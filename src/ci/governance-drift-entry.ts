// Entry point for the bundled governance drift check (.github/liftoff/governance-drift.mjs).
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { main } from "./governance-drift-check.ts";

process.exitCode = await main({
  env: process.env,
  listRulesetFiles: () =>
    readdirSync(".github/rulesets")
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => `.github/rulesets/${name}`),
  readFile: (path) => readFileSync(path, "utf8"),
  appendFile: (path, text) => appendFileSync(path, text),
  log: (text) => process.stdout.write(text),
});
