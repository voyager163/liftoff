import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  inspectModernInstalledActivation, validateCapturedModernInstalledActivation,
  validateCapturedModernMaintenanceSource, validateCapturedModernSuccessorSource
} from '../src/application/governance/modern-installed-preflight.js';
import { previewModernSuccessorUpdate, applyModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import type { InstalledLocalSnapshot } from '../src/domain/governance/activation/modern-local-runtime.js';
import { activationTargetHistoryPathParts } from '../src/domain/project/manifest/activation-target-history.js';
import { fixture, inventory, write, approval } from './fixtures/manifest-update.js';
import { writeModernSuccessor, writePriorRepairOriginalTarget } from './fixtures/modern-installed-project.js';

const journalPath = ['governance', 'migration-state.json'];

async function project(version: 1 | 2 | 3 = 3, retained = false, nested = false) {
  const owned = await fixture();
  const successor = await writeModernSuccessor(owned.root, version, retained, nested);
  return { ...owned, successor };
}

async function capture(root: string) {
  const installed = await inspectModernInstalledActivation(root);
  if (installed.status !== 'observed') throw new Error(installed.blockers.join('; '));
  return installed;
}

function replaceFile(snapshot: InstalledLocalSnapshot, parts: readonly string[], bytes: Buffer): InstalledLocalSnapshot {
  const name = parts.join('/');
  if (!snapshot.files.some(file => file.pathParts.join('/') === name)) throw new Error('Missing captured fixture input.');
  return {
    ...snapshot,
    files: snapshot.files.map(file => file.pathParts.join('/') !== name ? file : {
      ...file, content: bytes.toString('base64'), bytes: bytes.length, digest: rawLocalDigest(bytes)
    })
  };
}

describe('independently reconstructed modern successor revalidation source', () => {
  it.each([1, 2, 3] as const)('exposes actual v%s continuity without changing the existing installed observation or granting execution', async version => {
    const f = await project(version), before = await inventory(f.root), home = await inventory(f.home);
    const installed = await capture(f.root), original = structuredClone(installed);
    const source = await validateCapturedModernSuccessorSource(installed.snapshot);
    expect(source.kind).toBe('liftoff-modern-successor-source');
    expect(source.journal).toEqual(f.successor.prepared.journal);
    expect(source.journal.semanticInput.laneId).toBe(`activation-v${version}-to-v4`);
    expect(source.journal.revalidation.phases.map(phase => [phase.phaseId, phase.status])).toEqual([
      ['local-inputs-valid', 'pending'], ['local-baseline-verified', 'pending'], ['local-complete', 'pending']
    ]);
    expect(source.current).toEqual(installed.current);
    expect(source.execution).toBe('not-authorized');
    expect(source.publication).toBe('not-authorized');
    expect(source.binding).toBe(canonicalSha256({ kind: source.kind, installedBinding: installed.binding }));
    expect(await validateCapturedModernInstalledActivation(installed.snapshot)).toEqual(original);
    expect(installed).toEqual(original);
    expect(await inventory(f.root)).toEqual(before);
    expect(await inventory(f.home)).toEqual(home);
  });

  it.each(['retained', 'nested'] as const)('preserves %s historical obligations without reading protected payloads', async kind => {
    const f = await project(2, kind === 'retained', kind === 'nested');
    if (kind === 'retained') {
      await write(f.root, ['protected', 'state.enc'], 'not a state-reader grant');
      await write(f.root, ['protected', 'key'], 'not a key-reader grant');
    }
    const before = await inventory(f.root), installed = await capture(f.root);
    const source = await validateCapturedModernSuccessorSource(installed.snapshot);
    expect(source.retention).toEqual(installed.retention);
    if (kind === 'retained') {
      expect(source.retention).toMatchObject([{
        retainedAt: '2026-08-01T00:00:00.000Z', disposeAfter: '2026-08-31T00:00:00.000Z',
        authority: 'preservation-only', protectedPaths: [['protected', 'state.enc'], ['protected', 'key']]
      }]);
      expect(source.snapshot.files.some(file => file.pathParts[0] === 'protected')).toBe(false);
    } else {
      expect(source.snapshot.files.filter(file =>
        file.pathParts[0] === 'governance' && file.pathParts[1] === 'history' && file.pathParts.at(-1) === 'index.json').length).toBeGreaterThan(1);
    }
    expect(await inventory(f.root)).toEqual(before);
  });

  it.each(['digest', 'self-consistent-digest', 'anchor', 'preparation', 'complete-without-proof'] as const)(
    'refuses %s journal claims even when the captured raw digest is internally consistent', async change => {
      const f = await project(), installed = await capture(f.root);
      const journal = structuredClone(f.successor.prepared.journal);
      const tampered = change === 'digest' || change === 'self-consistent-digest'
        ? { ...journal, semanticInput: { ...journal.semanticInput, targetManifestDigest: 'a'.repeat(64) } }
        : change === 'anchor'
          ? { ...journal, preparation: { ...journal.preparation, localRepositoryId: 'local:33333333-3333-4333-8333-333333333333' },
            successor: { ...journal.successor, repositoryId: 'local:33333333-3333-4333-8333-333333333333' } }
          : change === 'preparation'
            ? { ...journal, preparation: { ...journal.preparation, preparedAt: '2026-09-01T11:00:00.000Z' },
              successor: { ...journal.successor, createdAt: '2026-09-01T11:00:00.000Z' } }
            : { ...journal, revalidation: { ...journal.revalidation, status: 'complete', nextAction: null,
              phases: journal.revalidation.phases.map(phase => ({ ...phase, status: 'complete', evidenceIds: ['invented-proof'] })) } };
      if (change === 'self-consistent-digest') tampered.semanticTransitionDigest = canonicalSha256(tampered.semanticInput);
      const snapshot = replaceFile(installed.snapshot, journalPath, Buffer.from(canonicalJson(tampered)));
      await expect(validateCapturedModernSuccessorSource(snapshot)).rejects.toThrow(
        /semantic T|constructed successor|preparation anchor|same-phase state\/header/
      );
    }
  );

  it('does not accept maintenance-only core drift as a revalidation source', async () => {
    const f = await project(), installed = await capture(f.root);
    const artifact = f.successor.plan.manifest.manifest.managedArtifacts[0];
    const snapshot = replaceFile(installed.snapshot, artifact.pathParts, Buffer.from('changed owned core'));
    expect((await validateCapturedModernMaintenanceSource(snapshot)).kind).toBe('liftoff-modern-maintenance-source');
    await expect(validateCapturedModernSuccessorSource(snapshot)).rejects.toThrow(/exact source bytes/);
  });

  it('does not manufacture a successor from a valid fresh v8 boundary', async () => {
    const f = await project();
    const manifest = f.successor.plan.manifest.manifest;
    const { sourceManifestHistory: _history, ...fresh } = manifest;
    await fs.unlink(path.join(f.root, 'governance', 'activation-state.json'));
    await fs.unlink(path.join(f.root, ...journalPath));
    await write(f.root, ['liftoff.manifest.json'], canonicalJson(fresh));
    const installed = await capture(f.root);
    expect(installed.classification).toBe('fresh');
    await expect(validateCapturedModernSuccessorSource(installed.snapshot)).rejects.toThrow(/installed activation successor/);
  });

  it('rejects accessors without evaluating them and isolates the captured caller values', async () => {
    const f = await project(), installed = await capture(f.root), before = structuredClone(installed.snapshot);
    const getter = vi.fn(() => installed.snapshot.files);
    const accessor = Object.defineProperty({ ...installed.snapshot }, 'files', { enumerable: true, get: getter });
    await expect(validateCapturedModernSuccessorSource(accessor)).rejects.toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled();
    const pending = validateCapturedModernSuccessorSource(installed.snapshot);
    Reflect.set(installed.snapshot.files[0], 'content', 'changed after invocation');
    expect((await pending).snapshot).toEqual(before);
  });

  it('retains the original T and preparation after actual approved metadata maintenance and rejects a damaged original copy', async () => {
    const f = await project();
    await writePriorRepairOriginalTarget(f.successor, 'Previously recorded repair integration.\r\n');
    const originalJournal = await fs.readFile(path.join(f.root, ...journalPath));
    const { selection, plugins, activeLayout } = f.successor.plan.target;
    const target = { selection, plugins, activeLayout };
    const preview = await previewModernSuccessorUpdate(f.root, target, f.options);
    const variant = preview.receipt.variants.find(entry => entry.mode === 'normal');
    if (!variant) throw new Error('Expected exact eligible maintenance review.');
    const applied = await applyModernSuccessorUpdate({
      projectRoot: f.root, selection: target, force: false, approvePlan: variant.fingerprint
    }, approval(), f.options);
    expect(applied.status).toBe('committed-incomplete');
    const installed = await capture(f.root), source = await validateCapturedModernSuccessorSource(installed.snapshot);
    expect(source.journal).toEqual(JSON.parse(originalJournal.toString('utf8')));
    expect(source.manifest.activationTargetHistory).toBeDefined();
    const currentManifest = installed.snapshot.files.find(file => file.pathParts.join('/') === 'liftoff.manifest.json')!;
    expect(source.journal.semanticInput.targetManifestDigest).not.toBe(currentManifest.digest);
    const copyPath = activationTargetHistoryPathParts(source.manifest.activationTargetHistory!);
    const damaged = replaceFile(installed.snapshot, copyPath, Buffer.from('damaged original target'));
    await expect(validateCapturedModernSuccessorSource(damaged)).rejects.toThrow(/Preserved original activation target/);
  });
});
