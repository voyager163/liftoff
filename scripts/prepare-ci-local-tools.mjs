#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

async function nativeTool(file, sha256) {
  const checked = await readPinnedCiTool(file, sha256);
  assert.deepEqual(checked.bytes.subarray(0, 6), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]),
    'CI tools must be native little-endian ELF64 executables, not wrappers.');
  assert.equal(checked.bytes.readUInt16LE(18), 62, 'CI tools must target Linux x64.');
  return checked.observation;
}

async function main() {
  assert.equal(process.argv.length, 2, 'CI local-tool preparation accepts no arguments.');
  assert.ok(process.platform === 'linux' && process.arch === 'x64' &&
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux' &&
    process.env.RUNNER_ARCH === 'X64', 'CI local-tool preparation requires a Linux x64 GitHub Actions runner.');
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
  const archive = path.join(root, 'docker-29.8.2.tgz');
  const docker = path.join(root, 'bin', 'docker');
  const compose = path.join(root, 'cli-plugins', 'docker-compose');
  const dockerUrl = 'https://download.docker.com/linux/static/stable/x86_64/docker-29.8.2.tgz';
  const composeUrl = 'https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-linux-x86_64';
  download(dockerUrl, archive);
  const archiveObservation = (await readPinnedCiTool(archive,
    '995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f')).observation;
  run('tar', ['-xzf', archive, '--no-same-owner', '-C', path.join(root, 'extract'), 'docker/docker']);
  await copyFile(path.join(root, 'extract', 'docker', 'docker'), docker);
  download(composeUrl, compose);
  await chmod(docker, 0o755);
  await chmod(compose, 0o755);
  const dockerObservation = await nativeTool(docker, '6f7a95d27f98fc8c5f6b220898988bf8f61dd9b040936797917cbdc72c6cabe6');
  const composeObservation = await nativeTool(compose, 'db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576');
  const probe = (file, args) => execFileSync(file, args, {
    encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 4096,
    env: { ...process.env, DOCKER_CONFIG: path.join(root, 'config') }
  }).trim();
  const dockerVersion = probe(docker, ['--version']);
  const composeVersion = probe(compose, ['version', '--short']);
  assert.equal(dockerVersion, 'Docker version 29.8.2, build 7fc2dff');
  assert.equal(composeVersion, '5.5.1');
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
