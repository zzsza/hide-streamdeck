import { describe, expect, it, vi } from "vitest";

import { generatePreviewHtml } from "../scripts/preview.js";
import { CountAction } from "../src/actions/count-action.js";
import { NeedsYouCountAction } from "../src/actions/needs-you-count.js";
import { WorkingCountAction } from "../src/actions/working-count.js";
import {
  connectionHint,
  connectionLabel,
  KEY_COLORS,
  KEY_SIZE,
  renderCountKey,
  renderNeedsYouCountKey,
  renderWorkingCountKey,
} from "../src/render/index.js";
import { FakeHideSource } from "../src/source/fake-source.js";
import { parsePsValue } from "../src/source/hide-access.js";
import type { AgentRow, ConnectionState, HideSnapshot } from "../src/source/types.js";
import { summarize } from "../src/state/classify.js";
import { StatusHub } from "../src/state/status-hub.js";

function makeAgent(index: number, state: string): AgentRow {
  return {
    id: `synthetic-agent-${index}`,
    name: `agent-${index}`,
    kind: "claude",
    state,
    line: `Synthetic line ${index}`,
    pane: `w1:p${index}`,
  };
}

function makeSnapshot(
  options: {
    connection?: ConnectionState;
    working?: number;
    needsYou?: number;
    toRead?: number;
  } = {},
): HideSnapshot {
  const agents: AgentRow[] = [];
  let index = 1;

  for (let i = 0; i < (options.working ?? 0); i += 1) {
    agents.push(makeAgent(index, i % 2 === 0 ? "going" : "waiting"));
    index += 1;
  }
  for (let i = 0; i < (options.needsYou ?? 0); i += 1) {
    agents.push(makeAgent(index, i % 2 === 0 ? "turn" : "look"));
    index += 1;
  }
  for (let i = 0; i < (options.toRead ?? 0); i += 1) {
    agents.push(makeAgent(index, "done"));
    index += 1;
  }

  return {
    connection: options.connection ?? { kind: "connected" },
    agents,
    readAt: 1_760_000_000_000,
  };
}

function decodeDataUrl(dataUrl: string): string {
  const prefix = "data:image/svg+xml;charset=utf8,";
  expect(dataUrl.startsWith(prefix)).toBe(true);
  return decodeURIComponent(dataUrl.slice(prefix.length));
}

describe("renderCountKey", () => {
  it("shows a single running session by its Hide label and labels a waiting fallback", () => {
    const raw = [
      { ...makeAgent(1, "waiting"), label: "응답 대기" },
      { ...makeAgent(2, "going"), label: "배포 점검" },
      { ...makeAgent(3, "going"), label: "문서 점검" },
    ];
    const parsed = parsePsValue({ panes: raw.map(agent => ({ pane: agent.pane, agent })) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const snapshot = { ...makeSnapshot(), agents: parsed.agents };
    const card = renderCountKey("working-agent", snapshot);
    expect(card).toMatch(/font-size="24"[^>]+>작업 중<\/text>/);
    expect(card).toContain("배포 점검");
    expect(card).not.toContain("응답 대기");
    expect(card).not.toContain("문서 점검");
    expect(renderCountKey("working-agent", { ...snapshot, agents: parsed.agents.slice(0, 1) })).toContain("대기 중");
    expect(renderCountKey("working-agent", makeSnapshot())).not.toContain("<text");
    expect(renderWorkingCountKey(snapshot)).toMatch(/font-size="24"[^>]+>작업 중<\/text>/);
  });

  it("shows distinct working sessions across four bindings and clears unoccupied slots", async () => {
    const snapshot = {
      ...makeSnapshot(),
      agents: [
        { ...makeAgent(1, "waiting"), label: "배포 대기" },
        { ...makeAgent(2, "going"), label: "자료 점검" },
        { ...makeAgent(3, "turn"), label: "승인 요청" },
        { ...makeAgent(4, "going"), label: "문서 정리" },
      ],
    };
    const hub = new StatusHub({ initialSettings: { source: "fake" }, sourceFactory: () => ({ read: async () => snapshot }) });
    const action = new CountAction(hub, "working-agent", "com.zzsza.hide-status.working-agent");
    const bindings = [undefined, 2, 3, 4].map((slot, index) => ({
      action: { id: String(index), isKey: () => true, setTitle: vi.fn(), setImage: vi.fn<(svg: string) => void>() },
      payload: { settings: { slot } },
    }));
    const image = (index: number) => decodeDataUrl(bindings[index]!.action.setImage.mock.lastCall![0]);

    try {
      for (const ev of bindings) action.onWillAppear(ev as never);
      await vi.waitFor(() => {
        expect(bindings.every(ev => ev.action.setImage.mock.calls.length > 0)).toBe(true);
      });
      expect(image(0)).toContain("자료 점검");
      expect(image(1)).toContain("문서 정리");
      expect(image(2)).toContain("배포 대기");
      expect(image(2)).toContain("대기 중");
      expect(image(3)).not.toContain("<text");

      action.onDidReceiveSettings({ action: bindings[1]!.action, payload: { settings: { slot: 4 } } } as never);
      expect(image(1)).not.toContain("<text");
    } finally {
      for (const ev of bindings) action.onWillDisappear(ev as never);
      hub.dispose();
    }
  });

  it("uses the Hide dark theme tokens and the concept D red label", () => {
    expect(KEY_COLORS).toEqual({
      background: "#0e0f12",
      card: "#1c1d20",
      text: "#f3f3f5",
      muted: "#8b8c90",
      disabled: "#393a3e",
      working: "#71a3ff",
      red: "#ff5c58",
      redLabel: "#2b0b0a",
    });
  });

  it("renders Working count key for 0, 1, 12, and 100+ with expected background and text", () => {
    const zeroSvg = renderWorkingCountKey(makeSnapshot({ working: 0, toRead: 3 }));
    expect(zeroSvg).toContain(`width="${KEY_SIZE}" height="${KEY_SIZE}"`);
    expect(zeroSvg).toContain("sans-serif");
    expect(zeroSvg).toContain(`fill="${KEY_COLORS.background}"`);
    expect(zeroSvg).toContain(`fill="${KEY_COLORS.disabled}"`);
    expect(zeroSvg).toContain('fill="#393a3e">작업 중</text>');
    expect(zeroSvg).toContain('fill="#393a3e">0</text>');
    expect(zeroSvg).not.toContain("<circle");

    const oneSvg = renderWorkingCountKey(makeSnapshot({ working: 1 }));
    expect(oneSvg).toContain(`fill="${KEY_COLORS.background}"`);
    expect(oneSvg).toContain(`fill="${KEY_COLORS.text}"`);
    expect(oneSvg).toContain('fill="#8b8c90">작업 중</text>');
    expect(oneSvg).toContain('<circle cx="124" cy="28" r="7" fill="#71a3ff"');
    expect(oneSvg).toContain(">1</text>");

    const twelveSvg = renderWorkingCountKey(makeSnapshot({ working: 12 }));
    expect(twelveSvg).toContain(`fill="${KEY_COLORS.background}"`);
    expect(twelveSvg).toContain(`fill="${KEY_COLORS.text}"`);
    expect(twelveSvg).toContain(">12</text>");

    const hundredSvg = renderWorkingCountKey(makeSnapshot({ working: 100 }));
    expect(hundredSvg).toContain(`fill="${KEY_COLORS.background}"`);
    expect(hundredSvg).toContain(">99+</text>");
    expect(hundredSvg).not.toContain(">100</text>");
  });

  it("renders Needs You count key for 0, 1, 12, and 100+ with expected background and text", () => {
    const zeroSvg = renderNeedsYouCountKey(makeSnapshot({ working: 4, needsYou: 0 }));
    expect(zeroSvg).toContain(`width="${KEY_SIZE}" height="${KEY_SIZE}"`);
    expect(zeroSvg).toContain("sans-serif");
    expect(zeroSvg).toContain(`fill="${KEY_COLORS.background}"`);
    expect(zeroSvg).toContain('fill="#393a3e">내 차례</text>');
    expect(zeroSvg).toContain('fill="#393a3e">0</text>');
    expect(zeroSvg).not.toContain("<circle");

    const oneSvg = renderNeedsYouCountKey(makeSnapshot({ needsYou: 1 }));
    expect(oneSvg).toContain('fill="#ff5c58"');
    expect(oneSvg).toContain('fill="#0e0f12"');
    expect(oneSvg).toContain('fill="#2b0b0a">내 차례</text>');
    expect(oneSvg).toContain('rx="0" fill="#ff5c58"');
    expect(oneSvg).toContain('fill="#0e0f12">1</text>');
    expect(oneSvg).toContain(">1</text>");

    const twelveSvg = renderNeedsYouCountKey(makeSnapshot({ needsYou: 12 }));
    expect(twelveSvg).toContain('fill="#ff5c58"');
    expect(twelveSvg).toContain('fill="#0e0f12"');
    expect(twelveSvg).toContain(">12</text>");

    const hundredPlusSvg = renderNeedsYouCountKey(makeSnapshot({ needsYou: 105 }));
    expect(hundredPlusSvg).toContain('fill="#ff5c58"');
    expect(hundredPlusSvg).toContain('fill="#0e0f12"');
    expect(hundredPlusSvg).toContain(">99+</text>");
    expect(hundredPlusSvg).not.toContain(">105</text>");
  });

  it("renders all 10 connection states on both keys and omits error.message", () => {
    const states: readonly ConnectionState[] = [
      { kind: "connected" },
      { kind: "not_connected" },
      { kind: "pending" },
      { kind: "refused" },
      { kind: "revoked" },
      { kind: "expired" },
      { kind: "hide_unavailable" },
      { kind: "hide_outdated" },
      { kind: "hide_missing" },
      { kind: "error", message: "synthetic-internal-error-detail" },
    ];

    expect(states).toHaveLength(10);

    for (const connection of states) {
      const snapshot = makeSnapshot({ connection, working: 2, needsYou: 1 });
      const workingSvg = renderCountKey("working", snapshot);
      const needsYouSvg = renderCountKey("needs_you", snapshot);
      const label = connectionLabel(connection);
      const hint = connectionHint(connection);

      if (label === null) {
        expect(workingSvg).toContain(`fill="${KEY_COLORS.background}"`);
        expect(workingSvg).toContain(">2</text>");
        expect(needsYouSvg).toContain('fill="#ff5c58"');
        expect(needsYouSvg).toContain(">1</text>");
        continue;
      }

      for (const [svg, title] of [
        [workingSvg, "작업 중"],
        [needsYouSvg, "내 차례"],
      ] as const) {
        expect(svg).toContain(`fill="${KEY_COLORS.background}"`);
        expect(svg).toContain(`>${title}</text>`);
        const texts = Array.from(svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g), (match) => match[1]);
        const statusLines = texts.slice(1, hint === null ? undefined : -1);
        expect(statusLines.length).toBeLessThanOrEqual(2);
        expect(statusLines.join(" ")).toBe(label);
        expect(svg).not.toContain(">2</text>");
        expect(svg).not.toContain(">1</text>");
        expect(svg).not.toContain("synthetic-internal-error-detail");

        if (hint !== null) {
          expect(svg).toContain(`>${hint}</text>`);
          const statusMatch = svg.match(
            new RegExp(
              `y="(\\d+)"[^>]*font-size="(\\d+)"[^>]*>${label}<\\/text><text x="72" y="(\\d+)"[^>]*font-size="(\\d+)"[^>]*>${hint}<\\/text>`,
            ),
          );
          expect(statusMatch).not.toBeNull();
          const statusY = Number(statusMatch?.[1]);
          const statusFont = Number(statusMatch?.[2]);
          const hintY = Number(statusMatch?.[3]);
          const hintFont = Number(statusMatch?.[4]);
          expect(hintY).toBeGreaterThan(statusY);
          expect(hintFont).toBeLessThan(statusFont);
          expect(hintFont).toBeLessThanOrEqual(14);
        } else {
          expect(svg).not.toContain("설정에서 연결 요청");
        }
      }
    }
  });
});

describe("WorkingCountAction and NeedsYouCountAction", () => {
  it("clears the default Stream Deck title and sets rendered SVG images on snapshot updates", async () => {
    const hub = new StatusHub({
      initialSettings: { source: "fake", fakeScenario: "needs-you-many" },
    });

    const workingAction = new WorkingCountAction(hub);
    const needsYouAction = new NeedsYouCountAction(hub);

    const workingSetTitle = vi.fn(async (_title?: string) => {});
    const workingSetImage = vi.fn(async (_image?: string) => {});
    const needsSetTitle = vi.fn(async (_title?: string) => {});
    const needsSetImage = vi.fn(async (_image?: string) => {});

    const workingEvent = {
      action: {
        id: "ctx-working-title",
        isKey: () => true,
        setTitle: workingSetTitle,
        setImage: workingSetImage,
      },
      payload: { settings: {} },
    };
    const needsEvent = {
      action: {
        id: "ctx-needs-title",
        isKey: () => true,
        setTitle: needsSetTitle,
        setImage: needsSetImage,
      },
      payload: { settings: {} },
    };

    workingAction.onWillAppear(workingEvent as never);
    needsYouAction.onWillAppear(needsEvent as never);

    expect(workingSetTitle).toHaveBeenCalledWith("");
    expect(needsSetTitle).toHaveBeenCalledWith("");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(workingSetImage).toHaveBeenCalledTimes(1);
    expect(needsSetImage).toHaveBeenCalledTimes(1);

    const workingSvg = decodeDataUrl(workingSetImage.mock.calls[0]?.[0] ?? "");
    const needsSvg = decodeDataUrl(needsSetImage.mock.calls[0]?.[0] ?? "");
    const snapshot = hub.getLastSnapshot();
    expect(snapshot).not.toBeNull();
    const expected = summarize(snapshot!);

    expect(workingSvg).toContain(">작업 중</text>");
    expect(workingSvg).toContain(`>${expected.working}</text>`);
    expect(needsSvg).toContain('fill="#ff5c58"');
    expect(needsSvg).toContain(">내 차례</text>");
    expect(needsSvg).toContain(`>${expected.needsYou.length}</text>`);

    workingAction.onWillDisappear(workingEvent as never);
    needsYouAction.onWillDisappear(needsEvent as never);
    hub.dispose();
  });
});

describe("preview output for count keys", () => {
  it("includes both count keys with red Needs You state and non-connected status labels", async () => {
    const html = await generatePreviewHtml();
    const matches = [...html.matchAll(/src="(data:image\/svg\+xml;charset=utf8,[^"]+)"/g)];
    const svgs = matches.map((match) => decodeURIComponent(match[1]!.slice("data:image/svg+xml;charset=utf8,".length)));
    const workingManySummary = summarize(await new FakeHideSource({ scenario: "working-many" }).read());

    expect(svgs.some((svg) => svg.includes(">작업 중</text>") && svg.includes(`>${workingManySummary.working}</text>`))).toBe(true);
    expect(svgs.some((svg) => svg.includes(">내 차례</text>") && svg.includes('fill="#ff5c58"'))).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">작업 중</text>") &&
          svg.includes(">연결 안 됨</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">내 차례</text>") &&
          svg.includes(">승인 대기</text>") &&
          !svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">작업 중</text>") &&
          svg.includes(">연결 끊김</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">내 차례</text>") &&
          svg.includes(">거절됨</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">작업 중</text>") &&
          svg.includes(">요청 만료</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
  });
});
