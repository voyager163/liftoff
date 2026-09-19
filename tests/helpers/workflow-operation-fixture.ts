import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../../src/domain/governance/activation/graph.js';
import { phaseIds, phaseScope, type ActivationConfiguration, type PhaseId, type TransitionOperation } from '../../src/domain/governance/activation/types.js';
import { evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase } from '../../src/domain/governance/activation/operations.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState } from '../../src/domain/governance/activation/validators.js';
import { writeGovernanceApprovalAuthority } from '../../src/governance-activation/authority-records.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../../src/governance-activation/inputs.js';
import { loadActivationState } from '../../src/governance-activation/activation-state.js';
import { parseManifest } from '../../src/application/project/manifest.js';
import { buildProjectPlan } from '../../src/application/project/planning.js';
import { buildArtifacts } from '../../src/templates.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput } from '../../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../../src/process-runner.js';

export async function workflowOperationFixture(
  phaseId: PhaseId,
  planned: readonly TransitionOperation[] | ((inspection: GovernanceTransitionInspection) => Promise<readonly TransitionOperation[]>),
  runner: CommandRunner,
  options: { configuration?: ActivationConfiguration; predecessorSourceSha?: string; files?: readonly { path: string; content: string }[] } = {}
) {
  const root = path.resolve(`tests/.workflow-operation-${randomUUID()}`);
  const projectRoot = path.join(root, 'project');
  const home = path.join(root, 'home');
  await mkdir(path.join(projectRoot, 'governance'), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const now = new Date('2026-09-15T00:00:00.000Z');
  const storage = { homedir: home, repositoryRoot: projectRoot, env: {}, clock: () => now };
  const projectPlan = buildProjectPlan({
    projectName: 'Workflow operation', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
    region: 'eastus', environments: ['dev'], includeFrontend: false, specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true });
  const manifest = parseManifest(JSON.parse(buildArtifacts(projectPlan).find((artifact) => artifact.logicalName === 'manifest')!.content));
  const state = validateUserActivationState({
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name: 'fixture', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: now.toISOString() },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false, cloudStateRequired: false, privateRunnerRequired: false },
    phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: [] }])),
    ...(options.configuration ? { activationInputs: options.configuration } : {}),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  for (const file of options.files ?? []) {
    const destination = path.resolve(projectRoot, file.path);
    if (!destination.startsWith(`${projectRoot}${path.sep}`)) throw new Error('Fixture file must stay in its own exact project root.');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  if (options.predecessorSourceSha) {
    state.phases['repository-workflow-source-ready'].state = 'verified';
    state.phaseOutputs = { 'repository-workflow-source-ready': {
      values: { sourceSha: options.predecessorSourceSha },
      resources: [{ provider: 'github', resourceType: 'workflow-source', resourceId: `/repos/owner/repo/git/commits/${options.predecessorSourceSha}` }]
    } };
  }
  await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
  const readOnly: CommandRunner = { async run(command) {
    return { command, status: 128, signal: null, timedOut: false, stdout: '', stderr: '', displayCommand: 'isolated fixture has no Git worktree' };
  } };
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, readOnly);
  const inspection: GovernanceTransitionInspection = {
    projectRoot, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash,
    scope: phaseScope(phaseId), state, approvals: [], evidence: [],
    ...(options.configuration ? { activationInputs: options.configuration } : {}),
    contexts: activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now),
    loadedState: await loadActivationState(projectRoot),
    readiness: { nextReadyPhase: phaseId, nextPlannablePhase: phaseId,
      phases: state.phases },
    sourceOfTruth: { status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', changeId: 'isolated-workflow-operation', workflowKind: 'openspec',
        reason: 'Fixture authority is not activation or qualification completion.', requiredFacts: [] } }
  };
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const context = inspection.contexts[phaseId];
  let operations: readonly TransitionOperation[];
  try { operations = typeof planned === 'function' ? await planned(inspection) : planned; } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const requested = transitionPlanForPhase(phase, state, context.transition, projectRoot, undefined, {
    operations, selectionScope: phaseScope(phaseId), fileChanges: [], recovery: false,
    ...(options.configuration ? { configuration: options.configuration } : {})
  });
  const envelope = validateApprovalEnvelope({
    ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: now.toISOString(), expiresAt, approver: 'isolated-workflow-test-operator'
  });
  await writeGovernanceApprovalAuthority(projectRoot, canonicalSha256(requested), envelope, storage);
  inspection.approvals = [envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: phaseScope(phaseId), selectionScope: phaseScope(phaseId), phaseId,
    createdAt: now.toISOString(), expiresAt, identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
    stateHash: inspection.loadedState!.contentHash, baselineDigest: context.baselineSha,
    inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: requested.planDigest }),
    mutationClasses: phase.allowedMutations, operations,
    approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase), fileChanges: [], recovery: false, noSecrets: true,
    ...(options.configuration ? { configuration: options.configuration } : {})
  });
  const input: PhaseAdapterExecutionInput = {
    inspection, plan, phase, runner, now, adapters: { githubActivation: { storage } }
  };
  return { root, projectRoot, home, storage, input, envelope, cleanup: () => rm(root, { recursive: true, force: true }) };
}
