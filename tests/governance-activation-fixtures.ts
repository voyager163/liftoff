import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import {
  activationEvidenceContexts, canonicalSha256, canonicalPhaseGraph, currentActivationIdentity,
  evidenceBodyDigest, evidenceContextForPhase, evidenceHeaderDigest, evaluateApprovalForTransitionPlan,
  planDigestFor, readActivationInputSnapshot, remoteBindingDigest, selectSeedBaselineChecks,
  transitionPlanForPhase, validateSavedTransitionPlan,
  type EvidenceFreshnessContext, type EvidenceHeader, type LiveReadbackProof, type PhaseEvidenceRecord,
  type PhaseId, type SavedTransitionPlan, type TransitionOperation, type UserActivationState
} from '../src/governance-activation/index.js';

export const fixtureBaseline = canonicalSha256('explicit activation test baseline');
export const fixtureInput = canonicalSha256('explicit activation test input');
export const fixtureSubscription = '00000000-0000-0000-0000-000000000001';
export const fixtureRemoteBinding = {
  id: 'R_REMOTE', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git',
  verifiedAt: '2026-09-04T00:00:00.000Z'
};

export function fixtureContext(phaseId: PhaseId, overrides: Parameters<typeof evidenceContextForPhase>[1] = {}) {
  return evidenceContextForPhase(phaseId, {
    repositoryId: 'R_123', baselineSha: fixtureBaseline, inputDigest: fixtureInput, ...overrides
  });
}

export function fixturePayload(phaseId: PhaseId): Record<string, unknown> {
  return {
    kind: phaseId === 'phase-0-complete' ? 'phase-0-discovery.v1' : `${phaseId}.v1`,
    ...(phaseId === 'phase-0-complete' ? { facts: [
      { id: 'repository.id', value: 'R_REMOTE' }, { id: 'repository.nameWithOwner', value: 'owner/repo' },
      { id: 'repository.defaultBranch', value: 'develop' }
    ] } : {}),
    ...(phaseId === 'seed-verified' ? { checks: [{ id: 'backend-tests', taskId: '2.2', status: 'passed' }] } : {}),
    ...(phaseId === 'state-path-selected' ? { statePath: 'bootstrap-local' } : {}),
    ...(['committed', 'pushed'].includes(phaseId) ? { head: 'a'.repeat(40), pushUrl: fixtureRemoteBinding.pushUrl } : {})
  };
}

export function fixtureHeader(phaseId: PhaseId, overrides: Partial<EvidenceHeader> = {}): EvidenceHeader {
  const context = fixtureContext(phaseId);
  return {
    schemaVersion: 2, repositoryId: context.repositoryId, identity: context.identity, phaseGraphHash: context.phaseGraphHash,
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
    case 'phase-0-complete': operations.push(operation('github.phase0.discover', 'github-read', 'github', repository, {}, true)); break;
    case 'credential-ready': operations.push(operation('github.credential.verify-policy', 'github-read', 'github', repository, {}, true)); break;
    case 'state-path-selected': operations.push(operation('azure.state-path.select', 'azure-read', 'azure-opentofu', subscription, {}, true)); break;
    case 'remote-import-verified': operations.push(operation('azure.remote-import.verify', 'azure-state-import', 'azure-opentofu', subscription, {}, true)); break;
    case 'remote-ready': operations.push(operation('azure.remote-ready.verify', 'azure-read', 'azure-opentofu', subscription, {}, true)); break;
    case 'workflow-source-ready':
      operations.push(operation('local.workflow-source.write', 'write-workflows', 'local-state', local('.github/workflows')));
      operations.push(operation('local.ruleset-source.write', 'write-ruleset-source', 'local-state', local('.github/rulesets'))); break;
    case 'green-red-proof': operations.push(operation('github.checks.green-red-proof', 'github-read', 'github', repository, {}, true)); break;
    case 'rulesets-applied':
      operations.push(operation('github.ruleset.apply', 'github-ruleset-write', 'github', repository, { sourceDigest: payload.sourceDigest ?? 'b'.repeat(64) }, true));
      operations.push(operation('github.ruleset.readback', 'github-read', 'github', repository, { sourceDigest: payload.sourceDigest ?? 'b'.repeat(64) }, true)); break;
    case 'bootstrap-state-disposed': operations.push(operation('local.bootstrap-state.dispose', 'delete-local-state', 'local-state', local('governance/activation-state.json'), {}, false, true)); break;
    default: throw new Error(`No reviewed fixture operation contract for ${phase.id}.`);
  }
  operations.push(operation('governance.evidence.write', 'write-evidence', 'local-evidence', local(`governance/evidence/${phase.id}.json`)));
  operations.push(operation('governance.activation-state.write', 'write-activation-state', 'local-evidence', local('governance/activation-state.json')));
  const requested = transitionPlanForPhase(phase, state, context.transition, root, context.publicationDestination);
  const envelope = { ...requested, schemaVersion: 2, id: `${phase.id}-review`, approver: 'fixture-owner',
    approvedAt: producedAt, expiresAt: new Date(Date.parse(producedAt) + 3_600_000).toISOString() };
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now: new Date(producedAt) });
  return validateSavedTransitionPlan({
    schemaVersion: 1, phaseId: phase.id, createdAt: producedAt, expiresAt: envelope.expiresAt,
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
  const liveReadback = record.liveReadback?.map((proof): LiveReadbackProof => ({
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
