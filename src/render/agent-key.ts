import type { AgentRow, HideSnapshot } from "../source/types.js";
import { summarize } from "../state/classify.js";
import { connectionLabel } from "./connection-label.js";
import { createKeySvg, escapeXml } from "./key-svg.js";

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, sans-serif";
const CONTENT_X = 12;
const CONTENT_MAX_WIDTH = 120;
const NAME_FONT_SIZE = 16;
const NAME_LINE_HEIGHT = 20;
const LINE_FONT_SIZE = 13;
const LINE_LINE_HEIGHT = 18;
const DEFAULT_ELLIPSIS = "…";
export const MIN_AGENT_SLOT = 1;
export const MAX_AGENT_SLOT = 20;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface AgentKeyRenderOptions {
  slot?: number;
}

export interface WrapTextOptions {
  maxWidth: number;
  maxLines: number;
  fontSize: number;
  bold?: boolean;
  ellipsis?: string;
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

function isWideGlyph(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

/**
 * Splits a string into user-perceived grapheme clusters using Intl.Segmenter.
 */
export function splitGraphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
}

function isEmojiGrapheme(grapheme: string, firstCodePoint: number): boolean {
  if (firstCodePoint > 0xffff) {
    return true;
  }
  if (
    grapheme.includes("\u200d") ||
    grapheme.includes("\ufe0f") ||
    grapheme.includes("\u20e3")
  ) {
    return true;
  }
  return firstCodePoint >= 0x1f1e6 && firstCodePoint <= 0x1f1ff;
}

/**
 * Estimates rendered pixel width of a single grapheme cluster in sans-serif SVG text.
 */
export function estimateCharWidth(grapheme: string, fontSize: number, bold = false): number {
  const weightFactor = bold ? 1.04 : 1;
  if (grapheme === " ") {
    return fontSize * 0.3;
  }
  if (grapheme === "…") {
    return fontSize * 0.95 * weightFactor;
  }
  const firstCodePoint = grapheme.codePointAt(0) ?? 0;
  if (isEmojiGrapheme(grapheme, firstCodePoint)) {
    return fontSize * 1.25;
  }
  const baseChar = Array.from(grapheme)[0] ?? grapheme;
  if ("ilI.,:;!'|`".includes(baseChar)) {
    return fontSize * 0.38 * weightFactor;
  }
  if ("fjrt-/()[]{}".includes(baseChar)) {
    return fontSize * 0.46 * weightFactor;
  }
  if (baseChar === "W" || baseChar === "M") {
    return fontSize * 0.95 * weightFactor;
  }
  if (baseChar === "w" || baseChar === "m") {
    return fontSize * 0.82 * weightFactor;
  }
  if (isWideGlyph(firstCodePoint)) {
    return fontSize * 1.0 * weightFactor;
  }
  if (firstCodePoint >= 0x41 && firstCodePoint <= 0x5a) {
    return fontSize * 0.74 * weightFactor;
  }
  if (
    (firstCodePoint >= 0x61 && firstCodePoint <= 0x7a) ||
    (firstCodePoint >= 0x30 && firstCodePoint <= 0x39) ||
    baseChar === "_"
  ) {
    return fontSize * 0.6 * weightFactor;
  }
  return fontSize * 0.7 * weightFactor;
}

/**
 * Estimates rendered pixel width of a string in sans-serif SVG text.
 */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let total = 0;
  for (const grapheme of splitGraphemes(text)) {
    total += estimateCharWidth(grapheme, fontSize, bold);
  }
  return total;
}

function truncateLineToWidth(
  text: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean,
  ellipsis: string,
): string {
  if (estimateTextWidth(text, fontSize, bold) <= maxWidth) {
    return text;
  }
  const ellipsisWidth = estimateTextWidth(ellipsis, fontSize, bold);
  if (ellipsisWidth > maxWidth) {
    return "";
  }

  const graphemes = splitGraphemes(text);
  let width = 0;
  let endIndex = 0;
  for (let i = 0; i < graphemes.length; i += 1) {
    const gWidth = estimateCharWidth(graphemes[i]!, fontSize, bold);
    if (width + gWidth + ellipsisWidth > maxWidth) {
      break;
    }
    width += gWidth;
    endIndex = i + 1;
  }

  const prefix = graphemes.slice(0, endIndex).join("").trimEnd();
  return `${prefix}${ellipsis}`;
}

function splitWordAtWidth(
  word: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean,
): [string, string] {
  const graphemes = splitGraphemes(word);
  let width = 0;
  let fitCount = 0;
  for (let i = 0; i < graphemes.length; i += 1) {
    const gWidth = estimateCharWidth(graphemes[i]!, fontSize, bold);
    if (fitCount > 0 && width + gWidth > maxWidth) {
      break;
    }
    width += gWidth;
    fitCount = i + 1;
  }

  let splitAt = fitCount;
  const minDelimiterPos = Math.ceil(fitCount * 0.4);
  for (let i = fitCount - 1; i >= minDelimiterPos; i -= 1) {
    const g = graphemes[i];
    if (g === "-" || g === "_" || g === "/") {
      if (i + 1 < graphemes.length) {
        splitAt = i + 1;
      }
      break;
    }
  }

  return [graphemes.slice(0, splitAt).join(""), graphemes.slice(splitAt).join("")];
}

/**
 * Wraps text into at most `maxLines` lines that each fit within `maxWidth`,
 * appending an ellipsis on the final line when truncated.
 */
export function wrapTextLines(text: string, options: WrapTextOptions): string[] {
  const { maxWidth, maxLines, fontSize, bold = false, ellipsis = DEFAULT_ELLIPSIS } = options;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || maxLines <= 0 || maxWidth <= 0) {
    return [];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const candidate = currentLine.length > 0 ? `${currentLine} ${word}` : word;

    if (estimateTextWidth(candidate, fontSize, bold) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (lines.length === maxLines - 1) {
      const remaining = currentLine.length > 0 ? `${currentLine} ${words.slice(i).join(" ")}` : words.slice(i).join(" ");
      lines.push(truncateLineToWidth(remaining, maxWidth, fontSize, bold, ellipsis));
      return lines;
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = "";
      i -= 1;
      continue;
    }

    const [head, tail] = splitWordAtWidth(word, maxWidth, fontSize, bold);
    lines.push(head);
    if (tail.length > 0) {
      words[i] = tail;
      i -= 1;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
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

function renderDisconnectedAgentKey(label: string, slot: number): string {
  const labelLines = wrapTextLines(label, {
    maxWidth: 116,
    maxLines: 3,
    fontSize: 13,
    bold: false,
  });

  const startY = 74 - ((labelLines.length - 1) * LINE_LINE_HEIGHT) / 2;
  const textNodes = labelLines
    .map(
      (line, idx) =>
        `<text x="72" y="${startY + idx * LINE_LINE_HEIGHT}" text-anchor="middle" fill="#94a3b8" font-family="${FONT_FAMILY}" font-size="13">${escapeXml(line)}</text>`,
    )
    .join("");

  const slotBadge = `<text x="132" y="133" text-anchor="end" fill="#475569" font-family="${FONT_FAMILY}" font-size="11" font-weight="600">#${slot}</text>`;

  return createKeySvg({
    background: "#12141a",
    borderColor: "#272b36",
    borderWidth: 2,
    body: `${textNodes}${slotBadge}`,
  });
}

function renderEmptyAgentKey(slot: number): string {
  const slotText = `<text x="72" y="77" text-anchor="middle" fill="#475569" font-family="${FONT_FAMILY}" font-size="15" font-weight="500">#${slot}</text>`;
  return createKeySvg({
    background: "#111318",
    borderColor: "#1e2430",
    borderWidth: 2,
    body: slotText,
  });
}

function renderOccupiedAgentKey(agent: AgentRow, slot: number): string {
  const rawName = agent.name.trim().length > 0 ? agent.name : agent.id;
  const nameLines = wrapTextLines(rawName, {
    maxWidth: CONTENT_MAX_WIDTH,
    maxLines: 2,
    fontSize: NAME_FONT_SIZE,
    bold: true,
  });

  const hasLine = agent.line !== null && agent.line.trim().length > 0;
  const lineSource = hasLine ? agent.line! : formatAgentStateLabel(agent.state);
  const lineLines = wrapTextLines(lineSource, {
    maxWidth: CONTENT_MAX_WIDTH,
    maxLines: 3,
    fontSize: LINE_FONT_SIZE,
    bold: false,
  });

  const topStripe = `<rect x="12" y="9" width="120" height="4" rx="2" fill="#ef4444" />`;
  const nameNodes = nameLines
    .map(
      (line, idx) =>
        `<text x="${CONTENT_X}" y="${35 + idx * NAME_LINE_HEIGHT}" fill="#f8fafc" font-family="${FONT_FAMILY}" font-size="${NAME_FONT_SIZE}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join("");

  const lineStartY = nameLines.length > 1 ? 78 : 60;
  const lineColor = hasLine ? "#cbd5e1" : "#fca5a5";
  const lineNodes = lineLines
    .map(
      (line, idx) =>
        `<text x="${CONTENT_X}" y="${lineStartY + idx * LINE_LINE_HEIGHT}" fill="${lineColor}" font-family="${FONT_FAMILY}" font-size="${LINE_FONT_SIZE}" font-weight="400">${escapeXml(line)}</text>`,
    )
    .join("");

  const slotBadge = `<text x="132" y="133" text-anchor="end" fill="#9ca3af" opacity="0.7" font-family="${FONT_FAMILY}" font-size="11" font-weight="600">#${slot}</text>`;

  return createKeySvg({
    background: "#1d1114",
    borderColor: "#ef4444",
    borderWidth: 3,
    body: `${topStripe}${nameNodes}${lineNodes}${slotBadge}`,
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
    return renderDisconnectedAgentKey(disconnectedLabel, slot);
  }

  const agent = selectNeedsYouAgent(snapshot, slot);
  if (agent === null) {
    return renderEmptyAgentKey(slot);
  }

  return renderOccupiedAgentKey(agent, slot);
}
