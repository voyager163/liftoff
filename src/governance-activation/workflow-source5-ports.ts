import type { ModernPhaseGraph } from '../domain/governance/activation/modern-graph.js';
import type { ModernSavedTransitionPlan, ModernTransitionOperation } from '../domain/governance/activation/modern-record-contracts.js';
import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../adapters/github/activation-rest.js';
import type { CommandRunner } from '../process-runner.js';
import type { ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import type { Source5WorkflowAuthority, Source5WorkflowPhase } from './workflow-source5-authority.js';
import {
  assertSource5WorkflowAuthority, assertSource5WorkflowEntryOwnership, readSource5WorkflowEntryKey
} from './workflow-source5-authority.js';
import { claimSource5WorkflowEntryCarrier, withSource5WorkflowEntryGate } from './workflow-source5-context.js';
import { readSource5WorkflowDispatchCheckpoint } from './workflow-source5-checkpoints.js';
import type { WorkflowProofCheckpoint } from './workflow-context-proof.js';
import type { WorkflowPublicationCheckpoint } from './workflow-publication.js';
import { assertSource5WorkflowJournal } from './workflow-source5-journal.js';
import type { Source5WorkflowJournal, Source5WorkflowStage } from './workflow-source5-journal.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import {
  captureWorkflowBinding, readWorkflowDispatchHandle, workflowFailure, workflowGitCommand, workflowGitOptions
} from './workflow-binding.js';
import { devNull } from 'node:os';
import { modernActivationSourceContracts } from '../domain/governance/policy/identity.js';

export interface Source5WorkflowEffectFields {
  readonly kind: 'source5-workflow-effect.v1';
  readonly projectRoot: string;
  readonly plan: ModernSavedTransitionPlan;
  readonly operation: ModernTransitionOperation;
  readonly phase: ModernPhaseGraph['phases'][number] & { readonly id: Source5WorkflowPhase };
  readonly authority: Source5WorkflowAuthority;
  readonly lease: ProjectMutationLease;
  readonly now: Date;
  readonly clock?: () => Date;
  readonly runner: CommandRunner;
  readonly transport: GitHubActivationTransport;
  readonly observationOnly: boolean;
  readonly profile: 'single-maintainer-gitflow' | 'team-gitflow';
  readonly reviewedPlans: readonly ModernSavedTransitionPlan[];
}
export interface Source5WorkflowEffectInput extends Source5WorkflowEffectFields {
  readonly publicationCheckpoint?: WorkflowPublicationCheckpoint;
  readonly workflowCheckpoint?: WorkflowProofCheckpoint;
  readonly workflowObservationOnly: boolean;
  readonly executionRefIntent?: { bindingDigest: string; planDigest: string };
  readonly runnerAdmissionIntent?: { bindingDigest: string; planDigest: string };
  readonly recordWorkflowPublication: (checkpoint: WorkflowPublicationCheckpoint) => Promise<void>;
  readonly recordWorkflowDispatch: (checkpoint: WorkflowProofCheckpoint) => Promise<void>;
  readonly recordExecutionRefIntent: (intent: { bindingDigest: string; planDigest: string }) => Promise<void>;
  readonly recordRunnerAdmissionIntent: (intent: { bindingDigest: string; planDigest: string }) => Promise<void>;
}
const issued = new WeakMap<Source5WorkflowEffectInput, { journal: Source5WorkflowJournal; entryKey: string; submitted: Set<string> }>();
export async function createSource5WorkflowEffectInput(
  fields: Source5WorkflowEffectFields, journal: Source5WorkflowJournal
): Promise<Source5WorkflowEffectInput> {
  assertSource5WorkflowJournal(journal);
  await journal.assertInventory();
  const allowedFields = ['kind', 'projectRoot', 'plan', 'operation', 'phase', 'authority', 'lease',
    'now', 'clock', 'runner', 'transport', 'observationOnly', 'profile', 'reviewedPlans'];
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !allowedFields.includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(fields)).some(descriptor => descriptor.get || descriptor.set) ||
    fields.kind !== 'source5-workflow-effect.v1' || typeof fields.observationOnly !== 'boolean' ||
    !Array.isArray(fields.reviewedPlans) || fields.reviewedPlans.some(plan => canonicalSha256(plan) !== canonicalSha256(journal.plan))) {
    return workflowFailure('workflow-source5-effect-context', 'Unknown runtime fields, caller checkpoint callbacks or arbitrary original plans are not an engine-owned effect context.');
  }
  const phase = modernActivationSourceContracts().find(row => row.identity.phaseGraphHash === fields.plan.identity.phaseGraphHash)
    ?.graph.phases.find(phase => phase.id === fields.plan.phaseId);
  if (fields.projectRoot !== journal.projectRoot || canonicalSha256(fields.plan) !== canonicalSha256(journal.plan) ||
    fields.lease !== journal.lease || !phase || canonicalSha256(fields.phase) !== canonicalSha256(phase) ||
    fields.profile !== fields.plan.identity.profile || !fields.observationOnly && (journal.wasAttempted(fields.operation) ||
      (await journal.events(fields.operation)).length)) {
    return workflowFailure('workflow-source5-effect-context', 'An attempted workflow entry can only receive observation authority, never another effect carrier.');
  }
  await assertSource5WorkflowAuthority({ authority: fields.authority, projectRoot: fields.projectRoot,
    plan: fields.plan, operation: fields.operation, now: fields.clock?.() ?? fields.now, write: !fields.observationOnly, lease: fields.lease });
  const entryKey = await readSource5WorkflowEntryKey({ ...fields, firstIntent: false });
  return withSource5WorkflowEntryGate(fields.projectRoot, fields.lease, entryKey, async gate => {
    await assertSource5WorkflowAuthority({ ...fields, now: fields.clock?.() ?? fields.now, write: !fields.observationOnly });
    const events = await journal.events(fields.operation);
    if (!fields.observationOnly && events.length) {
      return workflowFailure('workflow-source5-effect-context', 'Durable original work appeared before carrier issuance; only observation is permitted.');
    }
    if (!fields.observationOnly) await claimSource5WorkflowEntryCarrier(gate);
    const intent = (stage: Source5WorkflowStage) => {
      const event = events.find(event => event.stage === stage);
      return event ? { bindingDigest: event.bindingDigest, planDigest: event.planDigest } : undefined;
    };
    const publication = [...events].reverse().find(event => event.stage.startsWith('publication-'));
    let publicationCheckpoint: WorkflowPublicationCheckpoint | undefined;
    if (publication) {
      publicationCheckpoint = typeof publication.data.commitSha === 'string'
        ? { bindingDigest: publication.bindingDigest, planDigest: publication.planDigest,
          stage: publication.stage === 'publication-published' ? 'published' :
            publication.stage.startsWith('publication-push-') ? 'push-intent' : 'committed',
          commitSha: publication.data.commitSha }
        : { bindingDigest: publication.bindingDigest, planDigest: publication.planDigest, stage: 'writing' };
    }
    const dispatch = [...events].reverse().find(event => event.stage.startsWith('dispatch-'));
    const workflowCheckpoint = dispatch ? readSource5WorkflowDispatchCheckpoint(dispatch.data, String(fields.operation.inputs.repository)) : undefined;
    const input: Source5WorkflowEffectInput = Object.freeze({ ...fields, plan: journal.plan,
      operation: captureWorkflowBinding(fields.operation), phase: captureWorkflowBinding(fields.phase),
      reviewedPlans: Object.freeze([journal.plan]), now: new Date(fields.now.getTime()),
      publicationCheckpoint, workflowCheckpoint, workflowObservationOnly: fields.observationOnly,
      executionRefIntent: intent('execution-ref-intent'), runnerAdmissionIntent: intent('runner-intent'),
      recordWorkflowPublication: (checkpoint: WorkflowPublicationCheckpoint) =>
        recordSource5WorkflowStage(input, `publication-${checkpoint.stage}`, { ...checkpoint }),
      recordWorkflowDispatch: (checkpoint: WorkflowProofCheckpoint) =>
        recordSource5WorkflowStage(input, checkpoint.stage === 'dispatch-intent' ? 'dispatch-intent' :
          checkpoint.stage === 'accepted' ? 'dispatch-accepted' : 'dispatch-terminal', { ...checkpoint }),
      recordExecutionRefIntent: (intent: { bindingDigest: string; planDigest: string }) =>
        recordSource5WorkflowStage(input, 'execution-ref-intent', intent),
      recordRunnerAdmissionIntent: (intent: { bindingDigest: string; planDigest: string }) =>
        recordSource5WorkflowStage(input, 'runner-intent', intent)
    });
    issued.set(input, { journal, entryKey, submitted: new Set() });
    return input;
  });
}
export function assertSource5WorkflowEffectContext(input: Source5WorkflowEffectInput): void {
  if (!issued.has(input)) workflowFailure('workflow-source5-effect-context', 'Structural runtime fields or success-shaped callbacks are not a workflow effect capability.');
}
export async function recordSource5WorkflowStage(
  input: Source5WorkflowEffectInput, stage: Source5WorkflowStage, data: Readonly<Record<string, unknown>>
): Promise<void> {
  const binding = issued.get(input);
  if (!binding) return workflowFailure('workflow-source5-effect-context', 'Workflow checkpoints require their original engine-owned effect context.');
  await withSource5WorkflowEntryGate(input.projectRoot, input.lease, binding.entryKey, async () => {
    const firstIntent = !(await binding.journal.events(input.operation)).length;
    if (input.observationOnly && (firstIntent || stage.endsWith('-intent') || stage === 'publication-writing')) {
      return workflowFailure('workflow-observation-only', 'An observation carrier cannot introduce or repeat original intent.');
    }
    if (firstIntent) await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: !input.observationOnly });
    await assertSource5WorkflowEntryOwnership({ ...input, firstIntent });
    const bindingDigest = canonicalSha256(input.operation.inputs), planDigest = input.plan.planDigest;
    if (data.bindingDigest !== undefined && data.bindingDigest !== bindingDigest ||
      data.planDigest !== undefined && data.planDigest !== planDigest) {
      return workflowFailure('workflow-source5-checkpoint', 'An original checkpoint cannot be retagged to this carrier plan or binding.');
    }
    await binding.journal.record(input.operation, stage, { ...captureWorkflowBinding(data), bindingDigest, planDigest });
  });
}
export async function assertSource5WorkflowIntent(
  input: Source5WorkflowEffectInput, request: GitHubRequest | { readonly git: readonly string[] } | 'source-write'
): Promise<void> {
  request = captureWorkflowBinding(request);
  const bound = issued.get(input);
  if (!bound || input.observationOnly) return workflowFailure('workflow-observation-only', 'Only an unconsumed engine-issued workflow entry can perform its original exact effect.');
  return withSource5WorkflowEntryGate(input.projectRoot, input.lease, bound.entryKey, async () => {
    await bound.journal.assertInventory();
    await assertSource5WorkflowEntryOwnership({ ...input, firstIntent: false });
    const events = await bound.journal.events(input.operation), value = input.operation.inputs;
    const event = (stage: Source5WorkflowStage) => events.find(event => event.stage === stage);
    const same = (left: unknown, right: unknown) => canonicalSha256(left) === canonicalSha256(right);
    let identity = '', matches = false;
    if (request === 'source-write') {
      identity = 'source-write'; matches = Boolean(event('publication-writing'));
    } else if ('git' in request) {
      if (!Array.isArray(value.files) || value.files.some(file => !isRecord(file) || typeof file.path !== 'string')) {
        return workflowFailure('workflow-source5-intent', 'A source effect has no exact original file inventory.');
      }
      const files = value.files.map(file => String(file.path));
      const observed = event('publication-committed')?.data.commitSha;
      const commands = [
        { identity: 'git-add', stage: 'publication-writing' as const, args: ['--literal-pathspecs', 'add', '--', ...files] },
        { identity: 'git-commit', stage: 'publication-commit-intent' as const, args: ['-c', `core.hooksPath=${devNull}`,
          '--literal-pathspecs', 'commit', '--only', '--no-gpg-sign', '-m', 'Publish reviewed governance workflow source',
          '-m', 'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>', '--', ...files] },
        { identity: 'git-push', stage: 'publication-push-intent' as const,
          args: ['push', '--porcelain', 'origin', `${observed}:refs/heads/${value.ref}`] }
      ];
      const selected = commands.find(command => same(request.git, command.args));
      identity = selected?.identity ?? ''; matches = Boolean(selected && event(selected.stage));
    } else if (request.method === 'POST' && request.path === `/repos/${value.repository}/git/refs`) {
      identity = 'tag-create'; matches = Boolean(event('execution-ref-intent')) &&
        same(request.body, { ref: `refs/tags/${value.executionRef}`, sha: value.sourceSha });
    } else if (request.method === 'PATCH' &&
      request.path === `/orgs/${String(value.repository).split('/')[0]}/actions/runner-groups/${value.groupId}`) {
      identity = 'runner-patch'; matches = Boolean(event('runner-intent')) && same(request.body,
        { name: value.groupName, restricted_to_workflows: true, selected_workflows: value.afterWorkflows });
    } else if (request.method === 'POST' &&
      request.path === `/repos/${value.repository}/actions/workflows/${event('dispatch-intent')?.data.workflowId}/dispatches`) {
      identity = 'workflow-dispatch'; matches = Boolean(event('dispatch-intent')) && same(request.body,
        { ref: value.executionRef, inputs: { source_sha: value.sourceSha,
          protected_ref: `refs/heads/${value.ref}`, proof_id: canonicalSha256(value) } });
    }
    if (!matches || !identity || bound.submitted.has(identity)) {
      return workflowFailure('workflow-source5-intent', 'The exact reserved effect has no confirmed original intent, differs from review, or was already attempted. Never repeat uncertain work.');
    }
    await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: true });
    bound.submitted.add(identity);
  });
}

export async function requestSource5WorkflowEffect(
  input: Source5WorkflowEffectInput, request: GitHubRequest
): Promise<GitHubResponse> {
  request = captureWorkflowBinding(request);
  if (Object.keys(request).some(key => !['method', 'path', 'body'].includes(key))) {
    return workflowFailure('workflow-source5-intent', 'An exact provider effect cannot carry unreviewed transport fields.');
  }
  assertSource5WorkflowEffectContext(input);
  await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: true });
  await assertSource5WorkflowIntent(input, request);
  await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: true });
  const response = await input.transport.request(request);
  await recordSource5WorkflowResponse(input, request, response);
  return response;
}

async function recordSource5WorkflowResponse(
  input: Source5WorkflowEffectInput, request: GitHubRequest, response: GitHubResponse
): Promise<void> {
  const bound = issued.get(input);
  if (!bound) return workflowFailure('workflow-source5-effect-context', 'Acceptance requires the original issued effect carrier.');
  const data = response.data, value = input.operation.inputs;
  if (request.method === 'POST' && request.path === `/repos/${value.repository}/git/refs` && response.status === 201) {
    if (!isRecord(data) || !isRecord(data.object)) {
      return workflowFailure('workflow-source5-acceptance', 'Tag creation returned no exact acceptance handle; retain original intent and never repeat uncertain creation.');
    }
    await recordSource5WorkflowStage(input, 'execution-ref-accepted', {
      ref: data.ref, sha: data.object.sha, url: data.url
    });
  } else if (request.method === 'PATCH' && response.status === 200) {
    if (!isRecord(data) || !Array.isArray(data.selected_workflows)) {
      return workflowFailure('workflow-source5-acceptance', 'Runner assignment returned no exact acceptance fields; original intent remains unresolved.');
    }
    await recordSource5WorkflowStage(input, 'runner-accepted', {
      groupId: data.id, groupName: data.name, selectedWorkflowsDigest: canonicalSha256([...data.selected_workflows].sort())
    });
  } else if (request.method === 'POST' && request.path.includes('/dispatches')) {
    const handle = readWorkflowDispatchHandle(response, String(value.repository));
    if (handle) {
      const intent = (await bound.journal.events(input.operation)).find(event => event.stage === 'dispatch-intent');
      if (!intent) return workflowFailure('workflow-source5-acceptance', 'Dispatch acceptance lost its original intent; no handle may be adopted or retagged.');
      await recordSource5WorkflowStage(input, 'dispatch-accepted', { ...intent.data, ...handle, stage: 'accepted' });
    }
  }
}

async function recordSource5WorkflowGitResult(
  input: Source5WorkflowEffectInput, args: readonly string[], output: string
): Promise<void> {
  if (args[0] !== 'push') return;
  const bound = issued.get(input);
  if (!bound) return workflowFailure('workflow-source5-effect-context', 'Push acceptance requires the original issued effect carrier.');
  const intent = (await bound.journal.events(input.operation)).find(event => event.stage === 'publication-push-intent');
  if (!intent) return workflowFailure('workflow-source5-acceptance', 'Push acceptance lost its original exact commit intent.');
  await recordSource5WorkflowStage(input, 'publication-push-accepted', {
    commitSha: intent.data.commitSha, outputDigest: canonicalSha256(output)
  });
}

export async function runSource5WorkflowGitEffect(
  input: Source5WorkflowEffectInput, args: readonly string[], timeoutMs: number
) {
  args = captureWorkflowBinding(args);
  assertSource5WorkflowEffectContext(input);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    return workflowFailure('workflow-deadline', 'A workflow Git effect requires its unchanged bounded runtime deadline.');
  }
  await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: true });
  await assertSource5WorkflowIntent(input, { git: args });
  await assertSource5WorkflowAuthority({ ...input, now: input.clock?.() ?? input.now, write: true });
  const result = await input.runner.run(workflowGitCommand(args), workflowGitOptions(input.projectRoot, timeoutMs));
  if (result.status === 0 && !result.timedOut && !result.outputLimitExceeded && !result.errorCode && !result.aborted) {
    await recordSource5WorkflowGitResult(input, args, result.stdout);
  }
  return result;
}

export function isSource5WorkflowEffectInput(value: object): value is Source5WorkflowEffectInput {
  return 'kind' in value && value.kind === 'source5-workflow-effect.v1';
}
