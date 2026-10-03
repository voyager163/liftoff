import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { applyModernSuccessorUpdate, previewModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { inspectModernSuccessorUpdate } from '../src/application/update/inspection.js';
import { prepareModernSuccessorReview } from '../src/application/update/review-plan.js';
import { collectStandaloneManifestHistoryInput } from '../src/application/update/manifest-history-capture.js';
import { prepareStandaloneManifestHistory } from '../src/application/update/manifest-history.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { manifestHistoryPaths } from '../src/domain/project/manifest/history.js';
import { rawHistoryDigest } from '../src/governance-activation/history-contracts.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { reviewedJournalLimits } from '../src/adapters/filesystem/reviewed-update-journal.js';
import { approval, auditFor, fixture, inventory, now, write } from './fixtures/manifest-update.js';

describe('actual manifest-only successor publication', () => {
  it.each(['0.3.4', '0.4.1', '0.7.0', '0.8.0', '0.9.9', '0.10.0', '0.11.3', '0.12.3'])(
    'preserves the original %s manifest and application without inventing activation records', async version => {
      const project = await fixture(version), before = await inventory(project.root);
      const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
      expect(preview.scope).toBe('history-core-manifest-publication-only');
      expect(await inventory(project.root)).toEqual(before);
      const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
      expect(inspection.kind).toBe('manifest-successor');
      expect(inspection.sourceRepositoryId).toBeNull();
      const review = await prepareModernSuccessorReview(inspection, false, preview.receipt.publication.preparation, now);
      expect(review.descriptor).toEqual(preview.receipt.variants[0]);
      expect(review.mutations.at(-1)?.pathParts).toEqual(['liftoff.manifest.json']);
      expect(review.mutations.some(mutation => /(?:activation|migration)-state\.json$/u.test(mutation.pathParts.join('/')))).toBe(false);
      const outcome = await applyModernSuccessorUpdate({
        projectRoot: project.root, selection: project.selection, force: false,
        approvePlan: preview.receipt.variants[0].fingerprint
      }, approval(), project.options);
      expect(outcome.status).toBe('committed-incomplete');
      const current = JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'));
      expect(current.artifactVersion).toBe(8);
      expect(current.project).toEqual(project.manifest.project);
      expect(current.framework).toEqual(project.manifest.framework);
      expect(current.projectArtifacts).toEqual(project.manifest.projectArtifacts);
      expect(current.activeLayout).toEqual({ schemaVersion: 1, state: 'unresolved', bindings: [] });
      expect(current.sourceManifestHistory.kind).toBe('manifest-history');
      const paths = manifestHistoryPaths(current.sourceManifestHistory);
      expect(await fs.readFile(path.join(project.root, ...paths.manifestPathParts))).toEqual(project.original);
      const index = JSON.parse(await fs.readFile(path.join(project.root, ...paths.indexPathParts), 'utf8'));
      expect(index.source.mode).toBe(before['liftoff.manifest.json'].mode);
      expect(index.source.digest).toBe(rawHistoryDigest(project.original));
      const after = await inventory(project.root);
      expect(after['application.txt']).toEqual(before['application.txt']);
      expect(after['package.json']).toEqual(before['package.json']);
      expect(after['governance/activation-state.json']).toBeUndefined();
      expect(after['governance/migration-state.json']).toBeUndefined();
      expect(JSON.stringify(current)).not.toContain(preview.receipt.receiptId);
      expect(JSON.stringify(current)).not.toContain(preview.receipt.publication.preparation.localRepositoryId);
      expect((await auditFor(project, preview))?.audit.planFingerprint).toBe(preview.receipt.variants[0].fingerprint);
    }
  );

  it('preserves legacy framework uncertainty and explicitly selected governance none', async () => {
    const project = await fixture('0.3.4', 'none');
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), project.options)).toMatchObject({ status: 'committed-incomplete', committed: true });
    const current = JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'));
    expect(current.framework.state).toBe('legacy');
    expect(current.project.agents).toEqual([]);
    expect(current.governance).toEqual({ profile: 'none', state: 'disabled' });
    expect(Object.keys(await inventory(project.root)).some(name => name.startsWith('governance/'))).toBe(false);
  });

  it.each(['required', 'declined', 'mismatch'] as const)('does not publish or retain approval when consent is %s', async status => {
    const project = await fixture(), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const before = await inventory(project.root);
    const result = await applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false,
      ...(status === 'mismatch' ? { approvePlan: 'f'.repeat(64) } : {})
    }, approval(status === 'declined' ? async () => false : undefined), project.options);
    expect(result).toMatchObject({ status: 'approval-blocked', approval: { status } });
    expect(await inventory(project.root)).toEqual(before);
    expect(await auditFor(project, preview)).toBeNull();
  });

  it.each(['before', 'during'] as const)('preserves a source edit %s approval and refuses the stale candidate', async timing => {
    const project = await fixture(), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const file = path.join(project.root, 'liftoff.manifest.json');
    let before = await inventory(project.root), calls = 0;
    if (timing === 'before') { await fs.appendFile(file, '\r\n'); before = await inventory(project.root); }
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false
    }, approval(async () => {
      calls++; await fs.appendFile(file, '\r\n'); before = await inventory(project.root); return true;
    }), project.options)).rejects.toThrow(/changed|differs/u);
    expect(calls).toBe(timing === 'before' ? 0 : 1);
    expect(await inventory(project.root)).toEqual(before);
    expect(Boolean(await auditFor(project, preview))).toBe(timing === 'during');
  });

  it.each([
    ['governance', 'migration-state.json'], ['governance', 'activation-baseline.json'],
    ['governance', 'credentials', 'preflight-policy.json'],
    ...['plans', 'evidence', 'approvals', 'supersessions', 'reconciliation'].map(name => ['governance', name, 'orphan.json'])
  ].map(pathParts => ({ pathParts })))('refuses orphaned control records at $pathParts without parsing their contents', async ({ pathParts }) => {
    const project = await fixture();
    await write(project.root, pathParts, 'Malformed orphan: do not infer an unstarted activation.\n');
    const before = await inventory(project.root);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/manifest-only/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await fs.readdir(project.home)).toEqual([]);
  });

  it.each(['partial', 'changed'] as const)('preserves and refuses %s pre-existing source history', async kind => {
    const project = await fixture();
    const history = prepareStandaloneManifestHistory(await collectStandaloneManifestHistoryInput(project.root));
    const paths = manifestHistoryPaths(history.reference);
    await write(project.root, paths.indexPathParts, history.indexBytes);
    if (kind === 'changed') await write(project.root, paths.manifestPathParts, Buffer.concat([project.original, Buffer.from('\n')]));
    const before = await inventory(project.root);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/history/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await fs.readdir(project.home)).toEqual([]);
  });

  it('reuses completed exact source history without rewriting its bytes or modes', async () => {
    const project = await fixture();
    const history = prepareStandaloneManifestHistory(await collectStandaloneManifestHistoryInput(project.root));
    for (const mutation of history.preservationWrites) {
      if (mutation.type !== 'write') throw new Error('Expected preservation bytes.');
      await write(project.root, mutation.pathParts, mutation.content);
    }
    const before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), project.options)).toMatchObject({ committed: true });
    const after = await inventory(project.root);
    for (const name of Object.keys(before).filter(name => name.startsWith('.liftoff/manifest-history/'))) {
      expect(after[name]).toEqual(before[name]);
    }
  });

  it('never obtains ownership of a conflicting unrecorded managed destination through force', async () => {
    const project = await fixture('0.3.4');
    const artifact = buildModernManagedCore(project.selection)[0];
    await write(project.root, artifact.pathParts, 'Existing unowned integration.\n');
    const before = await inventory(project.root);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/unowned/u);
    expect(await inventory(project.root)).toEqual(before);
    expect(await fs.readdir(project.home)).toEqual([]);
  });

  it('rolls back an attributable precommit failure while retaining truthful approval', async () => {
    const project = await fixture(), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'before-commit') throw new Error('Injected before-commit failure.');
    } })).rejects.toThrow(/All attributable changes were rolled back/u);
    expect(await inventory(project.root)).toEqual(before);
    expect(await auditFor(project, preview)).not.toBeNull();
  });

  it('copies all review inputs before asynchronous transaction admission', async () => {
    const project = await fixture(), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    if (inspection.kind !== 'manifest-successor') throw new Error('Expected actual manifest-only source.');
    const pending = prepareModernSuccessorReview(inspection, false, preview.receipt.publication.preparation, now);
    inspection.source.sourceBinding = 'f'.repeat(64);
    inspection.historyInput.sourceManifest.content.fill(0);
    inspection.snapshots.splice(0);
    expect((await pending).descriptor).toEqual(preview.receipt.variants[0]);
  });

  it.each(['project', 'framework', 'plugins', 'manifest', 'transition'] as const)(
    'refuses a changed captured %s when reconstructing the prepared candidate', async changed => {
      const project = await fixture(), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
      const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
      if (inspection.kind !== 'manifest-successor') throw new Error('Expected actual manifest-only source.');
      const before = await inventory(project.root);
      if (changed === 'project') Object.assign(inspection.target.selection.project, { name: 'Changed project' });
      else if (changed === 'framework') Object.assign(inspection.target.selection, { framework: { state: 'legacy' } });
      else if (changed === 'plugins') Object.assign(inspection.target.plugins, { resolutionDigest: `sha256:${'f'.repeat(64)}` });
      else if (changed === 'manifest') inspection.successorPlan.manifest = { ...inspection.successorPlan.manifest, content: '{}\n' };
      else inspection.successorPlan.semanticTransitionDigest = `sha256:${'f'.repeat(64)}`;
      await expect(prepareModernSuccessorReview(
        inspection, false, preview.receipt.publication.preparation, now
      )).rejects.toThrow(/cannot change|plugins differ|changed after/iu);
      expect(await inventory(project.root)).toEqual(before);
      expect(await auditFor(project, preview)).toBeNull();
    }
  );

  it('rejects an oversized complete transaction before persisting preparation', async () => {
    const project = await fixture();
    await fs.writeFile(path.join(project.root, 'liftoff.manifest.json'), Buffer.concat([
      Buffer.alloc(reviewedJournalLimits.fileBytes - project.original.length, 0x20), project.original
    ]));
    const before = await inventory(project.root);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/limit|MiB|bytes/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await fs.readdir(project.home)).toEqual([]);
  });

  it.each([1024, 1025])('bounds complete collection enumeration at %i non-record entries', async count => {
    const project = await fixture('0.3.4', 'none');
    const directory = path.join(project.root, 'governance', 'plans');
    await fs.mkdir(directory, { recursive: true });
    for (let index = 0; index < count; index++) await fs.writeFile(path.join(directory, `${index}.txt`), 'Unowned note.\n');
    const before = await inventory(project.root);
    const pending = previewModernSuccessorUpdate(project.root, project.selection, project.options);
    if (count === 1024) expect((await pending).scope).toBe('history-core-manifest-publication-only');
    else {
      await expect(pending).rejects.toThrow(/1024 entry/u);
      expect(await fs.readdir(project.home)).toEqual([]);
    }
    expect(await inventory(project.root)).toEqual(before);
  });

  it('refuses newly orphaned records created during the approval prompt', async () => {
    const project = await fixture(), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    let before = await inventory(project.root);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false
    }, approval(async () => {
      await write(project.root, ['governance', 'evidence', 'new.json'], 'Independently created bytes.\n');
      before = await inventory(project.root); return true;
    }), project.options)).rejects.toThrow(/orphaned/u);
    expect(await inventory(project.root)).toEqual(before);
    expect(await auditFor(project, preview)).not.toBeNull();
  });

  it.each(['project', 'profile', 'workflow'] as const)('does not use metadata migration to switch %s intent', async kind => {
    const project = await fixture();
    const selection = structuredClone(project.selection);
    if (kind === 'project') Object.assign(selection.selection.project, { name: `${selection.selection.project.name} changed` });
    else if (kind === 'profile') Object.assign(selection.selection, { profile: 'none' });
    else Object.assign(selection.selection, {
      project: { ...selection.selection.project, specWorkflow: 'manual', agents: [] }, framework: { state: 'not-required' }
    });
    const before = await inventory(project.root);
    await expect(previewModernSuccessorUpdate(project.root, selection, project.options)).rejects.toThrow(/cannot change/u);
    expect(await inventory(project.root)).toEqual(before);
    expect(await fs.readdir(project.home)).toEqual([]);
  });

  it('preserves damage introduced into the source copy and refuses final manifest replacement', async () => {
    const project = await fixture(), before = await inventory(project.root);
    const history = prepareStandaloneManifestHistory(await collectStandaloneManifestHistoryInput(project.root));
    const paths = manifestHistoryPaths(history.reference);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'after-mutation' && checkpoint.index === 1) {
        await fs.appendFile(path.join(project.root, ...paths.manifestPathParts), 'Changed after preservation.\n');
      }
    } })).rejects.toThrow(/history|copy|Recovery incomplete/iu);
    expect(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.original);
    expect(await fs.readFile(path.join(project.root, ...paths.manifestPathParts), 'utf8')).toContain('Changed after preservation.');
    expect((await inventory(project.root))['application.txt']).toEqual(before['application.txt']);
    expect(await auditFor(project, preview)).not.toBeNull();
  });

  it.each([
    ['governance', 'activation-state.json'],
    ['governance', 'evidence', 'new.json']
  ].map(pathParts => ({ pathParts })))(
    'refuses final manifest replacement after unrelated $pathParts appears during preservation', async ({ pathParts }) => {
      const project = await fixture(), before = await inventory(project.root);
      const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
      const added = 'Independently created control bytes; do not interpret or remove.\n';
      await expect(applyModernSuccessorUpdate({
        projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
      }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
        if (checkpoint.phase === 'after-mutation' && checkpoint.index === 1) await write(project.root, pathParts, added);
      } })).rejects.toThrow(/manifest-only|orphaned|target changed after review/iu);
      expect(await fs.readFile(path.join(project.root, ...pathParts), 'utf8')).toBe(added);
      expect(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.original);
      expect((await inventory(project.root))['application.txt']).toEqual(before['application.txt']);
      expect(await auditFor(project, preview)).not.toBeNull();
    }
  );

  it.each(['after-mutation', 'committed'] as const)('recovers actual process interruption at %s without inventing activation', async phase => {
    const project = await fixture(), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const request = {
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    };
    const child = spawnSync(process.execPath, [
      '--import', new URL('./fixtures/source-typescript-loader.mjs', import.meta.url).href,
      '--input-type=module', '-e', `
        const { applyModernSuccessorUpdate } = await import(${JSON.stringify(new URL('../src/application/update/use-case.ts', import.meta.url).href)});
        await applyModernSuccessorUpdate(${JSON.stringify(request)}, { stderr: process.stderr }, {
          env: {}, homedir: ${JSON.stringify(project.home)}, clock: () => new Date(${JSON.stringify(now)}),
          onCheckpoint: async checkpoint => {
            if (checkpoint.phase === ${JSON.stringify(phase)} &&
              (${JSON.stringify(phase)} !== 'after-mutation' || checkpoint.index === 0)) process.exit(73);
          }
        });
        process.exitCode = 9;
      `
    ], { encoding: 'utf8', timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(73);
    const lock = await projectMutationLockPath(project.root), lockBytes = await fs.readFile(lock);
    expect(JSON.parse(lockBytes.toString('utf8')).pid).toBe(child.pid);
    const interrupted = await inventory(project.root);
    await expect(applyModernSuccessorUpdate(request, approval(), project.options)).rejects.toThrow(/lock/iu);
    expect(await inventory(project.root)).toEqual(interrupted);
    expect(await fs.readFile(lock)).toEqual(lockBytes);
    // The exact stopped child is reaped; this is test-owned recovery preparation, not production lock reaping.
    await fs.unlink(lock);
    expect(await applyModernSuccessorUpdate(request, approval(), project.options)).toMatchObject({
      status: 'recovered', requiresFreshPreview: true, outcome: { rollbackFailures: [], cleanupFailures: [] }
    });
    const after = await inventory(project.root);
    expect(after['governance/activation-state.json']).toBeUndefined();
    expect(after['governance/migration-state.json']).toBeUndefined();
    if (phase === 'after-mutation') expect(after).toEqual(before);
    else {
      expect(JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8')).artifactVersion).toBe(8);
      expect(after['application.txt']).toEqual(before['application.txt']);
    }
  });

  it('refuses a late orphan before commit and preserves the unrelated record', async () => {
    const project = await fixture(), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const parts = ['governance', 'evidence', 'late.json'];
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'before-commit') await write(project.root, parts, 'Independent late record.\n');
    } })).rejects.toThrow(/orphaned/iu);
    expect(await fs.readFile(path.join(project.root, ...parts), 'utf8')).toBe('Independent late record.\n');
    const after = await inventory(project.root); delete after[parts.join('/')];
    expect(after).toEqual(before);
    expect(await auditFor(project, preview)).not.toBeNull();
  });
});
