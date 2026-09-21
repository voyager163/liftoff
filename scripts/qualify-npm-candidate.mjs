#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { devNull, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { verifyReleaseIdentity } from '../dist/release-identity.js';
import { canonicalNpmRegistry, npmRegistryOverrideArgs } from '../dist/package-identity.js';
import { artifactHashes, parseNpmCandidate, verifyCandidateBytes } from './repository-security/npm-release.ts';
import { canonicalDigest } from './repository-security/admission.ts';
import { parseIdentity, portableParts } from './repository-security/evidence.ts';
import { createLocalPackageRecords } from './repository-security/npm-release-records.ts';
import { assessPackedNpmRuntime } from './repository-security/npm-runtime.ts';
import { assessPackedPythonGoTemplates, inspectPackedTemplateComponents, packedTemplateSbom, resolvePackedGoComponents } from './repository-security/packed-template-inventory.ts';
import { assessPackedNpmTemplates } from './repository-security/packed-template-audit.ts';

/** @typedef {import('./repository-security/npm-release.ts').NpmCandidate} NpmCandidate */

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd, env, shell: false, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024
  });
  // Do not echo arbitrary subprocess output (which can contain local credentials).
  if (result.status !== 0 || result.error) {
    if (args[0]?.endsWith('package-smoke-test.mjs')) {
      throw new Error('Exact-tarball smoke failed. The existing smoke runner must support --tarball; implicit npm repacking is forbidden.');
    }
    throw new Error(`Candidate subprocess failed: ${path.basename(command)} (${result.status ?? 'unavailable'}).`);
  }
  return result.stdout;
}

async function boundedBytes(file, maximum) {
  const status = await lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > maximum) throw new Error('Candidate file is not a bounded regular file.');
  const bytes = await readFile(file);
  if (bytes.length > maximum) throw new Error('Candidate file exceeds size limit.');
  return bytes;
}

async function sourceSnapshot(root, execute, env) {
  const environmentValue = name => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name];
  const gitEnv = Object.fromEntries(['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP']
    .map(name => [name, environmentValue(name)]).filter(([, value]) => typeof value === 'string'));
  Object.assign(gitEnv, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: devNull
  });
  const git = args => execute('git', args, root, gitEnv);
  if (await realpath(git(['rev-parse', '--show-toplevel']).trim()) !== root) {
    throw new Error('Source inventory does not belong to the selected checkout.');
  }
  const commit = git(['rev-parse', 'HEAD']).trim();
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const trackedNames = new Set(git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean));
  if (!names.length || names.length > 20_000 || new Set(names).size !== names.length) throw new Error('Invalid source inventory.');
  const entries = [];
  let total = 0;
  for (const name of names.sort()) {
    const parts = portableParts(name.split('/'));
    const file = path.join(root, ...parts);
    let status;
    try { status = await lstat(file); } catch (error) {
      if (error.code === 'ENOENT' && trackedNames.has(name)) { entries.push([name, 'deleted']); continue; }
      throw error;
    }
    if (!status.isFile() || status.isSymbolicLink() || status.size > 16 * 1024 * 1024) throw new Error('Unsafe source inventory entry.');
    if (await realpath(file) !== file) throw new Error('Source inventory traverses a symlink.');
    const bytes = await readFile(file);
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw new Error('Source inventory exceeds size limit.');
    entries.push([name, status.mode & 0o111, `sha256:${createHash('sha256').update(bytes).digest('hex')}`]);
  }
  const built = [];
  async function visit(parts) {
    const directory = path.join(root, ...parts);
    if (await realpath(directory) !== directory) throw new Error('Build input traverses a symlink.');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const child = portableParts([...parts, entry.name]);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const bytes = await boundedBytes(path.join(root, ...child), 16 * 1024 * 1024);
        total += bytes.length;
        if (built.length >= 20_000 || total > 256 * 1024 * 1024) throw new Error('Build inputs exceed size limit.');
        built.push([child.join('/'), `sha256:${createHash('sha256').update(bytes).digest('hex')}`]);
      } else throw new Error('Unsafe build input.');
    }
  }
  await visit(['dist']);
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']).trim().length > 0;
  if (git(['rev-parse', 'HEAD']).trim() !== commit) throw new Error('Source changed during inspection.');
  return { commit, tree, inputsDigest: canonicalDigest({ entries, built }), dirty };
}

/**
 * Builds nothing and packs exactly once. Existing build/identity/smoke checks are
 * reused; this local descriptor is NOT scanner evidence or protected-source proof.
 * The returned exact registered root is retained for the coordinator to consume.
 *
 * @param {{packageRoot: string, npmCliPath: string, releaseTag?: string, outputParent?: string, assessRuntime?: boolean, goPath?: string, assessTemplates?: boolean, pythonPath?: string}} options
 * @param {{run?: typeof run}} dependencies Command injection is for deterministic tests only.
 * @returns {Promise<{root: string, tarballPath: string, descriptorPath: string, descriptor: NpmCandidate}>}
 */
export async function packNpmCandidate(options, dependencies = {}) {
  const root = await realpath(options.packageRoot);
  if (!path.isAbsolute(options.npmCliPath) || !(await lstat(options.npmCliPath)).isFile()) throw new Error('An explicit npm CLI file is required.');
  if (options.assessTemplates === true && (!options.goPath || !path.isAbsolute(options.goPath))) {
    throw new Error('Exact packed-template assessment requires an explicit absolute Go tool path.');
  }
  if (options.assessTemplates === true && (options.assessRuntime !== true || !options.pythonPath || !path.isAbsolute(options.pythonPath))) {
    throw new Error('Packed template vulnerability assessment requires runtime assessment and an explicit absolute Python tool path.');
  }
  const execute = dependencies.run ?? run;
  const identity = await verifyReleaseIdentity({ packageRoot: root, ...(options.releaseTag ? { releaseTag: options.releaseTag } : {}) });
  const outputParent = await realpath(options.outputParent ?? process.env.RUNNER_TEMP ?? tmpdir());
  const relative = path.relative(root, outputParent);
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    throw new Error('Candidate output parent must be outside the source checkout.');
  }
  const candidateRoot = await mkdtemp(path.join(outputParent, 'liftoff-release-candidate-'));
  const rootStat = await lstat(candidateRoot);
  const scratch = path.join(candidateRoot, 'local-checks');
  let succeeded = false;
  try {
    await mkdir(scratch);
    const home = path.join(scratch, 'home');
    await mkdir(home);
    const runtime = path.join(scratch, 'runtime');
    await mkdir(runtime);
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, LIFTOFF_TELEMETRY: '0',
      TMPDIR: runtime, TMP: runtime, TEMP: runtime, NODE_DISABLE_COMPILE_CACHE: '1',
      XDG_STATE_HOME: path.join(home, '.local', 'state'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      npm_execpath: options.npmCliPath, npm_config_cache: path.join(scratch, 'npm-cache'),
      npm_config_userconfig: path.join(scratch, 'user.npmrc'), npm_config_globalconfig: path.join(scratch, 'global.npmrc'),
      npm_config_registry: canonicalNpmRegistry
    };
    const source = await sourceSnapshot(root, execute, env);
    const packOutput = JSON.parse(execute(process.execPath, [options.npmCliPath, 'pack', '--json', '--ignore-scripts',
      '--pack-destination', candidateRoot, ...npmRegistryOverrideArgs(canonicalNpmRegistry)], root, env));
    const packed = Array.isArray(packOutput) ? packOutput
      : packOutput && typeof packOutput === 'object' ? Object.values(packOutput) : [];
    if (packed.length !== 1) throw new Error('Expected exactly one npm pack result.');
    const metadata = packed[0];
    const expectedFilename = `msn-control-liftoff-${identity.version}.tgz`;
    if (metadata.filename !== expectedFilename || metadata.name !== identity.name || metadata.version !== identity.version) throw new Error('Packed package identity mismatch.');
    const tarballPath = path.join(candidateRoot, expectedFilename);
    const bytes = await boundedBytes(tarballPath, 32 * 1024 * 1024);
    const hashes = artifactHashes(bytes);
    if (metadata.integrity !== hashes.integrity || metadata.size !== bytes.length) throw new Error('npm pack bytes differ from metadata.');
    const descriptor = parseNpmCandidate({
      schemaVersion: 1, kind: 'npm-release-candidate', source,
      artifact: { name: identity.name, version: identity.version, filename: expectedFilename, size: bytes.length, ...hashes },
      releaseTag: identity.expectedTag,
      distTag: identity.version.split('+', 1)[0].includes('-') ? 'next' : 'latest',
      createdAt: new Date().toISOString()
    });
    // Old smoke runners ignore CLI arguments. Make such a runner fail closed,
    // rather than accidentally produce a second archive while claiming exactness.
    const smokeNpm = path.join(scratch, 'install-only-npm.cjs');
    await writeFile(smokeNpm, [
      "const { spawnSync } = require('node:child_process');",
      "if (process.argv[2] !== 'install') { console.error('Exact-tarball smoke forbids npm pack and publication.'); process.exit(1); }",
      `const result = spawnSync(process.execPath, [${JSON.stringify(options.npmCliPath)}, ...process.argv.slice(2), '--ignore-scripts', ...${JSON.stringify(npmRegistryOverrideArgs(canonicalNpmRegistry))}],`,
      "{ shell: false, stdio: 'inherit', env: process.env, timeout: 300000 });",
      'process.exit(result.error ? 1 : result.status ?? 1);'
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    const smokeStatus = path.join(scratch, 'smoke-status.json');
    try {
      execute(process.execPath, [path.join(root, 'scripts', 'package-smoke-test.mjs'), '--tarball', tarballPath],
        root, { ...env, npm_execpath: smokeNpm, LIFTOFF_PACKAGE_SMOKE_STATUS: smokeStatus });
    } catch {
      let status;
      try { status = JSON.parse((await boundedBytes(smokeStatus, 2048)).toString('utf8')); }
      catch { throw new Error('Exact package smoke failed before bounded diagnostic capture; implicit repacking remains forbidden and raw output withheld.'); }
      if (!status || Object.keys(status).sort().join(',') !== 'commandIndex,exit,failure,operation,schemaVersion,stage' ||
          status.schemaVersion !== 1 || !['artifact', 'installation', 'installed-artifact', 'installed-behavior'].includes(status.stage) ||
          !Number.isSafeInteger(status.commandIndex) || status.commandIndex < 0 || status.commandIndex > 1000 ||
          status.exit !== null && (!Number.isSafeInteger(status.exit) || status.exit < 0 || status.exit > 255) ||
          !['none', 'install', 'help', '--version', 'init', 'update', 'repair', 'plan', 'governance', 'upgrade', 'doctor', 'node-eval', 'other'].includes(status.operation) ||
          !['assertion', 'subprocess', 'ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS'].includes(status.failure)) {
        throw new Error('Exact package smoke produced invalid bounded diagnostics; raw output withheld.');
      }
      throw new Error(`Exact package smoke failed: ${status.stage}, command ${status.commandIndex}, operation ${status.operation}, ${status.failure}.`);
    }
    verifyCandidateBytes(descriptor, await boundedBytes(tarballPath, 32 * 1024 * 1024));
    const descriptorPath = path.join(candidateRoot, 'candidate.json');
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Neither local record is a release-evidence envelope or verified provenance.
    const records = createLocalPackageRecords(descriptor, bytes, new Date(), {
      node: process.version, platform: process.platform, architecture: process.arch
    });
    for (const [name, content] of Object.entries(records)) {
      await writeFile(path.join(candidateRoot, name), `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    if (options.assessRuntime === true) {
      const templates = inspectPackedTemplateComponents(descriptor, bytes);
      await writeFile(path.join(candidateRoot, 'template-component-inventory.json'), `${JSON.stringify(templates, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
      if (options.assessTemplates === true) {
        const go = await resolvePackedGoComponents({
          repository: root, workspaceParent: outputParent, go: options.goPath,
          candidate: descriptor, tarball: bytes, python: options.pythonPath
        });
        await writeFile(path.join(candidateRoot, 'template-go-component-inventory.json'), `${JSON.stringify(go, null, 2)}\n`,
          { flag: 'wx', mode: 0o600 });
        const templateSbom = packedTemplateSbom(descriptor, bytes, go);
        await writeFile(path.join(candidateRoot, 'template-components.cdx.json'),
          `${JSON.stringify(templateSbom, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        const identity = parseIdentity({
          repository: 'voyager163/liftoff', event: 'workflow_dispatch',
          sourceSha: descriptor.source.commit, baseSha: descriptor.source.commit, workflowSha: descriptor.source.commit,
          runId: String(Date.now()), attempt: 1,
          policyDigest: canonicalDigest('strict-local-no-exceptions-not-adopted-release-policy'),
          inventoryDigest: canonicalDigest(templateSbom),
          configurationDigest: canonicalDigest('exact-packed-python-go-native-coordinate-only-assessment')
        });
        const npm = await assessPackedNpmTemplates({
          repository: root, workspaceParent: outputParent, npmCli: options.npmCliPath, candidate: descriptor, tarball: bytes
        });
        const pythonGo = await assessPackedPythonGoTemplates({
          repository: root, workspaceParent: outputParent, python: options.pythonPath,
          candidate: descriptor, tarball: bytes, go, identity
        });
        await writeFile(path.join(candidateRoot, 'template-vulnerabilities.json'), `${JSON.stringify({
          kind: 'exact-packed-template-vulnerability-assessments', candidateDigest: canonicalDigest(descriptor),
          artifactDigest: descriptor.artifact.sha256, templateSbomDigest: canonicalDigest(templateSbom),
          npm, pythonGo, analysisComplete: npm.analysisComplete && pythonGo.analysisComplete,
          findingsPassed: npm.findingsPassed && pythonGo.findingsPassed,
          configuredReleasePolicy: 'not-adopted-by-local-preparation', producerAuthentication: false, publicationQualified: false
        }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      }
      const runtime = await assessPackedNpmRuntime({
        repository: root, workspaceParent: outputParent, npmCli: options.npmCliPath, candidate: descriptor, tarball: bytes
      });
      for (const [name, content] of [
        ['installed-runtime.cdx.json', runtime.sbom],
        ['runtime-vulnerabilities.json', runtime.vulnerabilities],
        ['runtime-assessment.json', runtime]
      ]) {
        await writeFile(path.join(candidateRoot, name), `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      }
      // The candidate persists even when findings block; release readiness must
      // consume the actual verdict, not treat preparation as security success.
    }
    verifyCandidateBytes(descriptor, await boundedBytes(tarballPath, 32 * 1024 * 1024));
    const after = await sourceSnapshot(root, execute, env);
    if (canonicalDigest(source) !== canonicalDigest(after)) throw new Error('Source/build inputs changed during candidate checks.');
    succeeded = true;
    return { root: candidateRoot, tarballPath, descriptorPath, descriptor };
  } finally {
    const current = await lstat(candidateRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootStat.dev || current.ino !== rootStat.ino) {
      throw new Error('Registered candidate root changed; cleanup refused.');
    }
    // Only roots created by this invocation are ever removed.
    await rm(succeeded ? scratch : candidateRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2 || new Set(args).size !== args.length ||
        args.some(arg => !['--runtime-assessment', '--template-assessment'].includes(arg)) ||
        args.includes('--template-assessment') && !args.includes('--runtime-assessment')) {
      throw new Error('Usage: node scripts/qualify-npm-candidate.mjs [--runtime-assessment [--template-assessment]] (npm_execpath required; full templates also require Go/Python paths; build first).');
    }
    const result = await packNpmCandidate({
      packageRoot: process.cwd(), npmCliPath: process.env.npm_execpath ?? '', assessRuntime: args.includes('--runtime-assessment'),
      goPath: process.env.LIFTOFF_RELEASE_GO, assessTemplates: args.includes('--template-assessment'),
      pythonPath: process.env.LIFTOFF_RELEASE_PYTHON
    });
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import('node:fs/promises');
      if (/[\r\n]/.test(result.root)) throw new Error('Unsafe candidate output path.');
      await appendFile(process.env.GITHUB_OUTPUT,
        `candidate-root=${result.root}\ntarball-name=${result.descriptor.artifact.filename}\ndist-tag=${result.descriptor.distTag}\n`);
    }
    console.log(JSON.stringify({
      candidate: path.relative(process.cwd(), result.descriptorPath),
      sha256: result.descriptor.artifact.sha256, integrity: result.descriptor.artifact.integrity,
      source: result.descriptor.source.dirty ? 'dirty-local-worktree' : 'committed-checkout',
      releaseQualification: 'not-established'
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate preparation failed.');
    process.exitCode = 1;
  }
}
