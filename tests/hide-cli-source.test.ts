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

function refusalJson(code: string, message = `Refused: ${code}`, exitCode = 1): HideExecResult {
  return {
    stdout: JSON.stringify({ ok: false, error: { code, message } }),
    stderr: "",
    exitCode,
  };
}

function makeFakePsPayload(
  panes: Array<{
    pane: string;
    agent: null | {
      id: string | null;
      name: string | null;
      kind: string;
      state: string;
      label?: string | null;
      line: string | null;
      pane: string;
    };
  }>,
) {
  return {
    missions_unreadable: false,
    agents: [],
    panes: panes.map((entry) => ({
      machine: "local-dev-machine",
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
            machine: "local-dev-machine",
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
    })),
  };
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
        return okJson({ state: "not_connected" });
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

    // 1st read: status (not_connected) -> request (pending)
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

  it("handles already-connected status on first read and promotes pending .request if ps reports access_not_connected", async () => {
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
          return refusalJson("access_not_connected", "Run hide access request --name streamdeck first");
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
  });

  it("resets flow and transitions state when ps --json is refused with access_revoked", async () => {
    let phase: "connected" | "revoked" | "reconnecting" = "connected";
    const calls: string[] = [];

    const fakeExec: HideExec = vi.fn(async (_file, args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "access status --json") {
        return okJson({ state: phase === "connected" ? "connected" : "not_connected" });
      }
      if (cmd === "ps --json") {
        if (phase === "connected") {
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
        return refusalJson("access_revoked", "The operator disconnected this tool");
      }
      if (cmd === "access request --name streamdeck --json") {
        return okJson({ state: "pending" });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const source = new HideCliSource({ exec: fakeExec, now: () => 5_000 });
    const first = await source.read();
    expect(first.connection).toEqual({ kind: "connected" });
    expect(first.agents).toHaveLength(1);

    phase = "revoked";
    const second = await source.read();
    expect(second.connection).toEqual({ kind: "revoked" });
    expect(second.agents).toEqual([]);

    // Next read restarts the access flow from `access status --json`.
    phase = "reconnecting";
    const third = await source.read();
    expect(third.connection).toEqual({ kind: "pending" });
    expect(calls).toEqual([
      "access status --json",
      "ps --json",
      "ps --json",
      "access status --json",
      "access request --name streamdeck --json",
    ]);
  });

  it("maps every access refusal code, outdated hide CLI, and ENOENT to the expected ConnectionState", async () => {
    const refusalCases: ReadonlyArray<{ code: string; expectedKind: string }> = [
      { code: "access_pending", expectedKind: "pending" },
      { code: "access_refused", expectedKind: "refused" },
      { code: "access_revoked", expectedKind: "revoked" },
      { code: "access_request_expired", expectedKind: "expired" },
      { code: "access_unavailable", expectedKind: "hide_unavailable" },
      { code: "hide_unavailable", expectedKind: "hide_unavailable" },
    ];

    for (const { code, expectedKind } of refusalCases) {
      const source = new HideCliSource({
        exec: vi.fn(async (_file, args) => {
          if (args[1] === "status") {
            return okJson({ state: "not_connected" });
          }
          return refusalJson(code);
        }),
        now: () => 1_000,
      });

      const snap = await source.read();
      expect(snap.connection).toEqual({ kind: expectedKind });
      expect(snap.agents).toEqual([]);
    }

    // Error codes that map to { kind: "error", message } containing the reason code
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
      const snap = await source.read();
      expect(snap.connection.kind).toBe("error");
      if (snap.connection.kind === "error") {
        expect(snap.connection.message).toContain(code);
      }
    }

    // Also supports reason-style error envelopes ({ ok: false, reason: ... })
    const reasonEnvelopeSource = new HideCliSource({
      exec: vi.fn(async () => ({
        stdout: JSON.stringify({
          ok: false,
          reason: "access_from_pane",
          next_action: "Run outside Hide panes",
        }),
        stderr: "",
        exitCode: 2,
      })),
    });
    const reasonSnap = await reasonEnvelopeSource.read();
    expect(reasonSnap.connection.kind).toBe("error");
    if (reasonSnap.connection.kind === "error") {
      expect(reasonSnap.connection.message).toContain("access_from_pane");
    }

    // Outdated hide (e.g., 1.2.8 without `access` subcommand) -> hide_outdated
    const outdatedSource = new HideCliSource({
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "unknown command: hide access (run hide --help for the commands)\n",
        exitCode: 2,
      })),
    });
    expect((await outdatedSource.read()).connection).toEqual({ kind: "hide_outdated" });

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

  it("parses value.panes[].agent, skips null agents, deduplicates by id, and turns malformed JSON into error", async () => {
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
            pane: "w1:p3",
            agent: {
              id: null,
              name: null,
              label: "unregistered-shell",
              kind: "codex",
              state: "going",
              line: null,
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
        id: "w1:p3",
        name: "unregistered-shell",
        kind: "codex",
        state: "going",
        line: null,
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

  it("bounds hung commands with timeoutMs and works with StatusHub global settings", async () => {
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
          setTimeout(() => resolve(okJson({ state: "not_connected" })), delay);
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

  it("defaultHideExec runs without a shell, captures non-zero exit codes, honors AbortSignal, and rejects ENOENT", async () => {
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
      defaultHideExec("/definitely-missing-hide-binary-for-test", ["access", "status", "--json"], {
        env: { HIDE_ACCESS: "streamdeck" },
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
