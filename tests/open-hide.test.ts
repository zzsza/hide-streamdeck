import { ChildProcess } from "node:child_process";
import { runInNewContext } from "node:vm";
import streamDeck, { type KeyDownEvent } from "@elgato/streamdeck";
import { expect, it, vi } from "vitest";
import { CountAction } from "../src/actions/count-action.js";
import { HIDE_NAVIGATION_SCRIPT } from "../src/actions/hide-navigation.js";
import { NeedsYouAgentAction } from "../src/actions/needs-you-agent.js";
import { NeedsYouCountAction } from "../src/actions/needs-you-count.js";
import { openHideOnKeyDown } from "../src/actions/open-hide.js";
import { WorkingCountAction } from "../src/actions/working-count.js";
import { DASHBOARD_LABELS, type DashboardKey } from "../src/render/count-key.js";
import { StatusHub } from "../src/state/status-hub.js";

const showAlert = () => vi.fn(async () => {});
function keyEvent(alert: ReturnType<typeof showAlert>) {
  return { action: { showAlert: alert } } as unknown as KeyDownEvent;
}

it("foregrounds Hide and sends the reply key to the first waiting session", async () => {
  const hub = new StatusHub();
  vi.spyOn(hub, "getLastSnapshot").mockReturnValue({
    connection: { kind: "connected" },
    agents: [
      { id: "a", name: "One", kind: "codex", state: "turn", line: null, pane: "w1:p1" },
      { id: "b", name: "Two", kind: "codex", state: "going", line: null, pane: "w1:p2" },
    ],
    readAt: 0,
  });
  const actions = [
    new WorkingCountAction(hub), new NeedsYouCountAction(hub), new NeedsYouAgentAction(hub),
    ...Object.keys(DASHBOARD_LABELS).map(key =>
      new CountAction(hub, key as DashboardKey, `com.zzsza.hide-status.${key}`)),
  ];
  const requestAccess = vi.spyOn(hub, "requestAccess");
  const launch = vi.fn(() => {
    const child = new ChildProcess();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
  const alert = showAlert();
  const destinations: Record<string, string> = {
    "com.zzsza.hide-status.working-count": "overview",
    "com.zzsza.hide-status.needs-you-count": "needs_you",
    "com.zzsza.hide-status.reply": "needs_you",
    "com.zzsza.hide-status.working-agent": "overview",
    "com.zzsza.hide-status.to-read": "to-read",
    "com.zzsza.hide-status.mission": "mission",
  };
  expect(actions).toHaveLength(11);
  for (const action of actions) {
    launch.mockClear();
    await action.onKeyDown(keyEvent(alert), "darwin", launch);
    expect(launch).toHaveBeenNthCalledWith(1, "/usr/bin/open", ["-b", "me.grab.hide.desktop"], {
      shell: false, stdio: "ignore",
    });
    const destination = destinations[action.manifestId ?? ""];
    expect(launch).toHaveBeenCalledTimes(destination ? 2 : 1);
    if (destination) {
      expect(launch).toHaveBeenNthCalledWith(2, "/usr/bin/osascript", [
        "-l", "JavaScript", "-e", HIDE_NAVIGATION_SCRIPT, destination,
      ], { shell: false, stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
    }
  }
  expect(requestAccess).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  hub.dispose();
});

it("opens the first My turn session and keeps Unread results as a list", () => {
  const collection = <T>(items: T[]) => ({ count: items.length, objectAtIndex: (index: number) => items[index] });
  const element = (role: string, title: string, value?: number, children: Record<string, unknown>[] = []) => ({
    AXRole: role, AXTitle: title, AXValue: value, AXChildren: collection(children),
  });
  const mission = element("AXMenuItem", "미션 열기");
  const overview = element("AXMenuItem", "개요");
  const menu = element("AXMenuBarItem", "보기", undefined, [mission, overview]);
  const work = element("AXTab", "작업 9", 1);
  const tabs = element("AXTabGroup", "개요 보기", undefined, [work]);
  const sessions = element("AXRadioButton", "세션 목록", 0);
  const unread = element("AXCheckBox", "안 읽은 결과 0", 0);
  const filters = element("AXGroup", "세션 필터", undefined, [unread]);
  const first = element("AXButton", "답하러 가기");
  const second = element("AXButton", "답하러 가기");
  const waiting = element("AXGroup", "나를 기다리는 것", undefined, [first, second]);
  const overviewPage = element("AXGroup", "", undefined, [tabs, sessions, filters, waiting]);
  const webArea = {
    ...element("AXWebArea", "hide", undefined, [element("AXButton", "내 차례 99")]), AXURL: { host: "127.0.0.1" },
  };
  const browser = { ...element("AXWebArea", "hide"), AXURL: { host: "example.com" } };
  let nativeFrame: Record<string, unknown> = webArea;
  for (let depth = 0; depth < 9; depth++) nativeFrame = element("AXGroup", "", undefined, [nativeFrame]);
  const activated: string[] = [];
  let focused: typeof mission;
  const app = {
    AXMenuBar: { AXChildren: collection([menu]) },
    AXFocusedWindow: { AXChildren: collection([browser, nativeFrame]) },
  };
  const context = {
    ObjC: {
      import() {},
      castRefToObject: (ref: { value: unknown }) => ref.value,
      unwrap: (value: unknown) => value,
    },
    Ref: () => [],
    $: Object.assign((value: string) => value, {
      AXIsProcessTrusted: () => true,
      NSThread: { sleepForTimeInterval() {} },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => collection([{ processIdentifier: 1 }]) },
      AXUIElementCreateApplication: () => app,
      AXUIElementCopyAttributeValue(node: Record<string, unknown>, name: string, ref: unknown[]) {
        if (name === "AXFocused") {
          ref[0] = { value: node === focused };
          return 0;
        }
        if (node[name] === undefined) return -25205;
        ref[0] = { value: node[name] };
        return 0;
      },
      AXUIElementCopyMultipleAttributeValues(node: Record<string, unknown>, names: string[], _options: number, ref: unknown[]) {
        ref[0] = { value: collection(names.map(name => node[name])) };
        return 0;
      },
      AXUIElementPerformAction(node: typeof mission, action: string) {
        expect(action).toBe("AXPress");
        activated.push(node.AXTitle);
        if (node === overview) webArea.AXChildren = collection([overviewPage]);
        return 0;
      },
      AXUIElementSetAttributeValue(node: typeof mission, attribute: string, value: boolean) {
        expect([attribute, value]).toEqual(["AXFocused", true]);
        focused = node;
        return 0;
      },
      AXUIElementGetPid(node: typeof app, ref: number[]) {
        expect(node).toBe(app);
        ref[0] = 1;
        return 0;
      },
      CGEventCreateKeyboardEvent(_source: unknown, keyCode: number, down: boolean) {
        expect(keyCode).toBe(49);
        return { down };
      },
      CGEventSetFlags() {},
      CGEventPostToPid(pid: number, event: { down: boolean }) {
        expect(pid).toBe(1);
        if (event.down) return;
        activated.push(focused.AXTitle);
        if (focused.AXValue !== undefined) focused.AXValue = 1;
        expect(focused).not.toBe(second);
        if (focused === first) webArea.AXChildren = collection([]);
      },
    }),
  };
  runInNewContext(`${HIDE_NAVIGATION_SCRIPT}\nrun(["mission"]); run(["needs_you"]); run(["to-read"]);`, context);
  expect(activated).toEqual(["미션 열기", "개요", "답하러 가기", "개요", "세션 목록", "안 읽은 결과 0"]);
});

it("ignores overlapping navigation presses and accepts the next press after completion", async () => {
  const open = new ChildProcess();
  const launch = vi.fn(() => {
    if (launch.mock.calls.length === 1) return open;
    const child = new ChildProcess();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
  const alert = showAlert();
  const first = openHideOnKeyDown(keyEvent(alert), "darwin", launch, "overview");
  await openHideOnKeyDown(keyEvent(alert), "darwin", launch, "needs_you");
  expect(launch).toHaveBeenCalledTimes(1);
  open.emit("close", 0, null);
  await first;
  await openHideOnKeyDown(keyEvent(alert), "darwin", launch, "needs_you");
  expect(launch).toHaveBeenCalledTimes(4);
  expect(alert).not.toHaveBeenCalled();
});

it.each(["win32", "linux"] as const)("does nothing on %s", async platform => {
  const launch = vi.fn(() => new ChildProcess());
  const alert = showAlert();
  await openHideOnKeyDown(keyEvent(alert), platform, launch);
  expect(launch).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
});

it.each(["throw", "error", "exit", "signal"])("alerts the pressed key once on %s", async failure => {
  const alert = showAlert();
  const warning = vi.spyOn(streamDeck.logger, "warn").mockReturnValue(streamDeck.logger);
  try {
    await openHideOnKeyDown(keyEvent(alert), "darwin", () => {
      if (failure === "throw") throw new Error("synthetic spawn failure");
      const child = new ChildProcess();
      queueMicrotask(() => {
        if (failure === "error") child.emit("error", new Error("synthetic launch failure"));
        child.emit("close", failure === "signal" ? null : 1, failure === "signal" ? "SIGTERM" : null);
      });
      return child;
    });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
  }
});
