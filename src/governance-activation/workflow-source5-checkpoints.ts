import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import type { ModernTransitionOperation } from '../domain/governance/activation/modern-record-contracts.js';
import type { WorkflowProofCheckpoint } from './workflow-context-proof.js';
import type { WorkflowPublicationCheckpoint } from './workflow-publication.js';
import type { Source5WorkflowEvent, Source5WorkflowStage } from './workflow-source5-journal.js';
import { readWorkflowDispatchHandle, workflowFailure, workflowTerminalConclusions } from './workflow-binding.js';

const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const keys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]) =>
  canonicalSha256(Object.keys(value).sort()) === canonicalSha256([...expected].sort());
function executionAdmission(value: unknown, binding: unknown): boolean {
  return isRecord(value) && value.kind === 'immutable-workflow-execution-ref.v1' &&
    isRecord(value.binding) && canonicalSha256(value.binding) === canonicalSha256(binding) &&
    keys(value, ['kind', 'binding', 'protectingRulesetIds', 'barrierDigest', 'providerAdmissionDigest', 'observationDigest']) &&
    hex(value.barrierDigest) && hex(value.providerAdmissionDigest) && hex(value.observationDigest) &&
    Array.isArray(value.protectingRulesetIds) && value.protectingRulesetIds.length > 0 &&
    value.protectingRulesetIds.every(id) && new Set(value.protectingRulesetIds).size === value.protectingRulesetIds.length;
}

export function readSource5WorkflowPublicationCheckpoint(value: Readonly<Record<string, unknown>>): WorkflowPublicationCheckpoint {
  if (!hex(value.bindingDigest) || !hex(value.planDigest)) {
    return workflowFailure('workflow-source5-checkpoint', 'Publication progress lost its original exact authority.');
  }
  if (value.stage === 'writing' && keys(value, ['bindingDigest', 'planDigest', 'stage'])) {
    return { bindingDigest: value.bindingDigest, planDigest: value.planDigest, stage: 'writing' };
  }
  if ((value.stage === 'committed' || value.stage === 'push-intent' || value.stage === 'published') &&
    sha(value.commitSha) && keys(value, ['bindingDigest', 'planDigest', 'stage', 'commitSha'])) {
    return { bindingDigest: value.bindingDigest, planDigest: value.planDigest, stage: value.stage, commitSha: value.commitSha };
  }
  return workflowFailure('workflow-source5-checkpoint', 'Unknown publication checkpoint fields or commit handle.');
}

export function readSource5WorkflowDispatchCheckpoint(
  value: Readonly<Record<string, unknown>>, repository: string
): WorkflowProofCheckpoint {
  if (!hex(value.bindingDigest) || !hex(value.planDigest) || !id(value.workflowId) ||
    typeof value.dispatchedAt !== 'string' || !Number.isFinite(Date.parse(value.dispatchedAt)) ||
    Object.keys(value).some(key => !['bindingDigest', 'planDigest', 'workflowId', 'dispatchedAt', 'stage',
      'runId', 'runUrl', 'htmlUrl', 'terminalConclusion', 'terminalConclusionDigest'].includes(key))) {
    return workflowFailure('workflow-source5-checkpoint', 'Dispatch progress requires its original bounded exact handle, time, workflow and authority.');
  }
  const base = { bindingDigest: value.bindingDigest, planDigest: value.planDigest,
    workflowId: value.workflowId, dispatchedAt: value.dispatchedAt };
  if (value.stage === 'dispatch-intent' && keys(value, ['bindingDigest', 'planDigest', 'workflowId', 'dispatchedAt', 'stage'])) {
    return { ...base, stage: 'dispatch-intent' };
  }
  if (!id(value.runId) || !(value.stage === 'accepted' || value.stage === 'terminal')) {
    return workflowFailure('workflow-source5-checkpoint', 'Accepted dispatch progress requires an actual positive run handle.');
  }
  const handle: Pick<WorkflowProofCheckpoint, 'runId' | 'runUrl' | 'htmlUrl'> = { runId: value.runId };
  if (value.runUrl !== undefined || value.htmlUrl !== undefined) {
    Object.assign(handle, readWorkflowDispatchHandle({ status: 200, headers: {}, data: {
      workflow_run_id: value.runId, run_url: value.runUrl, html_url: value.htmlUrl
    } }, repository));
  }
  if (value.stage === 'accepted') {
    if (value.terminalConclusion !== undefined || value.terminalConclusionDigest !== undefined) {
      return workflowFailure('workflow-source5-checkpoint', 'Acceptance cannot invent terminal provider truth.');
    }
    return { ...base, ...handle, stage: 'accepted' };
  }
  const conclusion = value.terminalConclusion === 'unknown' ? 'unknown' :
    workflowTerminalConclusions.find(conclusion => conclusion === value.terminalConclusion);
  if (!conclusion || !hex(value.terminalConclusionDigest) || conclusion !== 'unknown' &&
    canonicalSha256({ conclusion }) !== value.terminalConclusionDigest) {
    return workflowFailure('workflow-source5-checkpoint', 'Terminal progress requires the exact actual provider conclusion digest; unknown is never success.');
  }
  return { ...base, ...handle, stage: 'terminal', terminalConclusion: conclusion,
    terminalConclusionDigest: value.terminalConclusionDigest };
}

export function validateSource5WorkflowCheckpointData(
  operation: ModernTransitionOperation, stage: Source5WorkflowStage, data: Readonly<Record<string, unknown>>,
  previous: readonly Source5WorkflowEvent[], planDigest: string
): void {
  const binding = operation.inputs, bindingDigest = canonicalSha256(binding);
  const fail = () => workflowFailure('workflow-source5-checkpoint',
    'Checkpoint fields, ordering or known original handle differ from the reviewed closed workflow protocol.');
  if (data.bindingDigest !== bindingDigest || data.planDigest !== planDigest) fail();
  if (stage.startsWith('dispatch-')) {
    const checkpoint = readSource5WorkflowDispatchCheckpoint(data, String(binding.repository));
    if (`dispatch-${checkpoint.stage === 'dispatch-intent' ? 'intent' : checkpoint.stage}` !== stage) fail();
    const prior = [...previous].reverse().find(event => event.stage.startsWith('dispatch-'));
    if (stage !== 'dispatch-intent' && !prior) fail();
    if (stage === 'dispatch-accepted' && prior?.stage !== 'dispatch-intent' ||
      stage === 'dispatch-terminal' && prior?.stage !== 'dispatch-accepted') fail();
    if (prior) {
      const original = readSource5WorkflowDispatchCheckpoint(prior.data, String(binding.repository));
      if (checkpoint.workflowId !== original.workflowId || checkpoint.dispatchedAt !== original.dispatchedAt ||
        original.runId !== undefined && (checkpoint.runId !== original.runId ||
          checkpoint.runUrl !== original.runUrl || checkpoint.htmlUrl !== original.htmlUrl)) fail();
    }
    return;
  }
  if (stage === 'execution-ref-intent' || stage === 'runner-intent') {
    if (!keys(data, ['bindingDigest', 'planDigest'])) fail();
    return;
  }
  if (stage === 'execution-ref-accepted') {
    if (!keys(data, ['bindingDigest', 'planDigest', 'ref', 'sha', 'url']) ||
      data.ref !== `refs/tags/${binding.executionRef}` || data.sha !== binding.sourceSha ||
      data.url !== `https://api.github.com/repos/${binding.repository}/git/refs/tags/${binding.executionRef}`) fail();
    return;
  }
  if (stage === 'runner-accepted') {
    if (!keys(data, ['bindingDigest', 'planDigest', 'groupId', 'groupName', 'selectedWorkflowsDigest']) ||
      data.groupId !== binding.groupId || data.groupName !== binding.groupName || !Array.isArray(binding.afterWorkflows) ||
      data.selectedWorkflowsDigest !== canonicalSha256([...binding.afterWorkflows].sort())) fail();
    return;
  }
  if (stage.startsWith('publication-')) {
    if (stage === 'publication-writing' || stage === 'publication-committed' ||
      stage === 'publication-push-intent' || stage === 'publication-published') {
      const checkpoint = readSource5WorkflowPublicationCheckpoint(data);
      if (`publication-${checkpoint.stage}` !== stage) fail();
    } else if (stage === 'publication-commit-intent') {
      if (!keys(data, ['bindingDigest', 'planDigest']) || !previous.some(event => event.stage === 'publication-writing')) fail();
    } else if (!sha(data.commitSha) || !keys(data, stage === 'publication-push-accepted' ?
      ['bindingDigest', 'planDigest', 'commitSha', 'outputDigest'] : ['bindingDigest', 'planDigest', 'commitSha']) ||
      stage === 'publication-push-accepted' && !hex(data.outputDigest)) fail();
    const original = previous.find(event => sha(event.data.commitSha));
    if (data.commitSha !== undefined && original && data.commitSha !== original.data.commitSha) fail();
    if (stage === 'publication-commit-observed' && !previous.some(event => event.stage === 'publication-commit-intent') ||
      stage === 'publication-committed' && !previous.some(event => event.stage === 'publication-commit-observed') ||
      stage === 'publication-push-intent' && !previous.some(event => event.stage === 'publication-committed') ||
      stage === 'publication-push-accepted' && !previous.some(event => event.stage === 'publication-push-intent') ||
      stage === 'publication-published' && !previous.some(event => event.stage === 'publication-committed')) fail();
    return;
  }
  if (stage !== 'component-completed' || !keys(data, ['bindingDigest', 'planDigest', 'proof']) ||
    !isRecord(data.proof) || !hex(data.proof.observationDigest)) return fail();
  const proof = data.proof;
  if (operation.actionId.startsWith('github.checks.')) {
    const terminal = previous.find(event => event.stage === 'dispatch-terminal');
    const expected = binding.mode === 'green' ? 'success' : binding.mode === 'controlled-red' ? 'failure' : null;
    if (!terminal || proof.runId !== terminal.data.runId || proof.workflowId !== terminal.data.workflowId ||
      proof.dispatchedAt !== terminal.data.dispatchedAt || proof.planDigest !== planDigest ||
      proof.bindingDigest !== bindingDigest || !isRecord(proof.binding) || canonicalSha256(proof.binding) !== bindingDigest ||
      proof.kind !== 'workflow-context-proof.v1' || !expected ||
      proof.conclusion !== expected || terminal.data.terminalConclusion !== expected) fail();
    const requiredContexts = binding.contexts;
    if (!Array.isArray(requiredContexts) || !Array.isArray(proof.contexts) || proof.contexts.length !== requiredContexts.length ||
      !keys(proof, ['kind', 'binding', 'bindingDigest', 'planDigest', 'runId', 'workflowId', 'attempt', 'conclusion',
        'contexts', 'observedAt', 'dispatchedAt', 'observationDigest', 'executionAdmission']) ||
      typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt)) ||
      Date.parse(proof.observedAt) < Date.parse(String(proof.dispatchedAt)) ||
      proof.attempt !== 1 || !executionAdmission(proof.executionAdmission, {
        repository: binding.repository, repositoryId: binding.repositoryId, sourceSha: binding.sourceSha,
        treeSha: binding.treeSha, executionRef: binding.executionRef
      }) || proof.contexts.some((context, index) => {
        const required = requiredContexts[index];
        const conclusion = binding.mode === 'controlled-red' && isRecord(binding.violation) &&
          binding.violation.context === (isRecord(required) ? required.name : null) ? 'failure' : 'success';
        return !isRecord(context) || !isRecord(required) ||
          !keys(context, ['name', 'jobId', 'checkRunId', 'applicationId', 'conclusion', 'validationStep']) || context.name !== required.name ||
          context.validationStep !== required.validationStep || context.conclusion !== conclusion ||
          !id(context.jobId) || !id(context.checkRunId) || !id(context.applicationId);
      }) || proof.observationDigest !== canonicalSha256({
        runId: proof.runId, workflowId: proof.workflowId, attempt: 1, conclusion: expected,
        contexts: proof.contexts, executionAdmission: proof.executionAdmission
      })) fail();
  } else if (operation.actionId.startsWith('git.workflow-source.publish-reviewed:')) {
    const published = previous.find(event => event.stage === 'publication-published');
    const observed = { repository: binding.repository, repositoryId: binding.repositoryId, ref: binding.ref,
      parentSha: binding.parentSha, commitSha: proof.commitSha, treeSha: proof.treeSha,
      files: Array.isArray(binding.files) ? binding.files.map(file => isRecord(file) ? { path: file.path, digest: file.digest } : null) : null };
    if (!published || proof.kind !== 'workflow-source-publication.v1' || proof.bindingDigest !== bindingDigest ||
      proof.commitSha !== published.data.commitSha || !sha(proof.treeSha) || proof.observationDigest !== canonicalSha256(observed) ||
      typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt)) ||
      canonicalSha256(Object.keys(proof).sort()) !== canonicalSha256(['kind', 'bindingDigest', 'repository', 'repositoryId',
        'ref', 'parentSha', 'commitSha', 'treeSha', 'files', 'observedAt', 'observationDigest'].sort()) ||
      Object.entries(observed).some(([key, value]) => canonicalSha256(proof[key]) !== canonicalSha256(value))) fail();
  } else if (operation.actionId.startsWith('github.workflow-source.bind-execution-ref:')) {
    if (!executionAdmission(proof, binding)) fail();
  } else if (proof.bindingDigest !== bindingDigest || !keys(proof, ['bindingDigest', 'observationDigest']) ||
    !Array.isArray(binding.afterWorkflows) || proof.observationDigest !== canonicalSha256({
      repositoryId: binding.repositoryId, groupId: binding.groupId, networkConfigurationId: binding.networkConfigurationId,
      selectedWorkflows: [...binding.afterWorkflows].sort()
    })) fail();
}
