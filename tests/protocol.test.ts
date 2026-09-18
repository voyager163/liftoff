import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args/parser.js';
import {
  publicProtocolSchemaVersion,
  ProtocolValidationError,
  assertSchemaVersion,
  assertStrictKeys
} from '../src/protocol/schema.js';
import {
  validatePublicCapability,
  validatePublicCapabilitiesEnvelope,
  type PublicCapabilityV1,
  type PublicCapabilitiesEnvelopeV1
} from '../src/protocol/capabilities.js';
import {
  createStructuredContinuation,
  validateStructuredContinuation,
  type StructuredContinuationV1
} from '../src/protocol/continuation.js';
import {
  createPublicCommandResultEnvelope,
  validatePublicCommandEnvelope,
  validatePublicTarget
} from '../src/protocol/commands.js';
import {
  buildUnifiedOperationOutcome,
  validateUnifiedOperationOutcome,
  type OperationEffect
} from '../src/domain/execution/operation-outcome.js';
import {
  ContinuationSecretError,
  formatNativeSafeCommandLine,
  resolveGovernanceScope,
  canonicalizePathBoundary
} from '../src/domain/execution/continuation.js';
import {
  canonicalEngines,
  engineIds,
  engineOwners
} from '../src/domain/execution/engines.js';

describe('Public Protocol Schema 1 and Strict Validation (Task 2.1)', () => {
  it('enforces schemaVersion 1 and fails for unsupported or missing schemaVersion', () => {
    expect(publicProtocolSchemaVersion).toBe(1);

    expect(() => assertSchemaVersion({ schemaVersion: 2 }, 1, 'Test')).toThrow(ProtocolValidationError);
    expect(() => assertSchemaVersion({ schemaVersion: '1' as any }, 1, 'Test')).toThrow(ProtocolValidationError);
    expect(() => assertSchemaVersion({}, 1, 'Test')).toThrow(ProtocolValidationError);
    expect(() => assertSchemaVersion({ schemaVersion: 0 }, 1, 'Test')).toThrow(ProtocolValidationError);
  });

  it('rejects unsupported extra fields on strict validation', () => {
    const record = { schemaVersion: 1, command: 'assess', extraUnknownField: true };
    expect(() => assertStrictKeys(record, ['schemaVersion', 'command'], 'Test')).toThrow(ProtocolValidationError);
  });

  it('validates public command envelope without modifying existing command report schemas', () => {
    const validEnvelope = {
      schemaVersion: 1,
      command: 'assess',
      target: { kind: 'project' as const, path: '/workspace/my-app' },
      scope: 'repository'
    };
    const validated = validatePublicCommandEnvelope(validEnvelope);
    expect(validated.command).toBe('assess');
    expect(validated.target?.path).toBe('/workspace/my-app');

    // Invalid target kind fails
    expect(() => validatePublicTarget({ kind: 'invalid', path: '/workspace' })).toThrow(ProtocolValidationError);

    // Unsupported schemaVersion fails
    expect(() => validatePublicCommandEnvelope({ ...validEnvelope, schemaVersion: 2 })).toThrow(ProtocolValidationError);

    // Preserves existing command JSON bodies in result envelopes
    const legacyRepairReport = {
      schemaVersion: 2,
      repairContract: 1,
      status: 'verified',
      committed: false
    };
    const resultEnvelope = createPublicCommandResultEnvelope('repair', 'success', legacyRepairReport);
    expect(resultEnvelope.schemaVersion).toBe(1);
    expect(resultEnvelope.result.schemaVersion).toBe(2);
    expect(resultEnvelope.result.repairContract).toBe(1);
  });
});

describe('Six Capability Owners and Qualification States (Task 2.2)', () => {
  it('identifies exactly six engine owners with shared kernel as non-engine infrastructure', () => {
    expect(engineIds).toHaveLength(6);
    expect(engineOwners).toHaveLength(6);
    expect(engineIds).toEqual([
      'standards-assessment',
      'project-generation',
      'project-evolution',
      'repository-governance',
      'azure-activation',
      'distribution'
    ]);
    expect(engineOwners).toEqual([
      'Standards and Assessment',
      'Project Generation',
      'Project Evolution',
      'Repository Governance',
      'Azure Activation',
      'Distribution and CLI Upgrade'
    ]);
    expect(Object.keys(canonicalEngines)).toHaveLength(6);
  });

  it('validates capability records with distinct planner-only, prerequisite-blocked, implementation-missing and unqualified states', () => {
    const baseCapability: PublicCapabilityV1 = {
      schemaVersion: 1,
      id: 'test-capability',
      engine: 'project-evolution',
      owner: 'Project Evolution',
      title: 'Test Capability',
      description: 'Testing qualification states',
      supportedProfiles: ['python-fastapi'],
      supportedPlatforms: ['darwin', 'win32', 'linux'],
      requiredInputs: ['projectRoot'],
      commandSchema: { resultSchemaVersion: 2, contractVersion: 1 },
      authorization: { mechanism: 'reviewed-plan', defaultDecision: 'no' },
      planner: 'built-in',
      executor: 'built-in',
      verifier: 'built-in',
      recovery: 'attributable-journal',
      effectClasses: ['filesystem-write'],
      compatibilityIdentities: ['repair-contract-v1'],
      qualificationState: 'qualified',
      readOnly: false
    };

    // Valid qualified capability
    expect(validatePublicCapability(baseCapability)).toEqual(baseCapability);

    // Planner-only requires executor to be unavailable
    const plannerOnly: PublicCapabilityV1 = {
      ...baseCapability,
      id: 'test-planner-only',
      executor: 'unavailable',
      qualificationState: 'planner-only'
    };
    expect(validatePublicCapability(plannerOnly).qualificationState).toBe('planner-only');

    // Planner-only fails if executor is built-in
    expect(() => validatePublicCapability({
      ...baseCapability,
      qualificationState: 'planner-only'
    })).toThrow(ProtocolValidationError);

    // Implementation-missing requires executor to be unavailable
    const implMissing: PublicCapabilityV1 = {
      ...baseCapability,
      id: 'test-impl-missing',
      executor: 'unavailable',
      qualificationState: 'implementation-missing'
    };
    expect(validatePublicCapability(implMissing).qualificationState).toBe('implementation-missing');

    // Prerequisite-blocked remains distinct
    const prereqBlocked: PublicCapabilityV1 = {
      ...baseCapability,
      id: 'test-prereq-blocked',
      qualificationState: 'prerequisite-blocked'
    };
    expect(validatePublicCapability(prereqBlocked).qualificationState).toBe('prerequisite-blocked');

    // Unqualified remains distinct
    const unqualified: PublicCapabilityV1 = {
      ...baseCapability,
      id: 'test-unqualified',
      qualificationState: 'unqualified'
    };
    expect(validatePublicCapability(unqualified).qualificationState).toBe('unqualified');
  });

  it('enforces read-only capabilities have no mutating effectClasses and recovery is n/a', () => {
    const validReadOnly: PublicCapabilityV1 = {
      schemaVersion: 1,
      id: 'read-only-check',
      engine: 'standards-assessment',
      owner: 'Standards and Assessment',
      title: 'Standards Check',
      description: 'Read-only check',
      supportedProfiles: ['all'],
      supportedPlatforms: ['darwin', 'win32', 'linux'],
      requiredInputs: ['targetPath'],
      commandSchema: { resultSchemaVersion: 1 },
      authorization: { mechanism: 'read-only', defaultDecision: 'n/a' },
      planner: 'built-in',
      executor: 'built-in',
      verifier: 'n/a',
      recovery: 'n/a',
      effectClasses: ['filesystem-read'],
      compatibilityIdentities: [],
      qualificationState: 'qualified',
      readOnly: true
    };
    expect(validatePublicCapability(validReadOnly).readOnly).toBe(true);

    // Read-only with mutating effect class must fail
    expect(() => validatePublicCapability({
      ...validReadOnly,
      effectClasses: ['filesystem-write' as any]
    })).toThrow(ProtocolValidationError);

    // Read-only with non-n/a recovery must fail
    expect(() => validatePublicCapability({
      ...validReadOnly,
      recovery: 'attributable-journal'
    })).toThrow(ProtocolValidationError);
  });
});

describe('Structured Continuation Contract (Task 2.6)', () => {
  it('preserves executable, args array, cwd, project, configPath/digest, and requiredAuthority', () => {
    const continuation = createStructuredContinuation({
      executable: 'liftoff',
      args: ['governance', 'apply-next', '--project', '/path/to/project'],
      cwd: '/path/to/project',
      project: '/path/to/project',
      configPath: '/path/to/inputs.json',
      configDigest: 'a'.repeat(64),
      requiredAuthority: ['file-write', 'git-publication'],
      compatibilityIdentity: 'activation-v4'
    });

    expect(continuation.schemaVersion).toBe(1);
    expect(continuation.executable).toBe('liftoff');
    expect(continuation.args).toEqual([
      'governance', 'apply-next', '--project', '/path/to/project', '--inputs', '/path/to/inputs.json'
    ]);
    expect(parseArgs([...continuation.args])).toMatchObject({
      command: 'governance', subcommand: 'apply-next', flags: { inputs: '/path/to/inputs.json' }
    });
    expect(continuation.cwd).toBe('/path/to/project');
    expect(continuation.project).toBe('/path/to/project');
    expect(continuation.configPath).toBe('/path/to/inputs.json');
    expect(continuation.configDigest).toBe('a'.repeat(64));
    expect(continuation.requiredAuthority).toEqual(['file-write', 'git-publication']);
    expect(continuation.compatibilityIdentity).toBe('activation-v4');

    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
  });

  it('resolves absent governance scope to activation default', () => {
    // When command is governance and scope is omitted, resolves to activation
    const continuation = createStructuredContinuation({
      args: ['governance', 'plan'],
      cwd: '/workspace'
    });
    expect(continuation.scope).toBe('activation');

    // When scope is explicitly provided, preserves explicit scope
    const explicitScope = createStructuredContinuation({
      args: ['governance', 'plan'],
      cwd: '/workspace',
      scope: 'repository'
    });
    expect(explicitScope.scope).toBe('repository');

    // Other commands do not inject activation scope
    const updateContinuation = createStructuredContinuation({
      args: ['update', '--check'],
      cwd: '/workspace'
    });
    expect(updateContinuation.scope).toBeUndefined();
  });

  it('rejects secret value commands in continuation contracts', () => {
    expect(() => createStructuredContinuation({
      args: ['governance', '--token=ghp_1234567890123456789012345678901234'],
      cwd: '/workspace'
    })).toThrow(ContinuationSecretError);

    expect(() => createStructuredContinuation({
      args: ['governance', '--token', 'ghp_1234567890123456789012345678901234'],
      cwd: '/workspace'
    })).toThrow(ContinuationSecretError);

    expect(() => createStructuredContinuation({
      args: ['governance', '--pat=github_pat_12345678901234567890123456789012345678901234567890123456789012'],
      cwd: '/workspace'
    })).toThrow(ContinuationSecretError);

    // Protected references are consumed through the real bound input contract, not an invented token flag.
    const refContinuation = createStructuredContinuation({
      args: ['governance', 'plan', '--inputs', '/workspace/public-inputs.json'],
      cwd: '/workspace', configPath: '/workspace/public-inputs.json', configDigest: 'a'.repeat(64)
    });
    expect(refContinuation.args).toContain('/workspace/public-inputs.json');
    expect(() => createStructuredContinuation({
      args: ['governance', '--token', '$GITHUB_TOKEN'], cwd: '/workspace'
    })).toThrow(/Unknown flag/);
  });
});

describe('Native Shell Rendering and Canonical Path Boundaries (Task 2.7)', () => {
  it('formats native-safe command line with spaced paths and quotes on POSIX and Windows', () => {
    const posixCmd = formatNativeSafeCommandLine(
      'liftoff',
      ['update', '--project', '/path with spaces/my project'],
      'darwin'
    );
    expect(posixCmd).toBe("liftoff update --project '/path with spaces/my project'");

    const winCmd = formatNativeSafeCommandLine(
      'liftoff',
      ['repair', 'C:\\Program Files\\My App', '--check'],
      'win32'
    );
    expect(winCmd).toBe("& 'liftoff' 'repair' 'C:\\Program Files\\My App' '--check'");
  });

  it('escapes PowerShell metacharacters properly on Windows', () => {
    const winCmd = formatNativeSafeCommandLine(
      'liftoff',
      ['assess', 'path$name`eval@test'],
      'win32'
    );
    expect(winCmd).toBe("& 'liftoff' 'assess' 'path$name`eval@test'");
    expect(formatNativeSafeCommandLine('liftoff', ['assess', '@splat'], 'win32'))
      .toBe("& 'liftoff' 'assess' '@splat'");
  });

  it('canonicalizes path boundaries and rejects traversal escapes', () => {
    const canonical = canonicalizePathBoundary('my-app/src', 'my-app');
    expect(canonical).toBe('my-app/src');

    // Path traversal outside boundary root fails
    expect(() => canonicalizePathBoundary('../outside', 'my-app')).toThrow(/Path traversal detected/);

    // Path containing null bytes fails
    expect(() => canonicalizePathBoundary('my-app/\0invalid')).toThrow(/null bytes/);
  });
});

describe('Unified Operation Outcome Reporting (Task 2.8)', () => {
  it('preserves committed effects and prevents collapsing into success-shaped or untouched fallback', () => {
    const effect: OperationEffect = {
      type: 'file-write',
      target: 'src/config.json',
      timestamp: new Date().toISOString(),
      verified: false
    };

    // If effects were committed but verification failed, status is partial, never completed
    const partialOutcome = buildUnifiedOperationOutcome({
      operationId: 'op-1',
      command: 'update',
      status: 'completed', // Caller attempted to declare completed
      committedEffects: [effect],
      verification: 'failed',
      failureReason: 'Post-write verification failed.'
    });

    expect(partialOutcome.status).toBe('partial');
    expect(partialOutcome.committedEffects).toHaveLength(1);
    expect(partialOutcome.verification).toBe('failed');
    expect(partialOutcome.failureReason).toBe('Post-write verification failed.');

    expect(validateUnifiedOperationOutcome(partialOutcome)).toEqual(partialOutcome);
  });

  it('forces verification to uncertain and prevents completion on uncertain settlement', () => {
    const effect: OperationEffect = {
      type: 'process-execution',
      target: 'npm test',
      timestamp: new Date().toISOString(),
      verified: true
    };

    const uncertainOutcome = buildUnifiedOperationOutcome({
      operationId: 'op-2',
      command: 'repair',
      status: 'completed',
      committedEffects: [effect],
      verification: 'passed',
      uncertainSettlement: true
    });

    expect(uncertainOutcome.status).toBe('partial');
    expect(uncertainOutcome.verification).toBe('uncertain');
    expect(uncertainOutcome.uncertainSettlement).toBe(true);
  });

  it('validates outcome records strictly and rejects invalid structures', () => {
    expect(() => validateUnifiedOperationOutcome(null)).toThrow(/non-null object/);
    expect(() => validateUnifiedOperationOutcome({ schemaVersion: 2 })).toThrow(/unsupported outcome schemaVersion/i);
    expect(() => validateUnifiedOperationOutcome({ schemaVersion: 1, operationId: '' })).toThrow(/operationId/);
    expect(() => validateUnifiedOperationOutcome({ schemaVersion: 1, operationId: 'op-1', command: '' })).toThrow(/command/);
    expect(() => validateUnifiedOperationOutcome({
      schemaVersion: 1, operationId: 'op-1', command: 'update', status: 'invalid-status'
    })).toThrow(/invalid status/);
    expect(() => validateUnifiedOperationOutcome({
      schemaVersion: 1, operationId: 'op-1', command: 'update', status: 'completed', approvedEffects: 'not-array'
    })).toThrow(/arrays/);
  });
});

describe('Domain Execution Engine and Validation Utilities', () => {
  it('validates engine ids and owners and throws on unknown owner', async () => {
    const { isEngineId, isEngineOwner, engineOwnerForId, engineIdForOwner } = await import('../src/domain/execution/engines.js');
    expect(isEngineId('standards-assessment')).toBe(true);
    expect(isEngineId('non-existent')).toBe(false);
    expect(isEngineOwner('Standards and Assessment')).toBe(true);
    expect(isEngineOwner('Unknown Owner')).toBe(false);

    expect(engineOwnerForId('standards-assessment')).toBe('Standards and Assessment');
    expect(engineIdForOwner('Standards and Assessment')).toBe('standards-assessment');
    expect(() => engineIdForOwner('Non Existent' as any)).toThrow(/Unknown engine owner/);
  });

  it('validates plan input binding strictly with all field types', async () => {
    const { validatePlanInputBinding, computePlanFingerprint } = await import('../src/domain/execution/immutable-plan.js');
    expect(() => validatePlanInputBinding(null)).toThrow(/non-null object/);
    expect(() => validatePlanInputBinding({})).toThrow(/sourceBytesDigest/);
    expect(() => validatePlanInputBinding({ sourceBytesDigest: 'invalid' })).toThrow(/sourceBytesDigest/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      destinationBytesDigest: 'invalid'
    })).toThrow(/destinationBytesDigest/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: 'invalid'
    })).toThrow(/fileModes/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': -1 }
    })).toThrow(/invalid mode/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': 0o644 },
      directoryInventoryDigest: 'invalid'
    })).toThrow(/directoryInventoryDigest/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': 0o644 },
      directoryInventoryDigest: 'b'.repeat(64),
      targetIdentity: ''
    })).toThrow(/targetIdentity/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': 0o644 },
      directoryInventoryDigest: 'b'.repeat(64),
      targetIdentity: '/path',
      toolChainDigest: 'invalid'
    })).toThrow(/toolChainDigest/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': 0o644 },
      directoryInventoryDigest: 'b'.repeat(64),
      targetIdentity: '/path',
      configPath: 123 as any
    })).toThrow(/configPath/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': 0o644 },
      directoryInventoryDigest: 'b'.repeat(64),
      targetIdentity: '/path',
      configDigest: 'invalid'
    })).toThrow(/configDigest/);
    expect(() => validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      fileModes: { 'file.txt': 0o644 },
      directoryInventoryDigest: 'b'.repeat(64),
      targetIdentity: '/path',
      expiresAt: 123 as any
    })).toThrow(/expiresAt/);

    const validBinding = validatePlanInputBinding({
      sourceBytesDigest: 'a'.repeat(64),
      destinationBytesDigest: 'b'.repeat(64),
      fileModes: { 'src/index.ts': 0o644 },
      directoryInventoryDigest: 'c'.repeat(64),
      targetIdentity: '/path/to/project',
      toolChainDigest: 'd'.repeat(64),
      configPath: '/path/to/config.json',
      configDigest: 'e'.repeat(64),
      expiresAt: '2026-12-31T00:00:00.000Z'
    });
    expect(validBinding.targetIdentity).toBe('/path/to/project');
    const fingerprint = computePlanFingerprint(validBinding, { plan: 'test' });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects malformed public capabilities and envelopes', () => {
    const validCap: PublicCapabilityV1 = {
      schemaVersion: 1,
      id: 'valid-cap',
      engine: 'standards-assessment',
      owner: 'Standards and Assessment',
      title: 'Valid Cap',
      description: 'Description',
      supportedProfiles: ['python-fastapi'],
      supportedPlatforms: ['darwin', 'win32', 'linux'],
      requiredInputs: [],
      commandSchema: { resultSchemaVersion: 1 },
      authorization: { mechanism: 'read-only', defaultDecision: 'n/a' },
      planner: 'built-in',
      executor: 'built-in',
      verifier: 'n/a',
      recovery: 'n/a',
      effectClasses: ['filesystem-read'],
      compatibilityIdentities: [],
      qualificationState: 'qualified',
      readOnly: true
    };

    expect(() => validatePublicCapability({ ...validCap, id: '' })).toThrow(/id/);
    expect(() => validatePublicCapability({ ...validCap, engine: 'invalid-engine' })).toThrow(/engine/);
    expect(() => validatePublicCapability({ ...validCap, owner: 'Invalid Owner' })).toThrow(/owner/);
    expect(() => validatePublicCapability({ ...validCap, owner: 'Project Generation' })).toThrow(/owner mismatch/);
    expect(() => validatePublicCapability({ ...validCap, title: '' })).toThrow(/title/);
    expect(() => validatePublicCapability({ ...validCap, description: 123 })).toThrow(/description/);
    expect(() => validatePublicCapability({ ...validCap, supportedProfiles: 'not-array' })).toThrow(/supportedProfiles/);
    expect(() => validatePublicCapability({ ...validCap, supportedPlatforms: ['solaris' as any] })).toThrow(/supportedPlatforms/);
    expect(() => validatePublicCapability({ ...validCap, requiredInputs: 'not-array' })).toThrow(/requiredInputs/);
    expect(() => validatePublicCapability({ ...validCap, commandSchema: { resultSchemaVersion: 'one' } })).toThrow(/resultSchemaVersion/);
    expect(() => validatePublicCapability({ ...validCap, authorization: { mechanism: 'unknown' } })).toThrow(/mechanism/);
    expect(() => validatePublicCapability({ ...validCap, planner: 'invalid' })).toThrow(/planner/);
    expect(() => validatePublicCapability({ ...validCap, executor: 'invalid' })).toThrow(/executor/);
    expect(() => validatePublicCapability({ ...validCap, verifier: 'invalid' })).toThrow(/verifier/);
    expect(() => validatePublicCapability({ ...validCap, recovery: 'invalid' })).toThrow(/recovery/);
    expect(() => validatePublicCapability({ ...validCap, effectClasses: ['invalid-effect' as any] })).toThrow(/effectClasses/);
    expect(() => validatePublicCapability({ ...validCap, qualificationState: 'invalid-state' })).toThrow(/qualificationState/);
    expect(() => validatePublicCapability({ ...validCap, readOnly: 'true' })).toThrow(/readOnly/);

    expect(() => validatePublicCapabilitiesEnvelope({ ...validCap })).toThrow(/envelope/i);
    expect(() => validatePublicCapabilitiesEnvelope({
      schemaVersion: 1,
      kind: 'wrong-kind',
      cliVersion: '0.13.0',
      capabilities: [],
      engines: []
    })).toThrow(/kind/);
    expect(() => validatePublicCapabilitiesEnvelope({
      schemaVersion: 1,
      kind: 'liftoff-public-capabilities',
      cliVersion: '',
      capabilities: [],
      engines: []
    })).toThrow(/cliVersion/);
    expect(() => validatePublicCapabilitiesEnvelope({
      schemaVersion: 1,
      kind: 'liftoff-public-capabilities',
      cliVersion: '0.13.0',
      capabilities: 'not-array',
      engines: []
    })).toThrow(/capabilities/);
    expect(() => validatePublicCapabilitiesEnvelope({
      schemaVersion: 1,
      kind: 'liftoff-public-capabilities',
      cliVersion: '0.13.0',
      capabilities: [],
      engines: []
    })).toThrow(/array of exactly 6 engine descriptors/);
  });

  it('rejects malformed public command envelopes and targets', () => {
    expect(() => validatePublicCommandEnvelope({ schemaVersion: 1, command: '' })).toThrow(/command/);
    expect(() => validatePublicCommandEnvelope({ schemaVersion: 1, command: 'test', scope: 123 })).toThrow(/scope/);
    expect(() => validatePublicTarget({ kind: 'invalid', path: '/test' })).toThrow(/kind/);
    expect(() => validatePublicTarget({ kind: 'project', path: '' })).toThrow(/path/);
  });

  it('rejects malformed structured continuations', () => {
    expect(() => validateStructuredContinuation({ schemaVersion: 1, executable: '' })).toThrow(/executable/);
    expect(() => validateStructuredContinuation({ schemaVersion: 1, executable: 'liftoff', args: 'not-array' })).toThrow(/args/);
    expect(() => validateStructuredContinuation({ schemaVersion: 1, executable: 'liftoff', args: ['help'], cwd: '' })).toThrow(/cwd/);
    expect(() => validateStructuredContinuation({
      schemaVersion: 1, executable: 'liftoff', args: ['help'], cwd: '/path', displayCommand: ''
    })).toThrow(/displayCommand/);
    expect(() => validateStructuredContinuation({
      schemaVersion: 1, executable: 'liftoff', args: ['help'], cwd: '/path', displayCommand: 'cmd', targetScope: 'invalid'
    })).toThrow(/targetScope/);
    expect(() => validateStructuredContinuation({
      schemaVersion: 1, executable: 'liftoff', args: ['help'], cwd: '/path', displayCommand: 'cmd', requiredAuthority: 'not-array'
    })).toThrow(/requiredAuthority/);
  });
});
