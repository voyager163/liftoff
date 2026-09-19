import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../../domain/governance/activation/graph.js';
import { evidenceHeaderDigest, type PhaseEvidenceSource } from '../../domain/governance/activation/evidence.js';
import type {
  ExternalOperationState, PhaseEvidenceRecord, SavedTransitionPlan, TransitionOperation
} from '../../domain/governance/activation/types.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import {
  clientFor, githubOperation, phaseConfiguration, repositoryConfiguration, sourceSha, digest
} from '../../governance-activation/github-config.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import {
  GitHubActivationClient, GitHubActivationError, githubRef, githubRepository, object, positiveId,
  safeGitHubFailure, text
} from '../../adapters/github/activation-rest.js';
import {
  readBoundWorkflowRun, type BoundRepositoryCheckFixture, type ControlledNegativeCheckQualification,
  type PositiveCheckQualification, type QualifiedRepositoryCheckContext, type QualifiedRepositoryCheckRun,
  type WorkflowRunBinding, type FailedWorkflowArtifactRequest
} from '../../adapters/github/production-checks.js';
import {
  assertPublicationPreconditions, materializeGitFlowPullRequest, planWorkflowSourcePublication,
  readbackValidationSource, readbackWorkflowContent, readWorkflowPublicationOperation,
  validateWorkflowPublicationPlan, type WorkflowPublicationPlan
} from '../../adapters/github/production-workflows.js';
import {
  controlledSourceCheckFixtures, deriveRequiredSourceChecks, isProtectedRefFamily,
  matchesProtectedRefFamily, protectedRefFamilies, type ProtectedRefFamily, type RequiredWorkflowCheck
} from '../../adapters/github/workflow-check-recipes.js';
import { validateWorkflowRunBinding } from '../../adapters/github/workflow-run-readback.js';
import { readSourceCheckAssertionExecution, sourceCheckAssertionIdentity } from '../../adapters/github/source-check-execution.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import {
  prepareWorkflowEffect, readWorkflowEffect, recordWorkflowProviderResult,
  type WorkflowEffectIdentity
} from '../repository-governance/workflow-checkpoints.js';
import { AzureActivationAdmissionError } from './authority.js';
import {
  disposableTargetConfig, environmentQualificationScopeBlocker, qualificationFailure,
  qualificationInteger, qualificationObject, qualificationText, qualificationTimestamp,
  type DisposableTargetConfig
} from './qualification-authority.js';
import {
  qualificationDigest, qualificationEvidenceReference, requireQualificationEvidence,
  type QualificationEvidenceReference
} from './qualification-evidence.js';
import { blockedQualificationOutcome } from './qualification-checkpoints.js';
import {
  readRepositorySourceCheckFailedArtifact, SourceCheckArtifactPendingError
} from '../repository-governance/source-check-artifact.js';

export const fullActivationChecksAction = 'github.checks.green-red-proof' as const;
export const fullActivationChecksQualifyAction = 'github.checks.qualify' as const;
export const greenRedProofPhaseId = 'green-red-proof' as const;
export const greenRedProofEvidenceKind = 'green-red-proof.v1' as const;

export interface FullActivationCheckFixtureConfig {
  refFamily: ProtectedRefFamily;
  targetBranch: string;
  baseSha: string;
  positiveBranch: string;
  negativeBranch: string;
  commitTime: string;
}

export interface BoundPredecessorReference {
  phaseId: 'staging-qualified' | 'production-rehearsed';
  evidenceId: string;
  headerDigest: string;
  bodyDigest: string;
  sourceSha: string;
  artifactDigest?: string;
  verifiedAt: string;
}

export interface BoundProductionPredecessors {
  staging: BoundPredecessorReference;
  rehearsal: BoundPredecessorReference;
  sourceSha: string;
  artifactDigest?: string;
}

export interface PredecessorVerifierInput {
  staging: QualificationEvidenceReference;
  rehearsal: QualificationEvidenceReference;
  sourceSha: string;
  artifactDigest?: string;
  now?: Date;
}

export type PredecessorVerifierCallback = (
  input: PredecessorVerifierInput
) => Promise<BoundProductionPredecessors> | BoundProductionPredecessors;

export interface FullActivationChecksConfiguration {
  sourceSha: string;
  workflowPaths: readonly string[];
  repositoryId: number;
  actorId: number;
  staging: QualificationEvidenceReference;
  rehearsal: QualificationEvidenceReference;
  artifactDigest?: string;
  fixtures: readonly FullActivationCheckFixtureConfig[];
  disposableTarget?: DisposableTargetConfig;
}

export interface FullActivationChecksPlanPayload {
  repository: string;
  repositoryId: number;
  actorId: number;
  sourceSha: string;
  artifactDigest?: string;
  predecessors: BoundProductionPredecessors;
  requiredChecks: readonly RequiredWorkflowCheck[];
  fixtures: readonly WorkflowPublicationPlan[];
  fixtureBindings: readonly { featureBranch: string; polarity: 'positive' | 'negative'; refFamily: ProtectedRefFamily }[];
  disposableTarget?: DisposableTargetConfig;
}

export interface FullActivationChecksEvidencePayload {
  kind: 'green-red-proof.v1';
  scope: 'activation';
  repository: string;
  repositoryId: number;
  actorId: number;
  sourceSha: string;
  artifactDigest?: string;
  predecessors: BoundProductionPredecessors;
  requiredChecks: readonly RequiredWorkflowCheck[];
  requiredContexts: readonly QualifiedRepositoryCheckContext[];
  positiveChecks: readonly PositiveCheckQualification[];
  controlledNegativeChecks: readonly ControlledNegativeCheckQualification[];
  boundFixtures: readonly BoundRepositoryCheckFixture[];
  green: {
    conclusion: 'success';
    checkName: string;
    checkRunId?: number;
    verifiedAt: string;
  };
  deliberateRed: {
    conclusion: 'failure';
    deliberate: true;
    checkName: string;
    checkRunId?: number;
    verifiedAt: string;
  };
  qualifiedAt: string;
}

export interface FullActivationChecksQualificationResult {
  repository: string;
  repositoryId: number;
  actorId: number;
  sourceSha: string;
  artifactDigest?: string;
  predecessors: BoundProductionPredecessors;
  positiveChecks: readonly PositiveCheckQualification[];
  controlledNegativeChecks: readonly ControlledNegativeCheckQualification[];
  qualifiedAt: string;
  requiredChecks: readonly RequiredWorkflowCheck[];
  requiredContexts: readonly QualifiedRepositoryCheckContext[];
  green: {
    conclusion: 'success';
    checkName: string;
    checkRunId?: number;
    verifiedAt: string;
  };
  deliberateRed: {
    conclusion: 'failure';
    deliberate: true;
    checkName: string;
    checkRunId?: number;
    verifiedAt: string;
  };
}

export interface FullActivationChecksRevalidationInput {
  client: GitHubActivationClient;
  evidence: FullActivationChecksEvidencePayload;
  predecessorVerifier?: PredecessorVerifierCallback;
  now?: Date;
  artifactReadback?: { execution: PhaseAdapterExecutionInput; operation: TransitionOperation };
}

export interface FullActivationChecksExtensionContract {
  phaseId: 'green-red-proof';
  scope: 'activation';
  actionId: typeof fullActivationChecksAction;
  plan: (input: PhasePlanningInput, options?: { predecessorVerifier?: PredecessorVerifierCallback }) => Promise<PhasePlanBuild>;
  execute: (input: PhaseAdapterExecutionInput, options?: { predecessorVerifier?: PredecessorVerifierCallback }) => Promise<PhaseAdapterOutcome>;
  revalidate: (input: FullActivationChecksRevalidationInput) => Promise<FullActivationChecksQualificationResult>;
  qualify: typeof qualifyFullActivationChecks;
  verifyPredecessors: typeof verifyFullActivationPredecessors;
  projectContexts: typeof fullActivationCheckContextsFromQualification;
}

export const fullActivationChecksUnimplementedSeams = [
  'stagingQualificationInterfaceBlocker: Registered staging DAST and private-access runner admission are unavailable; runner-ready network proof alone does not prove staging DAST.',
  'productionRehearsalInterfaceBlocker: Genuine promotion rehearsal verifier with infrastructure cost and Azure provisioning is unavailable.',
  'overallProducerWiring: Environment producer execution in environment-workflow-qualification.ts remains blocked until staging and rehearsal producers are implemented and wired by coordinator.'
] as const;

function checkFail(message: string): never {
  throw new GitHubActivationError('check-context-binding', message);
}

/**
 * Projects internally coherent full-activation check contexts from green-red-proof qualification;
 * enforces literal release/** and hotfix/** ref families and distinguishes activation from repository-only proof.
 */
export function fullActivationCheckContextsFromQualification(value: unknown): readonly QualifiedRepositoryCheckContext[] {
  const result = object(value, 'Full-activation check qualification');
  if (result.kind !== undefined && result.kind !== 'green-red-proof.v1') {
    checkFail('Full-activation check qualification requires exact green-red-proof.v1 evidence kind.');
  }
  if (result.scope !== undefined && result.scope !== 'activation') {
    checkFail('Full-activation check qualification requires activation scope; repository scope cannot supply it.');
  }
  githubRepository(result.repository);
  const repositoryId = positiveId(result.repositoryId, 'Repository ID');
  const actorId = positiveId(result.actorId, 'Actor ID');
  const producerSourceSha = sourceSha(result.sourceSha, 'Producer source SHA');
  if (typeof result.qualifiedAt !== 'string' || !Number.isFinite(Date.parse(result.qualifiedAt))) {
    checkFail('Full-activation check qualification requires a valid ISO qualifiedAt timestamp.');
  }
  const records = (input: unknown, maximum: number, label: string) => {
    if (!Array.isArray(input) || !input.length || input.length > maximum) {
      checkFail(`Qualification requires 1 to ${maximum} ${label} records.`);
    }
    return input.map((entry) => object(entry, label));
  };
  const required = records(result.requiredChecks, 32, 'required checks');
  const positive = records(result.positiveChecks, 32 * protectedRefFamilies.length, 'positive check proof');
  const negative = records(result.controlledNegativeChecks, 32 * protectedRefFamilies.length, 'controlled negative check proof');
  const contexts: QualifiedRepositoryCheckContext[] = [];
  const seen = new Set<string>();

  const allFamilies = new Set<string>();
  for (const check of required) {
    if (Array.isArray(check.refFamilies)) {
      for (const fam of check.refFamilies) allFamilies.add(fam);
    }
  }
  if (!allFamilies.has('release/**') || !allFamilies.has('hotfix/**')) {
    checkFail('Full-activation green-red-proof requires literal release/** and hotfix/** ref-family coverage; single-level release/* or hotfix/* cannot substitute.');
  }

  for (const check of required) {
    const context = text(check.context, 'Required check context');
    const workflowId = positiveId(check.workflowId, 'Workflow ID');
    const jobKey = text(check.jobId, 'Source workflow job key');
    const workflowPath = text(check.workflowPath, 'Required workflow path');
    const workflowDigest = text(check.workflowDigest, 'Required workflow digest');
    const workflowBlobSha = sourceSha(check.workflowBlobSha, 'Required workflow blob SHA');
    const families = check.refFamilies;
    if (!Array.isArray(families) || !families.length || families.length > protectedRefFamilies.length ||
      new Set(families).size !== families.length) {
      checkFail('Workflow check ref families must be a non-empty unique subset of protected ref families.');
    }
    if (seen.has(context) || check.producerSourceSha !== producerSourceSha ||
      !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(workflowPath) ||
      !/^[a-f0-9]{64}$/u.test(workflowDigest)) {
      checkFail('Required check contains duplicate context, mismatched producer source, or malformed workflow descriptor.');
    }
    seen.add(context);
    let workflowAppId: number | undefined;
    for (const family of families) {
      if (!isProtectedRefFamily(family)) {
        checkFail(`Ref family '${family}' is not a registered protected ref family.`);
      }
      const select = (proofs: readonly Record<string, unknown>[], conclusion: 'success' | 'failure') => {
        const matches = proofs.filter((proof) => proof.context === context && proof.workflowId === workflowId &&
          proof.jobKey === jobKey && proof.refFamily === family);
        const proof = matches[0];
        if (matches.length !== 1 || !proof || proof.repositoryId !== repositoryId || proof.actorId !== actorId ||
          proof.workflowPath !== workflowPath || proof.workflowDigest !== workflowDigest ||
          proof.producerSourceSha !== producerSourceSha || proof.appSlug !== 'github-actions' ||
          proof.conclusion !== conclusion || (conclusion === 'failure' && proof.deliberateFailure !== true) ||
          typeof proof.verifiedAt !== 'string' || !Number.isFinite(Date.parse(proof.verifiedAt)) ||
          Date.parse(proof.verifiedAt) > Date.parse(String(result.qualifiedAt))) {
          checkFail(`Missing or conflicting ${conclusion} check proof for context '${context}' and family '${family}'.`);
        }
        const step = object(proof.validationStep, 'Validation step');
        if (step.name !== check.validationStep || step.conclusion !== conclusion) {
          checkFail(`Observed validation step '${step.name}' (${step.conclusion}) does not match expected '${check.validationStep}' (${conclusion}).`);
        }
        positiveId(step.number, 'Observed validation step number');
        const run: QualifiedRepositoryCheckRun = {
          runId: positiveId(proof.runId, 'Run ID'),
          runAttempt: positiveId(proof.runAttempt, 'Run attempt'),
          checkRunId: positiveId(proof.checkRunId, 'Check run ID'),
          jobId: positiveId(proof.jobId, 'Job ID'),
          headSha: sourceSha(proof.headSha, 'Head SHA'),
          fixtureRef: githubRef(proof.fixtureRef),
          pullRequestNumber: positiveId(proof.pullRequestNumber, 'PR number')
        };
        if (conclusion === 'failure' && canonicalSha256(proof.assertionExecution ?? null) !== canonicalSha256({
          ...sourceCheckAssertionIdentity(check.recipe, check.workingDirectory, jobKey), jobId: run.jobId
        })) {
          checkFail('Full-activation controlled-negative proof lacks the exact source-bound native assertion execution.');
        }
        if (run.runAttempt !== 1 || !/^(?:feature|automation)\/[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(run.fixtureRef)) {
          checkFail(`Run attempt must be 1 and fixture ref must be safe temporary branch: '${run.fixtureRef}'.`);
        }
        return { run, appId: positiveId(proof.appId, 'App ID') };
      };
      const green = select(positive, 'success');
      const red = select(negative, 'failure');
      if (green.appId !== red.appId || (workflowAppId !== undefined && green.appId !== workflowAppId) ||
        green.run.runId === red.run.runId || green.run.jobId === red.run.jobId ||
        green.run.checkRunId === red.run.checkRunId || green.run.headSha === red.run.headSha ||
        green.run.fixtureRef === red.run.fixtureRef || green.run.pullRequestNumber === red.run.pullRequestNumber) {
        checkFail('Positive and controlled-negative runs must use distinct provider IDs, commits, branches and PRs under the same Actions app.');
      }
      workflowAppId = green.appId;
      contexts.push({
        context, appId: green.appId, appSlug: 'github-actions', workflowId, workflowPath, workflowDigest, workflowBlobSha,
        producerSourceSha, jobKey, refFamily: family, positive: green.run, controlledNegative: red.run
      });
    }
  }
  if (contexts.length !== positive.length || contexts.length !== negative.length ||
    (result.requiredContexts !== undefined && canonicalSha256(result.requiredContexts) !== canonicalSha256(contexts))) {
    checkFail('Context projection length or retained digest conflicts with positive and negative proof inventory.');
  }
  return contexts;
}

/**
 * Concrete predecessor verifier. Validates source-bound staging-qualified and production-rehearsed receipts
 * with activation scope; rejects repository-only receipts or mismatched source/artifact identities.
 */
export function verifyFullActivationPredecessors(
  source: PhaseEvidenceSource,
  input: PredecessorVerifierInput,
  now = new Date()
): BoundProductionPredecessors {
  const expectedSource = sourceSha(input.sourceSha, 'Predecessor source SHA');
  const expectedArtifact = input.artifactDigest ? digest(input.artifactDigest, 'Predecessor artifact digest') : undefined;

  const { record: stagingRecord } = requireQualificationEvidence(source, 'staging-qualified', input.staging, now);
  if (stagingRecord.header.scope !== 'activation') {
    throw new AzureActivationAdmissionError(
      'predecessor-scope',
      'Full-activation green-red-proof requires staging predecessor receipt with activation scope; repository scope is rejected.'
    );
  }
  const stagingPayload = object(stagingRecord.payload, 'Staging evidence body');
  if (stagingPayload.sourceSha !== expectedSource ||
    (expectedArtifact !== undefined && stagingPayload.artifactDigest !== expectedArtifact)) {
    throw new AzureActivationAdmissionError(
      'predecessor-binding',
      'Staging predecessor receipt is bound to a different application source SHA or artifact digest.'
    );
  }

  const { record: rehearsalRecord } = requireQualificationEvidence(source, 'production-rehearsed', input.rehearsal, now);
  if (rehearsalRecord.header.scope !== 'activation') {
    throw new AzureActivationAdmissionError(
      'predecessor-scope',
      'Full-activation green-red-proof requires production rehearsal predecessor receipt with activation scope; repository scope is rejected.'
    );
  }
  const rehearsalPayload = object(rehearsalRecord.payload, 'Production rehearsal evidence body');
  if (rehearsalPayload.sourceSha !== expectedSource ||
    (expectedArtifact !== undefined && rehearsalPayload.artifactDigest !== expectedArtifact)) {
    throw new AzureActivationAdmissionError(
      'predecessor-binding',
      'Production rehearsal predecessor receipt is bound to a different application source SHA or artifact digest.'
    );
  }

  return {
    staging: {
      phaseId: 'staging-qualified',
      evidenceId: stagingRecord.evidenceId,
      headerDigest: evidenceHeaderDigest(stagingRecord.header),
      bodyDigest: stagingRecord.header.bodyDigest,
      sourceSha: stagingPayload.sourceSha as string,
      artifactDigest: stagingPayload.artifactDigest as string | undefined,
      verifiedAt: stagingRecord.header.producedAt
    },
    rehearsal: {
      phaseId: 'production-rehearsed',
      evidenceId: rehearsalRecord.evidenceId,
      headerDigest: evidenceHeaderDigest(rehearsalRecord.header),
      bodyDigest: rehearsalRecord.header.bodyDigest,
      sourceSha: rehearsalPayload.sourceSha as string,
      artifactDigest: rehearsalPayload.artifactDigest as string | undefined,
      verifiedAt: rehearsalRecord.header.producedAt
    },
    sourceSha: expectedSource,
    ...(expectedArtifact ? { artifactDigest: expectedArtifact } : {})
  };
}

async function checkFullActivationInputs(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  options?: { predecessorVerifier?: PredecessorVerifierCallback }
): Promise<{
  repository: string;
  repositoryId: number;
  actorId: number;
  source: string;
  artifactDigest?: string;
  workflowPaths: readonly string[];
  fixtures: readonly FullActivationCheckFixtureConfig[];
  predecessors: BoundProductionPredecessors;
  disposableTarget?: DisposableTargetConfig;
}> {
  if ((input.inspection.scope ?? 'activation') !== 'activation') {
    throw new GitHubActivationError('qualification-scope', environmentQualificationScopeBlocker);
  }
  const config = phaseConfiguration(
    input.inspection,
    input.phase.id,
    ['sourceSha', 'workflowPaths', 'repositoryId', 'actorId', 'fixtures', 'staging', 'rehearsal', 'artifactDigest', 'disposableTarget']
  );
  const repository = repositoryConfiguration(input.inspection).name;
  const source = sourceSha(config.sourceSha, 'Configured sourceSha');
  const repositoryId = positiveId(config.repositoryId, 'Configured repositoryId');
  const actorId = positiveId(config.actorId, 'Configured actorId');
  const artifactDigest = config.artifactDigest ? digest(config.artifactDigest, 'Configured artifactDigest') : undefined;

  if (input.inspection.state.remoteBinding?.id !== String(repositoryId)) {
    throw new GitHubActivationError('check-inputs', 'Repository ID does not match remote binding ID.');
  }

  if (!Array.isArray(config.workflowPaths) || !config.workflowPaths.length || config.workflowPaths.length > 8 ||
    new Set(config.workflowPaths).size !== config.workflowPaths.length) {
    throw new GitHubActivationError('check-inputs', 'Full-activation checks require 1 to 8 unique immutable workflow paths.');
  }

  if (!Array.isArray(config.fixtures) || !config.fixtures.length || config.fixtures.length > protectedRefFamilies.length) {
    throw new GitHubActivationError('check-inputs', 'Full-activation checks require one reviewed fixture pair per protected ref family.');
  }

  const stagingRef = qualificationEvidenceReference(config.staging);
  const rehearsalRef = qualificationEvidenceReference(config.rehearsal);

  let predecessors: BoundProductionPredecessors;
  if (options?.predecessorVerifier) {
    predecessors = await options.predecessorVerifier({
      staging: stagingRef,
      rehearsal: rehearsalRef,
      sourceSha: source,
      artifactDigest,
      now: input.now
    });
    if (predecessors.sourceSha !== source ||
      (artifactDigest && predecessors.artifactDigest !== artifactDigest)) {
      throw new GitHubActivationError('predecessor-binding', 'Predecessor verifier returned mismatched source SHA or artifact digest.');
    }
  } else {
    throw new GitHubActivationError('full-qualification-verifier-required',
      'The concrete private staging and separately approved rollout/rollback verifier is required; header/body integrity alone cannot authorize full production check effects.');
  }

  let disposableTarget: DisposableTargetConfig | undefined;
  if (config.disposableTarget !== undefined) {
    disposableTarget = disposableTargetConfig(config.disposableTarget);
  }

  const fixtures = config.fixtures.map((value) => {
    const entry = object(value, 'Fixture configuration');
    if (Object.keys(entry).sort().join(',') !==
      ['baseSha', 'commitTime', 'negativeBranch', 'positiveBranch', 'refFamily', 'targetBranch'].sort().join(',') ||
      !isProtectedRefFamily(entry.refFamily) ||
      typeof entry.targetBranch !== 'string' || !matchesProtectedRefFamily(entry.targetBranch, entry.refFamily) ||
      typeof entry.positiveBranch !== 'string' || typeof entry.negativeBranch !== 'string' ||
      entry.positiveBranch === entry.negativeBranch ||
      typeof entry.commitTime !== 'string') {
      throw new GitHubActivationError(
        'check-fixtures',
        'Fixture configuration requires exact existing GitFlow target refs and distinct unmerged positive/negative branches; arbitrary recipes or commands are forbidden.'
      );
    }
    sourceSha(entry.baseSha, 'Fixture base SHA');
    return entry as unknown as FullActivationCheckFixtureConfig;
  });

  if (fixtures.some((f) => f.refFamily === 'release/*' || f.refFamily === 'hotfix/*')) {
    throw new GitHubActivationError(
      'check-ref-coverage',
      'Full-activation green-red-proof requires literal recursive release/** and hotfix/** families; single-level wildcards are rejected.'
    );
  }

  const fixtureFamilies = new Set(fixtures.map((f) => f.refFamily));
  if (!fixtureFamilies.has('release/**') || !fixtureFamilies.has('hotfix/**')) {
    throw new GitHubActivationError(
      'check-ref-coverage',
      'Full-activation green-red-proof requires literal release/** and hotfix/** ref-family coverage; single-level release/* or hotfix/* cannot substitute.'
    );
  }

  if (new Set(fixtures.map((f) => f.refFamily)).size !== fixtures.length ||
    new Set(fixtures.flatMap((f) => [f.positiveBranch, f.negativeBranch])).size !== fixtures.length * 2) {
    throw new GitHubActivationError('check-fixtures', 'Each protected ref family and controlled fixture branch must be unique.');
  }

  return {
    repository, repositoryId, actorId, source, artifactDigest,
    workflowPaths: config.workflowPaths as readonly string[],
    fixtures, predecessors, disposableTarget
  };
}

function fixtureWorkflowBinding(
  plan: WorkflowPublicationPlan,
  checks: readonly RequiredWorkflowCheck[],
  workflowId: number
): WorkflowRunBinding {
  const selected = checks.filter((check) => check.workflowId === workflowId);
  const first = selected[0]!;
  return {
    repository: plan.repository,
    repositoryId: plan.repositoryId,
    workflowPath: first.workflowPath,
    workflowId,
    workflowDigest: first.workflowDigest,
    sourceSha: plan.commitSha,
    producerSourceSha: first.producerSourceSha,
    ref: plan.featureBranch,
    actorId: plan.actorId,
    event: 'pull_request',
    expectedJobs: selected.map((check) => check.context),
    runAttempt: 1
  };
}

async function fixtureRun(
  input: PhaseAdapterExecutionInput,
  operation: TransitionOperation,
  client: GitHubActivationClient,
  binding: WorkflowRunBinding,
  fixture: WorkflowPublicationPlan,
  pullRequestNumber?: number
): Promise<{ binding: WorkflowRunBinding; operation: ExternalOperationState } | null> {
  const identity: WorkflowEffectIdentity = {
    repositoryId: binding.repositoryId,
    ref: `${binding.ref}:${binding.workflowId}`,
    purpose: 'check-fixture',
    step: 'dispatch'
  };
  const payload = { binding, fixtureDigest: canonicalSha256(fixture) };
  let records = await readWorkflowEffect(input, operation, identity, payload);
  if (pullRequestNumber === undefined) {
    if (!records) await prepareWorkflowEffect(input, operation, identity, payload);
    return null;
  }
  if (!records) {
    throw new GitHubActivationError('fixture-pre-effect', 'A fixture run cannot be adopted without its private checkpoint preceding the PR trigger.');
  }
  const exact = (run: Record<string, unknown>) =>
    run.workflow_id === binding.workflowId &&
    run.path === binding.workflowPath &&
    run.head_sha === binding.sourceSha &&
    run.head_branch === binding.ref &&
    run.event === 'pull_request' &&
    run.run_attempt === 1 &&
    object(run.actor).id === binding.actorId &&
    object(run.repository).id === binding.repositoryId &&
    object(run.repository).full_name === binding.repository &&
    typeof run.created_at === 'string' &&
    Date.parse(run.created_at) >= Date.parse(records!.prepared.preparedAt) &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.some((value) => {
      const pr = object(value);
      return pr.number === pullRequestNumber && object(pr.head).sha === fixture.commitSha && object(pr.base).sha === fixture.baseSha;
    });

  let run: Record<string, unknown>;
  if (records.observed) {
    run = await client.get(`${records.observed.resourceId}/attempts/1`);
    if (String(run.id) !== records.observed.providerId || !exact(run)) {
      throw new GitHubActivationError('fixture-run-drift', 'The recorded fixture workflow run changed actor, source, attempt or PR binding.');
    }
  } else {
    const candidates = await client.list(
      `/repos/${binding.repository}/actions/workflows/${binding.workflowId}/runs?head_sha=${binding.sourceSha}&event=pull_request&branch=${binding.ref}`,
      'workflow_runs'
    );
    const matching = candidates.filter(exact);
    if (!matching.length) return null;
    if (matching.length !== 1) {
      throw new GitHubActivationError('fixture-run-ambiguous', 'Multiple exact-looking runs cannot substitute for one recorded fixture event; no latest run is adopted.');
    }
    run = await client.get(`/repos/${binding.repository}/actions/runs/${positiveId(matching[0]!.id)}/attempts/1`);
    if (!exact(run)) {
      throw new GitHubActivationError('fixture-run-binding', 'Actual run readback differs from the source-bound fixture event.');
    }
    await recordWorkflowProviderResult(input, operation, identity, records.prepared, 'observed', {
      status: 200,
      requestId: null,
      providerId: String(positiveId(run.id)),
      resourceId: `/repos/${binding.repository}/actions/runs/${run.id}`
    });
  }
  return {
    binding,
    operation: {
      provider: 'github',
      actionId: operation.actionId,
      operationId: String(positiveId(run.id)),
      resourceId: `/repos/${binding.repository}/actions/runs/${run.id}`,
      startedAt: records.prepared.preparedAt,
      observedAt: (input.clock?.() ?? input.now).toISOString(),
      status: run.status === 'completed' ? run.conclusion === 'success' ? 'completed' : 'failed' : 'running',
      planDigest: records.prepared.planDigest
    }
  };
}

/**
 * Plans full-activation green-red-proof. Reads registered active workflows, derives required status checks,
 * verifies predecessor staging and rehearsal proofs, plans GitFlow positive/negative fixtures for all ref families
 * including literal release/** and hotfix/**, and emits proposed github.checks.green-red-proof operation. Never mutates at planning.
 */
export async function planFullActivationChecks(
  input: PhasePlanningInput,
  options?: { predecessorVerifier?: PredecessorVerifierCallback }
): Promise<PhasePlanBuild> {
  try {
    if ((input.inspection.scope ?? 'activation') !== 'activation') {
      return { operations: [], blockers: [environmentQualificationScopeBlocker] };
    }
    if (input.phase.id !== greenRedProofPhaseId) {
      return { operations: [], blockers: [`Full-activation checks component handles only '${greenRedProofPhaseId}', not '${input.phase.id}'.`] };
    }
    const config = await checkFullActivationInputs(input, options);
    const client = clientFor(input);
    const checks: RequiredWorkflowCheck[] = [];
    for (const path of config.workflowPaths) {
      if (typeof path !== 'string') throw new GitHubActivationError('check-workflow', 'Every workflow needs an exact immutable source path.');
      const source = await readbackWorkflowContent(client, config.repository, path, config.source);
      const workflow = await client.get(`/repos/${config.repository}/actions/workflows/${path.split('/').at(-1)}`);
      if (workflow.path !== path || workflow.state !== 'active') {
        throw new GitHubActivationError('check-workflow', 'The actual active workflow ID/path does not match the immutable approved source.');
      }
      checks.push(...await deriveRequiredSourceChecks(client, config.repository, source, positiveId(workflow.id)));
    }
    if (new Set(checks.map((check) => check.context)).size !== checks.length) {
      throw new GitHubActivationError('check-context-collision', 'Required status contexts must be unambiguous across the actual immutable workflows.');
    }
    const families = new Set(checks.flatMap((check) => check.refFamilies));
    if (!families.has('release/**') || !families.has('hotfix/**')) {
      throw new GitHubActivationError(
        'check-ref-coverage',
        'Full-activation green-red-proof requires literal release/** and hotfix/** ref-family coverage; single-level release/* or hotfix/* cannot substitute.'
      );
    }
    if (families.size !== config.fixtures.length || config.fixtures.some((fixture) => !families.has(fixture.refFamily))) {
      throw new GitHubActivationError('check-ref-coverage', 'The reviewed fixture pairs must cover every and only the protected ref families selected by the actual workflow triggers.');
    }

    const priorDigest = input.inspection.state.phases[input.phase.id].executionPlanDigest;
    const prior = priorDigest ? input.inspection.contexts[input.phase.id].reviewedPlans?.find((plan) =>
      plan.phaseId === input.phase.id && plan.planDigest === priorDigest)?.operations.find((op) =>
      op.actionId === fullActivationChecksAction || op.actionId === fullActivationChecksQualifyAction)?.inputs as unknown as FullActivationChecksPlanPayload | undefined : undefined;

    const fixtures: WorkflowPublicationPlan[] = [];
    const fixtureBindings: FullActivationChecksPlanPayload['fixtureBindings'][number][] = [];
    for (const family of config.fixtures) {
      for (const check of checks.filter((check) => check.refFamilies.includes(family.refFamily))) {
        const baseSource = await readbackWorkflowContent(client, config.repository, check.workflowPath, family.baseSha);
        if (baseSource.digest !== check.workflowDigest) {
          throw new GitHubActivationError('check-target-source', 'The actual protected target must contain the approved workflow bytes; a fixture cannot substitute an unrelated workflow.');
        }
        if (check.validationManifest) {
          const manifest = await readbackValidationSource(client, config.repository, check.validationManifest.path, family.baseSha);
          if (manifest.digest !== check.validationManifest.digest) {
            throw new GitHubActivationError('check-target-source', 'The actual target validation manifest differs from the immutable approved test script.');
          }
        }
      }
      for (const polarity of ['positive', 'negative'] as const) {
        const featureBranch = polarity === 'positive' ? family.positiveBranch : family.negativeBranch;
        const files = controlledSourceCheckFixtures(checks.filter((check) => check.refFamilies.includes(family.refFamily)), polarity);
        const retained = prior?.fixtures.find((fixture) => fixture.featureBranch === featureBranch);
        if (prior && !retained) {
          throw new GitHubActivationError('check-recovery-inputs', 'Recovery cannot replace recorded fixture branches or dispatch a new qualification plan around an uncertain request.');
        }
        const plan = retained ?? await planWorkflowSourcePublication({
          client,
          repository: config.repository,
          repositoryId: config.repositoryId,
          actorId: config.actorId,
          baseSha: family.baseSha,
          targetBranch: family.targetBranch,
          featureBranch,
          workflowFiles: files,
          commitMessage: `Qualify full-activation checks: ${family.refFamily} ${polarity}`,
          commitTime: family.commitTime,
          recipe: 'gitflow-source-check-fixture.v1'
        });
        if (plan.repository !== config.repository || plan.repositoryId !== config.repositoryId || plan.actorId !== config.actorId ||
          plan.baseSha !== family.baseSha || plan.targetBranch !== family.targetBranch || plan.commitTime !== family.commitTime ||
          canonicalSha256(plan.files.map(({ path, content, digest: d }) => ({ path, content, digest: d }))) !== canonicalSha256(files)) {
          throw new GitHubActivationError('check-recovery-inputs', 'Recorded fixture source or approved scope differs from current exact recovery inputs.');
        }
        fixtures.push(plan);
        fixtureBindings.push({ featureBranch, polarity, refFamily: family.refFamily });
      }
    }
    const payload: FullActivationChecksPlanPayload = {
      repository: config.repository,
      repositoryId: config.repositoryId,
      actorId: config.actorId,
      sourceSha: config.source,
      ...(config.artifactDigest ? { artifactDigest: config.artifactDigest } : {}),
      predecessors: config.predecessors,
      requiredChecks: checks,
      fixtures,
      fixtureBindings,
      ...(config.disposableTarget ? { disposableTarget: config.disposableTarget } : {})
    };
    const destination = { type: 'repository' as const, identity: config.repository, repository: config.repository };
    return {
      operations: [
        githubOperation(
          input,
          fullActivationChecksAction,
          'github-workflow-dispatch',
          { ...payload },
          destination,
          ['github-read', 'github-write', 'git-push'].map((mutationClass) => ({
            mutationClass: mutationClass as 'github-read' | 'github-write' | 'git-push',
            destination,
            remote: true,
            destructive: false
          }))
        )
      ]
    };
  } catch (error) {
    return { operations: [], blockers: [safeGitHubFailure(error)] };
  }
}

/**
 * Concrete full-activation check qualification. Validates unmerged PRs, exact workflow runs, jobs, steps,
 * and conclusions for both positive and negative fixtures across literal release/** and hotfix/** families.
 */
export async function qualifyFullActivationChecks(input: {
  client: GitHubActivationClient;
  repository: string;
  requiredChecks: readonly RequiredWorkflowCheck[];
  fixtures: readonly BoundRepositoryCheckFixture[];
  predecessors?: BoundProductionPredecessors;
  now?: Date;
  artifactReadback?: { execution: PhaseAdapterExecutionInput; operation: TransitionOperation };
  failedArtifacts?: readonly FailedWorkflowArtifactRequest[];
}): Promise<FullActivationChecksQualificationResult> {
  if (!input.requiredChecks?.length || !input.fixtures?.length ||
    input.fixtures.length > protectedRefFamilies.length * 2 || input.requiredChecks.length > 32) {
    throw new GitHubActivationError('check-binding-required',
      'Full-activation check qualification requires exact workflow source, actor, ref, run/job/check binding and reviewed unmerged controlled-negative fixtures across all required ref families.');
  }
  const families = new Set(input.requiredChecks.flatMap((c) => c.refFamilies));
  if (!families.has('release/**') || !families.has('hotfix/**')) {
    throw new GitHubActivationError(
      'check-ref-coverage',
      'Full-activation green-red-proof requires literal release/** and hotfix/** ref-family coverage; single-level release/* or hotfix/* cannot substitute.'
    );
  }
  const repository = githubRepository(input.repository);
  const sourceChecks: RequiredWorkflowCheck[] = [];
  for (const check of input.requiredChecks) {
    const source = await readbackWorkflowContent(input.client, repository, check.workflowPath, check.producerSourceSha);
    const actual = (await deriveRequiredSourceChecks(input.client, repository, source, check.workflowId)).find((item) => item.jobId === check.jobId);
    if (!actual || canonicalSha256(actual) !== canonicalSha256(check)) {
      throw new GitHubActivationError('check-source', 'Required check contexts must be derived from the actual approved immutable workflow, not asserted context names.');
    }
    sourceChecks.push(actual);
  }

  const positiveChecks: PositiveCheckQualification[] = [];
  const controlledNegativeChecks: ControlledNegativeCheckQualification[] = [];
  const seen = new Set<string>();
  const verifiedAt = (input.now ?? new Date()).toISOString();

  for (const fixture of input.fixtures) {
    const plan = fixture.publication;
    if (!['gitflow-node-test-fixture.v1', 'gitflow-source-check-fixture.v1'].includes(plan.recipe) || plan.repository !== repository ||
      fixture.refFamily === 'release/*' || fixture.refFamily === 'hotfix/*' ||
      !matchesProtectedRefFamily(plan.targetBranch, fixture.refFamily) ||
      canonicalSha256(plan.files.map(({ path, content, digest: d }) => ({ path, content, digest: d }))) !==
        canonicalSha256(controlledSourceCheckFixtures(sourceChecks.filter((check) => check.refFamilies.includes(fixture.refFamily)), fixture.polarity))) {
      throw new GitHubActivationError('check-fixture', 'Qualification requires the actual registered controlled test fixture, repository and applicable protected ref family.');
    }
    const pullRequest = await input.client.get(`/repos/${repository}/pulls/${positiveId(fixture.pullRequestNumber)}`);
    const head = object(pullRequest.head, 'PR head'), base = object(pullRequest.base, 'PR base');
    if (pullRequest.number !== fixture.pullRequestNumber || pullRequest.state !== 'open' ||
      pullRequest.merged !== false || head.sha !== plan.commitSha || head.ref !== plan.featureBranch ||
      object(head.repo).id !== plan.repositoryId || object(head.repo).full_name !== repository ||
      base.sha !== plan.baseSha || base.ref !== plan.targetBranch || object(base.repo).id !== plan.repositoryId ||
      object(pullRequest.user).id !== plan.actorId) {
      throw new GitHubActivationError('check-fixture-pr', 'A source-check fixture must remain the exact actor-owned unmerged PR with unchanged source and target refs.');
    }
    for (const file of plan.files) {
      const fixtureContent = await readbackValidationSource(input.client, repository, file.path, plan.commitSha);
      if (fixtureContent.digest !== file.digest || fixtureContent.blobSha !== file.blobSha) {
        throw new GitHubActivationError('check-fixture-bytes', 'Actual immutable fixture bytes do not match the approved positive or controlled-negative validation input.');
      }
    }
    for (const expected of sourceChecks.filter((check) => check.refFamilies.includes(fixture.refFamily))) {
      const key = `${fixture.refFamily}:${fixture.polarity}:${expected.workflowId}:${expected.jobId}`;
      if (seen.has(key)) throw new GitHubActivationError('check-duplicate', 'Repeated fixtures or runs cannot replace missing required protected-ref proof.');
      seen.add(key);
      const matching = fixture.runs.filter((entry) => entry.binding.workflowId === expected.workflowId);
      if (matching.length !== 1) throw new GitHubActivationError('check-run-binding', 'Every fixture needs one exact recorded provider run per immutable workflow.');
      const selected = matching[0]!;
      const binding = selected.binding;
      if (expected.validationManifest) {
        const manifest = await readbackValidationSource(input.client, repository, expected.validationManifest.path, binding.sourceSha);
        if (manifest.digest !== expected.validationManifest.digest || manifest.blobSha !== expected.validationManifest.blobSha) {
          throw new GitHubActivationError('check-validation-manifest', 'The actual executed test script differs from the separately approved immutable validation manifest.');
        }
      }
      if (binding.repository !== repository || binding.repositoryId !== plan.repositoryId ||
        binding.workflowPath !== expected.workflowPath || binding.workflowDigest !== expected.workflowDigest ||
        binding.producerSourceSha !== expected.producerSourceSha || binding.ref !== plan.featureBranch ||
        binding.sourceSha !== plan.commitSha || binding.actorId !== plan.actorId || binding.event !== 'pull_request') {
        throw new GitHubActivationError('check-run-binding', 'The qualification run is not independently bound to the actual fixture, workflow producer, actor and source ref.');
      }
      const observed = await readBoundWorkflowRun(input.client, binding, selected.operation);
      if (!Array.isArray(observed.providerRun.pull_requests) ||
        !observed.providerRun.pull_requests.some((entry) => {
          const pr = object(entry);
          return pr.number === fixture.pullRequestNumber && object(pr.head).sha === plan.commitSha &&
            object(pr.base).sha === plan.baseSha;
        })) {
        throw new GitHubActivationError('check-pr-run-binding', 'The actual Actions run is not associated with the exact unmerged fixture PR and target source.');
      }
      const job = observed.jobs.find((entry) => entry.name === expected.context);
      if (!job) throw new GitHubActivationError('check-job', 'The actual required workflow validation job is missing.');
      const conclusion = fixture.polarity === 'positive' ? 'success' : 'failure';
      if (observed.conclusion !== conclusion || job.conclusion !== conclusion) {
        throw new GitHubActivationError('check-conclusion', 'The required workflow and job did not produce the actual expected positive or controlled-negative result.');
      }
      const validation = job.steps.filter((step) => step.name === expected.validationStep);
      if (validation.length !== 1 || validation[0]!.status !== 'completed' || validation[0]!.conclusion !== conclusion ||
        job.steps.filter((step) => step.number < validation[0]!.number).some((step) => step.conclusion !== 'success') ||
        (fixture.polarity === 'negative' && job.steps.some((step) =>
          step.name !== expected.validationStep && step.conclusion === 'failure'))) {
        throw new GitHubActivationError('check-validation-step', 'Only failure of the exact real validation step with successful setup proves a controlled negative; infrastructure, skipped or unrelated failures do not.');
      }
      const proof = {
        context: expected.context, headSha: binding.sourceSha, checkRunId: job.checkRunId, conclusion,
        appId: job.appId, appSlug: job.appSlug, verifiedAt,
        workflowId: binding.workflowId, workflowPath: binding.workflowPath, workflowDigest: binding.workflowDigest,
        producerSourceSha: expected.producerSourceSha, runId: observed.runId, runAttempt: binding.runAttempt,
        jobId: job.id, jobKey: expected.jobId, actorId: binding.actorId, repositoryId: binding.repositoryId,
        refFamily: fixture.refFamily, fixtureRef: binding.ref, pullRequestNumber: fixture.pullRequestNumber,
        validationStep: { name: validation[0]!.name, number: validation[0]!.number, conclusion }
      };
      if (fixture.polarity === 'positive') positiveChecks.push({ ...proof, conclusion: 'success' });
      else {
        const negative: Omit<ControlledNegativeCheckQualification, 'assertionExecution'> = {
          ...proof, conclusion: 'failure', deliberateFailure: true
        };
        if (expected.fixtureArtifact) {
          if (!input.artifactReadback) {
            throw new GitHubActivationError('check-fixture-artifact-authority',
              'The full source declares a failed fixture artifact; its original private custody and exact current read authority are required.');
          }
          const requests = input.failedArtifacts?.filter((request) =>
            request.operation.operationId === selected.operation.operationId && request.job.jobKey === expected.jobId) ?? [];
          if (requests.length > 1) throw new GitHubActivationError('check-fixture-artifact-authority', 'One exact original failed artifact is required, not repeated requests.');
          negative.fixtureArtifact = await readRepositorySourceCheckFailedArtifact({
            ...input.artifactReadback, check: expected, fixture, proof: negative, ...(requests[0] ? { request: requests[0] } : {})
          });
        }
        controlledNegativeChecks.push({
          ...negative, assertionExecution: await readSourceCheckAssertionExecution(input.client, repository, expected, job.id)
        });
      }
    }
  }

  for (const check of sourceChecks) {
    for (const family of check.refFamilies) {
      for (const polarity of ['positive', 'negative']) {
        if (!seen.has(`${family}:${polarity}:${check.workflowId}:${check.jobId}`)) {
          throw new GitHubActivationError('check-proof-missing', 'Every required actual workflow/job/ref family needs independent positive and controlled unmerged negative proof.');
        }
      }
    }
  }

  const greenCheck = positiveChecks[0]!;
  const redCheck = controlledNegativeChecks[0]!;

  const resultWithoutContexts: Omit<FullActivationChecksQualificationResult, 'requiredContexts'> = {
    repository,
    repositoryId: input.fixtures[0]!.publication.repositoryId,
    actorId: input.fixtures[0]!.publication.actorId,
    sourceSha: sourceChecks[0]!.producerSourceSha,
    ...(input.predecessors?.artifactDigest ? { artifactDigest: input.predecessors.artifactDigest } : {}),
    predecessors: input.predecessors!,
    positiveChecks,
    controlledNegativeChecks,
    qualifiedAt: verifiedAt,
    requiredChecks: sourceChecks,
    green: {
      conclusion: 'success',
      checkName: greenCheck.context,
      checkRunId: greenCheck.checkRunId,
      verifiedAt
    },
    deliberateRed: {
      conclusion: 'failure',
      deliberate: true,
      checkName: redCheck.context,
      checkRunId: redCheck.checkRunId,
      verifiedAt
    }
  };

  const requiredContexts = fullActivationCheckContextsFromQualification({
    ...resultWithoutContexts,
    kind: 'green-red-proof.v1',
    scope: 'activation'
  });

  return {
    ...resultWithoutContexts,
    requiredContexts
  };
}

/**
 * Executes full-activation green-red-proof. Verifies authority, materializes unmerged PR fixtures,
 * observes runs through private checkpoints, qualifies positive and deliberate-negative results,
 * and records live-readback proof and green-red-proof.v1 evidence.
 */
export async function executeFullActivationChecks(
  input: PhaseAdapterExecutionInput,
  options?: { predecessorVerifier?: PredecessorVerifierCallback }
): Promise<PhaseAdapterOutcome> {
  let lastOperation: ExternalOperationState | undefined;
  try {
    if ((input.inspection.scope ?? 'activation') !== 'activation') {
      return blockedQualificationOutcome(input, environmentQualificationScopeBlocker);
    }
    const operation = input.plan.operations.find((entry) =>
      entry.actionId === fullActivationChecksAction || entry.actionId === fullActivationChecksQualifyAction);
    if (!operation) {
      throw new GitHubActivationError('check-plan', 'There is no exact reviewed full-activation green-red-proof operation.');
    }
    await assertGitHubPhaseAuthority(input, operation);
    const config = await checkFullActivationInputs(input, options);
    const payload = operation.inputs as unknown as FullActivationChecksPlanPayload;
    if (payload.repository !== config.repository || payload.repositoryId !== config.repositoryId ||
      payload.actorId !== config.actorId || payload.sourceSha !== config.source ||
      payload.artifactDigest !== config.artifactDigest ||
      canonicalSha256(payload.predecessors) !== canonicalSha256(config.predecessors) ||
      !Array.isArray(payload.requiredChecks) || !payload.requiredChecks.length ||
      !Array.isArray(payload.fixtures) || payload.fixtures.length !== config.fixtures.length * 2) {
      throw new GitHubActivationError('check-plan', 'The exact reviewed check qualification scope changed after approval.');
    }
    const client = clientFor(input);
    const currentChecks: RequiredWorkflowCheck[] = [];
    for (const path of config.workflowPaths) {
      if (typeof path !== 'string') throw new GitHubActivationError('check-source', 'Every check workflow must retain its exact immutable path.');
      const source = await readbackWorkflowContent(client, config.repository, path, config.source);
      const workflow = await client.get(`/repos/${config.repository}/actions/workflows/${path.split('/').at(-1)}`);
      if (workflow.path !== path || workflow.state !== 'active') {
        throw new GitHubActivationError('check-source', 'The source workflow is no longer the exact active provider workflow.');
      }
      currentChecks.push(...await deriveRequiredSourceChecks(client, config.repository, source, positiveId(workflow.id)));
    }
    if (canonicalSha256(currentChecks) !== canonicalSha256(payload.requiredChecks)) {
      throw new GitHubActivationError('check-source', 'The exact required workflow, context or test manifest changed after review.');
    }
    if (!Array.isArray(payload.fixtureBindings) || payload.fixtureBindings.length !== payload.fixtures.length ||
      new Set(payload.fixtures.map((fixture) => fixture.featureBranch)).size !== payload.fixtures.length ||
      new Set(payload.fixtureBindings.map((selection) => selection.featureBranch)).size !== payload.fixtures.length) {
      throw new GitHubActivationError('check-plan', 'Every reviewed full-check fixture needs one unique configured polarity and target binding.');
    }
    const fixtures: readonly WorkflowPublicationPlan[] = payload.fixtures;
    for (const fixture of fixtures) {
      validateWorkflowPublicationPlan(fixture);
      const selected = payload.fixtureBindings.find((selection) => selection.featureBranch === fixture.featureBranch);
      const configured = config.fixtures.find((entry) => entry.refFamily === selected?.refFamily);
      if (!selected || !configured || !['positive', 'negative'].includes(selected.polarity) ||
        fixture.repository !== config.repository || fixture.repositoryId !== config.repositoryId || fixture.actorId !== config.actorId ||
        fixture.baseSha !== configured.baseSha || fixture.targetBranch !== configured.targetBranch ||
        fixture.commitTime !== configured.commitTime ||
        fixture.featureBranch !== configured[selected.polarity === 'positive' ? 'positiveBranch' : 'negativeBranch'] ||
        canonicalSha256(fixture.files.map(({ path, content, digest }) => ({ path, content, digest }))) !==
          canonicalSha256(controlledSourceCheckFixtures(
            currentChecks.filter((check) => check.refFamilies.includes(selected.refFamily)), selected.polarity
          ))) {
        throw new GitHubActivationError('check-plan', 'The complete full-check fixture source, target, polarity or actor differs from the exact reviewed configuration.');
      }
    }
    const bound: BoundRepositoryCheckFixture[] = [];
    for (const fixture of fixtures) {
      const selection = payload.fixtureBindings.find((entry) => entry.featureBranch === fixture.featureBranch);
      if (!selection) throw new GitHubActivationError('check-plan', 'A reviewed fixture is missing its positive/negative protected-ref binding.');
      const checks = payload.requiredChecks.filter((check) => check.refFamilies.includes(selection.refFamily));
      const bindings = [...new Set(checks.map((check) => check.workflowId))].map((id) => fixtureWorkflowBinding(fixture, checks, id));
      for (const b of bindings) await fixtureRun(input, operation, client, b, fixture);
      const materialized = await materializeGitFlowPullRequest({ execution: input, operation, publication: fixture, client });
      lastOperation = materialized.operation;
      const pullRequestNumber = positiveId(materialized.pullRequest.number, 'Fixture PR number');
      await assertPublicationPreconditions(client, fixture);

      const pr = await client.get(`/repos/${payload.repository}/pulls/${pullRequestNumber}`);
      if (pr.state !== 'open' || pr.merged !== false) {
        throw new GitHubActivationError('check-fixture-pr', 'A source-check fixture must remain the exact actor-owned unmerged PR with unchanged source and target refs.');
      }

      const runs = [];
      for (const b of bindings) {
        const run = await fixtureRun(input, operation, client, b, fixture, pullRequestNumber);
        if (!run) {
          return {
            status: 'pending',
            operation: lastOperation,
            completedOperations: [],
            blocker: 'The exact unmerged fixture PR is recorded; its source-bound workflow event has not appeared yet. Recovery reads this PR and never recreates or redispatches it.'
          };
        }
        lastOperation = run.operation;
        if (run.operation.status === 'running') {
          return {
            status: 'pending',
            operation: run.operation,
            completedOperations: [],
            blocker: 'The exact recorded fixture workflow is still running. Bounded recovery observes that same provider run and attempt.'
          };
        }
        runs.push(run);
      }
      bound.push({ publication: fixture, polarity: selection.polarity, refFamily: selection.refFamily, pullRequestNumber, runs });
    }
    const qualification = await qualifyFullActivationChecks({
      client,
      repository: payload.repository,
      requiredChecks: payload.requiredChecks,
      fixtures: bound,
      predecessors: payload.predecessors,
      now: input.now,
      artifactReadback: { execution: input, operation }
    });
    if (qualification.repositoryId !== payload.repositoryId || qualification.actorId !== payload.actorId ||
      qualification.sourceSha !== payload.sourceSha) {
      throw new GitHubActivationError('check-result-binding', 'Observed check qualification differs from the approved repository, actor or workflow producer source.');
    }
    const checks = [...qualification.positiveChecks, ...qualification.controlledNegativeChecks];
    const resources = checks.map((check) => ({
      provider: 'github' as const,
      resourceType: 'check-run',
      resourceId: `/repos/${payload.repository}/check-runs/${check.checkRunId}`
    }));
    const evidencePayload: FullActivationChecksEvidencePayload = {
      kind: 'green-red-proof.v1',
      scope: 'activation',
      ...qualification,
      boundFixtures: bound
    };
    return {
      status: 'completed',
      resultState: 'verified',
      completedOperations: [operation],
      evidencePayload,
      liveReadback: checks.map((check, index) => readbackProof(input, 'github', 'check-run', resources[index]!.resourceId, {
        repository: payload.repository,
        sourceSha: payload.sourceSha,
        requiredChecks: qualification.requiredChecks,
        check
      })),
      outputs: {
        values: {
          sourceSha: payload.sourceSha,
          artifactDigest: payload.artifactDigest ?? null,
          requiredChecksDigest: canonicalSha256(qualification.requiredChecks),
          requiredContextsDigest: canonicalSha256(qualification.requiredContexts),
          positiveChecksPassed: true,
          controlledNegativeChecksPassed: true
        },
        resources
      }
    };
  } catch (error) {
    if (error instanceof SourceCheckArtifactPendingError) {
      return { status: 'pending', blocker: error.message, completedOperations: [], operation: error.operation };
    }
    return {
      status: 'blocked',
      blocker: safeGitHubFailure(error),
      completedOperations: [],
      ...(lastOperation ? { operation: lastOperation } : {})
    };
  }
}

/**
 * Read-only revalidation of retained green-red-proof qualification evidence.
 * Verifies that unmerged PRs, exact workflow runs, jobs, steps and predecessors remain intact.
 * Read-only: never creates refs, commits, pushes, dispatches or mutates provider state.
 */
export async function revalidateFullActivationChecks(
  input: FullActivationChecksRevalidationInput
): Promise<FullActivationChecksQualificationResult> {
  const evidence = structuredClone(input.evidence);
  if (evidence.kind !== 'green-red-proof.v1' || evidence.scope !== 'activation' ||
    !Array.isArray(evidence.boundFixtures) || !evidence.boundFixtures.length ||
    evidence.boundFixtures.length > protectedRefFamilies.length * 2) {
    throw new GitHubActivationError(
      'check-revalidation-binding',
      'Full-activation check revalidation requires retained green-red-proof evidence with activation scope and exact fixture plans, not repository-only checks.'
    );
  }
  const expectedContexts = fullActivationCheckContextsFromQualification(evidence);

  const readOnly = new GitHubActivationClient({
    async request(request) {
      if (request.method !== 'GET') {
        throw new GitHubActivationError('check-read-only', 'Consuming green-red-proof revalidation permits readback only, never dispatch, PR creation or provider mutation.');
      }
      return input.client.transport.request(request);
    }
  });

  if (!input.predecessorVerifier) {
    throw new GitHubActivationError('full-qualification-verifier-required',
      'Full proof revalidation requires its concrete retained staging and rollout/rollback reader; public predecessor metadata is not qualification.');
  }
  {
    const verified = await input.predecessorVerifier({
      staging: {
        evidenceId: evidence.predecessors.staging.evidenceId,
        headerDigest: evidence.predecessors.staging.headerDigest,
        bodyDigest: evidence.predecessors.staging.bodyDigest
      },
      rehearsal: {
        evidenceId: evidence.predecessors.rehearsal.evidenceId,
        headerDigest: evidence.predecessors.rehearsal.headerDigest,
        bodyDigest: evidence.predecessors.rehearsal.bodyDigest
      },
      sourceSha: evidence.sourceSha,
      artifactDigest: evidence.artifactDigest,
      now: input.now
    });
    if (canonicalSha256(verified) !== canonicalSha256(evidence.predecessors)) {
      throw new GitHubActivationError('check-revalidation-drift', 'Current predecessor verification differs from the retained proof references.');
    }
  }

  const current = await qualifyFullActivationChecks({
    client: readOnly,
    repository: evidence.repository,
    requiredChecks: evidence.requiredChecks,
    fixtures: evidence.boundFixtures,
    predecessors: evidence.predecessors,
    now: input.now,
    ...(input.artifactReadback ? { artifactReadback: input.artifactReadback } : {}),
    failedArtifacts: evidence.controlledNegativeChecks.flatMap((proof) => proof.fixtureArtifact ? [proof.fixtureArtifact.request] : [])
  });

  const stableProofs = (proofs: readonly (PositiveCheckQualification | ControlledNegativeCheckQualification)[]) =>
    proofs.map(({ verifiedAt: _v, ...proof }) => proof);

  if (current.repositoryId !== evidence.repositoryId || current.actorId !== evidence.actorId ||
    current.sourceSha !== evidence.sourceSha ||
    canonicalSha256(current.requiredContexts) !== canonicalSha256(expectedContexts) ||
    canonicalSha256(stableProofs(current.positiveChecks)) !== canonicalSha256(stableProofs(evidence.positiveChecks)) ||
    canonicalSha256(stableProofs(current.controlledNegativeChecks)) !== canonicalSha256(stableProofs(evidence.controlledNegativeChecks))) {
    throw new GitHubActivationError('check-revalidation-drift', 'Actual current workflow, check, job, validation step or fixture identity differs from the retained qualified evidence.');
  }

  return current;
}

export const fullActivationChecksExtensionContract: FullActivationChecksExtensionContract = {
  phaseId: greenRedProofPhaseId,
  scope: 'activation',
  actionId: fullActivationChecksAction,
  plan: planFullActivationChecks,
  execute: executeFullActivationChecks,
  revalidate: revalidateFullActivationChecks,
  qualify: qualifyFullActivationChecks,
  verifyPredecessors: verifyFullActivationPredecessors,
  projectContexts: fullActivationCheckContextsFromQualification
};
