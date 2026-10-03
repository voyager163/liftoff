import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { applyModernSuccessorUpdate, previewModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { inspectModernSuccessorUpdate } from '../src/application/update/inspection.js';
import { prepareModernSuccessorReview } from '../src/application/update/review-plan.js';
import { inspectModernInstalledActivation, inspectModernMaintenanceSource } from '../src/application/governance/modern-installed-preflight.js';
import { prepareActiveManifestMaintenance, requiredActivationTargetPreservation } from '../src/application/update/active-manifest-maintenance.js';
import { readPreservedActivationTargetManifest } from '../src/application/update/activation-target-history.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { createManifestV8Reader } from '../src/domain/project/manifest/v8.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { activationTargetHistoryPathParts } from '../src/domain/project/manifest/activation-target-history.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { createModernActivationRecordContract } from '../src/domain/governance/activation/modern-records.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { rawHistoryDigest } from '../src/governance-activation/history-contracts.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import {
  reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts
} from '../src/domain/project/reviewed-update-artifacts.js';
import { approval, auditFor, fixture, inventory, now, write } from './fixtures/manifest-update.js';
import { selected, writeModernSuccessor, writePriorRepairOriginalTarget, localInputsPlanFixture } from './fixtures/modern-installed-project.js';

const contracts = { catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract };
const reader = createManifestV8Reader(contracts);
const prior = 'Previously recorded owned repair integration.\r\n';
async function currentManifest(root: string) {
  return reader.parseManifestV8(JSON.parse(await fs.readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')));
}
async function active(kind: 'current' | 1 | 2 | 3 = 3, outdated = false) {
  const stored = await fixture();
  if (kind !== 'current') {
    const source = await writeModernSuccessor(stored.root, kind);
    if (outdated) await writePriorRepairOriginalTarget(source, prior);
  } else {
    const input = stored.selection, core = buildModernManagedCore(input);
    const context = createModernGovernanceContextContract(contracts).buildModernGovernanceContext(input);
    const repair = core.find(file => file.logicalName.includes('repair'))!;
    const sourceCore = core.map(file => outdated && file === repair ? { ...file, content: prior } : file);
    const manifest = reader.parseManifestV8({
      artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion: context.governance.activationIdentity.liftoffVersion,
      project: input.selection.project, framework: input.selection.framework, plugins: input.plugins, activeLayout: input.activeLayout,
      governance: {
        profile: context.governance.profile, policyVersion: context.governance.policyVersion,
        activationIdentity: context.governance.activationIdentity, state: 'handoff-generated'
      },
      managedArtifacts: sourceCore.map(file => ({
        logicalName: file.logicalName, category: file.category, pathParts: file.pathParts,
        contentHash: `sha256:${rawHistoryDigest(Buffer.from(file.content))}`
      })), projectArtifacts: [], adoptionObservations: []
    });
    for (const file of sourceCore) await write(stored.root, file.pathParts, file.content);
    const candidate = createManifestV8Candidate({
      origin: 'maintenance', source: manifest,
      managed: manifest.managedArtifacts.map(file => ({ kind: 'retain', logicalName: file.logicalName }))
    });
    await write(stored.root, ['liftoff.manifest.json'], candidate.content);
    const api = createModernActivationRecordContract(projectCatalog, {
      recordedIdentity: context.governance.activationIdentity, profile: 'single-maintainer-gitflow',
      policyVersion: context.governance.policyVersion, selection: { ...input.selection, profile: 'single-maintainer-gitflow' },
      pluginResolutionDigest: input.plugins.resolutionDigest, activeLayoutDigest: context.governance.activationIdentity.activeLayoutDigest
    });
    const initial = api.createInitialState({
      repository: { id: 'local:11111111-1111-4111-8111-111111111111', name: manifest.project.name, defaultBranch: 'develop' },
      applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' }, createdAt: now
    });
    const plan = api.createPlan(localInputsPlanFixture(api));
    const proof = api.createEvidence({
      plan, evidenceId: 'maintained-local-input', repositoryId: initial.repository.id, producedAt: now,
      producer: 'record-format-fixture-not-execution', result: 'verified', payload: { kind: 'local-inputs-valid.v1' }
    });
    const state = api.stateAfterOutcome({
      state: initial, plan, phaseState: 'verified', updatedAt: now, evidenceId: proof.evidenceId
    }, { plans: [plan], evidence: [proof] });
    await write(stored.root, ['governance', 'plans', 'local-input.json'], canonicalJson(plan));
    await write(stored.root, ['governance', 'evidence', `${proof.evidenceId}.json`], canonicalJson(proof));
    await write(stored.root, ['governance', 'activation-state.json'], canonicalJson(state));
  }
  const manifest = await currentManifest(stored.root);
  if (manifest.governance.profile === 'none') throw new Error('Expected enabled fixture.');
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({ project: manifest.project, framework: manifest.framework });
  return { ...stored, selection: selected(leaf, manifest.governance.profile), current: manifest };
}
type ActiveProject = Awaited<ReturnType<typeof active>>;
function repair(project: ActiveProject) {
  const file = buildModernManagedCore(project.selection).find(file => file.logicalName.includes('repair'));
  if (!file) throw new Error('Expected selected repair integration.');
  return file;
}
async function apply(project: ActiveProject, preview: Awaited<ReturnType<typeof previewModernSuccessorUpdate>>, force = false) {
  const variant = preview.receipt.variants.find(entry => entry.mode === (force ? 'force' : 'normal'));
  if (!variant) throw new Error('Expected eligible fixture variant.');
  return applyModernSuccessorUpdate({
    projectRoot: project.root, selection: project.selection, force, approvePlan: variant.fingerprint
  }, approval(), project.options);
}
function protectedFiles(files: Awaited<ReturnType<typeof inventory>>) {
  return Object.fromEntries(Object.entries(files).filter(([name]) =>
    ['history', 'plans', 'evidence', 'approvals', 'supersessions'].some(collection => name.startsWith(`governance/${collection}/`)) ||
    name === 'governance/activation-state.json' ||
    name === 'governance/migration-state.json' || name === 'application.txt' || name === 'package.json'));
}

describe('actual reviewed active-v8 maintenance', () => {
  it.each(['current', 1, 2, 3] as const)('keeps compatible %s active sources untouched without approval or duplicate history', async kind => {
    const project = await active(kind), before = await inventory(project.root);
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(preview.scope).toBe('active-core-manifest-maintenance-only');
    expect(preview.plans.every(plan => plan.writeCount === 0)).toBe(true);
    const home = await inventory(project.home);
    expect(await applyModernSuccessorUpdate({ projectRoot: project.root, selection: project.selection, force: false },
      approval(async () => { throw new Error('No-op must not request consent.'); }), project.options))
      .toEqual({ status: 'current', committed: false, revalidation: 'separate-reviewed-operation-required' });
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
    expect(await auditFor(project, preview)).toBeNull();
  });

  it.each(['current', 1, 2, 3] as const)('repairs missing %s core without a manifest rewrite or preservation copy', async kind => {
    const project = await active(kind), file = repair(project), before = await inventory(project.root);
    await fs.unlink(path.join(project.root, ...file.pathParts));
    expect((await inspectModernInstalledActivation(project.root)).status).toBe('blocked');
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const review = await prepareModernSuccessorReview(await inspectModernSuccessorUpdate(project.root, project.selection),
      false, preview.receipt.publication.preparation, now);
    expect(review.mutations.map(entry => entry.pathParts)).toEqual([file.pathParts]);
    for (const parts of [reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts]) {
      expect(review.preconditions.some(entry => entry.pathParts.join('/') === parts.join('/'))).toBe(false);
    }
    expect(await apply(project, preview)).toMatchObject({
      status: 'committed-incomplete', committed: true, revalidation: 'separate-reviewed-operation-required'
    });
    expect(protectedFiles(await inventory(project.root))).toEqual(protectedFiles(before));
    expect((await inventory(project.root))['liftoff.manifest.json']).toEqual(before['liftoff.manifest.json']);
    expect((await currentManifest(project.root)).activationTargetHistory).toBeUndefined();
    expect((await inspectModernInstalledActivation(project.root)).status).toBe('observed');
  });

  it.each(['current', 1, 2, 3] as const)('updates %s metadata with exact original transition continuity', async kind => {
    const project = await active(kind, true), before = await inventory(project.root);
    const original = await fs.readFile(path.join(project.root, 'liftoff.manifest.json'));
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    const review = await prepareModernSuccessorReview(inspection, false, preview.receipt.publication.preparation, now);
    if (kind !== 'current') expect(review.mutations[0].pathParts.slice(0, 2)).toEqual(['.liftoff', 'activation-target-history']);
    expect(review.mutations.at(-1)?.pathParts).toEqual(['liftoff.manifest.json']);
    expect(await apply(project, preview)).toMatchObject({ status: 'committed-incomplete', committed: true });
    const current = await currentManifest(project.root), after = await inventory(project.root);
    if (kind === 'current') expect(current.activationTargetHistory).toBeUndefined();
    else {
      const reference = current.activationTargetHistory!;
      expect(reference).toMatchObject({
        manifestDigest: rawHistoryDigest(original), bytes: original.length, mode: before['liftoff.manifest.json'].mode
      });
      expect(await fs.readFile(path.join(project.root, ...activationTargetHistoryPathParts(reference)))).toEqual(original);
      expect(after[activationTargetHistoryPathParts(reference).join('/')].mode).toBe(reference.mode);
    }
    expect(protectedFiles(after)).toEqual(protectedFiles(before));
    expect((await inspectModernInstalledActivation(project.root)).status).toBe('observed');
    const next = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect((await apply(project, next)).status).toBe('current');
    expect(await inventory(project.root)).toEqual(after);
  });

  it('requires force for modified owned core without taking ownership of an unowned conflict', async () => {
    const project = await active(), file = repair(project);
    await write(project.root, file.pathParts, 'User-modified owned integration.\n');
    const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(preview.receipt.variants.map(entry => entry.mode)).toEqual(['force']);
    expect(await apply(project, preview, true)).toMatchObject({ committed: true });
    expect(await fs.readFile(path.join(project.root, ...file.pathParts), 'utf8')).toBe(file.content);

    const current = await active('current');
    const raw = structuredClone(current.current), unowned = repair(current);
    Object.assign(raw, { managedArtifacts: raw.managedArtifacts.filter(entry => entry.logicalName !== unowned.logicalName) });
    await write(current.root, ['liftoff.manifest.json'], canonicalJson(reader.parseManifestV8(raw)));
    await write(current.root, unowned.pathParts, 'User-owned integration.\n');
    const before = await inventory(current.root);
    await expect(previewModernSuccessorUpdate(current.root, current.selection, current.options)).rejects.toThrow(/unowned/iu);
    expect(await inventory(current.root)).toEqual(before);
  });

  it('reuses the first original target across subsequent metadata maintenance instead of chaining copies', async () => {
    const project = await active(3, true);
    await apply(project, await previewModernSuccessorUpdate(project.root, project.selection, project.options));
    const first = await currentManifest(project.root), reference = first.activationTargetHistory!;
    const parts = activationTargetHistoryPathParts(reference), original = await fs.readFile(path.join(project.root, ...parts));
    const file = repair(project), newerPrior = 'Another recorded core version.\n';
    const raw = {
      ...first, managedArtifacts: first.managedArtifacts.map(entry => entry.logicalName === file.logicalName
        ? { ...entry, contentHash: `sha256:${rawHistoryDigest(Buffer.from(newerPrior))}` } : entry)
    };
    await write(project.root, ['liftoff.manifest.json'], canonicalJson(reader.parseManifestV8(raw)));
    await write(project.root, file.pathParts, newerPrior);
    const before = await inventory(project.root), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    expect(await apply(project, preview)).toMatchObject({ committed: true });
    expect((await currentManifest(project.root)).activationTargetHistory).toEqual(reference);
    expect(await fs.readFile(path.join(project.root, ...parts))).toEqual(original);
    expect(Object.keys(await inventory(project.root)).filter(name => name.startsWith('.liftoff/activation-target-history/'))).toEqual([parts.join('/')]);
    expect(protectedFiles(await inventory(project.root))).toEqual(protectedFiles(before));
    expect((await inspectModernInstalledActivation(project.root)).status).toBe('observed');
  });

  it.each(['missing', 'changed', 'mode'] as const)('blocks a %s original target copy without another preview or audit', async fault => {
    const project = await active(3, true);
    await apply(project, await previewModernSuccessorUpdate(project.root, project.selection, project.options));
    const current = await currentManifest(project.root), reference = current.activationTargetHistory!;
    expect(await inspectModernInstalledActivation(project.root)).toMatchObject({ status: 'observed', classification: 'successor' });
    const absolute = path.join(project.root, ...activationTargetHistoryPathParts(reference));
    if (fault === 'missing') await fs.unlink(absolute);
    else if (fault === 'changed') await fs.appendFile(absolute, '\n');
    else await fs.chmod(absolute, reference.mode ^ 0o200);
    const observation = {
      pathParts: [...activationTargetHistoryPathParts(reference)],
      ...(fault === 'missing' ? {} : { content: await fs.readFile(absolute), mode: (await fs.stat(absolute)).mode & 0o777 })
    };
    expect(() => readPreservedActivationTargetManifest(current, observation))
      .toThrow('Preserved original activation target differs from its exact path, bytes or mode.');
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options))
      .rejects.toThrow('Installed preflight rejected invalid, unsupported or unavailable control/history records; source values were omitted.');
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it.each(['project', 'profile', 'plugins', 'layout', 'framework'] as const)('does not turn active maintenance into a %s transition', async field => {
    const project = await active(), input = structuredClone(project.selection);
    if (field === 'project') Object.assign(input.selection.project, { name: 'Different project' });
    else if (field === 'profile') Object.assign(input.selection, { profile: 'none' });
    else if (field === 'plugins') Object.assign(input.plugins, { resolutionDigest: `sha256:${'f'.repeat(64)}` });
    else if (field === 'framework') Object.assign(input.selection.framework, { contractVersion: '0.0.0' });
    else Object.assign(input, { activeLayout: {
      schemaVersion: 1, state: 'bound', bindings: [{ kind: 'component', component: 'backend', pathParts: ['custom', 'api'] }]
    } });
    const before = await inventory(project.root), home = await inventory(project.home);
    await expect(previewModernSuccessorUpdate(project.root, input, project.options)).rejects.toThrow();
    expect(await inventory(project.root)).toEqual(before);
    expect(await inventory(project.home)).toEqual(home);
  });

  it.each(['before', 'during'] as const)('preserves active evidence edited %s approval and rejects stale authority', async timing => {
    const project = await active('current', true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    let before = await inventory(project.root), calls = 0;
    const edit = async () => {
      await fs.appendFile(path.join(project.root, 'governance/evidence/maintained-local-input.json'), '\n');
      before = await inventory(project.root);
    };
    if (timing === 'before') await edit();
    await expect(applyModernSuccessorUpdate({ projectRoot: project.root, selection: project.selection, force: false },
      approval(async () => { calls++; await edit(); return true; }), project.options)).rejects.toThrow(/changed|differs/iu);
    expect(calls).toBe(timing === 'before' ? 0 : 1);
    expect(await inventory(project.root)).toEqual(before);
    expect(Boolean(await auditFor(project, preview))).toBe(timing === 'during');
  });

  it.each(['required', 'declined', 'mismatch'] as const)('does not preserve or replace a target when approval is %s', async status => {
    const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const before = await inventory(project.root);
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false,
      ...(status === 'mismatch' ? { approvePlan: 'f'.repeat(64) } : {})
    }, approval(status === 'declined' ? async () => false : undefined), project.options))
      .toMatchObject({ status: 'approval-blocked', approval: { status } });
    expect(await inventory(project.root)).toEqual(before);
    expect(await auditFor(project, preview)).toBeNull();
  });

  it.each(['same', 'different', 'mode'] as const)('handles %s preservation destination without overwriting it', async disposition => {
    const project = await active(3, true), inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    if (inspection.kind !== 'active-manifest-maintenance' || !inspection.preservationObservation) throw new Error('Expected preservation.');
    const original = await fs.readFile(path.join(project.root, 'liftoff.manifest.json'));
    const parts = inspection.preservationObservation.pathParts, originalMode = (await fs.stat(path.join(project.root, 'liftoff.manifest.json'))).mode & 0o777;
    await write(project.root, parts, disposition === 'different' ? 'Occupied destination.\n' : original);
    await fs.chmod(path.join(project.root, ...parts), disposition === 'mode' ? originalMode ^ 0o200 : originalMode);
    const before = await inventory(project.root);
    if (disposition === 'same') {
      const preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
      const review = await prepareModernSuccessorReview(await inspectModernSuccessorUpdate(project.root, project.selection),
        false, preview.receipt.publication.preparation, now);
      expect(review.mutations.some(entry => entry.pathParts.join('/') === parts.join('/'))).toBe(false);
      expect(await apply(project, preview)).toMatchObject({ committed: true });
      expect((await inventory(project.root))[parts.join('/')]).toEqual(before[parts.join('/')]);
    } else {
      await expect(previewModernSuccessorUpdate(project.root, project.selection, project.options)).rejects.toThrow(/occupied|different/iu);
      expect(await inventory(project.root)).toEqual(before);
    }
  });

  it.each(['content', 'transition', 'changed'] as const)('reconstructs active candidates instead of trusting supplied %s', async field => {
    const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    if (inspection.kind !== 'active-manifest-maintenance') throw new Error('Expected active maintenance.');
    const plan = inspection.successorPlan, altered = {
      ...inspection, successorPlan: {
        ...plan,
        ...(field === 'content' ? { manifest: { ...plan.manifest, content: plan.manifest.content + '\n' } } : {}),
        ...(field === 'transition' ? { semanticTransitionDigest: 'f'.repeat(64) } : {}),
        ...(field === 'changed' ? { manifestChanged: !plan.manifestChanged } : {})
      }
    };
    await expect(prepareModernSuccessorReview(altered, false, preview.receipt.publication.preparation, now))
      .rejects.toThrow(/changed after its captured construction/iu);
  });

  it('requires an explicit exact destination observation and rejects unexpected preservation input', async () => {
    const project = await active(3, true), inspection = await inspectModernSuccessorUpdate(project.root, project.selection);
    if (inspection.kind !== 'active-manifest-maintenance') throw new Error('Expected active maintenance.');
    await expect(prepareActiveManifestMaintenance(inspection.activeSnapshot, project.selection, inspection.managed))
      .rejects.toThrow(/not captured/iu);
    await expect(prepareActiveManifestMaintenance(inspection.activeSnapshot, project.selection, inspection.managed, { pathParts: ['elsewhere'] }))
      .rejects.toThrow(/different captured destination/iu);
    const current = await active('current'), other = await inspectModernSuccessorUpdate(current.root, current.selection);
    if (other.kind !== 'active-manifest-maintenance') throw new Error('Expected current active maintenance.');
    await expect(prepareActiveManifestMaintenance(other.activeSnapshot, current.selection, other.managed, { pathParts: ['elsewhere'] }))
      .rejects.toThrow(/does not require/iu);
  });

  it('rejects preservation overlapping a retained namespace before destination capture', async () => {
    const project = await active(3, true), source = await inspectModernMaintenanceSource(project.root);
    if (!('kind' in source)) throw new Error('Expected actual source.');
    const reference = requiredActivationTargetPreservation(source, true)!;
    const parts = activationTargetHistoryPathParts(reference);
    for (const protectedPath of [parts, parts.slice(0, 2), [...parts, 'payload']]) {
      expect(() => requiredActivationTargetPreservation({
        ...source, retention: [{
          origin: 'retained-namespace-fixture', repositoryId: source.current.state.repository.id,
          retainedAt: now, disposeAfter: '2026-10-01T00:00:00.000Z', status: 'retained',
          protectedPaths: [protectedPath], authority: 'preservation-only'
        }]
      }, true)).toThrow(/overlaps retained/iu);
    }
  });

  it.each(['after-first', 'after-last', 'before-commit'] as const)('preserves new active collection members added %s', async timing => {
    const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const before = await inventory(project.root);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), {
      ...project.options, onCheckpoint: async checkpoint => {
        if (timing === 'before-commit' ? checkpoint.phase === 'before-commit' :
          checkpoint.phase === 'after-mutation' && checkpoint.index === (timing === 'after-first' ? 0 : preview.plans[0].writeCount - 1)) {
          await write(project.root, ['governance', 'plans', 'late.json'], '{}\n');
        }
      }
    })).rejects.toThrow(/membership changed/iu);
    const after = await inventory(project.root);
    expect(after['governance/plans/late.json']).toBeDefined();
    delete after['governance/plans/late.json'];
    expect(after).toEqual(before);
  });

  it.each(['after-mutation', 'committed'] as const)('recovers actual original-target preservation interruption at %s', async phase => {
    const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const before = await inventory(project.root);
    const request = { projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint };
    const child = spawnSync(process.execPath, [
      '--import', new URL('./fixtures/source-typescript-loader.mjs', import.meta.url).href, '--input-type=module', '-e', `
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
    // This test owns the dead child's specific lock; production does not reap abandoned locks.
    const lock = await projectMutationLockPath(project.root), lockBytes = await fs.readFile(lock);
    expect(JSON.parse(lockBytes.toString('utf8')).pid).toBe(child.pid);
    expect(await fs.readFile(lock)).toEqual(lockBytes);
    await fs.unlink(lock);
    expect(await applyModernSuccessorUpdate(request, approval(), project.options)).toMatchObject({ status: 'recovered', requiresFreshPreview: true });
    if (phase === 'after-mutation') expect(await inventory(project.root)).toEqual(before);
    else {
      expect((await currentManifest(project.root)).activationTargetHistory).toBeDefined();
      expect(protectedFiles(await inventory(project.root))).toEqual(protectedFiles(before));
      expect((await inspectModernInstalledActivation(project.root)).status).toBe('observed');
    }
  });

  it.each([reviewedRepairTransactionPathParts, localVerificationTransactionPathParts].map(parts => ({ parts })))(
    'preserves a competing $parts journal and rolls back only its own writes', async ({ parts }) => {
      const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
      const before = await inventory(project.root);
      await expect(applyModernSuccessorUpdate({
        projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
      }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
        if (checkpoint.phase === 'after-mutation' && checkpoint.index === 0) await write(project.root, parts, 'Competing transaction; do not open or change.\n');
      } })).rejects.toThrow(/competing local transaction/iu);
      const after = await inventory(project.root);
      expect(after[parts.join('/')]).toBeDefined();
      delete after[parts.join('/')];
      expect(after).toEqual(before);
    }
  );

  it('retains a changed original journal during publication instead of rewriting its source binding', async () => {
    const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const before = await inventory(project.root), file = path.join(project.root, 'governance/migration-state.json');
    const changed = Buffer.concat([await fs.readFile(file), Buffer.from('\n')]);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'after-mutation' && checkpoint.index === 0) await fs.writeFile(file, changed);
    } })).rejects.toThrow(/changed after review/iu);
    expect(await fs.readFile(file)).toEqual(changed);
    const after = await inventory(project.root);
    delete before['governance/migration-state.json']; delete after['governance/migration-state.json'];
    expect(after).toEqual(before);
  });

  it('retains committed maintenance after a postcommit failure and recovers cleanup without another migration', async () => {
    const project = await active(3, true), preview = await previewModernSuccessorUpdate(project.root, project.selection, project.options);
    const before = await inventory(project.root), request = {
      projectRoot: project.root, selection: project.selection, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    };
    const outcome = await applyModernSuccessorUpdate(request, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'committed') throw new Error('Injected postcommit failure.');
    } });
    expect(outcome).toMatchObject({ status: 'committed-cleanup-pending', committed: true });
    const current = await currentManifest(project.root);
    expect(current.activationTargetHistory).toBeDefined();
    expect(protectedFiles(await inventory(project.root))).toEqual(protectedFiles(before));
    expect(await applyModernSuccessorUpdate(request, approval(), project.options)).toMatchObject({ status: 'recovered', requiresFreshPreview: true });
    expect(await currentManifest(project.root)).toEqual(current);
    expect((await inspectModernInstalledActivation(project.root)).status).toBe('observed');
  });
});
