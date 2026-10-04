import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { applyModernSuccessorUpdate, previewModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { inspectModernSuccessorUpdate } from '../src/application/update/inspection.js';
import { prepareModernSuccessorReview } from '../src/application/update/review-plan.js';
import { readCurrentManifestMaintenanceSource, manifestOnlyAbsentControlPaths } from '../src/application/update/manifest-maintenance.js';
import { buildModernManagedCore, type ModernManagedCoreInput } from '../src/application/project/modern-managed-core.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { manifestHistoryPaths } from '../src/domain/project/manifest/history.js';
import { rawHistoryDigest } from '../src/governance-activation/history-contracts.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { approval, auditFor, fixture, freshManifestFixture as fresh, inventory, now, write } from './fixtures/manifest-update.js';

const contracts = { catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract };
const reader = createManifestV8Reader(contracts), contexts = createModernGovernanceContextContract(contracts);
async function currentManifest(root: string) {
  return reader.parseManifestV8(JSON.parse(await fs.readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')));
}

async function historical(version = '0.12.3') {
  const project = await fixture(version);
  const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
  expect(await applyModernSuccessorUpdate({
    projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
  }, approval(), project.options)).toMatchObject({ status: 'committed-incomplete', committed: true });
  return { ...project, current: await currentManifest(project.root) };
}

type CurrentProject = Awaited<ReturnType<typeof historical>>;
function repairArtifact(project: CurrentProject) {
  const artifact = buildModernManagedCore(project.selection).find(entry => entry.logicalName.includes('repair'));
  if (!artifact) throw new Error('Expected an actual selected repair integration.');
  return artifact;
}
async function removeCore(project: CurrentProject) {
  const artifact = repairArtifact(project);
  await fs.unlink(path.join(project.root, ...artifact.pathParts));
  return artifact;
}
async function apply(project: CurrentProject, preview: Awaited<ReturnType<typeof previewModernSuccessorUpdate>>, force = false) {
  const variant = preview.receipt.variants.find(variant => variant.mode === (force ? 'force' : 'normal'));
  if (!variant) throw new Error('Expected eligible fixture variant.');
  return applyModernSuccessorUpdate({
    projectRoot: project.root, selection: project.selection, force, approvePlan: variant.fingerprint
  }, approval(), project.options);
}

describe('actual current-v8 maintenance without activation', () => {
  it.each(['0.3.4', '0.9.9', '0.12.3'])('leaves a current successor of %s untouched without duplicate history or approval', async version => {
    const project = await historical(version);
    const file = path.join(project.root, 'liftoff.manifest.json');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll('\n', '\r\n') + '\r\n');
    const before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(preview.scope).toBe('core-manifest-maintenance-only');
    expect(preview.plans.every(plan => plan.writeCount === 0)).toBe(true);
    const home = await inventory(project.home);
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false
    }, approval(async () => { throw new Error('No-op must not request approval.'); }), project.options))
      .toEqual({ status: 'current', committed: false, revalidation: 'not-required-no-activation' });
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
    expect(await auditFor(project, preview)).toBeNull();
  });

  it.each(['none', 'single-maintainer-gitflow', 'team-gitflow'].flatMap(profile =>
    ['manual', 'openspec', 'spec-kit'].map(workflow => ({ profile, workflow }))
  ))('recognizes fresh $profile/$workflow metadata without starting activation', async ({ profile, workflow }) => {
    if (profile !== 'none' && profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') throw new Error('Invalid fixture profile.');
    if (workflow !== 'manual' && workflow !== 'openspec' && workflow !== 'spec-kit') throw new Error('Invalid fixture workflow.');
    const project = await fresh(profile, workflow), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect((await apply(project, preview)).status).toBe('current');
    expect(await inventory(project.root)).toEqual(before);
    expect(project.current.sourceManifestHistory).toBeUndefined();
    expect((await currentManifest(project.root)).activeLayout).toEqual(project.current.activeLayout);
    expect(await auditFor(project, preview)).toBeNull();
  });

  it('restores missing owned core without rewriting the manifest, history or application', async () => {
    const project = await historical(), artifact = await removeCore(project), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    const review = await prepareModernSuccessorReview(inspection, false, preview.receipt.publication.preparation, now);
    expect(review.mutations.map(mutation => mutation.pathParts)).toEqual([[...artifact.pathParts]]);
    expect(await apply(project, preview)).toMatchObject({ status: 'committed', committed: true, revalidation: 'not-required-no-activation' });
    const after = await inventory(project.root);
    for (const [name, value] of Object.entries(before)) expect(after[name]).toEqual(value);
    expect(await fs.readFile(path.join(project.root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
    expect(Object.keys(after).some(name => /(?:activation|migration)-state\.json$/u.test(name))).toBe(false);
  });

  it('requires an exact force variant for edited owned core and preserves history', async () => {
    const project = await historical(), artifact = repairArtifact(project);
    await write(project.root, artifact.pathParts, 'Locally modified owned integration.\n');
    const before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(preview.plans.map(plan => plan.mode)).toEqual(['force']);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), project.options)).rejects.toThrow(/conflict/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await apply(project, preview, true)).toMatchObject({ status: 'committed', committed: true });
    expect(await fs.readFile(path.join(project.root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
  });

  it('updates prior recorded core bytes and their hash while preserving original project history', async () => {
    const project = await historical(), artifact = repairArtifact(project);
    const manifestPath = path.join(project.root, 'liftoff.manifest.json');
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const prior = 'Previously recorded owned integration.\r\n';
    const owned = raw.managedArtifacts.find((entry: { logicalName: string }) => entry.logicalName === artifact.logicalName);
    owned.contentHash = `sha256:${rawHistoryDigest(Buffer.from(prior))}`;
    await write(project.root, artifact.pathParts, prior);
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2) + '\n');
    const before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(await apply(project, preview)).toMatchObject({ status: 'committed', committed: true });
    const current = await currentManifest(project.root), after = await inventory(project.root);
    expect(current.managedArtifacts.find(entry => entry.logicalName === artifact.logicalName)?.contentHash)
      .toBe(`sha256:${rawHistoryDigest(Buffer.from(artifact.content))}`);
    expect(current.sourceManifestHistory).toEqual(project.current.sourceManifestHistory);
    expect(current.projectArtifacts).toEqual(project.current.projectArtifacts);
    expect(current.adoptionObservations).toEqual(project.current.adoptionObservations);
    for (const name of Object.keys(before).filter(name => name.startsWith('.liftoff/manifest-history/'))) expect(after[name]).toEqual(before[name]);
    expect(after['application.txt']).toEqual(before['application.txt']);
    expect((await apply(project, await previewModernSuccessorUpdate(project.root, project.selection, project.options))).status).toBe('current');
  });

  it('normalizes compatible binding and environment order instead of proposing a layout change', async () => {
    const project = await fresh('team-gitflow', 'openspec');
    const selected = structuredClone(project.selection);
    Object.assign(selected, { activeLayout: { ...selected.activeLayout, bindings: [...selected.activeLayout.bindings].reverse() } });
    Object.assign(selected.selection.project.workload, { environments: [...selected.selection.project.workload.environments].reverse() });
    const before = await inventory(project.root);
    const original = await inspectModernSuccessorUpdate(project.root, project.selection);
    const reordered = await inspectModernSuccessorUpdate(project.root, selected);
    expect(reordered.successorPlan.manifest.content).toBe(original.successorPlan.manifest.content);
    expect(reordered.successorPlan.semanticTransitionDigest).toBe(original.successorPlan.semanticTransitionDigest);
    expect(await inventory(project.root)).toEqual(before);
  });

  it.each(['identical', 'conflicting'] as const)('handles an unowned %s destination without a force ownership bypass', async disposition => {
    const project = await historical(), artifact = repairArtifact(project);
    const file = path.join(project.root, 'liftoff.manifest.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.managedArtifacts = raw.managedArtifacts.filter((entry: { logicalName: string }) => entry.logicalName !== artifact.logicalName);
    const source = resolveModernManifestV8SourceContract({ selection: project.selection.selection, recordedPlugins: project.selection.plugins });
    raw.governance.state = source.requiredHandoffLogicalNames.every(name =>
      raw.managedArtifacts.some((entry: { logicalName: string }) => entry.logicalName === name)) ? 'handoff-generated' : 'handoff-partial';
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    await currentManifest(project.root);
    if (disposition === 'conflicting') await write(project.root, artifact.pathParts, 'Unowned integration; preserve me.\n');
    const before = await inventory(project.root), home = await inventory(project.home);
    if (disposition === 'conflicting') {
      await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/unowned/iu);
      expect(await inventory(project.root)).toEqual(before);
      expect(await inventory(project.home)).toEqual(home);
      return;
    }
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const review = await prepareModernSuccessorReview(
      await inspectModernSuccessorUpdate(project.root, project.selection), false, preview.receipt.publication.preparation, now
    );
    expect(review.mutations.map(mutation => mutation.pathParts)).toEqual([['liftoff.manifest.json']]);
    expect(await apply(project, preview)).toMatchObject({ status: 'committed', committed: true });
    expect((await inventory(project.root))[artifact.pathParts.join('/')]).toEqual(before[artifact.pathParts.join('/')]);
    expect((await currentManifest(project.root)).managedArtifacts.some(entry => entry.logicalName === artifact.logicalName)).toBe(true);
  });

  it.each(['project', 'profile', 'plugins', 'layout', 'framework'] as const)('refuses a %s change through ordinary current maintenance', async field => {
    const project = await historical(), selected = structuredClone(project.selection);
    if (field === 'project') Object.assign(selected.selection.project, { name: 'Different project' });
    else if (field === 'profile') Object.assign(selected.selection, { profile: 'none' });
    else if (field === 'plugins') Object.assign(selected.plugins, { resolutionDigest: `sha256:${'f'.repeat(64)}` });
    else if (field === 'layout') Object.assign(selected, { activeLayout: { schemaVersion: 1, state: 'bound',
      bindings: [{ kind: 'component', component: 'backend', pathParts: ['custom', 'existing-api'] }] } });
    else Object.assign(selected.selection.framework, { contractVersion: '0.0.0' });
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, selected, project.options)).rejects.toThrow();
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it('preserves compatible custom bindings and original provenance while updating only core', async () => {
    const project = await historical();
    const activeLayout = { schemaVersion: 1 as const, state: 'bound' as const,
      bindings: [{ kind: 'component' as const, component: 'backend' as const, pathParts: ['custom', 'existing-api'] }] };
    Object.assign(project.selection, { activeLayout });
    const file = path.join(project.root, 'liftoff.manifest.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.activeLayout = activeLayout;
    const context = contexts.buildModernGovernanceContext(project.selection);
    raw.governance.activationIdentity = context.governance.activationIdentity;
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    await currentManifest(project.root);
    await write(project.root, ['custom', 'existing-api', 'user-code.txt'], 'Existing custom application.\n');
    const before = await inventory(project.root), originalLayout = structuredClone(activeLayout);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(await apply(project, preview)).toMatchObject({ status: 'committed', committed: true });
    const current = await currentManifest(project.root), after = await inventory(project.root);
    expect(current.activeLayout).toEqual(originalLayout);
    expect(current.projectArtifacts).toEqual(project.current.projectArtifacts);
    expect(current.adoptionObservations).toEqual(project.current.adoptionObservations);
    expect(after['custom/existing-api/user-code.txt']).toEqual(before['custom/existing-api/user-code.txt']);
    expect(after['application.txt']).toEqual(before['application.txt']);
  });

  it.each(['project', 'framework', 'projectArtifacts'] as const)('refuses current %s that contradicts preserved history', async field => {
    const project = await historical(), file = path.join(project.root, 'liftoff.manifest.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (field === 'project') raw.project.name = 'Different recorded project';
    else if (field === 'framework') raw.framework.contractVersion = '99.0.0';
    else raw.projectArtifacts[0].generationHash = `sha256:${'f'.repeat(64)}`;
    raw.governance.activationIdentity = contexts.buildModernGovernanceContext({
      selection: { project: raw.project, framework: raw.framework, profile: raw.governance.profile },
      plugins: raw.plugins, activeLayout: raw.activeLayout
    }).governance.activationIdentity;
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    await currentManifest(project.root);
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options))
      .rejects.toThrow(`preserved history disagrees with current ${field}`);
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it('does not accept disabled metadata as permission to reinterpret an explicit historical profile', async () => {
    const project = await historical(), target = await fixture('0.12.3', 'none');
    const file = path.join(project.root, 'liftoff.manifest.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const names = new Set(buildModernManagedCore(target.selection).map(artifact => artifact.logicalName));
    raw.plugins = target.selection.plugins;
    raw.governance = { profile: 'none', state: 'disabled' };
    raw.managedArtifacts = raw.managedArtifacts.filter((entry: { logicalName: string }) => names.has(entry.logicalName));
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    await currentManifest(project.root);
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, target.selection, project.options)).rejects.toThrow(/profile transition/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it.each(['content', 'transition', 'changed'] as const)('reconstructs the candidate rather than trusting supplied %s', async field => {
    const project = await historical(), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    if (inspection.kind !== 'manifest-maintenance') throw new Error('Expected current maintenance.');
    const plan = inspection.successorPlan;
    const altered = {
      ...inspection, successorPlan: {
        ...plan,
        ...(field === 'content' ? { manifest: { ...plan.manifest, content: plan.manifest.content + '\n' } } : {}),
        ...(field === 'transition' ? { semanticTransitionDigest: 'f'.repeat(64) } : {}),
        ...(field === 'changed' ? { manifestChanged: !plan.manifestChanged } : {})
      }
    };
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(prepareModernSuccessorReview(altered, false, preview.receipt.publication.preparation, now))
      .rejects.toThrow(/changed after its captured construction/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it.each(manifestOnlyAbsentControlPaths.map(pathParts => ({ pathParts })))(
    'does not treat an uncaptured $pathParts as evidence of absence', async ({ pathParts }) => {
      const project = await historical();
      const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
      const captures = inspection.snapshots.filter(file => file.pathParts.join('/') !== pathParts.join('/'));
      expect(() => readCurrentManifestMaintenanceSource(captures)).toThrow(/observed absence/iu);
    }
  );

  it('refuses an uncaptured current manifest rather than synthesizing source data', async () => {
    const project = await historical(), inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    expect(() => readCurrentManifestMaintenanceSource(
      inspection.snapshots.filter(file => file.pathParts.join('/') !== 'liftoff.manifest.json')
    )).toThrow(/required source/iu);
  });

  it.each(['required', 'declined', 'mismatch'] as const)('preserves missing core when maintenance consent is %s', async status => {
    const project = await historical(); await removeCore(project);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options), before = await inventory(project.root);
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false,
      ...(status === 'mismatch' ? { approvePlan: 'f'.repeat(64) } : {})
    }, approval(status === 'declined' ? async () => false : undefined), project.options))
      .toMatchObject({ status: 'approval-blocked', approval: { status } });
    expect(await inventory(project.root)).toEqual(before);
    expect(await auditFor(project, preview)).toBeNull();
  });

  it.each(['before', 'during'] as const)('preserves source edits %s maintenance approval', async timing => {
    const project = await historical(); await removeCore(project);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    let before = await inventory(project.root), calls = 0;
    const edit = async () => {
      await fs.appendFile(path.join(project.root, 'liftoff.manifest.json'), '\n'); before = await inventory(project.root);
    };
    if (timing === 'before') await edit();
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false
    }, approval(async () => { calls++; await edit(); return true; }), project.options)).rejects.toThrow(/changed|differs/iu);
    expect(calls).toBe(timing === 'before' ? 0 : 1);
    expect(await inventory(project.root)).toEqual(before);
    expect(Boolean(await auditFor(project, preview))).toBe(timing === 'during');
  });

  it.each(['index', 'copy'] as const)('refuses damaged preserved history %s without new preparation', async part => {
    const project = await historical();
    if (!project.current.sourceManifestHistory) throw new Error('Expected original history.');
    const paths = manifestHistoryPaths(project.current.sourceManifestHistory);
    await fs.appendFile(path.join(project.root, ...(part === 'index' ? paths.indexPathParts : paths.manifestPathParts)), '\n');
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/history|copy|digest/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it.each(['during-approval', 'during-publication'] as const)('preserves history changed %s and refuses completion', async timing => {
    const project = await historical(); await removeCore(project);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    if (!project.current.sourceManifestHistory) throw new Error('Expected original history.');
    const parts = manifestHistoryPaths(project.current.sourceManifestHistory).manifestPathParts;
    const file = path.join(project.root, ...parts), before = await inventory(project.root);
    const changed = Buffer.concat([await fs.readFile(file), Buffer.from('\n')]);
    const edit = async () => { await fs.writeFile(file, changed); };
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false
    }, approval(async () => { if (timing === 'during-approval') await edit(); return true; }), {
      ...project.options, onCheckpoint: async checkpoint => {
        if (timing === 'during-publication' && checkpoint.phase === 'after-mutation') await edit();
      }
    })).rejects.toThrow(/history|changed after review/iu);
    expect(await fs.readFile(file)).toEqual(changed);
    const after = await inventory(project.root);
    delete after[parts.join('/')]; delete before[parts.join('/')];
    expect(after).toEqual(before);
    expect(await auditFor(project, preview)).not.toBeNull();
  });

  it('refuses a recorded activation-history link with missing activation state', async () => {
    const project = await historical(), file = path.join(project.root, 'liftoff.manifest.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.sourceManifestHistory.kind = 'activation-history';
    await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    await currentManifest(project.root);
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/missing activation state/iu);
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it.each([
    ['governance', 'activation-state.json'], ['governance', 'migration-state.json'],
    ['governance', 'activation-baseline.json'], ['governance', 'credentials', 'preflight-policy.json'],
    ['governance', 'evidence', 'orphan.json']
  ].map(pathParts => ({ pathParts })))('refuses existing $pathParts instead of interpreting active maintenance', async ({ pathParts }) => {
    const project = await historical();
    await write(project.root, pathParts, 'Do not reinterpret this control record.\n');
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow();
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it('rolls back a core-only transaction without changing current metadata or history', async () => {
    const project = await historical(); await removeCore(project);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options), before = await inventory(project.root);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'before-commit') throw new Error('Injected current maintenance failure.');
    } })).rejects.toThrow(/All attributable changes were rolled back/u);
    expect(await inventory(project.root)).toEqual(before);
    expect(await auditFor(project, preview)).not.toBeNull();
  });

  it.each(['after-first', 'after-last', 'before-commit'] as const)(
    'preserves an unreferenced record added %s and rolls back only maintenance writes', async timing => {
    const project = await historical(), artifacts = buildModernManagedCore(project.selection).slice(0, 2);
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) await fs.unlink(path.join(project.root, ...artifact.pathParts));
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options), before = await inventory(project.root);
    const parts = ['governance', 'evidence', 'independent.json'];
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (timing === 'before-commit' ? checkpoint.phase === 'before-commit' :
        checkpoint.phase === 'after-mutation' && checkpoint.index === (timing === 'after-first' ? 0 : 1)) {
        await write(project.root, parts, 'Independent record.\n');
      }
    } })).rejects.toThrow(/orphaned/iu);
    expect(await fs.readFile(path.join(project.root, ...parts), 'utf8')).toBe('Independent record.\n');
    const after = await inventory(project.root);
    delete after[parts.join('/')];
    expect(after).toEqual(before);
    expect(await auditFor(project, preview)).not.toBeNull();
    }
  );

  it.each(['after-mutation', 'committed'] as const)('recovers actual core-only interruption at %s without rewriting metadata', async phase => {
    const project = await historical(), artifact = await removeCore(project), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const request = { projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint };
    const child = spawnSync(process.execPath, [
      '--import', new URL('./fixtures/source-typescript-loader.mjs', import.meta.url).href,
      '--input-type=module', '-e', `
        const { applyModernSuccessorUpdate } = await import(${JSON.stringify(new URL('../src/application/update/use-case.ts', import.meta.url).href)});
        await applyModernSuccessorUpdate(${JSON.stringify(request)}, { stderr: process.stderr }, {
          env: {}, homedir: ${JSON.stringify(project.home)}, clock: () => new Date(${JSON.stringify(now)}),
          onCheckpoint: async checkpoint => { if (checkpoint.phase === ${JSON.stringify(phase)}) process.exit(73); }
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
    // Only this settled test child's exact lock is removed, never an unattributed production lock.
    await fs.unlink(lock);
    expect(await applyModernSuccessorUpdate(request, approval(), project.options)).toMatchObject({
      status: 'recovered', requiresFreshPreview: true, outcome: { rollbackFailures: [], cleanupFailures: [] }
    });
    const after = await inventory(project.root);
    if (phase === 'committed') {
      expect(await fs.readFile(path.join(project.root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
      delete after[artifact.pathParts.join('/')];
    }
    expect(after).toEqual(before);
    expect((await apply(project, await previewModernSuccessorUpdate(project.root, project.selection, project.options))).status)
      .toBe(phase === 'committed' ? 'current' : 'committed');
  });

  it('reports committed cleanup failure and recovers without rolling back installed core', async () => {
    const project = await historical(), artifact = await removeCore(project), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const request = { projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint };
    expect(await applyModernSuccessorUpdate(request, approval(), {
      ...project.options, onCheckpoint: async checkpoint => {
        if (checkpoint.phase === 'committed') throw new Error('Injected post-commit cleanup failure.');
      }
    })).toMatchObject({ status: 'committed-cleanup-pending', committed: true, revalidation: 'not-required-no-activation' });
    expect(await fs.readFile(path.join(project.root, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
    expect(await applyModernSuccessorUpdate(request, approval(), project.options)).toMatchObject({
      status: 'recovered', requiresFreshPreview: true, outcome: { rollbackFailures: [], cleanupFailures: [] }
    });
    const after = await inventory(project.root); delete after[artifact.pathParts.join('/')];
    expect(after).toEqual(before);
    expect((await apply(project, await previewModernSuccessorUpdate(project.root, project.selection, project.options))).status).toBe('current');
  });
});
