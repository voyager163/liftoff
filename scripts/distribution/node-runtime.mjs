import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { demand, fileIdentity, runBuildCommand, writeJson } from './native-build-files.mjs';

const pinsPath = fileURLToPath(new URL('./node-runtime.json', import.meta.url));
export const pinnedRuntime = Object.freeze(JSON.parse(fs.readFileSync(pinsPath, 'utf8')));
const TARGETS = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];

export function runtimeDefinition(target) {
  demand(TARGETS.includes(target), `Unsupported native target: ${target}`);
  demand(pinnedRuntime.schemaVersion === 1 && /^\d+\.\d+\.\d+$/.test(pinnedRuntime.version), 'Invalid registered Node runtime version');
  demand(pinnedRuntime.vendorSupportPolicy === 'vendor-supported-platforms-only', 'Official runtime registration must retain the upstream vendor-support restriction');
  const definition = pinnedRuntime.targets[target];
  const platform = target.replace('win32-', 'win-');
  const extension = target.startsWith('win32-') ? 'zip' : 'tar.gz';
  demand(definition?.archive === `node-v${pinnedRuntime.version}-${platform}.${extension}` && /^[a-f0-9]{64}$/.test(definition.sha256), 'Missing exact official runtime archive identity');
  return { ...definition, target, version: pinnedRuntime.version, url: `https://nodejs.org/dist/v${pinnedRuntime.version}/${definition.archive}`,
    upstream: { ...definition.upstream, vendorSupportPolicy: pinnedRuntime.vendorSupportPolicy },
    archiveRoot: definition.archive.slice(0, -(extension.length + 1)) };
}

export function verifyRuntimeArchive(file, target) {
  const definition = runtimeDefinition(target);
  const actual = fileIdentity(file);
  demand(actual.size > 0 && actual.sha256 === definition.sha256, `Official pinned runtime archive checksum mismatch for ${target}`);
  return definition;
}

export async function downloadPinnedFile(url, destination, expectedSha256, maximumBytes) {
  const source = new URL(url);
  demand(source.protocol === 'https:' && ['nodejs.org', 'raw.githubusercontent.com'].includes(source.hostname) &&
    source.username === '' && source.password === '' && !source.hash && !source.search, 'Runtime inputs must come from registered official HTTPS sources');
  const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  demand(response.ok && response.body, `Official runtime download failed: ${source.pathname} (HTTP ${response.status})`);
  const length = response.headers.get('content-length');
  demand(length === null || Number(length) <= maximumBytes, 'Official runtime response exceeds the download bound');
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes <= maximumBytes ? null : new Error('Official runtime download exceeded its byte bound'), chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), bounded, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  const actual = fileIdentity(destination, maximumBytes);
  demand(actual.size > 0 && actual.sha256 === expectedSha256, `Official source bytes differ from the pinned SHA-256: ${source.pathname}`);
  return actual;
}

export function inspectNativeMachine(file, target) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const header = Buffer.alloc(1024 * 1024);
  let length;
  try { length = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  const [os, arch] = target.split('-');
  let minimumMacosVersion;
  if (os === 'darwin') {
    demand(length >= 32 && header.readUInt32LE(0) === 0xfeedfacf &&
      header.readUInt32LE(4) === (arch === 'arm64' ? 0x0100000c : 0x01000007), 'Private runtime/launcher Mach-O machine does not match its target');
    const count = header.readUInt32LE(16);
    demand(count <= 2048 && header.readUInt32LE(20) + 32 <= length, 'Mach-O load commands exceed the machine-inspection bound');
    let offset = 32;
    for (let index = 0; index < count; index++) {
      const command = header.readUInt32LE(offset);
      const size = header.readUInt32LE(offset + 4);
      demand(size >= 8 && offset + size <= length, 'Malformed Mach-O load command');
      let encoded;
      if (command === 0x32 && size >= 24 && header.readUInt32LE(offset + 8) === 1) encoded = header.readUInt32LE(offset + 12);
      if (command === 0x24 && size >= 16) encoded = header.readUInt32LE(offset + 8);
      if (encoded !== undefined) minimumMacosVersion = `${encoded >>> 16}.${(encoded >>> 8) & 255}.${encoded & 255}`;
      offset += size;
    }
  } else if (os === 'linux') {
    demand(length >= 20 && header.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
      header.readUInt16LE(18) === (arch === 'arm64' ? 183 : 62), 'Private runtime/launcher ELF machine does not match its target');
  } else {
    demand(os === 'win32' && length >= 64 && header.toString('ascii', 0, 2) === 'MZ', 'Windows runtime/launcher is not a PE executable');
    const offset = header.readUInt32LE(0x3c);
    demand(offset + 26 <= length && header.toString('ascii', offset, offset + 4) === 'PE\0\0' &&
      header.readUInt16LE(offset + 4) === (arch === 'arm64' ? 0xaa64 : 0x8664) &&
      header.readUInt16LE(offset + 24) === 0x20b, 'Windows runtime/launcher PE machine does not match its target');
  }
  return { os, arch, ...(minimumMacosVersion ? { minimumMacosVersion } : {}) };
}

export async function preparePrivateRuntime({ target, runtimeDirectory, workDirectory, archivePath, python, env }) {
  const definition = runtimeDefinition(target);
  const inputs = path.join(workDirectory, 'node-inputs');
  fs.mkdirSync(inputs, { mode: 0o700 });
  const archive = path.join(inputs, definition.archive);
  if (archivePath) {
    verifyRuntimeArchive(archivePath, target);
    fs.copyFileSync(archivePath, archive, fs.constants.COPYFILE_EXCL);
    verifyRuntimeArchive(archive, target);
  } else {
    await downloadPinnedFile(definition.url, archive, definition.sha256, 256 * 1024 * 1024);
  }
  const checksumFile = path.join(inputs, 'SHASUMS256.txt');
  const buildingFile = path.join(inputs, 'BUILDING.md');
  await Promise.all([
    downloadPinnedFile(pinnedRuntime.checksums.url, checksumFile, pinnedRuntime.checksums.sha256, 256 * 1024),
    downloadPinnedFile(pinnedRuntime.building.url, buildingFile, pinnedRuntime.building.sha256, 256 * 1024)
  ]);
  const matches = fs.readFileSync(checksumFile, 'utf8').split(/\r?\n/).filter((line) => line.endsWith(`  ${definition.archive}`));
  demand(matches.length === 1 && matches[0] === `${definition.sha256}  ${definition.archive}`, 'Official checksum inventory does not match the registered runtime');
  const extraction = fileURLToPath(new URL('./native-build-archive.py', import.meta.url));
  await runBuildCommand(python, [extraction, 'runtime', archive, definition.archiveRoot, definition.binary, runtimeDirectory], {
    cwd: workDirectory, env, label: 'Verified runtime extraction', timeout: 120_000
  });
  const binary = path.join(runtimeDirectory, target.startsWith('win32-') ? 'node.exe' : 'node');
  const identity = fileIdentity(binary);
  const machine = inspectNativeMachine(binary, target);
  if (target.startsWith('darwin-')) demand(machine.minimumMacosVersion === definition.upstream.minimumHostVersion,
    'Official Mach-O deployment target does not match pinned BUILDING.md; do not invent a lower host floor');
  const sameTarget = target === `${process.platform}-${process.arch}`;
  let observed = null;
  if (sameTarget) {
    const output = await runBuildCommand(binary, ['--input-type=commonjs', '-p',
      'JSON.stringify({version:process.versions.node,os:process.platform,arch:process.arch,hostRelease:require("node:os").release()})'], {
      cwd: workDirectory, env, timeout: 15_000, maxBuffer: 4096, label: 'Official private runtime identity'
    });
    observed = JSON.parse(output);
    demand(observed.version === definition.version && observed.os === machine.os && observed.arch === machine.arch, 'Verified runtime did not execute as its exact pinned Node version and machine');
  }
  demand(fileIdentity(binary).sha256 === identity.sha256, 'Private runtime changed after verification');
  const result = {
    schemaVersion: 1, name: 'node', version: definition.version, target,
    archive: { url: definition.url, sha256: definition.sha256 },
    checksums: pinnedRuntime.checksums, building: pinnedRuntime.building,
    executable: { path: target.startsWith('win32-') ? 'runtime/node.exe' : 'runtime/node', ...identity },
    upstream: definition.upstream, machine, observed,
    qualification: sameTarget ? 'verified-runtime-identity-on-current-host-only' : 'verified-archive-and-machine-not-executed-on-target'
  };
  writeJson(path.join(workDirectory, 'runtime-verification.json'), result);
  return result;
}
