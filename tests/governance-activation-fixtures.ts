import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from '../src/application/project/manifest.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { generatedManifestStandards, preserveManifestProvenance } from '../src/application/project/manifest-provenance.js';
import { liftoffVersion } from '../src/version.js';
import { buildRepositoryGovernanceArtifacts } from '../src/application/repository-governance/artifacts.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import {
  activationEvidenceContexts, canonicalSha256, canonicalPhaseGraph, currentActivationIdentity,
  evidenceBodyDigest, evidenceContextForPhase, evidenceHeaderDigest, evaluateApprovalForTransitionPlan,
  phaseScope, planDigestFor, readActivationInputSnapshot, remoteBindingDigest, selectSeedBaselineChecks,
  transitionPlanForPhase, validateSavedTransitionPlan,
  type EvidenceFreshnessContext, type EvidenceHeader, type LiveReadbackProof, type PhaseEvidenceRecord,
  type PhaseId, type SavedTransitionPlan, type TransitionOperation, type UserActivationState
} from '../src/governance-activation/index.js';

export const fixtureBaseline = canonicalSha256('explicit activation test baseline');
export const fixtureInput = canonicalSha256('explicit activation test input');
export const fixtureSubscription = '00000000-0000-0000-0000-000000000001';
export const fixtureRemoteBinding = {
  id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git',
  verifiedAt: '2026-09-04T00:00:00.000Z'
};

export function githubDiscoveryCliFixture(
  command: ExternalCommand, repository = 'owner/repo', id = 42, head = 'a'.repeat(40)
): string | undefined {
  if (command.executable !== 'gh' || command.args[0] !== 'api') return undefined;
  const requested = command.args.find((argument) => argument.startsWith('/'));
  const endpoint = requested?.split('?')[0];
  const base = `/repos/${repository}`;
  const org = `/orgs/${repository.split('/')[0]}`;
  const entries: Record<string, unknown> = {
    [base]: { id, full_name: repository, default_branch: 'develop', private: true,
      owner: { login: repository.split('/')[0], type: 'Organization', id: 3 }, permissions: { admin: true, push: true, pull: true } },
    '/user': { id: 7, login: 'fixture-owner', type: 'User' },
    [`${base}/branches`]: [{ name: 'develop', commit: { sha: head }, protected: false }],
    [`${base}/actions/workflows`]: { total_count: 0, workflows: [] },
    [`${base}/environments`]: { total_count: 0, environments: [] },
    [`${base}/actions/permissions`]: { enabled: true, allowed_actions: 'all' },
    [`${base}/actions/permissions/workflow`]: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    [`${base}/commits/${head}/check-runs`]: { total_count: 0, check_runs: [] },
    [`${base}/git/ref/heads/develop`]: { ref: 'refs/heads/develop', object: { sha: head, type: 'commit' } },
    [`${org}/actions/hosted-runners`]: { total_count: 0, runners: [] },
    [`${org}/actions/runner-groups`]: { total_count: 0, runner_groups: [] },
    [`${org}/settings/network-configurations`]: { total_count: 0, network_configurations: [] }
  };
  for (const suffix of ['rulesets', 'tags', 'releases', 'deployments', 'code-scanning/alerts', 'secret-scanning/alerts', 'dependabot/alerts']) {
    entries[`${base}/${suffix}`] = [];
  }
  if (!endpoint || !Object.hasOwn(entries, endpoint)) return 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Unknown fixture endpoint"}';
  return `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(entries[endpoint])}`;
}

export function currentGovernanceManifest(
  projectName: string,
  environments: Parameters<typeof buildProjectPlan>[0]['environments'] = ['dev']
): Record<string, any> {
  const plan = buildProjectPlan({
    projectName, projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
    region: 'eastus', environments, includeFrontend: false,
    specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true });
  return JSON.parse(buildArtifacts(plan).find((artifact) => artifact.logicalName === 'manifest')!.content);
}

export async function successorFixtureManifest(root: string) {
  const original = await readFile(path.join(root, 'liftoff.manifest.json'));
  const source = parseManifest(JSON.parse(original.toString('utf8')));
  const workload = source.project.workload;
  if (workload.kind === 'components') throw new Error('Historical generated-workload fixture required.');
  const plan = buildProjectPlan({
    projectName: source.project.name, projectType: workload.kind, apiStack: workload.apiStack,
    ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
    cloud: workload.cloud, region: workload.region, environments: workload.environments,
    includeFrontend: workload.frontend, specWorkflow: source.project.specWorkflow,
    agents: source.project.agents, defaultAgent: source.project.defaultAgent
  }, { requireProjectName: true });
  const preserved = preserveManifestProvenance(source, original);
  if (preserved.history?.type === 'write') {
    await mkdir(path.join(root, ...preserved.history.pathParts.slice(0, -1)), { recursive: true });
    await writeFile(path.join(root, ...preserved.history.pathParts), preserved.history.content, { mode: preserved.history.mode });
  }
  const core = buildRepositoryGovernanceArtifacts(plan);
  for (const artifact of core) {
    await mkdir(path.join(root, ...artifact.pathParts.slice(0, -1)), { recursive: true });
    await writeFile(path.join(root, ...artifact.pathParts), artifact.content);
  }
  return parseManifest({
    ...source, artifactVersion: 8, liftoffVersion,
    standards: generatedManifestStandards(plan), provenance: preserved.provenance,
    managedArtifacts: [
      ...source.managedArtifacts.filter((artifact) => !core.some((entry) => entry.logicalName === artifact.logicalName)),
      ...core.map((artifact) => ({
        logicalName: artifact.logicalName, category: artifact.category, pathParts: artifact.pathParts,
        contentHash: `sha256:${rawFixtureDigest(artifact.content)}`
      }))
    ],
    governance: { ...source.governance, policyVersion: currentActivationIdentity.policyVersion, activationIdentity: currentActivationIdentity }
  });
}

function rawFixtureDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function fixtureContext(phaseId: PhaseId, overrides: Parameters<typeof evidenceContextForPhase>[1] = {}) {
  return evidenceContextForPhase(phaseId, {
    repositoryId: 'R_123', baselineSha: fixtureBaseline, inputDigest: fixtureInput, ...overrides
  });
}

export function fixturePayload(phaseId: PhaseId): Record<string, unknown> {
  return {
    kind: phaseId === 'phase-0-complete' ? 'phase-0-discovery.v1' : `${phaseId}.v1`,
    ...(phaseId === 'phase-0-complete' ? { facts: [
      { id: 'repository.id', value: '42' }, { id: 'repository.nameWithOwner', value: 'owner/repo' },
      { id: 'repository.defaultBranch', value: 'develop' }
      , { id: 'azure.accountReadable', value: true }, { id: 'azure.accountState', value: 'Enabled' },
      { id: 'azure.subscriptionId', value: fixtureSubscription }, { id: 'azure.tenantId', value: fixtureSubscription }
    ] } : {}),
    ...(phaseId === 'seed-verified' ? { checks: [{ id: 'backend-tests', taskId: '2.2', status: 'passed' }] } : {}),
    ...(phaseId === 'state-path-selected' ? { statePath: 'bootstrap-local' } : {}),
    ...(['committed', 'pushed'].includes(phaseId) ? { head: 'a'.repeat(40), pushUrl: fixtureRemoteBinding.pushUrl } : {})
  };
}

export function fixtureHeader(phaseId: PhaseId, overrides: Partial<EvidenceHeader> = {}): EvidenceHeader {
  const context = fixtureContext(phaseId);
  return {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion, repositoryId: context.repositoryId, identity: context.identity, phaseGraphHash: context.phaseGraphHash,
    phaseId, phaseContractDigest: context.phaseContractDigest, baselineSha: context.baselineSha,
    inputDigest: context.inputDigest, transition: context.transition, producedAt: '2026-09-04T00:00:00.000Z',
    producer: 'versioned-test-fixture', result: 'verified', bodyDigest: evidenceBodyDigest(fixturePayload(phaseId)),
    ...overrides
  };
}

export async function writeIndependentInfrastructureFixture(root: string): Promise<void> {
  const manifestPath = path.join(root, 'liftoff.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const workload = manifest.project.workload;
  const plan = buildProjectPlan({
    projectName: manifest.project.name, projectType: workload.kind, apiStack: workload.apiStack,
    ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
    cloud: workload.cloud, region: workload.region, environments: workload.environments,
    includeFrontend: workload.frontend, specWorkflow: manifest.project.specWorkflow,
    agents: manifest.project.agents, defaultAgent: manifest.project.defaultAgent
  }, { requireProjectName: true });
  const artifacts = buildArtifacts(plan);
  const generated = JSON.parse(artifacts.find((artifact) => artifact.pathParts.join('/') === 'liftoff.manifest.json')!.content);
  for (const artifact of artifacts.filter((artifact) => artifact.category === 'infrastructure')) {
    await mkdir(path.join(root, ...artifact.pathParts.slice(0, -1)), { recursive: true });
    await writeFile(path.join(root, ...artifact.pathParts), artifact.content);
  }
  manifest.projectArtifacts = [
    ...manifest.projectArtifacts.filter((artifact: { category: string }) => artifact.category !== 'infrastructure'),
    ...generated.projectArtifacts.filter((artifact: { category: string }) => artifact.category === 'infrastructure')
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

export async function writeBootstrapFixture(root: string, name: string, archived: boolean): Promise<void> {
  const change = `bootstrap-${name}`;
  const base = archived ? ['openspec', 'changes', 'archive', `20260904-${change}`] : ['openspec', 'changes', change];
  const capability = 'node-fastify-application-baseline';
  const spec = '## Purpose\n\nExercise the generated Node baseline without provider mutations.\n\n## ADDED Requirements\n\n### Requirement: Baseline exists\nThe system SHALL have a local baseline.\n\n#### Scenario: Check local files\n- **WHEN** validation runs\n- **THEN** the baseline is present\n';
  const files: Array<[string[], string]> = [
    [[...base, '.openspec.yaml'], 'schema: spec-driven\n'],
    [[...base, 'proposal.md'], `## Capabilities\n\n### New Capabilities\n\n- \`${capability}\`: Local baseline\n`],
    [[...base, 'design.md'], '## Context\n\nLocal baseline only; no product implementation.\n'],
    [[...base, 'tasks.md'], '- [ ] 1.1 Inspect generated files\n- [ ] 2.1 Validate locally\n'],
    [[...base, 'specs', capability, 'spec.md'], spec]
  ];
  if (archived) files.push([['openspec', 'specs', capability, 'spec.md'], `# ${capability}\n\n${spec.replace('## ADDED Requirements', '## Requirements')}`]);
  for (const [parts, content] of files) {
    await mkdir(path.join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(path.join(root, ...parts), content);
  }
}

export function fixturePlan(context: EvidenceFreshnessContext, state: UserActivationState, producedAt: string, payload: Record<string, unknown>, root: string): SavedTransitionPlan {
  const phase = canonicalPhaseGraph.phases.find((node) => node.id === context.phaseId)!;
  const operation = (actionId: string, mutationClass: TransitionOperation['mutationClass'], adapter: TransitionOperation['adapter'], destination: TransitionOperation['destination'], inputs: Record<string, unknown> = {}, remote = false, destructive = false): TransitionOperation =>
    ({ actionId, mutationClass, adapter, destination, inputs, remote, destructive, phaseId: phase.id });
  const local = (identity: string) => ({ type: 'local' as const, identity, ...(!path.isAbsolute(identity) ? { pathParts: identity.split('/') } : {}) });
  const repository = { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo' };
  const subscription = { type: 'subscription' as const, identity: fixtureSubscription, subscriptionId: fixtureSubscription };
  const operations: TransitionOperation[] = [];
  switch (phase.id) {
    case 'seed-valid': operations.push(operation('openspec.seed.validate', 'read-worktree', 'selected-spec-workflow', local(root))); break;
    case 'seed-verified': operations.push(operation('openspec.seed.baseline-verify', 'read-worktree', 'selected-spec-workflow', local(root), {
      checks: (payload.checks as Array<{ id: string; taskId: string; status: string }>).map((check) => ({ id: check.id, taskId: check.taskId, applicable: check.status !== 'inapplicable' }))
    })); break;
    case 'seed-archived': operations.push(operation('openspec.seed.archive', 'write-openspec-seed', 'selected-spec-workflow', local('openspec/changes'))); break;
    case 'committed': operations.push(operation('git.verify-existing-commit', 'read-worktree', 'git', local('develop'))); break;
    case 'pushed': operations.push(operation('git.verify-existing-push', 'github-read', 'git', { ...repository, identity: fixtureRemoteBinding.pushUrl }, {}, true)); break;
    case 'phase-0-complete':
      operations.push(operation('github.phase0.discover', 'github-read', 'github', repository, {}, true));
      operations.push(operation('azure.phase0.discover', 'azure-read', 'azure-opentofu', subscription, {}, true));
      break;
    case 'credential-ready': operations.push(operation('github.credential.verify-policy', 'github-read', 'github', repository, {}, true)); break;
    case 'state-path-selected': operations.push(operation('azure.state-path.select', 'azure-read', 'azure-opentofu', subscription, {}, true)); break;
    case 'remote-import-verified': operations.push(operation('azure.remote-import.verify', 'azure-state-import', 'azure-opentofu', subscription, {}, true)); break;
    case 'remote-ready': operations.push(operation('azure.remote-ready.verify', 'azure-read', 'azure-opentofu', subscription, {}, true)); break;
    case 'workflow-source-ready':
      operations.push(operation('local.workflow-source.write', 'write-workflows', 'local-state', local('.github/workflows')));
      operations.push(operation('local.ruleset-source.write', 'write-ruleset-source', 'local-state', local('.github/rulesets')));
      operations.push(operation('github.workflow-source.verify', 'github-read', 'github', repository,
        { sourceDigest: payload.rulesetSourceDigest }, true)); break;
    case 'green-red-proof': operations.push(operation('github.checks.green-red-proof', 'github-workflow-dispatch', 'github', repository, {}, true)); break;
    case 'rulesets-applied':
      operations.push(operation('github.ruleset.apply', 'github-ruleset-write', 'github', repository, { sourceDigest: payload.sourceDigest ?? 'b'.repeat(64) }, true));
      operations.push(operation('github.ruleset.readback', 'github-read', 'github', repository, { sourceDigest: payload.sourceDigest ?? 'b'.repeat(64) }, true)); break;
    case 'bootstrap-state-disposed': operations.push(operation('local.bootstrap-state.dispose', 'delete-local-state', 'local-state', local('governance/activation-state.json'), {}, false, true)); break;
    default: throw new Error(`No reviewed fixture operation contract for ${phase.id}.`);
  }
  operations.push(operation('governance.evidence.write', 'write-evidence', 'local-evidence', local(`governance/evidence/${phase.id}.json`)));
  operations.push(operation('governance.activation-state.write', 'write-activation-state', 'local-evidence', local('governance/activation-state.json')));
  const requested = transitionPlanForPhase(phase, state, context.transition, root, context.publicationDestination, { operations });
  const envelope = { ...requested, schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion, id: `${phase.id}-review`, approver: 'fixture-owner',
    approvedAt: producedAt, expiresAt: new Date(Date.parse(producedAt) + 3_600_000).toISOString() };
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now: new Date(producedAt) });
  return validateSavedTransitionPlan({
    schemaVersion: 2, scope: phaseScope(phase.id), phaseId: phase.id, createdAt: producedAt, expiresAt: envelope.expiresAt,
    identity: context.identity, graphHash: context.phaseGraphHash, stateHash: null,
    baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
    mutationClasses: phase.allowedMutations, operations,
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation, envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: { phaseId: phase.id, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] },
    noSecrets: true
  });
}

export async function bindFixtureEvidence(root: string, state: UserActivationState, record: PhaseEvidenceRecord) {
  const manifest = await loadManifest(root);
  const snapshot = await readActivationInputSnapshot(root, manifest);
  const context = activationEvidenceContexts(canonicalPhaseGraph, state, snapshot)[record.header.phaseId];
  const phaseId = record.header.phaseId;
  const old = record.header;
  const baselineSha = old.baselineSha === fixtureBaseline ? context.baselineSha : old.baselineSha;
  const inputDigest = old.inputDigest === fixtureInput ? context.inputDigest : old.inputDigest;
  const payload = { ...fixturePayload(phaseId), ...(record.payload as Record<string, unknown> | undefined) };
  if (phaseId === 'seed-verified') payload.checks = selectSeedBaselineChecks(manifest).map((check) =>
    ({ id: check.id, taskId: check.taskId, status: check.applicability.applicable ? 'passed' : 'inapplicable' }));
  if (phaseId === 'seed-archived' && snapshot.workflowSpecDigest) payload.synchronizedSpecDigest = snapshot.workflowSpecDigest;
  const plan = fixturePlan(context, state, old.producedAt, payload, root);
  const existingReadback = [...record.liveReadback ?? []];
  if (phaseId === 'phase-0-complete' && !existingReadback.some((proof) => proof.provider === 'azure')) {
    existingReadback.push({
      schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
      identity: currentActivationIdentity, repositoryId: state.repository.id, phaseGraphHash: currentActivationIdentity.phaseGraphHash,
      phaseId, baselineSha, inputDigest, transition: { ...context.transition, baselineSha, inputDigest },
      observedAt: old.producedAt, provider: 'azure', resourceType: 'subscription',
      resourceId: `/subscriptions/${fixtureSubscription}`, sourceDigest: canonicalSha256('fixture-account-readback'),
      readbackDigest: canonicalSha256('fixture-account-readback'), matches: true
    });
  }
  const liveReadback = existingReadback.map((proof): LiveReadbackProof => ({
    ...proof,
    baselineSha: proof.baselineSha === fixtureBaseline ? baselineSha : proof.baselineSha,
    inputDigest: proof.inputDigest === fixtureInput ? inputDigest : proof.inputDigest,
    transition: proof.transition.transitionDigest === fixtureContext(phaseId).transition.transitionDigest
      ? { ...context.transition, baselineSha, inputDigest } : proof.transition,
    resourceId: proof.resourceId === 'owner/repo/rulesets/1' ? '/repos/owner/repo/rulesets/1' :
      proof.resourceId === '/subscriptions/000/resourceGroups/rg' ? `/subscriptions/${fixtureSubscription}/resourceGroups/rg` : proof.resourceId
  }));
  payload.planDigest = plan.planDigest;
  payload.savedPlanDigest = canonicalSha256(plan);
  const header: EvidenceHeader = {
    ...old, baselineSha, inputDigest, transition: { ...context.transition, baselineSha, inputDigest },
    bodyDigest: evidenceBodyDigest(payload, liveReadback),
    ...(!phaseId.startsWith('seed-') && phaseId !== 'committed' && phaseId !== 'pushed' ? { remoteBindingDigest: remoteBindingDigest(state.remoteBinding) } : {})
  };
  return { record: { ...record, header, payload, liveReadback }, plan, context };
}

export async function persistFixtureEvidence(root: string, state: UserActivationState, record: PhaseEvidenceRecord) {
  const bound = await bindFixtureEvidence(root, state, record);
  await mkdir(path.join(root, 'governance', 'plans'), { recursive: true });
  await mkdir(path.join(root, 'governance', 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'governance', 'plans', `${record.evidenceId}.json`), JSON.stringify(bound.plan));
  await writeFile(path.join(root, 'governance', 'evidence', `${record.evidenceId}.json`), JSON.stringify(bound.record));
  const phase = state.phases[record.header.phaseId];
  phase.evidence = [...phase.evidence.filter((reference) => reference.evidenceId !== record.evidenceId), {
    phaseId: record.header.phaseId, evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(bound.record.header), result: record.header.result
  }];
  return bound;
}
