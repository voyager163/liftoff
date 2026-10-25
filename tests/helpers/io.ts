import type { Choice, Io, Question } from "../../src/cli/command.ts";

export interface CapturedIo extends Io {
  readonly out: string[];
  readonly err: string[];
  readonly questions: string[];
  /** Each question asked, by its option, with the answers it offered. */
  readonly asked: { flag: string; choices?: readonly Choice[]; default?: string | string[] }[];
  readonly controller: AbortController;
}

/** Answers to questions, by option; a question with no answer here takes its default. */
export type Answers = Readonly<Record<string, string | readonly string[]>>;

/**
 * An Io that records output instead of writing to the terminal. Pass
 * `answer` to make it interactive and answer every confirmation that way, and
 * `answers` to answer the questions as a person would. An answer a question
 * would refuse fails the test.
 */
export function captureIo(
  cwd = process.cwd(),
  answer?: boolean,
  answers: Answers = {},
): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const asked: CapturedIo["asked"] = [];
  const controller = new AbortController();
  const given = (question: Question) => answers[question.flag];
  const choose = (choices: readonly Choice[], value: string) => {
    const choice = choices.find((candidate) => candidate.value === value);
    if (choice === undefined || choice.disabled !== undefined)
      throw new Error(`cannot choose ${value}`);
    return value;
  };
  return {
    asked,
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
    prompts: {
      text: async (question) => {
        asked.push({
          flag: question.flag,
          ...(question.default === undefined ? {} : { default: question.default }),
        });
        const value = (given(question) as string | undefined) ?? question.default ?? "";
        const problem = question.validate?.(value);
        if (problem !== undefined) throw new Error(`refused ${question.flag}: ${problem}`);
        return value;
      },
      select: async (question) => {
        asked.push({
          flag: question.flag,
          choices: question.choices,
          ...(question.default === undefined ? {} : { default: question.default }),
        });
        return choose(
          question.choices,
          (given(question) as string | undefined) ?? question.default ?? "",
        );
      },
      checkbox: async (question) => {
        const checked = question.choices.filter((c) => c.checked).map((c) => c.value);
        asked.push({ flag: question.flag, choices: question.choices, default: checked });
        const values = [...((given(question) as readonly string[] | undefined) ?? checked)];
        for (const value of values) choose(question.choices, value);
        if (question.required === true && values.length === 0)
          throw new Error(`refused ${question.flag}: choose at least one`);
        return values;
      },
    },
  };
}
