import { ChildProcess } from "node:child_process";
import type { KeyDownEvent } from "@elgato/streamdeck";
import { expect, it, vi } from "vitest";
import { CountAction } from "../src/actions/count-action.js";
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

it("all nine actions foreground Hide on macOS using a single shell-free open per press", async () => {
  const hub = new StatusHub();
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
  for (const action of actions) await action.onKeyDown(keyEvent(alert), "darwin", launch);
  expect(actions).toHaveLength(9);
  expect(launch).toHaveBeenCalledTimes(9);
  for (const args of launch.mock.calls) {
    expect(args).toEqual(["/usr/bin/open", ["-b", "me.grab.hide.desktop"], { shell: false, stdio: "ignore" }]);
  }
  expect(requestAccess).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  hub.dispose();
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
});
