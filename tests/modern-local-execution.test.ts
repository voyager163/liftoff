import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,lstat,rename,symlink,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {observeModernLocalTools} from '../src/adapters/process/modern-local-tools.js';
import {createApplicationEnvironment} from '../src/application/repair/application-environment.js';
import {NodeCommandRunner} from '../src/process-runner.js';
import {createLocalExecutionRecordStore} from '../src/adapters/filesystem/update-previews.js';
import {createModernLocalWorkspace,copyModernLocalWorkspace} from '../src/adapters/filesystem/modern-local-workspaces.js';
import {localExecutionPolicy,localExecutionDigest,validateLocalExecutionResult,type LocalExecutionPreview} from '../src/domain/governance/activation/modern-local-runtime.js';
import {canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {rawLocalDigest,type ModernLocalCheck,type ModernLocalSnapshot} from '../src/domain/governance/activation/modern-local-inputs.js';
import {toolFile} from '../src/application/repair/application-toolchain.js';
import {prepareModernLocalExecution,approveModernLocalExecution,inspectModernLocalExecution} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {projectCatalog} from '../src/application/project/catalog.js';
import {composeModernManifestPlugins} from '../src/application/project/plugins.js';
import {resolveModernManifestV8SourceContract} from '../src/application/project/manifest.js';
import {createManifestV8ProjectReader} from '../src/domain/project/manifest/v8-project.js';
import {createManifestV8Reader} from '../src/domain/project/manifest/v8.js';
import {readManifestPluginMetadata} from '../src/domain/project/manifest/plugins.js';
import {buildModernManagedCore} from '../src/application/project/modern-managed-core.js';
import {createModernGovernanceContextContract} from '../src/domain/governance/policy/modern-context.js';
import {modernActivationSourceContracts} from '../src/domain/governance/policy/identity.js';
import {inspectModernLocalRuntime} from '../src/application/governance/modern-local-inputs.js';
import {spawnSync} from 'node:child_process';
import {projectMutationLockPath} from '../src/adapters/filesystem/project-lock.js';
const mode=process.env.LIFTOFF_HCL_TEST_LANE??'auto';
if(!['auto','portable','native'].includes(mode))throw new Error('Invalid local execution qualification test lane.');
const qualified=process.platform==='darwin'&&process.arch==='arm64'&&process.versions.node==='24.21.0';
if(mode==='native'&&!qualified)throw new Error('Local execution native tests require actual qualified runtime.');
const native=mode!=='portable'&&qualified,nativeIt=it.skipIf(!native);
const executed:string[]=[];beforeEach(({task})=>{executed.push(task.name);});
afterAll(()=>{if(mode==='native')expect(executed.some(name=>name.startsWith('executes the real full none'))).toBe(true);
  console.info('MR2_B_TEST_INVENTORY '+JSON.stringify({mode,qualified,native,executed,
    nativeUnrun:native?[]:['actual tool observation','owned process settlement','full real approval/check execution and failure paths'],
    claim:mode==='portable'?'Portable contract/workspace checks only, not other-platform execution qualification.':'Actual current-host owned fixtures only.'}));});
const roots:string[]=[];
const scopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:false,dependencyNetwork:false,workflowFinalization:false as const,publishLocalRecords:false as const};
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'local-effects-')));roots.push(directory);const project=path.join(directory,'project');await mkdir(project);return {directory,project};}
async function completeFixture(profile:'none'|'single-maintainer-gitflow'='none',failure=false){
  const f=await fixture(),leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project:{name:'Local Execution Fixture',workload:{kind:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',frontend:true,environments:['dev']},specWorkflow:'manual',agents:[]},
    framework:{state:'not-required'}
  });
  const selection={...leaf,profile},resolution=composeModernManifestPlugins({workload:'standard',stack:'node-fastify',cloud:'azure',workflow:'manual',agents:[],frontend:'included',environments:['dev'],governanceProfile:profile},{safeProjectName:'local-execution-fixture'}).resolution;
  const plugins=readManifestPluginMetadata({schemaVersion:1,resolutionDigest:resolution.digest,selections:resolution.plugins},{stack:'node-fastify',cloud:'azure',workflow:'manual',agents:[]});
  const source=resolveModernManifestV8SourceContract({selection,recordedPlugins:plugins});
  const activeLayout={schemaVersion:1,state:'bound',bindings:[
    ...source.layoutDescriptor.components.map(component=>({kind:'component',component,pathParts:['Source Space',component.replace(':',' ')]})),
    {kind:'artifact',logicalName:'docker-compose',pathParts:['compose.yml']}
  ]};
  const contracts={catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract},input={selection,plugins,activeLayout};
  const core=buildModernManagedCore(input),context=profile==='none'?undefined:createModernGovernanceContextContract(contracts).buildModernGovernanceContext(input);
  const manifest=createManifestV8Reader(contracts).parseManifestV8({artifactVersion:8,generatedBy:'Mission Control Liftoff',liftoffVersion:modernActivationSourceContracts()[0].identity.liftoffVersion,
    project:leaf.project,framework:leaf.framework,plugins,activeLayout,
    governance:context?{profile,policyVersion:context.governance.policyVersion,state:'handoff-generated',activationIdentity:context.governance.activationIdentity}:{profile:'none',state:'disabled'},
    managedArtifacts:core.map(file=>({logicalName:file.logicalName,category:file.category,pathParts:file.pathParts,contentHash:`sha256:${rawLocalDigest(file.content)}`})),projectArtifacts:[],adoptionObservations:[]});
  async function put(parts:readonly string[],bytes:string){const destination=path.join(f.project,...parts);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);}
  await put(['liftoff.manifest.json'],JSON.stringify(manifest,null,2)+'\n');
  for(const file of core)await put(file.pathParts,file.content);
  for(const component of source.layoutDescriptor.components){
    const parts=['Source Space',component.replace(':',' ')];
    if(component==='backend'){
      await put([...parts,'package.json'],'{"name":"local-backend","version":"1.0.0","scripts":{"test":"node --test"}}\n');
      await put([...parts,'tests','source.test.cjs'],failure?'process.stdout.write("PRIVATE_UNTRUSTED_DIAGNOSTIC");process.exit(7);\n':'const test=require("node:test");const assert=require("node:assert/strict");test("actual local input",()=>{assert.equal(2+2,4);});\n');
    }else if(component==='frontend'){
      await put([...parts,'package.json'],'{"name":"local-frontend","version":"1.0.0","scripts":{"build":"node build.cjs"}}\n');
      await put([...parts,'build.cjs'],'require("node:fs").mkdirSync("dist");require("node:fs").writeFileSync("dist/index.html","owned build output");\n');
    }else if(component.startsWith('opentofu-'))await put([...parts,'main.tf'],'locals {\n  enabled = true\n}\n');
    else await put([...parts,'source.txt'],'Complete selected source.\n');
  }
  await put(['compose.yml'],'services:\n  app:\n    image: example/local:source\n');
  return {...f,manifest,put};
}
const nodeCheck:ModernLocalCheck={id:'owned-node-format-fixture',status:'planned',inputPaths:[],reasons:[],command:{executable:'node',args:['--version']},cwdPathParts:[],env:{},prerequisites:[],effects:['metadata-probe-only']};
function operation(root:string):LocalExecutionPreview{
  const createdAt=new Date().toISOString(),body={kind:'liftoff-local-execution-preview' as const,schemaVersion:1 as const,operationKind:'verify-local' as const,
    projectRoot:root,operationId:'11111111-1111-4111-8111-111111111111',createdAt,expiresAt:new Date(Date.parse(createdAt)+900000).toISOString(),
    installedBinding:'a'.repeat(64),observationDigest:'b'.repeat(64),physicalDigest:'c'.repeat(64),baselineDigest:'d'.repeat(64),recipeDigest:'e'.repeat(64),
    policyDigest:canonicalSha256(localExecutionPolicy),checks:[{...nodeCheck,inputPaths:undefined}],tools:[],preparation:[],preparationDigest:canonicalSha256([]),outputRoles:[],selectedPlan:null,selectedPlanDigest:null};
  const {inputPaths:_paths,...check}=nodeCheck;
  const exact={...body,checks:[check]};return {...exact,fingerprint:localExecutionDigest(exact)};
}
describe('actual local execution prerequisites and bounded effects',()=>{
  nativeIt('independently resolves actual installed Node for metadata, not a complete baseline',async()=>{
    const {project}=await fixture(),tools=await observeModernLocalTools(project,[nodeCheck],[]);
    expect(tools.map(tool=>tool.id)).toEqual(['node']);
    expect(tools[0].files[0].digest).toMatch(/^[a-f0-9]{64}$/);
    expect(tools[0].executablePath).not.toContain(project);
    expect(tools[0].version).toMatch(/^24\./);
  });
  nativeIt('reports actual complete required tool availability without installing or fabricating plugin identity',async()=>{
    const {project}=await fixture();
    const checks=['npm','tofu','docker'].map(executable=>({...nodeCheck,id:executable,command:{executable,args:['--version']}}));
    const outcome=await observeModernLocalTools(project,checks,[]).then(tools=>({tools,error:null}),error=>({tools:null,error:String(error.message)}));
    console.info('MR2_B_ACTUAL_TOOL_AVAILABILITY '+JSON.stringify(outcome));
    expect(outcome.error).toBeNull();
    expect(outcome.tools?.map(tool=>tool.id)).toEqual(expect.arrayContaining(['node','npm','tofu','docker']));
    expect(outcome.tools?.find(tool=>tool.id==='docker')?.versions.compose).toBe('5.5.1');
  },60000);
  nativeIt('retains changed workspace identity rather than deleting a replacement or granting verified',async()=>{
    const f=await completeFixture(),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
    await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
    const original=NodeCommandRunner.prototype.run;let replaced=false;
    vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      const result=await original.call(this,command,options);
      if(!replaced&&command.args.at(-1)==='test'){
        replaced=true;
        const project=path.dirname(path.dirname(options!.cwd!));
        await rename(project,`${project}-retained`);await mkdir(project);
      }
      return result;
    });
    const result=await executeModernLocalExecution(f.project,preview.fingerprint);
    expect(replaced).toBe(true);expect(result.complete).toBe(false);expect(result.cleanupComplete).toBe(false);
    if(!result.retainedWorkspace)throw new Error('Expected retained owned workspace.');
    expect(await lstat(path.join(result.retainedWorkspace,'project-retained'))).toBeDefined();
    roots.push(result.retainedWorkspace);
  },60000);
  nativeIt('clears actual ambient secrets/loader environment before an owned process runs',async()=>{
    const {directory,project}=await fixture(),workspace=path.join(directory,'workspace');await mkdir(workspace);
    const env=await createApplicationEnvironment({...process.env,MR2_SECRET:'do-not-forward',NODE_OPTIONS:'--require=bad'},project,project,workspace);
    const binary=await toolFile(process.execPath,project,workspace,true);
    const script=path.join(workspace,'fixture.cjs');await writeFile(script,'if (process.env.MR2_SECRET || process.env.NODE_OPTIONS) process.exit(17); process.stdout.write("owned-success");\n');
    const result=await new NodeCommandRunner().run({executable:binary.path,args:[script]},{cwd:workspace,env,timeoutMs:5000,maxOutputBytes:1024,ensureProcessTreeSettled:true,stream:false});
    expect(result.status).toBe(0);expect(result.stdout).toBe('owned-success');expect(result.processTreeSettled).toBe(true);
  });
  describe('actual complete approved local verification',()=>{
    nativeIt.each(['none','single-maintainer-gitflow'] as const)('executes the real full %s Manual baseline without publication',async profile=>{
      const f=await completeFixture(profile),manifestBefore=await readFile(path.join(f.project,'liftoff.manifest.json'));
      const preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      expect(preview.checks.some(check=>check.id==='compose-config')).toBe(true);
      expect(preview.checks.some(check=>check.id.startsWith('tofu-validate:'))).toBe(true);
      expect(preview.selectedPlan===null).toBe(profile==='none');
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      const result=await executeModernLocalExecution(f.project,preview.fingerprint);
      console.info('MR2_B_ACTUAL_COMPLETE_RESULT '+JSON.stringify(result));
      expect(result.status).toBe('checks-verified');expect(result.complete).toBe(true);expect(result.cleanupComplete).toBe(true);
      expect(result.checks.map(check=>check.id)).toEqual(preview.checks.map(check=>check.id));
      expect(result.checks.filter(check=>check.status==='passed').every(check=>check.processTreeSettled)).toBe(true);
      expect(await readFile(path.join(f.project,'liftoff.manifest.json'))).toEqual(manifestBefore);
      await expect(lstat(path.join(f.project,'governance','activation-state.json'))).rejects.toMatchObject({code:'ENOENT'});
      await expect(executeModernLocalExecution(f.project,preview.fingerprint)).rejects.toThrow(/already claimed/);
    },60000);
    nativeIt('records generated failure codes/digests, never project output text or fake full success',async()=>{
      const f=await completeFixture('none',true),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      const result=await executeModernLocalExecution(f.project,preview.fingerprint);
      expect(result.complete).toBe(false);expect(result.status).toBe('failed');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_UNTRUSTED_DIAGNOSTIC');
      expect(result.checks.find(check=>check.id==='backend-tests')).toMatchObject({status:'failed',code:'nonzero-exit'});
      expect(result.checks.find(check=>check.id==='frontend-build')?.status).toBe('blocked');
    },60000);
    nativeIt('executes real empty-lock offline preparation with separate consent and exact result correspondence',async()=>{
      const f=await completeFixture(),parts=['Source Space','backend'];
      const pkg={name:'local-backend',version:'1.0.0',scripts:{test:'node --test'},dependencies:{}};
      await f.put([...parts,'package.json'],JSON.stringify(pkg)+'\n');
      await f.put([...parts,'package-lock.json'],JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,dependencies:{}}}})+'\n');
      const request={provider:'npm-ci' as const,version:1 as const,cwdPathParts:parts,packageSource:'npmjs' as const,network:false,lifecycle:'disabled' as const};
      const preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[request]});
      await expect(approveModernLocalExecution(f.project,preview.fingerprint,scopes)).rejects.toThrow(/separate/);
      await approveModernLocalExecution(f.project,preview.fingerprint,{...scopes,dependencyPreparation:true});
      const result=await executeModernLocalExecution(f.project,preview.fingerprint);
      console.info('MR2_B_ACTUAL_OFFLINE_PREPARATION '+JSON.stringify(result));
      expect(result.complete).toBe(true);expect(result.preparation).toHaveLength(1);
      expect(result.preparation[0]).toMatchObject({id:'npm-ci:Source Space/backend:0',status:'passed',processTreeSettled:true});
      expect((await inspectModernLocalExecution(f.project,preview.fingerprint)).result).toEqual(result);
      for(const field of ['commandDigest','toolDigest']){
        const body={...result,preparation:[{...result.preparation[0],[field]:'a'.repeat(64)}]};
        const {resultDigest:_old,...changed}=body;
        expect(()=>validateLocalExecutionResult({...changed,resultDigest:canonicalSha256(changed)},preview)).toThrow(/exact approved/);
      }
      await f.put([...parts,'package.json'],JSON.stringify({...pkg,packageManager:'npm@1.0.0'})+'\n');
      await expect(prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[request]})).rejects.toThrow(/tool requirements/);
    },60000);
    nativeIt('rejects changed source after explicit approval before claiming or dispatching effects',async()=>{
      const f=await completeFixture(),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      await f.put(['Source Space','backend','tests','new.test.cjs'],'throw new Error("changed");');
      await expect(executeModernLocalExecution(f.project,preview.fingerprint)).rejects.toThrow(/changed/);
      expect(await inspectModernLocalExecution(f.project,preview.fingerprint)).toMatchObject({status:'absent'});
    },60000);
    nativeIt('detects changed original input after an actual command and retains failure instead of prior successes',async()=>{
      const f=await completeFixture(),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      const original=NodeCommandRunner.prototype.run;let changed=false;
      vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
        const result=await original.call(this,command,options);
        if(!changed&&command.args.at(-1)==='test'){changed=true;await f.put(['Source Space','backend','new-file.cjs'],'original changed after check');}
        return result;
      });
      const result=await executeModernLocalExecution(f.project,preview.fingerprint);
      expect(changed).toBe(true);expect(result.complete).toBe(false);expect(result.inputsUnchanged).toBe(false);
      expect(result.checks.find(check=>check.id==='backend-tests')?.status).toBe('passed');
      expect(result.checks.find(check=>check.id==='frontend-build')?.status).toBe('blocked');
      expect(await readFile(path.join(f.project,'Source Space/backend/new-file.cjs'),'utf8')).toContain('changed');
    },60000);
    nativeIt('fails when actual check code alters protected staged source, even with exitzero',async()=>{
      const f=await completeFixture();
      await f.put(['Source Space','backend','tests','source.test.cjs'],'require("node:fs").writeFileSync("package.json","{}");\n');
      const preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      const original=await readFile(path.join(f.project,'Source Space/backend/package.json'));
      const result=await executeModernLocalExecution(f.project,preview.fingerprint);
      expect(result.complete).toBe(false);
      expect(result.checks.find(check=>check.id==='backend-tests')?.status).toBe('passed');
      expect(await readFile(path.join(f.project,'Source Space/backend/package.json'))).toEqual(original);
    },60000);
    nativeIt('refuses a changed independently observed tool launcher before project dispatch',async()=>{
      const f=await completeFixture(),tools=path.join(f.directory,'tools');await mkdir(tools);
      const node=path.join(tools,'node');await symlink(process.execPath,node);
      const originalPath=process.env.PATH;
      process.env.PATH=[tools,originalPath??''].join(path.delimiter);
      try{
        const preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
        await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
        await unlink(node);await symlink('/usr/bin/false',node);
        const result=await executeModernLocalExecution(f.project,preview.fingerprint);
        expect(result.complete).toBe(false);expect(result.checks.every(check=>check.status==='blocked'||check.status==='inapplicable')).toBe(true);
      }finally{if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;}
    },60000);
    nativeIt('retains an uncertain command owner and never fabricates a settled result',async()=>{
      const f=await completeFixture(),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      const original=NodeCommandRunner.prototype.run;
      vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
        if(command.args.at(-1)==='test')throw new Error('Explicit dispatch uncertainty; no actual child launched by this fixture.');
        return original.call(this,command,options);
      });
      const result=await executeModernLocalExecution(f.project,preview.fingerprint);
      expect(result.status).toBe('uncertain');expect(result.complete).toBe(false);expect(result.cleanupComplete).toBe(false);
      expect(result.checks.find(check=>check.id==='backend-tests')).toMatchObject({status:'uncertain',code:'unsettled',stdoutDigest:null,stderrDigest:null,processTreeSettled:false});
      const progress=await inspectModernLocalExecution(f.project,preview.fingerprint);
      expect(progress.state).toMatchObject({phase:'uncertain',activity:{kind:'check'}});
      if(!result.retainedWorkspace)throw new Error('Expected exact retained owned workspace.');
      roots.push(result.retainedWorkspace);
    },60000);
    nativeIt('rejects malformed saved preparation rather than trusting its claimed commands or digest',async()=>{
      const f=await completeFixture(),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      const forged={...preview,preparation:[{provider:'npm-ci',version:1,cwdPathParts:['Source Space','backend'],packageSource:'npmjs',network:false,lifecycle:'disabled',commands:[{tool:'npm',args:['install']}]}]};
      forged.preparationDigest=canonicalSha256(forged.preparation);
      const {fingerprint:_old,...body}=forged;forged.fingerprint=localExecutionDigest(body);
      const store=createLocalExecutionRecordStore(f.project);await store.write('preview',forged.fingerprint,forged);
      await approveModernLocalExecution(f.project,forged.fingerprint,{...scopes,dependencyPreparation:true});
      const result=await executeModernLocalExecution(f.project,forged.fingerprint);
      expect(result.complete).toBe(false);expect(result.preparation).toEqual([]);
    },60000);
    nativeIt('retains real exited-child dispatch progress and refuses restart replay after exact test-only lock cleanup',async()=>{
      const f=await completeFixture(),preview=await prepareModernLocalExecution(f.project,{kind:'verify-local',preparation:[]});
      await approveModernLocalExecution(f.project,preview.fingerprint,scopes);
      const loader=path.join(f.directory,'source-loader.mjs'),child=path.join(f.directory,'crash-child.mjs'),repository=process.cwd();
      await writeFile(loader,`
        import {registerHooks,stripTypeScriptTypes} from 'node:module';
        import {readFileSync,existsSync} from 'node:fs';
        import {fileURLToPath,pathToFileURL} from 'node:url';
        const root=${JSON.stringify(repository)};
        registerHooks({
          resolve(specifier,context,next){
            if(context.parentURL?.startsWith(pathToFileURL(root+'/').href)&&specifier.startsWith('.')&&specifier.endsWith('.js')){
              const file=fileURLToPath(new URL(specifier.slice(0,-3)+'.ts',context.parentURL));
              if(existsSync(file))return next(pathToFileURL(file).href,context);
            }
            return next(specifier,context);
          },
          load(url,context,next){
            if(url.startsWith(pathToFileURL(root+'/').href)&&url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform',sourceUrl:url})};
            return next(url,context);
          }
        });
      `);
      await writeFile(child,`
        import {NodeCommandRunner} from ${JSON.stringify(new URL('../src/process-runner.ts',import.meta.url).href)};
        import {executeModernLocalExecution} from ${JSON.stringify(new URL('../src/application/governance/modern-local-execution.ts',import.meta.url).href)};
        const original=NodeCommandRunner.prototype.run;
        NodeCommandRunner.prototype.run=function(command,options){
          if(command.args.at(-1)==='test')process.exit(73);
          return original.call(this,command,options);
        };
        await executeModernLocalExecution(${JSON.stringify(f.project)},${JSON.stringify(preview.fingerprint)});
        process.exit(74);
      `);
      const result=spawnSync(process.execPath,['--import',loader,child],{cwd:f.directory,env:process.env,encoding:'utf8',timeout:30000,killSignal:'SIGKILL',maxBuffer:65536});
      expect(result.status,result.stderr).toBe(73);expect(result.error).toBeUndefined();expect(()=>process.kill(result.pid,0)).toThrow();
      const progress=await inspectModernLocalExecution(f.project,preview.fingerprint);
      expect(progress.state).toMatchObject({phase:'verifying',activity:{kind:'check',id:'backend-tests'}});
      expect(progress.result).toBeNull();
      const lock=await projectMutationLockPath(f.project),identity=await lstat(lock),bytes=await readFile(lock),current=await lstat(lock);
      expect(current.ino).toBe(identity.ino);expect(current.dev).toBe(identity.dev);expect(await readFile(lock)).toEqual(bytes);
      console.info('MR2_B_EXITED_CHILD_LOCK_PREREQUISITE '+JSON.stringify({pid:result.pid,status:result.status,pidAbsent:true,lock,ino:identity.ino,digest:rawLocalDigest(bytes),testOnlyKnownOwnerCleanup:true}));
      await unlink(lock);
      await expect(executeModernLocalExecution(f.project,preview.fingerprint)).rejects.toThrow(/already claimed/);
      if(!progress.state?.workspace)throw new Error('Expected actually retained owned workspace.');
      roots.push(progress.state.workspace);
    },60000);
  });
  nativeIt.each(['failure','output','descendant'] as const)('settles actual owned %s command without claiming complete checks',async fault=>{
    const {directory,project}=await fixture(),workspace=path.join(directory,'workspace');await mkdir(workspace);
    const env=await createApplicationEnvironment(process.env,project,project,workspace),file=path.join(workspace,'fixture.cjs');
    await writeFile(file,fault==='failure'?'process.exit(3);\n':fault==='output'?'process.stdout.write("x".repeat(8192));\n':
      'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setInterval(()=>{},1000);\n');
    const result=await new NodeCommandRunner().run({executable:process.execPath,args:[file]},{cwd:workspace,env,timeoutMs:500,maxOutputBytes:1024,ensureProcessTreeSettled:true,stream:false});
    expect(result.processTreeSettled).toBe(true);
    if(fault==='failure')expect(result.status).toBe(3);
    if(fault==='output')expect(result.outputLimitExceeded).toBe(true);
    if(fault==='descendant')expect(result.timedOut).toBe(true);
  },10000);
  it('does not execute without an actual saved complete operation and consent',async()=>{
    const {project}=await fixture();
    await expect(executeModernLocalExecution(project,'a'.repeat(64))).rejects.toThrow(/missing/);
    expect(await inspectModernLocalExecution(project,'a'.repeat(64))).toMatchObject({status:'absent',execution:'not-authorized'});
    await expect(prepareModernLocalExecution(project,{kind:'verify-local',preparation:[]})).rejects.toThrow(/unblocked/);
  });
});
describe('independently owned local workspace semantics',()=>{
  it('refuses denied initial CAS without allocating an execution owner',async()=>{
    const {project}=await fixture(),preview=operation(project),store=createLocalExecutionRecordStore(project);
    const denied={...store,compareExchangeState:async()=>{throw new Error('Explicit denied CAS fixture');}};
    await expect(createModernLocalWorkspace(project,preview,denied)).rejects.toThrow(/denied CAS/);
    expect(await store.readState(preview.fingerprint)).toBeNull();
    expect(await store.read('workspace-authority',preview.fingerprint)).toBeNull();
  });
  it('retains claimed progress and the actual allocated workspace when authority storage fails',async()=>{
    const {project}=await fixture(),preview=operation(project),store=createLocalExecutionRecordStore(project);
    let allocated:string|undefined;
    const denied={...store,write:async(kind:Parameters<typeof store.write>[0],key:string,value:unknown)=>{
      if(kind==='workspace-authority'){
        if(value&&typeof value==='object'&&'directory'in value&&typeof value.directory==='string')allocated=value.directory;
        throw new Error('Explicit denied authority storage fixture');
      }
      return store.write(kind,key,value);
    }};
    await expect(createModernLocalWorkspace(project,preview,denied)).rejects.toThrow(/denied authority/);
    expect((await store.readState(preview.fingerprint))?.value).toMatchObject({phase:'claimed'});
    if(!allocated)throw new Error('Expected exact allocated workspace.');
    expect((await lstat(allocated)).isDirectory()).toBe(true);roots.push(allocated);
    await expect(createModernLocalWorkspace(project,preview,store)).rejects.toThrow();
  });
  it('refuses cleanup when attributed authority cannot be read and leaves owned bytes intact',async()=>{
    const {project}=await fixture(),preview=operation(project),store=createLocalExecutionRecordStore(project);
    let denied=false;
    const port={...store,read:async(kind:Parameters<typeof store.read>[0],key:string)=>{
      if(denied&&kind==='workspace-authority')throw new Error('Explicit denied cleanup authority fixture');
      return store.read(kind,key);
    }};
    const workspace=await createModernLocalWorkspace(project,preview,port);denied=true;
    await expect(workspace.cleanup()).rejects.toThrow(/denied cleanup/);
    expect((await lstat(workspace.directory)).isDirectory()).toBe(true);
    denied=false;await workspace.cleanup();await workspace.finish('b'.repeat(64));
  });
  it('creates attributed roles, copies captured bytes and cleans only owned entries after settlement',async()=>{
    const {project,put}=await completeFixture(),preview=operation(project),store=createLocalExecutionRecordStore(project);
    const bytes=Buffer.from('retained source\r\n');await put(['Source Space','backend','source.txt'],bytes.toString());
    const observed=await inspectModernLocalRuntime(project);
    if(observed.status!=='observed'||observed.local.status!=='modern-observed')throw new Error('Expected actual source capture.');
    const workspace=await createModernLocalWorkspace(project,preview,store);
    await copyModernLocalWorkspace(observed.local.snapshot,workspace);
    expect(await readFile(path.join(workspace.roles.project,'Source Space','backend','source.txt'))).toEqual(bytes);
    await workspace.begin({kind:'check',id:'fixture-activity-only',commandDigest:'a'.repeat(64)});
    await expect(workspace.cleanup()).rejects.toThrow(/Unsettled/);
    await workspace.settle();await workspace.cleanup();await workspace.finish('b'.repeat(64));
    await expect(lstat(workspace.directory)).rejects.toMatchObject({code:'ENOENT'});
    await expect(createModernLocalWorkspace(project,preview,store)).rejects.toThrow();
  });
  it('retains uncertain owner state rather than inferring process settlement from a stored flag',async()=>{
    const {project}=await fixture(),preview=operation(project),store=createLocalExecutionRecordStore(project);
    const workspace=await createModernLocalWorkspace(project,preview,store);
    await workspace.begin({kind:'check',id:'never-dispatched-fault-fixture',commandDigest:'a'.repeat(64)});
    await workspace.uncertain();
    await expect(workspace.cleanup()).rejects.toThrow(/Unsettled/);
    expect(workspace.state().phase).toBe('uncertain');
    // No process was launched in this fixture; remove only its captured directory.
    roots.push(workspace.directory);
  });
});
