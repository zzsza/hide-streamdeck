import type { ConnectionState } from "../source/types.js";
import { escapeXml } from "./key-svg.js";
import { KEY_FONT, wrapTextLines } from "./key-text.js";
import { KEY_COLORS } from "./palette.js";

export function connectionLabel(state: ConnectionState): string | null {
  switch (state.kind) {
    case "connected":
      return null;
    case "not_connected":
      return "연결 안 됨";
    case "pending":
      return "승인 대기";
    case "refused":
      return "거절됨";
    case "revoked":
      return "연결 끊김";
    case "expired":
      return "요청 만료";
    case "hide_unavailable":
      return "Hide 꺼짐";
    case "hide_outdated":
      return "Hide 업데이트 필요";
    case "hide_missing":
      return "hide 없음";
    case "error":
      return "오류";
  }
}

export function connectionHint(state: ConnectionState): string | null {
  switch (state.kind) {
    case "not_connected":
    case "refused":
    case "revoked":
    case "expired":
      return "설정에서 연결 요청";
    default:
      return null;
  }
}

export function renderConnectionText(label: string, hint: string | null): string {
  const fontSize = label.length > 8 ? 20 : 24;
  const lines = wrapTextLines(label, { maxWidth: 132, maxLines: 2, fontSize, bold: true });
  const startY = (hint ? 80 : 88) - (lines.length - 1) * 13;
  const status = lines.map((line, index) =>
    `<text x="72" y="${startY + index * 26}" font-size="${fontSize}" fill="${KEY_COLORS.text}" font-weight="700">${escapeXml(line)}</text>`,
  ).join("");
  const hintNode = hint
    ? `<text x="72" y="113" font-size="14" fill="${KEY_COLORS.muted}">${escapeXml(hint)}</text>`
    : "";
  return `<g font-family="${KEY_FONT}" text-anchor="middle">${status}${hintNode}</g>`;
}
