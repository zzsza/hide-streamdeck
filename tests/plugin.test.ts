import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PropertyInspectorConnectionMessage, PropertyInspectorUi } from "../src/plugin.js";
import type { GlobalSettings, HideSnapshot } from "../src/source/types.js";
import { StatusHub } from "../src/state/status-hub.js";

const sdkMocks = vi.hoisted(() => {
  const globalSettingsListeners: Array<(ev: { settings: GlobalSettings }) => void> = [];
  const sendToPluginListeners: Array<(ev: { payload: unknown }) => void> = [];
  const piAppearListeners: Array<(ev: { action: { id: string } }) => void> = [];
  const piDisappearListeners: Array<(ev: { action: { id: string } }) => void> = [];
  const registeredActions: unknown[] = [];

  const sendToPropertyInspector = vi.fn(async (_payload: unknown) => {});
  const getGlobalSettings = vi.fn(
    async (): Promise<GlobalSettings> => ({
      source: "fake",
      fakeScenario: "not-connected",
    }),
  );
  const connect = vi.fn(async () => {});
  const loggerError = vi.fn();

  return {
    globalSettingsListeners,
    sendToPluginListeners,
    piAppearListeners,
    piDisappearListeners,
    registeredActions,
    sendToPropertyInspector,
    getGlobalSettings,
    connect,
    loggerError,
  };
});

vi.mock("@elgato/streamdeck", () => {
  class MockSingletonAction {}
  const actionDecorator = () => (_target: unknown, _ctx?: unknown) => {};

  const streamDeckMock = {
    logger: {
      error: sdkMocks.loggerError,
    },
    settings: {
      onDidReceiveGlobalSettings: (fn: (ev: { settings: GlobalSettings }) => void) => {
        sdkMocks.globalSettingsListeners.push(fn);
        return { dispose() {} };
      },
      getGlobalSettings: sdkMocks.getGlobalSettings,
    },
    actions: {
      registerAction: (instance: unknown) => {
        sdkMocks.registeredActions.push(instance);
      },
    },
    ui: {
      onSendToPlugin: (fn: (ev: { payload: unknown }) => void) => {
        sdkMocks.sendToPluginListeners.push(fn);
        return { dispose() {} };
      },
      sendToPropertyInspector: sdkMocks.sendToPropertyInspector,
      onDidAppear: (fn: (ev: { action: { id: string } }) => void) => {
        sdkMocks.piAppearListeners.push(fn);
        return { dispose() {} };
      },
      onDidDisappear: (fn: (ev: { action: { id: string } }) => void) => {
        sdkMocks.piDisappearListeners.push(fn);
        return { dispose() {} };
      },
    },
    connect: sdkMocks.connect,
  };

  return {
    default: streamDeckMock,
    streamDeck: streamDeckMock,
    SingletonAction: MockSingletonAction,
    action: actionDecorator,
  };
});

describe("plugin Property Inspector event wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdkMocks.sendToPropertyInspector.mockClear();
    sdkMocks.loggerError.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards hub snapshots to sendToPropertyInspector and triggers hub.requestAccess() on requestAccess messages", async () => {
    const { wirePropertyInspector } = await import("../src/plugin.js");

    let currentKind: HideSnapshot["connection"] = { kind: "not_connected" };
    const requestAccessSource = vi.fn(() => {
      currentKind = { kind: "pending" };
    });

    const hub = new StatusHub({
      initialSettings: { source: "fake" },
      sourceFactory: () => ({
        read: async () => ({
          connection: currentKind,
          agents: [],
          readAt: Date.now(),
        }),
        requestAccess: requestAccessSource,
      }),
    });

    let onSendHandler: ((ev: { payload: unknown }) => void) | undefined;
    let onAppearHandler: ((ev: { action: { id: string } }) => void) | undefined;
    let onDisappearHandler: ((ev: { action: { id: string } }) => void) | undefined;
    const sentToPi: PropertyInspectorConnectionMessage[] = [];

    const mockUi: PropertyInspectorUi = {
      onSendToPlugin(fn) {
        onSendHandler = fn;
        return { dispose() {} };
      },
      async sendToPropertyInspector(payload) {
        sentToPi.push(payload);
      },
      onDidAppear(fn) {
        onAppearHandler = fn;
        return { dispose() {} };
      },
      onDidDisappear(fn) {
        onDisappearHandler = fn;
        return { dispose() {} };
      },
    };

    const unwire = wirePropertyInspector(mockUi, hub);

    // With 0 subscribers and closed PI, polling stays stopped.
    expect(hub.getSubscriberCount()).toBe(0);

    // Opening PI starts polling and emits current connection kind.
    onAppearHandler?.({ action: { id: "act-1" } });
    expect(hub.getSubscriberCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentToPi).toEqual([{ event: "connection", kind: "not_connected" }]);

    // Unrelated payloads are ignored.
    onSendHandler?.({ payload: { event: "unrelated" } });
    onSendHandler?.({ payload: null });
    expect(requestAccessSource).not.toHaveBeenCalled();

    // Receiving { event: "requestAccess" } invokes hub.requestAccess() and pushes updated connection kind.
    onSendHandler?.({ payload: { event: "requestAccess" } });
    expect(requestAccessSource).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentToPi).toEqual([
      { event: "connection", kind: "not_connected" },
      { event: "connection", kind: "pending" },
    ]);

    // Closing PI with no visible keys returns subscriber count to 0.
    onDisappearHandler?.({ action: { id: "act-1" } });
    expect(hub.getSubscriberCount()).toBe(0);

    unwire();
    hub.dispose();
  });

  it("wires top-level plugin bootstrap to streamDeck.ui for requestAccess and connection updates", async () => {
    await import("../src/plugin.js");
    await vi.advanceTimersByTimeAsync(0);

    expect(sdkMocks.registeredActions).toHaveLength(9);
    expect(sdkMocks.sendToPluginListeners.length).toBeGreaterThan(0);

    // Open PI on the top-level plugin instance -> polls not-connected fake scenario.
    for (const listener of sdkMocks.piAppearListeners) {
      listener({ action: { id: "pi-top-1" } });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkMocks.sendToPropertyInspector).toHaveBeenLastCalledWith({
      event: "connection",
      kind: "not_connected",
    });

    // Send { event: "requestAccess" } from PI -> FakeHideSource transitions to pending and pushes update.
    for (const listener of sdkMocks.sendToPluginListeners) {
      listener({ payload: { event: "requestAccess" } });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkMocks.sendToPropertyInspector).toHaveBeenLastCalledWith({
      event: "connection",
      kind: "pending",
    });

    for (const listener of sdkMocks.piDisappearListeners) {
      listener({ action: { id: "pi-top-1" } });
    }
  });
});
