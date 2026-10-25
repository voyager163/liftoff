import { type ChildProcess, spawn } from "node:child_process";

export interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Kill the whole process tree after this long. Default 60 s. */
  readonly timeoutMs?: number;
  /** Keep at most this many bytes of each stream. Default 8 MiB. */
  readonly maxOutputBytes?: number;
  readonly input?: string;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Output went past `maxOutputBytes` and was cut off. */
  readonly truncated: boolean;
}

export class ProcessError extends Error {
  override readonly name = "ProcessError";
}

const isWindows = process.platform === "win32";

/**
 * Runs a program without a shell, with a time limit and bounded output. On
 * macOS the child leads its own process group so cancelling kills everything
 * it started; on Windows the tree is killed with taskkill /T.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessError(`${command} was cancelled before it started`));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: !isWindows,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ProcessError(`could not start ${command}: ${(error as Error).message}`));
      return;
    }

    const stdout = new BoundedBuffer(maxBytes);
    const stderr = new BoundedBuffer(maxBytes);
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(new ProcessError(`could not start ${command}: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        cancelled,
        truncated: stdout.truncated || stderr.truncated,
      });
    });

    child.stdin?.on("error", () => {
      // The child may exit before reading its input; that is reported by close.
    });
    child.stdin?.end(options.input ?? "");
  });
}

/** Kills a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private readonly limit: number;
  private size = 0;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
