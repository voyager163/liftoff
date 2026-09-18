import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  OwnedPrivateStateProcessRunner, spawnOwnedStateProcess, stopOwnedStateProcess
} from '../../src/adapters/state/owned-process.js';
import {
  consumeLinuxKeyClientOutput, type LinuxKeyClientOutcome
} from '../../src/adapters/state/linux-keystore-client-protocol.js';

const directory = path.resolve('native', 'linux-keystore-client');
const collection = '/org/freedesktop/secrets/collection/login';
const project = 'synthetic/source-project@local';
const workspace = '11111111-2222-4333-8444-555555555555';
const enrollment = '22222222-3333-4444-8555-666666666666';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: string) => [...Buffer.from(value)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
function must(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`synthetic-keystore:${code}`);
}

interface Identity {
  platform: string;
  architecture: string;
  libsecretCommit: string;
  binarySha256: string;
  sources: Record<string, string>;
  contractProbeLibraryPath: string;
  dependencies: Record<string, { library: string; sha256: string }>;
}

const primaryNames: Record<string, string> = {
  'libsecret-1': 'libsecret-1.so.0', 'gio-2.0': 'libgio-2.0.so.0',
  'glib-2.0': 'libglib-2.0.so.0', 'gobject-2.0': 'libgobject-2.0.so.0'
};
const binary = path.join(directory, 'build', 'liftoff-linux-keystore-client');
let identity: Identity;
let source: string;
let prerequisites: { python: string; busDaemon: string; upstreamMocks: Record<string, string> };
const cleanups: Array<() => Promise<void>> = [];
const basicEnvironment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' };
const runtimeEnvironment = () => ({
  ...basicEnvironment, LD_LIBRARY_PATH: identity.contractProbeLibraryPath
});

async function verifyBuild(): Promise<void> {
  must(hash(await readFile(binary)) === identity.binarySha256, 'binary-identity');
  for (const [name, digest] of Object.entries(identity.sources))
    must(!path.isAbsolute(name) && !name.includes('..') && hash(await readFile(path.join(directory, name))) === digest, 'source-identity');
  for (const dependency of Object.values(identity.dependencies))
    must(await realpath(dependency.library) === dependency.library &&
      hash(await readFile(dependency.library)) === dependency.sha256, 'library-identity');
}

async function verifyLoaded(text: string, mode: 'trace' | 'initialization'): Promise<void> {
  must(!text.includes('not found'), 'loader-missing');
  for (const [module, soname] of Object.entries(primaryNames)) {
    const observed: string[] = [];
    for (const line of text.split('\n')) {
      if (mode === 'trace') {
        const match = /^\s*(\S+)\s+=>\s+(\/\S+)\s+\(0x[a-f0-9]+\)\s*$/u.exec(line);
        if (match?.[1] === soname) observed.push(match[2]!);
      } else {
        const match = /^\s*[0-9]+:\s+calling init:\s+(\/\S+)\s*$/u.exec(line);
        if (match && path.basename(match[1]!).startsWith(soname)) observed.push(match[1]!);
      }
    }
    must(observed.length === 1, 'loader-observation');
    const selected = await realpath(observed[0]!);
    must(selected === identity.dependencies[module]?.library &&
      hash(await readFile(selected)) === identity.dependencies[module]?.sha256, 'loader-substitution');
  }
}

function readyProcess(
  request: Parameters<typeof spawnOwnedStateProcess>[0], children: ChildProcessWithoutNullStreams[]
): Promise<{ child: ChildProcessWithoutNullStreams; line: string }> {
  const child = spawnOwnedStateProcess(request);
  children.push(child);
  child.stdin.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), settled = false;
    const timer = setTimeout(() => finish('startup-deadline'), 5000);
    const finish = (code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code) { bytes.fill(0); reject(new Error(`synthetic-keystore:${code}`)); }
      else {
        const line = bytes.toString('utf8').trim();
        bytes.fill(0);
        resolve({ child, line });
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) { chunk.fill(0); return; }
      if (bytes.length + chunk.length > 4096) { chunk.fill(0); finish('startup-output-limit'); return; }
      const next = Buffer.concat([bytes, chunk]);
      bytes.fill(0); chunk.fill(0); bytes = next;
      if (bytes.includes(10)) finish();
    });
    child.stderr.on('data', (chunk: Buffer) => chunk.fill(0));
    child.once('error', () => finish('startup-failed'));
    child.once('close', () => finish('startup-closed'));
  });
}

interface Audit {
  sessions: string[];
  creates: number;
  reads: number;
  searches: number;
  prompts: number;
  unexpected: number;
  replaceRequested: boolean;
  attributesExact: boolean;
  createdLength: number;
}

async function fixture(mode: 'create' | 'read', fault = 'none') {
  const root = path.join(await realpath(process.cwd()), '.cache', `kc-${randomUUID().slice(0, 8)}`);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  must(await realpath(path.dirname(root)) === path.dirname(root), 'scratch-parent-alias');
  await mkdir(root, { mode: 0o700 });
  const children: ChildProcessWithoutNullStreams[] = [];
  const runner = new OwnedPrivateStateProcessRunner();
  cleanups.push(async () => {
    // Failed settlement preserves the exact root, not a guessed cleanup success.
    const settled = await Promise.allSettled([
      runner.quiesce(),
      ...[...children].reverse().map((child) => stopOwnedStateProcess(child, { immediate: false }))
    ]);
    must(settled.every((result) => result.status === 'fulfilled'), 'cleanup-settlement-unproven');
    await rm(root, { recursive: true, force: true });
  });
  const socket = path.join(root, "private bus'[1].sock");
  must(Buffer.byteLength(socket) <= 107, 'socket-path-limit');
  const address = `unix:path=${encoded(socket)}`;
  const configuration = path.join(root, 'bus.conf');
  await writeFile(configuration, `<busconfig>
<type>session</type><listen>${address}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow user="${process.getuid!()}"/><allow own="org.freedesktop.secrets"/>
<allow send_destination="*"/><allow receive_sender="*"/></policy>
<limit name="max_message_size">65536</limit>
</busconfig>\n`, { mode: 0o600 });
  const environment = { ...basicEnvironment, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root };
  const bus = await readyProcess({
    executable: prerequisites.busDaemon, args: ['--nofork', '--nopidfile', `--config-file=${configuration}`, '--print-address=1'],
    cwd: root, environment
  }, children);
  const guid = /(?:^|,)guid=([a-f0-9]{32})$/u.exec(bus.line)?.[1];
  must(guid, 'private-bus-guid');
  const started = await readyProcess({
    executable: prerequisites.python,
    args: ['-I', '-B', path.join(directory, 'synthetic-service.py'), '--source', source,
      '--address', `${address},guid=${guid}`, '--mode', mode, '--fault', fault,
      '--project', project, '--workspace', workspace, '--enrollment', enrollment],
    cwd: root, environment
  }, children);
  const ready = JSON.parse(started.line) as { pid: number; uid: number; sid: number; start: string; owner: string; kind: string };
  must(ready.kind === 'synthetic-source-fixture' && ready.pid === started.child.pid &&
    ready.uid === process.getuid!() && ready.sid === ready.pid && /^:[0-9]+\.[0-9]+$/u.test(ready.owner), 'fixture-identity');
  const proc = await readFile(`/proc/${ready.pid}/stat`, 'utf8');
  const fields = proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/u);
  must(fields[19] === ready.start && Number(fields[3]) === ready.sid, 'fixture-process-correlation');

  return {
    async audit(): Promise<Audit> {
      const bytes = await readFile(path.join(root, 'audit.json'));
      must(bytes.length < 4096, 'audit-limit');
      return JSON.parse(bytes.toString()) as Audit;
    },
    async invoke(operation: 'create' | 'read' = mode, item = `${collection}/1`,
      binding: 'correct' | 'owner' | 'pid' | 'guid' = 'correct'): Promise<LinuxKeyClientOutcome> {
      await verifyBuild();
      const result = await runner.run({
        executable: binary,
        args: [
          operation, address, binding === 'guid' ? `${guid![0] === 'a' ? 'b' : 'a'}${guid!.slice(1)}` : guid!,
          binding === 'owner' ? ':999999.999999' : ready.owner,
          String(ready.uid), String(binding === 'pid' ? bus.child.pid : ready.pid), String(ready.sid), ready.start,
          collection, operation === 'create' ? '-' : item, project, workspace, enrollment, '5000'
        ],
        cwd: root, environment: { ...environment, ...runtimeEnvironment(), LD_DEBUG: 'libs' },
        timeoutMs: 8000, maximumBytes: 131072
      });
      try {
        // Dynamic-loader initialization observations come from this actual client run.
        await verifyLoaded(Buffer.from(result.stderr).toString('utf8'), 'initialization');
        await verifyBuild();
        return consumeLinuxKeyClientOutput(result.stdout,
          operation === 'create' ? { operation } : { operation, item },
          { exitCode: result.exitCode, processTreeSettled: true });
      } finally { result.stdout.fill(0); result.stderr.fill(0); }
    }
  };
}

describe('opt-in compiled client against private synthetic Secret Service, not native custody', () => {
  beforeAll(async () => {
    must(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch), 'native-linux-required');
    must(process.env.LIFTOFF_LINUX_KEYSTORE_SYNTHETIC === '1', 'explicit-opt-in-required');
    must(process.env.LIBSECRET_SOURCE_DIR, 'pinned-source-required');
    source = await realpath(process.env.LIBSECRET_SOURCE_DIR);
    prerequisites = JSON.parse(await readFile(path.join(directory, 'synthetic-dependencies.json'), 'utf8'));
    identity = JSON.parse(await readFile(path.join(directory, 'build', 'build-identity.json'), 'utf8'));
    must(identity.platform === 'linux' && identity.architecture === process.arch &&
      identity.libsecretCommit === 'a5cd57f103038c06b64d5f6ebfd0e627bb40af4e', 'build-identity');
    must(Object.keys(identity.dependencies).sort().join(',') === Object.keys(primaryNames).sort().join(','), 'dependency-set');
    const directories = [...new Set(Object.values(identity.dependencies).map((entry) => path.dirname(entry.library)))];
    must(directories.every((entry) => /^\/[A-Za-z0-9_./-]+$/u.test(entry)) &&
      directories.join(':') === identity.contractProbeLibraryPath, 'runtime-library-path');
    await verifyBuild();
    for (const [filename, digest] of Object.entries(prerequisites.upstreamMocks))
      must(hash(await readFile(path.join(source, filename))) === digest, 'upstream-mock-identity');
    const runner = new OwnedPrivateStateProcessRunner();
    try {
      const trace = await runner.run({
        executable: binary, args: ['--contract'], cwd: directory,
        environment: { ...runtimeEnvironment(), LD_TRACE_LOADED_OBJECTS: '1' }, timeoutMs: 5000, maximumBytes: 65536
      });
      try {
        must(trace.exitCode === 0, 'loader-trace-failed');
        await verifyLoaded(Buffer.from(trace.stdout).toString('utf8'), 'trace');
      } finally { trace.stdout.fill(0); trace.stderr.fill(0); }
      const contract = await runner.run({
        executable: binary, args: ['--contract'], cwd: directory,
        environment: { ...runtimeEnvironment(), LD_DEBUG: 'libs' }, timeoutMs: 5000, maximumBytes: 131072
      });
      try {
        await verifyLoaded(Buffer.from(contract.stderr).toString('utf8'), 'initialization');
        const bytes = Buffer.from(contract.stdout);
        must(contract.exitCode === 0 && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'LKC1', 'contract-header');
        const length = bytes.readUInt32BE(4);
        must(length > 0 && length <= 2048 && bytes.readUInt32BE(8) === 0 && bytes.length === length + 12, 'contract-bounds');
        const value = JSON.parse(bytes.subarray(12).toString());
        bytes.fill(0);
        must(value.libsecretCommit === identity.libsecretCommit && value.authorization === false &&
          value.readiness === false && value.qualification === 'required', 'contract-claims');
      } finally { contract.stdout.fill(0); contract.stderr.fill(0); }
    } finally { await runner.quiesce(); }
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('accepts an encrypted session, creates without replacement, then reads the exact returned item', async () => {
    const f = await fixture('create');
    const created = await f.invoke();
    try {
      expect(created.status).toBe('completed');
      expect(created.creation).toBe('returned-identity');
      expect(created.readiness).toBe(false);
      expect(created.observedItemPaths.length).toBe(1);
      expect(Boolean(created.key)).toBe(true);
      await created.key!.consume((bytes) => expect(bytes.byteLength).toBe(32));
      const read = await f.invoke('read', created.observedItemPaths[0]!);
      try {
        expect(read.status).toBe('completed');
        await read.key!.consume((bytes) => expect(bytes.byteLength).toBe(32));
      } finally { read.key?.release(); }
      expect(await f.audit()).toMatchObject({
        creates: 1, createdLength: 32, replaceRequested: false, attributesExact: true,
        prompts: 0, unexpected: 0, sessions: ['encrypted', 'encrypted']
      });
    } finally { created.key?.release(); }
  });

  it('rejects a plain-only session before any key operation', async () => {
    const f = await fixture('create', 'plain');
    const result = await f.invoke();
    try {
      expect(result.status).toBe('failed');
      expect(result.issue).toBe('encrypted-session-required');
      expect(result.creation).toBe('no-dispatch');
      expect(Boolean(result.key)).toBe(false);
      expect(await f.audit()).toMatchObject({ sessions: ['encrypted', 'plain'], creates: 0, reads: 0, unexpected: 0 });
    } finally { result.key?.release(); }
  });

  it('refuses a creation prompt without calling Prompt or Unlock and retains mutation uncertainty', async () => {
    const f = await fixture('create', 'prompt');
    const result = await f.invoke();
    try {
      expect(result.status).toBe('failed');
      expect(result.creation).toBe('possible-mutation');
      expect(Boolean(result.key)).toBe(false);
      expect(await f.audit()).toMatchObject({ creates: 1, prompts: 0, reads: 0, unexpected: 0 });
    } finally { result.key?.release(); }
  });

  it.each(['owner', 'pid', 'guid'] as const)('rejects changed %s binding without key operations', async (binding) => {
    const f = await fixture('read');
    const result = await f.invoke('read', `${collection}/1`, binding);
    try {
      expect(result.status).toBe('failed');
      expect(result.creation).toBe('no-dispatch');
      expect(Boolean(result.key)).toBe(false);
      expect(await f.audit()).toMatchObject({ sessions: [], creates: 0, reads: 0 });
    } finally { result.key?.release(); }
  });

  it.each(['short-key', 'duplicate-search', 'duplicate-secrets', 'wrong-secret-path', 'changed-item'])(
    'rejects synthetic %s evidence without returning key material', async (fault) => {
      const f = await fixture('read', fault);
      const result = await f.invoke();
      try {
        expect(result.status).toBe('failed');
        expect(result.issue).toBe('item-mismatch');
        expect(Boolean(result.key)).toBe(false);
        expect((await f.audit()).creates).toBe(0);
      } finally { result.key?.release(); }
    }
  );

  it('requires the exact selected existing path before performing a private read', async () => {
    const f = await fixture('read');
    const result = await f.invoke('read', `${collection}/missing`);
    try {
      expect(result.status).toBe('failed');
      expect(result.issue).toBe('item-mismatch');
      expect(Boolean(result.key)).toBe(false);
      expect(await f.audit()).toMatchObject({ reads: 0, creates: 0, unexpected: 0 });
    } finally { result.key?.release(); }
  });

  it('retains an actual created identity when post-write attribute verification fails', async () => {
    const f = await fixture('create', 'post-write');
    const result = await f.invoke();
    try {
      expect(result.status).toBe('failed');
      expect(result.issue).toBe('item-mismatch');
      expect(result.creation).toBe('returned-identity');
      expect(result.observedItemPaths.length).toBe(1);
      expect(Boolean(result.key)).toBe(false);
      expect(await f.audit()).toMatchObject({ creates: 1, createdLength: 32, replaceRequested: false, unexpected: 0 });
    } finally { result.key?.release(); }
  });
});
