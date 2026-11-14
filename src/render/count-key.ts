import type { HideSnapshot } from "../source/types.js";
import { summarize } from "../state/classify.js";
import { connectionHint, connectionLabel } from "./connection-label.js";
import { createKeySvg, escapeXml } from "./key-svg.js";

export type CountKeyKind = "working" | "needs_you";

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, sans-serif";

export const COUNT_KEY_COLORS = {
  disconnected: {
    background: "#2b303a",
    border: "#475569",
    label: "#94a3b8",
    text: "#cbd5e1",
    hint: "#94a3b8",
  },
  workingZero: {
    background: "#2b303a",
    border: "#3f4654",
    label: "#94a3b8",
    number: "#717a8a",
  },
  workingActive: {
    background: "#1e293b",
    border: "#38bdf8",
    label: "#cbd5e1",
    number: "#ffffff",
  },
  needsYouZero: {
    background: "#181a20",
    border: "#2e3440",
    label: "#64748b",
    number: "#64748b",
  },
  needsYouActive: {
    background: "#d92d20",
    border: "#f04438",
    label: "#fee4e2",
    number: "#ffffff",
  },
} as const;

interface CountKeyTheme {
  background: string;
  border: string;
  labelColor: string;
  valueColor: string;
}

function formatCountText(count: number): string {
  const safeCount = Math.max(0, count);
  return safeCount > 99 ? "99+" : String(safeCount);
}

function getCountLayout(text: string): { fontSize: number; y: number } {
  if (text.length >= 3) {
    return { fontSize: 48, y: 103 };
  }
  if (text.length === 2) {
    return { fontSize: 56, y: 106 };
  }
  return { fontSize: 62, y: 108 };
}

function getStatusLayout(text: string, hasHint: boolean): { fontSize: number; y: number } {
  const charCount = Array.from(text).length;
  const fontSize = charCount > 8 ? 14 : 18;
  if (hasHint) {
    return { fontSize, y: 78 };
  }
  return { fontSize, y: charCount > 8 ? 92 : 93 };
}

function getHintFontSize(text: string): number {
  return Array.from(text).length > 10 ? 12 : 14;
}

function getConnectedTheme(kind: CountKeyKind, count: number): CountKeyTheme {
  if (kind === "working") {
    const palette = count > 0 ? COUNT_KEY_COLORS.workingActive : COUNT_KEY_COLORS.workingZero;
    return {
      background: palette.background,
      border: palette.border,
      labelColor: palette.label,
      valueColor: palette.number,
    };
  }

  const palette = count > 0 ? COUNT_KEY_COLORS.needsYouActive : COUNT_KEY_COLORS.needsYouZero;
  return {
    background: palette.background,
    border: palette.border,
    labelColor: palette.label,
    valueColor: palette.number,
  };
}

/**
 * Renders the 144x144 SVG key for Working or Needs You agent counts.
 */
export function renderCountKey(kind: CountKeyKind, snapshot: HideSnapshot): string {
  const title = kind === "working" ? "Working" : "Needs You";
  const statusText = connectionLabel(snapshot.connection);

  if (statusText !== null) {
    const palette = COUNT_KEY_COLORS.disconnected;
    const hintText = connectionHint(snapshot.connection);
    const layout = getStatusLayout(statusText, hintText !== null);
    const body = [
      `<text x="72" y="34" text-anchor="middle" fill="${palette.label}" font-family="${FONT_FAMILY}" font-size="16" font-weight="600">${escapeXml(title)}</text>`,
      `<text x="72" y="${layout.y}" text-anchor="middle" fill="${palette.text}" font-family="${FONT_FAMILY}" font-size="${layout.fontSize}" font-weight="600">${escapeXml(statusText)}</text>`,
      hintText !== null
        ? `<text x="72" y="110" text-anchor="middle" fill="${palette.hint}" font-family="${FONT_FAMILY}" font-size="${getHintFontSize(hintText)}" font-weight="500">${escapeXml(hintText)}</text>`
        : "",
    ].join("");

    return createKeySvg({
      background: palette.background,
      borderColor: palette.border,
      borderWidth: 2,
      body,
    });
  }

  const summary = summarize(snapshot);
  const count = kind === "working" ? summary.working : summary.needsYou.length;
  const theme = getConnectedTheme(kind, count);
  const countText = formatCountText(count);
  const layout = getCountLayout(countText);

  const body = [
    `<text x="72" y="34" text-anchor="middle" fill="${theme.labelColor}" font-family="${FONT_FAMILY}" font-size="16" font-weight="600">${escapeXml(title)}</text>`,
    `<text x="72" y="${layout.y}" text-anchor="middle" fill="${theme.valueColor}" font-family="${FONT_FAMILY}" font-size="${layout.fontSize}" font-weight="700">${escapeXml(countText)}</text>`,
  ].join("");

  return createKeySvg({
    background: theme.background,
    borderColor: theme.border,
    borderWidth: 2,
    body,
  });
}

export function renderWorkingCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("working", snapshot);
}

export function renderNeedsYouCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("needs_you", snapshot);
}
