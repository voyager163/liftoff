import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { assertOperationAllowed, operation, transitionDestination } from '../../domain/governance/activation/operations.js';
import type { TransitionOperation, ExternalOperationState } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput, PhasePlanBuild } from '../../governance-activation/transition-ports.js';
import { githubOperation } from '../../governance-activation/github-config.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { dispatchApprovedWorkflowRun } from '../../adapters/github/production-checks.js';
import { safeGitHubFailure } from '../../adapters/github/activation-rest.js';
import type { ApplicationPrivateAdapters } from '../../adapters/azure/application-private-runtime.js';
import { ApplicationPrivateError } from './application-private-contracts.js';
import { AzureActivationAdmissionError } from './authority.js';
import {
  configuredDisposableTarget, qualificationFailure, qualificationObject, requireDisposableQualificationAuthority,
  requireEnvironmentActivationScope
} from './qualification-authority.js';
import { qualificationEvidenceReference, requireQualificationEvidence } from './qualification-evidence.js';
import {
  applicationPrivateReceiptOperation, readCompletedApplicationPrivateReceipt, type ApplicationPrivateReceiptReference
} from './application-private-receipt.js';
import { environmentRuntimeInputs, type EnvironmentRuntimeInputs } from './environment-runtime-inputs.js';
import { readEnvironmentRuntimeProof } from './environment-runtime-proof.js';
import { environmentRuntimeRunnerReadEffects } from './environment-runtime-assignment.js';
import { blockedQualificationOutcome } from './qualification-checkpoints.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { applicationPrivateInputs } from './application-private-inputs.js';
import { applicationPrivateBackendArtifact } from './application-private-artifacts.js';

export const devProofRecipeId = 'private-foundation-runtime-observation/1' as const;

function configuration(input: PhasePlanningInput): { foundation: ApplicationPrivateReceiptReference; runtime: EnvironmentRuntimeInputs } {
  requireEnvironmentActivationScope(input);
  if (input.phase.id !== 'dev-proof') qualificationFailure('dev-phase', 'Development proof requires its own explicitly approved phase.');
  const config = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const fields = qualificationObject(config?.phases['dev-proof'], ['disposableTarget', 'foundation', 'observation'], 'Development proof');
  const disposableTarget = configuredDisposableTarget(input, 'dev');
  const observation = qualificationObject(fields.observation, ['workflow', 'runtime', 'runnerAssignment', 'dispatchInputs'], 'Development observation');
  const runtime = environmentRuntimeInputs({ ...observation, disposableTarget });
  const foundation: ApplicationPrivateReceiptReference = {
    phaseId: 'application-foundation', evidence: qualificationEvidenceReference(fields.foundation)
  };
  const { record, plan } = requireQualificationEvidence(input.inspection, 'application-foundation', foundation.evidence, input.now);
  const payload = record.payload;
  const actual = isRecord(payload) ? payload.applicationPrivate : undefined;
  const originalPhase = canonicalPhaseGraph.phases.find((phase) => phase.id === 'application-foundation')!;
  const original = applicationPrivateInputs({
    phase: originalPhase, inspection: { ...input.inspection, activationInputs: plan.configuration }
  });
  const artifact = applicationPrivateBackendArtifact(original);
  const resources = isRecord(actual) ? actual.observations : undefined;
  if (!isRecord(actual) || actual.status !== 'executed' || actual.additionalReview !== null || !artifact ||
    runtime.disposableTarget.target.environment !== 'dev' || artifact.sourceSha !== runtime.workflow.sourceSha ||
    artifact.imageRef !== runtime.runtime.imageRef || !Array.isArray(resources) ||
    !resources.some((resource) => isRecord(resource) && resource.resourceId === disposableTarget.target.resourceId &&
      resource.resourceType === 'Microsoft.App/containerApps' && resource.verified === true)) {
    qualificationFailure('dev-foundation-binding', 'Development observes the exact completed native foundation, source and immutable artifact. A deployment assertion, core-only stage, repository check or unrelated runtime cannot substitute.');
  }
  if (original.artifactSet && original.targets.find((target) => target.address ===
    original.artifactSet!.deployments.backend.address)?.resourceId !== disposableTarget.target.resourceId) {
    qualificationFailure('dev-artifact-role', 'The development API observation must select the actual backend role; a frontend document is not an API health/schema substitute.');
  }
  return { foundation, runtime };
}

async function operations(input: PhasePlanningInput) {
  const config = configuration(input);
  const receipt = await applicationPrivateReceiptOperation(input, config.foundation);
  const dispatch = githubOperation(input, 'github.checks.dev-proof', 'github-workflow-dispatch', { ...config.runtime }, undefined, [{
    mutationClass: 'github-read', destination: transitionDestination('repository', config.runtime.workflow.repository, {
      repository: config.runtime.workflow.repository
    }), remote: true, destructive: false
  }, ...environmentRuntimeRunnerReadEffects(config.runtime)]);
  const readback = operation({
    phaseId: 'dev-proof', adapter: 'azure-opentofu', actionId: 'azure.dev.readback', mutationClass: 'azure-read',
    remote: true, destructive: false,
    destination: transitionDestination('subscription', config.runtime.disposableTarget.target.resourceId, {
      subscriptionId: config.runtime.disposableTarget.target.subscriptionId
    }), inputs: { ...config.runtime }
  });
  const planned = [receipt, dispatch, readback];
  for (const selected of planned) assertOperationAllowed(input.phase, selected);
  return { config, receipt, dispatch, readback, planned };
}

function failure(error: unknown): string {
  if (error instanceof AzureActivationAdmissionError) return error.message;
  if (error instanceof ApplicationPrivateError) return `Development private foundation readback failed (${error.code}); retain original records.`;
  return safeGitHubFailure(error);
}

export async function planProductionDevProof(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try { return { operations: (await operations(input)).planned }; }
  catch (error) { return { operations: [], blockers: [failure(error)] }; }
}

export async function executeProductionDevProof(
  input: PhaseAdapterExecutionInput, adapters: ApplicationPrivateAdapters = {}
): Promise<PhaseAdapterOutcome> {
  let current: ExternalOperationState | undefined = input.inspection.state.phases['dev-proof'].operation;
  const completed: TransitionOperation[] = [];
  try {
    const selected = await operations({ ...input, now: input.clock?.() ?? input.now });
    if (canonicalSha256(input.plan.operations.filter((entry) => entry.remote)) !== canonicalSha256(selected.planned)) {
      qualificationFailure('dev-plan-drift', 'The exact completed-foundation, development workflow and Azure readback operations changed after review.');
    }
    await requireDisposableQualificationAuthority(input, 'dev', selected.dispatch);
    const foundation = await readCompletedApplicationPrivateReceipt(input, selected.config.foundation, selected.receipt, adapters);
    completed.push(selected.receipt);
    const dispatched = await dispatchApprovedWorkflowRun(input, selected.dispatch, selected.config.runtime.workflow,
      selected.config.runtime.dispatchInputs);
    current = dispatched.operation;
    completed.push(selected.dispatch);
    if (dispatched.status === 'pending') return {
      status: 'pending', operation: current, completedOperations: completed,
      blocker: 'The exact development observation is still running. Preserve its provider run ID and private checkpoint; do not redispatch.'
    };
    if (dispatched.run.conclusion !== 'success') qualificationFailure('dev-observation-failed', 'The exact development run did not succeed.');
    const runtimeObservation = await readEnvironmentRuntimeProof(input, selected.dispatch);
    completed.push(selected.readback);
    return {
      status: 'completed', resultState: 'verified', operation: runtimeObservation.operation, completedOperations: completed,
      evidencePayload: {
        kind: 'dev-proof.v1', recipe: devProofRecipeId, sourceSha: selected.config.runtime.workflow.sourceSha,
        artifactDigest: runtimeObservation.artifactDigest, foundation, runtimeObservation
      },
      outputs: {
        values: { 'dev.sourceSha': selected.config.runtime.workflow.sourceSha, 'dev.artifactDigest': runtimeObservation.artifactDigest,
          'dev.imageRef': runtimeObservation.imageRef, 'dev.revisionName': runtimeObservation.resource.revisionName,
          'dev.runId': runtimeObservation.operation.operationId },
        resources: [{ provider: 'azure', resourceType: 'Microsoft.App/containerApps', resourceId: runtimeObservation.resource.resourceId }]
      },
      liveReadback: [
        readbackProof(input, 'github', 'workflow-run', runtimeObservation.operation.resourceId, {
          sourceSha: runtimeObservation.executionSourceSha, artifact: runtimeObservation.reportArtifact, job: runtimeObservation.workflowEvidence.job
        }),
        ...foundation.observedResources.map((resource) => readbackProof(input, 'azure', resource.resourceType, resource.resourceId, resource)),
        readbackProof(input, 'azure', 'Microsoft.App/containerApps/revisions', runtimeObservation.resource.revisionResourceId,
          runtimeObservation.resource)
      ]
    };
  } catch (error) {
    return { ...blockedQualificationOutcome(input, failure(error)), completedOperations: completed,
      ...(current ? { operation: current } : {}) };
  }
}
