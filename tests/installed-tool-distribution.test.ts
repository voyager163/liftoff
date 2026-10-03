import {mkdtemp,mkdir,writeFile,lstat,rm,symlink,readlink,link,rename,chmod,open,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {captureOpenSpecDistribution,assertOpenSpecDistributionCurrent} from '../src/adapters/filesystem/installed-tool-distribution.js';
import {openSpecDistributionPolicy,distributionOrder,distributionPath,distributionLinkTarget,validateInstalledToolDistribution} from '../src/domain/governance/activation/installed-tool-distribution.js';
import {canonicalSha256,canonicalJson} from '../src/domain/governance/activation/canonical-json.js';
const roots:{path:string;ino:number;dev:number}[]=[];
const nofollow=vi.hoisted(()=>({component:'',calls:[] as {operation:string;path:string}[],violations:[] as string[],swapAtRoot:'',swapParent:'',swapTarget:'',swapped:false}));
const faults=vi.hoisted(()=>({directory:'',calls:0}));
vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  function observe(operation:string,target:unknown){
    if(!nofollow.component)return;
    const p=String(target);nofollow.calls.push({operation,path:p});
    if(nofollow.swapAtRoot&&!nofollow.swapped)return;
    if(p.startsWith(nofollow.component+path.sep)||(operation==='realpath'&&p===nofollow.component)){
      nofollow.violations.push(`${operation}:${p}`);throw new Error('Test-only prevented traversal through malformed owned canonical component.');
    }
  }
  return {...actual,
    lstat:async(...args:Parameters<typeof actual.lstat>)=>{
      observe('lstat',args[0]);
      const result=await actual.lstat(...args);
      if(nofollow.swapAtRoot&&String(args[0])===nofollow.swapAtRoot&&!nofollow.swapped){
        nofollow.swapped=true;
        await actual.rename(nofollow.swapParent,nofollow.swapTarget);
        await actual.symlink(nofollow.swapTarget,nofollow.swapParent);
      }
      return result;
    },
    realpath:async(...args:Parameters<typeof actual.realpath>)=>{observe('realpath',args[0]);return actual.realpath(...args);},
    opendir:async(...args:Parameters<typeof actual.opendir>)=>{
    if(args[0]===faults.directory&&++faults.calls===2)await actual.writeFile(path.join(faults.directory,'resource'),'changed between passes');
    return actual.opendir(...args);
  }};
});
afterEach(async()=>{faults.directory='';faults.calls=0;nofollow.component='';nofollow.calls=[];nofollow.violations=[];nofollow.swapAtRoot='';nofollow.swapParent='';nofollow.swapTarget='';nofollow.swapped=false;
  vi.restoreAllMocks();for(const root of roots.splice(0).reverse()){const s=await lstat(root.path);expect(s.ino).toBe(root.ino);expect(s.dev).toBe(root.dev);expect(s.isSymbolicLink()).toBe(false);await rm(root.path,{recursive:true});}});
async function fixture(){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'distribution-owned-'))),s=await lstat(root);roots.push({path:root,ino:s.ino,dev:s.dev});
  const pkg=path.join(root,'package'),project=path.join(root,'project'),staging=path.join(root,'staging');
  for(const p of [path.join(pkg,'bin'),project,staging])await mkdir(p,{recursive:true,mode:0o700});
  await writeFile(path.join(pkg,'package.json'),'{"name":"@fission-ai/openspec","version":"1.11.0","type":"module","bin":{"openspec":"./bin/openspec.js"}}\n');
  await writeFile(path.join(pkg,'bin/openspec.js'),'// Owned format fixture, never executed.\n');
  const locator={launcherPath:path.join(pkg,'bin/openspec.js'),canonicalLauncherPath:path.join(pkg,'bin/openspec.js'),projectRoot:project,stagingRoot:staging};
  return {root,pkg,locator};
}
describe('bounded complete installed distribution identity',()=>{
  it.each(['win32','darwin','linux'] as const)('interprets relative link separators for %s without changing their raw bytes',platform=>{
    expect(distributionLinkTarget('resources/policy',platform)).toEqual(['resources','policy']);
    if(platform==='win32')expect(distributionLinkTarget('resources\\policy',platform)).toEqual(['resources','policy']);
    else expect(()=>distributionLinkTarget('resources\\policy',platform)).toThrow(/malformed/);
    for(const value of ['/absolute','C:\\absolute','C:relative','\\\\server\\share','\0','\ud800','']){
      expect(()=>distributionLinkTarget(value,platform)).toThrow(/malformed/);
    }
  });
  it('uses canonical fixture paths when the temporary directory is an owned alias',async()=>{
    const parent=await fixture(),temporary=path.join(parent.root,'temporary'),alias=path.join(parent.root,'temporary-alias');
    await mkdir(temporary);await symlink('temporary',alias);
    vi.spyOn(os,'tmpdir').mockReturnValue(alias);
    const f=await fixture();
    expect(f.root.startsWith(temporary+path.sep)).toBe(true);
    expect((await captureOpenSpecDistribution(f.locator)).commitment.root.path).toBe(f.pkg);
  });
  it.each(['bin','entry','ancestor','ancestor-recheck'] as const)('rejects actual linked %s before resolving or stating through it',async kind=>{
    const f=await fixture(),sentinel=path.join(f.root,'owned-sentinel');
    await writeFile(sentinel,'owned sentinel remains original');
    const sentinelBefore=await lstat(sentinel,{bigint:true}),locator={...f.locator};
    let malformed:string;
    if(kind==='bin'){
      const target=path.join(f.root,'original-bin');
      await rename(path.join(f.pkg,'bin'),target);await symlink('../original-bin',path.join(f.pkg,'bin'));malformed=path.join(f.pkg,'bin');
    }else if(kind==='entry'){
      const entry=path.join(f.pkg,'bin','openspec.js');
      await rename(entry,path.join(f.root,'original-entry'));await symlink('../../original-entry',entry);malformed=entry;
    }else{
      const parent=path.join(f.root,'canonical-parent');await mkdir(parent);
      await rename(f.pkg,path.join(parent,'package'));
      locator.launcherPath=path.join(parent,'package','bin','openspec.js');locator.canonicalLauncherPath=locator.launcherPath;
      malformed=parent;
      if(kind==='ancestor'){
        await rename(parent,path.join(f.root,'original-parent'));await symlink('original-parent',parent);
      }else{
        nofollow.swapAtRoot=path.join(parent,'package');nofollow.swapParent=parent;nofollow.swapTarget=path.join(f.root,'original-parent');
      }
    }
    nofollow.component=malformed;
    let rejection:unknown;
    try{await captureOpenSpecDistribution(locator);}catch(error){rejection=error;}
    const observed={kind,malformed,calls:[...nofollow.calls],violations:[...nofollow.violations],swapped:nofollow.swapped,
      adapter:'test-only read barrier; actual malformed paths and actual lstat results, no successful eligibility substitution'};
    nofollow.component='';
    expect(rejection).toBeInstanceOf(Error);expect(String(rejection)).toMatch(/canonical|links|ancestor/);
    expect(observed.violations).toEqual([]);
    expect(observed.calls.some(call=>call.operation==='realpath')).toBe(false);
    expect(observed.calls.some(call=>call.path===malformed)).toBe(true);
    if(kind==='ancestor-recheck'){
      expect(observed.swapped).toBe(true);
      const lastParent=observed.calls.map(c=>c.path).lastIndexOf(malformed);
      expect(observed.calls.slice(lastParent+1).some(c=>c.path.startsWith(malformed+path.sep))).toBe(false);
    }
    const after=await lstat(sentinel,{bigint:true});
    expect(after).toMatchObject({ino:sentinelBefore.ino,mode:sentinelBefore.mode,size:sentinelBefore.size,mtimeNs:sentinelBefore.mtimeNs,ctimeNs:sentinelBefore.ctimeNs});
    expect(await readFile(sentinel,'utf8')).toBe('owned sentinel remains original');
    console.info('OB1_CANONICAL_NOFOLLOW '+JSON.stringify(observed));
  });
  it('uses the registered exact policy and raw UTF16 ordering',()=>{
    expect(canonicalSha256(openSpecDistributionPolicy)).toBe('1a3aab0eb7090295e0f000f2006ae52dbe7be7ffa383e0140785231f372f2b1e');
    expect(['\ue000','\u{10000}','a'].sort(distributionOrder)).toEqual(['a','\u{10000}','\ue000']);
    expect(canonicalJson({z:1,a:2})).toBe('{"a":2,"z":1}\n');
    expect(()=>distributionPath(['\ud800'])).toThrow(/path/);
    expect(()=>distributionPath(['a'.repeat(256)])).toThrow();
    expect(()=>distributionPath(Array(33).fill('a'))).toThrow();
    expect(()=>distributionPath(Array(9).fill('a'.repeat(255)))).toThrow();
  });
  it('includes empty files, nested resources and internal link chains in exact current comparisons',async()=>{
    const f=await fixture();await mkdir(path.join(f.pkg,'resources'));
    await writeFile(path.join(f.pkg,'resources/empty'),'');await writeFile(path.join(f.pkg,'resources/policy'),'original\r\n');
    await symlink('resources',path.join(f.pkg,'linked'));await symlink('linked/policy',path.join(f.pkg,'via'));
    await symlink('via',path.join(f.pkg,'outer'));
    const first=await captureOpenSpecDistribution(f.locator),second=await assertOpenSpecDistributionCurrent(f.locator,first.commitment);
    expect(second.commitment).toEqual(first.commitment);expect(first.inventory.files.some(f=>f.bytes===0)).toBe(true);
    expect(first.inventory.links.find(l=>l.pathParts[0]==='via')?.canonicalTargetParts).toEqual(['resources','policy']);
    expect(first.inventory.links.find(l=>l.pathParts[0]==='outer')?.canonicalTargetParts).toEqual(['resources','policy']);
    expect(first.inventory.links.find(l=>l.pathParts[0]==='via')?.linkText).toBe(await readlink(path.join(f.pkg,'via')));
    expect(Buffer.byteLength(canonicalJson(first.commitment))).toBeLessThan(8192);
    await writeFile(path.join(f.pkg,'resources/policy'),'changed\r\n');
    await expect(assertOpenSpecDistributionCurrent(f.locator,first.commitment)).rejects.toThrow(/identity changed/);
  });
  it.each(['added','deleted','mode','replacement','directory','link'] as const)('detects actual %s membership/physical changes',async fault=>{
    const f=await fixture();await writeFile(path.join(f.pkg,'resource'),'same bytes');const first=await captureOpenSpecDistribution(f.locator);
    if(fault==='added')await writeFile(path.join(f.pkg,'new-empty'),'');
    if(fault==='deleted')await rm(path.join(f.pkg,'resource'));
    if(fault==='mode')await chmod(path.join(f.pkg,'resource'),0o444);
    if(fault==='replacement'){await rename(path.join(f.pkg,'resource'),path.join(f.root,'retained'));await writeFile(path.join(f.pkg,'resource'),'same bytes');}
    if(fault==='directory')await mkdir(path.join(f.pkg,'new-empty-directory'));
    if(fault==='link')await symlink('resource',path.join(f.pkg,'new-link'));
    try{
      if(fault==='mode')expect((await lstat(path.join(f.pkg,'resource'))).mode&0o7777)
        .not.toBe(first.inventory.files.find(file=>file.pathParts[0]==='resource')!.mode);
      await expect(assertOpenSpecDistributionCurrent(f.locator,first.commitment)).rejects.toThrow(/changed/);
    }finally{
      if(fault==='mode')await chmod(path.join(f.pkg,'resource'),first.inventory.files.find(file=>file.pathParts[0]==='resource')!.mode);
    }
  });
  it.each(['escape','absolute','dangling','cycle','intermediate-escape','hardlink'] as const)('rejects owned %s without following an external target',async fault=>{
    const f=await fixture(),sentinel=path.join(f.root,'sentinel');await writeFile(sentinel,'owned do not follow');
    const sentinelBefore=await lstat(sentinel,{bigint:true});
    if(fault==='escape')await symlink('../sentinel',path.join(f.pkg,'bad'));
    if(fault==='absolute')await symlink(sentinel,path.join(f.pkg,'bad'));
    if(fault==='dangling')await symlink('missing',path.join(f.pkg,'bad'));
    if(fault==='cycle'){await symlink('second',path.join(f.pkg,'bad'));await symlink('bad',path.join(f.pkg,'second'));}
    if(fault==='intermediate-escape'){await symlink('../sentinel',path.join(f.pkg,'bad'));await symlink('bad/child',path.join(f.pkg,'through'));}
    if(fault==='hardlink')await link(sentinel,path.join(f.pkg,'bad'));
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow();
    const after=await lstat(sentinel,{bigint:true});expect(after.ino).toBe(sentinelBefore.ino);expect(after.mtimeNs).toBe(sentinelBefore.mtimeNs);
  });
  it('rejects invalid raw UTF8 names before they disappear into replacement characters',async()=>{
    const f=await fixture(),invalid=Buffer.concat([Buffer.from(f.pkg+'/'),Buffer.from([0xff])]);
    try{await writeFile(invalid,'owned');}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      expect(code).toBe(process.platform==='win32'?'ENOENT':'EILSEQ');
      console.info('OB1_RAW_NAME_HOST_REJECTION '+JSON.stringify({code,claim:'Host rejected the invalid UTF8 byte pathname; replacement-character rejection exercised separately.'}));
      await writeFile(path.join(f.pkg,'\ufffd'),'owned replacement-name fixture');
    }
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/UTF8/);
  });
  it('rejects missing required dependencies rather than searching another tree',async()=>{
    const f=await fixture();await writeFile(path.join(f.pkg,'package.json'),'{"name":"@fission-ai/openspec","version":"1.11.0","type":"module","bin":{"openspec":"./bin/openspec.js"},"dependencies":{"unavailable":"1.0.0"}}');
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/outside the complete distribution/);
  });
  it('binds existing directory-export prefixes without dropping their metadata',async()=>{
    const f=await fixture();await mkdir(path.join(f.pkg,'lib'));
    await writeFile(path.join(f.pkg,'lib/index.js'),'// not executed');
    await writeFile(path.join(f.pkg,'package.json'),'{"name":"@fission-ai/openspec","version":"1.11.0","type":"module","bin":{"openspec":"./bin/openspec.js"},"exports":{"./lib/":{"import":{"default":"./lib/"}}}}');
    const result=await captureOpenSpecDistribution(f.locator);
    expect(result.inventory.directories.some(d=>d.pathParts.join('/')==='lib')).toBe(true);
  });
  it('copies locator before awaits and refuses forged or mutated commitments',async()=>{
    const f=await fixture(),input={...f.locator},capture=captureOpenSpecDistribution(input);
    input.canonicalLauncherPath=path.join(f.root,'other/bin/openspec.js');
    const actual=await capture;expect(actual.commitment.root.path).toBe(f.pkg);
    await expect(assertOpenSpecDistributionCurrent(f.locator,{...actual.commitment,filesDigest:'a'.repeat(64)})).rejects.toThrow(/identity changed/);
    const getter=vi.fn(()=>f.locator.launcherPath);
    await expect(captureOpenSpecDistribution(Object.defineProperty({...f.locator},'launcherPath',{enumerable:true,get:getter}))).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(()=>validateInstalledToolDistribution({...actual.commitment,policyDigest:'b'.repeat(64)})).toThrow(/policy/);
  });
  it('rejects a deterministic actual resource mutation between passes',async()=>{
    const f=await fixture();await writeFile(path.join(f.pkg,'resource'),'before');
    faults.directory=f.pkg;faults.calls=0;
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/changed/);
  });
  it('hashes an actual exact8MiB file and rejects +1 before reading it',async()=>{
    const f=await fixture(),p=path.join(f.pkg,'large'),handle=await open(p,'wx');await handle.truncate(openSpecDistributionPolicy.fileBytes);await handle.close();
    expect((await captureOpenSpecDistribution(f.locator)).inventory.files.find(f=>f.pathParts[0]==='large')?.bytes).toBe(openSpecDistributionPolicy.fileBytes);
    const append=await open(p,'r+');await append.truncate(openSpecDistributionPolicy.fileBytes+1);await append.close();
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/bound/);
  },60000);
  it.each(['files','directories','symlinks'] as const)('observes the actual exact %s limit then rejects +1',async kind=>{
    const f=await fixture();
    if(kind==='files'){
      const dir=path.join(f.pkg,'files');await mkdir(dir);
      for(let i=0;i<8190;i++)await writeFile(path.join(dir,`f${String(i).padStart(5,'0')}`),'');
    }else if(kind==='directories'){
      for(let i=0;i<4094;i++)await mkdir(path.join(f.pkg,`d${String(i).padStart(5,'0')}`));
    }else{
      for(let i=0;i<1024;i++)await symlink('bin/openspec.js',path.join(f.pkg,`l${String(i).padStart(5,'0')}`));
    }
    const observed=await captureOpenSpecDistribution(f.locator);
    expect(observed.commitment.counts[kind]).toBe(openSpecDistributionPolicy[kind]);
    if(kind==='files')await writeFile(path.join(f.pkg,'files/overflow'),'');
    else if(kind==='directories')await mkdir(path.join(f.pkg,'overflow'));
    else await symlink('bin/openspec.js',path.join(f.pkg,'overflow'));
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/bound/);
  },120000);
  it('hashes actual aggregate128MiB then rejects one additional byte',async()=>{
    const f=await fixture(),initial=await captureOpenSpecDistribution(f.locator);let left=openSpecDistributionPolicy.totalBytes-initial.commitment.counts.totalBytes;
    for(let i=0;left>0;i++){const size=Math.min(openSpecDistributionPolicy.fileBytes,left),h=await open(path.join(f.pkg,`data-${i}`),'wx');await h.truncate(size);await h.close();left-=size;}
    expect((await captureOpenSpecDistribution(f.locator)).commitment.counts.totalBytes).toBe(openSpecDistributionPolicy.totalBytes);
    await writeFile(path.join(f.pkg,'overflow'),'x');
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/bound/);
  },120000);
  it('checks actual path depth and per-directory membership boundaries',async()=>{
    const f=await fixture(),parts=Array(31).fill('d'),dir=path.join(f.pkg,...parts);await mkdir(dir,{recursive:true});
    await writeFile(path.join(dir,'leaf'),'');
    expect((await captureOpenSpecDistribution(f.locator)).inventory.files.some(f=>f.pathParts.length===32)).toBe(true);
    await mkdir(path.join(dir,'deeper'));await writeFile(path.join(dir,'deeper','leaf'),'');
    await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(/path/);
  },60000);
  it('captures real supplementary-plane and BMP member order without locale normalization',async()=>{
    const f=await fixture();
    for(const name of ['\ue000','\u{10000}'])await writeFile(path.join(f.pkg,name),'actual');
    const r=await captureOpenSpecDistribution(f.locator);
    expect(r.inventory.files.filter(f=>['\ue000','\u{10000}'].includes(f.pathParts[0])).map(f=>f.pathParts[0])).toEqual(['\u{10000}','\ue000']);
  });
  it('rejects structural count and byte overflows without a fake filesystem pass',async()=>{
    const f=await fixture(),v=(await captureOpenSpecDistribution(f.locator)).commitment;
    for(const [field,limit]of [['files',8192],['directories',4096],['symlinks',1024],['totalBytes',134217728]] as const){
      expect(()=>validateInstalledToolDistribution({...v,counts:{...v.counts,[field]:limit+1}})).toThrow(/bound/);
    }
    expect(()=>validateInstalledToolDistribution({...v,root:{...v.root,path:'/'+ 'a'.repeat(4097)}})).toThrow(/root/);
  });
});

describe('O-B1 R1 captured dependency lookup',()=>{
  it.each(['absent','misplaced-only','nested','hoisted','scoped-nested','scoped-hoisted','scoped-ancestor'] as const)('checks Node-compatible %s ancestry inside the inventory',async placement=>{
    const f=await fixture(),scoped=placement.startsWith('scoped-'),consumer=scoped?'@owned/consumer':'owned-consumer',
      required=scoped?'@required/dependency':'owned-required',consumerDir=path.join(f.pkg,'node_modules',consumer);
    await mkdir(consumerDir,{recursive:true});
    await writeFile(path.join(f.pkg,'package.json'),JSON.stringify({name:'@fission-ai/openspec',version:'1.11.0',type:'module',
      bin:{openspec:'./bin/openspec.js'},dependencies:{[consumer]:'1.0.0'}}));
    await writeFile(path.join(consumerDir,'package.json'),JSON.stringify({name:consumer,version:'1.0.0',dependencies:{[required]:'1.0.0'}}));
    const lookup=createRequire(path.join(consumerDir,'package.json')).resolve.paths(required);
    expect(lookup).not.toBeNull();if(!lookup)throw new Error('Expected pure package lookup paths.');
    const admittedLookup=lookup.filter(p=>p.startsWith(f.pkg+path.sep));
    expect(admittedLookup).toEqual([path.join(consumerDir,'node_modules'),
      ...(scoped?[path.join(f.pkg,'node_modules','@owned','node_modules')]:[]),path.join(f.pkg,'node_modules')]);
    const misplacedParent=path.join(f.pkg,'node_modules','node_modules');
    expect(admittedLookup).not.toContain(misplacedParent);
    const parent=placement==='misplaced-only'?misplacedParent:placement.endsWith('nested')?path.join(consumerDir,'node_modules'):
      placement==='scoped-ancestor'?path.join(f.pkg,'node_modules','@owned','node_modules'):path.join(f.pkg,'node_modules');
    if(placement!=='absent'){
      const target=path.join(parent,required);await mkdir(target,{recursive:true});
      await writeFile(path.join(target,'package.json'),JSON.stringify({name:required,version:'1.0.0'}));
    }
    const rejected=placement==='absent'||placement==='misplaced-only';
    if(rejected)await expect(captureOpenSpecDistribution(f.locator)).rejects.toThrow(`Required installed dependency is outside the complete distribution: ${required}`);
    else{
      expect(admittedLookup).toContain(parent);
      const observed=await captureOpenSpecDistribution(f.locator);
      expect(observed.inventory.files.some(entry=>entry.pathParts.join('/')===path.relative(f.pkg,path.join(parent,required,'package.json')).split(path.sep).join('/'))).toBe(true);
    }
    console.info('OB1_R1_DEPENDENCY '+JSON.stringify({placement,rejected,consumer,required,admittedLookup,
      lookupQuery:'Node builtin resolve.paths only; no module resolution, fixture code execution or external tree read',
      fixtureProvenance:'owned package-format contract, not installed-tool eligibility'}));
  });
});
