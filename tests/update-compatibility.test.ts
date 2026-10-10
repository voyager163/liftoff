import { describe, expect, it } from 'vitest';
import {
  buildGovernanceCompatibilityMetadata,
  validateGovernanceCompatibilityMetadata
} from '../src/governance-activation/compatibility.js';
import { currentActivationIdentity, canonicalPhaseGraphHash } from '../src/domain/governance/activation/graph.js';
import { historicalActivationIdentities, resolveActivationCompatibility } from '../src/domain/governance/policy/identity.js';

describe('reviewed activation successor compatibility', () => {
  it('declares a successor lane without making historical proof executable', () => {
    const metadata = validateGovernanceCompatibilityMetadata(buildGovernanceCompatibilityMetadata([], [], []));
    expect(metadata.schemaVersion).toBe(4);
    const migrations = metadata.activation.successorMigrations;
    if (!migrations) throw new Error('Expected the retained schema-4 successor declarations.');
    expect(migrations.map((entry) => entry.id)).toEqual([
      'activation-v1-to-v3',
      'activation-v2-to-v3'
    ]);
    expect(metadata.activation.currentCompatibleTuples).toEqual([currentActivationIdentity]);
    expect(resolveActivationCompatibility(historicalActivationIdentities[0]!, new Map()).compatible).toBe(false);
  });

  it('reads schema 2 as historical input with no successor authorization', () => {
    const metadata = buildGovernanceCompatibilityMetadata([], [], []);
    const activation = { ...metadata.activation };
    Reflect.deleteProperty(activation, 'successorMigrations');
    const legacy = {
      ...metadata,
      schemaVersion: 2,
      activation: {
        ...activation,
        historicalReadability: {
          tuples: metadata.activation.historicalReadability.tuples,
          activationContractVersion: 1,
          activationStateSchemaVersion: 1,
          evidenceHeaderSchemaVersion: 1,
          execution: 'diagnostic-only',
          migration: 'unsupported-preserve-bytes'
        }
      }
    };
    const parsed = validateGovernanceCompatibilityMetadata(legacy);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.activation.successorMigrations).toBeUndefined();
    expect(validateGovernanceCompatibilityMetadata(parsed)).toEqual(parsed);
  });

  it('rejects a project-edited successor lane', () => {
    const metadata = buildGovernanceCompatibilityMetadata([], [], []);
    const altered = {
      ...metadata,
      activation: {
        ...metadata.activation,
        successorMigrations: [{ ...metadata.activation.successorMigrations[0], id: 'arbitrary-conversion' }]
      }
    };
    expect(() => validateGovernanceCompatibilityMetadata(altered)).toThrow(/packaged/);
    expect(() => validateGovernanceCompatibilityMetadata({ ...metadata, schemaVersion: 5 })).toThrow(/schemaVersion/);
  });

  it('records the reviewed runner graph successor without changing execution schema versions', () => {
    expect(currentActivationIdentity).toMatchObject({
      liftoffVersion: '0.12.0',
      manifestArtifactVersion: 7,
      policyVersion: '6',
      activationContractVersion: 3,
      activationStateSchemaVersion: 3,
      evidenceHeaderSchemaVersion: 3,
      approvalEnvelopeSchemaVersion: 3
    });
    expect(canonicalPhaseGraphHash).toBe('f8122e15e69b9e7425096ea7d8e8624d2b4c3041074e534ce582486331deadba');
  });
});
