import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModernHelperCommand } from '../src/application/project/helper-commands.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { commandShellForPlatform, formatShellCommand } from '../src/adapters/process/shell-command.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import type { LiftoffManifestV8 } from '../src/domain/project/manifest/v8.js';
import { createOpenSpecExecutionFixture, originalFiles } from './modern-openspec-fixtures.js';
import { writeModernSuccessor } from './fixtures/modern-installed-project.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import * as installed from '../src/application/governance/modern-installed-preflight.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: { path: string; dev: number; ino: number }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of roots.splice(0)) {
    const current = await fs.lstat(owner.path);
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    expect([current.dev, current.ino]).toEqual([owner.dev, owner.ino]);
    await fs.rm(owner.path, { recursive: true });
  }
});
function modern(raw: unknown): LiftoffManifestV8 {
  const manifest = parseProjectManifest(raw);
  if (manifest.artifactVersion !== 8) throw new Error('Expected modern fixture.');
  return manifest;
}
async function fixture() {
  const f = await createOpenSpecExecutionFixture(roots);
  const environment = f.manifest.activeLayout.bindings.find(entry => entry.kind === 'component' && entry.component === 'opentofu-environment:dev')!;
  const variables = [...environment.pathParts, "reviewed input's.tfvars"];
  await f.put(variables, 'resource_group_name = "source-fixture"\n');
  const manifest = modern({ ...f.manifest, activeLayout: { ...f.manifest.activeLayout,
    bindings: [...f.manifest.activeLayout.bindings, { kind: 'artifact', logicalName: 'opentofu-dev-tfvars', pathParts: variables }] } });
  await f.put(['liftoff.manifest.json'], canonicalJson(manifest));
  return { ...f, manifest, environment, variables };
}
async function cli(directory: string, args: string[]) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner();
  const code = await runCommand(parseArgs(args), { cwd: directory, stdout, stderr, runner, terminal: { color: false } });
  expect(runner.calls).toEqual([]);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
const shell = commandShellForPlatform(process.platform);

describe('modern active-binding helper guidance', () => {
  it.each(['up', 'down', 'logs', 'reset'] as const)('prints dev %s against the explicit Compose file from a nested cwd', async action => {
    const f = await fixture(), cwd = path.join(f.root, 'nested work');
    await fs.mkdir(cwd);
    const before = await originalFiles(f.root);
    const result = await cli(cwd, ['dev', action, ...(action === 'up' ? ['--profile', "worker's profile"] : [])]);
    expect(result.code).toBe(0);
    const command = await buildModernHelperCommand(f.root, f.manifest, { command: 'dev', action, profile: "worker's profile" });
    expect(command).toEqual({ executable: 'docker', args: [
      'compose', '--project-directory', f.root, '--file', path.join(f.root, 'compose.yml'),
      ...(action === 'up' ? ['--profile', "worker's profile", 'up', '--build'] :
        action === 'logs' ? ['logs', '-f'] : ['down', ...(action === 'reset' ? ['--volumes'] : [])])
    ] });
    expect(result.stdout).toContain(formatShellCommand(command, shell));
    expect(result.stderr).toBe('');
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it.each(['init', 'plan', 'apply', 'output'] as const)('prints infra %s using active environment and variables bindings', async action => {
    const f = await fixture(), before = await originalFiles(f.root);
    const result = await cli(f.root, ['infra', action, '--env', 'dev']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(formatShellCommand({ executable: 'tofu', args: [
      `-chdir=${path.join(f.root, ...f.environment.pathParts)}`, action,
      ...(action === 'plan' || action === 'apply' ? [`-var-file=${path.join(f.root, ...f.variables)}`] : [])
    ] }, shell));
    expect(result.stdout).not.toContain('infrastructure/opentofu/azure/environments');
    expect(result.stderr).toBe('');
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('uses existing default actions and the recorded environment without a profile', async () => {
    const f = await fixture();
    expect((await buildModernHelperCommand(f.root, f.manifest, { command: 'dev' })).args.slice(-2)).toEqual(['up', '--build']);
    expect((await buildModernHelperCommand(f.root, f.manifest, { command: 'infra' })).args).toContain('plan');
  });

  it.each(['unresolved', 'missing-component', 'missing-variables', 'missing-compose'] as const)(
    'refuses %s rather than falling back to generation provenance', async fault => {
      const f = await fixture();
      const bindings = f.manifest.activeLayout.bindings.filter(entry => fault === 'missing-component'
        ? entry.kind !== 'component' || entry.component !== 'opentofu-environment:dev'
        : entry.kind !== 'artifact' || entry.logicalName !== (fault === 'missing-compose' ? 'docker-compose' : 'opentofu-dev-tfvars'));
      const manifest = modern({ ...f.manifest, activeLayout: fault === 'unresolved'
        ? { schemaVersion: 1, state: 'unresolved', bindings: [] }
        : { ...f.manifest.activeLayout, bindings },
      projectArtifacts: [{ logicalName: 'opentofu-dev-tfvars', category: 'infrastructure',
        pathParts: [...f.variables], generatedBy: '0.12.3', generationHash: `sha256:${'a'.repeat(64)}`, provisioningGroup: 'environment:dev' }] });
      await f.put(['liftoff.manifest.json'], canonicalJson(manifest));
      const before = await originalFiles(f.root), result = await cli(f.root, fault === 'missing-compose' ? ['dev', 'up'] : ['infra', 'plan']);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain('tofu -chdir');
      expect(result.stderr).toMatch(/binding|layout/i);
      expect(await originalFiles(f.root)).toEqual(before);
    }
  );

  it.each(['staging', 'test'])('rejects unselected environment %s before inspecting controls', async environment => {
    const f = await fixture(), inspect = vi.spyOn(installed, 'inspectModernInstalledActivation');
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'infra', environment })).rejects.toThrow(/not selected/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['missing', 'directory', 'multiple-links'] as const)('rejects a %s Compose target', async fault => {
    const f = await fixture(), compose = path.join(f.root, 'compose.yml');
    if (fault === 'multiple-links') await fs.link(compose, path.join(f.root, 'another-compose.yml'));
    else {
      await fs.rm(compose);
      if (fault === 'directory') await fs.mkdir(compose);
    }
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'dev' })).rejects.toThrow(/Missing active binding|single-link regular file/);
  });

  it('refuses a linked environment before reaching its payload', async () => {
    const f = await fixture(), target = path.join(f.root, ...f.environment.pathParts);
    const destination = path.join(roots.at(-1)!.path, 'external input');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'sentinel'), 'unchanged');
    await fs.rm(target, { recursive: true });
    await fs.symlink(destination, target, process.platform === 'win32' ? 'junction' : 'dir');
    const opens = vi.mocked(fs.open).mockClear();
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'infra', action: 'init' })).rejects.toThrow(/symlink|junction/);
    expect(opens.mock.calls.some(([file]) => String(file).startsWith(destination))).toBe(false);
    expect(await fs.readFile(path.join(destination, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  it.each(['.git', '.liftoff', 'LIFTOFF.MANIFEST.JSON'])('refuses nested boundary %s without reading its payload', async marker => {
    const f = await fixture(), parts = [...f.environment.pathParts, marker];
    await f.put(parts, 'Unrelated inner boundary; do not parse or follow.\n');
    const before = await originalFiles(f.root), opens = vi.mocked(fs.open).mockClear();
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'infra', action: 'init' })).rejects.toThrow(/nested project or repository/);
    expect(opens.mock.calls.some(([file]) => String(file) === path.join(f.root, ...parts))).toBe(false);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('accepts exactly 256 directory entries and refuses the 257th without claiming a complete observation', async () => {
    const f = await fixture();
    const existing = (await fs.readdir(path.join(f.root, ...f.environment.pathParts))).length;
    for (let index = existing; index < 256; index += 1) await f.put([...f.environment.pathParts, `extra-${index}`], 'fixture');
    expect(await fs.readdir(path.join(f.root, ...f.environment.pathParts))).toHaveLength(256);
    const accepted = await originalFiles(f.root);
    expect((await buildModernHelperCommand(f.root, f.manifest, { command: 'infra', action: 'init' })).executable).toBe('tofu');
    expect(await originalFiles(f.root)).toEqual(accepted);
    await f.put([...f.environment.pathParts, 'entry-257'], 'fixture');
    expect(await fs.readdir(path.join(f.root, ...f.environment.pathParts))).toHaveLength(257);
    const before = await originalFiles(f.root);
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'infra', action: 'init' })).rejects.toThrow(/256-entry directory observation limit/);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('preserves current-source, state-retention and command boundaries', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-helper-fixture-')));
    const owner = await fs.lstat(directory);
    roots.push({ path: directory, dev: owner.dev, ino: owner.ino });
    const f = await writeModernSuccessor(directory, 2, true, false, false, {
      layout: { schemaVersion: 1, state: 'bound',
        bindings: [{ kind: 'component', component: 'opentofu-environment:dev', pathParts: ['protected'] }] }
    });
    const before = await originalFiles(directory), opens = vi.mocked(fs.open).mockClear();
    await expect(buildModernHelperCommand(directory, f.plan.manifest.manifest, { command: 'infra', action: 'init' })).rejects.toThrow(/state\/key retention/);
    expect(opens.mock.calls.some(([file]) => String(file).startsWith(path.join(directory, 'protected')))).toBe(false);
    expect(await originalFiles(directory)).toEqual(before);
  });

  it('refuses control drift, stale selection and unknown helper actions', async () => {
    const f = await fixture();
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'dev', action: 'unknown' })).rejects.toThrow(/Unsupported dev/);
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'infra', action: 'unknown' })).rejects.toThrow(/Unsupported infra/);
    const changed = modern({ ...f.manifest, liftoffVersion: '0.13.1' });
    await f.put(['liftoff.manifest.json'], canonicalJson(changed));
    await expect(buildModernHelperCommand(f.root, f.manifest, { command: 'dev' })).rejects.toThrow(/manifest changed/);
    await f.put(changed.managedArtifacts[0].pathParts, 'modified core');
    await expect(buildModernHelperCommand(f.root, changed, { command: 'dev' })).rejects.toThrow(/control inspection failed/);
  });
});
