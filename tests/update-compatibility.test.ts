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
    expect(metadata.schemaVersion).toBe(3);
    expect(metadata.activation.successorMigrations).toEqual([{
      id: 'activation-v1-to-v2',
      fromIdentity: historicalActivationIdentities[0],
      toIdentity: currentActivationIdentity,
      strategy: 'preserve-history-revalidate',
      historySchemaVersion: 1,
      journalSchemaVersion: 1
    }]);
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
        historicalReadability: { ...activation.historicalReadability, migration: 'unsupported-preserve-bytes' }
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
    expect(() => validateGovernanceCompatibilityMetadata({ ...metadata, schemaVersion: 4 })).toThrow(/schemaVersion/);
  });

  it('does not alter current phase graph or execution schema identities', () => {
    expect(currentActivationIdentity).toMatchObject({
      liftoffVersion: '0.11.0',
      manifestArtifactVersion: 7,
      policyVersion: '6',
      activationContractVersion: 2,
      activationStateSchemaVersion: 2,
      evidenceHeaderSchemaVersion: 2,
      approvalEnvelopeSchemaVersion: 2
    });
    expect(canonicalPhaseGraphHash).toBe('ac160e3fc86f3e438141d985658e09f419508b3adbe176ddd13100d5dfdee47c');
  });
});
