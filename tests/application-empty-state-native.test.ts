import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { captureStateExecutable, nativeStateHostId } from '../src/adapters/state/native-system.js';
import { stopOwnedStateProcessesIn } from '../src/adapters/state/owned-process.js';
import { applicationEmptyNativeRecipe, createCandidateEmptyState, readCandidateEmptyState } from '../src/adapters/azure/application-empty-state-native.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await stopOwnedStateProcessesIn(root);
    await rm(root, { recursive: true });
  }
});

describe('native provider-free empty-state candidate', () => {
  it('keeps the reviewed native recipe immutable through its exposed command inventory', () => {
    expect(Object.isFrozen(applicationEmptyNativeRecipe)).toBe(true);
    expect(Object.isFrozen(applicationEmptyNativeRecipe.commands)).toBe(true);
    expect(applicationEmptyNativeRecipe.commands.every((command) => Object.isFrozen(command))).toBe(true);
  });
  it.each([
    { serial: 0 }, { serial: 2 }, { terraform_version: '1.12.5' }, { version: 3 },
    { lineage: 'made-up' }, { resources: [{}] }, { outputs: { token: 'not-empty' } },
    { check_results: [] }, { unknown: true }
  ])('rejects unsupported or nonempty state %#', (change) => {
    const bytes = Buffer.from(JSON.stringify({
      version: 4, terraform_version: '1.12.6', serial: 1, lineage: randomUUID(),
      resources: [], outputs: {}, check_results: null, ...change
    }));
    expect(() => readCandidateEmptyState(bytes)).toThrow();
  });

  it.runIf(process.platform === 'darwin' && process.env.LIFTOFF_NATIVE_STATE_QUALIFICATION === '1')(
    'uses only a native verified empty saved plan and preserves the generated state bytes', async () => {
      const root = await realpath(await mkdtemp(path.join(process.cwd(), 'tests', '.native-empty-state-')));
      roots.push(root);
      const directoryPath = path.join(root, 'native');
      await mkdir(directoryPath, { mode: 0o700 });
      const info = await lstat(directoryPath);
      const identity = { device: String(info.dev), inode: String(info.ino), birthtime: String(info.birthtimeMs),
        uid: info.uid, mode: info.mode & 0o777 };
      const tofu = await captureStateExecutable(process.env.LIFTOFF_TOFU_EXECUTABLE ?? '/opt/homebrew/bin/tofu');
      const events: string[] = [];
      const result = await createCandidateEmptyState({
        directory: { path: directoryPath, identity },
        tools: { tofu, python: tofu, pythonVersion: 'not-used', tofuVersion: '1.12.6', hostId: nativeStateHostId() },
        maxCommandMs: 10_000,
        async assertDirectory(directory) {
          const current = await lstat(directory.path);
          expect(current.ino).toBe(info.ino);
          expect(current.dev).toBe(info.dev);
          expect(current.isSymbolicLink()).toBe(false);
        },
        async authorize() { events.push('authorized'); },
        async started() { events.push('started'); },
        async settled() { events.push('settled'); }
      });
      const bytes = await readFile(path.join(directoryPath, 'terraform.tfstate.d', 'liftoff-initial-empty', 'terraform.tfstate'));
      try {
        expect(Buffer.from(result.bytes)).toEqual(bytes);
        expect(result.serial).toBe(1);
        expect(Object.keys(result.payload).sort()).toEqual(['check_results', 'lineage', 'outputs', 'resources', 'serial', 'terraform_version', 'version']);
        expect(result.payload.check_results).toBeNull();
        expect(events.indexOf('started')).toBeGreaterThan(0);
        expect(events.at(-1)).toBe('settled');
      } finally { bytes.fill(0); result.bytes.fill(0); }
    }
  );
});
