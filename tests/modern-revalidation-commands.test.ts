import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { createCommandOutcome } from '../src/application/command-outcome.js';
import * as records from '../src/application/update/modern-revalidation-records.js';
import * as publication from '../src/application/update/modern-revalidation-publication.js';
import * as inspection from '../src/application/update/modern-revalidation-inspection.js';
import * as boundary from '../src/application/governance/modern-local-finalization.js';
import * as storage from '../src/adapters/filesystem/update-previews.js';
import * as publicInputs from '../src/adapters/filesystem/governance-records.js';
import * as historical from '../src/governance-activation/public-plans.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { fixture } from './fixtures/manifest-update.js';
import { writeModernInstalledProject, writeModernHistoricalSource } from './fixtures/modern-installed-project.js';
import { revalidationProject } from './fixtures/modern-revalidation-project.js';
import { fixture as wireFixture, h } from './fixtures/modern-revalidation-values.js';
import { originalFiles } from './modern-openspec-fixtures.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const native = process.env.LIFTOFF_PUBLIC_REVALIDATION_TESTS === '1';
if (native && (process.env.LIFTOFF_HCL_TEST_LANE === 'portable' ||
    process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.21.0')) {
  throw new Error('Public successor revalidation qualification requires the actual qualified macOS ARM64 runtime.');
}
const nativeIt = it.skipIf(!native), nativeCases: string[] = [];
const histories = (['spec-kit', 'openspec'] as const).flatMap(workflow => ([1, 2, 3] as const).map(version => ({ workflow, version })));
afterAll(() => {
  if (native) expect(nativeCases.sort()).toEqual([...histories.map(value => `${value.workflow}/${value.version}`),
    'incomplete', 'changed-source', 'committed-recovery'].sort());
});
afterEach(() => { vi.restoreAllMocks(); });
async function project() {
  const f = await fixture();
  await writeModernInstalledProject(f.root);
  return f;
}
async function input(root: string, name: string, value: unknown) {
  const file = path.join(path.dirname(root), name + '.json');
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}
async function invoke(root: string, args: string[], operation = 'revalidate-successor', jsonMode = true) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner(), outcome = createCommandOutcome();
  const code = await runCommand(parseArgs(['governance', ...args, '--scope', 'local', '--local-operation', operation,
    ...(jsonMode ? ['--json'] : [])]), { cwd: root, stdout, stderr, runner, outcome });
  expect(runner.calls).toEqual([]);
  return { code, stdout: stdout.text(), stderr: stderr.text(), semantic: outcome.finish(code),
    report: jsonMode && stdout.text() ? JSON.parse(stdout.text()) : undefined };
}

// Injected producer values test routing and reporting, never actual successor authority.
async function model(root: string, complete = true) {
  const values = wireFixture(complete, root), observed = await boundary.inspectCompletionBoundary(root);
  const progress = { projectRoot: root, publicationFingerprint: values.result.publicationFingerprint,
    intentFingerprint: values.intent.fingerprint, result: values.result, state: values.state,
    transaction: observed.transaction, recordedProgressIsCurrentProof: false as const };
  const review = { ...progress, files: values.result.targets.map(target => ({ ...target, content: '{}\n' })),
    currentSourceVerified: false as const, publicationAuthorized: false as const };
  return { ...values, progress, review, observed };
}
function returned(root: string, status: publication.SuccessorRevalidationOutcome['status']): publication.SuccessorRevalidationOutcome {
  const readback = status === 'revalidation-complete-current' || status === 'revalidation-incomplete';
  return { status, projectRoot: root, publicationFingerprint: h(), candidateBinding: h(), transactionDigest: h('b'),
    committed: readback || status.startsWith('committed-'), readbackDigest: readback ? h('c') : null,
    rollbackFailures: [], cleanupFailures: [], authority: 'local-only' };
}
describe('public successor revalidation routing and truthful effects', () => {
  it('constructs only through the selected producer and reviews its exact returned publication', async () => {
    const f = await project(), m = await model(f.root), request = { kind: 'revalidate-successor', executionFingerprint: h() };
    const file = await input(f.root, 'construct', request);
    const prepare = vi.spyOn(records, 'prepareModernSuccessorRevalidation').mockResolvedValue(m.result);
    const review = vi.spyOn(inspection, 'reviewModernRevalidationPublication').mockResolvedValue(m.review);
    const approve = vi.spyOn(publication, 'approveModernSuccessorRevalidationPublication'), old = vi.spyOn(historical, 'loadGovernancePreview');
    const result = await invoke(f.root, ['plan', '--inputs', file]);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ schemaVersion: 6, status: 'planned', fingerprint: m.result.publicationFingerprint,
      externalMetadataWriteRequested: true, executionRequested: false, projectFileEffectsRequested: false, localComplete: false });
    expect(prepare).toHaveBeenCalledWith(f.root, request);
    expect(review).toHaveBeenCalledWith(f.root, m.result.publicationFingerprint);
    expect(approve).not.toHaveBeenCalled(); expect(old).not.toHaveBeenCalled();
  });
  it('reviews saved exact text without constructing another candidate or saving consent', async () => {
    const f = await project(), m = await model(f.root);
    const file = await input(f.root, 'review', { kind: 'review-successor-revalidation', publicationFingerprint: m.result.publicationFingerprint });
    vi.spyOn(inspection, 'reviewModernRevalidationPublication').mockResolvedValue(m.review);
    const prepare = vi.spyOn(records, 'prepareModernSuccessorRevalidation'), approve = vi.spyOn(publication, 'approveModernSuccessorRevalidationPublication');
    const result = await invoke(f.root, ['plan', '--inputs', file]);
    expect(result.report).toMatchObject({ status: 'planned', externalMetadataWriteRequested: false, localComplete: false,
      review: { currentSourceVerified: false, publicationAuthorized: false } });
    expect(prepare).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  });
  it('forwards only the four exact authorization fields, preserving the original public key', async () => {
    const f = await project(), m = await model(f.root), authorization = {
      publishExactLocalBytes: true, intentFingerprint: m.intent.fingerprint,
      candidateBinding: m.result.candidateBinding, targetSetDigest: m.result.targetSetDigest
    };
    const file = await input(f.root, 'consent', { kind: 'approve-successor-revalidation', ...authorization });
    const approve = vi.spyOn(publication, 'approveModernSuccessorRevalidationPublication').mockResolvedValue(m.consent);
    const publish = vi.spyOn(publication, 'publishModernSuccessorRevalidation');
    const result = await invoke(f.root, ['approve', '--plan', m.result.publicationFingerprint, '--inputs', file]);
    expect(result.report).toMatchObject({ status: 'approved', operationComplete: true, localComplete: false });
    expect(approve).toHaveBeenCalledWith(f.root, m.result.publicationFingerprint, authorization);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(['awaiting-consent', 'awaiting-publication', 'interrupted', 'blocked', 'rolled-back',
    'committed-cleanup-pending', 'committed-readback-pending', 'revalidation-complete-current', 'revalidation-incomplete'] as const)(
    'preserves actual returned status %s without conflating commit, current proof and completion', async status => {
      const f = await project(), value = returned(f.root, status);
      const publish = vi.spyOn(publication, 'publishModernSuccessorRevalidation').mockResolvedValue(value);
      const result = await invoke(f.root, ['apply-next', '--plan', h(), '--execute']);
      const code = status === 'revalidation-complete-current' ? 0 : status === 'revalidation-incomplete' ? 2 : 1;
      expect(result.code).toBe(code);
      expect(result.semantic).toBe(code === 0 ? 'success' : code === 2 ? 'attention-required' : 'failure');
      expect(result.report).toMatchObject({ status, publicationCommitted: value.committed, result: value,
        projectFileEffectsRequested: true, localComplete: code === 0, revalidationComplete: code === 0,
        activationComplete: false, lifecycleComplete: false, providerOperationsAuthorized: false });
      expect(publish).toHaveBeenCalledWith(f.root, h());
    });
  it.each(['revalidation-complete-current', 'revalidation-incomplete'] as const)(
    'requires committed current readback and clean effects for %s', async status => {
      const f = await project();
      for (const changed of [{ readbackDigest: null }, { committed: false }, { cleanupFailures: ['Not cleaned.'] }, { rollbackFailures: ['Not restored.'] }]) {
        vi.spyOn(publication, 'publishModernSuccessorRevalidation').mockResolvedValue({ ...returned(f.root, status), ...changed });
        const result = await invoke(f.root, ['apply-next', '--plan', h(), '--execute']);
        expect(result.code).toBe(1); expect(result.report.localComplete).toBe(false);
      }
    });
  it('retains unknown effects on a thrown producer outcome instead of implying rollback', async () => {
    const f = await project();
    vi.spyOn(publication, 'publishModernSuccessorRevalidation').mockRejectedValue(new Error('No completed outcome returned.'));
    const result = await invoke(f.root, ['apply-next', '--plan', h(), '--execute']);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ status: 'failed', publicationCommitted: null, projectFileEffectsUncertain: true, localComplete: false });
    expect(result.stdout).toContain('Failure does not imply rollback');
  });
  it.each([true, false])('withholds credential-shaped output while retaining committed effects (JSON %s)', async jsonMode => {
    const f = await project(), token = 'ghp_' + 'x'.repeat(36);
    vi.spyOn(publication, 'publishModernSuccessorRevalidation').mockResolvedValue({
      ...returned(f.root, 'committed-cleanup-pending'), cleanupFailures: [token]
    });
    const result = await invoke(f.root, ['apply-next', '--plan', h(), '--execute'], 'revalidate-successor', jsonMode);
    expect(result.code).toBe(1); expect(result.semantic).toBe('failure');
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout).toContain('"publicationCommitted": true');
    expect(result.stdout).toContain('"projectFileEffectsUncertain": true');
    expect(result.stdout).toContain('was withheld');
  });
  it.each(['apply-next', 'recover'])('keeps %s nonexecuting with omitted or false --execute', async command => {
    const f = await project(), m = await model(f.root);
    const inspect = vi.spyOn(inspection, 'inspectModernRevalidationProgress').mockResolvedValue(m.progress);
    const publish = vi.spyOn(publication, 'publishModernSuccessorRevalidation'), recover = vi.spyOn(publication, 'recoverModernSuccessorRevalidation');
    for (const tail of [[], ['--execute=false']]) {
      const result = await invoke(f.root, [command, '--plan', m.result.publicationFingerprint, ...tail]);
      expect(result.report).toMatchObject({ status: 'not-executed', localComplete: false, revalidationComplete: false,
        executionRequested: false, externalMetadataWriteRequested: false, projectFileEffectsRequested: false,
        recordedProgressIsCurrentProof: false });
      expect(result.semantic).toBe('attention-required');
    }
    expect(inspect).toHaveBeenCalledWith(f.root, m.result.publicationFingerprint);
    expect(publish).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  });
  it('reports clean explicit rollback as recovery success, not revalidation completion', async () => {
    const f = await project(), m = await model(f.root);
    vi.spyOn(inspection, 'inspectModernRevalidationProgress').mockResolvedValue(m.progress);
    const recover = vi.spyOn(publication, 'recoverModernSuccessorRevalidation').mockResolvedValue(returned(f.root, 'rolled-back'));
    const result = await invoke(f.root, ['recover', '--plan', m.result.publicationFingerprint, '--execute']);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ operationComplete: true, localComplete: false, publicationCommitted: false });
    expect(recover).toHaveBeenCalledWith(f.root, { publicationFingerprint: m.result.publicationFingerprint });
    recover.mockResolvedValue({ ...returned(f.root, 'rolled-back'), rollbackFailures: ['Original restoration failed.'] });
    expect((await invoke(f.root, ['recover', '--plan', m.result.publicationFingerprint, '--execute'])).code).toBe(1);
  });
  it('rejects foreign or unattributed transactions before any result authority or recovery producer', async () => {
    const f = await project(), observed = await boundary.inspectCompletionBoundary(f.root);
    const load = vi.spyOn(records, 'loadRevalidationResult'), recover = vi.spyOn(publication, 'recoverModernSuccessorRevalidation');
    for (const planFingerprint of [h('b'), undefined]) {
      vi.spyOn(boundary, 'inspectCompletionBoundary').mockResolvedValue({
        ...observed, transaction: { ...observed.transaction, status: 'interrupted', planFingerprint, transactionDigest: h('c') }
      });
      await expect(inspection.inspectModernRevalidationProgress(f.root, h())).rejects.toThrow('not attributable');
      await expect(inspection.reviewModernRevalidationPublication(f.root, h())).rejects.toThrow('not attributable');
      expect((await invoke(f.root, ['recover', '--plan', h(), '--execute'])).code).toBe(1);
    }
    expect(load).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  });
  it('rejects malformed consent before opening publication authority or launching tools', async () => {
    const f = await project(), file = await input(f.root, 'bad', { kind: 'approve-successor-revalidation', publishExactLocalBytes: true });
    const approve = vi.spyOn(publication, 'approveModernSuccessorRevalidationPublication'), tools = vi.spyOn(NodeCommandRunner.prototype, 'run');
    expect((await invoke(f.root, ['approve', '--plan', h(), '--inputs', file])).code).toBe(1);
    expect(approve).not.toHaveBeenCalled(); expect(tools).not.toHaveBeenCalled();
  });
  it('rejects historical families before opening any new public inputs or authority stores', async () => {
    const f = await fixture();
    await writeModernHistoricalSource(f.root, 3);
    const read = vi.spyOn(publicInputs, 'readPublicGovernanceInputs'), store = vi.spyOn(records, 'revalidationStore');
    const result = await invoke(f.root, ['plan', '--inputs', 'must-not-open.json']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('only by modern v8');
    expect(read).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled();
  });
});

async function savedModel() {
  const f = await project(), m = await model(f.root);
  const store = storage.createLocalRevalidationRecordStore(f.root, { homedir: f.home, env: {} });
  vi.spyOn(records, 'revalidationStore').mockReturnValue(store);
  vi.spyOn(records, 'loadRevalidationResult').mockResolvedValue({
    intent: m.intent, result: m.result,
    index: { kind: 'liftoff-local-protected-index', schemaVersion: 1, projectRoot: f.root, files: [], directories: [], physical: [] },
    mutations: m.result.targets.map(target => ({ type: 'write', pathParts: [...target.pathParts], content: Buffer.from('{}'), mode: 0o600 }))
  });
  return { ...f, ...m, store };
}
describe('selected revalidation inspection without current-proof inference', () => {
  it('distinguishes missing progress from missing review and returns exact saved target text without tools', async () => {
    const f = await savedModel(), tools = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const compare = vi.spyOn(records, 'compareRevalidationExecution'), before = await originalFiles(f.root);
    expect(await inspection.inspectModernRevalidationProgress(f.root, f.result.publicationFingerprint))
      .toMatchObject({ state: null, recordedProgressIsCurrentProof: false });
    expect(await inspection.reviewModernRevalidationPublication(f.root, f.result.publicationFingerprint))
      .toMatchObject({ state: null, currentSourceVerified: false, publicationAuthorized: false,
        files: f.result.targets.map(target => ({ ...target, content: '{}' })) });
    vi.mocked(records.loadRevalidationResult).mockRejectedValue(new Error('Exact revalidation result is missing.'));
    await expect(inspection.inspectModernRevalidationProgress(f.root, f.result.publicationFingerprint)).rejects.toThrow('result is missing');
    expect(tools).not.toHaveBeenCalled(); expect(compare).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });
  it('validates saved complete progress but never promotes it to current proof', async () => {
    const f = await savedModel();
    await f.store.compareExchangeState(f.intent.fingerprint, null, f.state);
    const before = await originalFiles(f.home);
    expect(await inspection.inspectModernRevalidationProgress(f.root, f.result.publicationFingerprint))
      .toMatchObject({ state: f.state, recordedProgressIsCurrentProof: false });
    expect(await originalFiles(f.home)).toEqual(before);
  });
  it('rejects construction aliases even when the private loader can resolve them', async () => {
    const f = await savedModel();
    await expect(inspection.inspectModernRevalidationProgress(f.root, f.intent.fingerprint)).rejects.toThrow('not its construction');
    await expect(inspection.reviewModernRevalidationPublication(f.root, f.intent.fingerprint)).rejects.toThrow('not its construction');
  });
  it('rejects a mismatched original claim or malformed progress without repairing it', async () => {
    const f = await savedModel();
    const saved = await f.store.compareExchangeState(f.intent.fingerprint, null, f.state);
    vi.spyOn(boundary, 'inspectCompletionBoundary').mockResolvedValue({
      ...f.observed, transaction: { ...f.observed.transaction, status: 'interrupted',
        planFingerprint: f.result.publicationFingerprint, transactionDigest: h('9') }
    });
    await expect(inspection.inspectModernRevalidationProgress(f.root, f.result.publicationFingerprint)).rejects.toThrow('original publication claim');
    vi.mocked(boundary.inspectCompletionBoundary).mockResolvedValue(f.observed);
    await f.store.compareExchangeState(f.intent.fingerprint, saved.digest, { ...f.state, candidateBinding: h('8') });
    const before = await originalFiles(f.home);
    await expect(inspection.inspectModernRevalidationProgress(f.root, f.result.publicationFingerprint)).rejects.toThrow();
    expect(await originalFiles(f.home)).toEqual(before);
  });
});

async function ready(completed = true, version: 1 | 2 | 3 = 3, workflow: 'spec-kit' | 'openspec' = 'spec-kit') {
  const f = await revalidationProject(completed, version, version === 2, workflow), original = await originalFiles(f.root);
  const request = await input(f.root, 'verification', { kind: workflow === 'openspec' ? 'verify-openspec-archived' : 'verify-local', preparation: [] });
  const plan = await invoke(f.root, ['plan', '--inputs', request], 'verify');
  expect(plan.code, plan.stdout + plan.stderr).toBe(0);
  const executionFingerprint: string = plan.report.fingerprint;
  const consent = await input(f.root, 'verification-consent', { kind: 'approve-local-execution', scopes: {
    projectCode: true, hostCapabilitiesAcknowledged: true, dependencyPreparation: false, dependencyNetwork: false,
    workflowFinalization: false, publishLocalRecords: false
  } });
  expect((await invoke(f.root, ['approve', '--plan', executionFingerprint, '--inputs', consent], 'verify')).code).toBe(0);
  const executed = await invoke(f.root, ['apply-next', '--plan', executionFingerprint, '--execute'], 'verify');
  expect(executed.code, executed.stdout + executed.stderr).toBe(0);
  expect(executed.report).toMatchObject({ executionRequested: true, verificationComplete: true, result: { complete: true } });
  expect(await originalFiles(f.root)).toEqual(original);
  const construction = await input(f.root, 'construct', { kind: 'revalidate-successor', executionFingerprint });
  const prepared = await invoke(f.root, ['plan', '--inputs', construction]);
  expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
  const publicationFingerprint: string = prepared.report.fingerprint;
  const reviewed = await inspection.reviewModernRevalidationPublication(f.root, publicationFingerprint);
  const publicationConsent = await input(f.root, 'publication-consent', {
    kind: 'approve-successor-revalidation', publishExactLocalBytes: true, intentFingerprint: reviewed.intentFingerprint,
    candidateBinding: reviewed.result.candidateBinding, targetSetDigest: reviewed.result.targetSetDigest
  });
  expect(prepared.report.review).toEqual(reviewed);
  expect(reviewed.result.originalTransitionDigest).toBe(f.successor.prepared.journal.semanticTransitionDigest);
  expect(reviewed.result.originalPreparationDigest).toBe(canonicalSha256(f.successor.prepared.journal.preparation));
  expect(await originalFiles(f.root)).toEqual(original);
  return { ...f, original, reviewed, publicationFingerprint, publicationConsent };
}

describe('actual public successor verification and exact publication', () => {
  nativeIt.each(histories)('publishes $workflow history v$version without rewriting original provenance or source', async ({ workflow, version }) => {
    nativeCases.push(`${workflow}/${version}`);
    const f = await ready(true, version, workflow);
    expect(f.reviewed.files).toHaveLength(8);
    expect(f.reviewed.files.every(file => file.pathParts[0] === 'governance')).toBe(true);
    const alias = await input(f.root, 'wrong-selector', { kind: 'review-successor-revalidation', publicationFingerprint: f.reviewed.intentFingerprint });
    expect((await invoke(f.root, ['plan', '--inputs', alias])).code).toBe(1);
    expect((await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint, '--execute'])).code).toBe(1);
    expect(await originalFiles(f.root)).toEqual(f.original);
    expect((await invoke(f.root, ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent])).code).toBe(0);
    const saved = await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint, '--execute=false']);
    expect(saved.report).toMatchObject({ localComplete: false, executionRequested: false, inspection: { state: null } });
    expect(await originalFiles(f.root)).toEqual(f.original);
    const published = await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint, '--execute']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    expect(published.report).toMatchObject({ localComplete: true, revalidationComplete: true, publicationCommitted: true });
    const targets = new Set(f.reviewed.files.map(file => file.pathParts.join('/'))), after = await originalFiles(f.root);
    for (const [name, value] of Object.entries(f.original)) if (!targets.has(name)) expect(after[name], name).toEqual(value);
    for (const file of f.reviewed.files) {
      const absolute = path.join(f.root, ...file.pathParts);
      expect(await fs.readFile(absolute)).toEqual(Buffer.from(file.content));
      expect((await fs.lstat(absolute)).mode & 0o7777).toBe(file.target.mode);
    }
    expect(Object.keys(after).filter(name => !(name in f.original)).every(name => targets.has(name))).toBe(true);
    expect((await publication.inspectModernSuccessorRevalidationPublication(f.root, f.publicationFingerprint)).status).toBe('revalidation-complete-current');
    const tools = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const inspectionResult = await invoke(f.root, ['recover', '--plan', f.publicationFingerprint]);
    expect(inspectionResult.report).toMatchObject({ localComplete: false, recordedProgressIsCurrentProof: false, inspection: { state: { phase: 'complete' } } });
    expect(tools).not.toHaveBeenCalled();
    expect((await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint, '--execute'])).code).toBe(1);
    expect(await originalFiles(f.root)).toEqual(after);
  }, 300000);

  nativeIt('returns exit two for real committed incomplete revalidation and preserves its current successor', async () => {
    nativeCases.push('incomplete');
    const f = await ready(false);
    expect(f.reviewed.result.phases.map(phase => phase.status)).toEqual(['complete', 'complete', 'blocked']);
    expect(f.reviewed.files).toHaveLength(7);
    expect((await invoke(f.root, ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent])).code).toBe(0);
    const result = await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint, '--execute']);
    expect(result.code, result.stdout + result.stderr).toBe(2); expect(result.semantic).toBe('attention-required');
    expect(result.report).toMatchObject({ status: 'revalidation-incomplete', publicationCommitted: true,
      operationComplete: false, localComplete: false, revalidationComplete: false });
    const after = await originalFiles(f.root);
    expect(after['liftoff.manifest.json']).toEqual(f.original['liftoff.manifest.json']);
    expect(after[f.tasks.join('/')]).toEqual(f.original[f.tasks.join('/')]);
    expect((await publication.inspectModernSuccessorRevalidationPublication(f.root, f.publicationFingerprint)).status).toBe('revalidation-incomplete');
    const recovery = await invoke(f.root, ['recover', '--plan', f.publicationFingerprint, '--execute']);
    expect(recovery.code, recovery.stdout + recovery.stderr).toBe(2);
    expect(await originalFiles(f.root)).toEqual(after);
  }, 300000);

  nativeIt('refuses changed source before saving publication consent while saved review remains nonauthoritative', async () => {
    nativeCases.push('changed-source');
    const f = await ready();
    await f.put([...f.components.get('backend')!, 'tests', 'source.test.js'], 'throw new Error("changed public successor source");\n');
    const changed = await originalFiles(f.root);
    const result = await invoke(f.root, ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent]);
    expect(result.code).toBe(1);
    expect(await records.revalidationStore(f.root).read('publication-consent', f.publicationFingerprint)).toBeNull();
    const saved = await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint]);
    expect(saved.report).toMatchObject({ status: 'not-executed', localComplete: false, recordedProgressIsCurrentProof: false });
    expect(await originalFiles(f.root)).toEqual(changed);
  }, 300000);

  nativeIt('recovers actual committed publication after injected checkpoint-storage failure without replay', async () => {
    nativeCases.push('committed-recovery');
    const f = await ready();
    expect((await invoke(f.root, ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent])).code).toBe(0);
    const create = storage.createLocalRevalidationRecordStore;
    const fault = vi.spyOn(storage, 'createLocalRevalidationRecordStore').mockImplementation((root, options) => {
      const store = create(root, options);
      return { ...store, compareExchangeState: async (key, expected, value) => {
        if (value && typeof value === 'object' && 'phase' in value && value.phase === 'committed-readback-pending') {
          throw new Error('Explicit denied revalidation commit observation for public recovery qualification.');
        }
        return store.compareExchangeState(key, expected, value);
      } };
    });
    expect((await invoke(f.root, ['apply-next', '--plan', f.publicationFingerprint, '--execute'])).code).toBe(1);
    fault.mockRestore();
    const saved = await invoke(f.root, ['recover', '--plan', f.publicationFingerprint]);
    expect(saved.report).toMatchObject({ localComplete: false, executionRequested: false, inspection: { transaction: { committed: true } } });
    const recovered = await invoke(f.root, ['recover', '--plan', f.publicationFingerprint, '--execute']);
    expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
    expect(recovered.report).toMatchObject({ localComplete: true, publicationCommitted: true, revalidationComplete: true });
    expect((await publication.inspectModernSuccessorRevalidationPublication(f.root, f.publicationFingerprint)).status).toBe('revalidation-complete-current');
  }, 300000);
});
