import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedArtifact } from '../src/types.js';
import {
  applyMergePreflight,
  authorizeMergePreflight,
  buildMergePreflight,
  InitFileSystemError,
  MergeApplyError,
  withStagingArea,
  writeStagedArtifacts,
  type MergePreflight
} from '../src/init-filesystem.js';

// A deterministic seam over one-argument directory listings, which destination inspection takes.
// Without an installed hook every caller receives the real listing unchanged. Each test that installs
// a hook states whether the listing it returns is real (a forced interleaving) or simulated.
const listing = vi.hoisted(() => ({
  hook: undefined as ((directory: string, names: string[]) => string[]) | undefined
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const realReaddir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readdir: async (...args: unknown[]) => {
      const result = await realReaddir(...args);
      const hook = listing.hook;
      return hook && args.length === 1 && Array.isArray(result)
        ? hook(String(args[0]), result as string[])
        : result;
    }
  };
});

function present(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Native capabilities are classified once, in a recorded probe root. Unexpected errors fail loudly.
const host = (() => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'liftoff-alias-probe-'));
  const identity = lstatSync(root, { bigint: true });
  try {
    writeFileSync(path.join(root, 'probe-AbC'), '');
    const caseSensitive = !present(path.join(root, 'probe-abc'));
    writeFileSync(path.join(root, '\u017f-probe'), '');
    const unlistedAlias = present(path.join(root, 's-probe')) && !readdirSync(root).includes('s-probe');
    let unlistableDirectories = false;
    if (process.platform !== 'win32') {
      const closed = path.join(root, 'closed');
      mkdirSync(closed);
      chmodSync(closed, 0o300);
      try {
        readdirSync(closed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
        unlistableDirectories = true;
      } finally {
        chmodSync(closed, 0o700);
      }
    }
    return { caseSensitive, unlistedAlias, unlistableDirectories };
  } finally {
    const current = lstatSync(root, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error(`The recorded probe root changed: ${root}`);
    }
    rmSync(root, { recursive: true });
  }
})();

const unrun = (available: boolean, reason: string): string => (available ? '' : `; unrun: ${reason}`);

interface OwnedRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

// Cleanup removes only roots this file created and recorded, after re-checking their identity.
const ownedRoots: OwnedRoot[] = [];

afterEach(async () => {
  listing.hook = undefined;
  vi.unstubAllEnvs();
  for (const root of ownedRoots.splice(0).reverse()) {
    const details = await lstat(root.path, { bigint: true });
    if (!details.isDirectory() || details.dev !== root.dev || details.ino !== root.ino) {
      throw new Error(`Refusing to remove ${root.path}: it is no longer the recorded owned root.`);
    }
    await rm(root.path, { recursive: true });
  }
});

async function fixture(label: string): Promise<{ root: string; target: string; staging: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `liftoff-alias-${label}-`));
  const details = await lstat(root, { bigint: true });
  ownedRoots.push({ path: root, dev: details.dev, ino: details.ino });
  const target = path.join(root, 'target');
  const staging = path.join(root, 'staging');
  await mkdir(target);
  await mkdir(staging);
  vi.stubEnv('LIFTOFF_STAGING_ROOT', staging);
  return { root, target, staging };
}

async function put(root: string, pathParts: string[], content: string): Promise<void> {
  await mkdir(path.join(root, ...pathParts.slice(0, -1)), { recursive: true });
  await writeFile(path.join(root, ...pathParts), content, { flag: 'wx' });
}

// A no-follow snapshot of names, types, modes, link targets and bytes.
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const key = prefix ? `${prefix}/${name}` : name;
      const details = lstatSync(full);
      if (details.isSymbolicLink()) {
        entries[key] = `link:${readlinkSync(full)}`;
      } else if (details.isDirectory()) {
        entries[key] = `directory:${(details.mode & 0o7777).toString(8)}`;
        visit(full, key);
      } else if (details.isFile()) {
        entries[key] = `file:${(details.mode & 0o7777).toString(8)}:${readFileSync(full, 'utf8')}`;
      } else {
        entries[key] = 'other';
      }
    }
  };
  visit(root, '');
  return entries;
}

const artifact = (pathParts: string[], content: string): GeneratedArtifact =>
  ({ logicalName: 'alias-fixture', category: 'test', lifecycle: 'seed', pathParts, content });

function summary(preflight: MergePreflight) {
  return preflight.entries.map(({ relativePath, action, detail, destination }) =>
    ({ relativePath, action, detail, destination }));
}

function blockedAlias(pathParts: string[], detail: string) {
  return { relativePath: path.join(...pathParts), action: 'blocked', detail, destination: { type: 'alias' } };
}

function blockedMessage(entries: readonly { relativePath: string; detail: string }[]): string {
  return `Initialization is blocked by structural or symlink conflicts:\n${
    entries.map((entry) => `- ${entry.relativePath}: ${entry.detail}`).join('\n')}`;
}

async function rejection(action: Promise<unknown>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the operation to be refused.');
}

// The exact message proves that only staged spellings are reported, never an on-disk name.
async function expectRefusedEvenWithForce(preflight: MergePreflight, message: string): Promise<void> {
  for (const force of [false, true]) {
    const error = await rejection(authorizeMergePreflight(preflight, force));
    expect(error).toBeInstanceOf(InitFileSystemError);
    expect(error.message).toBe(message);
  }
}

describe('init destination case and Unicode aliases', () => {
  it('blocks a staged file whose destination exists under another case, even with force', async () => {
    const { root, target, staging } = await fixture('file');
    await put(target, ['readme.md'], 'user\n');
    const before = snapshot(target);
    const expected = [blockedAlias(['README.md'], 'case or Unicode alias at README.md')];

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['README.md'], 'generated\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(summary(preflight)).toEqual(expected);
      expect(preflight.replacements).toEqual([]);
      await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
    });

    expect(snapshot(target)).toEqual(before);
    expect(readdirSync(staging)).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it('blocks every staged entry below a directory that exists under another case', async () => {
    const { root, target } = await fixture('ancestor');
    await put(target, ['OpenSpec', 'user.md'], 'mine\n');
    const before = snapshot(target);
    const detail = 'case or Unicode alias at openspec';
    const expected = [
      ['openspec'],
      ['openspec', 'project.md'],
      ['openspec', 'specs'],
      ['openspec', 'specs', 'core'],
      ['openspec', 'specs', 'core', 'spec.md']
    ].map((pathParts) => blockedAlias(pathParts, detail));

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [
        artifact(['openspec', 'project.md'], 'project\n'),
        artifact(['openspec', 'specs', 'core', 'spec.md'], 'spec\n')
      ], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(summary(preflight)).toEqual(expected);
      await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
    });

    expect(snapshot(target)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it('blocks a destination entry that differs only by Unicode normalization', async () => {
    const { root, target } = await fixture('normalization');
    const decomposed = 'cafe\u0301';
    const composed = 'caf\u00e9';
    await put(target, [decomposed, 'user.md'], 'mine\n');
    const before = snapshot(target);
    const detail = `case or Unicode alias at ${composed}`;
    const expected = [[composed], [composed, 'menu.md']].map((pathParts) => blockedAlias(pathParts, detail));

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact([composed, 'menu.md'], 'menu\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(summary(preflight)).toEqual(expected);
      await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
    });

    expect(snapshot(target)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it.skipIf(!host.caseSensitive)(
    `natively blocks an alias even beside the exact spelling (requires a case-sensitive directory${unrun(host.caseSensitive, 'case-insensitive')})`,
    async () => {
      const { root, target } = await fixture('both-native');
      await put(target, ['README.md'], 'upper\n');
      await put(target, ['readme.md'], 'lower\n');
      await put(target, ['docs', 'a.md'], 'a\n');
      await put(target, ['Docs', 'b.md'], 'b\n');
      const before = snapshot(target);
      const expected = [
        blockedAlias(['README.md'], 'case or Unicode alias at README.md'),
        blockedAlias(['docs'], 'case or Unicode alias at docs'),
        blockedAlias(['docs', 'guide.md'], 'case or Unicode alias at docs')
      ];

      await withStagingArea(async (area) => {
        await writeStagedArtifacts(area, [
          artifact(['README.md'], 'generated\n'),
          artifact(['docs', 'guide.md'], 'guide\n')
        ], 'liftoff');
        const preflight = await buildMergePreflight(area, target);
        expect(summary(preflight)).toEqual(expected);
        await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
      });

      expect(snapshot(target)).toEqual(before);
      expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
    }
  );

  it('blocks a second spelling reported beside the exact entry (simulated listing; not native evidence)', async () => {
    const { root, target } = await fixture('both-simulated');
    await put(target, ['README.md'], 'same\n');
    const before = snapshot(target);
    let simulated = 0;
    listing.hook = (directory, names) => {
      if (directory !== target) return names;
      simulated += 1;
      return [...names, 'readme.md'];
    };
    const expected = [blockedAlias(['README.md'], 'case or Unicode alias at README.md')];

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['README.md'], 'same\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      listing.hook = undefined;
      expect(simulated).toBeGreaterThan(0);
      expect(summary(preflight)).toEqual(expected);
      await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
    });

    expect(snapshot(target)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it.skipIf(!host.unlistedAlias)(
    `natively blocks a destination the host resolves without listing it (requires a host that resolves an unlisted alias${unrun(host.unlistedAlias, 'not observed')})`,
    async () => {
      const { root, target } = await fixture('unlisted-native');
      await put(target, ['\u017f-alias', 'user.md'], 'mine\n');
      const before = snapshot(target);
      const detail = 'unlisted or aliased destination entry at s-alias';
      const expected = [['s-alias'], ['s-alias', 'x.md']].map((pathParts) => blockedAlias(pathParts, detail));

      await withStagingArea(async (area) => {
        await writeStagedArtifacts(area, [artifact(['s-alias', 'x.md'], 'x\n')], 'liftoff');
        const preflight = await buildMergePreflight(area, target);
        expect(summary(preflight)).toEqual(expected);
        await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
      });

      expect(snapshot(target)).toEqual(before);
      expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
    }
  );

  it('refuses an exact entry created between the listing and the stat without calling it an alias (deterministic owned interleaving)', async () => {
    const { root, target } = await fixture('interleaving');
    let created = 0;
    listing.hook = (directory, names) => {
      if (directory === target && created === 0) {
        created += 1;
        // The listing above is real and was taken before this exact entry existed.
        writeFileSync(path.join(target, 'late.md'), 'raced\n', { flag: 'wx' });
      }
      return names;
    };
    const detail = 'unlisted or aliased destination entry at late.md';
    const expected = [blockedAlias(['late.md'], detail)];

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['late.md'], 'generated\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      listing.hook = undefined;
      expect(created).toBe(1);
      expect(summary(preflight)).toEqual(expected);
      await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
    });

    expect(Object.keys(snapshot(target))).toEqual(['late.md']);
    expect(readFileSync(path.join(target, 'late.md'), 'utf8')).toBe('raced\n');
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it('reports a manifest alias as an alias ahead of the manifest rule and keeps the exact-manifest refusal', async () => {
    const aliased = await fixture('manifest-alias');
    await put(aliased.target, ['Liftoff.Manifest.json'], '{}\n');
    const aliasedBefore = snapshot(aliased.target);
    const expected = [blockedAlias(['liftoff.manifest.json'], 'case or Unicode alias at liftoff.manifest.json')];
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['liftoff.manifest.json'], '{"artifactVersion":7}\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, aliased.target);
      expect(summary(preflight)).toEqual(expected);
      await expectRefusedEvenWithForce(preflight, blockedMessage(expected));
    });
    expect(snapshot(aliased.target)).toEqual(aliasedBefore);

    const exact = await fixture('manifest-exact');
    await put(exact.target, ['liftoff.manifest.json'], '{}\n');
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['liftoff.manifest.json'], '{"artifactVersion":7}\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, exact.target);
      expect(summary(preflight)).toEqual([expect.objectContaining({
        relativePath: 'liftoff.manifest.json',
        action: 'blocked',
        detail: 'an existing Liftoff manifest must use liftoff update for managed-core maintenance, not reinitialization',
        destination: expect.objectContaining({ type: 'file' })
      })]);
    });
  });

  it('keeps exact-name identical, replace, merge and create behavior unchanged', async () => {
    const { root, target } = await fixture('exact');
    await put(target, ['README.md'], 'same\n');
    await put(target, ['NOTES.md'], 'old\n');
    await put(target, ['openspec', 'keep.md'], 'mine\n');
    const kept = snapshot(target)['openspec/keep.md'];

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [
        artifact(['README.md'], 'same\n'),
        artifact(['NOTES.md'], 'new\n'),
        artifact(['openspec', 'project.md'], 'project\n')
      ], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(summary(preflight).map(({ relativePath, action }) => [relativePath, action])).toEqual([
        ['NOTES.md', 'replace'],
        ['README.md', 'identical'],
        ['openspec', 'merge-directory'],
        [path.join('openspec', 'project.md'), 'create']
      ]);
      expect(preflight.blocked).toEqual([]);
      expect(await authorizeMergePreflight(preflight, false)).toBeUndefined();
      const authorized = await authorizeMergePreflight(preflight, true);
      expect(authorized).toBe(preflight);
      await expect(applyMergePreflight(authorized!)).resolves.toEqual({
        created: [path.join('openspec', 'project.md')],
        replaced: ['NOTES.md'],
        identical: ['README.md'],
        mergedDirectories: ['openspec']
      });
    });

    const after = snapshot(target);
    expect(Object.keys(after).sort()).toEqual(['NOTES.md', 'README.md', 'openspec', 'openspec/keep.md', 'openspec/project.md']);
    expect(after['openspec/keep.md']).toBe(kept);
    expect(readFileSync(path.join(target, 'NOTES.md'), 'utf8')).toBe('new\n');
    expect(readFileSync(path.join(target, 'openspec', 'project.md'), 'utf8')).toBe('project\n');
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it('refuses to apply after an existing directory changes case following preflight', async () => {
    const { root, target } = await fixture('swap-directory');
    await put(target, ['docs', 'keep.md'], 'mine\n');

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['docs', 'new.md'], 'new\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(summary(preflight).map(({ relativePath, action }) => [relativePath, action])).toEqual([
        ['docs', 'merge-directory'],
        [path.join('docs', 'new.md'), 'create']
      ]);
      const authorized = await authorizeMergePreflight(preflight, false);
      await rename(path.join(target, 'docs'), path.join(target, 'Docs'));
      const swapped = snapshot(target);

      const error = await rejection(applyMergePreflight(authorized!));
      expect(error).toBeInstanceOf(MergeApplyError);
      expect(error.message).toBe('Initialization merge failed: Destination changed after preflight: docs');
      expect((error as MergeApplyError).rollback).toEqual({ restored: [], removed: [], failures: [] });
      expect(snapshot(target)).toEqual(swapped);
    });

    expect(Object.keys(snapshot(target))).toEqual(['Docs', 'Docs/keep.md']);
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it('refuses to apply after an existing file changes case following preflight', async () => {
    const { root, target } = await fixture('swap-file');
    await put(target, ['README.md'], 'user\n');

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact(['README.md'], 'generated\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(summary(preflight).map(({ relativePath, action }) => [relativePath, action])).toEqual([
        ['README.md', 'replace']
      ]);
      const authorized = await authorizeMergePreflight(preflight, true);
      await rename(path.join(target, 'README.md'), path.join(target, 'readme.md'));
      const swapped = snapshot(target);

      const error = await rejection(applyMergePreflight(authorized!));
      expect(error).toBeInstanceOf(MergeApplyError);
      expect(error.message).toBe('Initialization merge failed: Destination changed after preflight: README.md');
      expect((error as MergeApplyError).rollback).toEqual({ restored: [], removed: [], failures: [] });
      expect(snapshot(target)).toEqual(swapped);
    });

    expect(Object.keys(snapshot(target))).toEqual(['readme.md']);
    expect(readFileSync(path.join(target, 'readme.md'), 'utf8')).toBe('user\n');
    expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
  });

  it.skipIf(!host.unlistableDirectories)(
    `fails closed when an existing destination directory cannot be listed (requires POSIX directory permissions${unrun(host.unlistableDirectories, process.platform === 'win32' ? 'not POSIX' : 'listing not denied')})`,
    async () => {
      const { root, target } = await fixture('unlistable');
      await put(target, ['docs', 'keep.md'], 'mine\n');
      const docs = path.join(target, 'docs');
      await chmod(docs, 0o300);
      try {
        await withStagingArea(async (area) => {
          await writeStagedArtifacts(area, [artifact(['docs', 'new.md'], 'new\n')], 'liftoff');
          const error = await rejection(buildMergePreflight(area, target));
          expect(error).toBeInstanceOf(InitFileSystemError);
          expect(error.message).toMatch(/^Unable to inspect destination docs\/new\.md: EACCES: /);
        });
      } finally {
        await chmod(docs, 0o700);
      }

      expect(Object.keys(snapshot(target))).toEqual(['docs', 'docs/keep.md']);
      expect(readdirSync(root).sort()).toEqual(['staging', 'target']);
    }
  );
});
