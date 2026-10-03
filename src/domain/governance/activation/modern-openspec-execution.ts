import path from 'node:path';
import {canonicalJson,canonicalSha256} from './canonical-json.js';
import {copyModernLocalData,localInputFailure,type ModernLocalCheck} from './modern-local-inputs.js';
import {exactRecord,isRecord} from '../../project/manifest/fields.js';
import {validateOpenSpecInitialization,type OpenSpecInitialization} from './modern-openspec-obligations.js';

export const openSpecReadSetPolicy=Object.freeze({
  kind:'liftoff-openspec-readonly-inputs',version:1,schema:'packaged-spec-driven',
  scope:'complete-supported-active-main-config-selected-markers-empty-archive',
  unsupported:'custom-schemas-stores-references-skipped-artifacts-retired-capabilities-archives-overlapping-changes',
  commands:'status-apply-selected-strict-all-strict-json',concurrency:1,
  inputDescriptorBytes:16384,
  taskCompletion:'observed-checkboxes-only-not-execution-proof',finalization:'not-authorized'
});
export interface OpenSpecExecutionInputs {
  kind:'liftoff-openspec-readonly-inputs';schemaVersion:1;changeName:string;capability:string;
  readSetDigest:string;subjects:readonly {id:string;type:'change'|'spec'}[];
  tasks:readonly {id:string;description:string;done:boolean}[];
}
export interface OpenSpecExecutionObservation {id:string;stdout:string}
const namePattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export function validateOpenSpecExecutionInputs(input:OpenSpecExecutionInputs):OpenSpecExecutionInputs{
  const value=copyModernLocalData(input);
  exactRecord(value,['kind','schemaVersion','changeName','capability','readSetDigest','subjects','tasks'],'OpenSpec read set');
  if(value.kind!=='liftoff-openspec-readonly-inputs'||value.schemaVersion!==1||typeof value.changeName!=='string'||!namePattern.test(value.changeName)||!value.changeName.startsWith('bootstrap-')||
    typeof value.capability!=='string'||!namePattern.test(value.capability)||typeof value.readSetDigest!=='string'||!/^[a-f0-9]{64}$/u.test(value.readSetDigest)||!Array.isArray(value.subjects)||!value.subjects.length||
    value.subjects.length>64||!Array.isArray(value.tasks)||!value.tasks.length||value.tasks.length>256)localInputFailure('Unsupported OpenSpec read-set identity or bounds.');
  const seen=new Set<string>();
  for(const subject of value.subjects){
    exactRecord(subject,['id','type'],'OpenSpec validation subject');
    if(typeof subject.id!=='string'||!namePattern.test(subject.id)||!['change','spec'].includes(subject.type)||seen.has(subject.id))localInputFailure('Ambiguous OpenSpec validation subject.');
    seen.add(subject.id);
  }
  if(!value.subjects.some(s=>s.id===value.changeName&&s.type==='change'))localInputFailure('Selected OpenSpec change is absent from the complete subject set.');
  value.tasks.forEach((task,index)=>{
    exactRecord(task,['id','description','done'],'OpenSpec task');
    if(task.id!==String(index+1)||typeof task.description!=='string'||!task.description||typeof task.done!=='boolean')localInputFailure('Unsupported OpenSpec task correspondence.');
  });
  if(Buffer.byteLength(canonicalJson(value))>openSpecReadSetPolicy.inputDescriptorBytes)localInputFailure('OpenSpec read-set descriptor exceeds its fixed record allocation.');
  return value;
}
export function openSpecExecutionChecks(input:OpenSpecExecutionInputs):ModernLocalCheck[]{
  const value=validateOpenSpecExecutionInputs(input),commands=[
    ['openspec-status',['status','--change',value.changeName,'--json']],
    ['openspec-apply',['instructions','apply','--change',value.changeName,'--json']],
    ['openspec-selected',['validate',value.changeName,'--strict','--json','--no-interactive']],
    ['openspec-all',['validate','--all','--strict','--json','--no-interactive','--concurrency','1']]
  ] as const;
  return commands.map(([id,args],index)=>({id,status:'planned',inputPaths:[],reasons:['openspec-complete-read-set-v1'],
    command:{executable:'openspec',args:[...args]},cwdPathParts:[],env:{},
    prerequisites:index?[commands[index-1][0]]:['framework-source'],effects:['read-only JSON observation; no task writes, initialization, archive or sync']}));
}
function same(actual:unknown,expected:unknown,label:string){
  if(canonicalSha256(actual)!==canonicalSha256(expected))localInputFailure(`OpenSpec ${label} differs from the complete approved input.`);
}
function object(value:unknown,fields:readonly string[],label:string):Record<string,unknown>{
  if(!isRecord(value))localInputFailure(`OpenSpec ${label} must be an object.`);
  exactRecord(value,fields,`OpenSpec ${label}`);return value;
}
export function validateOpenSpecCommandOutput(input:OpenSpecExecutionInputs,id:string,stdout:string,projectRoot:string):void{
  validateCommandOutput(input,id,stdout,projectRoot);
}
export function validateInitializedOpenSpecCommandOutput(input:OpenSpecExecutionInputs,initialization:OpenSpecInitialization,id:string,stdout:string,projectRoot:string):void{
  const value=validateOpenSpecInitialization(initialization);
  validateCommandOutput(input,id,stdout,projectRoot,value.config.context);
}
function validateCommandOutput(input:OpenSpecExecutionInputs,id:string,stdout:string,projectRoot:string,generatedContext?:string):void{
  const value=validateOpenSpecExecutionInputs(input);
  if(typeof stdout!=='string'||Buffer.byteLength(stdout)>65536||!path.isAbsolute(projectRoot))localInputFailure('OpenSpec output/root exceeds the admitted contract.');
  let raw:unknown;try{raw=JSON.parse(stdout);}catch{localInputFailure('OpenSpec command did not produce one JSON value.');}
  if(!isRecord(raw))localInputFailure('OpenSpec JSON output must be an object.');
  const root={path:projectRoot,source:'nearest'},changeRoot=path.join(projectRoot,'openspec','changes',value.changeName),
    artifacts=[['proposal','proposal.md',[]],['specs','specs/**/*.md',['proposal']],['design','design.md',['proposal']],['tasks','tasks.md',['specs','design']]] as const,
    outputs={proposal:[path.join(changeRoot,'proposal.md')],specs:[path.join(changeRoot,'specs',value.capability,'spec.md')],
      design:[path.join(changeRoot,'design.md')],tasks:[path.join(changeRoot,'tasks.md')]};
  same(raw.root,root,'command root');
  if(id==='openspec-status'){
    object(raw,['changeName','schemaName','planningHome','changeRoot','artifactPaths','isPlanningComplete','isComplete','applyRequires','nextSteps','actionContext','artifacts','root'],'status');
    same(raw.changeName,value.changeName,'change');same(raw.schemaName,'spec-driven','schema');same(raw.changeRoot,changeRoot,'change root');
    same(raw.planningHome,{kind:'repo',root:projectRoot,changesDir:path.join(projectRoot,'openspec','changes'),defaultSchema:'spec-driven'},'planning home');
    same(raw.isPlanningComplete,true,'planning completeness');same(raw.isComplete,true,'planning status');same(raw.applyRequires,['tasks'],'apply prerequisites');
    same(raw.artifacts,artifacts.map(([id,outputPath,requires])=>({id,outputPath,status:'done',requires})),'artifact graph');
    same(raw.artifactPaths,Object.fromEntries(artifacts.map(([id,outputPath])=>[id,{outputPath,resolvedOutputPath:path.join(changeRoot,outputPath),existingOutputPaths:outputs[id]}])),'artifact locations');
    same(raw.actionContext,{mode:'repo-local',sourceOfTruth:'repo',planningArtifacts:['proposal','specs','design','tasks'],linkedContext:[],
      allowedEditRoots:[projectRoot],requiresAffectedAreaSelection:false,constraints:['Repo-local change artifacts and implementation edits are scoped to this project.']},'planning authority');
    same(raw.nextSteps,[`All planning artifacts are complete. Run openspec instructions apply --change "${value.changeName}" --json to inspect implementation progress.`],'next steps');
  }else if(id==='openspec-apply'){
    object(raw,['changeName','changeDir','schemaName','contextFiles','progress','tasks','state','instruction','root',...(generatedContext!==undefined?['context']:[])],'apply');
    if(generatedContext!==undefined)same(raw.context,generatedContext,'generated project context');
    same(raw.changeName,value.changeName,'apply change');same(raw.changeDir,changeRoot,'apply root');same(raw.schemaName,'spec-driven','apply schema');
    same(raw.contextFiles,outputs,'complete apply context');same(raw.tasks,value.tasks,'original task bytes');
    const complete=value.tasks.filter(t=>t.done).length;
    same(raw.progress,{total:value.tasks.length,complete,remaining:value.tasks.length-complete},'task progress');
    same(raw.state,complete===value.tasks.length?'all_done':'ready','apply state');
    if(typeof raw.instruction!=='string'||!raw.instruction.trim())localInputFailure('OpenSpec apply instructions are missing.');
  }else if(id==='openspec-selected'||id==='openspec-all'){
    object(raw,['items','summary','version','root'],'validation');same(raw.version,'1.0','validation format');
    const expected=id==='openspec-selected'?[{id:value.changeName,type:'change'}]:value.subjects;
    if(!Array.isArray(raw.items)||raw.items.length!==expected.length)localInputFailure('OpenSpec validation omitted or added subjects.');
    const subjects=raw.items.map(item=>{
      const v=object(item,['id','type','valid','issues','durationMs'],'validation item');
      if(v.valid!==true||canonicalJson(v.issues)!=='[]\n'||typeof v.durationMs!=='number'||!Number.isFinite(v.durationMs)||v.durationMs<0)localInputFailure('OpenSpec strict validation contains issues or incomplete observations.');
      return {id:v.id,type:v.type};
    });
    same(subjects.map(s=>canonicalJson(s)).sort(),expected.map(s=>canonicalJson(s)).sort(),'exact validation subjects');
    const byType=Object.fromEntries(['change','spec'].flatMap(type=>{
      const count=expected.filter(s=>s.type===type).length;return count||generatedContext!==undefined&&id==='openspec-all'?[[type,{items:count,passed:count,failed:0}]]:[];
    }));
    same(raw.summary,{totals:{items:expected.length,passed:expected.length,failed:0},byType},'validation totals');
  }else localInputFailure('Unknown OpenSpec observation command.');
}
