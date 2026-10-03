import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat,unlink,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as storage from '../src/adapters/filesystem/update-previews.js';
import {prepareModernLocalExecution,approveModernLocalExecution,readCompletedModernLocalExecution,readCompletedLocalExecutionRecords} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {prepareModernLocalFinalization,approveModernLocalFinalization,finalizeModernLocalCompletion} from '../src/application/governance/modern-local-finalization.js';
import {approveModernLocalPublication,publishModernLocalCompletion,inspectModernLocalCompletion,recoverModernLocalCompletion} from '../src/application/governance/modern-local-publication.js';
import {inspectLocalVerificationTransaction} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import {projectMutationLockPath} from '../src/adapters/filesystem/project-lock.js';
import {completionDigest,validateFinalizationPreview,type LocalFinalizationState} from '../src/domain/governance/activation/modern-local-completion.js';
import type {LocalExecutionPreview,LocalExecutionConsent,LocalExecutionResult,LocalExecutionState} from '../src/domain/governance/activation/modern-local-runtime.js';
import {projectCatalog} from '../src/application/project/catalog.js';
import {composeModernManifestPlugins} from '../src/application/project/plugins.js';
import {resolveModernManifestV8SourceContract} from '../src/application/project/manifest.js';
import {createManifestV8ProjectReader} from '../src/domain/project/manifest/v8-project.js';
import {createManifestV8Reader} from '../src/domain/project/manifest/v8.js';
import {readManifestPluginMetadata} from '../src/domain/project/manifest/plugins.js';
import {buildModernManagedCore} from '../src/application/project/modern-managed-core.js';
import {createModernGovernanceContextContract} from '../src/domain/governance/policy/modern-context.js';
import {modernActivationSourceContracts} from '../src/domain/governance/policy/identity.js';
import {rawLocalDigest} from '../src/domain/governance/activation/modern-local-inputs.js';
import {NodeCommandRunner} from '../src/process-runner.js';
const lane=process.env.LIFTOFF_HCL_TEST_LANE??'auto',qualified=process.platform==='darwin'&&process.arch==='arm64'&&process.versions.node==='24.21.0';
if(!['native','portable','auto'].includes(lane)||lane==='native'&&!qualified)throw new Error('Invalid C1 qualification host/lane.');
const nativeIt=it.skipIf(lane==='portable'||!qualified),executed:string[]=[];
beforeEach(({task})=>executed.push(task.name));
afterAll(()=>console.info('MR2_C1_TEST_INVENTORY '+JSON.stringify({lane,qualified,executed,claim:lane==='portable'?'Portable contracts only; native processes unrun.':'Actual current-host owned fixtures, not other-platform readiness.'})));
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const executionScopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:false,dependencyNetwork:false,workflowFinalization:false as const,publishLocalRecords:false as const};
const finalizationScopes={finalizeLocal:true as const,workflowWrites:false as const,projectCode:false as const,dependencyPreparation:false as const,dependencyNetwork:false as const,publishLocalRecords:false as const};
async function fixture(profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none'){
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'c1-native-')));roots.push(directory);const root=path.join(directory,'Project Space');await mkdir(root);
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:{name:'Native Completion Fixture',workload:{kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:true,environments:['dev']},
    specWorkflow:'manual',agents:[]},framework:{state:'not-required'}});
  const selection={...leaf,profile},resolution=composeModernManifestPlugins({workload:'standard',stack:'node-fastify',cloud:'azure',workflow:'manual',agents:[],frontend:'included',environments:['dev'],governanceProfile:profile},{safeProjectName:'native-completion-fixture'}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},{stack:'node-fastify',cloud:'azure',workflow:'manual',agents:[]});
  const source=resolveModernManifestV8SourceContract({selection,recordedPlugins:plugins});
  const activeLayout={schemaVersion:1,state:'bound',bindings:[...source.layoutDescriptor.components.map(component=>({kind:'component',component,pathParts:['Source Space',component.replace(':',' ')]})),
    {kind:'artifact',logicalName:'docker-compose',pathParts:['compose.yml']}]};
  const contracts={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract},input={selection,plugins,activeLayout};
  const core=buildModernManagedCore(input),context=profile==='none'?undefined:createModernGovernanceContextContract(contracts).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(contracts).parseManifestV8({artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,
    project:leaf.project,framework:leaf.framework,plugins,activeLayout,governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(file=>({logicalName:file.logicalName,category:file.category,pathParts:file.pathParts,contentHash:`sha256:${rawLocalDigest(file.content)}`})),projectArtifacts:[],adoptionObservations:[]});
  async function put(parts:readonly string[],content:string){const target=path.join(root,...parts);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
  await put(['liftoff.manifest.json'],JSON.stringify(manifest,null,2)+'\n');for(const file of core)await put(file.pathParts,file.content);
  for(const component of source.layoutDescriptor.components){
    const parts=['Source Space',component.replace(':',' ')];
    if(component==='backend'){await put([...parts,'package.json'],'{"name":"native-backend","version":"1.0.0","scripts":{"test":"node --test"}}\n');
      await put([...parts,'tests','input.test.cjs'],'require("node:test")("actual local check",()=>require("node:assert/strict").equal(4,2+2));\n');}
    else if(component==='frontend'){await put([...parts,'package.json'],'{"name":"native-frontend","version":"1.0.0","scripts":{"build":"node build.cjs"}}\n');
      await put([...parts,'build.cjs'],'require("node:fs").mkdirSync("dist");require("node:fs").writeFileSync("dist/index.html","owned");\n');}
    else if(component.startsWith('opentofu-'))await put([...parts,'main.tf'],'locals {\n  enabled = true\n}\n');
    else await put([...parts,'source.txt'],'actual selected source\n');
  }
  await put(['compose.yml'],'services:\n  app:\n    image: example/local:source\n');
  return {root,directory,put};
}
async function completed(profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none'){
  const f=await fixture(profile),preview=await prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]});
  await approveModernLocalExecution(f.root,preview.fingerprint,executionScopes);
  const result=await executeModernLocalExecution(f.root,preview.fingerprint);expect(result.complete).toBe(true);
  return {...f,execution:preview,result};
}
async function reviewed(profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none'){
  const f=await completed(profile),preview=await prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:f.execution.fingerprint});
  await approveModernLocalFinalization(f.root,preview.fingerprint,finalizationScopes);
  const finalization=await finalizeModernLocalCompletion(f.root,preview.fingerprint);
  return {...f,preview,finalization};
}
async function consent(f:Awaited<ReturnType<typeof reviewed>>){
  const r=f.finalization;return approveModernLocalPublication(f.root,r.publicationFingerprint,{publishExactLocalBytes:true,finalizationFingerprint:f.preview.fingerprint,candidateBinding:r.candidateBinding,targetSetDigest:r.targetSetDigest});
}
async function retainedPublicationBytes(root:string){
  const location=await storage.resolveUpdatePreviewLocation(root);
  const names=await readdir(location.directory);expect(names.length).toBeLessThanOrEqual(1024);
  const files=[path.join(root,...transactions.localVerificationTransactionPathParts),path.join(root,'.liftoff/local-completion.json'),
    ...names.filter(name=>name.startsWith('local-verification-authority-')).sort().map(name=>path.join(location.directory,name))];
  const entries=[];
  for(const file of files){
    try{
      const stat=await lstat(file,{bigint:true}),bytes=await readFile(file);
      expect(stat.isFile()&&!stat.isSymbolicLink()).toBe(true);
      entries.push({file,sha256:rawLocalDigest(bytes),bytes:bytes.length,
        identity:[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs,stat.birthtimeNs].map(String)});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;entries.push({file,missing:true});}
  }
  return entries;
}
describe('actual native completion publication',()=>{
  nativeIt.each(['wrong-F','same-F-wrong-T'] as const)('leaves actual replacement transaction during recovery untouched: %s',async mismatch=>{
    const f=await reviewed();await consent(f);
    const originalStore=storage.createLocalFinalizationRecordStore;
    let denyCommit=true,beforeResultRead:(()=>Promise<void>)|undefined;
    vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
      const store=originalStore(root,options);
      return {...store,read:async(kind,key)=>{
        if(kind==='result'&&beforeResultRead){const barrier=beforeResultRead;beforeResultRead=undefined;await barrier();}
        return store.read(kind,key);
      },compareExchangeState:async(key,expected,value)=>{
        if(denyCommit&&value&&typeof value==='object'&&'phase'in value&&value.phase==='committed-readback-pending')throw new Error('Explicit denied C commit observation to retain real journal.');
        return store.compareExchangeState(key,expected,value);
      }};
    });
    expect((await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).status).toBe('committed-cleanup-pending');
    denyCommit=false;
    const authorityStore=storage.createLocalVerificationTransactionAuthorityStore(f.root);
    const original=await inspectLocalVerificationTransaction(f.root,{authorityStore});expect(original.status).toBe('committed');
    const replacementFingerprint=mismatch==='wrong-F'?completionDigest({kind:'actual-independent-recovery-race'}):original.planFingerprint!;
    let replacement:Awaited<ReturnType<typeof inspectLocalVerificationTransaction>>|undefined;
    let before:Awaited<ReturnType<typeof retainedPublicationBytes>>|undefined;
    beforeResultRead=async()=>{
      const cleaned=await transactions.recoverLocalVerificationTransaction(f.root,{authorityStore});
      expect(cleaned.committed).toBe(true);expect(cleaned.planFingerprint).toBe(original.planFingerprint);expect(cleaned.transactionDigest).toBe(original.transactionDigest);
      const parts=['.liftoff','local-completion.json'],content=await readFile(path.join(f.root,...parts)),mode=(await lstat(path.join(f.root,...parts))).mode&0o7777;
      const mutations=[{type:'write' as const,pathParts:parts,content,mode}],preconditions=[{pathParts:parts,content,mode}];
      const candidate=await transactions.inspectLocalVerificationCandidate(f.root,mutations,preconditions);
      const applied=await transactions.applyLocalVerificationTransaction(f.root,mutations,{authorityStore,planFingerprint:replacementFingerprint,
        preconditions,expectedCandidateBinding:candidate.binding,validateCurrentInputs:async()=>{
          expect(await readFile(path.join(f.root,...parts))).toEqual(content);expect((await lstat(path.join(f.root,...parts))).mode&0o7777).toBe(mode);
        },onCheckpoint:async checkpoint=>{if(checkpoint.phase==='committed')throw new Error('Retain actual competing committed journal.');}});
      expect(applied.committed).toBe(true);expect(applied.cleanupFailures).toHaveLength(1);
      replacement=await inspectLocalVerificationTransaction(f.root,{authorityStore});expect(replacement.status).toBe('committed');
      expect(replacement.planFingerprint).toBe(replacementFingerprint);expect(replacement.transactionDigest).not.toBe(original.transactionDigest);
      before=await retainedPublicationBytes(f.root);
    };
    const recovered=await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint});
    const after=await retainedPublicationBytes(f.root),afterInspection=await inspectLocalVerificationTransaction(f.root,{authorityStore});
    const progress=await originalStore(f.root).readState(f.preview.fingerprint);
    console.info('MR2_C1_R1_ACTUAL_RECOVERY_SWAP '+JSON.stringify({mismatch,original,replacement,before,after,afterInspection,recovered,progress:progress?.value,
      actualCompetingTransactions:true,forgedJournalOrSuccess:false}));
    expect(before).toBeDefined();expect(replacement).toBeDefined();
    expect.soft(after).toEqual(before);
    expect.soft(afterInspection).toEqual(replacement);
    expect.soft(recovered.status).toBe('blocked');
    expect.soft(progress?.value).toMatchObject({phase:'committed-readback-pending',blockerCodes:['cleanup-pending'],transactionDigest:original.transactionDigest});
  },120000);
  nativeIt.each(['planFingerprint','transactionDigest'] as const)('rejects mismatched returned recovery %s before clearing cleanup state',async field=>{
    const f=await reviewed();await consent(f);
    const create=storage.createLocalFinalizationRecordStore;let deny=true;
    vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
      const store=create(root,options);return {...store,compareExchangeState:async(key,expected,value)=>{
        if(deny&&value&&typeof value==='object'&&'phase'in value&&value.phase==='committed-readback-pending')throw new Error('Retain actual committed journal for returned-attribution negative.');
        return store.compareExchangeState(key,expected,value);
      }};
    });
    expect((await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).status).toBe('committed-cleanup-pending');
    deny=false;
    const recover=transactions.recoverLocalVerificationTransaction;
    vi.spyOn(transactions,'recoverLocalVerificationTransaction').mockImplementation(async(root,options)=>{
      const actual=await recover(root,options);
      expect(actual.committed).toBe(true);
      expect(options.expectedTransaction).toEqual({planFingerprint:actual.planFingerprint,transactionDigest:actual.transactionDigest});
      return {...actual,[field]:'b'.repeat(64)};
    });
    await expect(recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint})).rejects.toThrow(/returned attribution/);
    expect((await create(f.root).readState(f.preview.fingerprint))?.value).toMatchObject({phase:'committed-readback-pending',blockerCodes:['cleanup-pending'],readbackDigest:null});
  },120000);
  nativeIt.each(['none','single-maintainer-gitflow','team-gitflow'] as const)('publishes and independently reads back actual full %s Manual completion',async profile=>{
    const f=await reviewed(profile),before=await readFile(path.join(f.root,'liftoff.manifest.json'));
    expect((await inspectModernLocalCompletion(f.root)).status).toBe('absent');
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/second publication consent/);
    await consent(f);
    const outcome=await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint);
    console.info('MR2_C1_ACTUAL_COMPLETE '+JSON.stringify({profile,outcome}));
    expect(outcome.status).toBe('local-complete-current');expect(outcome.committed).toBe(true);
    const inspection=await inspectModernLocalCompletion(f.root);expect(inspection.status).toBe('local-complete-current');
    expect(await readFile(path.join(f.root,'liftoff.manifest.json'))).toEqual(before);
    if(profile==='none')await expect(lstat(path.join(f.root,'governance/activation-state.json'))).rejects.toMatchObject({code:'ENOENT'});
    else{
      const state=JSON.parse(await readFile(path.join(f.root,'governance/activation-state.json'),'utf8'));
      expect(state.repository.defaultBranch).toBe('undiscovered');
      expect(state.phases['local-complete'].state).toBe('verified');expect(state.phases.committed.state).toBe('pending');
    }
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow();
    const recovered=await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint});
    expect(recovered.status).toBe('local-complete-current');
    if(profile==='none'){
      const original=storage.createLocalFinalizationRecordStore;
      vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
        const store=original(root,options);return {...store,readState:async key=>{
          const saved=await store.readState(key);if(!saved)return null;
          const state=saved.value as LocalFinalizationState;
          return {...saved,value:{...state,phase:'publishing',commitObservation:null,readbackDigest:null}};
        }};
      });
      await expect(inspectModernLocalCompletion(f.root)).rejects.toThrow(/do not prove commit/);
      expect((await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint})).status).toBe('blocked');
      vi.restoreAllMocks();
      await f.put(['Source Space','backend','late.cjs'],'later source, not automatic revalidation\n');
      await expect(inspectModernLocalCompletion(f.root)).rejects.toThrow(/directory/);
    }
  },120000);
  nativeIt('historically reconstructs original consent and full B without metadata probes',async()=>{
    const f=await completed(),run=vi.spyOn(NodeCommandRunner.prototype,'run');
    const read=await readCompletedModernLocalExecution(f.root,f.execution.fingerprint);
    expect(read.result).toEqual(f.result);expect(read.consent.scopes.publishLocalRecords).toBe(false);expect(run).not.toHaveBeenCalled();
  },60000);
  nativeIt('rejects modeled external workflow finalization instead of inventing archive semantics',async()=>{
    const f=await completed(),p=await prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:f.execution.fingerprint});
    for(const workflow of ['openspec','spec-kit']){
      const {fingerprint:_old,...body}=p,changed={...body,context:{...body.context,workflow}};
      expect(()=>Reflect.apply(validateFinalizationPreview,undefined,[{...changed,fingerprint:completionDigest(changed)},new Date()])).toThrow(/identity/);
    }
    console.info('MR2_C1_EXTERNAL_CONTRACT_REJECTION '+JSON.stringify({modeled:true,externalToolOrWorkflowEffect:false}));
  },60000);
  nativeIt('models expired B permission without reviving execution or fabricating elapsed-time evidence',async()=>{
    const f=await completed();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(f.execution.expiresAt)+60000);
    expect((await readCompletedLocalExecutionRecords(f.root,f.execution.fingerprint)).result.complete).toBe(true);
    await expect(approveModernLocalExecution(f.root,f.execution.fingerprint,executionScopes)).rejects.toThrow(/expired|issuance/);
    await expect(executeModernLocalExecution(f.root,f.execution.fingerprint)).rejects.toThrow(/expired|issuance/);
    console.info('MR2_C1_MODELED_CLOCK '+JSON.stringify({actualElapsedClaim:false,modeledNow:new Date().toISOString(),originalExpiry:f.execution.expiresAt}));
  },60000);
  nativeIt('rejects a rehashed omitted frontend check despite mutually matching stored result flags',async()=>{
    const f=await completed(),records=await readCompletedLocalExecutionRecords(f.root,f.execution.fingerprint);
    const {fingerprint:_fingerprint,...previewBody}=records.preview;
    const changedBody={...previewBody,checks:previewBody.checks.filter(c=>c.id!=='frontend-build')};
    const p:LocalExecutionPreview={...changedBody,fingerprint:completionDigest(changedBody)};
    const c:LocalExecutionConsent={...records.consent,fingerprint:p.fingerprint};
    const {resultDigest:_result,...resultBody}=records.result,changedResult={...resultBody,fingerprint:p.fingerprint,checks:resultBody.checks.filter(c=>c.id!=='frontend-build')};
    const r:LocalExecutionResult={...changedResult,resultDigest:completionDigest(changedResult)};
    const s:LocalExecutionState={...records.state,fingerprint:p.fingerprint,resultDigest:r.resultDigest};
    const original=storage.createLocalExecutionRecordStore;
    vi.spyOn(storage,'createLocalExecutionRecordStore').mockImplementation((root,options)=>{
      const store=original(root,options);return {...store,read:async(kind,key)=>{
        if(key!==p.fingerprint)return store.read(kind,key);
        return {projectRoot:root,path:'negative-rehashed-fixture',value:kind==='preview'?p:kind==='consent'?c:kind==='result'?r:null};
      },readState:async key=>key===p.fingerprint?{projectRoot:root,path:'negative-rehashed-fixture',value:s,digest:completionDigest(s)}:store.readState(key)};
    });
    await expect(prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:p.fingerprint})).rejects.toThrow(/actual full/);
  },60000);
  nativeIt.each(['missing','after-start'] as const)('requires actual original B consent: %s negative adapter',async fault=>{
    const f=await completed(),original=storage.createLocalExecutionRecordStore;
    vi.spyOn(storage,'createLocalExecutionRecordStore').mockImplementation((root,options)=>{
      const store=original(root,options);return {...store,read:async(kind,key)=>{
        const value=await store.read(kind,key);
        if(kind!=='consent'||!value)return value;
        return fault==='missing'?null:{...value,value:{...(value.value as LocalExecutionConsent),approvedAt:new Date(Date.parse(f.result.startedAt)+1).toISOString()}};
      }};
    });
    await expect(prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:f.execution.fingerprint})).rejects.toThrow(/consent|chronology/);
  },60000);
  nativeIt('requires second consent for exact bytes and preserves changed original source before dispatch',async()=>{
    const f=await reviewed();
    await expect(approveModernLocalPublication(f.root,f.finalization.publicationFingerprint,{publishExactLocalBytes:true,finalizationFingerprint:f.preview.fingerprint,
      candidateBinding:'a'.repeat(64),targetSetDigest:f.finalization.targetSetDigest})).rejects.toThrow(/exact bytes/);
    await consent(f);
    await f.put(['Source Space','backend','new.cjs'],'changed original, retain it\n');
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/directory/);
    expect((await storage.createLocalFinalizationRecordStore(f.root).readState(f.preview.fingerprint))?.value).toMatchObject({phase:'awaiting-publication'});
    await expect(lstat(path.join(f.root,'.liftoff/local-completion.json'))).rejects.toMatchObject({code:'ENOENT'});
  },120000);
  nativeIt('compares untouched originals at actual precommit while accepting only its own target controls',async()=>{
    const f=await reviewed('single-maintainer-gitflow');await consent(f);
    const original=transactions.applyLocalVerificationTransaction;
    vi.spyOn(transactions,'applyLocalVerificationTransaction').mockImplementation((root,mutations,options)=>original(root,mutations,{...options,onCheckpoint:async checkpoint=>{
      await options.onCheckpoint?.(checkpoint);
      if(checkpoint.phase==='before-commit')await f.put(['Source Space','backend','changed-after-targets.cjs'],'not a transaction target\n');
    }}));
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/directory/);
    expect(await readFile(path.join(f.root,'Source Space/backend/changed-after-targets.cjs'),'utf8')).toContain('not a transaction');
    await expect(lstat(path.join(f.root,'.liftoff/local-completion.json'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await inspectModernLocalCompletion(f.root)).status).toBe('absent');
  },120000);
  nativeIt('preserves a sealed commit when denied C state persistence requires explicit recovery',async()=>{
    const f=await reviewed();await consent(f);
    const original=storage.createLocalFinalizationRecordStore;let denied=true;
    vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
      const store=original(root,options);return {...store,compareExchangeState:async(key,expected,value)=>{
        if(denied&&value&&typeof value==='object'&&'phase'in value&&value.phase==='committed-readback-pending')throw new Error('Explicit denied C commit observation storage.');
        return store.compareExchangeState(key,expected,value);
      }};
    });
    const outcome=await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint);
    expect(outcome.status).toBe('committed-cleanup-pending');expect(outcome.committed).toBe(true);
    const tx=await inspectLocalVerificationTransaction(f.root,{authorityStore:storage.createLocalVerificationTransactionAuthorityStore(f.root)});
    expect(tx.status).toBe('committed');
    denied=false;
    expect((await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint})).status).toBe('local-complete-current');
  },120000);
  nativeIt('does not infer successful cleanup after the journal disappears but C cleanup persistence is denied',async()=>{
    const f=await reviewed();await consent(f);
    const original=storage.createLocalFinalizationRecordStore;
    vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
      const store=original(root,options);return {...store,compareExchangeState:async(key,expected,value)=>{
        if(value&&typeof value==='object'&&'phase'in value&&value.phase==='committed-readback-pending'&&'blockerCodes'in value&&Array.isArray(value.blockerCodes)&&value.blockerCodes.length===0)throw new Error('Explicit denied cleanup observation persistence.');
        return store.compareExchangeState(key,expected,value);
      }};
    });
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/denied cleanup/);
    vi.restoreAllMocks();
    expect((await inspectLocalVerificationTransaction(f.root,{authorityStore:storage.createLocalVerificationTransactionAuthorityStore(f.root)})).status).toBe('absent');
    expect((await inspectModernLocalCompletion(f.root)).status).toBe('committed-cleanup-pending');
    expect((await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint})).status).toBe('committed-cleanup-pending');
  },120000);
  nativeIt.each(['prepared','committed','committed-unrecorded','sealed-before-append'] as const)('recovers actual child exit at %s without replaying B or finalization',async cut=>{
    const f=await reviewed();await consent(f);
    const repository=process.cwd(),loader=path.join(f.directory,'crash-loader.mjs'),child=path.join(f.directory,'publication-child.mjs');
    const marker="saved=await changeCompletionState(store,review.preview,saved!.digest,state);state=saved.value as LocalFinalizationState;";
    await writeFile(loader,`
      import {registerHooks,stripTypeScriptTypes} from 'node:module';
      import {readFileSync,existsSync} from 'node:fs';
      import {fileURLToPath,pathToFileURL} from 'node:url';
      const root=${JSON.stringify(repository)},marker=${JSON.stringify(marker)};
      registerHooks({
        resolve(specifier,context,next){
          if(context.parentURL?.startsWith(pathToFileURL(root+'/').href)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
            const file=fileURLToPath(new URL(specifier.slice(0,-3)+'.ts',context.parentURL));if(existsSync(file))return next(pathToFileURL(file).href,context);
          }return next(specifier,context);
        },
        load(url,context,next){
          if(url.startsWith(pathToFileURL(root+'/').href)&&url.endsWith('.ts')){
            let source=readFileSync(new URL(url),'utf8');
            if(url.endsWith('/modern-local-publication.ts')){
              if(source.split(marker).length!==2)throw new Error('Exact crash checkpoint marker unavailable.');
              source=source.replace(marker,${cut==='committed-unrecorded'?JSON.stringify('if(checkpoint.phase==="committed")process.exit(73);'):'""'}+marker+'if(checkpoint.phase===${JSON.stringify(cut)})process.exit(73);');
            }
            if(url.endsWith('/reviewed-update-transaction.ts')&&${JSON.stringify(cut)}==='sealed-before-append'){
              const seam='committed = true;\\n      loaded.committed = true;';
              if(source.split(seam).length!==2)throw new Error('Exact durable commit-seal cut is unavailable.');
              source=source.replace(seam,seam+'process.exit(73);');
            }
            return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url})};
          }return next(url,context);
        }
      });
    `);
    await writeFile(child,`import {publishModernLocalCompletion} from ${JSON.stringify(new URL('../src/application/governance/modern-local-publication.ts',import.meta.url).href)};
      await publishModernLocalCompletion(${JSON.stringify(f.root)},${JSON.stringify(f.finalization.publicationFingerprint)});process.exit(74);`);
    const childResult=spawnSync(process.execPath,['--import',loader,child],{cwd:f.directory,env:process.env,encoding:'utf8',timeout:30000,killSignal:'SIGKILL',maxBuffer:65536});
    expect(childResult.status,childResult.stderr).toBe(73);expect(childResult.error).toBeUndefined();expect(()=>process.kill(childResult.pid,0)).toThrow();
    const before=await inspectModernLocalCompletion(f.root);
    expect(before.status).toBe(cut==='prepared'?'interrupted':'committed-cleanup-pending');
    await expect(readCompletedModernLocalExecution(f.root,f.execution.fingerprint)).rejects.toThrow(/recovery first/);
    const lock=await projectMutationLockPath(f.root),identity=await lstat(lock),bytes=await readFile(lock),latest=await lstat(lock);
    expect(latest.ino).toBe(identity.ino);expect(latest.dev).toBe(identity.dev);expect(await readFile(lock)).toEqual(bytes);
    console.info('MR2_C1_ACTUAL_EXIT '+JSON.stringify({cut,pid:childResult.pid,status:childResult.status,pidAbsent:true,lock,ino:identity.ino,digest:rawLocalDigest(bytes),testOnlyKnownOwnerCleanup:true}));
    await unlink(lock);
    const commands=vi.spyOn(NodeCommandRunner.prototype,'run');
    const recovered=await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint});
    expect(recovered.status).toBe(cut==='prepared'?'rolled-back':'local-complete-current');expect(commands).not.toHaveBeenCalled();
  },120000);
});
