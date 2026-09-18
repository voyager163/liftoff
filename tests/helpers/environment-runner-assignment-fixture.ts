import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, canonicalSha256, isRecord } from '../../src/domain/governance/activation/canonical-json.js';
import { transitionPlanForPhase, evaluateApprovalForTransitionPlan } from '../../src/domain/governance/activation/approvals.js';
import { planDigestFor, rollbackPlanForPhase } from '../../src/domain/governance/activation/operations.js';
import { evidenceBodyDigest, evidenceHeaderDigest, validateEvidenceFreshness } from '../../src/domain/governance/activation/evidence.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../src/domain/governance/activation/validators.js';
import type { PhaseEvidenceRecord } from '../../src/domain/governance/activation/types.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild
} from '../../src/governance-activation/transition-ports.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../../src/governance-activation/inputs.js';
import { loadActivationState } from '../../src/governance-activation/activation-state.js';
import { writeGovernanceApprovalAuthority } from '../../src/governance-activation/authority-records.js';
import { evidenceHeaderFor, saveTransitionPlan } from '../../src/governance-activation/transition-records.js';
import { withProjectMutationLock } from '../../src/adapters/filesystem/project-lock.js';
import { executePrivateRunner, planPrivateRunner } from '../../src/application/azure-activation/producer-runner.js';
import { validatePrivateRunnerAssignment } from '../../src/application/azure-activation/private-runner-assignment.js';
import type { PrivateRunnerApplicationSource } from '../../src/application/azure-activation/private-runner-application-sources.js';
import { renderPrivateRunnerWorkflow } from '../../src/application/azure-activation/private-runner-workflow.js';
import { bootstrapRunnerOutputs, privateRunnerHttpFixture, runnerSource } from './private-runner-http-fixture.js';

async function refreshed(input: PhasePlanningInput): Promise<void> {
  const { inspection } = input;
  const previous = inspection.contexts['runner-ready'];
  await writeFile(path.join(inspection.projectRoot, 'governance', 'activation-state.json'), canonicalJson(inspection.state));
  inspection.loadedState = await loadActivationState(inspection.projectRoot);
  const snapshot = await readActivationInputSnapshot(inspection.projectRoot, inspection.manifest, input.runner);
  const current = activationEvidenceContexts(inspection.graph, inspection.state, snapshot, input.now)['runner-ready'];
  inspection.contexts['runner-ready'] = {
    ...current, ...(previous.reviewedPlans ? { reviewedPlans: previous.reviewedPlans } : {}),
    ...(previous.evidenceReferences ? { evidenceReferences: previous.evidenceReferences } : {})
  };
}

async function issued(input: PhasePlanningInput, build: PhasePlanBuild): Promise<PhaseAdapterExecutionInput> {
  if (build.blockers?.length) throw new Error(build.blockers.join(' '));
  const storage = input.adapters?.githubActivation?.storage;
  if (!storage) throw new Error('Runner fixture requires the exact explicitly selected private store.');
  await refreshed(input);
  const { inspection, phase } = input;
  const context = inspection.contexts[phase.id];
  const configuration = structuredClone(inspection.activationInputs);
  const requested = transitionPlanForPhase(phase, inspection.state, context.transition, inspection.projectRoot, undefined, {
    operations: build.operations, configuration, selectionScope: 'activation', fileChanges: [], recovery: false
  });
  const envelope = validateApprovalEnvelope({
    ...requested, schemaVersion: 4, id: randomUUID(), approvedAt: input.now.toISOString(),
    expiresAt: '2026-09-15T00:20:00.000Z', approver: 'isolated-runner-assignment-operator'
  });
  await withProjectMutationLock(inspection.projectRoot, () =>
    writeGovernanceApprovalAuthority(inspection.projectRoot, canonicalSha256(requested), envelope, storage));
  inspection.approvals = [...inspection.approvals, envelope];
  const evaluation = evaluateApprovalForTransitionPlan(requested, [envelope], { now: input.now });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: 'activation', selectionScope: 'activation', phaseId: phase.id,
    createdAt: input.now.toISOString(), expiresAt: envelope.expiresAt,
    identity: inspection.state.identity, graphHash: inspection.graphHash,
    stateHash: inspection.loadedState!.contentHash, baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({
      phase, transitionDigest: context.transition.transitionDigest, operations: build.operations, approvalPlanDigest: requested.planDigest
    }),
    mutationClasses: phase.allowedMutations, operations: build.operations,
    approval: { gateKind: phase.approvalGate.kind, required: true, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
    rollbackPlan: rollbackPlanForPhase(phase), configuration, fileChanges: [], recovery: false, noSecrets: true
  });
  await saveTransitionPlan(inspection.projectRoot, plan);
  context.reviewedPlans = [...(context.reviewedPlans ?? []), plan];
  return { ...input, plan, adapters: input.adapters ?? {} };
}

async function retained(input: PhaseAdapterExecutionInput, outcome: PhaseAdapterOutcome) {
  if (outcome.status !== 'completed' || !isRecord(outcome.evidencePayload) || !outcome.liveReadback?.length || !outcome.outputs) {
    throw new Error(`Actual isolated runner producer did not complete: ${outcome.blocker ?? outcome.status}`);
  }
  if (!input.lease) throw new Error('Retaining runner evidence requires its actual project lease.');
  await input.lease.assertHeld();
  const payload = {
    ...outcome.evidencePayload, planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan),
    outputBindings: outcome.outputs
  };
  const header = evidenceHeaderFor({
    inspection: input.inspection, phase: input.phase, plan: input.plan, result: 'verified',
    now: input.now, payload, liveReadback: outcome.liveReadback
  });
  const record: PhaseEvidenceRecord = { evidenceId: randomUUID(), header, payload, liveReadback: outcome.liveReadback };
  const reference = {
    evidenceId: record.evidenceId, headerDigest: evidenceHeaderDigest(header),
    bodyDigest: evidenceBodyDigest(payload, outcome.liveReadback)
  };
  const stateReference = {
    evidenceId: record.evidenceId, phaseId: input.phase.id,
    pathParts: ['governance', 'evidence', `${record.evidenceId}.json`],
    headerDigest: reference.headerDigest, producedAt: header.producedAt, result: header.result
  };
  const validation = validateEvidenceFreshness(record, {
    ...input.inspection.contexts[input.phase.id], inputDigest: input.plan.inputDigest,
    reviewedPlans: [input.plan], evidenceReferences: [stateReference], now: input.now
  });
  if (!validation.valid) {
    throw new Error(`Original runner producer did not emit engine-admissible evidence: ${validation.issues.map((issue) => issue.message).join(' ')}`);
  }
  const directory = path.join(input.inspection.projectRoot, 'governance', 'evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await input.lease.assertHeld();
  await writeFile(path.join(directory, `${record.evidenceId}.json`), canonicalJson(record), { flag: 'wx', mode: 0o600 });
  input.inspection.evidence = [...input.inspection.evidence, record];
  input.inspection.contexts[input.phase.id].evidenceReferences = [stateReference];
  input.inspection.state.phases[input.phase.id] = {
    ...input.inspection.state.phases[input.phase.id], state: 'verified', evidence: [{
      evidenceId: record.evidenceId, phaseId: input.phase.id, headerDigest: reference.headerDigest, result: header.result
    }],
    updatedAt: input.now.toISOString()
  };
  input.inspection.state.phaseOutputs = {
    ...input.inspection.state.phaseOutputs, [input.phase.id]: structuredClone(outcome.outputs)
  };
  return { record, reference };
}

/** Runs real creation and separately issued allowlist reconciliation in the caller's same isolated project/store. */
export async function environmentRunnerAssignmentFixture(
  input: PhasePlanningInput, application: PrivateRunnerApplicationSource,
  additionalApplications: readonly PrivateRunnerApplicationSource[] = []
) {
  if (input.phase.id !== 'runner-ready') throw new Error('Runner fixture must use its actual registered phase.');
  const source = runnerSource();
  source.sourceSha = application.sourceSha;
  source.recipe.runnerGroupName = application.recipe.runner.group;
  source.recipe.runnerLabel = application.recipe.runner.label;
  source.workflowDigest = canonicalSha256(renderPrivateRunnerWorkflow(source.recipe));
  const configuration = {
    organizationId: 7, actorId: source.actorId, networkConfigurationName: 'repo-private-network',
    runnerGroupName: source.recipe.runnerGroupName, runnerName: source.recipe.runnerLabel,
    imageId: 'ubuntu-24.04', machineSize: '4-core', maxRunners: 2, source,
    expiresAt: '2026-09-15T00:30:00.000Z'
  };
  const inputs = input.inspection.activationInputs;
  if (!inputs) throw new Error('Runner fixture has no reviewed activation configuration.');
  input.inspection.state.applicability.statePath = 'bootstrap-local';
  input.inspection.state.applicability.privateRunnerRequired = true;
  input.inspection.state.phases['bootstrap-local'].state = 'verified';
  input.inspection.state.phaseOutputs = { ...input.inspection.state.phaseOutputs, 'bootstrap-local': bootstrapRunnerOutputs() };
  inputs.phases['runner-ready'] = configuration;
  input.inspection.state.activationInputs = inputs;
  const http = privateRunnerHttpFixture(source);
  const originInput = await issued(input, planPrivateRunner(input));
  const { created, origin } = await withProjectMutationLock(input.inspection.projectRoot, async (lease) => {
    const execution = { ...originInput, lease };
    const created = await executePrivateRunner(execution, { client: http.client });
    return { created, origin: await retained(execution, created) };
  });
  if (!isRecord(created.evidencePayload) || !isRecord(created.evidencePayload.assignment)) {
    throw new Error('Actual creation assignment observation is missing.');
  }
  const initial = validatePrivateRunnerAssignment(created.evidencePayload.assignment.binding);
  http.publishApplication(application);
  for (const additional of additionalApplications) http.publishApplication(additional);
  inputs.phases['runner-ready'] = {
    ...configuration, applicationSources: [application, ...additionalApplications],
    reconciliation: {
      originPlanDigest: originInput.plan.planDigest, groupId: initial.groupId, definitionId: initial.definitionId,
      networkConfigurationId: initial.networkConfigurationId, expectedWorkflows: initial.allowedWorkflows
    }
  };
  const assignmentInput = await issued(input, planPrivateRunner(input));
  const { reconciled, assignment } = await withProjectMutationLock(input.inspection.projectRoot, async (lease) => {
    const execution = { ...assignmentInput, lease };
    const reconciled = await executePrivateRunner(execution, { client: http.client });
    return { reconciled, assignment: await retained(execution, reconciled) };
  });
  if (!isRecord(reconciled.evidencePayload) || !isRecord(reconciled.evidencePayload.assignment)) {
    throw new Error('Actual separate assignment observation is missing.');
  }
  return {
    binding: validatePrivateRunnerAssignment(reconciled.evidencePayload.assignment.binding),
    reference: assignment.reference, http, source, origin, assignment, originInput, assignmentInput
  };
}
