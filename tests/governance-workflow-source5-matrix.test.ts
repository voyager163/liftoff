import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { GitHubActivationError } from '../src/adapters/github/activation-rest.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import * as workflowRuntime from '../src/governance-activation/workflow-runtime.js';
import * as workflowPorts from '../src/governance-activation/workflow-source5-ports.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  source5WorkflowAuthorityValue, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import {
  readCurrentWorkflowContextProof, verifyProtectedWorkflowProofMatrix, verifySource5WorkflowProofMatrix
} from '../src/governance-activation/workflow-context-proof.js';
import {
  observeSource5WorkflowPlanMatrix, type Source5WorkflowPlanComponentFields
} from '../src/governance-activation/workflow-source5-components.js';
import {
  matrixValidatorConclusion, matrixValidatorEnvironment, matrixValidatorFailure, workflowSource5MatrixFixture
} from './fixtures/workflow-source5-matrix.js';

const fixtures: Awaited<ReturnType<typeof workflowSource5MatrixFixture>>[] = [];
type MatrixFixture = Awaited<ReturnType<typeof workflowSource5MatrixFixture>>;
type Observation = Awaited<ReturnType<MatrixFixture['entries']>>;
interface MatrixSession {
  readonly pending: boolean;
  read<T>(reader: (value: Observation) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const sessions: MatrixSession[] = [];
const preparations = new Set<Promise<unknown>>();
let prepared: Awaited<ReturnType<typeof workflowSource5MatrixFixture>> | undefined;
let originalProviderState: Awaited<ReturnType<typeof workflowSource5MatrixFixture>>['state'] | undefined;
let original: MatrixSession | undefined;
let integrationFixture: MatrixFixture | undefined;
let integration: { fixture: MatrixFixture; session: MatrixSession } | undefined;
let incompleteFixture: MatrixFixture | undefined;
let incomplete: { fixture: MatrixFixture; session: MatrixSession } | undefined;
beforeEach(() => {
  if (preparations.size) throw new Error('An earlier bounded original preparation has not settled; do not overlap it or remove its root.');
  if (sessions.some(session => session.pending)) throw new Error('An earlier bounded observation has not settled; do not reuse or remove its held lease.');
  if (prepared && originalProviderState) {
    Object.assign(prepared.state, originalProviderState);
    prepared.calls.splice(0);
    prepared.onRead(() => undefined);
    prepared.onResponse(() => undefined);
  }
});
afterAll(async () => {
  await Promise.allSettled(preparations);
  for (const session of sessions.splice(0)) await session.close();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close(); await rm(fixture.root, { recursive: true, force: true });
  }
});
async function prepare<T>(work: () => Promise<T>): Promise<T> {
  const result = work(); preparations.add(result);
  try { return await result; } finally { preparations.delete(result); }
}
async function fixture(options: Parameters<typeof workflowSource5MatrixFixture>[0] = {}) {
  const value = await workflowSource5MatrixFixture(options); fixtures.push(value); return value;
}
function originalFixture() {
  if (!prepared || !original) throw new Error('The explicit original fixture and fresh held observation lease preparation did not complete.');
  return { fixture: prepared, session: original };
}
function planFields(entry: Observation['entries'][number]): Source5WorkflowPlanComponentFields {
  const input = entry.input;
  return { projectRoot: input.projectRoot, plan: input.plan, phase: input.phase, authority: input.authority,
    lease: input.lease, now: input.now, runner: input.runner, transport: input.transport, profile: input.profile };
}
async function prepareObservation(value: MatrixFixture): Promise<MatrixSession> {
  let ready!: (value: Observation) => void, refuse!: (error: unknown) => void, release!: () => void;
  const prepared = new Promise<Observation>((resolve, reject) => { ready = resolve; refuse = reject; });
  const retained = new Promise<void>(resolve => { release = resolve; });
  const completion = withSource5WorkflowLease(value.projectRoot, async lease => {
    ready(await value.entries(lease, new Date(value.now.getTime() + 60_000)));
    await retained;
  });
  void completion.catch(refuse);
  const observation = await prepared, pending = new Set<Promise<unknown>>();
  let closed = false;
  const session = {
    get pending() { return pending.size > 0; },
    async read<T>(reader: (value: Observation) => Promise<T>): Promise<T> {
      if (closed) throw new Error('The original observation lease is closed.');
      const result = reader(observation); pending.add(result);
      try { return await result; } finally { pending.delete(result); }
    },
    async close() {
      closed = true;
      await Promise.allSettled(pending);
      release(); await completion;
    }
  };
  sessions.push(session);
  return session;
}

describe('owned matrix validator environment and actual outcomes', () => {
  it.each(['darwin', 'linux'] as const)('preserves the exact %s allowlist without reading ambient configuration', platform => {
    const ambient = {
      get SystemRoot(): never { throw new Error('POSIX must not inspect Windows configuration.'); },
      get unrelated(): never { throw new Error('Unrelated configuration must not be inspected.'); }
    };
    expect(matrixValidatorEnvironment('owned-home', platform, ambient)).toEqual({ HOME: 'owned-home', NODE_OPTIONS: '' });
  });

  it.each(['SystemRoot', 'SYSTEMROOT', 'systemroot'])('copies only actual Windows %s without forwarding ambient configuration', key => {
    const ambient = { [key]: 'S:\\Windows', HOME: 'ambient-home', NODE_OPTIONS: '--require=unselected',
      NODE_PATH: 'unselected', Path: 'ambient-search-path',
      get unrelated(): never { throw new Error('Unrelated configuration must not be inspected.'); }
    };
    expect(matrixValidatorEnvironment('owned-home', 'win32', ambient))
      .toEqual({ HOME: 'owned-home', NODE_OPTIONS: '', SystemRoot: 'S:\\Windows' });
    expect(ambient[key]).toBe('S:\\Windows');
    expect(ambient.NODE_OPTIONS).toBe('--require=unselected');
  });

  it('retains a defined Windows value across undefined or identical case aliases without mutating them', () => {
    const ambient = { SystemRoot: undefined, SYSTEMROOT: 'S:\\Windows', systemroot: 'S:\\Windows' };
    expect(matrixValidatorEnvironment('owned-home', 'win32', ambient))
      .toEqual({ HOME: 'owned-home', NODE_OPTIONS: '', SystemRoot: 'S:\\Windows' });
    expect(ambient).toEqual({ SystemRoot: undefined, SYSTEMROOT: 'S:\\Windows', systemroot: 'S:\\Windows' });
  });

  it.each([
    { name: 'absent', environment: {} },
    { name: 'undefined', environment: { SystemRoot: undefined } },
    { name: 'empty', environment: { SystemRoot: '' } }
  ])('refuses $name Windows SystemRoot', ({ environment }) => {
    expect(() => matrixValidatorEnvironment('owned-home', 'win32', environment)).toThrow(/actual host SystemRoot/);
  });

  it('refuses conflicting defined Windows aliases rather than selecting or fabricating a value', () => {
    expect(() => matrixValidatorEnvironment('owned-home', 'win32', { SystemRoot: 'S:\\Windows', SYSTEMROOT: 'T:\\Windows' }))
      .toThrow(/Conflicting case-insensitive environment aliases/);
  });

  it.each([
    { jobId: 'validate', extension: 'mjs', text: 'export const valid = true;\n', status: 0 },
    { jobId: 'validate', extension: 'mjs', text: 'export const valid = ;\n', status: 1 },
    { jobId: 'package', extension: 'json', text: '{"name":"isolated"}\n', status: 0 },
    { jobId: 'package', extension: 'json', text: '{broken}\n', status: 1 }
  ] as const)('executes actual $jobId file-backed input with expected status $status rather than accepting initialization failure', async control => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-matrix-validator-environment-'));
    try {
      const input = path.join(root, `input.${control.extension}`);
      await writeFile(input, control.text, { flag: 'wx', mode: 0o600 });
      const result = await new NodeCommandRunner().run({ executable: process.execPath, args: control.jobId === 'validate' ?
        ['--check', input] : ['-e', "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))", input] },
      { cwd: root, env: matrixValidatorEnvironment(root), timeoutMs: 5000, maxOutputBytes: 4096,
        stream: false, ensureProcessTreeSettled: true });
      expect(result.status, result.stderr).toBe(control.status);
      expect(result.signal).toBeNull();
      expect(result.processSpawned).toBe(true);
      expect(result.processTreeSettled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.outputLimitExceeded).not.toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(result.aborted).not.toBe(true);
      if (control.status === 1) expect(result.stderr).toMatch(/\bSyntaxError:/u);
      const selector = { family: 'develop', mode: control.status === 0 ? 'green' : 'controlled-red', jobId: control.jobId } as const;
      expect(matrixValidatorConclusion(selector, result, control.status === 1))
        .toBe(control.status === 0 ? 'success' : 'failure');
      const original = structuredClone(result);
      for (const mismatch of [
        { ...result, status: 134, signal: null, stderr: 'CSPRNG initialization assertion' },
        { ...result, status: 1, stderr: 'CSPRNG initialization assertion' },
        { ...result, status: 134, signal: null, stderr: 'SyntaxError: unrelated failure' },
        { ...result, status: 0, stderr: '' }
      ]) {
        expect(() => matrixValidatorConclusion({ ...selector, mode: 'controlled-red' }, mismatch, true))
          .toThrow(/did not detect only its own reviewed violation/);
      }
      expect(() => matrixValidatorConclusion({ ...selector, mode: 'green' }, { ...result, status: 1 }, false))
        .toThrow(/did not detect only its own reviewed violation/);
      expect(result).toEqual(original);
      expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(4096);
      expect(await readFile(input, 'utf8')).toBe(control.text);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('complete source5 per-entry independently current matrix', () => {
  it('prepares original source provenance and actual bounded validators independently of component and carrier preparation', async () => {
    prepared = await prepare(() => fixture());
    expect(prepared.bindings).toHaveLength(12);
    expect(prepared.proofs).toEqual([]);
    expect(prepared.calls).toEqual([]);
  });
  it('seals all12 original fixture components before acquiring read-only observation carriers', async () => {
    if (!prepared) throw new Error('The original source fixture preparation did not complete.');
    await prepare(() => prepared!.prepareOriginalComponents());
    expect(prepared.proofs).toHaveLength(12);
    expect(prepared.proofs.filter(proof => proof.conclusion === 'success')).toHaveLength(4);
    expect(prepared.proofs.filter(proof => proof.conclusion === 'failure')).toHaveLength(8);
    expect(prepared.errors).toEqual([]);
    const proofs = structuredClone(prepared.proofs);
    await expect(prepared.prepareOriginalComponents()).rejects.toThrow(/Never repeat attempted original/);
    expect(prepared.proofs).toEqual(proofs);
  });
  it('acquires a fresh genuine native lease and the complete original observation carrier inventory', async () => {
    if (!prepared) throw new Error('The original source fixture preparation did not complete.');
    original = await prepare(() => prepareObservation(prepared!));
    originalProviderState = { ...prepared.state };
    expect(original.pending).toBe(false);
    expect(prepared.calls).toEqual([]);
  });
  it('observes all12 original fixture components through actual process-backed loopback outcomes under a fresh lease without overwriting them', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const original = await Promise.all(entries.map(async entry => {
        const stored = (await value.store.read('proof', journal.proofKey(entry.input.operation)))!;
        return { path: stored.path, bytes: await readFile(stored.path) };
      }));
      const result = await verifySource5WorkflowProofMatrix(entries, value.requirements);
      expect(result.proofDigests).toEqual(value.proofs.map(proof => canonicalSha256({
        bindingDigest: proof.bindingDigest, observationDigest: proof.observationDigest, planDigest: proof.planDigest
      })));
      expect(result.observationDigest).toBe(canonicalSha256(result.proofDigests));
      expect(value.calls.filter(call => call.path.includes('/actions/runs/') && !call.path.includes('/jobs'))).toHaveLength(12);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      for (const stored of original) expect(await readFile(stored.path)).toEqual(stored.bytes);
      expect(value.errors).toEqual([]);
    });
  });

  describe('owned constant-file matrix diagnostics', () => {
    it('preserves actual bounded result fields without serializing unrelated inputs or submitting more work', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-matrix-diagnostic-'));
      const runner = new NodeCommandRunner(), run = vi.spyOn(runner, 'run');
      try {
        const input = path.join(root, 'validate.mjs'), text = 'export const valid = ;\n';
        await writeFile(input, text, { flag: 'wx', mode: 0o600 });
        const result = await runner.run({ executable: process.execPath, args: ['--check', input] },
          { cwd: root, env: matrixValidatorEnvironment(root), timeoutMs: 5000, maxOutputBytes: 4096,
            stream: false, ensureProcessTreeSettled: true });
        const original = structuredClone(result);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toMatch(/\bSyntaxError:/u);
        expect(result.processTreeSettled).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(4096);
        expect(await readFile(input, 'utf8')).toBe(text);
        const selector = { family: 'develop', mode: 'green', jobId: 'validate',
          get unrelatedConfiguration(): never { throw new Error('Unrelated configuration must not be inspected.'); }
        } as const;
        for (const reason of ['settlement', 'input-readback', 'expectation'] as const) {
          const error = matrixValidatorFailure(reason, selector, result);
          const diagnostic = JSON.parse(error.message.split('\nOwned matrix fixture diagnostic: ')[1]!);
          expect(diagnostic).toEqual({
            fixture: { family: 'develop', mode: 'green', jobId: 'validate' },
            runtime: { node: process.version, platform: process.platform, arch: process.arch },
            result: { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal,
              processSpawned: result.processSpawned ?? null, processTreeSettled: result.processTreeSettled ?? null,
              errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null,
              timedOut: result.timedOut, aborted: result.aborted ?? null, outputLimitExceeded: result.outputLimitExceeded ?? null }
          });
          expect(result).toEqual(original);
        }
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        run.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
  it('reconstructs the whole original matrix from the journal without accepting caller proof or carrier inventories', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const originals = await Promise.all(entries.map(async entry => {
        const stored = (await value.store.read('proof', journal.proofKey(entry.input.operation)))!;
        return { path: stored.path, bytes: await readFile(stored.path) };
      }));
      const result = await observeSource5WorkflowPlanMatrix(planFields(entries[0]!), journal, value.requirements);
      expect(result).toMatchObject({ phaseComplete: false, controlKey: value.control.controlKey,
        planDigest: value.plan.planDigest, matrix: { kind: 'green-red-required-contexts.v2' } });
      expect(result.matrix.proofDigests).toEqual(value.proofs.map(proof => canonicalSha256({
        bindingDigest: proof.bindingDigest, observationDigest: proof.observationDigest, planDigest: proof.planDigest
      })));
      expect(value.calls.filter(call => call.path.includes('/actions/runs/') && !call.path.includes('/jobs'))).toHaveLength(12);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(await journal.readFinalization()).toBeNull();
      for (const stored of originals) expect(await readFile(stored.path)).toEqual(stored.bytes);
      expect(value.errors).toEqual([]);
    });
  });
  it('withholds journal-derived matrix completion after actual run drift without replacing original receipts', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const originals = await Promise.all(entries.map(async entry => {
        const stored = (await value.store.read('proof', journal.proofKey(entry.input.operation)))!;
        return { path: stored.path, bytes: await readFile(stored.path) };
      }));
      value.state.driftRunId = value.proofs[1]!.runId;
      await expect(observeSource5WorkflowPlanMatrix(planFields(entries[0]!), journal, value.requirements)).rejects.toThrow();
      expect(value.calls.some(call => call.path.includes(`/actions/runs/${value.state.driftRunId}`))).toBe(true);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(await journal.readFinalization()).toBeNull();
      for (const stored of originals) expect(await readFile(stored.path)).toEqual(stored.bytes);
      expect(value.errors).toEqual([]);
    });
  });
  it('drains every original concurrent carrier read and preserves its first temporal refusal before yielding the held lease', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const first = new Error('Original carrier refusal'), later = new Error('Later carrier refusal');
      let release!: () => void, reached!: () => void, failed!: () => void, settled = false;
      const held = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { reached = resolve; });
      const refused = new Promise<void>(resolve => { failed = resolve; });
      const original = workflowPorts.createSource5WorkflowEffectInput;
      const observed = new Set<string>();
      const read = vi.spyOn(workflowPorts, 'createSource5WorkflowEffectInput').mockImplementation(async (...args) => {
        const input = await original(...args);
        observed.add(input.operation.actionId);
        if (input.operation.actionId === entries[0]!.input.operation.actionId) {
          failed(); throw first;
        }
        if (input.operation.actionId === entries[1]!.input.operation.actionId) {
          reached(); await held; throw later;
        }
        return input;
      });
      const result = observeSource5WorkflowPlanMatrix(planFields(entries[0]!), journal, value.requirements);
      void result.then(() => { settled = true; }, () => { settled = true; });
      try {
        await Promise.all([waiting, refused]);
        await setImmediate();
        expect(settled).toBe(false);
        expect(value.calls).toEqual([]);
        release();
        await expect(result).rejects.toBe(first);
        expect(observed).toEqual(new Set(entries.map(entry => entry.input.operation.actionId)));
        expect(read).toHaveBeenCalledTimes(entries.length);
        expect(await journal.readFinalization()).toBeNull();
        expect(session.pending).toBe(true);
      } finally {
        release();
        await Promise.allSettled([result]);
        read.mockRestore();
      }
    });
    expect(session.pending).toBe(false);
  });
  it.each(['operation', 'proofs', 'entries', 'observationOnly', 'reviewedPlans'] as const)(
    'rejects caller-selected whole-matrix %s before provider reads', async field => {
      const { fixture: value, session } = originalFixture();
      await session.read(async ({ entries, journal }) => {
        const fields = planFields(entries[0]!);
        Reflect.set(fields, field, entries);
        await expect(observeSource5WorkflowPlanMatrix(fields, journal, value.requirements)).rejects.toThrow();
        expect(value.calls).toEqual([]);
      });
    });
  it('keeps journal and carrier preparation inside one original observation deadline', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const started = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 180_000).mockReturnValueOnce(started);
      try {
        await expect(observeSource5WorkflowPlanMatrix(planFields(entries[0]!), journal, value.requirements))
          .rejects.toThrow(/three-minute deadline/);
        expect(value.calls).toEqual([]);
      } finally { clock.mockRestore(); }
      expect(await journal.readFinalization()).toBeNull();
    });
  });
  it('refuses another original entry through the first carrier, including the legacy one-runtime matrix path, before provider reads', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries }) => {
      await expect(readCurrentWorkflowContextProof(entries[0]!.input, entries[1]!.proof)).rejects.toThrow(/exact internally issued indexed entry/);
      await expect(verifyProtectedWorkflowProofMatrix(entries[0]!.input, value.requirements, value.proofs))
        .rejects.toThrow(/per-entry observation carriers/);
      expect(value.calls).toEqual([]);
    });
  });

  it('captures the exact entry proofs and requirements before asynchronous readback can observe caller mutation', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const callerEntries = entries.map(entry => ({ input: entry.input, proof: structuredClone(entry.proof) }));
      const requirements = structuredClone(value.requirements);
      const stored = (await value.store.read('proof', journal.proofKey(entries[0]!.input.operation)))!;
      const bytes = await readFile(stored.path);
      const reading = verifySource5WorkflowProofMatrix(callerEntries, requirements);
      callerEntries.pop(); callerEntries[0]!.proof.runId++;
      requirements.sourceDigest = '0'.repeat(64);
      expect((await reading).proofDigests).toEqual(value.proofs.map(proof => canonicalSha256({
        bindingDigest: proof.bindingDigest, observationDigest: proof.observationDigest, planDigest: proof.planDigest
      })));
      expect(await readFile(stored.path)).toEqual(bytes);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
    });
  });

  it.each(['subset', 'duplicate', 'reordered', 'proof-time', 'proof-run', 'structural-carrier'] as const)(
    'rejects %s members before current provider observations', async fault => {
      const { fixture: value, session } = originalFixture();
      await session.read(async ({ entries }) => {
        const invalid = fault === 'subset' ? entries.slice(0, -1) : fault === 'duplicate' ? [...entries.slice(0, -1), entries[0]!] :
          fault === 'reordered' ? [...entries].reverse() : entries.map((entry, index) => index ? entry :
            fault === 'structural-carrier' ? { ...entry, input: { ...entry.input } } :
              { ...entry, proof: { ...entry.proof, ...(fault === 'proof-time' ? {
                observedAt: new Date(value.now.getTime() + 1).toISOString()
              } : { runId: entry.proof.runId + 1 }) } });
        await expect(verifySource5WorkflowProofMatrix(invalid, value.requirements)).rejects.toThrow();
        expect(value.calls).toEqual([]);
      });
    });

  it.each(['array-accessor', 'member-accessor', 'array-symbol', 'member-symbol',
    'array-prototype', 'member-prototype', 'extra-member', 'sparse', 'over-capacity'] as const)(
    'refuses closed-inventory %s without invoking getters or provider reads', async fault => {
      const { fixture: value, session } = originalFixture();
      await session.read(async ({ entries }) => {
        let invoked = 0;
        const invalid = fault === 'over-capacity' ? Array.from({ length: 133 }, () => entries[0]!) :
          entries.map(entry => ({ ...entry }));
        if (fault === 'array-accessor') Object.defineProperty(invalid, '0', { get() { invoked++; return entries[0]; } });
        if (fault === 'member-accessor') Object.defineProperty(invalid[0], 'proof', { get() { invoked++; return entries[0]!.proof; } });
        if (fault === 'array-symbol') Object.defineProperty(invalid, Symbol('foreign'), { value: true });
        if (fault === 'member-symbol') Object.defineProperty(invalid[0], Symbol('foreign'), { value: true });
        if (fault === 'array-prototype') Object.setPrototypeOf(invalid, { foreign: true });
        if (fault === 'member-prototype') Object.setPrototypeOf(invalid[0], { foreign: true });
        if (fault === 'extra-member') Object.defineProperty(invalid[0], 'observe', { value() { invoked++; } });
        if (fault === 'sparse') Reflect.deleteProperty(invalid, '0');
        await expect(verifySource5WorkflowProofMatrix(invalid, value.requirements)).rejects.toThrow(/private matrix|Matrix members/);
        expect(invoked).toBe(0); expect(value.calls).toEqual([]);
      });
    });

  it.each(['missing-family', 'missing-integration', 'extra-field', 'duplicate-file', 'wrong-digest'] as const)(
    'rejects %s requirements before observing a caller-selected summary', async fault => {
      const { fixture: value, session } = originalFixture();
      await session.read(async ({ entries }) => {
        const requirements = structuredClone(value.requirements);
        if (fault === 'missing-family') Reflect.deleteProperty(requirements.families, 'hotfix');
        if (fault === 'missing-integration') Reflect.deleteProperty(requirements.integrations.main, 'Required validation');
        if (fault === 'extra-field') Object.assign(requirements, { observe: 'caller-selected' });
        if (fault === 'duplicate-file') requirements.files = [...requirements.files, requirements.files[0]!];
        if (fault === 'wrong-digest') requirements.sourceDigest = '0'.repeat(64);
        await expect(verifySource5WorkflowProofMatrix(entries, requirements)).rejects.toThrow(/closed complete source-derived/);
        expect(value.calls).toEqual([]);
      });
    });

  it('rejects carriers from separately opened journals even for the same original root, plan and held native lease', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries }) => {
      const foreign = await value.entries(entries[0]!.input.lease);
      await expect(verifySource5WorkflowProofMatrix([foreign.entries[0]!, ...entries.slice(1)], value.requirements))
        .rejects.toThrow(/one exact green-red journal and held lease/);
      expect(value.calls).toEqual([]);
    });
  });

  it('shares the unchanged three-minute deadline across every current-read carrier and settles them before returning', async () => {
    const { fixture: value, session } = originalFixture();
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      value.onRead(() => { clock.mockReturnValue(now + 180_000); });
      await session.read(async ({ entries }) => {
        await expect(verifySource5WorkflowProofMatrix(entries, value.requirements)).rejects.toThrow(/deadline/);
        expect(value.calls.length).toBeGreaterThan(0);
        expect(value.calls.length).toBeLessThanOrEqual(4);
        expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      });
      expect(session.pending).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it.each(['run', 'check', 'workflow', 'tag', 'protected-ref', 'ruleset', 'extra-file', 'truncated-tree', 'tree'] as const)(
    'withholds current matrix after actual %s drift without changing original proofs', async fault => {
      const { fixture: value, session } = originalFixture();
      await session.read(async ({ entries, journal }) => {
        const original = (await value.store.read('proof', journal.proofKey(entries[0]!.input.operation)))!;
        const bytes = await readFile(original.path);
        if (fault === 'run') value.state.driftRunId = value.proofs[1]!.runId;
        if (fault === 'check') value.state.driftCheckId = value.proofs[4]!.contexts[0]!.checkRunId;
        if (fault === 'workflow') value.state.workflowDrift = true;
        if (fault === 'tag') value.state.tagDrift = true;
        if (fault === 'protected-ref') value.state.protectedRefDrift = true;
        if (fault === 'ruleset') value.state.rulesetDrift = true;
        if (fault === 'extra-file') value.state.extraRuleFile = true;
        if (fault === 'truncated-tree') value.state.truncated = true;
        if (fault === 'tree') value.state.treeDrift = true;
        const refusal = { run: /Actual workflow run identity/, check: /Required contexts must be actual completed jobs/,
          workflow: /Immutable provider source bytes/, tag: /protected execution ref/,
          'protected-ref': /exact reviewed ref moved/, ruleset: /Immutable provider source bytes/,
          'extra-file': /omitted or substituted actual committed ruleset files/,
          'truncated-tree': /Incomplete\/truncated source trees/, tree: /actual source commit tree/ };
        await expect(verifySource5WorkflowProofMatrix(entries, value.requirements)).rejects.toThrow(refusal[fault]);
        expect(value.calls.every(call => call.method === 'GET')).toBe(true);
        expect(await readFile(original.path)).toEqual(bytes);
        expect(value.errors).toEqual([]);
      });
    });

  it('settles every immutable ruleset source read before refusing a failed matrix and yielding its held lease', async () => {
    const { fixture: value, session } = originalFixture();
    let release!: () => void, ready!: () => void;
    const retained = new Promise<void>(resolve => { release = resolve; });
    const responses = new Promise<void>(resolve => { ready = resolve; });
    let held = 0, returned = 0, siblingResponses = 0, settled = false;
    const markReady = () => { if (held === 4 && returned === 4) ready(); };
    value.state.rulesetDrift = true;
    value.onRead(async request => {
      if (request.path.includes('/contents/governance/rulesets/tags.json')) {
        held++; markReady(); await retained;
      }
    });
    value.onResponse(request => {
      if (request.path.includes('/contents/governance/rulesets/branches.json')) {
        returned++; markReady();
      }
      if (request.path.includes('/contents/governance/rulesets/tags.json')) siblingResponses++;
    });
    const reading = session.read(async ({ entries }) => {
      try { await verifySource5WorkflowProofMatrix(entries, value.requirements); return null; }
      catch (error) { return error; }
    }).finally(() => { settled = true; });
    try {
      await responses;
      await setImmediate();
      expect(settled).toBe(false);
      expect(session.pending).toBe(true);
      expect(siblingResponses).toBe(0);
    } finally {
      release();
      const error = await reading;
      if (!(error instanceof Error)) throw new Error('The actual drifted source matrix did not refuse.');
      expect(error.message).toMatch(/Immutable provider source bytes/);
    }
    expect(held).toBe(4); expect(returned).toBe(4);
    expect(siblingResponses).toBe(4);
    expect(session.pending).toBe(false);
    expect(value.calls.every(call => call.method === 'GET')).toBe(true);
    expect(value.errors).toEqual([]);
  });

  it.each(['branches', 'tags'] as const)(
    'preserves the exact first temporal %s rejection after draining both distinguishable actual source reads', async firstPath => {
      const { fixture: value, session } = originalFixture();
      const secondPath = firstPath === 'branches' ? 'tags' : 'branches';
      const failures: { path: string; reason: unknown }[] = [];
      const responseOrder: string[] = [];
      let release!: () => void, firstRejected!: () => void, secondHeld!: () => void;
      const retained = new Promise<void>(resolve => { release = resolve; });
      const firstRejection = new Promise<void>(resolve => { firstRejected = resolve; });
      const heldResponse = new Promise<void>(resolve => { secondHeld = resolve; });
      value.state.rulesetDriftIndex = 0;
      value.state.invalidTagRulesetIndex = 0;
      value.onResponse(async (request, index) => {
        if (index !== 0) return;
        if (request.path.includes(`/contents/governance/rulesets/${secondPath}.json`)) {
          secondHeld(); await retained;
          responseOrder.push(secondPath);
        } else if (request.path.includes(`/contents/governance/rulesets/${firstPath}.json`)) {
          responseOrder.push(firstPath);
        }
      });
      const read = workflowRuntime.readWorkflowBytes;
      const observer = vi.spyOn(workflowRuntime, 'readWorkflowBytes').mockImplementation(async (...args) => {
        try { return await read(...args); }
        catch (reason) {
          const path = args[3].split('/').at(-1)!.replace('.json', '');
          failures.push({ path, reason });
          if (path === firstPath) firstRejected();
          throw reason;
        }
      });
      const reading = session.read(async ({ entries }) => {
        try { await verifySource5WorkflowProofMatrix(entries, value.requirements); return null; }
        catch (reason) { return reason; }
      });
      let result: unknown;
      try {
        await Promise.all([firstRejection, heldResponse]);
        expect(failures.map(failure => failure.path)).toEqual([firstPath]);
        expect(responseOrder).toEqual([firstPath]);
      } finally {
        release();
        try { result = await reading; } finally { observer.mockRestore(); }
      }
      expect(responseOrder).toEqual([firstPath, secondPath]);
      expect(failures.map(failure => failure.path)).toEqual([firstPath, secondPath]);
      const first = failures[0]!.reason, second = failures[1]!.reason;
      if (!(first instanceof GitHubActivationError) || !(second instanceof GitHubActivationError)) {
        throw new Error('Both actual source failures must retain their original typed provider validation errors.');
      }
      expect(first).not.toBe(second);
      expect(first.code).toBe(firstPath === 'branches' ? 'workflow-readback' : 'invalid-response');
      expect(second.code).toBe(secondPath === 'branches' ? 'workflow-readback' : 'invalid-response');
      expect(result).toBe(first);
      expect(result).toBeInstanceOf(GitHubActivationError);
      expect(session.pending).toBe(false);
      for (const path of ['branches', 'tags']) {
        expect(value.calls.filter(call => call.path.includes(`/contents/governance/rulesets/${path}.json`))).toHaveLength(4);
      }
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(value.errors).toEqual([]);
    });

  it('rechecks original component ledgers after current provider reads and preserves loss without repair', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const original = (await value.store.read('proof', journal.proofKey(entries[0]!.input.operation)))!;
      let removed = false;
      value.onRead(async request => {
        if (!removed && request.path.includes(`/actions/runs/${entries[0]!.proof.runId}`)) {
          removed = true; await unlink(original.path);
        }
      });
      await expect(verifySource5WorkflowProofMatrix(entries, value.requirements)).rejects.toThrow();
      expect(removed).toBe(true); expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(await value.store.read('proof', journal.proofKey(entries[0]!.input.operation))).toBeNull();
    });
  });
  it('refuses journal-derived observation before provider reads when an original component receipt was lost', async () => {
    const { fixture: value, session } = originalFixture();
    await session.read(async ({ entries, journal }) => {
      const key = journal.proofKey(entries[0]!.input.operation);
      expect(await value.store.read('proof', key)).toBeNull();
      await expect(observeSource5WorkflowPlanMatrix(planFields(entries[0]!), journal, value.requirements))
        .rejects.toThrow(/progress pointer contradicts its immutable event receipts/);
      expect(value.calls).toEqual([]);
      expect(await value.store.read('proof', key)).toBeNull();
      expect(await journal.readFinalization()).toBeNull();
    });
  });

  it('prepares independent red integration source without reusing or changing the valid original ledgers', async () => {
    integrationFixture = await prepare(() => fixture({ wrongRedIntegration: true }));
    expect(integrationFixture.proofs).toEqual([]);
  });
  it('seals independent original red integration components without acquiring an observation lease', async () => {
    if (!integrationFixture) throw new Error('The independent integration source preparation did not complete.');
    const value = integrationFixture;
    await prepare(() => value.prepareOriginalComponents());
    expect(value.proofs[1]!.contexts.every(context => context.applicationId === 17000)).toBe(true);
  });
  it('acquires the fresh independent red integration observation lease and exact original carriers', async () => {
    if (!integrationFixture) throw new Error('The independent integration source preparation did not complete.');
    const value = integrationFixture;
    integration = { fixture: value, session: await prepare(() => prepareObservation(value)) };
    expect(value.calls).toEqual([]);
  });
  it('requires pinned actual integrations on controlled-red members, not only greens', async () => {
    if (!integration) throw new Error('The explicit red integration fixture preparation did not complete.');
    const { fixture: value, session } = integration;
    await session.read(async ({ entries }) => {
      await expect(verifySource5WorkflowProofMatrix(entries, value.requirements)).rejects.toThrow(/source-pinned required integration/);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(value.errors).toEqual([]);
    });
  });

  it('withholds an otherwise identical own-entry observation when original issuance disappears in its final actual HTTP response', async () => {
    if (!integration) throw new Error('The explicit integration fixture preparation did not complete.');
    const { fixture: value, session } = integration;
    await session.read(async ({ entries, journal }) => {
      const entry = entries[1]!;
      const original = (await value.store.read('approval',
        canonicalSha256(source5WorkflowAuthorityValue({ ...value, lease: entry.input.lease }))))!;
      const originalProof = (await value.store.read('proof', journal.proofKey(entry.input.operation)))!;
      const bytes = await readFile(originalProof.path);
      expect((await readCurrentWorkflowContextProof(entry.input, entry.proof)).observationDigest).toBe(entry.proof.observationDigest);
      let removed = false;
      value.onRead(async request => {
        if (request.path.includes('/compare/')) { removed = true; await unlink(original.path); }
      });
      await expect(readCurrentWorkflowContextProof(entry.input, entry.proof)).rejects.toThrow(/Original workflow issuance changed or disappeared/);
      expect(removed).toBe(true);
      expect(await readFile(originalProof.path)).toEqual(bytes);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
    });
  });

  it('refuses released observation leases before any provider read, without acquiring new permission', async () => {
    if (!integration) throw new Error('The explicit integration fixture preparation did not complete.');
    const { fixture: value, session } = integration;
    const observation = await session.read(async observation => observation);
    await session.close();
    value.calls.splice(0);
    await expect(verifySource5WorkflowProofMatrix(observation.entries, value.requirements)).rejects.toThrow(/lease.*not|no longer held/);
    expect(value.calls).toEqual([]);
  });

  it('prepares separately reviewed incomplete source without fabricating or repairing its missing member', async () => {
    incompleteFixture = await prepare(() => fixture({ omitLastRed: true }));
    expect(incompleteFixture.bindings).toHaveLength(11);
    expect(incompleteFixture.proofs).toEqual([]);
  });
  it('seals only the separately reviewed incomplete original component inventory', async () => {
    if (!incompleteFixture) throw new Error('The incomplete source preparation did not complete.');
    const value = incompleteFixture;
    await prepare(() => value.prepareOriginalComponents());
    expect(value.proofs).toHaveLength(11);
  });
  it('acquires a fresh native observation lease for the separately reviewed incomplete original inventory', async () => {
    if (!incompleteFixture) throw new Error('The incomplete source preparation did not complete.');
    const value = incompleteFixture;
    incomplete = { fixture: value, session: await prepare(() => prepareObservation(value)) };
    expect(value.calls).toEqual([]);
  });
  it('refuses a coherently reviewed incomplete original plan rather than treating its operation inventory as complete proof coverage', async () => {
    if (!incomplete) throw new Error('The explicit incomplete inventory fixture preparation did not complete.');
    const { fixture: value, session } = incomplete;
    await session.read(async ({ entries }) => {
      await expect(verifySource5WorkflowProofMatrix(entries, value.requirements)).rejects.toThrow(/Each required context/);
      expect(value.calls).toEqual([]);
    });
  });
});
