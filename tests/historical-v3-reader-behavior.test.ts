import { describe, expect, it } from 'vitest';
import {
  validateApprovalEnvelope as validateCurrentApprovalEnvelope,
  validateSavedTransitionPlan as validateCurrentSavedTransitionPlan
} from '../src/domain/governance/activation/validators.js';
import { releasedBytes, releasedCase } from './fixtures/released-baseline/corpus.js';

// Synthetic schema cases supplement original release bytes, never current execution authority.
const legacyRoot = new URL('../assets/governance/single-maintainer-gitflow/activation-v3-reader/domain/governance/activation/', import.meta.url);

const validHex64 = 'a'.repeat(64);
const validIsoDate = '2026-09-01T12:00:00.000Z';

describe('historical v3 reader validators behavior', async () => {
  const {
    validateActivationConfiguration,
    validateActivationIdentity,
    validateReadableActivationIdentity,
    validateEvidenceHeader,
    validateApprovalEnvelope,
    validateSavedTransitionPlan,
    validateUserActivationState,
    validateCredentialPolicy,
    validateLiveReadbackProof,
    validateGovernanceTaskProjectionContract,
    validateGovernanceTaskProjectionRecord,
    validateSupersessionRecord,
    validateGraphReconciliationRecord
  } = await import(new URL('validators.js', legacyRoot).href);

  const {
    currentActivationIdentity,
    canonicalPhaseGraph,
    canonicalPhaseGraphHash,
    phaseContractDigest
  } = await import(new URL('graph.js', legacyRoot).href);

  const {
    runnerPreflightDisplayNameTemplate,
    runnerPreflightSecretName,
    runnerPreflightRotationLeadDays,
    runnerPreflightRepositoryPermissions,
    runnerPreflightOrganizationPermissions,
    runnerPreflightPatLifetimeDays
  } = await import(new URL('types.js', legacyRoot).href);

  it('reads original released approvals and plans without promoting or retagging them', () => {
    const records = releasedCase('activation-v3-local').files.filter((file) =>
      /^governance\/(?:approvals|plans)\/[^/]+\.json$/u.test(file.path));
    expect(records.some((file) => file.path.startsWith('governance/approvals/'))).toBe(true);
    expect(records.some((file) => file.path.startsWith('governance/plans/'))).toBe(true);
    for (const file of records) {
      const bytes = releasedBytes(file);
      const original = JSON.parse(bytes.toString('utf8'));
      const before = structuredClone(original);
      if (file.path.startsWith('governance/approvals/')) {
        expect(validateApprovalEnvelope(original)).toEqual(before);
        expect(() => validateCurrentApprovalEnvelope(original)).toThrow();
      } else {
        expect(validateSavedTransitionPlan(original)).toEqual(before);
        expect(() => validateCurrentSavedTransitionPlan(original)).toThrow();
      }
      expect(original).toEqual(before);
      expect(releasedBytes(file)).toEqual(bytes);
    }
  });

  it('validates publicJson and activation configuration across valid inputs', () => {
    const config = {
      schemaVersion: 1,
      phases: {
        'seed-valid': { enabled: true, count: 5 }
      },
      repository: {
        name: 'test-org/flight-log',
        defaultBranch: 'main',
        visibility: 'private',
        create: true
      },
      azure: {
        subscriptionId: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
        region: 'eastus'
      },
      budget: {
        currency: 'USD',
        fixedMonthlyCents: 1000,
        usageMonthlyCents: 5000
      }
    };

    const validated = validateActivationConfiguration(config);
    expect(validated.schemaVersion).toBe(1);
    expect(validated.repository?.name).toBe('test-org/flight-log');
    expect(validated.repository?.visibility).toBe('private');
    expect(validated.azure?.region).toBe('eastus');
  });

  it('rejects forbidden credential strings and illegal keys in publicJson', () => {
    // String containing credential pattern
    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {
        'seed-valid': { customNote: 'ghp_' + 'a'.repeat(36) }
      }
    })).toThrow(/contains credential material/);

    // Private key in string
    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {
        'seed-valid': { customNote: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' }
      }
    })).toThrow(/contains credential material/);

    // Forbidden keys like password, secret, __proto__
    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {
        'seed-valid': { password: 'plaintext-secret' }
      }
    })).toThrow(/password is not permitted/);

    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {
        'seed-valid': { secret: 'my-secret' }
      }
    })).toThrow(/secret is not permitted/);

    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {
        'seed-valid': { clientSecret: 'my-client-secret' }
      }
    })).toThrow(/clientSecret is not permitted/);
  });

  it('admits valid GitHub app installation token metadata in publicJson', () => {
    const configWithAppToken = {
      schemaVersion: 1,
      phases: {
        'seed-valid': {
          token: {
            generatedBy: 'github-app',
            strategy: 'installation-token',
            ttlSeconds: 3600
          }
        }
      }
    };

    const validated = validateActivationConfiguration(configWithAppToken);
    expect(validated.phases['seed-valid'].token.generatedBy).toBe('github-app');
  });

  it('rejects invalid repository name, unsafe branch names, or unsupported visibility', () => {
    // Malformed repo name
    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {},
      repository: { name: 'not-owner-slash-repo' }
    })).toThrow(/must be owner\/repository/);

    // Unsafe branch name with traversal or .lock
    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {},
      repository: { name: 'owner/repo', defaultBranch: 'feature/../main' }
    })).toThrow(/must be a safe Git branch name/);

    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {},
      repository: { name: 'owner/repo', defaultBranch: 'main.lock' }
    })).toThrow(/must be a safe Git branch name/);

    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {},
      repository: { name: 'owner/repo', defaultBranch: 'feature/' }
    })).toThrow(/must be a safe Git branch name/);

    // Unsupported visibility
    expect(() => validateActivationConfiguration({
      schemaVersion: 1,
      phases: {},
      repository: { name: 'owner/repo', visibility: 'internal' }
    })).toThrow(/unsupported value "internal"/);
  });

  it('validates readable historical identities without retagging vectors', () => {
    const v3Identity = currentActivationIdentity;
    const v3 = validateReadableActivationIdentity(v3Identity);
    expect(v3.liftoffVersion).toBe('0.12.0');
    expect(v3.manifestArtifactVersion).toBe(7);
    expect(v3.policyVersion).toBe('6');

    // Incompatible identity rejected by validateActivationIdentity
    const incompatible = {
      ...v3Identity,
      policyVersion: '999'
    };
    expect(() => validateActivationIdentity(incompatible)).toThrow();
  });

  it('validates evidence headers and enforces bounds and outcomes', () => {
    const seedPhase = canonicalPhaseGraph.phases.find((p: any) => p.id === 'seed-valid');
    const contractDigest = phaseContractDigest(seedPhase);

    const validHeader = {
      schemaVersion: 3,
      repositoryId: 'local:repo-001',
      identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash,
      phaseId: 'seed-valid',
      phaseContractDigest: contractDigest,
      inputDigest: validHex64,
      baselineSha: validHex64,
      transition: {
        phaseId: 'seed-valid',
        baselineSha: validHex64,
        inputDigest: validHex64,
        transitionDigest: validHex64
      },
      producedAt: validIsoDate,
      producer: 'openspec.seed.validate',
      bodyDigest: validHex64,
      result: 'verified'
    };

    const header = validateEvidenceHeader(validHeader);
    expect(header.phaseId).toBe('seed-valid');
    expect(header.result).toBe('verified');

    // Invalid result outcome
    expect(() => validateEvidenceHeader({
      ...validHeader,
      result: 'pending'
    })).toThrow(/contains unsupported value "pending"/);

    // Malformed digest
    expect(() => validateEvidenceHeader({ ...validHeader, inputDigest: 'not-hex' })).toThrow(/must be a SHA-256 hex digest/);
  });

  it('validates approval envelope normalization and rejects duplicates or invalid formats', () => {
    const validEnvelope = {
      schemaVersion: 3,
      id: validHex64,
      identity: currentActivationIdentity,
      approver: 'admin-001',
      scope: 'activation',
      phaseId: 'activation-approved',
      coveredPhases: ['activation-approved'],
      gateKind: 'activation-plan',
      baselineSha: validHex64,
      planDigest: validHex64,
      approvedAt: validIsoDate,
      expiresAt: '2026-09-02T12:00:00.000Z',
      resources: [
        { type: 'file', identity: 'openspec.yaml' },
        { type: 'file', identity: 'specs/spec.md' }
      ],
      destinations: [
        { type: 'local', identity: 'repo-root', repository: null, subscriptionId: null }
      ],
      permissions: ['read-worktree'],
      costCeiling: {
        currency: 'USD',
        fixedMonthlyCents: 0,
        usageMonthlyCents: 0
      },
      policyExceptions: [],
      destructiveScope: []
    };

    const envelope = validateApprovalEnvelope(validEnvelope);
    expect(envelope.schemaVersion).toBe(3);
    expect(envelope.resources).toHaveLength(2);

    // Duplicate resource rejected
    expect(() => validateApprovalEnvelope({
      ...validEnvelope,
      resources: [
        { type: 'file', identity: 'same.txt' },
        { type: 'file', identity: 'same.txt' }
      ]
    })).toThrow(/duplicate/);

    // Invalid currency code rejected
    expect(() => validateApprovalEnvelope({
      ...validEnvelope,
      costCeiling: { currency: 'us-dollar', fixedMonthlyCents: 0, usageMonthlyCents: 0 }
    })).toThrow(/three-letter uppercase ISO currency code/);

    // Negative cost rejected
    expect(() => validateApprovalEnvelope({
      ...validEnvelope,
      costCeiling: { currency: 'USD', fixedMonthlyCents: -100, usageMonthlyCents: 0 }
    })).toThrow(/non-negative safe integer/);
  });

  it('validates live readback proof providers and credential policy', () => {
    const validProof = {
      schemaVersion: 3,
      repositoryId: 'local:repo-001',
      identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash,
      phaseId: 'seed-valid',
      baselineSha: validHex64,
      inputDigest: validHex64,
      transition: {
        phaseId: 'seed-valid',
        baselineSha: validHex64,
        inputDigest: validHex64,
        transitionDigest: validHex64
      },
      observedAt: validIsoDate,
      provider: 'github',
      resourceType: 'repository-ruleset',
      resourceId: 'ruleset-42',
      sourceDigest: validHex64,
      readbackDigest: validHex64,
      matches: true
    };
    expect(validateLiveReadbackProof(validProof).provider).toBe('github');

    expect(() => validateLiveReadbackProof({ ...validProof, provider: 'aws' })).toThrow(/unsupported value "aws"/);

    // Credential policy validation
    const validCredPolicy = {
      schemaVersion: 1,
      identity: currentActivationIdentity,
      repository: { id: 'R_repo', owner: 'octo-org', name: 'liftoff', fullName: 'octo-org/liftoff' },
      owner: 'octo-org',
      authKind: 'fine-grained-pat',
      displayNameTemplate: runnerPreflightDisplayNameTemplate,
      displayName: 'liftoff-runner-preflight-read',
      secretName: runnerPreflightSecretName,
      createdAt: validIsoDate,
      expiresAt: '2026-10-01T12:00:00.000Z',
      rotationLeadDays: runnerPreflightRotationLeadDays,
      rotationDueAt: new Date(Date.parse('2026-10-01T12:00:00.000Z') - runnerPreflightRotationLeadDays * 24 * 60 * 60 * 1000).toISOString(),
      permissions: {
        organization: runnerPreflightOrganizationPermissions,
        repository: runnerPreflightRepositoryPermissions
      },
      allowedWorkflows: [
        { path: '.github/workflows/bootstrap-import-preflight.yml', jobs: ['bootstrap-import-preflight'] }
      ],
      nonForwarding: true,
      status: 'active',
      proof: {
        verifiedAt: validIsoDate,
        readbackDigest: validHex64,
        readbackProvider: 'github-api',
        payloadFree: true
      },
      app: null,
      pat: {
        lifetimeDays: runnerPreflightPatLifetimeDays,
        selectedRepositoryOnly: true,
        createdBy: 'manual-masked-entry'
      }
    };
    const cp = validateCredentialPolicy(validCredPolicy);
    expect(cp.secretName).toBe(runnerPreflightSecretName);
    expect(cp.authKind).toBe('fine-grained-pat');

    expect(() => validateCredentialPolicy({ ...validCredPolicy, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateCredentialPolicy({ ...validCredPolicy, rotationLeadDays: 999 })).toThrow(/rotationLeadDays/);
  });

  it('validates saved transition plans, supersession, and reconciliation records', () => {
    const validPlan = {
      schemaVersion: 2,
      scope: 'local',
      phaseId: 'seed-valid',
      createdAt: validIsoDate,
      expiresAt: '2026-09-02T12:00:00.000Z',
      identity: currentActivationIdentity,
      graphHash: canonicalPhaseGraphHash,
      stateHash: validHex64,
      baselineDigest: validHex64,
      inputDigest: validHex64,
      transitionDigest: validHex64,
      planDigest: validHex64,
      mutationClasses: { local: ['read-worktree'], remote: [] },
      operations: [
        {
          adapter: 'selected-spec-workflow',
          actionId: 'openspec.seed.validate',
          mutationClass: 'read-worktree',
          phaseId: 'seed-valid',
          inputs: {},
          destination: { type: 'local', identity: 'repo-root' },
          remote: false,
          destructive: false
        }
      ],
      approval: {
        gateKind: 'none',
        required: false,
        evaluation: {
          phaseId: 'seed-valid',
          gateKind: 'none',
          questionKind: null,
          approvalRequired: false,
          status: 'not-required',
          envelopeId: null,
          envelopeHash: null,
          reasons: [],
          expansionReasons: []
        },
        envelopeId: null,
        envelopeHash: null
      },
      rollbackPlan: {
        phaseId: 'seed-valid',
        strategy: 'none',
        target: null,
        operations: [],
        retained: [],
        cleanupWarnings: []
      },
      noSecrets: true
    };

    const plan = validateSavedTransitionPlan(validPlan);
    expect(plan.phaseId).toBe('seed-valid');
    expect(plan.schemaVersion).toBe(2);

    // Supersession record
    const validSuper = {
      schemaVersion: 1,
      identity: currentActivationIdentity,
      supersededChangeId: 'change-001',
      supersedingChangeId: 'change-002',
      reason: 'superseded by clean v4 transition',
      approvedAt: validIsoDate,
      approver: 'admin-001'
    };
    expect(validateSupersessionRecord(validSuper).reason).toContain('clean v4');

    // Graph reconciliation record
    const validReconcile = {
      schemaVersion: 3,
      fromGraphHash: canonicalPhaseGraphHash,
      toGraphHash: canonicalPhaseGraphHash,
      fromIdentity: currentActivationIdentity,
      toIdentity: currentActivationIdentity,
      phaseMappings: canonicalPhaseGraph.phases.map((p) => ({
        phaseId: p.id,
        fromContractDigest: validHex64,
        toContractDigest: validHex64,
        preserveEvidence: true
      })),
      reconciledAt: validIsoDate,
      producer: 'reconciliation-worker'
    };
    expect(validateGraphReconciliationRecord(validReconcile).producer).toBe('reconciliation-worker');
  });
});

describe('historical v3 reader approvals behavior', async () => {
  const {
    normalizeApprovalCostCeiling,
    normalizeApprovalDestinations,
    normalizeApprovalResources,
    normalizeApprovalScope,
    canonicalApprovalEnvelopeScope,
    canonicalApprovalEnvelopeHash,
    questionKindForApprovalGate,
    determineHumanAuthorityQuestion,
    transitionAuthorityDigest,
    authorityOperations,
    combineApprovalRequests
  } = await import(new URL('approvals.js', legacyRoot).href);

  const {
    currentActivationIdentity
  } = await import(new URL('graph.js', legacyRoot).href);

  const validHex64 = 'b'.repeat(64);

  it('normalizes cost ceilings and rejects invalid currencies or non-integers', () => {
    expect(normalizeApprovalCostCeiling({
      currency: 'USD',
      fixedMonthlyCents: 500,
      usageMonthlyCents: 1500
    })).toEqual({
      currency: 'USD',
      fixedMonthlyCents: 500,
      usageMonthlyCents: 1500
    });

    expect(() => normalizeApprovalCostCeiling({ currency: 'usd', fixedMonthlyCents: 0, usageMonthlyCents: 0 })).toThrow(/three-letter uppercase/);
    expect(() => normalizeApprovalCostCeiling({ currency: 'EUR', fixedMonthlyCents: 10.5, usageMonthlyCents: 0 })).toThrow(/safe integer/);
    expect(() => normalizeApprovalCostCeiling({ currency: 'EUR', fixedMonthlyCents: 0, usageMonthlyCents: -5 })).toThrow(/non-negative/);
  });

  it('normalizes destinations across subscription, repository, and local types', () => {
    const destinations = [
      { type: 'subscription', identity: 'sub-1', repository: null, subscriptionId: 'sub-1' },
      { type: 'repository', identity: 'org/repo', repository: 'org/repo', subscriptionId: null },
      { type: 'local', identity: 'project', repository: null, subscriptionId: null }
    ];

    const normalized = normalizeApprovalDestinations(destinations);
    expect(normalized).toHaveLength(3);

    // Duplicate destination throws
    expect(() => normalizeApprovalDestinations([...destinations, destinations[0]])).toThrow(/duplicate/);

    // Unsupported type throws
    expect(() => normalizeApprovalDestinations([{ type: 'cloud-bucket', identity: 'b1' } as any])).toThrow(/unsupported value "cloud-bucket"/);
  });

  it('computes canonical approval envelope hash deterministically', () => {
    const scope = normalizeApprovalScope({
      scope: 'local',
      phaseId: 'seed-valid',
      coveredPhases: ['seed-valid'],
      gateKind: 'activation-plan',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [{ type: 'file', identity: 'config.json' }],
      destinations: [{ type: 'local', identity: 'root', repository: null, subscriptionId: null }],
      permissions: ['read-worktree'],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 },
      policyExceptions: [],
      destructiveScope: []
    });

    const envelope = {
      ...scope,
      schemaVersion: 3,
      approvedAt: validIsoDate,
      expiresAt: '2026-09-02T12:00:00.000Z',
      approver: 'admin-001'
    };

    const canonicalScope = canonicalApprovalEnvelopeScope(envelope);
    const hash1 = canonicalApprovalEnvelopeHash(envelope);
    const hash2 = canonicalApprovalEnvelopeHash(envelope);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('determines human authority questions and question kinds correctly', () => {
    expect(questionKindForApprovalGate('activation-plan')).toBe('billed-infrastructure-policy-exception-cost-ceiling');
    expect(questionKindForApprovalGate('infrastructure-cost')).toBe('billed-infrastructure-policy-exception-cost-ceiling');
    expect(questionKindForApprovalGate('destructive-disposal')).toBe('destructive-operation');
    expect(questionKindForApprovalGate('credential-enrollment')).toBe('credential-enrollment');
    expect(questionKindForApprovalGate('none')).toBe(null);

    // Questions via plan
    const plan = {
      scope: 'local',
      phaseId: 'seed-valid',
      coveredPhases: ['seed-valid'],
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
    expect(determineHumanAuthorityQuestion(plan)).toBe('billed-infrastructure-policy-exception-cost-ceiling');

    const disposalPlan = {
      ...plan,
      gateKind: 'destructive-disposal',
      scope: 'lifecycle',
      destructiveScope: ['bootstrap-state/key.enc']
    };
    expect(determineHumanAuthorityQuestion(disposalPlan)).toBe('destructive-operation');
  });

  it('filters authorityOperations and computes transitionAuthorityDigest', () => {
    const operations = [
      { actionId: 'governance.evidence.write', phaseId: 'committed' },
      { actionId: 'governance.activation-state.write', phaseId: 'committed' },
      { actionId: 'git.commit', phaseId: 'committed' }
    ] as any;

    const filtered = authorityOperations(operations);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].actionId).toBe('git.commit');

    const digest = transitionAuthorityDigest({
      phase: {
        id: 'committed',
        approvalGate: { kind: 'activation-plan' },
        allowedMutations: { local: ['git-commit'], remote: [] }
      } as any,
      transitionDigest: validHex64,
      operations: filtered
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('combines approval requests safely merging permissions, resources, and cost', () => {
    const req1 = normalizeApprovalScope({
      scope: 'local',
      phaseId: 'seed-valid',
      coveredPhases: ['seed-valid'],
      gateKind: 'activation-plan',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [{ type: 'file', identity: 'file1.ts' }],
      destinations: [{ type: 'local', identity: 'root', repository: null, subscriptionId: null }],
      permissions: ['read-worktree'],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 100, usageMonthlyCents: 200 },
      policyExceptions: [],
      destructiveScope: []
    });

    const req2 = normalizeApprovalScope({
      scope: 'local',
      phaseId: 'seed-verified',
      coveredPhases: ['seed-verified'],
      gateKind: 'activation-plan',
      identity: currentActivationIdentity,
      baselineSha: validHex64,
      planDigest: validHex64,
      resources: [{ type: 'file', identity: 'file2.ts' }],
      destinations: [{ type: 'local', identity: 'root', repository: null, subscriptionId: null }],
      permissions: ['read-worktree', 'read-history'],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 300, usageMonthlyCents: 400 },
      policyExceptions: [],
      destructiveScope: []
    });

    const combined = combineApprovalRequests([req1, req2]);
    expect(combined.coveredPhases).toEqual(['seed-valid', 'seed-verified']);
    expect(combined.resources).toHaveLength(2);
    expect(combined.permissions).toContain('read-history');
    expect(combined.costCeiling.fixedMonthlyCents).toBe(400);
    expect(combined.costCeiling.usageMonthlyCents).toBe(600);
  });
});
