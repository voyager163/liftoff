import {randomBytes} from 'node:crypto';
import {lstat,mkdir,readdir,realpath,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {resolveUpdatePreviewLocation,type LocalExecutionRecordStore} from './update-previews.js';
import {canonicalWorkspaceBoundary,captureWorkspaceDirectoryChain,createRegisteredWorkspaceDirectory,
  deleteCapturedWorkspace,assertWorkspaceDirectorySnapshot,workspaceFileIdentity} from './repair-workspaces.js';
import {canonicalSha256,canonicalJson} from '../../domain/governance/activation/canonical-json.js';
import {localInputFailure,copyModernLocalData,capturedFileBytes,validateModernLocalSnapshot,type ModernLocalSnapshot} from '../../domain/governance/activation/modern-local-inputs.js';
import {validateLocalExecutionPreview,validateLocalExecutionState,assertExecutableLocalExecutionPreview,type LocalExecutionPreview,type LocalExecutionState} from '../../domain/governance/activation/modern-local-runtime.js';
import type {RepairWorkspaceFileIdentity,RepairWorkspaceRole} from '../../application/repair/workspaces-types.js';
import {captureLocalExecutionStore,loadLocalExecutionConsent} from '../../application/governance/modern-local-approval.js';

const roles=['project','home','cache','scratch'] as const;
const liveOwners=new Set<string>();
export interface LocalExecutionWorkspace {
  readonly directory:string;
  readonly roles:Readonly<Record<RepairWorkspaceRole,string>>;
  readonly state:()=>LocalExecutionState;
  checkpoint(phase:LocalExecutionState['phase']):Promise<void>;
  begin(activity:NonNullable<LocalExecutionState['activity']>):Promise<void>;
  settle():Promise<void>;
  uncertain():Promise<void>;
  finish(resultDigest:string):Promise<void>;
  cleanup():Promise<void>;
}
export async function createModernLocalWorkspace(root:string,preview:LocalExecutionPreview,port:LocalExecutionRecordStore):Promise<LocalExecutionWorkspace>{
  preview=validateLocalExecutionPreview(preview,new Date());const store=captureLocalExecutionStore(port,root);
  assertExecutableLocalExecutionPreview(preview);
  if(preview.schemaVersion===3||preview.schemaVersion===4||preview.schemaVersion===5)await loadLocalExecutionConsent(root,preview,store);
  if(preview.projectRoot!==root)localInputFailure('Local workspace intent root mismatch.');
  const project=await canonicalWorkspaceBoundary(root);
  const ownerToken=randomBytes(32).toString('hex'),ownerTokenDigest=canonicalSha256(ownerToken);
  let value:LocalExecutionState={kind:'liftoff-local-execution-state',schemaVersion:1,projectRoot:root,fingerprint:preview.fingerprint,operationId:preview.operationId,
    phase:'claimed',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),workspace:null,activity:null,settledActivities:0,resultDigest:null,ownerTokenDigest};
  let saved=await store.compareExchangeState(preview.fingerprint,null,value);
  liveOwners.add(ownerTokenDigest);
  const location=await resolveUpdatePreviewLocation(root);
  if(location.projectRoot!==root)localInputFailure('Workspace storage resolves to another project.');
  const privateBase=path.join(location.directory,'local-execution-workspaces');
  const existingParents=await captureWorkspaceDirectoryChain(location.directory);
  await assertWorkspaceDirectorySnapshot(existingParents);
  try{await mkdir(privateBase,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const parent=await lstat(privateBase);
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o777)!==0o700||parent.uid!==process.getuid?.()||await realpath(privateBase)!==privateBase)localInputFailure('Local workspace private parent is unsafe.');
  const directory=path.join(privateBase,preview.operationId),parents=await captureWorkspaceDirectoryChain(privateBase);
  const creationIdentity=await createRegisteredWorkspaceDirectory(directory,parents,{});
  const roleIdentities={} as Record<RepairWorkspaceRole,{path:string;identity:RepairWorkspaceFileIdentity}>;
  for(const role of roles){
    const target=path.join(directory,role);await mkdir(target,{mode:0o700});roleIdentities[role]={path:target,identity:workspaceFileIdentity(await lstat(target,{bigint:true}))};
  }
  const authority={kind:'liftoff-local-execution-workspace-authority',schemaVersion:1,projectRoot:root,fingerprint:preview.fingerprint,operationId:preview.operationId,
    ownerToken,projectIdentity:project.identity,directory,creationIdentity,roles:roleIdentities};
  await store.write('workspace-authority',preview.fingerprint,authority);
  async function update(next:LocalExecutionState):Promise<void>{
    const current=await store.readState(preview.fingerprint);
    if(!current||current.digest!==saved.digest||!liveOwners.has(ownerTokenDigest))localInputFailure('Local workspace owner/progress changed.');
    value=validateLocalExecutionState({...next,updatedAt:new Date().toISOString()},preview);
    saved=await store.compareExchangeState(preview.fingerprint,saved.digest,value);
  }
  async function assertOwned():Promise<void>{
    const record=await store.read('workspace-authority',preview.fingerprint);
    if(!record||canonicalJson(record.value)!==canonicalJson(authority)||!liveOwners.has(ownerTokenDigest)||
      canonicalJson((await canonicalWorkspaceBoundary(root)).identity)!==canonicalJson(project.identity)||
      canonicalJson((await canonicalWorkspaceBoundary(directory)).identity)!==canonicalJson(creationIdentity))localInputFailure('Local workspace identity or authenticated owner changed.');
    for(const role of roles)if(canonicalJson((await canonicalWorkspaceBoundary(roleIdentities[role].path)).identity)!==canonicalJson(roleIdentities[role].identity))localInputFailure('Local workspace role identity changed.');
  }
  await update({...value,workspace:directory,phase:'copying'});
  return {
    directory,roles:Object.freeze(Object.fromEntries(roles.map(role=>[role,roleIdentities[role].path])) as Record<RepairWorkspaceRole,string>),
    state:()=>copyModernLocalData(value),
    checkpoint:async phase=>{await assertOwned();await update({...value,phase});},
    begin:async activity=>{activity=copyModernLocalData(activity);await assertOwned();if(value.activity||value.phase==='uncertain')localInputFailure('Unsettled workspace activity forbids dispatch.');await update({...value,activity});},
    settle:async()=>{await assertOwned();if(!value.activity)localInputFailure('No owned activity to settle.');await update({...value,activity:null,settledActivities:value.settledActivities+1});},
    uncertain:async()=>{await update({...value,phase:'uncertain'});},
    finish:async resultDigest=>{if(value.activity||value.phase==='uncertain')localInputFailure('Uncertain execution cannot finish.');await update({...value,phase:'finished',resultDigest});liveOwners.delete(ownerTokenDigest);},
    cleanup:async()=>{
      await assertOwned();if(value.activity||value.phase==='uncertain')localInputFailure('Unsettled execution workspace is retained.');
      await deleteCapturedWorkspace({directory,creationIdentity,roles:roleIdentities,privateBoundaries:[location.directory,privateBase],protectedRoots:[root]}, {},async()=>{},async()=>{
        const original=(await canonicalWorkspaceBoundary(root)).identity;
        if(canonicalJson(original)!==canonicalJson(project.identity)||!liveOwners.has(ownerTokenDigest))localInputFailure('Original root/workspace ownership changed before cleanup.');
      });
    }
  };
}
export async function copyModernLocalWorkspace(snapshot:ModernLocalSnapshot,workspace:LocalExecutionWorkspace):Promise<void>{
  const captured=copyModernLocalData(snapshot);
  validateModernLocalSnapshot(captured);
  for(const file of captured.files){
    if(file.content===null)continue;
    if(file.pathParts[0]==='governance')continue;
    const target=path.join(workspace.roles.project,...file.pathParts),relative=path.relative(workspace.roles.project,target);
    if(relative.startsWith('..')||path.isAbsolute(relative))localInputFailure('Captured local input escapes workspace.');
    await mkdir(path.dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,capturedFileBytes(file)!,{flag:'wx',mode:0o600});await chmod(target,file.mode!);
  }
  for(const directory of [...captured.directories].filter(d=>d.exists).sort((a,b)=>b.pathParts.length-a.pathParts.length)){
    if(directory.pathParts[0]==='governance')continue;
    const target=path.join(workspace.roles.project,...directory.pathParts);
    await mkdir(target,{recursive:true,mode:0o700});if(directory.pathParts.length)await chmod(target,directory.mode!);
  }
}
