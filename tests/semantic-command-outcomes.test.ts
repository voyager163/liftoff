import {mkdtemp,realpath,lstat,rm,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {runCli,type CliTelemetryHooks} from '../src/cli.js';
import {runCommand} from '../src/commands.js';
import {initializeProject} from '../src/application/initialize/use-case.js';
import {migrateProject} from '../src/application/migrate/use-case.js';
import {createCommandOutcome} from '../src/application/command-outcome.js';
import {PresentationSession} from '../src/terminal.js';
import {CaptureStream} from './helpers.js';
import {createSemanticTelemetryEvent,telemetryClientFields,type SemanticTelemetryEvent} from '../src/telemetry/contract.js';
import type {SelfUpgradeResult} from '../src/self-upgrade.js';
import type {CommandRunner} from '../src/process-runner.js';
import {liftoffPackageName} from '../src/domain/distribution/liftoff-package.js';
const prompt=vi.hoisted(()=>({answer:'decline' as 'decline'|'cancel'|'accept',profile:'decline' as 'decline'|'cancel',profileCalls:0}));
const boundary=vi.hoisted(()=>({project:false,applied:false,reason:'execute-required',cleanup:false,failedRemediation:false,profileRemediationOnly:false,installations:0}));
vi.mock('../src/adapters/filesystem/project-discovery.js',()=>({findProjectRoot:vi.fn(async()=>boundary.project?'/injected/governance':undefined)}));
vi.mock('../src/workstation.js',async original=>({
  ...await original<typeof import('../src/workstation.js')>(),
  probeWorkstation:vi.fn(async()=>boundary.failedRemediation?(boundary.profileRemediationOnly?['first']:['first','second']).map(id=>({
    requirement:{id,severity:'advisory',reasons:[],definition:{label:id}},state:'missing',reasonCode:'missing-executable',
    identity:{executable:id},detail:'injected missing prerequisite',notices:[]
  })):[]),
  detectHostEnvironment:vi.fn(async()=>({platform:'darwin',architecture:'arm64'})),
  selectRemediation:vi.fn(requirement=>({recipe:{id:requirement.id,requiresExplicitReview:requirement.id==='second',
    operation:'install',command:{executable:'injected-never-executed',args:[]}}})),
  installRequirement:vi.fn(async(_requirement,probe)=>{boundary.installations++;return {state:'failed',probe,detail:'injected installation failed'};})
}));
vi.mock('../src/adapters/filesystem/workstation-attempts.js',()=>({createWorkstationNoProgressStore:()=>({})}));
vi.mock('../src/application/governance/inspection.js',async original=>({...await original<typeof import('../src/application/governance/inspection.js')>(),
  inspectGovernance:vi.fn(async()=>({readiness:{completion:{}}})),transitionInspection:(value:unknown)=>value
}));
vi.mock('../src/governance-activation/transitions.js',async original=>({...await original<typeof import('../src/governance-activation/transitions.js')>(),
  executeApplyNext:vi.fn(async()=>({applied:boundary.applied,reason:boundary.reason,cleanupWarnings:boundary.cleanup?['injected incomplete cleanup']:[]})),
  previewApplyNext:vi.fn(async()=>({applied:boundary.applied,reason:boundary.reason}))
}));
vi.mock('../src/cli/commands/governance-output.js',async original=>({...await original<typeof import('../src/cli/commands/governance-output.js')>(),governanceNextActions:()=>[]}));
vi.mock('../src/interactive.js',async original=>{
  const actual=await original<typeof import('../src/interactive.js')>();
  return {...actual,InteractivePrompter:class {
    async confirmPlan(){if(prompt.answer==='cancel')throw new actual.InteractiveCancelledError();return prompt.answer==='accept';}
    async confirmToolInstallation(){throw new actual.InteractiveCancelledError();}
    async confirmOpenSpecProfileConfiguration(){
      prompt.profileCalls++;
      if(prompt.profile==='cancel')throw new actual.InteractiveCancelledError();
      return false;
    }
    close(){}
  }};
});
const roots:{root:string;ino:number;dev:number}[]=[];
beforeEach(()=>{
  Object.assign(boundary,{project:false,applied:false,reason:'execute-required',cleanup:false,failedRemediation:false,profileRemediationOnly:false,installations:0});
  Object.assign(prompt,{profile:'decline',profileCalls:0});
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();prompt.answer='decline';for(const r of roots.splice(0)){
  const s=await lstat(r.root);expect(s.ino).toBe(r.ino);expect(s.dev).toBe(r.dev);await rm(r.root,{recursive:true});
}});
const rejectedRunner:CommandRunner={run:vi.fn(async command=>({command,displayCommand:'injected discovery',status:128,signal:null,stdout:'',stderr:'fatal: not a git repository',timedOut:false,processSpawned:false}))};
const initOptions={projectName:'Semantic Contract',projectType:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',
  includeFrontend:false,environments:['dev'],specWorkflow:'openspec',agents:['github-copilot'],copilotCloud:false,governanceProfile:'none'};
async function ownedRoot(){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'semantic-source-'))),s=await lstat(root);
  roots.push({root,ino:s.ino,dev:s.dev});return root;
}
function hooks(){
  const legacy=vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined),events:SemanticTelemetryEvent[]=[];
  return {legacy,events,telemetry:{beforeCommand:vi.fn(async()=>true),afterCommand:legacy,
    afterSemanticCommand:vi.fn(async(event:SemanticTelemetryEvent)=>{events.push(event);})} satisfies CliTelemetryHooks};
}
describe('invocation-scoped semantic completion',()=>{
  it.each((['init','migrate'] as const).flatMap(command=>
    (['No','interrupted','noninteractive','unpresented-explicit-false','earlier-failure-then-No','inspection-error','configuration-error'] as const)
      .map(variant=>({command,variant}))
  ))('propagates actual OpenSpec profile consent $variant through $command without initialization',async({command,variant})=>{
    const root=await ownedRoot(),source=path.join(root,'legacy');
    await mkdir(source);
    const original=Buffer.from('original legacy input\r\n');
    await writeFile(path.join(source,'source.txt'),original,{mode:0o640});
    const originalMode=(await lstat(path.join(source,'source.txt'))).mode;
    vi.stubEnv('LIFTOFF_STAGING_ROOT',root);
    prompt.answer='accept';prompt.profile=variant==='interrupted'?'cancel':'decline';
    boundary.failedRemediation=variant==='earlier-failure-then-No';boundary.profileRemediationOnly=true;
    const calls:string[]=[];
    const runner:CommandRunner={run:vi.fn(async command=>{
      const displayCommand=[command.executable,...command.args].join(' ');calls.push(displayCommand);
      const result={command,displayCommand,status:0,signal:null,stdout:'',stderr:'',timedOut:false,processSpawned:false};
      if(command.executable==='git')return {...result,status:128,stderr:'fatal: not a git repository'};
      if(command.executable==='openspec'&&command.args.join(' ')==='config list --json'){
        return variant==='inspection-error'?{...result,status:1,stderr:'injected profile inspection failed'}:
          {...result,stdout:JSON.stringify({profile:'core',delivery:'skills',workflows:[]})};
      }
      if(command.executable==='openspec'&&command.args[0]==='config'&&command.args[1]==='set'&&variant==='configuration-error'){
        return {...result,status:1,stderr:'injected profile configuration failed'};
      }
      throw new Error(`Unexpected product command in injected profile test: ${displayCommand}`);
    })};
    const h=hooks(),stdout=new CaptureStream(),stderr=new CaptureStream();
    const code=await runCli({argv:command==='init'?['init']:['migrate',source],cwd:root,env:{},stdout,stderr,telemetry:h.telemetry,
      execute:(parsed,ctx)=>runCommand({...parsed,positional:command==='init'?[initOptions.projectName]:[source],flags:{
        project:initOptions.projectName,type:'standard',api:'node-fastify',cloud:'azure',region:'eastus',
        frontend:false,environments:'dev',spec:'openspec',agents:'github-copilot','copilot-cloud':false,governance:'none',
        ...(variant==='noninteractive'?{yes:true}:{}),
        ...(variant==='unpresented-explicit-false'?{'configure-openspec-profile':false}:{}),
        ...(variant==='configuration-error'?{'configure-openspec-profile':true}:{}),
        ...(variant==='earlier-failure-then-No'?{'install-tools':true}:{})
      }},{...ctx,runner})});
    expect(code).toBe(variant==='interrupted'?0:1);
    expect(h.events).toEqual([createSemanticTelemetryEvent(command,'0.12.3',
      variant==='No'||variant==='interrupted'?'cancelled':'failure')]);
    expect(h.legacy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({command}),code,{});
    expect(prompt.profileCalls).toBe(['No','interrupted','earlier-failure-then-No'].includes(variant)?1:0);
    expect(boundary.installations).toBe(variant==='earlier-failure-then-No'?1:0);
    expect(calls.filter(c=>c==='openspec config list --json')).toHaveLength(1);
    expect(calls.filter(c=>c.startsWith('openspec config set '))).toHaveLength(variant==='configuration-error'?1:0);
    const output=stdout.text()+stderr.text();
    expect(output).toContain(variant==='interrupted'?'Interactive operation stopped.':
      variant==='inspection-error'?'injected profile inspection failed':
      variant==='configuration-error'?'injected profile configuration failed':
      'The global OpenSpec profile does not satisfy the Liftoff template contract.');
    expect(await readdir(root)).toEqual(['legacy']);
    expect(await readdir(source)).toEqual(['source.txt']);
    expect(await readFile(path.join(source,'source.txt'))).toEqual(original);
    expect((await lstat(path.join(source,'source.txt'))).mode).toBe(originalMode);
  });
  it.each([
    {applied:false,reason:'execute-required',cleanup:false,expected:'attention-required',code:0},
    {applied:false,reason:'external-operation-pending',cleanup:false,expected:'attention-required',code:0},
    {applied:true,reason:'applied',cleanup:false,expected:'success',code:0},
    {applied:true,reason:'applied',cleanup:true,expected:'failure',code:0},
    {applied:false,reason:'blocked',cleanup:false,expected:'failure',code:1}
  ])('observes governance result $reason / cleanup $cleanup without changing numeric result',async result=>{
    Object.assign(boundary,result,{project:true});const h=hooks(),stdout=new CaptureStream();
    expect(await runCli({argv:['governance','apply-next','--execute','--json'],env:{},stdout,stderr:new CaptureStream(),telemetry:h.telemetry})).toBe(result.code);
    expect(h.events[0].outcome).toBe(result.expected);expect(JSON.parse(stdout.text())).toMatchObject({applied:result.applied,reason:result.reason});
  });
  it.each(['0.12.3','99.0.0'])('uses actual doctor readiness aggregation for published version %s',async version=>{
    const h=hooks(),stdout=new CaptureStream();
    expect(await runCli({argv:['doctor','--json'],env:{},stdout,stderr:new CaptureStream(),telemetry:h.telemetry,
      execute:(parsed,ctx)=>runCommand(parsed,{...ctx,runner:rejectedRunner,
        stableReleaseLookup:async()=>({name:liftoffPackageName,version}),
        configuredRegistryTargetLookup:async()=>({status:'available',registryKind:'canonical'})})})).toBe(0);
    expect(h.events[0].outcome).toBe(version==='0.12.3'?'success':'attention-required');
    expect(JSON.parse(stdout.text()).summary).toEqual({failures:0,warnings:version==='0.12.3'?0:1});
  });
  it('keeps explicit failure sticky through cancellation and freezes the final outcome',()=>{
    const value=createCommandOutcome();
    value.record('failure');value.record('cancelled');expect(value.finish(0)).toBe('failure');
    value.record('success');expect(value.finish(2)).toBe('failure');
    expect(createCommandOutcome().finish(2)).toBe('failure');
    const unknown=createCommandOutcome();unknown.record('success');expect(unknown.finish(2)).toBe('failure');
    expect(()=>Reflect.apply(createCommandOutcome().record,undefined,['private failure details'])).toThrow(/Invalid/);
  });
  it.each(['current','update-available','upgraded','blocked','failed'] as const)('uses the actual upgrade %s result and preserves exact numeric/JSON API',async status=>{
    const mode=status==='update-available'?'check':'apply';
    const result:SelfUpgradeResult=status==='current'?{schemaVersion:1,mode,status,currentVersion:'0.12.3',reasonCode:'current'}:
      status==='upgraded'?{schemaVersion:1,mode,status,currentVersion:'0.12.3',targetVersion:'99.0.0',registryKind:'canonical',reasonCode:'upgrade_complete'}:
      status==='update-available'?{schemaVersion:1,mode,status,currentVersion:'0.12.3',targetVersion:'99.0.0',registryKind:'canonical',reasonCode:'update_available'}:
        {schemaVersion:1,mode,status,currentVersion:'0.12.3',reasonCode:'verification_failed'};
    const h=hooks(),stdout=new CaptureStream(),stderr=new CaptureStream(),selfUpgrade=vi.fn(async()=>result);
    const code=await runCli({argv:['upgrade','--json',...(mode==='check'?['--check']:[])],env:{},stdout,stderr,telemetry:h.telemetry,
      execute:(parsed,ctx)=>runCommand(parsed,{...ctx,selfUpgrade})});
    expect(code).toBe(status==='update-available'?2:status==='failed'||status==='blocked'?1:0);
    expect(JSON.parse(stdout.text())).toEqual(result);expect(stderr.text()).toBe('');
    expect(h.events).toEqual([createSemanticTelemetryEvent('upgrade','0.12.3',status==='update-available'?'attention-required':
      status==='blocked'||status==='failed'?'failure':'success')]);
    expect(h.legacy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({command:'upgrade'}),code,{});
    expect(Object.keys(h.events[0])).toEqual([...telemetryClientFields]);expect(selfUpgrade).toHaveBeenCalledOnce();
  });
  it.each(['decline','cancel'] as const)('observes actual init %s as cancellation without tool or framework initialization',async answer=>{
    prompt.answer=answer;const h=hooks(),stdout=new CaptureStream(),stderr=new CaptureStream();
    const code=await runCli({argv:['init'],cwd:await ownedRoot(),env:{},stdout,stderr,telemetry:h.telemetry,
      execute:(parsed,ctx)=>runCommand({...parsed,positional:[initOptions.projectName],flags:{type:'standard',api:'node-fastify',cloud:'azure',region:'eastus',
        frontend:false,environments:'dev',spec:'openspec',agents:'github-copilot','copilot-cloud':false,governance:'none'}},{...ctx,runner:rejectedRunner})});
    expect(code).toBe(0);expect(h.events[0]?.outcome).toBe('cancelled');
    expect(stdout.text()+stderr.text()).toContain('stopped');
  });
  it('observes deliberate decline at the real initialization use-case boundary',async()=>{
    const h=hooks(),stdout=new CaptureStream(),stderr=new CaptureStream();
    const code=await runCli({argv:['init'],cwd:await ownedRoot(),env:{},stdout,stderr,telemetry:h.telemetry,execute:async(_parsed,ctx)=>
      initializeProject(initOptions,{...ctx,runner:rejectedRunner,presentation:new PresentationSession({stdout,stderr})})});
    expect(code).toBe(0);expect(h.events[0].outcome).toBe('cancelled');
  });
  it('observes actual migration decline while preserving its owned source',async()=>{
    const root=await ownedRoot();
    const h=hooks(),stdout=new CaptureStream(),stderr=new CaptureStream();
    const code=await runCli({argv:['migrate',root],env:{},stdout,stderr,telemetry:h.telemetry,execute:async(_parsed,ctx)=>
      migrateProject({source:root,options:initOptions},{...ctx,runner:rejectedRunner,presentation:new PresentationSession({stdout,stderr})})});
    expect(code).toBe(0);expect(h.events[0].outcome).toBe('cancelled');expect(stdout.text()+stderr.text()).toContain('Migration stopped');
  });
  it('records failed remediation before a later real prompt cancellation and keeps failure at exit0',async()=>{
    const h=hooks(),stdout=new CaptureStream(),stderr=new CaptureStream();prompt.answer='accept';boundary.failedRemediation=true;
    const code=await runCli({argv:['init'],cwd:await ownedRoot(),env:{},stdout,stderr,telemetry:h.telemetry,execute:(parsed,ctx)=>{
      return runCommand({...parsed,positional:[initOptions.projectName],flags:{type:'standard',api:'node-fastify',spec:'openspec',
        agents:'github-copilot',environments:'dev',region:'eastus',frontend:false,cloud:'azure',governance:'none','copilot-cloud':false,'install-tools':true}},{...ctx,runner:rejectedRunner});
    }});
    expect(code).toBe(0);expect(h.events[0].outcome).toBe('failure');
    expect(boundary.installations).toBe(1);expect(stdout.text()+stderr.text()).toContain('injected installation failed');
  });
  it('contains thrown execution and local semantic hook failures while preserving the legacy hook',async()=>{
    const h=hooks(),stderr=new CaptureStream();h.telemetry.afterSemanticCommand.mockRejectedValue(new Error('semantic observer unavailable'));
    const code=await runCli({argv:['plan'],env:{},stdout:new CaptureStream(),stderr,telemetry:h.telemetry,execute:async(_parsed,ctx)=>{
      ctx.outcome!.record('cancelled');throw new Error('actual execution failed');
    }});
    expect(code).toBe(1);expect(h.telemetry.afterSemanticCommand).toHaveBeenCalledWith(expect.objectContaining({outcome:'failure'}),{});
    expect(h.legacy).toHaveBeenCalledOnce();expect(stderr.text()).toContain('actual execution failed');expect(stderr.text()).not.toContain('semantic observer unavailable');
  });
  it('isolates a throwing semantic-hook getter and snapshots command identity before legacy observation',async()=>{
    const h=hooks();
    Object.defineProperty(h.telemetry,'afterSemanticCommand',{get(){throw new Error('observer getter');}});
    expect(await runCli({argv:['--version'],env:{},stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:h.telemetry,execute:async()=>0})).toBe(0);
    expect(h.legacy).toHaveBeenCalledOnce();
    const next=hooks();next.legacy.mockImplementation(async parsed=>{parsed.command='update';});
    expect(await runCli({argv:['--version'],env:{},stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:next.telemetry,execute:async()=>0})).toBe(0);
    expect(next.events[0].command).toBe('version');expect(Object.isFrozen(next.events[0])).toBe(true);
  });
  it('keeps concurrent and late observations isolated to each invocation',async()=>{
    const h=hooks();let release!:()=>void,late:()=>void=()=>{};
    const waiting=runCli({argv:['update'],env:{},stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:h.telemetry,
      execute:async(_p,ctx)=>{ctx.outcome!.record('attention-required');await new Promise<void>(r=>{release=r;});return 2;}});
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    expect(await runCli({argv:['--version'],env:{},stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:h.telemetry,
      execute:async(_p,ctx)=>{late=()=>ctx.outcome!.record('failure');return 0;}})).toBe(0);
    late();release();expect(await waiting).toBe(2);
    expect(h.events.map(e=>[e.command,e.outcome])).toEqual([['version','success'],['update','attention-required']]);
  });
  it.each([{LIFTOFF_TELEMETRY:'0'},{DO_NOT_TRACK:'1'},{CI:'true'}])('suppresses local semantic observation with opt-out %j',async env=>{
    const h=hooks();
    expect(await runCli({argv:['--version'],env,stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:h.telemetry,execute:async()=>0})).toBe(0);
    expect(h.telemetry.afterSemanticCommand).not.toHaveBeenCalled();
  });
  it.each([['governance','assess'],['governance','assess','--help'],['repair','--capabilities'],['repair','--inspect-layout']].map(argv=>({argv})))('retains exclusion $argv',async({argv})=>{
    const h=hooks();expect(await runCli({argv,env:{},stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:h.telemetry,execute:async()=>2})).toBe(2);
    expect(h.telemetry.beforeCommand).not.toHaveBeenCalled();expect(h.legacy).not.toHaveBeenCalled();expect(h.events).toEqual([]);
  });
  it('does not activate schema2 transport or bypass unsuccessful disclosure',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
    const h=hooks();h.telemetry.beforeCommand.mockResolvedValue(false);
    expect(await runCli({argv:['--version'],env:{},stdout:new CaptureStream(),stderr:new CaptureStream(),telemetry:h.telemetry,execute:async()=>0})).toBe(0);
    expect(h.events).toEqual([]);expect(h.legacy).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    expect(await runCli({argv:['--version'],env:{DO_NOT_TRACK:'1'},stdout:new CaptureStream(),stderr:new CaptureStream(),execute:async()=>0})).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
