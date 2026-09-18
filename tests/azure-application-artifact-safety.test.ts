import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../src/domain/governance/activation/approvals.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { readWorkflowEffect } from '../src/application/repository-governance/workflow-checkpoints.js';
import { executeApplicationArtifactReady, planApplicationArtifactReady } from '../src/application/azure-activation/producer-artifact.js';
import { readApplicationBuildArchive, validateApplicationBuildReport } from '../src/application/azure-activation/application-build-report.js';
import { applicationArtifactInputs } from '../src/application/azure-activation/application-artifact-inputs.js';
import {
  applicationArtifactFixture, applicationReportZip, applicationWorkflowSource,
  applicationRegistryId, applicationPrincipal, artifactSha
} from './helpers/application-artifact-fixture.js';

const fixtures: Awaited<ReturnType<typeof applicationArtifactFixture>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function fixture(options?: Parameters<typeof applicationArtifactFixture>[0]) {
  const result = await applicationArtifactFixture(options);
  fixtures.push(result);
  vi.stubGlobal('fetch', result.fetch);
  return result;
}
const dispatches = (f: Awaited<ReturnType<typeof fixture>>) => f.protocol.requests.filter((request) => request.method === 'POST');
async function checkpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const operation = f.input.plan.operations.find((entry) => entry.actionId === 'github.artifact.build-dispatch')!;
  return readWorkflowEffect(f.input, operation, {
    repositoryId: 42, ref: 'develop:4', purpose: 'workflow-dispatch', step: 'dispatch'
  }, { workflow: f.config.workflow, dispatchInputs: f.config.dispatchInputs });
}
async function privateBytes(root: string) {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const name = path.join(entry.parentPath, entry.name);
      result[path.relative(root, name)] = artifactSha(await readFile(name));
    }
  }
  return result;
}

describe('application artifact exact source, effect and provenance contracts', () => {
  it('uses the real default ARM transport, exact private issuance and provider run identity through complete readback', async () => {
    const f = await fixture({ defaultAzure: true });
    const fetch = vi.fn(f.fetch);
    vi.stubGlobal('fetch', fetch);
    f.protocol.beforeRequest = async (request) => {
      if (request.method !== 'POST') return;
      const records = await checkpoint(f);
      expect(records?.response).toBeNull();
      expect(records?.observed).toBeNull();
      expect(request.body).toMatchObject({ inputs: { ...f.config.dispatchInputs, liftoff_operation_id: records!.prepared.correlationId } });
    };
    const outcome = await f.execute();
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: 'completed', resultState: 'verified',
      operation: { provider: 'github', operationId: '100', resourceId: '/repos/owner/repo/actions/runs/100', status: 'completed' },
      evidencePayload: { digest: f.imageDigest, sourceCommitSha: f.config.workflow.sourceSha, buildRunId: 100 }
    });
    expect(outcome.completedOperations?.map((entry) => entry.actionId)).toEqual(['github.artifact.build-dispatch', 'azure.artifact.readback']);
    expect(outcome.liveReadback?.map((entry) => entry.provider)).toEqual(['github', 'azure']);
    expect(outcome.outputs?.values['azure.artifact.imageRef']).toBe(`crliftoff.azurecr.io/team/app@${f.imageDigest}`);
    const records = await checkpoint(f);
    expect(records!.observed!.providerId).toBe('100');
    expect(outcome.operation!.operationId).not.toBe(records!.prepared.correlationId);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(f.commands.filter((command) => command.executable === 'az')).toHaveLength(3);
    expect(JSON.stringify(outcome)).not.toContain('private-fixture-sentinel');
    const before = await privateBytes(f.home);
    expect((await f.execute()).status).toBe('completed');
    expect(dispatches(f)).toHaveLength(1);
    expect(await privateBytes(f.home)).toEqual(before);
  });

  it('uses default GitHub CLI transport for actual dispatch and bounded pending without reaching a binary network download', async () => {
    const f = await fixture({ defaultGitHub: true });
    f.protocol.runStatus = 'queued';
    expect(await f.execute()).toMatchObject({ status: 'pending', operation: { operationId: '100', status: 'running' } });
    expect(await f.execute()).toMatchObject({ status: 'pending', operation: { operationId: '100' } });
    expect(f.commands.some((command) => command.executable === 'gh' && command.args.includes('POST'))).toBe(true);
    expect(dispatches(f)).toHaveLength(1);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
  });

  it('accepts a newly produced digest only from its verified OCI bytes and exact registry readback, never list order or tags', async () => {
    const f = await fixture({ phasePatch: { expectedDigest: undefined } });
    const outcome = await f.execute();
    expect(outcome).toMatchObject({ status: 'completed', evidencePayload: { digest: f.imageDigest } });
    expect(f.registryRequests.filter((request) => request.method === 'GET')).toEqual([{
      method: 'GET', url: `https://crliftoff.azurecr.io/v2/team/app/manifests/${f.imageDigest}`
    }]);
    expect(f.commands.some((command) => command.args.includes('show-manifests'))).toBe(false);
    expect(dispatches(f)).toHaveLength(1);
  });

  it('retains response loss as uncertain, then recovers the original correlation without a second dispatch', async () => {
    const f = await fixture();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/actions/workflows/4/dispatches';
    const interrupted = await f.execute();
    expect(interrupted).toMatchObject({ status: 'blocked', completedOperations: [], outputs: { values: { 'application.artifact.status': 'submission-uncertain' } } });
    expect(interrupted.operation).toBeUndefined();
    const records = await checkpoint(f);
    const original = canonicalSha256(records!.prepared);
    expect(interrupted.blocker).toContain(original);
    expect(records!.response).toBeNull();
    expect((await f.execute()).status).toBe('completed');
    expect(canonicalSha256((await checkpoint(f))!.prepared)).toBe(original);
    expect(dispatches(f)).toHaveLength(1);
  });

  it('keeps an uncorrelated lost response blocked with no invented provider ID or retry', async () => {
    const f = await fixture();
    f.protocol.loseResponseFor = 'POST /repos/owner/repo/actions/workflows/4/dispatches';
    await f.execute();
    f.protocol.runs.get(100)!.display_title = 'unrelated provider run';
    const before = await privateBytes(f.home);
    const outcome = await f.execute();
    expect(outcome.status).toBe('blocked');
    expect(outcome.operation).toBeUndefined();
    expect(outcome.outputs?.values['application.artifact.status']).toBe('submission-uncertain');
    expect(outcome.blocker).toMatch(/no unique exact provider run identity/u);
    expect(await privateBytes(f.home)).toEqual(before);
    expect(dispatches(f)).toHaveLength(1);
  });

  it('retains a known previous operation when current input validation fails', async () => {
    const f = await fixture();
    f.protocol.runStatus = 'queued';
    const pending = await f.execute();
    f.input.inspection.state.phases['application-artifact-ready'].operation = pending.operation;
    delete f.phaseInputs.principalId;
    const failed = await f.execute();
    expect(failed.status).toBe('blocked');
    expect(failed.operation).toEqual(pending.operation);
    expect(failed.outputs?.values['application.artifact.status']).toBe('recorded-execution-unresolved');
    expect(dispatches(f)).toHaveLength(1);
  });

  it('does not redispatch a recorded operation after all of its private checkpoints disappear', async () => {
    const f = await fixture();
    f.protocol.runStatus = 'queued';
    const pending = await f.execute();
    const phase = f.input.inspection.state.phases['application-artifact-ready'];
    phase.operation = pending.operation;
    phase.executionPlanDigest = f.input.plan.planDigest;
    let removed = 0;
    for (const file of await readdir(f.home, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const name = path.join(file.parentPath, file.name);
      const record = JSON.parse(await readFile(name, 'utf8'));
      if (record.kind?.startsWith('github-workflow-effect-')) {
        await rm(name);
        removed += 1;
      }
    }
    expect(removed).toBe(3);
    const outcome = await f.execute();
    expect(outcome).toMatchObject({ status: 'blocked', operation: pending.operation, completedOperations: [] });
    expect(outcome.blocker).toMatch(/no matching original private dispatch checkpoint/u);
    expect(dispatches(f)).toHaveLength(1);
  });

  it('does not turn recovery without an original private dispatch into a new build', async () => {
    const f = await fixture();
    f.input.recovery = true;
    expect(await f.execute()).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(dispatches(f)).toEqual([]);
    expect(f.azureRequests).toEqual([]);
  });

  it.each([403, 503])('preserves HTTP %s classification without authorizing an automatic retry', async (status) => {
    const f = await fixture();
    const transport = f.github;
    f.input.adapters.githubActivation!.transport = {
      async request(request) {
        if (request.method === 'POST') {
          f.protocol.requests.push(structuredClone(request));
          return { status, headers: { 'x-github-request-id': 'PROVIDER-REJECTION-OR-UNCERTAINTY' }, data: {} };
        }
        return transport.request(request);
      }
    };
    const result = await f.execute();
    expect(result).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(result.outputs?.values['application.artifact.status']).toBe(status === 403
      ? 'rejected-awaiting-reviewed-recovery' : 'submission-uncertain');
    expect((await checkpoint(f))?.response?.status).toBe(status);
    await f.execute();
    expect(dispatches(f)).toHaveLength(1);
  });

  it.each(['image-source', 'producer-run', 'oci-bytes', 'configuration-bytes', 'registry-digest', 'missing-artifact', 'ambiguous-artifact', 'job-failure'] as const)(
    'preserves actual dispatch effects when %s verification fails', async (kind) => {
      const f = await fixture();
      if (kind === 'image-source') { f.report.source.commitSha = 'd'.repeat(40); f.setReport(f.report); }
      if (kind === 'producer-run') { f.report.producer.runId = 101; f.setReport(f.report); }
      if (kind === 'oci-bytes') { f.report.oci.manifestBase64 = Buffer.from('{}').toString('base64'); f.setReport(f.report); }
      if (kind === 'configuration-bytes') { f.report.oci.configBase64 = Buffer.from('{}').toString('base64'); f.setReport(f.report); }
      if (kind === 'registry-digest') f.setRegistryManifest(Buffer.from('Different immutable registry bytes'));
      if (kind === 'missing-artifact') f.setListedArtifacts([]);
      if (kind === 'ambiguous-artifact') f.setListedArtifacts([f.artifact.metadata, { ...f.artifact.metadata, id: 56 }]);
      if (kind === 'job-failure') f.protocol.beforeRequest = async (request) => {
        if (!request.path.startsWith('/repos/owner/repo/actions/runs/100')) return;
        f.protocol.runs.get(100)!.conclusion = 'failure';
        f.protocol.jobs.get(100)![0]!.conclusion = 'failure';
        f.protocol.checks.get(10000)!.conclusion = 'failure';
      };
      const outcome = await f.execute();
      expect(outcome.status).toBe('blocked');
      expect(outcome.operation).toMatchObject({ provider: 'github', operationId: '100' });
      expect(outcome.completedOperations?.map((entry) => entry.actionId)).toEqual(['github.artifact.build-dispatch']);
      expect(outcome.resultState).toBeUndefined();
      expect((await checkpoint(f))!.observed!.providerId).toBe('100');
      await f.execute();
      expect(dispatches(f)).toHaveLength(1);
    }
  );

  it.each(['principal', 'lease', 'private-approval', 'expired', 'target', 'workflow-time', 'extra-job', 'budget'] as const)(
    'blocks absent or changed %s authority before any dispatch', async (kind) => {
      const f = await fixture({
        ...(kind === 'workflow-time' ? { source: applicationWorkflowSource.replace('timeout-minutes: 5', 'timeout-minutes: 31') } : {}),
        ...(kind === 'extra-job' ? { source: `${applicationWorkflowSource}\n  extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo extra\n` } : {})
      });
      if (kind === 'principal') delete f.phaseInputs.principalId;
      if (kind === 'budget') delete f.input.inspection.activationInputs!.budget;
      if (kind === 'target') f.phaseInputs.resourceGroup = 'another-group';
      if (kind === 'expired') f.input.clock = () => new Date('2026-09-16T00:00:00.000Z');
      if (kind === 'private-approval') {
        const authority = await createScopedUserLocalRecordStore(f.projectRoot, 'governance-approval', f.storage)
          .read(canonicalApprovalEnvelopeHash(f.envelope));
        await rm(authority!.path);
      }
      const outcome = kind === 'lease' ? await executeApplicationArtifactReady(f.input) : await f.execute();
      expect(outcome.status, JSON.stringify(outcome)).toBe('blocked');
      expect(dispatches(f)).toEqual([]);
      if (!['workflow-time', 'extra-job'].includes(kind)) expect(f.azureRequests).toEqual([]);
    }
  );

  it('binds phase-declared principal and exact target metadata on every Azure read rather than an injected-only branch', async () => {
    const f = await fixture();
    expect(f.config.azure.principalId).toBe(applicationPrincipal);
    f.registry.properties.provisioningState = 'Creating';
    expect(await f.execute()).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(dispatches(f)).toEqual([]);
    expect(f.azureRequests).toHaveLength(1);
    expect(f.azureRequests[0]).toMatchObject({ method: 'GET', resourceId: applicationRegistryId });
  });

  it('refuses a different actual AAD principal before registry token exchange while retaining the known build effect', async () => {
    const f = await fixture();
    f.setCredentialPrincipal('99999999-2222-4333-8444-555555555557');
    const outcome = await f.execute();
    expect(outcome).toMatchObject({
      status: 'blocked', operation: { operationId: '100' },
      completedOperations: [expect.objectContaining({ actionId: 'github.artifact.build-dispatch' })]
    });
    expect(outcome.blocker).toMatch(/exact reviewed Azure principal/u);
    expect(f.registryRequests).toEqual([]);
    expect(dispatches(f)).toHaveLength(1);
  });

  it('returns no executable operations for missing exact source/actor/target planning inputs', async () => {
    const f = await fixture();
    for (const key of ['principalId', 'resourceGroup', 'workflow', 'dispatchInputs', 'platform']) {
      const original = f.phaseInputs[key];
      delete f.phaseInputs[key];
      expect(planApplicationArtifactReady({ ...f.input, inspection: f.input.inspection })).toMatchObject({
        operations: [], blockers: [expect.any(String)]
      });
      f.phaseInputs[key] = original;
    }
    expect(applicationArtifactInputs(f.input)).toEqual(f.config);
  });

  it.each([
    ['matrix fan-out', applicationWorkflowSource.replace('    timeout-minutes: 5', '    strategy:\n      matrix:\n        version: [20, 22, 24]\n    timeout-minutes: 5')],
    ['broad token writes', applicationWorkflowSource.replace('permissions:\n  contents: read', 'permissions: write-all')],
    ['unrelated cancellation', `${applicationWorkflowSource}\nconcurrency:\n  group: production\n  cancel-in-progress: true\n`],
    ['environment authority', applicationWorkflowSource.replace('    timeout-minutes: 5', '    environment: production\n    timeout-minutes: 5')]
  ])('rejects %s before dispatch rather than broadening the reviewed build effect', async (_name, source) => {
    const f = await fixture({ source });
    expect((await f.execute()).status).toBe('blocked');
    expect(dispatches(f)).toEqual([]);
  });
});

describe('bounded OCI build artifact decoder', () => {
  it.each(['wrong-name', 'extra-member', 'bad-crc', 'oversized', 'invalid-json', 'trailing-bytes'])('refuses %s archive data', (kind) => {
    let archive = applicationReportZip({ fixture: true });
    if (kind === 'wrong-name') archive = applicationReportZip({}, '../state.tfstate');
    if (kind === 'extra-member') archive.writeUInt16LE(2, archive.length - 22 + 10);
    if (kind === 'bad-crc') archive[archive.length - 22 - 'liftoff-application-build.json'.length - 46 + 16] ^= 1;
    if (kind === 'oversized') archive = applicationReportZip({ content: 'x'.repeat(128 * 1024) });
    if (kind === 'invalid-json') archive = Buffer.from('not a zip');
    if (kind === 'trailing-bytes') archive = Buffer.concat([archive, Buffer.from('extra')]);
    expect(() => readApplicationBuildArchive(archive)).toThrow();
  });

  it('requires byte-verified OCI source labels and exact source/job/platform bindings, not a digest substring', async () => {
    const f = await fixture();
    const observation = { runId: 100, loginServer: 'crliftoff.azurecr.io', jobs: [{
      id: 1000, name: 'Node source validation', conclusion: 'success' as const, checkRunId: 10000,
      appId: 1, appSlug: 'github-actions', steps: []
    }] };
    expect(validateApplicationBuildReport(f.report, f.config, observation)).toMatchObject({ digest: f.imageDigest, jobId: 1000 });
    const changed = structuredClone(f.report);
    const config = JSON.parse(f.imageConfig.toString('utf8'));
    config.config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40);
    const configuration = Buffer.from(JSON.stringify(config));
    const manifest = JSON.parse(f.manifest.toString('utf8'));
    manifest.config.digest = artifactSha(configuration);
    manifest.config.size = configuration.length;
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    changed.oci.configBase64 = configuration.toString('base64');
    changed.oci.manifestBase64 = manifestBytes.toString('base64');
    changed.image.digest = artifactSha(manifestBytes);
    expect(() => validateApplicationBuildReport(changed, { ...f.config, expectedDigest: changed.image.digest }, observation)).toThrow();
  });
});
