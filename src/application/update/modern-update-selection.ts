import { parseProjectConfigOptions } from '../../adapters/filesystem/project-config.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { catalogKey } from '../../domain/project/inputs.js';
import { createManifestV8ProjectReader } from '../../domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../../domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../../domain/project/planning.js';
import { parseHistoryJson } from '../../governance-activation/history-contracts.js';
import { copySourceHistoryData, createSourceHistoryCapture } from '../../governance-activation/source-history-capture.js';
import { projectCatalog } from '../project/catalog.js';
import { parseProjectManifest } from '../project/manifest.js';
import { resolveModernProjectSourceContext, type ModernProjectSourceInput } from '../project/source-context.js';
import { composeModernManifestPlugins } from '../project/plugins.js';

export interface RecordedModernUpdateSelection {
  readonly kind: 'recorded-project-intent';
}

export type ModernUpdateSelection = ModernProjectSourceInput | RecordedModernUpdateSelection;

export function isRecordedModernUpdateSelection(value: ModernUpdateSelection): value is RecordedModernUpdateSelection {
  if (!Object.hasOwn(value, 'kind')) return false;
  if (Object.keys(value).length !== 1 || !('kind' in value) || value.kind !== 'recorded-project-intent') {
    throw new FileSystemError('Recorded update selection requires only kind: recorded-project-intent.');
  }
  return true;
}

/** Captured desired state constrains core maintenance; it cannot authorize an identity transition. */
export async function readRecordedModernUpdateSelection(projectRoot: string) {
  const reader = await createSourceHistoryCapture(projectRoot);
  const original = await reader.capture(['liftoff.manifest.json']);
  const manifest = parseProjectManifest(parseHistoryJson(original.content, 'update source manifest'));
  const configuration = await reader.capture(['liftoff.config.json'], true);
  const config = configuration.content === undefined ? {} : parseProjectConfigOptions(
    copySourceHistoryData(parseHistoryJson(configuration.content, 'update desired configuration'), 'update desired configuration'),
    {
      ...projectCatalog,
      getSpecWorkflow: value => catalogKey(value) === 'manual' ? { id: 'manual' } : projectCatalog.getSpecWorkflow(value),
      getGovernanceProfile: value => catalogKey(value) === 'teamgitflow'
        ? { id: 'team-gitflow' } : projectCatalog.getGovernanceProfile(value)
    },
    { allowEmptyAgents: true }
  );
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: manifest.project, framework: manifest.framework
  });
  const profile = manifest.governance.profile === 'unspecified'
    ? config.governanceProfile ?? 'single-maintainer-gitflow' : manifest.governance.profile;
  if (profile !== 'none' && profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') {
    throw new FileSystemError('Modern update requires a supported recorded governance profile.');
  }
  if (manifest.artifactVersion !== 8 && profile === 'team-gitflow') {
    throw new FileSystemError('A historical core update cannot introduce team policy; profile changes require a separate reviewed operation.');
  }
  const workload = leaf.project.workload;
  const expected = [
    ['projectName', leaf.project.name],
    ['projectType', workload.kind],
    ['apiStack', workload.apiStack],
    ['pattern', workload.kind === 'genai' ? workload.pattern : undefined],
    ['cloud', workload.cloud],
    ['region', workload.region],
    ['includeFrontend', workload.frontend],
    ['specWorkflow', leaf.project.specWorkflow],
    ['agents', leaf.project.agents],
    ['defaultAgent', leaf.project.defaultAgent],
    ['governanceProfile', profile]
  ] as const;
  const deferredConfiguration: ('agents' | 'defaultAgent')[] = [];
  for (const [field, recorded] of expected) {
    const requested = field === 'projectName' ? config.projectName?.trim() : config[field];
    if (requested === undefined || (recorded !== undefined && canonicalJson(requested) === canonicalJson(recorded))) continue;
    if (leaf.framework.state === 'legacy' && (field === 'agents' || field === 'defaultAgent')) {
      deferredConfiguration.push(field);
      continue;
    }
    throw new FileSystemError(
      `Configuration field ${field} changes recorded project intent. Core update preserves workload, workflow, agents and profile; ` +
      'a separately supported migration, workflow transition or repair is required.'
    );
  }
  if (config.environments !== undefined &&
    canonicalJson([...config.environments].sort()) !== canonicalJson([...workload.environments].sort())) {
    throw new FileSystemError('Configuration field environments changes recorded workload intent; core update cannot apply that migration.');
  }
  let selection: ModernProjectSourceInput;
  if (manifest.artifactVersion === 8) {
    selection = { selection: { ...leaf, profile }, plugins: manifest.plugins, activeLayout: manifest.activeLayout };
  } else {
    const composition = composeModernManifestPlugins({
      workload: workload.kind, stack: workload.apiStack, cloud: workload.cloud,
      ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
      workflow: leaf.project.specWorkflow, agents: leaf.project.agents,
      frontend: workload.frontend ? 'included' : 'omitted', governanceProfile: profile, environments: workload.environments
    }, { safeProjectName: toSafeProjectName(leaf.project.name) });
    selection = {
      selection: { ...leaf, profile },
      plugins: readManifestPluginMetadata({
        schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
      }, { stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents }),
      activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] }
    };
  }
  const resolved = resolveModernProjectSourceContext(selection);
  await reader.assertRoot();
  return {
    selection: { selection: resolved.selection, plugins: resolved.plugins, activeLayout: resolved.activeLayout },
    snapshots: reader.observations(),
    deferredConfiguration
  };
}
