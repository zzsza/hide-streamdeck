import { DEFAULT_HIDE_PATH, type HideSnapshot, type HideSource } from "./types.js";

export interface HideExecOptions {
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HideExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type HideExec = (
  file: string,
  args: string[],
  opts: HideExecOptions,
) => Promise<HideExecResult>;

export interface HideCliSourceOptions {
  hidePath?: string;
  exec?: HideExec;
  now?: () => number;
}

/**
 * Placeholder CLI data source.
 * The hide-source node replaces this implementation with actual `hide` CLI execution and access handling.
 */
export class HideCliSource implements HideSource {
  readonly hidePath: string;
  readonly exec?: HideExec;
  private readonly now: () => number;

  constructor(options: HideCliSourceOptions = {}) {
    this.hidePath = options.hidePath ?? DEFAULT_HIDE_PATH;
    this.exec = options.exec;
    this.now = options.now ?? Date.now;
  }

  async read(): Promise<HideSnapshot> {
    return {
      connection: { kind: "error", message: "not implemented" },
      agents: [],
      readAt: this.now(),
    };
  }

  dispose(): void {
    // No resources held in placeholder implementation.
  }
}
