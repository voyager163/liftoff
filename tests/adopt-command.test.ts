import {
  mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  saveAdoptionCompatibilityPlan,
  type AdoptionCompatibilityReview
} from '../src/application/adoption/compatibility-plan.js';
import {
  prepareAdoptionDestinationPlan, saveAdoptionDestinationPlan
} from '../src/application/adoption/destination-plan.js';
import {
  createAdoptionReview, saveAdoptionPreview,
  type AdoptionReviewInspection
} from '../src/application/adoption/preview.js';
import {
  prepareAdoptionLayoutPlan
} from '../src/application/adoption/layout-plan.js';
import {
  saveAdoptionPublicationPlan
} from '../src/application/adoption/publication-plan.js';
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
  parseProjectManifest
} from '../src/application/project/manifest.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import {
  modernProjectSourceInput
} from '../src/application/project/source-context.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { optionsFromParsedArgs } from '../src/cli/project-options.js';
import { CaptureStream } from './helpers.js';
import {
  projectMutationLockPath
} from '../src/adapters/filesystem/project-lock.js';

const roots: string[] = [];
const now = new Date('2026-10-19T06:00:00.000Z');
const selection = [
  '--type', 'standard',
  '--api', 'node',
  '--cloud', 'azure',
  '--region', 'eastus',
  '--environments', 'dev',
  '--spec', 'manual',
  '--agents', 'none',
  '--governance', 'none',
  '--no-frontend'
] as const;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function fixture(options: { manifest?: boolean } = {}) {
  const root = await directory('liftoff-adopt-command-');
  const home = await directory('liftoff-adopt-home-');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const targetOptions = await optionsFromParsedArgs(
    parseArgs(['plan', ...selection]),
    root,
    false
  );
  const plan = buildCurrentProjectPlan({
    ...targetOptions,
    projectName: path.basename(root)
  }, { requireProjectName: true });
  for (const artifact of buildCurrentArtifacts(plan)) {
    if (artifact.logicalName === 'manifest' && !options.manifest) continue;
    const target = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
  }
  const manifest = buildCurrentArtifacts(plan).find(
    artifact => artifact.logicalName === 'manifest'
  );
  if (!manifest) throw new Error('Missing command fixture manifest source.');
  return {
    root,
    home,
    source: modernProjectSourceInput(
      parseProjectManifest(JSON.parse(manifest.content) as unknown)
    )
  };
}

function compatibilityReview(
  review: AdoptionReviewInspection,
  destinationPlanFingerprint: string
): AdoptionCompatibilityReview {
  const inventory = review.report.inventory;
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
        args: ['verify.cjs'],
        cwdPathParts: [],
        timeoutMs: 30_000,
        maxOutputBytes: 16_384,
        network: false
      }],
      preparation: []
    }
  };
}

async function preparePublication(
  project: Awaited<ReturnType<typeof fixture>>
) {
  await writeFile(
    path.join(project.root, 'verify.cjs'),
    'if (!process.env.LIFTOFF_APPLICATION_VERIFICATION) process.exit(9);\n'
  );
  const storage = {
    homedir: project.home,
    env: {},
    clock: () => now
  };
  const layout = await prepareAdoptionLayoutPlan(
    project.root, project.source
  );
  if (!layout.source) {
    throw new Error('Command publication fixture has no supported layout.');
  }
  const source = layout.source;
  const review = await createAdoptionReview(
    project.root, source, now
  );
  await saveAdoptionPreview(review.preview, now, storage);
  const observedDestination = await prepareAdoptionDestinationPlan(
    review.preview, source, now
  );
  if (observedDestination.report.status !==
      'ready-for-independent-verification') {
    throw new Error(JSON.stringify(observedDestination.report.blockers));
  }
  const destination = await saveAdoptionDestinationPlan(
    project.root, review.preview.fingerprint, source, now, storage
  );
  const compatibility = await saveAdoptionCompatibilityPlan(
    compatibilityReview(review, destination.plan.report.fingerprint),
    source,
    now,
    storage
  );
  const verification = await saveAdoptionVerificationPlan(
    project.root,
    review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    source,
    now,
    storage
  );
  await saveAdoptionVerificationConsent(
    project.root,
    review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    verification.plan.report.fingerprint,
    source,
    now,
    {
      projectCode: true,
      dependencyPreparation: false,
      declaredNetwork: false
    },
    storage
  );
  const receipt = await executeAdoptionVerification(
    project.root,
    review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    verification.plan.report.fingerprint,
    source,
    { storage }
  );
  expect(receipt.status).toBe('passed');
  return saveAdoptionPublicationPlan({
    projectRoot: project.root,
    reviewFingerprint: review.preview.fingerprint,
    destinationPlanFingerprint: destination.plan.report.fingerprint,
    compatibilityPlanFingerprint: compatibility.plan.report.fingerprint,
    verificationPlanFingerprint: verification.plan.report.fingerprint
  }, source, { storage });
}

async function interruptPublication(
  project: Awaited<ReturnType<typeof fixture>>,
  publication: Awaited<ReturnType<typeof preparePublication>>
) {
  const transactionUrl = new URL(
    '../src/adapters/filesystem/reviewed-update-transaction.ts',
    import.meta.url
  ).href;
  const authorityUrl = new URL(
    '../src/application/adoption/transaction-authority.ts',
    import.meta.url
  ).href;
  const loaderUrl = new URL(
    './fixtures/source-typescript-loader.mjs',
    import.meta.url
  ).href;
  const mutations = publication.plan.mutations.map(mutation =>
    mutation.type === 'write'
      ? {
          ...mutation,
          content: Buffer.from(mutation.content).toString('base64')
        }
      : mutation
  );
  const preconditions = publication.plan.preconditions.map(snapshot => ({
    pathParts: snapshot.pathParts,
    ...(snapshot.content === undefined
      ? {}
      : { content: snapshot.content.toString('base64') }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  }));
  const inputPath = path.join(
    project.home,
    `interrupted-adoption-${publication.plan.report.fingerprint}.json`
  );
  await writeFile(inputPath, JSON.stringify({
    projectRoot: project.root,
    home: project.home,
    now: now.toISOString(),
    fingerprint: publication.plan.report.fingerprint,
    transactionCandidateBinding:
      publication.plan.report.transactionCandidateBinding,
    mutations,
    preconditions
  }));
  const child = spawnSync(
    process.execPath,
    ['--import', loaderUrl, '--input-type=module', '-e', `
      const { readFile } = await import('node:fs/promises');
      const { applyAdoptionTransaction } = await import(${JSON.stringify(transactionUrl)});
      const { createAdoptionTransactionAuthorityStore } = await import(${JSON.stringify(authorityUrl)});
      const input = JSON.parse(await readFile(process.argv[1], 'utf8'));
      const mutations = input.mutations.map(entry => entry.type === 'write'
        ? { ...entry, content: Buffer.from(entry.content, 'base64') }
        : entry);
      const preconditions = input.preconditions.map(entry => ({
        ...entry,
        ...(entry.content === undefined
          ? {}
          : { content: Buffer.from(entry.content, 'base64') })
      }));
      await applyAdoptionTransaction(
        input.projectRoot,
        mutations,
        {
          planFingerprint: input.fingerprint,
          authorityStore: createAdoptionTransactionAuthorityStore(
            input.projectRoot,
            {
              homedir: input.home,
              env: {},
              clock: () => new Date(input.now)
            }
          ),
          preconditions,
          expectedCandidateBinding: input.transactionCandidateBinding,
          validateCurrentInputs: async () => {},
          onCheckpoint: async checkpoint => {
            if (checkpoint.phase === 'prepared') process.exit(73);
          }
        }
      );
      process.exitCode = 9;
    `, inputPath],
    {
      encoding: 'utf8',
      timeout: 20_000,
      cwd: process.cwd()
    }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  await unlink(await projectMutationLockPath(project.root));
}

async function snapshot(root: string) {
  const entries = (await readdir(root, { recursive: true })).sort();
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const target = path.join(root, entry);
    try {
      files[entry] = (await readFile(target)).toString('base64');
    } catch {
      // Directories are represented by the recursive entry list.
    }
  }
  return { entries, files };
}

async function invoke(
  argv: string[],
  cwd: string,
  home: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(argv), {
    cwd,
    stdout,
    stderr,
    updateNow: () => now,
    updatePreview: { homedir: home, env: {}, clock: () => now }
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('public reviewed adoption command', () => {
  it('emits a schema-1 JSON preview, preserves project bytes, and saves only external review records', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const result = await invoke(
      ['adopt', project.root, ...selection, '--json'],
      path.dirname(project.root),
      project.home
    );
    expect(result).toMatchObject({ code: 2, stderr: '' });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption',
      command: 'adopt',
      operation: 'preview',
      readOnly: true,
      projectRoot: project.root,
      projectKind: 'git',
      status: 'compatibility-review-required',
      exitCode: 2,
      layoutPlan: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-layout-plan',
        status: 'ready-for-candidate-inspection',
        compatibility: 'not-verified',
        deployment: 'planning-only',
        gitHistory: 'not-read-or-modified'
      },
      mappingReview: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-mapping-review',
        status: 'explicit-review-required',
        dynamicReferencesReviewed: false,
        verificationSelection: 'not-provided',
        compatibility: 'not-verified',
        publication: 'not-authorized'
      },
      review: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-preview',
        projectRoot: project.root,
        verification: 'not-performed',
        publication: 'not-authorized'
      },
      destinationPlan: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-destination-plan',
        status: 'ready-for-independent-verification',
        verification: 'not-performed',
        approval: 'not-requested',
        publication: 'not-authorized'
      },
      approval: { requestedFingerprint: null, status: 'not-requested' },
      recovery: { requested: false, status: 'not-requested' }
    });
    expect(report.candidate.status).toBe('candidate-observed-unverified');
    expect(report.destinationPlan.blockers).toEqual([]);
    expect(report.layoutPlan.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'observed-preserved' }),
      expect.objectContaining({ status: 'planning-only-excluded' })
    ]));
    expect(await snapshot(project.root)).toEqual(before);
    expect(await readdir(project.home, { recursive: true })).not.toEqual([]);
  });

  it('keeps bare non-TTY execution preview-only and emits no approval-shaped result', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const result = await invoke(
      ['adopt', '--project', project.root, ...selection],
      project.root,
      project.home
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Reviewed in-place adoption');
    expect(result.stdout).toContain('compatibility-review-required');
    expect(result.stdout).toContain('Mapping review');
    expect(result.stdout).toContain('Per-file review draft');
    expect(result.stdout).toContain('Reference review draft');
    expect(result.stdout).toContain('grants no verification, file approval');
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('applies only the exact externally verified publication plan and reports independent readback', async () => {
    const project = await fixture();
    const statePath = path.join(project.root, 'terraform.tfstate');
    const statePayload = '{"private":"deployment-state-must-not-be-read-or-written"}\n';
    await writeFile(statePath, statePayload, { mode: 0o600 });
    const publication = await preparePublication(project);
    const verificationBefore = await stat(
      path.join(project.root, 'verify.cjs')
    );
    const stateBefore = await stat(statePath);
    const result = await invoke(
      [
        'adopt', '--project', project.root, ...selection,
        '--approve-plan', publication.plan.report.fingerprint, '--json'
      ],
      project.root,
      project.home
    );
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).not.toContain('deployment-state-must-not-be-read-or-written');
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: 'approve',
      readOnly: false,
      projectRoot: project.root,
      projectKind: 'git',
      status: 'applied',
      exitCode: 0,
      publicationPlan: {
        fingerprint: publication.plan.report.fingerprint,
        status: 'ready-for-file-approval',
        manifestPublishedLast: true
      },
      approval: {
        requestedFingerprint: publication.plan.report.fingerprint,
        status: 'approved-exact-plan'
      },
      transaction: {
        status: 'committed',
        committed: true,
        transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        readbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rollbackFailures: [],
        cleanupFailures: []
      }
    });
    expect(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'), 'utf8'
    )).artifactVersion).toBe(8);
    const verificationAfter = await stat(
      path.join(project.root, 'verify.cjs')
    );
    expect({
      ino: verificationAfter.ino,
      mode: verificationAfter.mode,
      mtimeMs: verificationAfter.mtimeMs
    }).toEqual({
      ino: verificationBefore.ino,
      mode: verificationBefore.mode,
      mtimeMs: verificationBefore.mtimeMs
    });
    const stateAfter = await stat(statePath);
    expect(await readFile(statePath, 'utf8')).toBe(statePayload);
    expect({
      ino: stateAfter.ino,
      mode: stateAfter.mode,
      mtimeMs: stateAfter.mtimeMs
    }).toEqual({
      ino: stateBefore.ino,
      mode: stateBefore.mode,
      mtimeMs: stateBefore.mtimeMs
    });
    const recovery = await invoke(
      [
        'adopt', '--project', project.root, '--recover',
        '--approve-plan', publication.plan.report.fingerprint, '--json'
      ],
      project.root,
      project.home
    );
    expect(recovery.code).toBe(1);
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      operation: 'recover',
      status: 'recovery-unavailable',
      transaction: { status: 'absent', committed: false }
    });
  }, 120_000);

  it('fails closed on unknown approval and recovery before touching a selected project', async () => {
    const home = await directory('liftoff-adopt-authority-home-');
    const missing = path.join(await directory('liftoff-adopt-authority-parent-'), 'missing');
    const fingerprint = 'a'.repeat(64);
    const approval = await invoke(
      ['adopt', '--project', missing, '--approve-plan', fingerprint, '--json'],
      path.dirname(missing),
      home
    );
    expect(approval.code).toBe(1);
    expect(JSON.parse(approval.stdout)).toMatchObject({
      operation: 'approve',
      status: 'error',
      approval: {
        requestedFingerprint: fingerprint,
        status: 'unavailable-before-complete-plan'
      }
    });
    const recovery = await invoke(
      ['adopt', '--project', missing, '--recover', '--approve-plan', fingerprint, '--json'],
      path.dirname(missing),
      home
    );
    expect(recovery.code).toBe(1);
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      operation: 'recover',
      status: 'error',
      recovery: {
        requested: true,
        status: 'unavailable-before-authenticated-transaction'
      }
    });
    await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(home)).toEqual([]);
  });

  it('recovers only the fingerprint-selected authenticated adoption transaction', async () => {
    const project = await fixture();
    const publication = await preparePublication(project);
    await interruptPublication(project, publication);
    const result = await invoke(
      [
        'adopt', '--project', project.root, '--recover',
        '--approve-plan', publication.plan.report.fingerprint, '--json'
      ],
      project.root,
      project.home
    );
    expect(result).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: 'recover',
      readOnly: false,
      projectRoot: project.root,
      status: 'recovered',
      exitCode: 2,
      recovery: { requested: true, status: 'recovered' },
      transaction: {
        status: 'rolled-back',
        committed: false,
        transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rollbackFailures: [],
        cleanupFailures: []
      }
    });
    await expect(readFile(
      path.join(project.root, 'liftoff.manifest.json')
    )).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('routes an existing Liftoff project to update and repair without re-adoption', async () => {
    const project = await fixture({ manifest: true });
    const before = await snapshot(project.root);
    const result = await invoke(
      ['adopt', project.root, ...selection, '--json'],
      project.root,
      project.home
    );
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      projectKind: 'liftoff',
      status: 'existing-liftoff-project',
      review: null,
      destinationPlan: null
    });
    expect(report.nextActions.map((action: { command: string[] }) => action.command.slice(0, 2)))
      .toEqual([['liftoff', 'update'], ['liftoff', 'repair']]);
    expect(await snapshot(project.root)).toEqual(before);
    expect(await readdir(project.home)).toEqual([]);
  });

  it('requires an explicit path for a non-Git application boundary', async () => {
    const root = await directory('liftoff-adopt-non-git-');
    const home = await directory('liftoff-adopt-non-git-home-');
    await writeFile(path.join(root, 'README.md'), 'application\n');
    const implicit = await invoke(['adopt', ...selection, '--json'], root, home);
    expect(implicit.code).toBe(1);
    expect(JSON.parse(implicit.stdout)).toMatchObject({ status: 'error', projectKind: 'unavailable' });
    const explicit = await invoke(['adopt', root, ...selection, '--json'], root, home);
    expect(explicit.code).toBe(2);
    expect(JSON.parse(explicit.stdout)).toMatchObject({
      projectRoot: root,
      projectKind: 'explicit-non-git',
      status: 'blocked',
      layoutPlan: {
        status: 'blocked',
        blockers: [{ code: 'supported-application-binding-unobserved' }]
      },
      mappingReview: null,
      review: null,
      candidate: null,
      destinationPlan: null
    });
  });

  it('rejects contradictory or malformed authority syntax during parsing', () => {
    const fingerprint = 'a'.repeat(64);
    for (const argv of [
      ['adopt', '.', '--project', '.'],
      ['adopt', '--approve-plan', 'short'],
      ['adopt', '--check', '--approve-plan', fingerprint],
      ['adopt', '--check', '--recover', '--approve-plan', fingerprint],
      ['adopt', '--recover'],
      ['adopt', '--yes'],
      ['adopt', '--force'],
      ['adopt', '--state', 'terraform.tfstate'],
      ['adopt', '--import', 'resource.id'],
      ['adopt', '--apply'],
      ['adopt', '--destroy'],
      ['adopt', '--register-provider'],
      ['adopt', '--enroll-credential'],
      ['adopt', '--configure-openspec-profile']
    ]) {
      expect(() => parseArgs(argv)).toThrow();
    }
  });
});
