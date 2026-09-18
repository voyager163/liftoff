import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../../src/domain/governance/activation/graph.js';
import { evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase } from '../../src/domain/governance/activation/operations.js';
import { evidenceContextForPhase } from '../../src/domain/governance/activation/evidence.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState } from '../../src/domain/governance/activation/validators.js';
import { writeGovernanceApprovalAuthority } from '../../src/governance-activation/authority-records.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput } from '../../src/governance-activation/transition-ports.js';
import { runnerPreflightSecretName, type ActivationConfiguration, type PlannedFileChange, type TransitionOperation } from '../../src/domain/governance/activation/types.js';
import { credentialApiPermissions, type GitHubCredentialTarget } from '../../src/adapters/credentials/github-enrollment.js';
import { GitHubActivationClient, type GitHubActivationTransport } from '../../src/adapters/github/activation-rest.js';
import { buildProjectPlan } from '../../src/application/project/planning.js';
import { buildArtifacts } from '../../src/templates.js';
import { parseManifest } from '../../src/application/project/manifest.js';
import type { CommandRunner } from '../../src/process-runner.js';
import { currentProjectMutationLease, projectMutationLockPath } from '../../src/adapters/filesystem/project-lock.js';
import { credentialPermissionBoundary } from '../../src/adapters/credentials/credential-permissions.js';

export const credentialNow = new Date('2026-09-15T00:00:30.000Z');
export const fixtureCredentialTarget: GitHubCredentialTarget = {
  repository: 'owner/repo', repositoryId: 42, ownerId: 43,
  actor: { id: 70, login: 'fixture-operator' }, principal: { id: 71, login: 'fixture-app[bot]' },
  configuration: { kind: 'github-app', appId: 72, installationId: 73 },
  source: 'protected-input',
  protectedReference: 'protected-input:11111111-2222-4333-8444-555555555555',
  custodyVersion: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  metadata: { createdAt: '2026-09-01T00:00:00.000Z', accessGrantedAt: null, expiresAt: null, grantId: null,
    appSlug: 'fixture-app', observedPermissions: { kind: 'github-app', permissions: credentialApiPermissions },
    permissionsDigest: canonicalSha256(credentialApiPermissions) }
};
export const fixtureExistingAppTarget: GitHubCredentialTarget = {
  ...fixtureCredentialTarget, source: 'existing-app-private-key',
  protectedReference: `github-actions-secret:owner/repo/${runnerPreflightSecretName}`, custodyVersion: null
};

export function credentialProvider() {
  const target = structuredClone(fixtureCredentialTarget);
  const calls: { method: string; path: string }[] = [];
  let secret: { name: string; created_at: string; updated_at: string } | null = null;
  const repository = { id: target.repositoryId, full_name: target.repository, owner: { id: target.ownerId, login: 'owner', type: 'Organization' } };
  const overrides = new Map<string, { status: number; data: unknown }>();
  const transport: GitHubActivationTransport = {
    async request(request) {
      calls.push({ method: request.method, path: request.path });
      if (request.method !== 'GET') throw new Error('Unexpected provider mutation in observation fixture.');
      const path = request.path.split('?')[0]!;
      const override = overrides.get(path);
      if (override) return { ...override, headers: {} };
      const data = path === '/user' ? target.actor :
        path === `/repos/${target.repository}` ? repository :
          path === `/users/${target.principal.login}` ? { ...target.principal, type: 'Bot' } :
            path === '/orgs/owner/installations' ? { total_count: 1, installations: [{
              id: 73, app_id: 72, app_slug: 'fixture-app', account: repository.owner, repository_selection: 'selected',
              suspended_at: null, permissions: credentialApiPermissions, created_at: target.metadata.createdAt
            }] } :
              path === '/user/installations/73/repositories' ? { total_count: 1, repositories: [repository] } :
                path === '/repos/owner/repo/actions/secrets' ? { total_count: secret ? 1 : 0, secrets: secret ? [secret] : [] } :
                  path.endsWith(`/${runnerPreflightSecretName}`) ? secret : undefined;
      if (data === undefined) throw new Error('Unregistered fixture endpoint.');
      return { status: data === null ? 404 : 200, headers: {}, data };
    }
  };
  return { target, calls, overrides, transport, client: new GitHubActivationClient(transport),
    setSecret: (value: typeof secret) => { secret = value; } };
}

export async function credentialFixture(phaseInputs: Record<string, unknown> = {}) {
  const provider = credentialProvider();
  const root = path.resolve(`tests/.credential-producer-${randomUUID()}`);
  const projectRoot = path.join(root, 'project');
  const home = path.join(root, 'home');
  await mkdir(root, { mode: 0o700 });
  const ownedRoot = await lstat(root);
  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const unsettledProcesses = new Set<ChildProcess>();
  let cleaned = false;
  const trackProcess = (child: ChildProcess) => {
    if (cleaned) throw new Error('Cannot start work in a cleaned credential fixture.');
    unsettledProcesses.add(child);
    child.once('close', () => { unsettledProcesses.delete(child); });
  };
  const assertOwnedRoot = async () => {
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedRoot.dev ||
      current.ino !== ownedRoot.ino || current.birthtimeMs !== ownedRoot.birthtimeMs) {
      throw new Error('Credential fixture identity changed; cleanup refused and scope preserved.');
    }
  };
  const cleanup = async () => {
    if (cleaned) return;
    if (unsettledProcesses.size) throw new Error('Credential fixture process has not closed; cleanup refused and scope preserved.');
    await assertOwnedRoot();
    if (await currentProjectMutationLease(projectRoot)) throw new Error('Credential fixture lease remains active; cleanup refused.');
    const leasePath = await projectMutationLockPath(projectRoot);
    let leasePresent = false;
    try { await lstat(leasePath); leasePresent = true; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (leasePresent) throw new Error('Credential fixture lease path remains present; cleanup refused.');
    await assertOwnedRoot();
    await rm(root, { recursive: true });
    cleaned = true;
  };
  const now = new Date('2026-09-15T00:00:00.000Z');
  const storage = { homedir: home, repositoryRoot: projectRoot, env: {}, clock: () => now };
  const projectPlan = buildProjectPlan({
    projectName: 'Credential fixture', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus',
    environments: ['dev'], includeFrontend: false, specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true });
  const manifest = parseManifest(JSON.parse(buildArtifacts(projectPlan).find((artifact) => artifact.logicalName === 'manifest')!.content));
  const configuration: ActivationConfiguration = { schemaVersion: 1, phases: { 'credential-ready': {
    mode: 'enroll', credential: provider.target.configuration, principal: provider.target.principal, source: provider.target.source,
    protectedReference: provider.target.protectedReference, custodyVersion: provider.target.custodyVersion, ...phaseInputs
  } } };
  const state = validateUserActivationState({
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name: 'fixture', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: now.toISOString() },
    activeChange: null, activationInputs: configuration,
    applicability: { statePath: 'none', credentialRequired: true, privateStagingDast: false, cloudStateRequired: false, privateRunnerRequired: false },
    phases: Object.fromEntries(canonicalPhaseGraph.phases.map((phase) => [phase.id, {
      state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: []
    }])), createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  await mkdir(path.join(projectRoot, 'governance'));
  await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
  const inspection: GovernanceTransitionInspection = {
    projectRoot, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash, scope: 'activation',
    activationInputs: configuration, state, approvals: [], evidence: [],
    contexts: Object.fromEntries(canonicalPhaseGraph.phases.map((phase) => [phase.id, evidenceContextForPhase(phase.id, {
      repositoryId: state.repository.id, baselineSha: canonicalSha256('credential fixture baseline'), inputDigest: canonicalSha256(configuration),
      identity: currentActivationIdentity, phaseGraphHash: canonicalPhaseGraphHash
    })])) as GovernanceTransitionInspection['contexts'],
    readiness: {
      nextReadyPhase: null, nextPlannablePhase: 'credential-ready',
      phases: Object.fromEntries(canonicalPhaseGraph.phases.map((phase) => [phase.id, { state: 'pending', blockers: [] }])) as GovernanceTransitionInspection['readiness']['phases']
    },
    sourceOfTruth: { status: 'none', selected: null, candidates: [], createPlan: {
      status: 'blocked', changeId: 'fixture', workflowKind: 'openspec', reason: 'Credential fixture only.', requiredFacts: []
    } }
  };
  const runner: CommandRunner = { async run() { throw new Error('Tests must not invoke ambient accounts or external processes.'); } };
  return { root, projectRoot, home, storage, now, inspection, runner, provider, trackProcess, cleanup };
}

export async function approveCredentialOperations(
  fixture: Awaited<ReturnType<typeof credentialFixture>>,
  operations: readonly TransitionOperation[],
  options: { issue?: boolean; recovery?: boolean; fileChanges?: PlannedFileChange[] } = {}
): Promise<PhaseAdapterExecutionInput> {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'credential-ready')!;
  const context = fixture.inspection.contexts['credential-ready'];
  const requested = transitionPlanForPhase(phase, fixture.inspection.state, context.transition, fixture.projectRoot, undefined, {
    operations, configuration: fixture.inspection.activationInputs, selectionScope: 'activation',
    fileChanges: options.fileChanges ?? [], recovery: options.recovery ?? false
  });
  const envelope = validateApprovalEnvelope({
    ...requested, schemaVersion: 4, id: `credential-${randomUUID()}`,
    approvedAt: fixture.now.toISOString(), expiresAt: new Date(fixture.now.getTime() + 3600_000).toISOString(),
    approver: 'independent-fixture-operator'
  });
  const approvals = [...fixture.inspection.approvals, envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, approvals, { now: fixture.now });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id,
    createdAt: fixture.now.toISOString(), expiresAt: envelope.expiresAt, identity: fixture.inspection.state.identity,
    graphHash: fixture.inspection.graphHash, stateHash: fixture.inspection.loadedState?.contentHash ?? null,
    baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
    mutationClasses: phase.allowedMutations, operations,
    approval: { gateKind: phase.approvalGate.kind, required: true, evaluation, envelopeId: envelope.id, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase), configuration: fixture.inspection.activationInputs, fileChanges: options.fileChanges ?? [],
    recovery: options.recovery ?? false, noSecrets: true
  });
  if (options.issue !== false) await writeGovernanceApprovalAuthority(fixture.projectRoot, canonicalSha256({ fixture: envelope.id }), envelope, fixture.storage);
  return {
    inspection: { ...fixture.inspection, approvals }, phase, plan, runner: fixture.runner, now: fixture.now,
    adapters: { githubActivation: { transport: fixture.provider.transport, storage: fixture.storage } }, recovery: options.recovery
  };
}

export function enrollmentOperation(target = fixtureCredentialTarget): TransitionOperation {
  return {
    phaseId: 'credential-ready', adapter: 'github', actionId: 'github.credential.enroll-masked',
    mutationClass: 'github-secret-write',
    inputs: { enrollment: { kind: 'github-credential-enrollment.v1', target, expectedSecret: null,
      permissionBoundary: credentialPermissionBoundary(target.metadata.observedPermissions) } },
    destination: { type: 'repository', identity: target.repository, repository: target.repository },
    remote: true, destructive: false
  };
}
