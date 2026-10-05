export const telemetrySchemaVersion = 1 as const;
export const telemetrySemanticSchemaVersion = 2 as const;
export const projectTelemetrySchemaVersion = 2 as const;
export const telemetryEventName = 'command_executed' as const;
export const projectTelemetryEventName = 'project_observed' as const;
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
export const projectTelemetryClientFields = [
  'schemaVersion',
  'event',
  'projectId',
  'cliVersion',
  'policyProfile',
  'policyVersion',
  'templateSetDigest',
  'source'
] as const;
export const projectTelemetryStorageFields = [
  'TimeGenerated',
  'EventName',
  'SchemaVersion',
  'ProjectId',
  'CliVersion',
  'PolicyProfile',
  'PolicyVersion',
  'TemplateSetDigest',
  'Source'
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
  'repair',
  'upgrade',
  'migrate',
  'doctor',
  'governance',
  'governance:status',
  'governance:plan',
  'governance:approve',
  'governance:apply-next',
  'governance:credential-enroll',
  'governance:recover',
  'governance:resume',
  'governance:verify',
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

export const telemetryExcludedCommands = ['governance:assess', 'capabilities', 'assess'] as const;

export type TelemetryCommand = (typeof telemetryCommands)[number];
export type TelemetryOutcome = 'success' | 'failure';
export type TelemetrySemanticOutcome = TelemetryOutcome | 'attention-required' | 'cancelled';

export interface TelemetryEvent {
  schemaVersion: typeof telemetrySchemaVersion;
  event: typeof telemetryEventName;
  command: TelemetryCommand;
  cliVersion: string;
  outcome: TelemetryOutcome;
}

export interface SemanticTelemetryEvent extends Omit<TelemetryEvent, 'schemaVersion' | 'outcome'> {
  schemaVersion: typeof telemetrySemanticSchemaVersion;
  outcome: TelemetrySemanticOutcome;
}

export type TelemetryCommandEvent = TelemetryEvent | SemanticTelemetryEvent;

export type TelemetryStorageRecord = {
  TimeGenerated: string;
  EventName: typeof telemetryEventName;
  Command: TelemetryCommand;
  CliVersion: string;
} & (
  | { SchemaVersion: typeof telemetrySchemaVersion; Outcome: TelemetryOutcome }
  | { SchemaVersion: typeof telemetrySemanticSchemaVersion; Outcome: TelemetrySemanticOutcome }
);

export type ProjectTelemetryPolicy =
  | { policyProfile: 'none'; policyVersion: 'none' }
  | { policyProfile: 'single-maintainer-gitflow'; policyVersion: 6 | 7 }
  | { policyProfile: 'team-gitflow'; policyVersion: 1 };

export type ProjectTelemetryEvent = ProjectTelemetryPolicy & {
  schemaVersion: typeof projectTelemetrySchemaVersion;
  event: typeof projectTelemetryEventName;
  projectId: string;
  cliVersion: string;
  templateSetDigest: string;
  source: 'cli' | 'ci-heartbeat';
};

export interface ProjectTelemetryStorageRecord {
  TimeGenerated: string;
  EventName: typeof projectTelemetryEventName;
  SchemaVersion: typeof projectTelemetrySchemaVersion;
  ProjectId: string;
  CliVersion: string;
  PolicyProfile: ProjectTelemetryPolicy['policyProfile'];
  PolicyVersion: string;
  TemplateSetDigest: string;
  Source: ProjectTelemetryEvent['source'];
}

export interface TelemetryCommandInput {
  command?: string;
  subcommand?: string;
  positional?: readonly string[];
  flags: Readonly<Record<string, unknown>>;
}

const telemetryCommandSet: ReadonlySet<string> = new Set(telemetryCommands);
const telemetryCliVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)(?:\.(0|[1-9]\d*))?)?$/;

export function isTelemetryCommand(value: unknown): value is TelemetryCommand {
  return typeof value === 'string' && telemetryCommandSet.has(value);
}

export function isTelemetryCliVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 &&
    value.trim() === value && telemetryCliVersionPattern.test(value);
}

export function isTelemetrySemanticOutcome(value: unknown): value is TelemetrySemanticOutcome {
  return value === 'success' || value === 'attention-required' ||
    value === 'cancelled' || value === 'failure';
}

function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && fields.includes(key) &&
      descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

export function isTelemetryCommandEvent(value: unknown): value is TelemetryCommandEvent {
  return hasExactDataFields(value, telemetryClientFields) &&
    value.event === telemetryEventName && isTelemetryCommand(value.command) &&
    isTelemetryCliVersion(value.cliVersion) &&
    (value.schemaVersion === telemetrySchemaVersion
      ? value.outcome === 'success' || value.outcome === 'failure'
      : value.schemaVersion === telemetrySemanticSchemaVersion && isTelemetrySemanticOutcome(value.outcome));
}

export function isProjectTelemetryEvent(value: unknown): value is ProjectTelemetryEvent {
  return hasExactDataFields(value, projectTelemetryClientFields) &&
    value.schemaVersion === projectTelemetrySchemaVersion && value.event === projectTelemetryEventName &&
    isProjectTelemetryId(value.projectId) && isTelemetryCliVersion(value.cliVersion) &&
    parseProjectTelemetryPolicy(value.policyProfile, value.policyVersion) !== undefined &&
    isProjectTelemetryDigest(value.templateSetDigest) &&
    (value.source === 'cli' || value.source === 'ci-heartbeat');
}

export function isProjectTelemetryId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isProjectTelemetryDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 71 && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function parseProjectTelemetryPolicy(
  profile: unknown,
  version: unknown
): ProjectTelemetryPolicy | undefined {
  if (profile === 'none' && version === 'none') {
    return { policyProfile: profile, policyVersion: version };
  }
  if (profile === 'single-maintainer-gitflow' && (version === 6 || version === 7)) {
    return { policyProfile: profile, policyVersion: version };
  }
  if (profile === 'team-gitflow' && version === 1) {
    return { policyProfile: profile, policyVersion: version };
  }
  return undefined;
}

export function isTelemetryExcludedCommand(input: TelemetryCommandInput): boolean {
  if (input.command === 'help' && ['capabilities', 'assess'].includes(input.positional?.[0] ?? '')) return true;
  if (input.command === 'repair' &&
      ['capabilities', 'inspect-layout'].some((flag) => input.flags[flag] === true)) return true;
  const candidate = input.subcommand ? `${input.command}:${input.subcommand}` : input.command;
  return telemetryExcludedCommands.some((command) => command === candidate);
}

export function canonicalTelemetryCommand(input: TelemetryCommandInput): TelemetryCommand | undefined {
  if (isTelemetryExcludedCommand(input)) return undefined;
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
  event: TelemetryCommandEvent,
  generatedAt: Date
): TelemetryStorageRecord {
  const common = {
    TimeGenerated: generatedAt.toISOString(),
    EventName: event.event,
    SchemaVersion: event.schemaVersion,
    Command: event.command,
    CliVersion: event.cliVersion
  };
  if (event.schemaVersion === telemetrySchemaVersion) {
    return { ...common, SchemaVersion: telemetrySchemaVersion, Outcome: event.outcome };
  }
  return { ...common, SchemaVersion: telemetrySemanticSchemaVersion, Outcome: event.outcome };
}

export function createSemanticTelemetryEvent(
  command: TelemetryCommand,
  cliVersion: string,
  outcome: TelemetrySemanticOutcome
): SemanticTelemetryEvent {
  if (!isTelemetryCommand(command) || !isTelemetryCliVersion(cliVersion) || !isTelemetrySemanticOutcome(outcome)) {
    throw new TypeError('Invalid semantic telemetry event fields.');
  }
  return {
    schemaVersion: telemetrySemanticSchemaVersion,
    event: telemetryEventName,
    command,
    cliVersion,
    outcome
  };
}

export function createProjectTelemetryStorageRecord(
  event: ProjectTelemetryEvent,
  generatedAt: Date
): ProjectTelemetryStorageRecord {
  return {
    TimeGenerated: generatedAt.toISOString(),
    EventName: event.event,
    SchemaVersion: event.schemaVersion,
    ProjectId: event.projectId,
    CliVersion: event.cliVersion,
    PolicyProfile: event.policyProfile,
    PolicyVersion: String(event.policyVersion),
    TemplateSetDigest: event.templateSetDigest,
    Source: event.source
  };
}
