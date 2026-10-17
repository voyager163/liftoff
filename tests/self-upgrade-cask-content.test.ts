import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caskContentEnvironment, caskContentProgram, prepareAuthenticatedCaskContent,
  readCaskContentObservation, type CaskContentRequest } from '../src/adapters/distribution/native-cask-content.js';
import * as metadata from '../src/adapters/distribution/native-metadata.js';
import { NodeCommandRunner, type CommandResult } from '../src/process-runner.js';
import { stableReleaseLookupTimeoutMs } from '../src/stable-release.js';
import { signedMaterial } from './fixtures/native-stable-material.js';

const directories: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const prefix = '/opt/homebrew';
const tapRoot = `${prefix}/Library/Taps/fixture/homebrew-tools`;
const fixtureHost = fileURLToPath(new URL('./fixtures/cask-content-host.rb', import.meta.url));
const ruby = process.env.LIFTOFF_TEST_CASK_CONTENT_RUBY;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(nested = false) {
  const signed = signedMaterial('darwin-arm64');
  const candidate = await metadata.admitNativeStableMaterial(signed.material, { target: 'darwin-arm64' }, signed.policy);
  const controller = new AbortController();
  const input = {
    material: signed.material, candidate, policy: signed.policy,
    source: { prefix, path: `${tapRoot}/Casks/${nested ? 'l/' : ''}liftoff.rb`, tapCommit: 'd'.repeat(40) },
    signal: controller.signal
  };
  return { ...signed, input, controller, prepare: () => prepareAuthenticatedCaskContent(input) };
}

function response(request: CaskContentRequest): CommandResult {
  const { prefix: _prefix, definition: _definition, ...input } = JSON.parse(request.stdin);
  return {
    command: { executable: 'inert-fixture', args: [] }, displayCommand: 'inert-fixture',
    status: 0, signal: null, timedOut: false, processSpawned: true, processTreeSettled: true,
    stdout: JSON.stringify({ ...input, kind: 'liftoff-cask-content-observation',
      requestSha256: request.sha256, sourceChecksum: request.definitionSha256 }), stderr: ''
  };
}

describe('authenticated cask content preparation and strict child protocol', () => {
  it.each([false, true])('privately binds the canonical %s source layout without creating invocation or installation authority', async nested => {
    const world = await fixture(nested), request = await world.prepare();
    const input = JSON.parse(request.stdin);
    const definition = await metadata.authenticatedNativeCaskDefinition(world.material, world.input.candidate, world.policy);
    expect(input).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-cask-content-request', candidateIdentity: world.input.candidate.identity,
      definitionSha256: definition.sha256, sourcePath: world.input.source.path,
      fullToken: 'fixture/tools/liftoff', sourceRepository: 'fixture/homebrew-tools', tapCommit: 'd'.repeat(40),
      archiveSha256: world.input.candidate.archiveSha256, version: '0.13.0',
      artifactUrl: world.qualification.artifactUrl
    });
    expect(Buffer.from(input.definition, 'base64').toString('utf8')).toBe(definition.content);
    expect(request.sha256).toBe(hash(request.stdin));
    expect(Object.isFrozen(request)).toBe(true);
    const observation = readCaskContentObservation(request, response(request));
    expect(observation).toMatchObject({
      candidateIdentity: request.candidateIdentity, definitionSha256: request.definitionSha256,
      fullToken: 'fixture/tools/liftoff', sourcePath: world.input.source.path
    });
    expect(Object.isFrozen(observation)).toBe(true);
    for (const property of ['command', 'installed', 'installation', 'available', 'exactApply', 'owner', 'bundleRoot']) {
      expect(request).not.toHaveProperty(property);
      expect(observation).not.toHaveProperty(property);
    }
  });

  it.each(['identity', 'version', 'target', 'sourceCommit', 'archiveSha256', 'manifestSha256', 'inventorySha256'] as const)(
    'refuses a changed candidate %s', async field => {
      const world = await fixture();
      world.input.candidate[field] = 'foreign';
      await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it.each(['signer', 'namespace', 'repository', 'team'] as const)('refuses absent %s approval', async field => {
    const world = await fixture();
    if (field === 'signer') world.policy.approvedSigningKeySha256 = null;
    if (field === 'namespace') world.policy.homebrew.cask = null;
    if (field === 'repository') world.policy.homebrew.sourceRepository = null;
    if (field === 'team') world.policy.homebrew.developerTeamId = null;
    await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
  });

  it.each(['signature', 'public key', 'record', 'archive', 'provenance', 'evidence', 'stable tag', 'draft', 'prerelease'] as const)(
    'independently refuses changed %s material', async field => {
      const world = await fixture();
      if (field === 'signature') world.material.signature.fill(0);
      if (field === 'public key') world.material.publicKey.fill(0);
      if (field === 'record') world.material.record[0] ^= 1;
      if (field === 'archive') world.assets.get(world.record.files[0].filename)![0] ^= 1;
      if (field === 'provenance') world.assets.get('provenance.json')![0] ^= 1;
      if (field === 'evidence') world.platformEvidence.values().next().value![0] ^= 1;
      if (field === 'stable tag') world.material.stableTag = 'v0.13.1';
      if (field === 'draft') world.material.draft = true;
      if (field === 'prerelease') world.material.prerelease = true;
      await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    }
  );

  it.each(['URL', 'namespace', 'repository', 'team'] as const)('refuses a signed foreign %s', async field => {
    const world = await fixture();
    if (field === 'URL') world.qualification.artifactUrl = 'https://example.invalid/archive';
    if (field === 'namespace') world.qualification.channel!.id = 'foreign/tools/liftoff';
    if (field === 'repository') world.qualification.channel!.source = 'foreign/homebrew-tools';
    if (field === 'team') world.qualification.platformSigningIdentity = 'FOREIGN123';
    world.resign();
    await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it.each([
    { prefix: '/foreign' }, { prefix: '/opt/homebrew/' },
    { path: `${tapRoot}/Casks/../liftoff.rb` }, { path: `${tapRoot}/Casks/z/liftoff.rb` },
    { path: `${tapRoot}/Casks/liftoff.rb\n` }, { path: `${tapRoot}/Casks/other.rb` },
    { tapCommit: 'd'.repeat(39) }, { tapCommit: `${'d'.repeat(40)}\n` }
  ])('refuses a noncanonical source $path $prefix $tapCommit', async source => {
    const world = await fixture();
    Object.assign(world.input.source, source);
    await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it('bounds material before copying and does not borrow Linux archive authority', async () => {
    const world = await fixture();
    world.material.archivePublicKey = Buffer.from('foreign');
    world.material.archiveSignature = Buffer.from('foreign');
    world.policy.linux.archiveSigningKeySha256 = null;
    expect((await world.prepare()).definitionSha256).toMatch(/^[a-f0-9]{64}$/);
    world.assets.set('unclaimed', Buffer.from('foreign'));
    await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    world.assets.delete('unclaimed');
    world.material.publicKey = Buffer.alloc(4097);
    await expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_invalid' });
  });

  it('snapshots candidate, source, policy and bytes before asynchronous admission', async () => {
    const world = await fixture(), pending = world.prepare();
    world.input.candidate.identity = 'changed';
    world.input.source.path = '/foreign';
    world.policy.homebrew.cask = null;
    world.material.signature.fill(0);
    world.assets.get(world.record.files[0].filename)!.fill(0);
    expect(readCaskContentObservation(await pending, response(await pending))).toMatchObject({
      fullToken: 'fixture/tools/liftoff', sourcePath: `${tapRoot}/Casks/liftoff.rb`
    });
  });

  it.each(['before', 'during'])('honors cancellation %s preparation', async when => {
    const world = await fixture();
    if (when === 'before') world.controller.abort();
    const pending = world.prepare();
    if (when === 'during') world.controller.abort();
    await expect(pending).rejects.toMatchObject({ reasonCode: 'native_timeout' });
  });

  it('keeps the overall preparation deadline bounded independently of metadata completion', async () => {
    const world = await fixture();
    vi.useFakeTimers();
    vi.spyOn(metadata, 'lookupNativeStableCandidate').mockReturnValue(new Promise(() => {}));
    const failed = expect(world.prepare()).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await vi.advanceTimersByTimeAsync(stableReleaseLookupTimeoutMs);
    await failed;
  });

  it('does not mask an upstream snapshot budget failure as invalid metadata', async () => {
    const world = await fixture(), failure = new Error('fixture snapshot budget exhausted');
    Object.defineProperty(world.material, 'assets', { enumerable: true, get() { throw failure; } });
    await expect(world.prepare()).rejects.toBe(failure);
  });

  it('preserves an upstream runner output budget failure', async () => {
    const world = await fixture(), request = await world.prepare(), result = response(request);
    const failure = new Error('fixture output budget exhausted');
    Object.defineProperty(result, 'stdout', { get() { throw failure; } });
    expect(() => readCaskContentObservation(request, result)).toThrow(failure);
  });

  it('refuses cloned requests rather than treating a digest or asserted response as approval', async () => {
    const world = await fixture(), request = await world.prepare();
    expect(() => readCaskContentObservation({ ...request }, response(request))).toThrowError();
  });

  it.each(['status', 'signal', 'timedOut', 'aborted', 'outputLimitExceeded', 'errorCode', 'errorMessage',
    'processSpawned', 'processTreeSettled', 'stderr'] as const)('refuses a success-shaped response with %s failure', async field => {
    const world = await fixture(), request = await world.prepare(), result = response(request);
    if (field === 'status') result.status = 1;
    if (field === 'signal') result.signal = 'SIGTERM';
    if (field === 'timedOut' || field === 'aborted' || field === 'outputLimitExceeded') result[field] = true;
    if (field === 'errorCode' || field === 'errorMessage') result[field] = 'fixture failure';
    if (field === 'processSpawned' || field === 'processTreeSettled') result[field] = false;
    if (field === 'stderr') result.stderr = '\n';
    expect(() => readCaskContentObservation(request, result)).toThrowError();
  });

  it.each(['processSpawned', 'processTreeSettled'])('requires positive %s observation', async field => {
    const world = await fixture(), request = await world.prepare(), result = response(request);
    Reflect.deleteProperty(result, field);
    expect(() => readCaskContentObservation(request, result)).toThrowError();
  });

  it.each(['candidateIdentity', 'definitionSha256', 'version', 'archiveSha256', 'artifactUrl', 'fullToken',
    'sourceRepository', 'sourcePath', 'tapCommit', 'requestSha256', 'sourceChecksum', 'kind', 'schemaVersion'])(
    'refuses changed child %s binding', async field => {
      const world = await fixture(), request = await world.prepare(), result = response(request);
      const body = JSON.parse(result.stdout);
      body[field] = 'foreign';
      result.stdout = JSON.stringify(body);
      expect(() => readCaskContentObservation(request, result)).toThrowError();
    }
  );

  it.each(['extra', 'missing', 'duplicate', 'trailing JSON', 'trailing whitespace', 'malformed', 'oversized'])(
    'refuses %s child output', async kind => {
      const world = await fixture(), request = await world.prepare(), result = response(request);
      if (kind === 'extra') result.stdout = result.stdout.replace(/}$/, ',"installed":true}');
      if (kind === 'missing') result.stdout = '{}';
      if (kind === 'duplicate') result.stdout = result.stdout.replace('{"schemaVersion":1,', '{"schemaVersion":1,"schemaVersion":1,');
      if (kind === 'trailing JSON') result.stdout += '{}';
      if (kind === 'trailing whitespace') result.stdout += '\n';
      if (kind === 'malformed') result.stdout = 'not JSON';
      if (kind === 'oversized') result.stdout = ' '.repeat(16 * 1024 + 1);
      expect(() => readCaskContentObservation(request, result)).toThrowError();
    }
  );
});

describe.skipIf(!ruby || process.platform === 'win32')('opt-in inert Ruby content host, not real Homebrew qualification', () => {
  async function rubyFixture(nested = false) {
    if (!ruby || !path.isAbsolute(ruby)) throw new Error('LIFTOFF_TEST_CASK_CONTENT_RUBY must name an existing absolute Ruby executable.');
    const world = await fixture(nested), request = await world.prepare();
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-cask-content-')));
    directories.push(root);
    const local = (filename: string) => path.join(root, filename.slice(prefix.length));
    await mkdir(local(`${tapRoot}/Casks/l`), { recursive: true });
    await mkdir(local(`${tapRoot}/.git`), { recursive: true });
    await mkdir(path.join(root, 'home'));
    await writeFile(local(`${tapRoot}/.git/config`), '[remote "origin"]\nurl = https://github.com/fixture/homebrew-tools.git\n');
    await writeFile(local(world.input.source.path), Buffer.from(JSON.parse(request.stdin).definition, 'base64'));
    const runner = new NodeCommandRunner();
    const env = {
      ...caskContentEnvironment, PATH: '', RUBYOPT: '', RUBYLIB: '', HOME: path.join(root, 'home'),
      HOMEBREW_FORBIDDEN_CASKS: 'foreign', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0',
      LIFTOFF_FIXTURE_ROOT: root, LIFTOFF_FIXTURE_HOME: path.join(root, 'home')
    };
    const run = (options: { change?: string; stdin?: string; pin?: string; env?: NodeJS.ProcessEnv;
      signal?: AbortSignal; timeoutMs?: number } = {}) =>
      runner.run({ executable: ruby, args: ['-r', fixtureHost, '-e', caskContentProgram, options.pin ?? request.sha256] }, {
        cwd: root, inheritEnvironment: false, env: { ...env, LIFTOFF_FIXTURE_CHANGE: options.change, ...options.env },
        stdin: options.stdin ?? request.stdin, timeoutMs: options.timeoutMs ?? 5000, signal: options.signal,
        maxOutputBytes: 16 * 1024, ensureProcessTreeSettled: true
      });
    return { ...world, root, local, request, run };
  }

  it.each([false, true])('loads exact private stdin with genuine-shaped %s attribution, source checksum and retained restrictions', async nested => {
    const world = await rubyFixture(nested), result = await world.run();
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: '', processTreeSettled: true, processSpawned: true });
    expect(result.stdout).toBe(response(world.request).stdout);
    expect(readCaskContentObservation(world.request, result).sourcePath).toBe(world.input.source.path);
    expect(await readFile(path.join(world.root, 'fixture-loaded'), 'utf8')).toBe('loaded');
    expect(await readFile(world.local(world.input.source.path), 'utf8')).toBe(
      Buffer.from(JSON.parse(world.request.stdin).definition, 'base64').toString('utf8'));
  });

  it.each([
    { change: 'trust', phase: 'trust', loaded: false },
    { change: 'trust-after', phase: 'recheck', loaded: true },
    { change: 'trust-opt-out', phase: 'trust', loaded: false },
    { change: 'tap-absent', phase: 'host', loaded: false },
    { change: 'attribution', phase: 'content', loaded: true },
    { change: 'checksum', phase: 'content', loaded: true },
    { change: 'source', phase: 'content', loaded: true },
    { change: 'source-after-checksum', phase: 'recheck', loaded: true },
    { change: 'head', phase: 'recheck', loaded: true },
    { change: 'origin', phase: 'recheck', loaded: true },
    { change: 'config', phase: 'recheck', loaded: true },
    { change: 'directory', phase: 'recheck', loaded: true },
    { change: 'loaded-source', phase: 'content', loaded: true },
    { change: 'loaded-version', phase: 'content', loaded: true },
    { change: 'loaded-archive', phase: 'content', loaded: true },
    { change: 'loaded-url', phase: 'content', loaded: true },
    { change: 'competing-layout', phase: 'recheck', loaded: true }
  ])(
    'refuses $change at the exact $phase boundary', async ({ change, phase, loaded }) => {
      const world = await rubyFixture(), result = await world.run({ change });
      expect(result, result.stderr).toMatchObject({ status: 1, stdout: '', processTreeSettled: true });
      expect(result.stderr).toBe(`liftoff-cask-content:${phase}\n`);
      expect(() => readCaskContentObservation(world.request, result)).toThrowError();
      if (!loaded) {
        await expect(readFile(path.join(world.root, 'fixture-loaded'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else expect(await readFile(path.join(world.root, 'fixture-loaded'), 'utf8')).toBe('loaded');
    }
  );

  it('cancels a real inert Ruby child after content processing begins and requires tree settlement', async () => {
    const world = await rubyFixture(), controller = new AbortController();
    const pending = world.run({ change: 'pause', signal: controller.signal });
    try {
      await vi.waitFor(async () => {
        expect(await readFile(path.join(world.root, 'fixture-loaded'), 'utf8')).toBe('loaded');
      }, { timeout: 2000, interval: 20 });
    } finally { controller.abort(); }
    const result = await pending;
    expect(result).toMatchObject({ aborted: true, processSpawned: true, processTreeSettled: true, stdout: '' });
    expect(() => readCaskContentObservation(world.request, result)).toThrowError(
      expect.objectContaining({ reasonCode: 'native_timeout' }));
  });

  it('bounds an inert child deadline during content processing rather than waiting for completion', async () => {
    const world = await rubyFixture();
    const result = await world.run({ change: 'pause', timeoutMs: 1500 });
    expect(await readFile(path.join(world.root, 'fixture-loaded'), 'utf8')).toBe('loaded');
    expect(result).toMatchObject({ timedOut: true, processSpawned: true, processTreeSettled: true, stdout: '' });
    expect(() => readCaskContentObservation(world.request, result)).toThrowError(
      expect.objectContaining({ reasonCode: 'native_timeout' }));
  });

  it.each(['changed', 'symlink', 'hardlink', 'ambiguous', 'directory symlink', 'unsafe alternate parent'])(
    'refuses %s local source before loading Ruby', async kind => {
      const world = await rubyFixture(), source = world.local(world.input.source.path);
      if (kind === 'changed') await writeFile(source, 'raise "unverified local bytes must never run"\n');
      if (kind === 'symlink') {
        await rm(source);
        await writeFile(path.join(world.root, 'other.rb'), Buffer.from(JSON.parse(world.request.stdin).definition, 'base64'));
        await symlink(path.join(world.root, 'other.rb'), source);
      }
      if (kind === 'hardlink') await link(source, path.join(world.root, 'other.rb'));
      if (kind === 'ambiguous') await writeFile(world.local(`${tapRoot}/Casks/l/liftoff.rb`), await readFile(source));
      if (kind === 'directory symlink') {
        await rm(world.local(`${tapRoot}/Casks`), { recursive: true });
        await mkdir(path.join(world.root, 'other'));
        await writeFile(path.join(world.root, 'other/liftoff.rb'), Buffer.from(JSON.parse(world.request.stdin).definition, 'base64'));
        await symlink(path.join(world.root, 'other'), world.local(`${tapRoot}/Casks`));
      }
      if (kind === 'unsafe alternate parent') {
        await rm(world.local(`${tapRoot}/Casks/l`), { recursive: true });
        await symlink(path.join(world.root, 'home'), world.local(`${tapRoot}/Casks/l`));
      }
      const result = await world.run();
      expect(result, result.stderr).toMatchObject({ status: 1, stdout: '' });
      expect(result.stderr).toBe('liftoff-cask-content:host\n');
      await expect(readFile(path.join(world.root, 'fixture-loaded'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it.each(['stdin', 'pin', 'extra input', 'oversized input', 'environment', 'ruby options', 'trust context'])(
    'refuses changed %s controls before content consumption', async kind => {
      const world = await rubyFixture();
      let options: Parameters<typeof world.run>[0] = {};
      if (kind === 'stdin') options = { stdin: `${world.request.stdin} ` };
      if (kind === 'pin') options = { pin: '0'.repeat(64) };
      if (kind === 'extra input') {
        const stdin = JSON.stringify({ ...JSON.parse(world.request.stdin), installed: true });
        options = { stdin, pin: hash(stdin) };
      }
      if (kind === 'oversized input') options = { stdin: ' '.repeat(512 * 1024 + 1) };
      if (kind === 'environment') options = { env: { HOMEBREW_DEVELOPER: '' } };
      if (kind === 'ruby options') options = { env: { RUBYLIB: 'foreign' } };
      if (kind === 'trust context') options = { env: { HOMEBREW_FORBIDDEN_CASKS: '' } };
      const result = await world.run(options);
      expect(result, result.stderr).toMatchObject({ status: 1, stdout: '' });
      expect(result.stderr).toMatch(/^liftoff-cask-content:(?:input|trust)\n$/);
      await expect(readFile(path.join(world.root, 'fixture-loaded'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});
