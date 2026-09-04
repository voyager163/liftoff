import type { ActivationIdentity } from './types.js';
import { exactGlobalInstallCommand } from '../package-identity.js';

export const liftoffActivationPackageVersion = '0.10.0' as const;
export const liftoffManifestArtifactVersion = 7 as const;
export const governanceActivationPolicyVersion = '6' as const;
export const activationContractVersion = 1 as const;
export const phaseGraphSchemaVersion = 1 as const;
export const activationStateSchemaVersion = 1 as const;
export const evidenceHeaderSchemaVersion = 1 as const;
export const approvalEnvelopeSchemaVersion = 1 as const;
export const supersessionSchemaVersion = 1 as const;
export const credentialPolicySchemaVersion = 1 as const;

export const knownActivationVersions = {
  liftoffVersion: [liftoffActivationPackageVersion],
  manifestArtifactVersion: [liftoffManifestArtifactVersion],
  policyVersion: ['5', governanceActivationPolicyVersion],
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

export function createActivationIdentity(phaseGraphHash: string): ActivationIdentity {
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
          `upgrade/remediate with ${exactGlobalInstallCommand(liftoffActivationPackageVersion)}.`
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
        `${exactGlobalInstallCommand(liftoffActivationPackageVersion)}.`
    };
  }
  return { compatible: true, identity: found };
}
