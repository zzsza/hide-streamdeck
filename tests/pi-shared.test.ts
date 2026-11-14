import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface FakeElement {
  tagName: string;
  type: string;
  value: string;
  checked: boolean;
  attributes: Record<string, string>;
  listeners: Record<string, Array<() => void>>;
  classList: {
    hidden: boolean;
    toggle(cls: string, force?: boolean): void;
  };
  getAttribute(name: string): string | null;
  addEventListener(event: string, fn: () => void): void;
  dispatch(event: string): void;
}

function makeElement(
  tagName: string,
  type: string,
  attrs: Record<string, string>,
  initialValue = "",
): FakeElement {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    tagName,
    type,
    value: initialValue,
    checked: false,
    attributes: attrs,
    listeners,
    classList: {
      hidden: false,
      toggle(_cls: string, force?: boolean) {
        if (force !== undefined) {
          this.hidden = force;
        }
      },
    },
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
    addEventListener(event: string, fn: () => void) {
      listeners[event] ??= [];
      listeners[event]!.push(fn);
    },
    dispatch(event: string) {
      for (const fn of listeners[event] ?? []) {
        fn();
      }
    },
  };
}

async function setupPiEnvironment() {
  const sourceSelect = makeElement("SELECT", "select-one", { "data-global-setting": "source" });
  const hidePathInput = makeElement("INPUT", "text", { "data-global-setting": "hidePath" });
  const scenarioSelect = makeElement("SELECT", "select-one", {
    "data-global-setting": "fakeScenario",
  });
  const slotInput = makeElement("INPUT", "number", { "data-action-setting": "slot" });

  const globalControls = [sourceSelect, hidePathInput, scenarioSelect];
  const actionControls = [slotInput];

  const sentMessages: Array<Record<string, unknown>> = [];
  const sockets: MockWebSocket[] = [];

  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (evt: { data: string }) => void;
    constructor(_url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      sentMessages.push(JSON.parse(raw) as Record<string, unknown>);
    }
  }

  const sandbox = {
    window: {} as Record<string, unknown>,
    WebSocket: MockWebSocket,
    WeakMap,
    Object,
    Number,
    String,
    Boolean,
    JSON,
    document: {
      readyState: "complete",
      addEventListener() {},
      querySelectorAll(selector: string) {
        if (selector === "[data-global-setting]") return globalControls;
        if (selector === "[data-action-setting]") return actionControls;
        if (selector === "[data-visible-when-source]") return [];
        return [];
      },
    },
  };

  const scriptPath = path.resolve(
    process.cwd(),
    "com.zzsza.hide-status.sdPlugin/ui/pi-shared.js",
  );
  const code = await fs.readFile(scriptPath, "utf8");
  vm.runInNewContext(code, sandbox);

  const connect = sandbox.window.connectElgatoStreamDeckSocket as (
    port: number,
    uuid: string,
    registerEvent: string,
    info: string,
    actionInfo: string,
  ) => void;

  connect(28196, "pi-ctx-1", "registerPropertyInspector", "{}", JSON.stringify({ payload: { settings: { slot: 2 } } }));
  const socket = sockets[0];
  socket?.onopen?.();

  return {
    sourceSelect,
    hidePathInput,
    scenarioSelect,
    slotInput,
    sentMessages,
    receive(message: Record<string, unknown>) {
      socket?.onmessage?.({ data: JSON.stringify(message) });
    },
  };
}

describe("ui/pi-shared.js", () => {
  it("preserves existing global keys when input changes before didReceiveGlobalSettings arrives", async () => {
    const env = await setupPiEnvironment();
    env.sentMessages.length = 0;

    // User switches source before didReceiveGlobalSettings arrives.
    env.sourceSelect.value = "fake";
    env.sourceSelect.dispatch("change");
    expect(env.sentMessages).toHaveLength(0);

    // Saved global settings arrive with a custom hidePath and scenario.
    env.receive({
      event: "didReceiveGlobalSettings",
      payload: {
        settings: {
          source: "hide",
          hidePath: "/opt/custom/hide",
          fakeScenario: "pending",
        },
      },
    });

    expect(env.sentMessages).toHaveLength(1);
    expect(env.sentMessages[0]).toEqual({
      event: "setGlobalSettings",
      context: "pi-ctx-1",
      payload: {
        source: "fake",
        hidePath: "/opt/custom/hide",
        fakeScenario: "pending",
      },
    });
  });

  it("commits hidePath on change/blur rather than keystroke input, and does not save empty number as 0", async () => {
    const env = await setupPiEnvironment();
    env.receive({
      event: "didReceiveGlobalSettings",
      payload: { settings: { source: "hide", hidePath: "/usr/local/bin/hide" } },
    });
    env.sentMessages.length = 0;

    // Typing fires input, which must not send setGlobalSettings.
    env.hidePathInput.value = "/usr/local/bin/hide-dev";
    env.hidePathInput.dispatch("input");
    expect(env.sentMessages).toHaveLength(0);

    // Blur commits once, and a subsequent change with the same value does not duplicate.
    env.hidePathInput.dispatch("blur");
    env.hidePathInput.dispatch("change");
    expect(env.sentMessages).toHaveLength(1);
    expect(env.sentMessages[0]?.payload).toEqual({
      source: "hide",
      hidePath: "/usr/local/bin/hide-dev",
    });

    // Clearing a number input removes the key instead of saving 0.
    env.sentMessages.length = 0;
    env.slotInput.value = "";
    env.slotInput.dispatch("change");
    expect(env.sentMessages).toHaveLength(1);
    expect(env.sentMessages[0]).toEqual({
      event: "setSettings",
      context: "pi-ctx-1",
      payload: {},
    });
  });
});
