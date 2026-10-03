import {applyLocalVerificationTransaction,inspectLocalVerificationTransaction,recoverLocalVerificationTransaction,
  type ReviewedUpdateTransactionOutcome} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {compareCompletionInputs,completionPreconditions,readCompletionFile} from '../../adapters/filesystem/modern-local-publication-inputs.js';
import {assertModernLocalToolsCurrent} from '../../adapters/process/modern-local-tools.js';
import {inspectModernInstalledActivation} from './modern-installed-preflight.js';
import {inspectCompletionBoundary,requireIdleCompletionBoundary,finalizationStore,readFinalizationPreview,loadFinalizationResult,compareCompletedProvenance,changeCompletionState,validateSpecKitFinalization} from './modern-local-finalization.js';
import {completionDigest,completionTime,completionHash,nativeCompletionPath,validatePublicationConsent,validateFinalizationState,
  type LocalPublicationConsent,type LocalFinalizationState,type NativeLocalCompletion} from '../../domain/governance/activation/modern-local-completion.js';
import {copyModernLocalData,localInputFailure} from '../../domain/governance/activation/modern-local-inputs.js';
import {exactRecord} from '../../domain/project/manifest/fields.js';

type Reviewed=Awaited<ReturnType<typeof loadFinalizationResult>>;
export interface LocalPublicationOutcome {
  status:'absent'|'awaiting-consent'|'interrupted'|'rolled-back'|'blocked'|'committed-cleanup-pending'|'committed-readback-pending'|'local-complete-current';
  projectRoot:string;publicationFingerprint:string|null;candidateBinding:string|null;transactionDigest:string|null;committed:boolean;
  readbackDigest:string|null;rollbackFailures:string[];cleanupFailures:string[];authority:'local-only';
}
function outcome(root:string,status:LocalPublicationOutcome['status'],review?:Reviewed,transaction?:ReviewedUpdateTransactionOutcome):LocalPublicationOutcome{
  return {status,projectRoot:root,publicationFingerprint:review?.result.publicationFingerprint??null,candidateBinding:review?.result.candidateBinding??null,
    transactionDigest:transaction?.transactionDigest??null,committed:transaction?.committed??false,readbackDigest:null,
    rollbackFailures:transaction?.rollbackFailures??[],cleanupFailures:transaction?.cleanupFailures??[],authority:'local-only'};
}
async function publicationConsent(review:Reviewed,live:boolean){
  const store=finalizationStore(review.preview.projectRoot),saved=await store.read('publication-consent',review.result.publicationFingerprint);
  if(!saved)localInputFailure('Explicit second publication consent is missing.');
  const raw=copyModernLocalData(saved.value) as LocalPublicationConsent;
  if(completionTime(raw.approvedAt)>Date.now())localInputFailure('Publication consent is dated after its observation.');
  return validatePublicationConsent(raw,review.result,live?new Date():new Date(raw.approvedAt));
}
async function protectedCurrent(review:Reviewed,stage:'original'|'target-pending'|'target'){
  const records=await compareCompletedProvenance(review.preview);
  await assertModernLocalToolsCurrent(review.preview.projectRoot,records.state.workspace??review.preview.projectRoot,records.preview.tools);
  await compareCompletionInputs(review.index,review.result.targets,stage);
}
async function readback(review:Reviewed):Promise<string>{
  const root=review.preview.projectRoot;
  await requireIdleCompletionBoundary(root);
  await protectedCurrent(review,'target');
  const installed=await inspectModernInstalledActivation(root);
  if(installed.status!=='observed')localInputFailure('Committed native completion has no valid independent installed readback.');
  if(review.preview.context.profile==='none'){
    if(installed.classification!=='governance-none'||installed.current!==null)localInputFailure('None completion acquired an activation boundary.');
  }else{
    if(installed.classification!=='current'||!installed.current||
      completionDigest(installed.current.state.identity)!==completionDigest(review.preview.context.identity)||
      ['local-inputs-valid','local-baseline-verified','local-complete'].some(id=>Reflect.get(installed.current!.state.phases,id)?.state!=='verified'))localInputFailure('Actual current local phase records are incomplete.');
  }
  const raw=await readCompletionFile(root,nativeCompletionPath);if(!raw.content)localInputFailure('Committed native receipt is missing.');
  const receipt=copyModernLocalData(JSON.parse(raw.content.toString('utf8'))) as NativeLocalCompletion;
  exactRecord(receipt,['kind','schemaVersion','projectRoot','operationId','finalizationFingerprint','context','execution','finalizationConsentDigest','completedAt','frameworkValidation','frameworkFinalization','records',
    ...(receipt.schemaVersion===2?['workflowInput','workflowOutcome']:[])],'Installed native receipt');
  if(receipt.kind!=='liftoff-native-local-completion'||receipt.schemaVersion!==review.preview.schemaVersion||receipt.projectRoot!==root||receipt.operationId!==review.preview.operationId||
    receipt.finalizationFingerprint!==review.preview.fingerprint||completionDigest(receipt.context)!==completionDigest(review.preview.context)||
    completionDigest(receipt.execution)!==completionDigest(review.preview.execution)||receipt.finalizationConsentDigest!==review.result.consentDigest||
    receipt.frameworkValidation!==(receipt.schemaVersion===2?'verified':'not-required')||receipt.frameworkFinalization!==(receipt.schemaVersion===2?'finalized':'not-required')||
    completionDigest(receipt.records)!==completionDigest(review.result.targets.filter(t=>t.purpose!=='native-receipt').map(t=>({pathParts:t.pathParts,rawDigest:t.target.rawDigest,purpose:t.purpose})))||
    receipt.completedAt!==review.result.completedAt)localInputFailure('Installed native receipt differs from its actual completed operation.');
  if(receipt.schemaVersion===2){
    if(review.preview.schemaVersion!==2||review.result.schemaVersion!==2||completionDigest(receipt.workflowInput)!==completionDigest(review.preview.workflowInput)||
      completionDigest(receipt.workflowOutcome)!==completionDigest(review.result.workflowOutcome))localInputFailure('Installed Spec Kit receipt has disconnected workflow proof.');
    await validateSpecKitFinalization(review,'target');
  }
  await protectedCurrent(review,'target');
  return completionDigest({kind:'liftoff-local-completion-readback',schemaVersion:1,projectRoot:root,publicationFingerprint:review.result.publicationFingerprint,
    targetSetDigest:review.result.targetSetDigest,protectedSetDigest:review.result.protectedSetDigest,installedBinding:installed.binding});
}
export async function approveModernLocalPublication(root:string,publicationFingerprint:string,input:{
  publishExactLocalBytes:true;finalizationFingerprint:string;candidateBinding:string;targetSetDigest:string;
}):Promise<LocalPublicationConsent>{
  ({root,publicationFingerprint,input}=copyModernLocalData({root,publicationFingerprint,input}));
  exactRecord(input,['publishExactLocalBytes','finalizationFingerprint','candidateBinding','targetSetDigest'],'Exact publication consent');
  const {root:canonical}=await requireIdleCompletionBoundary(root),store=finalizationStore(canonical),review=await loadFinalizationResult(canonical,publicationFingerprint,store);
  if(input.publishExactLocalBytes!==true||input.finalizationFingerprint!==review.preview.fingerprint||input.candidateBinding!==review.result.candidateBinding||
    input.targetSetDigest!==review.result.targetSetDigest)localInputFailure('Publication approval does not match observed exact bytes.');
  await protectedCurrent(review,'original');
  if(review.preview.schemaVersion===2)await validateSpecKitFinalization(review,'original');
  const saved=await store.readState(review.preview.fingerprint);
  if(!saved||validateFinalizationState(saved.value as LocalFinalizationState,review.preview).phase!=='awaiting-publication')localInputFailure('Finalization is not awaiting its second approval.');
  const prior=await store.read('publication-consent',publicationFingerprint);
  if(prior)return validatePublicationConsent(prior.value as LocalPublicationConsent,review.result,new Date());
  const consent:LocalPublicationConsent={kind:'liftoff-local-publication-consent',schemaVersion:1,projectRoot:canonical,finalizationFingerprint:review.preview.fingerprint,
    finalizationResultDigest:review.result.resultDigest,executionConsentDigest:review.preview.execution.consentDigest,executionResultDigest:review.preview.execution.resultDigest,
    publicationFingerprint,candidateBinding:review.result.candidateBinding,targetSetDigest:review.result.targetSetDigest,approvedAt:new Date().toISOString(),
    expiresAt:review.result.reviewExpiresAt,publishExactLocalBytes:true};
  validatePublicationConsent(consent,review.result,new Date());await store.write('publication-consent',publicationFingerprint,consent);return consent;
}
export async function publishModernLocalCompletion(root:string,publicationFingerprint:string):Promise<LocalPublicationOutcome>{
  ({root,publicationFingerprint}=copyModernLocalData({root,publicationFingerprint}));
  const boundary=await requireIdleCompletionBoundary(root),canonical=boundary.root,store=finalizationStore(canonical),review=await loadFinalizationResult(canonical,publicationFingerprint,store);
  await publicationConsent(review,true);await protectedCurrent(review,'original');
  if(review.preview.schemaVersion===2)await validateSpecKitFinalization(review,'original');
  let saved=await store.readState(review.preview.fingerprint);if(!saved)localInputFailure('Finalization progress is missing.');
  let state=validateFinalizationState(saved.value as LocalFinalizationState,review.preview);
  if(state.phase!=='awaiting-publication'||state.publicationFingerprint!==publicationFingerprint||state.candidateBinding!==review.result.candidateBinding)localInputFailure('This publication was already claimed or belongs to another review; never replay.');
  saved=await changeCompletionState(store,review.preview,saved.digest,{...state,phase:'publishing'});state=saved.value as LocalFinalizationState;
  const preconditions=await completionPreconditions(review.index,review.result.targets);
  const transaction=await applyLocalVerificationTransaction(canonical,review.mutations,{
    planFingerprint:publicationFingerprint,authorityStore:boundary.authorityStore,preconditions,expectedCandidateBinding:review.result.candidateBinding,
    validateCurrentInputs:async stage=>{
      await publicationConsent(review,true);
      const retained=await loadFinalizationResult(canonical,publicationFingerprint,store);
      if(retained.result.resultDigest!==review.result.resultDigest)localInputFailure('Immutable publication result changed during admission.');
      if(stage==='before-commit'){
        const observed=await inspectLocalVerificationTransaction(canonical,{authorityStore:boundary.authorityStore});
        if(observed.status!=='interrupted'||observed.planFingerprint!==publicationFingerprint||observed.transactionDigest!==state.transactionDigest)localInputFailure('Precommit journal differs from its observed transaction.');
      }
      await protectedCurrent(review,stage==='before-commit'?'target-pending':'original');
    },
    onCheckpoint:async checkpoint=>{
      if(checkpoint.phase!=='prepared'&&checkpoint.phase!=='committed')return;
      const observed=await inspectLocalVerificationTransaction(canonical,{authorityStore:boundary.authorityStore});
      if(observed.planFingerprint!==publicationFingerprint||!observed.transactionDigest||observed.status!==(checkpoint.phase==='committed'?'committed':'interrupted')||
        state.transactionDigest!==null&&state.transactionDigest!==observed.transactionDigest)localInputFailure('Actual LV checkpoint lacks its exact root/review/transaction attribution.');
      state={...state,transactionDigest:observed.transactionDigest,...(checkpoint.phase==='committed'?{
        phase:'committed-readback-pending' as const,blockerCodes:['cleanup-pending'],commitObservation:{publicationFingerprint,transactionDigest:observed.transactionDigest,observedAt:new Date().toISOString(),source:'local-verification-inspector' as const,committed:true as const}
      }:{})};
      saved=await changeCompletionState(store,review.preview,saved!.digest,state);state=saved.value as LocalFinalizationState;
    }
  });
  if(!transaction.committed)return outcome(canonical,transaction.status==='rolled-back'?'rolled-back':'blocked',review,transaction);
  if(transaction.cleanupFailures.length)return outcome(canonical,'committed-cleanup-pending',review,transaction);
  if(!state.commitObservation)localInputFailure('Committed publication lacks its independently persisted precleanup observation.');
  saved=await changeCompletionState(store,review.preview,saved.digest,{...state,blockerCodes:[]});state=saved.value as LocalFinalizationState;
  const readbackDigest=await readback(review);
  await changeCompletionState(store,review.preview,saved.digest,{...state,phase:'complete',readbackDigest});
  return {...outcome(canonical,'local-complete-current',review,transaction),readbackDigest};
}
export async function recoverModernLocalCompletion(root:string,request:{publicationFingerprint:string}):Promise<LocalPublicationOutcome>{
  ({root,request}=copyModernLocalData({root,request}));exactRecord(request,['publicationFingerprint'],'Local completion recovery');completionHash(request.publicationFingerprint);
  const boundary=await inspectCompletionBoundary(root),canonical=boundary.root,store=finalizationStore(canonical),review=await loadFinalizationResult(canonical,request.publicationFingerprint,store);
  await publicationConsent(review,false);
  let saved=await store.readState(review.preview.fingerprint);if(!saved)localInputFailure('Original publication progress is missing.');
  let state=validateFinalizationState(saved.value as LocalFinalizationState,review.preview);
  if(state.publicationFingerprint!==request.publicationFingerprint||state.candidateBinding!==review.result.candidateBinding)localInputFailure('Recovery has a different original review.');
  const observed=boundary.transaction;
  if(observed.status==='blocked')return {...outcome(canonical,'blocked',review),rollbackFailures:[observed.reason??'Local publication inspection is blocked.']};
  if(observed.status!=='absent'&&(observed.planFingerprint!==request.publicationFingerprint||!observed.transactionDigest||
    state.transactionDigest!==null&&state.transactionDigest!==observed.transactionDigest))localInputFailure('Recovery transaction is not this approved publication.');
  if(observed.committed){
    state={...state,phase:'committed-readback-pending',blockerCodes:['cleanup-pending'],transactionDigest:observed.transactionDigest!,commitObservation:state.commitObservation??{
      publicationFingerprint:request.publicationFingerprint,transactionDigest:observed.transactionDigest!,observedAt:new Date().toISOString(),source:'local-verification-inspector',committed:true}};
    saved=await changeCompletionState(store,review.preview,saved.digest,state);state=saved.value as LocalFinalizationState;
  }
  if(observed.status==='absent'&&!state.commitObservation)return outcome(canonical,'blocked',review);
  if(observed.status==='absent'&&state.blockerCodes.includes('cleanup-pending')){
    return {...outcome(canonical,'committed-cleanup-pending',review),committed:true,transactionDigest:state.transactionDigest,
      cleanupFailures:['The journal is absent but successful seal cleanup was not durably observed; no automatic completion or seal disposal is authorized.']};
  }
  const transaction=observed.status==='absent'?{
    status:'committed' as const,committed:true,planFingerprint:request.publicationFingerprint,transactionDigest:state.commitObservation!.transactionDigest,rollbackFailures:[],cleanupFailures:[]
  }:await recoverLocalVerificationTransaction(canonical,{authorityStore:boundary.authorityStore,
    expectedTransaction:{planFingerprint:request.publicationFingerprint,transactionDigest:observed.transactionDigest!}});
  const expectedDigest=observed.status==='absent'?state.commitObservation!.transactionDigest:observed.transactionDigest;
  if((transaction.status!=='blocked'||transaction.planFingerprint!==undefined||transaction.transactionDigest!==undefined)&&
    (transaction.planFingerprint!==request.publicationFingerprint||transaction.transactionDigest!==expectedDigest)){
    localInputFailure('Recovery returned attribution that differs from the exact observed publication transaction.');
  }
  if(!transaction.committed){
    if(transaction.status==='rolled-back')await changeCompletionState(store,review.preview,saved.digest,{...state,phase:'rolled-back',blockerCodes:['rolled-back']});
    return outcome(canonical,transaction.status==='rolled-back'?'rolled-back':'blocked',review,transaction);
  }
  if(transaction.cleanupFailures.length)return outcome(canonical,'committed-cleanup-pending',review,transaction);
  if(!state.commitObservation)localInputFailure('Recovery cannot infer commit from resulting target bytes.');
  saved=await changeCompletionState(store,review.preview,saved.digest,{...state,blockerCodes:[]});state=saved.value as LocalFinalizationState;
  const readbackDigest=await readback(review);
  await changeCompletionState(store,review.preview,saved.digest,{...state,phase:'complete',readbackDigest});
  return {...outcome(canonical,'local-complete-current',review,transaction),readbackDigest};
}
export async function inspectModernLocalCompletion(root:string):Promise<LocalPublicationOutcome>{
  root=copyModernLocalData(root);
  const boundary=await inspectCompletionBoundary(root),canonical=boundary.root,observed=boundary.transaction;
  if(observed.status!=='absent')return {...outcome(canonical,observed.committed?'committed-cleanup-pending':observed.status==='blocked'?'blocked':'interrupted'),
    publicationFingerprint:observed.planFingerprint??null,transactionDigest:observed.transactionDigest??null,committed:observed.committed,
    cleanupFailures:observed.reason?[observed.reason]:[]};
  const native=await readCompletionFile(canonical,nativeCompletionPath);
  if(!native.content)return outcome(canonical,'absent');
  const raw:unknown=JSON.parse(native.content.toString('utf8'));
  if(!raw||typeof raw!=='object'||!('finalizationFingerprint'in raw))localInputFailure('Native completion receipt has no original intent.');
  completionHash(raw.finalizationFingerprint);
  const store=finalizationStore(canonical),preview=await readFinalizationPreview(canonical,raw.finalizationFingerprint,store);
  const review=await loadFinalizationResult(canonical,preview.fingerprint,store);await publicationConsent(review,false);
  const progress=await store.readState(preview.fingerprint);if(!progress)localInputFailure('Installed target bytes have no actual committed progress.');
  const state=validateFinalizationState(progress.value as LocalFinalizationState,preview);
  if(!state.commitObservation||state.publicationFingerprint!==review.result.publicationFingerprint||state.candidateBinding!==review.result.candidateBinding)localInputFailure('Absent journal and installed target bytes do not prove commit.');
  if(state.blockerCodes.includes('cleanup-pending'))return {...outcome(canonical,'committed-cleanup-pending',review),committed:true,transactionDigest:state.transactionDigest,
    cleanupFailures:['Successful transaction cleanup has not been durably observed.']};
  const readbackDigest=await readback(review);
  return {...outcome(canonical,'local-complete-current',review),committed:true,transactionDigest:state.commitObservation.transactionDigest,readbackDigest};
}
