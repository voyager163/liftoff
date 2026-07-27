#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';
import { runCommand, type CommandContext } from './commands.js';
import { nodeRuntimeError } from './runtime.js';
import {
  maybeShowTelemetryNotice,
  telemetryCommandFor,
  trackCommand
} from './telemetry/index.js';
import { PresentationSession } from './terminal.js';
import type { ParsedArgs } from './types.js';
import { liftoffVersion } from './version.js';

export interface CliTelemetryHooks {
  beforeCommand(stderr: NodeJS.WritableStream, env: NodeJS.ProcessEnv): Promise<boolean>;
  afterCommand(parsed: ParsedArgs, exitCode: number, env: NodeJS.ProcessEnv): Promise<void>;
}

export interface RunCliOptions {
  argv?: string[];
  cwd?: string;
  stdin?: Readable;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  runtimeError?: () => string | undefined;
  parse?: typeof parseArgs;
  execute?: (parsed: ParsedArgs, context: CommandContext) => Promise<number>;
  telemetry?: CliTelemetryHooks;
}

const defaultTelemetryHooks: CliTelemetryHooks = {
  beforeCommand: (stderr, env) => maybeShowTelemetryNotice({ stderr, env }),
  afterCommand: async (parsed, exitCode, env) => {
    const command = telemetryCommandFor(parsed);
    if (command) {
      await trackCommand(command, liftoffVersion, exitCode, { env });
    }
  }
};

function renderEntrypointError(
  error: unknown,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): void {
  const presentation = new PresentationSession({
    stdout,
    stderr
  });
  presentation.error(
    error instanceof Error ? error.message : String(error),
    'Run `liftoff help` to review accepted commands and options.'
  );
}

async function safelyPrepareTelemetry(action: () => Promise<boolean>): Promise<boolean> {
  try {
    return await action();
  } catch {
    // Telemetry hooks are isolated from CLI behavior.
    return false;
  }
}

async function safelyRunTelemetry(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Telemetry hooks are isolated from CLI behavior.
  }
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const runtimeError = options.runtimeError ?? nodeRuntimeError;
  const parse = options.parse ?? parseArgs;
  const execute = options.execute ?? runCommand;
  const telemetry = options.telemetry ?? defaultTelemetryHooks;

  let parsed: ParsedArgs;
  try {
    const error = runtimeError();
    if (error) {
      throw new Error(error);
    }
    parsed = parse(options.argv ?? process.argv.slice(2));
  } catch (error) {
    renderEntrypointError(error, stdout, stderr);
    return 1;
  }

  const telemetryReady = await safelyPrepareTelemetry(
    () => telemetry.beforeCommand(stderr, env)
  );

  let exitCode: number;
  try {
    exitCode = await execute(parsed, {
      cwd: options.cwd ?? process.cwd(),
      stdin: options.stdin ?? process.stdin,
      stdout,
      stderr
    });
  } catch (error) {
    renderEntrypointError(error, stdout, stderr);
    exitCode = 1;
  }

  if (telemetryReady) {
    await safelyRunTelemetry(() => telemetry.afterCommand(parsed, exitCode, env));
  }
  return exitCode;
}

function canonicalEntrypointPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

if (
  process.argv[1] &&
  canonicalEntrypointPath(process.argv[1]) === canonicalEntrypointPath(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCli();
}