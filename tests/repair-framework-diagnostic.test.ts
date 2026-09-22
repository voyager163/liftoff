import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  frameworkCwdGeometry, frameworkProbeRecorder, frameworkStorageObservation, frameworkVersionObservation
} from './fixtures/framework-diagnostic.js';
import { createOwnedFixtureRoot } from './fixtures/owned-root.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });
function result(stdout = '12.0.2\n'): CommandResult {
  return { command: { executable: process.execPath, args: [] }, displayCommand: 'PRIVATE_PATH',
    status: 0, signal: null, stdout, stderr: '', timedOut: false, processTreeSettled: true, processSpawned: true };
}

it.each([
  ['arbitrary PRIVATE_STDOUT', '12.0.2', ['version-unrecognized']],
  ['11.9.9', '11.9.9', ['release-line-mismatch', 'below-minimum']],
  ['12.0.2', '12.0.3', ['declaration-version-mismatch']],
  ['12.0.2-PRIVATE_SUFFIX', '12.0.2', ['version-unrecognized']],
  ['12.0.2-PRIVATE-SUFFIX', '12.0.2', ['version-not-stable-three-part', 'prerelease-forbidden', 'declaration-version-mismatch']]
])('projects finite predicate metadata without publishing arbitrary version text (%s)', (output, declared, predicates) => {
  const observation = frameworkVersionObservation('npm', result(output), declared);
  expect(observation.predicates).toEqual(predicates);
  expect(JSON.stringify(observation)).not.toMatch(/PRIVATE_|STDOUT|PATH|SUFFIX/);
});

it('keeps a failed probe a command failure instead of declaring its version incompatible', () => {
  const observation = frameworkVersionObservation('npm', {
    ...result('PRIVATE_FAILURE'), status: null, timedOut: true, processTreeSettled: false
  }, '12.0.2');
  expect(observation.predicates).toEqual(['command-result-unsuccessful']);
  expect(observation.commandFailureKind).not.toBeNull();
});

it('observes the original invocation and result once and delegates unregistered commands unchanged', async () => {
  const root = (await createOwnedFixtureRoot(os.tmpdir(), 'lf-probe-')).name; roots.push(root);
  const cli = path.join(root, 'npm', 'bin', 'npm-cli.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '// NONFUNCTIONAL_TEST_LAUNCHER\n');
  await writeFile(path.join(root, 'npm', 'package.json'), '{"name":"npm","version":"12.0.2"}');
  const calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [], original = result();
  const inner: CommandRunner = { async run(command, options) { calls.push({ command, options }); return original; } };
  const recorder = frameworkProbeRecorder(inner);
  const command = { executable: process.execPath, args: [cli, '--version'] };
  const options = { cwd: root, timeoutMs: 15_000, maxOutputBytes: 8192, env: { PRIVATE_ENVIRONMENT: 'NOT_LOGGED' } };
  expect(await recorder.runner.run(command, options)).toBe(original);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.command).toBe(command);
  expect(calls[0]?.options).toBe(options);
  expect(recorder.snapshot()).toMatchObject({ additionalCommands: 0, truncated: false,
    observations: [{ tool: 'npm', filesStable: true, resultUnchanged: true,
      result: { parsedNumericVersion: '12.0.2', declaredNumericVersion: '12.0.2', predicates: [] } }] });
  expect(JSON.stringify(recorder.snapshot())).not.toContain(root);
  expect(JSON.stringify(recorder.snapshot())).not.toMatch(/PRIVATE_|NOT_LOGGED|NONFUNCTIONAL_TEST_LAUNCHER/);
  const unregistered = { executable: process.execPath, args: ['-e', 'PRIVATE_UNREGISTERED'] };
  expect(await recorder.runner.run(unregistered, options)).toBe(original);
  expect(calls).toHaveLength(2);
  expect(recorder.snapshot().observations).toHaveLength(1);
});

it.each(['missing', 'changed'] as const)('reports %s declaration metadata without changing the original result', async kind => {
  const root = (await createOwnedFixtureRoot(os.tmpdir(), 'lf-probe-')).name; roots.push(root);
  const cli = path.join(root, 'npm', 'bin', 'npm-cli.js'), declaration = path.join(root, 'npm', 'package.json');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '// NONFUNCTIONAL_TEST_LAUNCHER\n');
  if (kind === 'changed') await writeFile(declaration, '{"name":"npm","version":"12.0.2"}');
  const original = result();
  const recorder = frameworkProbeRecorder({ async run() {
    await writeFile(declaration, '{"name":"npm","version":"12.0.3"}');
    return original;
  } });
  expect(await recorder.runner.run({ executable: process.execPath, args: [cli, '--version'] })).toBe(original);
  expect(recorder.snapshot()).toMatchObject({ observations: [{
    before: kind === 'missing' ? { status: 'unavailable', code: 'file-read-unavailable' } : { status: 'observed' },
    after: { status: 'observed' }, filesStable: false, resultUnchanged: true,
    result: { predicates: kind === 'missing' ? ['declaration-unobserved'] : [] }
  }] });
});

it('bounds concurrent metadata observations without suppressing any original calls', async () => {
  const root = (await createOwnedFixtureRoot(os.tmpdir(), 'lf-probe-')).name; roots.push(root);
  let calls = 0;
  const original = result();
  const recorder = frameworkProbeRecorder({ async run() { calls++; return original; } });
  const command = { executable: path.join(root, 'absent-runtime'), args: ['--version'] };
  const results = await Promise.all(Array.from({ length: 6 }, () => recorder.runner.run(command)));
  expect(calls).toBe(6);
  expect(results.every(value => value === original)).toBe(true);
  expect(recorder.snapshot()).toMatchObject({ truncated: true, additionalCommands: 0 });
  expect(recorder.snapshot().observations).toHaveLength(4);
});

it('rethrows the original runner error without recording its private message', async () => {
  const original = new Error('PRIVATE_DIAGNOSTIC_SENTINEL');
  const recorder = frameworkProbeRecorder({ async run() { throw original; } });
  await expect(recorder.runner.run({ executable: process.execPath, args: ['--version'] })).rejects.toBe(original);
  expect(recorder.snapshot()).toMatchObject({ observations: [{ tool: 'node', status: 'runner-threw', resultUnchanged: true }] });
  expect(JSON.stringify(recorder.snapshot())).not.toContain(original.message);
});

it('accounts for project/home and every logical, resolved and preparation cwd at the native boundary', () => {
  const root = 'C:\\' + 'a'.repeat(170);
  const policy = { commands: [{ cwdPathParts: ['backend'] }, { cwdPathParts: ['frontend'] }],
    executionCommands: [{ cwdPathParts: ['resolved'] }],
    preparation: [{ cwdPathParts: ['prepare'], commands: [{ cwdPathParts: ['prepare', 'nested'] }] }] };
  const geometry = frameworkCwdGeometry(root, policy);
  expect(geometry).toHaveLength(7);
  expect(geometry.map(item => item.depth)).toEqual([0, 0, 1, 1, 1, 1, 2]);
  expect(geometry.every(item => item.nativeUnits === item.length + 2)).toBe(true);
  expect(geometry.at(-1)?.withinNativeLimit).toBe(false);
  expect(() => frameworkCwdGeometry(root, { commands: [{ cwdPathParts: ['..'] }], executionCommands: [], preparation: [] }))
    .toThrow('portable');
  expect(() => frameworkCwdGeometry(root, {
    commands: Array.from({ length: 63 }, () => ({ cwdPathParts: [] })), executionCommands: [], preparation: []
  })).toThrow('bounded inventory');
});

it.each(['foreign', 'alias'] as const)('withholds %s storage metadata without allocating a workspace', async kind => {
  const parent = (await createOwnedFixtureRoot(os.tmpdir(), 'lf-geometry-')).name; roots.push(parent);
  const home = (await createOwnedFixtureRoot(os.tmpdir(), 'lf-geometry-')).name; roots.push(home);
  const project = path.join(parent, 'project'), alias = path.join(parent, 'alias');
  await mkdir(project);
  if (kind === 'alias') await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readdir(parent), beforeHome = await readdir(home);
  const observation = await frameworkStorageObservation({ parent, root: project, home: kind === 'alias' ? alias : home },
    { commands: [], executionCommands: [], preparation: [] });
  expect(observation).toMatchObject({ status: 'unavailable', newWorkspaceAllocated: false });
  expect(await readdir(parent)).toEqual(before);
  expect(await readdir(home)).toEqual(beforeHome);
  expect(JSON.stringify(observation)).not.toContain(parent);
  expect(JSON.stringify(observation)).not.toContain(home);
});
