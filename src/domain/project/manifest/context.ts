import type { ProjectCatalog } from '../catalog.js';
import type { LiftoffManifest } from '../contracts.js';
import type { StandardsProfileCatalog } from '../../standards/profile-schema.js';

type EnabledGovernance = Exclude<
  LiftoffManifest['governance'],
  { profile: 'none' | 'unspecified' }
>;

export interface ManifestContractContext {
  catalog: Pick<
    ProjectCatalog,
    | 'getApiStack'
    | 'canonicalizeCodingAgents'
    | 'getEnvironment'
    | 'getGovernanceProfile'
    | 'getCodingAgent'
    | 'getPattern'
    | 'getProvider'
    | 'getProjectType'
    | 'getSpecWorkflow'
    | 'listRegions'
  >;
  policyVersion: string;
  minimumLiftoffVersion: string;
  governanceArtifactPaths: ReadonlyMap<string, readonly string[]>;
  validateActivationIdentity(value: unknown): NonNullable<EnabledGovernance['activationIdentity']>;
  currentStandards?(): { profiles: StandardsProfileCatalog; resourceCatalogDigest: string };
}
