export type ConnectionState =
  | { kind: "connected" }
  | { kind: "not_connected" }
  | { kind: "pending" }
  | { kind: "refused" }
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "hide_unavailable" }
  | { kind: "hide_outdated" }
  | { kind: "hide_missing" }
  | { kind: "error"; message: string };

export type ConnectionKind = ConnectionState["kind"];

export interface AgentRow {
  id: string;
  name: string;
  kind: string;
  state: string;
  line: string | null;
  pane: string;
}

export interface HideSnapshot {
  connection: ConnectionState;
  agents: AgentRow[];
  readAt: number;
}

export interface HideSource {
  read(): Promise<HideSnapshot>;
  dispose?(): void;
}

export type SourceMode = "hide" | "fake";

export type FakeScenarioId =
  | "empty"
  | "working-many"
  | "needs-you-one"
  | "needs-you-many"
  | "not-connected"
  | "pending"
  | "hide-unavailable"
  | "cycling";

export type GlobalSettings = {
  source?: SourceMode;
  hidePath?: string;
  fakeScenario?: string;
};

export interface NormalizedGlobalSettings {
  source: SourceMode;
  hidePath: string;
  fakeScenario: FakeScenarioId;
}

export const DEFAULT_SOURCE_MODE: SourceMode = "hide";
export const DEFAULT_HIDE_PATH = "/Applications/hide.app/Contents/Resources/hide";
export const DEFAULT_FAKE_SCENARIO: FakeScenarioId = "needs-you-many";

export const FAKE_SCENARIO_IDS: readonly FakeScenarioId[] = [
  "empty",
  "working-many",
  "needs-you-one",
  "needs-you-many",
  "not-connected",
  "pending",
  "hide-unavailable",
  "cycling",
] as const;

export function isFakeScenarioId(value: unknown): value is FakeScenarioId {
  return typeof value === "string" && (FAKE_SCENARIO_IDS as readonly string[]).includes(value);
}

export function normalizeGlobalSettings(raw?: GlobalSettings | null): NormalizedGlobalSettings {
  const source: SourceMode = raw?.source === "fake" ? "fake" : DEFAULT_SOURCE_MODE;
  const trimmedPath = typeof raw?.hidePath === "string" ? raw.hidePath.trim() : "";
  const hidePath = trimmedPath.length > 0 ? trimmedPath : DEFAULT_HIDE_PATH;
  const fakeScenario: FakeScenarioId = isFakeScenarioId(raw?.fakeScenario)
    ? raw.fakeScenario
    : DEFAULT_FAKE_SCENARIO;

  return {
    source,
    hidePath,
    fakeScenario,
  };
}
