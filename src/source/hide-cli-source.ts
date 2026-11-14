import { execFile, type ExecFileException } from "node:child_process";

import {
  HIDE_ACCESS_NAME,
  HideAccessStateMachine,
} from "./hide-access.js";
import { DEFAULT_HIDE_PATH, type HideSnapshot, type HideSource } from "./types.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
export const DEFAULT_READ_TIMEOUT_MS = 10_000;

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
  timeoutMs?: number;
  readTimeoutMs?: number;
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function buildHideExecEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.HIDE_ACCESS = HIDE_ACCESS_NAME;
  return env;
}

/**
 * Default CLI runner using `child_process.execFile` without a shell, supporting timeout and AbortSignal.
 */
export const defaultHideExec: HideExec = (file, args, opts) => {
  if (opts.signal?.aborted) {
    return Promise.reject(createAbortError(opts.signal.reason));
  }

  return new Promise<HideExecResult>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        env: opts.env,
        timeout: opts.timeoutMs,
        signal: opts.signal,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");

        if (error === null) {
          resolve({
            stdout: out,
            stderr: errText,
            exitCode: child.exitCode ?? 0,
          });
          return;
        }

        const execErr = error as ExecFileException;
        if (
          typeof execErr.code === "number" &&
          !execErr.killed &&
          !opts.signal?.aborted
        ) {
          resolve({
            stdout: out,
            stderr: errText,
            exitCode: execErr.code,
          });
          return;
        }

        reject(error);
      },
    );
  });
};

export class HideCliSource implements HideSource {
  readonly hidePath: string;
  readonly exec: HideExec;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly accessMachine: HideAccessStateMachine;

  private activeAbortController: AbortController | null = null;
  private readChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: HideCliSourceOptions = {}) {
    this.hidePath = options.hidePath ?? DEFAULT_HIDE_PATH;
    this.exec = options.exec ?? defaultHideExec;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.readTimeoutMs =
      options.readTimeoutMs ??
      (options.timeoutMs !== undefined
        ? Math.max(options.timeoutMs, options.timeoutMs * 2)
        : DEFAULT_READ_TIMEOUT_MS);
    this.accessMachine = new HideAccessStateMachine(this.now);
  }

  read(): Promise<HideSnapshot> {
    if (this.disposed) {
      return Promise.resolve({
        connection: { kind: "error", message: "Source has been disposed" },
        agents: [],
        readAt: this.now(),
      });
    }

    const nextRead = this.readChain.then(() => this.performRead());
    this.readChain = nextRead.then(
      () => undefined,
      () => undefined,
    );
    return nextRead;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.activeAbortController?.abort(createAbortError("Source has been disposed"));
    this.activeAbortController = null;
  }

  private async performRead(): Promise<HideSnapshot> {
    if (this.disposed) {
      return {
        connection: { kind: "error", message: "Source has been disposed" },
        agents: [],
        readAt: this.now(),
      };
    }

    const readDeadline = Date.now() + this.readTimeoutMs;
    const result = await this.accessMachine.poll((args) =>
      this.runCommand(args, readDeadline),
    );
    return {
      connection: result.connection,
      agents: result.agents,
      readAt: this.now(),
    };
  }

  private async runCommand(
    args: readonly string[],
    readDeadline: number,
  ): Promise<HideExecResult> {
    if (this.disposed) {
      throw createAbortError("Source has been disposed");
    }

    const remainingReadMs = readDeadline - Date.now();
    if (remainingReadMs <= 0) {
      throw new Error(`hide read timed out after ${this.readTimeoutMs}ms`);
    }
    const effectiveTimeoutMs = Math.min(this.timeoutMs, remainingReadMs);

    const controller = new AbortController();
    this.activeAbortController = controller;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      const execPromise = this.exec(this.hidePath, [...args], {
        env: buildHideExecEnv(),
        timeoutMs: effectiveTimeoutMs,
        signal: controller.signal,
      });
      // Avoid unhandled rejection if the underlying exec rejects after abort/timeout settles the race.
      execPromise.catch(() => {});

      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (controller.signal.aborted) {
          reject(createAbortError(controller.signal.reason));
          return;
        }
        onAbort = () => reject(createAbortError(controller.signal.reason));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(
            `hide command timed out after ${effectiveTimeoutMs}ms`,
          );
          controller.abort(timeoutError);
          reject(timeoutError);
        }, effectiveTimeoutMs + 50);
      });

      return await Promise.race([execPromise, abortPromise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (onAbort !== undefined) {
        controller.signal.removeEventListener("abort", onAbort);
      }
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }
}
