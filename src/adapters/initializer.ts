import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { InitializerOutcome, InitializerPort } from "../application/ports.ts";
import type { InitializerStep } from "../plugins/contracts/project-plugin.ts";
import { ProcessError, run } from "./process.ts";

/** How much of an initializer's output an error message keeps, from the end. */
const OUTPUT_TAIL = 4000;

/**
 * The environment an initializer runs with: the user's own, with telemetry
 * and update checks off and no prompts or colors. Its home, configuration,
 * data and Codex directories are in `scratch`, so nothing it writes there,
 * such as telemetry settings or the clean-up of another tool's global
 * prompts, reaches the user's machine. It still reads the user's npm and Git
 * settings, so registries, proxies and credentials work, and it keeps using
 * their package caches.
 */
export function initializerEnv(
  base: NodeJS.ProcessEnv,
  scratch: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const scratchHome = path.join(scratch, "home");
  // Settings the user gave explicitly win; npm reads its variables in any case.
  const given = (name: string) =>
    Object.keys(base).some((key) => key.toLowerCase() === name.toLowerCase());
  const userFile = (variable: string, name: string) => {
    const file = path.join(home, name);
    return given(variable) || !exists(file) ? undefined : file;
  };
  const npmrc = userFile("npm_config_userconfig", ".npmrc");
  const gitconfig = userFile("GIT_CONFIG_GLOBAL", ".gitconfig");
  const posix = platform !== "win32";
  return {
    ...base,
    CI: "1",
    DO_NOT_TRACK: "1",
    OPENSPEC_TELEMETRY: "0",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    CODEX_HOME: path.join(scratch, "codex"),
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_DATA_HOME: path.join(scratch, "data"),
    // Read, never changed: the user's caches and settings.
    ...(posix ? { XDG_CACHE_HOME: base.XDG_CACHE_HOME ?? path.join(home, ".cache") } : {}),
    ...(posix && !given("npm_config_cache") ? { npm_config_cache: path.join(home, ".npm") } : {}),
    ...(npmrc ? { npm_config_userconfig: npmrc } : {}),
    ...(gitconfig ? { GIT_CONFIG_GLOBAL: gitconfig } : {}),
  };
}

/** Runs initializers on this machine through the bounded process runner. */
export class LocalInitializer implements InitializerPort {
  private readonly home: string;

  constructor(home: string = homedir()) {
    this.home = home;
  }

  async run(
    step: InitializerStep,
    directory: string,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<InitializerOutcome> {
    const scratch = await mkdtemp(path.join(tmpdir(), "liftoff-initializer-"));
    try {
      const result = await run(step.command, step.args, {
        cwd: directory,
        env: initializerEnv(process.env, scratch, this.home),
        timeoutMs: options.timeoutMs,
        // The end of the output explains a failure.
        maxOutputBytes: 1024 * 1024,
        keep: "end",
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        started: true,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: `${result.stdout}${result.stderr}`.trim().slice(-OUTPUT_TAIL),
      };
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
      return { started: false, exitCode: null, timedOut: false, output: error.message };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** The home directory and the temporary directory initializers run from. */
  machinePaths(): readonly string[] {
    return [this.home, tmpdir()];
  }
}
