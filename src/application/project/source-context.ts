import type {
  ManifestActiveLayout, ManifestLayoutBinding, ManifestLayoutComponentId
} from '../../domain/project/contracts.js';
import type { ManifestV8ProjectLeaf } from '../../domain/project/manifest/v8-project.js';
import { createManifestV8ProjectReader } from '../../domain/project/manifest/v8-project.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { exactRecord } from '../../domain/project/manifest/fields.js';
import { readManifestPluginMetadata, type ManifestPluginMetadata } from '../../domain/project/manifest/plugins.js';
import { validateManifestActiveLayout } from '../../domain/project/manifest/layout.js';
import type { ModernGovernanceProfile } from '../../domain/governance/activation/modern-record-contracts.js';
import { assertModernRecordData } from '../../domain/governance/activation/source-values.js';
import { projectCatalog } from './catalog.js';
import { resolveModernManifestV8SourceContract } from './manifest.js';
import { composeModernManifestPlugins } from './plugins.js';
import { toSafeProjectName } from '../../domain/project/planning.js';

export interface ModernProjectSourceInput {
  readonly selection: ManifestV8ProjectLeaf & { readonly profile: 'none' | ModernGovernanceProfile };
  readonly plugins: ManifestPluginMetadata;
  readonly activeLayout: ManifestActiveLayout;
}

export interface ModernProjectSourceContext extends ModernProjectSourceInput {
  readonly source: ReturnType<typeof resolveModernManifestV8SourceContract>;
}

/** Source metadata only; neither original generation paths nor inspection or execution authority. */
export function resolveModernProjectSourceContext(value: unknown): ModernProjectSourceContext {
  // Keep the original managed-core diagnostics compatible with existing callers.
  assertModernRecordData(value, 'modern managed-core input');
  const input = exactRecord(value, ['selection', 'plugins', 'activeLayout'], 'Modern managed-core input');
  const selected = exactRecord(input.selection, ['project', 'framework', 'profile'], 'Modern managed-core selection');
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: selected.project, framework: selected.framework
  });
  const profile = selected.profile;
  if (profile !== 'none' && profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') {
    throw new Error('Modern managed-core selection requires a supported explicit profile.');
  }
  const selection: ModernProjectSourceInput['selection'] = { ...leaf, profile };
  const plugins = readManifestPluginMetadata(input.plugins, {
    stack: leaf.project.workload.apiStack, cloud: leaf.project.workload.cloud,
    workflow: leaf.project.specWorkflow, agents: leaf.project.agents
  });
  const source = resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins });
  const activeLayout = validateManifestActiveLayout(input.activeLayout, source.layoutDescriptor);
  return { selection, plugins, activeLayout, source };
}

export function modernProjectSourceInput(manifest: LiftoffManifestV8): ModernProjectSourceInput {
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: manifest.project, framework: manifest.framework
  });
  return {
    selection: { ...leaf, profile: manifest.governance.profile },
    plugins: manifest.plugins, activeLayout: manifest.activeLayout
  };
}

export function resolveModernManifestSourceContext(manifest: LiftoffManifestV8): ModernProjectSourceContext {
  return resolveModernProjectSourceContext(modernProjectSourceInput(manifest));
}

export function resolveModernComparisonContext(
  source: ModernProjectSourceContext,
  profile: ModernProjectSourceInput['selection']['profile']
): ModernProjectSourceContext {
  const workload = source.selection.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind,
    stack: workload.apiStack,
    cloud: workload.cloud,
    ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    workflow: source.selection.project.specWorkflow,
    agents: source.selection.project.agents,
    frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile,
    environments: workload.environments
  }, {
    safeProjectName: toSafeProjectName(source.selection.project.name)
  });
  const plugins = readManifestPluginMetadata({
    schemaVersion: 1,
    resolutionDigest: composition.resolution.digest,
    selections: composition.resolution.plugins
  }, {
    stack: workload.apiStack,
    cloud: workload.cloud,
    workflow: source.selection.project.specWorkflow,
    agents: source.selection.project.agents
  });
  return resolveModernProjectSourceContext({
    selection: { ...source.selection, profile },
    plugins,
    activeLayout: source.activeLayout
  });
}

export function findModernActiveComponentBinding(
  context: ModernProjectSourceContext, component: ManifestLayoutComponentId
): Extract<ManifestLayoutBinding, { kind: 'component' }> | undefined {
  if (!context.source.layoutDescriptor.components.includes(component)) {
    throw new Error('Active component lookup requires an identity declared by the selected source.');
  }
  const bindings: readonly ManifestLayoutBinding[] = context.activeLayout.bindings;
  return bindings.find((binding): binding is Extract<ManifestLayoutBinding, { kind: 'component' }> =>
    binding.kind === 'component' && binding.component === component);
}

export function findModernActiveArtifactBinding(
  context: ModernProjectSourceContext, logicalName: string
): Extract<ManifestLayoutBinding, { kind: 'artifact' }> | undefined {
  if (!context.source.layoutDescriptor.artifacts.some(artifact => artifact.logicalName === logicalName)) {
    throw new Error('Active artifact lookup requires an identity declared by the selected source.');
  }
  const bindings: readonly ManifestLayoutBinding[] = context.activeLayout.bindings;
  return bindings.find((binding): binding is Extract<ManifestLayoutBinding, { kind: 'artifact' }> =>
    binding.kind === 'artifact' && binding.logicalName === logicalName);
}
