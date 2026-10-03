import {canonicalSha256,canonicalJson} from './canonical-json.js';
import {copyModernLocalData,localInputFailure,localPath} from './modern-local-inputs.js';
import {exactRecord} from '../../project/manifest/fields.js';
import path from 'node:path';

export const openSpecInitializationPolicy=Object.freeze({
  kind:'liftoff-openspec-initialized-baseline',version:1,
  selection:'node-fastify-github-copilot-no-cloud',config:'exact-rendered-schema-context-rules-copilot',
  tasks:'exact-rendered-ledger-checkboxes-not-proof',initialization:'provider-free-no-modules-backend-disabled',
  initArgs:Object.freeze(['init','-backend=false','-input=false','-no-color']),
  network:false,taskWrites:false,archive:false,publication:false,roots:4,descriptorBytes:16384,
  dataFiles:32,dataDirectories:16,dataFileBytes:65536,dataBytes:262144,dataDepth:4,
  markerProvenance:'observed-existing-marker-contract-not-historical-initializer-proof'
});
export interface OpenSpecInitialization {
  kind:'liftoff-openspec-initialization-inputs';schemaVersion:1;
  config:{schema:'spec-driven';context:string;rules:{specs:string[];design:string[];tasks:string[]};githubCopilot:{cloudAgent:false}};
  taskPathParts:string[];taskHash:string;taskBytes:number;taskMode:number;markerDigest:string;
  roots:{component:string;cwdPathParts:string[];dataPathParts:string[]}[];
  obligations:{id:string;checkIds:string[];applicability:'required'|'inapplicable'|'attestation'|'pending-finalization'}[];
}
export interface BootstrapScopeAttestation {generatedBaselineReviewed:true;domainBehaviorDeferred:true}
export interface OpenSpecInitializationOutput {
  component:string;sourceDigest:string;toolDigest:string;environmentDigest:string;outputDigest:string;
  dataPathParts:string[];entries:readonly {
    pathParts:string[];kind:'file'|'directory';mode:number;bytes:number;digest:string|null;physical:string;
  }[];
}
export interface OpenSpecInitializationOutcome {
  inputDigest:string;markerProvenance:'observed-existing-marker-contract-not-historical-initializer-proof';
  attestation:BootstrapScopeAttestation;outputs:readonly OpenSpecInitializationOutput[];
  obligations:readonly {id:string;status:'observed'|'inapplicable'|'attested'|'pending-finalization'|'blocked'}[];
}
export function initializationEnvironmentValues(workspace:string,input:OpenSpecInitialization,component:string):Record<string,string>{
  const selected=input.roots.find(r=>r.component===component);if(!selected||!path.isAbsolute(workspace))localInputFailure('Unmapped initialization environment.');
  return {TF_DATA_DIR:path.join(workspace,...selected.dataPathParts),TF_CLI_CONFIG_FILE:path.join(workspace,'cache','openspec-init','tofu.rc'),
    TF_CLI_ARGS:'',TF_CLI_ARGS_init:'',TF_CLI_ARGS_validate:'',TF_INPUT:'0',CHECKPOINT_DISABLE:'1',TF_IN_AUTOMATION:'1',TF_PLUGIN_CACHE_DIR:'',
    DO_NOT_TRACK:'1',LIFTOFF_TELEMETRY:'0'};
}
export function initializationObligationOutcomes(input:OpenSpecInitialization,checks:readonly {id:string;status:string}[],attestation:BootstrapScopeAttestation):OpenSpecInitializationOutcome['obligations']{
  const value=validateOpenSpecInitialization(input);validateBootstrapScopeAttestation(attestation);
  return value.obligations.map(o=>({id:o.id,status:o.applicability==='pending-finalization'?'pending-finalization':o.applicability==='attestation'?'attested':
    o.checkIds.every(id=>checks.some(c=>c.id===id&&c.status===(o.applicability==='inapplicable'?'inapplicable':'passed')))?
      o.applicability==='inapplicable'?'inapplicable':'observed':'blocked'}));
}
export function validateInitializationOutputs(input:readonly OpenSpecInitializationOutput[],initialization:OpenSpecInitialization,sourceDigest:string,toolDigest:string,workspace:string):void{
  if(!Array.isArray(input)||input.length>initialization.roots.length)localInputFailure('Invalid initialization output receipts.');
  const seen=new Set<string>();
  for(const output of input){
    exactRecord(output,['component','sourceDigest','toolDigest','environmentDigest','outputDigest','dataPathParts','entries'],'Initialization output');
    const selected=initialization.roots.find(r=>r.component===output.component);
    if(!selected||seen.has(output.component)||output.sourceDigest!==sourceDigest||output.toolDigest!==toolDigest||
      canonicalSha256(output.dataPathParts)!==canonicalSha256(selected.dataPathParts)||output.environmentDigest!==canonicalSha256(initializationEnvironmentValues(workspace,initialization,output.component))||
      !Array.isArray(output.entries)||output.entries.length>openSpecInitializationPolicy.dataFiles+openSpecInitializationPolicy.dataDirectories)
      localInputFailure('Initialization output is disconnected from its source/tool/root.');
    seen.add(output.component);const names=new Set<string>();let bytes=0,files=0,directories=0;
    for(const entry of output.entries){
      exactRecord(entry,['pathParts','kind','mode','bytes','digest','physical'],'Initialization output entry');localPath(entry.pathParts,true);
      const name=entry.pathParts.join('/');
      if(names.has(name)||entry.pathParts.length>openSpecInitializationPolicy.dataDepth||!['file','directory'].includes(entry.kind)||!Number.isInteger(entry.mode)||
        entry.mode<0||entry.mode>0o777||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>openSpecInitializationPolicy.dataFileBytes||
        typeof entry.physical!=='string'||!/^\d+(?::\d+){7}$/u.test(entry.physical)||
        (entry.kind==='file'?typeof entry.digest!=='string'||!/^[a-f0-9]{64}$/u.test(entry.digest):entry.bytes!==0||entry.digest!==null))
        localInputFailure('Malformed initialization output inventory.');
      if(entry.kind==='file')files++;else directories++;
      if(files>openSpecInitializationPolicy.dataFiles||directories>openSpecInitializationPolicy.dataDirectories)
        localInputFailure('Initialization output file or directory count exceeds its fixed bound.');
      names.add(name);bytes+=entry.bytes;
      const fields=entry.physical.split(':');
      if((Number(fields[2])&0o7777)!==entry.mode||(Number(fields[2])&0o170000)!==(entry.kind==='file'?0o100000:0o040000)||
        entry.kind==='file'&&(fields[3]!=='1'||Number(fields[4])!==entry.bytes))localInputFailure('Initialization physical metadata contradicts its file representation.');
    }
    if(bytes>openSpecInitializationPolicy.dataBytes||!output.entries.some((e:OpenSpecInitializationOutput['entries'][number])=>e.kind==='directory'&&e.pathParts.length===0)||
      canonicalSha256(output.entries)!==output.outputDigest||!workspace)localInputFailure('Missing initialization data-root proof.');
  }
}
export function validateBootstrapScopeAttestation(input:BootstrapScopeAttestation):BootstrapScopeAttestation{
  const value=copyModernLocalData(input);
  exactRecord(value,['generatedBaselineReviewed','domainBehaviorDeferred'],'Bootstrap scope attestation');
  if(value.generatedBaselineReviewed!==true||value.domainBehaviorDeferred!==true)localInputFailure('Explicit reviewed bootstrap-scope attestation is required.');
  return value;
}
export function validateOpenSpecInitialization(input:OpenSpecInitialization):OpenSpecInitialization{
  const value=copyModernLocalData(input);
  exactRecord(value,['kind','schemaVersion','config','taskPathParts','taskHash','taskBytes','taskMode','markerDigest','roots','obligations'],'OpenSpec initialization');
  if(value.kind!=='liftoff-openspec-initialization-inputs'||value.schemaVersion!==1)localInputFailure('Unsupported OpenSpec initialization protocol.');
  exactRecord(value.config,['schema','context','rules','githubCopilot'],'Generated OpenSpec config');
  exactRecord(value.config.rules,['specs','design','tasks'],'Generated OpenSpec rules');
  exactRecord(value.config.githubCopilot,['cloudAgent'],'Generated Copilot config');
  if(value.config.schema!=='spec-driven'||typeof value.config.context!=='string'||!value.config.context.trim()||
    value.config.githubCopilot.cloudAgent!==false)localInputFailure('Unsupported generated OpenSpec configuration.');
  for(const rules of Object.values(value.config.rules))if(!Array.isArray(rules)||!rules.length||rules.length>16||
    rules.some(r=>typeof r!=='string'||!r.trim()))localInputFailure('Generated OpenSpec rules must be bounded strings.');
  localPath(value.taskPathParts);
  if(value.taskPathParts.length!==4||value.taskPathParts[0]!=='openspec'||value.taskPathParts[1]!=='changes'||value.taskPathParts[3]!=='tasks.md'||
    !Number.isSafeInteger(value.taskBytes)||value.taskBytes<1||value.taskBytes>1048576||!Number.isInteger(value.taskMode)||value.taskMode<0||value.taskMode>0o777)
    localInputFailure('Invalid original OpenSpec task attribution.');
  for(const hash of [value.taskHash,value.markerDigest])if(typeof hash!=='string'||!/^[a-f0-9]{64}$/u.test(hash))localInputFailure('OpenSpec initialization needs raw content commitments.');
  if(!Array.isArray(value.roots)||value.roots.length<2||value.roots.length>openSpecInitializationPolicy.roots||
    new Set(value.roots.map(r=>r.component)).size!==value.roots.length)localInputFailure('Invalid initialized environment mapping.');
  value.roots.forEach((r,index)=>{
    exactRecord(r,['component','cwdPathParts','dataPathParts'],'OpenTofu initialization root');
    if(typeof r.component!=='string'||!(index===0?r.component==='opentofu-application':/^opentofu-environment:(dev|staging|prod)$/u.test(r.component)))localInputFailure('Unsupported initialized component.');
    localPath(r.cwdPathParts);localPath(r.dataPathParts);
    if(canonicalSha256(r.dataPathParts)!==canonicalSha256(['cache','openspec-init',String(index)]))localInputFailure('Initialization output role is not its exact private mapping.');
  });
  if(new Set(value.roots.map(r=>r.cwdPathParts.join('/'))).size!==value.roots.length)localInputFailure('Initialization roots must be distinct.');
  if(!Array.isArray(value.obligations)||value.obligations.length!==10+2*(value.roots.length-1))localInputFailure('Canonical generated obligation count differs.');
  const ids=['1.1','1.2','2.1','2.2','2.3','2.4','2.5','2.6',
    ...value.roots.slice(1).flatMap((_r,i)=>[`2.7.${i+1}`,`2.8.${i+1}`]),'2.9','3.1'];
  const expectedChecks=[['source-consistency','framework-source','openspec-status'],[],['source-consistency'],['backend-tests'],['worker-tests'],['frontend-build'],['compose-config'],
    value.roots.map(r=>`tofu-format:${r.component}`),...value.roots.slice(1).flatMap(r=>[[`tofu-initialize:${r.component}`],[`tofu-validate:${r.component}`]]),
    ['openspec-selected','openspec-all'],[]];
  value.obligations.forEach((o,index)=>{
    exactRecord(o,['id','checkIds','applicability'],'OpenSpec obligation');
    if(o.id!==ids[index]||!['required','inapplicable','attestation','pending-finalization'].includes(o.applicability)||
      !Array.isArray(o.checkIds)||o.checkIds.some(id=>typeof id!=='string'||!id)||new Set(o.checkIds).size!==o.checkIds.length)
      localInputFailure('Missing, duplicate or unknown generated obligation.');
    if(canonicalSha256(o.checkIds)!==canonicalSha256(expectedChecks[index])||
      (o.id==='2.3'?o.applicability!=='inapplicable':o.id==='2.4'?!['required','inapplicable'].includes(o.applicability):
        !['1.2','3.1'].includes(o.id)&&o.applicability!=='required'))localInputFailure('Obligation differs from its exact generated check mapping.');
    if(o.id==='3.1'?(o.applicability!=='pending-finalization'||o.checkIds.length!==0):o.id==='1.2'?
      (o.applicability!=='attestation'||o.checkIds.length!==0):!o.checkIds.length)localInputFailure('Invalid obligation applicability or deferred completion.');
  });
  if(Buffer.byteLength(canonicalJson(value))>openSpecInitializationPolicy.descriptorBytes)localInputFailure('Initialization descriptor exceeds its record allocation.');
  return value;
}
