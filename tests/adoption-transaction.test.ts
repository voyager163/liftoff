import {
  mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAdoptionTransaction,
  applyReviewedUpdateTransaction,
  inspectAdoptionTransaction,
  inspectAdoptionTransactionCandidate,
  inspectReviewedUpdateCandidate,
  recoverAdoptionTransaction,
  reviewedAdoptionTransactionPathParts
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import {
  captureProjectFileSnapshot
} from '../src/adapters/filesystem/project-transaction.js';
import {
  projectMutationLockPath
} from '../src/adapters/filesystem/project-lock.js';
import {
  createUpdateTransactionApprovalStore
} from '../src/adapters/filesystem/update-previews.js';
import {
  createAdoptionTransactionAuthorityStore
} from '../src/application/adoption/transaction-authority.js';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'liftoff-adoption-transaction-'));
  roots.push(parent);
  const selectedRoot = path.join(parent, 'project with spaces');
  const home = path.join(parent, 'home');
  await mkdir(selectedRoot);
  await mkdir(home);
  const root = await realpath(selectedRoot);
  await writeFile(path.join(root, 'application.ts'), 'project owned application\n', {
    mode: 0o640
  });
  const preconditions = [
    await captureProjectFileSnapshot(root, ['application.ts']),
    await captureProjectFileSnapshot(root, ['liftoff.config.json']),
    await captureProjectFileSnapshot(root, ['liftoff.manifest.json'])
  ];
  const mutations = [
    {
      type: 'write' as const,
      pathParts: ['liftoff.config.json'],
      content: '{"adopted":true}\n'
    },
    {
      type: 'write' as const,
      pathParts: ['liftoff.manifest.json'],
      content: '{"artifactVersion":8}\n'
    }
  ];
  const options = { homedir: home, env: {} };
  const authorityStore = createAdoptionTransactionAuthorityStore(root, options);
  return { parent, root, home, options, authorityStore, preconditions, mutations };
}

async function interrupted(
  phase: 'prepared' | 'before-mutation' | 'after-mutation',
  index?: number
) {
  const input = await fixture();
  const candidate = await inspectAdoptionTransactionCandidate(
    input.root, input.mutations, input.preconditions
  );
  const moduleUrl = new URL(
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
  const mutations = input.mutations.map(mutation => mutation.type === 'write'
    ? {
        ...mutation,
        content: Buffer.from(mutation.content).toString('base64')
      }
    : mutation);
  const preconditions = input.preconditions.map(snapshot => ({
    pathParts: snapshot.pathParts,
    ...(snapshot.content === undefined
      ? {}
      : { content: snapshot.content.toString('base64') }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  }));
  const child = spawnSync(
    process.execPath,
    ['--import', loaderUrl, '--input-type=module', '-e', `
      const { applyAdoptionTransaction } = await import(${JSON.stringify(moduleUrl)});
      const { createAdoptionTransactionAuthorityStore } = await import(${JSON.stringify(authorityUrl)});
      const mutations = ${JSON.stringify(mutations)}.map(entry => entry.type === 'write'
        ? { ...entry, content: Buffer.from(entry.content, 'base64') }
        : entry);
      const preconditions = ${JSON.stringify(preconditions)}.map(entry => ({
        ...entry,
        ...(entry.content === undefined
          ? {}
          : { content: Buffer.from(entry.content, 'base64') })
      }));
      await applyAdoptionTransaction(
        ${JSON.stringify(input.root)},
        mutations,
        {
          planFingerprint: ${JSON.stringify(fingerprint)},
          authorityStore: createAdoptionTransactionAuthorityStore(
            ${JSON.stringify(input.root)},
            { homedir: ${JSON.stringify(input.home)}, env: {} }
          ),
          preconditions,
          expectedCandidateBinding: ${JSON.stringify(candidate.binding)},
          validateCurrentInputs: async () => {},
          onCheckpoint: async checkpoint => {
            if (checkpoint.phase === ${JSON.stringify(phase)} &&
                checkpoint.index === ${JSON.stringify(index)}) {
              process.exit(73);
            }
          }
        }
      );
      process.exitCode = 9;
    `],
    {
      encoding: 'utf8',
      timeout: 20_000,
      cwd: process.cwd()
    }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  return {
    ...input,
    lock: await projectMutationLockPath(input.root)
  };
}

describe('authenticated adoption transaction lane', () => {
  it('commits exact metadata with a distinct candidate, journal and external authority', async () => {
    const input = await fixture();
    const applicationBefore = await stat(path.join(input.root, 'application.ts'));
    const candidate = await inspectAdoptionTransactionCandidate(
      input.root, input.mutations, input.preconditions
    );
    expect(candidate.binding).toMatch(/^[a-f0-9]{64}$/u);
    expect(candidate.payload.transactionKind).toBe('adoption');
    const outcome = await applyAdoptionTransaction(input.root, input.mutations, {
      planFingerprint: fingerprint,
      authorityStore: input.authorityStore,
      preconditions: input.preconditions,
      expectedCandidateBinding: candidate.binding,
      validateCurrentInputs: async () => {}
    });
    expect(outcome).toMatchObject({ status: 'committed', committed: true });
    expect(await readFile(path.join(input.root, 'liftoff.config.json'), 'utf8'))
      .toBe('{"adopted":true}\n');
    expect(await readFile(path.join(input.root, 'liftoff.manifest.json'), 'utf8'))
      .toBe('{"artifactVersion":8}\n');
    expect(await readFile(path.join(input.root, 'application.ts'), 'utf8'))
      .toBe('project owned application\n');
    const applicationAfter = await stat(path.join(input.root, 'application.ts'));
    expect({
      ino: applicationAfter.ino,
      mode: applicationAfter.mode,
      mtimeMs: applicationAfter.mtimeMs
    }).toEqual({
      ino: applicationBefore.ino,
      mode: applicationBefore.mode,
      mtimeMs: applicationBefore.mtimeMs
    });
    expect(await inspectAdoptionTransaction(input.root, {
      authorityStore: input.authorityStore
    })).toMatchObject({ status: 'absent', committed: false });
    expect(outcome.transactionDigest &&
      await input.authorityStore.verify(fingerprint, outcome.transactionDigest))
      .toBe(false);
  });

  it('requires the dedicated root-bound adoption entrypoint and authority', async () => {
    const input = await fixture();
    await expect(applyReviewedUpdateTransaction(input.root, input.mutations, {
      transactionKind: 'adoption',
      planFingerprint: fingerprint,
      approvalStore: input.authorityStore,
      preconditions: input.preconditions
    })).rejects.toThrow('adoption requires its dedicated publication entrypoint');
    const updateStore = createUpdateTransactionApprovalStore(input.root, input.options);
    await expect(applyAdoptionTransaction(input.root, input.mutations, {
      planFingerprint: fingerprint,
      authorityStore: updateStore as typeof input.authorityStore,
      preconditions: input.preconditions,
      expectedCandidateBinding: 'b'.repeat(64),
      validateCurrentInputs: async () => {}
    })).rejects.toThrow('adoption requires dedicated authority');
    const other = await fixture();
    await expect(applyAdoptionTransaction(input.root, input.mutations, {
      planFingerprint: fingerprint,
      authorityStore: other.authorityStore,
      preconditions: input.preconditions,
      expectedCandidateBinding: 'b'.repeat(64),
      validateCurrentInputs: async () => {}
    })).rejects.toThrow('canonical project root');
  });

  it('blocks every new lane while an adoption recovery journal exists', async () => {
    const input = await fixture();
    const journal = path.join(input.root, ...reviewedAdoptionTransactionPathParts);
    await mkdir(path.dirname(journal), { recursive: true });
    await writeFile(journal, 'PRIVATE_INTERRUPTED_ADOPTION\n', { mode: 0o600 });
    await expect(inspectReviewedUpdateCandidate(
      input.root, input.mutations, input.preconditions
    )).rejects.toThrow('existing recovery journal blocks new work');
    await expect(inspectAdoptionTransactionCandidate(
      input.root, input.mutations, input.preconditions
    )).rejects.toThrow('existing recovery journal blocks new work');
    expect(await recoverAdoptionTransaction(input.root, {
      authorityStore: input.authorityStore
    })).toMatchObject({
      status: 'blocked',
      rollbackFailures: [expect.stringContaining('recovery journal')]
    });
    expect(await readFile(journal, 'utf8')).toBe('PRIVATE_INTERRUPTED_ADOPTION\n');
  });

  it.each([
    ['after-mutation', 0],
    ['before-mutation', 1]
  ] as const)(
    'recovers an authenticated interruption at %s/%s before the final manifest exists',
    async (phase, index) => {
      const input = await interrupted(phase, index);
      expect(await inspectAdoptionTransaction(input.root, {
        authorityStore: input.authorityStore
      })).toMatchObject({
        status: 'interrupted',
        committed: false,
        planFingerprint: fingerprint
      });
      await expect(readFile(
        path.join(input.root, 'liftoff.manifest.json')
      )).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(recoverAdoptionTransaction(input.root, {
        authorityStore: input.authorityStore
      })).rejects.toThrow('Another cooperating Liftoff mutation');
      await unlink(input.lock);
      expect(await recoverAdoptionTransaction(input.root, {
        authorityStore: input.authorityStore,
        expectedTransaction: {
          planFingerprint: fingerprint,
          transactionDigest: (await inspectAdoptionTransaction(input.root, {
            authorityStore: input.authorityStore
          })).transactionDigest!
        }
      })).toMatchObject({
        status: 'rolled-back',
        committed: false,
        rollbackFailures: [],
        cleanupFailures: []
      });
      await expect(readFile(
        path.join(input.root, 'liftoff.config.json')
      )).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(
        path.join(input.root, 'liftoff.manifest.json')
      )).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('preserves a concurrent edit and leaves interrupted adoption recovery blocking', async () => {
    const input = await interrupted('after-mutation', 0);
    await unlink(input.lock);
    await writeFile(
      path.join(input.root, 'liftoff.config.json'),
      'concurrent developer edit\n'
    );
    const observed = await inspectAdoptionTransaction(input.root, {
      authorityStore: input.authorityStore
    });
    expect(await recoverAdoptionTransaction(input.root, {
      authorityStore: input.authorityStore,
      expectedTransaction: {
        planFingerprint: fingerprint,
        transactionDigest: observed.transactionDigest!
      }
    })).toMatchObject({
      status: 'blocked',
      committed: false,
      rollbackFailures: [
        expect.stringContaining('liftoff.config.json')
      ]
    });
    expect(await readFile(
      path.join(input.root, 'liftoff.config.json'), 'utf8'
    )).toBe('concurrent developer edit\n');
    await expect(readFile(
      path.join(input.root, 'liftoff.manifest.json')
    )).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inspectAdoptionTransaction(input.root, {
      authorityStore: input.authorityStore
    })).toMatchObject({ status: 'interrupted', committed: false });
  });
});
