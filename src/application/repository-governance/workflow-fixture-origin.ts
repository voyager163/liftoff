import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import { GitHubActivationError, githubRepository, object, positiveId, text } from '../../adapters/github/activation-rest.js';
import { validateWorkflowPublicationPlan, type WorkflowPublicationPlan } from '../../adapters/github/production-workflows.js';
import {
  sourceCheckFixtureWorkflowBinding, type RecordedWorkflowRunIdentity, type WorkflowRunBinding
} from '../../adapters/github/workflow-run-readback.js';
import {
  controlledSourceCheckFixtures, isProtectedRefFamily, matchesProtectedRefFamily, protectedRefFamilies,
  type ProtectedRefFamily, type RequiredWorkflowCheck
} from '../../adapters/github/workflow-check-recipes.js';
import { assertGitHubPhaseAuthority } from './workflow-authority.js';
import { readWorkflowEffect } from './workflow-checkpoints.js';
import { workflowOriginAuthority, workflowOriginTimestamp, type OriginalPublicationStage } from './workflow-origin-authority.js';

export interface OriginalCheckFixturePlanReference {
  phaseId: 'repository-checks-qualified' | 'green-red-proof';
  planDigest: string;
  savedPlanDigest: string;
  operationDigest: string;
}

export interface OriginalCheckFixtureCustody {
  reference: OriginalCheckFixturePlanReference;
  repository: string;
  repositoryId: number;
  actorId: number;
  producerSourceSha: string;
  requiredChecks: readonly RequiredWorkflowCheck[];
  fixtures: readonly {
    publication: WorkflowPublicationPlan;
    polarity: 'positive' | 'negative';
    refFamily: ProtectedRefFamily;
    pullRequestNumber: number;
    publicationStages: readonly OriginalPublicationStage[];
    runs: readonly {
      binding: WorkflowRunBinding;
      identity: RecordedWorkflowRunIdentity;
      savedPlanDigest: string;
      approvalEnvelopeHash: string;
      checkpointDigest: string;
    }[];
  }[];
}

function fail(message: string): never {
  throw new GitHubActivationError('fixture-origin-admission', message);
}

function records(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum || value.some((entry) => !isRecord(entry))) {
    fail('The exact original bounded fixture/source inventory is missing.');
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('Original fixture custody requires exact plan, operation and source digests.');
  return value;
}

function requiredChecks(value: unknown, producer: string): RequiredWorkflowCheck[] {
  const checks = records(value, 32);
  const contexts = new Set<string>();
  for (const check of checks) {
    positiveId(check.workflowId);
    const context = text(check.context, 'Original source check context');
    const path = text(check.workflowPath, 'Original workflow path');
    if (contexts.has(context) || !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(String(check.jobId)) ||
      !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(path) ||
      check.producerSourceSha !== producer ||
      !['node-test.v1', 'vitest.v1', 'pytest.v1', 'go-test.v1'].includes(String(check.recipe)) ||
      !['.', 'backend', 'frontend'].includes(String(check.workingDirectory)) ||
      !Array.isArray(check.refFamilies) || !check.refFamilies.length || check.refFamilies.length > protectedRefFamilies.length ||
      check.refFamilies.some((family) => !isProtectedRefFamily(family)) ||
      new Set(check.refFamilies).size !== check.refFamilies.length) {
      fail('The original workflow/job/recipe/ref-family descriptors are missing or inconsistent; no recipe or recursive scope is inferred.');
    }
    hash(check.workflowDigest); sourceSha(check.workflowBlobSha); text(check.validationStep, 'Original validation step');
    if (check.recipe === 'vitest.v1' || check.validationManifest !== undefined) {
      const manifest = object(check.validationManifest);
      if (manifest.path !== (check.workingDirectory === '.' ? 'package.json' : `${check.workingDirectory}/package.json`)) {
        fail('The original validation manifest is not the exact registered source directory.');
      }
      hash(manifest.digest); sourceSha(manifest.blobSha);
    }
    contexts.add(context);
  }
  return checks as unknown as RequiredWorkflowCheck[];
}

/**
 * Returns original provider custody as data, never a RepositoryChecksEvidencePayload or current run result.
 * A different phase must approve reference in inputs.originalFixturePlans under an actual primary github-read action.
 */
export async function readOriginalCheckFixtureCustody(input: {
  execution: PhaseAdapterExecutionInput;
  operation: TransitionOperation;
  reference: OriginalCheckFixturePlanReference;
}): Promise<OriginalCheckFixtureCustody> {
  const reference = structuredClone(input.reference), reader = structuredClone(input.operation);
  const fields = object(reference);
  if (Object.keys(fields).sort().join(',') !== ['phaseId', 'planDigest', 'savedPlanDigest', 'operationDigest'].sort().join(',') ||
    reference.phaseId !== 'repository-checks-qualified' && reference.phaseId !== 'green-red-proof') {
    fail('Original fixture admission requires its exact original phase/plan reference, not a repository qualification receipt or caller handles.');
  }
  hash(reference.planDigest); hash(reference.savedPlanDigest); hash(reference.operationDigest);
  await assertGitHubPhaseAuthority(input.execution, reader);
  const authority = workflowOriginAuthority(input.execution, reference.phaseId);
  const plan = authority.planFor(reference.planDigest, reference.savedPlanDigest);
  const operations = plan.operations.filter((operation) => canonicalSha256(operation) === reference.operationDigest);
  const operation = operations[0];
  const expectedAction = reference.phaseId === 'repository-checks-qualified' ? 'github.checks.repository-qualified' : 'github.checks.green-red-proof';
  if (operations.length !== 1 || !operation || operation.phaseId !== reference.phaseId || operation.actionId !== expectedAction ||
    operation.adapter !== 'github' || operation.mutationClass !== 'github-workflow-dispatch') {
    fail('The exact original fixture-producing operation is missing; a readback approval cannot stand in for its original creation authority.');
  }
  const repository = githubRepository(operation.inputs.repository);
  const repositoryId = positiveId(operation.inputs.repositoryId), actorId = positiveId(operation.inputs.actorId);
  const producerSourceSha = sourceSha(operation.inputs.sourceSha);
  if (String(repositoryId) !== input.execution.inspection.state.remoteBinding?.id ||
    operation.destination.repository !== repository || reader.adapter !== 'github' || reader.destination.repository !== repository ||
    ![reader, ...(reader.effects ?? [])].some((effect) => effect.remote && effect.mutationClass === 'github-read' &&
      effect.destination.repository === repository)) fail('The current reader and original producer must bind the same actual repository and explicit GitHub-read scope.');
  const ownProducer = reader.phaseId === reference.phaseId && canonicalSha256(reader) === canonicalSha256(operation);
  if (!ownProducer && (reader.mutationClass !== 'github-read' || !Array.isArray(reader.inputs.originalFixturePlans) ||
    !reader.inputs.originalFixturePlans.length || reader.inputs.originalFixturePlans.length > 8 ||
    reader.inputs.originalFixturePlans.filter((entry) => canonicalSha256(entry) === canonicalSha256(reference)).length !== 1)) {
    fail('A different consuming phase needs a registered primary GitHub-read action approving this exact originalFixturePlans reference; do not relabel readback as dispatch.');
  }
  const checks = requiredChecks(operation.inputs.requiredChecks, producerSourceSha);
  const configurations = object(plan.configuration?.phases[reference.phaseId], 'Original fixture configuration');
  const configured = records(configurations.fixtures, protectedRefFamilies.length);
  const publications = records(operation.inputs.fixtures, protectedRefFamilies.length * 2);
  const selections = records(operation.inputs.fixtureBindings, protectedRefFamilies.length * 2);
  const families = new Set(checks.flatMap((check) => check.refFamilies));
  if (configurations.repositoryId !== repositoryId || configurations.actorId !== actorId || configurations.sourceSha !== producerSourceSha ||
    canonicalSha256(configurations.workflowPaths ?? null) !== canonicalSha256([...new Set(checks.map((check) => check.workflowPath))]) ||
    publications.length !== selections.length || publications.length !== configured.length * 2 || configured.length !== families.size ||
    new Set(configured.map((entry) => entry.refFamily)).size !== configured.length ||
    configured.some((entry) => !isProtectedRefFamily(entry.refFamily) || !families.has(entry.refFamily)) ||
    new Set(publications.map((entry) => entry.featureBranch)).size !== publications.length ||
    new Set(selections.map((entry) => entry.featureBranch)).size !== selections.length) {
    fail('The original plan must retain its complete unique source workflow and positive/negative ref-family inventory.');
  }
  const fixtures: OriginalCheckFixtureCustody['fixtures'][number][] = [];
  const seen = new Set<string>();
  for (const value of publications) {
    const publication = value as unknown as WorkflowPublicationPlan;
    validateWorkflowPublicationPlan(publication);
    const matching = selections.filter((entry) => entry.featureBranch === publication.featureBranch);
    const selection = matching[0];
    if (matching.length !== 1 || !selection || !isProtectedRefFamily(selection.refFamily) ||
      selection.polarity !== 'positive' && selection.polarity !== 'negative' ||
      !matchesProtectedRefFamily(publication.targetBranch, selection.refFamily) ||
      publication.repository !== repository || publication.repositoryId !== repositoryId || publication.actorId !== actorId ||
      !['gitflow-source-check-fixture.v1', 'gitflow-node-test-fixture.v1'].includes(publication.recipe)) {
      fail('The exact original fixture repository, actor, polarity or literal protected ref family differs.');
    }
    const refFamily = selection.refFamily, polarity = selection.polarity;
    const key = `${refFamily}:${polarity}`;
    if (seen.has(key)) fail('Repeated fixtures cannot substitute for the original positive/negative pair.');
    seen.add(key);
    const configuration = configured.find((entry) => entry.refFamily === refFamily);
    const applicable = checks.filter((check) => check.refFamilies.includes(refFamily));
    if (!configuration || !applicable.length || configuration.targetBranch !== publication.targetBranch || configuration.baseSha !== publication.baseSha ||
      configuration.commitTime !== publication.commitTime ||
      configuration[polarity === 'positive' ? 'positiveBranch' : 'negativeBranch'] !== publication.featureBranch ||
      canonicalSha256(publication.files.map(({ path, content, digest }) => ({ path, content, digest }))) !==
        canonicalSha256(controlledSourceCheckFixtures(applicable, polarity))) {
      fail('The retained fixture source bytes, target/base/ref or commit metadata differs from its original approved recipe.');
    }
    const originalPublication = await authority.readPublication(plan, operation, publication);
    const prStage = originalPublication.stages.find((stage) => stage.step === 'pull-request')!;
    const runs: OriginalCheckFixtureCustody['fixtures'][number]['runs'][number][] = [];
    for (const workflowId of new Set(applicable.map((check) => check.workflowId))) {
      const binding = sourceCheckFixtureWorkflowBinding(publication, applicable, workflowId);
      const checkpoints = await readWorkflowEffect(input.execution, operation, {
        repositoryId, ref: `${binding.ref}:${binding.workflowId}`, purpose: 'check-fixture', step: 'dispatch'
      }, { binding, fixtureDigest: canonicalSha256(publication) });
      const observed = checkpoints?.observed;
      if (!checkpoints || !observed || !observed.providerId || !/^[1-9]\d*$/u.test(observed.providerId)) {
        fail('The original fixture has no observed private provider run identity. An unobserved request, nonce or latest run is not adopted.');
      }
      const runId = positiveId(Number(observed.providerId));
      if (observed.resourceId !== `/repos/${repository}/actions/runs/${runId}` ||
        workflowOriginTimestamp(checkpoints.prepared.preparedAt) > workflowOriginTimestamp(prStage.preparedAt) ||
        workflowOriginTimestamp(observed.recordedAt) > (input.execution.clock?.() ?? input.execution.now).getTime()) {
        fail('The original run must retain its real same-repository provider ID and private checkpoint preceding the PR trigger.');
      }
      const original = authority.planFor(checkpoints.prepared.planDigest, undefined, checkpoints.prepared.approvalEnvelopeHash);
      if (!original.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
        fail('The retained run belongs to a different original/recovery operation.');
      }
      await authority.admitAt(original, checkpoints.prepared.preparedAt);
      runs.push({
        binding, identity: { provider: 'github', actionId: operation.actionId, operationId: observed.providerId,
          resourceId: observed.resourceId, startedAt: checkpoints.prepared.preparedAt, observedAt: observed.recordedAt,
          planDigest: original.planDigest },
        savedPlanDigest: canonicalSha256(original), approvalEnvelopeHash: checkpoints.prepared.approvalEnvelopeHash,
        checkpointDigest: canonicalSha256(checkpoints.prepared)
      });
    }
    fixtures.push({
      publication, polarity, refFamily,
      pullRequestNumber: originalPublication.pullRequestNumber, publicationStages: originalPublication.stages, runs
    });
  }
  for (const family of families) {
    if (!seen.has(`${family}:positive`) || !seen.has(`${family}:negative`)) fail('Every original source ref family needs its exact complete fixture pair.');
  }
  if (!fixtures.some((fixture) => fixture.publicationStages.some((stage) =>
    stage.planDigest === reference.planDigest && stage.savedPlanDigest === reference.savedPlanDigest) ||
    fixture.runs.some((run) => run.identity.planDigest === reference.planDigest && run.savedPlanDigest === reference.savedPlanDigest))) {
    fail('The referenced plan did not prepare any retained fixture effect. Use its actual original creation/recovery plan, not an unexecuted replacement approval.');
  }
  await assertGitHubPhaseAuthority(input.execution, reader);
  return structuredClone({ reference, repository, repositoryId, actorId, producerSourceSha, requiredChecks: checks, fixtures });
}
