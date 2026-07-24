import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import type { ExternalCommand, GeneratedArtifact } from '../src/types.js';
import {
  applyMergePreflight,
  assertSafeInitTarget,
  authorizeMergePreflight,
  buildMergePreflight,
  captureTreeState,
  claimFrameworkChanges,
  discoverGitRoot,
  InitFileSystemError,
  MergeApplyError,
  normalizeComparisonPath,
  resolveInitTarget,
  validateStagedTree,
  withStagingArea,
  writeStagedArtifacts
} from '../src/init-filesystem.js';

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

class GitRunner implements CommandRunner {
  constructor(private readonly root?: string) {}

  async run(command: ExternalCommand): Promise<CommandResult> {
    return {
      command,
      displayCommand: 'git rev-parse --show-toplevel',
      status: this.root ? 0 : 128,
      signal: null,
      stdout: this.root ? `${this.root}\n` : '',
      stderr: this.root ? '' : 'not a git repository',
      timedOut: false
    };
  }
}

const artifact = (
  logicalName: string,
  pathParts: string[],
  content: string
): GeneratedArtifact => ({ logicalName, category: 'test', pathParts, content });

describe('Git-aware init targeting', () => {
  it('initializes an exact Git or worktree root in place even when a name is supplied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-git-root-'));
    cleanups.push(root);
    const canonicalRoot = await realpath(root);
    const discovery = await discoverGitRoot(root, new GitRunner(root));
    const target = await resolveInitTarget(root, 'different-name', new GitRunner(root));

    expect(discovery).toMatchObject({ root: canonicalRoot, exact: true });
    expect(target).toEqual({ root: canonicalRoot, mode: 'in-place', gitRoot: canonicalRoot });
  });

  it('uses a named child from nested Git and non-Git directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-git-nested-'));
    cleanups.push(root);
    const nested = path.join(root, 'packages');
    await mkdir(nested);
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);

    expect(await resolveInitTarget(nested, 'new-app', new GitRunner(root))).toEqual({
      root: path.join(canonicalNested, 'new-app'),
      mode: 'named-child',
      gitRoot: canonicalRoot
    });
    expect(await resolveInitTarget(nested, 'new-app', new GitRunner())).toEqual({
      root: path.join(canonicalNested, 'new-app'),
      mode: 'named-child'
    });
  });

  it('resolves a symlinked working directory before exact-root comparison', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-git-link-'));
    cleanups.push(parent);
    const root = path.join(parent, 'real');
    const linked = path.join(parent, 'linked');
    await mkdir(root);
    await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalRoot = await realpath(root);

    expect(await resolveInitTarget(linked, 'unused', new GitRunner(root))).toEqual({
      root: canonicalRoot,
      mode: 'in-place',
      gitRoot: canonicalRoot
    });
  });

  it('normalizes Windows drive casing and separators portably', () => {
    expect(normalizeComparisonPath('C:\\Work\\Repo\\', 'win32'))
      .toBe(normalizeComparisonPath('c:/work/repo', 'win32'));
    expect(normalizeComparisonPath('/Work/Repo', 'linux'))
      .not.toBe(normalizeComparisonPath('/work/repo', 'linux'));
  });

  it('fails closed when Git discovery fails for a reason other than a non-repository directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-git-failure-'));
    cleanups.push(root);
    const runner: CommandRunner = {
      run: async (command) => ({
        command,
        displayCommand: 'git rev-parse --show-toplevel',
        status: 128,
        signal: null,
        stdout: '',
        stderr: 'fatal: detected dubious ownership in repository',
        timedOut: false
      })
    };

    await expect(discoverGitRoot(root, runner)).rejects.toThrow(/Unable to determine the Git worktree root/);
  });
});

describe('init target guards', () => {
  it('allows unrelated existing content but redirects existing Liftoff projects to update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-target-guard-'));
    cleanups.push(root);
    await writeFile(path.join(root, 'unrelated.txt'), 'preserve');
    await expect(assertSafeInitTarget({ root, mode: 'in-place' })).resolves.toBeUndefined();

    await writeFile(path.join(root, 'liftoff.manifest.json'), '{}');
    await expect(assertSafeInitTarget({ root, mode: 'in-place' })).rejects.toThrow(/liftoff update/);
  });

  it('rejects non-directory, symlink, and escaping targets before staging', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-target-types-'));
    cleanups.push(parent);
    const file = path.join(parent, 'file');
    const linked = path.join(parent, 'linked');
    await writeFile(file, 'content');
    await symlink(file, linked);

    await expect(assertSafeInitTarget({ root: file, mode: 'named-child' }, parent)).rejects.toThrow(/not a directory/);
    await expect(assertSafeInitTarget({ root: linked, mode: 'named-child' }, parent)).rejects.toThrow(/symlink/);
    await expect(assertSafeInitTarget({ root: path.join(parent, '..', 'outside'), mode: 'named-child' }, parent))
      .rejects.toThrow(/escapes/);
  });
});

describe('staged ownership and validation', () => {
  it('tracks Liftoff and framework origins while enforcing adapter output roots', async () => {
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact('readme', ['README.md'], 'readme\n')], 'liftoff');
      const before = await captureTreeState(area.root);
      await mkdir(path.join(area.root, '.github', 'skills'), { recursive: true });
      await writeFile(path.join(area.root, '.github', 'skills', 'tool.md'), 'framework\n');

      expect(await claimFrameworkChanges(area, before, ['.github'])).toContain('.github/skills/tool.md');
      expect((await validateStagedTree(area)).map((entry) => [entry.relativePath, entry.origin])).toEqual([
        ['.github/skills/tool.md', 'framework'],
        ['README.md', 'liftoff']
      ]);
    });

    await withStagingArea(async (area) => {
      const before = await captureTreeState(area.root);
      await writeFile(path.join(area.root, 'outside.txt'), 'not allowed\n');
      await expect(claimFrameworkChanges(area, before, ['.github'])).rejects.toThrow(/outside its approved roots/);
    });
  });

  it('rejects staged symlinks and unowned files', async () => {
    await withStagingArea(async (area) => {
      await writeFile(path.join(area.root, 'target.txt'), 'target');
      area.origins.set('target.txt', 'liftoff');
      await symlink(path.join(area.root, 'target.txt'), path.join(area.root, 'linked.txt'));
      await expect(validateStagedTree(area)).rejects.toThrow(/forbidden symlink/);
    });

    await withStagingArea(async (area) => {
      await writeFile(path.join(area.root, 'unowned.txt'), 'content');
      await expect(validateStagedTree(area)).rejects.toThrow(/no declared owner/);
    });
  });
});

describe('transactional merge', () => {
  it('classifies a complete immutable plan, confirms once, and preserves unrelated files', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-merge-'));
    cleanups.push(target);
    await writeFile(path.join(target, 'README.md'), 'old\n');
    await writeFile(path.join(target, 'same.txt'), 'same\n');
    await writeFile(path.join(target, 'unrelated.txt'), 'preserve\n');

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [
        artifact('readme', ['README.md'], 'new\n'),
        artifact('same', ['same.txt'], 'same\n'),
        artifact('config', ['config', 'app.json'], '{}\n'),
        artifact('manifest', ['liftoff.manifest.json'], '{"artifactVersion":3}\n')
      ], 'liftoff');
      const preflight = await buildMergePreflight(area, target);

      expect(Object.isFrozen(preflight.entries)).toBe(true);
      expect(preflight.entries.find((entry) => entry.relativePath === 'README.md')?.action).toBe('replace');
      expect(preflight.entries.find((entry) => entry.relativePath === 'same.txt')?.action).toBe('identical');
      expect(preflight.entries.find((entry) => entry.relativePath === 'config')?.action).toBe('create');
      const confirm = vi.fn(async () => true);
      const authorized = await authorizeMergePreflight(preflight, false, confirm);
      expect(authorized).toBe(preflight);
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledWith(['README.md']);

      const order: string[] = [];
      const result = await applyMergePreflight(authorized!, {
        onBeforeMutation: async (entry) => {
          order.push(entry.relativePath);
        }
      });
      expect(result.replaced).toEqual(['README.md']);
      expect(result.identical).toEqual(['same.txt']);
      expect(order.at(-1)).toBe('liftoff.manifest.json');
    });

    expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('new\n');
    expect(await readFile(path.join(target, 'unrelated.txt'), 'utf8')).toBe('preserve\n');
    expect(await readFile(path.join(target, 'config', 'app.json'), 'utf8')).toBe('{}\n');
  });

  it('limits force to regular-file replacement and never authorizes structural or symlink conflicts', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-merge-blocked-'));
    cleanups.push(target);
    await mkdir(path.join(target, 'README.md'));

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact('readme', ['README.md'], 'content\n')], 'liftoff');
      const preflight = await buildMergePreflight(area, target);
      expect(preflight.blocked[0]).toMatchObject({ relativePath: 'README.md', action: 'blocked' });
      await expect(authorizeMergePreflight(preflight, true)).rejects.toThrow(/structural or symlink conflicts/);
    });
  });

  it('never allows force to replace an existing Liftoff manifest', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-guard-'));
    cleanups.push(target);
    await writeFile(path.join(target, 'liftoff.manifest.json'), '{"existing":true}\n');

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [
        artifact('manifest', ['liftoff.manifest.json'], '{"artifactVersion":3}\n')
      ], 'liftoff');
      const preflight = await buildMergePreflight(area, target);

      expect(preflight.blocked).toEqual([
        expect.objectContaining({ relativePath: 'liftoff.manifest.json', action: 'blocked' })
      ]);
      await expect(authorizeMergePreflight(preflight, true)).rejects.toThrow(/liftoff update/);
    });
  });

  it('rolls back created and replaced files in reverse order after a handled failure', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-merge-rollback-'));
    cleanups.push(target);
    await writeFile(path.join(target, '10-replace.txt'), 'original\n');

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [
        artifact('new', ['00-new.txt'], 'new\n'),
        artifact('replace', ['10-replace.txt'], 'replacement\n'),
        artifact('failure', ['20-fail.txt'], 'never written\n')
      ], 'liftoff');
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, target), true);

      let thrown: unknown;
      try {
        await applyMergePreflight(preflight!, {
          onBeforeMutation: async (entry) => {
            if (entry.relativePath === '20-fail.txt') {
              throw new Error('injected failure');
            }
          }
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MergeApplyError);
      expect((thrown as MergeApplyError).rollback.failures).toEqual([]);
      expect((thrown as MergeApplyError).rollback.restored).toEqual(['10-replace.txt']);
      expect((thrown as MergeApplyError).rollback.removed).toContain('00-new.txt');
    });

    expect(await readFile(path.join(target, '10-replace.txt'), 'utf8')).toBe('original\n');
    await expect(access(path.join(target, '00-new.txt'))).rejects.toThrow();
    await expect(access(path.join(target, '20-fail.txt'))).rejects.toThrow();
  });

  it('detects destination changes after preflight before writing', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-merge-stale-'));
    cleanups.push(target);
    await writeFile(path.join(target, 'README.md'), 'old\n');

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact('readme', ['README.md'], 'new\n')], 'liftoff');
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, target), true);
      await writeFile(path.join(target, 'README.md'), 'changed after plan\n');

      await expect(applyMergePreflight(preflight!)).rejects.toThrow(/changed after preflight/);
    });
    expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('changed after plan\n');
  });

  it('rejects files added to a fresh-only target after preflight', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-fresh-race-'));
    cleanups.push(target);

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact('readme', ['README.md'], 'new\n')], 'liftoff');
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, target), true);
      await writeFile(path.join(target, 'keep.txt'), 'preserve\n');

      await expect(applyMergePreflight(preflight!, { requireEmptyTarget: true }))
        .rejects.toThrow(/must remain new or empty/);
    });
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('preserve\n');
    await expect(access(path.join(target, '.liftoff-init.lock'))).rejects.toThrow();
  });

  it('rejects a target root replaced by a symlink after preflight', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-root-race-'));
    cleanups.push(parent);
    const target = path.join(parent, 'target');
    const moved = path.join(parent, 'moved');
    const outside = path.join(parent, 'outside');
    await mkdir(target);
    await mkdir(outside);

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [artifact('readme', ['README.md'], 'new\n')], 'liftoff');
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, target), true);
      await rename(target, moved);
      await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');

      await expect(applyMergePreflight(preflight!)).rejects.toThrow(/target root changed|target is a symlink/);
    });
    await expect(access(path.join(outside, 'README.md'))).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')('applies staged executable modes and restores replaced modes on rollback', async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), 'liftoff-mode-'));
    cleanups.push(target);
    const replaced = path.join(target, 'replace.sh');
    await writeFile(replaced, 'original\n');
    await chmod(replaced, 0o600);

    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [
        artifact('created-script', ['created.sh'], '#!/bin/sh\n'),
        artifact('replaced-script', ['replace.sh'], '#!/bin/sh\n'),
        artifact('failure', ['zz-fail.txt'], 'never written\n')
      ], 'liftoff');
      await chmod(path.join(area.root, 'created.sh'), 0o755);
      await chmod(path.join(area.root, 'replace.sh'), 0o755);
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, target), true);

      await expect(applyMergePreflight(preflight!, {
        onBeforeMutation: async (entry) => {
          if (entry.relativePath === 'zz-fail.txt') {
            expect((await stat(path.join(target, 'created.sh'))).mode & 0o777).toBe(0o755);
            expect((await stat(replaced)).mode & 0o777).toBe(0o755);
            throw new Error('injected failure');
          }
        }
      })).rejects.toBeInstanceOf(MergeApplyError);
    });

    expect((await stat(replaced)).mode & 0o777).toBe(0o600);
    await expect(access(path.join(target, 'created.sh'))).rejects.toThrow();
  });
});
