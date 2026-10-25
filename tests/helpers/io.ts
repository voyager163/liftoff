import type { Io } from "../../src/cli/command.ts";

export interface CapturedIo extends Io {
  readonly out: string[];
  readonly err: string[];
  readonly questions: string[];
  readonly controller: AbortController;
}

/**
 * An Io that records output instead of writing to the terminal. Pass
 * `answer` to make it interactive and answer every confirmation that way.
 */
export function captureIo(cwd = process.cwd(), answer?: boolean): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const controller = new AbortController();
  return {
    out,
    err,
    questions,
    controller,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    cwd,
    env: {},
    signal: controller.signal,
    interactive: answer !== undefined,
    confirm: async (question) => {
      questions.push(question);
      return answer === true;
    },
  };
}
