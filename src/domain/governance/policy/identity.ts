import type { ActivationIdentity } from '../activation/types.js';
import type { ActivationIdentityFieldsV1 } from '../activation/record-contracts.js';
import { buildModernPhaseGraph, freezeModernValue } from '../activation/modern-graph.js';
import { canonicalSha256 } from '../activation/canonical-json.js';
import type { ModernActivationSourceContract, ModernStaticVersions, ModernWorkflow } from '../activation/modern-record-contracts.js';

export const liftoffActivationPackageVersion = '0.12.0' as const;
export const liftoffManifestArtifactVersion = 7 as const;
export const governanceActivationPolicyVersion = '6' as const;
export const activationContractVersion = 3 as const;
export const phaseGraphSchemaVersion = 2 as const;
export const activationStateSchemaVersion = 3 as const;
export const evidenceHeaderSchemaVersion = 3 as const;
export const approvalEnvelopeSchemaVersion = 3 as const;
export const compatibilityMetadataSchemaVersion = 4 as const;
export const supersessionSchemaVersion = 1 as const;
export const credentialPolicySchemaVersion = 1 as const;
export const modernGovernanceSourceMetadataSchemaVersion = 2 as const;

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
}] as const satisfies readonly ActivationIdentityFieldsV1[];

export const historicalV1ActivationIdentity = historicalActivationIdentities[0];
export const historicalV2ActivationIdentity = historicalActivationIdentities[1];
export type HistoricalV1ActivationIdentity = typeof historicalV1ActivationIdentity;
export type HistoricalV2ActivationIdentity = typeof historicalV2ActivationIdentity;

export type HistoricalActivationIdentity = typeof historicalActivationIdentities[number];
export type ReadableActivationIdentity =
  CurrentActivationIdentity | HistoricalActivationIdentity | ReleasedV3ActivationIdentity;

// Frozen released contract; it remains the current executable family until an
// explicitly allocated successor replaces it. This is not a diagnostic selector.
export const releasedV3ActivationIdentity = Object.freeze({
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
} as const satisfies ActivationIdentityFieldsV1);

export type ReleasedV3ActivationIdentity = typeof releasedV3ActivationIdentity;
export type ReleasedActivationIdentity = HistoricalActivationIdentity | ReleasedV3ActivationIdentity;

function matchesReleasedIdentity<I extends ReleasedActivationIdentity>(value: unknown, expected: I): value is I {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const fields = Object.entries(expected);
  return Object.keys(identity).length === fields.length &&
    fields.every(([field, entry]) => Object.hasOwn(identity, field) && identity[field] === entry);
}

export function isReleasedV3ActivationIdentity(value: unknown): value is ReleasedV3ActivationIdentity {
  return matchesReleasedIdentity(value, releasedV3ActivationIdentity);
}

export function isHistoricalActivationIdentity(value: unknown): value is HistoricalActivationIdentity {
  return historicalActivationIdentities.some((historical) => matchesReleasedIdentity(value, historical));
}

export function isHistoricalV1ActivationIdentity(value: unknown): value is HistoricalV1ActivationIdentity {
  return matchesReleasedIdentity(value, historicalV1ActivationIdentity);
}

export function isHistoricalV2ActivationIdentity(value: unknown): value is HistoricalV2ActivationIdentity {
  return matchesReleasedIdentity(value, historicalV2ActivationIdentity);
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
    return { compatible: false, reason: `Historical activation v${identity.activationContractVersion} is diagnostic-only. Run liftoff update --check to inspect an explicitly supported history-preserving v3 successor; preserve original bytes without reset, retagging, or automatic conversion.` };
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

// Unpublished source allocation only. Current execution and released selectors above do not change.
const modernSourceVersions: ModernStaticVersions = Object.freeze({
  liftoffVersion: '0.13.0-dev.0',
  manifestArtifactVersion: 8,
  activationContractVersion: 4,
  phaseGraphSchemaVersion: 3,
  activationStateSchemaVersion: 4,
  evidenceHeaderSchemaVersion: 4,
  approvalEnvelopeSchemaVersion: 4,
  supersessionSchemaVersion: 2,
  credentialPolicySchemaVersion: 2
} as const);

const modernPolicySources = [
  {
    identity: {
      profile: 'single-maintainer-gitflow', policyVersion: '7',
      policyDigest: 'sha256:d39036cf736fa95480b3289c63a34cac9ecee7f4cd4cdd1d779f94aed98b4706'
    },
    pathParts: ['assets', 'governance', 'single-maintainer-gitflow', 'policy-v7.md']
  },
  {
    identity: {
      profile: 'team-gitflow', policyVersion: '1',
      policyDigest: 'sha256:707bd85e1fee60ccf023eebcb4f33a0458a0014ee0f92fe9e398d2e7fe4b7646'
    },
    pathParts: ['assets', 'governance', 'team-gitflow', 'policy-v1.md']
  }
] as const;
export const modernGovernancePolicyVersions = Object.freeze({
  'single-maintainer-gitflow': modernPolicySources[0].identity.policyVersion,
  'team-gitflow': modernPolicySources[1].identity.policyVersion
});
const modernWorkflows: readonly ModernWorkflow[] = ['openspec', 'spec-kit', 'manual'];
let modernSources: readonly ModernActivationSourceContract[] | undefined;

/** Static source data only: excludes all per-project, registry-resolution and approval digests. */
export function modernActivationSourceContracts(): readonly ModernActivationSourceContract[] {
  modernSources ??= modernPolicySources.flatMap(policy => modernWorkflows.map((workflow): ModernActivationSourceContract => {
    const graph = buildModernPhaseGraph(modernSourceVersions, policy.identity, workflow);
    return {
      identity: {
        ...modernSourceVersions, ...policy.identity, workflow, phaseGraphHash: canonicalSha256(graph)
      },
      savedPlanSchemaVersion: 3, compatibilityMetadataSchemaVersion: 5,
      policyPathParts: [...policy.pathParts], graph
    };
  }));
  return freezeModernValue(structuredClone(modernSources));
}
