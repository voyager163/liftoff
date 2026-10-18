#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeContainerToolProfile } from './native-custody-qualification.mjs';

export async function readPinnedCiTool(file, expectedSha256) {
  const before = await lstat(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'CI tool input must be a regular, non-symlink file.');
  const bytes = await readFile(file);
  const after = await lstat(file, { bigint: true });
  for (const field of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) {
    assert.equal(after[field], before[field], 'CI tool input changed while being read.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, expectedSha256, 'CI tool input checksum mismatch.');
  return {
    bytes,
    observation: {
      path: await realpath(file), sha256, bytes: bytes.length,
      dev: after.dev.toString(), ino: after.ino.toString(), uid: after.uid.toString(), gid: after.gid.toString(),
      mode: after.mode.toString(8), nlink: after.nlink.toString(),
      mtimeNs: after.mtimeNs.toString(), ctimeNs: after.ctimeNs.toString()
    }
  };
}

export function assertCiToolArchitecture(bytes, platform) {
  if (platform === 'darwin') {
    assert.ok(bytes.length >= 32, 'CI tools need a complete Mach-O header.');
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'CI tools must be native little-endian Mach-O64 executables.');
    assert.equal(bytes.readUInt32LE(4), 0x0100000c, 'CI tools must target macOS ARM64.');
    assert.equal(bytes.readUInt32LE(12), 2, 'CI tools must be Mach-O executables, not libraries.');
  } else if (platform === 'win32') {
    assert.ok(bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d, 'CI tools need a complete Windows DOS header.');
    const offset = bytes.readUInt32LE(60);
    assert.ok(offset >= 64 && offset <= bytes.length - 26, 'CI tools need a bounded complete PE header.');
    assert.equal(bytes.readUInt32LE(offset), 0x00004550, 'CI tools must be Windows PE executables.');
    assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, 'CI tools must target Windows x64.');
    const flags = bytes.readUInt16LE(offset + 22);
    assert.ok((flags & 0x0002) !== 0 && (flags & 0x2000) === 0, 'CI tools must be executable images, not DLLs.');
    assert.equal(bytes.readUInt16LE(offset + 24), 0x020b, 'CI tools must use the PE32+ format.');
  } else {
    assert.equal(platform, 'linux', 'Unsupported CI tool platform.');
    assert.ok(bytes.length >= 20, 'CI tools need a complete ELF identification and machine header.');
    assert.deepEqual(bytes.subarray(0, 6), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
      'CI tools must be native little-endian ELF64 executables, not wrappers.');
    assert.equal(bytes.readUInt16LE(18), 62, 'CI tools must target Linux x64.');
  }
}

async function nativeTool(file, sha256) {
  const checked = await readPinnedCiTool(file, sha256);
  assertCiToolArchitecture(checked.bytes, process.platform);
  return checked.observation;
}

async function main() {
  assert.equal(process.argv.length, 2, 'CI local-tool preparation accepts no arguments.');
  const mac = process.platform === 'darwin' && process.arch === 'arm64';
  const linux = process.platform === 'linux' && process.arch === 'x64';
  const windows = process.platform === 'win32' && process.arch === 'x64';
  assert.ok((mac || linux || windows) && process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_OS === (mac ? 'macOS' : windows ? 'Windows' : 'Linux') &&
    process.env.RUNNER_ARCH === (mac ? 'ARM64' : 'X64'),
    'CI local-tool preparation requires a Linux x64, Windows x64 or macOS ARM64 GitHub Actions runner.');
  const profile = mac ? nativeContainerToolProfile : windows ? {
    docker: {
      version: '29.8.2', build: '7fc2dff',
      archiveUrl: 'https://download.docker.com/win/static/stable/x86_64/docker-29.8.2.zip',
      archiveSha256: 'e8a956a1f117764dd79f6b1964eca0bb451088fe2db5ecce93ed0e01e5d814b3',
      binarySha256: 'd7366ec1d3fea33020a87151e29e01b703a840f413f72ab4de9a58c02a5ce42f'
    },
    compose: {
      version: '5.5.1',
      binaryUrl: 'https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-windows-x86_64.exe',
      binarySha256: 'a3c0c73033eaede90210345d0cc2233edf4fab8fe0282a91dad8fd8436809d2f'
    }
  } : {
    docker: {
      version: '29.8.2', build: '7fc2dff',
      archiveUrl: 'https://download.docker.com/linux/static/stable/x86_64/docker-29.8.2.tgz',
      archiveSha256: '995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f',
      binarySha256: '6f7a95d27f98fc8c5f6b220898988bf8f61dd9b040936797917cbdc72c6cabe6'
    },
    compose: {
      version: '5.5.1',
      binaryUrl: 'https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-x86_64',
      binarySha256: 'db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576'
    }
  };
  for (const name of ['RUNNER_TEMP', 'GITHUB_PATH']) {
    assert.ok(process.env[name] && path.isAbsolute(process.env[name]), `${name} must be an absolute runner-owned path.`);
  }
  const root = await realpath(await mkdtemp(path.join(process.env.RUNNER_TEMP, 'liftoff-ci-docker-')));
  assert.ok(!/[\r\n]/.test(root), 'The CI tool prefix must fit one GITHUB_PATH line.');
  for (const directory of ['bin', 'cli-plugins', 'extract', 'config']) {
    await mkdir(path.join(root, directory), { mode: 0o700 });
  }
  const run = (command, args, timeout = 15_000) => execFileSync(command, args, {
    encoding: 'utf8', shell: false, timeout, maxBuffer: 64 * 1024
  }).trim();
  const download = (url, destination) => run('curl', [
    '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--tlsv1.2', '--max-time', '180', '--output', destination, url
  ], 185_000);
  const archive = path.join(root, `docker-${profile.docker.version}.${windows ? 'zip' : 'tgz'}`);
  const docker = path.join(root, 'bin', windows ? 'docker.exe' : 'docker');
  const compose = path.join(root, 'cli-plugins', windows ? 'docker-compose.exe' : 'docker-compose');
  const dockerUrl = profile.docker.archiveUrl;
  const composeUrl = profile.compose.binaryUrl;
  download(dockerUrl, archive);
  const archiveObservation = (await readPinnedCiTool(archive,
    profile.docker.archiveSha256)).observation;
  run('tar', [windows ? '-xf' : '-xzf', archive, ...(windows ? [] : ['--no-same-owner']),
    '-C', path.join(root, 'extract'), windows ? 'docker/docker.exe' : 'docker/docker']);
  await copyFile(path.join(root, 'extract', 'docker', windows ? 'docker.exe' : 'docker'), docker);
  download(composeUrl, compose);
  await chmod(docker, 0o755);
  await chmod(compose, 0o755);
  const dockerObservation = await nativeTool(docker, profile.docker.binarySha256);
  const composeObservation = await nativeTool(compose, profile.compose.binarySha256);
  const probe = (file, args) => execFileSync(file, args, {
    encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 4096,
    env: { ...process.env, DOCKER_CONFIG: path.join(root, 'config') }
  }).trim();
  const dockerVersion = probe(docker, ['--version']);
  const composeVersion = probe(compose, ['version', '--short']);
  assert.equal(dockerVersion, `Docker version ${profile.docker.version}, build ${profile.docker.build}`);
  assert.equal(composeVersion, profile.compose.version);
  console.log(JSON.stringify({
    purpose: 'CI bootstrap observations, not an authenticated tool/program subject or release qualification',
    platform: process.platform, architecture: process.arch,
    archive: { ...archiveObservation, url: dockerUrl },
    docker: { ...dockerObservation, version: dockerVersion },
    compose: { ...composeObservation, url: composeUrl, version: composeVersion }
  }, null, 2));
  await appendFile(process.env.GITHUB_PATH, `${path.dirname(docker)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
