import type { AgentRow, HideSnapshot } from "../source/types.js";

export type RowMark = "needs_you" | "working" | "to_read" | "other";

export interface StatusSummary {
  working: number;
  needsYou: AgentRow[];
  toRead: number;
}

export function classify(state: string): RowMark {
  switch (state) {
    case "turn":
    case "look":
      return "needs_you";
    case "going":
    case "waiting":
      return "working";
    case "done":
    case "unread":
      return "to_read";
    case "quiet":
    case "unknown":
    case "asleep":
    default:
      return "other";
  }
}

export function summarize(snapshot: HideSnapshot): StatusSummary {
  let working = 0;
  let toRead = 0;
  const needsYou: AgentRow[] = [];
  const seenIds = new Set<string>();

  for (const agent of snapshot.agents) {
    if (seenIds.has(agent.id)) {
      continue;
    }
    seenIds.add(agent.id);

    const mark = classify(agent.state);
    if (mark === "needs_you") {
      needsYou.push(agent);
    } else if (mark === "working") {
      working += 1;
    } else if (mark === "to_read") {
      toRead += 1;
    }
  }

  return {
    working,
    needsYou,
    toRead,
  };
}
