import type { AgentRow, ConnectionKind, ConnectionState } from "./types.js";

export const HIDE_ACCESS_NAME = "streamdeck";
export const ACCESS_REQUEST_RETRY_INTERVAL_MS = 3_000;
export const MAX_PS_CALLS_PER_READ = 2;

export const ACCESS_STATUS_ARGS = ["access", "status", "--json"] as const;
export const ACCESS_REQUEST_ARGS = [
  "access",
  "request",
  "--name",
  HIDE_ACCESS_NAME,
  "--json",
] as const;
export const PS_ARGS = ["ps", "--json"] as const;

export interface CliOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CliEnvelope =
  | { kind: "ok"; value: unknown }
  | { kind: "refusal"; code: string; message: string | null }
  | { kind: "outdated" }
  | { kind: "invalid"; message: string };

export type PsParseResult =
  | { ok: true; agents: AgentRow[] }
  | { ok: false; message: string };

export type RunHideCommand = (args: readonly string[]) => Promise<CliOutput>;

type AccessPhase = "initial" | "pending" | "connected" | "halted";

interface ReadContext {
  requestRan: boolean;
  psCount: number;
}

const OUTDATED_PATTERN = /\bunknown command\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRefusalErrorMessage(code: string, message?: string | null): string {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (trimmed.length === 0) {
    return code;
  }
  return trimmed.includes(code) ? trimmed : `${code}: ${trimmed}`;
}

/**
 * Maps a `hide` CLI refusal code (from `contracts/hide-cli.json` / `access_cli.rs` / `ps_cli.rs`)
 * to the corresponding `ConnectionState`.
 */
export function mapRefusalCodeToConnectionState(
  code: string,
  message?: string | null,
): ConnectionState {
  switch (code) {
    case "access_pending":
      return { kind: "pending" };
    case "access_refused":
      return { kind: "refused" };
    case "access_revoked":
      return { kind: "revoked" };
    case "access_request_expired":
      return { kind: "expired" };
    case "access_unavailable":
    case "hide_unavailable":
      return { kind: "hide_unavailable" };
    case "access_not_connected":
      return { kind: "not_connected" };
    default:
      return {
        kind: "error",
        message: formatRefusalErrorMessage(code, message),
      };
  }
}

export function isOutdatedHideOutput(output: CliOutput): boolean {
  if (output.exitCode === 0) {
    return false;
  }
  const combined = `${output.stderr}\n${output.stdout}`;
  return OUTDATED_PATTERN.test(combined);
}

function describeInvalidOutput(output: CliOutput, reason: string): string {
  const detail = output.stderr.trim() || output.stdout.trim();
  const codePart = output.exitCode !== null ? ` (exit ${output.exitCode})` : "";
  return detail.length > 0 ? `${reason}${codePart}: ${detail}` : `${reason}${codePart}`;
}

export function parseCliJsonEnvelope(output: CliOutput): CliEnvelope {
  const trimmed = output.stdout.trim();
  if (trimmed.length === 0) {
    if (isOutdatedHideOutput(output)) {
      return { kind: "outdated" };
    }
    return {
      kind: "invalid",
      message: describeInvalidOutput(output, "Empty JSON output from hide"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (isOutdatedHideOutput(output)) {
      return { kind: "outdated" };
    }
    return {
      kind: "invalid",
      message: describeInvalidOutput(output, "Malformed JSON output from hide"),
    };
  }

  if (!isRecord(parsed)) {
    return {
      kind: "invalid",
      message: "Invalid JSON envelope from hide: expected object",
    };
  }

  if (parsed.ok === false) {
    const errorObj = isRecord(parsed.error) ? parsed.error : null;
    const code =
      typeof errorObj?.code === "string" && errorObj.code.length > 0
        ? errorObj.code
        : typeof parsed.reason === "string" && parsed.reason.length > 0
          ? parsed.reason
          : null;
    const message =
      typeof errorObj?.message === "string"
        ? errorObj.message
        : typeof parsed.next_action === "string"
          ? parsed.next_action
          : null;

    if (code !== null) {
      return { kind: "refusal", code, message };
    }
    return {
      kind: "invalid",
      message: "Invalid refusal envelope from hide: missing error.code",
    };
  }

  if (parsed.ok === true) {
    if (output.exitCode !== null && output.exitCode !== 0) {
      return {
        kind: "invalid",
        message: `hide returned ok=true with non-zero exit code ${output.exitCode}`,
      };
    }
    return { kind: "ok", value: parsed.value };
  }

  return {
    kind: "invalid",
    message: "Invalid JSON envelope from hide: missing boolean ok field",
  };
}

/**
 * Parses `hide ps --json`'s `value.panes[].agent` into deduplicated `AgentRow` entries.
 */
export function parsePsValue(value: unknown): PsParseResult {
  if (!isRecord(value) || !Array.isArray(value.panes)) {
    return {
      ok: false,
      message: "Invalid ps JSON: expected value.panes array",
    };
  }

  const agents: AgentRow[] = [];
  const seenIds = new Set<string>();

  for (const entry of value.panes) {
    if (!isRecord(entry)) {
      return {
        ok: false,
        message: "Invalid ps JSON: pane entry must be an object",
      };
    }

    if (entry.agent === null || entry.agent === undefined) {
      continue;
    }

    if (!isRecord(entry.agent)) {
      return {
        ok: false,
        message: "Invalid ps JSON: pane.agent must be an object or null",
      };
    }

    const rawAgent = entry.agent;
    const pane =
      typeof rawAgent.pane === "string" && rawAgent.pane.length > 0
        ? rawAgent.pane
        : typeof entry.pane === "string" && entry.pane.length > 0
          ? entry.pane
          : null;
    if (pane === null) {
      return {
        ok: false,
        message: "Invalid ps JSON: missing pane string",
      };
    }

    if (typeof rawAgent.kind !== "string" || rawAgent.kind.length === 0) {
      return {
        ok: false,
        message: "Invalid ps JSON: missing agent.kind string",
      };
    }

    if (typeof rawAgent.state !== "string" || rawAgent.state.length === 0) {
      return {
        ok: false,
        message: "Invalid ps JSON: missing agent.state string",
      };
    }

    if (
      rawAgent.id !== null &&
      rawAgent.id !== undefined &&
      typeof rawAgent.id !== "string"
    ) {
      return {
        ok: false,
        message: "Invalid ps JSON: agent.id must be a string or null",
      };
    }

    const machine =
      typeof rawAgent.machine === "string" && rawAgent.machine.length > 0
        ? rawAgent.machine
        : typeof entry.machine === "string" && entry.machine.length > 0
          ? entry.machine
          : null;
    const id =
      typeof rawAgent.id === "string" && rawAgent.id.length > 0
        ? rawAgent.id
        : machine !== null
          ? `${machine}:${pane}`
          : pane;

    if (
      rawAgent.name !== null &&
      rawAgent.name !== undefined &&
      typeof rawAgent.name !== "string"
    ) {
      return {
        ok: false,
        message: "Invalid ps JSON: agent.name must be a string or null",
      };
    }
    if (
      rawAgent.label !== null &&
      rawAgent.label !== undefined &&
      typeof rawAgent.label !== "string"
    ) {
      return {
        ok: false,
        message: "Invalid ps JSON: agent.label must be a string or null",
      };
    }
    const name =
      typeof rawAgent.name === "string" && rawAgent.name.length > 0
        ? rawAgent.name
        : typeof rawAgent.label === "string" && rawAgent.label.length > 0
          ? rawAgent.label
          : rawAgent.kind;

    if (
      rawAgent.line !== null &&
      rawAgent.line !== undefined &&
      typeof rawAgent.line !== "string"
    ) {
      return {
        ok: false,
        message: "Invalid ps JSON: agent.line must be a string or null",
      };
    }
    const line = typeof rawAgent.line === "string" ? rawAgent.line : null;

    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    agents.push({
      id,
      name,
      kind: rawAgent.kind,
      state: rawAgent.state,
      line,
      pane,
    });
  }

  return { ok: true, agents };
}

export function mapExecErrorToConnectionState(error: unknown): ConnectionState {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return { kind: "hide_missing" };
  }

  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : typeof error === "string" && error.length > 0
        ? error
        : "Failed to execute hide";

  return { kind: "error", message };
}

export interface AccessPollResult {
  connection: ConnectionState;
  agents: AgentRow[];
}

/**
 * Manages the `hide access status` -> `hide access request` -> `hide ps` connection lifecycle.
 */
export class HideAccessStateMachine {
  private phase: AccessPhase = "initial";
  private lastRequestAt: number | null = null;
  private lastRequestResult: ConnectionState | null = null;
  private hasCompletedPs = false;
  private haltedState: ConnectionState | null = null;
  private lastReportedKind: ConnectionKind | null = null;
  private forceRequestNextRead = false;

  constructor(
    private readonly now: () => number,
    private readonly retryIntervalMs: number = ACCESS_REQUEST_RETRY_INTERVAL_MS,
  ) {}

  /**
   * Marks the next `poll()` to issue an immediate `access request` when currently `revoked` or `refused`.
   */
  retry(): void {
    if (this.lastReportedKind === "revoked" || this.lastReportedKind === "refused") {
      this.forceRequestNextRead = true;
    }
  }

  async poll(run: RunHideCommand): Promise<AccessPollResult> {
    const ctx: ReadContext = { requestRan: false, psCount: 0 };

    if (this.forceRequestNextRead) {
      this.forceRequestNextRead = false;
      this.phase = "initial";
      this.haltedState = null;
      this.lastRequestResult = null;
      return this.finish(await this.runAccessRequest(run, ctx, true));
    }

    if (this.phase === "connected") {
      return this.finish(await this.pollPs(run, ctx));
    }

    if (this.phase === "pending") {
      return this.finish(await this.pollPending(run, ctx));
    }

    return this.finish(
      await this.checkAccessStatus(run, ctx, this.phase !== "halted"),
    );
  }

  private finish(result: AccessPollResult): AccessPollResult {
    this.lastReportedKind = result.connection.kind;
    return result;
  }

  private enterPending(): void {
    this.phase = "pending";
    this.haltedState = null;
    this.lastRequestResult = { kind: "pending" };
    this.lastRequestAt = this.now();
  }

  private enterHalted(state: ConnectionState): void {
    this.phase = "halted";
    this.haltedState = state;
    this.hasCompletedPs = false;
  }

  private shouldRecoverImmediately(code: string): boolean {
    return code === "access_request_expired" || code === "access_key_unreadable";
  }

  private isThrottleActive(): boolean {
    return (
      this.lastRequestAt !== null &&
      this.now() - this.lastRequestAt < this.retryIntervalMs
    );
  }

  private async handleNotConnected(
    run: RunHideCommand,
    ctx: ReadContext,
    requestOnNotConnected: boolean,
  ): Promise<AccessPollResult> {
    if (!requestOnNotConnected) {
      return {
        connection: this.haltedState ?? { kind: "not_connected" },
        agents: [],
      };
    }

    if (this.isThrottleActive()) {
      return {
        connection: this.lastRequestResult ?? { kind: "not_connected" },
        agents: [],
      };
    }

    return this.runAccessRequest(run, ctx, false);
  }

  private async checkAccessStatus(
    run: RunHideCommand,
    ctx: ReadContext,
    requestOnNotConnected: boolean,
  ): Promise<AccessPollResult> {
    const statusOutcome = await this.execEnvelope(run, ACCESS_STATUS_ARGS);
    if ("connection" in statusOutcome) {
      return { connection: statusOutcome.connection, agents: [] };
    }

    const { envelope } = statusOutcome;
    if (envelope.kind === "outdated") {
      this.phase = "initial";
      this.haltedState = null;
      return { connection: { kind: "hide_outdated" }, agents: [] };
    }
    if (envelope.kind === "invalid") {
      return { connection: { kind: "error", message: envelope.message }, agents: [] };
    }
    if (envelope.kind === "refusal") {
      const mapped = mapRefusalCodeToConnectionState(envelope.code, envelope.message);
      if (mapped.kind === "pending") {
        this.enterPending();
        return { connection: mapped, agents: [] };
      }
      if (mapped.kind === "revoked" || mapped.kind === "refused") {
        this.enterHalted(mapped);
        return { connection: mapped, agents: [] };
      }
      if (this.shouldRecoverImmediately(envelope.code) && !ctx.requestRan) {
        this.phase = "initial";
        this.haltedState = null;
        return this.runAccessRequest(run, ctx, true);
      }
      if (mapped.kind === "not_connected") {
        return this.handleNotConnected(run, ctx, requestOnNotConnected);
      }
      return { connection: mapped, agents: [] };
    }

    const stateStr = isRecord(envelope.value) ? envelope.value.state : undefined;
    if (stateStr === "connected") {
      this.phase = "connected";
      this.haltedState = null;
      this.lastRequestResult = null;
      this.hasCompletedPs = false;
      return this.pollPs(run, ctx);
    }
    if (stateStr === "not_connected") {
      return this.handleNotConnected(run, ctx, requestOnNotConnected);
    }
    if (stateStr === "pending") {
      this.enterPending();
      return { connection: { kind: "pending" }, agents: [] };
    }

    return {
      connection: {
        kind: "error",
        message: `Unexpected access status state: ${String(stateStr)}`,
      },
      agents: [],
    };
  }

  private async pollPending(
    run: RunHideCommand,
    ctx: ReadContext,
  ): Promise<AccessPollResult> {
    if (this.isThrottleActive()) {
      return { connection: { kind: "pending" }, agents: [] };
    }

    return this.runAccessRequest(run, ctx, false);
  }

  private async runAccessRequest(
    run: RunHideCommand,
    ctx: ReadContext,
    bypassThrottle: boolean,
  ): Promise<AccessPollResult> {
    if (ctx.requestRan) {
      this.phase = "initial";
      return {
        connection: {
          kind: "error",
          message: "Exceeded access request attempt limit within a single read",
        },
        agents: [],
      };
    }
    if (!bypassThrottle && this.isThrottleActive()) {
      return {
        connection: this.lastRequestResult ?? { kind: "pending" },
        agents: [],
      };
    }

    ctx.requestRan = true;
    this.lastRequestAt = this.now();
    const requestOutcome = await this.execEnvelope(run, ACCESS_REQUEST_ARGS);
    if ("connection" in requestOutcome) {
      this.phase = "initial";
      this.lastRequestResult = requestOutcome.connection;
      return { connection: requestOutcome.connection, agents: [] };
    }

    const { envelope } = requestOutcome;
    if (envelope.kind === "outdated") {
      this.phase = "initial";
      this.lastRequestResult = { kind: "hide_outdated" };
      return { connection: { kind: "hide_outdated" }, agents: [] };
    }
    if (envelope.kind === "invalid") {
      const state: ConnectionState = { kind: "error", message: envelope.message };
      this.phase = "initial";
      this.lastRequestResult = state;
      return { connection: state, agents: [] };
    }
    if (envelope.kind === "refusal") {
      const mapped = mapRefusalCodeToConnectionState(envelope.code, envelope.message);
      this.lastRequestResult = mapped;
      if (mapped.kind === "pending") {
        this.phase = "pending";
        this.haltedState = null;
      } else if (mapped.kind === "revoked" || mapped.kind === "refused") {
        this.enterHalted(mapped);
      } else {
        this.phase = "initial";
        this.haltedState = null;
      }
      return { connection: mapped, agents: [] };
    }

    const stateStr = isRecord(envelope.value) ? envelope.value.state : undefined;
    if (stateStr === "pending") {
      this.phase = "pending";
      this.haltedState = null;
      this.lastRequestResult = { kind: "pending" };
      return { connection: { kind: "pending" }, agents: [] };
    }
    if (stateStr === "connected") {
      this.phase = "connected";
      this.haltedState = null;
      this.lastRequestResult = null;
      this.hasCompletedPs = false;
      return this.pollPs(run, ctx);
    }
    if (stateStr === "not_connected") {
      this.phase = "initial";
      this.lastRequestResult = { kind: "not_connected" };
      return { connection: { kind: "not_connected" }, agents: [] };
    }

    const unexpected: ConnectionState = {
      kind: "error",
      message: `Unexpected access request state: ${String(stateStr)}`,
    };
    this.phase = "initial";
    this.lastRequestResult = unexpected;
    return { connection: unexpected, agents: [] };
  }

  private async pollPs(
    run: RunHideCommand,
    ctx: ReadContext,
  ): Promise<AccessPollResult> {
    if (ctx.psCount >= MAX_PS_CALLS_PER_READ) {
      this.phase = "initial";
      this.hasCompletedPs = false;
      return {
        connection: {
          kind: "error",
          message: "Exceeded ps retry limit within a single read",
        },
        agents: [],
      };
    }

    ctx.psCount += 1;
    const psOutcome = await this.execEnvelope(run, PS_ARGS);
    if ("connection" in psOutcome) {
      this.phase = "initial";
      this.hasCompletedPs = false;
      return { connection: psOutcome.connection, agents: [] };
    }

    const { envelope } = psOutcome;
    if (envelope.kind === "outdated") {
      this.phase = "initial";
      this.hasCompletedPs = false;
      return { connection: { kind: "hide_outdated" }, agents: [] };
    }
    if (envelope.kind === "invalid") {
      return { connection: { kind: "error", message: envelope.message }, agents: [] };
    }
    if (envelope.kind === "refusal") {
      const mapped = mapRefusalCodeToConnectionState(envelope.code, envelope.message);
      if (mapped.kind === "revoked" || mapped.kind === "refused") {
        this.enterHalted(mapped);
        return { connection: mapped, agents: [] };
      }

      this.phase = "initial";
      const hadCompletedPs = this.hasCompletedPs;
      this.hasCompletedPs = false;

      if (this.shouldRecoverImmediately(envelope.code) && !ctx.requestRan) {
        return this.runAccessRequest(run, ctx, true);
      }
      if (mapped.kind === "not_connected" && !hadCompletedPs && !ctx.requestRan) {
        // If `.request` was approved while offline, `access status` returns `connected`
        // before `access request` promotes `.request` to `.key` for `ps`.
        return this.runAccessRequest(run, ctx, true);
      }

      return { connection: mapped, agents: [] };
    }

    const parsed = parsePsValue(envelope.value);
    if (!parsed.ok) {
      return { connection: { kind: "error", message: parsed.message }, agents: [] };
    }

    this.hasCompletedPs = true;
    return { connection: { kind: "connected" }, agents: parsed.agents };
  }

  private async execEnvelope(
    run: RunHideCommand,
    args: readonly string[],
  ): Promise<{ envelope: CliEnvelope } | { connection: ConnectionState }> {
    try {
      const output = await run(args);
      return { envelope: parseCliJsonEnvelope(output) };
    } catch (error) {
      return { connection: mapExecErrorToConnectionState(error) };
    }
  }
}
