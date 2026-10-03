import path from 'node:path';
import type {BigIntStats} from 'node:fs';
import {canonicalJson,canonicalSha256} from './canonical-json.js';
import {copyModernLocalData,localInputFailure} from './modern-local-inputs.js';
import {exactRecord} from '../../project/manifest/fields.js';

export const openSpecDistributionPolicy=Object.freeze({
  kind:'liftoff-openspec-distribution-policy',schemaVersion:1,files:8192,directories:4096,symlinks:1024,
  totalBytes:134217728,fileBytes:8388608,depth:32,pathBytes:2048,componentBytes:255,entries:13312,entriesPerDirectory:8192,
  commitmentBytes:8192,inventoryMetadataBytes:33554432,scanTimeoutMs:30000,
  links:'internal-relative-target-only',hardlinks:'reject',exclusions:'none',ordering:'raw-utf16-code-unit-relative-path',
  canonicalization:'canonical-json-lf-v1',scan:'two-complete-matching-passes-no-cache'
});
export const distributionPhysicalFields=['dev','ino','mode','nlink','uid','gid','size','mtimeNs','ctimeNs','birthtimeNs'] as const;
export type DistributionPhysical=Record<typeof distributionPhysicalFields[number],string>;
export interface DistributionFile {pathParts:string[];bytes:number;contentDigest:string;mode:number;physical:DistributionPhysical}
export interface DistributionDirectory {pathParts:string[];physical:DistributionPhysical;entries:string[]}
export interface DistributionLink {pathParts:string[];linkText:string;canonicalTargetParts:string[];physical:DistributionPhysical}
export interface DistributionInventory {files:DistributionFile[];directories:DistributionDirectory[];links:DistributionLink[]}
export interface InstalledToolDistribution {
  kind:'liftoff-installed-tool-distribution';schemaVersion:1;scope:'complete-canonical-package-tree';policyDigest:string;
  root:{path:string;physical:DistributionPhysical};
  package:{name:'@fission-ai/openspec';version:string;metadataPathParts:['package.json'];metadataDigest:string;binName:'openspec';binPathParts:['bin','openspec.js']};
  counts:{files:number;directories:number;symlinks:number;totalBytes:number};filesDigest:string;directoriesDigest:string;symlinksDigest:string;
}
export interface OpenSpecDistributionLocator {launcherPath:string;canonicalLauncherPath:string;projectRoot:string;stagingRoot:string}
export interface DistributionLauncher {physical:DistributionPhysical;linkText:string|null;resolvedPath:string}
export function distributionPhysical(stat:BigIntStats):DistributionPhysical{
  return {dev:String(stat.dev),ino:String(stat.ino),mode:String(stat.mode),nlink:String(stat.nlink),uid:String(stat.uid),gid:String(stat.gid),size:String(stat.size),
    mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),birthtimeNs:String(stat.birthtimeNs)};
}
export function distributionOrder(a:string,b:string):number{return a<b?-1:a>b?1:0;}
export function distributionLinkTarget(linkText:string,platform:NodeJS.Platform=process.platform):string[]{
  if(typeof linkText!=='string'||!linkText||Buffer.from(linkText).toString('utf8')!==linkText||
    path.posix.isAbsolute(linkText)||path.win32.isAbsolute(linkText)||/^[A-Za-z]:/u.test(linkText)||
    platform!=='win32'&&linkText.includes('\\')||/[\u0000-\u001f\u007f]/u.test(linkText)){
    localInputFailure('Unsupported absolute or malformed distribution link.');
  }
  return linkText.split(platform==='win32'?/[\\/]/u:/\//u);
}
export function distributionPath(parts:readonly string[],allowRoot=false):void{
  if(!Array.isArray(parts)||parts.length>openSpecDistributionPolicy.depth||!allowRoot&&!parts.length||
    parts.some(p=>typeof p!=='string'||!p||p==='.'||p==='..'||/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(p)||
      Buffer.from(p,'utf8').toString('utf8')!==p||Buffer.byteLength(p)>openSpecDistributionPolicy.componentBytes||
      /[. ]$/u.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))||
    Buffer.byteLength(parts.join('/'))>openSpecDistributionPolicy.pathBytes)localInputFailure('Unsupported distribution path or path bound.');
}
export function validateDistributionPhysical(value:DistributionPhysical):void{
  exactRecord(value,distributionPhysicalFields,'Distribution physical identity');
  if(distributionPhysicalFields.some(k=>typeof value[k]!=='string'||!/^(?:0|[1-9]\d*)$/u.test(value[k])||value[k].length>24))localInputFailure('Invalid distribution physical identity.');
}
function digest(value:unknown):void{if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))localInputFailure('Invalid distribution digest.');}
export function validateInstalledToolDistribution(input:InstalledToolDistribution):InstalledToolDistribution{
  const v=copyModernLocalData(input);
  exactRecord(v,['kind','schemaVersion','scope','policyDigest','root','package','counts','filesDigest','directoriesDigest','symlinksDigest'],'Installed distribution');
  if(v.kind!=='liftoff-installed-tool-distribution'||v.schemaVersion!==1||v.scope!=='complete-canonical-package-tree'||
    v.policyDigest!==canonicalSha256(openSpecDistributionPolicy))localInputFailure('Unknown distribution identity policy.');
  exactRecord(v.root,['path','physical'],'Distribution root');validateDistributionPhysical(v.root.physical);
  if(typeof v.root.path!=='string'||!path.isAbsolute(v.root.path)||path.normalize(v.root.path)!==v.root.path||Buffer.byteLength(v.root.path)>4096)localInputFailure('Invalid canonical distribution root.');
  exactRecord(v.package,['name','version','metadataPathParts','metadataDigest','binName','binPathParts'],'Distribution package');
  if(v.package.name!=='@fission-ai/openspec'||v.package.binName!=='openspec'||! /^\d+\.\d+\.\d+$/u.test(v.package.version)||
    canonicalJson(v.package.metadataPathParts)!==canonicalJson(['package.json'])||canonicalJson(v.package.binPathParts)!==canonicalJson(['bin','openspec.js']))localInputFailure('Unsupported OpenSpec package/bin association.');
  digest(v.package.metadataDigest);
  exactRecord(v.counts,['files','directories','symlinks','totalBytes'],'Distribution counts');
  for(const [k,max]of [['files',openSpecDistributionPolicy.files],['directories',openSpecDistributionPolicy.directories],['symlinks',openSpecDistributionPolicy.symlinks],['totalBytes',openSpecDistributionPolicy.totalBytes]] as const){
    if(!Number.isSafeInteger(v.counts[k])||v.counts[k]<0||v.counts[k]>max)localInputFailure('Distribution count/byte bound exceeded.');
  }
  if(v.counts.files<2||v.counts.directories<2||v.counts.files+v.counts.directories+v.counts.symlinks>openSpecDistributionPolicy.entries)localInputFailure('Invalid complete distribution inventory counts.');
  for(const d of [v.filesDigest,v.directoriesDigest,v.symlinksDigest])digest(d);
  if(Buffer.byteLength(canonicalJson(v))>openSpecDistributionPolicy.commitmentBytes)localInputFailure('Distribution commitment exceeds8192 bytes.');
  return v;
}
export function distributionCommitment(root:string,inventory:DistributionInventory,version:string):InstalledToolDistribution{
  const order=(a:{pathParts:string[]},b:{pathParts:string[]})=>distributionOrder(a.pathParts.join('/'),b.pathParts.join('/'));
  inventory.files.sort(order);inventory.directories.sort(order);inventory.links.sort(order);
  const rootEntry=inventory.directories.find(d=>!d.pathParts.length),metadata=inventory.files.find(f=>f.pathParts.join('/')==='package.json');
  if(!rootEntry||!metadata)localInputFailure('Incomplete root/package distribution observation.');
  if(Buffer.byteLength(canonicalJson(inventory))>openSpecDistributionPolicy.inventoryMetadataBytes)localInputFailure('Distribution inventory metadata bound exceeded.');
  return validateInstalledToolDistribution({kind:'liftoff-installed-tool-distribution',schemaVersion:1,scope:'complete-canonical-package-tree',policyDigest:canonicalSha256(openSpecDistributionPolicy),
    root:{path:root,physical:rootEntry.physical},package:{name:'@fission-ai/openspec',version,metadataPathParts:['package.json'],metadataDigest:metadata.contentDigest,binName:'openspec',binPathParts:['bin','openspec.js']},
    counts:{files:inventory.files.length,directories:inventory.directories.length,symlinks:inventory.links.length,totalBytes:inventory.files.reduce((n,f)=>n+f.bytes,0)},
    filesDigest:canonicalSha256({kind:'distribution-files',schemaVersion:1,entries:inventory.files}),
    directoriesDigest:canonicalSha256({kind:'distribution-directories',schemaVersion:1,entries:inventory.directories}),
    symlinksDigest:canonicalSha256({kind:'distribution-symlinks',schemaVersion:1,entries:inventory.links})});
}
