import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createLocalFinalizationRecordStore,createLocalExecutionRecordStore,createLocalVerificationTransactionAuthorityStore,createUpdateTransactionApprovalStore} from '../src/adapters/filesystem/update-previews.js';
import {captureFinalizationStore,prepareModernLocalFinalization} from '../src/application/governance/modern-local-finalization.js';
import {validateFinalizationScopes,type LocalFinalizationScopes} from '../src/domain/governance/activation/modern-local-completion.js';
import {inspectModernLocalCompletion} from '../src/application/governance/modern-local-publication.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'c1-contract-')));roots.push(root);const project=path.join(root,'project');await mkdir(project);return project;}
const scopes:LocalFinalizationScopes={finalizeLocal:true,workflowWrites:false,projectCode:false,dependencyPreparation:false,dependencyNetwork:false,publishLocalRecords:false};
describe('closed native finalization contracts',()=>{
  it.each(['workflowWrites','projectCode','dependencyPreparation','dependencyNetwork','publishLocalRecords'])('does not infer %s permission',field=>{
    expect(()=>Reflect.apply(validateFinalizationScopes,undefined,[{...scopes,[field]:true}])).toThrow(/limited consent/);
  });
  it('requires affirmative native finalization and rejects extra fields/getters',()=>{
    expect(()=>Reflect.apply(validateFinalizationScopes,undefined,[{...scopes,finalizeLocal:false}])).toThrow();
    expect(()=>Reflect.apply(validateFinalizationScopes,undefined,[{...scopes,force:true}])).toThrow();
    const getter=vi.fn(()=>true),input=Object.defineProperty({...scopes},'finalizeLocal',{get:getter});
    expect(()=>validateFinalizationScopes(input)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it.each(['execution','publication','update','foreign'] as const)('rejects actual %s store attribution without effects',async kind=>{
    const root=await fixture(),other=await fixture(),port=kind==='execution'?createLocalExecutionRecordStore(root):
      kind==='publication'?createLocalVerificationTransactionAuthorityStore(root):kind==='update'?createUpdateTransactionApprovalStore(root):createLocalFinalizationRecordStore(other);
    expect(()=>Reflect.apply(captureFinalizationStore,undefined,[port,root])).toThrow(/attribution/);
  });
  it('captures own methods before awaits and refuses metadata accessors',async()=>{
    const root=await fixture(),store=createLocalFinalizationRecordStore(root),mutable={...store},captured=captureFinalizationStore(mutable,root);
    mutable.read=async()=>{throw new Error('replaced method');};
    expect(await captured.read('preview','a'.repeat(64))).toBeNull();
    const getter=vi.fn(()=>root);Object.defineProperty(mutable,'projectRoot',{enumerable:true,get:getter});
    expect(()=>captureFinalizationStore(mutable,root)).toThrow();expect(getter).not.toHaveBeenCalled();
  });
  it('uses six closed real namespaces with immutable bytes and exactly-once CAS',async()=>{
    const root=await fixture(),store=createLocalFinalizationRecordStore(root),key='a'.repeat(64);
    const record={kind:'liftoff-local-finalization-preview',projectRoot:root,formatFixtureOnly:true};
    await store.write('preview',key,record);expect((await store.read('preview',key))?.value).toEqual(record);
    await expect(store.write('preview',key,{...record,formatFixtureOnly:false})).rejects.toThrow(/replace/);
    await expect(store.write('result',key,record)).rejects.toThrow(/wire/);
    expect(await createLocalExecutionRecordStore(root).read('preview',key)).toBeNull();
    const progress={kind:'liftoff-local-finalization-state',projectRoot:root,formatFixtureOnly:true};
    const claims=await Promise.allSettled([store.compareExchangeState(key,null,progress),store.compareExchangeState(key,null,progress)]);
    expect(claims.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(claims.filter(r=>r.status==='rejected')).toHaveLength(1);
  });
  it('bounds serialized artifacts including base64 overhead without truncating',async()=>{
    const root=await fixture(),store=createLocalFinalizationRecordStore(root);
    await expect(store.write('artifact','a'.repeat(64),{kind:'liftoff-local-finalization-artifact',projectRoot:root,contentBase64:Buffer.alloc(49152).toString('base64')})).rejects.toThrow(/64KiB/);
  });
  it('does not treat absent inputs or output-looking flags as completion',async()=>{
    const root=await fixture();
    expect((await inspectModernLocalCompletion(root)).status).toBe('absent');
    await expect(prepareModernLocalFinalization(root,{kind:'finalize-local',executionFingerprint:'a'.repeat(64)})).rejects.toThrow(/original preview/);
  });
});
