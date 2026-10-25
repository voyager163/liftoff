// Entry point for the bundled branch-policy and release-lineage checks
// (.github/liftoff/branch-policy.mjs): node branch-policy.mjs branch|lineage
import { appendFileSync, readFileSync } from "node:fs";
import { main } from "./branch-policy-check.ts";

const mode = process.argv[2];
if (mode !== "branch" && mode !== "lineage") {
  process.stderr.write("usage: branch-policy.mjs branch|lineage\n");
  process.exitCode = 2;
} else {
  process.exitCode = await main(mode, {
    env: process.env,
    readFile: (path) => readFileSync(path, "utf8"),
    appendFile: (path, text) => appendFileSync(path, text),
    log: (text) => process.stdout.write(text),
  });
}
