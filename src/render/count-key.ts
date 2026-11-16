import type { HideSnapshot } from "../source/types.js";
import { renderPlaceholderCardSvg } from "./key-svg.js";

export type CountKeyKind = "working" | "needs_you";

/**
 * Placeholder renderer for Working and Needs You count keys.
 * The count-keys node replaces this implementation with actual count numbers and colors.
 */
export function renderCountKey(kind: CountKeyKind, snapshot: HideSnapshot): string {
  const title = kind === "working" ? "Working" : "Needs You";
  return renderPlaceholderCardSvg(title, snapshot.connection.kind);
}

export function renderWorkingCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("working", snapshot);
}

export function renderNeedsYouCountKey(snapshot: HideSnapshot): string {
  return renderCountKey("needs_you", snapshot);
}
