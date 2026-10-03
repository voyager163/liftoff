import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createLocalExecutionRecordStore,createUpdateTransactionApprovalStore,createLocalVerificationTransactionAuthorityStore} from '../src/adapters/filesystem/update-previews.js';
import {captureLocalExecutionStore,approveModernLocalExecution,loadLocalExecutionConsent} from '../src/application/governance/modern-local-approval.js';
import {repairApprovalStore} from '../src/application/repair/preview.js';
import {canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {localExecutionDigest,localExecutionPolicy,validateLocalExecutionScopes,validateLocalExecutionPreview,
  validateLocalExecutionResult,type LocalExecutionPreview,type LocalExecutionScopes,type LocalExecutionResult} from '../src/domain/governance/activation/modern-local-runtime.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'local-consent-')));roots.push(directory);const project=path.join(directory,'project');await mkdir(project);return project;}
const scopes:LocalExecutionScopes={projectCode:true,hostCapabilitiesAcknowledged:true,dependencyPreparation:false,dependencyNetwork:false,workflowFinalization:false,publishLocalRecords:false};
function preview(root:string,createdAt=new Date().toISOString()):LocalExecutionPreview{
  const body={kind:'liftoff-local-execution-preview' as const,schemaVersion:1 as const,operationKind:'verify-local' as const,projectRoot:root,
    operationId:'11111111-1111-4111-8111-111111111111',createdAt,expiresAt:new Date(Date.parse(createdAt)+900000).toISOString(),
    installedBinding:'a'.repeat(64),observationDigest:'b'.repeat(64),physicalDigest:'c'.repeat(64),baselineDigest:'d'.repeat(64),recipeDigest:'e'.repeat(64),
    policyDigest:canonicalSha256(localExecutionPolicy),checks:[{id:'format-contract-fixture',status:'inapplicable' as const,reasons:['Store-format fixture, never execution eligibility.'],
      command:null,cwdPathParts:[],env:{},prerequisites:[],effects:[]}],tools:[],preparation:[],preparationDigest:canonicalSha256([]),outputRoles:[],selectedPlan:null,selectedPlanDigest:null};
  return {...body,fingerprint:localExecutionDigest(body)};
}
describe('dedicated local-execution record authority',()=>{
  it('uses real immutable factories with fixed own attribution and explicit wire kinds',async()=>{
    const root=await fixture(),store=createLocalExecutionRecordStore(root),record=preview(root);
    expect(Object.getOwnPropertyDescriptor(store,'operationKind')).toMatchObject({value:'local-execution',writable:false,configurable:false});
    expect(Object.getOwnPropertyDescriptor(store,'projectRoot')).toMatchObject({value:root,writable:false,configurable:false});
    await store.write('preview',record.fingerprint,record);
    expect((await store.read('preview',record.fingerprint))?.value).toEqual(record);
    expect(await store.read('result',record.fingerprint)).toBeNull();
    await expect(store.write('preview',record.fingerprint,{...record,operationId:'22222222-2222-4222-8222-222222222222'})).rejects.toThrow(/replace/);
    await expect(store.write('result',record.fingerprint,record)).rejects.toThrow(/kind/);
  });
  it.each(['update','repair','publication','foreign'] as const)('rejects actual %s authority before callbacks',async kind=>{
    const root=await fixture(),foreign=await fixture();
    const wrong=kind==='update'?createUpdateTransactionApprovalStore(root):kind==='repair'?repairApprovalStore(root):
      kind==='publication'?createLocalVerificationTransactionAuthorityStore(root):createLocalExecutionRecordStore(foreign);
    expect(()=>Reflect.apply(captureLocalExecutionStore,undefined,[wrong,root])).toThrow(/attribution/);
  });
  it('captures own methods and refuses initial attribution getters',async()=>{
    const root=await fixture(),store=createLocalExecutionRecordStore(root),mutable={...store},captured=captureLocalExecutionStore(mutable,root);
    mutable.read=async()=>{throw new Error('late replacement');};
    expect(await captured.read('preview','a'.repeat(64))).toBeNull();
    const getter=vi.fn(()=>root);Object.defineProperty(mutable,'projectRoot',{enumerable:true,get:getter});
    expect(()=>captureLocalExecutionStore(mutable,root)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it('claims exactly once with actual absent-to-claimed CAS across competing calls',async()=>{
    const root=await fixture(),store=createLocalExecutionRecordStore(root),key='a'.repeat(64);
    const value={kind:'liftoff-local-execution-state',schemaVersion:1,projectRoot:root,operationId:'test-state-format-only'};
    const attempts=await Promise.allSettled([store.compareExchangeState(key,null,value),store.compareExchangeState(key,null,value)]);
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(1);
    await expect(store.compareExchangeState(key,null,value)).rejects.toThrow();
  });
  it('bounds real metadata without silently truncating or invoking getters',async()=>{
    const root=await fixture(),store=createLocalExecutionRecordStore(root),getter=vi.fn();
    const value=Object.defineProperty({kind:'liftoff-local-execution-preview'},'payload',{enumerable:true,get:getter});
    await expect(store.write('preview','a'.repeat(64),value)).rejects.toThrow();expect(getter).not.toHaveBeenCalled();
    await expect(store.write('preview','b'.repeat(64),{kind:'liftoff-local-execution-preview',payload:'a'.repeat(65536)})).rejects.toThrow(/64KiB/);
  });
  it('records explicit consent for the actual saved intent but not publication scopes',async()=>{
    const root=await fixture(),store=createLocalExecutionRecordStore(root),record=preview(root);
    await store.write('preview',record.fingerprint,record);
    const approval=await approveModernLocalExecution(root,record.fingerprint,scopes);
    expect(await loadLocalExecutionConsent(root,record,store)).toEqual(approval);
    expect(approval.scopes.publishLocalRecords).toBe(false);
    await expect(Reflect.apply(approveModernLocalExecution,undefined,[root,record.fingerprint,{...scopes,publishLocalRecords:true}])).rejects.toThrow(/no finalization/);
    await expect(approveModernLocalExecution(root,'b'.repeat(64),scopes)).rejects.toThrow(/missing/);
  });
  it('rejects future, expired, widened and mutated preview values with actual clock binding',async()=>{
    const root=await fixture();
    for(const at of [new Date(Date.now()+60000).toISOString(),new Date(Date.now()-1800000).toISOString()])expect(()=>validateLocalExecutionPreview(preview(root,at),new Date())).toThrow(/expired|issuance/);
    const record=preview(root);expect(()=>validateLocalExecutionPreview({...record,checks:[]},new Date())).toThrow();
    for(const field of ['projectCode','hostCapabilitiesAcknowledged'])expect(()=>Reflect.apply(validateLocalExecutionScopes,undefined,[{...scopes,[field]:false}])).toThrow();
  });
  it('requires exact full result coverage and cleanup rather than a successful flag',async()=>{
    const root=await fixture(),record=preview(root),time=new Date().toISOString();
    const body={kind:'liftoff-local-execution-result' as const,schemaVersion:1 as const,projectRoot:root,fingerprint:record.fingerprint,operationId:record.operationId,
      status:'checks-verified' as const,complete:true,startedAt:time,completedAt:time,checks:[{id:record.checks[0].id,status:'inapplicable' as const,code:'inapplicable' as const,
        commandDigest:null,toolDigest:null,exitStatus:null,signal:null,startedAt:null,completedAt:null,stdoutDigest:null,stderrDigest:null,processTreeSettled:true}],
      preparation:[],inputsUnchanged:true,cleanupComplete:true,retainedWorkspace:null,policyDigest:record.policyDigest,baselineDigest:record.baselineDigest,selectedPlanDigest:null,failureCode:null};
    const result:LocalExecutionResult={...body,resultDigest:canonicalSha256(body)};
    expect(validateLocalExecutionResult(result,record)).toEqual(result);
    expect(()=>validateLocalExecutionResult({...result,checks:[]},record)).toThrow();
    expect(()=>validateLocalExecutionResult({...result,cleanupComplete:false},record)).toThrow();
    expect(()=>validateLocalExecutionResult({...result,checks:[...result.checks,...result.checks]},record)).toThrow();
  });
  it('rejects rehashed unknown recipes and extra command data before admission',async()=>{
    const root=await fixture(),record=preview(root);
    for(const command of [{executable:'unregistered',args:[]},{executable:'node',args:[],hidden:true}]){
      const body={...record,checks:[{...record.checks[0],status:'planned' as const,command}]};
      const {fingerprint:_old,...input}=body;
      expect(()=>validateLocalExecutionPreview({...input,fingerprint:localExecutionDigest(input)},new Date())).toThrow();
    }
    const body={...record,checks:[{...record.checks[0],status:'planned' as const}]};
    const {fingerprint:_old,...input}=body;
    expect(()=>validateLocalExecutionPreview({...input,fingerprint:localExecutionDigest(input)},new Date())).toThrow(/producer/);
  });
});
