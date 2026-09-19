import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash } from '../../domain/governance/activation/graph.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan
} from '../../domain/governance/activation/approvals.js';
import { assertPlanOperationsAllowed } from '../../domain/governance/activation/operations.js';
import { validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import { phaseInScope, phaseScope, type SavedTransitionPlan, type TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  readWorkflowPublicationCheckpoints, type WorkflowPublicationPlan
} from '../../adapters/github/production-workflows.js';
import { GitHubActivationError, object, positiveId } from '../../adapters/github/activation-rest.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import type { WorkflowEffectStep } from './workflow-checkpoints.js';

export type WorkflowOriginPhase = 'repository-checks-qualified' | 'green-red-proof' | 'dev-proof' | 'staging-qualified' | 'production-rehearsed';

export interface OriginalPublicationStage {
  step: Exclude<WorkflowEffectStep, 'dispatch'>;
  providerId: string;
  resourceId: string;
  requestId: string | null;
  planDigest: string;
  savedPlanDigest: string;
  approvalEnvelopeHash: string;
  checkpointDigest: string;
  preparedAt: string;
  recordedAt: string;
}

function fail(message: string): never {
  throw new GitHubActivationError('workflow-origin-authority', message);
}

export function workflowOriginTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('An original workflow timestamp is missing or malformed.');
  return Date.parse(value);
}

/** Private original-stage readers only. Entry points must separately admit the current exact reader and its lease. */
export function workflowOriginAuthority(input: PhaseAdapterExecutionInput, phaseId: WorkflowOriginPhase) {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId);
  if (!phase) fail('The original workflow phase is not in the current registered graph.');
  const candidates = [...(input.inspection.contexts[phaseId].reviewedPlans ?? []),
    ...(input.plan.phaseId === phaseId ? [input.plan] : [])];
  const planFor = (digest: string, savedDigest?: string, envelopeHash?: string) => {
    const matches = [...new Map(candidates.filter((plan) => plan.phaseId === phaseId && plan.planDigest === digest &&
      (savedDigest === undefined || canonicalSha256(plan) === savedDigest) &&
      (envelopeHash === undefined || plan.approval.envelopeHash === envelopeHash)).map((plan) => [canonicalSha256(plan), plan])).values()];
    if (matches.length !== 1) fail('The exact original saved qualification plan is missing or ambiguous; a replacement plan cannot adopt its run.');
    const plan = validateSavedTransitionPlan(matches[0]);
    if (plan.graphHash !== canonicalPhaseGraphHash || plan.scope !== phaseScope(phaseId) ||
      !phaseInScope(phaseId, plan.selectionScope ?? plan.scope)) fail('The original qualification phase, scope or graph identity differs.');
    assertPlanOperationsAllowed(plan, phase);
    return plan;
  };
  const admitAt = async (original: SavedTransitionPlan, at: string) => {
    const envelopes = input.inspection.approvals.filter((envelope) => envelope.id === original.approval.envelopeId &&
      canonicalApprovalEnvelopeHash(envelope) === original.approval.envelopeHash);
    const envelope = envelopes[0];
    const when = new Date(workflowOriginTimestamp(at));
    if (envelopes.length !== 1 || !envelope || when.getTime() < workflowOriginTimestamp(original.createdAt) ||
      when.getTime() >= workflowOriginTimestamp(original.expiresAt)) fail('The original effect is outside its unique original plan/approval interval.');
    const evaluation = evaluateApprovalForTransitionPlan(
      approvalRequestForSavedPlan(original, phase, input.inspection.state), [envelope], { now: when }
    );
    if (evaluation.approvalRequired || evaluation.envelopeId !== original.approval.envelopeId ||
      evaluation.envelopeHash !== original.approval.envelopeHash) fail('The original effect has no exact phase-specific approval at its actual prepared time.');
    await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope, githubPorts(input).storage);
    const interval = { notBefore: Math.max(workflowOriginTimestamp(original.createdAt), workflowOriginTimestamp(envelope.approvedAt)),
      expiresAt: Math.min(workflowOriginTimestamp(original.expiresAt), workflowOriginTimestamp(envelope.expiresAt)) };
    // This constrains time only; complete environment/resource authorization remains consumer-owned.
    const request = original.configuration?.phases[phaseId]?.disposableTarget;
    if (request !== undefined) {
      const target = object(request, 'Original qualification request window');
      interval.notBefore = Math.max(interval.notBefore, workflowOriginTimestamp(target.notBefore));
      interval.expiresAt = Math.min(interval.expiresAt, workflowOriginTimestamp(target.expiresAt));
    }
    if (interval.notBefore >= interval.expiresAt || when.getTime() < interval.notBefore || when.getTime() >= interval.expiresAt) {
      fail('The original workflow effect is outside the intersection of its raw request, plan and actual issued approval windows.');
    }
    return interval;
  };
  const readPublication = async (
    plan: SavedTransitionPlan, operation: TransitionOperation, publication: WorkflowPublicationPlan,
    expectedPullRequestNumber?: number, runPreparedAt?: string
  ) => {
    const checkpoints = await readWorkflowPublicationCheckpoints({ ...input, phase, plan }, operation, publication);
    const stages: OriginalPublicationStage[] = [];
    let preceding = -Infinity;
    let pullRequestNumber: number | undefined;
    for (const { step, records } of checkpoints) {
      const provider = records?.observed ?? records?.response;
      if (!records || !provider || !provider.providerId || !provider.resourceId || provider.status < 200 || provider.status >= 300) {
        fail('Every original tree/commit/ref/PR stage needs its exact retained provider custody; an incomplete publication cannot establish fixture admission.');
      }
      if (step === 'pull-request') {
        pullRequestNumber = positiveId(Number(provider.providerId), 'Original provider PR number');
        if (expectedPullRequestNumber !== undefined && pullRequestNumber !== expectedPullRequestNumber) {
          fail('The original private PR number differs from the exact requested fixture.');
        }
      }
      const root = `/repos/${publication.repository}`;
      const resource = `${root}/${step === 'tree' ? `git/trees/${publication.treeSha}` :
        step === 'commit' ? `git/commits/${publication.commitSha}` : step === 'ref' ? `git/ref/heads/${publication.featureBranch}` :
          `pulls/${pullRequestNumber}`}`;
      const providerId = step === 'tree' ? publication.treeSha : step === 'commit' ? publication.commitSha :
        step === 'pull-request' ? String(pullRequestNumber) : provider.providerId;
      if (provider.resourceId !== resource || provider.providerId !== providerId ||
        workflowOriginTimestamp(records.prepared.preparedAt) < preceding ||
        workflowOriginTimestamp(provider.recordedAt) > (input.clock?.() ?? input.now).getTime()) {
        fail('The original publication stage provider identity or causal observation time differs from its private custody.');
      }
      const original = planFor(records.prepared.planDigest, undefined, records.prepared.approvalEnvelopeHash);
      if (!original.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(operation))) {
        fail('An original publication/recovery stage belongs to a different issued operation.');
      }
      await admitAt(original, records.prepared.preparedAt);
      preceding = workflowOriginTimestamp(provider.recordedAt);
      if (step === 'pull-request' && runPreparedAt !== undefined &&
        workflowOriginTimestamp(runPreparedAt) > workflowOriginTimestamp(records.prepared.preparedAt)) {
        fail('The original run checkpoint must precede the actual PR-triggering request.');
      }
      stages.push({
        step, providerId: provider.providerId, resourceId: resource,
        requestId: provider.requestId ?? records.response?.requestId ?? null, planDigest: original.planDigest,
        savedPlanDigest: canonicalSha256(original), approvalEnvelopeHash: records.prepared.approvalEnvelopeHash,
        checkpointDigest: canonicalSha256(records.prepared), preparedAt: records.prepared.preparedAt, recordedAt: provider.recordedAt
      });
    }
    if (pullRequestNumber === undefined) fail('The original publication has no recorded provider PR number.');
    return { pullRequestNumber, stages };
  };
  return { phase, planFor, admitAt, readPublication };
}
