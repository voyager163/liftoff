import fs, { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLegacyCredentialEffectAdmission, inspectLegacyCredentialEffects, legacyCredentialChallengeActionId
} from '../src/adapters/credentials/credential-legacy-effects.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { saveTransitionPlan } from '../src/governance-activation/transition-records.js';
import { GitHubActivationError, object, positiveId, type GitHubActivationTransport } from '../src/adapters/github/activation-rest.js';
import {
  readWorkflowEffect, recordWorkflowProviderResult, type WorkflowPreparedCheckpoint
} from '../src/application/repository-governance/workflow-checkpoints.js';
import {
  credentialUsageDispatchPlan, credentialUsageOperationEffects, prepareCredentialUsageDispatch
} from '../src/adapters/credentials/credential-usage-authority.js';
import { credentialWorkflowRunBinding, credentialUsageActionId } from '../src/adapters/credentials/credential-usage-challenge.js';
import { planProductionCredentialReadiness, executeProductionCredentialChallenge } from '../src/adapters/credentials/production-credentials.js';
import * as permissionAdmission from '../src/adapters/credentials/credential-permissions.js';
import { credentialFixture, approveCredentialOperations, fixtureExistingAppTarget } from './helpers/credential-fixture.js';
import { usageChallenge } from './helpers/credential-usage-fixture.js';

const fixtures: Awaited<ReturnType<typeof credentialFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function retainedLegacy(outcome: 'plan-only' | 'unknown' | 'pending' | 'rejected' = 'unknown') {
  const { runId: _runId, ...selection } = usageChallenge;
  const f = await credentialFixture({
    mode: 'challenge', source: fixtureExistingAppTarget.source, protectedReference: fixtureExistingAppTarget.protectedReference,
    custodyVersion: null, challenge: selection
  });
  fixtures.push(f);
  const workflow = credentialWorkflowRunBinding(fixtureExistingAppTarget, selection);
  const dispatchInputs = { challenge: selection.challengeId };
  const original: TransitionOperation = {
    phaseId: 'credential-ready', adapter: 'github', actionId: legacyCredentialChallengeActionId,
    mutationClass: 'github-workflow-dispatch', remote: true, destructive: false,
    destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
    inputs: { workflow, dispatchInputs }
  };
  const approved = await approveCredentialOperations(f, [original]);
  const saved = await saveTransitionPlan(f.projectRoot, approved.plan);
  const identity = { repositoryId: 42, ref: 'develop:81', purpose: 'workflow-dispatch' as const, step: 'dispatch' as const };
  const payload = { workflow, dispatchInputs };
  const rootIdentity = await lstat(f.projectRoot);
  const intentDigest = canonicalSha256({
    kind: 'github-workflow-effect', phaseId: original.phaseId, actionId: original.actionId, destination: original.destination, identity
  });
  const prepared: WorkflowPreparedCheckpoint = {
    schemaVersion: 1, kind: 'github-workflow-effect-prepared', projectRoot: f.projectRoot,
    projectIdentity: { device: String(rootIdentity.dev), inode: String(rootIdentity.ino), birthtime: String(rootIdentity.birthtimeMs) },
    activationIdentityDigest: canonicalSha256(currentActivationIdentity), intentDigest,
    operationDigest: canonicalSha256(original), payloadDigest: canonicalSha256(payload),
    planDigest: approved.plan.planDigest, approvalEnvelopeHash: approved.plan.approval.envelopeHash!,
    attempt: 0, correlationId: randomUUID(), preparedAt: f.now.toISOString()
  };
  const privateKey = canonicalSha256({ intentDigest, attempt: 0, stage: 'prepared' });
  const store = createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage);
  let posts = 0, reads = 0;
  const transport: GitHubActivationTransport = {
    async request(request) {
      if (request.method === 'POST') {
        posts++;
        const record = await readWorkflowEffect(approved, original, identity, payload);
        expect(record?.prepared).toEqual(prepared);
        expect(record?.response).toBeNull();
        if (outcome === 'unknown') throw new GitHubActivationError('fixture-lost-response', 'Synthetic provider accepted a request whose response was lost.');
        if (outcome === 'rejected') return { status: 403, headers: { 'x-github-request-id': 'ABCD:1234:FFFF' }, data: null };
        return { status: 200, headers: { 'x-github-request-id': 'ABCD:1234:FFFF' }, data: {
          workflow_run_id: 901, run_url: 'https://api.github.com/repos/owner/repo/actions/runs/901',
          html_url: 'https://github.com/owner/repo/actions/runs/901'
        } };
      }
      reads++;
      if (request.path === '/repos/owner/repo/actions/runs/901') return {
        status: 200, headers: { 'x-github-request-id': 'ABCD:5678:FFFF' },
        data: { id: 901, status: 'queued', run_attempt: 1, head_sha: workflow.sourceSha, workflow_id: workflow.workflowId }
      };
      return f.provider.transport.request(request);
    }
  };
  if (outcome !== 'plan-only') {
    // Retained historical format, not execution of an alias or a retrospective record made by admission.
    await store.write(privateKey, prepared);
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const request = { method: 'POST' as const, path: '/repos/owner/repo/actions/workflows/81/dispatches',
        body: { ref: 'develop', inputs: { ...dispatchInputs, liftoff_operation_id: prepared.correlationId } } };
      if (outcome === 'unknown') await expect(transport.request(request)).rejects.toMatchObject({ code: 'fixture-lost-response' });
      else {
        const response = await transport.request(request);
        const responseId = outcome === 'pending' ? String(positiveId(object(response.data).workflow_run_id)) : null;
        const resourceId = responseId ? `/repos/owner/repo/actions/runs/${responseId}` : null;
        await recordWorkflowProviderResult({ ...approved, lease }, original, identity, prepared, 'response', {
          status: response.status, requestId: response.headers['x-github-request-id'],
          providerId: responseId, resourceId
        });
        if (resourceId) {
          const observed = await transport.request({ method: 'GET', path: resourceId });
          await recordWorkflowProviderResult({ ...approved, lease }, original, identity, prepared, 'observed', {
            status: observed.status, requestId: observed.headers['x-github-request-id'],
            providerId: String(positiveId(object(observed.data).id)), resourceId
          });
        }
      }
    });
  }
  const nextSelection = { ...selection, challengeId: randomUUID(), sourceSha: 'c'.repeat(40) };
  const expectedSecret = { name: 'RUNNER_CONFIGURATION_READ_TOKEN' as const, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
  const usage = credentialUsageDispatchPlan(fixtureExistingAppTarget, nextSelection, expectedSecret);
  const current: TransitionOperation = {
    ...original, actionId: credentialUsageActionId,
    inputs: { usage, workflow: credentialWorkflowRunBinding(fixtureExistingAppTarget, nextSelection),
      dispatchInputs: { challenge: nextSelection.challengeId } },
    effects: credentialUsageOperationEffects(fixtureExistingAppTarget)
  };
  f.inspection.activationInputs!.phases['credential-ready'] = {
    ...f.inspection.activationInputs!.phases['credential-ready'], challenge: nextSelection
  };
  f.inspection.state.activationInputs = f.inspection.activationInputs;
  const input = await approveCredentialOperations(f, [current]);
  input.adapters.githubActivation = { storage: f.storage, transport };
  const planning = { inspection: input.inspection, phase: input.phase, runner: input.runner, now: input.now, adapters: input.adapters };
  return { f, approved, original, current, identity, payload, input, planning, store, privateKey, prepared,
    originalPath: path.join(f.projectRoot, ...saved.pathParts), initialReads: reads, posts: () => posts, reads: () => reads };
}

describe('legacy credential effects are admitted from original records, not the renamed key', () => {
  it.each(['unknown', 'pending'] as const)('blocks a genuine retained %s request with no second POST before policy or new namespace admission', async (outcome) => {
    const f = await retainedLegacy(outcome);
    // The ordinary state-only guard has no pending/running pointer in this retained-effect fixture.
    expect(f.input.inspection.state.phases['credential-ready'].state).toBe('pending');
    expect(f.input.inspection.state.phases['credential-ready'].operation).toBeUndefined();
    expect(f.input.inspection.state.phases['credential-ready'].executionPlanDigest).toBeUndefined();
    const originalBytes = await readFile(f.originalPath);
    const checkpoint = await f.store.read(f.privateKey);
    expect(checkpoint).not.toBeNull();
    const privateBytes = await readFile(checkpoint!.path);
    expect(await readWorkflowEffect(f.input, f.current, f.identity, {
      workflow: f.current.inputs.workflow, dispatchInputs: f.current.inputs.dispatchInputs
    })).toBeNull();
    const policy = vi.spyOn(permissionAdmission, 'assertCredentialProviderPolicyPermitted');
    const build = await planProductionCredentialReadiness(f.planning);
    expect(build.operations).toEqual([]);
    expect(build.blockers?.join(' ')).toContain(legacyCredentialChallengeActionId);
    await withProjectMutationLock(f.f.projectRoot, async (lease) => {
      const input = { ...f.input, lease };
      await expect(assertLegacyCredentialEffectAdmission(input)).rejects.toMatchObject({ code: 'credential-legacy-effect' });
      const result = await executeProductionCredentialChallenge(input);
      expect(result.status).toBe('blocked');
      expect(result.blocker).toContain(f.approved.plan.planDigest);
      await expect(prepareCredentialUsageDispatch(input, f.current, f.f.provider.client)).rejects.toMatchObject({ code: 'credential-legacy-effect' });
    });
    expect(policy).not.toHaveBeenCalled();
    expect(f.posts()).toBe(1);
    expect(f.reads()).toBe(f.initialReads);
    expect((await readFile(f.originalPath)).equals(originalBytes)).toBe(true);
    expect((await readFile(checkpoint!.path)).equals(privateBytes)).toBe(true);
    expect(await readWorkflowEffect(f.input, f.current, f.identity, {
      workflow: f.current.inputs.workflow, dispatchInputs: f.current.inputs.dispatchInputs
    })).toBeNull();
  });

  it('treats original unsupported rejection as a preserved recovery boundary, not a renamed retry', async () => {
    const f = await retainedLegacy('rejected');
    const records = await inspectLegacyCredentialEffects(f.planning);
    expect(records).toMatchObject([{ outcome: 'response-recorded', providerOperationId: null, providerRequestId: 'ABCD:1234:FFFF' }]);
    await expect(assertLegacyCredentialEffectAdmission(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-effect' });
    expect(f.posts()).toBe(1);
  });

  it('does not confuse an old plan without a private pre-effect record with a dispatched effect', async () => {
    const f = await retainedLegacy('plan-only');
    expect(await inspectLegacyCredentialEffects(f.planning)).toEqual([]);
    await expect(assertLegacyCredentialEffectAdmission(f.planning)).resolves.toBeUndefined();
    await expect(assertLegacyCredentialEffectAdmission(f.input)).rejects.toMatchObject({ code: 'credential-legacy-lease' });
    expect(f.posts()).toBe(0);
  });

  it('does not let expired original approval or a newly selected source/nonce erase the old request', async () => {
    const f = await retainedLegacy();
    await expect(assertLegacyCredentialEffectAdmission({ ...f.planning, now: new Date('2030-01-01') }))
      .rejects.toMatchObject({ code: 'credential-legacy-effect' });
    expect(f.posts()).toBe(1);
  });

  it('blocks missing original plan references and does not create retrospective preparation', async () => {
    const f = await retainedLegacy('plan-only');
    f.planning.inspection.state.phases['credential-ready'].operation = {
      provider: 'github', actionId: legacyCredentialChallengeActionId, operationId: '901',
      resourceId: '/repos/owner/repo/actions/runs/901', startedAt: f.f.now.toISOString(), observedAt: f.f.now.toISOString(),
      status: 'running', planDigest: f.approved.plan.planDigest
    };
    await expect(assertLegacyCredentialEffectAdmission(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
    expect(await f.store.read(f.privateKey)).toBeNull();
  });

  it('blocks a known original plan that is no longer at its retained project location without searching the private store', async () => {
    const f = await retainedLegacy();
    f.planning.inspection.contexts['credential-ready'].reviewedPlans = [f.approved.plan];
    const retained = path.join(f.f.projectRoot, 'retained-original-plan.json');
    const bytes = await readFile(f.originalPath);
    await rename(f.originalPath, retained);
    try {
      await expect(assertLegacyCredentialEffectAdmission(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
      expect((await readFile(retained)).equals(bytes)).toBe(true);
      expect(f.posts()).toBe(1);
    } finally { await rename(retained, f.originalPath); }
  });

  it.each(['planDigest', 'operationDigest', 'payloadDigest', 'approvalEnvelopeHash'] as const)(
    'blocks inconsistent original %s instead of accepting missing new-name records', async (field) => {
      const f = await retainedLegacy('plan-only');
      await f.store.write(f.privateKey, { ...f.prepared, [field]: 'f'.repeat(64) });
      const before = await f.store.read(f.privateKey);
      await expect(assertLegacyCredentialEffectAdmission(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
      expect((await f.store.read(f.privateKey))?.value).toEqual(before?.value);
      expect(f.posts()).toBe(0);
    }
  );

  it('rejects non-regular plan entries without modifying retained original files', async () => {
    const f = await retainedLegacy('plan-only');
    await mkdir(path.join(f.f.projectRoot, 'governance', 'plans', 'not-a-file.json'));
    const before = await readFile(f.originalPath);
    await expect(assertLegacyCredentialEffectAdmission(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
    expect((await readFile(f.originalPath)).equals(before)).toBe(true);
  });

  it('rejects hard links to original saved plans before accepting an empty legacy inventory', async () => {
    const f = await retainedLegacy('plan-only');
    const before = await readFile(f.originalPath);
    const alias = path.join(f.f.root, 'linked-original-plan.json');
    await link(f.originalPath, alias);
    await expect(inspectLegacyCredentialEffects(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
    expect(await readFile(f.originalPath)).toEqual(before);
    expect(f.posts()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects saved plans with special modes', async () => {
    const f = await retainedLegacy('plan-only');
    await chmod(f.originalPath, 0o4600);
    await expect(inspectLegacyCredentialEffects(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
    expect(f.posts()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rejects a substituted FIFO without a blocking open or a new dispatch', async () => {
    const f = await retainedLegacy('plan-only');
    const preserved = path.join(f.f.root, 'preserved-original-plan.json');
    const before = await readFile(f.originalPath);
    const open = fs.open;
    let substituted = false;
    let originalMoved = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === f.originalPath && !substituted) {
        if (typeof flags !== 'number' || !(flags & constants.O_NONBLOCK)) {
          throw new Error('A nonblocking descriptor is required before exercising this FIFO race.');
        }
        await rename(f.originalPath, preserved);
        originalMoved = true;
        const made = spawnSync('mkfifo', [f.originalPath], { encoding: 'utf8', timeout: 5000 });
        if (made.status !== 0) throw new Error(`Unable to create the bounded FIFO fixture: ${made.error?.message ?? made.stderr}`);
        substituted = true;
      }
      return open(file, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      await expect(inspectLegacyCredentialEffects(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
      expect(substituted).toBe(true);
      expect((await lstat(f.originalPath)).isFIFO()).toBe(true);
      expect(await readFile(preserved)).toEqual(before);
      expect(f.posts()).toBe(0);
    } finally {
      if (originalMoved) {
        if (substituted) await unlink(f.originalPath);
        await rename(preserved, f.originalPath);
      }
    }
  });

  it('enforces the aggregate byte budget before opening the next saved plan', async () => {
    const f = await retainedLegacy('plan-only');
    const record = JSON.stringify({ phaseId: 'seed-valid', operations: [] }).padEnd(256 * 1024, ' ');
    const names = Array.from({ length: 16 }, (_, index) => `a-inventory-${String(index).padStart(2, '0')}.json`);
    for (const name of names) await writeFile(path.join(f.f.projectRoot, 'governance', 'plans', name), record);
    const open = vi.spyOn(fs, 'open');
    syncBuiltinESMExports();
    await expect(inspectLegacyCredentialEffects(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
    expect(names.every((name) => open.mock.calls.some(([file]) => String(file).endsWith(`/${name}`) ||
      String(file).endsWith(`\\${name}`)))).toBe(true);
    expect(open.mock.calls.some(([file]) => String(file) === f.originalPath)).toBe(false);
    expect(f.posts()).toBe(0);
  });

  it('blocks a retagged public plan rather than allowing it to hide its original private POST', async () => {
    const f = await retainedLegacy();
    const before = await readFile(f.originalPath);
    const forged = { ...f.approved.plan, operations: [{ ...f.original, actionId: credentialUsageActionId }] };
    // A corrupt test input, not a supported migration or a write performed by the admission reader.
    await writeFile(f.originalPath, JSON.stringify(forged));
    try {
      await expect(assertLegacyCredentialEffectAdmission(f.planning)).rejects.toMatchObject({ code: 'credential-legacy-record-invalid' });
      expect(f.posts()).toBe(1);
      expect((await f.store.read(f.privateKey))?.value).toEqual(f.prepared);
    } finally { await writeFile(f.originalPath, before); }
  });
});
