import {mkdir,writeFile,lstat,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {prepareModernOpenSpecExecution,prepareModernLocalExecution,approveModernLocalExecution,inspectModernLocalExecution,readCompletedModernLocalExecution,captureLocalExecutionRuntime} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {createModernLocalWorkspace} from '../src/adapters/filesystem/modern-local-workspaces.js';
import {createLocalExecutionRecordStore} from '../src/adapters/filesystem/update-previews.js';
import {inspectModernOpenSpecRuntime} from '../src/application/governance/modern-local-inputs.js';
import {deriveCompleteOpenSpecInputs} from '../src/application/governance/modern-openspec-inputs.js';
import {NodeCommandRunner} from '../src/process-runner.js';
import {rawLocalDigest,capturedFileBytes} from '../src/domain/governance/activation/modern-local-inputs.js';
import {canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {assertExecutableLocalExecutionPreview,validateLocalExecutionPreview,validateLocalExecutionResult,validateLocalExecutionConsentRecord,openSpecMetadataEnvironment} from '../src/domain/governance/activation/modern-local-runtime.js';
import {openSpecExecutionChecks,validateOpenSpecCommandOutput,validateOpenSpecExecutionInputs,type OpenSpecExecutionInputs} from '../src/domain/governance/activation/modern-openspec-execution.js';
import {observeModernLocalTools,assertModernLocalToolsCurrent} from '../src/adapters/process/modern-local-tools.js';
import {createApplicationEnvironment} from '../src/application/repair/application-environment.js';
import {hclComputationPolicy} from '../src/adapters/hcl/isolated-parser.js';
import {createOpenSpecExecutionFixture,selected,capability,spec,originalFiles} from './modern-openspec-fixtures.js';

const native=process.env.LIFTOFF_OPENSPEC_B_TESTS==='1'&&process.env.LIFTOFF_HCL_TEST_LANE!=='portable';
if(native&&(process.platform!=='darwin'||process.arch!=='arm64'||process.versions.node!=='24.21.0'))throw new Error('OpenSpec B native qualification requires the recorded runtime.');
const parserRuntime=hclComputationPolicy.qualifiedRuntime;
const parserAvailable=process.env.LIFTOFF_HCL_TEST_LANE!=='portable'&&process.platform===parserRuntime.platform&&
  process.arch===parserRuntime.arch&&process.versions.node===parserRuntime.node;
const nativeIt=it.skipIf(!native),roots:{path:string;ino:number;dev:number}[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const root of roots.splice(0)){
    const st=await lstat(root.path);expect(st.ino).toBe(root.ino);expect(st.dev).toBe(root.dev);expect(st.isSymbolicLink()).toBe(false);
    await rm(root.path,{recursive:true});
  }
});
const scopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,dependencyPreparation:false,dependencyNetwork:false,
  workflowFinalization:false as const,publishLocalRecords:false as const};
async function fixture(profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none'){
  return createOpenSpecExecutionFixture(roots,profile);
}
describe('complete OpenSpec read-set admission',()=>{
  it.each(['archive','schema','references','overlap','extra','linked'] as const)('rejects unsupported %s before tool observation',async kind=>{
    const f=await fixture();
    if(kind==='archive')await f.put(['openspec','changes','archive','2026-09-01-old','tasks.md'],'archived');
    if(kind==='schema')await f.put(['openspec','schemas','spec-driven','schema.yaml'],'name: spec-driven');
    if(kind==='references')await f.put(['openspec','config.yaml'],'schema: spec-driven\nreferences: [foreign]\n');
    if(kind==='overlap')await f.change('overlapping-change',capability);
    if(kind==='extra')await f.put(['openspec','changes',selected,'unreviewed.md'],'Extra input.');
    if(kind==='linked')await symlink('../config.yaml',path.join(f.root,'openspec','specs','linked'));
    const run=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async()=>{throw new Error('No tool dispatch authorized by unsupported scope.');});
    await expect(prepareModernOpenSpecExecution(f.root,{kind:'verify-openspec-local',preparation:[]})).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('captures all original active/main source bytes and absent archive contents',async()=>{
    const f=await fixture(),inspection=await inspectModernOpenSpecRuntime(f.root);
    expect(inspection.status).toBe('observed');if(inspection.status!=='observed'||inspection.local.status!=='modern-observed')throw new Error('Missing complete observation.');
    const paths=inspection.local.snapshot.files.map(f=>f.pathParts.join('/'));
    expect(paths).toContain('openspec/changes/unrelated-change/specs/unrelated-capability/spec.md');
    expect(paths).toContain('openspec/specs/existing-capability/spec.md');
    const inputs=deriveCompleteOpenSpecInputs(inspection.local.snapshot,f.manifest);
    expect(inputs.subjects).toEqual(expect.arrayContaining([
      {id:selected,type:'change'},{id:'unrelated-change',type:'change'},{id:'existing-capability',type:'spec'}
    ]));
    expect(inputs.subjects).toHaveLength(3);
    expect(inputs.tasks).toEqual([
      {id:'1',description:'1.1 Review source.',done:false},
      {id:'2',description:'1.2 Run separately authorized tofu init before finalization.',done:false}
    ]);
    expect(openSpecExecutionChecks(inputs).map(c=>c.id)).toEqual(['openspec-status','openspec-apply','openspec-selected','openspec-all']);
  });
  it.skipIf(!parserAvailable)('assembles complete runtime checks on the qualified HCL host without executing project tools',async()=>{
    const f=await fixture();
    const run=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async()=>{throw new Error('Project tool dispatch is not part of input planning.');});
    const runtime=await captureLocalExecutionRuntime(f.root,true);
    expect(runtime.plan.localPlan!.checks.slice(0,6).map(c=>c.id)).toEqual(['source-consistency','framework-source','openspec-status','openspec-apply','openspec-selected','openspec-all']);
    expect(run).not.toHaveBeenCalled();
  });
});
describe('explicit actual OpenSpec B execution',()=>{
  nativeIt('qualifies actual readonly OpenSpec outputs without claiming full B or tofu eligibility',async()=>{
    const f=await fixture(),captured=await captureLocalExecutionRuntime(f.root,true),original=await originalFiles(f.root);
    if(captured.inspection.status!=='observed'||captured.inspection.local.status!=='modern-observed'||!captured.openSpecInputs)throw new Error('Missing full source.');
    expect(captured.plan.localPlan!.checks.slice(0,6).map(c=>c.id)).toEqual(['source-consistency','framework-source','openspec-status','openspec-apply','openspec-selected','openspec-all']);
    const checks=captured.plan.localPlan!.checks.filter(c=>c.command?.executable==='openspec'),
      tools=await observeModernLocalTools(f.root,checks,[]),tool=tools.find(t=>t.id==='openspec')!;
    const workspace=path.join(path.dirname(f.root),'readonly-workspace'),project=path.join(workspace,'project');
    await mkdir(project,{recursive:true});
    for(const file of captured.inspection.local.snapshot.files){
      if(file.content===null||file.pathParts[0]==='governance')continue;
      const p=path.join(project,...file.pathParts);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,capturedFileBytes(file)!);
    }
    for(const directory of captured.inspection.local.snapshot.directories.filter(d=>d.exists))await mkdir(path.join(project,...directory.pathParts),{recursive:true});
    const env={...await createApplicationEnvironment(process.env,f.root,project,workspace),...openSpecMetadataEnvironment},runner=new NodeCommandRunner();
    const before=await originalFiles(project),proofs=[];
    for(const check of checks){
      const command={executable:tool.executablePath,args:[...tool.prefixArgs,...check.command!.args]};
      await assertModernLocalToolsCurrent(f.root,workspace,tools);
      const result=await runner.run(command,{cwd:project,env:{...Object.fromEntries(Object.keys(process.env).map(k=>[k,undefined])),...env},
        timeoutMs:120000,maxOutputBytes:65536,ensureProcessTreeSettled:true,stream:false});
      console.info('OB2_READONLY_RESULT '+JSON.stringify({id:check.id,command,project,result,meaning:'actual tool observation only; not full B'}));
      expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(result.processTreeSettled).toBe(true);
      validateOpenSpecCommandOutput(captured.openSpecInputs,check.id,result.stdout,project);
      const parsed=JSON.parse(result.stdout);
      expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,root:{path:f.root,source:'nearest'}}),project)).toThrow(/root/);
      expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,unexpected:true}),project)).toThrow();
      if(check.id==='openspec-status'){
        expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,isPlanningComplete:false}),project)).toThrow(/completeness/);
        expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,artifacts:parsed.artifacts.slice(1)}),project)).toThrow(/graph/);
      }else if(check.id==='openspec-apply'){
        expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,contextFiles:{}}),project)).toThrow(/context/);
        expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,tasks:parsed.tasks.map((t:object)=>({...t,done:true}))}),project)).toThrow(/task/);
      }else{
        expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,items:[]}),project)).toThrow(/subjects/);
        expect(()=>validateOpenSpecCommandOutput(captured.openSpecInputs!,check.id,JSON.stringify({...parsed,summary:{}}),project)).toThrow(/totals/);
      }
      await assertModernLocalToolsCurrent(f.root,workspace,tools);
      proofs.push({id:check.id,stdout:result.stdout});
      expect(await originalFiles(project)).toEqual(before);
    }
    expect(await originalFiles(f.root)).toEqual(original);
    console.info('OB2_READONLY_NOT_FULL_B '+JSON.stringify({inputs:captured.openSpecInputs,proofs,tools,project,fullB:false,originalUnchanged:true}));
  },180000);
  nativeIt.each(['none','single-maintainer-gitflow','team-gitflow'] as const)('executes exact full %s B checks with original source and task truth preserved',async profile=>{
    const f=await fixture(profile),before=await originalFiles(f.root),calls:unknown[]=[],original=NodeCommandRunner.prototype.run;
    const spy=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      const dispatch={command,options:{cwd:options?.cwd,timeoutMs:options?.timeoutMs,maxOutputBytes:options?.maxOutputBytes,ensureProcessTreeSettled:options?.ensureProcessTreeSettled},
        effective:Object.fromEntries(Object.entries({...process.env,...options?.env}).filter(([,v])=>v!==undefined))};
      console.info('OB2_DISPATCH '+JSON.stringify(dispatch));
      const result=await original.call(this,command,options);calls.push({dispatch,result});
      console.info('OB2_RESULT '+JSON.stringify({command,result}));expect(result.processTreeSettled).toBe(true);return result;
    });
    const preview=await prepareModernOpenSpecExecution(f.root,{kind:'verify-openspec-local',preparation:[]});
    expect(preview.schemaVersion).toBe(3);if(preview.schemaVersion!==3)throw new Error('Expected fresh executable schema3.');
    expect(preview.openSpecInputs.subjects).toHaveLength(3);
    expect(preview.openSpecInputs.tasks.every(t=>!t.done)).toBe(true);
    const store=createLocalExecutionRecordStore(f.root),count=spy.mock.calls.length;
    await expect(createModernLocalWorkspace(f.root,preview,store)).rejects.toThrow(/consent/);
    expect(await store.readState(preview.fingerprint)).toBeNull();expect(spy.mock.calls.length).toBe(count);
    const consent=await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    expect(consent.schemaVersion).toBe(2);
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    console.info('OB2_ACTUAL_COMPLETE '+JSON.stringify({profile,preview,consent,result,fixtureProvenance:'preinitialized-contract-not-official-initializer',
      tofuInit:'not performed; original unchecked task remains a finalization obligation'}));
    expect(result.complete).toBe(true);expect(result.cleanupComplete).toBe(true);expect(result.schemaVersion).toBe(2);
    if(result.schemaVersion!==2)throw new Error('Missing actual OpenSpec command proof.');
    expect(result.openSpec.observations.map(p=>p.id)).toEqual(['openspec-status','openspec-apply','openspec-selected','openspec-all']);
    expect((await readCompletedModernLocalExecution(f.root,preview.fingerprint)).result).toEqual(result);
    expect((await inspectModernLocalExecution(f.root,preview.fingerprint)).status).toBe('retained');
    expect(await originalFiles(f.root)).toEqual(before);
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/already claimed/);
    const inputs=preview.openSpecInputs,all=result.openSpec.observations.find(p=>p.id==='openspec-all')!,parsed=JSON.parse(all.stdout);
    for(const altered of [{...parsed,items:parsed.items.slice(1)},{...parsed,items:[...parsed.items,parsed.items[0]]},
      {...parsed,root:{...parsed.root,path:f.root}},{...parsed,items:parsed.items.map((v:object)=>({...v,issues:[{level:'warning'}]}))}])
      expect(()=>validateOpenSpecCommandOutput(inputs,'openspec-all',JSON.stringify(altered),result.openSpec.projectRoot)).toThrow();
    const {resultDigest:_digest,...body}=result,bad={...body,openSpec:{...body.openSpec,observations:[]}};
    expect(()=>validateLocalExecutionResult({...bad,resultDigest:canonicalSha256(bad)},preview,path.dirname(result.openSpec.projectRoot))).toThrow(/observations/);
    const {fingerprint:_fingerprint,...previewBody}=preview,{openSpecInputs:_inputs,...oldBody}=previewBody,down={...oldBody,schemaVersion:1 as const};
    expect(()=>validateLocalExecutionPreview({...down,fingerprint:canonicalSha256(down)},new Date())).toThrow();
    expect(()=>validateLocalExecutionConsentRecord(f.root,preview,{...consent,schemaVersion:1},new Date())).toThrow();
    expect(()=>validateOpenSpecExecutionInputs({...inputs,subjects:[]})).toThrow();
    expect(calls.length).toBeGreaterThan(4);
  },300000);
  nativeIt('leaves old schema2 blocked and rejects complete-read-set drift before claiming',async()=>{
    const f=await fixture(),legacy=await prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]});
    expect(legacy.schemaVersion).toBe(2);expect(()=>assertExecutableLocalExecutionPreview(legacy)).toThrow(/unqualified/);
    const preview=await prepareModernOpenSpecExecution(f.root,{kind:'verify-openspec-local',preparation:[]});
    await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    await f.put(['openspec','specs','existing-capability','spec.md'],spec('Changed independently'));
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/changed/);
    expect(await createLocalExecutionRecordStore(f.root).readState(preview.fingerprint)).toBeNull();
  },120000);
  nativeIt('fails actual all-validation on unrelated invalid source before any project recipe',async()=>{
    const f=await fixture();
    await f.put(['openspec','changes','unrelated-change','specs','unrelated-capability','spec.md'],'## ADDED Requirements\n\nNot a valid requirement or scenario.\n');
    const before=await originalFiles(f.root),original=NodeCommandRunner.prototype.run,projectCommands:string[]=[];
    vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      if(command.args.at(-1)==='test'||command.args.at(-1)==='build')projectCommands.push(command.args.join(' '));
      const result=await original.call(this,command,options);
      console.info('OB2_INVALID_SUBJECT_RESULT '+JSON.stringify({command,result}));return result;
    });
    const preview=await prepareModernOpenSpecExecution(f.root,{kind:'verify-openspec-local',preparation:[]});
    await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    expect(result.complete).toBe(false);expect(result.cleanupComplete).toBe(true);
    expect(result.checks.find(c=>c.id==='openspec-selected')?.status).toBe('passed');
    expect(result.checks.find(c=>c.id==='openspec-all')).toMatchObject({status:'failed',code:'nonzero-exit',processTreeSettled:true});
    expect(result.checks.find(c=>c.id==='backend-tests')).toMatchObject({status:'blocked',code:'not-run'});
    expect(projectCommands).toEqual([]);
    expect(await originalFiles(f.root)).toEqual(before);
    await expect(readCompletedModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/Historical execution/);
    console.info('OB2_ACTUAL_INVALID_SUBJECT '+JSON.stringify({preview,result,projectCommands,originalUnchanged:true}));
  },300000);
});

describe('OpenSpec input primitive contracts',()=>{
  function valid():OpenSpecExecutionInputs{
    return {kind:'liftoff-openspec-readonly-inputs',schemaVersion:1,changeName:'bootstrap-owned',capability:'owned-capability',readSetDigest:'a'.repeat(64),
      subjects:[{id:'bootstrap-owned',type:'change'},{id:'existing-capability',type:'spec'}],
      tasks:[{id:'1',description:'Format-only contract; no execution or tool eligibility claim.',done:false}]};
  }
  const fields=['changeName','capability','readSetDigest','subject.id'] as const;
  it.each(fields.flatMap(field=>['null','array','number'].map(kind=>({field,kind}))))('rejects $kind in $field without string coercion',({field,kind})=>{
    const input=valid(),original=field==='subject.id'?input.subjects[1].id:input[field],
      malformed=kind==='null'?null:kind==='number'?123:[original];
    const candidate=field==='subject.id'?{...input,subjects:[input.subjects[0],{...input.subjects[1],id:malformed}]}:{...input,[field]:malformed};
    expect(()=>Reflect.apply(validateOpenSpecExecutionInputs,undefined,[candidate])).toThrow(/OpenSpec/);
  });
  it.each(fields)('preserves valid string %s in format-only input',field=>{
    const input=valid(),validated=validateOpenSpecExecutionInputs(input);
    expect(validated).toEqual(input);
    expect(typeof(field==='subject.id'?validated.subjects[1].id:validated[field])).toBe('string');
  });
});
