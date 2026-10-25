import type { ToolPort } from "../application/ports.ts";
import { ProcessError, run } from "./process.ts";

/** Runs `<tool> --version` style commands with a short time limit. */
export class LocalTools implements ToolPort {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async version(command: string, args: readonly string[]): Promise<string | undefined> {
    try {
      const result = await run(command, args, {
        cwd: this.cwd,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0) return undefined;
      return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    } catch (error) {
      if (error instanceof ProcessError) return undefined;
      throw error;
    }
  }
}
