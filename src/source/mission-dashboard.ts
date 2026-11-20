import { isRecord, parseCliJsonEnvelope, type RunHideCommand } from "./hide-access.js";

export interface MissionTotals {
  count: number;
  done: number;
  total: number;
  merge: number;
  confirmation: number;
  warning: number;
  ci: number;
}

export type MissionDashboard =
  | ({ kind: "ready" } & MissionTotals)
  | { kind: "denied" | "error"; count?: number };

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Invalid mission rows");
  return value;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function tallyMission(totals: MissionTotals, mission: Record<string, unknown>): void {
  const held = new Set(rows(field(mission.safety_net, "nodes") ?? []).map(node => node.key));
  const questionKey = field(mission.question, "key");
  const hasQuestion = Boolean(mission.decision || mission.question);
  if (hasQuestion && !mission.answer) totals.confirmation++;

  for (const node of rows(mission.nodes)) {
    if (typeof node.key !== "string" || typeof node.status !== "string") {
      throw new Error("Invalid mission node");
    }
    totals.total++;
    if (node.status === "done") totals.done++;
    if (field(node.merge, "by") === "operator" && field(node.merge, "state") === "due") totals.merge++;

    if (field(node.gate, "state") === "open") {
      const ask = field(node.gate, "ask");
      const usesMissionQuestion = hasQuestion && typeof ask === "number" && ask === questionKey;
      if (!usesMissionQuestion) totals.confirmation++;
    }

    const work = field(node.work, "state");
    const reason = field(node.attention, "reason");
    const stalled = reason === "not_started" || reason === "wait_stood" || reason === "warning_stood";
    if (rows(node.warnings ?? []).length || held.has(node.key) || work === "stopped" || work === "no_worker" || stalled) {
      totals.warning++;
    }

    // PR state also reflects reviews. The ci criterion is the result shown by mission show.
    const openPr = typeof node.pr === "number" && node.pr_state !== "merged" && node.pr_state !== "closed";
    if (openPr && rows(node.criteria ?? []).some(line => line.kind === "ci" && line.state === "fail")) {
      totals.ci++;
    }
  }
}

export async function readMissionDashboard(run: RunHideCommand): Promise<MissionDashboard> {
  let count: number | undefined;
  let denied = false;
  async function read(args: string[]) {
    const envelope = parseCliJsonEnvelope(await run(args), "result");
    if (envelope.kind === "ok" && isRecord(envelope.value)) return envelope.value;
    denied = envelope.kind === "refusal" && envelope.code.startsWith("access_");
    throw new Error("Mission command unavailable");
  }
  try {
    const list = await read(["mission", "list"]);
    const ids = new Set<string>();
    for (const item of rows(list.items)) {
      if (typeof item.id !== "string" || !item.id || typeof item.status !== "string" || typeof item.shelved !== "boolean") {
        throw new Error("Invalid mission list item");
      }
      if (!item.shelved && ["planning", "running", "merge_wait"].includes(item.status)) ids.add(item.id);
    }
    count = ids.size;
    const totals: MissionTotals = { count, done: 0, total: 0, merge: 0, confirmation: 0, warning: 0, ci: 0 };
    for (const id of ids) {
      const detail = await read(["mission", "show", "--mission", id, "--json"]);
      if (!isRecord(detail.mission)) throw new Error("Invalid mission detail");
      tallyMission(totals, detail.mission);
    }
    return { kind: "ready", ...totals };
  } catch {
    return { kind: denied ? "denied" : "error", count };
  }
}
