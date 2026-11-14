import { DEFAULT_HIDE_PATH, type HideSnapshot, type HideSource } from "./types.js";

export interface HideCliSourceOptions {
  hidePath?: string;
  now?: () => number;
}

/**
 * Placeholder CLI data source.
 * The hide-source node replaces this implementation with actual `hide` CLI execution and access handling.
 */
export class HideCliSource implements HideSource {
  readonly hidePath: string;
  private readonly now: () => number;

  constructor(options: HideCliSourceOptions = {}) {
    this.hidePath = options.hidePath ?? DEFAULT_HIDE_PATH;
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
