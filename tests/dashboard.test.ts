import { afterEach, describe, expect, it, vi } from "vitest";
import { readMissionDashboard } from "../src/source/mission-dashboard.js";
import { HideCliSource, type HideExec } from "../src/source/hide-cli-source.js";
import { parsePsValue } from "../src/source/hide-access.js";
import type { HideSnapshot } from "../src/source/types.js";
import { summarize } from "../src/state/classify.js";
import { StatusHub } from "../src/state/status-hub.js";
import { renderCountKey, type DashboardKey } from "../src/render/count-key.js";

const output = (data: unknown, exitCode = 0) => ({ stdout: JSON.stringify(data), stderr: "", exitCode });
const listItem = (id: string, status = "running", shelved = false) => ({ id, status, shelved });
const node = (key: string, fields: Record<string, unknown> = {}) => ({ key, status: "working", ...fields });

describe("mission dashboard", () => {
  it("totals live missions using distinct warned nodes, open questions and CI-specific evidence", async () => {
    const first = {
      decision: "Synthetic question?", question: { key: 4 }, safety_net: { nodes: [{ key: "a" }, { key: "c" }] },
      nodes: [
        node("a", { status: "done", pr: 12, pr_state: "mergeable", merge: { by: "operator", state: "due" },
          warnings: [{}, {}], attention: { reason: "wait_stood" }, gate: { state: "open", ask: 4 } }),
        node("b", { work: { state: "stopped" }, gate: { state: "open", ask: null },
          pr: 8, pr_state: "failed", criteria: [{ kind: "review", state: "fail" }], checks: { passed: 0, total: 2 } }),
        node("c", { pr: 9, pr_state: "draft", criteria: [{ kind: "ci", state: "fail" }] }),
        node("d", { pr: 11, pr_state: "merged", criteria: [{ kind: "ci", state: "fail" }], merge: { by: "operator", state: "merged" } }),
      ],
    };
    const second = {
      decision: "Synthetic answered question?", question: { key: 1 }, answer: { key: 1 },
      nodes: [node("a", { gate: { state: "open", ask: 1 }, warnings: [{}] })],
    };
    const commands: string[][] = [];
    const result = await readMissionDashboard(async args => {
      commands.push([...args]);
      const result = args[1] === "list" ? { items: [
        listItem("m1"), listItem("m1"), listItem("m2", "merge_wait"), listItem("m3", "done"),
        listItem("m4", "running", true), listItem("m5", "cancelled"),
      ] } : { mission: args[3] === "m1" ? first : second };
      return output({ ok: true, result });
    });
    expect(result).toEqual({ kind: "ready", count: 2, done: 1, total: 5, merge: 1, confirmation: 2, warning: 4, ci: 1 });
    expect(commands).toEqual([["mission", "list"], ["mission", "show", "--mission", "m1", "--json"], ["mission", "show", "--mission", "m2", "--json"]]);
  });

  it("shows permission or parse errors without turning missing details into zeros", async () => {
    const denied = output({ ok: false, reason: "access_view_only" }, 2);
    expect(await readMissionDashboard(async () => denied)).toMatchObject({ kind: "denied" });
    const partial = await readMissionDashboard(async args => args[1] === "list"
      ? output({ ok: true, result: { items: [listItem("m1"), listItem("m2")] } }) : denied);
    expect(partial).toEqual({ kind: "denied", count: 2 });
    const snap: HideSnapshot = { connection: { kind: "connected" }, missions: partial, agents: [], readAt: 0 };
    expect(renderCountKey("mission", snap)).toContain(">2</text>");
    expect(renderCountKey("merge", snap)).toContain(">권한 없음</text>");
    expect(renderCountKey("working", snap)).toContain(">0</text>");
    expect(await readMissionDashboard(async () => output({ ok: true, result: {} }))).toMatchObject({ kind: "error" });
  });

  it("keeps children in Working and To Read while directing only root turns to the operator", () => {
    const panes = [["turn", "", ""], ["turn", "parent-id", ""], ["look", "", "pane-p"], ["going", "p", ""], ["done", "p", ""]]
      .map(([state, parent, parent_pane], i) => ({ pane: String(i), agent: { state, kind: "sample", parent, parent_pane } }));
    const parsed = parsePsValue({ panes });
    if (!parsed.ok) throw new Error(parsed.message);
    const sum = summarize({ connection: { kind: "connected" }, agents: parsed.agents, readAt: 0 });
    expect(sum.working).toBe(1);
    expect(sum.toRead).toBe(1);
    expect(sum.needsYou.map(agent => agent.pane)).toEqual(["0"]);
  });

  it("renders the single mission fraction and alert colors on their respective keys", () => {
    const snap: HideSnapshot = {
      connection: { kind: "connected" }, readAt: 0,
      agents: [{ id: "a", name: "sample", line: null, pane: "x", kind: "sample", state: "unread" }],
      missions: { kind: "ready", count: 1, done: 3, total: 5, merge: 1, confirmation: 1, warning: 1, ci: 2 },
    };
    expect(renderCountKey("mission", snap)).toContain(">3/5</text>");
    for (const [key, color] of [["to-read", "#70e398"], ["merge", "#71a3ff"], ["warning", "#ffb756"], ["ci", "#ff5c58"]] as const) {
      expect(renderCountKey(key, snap)).toContain(`r="7" fill="${color}"`);
    }
    expect(renderCountKey("confirmation", snap)).toContain('rx="0" fill="#ff5c58"');
    for (const key of ["to-read", "mission", "merge", "confirmation", "warning", "ci"] as DashboardKey[]) {
      expect(renderCountKey(key, { ...snap, connection: { kind: "not_connected" } })).toContain(">연결 안 됨</text>");
    }
  });
});

afterEach(() => vi.useRealTimers());

it("shares the 10-second mission poll across keys while ps keeps its own 1.5-second timer", async () => {
  vi.useFakeTimers();
  const commands: string[] = [];
  let connection = "pending";
  let finish: ((data: ReturnType<typeof output>) => void) | undefined;
  let missionSignal: AbortSignal | undefined;
  const exec: HideExec = async (_file, args, opts) => {
    commands.push(args.join(" "));
    if (args[0] === "access") return output({ ok: true, value: { state: connection } });
    if (args[0] === "ps") return connection === "connected" ? output({ ok: true, value: { panes: [] } })
      : output({ ok: false, reason: "access_revoked" }, 2);
    if (args[1] === "list") return output({ ok: true, result: { items: [listItem("m1")] } });
    missionSignal = opts.signal;
    return new Promise(resolve => { finish = resolve; });
  };
  const hub = new StatusHub({ initialSettings: {}, sourceFactory: () => new HideCliSource({ exec }) });
  const off1 = hub.subscribe(() => {}, true);
  const off2 = hub.subscribe(() => {}, true);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.filter(c => c.startsWith("mission"))).toEqual([]);
    connection = "connected";
    await vi.advanceTimersByTimeAsync(3_000);
    expect(commands.filter(c => c === "mission list")).toHaveLength(1);
    expect(commands.filter(c => c === "mission show --mission m1 --json")).toHaveLength(1);
    const psBefore = commands.filter(c => c === "ps --json").length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(commands.filter(c => c === "ps --json")).toHaveLength(psBefore + 2);
    finish!(output({ ok: true, result: { mission: { nodes: [] } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.getLastSnapshot()?.missions).toMatchObject({ kind: "ready", count: 1 });
    off1();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(commands.filter(c => c === "mission list")).toHaveLength(2);
    connection = "revoked";
    await vi.advanceTimersByTimeAsync(1_500);
    expect(missionSignal?.aborted).toBe(true);
    expect(hub.getLastSnapshot()?.missions).toBeUndefined();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(commands.filter(c => c === "mission list")).toHaveLength(2);
  } finally {
    off2();
    hub.dispose();
  }
});

it("sets each new key image from its snapshot and releases its subscription on disappearance", async () => {
  const { CountAction } = await import("../src/actions/count-action.js");
  const hub = new StatusHub({ initialSettings: { source: "fake", fakeScenario: "needs-you-many" } });
  try {
    for (const kind of ["to-read", "mission", "merge", "confirmation", "warning", "ci"] as const) {
      const uuid = `com.zzsza.hide-status.${kind}`;
      const action = new CountAction(hub, kind, uuid);
      expect(action.manifestId).toBe(uuid);
      const event = { action: { id: "sample-key", isKey: () => true, setTitle: vi.fn(), setImage: vi.fn() } };
      action.onWillAppear(event as never);
      await new Promise(resolve => setTimeout(resolve, 0));
      const lastImage = event.action.setImage.mock.lastCall?.[0] as string;
      expect(decodeURIComponent(lastImage.split(",")[1]!)).toBe(renderCountKey(kind, hub.getLastSnapshot()!));
      action.onWillDisappear(event as never);
      expect(hub.getSubscriberCount()).toBe(0);
    }
  } finally {
    hub.dispose();
  }
});
