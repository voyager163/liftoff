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

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

export interface ParsedArgs {
  readonly options: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
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
