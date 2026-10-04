import path from 'node:path';
import {canonicalSha256,canonicalJson} from './canonical-json.js';
import {copyModernLocalData,localInputFailure,rawLocalDigest} from './modern-local-inputs.js';
import {exactRecord} from '../../project/manifest/fields.js';
import {validateManifestPathParts} from '../../project/manifest/layout.js';
import type {ReadableModernActivationIdentity} from './modern-record-contracts.js';
import type {LocalExecutionPreview,LocalExecutionConsent,LocalExecutionState,LocalExecutionResult} from './modern-local-runtime.js';
import {specKitBootstrapId,specKitBootstrapPath,specKitBootstrapTaskIds} from './local-check-values.js';

export const nativeCompletionPath=['.liftoff','local-completion.json'] as const;
export const localCompletionPolicy=Object.freeze({kind:'liftoff-local-completion-policy',schemaVersion:1,
  workflow:'manual',protocol:'manual-native-v1',recordBytes:65536,artifacts:12,mutations:12,approvalLifetimeMs:900000,
  execution:'historical-complete-only',publication:'second-exact-byte-consent',recovery:'explicit-attributed-transaction-only'});
export const specKitCompletionPolicy=Object.freeze({...localCompletionPolicy,workflow:'spec-kit',protocol:'spec-kit-bootstrap-v1',
  taskPath:Object.freeze([...specKitBootstrapPath,'tasks.md']),taskIds:specKitBootstrapTaskIds,transformation:'existing-B001-B006-checkbox-characters-only'});
export interface CompletedLocalExecutionBinding {
  projectRoot:string;rootIdentity:string;operationId:string;executionFingerprint:string;previewDigest:string;consentDigest:string;
  stateDigest:string;resultDigest:string;installedBinding:string;observationDigest:string;physicalDigest:string;baselineDigest:string;
  recipeDigest:string;policyDigest:string;toolSetDigest:string;preparationDigest:string;outputRolesDigest:string;checkSetDigest:string;
  selectedPlanDigest:string|null;startedAt:string;completedAt:string;
}
export type ManualCompletionContext=
  |{profile:'none';workflow:'manual';selectionDigest:string;pluginResolutionDigest:string;activeLayoutDigest:string;identity:null}
  |{profile:'single-maintainer-gitflow'|'team-gitflow';workflow:'manual';identity:ReadableModernActivationIdentity};
export type SpecKitCompletionContext=
  |{profile:'none';workflow:'spec-kit';selectionDigest:string;pluginResolutionDigest:string;activeLayoutDigest:string;identity:null}
  |{profile:'single-maintainer-gitflow'|'team-gitflow';workflow:'spec-kit';identity:ReadableModernActivationIdentity};
export type LocalCompletionContext=ManualCompletionContext|SpecKitCompletionContext;
export interface SpecKitWorkflowInput {
  kind:'spec-kit-bootstrap-inputs';schemaVersion:1;bootstrapId:'000-liftoff-bootstrap';
  taskPathParts:readonly string[];originalTaskHash:string;originalTaskBytes:number;originalTaskMode:number;
  bundleDigest:string;markerSetDigest:string;taskProtocolDigest:string;
}
export interface SpecKitWorkflowOutcome {
  kind:'spec-kit-bootstrap-finalization';schemaVersion:1;inputDigest:string;originalTaskArtifactKey:string;
  originalTaskHash:string;targetTaskHash:string;taskMode:number;disposition:'changed'|'already-finalized';
  taskPathParts:readonly string[];completedTaskIds:readonly string[];executionCheckSetDigest:string;
  afterInputDigest:string;
}
export interface ManualFinalizationPreview {
  kind:'liftoff-local-finalization-preview';schemaVersion:1;operationKind:'finalize-local';projectRoot:string;operationId:string;
  createdAt:string;expiresAt:string;fingerprint:string;context:ManualCompletionContext;execution:CompletedLocalExecutionBinding;
  protectedSetDigest:string;protocol:'manual-native-v1';policyDigest:string;prospectiveTargets:readonly string[];
}
export interface SpecKitFinalizationPreview extends Omit<ManualFinalizationPreview,'schemaVersion'|'context'|'protocol'> {
  schemaVersion:2;context:SpecKitCompletionContext;protocol:'spec-kit-bootstrap-v1';workflowInput:SpecKitWorkflowInput;
}
export type LocalFinalizationPreview=ManualFinalizationPreview|SpecKitFinalizationPreview;
export interface ManualFinalizationScopes {
  finalizeLocal:true;workflowWrites:false;projectCode:false;dependencyPreparation:false;dependencyNetwork:false;publishLocalRecords:false;
}
export type SpecKitFinalizationScopes=Omit<ManualFinalizationScopes,'workflowWrites'>&{workflowWrites:true};
export type LocalFinalizationScopes=ManualFinalizationScopes|SpecKitFinalizationScopes;
export interface ManualFinalizationConsent {
  kind:'liftoff-local-finalization-consent';schemaVersion:1;projectRoot:string;fingerprint:string;approvedAt:string;expiresAt:string;scopes:ManualFinalizationScopes;
}
export type LocalFinalizationConsent=ManualFinalizationConsent|(Omit<ManualFinalizationConsent,'schemaVersion'|'scopes'>&{schemaVersion:2;scopes:SpecKitFinalizationScopes});
export interface CompletionSnapshot {exists:boolean;rawDigest:string|null;bytes:number;mode:number|null}
export interface CompletionFile extends CompletionSnapshot {pathParts:string[]}
export interface CompletionDirectory {
  pathParts:string[];exists:boolean;mode:number|null;entries:{name:string;kind:'file'|'directory'|'symlink'|'other'}[];
}
export interface CompletionProtectedIndex {
  kind:'liftoff-local-protected-index';schemaVersion:1;projectRoot:string;
  files:CompletionFile[];directories:CompletionDirectory[];physical:{path:string;identity:string|null}[];
}
export interface CompletionTarget {
  pathParts:string[];operation:'write';original:CompletionSnapshot;target:CompletionSnapshot;artifactKey:string;
  purpose:'input-plan'|'baseline-plan'|'completion-plan'|'input-evidence'|'baseline-evidence'|'completion-evidence'|'state'|'native-receipt'|'spec-kit-bootstrap-tasks';
}
export interface CompletionArtifactV1 {
  kind:'liftoff-local-finalization-artifact';schemaVersion:1;projectRoot:string;operationId:string;finalizationFingerprint:string;
  role:'target'|'protected-index';pathParts:string[]|null;contentBase64:string;bytes:number;rawDigest:string;mode:number|null;
}
export type LocalFinalizationArtifact=CompletionArtifactV1|(Omit<CompletionArtifactV1,'schemaVersion'|'role'>&{schemaVersion:2;role:'workflow-original'});
export interface ManualFinalizationResult {
  kind:'liftoff-local-finalization-result';schemaVersion:1;projectRoot:string;operationId:string;fingerprint:string;consentDigest:string;
  execution:CompletedLocalExecutionBinding;startedAt:string;completedAt:string;protectedIndexKey:string;protectedSetDigest:string;
  targets:CompletionTarget[];targetSetDigest:string;candidateBinding:string;candidateSize:{
    kind:'journal'|'no-journal';mutationCount:number;suppliedPreconditionCount:number;snapshotBytes:number;
    headerBytes:number;mutationFrameBytes:number;commitFrameBytes:number;completeJournalBytes:number;
  };
  reviewCreatedAt:string;reviewExpiresAt:string;publicationFingerprint:string;resultDigest:string;
}
export interface SpecKitFinalizationResult extends Omit<ManualFinalizationResult,'schemaVersion'> {schemaVersion:2;workflowOutcome:SpecKitWorkflowOutcome}
export type LocalFinalizationResult=ManualFinalizationResult|SpecKitFinalizationResult;
export type FinalizationResultCore=Omit<ManualFinalizationResult,'publicationFingerprint'|'resultDigest'>|Omit<SpecKitFinalizationResult,'publicationFingerprint'|'resultDigest'>;
export interface LocalPublicationConsent {
  kind:'liftoff-local-publication-consent';schemaVersion:1;projectRoot:string;finalizationFingerprint:string;finalizationResultDigest:string;
  executionConsentDigest:string;executionResultDigest:string;publicationFingerprint:string;candidateBinding:string;targetSetDigest:string;
  approvedAt:string;expiresAt:string;publishExactLocalBytes:true;
}
export interface LocalFinalizationState {
  kind:'liftoff-local-finalization-state';schemaVersion:1;projectRoot:string;operationId:string;finalizationFingerprint:string;
  phase:'finalizing'|'awaiting-publication'|'publishing'|'committed-readback-pending'|'complete'|'blocked'|'uncertain'|'rolled-back';
  startedAt:string;updatedAt:string;ownerTokenDigest:string;publicationFingerprint:string|null;candidateBinding:string|null;transactionDigest:string|null;
  commitObservation:{publicationFingerprint:string;transactionDigest:string;observedAt:string;source:'local-verification-inspector';committed:true}|null;
  readbackDigest:string|null;blockerCodes:string[];
}
export interface ManualLocalCompletion {
  kind:'liftoff-native-local-completion';schemaVersion:1;projectRoot:string;operationId:string;finalizationFingerprint:string;
  context:ManualCompletionContext;execution:CompletedLocalExecutionBinding;finalizationConsentDigest:string;completedAt:string;
  frameworkValidation:'not-required';frameworkFinalization:'not-required';
  records:{pathParts:string[];rawDigest:string;purpose:CompletionTarget['purpose']}[];
}
export type NativeLocalCompletion=ManualLocalCompletion|(Omit<ManualLocalCompletion,'schemaVersion'|'context'|'frameworkValidation'|'frameworkFinalization'>&{
  schemaVersion:2;context:SpecKitCompletionContext;frameworkValidation:'verified';frameworkFinalization:'finalized';workflowInput:SpecKitWorkflowInput;workflowOutcome:SpecKitWorkflowOutcome;
});
export function completionRecord<T>(input:T,keys:readonly string[],label:string):T{
  const value=copyModernLocalData(input);exactRecord(value,keys,label);
  if(Buffer.byteLength(canonicalJson(value))>localCompletionPolicy.recordBytes)localInputFailure(`${label} exceeds64KiB.`);
  return value;
}
export function completionDigest(value:unknown):string{return canonicalSha256(value);}
export function completionTime(value:string):number{
  const time=Date.parse(value);if(!Number.isFinite(time)||new Date(time).toISOString()!==value)localInputFailure('Invalid completion timestamp.');return time;
}
export function completionHash(value:unknown):asserts value is string{
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))localInputFailure('Completion requires a complete SHA256 digest.');
}
export function completionRoot(value:string):void{
  if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value)localInputFailure('Completion requires canonical root attribution.');
}
function issued(createdAt:string,expiresAt:string,now:Date):void{
  const created=completionTime(createdAt),expires=completionTime(expiresAt);
  if(!Number.isFinite(now.getTime())||created>now.getTime()||expires<=now.getTime()||expires<=created||expires-created>localCompletionPolicy.approvalLifetimeMs)localInputFailure('Completion approval is expired or has invalid issuance.');
}
export function completedExecutionBinding(records:{preview:LocalExecutionPreview;consent:LocalExecutionConsent;state:LocalExecutionState;result:LocalExecutionResult},rootIdentity:string):CompletedLocalExecutionBinding{
  const {preview:p,consent,state,result:r}=records;
  return {projectRoot:p.projectRoot,rootIdentity,operationId:p.operationId,executionFingerprint:p.fingerprint,previewDigest:completionDigest(p),
    consentDigest:completionDigest(consent),stateDigest:completionDigest(state),resultDigest:r.resultDigest,installedBinding:p.installedBinding,
    observationDigest:p.observationDigest,physicalDigest:p.physicalDigest,baselineDigest:p.baselineDigest,recipeDigest:p.recipeDigest,policyDigest:p.policyDigest,
    toolSetDigest:completionDigest(p.tools),preparationDigest:p.preparationDigest,outputRolesDigest:completionDigest(p.outputRoles),checkSetDigest:completionDigest(p.checks),
    selectedPlanDigest:p.selectedPlanDigest,startedAt:r.startedAt,completedAt:r.completedAt};
}
export function validateCompletedBinding(value:CompletedLocalExecutionBinding):void{
  exactRecord(value,['projectRoot','rootIdentity','operationId','executionFingerprint','previewDigest','consentDigest','stateDigest','resultDigest','installedBinding','observationDigest',
    'physicalDigest','baselineDigest','recipeDigest','policyDigest','toolSetDigest','preparationDigest','outputRolesDigest','checkSetDigest','selectedPlanDigest','startedAt','completedAt'],'Completed execution binding');
  completionRoot(value.projectRoot);
  if(typeof value.rootIdentity!=='string'||!/^\d+(?::\d+){7}$/u.test(value.rootIdentity)||!/^[-a-f0-9]{36}$/u.test(value.operationId))localInputFailure('Invalid completed root/operation.');
  for(const [key,digest]of Object.entries(value))if(key.endsWith('Digest')||key.endsWith('Binding')||key.endsWith('Fingerprint'))if(digest!==null)completionHash(digest);
  if(completionTime(value.completedAt)<completionTime(value.startedAt))localInputFailure('Invalid completed execution chronology.');
}
export function validateFinalizationPreview(input:LocalFinalizationPreview,now:Date):LocalFinalizationPreview{
  input=copyModernLocalData(input);
  const p=completionRecord(input,['kind','schemaVersion','operationKind','projectRoot','operationId','createdAt','expiresAt','fingerprint','context','execution','protectedSetDigest','protocol','policyDigest','prospectiveTargets',
    ...(input.schemaVersion===2?['workflowInput']:[])],'Finalization preview');
  const specKit=p.schemaVersion===2;
  if(p.kind!=='liftoff-local-finalization-preview'||![1,2].includes(p.schemaVersion)||p.operationKind!=='finalize-local'||p.protocol!==(specKit?'spec-kit-bootstrap-v1':'manual-native-v1')||
    p.policyDigest!==completionDigest(specKit?specKitCompletionPolicy:localCompletionPolicy)||p.context.workflow!==(specKit?'spec-kit':'manual')||!['none','single-maintainer-gitflow','team-gitflow'].includes(p.context.profile)||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(p.operationId))localInputFailure('Invalid native finalization identity.');
  completionRoot(p.projectRoot);issued(p.createdAt,p.expiresAt,now);validateCompletedBinding(p.execution);completionHash(p.protectedSetDigest);
  if(p.execution.projectRoot!==p.projectRoot||completionTime(p.execution.completedAt)>completionTime(p.createdAt))localInputFailure('Finalization precedes its completed execution.');
  const {fingerprint,...body}=p;if(fingerprint!==completionDigest(body))localInputFailure('Finalization fingerprint mismatch.');
  if(p.context.profile==='none'){
    exactRecord(p.context,['profile','workflow','selectionDigest','pluginResolutionDigest','activeLayoutDigest','identity'],'None completion context');
    if(p.context.identity!==null||p.execution.selectedPlanDigest!==null)localInputFailure('None cannot acquire activation identity or plan.');
  }else{
    exactRecord(p.context,['profile','workflow','identity'],'Governed completion context');
    if(p.context.identity.profile!==p.context.profile||p.context.identity.workflow!==(specKit?'spec-kit':'manual')||p.execution.selectedPlanDigest===null)localInputFailure('Governed completion identity/plan mismatch.');
  }
  if(p.schemaVersion===2)validateSpecKitWorkflowInput(p.workflowInput);
  if(!Array.isArray(p.prospectiveTargets)||p.prospectiveTargets.length>localCompletionPolicy.mutations||p.prospectiveTargets.some(item=>typeof item!=='string'))localInputFailure('Invalid prospective completion roles.');
  return p;
}
export function validateFinalizationScopes(input:unknown):ManualFinalizationScopes{
  const keys=['finalizeLocal','workflowWrites','projectCode','dependencyPreparation','dependencyNetwork','publishLocalRecords'];
  const value=exactRecord(completionRecord(input,keys,'Finalization scopes'),keys,'Finalization scopes');
  if(value.finalizeLocal!==true||value.workflowWrites!==false||Object.entries(value).some(([key,v])=>key!=='finalizeLocal'&&v!==false))localInputFailure('Native finalization requires explicit limited consent; no code/workflow/publication permission.');
  return {finalizeLocal:true,workflowWrites:false,projectCode:false,dependencyPreparation:false,dependencyNetwork:false,publishLocalRecords:false};
}
export function validateSpecKitFinalizationScopes(input:unknown):SpecKitFinalizationScopes{
  const keys=['finalizeLocal','workflowWrites','projectCode','dependencyPreparation','dependencyNetwork','publishLocalRecords'];
  const value=exactRecord(completionRecord(input,keys,'Spec Kit finalization scopes'),keys,'Spec Kit finalization scopes');
  if(value.finalizeLocal!==true||value.workflowWrites!==true||Object.entries(value).some(([key,v])=>!['finalizeLocal','workflowWrites'].includes(key)&&v!==false))localInputFailure('Spec Kit requires affirmative fixed bootstrap workflow consent, not code/install/publication authority.');
  return {finalizeLocal:true,workflowWrites:true,projectCode:false,dependencyPreparation:false,dependencyNetwork:false,publishLocalRecords:false};
}
export function validateFinalizationConsent(input:LocalFinalizationConsent,p:LocalFinalizationPreview,now:Date):LocalFinalizationConsent{
  const value=completionRecord(input,['kind','schemaVersion','projectRoot','fingerprint','approvedAt','expiresAt','scopes'],'Finalization consent');
  if(value.kind!=='liftoff-local-finalization-consent'||value.schemaVersion!==p.schemaVersion||value.projectRoot!==p.projectRoot||value.fingerprint!==p.fingerprint||value.expiresAt!==p.expiresAt||
    completionTime(value.approvedAt)<completionTime(p.createdAt))localInputFailure('Finalization consent identity mismatch.');
  issued(value.approvedAt,value.expiresAt,now);
  if(p.schemaVersion===2)validateSpecKitFinalizationScopes(value.scopes);else validateFinalizationScopes(value.scopes);return value;
}
export function snapshotControl(input:CompletionSnapshot):void{
  exactRecord(input,['exists','rawDigest','bytes','mode'],'Completion snapshot');
  if(typeof input.exists!=='boolean'||!Number.isSafeInteger(input.bytes)||input.bytes<0||
    (input.exists?input.mode===null||!Number.isInteger(input.mode)||input.mode<0||input.mode>0o777:input.mode!==null||input.rawDigest!==null||input.bytes!==0))localInputFailure('Invalid completion snapshot.');
  if(input.exists)completionHash(input.rawDigest);
}
export function artifactBytes(input:LocalFinalizationArtifact,p:LocalFinalizationPreview):Buffer{
  const value=completionRecord(input,['kind','schemaVersion','projectRoot','operationId','finalizationFingerprint','role','pathParts','contentBase64','bytes','rawDigest','mode'],'Completion artifact');
  const workflowOriginal=value.schemaVersion===2&&value.role==='workflow-original'&&p.schemaVersion===2;
  if(value.kind!=='liftoff-local-finalization-artifact'||!(workflowOriginal||value.schemaVersion===1&&['target','protected-index'].includes(value.role))||
    value.projectRoot!==p.projectRoot||value.operationId!==p.operationId||value.finalizationFingerprint!==p.fingerprint||typeof value.contentBase64!=='string')localInputFailure('Completion artifact attribution mismatch.');
  const bytes=Buffer.from(value.contentBase64,'base64');
  if(bytes.toString('base64')!==value.contentBase64||bytes.length!==value.bytes||rawLocalDigest(bytes)!==value.rawDigest)localInputFailure('Completion artifact bytes mismatch.');
  if(value.role==='target'||workflowOriginal){validateManifestPathParts(value.pathParts,'Completion target');snapshotControl({exists:true,rawDigest:value.rawDigest,bytes:value.bytes,mode:value.mode});
    if(workflowOriginal&&(completionDigest(value.pathParts)!==completionDigest(specKitCompletionPolicy.taskPath)||p.schemaVersion!==2||
      value.rawDigest!==p.workflowInput.originalTaskHash||value.bytes!==p.workflowInput.originalTaskBytes||value.mode!==p.workflowInput.originalTaskMode))localInputFailure('Original task artifact differs from the approved Spec Kit input.');
  }
  else if(value.pathParts!==null||value.mode!==null)localInputFailure('Protected index cannot claim a target path.');
  return bytes;
}
export function publicationFingerprint(input:FinalizationResultCore):string{
  return completionDigest({kind:'liftoff-local-publication-review',schemaVersion:1,core:input,policyDigest:completionDigest(input.schemaVersion===2?specKitCompletionPolicy:localCompletionPolicy)});
}
export function validateFinalizationResult(input:LocalFinalizationResult,p:LocalFinalizationPreview):LocalFinalizationResult{
  input=copyModernLocalData(input);
  const value=completionRecord(input,['kind','schemaVersion','projectRoot','operationId','fingerprint','consentDigest','execution','startedAt','completedAt','protectedIndexKey','protectedSetDigest',
    'targets','targetSetDigest','candidateBinding','candidateSize','reviewCreatedAt','reviewExpiresAt','publicationFingerprint','resultDigest',...(input.schemaVersion===2?['workflowOutcome']:[])],'Finalization result');
  if(value.kind!=='liftoff-local-finalization-result'||value.schemaVersion!==p.schemaVersion||value.projectRoot!==p.projectRoot||value.operationId!==p.operationId||value.fingerprint!==p.fingerprint||
    completionDigest(value.execution)!==completionDigest(p.execution)||value.protectedSetDigest!==p.protectedSetDigest) localInputFailure('Finalization result attribution mismatch.');
  for(const digest of [value.consentDigest,value.protectedIndexKey,value.candidateBinding])completionHash(digest);
  exactRecord(value.candidateSize,['kind','mutationCount','suppliedPreconditionCount','snapshotBytes','headerBytes','mutationFrameBytes','commitFrameBytes','completeJournalBytes'],'Publication candidate size');
  if(value.candidateSize.kind!=='journal'||Object.entries(value.candidateSize).some(([key,v])=>key!=='kind'&&(!Number.isSafeInteger(v)||Number(v)<0))||
    value.candidateSize.mutationCount!==value.targets.length)localInputFailure('Publication candidate measurement is incomplete.');
  if(completionTime(value.startedAt)<completionTime(p.createdAt)||completionTime(value.completedAt)<completionTime(value.startedAt)||
    completionTime(value.completedAt)>completionTime(p.expiresAt)||completionTime(value.reviewCreatedAt)<completionTime(value.completedAt))localInputFailure('Finalization chronology differs from its admitted operation.');
  issued(value.reviewCreatedAt,value.reviewExpiresAt,new Date(value.reviewCreatedAt));
  if(!Array.isArray(value.targets)||!value.targets.length||value.targets.length>localCompletionPolicy.mutations||
    new Set(value.targets.map(t=>t.pathParts.join('/').normalize('NFC').toLowerCase())).size!==value.targets.length)localInputFailure('Completion requires a finite unique exact target set.');
  const purposes=p.context.profile==='none'?['native-receipt']:['input-plan','baseline-plan','completion-plan','input-evidence','baseline-evidence','completion-evidence','state','native-receipt'];
  if(value.schemaVersion===2){
    if(p.schemaVersion!==2)localInputFailure('Spec Kit result requires its original Spec Kit preview.');
    validateSpecKitWorkflowOutcome(value.workflowOutcome,p);
    if(value.workflowOutcome.disposition==='changed')purposes.push('spec-kit-bootstrap-tasks');
  }
  if(completionDigest(value.targets.map(t=>t.purpose).sort())!==completionDigest(purposes.sort()))localInputFailure('Completion target set omits or invents a required producer.');
  for(const t of value.targets){
    exactRecord(t,['pathParts','operation','original','target','artifactKey','purpose'],'Completion target');validateManifestPathParts(t.pathParts,'Completion target');
    snapshotControl(t.original);snapshotControl(t.target);completionHash(t.artifactKey);
    const key=t.pathParts.join('/');
    if(t.operation!=='write'||!t.target.exists||t.purpose==='native-receipt'&&key!==nativeCompletionPath.join('/')||
      t.purpose==='state'&&key!=='governance/activation-state.json'||
      t.purpose.endsWith('-plan')&&!(t.pathParts.length===3&&t.pathParts[0]==='governance'&&t.pathParts[1]==='plans'&&/^[a-f0-9]{64}\.json$/u.test(t.pathParts[2]))||
      t.purpose.endsWith('-evidence')&&!(t.pathParts.length===3&&t.pathParts[0]==='governance'&&t.pathParts[1]==='evidence'&&/^[-a-f0-9]{36}\.json$/u.test(t.pathParts[2])))localInputFailure('Completion target is outside its exact producer scope.');
    if(t.purpose==='spec-kit-bootstrap-tasks'&&(value.schemaVersion!==2||p.schemaVersion!==2||key!==specKitCompletionPolicy.taskPath.join('/')||
      t.original.rawDigest!==p.workflowInput.originalTaskHash||t.original.bytes!==p.workflowInput.originalTaskBytes||
      t.original.mode!==p.workflowInput.originalTaskMode||t.target.mode!==p.workflowInput.originalTaskMode||t.target.rawDigest!==value.workflowOutcome.targetTaskHash))localInputFailure('Spec Kit task target differs from its exact original/output commitment.');
  }
  const {resultDigest,publicationFingerprint:fp,...core}=value;
  if(value.targetSetDigest!==completionDigest(value.targets)||fp!==publicationFingerprint(core)||resultDigest!==completionDigest({...core,publicationFingerprint:fp}))localInputFailure('Completion review/target/result commitment mismatch.');
  return value;
}
export function validateSpecKitWorkflowInput(value:SpecKitWorkflowInput):void{
  exactRecord(value,['kind','schemaVersion','bootstrapId','taskPathParts','originalTaskHash','originalTaskBytes','originalTaskMode','bundleDigest','markerSetDigest','taskProtocolDigest'],'Spec Kit workflow input');
  if(value.kind!=='spec-kit-bootstrap-inputs'||value.schemaVersion!==1||value.bootstrapId!==specKitBootstrapId||
    completionDigest(value.taskPathParts)!==completionDigest(specKitCompletionPolicy.taskPath)||value.taskProtocolDigest!==completionDigest(specKitCompletionPolicy))localInputFailure('Unsupported Spec Kit bootstrap protocol.');
  snapshotControl({exists:true,rawDigest:value.originalTaskHash,bytes:value.originalTaskBytes,mode:value.originalTaskMode});
  for(const digest of [value.bundleDigest,value.markerSetDigest])completionHash(digest);
}
export function validateSpecKitWorkflowOutcome(value:SpecKitWorkflowOutcome,p:SpecKitFinalizationPreview):void{
  exactRecord(value,['kind','schemaVersion','inputDigest','originalTaskArtifactKey','originalTaskHash','targetTaskHash','taskMode','disposition','taskPathParts','completedTaskIds','executionCheckSetDigest','afterInputDigest'],'Spec Kit workflow outcome');
  if(value.kind!=='spec-kit-bootstrap-finalization'||value.schemaVersion!==1||value.inputDigest!==completionDigest(p.workflowInput)||
    value.originalTaskHash!==p.workflowInput.originalTaskHash||value.taskMode!==p.workflowInput.originalTaskMode||
    completionDigest(value.taskPathParts)!==completionDigest(specKitCompletionPolicy.taskPath)||completionDigest(value.completedTaskIds)!==completionDigest(specKitBootstrapTaskIds)||
    value.executionCheckSetDigest!==p.execution.checkSetDigest||value.disposition!==(value.originalTaskHash===value.targetTaskHash?'already-finalized':'changed'))localInputFailure('Spec Kit outcome does not describe its actual complete input contract.');
  for(const digest of [value.originalTaskArtifactKey,value.targetTaskHash,value.afterInputDigest])completionHash(digest);
}
export function validatePublicationConsent(input:LocalPublicationConsent,r:LocalFinalizationResult,now:Date):LocalPublicationConsent{
  const v=completionRecord(input,['kind','schemaVersion','projectRoot','finalizationFingerprint','finalizationResultDigest','executionConsentDigest','executionResultDigest','publicationFingerprint','candidateBinding','targetSetDigest','approvedAt','expiresAt','publishExactLocalBytes'],'Publication consent');
  if(v.kind!=='liftoff-local-publication-consent'||v.schemaVersion!==1||v.projectRoot!==r.projectRoot||v.finalizationFingerprint!==r.fingerprint||v.finalizationResultDigest!==r.resultDigest||
    v.executionConsentDigest!==r.execution.consentDigest||v.executionResultDigest!==r.execution.resultDigest||v.publicationFingerprint!==r.publicationFingerprint||v.candidateBinding!==r.candidateBinding||
    v.targetSetDigest!==r.targetSetDigest||v.publishExactLocalBytes!==true||v.expiresAt!==r.reviewExpiresAt||completionTime(v.approvedAt)<completionTime(r.reviewCreatedAt))localInputFailure('Publication lacks its exact second observed-byte consent.');
  issued(v.approvedAt,v.expiresAt,now);return v;
}
export function validateFinalizationState(input:LocalFinalizationState,p:LocalFinalizationPreview):LocalFinalizationState{
  const v=completionRecord(input,['kind','schemaVersion','projectRoot','operationId','finalizationFingerprint','phase','startedAt','updatedAt','ownerTokenDigest','publicationFingerprint','candidateBinding','transactionDigest','commitObservation','readbackDigest','blockerCodes'],'Finalization progress');
  if(v.kind!=='liftoff-local-finalization-state'||v.schemaVersion!==1||v.projectRoot!==p.projectRoot||v.operationId!==p.operationId||v.finalizationFingerprint!==p.fingerprint||
    !['finalizing','awaiting-publication','publishing','committed-readback-pending','complete','blocked','uncertain','rolled-back'].includes(v.phase)||
    completionTime(v.startedAt)<completionTime(p.createdAt)||completionTime(v.updatedAt)<completionTime(v.startedAt))localInputFailure('Invalid finalization progress attribution.');
  completionHash(v.ownerTokenDigest);
  for(const digest of [v.publicationFingerprint,v.candidateBinding,v.transactionDigest,v.readbackDigest])if(digest!==null)completionHash(digest);
  if(!Array.isArray(v.blockerCodes)||v.blockerCodes.some(code=>!['finalization-failed','publication-interrupted','readback-failed','cleanup-pending','rolled-back'].includes(code)))localInputFailure('Progress diagnostics require generated codes.');
  if(v.commitObservation){
    exactRecord(v.commitObservation,['publicationFingerprint','transactionDigest','observedAt','source','committed'],'Observed commit');
    if(v.commitObservation.source!=='local-verification-inspector'||v.commitObservation.committed!==true||v.commitObservation.publicationFingerprint!==v.publicationFingerprint||
      v.commitObservation.transactionDigest!==v.transactionDigest||completionTime(v.commitObservation.observedAt)>completionTime(v.updatedAt)||
      !['committed-readback-pending','complete'].includes(v.phase))localInputFailure('Invalid observed commit attribution.');
  }
  if(['committed-readback-pending','complete'].includes(v.phase)&&!v.commitObservation||v.phase==='complete'&&!v.readbackDigest)localInputFailure('Completion requires observed commit and independent readback.');
  return v;
}
