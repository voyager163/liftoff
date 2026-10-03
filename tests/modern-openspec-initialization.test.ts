import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {buildProjectPlan} from '../src/application/project/planning.js';
import {buildOpenSpecInitCommand} from '../src/framework-adapters.js';
import {renderOpenSpecConfig,renderSeedTasks,renderSeedSpec,renderSeedDesign,renderSeedProposal} from '../src/generators/common/spec-workflow.js';
import {OPEN_SPEC_PROFILE,OPEN_SPEC_DELIVERY,OPEN_SPEC_WORKFLOW_IDS} from '../src/openspec-profile.js';
import {frameworkOutputPaths,validateFrameworkInitialization} from '../src/framework-validation.js';
import {createApplicationEnvironment} from '../src/application/repair/application-environment.js';
import {observeModernLocalTools,assertModernLocalToolsCurrent} from '../src/adapters/process/modern-local-tools.js';
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
import {rawLocalDigest,type ModernLocalCheck} from '../src/domain/governance/activation/modern-local-inputs.js';
import {canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {prepareModernOpenSpecInitializedBaseline,approveModernOpenSpecInitializedBaseline,approveModernLocalExecution,readCompletedModernLocalExecution} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {createLocalExecutionRecordStore} from '../src/adapters/filesystem/update-previews.js';
import {createModernLocalWorkspace} from '../src/adapters/filesystem/modern-local-workspaces.js';
import {openSpecMetadataEnvironment,validateLocalExecutionConsentRecord,validateLocalExecutionResult,validateLocalExecutionPreview} from '../src/domain/governance/activation/modern-local-runtime.js';
const native=process.env.LIFTOFF_OI_TESTS==='1'&&process.env.LIFTOFF_HCL_TEST_LANE!=='portable';
if(native&&(process.platform!=='darwin'||process.arch!=='arm64'||process.versions.node!=='24.21.0'))throw new Error('O-I native tests require qualified runtime.');
const nativeIt=it.skipIf(!native),roots:{path:string;ino:number;dev:number}[]=[];
const consent={scopes:{projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:true,dependencyNetwork:false,workflowFinalization:false as const,publishLocalRecords:false as const},
  bootstrapScopeAttestation:{generatedBaselineReviewed:true as const,domainBehaviorDeferred:true as const}};
afterEach(async()=>{vi.restoreAllMocks();for(const r of roots.splice(0).reverse()){const s=await lstat(r.path);expect(s.ino).toBe(r.ino);expect(s.dev).toBe(r.dev);expect(s.isSymbolicLink()).toBe(false);await rm(r.path,{recursive:true});}});
async function tree(root:string){
  const entries:{path:string[];kind:'file'|'directory';mode:string;hash?:string;ino?:string}[]=[];
  async function walk(parts:string[]){
    for(const name of (await readdir(path.join(root,...parts))).sort()){
      const p=[...parts,name],s=await lstat(path.join(root,...p),{bigint:true});
      if(s.isDirectory()){entries.push({path:p,kind:'directory',mode:String(s.mode)});await walk(p);}
      else{expect(s.isSymbolicLink()).toBe(false);entries.push({path:p,kind:'file',mode:String(s.mode),hash:rawLocalDigest(await readFile(path.join(root,...p))),ino:String(s.ino)});}
    }
  }
  await walk([]);return entries;
}
async function fixture(profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none',official=false){
  const outer=await realpath(await mkdtemp(path.join(os.tmpdir(),'oi-owned-'))),st=await lstat(outer);roots.push({path:outer,ino:st.ino,dev:st.dev});
  console.info('OI_OWNED_ROOT '+JSON.stringify({root:outer,ino:st.ino,dev:st.dev}));
  const root=path.join(outer,'project');await mkdir(root);
  const plan=buildProjectPlan({projectName:'Owned Initialized Baseline',projectType:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',
    includeFrontend:true,environments:['dev'],specWorkflow:'openspec',agents:['github-copilot'],copilotCloud:false,governanceProfile:'none'},{requireProjectName:true});
  async function put(parts:readonly string[],content:string){const p=path.join(root,...parts);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,content);}
  if(official){
    const check:ModernLocalCheck={id:'initializer-tool-identity',status:'planned',inputPaths:[],reasons:[],command:{executable:'openspec',args:['--version']},cwdPathParts:[],env:{},prerequisites:[],effects:[]};
    const tools=await observeModernLocalTools(root,[check],[]),tool=tools.find(t=>t.id==='openspec')!;
    const workspace=path.join(outer,'initializer-environment');await mkdir(workspace);
    const env={...await createApplicationEnvironment(process.env,root,root,workspace),...openSpecMetadataEnvironment};
    await mkdir(path.join(workspace,'home','openspec'));await writeFile(path.join(workspace,'home','openspec','config.json'),
      JSON.stringify({profile:OPEN_SPEC_PROFILE,delivery:OPEN_SPEC_DELIVERY,workflows:OPEN_SPEC_WORKFLOW_IDS})+'\n');
    const literal=buildOpenSpecInitCommand(plan),command={executable:tool.executablePath,args:[...tool.prefixArgs,...literal.args]},before=await tree(root);
    expect(command.args).toContain('--no-copilot-cloud');
    await assertModernLocalToolsCurrent(root,workspace,tools);
    const result=await new NodeCommandRunner().run(command,{cwd:root,env:{...Object.fromEntries(Object.keys(process.env).map(k=>[k,undefined])),...env},
      timeoutMs:120000,maxOutputBytes:65536,ensureProcessTreeSettled:true,stream:false});
    if(result.processTreeSettled!==true){
      roots.splice(roots.findIndex(r=>r.path===outer),1);
      console.info('OI_UNSETTLED '+JSON.stringify({outer,command,result,cleanup:'retained-no-known-settlement'}));
      throw new Error('Official initializer settlement is unknown; original owned root retained.');
    }
    const after=await tree(root),config=await readFile(path.join(root,'openspec','config.yaml'),'utf8');
    console.info('OI_OFFICIAL_INITIALIZER '+JSON.stringify({command,result,before,after,config,tools,environment:env,provenance:'actual-executed-in-owned-staging-no-historical-user-provenance'}));
    expect(result.status).toBe(0);expect(result.processTreeSettled).toBe(true);await assertModernLocalToolsCurrent(root,workspace,tools);
    expect(after.filter(e=>e.kind==='file').map(e=>e.path.join('/')).sort()).toEqual(frameworkOutputPaths({workflow:'openspec',agents:['github-copilot']}).map(p=>p.join('/')).sort());
    expect(await readFile(path.join(workspace,'home','openspec','config.json'),'utf8')).toBe(JSON.stringify({profile:OPEN_SPEC_PROFILE,delivery:OPEN_SPEC_DELIVERY,workflows:OPEN_SPEC_WORKFLOW_IDS})+'\n');
    expect(await validateFrameworkInitialization(root,{workflow:'openspec',agents:['github-copilot']},false)).toEqual([]);
  }else for(const parts of frameworkOutputPaths({workflow:'openspec',agents:['github-copilot']}))await put(parts,'Owned contract fixture, not official initializer output.\n');
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:{name:plan.projectName,workload:{kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:true,environments:['dev']},
    specWorkflow:'openspec',agents:['github-copilot']},framework:{state:'initialized',adapter:'openspec',contractVersion:projectCatalog.getFrameworkDefinition('openspec').version}});
  const selection={...leaf,profile},resolution=composeModernManifestPlugins({workload:'standard',stack:'node-fastify',cloud:'azure',workflow:'openspec',agents:['github-copilot'],frontend:'included',
    environments:['dev'],governanceProfile:profile},{safeProjectName:plan.safeProjectName}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},{stack:'node-fastify',cloud:'azure',workflow:'openspec',agents:['github-copilot']});
  const source=resolveModernManifestV8SourceContract({selection,recordedPlugins:plugins}),activeLayout={schemaVersion:1,state:'bound',
    bindings:[...source.layoutDescriptor.components.map(component=>({kind:'component',component,pathParts:['Source Space',component.replace(':',' ')]})),{kind:'artifact',logicalName:'docker-compose',pathParts:['compose.yml']}]};
  const ctx={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract},input={selection,plugins,activeLayout},core=buildModernManagedCore(input),
    context=profile==='none'?undefined:createModernGovernanceContextContract(ctx).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(ctx).parseManifestV8({artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,
    project:leaf.project,framework:leaf.framework,plugins,activeLayout,governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(f=>({logicalName:f.logicalName,category:f.category,pathParts:f.pathParts,contentHash:`sha256:${rawLocalDigest(f.content)}`})),projectArtifacts:[],adoptionObservations:[]});
  await put(['liftoff.manifest.json'],JSON.stringify(manifest)+'\n');for(const f of core)await put(f.pathParts,f.content);
  for(const component of source.layoutDescriptor.components){
    const parts=['Source Space',component.replace(':',' ')];
    if(component==='backend'){await put([...parts,'package.json'],'{"name":"oi-backend","version":"1.0.0","scripts":{"test":"node --test"}}');
      await put([...parts,'tests','input.test.cjs'],'require("node:test")("owned",()=>require("node:assert/strict").equal(2+2,4));');}
    else if(component==='frontend'){await put([...parts,'package.json'],'{"name":"oi-frontend","version":"1.0.0","scripts":{"build":"node build.cjs"}}');
      await put([...parts,'build.cjs'],'require("node:fs").mkdirSync("dist");require("node:fs").writeFileSync("dist/index.html","owned");');}
    else if(component.startsWith('opentofu-'))await put([...parts,'main.tf'],'locals {\n  enabled = true\n}\n');
    else await put([...parts,'source.txt'],'Provider-free contract workload, not generated Azure completion.\n');
  }
  await put(['compose.yml'],'services:\n  app:\n    image: example/local:source\n');
  const change=['openspec','changes',`bootstrap-${plan.safeProjectName}`];await mkdir(path.join(root,'openspec','changes','archive'),{recursive:true});
  await mkdir(path.join(root,'openspec','specs'),{recursive:true});
  await put(['openspec','config.yaml'],renderOpenSpecConfig(plan));
  await put([...change,'.openspec.yaml'],'schema: spec-driven\n');
  await put([...change,'proposal.md'],renderSeedProposal(plan));await put([...change,'design.md'],renderSeedDesign(plan));
  await put([...change,'tasks.md'],renderSeedTasks(plan).replace(/\n/g,'\r\n'));await put([...change,'specs','node-fastify-application-baseline','spec.md'],renderSeedSpec(plan));
  return {root,put,change,plan};
}
describe('initialized source portable rejection',()=>{
  it.each(['config','missing-task','duplicate-task','unknown-task','completed-archive','module','provider','resource'] as const)('blocks %s without native tool lookup',async fault=>{
    const f=await fixture(),tasks=[...f.change,'tasks.md'];
    if(fault==='config')await f.put(['openspec','config.yaml'],'schema: spec-driven\ncontext: changed\nrules: {}\n');
    if(fault==='missing-task')await f.put(tasks,renderSeedTasks(f.plan).replace(/^- \[ \] 2\.7\.1.*\n/m,''));
    if(fault==='duplicate-task'||fault==='unknown-task')await f.put(tasks,renderSeedTasks(f.plan)+(fault==='duplicate-task'?'- [ ] 1.1 duplicate\n':'- [ ] 9.9 unknown\n'));
    if(fault==='completed-archive')await f.put(tasks,renderSeedTasks(f.plan).replace('- [ ] 3.1','- [x] 3.1'));
    if(fault==='module')await f.put(['Source Space','opentofu-application','main.tf'],'module "local" {\n source = "./child"\n}\n');
    if(fault==='provider')await f.put(['Source Space','opentofu-application','main.tf'],'provider "azurerm" {}\n');
    if(fault==='resource')await f.put(['Source Space','opentofu-application','main.tf'],'resource "random_id" "bad" {}\n');
    const run=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async()=>{throw new Error('Tool lookup forbidden for rejected input.');});
    await expect(prepareModernOpenSpecInitializedBaseline(f.root,{kind:'verify-openspec-initialized',preparation:[]})).rejects.toThrow();expect(run).not.toHaveBeenCalled();
  });
});
describe('actual initialized-baseline execution',()=>{
  nativeIt.each(['none','single-maintainer-gitflow','team-gitflow'] as const)('observes real init then validate for %s while preserving all original tasks',async profile=>{
    const f=await fixture(profile,profile==='none'),before=await tree(f.root),original=NodeCommandRunner.prototype.run,commands:unknown[]=[];
    vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      const effective=Object.fromEntries(Object.entries({...process.env,...options?.env}).filter(([,v])=>v!==undefined));
      console.info('OI_DISPATCH '+JSON.stringify({command,options:{cwd:options?.cwd,timeoutMs:options?.timeoutMs,maxOutputBytes:options?.maxOutputBytes},effective}));
      const result=await original.call(this,command,options);commands.push({command,result,effective});
      console.info('OI_RESULT '+JSON.stringify({command,result}));return result;
    });
    const preview=await prepareModernOpenSpecInitializedBaseline(f.root,{kind:'verify-openspec-initialized',preparation:[]});
    expect(preview.schemaVersion).toBe(4);if(preview.schemaVersion!==4)throw new Error('Missing initialization intent.');
    const store=createLocalExecutionRecordStore(f.root);
    await expect(createModernLocalWorkspace(f.root,preview,store)).rejects.toThrow(/consent/);
    await expect(approveModernLocalExecution(f.root,preview.fingerprint,consent.scopes)).rejects.toThrow(/attestation/);
    await expect(approveModernOpenSpecInitializedBaseline(f.root,preview.fingerprint,{...consent,scopes:{...consent.scopes,dependencyPreparation:false}})).rejects.toThrow(/preparation/);
    const approved=await approveModernOpenSpecInitializedBaseline(f.root,preview.fingerprint,consent);expect(approved.schemaVersion).toBe(3);
    const {fingerprint:_fp,...previewBody}=preview,wrong={...previewBody,initialization:{...preview.initialization,roots:preview.initialization.roots.map(r=>({...r,cwdPathParts:['different-root']}))}};
    expect(()=>validateLocalExecutionPreview({...wrong,fingerprint:canonicalSha256(wrong)},new Date())).toThrow(/distinct|matching/);
    expect(()=>validateLocalExecutionConsentRecord(f.root,preview,{...approved,expiresAt:new Date(0).toISOString()},new Date())).toThrow();
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    console.info('OI_COMPLETE '+JSON.stringify({profile,preview,approved,result,commands,fixtureProvenance:profile==='none'?'actual-official-init-owned-then-rendered-seed':'contract-markers-not-historical-official-init'}));
    expect(result.complete).toBe(true);expect(result.status).toBe('initialization-obligations-observed');expect(result.schemaVersion).toBe(3);
    if(result.schemaVersion!==3)throw new Error('Missing initialization proof.');
    expect(result.initialization.outputs).toHaveLength(2);
    expect(result.initialization.obligations.find(o=>o.id==='3.1')?.status).toBe('pending-finalization');
    expect(result.initialization.obligations.filter(o=>o.id!=='3.1').every(o=>['observed','inapplicable','attested'].includes(o.status))).toBe(true);
    expect((await readCompletedModernLocalExecution(f.root,preview.fingerprint)).result).toEqual(result);expect(await tree(f.root)).toEqual(before);
    const {resultDigest:_digest,...body}=result,bad={...body,initialization:{...body.initialization,outputs:[]}};
    expect(()=>validateLocalExecutionResult({...bad,resultDigest:canonicalSha256(bad)},preview,path.dirname(result.openSpec.projectRoot))).toThrow(/prior/);
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/already claimed/);
  },300000);
  nativeIt('blocks source changes before any initialization claim',async()=>{
    const f=await fixture(),preview=await prepareModernOpenSpecInitializedBaseline(f.root,{kind:'verify-openspec-initialized',preparation:[]});
    await approveModernOpenSpecInitializedBaseline(f.root,preview.fingerprint,consent);
    await f.put(['Source Space','opentofu-application','main.tf'],'locals {\n  changed = true\n}\n');
    const run=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async()=>{throw new Error('No dispatch allowed for stale source.');});
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/changed/);
    expect(run).not.toHaveBeenCalled();expect(await createLocalExecutionRecordStore(f.root).readState(preview.fingerprint)).toBeNull();
  },120000);
  nativeIt.each(['changed-output','unknown-settlement'] as const)('retains truthful %s without advancing dependent validation',async fault=>{
    const f=await fixture(),before=await tree(f.root),preview=await prepareModernOpenSpecInitializedBaseline(f.root,{kind:'verify-openspec-initialized',preparation:[]});
    await approveModernOpenSpecInitializedBaseline(f.root,preview.fingerprint,consent);
    const original=NodeCommandRunner.prototype.run;let affected=false,actualSettled=false;
    vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      const result=await original.call(this,command,options);
      if(!affected&&command.args[0]===(fault==='unknown-settlement'?'init':'validate')){
        affected=true;actualSettled=result.processTreeSettled===true;
        console.info('OI_FAULT_ACTUAL_RESULT '+JSON.stringify({fault,command,result,kind:'negative-adapter-after-genuine-settled-command'}));
        if(fault==='unknown-settlement')return {...result,processTreeSettled:false};
        if(!options?.env?.TF_DATA_DIR)throw new Error('Missing actual initialization environment.');
        await writeFile(path.join(options.env.TF_DATA_DIR,'unexpected'),'test-only mutation after actual validate');
      }
      return result;
    });
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    expect(affected).toBe(true);expect(actualSettled).toBe(true);expect(result.complete).toBe(false);
    expect(result.checks.find(c=>c.id==='tofu-initialize:opentofu-environment:dev')?.status).toBe('blocked');
    if(fault==='unknown-settlement'){
      expect(result.status).toBe('uncertain');expect(result.cleanupComplete).toBe(false);
      const store=createLocalExecutionRecordStore(f.root),record=await store.read('workspace-authority',preview.fingerprint),value=record?.value;
      if(!result.retainedWorkspace||!value||typeof value!=='object'||!('directory'in value)||value.directory!==result.retainedWorkspace||
        !('creationIdentity'in value)||!value.creationIdentity||typeof value.creationIdentity!=='object')throw new Error('Missing retained owned workspace identity.');
      const identity=value.creationIdentity,s=await lstat(result.retainedWorkspace,{bigint:true});
      if(!('inode'in identity)||!('device'in identity))throw new Error('Missing ownership anchor.');
      expect(String(s.ino)).toBe(identity.inode);expect(String(s.dev)).toBe(identity.device);
      roots.push({path:result.retainedWorkspace,ino:Number(s.ino),dev:Number(s.dev)});
    }else expect(result.cleanupComplete).toBe(true);
    expect(await tree(f.root)).toEqual(before);
    console.info('OI_NEGATIVE_OUTCOME '+JSON.stringify({fault,result,actualSettled,testOnlyAttributedCleanup:fault==='unknown-settlement'}));
  },300000);
});
