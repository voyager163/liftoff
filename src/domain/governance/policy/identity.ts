import type { ActivationIdentity } from '../activation/types.js';

export const liftoffActivationPackageVersion = '0.13.0' as const;
export const liftoffManifestArtifactVersion = 8 as const;
export const governanceActivationPolicyVersion = '8' as const;
export const activationContractVersion = 4 as const;
export const phaseGraphSchemaVersion = 3 as const;
export const activationStateSchemaVersion = 4 as const;
export const evidenceHeaderSchemaVersion = 4 as const;
export const approvalEnvelopeSchemaVersion = 4 as const;
export const compatibilityMetadataSchemaVersion = 5 as const;
export const governanceOutputSchemaVersion = 3 as const;
export const supersessionSchemaVersion = 1 as const;
export const credentialPolicySchemaVersion = 2 as const;

export const knownActivationVersions = {
  liftoffVersion: [liftoffActivationPackageVersion],
  manifestArtifactVersion: [liftoffManifestArtifactVersion],
  policyVersion: [governanceActivationPolicyVersion],
  activationContractVersion: [activationContractVersion],
  phaseGraphSchemaVersion: [phaseGraphSchemaVersion],
  activationStateSchemaVersion: [activationStateSchemaVersion],
  evidenceHeaderSchemaVersion: [evidenceHeaderSchemaVersion],
  approvalEnvelopeSchemaVersion: [approvalEnvelopeSchemaVersion],
  supersessionSchemaVersion: [supersessionSchemaVersion],
  credentialPolicySchemaVersion: [credentialPolicySchemaVersion]
} as const;

const tupleFields = [
  'liftoffVersion',
  'manifestArtifactVersion',
  'policyVersion',
  'activationContractVersion',
  'phaseGraphSchemaVersion',
  'phaseGraphHash',
  'activationStateSchemaVersion',
  'evidenceHeaderSchemaVersion',
  'approvalEnvelopeSchemaVersion',
  'supersessionSchemaVersion',
  'credentialPolicySchemaVersion'
] as const;

export type ActivationCompatibilityMap = ReadonlyMap<string, ActivationIdentity>;

export type CurrentActivationIdentity = ActivationIdentity & {
  liftoffVersion: typeof liftoffActivationPackageVersion;
  manifestArtifactVersion: typeof liftoffManifestArtifactVersion;
  policyVersion: typeof governanceActivationPolicyVersion;
  activationContractVersion: typeof activationContractVersion;
  phaseGraphSchemaVersion: typeof phaseGraphSchemaVersion;
  activationStateSchemaVersion: typeof activationStateSchemaVersion;
  evidenceHeaderSchemaVersion: typeof evidenceHeaderSchemaVersion;
  approvalEnvelopeSchemaVersion: typeof approvalEnvelopeSchemaVersion;
  supersessionSchemaVersion: typeof supersessionSchemaVersion;
  credentialPolicySchemaVersion: typeof credentialPolicySchemaVersion;
};

export const historicalActivationIdentities = [{
  liftoffVersion: '0.10.0',
  manifestArtifactVersion: 7,
  policyVersion: '6',
  activationContractVersion: 1,
  phaseGraphSchemaVersion: 1,
  phaseGraphHash: 'b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7',
  activationStateSchemaVersion: 1,
  evidenceHeaderSchemaVersion: 1,
  approvalEnvelopeSchemaVersion: 1,
  supersessionSchemaVersion: 1,
  credentialPolicySchemaVersion: 1
}, {
  liftoffVersion: '0.11.0',
  manifestArtifactVersion: 7,
  policyVersion: '6',
  activationContractVersion: 2,
  phaseGraphSchemaVersion: 1,
  phaseGraphHash: 'ac160e3fc86f3e438141d985658e09f419508b3adbe176ddd13100d5dfdee47c',
  activationStateSchemaVersion: 2,
  evidenceHeaderSchemaVersion: 2,
  approvalEnvelopeSchemaVersion: 2,
  supersessionSchemaVersion: 1,
  credentialPolicySchemaVersion: 1
}, {
  liftoffVersion: '0.12.0',
  manifestArtifactVersion: 7,
  policyVersion: '6',
  activationContractVersion: 3,
  phaseGraphSchemaVersion: 2,
  phaseGraphHash: '2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703',
  activationStateSchemaVersion: 3,
  evidenceHeaderSchemaVersion: 3,
  approvalEnvelopeSchemaVersion: 3,
  supersessionSchemaVersion: 1,
  credentialPolicySchemaVersion: 1
}, {
  liftoffVersion: '0.13.0',
  manifestArtifactVersion: 8,
  policyVersion: '7',
  activationContractVersion: 4,
  phaseGraphSchemaVersion: 3,
  phaseGraphHash: '00226d3a7e74b760f463e510847676b11baac432be013062cccda19fb77bcca2',
  activationStateSchemaVersion: 4,
  evidenceHeaderSchemaVersion: 4,
  approvalEnvelopeSchemaVersion: 4,
  supersessionSchemaVersion: 1,
  credentialPolicySchemaVersion: 1
}] as const satisfies readonly ActivationIdentity[];

export const historicalV1ActivationIdentity = historicalActivationIdentities[0];
export const historicalV2ActivationIdentity = historicalActivationIdentities[1];
export const historicalV3ActivationIdentity = historicalActivationIdentities[2];
export const historicalV4Policy7ActivationIdentity = historicalActivationIdentities[3];
export type HistoricalV1ActivationIdentity = typeof historicalV1ActivationIdentity;
export type HistoricalV2ActivationIdentity = typeof historicalV2ActivationIdentity;
export type HistoricalV3ActivationIdentity = typeof historicalV3ActivationIdentity;
export type HistoricalV4Policy7ActivationIdentity = typeof historicalV4Policy7ActivationIdentity;

export type HistoricalActivationIdentity = typeof historicalActivationIdentities[number];
export type ReadableActivationIdentity = CurrentActivationIdentity | HistoricalActivationIdentity;

export function isHistoricalActivationIdentity(value: unknown): value is HistoricalActivationIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).length === tupleFields.length &&
    historicalActivationIdentities.some((historical) => tupleFields.every((field) =>
      Object.hasOwn(identity, field) && identity[field] === historical[field]));
}

export function isHistoricalV1ActivationIdentity(value: unknown): value is HistoricalV1ActivationIdentity {
  return isHistoricalActivationIdentity(value) && value.activationContractVersion === 1;
}

export function isHistoricalV2ActivationIdentity(value: unknown): value is HistoricalV2ActivationIdentity {
  return isHistoricalActivationIdentity(value) && value.activationContractVersion === 2;
}

export function isHistoricalV3ActivationIdentity(value: unknown): value is HistoricalV3ActivationIdentity {
  return isHistoricalActivationIdentity(value) && value.activationContractVersion === 3;
}

export function isHistoricalV4Policy7ActivationIdentity(value: unknown): value is HistoricalV4Policy7ActivationIdentity {
  return isHistoricalActivationIdentity(value) && value.activationContractVersion === 4 && value.policyVersion === '7';
}

export function createActivationIdentity(phaseGraphHash: string): CurrentActivationIdentity {
  return {
    liftoffVersion: liftoffActivationPackageVersion,
    manifestArtifactVersion: liftoffManifestArtifactVersion,
    policyVersion: governanceActivationPolicyVersion,
    activationContractVersion,
    phaseGraphSchemaVersion,
    phaseGraphHash,
    activationStateSchemaVersion,
    evidenceHeaderSchemaVersion,
    approvalEnvelopeSchemaVersion,
    supersessionSchemaVersion,
    credentialPolicySchemaVersion
  };
}

export function activationCompatibilityKey(identity: ActivationIdentity): string {
  return tupleFields.map((field) => `${field}=${identity[field]}`).join('|');
}

export function buildActivationCompatibilityMap(
  identities: readonly ActivationIdentity[]
): ActivationCompatibilityMap {
  return new Map(identities.map((identity) => [activationCompatibilityKey(identity), identity]));
}

function knownVersion(field: keyof typeof knownActivationVersions, value: string | number): boolean {
  return (knownActivationVersions[field] as readonly (string | number)[]).includes(value);
}

export type ActivationCompatibilityResult =
  | { compatible: true; identity: ActivationIdentity }
  | { compatible: false; reason: string };

export function resolveActivationCompatibility(
  identity: ActivationIdentity,
  compatibility: ActivationCompatibilityMap
): ActivationCompatibilityResult {
  if (isHistoricalActivationIdentity(identity)) {
    return { compatible: false, reason: `Historical activation v${identity.activationContractVersion} policy ${identity.policyVersion} is diagnostic-only. Run liftoff update --check to inspect an explicitly supported history-preserving policy-8 successor; preserve original bytes and obtain fresh credential approval without reset, retagging, or automatic conversion.` };
  }
  for (const field of Object.keys(knownActivationVersions) as (keyof typeof knownActivationVersions)[]) {
    if (!knownVersion(field, identity[field])) {
      const supported = (knownActivationVersions[field] as readonly (string | number)[])
        .map((value) => JSON.stringify(value))
        .join(', ');
      return {
        compatible: false,
        reason:
          `Unsupported activation identity field ${field}: found ${JSON.stringify(identity[field])}; ` +
          `supported values are ${supported}. Minimum Liftoff ${liftoffActivationPackageVersion} is required; ` +
          'upgrade through the configured Liftoff package delivery workflow.'
      };
    }
  }
  const found = compatibility.get(activationCompatibilityKey(identity));
  if (!found) {
    const supportedTuples = [...compatibility.keys()].join('; ');
    const graphHashes = [...new Set([...compatibility.values()].map((entry) => entry.phaseGraphHash))].join(', ');
    return {
      compatible: false,
      reason:
        `Activation identity tuple is not present in the explicit compatibility map: found ${activationCompatibilityKey(identity)}; ` +
        `supported tuples are ${supportedTuples}; recognized graph hashes are ${graphHashes}. ` +
        `Minimum Liftoff ${liftoffActivationPackageVersion} is required; upgrade/remediate with ` +
        'the configured Liftoff package delivery workflow.'
    };
  }
  return { compatible: true, identity: found };
}
