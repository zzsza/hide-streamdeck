import { describe, expect, it, vi } from "vitest";

import { generatePreviewHtml } from "../scripts/preview.js";
import { NeedsYouCountAction } from "../src/actions/needs-you-count.js";
import { WorkingCountAction } from "../src/actions/working-count.js";
import {
  connectionHint,
  connectionLabel,
  COUNT_KEY_COLORS,
  KEY_SIZE,
  renderCountKey,
  renderNeedsYouCountKey,
  renderWorkingCountKey,
} from "../src/render/index.js";
import { FakeHideSource } from "../src/source/fake-source.js";
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
  it("renders Working count key for 0, 1, 12, and 100+ with expected background and text", () => {
    const zeroSvg = renderWorkingCountKey(makeSnapshot({ working: 0, toRead: 3 }));
    expect(zeroSvg).toContain(`width="${KEY_SIZE}" height="${KEY_SIZE}"`);
    expect(zeroSvg).toContain("sans-serif");
    expect(zeroSvg).toContain(`fill="${COUNT_KEY_COLORS.workingZero.background}"`);
    expect(zeroSvg).toContain(`fill="${COUNT_KEY_COLORS.workingZero.number}"`);
    expect(zeroSvg).toContain(">Working</text>");
    expect(zeroSvg).toContain(">0</text>");

    const oneSvg = renderWorkingCountKey(makeSnapshot({ working: 1 }));
    expect(oneSvg).toContain(`fill="${COUNT_KEY_COLORS.workingActive.background}"`);
    expect(oneSvg).toContain(`fill="${COUNT_KEY_COLORS.workingActive.number}"`);
    expect(oneSvg).toContain(">Working</text>");
    expect(oneSvg).toContain(">1</text>");

    const twelveSvg = renderWorkingCountKey(makeSnapshot({ working: 12 }));
    expect(twelveSvg).toContain(`fill="${COUNT_KEY_COLORS.workingActive.background}"`);
    expect(twelveSvg).toContain(`fill="${COUNT_KEY_COLORS.workingActive.number}"`);
    expect(twelveSvg).toContain(">12</text>");

    const hundredSvg = renderWorkingCountKey(makeSnapshot({ working: 100 }));
    expect(hundredSvg).toContain(`fill="${COUNT_KEY_COLORS.workingActive.background}"`);
    expect(hundredSvg).toContain(">99+</text>");
    expect(hundredSvg).not.toContain(">100</text>");
  });

  it("renders Needs You count key for 0, 1, 12, and 100+ with expected background and text", () => {
    const zeroSvg = renderNeedsYouCountKey(makeSnapshot({ working: 4, needsYou: 0 }));
    expect(zeroSvg).toContain(`width="${KEY_SIZE}" height="${KEY_SIZE}"`);
    expect(zeroSvg).toContain("sans-serif");
    expect(zeroSvg).toContain(`fill="${COUNT_KEY_COLORS.needsYouZero.background}"`);
    expect(zeroSvg).toContain(">Needs You</text>");
    expect(zeroSvg).toContain(">0</text>");

    const oneSvg = renderNeedsYouCountKey(makeSnapshot({ needsYou: 1 }));
    expect(oneSvg).toContain('fill="#d92d20"');
    expect(oneSvg).toContain('fill="#ffffff"');
    expect(oneSvg).toContain(">Needs You</text>");
    expect(oneSvg).toContain(">1</text>");

    const twelveSvg = renderNeedsYouCountKey(makeSnapshot({ needsYou: 12 }));
    expect(twelveSvg).toContain('fill="#d92d20"');
    expect(twelveSvg).toContain('fill="#ffffff"');
    expect(twelveSvg).toContain(">12</text>");

    const hundredPlusSvg = renderNeedsYouCountKey(makeSnapshot({ needsYou: 105 }));
    expect(hundredPlusSvg).toContain('fill="#d92d20"');
    expect(hundredPlusSvg).toContain('fill="#ffffff"');
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
        expect(workingSvg).toContain(`fill="${COUNT_KEY_COLORS.workingActive.background}"`);
        expect(workingSvg).toContain(">2</text>");
        expect(needsYouSvg).toContain('fill="#d92d20"');
        expect(needsYouSvg).toContain(">1</text>");
        continue;
      }

      for (const [svg, title] of [
        [workingSvg, "Working"],
        [needsYouSvg, "Needs You"],
      ] as const) {
        expect(svg).toContain(`fill="${COUNT_KEY_COLORS.disconnected.background}"`);
        expect(svg).toContain(`>${title}</text>`);
        expect(svg).toContain(`>${label}</text>`);
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

    expect(workingSvg).toContain(">Working</text>");
    expect(workingSvg).toContain(`>${expected.working}</text>`);
    expect(needsSvg).toContain('fill="#d92d20"');
    expect(needsSvg).toContain(">Needs You</text>");
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

    expect(svgs.some((svg) => svg.includes(">Working</text>") && svg.includes(`>${workingManySummary.working}</text>`))).toBe(true);
    expect(svgs.some((svg) => svg.includes(">Needs You</text>") && svg.includes('fill="#d92d20"'))).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">Working</text>") &&
          svg.includes(">연결 안 됨</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">Needs You</text>") &&
          svg.includes(">승인 대기</text>") &&
          !svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">Working</text>") &&
          svg.includes(">연결 끊김</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">Needs You</text>") &&
          svg.includes(">거절됨</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
    expect(
      svgs.some(
        (svg) =>
          svg.includes(">Working</text>") &&
          svg.includes(">요청 만료</text>") &&
          svg.includes(">설정에서 연결 요청</text>"),
      ),
    ).toBe(true);
  });
});
