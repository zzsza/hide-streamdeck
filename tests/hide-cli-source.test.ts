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

async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

type CoreStanding = "pending" | "approved" | "refused" | "revoked" | "dropped";
type FakeAgentEntry = Parameters<typeof makeFakePsPayload>[0][number];

/**
 * Stateful model of `hided/src/access_cli.rs` + `ps_cli.rs` rules:
 * - `access status` inspects `keyFile` without deleting ended files.
 * - `access request` runs `settle()` when a key file exists: an ended file is deleted before
 *   returning its ended refusal, and a fresh request is only opened on the subsequent call.
 * - `access request` removes a damaged (`unreadable`) key file and immediately issues a new request.
 */
class FakeHideWorld {
  running = true;
  keyFile:
    | null
    | { kept: "request" | "key"; id: string }
    | { kept: "unreadable" } = null;
  core = new Map<string, CoreStanding>();
  panes: FakeAgentEntry[] = [];
  calls: RecordedCall[] = [];
  private seq = 0;
  private activeId: string | null = null;

  seed(
    kept: "request" | "key" | "unreadable",
    standing?: CoreStanding,
    id = "seeded-1",
  ): string {
    if (kept === "unreadable") {
      this.keyFile = { kept: "unreadable" };
      this.activeId = null;
      return id;
    }
    this.keyFile = { kept, id };
    this.activeId = id;
    if (standing && standing !== "dropped") {
      this.core.set(id, standing);
    } else {
      this.core.delete(id);
    }
    return id;
  }

  approve(id = this.activeId): void {
    if (id) this.core.set(id, "approved");
  }

  refuse(id = this.activeId): void {
    if (id) this.core.set(id, "refused");
  }

  revoke(id = this.activeId): void {
    if (id) this.core.set(id, "revoked");
  }

  restartDaemon(): void {
    this.core.clear();
    this.running = true;
  }

  countCommands(prefix: string): number {
    return this.calls.filter((c) => c.args.join(" ").startsWith(prefix)).length;
  }

  private standing(id: string): CoreStanding {
    return this.core.get(id) ?? "dropped";
  }

  private endedCode(standing: CoreStanding, kept: "request" | "key"): string {
    if (standing === "refused") return "access_refused";
    if (standing === "revoked") return "access_revoked";
    return kept === "request" ? "access_request_expired" : "access_revoked";
  }

  private status(): HideExecResult {
    if (!this.keyFile) {
      return refusalJson("access_not_connected", "No access key for streamdeck");
    }
    if (this.keyFile.kept === "unreadable") {
      return refusalJson("access_key_unreadable", "Key file cannot be read");
    }
    if (!this.running) {
      return refusalJson("access_unavailable", "Hide is not running");
    }
    const s = this.standing(this.keyFile.id);
    if (s === "pending") {
      return okJson({ state: "pending", name: "streamdeck" });
    }
    if (s === "approved") {
      return okJson({ state: "connected", name: "streamdeck", level: "view" });
    }
    return refusalJson(this.endedCode(s, this.keyFile.kept));
  }

  private request(): HideExecResult {
    if (this.keyFile?.kept === "unreadable") {
      // access_cli.rs removes damaged key files before creating a fresh request.
      this.keyFile = null;
    }
    if (!this.keyFile) {
      if (!this.running) {
        return refusalJson("access_unavailable", "Start Hide on this machine");
      }
      const id = `req-${++this.seq}`;
      this.activeId = id;
      this.keyFile = { kept: "request", id };
      this.core.set(id, "pending");
      return okJson({ state: "pending", id, name: "streamdeck" });
    }
    if (!this.running) {
      return refusalJson("access_unavailable", "Start Hide on this machine");
    }
    const s = this.standing(this.keyFile.id);
    if (s === "pending" && this.keyFile.kept === "request") {
      return okJson({ state: "pending", id: this.keyFile.id, name: "streamdeck" });
    }
    if (s === "approved") {
      this.keyFile = { kept: "key", id: this.keyFile.id };
      return okJson({ state: "connected", id: this.keyFile.id, level: "view" });
    }
    const ended = this.endedCode(s, this.keyFile.kept);
    this.keyFile = null;
    return refusalJson(ended);
  }

  private ps(): HideExecResult {
    if (!this.keyFile) {
      return refusalJson("access_not_connected", "No access key for streamdeck");
    }
    if (this.keyFile.kept === "unreadable") {
      return refusalJson("access_key_unreadable", "Key file cannot be read");
    }
    if (this.keyFile.kept !== "key") {
      return refusalJson("access_not_connected", "Promote pending request first");
    }
    if (!this.running) {
      return refusalJson("access_unavailable", "Hide is not running");
    }
    const s = this.standing(this.keyFile.id);
    if (s === "approved") {
      return okJson(makeFakePsPayload(this.panes));
    }
    if (s === "pending") {
      return refusalJson("access_pending", "Approval pending");
    }
    return refusalJson(this.endedCode(s, "key"));
  }

  readonly exec: HideExec = vi.fn(async (file, args, opts) => {
    this.calls.push({ file, args: [...args], opts });
    const cmd = args.join(" ");
    if (cmd === "access status --json") return this.status();
    if (cmd === "access request --name streamdeck --json") return this.request();
    if (cmd === "ps --json") return this.ps();
    throw new Error(`Unexpected command: ${cmd}`);
  });
}

describe("HideCliSource", () => {
  beforeEach(() => {
    vi.stubEnv("EXISTING_TEST_VAR", "preserved-value");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("stays not_connected without auto-requesting, connects on requestAccess() -> pending (3s throttle) -> approved -> ps --json", async () => {
    let clock = 10_000;
    const world = new FakeHideWorld();
    world.panes = [
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
    ];

    const source = new HideCliSource({
      hidePath: "/custom/bin/hide",
      exec: world.exec,
      now: () => clock,
    });

    // Automatic polling only checks status and never opens a new request
    const snap1 = await source.read();
    expect(snap1.connection).toEqual({ kind: "not_connected" });
    expect(snap1.agents).toEqual([]);
    clock += 1_500;
    const snap2 = await source.read();
    expect(snap2.connection).toEqual({ kind: "not_connected" });
    expect(world.countCommands("access request")).toBe(0);

    // User clicks connect -> requestAccess() -> pending
    source.requestAccess();
    const snap3 = await source.read();
    expect(snap3.connection).toEqual({ kind: "pending" });
    expect(world.keyFile?.kept).toBe("request");
    expect(world.calls.slice(2).map((c) => c.args)).toEqual([
      ["access", "request", "--name", "streamdeck", "--json"],
    ]);

    // requestAccess() while pending is ignored; polling at +1500ms is throttled (< 3000ms)
    source.requestAccess();
    clock += 1_500;
    const callCountBeforeThrottle = world.calls.length;
    expect((await source.read()).connection).toEqual({ kind: "pending" });
    expect(world.calls).toHaveLength(callCountBeforeThrottle);

    // Operator approves; after >= 3000ms, settle request exchanges for key and polls ps --json
    world.approve();
    clock += ACCESS_REQUEST_RETRY_INTERVAL_MS - 1_500;
    const snap5 = await source.read();
    expect(snap5.connection).toEqual({ kind: "connected" });
    expect(world.keyFile?.kept).toBe("key");
    expect(snap5.agents).toEqual([
      {
        id: "ag-101",
        name: "falcon",
        kind: "claude",
        state: "turn",
        line: "Approve build step",
        pane: "w1:p1",
      },
    ]);
    expect(world.calls.slice(callCountBeforeThrottle).map((c) => c.args)).toEqual([
      ["access", "request", "--name", "streamdeck", "--json"],
      ["ps", "--json"],
    ]);

    // Subsequent read while connected runs ps --json directly; requestAccess() is ignored
    source.requestAccess();
    clock += 1_500;
    const callsBeforeConnectedRead = world.calls.length;
    expect((await source.read()).connection).toEqual({ kind: "connected" });
    expect(world.calls.slice(callsBeforeConnectedRead).map((c) => c.args)).toEqual([
      ["ps", "--json"],
    ]);

    for (const call of world.calls) {
      expect(call.file).toBe("/custom/bin/hide");
      expect(call.opts.env.HIDE_ACCESS).toBe("streamdeck");
      expect(call.opts.env.EXISTING_TEST_VAR).toBe("preserved-value");
    }
  });

  it("promotes .request approved while offline and caps mutual ps/request recursion", async () => {
    const world = new FakeHideWorld();
    world.seed("request", "approved", "offline-approved");

    const source = new HideCliSource({ exec: world.exec, now: () => 1_000 });
    const snap = await source.read();
    expect(snap.connection).toEqual({ kind: "connected" });
    expect(world.keyFile?.kept).toBe("key");
    expect(world.calls.map((c) => c.args.join(" "))).toEqual([
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

  it("keeps revoked across polls and restarts, then re-requests to pending on a single requestAccess()", async () => {
    let clock = 5_000;
    const world = new FakeHideWorld();
    const source = new HideCliSource({ exec: world.exec, now: () => clock });

    // Connect first
    await source.read();
    source.requestAccess();
    await source.read();
    world.approve();
    clock += ACCESS_REQUEST_RETRY_INTERVAL_MS;
    expect((await source.read()).connection).toEqual({ kind: "connected" });

    // Operator disconnects -> ps returns access_revoked (.key stays on disk)
    world.revoke();
    expect((await source.read()).connection).toEqual({ kind: "revoked" });
    expect(world.keyFile?.kept).toBe("key");

    const requestsBeforePolls = world.countCommands("access request");
    clock += 10_000;
    expect((await source.read()).connection).toEqual({ kind: "revoked" });
    expect(world.countCommands("access request")).toBe(requestsBeforePolls);

    // Plugin restart still sees revoked and never auto-requests
    const restarted = new HideCliSource({ exec: world.exec, now: () => clock });
    expect((await restarted.read()).connection).toEqual({ kind: "revoked" });
    clock += 10_000;
    expect((await restarted.read()).connection).toEqual({ kind: "revoked" });
    expect(world.countCommands("access request")).toBe(requestsBeforePolls);

    // Single requestAccess() settles + removes stale .key (1st call) and opens fresh .request (2nd call)
    const callsBeforeAction = world.calls.length;
    restarted.requestAccess();
    const reRequested = await restarted.read();
    expect(reRequested.connection).toEqual({ kind: "pending" });
    expect(world.keyFile?.kept).toBe("request");
    expect(world.calls.slice(callsBeforeAction).map((c) => c.args)).toEqual([
      ["access", "request", "--name", "streamdeck", "--json"],
      ["access", "request", "--name", "streamdeck", "--json"],
    ]);

    // If the 2nd access request also refuses/fails (e.g. Hide stops), it stops cleanly without looping
    const failingWorld = new FakeHideWorld();
    failingWorld.seed("key", "revoked");
    const failingSource = new HideCliSource({ exec: failingWorld.exec, now: () => clock });
    expect((await failingSource.read()).connection).toEqual({ kind: "revoked" });
    failingWorld.running = false;
    failingSource.requestAccess();
    expect((await failingSource.read()).connection).toEqual({ kind: "hide_unavailable" });
    expect(failingWorld.countCommands("access request")).toBe(1);
  });

  it("keeps refused without auto-requesting (during pending poll or after restart) until one requestAccess()", async () => {
    let clock = 2_000;
    const liveWorld = new FakeHideWorld();
    const liveSource = new HideCliSource({ exec: liveWorld.exec, now: () => clock });

    await liveSource.read();
    liveSource.requestAccess();
    expect((await liveSource.read()).connection).toEqual({ kind: "pending" });

    // Operator refuses during active polling -> settles, drops .request, halts on refused
    liveWorld.refuse();
    clock += ACCESS_REQUEST_RETRY_INTERVAL_MS;
    expect((await liveSource.read()).connection).toEqual({ kind: "refused" });
    expect(liveWorld.keyFile).toBeNull();

    const requestsAtRefusal = liveWorld.countCommands("access request");
    clock += 10_000;
    expect((await liveSource.read()).connection).toEqual({ kind: "refused" });
    expect(liveWorld.countCommands("access request")).toBe(requestsAtRefusal);

    liveSource.requestAccess();
    expect((await liveSource.read()).connection).toEqual({ kind: "pending" });
    expect(liveWorld.countCommands("access request")).toBe(requestsAtRefusal + 1);

    // Case where request was refused while plugin was off (.request left on disk)
    const offlineWorld = new FakeHideWorld();
    offlineWorld.seed("request", "refused");
    const offlineSource = new HideCliSource({ exec: offlineWorld.exec, now: () => clock });
    expect((await offlineSource.read()).connection).toEqual({ kind: "refused" });
    clock += 10_000;
    expect((await offlineSource.read()).connection).toEqual({ kind: "refused" });
    expect(offlineWorld.countCommands("access request")).toBe(0);

    offlineSource.requestAccess();
    expect((await offlineSource.read()).connection).toEqual({ kind: "pending" });
    expect(offlineWorld.countCommands("access request")).toBe(2);
  });

  it("shows expired on Hide restart with zero new auto-requests until one requestAccess() -> pending", async () => {
    let clock = 3_000;
    const pollWorld = new FakeHideWorld();
    const pollSource = new HideCliSource({ exec: pollWorld.exec, now: () => clock });

    await pollSource.read();
    pollSource.requestAccess();
    expect((await pollSource.read()).connection).toEqual({ kind: "pending" });

    // Hide restarts and drops in-memory pending requests while .request stays on disk
    pollWorld.restartDaemon();
    clock += ACCESS_REQUEST_RETRY_INTERVAL_MS;
    // Pending check gets access_request_expired and MUST stop at expired (no 2nd request)
    expect((await pollSource.read()).connection).toEqual({ kind: "expired" });
    expect(pollWorld.keyFile).toBeNull();
    const reqsAfterExpire = pollWorld.countCommands("access request");
    clock += 10_000;
    expect((await pollSource.read()).connection).toEqual({ kind: "expired" });
    expect(pollWorld.countCommands("access request")).toBe(reqsAfterExpire);

    // Single requestAccess() opens a new request
    pollSource.requestAccess();
    expect((await pollSource.read()).connection).toEqual({ kind: "pending" });
    expect(pollWorld.countCommands("access request")).toBe(reqsAfterExpire + 1);

    // Hide restarted while plugin was off (.request still on disk) -> status shows expired, 0 auto-requests
    const offlineWorld = new FakeHideWorld();
    offlineWorld.seed("request", "dropped");
    const offlineSource = new HideCliSource({ exec: offlineWorld.exec, now: () => clock });
    expect((await offlineSource.read()).connection).toEqual({ kind: "expired" });
    clock += 10_000;
    expect((await offlineSource.read()).connection).toEqual({ kind: "expired" });
    expect(offlineWorld.countCommands("access request")).toBe(0);

    offlineSource.requestAccess();
    expect((await offlineSource.read()).connection).toEqual({ kind: "pending" });
    expect(offlineWorld.countCommands("access request")).toBe(2);
  });

  it("reports error on access_key_unreadable without auto-requesting, and recovers to pending on requestAccess()", async () => {
    let clock = 1_000;
    const world = new FakeHideWorld();
    world.seed("unreadable");

    const source = new HideCliSource({ exec: world.exec, now: () => clock });
    const errSnap = await source.read();
    expect(errSnap.connection.kind).toBe("error");
    if (errSnap.connection.kind === "error") {
      expect(errSnap.connection.message).toContain("access_key_unreadable");
    }
    clock += 10_000;
    expect((await source.read()).connection.kind).toBe("error");
    expect(world.countCommands("access request")).toBe(0);

    // requestAccess() runs access request, which removes the damaged file and opens a fresh request
    source.requestAccess();
    expect((await source.read()).connection).toEqual({ kind: "pending" });
    expect(world.keyFile?.kept).toBe("request");
    expect(world.countCommands("access request")).toBe(1);
  });

  it("maps every access refusal code, outdated hide CLI, and ENOENT to the expected ConnectionState", async () => {
    const statusRefusalCases: ReadonlyArray<{ code: string; expectedKind: string }> = [
      { code: "access_pending", expectedKind: "pending" },
      { code: "access_refused", expectedKind: "refused" },
      { code: "access_revoked", expectedKind: "revoked" },
      { code: "access_request_expired", expectedKind: "expired" },
      { code: "access_not_connected", expectedKind: "not_connected" },
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

    // Error codes (returned on requestAccess() or status) map to { kind: "error", message } containing the code
    for (const code of [
      "access_from_pane",
      "access_name_taken",
      "access_key_unreadable",
      "access_limit",
    ]) {
      const source = new HideCliSource({
        exec: vi.fn(async () => refusalJson(code, `detail for ${code}`)),
        now: () => 1_000,
      });
      source.requestAccess();
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

    // Overall readTimeoutMs caps multi-command reads (e.g. access status -> ps)
    const slowMultiCommandExec: HideExec = vi.fn(
      (_file, args) =>
        new Promise<HideExecResult>((resolve) => {
          const isStatus = args[1] === "status";
          const delay = isStatus ? 300 : 1_000;
          setTimeout(
            () =>
              resolve(
                isStatus
                  ? okJson({ state: "connected" })
                  : okJson(makeFakePsPayload([])),
              ),
            delay,
          );
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

  it("triggers an immediate access request via StatusHub.requestAccess() after revocation", async () => {
    vi.useFakeTimers();
    const world = new FakeHideWorld();
    world.seed("key", "revoked");
    world.panes = [
      {
        pane: "w3:p1",
        agent: {
          id: "ag-hub-req",
          name: "kestrel",
          kind: "claude",
          state: "working",
          line: "Resumed polling",
          pane: "w3:p1",
        },
      },
    ];

    const hub = new StatusHub({
      initialSettings: { source: "hide", hidePath: "/opt/hide/bin/hide" },
      sourceFactory: (settings) =>
        createHideSource(settings, {
          cliOptions: { exec: world.exec },
          now: () => Date.now(),
        }),
    });

    const snapshots: HideSnapshot[] = [];
    const unsub = hub.subscribe((s) => snapshots.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(snapshots.at(-1)?.connection).toEqual({ kind: "revoked" });
    expect(world.countCommands("access request")).toBe(0);

    // Automatic polls do not open a new access request while revoked
    await vi.advanceTimersByTimeAsync(1_500);
    expect(snapshots.at(-1)?.connection).toEqual({ kind: "revoked" });
    expect(world.countCommands("access request")).toBe(0);

    // StatusHub.requestAccess() triggers immediate request (settles stale .key + opens fresh .request)
    hub.requestAccess();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)?.connection).toEqual({ kind: "pending" });
    expect(world.countCommands("access request")).toBe(2);
    expect(world.calls.at(-1)?.opts.env.HIDE_ACCESS).toBe("streamdeck");

    // Once approved, next >= 3s poll promotes key and reads ps --json
    world.approve();
    await vi.advanceTimersByTimeAsync(ACCESS_REQUEST_RETRY_INTERVAL_MS);
    expect(snapshots.at(-1)?.connection).toEqual({ kind: "connected" });
    expect(snapshots.at(-1)?.agents.map((a) => a.name)).toEqual(["kestrel"]);

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

      await waitForPidExit(disposePid);

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

      await waitForPidExit(timeoutPid);
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
