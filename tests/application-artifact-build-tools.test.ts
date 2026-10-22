import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationArtifactBuildToolObservationProgram as program, applicationArtifactBuildToolObligations
} from '../src/governance-activation/application-artifact-build-tools.js';
import { NodeCommandRunner } from '../src/process-runner.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const recipe = {
  version: 'oci-digest-v1', builderName: 'reviewed-existing-builder',
  buildxVersion: 'v0.30.1', buildkitVersion: 'v0.26.2'
};
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-static-build-tools-')));
  roots.push(root);
  const bin = path.join(root, 'bin'), config = path.join(root, 'docker');
  for (const directory of [bin, config, path.join(config, 'cli-plugins'), path.join(config, 'buildx', 'instances')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  for (const tool of ['node', 'git', 'az', 'docker']) {
    fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 79\n', { mode: 0o755 });
  }
  const plugin = path.join(config, 'cli-plugins', 'docker-buildx');
  fs.writeFileSync(plugin, '#!/bin/sh\nexit 83\n', { mode: 0o755 });
  const builder = path.join(config, 'buildx', 'instances', recipe.builderName);
  const declaration = {
    Name: recipe.builderName, Driver: 'docker-container', Dynamic: false,
    Nodes: [{ Name: `${recipe.builderName}0`, Endpoint: 'default', DriverOpts: { 'env.PRIVATE': 'not-for-output' } }]
  };
  fs.writeFileSync(builder, JSON.stringify(declaration), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'config.json'), 'credential-config-must-not-be-opened', { mode: 0o600 });
  return { root, bin, config, plugin, builder, declaration,
    env: { PATH: bin, DOCKER_CONFIG: config, LIFTOFF_DIGEST_RECIPE: JSON.stringify(recipe) } };
}
function observe(f: ReturnType<typeof fixture>, overrides: {
  environment?: Record<string, string>;
  filesystem?: Partial<typeof fs>;
  platform?: NodeJS.Platform;
} = {}) {
  let output = '';
  const opened: string[] = [];
  const filesystem = {
    ...fs, openSync: (filename: fs.PathLike, flags: number) => {
      opened.push(String(filename));
      return fs.openSync(filename, flags);
    }, ...overrides.filesystem
  };
  new Script(program.replace(/^import .+;\n/gmu, '')).runInNewContext({
    fs: filesystem, path, createHash, Buffer,
    process: { platform: overrides.platform ?? 'linux', execPath: path.join(f.bin, 'node'),
      getuid: () => process.getuid?.() ?? 0, env: { ...f.env, ...overrides.environment } },
    console: { log: (value: string) => { output += value; } }
  }, { timeout: 5_000 });
  const result: unknown = JSON.parse(output);
  return { result, output, opened };
}

it('uses the genuine process adapter with bounded stdin and emits no provider diagnostics', async () => {
  const f = fixture();
  const result = await new NodeCommandRunner().run({
    executable: process.execPath, args: ['--input-type=module']
  }, { cwd: f.root, stdin: program, inheritEnvironment: false, env: f.env,
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024, stream: false,
    ensureProcessTreeSettled: process.platform !== 'win32' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({
    qualification: 'not-issued',
    ...(process.platform === 'linux' ? {} : { status: 'blocked', code: 'host-unsupported', files: [] })
  });
});

describe.skipIf(process.platform === 'win32')('POSIX physical files, never Linux-host qualification', () => {
  it('reads and reobserves actual files and the selected local declaration without executing plugins or reading auth', () => {
    const f = fixture(), { result, output, opened } = observe(f);
    expect(result).toMatchObject({
      status: 'observed', code: 'complete-closure-unavailable', qualification: 'not-issued',
      scope: 'physical-files-and-local-builder-declaration', pluginSelection: 'not-established',
      obligations: applicationArtifactBuildToolObligations,
      builder: { name: recipe.builderName, scope: 'local-declaration-only', runningVersion: 'not-observed' },
      files: expect.arrayContaining(['node', 'git', 'azure-launcher', 'docker-client', 'buildx-candidate', 'builder-declaration']
        .map(role => ({ role, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          physicalDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), bytes: expect.any(Number), mode: expect.any(Number) })))
    });
    expect(opened.filter(file => file === f.plugin)).toHaveLength(2);
    expect(opened).not.toContain(path.join(f.config, 'config.json'));
    expect(output).not.toContain('not-for-output');
    expect(output).not.toContain(f.root);
    expect(output).not.toContain('toolQualificationDigest');
    expect(program).not.toMatch(/child_process|spawn|execFile|fetch\(|https?:\/\//u);
  });
  it.each([
    ['DOCKER_HOST', 'tcp://different-host'], ['BUILDKIT_HOST', 'tcp://different-builder'],
    ['DOCKER_CONTEXT', 'other'], ['BUILDX_CONFIG', '/another/config'], ['DOCKER_TLS_VERIFY', '1'],
    ['DOCKER_CERT_PATH', '/another/certificate'], ['DOCKER_API_VERSION', '1.24']
  ])('refuses %s without observing or executing any tool', (name, value) => {
    const f = fixture(), { result, opened } = observe(f, { environment: { [name]: value } });
    expect(result).toMatchObject({ status: 'blocked', code: 'ambient-builder-override', files: [] });
    expect(opened).toEqual([]);
  });
  it.each(['darwin', 'win32'] as const)('does not turn %s files into Linux-host evidence', platform => {
    const { result, opened } = observe(fixture(), { platform });
    expect(result).toMatchObject({ status: 'blocked', code: 'host-unsupported', files: [] });
    expect(opened).toEqual([]);
  });
  it.each(['relative/bin', '/safe::/also-safe'])('refuses unsafe PATH %s rather than inspecting the working directory', PATH => {
    const { result, opened } = observe(fixture(), { environment: { PATH } });
    expect(result).toMatchObject({ status: 'blocked', code: 'tool-path-unsafe', files: [] });
    expect(opened).toEqual([]);
  });
  it('rejects missing and decorated recipe versions rather than observing a legacy default', () => {
    const f = fixture();
    for (const change of [{ version: 'oci-digest-v2' }, { qualified: true }, { builderName: '../escape' }]) {
      expect(observe(f, { environment: { LIFTOFF_DIGEST_RECIPE: JSON.stringify({ ...recipe, ...change }) } }).result)
        .toMatchObject({ status: 'blocked', code: 'recipe-invalid', files: [] });
    }
  });
  it('retains actual partial file observation when a later client is absent', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.bin, 'docker'));
    expect(observe(f).result).toMatchObject({ status: 'blocked', code: 'client-file-unavailable',
      qualification: 'not-issued', files: [
        { role: 'node' }, { role: 'git' }, { role: 'azure-launcher' }
      ] });
  });
  it.each(['writable', 'hardlink', 'not-executable', 'oversized'] as const)('refuses %s client files', kind => {
    const f = fixture(), file = path.join(f.bin, 'git');
    if (kind === 'writable') fs.chmodSync(file, 0o777);
    if (kind === 'hardlink') fs.linkSync(file, path.join(f.bin, 'other-name'));
    if (kind === 'not-executable') fs.chmodSync(file, 0o600);
    if (kind === 'oversized') fs.truncateSync(file, 129 * 1024 * 1024);
    expect(observe(f).result).toMatchObject({ status: 'blocked', code: 'tool-file-unsafe', qualification: 'not-issued' });
  });
  it('refuses an unprotected credential directory without opening credentials or clients', () => {
    const f = fixture();
    fs.chmodSync(f.config, 0o755);
    const { result, opened } = observe(f);
    expect(result).toMatchObject({ status: 'blocked', code: 'credential-scope-unavailable' });
    expect(opened).toEqual([]);
  });
  it.each([
    { Driver: 'remote' }, { Dynamic: true }, { Name: 'another-builder' }, { Nodes: [] },
    { Nodes: [{ Name: 'other', Endpoint: 'tcp://elsewhere' }] }
  ])('refuses incompatible local builder metadata %j', change => {
    const f = fixture();
    fs.writeFileSync(f.builder, JSON.stringify({ ...f.declaration, ...change }));
    expect(observe(f).result).toMatchObject({ status: 'blocked', code: 'builder-declaration-mismatch' });
  });
  it.each(['invalid-json', 'oversized'])('bounds and refuses %s builder metadata', change => {
    const f = fixture();
    fs.writeFileSync(f.builder, change === 'invalid-json' ? '{' : ' '.repeat(65 * 1024));
    expect(observe(f).result).toMatchObject({ status: 'blocked',
      code: change === 'invalid-json' ? 'builder-declaration-invalid' : 'tool-file-unsafe' });
  });
  it('refuses a physical file changed between its first read and final reobservation', () => {
    const f = fixture();
    let changed = false;
    const { result } = observe(f, { filesystem: {
      openSync: ((filename: fs.PathLike, flags: number) => {
        if (String(filename) === f.builder && !changed) {
          fs.appendFileSync(f.plugin, '# changed\n');
          changed = true;
        }
        return fs.openSync(filename, flags);
      }) as typeof fs.openSync
    } });
    expect(changed).toBe(true);
    expect(result).toMatchObject({ status: 'blocked', code: 'tool-file-changed', qualification: 'not-issued' });
  });
  it('refuses linked builder metadata rather than reading an unrelated private file', () => {
    const f = fixture();
    fs.unlinkSync(f.builder);
    fs.symlinkSync(path.join(f.config, 'config.json'), f.builder);
    const { result, opened } = observe(f);
    expect(result).toMatchObject({ status: 'blocked', code: 'tool-path-unsafe' });
    expect(opened).not.toContain(path.join(f.config, 'config.json'));
  });
  it('sanitizes filesystem failure details rather than printing paths or credentials', () => {
    const f = fixture();
    const realpathSync = Object.assign(() => {
      throw new Error('provider-secret-path-and-token');
    }, { native: fs.realpathSync.native });
    const { result, output } = observe(f, { filesystem: { realpathSync } });
    expect(result).toMatchObject({ status: 'blocked', code: 'file-unobservable' });
    expect(output).not.toContain('provider-secret-path-and-token');
  });
});
