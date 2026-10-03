import { ManagedIdentityCredential } from '@azure/identity';
import { LogsIngestionClient } from '@azure/monitor-ingestion';
import {
  createProjectTelemetryStorageRecord,
  createTelemetryStorageRecord,
  isProjectTelemetryDigest,
  isProjectTelemetryId,
  isTelemetryCommand,
  isTelemetryCliVersion,
  isTelemetrySemanticOutcome,
  parseProjectTelemetryPolicy,
  projectTelemetryClientFields,
  projectTelemetryEventName,
  projectTelemetrySchemaVersion,
  telemetryClientFields,
  telemetryEventName,
  telemetrySchemaVersion,
  telemetrySemanticSchemaVersion,
  type ProjectTelemetryEvent,
  type ProjectTelemetryStorageRecord,
  type TelemetryCommandEvent,
  type TelemetryStorageRecord
} from '../../../src/telemetry/contract.js';

export const maximumTelemetryBodyBytes = 1_024;

export interface TelemetryHttpRequest {
  method: string;
  headers: Pick<Headers, 'get'>;
  body: AsyncIterable<unknown>;
}

export interface TelemetryHttpResponse {
  status: number;
}

export interface TelemetryIngestionDependencies {
  now(): Date;
  upload(record: TelemetryStorageRecord): Promise<void>;
  uploadProject?(record: ProjectTelemetryStorageRecord): Promise<void>;
}

export interface AzureTelemetryIngestionConfig {
  endpoint: string;
  dcrImmutableId: string;
  streamName: string;
  projectStreamName?: string;
  managedIdentityClientId: string;
}

export const azureMonitorScope = 'https://monitor.azure.com/.default';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTelemetryEvent(value: unknown): TelemetryCommandEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== telemetryClientFields.length ||
    !keys.every((key) => telemetryClientFields.includes(key as (typeof telemetryClientFields)[number]))
  ) {
    return undefined;
  }
  if (
    value.event !== telemetryEventName ||
    !isTelemetryCommand(value.command) ||
    !isTelemetryCliVersion(value.cliVersion)
  ) {
    return undefined;
  }
  if (
    value.schemaVersion === telemetrySchemaVersion &&
    (value.outcome === 'success' || value.outcome === 'failure')
  ) {
    return {
      schemaVersion: value.schemaVersion, event: value.event,
      command: value.command, cliVersion: value.cliVersion, outcome: value.outcome
    };
  }
  if (
    value.schemaVersion === telemetrySemanticSchemaVersion &&
    isTelemetrySemanticOutcome(value.outcome)
  ) {
    return {
      schemaVersion: value.schemaVersion, event: value.event,
      command: value.command, cliVersion: value.cliVersion, outcome: value.outcome
    };
  }
  return undefined;
}

export function parseProjectTelemetryEvent(value: unknown): ProjectTelemetryEvent | undefined {
  if (!isRecord(value)) return undefined;
  const fields: readonly string[] = projectTelemetryClientFields;
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) return undefined;
  const policy = parseProjectTelemetryPolicy(value.policyProfile, value.policyVersion);
  if (
    !policy ||
    value.schemaVersion !== projectTelemetrySchemaVersion ||
    value.event !== projectTelemetryEventName ||
    !isProjectTelemetryId(value.projectId) ||
    !isTelemetryCliVersion(value.cliVersion) ||
    !isProjectTelemetryDigest(value.templateSetDigest) ||
    (value.source !== 'cli' && value.source !== 'ci-heartbeat')
  ) return undefined;
  return {
    schemaVersion: value.schemaVersion,
    event: value.event,
    projectId: value.projectId,
    cliVersion: value.cliVersion,
    ...policy,
    templateSetDigest: value.templateSetDigest,
    source: value.source
  };
}

function contentLength(headers: Pick<Headers, 'get'>): number | undefined {
  const raw = headers.get('content-length');
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

type BodyReadResult =
  | { status: 'ok'; body: string }
  | { status: 'invalid' }
  | { status: 'too-large' };

function bodyChunk(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  return undefined;
}

async function readBoundedBody(request: TelemetryHttpRequest): Promise<BodyReadResult> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let body = '';
  try {
    for await (const value of request.body) {
      const bytes = bodyChunk(value);
      if (!bytes) {
        return { status: 'invalid' };
      }
      bytesRead += bytes.byteLength;
      if (bytesRead > maximumTelemetryBodyBytes) {
        return { status: 'too-large' };
      }
      body += decoder.decode(bytes, { stream: true });
    }
    body += decoder.decode();
    return { status: 'ok', body };
  } catch {
    return { status: 'invalid' };
  }
}

async function handleEventRequest<Event>(
  request: TelemetryHttpRequest,
  parseEvent: (value: unknown) => Event | undefined,
  upload: (event: Event) => Promise<void>
): Promise<TelemetryHttpResponse> {
  if (request.method.toUpperCase() !== 'POST') {
    return { status: 405 };
  }

  const contentType = request.headers.get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return { status: 415 };
  }
  if ((contentLength(request.headers) ?? 0) > maximumTelemetryBodyBytes) {
    return { status: 413 };
  }

  const bodyResult = await readBoundedBody(request);
  if (bodyResult.status === 'too-large') {
    return { status: 413 };
  }
  if (bodyResult.status === 'invalid') {
    return { status: 400 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.body) as unknown;
  } catch {
    return { status: 400 };
  }
  const event = parseEvent(parsed);
  if (!event) {
    return { status: 400 };
  }

  try {
    await upload(event);
  } catch {
    return { status: 503 };
  }
  return { status: 204 };
}

export function handleTelemetryRequest(
  request: TelemetryHttpRequest,
  dependencies: TelemetryIngestionDependencies
): Promise<TelemetryHttpResponse> {
  return handleEventRequest(request, parseTelemetryEvent, (event) =>
    dependencies.upload(createTelemetryStorageRecord(event, dependencies.now())));
}

export function handleProjectTelemetryRequest(
  request: TelemetryHttpRequest,
  dependencies: TelemetryIngestionDependencies
): Promise<TelemetryHttpResponse> {
  return handleEventRequest(request, parseProjectTelemetryEvent, async (event) => {
    if (!dependencies.uploadProject) throw new Error('Project telemetry ingestion is disabled.');
    await dependencies.uploadProject(createProjectTelemetryStorageRecord(event, dependencies.now()));
  });
}

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required telemetry ingestion setting: ${name}`);
  }
  return value;
}

export function readAzureTelemetryIngestionConfig(
  env: NodeJS.ProcessEnv = process.env
): AzureTelemetryIngestionConfig {
  const endpoint = requiredEnvironmentValue(env, 'TELEMETRY_DCE_ENDPOINT');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw new Error('TELEMETRY_DCE_ENDPOINT must use HTTPS.');
  }
  const streamName = requiredEnvironmentValue(env, 'TELEMETRY_STREAM_NAME');
  if (streamName !== 'Custom-LiftoffCommandEvents') {
    throw new Error('TELEMETRY_STREAM_NAME must name the approved command event stream.');
  }
  const projectStreamName = env.TELEMETRY_PROJECT_STREAM_NAME;
  if (projectStreamName !== undefined && projectStreamName.trim() !== 'Custom-LiftoffProjectEvents') {
    throw new Error('TELEMETRY_PROJECT_STREAM_NAME must name the approved project event stream.');
  }
  return {
    endpoint: url.toString().replace(/\/$/, ''),
    dcrImmutableId: requiredEnvironmentValue(env, 'TELEMETRY_DCR_IMMUTABLE_ID'),
    streamName,
    ...(projectStreamName === undefined ? {} : { projectStreamName: projectStreamName.trim() }),
    managedIdentityClientId: requiredEnvironmentValue(env, 'AZURE_CLIENT_ID')
  };
}

export function createAzureTelemetryIngestionDependencies(
  config: AzureTelemetryIngestionConfig
): TelemetryIngestionDependencies & { warmUp(): Promise<void> } {
  if (config.streamName !== 'Custom-LiftoffCommandEvents') {
    throw new Error('Command telemetry ingestion requires the approved command event stream.');
  }
  const projectStreamName = config.projectStreamName;
  if (projectStreamName !== undefined && projectStreamName !== 'Custom-LiftoffProjectEvents') {
    throw new Error('Project telemetry ingestion requires the approved project event stream.');
  }
  const credential = new ManagedIdentityCredential({ clientId: config.managedIdentityClientId });
  const client = new LogsIngestionClient(config.endpoint, credential);
  return {
    warmUp: async () => {
      const token = await credential.getToken(azureMonitorScope);
      if (!token) {
        throw new Error('Unable to acquire the Azure Monitor managed-identity token.');
      }
    },
    now: () => new Date(),
    upload: async (record) => {
      const azureRecord: Record<string, unknown> = {
        TimeGenerated: record.TimeGenerated,
        EventName: record.EventName,
        SchemaVersion: record.SchemaVersion,
        Command: record.Command,
        CliVersion: record.CliVersion,
        Outcome: record.Outcome
      };
      await client.upload(config.dcrImmutableId, config.streamName, [azureRecord]);
    },
    ...(projectStreamName === undefined ? {} : {
      uploadProject: async (record: ProjectTelemetryStorageRecord) => {
        const azureRecord: Record<string, unknown> = {
          TimeGenerated: record.TimeGenerated,
          EventName: record.EventName,
          SchemaVersion: record.SchemaVersion,
          ProjectId: record.ProjectId,
          CliVersion: record.CliVersion,
          PolicyProfile: record.PolicyProfile,
          PolicyVersion: record.PolicyVersion,
          TemplateSetDigest: record.TemplateSetDigest,
          Source: record.Source
        };
        await client.upload(config.dcrImmutableId, projectStreamName, [azureRecord]);
      }
    })
  };
}
