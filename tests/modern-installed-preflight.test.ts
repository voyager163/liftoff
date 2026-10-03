import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectModernInstalledActivation, validateCapturedModernInstalledActivation } from '../src/application/governance/modern-installed-preflight.js';
import { inspectModernLocalRuntime, planModernLocalRuntime, reinspectModernLocalRuntime } from '../src/application/governance/modern-local-inputs.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../src/domain/project/manifest/v8-project.js';
import { readManifestPluginMetadata } from '../src/domain/project/manifest/plugins.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { createModernActivationRecordContract, type ModernPlanInput } from '../src/domain/governance/activation/modern-records.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import { reservedLocalVerificationJournalPath } from '../src/domain/governance/activation/modern-local-runtime.js';
import { createManifestHistoryIndex, encodeManifestHistoryIndex, manifestHistoryPaths } from '../src/domain/project/manifest/history.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { parseHistoryJson, historyRecord, rawHistoryDigest } from '../src/governance-activation/history-contracts.js';
import { readModernActivationSuccessorSource, planModernActivationSuccessor, prepareActivationHistorySuccessor } from '../src/governance-activation/migration-history.js';
import { capturedV3Records, capturedV3Successor, writeFixtureBytes, writeCapturedV3Successor } from './fixtures/activation-v3/fixture.js';
import { writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { historicalV2EvidenceBodyDigest, historicalV2PhaseContractDigest, validateHistoricalV2EvidenceRecord } from '../src/governance-activation/historical-v2.js';
import type { ManifestActiveLayout } from '../src/domain/project/contracts.js';

const io=vi.hoisted(()=>({opens:[] as string[],afterOpen:undefined as undefined|((target:string)=>Promise<void>)}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
    const target=String(args[0]);io.opens.push(target);const handle=await actual.open(...args);
    try{await io.afterOpen?.(target);return handle;}catch(error){await handle.close();throw error;}
  }};
});
const roots:string[]=[];
afterEach(async()=>{io.afterOpen=undefined;io.opens=[];for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});vi.restoreAllMocks();});
const contracts={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract};
const timestamp='2026-09-01T12:00:00.000Z',expiry='2026-09-01T13:00:00.000Z';
async function root(){const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'installed-preflight-')));roots.push(directory);return directory;}
function selected(leaf:ManifestV8ProjectLeaf,profile:'none'|'single-maintainer-gitflow'|'team-gitflow'){
  const work=leaf.project.workload;
  const resolution=composeModernManifestPlugins({workload:work.kind,...(work.kind==='genai'?{variant:work.pattern}:{}),stack:work.apiStack,cloud:work.cloud,
    workflow:leaf.project.specWorkflow,agents:leaf.project.agents,frontend:work.frontend?'included':'omitted',environments:work.environments,governanceProfile:profile},
    {safeProjectName:toSafeProjectName(leaf.project.name)}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},
    {stack:work.apiStack,cloud:work.cloud,workflow:leaf.project.specWorkflow,agents:leaf.project.agents});
  return {selection:{...leaf,profile},plugins,activeLayout:{schemaVersion:1 as const,state:'unresolved' as const,bindings:[] as const}};
}
async function fixture(workflow:'manual'|'openspec'|'spec-kit'='manual',profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='single-maintainer-gitflow'){
  const directory=await root(),leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project:{name:'Installed local fixture',workload:{kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:false,environments:['dev']},
      specWorkflow:workflow,agents:workflow==='manual'?[]:['github-copilot'],...(workflow==='spec-kit'?{defaultAgent:'github-copilot'}:{})},
    framework:workflow==='manual'?{state:'not-required'}:{state:'initialized',adapter:workflow,contractVersion:'1.2.3'}
  });
  const input=selected(leaf,profile),core=buildModernManagedCore(input);
  const context=profile==='none'?undefined:createModernGovernanceContextContract(contracts).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(contracts).parseManifestV8({
    artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,
    project:leaf.project,framework:leaf.framework,plugins:input.plugins,activeLayout:input.activeLayout,
    governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(file=>({logicalName:file.logicalName,category:file.category,pathParts:file.pathParts,contentHash:`sha256:${rawHistoryDigest(Buffer.from(file.content))}`})),
    projectArtifacts:[],adoptionObservations:[]
  });
  for(const file of core)await writeFixtureBytes(directory,file.pathParts,file.content);
  await writeFixtureBytes(directory,['liftoff.manifest.json'],canonicalJson(manifest));
  const api=context&&profile!=='none'?createModernActivationRecordContract(projectCatalog,{
    recordedIdentity:context.governance.activationIdentity,profile,policyVersion:context.governance.policyVersion,
    selection:{...leaf,profile},pluginResolutionDigest:input.plugins.resolutionDigest,activeLayoutDigest:context.governance.activationIdentity.activeLayoutDigest
  }):undefined;
  const state=api?.createInitialState({repository:{id:'local:11111111-1111-4111-8111-111111111111',name:leaf.project.name,defaultBranch:'develop'},
    applicability:{statePath:'none',privateStagingDast:'unknown',credentialRequired:'unknown'},createdAt:timestamp});
  return {root:directory,manifest,input,api,state,write:(parts:readonly string[],bytes:string|Buffer,mode=0o600)=>writeFixtureBytes(directory,parts,bytes,mode)};
}
function planInput(api:NonNullable<Awaited<ReturnType<typeof fixture>>['api']>):ModernPlanInput{
  const id='local-inputs-valid',phase=api.graph.phases.find(phase=>phase.id===id)!;
  return {phaseId:id,createdAt:timestamp,expiresAt:expiry,stateHash:null,baselineDigest:'a'.repeat(64),inputDigest:'b'.repeat(64),transitionDigest:'c'.repeat(64),operations:[],
    approval:{gateKind:'none',required:false,envelopeId:null,envelopeHash:null,evaluation:{phaseId:id,gateKind:'none',questionKind:null,approvalRequired:false,status:'not-required',envelopeId:null,envelopeHash:null,reasons:[],expansionReasons:[]}},
    rollbackPlan:{phaseId:id,strategy:phase.rollback.kind,target:phase.rollback.target,operations:[],retained:[],cleanupWarnings:[]},noSecrets:true};
}
async function completedCurrent(){
  const f=await fixture(),api=f.api!,plan=api.createPlan(planInput(api));
  const proof=api.createEvidence({plan,evidenceId:'original-local-input',repositoryId:f.state!.repository.id,producedAt:timestamp,producer:'record-format-fixture-not-execution',result:'verified',payload:{kind:'local-inputs-valid.v1'}});
  const records={plans:[plan],evidence:[proof]},state=api.stateAfterOutcome({state:f.state!,plan,phaseState:'verified',updatedAt:timestamp,evidenceId:proof.evidenceId},records);
  await f.write(['governance','plans','plan.json'],canonicalJson(plan));
  await f.write(['governance','evidence',`${proof.evidenceId}.json`],canonicalJson(proof));
  await f.write(['governance','activation-state.json'],canonicalJson(state));
  return {...f,plan,proof,state};
}
async function source(version:1|2|3,retained=false){
  const directory=await root(),sample=capturedV3Successor(version===1?1:2);
  const manifest=version===3?capturedV3Records().manifest:parseHistoryJson(sample.files.get('liftoff.manifest.json')!,'original manifest');
  const state=structuredClone(version===3?historyRecord(sample.state,'state'):historyRecord(parseHistoryJson(sample.files.get('governance/activation-state.json')!,'state'),'state'));
  for(const field of ['bootstrapState','successorHistory','phaseOutputs','taskProjection','activationInputs'])delete state[field];
  state.activeChange=null;
  for(const value of Object.values(historyRecord(state.phases,'phases'))){
    const phase=historyRecord(value,'phase');Object.assign(phase,{state:'pending',evidence:[],approvals:[],blockers:[]});delete phase.operation;delete phase.executionPlanDigest;
  }
  if(retained){
    if(version!==2)throw new Error('This retention fixture is exact v2.');
    const file=sample.index.files.find(file=>file.kind==='evidence')!,original=validateHistoricalV2EvidenceRecord(parseHistoryJson(sample.files.get(file.originalPathParts.join('/'))!,'proof'));
    const id='remote-import-verified',payload={kind:`${id}.v1`},header={...original.header,phaseId:id,phaseContractDigest:historicalV2PhaseContractDigest(id),
      transition:{...original.header.transition,phaseId:id},result:'verified',producer:'original-retention-format-fixture',bodyDigest:historicalV2EvidenceBodyDigest(payload)};
    const proof={evidenceId:'original-import',header,payload};
    await writeFixtureBytes(directory,['governance','evidence','original-import.json'],canonicalJson(proof));
    state.bootstrapState={status:'retained',remoteImportEvidenceId:'original-import',remoteImportEvidenceDigest:canonicalSha256(header),
      retainedAt:'2026-08-01T00:00:00.000Z',disposeAfter:'2026-08-31T00:00:00.000Z',encryptedStatePathParts:[['protected','state.enc']],encryptionKeyPathParts:[['protected','key']]};
  }
  await writeFixtureBytes(directory,['liftoff.manifest.json'],JSON.stringify(manifest,null,'\t')+'\r\n',0o640);
  await writeFixtureBytes(directory,['governance','activation-state.json'],canonicalJson(state),0o600);
  return directory;
}
async function successor(version:1|2|3,retained=false,nested=false,overlap=false){
  const directory=nested?await root():await source(version,retained);
  if(nested)await writeCapturedV3Successor(directory,2);
  const original=await readModernActivationSuccessorSource(directory);
  const originalManifest=parseManifest(parseHistoryJson(original.captures.find(file=>file.pathParts.join('/')==='liftoff.manifest.json')!.content!,'source manifest'));
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:originalManifest.project,framework:originalManifest.framework});
  const selection=selected(leaf,'single-maintainer-gitflow');
  const activeLayout:ManifestActiveLayout=overlap?{schemaVersion:1,state:'bound',bindings:[{kind:'component',component:'backend',pathParts:['protected']}]}:selection.activeLayout;
  const input={...selection,activeLayout},core=buildModernManagedCore(input);
  const managed=[
    ...core.map(({logicalName,category,pathParts,content})=>({kind:'bytes' as const,logicalName,category,pathParts,content})),
    ...originalManifest.managedArtifacts.filter(file=>!core.some(target=>target.logicalName===file.logicalName)).map(file=>({kind:'retire-alias' as const,logicalName:file.logicalName}))
  ];
  const plan=await planModernActivationSuccessor(original,{...input,managed});
  const originalState=historyRecord(parseHistoryJson(original.captures.find(file=>file.pathParts.join('/')==='governance/activation-state.json')!.content!,'original state'),'original state');
  const anchor=String(historyRecord(originalState.repository,'repository').id);
  const preparation={schemaVersion:1 as const,preparationId:'22222222-2222-4222-8222-222222222222',preparedAt:timestamp,
    localRepositoryId:anchor.startsWith('local:')?anchor:'local:11111111-1111-4111-8111-111111111111'};
  const prepared=await prepareActivationHistorySuccessor(plan,Buffer.from(plan.manifest.content),preparation,'2026-09-02T00:00:00.000Z');
  for(const mutation of prepared.mutations){
    if(mutation.type==='write')await writeFixtureBytes(directory,mutation.pathParts,mutation.content,mutation.mode);
    else await fs.rm(path.join(directory,...mutation.pathParts),{force:true});
  }
  for(const file of core)await writeFixtureBytes(directory,file.pathParts,file.content);
  await writeFixtureBytes(directory,['liftoff.manifest.json'],prepared.manifestBytes);
  return {root:directory,prepared,plan};
}

describe('actual read-only installed activation classification',()=>{
  it.each((['single-maintainer-gitflow','team-gitflow'] as const).flatMap(profile=>(['manual','openspec','spec-kit'] as const).map(workflow=>({profile,workflow}))))(
    'distinguishes actual fresh/current $profile/$workflow without execution',async({profile,workflow})=>{
      const f=await fixture(workflow,profile);
      expect(await inspectModernInstalledActivation(f.root)).toMatchObject({status:'observed',classification:'fresh',current:null,localPublication:'codec-unavailable-not-authorized'});
      await f.write(['governance','activation-state.json'],canonicalJson(f.state));
      const result=await inspectModernInstalledActivation(f.root);
      expect(result).toMatchObject({status:'observed',classification:'current',current:{state:f.state}});
      if(result.status!=='observed')throw new Error('Expected actual observation.');
      expect(await validateCapturedModernInstalledActivation(result.snapshot)).toEqual(result);
    }
  );
  it.each(['manual','openspec','spec-kit'] as const)('keeps none/%s independent from activation state',async workflow=>{
    const f=await fixture(workflow,'none'),result=await inspectModernInstalledActivation(f.root);
    expect(result).toMatchObject({status:'observed',classification:'governance-none',current:null,retention:[]});
    await f.write(['governance','activation-state.json'],'{}');
    expect((await inspectModernInstalledActivation(f.root)).status).toBe('blocked');
  });
  it('validates exact plan/evidence/state links without granting new execution',async()=>{
    const f=await completedCurrent(),result=await inspectModernInstalledActivation(f.root);
    expect(result).toMatchObject({status:'observed',classification:'current',current:{state:f.state},localPublication:'codec-unavailable-not-authorized'});
  });
  it.each(['missing-proof','missing-plan','wrong-repository','future-state','mixed-identity','bad-json','orphan','duplicate-plan','reconciliation'] as const)(
    'rejects $0 installed record fault',async fault=>{
      const f=await completedCurrent();
      if(fault==='missing-proof')await fs.rm(path.join(f.root,'governance/evidence/original-local-input.json'));
      if(fault==='missing-plan')await fs.rm(path.join(f.root,'governance/plans/plan.json'));
      if(fault==='wrong-repository')await f.write(['governance','evidence','original-local-input.json'],canonicalJson({...f.proof,header:{...f.proof.header,repositoryId:'other'}}));
      if(fault==='future-state')await f.write(['governance','activation-state.json'],canonicalJson({...f.state,schemaVersion:99}));
      if(fault==='mixed-identity')await f.write(['governance','activation-state.json'],canonicalJson({...f.state,identity:{...f.state.identity,policyVersion:'future'}}));
      if(fault==='bad-json')await f.write(['governance','activation-state.json'],'not JSON');
      if(fault==='orphan')await fs.rm(path.join(f.root,'governance/activation-state.json'));
      if(fault==='duplicate-plan')await f.write(['governance','plans','duplicate.json'],canonicalJson(f.plan));
      if(fault==='reconciliation')await f.write(['governance','reconciliation','future.json'],'{}');
      expect((await inspectModernInstalledActivation(f.root)).status).toBe('blocked');
    }
  );
  it.each([
    ['.liftoff','reviewed-update-transaction.json'],['.liftoff','reviewed-repair-transaction.json'],[...reservedLocalVerificationJournalPath]
  ].map(parts=>[parts]))('blocks pending %j before opening manifest or record payload',async parts=>{
    const f=await fixture();await f.write(parts,'no codec authority');io.opens=[];
    expect((await inspectModernInstalledActivation(f.root)).status).toBe('blocked');
    expect(io.opens).toEqual([]);
  });
  it('reserves the local journal without pretending to decode it',async()=>{
    const f=await fixture();await f.write(reservedLocalVerificationJournalPath,'{"schemaVersion":3,"kind":"local-verification"}');
    const result=await inspectModernInstalledActivation(f.root);expect(result).toMatchObject({status:'blocked',blockers:[expect.stringContaining('real recovery codec')]});
  });
  it('uses raw retention declarations only to deny protected reads, never to grant record validity',async()=>{
    const f=await fixture(),policy=f.manifest.managedArtifacts.find(file=>file.logicalName==='repository-governance-policy')!;
    await f.write(['governance','activation-state.json'],canonicalJson({...f.state,bootstrapState:{
      encryptedStatePathParts:[policy.pathParts],encryptionKeyPathParts:[['private-key']]
    }}));
    io.opens=[];
    const result=await inspectModernInstalledActivation(f.root);
    expect(result.status).toBe('blocked');
    expect(io.opens.some(file=>file===path.join(f.root,...policy.pathParts))).toBe(false);
  });
});

describe('actual original and preserved historical sources',()=>{
  it.each([1,2,3] as const)('reads original releasedv%i without making it current',async version=>{
    const directory=await source(version),result=await inspectModernInstalledActivation(directory);
    expect(result).toMatchObject({status:'observed',classification:'released-source',current:null});
    const runtime=await inspectModernLocalRuntime(directory),plan=await planModernLocalRuntime(runtime);
    expect(plan.status).toBe('blocked');expect(plan.execution).toBe('not-authorized');
  });
  it.each([1,2,3] as const)('validates actually materialized C2Bv%i successor state/history/journal',async version=>{
    const f=await successor(version),result=await inspectModernInstalledActivation(f.root);
    expect(result).toMatchObject({status:'observed',classification:'successor',current:{state:f.prepared.successor}});
    if(result.status!=='observed')throw new Error(JSON.stringify(result));
    expect(await validateCapturedModernInstalledActivation(result.snapshot)).toEqual(result);
  },60_000);
  it('validates nested released source ancestry without retagging old bytes',async()=>{
    const f=await successor(3,false,true);
    expect(await inspectModernInstalledActivation(f.root)).toMatchObject({status:'observed',classification:'successor'});
  },60_000);
  it.each(['index','copy','journal','state-link','manifest-link'] as const)('rejects altered stored successor %s',async fault=>{
    const f=await successor(2),reference=f.plan.manifest.manifest.sourceManifestHistory!;
    if(fault==='index')await writeFixtureBytes(f.root,['governance','history',reference.snapshotId,'index.json'],'{}');
    if(fault==='copy'){
      const mutation=f.prepared.mutations.find(m=>m.type==='write'&&m.pathParts.at(-1)==='index.json');
      if(!mutation||mutation.type!=='write')throw new Error('Expected actual stored source index.');
      const index=historyRecord(parseHistoryJson(Buffer.from(mutation.content),'index'),'index');
      const files=index.files as {copyPathParts:string[]}[];
      await writeFixtureBytes(f.root,files[0].copyPathParts,'changed');
    }
    if(fault==='journal')await writeFixtureBytes(f.root,['governance','migration-state.json'],canonicalJson({...f.prepared.journal,semanticTransitionDigest:'0'.repeat(64)}));
    if(fault==='state-link')await writeFixtureBytes(f.root,['governance','activation-state.json'],canonicalJson({...f.prepared.successor,successorHistory:{...f.prepared.successor.successorHistory,historyIndexDigest:'0'.repeat(64)}}));
    if(fault==='manifest-link')await writeFixtureBytes(f.root,['liftoff.manifest.json'],canonicalJson({...f.plan.manifest.manifest,sourceManifestHistory:{...reference,indexDigest:'0'.repeat(64)}}));
    expect((await inspectModernInstalledActivation(f.root)).status).toBe('blocked');
  },60_000);
  it('preserves retention dates and protected paths without reading encrypted state or keys',async()=>{
    const f=await successor(2,true);
    await writeFixtureBytes(f.root,['protected','state.enc'],'private retained payload');
    await writeFixtureBytes(f.root,['protected','key'],'private key bytes');
    io.opens=[];
    const result=await inspectModernInstalledActivation(f.root);
    expect(result).toMatchObject({status:'observed',classification:'successor',retention:[{
      retainedAt:'2026-08-01T00:00:00.000Z',disposeAfter:'2026-08-31T00:00:00.000Z',status:'retained',
      protectedPaths:[['protected','state.enc'],['protected','key']],authority:'preservation-only'
    }]});
    expect(io.opens.some(file=>file.includes('/protected/'))).toBe(false);
  },60_000);
  it('blocks selected runtime input overlapping retained scope before opening protected payloads',async()=>{
    const f=await successor(2,true,false,true);
    await writeFixtureBytes(f.root,['protected','state.enc'],'retained payload');
    await writeFixtureBytes(f.root,['protected','key'],'retained key');
    io.opens=[];
    const runtime=await inspectModernLocalRuntime(f.root);
    expect(runtime).toMatchObject({status:'observed',local:{status:'blocked',blockers:[expect.stringContaining('retention boundary')]}});
    expect(io.opens.some(file=>file.includes('/protected/'))).toBe(false);
    expect((await planModernLocalRuntime(runtime)).status).toBe('blocked');
  },60_000);
  it.each(['none','single-maintainer-gitflow'] as const)('reads genuine %s manifest-only preservation and rejects damaged original bytes',async profile=>{
    const directory=await root(),content=readFileSync(new URL(`./fixtures/contract-baseline-0.12.3/manifests/${profile==='none'?'0.3.4':'0.9.9'}-standard-go.json`,import.meta.url));
    const original=parseManifest(parseHistoryJson(content,'source manifest'));
    const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:original.project,framework:original.framework});
    const input=selected(leaf,profile),core=buildModernManagedCore(input);
    const index=createManifestHistoryIndex({artifactVersion:original.artifactVersion,digest:rawHistoryDigest(content),bytes:content.length,mode:0o640});
    const encoded=encodeManifestHistoryIndex(index),reference={schemaVersion:1 as const,kind:'manifest-history' as const,snapshotId:index.snapshotId,indexDigest:encoded.indexDigest};
    const candidate=createManifestV8Candidate({origin:'historical-successor',source:parseHistoryJson(content,'source'),profile,
      activeLayout:input.activeLayout,sourceManifestHistory:reference,managed:[
        ...core.map(({logicalName,category,pathParts,content})=>({kind:'bytes',logicalName,category,pathParts,content})),
        ...original.managedArtifacts.filter(file=>!core.some(target=>target.logicalName===file.logicalName)).map(file=>({kind:'retire-alias',logicalName:file.logicalName}))
      ]});
    const paths=manifestHistoryPaths(reference);
    await writeFixtureBytes(directory,['liftoff.manifest.json'],candidate.content);
    for(const artifact of core)await writeFixtureBytes(directory,artifact.pathParts,artifact.content);
    await writeFixtureBytes(directory,paths.indexPathParts,encoded.content);
    await writeFixtureBytes(directory,paths.manifestPathParts,content,0o444);
    expect(await inspectModernInstalledActivation(directory)).toMatchObject({status:'observed',classification:profile==='none'?'governance-none':'fresh'});
    await fs.chmod(path.join(directory,...paths.manifestPathParts),0o600);
    await writeFixtureBytes(directory,paths.manifestPathParts,Buffer.from('{}'));
    expect((await inspectModernInstalledActivation(directory)).status).toBe('blocked');
  });
  it('continues to read the original complete v1 fixture without changing it',async()=>{
    const directory=await root(),fixture=await writeHistoricalV1Fixture(directory);
    const result=await inspectModernInstalledActivation(directory);
    expect(result).toMatchObject({status:'observed',classification:'released-source'});
    for(const [name,bytes]of fixture.files)expect(await fs.readFile(path.join(directory,name))).toEqual(bytes);
  },60_000);
  it.each(['0.3.4','0.4.1','0.7.0','0.8.0','0.9.9','0.12.3'])('keeps stateless released%s sources diagnostic-only',async version=>{
    const directory=await root(),bytes=readFileSync(new URL(`./fixtures/contract-baseline-0.12.3/manifests/${version}-standard-go.json`,import.meta.url));
    await writeFixtureBytes(directory,['liftoff.manifest.json'],bytes);
    expect(await inspectModernInstalledActivation(directory)).toMatchObject({status:'observed',classification:'released-source',current:null});
  });
  it('does not write records, normalize source bytes or change modes during repeated preflight',async()=>{
    const f=await successor(3);
    const before=new Map<string,{digest:string;mode:number}>();
    async function inventory(at:string,relative=''):Promise<void>{
      for(const name of await fs.readdir(at)){
        const absolute=path.join(at,name),parts=relative?`${relative}/${name}`:name,stat=await fs.lstat(absolute);
        if(stat.isDirectory())await inventory(absolute,parts);
        else before.set(parts,{digest:rawHistoryDigest(await fs.readFile(absolute)),mode:stat.mode&0o7777});
      }
    }
    await inventory(f.root);
    const first=await inspectModernInstalledActivation(f.root),second=await inspectModernInstalledActivation(f.root);
    expect(first.status).toBe('observed');expect(second.status).toBe('observed');
    if(first.status==='observed'&&second.status==='observed')expect(second.binding).toBe(first.binding);
    const saved=new Map(before);before.clear();await inventory(f.root);expect(before).toEqual(saved);
  },60_000);
});

describe('copied observations and independent current storage',()=>{
  it('rejects initial hooks and captures nested source data before yielding',async()=>{
    const f=await completedCurrent(),result=await inspectModernInstalledActivation(f.root);
    if(result.status!=='observed')throw new Error('Expected installed state.');
    const copy=structuredClone(result.snapshot),pending=validateCapturedModernInstalledActivation(copy),getter=vi.fn(()=>{throw new Error('late hook');});
    Object.defineProperty(copy.files[0],'content',{get:getter,enumerable:true});
    expect(await pending).toEqual(result);expect(getter).not.toHaveBeenCalled();
    await expect(validateCapturedModernInstalledActivation(copy)).rejects.toThrow(/accessor/);
  });
  it.for(['membership','bytes','mode','inode'] as const)('fresh observation distinguishes changed installed %s',async(change,{skip})=>{
    if(change==='mode'&&process.platform==='win32')skip('POSIX stored mode changes are not qualified on Windows.');
    const f=await completedCurrent(),first=await inspectModernInstalledActivation(f.root);
    if(first.status!=='observed')throw new Error('Expected installed source.');
    const target=path.join(f.root,'governance/activation-state.json');
    if(change==='membership')await f.write(['governance','plans','notes.txt'],'local note');
    if(change==='bytes')await f.write(['governance','activation-state.json'],JSON.stringify(f.state,null,2)+'\n');
    if(change==='mode')await fs.chmod(target,0o640);
    if(change==='inode'){const bytes=await fs.readFile(target);await fs.rm(target);await f.write(['governance','activation-state.json'],bytes);}
    const second=await inspectModernInstalledActivation(f.root);
    expect(second.status).toBe('observed');if(second.status==='observed')expect(second.binding).not.toBe(first.binding);
  });
  it('refuses changed controls during capture and never treats a late caller root as authority',async()=>{
    const f=await completedCurrent();let changed=false;
    io.afterOpen=async target=>{if(!changed&&target.endsWith('activation-state.json')){changed=true;await fs.appendFile(target,' ');}};
    expect((await inspectModernInstalledActivation(f.root)).status).toBe('blocked');
  });
  it('rejects denied control reads with sanitized diagnostics and no record fallback',async()=>{
    const f=await completedCurrent();
    io.afterOpen=async target=>{if(target.endsWith('activation-state.json'))throw Object.assign(new Error('private source text must not be reported'),{code:'EACCES'});};
    const result=await inspectModernInstalledActivation(f.root);
    expect(result).toEqual({status:'blocked',blockers:['Installed preflight control access was denied; no readiness is inferred.']});
  });
  it('distinguishes root and parent replacement with identical stored bytes',async()=>{
    const f=await completedCurrent(),first=await inspectModernInstalledActivation(f.root);
    if(first.status!=='observed')throw new Error('Expected installed source.');
    const previous=`${f.root}-old`;await fs.rename(f.root,previous);roots.push(previous);
    await fs.cp(previous,f.root,{recursive:true,preserveTimestamps:true});
    const changed=await inspectModernInstalledActivation(f.root);
    expect(changed.status).toBe('observed');if(changed.status==='observed')expect(changed.binding).not.toBe(first.binding);
    const controls=path.join(f.root,'governance'),oldControls=path.join(f.root,'old-controls');
    await fs.rename(controls,oldControls);await fs.cp(oldControls,controls,{recursive:true,preserveTimestamps:true});
    const replaced=await inspectModernInstalledActivation(f.root);
    expect(replaced.status).toBe('observed');if(replaced.status==='observed'&&changed.status==='observed')expect(replaced.binding).not.toBe(changed.binding);
  });
  it('rejects forged collection membership and missing physical observations',async()=>{
    const f=await completedCurrent(),current=await inspectModernInstalledActivation(f.root);
    if(current.status!=='observed')throw new Error('Expected installed source.');
    for(const fault of ['member','physical','digest'] as const){
      const copy=structuredClone(current.snapshot);
      if(fault==='member')Reflect.set(copy,'directories',copy.directories.map(directory=>directory.pathParts.join('/')==='governance/evidence'?{...directory,entries:[]}:directory));
      if(fault==='physical')Reflect.set(copy,'physical',copy.physical.filter(entry=>entry.path!==path.join(f.root,'governance','activation-state.json')));
      if(fault==='digest')Reflect.set(copy.files[0],'digest','0'.repeat(64));
      await expect(validateCapturedModernInstalledActivation(copy)).rejects.toThrow();
    }
  });
  it.each([0,1])('enforces actual1024 collection entries plus%i without truncation',async excess=>{
    const f=await fixture();
    for(let index=0;index<1024+excess;index++)await f.write(['governance','plans',`note-${index}.txt`],'');
    const result=await inspectModernInstalledActivation(f.root);
    expect(result.status).toBe(excess?'blocked':'observed');
  },60_000);
  it.for(['symlink','hardlink'] as const)('rejects unsafe installed %s records',async(kind,{skip})=>{
    const f=await completedCurrent(),file=path.join(f.root,'governance/activation-state.json'),other=path.join(f.root,'original-state.json');
    if(kind==='symlink'){
      await fs.rename(file,other);
      try{await fs.symlink(other,file);}
      catch(error){
        if(process.platform==='win32'&&['EPERM','EACCES','ENOSYS'].includes((error as NodeJS.ErrnoException).code??''))skip('This Windows host does not grant symlink capability.');
        throw error;
      }
    }
    else await fs.link(file,other);
    expect((await inspectModernInstalledActivation(f.root)).status).toBe('blocked');
  });
});
