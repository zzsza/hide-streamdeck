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
  private source: HideSource;
  private sourceGeneration = 0;

  private readonly listeners = new Set<StatusListener>();
  private lastSnapshot: HideSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private repollImmediately = false;
  private disposed = false;

  constructor(options: StatusHubOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onListenerError = options.onListenerError;
    this.sourceFactory =
      options.sourceFactory ?? ((normalized) => createHideSource(normalized, { now: this.now }));
    this.settings = normalizeGlobalSettings(options.initialSettings);
    this.source = this.sourceFactory(this.settings);
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

  subscribe(listener: StatusListener): () => void {
    if (this.disposed) {
      return () => {};
    }

    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);

    if (this.lastSnapshot !== null) {
      this.notifySingle(listener, this.lastSnapshot);
    }

    if (wasEmpty) {
      this.triggerPollNow();
    }

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.clearTimer();
        this.repollImmediately = false;
      }
    };
  }

  updateSettings(rawSettings?: GlobalSettings | null): void {
    if (this.disposed) {
      return;
    }

    const nextSettings = normalizeGlobalSettings(rawSettings);
    if (areSettingsEqual(this.settings, nextSettings)) {
      return;
    }

    const previousSource = this.source;
    this.settings = nextSettings;
    this.sourceGeneration += 1;
    this.lastSnapshot = null;
    this.clearTimer();

    try {
      previousSource.dispose?.();
    } catch {
      // Ignore disposal errors from outgoing sources.
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
    this.sourceGeneration += 1;
    this.clearTimer();
    this.repollImmediately = false;
    this.listeners.clear();
    try {
      this.source.dispose?.();
    } catch {
      // Ignore disposal errors.
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private triggerPollNow(): void {
    this.clearTimer();
    if (this.inFlight) {
      this.repollImmediately = true;
      return;
    }
    void this.runPoll();
  }

  private async runPoll(): Promise<void> {
    if (this.disposed || this.listeners.size === 0 || this.inFlight) {
      return;
    }

    this.clearTimer();
    this.inFlight = true;
    const capturedGeneration = this.sourceGeneration;
    const capturedSource = this.source;

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
      this.inFlight = false;
    }

    if (this.disposed) {
      return;
    }

    // If settings swapped the source while read() was running, discard stale result.
    if (capturedGeneration !== this.sourceGeneration) {
      if (this.listeners.size > 0) {
        this.repollImmediately = false;
        void this.runPoll();
      }
      return;
    }

    this.lastSnapshot = snapshot;

    if (this.listeners.size === 0) {
      this.repollImmediately = false;
      return;
    }

    this.broadcast(snapshot);

    if (this.disposed || this.listeners.size === 0) {
      this.repollImmediately = false;
      return;
    }

    if (this.repollImmediately) {
      this.repollImmediately = false;
      void this.runPoll();
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runPoll();
    }, this.intervalMs);
  }

  private broadcast(snapshot: HideSnapshot): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) {
        continue;
      }
      this.notifySingle(listener, snapshot);
    }
  }

  private notifySingle(listener: StatusListener, snapshot: HideSnapshot): void {
    try {
      listener(snapshot);
    } catch (error) {
      this.onListenerError?.(error);
    }
  }
}
