// Writes docs/projects/genai-patterns.md, the maturity matrix of the GenAI
// patterns, from the pattern plugins' own metadata, so it cannot drift from
// what the plugins generate. With --check, fails if the committed file is out
// of date.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { maturityMarkdown, PATTERN_LIST } from "../src/plugins/builtin/patterns.ts";
import { DEFAULT_PATTERN } from "../src/plugins/registry.ts";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "docs/projects/genai-patterns.md");

const lines = [
  "# GenAI patterns",
  "",
  "<!-- Generated from src/plugins/builtin/patterns.ts by scripts/render-pattern-matrix.ts. Do not edit. -->",
  "",
  "`--workload genai --pattern <name>` generates a [GenAI project](python-pydanticai.md)",
  `around one of these patterns; \`${DEFAULT_PATTERN}\` is the default. A **complete** pattern`,
  "does what its name says; a **foundation** is a working starting point whose",
  "gaps are listed below and in the project's README, never presented as done.",
  "",
  "| Pattern | Maturity | What it is |",
  "| --- | --- | --- |",
  ...PATTERN_LIST.map(
    (pattern) => `| \`${pattern.name}\` | ${pattern.maturity.level} | ${pattern.summary} |`,
  ),
];
for (const pattern of PATTERN_LIST) {
  lines.push(
    "",
    `## ${pattern.name}`,
    "",
    `${pattern.summary}.`,
    "",
    maturityMarkdown(pattern.maturity),
  );
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
    console.error(
      'docs/projects/genai-patterns.md is out of date; run "npm run render:docs" and commit it',
    );
    process.exit(1);
  }
  console.log("docs/projects/genai-patterns.md is up to date");
} else {
  writeFileSync(target, text);
  console.log("wrote docs/projects/genai-patterns.md");
}
