import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeBundleLimits } from './native-bundle-contract.mjs';

const refuse = () => { throw new Error('Invalid private cask staging request.'); };
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const physical = stat => JSON.stringify(
  ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]))
);
const directoryIdentity = stat => JSON.stringify(['dev', 'ino', 'uid', 'gid', 'mode'].map(key => String(stat[key])));

export function parseCaskStageWritePlan(value) {
  if (!closed(value, ['schemaVersion', 'kind', 'mode', 'root', 'directoryIdentity', 'files']) ||
    value.schemaVersion !== 1 || value.kind !== 'liftoff-cask-stage-write' ||
    !['create', 'manifest'].includes(value.mode) || typeof value.root !== 'string' ||
    !path.isAbsolute(value.root) || path.resolve(value.root) !== value.root || /[\u0000-\u001f]/.test(value.root) ||
    typeof value.directoryIdentity !== 'string' || value.directoryIdentity.length > 1024 ||
    !Array.isArray(value.files) || !value.files.length || value.files.length > 41) refuse();
  let total = 0;
  const names = new Set();
  const fixed = ['release.json', 'qualification.json', 'qualification.sig', 'qualification.pub',
    'archive.tar.gz', 'sbom.cdx.json', 'provenance.json', 'NOTICE', 'definition.rb'];
  for (const file of value.files) {
    if (!closed(file, ['name', 'bytes', 'sha256']) || typeof file.name !== 'string' ||
      names.has(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse();
    if (value.mode === 'manifest' ? file.name !== 'snapshot.json' :
      !fixed.includes(file.name) && !/^evidence-(?:[0-9]|[12][0-9]|3[01])\.bin$/.test(file.name)) refuse();
    const maximum = file.name === 'archive.tar.gz' ? 256 * 1024 * 1024
      : file.name === 'snapshot.json' ? 64 * 1024
        : file.name === 'qualification.sig' ? 64 : file.name === 'qualification.pub' ? 4096 : 8 * 1024 * 1024;
    if (file.bytes > maximum || (total += file.bytes) > nativeBundleLimits.totalBytes) refuse();
    names.add(file.name);
  }
  if (value.mode === 'manifest' ? value.files.length !== 1 : fixed.some(name => !names.has(name))) refuse();
  return value;
}

async function main() {
  if (process.platform === 'win32' || process.argv.length !== 2) refuse();
  const input = process.stdin[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  const next = async maximum => {
    while (!pending.length) {
      const chunk = await input.next();
      if (chunk.done) refuse();
      pending = chunk.value;
    }
    const value = pending.subarray(0, maximum);
    pending = pending.subarray(value.length);
    return value;
  };
  const exact = async length => {
    const result = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
      const bytes = await next(length - offset);
      bytes.copy(result, offset);
      offset += bytes.length;
    }
    return result;
  };
  const headerLength = (await exact(4)).readUInt32BE();
  if (!headerLength || headerLength > 64 * 1024) refuse();
  const plan = parseCaskStageWritePlan(JSON.parse(new TextDecoder('utf-8', { fatal: true })
    .decode(await exact(headerLength))));
  const assertDirectory = stat => {
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) ||
      stat.gid !== BigInt(process.getgid()) || (stat.mode & 0o7777n) !== 0o700n) refuse();
  };
  const initial = await lstat('.', { bigint: true });
  assertDirectory(initial);
  if (directoryIdentity(initial) !== plan.directoryIdentity || await realpath('.') !== plan.root) refuse();
  if (plan.mode === 'create') {
    await mkdir('cask-target', { mode: 0o700 });
    process.chdir('cask-target');
  }
  // This child alone changes cwd. Relative writes stay bound to its original directory after a parent-name replacement.
  const root = plan.mode === 'create' ? path.join(plan.root, 'cask-target') : plan.root;
  const directory = await open('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const ownedDirectory = await directory.stat({ bigint: true });
    assertDirectory(ownedDirectory);
    if (await realpath('.') !== root) refuse();
    const files = [];
    for (const file of plan.files) {
      const handle = await open(file.name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const hash = createHash('sha256');
        for (let remaining = file.bytes; remaining > 0;) {
          const bytes = await next(Math.min(remaining, 64 * 1024));
          hash.update(bytes);
          await handle.writeFile(bytes);
          remaining -= bytes.length;
        }
        if (hash.digest('hex') !== file.sha256) refuse();
        await handle.sync();
        const owned = await handle.stat({ bigint: true });
        if (!owned.isFile() || owned.nlink !== 1n || owned.uid !== ownedDirectory.uid || owned.gid !== ownedDirectory.gid ||
          (owned.mode & 0o7777n) !== 0o600n || owned.size !== BigInt(file.bytes) ||
          physical(await lstat(file.name, { bigint: true })) !== physical(owned)) refuse();
        files.push({ name: file.name, physical: physical(owned) });
      } finally { await handle.close(); }
    }
    if (pending.length || !(await input.next()).done) refuse();
    await directory.sync();
    if (directoryIdentity(await lstat('.', { bigint: true })) !== directoryIdentity(ownedDirectory) ||
      await realpath('.') !== root) refuse();
    process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'liftoff-cask-stage-written',
      directoryIdentity: directoryIdentity(ownedDirectory), files }));
  } finally { await directory.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch {
    process.stderr.write('liftoff-cask-target-stage:refused\n');
    process.exitCode = 1;
  }
}
