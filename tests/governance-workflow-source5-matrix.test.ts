import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, unlink } from 'node:fs/promises';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  source5WorkflowAuthorityValue, withSource5WorkflowLease
} from '../src/governance-activation/workflow-source5-authority.js';
import {
  readCurrentWorkflowContextProof, verifyProtectedWorkflowProofMatrix, verifySource5WorkflowProofMatrix
} from '../src/governance-activation/workflow-context-proof.js';
import { workflowSource5MatrixFixture } from './fixtures/workflow-source5-matrix.js';

const fixtures: Awaited<ReturnType<typeof workflowSource5MatrixFixture>>[] = [];
type MatrixFixture = Awaited<ReturnType<typeof workflowSource5MatrixFixture>>;
type Observation = Awaited<ReturnType<MatrixFixture['entries']>>;
interface MatrixSession {
  readonly pending: boolean;
  read<T>(reader: (value: Observation) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const sessions: MatrixSession[] = [];
let prepared: Awaited<ReturnType<typeof workflowSource5MatrixFixture>> | undefined;
let originalProviderState: Awaited<ReturnType<typeof workflowSource5MatrixFixture>>['state'] | undefined;
let original: MatrixSession | undefined;
let integration: { fixture: MatrixFixture; session: MatrixSession } | undefined;
let incomplete: { fixture: MatrixFixture; session: MatrixSession } | undefined;
beforeEach(() => {
  if (sessions.some(session => session.pending)) throw new Error('An earlier bounded observation has not settled; do not reuse or remove its held lease.');
  if (prepared && originalProviderState) {
    Object.assign(prepared.state, originalProviderState);
    prepared.calls.splice(0);
    prepared.onRead(() => undefined);
  }
});
afterAll(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close(); await rm(fixture.root, { recursive: true, force: true });
  }
});
async function fixture(options: Parameters<typeof workflowSource5MatrixFixture>[0] = {}) {
  const value = await workflowSource5MatrixFixture(options); fixtures.push(value); return value;
}
function originalFixture() {
  if (!prepared || !original) throw new Error('The explicit original fixture and fresh held observation lease preparation did not complete.');
  return { fixture: prepared, session: original };
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

describe('complete source5 per-entry independently current matrix', () => {
  it('prepares all12 original fixture components with separately issued sealed provenance and actual bounded validators', async () => {
    prepared = await fixture();
    original = await prepareObservation(prepared);
    originalProviderState = { ...prepared.state };
    expect(prepared.proofs).toHaveLength(12);
    expect(prepared.proofs.filter(proof => proof.conclusion === 'success')).toHaveLength(4);
    expect(prepared.proofs.filter(proof => proof.conclusion === 'failure')).toHaveLength(8);
    expect(prepared.errors).toEqual([]);
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

  it('prepares independently sealed red integration provenance without reusing or changing the valid original ledgers', async () => {
    const value = await fixture({ wrongRedIntegration: true });
    integration = { fixture: value, session: await prepareObservation(value) };
    expect(value.proofs[1]!.contexts.every(context => context.applicationId === 17000)).toBe(true);
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

  it('prepares a separately reviewed incomplete inventory without fabricating or repairing its missing member', async () => {
    const value = await fixture({ omitLastRed: true });
    incomplete = { fixture: value, session: await prepareObservation(value) };
    expect(value.proofs).toHaveLength(11);
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
