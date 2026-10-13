#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
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

export const nativeContainerToolProfile = Object.freeze({
  docker: Object.freeze({
    version: '29.8.2',
    build: '7fc2dff',
    archiveUrl: 'https://download.docker.com/mac/static/stable/aarch64/docker-29.8.2.tgz',
    archiveSha256: '5ffa2bafbabe073470f0333f4a129599230b73d1170bb61146b3d9b08e1d1325',
    binarySha256: 'b95f15a2e7c6a13c17b8af361a2797981bc858a87a1537c38cfa117a0c5009e1'
  }),
  compose: Object.freeze({
    version: '5.5.1',
    binaryUrl: 'https://github.com/docker/compose/releases/download/v5.5.1/docker-compose-darwin-aarch64',
    binarySha256: '998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5'
  })
});

export const qualifiedOpenSpecProfile = Object.freeze({
  kind: 'liftoff-qualified-openspec-content-profile',
  schemaVersion: 1,
  package: '@fission-ai/openspec',
  version: '1.11.0',
  registryCutoff: '2026-09-26T23:59:59Z',
  counts: Object.freeze({
    files: 2590,
    directories: 299,
    symlinks: 2,
    totalBytes: 11862860
  }),
  digest: 'sha256:05d52efd0875c1ff0c1bd0aec13f7128a4baab787ea6b31f33fa7360cd53bde2'
});

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

function ordered(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function captureQualifiedOpenSpecProfile(root, expected = qualifiedOpenSpecProfile) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !expected?.counts) {
    throw new Error('Qualified OpenSpec profile requires an absolute package root and expected bounds.');
  }
  const canonicalRoot = await realpath(root);
  const entries = [];
  const counts = { files: 0, directories: 0, symlinks: 0, totalBytes: 0 };
  let packageMetadata;

  async function walk(absolute, parts = []) {
    const relative = parts.join('/');
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) {
      if (++counts.symlinks > expected.counts.symlinks) throw new Error('Qualified OpenSpec symlink bound exceeded.');
      const target = await readlink(absolute);
      if (path.isAbsolute(target) || path.win32.isAbsolute(target) ||
          !inside(canonicalRoot, path.resolve(path.dirname(absolute), target))) {
        throw new Error('Qualified OpenSpec profile contains an escaping symlink.');
      }
      entries.push({ path: relative, type: 'link', target });
      return;
    }
    if (stat.isDirectory()) {
      if (++counts.directories > expected.counts.directories) throw new Error('Qualified OpenSpec directory bound exceeded.');
      entries.push({ path: relative, type: 'directory' });
      const names = [];
      for await (const entry of await opendir(absolute)) names.push(entry.name);
      names.sort(ordered);
      for (const name of names) await walk(path.join(absolute, name), [...parts, name]);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Qualified OpenSpec profile contains a special or hard-linked file.');
    if (++counts.files > expected.counts.files || stat.size > BigInt(expected.counts.totalBytes) ||
        BigInt(counts.totalBytes) + stat.size > BigInt(expected.counts.totalBytes)) {
      throw new Error('Qualified OpenSpec file or byte bound exceeded.');
    }
    const content = await readFile(absolute);
    counts.totalBytes += content.length;
    entries.push({
      path: relative,
      type: 'file',
      mode: Number(stat.mode & 0o777n),
      bytes: content.length,
      sha256: sha256(content)
    });
    if (relative === 'package.json') packageMetadata = JSON.parse(content.toString('utf8'));
  }

  await walk(canonicalRoot);
  if (packageMetadata?.name !== expected.package || packageMetadata?.version !== expected.version) {
    throw new Error('Qualified OpenSpec package identity changed.');
  }
  const identity = {
    kind: expected.kind,
    schemaVersion: expected.schemaVersion,
    package: packageMetadata.name,
    version: packageMetadata.version,
    counts,
    entries
  };
  return {
    kind: identity.kind,
    schemaVersion: identity.schemaVersion,
    package: identity.package,
    version: identity.version,
    counts,
    digest: `sha256:${sha256(JSON.stringify(identity))}`
  };
}

export async function verifyQualifiedOpenSpecProfile(root, expected = qualifiedOpenSpecProfile) {
  const first = await captureQualifiedOpenSpecProfile(root, expected);
  const second = await captureQualifiedOpenSpecProfile(root, expected);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('Qualified OpenSpec distribution changed between complete scans.');
  }
  const expectedContent = {
    kind: expected.kind,
    schemaVersion: expected.schemaVersion,
    package: expected.package,
    version: expected.version,
    counts: expected.counts,
    digest: expected.digest
  };
  if (JSON.stringify(first) !== JSON.stringify(expectedContent)) {
    throw new Error('Qualified OpenSpec distribution content profile mismatch.');
  }
  return { ...first, registryCutoff: expected.registryCutoff };
}

function defaultExecute(executable, args) {
  return execFileSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000
  }).trim();
}

async function defaultVerifyOpenSpecProfile() {
  const launcher = await realpath(defaultExecute('/usr/bin/which', ['openspec']));
  return verifyQualifiedOpenSpecProfile(path.dirname(path.dirname(launcher)));
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
  verifyOpenSpecProfile = defaultVerifyOpenSpecProfile,
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
  const docker = observedTool(execute, 'docker', ['--version'], failures);
  const composeExecutable = env.NATIVE_COMPOSE_EXECUTABLE ?? '';
  let compose = null;
  if (!path.isAbsolute(composeExecutable)) {
    failures.push(`NATIVE_COMPOSE_EXECUTABLE is not an absolute path: ${JSON.stringify(composeExecutable)}.`);
  } else {
    compose = observedTool(execute, composeExecutable, ['version', '--short'], failures);
  }
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
  if (docker !== `Docker version ${nativeContainerToolProfile.docker.version}, build ${nativeContainerToolProfile.docker.build}`) {
    failures.push(`Docker was ${JSON.stringify(docker)}; expected ${nativeContainerToolProfile.docker.version}.`);
  }
  if (compose !== nativeContainerToolProfile.compose.version) {
    failures.push(`Docker Compose was ${JSON.stringify(compose)}; expected ${nativeContainerToolProfile.compose.version}.`);
  }

  let openspecDistribution = null;
  try {
    openspecDistribution = await verifyOpenSpecProfile();
  } catch (error) {
    failures.push(`Qualified OpenSpec distribution verification failed: ${error.message}`);
  }

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
      uv,
      docker,
      compose,
      composeExecutable: composeExecutable || null,
      containerProfile: nativeContainerToolProfile,
      openspecDistribution
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
  const [operation, argument] = process.argv.slice(2);
  if (operation === 'verify-openspec-profile') {
    if (!argument) throw new Error('Usage: node scripts/native-custody-qualification.mjs verify-openspec-profile <package-root>');
    const profile = await verifyQualifiedOpenSpecProfile(path.resolve(argument));
    console.log(`Qualified OpenSpec content profile: ${profile.digest}`);
    return;
  }
  if (operation !== 'record') {
    throw new Error('Usage: node scripts/native-custody-qualification.mjs record [output-file]');
  }
  const output = argument ?? 'qualification/native-custody.json';
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
