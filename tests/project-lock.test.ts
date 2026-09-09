import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectMutationLockPath,
  withProjectMutationLock
} from '../src/adapters/filesystem/project-lock.js';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
import { applyProjectFileTransaction, loadManifest } from '../src/file-system.js';
import {
  applyMergePreflight,
  authorizeMergePreflight,
  buildMergePreflight,
  captureTreeState,
  withStagingArea,
  writeStagedArtifacts
} from '../src/init-filesystem.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-lock-'));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces');
  return { parent, root, lockPath: await projectMutationLockPath(root) };
}

describe('cooperating project mutation lock', () => {
  it('reserves a missing target without creating project state and releases after failure', async () => {
    const { parent, root, lockPath } = await fixture();
    await expect(withProjectMutationLock(root, async (lease) => {
      await lease.assertHeld();
      await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(parent)).toEqual([path.basename(lockPath)]);
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect(await readdir(parent)).toEqual([]);
  });

  it('serializes case and Unicode aliases before creation and retains the lease afterward', async () => {
    const { parent } = await fixture();
    const upper = path.join(parent, 'CAF\u00c9 Project');
    const lower = path.join(parent, 'cafe\u0301 project');
    const reservation = await projectMutationLockPath(upper);
    expect(await projectMutationLockPath(lower)).toBe(reservation);
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const first = withProjectMutationLock(upper, async () => {
      started.resolve();
      await resume.promise;
      await mkdir(upper);
      expect(await projectMutationLockPath(upper)).toBe(reservation);
      expect(await projectMutationLockPath(lower)).toBe(reservation);
      await withProjectMutationLock(lower, async (lease) => {
        await lease.assertHeld();
      });
    });
    await started.promise;
    try {
      await expect(withProjectMutationLock(lower, async () => undefined))
        .rejects.toThrow('Another cooperating Liftoff mutation');
    } finally {
      resume.resolve();
      await first;
    }
    await expect(readFile(reservation)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks a concurrent writer until the first operation and all its nested transactions finish', async () => {
    const { root, lockPath } = await fixture();
    await mkdir(root);
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const first = withProjectMutationLock(root, async () => {
      await applyProjectFileTransaction(root, [{ type: 'write', pathParts: ['one.txt'], content: 'one' }]);
      started.resolve();
      await resume.promise;
      await applyProjectFileTransaction(root, [{ type: 'write', pathParts: ['two.txt'], content: 'two' }]);
    });
    await started.promise;
    try {
      await expect(applyProjectFileTransaction(root, [
        { type: 'write', pathParts: ['competing.txt'], content: 'not authorized concurrently' }
      ])).rejects.toThrow('Another cooperating Liftoff mutation');
      expect(await readdir(root)).toEqual(['one.txt']);
    } finally {
      resume.resolve();
      await first;
    }
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual(['one.txt', 'two.txt']);
    await applyProjectFileTransaction(root, [{ type: 'write', pathParts: ['three.txt'], content: 'three' }]);
  });

  it('enforces exclusion in another Node process, not just through process-local bookkeeping', async () => {
    const { root } = await fixture();
    const moduleUrl = new URL('../src/adapters/filesystem/project-lock.ts', import.meta.url).href;
    await withProjectMutationLock(root, async () => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { withProjectMutationLock } from ${JSON.stringify(moduleUrl)};
        try {
          await withProjectMutationLock(process.argv[1], async () => { process.exitCode = 9; });
        } catch (error) {
          process.stderr.write(error.message);
          process.exitCode = 1;
        }
      `, root], { encoding: 'utf8', timeout: 15_000 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('Another cooperating Liftoff mutation');
    });
  });

  it('never removes an existing lock or starts the guarded operation', async () => {
    const { root, lockPath } = await fixture();
    await writeFile(lockPath, 'unowned stale or live lock');
    let called = false;
    await expect(withProjectMutationLock(root, async () => {
      called = true;
    })).rejects.toThrow('never removes an unowned lock');
    expect(called).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toBe('unowned stale or live lock');
  });

  it('preserves a replaced lock and reports both operation and cleanup failure', async () => {
    const { root, lockPath } = await fixture();
    await expect(withProjectMutationLock(root, async (lease) => {
      await unlink(lockPath);
      await writeFile(lockPath, 'replacement belongs to someone else', { flag: 'wx' });
      await lease.assertHeld();
    })).rejects.toThrow(/lock.*changed.*Lock cleanup also failed/s);
    expect(await readFile(lockPath, 'utf8')).toBe('replacement belongs to someone else');
  });

  it('stops later transaction writes if the held lock changes', async () => {
    const { root, lockPath } = await fixture();
    await mkdir(root);
    await expect(applyProjectFileTransaction(root, [
      { type: 'write', pathParts: ['one.txt'], content: 'one' },
      { type: 'write', pathParts: ['two.txt'], content: 'two' }
    ], {
      onBeforeMutation: async (_mutation, index) => {
        if (index === 1) await writeFile(lockPath, 'changed lock');
      }
    })).rejects.toThrow(/lock contents changed/);
    expect(await readFile(lockPath, 'utf8')).toBe('changed lock');
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects symlink or junction targets without reserving the destination', async () => {
    const { parent, root } = await fixture();
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(withProjectMutationLock(root, async () => undefined)).rejects.toThrow('symlink or junction');
    expect(await readdir(parent)).toEqual(['outside', 'project with spaces']);
  });

  it('rejects an old initialization lock without removing it', async () => {
    const { root, lockPath } = await fixture();
    await mkdir(root);
    const legacyPath = path.join(root, '.liftoff-init.lock');
    await writeFile(legacyPath, 'old writer');
    await expect(withProjectMutationLock(root, async () => undefined)).rejects.toThrow('legacy Liftoff initialization lock');
    expect(await readFile(legacyPath, 'utf8')).toBe('old writer');
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks a new initialization merge before creating its target directory', async () => {
    const { root, lockPath } = await fixture();
    await withStagingArea(async (area) => {
      await writeStagedArtifacts(area, [{
        logicalName: 'readme', category: 'documentation', lifecycle: 'project',
        provisioningGroup: 'base', pathParts: ['README.md'], content: 'project\n'
      }], 'liftoff');
      const preflight = await authorizeMergePreflight(await buildMergePreflight(area, root), false);
      expect(preflight).toBeDefined();
      await writeFile(lockPath, 'another initializer');
      await expect(applyMergePreflight(preflight!)).rejects.toThrow('Another cooperating Liftoff mutation');
    });
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(lockPath, 'utf8')).toBe('another initializer');
  });

  it('keeps public read-only commands lock-free while blocking an actual update', async () => {
    const root = await createFixtureProject({
      projectName: 'Lock contract', projectType: 'standard', apiStack: 'go',
      cloud: 'azure', includeFrontend: false
    });
    roots.push(path.dirname(root));
    const lockPath = await projectMutationLockPath(root);
    const before = await captureTreeState(root);
    await writeFile(lockPath, 'other writer');
    for (const { args, code } of [
      { args: ['validate', '--json'], code: 0 },
      { args: ['update', '--check', '--json'], code: 0 },
      { args: ['governance', 'assess', '--json'], code: 2 },
      { args: ['governance', 'assess', '--help'], code: 0 }
    ]) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      expect(await runCommand(parseArgs(args), {
        cwd: root, stdout, stderr, runner: new ReadyInitRunner(),
        env: { LIFTOFF_TELEMETRY_DISABLED: '1' }
      }), `${args.join(' ')}: ${stderr.text()}`).toBe(code);
    }
    expect(await captureTreeState(root)).toEqual(before);
    expect(await readFile(lockPath, 'utf8')).toBe('other writer');
    const manifest = await loadManifest(root);
    const managed = manifest.managedArtifacts[0];
    expect(managed).toBeDefined();
    await unlink(path.join(root, ...managed.pathParts));
    const updatePreview = { homedir: path.join(path.dirname(root), 'receipt-home'), env: {} };
    const previewOutput = new CaptureStream();
    const previewError = new CaptureStream();
    expect(await runCommand(parseArgs(['update', '--check', '--json']), {
      cwd: root, stdout: previewOutput, stderr: previewError, updatePreview
    })).toBe(2);
    const preview = JSON.parse(previewOutput.text());
    const fingerprint = preview.plans.find((entry: { mode: string }) => entry.mode === 'normal').fingerprint;
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    expect(await runCommand(parseArgs(['update', '--json', '--approve-plan', fingerprint]), {
      cwd: root, stdout, stderr, runner: new ReadyInitRunner(), updatePreview
    })).toBe(1);
    expect(`${stdout.text()}${stderr.text()}`).toContain('Another cooperating Liftoff mutation');
    await expect(readFile(path.join(root, ...managed.pathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(lockPath, 'utf8')).toBe('other writer');
  });
});
