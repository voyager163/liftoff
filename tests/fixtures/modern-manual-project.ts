import path from 'node:path';
import os from 'node:os';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { afterEach, vi } from 'vitest';
import { buildCurrentProjectPlan } from '../../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../../src/templates.js';
import { writeArtifacts } from '../../src/file-system.js';
import { createManifestV8Reader } from '../../src/domain/project/manifest/v8.js';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../../src/application/project/manifest.js';
import { NodeCommandRunner } from '../../src/process-runner.js';
import type { ApplicationPreparationRequest } from '../../src/application/repair/application-preparation-types.js';
import type { CodingAgentId, ProjectOptions } from '../../src/domain/project/contracts.js';
import type { ManualNativeExecutionScopes } from '../../src/domain/governance/activation/modern-local-runtime.js';

export const manualScopes: ManualNativeExecutionScopes = {
  projectCode: true, hostCapabilitiesAcknowledged: true, dependencyPreparation: true, dependencyNetwork: true,
  infrastructurePreparation: true, infrastructureNetwork: true, workflowFinalization: false, publishLocalRecords: false
};
const fixtures: { directory: string; complete: boolean; identity: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    if (fixture.complete) {
      const stat = await lstat(fixture.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}:${stat.uid}` !== fixture.identity) {
        throw new Error('Manual fixture root identity changed; no cleanup performed.');
      }
      await rm(fixture.directory, { recursive: true });
    }
    else console.warn(`Manual execution fixture retained without a cleanup claim: ${fixture.directory}`);
  }
});

export async function generatedManualFixture(options: {
  profile?: 'none' | 'single-maintainer-gitflow'; frontend?: boolean; environments?: readonly string[];
  workload?: Pick<ProjectOptions, 'projectType' | 'apiStack' | 'pattern'>; agents?: readonly CodingAgentId[]
} = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-manual-native-engine-')));
  const stat = await lstat(directory);
  const retained = { directory, complete: false, identity: `${stat.dev}:${stat.ino}:${stat.uid}` }; fixtures.push(retained);
  const project = path.join(directory, 'project'), home = path.join(directory, 'home');
  await mkdir(project); await mkdir(home, { mode: 0o700 });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
    projectName: 'Native Manual Engine', ...(options.workload ?? { projectType: 'standard', apiStack: 'node-fastify' }),
    specWorkflow: 'manual', agents: [...(options.agents ?? [])], governanceProfile: options.profile ?? 'none',
    includeFrontend: options.frontend ?? false, environments: [...(options.environments ?? ['dev'])]
  }, { requireProjectName: true }));
  await writeArtifacts(project, artifacts);
  const manifest = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract })
    .parseManifestV8(JSON.parse(artifacts.find(artifact => artifact.pathParts.join('/') === 'liftoff.manifest.json')!.content));
  const preparation: ApplicationPreparationRequest[] = [];
  for (const binding of manifest.activeLayout.bindings) {
    if (binding.kind !== 'component' || !['backend', 'frontend'].includes(binding.component)) continue;
    const node = binding.component === 'frontend' || manifest.project.workload.apiStack === 'node-fastify';
    const python = manifest.project.workload.apiStack === 'python-fastapi';
    preparation.push({
      provider: node ? 'npm-ci' : python ? 'uv-locked-sync' : 'go-mod-download',
      version: 1, cwdPathParts: [...binding.pathParts], packageSource: node ? 'npmjs' : python ? 'pypi' : 'go-proxy',
      network: true, lifecycle: 'disabled'
    });
  }
  return { retained, directory, project, home, artifacts, preparation };
}

export function recordManualCommands() {
  const original = NodeCommandRunner.prototype.run, commands: object[] = [];
  vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
    const observation = { command, cwd: options?.cwd, returned: false };
    commands.push(observation);
    const result = await original.call(this, command, options);
    Object.assign(observation, { returned: true, status: result.status, settled: result.processTreeSettled,
      timedOut: result.timedOut, ...(result.status !== 0 ? { stdout: result.stdout, stderr: result.stderr } : {}) });
    return result;
  });
  return commands;
}
