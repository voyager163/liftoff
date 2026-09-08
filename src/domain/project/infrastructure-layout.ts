import type {
  EnvironmentId,
  LiftoffManifest,
  ManifestProjectArtifact,
  ProjectProvisioningGroup
} from './contracts.js';

export interface InfrastructureArtifactIdentity {
  logicalName: string;
  category: 'infrastructure';
  pathParts: readonly string[];
  provisioningGroup: ProjectProvisioningGroup;
}

export type InfrastructureLayoutKind =
  | 'independent'
  | 'legacy-shared'
  | 'unknown';

export interface InfrastructureLayoutAssessment {
  kind: InfrastructureLayoutKind;
  canProvisionEnvironment: boolean;
  reason: string;
}

export interface InfrastructureProvisioningGate {
  status: 'ready' | 'migration-required';
  reason: string;
}

const azureRoot = ['infrastructure', 'opentofu', 'azure'] as const;
export const independentInfrastructureGenerationVersion = '0.11.0' as const;

export const sharedApplicationModuleIdentities = [
  ['opentofu-application-versions', 'versions.tf'],
  ['opentofu-application-variables', 'variables.tf'],
  ['opentofu-application-main', 'main.tf'],
  ['opentofu-application-outputs', 'outputs.tf']
].map(([logicalName, file]): InfrastructureArtifactIdentity => ({
  logicalName,
  category: 'infrastructure',
  pathParts: [...azureRoot, 'modules', 'application', file],
  provisioningGroup: 'base'
}));

export const retainedInfrastructureIdentities: readonly InfrastructureArtifactIdentity[] = [
  {
    logicalName: 'opentofu-readme',
    category: 'infrastructure',
    pathParts: [...azureRoot, 'README.md'],
    provisioningGroup: 'base'
  }
];

export const retiredFlatRootInfrastructureIdentities = [
  ['opentofu-versions', 'versions.tf'],
  ['opentofu-provider-lock', '.terraform.lock.hcl'],
  ['opentofu-providers', 'providers.tf'],
  ['opentofu-variables', 'variables.tf'],
  ['opentofu-main', 'main.tf'],
  ['opentofu-outputs', 'outputs.tf'],
  ['opentofu-local-state', 'backend.local.tf'],
  ['opentofu-remote-state-example', 'backend.remote.example.tf']
].map(([logicalName, file]): InfrastructureArtifactIdentity => ({
  logicalName,
  category: 'infrastructure',
  pathParts: [...azureRoot, file],
  provisioningGroup: 'base'
}));

const environmentFiles = [
  ['versions', 'versions.tf'],
  ['provider-lock', '.terraform.lock.hcl'],
  ['providers', 'providers.tf'],
  ['variables', 'variables.tf'],
  ['main', 'main.tf'],
  ['outputs', 'outputs.tf'],
  ['local-state', 'backend.local.tf'],
  ['remote-state-example', 'backend.remote.example.tf']
] as const;

export function environmentRootInfrastructureIdentities(
  environment: EnvironmentId
): InfrastructureArtifactIdentity[] {
  const root = [...azureRoot, 'environments', environment];
  const group = `environment:${environment}` as const;
  return [
    ...environmentFiles.map(([identity, file]) => ({
      logicalName: `opentofu-${environment}-${identity}`,
      category: 'infrastructure' as const,
      pathParts: [...root, file],
      provisioningGroup: group
    })),
    {
      logicalName: `opentofu-${environment}-tfvars`,
      category: 'infrastructure',
      pathParts: [...root, `${environment}.tfvars`],
      provisioningGroup: group
    }
  ];
}

export function currentInfrastructureIdentities(
  environments: readonly EnvironmentId[]
): InfrastructureArtifactIdentity[] {
  return [
    ...sharedApplicationModuleIdentities,
    ...retainedInfrastructureIdentities,
    ...environments.flatMap(environmentRootInfrastructureIdentities)
  ];
}

function isRecordedIdentity(
  artifacts: readonly ManifestProjectArtifact[],
  identity: InfrastructureArtifactIdentity,
  requiredGeneratedBy?: string
): boolean {
  return artifacts.some((artifact) =>
    artifact.logicalName === identity.logicalName &&
    artifact.category === identity.category &&
    artifact.provisioningGroup === identity.provisioningGroup &&
    artifact.pathParts.join('\0') === identity.pathParts.join('\0') &&
    (
      requiredGeneratedBy === undefined
        ? artifact.generatedBy.length > 0
        : artifact.generatedBy === requiredGeneratedBy
    ) &&
    /^sha256:[0-9a-f]{64}$/.test(artifact.generationHash)
  );
}

export function assessInfrastructureLayout(
  manifest: LiftoffManifest
): InfrastructureLayoutAssessment {
  const artifacts = manifest.projectArtifacts;
  if (
    retiredFlatRootInfrastructureIdentities.some((identity) =>
      isRecordedIdentity(artifacts, identity)
    )
  ) {
    return {
      kind: 'legacy-shared',
      canProvisionEnvironment: false,
      reason: 'Recorded infrastructure uses the legacy shared-state OpenTofu root and requires an explicit reviewed migration.'
    };
  }

  const expected = [
    ...sharedApplicationModuleIdentities,
    ...manifest.project.workload.environments.flatMap((environment) =>
      environmentRootInfrastructureIdentities(environment)
    )
  ];
  if (expected.every((identity) =>
    isRecordedIdentity(
      artifacts,
      identity,
      independentInfrastructureGenerationVersion
    )
  )) {
    return {
      kind: 'independent',
      canProvisionEnvironment: true,
      reason: 'Recorded provenance contains the shared application module and complete independent environment roots.'
    };
  }
  return {
    kind: 'unknown',
    canProvisionEnvironment: false,
    reason: 'Recorded provenance does not establish a complete supported independent-environment infrastructure layout.'
  };
}

export function infrastructureProvisioningGate(
  manifest: LiftoffManifest,
  environment: EnvironmentId
): InfrastructureProvisioningGate {
  const layout = assessInfrastructureLayout(manifest);
  return layout.canProvisionEnvironment
    ? {
        status: 'ready',
        reason: `Recorded infrastructure can provision the independent ${environment} environment root.`
      }
    : {
        status: 'migration-required',
        reason: `${layout.reason} The ${environment} environment was not provisioned.`
      };
}
