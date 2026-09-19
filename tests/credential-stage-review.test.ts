import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  credentialEnrollmentStageReviewOutcome, credentialUsageFinalizationReview, credentialUsageStageReviewOutcome,
  credentialRunReadbackPendingOutcome, credentialTerminalReadbackBlockedOutcome
} from '../src/adapters/credentials/credential-stage-review.js';
import { parseProductionCredentialConfiguration } from '../src/adapters/credentials/production-credentials.js';
import { usageChallenge, usageOperation, usageProvider } from './helpers/credential-usage-fixture.js';
import { enrollmentOperation, fixtureCredentialTarget } from './helpers/credential-fixture.js';
import type { CredentialEnrollmentResult } from '../src/adapters/credentials/github-enrollment.js';
import { runnerPreflightSecretName } from '../src/domain/governance/activation/types.js';
import { WorkflowDispatchReadbackPendingError } from '../src/adapters/github/production-checks.js';
import type { WorkflowEffectCheckpoints } from '../src/application/repository-governance/workflow-checkpoints.js';

describe('fully settled credential stage review handoff', () => {
  it('returns exact public verification inputs and proof refs without rewriting original dispatch identity', async () => {
    const f = usageProvider();
    const proof = await f.verify();
    const original = structuredClone(usageOperation);
    const stagePlan = canonicalSha256('a separately approved readback stage');
    const review = credentialUsageFinalizationReview(stagePlan, f.target, usageChallenge, usageOperation, proof);
    expect(review).toMatchObject({
      schemaVersion: 1, kind: 'credential-usage', phaseId: 'credential-ready', sourcePlanDigest: stagePlan,
      payload: {
        nextStage: 'verify', originalDispatchPlanDigest: original.planDigest, originalOperationId: original.operationId,
        artifact: proof.artifact
      }
    });

    expect(parseProductionCredentialConfiguration(review.payload.nextPhaseInputs)).toMatchObject({
      mode: 'verify', source: 'existing-app-private-key', custodyVersion: null, challenge: { runId: 82, runAttempt: 1 }
    });
    expect(usageOperation).toEqual(original);
    expect(review.payload).not.toHaveProperty('report');
    const outcome = credentialUsageStageReviewOutcome(stagePlan, {
      ...enrollmentOperation(), actionId: usageOperation.actionId, mutationClass: 'github-workflow-dispatch'
    }, f.target, usageChallenge, usageOperation, proof);
    expect(outcome.status).toBe('review-required');
    expect(outcome.operation).toBe(usageOperation);
    expect(outcome.review).toEqual(review);
  });

  it.each(['running', 'failed'] as const)('does not turn a %s operation into a fully settled review stage', async (status) => {
    const f = usageProvider();
    const proof = await f.verify();
    expect(() => credentialUsageFinalizationReview(usageOperation.planDigest!, f.target, usageChallenge,
      { ...usageOperation, status }, proof)).toThrow(/fully settled/);
  });

  it('rejects substituted run/actor/artifact identities without inventing a next-stage ID', async () => {
    const f = usageProvider();
    const proof = await f.verify();
    expect(() => credentialUsageFinalizationReview(usageOperation.planDigest!, f.target, usageChallenge,
      { ...usageOperation, operationId: '999' }, proof)).toThrow();
    expect(() => credentialUsageFinalizationReview(usageOperation.planDigest!, f.target, usageChallenge,
      usageOperation, { ...proof, actorId: 999 })).toThrow();
    expect(() => credentialUsageFinalizationReview(usageOperation.planDigest!, f.target, usageChallenge,
      usageOperation, { ...proof, artifact: { ...proof.artifact, id: 0 } })).toThrow();
  });

  it('does not report a known completed enrollment as running or guess future workflow/run IDs', () => {
    const operation = enrollmentOperation();
    const sourcePlanDigest = canonicalSha256('settled enrollment stage');
    const result: CredentialEnrollmentResult = {
      target: fixtureCredentialTarget, usage: 'not-yet-proven',
      receipt: { status: 201, providerRequestId: 'ABCD:1234:5678', providerVersion: null },
      prepared: {
        schemaVersion: 1, kind: 'github-credential-prepared', projectRoot: '/synthetic-only',
        projectIdentity: { device: '1', inode: '2', birthtime: '3' }, activationIdentityDigest: canonicalSha256('synthetic identity'),
        target: { repository: 'owner/repo', repositoryId: 42, secretName: runnerPreflightSecretName },
        operationDigest: canonicalSha256(operation), planDigest: sourcePlanDigest, approvalEnvelopeHash: canonicalSha256('synthetic issued approval'),
        attempt: 0, correlationId: '11111111-2222-4333-8444-555555555555', preparedAt: '2026-09-15T00:00:00.000Z'
      }
    };
    const outcome = credentialEnrollmentStageReviewOutcome(sourcePlanDigest, operation, result, new Date('2026-09-15T00:00:01Z'));
    expect(outcome).toMatchObject({
      status: 'review-required', operation: { status: 'completed', operationId: result.receipt.providerRequestId, planDigest: sourcePlanDigest },
      review: { schemaVersion: 1, kind: 'credential-enrollment', sourcePlanDigest }
    });
    expect(outcome.review?.payload).not.toHaveProperty('nextPhaseInputs');
    expect(outcome.review?.payload).not.toHaveProperty('runId');
  });
});

describe('credential consumer of unavailable exact run readback', () => {
  function fixture() {
    const operation = {
      ...enrollmentOperation(), actionId: usageOperation.actionId, mutationClass: 'github-workflow-dispatch' as const,
      inputs: { workflow: { fixture: 'retained exact workflow' }, dispatchInputs: { challenge: usageChallenge.challengeId } }
    };
    const providerOperation = { ...usageOperation, status: 'running' as const };
    const correlationId = '11111111-2222-4333-8444-555555555555';
    const prepared = {
      schemaVersion: 1 as const, kind: 'github-workflow-effect-prepared' as const, projectRoot: '/synthetic-only',
      projectIdentity: { device: '1', inode: '2', birthtime: '3' },
      activationIdentityDigest: canonicalSha256('synthetic identity'), intentDigest: canonicalSha256('synthetic intent'),
      operationDigest: canonicalSha256(operation),
      payloadDigest: canonicalSha256({ workflow: operation.inputs.workflow, dispatchInputs: operation.inputs.dispatchInputs }),
      planDigest: providerOperation.planDigest!, approvalEnvelopeHash: canonicalSha256('synthetic issued approval'),
      attempt: 0, correlationId, preparedAt: providerOperation.startedAt
    };
    const checkpoint: WorkflowEffectCheckpoints = {
      prepared, observed: null,
      response: {
        schemaVersion: 1, kind: 'github-workflow-effect-response', preparedDigest: canonicalSha256(prepared),
        status: 200, requestId: 'ABCD:1234:5678', providerId: providerOperation.operationId,
        resourceId: providerOperation.resourceId, recordedAt: providerOperation.observedAt
      }
    };
    return { operation, providerOperation, correlationId, checkpoint };
  }

  it('preserves a real response-only running handle as pending, never as observed usage or review proof', () => {
    const f = fixture();
    const before = structuredClone(f.checkpoint);
    const outcome = credentialRunReadbackPendingOutcome(f.operation, f.providerOperation, f.correlationId, f.checkpoint);
    expect(outcome.status).toBe('pending');
    expect(outcome.operation).toBe(f.providerOperation);
    expect(outcome.operation?.planDigest).toBe(usageOperation.planDigest);
    expect(outcome.review).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
    expect(outcome.liveReadback).toBeUndefined();
    expect(f.checkpoint).toEqual(before);
    expect(f.checkpoint.observed).toBeNull();
  });

  it('rejects missing, mismatched or non-provider response identities rather than inventing a pending run', () => {
    const f = fixture();
    expect(() => credentialRunReadbackPendingOutcome(f.operation, f.providerOperation, f.correlationId, null)).toThrow();
    expect(() => credentialRunReadbackPendingOutcome(f.operation, f.providerOperation, f.correlationId,
      { ...f.checkpoint, response: null })).toThrow();
    expect(() => credentialRunReadbackPendingOutcome(f.operation, f.providerOperation, f.correlationId, {
      ...f.checkpoint, response: { ...f.checkpoint.response!, providerId: '999' }
    })).toThrow();
    expect(() => credentialRunReadbackPendingOutcome(f.operation, f.providerOperation, f.correlationId, {
      ...f.checkpoint, prepared: { ...f.checkpoint.prepared, payloadDigest: canonicalSha256('different input') }
    })).toThrow();
  });

  it.each(['completed', 'failed'] as const)('retains known terminal %s state as blocked, not fabricated running or completed proof', (status) => {
    const f = fixture();
    const error = new WorkflowDispatchReadbackPendingError({ ...f.providerOperation, status }, f.correlationId);
    const before = structuredClone(error.operation);
    const outcome = credentialTerminalReadbackBlockedOutcome(f.operation, error);
    expect(outcome.status).toBe('blocked');
    expect(outcome.operation).toBe(error.operation);
    expect(outcome.operation).toEqual(before);
    expect(outcome.operation?.status).toBe(status);
    expect(outcome.review).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
  });
});
