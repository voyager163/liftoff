import { describe, expect, it } from 'vitest';
import {
  activationCompatibility,
  activationCompatibilityKey,
  activationContractVersion,
  activationStateSchemaVersion,
  approvalEnvelopeSchemaVersion,
  calculatePhaseReadiness,
  canonicalPhaseContractDigests,
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  canonicalSha256,
  createActivationIdentity,
  credentialPolicySchemaVersion,
  currentActivationIdentity,
  evidenceContextForPhase,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  liftoffManifestArtifactVersion,
  phaseGraphSchemaVersion,
  phaseIds,
  resolveActivationCompatibility,
  supersessionSchemaVersion,
  transitionPlanForPhase,
  validateApprovalEnvelope,
  validateCredentialPolicy,
  validateEvidenceHeader,
  validateManagedPhaseGraph,
  validateReleaseIntegrity,
  validateSupersessionRecord,
  validateUserActivationState
} from '../src/governance-activation/index.js';
import type {
  ApprovalEnvelope,
  CredentialPolicy,
  EvidenceHeader,
  ManagedPhaseGraph,
  PhaseId,
  PhaseState,
  UserActivationState
} from '../src/governance-activation/index.js';

const digest = 'a'.repeat(64);
const later = '2030-01-01T00:00:00.000Z';
const now = new Date('2026-09-04T00:00:00.000Z');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validState(overrides: Partial<UserActivationState> = {}): UserActivationState {
  const phases = Object.fromEntries(phaseIds.map((id) => [id, {
    state: 'pending',
    updatedAt: '2026-09-04T00:00:00.000Z',
    evidence: [],
    approvals: [],
    blockers: []
  }])) as UserActivationState['phases'];
  return {
    schemaVersion: activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      name: 'owner/repo',
      defaultBranch: 'main'
    },
    activeChange: {
      id: 'governance-activation',
      kind: 'openspec'
    },
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: true,
      credentialRequired: true
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  };
}

function evidence(phaseId: PhaseId, result: EvidenceHeader['result'] = 'verified'): EvidenceHeader {
  const context = evidenceContextForPhase(phaseId);
  return {
    schemaVersion: evidenceHeaderSchemaVersion,
    repositoryId: context.repositoryId,
    identity: context.identity,
    phaseGraphHash: context.phaseGraphHash,
    phaseId,
    phaseContractDigest: context.phaseContractDigest,
    inputDigest: context.inputDigest,
    baselineSha: context.baselineSha,
    transition: context.transition,
    producedAt: '2026-09-04T00:00:00.000Z',
    producer: 'vitest',
    result
  };
}

function approval(phaseId: PhaseId): ApprovalEnvelope {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const state = validState();
  const context = evidenceContextForPhase(phaseId, {
    repositoryId: state.repository.id,
    identity: currentActivationIdentity,
    phaseGraphHash: currentActivationIdentity.phaseGraphHash
  });
  const plan = transitionPlanForPhase(phase, state, context.transition);
  return {
    schemaVersion: approvalEnvelopeSchemaVersion,
    id: `${phaseId}-approval`,
    ...plan,
    expiresAt: later,
    approvedAt: '2026-09-04T00:00:00.000Z',
    approver: 'owner'
  };
}

function credentialPolicy(): CredentialPolicy {
  const createdAt = '2026-09-04T00:00:00.000Z';
  const expiresAt = '2026-10-04T00:00:00.000Z';
  return {
    schemaVersion: credentialPolicySchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      owner: 'owner',
      name: 'repo',
      fullName: 'owner/repo'
    },
    owner: 'owner',
    authKind: 'fine-grained-pat',
    displayNameTemplate: '<repo>-runner-preflight-read',
    displayName: 'repo-runner-preflight-read',
    secretName: 'RUNNER_CONFIGURATION_READ_TOKEN',
    createdAt,
    expiresAt,
    rotationLeadDays: 7,
    rotationDueAt: '2026-09-27T00:00:00.000Z',
    permissions: {
      repository: ['metadata:read'],
      organization: ['hosted-runners:read', 'network-configurations:read']
    },
    allowedWorkflows: [{ path: '.github/workflows/preflight.yml', jobs: ['runner-preflight'] }],
    nonForwarding: true,
    status: 'active',
    proof: {
      verifiedAt: createdAt,
      readbackDigest: digest,
      readbackProvider: 'adapter-fixture',
      payloadFree: true
    },
    app: null,
    pat: {
      lifetimeDays: 30,
      selectedRepositoryOnly: true,
      createdBy: 'manual-masked-entry'
    }
  };
}

describe('activation identity compatibility', () => {
  it('exports the target version vector and resolves only explicit tuples', () => {
    expect(liftoffActivationPackageVersion).toBe('0.10.0');
    expect(liftoffManifestArtifactVersion).toBe(7);
    expect(governanceActivationPolicyVersion).toBe('6');
    expect(activationContractVersion).toBe(1);
    expect(phaseGraphSchemaVersion).toBe(1);
    expect(activationStateSchemaVersion).toBe(1);
    expect(evidenceHeaderSchemaVersion).toBe(1);
    expect(approvalEnvelopeSchemaVersion).toBe(1);
    expect(supersessionSchemaVersion).toBe(1);
    expect(credentialPolicySchemaVersion).toBe(1);
    expect(activationCompatibility.has(activationCompatibilityKey(currentActivationIdentity))).toBe(true);
    expect(resolveActivationCompatibility(currentActivationIdentity, activationCompatibility))
      .toMatchObject({ compatible: true });

    const individuallyKnownUnsupported = {
      ...currentActivationIdentity,
      policyVersion: '5'
    };
    expect(resolveActivationCompatibility(individuallyKnownUnsupported, activationCompatibility))
      .toMatchObject({
        compatible: false,
        reason: expect.stringContaining('explicit compatibility map')
      });
  });
});

describe('managed graph and artifact schemas', () => {
  it('accepts canonical v1 fixtures and rejects unknown, missing, enum, and future fields', () => {
    expect(() => validateManagedPhaseGraph(canonicalPhaseGraph)).not.toThrow();
    expect(() => validateUserActivationState(validState())).not.toThrow();
    expect(() => validateEvidenceHeader(evidence('seed-valid'))).not.toThrow();
    expect(() => validateApprovalEnvelope(approval('committed'))).not.toThrow();
    expect(() => validateSupersessionRecord({
      schemaVersion: supersessionSchemaVersion,
      identity: currentActivationIdentity,
      supersededChangeId: 'old-change',
      supersedingChangeId: 'new-change',
      reason: 'explicit owner choice',
      approvedAt: '2026-09-04T00:00:00.000Z',
      approver: 'owner'
    })).not.toThrow();
    expect(() => validateCredentialPolicy(credentialPolicy())).not.toThrow();

    const extraGraph = clone(canonicalPhaseGraph) as ManagedPhaseGraph & { extra: true };
    extraGraph.extra = true;
    expect(() => validateManagedPhaseGraph(extraGraph)).toThrow(/not allowed/);

    const missingState = clone(validState()) as Record<string, unknown>;
    delete missingState.repository;
    expect(() => validateUserActivationState(missingState)).toThrow(/repository is required/);

    const badEnum = clone(validState()) as UserActivationState;
    badEnum.phases['seed-valid'].state = 'done' as PhaseState;
    expect(() => validateUserActivationState(badEnum)).toThrow(/unsupported value/);

    const disposedWithoutTimestamp = clone(validState());
    disposedWithoutTimestamp.bootstrapState = {
      status: 'disposed',
      remoteImportEvidenceId: 'remote-import',
      remoteImportEvidenceDigest: digest,
      retainedAt: '2026-09-04T00:00:00.000Z',
      disposeAfter: '2026-10-04T00:00:00.000Z',
      encryptedStatePathParts: [['infrastructure', 'bootstrap.tfstate.enc']],
      encryptionKeyPathParts: [['infrastructure', 'bootstrap.key']]
    };
    expect(() => validateUserActivationState(disposedWithoutTimestamp))
      .toThrow(/disposedAt is required/);

    const futureEvidence = clone(evidence('seed-valid')) as EvidenceHeader;
    futureEvidence.schemaVersion = 2;
    expect(() => validateEvidenceHeader(futureEvidence)).toThrow(/schemaVersion/);
  });

  it('rejects graph dependency reversals, missing canonical dependencies, and cycles', () => {
    const graph = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    expect(() => validateManagedPhaseGraph(graph)).not.toThrow();

    const reversed = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    const runner = reversed.phases.find((phase) => phase.id === 'runner-ready')!;
    runner.dependencies = [{ anyOf: ['private-backend-proof'], accepts: ['verified'], description: 'reversed' }];
    expect(() => validateManagedPhaseGraph(reversed)).toThrow(/Reversed dependency order/);

    const missingRunner = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    const proof = missingRunner.phases.find((phase) => phase.id === 'private-backend-proof')!;
    proof.dependencies = [];
    expect(() => validateManagedPhaseGraph(missingRunner)).toThrow(/runner-ready/);

    const cycle = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    const seed = cycle.phases.find((phase) => phase.id === 'seed-valid')!;
    seed.dependencies = [{ anyOf: ['bootstrap-state-disposed'], accepts: ['disposed'], description: 'cycle' }];
    expect(() => validateManagedPhaseGraph(cycle)).toThrow(/Reversed dependency order|Cycle/);
  });
});

describe('canonical graph hashes and release integrity', () => {
  it('generates stable graph and phase contract digests', () => {
    expect(canonicalPhaseGraphHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(canonicalPhaseContractDigests)).toHaveLength(phaseIds.length);
    for (const phaseId of phaseIds) {
      expect(canonicalPhaseContractDigests[phaseId]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('distinguishes wrapper-only graph bytes from behavioral contract drift', () => {
    const wrapperOnly = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    const seed = wrapperOnly.phases.find((phase) => phase.id === 'seed-valid')!;
    seed.label = `${seed.label}.`;
    const wrapperHash = canonicalSha256(wrapperOnly);
    const mappedIdentity = createActivationIdentity(wrapperHash);

    expect(() => validateReleaseIntegrity({
      previousGraph: canonicalPhaseGraph,
      currentGraph: wrapperOnly,
      previousIdentity: currentActivationIdentity,
      currentIdentity: mappedIdentity,
      compatibleGraphHashes: new Map()
    })).toThrow(/compatible hash mapping/);

    expect(() => validateReleaseIntegrity({
      previousGraph: canonicalPhaseGraph,
      currentGraph: wrapperOnly,
      previousIdentity: currentActivationIdentity,
      currentIdentity: mappedIdentity,
      compatibleGraphHashes: new Map([[canonicalPhaseGraphHash, wrapperHash]])
    })).not.toThrow();

    expect(() => validateReleaseIntegrity({
      previousGraph: canonicalPhaseGraph,
      currentGraph: wrapperOnly,
      previousIdentity: currentActivationIdentity,
      currentIdentity: { ...mappedIdentity, setupSkillVersion: '1' },
      compatibleGraphHashes: new Map([[canonicalPhaseGraphHash, wrapperHash]])
    })).toThrow(/independent skill version/);

    const semantic = clone(canonicalPhaseGraph) as ManagedPhaseGraph;
    semantic.phases.find((phase) => phase.id === 'seed-valid')!
      .allowedMutations.local = ['read-worktree', 'write-evidence', 'write-workflows'];
    expect(() => validateReleaseIntegrity({
      previousGraph: canonicalPhaseGraph,
      currentGraph: semantic,
      previousIdentity: currentActivationIdentity,
      currentIdentity: createActivationIdentity(canonicalSha256(semantic)),
      compatibleGraphHashes: new Map()
    })).toThrow(/activation-contract bump/);
  });
});

describe('phase readiness calculation', () => {
  it('reports ready, blocked, verified, failed, inapplicable, and identity-incompatible states', () => {
    const initial = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: [],
      now
    });
    expect(initial.phases['seed-valid'].state).toBe('ready');
    expect(initial.phases['seed-verified'].state).toBe('blocked');
    expect(initial.nextReadyPhase).toBe('seed-valid');

    const seedVerified = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: [evidence('seed-valid')],
      now
    });
    expect(seedVerified.phases['seed-valid'].state).toBe('verified');
    expect(seedVerified.phases['seed-verified'].state).toBe('ready');

    const failed = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: [evidence('seed-valid', 'failed')],
      now
    });
    expect(failed.phases['seed-valid'].state).toBe('failed');
    expect(failed.phases['seed-verified'].state).toBe('blocked');

    const inapplicable = calculatePhaseReadiness({
      state: validState({
        applicability: {
          statePath: 'existing-private',
          privateStagingDast: true,
          credentialRequired: false
        }
      }),
      approvals: [],
      evidence: [],
      now
    });
    expect(inapplicable.phases['credential-ready'].state).toBe('inapplicable');
    expect(inapplicable.phases['bootstrap-local'].state).toBe('inapplicable');

    const incompatible = calculatePhaseReadiness({
      state: validState(),
      identity: { ...currentActivationIdentity, policyVersion: '5' },
      approvals: [],
      evidence: [],
      now
    });
    expect(incompatible.identityCompatible).toBe(false);
    expect(incompatible.phases['seed-valid'].state).toBe('identity-incompatible');
  });

  it('does not let downstream evidence bypass a newly blocked dependency', () => {
    const result = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: [
        evidence('seed-valid'),
        evidence('seed-verified'),
        evidence('seed-archived'),
        evidence('committed'),
        evidence('pushed')
      ],
      phaseBlockers: {
        'seed-archived': ['Archived seed main capability is invalid.']
      },
      now
    });

    expect(result.phases['seed-archived']).toMatchObject({
      state: 'blocked',
      blockers: ['Archived seed main capability is invalid.']
    });
    expect(result.phases.committed.state).toBe('blocked');
    expect(result.phases.pushed.state).toBe('blocked');
    expect(result.phases['phase-0-complete'].state).toBe('blocked');
    expect(result.nextReadyPhase).toBeNull();
  });

  it('requires approval gates before readiness can advance protected phases', () => {
    const priorEvidence: EvidenceHeader[] = [
      evidence('seed-valid'),
      evidence('seed-verified'),
      evidence('seed-archived')
    ];
    const blocked = calculatePhaseReadiness({
      state: validState(),
      approvals: [],
      evidence: priorEvidence,
      now
    });
    expect(blocked.phases.committed.state).toBe('blocked');
    expect(blocked.phases.committed.blockers[0]).toContain('repository-publish');

    const ready = calculatePhaseReadiness({
      state: validState(),
      approvals: [approval('committed')],
      evidence: priorEvidence,
      now
    });
    expect(ready.phases.committed.state).toBe('ready');
  });
});
