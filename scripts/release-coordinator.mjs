#!/usr/bin/env node
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNpmCandidate, verifyCandidateBytes } from './repository-security/npm-release.ts';
import { releaseReadiness } from './repository-security/npm-release-operation.ts';
import { canonicalDigest } from './repository-security/admission.ts';

async function boundedFile(root, name, maximum) {
  const target = path.join(root, name);
  const status = await lstat(target);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > maximum ||
      await realpath(target) !== target) throw new Error('Release bundle contains an unsafe file.');
  const bytes = await readFile(target);
  if (bytes.length > maximum) throw new Error('Release bundle file exceeded its size bound.');
  return bytes;
}

export async function readCandidateBundle(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('Absolute registered release bundle path required.');
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) {
    throw new Error('Unsafe release bundle root.');
  }
  const candidate = parseNpmCandidate(JSON.parse((await boundedFile(directory, 'candidate.json', 64 * 1024)).toString('utf8')));
  const tarball = await boundedFile(directory, candidate.artifact.filename, 32 * 1024 * 1024);
  verifyCandidateBytes(candidate, tarball);
  return { candidate, tarball };
}

export async function main(args, env = process.env) {
  if (args.length !== 1 || !['readiness', 'assemble', 'npm', 'canonical', 'finalize'].includes(args[0])) {
    throw new Error('Usage: node scripts/release-coordinator.mjs <readiness|assemble|npm|canonical|finalize>');
  }
  const { candidate } = await readCandidateBundle(env.LIFTOFF_RELEASE_BUNDLE);
  if (env.GITHUB_REPOSITORY !== 'voyager163/liftoff' || !['true', 'false'].includes(env.LIFTOFF_RELEASE_DRY_RUN ?? '') ||
      !['workflow_dispatch', 'push', 'pull_request'].includes(env.GITHUB_EVENT_NAME ?? '')) {
    throw new Error('Missing or invalid workflow invocation context.');
  }
  if (args[0] === 'canonical') {
    if (candidate.source.dirty || candidate.source.commit !== env.GITHUB_SHA ||
        env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
        env.LIFTOFF_RELEASE_DRY_RUN !== 'false' ||
        ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'NODE_AUTH_TOKEN', 'NPM_TOKEN',
          'PUBLISHER_TOKEN', 'GITHUB_APP_TOKEN'].some(name => env[name])) {
      throw new Error('Canonical installed verification requires a clean selected source and no publisher authority.');
    }
    const source = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    if (source.name !== candidate.artifact.name || source.version !== candidate.artifact.version) {
      throw new Error('Canonical verifier source identity mismatch.');
    }
    const { verifyPublishedPackage } = await import('../dist/published-verifier.js');
    const result = await verifyPublishedPackage({
      packageRoot: process.cwd(), tag: candidate.distTag, expectedIntegrity: candidate.artifact.integrity
    });
    const observation = {
      kind: 'canonical-installed-observation', candidateDigest: canonicalDigest(candidate),
      result, completedAt: new Date().toISOString(),
      producerAuthentication: 'requires-independent-current-run-readback'
    };
    const target = path.join(env.LIFTOFF_RELEASE_BUNDLE, 'canonical-observation.json');
    await writeFile(target, `${JSON.stringify(observation, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return observation;
  }
  const feasibility = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'publisher-feasibility.json'), 'utf8'));
  const readiness = releaseReadiness(candidate, feasibility, {
    event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    sourceSha: env.GITHUB_SHA, dryRun: env.LIFTOFF_RELEASE_DRY_RUN === 'true'
  });
  if (args[0] === 'readiness') {
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'publication-authorized=false\n');
    console.log(JSON.stringify(readiness, null, 2));
    if (env.LIFTOFF_RELEASE_DRY_RUN !== 'true') throw new Error('Publication blocked: genuine producer and publisher-authority adapters are not qualified.');
    return readiness;
  }
  // There is intentionally no live transport, credential fallback, token
  // enrollment, or candidate-supplied trusted-context JSON deserialization.
  // The pure phase APIs are exercised only by fake transports until separately
  // qualified producers and authenticated readback adapters can be connected.
  throw new Error(`Release ${args[0]} blocked: authenticated production adapters are not installed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error('Release coordination blocked: invalid inputs or unqualified production evidence/authority. No fallback publication is permitted.');
    process.exitCode = 1;
  }
}
