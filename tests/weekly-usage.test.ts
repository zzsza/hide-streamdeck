import { runInNewContext } from "node:vm";
import type { WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { expect, it, vi } from "vitest";
import { HIDE_WEEKLY_USAGE_SCRIPT } from "../src/actions/hide-navigation.js";
import { parseWeeklyUsage, renderWeeklyUsage, WeeklyUsageAction, WeeklyUsagePoll } from "../src/actions/weekly-usage.js";
import { renderCountKey } from "../src/render/count-key.js";

it("converts only weekly Hide usage chips to remaining percentages", () => {
  const chips = ["Claude Code, 7일, 80%", "Codex, 7 days, 100%", "Antigravity, 7日間, 9%", "Codex, 5 hours, 10%"];
  const matches = runInNewContext(`${HIDE_WEEKLY_USAGE_SCRIPT}\nJSON.stringify(chips.map(weeklyReading));`, {
    ObjC: { import() {} }, $: (value: unknown) => value, chips,
  });
  expect(JSON.parse(matches)).toEqual([["claude", 20], ["codex", 0], ["antigravity", 91], null]);
  expect(parseWeeklyUsage('{"claude":0,"codex":102,"antigravity":"91"}')).toEqual({ claude: 0 });
  expect(renderWeeklyUsage("codex", 0)).toContain("0%</text>");
  expect(renderWeeklyUsage("codex")).toContain(">-</text>");
});

it("shares one quota read across keys and stops polling after all keys disappear", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn(async () => ({ claude: 20, codex: 40, antigravity: 91 }));
    const poll = new WeeklyUsagePoll(read);
    const listener = vi.fn();
    const unsubscribe = [poll.subscribe(listener), poll.subscribe(vi.fn()), poll.subscribe(vi.fn())];
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ claude: 20, codex: 40, antigravity: 91 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    for (const stop of unsubscribe) stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("updates a weekly dial and keeps the same action usable on a regular key", async () => {
  const poll = new WeeklyUsagePoll(async () => ({ codex: 0 }));
  const quota = new WeeklyUsageAction("codex", poll);
  const setFeedback = vi.fn();
  const setImage = vi.fn();
  const dial = { id: "dial", isDial: () => true, isKey: () => false, setFeedback };
  const key = { id: "key", isDial: () => false, isKey: () => true, setImage };

  quota.onWillAppear({ action: dial } as unknown as WillAppearEvent);
  quota.onWillAppear({ action: key } as unknown as WillAppearEvent);
  await vi.waitFor(() => {
    expect(setFeedback).toHaveBeenLastCalledWith({ title: "GPT", value: { value: "0%", color: "#ff5c58" } });
    expect(setImage).toHaveBeenCalledTimes(2);
  });
  expect(setFeedback).toHaveBeenNthCalledWith(1, { title: "GPT", value: { value: "-", color: "#393a3e" } });
  quota.onWillDisappear({ action: dial } as unknown as WillDisappearEvent);
  quota.onWillDisappear({ action: key } as unknown as WillDisappearEvent);
});

it("only lights the reply key for an operator turn", () => {
  const agent = { id: "a", name: "One", kind: "codex", state: "look", line: null, pane: "w1:p1" };
  const snapshot = { connection: { kind: "connected" as const }, agents: [agent], readAt: 0 };
  expect(renderCountKey("reply", snapshot)).not.toContain("답변 필요");
  expect(renderCountKey("reply", { ...snapshot, agents: [{ ...agent, state: "turn", parent: "other" }] })).not.toContain("답변 필요");
  expect(renderCountKey("reply", { ...snapshot, agents: [{ ...agent, state: "turn" }] })).toContain("답변 필요");
});
