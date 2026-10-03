import { projectCatalog } from './catalog.js';
import { readManifestFile } from '../../adapters/filesystem/manifest-file.js';
import { createManifestReader } from '../../domain/project/manifest/reader.js';
import { governancePolicyVersion } from '../../repository-governance.js';
import { minimumLiftoffForManifestV7 } from '../../governance-activation/compatibility.js';
import { validateReadableActivationIdentity } from '../../domain/governance/activation/validators.js';
import { managedCoreArtifactPaths, repairManagedCoreLogicalNames } from '../../domain/project/artifact-lifecycle.js';
import type { ManifestLayoutComponentId, ManifestLayoutDescriptor, ProjectPlan } from '../../domain/project/contracts.js';
import { composeManifestPlugins, composeModernManifestPlugins, composeProjectPlugins, type ProjectPluginComposition } from './plugins.js';
import { frameworkOutputPaths } from '../../framework-validation.js';
import { OPEN_SPEC_COPILOT_CLOUD_PATHS } from '../../openspec-profile.js';
import { manifestPluginMetadataMatches, readManifestPluginMetadata, type ManifestPluginMetadata } from '../../domain/project/manifest/plugins.js';
import { createManifestV8ProjectReader } from '../../domain/project/manifest/v8-project.js';
import { exactRecord } from '../../domain/project/manifest/fields.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { toSafeProjectName } from '../../domain/project/planning.js';
import { retiredFlatRootInfrastructureIdentities } from '../../domain/project/infrastructure-layout.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';

const manifestReader = createManifestReader({
  catalog: projectCatalog,
  policyVersion: governancePolicyVersion,
  minimumLiftoffVersion: minimumLiftoffForManifestV7,
  validateActivationIdentity: validateReadableActivationIdentity,
  governanceArtifactPaths: managedCoreArtifactPaths
});

export const { parseManifest, normalizeManifestProject, normalizeManifestFramework } = manifestReader;

export async function loadManifest(projectRoot: string) {
  return parseManifest(await readManifestFile(projectRoot));
}

export interface InstalledManifestBindingContext {
  readonly plugins: ManifestPluginMetadata;
  readonly layoutDescriptor: ManifestLayoutDescriptor;
}

/** Installed declarations only; no recorded project paths or generation hashes are consulted. */
export function resolveInstalledManifestBindingContext(plan: ProjectPlan): InstalledManifestBindingContext {
  return bindingContextForComposition(composeProjectPlugins(plan));
}

function bindingContextForComposition(composition: ProjectPluginComposition): InstalledManifestBindingContext {
  const { resolution } = composition;
  return Object.freeze({
    plugins: readManifestPluginMetadata({
      schemaVersion: 1, resolutionDigest: resolution.digest, selections: resolution.plugins
    }, {
      stack: resolution.selection.stack, cloud: resolution.selection.cloud,
      workflow: resolution.selection.workflow, agents: resolution.selection.agents
    }),
    layoutDescriptor: layoutDescriptorForComposition(composition)
  });
}

export function resolveManifestLayoutDescriptor(plan: ProjectPlan): ManifestLayoutDescriptor {
  return resolveInstalledManifestBindingContext(plan).layoutDescriptor;
}

/** Resolves recorded source metadata, not a desired target or permission to access project files. */
export function resolveManifestV8SourceContract(input: unknown) {
  return resolveSourceContract(input, composeManifestPlugins).contract;
}

export function resolveModernManifestV8SourceContract(input: unknown) {
  const { contract, profile, workflow } = resolveSourceContract(input, composeModernManifestPlugins);
  if (profile === 'none') {
    return Object.freeze({ ...contract, governanceSource: Object.freeze({ profile: 'none' as const }) });
  }
  const source = modernActivationSourceContracts().find((source) =>
    source.identity.profile === profile && source.identity.workflow === workflow);
  if (!source) throw new FileSystemError('No authoritative modern governance source matches the selected profile and workflow.');
  return Object.freeze({ ...contract, governanceSource: source });
}

function resolveSourceContract(input: unknown, compose: typeof composeManifestPlugins) {
  const request = exactRecord(input, ['selection', 'recordedPlugins'], 'Manifest v8 source request');
  const selection = exactRecord(request.selection, ['project', 'framework', 'profile'], 'Manifest v8 source selection');
  const { project } = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: selection.project, framework: selection.framework
  });
  const profile = selection.profile;
  if (profile !== 'none' && profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') {
    throw new FileSystemError('Manifest v8 source profile must be none, single-maintainer-gitflow or team-gitflow.');
  }
  const workload = project.workload;
  const recorded = readManifestPluginMetadata(request.recordedPlugins, {
    stack: workload.apiStack, cloud: workload.cloud, workflow: project.specWorkflow, agents: project.agents
  });
  const composition = compose({
    workload: workload.kind,
    ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack,
    cloud: workload.cloud,
    workflow: project.specWorkflow,
    agents: project.agents,
    frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile,
    environments: workload.environments
  }, { safeProjectName: toSafeProjectName(project.name) });
  const context = bindingContextForComposition(composition);
  if (!manifestPluginMetadataMatches(recorded, context.plugins)) {
    throw new FileSystemError('Manifest v8 source plugin metadata does not match the exact installed release-owned source contract.');
  }
  const managedArtifacts = composition.expected.filter((artifact) => artifact.lifecycle === 'managed-core').map((artifact) =>
    Object.freeze({ logicalName: artifact.logicalName, category: artifact.category, pathParts: Object.freeze([...artifact.pathParts]) }));
  const requiredHandoffLogicalNames = profile === 'none' ? [] : managedArtifacts
    .filter((artifact) => !repairManagedCoreLogicalNames.some((name) => name === artifact.logicalName))
    .map((artifact) => artifact.logicalName);
  const readableProjectLogicalNames = [...new Set([
    ...composition.expected.filter((artifact) => artifact.lifecycle === 'project').map((artifact) => artifact.logicalName),
    ...retiredFlatRootInfrastructureIdentities.map((artifact) => artifact.logicalName)
  ])].sort();
  const contract = Object.freeze({
    ...context,
    managedArtifacts: Object.freeze(managedArtifacts),
    requiredHandoffLogicalNames: Object.freeze(requiredHandoffLogicalNames),
    readableProjectLogicalNames: Object.freeze(readableProjectLogicalNames)
  });
  return { contract, profile, workflow: project.specWorkflow };
}

function layoutDescriptorForComposition({ expected, resolution }: ProjectPluginComposition): ManifestLayoutDescriptor {
  const roots: readonly { id: ManifestLayoutComponentId; pathParts: readonly string[] }[] = [
    { id: 'backend', pathParts: ['backend'] },
    { id: 'database', pathParts: ['database'] },
    { id: 'frontend', pathParts: ['frontend'] },
    ...(resolution.selection.variant ? [{
      id: 'function-worker' as const, pathParts: ['functions', `${resolution.selection.variant}-worker`]
    }] : []),
    { id: 'opentofu-application', pathParts: ['infrastructure', 'opentofu', 'azure', 'modules', 'application'] },
    ...(['dev', 'staging', 'prod'] as const).map((environment) => ({
      id: `opentofu-environment:${environment}` as const,
      pathParts: ['infrastructure', 'opentofu', 'azure', 'environments', environment]
    }))
  ];
  // Membership is derived once from exact installed declarations, never from a
  // caller's custom binding or from directory contents.
  const artifacts = expected.filter((artifact) => artifact.lifecycle === 'project').map((artifact) => {
    const component = roots.find((root) => artifact.pathParts.length > root.pathParts.length &&
      root.pathParts.every((part, index) => artifact.pathParts[index] === part));
    return Object.freeze({
      logicalName: artifact.logicalName,
      ...(component ? { component: component.id } : {})
    });
  }).sort((left, right) => left.logicalName < right.logicalName ? -1 : left.logicalName > right.logicalName ? 1 : 0);
  const components = roots.filter((root) => artifacts.some((artifact) => artifact.component === root.id)).map((root) => root.id);
  const protectedPaths = [
    ...expected.filter((artifact) => artifact.lifecycle !== 'project').map((artifact) => artifact.pathParts),
    ['openspec'], ['.specify'], ['specs'],
    ['governance', 'activation-state.json'], ['governance', 'activation-baseline.json'],
    ['governance', 'migration-state.json'],
    ...['history', 'evidence', 'plans', 'approvals', 'supersessions', 'reconciliation', 'credentials'].map((name) => ['governance', name]),
    ...projectCatalog.specWorkflows.flatMap((workflow) => frameworkOutputPaths({
      workflow: workflow.id, agents: projectCatalog.codingAgents.map((agent) => agent.id)
    })),
    ...OPEN_SPEC_COPILOT_CLOUD_PATHS,
    ...[...managedCoreArtifactPaths.values()]
  ].map((parts) => Object.freeze([...parts]));
  return Object.freeze({
    components: Object.freeze(components),
    artifacts: Object.freeze(artifacts),
    protectedPaths: Object.freeze(protectedPaths)
  });
}
