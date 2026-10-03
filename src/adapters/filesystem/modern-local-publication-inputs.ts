import {lstat,opendir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {readBoundProjectFileSnapshot,assertBoundProjectPath} from './bound-project-files.js';
import {errorCode} from './errors.js';
import type {ProjectFileSnapshot} from './project-transaction.js';
import {copyModernLocalData,localInputFailure,rawLocalDigest,capturedFileBytes,type ModernLocalSnapshot} from '../../domain/governance/activation/modern-local-inputs.js';
import {installedLocalBounds,reservedLocalVerificationJournalPath,type InstalledLocalSnapshot} from '../../domain/governance/activation/modern-local-runtime.js';
import {completionDigest,completionRecord,snapshotControl,nativeCompletionPath,type CompletionProtectedIndex,type CompletionDirectory,type CompletionFile,
  type CompletionSnapshot,type CompletionTarget} from '../../domain/governance/activation/modern-local-completion.js';
import {validateManifestPathParts} from '../../domain/project/manifest/layout.js';
import {exactRecord} from '../../domain/project/manifest/fields.js';
import {reviewedUpdateTransactionPathParts,reviewedRepairTransactionPathParts} from '../../domain/project/reviewed-update-artifacts.js';

const key=(parts:readonly string[])=>parts.join('/');
const sort=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function completionSnapshot(file:ProjectFileSnapshot):CompletionSnapshot{
  return {exists:file.content!==undefined,rawDigest:file.content===undefined?null:rawLocalDigest(file.content),bytes:file.content?.length??0,mode:file.mode??null};
}
export async function readCompletionFile(root:string,parts:readonly string[]):Promise<ProjectFileSnapshot>{
  return readBoundProjectFileSnapshot(root,parts,{maximumBytes:installedLocalBounds.fileBytes,linkPolicy:'single-link',
    diagnostics:{pathLabel:'Native completion control',invalid:localInputFailure}});
}
async function physical(root:string,target:string):Promise<string|null>{
  try{
    const s=await lstat(target,{bigint:true});if(s.isSymbolicLink())localInputFailure('Completion input traverses a link.');
    const ancestor=target!==root&&!target.startsWith(root+path.sep);
    return [s.dev,s.ino,s.mode,ancestor?0:s.nlink,ancestor?0:s.size,ancestor?0:s.mtimeNs,ancestor?0:s.ctimeNs,s.birthtimeNs].join(':');
  }catch(error){if(errorCode(error)==='ENOENT')return null;throw error;}
}
async function directory(root:string,parts:string[]):Promise<CompletionDirectory>{
  if(parts.length)await assertBoundProjectPath(root,parts,{pathLabel:'Native completion directory',invalid:localInputFailure});
  const absolute=path.join(root,...parts),before=await physical(root,absolute);
  if(before===null)return {pathParts:parts,exists:false,mode:null,entries:[]};
  const stat=await lstat(absolute);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(absolute)!==absolute)localInputFailure('Completion directory boundary changed.');
  const entries:CompletionDirectory['entries']=[],aliases=new Set<string>();
  for await(const entry of await opendir(absolute)){
    if(entries.length>=installedLocalBounds.directoryEntries)localInputFailure('Completion directory membership exceeds its bound.');
    validateManifestPathParts([entry.name],'Completion member');
    const alias=entry.name.normalize('NFC').toLowerCase();if(aliases.has(alias))localInputFailure('Completion member aliases are ambiguous.');aliases.add(alias);
    entries.push({name:entry.name,kind:entry.isSymbolicLink()?'symlink':entry.isDirectory()?'directory':entry.isFile()?'file':'other'});
  }
  if(before!==await physical(root,absolute))localInputFailure('Completion directory changed during capture.');
  return {pathParts:parts,exists:true,mode:stat.mode&0o7777,entries:entries.sort((a,b)=>sort(a.name,b.name))};
}
export function validateCompletionIndex(input:CompletionProtectedIndex):CompletionProtectedIndex{
  const value=completionRecord(input,['kind','schemaVersion','projectRoot','files','directories','physical'],'Completion protected index');
  if(value.kind!=='liftoff-local-protected-index'||value.schemaVersion!==1||!path.isAbsolute(value.projectRoot)||
    !Array.isArray(value.files)||value.files.length>1536||!Array.isArray(value.directories)||value.directories.length>1280||
    !Array.isArray(value.physical)||value.physical.length>17408)localInputFailure('Invalid bounded completion index.');
  for(const file of value.files){
    exactRecord(file,['pathParts','exists','rawDigest','bytes','mode'],'Protected file');validateManifestPathParts(file.pathParts,'Protected file');
    const {pathParts:_parts,...snapshot}=file;snapshotControl(snapshot);
  }
  for(const d of value.directories){
    exactRecord(d,['pathParts','exists','mode','entries'],'Protected directory');if(d.pathParts.length)validateManifestPathParts(d.pathParts,'Protected directory');
    if(!Array.isArray(d.entries)||d.entries.length>installedLocalBounds.directoryEntries||typeof d.exists!=='boolean'||
      (!d.exists&&(d.mode!==null||d.entries.length!==0)))localInputFailure('Invalid protected directory.');
    for(const entry of d.entries){exactRecord(entry,['name','kind'],'Protected member');validateManifestPathParts([entry.name],'Protected member');if(!['file','directory','symlink','other'].includes(entry.kind))localInputFailure('Invalid protected member type.');}
  }
  for(const p of value.physical){
    exactRecord(p,['path','identity'],'Protected physical path');
    if(!path.isAbsolute(p.path)||p.path!==path.normalize(p.path)||!(p.path===value.projectRoot||p.path.startsWith(value.projectRoot+path.sep)||value.projectRoot.startsWith(p.path.endsWith(path.sep)?p.path:p.path+path.sep))||
      p.identity!==null&&!/^\d+(?::\d+){7}$/u.test(p.identity))localInputFailure('Protected physical path is invalid.');
  }
  for(const values of [value.files.map(f=>key(f.pathParts)),value.directories.map(d=>key(d.pathParts)),value.physical.map(p=>p.path)]){
    if(new Set(values.map(v=>v.normalize('NFC').toLowerCase())).size!==values.length)localInputFailure('Duplicate protected input.');
  }
  return value;
}
export async function captureCompletionInputs(installed:InstalledLocalSnapshot,local:ModernLocalSnapshot):Promise<CompletionProtectedIndex>{
  const root=installed.root;
  if(local.root!==root)localInputFailure('Completion observations belong to different roots.');
  const files=new Map<string,CompletionFile>(),dirs=new Map<string,string[]>(),observedPhysical=new Map<string,string|null>();
  for(const snapshot of [installed,local]){
    for(const file of snapshot.files){
      const content=capturedFileBytes(file),entry={pathParts:[...file.pathParts],exists:content!==undefined,rawDigest:file.digest,bytes:file.bytes,mode:file.mode};
      if(files.has(key(file.pathParts))&&completionDigest(files.get(key(file.pathParts)))!==completionDigest(entry))localInputFailure('Original captured file observations disagree.');
      files.set(key(file.pathParts),entry);
    }
    for(const d of snapshot.directories)dirs.set(key(d.pathParts),[...d.pathParts]);
    for(const p of snapshot.physical){
      if(observedPhysical.has(p.path)&&observedPhysical.get(p.path)!==p.identity)localInputFailure('Original physical observations disagree.');
      observedPhysical.set(p.path,p.identity);
    }
  }
  const native=await readCompletionFile(root,nativeCompletionPath);files.set(key(nativeCompletionPath),{pathParts:[...nativeCompletionPath],...completionSnapshot(native)});
  for(const file of files.values())for(let length=0;length<file.pathParts.length;length++)dirs.set(key(file.pathParts.slice(0,length)),file.pathParts.slice(0,length));
  const directories:CompletionDirectory[]=[];
  for(const parts of [...dirs.values()].sort((a,b)=>sort(key(a),key(b))))directories.push(await directory(root,parts));
  for(const f of [...files.values(),...directories]){
    for(let count=0;count<=f.pathParts.length;count++){
      const target=path.join(root,...f.pathParts.slice(0,count)),identity=await physical(root,target);
      if(observedPhysical.has(target)&&observedPhysical.get(target)!==identity)localInputFailure('Original physical input changed before finalization.');
      observedPhysical.set(target,identity);
    }
  }
  const index=validateCompletionIndex({kind:'liftoff-local-protected-index',schemaVersion:1,projectRoot:root,
    files:[...files.values()].sort((a,b)=>sort(key(a.pathParts),key(b.pathParts))),directories,
    physical:[...observedPhysical].map(([path,identity])=>({path,identity})).sort((a,b)=>sort(a.path,b.path))});
  await compareCompletionInputs(index,[],'original');return index;
}
export async function compareCompletionInputs(input:CompletionProtectedIndex,selected:readonly CompletionTarget[],stage:'original'|'target-pending'|'target'):Promise<void>{
  const index=validateCompletionIndex(input),targets=copyModernLocalData(selected),root=index.projectRoot,after=stage!=='original';
  if(!['original','target-pending','target'].includes(stage))localInputFailure('Unknown completion comparison stage.');
  const targetMap=new Map(targets.map(t=>[key(t.pathParts),t]));
  const changedParents=new Set<string>();
  if(after)for(const parts of [...targets.map(t=>t.pathParts),[...reservedLocalVerificationJournalPath]])for(let n=0;n<parts.length;n++)changedParents.add(key(parts.slice(0,n)));
  const expectedFiles=new Map(index.files.map(f=>[key(f.pathParts),f]));
  for(const t of targets)expectedFiles.set(key(t.pathParts),{pathParts:[...t.pathParts],...(after?t.target:t.original)});
  for(const f of expectedFiles.values()){
    if(stage==='target-pending'&&key(f.pathParts)===key(reservedLocalVerificationJournalPath)){
      const s=await lstat(path.join(root,...f.pathParts));
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)localInputFailure('Pending publication journal is not its actual ordinary file.');
      continue;
    }
    const actual=await readCompletionFile(root,f.pathParts),{pathParts:_parts,...expected}=f;
    if(completionDigest(completionSnapshot(actual))!==completionDigest(expected))localInputFailure(`Protected ${key(f.pathParts)} differs from its exact ${after?'target/original':'original'} bytes or mode.`);
  }
  for(const original of index.directories){
    const expected=copyModernLocalData(original);
    if(after){
      const additions=[...targets.map(t=>t.pathParts),...(stage==='target-pending'?[[...reservedLocalVerificationJournalPath]]:[])];
      for(const parts of additions){
        if(parts.length<=original.pathParts.length||key(parts.slice(0,original.pathParts.length))!==key(original.pathParts))continue;
        const name=parts[original.pathParts.length],kind=parts.length===original.pathParts.length+1?'file':'directory';
        const entry=expected.entries.find(entry=>entry.name===name);
        if(entry&&entry.kind!==kind)localInputFailure('Reviewed target conflicts with original member type.');
        if(!entry)expected.entries.push({name,kind});
        if(!expected.exists){expected.exists=true;expected.mode=0o700;}
      }
      expected.entries.sort((a,b)=>sort(a.name,b.name));
    }
    if(completionDigest(await directory(root,original.pathParts))!==completionDigest(expected))localInputFailure(`Protected directory ${key(original.pathParts)} changed beyond exact publication targets.`);
  }
  for(const observed of index.physical){
    const relative=path.relative(root,observed.path).split(path.sep).join('/'),actual=await physical(root,observed.path);
    if(after&&targetMap.has(relative))continue;
    if(stage==='target-pending'&&relative===key(reservedLocalVerificationJournalPath))continue;
    if(after&&changedParents.has(relative)){
      if(actual===null)localInputFailure('Publication parent is absent.');
      const a=actual.split(':'),b=observed.identity?.split(':');
      if(b&&[0,1,2,7].some(i=>a[i]!==b[i])||!b&&(Number(a[2])&0o7777)!==0o700)localInputFailure('Publication replaced an original parent boundary.');
    }else if(actual!==observed.identity)localInputFailure('Untouched protected physical input changed.');
  }
}
export async function completionPreconditions(index:CompletionProtectedIndex,targets:readonly CompletionTarget[]):Promise<ProjectFileSnapshot[]>{
  await compareCompletionInputs(index,targets,'original');
  const parts=new Map([...index.files.map(f=>[key(f.pathParts),f.pathParts] as const),...targets.map(t=>[key(t.pathParts),t.pathParts] as const)]);
  const result:ProjectFileSnapshot[]=[];
  for(const p of parts.values()){
    // The codec reserves all three journal paths itself. Their absence remains
    // in the protected index and the engine's pending-transaction admission.
    if(![reservedLocalVerificationJournalPath,reviewedUpdateTransactionPathParts,reviewedRepairTransactionPathParts].some(parts=>key(parts)===key(p))){
      result.push(await readCompletionFile(index.projectRoot,p));
    }
  }
  await compareCompletionInputs(index,targets,'original');return result;
}
