import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseManifest, resolveModernManifestV8SourceContract } from '../../src/application/project/manifest.js';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { createManifestV8ProjectReader } from '../../src/domain/project/manifest/v8-project.js';
import type { ManifestActiveLayout, ManifestLayoutComponentId } from '../../src/domain/project/contracts.js';
import { completedSpecKitTasks } from '../../src/governance-activation/spec-kit-seed.js';
import { fixture, write } from './manifest-update.js';
import { selected, writeModernHistoricalSource, writeModernSuccessor } from './modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './modern-local-project.js';
import { spec } from '../modern-openspec-fixtures.js';

export async function revalidationProject(completed = true, version: 1 | 2 | 3 = 3, retained = false, workflow:'spec-kit'|'openspec'='spec-kit') {
  const f = await fixture();
  await writeModernHistoricalSource(f.root, version, retained, workflow==='spec-kit'?workflow:undefined);
  const manifest = parseManifest(JSON.parse(await fs.readFile(path.join(f.root, 'liftoff.manifest.json'), 'utf8')));
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
  const selection = selected(leaf, 'single-maintainer-gitflow');
  const source = resolveModernManifestV8SourceContract({ selection: selection.selection, recordedPlugins: selection.plugins });
  const components = new Map<ManifestLayoutComponentId, string[]>(source.layoutDescriptor.components.map(id => [id, ['Source Space', id.replace(':', ' ')]]));
  const compose = ['compose.yml'], layout: ManifestActiveLayout = { schemaVersion: 1, state: 'bound', bindings: [
    ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
    { kind: 'artifact', logicalName: 'docker-compose', pathParts: compose }
  ] };
  const successor = await writeModernSuccessor(f.root, version, retained, false, false, { layout, ...(workflow==='spec-kit'?{workflow}:{}) });
  const put = (parts: readonly string[], content: string | Buffer) => write(f.root, parts, content);
  let tasks = await writeModernLocalFixtureInputs(leaf, components, compose, put);
  if (!tasks) throw new Error('Expected initialized framework source fixture.');
  if(workflow==='openspec'){
    const base=tasks.slice(0,-1),workload=leaf.project.workload,
      capability=`${workload.kind==='genai'?workload.pattern:workload.apiStack}-application-baseline`,
      archived=['openspec','changes','archive',`2026-10-01-${base[2]}`];
    await put(['openspec','config.yaml'],'schema: spec-driven\ncontext: Preserve the existing successor source and original history.\n');
    await put([...base,'proposal.md'],`## Why\nPreserve local inputs.\n\n## What Changes\nObserve readonly source.\n\n## Capabilities\n\n### New Capabilities\n- \`${capability}\`: Preserve source.\n\n## Impact\nLocal observation only.\n`);
    await put([...base,'design.md'],'## Context\nExisting source.\n\n## Goals / Non-Goals\nNo historical execution claim.\n\n## Decisions\nPreserve source.\n\n## Risks / Trade-offs\nNo sandbox claim.\n');
    await put([...base,'specs',capability,'spec.md'],spec('Preserve '+capability,true));
    await put(['openspec','specs',capability,'spec.md'],spec('Preserve '+capability));
    await put(tasks,`- [${completed?'x':' '}] 1.1 Existing historical task, not prior execution proof.\r\n`);
    await fs.mkdir(path.join(f.root,'openspec','changes','archive'),{recursive:true});
    await fs.rename(path.join(f.root,...base),path.join(f.root,...archived));
    tasks=[...archived,'tasks.md'];
  }else if(completed)await put(tasks,completedSpecKitTasks(await fs.readFile(path.join(f.root,...tasks),'utf8')));
  return { ...f, successor, tasks, put, components };
}
