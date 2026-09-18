import { randomUUID } from 'node:crypto';
import { mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeProbeEnvironment } from '../../src/adapters/distribution/native-admission.js';
import { resolveNpmToolInvocation } from '../../src/adapters/distribution/npm-invocation.js';
import { encodeWindowsEnvironmentBlock, decodeWindowsEnvironmentBlock } from '../../src/adapters/process/windows-job-protocol.js';
import { assertNativeCommandInvocation } from '../../src/adapters/distribution/native-command-runner.js';
import { requireWinGetReadOnlyBindings, type WinGetReadOnlyRecords } from '../../src/adapters/distribution/winget-adapter.js';
import { WinGetReadOnlyObservationError, winGetReadOnlyObservationBlocker } from '../../src/domain/distribution/errors.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = path.resolve('tests', `.native-windows-invocation-${randomUUID()}`);
  roots.push(root);
  const toolRoot = path.join(root, 'selected npm tool');
  const cwd = path.join(root, 'unrelated project');
  const packageRoot = path.join(toolRoot, 'node_modules', 'npm');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await mkdir(cwd);
  const launcher = path.join(toolRoot, 'npm.cmd');
  const script = path.join(packageRoot, 'bin', 'npm-cli.js');
  const node = path.join(toolRoot, 'node.exe');
  await writeFile(launcher, 'fixture npm launcher: not executed');
  await writeFile(script, 'fixture npm script: not executed');
  await writeFile(node, 'fixture interpreter binding: not executed');
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'npm', version: '11.6.2', bin: { npm: 'bin/npm-cli.js' }
  }));
  return { root, toolRoot, cwd, packageRoot, launcher, script, node };
}

describe('Windows native environment boundary', () => {
  it('produces one canonical spelling for the strict Windows environment encoder', () => {
    const env = nativeProbeEnvironment({
      Path: 'C:\\selected tools', UserProfile: 'C:\\selected home', SystemRoot: 'C:\\Windows',
      node_options: '--require untrusted.js', NODE_PATH: 'C:\\unselected modules'
    }, 'win32');
    const defined = Object.entries(env).filter(([, value]) => value !== undefined);
    expect(new Set(defined.map(([key]) => key.toUpperCase())).size).toBe(defined.length);
    const decoded = decodeWindowsEnvironmentBlock(encodeWindowsEnvironmentBlock(env));
    expect(decoded.PATH).toBe('C:\\selected tools');
    expect(decoded.USERPROFILE).toBe('C:\\selected home');
    expect(decoded.SYSTEMROOT).toBe('C:\\Windows');
    expect(decoded.NODE_OPTIONS).toBeUndefined();
    expect(decoded.NODE_PATH).toBeUndefined();
    expect(decoded.LIFTOFF_TELEMETRY).toBe('0');
  });

  it('rejects ambiguous caller aliases instead of silently choosing a different environment', () => {
    expect(() => nativeProbeEnvironment({ Path: 'first', PATH: 'second' }, 'win32')).toThrow(/ambiguous case aliases/);
    expect(() => nativeProbeEnvironment({ Home: 'first', HOME: 'first' }, 'win32')).toThrow(/ambiguous case aliases/);
    expect(nativeProbeEnvironment({ Path: 'first', PATH: 'second' }, 'linux')).toMatchObject({ Path: 'first', PATH: 'second' });
  });
});

describe('Windows implementation and qualification blockers', () => {
  it.each(['cmd', 'bat', 'ps1', 'js', 'mjs', 'cjs', 'sh'])('rejects raw .%s launchers before the native controller', (extension) => {
    expect(() => assertNativeCommandInvocation({
      executable: `C:\\selected package\\liftoff.${extension}`, args: ['--version']
    }, { cwd: 'C:\\neutral context' }, 'win32')).toThrow(expect.objectContaining({ reasonCode: 'qualification_required' }));
  });

  it('allows only the literal native invocation shape, not a claim of Windows qualification', () => {
    expect(() => assertNativeCommandInvocation({
      executable: 'C:\\selected node\\node.exe', args: ['C:\\selected npm\\npm-cli.js', 'root', '--global']
    }, { cwd: 'C:\\neutral context' }, 'win32')).not.toThrow();
    expect(() => assertNativeCommandInvocation({ executable: 'npm', args: ['root'] }, { cwd: 'C:\\neutral context' }, 'win32'))
      .toThrow(expect.objectContaining({ reasonCode: 'unsafe_path' }));
  });

  it('distinguishes absent implementation and tool binding from missing launcher qualification', () => {
    expect(() => requireWinGetReadOnlyBindings({ executable: 'C:\\tools\\winget.exe' }))
      .toThrow(WinGetReadOnlyObservationError);
    expect(winGetReadOnlyObservationBlocker).toContain('PackageCatalogReference.Connect');
    expect(winGetReadOnlyObservationBlocker).toContain('AvailableVersions and GetApplicableInstaller');
    expect(winGetReadOnlyObservationBlocker).toContain('cached-only');
    expect(new WinGetReadOnlyObservationError()).toMatchObject({ reasonCode: 'implementation_missing' });
    const records: WinGetReadOnlyRecords = { read: async () => { throw new Error('Readiness inspection must not query a provider.'); } };
    expect(() => requireWinGetReadOnlyBindings({ records }))
      .toThrow(expect.objectContaining({ reasonCode: 'tool_unavailable' }));
    expect(requireWinGetReadOnlyBindings({ records, executable: 'C:\\tools\\winget.exe' }).records).toBe(records);
  });
});

describe('Windows npm literal interpreter binding', () => {
  it('maps only the selected adjacent npm package to node.exe plus npm-cli.js', async () => {
    const value = await fixture();
    const result = await resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32');
    expect(result.executable).toBe(value.node);
    expect(result.argsPrefix).toEqual([value.script]);
    expect(result.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.argsPrefix)).toBe(true);
    expect(result.executable).not.toBe(value.launcher);
  });

  it('binds script, package, launcher, and interpreter changes to the exact operation', async () => {
    const value = await fixture();
    const initial = await resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32');
    await writeFile(value.script, 'changed npm script');
    const changed = await resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32');
    expect(changed.bindingDigest).not.toBe(initial.bindingDigest);
    await writeFile(value.node, 'changed interpreter');
    expect((await resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32')).bindingDigest).not.toBe(changed.bindingDigest);
  });

  it('does not select a cwd lookalike or substitute the CLI private runtime when Node is absent', async () => {
    const value = await fixture();
    await unlink(value.node);
    await mkdir(path.join(value.cwd, 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(path.join(value.cwd, 'node.exe'), 'unapproved cwd interpreter');
    await writeFile(path.join(value.cwd, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'unapproved cwd npm');
    await expect(resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32')).rejects.toThrow(/no observed external node.exe/);
  });

  it('uses explicit PATH precedence only when the selected npm installation lacks a paired Node', async () => {
    const value = await fixture();
    await unlink(value.node);
    const first = path.join(value.root, 'first Node'), second = path.join(value.root, 'second Node');
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, 'node.exe'), 'selected external interpreter');
    await writeFile(path.join(second, 'node.exe'), 'later interpreter');
    const result = await resolveNpmToolInvocation(value.launcher, { Path: `${first};${second}` }, value.cwd, 'win32');
    expect(result.executable).toBe(path.join(first, 'node.exe'));
    expect(result.argsPrefix).toEqual([value.script]);
  });

  it('rejects renamed package identity, escaping bin declarations, and linked scripts', async () => {
    const value = await fixture();
    const metadata = path.join(value.packageRoot, 'package.json');
    await writeFile(metadata, JSON.stringify({ name: 'other-tool', version: '11.6.2', bin: { npm: 'bin/npm-cli.js' } }));
    await expect(resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32')).rejects.toThrow(/canonical npm-cli.js package/);
    await writeFile(metadata, JSON.stringify({ name: 'npm', version: '11.6.2', bin: { npm: '../outside.js' } }));
    await expect(resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32')).rejects.toThrow(/canonical npm-cli.js package/);
    await writeFile(metadata, JSON.stringify({ name: 'npm', version: '11.6.2', bin: { npm: 'bin/npm-cli.js' } }));
    await unlink(value.script);
    await symlink(path.join(value.cwd, 'unapproved.js'), value.script);
    await expect(resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'win32')).rejects.toThrow(/symlink/);
  });

  it('preserves POSIX tool invocation instead of introducing a new interpreter or shell layer', async () => {
    const value = await fixture();
    const result = await resolveNpmToolInvocation(value.launcher, { PATH: '' }, value.cwd, 'linux');
    expect(result.executable).toBe(value.launcher);
    expect(result.argsPrefix).toEqual([]);
  });
});
