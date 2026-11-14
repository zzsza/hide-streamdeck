import { describe, expect, it, vi } from "vitest";

import {
  createHideSource,
  DEFAULT_HIDE_PATH,
  FAKE_SCENARIOS,
  FakeHideSource,
  HideCliSource,
  type HideExec,
} from "../src/source/index.js";
import { summarize } from "../src/state/classify.js";

describe("FakeHideSource", () => {
  it("supports all agent and connection scenarios", async () => {
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

    const connectionScenarios: ReadonlyArray<[string, string]> = [
      ["not-connected", "not_connected"],
      ["pending", "pending"],
      ["refused", "refused"],
      ["revoked", "revoked"],
      ["expired", "expired"],
      ["hide-unavailable", "hide_unavailable"],
      ["hide-outdated", "hide_outdated"],
      ["hide-missing", "hide_missing"],
      ["error", "error"],
    ];

    for (const [scenarioId, expectedKind] of connectionScenarios) {
      const snap = await new FakeHideSource({ scenario: scenarioId }).read();
      expect(snap.connection.kind).toBe(expectedKind);
      expect(snap.agents).toHaveLength(0);
    }
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
    expect(FAKE_SCENARIOS.length).toBe(14);
  });

  it("switches not-connected, refused, revoked, and expired scenarios to pending after requestAccess()", async () => {
    const requestableCases = [
      ["not-connected", "not_connected"],
      ["refused", "refused"],
      ["revoked", "revoked"],
      ["expired", "expired"],
    ] as const;

    for (const [scenario, initialKind] of requestableCases) {
      const source = new FakeHideSource({ scenario });
      expect((await source.read()).connection).toEqual({ kind: initialKind });
      source.requestAccess();
      expect((await source.read()).connection).toEqual({ kind: "pending" });
    }

    const unavailable = new FakeHideSource({ scenario: "hide-unavailable" });
    unavailable.requestAccess();
    expect((await unavailable.read()).connection).toEqual({ kind: "hide_unavailable" });
  });
});

describe("createHideSource", () => {
  it("passes hidePath and injected exec to HideCliSource without invoking any binary", () => {
    const stubExec: HideExec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));

    const source = createHideSource(undefined, {
      cliOptions: { exec: stubExec },
    });

    expect(source).toBeInstanceOf(HideCliSource);
    const cliSource = source as HideCliSource;
    expect(cliSource.hidePath).toBe(DEFAULT_HIDE_PATH);
    expect(cliSource.exec).toBe(stubExec);
    expect(stubExec).not.toHaveBeenCalled();
  });

  it("creates FakeHideSource when source is set to fake", async () => {
    const source = createHideSource({ source: "fake", fakeScenario: "pending" });
    expect(source).toBeInstanceOf(FakeHideSource);

    const snapshot = await source.read();
    expect(snapshot.connection).toEqual({ kind: "pending" });
  });
});
