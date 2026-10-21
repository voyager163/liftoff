import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

type Files = { entries: Array<{ path: string }>; kind: string };
const original = {
  bundle: path.resolve('original-bundle'), manifest: { kind: 'original-manifest', package: { archive: { bytes: 3 } } },
  inputs: { kind: 'original-inputs' },
  tools: { entries: [{ path: 'tool' }, { path: 'runtime' }, { path: 'archive' }], kind: 'tools' },
  source: { entries: [{ path: 'source' }, { path: 'configuration' }, { path: 'test' }], kind: 'source' },
  output: { kind: 'original-output' }, archive: Buffer.from('abc')
};
type Readback = {
  kind: string; manifest: typeof original.manifest; sourceInputs: typeof original.inputs;
  packageArchive: { bytes: number; content: Buffer }; releaseAuthority: string;
  nativeQualification: string; workflowAuthority: string;
};
type Dependencies = {
  collectInputs: () => typeof original.inputs;
  assemblyFiles: (files: string[]) => Promise<Files>;
  verifyNativeBundle: (bundle: string) => Promise<typeof original.manifest>;
  assemblyOutput: (bundle: string) => Promise<typeof original.output>;
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function missingErrors() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-assembly-reader-'));
  roots.push(root);
  return Promise.all(['native', 'output'].map(async name => {
    try { await readFile(path.join(root, name)); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return error;
      throw error;
    }
    throw new Error('The missing-file control unexpectedly exists.');
  }));
}
async function readerWith(overrides: Partial<Dependencies> = {}) {
  const file = new URL('../scripts/native-bundle.mjs', import.meta.url), source = await readFile(file, 'utf8');
  const startMarker = '\nasync function readCapturedProgramAssembly(', endMarker = '\nasync function sourceFiles(';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  expect(source.indexOf(startMarker, start + startMarker.length)).toBe(-1);
  expect(source.indexOf(endMarker, end + endMarker.length)).toBe(-1);
  const body = source.slice(start, end);
  expect([...body.matchAll(/^(?:async )?function (\w+)\(/gm)].map(match => match[1])).toEqual(['readCapturedProgramAssembly']);
  const factory = compileFunction(`${body}\nreturn readCapturedProgramAssembly;`,
    ['assert', 'path', 'collectInputs', 'coveragePackage', 'assemblyFiles', 'verifyNativeBundle', 'assemblyOutput'],
    { filename: fileURLToPath(file) });
  const calls: string[] = [], methods: Dependencies = {
    collectInputs: () => structuredClone(original.inputs),
    assemblyFiles: async files => structuredClone(files[0] === 'tool' ? original.tools : original.source),
    verifyNativeBundle: async () => structuredClone(original.manifest),
    assemblyOutput: async () => structuredClone(original.output),
    ...overrides
  };
  const read: (value: typeof original) => Promise<Readback> = factory(assert, path,
    () => { calls.push('inputs'); return methods.collectInputs(); },
    (name: string) => { expect(name).toBe('cli'); return name; },
    (files: string[]) => {
      calls.push(files[0]!);
      expect(files).toEqual((files[0] === 'tool' ? original.tools : original.source).entries.map(entry => entry.path));
      return methods.assemblyFiles(files);
    },
    (bundle: string) => { calls.push('native'); return methods.verifyNativeBundle(bundle); },
    (bundle: string) => { calls.push('output'); return methods.assemblyOutput(bundle); });
  return { read: () => read(original), calls };
}

describe('private original assembly installed-readset scheduling', () => {
  it('freshly repeats every source/tool bracket and returns independent non-authoritative copies', async () => {
    const { read, calls } = await readerWith(), first = await read();
    expect(calls).toEqual(['inputs', 'tool', 'source', 'native', 'output', 'source', 'tool', 'inputs']);
    expect(first).toMatchObject({ kind: 'liftoff-original-native-program-content', releaseAuthority: 'not-issued',
      nativeQualification: 'not-issued', workflowAuthority: 'not-issued' });
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.packageArchive)).toBe(true);
    first.packageArchive.content.fill(0); first.manifest.kind = 'changed'; first.sourceInputs.kind = 'changed';
    const second = await read();
    expect(second.packageArchive.content.toString()).toBe('abc');
    expect(second.manifest).toEqual(original.manifest); expect(second.sourceInputs).toEqual(original.inputs);
    expect(calls).toEqual(Array(2).fill(['inputs', 'tool', 'source', 'native', 'output', 'source', 'tool', 'inputs']).flat());
  });

  it.each(['native', 'output'] as const)('overlaps both complete installed reads but waits for the pending %s read before final brackets', async pending => {
    const started = deferred(), gates = { native: deferred(), output: deferred() };
    const done = { native: deferred(), output: deferred() };
    let active = 0, maximum = 0, settled = false;
    async function capture<T>(name: 'native' | 'output', value: T) {
      active++; maximum = Math.max(maximum, active); started.resolve();
      try { await gates[name].promise; return structuredClone(value); }
      finally { active--; done[name].resolve(); }
    }
    const { read, calls } = await readerWith({
      verifyNativeBundle: () => capture('native', original.manifest),
      assemblyOutput: () => capture('output', original.output)
    });
    const observation = read().finally(() => { settled = true; });
    try {
      await started.promise;
      expect([...calls]).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
      expect(maximum).toBe(2);
      const completed = pending === 'native' ? 'output' : 'native';
      gates[completed].resolve(); await done[completed].promise;
      expect(active).toBe(1); expect(settled).toBe(false);
      expect([...calls]).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
    } finally {
      gates.native.resolve(); gates.output.resolve(); await observation;
    }
    expect(active).toBe(0);
    expect(calls).toEqual(['inputs', 'tool', 'source', 'native', 'output', 'source', 'tool', 'inputs']);
  });

  it.each(['native', 'output'] as const)('drains both actual filesystem failures with %s finishing first and preserves the original native error', async first => {
    const errors = await missingErrors(), started = deferred();
    const gates = { native: deferred(), output: deferred() }, done = { native: deferred(), output: deferred() };
    let active = 0, settled = false;
    async function fail(name: 'native' | 'output', error: Error): Promise<never> {
      active++; started.resolve();
      try { await gates[name].promise; throw error; }
      finally { active--; done[name].resolve(); }
    }
    const { read, calls } = await readerWith({
      verifyNativeBundle: () => fail('native', errors[0]!),
      assemblyOutput: () => fail('output', errors[1]!)
    });
    const observation = read().then(
      () => { settled = true; return { status: 'fulfilled' as const }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    try {
      await started.promise; expect(active).toBe(2);
      gates[first].resolve(); await done[first].promise;
      expect(active).toBe(1); expect(settled).toBe(false);
      expect([...calls]).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
    } finally { gates.native.resolve(); gates.output.resolve(); }
    const result = await observation;
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Failed original readsets must not return content.');
    expect(result.reason).toBe(errors[0]); expect(active).toBe(0);
    expect([...calls]).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
  });

  it('preserves the earlier manifest semantic refusal over a later actual output failure', async () => {
    const errors = await missingErrors();
    const { read, calls } = await readerWith({
      verifyNativeBundle: async () => ({ ...original.manifest, kind: 'changed' }),
      assemblyOutput: async () => { throw errors[1]; }
    });
    await expect(read()).rejects.toThrow('Original installed assembly changed.');
    expect(calls).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
  });

  it.each(['native', 'output'] as const)('waits for the successful sibling after an original %s filesystem refusal', async failed => {
    const errors = await missingErrors(), started = deferred(), sibling = deferred();
    let settled = false;
    const { read, calls } = await readerWith({
      async verifyNativeBundle() {
        started.resolve();
        if (failed === 'native') throw errors[0];
        await sibling.promise; return structuredClone(original.manifest);
      },
      async assemblyOutput() {
        if (failed === 'output') throw errors[1];
        await sibling.promise; return structuredClone(original.output);
      }
    });
    const observation = read().then(
      () => { settled = true; return { status: 'fulfilled' as const }; },
      reason => { settled = true; return { status: 'rejected' as const, reason }; }
    );
    try {
      await started.promise;
      expect(calls).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
      expect(settled).toBe(false);
    } finally { sibling.resolve(); }
    const result = await observation;
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('A failed original readset must not return content.');
    expect(result.reason).toBe(errors[failed === 'native' ? 0 : 1]);
    expect(calls).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
  });

  it('refuses the complete output comparison before starting either final physical bracket', async () => {
    const { read, calls } = await readerWith({ assemblyOutput: async () => ({ kind: 'changed' }) });
    await expect(read()).rejects.toThrow('Original installed assembly readset changed.');
    expect(calls).toEqual(['inputs', 'tool', 'source', 'native', 'output']);
  });

  it.each(['inputs-before', 'tool-before', 'source-before', 'source-after', 'tool-after', 'inputs-after'])(
    'retains the independent fresh %s refusal', async failure => {
      let inputs = 0, tools = 0, sources = 0;
      const { read, calls } = await readerWith({
        collectInputs() {
          inputs++;
          return { kind: failure === `inputs-${inputs === 1 ? 'before' : 'after'}` ? 'changed' : original.inputs.kind };
        },
        async assemblyFiles(files) {
          const name = files[0] === 'tool' ? 'tool' : 'source';
          const count = name === 'tool' ? ++tools : ++sources;
          return { ...structuredClone(name === 'tool' ? original.tools : original.source),
            ...(failure === `${name}-${count === 1 ? 'before' : 'after'}` ? { kind: 'changed' } : {}) };
        }
      });
      await expect(read()).rejects.toBeInstanceOf(assert.AssertionError);
      const before = failure.endsWith('-before');
      expect(calls.includes('native')).toBe(!before);
      expect(calls.includes('output')).toBe(!before);
      if (failure === 'source-after') expect(calls.at(-1)).toBe('source');
      if (failure === 'tool-after') expect(calls.at(-1)).toBe('tool');
      if (failure === 'inputs-after') expect(calls.at(-1)).toBe('inputs');
    }
  );
});
