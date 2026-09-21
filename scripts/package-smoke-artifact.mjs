import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const maximumArchiveSize = 32 * 1024 * 1024;
const maximumUnpackedSize = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** @returns {never} */
function fail(reason) {
  throw new Error(`Invalid package smoke artifact: ${reason}`);
}

export function parseSmokeArguments(args, paths = path) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--tarball' || !paths.isAbsolute(args[1]) ||
      /[\0-\x1f\x7f]/u.test(args[1])) {
    fail('usage: --tarball <absolute-existing-file>');
  }
  return args[1];
}

function stringField(bytes) {
  const nul = bytes.indexOf(0);
  if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) fail('ambiguous tar string');
  try { return decoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul)); }
  catch { fail('invalid tar text'); }
}

function octal(bytes) {
  const value = bytes.toString('ascii').replace(/^[ \0]+|[ \0]+$/g, '');
  if (!/^[0-7]+$/.test(value)) fail('invalid tar number');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result) || result < 0) fail('invalid tar number');
  return result;
}

function paxFields(bytes) {
  if (bytes.length > 16 * 1024) fail('oversized PAX header');
  const fields = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const count = bytes.subarray(offset, space).toString('ascii');
    if (space < offset || !/^[1-9]\d{0,5}$/.test(count)) fail('invalid PAX record');
    const end = offset + Number(count);
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) fail('invalid PAX record');
    let text;
    try { text = decoder.decode(bytes.subarray(space + 1, end - 1)); }
    catch { fail('invalid PAX text'); }
    const equal = text.indexOf('=');
    const key = text.slice(0, equal), value = text.slice(equal + 1);
    if (equal <= 0 || fields.has(key) ||
        !['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key) ||
        /[\0\r\n]/u.test(value)) fail('unsupported PAX field');
    if (key === 'size' && !/^(?:0|[1-9]\d{0,8})$/.test(value)) fail('invalid PAX size');
    fields.set(key, value);
    offset = end;
  }
  return fields;
}

function packagePath(name, directory) {
  if (directory && name.endsWith('/')) name = name.slice(0, -1);
  const parts = name.split('/');
  if (parts[0] !== 'package' || parts.length < (directory ? 1 : 2) || name.length > 4096 ||
      parts.some(part => !part || part === '.' || part === '..' || part.normalize('NFC') !== part ||
        Buffer.byteLength(part) > 255 || /[\\:\0-\x1f\x7f<>|"?*]/u.test(part) || /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('unsafe or non-portable tar path');
  }
  return parts.slice(1).join('/');
}

/** Inspect bytes only; never extract an archive or execute package content. */
export function inspectPackageArchive(bytes, expected, selectedPaths = []) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximumArchiveSize) fail('archive size');
  if (!Array.isArray(selectedPaths) || selectedPaths.length > 100 ||
      selectedPaths.some(value => typeof value !== 'string' || packagePath(`package/${value}`, false) !== value) ||
      new Set(selectedPaths.map(value => value.toLowerCase())).size !== selectedPaths.length) fail('selected input inventory');
  const selectedInputs = [];
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: maximumArchiveSize }); }
  catch { fail('unreadable or oversized gzip archive'); }
  const files = [], nodes = new Map(), explicit = new Set();
  let offset = 0, unpackedSize = 0, pendingPax, ended = false, packageBytes;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (pendingPax || tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) {
        fail('invalid tar terminator');
      }
      ended = true;
      break;
    }
    if (files.length + explicit.size > 20_000) fail('too many tar entries');
    if (header.subarray(257, 265).toString('ascii') !== 'ustar\0' + '00') fail('unsupported tar format');
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(header.subarray(148, 156))) fail('tar checksum mismatch');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (!['0', '5', 'x'].includes(type) || stringField(header.subarray(157, 257)) !== '') {
      fail('links and special tar entries are forbidden');
    }
    const headerSize = octal(header.subarray(124, 136));
    const size = pendingPax?.has('size') ? Number(pendingPax.get('size')) : headerSize;
    if (size > maximumUnpackedSize || (type !== '0' && pendingPax?.has('size'))) fail('invalid tar entry size');
    const end = offset + 512 + size;
    const next = Math.ceil(end / 512) * 512;
    if (next > tar.length || tar.subarray(end, next).some(byte => byte !== 0)) fail('truncated tar entry');
    const body = tar.subarray(offset + 512, end);
    offset = next;
    if (type === 'x') {
      if (pendingPax) fail('stacked PAX headers');
      pendingPax = paxFields(body);
      continue;
    }
    const prefix = stringField(header.subarray(345, 500));
    const name = pendingPax?.get('path') ?? [prefix, stringField(header.subarray(0, 100))].filter(Boolean).join('/');
    pendingPax = undefined;
    const logical = packagePath(name, type === '5');
    const folded = logical.toLowerCase();
    if (explicit.has(folded)) fail('duplicate tar path');
    explicit.add(folded);
    const parts = logical ? logical.split('/') : [];
    for (let index = 0; index < parts.length; index++) {
      const current = parts.slice(0, index + 1).join('/');
      const key = current.toLowerCase();
      const kind = index === parts.length - 1 && type === '0' ? 'file' : 'directory';
      const prior = nodes.get(key);
      if (prior && (prior.path !== current || prior.kind !== kind || kind === 'file')) fail('tar path collision');
      nodes.set(key, { path: current, kind });
    }
    const mode = octal(header.subarray(100, 108));
    if ((mode & ~0o777) !== 0 || (type === '5' && size !== 0)) fail('unsafe tar mode or directory');
    if (type === '5') continue;
    unpackedSize += size;
    if (unpackedSize > maximumUnpackedSize) fail('unpacked size exceeds 8 MiB');
    files.push({ path: logical, size, mode, sha256: createHash('sha256').update(body).digest('hex') });
    if (selectedPaths.includes(logical)) {
      if (body.length > 4 * 1024 * 1024) fail('selected input size');
      let content;
      try { content = decoder.decode(body); } catch { fail('selected input encoding'); }
      selectedInputs.push({ path: logical, content, sha256: createHash('sha256').update(body).digest('hex') });
    }
    if (logical === 'package.json') {
      if (size > 1024 * 1024) fail('oversized package metadata');
      packageBytes = body;
    }
  }
  if (!ended || !packageBytes) fail('missing tar terminator or package.json');
  let metadata;
  try { metadata = JSON.parse(decoder.decode(packageBytes)); }
  catch { fail('invalid package.json'); }
  if (expected.name !== '@msn-control/liftoff' || metadata.name !== expected.name ||
      typeof expected.version !== 'string' || metadata.version !== expected.version) fail('package name/version mismatch');
  if (selectedInputs.length !== selectedPaths.length) fail('missing selected input');
  return {
    name: metadata.name, version: metadata.version, files, unpackedSize, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    ...(selectedPaths.length ? { selectedInputs } : {})
  };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function ownedRegularFile(status) {
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1n ||
      status.size < 1n || status.size > BigInt(maximumArchiveSize) ||
      (process.platform !== 'win32' && ((status.mode & 0o022n) !== 0n ||
        (process.getuid && status.uid !== BigInt(process.getuid()))))) fail('unsafe archive ownership/type/size');
}

async function readArchive(file) {
  if (!path.isAbsolute(file)) fail('archive path must be absolute');
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const parent = await lstat(current);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('archive path traverses a link');
  }
  const canonical = await realpath(absolute);
  const status = await lstat(absolute, { bigint: true });
  ownedRegularFile(status);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(status, await handle.stat({ bigint: true }))) fail('archive identity changed');
    const buffer = Buffer.alloc(Number(status.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    const bytes = buffer.subarray(0, count);
    if (!sameFile(status, await handle.stat({ bigint: true })) ||
        !sameFile(status, await lstat(absolute, { bigint: true })) ||
        await realpath(absolute) !== canonical || bytes.length !== Number(status.size)) fail('archive changed while reading');
    return { bytes, status, canonical };
  } finally {
    await handle.close();
  }
}

/**
 * Select one existing archive or pack once. The snapshot is byte-for-byte, not a
 * repack; npm installs it so replacement of the caller's pathname cannot change
 * the inspected input. Neither the caller's file nor its metadata is written.
 */
export async function prepareSmokeArtifact({ tarball, packageRoot, packDirectory, runNpm }) {
  const expected = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  let packed;
  if (!tarball) {
    const output = JSON.parse(runNpm(['pack', '--json', '--pack-destination', packDirectory]).stdout);
    const results = Array.isArray(output) ? output : output && typeof output === 'object' ? Object.values(output) : [];
    if (results.length !== 1 || typeof results[0]?.filename !== 'string' ||
        !/^[a-z0-9][a-z0-9.+_-]*\.tgz$/i.test(results[0].filename)) fail('invalid npm pack filename');
    packed = results[0];
    tarball = path.join(packDirectory, packed.filename);
  }
  const original = await readArchive(tarball);
  const metadata = inspectPackageArchive(original.bytes, expected);
  if (packed && (packed.name !== metadata.name || packed.version !== metadata.version ||
      packed.integrity !== metadata.integrity || packed.size !== metadata.size ||
      packed.unpackedSize !== metadata.unpackedSize ||
      JSON.stringify(packed.files.map(({ path, size }) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path, 'en'))) !==
      JSON.stringify(metadata.files.map(({ path, size }) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path, 'en'))))) {
    fail('npm metadata differs from actual archive bytes');
  }
  const snapshotPath = path.join(packDirectory, 'inspected-artifact.tgz');
  await writeFile(snapshotPath, original.bytes, { flag: 'wx', mode: 0o400 });
  const snapshot = await readArchive(snapshotPath);
  if (!snapshot.bytes.equals(original.bytes)) fail('archive snapshot mismatch');
  return {
    tarballPath: snapshotPath,
    packResult: { ...metadata, filename: path.basename(tarball) },
    async verifyUnchanged() {
      const [source, copy] = await Promise.all([readArchive(tarball), readArchive(snapshotPath)]);
      if (!sameFile(original.status, source.status) || original.canonical !== source.canonical ||
          !sameFile(snapshot.status, copy.status) || snapshot.canonical !== copy.canonical ||
          !source.bytes.equals(original.bytes) || !copy.bytes.equals(original.bytes)) fail('archive changed after inspection');
    }
  };
}

export async function verifyInstalledArchiveFiles(root, files) {
  for (const file of files) {
    const location = path.join(root, ...file.path.split('/'));
    let parent = root;
    for (const part of ['', ...file.path.split('/').slice(0, -1)]) {
      parent = path.join(parent, part);
      const directory = await lstat(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink()) fail('installed path traverses a link');
    }
    const status = await lstat(location);
    if (!status.isFile() || status.isSymbolicLink() || status.size !== file.size ||
        createHash('sha256').update(await readFile(location)).digest('hex') !== file.sha256) {
      fail('installed file differs from inspected archive');
    }
  }
}
