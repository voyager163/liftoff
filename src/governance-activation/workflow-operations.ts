import { isRecord } from '../domain/governance/activation/canonical-json.js';
import type { PhaseId, TransitionOperation } from '../domain/governance/activation/types.js';
import { workflowFailure } from './workflow-binding.js';

export function workflowPlannedOperation(phaseId: PhaseId, actionId: string, binding: unknown): TransitionOperation {
  if (!isRecord(binding) || typeof binding.repository !== 'string') {
    return workflowFailure('workflow-plan', 'Workflow planning requires its exact repository binding.');
  }
  const repository = binding.repository;
  const destination: TransitionOperation['destination'] = { type: 'repository', identity: repository, repository };
  const read: NonNullable<TransitionOperation['effects']>[number] = {
    mutationClass: 'github-read', destination, remote: true, destructive: false
  };
  if (actionId === 'git.workflow-source.publish-reviewed') {
    if (!Array.isArray(binding.files)) return workflowFailure('workflow-plan', 'Source planning requires its per-file inventory.');
    const writes: NonNullable<TransitionOperation['effects']>[number][] = binding.files.map(file => {
      if (!isRecord(file) || typeof file.path !== 'string') return workflowFailure('workflow-plan', 'A reviewed source path is missing.');
      return { mutationClass: file.path.startsWith('.github/workflows/') ? 'write-workflows' : 'write-ruleset-source',
        destination: { type: 'local', identity: file.path, pathParts: file.path.split('/') }, remote: false, destructive: false };
    });
    return { phaseId, actionId, adapter: 'git', mutationClass: 'git-push', destination,
      inputs: binding, remote: true, destructive: false, effects: [...writes, { mutationClass: 'git-commit',
        destination: { type: 'local', identity: '.git' }, remote: false, destructive: false }, read] };
  }
  if (actionId === 'github.workflow-source.admit-reviewed') {
    return { phaseId, actionId, adapter: 'github', mutationClass: 'github-write',
      destination: { type: 'external', identity: `/orgs/${repository.split('/')[0]}/actions/runner-groups/${binding.groupId}` },
      inputs: binding, remote: true, destructive: false, effects: [read] };
  }
  const actions = ['github.workflow-source.bind-execution-ref', 'github.checks.dev-proof',
    'github.checks.staging', 'github.checks.production-rehearsal', 'github.checks.green-red-proof'];
  if (!actions.includes(actionId)) return workflowFailure('workflow-plan', 'The workflow source producer does not expose generic actions.');
  return { phaseId, actionId, adapter: 'github',
    mutationClass: actionId === 'github.workflow-source.bind-execution-ref' ? 'github-write' : 'github-workflow-dispatch',
    inputs: binding, destination: { ...destination, ref: `refs/tags/${binding.executionRef}` },
    remote: true, destructive: false, effects: [read] };
}
