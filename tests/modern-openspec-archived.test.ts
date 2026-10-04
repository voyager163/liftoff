import {lstat,mkdir,readFile,readdir,rename,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createOpenSpecExecutionFixture,selected,capability,spec,originalFiles} from './modern-openspec-fixtures.js';
import {inspectModernArchivedOpenSpecRuntime,inspectModernOpenSpecRuntime} from '../src/application/governance/modern-local-inputs.js';
import {deriveArchivedOpenSpecInputs} from '../src/application/governance/modern-openspec-inputs.js';
import {
  archivedOpenSpecExecutionChecks,validateArchivedOpenSpecCommandOutput,validateArchivedOpenSpecExecutionInputs,
  validateOpenSpecExecutionInputs,type OpenSpecArchivedExecutionInputs
} from '../src/domain/governance/activation/modern-openspec-execution.js';
import {
  prepareModernArchivedOpenSpecExecution,prepareModernLocalExecution,prepareModernOpenSpecExecution,
  approveModernLocalExecution,readCompletedModernLocalExecution,inspectModernLocalExecution
} from '../src/application/governance/modern-local-approval.js';
import {executeModernLocalExecution} from '../src/application/governance/modern-local-execution.js';
import {createLocalExecutionRecordStore} from '../src/adapters/filesystem/update-previews.js';
import {createModernLocalWorkspace} from '../src/adapters/filesystem/modern-local-workspaces.js';
import {NodeCommandRunner} from '../src/process-runner.js';
import {canonicalSha256} from '../src/domain/governance/activation/canonical-json.js';
import {assertExecutableLocalExecutionPreview,openSpecMetadataEnvironment,validateLocalExecutionConsentRecord,validateLocalExecutionPreview,validateLocalExecutionResult} from '../src/domain/governance/activation/modern-local-runtime.js';
import {archivedOpenSpecMatchesMain} from '../src/domain/governance/activation/local-check-values.js';
import {buildProjectPlan} from '../src/application/project/planning.js';
import {renderOpenSpecConfig,renderSeedProposal,renderSeedDesign,renderSeedTasks,renderSeedSpec} from '../src/generators/common/spec-workflow.js';
import {observeModernLocalTools,assertModernLocalToolsCurrent} from '../src/adapters/process/modern-local-tools.js';
import {createApplicationEnvironment} from '../src/application/repair/application-environment.js';

const roots:{path:string;ino:number;dev:number}[]=[],archive=`2026-10-01-${selected}`;
const native=process.env.LIFTOFF_OPENSPEC_ARCHIVE_TESTS==='1'&&process.env.LIFTOFF_HCL_TEST_LANE!=='portable';
if(native&&(process.platform!=='darwin'||process.arch!=='arm64'||process.versions.node!=='24.21.0'))throw new Error('Archived OpenSpec native qualification requires the recorded runtime.');
const nativeIt=it.skipIf(!native),scopes={projectCode:true as const,hostCapabilitiesAcknowledged:true as const,
  dependencyPreparation:false,dependencyNetwork:false,workflowFinalization:false as const,publishLocalRecords:false as const};
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const root of roots.splice(0)){
    const st=await lstat(root.path);expect(st.ino).toBe(root.ino);expect(st.dev).toBe(root.dev);expect(st.isSymbolicLink()).toBe(false);
    await rm(root.path,{recursive:true});
  }
});
async function fixture(withActive=true,profile:'none'|'single-maintainer-gitflow'|'team-gitflow'='none'){
  const f=await createOpenSpecExecutionFixture(roots,profile);
  await rename(path.join(f.root,'openspec','changes',selected),path.join(f.root,'openspec','changes','archive',archive));
  await f.put(['openspec','changes','archive',archive,'tasks.md'],'- [x] 1.1 Review source.\r\n- [x] 1.2 Existing historical task; no execution claim.\r\n');
  await f.put(['openspec','specs',capability,'spec.md'],spec('Preserve '+capability));
  await f.put(['openspec','config.yaml'],`schema: spec-driven\ngithubCopilot:\n  cloudAgent: ${profile==='team-gitflow'}\ncontext: |\n  Preserve existing project source and history.\nrules:\n  proposal:\n    - Preserve reviewed intent.\n  specs:\n    - Preserve existing requirements.\n`);
  if(!withActive){
    await rename(path.join(f.root,'openspec','changes','unrelated-change'),path.join(f.root,'openspec','changes','archive','2026-10-02-unrelated-change'));
    await f.put(['openspec','changes','archive','2026-10-02-unrelated-change','tasks.md'],'- [x] 1.1 Existing unrelated historical task.\n');
  }
  return f;
}
async function capture(f:Awaited<ReturnType<typeof fixture>>){
  const observed=await inspectModernArchivedOpenSpecRuntime(f.root);
  if(observed.status!=='observed'||observed.local.status!=='modern-observed')throw new Error('Archived source capture blocked: '+JSON.stringify(observed));
  return {snapshot:observed.local.snapshot,inputs:deriveArchivedOpenSpecInputs(observed.local.snapshot,f.manifest)};
}
function generatedSeed(f:Awaited<ReturnType<typeof fixture>>){
  const plan=buildProjectPlan({projectName:f.manifest.project.name,projectType:'standard',apiStack:'node-fastify',cloud:'azure',region:'eastus',
    includeFrontend:true,environments:['dev'],specWorkflow:'openspec',agents:['github-copilot'],copilotCloud:false,governanceProfile:'none'},{requireProjectName:true});
  return {config:renderOpenSpecConfig(plan),files:{
    '.openspec.yaml':'schema: spec-driven\n','proposal.md':renderSeedProposal(plan),'design.md':renderSeedDesign(plan),
    'tasks.md':renderSeedTasks(plan).replace(/^(- \[) (\])/gm,'$1x$2'),[`specs/${capability}/spec.md`]:renderSeedSpec(plan)
  }};
}
async function generatedArchiveFixture(){
  const f=await createOpenSpecExecutionFixture(roots),seed=generatedSeed(f),base=['openspec','changes',selected];
  await f.put(['openspec','config.yaml'],seed.config);
  for(const [name,content]of Object.entries(seed.files))await f.put([...base,...name.split('/')],content);
  const workspace=path.join(path.dirname(f.root),'archive-fixture-environment'),home=path.join(workspace,'home');
  await mkdir(home,{recursive:true,mode:0o700});
  const args=['archive',selected,'--yes','--json'],tools=await observeModernLocalTools(f.root,[{
    id:'owned-fixture-archive',status:'planned',inputPaths:[],reasons:[],command:{executable:'openspec',args},cwdPathParts:[],env:{},prerequisites:[],effects:[]
  }],[]),tool=tools.find(t=>t.id==='openspec');
  if(!tool)throw new Error('Actual OpenSpec is required to prepare the owned archive fixture.');
  const environment=await createApplicationEnvironment(process.env,f.root,f.root,workspace),
    env={...Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined])),...environment,...openSpecMetadataEnvironment,
      HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,XDG_CONFIG_HOME:home,XDG_DATA_HOME:home,XDG_STATE_HOME:home,XDG_CACHE_HOME:home,
      LIFTOFF_TELEMETRY:'0',NODE_DISABLE_COMPILE_CACHE:'1'};
  const before=await originalFiles(f.root);
  await assertModernLocalToolsCurrent(f.root,workspace,tools);
  const result=await new NodeCommandRunner().run({executable:tool.executablePath,args:[...tool.prefixArgs,...args]},
    {cwd:f.root,env,timeoutMs:15000,maxOutputBytes:65536,ensureProcessTreeSettled:true,stream:false});
  console.log('ARCHIVED-GENERATED-FIXTURE',JSON.stringify({tools,result,meaning:'Owned fixture preparation only; completed checkboxes do not assert historical task execution.'}));
  expect(result).toMatchObject({status:0,stderr:'',processTreeSettled:true});
  await assertModernLocalToolsCurrent(f.root,workspace,tools);
  const entries=await readdir(path.join(f.root,'openspec','changes','archive'));
  expect(entries).toHaveLength(1);const archiveName=entries[0];
  expect(archiveName).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${selected}$`));
  const after=await originalFiles(f.root),mainPath=`openspec/specs/${capability}/spec.md`;
  const expected=Object.fromEntries(Object.entries(before).map(([name,value])=>[
    name.startsWith(base.join('/')+'/')?name.replace(base.join('/'),`openspec/changes/archive/${archiveName}`):name,value
  ]));
  expect(Object.keys(after).sort()).toEqual([...Object.keys(expected),mainPath].sort());
  for(const [name,value]of Object.entries(expected))expect(after[name]).toEqual(value);
  const main=await readFile(path.join(f.root,mainPath),'utf8'),delta=seed.files[`specs/${capability}/spec.md`];
  expect(delta).toContain('## Purpose\n\n');expect(main).toContain('## Purpose\nDefine');
  expect(main.includes(delta.replace('## ADDED Requirements','## Requirements'))).toBe(false);
  expect(archivedOpenSpecMatchesMain(main,delta)).toBe(true);
  return f;
}
describe('complete archived OpenSpec source admission',()=>{
  it.each(['lf','crlf','extra-heading-blank'] as const)('admits generated archive Purpose formatting (%s) while binding raw source bytes',async kind=>{
    const f=await fixture(),seed=generatedSeed(f),base=['openspec','changes','archive',archive];
    for(const [name,content]of Object.entries(seed.files))await f.put([...base,...name.split('/')],content);
    await f.put(['openspec','config.yaml'],seed.config);
    const delta=seed.files[`specs/${capability}/spec.md`],
      main=delta.replace('## Purpose\n\n','## Purpose\n').replace('## ADDED Requirements','## Requirements');
    await f.put(['openspec','specs',capability,'spec.md'],main);
    const before=(await capture(f)).inputs.readSetDigest;
    const changed=kind==='crlf'?delta.replace(/\n/g,'\r\n'):delta.replace('## Purpose\n\n',kind==='lf'?'## Purpose\n':'## Purpose\n\n\n');
    await f.put([...base,'specs',capability,'spec.md'],changed);
    expect((await capture(f)).inputs.readSetDigest).not.toBe(before);
  });
  it.each(['purpose-body','requirement-body','scenario-body','body-blank-line'] as const)('does not normalize away %s changes in generated archives',async kind=>{
    const f=await fixture(),seed=generatedSeed(f),base=['openspec','changes','archive',archive];
    for(const [name,content]of Object.entries(seed.files))await f.put([...base,...name.split('/')],content);
    const delta=seed.files[`specs/${capability}/spec.md`],main=delta.replace('## Purpose\n\n','## Purpose\n').replace('## ADDED Requirements','## Requirements'),
      changed=kind==='purpose-body'?main.replace('Define the generated','Replace the generated'):
        kind==='requirement-body'?main.replace('SHALL describe','SHALL replace'):
        kind==='scenario-body'?main.replace('**WHEN**','**IF**'):main.replace('\n\n#### Scenario: Product','\n#### Scenario: Product');
    await f.put(['openspec','specs',capability,'spec.md'],changed);
    expect(archivedOpenSpecMatchesMain(changed,delta)).toBe(false);
    await expect(capture(f)).rejects.toThrow('Archived bootstrap and concrete synchronized main capability no longer correspond.');
  });
  it.each([true,false])('captures every current and archived input with active changes=%s',async withActive=>{
    const f=await fixture(withActive),before=await originalFiles(f.root),{snapshot,inputs}=await capture(f);
    expect(inputs.archiveName).toBe(archive);
    expect(inputs.subjects).toEqual(expect.arrayContaining([{id:capability,type:'spec'},{id:'existing-capability',type:'spec'}]));
    expect(inputs.subjects.some(s=>s.type==='change')).toBe(withActive);
    expect(inputs.archives).toHaveLength(withActive?1:2);
    expect(snapshot.files.some(file=>file.pathParts.join('/')===`openspec/changes/archive/${archive}/tasks.md`)).toBe(true);
    expect(await originalFiles(f.root)).toEqual(before);
    const activeOnly=await inspectModernOpenSpecRuntime(f.root);
    expect(activeOnly.status==='observed'&&activeOnly.local.status==='modern-observed').toBe(false);
  });
  it.each(['plain','empty-rules','markers','copilot-enabled'] as const)('accepts bounded %s source without active-schema promotion',async kind=>{
    const f=await fixture();
    if(kind==='plain')await f.put(['openspec','config.yaml'],'schema: spec-driven\n');
    if(kind==='empty-rules')await f.put(['openspec','config.yaml'],'schema: spec-driven\ncontext: ""\nrules:\n  tasks: []\n');
    if(kind==='markers')for(const parts of [['openspec','changes'],['openspec','changes','archive'],['openspec','specs']])await f.put([...parts,'.gitkeep'],'');
    if(kind==='copilot-enabled')await f.put(['openspec','config.yaml'],'schema: spec-driven\ngithubCopilot:\n  cloudAgent: true\n');
    const {inputs}=await capture(f);expect(validateArchivedOpenSpecExecutionInputs(inputs)).toEqual(inputs);
    expect(()=>Reflect.apply(validateOpenSpecExecutionInputs,undefined,[inputs])).toThrow();
  });
  it.each(['pending-selected','pending-unrelated','empty-tasks','too-many-tasks','missing-artifact','extra-artifact','linked',
    'custom-schema','references','bad-config','nonobject-config','bad-context','bad-rules','rule-reference','bad-metadata','bad-copilot','copilot-reference','copilot-extra',
    'main-drift','main-placeholder','duplicate-bootstrap','active-bootstrap','overlap'] as const)('rejects %s without tool dispatch',async kind=>{
    const f=await fixture(false),selectedPath=['openspec','changes','archive',archive];
    if(kind==='pending-selected')await f.put([...selectedPath,'tasks.md'],'- [ ] Still pending.\n');
    if(kind==='pending-unrelated')await f.put(['openspec','changes','archive','2026-10-02-unrelated-change','tasks.md'],'- [ ] Still pending.\n');
    if(kind==='empty-tasks')await f.put([...selectedPath,'tasks.md'],'# No tasks\n');
    if(kind==='too-many-tasks')await f.put([...selectedPath,'tasks.md'],Array.from({length:257},(_,i)=>`- [x] Task ${i}\n`).join(''));
    if(kind==='missing-artifact')await rm(path.join(f.root,...selectedPath,'design.md'));
    if(kind==='extra-artifact')await f.put([...selectedPath,'extra.md'],'Uncaptured input.');
    if(kind==='linked')await symlink('../../../../config.yaml',path.join(f.root,...selectedPath,'extra.md'));
    if(kind==='custom-schema')await f.put(['openspec','schemas','custom','schema.yaml'],'name: custom\n');
    if(kind==='references')await f.put(['openspec','config.yaml'],'schema: spec-driven\nreferences: [foreign]\n');
    if(kind==='bad-config')await f.put(['openspec','config.yaml'],'schema: [\n');
    if(kind==='nonobject-config')await f.put(['openspec','config.yaml'],'- spec-driven\n');
    if(kind==='bad-context')await f.put(['openspec','config.yaml'],'schema: spec-driven\ncontext: [foreign]\n');
    if(kind==='bad-rules')await f.put(['openspec','config.yaml'],'schema: spec-driven\nrules: [foreign]\n');
    if(kind==='rule-reference')await f.put(['openspec','config.yaml'],'schema: spec-driven\nrules:\n  proposal:\n    - reference: foreign\n');
    if(kind==='bad-metadata')await f.put([...selectedPath,'.openspec.yaml'],'schema: custom\n');
    if(kind==='bad-copilot')await f.put(['openspec','config.yaml'],'schema: spec-driven\ngithubCopilot: []\n');
    if(kind==='copilot-reference')await f.put(['openspec','config.yaml'],'schema: spec-driven\ngithubCopilot:\n  cloudAgent: [foreign]\n');
    if(kind==='copilot-extra')await f.put(['openspec','config.yaml'],'schema: spec-driven\ngithubCopilot:\n  cloudAgent: false\n  reference: foreign\n');
    if(kind==='main-drift')await f.put(['openspec','specs',capability,'spec.md'],spec('Different requirement'));
    if(kind==='main-placeholder')await f.put(['openspec','specs',capability,'spec.md'],'## Purpose\n\nTBD - created by archiving change\n\n'+spec('Preserve '+capability,true).replace('## ADDED Requirements','## Requirements'));
    if(kind==='duplicate-bootstrap'){
      await f.change(selected,capability);
      await rename(path.join(f.root,'openspec','changes',selected),path.join(f.root,'openspec','changes','archive',`2026-10-02-${selected}`));
    }
    if(kind==='active-bootstrap')await f.change(selected,capability);
    if(kind==='overlap'){await f.change('first-change','shared-capability');await f.change('second-change','shared-capability');}
    const run=vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async()=>{throw new Error('No tool dispatch belongs to source admission.');});
    await expect(capture(f)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['config','archive','main','membership'] as const)('binds %s drift to a different full read-set digest',async kind=>{
    const f=await fixture(),before=(await capture(f)).inputs.readSetDigest;
    if(kind==='config')await f.put(['openspec','config.yaml'],'schema: spec-driven\ncontext: Different captured context.\n');
    if(kind==='archive')await f.put(['openspec','changes','archive',archive,'design.md'],'## Context\nChanged historical source, not execution proof.\n');
    if(kind==='main')await f.put(['openspec','specs','existing-capability','spec.md'],spec('Independent current change'));
    if(kind==='membership')await f.change('new-change','new-capability');
    expect((await capture(f)).inputs.readSetDigest).not.toBe(before);
  });
});

function descriptor():OpenSpecArchivedExecutionInputs{
  return {kind:'liftoff-openspec-archived-readonly-inputs',schemaVersion:1,changeName:selected,archiveName:archive,capability,
    readSetDigest:'a'.repeat(64),subjects:[{id:capability,type:'spec'}],archives:[archive]};
}
const projectRoot=path.resolve('owned-observation-project');
function output(id:string,input=descriptor()){
  const subjects=id==='openspec-current-main'?[{id:input.capability,type:'spec'}]:
    id==='openspec-current-all'?input.subjects:input.archives.map(name=>({id:name,type:'change'}));
  const count=subjects.length,changes=subjects.filter(s=>s.type==='change').length,specs=count-changes,
    totals=(items:number)=>({items,passed:items,failed:0});
  return {items:subjects.map(subject=>({...subject,valid:true,issues:[] as unknown[],durationMs:1})),
    summary:{totals:totals(count),byType:id==='openspec-current-all'?{change:totals(changes),spec:totals(specs)}:
      id==='openspec-current-main'?{spec:totals(count)}:{change:totals(count)}},version:'1.0',root:{path:projectRoot,source:'nearest'}};
}
describe('archived OpenSpec closed JSON contracts',()=>{
  it('plans only three read-only validations, with explicit current-spec selection and no inactive apply',()=>{
    const checks=archivedOpenSpecExecutionChecks(descriptor());
    expect(checks.map(c=>c.command?.args)).toEqual([
      ['validate',capability,'--type','spec','--strict','--json','--no-interactive'],
      ['validate','--all','--strict','--json','--no-interactive','--concurrency','1'],
      ['validate','--archived','--strict','--json','--no-interactive','--concurrency','1']
    ]);
    expect(checks.map(c=>c.prerequisites)).toEqual([['framework-source'],['openspec-current-main'],['openspec-current-all']]);
  });
  it.each(['openspec-current-main','openspec-current-all','openspec-archived-all'])('accepts the observed %s output shape, including zero active subjects',id=>{
    expect(()=>validateArchivedOpenSpecCommandOutput(descriptor(),id,JSON.stringify(output(id)),projectRoot)).not.toThrow();
  });
  it('requires every unrelated current and archived subject',()=>{
    const input={...descriptor(),subjects:[...descriptor().subjects,{id:'unrelated-change',type:'change' as const}],archives:[archive,'2026-10-02-unrelated']};
    for(const id of ['openspec-current-all','openspec-archived-all']){
      const raw=output(id,input);
      expect(()=>validateArchivedOpenSpecCommandOutput(input,id,JSON.stringify(raw),projectRoot)).not.toThrow();
      expect(()=>validateArchivedOpenSpecCommandOutput(input,id,JSON.stringify({...raw,items:raw.items.slice(1)}),projectRoot)).toThrow(/subjects/);
    }
  });
  it.each(['omitted','extra','duplicate','wrong-subject','wrong-type','failed','warning','duration','root','store','version','totals','missing-zero-type','extra-field'] as const)('rejects %s JSON observations',kind=>{
    const id='openspec-current-all',raw=output(id),item=raw.items[0];
    if(kind==='omitted')raw.items=[];
    if(kind==='extra')raw.items.push({...item,id:'extra'});
    if(kind==='duplicate')raw.items.push(item);
    if(kind==='wrong-subject')item.id='different';
    if(kind==='wrong-type')item.type='change';
    if(kind==='failed')item.valid=false;
    if(kind==='warning')item.issues=[{level:'WARNING',message:'Not strict success.'}];
    if(kind==='duration')item.durationMs=-1;
    if(kind==='root')raw.root.path=path.resolve('foreign-project');
    if(kind==='store')raw.root.source='store';
    if(kind==='version')raw.version='2.0';
    if(kind==='totals')raw.summary.totals.passed=0;
    if(kind==='missing-zero-type')delete raw.summary.byType.change;
    const candidate=kind==='extra-field'?{...raw,executedHistoricalTasks:true}:raw;
    expect(()=>validateArchivedOpenSpecCommandOutput(descriptor(),id,JSON.stringify(candidate),projectRoot)).toThrow();
  });
  it.each(['not-json','[]','null','{}\n{}',' '.repeat(65537)])('rejects malformed or oversized output %#',stdout=>{
    expect(()=>validateArchivedOpenSpecCommandOutput(descriptor(),'openspec-current-main',stdout,projectRoot)).toThrow();
  });
  it('rejects unknown commands and relative workspace attribution',()=>{
    const stdout=JSON.stringify(output('openspec-current-main'));
    expect(()=>validateArchivedOpenSpecCommandOutput(descriptor(),'openspec-status',stdout,projectRoot)).toThrow(/Unknown/);
    expect(()=>validateArchivedOpenSpecCommandOutput(descriptor(),'openspec-current-main',stdout,'relative')).toThrow(/root/);
  });
  it.each(['kind','version','archive-name','missing-archive','duplicate-archive','active-selected','missing-main','duplicate-subject','bounds','descriptor-bytes','extra-field'] as const)('rejects %s descriptors',kind=>{
    const input=descriptor();
    const candidate=kind==='kind'?{...input,kind:'liftoff-openspec-readonly-inputs'}:
      kind==='version'?{...input,schemaVersion:2}:
      kind==='archive-name'?{...input,archiveName:`arbitrary-${selected}`}:
      kind==='missing-archive'?{...input,archives:['unrelated']}:
      kind==='duplicate-archive'?{...input,archives:[archive,archive]}:
      kind==='active-selected'?{...input,subjects:[...input.subjects,{id:selected,type:'change'}]}:
      kind==='missing-main'?{...input,subjects:[{id:'unrelated',type:'spec'}]}:
      kind==='duplicate-subject'?{...input,subjects:[...input.subjects,...input.subjects]}:
      kind==='bounds'?{...input,archives:[archive,...Array.from({length:63},(_,i)=>`archive-${i}`)]}:
      kind==='descriptor-bytes'?{...input,archives:[archive,'x'.repeat(16384)]}:{...input,historicalExecution:true};
    expect(()=>Reflect.apply(validateArchivedOpenSpecExecutionInputs,undefined,[candidate])).toThrow();
  });
  it.each(['changeName','archiveName','capability','readSetDigest','subjects','archives'] as const)('rejects non-string/non-list %s without coercion',field=>{
    for(const value of [null,123,{}])expect(()=>Reflect.apply(validateArchivedOpenSpecExecutionInputs,undefined,[{...descriptor(),[field]:value}])).toThrow();
  });
});

describe('explicit actual archived OpenSpec execution',()=>{
  nativeIt('revalidates a real generated seed after official owned-fixture archival',async()=>{
    const f=await generatedArchiveFixture(),before=await originalFiles(f.root),
      preview=await prepareModernArchivedOpenSpecExecution(f.root,{kind:'verify-openspec-archived',preparation:[]});
    expect(preview.schemaVersion).toBe(5);
    const consent=await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    console.info('ARCHIVED_GENERATED_ACTUAL '+JSON.stringify({preview,consent,result,meaning:'Fresh read-only revalidation after separately observed disposable fixture archival.'}));
    expect(result.complete,JSON.stringify(result)).toBe(true);expect(result.cleanupComplete).toBe(true);
    expect(result.schemaVersion).toBe(4);if(result.schemaVersion!==4)throw new Error('Missing generated archive validation proof.');
    expect(result.openSpec.observations.map(p=>p.id)).toEqual(['openspec-current-main','openspec-current-all','openspec-archived-all']);
    expect((await readCompletedModernLocalExecution(f.root,preview.fingerprint)).result).toEqual(result);
    expect(await originalFiles(f.root)).toEqual(before);
  },300000);
  nativeIt.each(['none','single-maintainer-gitflow','team-gitflow'] as const)('runs fresh complete %s checks without rewriting archived history',async profile=>{
    const f=await fixture(profile==='single-maintainer-gitflow',profile),before=await originalFiles(f.root),
      preview=await prepareModernArchivedOpenSpecExecution(f.root,{kind:'verify-openspec-archived',preparation:[]});
    expect(preview.schemaVersion).toBe(5);if(preview.schemaVersion!==5)throw new Error('Missing archived execution identity.');
    const store=createLocalExecutionRecordStore(f.root);
    await expect(createModernLocalWorkspace(f.root,preview,store)).rejects.toThrow(/consent/);
    expect(await store.readState(preview.fingerprint)).toBeNull();
    const consent=await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    expect(consent.schemaVersion).toBe(4);
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    console.info('ARCHIVED_OPENSPEC_ACTUAL '+JSON.stringify({preview:{schemaVersion:preview.schemaVersion,fingerprint:preview.fingerprint,
      policyDigest:preview.policyDigest,archivedOpenSpecInputs:preview.archivedOpenSpecInputs,
      tools:preview.tools.map(tool=>({id:tool.id,version:tool.version,digest:tool.digest}))},
      consent,result,meaning:'fresh current validation; no historical task execution proof or archive mutation'}));
    expect(result.complete,JSON.stringify(result)).toBe(true);expect(result.cleanupComplete).toBe(true);
    expect(result.schemaVersion).toBe(4);if(result.schemaVersion!==4)throw new Error('Missing current/archive JSON proof.');
    expect(result.openSpec.observations.map(p=>p.id)).toEqual(['openspec-current-main','openspec-current-all','openspec-archived-all']);
    expect((await readCompletedModernLocalExecution(f.root,preview.fingerprint)).result).toEqual(result);
    expect((await inspectModernLocalExecution(f.root,preview.fingerprint)).status).toBe('retained');
    expect(await originalFiles(f.root)).toEqual(before);
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/already claimed/);
    for(const version of [1,2,3,4]){
      const {fingerprint:_fingerprint,...body}=preview,candidate={...body,schemaVersion:version};
      expect(()=>validateLocalExecutionPreview({...candidate,fingerprint:canonicalSha256(candidate)} as typeof preview,new Date())).toThrow();
    }
    expect(()=>validateLocalExecutionConsentRecord(f.root,preview,{...consent,schemaVersion:2},new Date())).toThrow();
    const {resultDigest:_digest,...body}=result,missing={...body,openSpec:{...body.openSpec,observations:[]}};
    expect(()=>validateLocalExecutionResult({...missing,resultDigest:canonicalSha256(missing)},preview,path.dirname(result.openSpec.projectRoot))).toThrow(/observations/);
  },300000);
  nativeIt('preserves generic schema2 refusal and active-schema archive refusal',async()=>{
    const f=await fixture(),legacy=await prepareModernLocalExecution(f.root,{kind:'verify-local',preparation:[]});
    expect(legacy.schemaVersion).toBe(2);
    expect(()=>assertExecutableLocalExecutionPreview(legacy)).toThrow(/unqualified/);
    await expect(prepareModernOpenSpecExecution(f.root,{kind:'verify-openspec-local',preparation:[]})).rejects.toThrow();
  },120000);
  nativeIt('fails actual invalid unrelated current validation before any project recipe',async()=>{
    const f=await fixture();
    await f.put(['openspec','changes','unrelated-change','specs','unrelated-capability','spec.md'],'## ADDED Requirements\n\nInvalid requirement without a scenario.\n');
    const before=await originalFiles(f.root),original=NodeCommandRunner.prototype.run,projectCommands:string[]=[];
    vi.spyOn(NodeCommandRunner.prototype,'run').mockImplementation(async function(this:NodeCommandRunner,command,options){
      if(command.args.at(-1)==='test'||command.args.at(-1)==='build')projectCommands.push(command.args.join(' '));
      return original.call(this,command,options);
    });
    const preview=await prepareModernArchivedOpenSpecExecution(f.root,{kind:'verify-openspec-archived',preparation:[]});
    await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    const result=await executeModernLocalExecution(f.root,preview.fingerprint);
    expect(result.complete).toBe(false);expect(result.cleanupComplete).toBe(true);
    expect(result.checks.find(c=>c.id==='openspec-current-main')?.status).toBe('passed');
    expect(result.checks.find(c=>c.id==='openspec-current-all')).toMatchObject({status:'failed',code:'nonzero-exit',processTreeSettled:true});
    expect(result.checks.find(c=>c.id==='openspec-archived-all')).toMatchObject({status:'blocked',code:'not-run'});
    expect(result.checks.find(c=>c.id==='backend-tests')).toMatchObject({status:'blocked',code:'not-run'});
    expect(projectCommands).toEqual([]);expect(await originalFiles(f.root)).toEqual(before);
    await expect(readCompletedModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/Historical execution/);
  },180000);
  nativeIt.each(['archive','current','config'] as const)('refuses %s drift before claiming the approved operation',async kind=>{
    const f=await fixture(),preview=await prepareModernArchivedOpenSpecExecution(f.root,{kind:'verify-openspec-archived',preparation:[]});
    await approveModernLocalExecution(f.root,preview.fingerprint,scopes);
    if(kind==='archive')await f.put(['openspec','changes','archive',archive,'design.md'],'Different archived source.\n');
    if(kind==='current')await f.change('new-change','new-capability');
    if(kind==='config')await f.put(['openspec','config.yaml'],'schema: spec-driven\ncontext: Changed.\n');
    await expect(executeModernLocalExecution(f.root,preview.fingerprint)).rejects.toThrow(/changed/);
    expect(await createLocalExecutionRecordStore(f.root).readState(preview.fingerprint)).toBeNull();
  },120000);
});
