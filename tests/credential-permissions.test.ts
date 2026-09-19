import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import {
  credentialApiPermissions, credentialPermissionBoundary,
  observeCredentialPermissions, assertCredentialProviderPolicyPermitted
} from '../src/adapters/credentials/credential-permissions.js';
import {
  planProductionCredentialReadiness, executeProductionCredentialChallenge, verifyProductionCredentialReadiness
} from '../src/adapters/credentials/production-credentials.js';
import { credentialFixture, approveCredentialOperations, fixtureExistingAppTarget } from './helpers/credential-fixture.js';
import { usageChallenge } from './helpers/credential-usage-fixture.js';
import { credentialPolicyPathParts, buildGitHubAppCredentialPolicy } from '../src/governance-activation/credentials.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { runnerPreflightProviderReadDisclosure } from '../src/domain/governance/activation/types.js';
import { planCredentialPolicyTransaction, stageCredentialPolicyTransaction } from '../src/adapters/credentials/credential-policy-transaction.js';
import { credentialUsageJob, credentialUsageWorkflowPath } from '../src/adapters/credentials/credential-usage-challenge.js';
import { renderCredentialPermissionReview } from '../src/cli/governance/presentation.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';

const fixtures: Awaited<ReturnType<typeof credentialFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture(mode: 'challenge' | 'verify') {
  const { runId: _runId, ...selection } = usageChallenge;
  const f = await credentialFixture({
    mode, credential: fixtureExistingAppTarget.configuration, principal: fixtureExistingAppTarget.principal,
    source: fixtureExistingAppTarget.source, protectedReference: fixtureExistingAppTarget.protectedReference,
    custodyVersion: null, challenge: mode === 'verify' ? usageChallenge : selection
  });
  fixtures.push(f);
  f.provider.setSecret({ name: 'RUNNER_CONFIGURATION_READ_TOKEN', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' });
  const phase = f.inspection.graph.phases.find((entry) => entry.id === 'credential-ready')!;
  const planning = { inspection: f.inspection, phase, runner: f.runner, now: f.now,
    adapters: { githubActivation: { transport: f.provider.transport, storage: f.storage } } };
  return { f, build: await planProductionCredentialReadiness(planning) };
}

describe('policy-8 provider grant and separate execution authority', () => {
  it('discloses the actual broader grant and exact operations in human review without leaking protected values', async () => {
    const { f, build } = await fixture('challenge');
    const input = await approveCredentialOperations(f, build.operations);
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const presentation = new PresentationSession({ stdout, stderr, json: false });
    renderCredentialPermissionReview(input.plan, presentation);
    const output = stdout.text() + stderr.text();
    expect(output).toContain('Broader provider read scope');
    for (const value of ['organization_administration:read', 'billing', 'actions-settings', input.plan.planDigest, input.plan.expiresAt]) {
      expect(output).toContain(value);
    }
    expect(output).toContain('Separate approval required');
    const privateValue = `ghp_${'a'.repeat(36)}`;
    expect(() => renderCredentialPermissionReview({
      ...input.plan, operations: [{ ...input.plan.operations[0]!, inputs: { privateValue } }]
    }, presentation)).toThrow(/withheld/);
    expect(stdout.text() + stderr.text()).not.toContain(privateValue);
  });

  it('uses Administration read and discloses all of its additional reach without a fake Hosted-runners alias', () => {
    expect(credentialApiPermissions).toEqual({
      metadata: 'read', organization_administration: 'read', organization_network_configurations: 'read'
    });
    const raw = observeCredentialPermissions('github-app', credentialApiPermissions);
    const boundary = credentialPermissionBoundary(raw);
    expect(boundary.observedProviderPermissions).toEqual(raw);
    expect(boundary.additionalReadReachScope).toBe('all-organization-administration-read-endpoints');
    expect(boundary.additionalOrganizationReadReach).toContain('GET /organizations/{org}/settings/billing/usage');
    expect(boundary.policy.organization).toEqual(['organization_administration:read', 'organization_network_configurations:read']);
    expect(boundary.policy).toMatchObject({ policyVersion: '8', schemaVersion: 2, admission: 'exact-provider-read-scope' });
    expect(boundary.providerReadDisclosure).toEqual(runnerPreflightProviderReadDisclosure);
    expect(boundary.blockers).toEqual([]);
    expect(() => assertCredentialProviderPolicyPermitted(raw)).not.toThrow();
    expect(() => assertCredentialProviderPolicyPermitted()).toThrow(/observation is required/);
  });

  it.each([
    { ...credentialApiPermissions, members: 'read' },
    { ...credentialApiPermissions, organization_administration: 'write' },
    { metadata: 'read', organization_hosted_runners: 'read', organization_network_configurations: 'read' },
    { metadata: 'read', organization_network_configurations: 'read' }
  ])('preserves and rejects extra/missing grants instead of normalizing them away', (permissions) => {
    const raw = observeCredentialPermissions('github-app', permissions);
    expect(raw.permissions).toEqual(permissions);
    expect(credentialPermissionBoundary(raw).providerGrantMatch).toBe('unsupported-additional-or-missing');
    expect(() => assertCredentialProviderPolicyPermitted(raw)).toThrow(/additional or missing/);
  });

  it('rejects malformed permission levels rather than coercing them into read', () => {
    expect(() => observeCredentialPermissions('github-app', { members: ['read'] })).toThrow(/permission names/);
    expect(() => observeCredentialPermissions('fine-grained-pat', { repository: {}, organization: {} })).toThrow(/scopes/);
  });

  it('requires original usage custody before planning finalization even when the grant is supported', async () => {
    const { f, build } = await fixture('verify');
    expect(build.operations).toEqual([]);
    expect(build.blockers?.join(' ')).toMatch(/private pre-effect approval|provider-issued run binding/);
    expect(build.fileMutations).toBeUndefined();
    await expect(access(path.join(f.projectRoot, ...credentialPolicyPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not turn approval of an empty or unavailable finalization plan into verified readiness', async () => {
    const { f, build } = await fixture('verify');
    const input = await approveCredentialOperations(f, build.operations);
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) =>
      verifyProductionCredentialReadiness({ ...input, lease }));
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toMatch(/exact required credential operation/);
    expect(outcome.fileMutations).toBeUndefined();
    expect(f.provider.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('detects raw-grant drift after approval instead of reading a matching digest as authority', async () => {
    const { f, build } = await fixture('challenge');
    const input = await approveCredentialOperations(f, build.operations);
    f.provider.overrides.set('/orgs/owner/installations', { status: 200, data: { total_count: 1, installations: [{
      id: 73, app_id: 72, app_slug: 'fixture-app', account: { id: 43 }, repository_selection: 'selected',
      suspended_at: null, permissions: { ...credentialApiPermissions, members: 'read' }, created_at: '2026-09-01T00:00:00Z'
    }] } });
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeProductionCredentialChallenge({ ...input, lease }));
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toMatch(/additional or missing permissions/);
    expect(f.provider.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('does not dispatch or read protected material when the current exact approval is absent', async () => {
    const { f, build } = await fixture('challenge');
    const input = await approveCredentialOperations(f, build.operations);
    const before = f.provider.calls.length;
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeProductionCredentialChallenge({
      ...input, inspection: { ...input.inspection, approvals: [] }, lease
    }));
    expect(outcome.status).toBe('blocked');
    expect(outcome.blocker).toMatch(/approval/);
    expect(f.provider.calls).toHaveLength(before);
  });

  it('stages only exactly approved schema-2 policy bytes and rejects an old or undisclosed replacement', async () => {
    const { f } = await fixture('verify');
    const repository = { id: '42', owner: 'owner', name: 'repo', fullName: 'owner/repo' };
    const policy = buildGitHubAppCredentialPolicy({
      repository, identity: currentActivationIdentity, createdAt: f.now,
      allowedWorkflows: [{ path: credentialUsageWorkflowPath, jobs: [credentialUsageJob] }],
      installation: {
        installationId: 73, appSlug: 'fixture-app', approved: true, verified: true, selection: 'selected-repository',
        repositories: [repository], permissions: { repository: ['metadata:read'], organization: ['organization_administration:read', 'organization_network_configurations:read'] },
        observedPermissions: { kind: 'github-app', permissions: credentialApiPermissions },
        permissionsVerifiedAt: f.now.toISOString(), readbackDigest: canonicalSha256('logical-policy fixture, not actual grant acceptance'),
        token: { canGenerate: true, ttlSeconds: 3600 }
      }
    });
    expect(policy).toMatchObject({ schemaVersion: 2, providerReadDisclosure: runnerPreflightProviderReadDisclosure });
    const planned = await planCredentialPolicyTransaction(f.projectRoot, policy);
    const operation = {
      phaseId: 'credential-ready' as const, adapter: 'local-state' as const, actionId: 'local.credential-policy.write',
      mutationClass: 'write-credential-policy' as const, inputs: { policyTransaction: planned.plan },
      destination: { type: 'local' as const, identity: credentialPolicyPathParts.join('/'), pathParts: credentialPolicyPathParts },
      remote: false, destructive: false
    };
    const input = await approveCredentialOperations(f, [operation], {
      fileChanges: [{ pathParts: credentialPolicyPathParts, beforeHash: null, afterHash: planned.plan.afterHash }]
    });
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const staged = await stageCredentialPolicyTransaction({ ...input, lease }, operation, planned.plan);
      expect(staged.fileMutations).toHaveLength(1);
      const old = { ...planned.plan, policy: { ...policy, schemaVersion: 1 } };
      await expect(stageCredentialPolicyTransaction({ ...input, lease }, operation, old)).rejects.toThrow(/schemaVersion/);
      await expect(stageCredentialPolicyTransaction({
        ...input, inspection: { ...input.inspection, approvals: [] }, lease
      }, operation, planned.plan)).rejects.toThrow(/approval/);
    });
    await expect(access(path.join(f.projectRoot, ...credentialPolicyPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
