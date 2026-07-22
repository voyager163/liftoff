#!/usr/bin/env node
import { parseArgs } from './args.js';
import { runCommand } from './commands.js';

try {
  const parsed = parseArgs(process.argv.slice(2));
  process.exitCode = await runCommand(parsed, {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}