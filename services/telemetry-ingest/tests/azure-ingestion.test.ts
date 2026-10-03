import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  azureMonitorScope,
  createAzureTelemetryIngestionDependencies,
  handleProjectTelemetryRequest,
  handleTelemetryRequest,
  type AzureTelemetryIngestionConfig
} from '../src/handler.js';
import {
  telemetryStorageFields,
  projectTelemetryStorageFields,
  type ProjectTelemetryStorageRecord,
  type TelemetryStorageRecord
} from '../../../src/telemetry/contract.js';
import { silenceConsole, streamedRequest, validEvent, validRecord } from './support/fixtures.js';

// Offline stand-ins for the Azure SDK: no managed-identity endpoint, credential or
// Logs Ingestion request is ever contacted from these tests.
const azure = vi.hoisted(() => {
  const state = {
    credentials: [] as object[],
    credentialOptions: [] as unknown[],
    clients: [] as Array<{ endpoint: string; credential: unknown }>,
    getToken: vi.fn<(scopes: string | string[]) => Promise<{ token: string; expiresOnTimestamp: number } | null>>(),
    upload: vi.fn<(ruleId: string, streamName: string, logs: Record<string, unknown>[]) => Promise<void>>()
  };
  class ManagedIdentityCredential {
    constructor(options: unknown) {
      state.credentials.push(this);
      state.credentialOptions.push(options);
    }

    getToken(scopes: string | string[]) {
      return state.getToken(scopes);
    }
  }
  class LogsIngestionClient {
    constructor(endpoint: string, credential: unknown) {
      state.clients.push({ endpoint, credential });
    }

    upload(ruleId: string, streamName: string, logs: Record<string, unknown>[]) {
      return state.upload(ruleId, streamName, logs);
    }
  }
  return { state, ManagedIdentityCredential, LogsIngestionClient };
});

vi.mock('@azure/identity', () => ({ ManagedIdentityCredential: azure.ManagedIdentityCredential }));
vi.mock('@azure/monitor-ingestion', () => ({ LogsIngestionClient: azure.LogsIngestionClient }));

const config: AzureTelemetryIngestionConfig = {
  endpoint: 'https://liftoff-gateway-test.invalid',
  dcrImmutableId: 'dcr-00000000000000000000000000000000',
  streamName: 'Custom-LiftoffCommandEvents',
  managedIdentityClientId: '00000000-0000-0000-0000-000000000000'
};

beforeEach(() => {
  azure.state.credentials.length = 0;
  azure.state.credentialOptions.length = 0;
  azure.state.clients.length = 0;
  azure.state.getToken.mockResolvedValue({
    token: 'synthetic-test-token',
    expiresOnTimestamp: Date.now() + 3_600_000
  });
  azure.state.upload.mockResolvedValue(undefined);
});

describe('Azure managed-identity ingestion dependencies', () => {
  it('binds one user-assigned managed identity to one Logs Ingestion client without contacting Azure', () => {
    createAzureTelemetryIngestionDependencies(config);
    expect(azure.state.credentialOptions).toEqual([{ clientId: config.managedIdentityClientId }]);
    expect(azure.state.clients).toEqual([
      { endpoint: config.endpoint, credential: azure.state.credentials[0] }
    ]);
    expect(azure.state.getToken).not.toHaveBeenCalled();
    expect(azure.state.upload).not.toHaveBeenCalled();
  });

  it('warms up by acquiring exactly the Azure Monitor scope', async () => {
    const deps = createAzureTelemetryIngestionDependencies(config);
    await expect(deps.warmUp()).resolves.toBeUndefined();
    expect(azure.state.getToken).toHaveBeenCalledOnce();
    expect(azure.state.getToken).toHaveBeenCalledWith(azureMonitorScope);
  });

  it('fails warm-up when the managed identity returns no token', async () => {
    azure.state.getToken.mockResolvedValue(null);
    await expect(createAzureTelemetryIngestionDependencies(config).warmUp()).rejects.toThrow(
      'Unable to acquire the Azure Monitor managed-identity token.'
    );
  });

  it('propagates managed-identity failures unchanged', async () => {
    const unavailable = Object.assign(
      new Error('ManagedIdentityCredential: no managed identity endpoint is available.'),
      { name: 'CredentialUnavailableError' }
    );
    azure.state.getToken.mockRejectedValue(unavailable);
    await expect(createAzureTelemetryIngestionDependencies(config).warmUp()).rejects.toBe(unavailable);
  });

  it('uploads exactly the six approved columns as one record to the configured rule and stream', async () => {
    const deps = createAzureTelemetryIngestionDependencies(config);
    const withTransportMetadata = {
      ...validRecord,
      SourceAddress: '203.0.113.7',
      UserAgent: 'liftoff/0.6.1'
    };

    await deps.upload(withTransportMetadata);
    expect(azure.state.upload).toHaveBeenCalledOnce();
    const [ruleId, streamName, logs] = azure.state.upload.mock.calls[0];
    expect(ruleId).toBe(config.dcrImmutableId);
    expect(streamName).toBe(config.streamName);
    expect(logs).toEqual([validRecord]);
    expect(Object.keys(logs[0])).toEqual([...telemetryStorageFields]);
  });

  it('propagates upload rejection, which the handler reports as 503 without detail', async () => {
    const output = silenceConsole();
    const rejection = new Error('Logs Ingestion rejected the batch for dcr-00000000000000000000000000000000.');
    azure.state.upload.mockRejectedValue(rejection);
    const deps = createAzureTelemetryIngestionDependencies(config);

    await expect(deps.upload(validRecord)).rejects.toBe(rejection);
    expect(await handleTelemetryRequest(streamedRequest([JSON.stringify(validEvent)]), deps))
      .toEqual({ status: 503 });
    expect(azure.state.upload).toHaveBeenCalledTimes(2);
    output.expectNothingLogged();
  });

  it('stamps records with the current server time', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-24T12:34:56.789Z') });
    try {
      const deps = createAzureTelemetryIngestionDependencies(config);
      expect(deps.now().toISOString()).toBe('2026-09-24T12:34:56.789Z');
      expect(await handleTelemetryRequest(streamedRequest([JSON.stringify(validEvent)]), deps))
        .toEqual({ status: 204 });
      expect(azure.state.upload.mock.calls[0][2]).toEqual([
        { ...validRecord, TimeGenerated: '2026-09-24T12:34:56.789Z' }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not enable project ingestion without its explicit stream', () => {
    expect(createAzureTelemetryIngestionDependencies(config).uploadProject).toBeUndefined();
    expect(() => createAzureTelemetryIngestionDependencies({
      ...config, projectStreamName: config.streamName
    })).toThrow('Project telemetry ingestion requires the approved project event stream.');
    expect(() => createAzureTelemetryIngestionDependencies({
      ...config, streamName: 'Custom-LiftoffProjectEvents'
    })).toThrow('Command telemetry ingestion requires the approved command event stream.');
  });

  it('uploads project data only to its distinct stream and nine-column projection', async () => {
    const deps = createAzureTelemetryIngestionDependencies({
      ...config, projectStreamName: 'Custom-LiftoffProjectEvents'
    });
    const record: ProjectTelemetryStorageRecord = {
      TimeGenerated: '2026-09-30T00:00:00.000Z', EventName: 'project_observed', SchemaVersion: 2,
      ProjectId: '550e8400-e29b-41d4-a716-446655440000', CliVersion: '0.12.3',
      PolicyProfile: 'none', PolicyVersion: 'none',
      TemplateSetDigest: `sha256:${'a'.repeat(64)}`, Source: 'ci-heartbeat'
    };
    if (!deps.uploadProject) throw new Error('Expected explicitly enabled project ingestion.');
    const withTransportMetadata = { ...record, SourceAddress: '203.0.113.7' };
    await deps.uploadProject(withTransportMetadata);
    expect(azure.state.upload).toHaveBeenCalledExactlyOnceWith(
      config.dcrImmutableId, 'Custom-LiftoffProjectEvents', [record]
    );
    expect(Object.keys(azure.state.upload.mock.calls[0][2][0])).toEqual([...projectTelemetryStorageFields]);
  });

  it('reports actual project upload failure as unavailable without exposing details', async () => {
    const output = silenceConsole();
    const deps = createAzureTelemetryIngestionDependencies({
      ...config, projectStreamName: 'Custom-LiftoffProjectEvents'
    });
    azure.state.upload.mockRejectedValue(new Error('private ingestion failure'));
    const event = {
      schemaVersion: 2, event: 'project_observed',
      projectId: '550e8400-e29b-41d4-a716-446655440000', cliVersion: '0.12.3',
      policyProfile: 'team-gitflow', policyVersion: 1,
      templateSetDigest: `sha256:${'a'.repeat(64)}`, source: 'cli'
    };
    expect(await handleProjectTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
      .toEqual({ status: 503 });
    expect(azure.state.upload).toHaveBeenCalledOnce();
    expect(azure.state.upload.mock.calls[0][1]).toBe('Custom-LiftoffProjectEvents');
    output.expectNothingLogged();
  });
});
