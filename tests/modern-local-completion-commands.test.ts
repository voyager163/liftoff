import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { createCommandOutcome } from '../src/application/command-outcome.js';
import * as finalization from '../src/application/governance/modern-local-finalization.js';
import * as publication from '../src/application/governance/modern-local-publication.js';
import * as inspection from '../src/application/governance/modern-local-completion-inspection.js';
import * as storage from '../src/adapters/filesystem/update-previews.js';
import * as publicInputs from '../src/adapters/filesystem/governance-records.js';
import * as historical from '../src/governance-activation/public-plans.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { writeModernInstalledProject, writeModernHistoricalSource } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';
import { originalFiles } from './modern-openspec-fixtures.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const fingerprint = 'a'.repeat(64);
const executionScopes = {
  projectCode: true, hostCapabilitiesAcknowledged: true, dependencyPreparation: false,
  dependencyNetwork: false, workflowFinalization: false, publishLocalRecords: false
};
const finalizationScopes = {
  finalizeLocal: true, workflowWrites: false, projectCode: false,
  dependencyPreparation: false, dependencyNetwork: false, publishLocalRecords: false
};
const roots: { path: string; dev: number; ino: number }[] = [];
const native = process.env.LIFTOFF_PUBLIC_COMPLETION_TESTS === '1';
if (native && (process.env.LIFTOFF_HCL_TEST_LANE === 'portable' ||
    process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.21.0')) {
  throw new Error('Public completion native qualification requires the actual qualified macOS ARM64 runtime.');
}
const nativeIt = it.skipIf(!native), nativeCases: string[] = [];
const combinations = (['manual', 'spec-kit'] as const).flatMap(workflow =>
  (['none', 'single-maintainer-gitflow', 'team-gitflow'] as const).map(profile => ({ workflow, profile })));
afterAll(() => {
  if (native) expect(nativeCases.sort()).toEqual([...combinations.map(value => `${value.workflow}/${value.profile}`), 'stale', 'committed-recovery'].sort());
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0).reverse()) {
    const stat = await fs.lstat(root.path);
    expect([stat.dev, stat.ino, stat.isDirectory(), stat.isSymbolicLink()]).toEqual([root.dev, root.ino, true, false]);
    await fs.rm(root.path, { recursive: true });
  }
});
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'public-completion-'))), stat = await fs.lstat(root);
  roots.push({ path: root, dev: stat.dev, ino: stat.ino });
  return root;
}
async function fixture() {
  return writeModernInstalledProject(path.join(await directory(), 'Project Space'));
}
async function input(root: string, name: string, value: unknown) {
  const file = path.join(path.dirname(root), name + '.json');
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}
async function invoke(root: string, operation: 'verify' | 'finalize' | 'publish', args: string[], jsonMode = true) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner(), outcome = createCommandOutcome();
  const code = await runCommand(parseArgs(['governance', ...args, '--scope', 'local', '--local-operation', operation,
    ...(jsonMode ? ['--json'] : [])]), { cwd: root, stdout, stderr, runner, outcome });
  expect(runner.calls).toEqual([]);
  return { code, stdout: stdout.text(), stderr: stderr.text(), semantic: outcome.finish(code),
    report: jsonMode && stdout.text() ? JSON.parse(stdout.text()) : undefined };
}

// These producer specimens exercise routing/output, not native authority or filesystem qualification.
function publicationOutcome(root: string, status: publication.LocalPublicationOutcome['status']): publication.LocalPublicationOutcome {
  return {
    status, projectRoot: root, publicationFingerprint: fingerprint, candidateBinding: fingerprint,
    transactionDigest: fingerprint, committed: status.startsWith('committed-') || status === 'local-complete-current',
    readbackDigest: status === 'local-complete-current' ? fingerprint : null,
    rollbackFailures: [], cleanupFailures: [], authority: 'local-only'
  };
}
describe('public completion routing and effects', () => {
  it('routes finalization planning only to its selected producer without broad authority', async () => {
    const f = await fixture(), file = await input(f.root, 'finalization', { kind: 'finalize-local', executionFingerprint: fingerprint });
    const prepare = vi.spyOn(finalization, 'prepareModernLocalFinalization').mockRejectedValue(new Error('Exact producer refusal.'));
    const publish = vi.spyOn(publication, 'publishModernLocalCompletion'), old = vi.spyOn(historical, 'loadGovernancePreview');
    const result = await invoke(f.root, 'finalize', ['plan', '--inputs', file]);
    expect(result.report).toMatchObject({ schemaVersion: 5, operation: 'finalize', status: 'failed',
      executionRequested: false, externalMetadataWriteRequested: true, projectFileEffectsRequested: false, localComplete: false });
    expect(prepare).toHaveBeenCalledWith(f.root, { kind: 'finalize-local', executionFingerprint: fingerprint });
    expect(publish).not.toHaveBeenCalled(); expect(old).not.toHaveBeenCalled();
  });
  it('routes publication review without saving approval or claiming current source', async () => {
    const f = await fixture(), file = await input(f.root, 'review', { kind: 'review-local-publication', publicationFingerprint: fingerprint });
    const review = vi.spyOn(inspection, 'reviewModernLocalPublication').mockRejectedValue(new Error('Exact review refusal.'));
    const approve = vi.spyOn(publication, 'approveModernLocalPublication');
    const result = await invoke(f.root, 'publish', ['plan', '--inputs', file]);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ executionRequested: false, externalMetadataWriteRequested: false, localComplete: false });
    expect(review).toHaveBeenCalledWith(f.root, fingerprint); expect(approve).not.toHaveBeenCalled();
  });
  it('passes only exact publication authorization and never the public kind', async () => {
    const f = await fixture(), authorization = {
      publishExactLocalBytes: true as const, finalizationFingerprint: fingerprint, candidateBinding: fingerprint, targetSetDigest: fingerprint
    };
    const file = await input(f.root, 'consent', { kind: 'approve-local-publication', ...authorization });
    const approve = vi.spyOn(publication, 'approveModernLocalPublication').mockResolvedValue({
      kind: 'liftoff-local-publication-consent', schemaVersion: 1, projectRoot: f.root,
      ...authorization, publicationFingerprint: fingerprint, finalizationResultDigest: fingerprint,
      executionConsentDigest: fingerprint, executionResultDigest: fingerprint,
      approvedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T00:15:00.000Z'
    });
    const execute = vi.spyOn(publication, 'publishModernLocalCompletion');
    const result = await invoke(f.root, 'publish', ['approve', '--plan', fingerprint, '--inputs', file]);
    expect(result.report).toMatchObject({ status: 'approved', operationComplete: true, localComplete: false, executionRequested: false });
    expect(approve).toHaveBeenCalledWith(f.root, fingerprint, authorization); expect(execute).not.toHaveBeenCalled();
  });
  it.each(['absent', 'awaiting-consent', 'interrupted', 'rolled-back', 'blocked', 'committed-cleanup-pending',
    'committed-readback-pending', 'local-complete-current'] as const)('preserves actual publication outcome %s', async status => {
    const f = await fixture(), receipt = publicationOutcome(f.root, status);
    const publish = vi.spyOn(publication, 'publishModernLocalCompletion').mockResolvedValue(receipt);
    const result = await invoke(f.root, 'publish', ['apply-next', '--plan', fingerprint, '--execute']);
    expect(result.code).toBe(status === 'local-complete-current' ? 0 : 1);
    expect(result.report).toMatchObject({ status, result: receipt, publicationCommitted: receipt.committed,
      projectFileEffectsRequested: true, localComplete: status === 'local-complete-current', activationComplete: false,
      lifecycleComplete: false, providerOperationsAuthorized: false });
    expect(publish).toHaveBeenCalledWith(f.root, fingerprint);
  });
  it('does not turn a claimed successful status without readback into completion', async () => {
    const f = await fixture();
    vi.spyOn(publication, 'publishModernLocalCompletion').mockResolvedValue({
      ...publicationOutcome(f.root, 'local-complete-current'), readbackDigest: null
    });
    const result = await invoke(f.root, 'publish', ['apply-next', '--plan', fingerprint, '--execute']);
    expect(result.code).toBe(1); expect(result.report.localComplete).toBe(false);
  });
  it('preserves possible file effects when the producer throws before returning an outcome', async () => {
    const f = await fixture();
    vi.spyOn(publication, 'publishModernLocalCompletion').mockRejectedValue(new Error('No completed readback was returned.'));
    const result = await invoke(f.root, 'publish', ['apply-next', '--plan', fingerprint, '--execute']);
    expect(result.semantic).toBe('failure');
    expect(result.report).toMatchObject({ status: 'failed', operationComplete: false, localComplete: false,
      publicationCommitted: null, projectFileEffectsUncertain: true, projectFileEffectsRequested: true });
    expect(result.stdout).toContain('Failure does not imply rollback');
  });
  it('preserves rollback and cleanup failures rather than presenting successful compensation', async () => {
    const f = await fixture();
    vi.spyOn(publication, 'recoverModernLocalCompletion').mockResolvedValue({
      ...publicationOutcome(f.root, 'rolled-back'), rollbackFailures: ['Original bytes could not be restored.'], cleanupFailures: ['Owned cleanup is incomplete.']
    });
    const result = await invoke(f.root, 'publish', ['recover', '--plan', fingerprint, '--execute']);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ operationComplete: false, localComplete: false, projectFileEffectsUncertain: true,
      result: { rollbackFailures: ['Original bytes could not be restored.'], cleanupFailures: ['Owned cleanup is incomplete.'] } });
  });
  it.each([true, false])('withholds credential-shaped output without hiding committed effects (JSON %s)', async jsonMode => {
    const f = await fixture(), synthetic = 'ghp_' + 'x'.repeat(36);
    vi.spyOn(publication, 'publishModernLocalCompletion').mockResolvedValue({
      ...publicationOutcome(f.root, 'committed-cleanup-pending'), cleanupFailures: [synthetic]
    });
    const result = await invoke(f.root, 'publish', ['apply-next', '--plan', fingerprint, '--execute'], jsonMode);
    expect(result.code).toBe(1); expect(result.semantic).toBe('failure');
    expect(result.stdout + result.stderr).not.toContain(synthetic);
    expect(result.stdout).toContain('was withheld');
    expect(result.stdout).toContain('"publicationCommitted": true');
    expect(result.stdout).toContain('"projectFileEffectsUncertain": true');
    expect(result.stdout).toContain('"localComplete": false');
  });
  it('reports successful explicit rollback as recovery, not local readiness or publication replay', async () => {
    const f = await fixture(), recover = vi.spyOn(publication, 'recoverModernLocalCompletion').mockResolvedValue(publicationOutcome(f.root, 'rolled-back'));
    const publish = vi.spyOn(publication, 'publishModernLocalCompletion');
    const result = await invoke(f.root, 'publish', ['recover', '--plan', fingerprint, '--execute']);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ status: 'rolled-back', operationComplete: true, localComplete: false, publicationCommitted: false });
    expect(recover).toHaveBeenCalledWith(f.root, { publicationFingerprint: fingerprint }); expect(publish).not.toHaveBeenCalled();
  });
  it.each(['finalize', 'publish'] as const)('keeps %s inspection nonexecuting even with unknown saved authority', async operation => {
    const f = await fixture(), before = await originalFiles(f.root);
    const finalize = vi.spyOn(finalization, 'finalizeModernLocalCompletion'), publish = vi.spyOn(publication, 'publishModernLocalCompletion');
    for (const flags of [[], ['--execute=false']]) {
      const result = await invoke(f.root, operation, ['apply-next', '--plan', fingerprint, ...flags]);
      expect(result.code).toBe(1);
      expect(result.report).toMatchObject({ executionRequested: false, externalMetadataWriteRequested: false, projectFileEffectsRequested: false });
    }
    expect(finalize).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(await originalFiles(f.root)).toEqual(before);
  });
  it('rejects another active publication before loading any result authority', async () => {
    const f = await fixture(), boundary = await finalization.inspectCompletionBoundary(f.root);
    vi.spyOn(finalization, 'inspectCompletionBoundary').mockResolvedValue({
      ...boundary, transaction: { ...boundary.transaction, status: 'interrupted', planFingerprint: 'b'.repeat(64), transactionDigest: 'c'.repeat(64) }
    });
    const load = vi.spyOn(finalization, 'loadFinalizationResult');
    await expect(inspection.inspectModernLocalPublication(f.root, fingerprint)).rejects.toThrow('not attributable');
    await expect(inspection.reviewModernLocalPublication(f.root, fingerprint)).rejects.toThrow('not attributable');
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects malformed consent before any authority lookup or tool dispatch', async () => {
    const f = await fixture(), file = await input(f.root, 'invalid', { kind: 'approve-manual-finalization', scopes: true });
    const load = vi.spyOn(finalization, 'readFinalizationPreview'), tools = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const result = await invoke(f.root, 'finalize', ['approve', '--plan', fingerprint, '--inputs', file]);
    expect(result.code).toBe(1); expect(result.report.externalMetadataWriteRequested).toBe(false);
    expect(load).not.toHaveBeenCalled(); expect(tools).not.toHaveBeenCalled();
  });
  it('rejects historical projects before reading public completion input or authority', async () => {
    const root = await writeModernHistoricalSource(await directory(), 3);
    const read = vi.spyOn(publicInputs, 'readPublicGovernanceInputs'), load = vi.spyOn(finalization, 'readFinalizationPreview');
    const result = await invoke(root, 'finalize', ['plan', '--inputs', 'never-read.json']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('only by modern v8');
    expect(read).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  });
});

async function baseline(workflow: 'manual' | 'spec-kit', profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow' = 'none') {
  const root = path.join(await directory(), 'Project Space'), options = { frontend: true };
  const seed = await writeModernInstalledProject(root, workflow, profile, options);
  const source = resolveModernManifestV8SourceContract({ selection: seed.input.selection, recordedPlugins: seed.input.plugins });
  const components = new Map(source.layoutDescriptor.components.map(component => [component, ['Source Space', component.replace(':', ' ')]]));
  const f = await writeModernInstalledProject(root, workflow, profile, {
    ...options, activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
      ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
      { kind: 'artifact', logicalName: 'docker-compose', pathParts: ['compose.yml'] }
    ] }
  });
  await writeModernLocalFixtureInputs(f.input.selection, components, ['compose.yml'], f.write);
  return f;
}
async function readyForPublication(workflow: 'manual' | 'spec-kit', profile: 'none' | 'single-maintainer-gitflow' | 'team-gitflow' = 'none') {
  const f = await baseline(workflow, profile), before = await originalFiles(f.root);
  const request = await input(f.root, 'verify', { kind: 'verify-local', preparation: [] });
  const consent = await input(f.root, 'verify-consent', { kind: 'approve-local-execution', scopes: executionScopes });
  const planned = await invoke(f.root, 'verify', ['plan', '--inputs', request]);
  expect(planned.code, planned.stdout + planned.stderr).toBe(0);
  const executionFingerprint = planned.report.fingerprint;
  expect((await invoke(f.root, 'verify', ['approve', '--plan', executionFingerprint, '--inputs', consent])).code).toBe(0);
  const verified = await invoke(f.root, 'verify', ['apply-next', '--plan', executionFingerprint, '--execute']);
  expect(verified.code, verified.stdout + verified.stderr).toBe(0);
  const finalizeRequest = await input(f.root, 'finalize', { kind: 'finalize-local', executionFingerprint });
  const finalPlan = await invoke(f.root, 'finalize', ['plan', '--inputs', finalizeRequest]);
  expect(finalPlan.code, finalPlan.stdout + finalPlan.stderr).toBe(0);
  const finalizationFingerprint = finalPlan.report.fingerprint, store = storage.createLocalFinalizationRecordStore(f.root);
  expect(await store.read('consent', finalizationFingerprint)).toBeNull();
  expect(await store.readState(finalizationFingerprint)).toBeNull();
  const wrongConsent = await input(f.root, 'wrong-finalize-consent', {
    kind: workflow === 'manual' ? 'approve-spec-kit-finalization' : 'approve-manual-finalization',
    scopes: { ...finalizationScopes, workflowWrites: workflow === 'manual' }
  });
  const approvalSpy = vi.spyOn(finalization, 'approveModernLocalFinalization');
  const wrong = await invoke(f.root, 'finalize', ['approve', '--plan', finalizationFingerprint, '--inputs', wrongConsent]);
  expect(wrong.code).toBe(1); expect(wrong.report.externalMetadataWriteRequested).toBe(false);
  expect(wrong.report.diagnostics.join(' ')).toContain('consent must match');
  expect(approvalSpy).not.toHaveBeenCalled(); approvalSpy.mockRestore();
  expect(await store.read('consent', finalizationFingerprint)).toBeNull();
  const finalConsent = await input(f.root, 'finalize-consent', {
    kind: workflow === 'manual' ? 'approve-manual-finalization' : 'approve-spec-kit-finalization',
    scopes: { ...finalizationScopes, workflowWrites: workflow === 'spec-kit' }
  });
  const approved = await invoke(f.root, 'finalize', ['approve', '--plan', finalizationFingerprint, '--inputs', finalConsent]);
  expect(approved.code, approved.stdout + approved.stderr).toBe(0);
  const held = await invoke(f.root, 'finalize', ['apply-next', '--plan', finalizationFingerprint]);
  expect(held.report).toMatchObject({ status: 'not-executed', localComplete: false, executionRequested: false, recordedProgressIsCurrentProof: false });
  expect(await store.readState(finalizationFingerprint)).toBeNull();
  const finalized = await invoke(f.root, 'finalize', ['apply-next', '--plan', finalizationFingerprint, '--execute']);
  expect(finalized.code, finalized.stdout + finalized.stderr).toBe(0);
  expect(finalized.report).toMatchObject({ status: 'finalized', operationComplete: true, localComplete: false, projectFileEffectsRequested: false });
  expect(await originalFiles(f.root)).toEqual(before);
  const publicationFingerprint = finalized.report.result.publicationFingerprint;
  await expect(inspection.inspectModernLocalPublication(f.root, finalizationFingerprint)).rejects.toThrow('Select the publication fingerprint');
  await expect(inspection.reviewModernLocalPublication(f.root, finalizationFingerprint)).rejects.toThrow('Select the publication fingerprint');
  const reviewRequest = await input(f.root, 'review', { kind: 'review-local-publication', publicationFingerprint });
  const reviewed = await invoke(f.root, 'publish', ['plan', '--inputs', reviewRequest]);
  expect(reviewed.code, reviewed.stdout + reviewed.stderr).toBe(0);
  expect(reviewed.report).toMatchObject({ externalMetadataWriteRequested: false, localComplete: false,
    review: { currentSourceVerified: false, publicationAuthorized: false } });
  expect(await store.read('publication-consent', publicationFingerprint)).toBeNull();
  const publicationConsent = await input(f.root, 'publish-consent', {
    kind: 'approve-local-publication', publishExactLocalBytes: true, finalizationFingerprint,
    candidateBinding: reviewed.report.review.result.candidateBinding, targetSetDigest: reviewed.report.review.result.targetSetDigest
  });
  return { ...f, before, publicationFingerprint, finalizationFingerprint, store, reviewed, publicationConsent };
}

describe('actual public modern completion', () => {
  nativeIt.each(combinations)('publishes the actual $workflow/$profile local completion', async ({ workflow, profile }) => {
    nativeCases.push(`${workflow}/${profile}`);
    const f = await readyForPublication(workflow, profile);
    const approved = await invoke(f.root, 'publish', ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent]);
    expect(approved.code, approved.stdout + approved.stderr).toBe(0);
    const tools = vi.spyOn(NodeCommandRunner.prototype, 'run');
    for (const command of ['apply-next', 'recover']) {
      const held = await invoke(f.root, 'publish', [command, '--plan', f.publicationFingerprint, '--execute=false']);
      expect(held.report).toMatchObject({ status: 'not-executed', executionRequested: false, localComplete: false, recordedProgressIsCurrentProof: false });
    }
    expect(tools).not.toHaveBeenCalled(); tools.mockRestore();
    expect(await originalFiles(f.root)).toEqual(f.before);
    const result = await invoke(f.root, 'publish', ['apply-next', '--plan', f.publicationFingerprint, '--execute']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.report).toMatchObject({ status: 'local-complete-current', localComplete: true, publicationCommitted: true,
      activationComplete: false, lifecycleComplete: false, providerOperationsAuthorized: false, result: { authority: 'local-only' } });
    const targets = new Set<string>();
    for (const file of f.reviewed.report.review.files) {
      targets.add(file.pathParts.join('/'));
      expect(await fs.readFile(path.join(f.root, ...file.pathParts))).toEqual(Buffer.from(file.content));
      expect((await fs.stat(path.join(f.root, ...file.pathParts))).mode & 0o777).toBe(file.target.mode);
    }
    const after = await originalFiles(f.root);
    for (const [name, value] of Object.entries(f.before)) if (!targets.has(name)) expect(after[name], name).toEqual(value);
    expect(Object.keys(after).filter(name => !(name in f.before)).every(name => targets.has(name))).toBe(true);
    expect((await publication.inspectModernLocalCompletion(f.root)).status).toBe('local-complete-current');
    const observed = await invoke(f.root, 'publish', ['apply-next', '--plan', f.publicationFingerprint]);
    expect(observed.report).toMatchObject({ localComplete: false, recordedProgressIsCurrentProof: false, inspection: { state: { phase: 'complete' } } });
    if (workflow === 'manual' && profile === 'none') {
      await f.write(['Source Space', 'backend', 'tests', 'after-publication.txt'], 'A later source change is not fresh proof.\n');
      const changed = await originalFiles(f.root);
      const saved = await invoke(f.root, 'publish', ['apply-next', '--plan', f.publicationFingerprint]);
      expect(saved.report).toMatchObject({ localComplete: false, recordedProgressIsCurrentProof: false, inspection: { state: { phase: 'complete' } } });
      await expect(publication.inspectModernLocalCompletion(f.root)).rejects.toThrow('changed beyond exact publication targets');
      expect(await originalFiles(f.root)).toEqual(changed);
    }
    console.info('PUBLIC_COMPLETION_ACTUAL ' + JSON.stringify({ workflow, profile, finalizationFingerprint: f.finalizationFingerprint, report: result.report }));
  }, 180000);
  nativeIt('refuses changed source before second consent without rewriting or approving it', async () => {
    nativeCases.push('stale');
    const f = await readyForPublication('spec-kit');
    await f.write(['Source Space', 'backend', 'tests', 'source.txt'], 'Changed after finalization.\n');
    const before = await originalFiles(f.root);
    const denied = await invoke(f.root, 'publish', ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent]);
    expect(denied.code).toBe(1);
    expect(await f.store.read('publication-consent', f.publicationFingerprint)).toBeNull();
    expect(await originalFiles(f.root)).toEqual(before);
  }, 180000);
  nativeIt('recovers an actual committed publication without replay after denied progress persistence', async () => {
    nativeCases.push('committed-recovery');
    const f = await readyForPublication('manual');
    expect((await invoke(f.root, 'publish', ['approve', '--plan', f.publicationFingerprint, '--inputs', f.publicationConsent])).code).toBe(0);
    const create = storage.createLocalFinalizationRecordStore;
    const fault = vi.spyOn(storage, 'createLocalFinalizationRecordStore').mockImplementation((root, options) => {
      const store = create(root, options);
      return { ...store, compareExchangeState: async (key, expected, value) => {
        if (value && typeof value === 'object' && 'phase' in value && value.phase === 'committed-readback-pending') {
          throw new Error('Explicit denied commit observation for public recovery qualification.');
        }
        return store.compareExchangeState(key, expected, value);
      } };
    });
    const interrupted = await invoke(f.root, 'publish', ['apply-next', '--plan', f.publicationFingerprint, '--execute']);
    expect(interrupted.code, interrupted.stdout).toBe(1);
    expect(interrupted.report).toMatchObject({ localComplete: false, projectFileEffectsRequested: true });
    fault.mockRestore();
    const held = await invoke(f.root, 'publish', ['recover', '--plan', f.publicationFingerprint]);
    expect(held.report).toMatchObject({ executionRequested: false, localComplete: false, inspection: { transaction: { committed: true } } });
    const recovered = await invoke(f.root, 'publish', ['recover', '--plan', f.publicationFingerprint, '--execute']);
    expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
    expect(recovered.report).toMatchObject({ localComplete: true, publicationCommitted: true, result: { status: 'local-complete-current' } });
    expect((await publication.inspectModernLocalCompletion(f.root)).status).toBe('local-complete-current');
  }, 180000);
});
