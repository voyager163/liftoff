import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { releasedBytes, releasedCase } from './fixtures/released-baseline/corpus.js';

const legacyRoot = new URL('../assets/governance/single-maintainer-gitflow/activation-v3-reader/domain/governance/activation/', import.meta.url);

const validHex64 = 'a'.repeat(64);
const validHex64b = 'b'.repeat(64);
const validIsoDate = '2026-09-01T12:00:00.000Z';

describe('historical v3 reader approval matrix and authority boundaries', async () => {
  const {
    evaluateApprovalForTransitionPlan,
    approvalRequestForSavedPlan,
    savedPlanAuthorityDigest,
    transitionPlanForPhase,
    authorityOperations,
    transitionAuthorityDigest,
    normalizeApprovalScope,
    canonicalApprovalEnvelopeScope,
    canonicalApprovalEnvelopeHash,
    determineHumanAuthorityQuestion,
    combineApprovalRequests
  } = await import(new URL('approvals.js', legacyRoot).href);

  const {
    validateUserActivationState,
    validateGovernanceTaskProjectionContract,
    validateGovernanceTaskProjectionRecord,
    assertCanonicalGraphValid,
    validateEvidenceReference,
    validateApprovalEnvelope,
    validateSavedTransitionPlan,
    validateActivationConfiguration
  } = await import(new URL('validators.js', legacyRoot).href);

  const {
    currentActivationIdentity,
    canonicalPhaseGraph,
    canonicalPhaseGraphHash,
    phaseContractDigest
  } = await import(new URL('graph.js', legacyRoot).href);

  const {
    phaseIds,
    approvalGateKinds
  } = await import(new URL('types.js', legacyRoot).href);

  describe('real released activation state validation and mutation boundaries', () => {
    it('validates original released activation state without mutation', () => {
      const c = releasedCase('activation-v3-local');
      const f = c.files.find((file) => file.path === 'governance/activation-state.json');
      expect(f).toBeDefined();
      const state = JSON.parse(releasedBytes(f!).toString('utf8'));
      const before = structuredClone(state);
      const validated = validateUserActivationState(state);

      expect(validated.schemaVersion).toBe(3);
      expect(validated.identity.phaseGraphHash).toBe(canonicalPhaseGraphHash);
      expect(Object.keys(validated.phases)).toHaveLength(29);
      expect(state).toEqual(before);
    });

    it('validates state with successor history and migration index bindings', () => {
      const c = releasedCase('activation-v3-with-v2-v1-history');
      const f = c.files.find((file) => file.path === 'governance/activation-state.json');
      expect(f).toBeDefined();
      const state = JSON.parse(releasedBytes(f!).toString('utf8'));
      const validated = validateUserActivationState(state);

      expect(validated.successorHistory).toBeDefined();
      expect(validated.successorHistory!.schemaVersion).toBe(1);
      expect(validated.successorHistory!.snapshotId).toBe('473886bdac05025c72ede1d7ec0bdc854918d6a10d54050b56b95ca34e9f2e89');
      expect(validated.successorHistory!.journalPathParts).toEqual(['governance', 'migration-state.json']);
    });

    it('rejects corrupted or malicious activation state mutations', () => {
      const c = releasedCase('activation-v3-local');
      const f = c.files.find((file) => file.path === 'governance/activation-state.json');
      const baseState = JSON.parse(releasedBytes(f!).toString('utf8'));

      // 1. Wrong schema version
      expect(() => validateUserActivationState({ ...baseState, schemaVersion: 2 })).toThrow(/activationState\.schemaVersion/);

      // 2. Mismatched graph hash
      expect(() => validateUserActivationState({
        ...baseState,
        identity: { ...baseState.identity, phaseGraphHash: validHex64 }
      })).toThrow(/Activation identity tuple is not present/);

      // 3. Unbound local execution repository
      expect(() => validateUserActivationState({
        ...baseState,
        repository: { ...baseState.repository, id: 'unbound' }
      })).toThrow(/immutable local execution anchor/);

      // 4. Malformed remote pushUrl
      expect(() => validateUserActivationState({
        ...baseState,
        remoteBinding: {
          id: 'origin',
          name: 'octo-org/flight-log',
          defaultBranch: 'main',
          pushUrl: 'https://evil.example.com/octo-org/flight-log.git',
          verifiedAt: validIsoDate
        }
      })).toThrow(/credential-free GitHub push destination/);

      // 5. Missing required phase
      const missingPhases = { ...baseState.phases };
      delete missingPhases['committed'];
      expect(() => validateUserActivationState({ ...baseState, phases: missingPhases })).toThrow(/phases\.committed is required/);

      // 6. Invalid phase state
      const invalidPhases = {
        ...baseState.phases,
        committed: { ...baseState.phases.committed, state: 'nonexistent-phase-state' }
      };
      expect(() => validateUserActivationState({ ...baseState, phases: invalidPhases })).toThrow(/phases\.committed\.state/);

      // 7. Non-array evidence
      const nonArrayEvidencePhases = {
        ...baseState.phases,
        committed: { ...baseState.phases.committed, evidence: null }
      };
      expect(() => validateUserActivationState({ ...baseState, phases: nonArrayEvidencePhases })).toThrow(/evidence, approvals, and blockers must be arrays/);
    });
  });

  describe('real released plan and approval evaluation matrix', () => {
    it('evaluates released plan with matching released approval envelope', () => {
      const c = releasedCase('activation-v3-local');
      const fPlan = c.files.find((file) => file.path === 'governance/plans/committed-20260909T000000000Z-46d43ca67021.json');
      const fApproval = c.files.find((file) => file.path === 'governance/approvals/committed-review.json');
      const fState = c.files.find((file) => file.path === 'governance/activation-state.json');

      const plan = JSON.parse(releasedBytes(fPlan!).toString('utf8'));
      const approval = JSON.parse(releasedBytes(fApproval!).toString('utf8'));
      const state = JSON.parse(releasedBytes(fState!).toString('utf8'));

      const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'committed')!;
      const req = approvalRequestForSavedPlan(plan, phase, state);
      expect(req.phaseId).toBe('committed');
      expect(req.gateKind).toBe('repository-publish');

      // Valid within authorization window
      const validNow = new Date('2026-09-09T00:30:00.000Z');
      const evalValid = evaluateApprovalForTransitionPlan(req, [approval], { now: validNow });
      expect(evalValid.status).toBe('reused');
      expect(evalValid.approvalRequired).toBe(false);
      expect(evalValid.envelopeId).toBe('committed-review');
      expect(evalValid.reasons[0]).toContain('covers the requested transition scope');

      // Expired: now > expiresAt
      const expiredNow = new Date('2026-09-10T00:00:00.000Z');
      const evalExpired = evaluateApprovalForTransitionPlan(req, [approval], { now: expiredNow });
      expect(evalExpired.status).toBe('expired');
      expect(evalExpired.approvalRequired).toBe(true);

      // Premature: now < approvedAt
      const prematureNow = new Date('2026-09-08T00:00:00.000Z');
      const evalPremature = evaluateApprovalForTransitionPlan(req, [approval], { now: prematureNow });
      expect(evalPremature.status).toBe('expired');
      expect(evalPremature.reasons[0]).toContain('requires a valid approvedAt <= now < expiresAt interval');

      // No envelopes supplied
      const evalNone = evaluateApprovalForTransitionPlan(req, [], { now: validNow });
      expect(evalNone.status).toBe('approval-required');
      expect(evalNone.reasons[0]).toContain('no approval envelope exists for committed');
    });

    it('computes saved plan authority digest and validates authority operations filtering', () => {
      const c = releasedCase('activation-v3-local');
      const fPlan = c.files.find((file) => file.path === 'governance/plans/committed-20260909T000000000Z-46d43ca67021.json');
      const plan = JSON.parse(releasedBytes(fPlan!).toString('utf8'));
      const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'committed')!;

      const digest = savedPlanAuthorityDigest(plan, phase);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);

      // Verify authorityOperations excludes governance bookkeeping writes
      const ops = [
        { actionId: 'governance.evidence.write', adapter: 'local-evidence' },
        { actionId: 'governance.activation-state.write', adapter: 'local-evidence' },
        { actionId: 'git.commit', adapter: 'git' }
      ];
      const filtered = authorityOperations(ops);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].actionId).toBe('git.commit');
    });
  });

  describe('authority invalidation boundaries', () => {
    const baseEnvelope = {
      id: 'base-env',
      schemaVersion: 3,
      phaseId: 'activation-approved',
      gateKind: 'activation-plan',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [],
      destinations: [],
      permissions: [],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
      policyExceptions: [],
      destructiveScope: [],
      approvedAt: '2026-09-01T10:00:00.000Z',
      expiresAt: '2026-09-10T10:00:00.000Z',
      approver: 'admin-001'
    };

    const baseRequested = {
      scope: 'local',
      phaseId: 'activation-approved',
      gateKind: 'activation-plan',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [],
      destinations: [],
      permissions: [],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
      policyExceptions: [],
      destructiveScope: []
    };

    const evalNow = new Date('2026-09-05T00:00:00.000Z');

    it('invalidates approval when identity differs', () => {
      const env = { ...baseEnvelope, identity: { ...currentActivationIdentity, liftoffVersion: '0.11.0' } };
      const res = evaluateApprovalForTransitionPlan(baseRequested, [env], { now: evalNow });
      expect(res.status).toBe('invalidated');
      expect(res.reasons).toContain('activation identity changed');
    });

    it('invalidates approval when governance execution scope differs', () => {
      const res = evaluateApprovalForTransitionPlan({ ...baseRequested, scope: 'subscription' }, [baseEnvelope], { now: evalNow });
      expect(res.status).toBe('invalidated');
      expect(res.reasons).toContain('governance execution scope changed');
    });

    it('invalidates approval when baseline SHA differs', () => {
      const env = { ...baseEnvelope, baselineSha: validHex64b };
      const res = evaluateApprovalForTransitionPlan(baseRequested, [env], { now: evalNow });
      expect(res.status).toBe('invalidated');
      expect(res.reasons).toContain('baseline SHA changed');
    });

    it('invalidates approval when plan authority digest differs', () => {
      const env = { ...baseEnvelope, planDigest: validHex64b };
      const res = evaluateApprovalForTransitionPlan(baseRequested, [env], { now: evalNow });
      expect(res.status).toBe('invalidated');
      expect(res.reasons).toContain('plan authority digest changed');
    });

    it('handles phase change across matching approval gate kind', () => {
      const env = { ...baseEnvelope, phaseId: 'runner-ready' };
      const res = evaluateApprovalForTransitionPlan(baseRequested, [env], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.reasons.some((r) => r.includes('phase changed from runner-ready to activation-approved'))).toBe(true);
    });
  });

  describe('authority scope expansion boundaries', () => {
    const evalNow = new Date('2026-09-05T00:00:00.000Z');

    const infraEnvelope = {
      id: 'infra-env',
      schemaVersion: 3,
      phaseId: 'bootstrap-local',
      gateKind: 'infrastructure-cost',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [{ type: 'tf-state', identity: 'storage-1' }],
      destinations: [{ type: 'subscription', identity: 'sub-1', repository: null, subscriptionId: 'sub-1' }],
      permissions: ['azure-resource-provision'],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 1000, usageMonthlyCents: 2000 },
      policyExceptions: ['exception-initial'],
      destructiveScope: [],
      approvedAt: '2026-09-01T10:00:00.000Z',
      expiresAt: '2026-09-10T10:00:00.000Z',
      approver: 'admin-001'
    };

    const infraRequested = {
      scope: 'subscription',
      phaseId: 'bootstrap-local',
      gateKind: 'infrastructure-cost',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [{ type: 'tf-state', identity: 'storage-1' }],
      destinations: [{ type: 'subscription', identity: 'sub-1', repository: null, subscriptionId: 'sub-1' }],
      permissions: ['azure-resource-provision'],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 1000, usageMonthlyCents: 2000 },
      policyExceptions: ['exception-initial'],
      destructiveScope: []
    };

    it('detects unapproved resource additions', () => {
      const expanded = {
        ...infraRequested,
        resources: [...infraRequested.resources, { type: 'key-vault', identity: 'kv-secret' }]
      };
      const res = evaluateApprovalForTransitionPlan(expanded, [infraEnvelope], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons[0]).toContain('resource scope expanded');
    });

    it('detects unapproved destination additions', () => {
      const expanded = {
        ...infraRequested,
        destinations: [...infraRequested.destinations, { type: 'local', identity: 'local-repo', repository: null, subscriptionId: null }]
      };
      const res = evaluateApprovalForTransitionPlan(expanded, [infraEnvelope], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons[0]).toContain('destination scope expanded');
    });

    it('detects unapproved permission additions', () => {
      const expanded = {
        ...infraRequested,
        permissions: [...infraRequested.permissions, 'azure-network-provision']
      };
      const res = evaluateApprovalForTransitionPlan(expanded, [infraEnvelope], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons[0]).toContain('permission scope expanded: azure-network-provision');
    });

    it('detects cost currency currency drift', () => {
      const expanded = {
        ...infraRequested,
        costCeiling: { currency: 'EUR', fixedMonthlyCents: 1000, usageMonthlyCents: 2000 }
      };
      const res = evaluateApprovalForTransitionPlan(expanded, [infraEnvelope], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons).toContain('cost currency changed from USD to EUR');
    });

    it('detects increased fixed and usage monthly cost ceilings', () => {
      const expanded = {
        ...infraRequested,
        costCeiling: { currency: 'USD', fixedMonthlyCents: 1500, usageMonthlyCents: 3000 }
      };
      const res = evaluateApprovalForTransitionPlan(expanded, [infraEnvelope], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons.some((r) => r.includes('fixed monthly cost ceiling increased'))).toBe(true);
      expect(res.expansionReasons.some((r) => r.includes('usage monthly cost ceiling increased'))).toBe(true);
    });

    it('detects policy exceptions added to request', () => {
      const expanded = {
        ...infraRequested,
        policyExceptions: ['exception-initial', 'exception-bypass-tls']
      };
      const res = evaluateApprovalForTransitionPlan(expanded, [infraEnvelope], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons).toContain('policy exception added: exception-bypass-tls');
    });

    it('detects destructive scope expansion on destructive-disposal gate', () => {
      const destructiveEnv = {
        ...infraEnvelope,
        gateKind: 'destructive-disposal',
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: [],
        destructiveScope: ['state/bootstrap-arm/old.tfstate']
      };
      const destructiveReq = {
        ...infraRequested,
        gateKind: 'destructive-disposal',
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: [],
        destructiveScope: ['state/bootstrap-arm/old.tfstate', 'state/bootstrap-arm/key.bin']
      };
      const res = evaluateApprovalForTransitionPlan(destructiveReq, [destructiveEnv], { now: evalNow });
      expect(res.status).toBe('approval-required');
      expect(res.expansionReasons).toContain('destructive scope expanded: state/bootstrap-arm/key.bin');
    });
  });

  describe('approval gate invariants and strict authority rules', () => {
    it('rejects gate none requesting cost, policy exceptions, or destructive authority', () => {
      const invalidCost = {
        scope: 'local',
        phaseId: 'seed-valid',
        gateKind: 'none',
        identity: currentActivationIdentity,
        baselineSha: validHex64,
        planDigest: validHex64,
        resources: [], destinations: [], permissions: [],
        costCeiling: { currency: 'USD', fixedMonthlyCents: 10, usageMonthlyCents: 0 },
        policyExceptions: [], destructiveScope: []
      };
      expect(() => determineHumanAuthorityQuestion(normalizeApprovalScope(invalidCost))).toThrow(/Approval gate none cannot request fixed monthly cost authority/);

      const invalidException = {
        ...invalidCost,
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: ['bypass']
      };
      expect(() => determineHumanAuthorityQuestion(normalizeApprovalScope(invalidException))).toThrow(/Approval gate none cannot request policy exception authority/);

      const invalidDestructive = {
        ...invalidCost,
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        destructiveScope: ['erase-everything']
      };
      expect(() => determineHumanAuthorityQuestion(normalizeApprovalScope(invalidDestructive))).toThrow(/Approval gate none cannot request destructive scope authority/);
    });

    it('rejects destructive scope on non-destructive gate', () => {
      const plan = {
        scope: 'local',
        phaseId: 'committed',
        gateKind: 'repository-publish',
        identity: currentActivationIdentity,
        baselineSha: validHex64,
        planDigest: validHex64,
        resources: [], destinations: [], permissions: [],
        costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
        policyExceptions: [],
        destructiveScope: ['delete/data']
      };
      expect(() => determineHumanAuthorityQuestion(normalizeApprovalScope(plan))).toThrow(/Destructive scope requires the destructive-disposal approval gate/);
    });

    it('rejects cost ceilings and policy exceptions on disallowed gates', () => {
      const plan = {
        scope: 'local',
        phaseId: 'committed',
        gateKind: 'repository-publish',
        identity: currentActivationIdentity,
        baselineSha: validHex64,
        planDigest: validHex64,
        resources: [], destinations: [], permissions: [],
        costCeiling: { currency: 'USD', fixedMonthlyCents: 100, usageMonthlyCents: 0 },
        policyExceptions: [],
        destructiveScope: []
      };
      expect(() => determineHumanAuthorityQuestion(normalizeApprovalScope(plan))).toThrow(/require an activation-plan or infrastructure-cost approval gate/);
    });
  });

  describe('governance task projection contracts and audit records', () => {
    it('validates existing task projection contracts and rejects unauthorized targets', () => {
      const validExisting = {
        schemaVersion: 1,
        derivation: 'validated-current-readiness',
        source: 'existing',
        changeId: 'feat-repair-flow',
        workflowKind: 'openspec',
        taskPathParts: ['openspec', 'changes', 'feat-repair-flow', 'tasks.md'],
        metadataPathParts: ['openspec', 'changes', 'feat-repair-flow', 'liftoff-governance.json'],
        metadataHash: validHex64,
        layoutHash: validHex64
      };
      const validated = validateGovernanceTaskProjectionContract(validExisting);
      expect(validated.source).toBe('existing');
      expect(validated.changeId).toBe('feat-repair-flow');

      // Rejects bootstrap or archive targets
      expect(() => validateGovernanceTaskProjectionContract({
        ...validExisting,
        changeId: 'archive',
        taskPathParts: ['openspec', 'changes', 'archive', 'tasks.md'],
        metadataPathParts: ['openspec', 'changes', 'archive', 'liftoff-governance.json']
      })).toThrow(/cannot target seed tasks or an archive/);

      expect(() => validateGovernanceTaskProjectionContract({
        ...validExisting,
        changeId: 'bootstrap-import',
        taskPathParts: ['openspec', 'changes', 'bootstrap-import', 'tasks.md'],
        metadataPathParts: ['openspec', 'changes', 'bootstrap-import', 'liftoff-governance.json']
      })).toThrow(/cannot target seed tasks or an archive/);

      // Rejects invalid derivation
      expect(() => validateGovernanceTaskProjectionContract({
        ...validExisting,
        derivation: 'arbitrary-derivation'
      })).toThrow(/bounded current-readiness derivation/);
    });

    it('validates creation task projection contracts and enforces byte bounds and hash binding', () => {
      const metaText = '{"policy": "strict"}';
      const metaHash = createHash('sha256').update(metaText).digest('hex');

      const validCreate = {
        schemaVersion: 1,
        derivation: 'validated-current-readiness',
        source: 'create',
        changeId: 'feat-new-workflow',
        workflowKind: 'openspec',
        taskPathParts: ['openspec', 'changes', 'feat-new-workflow', 'tasks.md'],
        metadataPathParts: ['openspec', 'changes', 'feat-new-workflow', 'liftoff-governance.json'],
        metadataHash: metaHash,
        layoutHash: validHex64,
        template: '{"tasks": []}',
        metadataText: metaText
      };
      const validated = validateGovernanceTaskProjectionContract(validCreate);
      expect(validated.source).toBe('create');
      expect(validated.metadataHash).toBe(metaHash);

      // Rejects hash mismatch
      expect(() => validateGovernanceTaskProjectionContract({
        ...validCreate,
        metadataHash: validHex64
      })).toThrow(/inconsistently bound creation sources/);
    });

    it('validates governance task projection records in both blocked and complete states', () => {
      // 1. Blocked record
      const validBlocked = {
        schemaVersion: 1,
        purpose: 'projection-audit-only',
        phaseId: 'seed-valid',
        planDigest: validHex64,
        contractDigest: validHex64,
        taskPathParts: ['openspec', 'changes', 'feat-work', 'tasks.md'],
        metadataHash: validHex64,
        layoutHash: validHex64,
        status: 'blocked',
        observedAt: validIsoDate,
        beforeHash: null,
        afterHash: null,
        states: null,
        blockers: ['reviewer approval required']
      };
      const blocked = validateGovernanceTaskProjectionRecord(validBlocked);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockers).toHaveLength(1);

      // 2. Complete record
      const phaseStatesMap = Object.fromEntries(phaseIds.map((id) => [id, 'verified']));
      const validComplete = {
        schemaVersion: 1,
        purpose: 'projection-audit-only',
        phaseId: 'seed-valid',
        planDigest: validHex64,
        contractDigest: validHex64,
        taskPathParts: ['openspec', 'changes', 'feat-work', 'tasks.md'],
        metadataHash: validHex64,
        layoutHash: validHex64,
        status: 'complete',
        observedAt: validIsoDate,
        beforeHash: validHex64,
        afterHash: validHex64b,
        states: phaseStatesMap,
        blockers: []
      };
      const complete = validateGovernanceTaskProjectionRecord(validComplete);
      expect(complete.status).toBe('complete');
      expect(complete.afterHash).toBe(validHex64b);

      // 3. Rejects illegal combinations
      expect(() => validateGovernanceTaskProjectionRecord({
        ...validBlocked,
        status: 'complete' // complete without states or afterHash
      })).toThrow(/must distinguish completed projection from blocked/);

      expect(() => validateGovernanceTaskProjectionRecord({
        ...validBlocked,
        purpose: 'execution-authority'
      })).toThrow(/is not execution authority/);
    });
  });

  describe('canonical phase graph assertions and destinations', () => {
    it('asserts canonical phase graph structural validity', () => {
      expect(() => assertCanonicalGraphValid()).not.toThrow();
    });

    it('derives destinations for phases correctly across local, repository, and subscription mutations', () => {
      const phasePushed = canonicalPhaseGraph.phases.find((p) => p.id === 'pushed')!;
      const phaseBootstrap = canonicalPhaseGraph.phases.find((p) => p.id === 'bootstrap-local')!;

      const mockState = {
        identity: currentActivationIdentity,
        repository: { id: 'local-repo-01', name: 'octo-org/flight-log', defaultBranch: 'main' },
        activationInputs: { azure: { subscriptionId: '11111111-2222-3333-4444-555555555555' } }
      };

      const planPushed = transitionPlanForPhase(phasePushed, mockState as any, {
        phaseId: phasePushed.id,
        baselineSha: validHex64,
        inputDigest: validHex64,
        transitionDigest: validHex64
      });
      expect(planPushed.destinations.some((d: any) => d.type === 'repository')).toBe(true);

      const planBootstrap = transitionPlanForPhase(phaseBootstrap, mockState as any, {
        phaseId: phaseBootstrap.id,
        baselineSha: validHex64,
        inputDigest: validHex64,
        transitionDigest: validHex64
      });
      expect(planBootstrap.destinations.some((d: any) => d.type === 'subscription')).toBe(true);
    });
  });
});
