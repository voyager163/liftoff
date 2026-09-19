import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuildFailure, buildCommandLimits, runBuildCommand } from '../native/linux-keystore-client/build-tools.mjs';
import {
  consumeLinuxKeyClientOutput, PrivateLinuxKeySnapshot
} from '../src/adapters/state/linux-keystore-client-protocol.js';

const root = path.resolve('native', 'linux-keystore-client');
const client = await readFile(path.join(root, 'client.c'), 'utf8');
const protocol = await readFile(path.join(root, 'protocol.c'), 'utf8');
const header = await readFile(path.join(root, 'protocol.h'), 'utf8');
const build = await readFile(path.join(root, 'build.mjs'), 'utf8');
const parser = await readFile(path.join(root, 'parser.c'), 'utf8');
const dependencies = JSON.parse(await readFile(path.join(root, 'dependencies.json'), 'utf8'));
const syntheticService = await readFile(path.join(root, 'synthetic-service.py'), 'utf8');
const syntheticTests = await readFile(path.join(root, 'synthetic-behavior-tests.ts'), 'utf8');
const syntheticDependencies = JSON.parse(await readFile(path.join(root, 'synthetic-dependencies.json'), 'utf8'));

if (process.env.LIFTOFF_LINUX_KEYSTORE_SYNTHETIC === '1') {
  await import('../native/linux-keystore-client/synthetic-behavior-tests.js');
}

describe('Linux keystore client source/API contract, not native qualification', () => {
  it('keeps synthetic behavior opt-in and reuses hash-bound upstream mocks rather than production crypto', () => {
    expect(dependencies.syntheticBehaviorTests.optIn).toBe('LIFTOFF_LINUX_KEYSTORE_SYNTHETIC=1');
    expect(syntheticDependencies.libsecretCommit).toBe(dependencies.libsecret.commit);
    expect(Object.keys(syntheticDependencies.upstreamMocks)).toEqual([
      'libsecret/mock/__init__.py', 'libsecret/mock/service.py', 'libsecret/mock/aes.py',
      'libsecret/mock/dh.py', 'libsecret/mock/hkdf.py'
    ]);
    expect(syntheticService).toContain('hashlib.sha256(selected.read_bytes()).hexdigest() != digest');
    expect(syntheticService).toContain('bus = dbus.bus.BusConnection(args.address)');
    expect(syntheticService).not.toContain('dbus.SessionBus(');
    expect(syntheticService).not.toMatch(/subprocess|os\.system|eval\(|exec\(/u);
    expect(syntheticService).toContain('sys.pycache_prefix = str(cache)');
    expect(syntheticTests).toContain('LD_TRACE_LOADED_OBJECTS');
    expect(syntheticTests).toContain("LD_DEBUG: 'libs'");
    expect(syntheticTests).toContain("verifyLoaded(Buffer.from(result.stderr).toString('utf8'), 'initialization')");
  });

  it('pins the audited source rather than substituting a tag or system libsecret', () => {
    expect(dependencies.libsecret.commit).toBe('a5cd57f103038c06b64d5f6ebfd0e627bb40af4e');
    expect(dependencies.libsecret.tagEquivalent).toBeNull();
    expect(dependencies.providerWireProfile).toMatchObject({
      sourceCommit: 'da00f9621eaf263d5ed4236df9c22798ea8021d2',
      requestContentType: 'application/octet-stream', responseContentType: 'text/plain',
      otherProviderProfiles: 'not-admitted'
    });
    expect(header).toContain(dependencies.libsecret.commit);
    expect(dependencies.qualification).toBe('source-only-unqualified');
    expect(build).toContain("'libsecret-system-fallback-forbidden'");
    expect(build).toContain("'libsecret-source-identity-mismatch'");
    expect(build).toContain("'compile-only-not-provider-or-runtime-admission'");
    for (const symbol of dependencies.requiredSymbols) expect(client).toContain(`${symbol}(`);
  });

  it('selects a private address/unique owner and rejects all prompt paths without ordinary bus discovery', () => {
    expect(client).toContain('g_dbus_connection_new_for_address_sync(r->bus.bound');
    expect(client).toContain('G_BUS_TYPE_NONE');
    expect(client).toContain('"g-connection", selected_connection');
    expect(client).toContain('"g-name", selected_owner');
    expect(client).toContain('G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START');
    expect(client).toContain('G_DBUS_CALL_FLAGS_NO_AUTO_START');
    expect(client).toContain('prompt_sync = reject_prompt_sync');
    expect(client).toContain('prompt_async = reject_prompt_async');
    expect(client).toContain('prompt_finish = reject_prompt_finish');
    expect(client).toContain('g_dbus_is_unique_name(r->owner)');
    expect(client).toContain('g_dbus_connection_get_guid(bus)');
    expect(client).not.toContain('"GetId"');
    expect(client).toContain('"GetConnectionCredentials"');
    expect(client).toContain('getsid((pid_t)r->pid)');
    expect(client).toContain('"/proc/%u/stat"');
    expect(client).not.toMatch(/\bg_bus_get|\bsecret_service_get_sync|\bsecret_prompt_perform/);
  });

  it('uses decoded canonical socket paths and the complete selected GUID-bound address', () => {
    expect(client).toContain('lk_parse_bus_address(r->address, r->guid, &r->bus)');
    expect(client).toContain('const char *name = r->bus.path');
    expect(client).toContain('strcmp(name, resolved)');
    expect(client).toContain('setenv("DBUS_SESSION_BUS_ADDRESS", request.bus.bound, 1)');
    expect(client).not.toContain('char address[192]');
    expect(client).toContain('lk_project_identifier(r->project)');
    expect(parser).toContain('written == LK_MAX_SOCKET_BYTES');
    expect(dependencies.sources).toEqual(expect.arrayContaining(['parser.c', 'parser.h']));
  });

  it('requires exact encrypted session and non-replacing collection-scoped key operations', () => {
    expect(header).toContain('dh-ietf1024-sha256-aes128-cbc-pkcs7');
    expect(client).toContain('g_strcmp0(secret_service_get_session_algorithms(service), LK_ALGORITHM)');
    expect(client.indexOf('!secret_service_ensure_session_sync')).toBeLessThan(client.indexOf('if (!random_key(key))'));
    expect(client).toContain('SECRET_ITEM_CREATE_NONE');
    expect(client).toContain('secret_collection_search_for_dbus_paths_sync(collection, NULL, attributes');
    expect(client).toContain('secret_service_get_secrets_for_dbus_paths_sync(service, paths');
    expect(client).toContain('g_hash_table_size(secrets) != 1');
    expect(client).toContain('lk_gnome_secret_shape(secret_value_get_content_type(value), length)');
    expect(client).toContain('const char *bytes = secret_value_get(value, &length)');
    expect(client).not.toContain('secret_value_get_text');
    expect(client).toContain('secret_value_new_full((gchar *)key, LK_KEY_BYTES, "application/octet-stream", key_free)');
    expect(client).toContain('getrandom(key + have, LK_KEY_BYTES - have, GRND_NONBLOCK)');
    expect(client).toContain('g_variant_n_children(attributes) != 4');
    expect(client).toContain('paths[0] && !paths[1] && !strcmp(paths[0], expected)');
    expect(client).not.toMatch(/\bsecret_service_(store|lookup|unlock|clear|read_alias|delete|create_collection)/);
    expect(client).not.toContain('SECRET_ITEM_CREATE_REPLACE');
    expect(client).not.toMatch(/\bsecret_service_search|\bsecret_item_set_secret/);
  });

  it('retains actual returned identity and possible mutations independently of final validation', () => {
    const pre = client.indexOf('lk_frame("before-create"');
    const effect = client.indexOf('effect = LK_POSSIBLE_MUTATION;', pre);
    const dispatch = client.indexOf('secret_service_create_item_dbus_path_sync');
    const returned = client.indexOf('effect = LK_RETURNED_IDENTITY;');
    expect(pre).toBeLessThan(effect);
    expect(effect).toBeLessThan(dispatch);
    expect(dispatch).toBeLessThan(returned);
    expect(returned).toBeLessThan(client.indexOf('lk_frame("created-identity"'));
    expect(client.indexOf('lk_frame("created-identity"')).toBeLessThan(client.indexOf('if (!item_path(item))'));
    expect(client).toContain('lk_frame("result", effect, code, effect == LK_RETURNED_IDENTITY || code == LK_OK ? item : NULL');
    expect(client.slice(effect)).not.toContain('effect = LK_NO_DISPATCH');
  });

  it('bounds metadata, clears owned buffers, suppresses diagnostics and leaves readiness to the parent', () => {
    expect(client).toContain('mlock(key, (size_t)page)');
    expect(client).toContain('MADV_DONTDUMP');
    expect(client).toContain('PR_SET_DUMPABLE');
    expect(client).toContain('lk_clear(value, page)');
    expect(client).toContain('g_variant_get_size(body) > 65536');
    expect(client).toContain('total > 4096');
    expect(client).toContain('g_cancellable_cancel(cancellable)');
    expect(client).toContain('S_ISFIFO(output.st_mode) || S_ISSOCK(output.st_mode)');
    expect(client).not.toMatch(/error->message|g_printerr|fprintf\s*\(\s*stderr|fread\s*\([^;]*stdin|STDIN_FILENO/);
    expect(protocol).toContain('\\"authorization\\":false');
    expect(protocol).toContain('\\"readiness\\":false');
  });
});

const compiler = process.env.CC ?? 'cc';
const available = spawnSync(compiler, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
describe.runIf(available)('dependency-free native C framing, no libsecret or daemon', () => {
  const scratch = path.resolve('tests', `.keystore-protocol-${randomUUID()}`);
  const binary = path.join(scratch, process.platform === 'win32' ? 'protocol-test.exe' : 'protocol-test');
  beforeAll(async () => {
    await mkdir(scratch, { mode: 0o700 });
    execFileSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror',
      path.join(root, 'protocol.c'), path.join(root, 'parser.c'), path.join(root, 'protocol-test.c'), '-o', binary],
    { stdio: 'pipe', timeout: 10_000, maxBuffer: 65_536 });
  });
  afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

  function nativeOutput(mode: string): Buffer {
    return execFileSync(binary, [mode], { timeout: 5000, maxBuffer: 8192 });
  }

  function frames(mode: string) {
    const bytes = nativeOutput(mode);
    const values: Array<{ metadata: Record<string, unknown>; key: Buffer }> = [];
    let offset = 0;
    while (offset < bytes.length) {
      expect(bytes.length - offset).toBeGreaterThanOrEqual(12);
      expect(bytes.subarray(offset, offset + 4).toString()).toBe('LKC1');
      const metadataBytes = bytes.readUInt32BE(offset + 4), keyBytes = bytes.readUInt32BE(offset + 8);
      expect(metadataBytes).toBeGreaterThan(0); expect(metadataBytes).toBeLessThanOrEqual(2048);
      expect([0, 32]).toContain(keyBytes);
      const end = offset + 12 + metadataBytes + keyBytes;
      expect(end).toBeLessThanOrEqual(bytes.length);
      values.push({
        metadata: JSON.parse(bytes.subarray(offset + 12, offset + 12 + metadataBytes).toString()),
        key: Buffer.from(bytes.subarray(end - keyBytes, end))
      });
      offset = end;
    }
    bytes.fill(0);
    return values;
  }

  it('emits a source-safe bounded contract without secret bytes', () => {
    expect(frames('contract')).toMatchObject([{
      metadata: {
        protocol: 'liftoff-linux-keystore-client/1', authorization: false, readiness: false, qualification: 'required',
        daemonSourceCommit: 'da00f9621eaf263d5ed4236df9c22798ea8021d2'
      },
      key: Buffer.alloc(0)
    }]);
  });
  it('frames pre-dispatch uncertainty, returned identity and binary key bytes separately', () => {
    const result = frames('create');
    expect(result.map((frame) => frame.metadata.effect)).toEqual(['possible-mutation', 'returned-identity', 'returned-identity']);
    expect(result.map((frame) => frame.metadata.event)).toEqual(['before-create', 'created-identity', 'result']);
    expect(result.map((frame) => frame.key.length)).toEqual([0, 0, 32]);
    expect(result[2]!.key).toEqual(Buffer.alloc(32, 0xa5));
    for (const frame of result) frame.key.fill(0);
  });
  it('does not label a failed or post-write call untouched or emit key material on error', () => {
    expect(frames('uncertain')).toMatchObject([{ metadata: { effect: 'possible-mutation', code: 'provider-failure', item: null }, key: Buffer.alloc(0) }]);
    expect(frames('post-write')).toMatchObject([{ metadata: { effect: 'returned-identity', code: 'identity-changed', item: '/org/freedesktop/secrets/collection/login/42' }, key: Buffer.alloc(0) }]);
  });
  it('rejects invalid enum values, diagnostics, unsafe/oversized paths and secret-bearing errors', () => {
    expect(frames('reject')).toEqual([]);
  });

  it('interoperates with the production decoder and opaque one-use snapshot for C creation output', async () => {
    const bytes = nativeOutput('create');
    const result = consumeLinuxKeyClientOutput(bytes, { operation: 'create' }, { exitCode: 0, processTreeSettled: true });
    try {
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(result).toMatchObject({
        status: 'completed', creation: 'returned-identity', issue: null,
        observedItemPaths: ['/org/freedesktop/secrets/collection/login/42'], readiness: false
      });
      expect(result.key).toBeInstanceOf(PrivateLinuxKeySnapshot);
      let consumed: Uint8Array | undefined;
      await result.key!.consume((key) => {
        consumed = key;
        expect(key).toHaveLength(32);
        expect([...key].every((byte) => byte === 0xa5)).toBe(true);
      });
      expect(consumed!.every((byte) => byte === 0)).toBe(true);
      await expect(result.key!.consume(() => undefined)).rejects.toMatchObject({ code: 'key-unavailable' });
    } finally { bytes.fill(0); result.key?.release(); }
  });

  it.each([
    { mode: 'uncertain', prefixFrames: 1, creation: 'possible-mutation', issue: 'provider-failure', items: [] },
    { mode: 'post-write', prefixFrames: 2, creation: 'returned-identity', issue: 'identity-changed',
      items: ['/org/freedesktop/secrets/collection/login/42'] }
  ])('interoperates with the production decoder for C $mode failure stages', ({ mode, prefixFrames, creation, issue, items }) => {
    const creationOutput = nativeOutput('create'), terminal = nativeOutput(mode);
    let joined: Buffer | undefined;
    try {
      let end = 0;
      for (let index = 0; index < prefixFrames; index++) {
        expect(creationOutput.readUInt32BE(end + 8)).toBe(0);
        end += 12 + creationOutput.readUInt32BE(end + 4);
      }
      // Both prefix and terminal are exact C-emitted bytes; the framing harness
      // itself exits zero, while this represents the helper's settled error exit.
      joined = Buffer.concat([creationOutput.subarray(0, end), terminal]);
      const result = consumeLinuxKeyClientOutput(joined, { operation: 'create' }, { exitCode: 1, processTreeSettled: true });
      try {
        expect(result).toMatchObject({
          status: 'failed', creation, issue, observedItemPaths: items, key: null, readiness: false
        });
        expect(joined.every((byte) => byte === 0)).toBe(true);
      } finally { result.key?.release(); }
    } finally { creationOutput.fill(0); terminal.fill(0); joined?.fill(0); }
  });

  const encoded = (value: string) => 'unix:path=' + [...Buffer.from(value, 'utf8')].map((byte) =>
    `%${byte.toString(16).padStart(2, '0')}`).join('');
  const runParser = (...args: string[]) => execFileSync(binary, args, { timeout: 5000, maxBuffer: 8192 });

  it('requires the exact pinned GNOME reply label with exactly 32 opaque bytes', () => {
    expect(runParser('gnome-wire-accept', 'text/plain', '32')).toHaveLength(0);
    expect(runParser('gnome-wire-null')).toHaveLength(0);
  });

  it.each([
    ['application/octet-stream', '32'], ['TEXT/PLAIN', '32'],
    ['text/plain; charset=utf-8', '32'], ['', '32'],
    ['text/plain', '0'], ['text/plain', '31'], ['text/plain', '33']
  ])('rejects an unregistered reply label or length: %s / %s', (type, length) => {
    expect(runParser('gnome-wire-reject', type, length)).toHaveLength(0);
  });

  it('retains embedded NUL and non-UTF8 key bytes despite the GNOME MIME label', async () => {
    const output = nativeOutput('binary-gnome-read');
    const result = consumeLinuxKeyClientOutput(output, { operation: 'read', item: '/org/freedesktop/secrets/collection/login/42' },
      { exitCode: 0, processTreeSettled: true });
    try {
      expect(result.status).toBe('completed');
      expect(output.every((byte) => byte === 0)).toBe(true);
      await result.key!.consume((bytes) => {
        expect(bytes.length).toBe(32);
        expect(bytes[0] === 0 && bytes[1] === 0xff && bytes[2] === 0xc0).toBe(true);
      });
    } finally { result.key?.release(); output.fill(0); }
  });

  it.each([
    '/private/key store/"quoted"/[brackets]/bus',
    "/private/'single'/$(literal);comma,equals=/bus",
    '/private/café/東京/🔐/bus',
    '/private/literal%00%3bunix:path=elsewhere/bus',
    `/${'a'.repeat(106)}`,
    `/${'é'.repeat(53)}`
  ])('decodes canonical launch-contract percent encoding exactly: %s', (socket) => {
    expect(runParser('address', encoded(socket), socket)).toHaveLength(0);
    expect(runParser('bound-address', encoded(socket), `${encoded(socket)},guid=0123456789abcdef0123456789abcdef`)).toHaveLength(0);
  });

  it('accepts safe raw/mixed encoding and uppercase escapes without double-decoding', () => {
    expect(runParser('address', 'unix:path=/private/my%20store/%5Bbus%5D', '/private/my store/[bus]')).toHaveLength(0);
    expect(runParser('address', 'unix:path=/private/bus', '/private/bus')).toHaveLength(0);
    const longest = encoded(`/${'a'.repeat(106)}`);
    expect(longest.length).toBe(331);
    const bound = `${longest},guid=0123456789abcdef0123456789abcdef`;
    expect(bound.length).toBe(369);
    expect(runParser('bound-address', longest, bound)).toHaveLength(0);
  });

  it.each([
    '', 'unix:path=', 'unix:abstract=/private/bus', 'autolaunch:', 'tcp:host=localhost',
    'unix:path=/private/bus;unix:path=/other/bus',
    'unix:path=/private/bus,guid=0123456789abcdef0123456789abcdef',
    'unix:path=/private/bus,abstract=fallback', 'unix:path=/private/bus,path=/other',
    'unix:path=/private/%', 'unix:path=/private/%0', 'unix:path=/private/%gg',
    'unix:path=/private/%00', 'unix:path=/private/%0a', 'unix:path=/private/%1f',
    'unix:path=/private/%7f', 'unix:path=/private/%c2%85',
    'unix:path=/private/%c0%af', 'unix:path=/private/%c1%bf', 'unix:path=/private/%ed%a0%80',
    'unix:path=/private/%f4%90%80%80', 'unix:path=/private/%f5%80%80%80',
    'unix:path=/private/%80', 'unix:path=/private/%e2%82',
    'unix:path=relative/bus', 'unix:path=/', 'unix:path=/private//bus',
    'unix:path=/private/../bus', 'unix:path=/private/%2e/bus', 'unix:path=/private/bus/',
    encoded(`/${'a'.repeat(107)}`), `unix:path=/${'a'.repeat(107)}`, encoded(`/${'é'.repeat(54)}`)
  ])('rejects malformed, compound, noncanonical or oversized address: %s', (address) => {
    expect(runParser('reject-address', address)).toHaveLength(0);
  });

  it.each(['org.example:owner/project@host_v1-2', 'a', 'x'.repeat(256), '/team/project'])(
    'accepts the existing state-context project grammar: %s', (project) => {
      expect(runParser('project', project)).toHaveLength(0);
    }
  );
  it.each(['', 'x'.repeat(257), 'has space', 'quote"', '[bracket]', 'semi;colon', 'line\nbreak', 'é'])(
    'rejects identifiers outside the existing project grammar: %s', (project) => {
      expect(runParser('reject-project', project)).toHaveLength(0);
    }
  );

  it('surfaces actual compiler errors as bounded diagnostics rather than a generic failure', () => {
    try {
      runBuildCommand(compiler, ['-fsyntax-only', path.join(scratch, 'absent.c')], { label: 'compiler', diagnostics: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BuildFailure);
      expect(error).toMatchObject({ message: 'build-command-failed:compiler' });
      expect((error as BuildFailure).diagnostics).toContain('absent.c');
    }
  });
});

describe('bounded compile-only command execution', () => {
  it('reports exact missing tools without logging supplied command paths or environments', () => {
    const missing = path.join(root, `missing-${randomUUID()}`);
    expect(() => runBuildCommand(missing, [], {
      label: 'compiler', environment: { ENV_SENTINEL: 'NONSECRET_NOT_FOR_LOGGING' }, diagnostics: true
    })).toThrow('missing-build-dependency:compiler');
  });
  it('caps diagnostic text and never serializes the exec error object or environment', () => {
    try {
      runBuildCommand(process.execPath, ['-e', 'process.stderr.write("compile error\\n" + "x".repeat(20000)); process.exit(2)'], {
        label: 'compiler', diagnostics: true, environment: { ...process.env, ENV_SENTINEL: 'NONSECRET_NOT_FOR_LOGGING' }
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ message: 'build-command-failed:compiler' });
      const diagnostics = (error as BuildFailure).diagnostics;
      expect(diagnostics).toContain('compile error');
      expect(diagnostics).toContain('[compile diagnostics truncated]');
      expect(diagnostics.length).toBeLessThanOrEqual(buildCommandLimits.diagnosticBytes + 40);
      expect(diagnostics).not.toContain('NONSECRET_NOT_FOR_LOGGING');
    }
  });
  it('terminates a hung build command within its configured bound', () => {
    expect(() => runBuildCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      label: 'compiler', timeoutMs: 100
    })).toThrow('build-command-timeout:compiler');
  });
  it('rejects tool output exceeding the fixed capture limit', () => {
    expect(() => runBuildCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], {
      label: 'compiler'
    })).toThrow('build-command-output-limit:compiler');
  });
});
