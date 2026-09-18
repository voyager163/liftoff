#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_REPOSITORY, confinedDirectory, DASHBOARD_CHECKS, EVIDENCE_KIND, HELPER_CHECKS, inspectFile,
  loadReleaseContext, loadReleaseContracts, NATIVE_CHECKS, readJsonFile, verifySourceWorktree
} from './release-evidence.mjs';
import { createGitHubEvidenceVerifier, positiveId, requireValue } from './release-evidence-github.mjs';
import { REQUIRED_REPORT_IDS } from './release-gate.mjs';
import { loadQualificationRegistry } from './release-qualification.mjs';
import { validateGatewayRegistration } from './release-telemetry-gateway.mjs';
import { validateMinimumNativeHosts } from './release-native-host.mjs';

export function parseCollectionArgs(args) {
  const [command, ...rest] = args;
  requireValue(['capture-source', 'collect'].includes(command), 'Choose capture-source or collect; neither command signs, stages, or publishes');
  requireValue(rest.length % 2 === 0, 'Every collection option requires an explicit value');
  const allowed = command === 'capture-source' ? ['--source-commit', '--output'] : ['--source-commit', '--run-id', '--run-attempt', '--artifact-id', '--output'];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    requireValue(allowed.includes(key) && !Object.hasOwn(options, key) && typeof rest[index + 1] === 'string' && rest[index + 1].length > 0, 'Unknown, duplicated, or empty collection option');
    options[key] = rest[index + 1];
  }
  requireValue(allowed.every((key) => Object.hasOwn(options, key)), `Required explicit inputs: ${allowed.join(', ')}`);
  requireValue(/^[a-f0-9]{40}$/.test(options['--source-commit']), 'source-commit must be the exact reviewed 40-character lowercase SHA, never a branch or source default');
  requireValue(/^build\/[A-Za-z0-9._/-]+$/.test(options['--output']) && options['--output'].split('/').every((part) => part !== '.' && part !== '..'), 'Output must be a confined new build/ path');
  if (command === 'collect') {
    positiveId(options['--run-id'], 'Evidence run ID');
    positiveId(options['--artifact-id'], 'Evidence artifact ID');
    requireValue(/^[1-9][0-9]?$/.test(options['--run-attempt']), 'Evidence run attempt must be an explicit number from 1 to 99');
  }
  return { command, options };
}

async function downloadArtifact(id, destination, maxBytes, projectRoot) {
  const child = spawn('gh', ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${CANONICAL_REPOSITORY}/actions/artifacts/${id}/zip`], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
  });
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('GitHub artifact download failed; no release qualification is established')));
  });
  // Never include API diagnostic payloads, tokens, or signed download URLs in public reports.
  child.stderr.resume();
  let measured = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      measured += chunk.length;
      callback(measured <= maxBytes ? null : new Error('Artifact download exceeds its registered byte bound'), chunk);
    }
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
  try {
    await Promise.all([pipeline(child.stdout, bounded, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })), ended]);
    requireValue(measured > 0, 'GitHub artifact download is empty');
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function captureSourceValidation(projectRoot, sourceCommit, output) {
  verifySourceWorktree(projectRoot, sourceCommit);
  const context = await loadReleaseContext(projectRoot, sourceCommit, await loadReleaseContracts(projectRoot, sourceCommit));
  let qualificationRegistry;
  let minimumNativeHosts;
  const registrationBlockers = [];
  try {
    qualificationRegistry = loadQualificationRegistry(context);
  } catch (error) {
    registrationBlockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    validateGatewayRegistration(context.scope.verification?.telemetryGateway);
  } catch (error) {
    registrationBlockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    minimumNativeHosts = validateMinimumNativeHosts(context);
  } catch (error) {
    registrationBlockers.push(error instanceof Error ? error.message : String(error));
  }
  const report = {
    schemaVersion: 1, kind: 'liftoff-source-validation', status: 'SOURCE_ONLY_NOT_QUALIFIED',
    product: context.scope.product, version: context.scope.candidate.version, sourceCommit,
    sourceFiles: context.sourceFiles, registryBindings: context.registryBindings, registrySha256: context.registrySha256,
    requiredEvidence: {
      schemaVersion: 1, kind: EVIDENCE_KIND, reports: REQUIRED_REPORT_IDS, cases: context.cases,
      nativeChecks: NATIVE_CHECKS, helperChecks: HELPER_CHECKS, dashboardChecks: DASHBOARD_CHECKS,
      minimumNativeHosts: minimumNativeHosts ?? null,
      qualificationRegistry: qualificationRegistry ?? null, telemetryContract: context.telemetry
    },
    releaseBlockers: [...context.implementationBlockers, ...registrationBlockers, ...(qualificationRegistry?.operationalBlockers ?? []), ...context.scope.externalQualification.releaseBlockers]
  };
  const absolute = path.resolve(projectRoot, output);
  confinedDirectory(projectRoot, path.posix.dirname(output), true);
  fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return report;
}

export async function collectReleaseEvidence(projectRoot, options) {
  const sourceCommit = options['--source-commit'];
  verifySourceWorktree(projectRoot, sourceCommit);
  const context = await loadReleaseContext(projectRoot, sourceCommit, await loadReleaseContracts(projectRoot, sourceCommit));
  const verification = context.scope.verification;
  requireValue(typeof verification?.collectionWorkflow === 'string' && verification.collectionWorkflow.length > 0, 'Missing prerequisite: registered trusted evidence-collection workflow in assets/qualification/release-scope.json; signing/publisher/live evidence must be supplied independently');
  const origin = { workflow: verification.collectionWorkflow, runId: options['--run-id'], runAttempt: Number(options['--run-attempt']) };
  const verifier = createGitHubEvidenceVerifier({ projectRoot, verification, sourceCommit });
  const verified = await verifier.verifyOrigin(origin, 'evidence-collection');
  requireValue(verified.artifact.id === Number(options['--artifact-id']), 'Requested artifact ID is not the exact registered artifact of the verified source/run attempt');
  const output = options['--output'];
  const absolute = path.resolve(projectRoot, output);
  requireValue(!fs.existsSync(absolute), 'Evidence output must not already exist; do not overwrite or merge another evidence collection');
  confinedDirectory(projectRoot, path.posix.dirname(output), true);
  fs.mkdirSync(absolute, { mode: 0o700 });
  const archiveName = '.download.zip';
  const archivePath = path.join(absolute, archiveName);
  await downloadArtifact(options['--artifact-id'], archivePath, Math.min(2 * 1024 ** 3, verified.artifact.size_in_bytes), projectRoot);
  inspectFile(absolute, archiveName, verified.artifact.digest.slice(7));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  execFileSync(python, [path.join(projectRoot, 'scripts/release-evidence-archive.py'), '--extract-evidence', archivePath, absolute], {
    cwd: projectRoot, timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  const index = readJsonFile(absolute, 'release-evidence.json');
  requireValue(index.value.schemaVersion === 1 && index.value.kind === EVIDENCE_KIND && index.value.sourceCommit === sourceCommit, 'Collected evidence index has a different schema/source identity');
  await verifier.verifyFile(index.file, origin, 'evidence-collection');
  fs.unlinkSync(archivePath);
  verifySourceWorktree(projectRoot, sourceCommit);
  return { evidencePath: `${output}/release-evidence.json`, runId: origin.runId, artifactId: options['--artifact-id'] };
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  try {
    const { command, options } = parseCollectionArgs(process.argv.slice(2));
    if (command === 'capture-source') {
      const result = await captureSourceValidation(process.cwd(), options['--source-commit'], options['--output']);
      process.stdout.write(`${result.status}: source identities and required evidence inventory captured; native/external qualification and publication remain separate.\n`);
      for (const blocker of result.releaseBlockers) process.stdout.write(`[PREREQUISITE] ${blocker}\n`);
    } else {
      const result = await collectReleaseEvidence(process.cwd(), options);
      process.stdout.write(`Collected authenticated evidence from run ${result.runId}, artifact ${result.artifactId}. Not yet qualified; run node scripts/release-gate.mjs --evidence ${result.evidencePath}\n`);
    }
  } catch (error) {
    process.stderr.write(`EVIDENCE_COLLECTION_BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
