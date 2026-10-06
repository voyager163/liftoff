import { createHash } from 'node:crypto';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../../src/application/project/manifest.js';
import type { ManifestV8WriteRequest } from '../../src/application/project/manifest-writer.js';
import { buildModernManagedCore } from '../../src/application/project/modern-managed-core.js';
import { composeModernManifestPlugins } from '../../src/application/project/plugins.js';
import type { ModernProjectSourceInput } from '../../src/application/project/source-context.js';
import { validateManifestActiveLayout } from '../../src/domain/project/manifest/layout.js';
import { readManifestPluginMetadata } from '../../src/domain/project/manifest/plugins.js';
import { createManifestV8ProjectReader } from '../../src/domain/project/manifest/v8-project.js';

export type AdoptionRequest = Extract<ManifestV8WriteRequest, { origin: 'adoption' }>;

export function adoptionFixture(
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma' = 'node-fastify',
  profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow' = 'none',
  workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual'
): { request: AdoptionRequest; source: ModernProjectSourceInput } {
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: {
      name: 'Preserved Application',
      workload: { kind: 'standard', apiStack: stack, cloud: 'azure', region: 'eastus', frontend: false, environments: ['dev', 'prod'] },
      specWorkflow: workflow, agents: workflow === 'manual' ? [] : ['claude'],
      ...(workflow === 'spec-kit' ? { defaultAgent: 'claude' } : {})
    },
    framework: workflow === 'manual' ? { state: 'not-required' } :
      { state: 'initialized', adapter: workflow, contractVersion: projectCatalog.getFrameworkDefinition(workflow).version }
  });
  const selection = { ...leaf, profile };
  const composition = composeModernManifestPlugins({
    workload: 'standard', stack, cloud: 'azure', workflow, agents: leaf.project.agents,
    frontend: 'omitted', governanceProfile: profile, environments: leaf.project.workload.environments
  }, { safeProjectName: 'preserved-application' });
  const plugins = readManifestPluginMetadata({
    schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
  }, { stack, cloud: 'azure', workflow, agents: leaf.project.agents });
  const contract = resolveModernManifestV8SourceContract({ selection, recordedPlugins: plugins });
  const backend = composition.expected.find(entry => entry.lifecycle === 'project' && entry.category === 'backend');
  if (!backend) throw new Error('Actual selected source has no backend fixture artifact.');
  const backendRoot = ['Existing Services', 'API With Spaces'];
  const backendPath = [...backendRoot, ...backend.pathParts.slice(1)];
  const activeLayout = validateManifestActiveLayout({
    schemaVersion: 1, state: 'bound', bindings: [
      { kind: 'component', component: 'backend', pathParts: backendRoot },
      { kind: 'artifact', logicalName: backend.logicalName, pathParts: backendPath },
      { kind: 'artifact', logicalName: 'root-readme', pathParts: ['README.md'] }
    ]
  }, contract.layoutDescriptor);
  const source = { selection, plugins, activeLayout };
  const sha = (content: string): `sha256:${string}` =>
    `sha256:${createHash('sha256').update(content).digest('hex')}`;
  return {
    source,
    request: {
      origin: 'adoption', selection, activeLayout,
      managed: buildModernManagedCore(source).map(artifact => ({
        kind: 'bytes', logicalName: artifact.logicalName, category: artifact.category,
        pathParts: [...artifact.pathParts], content: artifact.content
      })),
      adoptionObservations: [
        { logicalName: 'root-readme', pathParts: ['README.md'], observedHash: sha('Original application documentation\r\n') },
        { logicalName: backend.logicalName, pathParts: backendPath, observedHash: sha('Original customized application bytes\n') }
      ]
    }
  };
}
