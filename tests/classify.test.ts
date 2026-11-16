import { describe, expect, it } from "vitest";

import type { AgentRow, HideSnapshot } from "../src/source/types.js";
import { classify, summarize } from "../src/state/classify.js";

function makeRow(overrides: Partial<AgentRow> & Pick<AgentRow, "id" | "state">): AgentRow {
  return {
    id: overrides.id,
    name: overrides.name ?? `agent-${overrides.id}`,
    kind: overrides.kind ?? "claude",
    state: overrides.state,
    line: overrides.line ?? null,
    pane: overrides.pane ?? "w1:p1",
  };
}

describe("classify", () => {
  it("maps turn and look to needs_you", () => {
    expect(classify("turn")).toBe("needs_you");
    expect(classify("look")).toBe("needs_you");
  });

  it("maps going and waiting to working", () => {
    expect(classify("going")).toBe("working");
    expect(classify("waiting")).toBe("working");
  });

  it("maps done and unread to to_read", () => {
    expect(classify("done")).toBe("to_read");
    expect(classify("unread")).toBe("to_read");
  });

  it("maps quiet, unknown, asleep, and unrecognized states to other", () => {
    expect(classify("quiet")).toBe("other");
    expect(classify("unknown")).toBe("other");
    expect(classify("asleep")).toBe("other");
    expect(classify("")).toBe("other");
    expect(classify("unexpected_future_state")).toBe("other");
  });
});

describe("summarize", () => {
  it("counts each agent id once and preserves pane order for needsYou", () => {
    const snapshot: HideSnapshot = {
      connection: { kind: "connected" },
      readAt: 1_700_000_000_000,
      agents: [
        makeRow({ id: "a-1", name: "atlas", state: "going", pane: "w1:p1" }),
        makeRow({ id: "a-2", name: "vega", state: "look", pane: "w1:p2", line: "Open diff ready" }),
        makeRow({ id: "a-1", name: "atlas", state: "going", pane: "w1:p3" }),
        makeRow({ id: "a-3", name: "nova", state: "turn", pane: "w2:p1", line: "Confirm migration" }),
        makeRow({ id: "a-2", name: "vega", state: "turn", pane: "w2:p2" }),
        makeRow({ id: "a-4", name: "orion", state: "waiting", pane: "w2:p3" }),
        makeRow({ id: "a-5", name: "lyra", state: "done", pane: "w3:p1" }),
        makeRow({ id: "a-6", name: "zephyr", state: "unread", pane: "w3:p2" }),
        makeRow({ id: "a-5", name: "lyra", state: "done", pane: "w3:p3" }),
        makeRow({ id: "a-7", name: "sol", state: "quiet", pane: "w4:p1" }),
        makeRow({ id: "a-8", name: "echo", state: "asleep", pane: "w4:p2" }),
      ],
    };

    const result = summarize(snapshot);
    expect(result.working).toBe(2);
    expect(result.toRead).toBe(2);
    expect(result.needsYou.map((row) => ({ id: row.id, pane: row.pane }))).toEqual([
      { id: "a-2", pane: "w1:p2" },
      { id: "a-3", pane: "w2:p1" },
    ]);
  });

  it("returns zeros when snapshot has no agents", () => {
    const snapshot: HideSnapshot = {
      connection: { kind: "not_connected" },
      readAt: 1_700_000_000_000,
      agents: [],
    };
    expect(summarize(snapshot)).toEqual({
      working: 0,
      needsYou: [],
      toRead: 0,
    });
  });
});
