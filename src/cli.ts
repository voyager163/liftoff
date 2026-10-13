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
  isTelemetryEnabled,
  reportCommandEvent,
  telemetryCommandFor
} from './telemetry/index.js';
import { PresentationSession } from './terminal.js';
import type { ParsedArgs } from './domain/project/contracts.js';
import { liftoffVersion } from './version.js';
import { isTelemetryExcludedCommand, createSemanticTelemetryEvent, type SemanticTelemetryEvent } from './telemetry/contract.js';
import { createCommandOutcome } from './application/command-outcome.js';
import { createTelemetryDelivery, type TelemetryDelivery } from './telemetry/delivery.js';
import { reportOrdinaryProject } from './application/telemetry/project-reporting.js';

export interface CliTelemetryHooks {
  beforeCommand(stderr: NodeJS.WritableStream, env: NodeJS.ProcessEnv): Promise<boolean>;
  afterCommand(parsed: ParsedArgs, exitCode: number, env: NodeJS.ProcessEnv): Promise<void>;
  afterSemanticCommand?(event: SemanticTelemetryEvent, env: NodeJS.ProcessEnv): Promise<void>;
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

function createDefaultTelemetryHooks(delivery: () => TelemetryDelivery | undefined): CliTelemetryHooks {
  return {
    beforeCommand: (stderr, env) => maybeShowTelemetryNotice({ stderr, env }),
    afterCommand: async () => undefined,
    afterSemanticCommand: async (event, env) => {
      await reportCommandEvent(event, { env, delivery: delivery() });
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

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const runtimeError = options.runtimeError ?? nodeRuntimeError;
  const parse = options.parse ?? parseArgs;
  const execute = options.execute ?? runCommand;
  let delivery: TelemetryDelivery | undefined;
  const telemetry = options.telemetry ?? createDefaultTelemetryHooks(() => delivery);

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

  const telemetryReady = isTelemetryEnabled(env) && !isTelemetryExcludedCommand(parsed) && await safelyPrepareTelemetry(
    () => telemetry.beforeCommand(stderr, env)
  );

  let exitCode: number;
  const outcome = createCommandOutcome();
  try {
    exitCode = await execute(parsed, {
      outcome,
      cwd: options.cwd ?? process.cwd(),
      stdin: options.stdin ?? process.stdin,
      stdout,
      stderr,
      env
    });
  } catch (error) {
    outcome.record('failure');
    renderEntrypointError(error, stdout, stderr);
    exitCode = 1;
  }
  if (telemetryReady && isTelemetryEnabled(env)) delivery = createTelemetryDelivery({ env });
  const semanticOutcome = outcome.finish(exitCode);
  const semanticCommand = telemetryCommandFor(parsed);

  if (delivery) {
    const activeDelivery = delivery;
    try {
      await activeDelivery.withinBudget(() => telemetry.afterCommand(parsed, exitCode, env));
      await activeDelivery.withinBudget(async () => {
        await Promise.all([
          telemetry.afterSemanticCommand && semanticCommand && isTelemetryEnabled(env)
            ? telemetry.afterSemanticCommand(
                Object.freeze(createSemanticTelemetryEvent(semanticCommand, liftoffVersion, semanticOutcome)), env
              ) : undefined,
          !options.telemetry ? reportOrdinaryProject(parsed, options.cwd ?? process.cwd(), env, activeDelivery) : undefined
        ]);
      });
    } finally {
      activeDelivery.close();
    }
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