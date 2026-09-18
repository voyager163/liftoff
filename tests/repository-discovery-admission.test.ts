import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPath, object } from '../src/adapters/github/activation-rest.js';
import { discoverRepositoryGovernance } from '../src/adapters/github/production-repository.js';
import { readbackWorkflowContent } from '../src/adapters/github/production-workflows.js';
import { canonicalSha256, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { repositoryDiscoveryFixture } from './helpers/repository-discovery-fixture.js';
import { githubSourceFixture } from './helpers/github-source-fixture.js';
import { normalizeGitHubRulesetObservation } from '../src/adapters/github/ruleset-observation.js';
import { currentGovernanceManifest } from './governance-activation-fixtures.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { evidenceContextForPhase } from '../src/domain/governance/activation/evidence.js';
import { remoteBindingDigest } from '../src/domain/governance/activation/inputs.js';
import { phaseIds, type PhaseId } from '../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { buildSavedTransitionPlan } from '../src/governance-activation/transition-planning.js';
import { executeRepositoryDiscovery } from '../src/application/repository-governance/producer-discovery.js';
import type { PhaseAdapterExecutionInput, GovernanceTransitionInspection } from '../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../src/process-runner.js';

afterEach(() => vi.restoreAllMocks());

async function executionFixture() {
  const f = repositoryDiscoveryFixture();
  const now = new Date('2026-09-15T00:00:00.000Z');
  const state = validateUserActivationState({
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: 'discovery', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: now.toISOString() },
    activeChange: null, applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: []
    }])),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  const contexts = Object.fromEntries(phaseIds.map((id) => [id, evidenceContextForPhase(id, {
    repositoryId: state.repository.id, baselineSha: canonicalSha256('baseline'), inputDigest: canonicalSha256(id),
    remoteBindingDigest: remoteBindingDigest(state.remoteBinding), now
  })])) as Record<PhaseId, ReturnType<typeof evidenceContextForPhase>>;
  const inspection: GovernanceTransitionInspection = {
    projectRoot: process.cwd(), manifest: parseManifest(currentGovernanceManifest('discovery')),
    graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash, scope: 'repository',
    state, approvals: [], evidence: [], contexts,
    readiness: {
      nextReadyPhase: 'repository-discovered',
      phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', blockers: [] }])) as Record<PhaseId, { state: string; blockers: string[] }>
    },
    sourceOfTruth: {
      status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', changeId: 'repository-discovery', workflowKind: 'openspec', reason: 'Read-only classification.', requiredFacts: [] }
    }
  };
  const calls: Parameters<CommandRunner['run']>[] = [];
  const runner: CommandRunner = {
    async run(command, options) {
      calls.push([command, options]);
      expect(command.executable).toBe('gh');
      expect(command.args.slice(0, 5)).toEqual(['api', '--hostname', 'github.com', '--method', 'GET']);
      expect(options).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, stream: false });
      expect(options?.stdin).toBeUndefined();
      const endpoint = command.args.find((arg) => arg.startsWith('/'));
      if (!endpoint) throw new Error('The production transport omitted its exact endpoint.');
      const response = await f.transport.request({ method: 'GET', path: endpoint });
      return {
        status: response.status === 200 ? 0 : 1,
        stdout: `HTTP/2.0 ${response.status} Response\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(response.data)}`,
        stderr: '', displayCommand: 'bounded fixture gh GET'
      };
    }
  };
  const plan = await buildSavedTransitionPlan({ inspection, runner, now });
  if (!plan) throw new Error('The production planner did not return a discovery plan.');
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'repository-discovered')!;
  const input: PhaseAdapterExecutionInput = { inspection, plan, phase, runner, adapters: {}, now };
  return { ...f, input, calls };
}

describe('repository discovery producer authority and readback', () => {
  it('uses the real saved-plan and default bounded CLI transport without Azure configuration', async () => {
    const f = await executionFixture();
    expect(f.calls).toEqual([]);
    const before = canonicalSha256(f.input.inspection.state);
    const outcome = await executeRepositoryDiscovery(f.input);
    expect(outcome).toMatchObject({ status: 'completed', resultState: 'verified' });
    expect(outcome.completedOperations).toEqual([f.input.plan.operations.find((operation) => operation.actionId === 'github.repository.discover')]);
    expect(outcome.evidencePayload).toMatchObject({
      kind: 'repository-discovered.v1',
      workflows: [expect.objectContaining({ sourceSha: 'a'.repeat(40), sourceDigest: sha256Hex(f.source) })],
      capabilities: { actionsEnabled: true },
      branchProtections: { develop: null }, observationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(outcome.liveReadback?.[0]).toMatchObject({
      provider: 'github', resourceId: '/repos/owner/repo', matches: true,
      sourceDigest: outcome.liveReadback?.[0]?.readbackDigest
    });
    expect(canonicalSha256(f.input.inspection.state)).toBe(before);
    expect(f.input.inspection.activationInputs).toBeUndefined();
    expect(f.calls.length).toBeGreaterThan(0);
    expect(outcome.evidencePayload).not.toHaveProperty('mainHold');
    expect(outcome.evidencePayload).not.toHaveProperty('qualified');
  });

  it.each(['changed-plan', 'expired-plan', 'wrong-scope', 'missing-binding'] as const)('refuses %s before provider access', async (change) => {
    const f = await executionFixture();
    if (change === 'changed-plan') f.input.plan.operations[0]!.inputs.repositoryId = '43';
    if (change === 'expired-plan') f.input.plan.expiresAt = f.input.now.toISOString();
    if (change === 'wrong-scope') f.input.inspection.scope = 'activation';
    if (change === 'missing-binding') delete f.input.inspection.state.remoteBinding;
    const outcome = await executeRepositoryDiscovery(f.input);
    expect(outcome.status).toBe('blocked');
    expect(outcome.liveReadback).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it('withholds successful proof for a provider identity mismatch or incomplete capability read', async () => {
    const mismatch = await executionFixture();
    object(mismatch.responses.get(mismatch.base)!.data).id = 43;
    const changed = await executeRepositoryDiscovery(mismatch.input);
    expect(changed).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('publication binding') });
    expect(changed.liveReadback).toBeUndefined();
    expect(mismatch.calls).toHaveLength(1);
    const incomplete = await executionFixture();
    incomplete.set(`${incomplete.base}/actions/permissions/workflow`, {}, 403);
    const blocked = await executeRepositoryDiscovery(incomplete.input);
    expect(blocked).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('HTTP 403') });
    expect(blocked.liveReadback).toBeUndefined();
  });
});

describe('complete bounded repository discovery', () => {
  it('reads exact source, all GitFlow refs, inherited controls and capability settings twice without provider writes', async () => {
    const f = repositoryDiscoveryFixture();
    const report = await discoverRepositoryGovernance(f.client, 'owner/repo');
    expect(report.repository).toMatchObject({ id: 42, name: 'owner/repo', isPrivate: true });
    expect(report.workflows).toEqual([expect.objectContaining({
      id: 4, path: f.workflowPath, sourceSha: 'a'.repeat(40), sourceDigest: sha256Hex(f.source),
      blobSha: githubSourceFixture(f.workflowPath, f.source).sha, jobs: [{ id: 'verify', name: 'verify-source' }]
    })]);
    expect(report.rulesets).toContainEqual(expect.objectContaining({
      id: 12, name: 'liftoff-gitflow-main', source_type: 'Organization', source: 'owner'
    }));
    expect(report.branchProtections).toEqual({ develop: null, main: null, 'release/1.0': null, 'hotfix/security': null });
    for (const branch of f.branches) expect(report.checksByRef[branch.name]).toEqual([
      expect.objectContaining({ name: 'verify-source', headSha: branch.commit.sha, appId: 15368, appSlug: 'github-actions' })
    ]);
    expect(report.capabilities).toMatchObject({
      actionsEnabled: true, allowedActions: 'all',
      tokenPermissions: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }
    });
    expect(report.unobserved).toEqual([]);
    const { observedAt, observationDigest, ...snapshot } = report;
    expect(observationDigest).toBe(canonicalSha256(snapshot));
    expect(Date.parse(observedAt)).toBeGreaterThan(0);
    expect(report).not.toHaveProperty('qualified');
    expect(f.requests.every((request) => request.method === 'GET' && request.path.startsWith(f.base) &&
      !request.body && !request.binary)).toBe(true);
    expect(f.requests.filter((request) => request.path === f.base)).toHaveLength(2);
    expect(f.requests.filter((request) => request.path.includes('/contents/')).every((request) =>
      request.path.endsWith(`?ref=${'a'.repeat(40)}`))).toBe(true);
  });

  it.each([
    '/actions/workflows', '/rulesets/11', '/rulesets/12', '/actions/permissions',
    '/actions/permissions/workflow', `/commits/${'a'.repeat(40)}/check-runs`,
    '/branches/develop/protection'
  ])('does not turn an unreadable %s into an empty or disabled result', async (endpoint) => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}${endpoint}`, { message: 'withheld-provider-details' }, 403);
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toMatchObject({
      status: 403, message: expect.not.stringContaining('withheld-provider-details')
    });
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not treat a masked protection 404 as authoritative absence', async () => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}/branches/develop/protection`, { message: 'Not Found' }, 404);
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/HTTP 404/);
  });

  it.each([
    { unsupported_enforcement: true },
    { enforce_admins: { enabled: true, unsupported_enforcement: true } },
    { required_status_checks: { strict: true, contexts: [], new_gate: true } },
    { required_pull_request_reviews: { required_approving_review_count: 0, unknown_review_restriction: true } }
  ])('rejects unknown classic protection rather than dropping it %#', async (fields) => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}/branches/develop/protection`, { enforce_admins: { enabled: true }, ...fields });
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/unknown enforcement metadata/);
  });

  it('reads documented classic protection without discarding its meaningful controls', async () => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}/branches/develop/protection`, {
      url: 'https://api.github.com/repos/owner/repo/branches/develop/protection',
      enforce_admins: { enabled: true },
      required_status_checks: {
        strict: true, contexts: ['verify-source'],
        checks: [{ context: 'verify-source', app_id: 15368 }]
      },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true, require_code_owner_reviews: false, require_last_push_approval: false,
        required_approving_review_count: 0, dismissal_restrictions: { users: [], teams: [], apps: [] }
      }
    });
    const report = await discoverRepositoryGovernance(f.client, 'owner/repo');
    expect(report.branchProtections.develop).toMatchObject({
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, checks: [{ context: 'verify-source', app_id: 15368 }] },
      required_pull_request_reviews: { required_approving_review_count: 0 }
    });
  });

  it.each([
    ['full_name', 'other/repo'], ['private', 'false'],
    ['permissions', { admin: true, push: 'yes' }],
    ['owner', { id: 3, login: 'different', type: 'Organization' }]
  ])('rejects malformed or mismatching repository %s', async (key, value) => {
    const f = repositoryDiscoveryFixture();
    object(f.responses.get(f.base)!.data)[String(key)] = value;
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });

  it('retains explicitly unobserved optional permission/security metadata rather than guessing values', async () => {
    const f = repositoryDiscoveryFixture();
    const repository = object(f.responses.get(f.base)!.data);
    delete repository.permissions;
    delete repository.security_and_analysis;
    const report = await discoverRepositoryGovernance(f.client, 'owner/repo');
    expect(report.repository.permissions).toBeNull();
    expect(report.repository.securityAndAnalysis).toBeNull();
    expect(report.unobserved).toEqual(['repository.permissions', 'repository.security_and_analysis']);
  });

  it('separates documented response metadata without discarding the observed actor bypass capability', async () => {
    const f = repositoryDiscoveryFixture();
    Object.assign(object(f.responses.get(`${f.base}/rulesets/11`)!.data), {
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
      current_user_can_bypass: 'exempt',
      _links: {
        self: { href: 'https://api.github.com/repos/owner/repo/rulesets/11' },
        html: { href: 'https://github.com/owner/repo/rules/11' }
      }
    });
    const report = await discoverRepositoryGovernance(f.client, 'owner/repo');
    expect(report.rulesetMetadata['11']).toEqual({
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z', currentUserCanBypass: 'exempt'
    });
    expect(report.rulesets[0]).not.toHaveProperty('_links');
    expect(report.rulesets[0]).toHaveProperty('rules');
  });

  it.each([
    { current_user_can_bypass: true }, { current_user_can_bypass: 'unknown-bypass' },
    { created_at: 'yesterday' }, { _links: { external: {} } },
    { _links: { self: { href: 'https://foreign.example/rulesets/11' } } },
    { _links: { self: { href: 'https://api.github.com/repos/owner/repo/rulesets/11?token=withheld' } } }
  ])('rejects malformed documented ruleset metadata rather than stripping it %#', (metadata) => {
    const f = repositoryDiscoveryFixture();
    expect(() => normalizeGitHubRulesetObservation({ ...f.rulesets[0], ...metadata })).toThrow();
  });

  it.each(['Repository', 'Organization'])('rejects unknown %s enforcement instead of returning raw rules', async (kind) => {
    const f = repositoryDiscoveryFixture();
    const id = kind === 'Repository' ? 11 : 12;
    object(f.responses.get(`${f.base}/rulesets/${id}`)!.data).unknown_enforcement = true;
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/unsupported enforcement/);
  });

  it('rejects changed or foreign detail identities even when the summary name matches', async () => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}/rulesets/11`, { ...f.rulesets[0], source: 'foreign/repo' });
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/identity\/source changed/);
  });

  it('rejects duplicate inventory IDs and malformed branch booleans', async () => {
    const duplicate = repositoryDiscoveryFixture();
    duplicate.branches.push(structuredClone(duplicate.branches[0]!));
    await expect(discoverRepositoryGovernance(duplicate.client, 'owner/repo')).rejects.toThrow(/duplicate identities/);
    const malformed = repositoryDiscoveryFixture();
    malformed.set(`${malformed.base}/branches`, [{ ...malformed.branches[0], protected: 'false' }]);
    await expect(discoverRepositoryGovernance(malformed.client, 'owner/repo')).rejects.toThrow(/Expected boolean/);
  });

  it.each([
    { head_sha: 'f'.repeat(40) }, { app: null }, { status: 'completed', conclusion: null }, { conclusion: 'invented-success' }
  ])('rejects unbound or malformed check observations %#', async (change) => {
    const f = repositoryDiscoveryFixture();
    const endpoint = `${f.base}/commits/${'a'.repeat(40)}/check-runs`;
    const envelope = object(f.responses.get(endpoint)!.data);
    const runs = envelope.check_runs as Record<string, unknown>[];
    Object.assign(runs[0]!, change);
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow();
  });

  it('observes a selected Actions policy without treating an unreadable allowlist as permissive', async () => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}/actions/permissions`, { enabled: true, allowed_actions: 'selected' });
    f.set(`${f.base}/actions/permissions/selected-actions`, {
      github_owned_allowed: true, verified_allowed: false, patterns_allowed: ['actions/checkout@*']
    });
    expect((await discoverRepositoryGovernance(f.client, 'owner/repo')).capabilities.selectedActions).toEqual({
      githubOwnedAllowed: true, verifiedAllowed: false, patternsAllowed: ['actions/checkout@*']
    });
    f.set(`${f.base}/actions/permissions/selected-actions`, {}, 404);
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/HTTP 404/);
  });

  it('rejects concurrent same-count ref changes rather than hashing only inventory counts', async () => {
    const f = repositoryDiscoveryFixture();
    let identityReads = 0;
    f.beforeRequest((request) => {
      if (request.path === f.base && ++identityReads === 2) {
        f.branches[0]!.commit.sha = 'e'.repeat(40);
        f.set(`${f.base}/commits/${'e'.repeat(40)}/check-runs`, { total_count: 0, check_runs: [] });
      }
    });
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/changed during discovery/);
  });

  it('rejects concurrent same-count control changes without any reconciliation write', async () => {
    const f = repositoryDiscoveryFixture();
    let identityReads = 0;
    f.beforeRequest((request) => {
      if (request.path === f.base && ++identityReads === 2) f.rulesets[0]!.enforcement = 'disabled';
    });
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/changed during discovery/);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('enforces the total request budget instead of accepting a truncated control inventory', async () => {
    const f = repositoryDiscoveryFixture();
    const rulesets = Array.from({ length: 161 }, (_, index) => ({ ...f.rulesets[0], id: index + 1 }));
    f.set(`${f.base}/rulesets`, rulesets.slice(0, 100));
    f.beforeRequest((request) => {
      if (request.path.startsWith(`${f.base}/rulesets?`)) {
        f.set(`${f.base}/rulesets`, request.path.includes('page=2') ? rulesets.slice(100) : rulesets.slice(0, 100));
      }
    });
    for (const ruleset of rulesets) f.set(`${f.base}/rulesets/${ruleset.id}`, ruleset);
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/160-request/);
    expect(f.requests).toHaveLength(160);
  });

  it('enforces the whole-observation deadline even when an individual request succeeds', async () => {
    const f = repositoryDiscoveryFixture();
    const timer = vi.spyOn(performance, 'now').mockReturnValue(0);
    f.beforeRequest(() => timer.mockReturnValue(120_001));
    await expect(discoverRepositoryGovernance(f.client, 'owner/repo')).rejects.toThrow(/observation deadline/);
    expect(f.requests).toHaveLength(1);
  });
});

describe('immutable workflow readback admission', () => {
  it.each([
    { type: 'symlink' }, { path: '.github/workflows/other.yml' }, { sha: '0'.repeat(40) },
    { size: 1.5 }, { content: '!!!' }, { encoding: 'none' }
  ])('rejects mismatching file identity or malformed bytes %#', async (change) => {
    const f = repositoryDiscoveryFixture();
    Object.assign(object(f.responses.get(`${f.base}/contents/${f.workflowPath}`)!.data), change);
    await expect(readbackWorkflowContent(f.client, 'owner/repo', f.workflowPath, 'a'.repeat(40))).rejects.toThrow(/Workflow/);
  });

  it('rejects invalid UTF-8 instead of hashing replacement characters', async () => {
    const f = repositoryDiscoveryFixture();
    f.set(`${f.base}/contents/${f.workflowPath}`, githubSourceFixture(f.workflowPath, new Uint8Array([0xff])));
    await expect(readbackWorkflowContent(f.client, 'owner/repo', f.workflowPath, 'a'.repeat(40))).rejects.toThrow(/UTF-8/);
  });

  it('admits only an exact encoded branch in the scoped protection endpoint', () => {
    expect(apiPath('/repos/owner/repo/branches/release%2F1.0/protection')).toBe('/repos/owner/repo/branches/release%2F1.0/protection');
    for (const endpoint of [
      '/repos/owner/repo/branches/release%2F..%2Fmain/protection',
      '/repos/owner/repo/branches/release%2F%5Cmain/protection',
      '/repos/owner/repo/contents/release%2Fmain',
      '/repos/owner/repo/branches/release%2Fmain/protection?target=%2Fother'
    ]) expect(() => apiPath(endpoint)).toThrow();
  });
});
