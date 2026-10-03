import { describe, expect, it, vi } from 'vitest';
import {
  createProjectTelemetryStorageRecord,
  createSemanticTelemetryEvent,
  createTelemetryEvent,
  createTelemetryStorageRecord,
  isProjectTelemetryDigest,
  isProjectTelemetryId,
  isTelemetryCliVersion,
  projectTelemetryClientFields,
  projectTelemetryStorageFields,
  telemetryCommands,
  type ProjectTelemetryEvent,
  type ProjectTelemetryStorageRecord,
  type TelemetrySemanticOutcome
} from '../../../src/telemetry/contract.js';
import {
  handleProjectTelemetryRequest,
  handleTelemetryRequest,
  parseProjectTelemetryEvent,
  parseTelemetryEvent,
  readAzureTelemetryIngestionConfig
} from '../src/handler.js';
import {
  closeTelemetryServer,
  createTelemetryServer,
  listenTelemetryServer,
  projectTelemetryRoute,
  telemetryRoute
} from '../src/server.js';
import {
  fixedNow,
  recordingDependencies,
  silenceConsole,
  streamedRequest,
  validEvent
} from './support/fixtures.js';

const project: ProjectTelemetryEvent = {
  schemaVersion: 2,
  event: 'project_observed',
  projectId: '550e8400-e29b-41d4-a716-446655440000',
  cliVersion: '0.12.3',
  policyProfile: 'single-maintainer-gitflow',
  policyVersion: 6,
  templateSetDigest: `sha256:${'a'.repeat(64)}`,
  source: 'cli'
};

function dependencies() {
  return {
    ...recordingDependencies(),
    uploadProject: vi.fn<(record: ProjectTelemetryStorageRecord) => Promise<void>>()
      .mockResolvedValue(undefined)
  };
}

describe('versioned command outcomes', () => {
  it.each<TelemetrySemanticOutcome>(['success', 'attention-required', 'cancelled', 'failure'])(
    'accepts explicit semantic %s for every allowlisted command without reclassifying by exit code',
    async (outcome) => {
      for (const command of telemetryCommands) {
        const event = createSemanticTelemetryEvent(command, '0.12.3', outcome);
        expect(parseTelemetryEvent(event)).toEqual(event);
        const deps = dependencies();
        expect(await handleTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
          .toEqual({ status: 204 });
        expect(deps.upload).toHaveBeenCalledExactlyOnceWith(createTelemetryStorageRecord(event, fixedNow));
        expect(deps.uploadProject).not.toHaveBeenCalled();
        expect(deps.upload.mock.calls[0][0]).toMatchObject({ SchemaVersion: 2, Outcome: outcome });
      }
    }
  );

  it('preserves legacy exit-two failure separately from expected attention and actual partial failure', () => {
    const legacy = createTelemetryEvent('update', '0.12.3', 2);
    expect(parseTelemetryEvent(legacy)).toEqual(legacy);
    expect(createTelemetryStorageRecord(legacy, fixedNow)).toMatchObject({ SchemaVersion: 1, Outcome: 'failure' });
    for (const outcome of ['attention-required', 'failure'] as const) {
      const semantic = createSemanticTelemetryEvent('update', '0.12.3', outcome);
      expect(createTelemetryStorageRecord(semantic, fixedNow)).toMatchObject({ SchemaVersion: 2, Outcome: outcome });
    }
    expect(parseTelemetryEvent({ ...legacy, outcome: 'attention-required' })).toBeUndefined();
    expect(parseTelemetryEvent({ ...legacy, outcome: 'cancelled' })).toBeUndefined();
  });

  it.each([0, 3, '2', null, undefined])('rejects unsupported command schema %j', (schemaVersion) => {
    expect(parseTelemetryEvent({ ...validEvent, schemaVersion })).toBeUndefined();
  });

  it.each(['pending', 'partial', 2, null, {}, 'attention-required/private-project'])(
    'rejects unsupported semantic outcome %j', (outcome) => {
      expect(parseTelemetryEvent({ ...validEvent, schemaVersion: 2, outcome })).toBeUndefined();
    }
  );

  it('bounds version length and rejects identifier-bearing build or arbitrary prerelease metadata', () => {
    expect(isTelemetryCliVersion(`${'1'.repeat(65)}.0.0`)).toBe(false);
    expect(isTelemetryCliVersion('0.13.0+private-project')).toBe(false);
    expect(isTelemetryCliVersion('0.13.0-private-project')).toBe(false);
  });
});

describe('project observation endpoint contract', () => {
  it.each([
    { policyProfile: 'none', policyVersion: 'none' },
    { policyProfile: 'single-maintainer-gitflow', policyVersion: 6 },
    { policyProfile: 'single-maintainer-gitflow', policyVersion: 7 },
    { policyProfile: 'team-gitflow', policyVersion: 1 }
  ])('accepts only the declared policy pair $policyProfile/$policyVersion', async (policy) => {
    for (const source of ['cli', 'ci-heartbeat'] as const) {
      const event = { ...project, ...policy, source };
      expect(parseProjectTelemetryEvent(event)).toEqual(event);
      const deps = dependencies();
      expect(await handleProjectTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
        .toEqual({ status: 204 });
      expect(deps.upload).not.toHaveBeenCalled();
      expect(deps.uploadProject).toHaveBeenCalledExactlyOnceWith({
        TimeGenerated: fixedNow.toISOString(), EventName: 'project_observed', SchemaVersion: 2,
        ProjectId: project.projectId, CliVersion: project.cliVersion,
        PolicyProfile: policy.policyProfile, PolicyVersion: String(policy.policyVersion),
        TemplateSetDigest: project.templateSetDigest, Source: source
      });
      expect(Object.keys(deps.uploadProject.mock.calls[0][0])).toEqual([...projectTelemetryStorageFields]);
      expect(Object.keys(event)).toEqual([...projectTelemetryClientFields]);
    }
  });

  it.each([
    ['legacy schema', { schemaVersion: 1 }],
    ['future schema', { schemaVersion: 3 }],
    ['string schema', { schemaVersion: '2' }],
    ['command event', { event: 'command_executed' }],
    ['missing identity', { projectId: undefined }],
    ['non-random UUID version', { projectId: '550e8400-e29b-11d4-a716-446655440000' }],
    ['invalid UUID variant', { projectId: '550e8400-e29b-41d4-0716-446655440000' }],
    ['URL identity', { projectId: 'https://github.com/private/repo' }],
    ['object identity', { projectId: {} }],
    ['noncanonical identity whitespace', { projectId: `${project.projectId}\n` }],
    ['numeric release', { cliVersion: 12 }],
    ['metadata-bearing release', { cliVersion: '0.12.3+secret' }],
    ['unknown policy', { policyProfile: 'private-team' }],
    ['unknown policy version', { policyVersion: 8 }],
    ['coerced version', { policyVersion: '6' }],
    ['mismatched team policy', { policyProfile: 'team-gitflow', policyVersion: 7 }],
    ['mismatched none policy', { policyProfile: 'none', policyVersion: 1 }],
    ['non-digest', { templateSetDigest: '/private/repository' }],
    ['short digest', { templateSetDigest: 'sha256:aa' }],
    ['noncanonical digest whitespace', { templateSetDigest: `${project.templateSetDigest}\n` }],
    ['noncanonical digest', { templateSetDigest: `sha256:${'A'.repeat(64)}` }],
    ['unknown source', { source: 'developer-name' }],
    ['null source', { source: null }]
  ])('rejects %s without upload or logging', async (_label, change) => {
    const output = silenceConsole();
    const deps = dependencies();
    const event = { ...project, ...change };
    expect(parseProjectTelemetryEvent(event)).toBeUndefined();
    expect(await handleProjectTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
      .toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.uploadProject).not.toHaveBeenCalled();
    output.expectNothingLogged();
  });

  it.each([
    'path', 'projectName', 'repository', 'url', 'timestamp', 'userId', 'deviceId',
    'ip', 'error', 'command', 'outcome', 'synthetic', '__proto__', 'constructor'
  ])('rejects the undeclared %s field', async (key) => {
    const deps = dependencies();
    const body = JSON.stringify({ ...project, [key]: 'not-allowed' });
    expect(await handleProjectTelemetryRequest(streamedRequest([body]), deps)).toEqual({ status: 400 });
    expect(deps.uploadProject).not.toHaveBeenCalled();
  });

  it.each([null, [], 1, true, 'project_observed'])('rejects non-object %j', (value) => {
    expect(parseProjectTelemetryEvent(value)).toBeUndefined();
  });

  it('rejects every missing field and keeps command and project endpoints distinct', async () => {
    const deps = dependencies();
    for (const missing of projectTelemetryClientFields) {
      const event = Object.fromEntries(Object.entries(project).filter(([key]) => key !== missing));
      expect(await handleProjectTelemetryRequest(streamedRequest([JSON.stringify(event)]), deps))
        .toEqual({ status: 400 });
    }
    expect(await handleTelemetryRequest(streamedRequest([JSON.stringify(project)]), deps)).toEqual({ status: 400 });
    expect(await handleProjectTelemetryRequest(streamedRequest([JSON.stringify(validEvent)]), deps))
      .toEqual({ status: 400 });
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.uploadProject).not.toHaveBeenCalled();
  });

  it('accepts exactly 1024 bytes, rejects 1025 and stops before another streamed chunk', async () => {
    const deps = dependencies();
    const body = JSON.stringify(project);
    const atLimit = body + ' '.repeat(1024 - Buffer.byteLength(body));
    expect(await handleProjectTelemetryRequest(streamedRequest([atLimit]), deps)).toEqual({ status: 204 });
    const oversized = streamedRequest([atLimit, ' ', 'do not read']);
    expect(await handleProjectTelemetryRequest(oversized, deps)).toEqual({ status: 413 });
    expect(oversized.chunksPulled).toBe(2);
    const declared = streamedRequest([body], { contentLength: '1025' });
    expect(await handleProjectTelemetryRequest(declared, deps)).toEqual({ status: 413 });
    expect(declared.chunksPulled).toBe(0);
    expect(deps.uploadProject).toHaveBeenCalledOnce();
  });

  it('rejects malformed UTF-8, JSON and chunks without upload', async () => {
    const deps = dependencies();
    for (const chunks of [[Uint8Array.of(0xff)], ['{invalid'], [''], [{}]]) {
      expect(await handleProjectTelemetryRequest(streamedRequest(chunks), deps)).toEqual({ status: 400 });
    }
    expect(deps.uploadProject).not.toHaveBeenCalled();
  });

  it('enforces method/media type before reading and counts multibyte input as bytes', async () => {
    const deps = dependencies();
    for (const [options, status] of [
      [{ method: 'GET' }, 405],
      [{ contentType: 'text/plain' }, 415]
    ] as const) {
      const incoming = streamedRequest([JSON.stringify(project)], options);
      expect(await handleProjectTelemetryRequest(incoming, deps)).toEqual({ status });
      expect(incoming.chunksPulled).toBe(0);
    }
    expect(await handleProjectTelemetryRequest(streamedRequest(['é'.repeat(513)]), deps)).toEqual({ status: 413 });
    expect(deps.uploadProject).not.toHaveBeenCalled();
  });

  it('reports disabled configuration, clock and upload failures without logging or command fallback', async () => {
    const output = silenceConsole();
    const deps = dependencies();
    const request = () => streamedRequest([JSON.stringify(project)]);
    expect(await handleProjectTelemetryRequest(request(), recordingDependencies())).toEqual({ status: 503 });
    expect(await handleProjectTelemetryRequest(request(), { ...deps, now: () => new Date(NaN) }))
      .toEqual({ status: 503 });
    deps.uploadProject.mockRejectedValue(new Error('private SDK detail'));
    expect(await handleProjectTelemetryRequest(request(), deps)).toEqual({ status: 503 });
    expect(deps.uploadProject).toHaveBeenCalledOnce();
    expect(deps.upload).not.toHaveBeenCalled();
    output.expectNothingLogged();
  });

  it('projects only the nine storage columns without client/request metadata', () => {
    const extra = { ...project, timestamp: 'client-time', ip: '203.0.113.1' };
    expect(Object.keys(createProjectTelemetryStorageRecord(extra, fixedNow)))
      .toEqual([...projectTelemetryStorageFields]);
    expect(isProjectTelemetryId(undefined)).toBe(false);
    expect(isProjectTelemetryDigest(undefined)).toBe(false);
  });

  it('requires explicit approved project stream configuration without breaking legacy configuration', () => {
    const env = {
      TELEMETRY_DCE_ENDPOINT: 'https://ingestion.invalid',
      TELEMETRY_DCR_IMMUTABLE_ID: 'dcr-test',
      TELEMETRY_STREAM_NAME: 'Custom-LiftoffCommandEvents',
      AZURE_CLIENT_ID: 'test-client'
    };
    expect(readAzureTelemetryIngestionConfig(env)).not.toHaveProperty('projectStreamName');
    expect(readAzureTelemetryIngestionConfig({
      ...env, TELEMETRY_PROJECT_STREAM_NAME: ' Custom-LiftoffProjectEvents '
    }).projectStreamName).toBe('Custom-LiftoffProjectEvents');
    for (const setting of ['', ' ', 'Custom-LiftoffCommandEvents', 'private-stream']) {
      expect(() => readAzureTelemetryIngestionConfig({ ...env, TELEMETRY_PROJECT_STREAM_NAME: setting }))
        .toThrow('TELEMETRY_PROJECT_STREAM_NAME must name the approved project event stream.');
    }
    expect(() => readAzureTelemetryIngestionConfig({
      ...env, TELEMETRY_STREAM_NAME: 'Custom-LiftoffProjectEvents'
    })).toThrow('TELEMETRY_STREAM_NAME must name the approved command event stream.');
  });

  it('routes actual HTTP requests independently and keeps the disabled project endpoint unavailable', async () => {
    const deps = dependencies();
    let enabled = true;
    const server = createTelemetryServer(() => enabled ? deps : recordingDependencies());
    await listenTelemetryServer(server, 0, '127.0.0.1');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address.');
      const post = (route: string, event: unknown) => fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
      });
      expect(projectTelemetryRoute).toBe('/api/projects');
      expect((await post(projectTelemetryRoute, project)).status).toBe(204);
      expect((await post(telemetryRoute, project)).status).toBe(400);
      expect((await post(projectTelemetryRoute, validEvent)).status).toBe(400);
      expect((await post(telemetryRoute, createSemanticTelemetryEvent('upgrade', '0.12.3', 'attention-required'))).status)
        .toBe(204);
      enabled = false;
      expect((await post(projectTelemetryRoute, project)).status).toBe(503);
      expect((await post(telemetryRoute, validEvent)).status).toBe(204);
      expect(deps.uploadProject).toHaveBeenCalledOnce();
      expect(deps.upload).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await closeTelemetryServer(server);
    }
  });
});
