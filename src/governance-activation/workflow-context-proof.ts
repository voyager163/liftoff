import { parse } from 'yaml';
import {
  canonicalSha256, isRecord
} from '../domain/governance/activation/canonical-json.js';
import {
  githubRef, githubRepository, GitHubActivationClient, GitHubActivationError, positiveId
} from '../adapters/github/activation-rest.js';
import { sourceSha } from './github-config.js';
import { workflowTerminalConclusions, readWorkflowDispatchHandle } from './workflow-binding.js';
export { readWorkflowDispatchHandle } from './workflow-binding.js';
import type { PhaseId } from '../domain/governance/activation/types.js';
import {
  observeImmutableWorkflowExecutionRef, type ImmutableWorkflowExecutionRef
} from './workflow-execution-ref.js';
import {
  protectedWorkflowFamilies, requiredWorkflowContextsFromSource,
  type ProtectedWorkflowFamily, type WorkflowRequirementSource
} from './workflow-requirements.js';
import {
  assertWorkflowAuthority, captureWorkflowBinding, readWorkflowBytes, workflowDigest, workflowFailure,
  workflowOperation, workflowRuntime, recordWorkflowCheckpoint, workflowReviewedPlans, type WorkflowEffectInput
} from './workflow-runtime.js';
import {
  isSource5WorkflowEffectInput, assertSource5WorkflowCurrentProof, assertSource5WorkflowMatrixEntries,
  captureSource5WorkflowMatrixEntries
} from './workflow-source5-ports.js';
import type { Source5WorkflowEffectInput } from './workflow-source5-ports.js';

export { protectedWorkflowFamilies };
export type { ProtectedWorkflowFamily };

export interface RequiredWorkflowContext {
  jobId: string;
  name: string;
  validationStep: string;
}

export interface WorkflowContextBinding {
  repository: string;
  repositoryId: number;
  family: ProtectedWorkflowFamily;
  ref: string;
  sourceSha: string;
  treeSha: string;
  executionRef: string;
  workflowPath: string;
  workflowDigest: string;
  contexts: readonly RequiredWorkflowContext[];
  mode: 'green' | 'controlled-red';
  violation?: {
    path: string;
    parentSha: string;
    beforeDigest: string;
    afterDigest: string;
    context: string;
  };
  tokenSuppressedTrigger: true;
}

export interface WorkflowProofCheckpoint {
  bindingDigest: string;
  planDigest: string;
  dispatchedAt: string;
  workflowId: number;
  stage: 'dispatch-intent' | 'accepted' | 'terminal';
  runId?: number;
  runUrl?: string;
  htmlUrl?: string;
  terminalConclusion?: typeof workflowTerminalConclusions[number] | 'unknown';
  terminalConclusionDigest?: string;
}

export type WorkflowContextExecutionInput = WorkflowEffectInput & {
  workflowCheckpoint?: WorkflowProofCheckpoint;
  workflowObservationOnly?: boolean;
  recordWorkflowDispatch?: (checkpoint: WorkflowProofCheckpoint) => Promise<void>;
};

export interface ObservedWorkflowContext {
  name: string;
  jobId: number;
  checkRunId: number;
  applicationId: number;
  conclusion: 'success' | 'failure';
  validationStep: string;
}

export interface WorkflowContextProof {
  kind: 'workflow-context-proof.v1';
  binding: WorkflowContextBinding;
  bindingDigest: string;
  planDigest: string;
  runId: number;
  workflowId: number;
  attempt: 1;
  conclusion: 'success' | 'failure';
  contexts: readonly ObservedWorkflowContext[];
  observedAt: string;
  dispatchedAt: string;
  observationDigest: string;
  executionAdmission: ImmutableWorkflowExecutionRef;
}

export type WorkflowContextResult =
  | { status: 'pending'; checkpoint: WorkflowProofCheckpoint }
  | { status: 'completed'; checkpoint: WorkflowProofCheckpoint; proof: WorkflowContextProof };

function actualFamily(ref: string): ProtectedWorkflowFamily | null {
  if (ref === 'develop' || ref === 'main') return ref;
  if (/^release\/[^/]+(?:\/[^/]+)*$/u.test(ref)) return 'release';
  if (/^hotfix\/[^/]+(?:\/[^/]+)*$/u.test(ref)) return 'hotfix';
  return null;
}

export function validateWorkflowContextBinding(binding: WorkflowContextBinding): WorkflowContextBinding {
  binding = captureWorkflowBinding(binding);
  githubRepository(binding.repository); githubRef(binding.ref); sourceSha(binding.sourceSha);
  sourceSha(binding.treeSha, 'Reviewed source tree SHA');
  workflowDigest(binding.workflowDigest);
  if (!Number.isSafeInteger(binding.repositoryId) || binding.repositoryId <= 0 ||
    actualFamily(binding.ref) !== binding.family || binding.tokenSuppressedTrigger !== true ||
    binding.executionRef !== `liftoff-execution-${binding.sourceSha}` ||
    !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/u.test(binding.workflowPath) ||
    !binding.contexts.length || binding.contexts.length > 32 ||
    new Set(binding.contexts.map((context) => context.name)).size !== binding.contexts.length ||
    new Set(binding.contexts.map((context) => context.jobId)).size !== binding.contexts.length ||
    binding.contexts.some((context) => !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(context.jobId) ||
      !context.name || context.name.length > 100 || /[\u0000-\u001f\u007f]/u.test(context.name) ||
      !context.validationStep || context.validationStep.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(context.validationStep)) ||
    !['green', 'controlled-red'].includes(binding.mode)) {
    return workflowFailure('workflow-proof-binding', 'Required-context proof must bind one actual protected ref family, full source SHA, immutable workflow and a unique nonempty exact job/context inventory.');
  }
  const violation = binding.violation;
  if (binding.mode === 'controlled-red') {
    if (!violation || !/^(?:backend|frontend|infrastructure|tests|scripts)\/[A-Za-z0-9_./-]+$/u.test(violation.path) ||
      violation.path.split('/').some((part) => part === '.' || part === '..' || part === '.git') ||
      /(?:^|\/)(?:\.env|.*\.tfstate|.*\.pem|.*\.key)(?:$|\.)/u.test(violation.path) ||
      !binding.contexts.some((context) => context.name === violation.context) ||
      workflowDigest(violation.beforeDigest) === workflowDigest(violation.afterDigest) ||
      sourceSha(violation.parentSha) === binding.sourceSha) {
      return workflowFailure('workflow-red-binding', 'Controlled red requires an exact nonsensitive source violation, unchanged validation recipe, distinct parent/after bytes and the actual context expected to detect it.');
    }
  } else if (violation !== undefined) {
    return workflowFailure('workflow-red-binding', 'A green request cannot contain a controlled-red override.');
  }
  return binding;
}

export function validateContextWorkflow(bytes: Buffer, binding: WorkflowContextBinding): void {
  let value: unknown;
  try { value = parse(bytes.toString('utf8'), { uniqueKeys: true, maxAliasCount: 0 }); }
  catch { return workflowFailure('workflow-proof-recipe', 'The immutable proof workflow is not unambiguous bounded YAML.'); }
  const dispatch = isRecord(value) && isRecord(value.on) && isRecord(value.on.workflow_dispatch)
    ? value.on.workflow_dispatch : null;
  if (!isRecord(value) || value['run-name'] !== 'Liftoff context proof ${{ inputs.proof_id }}' ||
    !dispatch || !isRecord(dispatch.inputs) ||
    canonicalSha256(Object.keys(dispatch.inputs).sort()) !== canonicalSha256(['proof_id', 'protected_ref', 'source_sha']) ||
    Object.values(dispatch.inputs).some((entry) => !isRecord(entry) || entry.required !== true || entry.type !== 'string') ||
    !isRecord(value.concurrency) || value.concurrency.group !== 'liftoff-context-proof-${{ inputs.proof_id }}' ||
    value.concurrency['cancel-in-progress'] !== false || !isRecord(value.jobs) ||
    canonicalSha256(Object.keys(value.jobs).sort()) !== canonicalSha256(binding.contexts.map(context => context.jobId).sort()) ||
    !isRecord(value.permissions) || value.permissions.contents !== 'read' ||
    Object.values(value.permissions).some((permission) => permission !== 'read' && permission !== 'none')) {
    return workflowFailure('workflow-proof-recipe', 'Proof dispatch requires exact non-secret inputs, binding-keyed non-cancelling concurrency and read-only permissions. It cannot publish statuses, checks, tags or releases.');
  }
  for (const context of binding.contexts) {
    const job = value.jobs[context.jobId];
    const checkout = isRecord(job) && Array.isArray(job.steps) ? job.steps[0] : null;
    const validation = isRecord(job) && Array.isArray(job.steps) ? job.steps.at(-1) : null;
    if (!isRecord(job) || job.name !== context.name ||
      job.if !== '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}' ||
      job['continue-on-error'] !== undefined ||
      !Number.isInteger(job['timeout-minutes']) || Number(job['timeout-minutes']) < 1 || Number(job['timeout-minutes']) > 20 ||
      job.strategy !== undefined || job.uses !== undefined || job.permissions !== undefined || job.needs !== undefined ||
      !Array.isArray(job.steps) || job.steps.length < 2 || job.steps.length > 32 ||
      !isRecord(checkout) || checkout.name !== 'Checkout reviewed source' ||
      typeof checkout.uses !== 'string' || !/^actions\/checkout@[a-f0-9]{40}$/u.test(checkout.uses) ||
      !isRecord(checkout.with) ||
      canonicalSha256(Object.keys(checkout.with).sort()) !== canonicalSha256(['clean', 'persist-credentials', 'ref']) ||
      checkout.with.ref !== '${{ inputs.source_sha }}' || checkout.with.clean !== true ||
      checkout.with['persist-credentials'] !== false ||
      !isRecord(validation) || validation.name !== context.validationStep ||
      (validation.run === undefined) === (validation.uses === undefined) ||
      validation.run !== undefined && (typeof validation.run !== 'string' || !validation.run.trim()) ||
      job.steps.filter((step) => isRecord(step) && step.name === context.validationStep).length !== 1 ||
      job.steps.some((step) => !isRecord(step) || step['continue-on-error'] !== undefined ||
        step.if !== undefined || step.uses !== undefined &&
        (typeof step.uses !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u.test(step.uses)))) {
      return workflowFailure('workflow-proof-recipe', 'Every required context must be one independent bounded job with a pre-effect exact-SHA/attempt guard, pinned actions and one unconditional executable validator as its final ordinary step; duplicate validators, dependent jobs, skipped and fail-open recipes cannot qualify.');
    }
  }
}

async function observeSource(
  runtime: ReturnType<typeof workflowRuntime>, binding: WorkflowContextBinding, requireCurrentRef: boolean
) {
  const repository = await runtime.client.get(`/repos/${binding.repository}`);
  if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository) {
    return workflowFailure('workflow-proof-repository', 'The independently observed repository ID/name differs from the reviewed dispatch destination.');
  }
  if (requireCurrentRef) {
    const ref = await runtime.client.get(`/repos/${binding.repository}/git/ref/heads/${binding.ref}`);
    const expectedSha = binding.mode === 'green' ? binding.sourceSha : binding.violation?.parentSha;
    if (ref.ref !== `refs/heads/${binding.ref}` || !isRecord(ref.object) || ref.object.sha !== expectedSha) {
      return workflowFailure('workflow-proof-ref', 'The exact reviewed ref moved; token-suppressed automation must dispatch only its approved complete commit.');
    }
  }
  const bytes = await readWorkflowBytes(runtime.client, binding.repository, binding.sourceSha,
    binding.workflowPath, binding.workflowDigest);
  validateContextWorkflow(bytes, binding);
  const executionAdmission = await observeImmutableWorkflowExecutionRef(runtime, binding);
  if (binding.violation) {
    await readWorkflowBytes(runtime.client, binding.repository, binding.violation.parentSha,
      binding.workflowPath, binding.workflowDigest);
    await readWorkflowBytes(runtime.client, binding.repository, binding.violation.parentSha,
      binding.violation.path, binding.violation.beforeDigest);
    await readWorkflowBytes(runtime.client, binding.repository, binding.sourceSha,
      binding.violation.path, binding.violation.afterDigest);
    const difference = await runtime.client.get(`/repos/${binding.repository}/compare/${binding.violation.parentSha}...${binding.sourceSha}`);
    if (difference.status !== 'ahead' || difference.total_commits !== 1 || difference.ahead_by !== 1 ||
      !Array.isArray(difference.commits) || difference.commits.length !== 1 ||
      !isRecord(difference.commits[0]) || difference.commits[0].sha !== binding.sourceSha ||
      !Array.isArray(difference.commits[0].parents) || difference.commits[0].parents.length !== 1 ||
      !isRecord(difference.commits[0].parents[0]) || difference.commits[0].parents[0].sha !== binding.violation.parentSha ||
      !Array.isArray(difference.files) || difference.files.length !== 1 || !isRecord(difference.files[0]) ||
      difference.files[0].filename !== binding.violation.path || difference.files[0].status !== 'modified') {
      return workflowFailure('workflow-red-source', 'Controlled red must be the exact single-parent, single-file reviewed violation, with no workflow change or unrelated failure substitution.');
    }
  }
  return executionAdmission;
}

function validateRun(run: Record<string, unknown>, binding: WorkflowContextBinding, checkpoint: WorkflowProofCheckpoint) {
  const created = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
  if (run.head_sha !== binding.sourceSha || run.head_branch !== binding.executionRef ||
    run.path !== binding.workflowPath || run.event !== 'workflow_dispatch' || run.run_attempt !== 1 ||
    run.display_title !== `Liftoff context proof ${checkpoint.bindingDigest}` || run.workflow_id !== checkpoint.workflowId ||
    !isRecord(run.repository) || run.repository.id !== binding.repositoryId ||
    run.repository.full_name !== binding.repository || !Number.isFinite(created) ||
    created < Date.parse(checkpoint.dispatchedAt) || created > Date.parse(checkpoint.dispatchedAt) + 180_000 ||
    checkpoint.runId !== undefined && run.id !== checkpoint.runId) {
    return workflowFailure('workflow-proof-run', 'Actual workflow run identity, source, attempt or dispatch time differs; stale, foreign, rerun and ambiguous work cannot qualify.');
  }
  return { runId: positiveId(run.id), workflowId: positiveId(run.workflow_id) };
}

async function observeRun(
  runtime: ReturnType<typeof workflowRuntime>, binding: WorkflowContextBinding, checkpoint: WorkflowProofCheckpoint,
  observedAt: string, recordDispatch?: WorkflowContextExecutionInput['recordWorkflowDispatch']
): Promise<WorkflowContextResult> {
  if (!checkpoint.runId) return { status: 'pending', checkpoint };
  const run = await runtime.client.get(`/repos/${binding.repository}/actions/runs/${checkpoint.runId}`);
  const identity = validateRun(run, binding, checkpoint);
  if (checkpoint.stage === 'terminal' && run.status !== 'completed') {
    return workflowFailure('workflow-proof-run', 'A previously terminal actual workflow cannot be reclassified as pending.');
  }
  if (run.status !== 'completed') {
    if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(String(run.status))) {
      return workflowFailure('workflow-proof-run', 'The provider returned an unsupported workflow state.');
    }
    return { status: 'pending', checkpoint };
  }
  const terminalConclusion = workflowTerminalConclusions.find(conclusion => conclusion === run.conclusion) ?? 'unknown';
  const terminalConclusionDigest = canonicalSha256({ conclusion: run.conclusion ?? null });
  if (checkpoint.stage === 'terminal' &&
    (checkpoint.terminalConclusion !== terminalConclusion || checkpoint.terminalConclusionDigest !== terminalConclusionDigest)) {
    return workflowFailure('workflow-proof-run', 'The actual terminal provider outcome differs from its original durable record.');
  }
  if (recordDispatch && checkpoint.stage !== 'terminal') {
    checkpoint = { ...checkpoint, stage: 'terminal', terminalConclusion, terminalConclusionDigest };
    await recordWorkflowCheckpoint(recordDispatch, checkpoint);
  }
  const expected: 'success' | 'failure' = binding.mode === 'green' ? 'success' : 'failure';
  if (run.conclusion !== expected) {
    return workflowFailure('workflow-proof-conclusion', 'The actual workflow did not reach the required successful green or deliberate failing red outcome; skipped, neutral and cancelled are not proof.');
  }
  const jobs = await runtime.client.list(`/repos/${binding.repository}/actions/runs/${identity.runId}/attempts/1/jobs`, 'jobs');
  const checks = await runtime.client.list(`/repos/${binding.repository}/commits/${binding.sourceSha}/check-runs?filter=all`, 'check_runs');
  const app = await runtime.client.get('/apps/github-actions');
  if (app.slug !== 'github-actions') return workflowFailure('workflow-proof-check', 'The real GitHub Actions application identity could not be established.');
  const appId = positiveId(app.id);
  const contexts: ObservedWorkflowContext[] = [];
  for (const context of binding.contexts) {
    const actual = jobs.filter((job) => job.name === context.name);
    if (actual.length !== 1) return workflowFailure('workflow-proof-job', 'A required context is absent or has ambiguous actual workflow jobs.');
    const job = actual[0]!;
    const checkPrefix = `https://api.github.com/repos/${binding.repository}/check-runs/`;
    if (typeof job.check_run_url !== 'string' || !job.check_run_url.startsWith(checkPrefix) ||
      !/^[1-9][0-9]*$/u.test(job.check_run_url.slice(checkPrefix.length))) {
      return workflowFailure('workflow-proof-check', 'The actual job does not expose its repository-scoped GitHub check-run URL.');
    }
    const checkId = positiveId(Number(job.check_run_url.slice(checkPrefix.length)));
    const check = checks.filter((entry) => entry.id === checkId);
    const conclusion = binding.mode === 'controlled-red' && binding.violation?.context === context.name ? 'failure' : 'success';
    if (job.status !== 'completed' || job.conclusion !== conclusion ||
      job.run_id !== identity.runId || job.run_attempt !== 1 ||
      !Array.isArray(job.steps) || !job.steps.length || job.steps.length > 40 ||
      check.length !== 1 || check[0]!.head_sha !== binding.sourceSha || check[0]!.name !== context.name ||
      check[0]!.status !== 'completed' || check[0]!.conclusion !== conclusion ||
      !isRecord(check[0]!.app) || check[0]!.app.id !== appId || check[0]!.app.slug !== 'github-actions' ||
      !isRecord(check[0]!.check_suite) || check[0]!.check_suite.id !== run.check_suite_id) {
      return workflowFailure('workflow-proof-check', 'Required contexts must be actual completed jobs and their own GitHub Actions checks on the exact commit/run/suite; caller-created statuses are not proof.');
    }
    const steps = job.steps.filter(isRecord);
    const validators = steps.filter((step) => step.name === context.validationStep);
    if (steps.length !== job.steps.length || validators.length !== 1 ||
      steps[0]?.name !== 'Checkout reviewed source' || steps[0].conclusion !== 'success' ||
      validators[0] === steps[0] ||
      validators[0]!.conclusion !== conclusion || validators[0]!.status !== 'completed' ||
      steps.some((step) => step.status !== 'completed' ||
        step !== validators[0] && step.conclusion !== 'success')) {
      return workflowFailure('workflow-proof-cause', 'The real required validator must detect the exact controlled violation; infrastructure failures, skipped dependencies and fabricated failure annotations cannot substitute.');
    }
    contexts.push({ name: context.name, jobId: positiveId(job.id), checkRunId: checkId, applicationId: appId,
      conclusion, validationStep: context.validationStep });
  }
  if (jobs.some((job) => !binding.contexts.some((context) => context.name === job.name) && job.conclusion !== 'success')) {
    return workflowFailure('workflow-proof-cause', 'An unrelated failing job cannot be used as the controlled-red cause.');
  }
  const executionAdmission = await observeSource(runtime, binding, true);
  const observed = { ...identity, attempt: 1 as const, conclusion: expected, contexts, executionAdmission };
  return { status: 'completed', checkpoint, proof: {
    kind: 'workflow-context-proof.v1', binding, bindingDigest: canonicalSha256(binding),
    planDigest: checkpoint.planDigest, ...observed,
    observedAt, dispatchedAt: checkpoint.dispatchedAt, observationDigest: canonicalSha256(observed)
  } };
}

export async function executeWorkflowContextProof(
  input: WorkflowContextExecutionInput, request: WorkflowContextBinding
): Promise<WorkflowContextResult> {
  const binding = validateWorkflowContextBinding(request);
  const bindingDigest = canonicalSha256(binding);
  const actions: Partial<Record<PhaseId, string>> = {
    'dev-proof': 'github.checks.dev-proof',
    'staging-qualified': 'github.checks.staging',
    'production-rehearsed': 'github.checks.production-rehearsal',
    'green-red-proof': 'github.checks.green-red-proof'
  };
  const action = actions[input.phase.id];
  if (!action) return workflowFailure('workflow-proof-phase', 'Required-context dispatch is not authorized in this phase.');
  const operation = workflowOperation(input, action, binding);
  const runtime = workflowRuntime(input);
  let checkpoint = input.workflowCheckpoint && captureWorkflowBinding(input.workflowCheckpoint);
  const recordDispatch = input.recordWorkflowDispatch;
  if (!recordDispatch) {
    return workflowFailure('workflow-proof-unavailable', 'Workflow dispatch requires engine-owned durable intent and accepted-run checkpoints; standalone success-shaped callbacks do not enable a public capability.');
  }
  if (checkpoint) {
    if (Object.keys(checkpoint).some(key => ![
      'bindingDigest', 'planDigest', 'dispatchedAt', 'workflowId', 'stage', 'runId', 'runUrl', 'htmlUrl',
      'terminalConclusion', 'terminalConclusionDigest'
    ].includes(key))) {
      return workflowFailure('workflow-proof-checkpoint', 'Workflow checkpoint contains unsupported control fields.');
    }
    if (checkpoint.runUrl !== undefined || checkpoint.htmlUrl !== undefined) {
      readWorkflowDispatchHandle({ status: 200, headers: {}, data: {
        workflow_run_id: checkpoint.runId, run_url: checkpoint.runUrl, html_url: checkpoint.htmlUrl
      } }, binding.repository);
    }
    positiveId(checkpoint.workflowId);
    if (checkpoint.bindingDigest !== bindingDigest || !/^[a-f0-9]{64}$/u.test(checkpoint.planDigest) ||
      !Number.isFinite(Date.parse(checkpoint.dispatchedAt)) ||
      Date.parse(checkpoint.dispatchedAt) > (input.clock?.() ?? input.now).getTime() ||
      (input.clock?.() ?? input.now).getTime() - Date.parse(checkpoint.dispatchedAt) > 86_400_000 ||
      (checkpoint.stage === 'accepted' || checkpoint.stage === 'terminal') && !checkpoint.runId ||
      checkpoint.stage === 'dispatch-intent' && checkpoint.runId !== undefined ||
      checkpoint.stage === 'terminal' && (
        ![...workflowTerminalConclusions, 'unknown']
          .includes(String(checkpoint.terminalConclusion)) ||
        typeof checkpoint.terminalConclusionDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(checkpoint.terminalConclusionDigest)
      ) ||
      checkpoint.stage !== 'terminal' && (
        checkpoint.terminalConclusion !== undefined || checkpoint.terminalConclusionDigest !== undefined
      ) ||
      !['dispatch-intent', 'accepted', 'terminal'].includes(checkpoint.stage)) {
      return workflowFailure('workflow-proof-checkpoint', 'Observation must retain the original exact dispatch binding, plan, timestamp and handle; imported or retagged checkpoints do not authorize a repeat.');
    }
    const original = workflowReviewedPlans(input)
      .find((plan) => plan.planDigest === checkpoint!.planDigest);
    if (!original || original.phaseId !== input.phase.id || original.scope !== input.plan.scope ||
      original.graphHash !== input.plan.graphHash ||
      canonicalSha256(original.identity) !== canonicalSha256(input.plan.identity) ||
      original.baselineDigest !== input.plan.baselineDigest || original.inputDigest !== input.plan.inputDigest ||
      canonicalSha256(original.configuration ?? null) !== canonicalSha256(input.plan.configuration ?? null) ||
      !original.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
      return workflowFailure('workflow-proof-checkpoint', 'The independently loaded original reviewed dispatch plan is absent or changed.');
    }
  } else {
    if (input.workflowObservationOnly) return workflowFailure('workflow-proof-checkpoint', 'A read-only retry cannot dispatch without a recorded original intent.');
    await observeSource(runtime, binding, true);
    await assertWorkflowAuthority(input, operation);
    const workflow = await runtime.client.get(`/repos/${binding.repository}/actions/workflows/${binding.workflowPath.split('/').at(-1)}`);
    if (workflow.path !== binding.workflowPath || workflow.state !== 'active') {
      return workflowFailure('workflow-proof-workflow', 'The exact published workflow is not active and independently visible.');
    }
    const workflowId = positiveId(workflow.id);
    const existing = await runtime.client.list(`/repos/${binding.repository}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&head_sha=${binding.sourceSha}`, 'workflow_runs');
    if (existing.some((run) => run.display_title === `Liftoff context proof ${bindingDigest}`)) {
      return workflowFailure('workflow-proof-unowned', 'A matching run already exists without this recorded original intent. Do not adopt it or repeat the dispatch; reconcile durable authority first.');
    }
    checkpoint = { bindingDigest, planDigest: input.plan.planDigest,
      dispatchedAt: (input.clock?.() ?? input.now).toISOString(), workflowId, stage: 'dispatch-intent' };
    await recordWorkflowCheckpoint(recordDispatch, checkpoint);
    await assertWorkflowAuthority(input, operation);
    await observeImmutableWorkflowExecutionRef(runtime, binding);
    // GITHUB_TOKEN-created pushes do not schedule follow-on runs. Never infer a push-triggered success.
    const response = await runtime.client.transport.request({
      method: 'POST', path: `/repos/${binding.repository}/actions/workflows/${workflow.id}/dispatches`,
      body: { ref: binding.executionRef, inputs: {
        source_sha: binding.sourceSha, protected_ref: `refs/heads/${binding.ref}`, proof_id: bindingDigest
      } }
    });
    const handle = readWorkflowDispatchHandle(response, binding.repository);
    if (handle) {
      checkpoint = { ...checkpoint, ...handle, stage: 'accepted' };
      await recordWorkflowCheckpoint(recordDispatch, checkpoint);
    }
  }
  if (!checkpoint.runId) {
    const runs = await runtime.client.list(`/repos/${binding.repository}/actions/workflows/${binding.workflowPath.split('/').at(-1)}/runs?event=workflow_dispatch&head_sha=${binding.sourceSha}`, 'workflow_runs');
    const owned = runs.filter((run) => run.display_title === `Liftoff context proof ${bindingDigest}`);
    if (owned.length > 1) return workflowFailure('workflow-proof-ambiguous', 'Multiple runs match the recorded dispatch; no run was adopted and no repeat dispatch is permitted.');
    if (!owned.length) return { status: 'pending', checkpoint };
    const actual = validateRun(owned[0]!, binding, checkpoint);
    checkpoint = { ...checkpoint, stage: 'accepted', runId: actual.runId };
    await recordWorkflowCheckpoint(recordDispatch, checkpoint);
  }
  runtime.assertWithinDeadline();
  return observeRun(runtime, binding, checkpoint, (input.clock?.() ?? input.now).toISOString(), recordDispatch);
}

export async function readCurrentWorkflowContextProof(
  input: WorkflowEffectInput, proof: WorkflowContextProof
): Promise<WorkflowContextProof> {
  return readCurrentProof(input, captureWorkflowBinding(proof), workflowRuntime(input));
}

async function readCurrentProof(
  input: WorkflowEffectInput, proof: WorkflowContextProof, runtime: ReturnType<typeof workflowRuntime>
): Promise<WorkflowContextProof> {
  const binding = validateWorkflowContextBinding(proof.binding);
  if (proof.kind !== 'workflow-context-proof.v1' || proof.bindingDigest !== canonicalSha256(binding)) {
    return workflowFailure('workflow-proof-current', 'Independent proof readback requires the exact complete source binding.');
  }
  if (isSource5WorkflowEffectInput(input)) await assertSource5WorkflowCurrentProof(input, proof);
  const plans = workflowReviewedPlans(input);
  if (!plans.some((plan) => plan.planDigest === proof.planDigest &&
    canonicalSha256(plan.identity) === canonicalSha256(input.plan.identity) &&
    plan.graphHash === input.plan.graphHash && plan.baselineDigest === input.plan.baselineDigest &&
    plan.operations.some((operation) => canonicalSha256(operation.inputs) === canonicalSha256(binding)))) {
    return workflowFailure('workflow-proof-current', 'Retained proof has no independently loaded original plan for this identity, baseline and exact dispatch binding.');
  }
  const dispatchedAt = proof.dispatchedAt;
  if (typeof dispatchedAt !== 'string' || !Number.isFinite(Date.parse(dispatchedAt))) {
    return workflowFailure('workflow-proof-current', 'Independent current proof must preserve its original durable dispatch time.');
  }
  const observed = await observeRun(runtime, binding, {
    bindingDigest: proof.bindingDigest, planDigest: proof.planDigest,
    dispatchedAt, workflowId: positiveId(proof.workflowId), stage: 'accepted', runId: proof.runId
  }, (input.clock?.() ?? input.now).toISOString());
  if (observed.status !== 'completed' || observed.proof.observationDigest !== proof.observationDigest ||
    observed.proof.workflowId !== proof.workflowId) {
    return workflowFailure('workflow-proof-current', 'Actual current jobs/checks/source no longer match the retained proof.');
  }
  if (isSource5WorkflowEffectInput(input)) await assertSource5WorkflowCurrentProof(input, proof);
  return observed.proof;
}

export async function verifyProtectedWorkflowProofMatrix(
  input: WorkflowEffectInput,
  requirements: WorkflowRequirementSource,
  proofs: readonly WorkflowContextProof[]
): Promise<{ kind: 'green-red-required-contexts.v2'; proofDigests: readonly string[]; observationDigest: string }> {
  if (isSource5WorkflowEffectInput(input)) {
    return workflowFailure('workflow-source5-proof-matrix', 'A complete source5 matrix requires its original per-entry observation carriers; the first indexed entry cannot stand in for other entries.');
  }
  requirements = captureWorkflowBinding(requirements);
  proofs = captureWorkflowBinding(proofs);
  if (!proofs.length || proofs.length > 132) {
    return workflowFailure('workflow-proof-matrix', 'The complete proof matrix exceeds its bounded four-family context inventory.');
  }
  const runtime = workflowRuntime(input);
  return verifyProofMatrix(requirements, proofs.map(proof => ({ input, proof, runtime })));
}

export async function verifySource5WorkflowProofMatrix(
  entries: readonly { readonly input: Source5WorkflowEffectInput; readonly proof: WorkflowContextProof }[],
  requirements: WorkflowRequirementSource
): Promise<{ kind: 'green-red-required-contexts.v2'; proofDigests: readonly string[]; observationDigest: string }> {
  entries = captureSource5WorkflowMatrixEntries(entries);
  requirements = captureWorkflowBinding(requirements);
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements) ||
    canonicalSha256(Object.keys(requirements).sort()) !==
    canonicalSha256(['profile', 'sourceDigest', 'files', 'families', 'integrations'].sort()) ||
    !['single-maintainer-gitflow', 'team-gitflow'].includes(requirements.profile) ||
    !Array.isArray(requirements.files) || !requirements.files.length || requirements.files.length > 16 ||
    requirements.files.some(file => !isRecord(file) ||
      canonicalSha256(Object.keys(file).sort()) !== canonicalSha256(['digest', 'path']) ||
      typeof file.path !== 'string' || !/^governance\/rulesets\/[A-Za-z0-9_-]+\.json$/u.test(file.path) ||
      typeof file.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(file.digest)) ||
    new Set(requirements.files.map(file => file.path)).size !== requirements.files.length ||
    !isRecord(requirements.families) || !isRecord(requirements.integrations) ||
    canonicalSha256(Object.keys(requirements.families).sort()) !== canonicalSha256([...protectedWorkflowFamilies].sort()) ||
    canonicalSha256(Object.keys(requirements.integrations).sort()) !== canonicalSha256([...protectedWorkflowFamilies].sort()) ||
    protectedWorkflowFamilies.some(family => {
      const contexts = requirements.families[family], integrations = requirements.integrations[family];
      return !Array.isArray(contexts) || !contexts.length || contexts.length > 32 ||
        new Set(contexts).size !== contexts.length ||
        contexts.some(name => typeof name !== 'string' || !name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) ||
        !isRecord(integrations) || canonicalSha256(Object.keys(integrations).sort()) !== canonicalSha256([...contexts].sort()) ||
        Object.values(integrations).some(id => id !== null && (!Number.isSafeInteger(id) || Number(id) < 1));
    }) ||
    requirements.sourceDigest !== canonicalSha256({ profile: requirements.profile, files: requirements.files,
      families: requirements.families, integrations: requirements.integrations })) {
    return workflowFailure('workflow-source5-proof-matrix', 'Matrix requirements must be the closed complete source-derived family/file/integration inventory, not a partial or retagged summary.');
  }
  const captured = entries.map(entry => ({ ...entry, runtime: workflowRuntime(entry.input) }));
  // One original three-minute budget covers ledger validation and all per-entry reads.
  const budget = captured[0]!.runtime;
  const bounded = captured.map(entry => ({ ...entry, runtime: { ...entry.runtime,
    client: new GitHubActivationClient({ async request(request) {
      budget.assertWithinDeadline();
      const response = await entry.runtime.client.transport.request(request);
      budget.assertWithinDeadline();
      return response;
    } })
  } }));
  await assertSource5WorkflowMatrixEntries(entries);
  budget.assertWithinDeadline();
  let expected = 0;
  for (const family of protectedWorkflowFamilies) {
    const required = requirements.families[family];
    const greens = captured.filter(entry => entry.proof.binding.family === family && entry.proof.binding.mode === 'green');
    if (greens.length !== 1 || canonicalSha256(greens[0]!.proof.binding.contexts.map(context => context.name).sort()) !==
      canonicalSha256([...required].sort())) {
      return workflowFailure('workflow-proof-matrix', 'Every applicable protected ref family needs one independently current green proof for all required contexts.');
    }
    expected += 1 + required.length;
    for (const name of required) {
      const reds = captured.filter(entry => entry.proof.binding.family === family &&
        entry.proof.binding.mode === 'controlled-red' && entry.proof.binding.violation?.context === name);
      if (reds.length !== 1) {
        return workflowFailure('workflow-proof-matrix', 'Each required context needs its own actual controlled violation and failing validator; one generic red run is insufficient.');
      }
    }
  }
  if (expected !== captured.length) {
    return workflowFailure('workflow-proof-matrix', 'The original matrix contains extra entries outside its complete source-derived family/context inventory.');
  }
  const result = await verifyProofMatrix(requirements, bounded);
  if (canonicalSha256(result.proofDigests) !== canonicalSha256(captured.map(({ proof }) => canonicalSha256({
    bindingDigest: proof.bindingDigest, observationDigest: proof.observationDigest, planDigest: proof.planDigest
  })))) {
    return workflowFailure('workflow-source5-proof-matrix', 'The original indexed plan order differs from the source-derived complete matrix projection; current observation cannot reorder original provenance.');
  }
  budget.assertWithinDeadline();
  await assertSource5WorkflowMatrixEntries(entries);
  budget.assertWithinDeadline();
  return result;
}

async function verifyProofMatrix(
  requirements: WorkflowRequirementSource,
  entries: readonly { readonly input: WorkflowEffectInput; readonly proof: WorkflowContextProof;
    readonly runtime: ReturnType<typeof workflowRuntime> }[]
): Promise<{ kind: 'green-red-required-contexts.v2'; proofDigests: readonly string[]; observationDigest: string }> {
  const proofs = entries.map(entry => entry.proof), budget = entries[0]!.runtime;
  const source5 = entries.every(entry => isSource5WorkflowEffectInput(entry.input));
  const entryFor = (proof: WorkflowContextProof) => {
    budget.assertWithinDeadline();
    const entry = entries.find(entry => entry.proof === proof);
    if (!entry) return workflowFailure('workflow-proof-matrix', 'The original current observation entry is missing.');
    return entry;
  };
  const assertIntegrations = (proof: WorkflowContextProof, family: ProtectedWorkflowFamily) => {
    if (proof.contexts.some(context => {
      const integration = requirements.integrations[family][context.name];
      return integration !== null && integration !== context.applicationId;
    })) {
      return workflowFailure('workflow-proof-matrix', 'Actual context application IDs do not satisfy the source-pinned required integration.');
    }
  };
  async function observeFamily(family: ProtectedWorkflowFamily): Promise<readonly WorkflowContextProof[]> {
    const observed: WorkflowContextProof[] = [];
    const required = requirements.families[family];
    if (!required.length || new Set(required).size !== required.length) {
      return workflowFailure('workflow-proof-matrix', 'Each protected ref family requires its nonempty exact source-derived context inventory.');
    }
    const green = proofs.filter((proof) => proof.binding.family === family && proof.binding.mode === 'green');
    if (green.length !== 1 || canonicalSha256(green[0]!.binding.contexts.map((context) => context.name).sort()) !==
      canonicalSha256([...required].sort())) {
      return workflowFailure('workflow-proof-matrix', 'Every applicable protected ref family needs one independently current green proof for all required contexts.');
    }
    const { input, runtime } = entryFor(green[0]!);
    observed.push(await readCurrentProof(input, green[0]!, runtime));
    assertIntegrations(observed.at(-1)!, family);
    const binding = green[0]!.binding;
    const commit = await runtime.client.get(`/repos/${binding.repository}/git/commits/${binding.sourceSha}`);
    if (commit.sha !== binding.sourceSha || !isRecord(commit.tree) || commit.tree.sha !== binding.treeSha) {
      return workflowFailure('workflow-proof-matrix', 'Actual green source tree could not establish the complete required-context inventory.');
    }
    const treeSha = sourceSha(commit.tree.sha);
    const tree = await runtime.client.get(`/repos/${binding.repository}/git/trees/${treeSha}?recursive=1`);
    if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree)) {
      return workflowFailure('workflow-proof-matrix', 'Incomplete/truncated source trees cannot prove that every required context was covered.');
    }
    const ruleFiles = tree.tree.filter((entry) => isRecord(entry) && typeof entry.path === 'string' &&
      /^governance\/rulesets\/[^/]+\.json$/u.test(entry.path));
    if (ruleFiles.some((entry) => !isRecord(entry) || entry.type !== 'blob' || entry.mode !== '100644') ||
      canonicalSha256(ruleFiles.map((entry) => String(entry.path)).sort()) !==
      canonicalSha256(requirements.files.map((file) => file.path).sort())) {
      return workflowFailure('workflow-proof-matrix', 'Required context source omitted or substituted actual committed ruleset files.');
    }
    const fileReads = requirements.files.map(async (file) => ({
      path: file.path, content: await readWorkflowBytes(runtime.client, binding.repository, binding.sourceSha, file.path, file.digest)
    }));
    const files = await Promise.all(fileReads).catch(async (error: unknown) => {
      await Promise.allSettled(fileReads);
      throw error;
    });
    const actualRequirements = requiredWorkflowContextsFromSource(files, requirements.profile);
    if (requirements.profile !== (isSource5WorkflowEffectInput(input) ? input.profile : input.inspection.manifest.governance?.profile) ||
      actualRequirements.sourceDigest !== requirements.sourceDigest ||
      canonicalSha256(actualRequirements.families) !== canonicalSha256(requirements.families) ||
      canonicalSha256(actualRequirements.integrations) !== canonicalSha256(requirements.integrations)) {
      return workflowFailure('workflow-proof-matrix', 'Proof requirements differ from the selected profile and the complete immutable source-derived ruleset context inventory.');
    }
    for (const name of required) {
      const red = proofs.filter((proof) => proof.binding.family === family &&
        proof.binding.mode === 'controlled-red' && proof.binding.violation?.context === name);
      if (red.length !== 1 || red[0]!.binding.repository !== green[0]!.binding.repository ||
        red[0]!.binding.repositoryId !== green[0]!.binding.repositoryId ||
        red[0]!.binding.ref !== green[0]!.binding.ref ||
        red[0]!.binding.violation?.parentSha !== green[0]!.binding.sourceSha ||
        red[0]!.binding.workflowPath !== green[0]!.binding.workflowPath ||
        red[0]!.binding.workflowDigest !== green[0]!.binding.workflowDigest ||
        canonicalSha256(red[0]!.binding.contexts) !== canonicalSha256(green[0]!.binding.contexts)) {
        return workflowFailure('workflow-proof-matrix', 'Each required context needs its own actual controlled violation and failing validator under the same immutable recipe; one generic red run is insufficient.');
      }
      const entry = entryFor(red[0]!);
      observed.push(await readCurrentProof(entry.input, red[0]!, entry.runtime));
      assertIntegrations(observed.at(-1)!, family);
    }
    budget.assertWithinDeadline();
    return observed;
  }
  const observed: WorkflowContextProof[] = [];
  if (source5) {
    // Independent read-only carriers share the held lease, not each other's authority.
    const families = await Promise.allSettled(protectedWorkflowFamilies.map(observeFamily));
    for (const family of families) {
      if (family.status === 'rejected') throw family.reason;
      observed.push(...family.value);
    }
  } else {
    for (const family of protectedWorkflowFamilies) observed.push(...await observeFamily(family));
  }
  if (observed.length !== proofs.length ||
    new Set(observed.map(proof => proof.bindingDigest)).size !== observed.length ||
    observed.some(proof => proof.binding.repository !== observed[0]!.binding.repository ||
      proof.binding.repositoryId !== observed[0]!.binding.repositoryId)) {
    return workflowFailure('workflow-proof-matrix', 'The complete proof matrix must contain only its exact unique owned green/red runs in one repository.');
  }
  const proofDigests = observed.map((proof) => canonicalSha256({
    bindingDigest: proof.bindingDigest, observationDigest: proof.observationDigest, planDigest: proof.planDigest
  }));
  return { kind: 'green-red-required-contexts.v2', proofDigests, observationDigest: canonicalSha256(proofDigests) };
}

export function workflowProviderFailure(error: unknown): error is GitHubActivationError {
  return error instanceof GitHubActivationError;
}
