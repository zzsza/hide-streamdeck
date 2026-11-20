import type { HideSnapshot } from "../source/types.js";
import { summarize } from "../state/classify.js";
import { connectionHint, connectionLabel, renderConnectionText } from "./connection-label.js";
import { createKeySvg } from "./key-svg.js";
import { KEY_FONT } from "./key-text.js";
import { KEY_COLORS } from "./palette.js";

export type CountKeyKind = "working" | "needs_you";

export function renderCountKey(kind: CountKeyKind, snapshot: HideSnapshot): string {
  const working = kind === "working";
  const title = working ? "작업 중" : "내 차례";
  const status = connectionLabel(snapshot.connection);
  let background: string = KEY_COLORS.background;
  let labelColor: string = KEY_COLORS.muted;
  let content: string;

  if (status !== null) {
    content = renderConnectionText(status, connectionHint(snapshot.connection));
  } else {
    const summary = summarize(snapshot);
    const count = working ? summary.working : summary.needsYou.length;
    const value = count > 99 ? "99+" : String(count);
    const fontSize = [72, 64, 54][value.length - 1];
    let numberColor: string = KEY_COLORS.text;
    let dot = "";
    if (count === 0) {
      labelColor = numberColor = KEY_COLORS.disabled;
    } else if (working) {
      dot = `<circle cx="124" cy="28" r="7" fill="${KEY_COLORS.working}" />`;
    } else {
      background = KEY_COLORS.red;
      labelColor = KEY_COLORS.redLabel;
      numberColor = KEY_COLORS.background;
    }
    content = dot + `<text x="72" y="112" text-anchor="middle" font-family="${KEY_FONT}" font-size="${fontSize}" font-weight="700" fill="${numberColor}">${value}</text>`;
  }

  return createKeySvg({
    background,
    cornerRadius: 0,
    body: `<text x="16" y="34" font-family="${KEY_FONT}" font-size="17" font-weight="700" fill="${labelColor}">${title}</text>` + content,
  });
}

export function renderWorkingCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("working", snapshot);
}

export function renderNeedsYouCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("needs_you", snapshot);
}
