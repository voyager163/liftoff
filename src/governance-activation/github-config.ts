import { phaseScope, type PhaseId, type TransitionOperation } from '../domain/governance/activation/types.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhasePlanningInput } from './transition-ports.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../domain/governance/activation/approvals.js';
import {
  createGitHubCliTransport, GitHubActivationClient, GitHubActivationError, githubRef, githubRepository, object, text
} from '../adapters/github/activation-rest.js';
import { githubPorts } from './github-ports.js';

export function clientFor(input: PhasePlanningInput | PhaseAdapterExecutionInput): GitHubActivationClient {
  return new GitHubActivationClient(githubPorts(input).transport ?? createGitHubCliTransport(input.runner, input.inspection.projectRoot));
}

export function phaseConfiguration(
  inspection: GovernanceTransitionInspection, phaseId: PhaseId, keys: readonly string[]
): Record<string, unknown> {
  const config = object(inspection.activationInputs?.phases[phaseId] ?? {}, `${phaseId} configuration`);
  if (Object.keys(config).some((key) => !keys.includes(key))) {
    throw new GitHubActivationError('invalid-configuration', `${phaseId} configuration has unknown keys. Only the documented declarative inputs are allowed; commands and guessed targets are forbidden.`);
  }
  return config;
}

export function repositoryConfiguration(inspection: GovernanceTransitionInspection): {
  name: string; defaultBranch: string; visibility: 'private' | 'public'; create: boolean;
} {
  const config = inspection.activationInputs?.repository;
  const fallback = inspection.state.remoteBinding?.name ?? inspection.state.repository.name;
  const rawName = config?.name ?? (fallback.includes('/') ? fallback : null);
  if (!rawName) {
    throw new GitHubActivationError('repository-binding-required', 'Supply the actual owner/repository or establish it through independently verified publication. Placeholder owners are not executable targets.');
  }
  const name = githubRepository(rawName);
  const bound = inspection.state.remoteBinding;
  if (bound && bound.name.toLowerCase() !== name.toLowerCase()) {
    throw new GitHubActivationError('repository-drift', 'The configured GitHub repository differs from the verified publication binding. Review repository reconciliation first.');
  }
  if (config?.defaultBranch !== undefined && config.defaultBranch !== 'develop') {
    throw new GitHubActivationError('policy-default-branch', 'The single-maintainer GitFlow policy requires develop as the default branch; reconcile an existing nonconforming default explicitly.');
  }
  return {
    name, defaultBranch: githubRef(config?.defaultBranch ?? 'develop'),
    visibility: config?.visibility ?? 'private', create: config?.create === true
  };
}

export function sourceSha(value: unknown, label = 'Reviewed source SHA'): string {
  const sha = text(value, label);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new GitHubActivationError('source-required', `${label} must be an actual full Git commit SHA.`);
  return sha;
}

export function digest(value: unknown, label = 'Artifact digest'): string {
  const result = text(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) throw new GitHubActivationError('digest-required', `${label} must be an immutable sha256 digest.`);
  return result;
}

export function ownedPath(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(result) ||
    result.split('/').some((part) => part === '.' || part === '..' || part === '.git') ||
    result.startsWith('governance/') || /(?:^|\/)(?:\.env|.*\.tfstate)(?:$|\.)/u.test(result)) {
    throw new GitHubActivationError('unsafe-path', `${label} must be an explicitly approved project-relative non-sensitive file path.`);
  }
  return result;
}

export function verifiedOutput(inspection: GovernanceTransitionInspection, phase: PhaseId, key: string): string | number | boolean | null {
  const state = inspection.state.phases[phase];
  const output = inspection.state.phaseOutputs?.[phase];
  if (!state || !['verified', 'retained'].includes(state.state) || !output || !(key in output.values)) {
    throw new GitHubActivationError('predecessor-required', `A current verified ${phase} output named ${key} is required; user assertions are not provider proof.`);
  }
  return output.values[key]!;
}

export function githubOperation(
  input: PhasePlanningInput, actionId: string, mutationClass: TransitionOperation['mutationClass'],
  inputs: Record<string, unknown>, destination?: TransitionOperation['destination'],
  effects?: TransitionOperation['effects']
): TransitionOperation {
  const repository = repositoryConfiguration(input.inspection).name;
  return {
    phaseId: input.phase.id, adapter: 'github', actionId, mutationClass, inputs,
    destination: destination ?? { type: 'repository', identity: repository, repository },
    remote: true, destructive: false, ...(effects?.length ? { effects } : {})
  };
}

export async function assertGitHubAuthorized(input: PhaseAdapterExecutionInput, operation: TransitionOperation): Promise<void> {
  await input.lease?.assertHeld();
  const now = input.clock?.() ?? input.now;
  if (!input.plan.operations.some((planned) => canonicalSha256(planned) === canonicalSha256(operation)) ||
    operation.phaseId !== input.phase.id || input.plan.phaseId !== input.phase.id ||
    input.plan.scope !== phaseScope(input.phase.id) || Date.parse(input.plan.expiresAt) <= now.getTime()) {
    throw new GitHubActivationError('stale-approval', 'The exact GitHub operation is absent from the reviewed activation plan, has changed, or has expired.');
  }
  if (input.plan.configuration && canonicalSha256(input.plan.configuration) !== canonicalSha256(input.inspection.activationInputs)) {
    throw new GitHubActivationError('stale-configuration', 'Activation configuration changed after review.');
  }
  if (!input.phase.approvalGate.required) return;
  const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
  if (!envelope || Date.parse(envelope.expiresAt) <= now.getTime() || Date.parse(envelope.approvedAt) > now.getTime() ||
    canonicalApprovalEnvelopeHash(envelope) !== input.plan.approval.envelopeHash) {
    throw new GitHubActivationError('approval-required', 'The phase-specific GitHub approval is missing, changed, or expired immediately before mutation.');
  }
}
