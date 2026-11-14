import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HideSnapshot, HideSource, NormalizedGlobalSettings } from "../src/source/types.js";
import { DEFAULT_POLL_INTERVAL_MS, StatusHub } from "../src/state/status-hub.js";

function makeSnapshot(readAt: number, agentName = "atlas"): HideSnapshot {
  return {
    connection: { kind: "connected" },
    readAt,
    agents: [
      {
        id: `id-${agentName}`,
        name: agentName,
        kind: "claude",
        state: "turn",
        line: "Sample line",
        pane: "w1:p1",
      },
    ],
  };
}

describe("StatusHub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll while there are zero subscribers and stops when subscribers drop to zero", async () => {
    const read = vi.fn(async () => makeSnapshot(Date.now()));
    const hub = new StatusHub({
      sourceFactory: () => ({ read }),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).not.toHaveBeenCalled();

    const received: HideSnapshot[] = [];
    const unsubscribe = hub.subscribe((snap) => received.push(snap));

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);

    unsubscribe();
    expect(hub.getSubscriberCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 10);
    expect(read).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);
  });

  it("runs only one read per interval across multiple subscribers and delivers last snapshot immediately to late subscribers", async () => {
    let callCount = 0;
    const read = vi.fn(async () => {
      callCount += 1;
      return makeSnapshot(Date.now(), `agent-${callCount}`);
    });
    const hub = new StatusHub({
      sourceFactory: () => ({ read }),
    });

    const firstEvents: HideSnapshot[] = [];
    const secondEvents: HideSnapshot[] = [];
    const thirdEvents: HideSnapshot[] = [];

    const unsub1 = hub.subscribe((s) => firstEvents.push(s));
    const unsub2 = hub.subscribe((s) => secondEvents.push(s));

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);

    // Late subscriber receives the cached snapshot synchronously without triggering an extra read.
    const unsub3 = hub.subscribe((s) => thirdEvents.push(s));
    expect(thirdEvents).toHaveLength(1);
    expect(thirdEvents[0]?.agents[0]?.name).toBe("agent-1");
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(firstEvents).toHaveLength(2);
    expect(secondEvents).toHaveLength(2);
    expect(thirdEvents).toHaveLength(2);

    unsub1();
    unsub2();
    // Still 1 subscriber remaining, polling continues.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(3);

    unsub3();
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 3);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("schedules the next poll 1500ms after the previous read finishes without overlapping slow reads", async () => {
    let activeReads = 0;
    let maxConcurrentReads = 0;
    const resolvers: Array<(snap: HideSnapshot) => void> = [];

    const read = vi.fn(
      () =>
        new Promise<HideSnapshot>((resolve) => {
          activeReads += 1;
          maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
          resolvers.push((snap) => {
            activeReads -= 1;
            resolve(snap);
          });
        }),
    );

    const hub = new StatusHub({
      sourceFactory: () => ({ read }),
    });

    const unsub = hub.subscribe(() => {});
    expect(read).toHaveBeenCalledTimes(1);

    // Even if 5 seconds pass while the first read is still running, no second read starts.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(maxConcurrentReads).toBe(1);

    // Finish the first read at t = 5000ms.
    resolvers.shift()!(makeSnapshot(Date.now()));
    await Promise.resolve();

    // At 1499ms after completion, next read has not started yet.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);

    // At 1500ms after completion, second read starts.
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(maxConcurrentReads).toBe(1);

    unsub();
    resolvers.shift()?.(makeSnapshot(Date.now()));
  });

  it("converts read() exceptions into error connection snapshots and keeps polling", async () => {
    let failNext = true;
    const read = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error("spawn EACCES");
      }
      return makeSnapshot(Date.now(), "vega");
    });

    const hub = new StatusHub({
      sourceFactory: () => ({ read }),
    });

    const snapshots: HideSnapshot[] = [];
    const unsub = hub.subscribe((s) => snapshots.push(s));

    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.connection).toEqual({
      kind: "error",
      message: "spawn EACCES",
    });
    expect(snapshots[0]?.agents).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.connection).toEqual({ kind: "connected" });
    expect(snapshots[1]?.agents[0]?.name).toBe("vega");

    unsub();
  });

  it("replaces and disposes the old source when global settings change", async () => {
    const createdSettings: NormalizedGlobalSettings[] = [];
    const disposedIndices: number[] = [];

    const hub = new StatusHub({
      initialSettings: { source: "hide" },
      sourceFactory: (settings): HideSource => {
        const idx = createdSettings.length;
        createdSettings.push(settings);
        return {
          read: async () =>
            settings.source === "fake"
              ? makeSnapshot(Date.now(), `fake-${settings.fakeScenario}`)
              : {
                  connection: { kind: "not_connected" },
                  agents: [],
                  readAt: Date.now(),
                },
          dispose: () => {
            disposedIndices.push(idx);
          },
        };
      },
    });

    const received: HideSnapshot[] = [];
    const unsub = hub.subscribe((s) => received.push(s));
    await vi.advanceTimersByTimeAsync(0);

    expect(createdSettings).toHaveLength(1);
    expect(received[0]?.connection).toEqual({ kind: "not_connected" });

    // No-op when settings are unchanged.
    hub.updateSettings({ source: "hide" });
    expect(createdSettings).toHaveLength(1);
    expect(disposedIndices).toEqual([]);

    // Switching to fake disposes source 0 and immediately polls source 1.
    hub.updateSettings({ source: "fake", fakeScenario: "needs-you-one" });
    await vi.advanceTimersByTimeAsync(0);

    expect(disposedIndices).toEqual([0]);
    expect(createdSettings).toHaveLength(2);
    expect(received.at(-1)?.agents[0]?.name).toBe("fake-needs-you-one");

    unsub();
  });
});
