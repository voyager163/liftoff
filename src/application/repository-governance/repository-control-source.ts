import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { latestRecordWithPayload } from '../../domain/governance/activation/evidence.js';
import type { PhaseEvidenceRecord, PhaseId } from '../../domain/governance/activation/types.js';
import { normalizeRulesetDefinition } from '../../domain/governance/assessment/live-normalize.js';
import { GitHubActivationError, githubRef, object, positiveId, text, type GitHubActivationClient } from '../../adapters/github/activation-rest.js';
import { readbackControlledNodeFixture, readbackWorkflowContent, type PublishedWorkflowSourceFile } from '../../adapters/github/production-workflows.js';
import { readBoundWorkflowRun, repositoryCheckContextsFromQualification } from '../../adapters/github/production-checks.js';
import {
  controlledNodeTestFixture, decodeWorkflow, isProtectedRefFamily, protectedRefFamilies, sourceCheckFixtureArtifact
} from '../../adapters/github/workflow-check-recipes.js';
import type { DesiredRulesetDefinition, RepositoryControlPlan } from '../../adapters/github/production-rulesets.js';
import type { RepositoryControlBinding } from '../../adapters/github/repository-control-observation.js';
import type { PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { assertFullControlQualification } from './full-control-qualification.js';
import type { WorkflowSourceEvidencePayload } from './producer-workflow-source.js';
import { requireQualificationEvidence } from '../azure-activation/qualification-evidence.js';
import { AzureActivationAdmissionError } from '../azure-activation/authority.js';
import {
  planApprovedRepositoryChecks, revalidateApprovedRepositoryChecks, planApprovedFullChecks, revalidateApprovedFullChecks,
  type RepositoryCheckRevalidation
} from './repository-check-revalidation.js';
import type { RepositoryControlArtifactReadback } from './repository-control-artifact-readback.js';

export type RepositoryControlQualificationRead =
  | { kind: 'plan' }
  | { kind: 'readback'; authority: RepositoryControlArtifactReadback };

export interface ControlCheckRequirement {
  context: string;
  appId: number;
  refFamily: 'develop' | 'main' | 'release/*' | 'hotfix/*' | 'release/**' | 'hotfix/**';
  workflowPath: string;
  workflowId: number;
  workflowDigest: string;
  workflowBlobSha: string;
  jobName: string;
  jobKey: string;
  validationStep: string;
  producerSourceSha: string;
}

function freshRecord(input: PhasePlanningInput, phase: PhaseId, scope: 'repository' | 'activation'): PhaseEvidenceRecord {
  const record = latestRecordWithPayload(input.inspection, phase);
  if (!record || record.header.result !== 'verified' || record.header.scope !== scope ||
    !isRecord(record.payload) || record.payload.kind !== `${phase}.v1`) {
    throw new GitHubActivationError('control-qualification', `Current independently verified ${scope}-scope ${phase} evidence is required; another scope's receipt or flags cannot supply it.`);
  }
  return structuredClone(record);
}

function publicHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new GitHubActivationError('control-source', 'An exact immutable public source/proof digest is required.');
  }
  return value;
}

function gitObjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new GitHubActivationError('control-source', 'Source receipts require actual immutable Git commit/blob IDs.');
  }
  return value;
}

type PublishedControlSource = Pick<WorkflowSourceEvidencePayload,
  'repository' | 'repositoryId' | 'actorId' | 'actorLogin' | 'ref' | 'sourceSha' | 'files' | 'workflows'>;

function publishedControlSource(payload: Record<string, unknown>, binding: RepositoryControlBinding): PublishedControlSource {
  if (payload.repository !== binding.repository || payload.repositoryId !== binding.repositoryId ||
    !Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > 64 ||
    !Array.isArray(payload.workflows) || payload.workflows.length === 0 || payload.workflows.length > 64) {
    throw new GitHubActivationError('control-source', 'Current source proof requires its exact repository/provider identity and published file/workflow inventory.');
  }
  const files: PublishedWorkflowSourceFile[] = payload.files.map((file) => {
    const entry = object(file);
    const path = text(entry.path, 'Published source path');
    const digest = publicHash(entry.digest);
    if (entry.readbackDigest !== digest) throw new GitHubActivationError('control-source', 'A source file has no matching independent immutable readback.');
    return { path, digest, readbackDigest: digest, blobSha: gitObjectId(entry.blobSha) };
  });
  if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) {
    throw new GitHubActivationError('control-source', 'Published source contains duplicate or ambiguous file identities.');
  }
  const sourceSha = gitObjectId(payload.sourceSha);
  const workflows: PublishedControlSource['workflows'] = payload.workflows.map((value) => {
    const workflow = object(value, 'Published workflow identity');
    const path = text(workflow.path, 'Published workflow path');
    const file = files.find((entry) => entry.path === path);
    if (!/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/u.test(path) ||
      !file || workflow.digest !== file.digest || workflow.blobSha !== file.blobSha || workflow.sourceSha !== sourceSha) {
      throw new GitHubActivationError('control-source', 'The published workflow identity does not bind the exact source commit, content digest and observed blob.');
    }
    return { path, workflowId: positiveId(workflow.workflowId), digest: file.digest, blobSha: file.blobSha, sourceSha };
  });
  if (new Set(workflows.map((entry) => entry.path)).size !== workflows.length ||
    new Set(workflows.map((entry) => entry.workflowId)).size !== workflows.length ||
    files.filter((file) => file.path.startsWith('.github/workflows/')).length !== workflows.length) {
    throw new GitHubActivationError('control-source', 'Every published workflow needs one exact unique observed provider identity.');
  }
  return {
    repository: binding.repository, repositoryId: binding.repositoryId,
    actorId: positiveId(payload.actorId, 'Source-publication actor ID'),
    actorLogin: text(payload.actorLogin, 'Source-publication actor login'), ref: githubRef(payload.ref),
    sourceSha, files, workflows
  };
}

interface CheckQualificationIdentity {
  repository: string;
  repositoryId: number;
  actorId: number;
  actionId: 'github.checks.repository-qualified' | 'github.checks.green-red-proof';
}

async function checkRun(
  client: GitHubActivationClient, value: unknown, expected: ControlCheckRequirement,
  binding: CheckQualificationIdentity, negative: boolean
): Promise<void> {
  const entry = object(value, 'Qualified exact check run');
  if (entry.context !== expected.context || entry.appId !== expected.appId || entry.refFamily !== expected.refFamily ||
    entry.workflowPath !== expected.workflowPath || entry.workflowId !== expected.workflowId ||
    entry.workflowDigest !== expected.workflowDigest || entry.jobKey !== expected.jobKey ||
    entry.producerSourceSha !== expected.producerSourceSha ||
    entry.repositoryId !== binding.repositoryId || entry.actorId !== binding.actorId ||
    entry.conclusion !== (negative ? 'failure' : 'success') ||
    typeof entry.headSha !== 'string' || !/^[a-f0-9]{40}$/u.test(entry.headSha) ||
    typeof entry.fixtureRef !== 'string' ||
    !/^(?:liftoff|feature|feat|automation)\/[A-Za-z0-9_./-]+$/u.test(entry.fixtureRef) ||
    negative && entry.deliberateFailure !== true) {
    throw new GitHubActivationError('control-check-binding', 'A required check has stale actor/source/ref/context identity or lacks a genuine applicable positive/controlled-negative result.');
  }
  for (const key of ['runId', 'runAttempt', 'jobId', 'checkRunId']) positiveId(entry[key], key);
  const conclusion = negative ? 'failure' : 'success';
  const step = object(entry.validationStep, 'Recorded validation step');
  if (step.conclusion !== conclusion || step.name !== expected.validationStep) {
    throw new GitHubActivationError('control-negative-proof', 'A real registered unmerged fixture and exact failed validation step are required; a copied conclusion is not proof.');
  }
  const pullRequestNumber = positiveId(entry.pullRequestNumber, 'Fixture PR number');
  const stepNumber = positiveId(step.number, 'Validation step number');
  const pullRequest = await client.get(`/repos/${binding.repository}/pulls/${pullRequestNumber}`);
  const head = object(pullRequest.head), base = object(pullRequest.base);
  const familyMatches = expected.refFamily === 'develop' || expected.refFamily === 'main' ? base.ref === expected.refFamily :
    typeof base.ref === 'string' && base.ref.startsWith(expected.refFamily.split('/')[0] + '/') &&
      (expected.refFamily.endsWith('/**') || !base.ref.slice(base.ref.indexOf('/') + 1).includes('/'));
  if (pullRequest.number !== pullRequestNumber || pullRequest.state !== 'open' || pullRequest.merged !== false ||
    object(pullRequest.user).id !== binding.actorId || head.ref !== entry.fixtureRef || head.sha !== entry.headSha ||
    object(head.repo).id !== binding.repositoryId || object(head.repo).full_name !== binding.repository ||
    object(base.repo).id !== binding.repositoryId || !familyMatches || typeof base.sha !== 'string') {
    throw new GitHubActivationError('control-fixture-drift', 'The exact actor/source/target-bound check fixture is no longer an unmerged applicable PR.');
  }
  const fixture = await readbackControlledNodeFixture(client, binding.repository, entry.headSha);
  if (fixture.digest !== controlledNodeTestFixture(negative ? 'negative' : 'positive').digest) {
    throw new GitHubActivationError('control-fixture-drift', 'The independently read fixture bytes are not the registered positive/controlled-negative validator input.');
  }
  const operationId = String(positiveId(entry.runId));
  const resourceId = `/repos/${binding.repository}/actions/runs/${operationId}`;
  const verifiedAt = text(entry.verifiedAt, 'Check verification time');
  const observed = await readBoundWorkflowRun(client, {
    repository: binding.repository, repositoryId: binding.repositoryId, workflowId: expected.workflowId,
    workflowPath: expected.workflowPath, workflowDigest: expected.workflowDigest,
    producerSourceSha: expected.producerSourceSha, sourceSha: entry.headSha, ref: entry.fixtureRef,
    actorId: binding.actorId, event: 'pull_request', expectedJobs: [expected.jobName], runAttempt: positiveId(entry.runAttempt)
  }, {
    provider: 'github', actionId: binding.actionId, operationId, resourceId,
    startedAt: verifiedAt, observedAt: verifiedAt, status: negative ? 'failed' : 'completed'
  });
  const job = observed.jobs[0];
  const validation = job?.steps.filter((item) => item.name === expected.validationStep);
  if (observed.conclusion !== conclusion || !job || job.id !== entry.jobId || job.checkRunId !== entry.checkRunId ||
    job.appId !== expected.appId || job.conclusion !== conclusion ||
    validation?.length !== 1 || validation[0]?.number !== stepNumber || validation[0].conclusion !== conclusion ||
    job.steps.some((item) => item.number < stepNumber && item.conclusion !== 'success' ||
      item.name !== expected.validationStep && item.conclusion === 'failure') ||
    !Array.isArray(observed.providerRun.pull_requests) || !observed.providerRun.pull_requests.some((value) => {
      const pr = object(value);
      return pr.number === pullRequestNumber && object(pr.head).sha === entry.headSha && object(pr.base).sha === base.sha;
    })) {
    throw new GitHubActivationError('control-check-readback', 'Actual provider run/job/check/validation-step results no longer match the exact recorded positive or controlled-negative proof.');
  }
}

async function checkProofs(
  input: PhasePlanningInput, client: GitHubActivationClient, record: PhaseEvidenceRecord, binding: RepositoryControlBinding, sourceSha: string,
  qualificationRead?: RepositoryControlQualificationRead
): Promise<RepositoryCheckRevalidation> {
  const payload = object(record.payload, 'Required check qualification payload');
  const proof = isRecord(payload.qualification) ? payload.qualification : payload;
  if (proof.repository !== binding.repository || proof.repositoryId !== binding.repositoryId || proof.sourceSha !== sourceSha ||
    !Array.isArray(proof.requiredChecks) || proof.requiredChecks.length === 0 || proof.requiredChecks.length > 32 ||
    !Array.isArray(proof.positiveChecks) || !Array.isArray(proof.controlledNegativeChecks)) {
    throw new GitHubActivationError('control-check-proof', 'The exact context/ref/workflow and provider-issued positive/negative run inventory is required before control planning.');
  }
  const actorId = positiveId(proof.actorId, 'Check-qualification actor ID');
  if (record.header.scope === 'repository' && proof.boundFixtures !== undefined) {
    if (qualificationRead?.kind === 'plan') return planApprovedRepositoryChecks(input, client, record, binding, sourceSha);
    return revalidateApprovedRepositoryChecks(input, client, record, binding, sourceSha,
      qualificationRead?.kind === 'readback' ? qualificationRead.authority : undefined);
  }
  if (record.header.scope === 'activation' && proof.boundFixtures !== undefined) {
    if (qualificationRead?.kind === 'plan') return planApprovedFullChecks(input, client, record, binding, sourceSha);
    return revalidateApprovedFullChecks(input, client, record, binding, sourceSha,
      qualificationRead?.kind === 'readback' ? qualificationRead.authority : undefined);
  }
  if (record.header.scope === 'activation') {
    throw new GitHubActivationError('full-control-qualification',
      'Full qualification requires the genuine source/artifact/environment-bound workflow operation, original approved fixture inventory and native assertion readback; legacy flat check metadata cannot release the hold.');
  }
  // Older node-only receipts had no recipe discriminator. Current descriptors
  // cannot discard their original fixture inventory to use that reader.
  if (proof.requiredChecks.some((value) => {
    const check = object(value);
    return record.header.scope === 'repository'
      ? check.recipe !== undefined || check.workingDirectory !== undefined || check.validationManifest !== undefined || check.fixtureArtifact !== undefined
      : check.recipe !== undefined && check.recipe !== 'node-test.v1' ||
        check.workingDirectory !== undefined && check.workingDirectory !== '.' || check.validationManifest !== undefined;
  })) {
    throw new GitHubActivationError('control-check-fixtures',
      'This registered recipe requires its original reviewed boundFixtures and provider-operation inventory; no recipe or working directory is inferred from a check name.');
  }
  if (record.header.scope === 'repository' &&
    proof.controlledNegativeChecks.some((value) => isRecord(value) && value.fixtureArtifact !== undefined)) {
    throw new GitHubActivationError('control-check-fixtures',
      'Retained failed artifacts require their original boundFixtures and current exact read authority; legacy proof cannot discard that inventory.');
  }
  if (record.header.scope === 'repository' && proof.requiredContexts !== undefined) {
    repositoryCheckContextsFromQualification(proof);
  }
  const qualification: CheckQualificationIdentity = {
    repository: binding.repository, repositoryId: binding.repositoryId, actorId,
    actionId: record.header.scope === 'repository' ? 'github.checks.repository-qualified' : 'github.checks.green-red-proof'
  };
  const requirements: ControlCheckRequirement[] = [];
  for (const raw of proof.requiredChecks) {
    const required = object(raw, 'Required workflow check');
    if (!Array.isArray(required.refFamilies) || required.refFamilies.length === 0 || required.refFamilies.length > protectedRefFamilies.length ||
      required.refFamilies.some((family) => !isProtectedRefFamily(family))) {
      throw new GitHubActivationError('control-check-context', 'Required workflow checks must bind their exact protected ref-family inventory.');
    }
    const workflowPath = text(required.workflowPath, 'Required workflow path');
    const producerSourceSha = text(required.producerSourceSha, 'Workflow producer source SHA');
    if (producerSourceSha !== sourceSha) throw new GitHubActivationError('control-check-source', 'A required check names a different immutable workflow producer commit.');
    const source = await readbackWorkflowContent(client, binding.repository, workflowPath, producerSourceSha);
    if (source.digest !== publicHash(required.workflowDigest) || source.blobSha !== required.workflowBlobSha) {
      throw new GitHubActivationError('control-check-source', 'The exact workflow producer bytes or blob identity changed.');
    }
    const document = decodeWorkflow(source.content);
    const jobKey = text(required.jobId, 'Required job key');
    const job = object(object(document.jobs)[jobKey], 'Actual required workflow job');
    const context = text(required.context, 'Required check context');
    const validationStep = text(required.validationStep, 'Required validation step');
    const trigger = object(object(document.on).pull_request, 'Actual workflow trigger');
    const declaredArtifact = sourceCheckFixtureArtifact(jobKey, 'node-test.v1', '.');
    if (Array.isArray(job.steps) && job.steps.some((value) => isRecord(value) &&
      typeof value.uses === 'string' && value.uses.startsWith('actions/upload-artifact@') &&
      isRecord(value.with) && value.with.name === declaredArtifact.name)) {
      throw new GitHubActivationError('control-check-fixtures',
        'The immutable source declares a registered fixture artifact. Its original boundFixtures/private artifact custody and current read approval cannot be removed by relabeling the receipt as legacy.');
    }
    if ((job.name ?? jobKey) !== context || !Array.isArray(job.steps) ||
      job.steps.filter((value) => { const step = object(value); return step.name === validationStep && step.run === 'node --test'; }).length !== 1 ||
      canonicalSha256(trigger.branches ?? ['develop', 'main', 'release/**', 'hotfix/**']) !== canonicalSha256(required.refFamilies)) {
      throw new GitHubActivationError('control-check-source', 'Required context/job/validation step/ref families are not derived from the exact immutable workflow source.');
    }
    for (const refFamily of required.refFamilies) {
      const positive = proof.positiveChecks.filter((value) => isRecord(value) && value.context === context && value.refFamily === refFamily);
      if (positive.length !== 1) throw new GitHubActivationError('control-check-context', 'The required context has no unique actual positive application identity.');
      const appId = positiveId(object(positive[0]).appId, 'Required check application ID');
      if (appId !== binding.actionsApp.id) throw new GitHubActivationError('control-check-context', 'The required context does not come from the observed actual GitHub Actions application.');
      requirements.push({
        context, appId, refFamily: refFamily as ControlCheckRequirement['refFamily'],
        workflowPath, workflowId: positiveId(required.workflowId), workflowDigest: source.digest, workflowBlobSha: source.blobSha, jobName: context,
        jobKey, validationStep, producerSourceSha
      });
    }
  }
  if (new Set(requirements.map((entry) => canonicalSha256(entry))).size !== requirements.length) {
    throw new GitHubActivationError('control-check-proof', 'The qualified required-context inventory contains duplicate bindings.');
  }
  for (const item of requirements) {
    const matching = (values: unknown[]) => values.filter((value) => isRecord(value) &&
      value.context === item.context && value.appId === item.appId && value.refFamily === item.refFamily);
    const positive = matching(proof.positiveChecks);
    const negative = matching(proof.controlledNegativeChecks);
    if (positive.length !== 1 || negative.length !== 1) {
      throw new GitHubActivationError('control-check-proof', 'Each exact context/application/ref family requires one current positive and one controlled-negative qualification.');
    }
    await checkRun(client, positive[0], item, qualification, false);
    await checkRun(client, negative[0], item, qualification, true);
    if (object(positive[0]).headSha === object(negative[0]).headSha ||
      object(positive[0]).runId === object(negative[0]).runId) {
      throw new GitHubActivationError('control-negative-proof', 'Positive and controlled-negative proof cannot reuse the same fixture commit or provider run.');
    }
  }
  return { requirements, actorId };
}

export async function repositoryControlSource(
  input: PhasePlanningInput, client: GitHubActivationClient, binding: RepositoryControlBinding,
  mode: RepositoryControlPlan['mainHold']['mode'], expectedSource?: RepositoryControlPlan['source'],
  qualificationRead?: RepositoryControlQualificationRead
): Promise<{
  source: RepositoryControlPlan['source']; desiredRulesets: readonly DesiredRulesetDefinition[];
  failedWorkflowArtifacts?: RepositoryCheckRevalidation['failedWorkflowArtifacts'];
  originalFixturePlans?: RepositoryCheckRevalidation['originalFixturePlans'];
  artifactReadbacks?: RepositoryCheckRevalidation['artifactReadbacks'];
}> {
  const scope = input.phase.id.startsWith('repository-') ? 'repository' : 'activation';
  const sourcePhase = scope === 'repository' ? 'repository-workflow-source-ready' : 'workflow-source-ready';
  const sourceRecord = freshRecord(input, sourcePhase, scope);
  const payload = object(sourceRecord.payload);
  const published = publishedControlSource(payload, binding);
  const { sourceSha, files } = published;
  const rulesetFiles = files.filter((file) => /^\.github\/rulesets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/u.test(file.path));
  if (rulesetFiles.length === 0 || canonicalSha256(rulesetFiles.map(({ path, digest }) => ({ path, digest }))) !== payload.rulesetSourceDigest) {
    throw new GitHubActivationError('control-source', 'The published file-inventory digest differs from its reviewed ruleset sources; a semantic digest cannot silently replace it.');
  }
  const checksPhase = scope === 'repository' ? 'repository-checks-qualified' : 'green-red-proof';
  const fullRecord = (phaseId: 'green-red-proof' | 'staging-qualified' | 'production-rehearsed') => {
    if (!expectedSource) return freshRecord(input, phaseId, 'activation');
    const references = expectedSource.qualificationReferences?.filter((entry) => entry.phaseId === phaseId);
    if (references?.length !== 1) {
      throw new GitHubActivationError('full-proof-reference', 'Full control readback requires the exact original qualification references frozen in its reviewed plan; old proof is not rehashed into new authority.');
    }
    try {
      return structuredClone(requireQualificationEvidence(input.inspection, phaseId, references[0]!.reference, input.now).record);
    } catch (error) {
      if (error instanceof AzureActivationAdmissionError) throw new GitHubActivationError('full-proof-reference', error.message);
      throw error;
    }
  };
  const checks = scope === 'repository' ? freshRecord(input, checksPhase, scope) : fullRecord('green-red-proof');
  const qualifications = [checks];
  if (scope === 'activation') {
    qualifications.push(fullRecord('staging-qualified'), fullRecord('production-rehearsed'));
  }
  const checkPayload = object(checks.payload);
  const checkResult = isRecord(checkPayload.qualification) ? checkPayload.qualification : checkPayload;
  const qualificationActorId = positiveId(checkResult.actorId, 'Check-qualification actor ID');
  const qualificationReferences = scope === 'activation' ? qualifications.map((record) => {
    const phaseId = record.header.phaseId;
    if (phaseId !== 'green-red-proof' && phaseId !== 'staging-qualified' && phaseId !== 'production-rehearsed') {
      throw new GitHubActivationError('full-proof-reference', 'A differently scoped phase cannot supply full qualification.');
    }
    return { phaseId, reference: {
      evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), bodyDigest: record.header.bodyDigest
    } };
  }) : undefined;
  const source: RepositoryControlPlan['source'] = {
    sourceSha, fileInventoryDigest: publicHash(payload.rulesetSourceDigest),
    evidenceDigest: canonicalSha256(sourceRecord), qualificationDigest: canonicalSha256(qualifications),
    publication: {
      repository: published.repository, repositoryId: published.repositoryId,
      actorId: published.actorId, actorLogin: published.actorLogin, ref: published.ref
    },
    qualificationActorId, files, ...(qualificationReferences ? { qualificationReferences } : {})
  };
  if (expectedSource && canonicalSha256(source) !== canonicalSha256(expectedSource)) {
    throw new GitHubActivationError('control-proof-drift', 'Original source or qualification commitments changed after review; no replacement provider proof is read or adopted.');
  }
  const { requirements, failedWorkflowArtifacts, originalFixturePlans, artifactReadbacks } =
    await checkProofs(input, client, checks, binding, sourceSha, qualificationRead);
  if (scope === 'activation') {
    const artifacts = qualifications.map((record) => object(record.payload).artifactDigest);
    if (artifacts.some((digest) => typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)) ||
      new Set(artifacts).size !== 1 || qualifications.some((record) => object(record.payload).sourceSha !== sourceSha)) {
      throw new GitHubActivationError('full-control-qualification', 'Full enforcement requires its own identical immutable artifact/source staging, rehearsal and green/red qualification. Repository receipts cannot replace it.');
    }
    for (const qualification of qualifications.slice(1)) {
      const reference = qualificationReferences!.find((entry) => entry.phaseId === qualification.header.phaseId)!.reference;
      await assertFullControlQualification(input, client, binding, qualification, sourceSha, String(artifacts[0]), reference,
        qualificationRead?.kind === 'readback' ? qualificationRead.authority : undefined, qualificationRead?.kind === 'plan');
    }
  }
  for (const required of requirements) {
    if (!published.workflows.some((workflow) => workflow.path === required.workflowPath &&
      workflow.workflowId === required.workflowId && workflow.digest === required.workflowDigest &&
      workflow.blobSha === required.workflowBlobSha && workflow.sourceSha === required.producerSourceSha)) {
      throw new GitHubActivationError('control-check-source', 'A qualified required workflow/job belongs to different approved source bytes.');
    }
  }
  const desiredRulesets: DesiredRulesetDefinition[] = [];
  for (const file of rulesetFiles) {
    const source = await readbackWorkflowContent(client, binding.repository, file.path, sourceSha);
    if (source.digest !== file.digest || source.blobSha !== file.blobSha) {
      throw new GitHubActivationError('control-source', 'Actual immutable ruleset source differs from the reviewed file bytes or observed blob identity.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(source.content); }
    catch { throw new GitHubActivationError('control-source', 'Reviewed ruleset source is not valid JSON.'); }
    normalizeRulesetDefinition(parsed);
    const definition = structuredClone(object(parsed)) as unknown as DesiredRulesetDefinition;
    if (!Array.isArray(definition.rules) || !Array.isArray(definition.conditions?.ref_name?.include)) {
      throw new GitHubActivationError('control-source', 'Reviewed ruleset source lacks exact rules and protected ref patterns.');
    }
    if (definition.name === 'liftoff-gitflow-main') {
      definition.rules = [
        ...definition.rules.filter((rule) => rule.type !== 'update'),
        ...(mode === 'hold' ? [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }] : [])
      ];
    }
    for (const rule of definition.rules.filter((entry) => entry.type === 'required_status_checks')) {
      const parameters = object(rule.parameters);
      if (!Array.isArray(parameters.required_status_checks)) throw new GitHubActivationError('control-source', 'A proposed required-check rule has no exact context inventory.');
      for (const required of parameters.required_status_checks) {
        const check = object(required);
        const families = definition.conditions.ref_name.include.map((ref) => ref.replace(/^refs\/heads\//u, ''));
        const matching = requirements.filter((entry) => entry.context === check.context &&
          (check.integration_id === null || check.integration_id === undefined || entry.appId === check.integration_id));
        const apps = new Set(matching.map((entry) => entry.appId));
        if (apps.size !== 1 || families.length === 0 ||
          families.some((family) => !matching.some((entry) => entry.refFamily === family))) {
          throw new GitHubActivationError('control-check-coverage', 'Every proposed required context/application must be genuinely qualified for each applicable protected ref family.');
        }
        check.integration_id = matching[0]!.appId;
      }
    }
    desiredRulesets.push(definition);
  }
  return {
    desiredRulesets, source,
    ...(failedWorkflowArtifacts?.length ? { failedWorkflowArtifacts } : {}),
    ...(originalFixturePlans?.length ? { originalFixturePlans } : {}),
    ...(artifactReadbacks?.length ? { artifactReadbacks } : {})
  };
}
