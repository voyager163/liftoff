import {constants} from 'node:fs';
import {lstat,open,opendir,readlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {canonicalJson,canonicalSha256} from '../../domain/governance/activation/canonical-json.js';
import {copyModernLocalData,localInputFailure} from '../../domain/governance/activation/modern-local-inputs.js';
import {exactRecord} from '../../domain/project/manifest/fields.js';
import {openSpecDistributionPolicy as limits,distributionPath,distributionOrder,distributionPhysical,distributionCommitment,distributionLinkTarget,validateInstalledToolDistribution,
  type DistributionInventory,type DistributionPhysical,type InstalledToolDistribution,type OpenSpecDistributionLocator,type DistributionLauncher} from '../../domain/governance/activation/installed-tool-distribution.js';

const key=(parts:readonly string[])=>parts.join('/');
const inside=(root:string,target:string)=>target===root||target.startsWith(root+path.sep);
export async function captureOpenSpecDistribution(input:OpenSpecDistributionLocator){
  const locator=copyModernLocalData(input);
  exactRecord(locator,['launcherPath','canonicalLauncherPath','projectRoot','stagingRoot'],'Observed OpenSpec locator');
  for(const p of Object.values(locator))if(typeof p!=='string'||!path.isAbsolute(p)||path.normalize(p)!==p||Buffer.byteLength(p)>4096||/[\u0000-\u001f\u007f]/u.test(p))localInputFailure('Invalid observed distribution locator.');
  if(path.basename(locator.canonicalLauncherPath)!=='openspec.js'||path.basename(path.dirname(locator.canonicalLauncherPath))!=='bin')localInputFailure('Unsupported observed OpenSpec bin layout.');
  const root=path.dirname(path.dirname(locator.canonicalLauncherPath)),started=performance.now();
  for(const protectedRoot of [locator.projectRoot,locator.stagingRoot])if(inside(protectedRoot,root)||inside(root,protectedRoot))localInputFailure('Installed distribution overlaps protected project/workspace.');
  function budget(){if(performance.now()-started>=limits.scanTimeoutMs)localInputFailure('Complete distribution scan deadline exceeded.');}
  const ancestors=new Map<string,DistributionPhysical>();
  const ancestorPaths:string[]=[];
  for(let at=root;;at=path.dirname(at)){
    ancestorPaths.push(at);if(path.dirname(at)===at)break;
  }
  for(const at of ancestorPaths.reverse()){
    budget();
    const stat=await lstat(at,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())localInputFailure('Distribution root/ancestor is not canonical.');
    ancestors.set(at,distributionPhysical(stat));budget();
  }
  async function assertAncestors(){
    budget();
    for(const [at,old]of ancestors){
      budget();
      const s=await lstat(at,{bigint:true}),current=distributionPhysical(s);
      if(!s.isDirectory()||s.isSymbolicLink()||['dev','ino','mode','uid','gid','birthtimeNs'].some(k=>current[k as keyof DistributionPhysical]!==old[k as keyof DistributionPhysical]))localInputFailure('Distribution root/ancestor replaced.');
      budget();
    }
  }
  const canonicalAnchors=new Map<string,DistributionPhysical>();
  async function assertCanonicalLauncher(){
    await assertAncestors();
    for(const [target,directory]of [[path.join(root,'bin'),true],[locator.canonicalLauncherPath,false]] as const){
      budget();
      const s=await lstat(target,{bigint:true});
      if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile()))localInputFailure('Canonical OpenSpec bin/launcher must not traverse links.');
      const observed=distributionPhysical(s),prior=canonicalAnchors.get(target);
      if(prior&&canonicalJson(prior)!==canonicalJson(observed))localInputFailure('Canonical OpenSpec bin/launcher identity changed.');
      if(!prior)canonicalAnchors.set(target,observed);
      budget();
    }
  }
  async function launcher():Promise<DistributionLauncher>{
    await assertCanonicalLauncher();
    budget();
    const s=await lstat(locator.launcherPath,{bigint:true}),linkText=s.isSymbolicLink()?await readlink(locator.launcherPath):null;
    if(!s.isSymbolicLink()&&!s.isFile())localInputFailure('Invalid observed OpenSpec launcher.');
    budget();
    const resolvedPath=await realpath(locator.launcherPath);
    if(resolvedPath!==locator.canonicalLauncherPath)localInputFailure('Observed OpenSpec launcher resolution changed.');
    await assertCanonicalLauncher();
    budget();
    if(canonicalJson(distributionPhysical(await lstat(locator.launcherPath,{bigint:true})))!==canonicalJson(distributionPhysical(s)))localInputFailure('Observed OpenSpec launcher changed during resolution.');
    budget();
    return {physical:distributionPhysical(s),linkText,resolvedPath};
  }
  const originalLauncher=await launcher();
  async function scan(){
    const inventory:DistributionInventory={files:[],directories:[],links:[]},metadata=new Map<string,unknown>(),nodes=new Map<string,'file'|'directory'|'link'>();
    let bytes=0,entries=0,metadataBytes=0;
    function addMetadata(value:unknown){metadataBytes+=Buffer.byteLength(canonicalJson(value));if(metadataBytes>limits.inventoryMetadataBytes)localInputFailure('Distribution inventory metadata bound exceeded.');}
    async function walk(parts:string[],parents:Map<string,DistributionPhysical>){
      budget();distributionPath(parts,true);
      const absolute=path.join(root,...parts),s=await lstat(absolute,{bigint:true});
      if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o7000n)!==0n)localInputFailure('Unsafe distribution directory.');
      if(++entries>limits.entries||inventory.directories.length>=limits.directories)localInputFailure('Distribution directory/entry bound exceeded.');
      const before=distributionPhysical(s),names:string[]=[],aliases=new Set<string>();
      nodes.set(key(parts),'directory');
      const directory={pathParts:parts,physical:before,entries:names};inventory.directories.push(directory);
      // Dir streams decode names; reject replacement characters rather than
      // admitting a lossy name or reading through the replacement spelling.
      for await(const entry of await opendir(absolute)){
        budget();
        const nameValue:unknown=entry.name;
        const raw=Buffer.isBuffer(nameValue)?nameValue:typeof nameValue==='string'?Buffer.from(nameValue):localInputFailure('Invalid distribution member name.');
        const name=raw.toString('utf8');
        if(name.includes('\ufffd')||!Buffer.from(name).equals(raw))localInputFailure('Distribution member name is not round-trip UTF8.');
        distributionPath([...parts,name]);const alias=name.normalize('NFC').toLowerCase();
        if(aliases.has(alias))localInputFailure('Distribution member case/normalization alias.');
        aliases.add(alias);if(names.length>=limits.entriesPerDirectory)localInputFailure('Distribution directory membership bound exceeded.');
        names.push(name);
      }
      names.sort(distributionOrder);addMetadata(directory);
      const chain=new Map(parents).set(absolute,before);
      async function assertChain(){
        await assertAncestors();
        for(const [p,expected]of chain)if(canonicalJson(distributionPhysical(await lstat(p,{bigint:true})))!==canonicalJson(expected))localInputFailure('Distribution parent changed during capture.');
      }
      for(const name of names){
        budget();await assertChain();
        const childParts=[...parts,name],child=path.join(root,...childParts),stat=await lstat(child,{bigint:true}),physical=distributionPhysical(stat);
        if(stat.isDirectory()&&!stat.isSymbolicLink()){await walk(childParts,chain);continue;}
        if(++entries>limits.entries)localInputFailure('Distribution entry bound exceeded.');
        if(stat.isSymbolicLink()){
          if(inventory.links.length>=limits.symlinks)localInputFailure('Distribution symlink bound exceeded.');
          if(stat.size>BigInt(limits.pathBytes))localInputFailure('Distribution link text bound exceeded.');
          const raw=await readlink(child,{encoding:'buffer'}),linkText=raw.toString('utf8');
          if(!Buffer.from(linkText).equals(raw))localInputFailure('Unsupported absolute or malformed distribution link.');
          distributionLinkTarget(linkText);
          const link={pathParts:childParts,linkText,canonicalTargetParts:[] as string[],physical};
          inventory.links.push(link);nodes.set(key(childParts),'link');addMetadata(link);
        }else{
          if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o7000n)!==0n)localInputFailure('Distribution file is special, hard-linked or unsafe.');
          if(inventory.files.length>=limits.files||stat.size>BigInt(limits.fileBytes)||BigInt(bytes)+stat.size>BigInt(limits.totalBytes))localInputFailure('Distribution file/count/byte bound exceeded.');
          const isMetadata=name==='package.json'&&(parts.length===0||/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/u.test(key(parts)));
          if(isMetadata&&stat.size>65536n)localInputFailure('Distribution package metadata exceeds supported64KiB.');
          const handle=await open(child,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)),hash=createHash('sha256'),chunks:Buffer[]=[];
          try{
            if(canonicalJson(distributionPhysical(await handle.stat({bigint:true})))!==canonicalJson(physical))localInputFailure('Distribution file changed at open.');
            let offset=0;const buffer=Buffer.alloc(Math.min(1024*1024,Number(stat.size)+1));
            while(offset<Number(stat.size)){
              budget();const got=await handle.read(buffer,0,Math.min(buffer.length,Number(stat.size)-offset),offset);
              if(!got.bytesRead)localInputFailure('Distribution file truncated during scan.');
              hash.update(buffer.subarray(0,got.bytesRead));if(isMetadata)chunks.push(Buffer.from(buffer.subarray(0,got.bytesRead)));offset+=got.bytesRead;
            }
            if(canonicalJson(distributionPhysical(await handle.stat({bigint:true})))!==canonicalJson(physical))localInputFailure('Distribution file changed during read.');
          }finally{await handle.close();}
          const entry={pathParts:childParts,bytes:Number(stat.size),contentDigest:hash.digest('hex'),mode:Number(stat.mode&0o7777n),physical};
          inventory.files.push(entry);nodes.set(key(childParts),'file');bytes+=entry.bytes;addMetadata(entry);
          if(isMetadata){const raw=Buffer.concat(chunks),text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))localInputFailure('Invalid package metadata encoding.');metadata.set(key(parts),JSON.parse(text));}
        }
        if(canonicalJson(distributionPhysical(await lstat(child,{bigint:true})))!==canonicalJson(physical))localInputFailure('Distribution entry changed during scan.');
        await assertChain();
      }
      await assertChain();
    }
    await walk([],new Map());
    const links=new Map(inventory.links.map(l=>[key(l.pathParts),l]));
    function resolve(parts:string[],visited=new Set<string>()):string[]{
      let resolved:string[]=[];
      for(let i=0;i<parts.length;i++){
        const part=parts[i];if(part==='.'||!part)continue;
        if(part==='..'){if(!resolved.length)localInputFailure('Distribution symlink escapes its admitted root.');resolved.pop();continue;}
        resolved.push(part);
        const name=key(resolved),kind=nodes.get(name);if(!kind)localInputFailure('Dangling distribution link or package target.');
        if(kind==='link'){
          if(visited.has(name)||visited.size>=limits.symlinks)localInputFailure('Cyclic distribution link.');
          const next=new Set(visited).add(name),link=links.get(name)!;
          return resolve([...resolved.slice(0,-1),...distributionLinkTarget(link.linkText),...parts.slice(i+1)],next);
        }
        if(i<parts.length-1&&kind!=='directory')localInputFailure('Distribution link traverses a non-directory.');
      }
      return resolved;
    }
    for(const link of inventory.links)link.canonicalTargetParts=resolve([...link.pathParts.slice(0,-1),...link.linkText.split('/')]);
    // Support the installed npm package layout, not arbitrary Node loaders.
    for(const [packageDir,raw]of metadata){
      if(!raw||typeof raw!=='object'||Array.isArray(raw))localInputFailure('Malformed installed package metadata.');
      const pkg=raw as Record<string,unknown>;
      if(packageDir===''&&(pkg.name!=='@fission-ai/openspec'||pkg.type!=='module'||!pkg.bin||typeof pkg.bin!=='object'||
        Reflect.get(pkg.bin,'openspec')!=='./bin/openspec.js'||typeof pkg.version!=='string'))localInputFailure('Unsupported OpenSpec package/bin loader association.');
      for(const field of ['dependencies','optionalDependencies']){
        const deps=pkg[field];if(deps===undefined)continue;
        if(!deps||typeof deps!=='object'||Array.isArray(deps))localInputFailure('Unsupported dependency metadata.');
        for(const [name,range]of Object.entries(deps)){
          if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)||typeof range!=='string'||/^(?:file:|link:|git|https?:)/iu.test(range))localInputFailure('Unsupported distribution dependency source.');
          let current=packageDir,found=false;
          for(;;){
            if(path.posix.basename(current)!=='node_modules'){
              const candidate=key([...(current?current.split('/'):[]),'node_modules',...name.split('/')]);
              if(metadata.has(candidate)){const dep=metadata.get(candidate);if(!dep||typeof dep!=='object'||Reflect.get(dep,'name')!==name)localInputFailure('Nested dependency identity mismatch.');found=true;break;}
            }
            if(!current)break;current=path.posix.dirname(current);if(current==='.')current='';
          }
          if(!found&&field==='dependencies')localInputFailure(`Required installed dependency is outside the complete distribution: ${name}`);
        }
      }
      const validateTarget=(value:unknown,field:string):void=>{
        if(value===null)return;
        if(typeof value==='string'){
          if(field==='exports'||field==='imports'){
            if(!value.startsWith('./'))localInputFailure('Unsupported external package export/import target.');
          }
          if(path.posix.isAbsolute(value)||path.win32.isAbsolute(value)||value.includes('\\'))localInputFailure('Package loader target escapes its root.');
          const relative=path.posix.normalize(value),target=path.posix.normalize(path.posix.join(packageDir,relative)).replace(/\/$/u,'');
          if(relative==='..'||relative.startsWith('../'))localInputFailure('Package loader target escapes its package.');
          if(value.includes('*'))return; // Literal pattern is committed; no external prefix is admitted.
          const options=[target,target+'.js',target+'.json',target+'/index.js'];
          if(!options.some(p=>nodes.has(p)))localInputFailure('Unsupported missing installed package loader target.');
          return;
        }
        if(Array.isArray(value)){for(const v of value)validateTarget(v,field);return;}
        if(value&&typeof value==='object'){for(const v of Object.values(value))validateTarget(v,field);return;}
        localInputFailure('Unsupported package loader declaration.');
      };
      for(const field of ['main','exports','imports'])if(pkg[field]!==undefined)validateTarget(pkg[field],field);
    }
    if(nodes.get('bin/openspec.js')!=='file')localInputFailure('OpenSpec canonical launcher is not a regular package member.');
    const pkg=metadata.get('') as Record<string,unknown>;
    const commitment=distributionCommitment(root,inventory,String(pkg.version));
    budget();return {inventory,commitment};
  }
  const first=await scan(),second=await scan();
  if(canonicalJson(first)!==canonicalJson(second)||canonicalJson(await launcher())!==canonicalJson(originalLauncher))localInputFailure('Installed OpenSpec distribution changed between complete scans.');
  await assertAncestors();budget();
  return {...second,launcher:originalLauncher};
}
export async function assertOpenSpecDistributionCurrent(locator:OpenSpecDistributionLocator,expected:InstalledToolDistribution){
  const recorded=validateInstalledToolDistribution(expected),captured=copyModernLocalData(locator);
  const actual=await captureOpenSpecDistribution(captured);
  if(canonicalSha256(actual.commitment)!==canonicalSha256(recorded))localInputFailure('Complete installed OpenSpec distribution identity changed.');
  return actual;
}
