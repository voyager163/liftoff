import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat,chmod,unlink,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {afterEach,afterAll,beforeEach,describe,expect,it,vi} from 'vitest';
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
import {frameworkOutputPaths} from '../src/framework-validation.js';
import {specKitBootstrapPath,specKitBootstrapTaskIds} from '../src/domain/governance/activation/local-check-values.js';
import {prepareModernLocalExecution,approveModernLocalExecution,readCompletedModernLocalExecution} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {inspectModernLocalRuntime,planModernLocalRuntime} from '../src/application/governance/modern-local-inputs.js';
import {prepareModernLocalFinalization,approveModernLocalFinalization,finalizeModernLocalCompletion,loadFinalizationResult} from '../src/application/governance/modern-local-finalization.js';
import {approveModernLocalPublication,publishModernLocalCompletion,inspectModernLocalCompletion,recoverModernLocalCompletion} from '../src/application/governance/modern-local-publication.js';
import {completedSpecKitTasks} from '../src/governance-activation/spec-kit-seed.js';
import {completionDigest,validateFinalizationPreview,validateSpecKitFinalizationScopes} from '../src/domain/governance/activation/modern-local-completion.js';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import * as storage from '../src/adapters/filesystem/update-previews.js';
import {projectMutationLockPath} from '../src/adapters/filesystem/project-lock.js';
import {createModernActivationRecordContract} from '../src/domain/governance/activation/modern-records.js';
import {randomUUID} from 'node:crypto';
import {NodeCommandRunner} from '../src/process-runner.js';

const lane=process.env.LIFTOFF_HCL_TEST_LANE??'auto',qualified=process.platform==='darwin'&&process.arch==='arm64'&&process.versions.node==='24.21.0';
if(!['native','portable','auto'].includes(lane)||lane==='native'&&!qualified)throw new Error('Invalid Spec Kit qualification host/lane.');
const nativeIt=it.skipIf(lane==='portable'||!qualified),executed:string[]=[];
beforeEach(({task})=>executed.push(task.name));
afterAll(()=>console.info('MR2_SPEC_KIT_TEST_INVENTORY '+JSON.stringify({lane,qualified,executed,markers:'owned preinitialized contract fixtures; no official initializer provenance',externalInitializer:false})));
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const executionScopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:false,dependencyNetwork:false,workflowFinalization:false as const,publishLocalRecords:false as const};
const scopes={finalizeLocal:true as const,workflowWrites:true as const,projectCode:false as const,dependencyPreparation:false as const,dependencyNetwork:false as const,publishLocalRecords:false as const};
type Profile='none'|'single-maintainer-gitflow'|'team-gitflow';
const taskPath=[...specKitBootstrapPath,'tasks.md'];
async function fixture(profile:Profile='none',newline='\r\n',checked=false,pending=false){
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'sk-completion-')));roots.push(directory);
  const root=path.join(directory,'Project Space');await mkdir(root);
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:{name:'Spec Kit Completion Fixture',workload:{
    kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:true,environments:['dev']},
    specWorkflow:'spec-kit',agents:['github-copilot'],defaultAgent:'github-copilot'},
    framework:{state:'initialized',adapter:'spec-kit',contractVersion:projectCatalog.getFrameworkDefinition('spec-kit').version}});
  const selection={...leaf,profile},resolution=composeModernManifestPlugins({workload:'standard',stack:'node-fastify',cloud:'azure',workflow:'spec-kit',
    agents:['github-copilot'],frontend:'included',environments:['dev'],governanceProfile:profile},{safeProjectName:'spec-kit-completion-fixture'}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},{stack:'node-fastify',cloud:'azure',workflow:'spec-kit',agents:['github-copilot']});
  const source=resolveModernManifestV8SourceContract({selection,recordedPlugins:plugins});
  const activeLayout={schemaVersion:1,state:'bound',bindings:[...source.layoutDescriptor.components.map(component=>({kind:'component',component,pathParts:['Source Space',component.replace(':',' ')]})),
    {kind:'artifact',logicalName:'docker-compose',pathParts:['compose.yml']}]};
  const contracts={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract},input={selection,plugins,activeLayout},core=buildModernManagedCore(input);
  const context=profile==='none'?undefined:createModernGovernanceContextContract(contracts).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(contracts).parseManifestV8({artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,
    project:leaf.project,framework:leaf.framework,plugins,activeLayout,
    governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(file=>({logicalName:file.logicalName,category:file.category,pathParts:file.pathParts,contentHash:`sha256:${rawLocalDigest(file.content)}`})),projectArtifacts:[],adoptionObservations:[]});
  async function put(parts:readonly string[],content:string|Buffer){const target=path.join(root,...parts);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content);}
  await put(['liftoff.manifest.json'],JSON.stringify(manifest,null,2)+'\n');for(const file of core)await put(file.pathParts,file.content);
  for(const component of source.layoutDescriptor.components){
    const parts=['Source Space',component.replace(':',' ')];
    if(component==='backend'){
      await put([...parts,'package.json'],'{"name":"sk-backend","version":"1.0.0","scripts":{"test":"node --test"}}\n');
      await put([...parts,'tests','input.test.cjs'],'require("node:test")("actual check",()=>require("node:assert/strict").equal(2+2,4));\n');
    }else if(component==='frontend'){
      await put([...parts,'package.json'],'{"name":"sk-frontend","version":"1.0.0","scripts":{"build":"node build.cjs"}}\n');
      await put([...parts,'build.cjs'],'require("node:fs").mkdirSync("dist");require("node:fs").writeFileSync("dist/index.html","owned output");\n');
    }else if(component.startsWith('opentofu-'))await put([...parts,'main.tf'],'locals {\n  enabled = true\n}\n');
    else await put([...parts,'source.txt'],'actual selected source\n');
  }
  await put(['compose.yml'],'services:\n  app:\n    image: example/local:source\n');
  const markers=frameworkOutputPaths({workflow:'spec-kit',agents:['github-copilot'],defaultAgent:'github-copilot'});
  for(const parts of markers)await put(parts,`# Preinitialized contract fixture\n\nPath: ${parts.join('/')}\nNot official CLI output; no initializer has run.\n`);
  await put(['.specify','init-options.json'],'{"fixture":"preinitialized-contract","officialInitializerRun":false}\n');
  await put(['.specify','integration.json'],JSON.stringify({default_integration:'copilot',installed_integrations:['copilot']})+'\n');
  const identity='Bootstrap identity: `000-liftoff-bootstrap`';
  await put([...specKitBootstrapPath,'spec.md'],[identity,'## Requirements','Review the actual project inputs, explicit dependency needs and every local check.',''].join(newline));
  await put([...specKitBootstrapPath,'plan.md'],[identity,'## Verification','Read specs/000-liftoff-bootstrap/spec.md and the actual source layout.','Execute the complete approved local checks without external services.',''].join(newline));
  const meanings=['Review spec, plan, selected inputs and official-marker contract.',
    'Establish actual dependency preparation or its absence with separate consent.',
    'Run source validation and actual backend/worker checks.',
    'Build the selected frontend or establish inapplicability.',
    'Validate Compose and every independent Tofu root without providers.',
    'After all checks, explicitly finalize local tasks and receipt without archive.'];
  const tasks=[identity,'# Bootstrap tasks','',...specKitBootstrapTaskIds.map((id,i)=>`  - [${checked?'x':i===1?'X':i===2?'x':' '}] ${id} ${meanings[i]}`),
    '', '- [ ] NOT-B Leave this unrelated checkbox unchanged.','Preserve prose and trailing space.  ',''].join(newline);
  await put(taskPath,tasks);await chmod(path.join(root,...taskPath),0o640);
  let originalState;
  if(pending){
    if(!context||profile==='none')throw new Error('Existing pending fixture requires governed profile.');
    const api=createModernActivationRecordContract(projectCatalog,{recordedIdentity:context.governance.activationIdentity,profile,policyVersion:context.governance.policyVersion,
      selection:{...leaf,profile},pluginResolutionDigest:plugins.resolutionDigest,activeLayoutDigest:context.governance.activationIdentity.activeLayoutDigest});
    originalState=api.createInitialState({repository:{id:`local:${randomUUID()}`,name:leaf.project.name,defaultBranch:'undiscovered'},
      applicability:{statePath:'none',privateStagingDast:'unknown',credentialRequired:'unknown'},createdAt:new Date().toISOString()});
    await put(['governance','activation-state.json'],Buffer.from(api.encodeRecord({kind:'state',record:originalState}).content));
  }
  return {root,directory,manifest,put,markers,tasks,originalState};
}
async function runB(profile:Profile='none',newline='\r\n',checked=false,pending=false){
  const f=await fixture(profile,newline,checked,pending),preview=await prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]});
  expect(preview.checks.find(c=>c.id==='framework-source')).toMatchObject({status:'planned',command:null,reasons:['spec-kit-bootstrap-observed-not-finalized']});
  expect(preview.tools.some(t=>t.id==='specify'||t.id==='openspec')).toBe(false);
  expect(preview.checks.some(c=>c.id==='frontend-build')).toBe(true);
  expect(preview.checks.some(c=>c.id.startsWith('tofu-validate:'))).toBe(true);
  await approveModernLocalExecution(f.root,preview.fingerprint,executionScopes);
  const result=await executeModernLocalExecution(f.root,preview.fingerprint);
  expect(result.complete).toBe(true);expect(result.cleanupComplete).toBe(true);
  expect(result.checks.map(c=>c.id)).toEqual(preview.checks.map(c=>c.id));
  expect(result.checks.find(c=>c.id==='framework-source')).toMatchObject({status:'passed',processTreeSettled:true,toolDigest:null});
  return {...f,preview,result};
}
describe('actual Spec Kit completion prerequisites',()=>{
  nativeIt.each(['none','single-maintainer-gitflow','team-gitflow'] as const)('unchanged B prerequisite executes full actual Spec Kit %s checks',async profile=>{
    const f=await runB(profile);
    expect((await readCompletedModernLocalExecution(f.root,f.preview.fingerprint)).result).toEqual(f.result);
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(f.tasks);
    await expect(lstat(path.join(f.root,'.liftoff','local-completion.json'))).rejects.toMatchObject({code:'ENOENT'});
    console.info('MR2_SPEC_KIT_B_PREREQUISITE '+JSON.stringify({profile,markers:f.markers,fixtureProvenance:'preinitialized-contract-not-official-CLI',preview:f.preview,result:f.result}));
  },120000);
});
async function reviewed(profile:Profile='none',newline='\r\n',checked=false,pending=false){
  const f=await runB(profile,newline,checked,pending),p=await prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:f.preview.fingerprint});
  expect(p.schemaVersion).toBe(2);
  await approveModernLocalFinalization(f.root,p.fingerprint,scopes);
  const result=await finalizeModernLocalCompletion(f.root,p.fingerprint);
  return {...f,finalPreview:p,finalization:result};
}
async function approve(f:Awaited<ReturnType<typeof reviewed>>){
  return approveModernLocalPublication(f.root,f.finalization.publicationFingerprint,{publishExactLocalBytes:true,finalizationFingerprint:f.finalPreview.fingerprint,
    candidateBinding:f.finalization.candidateBinding,targetSetDigest:f.finalization.targetSetDigest});
}
describe('actual Spec Kit bootstrap completion',()=>{
  nativeIt.each(['none','single-maintainer-gitflow','team-gitflow'] as const)('finalizes and reads back actual %s Spec Kit CRLF task bytes',async profile=>{
    const f=await reviewed(profile),before=Buffer.from(f.tasks),manifest=await readFile(path.join(f.root,'liftoff.manifest.json'));
    expect(await readFile(path.join(f.root,...taskPath))).toEqual(before);
    const loaded=await loadFinalizationResult(f.root,f.finalization.fingerprint);
    expect(loaded.result.schemaVersion).toBe(2);
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/second publication consent/);
    await approve(f);
    const outcome=await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint);
    expect(outcome.status).toBe('local-complete-current');
    expect(await readFile(path.join(f.root,...taskPath))).toEqual(Buffer.from(completedSpecKitTasks(f.tasks)));
    expect((await lstat(path.join(f.root,...taskPath))).mode&0o7777).toBe(0o640);
    expect(await readFile(path.join(f.root,'liftoff.manifest.json'))).toEqual(manifest);
    expect((await inspectModernLocalCompletion(f.root)).status).toBe('local-complete-current');
    expect((await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint})).status).toBe('local-complete-current');
    if(profile==='none')await expect(lstat(path.join(f.root,'governance/activation-state.json'))).rejects.toMatchObject({code:'ENOENT'});
    else{
      const state=JSON.parse(await readFile(path.join(f.root,'governance/activation-state.json'),'utf8'));
      expect(state.activeChange).toBeNull();expect(state.taskProjection).toBeUndefined();expect(state.phases['local-complete'].state).toBe('verified');
      const proofPath=f.finalization.targets.find(t=>t.purpose==='completion-evidence')!.pathParts;
      const proof=JSON.parse(await readFile(path.join(f.root,...proofPath),'utf8'));
      expect(proof.payload).toMatchObject({workflow:'spec-kit',frameworkValidation:'verified',frameworkFinalization:'finalized'});
      expect(proof.header.inputBindings.files).toEqual([{pathParts:taskPath,beforeHash:rawLocalDigest(before),afterHash:rawLocalDigest(Buffer.from(completedSpecKitTasks(f.tasks)))}]);
    }
    console.info('MR2_SPEC_KIT_ACTUAL_COMPLETION '+JSON.stringify({profile,outcome,workflow:f.finalization.schemaVersion===2?f.finalization.workflowOutcome:null}));
  },120000);
  nativeIt('preserves physical identity of already-finalized LF tasks without a write',async()=>{
    const f=await reviewed('single-maintainer-gitflow','\n',true),before=await lstat(path.join(f.root,...taskPath),{bigint:true});
    expect(f.finalization.targets.some(t=>t.purpose==='spec-kit-bootstrap-tasks')).toBe(false);
    await approve(f);expect((await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).status).toBe('local-complete-current');
    const after=await lstat(path.join(f.root,...taskPath),{bigint:true});
    expect([after.dev,after.ino,after.mode,after.size,after.mtimeNs,after.ctimeNs]).toEqual([before.dev,before.ino,before.mode,before.size,before.mtimeNs,before.ctimeNs]);
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(f.tasks);
    const evidencePath=f.finalization.targets.find(t=>t.purpose==='completion-evidence')!.pathParts,proof=JSON.parse(await readFile(path.join(f.root,...evidencePath),'utf8'));
    expect(proof.header.inputBindings.beforeDigest).toBe(proof.header.inputBindings.afterDigest);
    const planPath=f.finalization.targets.find(t=>t.purpose==='completion-plan')!.pathParts,plan=JSON.parse(await readFile(path.join(f.root,...planPath),'utf8'));
    expect(plan.operations.some((op:{mutationClass:string})=>op.mutationClass==='write-spec-kit-seed')).toBe(false);
  },120000);
  nativeIt('retains an existing pending state and the original full B selected plan and stateHash',async()=>{
    const f=await reviewed('single-maintainer-gitflow','\n',false,true);
    expect(f.preview.selectedPlan?.stateHash).toBe(completionDigest(f.originalState));
    await approve(f);expect((await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).status).toBe('local-complete-current');
    const state=JSON.parse(await readFile(path.join(f.root,'governance/activation-state.json'),'utf8'));
    expect(state.repository).toEqual(f.originalState!.repository);expect(state.applicability).toEqual(f.originalState!.applicability);expect(state.createdAt).toBe(f.originalState!.createdAt);
    const p=f.finalization.targets.find(t=>t.purpose==='baseline-plan')!.pathParts;
    expect(JSON.parse(await readFile(path.join(f.root,...p),'utf8'))).toEqual(f.preview.selectedPlan);
  },120000);
  nativeIt.each(['missing-task','duplicate-task','bad-identity','bad-plan','missing-marker','empty-marker','linked-marker','bad-default','missing-integration'] as const)(
    'rejects actual incomplete Spec Kit prerequisite %s without framework inapplicability',async fault=>{
      const f=await fixture(),marker=f.markers.find(p=>p.at(-1)==='SKILL.md')!;
      if(fault==='missing-task')await unlink(path.join(f.root,...taskPath));
      if(fault==='duplicate-task')await f.put(taskPath,f.tasks+'- [ ] B001 duplicate\n');
      if(fault==='bad-identity')await f.put([...specKitBootstrapPath,'spec.md'],'## Requirements\nNo bootstrap identity\n');
      if(fault==='bad-plan')await f.put([...specKitBootstrapPath,'plan.md'],'Bootstrap identity: `000-liftoff-bootstrap`\n## Verification\nWrong reference\n');
      if(fault==='missing-marker')await unlink(path.join(f.root,...marker));
      if(fault==='empty-marker')await f.put(marker,'');
      if(fault==='linked-marker'){await unlink(path.join(f.root,...marker));await symlink(path.join(f.root,...taskPath),path.join(f.root,...marker));}
      if(fault==='bad-default')await f.put(['.specify','integration.json'],'{"default_integration":"claude","installed_integrations":["copilot"]}');
      if(fault==='missing-integration')await f.put(['.specify','integration.json'],'{"default_integration":"copilot","installed_integrations":[]}');
      const plan=await planModernLocalRuntime(await inspectModernLocalRuntime(f.root));
      expect(plan.status).toBe('blocked');
      expect(plan.localPlan?.checks.find(c=>c.id==='framework-source')?.status).not.toBe('inapplicable');
      await expect(prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]})).rejects.toThrow(/unblocked/);
    },60000);
  nativeIt('requires workflow-specific first consent and rejects stale original task bytes',async()=>{
    const f=await runB(),p=await prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:f.preview.fingerprint});
    await expect(approveModernLocalFinalization(f.root,p.fingerprint,{...scopes,workflowWrites:false})).rejects.toThrow(/affirmative/);
    if(p.schemaVersion!==2)throw new Error('Expected actual Spec Kit preview.');
    const {fingerprint:_old,...body}=p,wrong={...body,protocol:'manual-native-v1'};
    expect(()=>Reflect.apply(validateFinalizationPreview,undefined,[{...wrong,fingerprint:completionDigest(wrong)},new Date()])).toThrow(/identity/);
    await approveModernLocalFinalization(f.root,p.fingerprint,scopes);
    await f.put(taskPath,f.tasks+'changed original prose\n');
    await expect(finalizeModernLocalCompletion(f.root,p.fingerprint)).rejects.toThrow();
    await expect(lstat(path.join(f.root,'.liftoff/local-completion.json'))).rejects.toMatchObject({code:'ENOENT'});
  },60000);
  nativeIt('refuses missing original task artifact and wrong exact-byte publication approval',async()=>{
    const f=await reviewed();
    await expect(approveModernLocalPublication(f.root,f.finalization.publicationFingerprint,{publishExactLocalBytes:true,finalizationFingerprint:f.finalPreview.fingerprint,
      candidateBinding:'a'.repeat(64),targetSetDigest:f.finalization.targetSetDigest})).rejects.toThrow(/exact bytes/);
    if(f.finalization.schemaVersion!==2)throw new Error('Expected Spec Kit result.');
    const originalKey=f.finalization.workflowOutcome.originalTaskArtifactKey;
    const original=storage.createLocalFinalizationRecordStore;
    vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
      const store=original(root,options);return {...store,read:async(kind,key)=>kind==='artifact'&&key===originalKey?null:store.read(kind,key)};
    });
    await expect(approve(f)).rejects.toThrow(/artifact is missing/);
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(f.tasks);
  },120000);
  nativeIt('rejects actual baseline failure without projecting successful tasks',async()=>{
    const f=await fixture();await f.put(['Source Space','backend','tests','input.test.cjs'],'process.exit(4);\n');
    const p=await prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]});await approveModernLocalExecution(f.root,p.fingerprint,executionScopes);
    const result=await executeModernLocalExecution(f.root,p.fingerprint);expect(result.complete).toBe(false);
    await expect(prepareModernLocalFinalization(f.root,{kind:'finalize-local',executionFingerprint:p.fingerprint})).rejects.toThrow(/Historical/);
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(f.tasks);
  },60000);
  nativeIt('rolls task bytes and mode back after actual precommit failure without rewriting unrelated source',async()=>{
    const f=await reviewed();await approve(f);const original=transactions.applyLocalVerificationTransaction;
    vi.spyOn(transactions,'applyLocalVerificationTransaction').mockImplementation((root,mutations,options)=>original(root,mutations,{...options,onCheckpoint:async point=>{
      await options.onCheckpoint?.(point);
      if(point.phase==='before-commit'){
        expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(completedSpecKitTasks(f.tasks));
        throw new Error('Explicit test failure after actual task write before commit.');
      }
    }}));
    await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/after actual task write/);
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(f.tasks);expect((await lstat(path.join(f.root,...taskPath))).mode&0o7777).toBe(0o640);
    await expect(lstat(path.join(f.root,'.liftoff/local-completion.json'))).rejects.toMatchObject({code:'ENOENT'});
  },120000);
  nativeIt.each(['commit-state','cleanup-observation'] as const)('preserves Spec Kit commitment across denied %s persistence',async cut=>{
    const f=await reviewed();await approve(f);const original=storage.createLocalFinalizationRecordStore;let deny=true;
    vi.spyOn(storage,'createLocalFinalizationRecordStore').mockImplementation((root,options)=>{
      const store=original(root,options);return {...store,compareExchangeState:async(key,digest,value)=>{
        if(deny&&value&&typeof value==='object'&&'phase'in value&&value.phase==='committed-readback-pending'&&
          (cut==='commit-state'||'blockerCodes'in value&&Array.isArray(value.blockerCodes)&&value.blockerCodes.length===0))throw new Error('Explicit denied Spec Kit persistence.');
        return store.compareExchangeState(key,digest,value);
      }};
    });
    if(cut==='commit-state')expect((await publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).status).toBe('committed-cleanup-pending');
    else await expect(publishModernLocalCompletion(f.root,f.finalization.publicationFingerprint)).rejects.toThrow(/denied Spec Kit/);
    deny=false;const run=vi.spyOn(NodeCommandRunner.prototype,'run');
    const recovered=await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint});
    expect(recovered.status).toBe(cut==='commit-state'?'local-complete-current':'committed-cleanup-pending');expect(run).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(completedSpecKitTasks(f.tasks));
  },120000);
  nativeIt.each(['after-task','sealed-before-append'] as const)('recovers actual Spec Kit child exit at %s without repeating finalization',async cut=>{
    const f=await reviewed();await approve(f);const repository=process.cwd(),loader=path.join(f.directory,'loader.mjs'),child=path.join(f.directory,'child.mjs');
    await writeFile(loader,`
      import {registerHooks,stripTypeScriptTypes} from 'node:module';import {readFileSync,existsSync} from 'node:fs';import {fileURLToPath,pathToFileURL} from 'node:url';
      const root=${JSON.stringify(repository)};
      registerHooks({resolve(specifier,context,next){
        if(context.parentURL?.startsWith(pathToFileURL(root+'/').href)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
          const file=fileURLToPath(new URL(specifier.slice(0,-3)+'.ts',context.parentURL));if(existsSync(file))return next(pathToFileURL(file).href,context);
        }return next(specifier,context);
      },load(url,context,next){
        if(url.startsWith(pathToFileURL(root+'/').href)&&url.endsWith('.ts')){
          let source=readFileSync(new URL(url),'utf8');
          if(url.endsWith('/reviewed-update-transaction.ts')){
            const marker=${JSON.stringify(cut==='after-task'?"await options.onCheckpoint?.({ phase: 'after-mutation', index });":"committed = true;\n      loaded.committed = true;")};
            if(source.split(marker).length!==2)throw new Error('Exact Spec Kit test cut unavailable.');
            source=source.replace(marker,marker+${JSON.stringify(cut==='after-task'?"if(mutation.pathParts.join('/')==='specs/000-liftoff-bootstrap/tasks.md')process.exit(73);":"process.exit(73);")});
          }return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(source,{mode:'transform',sourceUrl:url})};
        }return next(url,context);
      }});
    `);
    await writeFile(child,`import {publishModernLocalCompletion} from ${JSON.stringify(new URL('../src/application/governance/modern-local-publication.ts',import.meta.url).href)};
      await publishModernLocalCompletion(${JSON.stringify(f.root)},${JSON.stringify(f.finalization.publicationFingerprint)});process.exit(74);`);
    const result=spawnSync(process.execPath,['--import',loader,child],{cwd:f.directory,env:process.env,encoding:'utf8',timeout:30000,maxBuffer:65536,killSignal:'SIGKILL'});
    expect(result.status,result.stderr).toBe(73);expect(result.error).toBeUndefined();expect(()=>process.kill(result.pid,0)).toThrow();
    const lock=await projectMutationLockPath(f.root),identity=await lstat(lock),bytes=await readFile(lock),latest=await lstat(lock);
    expect(latest.ino).toBe(identity.ino);expect(latest.dev).toBe(identity.dev);expect(await readFile(lock)).toEqual(bytes);
    console.info('MR2_SPEC_KIT_ACTUAL_EXIT '+JSON.stringify({cut,pid:result.pid,status:result.status,pidAbsent:true,lock,ino:identity.ino,digest:rawLocalDigest(bytes),testOnlyKnownOwnerCleanup:true}));
    await unlink(lock);
    const run=vi.spyOn(NodeCommandRunner.prototype,'run'),recovered=await recoverModernLocalCompletion(f.root,{publicationFingerprint:f.finalization.publicationFingerprint});
    expect(run).not.toHaveBeenCalled();expect(recovered.status).toBe(cut==='after-task'?'rolled-back':'local-complete-current');
    expect(await readFile(path.join(f.root,...taskPath),'utf8')).toBe(cut==='after-task'?f.tasks:completedSpecKitTasks(f.tasks));
    expect((await lstat(path.join(f.root,...taskPath))).mode&0o7777).toBe(0o640);
  },120000);
  it('requires exact limited workflow consent',()=>{
    expect(()=>validateSpecKitFinalizationScopes({...scopes,workflowWrites:false})).toThrow(/affirmative/);
    expect(()=>Reflect.apply(validateSpecKitFinalizationScopes,undefined,[{...scopes,projectCode:true}])).toThrow();
  });
  it('keeps helper transformation byte-local with CRLF, LF and mixed newline input',()=>{
    for(const nl of ['\n','\r\n']){
      const input=specKitBootstrapTaskIds.map((id,i)=>`  - [${i%2?'X':' '}] ${id} keep prose ${i}${nl}`).join('')+'\n- [ ] Non-B unaffected.\r\n';
      const output=completedSpecKitTasks(input);
      expect(output.replaceAll('[x]','[ ]')).toBe(input.replaceAll('[X]','[ ]'));
      expect(output).toContain('- [ ] Non-B unaffected.\r\n');
      expect(Buffer.byteLength(output)).toBe(Buffer.byteLength(input));
    }
  });
});
