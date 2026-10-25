import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { InitializerOutcome, InitializerPort } from "../application/ports.ts";
import type { InitializerStep } from "../plugins/contracts/project-plugin.ts";
import { ProcessError, run } from "./process.ts";

/** Initializers download their framework first, so they get longer than other commands. */
const TIMEOUT_MS = 10 * 60_000;
/** How much of an initializer's output an error message keeps, from the end. */
const OUTPUT_TAIL = 4000;

/**
 * The environment an initializer runs with: the user's own, with telemetry
 * and update checks off, no prompts or colors, and configuration and data
 * directories in `scratch`, so nothing it writes there reaches the user's
 * global configuration.
 */
export function initializerEnv(base: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: "1",
    DO_NOT_TRACK: "1",
    OPENSPEC_TELEMETRY: "0",
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_DATA_HOME: path.join(scratch, "data"),
  };
}

/** Runs initializers on this machine through the bounded process runner. */
export class LocalInitializer implements InitializerPort {
  async run(
    step: InitializerStep,
    directory: string,
    signal?: AbortSignal,
  ): Promise<InitializerOutcome> {
    const scratch = await mkdtemp(path.join(tmpdir(), "liftoff-initializer-"));
    try {
      const result = await run(step.command, step.args, {
        cwd: directory,
        env: initializerEnv(process.env, scratch),
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
        ...(signal ? { signal } : {}),
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

  machinePaths(): readonly string[] {
    const home = homedir();
    return [...new Set([home, home.split(path.sep).join("/")])];
  }
}
