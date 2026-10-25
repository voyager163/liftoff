#!/usr/bin/env node
import { REGISTRY } from "./registry.ts";
import { runCli } from "./run.ts";
import { VERSION } from "./version.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
  },
  REGISTRY,
  VERSION,
);
process.exitCode = exitCode;
