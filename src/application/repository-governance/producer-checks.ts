import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import type { ExternalOperationState, TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  clientFor, githubOperation, phaseConfiguration, repositoryConfiguration, sourceSha, verifiedOutput
} from '../../governance-activation/github-config.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import {
  qualifyRepositorySourceChecks, type BoundRepositoryCheckFixture, type RepositoryChecksEvidencePayload, type WorkflowRunBinding
} from '../../adapters/github/production-checks.js';
import { sourceCheckFixtureWorkflowBinding } from '../../adapters/github/workflow-run-readback.js';
import {
  materializeGitFlowPullRequest, planWorkflowSourcePublication, readbackWorkflowContent,
  readbackValidationSource, assertPublicationPreconditions, type WorkflowPublicationPlan
} from '../../adapters/github/production-workflows.js';
import {
  controlledSourceCheckFixtures, deriveRequiredSourceChecks, isProtectedRefFamily, matchesProtectedRefFamily, protectedRefFamilies,
  type RequiredWorkflowCheck, type ProtectedRefFamily
} from '../../adapters/github/workflow-check-recipes.js';
import { GitHubActivationError, object, positiveId, safeGitHubFailure, type GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';
import { SourceCheckArtifactPendingError } from './source-check-artifact.js';
import {
  prepareWorkflowEffect, readWorkflowEffect, recordWorkflowProviderResult, type WorkflowEffectIdentity
} from './workflow-checkpoints.js';

export const repositoryChecksAction = 'github.checks.repository-qualified' as const;

export interface RepositoryCheckFixtureConfiguration {
  refFamily: ProtectedRefFamily;
  targetBranch: string;
  baseSha: string;
  positiveBranch: string;
  negativeBranch: string;
  commitTime: string;
}

export interface RepositoryChecksPlanPayload {
  repository: string;
  repositoryId: number;
  actorId: number;
  sourceSha: string;
  requiredChecks: readonly RequiredWorkflowCheck[];
  fixtures: readonly WorkflowPublicationPlan[];
  fixtureBindings: readonly { featureBranch: string; polarity: 'positive' | 'negative'; refFamily: ProtectedRefFamily }[];
}

async function checkInputs(input: PhasePlanningInput) {
  const config = phaseConfiguration(input.inspection, input.phase.id, ['sourceSha', 'workflowPaths', 'repositoryId', 'actorId', 'fixtures']);
  const repository = repositoryConfiguration(input.inspection).name;
  const source = sourceSha(config.sourceSha);
  const repositoryId = positiveId(config.repositoryId);
  const actorId = positiveId(config.actorId);
  if (input.inspection.state.remoteBinding?.id !== String(repositoryId) ||
    verifiedOutput(input.inspection, 'repository-workflow-source-ready', 'sourceSha') !== source ||
    !Array.isArray(config.workflowPaths) || !config.workflowPaths.length || config.workflowPaths.length > 8 ||
    new Set(config.workflowPaths).size !== config.workflowPaths.length ||
    !Array.isArray(config.fixtures) || !config.fixtures.length || config.fixtures.length > protectedRefFamilies.length) {
    throw new GitHubActivationError('check-inputs', 'Source qualification needs current published workflow output, exact repository/actor IDs, immutable workflow paths and one reviewed fixture pair per protected ref family.');
  }
  const fixtures = config.fixtures.map((value) => {
    const entry = object(value);
    if (Object.keys(entry).sort().join(',') !==
      ['refFamily', 'targetBranch', 'baseSha', 'positiveBranch', 'negativeBranch', 'commitTime'].sort().join(',') ||
      !isProtectedRefFamily(entry.refFamily) ||
      typeof entry.targetBranch !== 'string' || !matchesProtectedRefFamily(entry.targetBranch, entry.refFamily) ||
      typeof entry.positiveBranch !== 'string' || typeof entry.negativeBranch !== 'string' ||
      typeof entry.commitTime !== 'string') {
      throw new GitHubActivationError('check-fixtures', 'Fixture configuration requires exact existing GitFlow target refs and distinct unmerged positive/negative branches; arbitrary recipes or commands are forbidden.');
    }
    sourceSha(entry.baseSha);
    return entry as unknown as RepositoryCheckFixtureConfiguration;
  });
  if (new Set(fixtures.map((fixture) => fixture.refFamily)).size !== fixtures.length ||
    new Set(fixtures.flatMap((fixture) => [fixture.positiveBranch, fixture.negativeBranch])).size !== fixtures.length * 2) {
    throw new GitHubActivationError('check-fixtures', 'Each protected ref family and controlled fixture branch must be unique.');
  }
  return { repository, repositoryId, actorId, source, workflowPaths: config.workflowPaths, fixtures };
}

export async function planRepositoryChecks(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    const config = await checkInputs(input);
    const client = clientFor(input);
    const checks: RequiredWorkflowCheck[] = [];
    for (const path of config.workflowPaths) {
      if (typeof path !== 'string') throw new GitHubActivationError('check-workflow', 'Every workflow needs an exact immutable source path.');
      const source = await readbackWorkflowContent(client, config.repository, path, config.source);
      const workflow = await client.get(`/repos/${config.repository}/actions/workflows/${path.split('/').at(-1)}`);
      if (workflow.path !== path || workflow.state !== 'active') throw new GitHubActivationError('check-workflow', 'The actual active workflow ID/path does not match the immutable approved source.');
      checks.push(...await deriveRequiredSourceChecks(client, config.repository, source, positiveId(workflow.id)));
    }
    if (new Set(checks.map((check) => check.context)).size !== checks.length) {
      throw new GitHubActivationError('check-context-collision', 'Required status contexts must be unambiguous across the actual immutable workflows.');
    }
    const families = new Set(checks.flatMap((check) => check.refFamilies));
    if (families.size !== config.fixtures.length || config.fixtures.some((fixture) => !families.has(fixture.refFamily))) {
      throw new GitHubActivationError('check-ref-coverage', 'The reviewed fixture pairs must cover every and only the protected ref families selected by the actual workflow triggers.');
    }
    const priorDigest = input.inspection.state.phases[input.phase.id].executionPlanDigest;
    const prior = priorDigest ? input.inspection.contexts[input.phase.id].reviewedPlans?.find((plan) =>
      plan.phaseId === input.phase.id && plan.planDigest === priorDigest)?.operations.find((operation) =>
      operation.actionId === repositoryChecksAction)?.inputs as unknown as RepositoryChecksPlanPayload | undefined : undefined;
    const fixtures: WorkflowPublicationPlan[] = [];
    const fixtureBindings: RepositoryChecksPlanPayload['fixtureBindings'][number][] = [];
    for (const family of config.fixtures) {
      for (const check of checks.filter((check) => check.refFamilies.includes(family.refFamily))) {
        const baseSource = await readbackWorkflowContent(client, config.repository, check.workflowPath, family.baseSha);
        if (baseSource.digest !== check.workflowDigest) throw new GitHubActivationError('check-target-source', 'The actual protected target must contain the approved workflow bytes; a fixture cannot substitute an unrelated workflow.');
        if (check.validationManifest) {
          const manifest = await readbackValidationSource(client, config.repository, check.validationManifest.path, family.baseSha);
          if (manifest.digest !== check.validationManifest.digest) throw new GitHubActivationError('check-target-source', 'The actual target validation manifest differs from the immutable approved test script.');
        }
      }
      for (const polarity of ['positive', 'negative'] as const) {
        const featureBranch = polarity === 'positive' ? family.positiveBranch : family.negativeBranch;
        const files = controlledSourceCheckFixtures(checks.filter((check) => check.refFamilies.includes(family.refFamily)), polarity);
        const retained = prior?.fixtures.find((fixture) => fixture.featureBranch === featureBranch);
        if (prior && !retained) throw new GitHubActivationError('check-recovery-inputs', 'Recovery cannot replace recorded fixture branches or dispatch a new qualification plan around an uncertain request.');
        const plan = retained ?? await planWorkflowSourcePublication({
          client, repository: config.repository, repositoryId: config.repositoryId, actorId: config.actorId,
          baseSha: family.baseSha, targetBranch: family.targetBranch, featureBranch, workflowFiles: files,
          commitMessage: `Qualify source checks: ${family.refFamily} ${polarity}`,
          commitTime: family.commitTime, recipe: 'gitflow-source-check-fixture.v1'
        });
        if (plan.repository !== config.repository || plan.repositoryId !== config.repositoryId || plan.actorId !== config.actorId ||
          plan.baseSha !== family.baseSha || plan.targetBranch !== family.targetBranch || plan.commitTime !== family.commitTime ||
          canonicalSha256(plan.files.map(({ path, content, digest }) => ({ path, content, digest }))) !== canonicalSha256(files)) {
          throw new GitHubActivationError('check-recovery-inputs', 'Recorded fixture source or approved scope differs from current exact recovery inputs.');
        }
        fixtures.push(plan);
        fixtureBindings.push({ featureBranch, polarity, refFamily: family.refFamily });
      }
    }
    const payload: RepositoryChecksPlanPayload = {
      repository: config.repository, repositoryId: config.repositoryId, actorId: config.actorId, sourceSha: config.source,
      requiredChecks: checks, fixtures, fixtureBindings
    };
    const destination = { type: 'repository' as const, identity: config.repository, repository: config.repository };
    return { operations: [githubOperation(input, repositoryChecksAction, 'github-workflow-dispatch', { ...payload }, destination,
      ['github-read', 'github-write', 'git-push'].map((mutationClass) => ({
        mutationClass: mutationClass as 'github-read' | 'github-write' | 'git-push', destination, remote: true, destructive: false
      })))] };
  } catch (error) {
    return { operations: [], blockers: [safeGitHubFailure(error)] };
  }
}

async function fixtureRun(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, client: GitHubActivationClient,
  binding: WorkflowRunBinding, fixture: WorkflowPublicationPlan, pullRequestNumber?: number
): Promise<{ binding: WorkflowRunBinding; operation: ExternalOperationState } | null> {
  const identity: WorkflowEffectIdentity = {
    repositoryId: binding.repositoryId, ref: `${binding.ref}:${binding.workflowId}`, purpose: 'check-fixture', step: 'dispatch'
  };
  const payload = { binding, fixtureDigest: canonicalSha256(fixture) };
  let records = await readWorkflowEffect(input, operation, identity, payload);
  if (pullRequestNumber === undefined) {
    if (!records) await prepareWorkflowEffect(input, operation, identity, payload);
    return null;
  }
  if (!records) throw new GitHubActivationError('fixture-pre-effect', 'A fixture run cannot be adopted without its private checkpoint preceding the PR trigger.');
  const exact = (run: Record<string, unknown>) => run.workflow_id === binding.workflowId &&
    run.path === binding.workflowPath && run.head_sha === binding.sourceSha && run.head_branch === binding.ref &&
    run.event === 'pull_request' && run.run_attempt === 1 && object(run.actor).id === binding.actorId &&
    object(run.repository).id === binding.repositoryId && object(run.repository).full_name === binding.repository &&
    typeof run.created_at === 'string' && Date.parse(run.created_at) >= Date.parse(records!.prepared.preparedAt) &&
    Array.isArray(run.pull_requests) && run.pull_requests.some((value) => {
      const pr = object(value);
      return pr.number === pullRequestNumber && object(pr.head).sha === fixture.commitSha && object(pr.base).sha === fixture.baseSha;
    });
  let run: Record<string, unknown>;
  if (records.observed) {
    run = await client.get(`${records.observed.resourceId}/attempts/1`);
    if (String(run.id) !== records.observed.providerId || !exact(run)) throw new GitHubActivationError('fixture-run-drift', 'The recorded fixture workflow run changed actor, source, attempt or PR binding.');
  } else {
    const candidates = await client.list(`/repos/${binding.repository}/actions/workflows/${binding.workflowId}/runs?head_sha=${binding.sourceSha}&event=pull_request&branch=${binding.ref}`, 'workflow_runs');
    const matching = candidates.filter(exact);
    if (!matching.length) return null;
    if (matching.length !== 1) throw new GitHubActivationError('fixture-run-ambiguous', 'Multiple exact-looking runs cannot substitute for one recorded fixture event; no latest run is adopted.');
    run = await client.get(`/repos/${binding.repository}/actions/runs/${positiveId(matching[0]!.id)}/attempts/1`);
    if (!exact(run)) throw new GitHubActivationError('fixture-run-binding', 'Actual run readback differs from the source-bound fixture event.');
    await recordWorkflowProviderResult(input, operation, identity, records.prepared, 'observed', {
      status: 200, requestId: null, providerId: String(positiveId(run.id)),
      resourceId: `/repos/${binding.repository}/actions/runs/${run.id}`
    });
  }
  return { binding, operation: {
    provider: 'github', actionId: operation.actionId, operationId: String(positiveId(run.id)),
    resourceId: `/repos/${binding.repository}/actions/runs/${run.id}`,
    startedAt: records.prepared.preparedAt, observedAt: (input.clock?.() ?? input.now).toISOString(),
    status: run.status === 'completed' ? run.conclusion === 'success' ? 'completed' : 'failed' : 'running',
    planDigest: records.prepared.planDigest
  } };
}

export async function executeRepositoryChecks(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  let lastOperation: ExternalOperationState | undefined;
  try {
    const operation = input.plan.operations.find((entry) => entry.actionId === repositoryChecksAction);
    if (!operation) throw new GitHubActivationError('check-plan', 'There is no exact reviewed repository source-check operation.');
    await assertGitHubPhaseAuthority(input, operation);
    const config = await checkInputs(input);
    const payload = operation.inputs as unknown as RepositoryChecksPlanPayload;
    if (payload.repository !== config.repository || payload.repositoryId !== config.repositoryId ||
      payload.actorId !== config.actorId || payload.sourceSha !== config.source ||
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
      if (workflow.path !== path || workflow.state !== 'active') throw new GitHubActivationError('check-source', 'The source workflow is no longer the exact active provider workflow.');
      currentChecks.push(...await deriveRequiredSourceChecks(client, config.repository, source, positiveId(workflow.id)));
    }
    if (canonicalSha256(currentChecks) !== canonicalSha256(payload.requiredChecks)) {
      throw new GitHubActivationError('check-source', 'The exact required workflow, context or test manifest changed after review.');
    }
    const bound: BoundRepositoryCheckFixture[] = [];
    for (const fixture of payload.fixtures) {
      const selection = payload.fixtureBindings.find((entry) => entry.featureBranch === fixture.featureBranch);
      if (!selection) throw new GitHubActivationError('check-plan', 'A reviewed fixture is missing its positive/negative protected-ref binding.');
      const checks = payload.requiredChecks.filter((check) => check.refFamilies.includes(selection.refFamily));
      const bindings = [...new Set(checks.map((check) => check.workflowId))].map((id) => sourceCheckFixtureWorkflowBinding(fixture, checks, id));
      for (const binding of bindings) await fixtureRun(input, operation, client, binding, fixture);
      const materialized = await materializeGitFlowPullRequest({ execution: input, operation, publication: fixture, client });
      lastOperation = materialized.operation;
      const pullRequestNumber = positiveId(materialized.pullRequest.number);
      await assertPublicationPreconditions(client, fixture);
      const runs = [];
      for (const binding of bindings) {
        const run = await fixtureRun(input, operation, client, binding, fixture, pullRequestNumber);
        if (!run) return { status: 'pending', operation: lastOperation, completedOperations: [],
          blocker: 'The exact unmerged fixture PR is recorded; its source-bound workflow event has not appeared yet. Recovery reads this PR and never recreates or redispatches it.' };
        lastOperation = run.operation;
        if (run.operation.status === 'running') return {
          status: 'pending', operation: run.operation, completedOperations: [],
          blocker: 'The exact recorded fixture workflow is still running. Bounded recovery observes that same provider run and attempt.'
        };
        runs.push(run);
      }
      bound.push({ publication: fixture, polarity: selection.polarity, refFamily: selection.refFamily, pullRequestNumber, runs });
    }
    const qualification = await qualifyRepositorySourceChecks({
      client, repository: payload.repository, requiredChecks: payload.requiredChecks, fixtures: bound, now: input.now,
      artifactReadback: { execution: input, operation }
    });
    if (qualification.repositoryId !== payload.repositoryId || qualification.actorId !== payload.actorId ||
      qualification.sourceSha !== payload.sourceSha) {
      throw new GitHubActivationError('check-result-binding', 'Observed check qualification differs from the approved repository, actor or workflow producer source.');
    }
    const checks = [...qualification.positiveChecks, ...qualification.controlledNegativeChecks];
    const resources = checks.map((check) => ({
      provider: 'github' as const, resourceType: 'check-run',
      resourceId: `/repos/${payload.repository}/check-runs/${check.checkRunId}`
    }));
    const artifacts = qualification.controlledNegativeChecks.flatMap((check) => check.fixtureArtifact ? [{
      check, observation: check.fixtureArtifact,
      resource: { provider: 'github' as const, resourceType: 'workflow-artifact',
        resourceId: `/repos/${payload.repository}/actions/artifacts/${check.fixtureArtifact.request.artifact.artifactId}` }
    }] : []);
    const evidencePayload: RepositoryChecksEvidencePayload = {
      kind: 'repository-checks-qualified.v1', ...qualification, boundFixtures: bound
    };
    return {
      status: 'completed', resultState: 'verified', completedOperations: [operation],
      evidencePayload,
      liveReadback: [
        ...checks.map((check, index) => readbackProof(input, 'github', 'check-run', resources[index]!.resourceId, {
          repository: payload.repository, sourceSha: payload.sourceSha, requiredChecks: qualification.requiredChecks, check
        })),
        ...artifacts.map(({ check, observation, resource }) => readbackProof(input, 'github', 'workflow-artifact', resource.resourceId, {
          repository: payload.repository, repositoryId: check.repositoryId, actorId: check.actorId,
          producerSourceSha: check.producerSourceSha, sourceSha: check.headSha, workflowId: check.workflowId,
          runId: check.runId, runAttempt: check.runAttempt, jobId: check.jobId, checkRunId: check.checkRunId,
          conclusion: check.conclusion, artifact: observation.request.artifact, checkpointDigest: observation.checkpointDigest,
          recordKey: observation.recordKey, sourceFileDigest: observation.sourceFileDigest
        }))
      ],
      outputs: { values: { sourceSha: payload.sourceSha, requiredChecksDigest: canonicalSha256(qualification.requiredChecks),
        requiredContextsDigest: canonicalSha256(qualification.requiredContexts),
        positiveChecksPassed: true, controlledNegativeChecksPassed: true },
        resources: [...resources, ...artifacts.map((artifact) => artifact.resource)] }
    };
  } catch (error) {
    if (error instanceof SourceCheckArtifactPendingError) {
      return { status: 'blocked', blocker: error.message, completedOperations: [], operation: error.operation };
    }
    return { status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: [],
      ...(lastOperation ? { operation: lastOperation } : {}) };
  }
}
