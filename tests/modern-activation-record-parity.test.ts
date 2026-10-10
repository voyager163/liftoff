import { describe, expect, expectTypeOf, it } from 'vitest';
import { currentActivationRecordValidators, releasedV3RecordValidators } from '../src/domain/governance/activation/record-validation.js';
import { historicalV3PhaseGraph } from '../src/governance-activation/historical-v3.js';
import * as Current from '../src/domain/governance/activation/types.js';
import type { CurrentActivationIdentity } from '../src/domain/governance/policy/identity.js';
import { capturedV3Records } from './fixtures/activation-v3/fixture.js';
import { historyArray, historyRecord } from '../src/governance-activation/history-contracts.js';
import { canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { assertSafeControlRecord } from '../src/domain/governance/activation/source-values.js';
import { assertSafeHistoricalRecord, ActivationHistoryError } from '../src/governance-activation/historical-safety.js';

describe('unchanged current/released factory shapes and runtime meaning', () => {
  it('retains every facade key, own order and current exact record type', () => {
    const api = currentActivationRecordValidators();
    expect(Object.keys(api)).toEqual([
      'validateActivationIdentity', 'validateActivationConfiguration', 'validateGovernanceTaskProjectionRecord',
      'validateUserActivationState', 'validateEvidenceHeader', 'validateLiveReadbackProof', 'validateApprovalEnvelope',
      'validateSavedTransitionPlan', 'validateSupersessionRecord', 'validateGraphReconciliationRecord', 'validateCredentialPolicy',
      'stringArray', 'exact', 'enumValue', 'stringField', 'record', 'requireVersion', 'booleanField', 'exactStringSet', 'safePathParts', 'hexDigest', 'publicJson'
    ]);
    expectTypeOf<ReturnType<typeof api.validateActivationIdentity>>().toEqualTypeOf<CurrentActivationIdentity>();
    expectTypeOf<ReturnType<typeof api.validateUserActivationState>>().toEqualTypeOf<Current.UserActivationState>();
    expectTypeOf<ReturnType<typeof api.validateActivationConfiguration>>().toEqualTypeOf<Current.ActivationConfiguration>();
    expectTypeOf<ReturnType<typeof api.validateGovernanceTaskProjectionRecord>>().toEqualTypeOf<Current.GovernanceTaskProjectionRecord>();
    expectTypeOf<ReturnType<typeof api.validateLiveReadbackProof>>().toEqualTypeOf<Current.LiveReadbackProof>();
    expectTypeOf<ReturnType<typeof api.validateSupersessionRecord>>().toEqualTypeOf<Current.SupersessionRecord>();
    expectTypeOf<ReturnType<typeof api.validateSavedTransitionPlan>>().toEqualTypeOf<Current.SavedTransitionPlan>();
    expectTypeOf<ReturnType<typeof api.validateApprovalEnvelope>>().toEqualTypeOf<Current.ApprovalEnvelope>();
    expectTypeOf<ReturnType<typeof api.validateCredentialPolicy>>().toEqualTypeOf<Current.CredentialPolicy>();
    expectTypeOf<ReturnType<typeof api.validateEvidenceHeader>>().toEqualTypeOf<Current.EvidenceHeader>();
    expectTypeOf<ReturnType<typeof api.validateGraphReconciliationRecord>>().toEqualTypeOf<Current.GraphReconciliationRecord>();
    expectTypeOf<Parameters<typeof api.validateGraphReconciliationRecord>>()
      .toEqualTypeOf<[value: unknown, recognizedGraphHashes?: ReadonlySet<string>]>();
    expect(api.validateApprovalEnvelope.length).toBe(1);
    expect(api.validateGraphReconciliationRecord.length).toBe(1);
  });
  it('preserves current/released data normalization and existing malformed error precedence', () => {
    const original = capturedV3Records(), current = currentActivationRecordValidators(), released = releasedV3RecordValidators(historicalV3PhaseGraph());
    const releasedPlan = historyArray(original.plans, 'plans')[0];
    const releasedApproval = historyArray(original.approvals, 'approvals')[0];
    const cases = [
      { api: released, state: original.state, credential: original.credential, plan: releasedPlan, approval: releasedApproval },
      {
        api: current,
        state: { ...historyRecord(original.state, 'state'), identity: currentActivationIdentity },
        credential: { ...historyRecord(original.credential, 'credential'), identity: currentActivationIdentity },
        plan: {
          ...historyRecord(releasedPlan, 'plan'),
          identity: currentActivationIdentity,
          graphHash: currentActivationIdentity.phaseGraphHash
        },
        approval: { ...historyRecord(releasedApproval, 'approval'), identity: currentActivationIdentity }
      }
    ] as const;
    for (const { api, state, credential, plan, approval } of cases) {
      expect(api.validateUserActivationState(state)).toEqual(state);
      expect(api.validateCredentialPolicy(credential)).toEqual(credential);
      expect(api.validateSavedTransitionPlan(plan)).toEqual(plan);
      expect(() => api.validateSavedTransitionPlan({ ...historyRecord(plan, 'plan'), schemaVersion: 3, identity: null }))
        .toThrow('transitionPlan.schemaVersion must be 2.');
      expect(api.validateApprovalEnvelope(approval)).toEqual(approval);
      expect(() => api.validateApprovalEnvelope({ ...historyRecord(approval, 'approval'), schemaVersion: 4, expiresAt: 'invalid' }))
        .toThrow('approvalEnvelope.schemaVersion must be 3.');
    }
  });
  it('keeps custom recognized reconciliation hashes shape-bound, not falsely fixed to current graph', () => {
    const record = historyRecord(capturedV3Records().reconciliation, 'reconciliation');
    record.fromGraphHash = 'f'.repeat(64);
    historyRecord(record.fromIdentity, 'identity').phaseGraphHash = 'f'.repeat(64);
    expect(currentActivationRecordValidators().validateGraphReconciliationRecord(record,
      new Set(['f'.repeat(64), canonicalPhaseGraphHash,
        historyRecord(record.toIdentity, 'toIdentity').phaseGraphHash as string])).fromGraphHash).toBe('f'.repeat(64));
    expect(() => currentActivationRecordValidators().validateGraphReconciliationRecord(record)).toThrow(/recognized graph hash/);
  });

  it('retains the historical exception and exact non-SyntaxError nested-JSON rejection', () => {
    const forbidden = '{"outer":"{\\"prior_state\\":{}}"}';
    const failure = new Error('control safety rejected');
    expect(() => assertSafeControlRecord(forbidden, () => { throw failure; })).toThrow(failure);
    try { assertSafeHistoricalRecord(forbidden, 'historical/path'); throw new Error('unexpected success'); }
    catch (error) {
      expect(error).toBeInstanceOf(ActivationHistoryError);
      expect(error).toMatchObject({ code: 'unsafe-historical-payload', location: 'historical/path',
        message: 'historical/path: historical preservation is blocked by prohibited sensitive content or an unsafe payload; source bytes were not copied or modified.' });
    }
    expect(() => assertSafeHistoricalRecord('{not-json', 'safe')).not.toThrow();
    expect(() => assertSafeControlRecord({ token: { strategy: 'installation-token', generatedBy: 'github-app', ttlSeconds: 60 } },
      () => { throw failure; })).not.toThrow();
  });

  it('preserves the real inclusive existing 8MiB string, 64-depth and 200000-node screen limits', () => {
    const fail = () => { throw new Error('limit'); };
    expect(() => assertSafeControlRecord('x'.repeat(8 * 1024 * 1024), fail)).not.toThrow();
    expect(() => assertSafeControlRecord('x'.repeat(8 * 1024 * 1024 + 1), fail)).toThrow('limit');
    expect(() => assertSafeControlRecord(new Array(199_999).fill(null), fail)).not.toThrow();
    expect(() => assertSafeControlRecord(new Array(200_000).fill(null), fail)).toThrow('limit');
    let nested: unknown = null; for (let i = 0; i < 64; i++) nested = [nested];
    expect(() => assertSafeControlRecord(nested, fail)).not.toThrow();
    expect(() => assertSafeControlRecord([nested], fail)).toThrow('limit');
  });
});
