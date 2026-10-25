import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Kill the whole process tree after this long. Default 60 s. */
  readonly timeoutMs?: number;
  /** Keep at most this many bytes of each stream. Default 8 MiB. */
  readonly maxOutputBytes?: number;
  /** Which bytes to keep when a stream is longer: its start (default) or its end. */
  readonly keep?: "start" | "end";
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

export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  /** Pass the arguments to Windows exactly as given, already quoted. */
  readonly verbatim: boolean;
}

/**
 * An environment variable whatever the case of its name, as a Windows child
 * sees it: Node sorts the names and keeps the first of any that differ only
 * in case, so PATH wins over Path.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Arguments cmd.exe passes on unchanged: no spaces, quotes or characters it interprets. */
const PLAIN_ARGUMENT = /^[\w@.,:/\\=+-]+$/;

/**
 * How to start a command on Windows. Tools that npm installs, such as npx,
 * are batch files, which only cmd.exe can run. Those are found on PATH and run
 * through cmd.exe, and only with plain arguments, since cmd.exe would
 * interpret quotes and other special characters. Anything else starts directly.
 */
export function windowsLaunch(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  isFile: (file: string) => boolean,
): Launch {
  const direct: Launch = { command, args, verbatim: false };
  if (/[\\/]/.test(command) || path.win32.extname(command) !== "") return direct;
  // Windows allows quotes around a PATH entry, as in "C:\Program Files\nodejs".
  const directories = (envValue(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = path.win32.join(directory, `${command}${extension}`);
      if (!isFile(file)) continue;
      if (!/^\.(bat|cmd)$/i.test(extension)) return direct;
      const unsafe = args.find((arg) => !PLAIN_ARGUMENT.test(arg));
      if (unsafe !== undefined || /["%]/.test(file)) {
        throw new ProcessError(
          `cannot run ${command} through cmd.exe with ${JSON.stringify(unsafe ?? file)}`,
        );
      }
      // /s strips the outer quotes, leaving the quoted file and its arguments.
      return {
        command: envValue(env, "COMSPEC") ?? "cmd.exe",
        args: ["/d", "/s", "/c", `""${file}"${args.map((arg) => ` ${arg}`).join("")}"`],
        verbatim: true,
      };
    }
  }
  return direct;
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Runs a program without a shell, with a time limit and bounded output. On
 * macOS the child leads its own process group so cancelling kills everything
 * it started; on Windows the tree is killed with taskkill /T, and batch files
 * run through cmd.exe (see windowsLaunch).
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
      const env = options.env ?? process.env;
      const launch = isWindows
        ? windowsLaunch(command, args, env, isFile)
        : { command, args, verbatim: false };
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        detached: !isWindows,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        error instanceof ProcessError
          ? error
          : new ProcessError(`could not start ${command}: ${(error as Error).message}`),
      );
      return;
    }

    const stdout = new BoundedBuffer(maxBytes, options.keep ?? "start");
    const stderr = new BoundedBuffer(maxBytes, options.keep ?? "start");
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
  private chunks: Buffer[] = [];
  private readonly limit: number;
  private readonly keep: "start" | "end";
  private size = 0;
  truncated = false;

  constructor(limit: number, keep: "start" | "end") {
    this.limit = limit;
    this.keep = keep;
  }

  push(chunk: Buffer): void {
    if (this.keep === "end") {
      this.chunks.push(chunk);
      this.size += chunk.length;
      if (this.size > this.limit) {
        // Drop the oldest bytes, keeping exactly the last `limit`.
        const all = Buffer.concat(this.chunks);
        this.chunks = [all.subarray(all.length - this.limit)];
        this.size = this.limit;
        this.truncated = true;
      }
      return;
    }
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
