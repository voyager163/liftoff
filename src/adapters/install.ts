import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallPorts, QueryResult } from "../application/ports.ts";
import { ProcessError, run } from "./process.ts";

/** The Liftoff package directory: two levels above this file in src/ and dist/ alike. */
const packageDirectory = (): string => fileURLToPath(new URL("../../", import.meta.url));

/** PATH with `first` before what it was, whatever case its name has. */
export function withPathFirst(
  env: NodeJS.ProcessEnv,
  first: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  if (first === undefined || first.length === 0) return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const rest = env[key];
  return {
    ...env,
    [key]: [...first, ...(rest ? [rest] : [])].join(path.delimiter),
  };
}

/** The running Liftoff and the channels' tools on this machine. */
export class LocalInstall implements InstallPorts {
  readonly platform = process.platform === "win32" ? "win32" : "darwin";
  readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;

  constructor(cwd: string, env: NodeJS.ProcessEnv = process.env) {
    this.cwd = cwd;
    this.env = env;
  }

  async running() {
    return {
      app: await realpath(packageDirectory()),
      executable: await realpath(process.execPath),
    };
  }

  async realPath(file: string): Promise<string | undefined> {
    try {
      return await realpath(file);
    } catch {
      return undefined;
    }
  }

  async readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }

  async exists(file: string): Promise<boolean> {
    try {
      await lstat(file);
      return true;
    } catch {
      return false;
    }
  }

  async query(
    command: string,
    args: readonly string[],
    pathFirst?: readonly string[],
  ): Promise<QueryResult | undefined> {
    try {
      const result = await run(command, args, {
        cwd: this.cwd,
        env: withPathFirst(this.env, pathFirst),
        timeoutMs: 60_000,
      });
      if (result.timedOut || result.cancelled) return undefined;
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (error instanceof ProcessError) return undefined;
      throw error;
    }
  }

  delegate(
    command: string,
    args: readonly string[],
    pathFirst?: readonly string[],
  ): Promise<number | null> {
    return new Promise((resolve) => {
      // Its output goes to stderr, so stdout keeps only Liftoff's own report.
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: withPathFirst(this.env, pathFirst),
        shell: false,
        stdio: ["ignore", 2, 2],
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
  }

  async handOff(command: string, args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // Detached on Windows gives it a console of its own, which shows its
      // progress after Liftoff exits.
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      child.once("error", (error) =>
        reject(new ProcessError(`could not start ${command}: ${error.message}`)),
      );
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "liftoff-cli" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  }
}
