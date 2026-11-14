import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  NeedsYouAgentAction,
  normalizeNeedsYouAgentSettings,
} from "../src/actions/needs-you-agent.js";
import {
  estimateTextWidth,
  normalizeAgentSlot,
  renderAgentKey,
  selectNeedsYouAgent,
  wrapTextLines,
} from "../src/render/agent-key.js";
import { connectionLabel } from "../src/render/connection-label.js";
import { KEY_SIZE } from "../src/render/key-svg.js";
import { FakeHideSource } from "../src/source/fake-source.js";
import type { AgentRow, ConnectionState, HideSnapshot } from "../src/source/types.js";
import { StatusHub } from "../src/state/status-hub.js";

function makeSnapshot(
  agents: AgentRow[],
  connection: ConnectionState = { kind: "connected" },
): HideSnapshot {
  return {
    connection,
    agents,
    readAt: 1_760_000_000_000,
  };
}

function makeAgent(overrides: Partial<AgentRow> & Pick<AgentRow, "id" | "name" | "state">): AgentRow {
  return {
    id: overrides.id,
    name: overrides.name,
    kind: overrides.kind ?? "claude",
    state: overrides.state,
    line: overrides.line === undefined ? null : overrides.line,
    pane: overrides.pane ?? "w1:p1",
  };
}

function extractTextContents(svg: string): string[] {
  const matches = svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g);
  return Array.from(matches, (m) =>
    m[1]!
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&"),
  );
}

describe("slot normalization and selection", () => {
  it("normalizes missing, non-integer, or out-of-range slots to 1 (valid range 1..20)", () => {
    expect(normalizeAgentSlot(undefined)).toBe(1);
    expect(normalizeAgentSlot(null)).toBe(1);
    expect(normalizeAgentSlot(0)).toBe(1);
    expect(normalizeAgentSlot(-3)).toBe(1);
    expect(normalizeAgentSlot(1.5)).toBe(1);
    expect(normalizeAgentSlot(21)).toBe(1);
    expect(normalizeAgentSlot(999)).toBe(1);
    expect(normalizeAgentSlot(Number.NaN)).toBe(1);
    expect(normalizeAgentSlot(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeAgentSlot("")).toBe(1);
    expect(normalizeAgentSlot("abc")).toBe(1);
    expect(normalizeAgentSlot("0")).toBe(1);
    expect(normalizeAgentSlot("1.5")).toBe(1);
    expect(normalizeAgentSlot("21")).toBe(1);

    expect(normalizeAgentSlot(1)).toBe(1);
    expect(normalizeAgentSlot(2)).toBe(2);
    expect(normalizeAgentSlot(20)).toBe(20);
    expect(normalizeAgentSlot("3")).toBe(3);
    expect(normalizeAgentSlot(" 20 ")).toBe(20);
  });

  it("selects the N-th Needs You agent in input order", () => {
    const snap = makeSnapshot([
      makeAgent({ id: "a1", name: "atlas", state: "going", pane: "w1:p1", line: "working" }),
      makeAgent({ id: "a2", name: "nova", state: "turn", pane: "w1:p2", line: "first" }),
      makeAgent({ id: "a3", name: "lyra", state: "done", pane: "w1:p3", line: "done" }),
      makeAgent({ id: "a4", name: "vega", state: "look", pane: "w2:p1", line: "second" }),
    ]);

    expect(selectNeedsYouAgent(snap, 1)?.name).toBe("nova");
    expect(selectNeedsYouAgent(snap, 2)?.name).toBe("vega");
    expect(selectNeedsYouAgent(snap, 3)).toBeNull();
    expect(selectNeedsYouAgent(snap, 0)?.name).toBe("nova");
    expect(selectNeedsYouAgent(snap, 21)?.name).toBe("nova");
    expect(selectNeedsYouAgent(snap, 1.5)?.name).toBe("nova");
    expect(selectNeedsYouAgent(snap, undefined)?.name).toBe("nova");
  });
});

describe("text wrapping and width estimation", () => {
  it("caps line count and keeps every wrapped line within maxWidth for Korean and English text", () => {
    const samples = [
      "hyperion-telemetry-pipeline-coordinator-superlong-identifier",
      "공백이하나도없는아주긴한글에이전트이름테스트입니다계속이어집니다",
      "가상 시나리오에서 긴 한국어 안내 문장이 세 줄 안에 깔끔하게 줄바꿈되고 말줄임 처리되는지 확인해 주세요 정말 길어요",
      "Waiting for review on multi-region synthetic routing table and fallback retry policy diff across clusters",
      "Mixed 한국어와 EnglishWordWithoutAnySpacesInBetweenToTestWrappingBehavior",
    ];

    for (const sample of samples) {
      const nameLines = wrapTextLines(sample, {
        maxWidth: 120,
        maxLines: 2,
        fontSize: 16,
        bold: true,
      });
      expect(nameLines.length).toBeGreaterThan(0);
      expect(nameLines.length).toBeLessThanOrEqual(2);
      for (const line of nameLines) {
        expect(estimateTextWidth(line, 16, true)).toBeLessThanOrEqual(120);
      }

      const bodyLines = wrapTextLines(sample, {
        maxWidth: 120,
        maxLines: 3,
        fontSize: 13,
        bold: false,
      });
      expect(bodyLines.length).toBeGreaterThan(0);
      expect(bodyLines.length).toBeLessThanOrEqual(3);
      for (const line of bodyLines) {
        expect(estimateTextWidth(line, 13, false)).toBeLessThanOrEqual(120);
      }
    }
  });

  it("never splits family emoji (ZWJ) or combining accents across lines or truncation boundaries", () => {
    const familyEmoji = "👨‍👩‍👧‍👦";
    const emojiWrapSamples = [
      `aaaaaa${familyEmoji}끝`,
      `aaaaaaaaaaa${familyEmoji}끝`,
      `aaaaaaaaaaaa${familyEmoji}끝`,
      `aaaaaaaaaaa${familyEmoji}끝aaaaaaaaaaaa`,
    ];

    for (const sample of emojiWrapSamples) {
      const lines = wrapTextLines(sample, {
        maxWidth: 120,
        maxLines: 2,
        fontSize: 16,
        bold: true,
      });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) {
        const withoutFullEmoji = line.replaceAll(familyEmoji, "");
        expect(withoutFullEmoji).not.toContain("👨");
        expect(withoutFullEmoji).not.toContain("👩");
        expect(withoutFullEmoji).not.toContain("👧");
        expect(withoutFullEmoji).not.toContain("👦");
        expect(withoutFullEmoji).not.toContain("\u200d");
        expect(estimateTextWidth(line, 16, true)).toBeLessThanOrEqual(120);
      }
      if (!lines.join("").includes("…")) {
        expect(lines.join("")).toContain(familyEmoji);
      }
    }

    const combiningSamples = [
      "aaaaaaaaaaae\u0301끝",
      "aaaaaaaaaaaae\u0301끝",
      "aaaaaaaaaaae\u0301끝aaaaaaaaaaaa",
    ];
    for (const sample of combiningSamples) {
      const lines = wrapTextLines(sample, {
        maxWidth: 120,
        maxLines: 2,
        fontSize: 16,
        bold: true,
      });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) {
        expect(line.startsWith("\u0301")).toBe(false);
        expect(estimateTextWidth(line, 16, true)).toBeLessThanOrEqual(120);
      }
      if (!lines.join("").includes("…")) {
        expect(lines.join("")).toContain("e\u0301");
      }
    }

    // Verify rendered SVG preserves full grapheme clusters on boundary-crossing names.
    const snap = makeSnapshot([
      makeAgent({
        id: "g1",
        name: `aaaaaaaaaaa${familyEmoji}끝`,
        state: "turn",
        line: "확인",
      }),
      makeAgent({
        id: "g2",
        name: "aaaaaaaaaaae\u0301끝",
        state: "look",
        line: "확인",
      }),
    ]);
    expect(extractTextContents(renderAgentKey(snap, { slot: 1 })).join("")).toContain(familyEmoji);
    expect(extractTextContents(renderAgentKey(snap, { slot: 2 })).join("")).toContain("e\u0301");
  });
});

describe("renderAgentKey", () => {
  it("renders occupied slot with red accent, name, and line", () => {
    const snap = makeSnapshot([
      makeAgent({
        id: "a1",
        name: "nova",
        state: "turn",
        line: "Approve schema update?",
      }),
    ]);

    const svg = renderAgentKey(snap, { slot: 1 });
    expect(svg).toContain(`width="${KEY_SIZE}"`);
    expect(svg).toContain(`height="${KEY_SIZE}"`);
    expect(svg).toContain("#ef4444");

    const texts = extractTextContents(svg);
    expect(texts).toContain("nova");
    expect(texts.join(" ")).toContain("Approve schema update?");
    expect(texts).toContain("#1");
  });

  it("falls back to Korean state labels when line is null", () => {
    const snap = makeSnapshot([
      makeAgent({ id: "a1", name: "zephyr", state: "turn", line: null }),
      makeAgent({ id: "a2", name: "orion", state: "look", line: null }),
    ]);

    const turnTexts = extractTextContents(renderAgentKey(snap, { slot: 1 }));
    expect(turnTexts).toContain("zephyr");
    expect(turnTexts).toContain("차례");

    const lookTexts = extractTextContents(renderAgentKey(snap, { slot: 2 }));
    expect(lookTexts).toContain("orion");
    expect(lookTexts).toContain("확인 요청");
  });

  it("renders a dimmed empty key with only slot number when slot has no agent", () => {
    const snap = makeSnapshot([
      makeAgent({ id: "a1", name: "nova", state: "turn", line: "Ready" }),
    ]);

    const svg = renderAgentKey(snap, { slot: 3 });
    expect(svg).not.toContain("#ef4444");
    expect(svg).not.toContain("nova");
    expect(extractTextContents(svg)).toEqual(["#3"]);
  });

  it("renders connectionLabel on a dimmed key when not connected", () => {
    const states: ConnectionState[] = [
      { kind: "not_connected" },
      { kind: "pending" },
      { kind: "refused" },
      { kind: "revoked" },
      { kind: "expired" },
      { kind: "hide_unavailable" },
      { kind: "hide_outdated" },
      { kind: "hide_missing" },
      { kind: "error", message: "spawn failed" },
    ];

    for (const connection of states) {
      const snap = makeSnapshot(
        [makeAgent({ id: "a1", name: "nova", state: "turn", line: "Should stay hidden" })],
        connection,
      );
      const svg = renderAgentKey(snap, { slot: 1 });
      const expectedLabel = connectionLabel(connection) ?? "";
      const texts = extractTextContents(svg);
      const bodyTexts = texts.filter((t) => t !== "#1");

      expect(svg).not.toContain("#ef4444");
      expect(svg).not.toContain("Should stay hidden");
      expect(bodyTexts.length).toBeGreaterThan(0);
      expect(bodyTexts.length).toBeLessThanOrEqual(3);
      expect(expectedLabel.length).toBeGreaterThan(0);
      expect(bodyTexts[0]?.slice(0, 4)).toBe(expectedLabel.slice(0, 4));
    }
  });

  it("renders Korean and long English agents in fake needs-you-many scenario without overflow", async () => {
    const snap = await new FakeHideSource({ scenario: "needs-you-many" }).read();
    for (const slot of [1, 2, 3, 4, 5]) {
      const svg = renderAgentKey(snap, { slot });
      const texts = extractTextContents(svg);
      expect(texts.length).toBeGreaterThanOrEqual(3);
      expect(texts.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("NeedsYouAgentAction settings and UI", () => {
  it("normalizes slot settings to integers within 1..20", () => {
    expect(normalizeNeedsYouAgentSettings(undefined)).toEqual({ slot: 1 });
    expect(normalizeNeedsYouAgentSettings({ slot: 0 })).toEqual({ slot: 1 });
    expect(normalizeNeedsYouAgentSettings({ slot: 1.5 })).toEqual({ slot: 1 });
    expect(normalizeNeedsYouAgentSettings({ slot: 21 })).toEqual({ slot: 1 });
    expect(normalizeNeedsYouAgentSettings({ slot: "2" })).toEqual({ slot: 2 });
    expect(normalizeNeedsYouAgentSettings({ slot: 20 })).toEqual({ slot: 20 });
  });

  it("updates rendered image when slot settings arrive", async () => {
    const hub = new StatusHub({
      initialSettings: { source: "fake", fakeScenario: "needs-you-many" },
    });
    const action = new NeedsYouAgentAction(hub);
    const setImage = vi.fn(async (_image?: string) => {});
    const keyAction = {
      id: "ctx-1",
      isKey: () => true,
      setImage,
    };

    action.onWillAppear({
      action: keyAction,
      payload: { settings: {} },
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setImage).toHaveBeenCalledTimes(1);
    const firstSvg = decodeURIComponent(
      (setImage.mock.calls[0]?.[0] ?? "").replace("data:image/svg+xml;charset=utf8,", ""),
    );
    expect(firstSvg).toContain("nova");

    action.onDidReceiveSettings({
      action: keyAction,
      payload: { settings: { slot: "2" } },
    } as never);
    expect(setImage).toHaveBeenCalledTimes(2);
    const secondSvg = decodeURIComponent(
      (setImage.mock.calls[1]?.[0] ?? "").replace("data:image/svg+xml;charset=utf8,", ""),
    );
    expect(secondSvg).toContain("hyperion-");

    action.onWillDisappear({ action: keyAction } as never);
    hub.dispose();
  });

  it("configures slot input (1-20) in property inspector HTML and prevents saving out-of-range values", async () => {
    const htmlPath = path.resolve(
      process.cwd(),
      "com.zzsza.hide-status.sdPlugin/ui/needs-you-agent.html",
    );
    const piSharedPath = path.resolve(
      process.cwd(),
      "com.zzsza.hide-status.sdPlugin/ui/pi-shared.js",
    );
    const html = await fs.readFile(htmlPath, "utf8");
    const piSharedCode = await fs.readFile(piSharedPath, "utf8");

    expect(html).not.toContain("TODO(agent-key)");
    expect(html).toContain('data-action-setting="slot"');
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="20"');

    const inlineScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
    expect(inlineScriptMatch).not.toBeNull();
    const inlineScript = inlineScriptMatch![1]!;

    const listeners: Record<string, Array<() => void>> = {};
    const slotElement = {
      tagName: "INPUT",
      type: "number",
      value: "",
      checked: false,
      getAttribute(name: string) {
        if (name === "data-action-setting") return "slot";
        if (name === "data-default") return "1";
        return null;
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

    const sentMessages: Array<Record<string, unknown>> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (evt: { data: string }) => void;
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
        readyState: "interactive",
        addEventListener() {},
        getElementById(id: string) {
          return id === "slot" ? slotElement : null;
        },
        querySelectorAll(selector: string) {
          if (selector === "[data-action-setting]") return [slotElement];
          return [];
        },
      },
    };

    // Inline script runs before defer pi-shared.js during HTML parse.
    vm.runInNewContext(inlineScript, sandbox);
    vm.runInNewContext(piSharedCode, sandbox);

    const connect = sandbox.window.connectElgatoStreamDeckSocket as (
      port: number,
      uuid: string,
      registerEvent: string,
      info: string,
      actionInfo: string,
    ) => void;
    connect(28196, "pi-ctx-slot", "registerPropertyInspector", "{}", JSON.stringify({ payload: { settings: { slot: 3 } } }));
    sentMessages.length = 0;

    for (const invalidValue of ["21", "0", "-2", "1.5", "abc"]) {
      slotElement.value = invalidValue;
      slotElement.dispatch("change");
      expect(slotElement.value).toBe("3");
      expect(sentMessages).toHaveLength(0);
    }

    slotElement.value = "20";
    slotElement.dispatch("change");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({
      event: "setSettings",
      context: "pi-ctx-slot",
      payload: { slot: 20 },
    });
  });
});
