import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  GitHubActivationError,
  githubRef,
  githubRepository,
  object,
  positiveId,
  text,
  type GitHubActivationClient
} from './activation-rest.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { readbackWorkflowContent, readbackValidationSource } from './workflow-source-readback.js';
import type { WorkflowPublicationPlan } from './production-workflows.js';
import {
  controlledSourceCheckFixtures, deriveRequiredSourceChecks, isProtectedRefFamily, matchesProtectedRefFamily, protectedRefFamilies,
  type RequiredWorkflowCheck, type ProtectedRefFamily
} from './workflow-check-recipes.js';
import { readBoundWorkflowRun, type WorkflowRunBinding } from './workflow-run-readback.js';
import { readWorkflowArtifactBytes, type WorkflowArtifactReadback } from './workflow-artifact-readback.js';
export {
  observeOrPollWorkflowRun, readBoundWorkflowRun, sourceCheckFixtureWorkflowBinding,
  type BoundWorkflowJob, type WorkflowRunBinding, type RecordedWorkflowRunIdentity
} from './workflow-run-readback.js';
export {
  readOriginalCheckFixtureCustody, type OriginalCheckFixturePlanReference, type OriginalCheckFixtureCustody
} from '../../application/repository-governance/workflow-fixture-origin.js';
export { dispatchApprovedWorkflowRun, WorkflowDispatchReadbackPendingError, type WorkflowDispatchResult } from './workflow-dispatch.js';
export {
  extractWorkflowReport, WorkflowReportArchiveError, workflowReportArchiveErrorCode, type WorkflowReportExtractionOptions
} from './workflow-report-archive.js';
export {
  readBoundFailedWorkflowArtifact, FailedWorkflowArtifactPendingError, type FailedWorkflowArtifactReadback, type FailedWorkflowArtifactRequest,
  type WorkflowRunOriginReference
} from './workflow-failed-artifact.js';
export type { WorkflowArtifactDescriptor, WorkflowArtifactReadback } from './workflow-artifact-readback.js';
export {
  deriveRequiredNodeTestChecks, deriveRequiredSourceChecks, isProtectedRefFamily, matchesProtectedRefFamily, protectedRefFamilies,
  type RequiredWorkflowCheck, type ProtectedRefFamily
} from './workflow-check-recipes.js';
import type {
  ExternalOperationState, TransitionOperation
} from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { FailedWorkflowArtifactRequest } from './workflow-failed-artifact.js';
import {
  readRepositorySourceCheckFailedArtifact, type SourceCheckFixtureArtifactReadback
} from '../../application/repository-governance/source-check-artifact.js';
import {
  readSourceCheckAssertionExecution, sourceCheckAssertionIdentity, type SourceCheckAssertionExecution
} from './source-check-execution.js';

export interface SourceCheckProofBinding {
  workflowId: number;
  workflowPath: string;
  workflowDigest: string;
  producerSourceSha: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  jobKey: string;
  actorId: number;
  repositoryId: number;
  appId: number;
  appSlug: string;
  refFamily: ProtectedRefFamily;
  fixtureRef: string;
  pullRequestNumber: number;
  validationStep: { name: string; number: number; conclusion: string };
}

export interface PositiveCheckQualification extends SourceCheckProofBinding {
  context: string;
  headSha: string;
  checkRunId: number;
  conclusion: 'success';
  verifiedAt: string;
}

export interface ControlledNegativeCheckQualification extends SourceCheckProofBinding {
  context: string;
  fixtureRef: string;
  headSha: string;
  checkRunId: number;
  conclusion: 'failure';
  deliberateFailure: true;
  assertionExecution: SourceCheckAssertionExecution;
  verifiedAt: string;
  fixtureArtifact?: SourceCheckFixtureArtifactReadback;
}

export interface RepositoryChecksQualificationResult {
  repository: string;
  repositoryId: number;
  actorId: number;
  sourceSha: string;
  positiveChecks: readonly PositiveCheckQualification[];
  controlledNegativeChecks: readonly ControlledNegativeCheckQualification[];
  qualifiedAt: string;
  requiredChecks: readonly RequiredWorkflowCheck[];
  requiredContexts: readonly QualifiedRepositoryCheckContext[];
}

export interface QualifiedRepositoryCheckRun {
  runId: number;
  runAttempt: number;
  checkRunId: number;
  jobId: number;
  headSha: string;
  fixtureRef: string;
  pullRequestNumber: number;
}

export interface QualifiedRepositoryCheckContext {
  context: string;
  appId: number;
  appSlug: 'github-actions';
  workflowId: number;
  workflowPath: string;
  workflowDigest: string;
  workflowBlobSha: string;
  producerSourceSha: string;
  jobKey: string;
  refFamily: ProtectedRefFamily;
  positive: QualifiedRepositoryCheckRun;
  controlledNegative: QualifiedRepositoryCheckRun;
}

export interface BoundRepositoryCheckFixture {
  publication: WorkflowPublicationPlan;
  polarity: 'positive' | 'negative';
  refFamily: ProtectedRefFamily;
  pullRequestNumber: number;
  runs: readonly { binding: WorkflowRunBinding; operation: ExternalOperationState }[];
}

export interface RepositoryChecksEvidencePayload extends RepositoryChecksQualificationResult {
  kind: 'repository-checks-qualified.v1';
  boundFixtures: readonly BoundRepositoryCheckFixture[];
}

/** Projects internally coherent repository proof only; callers must separately admit its phase, authority and freshness. */
export function repositoryCheckContextsFromQualification(value: unknown): readonly QualifiedRepositoryCheckContext[] {
  const result = object(value, 'Repository check qualification');
  const fail = (): never => {
    throw new GitHubActivationError('check-context-binding',
      'Repository check qualification has missing, reused or conflicting source, actor, app, ref-family or provider proof. It cannot supply required contexts.');
  };
  if (result.kind !== undefined && result.kind !== 'repository-checks-qualified.v1' ||
    result.scope !== undefined && result.scope !== 'repository') fail();
  githubRepository(result.repository);
  const repositoryId = positiveId(result.repositoryId), actorId = positiveId(result.actorId);
  const producerSourceSha = sourceSha(result.sourceSha);
  if (typeof result.qualifiedAt !== 'string' || !Number.isFinite(Date.parse(result.qualifiedAt))) fail();
  const records = (input: unknown, maximum: number) => {
    if (!Array.isArray(input) || !input.length || input.length > maximum) return fail();
    return input.map((entry) => object(entry, 'Repository check proof'));
  };
  const required = records(result.requiredChecks, 32);
  const positive = records(result.positiveChecks, 32 * protectedRefFamilies.length);
  const negative = records(result.controlledNegativeChecks, 32 * protectedRefFamilies.length);
  const contexts: QualifiedRepositoryCheckContext[] = [];
  const seen = new Set<string>();
  for (const check of required) {
    const context = text(check.context, 'Required check context');
    const workflowId = positiveId(check.workflowId);
    const jobKey = text(check.jobId, 'Source workflow job key');
    const workflowPath = text(check.workflowPath, 'Required workflow path');
    const workflowDigest = text(check.workflowDigest, 'Required workflow digest');
    const workflowBlobSha = sourceSha(check.workflowBlobSha, 'Required workflow blob SHA');
    const families = check.refFamilies;
    if (!Array.isArray(families)) return fail();
    if (seen.has(context) || check.producerSourceSha !== producerSourceSha ||
      !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(workflowPath) ||
      !/^[a-f0-9]{64}$/u.test(workflowDigest) || !families.length ||
      families.length > protectedRefFamilies.length || new Set(families).size !== families.length) fail();
    seen.add(context);
    let workflowAppId: number | undefined;
    for (const family of families) {
      if (!isProtectedRefFamily(family)) return fail();
      const select = (proofs: readonly Record<string, unknown>[], conclusion: 'success' | 'failure') => {
        const matches = proofs.filter((proof) => proof.context === context && proof.workflowId === workflowId &&
          proof.jobKey === jobKey && proof.refFamily === family);
        const proof = matches[0];
        if (matches.length !== 1 || !proof || proof.repositoryId !== repositoryId || proof.actorId !== actorId ||
          proof.workflowPath !== workflowPath || proof.workflowDigest !== workflowDigest ||
          proof.producerSourceSha !== producerSourceSha || proof.appSlug !== 'github-actions' ||
          proof.conclusion !== conclusion || conclusion === 'failure' && proof.deliberateFailure !== true ||
          typeof proof.verifiedAt !== 'string' || !Number.isFinite(Date.parse(proof.verifiedAt)) ||
          Date.parse(proof.verifiedAt) > Date.parse(String(result.qualifiedAt))) fail();
        const step = object(proof.validationStep);
        if (step.name !== check.validationStep || step.conclusion !== conclusion) fail();
        positiveId(step.number, 'Observed validation step number');
        const run: QualifiedRepositoryCheckRun = {
          runId: positiveId(proof.runId), runAttempt: positiveId(proof.runAttempt),
          checkRunId: positiveId(proof.checkRunId), jobId: positiveId(proof.jobId),
          headSha: sourceSha(proof.headSha), fixtureRef: githubRef(proof.fixtureRef),
          pullRequestNumber: positiveId(proof.pullRequestNumber)
        };
        if (conclusion === 'failure' && canonicalSha256(proof.assertionExecution ?? null) !== canonicalSha256({
          ...sourceCheckAssertionIdentity(check.recipe, check.workingDirectory, jobKey), jobId: run.jobId
        })) fail();
        if (run.runAttempt !== 1 || !/^(?:feature|automation)\/[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(run.fixtureRef)) fail();
        return { run, appId: positiveId(proof.appId) };
      };
      const green = select(positive, 'success'), red = select(negative, 'failure');
      if (green.appId !== red.appId || workflowAppId !== undefined && green.appId !== workflowAppId ||
        green.run.runId === red.run.runId || green.run.jobId === red.run.jobId ||
        green.run.checkRunId === red.run.checkRunId || green.run.headSha === red.run.headSha ||
        green.run.fixtureRef === red.run.fixtureRef || green.run.pullRequestNumber === red.run.pullRequestNumber) fail();
      workflowAppId = green.appId;
      contexts.push({
        context, appId: green.appId, appSlug: 'github-actions', workflowId, workflowPath, workflowDigest, workflowBlobSha,
        producerSourceSha, jobKey, refFamily: family, positive: green.run, controlledNegative: red.run
      });
    }
  }
  if (contexts.length !== positive.length || contexts.length !== negative.length ||
    result.requiredContexts !== undefined && canonicalSha256(result.requiredContexts) !== canonicalSha256(contexts)) fail();
  return contexts;
}

/** Bounded commit/check observation only. A failure here is not controlled-negative qualification. */
export async function verifyCommitCheckRun(
  client: GitHubActivationClient,
  repository: string,
  commitSha: string,
  contextName: string,
  expectedConclusion: 'success' | 'failure'
): Promise<{
  checkRunId: number;
  name: string;
  status: string;
  conclusion: string;
  headSha: string;
  appId: number | null;
  appSlug: string | null;
}> {
  const repo = githubRepository(repository);
  const sha = sourceSha(commitSha);

  const runs = await client.list(
    `/repos/${repo}/commits/${sha}/check-runs?filter=latest`,
    'check_runs'
  );

  const matching = runs.filter((r) => r.name === contextName);
  if (!matching.length) {
    throw new GitHubActivationError(
      'check-run-missing',
      `Required check run '${contextName}' was not found on commit ${sha}.`
    );
  }

  const check = matching[0]!;
  if (matching.length !== 1 || check.head_sha !== sha) {
    throw new GitHubActivationError('check-binding', 'Check readback must identify one exact requested commit and context.');
  }
  const status = text(check.status, 'Check run status');
  const conclusion = check.conclusion !== null ? text(check.conclusion, 'Check run conclusion') : null;

  if (status !== 'completed') {
    throw new GitHubActivationError(
      'check-run-in-progress',
      `Check run '${contextName}' has not settled (status: ${status}).`
    );
  }

  if (conclusion === 'skipped' || conclusion === 'cancelled' || conclusion === 'neutral') {
    throw new GitHubActivationError(
      'invalid-conclusion',
      `Check run '${contextName}' concluded with '${conclusion}', which cannot satisfy fail-closed verification.`
    );
  }

  if (conclusion !== expectedConclusion) {
    throw new GitHubActivationError(
      'unexpected-conclusion',
      `Check run '${contextName}' concluded with '${conclusion}', but expected '${expectedConclusion}'.`
    );
  }

  // If deliberate failure expected, verify it's an application test failure, not an infrastructure abort
  if (expectedConclusion === 'failure') {
    // If output is available, inspect for runner/infra failure
    const output = check.output ? object(check.output) : null;
    const summary = output?.summary ? String(output.summary).toLowerCase() : '';
    if (summary.includes('runner lost communication') || summary.includes('infrastructure error')) {
      throw new GitHubActivationError(
        'infrastructure-error',
        `Check run '${contextName}' failed due to infrastructure error, not deliberate test failure.`
      );
    }
  }

  const app = check.app ? object(check.app) : null;
  return {
    checkRunId: positiveId(check.id, 'Check run ID'),
    name: text(check.name, 'Check run name'),
    status,
    conclusion,
    headSha: sha,
    appId: app ? positiveId(app.id, 'App ID') : null,
    appSlug: app?.slug ? String(app.slug) : null
  };
}

/** Qualifies exact immutable workflow jobs on positive and controlled-negative unmerged PRs for every required ref family. */
export async function qualifyRepositorySourceChecks(input: {
  client: GitHubActivationClient;
  repository: string;
  headSha?: string;
  contexts?: readonly string[];
  requiredChecks?: readonly RequiredWorkflowCheck[];
  fixtures?: readonly BoundRepositoryCheckFixture[];
  deliberateRedFixture?: {
    ref: string;
    headSha: string;
    context: string;
  };
  now?: Date;
  artifactReadback?: { execution: PhaseAdapterExecutionInput; operation: TransitionOperation };
  failedArtifacts?: readonly FailedWorkflowArtifactRequest[];
}): Promise<RepositoryChecksQualificationResult> {
  if (!input.requiredChecks?.length || !input.fixtures?.length ||
    input.fixtures.length > protectedRefFamilies.length * 2 || input.requiredChecks.length > 32) {
    throw new GitHubActivationError('check-binding-required',
      'Full source-check qualification requires exact workflow source, actor, ref, run/job/check binding and a reviewed unmerged controlled-negative fixture. Bare check conclusions cannot qualify repository enforcement.');
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
      !matchesProtectedRefFamily(plan.targetBranch, fixture.refFamily) ||
      canonicalSha256(plan.files.map(({ path, content, digest }) => ({ path, content, digest }))) !==
        canonicalSha256(controlledSourceCheckFixtures(sourceChecks.filter((check) => check.refFamilies.includes(fixture.refFamily)), fixture.polarity))) {
      throw new GitHubActivationError('check-fixture', 'Qualification requires the actual registered controlled test fixture, repository and applicable protected ref family.');
    }
    const pullRequest = await input.client.get(`/repos/${repository}/pulls/${positiveId(fixture.pullRequestNumber)}`);
    const head = object(pullRequest.head), base = object(pullRequest.base);
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
        fixture.polarity === 'negative' && job.steps.some((step) =>
          step.name !== expected.validationStep && step.conclusion === 'failure')) {
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
        const negative: Omit<ControlledNegativeCheckQualification, 'assertionExecution'> = { ...proof, conclusion: 'failure', deliberateFailure: true };
        if (expected.fixtureArtifact) {
          if (!input.artifactReadback) {
            throw new GitHubActivationError('check-fixture-artifact-authority', 'This immutable source declares a failed fixture artifact; its original private custody and independently approved current GitHub readback are required.');
          }
          const requests = input.failedArtifacts?.filter((request) => request.operation.operationId === selected.operation.operationId &&
            request.job.jobKey === expected.jobId) ?? [];
          if (requests.length > 1) throw new GitHubActivationError('check-fixture-artifact-authority', 'Repeated artifact requests cannot replace one exact original fixture artifact.');
          negative.fixtureArtifact = await readRepositorySourceCheckFailedArtifact({
            ...input.artifactReadback, check: expected, fixture, proof: negative, ...(requests[0] ? { request: requests[0] } : {})
          });
        }
        const assertionExecution = await readSourceCheckAssertionExecution(input.client, repository, expected, job.id);
        controlledNegativeChecks.push({ ...negative, assertionExecution });
      }
    }
  }
  for (const check of sourceChecks) for (const family of check.refFamilies) for (const polarity of ['positive', 'negative']) {
    if (!seen.has(`${family}:${polarity}:${check.workflowId}:${check.jobId}`)) {
      throw new GitHubActivationError('check-proof-missing', 'Every required actual workflow/job/ref family needs independent positive and controlled unmerged negative proof.');
    }
  }
  const result = {
    repository, repositoryId: input.fixtures[0]!.publication.repositoryId, actorId: input.fixtures[0]!.publication.actorId,
    sourceSha: sourceChecks[0]!.producerSourceSha, positiveChecks, controlledNegativeChecks,
    requiredChecks: sourceChecks, qualifiedAt: verifiedAt
  };
  return { ...result, requiredContexts: repositoryCheckContextsFromQualification(result) };
}

/** Reobserves retained provider identities without dispatching; evidence/plan authority admission remains the caller's responsibility. */
export async function revalidateRepositoryChecksQualification(input: {
  client: GitHubActivationClient;
  evidence: RepositoryChecksEvidencePayload;
  now?: Date;
  artifactReadback?: { execution: PhaseAdapterExecutionInput; operation: TransitionOperation };
}): Promise<RepositoryChecksQualificationResult> {
  const evidence = structuredClone(input.evidence);
  if (evidence.kind !== 'repository-checks-qualified.v1' ||
    !Array.isArray(evidence.boundFixtures) || !evidence.boundFixtures.length ||
    evidence.boundFixtures.length > protectedRefFamilies.length * 2) {
    throw new GitHubActivationError('check-revalidation-binding', 'Repository check revalidation requires retained exact fixture plans and provider run bindings, not copied proof fields or full-activation evidence.');
  }
  const expectedContexts = repositoryCheckContextsFromQualification(evidence);
  const current = await qualifyRepositorySourceChecks({
    client: input.client, repository: evidence.repository, requiredChecks: evidence.requiredChecks,
    fixtures: evidence.boundFixtures, now: input.now,
    ...(input.artifactReadback ? { artifactReadback: input.artifactReadback } : {}),
    failedArtifacts: evidence.controlledNegativeChecks.flatMap((check) => check.fixtureArtifact ? [check.fixtureArtifact.request] : [])
  });
  const stableProofs = (proofs: readonly (PositiveCheckQualification | ControlledNegativeCheckQualification)[]) =>
    proofs.map(({ verifiedAt: _verifiedAt, ...proof }) => proof);
  if (current.repositoryId !== evidence.repositoryId || current.actorId !== evidence.actorId ||
    current.sourceSha !== evidence.sourceSha ||
    canonicalSha256(current.requiredContexts) !== canonicalSha256(expectedContexts) ||
    canonicalSha256(stableProofs(current.positiveChecks)) !== canonicalSha256(stableProofs(evidence.positiveChecks)) ||
    canonicalSha256(stableProofs(current.controlledNegativeChecks)) !== canonicalSha256(stableProofs(evidence.controlledNegativeChecks))) {
    throw new GitHubActivationError('check-revalidation-drift', 'Actual current workflow, check, job, validation step or fixture identity differs from the retained qualified evidence.');
  }
  return current;
}

/** Returns an integrity-checked opaque archive, not an OCI digest or semantic/private-state qualification. */
export async function readBoundWorkflowArtifact(input: {
  client: GitHubActivationClient;
  binding: WorkflowRunBinding;
  operation: ExternalOperationState;
  artifactId: number;
  name: string;
  expectedDigest?: string;
}): Promise<WorkflowArtifactReadback> {
  const run = await readBoundWorkflowRun(input.client, input.binding, input.operation);
  if (run.conclusion !== 'success') throw new GitHubActivationError('artifact-producer', 'A failed producer run cannot establish a qualified artifact.');
  return readWorkflowArtifactBytes({ ...input, runId: run.runId });
}
