#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'voyager163/liftoff';
const packageName = '@msn-control/liftoff';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', shell: false, timeout: 300_000, maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout.trim();
}

export async function releaseContext(root, env, { allowDispatch = false } = {}) {
  assert.equal(env.GITHUB_REPOSITORY, repository, 'Release repository must be canonical.');
  assert.match(env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/, 'Release commit must be a full SHA.');
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/, 'Release must identify its workflow run.');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root), env.GITHUB_SHA, 'Checkout does not match the release commit.');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, packageName, 'Release package name must be canonical.');
  // Full SemVer and installed-version qualification is performed by verify:release-identity.
  assert.match(pkg.version ?? '', /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Unsafe release version.');
  const manual = allowDispatch && env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (!manual) {
    assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Only tag pushes can publish.');
    assert.equal(env.GITHUB_REF_TYPE, 'tag', 'Release ref must be a tag, not a branch.');
    assert.equal(env.GITHUB_REF, `refs/tags/v${pkg.version}`, 'Tag must match the qualified package version.');
    assert.equal(
      run('git', ['rev-parse', '--verify', `${env.GITHUB_REF}^{commit}`], root),
      env.GITHUB_SHA,
      'Release tag no longer identifies the qualified commit.'
    );
    run('git', ['merge-base', '--is-ancestor', env.GITHUB_SHA, 'refs/remotes/origin/main'], root);
  }
  return {
    schemaVersion: 1,
    repository,
    name: packageName,
    version: pkg.version,
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    event: env.GITHUB_EVENT_NAME,
    tag: manual ? null : `v${pkg.version}`,
    distTag: pkg.version.includes('-') ? 'next' : 'latest',
    filename: `msn-control-liftoff-${pkg.version}.tgz`
  };
}

async function regularFile(file) {
  assert.ok((await lstat(file)).isFile(), `Release artifact must be a regular file: ${file}`);
  return readFile(file);
}

export async function recordArtifact(directory, context) {
  const bytes = await regularFile(path.join(directory, context.filename));
  const record = { ...context, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(path.join(directory, 'release.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return record;
}

export async function verifyArtifact(directory, context, expectedDigest) {
  assert.match(expectedDigest ?? '', /^[0-9a-f]{64}$/, 'Expected digest must come from the qualification job.');
  const record = JSON.parse((await regularFile(path.join(directory, 'release.json'))).toString('utf8'));
  for (const [key, expected] of Object.entries(context)) {
    assert.equal(record[key], expected, `Qualified artifact ${key} mismatch.`);
  }
  assert.equal(record.sha256, expectedDigest, 'Recorded artifact digest differs from qualification.');
  const bytes = await regularFile(path.join(directory, context.filename));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedDigest, 'Release tarball digest mismatch.');
  return record;
}

async function outputs(record, env) {
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `filename=${record.filename}\nsha256=${record.sha256}\ndist_tag=${record.distTag}\n`);
  }
  console.log(`Verified ${record.name}@${record.version} for run ${record.runId} (${record.sha256}).`);
}

async function main() {
  const [operation, destination, ...extra] = process.argv.slice(2);
  assert.ok(['check-ref', 'pack', 'verify'].includes(operation), 'Usage: release-artifact.mjs <check-ref|pack|verify> [directory]');
  assert.equal(extra.length, 0, 'Unexpected release artifact arguments.');
  const root = process.cwd();
  const env = process.env;
  const context = await releaseContext(root, env, { allowDispatch: operation !== 'verify' });
  if (operation === 'check-ref') {
    assert.equal(destination, undefined, 'check-ref does not take an artifact directory.');
    console.log(`Qualified ref ${env.GITHUB_REF} at ${context.commit}; ${context.event}.`);
    return;
  }
  assert.ok(destination, 'An explicit artifact directory is required.');
  const directory = path.resolve(destination);
  if (operation === 'pack') {
    assert.ok(env.npm_execpath, 'Run packing through npm run prepare:release.');
    await mkdir(directory, { recursive: true });
    assert.deepEqual(await readdir(directory), [], 'The release artifact directory must be empty.');
    const value = JSON.parse(run(process.execPath, [
      env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory
    ], root));
    const results = Array.isArray(value) ? value : Object.values(value);
    assert.equal(results.length, 1, 'Packing must produce exactly one package.');
    assert.equal(results[0].name, context.name);
    assert.equal(results[0].version, context.version);
    assert.equal(results[0].filename, context.filename);
    await outputs(await recordArtifact(directory, context), env);
  } else {
    await outputs(await verifyArtifact(directory, context, env.EXPECTED_SHA256), env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Release artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
