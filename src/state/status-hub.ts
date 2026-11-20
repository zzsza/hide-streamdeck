import { createHideSource } from "../source/index.js";
import {
  normalizeGlobalSettings,
  type GlobalSettings,
  type HideSnapshot,
  type HideSource,
  type NormalizedGlobalSettings,
} from "../source/types.js";

export const DEFAULT_POLL_INTERVAL_MS = 1_500;

export type StatusListener = (snapshot: HideSnapshot) => void;
export type SourceFactory = (settings: NormalizedGlobalSettings) => HideSource;

export interface StatusHubOptions {
  intervalMs?: number;
  initialSettings?: GlobalSettings | null;
  sourceFactory?: SourceFactory;
  now?: () => number;
  onListenerError?: (error: unknown) => void;
}

function areSettingsEqual(a: NormalizedGlobalSettings, b: NormalizedGlobalSettings): boolean {
  return a.source === b.source && a.hidePath === b.hidePath && a.fakeScenario === b.fakeScenario;
}

export class StatusHub {
  private readonly intervalMs: number;
  private readonly sourceFactory: SourceFactory;
  private readonly now: () => number;
  private readonly onListenerError?: (error: unknown) => void;

  private settings: NormalizedGlobalSettings;
  private source: HideSource | null = null;
  private sourceGeneration = 0;
  private ready = false;

  private readonly listeners = new Set<StatusListener>();
  private readonly snapshotObservers = new Set<StatusListener>();
  private lastSnapshot: HideSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeReadGeneration: number | null = null;
  private repollGeneration: number | null = null;
  private disposed = false;
  private missionSubscribers = 0;
  private missionPoll: AbortController | null = null;
  private missionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StatusHubOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onListenerError = options.onListenerError;
    this.sourceFactory =
      options.sourceFactory ?? ((normalized) => createHideSource(normalized, { now: this.now }));
    this.settings = normalizeGlobalSettings(options.initialSettings);

    if (options.initialSettings !== undefined) {
      this.ready = true;
      this.sourceGeneration = 1;
      this.source = this.sourceFactory(this.settings);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getSettings(): NormalizedGlobalSettings {
    return { ...this.settings };
  }

  getLastSnapshot(): HideSnapshot | null {
    return this.lastSnapshot;
  }

  getSubscriberCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: StatusListener, includeMissions = false): () => void {
    if (this.disposed) {
      return () => {};
    }

    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);
    if (includeMissions) this.missionSubscribers++;

    if (this.lastSnapshot !== null) {
      this.notifySingle(listener, this.lastSnapshot);
    }

    if (wasEmpty && this.ready) {
      this.triggerPollNow();
    }

    if (includeMissions && !wasEmpty) this.refreshMissions();
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.listeners.delete(listener);
      if (includeMissions) {
        this.missionSubscribers--;
        if (this.missionSubscribers === 0) this.stopMissionPoll();
      }
      if (this.listeners.size === 0) {
        this.repollGeneration = null;
        this.clearTimer();
      }
    };
  }

  onSnapshot(observer: StatusListener): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.snapshotObservers.add(observer);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.snapshotObservers.delete(observer);
    };
  }

  requestAccess(): void {
    if (this.disposed || !this.ready || this.source === null) {
      return;
    }

    try {
      this.source.requestAccess?.();
    } catch (error) {
      this.reportError(error);
    }

    if (this.listeners.size === 0) {
      return;
    }

    this.clearTimer();
    if (this.activeReadGeneration === this.sourceGeneration) {
      this.repollGeneration = this.sourceGeneration;
      return;
    }

    this.repollGeneration = null;
    void this.runPoll();
  }

  updateSettings(rawSettings?: GlobalSettings | null): void {
    if (this.disposed) {
      return;
    }

    const nextSettings = normalizeGlobalSettings(rawSettings);
    if (this.ready && areSettingsEqual(this.settings, nextSettings)) {
      return;
    }

    const previousSource = this.source;
    this.ready = true;
    this.settings = nextSettings;
    this.sourceGeneration += 1;
    this.repollGeneration = null;
    this.stopMissionPoll();
    this.lastSnapshot = null;
    this.clearTimer();

    if (previousSource !== null) {
      this.disposeSourceSafely(previousSource);
    }

    this.source = this.sourceFactory(this.settings);

    if (this.listeners.size > 0) {
      this.triggerPollNow();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopMissionPoll();
    this.ready = false;
    this.sourceGeneration += 1;
    this.activeReadGeneration = null;
    this.repollGeneration = null;
    this.clearTimer();
    this.listeners.clear();
    this.snapshotObservers.clear();

    const currentSource = this.source;
    this.source = null;
    if (currentSource !== null) {
      this.disposeSourceSafely(currentSource);
    }
  }

  private disposeSourceSafely(target: HideSource): void {
    try {
      target.dispose?.();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    this.onListenerError?.(error);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private triggerPollNow(): void {
    this.clearTimer();
    void this.runPoll();
  }

  private async runPoll(): Promise<void> {
    if (
      this.disposed ||
      !this.ready ||
      this.source === null ||
      this.listeners.size === 0 ||
      this.activeReadGeneration === this.sourceGeneration
    ) {
      return;
    }

    this.clearTimer();
    const capturedGeneration = this.sourceGeneration;
    const capturedSource = this.source;
    this.activeReadGeneration = capturedGeneration;

    let snapshot: HideSnapshot;
    try {
      snapshot = await capturedSource.read();
    } catch (error) {
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : typeof error === "string" && error.length > 0
            ? error
            : "Failed to read Hide status";
      snapshot = {
        connection: { kind: "error", message },
        agents: [],
        readAt: this.now(),
      };
    } finally {
      if (this.activeReadGeneration === capturedGeneration) {
        this.activeReadGeneration = null;
      }
    }

    if (this.disposed || capturedGeneration !== this.sourceGeneration) {
      return;
    }

    if (snapshot.connection.kind !== "connected") {
      this.stopMissionPoll();
    } else if (this.missionSubscribers && this.source?.readMissions && this.lastSnapshot?.missions) {
      snapshot = { ...snapshot, missions: this.lastSnapshot.missions };
    }
    this.lastSnapshot = snapshot;

    if (this.listeners.size === 0) {
      this.repollGeneration = null;
      return;
    }

    this.broadcast(snapshot);
    this.refreshMissions();

    if (
      this.disposed ||
      capturedGeneration !== this.sourceGeneration ||
      this.listeners.size === 0
    ) {
      return;
    }

    if (this.repollGeneration === capturedGeneration) {
      this.repollGeneration = null;
      void this.runPoll();
      return;
    }

    if (this.activeReadGeneration === capturedGeneration) {
      return;
    }

    this.timer = setTimeout(() => {
      if (capturedGeneration !== this.sourceGeneration) {
        return;
      }
      this.timer = null;
      void this.runPoll();
    }, this.intervalMs);
  }

  private stopMissionPoll(): void {
    this.missionPoll?.abort();
    this.missionPoll = null;
    if (this.missionTimer !== null) clearTimeout(this.missionTimer);
    this.missionTimer = null;
  }

  private refreshMissions(): void {
    if (!this.missionSubscribers || !this.source?.readMissions || this.lastSnapshot?.connection.kind !== "connected"
      || this.missionPoll || this.missionTimer || this.disposed) return;

    const poll = new AbortController();
    this.missionPoll = poll;
    const started = this.now();
    void this.source.readMissions(poll.signal).catch(() => ({ kind: "error" as const })).then(missions => {
      if (poll.signal.aborted || !this.lastSnapshot) return;
      this.lastSnapshot = { ...this.lastSnapshot, missions };
      this.broadcast(this.lastSnapshot);
      if (poll.signal.aborted) return;
      this.missionPoll = null;
      this.missionTimer = setTimeout(() => {
        this.missionTimer = null;
        this.refreshMissions();
      }, Math.max(0, 10_000 - (this.now() - started)));
    });
  }

  private broadcast(snapshot: HideSnapshot): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) {
        continue;
      }
      this.notifySingle(listener, snapshot);
    }
    for (const observer of [...this.snapshotObservers]) {
      if (!this.snapshotObservers.has(observer)) {
        continue;
      }
      this.notifySingle(observer, snapshot);
    }
  }

  private notifySingle(listener: StatusListener, snapshot: HideSnapshot): void {
    try {
      listener(snapshot);
    } catch (error) {
      this.reportError(error);
    }
  }
}
