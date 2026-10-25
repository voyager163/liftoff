import type { Io } from "../../src/cli/command.ts";

export interface CapturedIo extends Io {
  readonly out: string[];
  readonly err: string[];
  readonly controller: AbortController;
}

/** An Io that records output instead of writing to the terminal. */
export function captureIo(cwd = process.cwd()): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  return {
    out,
    err,
    controller,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    cwd,
    env: {},
    signal: controller.signal,
  };
}
