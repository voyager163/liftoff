#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  coverageMetrics,
  verifyCoverageEvidence
} from './coverage-gate.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedOutcomes = [
  ['toolchain', 'NATIVE_TOOLCHAIN_OUTCOME'],
  ['cleanStart', 'NATIVE_CLEAN_START_OUTCOME'],
  ['supportedStack', 'NATIVE_SUPPORTED_STACK_OUTCOME'],
  ['build', 'NATIVE_BUILD_OUTCOME'],
  ['fullSuite', 'NATIVE_FULL_SUITE_OUTCOME'],
  ['coverage', 'NATIVE_COVERAGE_OUTCOME'],
  ['coverageVerification', 'NATIVE_COVERAGE_VERIFY_OUTCOME'],
  ['focused', 'NATIVE_FOCUSED_OUTCOME'],
  ['packageSmoke', 'NATIVE_PACKAGE_OUTCOME'],
  ['repositoryPolicy', 'NATIVE_POLICY_OUTCOME'],
  ['openspec', 'NATIVE_OPENSPEC_OUTCOME'],
  ['cleanFinish', 'NATIVE_CLEAN_FINISH_OUTCOME']
];

export const nativeCustodyQualificationCommands = Object.freeze({
  supportedStack: 'npm run check:supported-stack',
  build: 'npm run build -- --pretty false',
  fullSuite: 'npm test -- --maxWorkers=1 --no-file-parallelism --reporter=dot',
  coverage: 'npm run coverage:cli -- --max-workers 1',
  coverageVerification: 'node scripts/coverage-gate.mjs verify cli',
  packageSmoke: 'npm run smoke:package',
  repositoryPolicy: 'npm run check:repository',
  openspec: 'openspec validate modernize-liftoff-platform --strict --no-interactive',
  cleanFinish: 'git diff --check and clean git status'
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function defaultExecute(executable, args) {
  return execFileSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000
  }).trim();
}

async function optionalText(file, readText) {
  try {
    return await readText(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseJson(text, label, failures) {
  if (text === undefined) {
    failures.push(`Missing ${label}.`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`${label} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function observedTool(execute, executable, args, failures) {
  try {
    return execute(executable, args);
  } catch (error) {
    failures.push(`Unable to read ${executable} version: ${error.message}`);
    return null;
  }
}

export async function createNativeCustodyQualificationEvidence({
  root = repositoryRoot,
  env = process.env,
  runtime = {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node
  },
  execute = defaultExecute,
  readText = readFile,
  verify = () => verifyCoverageEvidence('cli', { root }),
  generatedAt = () => new Date().toISOString()
} = {}) {
  const failures = [];
  const gates = {};
  for (const [name, variable] of expectedOutcomes) {
    const outcome = env[variable] ?? 'missing';
    gates[name] = outcome;
    if (outcome !== 'success') failures.push(`${name} gate outcome was ${outcome}, not success.`);
  }

  const expectedRevision = env.GITHUB_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
    failures.push(`GITHUB_SHA is not an exact commit identity: ${JSON.stringify(expectedRevision)}.`);
  }
  if (runtime.platform !== 'darwin' || runtime.architecture !== 'arm64' || runtime.node !== '24.21.0') {
    failures.push(
      `Hosted native runtime was ${runtime.platform}/${runtime.architecture}/Node${runtime.node}; ` +
      'expected darwin/arm64/Node24.21.0.'
    );
  }

  const npm = observedTool(execute, 'npm', ['--version'], failures);
  const opentofu = observedTool(execute, 'tofu', ['version'], failures);
  const openspec = observedTool(execute, 'openspec', ['--version'], failures);
  const go = observedTool(execute, 'go', ['version'], failures);
  const python = observedTool(execute, 'python', ['--version'], failures);
  const uv = observedTool(execute, 'uv', ['--version'], failures);
  if (npm !== '12.0.2') failures.push(`npm was ${JSON.stringify(npm)}; expected 12.0.2.`);
  if (!/^OpenTofu v1\.12\.6(?:\n|$)/.test(opentofu ?? '')) {
    failures.push(`OpenTofu was ${JSON.stringify(opentofu)}; expected 1.12.6.`);
  }
  if (openspec !== '1.11.0') failures.push(`OpenSpec was ${JSON.stringify(openspec)}; expected 1.11.0.`);
  if (!/^go version go1\.27\.0 darwin\/arm64$/.test(go ?? '')) {
    failures.push(`Go was ${JSON.stringify(go)}; expected go1.27.0 darwin/arm64.`);
  }
  if (python !== 'Python 3.14.7') failures.push(`Python was ${JSON.stringify(python)}; expected 3.14.7.`);
  if (!/^uv 0\.12\.7(?:\s|$)/.test(uv ?? '')) failures.push(`uv was ${JSON.stringify(uv)}; expected 0.12.7.`);

  const coveragePath = path.join(root, 'coverage', 'cli', 'coverage-evidence.json');
  const coverageText = await optionalText(coveragePath, readText);
  const coverage = parseJson(coverageText, 'coverage/cli/coverage-evidence.json', failures);
  if (coverage) {
    if (coverage.result !== 'passed' || coverage.qualifying !== true) {
      failures.push('Coverage evidence does not record a passing qualifying gate.');
    }
    if (!Array.isArray(coverage.failures) || coverage.failures.length !== 0) {
      failures.push('Coverage evidence does not record an empty failure list.');
    }
    if (coverage.revision?.commit !== expectedRevision || coverage.revision?.dirty !== false) {
      failures.push('Coverage evidence is not bound to the exact clean dispatched revision.');
    }
    if (coverage.invocation?.host?.platform !== 'darwin' || coverage.invocation?.host?.arch !== 'arm64') {
      failures.push('Coverage evidence did not run on native macOS ARM64.');
    }
    if (coverage.tools?.node !== 'v24.21.0' || coverage.tools?.npm !== '12.0.2') {
      failures.push('Coverage evidence does not record Node 24.21.0 and npm 12.0.2.');
    }
    if ((coverage.tests?.failed ?? -1) !== 0 || (coverage.tests?.files ?? 0) <= 0) {
      failures.push('Coverage evidence does not record a complete zero-failure test run.');
    }
    if ((coverage.sourceInventory?.fileCount ?? 0) <= 0 || !coverage.sourceInventory?.digest) {
      failures.push('Coverage evidence lacks a nonempty source inventory and digest.');
    }
    for (const metric of coverageMetrics) {
      const value = coverage.metrics?.[metric];
      if (!value || !Number.isInteger(value.covered) || !Number.isInteger(value.total) ||
          value.total <= 0 || value.covered * 100 <= value.total * 80 || value.passed !== true) {
        failures.push(`Coverage metric ${metric} is not strictly above 80%.`);
      }
    }
  }

  let verification;
  try {
    verification = await verify();
    if (verification.result !== 'passed' || verification.failures.length !== 0) {
      failures.push(`Independent coverage verification failed: ${verification.failures.join('; ')}`);
    }
  } catch (error) {
    failures.push(`Independent coverage verification could not run: ${error.message}`);
  }

  const fullSuiteLog = await optionalText(path.join(root, 'qualification', 'native-full-suite.log'), readText);
  const coverageLog = await optionalText(path.join(root, 'qualification', 'native-coverage.log'), readText);
  if (!fullSuiteLog) failures.push('Missing or empty native full-suite log.');
  if (!coverageLog) failures.push('Missing or empty native coverage log.');

  return {
    schemaVersion: 1,
    kind: 'liftoff-hosted-native-custody-qualification',
    result: failures.length === 0 ? 'passed' : 'failed',
    failures,
    generatedAt: generatedAt(),
    repository: env.GITHUB_REPOSITORY ?? null,
    revision: {
      commit: expectedRevision || null,
      ref: env.GITHUB_REF ?? null,
      clean: coverage?.revision?.dirty === false
    },
    workflow: {
      runId: env.GITHUB_RUN_ID ?? null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      workflow: env.GITHUB_WORKFLOW ?? null
    },
    host: runtime,
    tools: {
      npm,
      opentofu,
      openspec,
      go,
      python,
      uv
    },
    gates,
    commands: nativeCustodyQualificationCommands,
    coverage: coverage ? {
      evidenceSha256: sha256(coverageText),
      sourceInventory: coverage.sourceInventory,
      testInventory: coverage.testInventory,
      tests: coverage.tests,
      metrics: coverage.metrics,
      verification
    } : null,
    logs: {
      fullSuite: fullSuiteLog ? { bytes: Buffer.byteLength(fullSuiteLog), sha256: sha256(fullSuiteLog) } : null,
      coverage: coverageLog ? { bytes: Buffer.byteLength(coverageLog), sha256: sha256(coverageLog) } : null
    },
    claims: {
      hostedNativeMacosArm64: runtime.platform === 'darwin' && runtime.architecture === 'arm64',
      macbookRetroactiveQualification: false,
      productionCustodyQualification: false,
      disposableAzureQualification: false
    }
  };
}

async function main() {
  const [operation, output = 'qualification/native-custody.json'] = process.argv.slice(2);
  if (operation !== 'record') {
    throw new Error('Usage: node scripts/native-custody-qualification.mjs record [output-file]');
  }
  const evidence = await createNativeCustodyQualificationEvidence();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Hosted native custody qualification evidence: ${evidence.result.toUpperCase()}`);
  for (const failure of evidence.failures) console.error(`- ${failure}`);
  if (evidence.result !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Hosted native custody qualification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
