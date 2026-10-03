import {performance} from 'node:perf_hooks';
import path from 'node:path';
import { lstat,mkdir,readdir } from 'node:fs/promises';
import {NodeCommandRunner,type CommandResult} from '../../process-runner.js';
import {withProjectMutationLock} from '../../adapters/filesystem/project-lock.js';
import {createModernLocalWorkspace,copyModernLocalWorkspace,type LocalExecutionWorkspace} from '../../adapters/filesystem/modern-local-workspaces.js';
import {assertModernLocalToolsCurrent,LocalToolSettlementError} from '../../adapters/process/modern-local-tools.js';
import {createApplicationEnvironment} from '../repair/application-environment.js';
import {CapturedApplicationProtection} from '../repair/application-protection.js';
import {inspectModernLocalRuntime,planModernLocalRuntime} from './modern-local-inputs.js';
import {localExecutionRoot,localExecutionStore,loadLocalExecutionPreview,loadLocalExecutionConsent,captureLocalExecutionRuntime,reconstructLocalExecution} from './modern-local-approval.js';
import {canonicalSha256} from '../../domain/governance/activation/canonical-json.js';
import {copyModernLocalData,capturedFileBytes,localInputFailure,rawLocalDigest,ModernLocalInputError} from '../../domain/governance/activation/modern-local-inputs.js';
import {localExecutionPolicy,validateLocalExecutionResult,type LocalExecutionResult,type LocalExecutionCheckResult,
  assertExecutableLocalExecutionPreview,openSpecMetadataEnvironment,openSpecReadOnlyExecutionPolicy,
  type LocalExecutionPreview,type LocalExecutionTool,type LocalExecutionCode} from '../../domain/governance/activation/modern-local-runtime.js';
import type {ApplicationResolvedPreparation} from '../repair/application-preparation-types.js';
import {validateOpenSpecCommandOutput,validateInitializedOpenSpecCommandOutput,type OpenSpecExecutionObservation} from '../../domain/governance/activation/modern-openspec-execution.js';
import {createOpenSpecInitializationEnvironment} from './modern-openspec-preparation.js';
import {initializationObligationOutcomes,openSpecInitializationPolicy,type OpenSpecInitializationOutput} from '../../domain/governance/activation/modern-openspec-obligations.js';

function observedResult(id:string,tool:LocalExecutionTool,command:{executable:string;args:string[]},raw:CommandResult,startedAt:string):LocalExecutionCheckResult{
  const code:LocalExecutionCode=raw.processTreeSettled!==true?'unsettled':raw.timedOut?'timeout':raw.outputLimitExceeded?'output-limit':
    raw.aborted?'cancelled':raw.errorCode||raw.errorMessage||raw.processSpawned===false?'process-failed':
      raw.status!==0||raw.signal?'nonzero-exit':'passed';
  return {id,status:code==='passed'?'passed':code==='unsettled'?'uncertain':'failed',code,
    commandDigest:canonicalSha256(command),toolDigest:tool.digest,exitStatus:Number.isSafeInteger(raw.status)?raw.status:null,
    signal:raw.signal&&/^SIG[A-Z0-9]+$/u.test(raw.signal)?raw.signal:null,
    startedAt,completedAt:new Date().toISOString(),stdoutDigest:rawLocalDigest(raw.stdout),stderrDigest:rawLocalDigest(raw.stderr),processTreeSettled:raw.processTreeSettled===true};
}
function notRun(id:string,inapplicable=false):LocalExecutionCheckResult{
  return {id,status:inapplicable?'inapplicable':'blocked',code:inapplicable?'inapplicable':'not-run',
    commandDigest:null,toolDigest:null,exitStatus:null,signal:null,startedAt:null,completedAt:null,stdoutDigest:null,stderrDigest:null,processTreeSettled:inapplicable};
}
export async function executeModernLocalExecution(root:string,fingerprint:string):Promise<LocalExecutionResult>{
  const selected=copyModernLocalData({root,fingerprint});
  const canonical=await localExecutionRoot(selected.root),store=localExecutionStore(canonical);
  const preview=await loadLocalExecutionPreview(canonical,selected.fingerprint,store);
  assertExecutableLocalExecutionPreview(preview);
  const consent=await loadLocalExecutionConsent(canonical,preview,store);
  const startedAt=new Date().toISOString(),start=performance.now(),checks=preview.checks.map(check=>notRun(check.id,check.status==='inapplicable'));
  const preparationResults:LocalExecutionCheckResult[]=[];
  const openSpecObservations:OpenSpecExecutionObservation[]=[];
  const initializationOutputs:OpenSpecInitializationOutput[]=[];
  let initializationEnvironment:Awaited<ReturnType<typeof createOpenSpecInitializationEnvironment>>|undefined;
  let workspace:LocalExecutionWorkspace|undefined,cleanupComplete=false,inputsUnchanged=false,uncertain=false,failed=false;
  let protection:CapturedApplicationProtection|undefined;
  let preparation:ApplicationResolvedPreparation[]=[];
  if(preview.preparation.some(step=>typeof step==='object'&&step!==null&&'network'in step&&step.network===true))localInputFailure('Dependency network execution requires a separate authorized fixture/effect qualification; this bounded local executor does not perform it.');
  async function current(){
    if(performance.now()-start>=localExecutionPolicy.operationTimeoutMs)localInputFailure('Local whole-operation deadline exhausted.');
    const {inspection,plan,binding}=await captureLocalExecutionRuntime(canonical,preview.schemaVersion===3||preview.schemaVersion===4,preview.schemaVersion===4);
    const expected={installedBinding:preview.installedBinding,observationDigest:preview.observationDigest,physicalDigest:preview.physicalDigest,
      baselineDigest:preview.baselineDigest,recipeDigest:preview.recipeDigest};
    if(canonicalSha256(binding)!==canonicalSha256(expected)||canonicalSha256(plan.localPlan!.checks.map(({inputPaths:_paths,...check})=>check))!==canonicalSha256(preview.checks))localInputFailure('Approved original runtime inputs or complete recipes changed.');
    if(Date.now()>=Date.parse(preview.expiresAt))localInputFailure('Execution consent expired before a new effect.');
    if(performance.now()-start>=localExecutionPolicy.operationTimeoutMs)localInputFailure('Local whole-operation deadline exhausted during reinspection.');
    return inspection;
  }
  return withProjectMutationLock(canonical,async lease=>{
    await current();
    if(await store.readState(preview.fingerprint))localInputFailure('This local execution intent was already claimed; inspect retained progress, never replay automatically.');
    workspace=await createModernLocalWorkspace(canonical,preview,store);
    try{
      await workspace.begin({kind:'probe',id:'actual-admission-reconstruction',commandDigest:canonicalSha256(preview.tools.map(tool=>tool.probe))});
      try{
        const reconstruction=await reconstructLocalExecution(preview);
        preparation=reconstruction.preparation;
        await workspace.settle();
      }catch(error){
        if(error instanceof LocalToolSettlementError){uncertain=true;await workspace.uncertain();}
        else await workspace.settle();
        localInputFailure('Actual tool/preparation admission could not be reconstructed; no project check was run.');
      }
      const inspection=await current();
      if(inspection.status!=='observed'||inspection.local.status!=='modern-observed')localInputFailure('Missing actual runtime source.');
      const captured=inspection.local.snapshot;
      await copyModernLocalWorkspace(captured,workspace);
      if(preview.schemaVersion===4)initializationEnvironment=await createOpenSpecInitializationEnvironment(workspace.directory,preview.initialization);
      const base=await createApplicationEnvironment(process.env,canonical,workspace.directory,workspace.directory);
      const node=preview.tools.find(tool=>tool.id==='node');
      if(node)base.PATH=[path.dirname(node.executablePath),base.PATH??''].filter(Boolean).join(path.delimiter);
      Object.assign(base,{DOCKER_CONFIG:path.join(workspace.roles.home,'docker'),DOCKER_HOST:`unix://${path.join(workspace.roles.scratch,'no-daemon.sock')}`,
        DOCKER_CLI_HINTS:'false',COMPOSE_DISABLE_ENV_FILE:'1'});
      const openSpecHome=preview.schemaVersion===3||preview.schemaVersion===4?path.join(workspace.roles.home,'openspec-readonly'):null;
      if(openSpecHome)await mkdir(openSpecHome,{mode:0o700});
      const openSpecHomeIdentity=openSpecHome?await lstat(openSpecHome,{bigint:true}):null;
      async function assertOpenSpecHome(){
        if(!openSpecHome||!openSpecHomeIdentity)localInputFailure('Missing owned OpenSpec environment.');
        const current=await lstat(openSpecHome,{bigint:true});
        if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==openSpecHomeIdentity.dev||current.ino!==openSpecHomeIdentity.ino||
          current.mode!==openSpecHomeIdentity.mode||current.uid!==openSpecHomeIdentity.uid||(await readdir(openSpecHome)).length)
          localInputFailure('OpenSpec user configuration/schema/cache boundary is no longer empty and owned.');
      }
      const sourceFiles=captured.files.filter(file=>file.pathParts[0]!=='governance');
      const directoryInventory=captured.directories.filter(dir=>dir.pathParts[0]!=='governance').map(dir=>({...dir,pathParts:[...dir.pathParts],entries:dir.entries.map(entry=>({...entry}))}));
      // Managed control readers capture file/physical identities independently
      // of the application directory inventory. The private copy still needs
      // every created parent represented for output protection.
      for(const file of sourceFiles.filter(file=>file.content!==null)){
        for(let length=1;length<file.pathParts.length;length++){
          const parts=file.pathParts.slice(0,length);
          if(directoryInventory.some(directory=>directory.pathParts.join('/')===parts.join('/')))continue;
          const identity=await lstat(path.join(workspace.roles.project,...parts));
          if(!identity.isDirectory()||identity.isSymbolicLink())localInputFailure('Private control parent is not a real created directory.');
          directoryInventory.push({pathParts:[...parts],exists:true,mode:identity.mode&0o7777,entries:[]});
        }
      }
      protection=new CapturedApplicationProtection({
        files:sourceFiles.map(file=>({pathParts:[...file.pathParts],...(file.content===null?{}:{content:capturedFileBytes(file)!,mode:file.mode!})})),
        directories:directoryInventory.filter(dir=>dir.exists),outputRoles:preview.outputRoles,toolchain:preview.tools
      },workspace.directory);
      await protection.captureControls();
      const runner=new NodeCommandRunner();
      function environmentFor(step:ApplicationResolvedPreparation|undefined):NodeJS.ProcessEnv{
        const env={...base};
        if(!step)return env;
        const id=step.cwdPathParts.join('-');
        if(step.provider==='uv-locked-sync')Object.assign(env,{UV_PROJECT_ENVIRONMENT:path.join(workspace!.roles.project,...step.cwdPathParts,'.venv'),
          UV_CACHE_DIR:path.join(workspace!.roles.cache,'uv',id),UV_OFFLINE:'1'});
        if(step.provider==='npm-ci')Object.assign(env,{npm_config_cache:path.join(workspace!.roles.cache,'npm',id),npm_config_registry:step.registry,npm_config_offline:'true'});
        if(step.provider==='go-mod-download')Object.assign(env,{GOPATH:path.join(workspace!.roles.cache,'go-path',id),
          GOMODCACHE:path.join(workspace!.roles.cache,'go-mod',id),GOCACHE:path.join(workspace!.roles.cache,'go-build',id)});
        return env;
      }
      async function run(id:string,tool:LocalExecutionTool,args:string[],cwdParts:readonly string[],kind:'preparation'|'check'|'probe',environment:NodeJS.ProcessEnv=base){
        await lease.assertHeld();await current();await protection!.assertCurrent();await assertModernLocalToolsCurrent(canonical,workspace!.directory,preview.tools);
        if(initializationEnvironment){
          await initializationEnvironment.assertControls();
          if(id.startsWith('tofu-initialize:'))await initializationEnvironment.assertFresh(id.slice('tofu-initialize:'.length));
          for(const old of initializationOutputs){
            const actual=await initializationEnvironment.capture(old.component,preview.observationDigest,old.toolDigest);
            if(canonicalSha256(actual)!==canonicalSha256(old))localInputFailure('Prepared initialization output changed before a dependent check.');
          }
        }
        const remaining=localExecutionPolicy.operationTimeoutMs-(performance.now()-start);
        if(remaining<=0)localInputFailure('Local whole-operation deadline exhausted before dispatch.');
        if(tool.id==='openspec')await assertOpenSpecHome();
        const command={executable:tool.executablePath,args:[...tool.prefixArgs,...args]},commandDigest=canonicalSha256(command);
        await workspace!.begin({kind,id,commandDigest});
        const at=new Date().toISOString();
        let result:CommandResult;
        try{
          let dispatchEnvironment=environment;
          if(tool.id==='openspec'){
            dispatchEnvironment={...Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined])),...environment,...openSpecMetadataEnvironment,
              HOME:openSpecHome!,USERPROFILE:openSpecHome!,APPDATA:openSpecHome!,LOCALAPPDATA:openSpecHome!,
              XDG_CONFIG_HOME:openSpecHome!,XDG_DATA_HOME:openSpecHome!,XDG_STATE_HOME:openSpecHome!,XDG_CACHE_HOME:openSpecHome!,
              DO_NOT_TRACK:'1',LIFTOFF_TELEMETRY:'0',NODE_DISABLE_COMPILE_CACHE:'1'};
          }
          if(preview.schemaVersion===4)dispatchEnvironment={...Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined])),...dispatchEnvironment};
          result=await runner.run(command,{cwd:path.join(workspace!.roles.project,...cwdParts),env:dispatchEnvironment,
            timeoutMs:Math.min(remaining,kind==='preparation'?localExecutionPolicy.preparationTimeoutMs:localExecutionPolicy.checkTimeoutMs),
            maxOutputBytes:localExecutionPolicy.checkOutputBytes,ensureProcessTreeSettled:true,stream:false});
        }catch{
          uncertain=true;
          const observation:LocalExecutionCheckResult={...notRun(id),status:'uncertain',code:'unsettled',commandDigest,toolDigest:tool.digest,startedAt:at,completedAt:new Date().toISOString()};
          if(kind==='check'){const index=checks.findIndex(check=>check.id===id);if(index>=0)checks[index]=observation;}
          else if(kind==='preparation')preparationResults.push(observation);
          await workspace!.uncertain();localInputFailure('Local process dispatch or settlement is unknown; workspace retained.');
        }
        let observed=observedResult(id,tool,command,result,at);
        if(tool.id==='openspec'&&observed.status==='passed'){
          try{
            if((preview.schemaVersion!==3&&preview.schemaVersion!==4)||result.stderr!=='')localInputFailure('OpenSpec command has unexpected diagnostics or admission.');
            if(preview.schemaVersion===4)validateInitializedOpenSpecCommandOutput(preview.openSpecInputs,preview.initialization,id,result.stdout,workspace!.roles.project);
            else validateOpenSpecCommandOutput(preview.openSpecInputs,id,result.stdout,workspace!.roles.project);
            await assertOpenSpecHome();
            const proof={id,stdout:result.stdout};
            if(Buffer.byteLength(JSON.stringify([...openSpecObservations,proof]))>openSpecReadOnlyExecutionPolicy.jsonProofBytes)localInputFailure('OpenSpec observation proof exceeds its bounded result allocation.');
            openSpecObservations.push(proof);
          }catch(error){
            if(!(error instanceof ModernLocalInputError))throw error;
            observed={...observed,status:'failed',code:'admission-changed'};
          }
        }
        if(kind==='check'){
          const index=checks.findIndex(check=>check.id===id);if(index>=0)checks[index]=observed;
        }else if(kind==='preparation')preparationResults.push(observed);
        if(!observed.processTreeSettled){uncertain=true;await workspace!.uncertain();return observed;}
        await workspace!.settle();
        if(initializationEnvironment&&id.startsWith('tofu-initialize:')&&observed.status==='passed'){
          try{initializationOutputs.push(await initializationEnvironment.capture(id.slice('tofu-initialize:'.length),preview.observationDigest,tool.digest));}
          catch(error){
            if(kind==='check'){const index=checks.findIndex(c=>c.id===id);if(index>=0)checks[index]={...observed,status:'failed',code:'admission-changed'};}
            throw error;
          }
        }
        if(initializationEnvironment)for(const old of initializationOutputs){
          if(canonicalSha256(await initializationEnvironment.capture(old.component,preview.observationDigest,old.toolDigest))!==canonicalSha256(old))
            localInputFailure('Initialization output changed after a process.');
        }
        await assertModernLocalToolsCurrent(canonical,workspace!.directory,preview.tools);
        await protection!.assertCurrent();await current();await lease.assertHeld();
        return observed;
      }
      if(preparation.length&&!consent.scopes.dependencyPreparation)localInputFailure('Locked preparation lacks its separate consent.');
      for(const step of preparation){
        await workspace.checkpoint('preparing');
        for(const [index,command]of step.commands.entries()){
          const tool=preview.tools.find(tool=>tool.id===command.tool);if(!tool)localInputFailure('Preparation tool missing.');
          const python=preview.tools.find(tool=>tool.id==='python');
          const args=command.args.map(value=>value==='$APPROVED_PYTHON'?python?.executablePath??localInputFailure('Python identity missing.'):
            value==='$PRIVATE_PYTHON_ENVIRONMENT'?path.join(workspace!.roles.project,...step.cwdPathParts,'.venv'):value);
          const outcome=await run(`${step.provider}:${step.cwdPathParts.join('/')}:${index}`,tool,args,step.cwdPathParts,'preparation',environmentFor(step));
          if(outcome.status!=='passed')localInputFailure('Approved preparation did not complete.');
        }
        // npm legitimately omits node_modules for an empty locked dependency set.
        if(step.provider==='npm-ci'&&step.packageCount===0){
          for(const role of step.outputRoles.filter(role=>role.protectedAfterPreparation)){
            await mkdir(path.join(workspace.directory,...role.pathParts),{recursive:true,mode:0o700});
          }
        }
        await protection.freeze(step);
      }
      await workspace.checkpoint('verifying');
      for(const [index,check]of preview.checks.entries()){
        if(check.status==='inapplicable')continue;
        if(!check.command){
          await current();
          checks[index]={...notRun(check.id),status:'passed',code:'passed',exitStatus:0,processTreeSettled:true,
            startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),commandDigest:canonicalSha256({kind:'in-process',id:check.id}),toolDigest:null};
          continue;
        }
        const tool=preview.tools.find(tool=>tool.id===check.command!.executable);if(!tool)localInputFailure('Applicable local check has no exact installed tool.');
        const args=tool.id==='docker'?check.command.args.slice(1):check.command.args;
        const prepared=preparation.find(step=>step.cwdPathParts.join('/')===check.cwdPathParts.join('/')||
          check.command?.executable==='uv'&&step.provider==='uv-locked-sync');
        const component=preview.schemaVersion===4?preview.initialization.roots.find(r=>check.id===`tofu-initialize:${r.component}`||check.id===`tofu-validate:${r.component}`):undefined;
        const env={...environmentFor(prepared),...check.env,...(component?initializationEnvironment!.environment(component.component):{})};
        const outcome=await run(check.id,tool,args,check.cwdPathParts,'check',env);checks[index]=outcome;
        if(outcome.status!=='passed')localInputFailure('Actual local check did not pass.');
      }
      await current();await assertModernLocalToolsCurrent(canonical,workspace.directory,preview.tools);inputsUnchanged=true;
    }catch{
      failed=true;
      if(workspace?.state().activity){
        uncertain=true;
        await workspace.uncertain();
      }
    }
    finally{
      try{await current();inputsUnchanged=true;}catch{inputsUnchanged=false;}
      if(workspace&&!uncertain){
        try{await workspace.cleanup();cleanupComplete=true;}catch{cleanupComplete=false;failed=true;}
      }
    }
    if(performance.now()-start>=localExecutionPolicy.operationTimeoutMs)failed=true;
    const complete=!failed&&!uncertain&&inputsUnchanged&&cleanupComplete&&checks.every((check,index)=>check.status===(preview.checks[index].status==='inapplicable'?'inapplicable':'passed'));
    const body={kind:'liftoff-local-execution-result' as const,schemaVersion:1 as const,projectRoot:canonical,fingerprint:preview.fingerprint,operationId:preview.operationId,
      status:complete?'checks-verified' as const:uncertain?'uncertain' as const:workspace?'failed' as const:'blocked' as const,complete,startedAt,completedAt:new Date().toISOString(),
      checks,preparation:preparationResults,inputsUnchanged,cleanupComplete,retainedWorkspace:cleanupComplete?null:workspace?.directory??null,
      policyDigest:preview.policyDigest,baselineDigest:preview.baselineDigest,selectedPlanDigest:preview.selectedPlanDigest,
      failureCode:complete?null:uncertain?'unsettled' as const:!inputsUnchanged?'admission-changed' as const:!cleanupComplete?'workspace-failed' as const:'process-failed' as const};
    if(preview.schemaVersion===4&&consent.schemaVersion!==3)localInputFailure('Initialization consent changed during execution.');
    const selectedBody=preview.schemaVersion===4&&consent.schemaVersion===3?{...body,schemaVersion:3 as const,
      status:complete?'initialization-obligations-observed' as const:uncertain?'uncertain' as const:workspace?'failed' as const:'blocked' as const,
      openSpec:{inputDigest:canonicalSha256(preview.openSpecInputs),projectRoot:path.join(workspace!.directory,'project'),observations:openSpecObservations},
      initialization:{inputDigest:canonicalSha256(preview.initialization),markerProvenance:openSpecInitializationPolicy.markerProvenance,
        attestation:consent.bootstrapScopeAttestation,outputs:initializationOutputs,
        obligations:initializationObligationOutcomes(preview.initialization,checks,consent.bootstrapScopeAttestation)}}:preview.schemaVersion===3?{...body,schemaVersion:2 as const,openSpec:{
      inputDigest:canonicalSha256(preview.openSpecInputs),projectRoot:path.join(workspace!.directory,'project'),observations:openSpecObservations}}:body;
    const result=validateLocalExecutionResult({...selectedBody,resultDigest:canonicalSha256(selectedBody)},preview,workspace?.directory);
    if(workspace&&!uncertain)await workspace.finish(result.resultDigest);
    await store.write('result',preview.fingerprint,result);
    return result;
  });
}
