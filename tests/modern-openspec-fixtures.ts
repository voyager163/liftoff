import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {projectCatalog} from '../src/application/project/catalog.js';
import {composeModernManifestPlugins} from '../src/application/project/plugins.js';
import {resolveModernManifestV8SourceContract} from '../src/application/project/manifest.js';
import {createManifestV8ProjectReader} from '../src/domain/project/manifest/v8-project.js';
import {createManifestV8Reader} from '../src/domain/project/manifest/v8.js';
import {readManifestPluginMetadata} from '../src/domain/project/manifest/plugins.js';
import {buildModernManagedCore} from '../src/application/project/modern-managed-core.js';
import {createModernGovernanceContextContract} from '../src/domain/governance/policy/modern-context.js';
import {modernActivationSourceContracts} from '../src/domain/governance/policy/identity.js';
import {frameworkOutputPaths} from '../src/framework-validation.js';
import {rawLocalDigest} from '../src/domain/governance/activation/modern-local-inputs.js';

export const selected='bootstrap-openspec-execution-fixture',capability='node-fastify-application-baseline';
export function spec(title:string,delta=false){
  return `${delta?'## ADDED Requirements':'## Purpose\n\nThis capability preserves bounded local contract inputs without remote execution or source publication.\n\n## Requirements'}\n\n### Requirement: ${title}\nThe system SHALL preserve input.\n\n#### Scenario: Observe source\n- **WHEN** the input is inspected\n- **THEN** its original bytes remain unchanged\n`;
}
export async function createOpenSpecExecutionFixture(roots:{path:string;ino:number;dev:number}[],
  profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none'){
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'ob2-contract-'))),owner=await lstat(directory);
  roots.push({path:directory,ino:owner.ino,dev:owner.dev});const root=path.join(directory,'project');await mkdir(root);
  async function put(parts:readonly string[],text:string){const file=path.join(root,...parts);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:{name:'OpenSpec Execution Fixture',
    workload:{kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:true,environments:['dev']},specWorkflow:'openspec',agents:['github-copilot']},
    framework:{state:'initialized',adapter:'openspec',contractVersion:projectCatalog.getFrameworkDefinition('openspec').version}});
  const selection={...leaf,profile},resolution=composeModernManifestPlugins({workload:'standard',stack:'node-fastify',cloud:'azure',workflow:'openspec',
    agents:['github-copilot'],frontend:'included',environments:['dev'],governanceProfile:profile},{safeProjectName:'openspec-execution-fixture'}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},{stack:'node-fastify',cloud:'azure',workflow:'openspec',agents:['github-copilot']});
  const source=resolveModernManifestV8SourceContract({selection,recordedPlugins:plugins}),activeLayout={schemaVersion:1,state:'bound',
    bindings:[...source.layoutDescriptor.components.map(component=>({kind:'component',component,pathParts:['Source Space',component.replace(':',' ')]})),
      {kind:'artifact',logicalName:'docker-compose',pathParts:['compose.yml']}]};
  const ctx={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract},input={selection,plugins,activeLayout},core=buildModernManagedCore(input),
    context=profile==='none'?undefined:createModernGovernanceContextContract(ctx).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(ctx).parseManifestV8({artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,
    project:leaf.project,framework:leaf.framework,plugins,activeLayout,
    governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(f=>({logicalName:f.logicalName,category:f.category,pathParts:f.pathParts,contentHash:`sha256:${rawLocalDigest(f.content)}`})),projectArtifacts:[],adoptionObservations:[]});
  await put(['liftoff.manifest.json'],JSON.stringify(manifest)+'\n');for(const f of core)await put(f.pathParts,f.content);
  for(const component of source.layoutDescriptor.components){
    const parts=['Source Space',component.replace(':',' ')];
    if(component==='backend'){
      await put([...parts,'package.json'],'{"name":"ob2-backend","version":"1.0.0","scripts":{"test":"node --test"}}');
      await put([...parts,'tests','input.test.cjs'],'require("node:test")("owned baseline",()=>require("node:assert/strict").equal(2+2,4));');
    }else if(component==='frontend'){
      await put([...parts,'package.json'],'{"name":"ob2-frontend","version":"1.0.0","scripts":{"build":"node build.cjs"}}');
      await put([...parts,'build.cjs'],'require("node:fs").mkdirSync("dist");require("node:fs").writeFileSync("dist/index.html","owned");');
    }else if(component.startsWith('opentofu-'))await put([...parts,'main.tf'],'locals {\n  enabled = true\n}\n');
    else await put([...parts,'source.txt'],'Owned local source.\n');
  }
  await put(['compose.yml'],'services:\n  app:\n    image: example/local:source\n');
  for(const parts of frameworkOutputPaths({workflow:'openspec',agents:['github-copilot']}))await put(parts,'Preinitialized contract fixture, not official initializer provenance.\n');
  await put(['openspec','config.yaml'],'schema: spec-driven\n');await mkdir(path.join(root,'openspec','changes','archive'),{recursive:true});
  async function change(name:string,cap:string){
    const parts=['openspec','changes',name];
    await put([...parts,'.openspec.yaml'],'schema: spec-driven\n');
    await put([...parts,'proposal.md'],`## Why\nPreserve local inputs.\n\n## What Changes\nObserve readonly input.\n\n## Capabilities\n\n### New Capabilities\n- \`${cap}\`: Preserve the original bounded input.\n\n## Impact\nOnly local observation.\n`);
    await put([...parts,'design.md'],'## Context\nOwned source.\n\n## Goals / Non-Goals\nNo publication.\n\n## Decisions\nPreserve inputs.\n\n## Risks / Trade-offs\nNo sandbox claim.\n');
    await put([...parts,'tasks.md'],'- [ ] 1.1 Review source.\r\n- [ ] 1.2 Run separately authorized tofu init before finalization.\r\n');
    await put([...parts,'specs',cap,'spec.md'],spec('Preserve '+cap,true));
  }
  await change(selected,capability);await change('unrelated-change','unrelated-capability');
  await put(['openspec','specs','existing-capability','spec.md'],spec('Preserve existing capability'));
  return {root,put,change,manifest};
}
export async function originalFiles(root:string){
  const out:Record<string,unknown>={};
  async function walk(parts:string[]){
    for(const entry of await readdir(path.join(root,...parts),{withFileTypes:true})){
      const next=[...parts,entry.name],file=path.join(root,...next),st=await lstat(file,{bigint:true});
      if(entry.isDirectory())await walk(next);
      else out[next.join('/')]={digest:rawLocalDigest(await readFile(file)),ino:String(st.ino),mode:String(st.mode),mtime:String(st.mtimeNs)};
    }
  }
  await walk([]);return out;
}
