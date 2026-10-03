import {Readable} from 'node:stream';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {runCli} from '../src/cli.js';
import {runCommand} from '../src/commands.js';
import {CaptureStream,ttyCaptureStream} from './helpers.js';
import type {SemanticTelemetryEvent} from '../src/telemetry/contract.js';
const f=vi.hoisted(()=>({
  work:true,requiresApproval:true,eligible:true,agentPending:false,skipped:false,revalidate:false,revalidationBlocked:false,cleanup:false,committed:true,
  recovery:false,recoveryBlocked:false,throwInspection:false,calls:[] as string[]
}));
vi.mock('../src/adapters/filesystem/project-discovery.js',()=>({findProjectRoot:vi.fn(async()=>'/owned-injected-project')}));
vi.mock('../src/application/project/manifest.js',async original=>({...await original<typeof import('../src/application/project/manifest.js')>(),loadManifest:vi.fn(async()=>({}))}));
vi.mock('../src/adapters/filesystem/update-previews.js',async original=>({...await original<typeof import('../src/adapters/filesystem/update-previews.js')>(),
  createUpdateTransactionApprovalStore:()=>({}),
  issueUpdatePreviewReceipt:vi.fn(async()=>{f.calls.push('issue-preview');return {location:{receiptPath:'/injected/preview'}};}),
  resolveUpdatePreviewLocation:vi.fn(async()=>({receiptPath:'/injected/preview'})),
  loadUpdatePreviewReceipt:vi.fn(async()=>{f.calls.push('load-preview');return {receipt:{}};}),
  consumeUpdatePreviewReceipt:vi.fn(async()=>{f.calls.push('consume-preview');})
}));
vi.mock('../src/adapters/filesystem/reviewed-update-transaction.js',async original=>({...await original<typeof import('../src/adapters/filesystem/reviewed-update-transaction.js')>(),
  inspectReviewedUpdateTransaction:vi.fn(async(_root,options)=>({status:options?.transactionKind==='repair'?'absent':f.recovery?'interrupted':'absent',committed:false})),
  recoverReviewedUpdateTransaction:vi.fn(async()=>({status:f.recoveryBlocked?'blocked':'rolled-back',committed:false,rollbackFailures:f.recoveryBlocked?['injected failure']:[],cleanupFailures:[]})),
  applyReviewedUpdateTransaction:vi.fn(async()=>{
    f.calls.push('apply-transaction');return {status:f.committed?'committed':'rolled-back',committed:f.committed,rollbackFailures:[],cleanupFailures:f.cleanup?['injected cleanup failure']:[]};
  })
}));
vi.mock('../src/application/update/inspection.js',async original=>({...await original<typeof import('../src/application/update/inspection.js')>(),
  inspectProjectUpdate:vi.fn(async()=>{
    if(f.throwInspection)throw new Error('injected inspection failure');
    return {projectRoot:'/owned-injected-project',hasDrift:f.work,deferredAgentRepair:f.agentPending?{}:null,summary:{unchanged:1,conflict:0,retiredConflict:0},
      reconciliation:{remedy:'injected'},entries:[],oldByName:{},historyMigration:{status:'none'},stateMigration:{mutations:[]},provisioningPlans:[],manifest:{}};
  })
}));
vi.mock('../src/application/update/review-plan.js',()=>({prepareUpdateReview:vi.fn(async()=>({
  summary:{eligible:f.eligible,blockers:f.eligible?[]:['injected blocker']},requiresApproval:f.requiresApproval,needsRevalidation:f.revalidate,
  descriptor:{fingerprint:'a'.repeat(64)},writePlan:{skipped:f.skipped?[{}]:[],written:[],retired:[]},candidateAdmission:{status:'absent'},preconditions:[]
}))}));
vi.mock('../src/application/update/planning.js',()=>({preflightUpdate:vi.fn(async()=>{f.calls.push('preflight');}),assertAuthorizedUpdateMutations:vi.fn()}));
vi.mock('../src/application/update/preview.js',async original=>({...await original<typeof import('../src/application/update/preview.js')>(),matchUpdatePreviewReceipt:vi.fn()}));
vi.mock('../src/application/update/migration-runtime.js',()=>({
  describeUpdateMigration:()=>({status:'not-required',sourceIdentity:null,targetIdentity:null,historyPaths:[],issues:[]}),
  describeUpdateRevalidation:()=>({status:f.revalidate?'pending':'not-required',nextPhase:null,issues:[]}),
  materializeUpdateMutations:()=>({mutations:[{type:'write',pathParts:['injected'],content:'not written'}]}),
  verifyHistoryBeforeReplacement:vi.fn(),
  runUpdateRevalidation:vi.fn(async()=>{f.calls.push('revalidate');return {status:f.revalidationBlocked?'blocked':'complete',nextPhase:null,issues:f.revalidationBlocked?['injected check failure']:[]};})
}));
vi.mock('../src/application/update/output.js',async original=>({...await original<typeof import('../src/application/update/output.js')>(),
  buildUpdateReport:(report:unknown)=>report,renderUpdateApprovalScope:vi.fn()
}));
beforeEach(()=>{Object.assign(f,{work:true,requiresApproval:true,eligible:true,agentPending:false,skipped:false,revalidate:false,revalidationBlocked:false,cleanup:false,committed:true,recovery:false,recoveryBlocked:false,throwInspection:false,calls:[]});});
async function invoke(check:boolean,answer?:'decline'|'cancel'){
  const stdout=new CaptureStream(),stderr=ttyCaptureStream(),stdin=new Readable({read(){}});
  Object.defineProperty(stdin,'isTTY',{value:true});
  const events:SemanticTelemetryEvent[]=[];
  try{
    const code=await runCli({argv:['update',...(check?['--check']:answer?[]:['--approve-plan','a'.repeat(64)]),'--json'],
      cwd:'/owned-injected-project',env:{},stdout,stderr,stdin,
      telemetry:{beforeCommand:async()=>true,afterCommand:async()=>{},afterSemanticCommand:async event=>{events.push(event);}},
      execute:(parsed,ctx)=>runCommand(parsed,{...ctx,approveUpdatePlan:async()=>{
        f.calls.push('prompt');if(answer==='cancel')throw Object.assign(new Error('synthetic cancellation'),{name:'ExitPromptError'});return false;
      }})});
    return {code,event:events[0],report:JSON.parse(stdout.text()),stderr:stderr.text()};
  }finally{stdin.destroy();}
}
describe('actual update producer semantic boundaries with injected I/O',()=>{
  it('distinguishes successful drift detection from failed postcommit verification at the same exit2',async()=>{
    const check=await invoke(true);
    expect(check.code).toBe(2);expect(check.report.status).toBe('update-available');expect(check.event.outcome).toBe('attention-required');
    expect(f.calls).toEqual(['issue-preview']);
    f.calls=[];f.revalidate=true;f.revalidationBlocked=true;
    const failed=await invoke(false);
    expect(failed.code).toBe(2);expect(failed.report).toMatchObject({status:'partial',committed:true,reasonCode:'revalidation-blocked'});
    expect(failed.event.outcome).toBe('failure');
    expect(f.calls).toEqual(['load-preview','preflight','apply-transaction','revalidate','consume-preview']);
  });
  it.each(['decline','cancel'] as const)('records actual %s without applying an update',async answer=>{
    const result=await invoke(false,answer);
    expect(result.code).toBe(1);expect(result.event.outcome).toBe('cancelled');expect(result.report.approval.status).toBe('declined');
    expect(f.calls).toEqual(['load-preview','prompt']);
  });
  it('retains current success and applied success without changing reports',async()=>{
    f.work=false;f.requiresApproval=false;
    expect(await invoke(true)).toMatchObject({code:0,event:{outcome:'success'},report:{status:'current'}});
    f.work=true;f.requiresApproval=true;
    expect(await invoke(false)).toMatchObject({code:0,event:{outcome:'success'},report:{status:'applied',committed:true}});
  });
  it('reports expected deferred maintenance independently of a zero exit',async()=>{
    f.work=false;f.requiresApproval=false;f.skipped=true;
    expect(await invoke(false)).toMatchObject({code:0,event:{outcome:'attention-required'},report:{status:'partial'}});
    f.skipped=false;f.agentPending=true;
    expect(await invoke(true)).toMatchObject({code:2,event:{outcome:'attention-required'},report:{status:'partial'}});
  });
  it('does not report failed rollback or cleanup as expected maintenance',async()=>{
    f.cleanup=true;
    expect(await invoke(false)).toMatchObject({code:1,event:{outcome:'failure'},report:{status:'failed',committed:true}});
    f.cleanup=false;f.committed=false;
    expect(await invoke(false)).toMatchObject({code:1,event:{outcome:'failure'},report:{status:'failed'}});
  });
  it('distinguishes successful recovery needing a new review from failed recovery',async()=>{
    f.recovery=true;
    expect(await invoke(false)).toMatchObject({code:2,event:{outcome:'attention-required'},report:{reasonCode:'transaction-recovery'}});
    f.recoveryBlocked=true;
    expect(await invoke(false)).toMatchObject({code:1,event:{outcome:'failure'}});
    expect(f.calls).toEqual([]);
  });
  it('keeps rejected and thrown inspection failures conservative',async()=>{
    f.eligible=false;expect(await invoke(true)).toMatchObject({code:1,event:{outcome:'failure'},report:{status:'blocked'}});
    f.eligible=true;f.throwInspection=true;expect(await invoke(true)).toMatchObject({code:1,event:{outcome:'failure'},report:{status:'failed'}});
  });
});
