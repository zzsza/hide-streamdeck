import { describe, expect, it } from "vitest";

import {
  createHideSource,
  DEFAULT_HIDE_PATH,
  FAKE_SCENARIOS,
  FakeHideSource,
  HideCliSource,
} from "../src/source/index.js";
import { summarize } from "../src/state/classify.js";

describe("FakeHideSource", () => {
  it("supports empty, working-many, needs-you-one, needs-you-many, not-connected, and pending scenarios", async () => {
    const emptySnap = await new FakeHideSource({ scenario: "empty" }).read();
    expect(emptySnap.connection).toEqual({ kind: "connected" });
    expect(emptySnap.agents).toHaveLength(0);

    const workingSnap = await new FakeHideSource({ scenario: "working-many" }).read();
    expect(workingSnap.connection).toEqual({ kind: "connected" });
    const workingSummary = summarize(workingSnap);
    expect(workingSummary.working).toBeGreaterThan(1);
    expect(workingSummary.needsYou).toHaveLength(0);

    const oneSnap = await new FakeHideSource({ scenario: "needs-you-one" }).read();
    expect(summarize(oneSnap).needsYou).toHaveLength(1);

    const manySnap = await new FakeHideSource({ scenario: "needs-you-many" }).read();
    const manySummary = summarize(manySnap);
    expect(manySummary.needsYou.length).toBeGreaterThan(1);
    expect(manySummary.needsYou.some((a) => a.name.length >= 25)).toBe(true);
    expect(manySummary.needsYou.some((a) => (a.line ?? "").length >= 60)).toBe(true);

    const disconnectedSnap = await new FakeHideSource({ scenario: "not-connected" }).read();
    expect(disconnectedSnap.connection).toEqual({ kind: "not_connected" });
    expect(disconnectedSnap.agents).toHaveLength(0);

    const pendingSnap = await new FakeHideSource({ scenario: "pending" }).read();
    expect(pendingSnap.connection).toEqual({ kind: "pending" });
    expect(pendingSnap.agents).toHaveLength(0);
  });

  it("transitions across states over time in the cycling scenario", async () => {
    let clock = 1_000;
    const source = new FakeHideSource({
      scenario: "cycling",
      now: () => clock,
      cycleStepMs: 3_000,
    });

    const first = await source.read();
    expect(first.connection).toEqual({ kind: "pending" });

    clock += 3_000;
    const second = await source.read();
    expect(second.connection).toEqual({ kind: "connected" });
    expect(summarize(second).working).toBeGreaterThan(1);
    expect(summarize(second).needsYou).toHaveLength(0);

    clock += 3_000;
    const third = await source.read();
    expect(summarize(third).needsYou).toHaveLength(1);

    clock += 3_000;
    const fourth = await source.read();
    expect(summarize(fourth).needsYou.length).toBeGreaterThan(1);

    clock += 3_000;
    const fifth = await source.read();
    expect(fifth.agents).toHaveLength(0);
  });

  it("returns fresh copies of agent rows so callers cannot mutate fixtures", async () => {
    const source = new FakeHideSource({ scenario: "needs-you-one" });
    const snapA = await source.read();
    snapA.agents[0]!.name = "mutated";
    snapA.agents.pop();

    const snapB = await source.read();
    expect(snapB.agents).toHaveLength(2);
    expect(snapB.agents[0]!.name).toBe("atlas");
  });

  it("registers metadata for every scenario id", () => {
    expect(FAKE_SCENARIOS.length).toBeGreaterThanOrEqual(7);
  });
});

describe("createHideSource", () => {
  it("defaults to HideCliSource with default hidePath when settings are empty", async () => {
    const source = createHideSource();
    expect(source).toBeInstanceOf(HideCliSource);
    expect((source as HideCliSource).hidePath).toBe(DEFAULT_HIDE_PATH);

    const snapshot = await source.read();
    expect(snapshot.connection).toEqual({ kind: "error", message: "not implemented" });
  });

  it("creates FakeHideSource when source is set to fake", async () => {
    const source = createHideSource({ source: "fake", fakeScenario: "pending" });
    expect(source).toBeInstanceOf(FakeHideSource);

    const snapshot = await source.read();
    expect(snapshot.connection).toEqual({ kind: "pending" });
  });
});
