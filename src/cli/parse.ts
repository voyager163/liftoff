import { parseArgs } from "node:util";
import { type CommandSpec, commandName, type OptionSpec, type ParsedArgs } from "./command.ts";
import { UsageError } from "./outcome.ts";

/** Options every command accepts. */
export const COMMON_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  json: { type: "boolean", description: "Print one JSON report on stdout." },
  help: { type: "boolean", short: "h", description: "Show help for this command." },
};

export type Resolution =
  | { readonly kind: "command"; readonly spec: CommandSpec; readonly rest: readonly string[] }
  | {
      readonly kind: "group";
      readonly path: readonly string[];
      readonly specs: readonly CommandSpec[];
    }
  | { readonly kind: "root" };

/**
 * Finds the command named by the leading words of argv. A prefix shared by
 * several commands (such as "review") resolves to that group.
 */
export function resolveCommand(
  registry: readonly CommandSpec[],
  argv: readonly string[],
): Resolution {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  if (words.length === 0) return { kind: "root" };

  let best: CommandSpec | undefined;
  for (const spec of registry) {
    if (spec.path.length > words.length) continue;
    if (spec.path.every((word, i) => words[i] === word)) {
      if (!best || spec.path.length > best.path.length) best = spec;
    }
  }
  if (best) return { kind: "command", spec: best, rest: argv.slice(best.path.length) };

  for (let length = words.length; length > 0; length--) {
    const prefix = words.slice(0, length);
    const specs = registry.filter((spec) => prefix.every((word, i) => spec.path[i] === word));
    if (specs.length > 0) {
      if (length < words.length) {
        throw new UsageError(
          `unknown command "${words.slice(0, length + 1).join(" ")}"${suggest(registry, words)}`,
        );
      }
      return { kind: "group", path: prefix, specs };
    }
  }
  throw new UsageError(`unknown command "${words[0]}"${suggest(registry, words)}`);
}

/** Parses a command's options strictly: unknown options and stray arguments fail. */
export function parseCommandArgs(spec: CommandSpec, rest: readonly string[]): ParsedArgs {
  const all = { ...COMMON_OPTIONS, ...spec.options };
  const config: Record<string, { type: "string" | "boolean"; short?: string }> = {};
  for (const [name, option] of Object.entries(all)) {
    config[name] =
      option.short === undefined
        ? { type: option.type }
        : { type: option.type, short: option.short };
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: config,
      strict: true,
      allowPositionals: (spec.positionals?.length ?? 0) > 0,
      allowNegative: false,
    });
  } catch (error) {
    throw new UsageError(`${commandName(spec)}: ${cleanParseError((error as Error).message)}`);
  }

  const maxPositionals = spec.positionals?.length ?? 0;
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(
      `${commandName(spec)}: unexpected argument "${parsed.positionals[maxPositionals]}"`,
    );
  }

  const options: Record<string, string | boolean | undefined> = {};
  for (const [name, option] of Object.entries(all)) {
    const value = parsed.values[name];
    if (Array.isArray(value))
      throw new UsageError(`${commandName(spec)}: --${name} was given more than once`);
    if (option.type === "string") {
      const text = (value as string | undefined) ?? option.default;
      if (text !== undefined && option.choices && !option.choices.includes(text)) {
        throw new UsageError(
          `${commandName(spec)}: --${name} must be one of ${option.choices.join(", ")} (got "${text}")`,
        );
      }
      if (text === "") throw new UsageError(`${commandName(spec)}: --${name} needs a value`);
      options[name] = text;
    } else {
      options[name] = value === true;
    }
  }
  return { options, positionals: parsed.positionals, given: new Set(Object.keys(parsed.values)) };
}

// node:util messages are sentences with advice for script authors; keep the
// first clause and match the lowercase style of Liftoff's own messages.
function cleanParseError(message: string): string {
  const first = message.replace(/\. (To specify|This command).*$/s, "");
  return first.charAt(0).toLowerCase() + first.slice(1);
}

function suggest(registry: readonly CommandSpec[], words: readonly string[]): string {
  const typed = words.join(" ");
  const names = registry.map(commandName);
  const close = names.filter(
    (name) => distance(name, typed) <= 2 || name.startsWith(words[0] ?? ""),
  );
  return close.length > 0 ? `; did you mean ${close.map((n) => `"${n}"`).join(" or ")}?` : "";
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}
