import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import type { CompletionProtectedIndex } from '../src/domain/governance/activation/modern-local-completion.js';
import type { LocalRevalidationArtifact, LocalRevalidationState } from '../src/domain/governance/activation/modern-revalidation-publication.js';
import * as records from '../src/application/update/modern-revalidation-records.js';
import * as publication from '../src/application/update/modern-revalidation-publication.js';
import * as boundary from '../src/application/governance/modern-local-finalization.js';
import * as transaction from '../src/adapters/filesystem/reviewed-update-transaction.js';
import * as inputs from '../src/adapters/filesystem/modern-local-publication-inputs.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { at, fixture, h, resignIntent, resignResult } from './fixtures/modern-revalidation-values.js';

const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at(10000)));
  vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async () => { throw new Error('Portable coordination tests cannot launch native tools.'); });
});
afterEach(async () => {
  expect(NodeCommandRunner.prototype.run).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function reviewFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'liftoff-revalidation-coordination-')));
  roots.push(root);
  const wire = fixture(true, root);
  const index: CompletionProtectedIndex = {
    kind: 'liftoff-local-protected-index', schemaVersion: 1, projectRoot: root, files: [], directories: [], physical: []
  };
  const intent = resignIntent({ ...wire.intent, protectedSetDigest: canonicalSha256(index) }), store = records.revalidationStore(root);
  function artifact(role: LocalRevalidationArtifact['role'], bytes: Buffer, pathParts: string[] | null, mode: number | null): LocalRevalidationArtifact {
    return { kind: 'liftoff-local-revalidation-artifact', schemaVersion: 1, projectRoot: root, operationId: intent.operationId,
      intentFingerprint: intent.fingerprint, role, pathParts, mode, contentBase64: bytes.toString('base64'), bytes: bytes.length, rawDigest: rawLocalDigest(bytes) };
  }
  const protectedArtifact = artifact('protected-index', Buffer.from(canonicalJson(index)), null, null);
  const artifacts = [protectedArtifact], targets = wire.result.targets.map(target => {
    const value = artifact('target', Buffer.from('{}\n'), target.pathParts, target.target.mode);
    artifacts.push(value);
    return { ...target, artifactKey: canonicalSha256(value), target: { ...target.target, bytes: value.bytes, rawDigest: value.rawDigest } };
  });
  const result = resignResult({ ...wire.result, fingerprint: intent.fingerprint, protectedSetDigest: intent.protectedSetDigest,
    protectedIndexKey: canonicalSha256(protectedArtifact), targets });
  const consent = { ...wire.consent, intentFingerprint: intent.fingerprint, resultDigest: result.resultDigest,
    publicationFingerprint: result.publicationFingerprint, targetSetDigest: result.targetSetDigest };
  const committed: LocalRevalidationState = { ...wire.state, intentFingerprint: intent.fingerprint, publicationFingerprint: result.publicationFingerprint,
    commitObservation: { ...wire.state.commitObservation!, publicationFingerprint: result.publicationFingerprint } };
  const uncommitted: LocalRevalidationState = { ...committed, phase: 'publishing', transactionDigest: null, commitObservation: null, readbackDigest: null };
  await store.write('preview', intent.fingerprint, intent);
  for (const value of artifacts) await store.write('artifact', canonicalSha256(value), value);
  for (const key of [intent.fingerprint, result.publicationFingerprint]) await store.write('result', key, result);
  const approval = { publishExactLocalBytes: true as const, intentFingerprint: intent.fingerprint,
    candidateBinding: result.candidateBinding, targetSetDigest: result.targetSetDigest };
  return { root, intent, result, consent, committed, uncommitted, index, artifacts, store, approval };
}
type ReviewFixture = Awaited<ReturnType<typeof reviewFixture>>;
function changedRead(review: ReviewFixture, kind: string, key: string, value: unknown) {
  return { ...review.store, read: async (requestedKind: Parameters<typeof review.store.read>[0], requestedKey: string) => {
    const saved = await review.store.read(requestedKind, requestedKey);
    return requestedKind === kind && requestedKey === key ? value === null ? null : saved && { ...saved, value } : saved;
  } };
}
async function claim(review: ReviewFixture, state = review.uncommitted) {
  await review.store.write('publication-consent', review.result.publicationFingerprint, review.consent);
  return review.store.compareExchangeState(review.intent.fingerprint, null, state);
}
async function modelBoundary(review: ReviewFixture, observed: Partial<transaction.ReviewedUpdateTransactionInspection>) {
  const actual = await boundary.inspectCompletionBoundary(review.root);
  const value = { ...actual, transaction: { ...actual.transaction, ...observed } };
  vi.spyOn(boundary, 'inspectCompletionBoundary').mockResolvedValue(value);
  return value;
}
function attributed(review: ReviewFixture, status: 'interrupted' | 'committed' = 'interrupted') {
  return { status, committed: status === 'committed', planFingerprint: review.result.publicationFingerprint, transactionDigest: h('b') };
}
function recovery(review: ReviewFixture) {
  return publication.recoverModernSuccessorRevalidation(review.root, { publicationFingerprint: review.result.publicationFingerprint });
}
function inspect(review: ReviewFixture) {
  return publication.inspectModernSuccessorRevalidationPublication(review.root, review.result.publicationFingerprint);
}

describe('portable revalidation private-record loading, without native proof', () => {
  it.each(['intent', 'publication'] as const)('loads exact private bytes by %s key without writing project targets', async key => {
    const r = await reviewFixture();
    const loaded = await records.loadRevalidationResult(r.root, key === 'intent' ? r.intent.fingerprint : r.result.publicationFingerprint);
    expect(loaded).toMatchObject({ intent: r.intent, result: r.result, index: r.index });
    expect(loaded.mutations).toEqual(r.result.targets.map(target => ({ type: 'write', pathParts: target.pathParts, mode: 0o600, content: Buffer.from('{}\n') })));
    expect(await fs.readdir(r.root)).toEqual([]);
  });
  it.each(['preview', 'result', 'artifact'] as const)('rejects missing %s without reconstructing or substituting records', async kind => {
    const r = await reviewFixture(), key = kind === 'preview' ? r.intent.fingerprint : kind === 'result' ? r.result.publicationFingerprint : r.result.protectedIndexKey;
    await expect(records.loadRevalidationResult(r.root, r.result.publicationFingerprint, changedRead(r, kind, key, null))).rejects.toThrow(/missing/i);
  });
  it('rejects unknown intent keys, foreign roots and future issuance', async () => {
    const r = await reviewFixture();
    await expect(records.readRevalidationIntent(r.root, 'invalid')).rejects.toThrow();
    await expect(records.readRevalidationIntent(path.join(r.root, 'foreign'), r.intent.fingerprint, r.store)).rejects.toThrow(/root or issuance/);
    await r.store.write('preview', h('9'), r.intent);
    await expect(records.readRevalidationIntent(r.root, h('9'), r.store)).rejects.toThrow(/root or issuance/);
    vi.setSystemTime(new Date(at(-1)));
    await expect(records.readRevalidationIntent(r.root, r.intent.fingerprint)).rejects.toThrow(/root or issuance/);
  });
  it('rejects result aliases and future completion, even with internally consistent digests', async () => {
    const r = await reviewFixture();
    await r.store.write('result', h('9'), r.result);
    await expect(records.loadRevalidationResult(r.root, h('9'))).rejects.toThrow(/another review/);
    vi.setSystemTime(new Date(at(500)));
    await expect(records.loadRevalidationResult(r.root, r.result.publicationFingerprint)).rejects.toThrow(/future/);
  });
  it('rejects artifact bytes changed under the original content-addressed key', async () => {
    const r = await reviewFixture(), value = r.artifacts[1], bytes = Buffer.from('{"changed":true}\n');
    const forged = { ...value, bytes: bytes.length, rawDigest: rawLocalDigest(bytes), contentBase64: bytes.toString('base64') };
    await expect(records.loadRevalidationResult(r.root, r.result.publicationFingerprint,
      changedRead(r, 'artifact', canonicalSha256(value), forged))).rejects.toThrow(/artifact key differs/);
  });
  it.each(['role', 'path', 'digest', 'bytes', 'mode'] as const)('rejects a target whose %s differs from its exact artifact', async field => {
    const r = await reviewFixture(), targets = structuredClone(r.result.targets), target = targets[0];
    if (field === 'role') target.artifactKey = r.result.protectedIndexKey;
    if (field === 'path') target.artifactKey = r.result.targets[1].artifactKey;
    if (field === 'digest') target.target.rawDigest = h('9');
    if (field === 'bytes') target.target.bytes++;
    if (field === 'mode') {
      const artifact = { ...r.artifacts[1], mode: 0o644 };
      target.artifactKey = canonicalSha256(artifact);
      await r.store.write('artifact', target.artifactKey, artifact);
    }
    const result = resignResult({ ...r.result, targets });
    await r.store.write('result', result.publicationFingerprint, result);
    await expect(records.loadRevalidationResult(r.root, result.publicationFingerprint)).rejects.toThrow(/target differs/);
  });
  it('requires the protected-index role rather than accepting an attributed target artifact', async () => {
    const r = await reviewFixture(), result = resignResult({ ...r.result, protectedIndexKey: r.result.targets[0].artifactKey });
    await r.store.write('result', result.publicationFingerprint, result);
    await expect(records.loadRevalidationResult(r.root, result.publicationFingerprint)).rejects.toThrow(/wrong artifact role/);
  });
  it.each(['root', 'digest'] as const)('rejects a valid index with a different %s commitment', async field => {
    const r = await reviewFixture();
    const index = field === 'root' ? { ...r.index, projectRoot: path.join(r.root, 'foreign') } :
      { ...r.index, directories: [{ pathParts: [], exists: false, mode: null, entries: [] }] };
    const bytes = Buffer.from(canonicalJson(index)), value = { ...r.artifacts[0], contentBase64: bytes.toString('base64'), bytes: bytes.length, rawDigest: rawLocalDigest(bytes) };
    const result = resignResult({ ...r.result, protectedIndexKey: canonicalSha256(value) });
    await r.store.write('artifact', result.protectedIndexKey, value);
    await r.store.write('result', result.publicationFingerprint, result);
    await expect(records.loadRevalidationResult(r.root, result.publicationFingerprint)).rejects.toThrow(/protected inputs differ/);
  });
});

describe('portable publication consent and inspection, without native proof', () => {
  it('distinguishes no consent from a separately saved exact-byte consent', async () => {
    const r = await reviewFixture();
    expect(await inspect(r)).toMatchObject({ status: 'awaiting-consent', committed: false, transactionDigest: null, readbackDigest: null });
    await r.store.write('publication-consent', r.result.publicationFingerprint, r.consent);
    expect(await inspect(r)).toMatchObject({ status: 'awaiting-publication', authority: 'local-only', committed: false });
    expect(await fs.readdir(r.root)).toEqual([]);
  });
  it('rejects intent selection and expired reviews instead of implying publication authority', async () => {
    const r = await reviewFixture();
    await expect(publication.inspectModernSuccessorRevalidationPublication(r.root, r.intent.fingerprint)).rejects.toThrow(/not its construction intent/);
    vi.setSystemTime(new Date(r.result.reviewExpiresAt));
    await expect(inspect(r)).rejects.toThrow(/expired/);
  });
  it('requires separate live consent before independent construction or transaction effects', async () => {
    const r = await reviewFixture(), construction = vi.spyOn(records, 'validateRevalidationConstruction'), apply = vi.spyOn(transaction, 'applyLocalVerificationTransaction');
    await expect(publication.publishModernSuccessorRevalidation(r.root, r.result.publicationFingerprint)).rejects.toThrow(/consent is missing/);
    expect(construction).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    await r.store.write('publication-consent', r.result.publicationFingerprint, r.consent);
    vi.setSystemTime(new Date(r.result.reviewExpiresAt));
    await expect(publication.publishModernSuccessorRevalidation(r.root, r.result.publicationFingerprint)).rejects.toThrow(/expired/i);
    expect(construction).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });
  it('rejects consent approved after observation', async () => {
    const r = await reviewFixture();
    await r.store.write('publication-consent', r.result.publicationFingerprint, { ...r.consent, approvedAt: at(10001) });
    await expect(inspect(r)).rejects.toThrow(/after observation/);
  });
  it.each(['intentFingerprint', 'candidateBinding', 'targetSetDigest'] as const)('rejects mismatched approval %s before construction', async field => {
    const r = await reviewFixture(), construction = vi.spyOn(records, 'validateRevalidationConstruction');
    await expect(publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint,
      { ...r.approval, [field]: h('9') })).rejects.toThrow(/does not match/);
    expect(construction).not.toHaveBeenCalled();
    expect(await r.store.read('publication-consent', r.result.publicationFingerprint)).toBeNull();
  });
  it('requires explicit permission and rejects expanded approval scope before construction', async () => {
    const r = await reviewFixture(), construction = vi.spyOn(records, 'validateRevalidationConstruction');
    // @ts-expect-error Runtime callers cannot substitute false for explicit exact-byte consent.
    await expect(publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint, { ...r.approval, publishExactLocalBytes: false })).rejects.toThrow(/does not match/);
    const expanded = { ...r.approval, providerAccess: true };
    await expect(publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint, expanded))
      .rejects.toThrow('Revalidation publication approval must contain exactly the required fields: publishExactLocalBytes, intentFingerprint, candidateBinding, targetSetDigest.');
    expect(construction).not.toHaveBeenCalled();
    expect(await r.store.read('publication-consent', r.result.publicationFingerprint)).toBeNull();
  });
  it('does not turn wire-only records into independently valid native construction', async () => {
    const r = await reviewFixture(), construction = vi.spyOn(records, 'validateRevalidationConstruction'), apply = vi.spyOn(transaction, 'applyLocalVerificationTransaction');
    await expect(publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint, r.approval))
      .rejects.toThrow('Completed execution requires original preview, consent, result and progress.');
    expect(construction).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
    expect(await r.store.read('publication-consent', r.result.publicationFingerprint)).toBeNull();
    expect(await r.store.readState(r.intent.fingerprint)).toBeNull();
    expect(await fs.readdir(r.root)).toEqual([]);
  });
  it('refuses approval replacement and publication replay of a previously claimed review', async () => {
    const r = await reviewFixture(), saved = await claim(r), construction = vi.spyOn(records, 'validateRevalidationConstruction');
    await expect(publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint, r.approval)).rejects.toThrow(/already claimed/);
    await expect(publication.publishModernSuccessorRevalidation(r.root, r.result.publicationFingerprint)).rejects.toThrow(/already claimed/);
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
    expect(construction).not.toHaveBeenCalled();
  });
  it.each(['publishing', 'rolled-back', 'blocked'] as const)('reports saved %s without claiming completion or rerunning publication', async phase => {
    const r = await reviewFixture(), saved = await claim(r, { ...r.uncommitted, phase });
    expect(await inspect(r)).toMatchObject({ status: phase === 'publishing' ? 'interrupted' : phase, committed: false, readbackDigest: null });
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it('does not infer seal cleanup from an absent journal or accept saved readback as fresh proof', async () => {
    const r = await reviewFixture();
    const saved = await claim(r, { ...r.committed, phase: 'committed-readback-pending', readbackDigest: null, cleanupPending: true });
    expect(await inspect(r)).toMatchObject({ status: 'committed-cleanup-pending', committed: true, readbackDigest: null });
    await r.store.compareExchangeState(r.intent.fingerprint, saved.digest, r.committed);
    await expect(inspect(r)).rejects.toThrow('Completed execution requires original preview, consent, result and progress.');
    expect(await fs.readdir(r.root)).toEqual([]);
  });

  describe('portable publication coordination with explicitly modeled construction and transaction boundaries', () => {
    function modelConstruction(r: ReviewFixture) {
      const construction = vi.spyOn(records, 'validateRevalidationConstruction').mockResolvedValue();
      const preconditions = vi.spyOn(inputs, 'completionPreconditions').mockResolvedValue([]);
      const candidate: transaction.ReviewedUpdateCandidate = {
        payload: { schemaVersion: transaction.localVerificationTransactionSchemaVersion, transactionKind: 'local-verification',
          projectRoot: r.root, mutations: [], missingDirectories: [] },
        suppliedPreconditions: [], binding: r.result.candidateBinding, size: r.result.candidateSize
      };
      const measurement = vi.spyOn(transaction, 'inspectLocalVerificationCandidate').mockResolvedValue(candidate);
      return { construction, preconditions, candidate, measurement };
    }
    async function approved(r: ReviewFixture) {
      await r.store.write('publication-consent', r.result.publicationFingerprint, r.consent);
      return modelConstruction(r);
    }
    function publish(r: ReviewFixture) {
      return publication.publishModernSuccessorRevalidation(r.root, r.result.publicationFingerprint);
    }
    it('writes a separate narrow consent only after construction admission and reuses its exact bytes', async () => {
      const r = await reviewFixture(), { construction } = modelConstruction(r);
      const consent = await publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint, r.approval);
      expect(consent).toEqual({ ...r.consent, approvedAt: at(10000) });
      expect(construction).toHaveBeenCalledOnce();
      const saved = await r.store.read('publication-consent', r.result.publicationFingerprint);
      vi.setSystemTime(new Date(at(11000)));
      expect(await publication.approveModernSuccessorRevalidationPublication(r.root, r.result.publicationFingerprint, r.approval)).toEqual(consent);
      expect(await r.store.read('publication-consent', r.result.publicationFingerprint)).toEqual(saved);
      expect(construction).toHaveBeenCalledTimes(2);
      expect(await r.store.readState(r.intent.fingerprint)).toBeNull();
      expect(await fs.readdir(r.root)).toEqual([]);
    });
    it.each(['binding', 'size'] as const)('rejects a newly measured candidate with different %s before a publication claim', async field => {
      const r = await reviewFixture(), { candidate, measurement } = await approved(r), apply = vi.spyOn(transaction, 'applyLocalVerificationTransaction');
      measurement.mockResolvedValue(field === 'binding' ? { ...candidate, binding: h('9') } :
        { ...candidate, size: { ...candidate.size, headerBytes: candidate.size.headerBytes + 1 } });
      await expect(publish(r)).rejects.toThrow(/independently measured transaction/);
      expect(await r.store.readState(r.intent.fingerprint)).toBeNull(); expect(apply).not.toHaveBeenCalled();
    });
    it.each(['rolled-back', 'blocked'] as const)('records a modeled uncommitted %s result without repeating construction', async status => {
      const r = await reviewFixture(), { construction } = await approved(r);
      const apply = vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockResolvedValue({
        status, committed: false, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'),
        rollbackFailures: status === 'blocked' ? ['Modeled rollback failure.'] : [], cleanupFailures: []
      });
      expect(await publish(r)).toMatchObject({ status, committed: false, readbackDigest: null,
        rollbackFailures: status === 'blocked' ? ['Modeled rollback failure.'] : [] });
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: status, commitObservation: null, readbackDigest: null });
      expect(construction).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledOnce();
      expect(apply.mock.calls[0][2]).toMatchObject({ planFingerprint: r.result.publicationFingerprint, expectedCandidateBinding: r.result.candidateBinding, preconditions: [] });
      await expect(publish(r)).rejects.toThrow(/already claimed/);
      expect(apply).toHaveBeenCalledOnce();
      expect(await fs.readdir(r.root)).toEqual([]);
    });
    it('requires a durable checkpoint instead of inferring commit from a bare adapter result', async () => {
      const r = await reviewFixture(); await approved(r);
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockResolvedValue({
        status: 'committed', committed: true, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'), rollbackFailures: [], cleanupFailures: []
      });
      await expect(publish(r)).rejects.toThrow(/cannot infer commit/);
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'publishing', commitObservation: null });
    });
    it('saves modeled prepared and committed checkpoints before returning pending cleanup', async () => {
      const r = await reviewFixture(); await approved(r);
      const idle = (await boundary.inspectCompletionBoundary(r.root)).transaction;
      const observe = vi.spyOn(transaction, 'inspectLocalVerificationTransaction').mockResolvedValue(idle);
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockImplementation(async (_root, _mutations, options) => {
        observe.mockResolvedValue({ ...idle, ...attributed(r) });
        await options.onCheckpoint?.({ phase: 'prepared' });
        expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'publishing', transactionDigest: h('b'), commitObservation: null });
        observe.mockClear();
        await options.onCheckpoint?.({ phase: 'staged', index: 0 });
        expect(observe).not.toHaveBeenCalled();
        observe.mockResolvedValue({ ...idle, ...attributed(r, 'committed') });
        await options.onCheckpoint?.({ phase: 'committed' });
        return { status: 'committed', committed: true, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'),
          rollbackFailures: [], cleanupFailures: ['Modeled cleanup refusal.'] };
      });
      expect(await publish(r)).toMatchObject({ status: 'committed-cleanup-pending', committed: true, transactionDigest: h('b'),
        cleanupFailures: ['Modeled cleanup refusal.'], readbackDigest: null });
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'committed-readback-pending', cleanupPending: true,
        commitObservation: { publicationFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'), source: 'local-verification-inspector' } });
      expect(await fs.readdir(r.root)).toEqual([]);
    });
    it('does not turn modeled clean commit into current readback when actual native proof is absent', async () => {
      const r = await reviewFixture(); await approved(r);
      const idle = (await boundary.inspectCompletionBoundary(r.root)).transaction;
      const observe = vi.spyOn(transaction, 'inspectLocalVerificationTransaction').mockResolvedValue(idle);
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockImplementation(async (_root, _mutations, options) => {
        observe.mockResolvedValue({ ...idle, ...attributed(r, 'committed') });
        await options.onCheckpoint?.({ phase: 'committed' });
        observe.mockResolvedValue(idle);
        return { status: 'committed', committed: true, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'),
          rollbackFailures: [], cleanupFailures: [] };
      });
      await expect(publish(r)).rejects.toThrow('Completed execution requires original preview, consent, result and progress.');
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'committed-readback-pending',
        cleanupPending: false, readbackDigest: null, commitObservation: { committed: true } });
      expect(await fs.readdir(r.root)).toEqual([]);
    });
    it.each(['fingerprint', 'missing-transaction', 'status', 'replacement-transaction'] as const)('refuses a modeled checkpoint with %s mismatch', async mismatch => {
      const r = await reviewFixture(); await approved(r);
      const idle = (await boundary.inspectCompletionBoundary(r.root)).transaction;
      const observe = vi.spyOn(transaction, 'inspectLocalVerificationTransaction').mockResolvedValue(idle);
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockImplementation(async (_root, _mutations, options) => {
        if (mismatch === 'replacement-transaction') {
          observe.mockResolvedValue({ ...idle, ...attributed(r) });
          await options.onCheckpoint?.({ phase: 'prepared' });
        }
        observe.mockResolvedValue({ ...idle, ...attributed(r),
          ...(mismatch === 'fingerprint' ? { planFingerprint: h('9') } :
            mismatch === 'missing-transaction' ? { transactionDigest: undefined } :
            mismatch === 'status' ? { status: 'committed' } : { transactionDigest: h('9') }) });
        await options.onCheckpoint?.({ phase: 'prepared' });
        throw new Error('The mismatched checkpoint must reject before adapter continuation.');
      });
      await expect(publish(r)).rejects.toThrow(/checkpoint has different root, review or transaction attribution/);
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'publishing', commitObservation: null,
        transactionDigest: mismatch === 'replacement-transaction' ? h('b') : null });
    });
    it.each(['before-admission', 'before-publication', 'before-commit'] as const)('rechecks consent at modeled %s before protected reads', async stage => {
      const r = await reviewFixture(); await approved(r);
      const compare = vi.spyOn(records, 'compareRevalidationExecution');
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockImplementation(async (_root, _mutations, options) => {
        vi.setSystemTime(new Date(r.result.reviewExpiresAt));
        await options.validateCurrentInputs(stage);
        throw new Error('Expired consent must reject before adapter continuation.');
      });
      await expect(publish(r)).rejects.toThrow(/expired/i);
      expect(compare).not.toHaveBeenCalled();
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'publishing', commitObservation: null });
    });
    it('refuses an unattributed precommit journal before protected target observation', async () => {
      const r = await reviewFixture(); await approved(r);
      const idle = (await boundary.inspectCompletionBoundary(r.root)).transaction;
      const observe = vi.spyOn(transaction, 'inspectLocalVerificationTransaction').mockResolvedValue(idle);
      const compare = vi.spyOn(records, 'compareRevalidationExecution');
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockImplementation(async (_root, _mutations, options) => {
        observe.mockResolvedValue({ ...idle, ...attributed(r), planFingerprint: h('9') });
        await options.validateCurrentInputs('before-commit');
        throw new Error('Unattributed journal must reject before adapter continuation.');
      });
      await expect(publish(r)).rejects.toThrow(/precommit journal differs/);
      expect(compare).not.toHaveBeenCalled();
    });
    it.each(['restored', 'rollback-failure', 'journal-remains', 'ordinary-error'] as const)('preserves the exact %s exception and qualifies rollback only narrowly', async failure => {
      const r = await reviewFixture(); await approved(r);
      const idle = (await boundary.inspectCompletionBoundary(r.root)).transaction;
      const observe = vi.spyOn(transaction, 'inspectLocalVerificationTransaction').mockResolvedValue(idle);
      const error = failure === 'ordinary-error' ? new Error('Modeled nontransaction failure.') :
        new transaction.ReviewedUpdateTransactionError('Modeled transaction failure.', failure === 'rollback-failure' ? ['Modeled restore refusal.'] : []);
      vi.spyOn(transaction, 'applyLocalVerificationTransaction').mockImplementation(async () => {
        if (failure === 'journal-remains') observe.mockResolvedValue({ ...idle, ...attributed(r) });
        throw error;
      });
      await expect(publish(r)).rejects.toBe(error);
      expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({
        phase: failure === 'restored' ? 'rolled-back' : 'publishing', commitObservation: null, readbackDigest: null
      });
      expect(await fs.readdir(r.root)).toEqual([]);
    });
  });
});

describe('portable recovery coordination with explicitly modeled transaction observations', () => {
  it('requires the original claim even when exact consent exists', async () => {
    const r = await reviewFixture();
    await r.store.write('publication-consent', r.result.publicationFingerprint, r.consent);
    await expect(recovery(r)).rejects.toThrow(/original publication claim/);
  });
  it.each([false, true])('preserves saved committed=%s when inspection is blocked', async committed => {
    const r = await reviewFixture(), saved = await claim(r, committed ? r.committed : r.uncommitted);
    await modelBoundary(r, { status: 'blocked', reason: 'Modeled unreadable journal.' });
    expect(await recovery(r)).toMatchObject({ status: committed ? 'committed-readback-pending' : 'blocked', committed,
      cleanupFailures: ['Modeled unreadable journal.'] });
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it.each(['planFingerprint', 'transactionDigest'] as const)('refuses foreign %s before invoking recovery', async field => {
    const r = await reviewFixture(), saved = await claim(r, { ...r.uncommitted, transactionDigest: h('b') });
    const recover = vi.spyOn(transaction, 'recoverLocalVerificationTransaction');
    await modelBoundary(r, { ...attributed(r), [field]: h('9') });
    await expect(recovery(r)).rejects.toThrow(/another approved publication/);
    await expect(inspect(r)).rejects.toThrow(/not this revalidation publication/);
    expect(recover).not.toHaveBeenCalled();
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it('never downgrades an observed committed publication to an interrupted transaction', async () => {
    const r = await reviewFixture(), saved = await claim(r, r.committed);
    await modelBoundary(r, attributed(r));
    await expect(recovery(r)).rejects.toThrow(/cannot be downgraded/);
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it.each(['publishing', 'rolled-back'] as const)('does not replay saved %s after its journal disappears', async phase => {
    const r = await reviewFixture(), saved = await claim(r, { ...r.uncommitted, phase }), recover = vi.spyOn(transaction, 'recoverLocalVerificationTransaction');
    vi.setSystemTime(new Date(at(1000000)));
    expect(await recovery(r)).toMatchObject({ status: phase === 'rolled-back' ? 'rolled-back' : 'blocked', committed: false });
    expect(recover).not.toHaveBeenCalled();
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it('retains durable commit and pending cleanup when the journal is absent', async () => {
    const r = await reviewFixture(), saved = await claim(r, { ...r.committed, phase: 'committed-readback-pending', readbackDigest: null, cleanupPending: true });
    expect(await recovery(r)).toMatchObject({ status: 'committed-cleanup-pending', committed: true, readbackDigest: null });
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it.each(['interrupted', 'blocked', 'committed'] as const)('reports modeled %s observation without treating it as current readback', async status => {
    const r = await reviewFixture();
    await claim(r);
    await modelBoundary(r, { ...attributed(r), status, committed: status === 'committed', reason: 'Modeled observation.' });
    expect(await inspect(r)).toMatchObject({ status: status === 'committed' ? 'committed-cleanup-pending' : status,
      committed: status === 'committed', transactionDigest: h('b'), cleanupFailures: ['Modeled observation.'], readbackDigest: null });
  });
  it.each(['rolled-back', 'blocked'] as const)('retains modeled %s outcome and forwards exact F/T to the transaction boundary', async status => {
    const r = await reviewFixture(); await claim(r);
    const observed = await modelBoundary(r, attributed(r));
    const recover = vi.spyOn(transaction, 'recoverLocalVerificationTransaction').mockResolvedValue({
      status, committed: false, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'),
      rollbackFailures: status === 'blocked' ? ['Modeled rollback refusal.'] : [], cleanupFailures: []
    });
    expect(await recovery(r)).toMatchObject({ status, committed: false, rollbackFailures: status === 'blocked' ? ['Modeled rollback refusal.'] : [] });
    expect(recover).toHaveBeenCalledExactlyOnceWith(r.root, { authorityStore: observed.authorityStore,
      expectedTransaction: { planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b') } });
    expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: status === 'rolled-back' ? 'rolled-back' : 'publishing' });
    expect(await fs.readdir(r.root)).toEqual([]);
  });
  it('rejects a recovery result attributed to a different transaction', async () => {
    const r = await reviewFixture(), saved = await claim(r);
    await modelBoundary(r, attributed(r));
    vi.spyOn(transaction, 'recoverLocalVerificationTransaction').mockResolvedValue({
      status: 'rolled-back', committed: false, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('9'), rollbackFailures: [], cleanupFailures: []
    });
    await expect(recovery(r)).rejects.toThrow(/different revalidation transaction attribution/);
    expect(await r.store.readState(r.intent.fingerprint)).toEqual(saved);
  });
  it('preserves an unattributed blocked adapter result without inventing transaction evidence', async () => {
    const r = await reviewFixture(); await claim(r);
    await modelBoundary(r, attributed(r));
    vi.spyOn(transaction, 'recoverLocalVerificationTransaction').mockResolvedValue({
      status: 'blocked', committed: false, rollbackFailures: [], cleanupFailures: ['Modeled competing transaction.']
    });
    expect(await recovery(r)).toMatchObject({ status: 'blocked', committed: false, transactionDigest: null, cleanupFailures: ['Modeled competing transaction.'] });
  });
  it('persists modeled commit observation before reporting cleanup failure', async () => {
    const r = await reviewFixture(); await claim(r);
    await modelBoundary(r, attributed(r, 'committed'));
    vi.spyOn(transaction, 'recoverLocalVerificationTransaction').mockResolvedValue({
      status: 'committed', committed: true, planFingerprint: r.result.publicationFingerprint, transactionDigest: h('b'), rollbackFailures: [], cleanupFailures: ['Modeled seal failure.']
    });
    expect(await recovery(r)).toMatchObject({ status: 'committed-cleanup-pending', committed: true, readbackDigest: null, cleanupFailures: ['Modeled seal failure.'] });
    expect((await r.store.readState(r.intent.fingerprint))?.value).toMatchObject({ phase: 'committed-readback-pending', cleanupPending: true,
      transactionDigest: h('b'), commitObservation: { publicationFingerprint: r.result.publicationFingerprint, committed: true } });
    expect(await fs.readdir(r.root)).toEqual([]);
  });
});
