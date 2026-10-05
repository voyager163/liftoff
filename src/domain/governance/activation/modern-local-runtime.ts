import path from 'node:path';
import { canonicalSha256 } from './canonical-json.js';
import { copyModernLocalData, capturedFileBytes, localInputFailure,rawLocalDigest,
  type ModernLocalFile, type ModernLocalDirectory, type ModernLocalPhysical,
  type ModernLocalInspection, type ModernLocalVerificationPlan } from './modern-local-inputs.js';
import { validateManifestPathParts } from '../../project/manifest/layout.js';
import { exactRecord } from '../../project/manifest/fields.js';
import type { ModernActivationState } from './modern-record-contracts.js';
import type { ModernRelatedRecords } from './modern-records.js';
import type { ModernSavedTransitionPlan } from './modern-record-contracts.js';
import type { ModernLocalCheck } from './modern-local-inputs.js';
import {openSpecDistributionPolicy,validateInstalledToolDistribution,validateDistributionPhysical,
  type InstalledToolDistribution,type DistributionLauncher} from './installed-tool-distribution.js';

export const installedLocalBounds = Object.freeze({
  files: 1024, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
  directories: 1024, directoryEntries: 1024, historyGenerations: 3
});
export const reservedLocalVerificationJournalPath = ['.liftoff', 'local-verification-transaction.json'] as const;
export interface InstalledLocalSnapshot {
  readonly kind: 'liftoff-modern-installed-inputs';
  readonly schemaVersion: 1;
  readonly root: string;
  readonly observedAt: string;
  readonly files: readonly ModernLocalFile[];
  readonly directories: readonly ModernLocalDirectory[];
  readonly physical: readonly ModernLocalPhysical[];
}
export interface InstalledRetentionObligation {
  readonly origin: string;
  readonly repositoryId: string;
  readonly retainedAt: string;
  readonly disposeAfter: string;
  readonly status: 'retained' | 'disposed';
  readonly protectedPaths: readonly (readonly string[])[];
  readonly authority: 'preservation-only';
}
export type InstalledLocalClassification = 'fresh' | 'current' | 'successor' | 'governance-none' | 'released-source';
export type InstalledLocalPreflight =
  | {
      readonly status: 'observed';
      readonly classification: InstalledLocalClassification;
      readonly snapshot: InstalledLocalSnapshot;
      readonly binding: string;
      readonly retention: readonly InstalledRetentionObligation[];
      readonly current: { readonly state: ModernActivationState; readonly records: ModernRelatedRecords } | null;
      readonly localPublication: 'codec-unavailable-not-authorized';
    }
  | { readonly status: 'blocked'; readonly blockers: readonly string[] };
export type ModernLocalRuntimeInspection =
  | {
      readonly kind: 'liftoff-modern-local-runtime-inputs';
      readonly schemaVersion: 1;
      readonly status: 'observed';
      readonly installed: Extract<InstalledLocalPreflight, { status: 'observed' }>;
      readonly local: ModernLocalInspection;
    }
  | { readonly kind: 'liftoff-modern-local-runtime-inputs'; readonly schemaVersion: 1; readonly status: 'blocked'; readonly blockers: readonly string[] };
export interface ModernLocalRuntimePlan {
  readonly kind: 'liftoff-modern-local-runtime-plan';
  readonly schemaVersion: 1;
  readonly status: 'planned' | 'blocked';
  readonly inspection: ModernLocalRuntimeInspection;
  readonly localPlan: ModernLocalVerificationPlan | null;
  readonly installedBinding: string | null;
  readonly blockers: readonly string[];
  readonly execution: 'not-authorized';
  readonly publication: 'codec-unavailable-not-authorized';
}
export function validateInstalledLocalSnapshot(value: InstalledLocalSnapshot): void {
  value = copyModernLocalData(value);
  exactRecord(value, ['kind','schemaVersion','root','observedAt','files','directories','physical'], 'Installed input snapshot');
  if (value.kind !== 'liftoff-modern-installed-inputs' || value.schemaVersion !== 1 || !path.isAbsolute(value.root) ||
      path.normalize(value.root) !== value.root || typeof value.observedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/u.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) {
    localInputFailure('Invalid installed input snapshot identity.');
  }
  if (!Array.isArray(value.files) || value.files.length > installedLocalBounds.files ||
      !Array.isArray(value.directories) || value.directories.length > installedLocalBounds.directories ||
      !Array.isArray(value.physical) || value.physical.length > installedLocalBounds.files * 34) {
    localInputFailure('Installed input inventory exceeds its finite bounds.');
  }
  let total = 0;
  const fileNames = new Set<string>(), directoryNames = new Set<string>(), physicalNames = new Set<string>();
  for (const file of value.files) {
    const parts = validateManifestPathParts(file.pathParts, 'Installed input path'), name = parts.join('/');
    if (file.scope !== 'control' || fileNames.has(name)) localInputFailure('Duplicate or invalid installed control input.');
    fileNames.add(name);
    const bytes = capturedFileBytes(file);
    total += bytes?.length ?? 0;
    if (file.bytes > installedLocalBounds.fileBytes || total > installedLocalBounds.totalBytes) localInputFailure('Installed control byte bound exceeded.');
  }
  for (const directory of value.directories) {
    exactRecord(directory, ['pathParts','exists','mode','entries'], 'Installed directory');
    const name = directory.pathParts.length ? validateManifestPathParts(directory.pathParts, 'Installed directory').join('/') : '';
    if (directoryNames.has(name) || typeof directory.exists !== 'boolean' || !Array.isArray(directory.entries) ||
        directory.entries.length > installedLocalBounds.directoryEntries ||
        !directory.exists && (directory.mode !== null || directory.entries.length !== 0) ||
        directory.exists && (!Number.isInteger(directory.mode) || directory.mode === null || directory.mode < 0 || directory.mode > 0o777)) localInputFailure('Invalid installed directory observation.');
    directoryNames.add(name);
    const aliases = new Set<string>();
    for (const entry of directory.entries) {
      exactRecord(entry, ['name','kind'], 'Installed directory entry');
      validateManifestPathParts([entry.name], 'Installed member');
      const alias = entry.name.normalize('NFC').toLowerCase();
      if (aliases.has(alias) || !['file','directory','symlink','other'].includes(entry.kind)) localInputFailure('Installed directory contains ambiguous members.');
      aliases.add(alias);
    }
  }
  for (const entry of value.physical) {
    exactRecord(entry, ['path','identity'], 'Installed physical observation');
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || path.normalize(entry.path) !== entry.path ||
        physicalNames.has(entry.path) || entry.identity !== null && (typeof entry.identity !== 'string' || !/^\d+(?::\d+){7}$/u.test(entry.identity))) {
      localInputFailure('Invalid installed physical identity.');
    }
    const relative = path.relative(value.root, entry.path), ancestor = value.root === entry.path || value.root.startsWith(entry.path.endsWith(path.sep) ? entry.path : entry.path + path.sep);
    if (!ancestor && (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))) localInputFailure('Installed physical observation escapes its boundary.');
    physicalNames.add(entry.path);
  }
  if (!value.physical.some(entry => entry.path === value.root && entry.identity !== null)) localInputFailure('Installed root physical identity missing.');
  for (const entry of [...value.files, ...value.directories]) {
    for (let length = 0; length <= entry.pathParts.length; length++) {
      if (!physicalNames.has(path.join(value.root, ...entry.pathParts.slice(0,length)))) localInputFailure('Installed ancestor physical observation missing.');
    }
    const identity = value.physical.find(physical => physical.path === path.join(value.root,...entry.pathParts))!.identity;
    const present = 'content' in entry ? entry.content !== null : entry.exists;
    if (present !== (identity !== null) || present && (Number(identity!.split(':')[2]) & 0o7777) !== entry.mode) localInputFailure('Installed presence or mode contradicts physical observation.');
  }
  for (const file of value.files) {
    const parent: ModernLocalDirectory | undefined = value.directories.find(directory => directory.pathParts.join('/') === file.pathParts.slice(0,-1).join('/'));
    if (!parent) continue;
    const member = parent.entries.find(entry => entry.name === file.pathParts.at(-1));
    if (file.content !== null ? !parent.exists || member?.kind !== 'file' : member !== undefined) localInputFailure('Installed file contradicts captured collection membership.');
  }
}
export function installedLocalBinding(snapshot: InstalledLocalSnapshot): string {
  validateInstalledLocalSnapshot(snapshot);
  return canonicalSha256({ kind:'liftoff-installed-local-binding',schemaVersion:1,root:snapshot.root,
    files:snapshot.files.map(({content:_content,...file})=>file),directories:snapshot.directories,physical:snapshot.physical });
}

import {openSpecReadSetPolicy,validateOpenSpecExecutionInputs,openSpecExecutionChecks,validateOpenSpecCommandOutput,
  validateInitializedOpenSpecCommandOutput,openSpecArchivedReadSetPolicy,validateArchivedOpenSpecExecutionInputs,
  archivedOpenSpecExecutionChecks,validateArchivedOpenSpecCommandOutput,
  type OpenSpecExecutionInputs,type OpenSpecExecutionObservation,type OpenSpecArchivedExecutionInputs} from './modern-openspec-execution.js';
import {openSpecInitializationPolicy,validateOpenSpecInitialization,validateBootstrapScopeAttestation,initializationObligationOutcomes,validateInitializationOutputs,
  type OpenSpecInitialization,type BootstrapScopeAttestation,type OpenSpecInitializationOutcome} from './modern-openspec-obligations.js';
import { modernComposeInputPolicy, validateModernComposeInputs, type ModernComposeInputs } from './modern-compose.js';
import { explicitTofuFormatPolicy } from './modern-tofu-format.js';
import {
  manualInfrastructurePolicy, validateManualInfrastructureInputs, validateManualInfrastructureOutput,
  type ManualInfrastructureInputs, type ManualInfrastructureOutput
} from './modern-manual-infrastructure.js';

export const localExecutionPolicy = Object.freeze({
  kind:'liftoff-local-execution-policy',version:1,checks:32,checkTimeoutMs:120000,
  checkOutputBytes:65536,preparationTimeoutMs:180000,operationTimeoutMs:600000,
  approvalLifetimeMs:900000,recordBytes:65536,workspaceEntries:250000,workspaceDepth:64,
  projectCode:'explicit-host-and-network-capability-acknowledgement',
  diagnostics:'generated-codes-and-output-digests-only',publication:'not-authorized',sandbox:false
});
export const openSpecMetadataEnvironment=Object.freeze({OPENSPEC_TELEMETRY:'0',DO_NOT_TRACK:'1',OPENSPEC_NO_UPDATE_CHECK:'1',OPENSPEC_NO_COMPLETIONS:'1',OPEN_SPEC_INTERACTIVE:'0'});
export const openSpecExecutionPolicy=Object.freeze({kind:'liftoff-openspec-execution-policy',version:1,basePolicy:localExecutionPolicy,
  distributionPolicy:openSpecDistributionPolicy,metadataEnvironment:openSpecMetadataEnvironment,
  loader:'independent-node-default-conditions-no-inherited-options-or-path',admission:'openspec-workflow-inputs-unqualified'});
export const openSpecExecutionAdmission=Object.freeze({status:'blocked',code:'openspec-workflow-inputs-unqualified'} as const);
export const openSpecReadOnlyExecutionPolicy=Object.freeze({kind:'liftoff-openspec-execution-policy',version:2,basePolicy:localExecutionPolicy,
  distributionPolicy:openSpecDistributionPolicy,readSetPolicy:openSpecReadSetPolicy,environment:openSpecMetadataEnvironment,
  projectEnvironment:'fresh-owned-empty-home-config-data-cache-no-inherited-loader-after-last-await',jsonProofBytes:32768,
  loader:'independent-node-default-conditions-no-inherited-options-or-path',admission:'fresh-complete-readonly-inputs-and-consent',
  diagnostics:'validated-machine-json-only-with-raw-output-commitment',finalization:'not-authorized'});
export const openSpecInitializedExecutionPolicy=Object.freeze({...openSpecReadOnlyExecutionPolicy,version:3,initialization:openSpecInitializationPolicy,
  admission:'fresh-initialized-baseline-preparation-and-scope-attestation',completion:'initialization-obligations-observed-not-finalized'});
export const openSpecArchivedExecutionPolicy=Object.freeze({...openSpecReadOnlyExecutionPolicy,version:4,readSetPolicy:openSpecArchivedReadSetPolicy,
  admission:'fresh-complete-archived-inputs-and-consent',completion:'current-validation-not-historical-task-execution'});
export const manualNativeExecutionPolicy = Object.freeze({
  kind: 'liftoff-manual-native-execution-policy', version: 1, basePolicy: localExecutionPolicy,
  compose: modernComposeInputPolicy, formatting: explicitTofuFormatPolicy, infrastructure: manualInfrastructurePolicy,
  outputRole: Object.freeze({
    id: 'manual-infrastructure-preparation', kind: 'cache' as const,
    pathParts: Object.freeze(['cache', 'manual-init']), protectedAfterPreparation: false
  }),
  environment: 'fresh-owned-controls-and-explicitly-absent-compose-inputs-after-last-await',
  admission: 'independent-project-dependency-and-infrastructure-preparation-consent',
  completion: 'complete-native-checks-not-finalization-or-publication'
});
export interface LocalExecutionToolFile {
  path:string;digest:string;bytes:number;mode:number;device:string;inode:string;modifiedNs:string;changedNs:string;
}
export interface LegacyLocalExecutionTool {
  id:string;launcherPath:string;executablePath:string;prefixArgs:string[];version:string;
  versions:Readonly<Record<string,string>>;
  files:readonly LocalExecutionToolFile[];probe:{executable:string;args:string[]};digest:string;
}
export interface DistributionBoundLocalTool extends LegacyLocalExecutionTool {
  kind:'liftoff-distribution-bound-tool';schemaVersion:1;id:'openspec';distribution:InstalledToolDistribution;launcherObservation:DistributionLauncher;
}
export type LocalExecutionTool=LegacyLocalExecutionTool|DistributionBoundLocalTool;
export interface LocalExecutionScopes {
  projectCode:true;hostCapabilitiesAcknowledged:true;dependencyPreparation:boolean;dependencyNetwork:boolean;
  workflowFinalization:false;publishLocalRecords:false;
}
export interface LocalExecutionCheck extends Omit<ModernLocalCheck,'inputPaths'> {}
export interface LocalExecutionPreviewV1 {
  kind:'liftoff-local-execution-preview';schemaVersion:1;operationKind:'verify-local';
  projectRoot:string;operationId:string;createdAt:string;expiresAt:string;fingerprint:string;
  installedBinding:string;observationDigest:string;physicalDigest:string;baselineDigest:string;recipeDigest:string;
  policyDigest:string;checks:readonly LocalExecutionCheck[];tools:readonly LocalExecutionTool[];
  preparation:readonly unknown[];preparationDigest:string;outputRoles:readonly {
    id:string;kind:'dependency'|'cache'|'build-output';pathParts:string[];protectedAfterPreparation:boolean;
  }[];
  selectedPlan:ModernSavedTransitionPlan|null;selectedPlanDigest:string|null;
}
export interface LocalExecutionPreviewV2 extends Omit<LocalExecutionPreviewV1,'schemaVersion'> {
  schemaVersion:2;executionAdmission:typeof openSpecExecutionAdmission;
}
export interface LocalExecutionPreviewV3 extends Omit<LocalExecutionPreviewV1,'schemaVersion'>{
  schemaVersion:3;openSpecInputs:OpenSpecExecutionInputs;
}
export interface LocalExecutionPreviewV4 extends Omit<LocalExecutionPreviewV3,'schemaVersion'>{
  schemaVersion:4;initialization:OpenSpecInitialization;
}
export interface LocalExecutionPreviewV5 extends Omit<LocalExecutionPreviewV1,'schemaVersion'>{
  schemaVersion:5;archivedOpenSpecInputs:OpenSpecArchivedExecutionInputs;
}
export interface LocalExecutionPreviewV6 extends Omit<LocalExecutionPreviewV1, 'schemaVersion'> {
  schemaVersion: 6;
  manualInputs: { compose: ModernComposeInputs; infrastructure: ManualInfrastructureInputs };
}
export type LocalExecutionPreview=LocalExecutionPreviewV1|LocalExecutionPreviewV2|LocalExecutionPreviewV3|LocalExecutionPreviewV4|LocalExecutionPreviewV5|LocalExecutionPreviewV6;
export interface LocalExecutionConsentV1 {
  kind:'liftoff-local-execution-consent';schemaVersion:1;projectRoot:string;fingerprint:string;
  approvedAt:string;expiresAt:string;scopes:LocalExecutionScopes;
}
export interface LocalExecutionConsentV2 extends Omit<LocalExecutionConsentV1,'schemaVersion'>{
  schemaVersion:2;openSpecInputDigest:string;
}
export interface LocalExecutionConsentV3 extends Omit<LocalExecutionConsentV2,'schemaVersion'>{
  schemaVersion:3;initializationDigest:string;bootstrapScopeAttestation:BootstrapScopeAttestation;
}
export interface LocalExecutionConsentV4 extends Omit<LocalExecutionConsentV1,'schemaVersion'>{
  schemaVersion:4;archivedOpenSpecInputDigest:string;
}
export interface ManualNativeExecutionScopes extends LocalExecutionScopes {
  infrastructurePreparation: true;
  infrastructureNetwork: true;
}
export interface LocalExecutionConsentV5 extends Omit<LocalExecutionConsentV1, 'schemaVersion' | 'scopes'> {
  schemaVersion: 5; manualInputDigest: string; scopes: ManualNativeExecutionScopes;
}
export type LocalExecutionConsent=LocalExecutionConsentV1|LocalExecutionConsentV2|LocalExecutionConsentV3|LocalExecutionConsentV4|LocalExecutionConsentV5;
export type LocalExecutionCode = 'passed'|'inapplicable'|'nonzero-exit'|'process-failed'|'timeout'|'output-limit'|
  'cancelled'|'unsettled'|'admission-changed'|'workspace-failed'|'storage-failed'|'not-run'|'preparation-failed';
export interface LocalExecutionCheckResult {
  id:string;status:'passed'|'inapplicable'|'failed'|'blocked'|'uncertain';code:LocalExecutionCode;
  commandDigest:string|null;toolDigest:string|null;exitStatus:number|null;signal:string|null;
  startedAt:string|null;completedAt:string|null;stdoutDigest:string|null;stderrDigest:string|null;processTreeSettled:boolean;
}
export interface LocalExecutionResultV1 {
  kind:'liftoff-local-execution-result';schemaVersion:1;projectRoot:string;fingerprint:string;operationId:string;
  status:'checks-verified'|'failed'|'blocked'|'uncertain';complete:boolean;startedAt:string;completedAt:string;
  checks:readonly LocalExecutionCheckResult[];preparation:readonly LocalExecutionCheckResult[];
  inputsUnchanged:boolean;cleanupComplete:boolean;retainedWorkspace:string|null;
  policyDigest:string;baselineDigest:string;selectedPlanDigest:string|null;resultDigest:string;
  failureCode:LocalExecutionCode|null;
}
export interface LocalExecutionResultV2 extends Omit<LocalExecutionResultV1,'schemaVersion'>{
  schemaVersion:2;openSpec:{inputDigest:string;projectRoot:string;observations:readonly OpenSpecExecutionObservation[]};
}
export interface LocalExecutionResultV3 extends Omit<LocalExecutionResultV2,'schemaVersion'|'status'>{
  schemaVersion:3;status:'initialization-obligations-observed'|'failed'|'blocked'|'uncertain';initialization:OpenSpecInitializationOutcome;
}
export interface LocalExecutionResultV4 extends Omit<LocalExecutionResultV2,'schemaVersion'>{
  schemaVersion:4;
}
export interface LocalExecutionResultV5 extends Omit<LocalExecutionResultV1, 'schemaVersion'> {
  schemaVersion: 5;
  infrastructure: { inputDigest: string; outputs: readonly ManualInfrastructureOutput[] };
}
export type LocalExecutionResult=LocalExecutionResultV1|LocalExecutionResultV2|LocalExecutionResultV3|LocalExecutionResultV4|LocalExecutionResultV5;
export interface LocalExecutionState {
  kind:'liftoff-local-execution-state';schemaVersion:1;projectRoot:string;fingerprint:string;operationId:string;
  phase:'claimed'|'copying'|'preparing'|'verifying'|'finished'|'uncertain';
  startedAt:string;updatedAt:string;workspace:string|null;activity:{kind:'preparation'|'check'|'probe';id:string;commandDigest:string}|null;
  settledActivities:number;resultDigest:string|null;ownerTokenDigest:string;
}
export function localExecutionDigest(preview:Omit<LocalExecutionPreview,'fingerprint'>):string {return canonicalSha256(preview);}
function utc(value:string):number{
  const time=Date.parse(value);
  if(!Number.isFinite(time)||new Date(time).toISOString()!==value)localInputFailure('Invalid local execution timestamp.');
  return time;
}
export function validateLocalExecutionPreview(input:LocalExecutionPreview,now:Date):LocalExecutionPreview{
  const value=copyModernLocalData(input);
  exactRecord(value,['kind','schemaVersion','operationKind','projectRoot','operationId','createdAt','expiresAt','fingerprint',
    'installedBinding','observationDigest','physicalDigest','baselineDigest','recipeDigest','policyDigest','checks','tools',
    'preparation','preparationDigest','outputRoles','selectedPlan','selectedPlanDigest',...(value.schemaVersion===2?['executionAdmission']:[]),...([3,4].includes(value.schemaVersion)?['openSpecInputs']:[]),
    ...(value.schemaVersion===4?['initialization']:[]),...(value.schemaVersion===5?['archivedOpenSpecInputs']:[]),
    ...(value.schemaVersion===6?['manualInputs']:[])],'Local execution preview');
  if(value.kind!=='liftoff-local-execution-preview'||![1,2,3,4,5,6].includes(value.schemaVersion)||value.operationKind!=='verify-local'||
    !path.isAbsolute(value.projectRoot)||path.normalize(value.projectRoot)!==value.projectRoot||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.operationId))localInputFailure('Invalid local execution identity.');
  const created=utc(value.createdAt),expires=utc(value.expiresAt);
  if(!Number.isFinite(now.getTime())||created>now.getTime()||expires<=now.getTime()||expires<=created||expires-created>localExecutionPolicy.approvalLifetimeMs)localInputFailure('Local execution preview is expired or has invalid issuance.');
  if(!Array.isArray(value.checks)||!value.checks.length||value.checks.length>localExecutionPolicy.checks||
    new Set(value.checks.map(check=>check.id)).size!==value.checks.length||value.checks.some(check=>check.status==='blocked'))localInputFailure('Local execution requires every applicable check with no blockers.');
  function strings(input:unknown):asserts input is string[]{
    if(!Array.isArray(input)||input.some(item=>typeof item!=='string'))localInputFailure('Local execution requires explicit text lists.');
  }
  for(const check of value.checks){
    exactRecord(check,['id','status','reasons','command','cwdPathParts','env','prerequisites','effects'],'Local execution check');
    if(typeof check.id!=='string'||!check.id||!['planned','inapplicable'].includes(check.status))localInputFailure('Invalid local check identity/status.');
    for(const values of [check.reasons,check.prerequisites,check.effects])strings(values);
    strings(check.cwdPathParts);if(check.cwdPathParts.length)validateManifestPathParts(check.cwdPathParts,'Local check cwd');
    if(!check.env||typeof check.env!=='object'||Array.isArray(check.env)||Object.values(check.env).some(item=>typeof item!=='string'))localInputFailure('Invalid local check environment.');
    if(check.command!==null){
      exactRecord(check.command,['executable','args'],'Local check command');strings(check.command.args);
      if(!['npm','node','python','uv','go','docker','tofu','openspec'].includes(check.command.executable)||check.status!=='planned')localInputFailure('Unknown local command or inapplicable command invocation.');
    }else if(check.status==='planned'&&!['source-consistency','framework-source'].includes(check.id))localInputFailure('No registered in-process check producer.');
  }
  if(!Array.isArray(value.tools)||value.tools.length>8||new Set(value.tools.map(tool=>tool.id)).size!==value.tools.length||
      !Array.isArray(value.preparation)||value.preparation.length>4||!Array.isArray(value.outputRoles)||value.outputRoles.length>32)localInputFailure('Invalid local tool/preparation/output inventory.');
  for(const tool of value.tools){
    const distribution='distribution'in tool;
    exactRecord(tool,['id','launcherPath','executablePath','prefixArgs','version','versions','files','probe','digest',...(distribution?['kind','schemaVersion','distribution','launcherObservation']:[])],'Local tool');
    if(distribution){
      if(![2,3,4,5].includes(value.schemaVersion)||tool.id!=='openspec'||tool.kind!=='liftoff-distribution-bound-tool'||tool.schemaVersion!==1)localInputFailure('Mixed OpenSpec distribution tool identity.');
      validateInstalledToolDistribution(tool.distribution);
      exactRecord(tool.launcherObservation,['physical','linkText','resolvedPath'],'Observed tool launcher');validateDistributionPhysical(tool.launcherObservation.physical);
      if(tool.launcherObservation.linkText!==null&&typeof tool.launcherObservation.linkText!=='string'||
        tool.launcherObservation.resolvedPath!==path.join(tool.distribution.root.path,...tool.distribution.package.binPathParts)||
        canonicalSha256(tool.prefixArgs)!==canonicalSha256([tool.launcherObservation.resolvedPath])||
        tool.version!==tool.distribution.package.version||tool.versions.openspec!==tool.version||
        tool.files[0]?.path!==tool.launcherObservation.resolvedPath||tool.files[1]?.digest!==tool.distribution.package.metadataDigest||
        tool.files[1]?.path!==path.join(tool.distribution.root.path,'package.json')||
        canonicalSha256(tool.probe)!==canonicalSha256({executable:tool.executablePath,args:[...tool.prefixArgs,'--version']}))localInputFailure('OpenSpec package/launcher/version/probe correspondence differs.');
      const node=value.tools.find(t=>t.id==='node');
      if(!node||tool.executablePath!==node.executablePath||!node.files.every((f:LocalExecutionToolFile)=>tool.files.some((anchor:LocalExecutionToolFile)=>canonicalSha256(anchor)===canonicalSha256(f))))localInputFailure('OpenSpec lacks its exact independently observed Node association.');
    }else if([2,3,4,5].includes(value.schemaVersion)&&tool.id==='openspec')localInputFailure('OpenSpec preview requires complete distribution identity.');
    if(!['node','npm','python','uv','go','docker','tofu','openspec'].includes(tool.id)||!path.isAbsolute(tool.launcherPath)||!path.isAbsolute(tool.executablePath)||
      typeof tool.version!=='string'||!tool.version||!tool.versions||typeof tool.versions!=='object'||Array.isArray(tool.versions)||
      Object.values(tool.versions).some(version=>typeof version!=='string'||!version))localInputFailure('Invalid local tool identity.');
    strings(tool.prefixArgs);exactRecord(tool.probe,['executable','args'],'Local tool probe');strings(tool.probe.args);
    if(!path.isAbsolute(tool.probe.executable)||!Array.isArray(tool.files)||!tool.files.length||tool.files.length>16)localInputFailure('Local tool lacks a bounded installed identity.');
    for(const file of tool.files){
      exactRecord(file,['path','digest','bytes','mode','device','inode','modifiedNs','changedNs'],'Local tool file');
      if(!path.isAbsolute(file.path)||!/^[a-f0-9]{64}$/u.test(file.digest)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>256*1024*1024||
        !Number.isInteger(file.mode)||file.mode<0||file.mode>0o7777||
        [file.device,file.inode,file.modifiedNs,file.changedNs].some(field=>typeof field!=='string'||!/^\d+$/u.test(field)))localInputFailure('Invalid physical tool file.');
    }
    const {digest,...body}=tool;if(digest!==canonicalSha256(body))localInputFailure('Tool metadata digest mismatch.');
  }
  for(const role of value.outputRoles){
    exactRecord(role,['id','kind','pathParts','protectedAfterPreparation'],'Local output role');
    validateManifestPathParts(role.pathParts,'Local output role path');
    if(typeof role.id!=='string'||!['dependency','cache','build-output'].includes(role.kind)||typeof role.protectedAfterPreparation!=='boolean'||
      !['project','cache'].includes(role.pathParts[0]))localInputFailure('Local output role is not an admitted private boundary.');
  }
  if(value.schemaVersion===2){
    exactRecord(value.executionAdmission,['status','code'],'OpenSpec nonexecution admission');
    if(canonicalSha256(value.executionAdmission)!==canonicalSha256(openSpecExecutionAdmission)||
      value.tools.filter(t=>t.id==='openspec').length!==1||!value.checks.some(c=>c.command?.executable==='openspec')||
      value.selectedPlan&&value.selectedPlan.identity.workflow!=='openspec')localInputFailure('OpenSpec schema2 requires matching source/check/tool and permanently blocked admission.');
  }
  if(value.schemaVersion===3||value.schemaVersion===4){
    validateOpenSpecExecutionInputs(value.openSpecInputs);
    const expected=openSpecExecutionChecks(value.openSpecInputs).map(({inputPaths:_paths,...check})=>check);
    if(canonicalSha256(value.checks.filter(c=>c.command?.executable==='openspec'))!==canonicalSha256(expected)||
      value.tools.filter(t=>t.id==='openspec').length!==1||value.selectedPlan&&value.selectedPlan.identity.workflow!=='openspec'||
      !value.checks.some(c=>c.id==='framework-source'&&c.status==='planned'&&c.command===null))localInputFailure('OpenSpec executable preview lacks exact complete read-only recipes.');
  }
  if(value.schemaVersion===5){
    validateArchivedOpenSpecExecutionInputs(value.archivedOpenSpecInputs);
    const expected=archivedOpenSpecExecutionChecks(value.archivedOpenSpecInputs).map(({inputPaths:_paths,...check})=>check);
    if(canonicalSha256(value.checks.filter(c=>c.command?.executable==='openspec'))!==canonicalSha256(expected)||
      value.tools.filter(t=>t.id==='openspec').length!==1||value.selectedPlan&&value.selectedPlan.identity.workflow!=='openspec'||
      !value.checks.some(c=>c.id==='framework-source'&&c.status==='planned'&&c.command===null))
      localInputFailure('Archived OpenSpec preview lacks exact complete current/main/archive validation recipes.');
  }
  if(value.schemaVersion===4){
    const init=validateOpenSpecInitialization(value.initialization);
    if(init.taskPathParts[2]!==value.openSpecInputs.changeName||!value.tools.some(t=>t.id==='tofu')||value.preparation.some(p=>typeof p==='object'&&p!==null&&'network'in p&&p.network!==false))
      localInputFailure('Initialized baseline lacks provider-free source/tool/preparation correspondence.');
    const actual=value.checks.filter(c=>c.id.startsWith('tofu-initialize:'));
    if(actual.length!==init.roots.length)localInputFailure('Initialization must cover every selected OpenTofu root.');
    init.roots.forEach(r=>{
      const id=`tofu-initialize:${r.component}`,at=value.checks.findIndex(c=>c.id===id),check=value.checks[at],
        next=value.checks[at+1];
      if(!check||check.status!=='planned'||canonicalSha256(check.command)!==canonicalSha256({executable:'tofu',args:openSpecInitializationPolicy.initArgs})||
        canonicalSha256(check.cwdPathParts)!==canonicalSha256(r.cwdPathParts)||next?.id!==`tofu-validate:${r.component}`||
        canonicalSha256(next.cwdPathParts)!==canonicalSha256(r.cwdPathParts))localInputFailure('Init must precede its exact matching validate in the same workspace.');
    });
  }
  if (value.schemaVersion === 6) {
    exactRecord(value.manualInputs, ['compose', 'infrastructure'], 'Manual native execution inputs');
    validateModernComposeInputs(value.manualInputs.compose);
    const infrastructure = validateManualInfrastructureInputs(value.manualInputs.infrastructure);
    const tofu = value.tools.find(tool => tool.id === 'tofu');
    if (value.outputRoles.filter(role => role.id === manualNativeExecutionPolicy.outputRole.id).length !== 1 ||
        !value.outputRoles.some(role => canonicalSha256(role) === canonicalSha256(manualNativeExecutionPolicy.outputRole))) {
      localInputFailure('Manual execution requires its exact separately guarded owned preparation output role.');
    }
    if (hasOpenSpecExecutionIdentity(value) || !tofu || tofu.version !== manualInfrastructurePolicy.tofuVersion ||
        tofu.versions.tofu !== manualInfrastructurePolicy.tofuVersion ||
        value.selectedPlan && value.selectedPlan.identity.workflow !== 'manual' ||
        !value.checks.some(check => check.id === 'framework-source' && check.status === 'inapplicable' && check.command === null) ||
        !value.checks.some(check => check.id === 'tofu-validate:opentofu-application' && check.status === 'inapplicable' && check.command === null)) {
      localInputFailure('Native Manual execution requires its exact workflow, qualified tool and honest application-module coverage.');
    }
    const initialization = value.checks.filter(check => check.id.startsWith('tofu-initialize:'));
    const validation = value.checks.filter(check => check.id.startsWith('tofu-validate:') && check.command !== null);
    if (initialization.length !== infrastructure.roots.length || validation.length !== infrastructure.roots.length) {
      localInputFailure('Native Manual initialization and validation must cover every selected locked root.');
    }
    for (const root of infrastructure.roots) {
      const at = value.checks.findIndex(check => check.id === `tofu-initialize:${root.component}`);
      const init = value.checks[at], validate = value.checks[at + 1];
      if (!init || init.status !== 'planned' || validate?.id !== `tofu-validate:${root.component}` || validate.status !== 'planned' ||
          canonicalSha256(init.command) !== canonicalSha256({ executable: 'tofu', args: manualInfrastructurePolicy.initArgs }) ||
          canonicalSha256(validate.command) !== canonicalSha256({ executable: 'tofu', args: manualInfrastructurePolicy.validateArgs }) ||
          canonicalSha256(init.cwdPathParts) !== canonicalSha256(root.cwdPathParts) ||
          canonicalSha256(validate.cwdPathParts) !== canonicalSha256(root.cwdPathParts) ||
          Object.keys(init.env).length || Object.keys(validate.env).length) {
        localInputFailure('Manual initialization must precede its exact matching validation with owned runtime configuration.');
      }
    }
    const formatting = value.checks.filter(check => check.id.startsWith('tofu-format:'));
    const components = [{ component: infrastructure.moduleComponent, cwdPathParts: infrastructure.modulePathParts }, ...infrastructure.roots];
    if (formatting.length !== components.length) localInputFailure('Manual formatting must cover the complete selected component set.');
    for (const component of components) {
      const check = formatting.find(check => check.id === `tofu-format:${component.component}`);
      if (!check || check.status !== 'planned' || check.command?.executable !== 'tofu' ||
          canonicalSha256(check.cwdPathParts) !== canonicalSha256(component.cwdPathParts) ||
          canonicalSha256(check.command.args.slice(0, 3)) !== canonicalSha256(explicitTofuFormatPolicy.args) ||
          check.command.args.length <= 3 || check.command.args.length > explicitTofuFormatPolicy.files + 3 ||
          Buffer.byteLength(check.command.args.join('\0')) > explicitTofuFormatPolicy.argumentsBytes) {
        localInputFailure('Manual formatting requires bounded explicit captured .tf arguments in each approved component.');
      }
      for (const argument of check.command.args.slice(3)) {
        if (!argument.startsWith('./') || !argument.endsWith('.tf')) localInputFailure('Manual formatting cannot discover recursive or variable-file input.');
        validateManifestPathParts(argument.slice(2).split('/'), 'Manual explicit format input');
      }
    }
  }
  if(value.policyDigest!==canonicalSha256(value.schemaVersion===6?manualNativeExecutionPolicy:value.schemaVersion===5?openSpecArchivedExecutionPolicy:value.schemaVersion===4?openSpecInitializedExecutionPolicy:value.schemaVersion===3?openSpecReadOnlyExecutionPolicy:value.schemaVersion===2?openSpecExecutionPolicy:localExecutionPolicy)||value.preparationDigest!==canonicalSha256(value.preparation)||
    value.selectedPlanDigest!==(value.selectedPlan===null?null:canonicalSha256(value.selectedPlan)))localInputFailure('Local execution policy/preparation/plan binding mismatch.');
  const {fingerprint,...body}=value;
  if(fingerprint!==localExecutionDigest(body))localInputFailure('Local execution preview fingerprint mismatch.');
  if(Buffer.byteLength(JSON.stringify(value))>localExecutionPolicy.recordBytes)localInputFailure('Local execution preview exceeds64KiB.');
  return value;
}
export function hasOpenSpecExecutionIdentity(input:LocalExecutionPreview):boolean{
  const value=copyModernLocalData(input);
  if(!Array.isArray(value.checks)||!Array.isArray(value.tools))localInputFailure('Execution identity requires explicit check/tool inventories.');
  return [2,3,4,5].includes(value.schemaVersion)||'initialization'in value||'openSpecInputs'in value||'archivedOpenSpecInputs'in value||'executionAdmission'in value||value.selectedPlan?.identity?.workflow==='openspec'||
    value.checks.some(c=>c.command?.executable==='openspec'||c.reasons.some((reason:string)=>reason.startsWith('openspec-')))||
    value.tools.some(t=>t.id==='openspec'||'distribution'in t||'kind'in t&&t.kind==='liftoff-distribution-bound-tool');
}
export function assertExecutableLocalExecutionPreview(preview:LocalExecutionPreview):void{
  const value=copyModernLocalData(preview);
  if(value.schemaVersion===3||value.schemaVersion===4||value.schemaVersion===5||value.schemaVersion===6){validateLocalExecutionPreview(value,new Date(value.createdAt));return;}
  if(hasOpenSpecExecutionIdentity(preview))localInputFailure('openspec-workflow-inputs-unqualified: OpenSpec previews cannot authorize consent or execution.');
}
export function validateLocalExecutionScopes(input:unknown):LocalExecutionScopes{
  const value=exactRecord(copyModernLocalData(input),['projectCode','hostCapabilitiesAcknowledged','dependencyPreparation','dependencyNetwork','workflowFinalization','publishLocalRecords'],'Execution consent scopes');
  if(value.projectCode!==true||value.hostCapabilitiesAcknowledged!==true||typeof value.dependencyPreparation!=='boolean'||
    typeof value.dependencyNetwork!=='boolean'||value.workflowFinalization!==false||value.publishLocalRecords!==false||
    value.dependencyNetwork&&!value.dependencyPreparation)localInputFailure('Local execution needs explicit limited consent; no finalization or publication is authorized.');
  return {projectCode:value.projectCode,hostCapabilitiesAcknowledged:value.hostCapabilitiesAcknowledged,
    dependencyPreparation:value.dependencyPreparation,dependencyNetwork:value.dependencyNetwork,
    workflowFinalization:value.workflowFinalization,publishLocalRecords:value.publishLocalRecords};
}
export function validateManualNativeExecutionScopes(input: unknown): ManualNativeExecutionScopes {
  const value = exactRecord(copyModernLocalData(input), ['projectCode', 'hostCapabilitiesAcknowledged', 'dependencyPreparation',
    'dependencyNetwork', 'workflowFinalization', 'publishLocalRecords', 'infrastructurePreparation', 'infrastructureNetwork'], 'Manual native consent scopes');
  const { infrastructurePreparation, infrastructureNetwork, ...base } = value;
  const scopes = validateLocalExecutionScopes(base);
  if (infrastructurePreparation !== true || infrastructureNetwork !== true) {
    localInputFailure('Manual execution requires independent affirmative infrastructure preparation and provider-distribution network consent.');
  }
  return { ...scopes, infrastructurePreparation, infrastructureNetwork };
}
export function validateLocalExecutionConsentRecord(root:string,preview:LocalExecutionPreview,input:unknown,observedAt:Date):LocalExecutionConsent{
  if(preview.schemaVersion===2)localInputFailure('OpenSpec schema2 has no legitimate execution consent.');
  const value=copyModernLocalData(input) as LocalExecutionConsent;
  exactRecord(value,['kind','schemaVersion','projectRoot','fingerprint','approvedAt','expiresAt','scopes',...([3,4].includes(preview.schemaVersion)?['openSpecInputDigest']:[]),
    ...(preview.schemaVersion===4?['initializationDigest','bootstrapScopeAttestation']:[]),...(preview.schemaVersion===5?['archivedOpenSpecInputDigest']:[]),
    ...(preview.schemaVersion===6?['manualInputDigest']:[])],'Local execution consent');
  const at=Date.parse(value.approvedAt),expires=Date.parse(value.expiresAt);
  if(!Number.isFinite(observedAt.getTime())||!Number.isFinite(at)||!Number.isFinite(expires)||new Date(at).toISOString()!==value.approvedAt||
    value.kind!=='liftoff-local-execution-consent'||value.schemaVersion!==(preview.schemaVersion===6?5:preview.schemaVersion===5?4:preview.schemaVersion===4?3:preview.schemaVersion===3?2:1)||value.projectRoot!==root||value.fingerprint!==preview.fingerprint||
    value.expiresAt!==preview.expiresAt||Date.parse(value.approvedAt)<Date.parse(preview.createdAt)||Date.parse(value.approvedAt)>observedAt.getTime()||Date.parse(value.expiresAt)<=observedAt.getTime())localInputFailure('Local execution consent is invalid, stale or foreign.');
  if (preview.schemaVersion === 6) {
    validateManualNativeExecutionScopes(value.scopes);
    if (value.schemaVersion !== 5 || value.manualInputDigest !== canonicalSha256(preview.manualInputs)) {
      localInputFailure('Manual consent omits its exact complete native input contract.');
    }
  } else validateLocalExecutionScopes(value.scopes);
  if(preview.schemaVersion===3&&(value.schemaVersion!==2||value.openSpecInputDigest!==canonicalSha256(preview.openSpecInputs)))localInputFailure('OpenSpec consent omits its exact complete input contract.');
  if(preview.schemaVersion===5&&(value.schemaVersion!==4||value.archivedOpenSpecInputDigest!==canonicalSha256(preview.archivedOpenSpecInputs)))
    localInputFailure('Archived OpenSpec consent omits its exact current/archive input contract.');
  if(preview.schemaVersion===4){
    if(value.schemaVersion!==3||value.openSpecInputDigest!==canonicalSha256(preview.openSpecInputs)||value.initializationDigest!==canonicalSha256(preview.initialization)||
      value.scopes.dependencyPreparation!==true||value.scopes.dependencyNetwork!==false)localInputFailure('Initialized baseline requires exact affirmative preparation and no-network consent.');
    validateBootstrapScopeAttestation(value.bootstrapScopeAttestation);
  }
  if(preview.preparation.length&&!value.scopes.dependencyPreparation||
    preview.preparation.some(step=>typeof step==='object'&&step!==null&&'network'in step&&step.network===true)&&!value.scopes.dependencyNetwork)localInputFailure('Saved consent omits actual preparation/network effects.');
  return value;
}
export function validateLocalExecutionResult(input:unknown,preview:LocalExecutionPreview,workspaceDirectory?:string):LocalExecutionResult{
  if(preview.schemaVersion===2)localInputFailure('OpenSpec schema2 has no legitimate execution result.');
  const value=copyModernLocalData(input) as LocalExecutionResult;
  exactRecord(value,['kind','schemaVersion','projectRoot','fingerprint','operationId','status','complete','startedAt','completedAt','checks','preparation','inputsUnchanged','cleanupComplete','retainedWorkspace','policyDigest','baselineDigest','selectedPlanDigest','resultDigest','failureCode',...([3,4,5].includes(preview.schemaVersion)?['openSpec']:[]),
    ...(preview.schemaVersion===4?['initialization']:[]),...(preview.schemaVersion===6?['infrastructure']:[])],'Local execution result');
  if(value.kind!=='liftoff-local-execution-result'||value.schemaVersion!==(preview.schemaVersion===6?5:preview.schemaVersion===5?4:preview.schemaVersion===4?3:preview.schemaVersion===3?2:1)||value.projectRoot!==preview.projectRoot||
    value.fingerprint!==preview.fingerprint||value.operationId!==preview.operationId||value.policyDigest!==preview.policyDigest||
    value.baselineDigest!==preview.baselineDigest||value.selectedPlanDigest!==preview.selectedPlanDigest||
    utc(value.completedAt)<utc(value.startedAt)||value.checks.length!==preview.checks.length||
    value.checks.some((check,index)=>check.id!==preview.checks[index].id))localInputFailure('Execution result lacks exact complete input/check correspondence.');
  const validCodes=['passed','inapplicable','nonzero-exit','process-failed','timeout','output-limit','cancelled','unsettled','admission-changed','workspace-failed','storage-failed','not-run','preparation-failed'];
  if(typeof value.inputsUnchanged!=='boolean'||typeof value.cleanupComplete!=='boolean'||typeof value.complete!=='boolean'||
    !(preview.schemaVersion===4?['initialization-obligations-observed','failed','blocked','uncertain']:['checks-verified','failed','blocked','uncertain']).includes(value.status)||value.failureCode!==null&&!validCodes.includes(value.failureCode)||
    value.retainedWorkspace!==null&&(typeof value.retainedWorkspace!=='string'||!path.isAbsolute(value.retainedWorkspace)))localInputFailure('Invalid execution result state.');
  for(const result of [...value.checks,...value.preparation]){
    exactRecord(result,['id','status','code','commandDigest','toolDigest','exitStatus','signal','startedAt','completedAt','stdoutDigest','stderrDigest','processTreeSettled'],'Execution check result');
    if(!validCodes.includes(result.code)||!['passed','inapplicable','failed','blocked','uncertain'].includes(result.status)||
      typeof result.processTreeSettled!=='boolean')localInputFailure('Execution diagnostics must be generated allowlisted codes.');
    for(const digest of [result.commandDigest,result.toolDigest,result.stdoutDigest,result.stderrDigest])if(digest!==null&&(typeof digest!=='string'||!/^[a-f0-9]{64}$/u.test(digest)))localInputFailure('Invalid execution observation digest.');
    if(result.startedAt!==null&&(utc(result.startedAt)<utc(value.startedAt)||result.completedAt===null||utc(result.completedAt)<utc(result.startedAt)||utc(result.completedAt)>utc(value.completedAt)))localInputFailure('Execution check timestamps contradict their actual operation.');
    if(result.status==='passed'&&(!result.processTreeSettled||result.exitStatus!==0||result.signal!==null||result.code!=='passed'))localInputFailure('Passed execution lacks actual settlement.');
  }
  for(const [index,result]of value.checks.entries()){
    const check=preview.checks[index];
    if(check.status==='inapplicable'){
      if(result.status!=='inapplicable'||result.code!=='inapplicable'||result.commandDigest!==null||result.toolDigest!==null||
        result.startedAt!==null||result.completedAt!==null||result.stdoutDigest!==null||result.stderrDigest!==null)localInputFailure('Inapplicable check must not fabricate command execution.');
      continue;
    }
    if(result.status==='inapplicable')localInputFailure('An applicable required check cannot disappear.');
    if(result.status==='blocked'&&result.code==='not-run'){
      if(result.commandDigest!==null||result.toolDigest!==null||result.startedAt!==null||result.completedAt!==null||result.stdoutDigest!==null||result.stderrDigest!==null||result.processTreeSettled)localInputFailure('Unrun check cannot contain observed execution.');
      continue;
    }
    const tool=check.command?preview.tools.find(tool=>tool.id===check.command!.executable):undefined;
    const expected=check.command&&tool?canonicalSha256({executable:tool.executablePath,args:[...tool.prefixArgs,...(tool.id==='docker'?check.command.args.slice(1):check.command.args)]}):
      check.command?null:canonicalSha256({kind:'in-process',id:check.id});
    if(result.commandDigest!==expected||result.toolDigest!==(tool?.digest??null)||result.startedAt===null||result.completedAt===null) localInputFailure('Check result is disconnected from its exact approved command/tool.');
    if(check.command&&result.status!=='uncertain'&&(result.stdoutDigest===null||result.stderrDigest===null))localInputFailure('Actual command output commitments are missing.');
  }
  const preparationCommands=preview.preparation.flatMap(value=>{
    if(!value||typeof value!=='object'||!('provider'in value)||!('commands'in value)||!Array.isArray(value.commands))localInputFailure('Invalid preparation result contract.');
    const entry=value as Record<string,unknown>;
    const parts=entry.cwdPathParts;
    if(!Array.isArray(parts)||parts.some(part=>typeof part!=='string'))localInputFailure('Preparation result location is missing.');
    return value.commands.map((command,index)=>({id:`${String(value.provider)}:${parts.join('/')}:${index}`,command,parts}));
  });
  for(const [index,result]of value.preparation.entries()){
    const expected=preparationCommands[index];
    if(!expected||result.id!==expected.id)localInputFailure('Preparation results are missing, reordered or invented.');
    const command:unknown=expected.command;
    if(!command||typeof command!=='object'||!('tool'in command)||!('args'in command)||!Array.isArray(command.args)||command.args.some(arg=>typeof arg!=='string'))localInputFailure('Preparation command correspondence is missing.');
    const tool=preview.tools.find(tool=>tool.id===command.tool);
    if(!tool)localInputFailure('Preparation result has no approved installed tool.');
    const args=command.args.map((arg:string)=>{
      if(arg==='$APPROVED_PYTHON')return preview.tools.find(tool=>tool.id==='python')?.executablePath??localInputFailure('Preparation Python identity missing.');
      if(arg==='$PRIVATE_PYTHON_ENVIRONMENT'){
        if(!workspaceDirectory||!path.isAbsolute(workspaceDirectory)||path.basename(workspaceDirectory)!==preview.operationId)localInputFailure('Preparation lacks its attributed original workspace.');
        return path.join(workspaceDirectory,'project',...expected.parts,'.venv');
      }
      return arg;
    });
    if(result.toolDigest!==tool.digest||result.commandDigest!==canonicalSha256({executable:tool.executablePath,args:[...tool.prefixArgs,...args]})||
      result.startedAt===null||result.completedAt===null||result.status==='inapplicable'||result.status==='blocked'||
      result.status!=='uncertain'&&(result.stdoutDigest===null||result.stderrDigest===null))localInputFailure('Preparation result differs from its exact approved command/tool.');
  }
  if(preview.schemaVersion===3||preview.schemaVersion===4||preview.schemaVersion===5){
    if(value.schemaVersion!==2&&value.schemaVersion!==3&&value.schemaVersion!==4)localInputFailure('OpenSpec execution result requires exact command-output proof.');
    exactRecord(value.openSpec,['inputDigest','projectRoot','observations'],'OpenSpec result proof');
    if(value.openSpec.inputDigest!==canonicalSha256(preview.schemaVersion===5?preview.archivedOpenSpecInputs:preview.openSpecInputs)||!workspaceDirectory||
      value.openSpec.projectRoot!==path.join(workspaceDirectory,'project')||!Array.isArray(value.openSpec.observations))localInputFailure('OpenSpec result attribution differs from its original workspace/read set.');
    const passed=value.checks.filter(c=>c.id.startsWith('openspec-')&&c.status==='passed');
    if(passed.length!==value.openSpec.observations.length)localInputFailure('OpenSpec result is missing exact successful JSON observations.');
    value.openSpec.observations.forEach((proof,index)=>{
      exactRecord(proof,['id','stdout'],'OpenSpec observed JSON');
      if(proof.id!==passed[index].id||rawLocalDigest(proof.stdout)!==passed[index].stdoutDigest||passed[index].stderrDigest!==rawLocalDigest(''))localInputFailure('OpenSpec JSON proof is disconnected from command output.');
      if(preview.schemaVersion===5)validateArchivedOpenSpecCommandOutput(preview.archivedOpenSpecInputs,proof.id,proof.stdout,value.openSpec.projectRoot);
      else if(preview.schemaVersion===4)validateInitializedOpenSpecCommandOutput(preview.openSpecInputs,preview.initialization,proof.id,proof.stdout,value.openSpec.projectRoot);
      else validateOpenSpecCommandOutput(preview.openSpecInputs,proof.id,proof.stdout,value.openSpec.projectRoot);
    });
  }
  if(preview.schemaVersion===4){
    if(value.schemaVersion!==3||!workspaceDirectory)localInputFailure('Missing initialized-baseline outcome.');
    exactRecord(value.initialization,['inputDigest','markerProvenance','attestation','outputs','obligations'],'Initialization outcome');
    if(value.initialization.inputDigest!==canonicalSha256(preview.initialization)||value.initialization.markerProvenance!==openSpecInitializationPolicy.markerProvenance)
      localInputFailure('Initialization provenance/input differs.');
    validateBootstrapScopeAttestation(value.initialization.attestation);
    validateInitializationOutputs(value.initialization.outputs,preview.initialization,preview.observationDigest,preview.tools.find(t=>t.id==='tofu')!.digest,workspaceDirectory);
    if(canonicalSha256(value.initialization.obligations)!==canonicalSha256(initializationObligationOutcomes(preview.initialization,value.checks,value.initialization.attestation)))
      localInputFailure('Initialization obligation status lacks its actual check/attestation.');
    for(const r of preview.initialization.roots){
      const init=value.checks.find(c=>c.id===`tofu-initialize:${r.component}`)!,validate=value.checks.find(c=>c.id===`tofu-validate:${r.component}`)!,
        output=value.initialization.outputs.find(o=>o.component===r.component);
      if(validate.status==='passed'&&(init.status!=='passed'||!output||!init.completedAt||!validate.startedAt||utc(init.completedAt)>utc(validate.startedAt)))
        localInputFailure('Validation lacks prior settled initialization and unchanged output proof.');
      if(output&&init.status!=='passed')localInputFailure('Initialization output must not fabricate a passed init.');
    }
  }
  if (preview.schemaVersion === 6) {
    if (value.schemaVersion !== 5) localInputFailure('Native Manual execution needs its independently identified infrastructure outcome.');
    exactRecord(value.infrastructure, ['inputDigest', 'outputs'], 'Manual infrastructure outcome');
    if (value.infrastructure.inputDigest !== canonicalSha256(preview.manualInputs.infrastructure) || !workspaceDirectory ||
        !path.isAbsolute(workspaceDirectory) || path.normalize(workspaceDirectory) !== workspaceDirectory ||
        path.basename(workspaceDirectory) !== preview.operationId ||
        !Array.isArray(value.infrastructure.outputs) || value.infrastructure.outputs.length > preview.manualInputs.infrastructure.roots.length ||
        new Set(value.infrastructure.outputs.map(output => output.component)).size !== value.infrastructure.outputs.length) {
      localInputFailure('Manual infrastructure outcome lacks its exact source, output mapping or original workspace.');
    }
    const prepared = value.checks.filter(check => check.id.startsWith('tofu-initialize:') && check.status === 'passed');
    if (value.infrastructure.outputs.some((output, index) => prepared[index]?.id !== `tofu-initialize:${output.component}`)) {
      localInputFailure('Manual output proofs must follow their actual successful initialization order.');
    }
    for (const output of value.infrastructure.outputs) {
      validateManualInfrastructureOutput(output, preview.manualInputs.infrastructure, preview.observationDigest,
        preview.tools.find(tool => tool.id === 'tofu')!.digest, workspaceDirectory);
    }
    for (const root of preview.manualInputs.infrastructure.roots) {
      const init = value.checks.find(check => check.id === `tofu-initialize:${root.component}`)!;
      const validate = value.checks.find(check => check.id === `tofu-validate:${root.component}`)!;
      const output = value.infrastructure.outputs.find(output => output.component === root.component);
      if (validate.status === 'passed' && (init.status !== 'passed' || !output || !init.completedAt ||
          !validate.startedAt || utc(init.completedAt) > utc(validate.startedAt)) || output && init.status !== 'passed') {
        localInputFailure('Manual validation requires its prior settled initialization and unchanged owned provider/module output.');
      }
    }
  }
  if([3,4,5,6].includes(preview.schemaVersion)&&Buffer.byteLength(JSON.stringify(value))>localExecutionPolicy.recordBytes)localInputFailure('Execution result exceeds64KiB.');
  const verified=value.failureCode===null&&value.inputsUnchanged&&value.cleanupComplete&&value.retainedWorkspace===null&&
    value.checks.every((check,index)=>check.status===(preview.checks[index].status==='inapplicable'?'inapplicable':'passed'))&&
    value.preparation.length===preparationCommands.length&&value.preparation.every(check=>check.status==='passed')&&utc(value.completedAt)<=utc(preview.expiresAt)&&
    utc(value.completedAt)-utc(value.startedAt)<=localExecutionPolicy.operationTimeoutMs;
  if(value.complete!==verified||(value.status===(preview.schemaVersion===4?'initialization-obligations-observed':'checks-verified'))!==verified)localInputFailure('Local success requires complete checks, original inputs, settlement and cleanup.');
  const {resultDigest,...body}=value;
  if(resultDigest!==canonicalSha256(body))localInputFailure('Local execution result digest mismatch.');
  return value;
}
export function validateLocalExecutionState(input:LocalExecutionState,preview:LocalExecutionPreview):LocalExecutionState{
  if(preview.schemaVersion===2)localInputFailure('OpenSpec schema2 has no legitimate execution state.');
  const value=copyModernLocalData(input);
  exactRecord(value,['kind','schemaVersion','projectRoot','fingerprint','operationId','phase','startedAt','updatedAt','workspace','activity','settledActivities','resultDigest','ownerTokenDigest'],'Local execution state');
  if(value.kind!=='liftoff-local-execution-state'||value.schemaVersion!==1||value.projectRoot!==preview.projectRoot||
    value.fingerprint!==preview.fingerprint||value.operationId!==preview.operationId||
    !['claimed','copying','preparing','verifying','finished','uncertain'].includes(value.phase)||
    utc(value.updatedAt)<utc(value.startedAt)||!Number.isSafeInteger(value.settledActivities)||value.settledActivities<0||
    !/^[a-f0-9]{64}$/u.test(value.ownerTokenDigest)||value.workspace!==null&&(typeof value.workspace!=='string'||!path.isAbsolute(value.workspace))||
    value.resultDigest!==null&&!/^[a-f0-9]{64}$/u.test(value.resultDigest))localInputFailure('Local execution progress identity is invalid.');
  if(value.activity){
    exactRecord(value.activity,['kind','id','commandDigest'],'Local execution activity');
    if(!['preparation','check','probe'].includes(value.activity.kind)||typeof value.activity.id!=='string'||
      !/^[a-f0-9]{64}$/u.test(value.activity.commandDigest))localInputFailure('Local execution activity has invalid attribution.');
  }
  if(value.phase==='finished'&&(value.activity!==null||value.resultDigest===null))localInputFailure('Finished execution requires settled activities and its exact intended result.');
  return value;
}
