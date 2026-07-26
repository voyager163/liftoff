export const telemetrySchemaVersion = 1 as const;
export const telemetryEventName = 'command_executed' as const;
export const telemetryNoticeVersion = 1 as const;
export const telemetryClientFields = [
  'schemaVersion',
  'event',
  'command',
  'cliVersion',
  'outcome'
] as const;
export const telemetryStorageFields = [
  'TimeGenerated',
  'EventName',
  'SchemaVersion',
  'Command',
  'CliVersion',
  'Outcome'
] as const;

export const telemetryCommands = [
  'help',
  'version',
  'init',
  'plan',
  'patterns',
  'providers',
  'regions',
  'regions:search',
  'validate',
  'update',
  'migrate',
  'doctor',
  'dev',
  'dev:up',
  'dev:down',
  'dev:logs',
  'dev:reset',
  'infra',
  'infra:init',
  'infra:plan',
  'infra:apply',
  'infra:output'
] as const;

export type TelemetryCommand = (typeof telemetryCommands)[number];
export type TelemetryOutcome = 'success' | 'failure';

export interface TelemetryEvent {
  schemaVersion: typeof telemetrySchemaVersion;
  event: typeof telemetryEventName;
  command: TelemetryCommand;
  cliVersion: string;
  outcome: TelemetryOutcome;
}

export interface TelemetryStorageRecord {
  TimeGenerated: string;
  EventName: typeof telemetryEventName;
  SchemaVersion: typeof telemetrySchemaVersion;
  Command: TelemetryCommand;
  CliVersion: string;
  Outcome: TelemetryOutcome;
}

export interface TelemetryCommandInput {
  command?: string;
  subcommand?: string;
  flags: Readonly<Record<string, unknown>>;
}

const telemetryCommandSet: ReadonlySet<string> = new Set(telemetryCommands);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isTelemetryCommand(value: unknown): value is TelemetryCommand {
  return typeof value === 'string' && telemetryCommandSet.has(value);
}

export function isSemanticVersion(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = semverPattern.exec(value);
  if (!match) {
    return false;
  }
  const prerelease = match[4];
  return prerelease === undefined || prerelease
    .split('.')
    .every((identifier) => !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'));
}

export function canonicalTelemetryCommand(input: TelemetryCommandInput): TelemetryCommand | undefined {
  if (
    input.command === undefined ||
    input.command === 'help' ||
    input.command === '--help' ||
    input.flags.help === true
  ) {
    return 'help';
  }

  const candidate = input.subcommand
    ? `${input.command}:${input.subcommand}`
    : input.command;
  return isTelemetryCommand(candidate) ? candidate : undefined;
}

export function createTelemetryEvent(
  command: TelemetryCommand,
  cliVersion: string,
  exitCode: number
): TelemetryEvent {
  return {
    schemaVersion: telemetrySchemaVersion,
    event: telemetryEventName,
    command,
    cliVersion,
    outcome: exitCode === 0 ? 'success' : 'failure'
  };
}

export function createTelemetryStorageRecord(
  event: TelemetryEvent,
  generatedAt: Date
): TelemetryStorageRecord {
  return {
    TimeGenerated: generatedAt.toISOString(),
    EventName: event.event,
    SchemaVersion: event.schemaVersion,
    Command: event.command,
    CliVersion: event.cliVersion,
    Outcome: event.outcome
  };
}
