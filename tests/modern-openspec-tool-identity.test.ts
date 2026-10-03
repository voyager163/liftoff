import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {prepareModernLocalExecution,approveModernLocalExecution,inspectModernLocalExecution,readCompletedModernLocalExecution,loadLocalExecutionConsent} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {createModernLocalWorkspace} from '../src/adapters/filesystem/modern-local-workspaces.js';
import {createLocalExecutionRecordStore} from '../src/adapters/filesystem/update-previews.js';
import {NodeCommandRunner} from '../src/process-runner.js';
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
import {canonicalJson,canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {openSpecExecutionAdmission,validateLocalExecutionPreview,validateLocalExecutionConsentRecord,validateLocalExecutionState,validateLocalExecutionResult,assertExecutableLocalExecutionPreview,
  localExecutionPolicy,
  type LocalExecutionPreview,type LocalExecutionState,type LocalExecutionResult} from '../src/domain/governance/activation/modern-local-runtime.js';
function nativeMetadataEnabled(lane:string,versionBudget:string|undefined,supportBudget:string|undefined,qualifiedRuntime:boolean):boolean{
  if(lane==='auto'||lane==='portable')return false;
  if(lane!=='native')throw new Error('Unknown O-B1 test lane.');
  if(!qualifiedRuntime)throw new Error('O-B1 requires qualified native runtime.');
  for(const [name,value,minimum,maximum]of [['OB1_VERSION_REMAINING',versionBudget,2,16],['OB1_SUPPORT_REMAINING',supportBudget,10,112]] as const){
    if(value===undefined||!/^(0|[1-9][0-9]*)$/u.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<minimum||Number(value)>maximum)
      throw new Error(`O-B1 native metadata requires explicit integer ${name} between ${minimum} and ${maximum} before fixture allocation.`);
  }
  return true;
}
const lane=process.env.LIFTOFF_HCL_TEST_LANE??'auto',native=nativeMetadataEnabled(lane,process.env.OB1_VERSION_REMAINING,process.env.OB1_SUPPORT_REMAINING,
  process.platform==='darwin'&&process.arch==='arm64'&&process.versions.node==='24.21.0');
if(!native)console.info('OB1_NATIVE_METADATA_UNRUN '+JSON.stringify({lane,reason:'requires explicit native lane and finite probe budgets'}));
const nativeIt=it.skipIf(!native),roots:{path:string;ino:number;dev:number}[]=[];
let versions=0,support=0;
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0)){const s=await lstat(root.path);expect(s.ino).toBe(root.ino);expect(s.dev).toBe(root.dev);await rm(root.path,{recursive:true});}});
async function fixture(profile:'none'|'single-maintainer-gitflow'){
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'ob1-contract-'))),st=await lstat(directory);roots.push({path:directory,ino:st.ino,dev:st.dev});
  const root=path.join(directory,'project');await mkdir(root);
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:{name:'OpenSpec Identity Fixture',workload:{kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:true,environments:['dev']},specWorkflow:'openspec',agents:['github-copilot']},
    framework:{state:'initialized',adapter:'openspec',contractVersion:projectCatalog.getFrameworkDefinition('openspec').version}});
  const selection={...leaf,profile},resolution=composeModernManifestPlugins({workload:'standard',stack:'node-fastify',cloud:'azure',workflow:'openspec',agents:['github-copilot'],frontend:'included',environments:['dev'],governanceProfile:profile},{safeProjectName:'openspec-identity-fixture'}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},{stack:'node-fastify',cloud:'azure',workflow:'openspec',agents:['github-copilot']});
  const source=resolveModernManifestV8SourceContract({selection,recordedPlugins:plugins});
  const activeLayout={schemaVersion:1,state:'bound',bindings:[...source.layoutDescriptor.components.map(component=>({kind:'component',component,pathParts:['Source Space',component.replace(':',' ')]})),
    {kind:'artifact',logicalName:'docker-compose',pathParts:['compose.yml']}]};
  const ctx={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract},input={selection,plugins,activeLayout},core=buildModernManagedCore(input);
  const context=profile==='none'?undefined:createModernGovernanceContextContract(ctx).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(ctx).parseManifestV8({artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,project:leaf.project,framework:leaf.framework,plugins,activeLayout,
    governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(f=>({logicalName:f.logicalName,category:f.category,pathParts:f.pathParts,contentHash:`sha256:${rawLocalDigest(f.content)}`})),projectArtifacts:[],adoptionObservations:[]});
  async function put(parts:readonly string[],text:string){const p=path.join(root,...parts);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,text);}
  await put(['liftoff.manifest.json'],JSON.stringify(manifest)+'\n');for(const f of core)await put(f.pathParts,f.content);
  for(const component of source.layoutDescriptor.components){
    const parts=['Source Space',component.replace(':',' ')];
    if(component==='backend'){await put([...parts,'package.json'],'{"name":"ob1-backend","version":"1.0.0","scripts":{"test":"node --test"}}');await put([...parts,'tests','input.test.cjs'],'throw new Error("must never execute");');}
    else if(component==='frontend'){await put([...parts,'package.json'],'{"name":"ob1-frontend","version":"1.0.0","scripts":{"build":"node build.cjs"}}');await put([...parts,'build.cjs'],'throw new Error("must never execute");');}
    else if(component.startsWith('opentofu-'))await put([...parts,'main.tf'],'locals {\n  enabled = true\n}\n');else await put([...parts,'source.txt'],'owned input\n');
  }
  await put(['compose.yml'],'services:\n  app:\n    image: example/local:source\n');
  for(const parts of frameworkOutputPaths({workflow:'openspec',agents:['github-copilot']}))await put(parts,'Preinitialized contract fixture; not official initializer output.\n');
  await put(['openspec','config.yaml'],'schema: spec-driven\n');
  const change=['openspec','changes','bootstrap-openspec-identity-fixture'];
  await mkdir(path.join(root,'openspec','changes','archive'),{recursive:true});
  await put([...change,'.openspec.yaml'],'schema: spec-driven\n');
  await put([...change,'proposal.md'],'### New Capabilities\n- `node-fastify-application-baseline`: Readonly contract.\n');
  await put([...change,'design.md'],'# Contract design only\n');
  await put([...change,'tasks.md'],'- [ ] 1.1 Do not execute project checks under O-B1.\n');
  await put([...change,'specs','node-fastify-application-baseline','spec.md'],'## Purpose\n\nThis contract fixture describes an observed source and grants no project execution or archive authority.\n\n## ADDED Requirements\n\n### Requirement: Preserve input\nThe system SHALL preserve the fixture.\n\n#### Scenario: Inspect\n- **WHEN** inspected\n- **THEN** it remains unchanged\n');
  return {root};
}
describe('closed OpenSpec tool admission',()=>{
  it('refuses all retained OpenSpec indicators at the shared authority guard',()=>{
    const examples=[
      {schemaVersion:1,checks:[{command:{executable:'openspec'},reasons:[]}],tools:[],selectedPlan:null},
      {schemaVersion:1,checks:[],tools:[{id:'openspec'}],selectedPlan:null},
      {schemaVersion:1,checks:[{reasons:['openspec-active-source']}],tools:[],selectedPlan:null},
      {schemaVersion:1,checks:[],tools:[],selectedPlan:{identity:{workflow:'openspec'}}},
      {schemaVersion:1,checks:[],tools:[],selectedPlan:null,executionAdmission:openSpecExecutionAdmission}
    ];
    for(const value of examples)expect(()=>Reflect.apply(assertExecutableLocalExecutionPreview,undefined,[value])).toThrow(/openspec-workflow/);
  });
  nativeIt.each(['none','single-maintainer-gitflow'] as const)('persists blocked %s preview from real metadata and rejects every execution surface',async profile=>{
    const f=await fixture(profile),original=NodeCommandRunner.prototype.run,neutralPaths=new Set<string>(),dispatches:unknown[]=[];
    const spy=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      const isOpenSpec=command.args.some(a=>a.endsWith('/openspec/bin/openspec.js'));
      expect(command.args.at(-1)).toMatch(/^(?:--version|--short|-json)$/);
      if(isOpenSpec){expect(command.args.slice(1)).toEqual(['--version']);expect(++versions).toBeLessThanOrEqual(Number(process.env.OB1_VERSION_REMAINING??0));}
      else expect(++support).toBeLessThanOrEqual(Number(process.env.OB1_SUPPORT_REMAINING??0));
      const effective=Object.fromEntries(Object.entries({...process.env,...options?.env}).filter(([,v])=>v!==undefined));
      expect(effective.NODE_OPTIONS).toBeUndefined();expect(effective.NODE_PATH).toBeUndefined();
      if(isOpenSpec){expect(effective.OPENSPEC_TELEMETRY).toBe('0');expect(effective.OPENSPEC_NO_COMPLETIONS).toBe('1');expect(options?.timeoutMs).toBe(15000);expect(options?.maxOutputBytes).toBe(8192);}
      console.info('OB1_METADATA_DISPATCH '+JSON.stringify({openspec:isOpenSpec,command,options:{cwd:options?.cwd,timeoutMs:options?.timeoutMs,maxOutputBytes:options?.maxOutputBytes,ensureProcessTreeSettled:options?.ensureProcessTreeSettled},effective,clearedKeys:Object.keys(process.env)}));
      if(options?.cwd?.startsWith('/private/tmp/liftoff-local-tools-'))neutralPaths.add(options.cwd);
      const result=await original.call(this,command,options);expect(result.processTreeSettled).toBe(true);expect(result.status).toBe(0);
      dispatches.push({command,result});console.info('OB1_METADATA_RESULT '+JSON.stringify({command,result}));return result;
    });
    const preview=await prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]});
    expect(preview.schemaVersion).toBe(2);if(preview.schemaVersion!==2)throw new Error('Expected blocked schema2.');
    expect(preview.executionAdmission).toEqual(openSpecExecutionAdmission);
    const openspec=preview.tools.find(t=>t.id==='openspec');if(!openspec||!('distribution'in openspec))throw new Error('Missing actual distribution.');
    expect(openspec.distribution.counts).toEqual({files:2590,directories:299,symlinks:2,totalBytes:11862860});
    expect(Buffer.byteLength(canonicalJson(preview))).toBeLessThanOrEqual(65536);
    expect(preview.selectedPlan===null).toBe(profile==='none');
    const count=spy.mock.calls.length,store=createLocalExecutionRecordStore(f.root);
    expect(await inspectModernLocalExecution(f.root,preview.fingerprint)).toMatchObject({status:'blocked',admission:openSpecExecutionAdmission,execution:'not-authorized'});
    const scopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:false,dependencyNetwork:false,workflowFinalization:false as const,publishLocalRecords:false as const};
    await expect(approveModernLocalExecution(f.root,preview.fingerprint,scopes)).rejects.toThrow(/openspec-workflow/);
    await expect(loadLocalExecutionConsent(f.root,preview,store)).rejects.toThrow(/openspec-workflow/);
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/openspec-workflow/);
    await expect(createModernLocalWorkspace(f.root,preview,store)).rejects.toThrow(/openspec-workflow/);
    await expect(readCompletedModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/openspec-workflow/);
    expect(spy.mock.calls.length).toBe(count);expect(await store.read('consent',preview.fingerprint)).toBeNull();expect(await store.readState(preview.fingerprint)).toBeNull();
    expect(()=>validateLocalExecutionConsentRecord(f.root,preview,{},new Date())).toThrow(/no legitimate/);
    expect(()=>validateLocalExecutionState({} as LocalExecutionState,preview)).toThrow(/no legitimate/);
    expect(()=>validateLocalExecutionResult({} as LocalExecutionResult,preview)).toThrow(/no legitimate/);
    const {fingerprint:_old,...body}=preview,downgraded={...body,schemaVersion:1};expect(()=>Reflect.apply(validateLocalExecutionPreview,undefined,[{...downgraded,fingerprint:canonicalSha256(downgraded)},new Date()])).toThrow();
    // A format-only old preview remains inspectable, never current authority.
    const {executionAdmission:_admission,...oldBody}=body;
    const legacyBody={...oldBody,schemaVersion:1 as const,policyDigest:canonicalSha256(localExecutionPolicy),tools:preview.tools.map(tool=>{
      if(!('distribution'in tool))return tool;
      const {distribution:_distribution,kind:_kind,schemaVersion:_version,launcherObservation:_launcher,digest:_digest,...old}=tool;
      return {...old,digest:canonicalSha256(old)};
    })};
    const legacy={...legacyBody,fingerprint:canonicalSha256(legacyBody)};
    expect(validateLocalExecutionPreview(legacy,new Date())).toEqual(legacy);
    await store.write('preview',legacy.fingerprint,legacy);
    expect(await inspectModernLocalExecution(f.root,legacy.fingerprint)).toMatchObject({status:'blocked',execution:'not-authorized'});
    await expect(approveModernLocalExecution(f.root,legacy.fingerprint,scopes)).rejects.toThrow(/openspec-workflow/);
    await expect(readCompletedModernLocalExecution(f.root,legacy.fingerprint)).rejects.toThrow(/openspec-workflow/);
    expect(spy.mock.calls.length).toBe(count);
    await store.write('consent',preview.fingerprint,{kind:'liftoff-local-execution-consent',schemaVersion:1,projectRoot:f.root,fingerprint:preview.fingerprint});
    await expect(inspectModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/no legitimate/);
    for(const p of neutralPaths)await expect(lstat(p)).rejects.toMatchObject({code:'ENOENT'});
    console.info('OB1_ACTUAL_BLOCKED_PREVIEW '+JSON.stringify({profile,preview,previewBytes:Buffer.byteLength(canonicalJson(preview)),toolBytes:Buffer.byteLength(canonicalJson(openspec)),dispatches:dispatches.length,neutralCleanup:[...neutralPaths]}));
  },120000);
});

async function historicalFormatFixture(stateKind:'missing'|'not-finished'|'wrong-result'|'matching'){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ob1-r1-history-format-'))),owner=await lstat(root);
  roots.push({path:root,ino:owner.ino,dev:owner.dev});
  const marker=path.join(root,'never-executed.js'),content='// Historical format fixture; never executed or an eligible installed tool.\n';
  await writeFile(marker,content);const st=await lstat(marker,{bigint:true});
  const toolBody={id:'openspec' as const,launcherPath:marker,executablePath:marker,prefixArgs:[],version:'1.11.0',versions:{openspec:'1.11.0'},
    files:[{path:marker,digest:rawLocalDigest(content),bytes:Number(st.size),mode:Number(st.mode&0o7777n),device:String(st.dev),inode:String(st.ino),
      modifiedNs:String(st.mtimeNs),changedNs:String(st.ctimeNs)}],probe:{executable:marker,args:['--version']}};
  const now=Date.now(),createdAt=new Date(now-2000).toISOString(),startedAt=new Date(now-1500).toISOString(),completedAt=new Date(now-1000).toISOString();
  const body:Omit<LocalExecutionPreview,'fingerprint'>={kind:'liftoff-local-execution-preview',schemaVersion:1,operationKind:'verify-local',projectRoot:root,operationId:randomUUID(),
    createdAt,expiresAt:new Date(now+600000).toISOString(),installedBinding:'1'.repeat(64),observationDigest:'2'.repeat(64),physicalDigest:'3'.repeat(64),
    baselineDigest:'4'.repeat(64),recipeDigest:'5'.repeat(64),policyDigest:canonicalSha256(localExecutionPolicy),
    checks:[{id:'source-consistency',status:'planned',reasons:[],command:null,cwdPathParts:[],env:{},prerequisites:[],effects:[]}],
    tools:[{...toolBody,digest:canonicalSha256(toolBody)}],preparation:[],preparationDigest:canonicalSha256([]),outputRoles:[],selectedPlan:null,selectedPlanDigest:null};
  const preview=validateLocalExecutionPreview({...body,schemaVersion:1,fingerprint:canonicalSha256(body)},new Date());
  const resultBody:Omit<LocalExecutionResult,'resultDigest'>={kind:'liftoff-local-execution-result',schemaVersion:1,projectRoot:root,fingerprint:preview.fingerprint,operationId:preview.operationId,
    status:'checks-verified',complete:true,startedAt,completedAt,checks:[{id:'source-consistency',status:'passed',code:'passed',
      commandDigest:canonicalSha256({kind:'in-process',id:'source-consistency'}),toolDigest:null,exitStatus:0,signal:null,startedAt,completedAt,
      stdoutDigest:null,stderrDigest:null,processTreeSettled:true}],preparation:[],inputsUnchanged:true,cleanupComplete:true,retainedWorkspace:null,
    policyDigest:preview.policyDigest,baselineDigest:preview.baselineDigest,selectedPlanDigest:null,failureCode:null};
  const result=validateLocalExecutionResult({...resultBody,resultDigest:canonicalSha256(resultBody)},preview),store=createLocalExecutionRecordStore(root);
  await store.write('preview',preview.fingerprint,preview);await store.write('result',preview.fingerprint,result);
  if(stateKind!=='missing'){
    const state:LocalExecutionState={kind:'liftoff-local-execution-state',schemaVersion:1,projectRoot:root,fingerprint:preview.fingerprint,operationId:preview.operationId,
      phase:stateKind==='not-finished'?'claimed':'finished',startedAt,updatedAt:completedAt,workspace:null,activity:null,settledActivities:0,
      resultDigest:stateKind==='not-finished'?null:stateKind==='wrong-result'?'f'.repeat(64):result.resultDigest,ownerTokenDigest:'a'.repeat(64)};
    validateLocalExecutionState(state,preview);expect((await store.compareExchangeState(preview.fingerprint,null,state)).value).toEqual(state);
  }
  return {root,preview,result,store};
}
describe('O-B1 R1 historical record consistency',()=>{
  it.each(['missing','not-finished','wrong-result','matching'] as const)('preserves the original complete-result invariant for %s format-only progress',async stateKind=>{
    const command=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async()=>{throw new Error('No command is authorized by a historical format fixture.');});
    const f=await historicalFormatFixture(stateKind),fingerprint=f.preview.fingerprint;
    const before={preview:await f.store.read('preview',fingerprint),result:await f.store.read('result',fingerprint),state:await f.store.readState(fingerprint)};
    if(stateKind==='matching')expect(await inspectModernLocalExecution(f.root,fingerprint)).toMatchObject({
      status:'blocked',execution:'not-authorized',admission:openSpecExecutionAdmission,result:f.result,state:{phase:'finished',resultDigest:f.result.resultDigest}});
    else await expect(inspectModernLocalExecution(f.root,fingerprint)).rejects.toThrow('Verified receipt lacks its actual finished operation progress.');
    const scopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:false,dependencyNetwork:false,
      workflowFinalization:false as const,publishLocalRecords:false as const};
    await expect(approveModernLocalExecution(f.root,fingerprint,scopes)).rejects.toThrow(/openspec-workflow/);
    await expect(executeModernLocalExecution(f.root,fingerprint)).rejects.toThrow(/openspec-workflow/);
    await expect(createModernLocalWorkspace(f.root,f.preview,f.store)).rejects.toThrow(/openspec-workflow/);
    await expect(readCompletedModernLocalExecution(f.root,fingerprint)).rejects.toThrow(/openspec-workflow/);
    expect(await f.store.read('consent',fingerprint)).toBeNull();
    expect({preview:await f.store.read('preview',fingerprint),result:await f.store.read('result',fingerprint),state:await f.store.readState(fingerprint)}).toEqual(before);
    expect(command).not.toHaveBeenCalled();
    console.info('OB1_R1_HISTORY '+JSON.stringify({stateKind,formatOnly:true,actualSuccessfulExecutionClaim:false,commands:0,recordsUnchanged:true,
      inspection:stateKind==='matching'?'blocked-readable':'rejected-inconsistent',fingerprint}));
  });
});

describe('O-B1 R2 native metadata opt-in',()=>{
  it.each(['auto','portable'])('keeps %s tool-free without interpreting a probe allowance',lane=>{
    expect(nativeMetadataEnabled(lane,undefined,undefined,true)).toBe(false);
    expect(nativeMetadataEnabled(lane,'16','112',true)).toBe(false);
    expect(nativeMetadataEnabled(lane,'invalid','Infinity',false)).toBe(false);
  });
  it.each([undefined,'',' ','invalid','NaN','Infinity','-1','1.5','1e1','0x10','99999999999999999999'])('rejects malformed or missing explicit native budget %s',value=>{
    expect(()=>nativeMetadataEnabled('native',value,'112',true)).toThrow(/OB1_VERSION_REMAINING.*before fixture allocation/);
    expect(()=>nativeMetadataEnabled('native','16',value,true)).toThrow(/OB1_SUPPORT_REMAINING.*before fixture allocation/);
  });
  it.each([['0','112'],['1','112'],['17','112'],['16','0'],['16','9'],['16','113']])('rejects insufficient or over-cap native budgets %s/%s',(versions,support)=>{
    expect(()=>nativeMetadataEnabled('native',versions,support,true)).toThrow(/before fixture allocation/);
  });
  it('admits exact minimum and maximum budgets only on the qualified explicit native lane',()=>{
    expect(nativeMetadataEnabled('native','2','10',true)).toBe(true);
    expect(nativeMetadataEnabled('native','16','112',true)).toBe(true);
    expect(()=>nativeMetadataEnabled('native','16','112',false)).toThrow('O-B1 requires qualified native runtime.');
    expect(()=>nativeMetadataEnabled('unknown','16','112',true)).toThrow('Unknown O-B1 test lane.');
  });
});
