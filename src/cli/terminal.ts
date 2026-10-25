import type { Readable, Writable } from "node:stream";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import type { Choice, Prompts } from "./command.ts";
import { CancelledError } from "./outcome.ts";

/** Ctrl+C at a question, or a cancelled command, stops the command as cancelled. */
export const answered = <T>(prompt: Promise<T>): Promise<T> =>
  prompt.catch((error: unknown) => {
    const name = (error as Error | undefined)?.name;
    if (name === "ExitPromptError" || name === "AbortPromptError") {
      throw new CancelledError("stopped at a question");
    }
    throw error;
  });

/** Choices as Inquirer takes them: a choice that cannot be chosen says why. */
export const inquirerChoices = <C extends Choice>(choices: readonly C[]) =>
  choices.map(({ disabled, ...choice }) =>
    disabled === undefined ? choice : { ...choice, disabled },
  );

/**
 * Asks with Inquirer in the terminal; the default answer of a yes/no question
 * is no. Questions are written to stderr, so stdout carries only the command's
 * result, such as its --json report.
 */
export function terminalPrompts(
  signal: AbortSignal,
  streams: { readonly input: Readable; readonly output: Writable } = {
    input: process.stdin,
    output: process.stderr,
  },
): {
  confirm(message: string): Promise<boolean>;
  prompts: Prompts;
} {
  const context = { signal, input: streams.input, output: streams.output };
  return {
    confirm: (message) => answered(confirm({ message, default: false }, context)),
    prompts: {
      text: ({ message, default: suggested, validate }) =>
        answered(
          input(
            {
              message,
              ...(suggested === undefined ? {} : { default: suggested }),
              validate: (value) => validate?.(value) ?? true,
            },
            context,
          ),
        ),
      select: ({ message, choices, default: suggested }) =>
        answered(
          select(
            {
              message,
              choices: inquirerChoices(choices),
              ...(suggested === undefined ? {} : { default: suggested }),
            },
            context,
          ),
        ),
      checkbox: ({ message, choices, required }) =>
        answered(
          checkbox(
            { message, choices: inquirerChoices(choices), required: required === true },
            context,
          ),
        ),
    },
  };
}
