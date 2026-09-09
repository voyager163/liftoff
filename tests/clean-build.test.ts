import { spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('clean build output', () => {
  it('removes only the script-owning package dist when invoked from another cwd', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8')
    ) as { scripts: { build: string } };
    expect(packageJson.scripts.build).toBe(
      'node scripts/clean-build.mjs && tsc -p tsconfig.json'
    );

    const cacheRoot = path.join(process.cwd(), '.cache');
    await mkdir(cacheRoot, { recursive: true });
    const root = await mkdtemp(path.join(cacheRoot, 'clean-build-'));
    const packageRoot = path.join(root, 'package');
    const scriptsRoot = path.join(packageRoot, 'scripts');
    const distRoot = path.join(packageRoot, 'dist');
    const callerRoot = path.join(root, 'caller');
    const copiedScript = path.join(scriptsRoot, 'clean-build.mjs');
    const retainedFile = path.join(packageRoot, 'retained.txt');
    try {
      await mkdir(scriptsRoot, { recursive: true });
      await mkdir(distRoot, { recursive: true });
      await mkdir(callerRoot, { recursive: true });
      await copyFile(
        path.resolve('scripts/clean-build.mjs'),
        copiedScript
      );
      await writeFile(path.join(distRoot, 'stale.js'), 'stale compiled module\n');
      await writeFile(retainedFile, 'retain neighboring package bytes\n');
      await writeFile(path.join(callerRoot, 'caller.txt'), 'retain caller bytes\n');

      const result = spawnSync(process.execPath, [copiedScript], {
        cwd: callerRoot,
        encoding: 'utf8'
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(access(distRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(retainedFile, 'utf8'))
        .toBe('retain neighboring package bytes\n');
      expect(await readFile(path.join(callerRoot, 'caller.txt'), 'utf8'))
        .toBe('retain caller bytes\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
