import { spawn, type ChildProcess } from "node:child_process";

import {
  HIDE_ACCESS_NAME,
  HideAccessStateMachine,
} from "./hide-access.js";
import { DEFAULT_HIDE_PATH, type HideSnapshot, type HideSource } from "./types.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
export const DEFAULT_READ_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const PROCESS_GROUP_KILL_GRACE_MS = 150;

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

function sendGroupSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, 0);
    } else {
      process.kill(pid, 0);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates a detached child process and any grandchildren in its process group,
 * escalating from SIGTERM to SIGKILL after a short grace period.
 */
function terminateProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (!sendGroupSignal(pid, "SIGTERM")) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child or group already exited.
    }
  }

  const killTimer = setTimeout(() => {
    if (!isProcessGroupAlive(pid)) {
      return;
    }
    if (!sendGroupSignal(pid, "SIGKILL")) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Child or group already exited.
      }
    }
  }, PROCESS_GROUP_KILL_GRACE_MS);
  killTimer.unref();
}

/**
 * Default CLI runner spawning without a shell in its own process group (`detached: true`)
 * so timeout or AbortSignal terminates the child and all descendant processes.
 */
export const defaultHideExec: HideExec = (file, args, opts) => {
  if (opts.signal?.aborted) {
    return Promise.reject(createAbortError(opts.signal.reason));
  }

  return new Promise<HideExecResult>((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(file, args, {
      env: opts.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const failWith = (error: Error, killGroup: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (killGroup) {
        terminateProcessGroup(child);
      }
      reject(error);
    };

    const onAbort = (): void => {
      failWith(createAbortError(opts.signal?.reason), true);
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        failWith(
          new Error(`hide command timed out after ${opts.timeoutMs}ms`),
          true,
        );
      }, opts.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        failWith(new Error("hide stdout exceeded maxBuffer"), true);
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        failWith(new Error("hide stderr exceeded maxBuffer"), true);
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      failWith(error, false);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (code === null && signal !== null) {
        reject(new Error(`hide exited with signal ${signal}`));
        return;
      }

      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
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
        ? options.timeoutMs * 2
        : DEFAULT_READ_TIMEOUT_MS);
    this.accessMachine = new HideAccessStateMachine(this.now);
  }

  retry(): void {
    if (this.disposed) {
      return;
    }
    this.accessMachine.retry();
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
