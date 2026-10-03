import {lstat,mkdir,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {ApplicationFiles} from '../repair/application-files.js';
import {readBoundProjectFileSnapshot} from '../../adapters/filesystem/bound-project-files.js';
import {canonicalSha256} from '../../domain/governance/activation/canonical-json.js';
import {localInputFailure,rawLocalDigest} from '../../domain/governance/activation/modern-local-inputs.js';
import {openSpecInitializationPolicy,validateOpenSpecInitialization,initializationEnvironmentValues,type OpenSpecInitialization,type OpenSpecInitializationOutput} from '../../domain/governance/activation/modern-openspec-obligations.js';

export async function createOpenSpecInitializationEnvironment(workspace:string,input:OpenSpecInitialization){
  const initialization=validateOpenSpecInitialization(input),base=path.join(workspace,'cache','openspec-init');
  await mkdir(base,{mode:0o700});
  const mirror=path.join(base,'empty-provider-mirror');await mkdir(mirror,{mode:0o700});
  const config=path.join(base,'tofu.rc'),configBytes=`provider_installation {\n  filesystem_mirror {\n    path = ${JSON.stringify(mirror)}\n    include = ["*/*/*"]\n  }\n}\n`;
  await writeFile(config,configBytes,{flag:'wx',mode:0o600});
  const rootIdentity=await lstat(base,{bigint:true}),mirrorIdentity=await lstat(mirror,{bigint:true});
  const dataIdentities=new Map<string,{dev:number;ino:number;mode:number;uid:number;birthtimeMs:number}>();
  for(const r of initialization.roots){
    const target=path.join(workspace,...r.dataPathParts);await mkdir(target,{mode:0o700});dataIdentities.set(r.component,await lstat(target));
  }
  const configIdentity=await lstat(config,{bigint:true});
  async function assertControls(){
    const s=await lstat(base,{bigint:true}),m=await lstat(mirror,{bigint:true});
    if(s.ino!==rootIdentity.ino||s.dev!==rootIdentity.dev||s.mode!==rootIdentity.mode||!s.isDirectory()||s.isSymbolicLink()||
      m.ino!==mirrorIdentity.ino||m.dev!==mirrorIdentity.dev||m.mode!==mirrorIdentity.mode||!m.isDirectory()||m.isSymbolicLink()||
      (await readdir(mirror)).length)localInputFailure('Owned initialization configuration or empty provider mirror changed.');
    const file=await readBoundProjectFileSnapshot(workspace,['cache','openspec-init','tofu.rc'],{
      maximumBytes:65536,linkPolicy:'single-link',diagnostics:{pathLabel:'Owned initialization configuration',invalid:localInputFailure}});
    const identity=await lstat(config,{bigint:true});
    if(!file.content?.equals(Buffer.from(configBytes))||file.mode!==0o600||identity.ino!==configIdentity.ino||identity.dev!==configIdentity.dev||
      identity.mtimeNs!==configIdentity.mtimeNs||identity.ctimeNs!==configIdentity.ctimeNs)localInputFailure('Initialization CLI configuration changed.');
    for(const r of initialization.roots){
      const expected=dataIdentities.get(r.component)!,observed=await lstat(path.join(workspace,...r.dataPathParts));
      if(!observed.isDirectory()||observed.isSymbolicLink()||observed.dev!==expected.dev||observed.ino!==expected.ino||
        observed.mode!==expected.mode||observed.uid!==expected.uid||observed.birthtimeMs!==expected.birthtimeMs)
        localInputFailure('Initialization data root was replaced or lost its owned identity.');
    }
  }
  async function assertFresh(component:string){
    await assertControls();const r=initialization.roots.find(r=>r.component===component);if(!r)localInputFailure('Unmapped initialization root.');
    if((await readdir(path.join(workspace,...r.dataPathParts))).length)localInputFailure('Initialization data root is not fresh and empty before init.');
  }
  function environment(component:string):Record<string,string>{
    return initializationEnvironmentValues(workspace,initialization,component);
  }
  async function capture(component:string,sourceDigest:string,toolDigest:string):Promise<OpenSpecInitializationOutput>{
    await assertControls();
    const r=initialization.roots.find(r=>r.component===component);if(!r)localInputFailure('Unmapped initialization output.');
    const reader=new ApplicationFiles(path.join(workspace,...r.dataPathParts));
    let enumeratedBytes=0;
    async function walk(parts:string[]){
      if(parts.length>openSpecInitializationPolicy.dataDepth||reader.directoryInventory.length>=openSpecInitializationPolicy.dataDirectories)
        localInputFailure('Initialization output depth/directory inventory exceeds its bounds.');
      const d=await reader.inventory(parts);if(!d.exists)localInputFailure('Initialization data directory is missing.');
      for(const e of d.entries){
        const next=[...parts,e.name];if(e.kind==='directory')await walk(next);
        else if(e.kind==='file'){
          if(reader.snapshots.size>=openSpecInitializationPolicy.dataFiles)localInputFailure('Initialization file inventory exceeds its bounds.');
          const f=await reader.read(next,openSpecInitializationPolicy.dataFileBytes);enumeratedBytes+=f.content?.length??0;
          if(enumeratedBytes>openSpecInitializationPolicy.dataBytes)localInputFailure('Initialization output byte inventory exceeds its bounds.');
        }else localInputFailure('Initialization output contains a link or special file.');
      }
    }
    await walk([]);
    const entries:OpenSpecInitializationOutput['entries'][number][]=[];let bytes=0;
    for(const d of reader.directoryInventory.filter(d=>d.exists)){
      const s=await lstat(path.join(reader.root,...d.pathParts),{bigint:true});
      entries.push({pathParts:[...d.pathParts],kind:'directory',mode:d.mode!,bytes:0,digest:null,physical:[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs,s.birthtimeNs].join(':')});
    }
    for(const f of reader.snapshots.values()){
      if(!f.content)continue;bytes+=f.content.length;
      if(f.content.length>openSpecInitializationPolicy.dataFileBytes||bytes>openSpecInitializationPolicy.dataBytes)localInputFailure('Initialization output bytes exceed their fixed bounds.');
      const s=await lstat(path.join(reader.root,...f.pathParts),{bigint:true});
      entries.push({pathParts:[...f.pathParts],kind:'file',mode:f.mode!,bytes:f.content.length,digest:rawLocalDigest(f.content),
        physical:[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs,s.birthtimeNs].join(':')});
    }
    if(entries.some(e=>e.pathParts.length>openSpecInitializationPolicy.dataDepth))localInputFailure('Initialization output depth exceeds its bound.');
    entries.sort((a,b)=>a.pathParts.join('/').localeCompare(b.pathParts.join('/'),'en'));await reader.assertUnchanged();
    return {component,sourceDigest,toolDigest,environmentDigest:canonicalSha256(environment(component)),dataPathParts:[...r.dataPathParts],entries,outputDigest:canonicalSha256(entries)};
  }
  return {environment,capture,assertControls,assertFresh};
}
