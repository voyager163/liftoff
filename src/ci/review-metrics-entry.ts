// Entry point for the bundled review metrics (.github/liftoff/review-metrics.mjs).
import { appendFileSync } from "node:fs";
import { main } from "./review-metrics.ts";

process.exitCode = await main({
  env: process.env,
  appendFile: (path, text) => appendFileSync(path, text),
  log: (text) => process.stdout.write(text),
  now: () => Date.now(),
});
