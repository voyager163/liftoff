import {
  mkdir,
  mkdtemp,
  rm
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  artifactPath
} from '../../adapters/filesystem/project-paths.js';
import {
  assertNewOrEmptyDirectory,
  writeArtifacts,
  writeProjectFile
} from '../../adapters/filesystem/project-files.js';
import {
  buildProjectPlan
} from '../project/planning.js';
import {
  buildArtifacts
} from '../../templates.js';
import type {
  ProjectOptions
} from '../../domain/project/contracts.js';

export async function createFixtureProject(options: ProjectOptions): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-'));
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const target = artifactPath(tempRoot, [plan.safeProjectName]);
  await mkdir(target, { recursive: true });
  await assertNewOrEmptyDirectory(target);
  await rm(target, { recursive: true, force: true });
  await writeArtifacts(target, buildArtifacts(plan));
  for (const marker of [
    ...plan.framework.baseMarkers,
    ...plan.agents.flatMap((agent) => plan.framework.agentMarkers[agent.id])
  ]) {
    let content = 'fixture marker\n';
    if (marker.join('/') === '.specify/integration.json') {
      const installed = plan.agents.map((agent) => agent.integrationIds['spec-kit']);
      const defaultIntegration = plan.defaultAgent?.integrationIds['spec-kit'];
      content = `${JSON.stringify({
        integration_state_schema: 1,
        integration: defaultIntegration,
        default_integration: defaultIntegration,
        installed_integrations: installed,
        integration_settings: {}
      }, null, 2)}\n`;
    } else if (marker.join('/') === '.specify/init-options.json') {
      content = '{}\n';
    }
    await writeProjectFile(target, marker, content);
  }
  return target;
}