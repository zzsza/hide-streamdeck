import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCESS_REQUEST_RETRY_INTERVAL_MS,
  createHideSource,
  defaultHideExec,
  HideCliSource,
  type HideExec,
  type HideExecOptions,
  type HideExecResult,
  type HideSnapshot,
} from "../src/source/index.js";
import { StatusHub } from "../src/state/status-hub.js";

interface RecordedCall {
  file: string;
  args: string[];
  opts: HideExecOptions;
}

function okJson(value: unknown): HideExecResult {
  return {
    stdout: JSON.stringify({ ok: true, value }),
    stderr: "",
    exitCode: 0,
  };
}

function refusalJson(
  code: string,
  message = `Refused: ${code}`,
  exitCode = 2,
): HideExecResult {
  return {
    stdout: JSON.stringify({ ok: false, error: { code, message } }),
    stderr: `${code}\n`,
    exitCode,
  };
}

function makeFakePsPayload(
  panes: Array<{
    machine?: string;
    pane: string;
    agent: null | {
      id: string | null;
      name: string | null;
      kind: string;
      state: string;
      label?: string | null;
      line: string | null;
      machine?: string;
      pane: string;
    };
  }>,
) {
  return {
    missions_unreadable: false,
    agents: [],
    panes: panes.map((entry) => {
      const machine = entry.machine ?? "local-dev-machine";
      return {
        machine,
        machine_label: null,
        project: "sample-app",
        project_path: "/tmp/sample-app",
        checkout: "main",
        checkout_path: "/tmp/sample-app",
        worktree: false,
        tab: "Agents",
        tab_id: "tab-1",
        pane: entry.pane,
        title: entry.agent ? null : "zsh",
        you: false,
        agent: entry.agent
          ? {
              id: entry.agent.id,
              name: entry.agent.name,
              kind: entry.agent.kind,
              state: entry.agent.state,
              label: entry.agent.label ?? entry.agent.name,
              line: entry.agent.line,
              machine: entry.agent.machine ?? machine,
              pane: entry.agent.pane,
              parent_machine: null,
              parent_pane: null,
              parent: null,
              origin_tool: null,
              watched_by: null,
              mission: null,
              project: "/tmp/sample-app",
            }
          : null,
      };
    }),
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFileContent(filePath: string, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = (await fs.readFile(filePath, "utf8")).trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // File not created yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file ${filePath}`);
}

describe("HideCliSource", () => {
  beforeEach(() => {
    vi.stubEnv("EXISTING_TEST_VAR", "preserved-value");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("runs access status -> request (throttled to >= 3s) -> ps --json with HIDE_ACCESS=streamdeck", async () => {
    let clock = 10_000;
    let requestAttempt = 0;
    const calls: RecordedCall[] = [];

    const fakeExec: HideExec = vi.fn(async (file, args, opts) => {
      calls.push({ file, args: [...args], opts });
      const key = args.join(" ");
      if (key === "access status --json") {
        return refusalJson(
          "access_not_connected",
          "Run hide access request --name streamdeck first",
        );
      }
      if (key === "access request --name streamdeck --json") {
        requestAttempt += 1;
        if (requestAttempt < 2) {
          return okJson({ state: "pending", id: "req-1" });
        }
        return okJson({ state: "connected", id: "conn-1", level: "view" });
      }
      if (key === "ps --json") {
        return okJson(
          makeFakePsPayload([
            {
              pane: "w1:p1",
              agent: {
                id: "ag-101",
                name: "falcon",
                kind: "claude",
                state: "turn",
                line: "Approve build step",
                pane: "w1:p1",
              },
            },
          ]),
        );
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const source = new HideCliSource({
      hidePath: "/custom/bin/hide",
      exec: fakeExec,
      now: () => clock,
    });

    // 1st read: status (access_not_connected) -> request (pending)
    const snap1 = await source.read();
    expect(snap1.connection).toEqual({ kind: "pending" });
    expect(snap1.agents).toEqual([]);
    expect(calls.map((c) => c.args)).toEqual([
      ["access", "status", "--json"],
      ["access", "request", "--name", "streamdeck", "--json"],
    ]);

    // 2nd read at +1500ms: throttled (< 3000ms), should not call exec
    clock += 1_500;
    const snap2 = await source.read();
    expect(snap2.connection).toEqual({ kind: "pending" });
    expect(calls).toHaveLength(2);

    // 3rd read at +3000ms: retries request -> connected -> immediately runs ps --json
    clock += ACCESS_REQUEST_RETRY_INTERVAL_MS - 1_500;
    const snap3 = await source.read();
    expect(snap3.connection).toEqual({ kind: "connected" });
    expect(snap3.agents).toEqual([
      {
        id: "ag-101",
        name: "falcon",
        kind: "claude",
        state: "turn",
        line: "Approve build step",
        pane: "w1:p1",
      },
    ]);
    expect(calls.slice(2).map((c) => c.args)).toEqual([
      ["access", "request", "--name", "streamdeck", "--json"],
      ["ps", "--json"],
    ]);

    // 4th read when already connected: goes straight to ps --json
    clock += 1_500;
    const snap4 = await source.read();
    expect(snap4.connection).toEqual({ kind: "connected" });
    expect(calls.slice(4).map((c) => c.args)).toEqual([["ps", "--json"]]);

    for (const call of calls) {
      expect(call.file).toBe("/custom/bin/hide");
      expect(call.opts.env.HIDE_ACCESS).toBe("streamdeck");
      expect(call.opts.env.EXISTING_TEST_VAR).toBe("preserved-value");
    }
  });

  it("handles already-connected status on first read, promotes .request on access_not_connected, and caps mutual recursion", async () => {
    const calls: string[] = [];
    let psAttempts = 0;

    const fakeExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "access status --json") {
        return okJson({ state: "connected", name: "streamdeck", level: "view" });
      }
      if (cmd === "ps --json") {
        psAttempts += 1;
        if (psAttempts === 1) {
          return refusalJson(
            "access_not_connected",
            "Run hide access request --name streamdeck first",
          );
        }
        return okJson(makeFakePsPayload([]));
      }
      if (cmd === "access request --name streamdeck --json") {
        return okJson({ state: "connected", id: "conn-2", level: "view" });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const source = new HideCliSource({ exec: fakeExec, now: () => 1_000 });
    const snap = await source.read();
    expect(snap.connection).toEqual({ kind: "connected" });
    expect(snap.agents).toEqual([]);
    expect(calls).toEqual([
      "access status --json",
      "ps --json",
      "access request --name streamdeck --json",
      "ps --json",
    ]);

    // Mutual recursion guard: if 2nd ps also refuses with access_not_connected, stops after 1 request
    const loopingCalls: string[] = [];
    const loopingExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      loopingCalls.push(cmd);
      if (cmd === "access status --json") {
        return okJson({ state: "connected" });
      }
      if (cmd === "access request --name streamdeck --json") {
        return okJson({ state: "connected" });
      }
      return refusalJson("access_not_connected");
    });

    const boundedSource = new HideCliSource({ exec: loopingExec, now: () => 2_000 });
    const boundedSnap = await boundedSource.read();
    expect(boundedSnap.connection).toEqual({ kind: "not_connected" });
    expect(loopingCalls).toEqual([
      "access status --json",
      "ps --json",
      "access request --name streamdeck --json",
      "ps --json",
    ]);
  });

  it("path 1: keeps revoked across polls and restarts after ps access_revoked, then re-requests immediately on retry()", async () => {
    let clock = 5_000;
    let revokedOnServer = true;
    let requestApproved = false;
    const calls1: string[] = [];

    const makeExec = (record: string[]): HideExec =>
      vi.fn(async (_file, args) => {
        const cmd = args.join(" ");
        record.push(cmd);
        if (cmd === "access status --json") {
          return revokedOnServer
            ? refusalJson("access_revoked", "The operator disconnected this tool")
            : okJson({ state: "pending" });
        }
        if (cmd === "ps --json") {
          if (revokedOnServer && !requestApproved) {
            return refusalJson("access_revoked", "The operator disconnected this tool");
          }
          return okJson(
            makeFakePsPayload([
              {
                pane: "w1:p1",
                agent: {
                  id: "ag-1",
                  name: "robin",
                  kind: "codex",
                  state: "going",
                  line: "Running checks",
                  pane: "w1:p1",
                },
              },
            ]),
          );
        }
        if (cmd === "access request --name streamdeck --json") {
          revokedOnServer = false;
          return okJson({ state: "pending" });
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });

    const exec1 = makeExec(calls1);
    const source1 = new HideCliSource({ exec: exec1, now: () => clock });

    // Start connected by mocking initial status -> connected
    const firstCalls: string[] = [];
    let isConnected = true;
    const connectedThenRevokedExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      firstCalls.push(cmd);
      if (cmd === "access status --json") {
        return isConnected
          ? okJson({ state: "connected" })
          : refusalJson("access_revoked", "The operator disconnected this tool");
      }
      if (cmd === "ps --json") {
        if (isConnected) {
          return okJson(makeFakePsPayload([]));
        }
        return refusalJson("access_revoked", "The operator disconnected this tool");
      }
      if (cmd === "access request --name streamdeck --json") {
        return okJson({ state: "pending" });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const activeSource = new HideCliSource({
      exec: connectedThenRevokedExec,
      now: () => clock,
    });
    expect((await activeSource.read()).connection).toEqual({ kind: "connected" });

    // Operator disconnects -> ps returns access_revoked
    isConnected = false;
    const revokedSnap = await activeSource.read();
    expect(revokedSnap.connection).toEqual({ kind: "revoked" });
    expect(revokedSnap.agents).toEqual([]);

    // Subsequent poll keeps revoked without calling access request automatically
    clock += 10_000;
    const stayedRevokedSnap = await activeSource.read();
    expect(stayedRevokedSnap.connection).toEqual({ kind: "revoked" });
    expect(firstCalls).toEqual([
      "access status --json",
      "ps --json",
      "ps --json",
      "access status --json",
    ]);

    // Recreated HideCliSource (plugin restart) also sees status access_revoked and keeps revoked
    const sourceAfterRestart = new HideCliSource({ exec: exec1, now: () => clock });
    expect((await sourceAfterRestart.read()).connection).toEqual({ kind: "revoked" });
    expect(calls1).toEqual(["access status --json"]);

    // User presses key -> retry() -> immediate access request on next read (no 3s wait)
    clock += 100;
    sourceAfterRestart.retry();
    const afterRetrySnap = await sourceAfterRestart.read();
    expect(afterRetrySnap.connection).toEqual({ kind: "pending" });
    expect(calls1).toEqual([
      "access status --json",
      "access request --name streamdeck --json",
    ]);

    // Unused variable cleanup
    void source1;
    void requestApproved;
  });

  it("path 2: status or ps returning access_request_expired immediately runs access request -> pending", async () => {
    const calls: string[] = [];
    let statusExpired = true;

    const fakeExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "access status --json") {
        return statusExpired
          ? refusalJson("access_request_expired", "The request was dropped")
          : okJson({ state: "pending" });
      }
      if (cmd === "access request --name streamdeck --json") {
        statusExpired = false;
        return okJson({ state: "pending", id: "req-new" });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const source = new HideCliSource({ exec: fakeExec, now: () => 2_000 });
    const snap = await source.read();
    expect(snap.connection).toEqual({ kind: "pending" });
    expect(calls).toEqual([
      "access status --json",
      "access request --name streamdeck --json",
    ]);
  });

  it("path 3: status returning access_refused keeps refused without auto-request, and retry() immediately re-requests", async () => {
    let clock = 1_000;
    const calls: string[] = [];
    let refusedOnServer = true;

    const fakeExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "access status --json") {
        return refusedOnServer
          ? refusalJson("access_refused", "The operator refused this tool")
          : okJson({ state: "pending" });
      }
      if (cmd === "access request --name streamdeck --json") {
        refusedOnServer = false;
        return okJson({ state: "pending", id: "req-retry" });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const source = new HideCliSource({ exec: fakeExec, now: () => clock });
    expect((await source.read()).connection).toEqual({ kind: "refused" });

    clock += 10_000;
    expect((await source.read()).connection).toEqual({ kind: "refused" });
    expect(calls).toEqual(["access status --json", "access status --json"]);

    // retry() bypasses 3s wait and executes access request on next read
    clock += 50;
    source.retry();
    expect((await source.read()).connection).toEqual({ kind: "pending" });
    expect(calls).toEqual([
      "access status --json",
      "access status --json",
      "access request --name streamdeck --json",
    ]);

    // retry() in pending state is a no-op (respects 3s throttle)
    clock += 500;
    source.retry();
    expect((await source.read()).connection).toEqual({ kind: "pending" });
    expect(calls).toHaveLength(3);
  });

  it("path 4: status or ps returning access_key_unreadable immediately runs access request", async () => {
    const statusCalls: string[] = [];
    const statusUnreadableExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      statusCalls.push(cmd);
      if (cmd === "access status --json") {
        return refusalJson("access_key_unreadable", "Key file cannot be read");
      }
      if (cmd === "access request --name streamdeck --json") {
        return okJson({ state: "pending", id: "req-clean" });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const sourceA = new HideCliSource({ exec: statusUnreadableExec, now: () => 1_000 });
    expect((await sourceA.read()).connection).toEqual({ kind: "pending" });
    expect(statusCalls).toEqual([
      "access status --json",
      "access request --name streamdeck --json",
    ]);

    // Also when ps --json fails with access_key_unreadable
    const psCalls: string[] = [];
    const psUnreadableExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      psCalls.push(cmd);
      if (cmd === "access status --json") {
        return okJson({ state: "connected" });
      }
      if (cmd === "ps --json") {
        return refusalJson("access_key_unreadable", "Key file cannot be read");
      }
      if (cmd === "access request --name streamdeck --json") {
        return refusalJson("access_name_taken", "A connected tool has this name");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const sourceB = new HideCliSource({ exec: psUnreadableExec, now: () => 2_000 });
    const snapB = await sourceB.read();
    expect(snapB.connection.kind).toBe("error");
    if (snapB.connection.kind === "error") {
      expect(snapB.connection.message).toContain("access_name_taken");
    }
    expect(psCalls).toEqual([
      "access status --json",
      "ps --json",
      "access request --name streamdeck --json",
    ]);
  });

  it("throttles access request to >= 3s even when Hide is unavailable and no key file exists", async () => {
    let clock = 0;
    const calls: string[] = [];

    const unavailableExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "access status --json") {
        return refusalJson("access_not_connected");
      }
      if (cmd === "access request --name streamdeck --json") {
        return refusalJson("hide_unavailable", "Start Hide on this machine");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const source = new HideCliSource({ exec: unavailableExec, now: () => clock });
    expect((await source.read()).connection).toEqual({ kind: "hide_unavailable" });
    expect(calls).toEqual([
      "access status --json",
      "access request --name streamdeck --json",
    ]);

    // At +1500ms (< 3000ms), status runs but request is throttled and hide_unavailable is preserved
    clock += 1_500;
    expect((await source.read()).connection).toEqual({ kind: "hide_unavailable" });
    expect(calls).toEqual([
      "access status --json",
      "access request --name streamdeck --json",
      "access status --json",
    ]);

    // At +3000ms (>= 3000ms), request runs again
    clock += 1_500;
    expect((await source.read()).connection).toEqual({ kind: "hide_unavailable" });
    expect(calls).toEqual([
      "access status --json",
      "access request --name streamdeck --json",
      "access status --json",
      "access status --json",
      "access request --name streamdeck --json",
    ]);
  });

  it("maps every access refusal code, outdated hide CLI, and ENOENT to the expected ConnectionState", async () => {
    const statusRefusalCases: ReadonlyArray<{ code: string; expectedKind: string }> = [
      { code: "access_pending", expectedKind: "pending" },
      { code: "access_refused", expectedKind: "refused" },
      { code: "access_revoked", expectedKind: "revoked" },
      { code: "access_unavailable", expectedKind: "hide_unavailable" },
      { code: "hide_unavailable", expectedKind: "hide_unavailable" },
    ];

    for (const { code, expectedKind } of statusRefusalCases) {
      const source = new HideCliSource({
        exec: vi.fn(async () => refusalJson(code)),
        now: () => 1_000,
      });

      const snap = await source.read();
      expect(snap.connection).toEqual({ kind: expectedKind });
      expect(snap.agents).toEqual([]);
    }

    // access_request_expired directly returned by request when status is access_not_connected
    const expiredSource = new HideCliSource({
      exec: vi.fn(async (_file, args) => {
        if (args[1] === "status") {
          return refusalJson("access_not_connected");
        }
        return refusalJson("access_request_expired");
      }),
      now: () => 1_000,
    });
    expect((await expiredSource.read()).connection).toEqual({ kind: "expired" });

    // Error codes that map to { kind: "error", message } containing the reason code
    for (const code of [
      "access_from_pane",
      "access_name_taken",
      "access_key_unreadable",
      "access_limit",
    ]) {
      const source = new HideCliSource({
        exec: vi.fn(async (_file, args) => {
          if (args[1] === "status") {
            return refusalJson("access_not_connected");
          }
          return refusalJson(code, `detail for ${code}`);
        }),
        now: () => 1_000,
      });
      const snap = await source.read();
      expect(snap.connection.kind).toBe("error");
      if (snap.connection.kind === "error") {
        expect(snap.connection.message).toContain(code);
      }
    }

    // Outdated hide (1.2.8 without `access` subcommand) -> hide_outdated
    const outdatedSource = new HideCliSource({
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "unknown command: hide access (run hide --help for the commands)\n",
        exitCode: 2,
      })),
    });
    expect((await outdatedSource.read()).connection).toEqual({ kind: "hide_outdated" });

    // Non-hide generic error text without "unknown command" is error, not hide_outdated
    const genericErrSource = new HideCliSource({
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "unexpected failure\n",
        exitCode: 2,
      })),
    });
    expect((await genericErrSource.read()).connection.kind).toBe("error");

    // Missing binary (ENOENT) -> hide_missing
    const missingSource = new HideCliSource({
      exec: vi.fn(async () => {
        const err = new Error("spawn /missing/hide ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }),
    });
    expect((await missingSource.read()).connection).toEqual({ kind: "hide_missing" });
  });

  it("parses value.panes[].agent, skips null agents, deduplicates by id (or machine+pane when id is null), and turns malformed JSON into error", async () => {
    const fakeExec: HideExec = vi.fn(async (_file, args) => {
      if (args[0] === "access") {
        return okJson({ state: "connected" });
      }
      return okJson(
        makeFakePsPayload([
          { pane: "w1:p0", agent: null },
          {
            pane: "w1:p1",
            agent: {
              id: "agent-a",
              name: "kestrel",
              kind: "claude",
              state: "look",
              line: "Review API diff",
              pane: "w1:p1",
            },
          },
          {
            pane: "w1:p2",
            agent: {
              id: "agent-a",
              name: "kestrel-dup",
              kind: "claude",
              state: "turn",
              line: "Duplicate id should be ignored",
              pane: "w1:p2",
            },
          },
          {
            machine: "dev-mac",
            pane: "w1:p3",
            agent: {
              id: null,
              name: null,
              label: "unregistered-local",
              kind: "codex",
              state: "going",
              line: null,
              machine: "dev-mac",
              pane: "w1:p3",
            },
          },
          {
            machine: "remote-box",
            pane: "w1:p3",
            agent: {
              id: null,
              name: null,
              label: "unregistered-remote",
              kind: "codex",
              state: "turn",
              line: "Needs check",
              machine: "remote-box",
              pane: "w1:p3",
            },
          },
        ]),
      );
    });

    const source = new HideCliSource({ exec: fakeExec, now: () => 2_000 });
    const snap = await source.read();
    expect(snap.connection).toEqual({ kind: "connected" });
    expect(snap.agents).toEqual([
      {
        id: "agent-a",
        name: "kestrel",
        kind: "claude",
        state: "look",
        line: "Review API diff",
        pane: "w1:p1",
      },
      {
        id: "dev-mac:w1:p3",
        name: "unregistered-local",
        kind: "codex",
        state: "going",
        line: null,
        pane: "w1:p3",
      },
      {
        id: "remote-box:w1:p3",
        name: "unregistered-remote",
        kind: "codex",
        state: "turn",
        line: "Needs check",
        pane: "w1:p3",
      },
    ]);

    // Malformed JSON -> error
    const badJsonSource = new HideCliSource({
      exec: vi.fn(async (_file, args) => {
        if (args[0] === "access") return okJson({ state: "connected" });
        return { stdout: "{not valid json", stderr: "", exitCode: 0 };
      }),
    });
    expect((await badJsonSource.read()).connection.kind).toBe("error");

    // Wrong ps schema shape -> error
    const badSchemaSource = new HideCliSource({
      exec: vi.fn(async (_file, args) => {
        if (args[0] === "access") return okJson({ state: "connected" });
        return okJson({ panes: "not-an-array" });
      }),
    });
    expect((await badSchemaSource.read()).connection.kind).toBe("error");
  });

  it("serializes overlapping read() calls and aborts in-flight read() on dispose()", async () => {
    let activeCount = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const serialExec: HideExec = vi.fn(async (_file, args) => {
      activeCount += 1;
      maxActive = Math.max(maxActive, activeCount);
      try {
        if (args[1] === "status") {
          firstStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return okJson({ state: "connected" });
        }
        return okJson(makeFakePsPayload([]));
      } finally {
        activeCount -= 1;
      }
    });

    const source = new HideCliSource({ exec: serialExec, now: () => 3_000 });
    const readA = source.read();
    await firstStartedPromise;
    const readB = source.read();
    expect(maxActive).toBe(1);

    releaseFirst();
    const [resA, resB] = await Promise.all([readA, readB]);
    expect(maxActive).toBe(1);
    expect(resA.connection).toEqual({ kind: "connected" });
    expect(resB.connection).toEqual({ kind: "connected" });

    // dispose() aborts an in-flight read immediately even if exec ignores signal
    let capturedSignal: AbortSignal | undefined;
    let hangingStarted!: () => void;
    const hangingStartedPromise = new Promise<void>((resolve) => {
      hangingStarted = resolve;
    });
    const hangingExec: HideExec = vi.fn((_file, _args, opts) => {
      capturedSignal = opts.signal;
      hangingStarted();
      return new Promise<HideExecResult>(() => {});
    });
    const disposableSource = new HideCliSource({ exec: hangingExec, now: () => 4_000 });
    const pendingRead = disposableSource.read();
    await hangingStartedPromise;
    expect(capturedSignal?.aborted).toBe(false);

    disposableSource.dispose();
    expect(capturedSignal?.aborted).toBe(true);

    const abortedSnap = await pendingRead;
    expect(abortedSnap.connection.kind).toBe("error");

    // Subsequent read after dispose() does not execute commands
    await disposableSource.read();
    expect(hangingExec).toHaveBeenCalledTimes(1);
  });

  it("bounds hung commands with timeoutMs and readTimeoutMs, and works with StatusHub global settings", async () => {
    vi.useFakeTimers();

    const hangingExec: HideExec = vi.fn(() => new Promise<HideExecResult>(() => {}));
    const timedSource = new HideCliSource({
      exec: hangingExec,
      timeoutMs: 500,
      now: () => Date.now(),
    });

    const readPromise = timedSource.read();
    await vi.advanceTimersByTimeAsync(600);
    const snap = await readPromise;
    expect(snap.connection.kind).toBe("error");
    if (snap.connection.kind === "error") {
      expect(snap.connection.message).toContain("timed out");
    }

    // Overall readTimeoutMs caps multi-command reads
    const slowMultiCommandExec: HideExec = vi.fn(
      (_file, args) =>
        new Promise<HideExecResult>((resolve) => {
          const delay = args[1] === "status" ? 300 : 1_000;
          setTimeout(() => resolve(refusalJson("access_not_connected")), delay);
        }),
    );
    const cappedSource = new HideCliSource({
      exec: slowMultiCommandExec,
      timeoutMs: 500,
      readTimeoutMs: 600,
      now: () => Date.now(),
    });
    const cappedPromise = cappedSource.read();
    await vi.advanceTimersByTimeAsync(700);
    const cappedSnap = await cappedPromise;
    expect(cappedSnap.connection.kind).toBe("error");
    if (cappedSnap.connection.kind === "error") {
      expect(cappedSnap.connection.message).toContain("timed out");
    }

    // Global settings switch between fake and hide sources and propagate custom hidePath
    const stubExec = vi.fn<HideExec>(async (_file, args) => {
      if (args[0] === "access") return okJson({ state: "connected" });
      return okJson(
        makeFakePsPayload([
          {
            pane: "w2:p1",
            agent: {
              id: "ag-hub",
              name: "sparrow",
              kind: "claude",
              state: "turn",
              line: "Waiting for input",
              pane: "w2:p1",
            },
          },
        ]),
      );
    });

    const hub = new StatusHub({
      initialSettings: { source: "fake", fakeScenario: "pending" },
      sourceFactory: (settings) =>
        createHideSource(settings, {
          cliOptions: { exec: stubExec },
        }),
    });

    const snapshots: HideSnapshot[] = [];
    const unsub = hub.subscribe((s) => snapshots.push(s));
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)?.connection).toEqual({ kind: "pending" });
    expect(stubExec).not.toHaveBeenCalled();

    hub.updateSettings({ source: "hide", hidePath: "/opt/hide/bin/hide" });
    await vi.advanceTimersByTimeAsync(0);
    expect(stubExec).toHaveBeenCalled();
    expect(stubExec.mock.calls[0]?.[0]).toBe("/opt/hide/bin/hide");
    expect(snapshots.at(-1)?.connection).toEqual({ kind: "connected" });
    expect(snapshots.at(-1)?.agents[0]?.name).toBe("sparrow");

    unsub();
    hub.dispose();
  });

  it("defaultHideExec runs without a shell, reports timed out message, captures non-zero exit codes, honors AbortSignal, and rejects ENOENT", async () => {
    const okRes = await defaultHideExec(
      process.execPath,
      ["-e", "process.stdout.write(process.env.HIDE_ACCESS ?? '')"],
      { env: { ...process.env, HIDE_ACCESS: "streamdeck" }, timeoutMs: 3_000 },
    );
    expect(okRes.exitCode).toBe(0);
    expect(okRes.stdout).toBe("streamdeck");

    const nonZeroRes = await defaultHideExec(
      process.execPath,
      ["-e", "process.stdout.write('{\"ok\":false}'); process.exit(2);"],
      { env: { ...process.env, HIDE_ACCESS: "streamdeck" }, timeoutMs: 3_000 },
    );
    expect(nonZeroRes.exitCode).toBe(2);
    expect(nonZeroRes.stdout).toBe('{"ok":false}');

    await expect(
      defaultHideExec(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10000)"],
        { env: { ...process.env, HIDE_ACCESS: "streamdeck" }, timeoutMs: 100 },
      ),
    ).rejects.toThrow(/timed out/);

    const controller = new AbortController();
    const abortedPromise = defaultHideExec(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      {
        env: { ...process.env, HIDE_ACCESS: "streamdeck" },
        timeoutMs: 3_000,
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(abortedPromise).rejects.toThrow();

    await expect(
      defaultHideExec(
        "/definitely-missing-hide-binary-for-test",
        ["access", "status", "--json"],
        {
          env: { HIDE_ACCESS: "streamdeck" },
          timeoutMs: 1_000,
        },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills grandchild processes spawned by a child script on dispose() and timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hide-source-pgid-"));
    const scriptPath = path.join(tempDir, "fake-cli.sh");
    const pidFileDispose = path.join(tempDir, "grandchild-dispose.pid");
    const pidFileTimeout = path.join(tempDir, "grandchild-timeout.pid");

    const scriptBody = `#!/bin/sh
/bin/sleep 30 &
echo $! > "$HIDE_TEST_PID_FILE"
wait
`;
    await fs.writeFile(scriptPath, scriptBody, { mode: 0o755 });

    const pidsToCleanup: number[] = [];

    try {
      // 1) dispose() kills grandchild /bin/sleep process
      vi.stubEnv("HIDE_TEST_PID_FILE", pidFileDispose);
      const disposeSource = new HideCliSource({ hidePath: scriptPath });
      const disposeReadPromise = disposeSource.read();
      const disposePid = Number(await waitForFileContent(pidFileDispose));
      pidsToCleanup.push(disposePid);
      expect(Number.isInteger(disposePid) && disposePid > 0).toBe(true);

      disposeSource.dispose();
      const disposeSnap = await disposeReadPromise;
      expect(disposeSnap.connection.kind).toBe("error");

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(isPidAlive(disposePid)).toBe(false);

      // 2) timeout kills grandchild /bin/sleep process and returns "timed out" message
      vi.stubEnv("HIDE_TEST_PID_FILE", pidFileTimeout);
      const timeoutSource = new HideCliSource({
        hidePath: scriptPath,
        timeoutMs: 250,
        readTimeoutMs: 500,
      });
      const timeoutReadPromise = timeoutSource.read();
      const timeoutPid = Number(await waitForFileContent(pidFileTimeout));
      pidsToCleanup.push(timeoutPid);
      expect(Number.isInteger(timeoutPid) && timeoutPid > 0).toBe(true);

      const timeoutSnap = await timeoutReadPromise;
      expect(timeoutSnap.connection.kind).toBe("error");
      if (timeoutSnap.connection.kind === "error") {
        expect(timeoutSnap.connection.message).toContain("timed out");
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(isPidAlive(timeoutPid)).toBe(false);
    } finally {
      for (const pid of pidsToCleanup) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already terminated.
        }
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
