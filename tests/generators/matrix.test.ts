import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  cachedAssets,
  combinations,
  generateCombination,
  unsupportedReason,
} from "../../scripts/matrix/combinations.ts";
import { sha256Hex } from "../../src/domain/plan/plan.ts";
import { MANIFEST_FILE, parseManifest } from "../../src/domain/project/manifest.ts";
import { GOVERNANCE, STACKS, WORKFLOWS } from "../../src/plugins/registry.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const golden = path.join(repoRoot, "tests/fixtures/golden/matrix.txt");

/** Problems with one file's content, checked once per distinct content. */
function contentProblems(file: string, content: string): string[] {
  const problems: string[] = [];
  if (content.includes("{{liftoff.")) problems.push("has an unrendered placeholder");
  for (const local of [repoRoot, homedir()]) {
    if (content.includes(local)) problems.push(`contains the local path ${local}`);
  }
  try {
    if (/\.ya?ml$/.test(file)) parseYaml(content);
    if (file.endsWith(".json")) JSON.parse(content);
  } catch (error) {
    problems.push(`does not parse: ${(error as Error).message.split("\n")[0]}`);
  }
  return problems;
}

describe("PROJ-022 every supported combination generates a valid project", () => {
  it("generates each one cleanly, and the matrix matches its snapshot", async () => {
    const assets = cachedAssets();
    const lines: string[] = [];
    const unsupported = new Map<string, number>();
    const checked = new Set<string>();
    const problems: string[] = [];
    const used = {
      stacks: new Set<string>(),
      workflows: new Set<string>(),
      profiles: new Set<string>(),
    };

    for (const combination of combinations()) {
      const reason = unsupportedReason(combination);
      if (reason !== undefined) {
        unsupported.set(reason, (unsupported.get(reason) ?? 0) + 1);
        continue;
      }
      used.stacks.add(combination.config.stack);
      used.workflows.add(combination.config.workflow);
      used.profiles.add(combination.config.governance);
      const files = await generateCombination(assets, combination);
      for (const file of files) {
        if (
          file.path.startsWith("/") ||
          file.path.includes("\\") ||
          file.path.split("/").includes("..")
        ) {
          problems.push(`${combination.id}: ${file.path} is not a relative POSIX path`);
        }
        if (checked.has(`${file.path} ${file.sha256}`)) continue;
        checked.add(`${file.path} ${file.sha256}`);
        for (const problem of contentProblems(file.path, file.content)) {
          problems.push(`${combination.id}: ${file.path} ${problem}`);
        }
      }
      const manifest = files.find((file) => file.path === MANIFEST_FILE);
      const listed = manifest ? parseManifest(manifest.content).files.map((file) => file.path) : [];
      const others = files.filter((file) => file.path !== MANIFEST_FILE).map((file) => file.path);
      if (listed.join("\n") !== others.join("\n")) {
        problems.push(`${combination.id}: the manifest does not list exactly the generated files`);
      }
      const inventory = files.map((file) => `${file.path} ${file.ownership} ${file.sha256}`);
      lines.push(
        `${combination.id} ${files.length} ${sha256Hex(inventory.join("\n")).slice(0, 16)}`,
      );
    }

    expect(problems).toEqual([]);
    // Each stack, workflow and profile is supported in at least one combination.
    expect([...used.stacks].sort()).toEqual(Object.keys(STACKS).sort());
    expect([...used.workflows].sort()).toEqual(Object.keys(WORKFLOWS).sort());
    expect([...used.profiles].sort()).toEqual(Object.keys(GOVERNANCE).sort());

    const text = [
      "# Every combination of project options: stack and pattern, workflow, agents, profile.",
      "# Supported: <combination> <files> <first 16 hex of the inventory's sha256>.",
      "# Made by tests/generators/matrix.test.ts; UPDATE_GOLDEN=1 regenerates it.",
      ...lines,
      ...[...unsupported]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => `unsupported ${count}: ${reason}`),
      "",
    ].join("\n");
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, text);
    expect(text).toBe(readFileSync(golden, "utf8"));
  }, 300_000);
});
