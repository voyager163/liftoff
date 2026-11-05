// Entry point for the bundled review-policy check (.github/liftoff/review-policy.mjs).
import { appendFileSync, readFileSync } from "node:fs";
import { main } from "./review-policy-check.ts";

process.exitCode = await main({
  env: process.env,
  readFile: (path) => readFileSync(path, "utf8"),
  appendFile: (path, text) => appendFileSync(path, text),
  log: (text) => process.stdout.write(text),
});
