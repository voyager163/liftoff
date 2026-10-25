import type { Outcome } from "./outcome.ts";

export interface StringOption {
  readonly type: "string";
  readonly description: string;
  readonly valueName: string;
  readonly default?: string;
  readonly choices?: readonly string[];
  readonly short?: string;
}

export interface BooleanOption {
  readonly type: "boolean";
  readonly description: string;
  readonly short?: string;
}

export type OptionSpec = StringOption | BooleanOption;

/** One answer a question offers. */
export interface Choice {
  readonly value: string;
  /** How the answer is shown, if not its value. */
  readonly name?: string;
  readonly description?: string;
  /** Why it cannot be chosen with the earlier answers, if it cannot. */
  readonly disabled?: string;
}

/**
 * A question asked in a terminal. It is named after the command-line option
 * that gives the same answer, so every answer can also be given as a flag.
 */
export interface Question {
  readonly flag: string;
  readonly message: string;
}

/** Questions for a person at a terminal. Only asked when `Io.interactive` is true. */
export interface Prompts {
  /** Free text; `validate` returns why an answer is not accepted. */
  text(
    question: Question & { default?: string; validate?: (value: string) => string | undefined },
  ): Promise<string>;
  select(question: Question & { choices: readonly Choice[]; default?: string }): Promise<string>;
  /** Several answers; `required` refuses none. */
  checkbox(
    question: Question & {
      choices: readonly (Choice & { checked?: boolean })[];
      required?: boolean;
    },
  ): Promise<string[]>;
}

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** True when a person can answer prompts (stdin and stdout are terminals). */
  readonly interactive: boolean;
  /** Asks a yes/no question; the default answer is always no. */
  confirm(question: string): Promise<boolean>;
  readonly prompts: Prompts;
}

export interface ParsedArgs {
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
  /** Options typed on the command line, as opposed to filled in from defaults. */
  readonly given: ReadonlySet<string>;
}

export interface CommandResult {
  readonly outcome: Outcome;
  /** Machine-readable payload; printed as JSON with `--json`. */
  readonly report: Readonly<Record<string, unknown>>;
  /** Human-readable text printed without `--json`. */
  readonly text: string;
}

export interface CommandContext {
  readonly io: Io;
  readonly registry: readonly CommandSpec[];
  readonly version: string;
}

export interface CommandSpec {
  /** Words that select the command, such as ["review", "classify"]. */
  readonly path: readonly string[];
  readonly summary: string;
  readonly description: string;
  /** True when the command never changes files, settings or remote state. */
  readonly readOnly: boolean;
  /** Schema id of the JSON report, such as "liftoff.capabilities/v1". */
  readonly reportSchema: string;
  readonly options: Readonly<Record<string, OptionSpec>>;
  readonly positionals?: readonly { readonly name: string; readonly description: string }[];
  readonly examples: readonly string[];
  run(args: ParsedArgs, context: CommandContext): Promise<CommandResult>;
}

export const commandName = (spec: Pick<CommandSpec, "path">): string => spec.path.join(" ");
