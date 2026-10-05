import {randomUUID} from 'node:crypto';
import {realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {types} from 'node:util';
import {createLocalExecutionRecordStore,createLocalVerificationTransactionAuthorityStore,type LocalExecutionRecordStore} from '../../adapters/filesystem/update-previews.js';
import {inspectLocalVerificationTransaction} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {copyModernLocalData,localInputFailure,capturedFileBytes} from '../../domain/governance/activation/modern-local-inputs.js';
import {canonicalSha256,canonicalJson} from '../../domain/governance/activation/canonical-json.js';
import {exactRecord} from '../../domain/project/manifest/fields.js';
import {localExecutionPolicy,localExecutionDigest,validateLocalExecutionPreview,validateLocalExecutionScopes,validateLocalExecutionResult,validateLocalExecutionState,validateLocalExecutionConsentRecord,
  openSpecExecutionPolicy,openSpecReadOnlyExecutionPolicy,openSpecInitializedExecutionPolicy,openSpecArchivedExecutionPolicy,openSpecExecutionAdmission,assertExecutableLocalExecutionPreview,hasOpenSpecExecutionIdentity,
  manualNativeExecutionPolicy,validateManualNativeExecutionScopes,
  type ManualNativeExecutionScopes,type LocalExecutionPreview,type LocalExecutionScopes,type LocalExecutionConsent,type LocalExecutionState,type LocalExecutionResult,type LocalExecutionTool} from '../../domain/governance/activation/modern-local-runtime.js';
import {inspectModernLocalRuntime,inspectModernOpenSpecRuntime,inspectModernArchivedOpenSpecRuntime,planModernLocalRuntime,planManualNativeLocalRuntime} from './modern-local-inputs.js';
import {deriveCompleteOpenSpecInputs,deriveArchivedOpenSpecInputs,deriveOpenSpecInitialization} from './modern-openspec-inputs.js';
import {openSpecInitializationPolicy,validateBootstrapScopeAttestation,type BootstrapScopeAttestation} from '../../domain/governance/activation/modern-openspec-obligations.js';
import {openSpecExecutionChecks,openSpecReadSetPolicy,archivedOpenSpecExecutionChecks,openSpecArchivedReadSetPolicy} from '../../domain/governance/activation/modern-openspec-execution.js';
import {observeModernLocalTools,assertModernLocalToolsCurrent} from '../../adapters/process/modern-local-tools.js';
import {parseApplicationPreparation,resolveCapturedApplicationPreparationInputs} from '../repair/application-preparation-inputs.js';
import type {ApplicationTargetArtifact} from '../repair/application-types.js';
import type {ApplicationPreparationRequest} from '../repair/application-preparation-types.js';
import {createModernActivationRecordContract} from '../../domain/governance/activation/modern-records.js';
import {createManifestV8ProjectReader} from '../../domain/project/manifest/v8-project.js';
import {createManifestV8Reader} from '../../domain/project/manifest/v8.js';
import {projectCatalog} from '../project/catalog.js';
import {resolveModernManifestV8SourceContract} from '../project/manifest.js';

export function captureLocalExecutionStore(value:LocalExecutionRecordStore,root:string):LocalExecutionRecordStore{
  const keys=['operationKind','projectRoot','read','write','readState','compareExchangeState'];
  if(!value||typeof value!=='object'||types.isProxy(value))localInputFailure('Dedicated local-execution storage is required.');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(keys.some(key=>!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key],'value'))||
    descriptors.operationKind.value!=='local-execution'||descriptors.projectRoot.value!==root||
    keys.slice(2).some(key=>typeof descriptors[key].value!=='function'))localInputFailure('Local execution storage kind/root attribution does not match.');
  const read=value.read,write=value.write,readState=value.readState,compareExchangeState=value.compareExchangeState;
  return Object.freeze({operationKind:'local-execution',projectRoot:root,
    read:(kind,key)=>read.call(value,kind,key),write:(kind,key,item)=>write.call(value,kind,key,item),
    readState:key=>readState.call(value,key),compareExchangeState:(key,digest,item)=>compareExchangeState.call(value,key,digest,item)} satisfies LocalExecutionRecordStore);
}
export async function localExecutionRoot(root:string):Promise<string>{
  if(typeof root!=='string'||!root||root.length>4096||/[\u0000-\u001f]/u.test(root))localInputFailure('Local execution root must be a bounded path.');
  const selected=path.resolve(root),before=await lstat(selected),canonical=await realpath(selected),after=await lstat(canonical);
  if(!before.isDirectory()||before.isSymbolicLink()||!after.isDirectory()||after.dev!==before.dev||after.ino!==before.ino)localInputFailure('Local execution root is unsafe or changed.');
  return canonical;
}
export function localExecutionStore(root:string):LocalExecutionRecordStore{return captureLocalExecutionStore(createLocalExecutionRecordStore(root),root);}
export function executionBinding(plan:Awaited<ReturnType<typeof planModernLocalRuntime>>){
  if(plan.status!=='planned'||!plan.localPlan||plan.inspection.status!=='observed'||plan.inspection.local.status!=='modern-observed')localInputFailure('Local execution requires the complete actual unblocked runtime plan.');
  return {installedBinding:plan.installedBinding!,observationDigest:plan.localPlan.observationDigest,physicalDigest:plan.localPlan.physicalDigest,
    baselineDigest:plan.localPlan.baselineDigest,recipeDigest:plan.localPlan.recipeSet.digest};
}
export async function prepareModernLocalExecution(root:string,request:{kind:'verify-local';preparation:readonly ApplicationPreparationRequest[]}):Promise<LocalExecutionPreview>{
  const selected=copyModernLocalData({root,request});exactRecord(selected.request,['kind','preparation'],'Local execution request');
  if(selected.request.kind!=='verify-local')localInputFailure('Only verify-local execution is registered.');
  const requests=parseApplicationPreparation(selected.request.preparation);
  const canonical=await localExecutionRoot(selected.root),store=localExecutionStore(canonical);
  const derived=await deriveLocalExecution(canonical,requests);
  await store.write('preview',derived.preview.fingerprint,derived.preview);
  return derived.preview;
}
export async function prepareModernManualNativeExecution(
  root: string, request: { kind: 'verify-manual-native'; preparation: readonly ApplicationPreparationRequest[] }
): Promise<LocalExecutionPreview> {
  const selected = copyModernLocalData({ root, request });
  exactRecord(selected.request, ['kind', 'preparation'], 'Manual native execution request');
  if (selected.request.kind !== 'verify-manual-native') localInputFailure('A separately identified native Manual request is required.');
  const requests = parseApplicationPreparation(selected.request.preparation), canonical = await localExecutionRoot(selected.root);
  const derived = await deriveLocalExecution(canonical, requests, undefined, 'manual-native');
  await localExecutionStore(canonical).write('preview', derived.preview.fingerprint, derived.preview);
  return derived.preview;
}
type LocalExecutionInputMode='generic'|'active-openspec'|'initialized-openspec'|'archived-openspec'|'manual-native';
function previewInputMode(preview:LocalExecutionPreview):LocalExecutionInputMode{
  return preview.schemaVersion===6?'manual-native':preview.schemaVersion===5?'archived-openspec':preview.schemaVersion===4?'initialized-openspec':
    preview.schemaVersion===3?'active-openspec':'generic';
}
async function deriveLocalExecution(canonical:string,requests:readonly ApplicationPreparationRequest[],
  issuance?:Pick<LocalExecutionPreview,'operationId'|'createdAt'|'expiresAt'>,mode:LocalExecutionInputMode='generic'){
  const captured=await captureLocalExecutionInput(canonical,requests,mode);
  const {inspection,plan,binding,preparation}=captured;
  const tools=await observeModernLocalTools(canonical,plan.localPlan!.checks,preparation);
  const now=new Date(),createdAt=issuance?.createdAt??now.toISOString(),expiresAt=issuance?.expiresAt??new Date(now.getTime()+localExecutionPolicy.approvalLifetimeMs).toISOString();
  const preview=assembleLocalExecutionPreview(canonical,captured,tools,{operationId:issuance?.operationId,createdAt,expiresAt},now);
  const after=(await captureExecutionRuntime(canonical,mode)).binding;
  if(canonicalJson(after)!==canonicalJson(binding))localInputFailure('Original inputs changed while tools were being inspected.');
  return {preview,inspection,preparation};
}
export async function prepareModernOpenSpecExecution(root:string,request:{kind:'verify-openspec-local';preparation:readonly ApplicationPreparationRequest[]}):Promise<LocalExecutionPreview>{
  const selected=copyModernLocalData({root,request});exactRecord(selected.request,['kind','preparation'],'OpenSpec execution request');
  if(selected.request.kind!=='verify-openspec-local')localInputFailure('Fresh complete OpenSpec execution intent is required.');
  const requests=parseApplicationPreparation(selected.request.preparation),canonical=await localExecutionRoot(selected.root);
  const derived=await deriveLocalExecution(canonical,requests,undefined,'active-openspec');
  await localExecutionStore(canonical).write('preview',derived.preview.fingerprint,derived.preview);
  return derived.preview;
}
export async function prepareModernOpenSpecInitializedBaseline(root:string,request:{kind:'verify-openspec-initialized';preparation:readonly ApplicationPreparationRequest[]}):Promise<LocalExecutionPreview>{
  const selected=copyModernLocalData({root,request});exactRecord(selected.request,['kind','preparation'],'Initialized baseline request');
  if(selected.request.kind!=='verify-openspec-initialized')localInputFailure('Fresh initialized-baseline request required.');
  const requests=parseApplicationPreparation(selected.request.preparation);
  if(requests.some(r=>r.network))localInputFailure('Initialized baseline permits no dependency network.');
  const canonical=await localExecutionRoot(selected.root),derived=await deriveLocalExecution(canonical,requests,undefined,'initialized-openspec');
  await localExecutionStore(canonical).write('preview',derived.preview.fingerprint,derived.preview);return derived.preview;
}
export async function prepareModernArchivedOpenSpecExecution(root:string,request:{kind:'verify-openspec-archived';preparation:readonly ApplicationPreparationRequest[]}):Promise<LocalExecutionPreview>{
  const selected=copyModernLocalData({root,request});exactRecord(selected.request,['kind','preparation'],'Archived OpenSpec execution request');
  if(selected.request.kind!=='verify-openspec-archived')localInputFailure('Fresh archived OpenSpec validation intent is required.');
  const requests=parseApplicationPreparation(selected.request.preparation),canonical=await localExecutionRoot(selected.root);
  const derived=await deriveLocalExecution(canonical,requests,undefined,'archived-openspec');
  await localExecutionStore(canonical).write('preview',derived.preview.fingerprint,derived.preview);return derived.preview;
}
export async function captureLocalExecutionRuntime(canonical:string,completeOpenSpec=false,initialized=false){
  if(initialized&&!completeOpenSpec)localInputFailure('Initialization requires complete OpenSpec input admission.');
  return captureExecutionRuntime(canonical,initialized?'initialized-openspec':completeOpenSpec?'active-openspec':'generic');
}
export async function captureLocalExecutionPreviewRuntime(canonical:string,preview:LocalExecutionPreview){
  return captureExecutionRuntime(canonical,previewInputMode(preview));
}
async function captureExecutionRuntime(canonical:string,mode:LocalExecutionInputMode){
  const initialized=mode==='initialized-openspec',archived=mode==='archived-openspec',
    completeOpenSpec=mode==='active-openspec'||initialized;
  const inspection=await (archived?inspectModernArchivedOpenSpecRuntime:completeOpenSpec?inspectModernOpenSpecRuntime:inspectModernLocalRuntime)(canonical);
  const manual = mode === 'manual-native' ? await planManualNativeLocalRuntime(inspection) : null;
  let plan=manual?.plan??await planModernLocalRuntime(inspection,initialized);
  executionBinding(plan);
  if (manual && (!manual.composeInputs || !manual.infrastructure)) localInputFailure('Native Manual planning omitted its complete interpreted input contracts.');
  const manualInputs = manual?.composeInputs && manual.infrastructure
    ? { compose: manual.composeInputs, infrastructure: manual.infrastructure } : null;
  if(inspection.status!=='observed'||inspection.local.status!=='modern-observed')localInputFailure('Missing actual captured runtime inputs.');
  const snapshot=inspection.local.snapshot,manifestFile=snapshot.files.find(file=>file.pathParts.join('/')==='liftoff.manifest.json');
  const raw=manifestFile&&capturedFileBytes(manifestFile);if(!raw)localInputFailure('Captured manifest missing.');
  const manifest=createManifestV8Reader({catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract}).parseManifestV8(JSON.parse(raw.toString('utf8')));
  const initialization=initialized?deriveOpenSpecInitialization(snapshot,manifest):null;
  const openSpecInputs=completeOpenSpec?deriveCompleteOpenSpecInputs(snapshot,manifest,initialization??undefined):null;
  const archivedOpenSpecInputs=archived?deriveArchivedOpenSpecInputs(snapshot,manifest):null;
  if(openSpecInputs||archivedOpenSpecInputs){
    const original=plan.localPlan!.checks,source=original.find(c=>c.id==='source-consistency')!,framework=original.find(c=>c.id==='framework-source')!;
    const remaining=original.filter(c=>!['source-consistency','framework-source'].includes(c.id)).flatMap(check=>{
      const r=initialization?.roots.find(r=>check.id===`tofu-validate:${r.component}`);
      return r?[{...check,id:`tofu-initialize:${r.component}`,command:{executable:'tofu',args:[...openSpecInitializationPolicy.initArgs]},
        env:{},prerequisites:['explicit initialization preparation consent'],effects:['private provider-free backend-disabled init; no original writes or network']},
        {...check,env:{},prerequisites:[`tofu-initialize:${r.component}`]}]:[check];
    });
    const workflowChecks=archivedOpenSpecInputs?archivedOpenSpecExecutionChecks(archivedOpenSpecInputs):openSpecExecutionChecks(openSpecInputs!);
    const checks=[source,{...framework,command:null,prerequisites:[],effects:[]},...workflowChecks,...remaining];
    plan={...plan,localPlan:{...plan.localPlan!,checks,recipeSet:{...plan.localPlan!.recipeSet,
      digest:canonicalSha256({originalRecipe:plan.localPlan!.recipeSet.digest,
        ...(archivedOpenSpecInputs?{policy:openSpecArchivedReadSetPolicy,archivedOpenSpecInputs}:{policy:openSpecReadSetPolicy,openSpecInputs}),
        checks,...(initialization?{initialization,initializationPolicy:openSpecInitializationPolicy}:{})})}}};
  }
  return {inspection,plan,binding:executionBinding(plan),manifest,openSpecInputs,initialization,archivedOpenSpecInputs,
    ...(manualInputs?{manualInputs}:{})};
}
async function captureLocalExecutionInput(canonical:string,requests:readonly ApplicationPreparationRequest[],mode:LocalExecutionInputMode='generic'){
  const captured=await captureExecutionRuntime(canonical,mode),{inspection,plan,manifest}=captured;
  if(inspection.status!=='observed'||inspection.local.status!=='modern-observed')localInputFailure('Missing actual captured runtime inputs.');
  const snapshot=inspection.local.snapshot;
  const targets:ApplicationTargetArtifact[]=[];
  for(const component of manifest.activeLayout.bindings){
    if(component.kind!=='component')continue;
    const owner=component.component,parts=[...component.pathParts];
    const definitions=owner==='backend'?(manifest.project.workload.apiStack==='node-fastify'?[['node-backend-package','package.json']]:
      manifest.project.workload.apiStack==='python-fastapi'?[['backend-pyproject','pyproject.toml']]:[['go-backend-module','go.mod']]):
      owner==='frontend'?[['frontend-package','package.json']]:owner==='function-worker'?[['function-worker-app','function_app.py']]:[];
    for(const [logicalName,name]of definitions)targets.push({logicalName,category:owner,pathParts:[...parts,name],provisioningGroup:'base',
      component:owner==='function-worker'?'functions':owner==='frontend'?'frontend':'backend',componentRootPathParts:parts});
  }
  const snapshots=snapshot.files.map(file=>({pathParts:[...file.pathParts],...(file.content===null?{}:{content:capturedFileBytes(file)!,mode:file.mode!})}));
  const preparation=resolveCapturedApplicationPreparationInputs(snapshots,targets,requests);
  for(const check of plan.localPlan!.checks.filter(check=>check.command?.executable==='npm'||check.command?.executable==='uv'||check.command?.executable==='go')){
    if(check.command?.executable==='npm'){
      const file=snapshots.find(file=>file.pathParts.join('/')===[...check.cwdPathParts,'package.json'].join('/'));
      const pkg:unknown=file?.content?JSON.parse(file.content.toString('utf8')):null;
      if(pkg&&typeof pkg==='object'&&['dependencies','devDependencies','optionalDependencies'].some(field=>Object.hasOwn(pkg,field))&&
        !preparation.some(step=>step.cwdPathParts.join('/')===check.cwdPathParts.join('/')))localInputFailure('Selected package dependencies require exact reviewed locked preparation.');
    }else if(!preparation.length)localInputFailure('Python/Go dependency preparation is required before this local execution lane can admit the complete check set.');
  }
  return {...captured,preparation};
}
function assembleLocalExecutionPreview(canonical:string,captured:Awaited<ReturnType<typeof captureLocalExecutionInput>>,tools:readonly LocalExecutionTool[],
  issuance:{operationId?:string;createdAt:string;expiresAt:string},now:Date){
  const {inspection,plan,binding,manifest,preparation,openSpecInputs,initialization,archivedOpenSpecInputs,manualInputs}=captured,{createdAt,expiresAt}=issuance;
  const openSpec=manifest.project.specWorkflow==='openspec';
  if(openSpec!==tools.some(t=>t.id==='openspec')||openSpec!==plan.localPlan!.checks.some(c=>c.command?.executable==='openspec'))localInputFailure('Actual workflow/check/tool OpenSpec identity mismatch.');
  const policy=manualInputs?manualNativeExecutionPolicy:archivedOpenSpecInputs?openSpecArchivedExecutionPolicy:initialization?openSpecInitializedExecutionPolicy:openSpecInputs?openSpecReadOnlyExecutionPolicy:openSpec?openSpecExecutionPolicy:localExecutionPolicy;
  let selectedPlan:LocalExecutionPreview['selectedPlan']=null;
  if(manifest.governance.profile!=='none'){
    const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:manifest.project,framework:manifest.framework});
    const api=createModernActivationRecordContract(projectCatalog,{recordedIdentity:manifest.governance.activationIdentity,profile:manifest.governance.profile,policyVersion:manifest.governance.policyVersion,
      selection:{...leaf,profile:manifest.governance.profile},pluginResolutionDigest:manifest.plugins.resolutionDigest,activeLayoutDigest:manifest.governance.activationIdentity.activeLayoutDigest});
    const phaseId='local-baseline-verified',phase=api.graph.phases.find(phase=>phase.id===phaseId)!;
    selectedPlan=api.createPlan({phaseId,createdAt,expiresAt,stateHash:inspection.installed.current?canonicalSha256(inspection.installed.current.state):null,
      baselineDigest:binding.baselineDigest,inputDigest:binding.observationDigest,transitionDigest:canonicalSha256({binding,policy,tools,preparation,...(initialization?{initialization}:{}),
        ...(manualInputs?{manualInputs}:archivedOpenSpecInputs?{archivedOpenSpecInputs}:openSpecInputs?{openSpecInputs}:openSpec?{executionAdmission:openSpecExecutionAdmission}:{})}),
      operations:[{adapter:'local-evidence',actionId:'governance.local.observe-approved-checks',mutationClass:'read-worktree',phaseId,
        inputs:{recipeDigest:binding.recipeDigest,completeCheckIds:plan.localPlan!.checks.map(check=>check.id)},destination:{type:'local',identity:canonical},remote:false,destructive:false}],
      approval:{gateKind:phase.approvalGate.kind,required:false,envelopeId:null,envelopeHash:null,evaluation:{phaseId,gateKind:phase.approvalGate.kind,questionKind:null,approvalRequired:false,status:'not-required',envelopeId:null,envelopeHash:null,reasons:[],expansionReasons:[]}},
      rollbackPlan:{phaseId,strategy:phase.rollback.kind,target:phase.rollback.target,operations:[],retained:[],cleanupWarnings:[]},noSecrets:true});
  }
  const frontend=plan.localPlan!.checks.find(check=>check.id==='frontend-build'&&check.status==='planned');
  const outputRoles=[...preparation.flatMap(item=>item.outputRoles),
    ...(manualInputs?[{...manualNativeExecutionPolicy.outputRole,pathParts:[...manualNativeExecutionPolicy.outputRole.pathParts]}]:[]),
    ...(frontend&&!preparation.some(item=>item.cwdPathParts.join('/')===frontend.cwdPathParts.join('/'))?[{
      id:'local-frontend-build',kind:'build-output' as const,pathParts:['project',...frontend.cwdPathParts,'dist'],protectedAfterPreparation:false
    }]:[])];
  const body={kind:'liftoff-local-execution-preview' as const,schemaVersion:1 as const,operationKind:'verify-local' as const,projectRoot:canonical,
    operationId:issuance.operationId??randomUUID(),createdAt,expiresAt,...binding,policyDigest:canonicalSha256(policy),
    checks:plan.localPlan!.checks.map(({inputPaths:_paths,...check})=>check),tools,preparation,preparationDigest:canonicalSha256(preparation),
    outputRoles,selectedPlan,selectedPlanDigest:selectedPlan?canonicalSha256(selectedPlan):null};
  const selected=manualInputs?{...body,schemaVersion:6 as const,manualInputs}:archivedOpenSpecInputs?{...body,schemaVersion:5 as const,archivedOpenSpecInputs}:
    initialization&&openSpecInputs?{...body,schemaVersion:4 as const,openSpecInputs,initialization}:openSpecInputs?{...body,schemaVersion:3 as const,openSpecInputs}:openSpec?{...body,schemaVersion:2 as const,executionAdmission:openSpecExecutionAdmission}:body;
  return validateLocalExecutionPreview({...selected,fingerprint:localExecutionDigest(selected)},now);
}
export async function reconstructLocalExecution(preview:LocalExecutionPreview){
  const captured=validateLocalExecutionPreview(preview,new Date());
  assertExecutableLocalExecutionPreview(captured);
  const requests=parseApplicationPreparation(captured.preparation.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))localInputFailure('Stored preparation is not a closed observed record.');
    const entry=value as Record<string,unknown>;
    return {provider:entry.provider,version:entry.version,cwdPathParts:entry.cwdPathParts,packageSource:entry.packageSource,network:entry.network,lifecycle:entry.lifecycle};
  }));
  const actual=await deriveLocalExecution(captured.projectRoot,requests,captured,previewInputMode(captured));
  if(canonicalJson(actual.preview)!==canonicalJson(captured))localInputFailure('Saved intent differs from actual source, tool, lock, recipe or selected-plan reconstruction.');
  return actual;
}
export async function loadLocalExecutionPreview(root:string,fingerprint:string,store=localExecutionStore(root)):Promise<LocalExecutionPreview>{
  const port=captureLocalExecutionStore(store,root);
  if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/u.test(fingerprint))localInputFailure('Exact local execution fingerprint required.');
  const record=await port.read('preview',fingerprint);if(!record)localInputFailure('Saved local execution preview is missing.');
  const value=validateLocalExecutionPreview(record.value as LocalExecutionPreview,new Date());
  if(value.projectRoot!==root||value.fingerprint!==fingerprint)localInputFailure('Local execution preview belongs to another root or intent.');
  return value;
}
export async function approveModernLocalExecution(root:string,fingerprint:string,input:LocalExecutionScopes):Promise<LocalExecutionConsent>{
  const captured=copyModernLocalData({root,fingerprint,input}),scopes=validateLocalExecutionScopes(captured.input),selected=captured.root,key=captured.fingerprint;
  const canonical=await localExecutionRoot(selected),store=localExecutionStore(canonical),preview=await loadLocalExecutionPreview(canonical,key,store);
  assertExecutableLocalExecutionPreview(preview);
  if(preview.schemaVersion===4)localInputFailure('Initialized baseline requires explicit scope attestation through its dedicated consent entrypoint.');
  if(preview.schemaVersion===6)localInputFailure('Native Manual execution requires its dedicated infrastructure preparation and network consent.');
  if(preview.preparation.length&&!scopes.dependencyPreparation||preview.preparation.some(value=>typeof value==='object'&&value!==null&&'network'in value&&value.network===true)&&!scopes.dependencyNetwork)localInputFailure('Displayed preparation/network effects require separate affirmative consent.');
  const prior=await store.read('consent',key);
  if(prior){
    const original=await loadLocalExecutionConsent(canonical,preview,store);
    if(canonicalJson(original.scopes)!==canonicalJson(scopes))localInputFailure('An existing immutable consent cannot silently change scopes.');
    return original;
  }
  const body={kind:'liftoff-local-execution-consent' as const,projectRoot:canonical,fingerprint:key,approvedAt:new Date().toISOString(),expiresAt:preview.expiresAt,scopes};
  const record:LocalExecutionConsent=preview.schemaVersion===5?{...body,schemaVersion:4,archivedOpenSpecInputDigest:canonicalSha256(preview.archivedOpenSpecInputs)}:
    preview.schemaVersion===3?{...body,schemaVersion:2,openSpecInputDigest:canonicalSha256(preview.openSpecInputs)}:{...body,schemaVersion:1};
  await store.write('consent',key,record);return record;
}
export async function approveModernOpenSpecInitializedBaseline(root:string,fingerprint:string,input:{scopes:LocalExecutionScopes;bootstrapScopeAttestation:BootstrapScopeAttestation}):Promise<LocalExecutionConsent>{
  const captured=copyModernLocalData({root,fingerprint,input});exactRecord(captured.input,['scopes','bootstrapScopeAttestation'],'Initialized consent request');
  const scopes=validateLocalExecutionScopes(captured.input.scopes),attestation=validateBootstrapScopeAttestation(captured.input.bootstrapScopeAttestation);
  if(!scopes.dependencyPreparation||scopes.dependencyNetwork)localInputFailure('Initialization requires explicit preparation consent without network.');
  const canonical=await localExecutionRoot(captured.root),store=localExecutionStore(canonical),preview=await loadLocalExecutionPreview(canonical,captured.fingerprint,store);
  if(preview.schemaVersion!==4)localInputFailure('Initialized consent cannot promote an older preview.');
  const original=await store.read('consent',preview.fingerprint);
  if(original)return validateLocalExecutionConsentRecord(canonical,preview,original.value,new Date());
  const value:LocalExecutionConsent={kind:'liftoff-local-execution-consent',schemaVersion:3,projectRoot:canonical,fingerprint:preview.fingerprint,
    approvedAt:new Date().toISOString(),expiresAt:preview.expiresAt,scopes,openSpecInputDigest:canonicalSha256(preview.openSpecInputs),
    initializationDigest:canonicalSha256(preview.initialization),bootstrapScopeAttestation:attestation};
  validateLocalExecutionConsentRecord(canonical,preview,value,new Date());await store.write('consent',preview.fingerprint,value);return value;
}
export async function approveModernManualNativeExecution(
  root: string, fingerprint: string, input: ManualNativeExecutionScopes
): Promise<LocalExecutionConsent> {
  const captured = copyModernLocalData({ root, fingerprint, input });
  const scopes = validateManualNativeExecutionScopes(captured.input);
  const canonical = await localExecutionRoot(captured.root), store = localExecutionStore(canonical);
  const preview = await loadLocalExecutionPreview(canonical, captured.fingerprint, store);
  if (preview.schemaVersion !== 6) localInputFailure('Native Manual consent cannot promote another execution recipe.');
  const prior = await store.read('consent', preview.fingerprint);
  if (prior) {
    const original = validateLocalExecutionConsentRecord(canonical, preview, prior.value, new Date());
    if (canonicalJson(original.scopes) !== canonicalJson(scopes)) localInputFailure('An existing immutable consent cannot silently change scopes.');
    return original;
  }
  const value: LocalExecutionConsent = {
    kind: 'liftoff-local-execution-consent', schemaVersion: 5, projectRoot: canonical, fingerprint: preview.fingerprint,
    approvedAt: new Date().toISOString(), expiresAt: preview.expiresAt, scopes,
    manualInputDigest: canonicalSha256(preview.manualInputs)
  };
  validateLocalExecutionConsentRecord(canonical, preview, value, new Date());
  await store.write('consent', preview.fingerprint, value);
  return value;
}
export async function loadLocalExecutionConsent(root:string,preview:LocalExecutionPreview,store=localExecutionStore(root)):Promise<LocalExecutionConsent>{
  preview=validateLocalExecutionPreview(preview,new Date());
  assertExecutableLocalExecutionPreview(preview);
  const port=captureLocalExecutionStore(store,root),saved=await port.read('consent',preview.fingerprint);
  if(!saved)localInputFailure('Explicit local execution consent is missing.');
  return validateLocalExecutionConsentRecord(root,preview,saved.value,new Date());
}
/** Historical provenance only: this never grants or repeats execution. */
export async function readCompletedLocalExecutionRecords(root:string,fingerprint:string){
  ({root,fingerprint}=copyModernLocalData({root,fingerprint}));
  const canonical=await localExecutionRoot(root),store=localExecutionStore(canonical);
  if(!/^[a-f0-9]{64}$/u.test(fingerprint))localInputFailure('Exact completed execution fingerprint required.');
  const previewRecord=await store.read('preview',fingerprint),consentRecord=await store.read('consent',fingerprint),
    stateRecord=await store.readState(fingerprint),resultRecord=await store.read('result',fingerprint);
  if(!previewRecord||!consentRecord||!stateRecord||!resultRecord)localInputFailure('Completed execution requires original preview, consent, result and progress.');
  const raw=copyModernLocalData(previewRecord.value) as LocalExecutionPreview;
  const preview=validateLocalExecutionPreview(raw,new Date(raw.createdAt));
  if(preview.projectRoot!==canonical||preview.fingerprint!==fingerprint)localInputFailure('Completed execution root/fingerprint differs.');
  const state=validateLocalExecutionState(stateRecord.value as LocalExecutionState,preview);
  const result=validateLocalExecutionResult(resultRecord.value as LocalExecutionResult,preview,state.workspace??undefined);
  const consent=validateLocalExecutionConsentRecord(canonical,preview,consentRecord.value,new Date(result.startedAt));
  const now=Date.now();
  if(!result.complete||state.phase!=='finished'||state.activity!==null||state.resultDigest!==result.resultDigest||
    Date.parse(result.startedAt)<Date.parse(preview.createdAt)||Date.parse(result.completedAt)>Date.parse(preview.expiresAt)||
    Date.parse(result.completedAt)>now||Date.parse(state.startedAt)<Date.parse(result.startedAt)||Date.parse(state.updatedAt)>now||
    Date.parse(state.updatedAt)<Date.parse(result.completedAt))localInputFailure('Historical execution chronology, complete coverage or finished progress is invalid.');
  return {preview,consent,state,result};
}
export async function readCompletedModernLocalExecution(root:string,fingerprint:string){
  ({root,fingerprint}=copyModernLocalData({root,fingerprint}));
  const canonical=await localExecutionRoot(root),transaction=await inspectLocalVerificationTransaction(canonical,{
    authorityStore:createLocalVerificationTransactionAuthorityStore(canonical)
  });
  if(transaction.status!=='absent')localInputFailure('Completed local source inspection requires explicit publication recovery first.');
  const saved=await localExecutionStore(canonical).read('preview',fingerprint);
  if(saved)assertExecutableLocalExecutionPreview(saved.value as LocalExecutionPreview);
  const records=await readCompletedLocalExecutionRecords(canonical,fingerprint),{preview}=records;
  const requests=parseApplicationPreparation(preview.preparation.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))localInputFailure('Stored preparation is not a closed observed record.');
    const entry=value as Record<string,unknown>;
    return {provider:entry.provider,version:entry.version,cwdPathParts:entry.cwdPathParts,packageSource:entry.packageSource,network:entry.network,lifecycle:entry.lifecycle};
  }));
  const current=await captureLocalExecutionInput(preview.projectRoot,requests,previewInputMode(preview));
  await assertModernLocalToolsCurrent(preview.projectRoot,records.state.workspace??preview.projectRoot,preview.tools);
  const reconstructed=assembleLocalExecutionPreview(preview.projectRoot,current,preview.tools,preview,new Date(preview.createdAt));
  if(canonicalJson(reconstructed)!==canonicalJson(preview))localInputFailure('Completed execution no longer corresponds to the actual full source/recipe/preparation/plan.');
  return {...records,...current};
}
export async function inspectModernLocalExecution(root:string,fingerprint:string){
  ({root,fingerprint}=copyModernLocalData({root,fingerprint}));
  if(typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/u.test(fingerprint))localInputFailure('Exact local execution fingerprint required.');
  const canonical=await localExecutionRoot(root),store=localExecutionStore(canonical);
  const saved=await store.read('preview',fingerprint),state=await store.readState(fingerprint),result=await store.read('result',fingerprint);
  if(!saved){
    if(state||result)localInputFailure('Local execution records have no original preview.');
    return {kind:'liftoff-local-execution-inspection' as const,projectRoot:canonical,fingerprint,status:'absent',state:null,result:null,execution:'not-authorized' as const};
  }
  const raw=copyModernLocalData(saved.value) as LocalExecutionPreview;
  const preview=validateLocalExecutionPreview(raw,new Date(raw.createdAt));
  if(preview.projectRoot!==canonical||preview.fingerprint!==fingerprint)localInputFailure('Inspected intent belongs to another project.');
  const progress=state?validateLocalExecutionState(state.value as LocalExecutionState,preview):null;
  const observed=result?validateLocalExecutionResult(result.value as LocalExecutionResult,preview,progress?.workspace??undefined):null;
  if(observed?.complete&&(!progress||progress.phase!=='finished'||progress.resultDigest!==observed.resultDigest))localInputFailure('Verified receipt lacks its actual finished operation progress.');
  if(preview.schemaVersion!==3&&preview.schemaVersion!==4&&preview.schemaVersion!==5&&hasOpenSpecExecutionIdentity(preview)){
    if(preview.schemaVersion===2&&await store.read('consent',fingerprint))localInputFailure('OpenSpec schema2 has no legitimate execution consent.');
    return {kind:'liftoff-local-execution-inspection' as const,projectRoot:canonical,fingerprint,
      status:'blocked' as const,state:progress,result:observed,execution:'not-authorized' as const,admission:openSpecExecutionAdmission};
  }
  return {kind:'liftoff-local-execution-inspection' as const,projectRoot:canonical,fingerprint,
    status:state?'retained':'absent',state:progress,result:observed,execution:'not-authorized' as const};
}
