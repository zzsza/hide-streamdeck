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

  it("waits for the first updateSettings call before creating a source or polling when initialSettings is omitted", async () => {
    const read = vi.fn(async () => makeSnapshot(Date.now(), "nova"));
    const sourceFactory = vi.fn(() => ({ read }));
    const hub = new StatusHub({ sourceFactory });

    expect(hub.isReady()).toBe(false);

    const received: HideSnapshot[] = [];
    const unsubscribe = hub.subscribe((snap) => received.push(snap));

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS * 5);
    expect(sourceFactory).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);

    // First settings arrival starts polling immediately even when values match defaults.
    hub.updateSettings({});
    expect(hub.isReady()).toBe(true);
    expect(sourceFactory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);

    unsubscribe();
  });

  it("does not poll while there are zero subscribers and stops when subscribers drop to zero", async () => {
    const read = vi.fn(async () => makeSnapshot(Date.now()));
    const hub = new StatusHub({
      initialSettings: { source: "fake" },
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
      initialSettings: { source: "fake" },
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
      initialSettings: { source: "fake" },
      sourceFactory: () => ({ read }),
    });

    const unsub = hub.subscribe(() => {});
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(maxConcurrentReads).toBe(1);

    resolvers.shift()!(makeSnapshot(Date.now()));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);

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
      initialSettings: { source: "fake" },
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

  it("immediately polls the new source even if the previous generation read never finishes, and reports dispose errors", async () => {
    const createdSettings: NormalizedGlobalSettings[] = [];
    const reportedErrors: unknown[] = [];
    let newSourceCalls = 0;

    const hub = new StatusHub({
      initialSettings: { source: "hide" },
      onListenerError: (err) => reportedErrors.push(err),
      sourceFactory: (settings): HideSource => {
        createdSettings.push(settings);
        if (settings.source === "hide") {
          return {
            // Never resolves.
            read: () => new Promise<HideSnapshot>(() => {}),
            dispose: () => {
              throw new Error("dispose failure");
            },
          };
        }
        return {
          read: async () => {
            newSourceCalls += 1;
            return makeSnapshot(Date.now(), `fresh-${newSourceCalls}`);
          },
        };
      },
    });

    const received: HideSnapshot[] = [];
    const unsub = hub.subscribe((s) => received.push(s));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(received).toHaveLength(0);

    // Switch settings while generation 1 read is permanently hung.
    hub.updateSettings({ source: "fake", fakeScenario: "needs-you-one" });
    expect(reportedErrors).toHaveLength(1);
    expect((reportedErrors[0] as Error).message).toBe("dispose failure");

    await vi.advanceTimersByTimeAsync(0);
    expect(newSourceCalls).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.agents[0]?.name).toBe("fresh-1");

    // Subsequent intervals keep polling the new source normally.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(newSourceCalls).toBe(2);
    expect(received).toHaveLength(2);
    expect(received[1]?.agents[0]?.name).toBe("fresh-2");

    unsub();
    hub.dispose();
  });
});
