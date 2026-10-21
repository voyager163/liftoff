#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'voyager163/liftoff';
export const jobIdentityQualificationName = 'Observe signed GitHub job identity';

export const jobIdentityProgramBootstrap = String.raw`node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isBuiltin, registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

try {
  assert.equal(process.version, 'v24.21.0');
  const expected = process.env.LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/u);
  const root = await realpath(process.cwd());
  const directory = path.join(root, 'qualification', 'job-identity-program');
  const snapshots = new Map();
  const modules = new Map();
  const identity = value => [value.dev, value.ino, value.mode, value.nlink,
    value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const name of [root, path.dirname(directory), directory]) {
    const value = await lstat(name, { bigint: true });
    assert.ok(value.isDirectory() && !value.isSymbolicLink());
    assert.equal(await realpath(name), name);
    snapshots.set(name, identity(value));
  }
  const names = ['job-identity.js', 'activation-rest.js', 'qualify.mjs', 'package.json'];
  assert.deepEqual((await readdir(directory)).sort(), [...names, 'inventory.json'].sort());
  async function capture(name, maximum) {
    const file = path.join(directory, name);
    const before = await lstat(file, { bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum));
    // Windows has no POSIX FIFO/no-follow flags; opened identity is checked on every host.
    const flags = process.platform === 'win32' ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(file, flags);
    let bytes;
    try {
      assert.equal(identity(await handle.stat({ bigint: true })), identity(before));
      bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        assert.ok(bytesRead > 0);
        offset += bytesRead;
      }
      assert.equal((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead, 0);
      assert.equal(identity(await handle.stat({ bigint: true })), identity(before));
    } finally { await handle.close(); }
    assert.equal(identity(await lstat(file, { bigint: true })), identity(before));
    snapshots.set(file, identity(before));
    return bytes;
  }
  const inventoryBytes = await capture('inventory.json', 4096);
  assert.equal(hash(inventoryBytes), expected);
  const inventory = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventoryBytes));
  assert.deepEqual(Object.keys(inventory).sort(), ['files', 'schemaVersion']);
  assert.equal(inventory.schemaVersion, 1);
  assert.ok(Array.isArray(inventory.files));
  assert.deepEqual(inventory.files.map(file => file.name), names);
  for (const file of inventory.files) {
    assert.deepEqual(Object.keys(file).sort(), ['name', 'sha256']);
    assert.match(file.sha256 ?? '', /^[a-f0-9]{64}$/u);
    const bytes = await capture(file.name, 256 * 1024);
    assert.equal(hash(bytes), file.sha256);
    if (file.name === 'package.json') assert.equal(bytes.toString('utf8'), '{"type":"module"}\n');
    else modules.set(pathToFileURL(path.join(directory, file.name)).href,
      new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  assert.deepEqual((await readdir(directory)).sort(), [...names, 'inventory.json'].sort());
  for (const [name, before] of snapshots) {
    assert.equal(identity(await lstat(name, { bigint: true })), before);
  }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('node:') && isBuiltin(specifier)) return nextResolve(specifier, context);
      const url = new URL(specifier, context.parentURL).href;
      assert.ok(modules.has(url));
      return { url, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (url.startsWith('node:') && isBuiltin(url)) return nextLoad(url, context);
      assert.ok(modules.has(url));
      return { format: 'module', source: modules.get(url), shortCircuit: true };
    }
  });
  try {
    const program = await import(pathToFileURL(path.join(directory, 'qualify.mjs')).href);
    await program.runGitHubJobIdentityObservation();
  } finally { hooks.deregister(); }
} catch {
  console.error('GitHub job identity program handoff failed; helper verification or execution was refused and diagnostics were withheld.');
  process.exitCode = 1;
}
NODE`;

function id(value) {
  assert.match(value ?? '', /^[1-9][0-9]*$/u, 'A literal original provider ID is required.');
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number), 'The original provider ID must be safe.');
  return number;
}

// These are expected selectors, not verified job facts or an authorization grant.
export function selectGitHubJobIdentityBinding(env, data) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'Reruns require a new original qualification.');
  assert.equal(env.GITHUB_JOB, 'observe-job-identity');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
  assert.ok(env.GITHUB_WORKFLOW_REF?.startsWith(`${repository}/.github/workflows/github-job-identity.yml@refs/heads/`));
  assert.ok(data && !Array.isArray(data) && typeof data === 'object');
  assert.ok(Array.isArray(data.jobs) && data.total_count === data.jobs.length && data.jobs.length <= 100,
    'The original jobs response must be complete and bounded.');
  const matches = data.jobs.filter(job => job.name === jobIdentityQualificationName);
  assert.equal(matches.length, 1, 'Exactly one original identity job is required.');
  const job = matches[0], runId = id(env.GITHUB_RUN_ID);
  assert.equal(job.run_id, runId);
  assert.equal(job.run_attempt, 1);
  assert.equal(job.head_sha, env.GITHUB_SHA);
  assert.equal(job.status, 'in_progress');
  assert.equal(job.conclusion, null);
  const check = new RegExp(`^https://api\\.github\\.com/repos/${repository}/check-runs/([1-9][0-9]*)$`, 'u').exec(job.check_run_url);
  assert.ok(check, 'Use the actual check-run URL; the Actions job ID is not its check-run ID.');
  const selected = {
    repository, repositoryId: id(env.GITHUB_REPOSITORY_ID), ownerId: id(env.GITHUB_REPOSITORY_OWNER_ID),
    actorId: id(env.GITHUB_ACTOR_ID), runId, checkRunId: id(check[1]), runAttempt: 1,
    sourceSha: env.GITHUB_SHA, workflowRef: env.GITHUB_WORKFLOW_REF
  };
  return Object.freeze({
    ...selected,
    audience: `urn:liftoff:github-job-identity:${createHash('sha256')
      .update(JSON.stringify(selected)).update(randomBytes(32)).digest('hex')}`
  });
}

export async function prepareGitHubJobIdentityProgram(root = process.cwd()) {
  assert.equal(process.version, 'v24.21.0', 'Qualification uses the exact reviewed Node transformer/runtime.');
  const output = path.join(root, 'qualification', 'job-identity-program');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const files = [];
  for (const name of ['job-identity', 'activation-rest']) {
    const source = await readFile(path.join(root, 'src', 'adapters', 'github', `${name}.ts`), 'utf8');
    const bytes = stripTypeScriptTypes(source, { mode: 'transform' });
    await writeFile(path.join(output, `${name}.js`), bytes, { flag: 'wx' });
    files.push({ name: `${name}.js`, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const entry = await readFile(fileURLToPath(import.meta.url));
  await writeFile(path.join(output, 'qualify.mjs'), entry, { flag: 'wx' });
  files.push({ name: 'qualify.mjs', sha256: createHash('sha256').update(entry).digest('hex') });
  const packageBytes = '{"type":"module"}\n';
  await writeFile(path.join(output, 'package.json'), packageBytes, { flag: 'wx' });
  files.push({ name: 'package.json', sha256: createHash('sha256').update(packageBytes).digest('hex') });
  await writeFile(path.join(output, 'inventory.json'), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { flag: 'wx' });
  return output;
}

async function originalJobs(env) {
  const runId = id(env.GITHUB_RUN_ID);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.ok(env.GH_TOKEN && !/[\s\u0000-\u001f\u007f]/u.test(env.GH_TOKEN), 'The read-only Actions API credential is required.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/1/jobs?per_page=100`, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', Authorization: `Bearer ${env.GH_TOKEN}` }
    });
    assert.equal(response.status, 200, 'The original jobs API must succeed.');
    assert.ok(response.body, 'The original jobs body is required.');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        assert.ok(size <= 262_144, 'The original jobs API exceeded its byte bound.');
        chunks.push(part.value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    } finally { reader.releaseLock(); }
  } finally { clearTimeout(timer); controller.abort(); }
}

async function observe() {
  assert.equal(process.version, 'v24.21.0');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const inventoryBytes = await readFile(path.join(directory, 'inventory.json'));
  const inventorySha256 = createHash('sha256').update(inventoryBytes).digest('hex');
  assert.match(process.env.LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256 ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(inventorySha256, process.env.LIFTOFF_JOB_IDENTITY_PROGRAM_SHA256);
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  assert.equal(inventory.schemaVersion, 1);
  assert.deepEqual(inventory.files.map(file => file.name), ['job-identity.js', 'activation-rest.js', 'qualify.mjs', 'package.json']);
  for (const file of inventory.files) {
    assert.equal(createHash('sha256').update(await readFile(path.join(directory, file.name))).digest('hex'), file.sha256,
      'The exact prepared qualification program must be unchanged.');
  }
  const { observeGitHubJobIdentity, assertCurrentGitHubJobIdentity } = await import('./job-identity.js');
  const expected = selectGitHubJobIdentityBinding(process.env, await originalJobs(process.env));
  const observation = await observeGitHubJobIdentity(expected);
  assertCurrentGitHubJobIdentity(observation, expected);
  await writeFile(path.join(directory, 'job-identity-report.json'), `${JSON.stringify({
    schemaVersion: 1, scope: 'signed-github-job-facts-only', nodeVersion: process.version,
    observation, programInventory: inventory, programInventorySha256: inventorySha256,
    limits: ['ordinary Actions artifact transport is not Source5 authenticated program delivery',
      'no whole-job host custody, cloud access, build, publication, effect approval or workflow authority']
  }, null, 2)}\n`, { flag: 'wx' });
  console.log('Verified original signed GitHub job facts only; delivery, host custody and workflow authority remain unestablished.');
}

function qualificationFailure(error) {
  const code = /^github-job-identity-[a-z-]+$/u.test(error?.code ?? '') ? error.code : 'qualification-input-or-preparation';
  const stage = code === 'github-job-identity-claims' && [
    'time-type', 'lifetime', 'issuer-audience', 'repository', 'actor', 'run', 'job',
    'source-workflow', 'event-host', 'ref', 'subject', 'unsupported-claims'
  ].includes(error?.claimStage) ? `; claim-stage=${error.claimStage}` : '';
  console.error(`GitHub job identity qualification failed (${code}${stage}); credentials and provider diagnostics were withheld.`);
  process.exitCode = 1;
}

export async function runGitHubJobIdentityObservation() {
  try { await observe(); } catch (error) { qualificationFailure(error); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3);
    assert.ok(['prepare', 'observe'].includes(process.argv[2]));
    if (process.argv[2] === 'prepare') {
      const output = await prepareGitHubJobIdentityProgram();
      console.log(createHash('sha256').update(await readFile(path.join(output, 'inventory.json'))).digest('hex'));
    } else await runGitHubJobIdentityObservation();
  } catch (error) { qualificationFailure(error); }
}
