import {describe,it,expect} from 'vitest';
import {buildProjectPlan} from '../src/application/project/planning.js';
import {renderOpenSpecConfig,renderSeedTasks} from '../src/generators/common/spec-workflow.js';
import {parse as parseYaml} from 'yaml';
import {validateBootstrapScopeAttestation,validateOpenSpecInitialization,initializationObligationOutcomes,validateInitializationOutputs,initializationEnvironmentValues,
  type OpenSpecInitialization,type OpenSpecInitializationOutput} from '../src/domain/governance/activation/modern-openspec-obligations.js';
import {rawLocalDigest} from '../src/domain/governance/activation/modern-local-inputs.js';
import {canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {createOpenSpecInitializationEnvironment} from '../src/application/governance/modern-openspec-preparation.js';
import {mkdtemp,realpath,lstat,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const attestation={generatedBaselineReviewed:true as const,domainBehaviorDeferred:true as const};
function contract():OpenSpecInitialization{
  const plan=buildProjectPlan({projectName:'Owned Initialization',projectType:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',
    includeFrontend:true,environments:['dev'],specWorkflow:'openspec',agents:['github-copilot'],copilotCloud:false,governanceProfile:'none'},{requireProjectName:true});
  const root='opentofu-environment:dev';
  return {kind:'liftoff-openspec-initialization-inputs',schemaVersion:1,config:parseYaml(renderOpenSpecConfig(plan)),
    taskPathParts:['openspec','changes','bootstrap-owned-initialization','tasks.md'],taskHash:canonicalSha256(renderSeedTasks(plan)),taskBytes:Buffer.byteLength(renderSeedTasks(plan)),taskMode:0o644,
    markerDigest:'a'.repeat(64),roots:[{component:'opentofu-application',cwdPathParts:['app'],dataPathParts:['cache','openspec-init','0']},
      {component:root,cwdPathParts:['dev'],dataPathParts:['cache','openspec-init','1']}],
    obligations:[{id:'1.1',checkIds:['source-consistency','framework-source','openspec-status'],applicability:'required'},{id:'1.2',checkIds:[],applicability:'attestation'},
      {id:'2.1',checkIds:['source-consistency'],applicability:'required'},{id:'2.2',checkIds:['backend-tests'],applicability:'required'},
      {id:'2.3',checkIds:['worker-tests'],applicability:'inapplicable'},{id:'2.4',checkIds:['frontend-build'],applicability:'required'},
      {id:'2.5',checkIds:['compose-config'],applicability:'required'},{id:'2.6',checkIds:['tofu-format:opentofu-application',`tofu-format:${root}`],applicability:'required'},
      {id:'2.7.1',checkIds:[`tofu-initialize:${root}`],applicability:'required'},{id:'2.8.1',checkIds:[`tofu-validate:${root}`],applicability:'required'},
      {id:'2.9',checkIds:['openspec-selected','openspec-all'],applicability:'required'},{id:'3.1',checkIds:[],applicability:'pending-finalization'}]};
}
describe('initialized-baseline portable contracts',()=>{
  it('retains all rendered task obligations and leaves3.1 pending after actual checks',()=>{
    const value=contract();expect(validateOpenSpecInitialization(value)).toEqual(value);
    const checks=value.obligations.flatMap(o=>o.checkIds.map(id=>({id,status:o.applicability==='inapplicable'?'inapplicable':'passed'})));
    const result=initializationObligationOutcomes(value,checks,attestation);
    expect(result.find(o=>o.id==='3.1')?.status).toBe('pending-finalization');expect(result.find(o=>o.id==='1.2')?.status).toBe('attested');
    expect(initializationObligationOutcomes(value,[],attestation).find(o=>o.id==='2.7.1')?.status).toBe('blocked');
  });
  it.each([null,123,['generated'],false])('rejects non-string generated context %j',context=>{
    const v=contract();expect(()=>Reflect.apply(validateOpenSpecInitialization,undefined,[{...v,config:{...v.config,context}}])).toThrow();
  });
  it.each(['missing','duplicate','unknown','finalized','root','network-config'] as const)('rejects malformed %s contract',fault=>{
    const v=contract();
    if(fault==='missing')v.obligations.pop();
    if(fault==='duplicate')v.obligations[2]={...v.obligations[0]};
    if(fault==='unknown')v.obligations[0].id='9.9';
    if(fault==='finalized')v.obligations.at(-1)!.applicability='required';
    if(fault==='root')v.roots[1].dataPathParts=['project','state'];
    const candidate=fault==='network-config'?{...v,config:{...v.config,references:['external']}}:v;
    expect(()=>validateOpenSpecInitialization(candidate)).toThrow();
  });
  it.each([null,{},false,{generatedBaselineReviewed:false,domainBehaviorDeferred:true},{generatedBaselineReviewed:true,domainBehaviorDeferred:true,extra:true}])('requires exact explicit attestation %j',value=>{
    expect(()=>Reflect.apply(validateBootstrapScopeAttestation,undefined,[value])).toThrow();
  });
  it('accepts only explicit true attestation without producing historical provenance',()=>{
    expect(validateBootstrapScopeAttestation(attestation)).toEqual(attestation);
  });
  it.each(['empty','populated','replaced'] as const)('requires the actual %s data-root boundary before an init dispatch',async fault=>{
    const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'oi-data-contract-'))),owner=await lstat(root);
    console.info('OI_OWNED_ROOT '+JSON.stringify({root,ino:owner.ino,dev:owner.dev,kind:'portable-no-process'}));
    try{
      await mkdir(path.join(root,'cache'));
      const v=contract(),environment=await createOpenSpecInitializationEnvironment(root,v),r=v.roots[0],target=path.join(root,...r.dataPathParts);
      if(fault==='populated')await writeFile(path.join(target,'injected'),'not an init output');
      if(fault==='replaced'){await rename(target,`${target}-old`);await mkdir(target,{mode:0o700});}
      if(fault==='empty')await expect(environment.assertFresh(r.component)).resolves.toBeUndefined();
      else await expect(environment.assertFresh(r.component)).rejects.toThrow(/fresh|identity/);
    }finally{
      const current=await lstat(root);expect(current.ino).toBe(owner.ino);expect(current.dev).toBe(owner.dev);
      await rm(root,{recursive:true});
    }
  });
});

describe('synthetic initialization receipt count contracts (no native provenance)',()=>{
  function receipt(files:number,directories:number){
    const initialization=contract(),selected=initialization.roots[0],workspace=path.resolve('synthetic-receipt-workspace'),
      sourceDigest=canonicalSha256({fixture:'synthetic source'}),toolDigest=canonicalSha256({fixture:'synthetic tool'});
    const entries:OpenSpecInitializationOutput['entries'][number][]=[
      ...Array.from({length:directories},(_,index)=>({
        pathParts:index===0?[]:[`directory-${index}`],kind:'directory' as const,mode:0o700,bytes:0,digest:null,
        physical:[1,index+1,0o40700,2,0,1,1,1].join(':')
      })),
      ...Array.from({length:files},(_,index)=>({
        pathParts:[`file-${index}`],kind:'file' as const,mode:0o600,bytes:0,digest:rawLocalDigest(''),
        physical:[1,directories+index+1,0o100600,1,0,1,1,1].join(':')
      }))
    ];
    const output:OpenSpecInitializationOutput={component:selected.component,sourceDigest,toolDigest,
      environmentDigest:canonicalSha256(initializationEnvironmentValues(workspace,initialization,selected.component)),
      dataPathParts:[...selected.dataPathParts],entries,outputDigest:canonicalSha256(entries)};
    return {output,validate:()=>validateInitializationOutputs([output],initialization,sourceDigest,toolDigest,workspace)};
  }
  it.each([
    {label:'empty output with root',files:0,directories:1},
    {label:'exact32 files',files:32,directories:1},
    {label:'exact16 directories including root',files:0,directories:16},
    {label:'both exact limits together',files:32,directories:16}
  ])('accepts $label as a pure receipt format',({files,directories})=>{
    const value=receipt(files,directories);
    expect(value.output.entries).toHaveLength(files+directories);
    expect(value.validate).not.toThrow();
  });
  it.each([
    {label:'33 files plus root',files:33,directories:1},
    {label:'17 directories including root',files:0,directories:17},
    {label:'17 extra directories plus root parent reproduction',files:0,directories:18},
    {label:'33 files within48 total',files:33,directories:15},
    {label:'17 directories within48 total',files:31,directories:17}
  ])('rejects $label even within the combined allowance',({files,directories})=>{
    const value=receipt(files,directories);
    expect(value.output.entries.length).toBeLessThanOrEqual(48);
    expect(value.validate).toThrow('Initialization output file or directory count exceeds its fixed bound.');
  });
  it('retains the combined48-entry limit',()=>{
    expect(receipt(33,16).validate).toThrow(/disconnected/);
  });
  it('still rejects a receipt without its required data-root directory',()=>{
    expect(receipt(1,0).validate).toThrow(/data-root/);
  });
});
