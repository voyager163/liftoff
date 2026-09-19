import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeCommandRunner } from '../src/process-runner.js';
import { ApiFixtureLifecycle } from './helpers/api-fixture-lifecycle.mjs';
import { putApplicationFixtureFile } from './fixtures/repair-application.js';

describe('owned API fixture teardown', () => {
  it('returns actual operation results and keeps failures observable', async () => {
    const scope = new ApiFixtureLifecycle('fixture', new AbortController().signal);
    await expect(scope.run(async () => 42)).resolves.toBe(42);
    const error = new Error('actual check failed');
    await expect(scope.run(async () => { throw error; })).rejects.toBe(error);
    await scope.drain(100);
    expect(scope.pending).toBe(0);
  });

  it('drains already-owned work after timeout without authorizing subsequent writes', async () => {
    const controller = new AbortController(), scope = new ApiFixtureLifecycle('fixture', controller.signal);
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const running = scope.run(() => pending);
    const failed = expect(running).rejects.toThrow('finished or timed out');
    await Promise.resolve();
    controller.abort(new Error('test timeout'));
    const lateWrite = vi.fn(async () => {});
    expect(() => scope.run(lateWrite)).toThrow('no subsequent operation');
    expect(lateWrite).not.toHaveBeenCalled();
    let drained = false;
    const cleanup = scope.drain(100).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(scope.pending).toBe(1);
    complete();
    await Promise.all([cleanup, failed]);
    expect(drained).toBe(true);
    expect(scope.pending).toBe(0);
  });

  it('retains unresolved work when the finite drain budget expires', async () => {
    const controller = new AbortController(), scope = new ApiFixtureLifecycle('retained-fixture', controller.signal);
    let complete!: () => void;
    const running = scope.run(() => new Promise<void>((resolve) => { complete = resolve; }));
    const failed = expect(running).rejects.toThrow('finished or timed out');
    await Promise.resolve();
    controller.abort();
    await expect(scope.drain(20)).rejects.toThrow('retain the registered scope');
    expect(scope.pending).toBe(1);
    complete();
    await failed;
    await scope.drain(100);
  });

  it('does not start work after an already-aborted test or accept unbounded drain budgets', async () => {
    const controller = new AbortController();
    controller.abort();
    const scope = new ApiFixtureLifecycle('fixture', controller.signal);
    const operation = vi.fn(async () => {});
    expect(() => scope.run(operation)).toThrow('finished or timed out');
    expect(operation).not.toHaveBeenCalled();
    for (const budget of [0, -1, Infinity, NaN]) {
      await expect(scope.drain(budget)).rejects.toThrow('positive finite');
    }
  });

  it('keeps an actual Vitest timeout failed while its teardown drains cleanup and blocks late approval', async () => {
    const root = path.resolve('tests', `.api fixture timeout ${randomUUID()}`);
    const helper = pathToFileURL(path.resolve('tests/helpers/api-fixture-lifecycle.mjs')).href;
    await mkdir(path.join(root, 'scratch'), { recursive: true, mode: 0o700 });
    let settled = true;
    try {
      await putApplicationFixtureFile(root, ['vitest.config.mjs'], `export default {
  test: { include: ['failure.fixture.test.mjs'], maxWorkers: 1, hookTimeout: 1000 }
};\n`);
      await putApplicationFixtureFile(root, ['failure.fixture.test.mjs'], `
import { afterEach, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { ApiFixtureLifecycle } from ${JSON.stringify(helper)};
let scope;
afterEach(async () => {
  await scope.drain(500);
  await writeFile('teardown-drained.txt', 'cleanup finished before worker exit');
});
it('deliberately times out during pending owned cleanup', async ({ signal }) => {
  scope = new ApiFixtureLifecycle('timeout integration', signal);
  await scope.run(async () => {
    await setTimeout(100);
    await writeFile('cleanup-settled.txt', 'owned cleanup released');
  });
  await scope.run(() => writeFile('forbidden-approval.txt', 'must not execute'));
}, 20);
`);
      settled = false;
      const result = await new NodeCommandRunner().run({
        executable: process.execPath,
        args: [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(root, 'vitest.config.mjs'), '--root', root,
          '--reporter=json', '--outputFile', path.join(root, 'result.json')]
      }, {
        cwd: root, env: { ...process.env, TMPDIR: path.join(root, 'scratch'), TEMP: path.join(root, 'scratch'), TMP: path.join(root, 'scratch') },
        timeoutMs: 20_000, maxOutputBytes: 65_536, ensureProcessTreeSettled: true
      });
      settled = result.processTreeSettled === true;
      expect(settled, result.errorMessage).toBe(true);
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
      expect(report.numFailedTests).toBe(1);
      expect(report.success).toBe(false);
      expect(JSON.stringify(report)).toContain('Test timed out in 20ms');
      expect(await readFile(path.join(root, 'cleanup-settled.txt'), 'utf8')).toBe('owned cleanup released');
      expect(await readFile(path.join(root, 'teardown-drained.txt'), 'utf8')).toBe('cleanup finished before worker exit');
      await expect(lstat(path.join(root, 'forbidden-approval.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (settled) await rm(root, { recursive: true, force: true });
      else throw new Error(`Nested test process settlement is unconfirmed; retaining ${root}`);
    }
  });
});
