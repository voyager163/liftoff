import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { sourceSha } from './github-config.js';
import { githubRepository, positiveId } from '../adapters/github/activation-rest.js';
import type { GitHubActivationClient } from '../adapters/github/activation-rest.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';

export interface WorkflowExecutionRefObservationRuntime {
  readonly client: Pick<GitHubActivationClient, 'get' | 'list' | 'transport'>;
}

export interface WorkflowExecutionRefBinding {
  repository: string;
  repositoryId: number;
  sourceSha: string;
  treeSha: string;
  executionRef: string;
}

export interface ImmutableWorkflowExecutionRef {
  kind: 'immutable-workflow-execution-ref.v1';
  binding: WorkflowExecutionRefBinding;
  protectingRulesetIds: readonly number[];
  barrierDigest: string;
  providerAdmissionDigest: string;
  observationDigest: string;
}

export function workflowExecutionRefName(sha: string): string {
  return `liftoff-execution-${sourceSha(sha)}`;
}

export async function observeWorkflowExecutionBarrier(
  runtime: WorkflowExecutionRefObservationRuntime, binding: WorkflowExecutionRefBinding
): Promise<{ ids: readonly number[]; digest: string }> {
  githubRepository(binding.repository); positiveId(binding.repositoryId);
  if (binding.executionRef !== workflowExecutionRefName(binding.sourceSha)) {
    return workflowFailure('workflow-execution-ref', 'Execution requires the exact full-commit-named tag, not a mutable branch or an undocumented SHA-dispatch fallback.');
  }
  const repository = await runtime.client.get(`/repos/${binding.repository}`);
  if (repository.id !== binding.repositoryId || repository.full_name !== binding.repository) {
    return workflowFailure('workflow-execution-ref', 'Immutable execution admission differs from the independently observed repository.');
  }
  const summaries = await runtime.client.list(`/repos/${binding.repository}/rulesets?includes_parents=true`);
  const protecting: number[] = [];
  const barriers: unknown[] = [];
  for (const summary of summaries) {
    const id = positiveId(summary.id);
    if (summary.source_type !== 'Repository' || summary.source !== binding.repository) {
      return workflowFailure('workflow-execution-inherited', 'Complete effective inherited/organization rule admission is not supported by this repository-scoped producer. Unknown or inherited policy cannot be silently omitted; no dispatch or policy write is permitted.');
    }
    const ruleset = await runtime.client.get(`/repos/${binding.repository}/rulesets/${id}`);
    if (ruleset.id !== id || ruleset.source_type !== 'Repository' || ruleset.source !== binding.repository ||
      !['branch', 'tag'].includes(String(ruleset.target)) ||
      !['active', 'disabled', 'evaluate'].includes(String(ruleset.enforcement)) ||
      !Array.isArray(ruleset.rules) || ruleset.rules.some(rule => !isRecord(rule) || typeof rule.type !== 'string')) {
      return workflowFailure('workflow-execution-policy', 'Effective repository policy readback is incomplete or unsupported; another valid barrier cannot conceal unknown admission.');
    }
    if (ruleset.target === 'branch' || ruleset.enforcement !== 'active') continue;
    if (
      !Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0 ||
      !isRecord(ruleset.conditions) || !isRecord(ruleset.conditions.ref_name) ||
      Object.keys(ruleset.conditions).some(key => key !== 'ref_name') ||
      Object.keys(ruleset.conditions.ref_name).some(key => !['include', 'exclude'].includes(key)) ||
      !Array.isArray(ruleset.conditions.ref_name.include) || !Array.isArray(ruleset.conditions.ref_name.exclude) ||
      ruleset.conditions.ref_name.exclude.length !== 0 ||
      !ruleset.conditions.ref_name.include.length ||
      ruleset.conditions.ref_name.include.some(ref => typeof ref !== 'string' ||
        ![ `refs/tags/${binding.executionRef}`, 'refs/tags/liftoff-execution-*', '~ALL' ].includes(ref)) ||
      ruleset.rules.some(rule => !isRecord(rule) || !['update', 'deletion'].includes(String(rule.type)) ||
        Object.keys(rule).some(key => key !== 'type'))) {
      return workflowFailure('workflow-execution-policy', 'Active tag policy contains bypass, exclusions, unknown scope or unsupported rules. Complete admission is required before tag creation or dispatch; this producer cannot change policy.');
    }
    const types = ruleset.rules.filter(isRecord).map((rule) => rule.type);
    if (['update', 'deletion'].every((rule) => types.includes(rule))) {
      protecting.push(id);
      barriers.push({ id, source: ruleset.source, target: ruleset.target, enforcement: ruleset.enforcement,
        conditions: ruleset.conditions, bypassActors: ruleset.bypass_actors, types: [...types].sort() });
    }
  }
  if (!protecting.length) {
    return workflowFailure('workflow-execution-unprotected', 'A commit-named tag alone is mutable. Dispatch requires active independently read repository tag-update/deletion protection with no bypass. Blocking all updates also blocks non-fast-forward changes; no unsupported extra tag rule is assumed. This producer never installs or weakens protections.');
  }
  return { ids: protecting.sort((a, b) => a - b), digest: canonicalSha256(barriers) };
}

export async function observeExecutionCommit(
  runtime: WorkflowExecutionRefObservationRuntime, binding: WorkflowExecutionRefBinding
): Promise<void> {
  sourceSha(binding.sourceSha); sourceSha(binding.treeSha, 'Reviewed source tree SHA');
  const commit = await runtime.client.get(`/repos/${binding.repository}/git/commits/${binding.sourceSha}`);
  if (commit.sha !== binding.sourceSha || !isRecord(commit.tree) || commit.tree.sha !== binding.treeSha) {
    return workflowFailure('workflow-execution-tree', 'The actual source commit tree differs from the separately reviewed immutable execution binding.');
  }
}

export async function observeImmutableWorkflowExecutionRef(
  runtime: WorkflowExecutionRefObservationRuntime, binding: WorkflowExecutionRefBinding
): Promise<ImmutableWorkflowExecutionRef> {
  binding = captureWorkflowBinding({
    repository: binding.repository, repositoryId: binding.repositoryId,
    sourceSha: binding.sourceSha, treeSha: binding.treeSha, executionRef: binding.executionRef
  });
  const barrier = await observeWorkflowExecutionBarrier(runtime, binding);
  const providerAdmissionDigest = await observeWorkflowProviderAdmission(runtime, binding, 'dispatch');
  await observeExecutionCommit(runtime, binding);
  const ref = await runtime.client.get(`/repos/${binding.repository}/git/ref/tags/${binding.executionRef}`);
  if (ref.ref !== `refs/tags/${binding.executionRef}` || !isRecord(ref.object) ||
    ref.object.type !== 'commit' || ref.object.sha !== binding.sourceSha) {
    return workflowFailure('workflow-execution-ref', 'The protected execution ref must be the exact observed lightweight tag bound directly to the approved complete commit.');
  }
  return { kind: 'immutable-workflow-execution-ref.v1', binding, protectingRulesetIds: barrier.ids,
    barrierDigest: barrier.digest, providerAdmissionDigest,
    observationDigest: canonicalSha256({ binding, barrierDigest: barrier.digest, providerAdmissionDigest }) };
}

export async function observeWorkflowProviderAdmission(
  runtime: WorkflowExecutionRefObservationRuntime, binding: Pick<WorkflowExecutionRefBinding, 'repository' | 'repositoryId'>,
  effect: 'dispatch' | 'tag-create'
): Promise<string> {
  const response = await runtime.client.transport.request({ method: 'GET', path: `/repos/${binding.repository}` });
  const repository = response.data;
  const header = response.headers['x-oauth-scopes'];
  const scopes = typeof header === 'string' && header.length <= 1024
    ? header.split(',').map((scope) => scope.trim()).filter(Boolean).sort() : [];
  if (response.status !== 200 || !isRecord(repository) || repository.id !== binding.repositoryId ||
    repository.full_name !== binding.repository || !isRecord(repository.permissions) ||
    repository.permissions.push !== true || !scopes.includes('repo') ||
    effect === 'dispatch' && !scopes.includes('workflow')) {
    return workflowFailure('workflow-provider-admission', 'Complete provider permission admission is unavailable. This source supports independently observed classic OAuth repo/workflow grants plus repository push access; fine-grained, installation and workflow-token grants are not inferred from a repository role or caller annotation. Unsupported credentials remain blocked before effects.');
  }
  return canonicalSha256({ mode: 'classic-oauth', repositoryId: binding.repositoryId, scopes, push: true, effect });
}
