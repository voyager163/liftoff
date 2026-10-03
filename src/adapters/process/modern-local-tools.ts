import {lstat,mkdir,mkdtemp,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {NodeCommandRunner} from '../../process-runner.js';
import {nativeExecutableObserver} from '../filesystem/executables.js';
import {resolveApplicationToolsForLocalChecks,toolFile} from '../../application/repair/application-toolchain.js';
import {createApplicationEnvironment} from '../../application/repair/application-environment.js';
import {applicationToolRequirement} from '../../application/repair/application-preparation-policy.js';
import {compatibleRange} from '../../application/repair/application-preparation.js';
import type {ApplicationToolId,ApplicationResolvedPreparation} from '../../application/repair/application-preparation-types.js';
import {canonicalSha256} from '../../domain/governance/activation/canonical-json.js';
import {localInputFailure,copyModernLocalData,ModernLocalInputError,type ModernLocalCheck} from '../../domain/governance/activation/modern-local-inputs.js';
import {openSpecMetadataEnvironment,type LocalExecutionTool} from '../../domain/governance/activation/modern-local-runtime.js';
import {captureOpenSpecDistribution,assertOpenSpecDistributionCurrent} from '../filesystem/installed-tool-distribution.js';
import {workstationRequirementCatalog} from '../../workstation-catalog.js';
import {extractVersion,matchesReleaseLine,compareVersionCores} from '../../domain/workstation/versions.js';
import {canonicalWorkspaceBoundary,deleteCapturedWorkspace,workspaceFileIdentity} from '../filesystem/repair-workspaces.js';
import type {RepairWorkspaceRole,RepairWorkspaceFileIdentity} from '../../application/repair/workspaces-types.js';
export class LocalToolSettlementError extends ModernLocalInputError {}

async function neutral(root:string) {
  const original=await canonicalWorkspaceBoundary(root);
  const parent=await realpath(process.platform==='darwin'?'/private/tmp':'/tmp');
  const directory=await mkdtemp(path.join(parent,'liftoff-local-tools-')),identity=await lstat(directory);
  if(identity.isSymbolicLink()||!identity.isDirectory())localInputFailure('Unsafe local tool observation workspace.');
  const identities={} as Record<RepairWorkspaceRole,{path:string;identity:RepairWorkspaceFileIdentity}>;
  for(const name of ['project','home','cache','scratch'] as const){
    const target=path.join(directory,name);await mkdir(target,{mode:0o700});
    identities[name]={path:target,identity:workspaceFileIdentity(await lstat(target,{bigint:true}))};
  }
  const creationIdentity=workspaceFileIdentity(await lstat(directory,{bigint:true}));
  const assertCurrent=async()=>{
    if(canonicalSha256((await canonicalWorkspaceBoundary(root)).identity)!==canonicalSha256(original.identity)||
      canonicalSha256((await canonicalWorkspaceBoundary(directory)).identity)!==canonicalSha256(creationIdentity))localInputFailure('Tool observation workspace/root changed; retained.');
  };
  return {directory,staging:identities.project.path,
    cleanup:()=>deleteCapturedWorkspace({directory,creationIdentity,roles:identities,privateBoundaries:[directory],protectedRoots:[root]}, {},async()=>{},assertCurrent)};
}
export async function observeModernLocalTools(root:string,checks:readonly ModernLocalCheck[],preparation:readonly ApplicationResolvedPreparation[]):Promise<readonly LocalExecutionTool[]>{
  const captured=copyModernLocalData({root,checks,preparation});
  const platform=process.platform;
  if(platform!=='darwin'&&platform!=='linux'&&platform!=='win32')localInputFailure('Local tool inspection is unavailable on this platform.');
  const needed=new Set(captured.checks.flatMap(check=>check.command?[check.command.executable]:[]));
  for(const step of captured.preparation)for(const id of step.tools)needed.add(id);
  if(needed.has('npm')||needed.has('openspec'))needed.add('node');
  if(needed.has('uv'))needed.add('python');
  const owned=await neutral(root);let unsettled=false;
  try{
    const basic:ApplicationToolId[]=(['node','npm','python','uv','go'] as const).filter(id=>needed.has(id));
    const observed=basic.length?await resolveApplicationToolsForLocalChecks(root,owned.staging,basic,{},true):[];
    const tools:LocalExecutionTool[]=observed.map(tool=>{
      const body={id:tool.id,launcherPath:tool.launcherPath,executablePath:tool.executablePath,
        prefixArgs:tool.prefixArgs,version:tool.version,versions:{[tool.id]:tool.version},files:tool.files,probe:tool.probe};
      return {...body,digest:canonicalSha256(body)};
    });
    const env=await createApplicationEnvironment(process.env,root,owned.staging,owned.directory),runner=new NodeCommandRunner();
    Object.assign(env,{DOCKER_CONFIG:path.join(owned.directory,'home','docker'),DOCKER_HOST:`unix://${path.join(owned.directory,'scratch','no-daemon.sock')}`,DOCKER_CLI_HINTS:'false',COMPOSE_DISABLE_ENV_FILE:'1'});
    for(const id of (['tofu','docker','openspec'] as const).filter(id=>needed.has(id))){
      const definition=workstationRequirementCatalog[id==='tofu'?'opentofu':id==='docker'?'docker':'openspec'];
      const resolution=await nativeExecutableObserver.resolve(id,{platform,cwd:owned.directory,env,definition});
      if(resolution.resolution!=='resolved'||!resolution.realPath||!resolution.resolvedPath)localInputFailure(`Missing independently installed ${id} tool; no installation is implicit.`);
      let executablePath=resolution.realPath;const prefixArgs:string[]=[],files=[];
      let distribution:Awaited<ReturnType<typeof captureOpenSpecDistribution>>|undefined;
      if(id==='openspec'){
        const node=tools.find(tool=>tool.id==='node');if(!node)localInputFailure('OpenSpec requires an independently resolved Node interpreter.');
        const launcher=await toolFile(resolution.resolvedPath,root,owned.staging,false);
        const packagePath=path.join(path.dirname(path.dirname(launcher.path)),'package.json');
        const metadata=await toolFile(packagePath,root,owned.staging,false);
        if(metadata.bytes>65536)localInputFailure('OpenSpec package metadata is unbounded.');
        const value:unknown=JSON.parse(await readFile(metadata.path,'utf8'));
        if(typeof value!=='object'||value===null||!('name'in value)||value.name!=='@fission-ai/openspec')localInputFailure('OpenSpec launcher lacks its exact installed package identity.');
        files.push(launcher,metadata,...node.files);executablePath=node.executablePath;prefixArgs.push(launcher.path);
        distribution=await captureOpenSpecDistribution({launcherPath:resolution.resolvedPath,canonicalLauncherPath:launcher.path,projectRoot:root,stagingRoot:owned.staging});
      }else files.push(await toolFile(resolution.resolvedPath,root,owned.staging,true));
      let probe={executable:executablePath,args:[...prefixArgs,'--version']};
      unsettled=true;
      const probeEnv=id==='openspec'?{...Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined])),...env,...openSpecMetadataEnvironment}:env;
      const result=await runner.run(probe,{cwd:owned.directory,env:probeEnv,timeoutMs:15000,maxOutputBytes:8192,ensureProcessTreeSettled:true,stream:false});
      unsettled=result.processTreeSettled!==true&&result.processSpawned!==false;
      if(result.status!==0||result.signal||result.timedOut||result.outputLimitExceeded||result.errorCode||result.processTreeSettled!==true)localInputFailure(`Installed ${id} metadata observation failed; no check is authorized.`);
      let version=extractVersion(`${result.stdout}\n${result.stderr}`,id==='tofu'?'opentofu':id);
      if(!version||definition.exactVersion&&version!==definition.exactVersion||
        definition.minimumVersion&&compareVersionCores(version,definition.minimumVersion)<0||
        definition.releaseLine&&!matchesReleaseLine(version,definition.releaseLine))localInputFailure(`Installed ${id} version is not supported.`);
      const versions:Record<string,string>={[id]:version};
      if(id==='docker'){
        // The CLI version does not identify the separately executed Compose plugin.
        const candidates=[path.resolve(path.dirname(resolution.realPath),'../cli-plugins/docker-compose'),
          path.resolve(path.dirname(resolution.realPath),'../../lib/docker/cli-plugins/docker-compose')];
        let plugin;
        for(const candidate of candidates){
          try{plugin=await toolFile(candidate,root,owned.staging,true);break;}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        }
        if(!plugin)localInputFailure('The actual installed Compose plugin identity is unavailable; Docker CLI version alone is insufficient.');
        files.push(plugin);executablePath=plugin.path;
        unsettled=true;
        const compose=await runner.run({executable:plugin.path,args:['version','--short']},{cwd:owned.directory,env,timeoutMs:15000,maxOutputBytes:8192,ensureProcessTreeSettled:true,stream:false});
        unsettled=compose.processTreeSettled!==true&&compose.processSpawned!==false;
        const composeVersion=extractVersion(compose.stdout,'docker');
        if(compose.status!==0||compose.signal||compose.errorCode||compose.timedOut||compose.outputLimitExceeded||compose.processTreeSettled!==true||!composeVersion)localInputFailure('Compose plugin version/settlement is unavailable.');
        versions.compose=composeVersion;version=composeVersion;probe={executable:plugin.path,args:['version','--short']};
      }
      const body={id,launcherPath:resolution.resolvedPath,executablePath,prefixArgs,version,versions,files,probe};
      if(id==='openspec'){
        if(!distribution||distribution.commitment.package.version!==version)localInputFailure('OpenSpec version differs from its complete package identity.');
        const after=await assertOpenSpecDistributionCurrent({launcherPath:resolution.resolvedPath,canonicalLauncherPath:files[0].path,projectRoot:root,stagingRoot:owned.staging},distribution.commitment);
        if(canonicalSha256(after.launcher)!==canonicalSha256(distribution.launcher))localInputFailure('OpenSpec launcher association changed around metadata execution.');
        const full={...body,id:'openspec' as const,kind:'liftoff-distribution-bound-tool' as const,schemaVersion:1 as const,distribution:distribution.commitment,launcherObservation:distribution.launcher};
        tools.push({...full,digest:canonicalSha256(full)});
      }else tools.push({...body,digest:canonicalSha256(body)});
    }
    for(const step of captured.preparation)for(const [id,requirement] of Object.entries(step.toolRequirements)){
      const tool=tools.find(item=>item.id===id.replace(/-(?:exact|toolchain)$/u,''));
      if(!tool||!compatibleRange(tool.version,requirement))localInputFailure('Installed runtime differs from exact locked project tool requirements.');
    }
    await assertModernLocalToolsCurrent(root,owned.staging,tools);
    return tools;
  }catch(error){
    if(error instanceof Error&&error.message.includes('tool-probe-cleanup'))unsettled=true;
    throw error;
  }finally{if(unsettled)throw new LocalToolSettlementError('Tool process settlement unknown; owned metadata workspace retained.');await owned.cleanup();}
}
export async function assertModernLocalToolsCurrent(root:string,workspace:string,input:readonly LocalExecutionTool[]):Promise<void>{
  const tools=copyModernLocalData(input);
  for(const tool of tools){
    if(tool.id==='openspec'){
      if(!('distribution'in tool))localInputFailure('Legacy OpenSpec tool identity does not establish a current complete distribution.');
      const actual=await assertOpenSpecDistributionCurrent({launcherPath:tool.launcherPath,canonicalLauncherPath:tool.files[0].path,projectRoot:root,stagingRoot:workspace},tool.distribution);
      if(canonicalSha256(actual.launcher)!==canonicalSha256(tool.launcherObservation))localInputFailure('Current OpenSpec launcher association differs.');
    }
    if(await realpath(tool.launcherPath)!==tool.files[0]?.path)localInputFailure('Installed local tool launcher changed.');
    for(const file of tool.files)if(canonicalSha256(await toolFile(file.path,root,workspace,false))!==canonicalSha256(file))localInputFailure('Installed local tool bytes or physical identity changed.');
    if(['node','npm','python','uv','go'].includes(tool.id)){
      const requirement=applicationToolRequirement(tool.id as ApplicationToolId);
      if(!matchesReleaseLine(tool.version,requirement.releaseLine)||compareVersionCores(tool.version,requirement.minimumVersion)<0)localInputFailure('Local tool version changed from packaged requirement.');
    }
  }
}
