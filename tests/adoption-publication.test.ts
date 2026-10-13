import {
  mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAdoptionTransaction, reviewedAdoptionTransactionPathParts
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import type {
  UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import {
  saveAdoptionCompatibilityPlan,
  type AdoptionCompatibilityReview
} from '../src/application/adoption/compatibility-plan.js';
import {
  saveAdoptionDestinationPlan
} from '../src/application/adoption/destination-plan.js';
import {
  saveAdoptionPreview, createAdoptionReview,
  type AdoptionReviewInspection
} from '../src/application/adoption/preview.js';
import {
  loadAdoptionPublicationPlan, saveAdoptionPublicationPlan,
  validateAdoptionPublicationPlanReport
} from '../src/application/adoption/publication-plan.js';
import {
  publishAdoptionPlan, recoverAdoptionPlan
} from '../src/application/adoption/publication.js';
import {
  executeAdoptionVerification
} from '../src/application/adoption/verification-execution.js';
import {
  saveAdoptionVerificationConsent
} from '../src/application/adoption/verification-consent.js';
import {
  saveAdoptionVerificationPlan
} from '../src/application/adoption/verification-plan.js';
import {
  createAdoptionTransactionAuthorityStore
} from '../src/application/adoption/transaction-authority.js';
import {
  canonicalSha256
} from '../src/domain/governance/activation/canonical-json.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-07T15:00:00.000Z');

async function directory(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function put(
  root: string, pathParts: readonly string[], content: string
) {
  const filename = path.join(root, ...pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { mode: 0o640 });
}

function compatibilityReview(
  review: AdoptionReviewInspection,
  destinationPlanFingerprint: string
): AdoptionCompatibilityReview {
  const inventory = review.report.inventory;
  const backend = inventory.files.find(file =>
    file.currentTargetLogicalName !== null &&
    file.currentTargetLogicalName !== 'root-readme'
  );
  if (!backend) throw new Error('Missing backend publication fixture.');
  return {
    schemaVersion: 1,
    kind: 'liftoff-adoption-compatibility-review',
    projectRoot: inventory.projectRoot,
    reviewFingerprint: review.preview.fingerprint,
    destinationPlanFingerprint,
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
        ? {
            kind: 'custom-component',
            logicalName: `custom-file-${index + 1}`
          }
        : {
            kind: 'active-binding',
            logicalName: file.currentTargetLogicalName
          }
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
        network: false
      }],
      preparation: []
    }
  };
}

function refingerprint(
  value: Record<string, unknown>
): Record<string, unknown> & { fingerprint: string } {
  const { fingerprint: _fingerprint, ...body } = value;
  return { ...body, fingerprint: canonicalSha256(body) };
}

async function prepared() {
  const root = await directory('lf adoption publication ');
  const home = await directory('lf adoption publication home ');
  const storage: UpdatePreviewOptions = {
    homedir: home,
    env: {},
    clock: () => now
  };
  const fixture = adoptionFixture(
    'node-fastify', 'single-maintainer-gitflow', 'openspec'
  );
  const backend = fixture.request.adoptionObservations.find(entry =>
    entry.logicalName !== 'root-readme'
  );
  if (!backend) throw new Error('Missing backend fixture.');
  await put(
    root,
    backend.pathParts,
    'if (!process.env.LIFTOFF_APPLICATION_VERIFICATION) process.exit(9);\n'
  );
  await put(
    root,
    ['README.md'],
    `Preserved application: "${backend.pathParts.join('/')}"\n`
  );
  const review = await createAdoptionReview(root, fixture.source, now);
  await saveAdoptionPreview(review.preview, now, storage);
  const destination = await saveAdoptionDestinationPlan(
    root, review.preview.fingerprint, fixture.source, now, storage
  );
  const compatibility = await saveAdoptionCompatibilityPlan(
    compatibilityReview(review, destination.plan.report.fingerprint),
    fixture.source,
    now,
    storage
  );
  const verification = await saveAdoptionVerificationPlan(
    root,
    review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    fixture.source,
    now,
    storage
  );
  await saveAdoptionVerificationConsent(
    root,
    review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    verification.plan.report.fingerprint,
    fixture.source,
    now,
    {
      projectCode: true,
      dependencyPreparation: false,
      declaredNetwork: false
    },
    storage
  );
  const receipt = await executeAdoptionVerification(
    root,
    review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    verification.plan.report.fingerprint,
    fixture.source,
    { storage }
  );
  if (receipt.status !== 'passed' || !receipt.receiptFingerprint) {
    throw new Error('Publication fixture verification did not pass.');
  }
  const identity = {
    projectRoot: root,
    reviewFingerprint: review.preview.fingerprint,
    destinationPlanFingerprint: destination.plan.report.fingerprint,
    compatibilityPlanFingerprint: compatibility.plan.report.fingerprint,
    verificationPlanFingerprint: verification.plan.report.fingerprint
  };
  const publication = await saveAdoptionPublicationPlan(
    identity, fixture.source, { storage }
  );
  return {
    root, home, storage, source: fixture.source, backend, identity,
    receipt, publication
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe('verified adoption publication planning and execution', () => {
  it('persists only a deterministic public exact-effect plan and rebuilds private bytes', async () => {
    const input = await prepared();
    const report = input.publication.plan.report;
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-publication-plan',
      readOnly: true,
      projectRoot: input.root,
      verificationReceiptFingerprint: input.receipt.receiptFingerprint,
      status: 'ready-for-file-approval',
      requiredPermissions: ['file-transaction'],
      approval: 'not-requested',
      transaction: 'not-started',
      application: {
        status: 'preserved-current-bytes-modes-and-paths',
        moveCount: 0,
        referenceUpdateCount: 0
      },
      manifestPublishedLast: true,
      recovery: {
        transactionKind: 'adoption',
        journalPathParts: reviewedAdoptionTransactionPathParts
      },
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(report.effects.at(-1)).toMatchObject({
      kind: 'manifest',
      pathParts: ['liftoff.manifest.json']
    });
    expect(report.transactionCandidateBinding).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.preconditionCount).toBeGreaterThan(report.effects.length);
    expect(Object.keys(input.publication.plan)).toEqual(['report']);
    expect(JSON.stringify(input.publication.plan)).not.toContain(
      'LIFTOFF_APPLICATION_VERIFICATION'
    );
    const loaded = await loadAdoptionPublicationPlan(
      input.root, report.fingerprint, input.source,
      { storage: input.storage }
    );
    expect(loaded.report).toEqual(report);
    expect(loaded.mutations.at(-1)?.pathParts)
      .toEqual(['liftoff.manifest.json']);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.effects)).toBe(true);
  }, 120_000);

  it('publishes exact managed metadata with the manifest last and preserves application identity', async () => {
    const input = await prepared();
    const applicationPath = path.join(
      input.root, ...input.backend.pathParts
    );
    const before = await stat(applicationPath);
    const result = await publishAdoptionPlan(
      input.root,
      input.publication.plan.report.fingerprint,
      input.source,
      { storage: input.storage }
    );
    expect(result).toMatchObject({
      operation: 'publish',
      status: 'committed',
      committed: true,
      publicationPlanFingerprint:
        input.publication.plan.report.fingerprint,
      transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      readbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      rollbackFailures: [],
      cleanupFailures: []
    });
    for (const effect of input.publication.plan.report.effects) {
      expect(await readFile(path.join(input.root, ...effect.pathParts)))
        .toHaveLength(effect.contentBytes);
    }
    const after = await stat(applicationPath);
    expect({
      ino: after.ino,
      mode: after.mode,
      mtimeMs: after.mtimeMs
    }).toEqual({
      ino: before.ino,
      mode: before.mode,
      mtimeMs: before.mtimeMs
    });
    await expect(readFile(path.join(
      input.root, ...reviewedAdoptionTransactionPathParts
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoverAdoptionPlan(
      input.root,
      input.publication.plan.report.fingerprint,
      { storage: input.storage }
    )).toMatchObject({
      operation: 'recover',
      status: 'absent',
      committed: false
    });
  }, 120_000);

  it('rejects duplicate manifest effects and platform-folded path collisions', async () => {
    const input = await prepared();
    const duplicateManifest = structuredClone(
      input.publication.plan.report
    ) as unknown as Record<string, unknown>;
    const duplicateEffects = duplicateManifest.effects as Array<
      Record<string, unknown>
    >;
    duplicateEffects[0] = {
      ...duplicateEffects[0],
      kind: 'manifest'
    };
    expect(() => validateAdoptionPublicationPlanReport(
      refingerprint(duplicateManifest), input.root
    )).toThrow(/invalid/u);

    const aliasCollision = structuredClone(
      input.publication.plan.report
    ) as unknown as Record<string, unknown>;
    const aliasEffects = aliasCollision.effects as Array<
      Record<string, unknown>
    >;
    aliasEffects[0] = {
      ...aliasEffects[0],
      pathParts: ['LIFTOFF.MANIFEST.JSON']
    };
    expect(() => validateAdoptionPublicationPlanReport(
      refingerprint(aliasCollision), input.root
    )).toThrow(/invalid/u);
  }, 120_000);

  it('reports committed readback failure separately from transaction cleanup', async () => {
    const input = await prepared();
    const plan = input.publication.plan;
    const authorityStore = createAdoptionTransactionAuthorityStore(
      input.root, input.storage
    );
    const altered = plan.report.effects[0];
    if (!altered) throw new Error('Missing publication effect fixture.');
    const transaction = await applyAdoptionTransaction(
      input.root,
      plan.mutations,
      {
        planFingerprint: plan.report.fingerprint,
        authorityStore,
        preconditions: plan.preconditions,
        expectedCandidateBinding: plan.report.transactionCandidateBinding,
        validateCurrentInputs: async () => {},
        onCheckpoint: async checkpoint => {
          if (checkpoint.phase !== 'committed') return;
          await writeFile(
            path.join(input.root, ...altered.pathParts),
            'concurrent committed edit\n'
          );
          throw new Error('injected finalization interruption');
        }
      }
    );
    expect(transaction).toMatchObject({
      committed: true,
      cleanupFailures: [
        expect.stringContaining('injected finalization interruption')
      ]
    });
    expect(await recoverAdoptionPlan(
      input.root,
      plan.report.fingerprint,
      { storage: input.storage }
    )).toMatchObject({
      status: 'committed-readback-failed',
      committed: true,
      cleanupFailures: [],
      readbackFailures: [
        expect.stringContaining(altered.pathParts.join('/'))
      ]
    });
  }, 120_000);

  it('rejects stale application bytes, expired authority and modified saved metadata before effects', async () => {
    const stale = await prepared();
    await put(
      stale.root,
      stale.backend.pathParts,
      'console.log("developer changed the application");\n'
    );
    await expect(publishAdoptionPlan(
      stale.root,
      stale.publication.plan.report.fingerprint,
      stale.source,
      { storage: stale.storage }
    )).rejects.toThrow();
    await expect(readFile(
      path.join(stale.root, 'liftoff.manifest.json')
    )).rejects.toMatchObject({ code: 'ENOENT' });

    const expired = await prepared();
    await expect(loadAdoptionPublicationPlan(
      expired.root,
      expired.publication.plan.report.fingerprint,
      expired.source,
      {
        storage: {
          homedir: expired.home,
          env: {},
          clock: () => new Date('2099-01-01T00:00:00.000Z')
        }
      }
    )).rejects.toThrow(/stale|expired|invalid/u);

    const modified = await prepared();
    await writeFile(
      modified.publication.path,
      JSON.stringify({
        ...modified.publication.plan.report,
        transactionCandidateBinding: '0'.repeat(64)
      })
    );
    await expect(loadAdoptionPublicationPlan(
      modified.root,
      modified.publication.plan.report.fingerprint,
      modified.source,
      { storage: modified.storage }
    )).rejects.toThrow(/fingerprint|invalid/u);
    await expect(readFile(
      path.join(modified.root, 'liftoff.manifest.json')
    )).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});
