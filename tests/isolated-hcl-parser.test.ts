import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIsolatedHcl, scheduleIsolatedHcl, isolatedHclRemaining } from '../src/adapters/hcl/isolated-parser.js';
import {
  hclComputationPolicy, hclPolicyDigest, hclRawDigest, makeHclRequest, validateHclReply, validateHclTransport,
  ownHclRecord, type HclExpression, type HclExpressionNode
} from '../src/adapters/hcl/parser-child.js';
import { buildArtifacts } from '../src/templates.js';
import { buildProjectPlan } from '../src/application/project/planning.js';


function resolveHclTestLane(value: string | undefined, runtime: { platform: string; arch: string; node: string }) {
  const mode = value ?? 'auto';
  if (!['auto', 'portable', 'native'].includes(mode)) throw new Error('Invalid LIFTOFF_HCL_TEST_LANE; expected auto, portable or native.');
  const qualified = runtime.platform === 'darwin' && runtime.arch === 'arm64' && runtime.node === '24.21.0';
  if (mode === 'native' && !qualified) throw new Error('Native HCL qualification requires actual darwin/arm64/Node24.21.0; no cases were qualified.');
  return { mode, qualified, native: mode !== 'portable' && qualified };
}
const testLane = resolveHclTestLane(process.env.LIFTOFF_HCL_TEST_LANE, {
  platform: process.platform, arch: process.arch, node: process.versions.node
});
const nativeIt = it.skipIf(!testLane.native);
const nativeCaseTemplates = [
  "freshly reproduces every actual recorded validator specimen without injecting parser results",
  "parses actual cold/repeated configurations and expressions from neutral cwd",
  "copies nested source intake and rejects concurrent admission without a queue",
  "packs65 actual small sources into three bounded children",
  "parses actual generated HCL without claiming provider eligibility",
  "does not inherit poisoned ambient loader, credential or temporary-root values",
  "settles actual fixed %s fault and permits a healthy subsequent parser",
  "kills and settles an actual hanging child at the fixed deadline",
  "demonstrates actual WASM cap in a test-owned canary, never authored source",
  "refuses2049 distinct expression calls across batches and recovers",
  "enforces real helper stdin framing and refuses invocation without resource flags",
  "admits actual source-bound static key forms: %s",
  "rejects opaque, ambiguous or outside-static-atom keys: %s",
  "models an unconfirmed child deterministically and latches unavailable without leaving a process"
];
const executedCaseNames: string[] = [];
beforeEach(({ task }) => { executedCaseNames.push(task.name); });
afterAll(() => {
  if (testLane.mode === 'native') {
    expect(nativeCaseTemplates.length).toBeGreaterThan(0);
    for (const title of ["parses actual cold/repeated configurations and expressions from neutral cwd","kills and settles an actual hanging child at the fixed deadline","demonstrates actual WASM cap in a test-owned canary, never authored source"]) expect(executedCaseNames).toContain(title);
  }
  console.info('LIFTOFF_HCL_TEST_INVENTORY ' + JSON.stringify({
    file: 'tests/isolated-hcl-parser.test.ts', lane: testLane.mode,
    actualRuntime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    nativeSelected: testLane.native, nativeUnrunTemplates: testLane.native ? [] : nativeCaseTemplates,
    executedCaseNames, claim: testLane.mode === 'portable' && testLane.qualified
      ? 'Forced-portable routing and synthetic runtime rejection only; not Linux/Windows/Node24.20 qualification.'
      : 'Current-host test evidence only.'
  }));
});

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
async function recordedValidatorInput(text: string) {
  const raw: unknown = JSON.parse(await readFile(new URL('./fixtures/hcl/isolated-parser-v2.json', import.meta.url), 'utf8'));
  const fixture = ownHclRecord(raw, ['kind', 'schemaVersion', 'provenance', 'use', 'specimens']);
  expect(fixture.kind).toBe('liftoff-isolated-hcl-recorded-validator-specimens');
  const provenance = ownHclRecord(fixture.provenance, ['runtime', 'parserPackage', 'parserPackageVersion', 'protocolVersion', 'policyDigest', 'helperSha256']);
  expect(provenance.policyDigest).toBe(hclPolicyDigest);
  expect(provenance.runtime).toEqual(hclComputationPolicy.qualifiedRuntime);
  expect(provenance.parserPackageVersion).toBe(hclComputationPolicy.parserPackageVersion);
  expect(provenance.protocolVersion).toBe(2);
  expect(Array.isArray(fixture.specimens)).toBe(true);
  if (!Array.isArray(fixture.specimens)) throw new Error('Recorded specimens must be an array.');
  const request = makeHclRequest([{ id: '0', text, sourceSha256: hclRawDigest(text) }], 2048, 8388608);
  for (const item of fixture.specimens) {
    const specimen = ownHclRecord(item, ['id', 'request', 'reply']);
    const captured = ownHclRecord(specimen.request, ['schemaVersion', 'policyDigest', 'requestId', 'expressionAllowance', 'replyAllowance', 'documents']);
    if (captured.requestId !== request.requestId) continue;
    expect(specimen.request).toEqual(request);
    const reply = validateHclReply(specimen.reply, request);
    return { parsed: reply.results[0].parsed, expressions: new Map(reply.expressions.map(expression => [expression.value, expression.ast])) };
  }
  throw new Error('No actual recorded helper specimen matches the validator input.');
}
async function validatorInput(text: string) {
  return testLane.native ? (await parseIsolatedHcl([text]))[0] : recordedValidatorInput(text);
}
const cleanups: string[] = [], pids: number[] = [], profiles: string[] = [];
afterEach(async () => {
  vi.mocked(spawn).mockImplementation(real.spawn);
  vi.useRealTimers();
  for (const pid of pids.splice(0)) expect(() => process.kill(pid, 0)).toThrow();
  for (const profile of profiles.splice(0)) await expect(lstat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const root of cleanups.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const faultSource = `
const mode = process.argv[2];
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'crash') process.exit(71);
else if (mode === 'signal') process.kill(process.pid, 'SIGKILL');
else if (mode === 'malformed') process.stdout.write('{"broken":', () => process.exit(0));
else if (mode === 'extra') process.stdout.write('{} {}', () => process.exit(0));
else if (mode === 'deep') process.stdout.write('['.repeat(257)+'0'+']'.repeat(257), () => process.exit(0));
else if (mode === 'utf8') process.stdout.write(Buffer.from([0xc0, 0xaf]), () => process.exit(0));
else if (mode === 'stdout' || mode === 'stderr') {
  const output = mode === 'stdout' ? process.stdout : process.stderr;
  for (;;) if (!output.write(Buffer.alloc(16384, 97))) await new Promise(resolve => output.once('drain', resolve));
} else if (mode === 'binding' || mode === 'ast') {
  let text = ''; for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  process.stdout.write(JSON.stringify({schemaVersion:2,policyDigest:input.policyDigest,requestId:mode==='binding'?'0'.repeat(64):input.requestId,
    status:'ok',results:input.documents.map(file=>({id:file.id,sourceSha256:file.sourceSha256,parsed:{value:'\${file("./one")}'}})),
    expressions:[{value:'\${file("./one")}',sourceSha256:'0'.repeat(64),ast:{type:'template'}}],expressionCalls:1}),()=>process.exit(0));
} else if (mode === 'wasm') {
  const memory = new WebAssembly.Memory({initial:1,maximum:4096});
  memory.grow(2047); let refused=false;
  try { memory.grow(1); } catch (error) { refused=error instanceof RangeError; }
  process.stdout.write(JSON.stringify({pages:memory.buffer.byteLength/65536,refused}),()=>process.exit(refused && memory.buffer.byteLength/65536===2048 ? 0 : 1));
}
`;
async function fault(mode: string): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isolated-hcl-fault-')); cleanups.push(directory);
  const target = path.join(directory, 'fault.mjs'); await writeFile(target, faultSource);
  vi.mocked(spawn).mockImplementation((executable, args = [], options = {}) => {
    expect(executable).toBe(process.execPath);
    expect(args.slice(0, 3)).toEqual(['--wasm-max-mem-pages=2048', '--max-old-space-size=128', '--max-semi-space-size=8']);
    expect(args[3]).toMatch(/\/src\/adapters\/hcl\/parser-child\.ts$/);
    expect(options.shell).toBe(false);
    expect(String(options.cwd)).toMatch(/^\/private\/tmp\/liftoff-hcl-[^/]+\/cwd$/);
    profiles.push(path.dirname(String(options.cwd)));
    const child = real.spawn(mode === 'startup' ? path.join(directory, 'absent') : executable,
      [...args.slice(0, 3), target, mode], options);
    if (child.pid) pids.push(child.pid);
    return child;
  });
}

describe('fixed isolated HCL computation', () => {
  it('rejects invalid lane and synthetic native mismatch before test registration succeeds', () => {
    expect(() => resolveHclTestLane('invalid', { platform: process.platform, arch: process.arch, node: process.versions.node })).toThrow(/Invalid/);
    expect(() => resolveHclTestLane('native', { platform: 'unqualified-test-host', arch: process.arch, node: process.versions.node })).toThrow(/requires actual/);
  });
  nativeIt('freshly reproduces every actual recorded validator specimen without injecting parser results', async () => {
    for (const text of [
      'locals { policy = file("./policy.json") }',
      'locals { payload = merge({ prefix = "é🌍" }, { first = { nested = "actual" }, "second-key" = file("./policy.json") }) }\n'
    ]) {
      const recorded = await recordedValidatorInput(text);
      expect((await parseIsolatedHcl([text]))[0]).toEqual(recorded);
    }
  });
  nativeIt('parses actual cold/repeated configurations and expressions from neutral cwd', async () => {
    const input = ['locals { enabled = true }\n', 'locals { policy = file("./policy.json") }\n'];
    const first = await parseIsolatedHcl(input), second = await parseIsolatedHcl(input);
    expect(second).toEqual(first);
    expect(first[0].parsed).toEqual({ locals: [{ enabled: true }] });
    expect(first[1].expressions.size).toBe(1);
    for (const call of vi.mocked(spawn).mock.calls) {
      const args = call[1] as readonly string[], options = call[2] as SpawnOptionsWithoutStdio;
      expect(args).toHaveLength(4); expect(args[3]).toMatch(/parser-child\.ts$/);
      expect(String(options.cwd)).toMatch(/^\/private\/tmp\/liftoff-hcl-/);
      expect(options.env?.NODE_OPTIONS).toBeUndefined(); expect(options.env?.PATH).toBeUndefined();
      expect(options.env?.LIFTOFF_HCL_TEST_LANE).toBeUndefined();
      profiles.push(path.dirname(String(options.cwd)));
    }
  });
  it('has inert policy exports, an immutable runtime tuple and no loader flags', async () => {
    const count = vi.mocked(spawn).mock.calls.length;
    const module = await import('../src/adapters/hcl/parser-child.js');
    expect(module.hclComputationPolicy).toBe(hclComputationPolicy);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(count);
    expect(Object.isFrozen(hclComputationPolicy.qualifiedRuntime)).toBe(true);
    expect(hclComputationPolicy.qualifiedRuntime).toEqual({ platform: 'darwin', arch: 'arm64', node: '24.21.0' });
    expect(hclPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  nativeIt('copies nested source intake and rejects concurrent admission without a queue', async () => {
    const sources = ['locals { original = true }'], pending = parseIsolatedHcl(sources);
    const getter = vi.fn(() => { throw new Error('late source getter'); });
    Object.defineProperty(sources, 0, { get: getter, enumerable: true });
    await expect(parseIsolatedHcl(['locals {}'])).rejects.toThrow(/busy/);
    expect((await pending)[0].parsed).toEqual({ locals: [{ original: true }] });
    expect(getter).not.toHaveBeenCalled();
    await expect(parseIsolatedHcl(sources)).rejects.toThrow(/own text/);
  });
  nativeIt('packs65 actual small sources into three bounded children', async () => {
    const count = vi.mocked(spawn).mock.calls.length;
    const results = await parseIsolatedHcl(Array.from({ length: 65 }, (_, index) => `locals { value = ${index} }`));
    expect(results).toHaveLength(65);
    expect(vi.mocked(spawn).mock.calls.length - count).toBe(3);
  });
  nativeIt('parses actual generated HCL without claiming provider eligibility', async () => {
    const unique = new Set<string>();
    for (const selection of [
      { projectType: 'standard', apiStack: 'node-fastify', includeFrontend: true },
      { projectType: 'standard', apiStack: 'go-huma', includeFrontend: false },
      { projectType: 'standard', apiStack: 'python-fastapi', includeFrontend: true },
      { pattern: 'rag', includeFrontend: true }
    ]) {
      const plan = buildProjectPlan({ projectName: 'Isolated Parser Corpus', cloud: 'azure', region: 'eastus',
        environments: ['prod', 'dev'], agents: ['github-copilot'], specWorkflow: 'openspec', ...selection }, { requireProjectName: true });
      for (const file of buildArtifacts(plan).filter(file => file.pathParts.at(-1)?.endsWith('.tf'))) unique.add(file.content);
    }
    expect(unique.size).toBeGreaterThan(20);
    expect(await parseIsolatedHcl([...unique])).toHaveLength(unique.size);
  });
  nativeIt('does not inherit poisoned ambient loader, credential or temporary-root values', async () => {
    vi.stubEnv('NODE_OPTIONS', '--require=/never/load.cjs');
    vi.stubEnv('NODE_PATH', '/never/load');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'test-only-not-a-real-secret');
    vi.stubEnv('TMPDIR', '/project-controlled-and-absent');
    try {
      await parseIsolatedHcl(['locals {}']);
      const options = vi.mocked(spawn).mock.calls.at(-1)![2] as SpawnOptionsWithoutStdio;
      expect(options.env?.NODE_OPTIONS).toBeUndefined(); expect(options.env?.NODE_PATH).toBeUndefined();
      expect(options.env?.AZURE_CLIENT_SECRET).toBeUndefined(); expect(options.cwd).not.toContain('/project-controlled');
      profiles.push(path.dirname(String(options.cwd)));
    } finally { vi.unstubAllEnvs(); }
  });
  nativeIt.each(['crash', 'signal', 'startup', 'malformed', 'extra', 'deep', 'utf8', 'binding', 'ast', 'stdout', 'stderr'])(
    'settles actual fixed %s fault and permits a healthy subsequent parser', async mode => {
      await fault(mode);
      await expect(parseIsolatedHcl(['locals {}'])).rejects.toThrow(/Isolated HCL|Isolated parser|HCL expression/);
      vi.mocked(spawn).mockImplementation(real.spawn);
      expect((await parseIsolatedHcl(['locals { recovered = true }']))[0].parsed).toEqual({ locals: [{ recovered: true }] });
    }
  );
  nativeIt('kills and settles an actual hanging child at the fixed deadline', async () => {
    await fault('hang');
    await expect(parseIsolatedHcl(['locals {}'])).rejects.toThrow(/unavailable/);
    vi.mocked(spawn).mockImplementation(real.spawn);
    expect(await parseIsolatedHcl(['locals {}'])).toHaveLength(1);
  }, 15000);
  nativeIt('demonstrates actual WASM cap in a test-owned canary, never authored source', async () => {
    await fault('wasm');
    await expect(parseIsolatedHcl(['locals {}'])).rejects.toThrow(/record fields|correspondence/);
    const child = vi.mocked(spawn).mock.results.at(-1)?.value as ChildProcessWithoutNullStreams;
    expect(child.exitCode).toBe(0);
  });
  nativeIt('refuses2049 distinct expression calls across batches and recovers', async () => {
    const sources = Array.from({ length: 65 }, (_, file) =>
      `locals {\n ${Array.from({ length: file === 64 ? 1 : 32 }, (_, index) => `v${index} = upper("literal-${file}-${index}")`).join('\n')}\n}\n`);
    expect(await parseIsolatedHcl(sources.slice(0, 64))).toHaveLength(64);
    const requests: string[] = [], calls: number[] = [];
    vi.mocked(spawn).mockImplementation((executable, args = [], options = {}) => {
      const child = real.spawn(executable, args, options);
      const stdin = child.stdin!;
      const original = stdin.end.bind(stdin);
      vi.spyOn(stdin, 'end').mockImplementation((...input: Parameters<typeof stdin.end>) => {
        if (Buffer.isBuffer(input[0])) requests.push(input[0].toString());
        return original(...input);
      });
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => { if (output.length < 8388608) output += chunk.toString(); });
      child.once('close', () => { if (child.exitCode === 0) calls.push(JSON.parse(output).expressionCalls); });
      return child;
    });
    await expect(parseIsolatedHcl(sources)).rejects.toThrow(/unavailable/);
    expect(requests.map(value => JSON.parse(value).expressionAllowance)).toEqual([2048, 1024, 0]);
    expect(calls).toEqual([1024, 1024]);
    vi.mocked(spawn).mockImplementation(real.spawn);
    expect(await parseIsolatedHcl(['locals {}'])).toHaveLength(1);
  }, 15000);
  it('rejects an unsupported runtime before spawn without rejecting parser-free input', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;
    const count = vi.mocked(spawn).mock.calls.length;
    Object.defineProperty(process, 'arch', { ...descriptor, value: 'x64' });
    try {
      await expect(parseIsolatedHcl(['locals {}'])).rejects.toThrow(/not the qualified/);
      expect(await parseIsolatedHcl([])).toEqual([]);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(count);
    } finally { Object.defineProperty(process, 'arch', descriptor); }
  });
  nativeIt('enforces real helper stdin framing and refuses invocation without resource flags', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'isolated-hcl-direct-')); cleanups.push(directory);
    const helper = path.resolve('src/adapters/hcl/parser-child.ts');
    const flags = ['--wasm-max-mem-pages=2048', '--max-old-space-size=128', '--max-semi-space-size=8'];
    for (const [args, input] of [
      [[...flags, helper], Buffer.alloc(hclComputationPolicy.requestBytes + 1, 0x20)],
      [[helper], Buffer.from('{}')]
    ] as const) {
      const result = real.spawnSync(process.execPath, [...args], {
        cwd: directory, env: { HOME: directory, TMPDIR: directory, NODE_DISABLE_COMPILE_CACHE: '1' },
        input, maxBuffer: 65536, timeout: 10000, killSignal: 'SIGKILL'
      });
      expect(result.status).toBe(2); expect(result.error).toBeUndefined();
      expect(() => process.kill(result.pid, 0)).toThrow();
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: 'blocked', code: 'computation-unavailable' });
      expect(result.stderr.length).toBe(0);
    }
  });
});

describe('separate arithmetic and transport validation', () => {
  const literalObjects = [
    'jsonencode({ label = "actual" })',
    'jsonencode({ "label" = "actual", other = 1 })',
    'jsonencode({ z = { nested = "actual" }, a = file("./policy.json") })',
    'merge({ first = "actual" }, { second = filebase64("./policy.json") })',
    'merge({ prefix = "é🌍" }, { "later-key" = "value", "clé" = "café" })',
    'jsonencode({ a = { b = 2 }, c = [ { d = 3 } ] })',
    'jsonencode({ label = "a } string", escaped = "q\\"uote", next = true })',
    'jsonencode({ label : "actual", other = null })',
    'jsonencode({ a = "actual"\n b = "next"\n})'
  ];
  nativeIt.each(literalObjects)('admits actual source-bound static key forms: %s', async expression => {
    const source = `locals { payload = ${expression} }\n`;
    const [result] = await parseIsolatedHcl([source]);
    expect(result.parsed).toBeDefined();
    expect(result.expressions.size).toBeGreaterThan(0);
    const markers: HclExpression[] = [];
    const pending = [...result.expressions.values()];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === '') { markers.push(node); expect(node).not.toHaveProperty('meta'); }
      pending.push(...node.children);
    }
    expect(markers.length).toBeGreaterThan(0);
  });
  nativeIt.each([
    'jsonencode({ (file("./private-key.txt")) = "actual" })',
    'jsonencode({ "${file("./private-key.txt")}" = "actual" })',
    'jsonencode({ (filebase64("./private-key.txt")) = "actual" })',
    'jsonencode({ (templatefile("./private-key.txt", {})) = "actual" })',
    'jsonencode({ ("literal") = "actual" })',
    'jsonencode({ (var.dynamic) = "actual" })',
    'jsonencode({ "a\\\\b" = "actual" })',
    'jsonencode({ "q\\"uote" = "actual" })',
    'jsonencode({ a = "first", a = "second" })',
    'jsonencode({ a = "first", "a" = "second" })',
    'jsonencode({ /* comment */ label = "actual" })'
  ])('rejects opaque, ambiguous or outside-static-atom keys: %s', async expression => {
    await expect(parseIsolatedHcl([`locals { payload = ${expression} }\n`])).rejects.toThrow(/unavailable/);
  });
  it('rejects forged key spans, membership and parent positions starting only from real parser results', async () => {
    const text = 'locals { payload = merge({ prefix = "é🌍" }, { first = { nested = "actual" }, "second-key" = file("./policy.json") }) }\n';
    const parsed = await validatorInput(text);
    const request = makeHclRequest([{ id: '0', text, sourceSha256: hclRawDigest(text) }], 2048, 8388608);
    const reply = { schemaVersion: 2, policyDigest: hclPolicyDigest, requestId: request.requestId, status: 'ok',
      results: [{ id: '0', sourceSha256: hclRawDigest(text), parsed: parsed.parsed }],
      expressions: [...parsed.expressions].map(([value, ast]) => ({ value, sourceSha256: hclRawDigest(value), ast })),
      expressionCalls: parsed.expressions.size };
    expect(validateHclReply(reply, request).expressionCalls).toBe(1);
    function nodes(root: HclExpression): HclExpressionNode[] {
      const result: HclExpressionNode[] = [], pending = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.type !== '') result.push(node);
        pending.push(...node.children);
      }
      return result;
    }
    for (const fault of ['missing-key','extra-key','reorder-pairs','swap-values','duplicate-key','metadata-value','metadata-missing','metadata-extra','range-shift','range-split','utf16-offset','key-meta','key-child','value-marker','function-marker','object-range','root-child-omission','protocol','policy','omitted-expression']) {
      const altered = structuredClone(reply), all = nodes(altered.expressions[0].ast);
      const object = all.find(node => node.type === 'object' && String(node.meta.value).includes('"second-key"'))!;
      const marker = object.children[0], items = ownHclRecord(object.meta.items, ['first', '"second-key"']);
      if (fault === 'missing-key') object.children.splice(0,2);
      if (fault === 'extra-key') object.children.push(...structuredClone(object.children.slice(0,2)));
      if (fault === 'reorder-pairs') object.children = [...object.children.slice(2),...object.children.slice(0,2)];
      if (fault === 'swap-values') [object.children[1],object.children[3]] = [object.children[3],object.children[1]];
      if (fault === 'duplicate-key') object.children[2] = structuredClone(marker);
      if (fault === 'metadata-value') items.first = '"unrelated"';
      if (fault === 'metadata-missing') delete items.first;
      if (fault === 'metadata-extra') items.extra = '"unrepresented"';
      if (fault === 'range-shift' || fault === 'range-split') {
        const span = ownHclRecord(marker.range,['start','end']), start = ownHclRecord(span.start,['line','column','byte']);
        start.byte = Number(start.byte) - (fault === 'range-shift' ? 1 : 7);
      }
      if (fault === 'key-meta') Reflect.set(marker,'meta',{value:'first'});
      if (fault === 'key-child') marker.children = [object.children[3]];
      if (fault === 'value-marker') object.children[1] = structuredClone(marker);
      if (fault === 'function-marker') all.find(node => node.type === 'function')!.children[0] = structuredClone(marker);
      if (fault === 'object-range') {
        const span = ownHclRecord(object.range,['start','end']), start = ownHclRecord(span.start,['line','column','byte']);
        start.byte = Number(start.byte) + 1;
      }
      if (fault === 'root-child-omission') altered.expressions[0].ast.children = [];
      if (fault === 'utf16-offset') {
        const expression = altered.expressions[0].value, source = `<<LIFTOFF_REPAIR_EXPRESSION\n${expression}\nLIFTOFF_REPAIR_EXPRESSION\n`;
        const span = ownHclRecord(marker.range,['start','end']), start = ownHclRecord(span.start,['line','column','byte']);
        const byte = Number(start.byte), wrong = Buffer.from(source).subarray(0,byte).toString('utf8').length;
        expect(wrong).toBeLessThan(byte);
        start.byte = wrong;
      }
      if (fault === 'protocol') altered.schemaVersion = 1;
      if (fault === 'policy') altered.policyDigest = '0'.repeat(64);
      if (fault === 'omitted-expression') altered.expressions = [];
      expect(() => validateHclReply(altered,request),fault).toThrow();
    }
    const oldRequest = structuredClone(request); Reflect.set(oldRequest,'schemaVersion',1);
    expect(() => validateHclReply(reply,oldRequest)).toThrow();
  });
  it('preserves source and process admission bounds without running proxies for successful parsing', () => {
    expect(scheduleIsolatedHcl(Array.from({ length: 512 }, () => ''))).toHaveLength(16);
    expect(() => scheduleIsolatedHcl(Array.from({ length: 513 }, () => ''))).toThrow();
    expect(scheduleIsolatedHcl(Array.from({ length: 8 }, () => ' '.repeat(1048576)))).toHaveLength(8);
    expect(() => scheduleIsolatedHcl([...Array.from({ length: 8 }, () => ' '.repeat(1048576)), ' '])).toThrow();
    expect(scheduleIsolatedHcl(Array.from({ length: 64 }, () => ' '.repeat(65537)))).toHaveLength(64);
    expect(() => scheduleIsolatedHcl(Array.from({ length: 65 }, () => ' '.repeat(65537)))).toThrow();
    expect(isolatedHclRemaining(59999, 33554431, 2048)).toEqual({ deadline: 1, reply: 1, expressions: 0 });
    expect(() => isolatedHclRemaining(60000, 0, 0)).toThrow();
    expect(() => isolatedHclRemaining(0, 33554432, 0)).toThrow();
  });
  it('rejects fake/incomplete reply ASTs rather than trusting ast.type', () => {
    const request = makeHclRequest([{ id: '0', text: 'locals {}', sourceSha256: hclRawDigest('locals {}') }], 2048, 8388608);
    expect(() => validateHclReply({ schemaVersion: 2, policyDigest: hclPolicyDigest, requestId: request.requestId,
      status: 'ok', results: [{ id: '0', sourceSha256: request.documents[0].sourceSha256, parsed: { value: '${var.x}' } }],
      expressions: [{ value: '${var.x}', sourceSha256: hclRawDigest('${var.x}'), ast: { type: 'template' } }], expressionCalls: 1 }, request)).toThrow();
  });
  it('validates complete real AST metadata, arity and expression correspondence before consumers', async () => {
    const text = 'locals { policy = file("./policy.json") }', parsed = await validatorInput(text);
    const request = makeHclRequest([{ id: '0', text, sourceSha256: hclRawDigest(text) }], 2048, 8388608);
    const reply = { schemaVersion: 2, policyDigest: hclPolicyDigest, requestId: request.requestId, status: 'ok',
      results: [{ id: '0', sourceSha256: hclRawDigest(text), parsed: parsed.parsed }],
      expressions: [...parsed.expressions].map(([value, ast]) => ({ value, sourceSha256: hclRawDigest(value), ast })),
      expressionCalls: parsed.expressions.size };
    expect(validateHclReply(reply, request).results[0].parsed).toEqual(parsed.parsed);
    for (const fault of ['range', 'unknown', 'missing', 'extra', 'boolean', 'root-source', 'children', 'expression-count']) {
      const altered = structuredClone(reply);
      const root = altered.expressions[0].ast, call = root.children.find(node => node.type === 'function')!;
      if (root.type === '' || call.type === '') throw new Error('Expected actual expression nodes.');
      if (fault === 'range') root.range = { start: { byte: -1, line: 1, column: 1 }, end: { byte: 1, line: 1, column: 1 } };
      if (fault === 'unknown') Reflect.set(call, 'type', 'future-expression');
      if (fault === 'missing') delete call.meta.name;
      if (fault === 'extra') call.meta.invented = true;
      if (fault === 'boolean') call.meta.expandedFinalArgument = 'false';
      if (fault === 'root-source') root.meta.value = 'unrelated';
      if (fault === 'children') call.children = [];
      if (fault === 'expression-count') altered.expressionCalls = 0;
      expect(() => validateHclReply(altered, request), fault).toThrow();
    }
  });
  it('keeps transport intake depth/string/node bounds distinct from semantic visits', () => {
    let value: unknown = 0;
    for (let depth = 0; depth < hclComputationPolicy.replyEnvelopeDepth; depth++) value = [value];
    expect(() => validateHclTransport(value)).not.toThrow();
    expect(() => validateHclTransport([value])).toThrow(/structure/);
    expect(() => validateHclTransport('a'.repeat(hclComputationPolicy.replyDecodedStringBytes))).not.toThrow();
    expect(() => validateHclTransport('a'.repeat(hclComputationPolicy.replyDecodedStringBytes + 1))).toThrow(/string/);
  });
  nativeIt('models an unconfirmed child deterministically and latches unavailable without leaving a process', async () => {
    vi.resetModules();
    const fresh = await import('../src/adapters/hcl/isolated-parser.js');
    vi.useFakeTimers();
    const synthetic = new real.ChildProcess();
    synthetic.stdin = new PassThrough(); synthetic.stdout = new PassThrough(); synthetic.stderr = new PassThrough();
    Object.defineProperty(synthetic, 'pid', { value: process.pid });
    const killed = vi.spyOn(synthetic, 'kill').mockReturnValue(true);
    const count = vi.mocked(spawn).mock.calls.length;
    // A synthetic ChildProcess exercises uncertainty only; it never emits a
    // successful parser reply, spawns a process, or signals this PID.
    vi.mocked(spawn).mockImplementation(() => synthetic);
    const pending = expect(fresh.parseIsolatedHcl(['locals {}'])).rejects.toThrow(/shutdown could not be verified/);
    await vi.advanceTimersByTimeAsync(11000);
    await pending;
    await expect(fresh.parseIsolatedHcl(['locals {}'])).rejects.toThrow(/shutdown is unconfirmed/);
    expect(vi.mocked(spawn).mock.calls.length - count).toBe(1);
    expect(killed).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    // Retention is intentional; inspect and remove only this test's known empty
    // workspace after proving no real child was created by this instrumentation.
    const options = vi.mocked(spawn).mock.calls.at(-1)![2] as SpawnOptionsWithoutStdio;
    const owned = path.dirname(String(options.cwd));
    const entries = (await import('node:fs/promises')).readdir;
    expect((await entries(owned)).sort()).toEqual(['appdata','cache','config','cwd','data','home','localappdata','state','tmp']);
    for (const name of await entries(owned)) expect(await entries(path.join(owned, name))).toEqual([]);
    await rm(owned, { recursive: true });
  });
});
