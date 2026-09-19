// Test-only owned coordinator. Restart runs this entire process tree inside Landlock.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { consumeBusStartupDiagnostic, safeNativeErrno } from './gnome-bus-diagnostics.mjs';

const children = [];
let cancelled = false;
const expires = Date.now() + 12_000;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const live = () => check(!cancelled && Date.now() < expires, 'cancelled-or-expired');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encode = (text) => [...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  cancelled = true;
  for (const entry of children) if (!entry.closed) entry.child.kill('SIGTERM');
});

async function registered(executable) {
  live();
  check(path.isAbsolute(executable.path) && await realpath(executable.path) === executable.path, 'executable-path');
  const info = await lstat(executable.path);
  check(info.isFile() && !(info.mode & 0o022) && (info.mode & 0o111) &&
    digest(await readFile(executable.path)) === executable.sha256, 'executable-identity');
}

function launch(executable, args, environment, cwd, input) {
  live();
  const child = spawn(executable, args, { cwd, env: environment, shell: false,
    detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const entry = { child, closed: false, code: null, signal: null, spawnError: null,
    stdout: [], stderr: [], length: 0, overflow: false };
  entry.done = new Promise((resolve) => {
    child.once('error', (error) => { entry.code = -1; entry.spawnError = safeNativeErrno(error.code); });
    child.once('close', (code, signal) => { entry.closed = true; entry.code = code ?? -1; entry.signal = signal; resolve(); });
  });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', (bytes) => {
    entry.length += bytes.length;
    if (entry.length > 131072) {
      bytes.fill(0); entry.overflow = true; child.kill('SIGTERM');
    } else entry[stream].push(bytes);
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input, () => input?.fill(0));
  children.push(entry);
  return entry;
}

function collected(entry, stream) {
  check(!entry.overflow, 'native-output-limit');
  return Buffer.concat(entry[stream]);
}
async function waitFor(condition, ms = 5000) {
  const deadline = Math.min(expires, Date.now() + ms);
  while (!condition()) {
    live();
    check(Date.now() < deadline, 'native-deadline');
    await pause(20);
  }
}
async function stop(entry) {
  if (entry.closed) return;
  const closedWithin = async () => {
    let timer;
    try {
      return await Promise.race([entry.done.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 900); })]);
    } finally { clearTimeout(timer); }
  };
  if (!entry.closed) entry.child.kill('SIGTERM');
  if (await closedWithin()) return;
  entry.child.kill('SIGKILL');
  check(await closedWithin(), 'settlement-unproven');
}

async function loaded(entry, dependencies) {
  const bytes = collected(entry, 'stderr');
  try {
    const text = bytes.toString('utf8');
    for (const dependency of Object.values(dependencies)) {
      live();
      const matches = text.split('\n').flatMap((line) => {
        const match = /^\s*[0-9]+:\s+calling init:\s+(\/\S+)\s*$/u.exec(line);
        return match && path.basename(match[1]).startsWith(dependency.stem) ? [match[1]] : [];
      });
      check(matches.length === 1 && await realpath(matches[0]) === dependency.library &&
        digest(await readFile(dependency.library)) === dependency.sha256, 'runtime-library-mismatch');
    }
  } finally { bytes.fill(0); }
}

async function admitLoader(executable, args, environment, dependencies, cwd) {
  const entry = launch(executable, args, { ...environment, LD_TRACE_LOADED_OBJECTS: '1' }, cwd);
  await waitFor(() => entry.closed, 1000);
  check(entry.code === 0, 'loader-trace-failed');
  const bytes = collected(entry, 'stdout');
  try {
    const text = bytes.toString('utf8');
    check(!text.includes('not found'), 'loader-missing');
    for (const dependency of Object.values(dependencies)) {
      const matches = text.split('\n').flatMap((line) => {
        const match = /^\s*(\S+)\s+=>\s+(\/\S+)\s+\(0x[a-f0-9]+\)\s*$/u.exec(line);
        return match && match[1].startsWith(dependency.stem) ? [match[2]] : [];
      });
      check(matches.length === 1 && await realpath(matches[0]) === dependency.library &&
        digest(await readFile(dependency.library)) === dependency.sha256, 'loader-substitution');
    }
  } finally { bytes.fill(0); }
}

function isolatedEnvironment(config) {
  return {
    PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C',
    HOME: path.join(config.store, 'home'), USERPROFILE: path.join(config.store, 'home'),
    XDG_DATA_HOME: path.join(config.store, 'data'), XDG_CONFIG_HOME: path.join(config.store, 'config'),
    XDG_CACHE_HOME: config.scratch, XDG_RUNTIME_DIR: config.runtime,
    TMPDIR: config.scratch, TMP: config.scratch, TEMP: config.scratch,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${encode(path.join(config.runtime, 'no-system-bus'))}`,
    GNOME_KEYRING_PARANOID: '1'
  };
}

async function query(config, address, method, argument) {
  const child = launch(config.tools.observer.path, ['call', '--address', address,
    '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
    '--method', `org.freedesktop.DBus.${method}`, argument],
  { ...isolatedEnvironment(config), DBUS_SESSION_BUS_ADDRESS: address, LD_LIBRARY_PATH: config.gnome.libraryPath }, config.scratch);
  await waitFor(() => child.closed, 1000);
  const output = collected(child, 'stdout');
  try { return child.code === 0 ? output.toString('utf8').trim() : null; }
  finally { output.fill(0); }
}

async function password() {
  const parts = [];
  let length = 0;
  try {
    for await (const part of process.stdin) {
      length += part.length;
      if (length > 4096) { part.fill(0); check(false, 'password-channel-limit'); }
      parts.push(part);
    }
    const value = Buffer.concat(parts);
    if (value.length < 16 || !value.every((byte) => byte >= 33 && byte <= 126)) {
      value.fill(0); check(false, 'password-channel-shape');
    }
    return value;
  } finally { for (const part of parts) part.fill(0); }
}

async function storeMatches(config) {
  if (!config.expectedStore) return false;
  const filename = path.join(config.store, 'data', 'keyrings', 'login.keyring');
  const info = await lstat(filename, { bigint: true }).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return false;
  const bytes = await readFile(filename);
  try {
    return String(info.dev) === config.expectedStore.device && String(info.ino) === config.expectedStore.inode &&
      String(info.birthtimeNs) === config.expectedStore.birthtime && digest(bytes) === config.expectedStore.sha256 &&
      Number(info.uid) === process.getuid() && (info.mode & 0o077n) === 0n;
  } finally { bytes.fill(0); }
}

async function observeNullReadWrite() {
  // Same open mode required by D-Bus before it parses --nofork; no data is
  // read or written, and the descriptor is closed before any child starts.
  let fd;
  try { fd = await open('/dev/null', 'r+'); }
  catch (error) { return safeNativeErrno(error.code); }
  try { await fd.close(); }
  catch { check(false, 'null-device-probe-close'); }
  return 'allowed';
}

async function main() {
  const report = { kind: 'actual-gnome-generated-data-source-fixture', blocked: null,
    settled: false, clientExitCode: null, daemon: null, generationChecked: false, loaderVerified: false,
    busDiagnostic: null };
  let secret, frames = Buffer.alloc(0);
  let config;
  try {
    check(process.platform === 'linux' && process.argv.length === 3, 'linux-source-fixture-required');
    check(Buffer.byteLength(process.argv[2]) <= 32768, 'configuration-limit');
    config = JSON.parse(process.argv[2]);
    check(['enroll', 'restart'].includes(config.operation) &&
      ['none', 'missing-probe', 'hold', 'withhold-settlement'].includes(config.fault), 'fixture-operation');
    check(config.gnome.sourceCommit === 'da00f9621eaf263d5ed4236df9c22798ea8021d2', 'daemon-source');
    for (const name of ['scope', 'store', 'control', 'runtime', 'scratch']) {
      check(path.isAbsolute(config[name]) && await realpath(config[name]) === config[name], 'fixture-path');
      const info = await lstat(config[name]);
      check(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077), 'fixture-directory');
      if (name !== 'scope') {
        const relative = path.relative(config.scope, config[name]);
        check(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'fixture-scope');
      }
    }
    await registered(config.gnome.executable);
    await registered(config.client.executable);
    for (const tool of Object.values(config.tools)) await registered(tool);
    for (const identity of [config.gnome, config.client]) {
      check(identity.libraryPath.split(':').every((entry) => /^\/[A-Za-z0-9_./-]+$/u.test(entry)), 'library-path');
      for (const dependency of Object.values(identity.dependencies))
        check(await realpath(dependency.library) === dependency.library &&
          digest(await readFile(dependency.library)) === dependency.sha256, 'library-identity');
    }
    const environment = isolatedEnvironment(config);
    await admitLoader(config.gnome.executable.path, ['--version'],
      { ...environment, LD_LIBRARY_PATH: config.gnome.libraryPath }, config.gnome.dependencies, config.scratch);
    await admitLoader(config.client.executable.path, ['--contract'],
      { ...environment, LD_LIBRARY_PATH: config.client.libraryPath }, config.client.dependencies, config.scratch);
    secret = await password();
    live();
    if (config.operation === 'restart' && config.fault !== 'missing-probe') {
      check(await storeMatches(config), 'store-identity');
      report.generationChecked = true;
    }
    const socket = path.join(config.runtime, 'bus');
    check(Buffer.byteLength(socket) <= 107, 'socket-path-limit');
    const address = `unix:path=${encode(socket)}`;
    const busConfig = path.join(config.scratch, 'bus.conf');
    await writeFile(busConfig, `<busconfig><type>session</type><listen>${address}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow user="${process.getuid()}"/><allow own="org.gnome.keyring"/>
<allow own="org.freedesktop.secrets"/><allow own="org.freedesktop.impl.portal.Secret"/>
<allow send_destination="*"/><allow receive_sender="*"/></policy><limit name="max_message_size">65536</limit></busconfig>`, { mode: 0o600 });
    const nullReadWrite = await observeNullReadWrite();
    const bus = launch(config.tools.bus.path, ['--nofork', '--nopidfile', `--config-file=${busConfig}`, '--print-address=1'],
      environment, config.scratch);
    let guid;
    try {
      await waitFor(() => bus.stdout.some((part) => part.includes(10)) || bus.closed);
      const busOutput = collected(bus, 'stdout');
      try { guid = /(?:^|,)guid=([a-f0-9]{32})\s*$/u.exec(busOutput.toString('utf8'))?.[1]; }
      finally { busOutput.fill(0); }
      check(guid && !bus.closed, 'private-bus-startup');
    } catch (error) {
      report.busDiagnostic = consumeBusStartupDiagnostic(collected(bus, 'stderr'), {
        closed: bus.closed, spawnError: bus.spawnError, exitCode: bus.code, signal: bus.signal,
        addressObserved: Boolean(guid), nullReadWrite
      });
      throw error;
    }
    const selectedAddress = `${address},guid=${guid}`;
    const daemon = launch(config.gnome.executable.path,
      ['--foreground', '--components=secrets', '--control-directory', config.control, '--unlock'],
      { ...environment, DBUS_SESSION_BUS_ADDRESS: selectedAddress, LD_LIBRARY_PATH: config.gnome.libraryPath, LD_DEBUG: 'libs' },
      config.scratch, secret);
    let owner;
    const startup = Date.now() + 5000;
    while (!owner) {
      live();
      check(!daemon.closed && Date.now() < startup, 'daemon-startup');
      owner = /^\('(:[0-9]+\.[0-9]+)',\)$/u.exec(
        await query(config, selectedAddress, 'GetNameOwner', 'org.freedesktop.secrets') ?? '')?.[1];
      if (!owner) await pause(30);
    }
    const pidReply = await query(config, selectedAddress, 'GetConnectionUnixProcessID', owner);
    const uidReply = await query(config, selectedAddress, 'GetConnectionUnixUser', owner);
    check(/^\(uint32 ([0-9]+),\)$/u.exec(pidReply ?? '')?.[1] === String(daemon.child.pid) &&
      /^\(uint32 ([0-9]+),\)$/u.exec(uidReply ?? '')?.[1] === String(process.getuid()), 'daemon-owner-binding');
    const stat = await readFile(`/proc/${daemon.child.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    check(Number(fields[2]) === process.pid && Number(fields[3]) === process.pid, 'nested-session-escape');
    const control = await lstat(path.join(config.control, 'control'));
    check(control.isSocket() && control.uid === process.getuid(), 'control-location');
    const announced = collected(daemon, 'stdout');
    check(announced.toString('utf8').split('\n').includes(`GNOME_KEYRING_CONTROL=${config.control}`), 'control-announcement');
    announced.fill(0);
    await loaded(daemon, config.gnome.dependencies);
    report.daemon = { pid: daemon.child.pid, sid: Number(fields[3]), start: fields[19], owner };
    await writeFile(path.join(config.runtime, 'ready.json'), JSON.stringify({ ready: true, pid: daemon.child.pid }), { mode: 0o600 });
    if (config.fault === 'hold') await waitFor(() => false, 5000);
    const client = launch(config.client.executable.path, [
      config.operation === 'enroll' ? 'create' : 'read', address, guid, owner, String(process.getuid()),
      String(daemon.child.pid), fields[3], fields[19], '/org/freedesktop/secrets/collection/login',
      config.operation === 'enroll' ? '-' : config.item, config.project, config.workspace, config.enrollment, '5000'
    ], { ...environment, DBUS_SESSION_BUS_ADDRESS: selectedAddress, LD_LIBRARY_PATH: config.client.libraryPath, LD_DEBUG: 'libs' }, config.scratch);
    await waitFor(() => client.closed, 6000);
    await loaded(client, config.client.dependencies);
    frames = collected(client, 'stdout');
    check(frames.length <= 6212, 'client-output-limit');
    report.clientExitCode = client.code;
    report.loaderVerified = true;
  } catch (error) {
    report.blocked = error instanceof Error && /^[a-z-]+$/u.test(error.message) ? error.message : 'native-fixture-failed';
    frames.fill(0); frames = Buffer.alloc(0);
  } finally {
    secret?.fill(0);
    const settled = await Promise.allSettled([...children].reverse().map(stop));
    report.settled = settled.every((result) => result.status === 'fulfilled');
    if (!report.settled || cancelled || config?.fault === 'withhold-settlement') {
      frames.fill(0); frames = Buffer.alloc(0);
      if (config?.fault === 'withhold-settlement') report.settled = false;
    }
    for (const entry of children)
      for (const part of [...entry.stdout, ...entry.stderr]) part.fill(0);
  }
  const metadata = Buffer.from(JSON.stringify(report));
  const header = Buffer.alloc(12);
  header.write('GNF1'); header.writeUInt32BE(metadata.length, 4); header.writeUInt32BE(frames.length, 8);
  const output = Buffer.concat([header, metadata, frames]);
  metadata.fill(0); frames.fill(0);
  await new Promise((resolve) => process.stdout.write(output, () => { output.fill(0); resolve(); }));
}

main().catch(() => { process.exitCode = 1; });
