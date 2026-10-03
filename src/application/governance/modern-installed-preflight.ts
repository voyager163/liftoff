import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readBoundProjectFileSnapshot, assertBoundProjectPath } from '../../adapters/filesystem/bound-project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { inspectReviewedUpdateTransaction } from '../../adapters/filesystem/reviewed-update-transaction.js';
import { reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts } from '../../domain/project/reviewed-update-artifacts.js';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { createManifestV8Reader, type LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { createManifestV8ProjectReader } from '../../domain/project/manifest/v8-project.js';
import { manifestHistoryPaths } from '../../domain/project/manifest/history.js';
import { validateManifestPathParts } from '../../domain/project/manifest/layout.js';
import { readPreservedStandaloneManifest } from '../update/manifest-history.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../project/manifest.js';
import { projectCatalog } from '../project/catalog.js';
import { buildModernManagedCore } from '../project/modern-managed-core.js';
import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { copyModernLocalData, capturedFileBytes, localInputFailure, rawLocalDigest, ModernLocalInputError,
  type ModernLocalFile, type ModernLocalDirectory, type ModernLocalPhysical } from '../../domain/governance/activation/modern-local-inputs.js';
import { installedLocalBounds, installedLocalBinding, reservedLocalVerificationJournalPath, validateInstalledLocalSnapshot,
  type InstalledLocalSnapshot, type InstalledLocalPreflight, type InstalledRetentionObligation } from '../../domain/governance/activation/modern-local-runtime.js';
import { createModernActivationRecordContract, type ModernRelatedRecords } from '../../domain/governance/activation/modern-records.js';
import type { BootstrapStateRetentionFieldsV1 } from '../../domain/governance/activation/record-contracts.js';
import { isReleasedV3ActivationIdentity } from '../../domain/governance/policy/identity.js';
import { createModernHistoryContract } from '../../governance-activation/modern-history-contracts.js';
import { parseHistoryJson, historyRecord, validateFrozenActivationHistoryIndex, validateFrozenV3SourceIndex } from '../../governance-activation/history-contracts.js';
import { validateCapturedHistoricalSnapshot, validateCapturedV3SourceSnapshot, validateCapturedReleasedSource,
  assertCapturedHistoricalAncestor, assertCapturedV3SourceAncestor, assertCapturedV3MetadataAncestry,
  type ReleasedSourceInventory, type HistoricalActivationInventory, type FrozenV3SourceInventory } from '../../governance-activation/historical-state.js';
import { readModernActivationSuccessorSource } from '../../governance-activation/migration-history.js';

const statePath = ['governance','activation-state.json'], journalPath = ['governance','migration-state.json'];
const collections = ['plans','evidence','approvals','supersessions','reconciliation'] as const;
const transactionPaths = [reviewedUpdateTransactionPathParts,reviewedRepairTransactionPathParts,reservedLocalVerificationJournalPath];
const reader = createManifestV8Reader({catalog:projectCatalog,resolveSourceContract:resolveModernManifestV8SourceContract});
const key = (parts:readonly string[]) => parts.join('/');
const compare = (a:string,b:string) => a<b?-1:a>b?1:0;
function present(file: ModernLocalFile): ProjectFileSnapshot {
  const bytes=capturedFileBytes(file);
  return {pathParts:[...file.pathParts],...(bytes===undefined?{}:{content:bytes,mode:file.mode!})};
}
function retention(origin:string,repositoryId:string,value:BootstrapStateRetentionFieldsV1|undefined): InstalledRetentionObligation[] {
  if (!value) return [];
  return [{origin,repositoryId,retainedAt:value.retainedAt,disposeAfter:value.disposeAfter,status:value.status,
    protectedPaths:[...value.encryptedStatePathParts,...value.encryptionKeyPathParts].map(parts=>[...parts]),authority:'preservation-only'}];
}
function context(manifest:LiftoffManifestV8) {
  if(manifest.governance.profile==='none')return localInputFailure('Governance-none has no activation record contract.');
  const leaf=createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({project:manifest.project,framework:manifest.framework});
  return {recordedIdentity:manifest.governance.activationIdentity,profile:manifest.governance.profile,policyVersion:manifest.governance.policyVersion,
    selection:{...leaf,profile:manifest.governance.profile},
    pluginResolutionDigest:manifest.plugins.resolutionDigest,activeLayoutDigest:manifest.governance.activationIdentity.activeLayoutDigest};
}
interface CapturedHistory {
  readonly inventories: readonly ReleasedSourceInventory[];
  readonly firstIndex: ReturnType<typeof validateFrozenActivationHistoryIndex>|ReturnType<typeof validateFrozenV3SourceIndex>;
}
async function validateHistory(snapshot:InstalledLocalSnapshot,reference:{snapshotId:string;indexDigest:string}):Promise<CapturedHistory>{
  const files=new Map(snapshot.files.map(file=>[key(file.pathParts),file]));
  let id=reference.snapshotId,digest=reference.indexDigest;
  const visited=new Set<string>(),inventories:ReleasedSourceInventory[]=[];
  let firstIndex:CapturedHistory['firstIndex']|undefined;
  for(;;){
    if(visited.has(id)||visited.size>=installedLocalBounds.historyGenerations)localInputFailure('Installed history exceeds its exact released ancestry bound.');
    visited.add(id);
    const file=files.get(`governance/history/${id}/index.json`),bytes=file&&capturedFileBytes(file);
    if(!bytes||rawLocalDigest(bytes)!==digest)localInputFailure('Stored history index is missing or differs from its reference.');
    const raw=historyRecord(parseHistoryJson(bytes,'stored history index'),'stored index');
    const v3=isReleasedV3ActivationIdentity(raw.sourceIdentity);
    const index=v3?validateFrozenV3SourceIndex(raw):validateFrozenActivationHistoryIndex(raw);
    if(index.snapshotId!==id)localInputFailure('Stored history index names another snapshot.');
    const copies=index.files.map(entry=>{
      const file=files.get(key(entry.copyPathParts));
      if(!file)localInputFailure('Stored historical copy was not independently captured.');
      return present(file);
    });
    const inventory=v3?await validateCapturedV3SourceSnapshot(validateFrozenV3SourceIndex(index),copies):
      await validateCapturedHistoricalSnapshot(validateFrozenActivationHistoryIndex(index),copies);
    if(!firstIndex)firstIndex=index;
    const previous=inventories.at(-1);
    if(previous){
      if(v3)localInputFailure('A historical ancestor cannot be a future v3 source.');
      if(previous.state.schemaVersion===3)assertCapturedV3SourceAncestor(previous as FrozenV3SourceInventory,validateFrozenActivationHistoryIndex(index),inventory as HistoricalActivationInventory);
      else assertCapturedHistoricalAncestor(previous as HistoricalActivationInventory,validateFrozenActivationHistoryIndex(index),inventory as HistoricalActivationInventory);
    }
    inventories.push(inventory);
    if(!inventory.sourceMigration)break;
    id=inventory.sourceMigration.snapshotId;digest=inventory.sourceMigration.historyIndexDigest;
  }
  assertCapturedV3MetadataAncestry(inventories);
  return {inventories,firstIndex:firstIndex!};
}

/** Reconstructs record and source relations from bounded captured bytes, never embedded success flags. */
export async function validateCapturedModernInstalledActivation(input:InstalledLocalSnapshot):Promise<Extract<InstalledLocalPreflight,{status:'observed'}>>{
  const snapshot=copyModernLocalData(input);validateInstalledLocalSnapshot(snapshot);
  const files=new Map(snapshot.files.map(file=>[key(file.pathParts),file]));
  function bytes(parts:readonly string[],required=false):Buffer|undefined{
    const file=files.get(key(parts));if(!file)localInputFailure(`${key(parts)}: installed input was not captured.`);
    const content=capturedFileBytes(file);if(required&&!content)localInputFailure(`${key(parts)}: installed input is missing.`);return content;
  }
  for(const parts of transactionPaths)if(bytes(parts)!==undefined)localInputFailure('Pending local/update/repair transaction requires its actual recovery codec before installed-state interpretation.');
  const manifestBytes=bytes(['liftoff.manifest.json'],true)!,raw=historyRecord(parseHistoryJson(manifestBytes,'installed manifest'),'installed manifest');
  const stateBytes=bytes(statePath),journalBytes=bytes(journalPath);
  const observedCollections=collections.map(name=>{
    const directory=snapshot.directories.find(entry=>key(entry.pathParts)===`governance/${name}`);
    if(!directory)localInputFailure('Installed record collection membership was not captured.');
    return {name,files:directory.entries.filter(entry=>/\.json$/iu.test(entry.name)).map(entry=>{
      if(entry.kind!=='file')localInputFailure('Installed record is not a regular file.');
      const parts=['governance',name,entry.name];return {parts,value:parseHistoryJson(bytes(parts,true)!,'installed record')};
    })};
  });
  const list=(name:typeof collections[number])=>observedCollections.find(item=>item.name===name)!.files;
  const result=(classification:Extract<InstalledLocalPreflight,{status:'observed'}>['classification'],
    retained:readonly InstalledRetentionObligation[],current:Extract<InstalledLocalPreflight,{status:'observed'}>['current'])=>({
    status:'observed' as const,classification,snapshot,binding:installedLocalBinding(snapshot),retention:retained,current,
    localPublication:'codec-unavailable-not-authorized' as const
  });
  if(raw.artifactVersion!==8){
    const manifest=parseManifest(raw);
    if(stateBytes){
      const inventory=await validateCapturedReleasedSource(snapshot.files.map(present));
      const histories=inventory.sourceMigration?await validateHistory(snapshot,{snapshotId:inventory.sourceMigration.snapshotId,indexDigest:inventory.sourceMigration.historyIndexDigest}):undefined;
      if(histories){
        if(inventory.state.schemaVersion===3)assertCapturedV3SourceAncestor(inventory as FrozenV3SourceInventory,validateFrozenActivationHistoryIndex(histories.firstIndex),histories.inventories[0] as HistoricalActivationInventory);
        else assertCapturedHistoricalAncestor(inventory as HistoricalActivationInventory,validateFrozenActivationHistoryIndex(histories.firstIndex),histories.inventories[0] as HistoricalActivationInventory);
      }
      return result('released-source',[...retention('released-active',inventory.state.repository.id,inventory.state.bootstrapState),
        ...(histories?.inventories??[]).flatMap(source=>retention(canonicalSha256(source.state.identity),source.state.repository.id,source.state.bootstrapState))],null);
    }
    if(journalBytes || observedCollections.some(item=>item.files.length))localInputFailure('Released source has missing activation state with orphaned records.');
    return result('released-source',[],null);
  }
  const manifest=reader.parseManifestV8(raw);
  const core=buildModernManagedCore({selection:{project:manifest.project,framework:manifest.framework,profile:manifest.governance.profile},
    plugins:manifest.plugins,activeLayout:manifest.activeLayout});
  for(const artifact of core){
    const observed=bytes(artifact.pathParts,true)!;
    const recorded=manifest.managedArtifacts.find(file=>file.logicalName===artifact.logicalName);
    if(!observed.equals(Buffer.from(artifact.content))||recorded?.contentHash!==`sha256:${rawLocalDigest(observed)}`)localInputFailure('Installed managed core differs from its exact source bytes.');
  }
  let retained:InstalledRetentionObligation[]=[];
  if(manifest.sourceManifestHistory?.kind==='manifest-history'){
    const paths=manifestHistoryPaths(manifest.sourceManifestHistory),indexBytes=bytes(paths.indexPathParts,true)!;
    const original=readPreservedStandaloneManifest(manifest.sourceManifestHistory,
      {pathParts:paths.indexPathParts,content:indexBytes,mode:files.get(key(paths.indexPathParts))!.mode!},
      {pathParts:paths.manifestPathParts,content:bytes(paths.manifestPathParts,true)!,mode:files.get(key(paths.manifestPathParts))!.mode!});
    if(canonicalJson(original.project)!==canonicalJson(manifest.project)) {
      localInputFailure('Manifest-only source history belongs to a different project selection.');
    }
  }
  if(manifest.governance.profile==='none'){
    if(stateBytes||journalBytes||observedCollections.some(item=>item.files.length)||manifest.sourceManifestHistory?.kind==='activation-history')localInputFailure('Governance-none cannot manufacture or inherit an active activation boundary.');
    return result('governance-none',[],null);
  }
  if(!stateBytes){
    if(journalBytes||observedCollections.some(item=>item.files.length)||manifest.sourceManifestHistory?.kind==='activation-history')localInputFailure('Missing current state with orphaned activation/history records.');
    return result('fresh',[],null);
  }
  const api=createModernActivationRecordContract(projectCatalog,context(manifest));
  const refs:ModernRelatedRecords={plans:list('plans').map(file=>file.value),evidence:list('evidence').map(file=>file.value),approvals:list('approvals').map(file=>file.value)};
  const state=api.readState(parseHistoryJson(stateBytes,'installed state'),refs);
  if(Date.parse(state.updatedAt)>Date.parse(snapshot.observedAt))localInputFailure('Installed state is dated after the actual observation.');
  for(const file of list('evidence')){
    const record=api.readEvidence(file.value,refs);
    if(file.parts[2]!==`${record.evidenceId}.json`||record.header.repositoryId!==state.repository.id)localInputFailure('Installed evidence filename or repository contradicts its actual identity.');
    if(Date.parse(record.header.producedAt)>Date.parse(snapshot.observedAt))localInputFailure('Installed evidence is dated after its observation.');
  }
  for(const file of list('approvals')){
    const record=api.readApproval(file.value);
    if(file.parts[2]!==`${record.id}.json`)localInputFailure('Installed approval filename contradicts its actual identity.');
  }
  for(const file of list('plans'))api.readPlan(file.value,refs);
  if(new Set(list('plans').map(file=>canonicalSha256(file.value))).size!==list('plans').length)localInputFailure('Installed plan records contain duplicate bodies.');
  for(const file of list('supersessions'))api.readSupersession(file.value);
  if(list('supersessions').length)localInputFailure('Modern supersession requires allocated source-metadata links before local runtime readiness.');
  if(list('reconciliation').length)localInputFailure('Modern reconciliation storage has no allocated reader; it cannot confer installed readiness.');
  if(state.activeChange||state.taskProjection)localInputFailure('Modern active source-metadata/projection is unavailable; installed source bindings cannot be fabricated.');
  retained.push(...retention('current',state.repository.id,state.bootstrapState));
  if(manifest.sourceManifestHistory?.kind==='activation-history'){
    if(!journalBytes||!state.successorHistory)localInputFailure('Modern successor lacks its stored migration journal or state history link.');
    const history=await validateHistory(snapshot,manifest.sourceManifestHistory);
    const first=history.inventories[0],link=state.successorHistory,reference=manifest.sourceManifestHistory;
    if(canonicalJson(first.manifest.project)!==canonicalJson(manifest.project))localInputFailure('Activation source history belongs to a different project selection.');
    if(link.snapshotId!==reference.snapshotId||link.historyIndexDigest!==reference.indexDigest||
      key(link.historyIndexPathParts)!==`governance/history/${reference.snapshotId}/index.json` ||
      key(link.journalPathParts)!==key(journalPath) ||
      canonicalJson(link.sourceActiveChange)!==canonicalJson(first.state.activeChange))localInputFailure('Modern state and immutable history source disagree.');
    const contract=createModernHistoryContract(projectCatalog,context(manifest));
    const expected=contract.semanticInput(history.firstIndex.sourceIdentity,reference,rawLocalDigest(manifestBytes));
    const journal=contract.readJournal(parseHistoryJson(journalBytes,'modern migration journal'),expected,snapshot.observedAt,{state,records:refs});
    if(journal.successor.repositoryId!==state.repository.id||journal.successor.createdAt!==state.createdAt)localInputFailure('Installed successor state differs from its preparation anchor.');
    retained.push(...history.inventories.flatMap(source=>retention(canonicalSha256(source.state.identity),source.state.repository.id,source.state.bootstrapState)));
    return result('successor',retained,{state,records:refs});
  }
  if(journalBytes||state.successorHistory)localInputFailure('Current state names a missing or mismatched source history.');
  return result('current',retained,{state,records:refs});
}

/** Storage truth only. Pending journals are checked before any installed record interpretation. */
export async function inspectModernInstalledActivation(root:string):Promise<InstalledLocalPreflight>{
  if(typeof root!=='string'||!root||root.length>4096||/[\u0000-\u001f]/u.test(root))localInputFailure('Installed preflight requires a bounded root string.');
  const requested=root;
  try{
    const resolved=path.resolve(requested),initial=await lstat(resolved);
    if(!initial.isDirectory()||initial.isSymbolicLink())localInputFailure('Installed root must be a real directory.');
    const canonical=await realpath(resolved),files=new Map<string,ModernLocalFile>(),directories=new Map<string,ModernLocalDirectory>(),physical=new Map<string,ModernLocalPhysical>();
    const canonicalStat=await lstat(canonical);
    if(!canonicalStat.isDirectory()||canonicalStat.isSymbolicLink()||canonicalStat.dev!==initial.dev||
      canonicalStat.ino!==initial.ino||canonicalStat.mode!==initial.mode)localInputFailure('Installed root changed during canonical selection.');
    let total=0;
    const protectedCandidates:string[]=[];
    function preserveDeclaredPayloads(file:ModernLocalFile):void{
      const content=capturedFileBytes(file);if(!content)return;
      const raw=historyRecord(parseHistoryJson(content,'stored state'),'stored state'),value=raw.bootstrapState;
      if(value===undefined)return;
      const retained=historyRecord(value,'stored retention');
      for(const field of ['encryptedStatePathParts','encryptionKeyPathParts']){
        const paths=retained[field];if(!Array.isArray(paths)||paths.length>installedLocalBounds.files)localInputFailure('Retained payload declarations exceed the bounded path contract.');
        for(const candidate of paths){
          const name=key(validateManifestPathParts(candidate,'Retained payload path')).toLowerCase();
          if([...files.keys()].some(file=>file.toLowerCase()===name))localInputFailure('Retained payload declaration overlaps an already required control input.');
          protectedCandidates.push(name);
        }
      }
    }
    async function stamp(absolute:string):Promise<ModernLocalPhysical>{
      try{
        const stat=await lstat(absolute,{bigint:true});
        if(stat.isSymbolicLink())localInputFailure('Installed control path traverses a link.');
        const ancestor=absolute!==canonical&&!absolute.startsWith(canonical+path.sep);
        return {path:absolute,identity:[stat.dev,stat.ino,stat.mode,ancestor?0:stat.nlink,ancestor?0:stat.size,ancestor?0:stat.mtimeNs,ancestor?0:stat.ctimeNs,stat.birthtimeNs].join(':')};
      }catch(error){if(errorCode(error)==='ENOENT')return {path:absolute,identity:null};throw error;}
    }
    async function remember(absolute:string):Promise<void>{
      const entry=await stamp(absolute),prior=physical.get(absolute);
      if(prior&&canonicalJson(prior)!==canonicalJson(entry))localInputFailure('Installed root/parent/input changed during collection.');
      physical.set(absolute,entry);
    }
    for(let at=canonical;;at=path.dirname(at)){await remember(at);if(path.dirname(at)===at)break;}
    async function parents(parts:readonly string[]):Promise<void>{
      for(let length=0;length<=parts.length;length++)await remember(path.join(canonical,...parts.slice(0,length)));
    }
    async function capture(parts:readonly string[],absenceOnly=false):Promise<ModernLocalFile>{
      const checked=validateManifestPathParts(parts,'Installed path'),name=key(checked),prior=files.get(name);if(prior)return prior;
      const folded=name.toLowerCase();
      if(protectedCandidates.some(reserved=>folded===reserved||folded.startsWith(`${reserved}/`)||reserved.startsWith(`${folded}/`))) {
        localInputFailure('A required installed control overlaps a declared retained payload/key; its bytes are not read.');
      }
      if(files.size>=installedLocalBounds.files)localInputFailure('Installed capture exceeds the file-count bound.');
      await assertBoundProjectPath(canonical,checked,{pathLabel:'Installed input',invalid:localInputFailure});
      await parents(checked);
      const missing=physical.get(path.join(canonical,...checked))!.identity===null;
      if(absenceOnly&&!missing)localInputFailure('Pending local/update/repair transaction requires its real recovery codec; no installed interpretation occurred.');
      if(!missing&&total>=installedLocalBounds.totalBytes)localInputFailure('Installed raw-byte aggregate bound exhausted.');
      const observed=absenceOnly||missing?{pathParts:[...checked]}:await readBoundProjectFileSnapshot(canonical,checked,{
        maximumBytes:Math.min(installedLocalBounds.fileBytes,installedLocalBounds.totalBytes-total),
        linkPolicy:'single-link',diagnostics:{pathLabel:'Installed control',invalid:localInputFailure}});
      await parents(checked);
      total+=observed.content?.length??0;if(total>installedLocalBounds.totalBytes)localInputFailure('Installed raw-byte aggregate bound exceeded.');
      const file:ModernLocalFile={pathParts:[...checked],scope:'control',content:observed.content?.toString('base64')??null,mode:observed.mode??null,bytes:observed.content?.length??0,digest:observed.content?rawLocalDigest(observed.content):null};
      files.set(name,file);return file;
    }
    async function directory(parts:readonly string[]):Promise<void>{
      const name=key(parts);if(directories.has(name))return;if(directories.size>=installedLocalBounds.directories)localInputFailure('Installed directory bound exceeded.');
      await assertBoundProjectPath(canonical,parts,{pathLabel:'Installed collection',invalid:localInputFailure});await parents(parts);
      const identity=physical.get(path.join(canonical,...parts))!;
      if(identity.identity===null){directories.set(name,{pathParts:[...parts],exists:false,mode:null,entries:[]});return;}
      const entries:ModernLocalDirectory['entries'][number][]=[];
      const handle=await opendir(path.join(canonical,...parts));
      for await(const entry of handle){
        if(entries.length>=installedLocalBounds.directoryEntries)localInputFailure('Installed collection membership bound exceeded.');
        validateManifestPathParts([entry.name],'Installed member');
        entries.push({name:entry.name,kind:entry.isSymbolicLink()?'symlink':entry.isDirectory()?'directory':entry.isFile()?'file':'other'});
      }
      entries.sort((a,b)=>compare(a.name,b.name));await parents(parts);
      directories.set(name,{pathParts:[...parts],exists:true,mode:Number(identity.identity.split(':')[2])&0o7777,entries});
    }
    for(const parts of transactionPaths)await capture(parts,true);
    for(const transactionKind of ['update','repair'] as const)if((await inspectReviewedUpdateTransaction(canonical,{transactionKind})).status!=='absent')localInputFailure('Unfinished transaction blocks installed preflight.');
    const manifestFile=await capture(['liftoff.manifest.json']),manifestBytes=capturedFileBytes(manifestFile);
    if(!manifestBytes)localInputFailure('Installed manifest is absent.');
    const raw=historyRecord(parseHistoryJson(manifestBytes,'installed manifest'),'installed manifest');
    const stateFile=await capture(statePath);preserveDeclaredPayloads(stateFile);await capture(journalPath);
    for(const name of collections){
      const parts=['governance',name];await directory(parts);
      for(const entry of directories.get(key(parts))!.entries.filter(entry=>/\.json$/iu.test(entry.name)))await capture([...parts,entry.name]);
    }
    if(raw.artifactVersion!==8&&stateFile.content!==null){
      const source=await readModernActivationSuccessorSource(canonical);
      for(const observed of [...source.captures,...source.ancestors.flatMap(ancestor=>ancestor.copies)])await capture(observed.pathParts);
      for(const ancestor of source.ancestors)await capture(ancestor.indexPathParts);
    }else if(raw.artifactVersion===8){
      const manifest=reader.parseManifestV8(raw);
      const core=buildModernManagedCore({selection:{project:manifest.project,framework:manifest.framework,profile:manifest.governance.profile},
        plugins:manifest.plugins,activeLayout:manifest.activeLayout});
      for(const artifact of core)await capture(artifact.pathParts);
      if(manifest.sourceManifestHistory?.kind==='manifest-history'){
        const paths=manifestHistoryPaths(manifest.sourceManifestHistory);await capture(paths.indexPathParts);await capture(paths.manifestPathParts);
      }else if(manifest.sourceManifestHistory?.kind==='activation-history'){
        let id=manifest.sourceManifestHistory.snapshotId;
        const visited=new Set<string>();
        for(;;){
          if(visited.has(id)||visited.size>=installedLocalBounds.historyGenerations)localInputFailure('Stored ancestry exceeds exact source generations.');
          visited.add(id);
          const file=await capture(['governance','history',id,'index.json']),content=capturedFileBytes(file);
          if(!content)localInputFailure('Stored source index is missing.');
          const rawIndex=historyRecord(parseHistoryJson(content,'history index'),'history index');
          const index=isReleasedV3ActivationIdentity(rawIndex.sourceIdentity)?validateFrozenV3SourceIndex(rawIndex):validateFrozenActivationHistoryIndex(rawIndex);
          const declaredState=index.files.find(file=>file.kind==='state');
          if(!declaredState)localInputFailure('Stored source index lacks its original state.');
          preserveDeclaredPayloads(await capture(declaredState.copyPathParts));
          for(const entry of [...index.files.filter(file=>file.kind!=='state'),...index.files.filter(file=>file.kind==='state')])await capture(entry.copyPathParts);
          const inventory=index.sourceIdentity.activationContractVersion===3
            ?await validateCapturedV3SourceSnapshot(validateFrozenV3SourceIndex(index),index.files.map(entry=>present(files.get(key(entry.copyPathParts))!)))
            :await validateCapturedHistoricalSnapshot(validateFrozenActivationHistoryIndex(index),index.files.map(entry=>present(files.get(key(entry.copyPathParts))!)));
          if(!inventory.sourceMigration)break;
          id=inventory.sourceMigration.snapshotId;
        }
      }
    }
    for(const entry of physical.values())if(canonicalJson(await stamp(entry.path))!==canonicalJson(entry))localInputFailure('Installed physical inputs changed during collection.');
    const snapshot:InstalledLocalSnapshot={kind:'liftoff-modern-installed-inputs',schemaVersion:1,root:canonical,observedAt:new Date().toISOString(),
      files:[...files.values()].sort((a,b)=>compare(key(a.pathParts),key(b.pathParts))),directories:[...directories.values()].sort((a,b)=>compare(key(a.pathParts),key(b.pathParts))),
      physical:[...physical.values()].sort((a,b)=>compare(a.path,b.path))};
    return await validateCapturedModernInstalledActivation(snapshot);
  }catch(error){
    const code=errorCode(error);
    return {status:'blocked',blockers:[error instanceof ModernLocalInputError?error.message:
      code==='EACCES'||code==='EPERM'?'Installed preflight control access was denied; no readiness is inferred.':
        'Installed preflight rejected invalid, unsupported or unavailable control/history records; source values were omitted.']};
  }
}
