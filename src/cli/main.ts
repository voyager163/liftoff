#!/usr/bin/env node
import { REGISTRY } from "./registry.ts";
import { runCli } from "./run.ts";
import { terminalPrompts } from "./terminal.ts";
import { VERSION } from "./version.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

// No top-level await: the native launcher loads this module with require().
void runCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ...terminalPrompts(controller.signal),
  },
  REGISTRY,
  VERSION,
).then((exitCode) => {
  process.exitCode = exitCode;
});
