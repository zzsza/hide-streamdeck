import type { HideSnapshot } from "../source/types.js";
import { summarize } from "../state/classify.js";
import { connectionHint, connectionLabel, renderConnectionText } from "./connection-label.js";
import { createKeySvg } from "./key-svg.js";
import { KEY_FONT } from "./key-text.js";
import { KEY_COLORS, SUCCESS_COLOR, WARNING_COLOR } from "./palette.js";

export type CountKeyKind = "working" | "needs_you";
export const DASHBOARD_LABELS = {
  "to-read": "읽을 것",
  mission: "미션",
  merge: "머지 대기",
  confirmation: "확인 대기",
  warning: "경고",
  ci: "CI 실패",
} as const;
export type DashboardKey = keyof typeof DASHBOARD_LABELS;

const labels = { working: "작업 중", needs_you: "내 차례", ...DASHBOARD_LABELS };
const dots: Partial<Record<CountKeyKind | DashboardKey, string>> = {
  working: KEY_COLORS.working, "to-read": SUCCESS_COLOR, merge: KEY_COLORS.working,
  warning: WARNING_COLOR, ci: KEY_COLORS.red,
};

export function renderCountKey(kind: CountKeyKind | DashboardKey, snapshot: HideSnapshot): string {
  let title: string = labels[kind];
  let status = connectionLabel(snapshot.connection);
  let value = "";
  let count = 0;
  if (status === null) {
    if (kind === "working" || kind === "needs_you" || kind === "to-read") {
      const summary = summarize(snapshot);
      count = kind === "working" ? summary.working : kind === "to-read" ? summary.toRead : summary.needsYou.length;
    } else {
      const data = snapshot.missions;
      if (kind === "mission" && data?.count !== undefined && data.count > 1) {
        count = data.count;
        title = "진행 중 미션";
      } else if (data?.kind === "ready") {
        count = kind === "mission" ? data.count : data[kind];
        if (kind === "mission" && count === 1) value = `${data.done}/${data.total}`;
      } else {
        status = !data ? "확인 중" : data.kind === "denied" ? "권한 없음" : "오류";
      }
    }
  }

  const alert = count > 0 && (kind === "needs_you" || kind === "confirmation");
  const dim = status === null && count === 0;
  const labelColor = alert ? KEY_COLORS.redLabel : dim ? KEY_COLORS.disabled : KEY_COLORS.muted;
  const numberColor = alert ? KEY_COLORS.background : dim ? KEY_COLORS.disabled : KEY_COLORS.text;
  const dot = count > 0 && dots[kind] ? `<circle cx="124" cy="28" r="7" fill="${dots[kind]}" />` : "";
  value ||= count > 99 ? "99+" : String(count);
  const fontSize = value.length === 1 ? 72 : value.length === 2 ? 64 : Math.min(54, Math.floor(200 / value.length));
  const content = status === null
    ? `<text x="72" y="112" text-anchor="middle" font-family="${KEY_FONT}" font-size="${fontSize}" font-weight="700" fill="${numberColor}">${value}</text>`
    : renderConnectionText(status, connectionHint(snapshot.connection));

  return createKeySvg({
    background: alert ? KEY_COLORS.red : KEY_COLORS.background,
    cornerRadius: 0,
    body: `<text x="16" y="34" font-family="${KEY_FONT}" font-size="17" font-weight="700" fill="${labelColor}">${title}</text>` + dot + content,
  });
}

export function renderWorkingCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("working", snapshot);
}

export function renderNeedsYouCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("needs_you", snapshot);
}
