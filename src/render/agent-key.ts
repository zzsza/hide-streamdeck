import type { AgentRow, HideSnapshot } from "../source/types.js";
import { summarize } from "../state/classify.js";
import { connectionHint, connectionLabel, renderConnectionText } from "./connection-label.js";
import { createKeySvg, escapeXml } from "./key-svg.js";
import { estimateTextWidth, KEY_FONT, wrapTextLines } from "./key-text.js";
import { KEY_COLORS } from "./palette.js";

export { estimateCharWidth, estimateTextWidth, splitGraphemes, wrapTextLines, type WrapTextOptions } from "./key-text.js";

export const MIN_AGENT_SLOT = 1;
export const MAX_AGENT_SLOT = 20;

export interface AgentKeyRenderOptions {
  slot?: number;
}

function isValidAgentSlot(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_AGENT_SLOT && value <= MAX_AGENT_SLOT;
}

/**
 * Normalizes a 1-based Needs You slot index (1..20). Missing or out-of-range values fall back to 1.
 */
export function normalizeAgentSlot(slot: unknown): number {
  if (typeof slot === "number") {
    return isValidAgentSlot(slot) ? slot : MIN_AGENT_SLOT;
  }
  if (typeof slot === "string") {
    const trimmed = slot.trim();
    if (trimmed.length === 0) {
      return MIN_AGENT_SLOT;
    }
    const parsed = Number(trimmed);
    return isValidAgentSlot(parsed) ? parsed : MIN_AGENT_SLOT;
  }
  return MIN_AGENT_SLOT;
}

/**
 * Selects the 1-based slot-th agent from `summarize(snapshot).needsYou`.
 */
export function selectNeedsYouAgent(snapshot: HideSnapshot, slot?: unknown): AgentRow | null {
  const normalizedSlot = normalizeAgentSlot(slot);
  const { needsYou } = summarize(snapshot);
  return needsYou[normalizedSlot - 1] ?? null;
}

/**
 * Maps an agent state without a `line` to a Korean status label.
 */
export function formatAgentStateLabel(state: string): string {
  switch (state) {
    case "turn":
      return "차례";
    case "look":
      return "확인 요청";
    default:
      return state;
  }
}

function renderAgentName(name: string): string {
  const nameLines = wrapTextLines(name, { maxWidth: 116, maxLines: 2, fontSize: 26, bold: true });
  const nameY = nameLines.length > 1 ? 74 : 88;
  // Bound the rendered advance even when a fallback font has wider glyphs.
  return nameLines.map((line, index) =>
    `<text x="16" y="${nameY + index * 32}" fill="${KEY_COLORS.text}" font-size="26" font-weight="700" textLength="${estimateTextWidth(line, 26, true)}" lengthAdjust="spacingAndGlyphs">${escapeXml(line)}</text>`,
  ).join("");
}

function renderOccupiedAgentKey(agent: AgentRow, slot: number): string {
  const [kind = ""] = wrapTextLines(agent.kind, { maxWidth: 72, maxLines: 1, fontSize: 16 });

  return createKeySvg({
    background: KEY_COLORS.card,
    cornerRadius: 0,
    body: [
      `<rect width="6" height="144" fill="${KEY_COLORS.red}" />`,
      `<g font-family="${KEY_FONT}">`,
      `<text x="16" y="34" fill="${KEY_COLORS.red}" font-size="17" font-weight="800">#${slot}</text>`,
      `<text x="132" y="34" text-anchor="end" fill="${KEY_COLORS.muted}" font-size="16" textLength="${estimateTextWidth(kind, 16)}" lengthAdjust="spacingAndGlyphs">${escapeXml(kind)}</text>`,
      renderAgentName(agent.name.trim() || agent.id),
      "</g>",
    ].join(""),
  });
}

export function selectWorkingAgent(snapshot: HideSnapshot, slot?: unknown): AgentRow | null {
  if (snapshot.connection.kind !== "connected") return null;
  const running = snapshot.agents.filter(agent => agent.state === "going");
  const waiting = snapshot.agents.filter(agent => agent.state === "waiting");
  return [...running, ...waiting][normalizeAgentSlot(slot) - 1] ?? null;
}

export function renderWorkingAgentKey(snapshot: HideSnapshot, slot?: unknown): string {
  const status = connectionLabel(snapshot.connection);
  const agent = selectWorkingAgent(snapshot, slot);
  if (!agent && (!status || normalizeAgentSlot(slot) !== 1)) {
    return createKeySvg({ background: KEY_COLORS.background, cornerRadius: 0, body: "" });
  }
  const label = agent?.state === "waiting" && !status ? "대기 중" : "작업 중";
  const name = agent?.label?.trim() || agent?.name.trim() || agent?.id || "";
  const content = status
    ? renderConnectionText(status, connectionHint(snapshot.connection))
    : renderAgentName(name);
  return createKeySvg({ background: KEY_COLORS.background, cornerRadius: 0, body:
    `<g font-family="${KEY_FONT}"><text x="16" y="35" fill="${KEY_COLORS.working}" font-size="24" font-weight="700">${label}</text>${content}</g>`,
  });
}

/**
 * Renders the 144x144 Stream Deck SVG for a Needs You slot key.
 */
export function renderAgentKey(
  snapshot: HideSnapshot,
  options: AgentKeyRenderOptions = {},
): string {
  const slot = normalizeAgentSlot(options.slot);

  const disconnectedLabel = connectionLabel(snapshot.connection);
  if (disconnectedLabel !== null) {
    return createKeySvg({
      background: KEY_COLORS.background,
      cornerRadius: 0,
      body: `<text x="16" y="34" font-family="${KEY_FONT}" font-size="17" font-weight="700" fill="${KEY_COLORS.disabled}">#${slot}</text>`
        + renderConnectionText(disconnectedLabel, connectionHint(snapshot.connection)),
    });
  }

  const agent = selectNeedsYouAgent(snapshot, slot);
  if (agent === null) {
    return createKeySvg({
      background: KEY_COLORS.background,
      cornerRadius: 0,
      body: `<text x="72" y="84" text-anchor="middle" font-family="${KEY_FONT}" font-size="24" font-weight="700" fill="${KEY_COLORS.disabled}">#${slot}</text>`,
    });
  }

  return renderOccupiedAgentKey(agent, slot);
}
