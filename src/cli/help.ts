import { type CommandSpec, commandName, type OptionSpec } from "./command.ts";
import { COMMON_OPTIONS } from "./parse.ts";

const pad = (text: string, width: number) => text + " ".repeat(Math.max(1, width - text.length));

function optionLabel(name: string, option: OptionSpec): string {
  const short = option.short === undefined ? "" : `-${option.short}, `;
  return option.type === "string" ? `${short}--${name} <${option.valueName}>` : `${short}--${name}`;
}

function optionDetail(option: OptionSpec): string {
  if (option.type === "boolean") return option.description;
  const extras: string[] = [];
  if (option.choices) extras.push(`one of: ${option.choices.join(", ")}`);
  if (option.default !== undefined) extras.push(`default: ${option.default}`);
  return extras.length === 0 ? option.description : `${option.description} (${extras.join("; ")})`;
}

export function renderRootHelp(registry: readonly CommandSpec[], version: string): string {
  const width = Math.max(...registry.map((spec) => commandName(spec).length)) + 4;
  const lines = [
    `Liftoff ${version}`,
    "",
    "Usage: liftoff <command> [options]",
    "",
    "Commands:",
    ...registry.map((spec) => `  ${pad(commandName(spec), width)}${spec.summary}`),
    "",
    "Options:",
    "  --version     Print the Liftoff version.",
    "  -h, --help    Show help.",
    "",
    'Run "liftoff help <command>" for details on a command.',
  ];
  return `${lines.join("\n")}\n`;
}

export function renderGroupHelp(path: readonly string[], specs: readonly CommandSpec[]): string {
  const width = Math.max(...specs.map((spec) => commandName(spec).length)) + 4;
  const lines = [
    `Usage: liftoff ${path.join(" ")} <command> [options]`,
    "",
    "Commands:",
    ...specs.map((spec) => `  ${pad(commandName(spec), width)}${spec.summary}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderCommandHelp(spec: CommandSpec): string {
  const options = Object.entries({ ...spec.options, ...COMMON_OPTIONS });
  const labels = options.map(([name, option]) => optionLabel(name, option));
  const width = Math.max(...labels.map((label) => label.length)) + 4;
  const positionals = (spec.positionals ?? []).map((p) => ` [${p.name}]`).join("");
  const lines = [
    `Usage: liftoff ${commandName(spec)}${positionals} [options]`,
    "",
    spec.description,
    "",
    spec.readOnly ? "This command is read-only." : "This command can change files or settings.",
  ];
  if (spec.positionals && spec.positionals.length > 0) {
    lines.push("", "Arguments:");
    for (const p of spec.positionals) lines.push(`  ${pad(p.name, width)}${p.description}`);
  }
  lines.push("", "Options:");
  options.forEach(([, option], i) => {
    lines.push(`  ${pad(labels[i] ?? "", width)}${optionDetail(option)}`);
  });
  if (spec.examples.length > 0) {
    lines.push("", "Examples:", ...spec.examples.map((example) => `  ${example}`));
  }
  return `${lines.join("\n")}\n`;
}
