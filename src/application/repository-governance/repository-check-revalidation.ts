import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { evidenceBodyDigest, validateEvidenceFreshness } from '../../domain/governance/activation/evidence.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../../domain/governance/activation/approvals.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { ExternalOperationState, PhaseEvidenceRecord, SavedTransitionPlan, TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  GitHubActivationClient, GitHubActivationError, githubRef, object, positiveId, text
} from '../../adapters/github/activation-rest.js';
import {
  readOriginalCheckFixtureCustody, repositoryCheckContextsFromQualification, revalidateRepositoryChecksQualification,
  type FailedWorkflowArtifactRequest, type OriginalCheckFixturePlanReference,
  type RepositoryChecksEvidencePayload, type WorkflowRunBinding
} from '../../adapters/github/production-checks.js';
import {
  readWorkflowPublicationOperation, validateWorkflowPublicationPlan, type WorkflowPublicationPlan
} from '../../adapters/github/production-workflows.js';
import { validateWorkflowRunBinding } from '../../adapters/github/workflow-run-readback.js';
import { protectedRefFamilies } from '../../adapters/github/workflow-check-recipes.js';
import type { RepositoryControlBinding } from '../../adapters/github/repository-control-observation.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import {
  fullActivationCheckContextsFromQualification, revalidateFullActivationChecks,
  type FullActivationChecksEvidencePayload
} from '../azure-activation/full-activation-checks.js';
import { enforcementProductionPredecessorVerifier } from './repository-control-predecessors.js';
import { AzureActivationAdmissionError } from '../azure-activation/authority.js';
import { readWorkflowEffect } from './workflow-checkpoints.js';
import type { ControlCheckRequirement } from './repository-control-source.js';
import {
  assertEnforcementReadAuthority, assertRepositoryArtifactReadback, originalFixtureReferences,
  sourceCheckArtifactRequests, type RepositoryControlArtifactReadback
} from './repository-control-artifact-readback.js';
import type { SourceCheckFixtureArtifactReadback } from './source-check-artifact.js';

export interface RepositoryCheckRevalidation {
  requirements: readonly ControlCheckRequirement[];
  actorId: number;
  failedWorkflowArtifacts?: readonly FailedWorkflowArtifactRequest[];
  originalFixturePlans?: readonly OriginalCheckFixturePlanReference[];
  artifactReadbacks?: readonly SourceCheckFixtureArtifactReadback[];
}

function fail(message: string): never {
  throw new GitHubActivationError('check-evidence-admission', message);
}

function records(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((entry) => !isRecord(entry))) {
    fail('Current qualification requires its bounded original recipe, fixture and provider-operation inventory.');
  }
  return value;
}

function digest(value: unknown, length: 40 | 64): void {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)) {
    fail('Qualification contains a missing or malformed original source/object/plan commitment.');
  }
}

function timestamp(value: unknown): string {
  const result = text(value, 'Original qualification timestamp');
  if (!Number.isFinite(Date.parse(result))) fail('Qualification has an invalid original observation time.');
  return result;
}

function assertPublication(value: unknown): asserts value is WorkflowPublicationPlan {
  const plan = object(value, 'Original approved fixture');
  if (plan.schemaVersion !== 1 ||
    (plan.recipe !== 'gitflow-node-test-fixture.v1' && plan.recipe !== 'gitflow-source-check-fixture.v1')) {
    fail('A qualification fixture must retain its exact registered publication recipe.');
  }
  for (const key of ['repository', 'actorLogin', 'targetBranch', 'featureBranch', 'commitTime', 'commitMessage']) text(plan[key], key);
  positiveId(plan.repositoryId); positiveId(plan.actorId);
  for (const key of ['baseSha', 'mainSha', 'baseTreeSha', 'treeSha', 'commitSha']) digest(plan[key], 40);
  digest(plan.controlsDigest, 64);
  if (!Array.isArray(plan.requiredChecks) || plan.requiredChecks.length > 64) fail('The original fixture control precondition is missing.');
  for (const entry of plan.requiredChecks) {
    const check = object(entry);
    text(check.context, 'Original required check');
    if (check.appId !== null) positiveId(check.appId);
  }
  for (const file of records(plan.files, 64)) {
    text(file.path, 'Original fixture path');
    if (typeof file.content !== 'string') fail('Original fixture bytes are missing.');
    digest(file.digest, 64); digest(file.blobSha, 40);
    if (file.beforeBlobSha !== null) digest(file.beforeBlobSha, 40);
  }
}

function assertRunBinding(value: unknown): asserts value is WorkflowRunBinding {
  const binding = object(value);
  for (const key of ['repository', 'workflowPath', 'ref']) text(binding[key], key);
  for (const key of ['repositoryId', 'workflowId', 'actorId', 'runAttempt']) positiveId(binding[key], key);
  digest(binding.workflowDigest, 64); digest(binding.sourceSha, 40); digest(binding.producerSourceSha, 40);
  if (binding.event !== 'pull_request' || !Array.isArray(binding.expectedJobs) || binding.expectedJobs.length === 0 ||
    binding.expectedJobs.length > 32 || binding.expectedJobs.some((job) => typeof job !== 'string')) {
    fail('Qualification requires its exact original PR-triggered workflow/job binding.');
  }
}

type CheckPhase = 'repository-checks-qualified' | 'green-red-proof';
type CheckEvidence = RepositoryChecksEvidencePayload | FullActivationChecksEvidencePayload;

function actionFor(phaseId: CheckPhase) {
  return phaseId === 'repository-checks-qualified' ? 'github.checks.repository-qualified' : 'github.checks.green-red-proof';
}

function contextsFor(evidence: CheckEvidence) {
  return evidence.kind === 'repository-checks-qualified.v1'
    ? repositoryCheckContextsFromQualification(evidence) : fullActivationCheckContextsFromQualification(evidence);
}

function assertOperation(value: unknown, phaseId: CheckPhase): asserts value is ExternalOperationState {
  const operation = object(value);
  if (operation.provider !== 'github' || operation.actionId !== actionFor(phaseId) ||
    typeof operation.operationId !== 'string' || !/^[1-9]\d*$/u.test(operation.operationId) ||
    (operation.status !== 'completed' && operation.status !== 'failed')) {
    fail('Only the actual settled repository-check provider operation may be re-read.');
  }
  positiveId(Number(operation.operationId));
  text(operation.resourceId, 'Original run resource');
  timestamp(operation.startedAt); timestamp(operation.observedAt); digest(operation.planDigest, 64);
}

function assertCurrentEvidence(value: unknown, phaseId: CheckPhase): asserts value is CheckEvidence {
  const evidence = object(value);
  if (evidence.kind !== `${phaseId}.v1` || !Array.isArray(evidence.requiredContexts)) {
    fail('Current extended qualification requires its exact selected-scope evidence kind and required-context projection.');
  }
  if (phaseId === 'repository-checks-qualified') repositoryCheckContextsFromQualification(evidence);
  else fullActivationCheckContextsFromQualification(evidence);
  for (const check of records(evidence.requiredChecks, 32)) {
    if (!['node-test.v1', 'vitest.v1', 'pytest.v1', 'go-test.v1'].includes(String(check.recipe)) ||
      !['.', 'backend', 'frontend'].includes(String(check.workingDirectory))) {
      fail('The required check has no explicit currently registered recipe and working directory; check names are not recipes.');
    }
    if (check.recipe === 'vitest.v1' || check.validationManifest !== undefined) {
      const manifest = object(check.validationManifest, 'Original validation manifest');
      if (manifest.path !== (check.workingDirectory === '.' ? 'package.json' : `${check.workingDirectory}/package.json`)) {
        fail('The validation manifest is not bound to the exact approved recipe directory.');
      }
      digest(manifest.digest, 64); digest(manifest.blobSha, 40);
    }
  }
  for (const fixture of records(evidence.boundFixtures, protectedRefFamilies.length * 2)) {
    assertPublication(fixture.publication);
    validateWorkflowPublicationPlan(fixture.publication);
    if (fixture.polarity !== 'positive' && fixture.polarity !== 'negative') fail('The retained fixture polarity is missing.');
    if (!protectedRefFamilies.some((family) => family === fixture.refFamily)) fail('The retained fixture family is not registered.');
    positiveId(fixture.pullRequestNumber);
    for (const run of records(fixture.runs, 32)) {
      assertRunBinding(run.binding);
      validateWorkflowRunBinding(run.binding);
      assertOperation(run.operation, phaseId);
    }
  }
}

async function admitApprovedSourceChecks(
  input: PhasePlanningInput, record: PhaseEvidenceRecord,
  binding: RepositoryControlBinding, sourceSha: string, phaseId: CheckPhase
): Promise<CheckEvidence> {
  const scope = phaseId === 'repository-checks-qualified' ? 'repository' : 'activation';
  const consumers = scope === 'repository' ? ['repository-rulesets-applied', 'repository-live-readback'] : ['rulesets-applied', 'live-readback'];
  if (input.inspection.scope !== scope || !consumers.includes(input.phase.id)) {
    fail('Source-check recipes cannot cross repository/full-activation boundaries or provide differently scoped enforcement proof.');
  }
  const context = input.inspection.contexts[phaseId];
  const snapshot = structuredClone(record);
  if (snapshot.header.phaseId !== phaseId || snapshot.header.scope !== scope || snapshot.header.result !== 'verified' ||
    snapshot.header.producer !== 'liftoff-governance-transition-engine' || !context?.evidenceReferences?.length ||
    snapshot.header.bodyDigest !== evidenceBodyDigest(snapshot.payload, snapshot.liveReadback) ||
    !validateEvidenceFreshness(snapshot, { ...context, now: input.now }).valid) {
    fail('Extended recipe consumption requires the current original authoritative repository-check header/body and state references.');
  }
  const evidence = snapshot.payload;
  assertCurrentEvidence(evidence, phaseId);
  if (Date.parse(timestamp(evidence.qualifiedAt)) > Date.parse(snapshot.header.producedAt)) {
    fail('Qualification observation time cannot be after its original authoritative receipt.');
  }
  if (evidence.repository !== binding.repository || evidence.repositoryId !== binding.repositoryId || evidence.sourceSha !== sourceSha) {
    fail('The qualified recipe belongs to another repository or immutable published source.');
  }
  const body = object(snapshot.payload);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const planFor = (planDigest: unknown, savedDigest?: unknown) => {
    digest(planDigest, 64);
    const matches = context.reviewedPlans?.filter((entry) => entry.phaseId === phaseId && entry.planDigest === planDigest &&
      (savedDigest === undefined || canonicalSha256(entry) === savedDigest));
    if (matches?.length !== 1) fail('The exact original qualification or provider-operation plan is missing or ambiguous.');
    const plan = validateSavedTransitionPlan(matches[0]);
    try { assertPlanOperationsAllowed(plan, phase); }
    catch { fail('The original qualification plan no longer satisfies its registered phase/action contract.'); }
    return plan;
  };
  const operationFor = (plan: SavedTransitionPlan): TransitionOperation => {
    const operations = plan.operations.filter((entry) => entry.actionId === actionFor(phaseId));
    if (operations.length !== 1) fail('The original plan must contain one exact same-scope check operation.');
    const operation = operations[0]!;
    if (operation.inputs.repository !== evidence.repository || operation.inputs.repositoryId !== evidence.repositoryId ||
      operation.inputs.actorId !== evidence.actorId || operation.inputs.sourceSha !== evidence.sourceSha ||
      canonicalSha256(operation.inputs.requiredChecks) !== canonicalSha256(evidence.requiredChecks)) {
      fail('Current recipe, manifest, workflow/job, actor or source descriptors differ from the original reviewed check operation.');
    }
    if (evidence.kind === 'green-red-proof.v1' &&
      (operation.inputs.artifactDigest !== evidence.artifactDigest ||
        canonicalSha256(operation.inputs.predecessors) !== canonicalSha256(evidence.predecessors))) {
      fail('Full check qualification must retain its exact separately qualified original staging/rehearsal and artifact commitments.');
    }
    const configuration = object(plan.configuration?.phases[phaseId], 'Original qualification configuration');
    if (configuration.repositoryId !== evidence.repositoryId || configuration.actorId !== evidence.actorId ||
      configuration.sourceSha !== evidence.sourceSha ||
      canonicalSha256(configuration.workflowPaths) !== canonicalSha256([...new Set(evidence.requiredChecks.map((entry) => entry.workflowPath))])) {
      fail('The original qualification configuration does not bind these exact workflow/source/actor inputs.');
    }
    return operation;
  };
  const admitAuthority = async (plan: SavedTransitionPlan, at: string) => {
    const when = new Date(timestamp(at));
    if (when < new Date(plan.createdAt) || when >= new Date(plan.expiresAt)) fail('The original qualification effect is outside its reviewed plan interval.');
    const candidates = input.inspection.approvals.filter((entry) => entry.id === plan.approval.envelopeId);
    const evaluation = evaluateApprovalForTransitionPlan(approvalRequestForSavedPlan(plan, phase, input.inspection.state), candidates, { now: when });
    const envelope = candidates[0];
    if (candidates.length !== 1 || evaluation.approvalRequired || !envelope || evaluation.envelopeHash !== plan.approval.envelopeHash) {
      fail('The original qualification effect has no matching exact issued approval.');
    }
    try { await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, githubPorts(input).storage); }
    catch { fail('The original qualification approval has no project-bound private issuance.'); }
  };
  digest(body.savedPlanDigest, 64);
  const plan = planFor(body.planDigest, body.savedPlanDigest);
  await admitAuthority(plan, snapshot.header.producedAt);
  const operation = operationFor(plan);
  const fixtures = records(operation.inputs.fixtures, protectedRefFamilies.length * 2);
  const fixtureBindings = records(operation.inputs.fixtureBindings, protectedRefFamilies.length * 2);
  const configuredFixtures = records(plan.configuration?.phases[phaseId]?.fixtures, protectedRefFamilies.length);
  if (fixtures.length !== evidence.boundFixtures.length || fixtureBindings.length !== fixtures.length ||
    new Set(evidence.boundFixtures.map((entry) => entry.publication.featureBranch)).size !== fixtures.length ||
    configuredFixtures.length * 2 !== fixtures.length ||
    new Set(configuredFixtures.map((entry) => entry.refFamily)).size !== configuredFixtures.length) {
    fail('The retained fixture set is not the complete unique original approved inventory.');
  }
  const readInput = (original: SavedTransitionPlan): PhaseAdapterExecutionInput => ({
    ...input, phase, plan: original, adapters: input.adapters ?? {}
  });
  for (const fixture of evidence.boundFixtures) {
    const publication = fixture.publication;
    const declared = fixtures.filter((entry) => entry.featureBranch === publication.featureBranch);
    const selection = fixtureBindings.filter((entry) => entry.featureBranch === publication.featureBranch);
    if (declared.length !== 1 || canonicalSha256(declared[0]) !== canonicalSha256(publication) ||
      selection.length !== 1 || selection[0]!.polarity !== fixture.polarity || selection[0]!.refFamily !== fixture.refFamily ||
      publication.repositoryId !== evidence.repositoryId || publication.actorId !== evidence.actorId ||
      publication.repository !== evidence.repository) {
      fail('The fixture branch, source/tree/blob inventory, recipe or polarity differs from the exact original approved plan.');
    }
    const counterpart = evidence.boundFixtures.filter((entry) => entry.refFamily === fixture.refFamily && entry.polarity !== fixture.polarity);
    if (counterpart.length !== 1 || counterpart[0]!.publication.baseSha !== publication.baseSha ||
      counterpart[0]!.publication.targetBranch !== publication.targetBranch) {
      fail('Positive and controlled-negative fixtures must share the exact approved target/base, not unrelated source revisions.');
    }
    const configured = configuredFixtures.filter((entry) => entry.refFamily === fixture.refFamily);
    if (configured.length !== 1 || configured[0]!.targetBranch !== publication.targetBranch ||
      configured[0]!.baseSha !== publication.baseSha || configured[0]!.commitTime !== publication.commitTime ||
      configured[0]![fixture.polarity === 'positive' ? 'positiveBranch' : 'negativeBranch'] !== publication.featureBranch) {
      fail('The exact fixture target/base/ref/time differs from its original declared qualification configuration.');
    }
    const pr = await readWorkflowPublicationOperation(readInput(plan), operation, publication);
    if (!pr || pr.operationId !== String(fixture.pullRequestNumber) ||
      pr.resourceId !== `/repos/${evidence.repository}/pulls/${fixture.pullRequestNumber}`) {
      fail('The fixture has no actual original private provider PR record; branch names and copied public IDs cannot establish it.');
    }
    const publicationPlan = planFor(pr.planDigest);
    if (canonicalSha256(operationFor(publicationPlan)) !== canonicalSha256(operation)) {
      fail('The private fixture PR belongs to a different original reviewed operation.');
    }
    await admitAuthority(publicationPlan, pr.startedAt);
    for (const run of fixture.runs) {
      const original = planFor(run.operation.planDigest);
      const originalOperation = operationFor(original);
      if (!records(originalOperation.inputs.fixtures, protectedRefFamilies.length * 2)
        .some((entry) => canonicalSha256(entry) === canonicalSha256(publication))) {
        fail('The original provider-run approval does not contain this exact fixture inventory.');
      }
      const expectedJobs = evidence.requiredChecks.filter((check) =>
        check.workflowId === run.binding.workflowId && check.refFamilies.includes(fixture.refFamily)).map((check) => check.context);
      if (run.binding.repository !== evidence.repository || run.binding.repositoryId !== evidence.repositoryId ||
        run.binding.actorId !== evidence.actorId || run.binding.sourceSha !== publication.commitSha ||
        run.binding.producerSourceSha !== evidence.sourceSha || run.binding.ref !== publication.featureBranch ||
        canonicalSha256(run.binding.expectedJobs) !== canonicalSha256(expectedJobs)) {
        fail('The retained run binding differs from its exact approved fixture, workflow/job set or producer identity.');
      }
      const checkpoint = await readWorkflowEffect(readInput(original), originalOperation, {
        repositoryId: evidence.repositoryId, ref: `${githubRef(run.binding.ref)}:${run.binding.workflowId}`,
        purpose: 'check-fixture', step: 'dispatch'
      }, { binding: run.binding, fixtureDigest: canonicalSha256(publication) });
      if (!checkpoint?.observed || checkpoint.prepared.planDigest !== original.planDigest ||
        checkpoint.prepared.approvalEnvelopeHash !== original.approval.envelopeHash ||
        checkpoint.observed.providerId !== run.operation.operationId || checkpoint.observed.resourceId !== run.operation.resourceId ||
        run.operation.startedAt !== checkpoint.prepared.preparedAt ||
        Date.parse(run.operation.observedAt) < Date.parse(checkpoint.observed.recordedAt) ||
        Date.parse(run.operation.observedAt) > Date.parse(snapshot.header.producedAt)) {
        fail('The run is not backed by its actual original private pre-effect/provider record; no replacement run is adopted.');
      }
      await admitAuthority(original, checkpoint.prepared.preparedAt);
    }
  }
  return evidence;
}

function requirementsFor(current: CheckEvidence, binding: RepositoryControlBinding) {
  return {
    actorId: current.actorId,
    requirements: contextsFor(current).map((entry): ControlCheckRequirement => {
      const check = current.requiredChecks.find((check) => check.workflowId === entry.workflowId && check.jobId === entry.jobKey)!;
      if (entry.appId !== binding.actionsApp.id) fail('The re-read check application is not the actual observed GitHub Actions application.');
      return {
        context: entry.context, appId: entry.appId, refFamily: entry.refFamily, workflowPath: entry.workflowPath,
        workflowId: entry.workflowId, workflowDigest: entry.workflowDigest, workflowBlobSha: entry.workflowBlobSha,
        jobName: entry.context, jobKey: entry.jobKey, validationStep: check.validationStep, producerSourceSha: entry.producerSourceSha
      };
    })
  };
}

async function revalidate(
  input: PhasePlanningInput, client: GitHubActivationClient, evidence: CheckEvidence,
  binding: RepositoryControlBinding, artifactReadback?: RepositoryControlArtifactReadback
): Promise<RepositoryCheckRevalidation> {
  const phaseId = evidence.kind === 'repository-checks-qualified.v1' ? 'repository-checks-qualified' : 'green-red-proof';
  if (phaseId === 'green-red-proof') await assertEnforcementReadAuthority(input, artifactReadback);
  const failedWorkflowArtifacts = sourceCheckArtifactRequests(evidence, phaseId);
  const originalFixturePlans = originalFixtureReferences(failedWorkflowArtifacts);
  await assertRepositoryArtifactReadback(input, artifactReadback, failedWorkflowArtifacts);
  if (originalFixturePlans.length) {
    if (!artifactReadback || canonicalSha256(artifactReadback.operation.inputs.originalFixturePlans ?? null) !== canonicalSha256(originalFixturePlans)) {
      fail('The current read operation must approve every exact original performed fixture-plan reference, not a replacement qualification plan.');
    }
    for (const reference of originalFixturePlans) {
      const custody = await readOriginalCheckFixtureCustody({
        execution: artifactReadback.execution, operation: artifactReadback.operation, reference
      });
      if (custody.repository !== evidence.repository || custody.repositoryId !== evidence.repositoryId ||
        custody.actorId !== evidence.actorId || custody.producerSourceSha !== evidence.sourceSha ||
        canonicalSha256(custody.requiredChecks) !== canonicalSha256(evidence.requiredChecks) ||
        custody.fixtures.length !== evidence.boundFixtures.length) {
        fail('Original fixture custody differs from the retained repository/source/actor/check inventory.');
      }
      for (const actual of custody.fixtures) {
        const expected = evidence.boundFixtures.find((fixture) => fixture.publication.featureBranch === actual.publication.featureBranch);
        if (!expected || canonicalSha256(expected.publication) !== canonicalSha256(actual.publication) ||
          expected.polarity !== actual.polarity || expected.refFamily !== actual.refFamily ||
          expected.pullRequestNumber !== actual.pullRequestNumber || expected.runs.length !== actual.runs.length) {
          fail('The retained fixture or PR differs from its actual original private publication custody.');
        }
        for (const actualRun of actual.runs) {
          const saved = expected.runs.find((run) => canonicalSha256(run.binding) === canonicalSha256(actualRun.binding));
          if (!saved || saved.operation.provider !== actualRun.identity.provider ||
            saved.operation.actionId !== actualRun.identity.actionId || saved.operation.operationId !== actualRun.identity.operationId ||
            saved.operation.resourceId !== actualRun.identity.resourceId || saved.operation.planDigest !== actualRun.identity.planDigest ||
            saved.operation.startedAt !== actualRun.identity.startedAt ||
            Date.parse(saved.operation.observedAt) < Date.parse(actualRun.identity.observedAt)) {
            fail('A retained run differs from its actual statusless original provider identity; no status or ID is invented.');
          }
        }
      }
    }
  }
  const readOnly = new GitHubActivationClient({ async request(request) {
    if (request.method !== 'GET') fail('Consuming qualification permits readback only, never dispatch, PR creation or provider mutation.');
    if (phaseId === 'green-red-proof' && !failedWorkflowArtifacts.length) await assertEnforcementReadAuthority(input, artifactReadback);
    await assertRepositoryArtifactReadback(input, artifactReadback, failedWorkflowArtifacts);
    return client.transport.request(request);
  } });
  const current = evidence.kind === 'repository-checks-qualified.v1'
    ? await revalidateRepositoryChecksQualification({
      client: readOnly, evidence, now: input.now, ...(artifactReadback ? { artifactReadback } : {})
    })
    : await revalidateFullActivationChecks({
      client: readOnly, evidence, now: input.now, artifactReadback,
      predecessorVerifier: enforcementProductionPredecessorVerifier(input, artifactReadback!, binding)
    });
  return {
    ...requirementsFor({ ...evidence, ...current }, binding),
    ...(failedWorkflowArtifacts.length ? {
      failedWorkflowArtifacts, originalFixturePlans,
      artifactReadbacks: current.controlledNegativeChecks.flatMap((proof) => proof.fixtureArtifact ? [proof.fixtureArtifact] : [])
    } : {})
  };
}

/** Admits original authority before actual current, privately approved artifact/provider reads. */
export async function revalidateApprovedRepositoryChecks(
  input: PhasePlanningInput, client: GitHubActivationClient, record: PhaseEvidenceRecord,
  binding: RepositoryControlBinding, sourceSha: string, artifactReadback?: RepositoryControlArtifactReadback
): Promise<RepositoryCheckRevalidation> {
  const evidence = await admitApprovedSourceChecks(input, record, binding, sourceSha, 'repository-checks-qualified');
  return revalidate(input, client, evidence, binding, artifactReadback);
}

/** A preview retains the entire artifact inventory for mandatory readback before any approved control effect. */
export async function planApprovedRepositoryChecks(
  input: PhasePlanningInput, client: GitHubActivationClient, record: PhaseEvidenceRecord,
  binding: RepositoryControlBinding, sourceSha: string
): Promise<RepositoryCheckRevalidation> {
  const evidence = await admitApprovedSourceChecks(input, record, binding, sourceSha, 'repository-checks-qualified');
  const failedWorkflowArtifacts = sourceCheckArtifactRequests(evidence, 'repository-checks-qualified');
  if (!failedWorkflowArtifacts.length) return revalidate(input, client, evidence, binding);
  return { ...requirementsFor(evidence, binding), failedWorkflowArtifacts, originalFixturePlans: originalFixtureReferences(failedWorkflowArtifacts) };
}

export async function planApprovedFullChecks(
  input: PhasePlanningInput, _client: GitHubActivationClient, record: PhaseEvidenceRecord,
  binding: RepositoryControlBinding, sourceSha: string
): Promise<RepositoryCheckRevalidation> {
  const evidence = await admitApprovedSourceChecks(input, record, binding, sourceSha, 'green-red-proof');
  const failedWorkflowArtifacts = sourceCheckArtifactRequests(evidence, 'green-red-proof');
  return { ...requirementsFor(evidence, binding), failedWorkflowArtifacts,
    originalFixturePlans: originalFixtureReferences(failedWorkflowArtifacts) };
}

export async function revalidateApprovedFullChecks(
  input: PhasePlanningInput, client: GitHubActivationClient, record: PhaseEvidenceRecord,
  binding: RepositoryControlBinding, sourceSha: string, artifactReadback?: RepositoryControlArtifactReadback
): Promise<RepositoryCheckRevalidation> {
  try {
    const evidence = await admitApprovedSourceChecks(input, record, binding, sourceSha, 'green-red-proof');
    return await revalidate(input, client, evidence, binding, artifactReadback);
  } catch (error) {
    if (error instanceof AzureActivationAdmissionError) {
      throw new GitHubActivationError('full-control-qualification', error.message);
    }
    throw error;
  }
}
