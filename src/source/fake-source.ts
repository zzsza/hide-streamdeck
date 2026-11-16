import {
  DEFAULT_FAKE_SCENARIO,
  isFakeScenarioId,
  type AgentRow,
  type FakeScenarioId,
  type HideSnapshot,
  type HideSource,
} from "./types.js";

export interface FakeScenarioMeta {
  id: FakeScenarioId;
  label: string;
  description: string;
}

export const FAKE_SCENARIOS: readonly FakeScenarioMeta[] = [
  {
    id: "empty",
    label: "Empty (0 agents)",
    description: "Connected to Hide with zero active agents.",
  },
  {
    id: "working-many",
    label: "Multiple Working",
    description: "Connected with several agents actively working and none waiting on you.",
  },
  {
    id: "needs-you-one",
    label: "Needs You (1 agent)",
    description: "Connected with one agent waiting on you alongside working agents.",
  },
  {
    id: "needs-you-many",
    label: "Needs You (multiple, long text)",
    description: "Connected with multiple agents waiting on you, including long names and lines.",
  },
  {
    id: "not-connected",
    label: "Not Connected",
    description: "Plugin has not requested Hide access yet.",
  },
  {
    id: "pending",
    label: "Pending Approval",
    description: "Waiting for operator approval in Hide.",
  },
  {
    id: "refused",
    label: "Refused",
    description: "Operator refused the access request.",
  },
  {
    id: "revoked",
    label: "Revoked",
    description: "Previously granted access was revoked.",
  },
  {
    id: "expired",
    label: "Expired",
    description: "Access grant expired.",
  },
  {
    id: "hide-unavailable",
    label: "Hide Unavailable",
    description: "Hide application is not running.",
  },
  {
    id: "hide-outdated",
    label: "Hide Outdated",
    description: "Installed hide binary lacks the access command.",
  },
  {
    id: "hide-missing",
    label: "Hide Missing",
    description: "Configured hide executable path does not exist.",
  },
  {
    id: "error",
    label: "Error",
    description: "Unexpected CLI failure while reading status.",
  },
  {
    id: "cycling",
    label: "Cycling Over Time",
    description: "Transitions across pending, working, needs-you, and empty states over time.",
  },
] as const;

const WORKING_MANY_AGENTS: readonly AgentRow[] = [
  {
    id: "fake-agent-atlas",
    name: "atlas",
    kind: "claude",
    state: "going",
    line: "Drafting database migration tests for sample inventory table",
    pane: "w1:p1",
  },
  {
    id: "fake-agent-vega",
    name: "vega",
    kind: "codex",
    state: "waiting",
    line: "Running unit test suite in sandbox",
    pane: "w1:p2",
  },
  {
    id: "fake-agent-orion",
    name: "orion",
    kind: "claude",
    state: "going",
    line: "Refactoring fictional billing adapter types",
    pane: "w2:p1",
  },
  {
    id: "fake-agent-lyra",
    name: "lyra",
    kind: "gemini",
    state: "done",
    line: "Completed changelog summary",
    pane: "w2:p2",
  },
];

const NEEDS_YOU_ONE_AGENTS: readonly AgentRow[] = [
  {
    id: "fake-agent-atlas",
    name: "atlas",
    kind: "claude",
    state: "going",
    line: "Compiling widget bundle",
    pane: "w1:p1",
  },
  {
    id: "fake-agent-nova",
    name: "nova",
    kind: "claude",
    state: "turn",
    line: "Choose fixture storage format: JSON or SQLite?",
    pane: "w1:p2",
  },
];

const NEEDS_YOU_MANY_AGENTS: readonly AgentRow[] = [
  {
    id: "fake-agent-nova",
    name: "nova",
    kind: "claude",
    state: "turn",
    line: "Approve schema update for demo catalog?",
    pane: "w1:p1",
  },
  {
    id: "fake-agent-hyperion",
    name: "hyperion-telemetry-pipeline-coordinator",
    kind: "codex",
    state: "look",
    line: "Waiting for review on multi-region synthetic routing table and fallback retry policy diff",
    pane: "w1:p2",
  },
  {
    id: "fake-agent-atlas",
    name: "atlas",
    kind: "claude",
    state: "going",
    line: "Checking type definitions",
    pane: "w2:p1",
  },
  {
    id: "fake-agent-zephyr",
    name: "zephyr",
    kind: "gemini",
    state: "turn",
    line: null,
    pane: "w2:p2",
  },
  {
    id: "fake-agent-callisto",
    name: "callisto-frontend-storybook-verifier",
    kind: "claude",
    state: "look",
    line: "Opened preview comparison page for sample dashboard cards",
    pane: "w3:p1",
  },
  {
    id: "fake-agent-lyra",
    name: "lyra",
    kind: "gemini",
    state: "unread",
    line: "All 18 synthetic checks passed",
    pane: "w3:p2",
  },
];

const CYCLING_SEQUENCE: readonly Exclude<FakeScenarioId, "cycling">[] = [
  "pending",
  "working-many",
  "needs-you-one",
  "needs-you-many",
  "empty",
];

function cloneAgents(rows: readonly AgentRow[]): AgentRow[] {
  return rows.map((row) => ({ ...row }));
}

export function buildStaticScenarioSnapshot(
  scenario: Exclude<FakeScenarioId, "cycling">,
  readAt: number,
): HideSnapshot {
  switch (scenario) {
    case "empty":
      return {
        connection: { kind: "connected" },
        agents: [],
        readAt,
      };
    case "working-many":
      return {
        connection: { kind: "connected" },
        agents: cloneAgents(WORKING_MANY_AGENTS),
        readAt,
      };
    case "needs-you-one":
      return {
        connection: { kind: "connected" },
        agents: cloneAgents(NEEDS_YOU_ONE_AGENTS),
        readAt,
      };
    case "needs-you-many":
      return {
        connection: { kind: "connected" },
        agents: cloneAgents(NEEDS_YOU_MANY_AGENTS),
        readAt,
      };
    case "not-connected":
      return {
        connection: { kind: "not_connected" },
        agents: [],
        readAt,
      };
    case "pending":
      return {
        connection: { kind: "pending" },
        agents: [],
        readAt,
      };
    case "refused":
      return {
        connection: { kind: "refused" },
        agents: [],
        readAt,
      };
    case "revoked":
      return {
        connection: { kind: "revoked" },
        agents: [],
        readAt,
      };
    case "expired":
      return {
        connection: { kind: "expired" },
        agents: [],
        readAt,
      };
    case "hide-unavailable":
      return {
        connection: { kind: "hide_unavailable" },
        agents: [],
        readAt,
      };
    case "hide-outdated":
      return {
        connection: { kind: "hide_outdated" },
        agents: [],
        readAt,
      };
    case "hide-missing":
      return {
        connection: { kind: "hide_missing" },
        agents: [],
        readAt,
      };
    case "error":
      return {
        connection: { kind: "error", message: "Synthetic read failure" },
        agents: [],
        readAt,
      };
  }
}

export interface FakeHideSourceOptions {
  scenario?: string;
  now?: () => number;
  cycleStepMs?: number;
}

export const DEFAULT_CYCLE_STEP_MS = 3_000;

const REQUESTABLE_SCENARIOS: ReadonlySet<FakeScenarioId> = new Set<FakeScenarioId>([
  "not-connected",
  "refused",
  "revoked",
  "expired",
]);

export class FakeHideSource implements HideSource {
  readonly scenario: FakeScenarioId;
  private readonly now: () => number;
  private readonly cycleStepMs: number;
  private readonly startedAt: number;
  private requestedPending = false;

  constructor(options: FakeHideSourceOptions = {}) {
    this.scenario = isFakeScenarioId(options.scenario) ? options.scenario : DEFAULT_FAKE_SCENARIO;
    this.now = options.now ?? Date.now;
    this.cycleStepMs = Math.max(100, options.cycleStepMs ?? DEFAULT_CYCLE_STEP_MS);
    this.startedAt = this.now();
  }

  requestAccess(): void {
    if (REQUESTABLE_SCENARIOS.has(this.scenario)) {
      this.requestedPending = true;
    }
  }

  async read(): Promise<HideSnapshot> {
    const readAt = this.now();
    if (this.requestedPending && REQUESTABLE_SCENARIOS.has(this.scenario)) {
      return buildStaticScenarioSnapshot("pending", readAt);
    }

    if (this.scenario === "cycling") {
      const elapsed = Math.max(0, readAt - this.startedAt);
      const stepIndex = Math.floor(elapsed / this.cycleStepMs) % CYCLING_SEQUENCE.length;
      const stage = CYCLING_SEQUENCE[stepIndex] ?? "empty";
      return buildStaticScenarioSnapshot(stage, readAt);
    }

    return buildStaticScenarioSnapshot(this.scenario, readAt);
  }
}
