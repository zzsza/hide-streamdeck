import type { HideSnapshot } from "../source/types.js";
import { renderPlaceholderCardSvg } from "./key-svg.js";

export interface AgentKeyRenderOptions {
  slot?: number;
}

/**
 * Placeholder renderer for the Needs You single-agent slot key.
 * The agent-key node replaces this implementation with agent name, line, and slot handling.
 */
export function renderAgentKey(
  snapshot: HideSnapshot,
  options: AgentKeyRenderOptions = {},
): string {
  const slotLabel = options.slot !== undefined ? `Agent #${options.slot}` : "Agent Slot";
  return renderPlaceholderCardSvg(slotLabel, snapshot.connection.kind);
}
