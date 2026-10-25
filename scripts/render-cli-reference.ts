// Writes docs/reference/cli.md from the command registry, so the reference
// lists exactly the commands and options that exist. With --check, fails if
// the committed reference is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandName, type OptionSpec } from "../src/cli/command.ts";
import { OUTCOMES } from "../src/cli/outcome.ts";
import { COMMON_OPTIONS } from "../src/cli/parse.ts";
import { REGISTRY } from "../src/cli/registry.ts";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "docs/reference/cli.md");

const option = ([name, spec]: [string, OptionSpec]) => {
  const flag = spec.type === "string" ? `\`--${name} <${spec.valueName}>\`` : `\`--${name}\``;
  const extras: string[] = [];
  if (spec.type === "string" && spec.choices)
    extras.push(`one of ${spec.choices.map((c) => `\`${c}\``).join(", ")}`);
  if (spec.type === "string" && spec.default !== undefined)
    extras.push(`default \`${spec.default}\``);
  const detail = extras.length > 0 ? ` (${extras.join("; ")})` : "";
  return `| ${flag} | ${spec.description.replaceAll("|", "\\|")}${detail} |`;
};

const lines = [
  "# Command reference",
  "",
  "<!-- Generated from src/cli/registry.ts by scripts/render-cli-reference.ts. Do not edit. -->",
  "",
  "Every command accepts `--json` (print one JSON report on stdout) and `--help`.",
  "",
  "## Exit codes",
  "",
  "| Code | Outcome |",
  "| --- | --- |",
  ...Object.entries(OUTCOMES).map(([outcome, code]) => `| ${code} | ${outcome} |`),
];
for (const spec of REGISTRY) {
  lines.push(
    "",
    `## liftoff ${commandName(spec)}`,
    "",
    spec.description,
    "",
    spec.readOnly ? "Read-only." : "Changes files; asks first unless `--yes` is given.",
    "",
    `JSON report: \`${spec.reportSchema}\`.`,
  );
  const options = Object.entries({ ...spec.options, ...COMMON_OPTIONS });
  lines.push("", "| Option | Description |", "| --- | --- |", ...options.map(option));
  if (spec.examples.length > 0) {
    lines.push("", "```bash", ...spec.examples, "```");
  }
}
const text = `${lines.join("\n")}\n`;

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(target, "utf8");
  } catch {
    // Reported below.
  }
  if (committed !== text) {
    console.error('docs/reference/cli.md is out of date; run "npm run render:docs" and commit it');
    process.exit(1);
  }
  console.log("docs/reference/cli.md is up to date");
} else {
  writeFileSync(target, text);
  console.log("wrote docs/reference/cli.md");
}
