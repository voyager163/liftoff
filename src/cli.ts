#!/usr/bin/env node
import { parseArgs } from './args.js';
import { runCommand } from './commands.js';
import { nodeRuntimeError } from './runtime.js';
import { PresentationSession } from './terminal.js';

try {
  const runtimeError = nodeRuntimeError();
  if (runtimeError) {
    throw new Error(runtimeError);
  }
  const parsed = parseArgs(process.argv.slice(2));
  process.exitCode = await runCommand(parsed, {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  });
} catch (error) {
  const presentation = new PresentationSession({
    stdout: process.stdout,
    stderr: process.stderr
  });
  presentation.error(
    error instanceof Error ? error.message : String(error),
    'Run `liftoff help` to review accepted commands and options.'
  );
  process.exitCode = 1;
}