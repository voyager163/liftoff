import { inspect } from 'node:util';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { applyProjectFileTransaction, captureProjectFileSnapshot } from '../src/adapters/filesystem/project-transaction.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { runnerPreflightSecretName, type CredentialPolicy, type TransitionOperation } from '../src/domain/governance/activation/types.js';
import { buildGitHubAppCredentialPolicy, credentialPolicyPathParts } from '../src/governance-activation/credentials.js';
import { assertCredentialAuthority } from '../src/adapters/credentials/credential-authority.js';
import { prepareCredentialEnrollment, readCredentialCheckpoints, recordCredentialEnrollmentResponse, settleCredentialEnrollment } from '../src/adapters/credentials/credential-checkpoints.js';
import {
  credentialApiPermissions, enrollGitHubCredential, githubCliSecretWriter, githubRestSecretWriter,
  inspectGitHubCredentialTarget, readGitHubSecretMetadata, type CredentialEnrollmentPlan
} from '../src/adapters/credentials/github-enrollment.js';
import { parseProductionCredentialConfiguration, planProductionCredentialReadiness } from '../src/adapters/credentials/production-credentials.js';
import {
  assertCredentialPolicyPrecondition, credentialPolicyBytes, parseCredentialPolicyBytes, planCredentialPolicyTransaction,
  readbackCredentialPolicy, createCredentialPolicyTransactionGuard, type CredentialPolicyTransactionPlan
} from '../src/adapters/credentials/credential-policy-transaction.js';
import { credentialUsageActionId, credentialUsageJob, credentialUsageWorkflowPath } from '../src/adapters/credentials/credential-usage-challenge.js';
import { approveCredentialOperations, credentialFixture, enrollmentOperation, fixtureCredentialTarget, fixtureExistingAppTarget } from './helpers/credential-fixture.js';
import { usageChallenge } from './helpers/credential-usage-fixture.js';
import type { CommandRunner } from '../src/process-runner.js';
import { credentialPermissionBoundary, credentialProviderScopeBlocker } from '../src/adapters/credentials/credential-permissions.js';

const fixtures: Awaited<ReturnType<typeof credentialFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture() { const f = await credentialFixture(); fixtures.push(f); return f; }
const checkpointTarget = { repository: 'owner/repo', repositoryId: 42, secretName: runnerPreflightSecretName };

function policy(now = new Date('2026-09-15T00:00:00.000Z')) {
  const repository = { id: '42', owner: 'owner', name: 'repo', fullName: 'owner/repo' };
  return buildGitHubAppCredentialPolicy({
    repository, identity: currentActivationIdentity, createdAt: now,
    allowedWorkflows: [{ path: credentialUsageWorkflowPath, jobs: [credentialUsageJob] }],
    installation: {
      installationId: 73, appSlug: 'fixture-app', approved: true, verified: true, selection: 'selected-repository',
      repositories: [repository], permissions: { repository: ['metadata:read'], organization: ['organization_administration:read', 'organization_network_configurations:read'] },
      observedPermissions: { kind: 'github-app', permissions: credentialApiPermissions },
      permissionsVerifiedAt: now.toISOString(), readbackDigest: canonicalSha256({ fixture: 'retained logical policy only, not provider grant admission' }),
      token: { canGenerate: true, ttlSeconds: 3600 }
    }
  });
}

function policyOperation(plan: CredentialPolicyTransactionPlan): TransitionOperation {
  return {
    phaseId: 'credential-ready', adapter: 'local-state', actionId: 'local.credential-policy.write',
    mutationClass: 'write-credential-policy', inputs: { policyTransaction: plan },
    destination: { type: 'local', identity: credentialPolicyPathParts.join('/'), pathParts: credentialPolicyPathParts },
    remote: false, destructive: false
  };
}

describe('credential authority and explicit sources', () => {
  it('selects the exact reviewed approval instead of an earlier matching envelope', async () => {
    const f = await fixture(), operation = enrollmentOperation();
    const input = await approveCredentialOperations(f, [operation]);
    const selected = input.inspection.approvals[0]!;
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      await expect(assertCredentialAuthority({
        ...input, lease, inspection: {
          ...input.inspection, approvals: [{ ...selected, id: 'older-unselected-envelope' }, selected]
        }
      }, operation, f.storage)).resolves.toBeUndefined();
    });
    expect(f.provider.calls).toEqual([]);
  });

  it('never defaults PAT, invents a version for an existing App, or accepts caller approval flags', () => {
    expect(() => parseProductionCredentialConfiguration({})).toThrow();
    const { runId: _runId, ...challenge } = usageChallenge;
    const input = {
      mode: 'challenge', credential: fixtureExistingAppTarget.configuration, principal: fixtureExistingAppTarget.principal,
      source: fixtureExistingAppTarget.source, protectedReference: fixtureExistingAppTarget.protectedReference, custodyVersion: null, challenge
    };
    expect(parseProductionCredentialConfiguration(input)).toMatchObject({ source: 'existing-app-private-key', custodyVersion: null });
    expect(() => parseProductionCredentialConfiguration({ ...input, approved: true })).toThrow();
  });

  it('reports the unavailable exact create-only effect, not universal GitHub enrollment impossibility', async () => {
    const f = await fixture();
    const phase = (await approveCredentialOperations(f, [enrollmentOperation()])).phase;
    const build = await planProductionCredentialReadiness({ inspection: f.inspection, phase, runner: f.runner, now: f.now,
      adapters: { githubActivation: { transport: f.provider.transport, storage: f.storage } } });
    expect(build.operations).toEqual([enrollmentOperation(f.provider.target)]);
    expect(build.blockers?.join(' ')).toContain('reviewed create-only request');
    expect(build.blockers?.join(' ')).toContain('Existing-App verification does not require this write');
    expect(build.fileMutations).toBeUndefined();
  });

  it('plans existing-App usage independently of new secret enrollment', async () => {
    const f = await fixture();
    const { runId: _runId, ...challenge } = usageChallenge;
    f.provider.setSecret({ name: runnerPreflightSecretName, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' });
    f.inspection.activationInputs!.phases['credential-ready'] = {
      mode: 'challenge', credential: fixtureExistingAppTarget.configuration, principal: fixtureExistingAppTarget.principal,
      source: fixtureExistingAppTarget.source, protectedReference: fixtureExistingAppTarget.protectedReference, custodyVersion: null, challenge
    };
    const phase = (await approveCredentialOperations(f, [enrollmentOperation()])).phase;
    const build = await planProductionCredentialReadiness({ inspection: f.inspection, phase, runner: f.runner, now: f.now,
      adapters: { githubActivation: { transport: f.provider.transport, storage: f.storage } } });
    expect(build.blockers).not.toContain(credentialProviderScopeBlocker);
    expect(build.blockers?.some((blocker) => blocker.includes('must admit these exact effects')))
      .toBe(!phase.allowedMutations.remote.includes('github-write'));
    expect(build.operations).toHaveLength(1);
    expect(build.operations[0]).toMatchObject({ actionId: credentialUsageActionId, mutationClass: 'github-workflow-dispatch',
      inputs: { usage: { target: { source: 'existing-app-private-key', custodyVersion: null } } } });
    expect(build.operations[0]!.effects?.map((effect) => effect.mutationClass)).toEqual(['github-write', 'github-write']);
    expect(build.fileMutations).toBeUndefined();
    expect(f.provider.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('binds actual published IDs, principal, exact App permissions and complete secret inventory', async () => {
    const f = await fixture();
    const input = { client: f.provider.client, repository: 'owner/repo', publishedRepositoryId: '42',
      configuration: fixtureCredentialTarget.configuration, principal: fixtureCredentialTarget.principal, source: fixtureCredentialTarget.source,
      protectedReference: fixtureCredentialTarget.protectedReference, custodyVersion: fixtureCredentialTarget.custodyVersion, now: f.now };
    await expect(inspectGitHubCredentialTarget({ ...input, publishedRepositoryId: 'local:42' })).rejects.toThrow(/actual published/);
    await expect(inspectGitHubCredentialTarget({ ...input, principal: { ...input.principal, id: 999 } })).rejects.toThrow(/principal/);
    f.provider.overrides.set('/orgs/owner/installations', { status: 200, data: { total_count: 1, installations: [{
      id: 73, app_id: 72, app_slug: 'fixture-app', account: { id: 43 }, repository_selection: 'selected',
      suspended_at: null, permissions: { ...credentialApiPermissions, contents: 'write' },
      created_at: fixtureCredentialTarget.metadata.createdAt
    }] } });
    const observed = await inspectGitHubCredentialTarget(input);
    expect(observed.metadata.observedPermissions).toMatchObject({ permissions: { contents: 'write', organization_administration: 'read' } });
    expect(credentialPermissionBoundary(observed.metadata.observedPermissions).providerGrantMatch).toBe('unsupported-additional-or-missing');
    f.provider.overrides.set('/repos/owner/repo/actions/secrets', { status: 404, data: {} });
    await expect(readGitHubSecretMetadata(f.provider.client, 'owner/repo')).rejects.toThrow(/not visible/);
  });

  it('preserves approved-grant access time and unknown token creation without deriving thirty-day proof', async () => {
    const f = await fixture();
    f.provider.overrides.set('/users/fixture-user', { status: 200, data: { id: 92, login: 'fixture-user', type: 'User' } });
    f.provider.overrides.set('/orgs/owner/personal-access-tokens', { status: 200, data: [{
      id: 93, token_id: 91, owner: { id: 92, login: 'fixture-user' }, repository_selection: 'subset',
      token_expired: false, token_name: 'repo-runner-preflight-read', access_granted_at: '2026-09-01T00:00:00Z',
      token_expires_at: '2026-10-01T00:00:00Z', permissions: {
        repository: { metadata: 'read' }, organization: { organization_administration: 'read', organization_network_configurations: 'read' }, other: {}
      }
    }] });
    f.provider.overrides.set('/orgs/owner/personal-access-tokens/93/repositories', { status: 200, data: [{ id: 42, full_name: 'owner/repo' }] });
    const observed = await inspectGitHubCredentialTarget({
      client: f.provider.client, repository: 'owner/repo', publishedRepositoryId: '42',
      configuration: { kind: 'fine-grained-pat', tokenId: 91, owner: 'fixture-user', appUnavailableReason: 'No approved App available.' },
      principal: { id: 92, login: 'fixture-user' }, source: 'protected-input',
      protectedReference: fixtureCredentialTarget.protectedReference, custodyVersion: fixtureCredentialTarget.custodyVersion, now: f.now
    });
    expect(observed.metadata).toMatchObject({ createdAt: null, accessGrantedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' });
  });

  it('requires actual project lease, exact approval, private issuance, current configuration and expiry', async () => {
    const f = await fixture(), op = enrollmentOperation();
    const imported = await approveCredentialOperations(f, [op], { issue: false });
    await expect(assertCredentialAuthority({ ...imported, lease: { assertHeld: async () => undefined } }, op, f.storage)).rejects.toThrow(/real project-bound/);
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      await expect(assertCredentialAuthority({ ...imported, lease }, op, f.storage)).rejects.toThrow(/project-bound authority/);
      const issued = await approveCredentialOperations(f, [op]);
      await expect(assertCredentialAuthority({ ...issued, lease }, op, f.storage)).resolves.toBeUndefined();
      await expect(assertCredentialAuthority({ ...issued, lease }, { ...op, inputs: {} }, f.storage)).rejects.toThrow();
      await expect(assertCredentialAuthority({ ...issued, lease, clock: () => new Date('2030-01-01') }, op, f.storage)).rejects.toThrow(/time binding/);
      await expect(assertCredentialAuthority({ ...issued, lease, inspection: { ...issued.inspection,
        activationInputs: { ...issued.inspection.activationInputs!, phases: {} } } }, op, f.storage)).rejects.toThrow(/configuration/i);
    });
  });
});

describe('immutable enrollment recovery evidence', () => {
  it('retains unknown provider responses and never repeats them under a new approval', async () => {
    const f = await fixture(), op = enrollmentOperation(), input = await approveCredentialOperations(f, [enrollmentOperation()]);
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const active = { ...input, lease };
      const prepared = await prepareCredentialEnrollment(active, op, checkpointTarget, f.storage);
      await recordCredentialEnrollmentResponse(active, prepared, { providerRequestId: 'ABCD:1234:5678', status: 500 }, f.storage);
      expect((await readCredentialCheckpoints(active, checkpointTarget, f.storage))?.submitted).toMatchObject({ status: 500, providerVersion: null });
      const fresh = await approveCredentialOperations(f, [op], { recovery: true });
      await expect(prepareCredentialEnrollment({ ...fresh, lease }, op, checkpointTarget, f.storage)).rejects.toThrow(/uncertain/);
      await expect(readCredentialCheckpoints(active, { ...checkpointTarget, repository: 'owner/renamed' }, f.storage)).rejects.toThrow();
    });
  });

  it('keeps all sixteen known rejected attempts readable and requires separate issued recovery approvals', async () => {
    const f = await fixture(), op = enrollmentOperation();
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      for (let attempt = 0; attempt < 16; attempt++) {
        if (attempt) f.now.setTime(f.now.getTime() + 1000);
        const active = { ...await approveCredentialOperations(f, [op], { recovery: attempt > 0 }), lease };
        const prepared = await prepareCredentialEnrollment(active, op, checkpointTarget, f.storage);
        await settleCredentialEnrollment(active, prepared, { outcome: 'rejected', providerRequestId: `ABCD:1234:${attempt}`, status: 403 }, f.storage);
        await expect(settleCredentialEnrollment(active, prepared, { outcome: 'enrolled', providerRequestId: `ABCD:1234:${attempt}`, status: 201 }, f.storage)).rejects.toThrow();
      }
      f.now.setTime(f.now.getTime() + 1000);
      const final = { ...await approveCredentialOperations(f, [op], { recovery: true }), lease };
      expect((await readCredentialCheckpoints(final, checkpointTarget, f.storage))?.prepared.attempt).toBe(15);
      await expect(prepareCredentialEnrollment(final, op, checkpointTarget, f.storage)).rejects.toThrow(/Sixteen/);
    });
  });
});

describe('documented protected encryption without invented atomic writers', () => {
  it('uses real CLI protocol/local encryption with protected stdin, exact repository and no-store', async () => {
    const f = await fixture();
    const value = Buffer.from('synthetic-protected-input');
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(command, options) {
      calls.push(command.args);
      if (command.args[0] === 'api') return { status: 0, stderr: '', displayCommand: 'public key read',
        stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ key_id: '12345', key: Buffer.alloc(32, 7).toString('base64') })}` };
      expect(command.args).toEqual(['secret', 'set', runnerPreflightSecretName, '--repo', 'github.com/owner/repo', '--app', 'actions', '--no-store']);
      expect(options?.stdin === value).toBe(true);
      expect(command.args.some((argument) => argument.includes(value.toString()))).toBe(false);
      return { status: 0, stderr: '', displayCommand: 'protected encryption', stdout: Buffer.alloc(value.length + 48, 5).toString('base64') };
    } };
    const writer = githubCliSecretWriter(runner, f.projectRoot);
    expect(writer.semantics).toBe('create-or-update');
    const encrypted = await writer.encrypt('owner/repo', runnerPreflightSecretName, value);
    expect(inspect(encrypted)).toBe('[ProtectedGitHubSecretCiphertext]');
    expect(() => JSON.stringify(encrypted)).toThrow(/public record/);
    let held: Uint8Array | undefined;
    encrypted.use((bytes) => { held = bytes; });
    encrypted.release();
    expect(held!.every((byte) => byte === 0)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('performs supported REST public-key/sealed-box preparation and withholds encryption failures', async () => {
    const f = await fixture();
    f.provider.overrides.set('/repos/owner/repo/actions/secrets/public-key', { status: 200,
      data: { key_id: '12345', key: Buffer.alloc(32, 7).toString('base64') } });
    const writer = githubRestSecretWriter(f.provider.client, async (value, publicKey) => {
      expect(publicKey.byteLength).toBe(32);
      return Buffer.alloc(value.length + 48);
    });
    const ciphertext = await writer.encrypt('owner/repo', runnerPreflightSecretName, Buffer.from('synthetic'));
    expect(ciphertext.keyId).toBe('12345'); ciphertext.release();
    const failing = githubRestSecretWriter(f.provider.client, async () => { throw new Error('private details must not escape'); });
    await expect(failing.encrypt('owner/repo', runnerPreflightSecretName, Buffer.from('synthetic'))).rejects.toThrow(/diagnostics were withheld/);
  });

  it('refuses the unsupported create-only effect and existing values before reading protected input', async () => {
    const f = await fixture(), op = enrollmentOperation(), input = await approveCredentialOperations(f, [enrollmentOperation()]);
    const read = vi.fn(async () => Buffer.from('unused'));
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const request = { executionInput: { ...input, lease }, operation: op, plan: op.inputs.enrollment as CredentialEnrollmentPlan,
        client: f.provider.client, channel: { kind: 'protected-stdin' as const, read },
        secretWriter: githubCliSecretWriter(f.runner, f.projectRoot), storage: f.storage };
      await expect(enrollGitHubCredential(request)).rejects.toThrow(/create-only/);
      f.provider.setSecret({ name: runnerPreflightSecretName, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' });
      await expect(enrollGitHubCredential(request)).rejects.toThrow(/will not be overwritten/);
      expect(await readCredentialCheckpoints({ ...input, lease }, checkpointTarget, f.storage)).toBeNull();
    });
    expect(read).not.toHaveBeenCalled();
  });
});

// Synthetic retained output from an independently approved prior transaction, not a public ownership Boolean.
async function ownedPolicyFixture(f: Awaited<ReturnType<typeof credentialFixture>>, document: CredentialPolicy) {
  const planned = await planCredentialPolicyTransaction(f.projectRoot, document);
  const operation = policyOperation(planned.plan);
  const input = await approveCredentialOperations(f, [operation], { fileChanges: [{
    pathParts: credentialPolicyPathParts, beforeHash: null, afterHash: planned.plan.afterHash
  }] });
  await applyProjectFileTransaction(f.projectRoot, [planned.mutation], { preconditions: [planned.snapshot] });
  const identity = async (filename: string) => { const s = await lstat(filename); return { device: String(s.dev), inode: String(s.ino), birthtime: String(s.birthtimeMs) }; };
  const fileIdentity = await identity(path.join(f.projectRoot, ...credentialPolicyPathParts));
  const receipt = {
    kind: 'credential-policy-owned-output.v1', projectRoot: await realpath(f.projectRoot),
    projectIdentity: await identity(f.projectRoot), fileIdentity, contentHash: planned.plan.afterHash, mode: planned.plan.afterMode,
    operation, envelope: input.inspection.approvals[0]
  };
  await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage)
    .write(canonicalSha256({ kind: receipt.kind, path: credentialPolicyPathParts.join('/'), contentHash: receipt.contentHash, mode: receipt.mode }), receipt);
  return { input, planned, operation };
}

describe('owned public-policy renewal and transaction boundary', () => {
  it('renews only privately owned public App policy, preserving original creation, target, mode and remote secret', async () => {
    const f = await fixture(), original = policy();
    await ownedPolicyFixture(f, original);
    const next = { ...policy(new Date('2026-10-15T00:00:00Z')), createdAt: original.createdAt };
    const planned = await planCredentialPolicyTransaction(f.projectRoot, next, { action: 'renew-owned', storage: f.storage });
    expect(planned.plan).toMatchObject({ ownership: 'renew-owned-policy', beforeMode: 0o600, afterMode: 0o600 });
    expect(planned.plan.priorOwnership).toMatch(/^[a-f0-9]{64}$/);
    expect(planned.plan.policy.createdAt).toBe(original.createdAt);
    await expect(readbackCredentialPolicy(f.projectRoot, planned.plan)).rejects.toThrow(/readback differs/);
    expect(f.provider.calls).toEqual([]);
    await expect(planCredentialPolicyTransaction(f.projectRoot, { ...next, createdAt: next.expiresAt }, { action: 'renew-owned', storage: f.storage })).rejects.toThrow();
  });

  it('requires private ownership beyond matching hashes, preserves atomic rewrites, and rejects mode drift', async () => {
    const f = await fixture(), original = policy();
    const prior = await ownedPolicyFixture(f, original);
    const next = { ...policy(new Date('2026-10-15')), createdAt: original.createdAt };
    const planned = await planCredentialPolicyTransaction(f.projectRoot, next, { action: 'renew-owned', storage: f.storage });
    await chmod(path.join(f.projectRoot, ...credentialPolicyPathParts), 0o640);
    await expect(assertCredentialPolicyPrecondition(f.projectRoot, planned.plan, f.storage)).rejects.toThrow(/changed after review/);
    await chmod(path.join(f.projectRoot, ...credentialPolicyPathParts), 0o600);
    await applyProjectFileTransaction(f.projectRoot, [prior.planned.mutation]);
    await expect(planCredentialPolicyTransaction(f.projectRoot, next, { action: 'renew-owned', storage: f.storage })).resolves.toMatchObject({
      plan: { ownership: 'renew-owned-policy' }
    });
    const other = await fixture();
    await mkdir(path.join(other.projectRoot, 'governance', 'credentials'));
    await writeFile(path.join(other.projectRoot, ...credentialPolicyPathParts), credentialPolicyBytes(original), { mode: 0o600 });
    await expect(planCredentialPolicyTransaction(other.projectRoot, next, { action: 'renew-owned', storage: other.storage })).rejects.toThrow(/ownership/);
  });

  it('enforces in-transaction readback ordering and rolls back original policy bytes/mode on later failure', async () => {
    const f = await fixture(), original = policy();
    const owned = await ownedPolicyFixture(f, original);
    const planned = await planCredentialPolicyTransaction(f.projectRoot, { ...policy(new Date('2026-10-15')), createdAt: original.createdAt }, { action: 'renew-owned', storage: f.storage });
    await expect(createCredentialPolicyTransactionGuard(owned.input, owned.operation, owned.planned.plan, f.storage)(
      { type: 'write', pathParts: ['governance', 'activation-state.json'], content: '{}' }, 0
    )).rejects.toThrow(/cannot precede/);
    const before = await readFile(path.join(f.projectRoot, ...credentialPolicyPathParts));
    let independentlyRead = false;
    await expect(applyProjectFileTransaction(f.projectRoot, [planned.mutation, {
      type: 'write', pathParts: ['governance', 'evidence', 'fixture.json'], content: '{}'
    }], { preconditions: [planned.snapshot], onBeforeMutation: async (_mutation, index) => {
      if (index === 1) { await readbackCredentialPolicy(f.projectRoot, planned.plan); independentlyRead = true; throw new Error('Synthetic later persistence failure.'); }
    } })).rejects.toThrow(/rolled back/);
    expect(independentlyRead).toBe(true);
    expect((await readFile(path.join(f.projectRoot, ...credentialPolicyPathParts))).equals(before)).toBe(true);
    expect((await captureProjectFileSnapshot(f.projectRoot, [...credentialPolicyPathParts])).mode).toBe(0o600);
    await expect(assertCredentialPolicyPrecondition(f.projectRoot, planned.plan, f.storage)).resolves.toMatchObject({ mode: 0o600 });
  });

  it('rejects malformed/sensitive policy and never writes during planning', async () => {
    const f = await fixture();
    expect(() => parseCredentialPolicyBytes(Buffer.from(JSON.stringify({ ...policy(), unexpected: true })))).toThrow(/strict contract/);
    const planned = await planCredentialPolicyTransaction(f.projectRoot, policy());
    await expect(readFile(path.join(f.projectRoot, ...credentialPolicyPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(path.join(f.projectRoot, 'governance', 'credentials'));
    await writeFile(path.join(f.projectRoot, ...credentialPolicyPathParts), 'foreign bytes');
    await expect(assertCredentialPolicyPrecondition(f.projectRoot, planned.plan)).rejects.toThrow(/changed after review/);
  });
});
