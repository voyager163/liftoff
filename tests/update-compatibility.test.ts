import { describe, expect, it } from 'vitest';
import {
  buildGovernanceCompatibilityMetadata,
  validateGovernanceCompatibilityMetadata
} from '../src/governance-activation/compatibility.js';
import { currentActivationIdentity, canonicalPhaseGraphHash } from '../src/domain/governance/activation/graph.js';
import { historicalActivationIdentities, historicalV3ActivationIdentity, resolveActivationCompatibility } from '../src/domain/governance/policy/identity.js';
import { validateHistoricalV2Compatibility } from '../src/governance-activation/historical-v2.js';
import { releasedBytes, releasedCase } from './fixtures/released-baseline/corpus.js';

describe('reviewed activation successor compatibility', () => {
  it('keeps authentic released v2 compatibility readable only through its isolated historical contract', () => {
    const source = releasedCase('activation-v2');
    const file = source.files.find((entry) => entry.path === '.liftoff/governance/compatibility.json');
    expect(file).toBeDefined();
    const bytes = releasedBytes(file!);
    const document: unknown = JSON.parse(bytes.toString('utf8'));
    const before = JSON.stringify(document);
    expect(() => validateHistoricalV2Compatibility(document)).not.toThrow();
    expect(() => validateGovernanceCompatibilityMetadata(document)).toThrow(/isolated version-specific reader/);
    expect(JSON.stringify(document)).toBe(before);
    expect(releasedBytes(file!)).toEqual(bytes);
  });
  it('declares a successor lane without making historical proof executable', () => {
    const metadata = validateGovernanceCompatibilityMetadata(buildGovernanceCompatibilityMetadata([], [], []));
    expect(metadata.schemaVersion).toBe(5);
    expect(metadata.activation.successorMigrations.map((entry) => entry.id)).toEqual([
      'activation-v1-to-v4',
      'activation-v2-to-v4',
      'activation-v3-to-v4',
      'activation-v4-policy7-to-policy8'
    ]);
    expect(metadata.activation.currentCompatibleTuples).toEqual([currentActivationIdentity]);
    expect(resolveActivationCompatibility(historicalActivationIdentities[0]!, new Map()).compatible).toBe(false);
  });

  it('refuses relabeled historical metadata through the current execution reader without changing its bytes', () => {
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
    const before = JSON.stringify(legacy);
    expect(() => validateGovernanceCompatibilityMetadata(legacy)).toThrow(/historical metadata requires its isolated version-specific reader/);
    expect(JSON.stringify(legacy)).toBe(before);
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
    expect(() => validateGovernanceCompatibilityMetadata({ ...metadata, schemaVersion: 6 })).toThrow(/schemaVersion/);
  });

  it('uses the reviewed v4 identity without altering the retained released v3 graph', () => {
    expect(currentActivationIdentity).toMatchObject({
      liftoffVersion: '0.13.0',
      manifestArtifactVersion: 8,
      policyVersion: '8',
      activationContractVersion: 4,
      activationStateSchemaVersion: 4,
      evidenceHeaderSchemaVersion: 4,
      approvalEnvelopeSchemaVersion: 4
    });
    expect(canonicalPhaseGraphHash).toBe('7ae2149bfe39b3983bd09c14f0b11ebb84f82ad276170f12cc2c250d780301e9');
    expect(historicalV3ActivationIdentity).toMatchObject({
      liftoffVersion: '0.12.0', activationContractVersion: 3,
      phaseGraphHash: '2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703'
    });
  });
});
