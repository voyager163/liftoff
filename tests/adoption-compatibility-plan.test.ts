import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAdoptionCompatibilityPlan, prepareAdoptionCompatibilityPlan,
  saveAdoptionCompatibilityPlan, type AdoptionCompatibilityReview
} from '../src/application/adoption/compatibility-plan.js';
import { inspectAdoptionCandidate } from '../src/application/adoption/candidate.js';
import {
  saveAdoptionDestinationPlan, type SavedAdoptionDestinationPlan
} from '../src/application/adoption/destination-plan.js';
import {
  createAdoptionReview, saveAdoptionPreview, type AdoptionReviewInspection
} from '../src/application/adoption/preview.js';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-07T12:00:00.000Z');

async function directory(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function put(root: string, pathParts: readonly string[], content: string) {
  const filename = path.join(root, ...pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { mode: 0o640 });
}

function verification(
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma',
  backendPathParts: readonly string[],
  backendRootPathParts: readonly string[]
): AdoptionCompatibilityReview['verification'] {
  const command = stack === 'node-fastify'
    ? { executable: 'node', args: [backendPathParts.join('/')], cwdPathParts: [] }
    : stack === 'python-fastapi'
      ? { executable: 'python3', args: ['-I', '-B', backendPathParts.join('/')], cwdPathParts: [] }
      : { executable: 'go', args: ['test', './...'], cwdPathParts: [...backendRootPathParts] };
  return {
    commands: [{
      ...command, timeoutMs: 30_000, maxOutputBytes: 16_384, network: false
    }],
    preparation: []
  };
}

function document(
  review: AdoptionReviewInspection,
  saved: SavedAdoptionDestinationPlan,
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma'
): AdoptionCompatibilityReview {
  const inventory = review.report.inventory;
  const backend = inventory.files.find(file =>
    file.currentTargetLogicalName !== null && file.currentTargetLogicalName !== 'root-readme');
  if (!backend) throw new Error('Missing backend fixture.');
  const target = inventory.target.artifacts.find(artifact =>
    artifact.logicalName === backend.currentTargetLogicalName);
  if (!target) throw new Error('Missing backend target fixture.');
  return {
    schemaVersion: 1,
    kind: 'liftoff-adoption-compatibility-review',
    projectRoot: inventory.projectRoot,
    reviewFingerprint: review.preview.fingerprint,
    destinationPlanFingerprint: saved.plan.report.fingerprint,
    inventoryDigest: inventory.inspectionDigest,
    targetLayoutDigest: inventory.target.digest,
    dynamicReferencesReviewed: true,
    unresolvedMappings: [],
    files: inventory.files.map((file, index) => ({
      sourcePathParts: [...file.pathParts],
      expectedDigest: file.digest,
      expectedMode: file.mode,
      decision: 'preserve-current-path',
      targetPathParts: [...file.pathParts],
      targetIdentity: file.currentTargetLogicalName === null
        ? { kind: 'custom-component', logicalName: `custom-file-${index + 1}` }
        : { kind: 'active-binding', logicalName: file.currentTargetLogicalName }
    })),
    references: inventory.references.map(reference => ({
      referenceId: reference.id,
      disposition: 'unchanged-reviewed',
      afterTargetPathParts: [...reference.targetPathParts]
    })),
    verification: verification(stack, backend.pathParts, target.componentRootPathParts)
  };
}

async function prepared(
  stack: 'python-fastapi' | 'node-fastify' | 'go-huma' = 'node-fastify',
  extend?: (root: string, backendPathParts: readonly string[]) => Promise<void>
) {
  const root = await directory('lf compatibility ');
  const userDataRoot = await directory('lf compatibility home ');
  const storage: UpdatePreviewOptions = { homedir: userDataRoot, env: {}, clock: () => now };
  const value = adoptionFixture(stack, 'single-maintainer-gitflow', 'openspec');
  const backend = value.request.adoptionObservations.find(entry => entry.logicalName !== 'root-readme');
  if (!backend) throw new Error('Missing backend fixture.');
  await put(root, backend.pathParts, `PRIVATE_${stack}_APPLICATION\n`);
  await put(root, ['README.md'], `Preserved application: "${backend.pathParts.join('/')}"\n`);
  await extend?.(root, backend.pathParts);
  const review = await createAdoptionReview(root, value.source, now);
  await saveAdoptionPreview(review.preview, now, storage);
  const saved = await saveAdoptionDestinationPlan(
    root, review.preview.fingerprint, value.source, now, storage
  );
  return {
    root, storage, source: value.source, review, saved,
    value: document(review, saved, stack)
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('exact adoption compatibility planning without verification or transaction authority', () => {
  it.each(['python-fastapi', 'node-fastify', 'go-huma'] as const)(
    'accepts an exact preserved %s layout only as ready for independently permissioned verification staging',
    async stack => {
      const input = await prepared(stack);
      const plan = await prepareAdoptionCompatibilityPlan(
        input.value, input.source, now, input.storage
      );
      expect(plan.report).toMatchObject({
        schemaVersion: 1,
        kind: 'liftoff-adoption-compatibility-plan',
        readOnly: true,
        projectRoot: input.root,
        reviewFingerprint: input.review.preview.fingerprint,
        destinationPlanFingerprint: input.saved.plan.report.fingerprint,
        status: 'ready-for-independent-verification-staging',
        compatibility: 'not-verified',
        deployment: 'planning-only',
        blockers: [],
        requiredPermissions: ['project-code-execution'],
        preparation: 'not-performed',
        checkExecution: 'not-performed',
        approval: 'not-requested',
        publication: 'not-authorized'
      });
      expect(plan.report.fileMappings).toHaveLength(input.review.report.inventory.files.length);
      expect(plan.report.referenceReviews).toHaveLength(input.review.report.inventory.references.length);
      expect(plan.report.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const reordered = await prepareAdoptionCompatibilityPlan({
        ...input.value,
        files: [...input.value.files].reverse(),
        references: [...input.value.references].reverse()
      }, input.source, now, input.storage);
      expect(reordered.report.fingerprint).toBe(plan.report.fingerprint);
      expect(JSON.stringify(plan)).not.toContain('PRIVATE_');
      expect(await readFile(path.join(input.root, ...input.review.report.inventory.files[0]!.pathParts)))
        .toBeDefined();
    }
  );

  it('requires every unmapped custom file and bounded literal reference to receive an exact decision', async () => {
    const input = await prepared('node-fastify', async root => {
      await put(root, ['custom', 'helper.ts'], 'export const helper = 37;\n');
      await put(root, ['tests', 'existing.test.ts'], 'import {helper} from "../custom/helper.js";\n');
    });
    const helper = input.value.files.find(mapping => mapping.sourcePathParts.join('/') === 'custom/helper.ts');
    const reference = input.review.report.inventory.references.find(item =>
      item.targetPathParts.join('/') === 'custom/helper.ts');
    if (!helper || !reference) throw new Error('Missing custom mapping fixture.');
    const blocked = {
      ...input.value,
      files: input.value.files.filter(mapping => mapping !== helper),
      references: input.value.references.filter(item => item.referenceId !== reference.id),
      unresolvedMappings: [{
        pathParts: [...helper.sourcePathParts],
        reason: 'mapping-decision-required' as const
      }]
    };
    const plan = await prepareAdoptionCompatibilityPlan(blocked, input.source, now, input.storage);
    expect(plan.report.status).toBe('blocked');
    expect(plan.report.blockers).toEqual(expect.arrayContaining([
      { code: 'file-review-missing', pathParts: helper.sourcePathParts },
      { code: 'reference-review-missing', referenceId: reference.id },
      { code: 'unresolved-mapping', pathParts: helper.sourcePathParts }
    ]));
    expect(plan.report.compatibility).toBe('not-verified');
  });

  it('retains exact move and affected-reference review while blocking until staged changed bytes exist', async () => {
    const input = await prepared();
    const backend = input.review.report.inventory.files.find(file =>
      file.currentTargetLogicalName !== null && file.currentTargetLogicalName !== 'root-readme');
    if (!backend) throw new Error('Missing backend fixture.');
    const moved = ['Moved Application', backend.pathParts.at(-1)!];
    const value: AdoptionCompatibilityReview = {
      ...input.value,
      files: input.value.files.map(mapping =>
        mapping.sourcePathParts.join('/') === backend.pathParts.join('/')
          ? { ...mapping, decision: 'move-required', targetPathParts: moved }
          : mapping),
      references: input.review.report.inventory.references.map(reference => ({
        referenceId: reference.id,
        disposition: reference.targetPathParts.join('/') === backend.pathParts.join('/')
          ? 'updated' as const : 'unchanged-reviewed' as const,
        afterTargetPathParts: reference.targetPathParts.join('/') === backend.pathParts.join('/')
          ? moved : [...reference.targetPathParts]
      }))
    };
    const plan = await prepareAdoptionCompatibilityPlan(value, input.source, now, input.storage);
    expect(plan.report.status).toBe('blocked');
    expect(plan.report.fileMappings).toContainEqual(expect.objectContaining({
      sourcePathParts: backend.pathParts,
      targetPathParts: moved,
      decision: 'move-required'
    }));
    expect(plan.report.blockers).toEqual(expect.arrayContaining([
      { code: 'application-move-requires-staged-patch', pathParts: backend.pathParts },
      expect.objectContaining({ code: 'reference-update-requires-staged-patch' })
    ]));
    expect(plan.report.verification.commands).toEqual(input.value.verification.commands);
  });

  it('keeps incomplete dynamic-reference review and absent verification commands blocked', async () => {
    const input = await prepared();
    const plan = await prepareAdoptionCompatibilityPlan({
      ...input.value,
      dynamicReferencesReviewed: false,
      verification: { commands: [], preparation: [] }
    }, input.source, now, input.storage);
    expect(plan.report.status).toBe('blocked');
    expect(plan.report.blockers).toEqual(expect.arrayContaining([
      { code: 'dynamic-reference-review-incomplete' },
      { code: 'verification-command-missing' }
    ]));
    expect(plan.report.requiredPermissions).toEqual(['project-code-execution']);
  });

  it('binds explicit preparation and network declarations without running either effect', async () => {
    const input = await prepared();
    const value: AdoptionCompatibilityReview = {
      ...input.value,
      verification: {
        commands: input.value.verification.commands.map(command => ({ ...command, network: true })),
        preparation: [{
          provider: 'npm-ci',
          version: 1,
          cwdPathParts: [],
          packageSource: 'npmjs',
          network: true,
          lifecycle: 'disabled'
        }]
      }
    };
    const plan = await prepareAdoptionCompatibilityPlan(value, input.source, now, input.storage);
    expect(plan.report.requiredPermissions).toEqual([
      'dependency-preparation', 'project-code-execution', 'declared-network'
    ]);
    expect(plan.report.status).toBe('ready-for-independent-verification-staging');
    expect(plan.report.preparation).toBe('not-performed');
    expect(plan.report.checkExecution).toBe('not-performed');
  });

  it('rejects stale application observations and review identities instead of exposing old private bytes', async () => {
    const input = await prepared();
    const backend = input.review.report.inventory.files.find(file =>
      file.currentTargetLogicalName !== null && file.currentTargetLogicalName !== 'root-readme');
    if (!backend) throw new Error('Missing backend fixture.');
    await put(input.root, backend.pathParts, 'CHANGED_AFTER_REVIEW\n');
    await expect(prepareAdoptionCompatibilityPlan(
      input.value, input.source, now, input.storage
    )).rejects.toThrow(/stale|different observations/);
    expect(JSON.stringify(input.value)).not.toContain('PRIVATE_');
  });

  it('rejects unknown paths, mismatched binding identities and unsafe verification commands', async () => {
    const input = await prepared();
    await expect(prepareAdoptionCompatibilityPlan({
      ...input.value,
      files: [...input.value.files, {
        sourcePathParts: ['outside.ts'],
        expectedDigest: '0'.repeat(64),
        expectedMode: 0o640,
        decision: 'preserve-current-path',
        targetPathParts: ['outside.ts'],
        targetIdentity: { kind: 'custom-component', logicalName: 'outside' }
      }]
    }, input.source, now, input.storage)).rejects.toThrow('outside the current bounded adoption inventory');
    const first = input.value.files[0]!;
    await expect(prepareAdoptionCompatibilityPlan({
      ...input.value,
      files: input.value.files.map(mapping => mapping === first
        ? {
            ...mapping,
            sourcePathParts: mapping.sourcePathParts.map((part, index) =>
              index === 0 ? part.toUpperCase() : part)
          }
        : mapping)
    }, input.source, now, input.storage)).rejects.toThrow(/outside the current bounded adoption inventory|exact observed spelling/);
    await expect(prepareAdoptionCompatibilityPlan({
      ...input.value,
      files: input.value.files.map(mapping => mapping === first
        ? {
            ...mapping,
            decision: 'move-required',
            targetPathParts: ['.git', 'unsafe.ts']
          }
        : mapping)
    }, input.source, now, input.storage)).rejects.toThrow('cannot target excluded');
    await expect(prepareAdoptionCompatibilityPlan({
      ...input.value,
      verification: {
        commands: [{
          executable: 'sh',
          args: ['-c', 'echo unsafe'],
          cwdPathParts: [],
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          network: false
        }],
        preparation: []
      }
    }, input.source, now, input.storage)).rejects.toThrow('supports only bounded');
  });

  it('rejects Proxy review input before traps and returns deeply frozen public data with defensive snapshots', async () => {
    const input = await prepared();
    const get = vi.fn();
    const proxied = new Proxy(input.value, {
      get(target, key, receiver) {
        get();
        return Reflect.get(target, key, receiver);
      }
    });
    await expect(prepareAdoptionCompatibilityPlan(
      proxied, input.source, now, input.storage
    )).rejects.toThrow('plain own data');
    expect(get).not.toHaveBeenCalled();

    const plan = await prepareAdoptionCompatibilityPlan(input.value, input.source, now, input.storage);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.report)).toBe(true);
    expect(Object.isFrozen(plan.report.fileMappings[0])).toBe(true);
    const first = plan.snapshots[0]!;
    const original = Buffer.from(first.content!);
    first.content![0] = first.content![0]! ^ 0xff;
    first.pathParts[0] = 'changed';
    expect(plan.snapshots[0]!.content).toEqual(original);
    expect(plan.snapshots[0]!.pathParts[0]).not.toBe('changed');
    expect(Object.keys(plan)).toEqual(['report']);
  });

  it('saves only a current ready report and rebuilds defensive private snapshots when loading', async () => {
    const input = await prepared();
    const before = await readdir(input.root);
    const saved = await saveAdoptionCompatibilityPlan(
      input.value, input.source, now, input.storage
    );
    expect(path.relative(input.storage.homedir!, saved.path).startsWith('..')).toBe(false);
    expect(path.basename(saved.path)).toMatch(/^adoption-compatibility-plan-/);
    expect(Object.keys(saved.plan)).toEqual(['report']);
    const loaded = await loadAdoptionCompatibilityPlan(
      input.root, input.review.preview.fingerprint, input.saved.plan.report.fingerprint,
      saved.plan.report.fingerprint, input.source, now, input.storage
    );
    expect(loaded.report).toEqual(saved.plan.report);
    expect(loaded.snapshots).toEqual(saved.plan.snapshots);
    expect((await saveAdoptionCompatibilityPlan(
      input.value, input.source, now, input.storage
    )).path).toBe(saved.path);
    expect(await readdir(input.root)).toEqual(before);
    const text = await readFile(saved.path, 'utf8');
    expect(text).not.toContain('PRIVATE_');
    expect(text).not.toContain('"snapshots":');
    expect(loaded.report).toMatchObject({
      compatibility: 'not-verified',
      preparation: 'not-performed',
      checkExecution: 'not-performed',
      approval: 'not-requested',
      publication: 'not-authorized'
    });
    expect(await createScopedUserLocalRecordStore(
      input.root, 'repair-verification', input.storage
    ).read(saved.plan.report.fingerprint)).toBeNull();
    if (process.platform !== 'win32') expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
  });

  it('does not persist a blocked compatibility report as a verification-staging input', async () => {
    const input = await prepared();
    await expect(saveAdoptionCompatibilityPlan({
      ...input.value,
      dynamicReferencesReviewed: false
    }, input.source, now, input.storage)).rejects.toThrow(/Blocked/);
    expect((await readdir(input.storage.homedir!, { recursive: true })).map(String)
      .some(name => name.includes('adoption-compatibility-plan-'))).toBe(false);
  });

  it.each(['application', 'destination', 'source', 'expired'] as const)(
    'refuses a saved compatibility plan after %s changes without exposing old snapshots',
    async change => {
      const input = await prepared();
      const saved = await saveAdoptionCompatibilityPlan(
        input.value, input.source, now, input.storage
      );
      let source: unknown = input.source;
      let clock = now;
      if (change === 'application') {
        const file = input.review.report.inventory.files.find(item =>
          item.currentTargetLogicalName !== 'root-readme')!;
        await put(input.root, file.pathParts, 'PRIVATE_CHANGED_APPLICATION\n');
      }
      if (change === 'destination') {
        const destination = input.saved.plan.report.destinations[0]!;
        await put(input.root, destination.pathParts, 'PRIVATE_CHANGED_DESTINATION\n');
      }
      if (change === 'source') source = adoptionFixture('python-fastapi').source;
      if (change === 'expired') clock = new Date(now.getTime() + 15 * 60_000);
      await expect(loadAdoptionCompatibilityPlan(
        input.root, input.review.preview.fingerprint, input.saved.plan.report.fingerprint,
        saved.plan.report.fingerprint, source, clock, input.storage
      )).rejects.toThrow();
      expect(JSON.stringify(saved.plan)).not.toContain('PRIVATE_');
    }
  );

  it('does not load another namespace, project, prerequisite identity or forged plan key', async () => {
    const first = await prepared(), second = await prepared();
    const plan = await prepareAdoptionCompatibilityPlan(
      first.value, first.source, now, first.storage
    );
    await createScopedUserLocalRecordStore(
      first.root, 'repair-verification', first.storage
    ).write(plan.report.fingerprint, plan.report);
    await expect(loadAdoptionCompatibilityPlan(
      first.root, first.review.preview.fingerprint, first.saved.plan.report.fingerprint,
      plan.report.fingerprint, first.source, now, first.storage
    )).rejects.toThrow(/No matching/);
    const saved = await saveAdoptionCompatibilityPlan(
      first.value, first.source, now, first.storage
    );
    await expect(loadAdoptionCompatibilityPlan(
      second.root, first.review.preview.fingerprint, first.saved.plan.report.fingerprint,
      saved.plan.report.fingerprint, first.source, now, first.storage
    )).rejects.toThrow();
    for (const [reviewFingerprint, destinationPlanFingerprint] of [
      ['0'.repeat(64), first.saved.plan.report.fingerprint],
      [first.review.preview.fingerprint, '0'.repeat(64)]
    ]) {
      await expect(loadAdoptionCompatibilityPlan(
        first.root, reviewFingerprint, destinationPlanFingerprint,
        saved.plan.report.fingerprint, first.source, now, first.storage
      )).rejects.toThrow(/invalid|different identities/);
    }
    await expect(loadAdoptionCompatibilityPlan(
      first.root, first.review.preview.fingerprint, first.saved.plan.report.fingerprint,
      'partial', first.source, now, first.storage
    )).rejects.toThrow(/complete/);
  });

  it('reports changed saved review and check metadata without repairing or trusting it', async () => {
    const input = await prepared();
    const saved = await saveAdoptionCompatibilityPlan(
      input.value, input.source, now, input.storage
    );
    const changed = JSON.stringify({
      ...saved.plan.report,
      checkExecution: 'performed',
      verification: { commands: [], preparation: [] }
    });
    await writeFile(saved.path, changed);
    await expect(loadAdoptionCompatibilityPlan(
      input.root, input.review.preview.fingerprint, input.saved.plan.report.fingerprint,
      saved.plan.report.fingerprint, input.source, now, input.storage
    )).rejects.toThrow(/invalid|stale|different/);
    expect(await readFile(saved.path, 'utf8')).toBe(changed);
    expect(await readdir(input.root)).not.toContain('liftoff.manifest.json');
  });
});
