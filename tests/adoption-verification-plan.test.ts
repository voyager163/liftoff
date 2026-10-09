import {
  mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import {
  saveAdoptionCompatibilityPlan, type AdoptionCompatibilityReview,
  type SavedAdoptionCompatibilityPlan
} from '../src/application/adoption/compatibility-plan.js';
import {
  saveAdoptionDestinationPlan, type SavedAdoptionDestinationPlan
} from '../src/application/adoption/destination-plan.js';
import {
  createAdoptionReview, saveAdoptionPreview, type AdoptionReviewInspection
} from '../src/application/adoption/preview.js';
import {
  loadAdoptionVerificationPlan, prepareAdoptionVerificationPlan,
  saveAdoptionVerificationPlan
} from '../src/application/adoption/verification-plan.js';
import {
  readAdoptionVerificationConsent, saveAdoptionVerificationConsent
} from '../src/application/adoption/verification-consent.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-07T14:00:00.000Z');

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

function compatibilityReview(
  review: AdoptionReviewInspection,
  destination: SavedAdoptionDestinationPlan,
  network: boolean
): AdoptionCompatibilityReview {
  const inventory = review.report.inventory;
  const backend = inventory.files.find(file =>
    file.currentTargetLogicalName !== null && file.currentTargetLogicalName !== 'root-readme');
  if (!backend) throw new Error('Missing backend fixture.');
  return {
    schemaVersion: 1,
    kind: 'liftoff-adoption-compatibility-review',
    projectRoot: inventory.projectRoot,
    reviewFingerprint: review.preview.fingerprint,
    destinationPlanFingerprint: destination.plan.report.fingerprint,
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
    verification: {
      commands: [{
        executable: 'node',
        args: [backend.pathParts.join('/')],
        cwdPathParts: [],
        timeoutMs: 30_000,
        maxOutputBytes: 16_384,
        network
      }],
      preparation: []
    }
  };
}

async function prepared(network = false) {
  const root = await directory('lf adoption verification ');
  const home = await directory('lf adoption verification home ');
  const storage: UpdatePreviewOptions = { homedir: home, env: {}, clock: () => now };
  const value = adoptionFixture('node-fastify', 'single-maintainer-gitflow', 'openspec');
  const backend = value.request.adoptionObservations.find(entry => entry.logicalName !== 'root-readme');
  if (!backend) throw new Error('Missing backend fixture.');
  await put(root, backend.pathParts, 'PRIVATE_INVALID_IF_EXECUTED\n');
  await put(root, ['README.md'], `Preserved application: "${backend.pathParts.join('/')}"\n`);
  const review = await createAdoptionReview(root, value.source, now);
  await saveAdoptionPreview(review.preview, now, storage);
  const destination = await saveAdoptionDestinationPlan(
    root, review.preview.fingerprint, value.source, now, storage
  );
  const document = compatibilityReview(review, destination, network);
  const compatibility = await saveAdoptionCompatibilityPlan(
    document, value.source, now, storage
  );
  return {
    root, home, storage, source: value.source, backend, review, destination,
    compatibility, document
  };
}

async function plan(input: Awaited<ReturnType<typeof prepared>>) {
  return prepareAdoptionVerificationPlan(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    input.source,
    now,
    input.storage
  );
}

async function save(input: Awaited<ReturnType<typeof prepared>>) {
  return saveAdoptionVerificationPlan(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    input.source,
    now,
    input.storage
  );
}

async function load(
  input: Awaited<ReturnType<typeof prepared>>,
  saved: Awaited<ReturnType<typeof save>>,
  source: unknown = input.source,
  clock = now,
  inspection: Parameters<typeof loadAdoptionVerificationPlan>[8] = {}
) {
  return loadAdoptionVerificationPlan(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    saved.plan.report.fingerprint,
    source,
    clock,
    input.storage,
    inspection
  );
}

async function grant(
  input: Awaited<ReturnType<typeof prepared>>,
  saved: Awaited<ReturnType<typeof save>>,
  request: {
    projectCode: boolean;
    dependencyPreparation: boolean;
    declaredNetwork: boolean;
  }
) {
  return saveAdoptionVerificationConsent(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    saved.plan.report.fingerprint,
    input.source,
    now,
    request,
    input.storage
  );
}

async function readConsent(
  input: Awaited<ReturnType<typeof prepared>>,
  saved: Awaited<ReturnType<typeof save>>,
  clock = now
) {
  return readAdoptionVerificationConsent(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    saved.plan.report.fingerprint,
    input.source,
    clock,
    input.storage
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('adoption verification planning without effect or transaction authority', () => {
  it('binds current private source and exact installed tools without running project code', async () => {
    const input = await prepared();
    const before = await readFile(path.join(input.root, ...input.backend.pathParts));
    const entries = await readdir(input.root);
    const verification = await plan(input);
    expect(verification.report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-verification-plan',
      readOnly: true,
      projectRoot: input.root,
      reviewFingerprint: input.review.preview.fingerprint,
      destinationPlanFingerprint: input.destination.plan.report.fingerprint,
      compatibilityPlanFingerprint: input.compatibility.plan.report.fingerprint,
      status: 'ready-for-independent-permission',
      requiredPermissions: ['project-code-execution'],
      compatibility: 'not-verified',
      preparation: 'not-performed',
      checkExecution: 'not-performed',
      approval: 'not-requested',
      transaction: 'not-authorized',
      publication: 'not-authorized'
    });
    expect(verification.report.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification.verificationPolicy).toMatchObject({
      kind: 'isolated-application-checks',
      commands: [{ executable: 'node', network: false }],
      preparation: [],
      toolchain: [{ id: 'node', version: expect.any(String) }],
      effects: {
        projectCode: true,
        preparation: false,
        lifecycle: false,
        isolatedCopy: true,
        network: false,
        securitySandbox: false
      }
    });
    expect(Object.keys(verification)).toEqual(['report']);
    expect(JSON.stringify(verification)).not.toContain('PRIVATE_');
    expect(JSON.stringify(verification)).not.toContain('"verificationPolicy":');
    expect(await readFile(path.join(input.root, ...input.backend.pathParts))).toEqual(before);
    expect(await readdir(input.root)).toEqual(entries);

    const firstPolicy = verification.verificationPolicy;
    firstPolicy.commands[0]!.args[0] = 'changed';
    expect(verification.verificationPolicy.commands[0]!.args[0]).not.toBe('changed');
    const firstSnapshot = verification.snapshots[0]!;
    const original = Buffer.from(firstSnapshot.content!);
    firstSnapshot.content![0] ^= 0xff;
    expect(verification.snapshots[0]!.content).toEqual(original);
  });

  it('retains declared-network as a separate unperformed permission', async () => {
    const input = await prepared(true);
    const verification = await plan(input);
    expect(verification.report.requiredPermissions).toEqual([
      'project-code-execution', 'declared-network'
    ]);
    expect(verification.verificationPolicy.effects.network).toBe(true);
    expect(verification.report.checkExecution).toBe('not-performed');
    expect(verification.report.transaction).toBe('not-authorized');
  });

  it('saves only the report and reconstructs current private policy and snapshots on load', async () => {
    const input = await prepared();
    const saved = await save(input);
    expect(path.relative(input.home, saved.path).startsWith('..')).toBe(false);
    expect(path.basename(saved.path)).toMatch(/^adoption-verification-plan-/u);
    expect(Object.keys(saved.plan)).toEqual(['report']);
    const loaded = await load(input, saved);
    expect(loaded.report).toEqual(saved.plan.report);
    expect(loaded.snapshots).toEqual(saved.plan.snapshots);
    expect(loaded.verificationPolicy).toEqual(saved.plan.verificationPolicy);
    expect((await save(input)).path).toBe(saved.path);
    const text = await readFile(saved.path, 'utf8');
    expect(text).not.toContain('PRIVATE_');
    expect(text).not.toContain('"snapshots":');
    expect(text).not.toContain('"verificationPolicy":');
    if (process.platform !== 'win32') {
      expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(['application', 'destination', 'source', 'expired', 'tool'] as const)(
    'refuses a saved verification plan after %s identity changes',
    async change => {
      const input = await prepared();
      const saved = await save(input);
      let source: unknown = input.source;
      let clock = now;
      let inspection: Parameters<typeof loadAdoptionVerificationPlan>[8] = {};
      if (change === 'application') {
        await put(input.root, input.backend.pathParts, 'PRIVATE_CHANGED_APPLICATION\n');
      }
      if (change === 'destination') {
        const destination = input.destination.plan.report.destinations[0]!;
        await put(input.root, destination.pathParts, 'PRIVATE_CHANGED_DESTINATION\n');
      }
      if (change === 'source') {
        source = adoptionFixture('python-fastapi').source;
      }
      if (change === 'expired') {
        clock = new Date(now.getTime() + 15 * 60_000);
      }
      if (change === 'tool') {
        inspection = { env: { ...process.env, PATH: '' } };
      }
      await expect(load(input, saved, source, clock, inspection)).rejects.toThrow();
      expect(JSON.stringify(saved.plan)).not.toContain('PRIVATE_');
    }
  );

  it('isolates namespaces/projects/keys and rejects modified stored metadata', async () => {
    const first = await prepared(), second = await prepared();
    const preparedPlan = await plan(first);
    await createScopedUserLocalRecordStore(
      first.root, 'repair-verification', first.storage
    ).write(preparedPlan.report.fingerprint, preparedPlan.report);
    await expect(loadAdoptionVerificationPlan(
      first.root,
      first.review.preview.fingerprint,
      first.destination.plan.report.fingerprint,
      first.compatibility.plan.report.fingerprint,
      preparedPlan.report.fingerprint,
      first.source,
      now,
      first.storage
    )).rejects.toThrow(/No matching/u);

    const saved = await save(first);
    await expect(loadAdoptionVerificationPlan(
      second.root,
      first.review.preview.fingerprint,
      first.destination.plan.report.fingerprint,
      first.compatibility.plan.report.fingerprint,
      saved.plan.report.fingerprint,
      first.source,
      now,
      first.storage
    )).rejects.toThrow(/No matching/u);
    await expect(loadAdoptionVerificationPlan(
      first.root,
      first.review.preview.fingerprint,
      first.destination.plan.report.fingerprint,
      first.compatibility.plan.report.fingerprint,
      'partial',
      first.source,
      now,
      first.storage
    )).rejects.toThrow(/complete/u);

    const changed = JSON.stringify({
      ...saved.plan.report,
      checkExecution: 'passed',
      transaction: 'authorized'
    });
    await writeFile(saved.path, changed);
    await expect(load(first, saved)).rejects.toThrow(/invalid|stale|different/u);
    expect(await readFile(saved.path, 'utf8')).toBe(changed);
    expect(await readdir(first.root)).not.toContain('liftoff.manifest.json');
  });

  it('stores exact expiring verification scopes without granting success or transaction authority', async () => {
    const input = await prepared();
    const saved = await save(input);
    const before = await readFile(path.join(input.root, ...input.backend.pathParts));
    const granted = await grant(input, saved, {
      projectCode: true,
      dependencyPreparation: false,
      declaredNetwork: false
    });
    expect(path.basename(granted.path)).toMatch(/^adoption-verification-consent-/u);
    expect(granted.consent).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-verification-consent',
      projectRoot: input.root,
      verificationPlanFingerprint: saved.plan.report.fingerprint,
      verificationPolicyDigest: saved.plan.report.verificationPolicyDigest,
      permissions: {
        projectCode: true,
        dependencyPreparation: false,
        declaredNetwork: false
      },
      result: 'granted-for-isolated-verification-only',
      compatibility: 'not-verified',
      transaction: 'not-authorized',
      publication: 'not-authorized'
    });
    expect(Object.isFrozen(granted.consent)).toBe(true);
    expect(Object.isFrozen(granted.consent.permissions)).toBe(true);
    expect(await readConsent(input, saved)).toEqual(granted.consent);
    expect((await grant(input, saved, granted.consent.permissions)).path).toBe(granted.path);
    expect(await readFile(path.join(input.root, ...input.backend.pathParts))).toEqual(before);
  });

  it('requires every displayed scope and rejects unused scope or hostile request objects', async () => {
    const input = await prepared();
    const saved = await save(input);
    for (const request of [
      { projectCode: false, dependencyPreparation: false, declaredNetwork: false },
      { projectCode: true, dependencyPreparation: true, declaredNetwork: false },
      { projectCode: true, dependencyPreparation: false, declaredNetwork: true }
    ]) {
      await expect(grant(input, saved, request)).rejects.toThrow(/exactly grant/u);
    }
    const get = vi.fn();
    const proxied = new Proxy({
      projectCode: true, dependencyPreparation: false, declaredNetwork: false
    }, {
      get(target, key, receiver) {
        get();
        return Reflect.get(target, key, receiver);
      }
    });
    await expect(saveAdoptionVerificationConsent(
      input.root,
      input.review.preview.fingerprint,
      input.destination.plan.report.fingerprint,
      input.compatibility.plan.report.fingerprint,
      saved.plan.report.fingerprint,
      input.source,
      now,
      proxied,
      input.storage
    )).rejects.toThrow(/plain fields/u);
    expect(get).not.toHaveBeenCalled();
  });

  it('grants declared network only for a plan that requires it and still performs no check', async () => {
    const input = await prepared(true);
    const saved = await save(input);
    const granted = await grant(input, saved, {
      projectCode: true,
      dependencyPreparation: false,
      declaredNetwork: true
    });
    expect(granted.consent.permissions.declaredNetwork).toBe(true);
    expect(granted.consent.compatibility).toBe('not-verified');
    expect(granted.consent.transaction).toBe('not-authorized');
  });

  it('rejects absent namespaces, expiry and modified consent metadata', async () => {
    const input = await prepared();
    const saved = await save(input);
    await createScopedUserLocalRecordStore(
      input.root, 'repair-approval', input.storage
    ).write(saved.plan.report.fingerprint, { unrelated: true });
    expect(await readConsent(input, saved)).toBeNull();

    const granted = await grant(input, saved, {
      projectCode: true,
      dependencyPreparation: false,
      declaredNetwork: false
    });
    await expect(readConsent(
      input, saved, new Date(now.getTime() + 15 * 60_000)
    )).rejects.toThrow();

    const changed = JSON.stringify({
      ...granted.consent,
      result: 'declared-checks-passed',
      transaction: 'authorized'
    });
    await writeFile(granted.path, changed);
    await expect(readConsent(input, saved)).rejects.toThrow(/invalid|stale|different/u);
    expect(await readFile(granted.path, 'utf8')).toBe(changed);
  });
});
