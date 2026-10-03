import {parse as parseYaml} from 'yaml';
import type {ApplicationFiles} from '../repair/application-files.js';
import type {LiftoffManifestV8} from '../../domain/project/manifest/v8.js';
import {capturedFileBytes,localInputFailure,type ModernLocalSnapshot} from '../../domain/governance/activation/modern-local-inputs.js';
import {canonicalSha256} from '../../domain/governance/activation/canonical-json.js';
import {openSpecReadSetPolicy,validateOpenSpecExecutionInputs,type OpenSpecExecutionInputs} from '../../domain/governance/activation/modern-openspec-execution.js';
import {toSafeProjectName} from '../../domain/project/planning.js';
import {isRecord,exactRecord} from '../../domain/project/manifest/fields.js';
import {buildProjectPlan} from '../project/planning.js';
import {renderOpenSpecConfig,renderSeedTasks} from '../../generators/common/spec-workflow.js';
import {frameworkOutputPaths} from '../../framework-validation.js';
import {rawLocalDigest} from '../../domain/governance/activation/modern-local-inputs.js';
import {validateOpenSpecInitialization,type OpenSpecInitialization} from '../../domain/governance/activation/modern-openspec-obligations.js';

export async function captureCompleteOpenSpecInputs(files:ApplicationFiles):Promise<void>{
  async function directory(parts:string[],allowed:(name:string,kind:string)=>boolean){
    const observed=await files.inventory(parts);
    if(!observed.exists)localInputFailure(`OpenSpec complete read-set directory is missing: ${parts.join('/')}`);
    for(const entry of observed.entries)if(!allowed(entry.name,entry.kind))localInputFailure(`OpenSpec unsupported input scope: ${[...parts,entry.name].join('/')}`);
    return observed;
  }
  const named=(name:string)=>/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name);
  async function capabilities(parts:string[]){
    const entries=await directory(parts,(name,kind)=>kind==='directory'&&named(name)||name==='.gitkeep'&&kind==='file');
    for(const entry of entries.entries){
      if(entry.name==='.gitkeep'){await files.read([...parts,entry.name]);continue;}
      await directory([...parts,entry.name],(name,kind)=>name==='spec.md'&&kind==='file');
      await files.read([...parts,entry.name,'spec.md']);
    }
  }
  await directory(['openspec'],(name,kind)=>name==='config.yaml'&&kind==='file'||['changes','specs'].includes(name)&&kind==='directory');
  await files.read(['openspec','config.yaml']);
  const active=await directory(['openspec','changes'],(name,kind)=>kind==='directory'&&(name==='archive'||named(name))||name==='.gitkeep'&&kind==='file');
  const archive=await files.inventory(['openspec','changes','archive']);
  if(archive.entries.some(e=>e.name!=='.gitkeep'||e.kind!=='file'))localInputFailure('OpenSpec archived histories require separate execution applicability; no inactive change is executed.');
  if(archive.entries.length)await files.read(['openspec','changes','archive','.gitkeep']);
  for(const entry of active.entries){
    if(entry.name==='archive')continue;
    if(entry.name==='.gitkeep'){await files.read(['openspec','changes',entry.name]);continue;}
    const parts=['openspec','changes',entry.name];
    await directory(parts,(name,kind)=>name==='specs'&&kind==='directory'||['.openspec.yaml','proposal.md','design.md','tasks.md'].includes(name)&&kind==='file');
    for(const name of ['.openspec.yaml','proposal.md','design.md','tasks.md'])await files.read([...parts,name]);
    await capabilities([...parts,'specs']);
  }
  await capabilities(['openspec','specs']);
}
export function deriveCompleteOpenSpecInputs(snapshot:ModernLocalSnapshot,manifest:LiftoffManifestV8,initialization?:OpenSpecInitialization):OpenSpecExecutionInputs{
  if(manifest.project.specWorkflow!=='openspec'||manifest.framework.state!=='initialized')localInputFailure('Complete OpenSpec execution requires initialized OpenSpec source.');
  const files=new Map(snapshot.files.map(f=>[f.pathParts.join('/'),f]));
  function text(parts:string[]):string{
    const file=files.get(parts.join('/')),bytes=file&&capturedFileBytes(file);
    if(!bytes?.length)localInputFailure('OpenSpec planning/current capability input is empty or absent.');
    const value=bytes.toString('utf8');if(!Buffer.from(value).equals(bytes)||value.includes('\0'))localInputFailure('OpenSpec inputs require UTF8 text.');
    return value;
  }
  function schema(parts:string[],metadata=false){
    let value:unknown;try{value=parseYaml(text(parts));}catch{localInputFailure('OpenSpec schema configuration is invalid YAML.');}
    if(!isRecord(value))localInputFailure('OpenSpec schema configuration must be an object.');
    exactRecord(value,metadata&&'created'in value?['schema','created']:['schema'],'Supported OpenSpec schema configuration');
    if(value.schema!=='spec-driven'||'created'in value&&(typeof value.created!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value.created)))localInputFailure('OpenSpec custom schema or metadata is unsupported.');
  }
  if(initialization){
    validateOpenSpecInitialization(initialization);
    if(canonicalSha256(parseYaml(text(['openspec','config.yaml'])))!==canonicalSha256(initialization.config))localInputFailure('Generated config differs from its exact reviewed source.');
  }else schema(['openspec','config.yaml']);
  const changeName=`bootstrap-${toSafeProjectName(manifest.project.name)}`,capability=`${manifest.project.workload.kind==='genai'?manifest.project.workload.pattern:manifest.project.workload.apiStack}-application-baseline`;
  const changes=snapshot.directories.find(d=>d.pathParts.join('/')==='openspec/changes');
  const main=snapshot.directories.find(d=>d.pathParts.join('/')==='openspec/specs');
  if(!changes?.exists||!main?.exists)localInputFailure('Complete OpenSpec subject membership is missing.');
  const subjects:OpenSpecExecutionInputs['subjects'][number][]=[],owners=new Set<string>();
  for(const entry of changes.entries.filter(e=>e.kind==='directory'&&e.name!=='archive')){
    const parts=['openspec','changes',entry.name];schema([...parts,'.openspec.yaml'],true);
    for(const name of ['proposal.md','design.md','tasks.md'])text([...parts,name]);
    const specs=snapshot.directories.find(d=>d.pathParts.join('/')===[...parts,'specs'].join('/'));
    if(!specs?.exists||!specs.entries.some(e=>e.kind==='directory'))localInputFailure('OpenSpec active change has no capability delta.');
    if(entry.name===changeName&&(specs.entries.filter(e=>e.kind==='directory').length!==1||!specs.entries.some(e=>e.kind==='directory'&&e.name===capability)))
      localInputFailure('Selected OpenSpec bootstrap must have exactly its original workload capability delta.');
    for(const spec of specs.entries.filter(e=>e.kind==='directory')){
      if(owners.has(spec.name))localInputFailure('Overlapping active OpenSpec capability work is unsupported.');
      owners.add(spec.name);text([...parts,'specs',spec.name,'spec.md']);
    }
    subjects.push({id:entry.name,type:'change'});
  }
  for(const spec of main.entries.filter(e=>e.kind==='directory')){text(['openspec','specs',spec.name,'spec.md']);subjects.push({id:spec.name,type:'spec'});}
  const tasks=text(['openspec','changes',changeName,'tasks.md']).split('\n').flatMap(line=>{
    const match=/^\s*[-*]\s*\[([\sxX])\]\s*(.*)/u.exec(line);return match?[{description:match[2].trim(),done:match[1].toLowerCase()==='x'}]:[];
  }).map((task,index)=>({id:String(index+1),...task}));
  return validateOpenSpecExecutionInputs({kind:'liftoff-openspec-readonly-inputs',schemaVersion:1,changeName,capability,
    readSetDigest:canonicalSha256({policy:openSpecReadSetPolicy,files:snapshot.files.filter(f=>f.pathParts[0]==='openspec').map(({content:_content,...f})=>f),
      directories:snapshot.directories.filter(d=>d.pathParts[0]==='openspec')}),subjects,tasks});
}
export function deriveOpenSpecInitialization(snapshot:ModernLocalSnapshot,manifest:LiftoffManifestV8):OpenSpecInitialization{
      const {project}=manifest,w=project.workload;
      if(project.specWorkflow!=='openspec'||manifest.framework.state!=='initialized'||w.kind!=='standard'||w.apiStack!=='node-fastify'||
        canonicalSha256(project.agents)!==canonicalSha256(['github-copilot']))localInputFailure('Initialized-baseline qualification supports Node/Fastify and Copilot/no-cloud only.');
      const plan=buildProjectPlan({projectName:project.name,projectType:'standard',apiStack:w.apiStack,cloud:w.cloud,region:w.region,
        includeFrontend:w.frontend,environments:[...w.environments],specWorkflow:'openspec',agents:['github-copilot'],copilotCloud:false,governanceProfile:'none'},{requireProjectName:true});
      const files=new Map(snapshot.files.map(f=>[f.pathParts.join('/'),f]));
      function file(parts:string[]){const f=files.get(parts.join('/')),b=f&&capturedFileBytes(f);if(!f||!b)localInputFailure('Required initialized source is missing.');return {f,b};}
      const config=file(['openspec','config.yaml']),taskPathParts=['openspec','changes',`bootstrap-${plan.safeProjectName}`,'tasks.md'],task=file(taskPathParts);
      const decoded=task.b.toString('utf8');
      if(!Buffer.from(decoded).equals(task.b))localInputFailure('Canonical task source must be UTF8.');
      const normalize=(s:string)=>s.replace(/\r\n/g,'\n').replace(/^(- \[)[xX](\])/gm,'$1 $2');
      if(normalize(decoded)!==renderSeedTasks(plan))localInputFailure('Tasks must match the complete rendered seed ledger; missing, duplicate, changed or unknown obligations are unsupported.');
      if(!/^- \[ \] 3\.1 /m.test(decoded))localInputFailure('Task3.1 must remain pending; initialization never proves archive or finalization.');
      const actualConfig:unknown=parseYaml(config.b.toString('utf8')),expected:unknown=parseYaml(renderOpenSpecConfig(plan));
      if(canonicalSha256(actualConfig)!==canonicalSha256(expected))localInputFailure('Only exact bounded generated OpenSpec config/context/rules/no-cloud is admitted.');
      const roots=['opentofu-application',...w.environments.map(env=>`opentofu-environment:${env}`)].map((component,index)=>{
        const binding=manifest.activeLayout.bindings.find(b=>b.kind==='component'&&b.component===component);
        if(!binding)localInputFailure('Missing exact environment initialization binding.');
        return {component,cwdPathParts:[...binding.pathParts],dataPathParts:['cache','openspec-init',String(index)]};
      });
      const obligations:OpenSpecInitialization['obligations']=[
        {id:'1.1',checkIds:['source-consistency','framework-source','openspec-status'],applicability:'required'},
        {id:'1.2',checkIds:[],applicability:'attestation'},
        {id:'2.1',checkIds:['source-consistency'],applicability:'required'},
        {id:'2.2',checkIds:['backend-tests'],applicability:'required'},
        {id:'2.3',checkIds:['worker-tests'],applicability:'inapplicable'},
        {id:'2.4',checkIds:['frontend-build'],applicability:w.frontend?'required':'inapplicable'},
        {id:'2.5',checkIds:['compose-config'],applicability:'required'},
        {id:'2.6',checkIds:roots.map(r=>`tofu-format:${r.component}`),applicability:'required'},
        ...roots.slice(1).flatMap((r,index)=>[
          {id:`2.7.${index+1}`,checkIds:[`tofu-initialize:${r.component}`],applicability:'required' as const},
          {id:`2.8.${index+1}`,checkIds:[`tofu-validate:${r.component}`],applicability:'required' as const}]),
        {id:'2.9',checkIds:['openspec-selected','openspec-all'],applicability:'required'},
        {id:'3.1',checkIds:[],applicability:'pending-finalization'}
      ];
      const markers=frameworkOutputPaths({workflow:'openspec',agents:['github-copilot']}).map(parts=>file(parts).f);
      return validateOpenSpecInitialization({kind:'liftoff-openspec-initialization-inputs',schemaVersion:1,
        config:actualConfig as OpenSpecInitialization['config'],taskPathParts,taskHash:rawLocalDigest(task.b),taskBytes:task.b.length,taskMode:task.f.mode!,
        markerDigest:canonicalSha256(markers.map(({content:_content,...f})=>f)),roots,obligations});
}
