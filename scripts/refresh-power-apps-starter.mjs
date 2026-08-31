#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/microsoft/PowerAppsCodeApps';
const STARTER_PATH = 'templates/starter';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedStack = JSON.parse(
  await readFile(path.join(repositoryRoot, 'assets', 'supported-stack.json'), 'utf8')
);
const NPM_VERSION = supportedStack.packageManagers.npm.version;
const NODE_RELEASE_LINE = supportedStack.runtimes.node.releaseLine;
const assetsRoot = path.join(repositoryRoot, 'assets', 'power-apps-code-app');
const catalogsPath = path.join(repositoryRoot, 'src', 'catalogs.ts');
const assetReadmePath = path.join(assetsRoot, 'README.md');
const requestedCommit = process.argv[2]?.toLowerCase();
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!requestedCommit || !COMMIT_PATTERN.test(requestedCommit)) {
  throw new Error(
    'Usage: npm run refresh:power-apps-starter -- <40-character immutable commit SHA>'
  );
}
if (process.versions.node.split('.')[0] !== NODE_RELEASE_LINE) {
  throw new Error(
    `Run the Power Apps starter refresh with the supported Node.js ${NODE_RELEASE_LINE} baseline.`
  );
}
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    'Run the Power Apps starter refresh on Linux x64 so npm generates the canonical cross-platform lockfile.'
  );
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function assertSuccess(result, description) {
  if (result.status !== 0) {
    throw new Error(
      `${description} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`.trimEnd()
    );
  }
}

function isExcluded(relativePath) {
  const parts = relativePath.split('/');
  const base = parts.at(-1) ?? '';
  return parts.some((part) => [
    '.git',
    '.cache',
    '.parcel-cache',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'node_modules'
  ].includes(part)) ||
    base === 'package-lock.json' ||
    base === 'power.config.json' ||
    base === '.env' ||
    base.startsWith('.env.');
}

function logicalNameFor(relativePath, previousNames) {
  const existing = previousNames.get(relativePath);
  if (existing) {
    return existing;
  }
  if (relativePath === '.gitignore') {
    return 'power-apps-gitignore';
  }
  if (relativePath === 'package.json') {
    return 'power-apps-package';
  }
  if (relativePath === 'package-lock.json') {
    return 'power-apps-lock';
  }
  return `power-apps-starter-${relativePath.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

async function copyStarterFiles(sourceRoot, destinationRoot) {
  const copied = [];

  async function visit(currentSource, relativeDirectory = '') {
    const entries = await readdir(currentSource, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (isExcluded(relativePath)) {
        continue;
      }
      const sourcePath = path.join(currentSource, entry.name);
      const details = await lstat(sourcePath);
      if (details.isSymbolicLink()) {
        throw new Error(`Refusing starter symlink: ${relativePath}`);
      }
      if (details.isDirectory()) {
        await visit(sourcePath, relativePath);
        continue;
      }
      if (!details.isFile()) {
        throw new Error(`Refusing non-regular starter entry: ${relativePath}`);
      }
      const bytes = await readFile(sourcePath);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const destinationPath = path.join(destinationRoot, ...relativePath.split('/'));
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      copied.push(relativePath);
    }
  }

  await visit(sourceRoot);
  return copied;
}

async function readPreviousCatalog() {
  const catalogsSource = await readFile(catalogsPath, 'utf8');
  const selectedCommit = catalogsSource.match(
    /powerAppsCodeAppStarter[\s\S]*?commit: '([0-9a-f]{40})'/
  )?.[1];
  if (!selectedCommit) {
    throw new Error('Unable to resolve the selected Power Apps starter commit.');
  }
  const catalog = JSON.parse(
    await readFile(path.join(assetsRoot, selectedCommit, 'catalog.json'), 'utf8')
  );
  return {
    commit: catalog.source.commit,
    starterRoot: path.join(assetsRoot, selectedCommit, 'starter'),
    names: new Map(
      catalog.files.map((file) => [file.pathParts.join('/'), file.logicalName])
    )
  };
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-power-apps-refresh-'));
try {
  const previous = await readPreviousCatalog();
  const archiveUrl =
    `https://codeload.github.com/microsoft/PowerAppsCodeApps/tar.gz/${requestedCommit}`;
  const response = await fetch(archiveUrl, {
    headers: { 'User-Agent': 'mission-control-liftoff-maintainer' },
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`Unable to download ${archiveUrl}: HTTP ${response.status}`);
  }
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const archivePath = path.join(tempRoot, 'source.tar.gz');
  const extractRoot = path.join(tempRoot, 'source');
  await writeFile(archivePath, archiveBytes);
  await mkdir(extractRoot);
  assertSuccess(
    run('tar', ['-xzf', archivePath, '-C', extractRoot]),
    'Extracting the immutable upstream archive'
  );

  const extractedDirectories = await readdir(extractRoot);
  if (
    extractedDirectories.length !== 1 ||
    !extractedDirectories[0].endsWith(requestedCommit)
  ) {
    throw new Error('The upstream archive did not contain one repository root.');
  }
  const upstreamRoot = path.join(extractRoot, extractedDirectories[0]);
  const upstreamStarter = path.join(upstreamRoot, ...STARTER_PATH.split('/'));
  const upstreamLicense = await readFile(path.join(upstreamRoot, 'LICENSE'));
  if (!upstreamLicense.toString('utf8').includes('MIT License')) {
    throw new Error('The upstream repository license is no longer the expected MIT license.');
  }

  const stagedRoot = path.join(tempRoot, requestedCommit);
  const stagedStarter = path.join(stagedRoot, 'starter');
  await mkdir(stagedStarter, { recursive: true });
  const copied = await copyStarterFiles(upstreamStarter, stagedStarter);
  if (!copied.includes('package.json')) {
    throw new Error('The upstream starter does not contain package.json.');
  }

  assertSuccess(
    run(npmExecutable, [
      'exec',
      '--yes',
      `--package=npm@${NPM_VERSION}`,
      '--',
      'npm',
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund'
    ], { cwd: stagedStarter }),
    `Generating package-lock.json with npm ${NPM_VERSION}`
  );
  copied.push('package-lock.json');
  copied.sort();
  await writeFile(path.join(stagedRoot, 'UPSTREAM_LICENSE.txt'), upstreamLicense);

  const packageJson = JSON.parse(await readFile(path.join(stagedStarter, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(
    await readFile(path.join(stagedStarter, 'package-lock.json'), 'utf8')
  );
  if (
    packageLock.name !== packageJson.name ||
    packageLock.packages?.['']?.name !== packageJson.name
  ) {
    throw new Error('Generated package-lock.json does not match the starter package identity.');
  }

  const files = [];
  const logicalNames = new Set();
  for (const relativePath of copied) {
    const bytes = await readFile(path.join(stagedStarter, ...relativePath.split('/')));
    const logicalName = logicalNameFor(relativePath, previous.names);
    if (logicalNames.has(logicalName)) {
      throw new Error(`Generated duplicate logical artifact name: ${logicalName}`);
    }
    logicalNames.add(logicalName);
    const assetPath = relativePath === '.gitignore'
      ? 'packaged/gitignore'
      : `starter/${relativePath}`;
    if (relativePath === '.gitignore') {
      const packagedPath = path.join(stagedRoot, ...assetPath.split('/'));
      await mkdir(path.dirname(packagedPath), { recursive: true });
      await writeFile(packagedPath, bytes);
    }
    files.push({
      logicalName,
      pathParts: relativePath.split('/'),
      assetPath,
      sha256: sha256(bytes),
      provenance: relativePath === 'package-lock.json' ? 'generated-lockfile' : 'upstream'
    });
  }
  const catalog = {
    schemaVersion: 1,
    source: {
      repository: REPOSITORY,
      path: STARTER_PATH,
      commit: requestedCommit,
      archiveSha256: sha256(archiveBytes)
    },
    license: {
      spdx: 'MIT',
      assetPath: 'UPSTREAM_LICENSE.txt',
      sha256: sha256(upstreamLicense)
    },
    lockfile: {
      nodeBaseline: `${NODE_RELEASE_LINE}.x`,
      npmVersion: NPM_VERSION,
      sha256: files.find((file) => file.pathParts.join('/') === 'package-lock.json').sha256
    },
    files
  };
  await writeFile(path.join(stagedRoot, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);

  const diff = run('git', [
    '--no-pager',
    'diff',
    '--no-index',
    '--',
    previous.starterRoot,
    stagedStarter
  ]);
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(`Unable to show starter diff\n${diff.stderr ?? ''}`);
  }
  process.stdout.write(diff.stdout || 'No starter source changes.\n');

  const finalRoot = path.join(assetsRoot, requestedCommit);
  try {
    await lstat(finalRoot);
    throw new Error(`Asset destination already exists: ${finalRoot}`);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  await rename(stagedRoot, finalRoot);

  const catalogsSource = await readFile(catalogsPath, 'utf8');
  const previousLiteral = `commit: '${previous.commit}'`;
  if (!catalogsSource.includes(previousLiteral)) {
    throw new Error('Unable to locate the previous starter commit in src/catalogs.ts.');
  }
  await writeFile(
    catalogsPath,
    catalogsSource.replace(previousLiteral, `commit: '${requestedCommit}'`)
  );
  const assetReadme = await readFile(assetReadmePath, 'utf8');
  await writeFile(
    assetReadmePath,
    assetReadme.replace(`Commit: \`${previous.commit}\``, `Commit: \`${requestedCommit}\``)
  );

  console.log(`\nRefreshed ${files.length} starter files from ${requestedCommit}.`);
  console.log('Review the diff, update commit-specific tests, then run npm run verify:power-apps-starter.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
