#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli/args/parser.js';
import { runCommand } from './cli/commands/dispatch.js';
import type { CommandContext } from './application/context.js';
import { nodeRuntimeError } from './runtime.js';
import {
  maybeShowTelemetryNotice,
  telemetryCommandFor,
  trackCommand
} from './telemetry/index.js';
import { PresentationSession } from './terminal.js';
import type { ParsedArgs } from './domain/project/contracts.js';
import { liftoffVersion } from './version.js';
import { canPersistTelemetryNotice, type TelemetryCommand } from './telemetry/contract.js';
import { hasUsableApprovalTerminal } from './application/update/approval.js';

export interface CliTelemetryHooks {
  beforeCommand(
    stderr: NodeJS.WritableStream,
    env: NodeJS.ProcessEnv,
    policy: { persistNotice: boolean }
  ): Promise<boolean>;
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

function defaultTelemetryHooks(command: TelemetryCommand | undefined): CliTelemetryHooks {
  return {
    beforeCommand: (stderr, env, policy) => maybeShowTelemetryNotice({ stderr, env, ...policy }),
    afterCommand: async (_parsed, exitCode, env) => {
      if (command) {
        await trackCommand(command, liftoffVersion, exitCode, { env });
      }
    }
  };
}

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
  const stdin = options.stdin ?? process.stdin;
  const env = options.env ?? process.env;
  const runtimeError = options.runtimeError ?? nodeRuntimeError;
  const parse = options.parse ?? parseArgs;
  const execute = options.execute ?? runCommand;

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

  const interactive = hasUsableApprovalTerminal({ stdin, stderr });
  const command = telemetryCommandFor(parsed, interactive);
  const telemetry = options.telemetry ?? defaultTelemetryHooks(command);
  const telemetryReady = command !== undefined && await safelyPrepareTelemetry(
    () => telemetry.beforeCommand(stderr, env, {
      persistNotice: canPersistTelemetryNotice({ ...parsed, interactive })
    })
  );

  let exitCode: number;
  try {
    exitCode = await execute(parsed, {
      cwd: options.cwd ?? process.cwd(),
      stdin,
      stdout,
      stderr,
      env
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