import {mkdtemp,realpath,lstat,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {runCli} from '../src/cli.js';
import {runCommand} from '../src/commands.js';
import {CaptureStream,ttyCaptureStream} from './helpers.js';
import type {SemanticTelemetryEvent} from '../src/telemetry/contract.js';
const f=vi.hoisted(()=>({
  failedVerification:false,throwVerification:false,committed:true,cleanup:false,throwReadback:false,verified:false,declineAt:0,promptCount:0,
  recover:false,recoveryBlocked:false,infrastructure:false,infrastructureBlocked:false,root:'',calls:[] as string[],reports:[] as unknown[],
  nonTTY:false,preparation:false,network:false,disconnectAfterPrompt:0,disconnectAfterVerification:false,disconnect:()=>{},
  stalePreview:false,mismatchedPreview:false
}));
const fingerprint='a'.repeat(64);
vi.mock('../src/application/project/manifest.js',async original=>({...await original<typeof import('../src/application/project/manifest.js')>(),
  loadManifest:vi.fn(async()=>({artifactVersion:7,projectArtifacts:[],project:{workload:{environments:['dev']}}})),
  loadProjectManifest:vi.fn(async()=>({artifactVersion:7,projectArtifacts:[],project:{workload:{environments:['dev']}}})),
  parseManifest:vi.fn(()=>({}))
}));
vi.mock('../src/domain/project/infrastructure-layout.js',async original=>({...await original<typeof import('../src/domain/project/infrastructure-layout.js')>(),
  assessInfrastructureLayout:()=>({kind:'independent'})
}));
vi.mock('../src/application/repair/infrastructure.js',()=>({inspectInfrastructureRepair:vi.fn(async()=>({
  layout:'legacy',blockers:f.infrastructureBlocked?['injected unsafe layout']:[],mutations:[],snapshots:[],artifacts:[],resourceGroups:[],statePaths:[],directoryInventory:[]
}))}));
vi.mock('../src/application/repair/discovery.js',async original=>({...await original<typeof import('../src/application/repair/discovery.js')>(),
  discoverRepairEligibility:vi.fn(async()=>({blockers:[],observations:[],status:'absent'}))
}));
vi.mock('../src/adapters/filesystem/project-transaction.js',async original=>({...await original<typeof import('../src/adapters/filesystem/project-transaction.js')>(),
  captureProjectFileSnapshot:vi.fn(async(_root,parts:string[])=>({pathParts:parts,content:parts.length===1?Buffer.from('{}'):undefined}))
}));
vi.mock('../src/adapters/filesystem/update-previews.js',async original=>({...await original<typeof import('../src/adapters/filesystem/update-previews.js')>(),
  createScopedUserLocalRecordStore:()=>({write:vi.fn(async()=>({path:'/injected/preview'}))})
}));
vi.mock('../src/adapters/filesystem/reviewed-update-transaction.js',async original=>({...await original<typeof import('../src/adapters/filesystem/reviewed-update-transaction.js')>(),
  inspectReviewedUpdateTransaction:vi.fn(async()=>({status:'absent'})),
  recoverReviewedUpdateTransaction:vi.fn(async()=>({status:f.recoveryBlocked?'blocked':'rolled-back',committed:false,rollbackFailures:f.recoveryBlocked?['injected recovery failure']:[],cleanupFailures:[]})),
  applyReviewedUpdateTransaction:vi.fn(async()=>{f.calls.push('apply');return {committed:f.committed,rollbackFailures:[],cleanupFailures:f.cleanup?['injected cleanup failure']:[]};})
}));
vi.mock('../src/application/repair/workspaces.js',()=>({
  inspectRepairVerificationWorkspaces:vi.fn(async()=>({status:'absent',issues:[],workspaces:[]})),
  recoverRepairVerificationWorkspaces:vi.fn(async()=>({status:'absent',issues:[],results:[]}))
}));
vi.mock('../src/application/repair/preview.js',async original=>{
  const actual=await original<typeof import('../src/application/repair/preview.js')>();
  const preview=()=>({fingerprint:'a'.repeat(64),createdAt:'2026-10-01T00:00:00Z',expiresAt:'2026-10-02T00:00:00Z',
    recipe:{id:'application-layout-patch'},applicationPatchPath:'/injected/patch',verificationDigest:'b'.repeat(64)});
  return {...actual,buildRepairPreview:preview,loadRepairPreview:vi.fn(async()=>{
      if(f.stalePreview)throw new Error('injected stale preview');
      return {...preview(),...(f.mismatchedPreview?{fingerprint:'d'.repeat(64)}:{})};
    }),
    snapshotDescriptors:(s:unknown)=>s,mutationDescriptors:(s:unknown)=>s,repairApprovalStore:()=>({})};
});
vi.mock('../src/application/repair/application-patch.js',()=>({
  applicationCandidateDigest:()=> 'c'.repeat(64),
  inspectApplicationPatch:vi.fn(async()=>({
    patchPath:'/injected/patch',blockers:[],snapshots:[],mutations:[],report:{effects:[]},
    scope:{sourceLayout:'explicit-project-file-mapping-v1'},
    verificationPolicy:{effects:{preparation:f.preparation,network:f.network},preparation:[],
      commands:[{executable:'injected-never-executed',args:[],cwdPathParts:[],timeoutMs:1000,network:false}]}
  })),
  verifyApplicationPatch:vi.fn(async()=>{
    f.calls.push('verify');if(f.throwVerification)throw new Error('injected verifier exception');
    if(f.disconnectAfterVerification)f.disconnect();
    return {status:f.failedVerification?'failed':'passed',inspectedProjectUnchanged:true,cleanupComplete:true,
      candidateDigest:'c'.repeat(64),verificationPolicyDigest:'b'.repeat(64),commands:[{passed:!f.failedVerification}],blockers:f.failedVerification?['injected verifier failure']:[]};
  })
}));
vi.mock('../src/application/repair/verification-receipt.js',()=>({
  readRepairVerification:vi.fn(async()=>f.verified?{networkAuthorized:false}:null),
  saveRepairVerification:vi.fn(async()=>{f.calls.push('save-verification');f.verified=true;return {networkAuthorized:false};})
}));
vi.mock('../src/application/repair/backup.js',()=>({preserveRepairOriginals:vi.fn(async()=>{f.calls.push('backup');return {path:'/injected/backup',indexKey:'injected'};})}));
vi.mock('../src/application/repair/history.js',()=>({repairHistoryMutations:()=>[]}));
vi.mock('../src/application/repair/active-binding-publication.js',()=>({
  createActiveBindingPublicationIntent:()=>null,
  prepareActiveBindingPublication:vi.fn(async()=>null),
  publishActiveBindingPlan:vi.fn(),
  readActiveBindingPublicationPlan:vi.fn(async()=>null)
}));
vi.mock('../src/application/repair/readback.js',()=>({assertRepairReadback:vi.fn(async()=>{f.calls.push('readback');if(f.throwReadback)throw new Error('injected readback failure');})}));
vi.mock('../src/application/repair/guidance.js',async original=>({...await original<typeof import('../src/application/repair/guidance.js')>(),repairAgentActions:()=>[],repairResumeActions:()=>[]}));
vi.mock('../src/application/repair/report.js',async original=>({...await original<typeof import('../src/application/repair/report.js')>(),emitRepairReport:(_ctx:unknown,_json:unknown,report:unknown)=>{f.reports.push(report);}}));
const roots:{root:string;ino:number;dev:number}[]=[];
beforeEach(async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'semantic-repair-'))),s=await lstat(root);roots.push({root,ino:s.ino,dev:s.dev});
  Object.assign(f,{failedVerification:false,throwVerification:false,committed:true,cleanup:false,throwReadback:false,verified:false,declineAt:0,promptCount:0,recover:false,recoveryBlocked:false,infrastructure:false,infrastructureBlocked:false,root,calls:[],reports:[]});
  Object.assign(f,{nonTTY:false,preparation:false,network:false,disconnectAfterPrompt:0,disconnectAfterVerification:false,disconnect:()=>{},stalePreview:false,mismatchedPreview:false});
});
afterEach(async()=>{for(const r of roots.splice(0)){const s=await lstat(r.root);expect(s.ino).toBe(r.ino);expect(s.dev).toBe(r.dev);await rm(r.root,{recursive:true});}});
async function invoke(args:string[]=[]){
  const stdout=new CaptureStream(),stderr=f.nonTTY?new CaptureStream():ttyCaptureStream(),stdin=new Readable({read(){}});
  Object.defineProperty(stdin,'isTTY',{value:!f.nonTTY});f.disconnect=()=>{stdin.destroy();};
  const events:SemanticTelemetryEvent[]=[];
  try{
    const code=await runCli({argv:['repair',f.root,...(f.recover?['--recover']:f.infrastructure||args.includes('--verify-plan')?[]:['--application-patch','/injected/patch']),...args],
      cwd:f.root,env:{},stdout,stderr,stdin,telemetry:{beforeCommand:async()=>true,afterCommand:async()=>{},afterSemanticCommand:async event=>{events.push(event);}},
      execute:(parsed,ctx)=>runCommand(parsed,{...ctx,approveRepairPlan:async()=>{
        f.calls.push('prompt');f.promptCount++;
        if(f.promptCount===f.disconnectAfterPrompt)f.disconnect();
        return f.promptCount!==f.declineAt;
      }})});
    return {code,event:events[0],report:f.reports.at(-1)};
  }finally{stdin.destroy();}
}
describe('actual repair semantic producer paths with injected effects',()=>{
  it.each(['non-TTY','check','json'] as const)('keeps an available application preview as attention via %s',async mode=>{
    f.nonTTY=mode==='non-TTY';
    expect(await invoke(mode==='non-TTY'?[]:[`--${mode}`])).toMatchObject({
      code:2,event:{outcome:'attention-required'},report:{status:'available',committed:false,verificationEffects:{attempted:false,outcome:'not-run'}}
    });
    expect(f.calls).toEqual([]);expect(f.promptCount).toBe(0);
  });
  it.each(['preparation','verification','file'] as const)('waits for explicit %s consent on non-TTY streams without running effects',async phase=>{
    f.nonTTY=true;f.preparation=phase==='preparation';f.verified=phase==='file';
    const result=await invoke();
    expect(result).toMatchObject({
      code:2,event:{outcome:'attention-required'},report:{committed:false,verificationEffects:{attempted:false,outcome:'not-run'}}
    });
    if(phase==='file')expect(result.report).toMatchObject({approval:{status:'required'},verification:'passed'});
    else expect(result.report).toMatchObject({status:'available'});
    expect(f.calls).toEqual([]);expect(f.promptCount).toBe(0);
  });
  it('waits for verification consent after preparation was separately approved but the terminal closed',async()=>{
    f.preparation=true;f.disconnectAfterPrompt=1;
    expect(await invoke()).toMatchObject({
      code:2,event:{outcome:'attention-required'},report:{status:'available',committed:false,verificationEffects:{attempted:false}}
    });
    expect(f.calls).toEqual(['prompt']);
  });
  it('waits for network consent after verification was separately approved without executing either effect',async()=>{
    f.network=true;f.disconnectAfterPrompt=1;
    expect(await invoke()).toMatchObject({
      code:2,event:{outcome:'attention-required'},report:{approval:{status:'required'},committed:false,verificationEffects:{attempted:false}}
    });
    expect(f.calls).toEqual(['prompt']);
  });
  it('requires separate file consent after already approved verification when the terminal closes',async()=>{
    f.disconnectAfterVerification=true;
    expect(await invoke()).toMatchObject({
      code:2,event:{outcome:'attention-required'},report:{approval:{status:'required'},committed:false,verificationEffects:{attempted:true,outcome:'passed'}}
    });
    expect(f.calls).toEqual(['prompt','verify','save-verification']);
  });
  it.each(['preparation','network'] as const)('keeps an actual %s decline distinct from required consent',async phase=>{
    f.preparation=phase==='preparation';f.network=phase==='network';f.declineAt=phase==='preparation'?1:2;
    expect(await invoke()).toMatchObject({
      code:2,event:{outcome:'cancelled'},report:{approval:{status:'declined'},committed:false,verificationEffects:{attempted:false}}
    });
    expect(f.calls).toEqual(phase==='preparation'?['prompt']:['prompt','prompt']);
  });
  it.each(['stale','mismatched'] as const)('keeps %s saved verification authority as failure, not pending consent',async kind=>{
    f.nonTTY=true;f.stalePreview=kind==='stale';f.mismatchedPreview=kind==='mismatched';
    expect(await invoke(['--verify-plan',fingerprint])).toMatchObject({code:1,event:{outcome:'failure'},report:{status:'failed',committed:false}});
    expect(f.calls).toEqual([]);
  });
  it('rejects malformed authority before disclosure or effects rather than treating it as a consent request',async()=>{
    f.nonTTY=true;
    expect(await invoke(['--verify-plan','invalid'])).toEqual({code:1,event:undefined,report:undefined});
    expect(f.calls).toEqual([]);
  });
  it('rejects a verification receipt missing required network authority before requesting file consent',async()=>{
    f.nonTTY=true;f.network=true;f.verified=true;
    expect(await invoke()).toMatchObject({code:1,event:{outcome:'failure'},report:{status:'failed',committed:false}});
    expect(f.calls).toEqual([]);
  });
  it.each([false,true])('distinguishes infrastructure check availability from blockers: blocked=%s',async blocked=>{
    f.infrastructure=true;f.infrastructureBlocked=blocked;
    expect(await invoke(['--check'])).toMatchObject({code:2,event:{outcome:blocked?'failure':'attention-required'},report:{status:blocked?'blocked':'available'}});
    expect(f.calls).toEqual([]);
  });
  it('separates available preview from attempted failed verification with the same exit2',async()=>{
    expect(await invoke(['--check'])).toMatchObject({code:2,event:{outcome:'attention-required'},report:{status:'available',committed:false}});
    expect(f.calls).toEqual([]);f.failedVerification=true;
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'failure'},report:{status:'partial',committed:false}});
    expect(f.calls).toEqual(['prompt','verify']);
  });
  it('reports verification decline before effects as cancellation',async()=>{
    f.declineAt=1;
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'cancelled'},report:{approval:{status:'declined'},committed:false}});
    expect(f.calls).toEqual(['prompt']);
  });
  it('reports separate file decline after successful verification without claiming rollback',async()=>{
    f.declineAt=2;
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'cancelled'},report:{verificationEffects:{attempted:true,outcome:'passed'},committed:false}});
    expect(f.calls).toEqual(['prompt','verify','save-verification','prompt']);
  });
  it('retains an actual verifier exception as failure, not cancellation',async()=>{
    f.throwVerification=true;
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'failure'},report:{status:'partial',committed:false}});
    expect(f.calls).toEqual(['prompt','verify']);
  });
  it.each(['rollback','cleanup','readback'] as const)('records actual %s partial failure, not expected attention',async kind=>{
    f.verified=true;f.committed=kind!=='rollback';f.cleanup=kind==='cleanup';f.throwReadback=kind==='readback';
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'failure'},report:{status:'partial',committed:kind!=='rollback'}});
    expect(f.calls.slice(0,3)).toEqual(['prompt','backup','apply']);
  });
  it('keeps full verified commit a normal success',async()=>{
    expect(await invoke()).toMatchObject({code:0,event:{outcome:'success'},report:{status:'applied',committed:true}});
    expect(f.calls).toEqual(['prompt','verify','save-verification','prompt','backup','apply','readback']);
  });
  it('retains scoped verification success without claiming file application',async()=>{
    expect(await invoke(['--verify-plan',fingerprint])).toMatchObject({code:0,event:{outcome:'success'},report:{status:'verified',committed:false}});
    expect(f.calls).toEqual(['verify','save-verification']);
  });
  it('distinguishes repaired recovery requiring review from a blocked failed recovery',async()=>{
    f.recover=true;
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'attention-required'},report:{status:'recovered'}});
    f.recoveryBlocked=true;
    expect(await invoke()).toMatchObject({code:2,event:{outcome:'failure'},report:{status:'blocked'}});
    expect(f.calls).toEqual([]);
  });
});
