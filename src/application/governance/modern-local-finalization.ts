import {randomUUID,randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {createLocalFinalizationRecordStore,createLocalVerificationTransactionAuthorityStore,
  type LocalFinalizationRecordStore} from '../../adapters/filesystem/update-previews.js';
import {inspectLocalVerificationTransaction,inspectLocalVerificationCandidate} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {captureCompletionInputs,compareCompletionInputs,completionPreconditions,completionSnapshot,readCompletionFile,validateCompletionIndex} from '../../adapters/filesystem/modern-local-publication-inputs.js';
import {localExecutionRoot,readCompletedModernLocalExecution,readCompletedLocalExecutionRecords} from './modern-local-approval.js';
import {copyModernLocalData,localInputFailure,rawLocalDigest,capturedFileBytes} from '../../domain/governance/activation/modern-local-inputs.js';
import {canonicalJson} from '../../domain/governance/activation/canonical-json.js';
import {createModernActivationRecordContract,type ModernRelatedRecords,type ModernActivationRecordContract} from '../../domain/governance/activation/modern-records.js';
import {projectCatalog} from '../project/catalog.js';
import {createManifestV8ProjectReader} from '../../domain/project/manifest/v8-project.js';
import type {ModernActivationState,ModernPhaseId,ModernSavedTransitionPlan} from '../../domain/governance/activation/modern-record-contracts.js';
import type {ProjectFileMutation,ProjectFileSnapshot} from '../../adapters/filesystem/project-transaction.js';
import {exactRecord} from '../../domain/project/manifest/fields.js';
import {createManifestV8Reader,type LiftoffManifestV8} from '../../domain/project/manifest/v8.js';
import {resolveModernManifestV8SourceContract} from '../project/manifest.js';
import {frameworkOutputPaths} from '../../framework-validation.js';
import {completedSpecKitTasks} from '../../governance-activation/spec-kit-seed.js';
import {appendSpecKitDocumentIssues,appendSpecKitTaskIssues,appendSpecKitDefaultIssues,appendSpecKitSelectedIssues,isSpecKitIntegrationRecord,isSpecKitInstalledList,
  specKitBootstrapId,specKitBootstrapPath,specKitBootstrapTaskIds} from '../../domain/governance/activation/local-check-values.js';
import {artifactBytes,completionDigest,completionHash,completionTime,completedExecutionBinding,localCompletionPolicy,nativeCompletionPath,
  publicationFingerprint,validateFinalizationPreview,validateFinalizationScopes,validateFinalizationConsent,validateFinalizationResult,validateFinalizationState,
  specKitCompletionPolicy,validateSpecKitFinalizationScopes,validateSpecKitWorkflowInput,
  type SpecKitFinalizationPreview,type SpecKitWorkflowInput,type SpecKitWorkflowOutcome,
  type LocalCompletionContext,type LocalFinalizationPreview,type LocalFinalizationConsent,type LocalFinalizationScopes,type LocalFinalizationState,
  type LocalFinalizationArtifact,type LocalFinalizationResult,type CompletionTarget,type CompletionProtectedIndex,type NativeLocalCompletion} from '../../domain/governance/activation/modern-local-completion.js';

export async function inspectCompletionBoundary(root:string){
  const canonical=await localExecutionRoot(root),authorityStore=createLocalVerificationTransactionAuthorityStore(canonical);
  const transaction=await inspectLocalVerificationTransaction(canonical,{authorityStore});
  return {root:canonical,authorityStore,transaction};
}
export async function requireIdleCompletionBoundary(root:string){
  const observed=await inspectCompletionBoundary(root);
  if(observed.transaction.status!=='absent')localInputFailure('Local publication requires explicit attributed recovery before installed-state interpretation.');
  return observed;
}
export function captureFinalizationStore(value:LocalFinalizationRecordStore,root:string):LocalFinalizationRecordStore{
  const keys=['operationKind','projectRoot','read','write','readState','compareExchangeState'];
  if(!value||typeof value!=='object'||types.isProxy(value))localInputFailure('Dedicated local-finalization store is required.');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(keys.some(key=>!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value'))||descriptors.operationKind.value!=='local-finalization'||
    descriptors.projectRoot.value!==root||keys.slice(2).some(key=>typeof descriptors[key].value!=='function'))localInputFailure('Local finalization store attribution differs.');
  const {read,write,readState,compareExchangeState}=value;
  return Object.freeze({operationKind:'local-finalization',projectRoot:root,
    read:(kind,key)=>read.call(value,kind,key),write:(kind,key,item)=>write.call(value,kind,key,item),
    readState:key=>readState.call(value,key),compareExchangeState:(key,digest,item)=>compareExchangeState.call(value,key,digest,item)} satisfies LocalFinalizationRecordStore);
}
export function finalizationStore(root:string):LocalFinalizationRecordStore{return captureFinalizationStore(createLocalFinalizationRecordStore(root),root);}
export async function readFinalizationPreview(root:string,fingerprint:string,store=finalizationStore(root)):Promise<LocalFinalizationPreview>{
  completionHash(fingerprint);
  const saved=await store.read('preview',fingerprint);if(!saved)localInputFailure('Original finalization preview is missing.');
  const raw=copyModernLocalData(saved.value) as LocalFinalizationPreview,p=validateFinalizationPreview(raw,new Date(raw.createdAt));
  if(p.projectRoot!==root||p.fingerprint!==fingerprint||completionTime(p.createdAt)>Date.now())localInputFailure('Finalization preview root/issuance differs.');
  return p;
}
function artifact(p:LocalFinalizationPreview,role:LocalFinalizationArtifact['role'],bytes:Buffer,parts:string[]|null,mode:number|null):LocalFinalizationArtifact{
  const body={kind:'liftoff-local-finalization-artifact' as const,projectRoot:p.projectRoot,operationId:p.operationId,finalizationFingerprint:p.fingerprint,
    pathParts:parts,contentBase64:bytes.toString('base64'),bytes:bytes.length,rawDigest:rawLocalDigest(bytes),mode};
  const result:LocalFinalizationArtifact=role==='workflow-original'?{...body,schemaVersion:2,role}:{...body,schemaVersion:1,role};
  artifactBytes(result,p);return result;
}
export async function loadCompletionArtifact(store:LocalFinalizationRecordStore,key:string,p:LocalFinalizationPreview){
  const saved=await store.read('artifact',key);if(!saved)localInputFailure('Original exact completion artifact is missing.');
  const value=copyModernLocalData(saved.value) as LocalFinalizationArtifact,bytes=artifactBytes(value,p);
  if(completionDigest(value)!==key)localInputFailure('Completion artifact key differs from its exact original bytes.');
  return {value,bytes};
}
export async function loadFinalizationResult(root:string,key:string,store=finalizationStore(root)){
  completionHash(key);
  const saved=await store.read('result',key);if(!saved)localInputFailure('Exact finalization result is missing.');
  const raw=copyModernLocalData(saved.value) as LocalFinalizationResult,p=await readFinalizationPreview(root,raw.fingerprint,store),result=validateFinalizationResult(raw,p);
  if(key!==result.fingerprint&&key!==result.publicationFingerprint)localInputFailure('Finalization result was loaded under a foreign review.');
  const original=await store.read('consent',p.fingerprint);if(!original)localInputFailure('Original finalization consent is missing.');
  const consent=validateFinalizationConsent(original.value as LocalFinalizationConsent,p,new Date(result.startedAt));
  if(completionDigest(consent)!==result.consentDigest||completionTime(result.completedAt)>Date.now())localInputFailure('Finalization result/consent chronology differs.');
  const protectedArtifact=await loadCompletionArtifact(store,result.protectedIndexKey,p);
  if(protectedArtifact.value.role!=='protected-index')localInputFailure('Protected input index artifact is not its registered role.');
  const index=validateCompletionIndex(JSON.parse(protectedArtifact.bytes.toString('utf8')) as CompletionProtectedIndex);
  if(index.projectRoot!==root||completionDigest(index)!==p.protectedSetDigest)localInputFailure('Protected input index differs from the reviewed operation.');
  const mutations:ProjectFileMutation[]=[];
  for(const target of result.targets){
    const item=await loadCompletionArtifact(store,target.artifactKey,p);
    if(item.value.role!=='target'||completionDigest(item.value.pathParts)!==completionDigest(target.pathParts)||
      item.value.rawDigest!==target.target.rawDigest||item.value.bytes!==target.target.bytes||item.value.mode!==target.target.mode)localInputFailure('Exact publication artifact differs from its observed target descriptor.');
    mutations.push({type:'write',pathParts:[...target.pathParts],content:item.bytes,mode:target.target.mode!});
  }
  if(result.schemaVersion===2){
    if(p.schemaVersion!==2)localInputFailure('Spec Kit result lacks its original workflow preview.');
    const original=await loadCompletionArtifact(store,result.workflowOutcome.originalTaskArtifactKey,p);
    if(original.value.role!=='workflow-original')localInputFailure('Spec Kit original bytes are not the original-task artifact role.');
  }
  return {preview:p,result,consent,index,mutations};
}
function specKitPaths(manifest:LiftoffManifestV8):string[][]{
  if(manifest.project.specWorkflow!=='spec-kit'||manifest.framework.state!=='initialized')localInputFailure('Spec Kit requires its actual initialized source contract.');
  return frameworkOutputPaths({workflow:'spec-kit',agents:[...manifest.project.agents],defaultAgent:manifest.project.defaultAgent});
}
function specKitText(file:ProjectFileSnapshot|undefined):string{
  if(!file?.content||file.mode===undefined)localInputFailure('Spec Kit bundle or selected marker is missing.');
  const text=file.content.toString('utf8');
  if(!text.length||text.includes('\0')||!Buffer.from(text).equals(file.content))localInputFailure('Spec Kit input is not exact nonempty UTF8.');
  return text;
}
function specKitInput(manifest:LiftoffManifestV8,files:readonly ProjectFileSnapshot[]):SpecKitWorkflowInput{
  const find=(parts:readonly string[])=>files.find(file=>file.pathParts.join('/')===parts.join('/')),markers=specKitPaths(manifest),issues:string[]=[];
  const bundle= ['spec','plan','tasks'].map(name=>find([...specKitBootstrapPath,`${name}.md`]));
  for(const [i,name]of (['spec','plan','tasks'] as const).entries()){
    const text=specKitText(bundle[i]);appendSpecKitDocumentIssues(name,text,[...specKitBootstrapPath,`${name}.md`],issues);
    if(name==='tasks')appendSpecKitTaskIssues(text,issues);
  }
  for(const parts of markers)specKitText(find(parts));
  const integration:unknown=JSON.parse(specKitText(find(['.specify','integration.json'])));
  if(!isSpecKitIntegrationRecord(integration))localInputFailure('Spec Kit integration must be an actual object.');
  const expectedDefault=manifest.project.defaultAgent?projectCatalog.getCodingAgent(manifest.project.defaultAgent)!.integrationIds['spec-kit']:undefined;
  appendSpecKitDefaultIssues(integration,expectedDefault,issues);
  if(!isSpecKitInstalledList(integration.installed_integrations))issues.push('Spec Kit installed integrations require an actual string array.');
  else appendSpecKitSelectedIssues(integration.installed_integrations,manifest.project.agents.map(agent=>projectCatalog.getCodingAgent(agent)!.integrationIds['spec-kit']),issues);
  if(issues.length)localInputFailure(issues.join(' '));
  const entry=(file:ProjectFileSnapshot)=>({pathParts:file.pathParts,...completionSnapshot(file)});
  const sorted=(values:ProjectFileSnapshot[])=>values.map(entry).sort((a,b)=>a.pathParts.join('/').localeCompare(b.pathParts.join('/'),'en'));
  const tasks=bundle[2]!;
  const input:SpecKitWorkflowInput={kind:'spec-kit-bootstrap-inputs',schemaVersion:1,bootstrapId:specKitBootstrapId,taskPathParts:[...specKitCompletionPolicy.taskPath],
    originalTaskHash:rawLocalDigest(tasks.content!),originalTaskBytes:tasks.content!.length,originalTaskMode:tasks.mode!,
    bundleDigest:completionDigest(sorted(bundle.map(file=>file??localInputFailure('Missing actual bundle file.')))),
    markerSetDigest:completionDigest({files:sorted(markers.map(parts=>find(parts)??localInputFailure('Missing actual marker file.'))),agents:manifest.project.agents,defaultAgent:manifest.project.defaultAgent}),
    taskProtocolDigest:completionDigest(specKitCompletionPolicy)};
  validateSpecKitWorkflowInput(input);return input;
}
function capturedSpecKit(current:Awaited<ReturnType<typeof readCompletedModernLocalExecution>>){
  if(current.inspection.local.status!=='modern-observed')localInputFailure('Missing actual captured Spec Kit input.');
  const files=current.inspection.local.snapshot.files.map(file=>({pathParts:[...file.pathParts],...(file.content===null?{}:{content:capturedFileBytes(file)!,mode:file.mode!})}));
  return {files,input:specKitInput(current.manifest,files),task:files.find(file=>file.pathParts.join('/')===specKitCompletionPolicy.taskPath.join('/'))!};
}
function preparedSpecKitInputDigest(original:SpecKitWorkflowInput,target:SpecKitWorkflowInput):string{
  if(completionDigest(original)===completionDigest(target))return completionDigest(original);
  return completionDigest({kind:'spec-kit-prepared-bootstrap-inputs',schemaVersion:1,beforeDigest:completionDigest(original),taskPathParts:original.taskPathParts,
    targetTaskHash:target.originalTaskHash,targetTaskBytes:target.originalTaskBytes,taskMode:target.originalTaskMode,targetBundleDigest:target.bundleDigest,markerSetDigest:target.markerSetDigest});
}
export async function validateSpecKitFinalization(review:Awaited<ReturnType<typeof loadFinalizationResult>>,stage:'original'|'target'):Promise<void>{
  const {preview:p,result}=review;if(p.schemaVersion!==2||result.schemaVersion!==2)localInputFailure('Expected the exact Spec Kit completion branch.');
  const store=finalizationStore(p.projectRoot),original=await loadCompletionArtifact(store,result.workflowOutcome.originalTaskArtifactKey,p);
  if(original.value.role!=='workflow-original')localInputFailure('Missing attributed original task bytes.');
  const manifestFile=await readCompletionFile(p.projectRoot,['liftoff.manifest.json']);
  if(!manifestFile.content)localInputFailure('Missing actual Spec Kit manifest.');
  const manifest=createManifestV8Reader({catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract}).parseManifestV8(JSON.parse(manifestFile.content.toString('utf8')));
  const paths=[...specKitPaths(manifest),...['spec','plan','tasks'].map(name=>[...specKitBootstrapPath,`${name}.md`])],files:ProjectFileSnapshot[]=[];
  for(const parts of paths)files.push(await readCompletionFile(p.projectRoot,parts));
  const task=files.find(file=>file.pathParts.join('/')===specKitCompletionPolicy.taskPath.join('/'))!;
  const beforeFiles=files.map(file=>file===task?{pathParts:task.pathParts,content:original.bytes,mode:original.value.mode!}:file);
  const before=specKitInput(manifest,beforeFiles);
  if(completionDigest(before)!==completionDigest(p.workflowInput))localInputFailure('Actual preserved Spec Kit bundle/markers differ from the original reviewed inputs.');
  const output=Buffer.from(completedSpecKitTasks(specKitText({pathParts:task.pathParts,content:original.bytes,mode:original.value.mode!})));
  const afterFiles=files.map(file=>file===task?{pathParts:task.pathParts,content:output,mode:original.value.mode!}:file),after=specKitInput(manifest,afterFiles);
  const outcome=result.workflowOutcome;
  if(outcome.targetTaskHash!==rawLocalDigest(output)||outcome.afterInputDigest!==preparedSpecKitInputDigest(before,after)||
    !task.content?.equals(stage==='original'?original.bytes:output)||task.mode!==original.value.mode)localInputFailure('Spec Kit task bytes/mode differ from the original helper correspondence.');
  const target=result.targets.find(t=>t.purpose==='spec-kit-bootstrap-tasks');
  if(output.equals(original.bytes)){
    if(target||outcome.disposition!=='already-finalized')localInputFailure('Already finalized task must not acquire a write.');
  }else{
    if(!target||outcome.disposition!=='changed')localInputFailure('Changed Spec Kit task lacks its exact reviewed target.');
    const expected=await loadCompletionArtifact(store,target.artifactKey,p);if(!expected.bytes.equals(output))localInputFailure('Spec Kit target is not the unchanged helper applied to original bytes.');
  }
}
export async function compareCompletedProvenance(p:LocalFinalizationPreview){
  const records=await readCompletedLocalExecutionRecords(p.projectRoot,p.execution.executionFingerprint);
  if(completionDigest(completedExecutionBinding(records,p.execution.rootIdentity))!==completionDigest(p.execution))localInputFailure('Original completed execution provenance changed.');
  return records;
}
function admissible(current:Awaited<ReturnType<typeof readCompletedModernLocalExecution>>):LocalCompletionContext{
  const {manifest,inspection,plan}=current,installed=inspection.installed,state=installed.current?.state;
  if(manifest.project.specWorkflow!=='manual'&&manifest.project.specWorkflow!=='spec-kit')localInputFailure('workflow-finalization-not-qualified: only Manual or Spec Kit is admitted.');
  if(!['fresh','current','governance-none'].includes(installed.classification)||installed.retention.length||
    state&&(state.remoteBinding||state.bootstrapState||state.successorHistory||state.activeChange||state.taskProjection||
      Object.entries(state.phases).some(([id,phase])=>!id.startsWith('local-')&&(phase.state!=='pending'||phase.evidence.length||phase.approvals.length))||
      state.baselineAnchor!==undefined&&state.baselineAnchor!==current.preview.baselineDigest))localInputFailure('History, retained-state, nonlocal or changed-baseline progression requires a separate reconciliation grant.');
  const context=plan.localPlan!.context!;
  return manifest.governance.profile==='none'&&context.kind==='governance-none'
    ?{profile:'none',workflow:manifest.project.specWorkflow,selectionDigest:context.selectionDigest,pluginResolutionDigest:context.pluginResolutionDigest,activeLayoutDigest:context.activeLayoutDigest,identity:null}
    :manifest.governance.profile!=='none'?{profile:manifest.governance.profile,workflow:manifest.project.specWorkflow,identity:manifest.governance.activationIdentity}
      :localInputFailure('None source context differs.');
}
export async function prepareModernLocalFinalization(root:string,request:{kind:'finalize-local';executionFingerprint:string}):Promise<LocalFinalizationPreview>{
  const selected=copyModernLocalData({root,request});exactRecord(selected.request,['kind','executionFingerprint'],'Finalization request');
  if(selected.request.kind!=='finalize-local')localInputFailure('Only native local finalization is registered.');
  const {root:canonical}=await requireIdleCompletionBoundary(selected.root),current=await readCompletedModernLocalExecution(canonical,selected.request.executionFingerprint),context=admissible(current);
  if((await readCompletionFile(canonical,nativeCompletionPath)).content!==undefined)localInputFailure('Existing native completion requires inspection or explicit reconciliation, not replacement.');
  const index=await captureCompletionInputs(current.inspection.installed.snapshot,current.inspection.local.status==='modern-observed'?current.inspection.local.snapshot:localInputFailure('Missing actual local source.'));
  const identity=index.physical.find(p=>p.path===canonical)?.identity;if(!identity)localInputFailure('Actual completion root identity missing.');
  const now=new Date(),createdAt=now.toISOString(),expiresAt=new Date(now.getTime()+localCompletionPolicy.approvalLifetimeMs).toISOString();
  const body={kind:'liftoff-local-finalization-preview' as const,schemaVersion:1 as const,operationKind:'finalize-local' as const,projectRoot:canonical,operationId:randomUUID(),createdAt,expiresAt,
    context,execution:completedExecutionBinding(current,identity),protectedSetDigest:completionDigest(index),protocol:'manual-native-v1' as const,policyDigest:completionDigest(localCompletionPolicy),
    prospectiveTargets:context.profile==='none'?['native-receipt']:['input-plan','baseline-plan','completion-plan','input-evidence','baseline-evidence','completion-evidence','state','native-receipt']};
  const source= context.workflow==='spec-kit'?{...body,schemaVersion:2 as const,context,protocol:'spec-kit-bootstrap-v1' as const,policyDigest:completionDigest(specKitCompletionPolicy),
    workflowInput:capturedSpecKit(current).input,prospectiveTargets:[...body.prospectiveTargets,'spec-kit-bootstrap-tasks']}:{...body,context};
  const preview=validateFinalizationPreview({...source,fingerprint:completionDigest(source)},now),store=finalizationStore(canonical);
  await store.write('preview',preview.fingerprint,preview);return preview;
}
export async function approveModernLocalFinalization(root:string,fingerprint:string,scopes:LocalFinalizationScopes):Promise<LocalFinalizationConsent>{
  ({root,fingerprint,scopes}=copyModernLocalData({root,fingerprint,scopes}));
  const {root:canonical}=await requireIdleCompletionBoundary(root),store=finalizationStore(canonical),p=await readFinalizationPreview(canonical,fingerprint,store);
  validateFinalizationPreview(p,new Date());if(p.schemaVersion===2)validateSpecKitFinalizationScopes(scopes);else validateFinalizationScopes(scopes);
  const prior=await store.read('consent',fingerprint);
  if(prior)return validateFinalizationConsent(prior.value as LocalFinalizationConsent,p,new Date());
  const body={kind:'liftoff-local-finalization-consent' as const,projectRoot:canonical,fingerprint,approvedAt:new Date().toISOString(),expiresAt:p.expiresAt};
  const value:LocalFinalizationConsent=p.schemaVersion===2?{...body,schemaVersion:2,scopes:validateSpecKitFinalizationScopes(scopes)}:{...body,schemaVersion:1,scopes:validateFinalizationScopes(scopes)};
  validateFinalizationConsent(value,p,new Date());await store.write('consent',fingerprint,value);return value;
}
export async function changeCompletionState(store:LocalFinalizationRecordStore,p:LocalFinalizationPreview,expectedDigest:string,state:LocalFinalizationState){
  const value=validateFinalizationState({...state,updatedAt:new Date().toISOString()},p);
  return store.compareExchangeState(p.fingerprint,expectedDigest,value);
}
function phasePlan(api:ModernActivationRecordContract,p:LocalFinalizationPreview,state:ModernActivationState,id:ModernPhaseId,createdAt:string,workflow?:SpecKitWorkflowOutcome):ModernSavedTransitionPlan{
  const node=api.graph.phases.find(phase=>phase.id===id)!;
  for(const dep of node.dependencies)if(!dep.anyOf.some(phase=>dep.accepts.includes(state.phases[phase].state as typeof dep.accepts[number])))localInputFailure('Native local phase dependency is not actually satisfied.');
  return api.createPlan({phaseId:id,createdAt,expiresAt:p.expiresAt,stateHash:completionDigest(state),baselineDigest:p.execution.baselineDigest,inputDigest:p.execution.observationDigest,
    transitionDigest:completionDigest({finalizationFingerprint:p.fingerprint,phaseId:id,execution:p.execution}),
    operations:[{adapter:'local-evidence',actionId:`governance.local.${id}`,mutationClass:'write-evidence',phaseId:id,inputs:{finalizationFingerprint:p.fingerprint,executionResultDigest:p.execution.resultDigest},
      destination:{type:'local',identity:p.projectRoot},remote:false,destructive:false},
      ...(workflow?.disposition==='changed'?[{adapter:'selected-spec-workflow' as const,actionId:'governance.local.finalize-spec-kit-tasks',mutationClass:'write-spec-kit-seed' as const,phaseId:id,
        inputs:{workflow},destination:{type:'local' as const,identity:specKitCompletionPolicy.taskPath.join('/'),pathParts:[...specKitCompletionPolicy.taskPath]},remote:false,destructive:false}]:[])],
    approval:{gateKind:node.approvalGate.kind,required:false,envelopeId:null,envelopeHash:null,evaluation:{phaseId:id,gateKind:node.approvalGate.kind,questionKind:null,approvalRequired:false,status:'not-required',envelopeId:null,envelopeHash:null,reasons:[],expansionReasons:[]}},
    rollbackPlan:{phaseId:id,strategy:node.rollback.kind,target:node.rollback.target,operations:[],retained:[],cleanupWarnings:[]},noSecrets:true,
    ...(workflow?{inputDigest:workflow.inputDigest,fileChanges:[{pathParts:[...specKitCompletionPolicy.taskPath],beforeHash:workflow.originalTaskHash,afterHash:workflow.targetTaskHash}]}:{})});
}
export async function finalizeModernLocalCompletion(root:string,fingerprint:string):Promise<LocalFinalizationResult>{
  ({root,fingerprint}=copyModernLocalData({root,fingerprint}));
  const {root:canonical}=await requireIdleCompletionBoundary(root),store=finalizationStore(canonical),p=await readFinalizationPreview(canonical,fingerprint,store);
  validateFinalizationPreview(p,new Date());
  const savedConsent=await store.read('consent',fingerprint);if(!savedConsent)localInputFailure('Explicit native finalization consent is missing.');
  const consent=validateFinalizationConsent(savedConsent.value as LocalFinalizationConsent,p,new Date()),startedAt=new Date().toISOString();
  let state:LocalFinalizationState={kind:'liftoff-local-finalization-state',schemaVersion:1,projectRoot:canonical,operationId:p.operationId,finalizationFingerprint:fingerprint,
    phase:'finalizing',startedAt,updatedAt:startedAt,ownerTokenDigest:completionDigest(randomBytes(32).toString('hex')),publicationFingerprint:null,candidateBinding:null,transactionDigest:null,
    commitObservation:null,readbackDigest:null,blockerCodes:[]};
  let stored=await store.compareExchangeState(fingerprint,null,state);
  try{
    const current=await readCompletedModernLocalExecution(canonical,p.execution.executionFingerprint);
    if(completionDigest(admissible(current))!==completionDigest(p.context))localInputFailure('Finalization profile/source changed.');
    await compareCompletedProvenance(p);
    const local=current.inspection.local;if(local.status!=='modern-observed')localInputFailure('Missing actual native inputs.');
    const index=await captureCompletionInputs(current.inspection.installed.snapshot,local.snapshot);
    if(completionDigest(index)!==p.protectedSetDigest)localInputFailure('Original protected inputs changed before finalization.');
    const produced:{pathParts:string[];content:Buffer;purpose:CompletionTarget['purpose']}[]=[];
    let workflow:SpecKitWorkflowOutcome|undefined,plannedTask:Buffer|undefined,originalTask:Buffer|undefined,actualTask:Buffer|undefined;
    if(p.schemaVersion===2){
      const sk=capturedSpecKit(current);
      if(completionDigest(sk.input)!==completionDigest(p.workflowInput))localInputFailure('Actual Spec Kit source differs from the reviewed workflow input.');
      originalTask=sk.task.content!;
      plannedTask=Buffer.from(completedSpecKitTasks(specKitText(sk.task)));
      const prepared=specKitInput(current.manifest,sk.files.map(file=>file===sk.task?{...file,content:plannedTask}:file));
      const original=artifact(p,'workflow-original',originalTask,[...specKitCompletionPolicy.taskPath],sk.task.mode!),originalTaskArtifactKey=completionDigest(original);
      await store.write('artifact',originalTaskArtifactKey,original);
      workflow={kind:'spec-kit-bootstrap-finalization',schemaVersion:1,inputDigest:completionDigest(p.workflowInput),originalTaskArtifactKey,originalTaskHash:sk.input.originalTaskHash,
        targetTaskHash:rawLocalDigest(plannedTask),taskMode:sk.task.mode!,disposition:plannedTask.equals(originalTask)?'already-finalized':'changed',
        taskPathParts:[...specKitCompletionPolicy.taskPath],completedTaskIds:[...specKitBootstrapTaskIds],executionCheckSetDigest:p.execution.checkSetDigest,
        afterInputDigest:preparedSpecKitInputDigest(sk.input,prepared)};
    }
    if(p.context.profile!=='none'){
      const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:current.manifest.project,framework:current.manifest.framework});
      const api=createModernActivationRecordContract(projectCatalog,{recordedIdentity:p.context.identity,profile:p.context.profile,policyVersion:p.context.identity.policyVersion,
        selection:{...leaf,profile:p.context.profile},
        pluginResolutionDigest:p.context.identity.pluginResolutionDigest,activeLayoutDigest:p.context.identity.activeLayoutDigest});
      const old=current.inspection.installed.current,refs:{plans:unknown[];evidence:unknown[];approvals:unknown[]}={plans:[...old?.records.plans??[]],evidence:[...old?.records.evidence??[]],approvals:[...old?.records.approvals??[]]};
      let activation=old?.state??api.createInitialState({repository:{id:`local:${randomUUID()}`,name:current.manifest.project.name,defaultBranch:'undiscovered'},
        applicability:{statePath:'none',privateStagingDast:'unknown',credentialRequired:'unknown'},createdAt:new Date().toISOString()});
      const inputPlan=phasePlan(api,p,activation,'local-inputs-valid',new Date().toISOString());
      const actual=await readCompletedModernLocalExecution(canonical,p.execution.executionFingerprint);
      if(completionDigest(actual.preview)!==p.execution.previewDigest)localInputFailure('Actual input phase changed after its plan was prepared.');
      const plans=[inputPlan,current.preview.selectedPlan!];
      let baselineEvidence:ReturnType<typeof api.createEvidence>|undefined;
      for(const [position,id]of (['local-inputs-valid','local-baseline-verified','local-complete'] as const).entries()){
        const node=api.graph.phases.find(phase=>phase.id===id)!;
        for(const dep of node.dependencies)if(!dep.anyOf.some(phase=>dep.accepts.includes(activation.phases[phase].state as typeof dep.accepts[number])))localInputFailure('Actual local evidence dependency is missing.');
        if(position===2){
          plans.push(phasePlan(api,p,activation,id,new Date().toISOString(),workflow));
          if(workflow){
            actualTask=Buffer.from(completedSpecKitTasks(originalTask!.toString('utf8')));
            if(!actualTask.equals(plannedTask!))localInputFailure('Spec Kit finalization differs from its prepared plan.');
          }
        }
        const plan=plans[position];refs.plans=[...refs.plans!.filter(item=>completionDigest(item)!==completionDigest(plan)),plan];
        const payload:Record<string,unknown>=position===0?{kind:'local-inputs-valid.v1',schemaVersion:1,workflow:p.context.workflow,execution:p.execution}:
          position===1?{kind:'local-baseline-verified.v1',schemaVersion:1,workflow:p.context.workflow,checks:current.result.checks,preparation:current.result.preparation,execution:p.execution}:
            {kind:'local-complete.v1',schemaVersion:1,workflow:p.context.workflow,frameworkValidation:workflow?'verified':'not-required',frameworkFinalization:workflow?'finalized':'not-required',
              baselineEvidenceId:baselineEvidence!.evidenceId,baselineHeaderDigest:completionDigest(baselineEvidence!.header),execution:p.execution,finalizationFingerprint:p.fingerprint,
              ...(workflow?{workflowOutcome:workflow}:{})};
        const evidence=api.createEvidence({plan,evidenceId:randomUUID(),repositoryId:activation.repository.id,producedAt:new Date().toISOString(),
          producer:'liftoff-native-local-finalization',result:'verified',payload,...(position===2&&workflow?{afterInputDigest:workflow.afterInputDigest}:{})},refs);
        refs.evidence=[...refs.evidence!,evidence];if(position===1)baselineEvidence=evidence;
        activation=api.stateAfterOutcome({state:activation,plan,phaseState:'verified',updatedAt:new Date().toISOString(),evidenceId:evidence.evidenceId},refs);
        produced.push({pathParts:['governance','plans',`${completionDigest(plan)}.json`],content:Buffer.from(api.encodeRecord({kind:'plan',record:plan},refs).content),
          purpose:position===0?'input-plan':position===1?'baseline-plan':'completion-plan'});
        produced.push({pathParts:['governance','evidence',`${evidence.evidenceId}.json`],content:Buffer.from(api.encodeRecord({kind:'evidence',record:evidence},refs).content),
          purpose:position===0?'input-evidence':position===1?'baseline-evidence':'completion-evidence'});
      }
      produced.push({pathParts:['governance','activation-state.json'],content:Buffer.from(api.encodeRecord({kind:'state',record:activation},refs).content),purpose:'state'});
    }
    if(workflow){
      actualTask??=Buffer.from(completedSpecKitTasks(originalTask!.toString('utf8')));
      if(!actualTask.equals(plannedTask!))localInputFailure('Actual Spec Kit checkbox bytes differ from the planned target.');
      if(workflow.disposition==='changed')produced.push({pathParts:[...specKitCompletionPolicy.taskPath],content:actualTask,purpose:'spec-kit-bootstrap-tasks'});
    }
    const completedAt=new Date().toISOString();
    const receiptBody={kind:'liftoff-native-local-completion' as const,projectRoot:canonical,operationId:p.operationId,finalizationFingerprint:p.fingerprint,
      execution:p.execution,finalizationConsentDigest:completionDigest(consent),completedAt,
      records:produced.map(item=>({pathParts:item.pathParts,rawDigest:rawLocalDigest(item.content),purpose:item.purpose}))};
    const receipt:NativeLocalCompletion=p.schemaVersion===2?{...receiptBody,schemaVersion:2,context:p.context,frameworkValidation:'verified',frameworkFinalization:'finalized',workflowInput:p.workflowInput,workflowOutcome:workflow!}:
      {...receiptBody,schemaVersion:1,context:p.context,frameworkValidation:'not-required',frameworkFinalization:'not-required'};
    produced.push({pathParts:[...nativeCompletionPath],content:Buffer.from(canonicalJson(receipt)),purpose:'native-receipt'});
    const targets:CompletionTarget[]=[],mutations:ProjectFileMutation[]=[];
    for(const target of produced){
      const original=await readCompletionFile(canonical,target.pathParts),mode=original.mode??0o600;
      if(target.purpose!=='state'&&target.purpose!=='spec-kit-bootstrap-tasks'&&original.content!==undefined&&!original.content.equals(target.content))localInputFailure('Native completion cannot replace original immutable records.');
      const value=artifact(p,'target',target.content,target.pathParts,mode),artifactKey=completionDigest(value);
      await store.write('artifact',artifactKey,value);
      targets.push({pathParts:target.pathParts,operation:'write',original:completionSnapshot(original),target:{exists:true,rawDigest:value.rawDigest,bytes:value.bytes,mode},artifactKey,purpose:target.purpose});
      mutations.push({type:'write',pathParts:target.pathParts,content:target.content,mode});
    }
    const indexArtifact=artifact(p,'protected-index',Buffer.from(canonicalJson(index)),null,null),protectedIndexKey=completionDigest(indexArtifact);
    await store.write('artifact',protectedIndexKey,indexArtifact);
    const preconditions=await completionPreconditions(index,targets),candidate=await inspectLocalVerificationCandidate(canonical,mutations,preconditions);
    validateFinalizationPreview(p,new Date());await compareCompletedProvenance(p);
    const reviewCreatedAt=new Date().toISOString(),core={kind:'liftoff-local-finalization-result' as const,schemaVersion:1 as const,projectRoot:canonical,operationId:p.operationId,fingerprint,
      consentDigest:completionDigest(consent),execution:p.execution,startedAt,completedAt,protectedIndexKey,protectedSetDigest:p.protectedSetDigest,targets,targetSetDigest:completionDigest(targets),
      candidateBinding:candidate.binding,candidateSize:candidate.size,reviewCreatedAt,reviewExpiresAt:new Date(Date.parse(reviewCreatedAt)+localCompletionPolicy.approvalLifetimeMs).toISOString()};
    const resultCore=workflow?{...core,schemaVersion:2 as const,workflowOutcome:workflow}:core;
    const body={...resultCore,publicationFingerprint:publicationFingerprint(resultCore)},result=validateFinalizationResult({...body,resultDigest:completionDigest(body)},p);
    await store.write('result',fingerprint,result);await store.write('result',result.publicationFingerprint,result);
    if(p.schemaVersion===2)await validateSpecKitFinalization(await loadFinalizationResult(canonical,fingerprint,store),'original');
    state={...state,phase:'awaiting-publication',publicationFingerprint:result.publicationFingerprint,candidateBinding:result.candidateBinding};
    stored=await changeCompletionState(store,p,stored.digest,state);return result;
  }catch(error){
    state={...state,phase:'blocked',blockerCodes:['finalization-failed']};
    await changeCompletionState(store,p,stored.digest,state);throw error;
  }
}
