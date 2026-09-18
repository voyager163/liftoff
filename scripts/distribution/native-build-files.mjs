import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../release-evidence.mjs';
import { REQUIRED_PUBLIC_DOCUMENTS, validateDocumentShippingEntries } from './native-document-links.mjs';

export const REQUIRED_ASSET_ROOTS = ['assets/locks', 'assets/governance', 'assets/repair', 'assets/skills', 'assets/templates', 'assets/profiles', 'assets/distribution'];
export const REQUIRED_BUILD_HELPERS = [
  'scripts/release-evidence.mjs', 'scripts/release-evidence-github.mjs',
  'scripts/release-telemetry-gateway.mjs', 'scripts/release-evidence-archive.py'
];
export const BUILD_OWNER_FILE = '.liftoff-native-build-owner.json';

export function demand(condition, message) {
  if (!condition) throw new Error(message);
}

export function regularRoot(root) {
  const absolute = path.resolve(root);
  const stat = fs.lstatSync(absolute);
  demand(stat.isDirectory() && !stat.isSymbolicLink(), `Build root is not a real directory: ${absolute}`);
  demand(fs.realpathSync(absolute) === absolute, `Build root has linked ancestors: ${absolute}`);
  return absolute;
}

export function relativeName(value) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !path.isAbsolute(value) && !/[\\:\u0000-\u001f]/.test(value), 'Build paths must be exact relative filesystem names');
  demand(value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe or ambiguous native build path');
  return value;
}

export function confinedPath(root, relative, { createParents = false, leafMustBeAbsent = false } = {}) {
  relativeName(relative);
  let current = regularRoot(root);
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const names = fs.readdirSync(current);
    const aliases = names.filter((name) => name.normalize('NFC').toLowerCase() === part.normalize('NFC').toLowerCase());
    demand(aliases.length <= 1 && (!aliases.length || aliases[0] === part), `Case/Unicode alias in build destination: ${relative}`);
    current = path.join(current, part);
    const last = index === parts.length - 1;
    if (last && leafMustBeAbsent) {
      demand(!fs.existsSync(current) && aliases.length === 0, `Output already exists; build will not overwrite or merge it: ${relative}`);
      return current;
    }
    if (!fs.existsSync(current) && createParents && !last) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    demand(!stat.isSymbolicLink() && (last || stat.isDirectory()), `Linked or non-directory build path: ${relative}`);
  }
  return current;
}

export function fileIdentity(file, maximum = 256 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  demand(before.isFile() && !before.isSymbolicLink() && before.size <= maximum, `Required build input is not a bounded regular file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    demand(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, `Input changed before reading: ${file}`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, bytes));
    const after = fs.fstatSync(fd);
    demand(opened.dev === after.dev && opened.ino === after.ino && opened.size === after.size &&
      opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs, `Input changed while reading: ${file}`);
    return { sha256: hash.digest('hex'), size: opened.size, mode: opened.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

export function inventoryTree(root, { maximumFiles = 16384, maximumBytes = 1024 * 1024 * 1024 } = {}) {
  regularRoot(root);
  const result = [];
  const seen = new Set();
  let bytes = 0;
  const walk = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      relativeName(relative);
      const canonical = relative.normalize('NFC').toLowerCase();
      demand(!seen.has(canonical), `Case/Unicode-colliding build input: ${relative}`);
      seen.add(canonical);
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      demand(!stat.isSymbolicLink(), `Linked build input is forbidden: ${relative}`);
      if (stat.isDirectory()) walk(full, relative);
      else {
        const identity = fileIdentity(full);
        bytes += identity.size;
        result.push({ path: relative, ...identity });
        demand(result.length <= maximumFiles && bytes <= maximumBytes, 'Native source/payload inventory exceeds declared bounds');
      }
    }
  };
  walk(root, '');
  return result;
}

export function writeNew(file, value, mode = 0o600) {
  fs.writeFileSync(file, value, { flag: 'wx', mode });
}

export function writeJson(file, value) {
  writeNew(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function createOwnedOutput(projectRoot, output) {
  const absolute = path.resolve(projectRoot, output);
  const relative = path.relative(projectRoot, absolute).split(path.sep).join('/');
  demand(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), 'Native build output must be a new descendant of the explicit project root');
  const destination = confinedPath(projectRoot, relative, { createParents: true, leafMustBeAbsent: true });
  fs.mkdirSync(destination, { mode: 0o700 });
  const stat = fs.lstatSync(destination);
  const owner = { schemaVersion: 1, id: randomUUID(), device: stat.dev, inode: stat.ino };
  writeJson(path.join(destination, BUILD_OWNER_FILE), owner);
  return { root: destination, owner };
}

export function assertOwnedOutput(output) {
  const root = regularRoot(output.root);
  const stat = fs.lstatSync(root);
  const file = path.join(root, BUILD_OWNER_FILE);
  fileIdentity(file, 4096);
  const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  demand(stat.dev === output.owner.device && stat.ino === output.owner.inode && owner.id === output.owner.id,
    'Native output ownership changed; refusing mutation or cleanup');
}

export function copyInventoriedFile(sourceRoot, targetRoot, record) {
  const source = confinedPath(sourceRoot, record.path);
  const destination = confinedPath(targetRoot, record.path, { createParents: true, leafMustBeAbsent: true });
  const before = fileIdentity(source);
  demand(before.sha256 === record.sha256 && before.mode === record.mode && before.size === record.size, `Source changed after selection: ${record.path}`);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, record.mode & 0o111 ? 0o755 : 0o644);
  demand(fileIdentity(destination).sha256 === record.sha256 && fileIdentity(source).sha256 === record.sha256, `Source changed while copying: ${record.path}`);
}

export function readSourceIdentity(projectRoot) {
  const read = (relative) => JSON.parse(fs.readFileSync(confinedPath(projectRoot, relative), 'utf8'));
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  demand(pkg.name === '@msn-control/liftoff' && /^\d+\.\d+\.\d+$/.test(pkg.version), 'Native builds require the canonical source package and explicit stable candidate version');
  demand(lock.name === pkg.name && lock.version === pkg.version && lock.packages?.['']?.name === pkg.name &&
    lock.packages[''].version === pkg.version && lock.lockfileVersion === 3, 'Source package and root lock identity disagree');
  demand(pkg.license === 'GPL-3.0-only' && pkg.repository?.url === 'git+https://github.com/voyager163/liftoff.git', 'Native source repository/license identity is not canonical');
  demand(canonicalJson(pkg.dependencies ?? {}) === canonicalJson(lock.packages[''].dependencies ?? {}) &&
    canonicalJson(pkg.devDependencies ?? {}) === canonicalJson(lock.packages[''].devDependencies ?? {}), 'Source dependency manifest and lockfile disagree');
  demand(pkg.bin?.liftoff === 'dist/cli.js' && pkg.type === 'module', 'Native build requires the canonical ESM CLI entrypoint');
  const required = ['dist', ...REQUIRED_ASSET_ROOTS, 'assets/supported-stack.json', 'docs', ...REQUIRED_PUBLIC_DOCUMENTS, 'LICENSE'];
  demand(Array.isArray(pkg.files) && required.every((entry) => pkg.files.includes(entry)), 'Source package files inventory omits a required native resource/documentation surface');
  validateDocumentShippingEntries(pkg.files);
  for (const entry of pkg.files) {
    relativeName(entry);
    demand(!/[*?{}[\]]/.test(entry) && entry !== 'assets' && entry !== 'node_modules' && entry !== 'runtime' && !entry.startsWith('assets/qualification'), 'Source shipping inventory must use exact runtime paths, not whole assets, globs, operational evidence, runtime overrides or ambient node_modules');
  }
  return { pkg, lock };
}

export function captureSource(projectRoot, snapshotRoot) {
  const { pkg, lock } = readSourceIdentity(projectRoot);
  const selections = [...new Set(['src', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/distribution', ...REQUIRED_BUILD_HELPERS,
    ...pkg.files.filter((entry) => entry !== 'dist')])];
  const records = new Map();
  for (const selection of selections) {
    const full = confinedPath(projectRoot, selection);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      const children = inventoryTree(full);
      demand(children.length > 0, `Required source directory is empty: ${selection}`);
      for (const child of children) records.set(`${selection}/${child.path}`, { ...child, path: `${selection}/${child.path}` });
    } else records.set(selection, { path: selection, ...fileIdentity(full) });
  }
  const files = [...records.values()].sort((a, b) => a.path.localeCompare(b.path));
  const aliases = files.map((file) => file.path.normalize('NFC').toLowerCase());
  demand(new Set(aliases).size === aliases.length, 'Selected source inputs collide under native case normalization');
  for (const file of files) copyInventoriedFile(projectRoot, snapshotRoot, file);
  for (const selection of selections) {
    const full = confinedPath(projectRoot, selection);
    const current = fs.lstatSync(full).isDirectory()
      ? inventoryTree(full).map((file) => ({ ...file, path: `${selection}/${file.path}` }))
      : [{ path: selection, ...fileIdentity(full) }];
    const original = files.filter((file) => file.path === selection || file.path.startsWith(`${selection}/`));
    demand(canonicalJson(current.sort((a, b) => a.path.localeCompare(b.path))) === canonicalJson(original), `Source changed while snapshotting: ${selection}`);
  }
  return { pkg, lock, files, treeSha256: sha256(canonicalJson(files)) };
}

export function cleanBuildEnvironment(workRoot, additions = {}) {
  const home = path.join(workRoot, 'home');
  const temp = path.join(workRoot, 'temp');
  const cache = path.join(workRoot, 'npm-cache');
  for (const directory of [home, temp, cache]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = path.join(workRoot, 'empty-user.npmrc');
  const globalConfig = path.join(workRoot, 'empty-global.npmrc');
  for (const file of [config, globalConfig]) if (!fs.existsSync(file)) writeNew(file, '');
  const inherited = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE|HTTPS_PROXY|HTTP_PROXY|NO_PROXY)$/i.test(key)) {
      const name = process.platform === 'win32' ? key.toUpperCase() : key;
      demand(!Object.hasOwn(inherited, name), 'Ambiguous build environment aliases');
      inherited[name] = value;
    }
  }
  return {
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
    ...inherited, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: cache, TMPDIR: temp, TMP: temp, TEMP: temp,
    CI: 'true', LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1', GOMAXPROCS: '2',
    npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_cache: cache,
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true', npm_config_bin_links: 'false', ...additions
  };
}

export async function runBuildCommand(executable, args, { cwd, env, timeout = 180_000, maxBuffer = 1024 * 1024, label }) {
  demand(path.isAbsolute(executable), 'Build subprocesses require an explicitly resolved executable');
  const identity = fileIdentity(executable);
  const module = await import(new URL('../../dist/process-runner.js', import.meta.url).href);
  const result = await new module.NodeCommandRunner().run({ executable, args }, {
    cwd, env, timeoutMs: timeout, maxOutputBytes: maxBuffer, ensureProcessTreeSettled: true, stream: false
  });
  demand(fileIdentity(executable).sha256 === identity.sha256, `${label} executable changed during execution`);
  demand(result.status === 0 && result.signal === null && result.timedOut === false && result.processTreeSettled === true &&
    !result.errorCode && !result.errorMessage && !result.outputLimitExceeded && !result.aborted,
  `${label} failed (${result.errorCode ?? result.signal ?? result.status}; processTreeSettled=${result.processTreeSettled}): ${String(result.stderr ?? '').slice(-6000)}`);
  return result.stdout;
}

export function findExternalExecutable(name, projectRoot) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate);
    const relative = path.relative(projectRoot, real);
    demand(relative.startsWith('..') || path.isAbsolute(relative), `Build tool ${name} resolves inside project-controlled scope`);
    fileIdentity(real);
    return real;
  }
  throw new Error(`Missing verified existing ${name} build tool`);
}

export function verifyDependencyTree(root, lock, target) {
  const [os, arch] = target.split('-');
  const supports = (values, actual) => !values || values.includes('any') ||
    !values.includes(`!${actual}`) && (values.every((value) => value.startsWith('!')) || values.includes(actual));
  const packages = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith('node_modules/') || entry.dev === true) continue;
    demand(!entry.link && typeof entry.integrity === 'string' && /^(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/=]+$/.test(entry.integrity), `Runtime dependency lacks locked registry integrity: ${relative}`);
    const expected = supports(entry.os, os) && supports(entry.cpu, arch) && supports(entry.libc, 'glibc');
    if (!expected && entry.optional === true) continue;
    demand(expected, `Required runtime dependency does not support ${target}: ${relative}`);
    const manifest = JSON.parse(fs.readFileSync(confinedPath(root, `${relative}/package.json`), 'utf8'));
    const name = relative.split('node_modules/').at(-1);
    demand(manifest.name === (entry.name ?? name) && manifest.version === entry.version, `Installed runtime dependency differs from lock: ${relative}`);
    packages.push({ path: relative, name: manifest.name, version: manifest.version, integrity: entry.integrity, license: manifest.license ?? null });
  }
  demand(packages.length > 0, 'Runtime dependency closure is empty');
  return packages;
}

export function compilerLockSubset(source) {
  const names = ['typescript', '@types/node', '@types/cross-spawn'];
  const dependencies = {};
  const selected = new Map();
  const resolve = (from, name) => {
    let current = from;
    while (current) {
      const candidate = `${current}/node_modules/${name}`;
      if (Object.hasOwn(source.lock.packages, candidate)) return candidate;
      const index = current.lastIndexOf('/node_modules/');
      current = index === -1 ? '' : current.slice(0, index);
    }
    const top = `node_modules/${name}`;
    return Object.hasOwn(source.lock.packages, top) ? top : undefined;
  };
  const queue = [];
  for (const name of names) {
    const entry = source.lock.packages[`node_modules/${name}`];
    demand(entry?.version, `Missing locked contributor compiler dependency: ${name}`);
    dependencies[name] = entry.version;
    queue.push(`node_modules/${name}`);
  }
  while (queue.length) {
    const key = queue.shift();
    if (selected.has(key)) continue;
    const original = source.lock.packages[key];
    demand(original && !original.link && original.integrity, `Compiler dependency is not locked to registry bytes: ${key}`);
    const entry = { ...original };
    delete entry.dev;
    delete entry.devOptional;
    selected.set(key, entry);
    for (const name of new Set([...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {})])) {
      const resolved = resolve(key, name);
      if (!resolved) {
        demand(Object.hasOwn(entry.optionalDependencies ?? {}, name) || entry.peerDependenciesMeta?.[name]?.optional === true,
          `Locked compiler dependency is missing: ${key} -> ${name}`);
        continue;
      }
      queue.push(resolved);
    }
  }
  const pkg = { name: 'liftoff-contributor-build-tools', version: source.pkg.version, private: true, dependencies };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: pkg.name, version: pkg.version, dependencies }, ...Object.fromEntries(selected) } };
  return { pkg, lock };
}

export function seedLockedPublicCache(lock, sourceCache, destinationCache) {
  const source = regularRoot(sourceCache);
  const destination = regularRoot(destinationCache);
  demand(source !== destination, 'A read-only source cache cannot be the build write cache');
  const copied = new Set();
  let bytes = 0;
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || !entry.integrity || copied.has(entry.integrity)) continue;
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(entry.integrity);
    demand(match, `Unsupported locked cache integrity: ${name}`);
    const hex = Buffer.from(match[2], 'base64').toString('hex');
    const relative = `_cacache/content-v2/${match[1]}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`;
    const candidate = path.join(source, relative);
    if (!fs.existsSync(candidate)) continue;
    confinedPath(source, relative);
    const identity = fileIdentity(candidate);
    const content = fs.readFileSync(candidate);
    demand(createHash(match[1]).update(content).digest('base64') === match[2], `Cached package tarball does not match the exact source lock: ${name}`);
    const target = confinedPath(destination, relative, { createParents: true, leafMustBeAbsent: true });
    writeNew(target, content, 0o444);
    demand(fileIdentity(target).sha256 === identity.sha256 && fileIdentity(candidate).sha256 === identity.sha256, `Locked cache bytes changed while staging: ${name}`);
    copied.add(entry.integrity);
    bytes += identity.size;
    demand(bytes <= 1024 * 1024 * 1024, 'Locked public cache inputs exceed the build byte bound');
  }
  return { source: 'explicit-read-only-content-cache', tarballs: copied.size, bytes };
}

export function makeReadOnly(root) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      demand(!stat.isSymbolicLink(), 'Cannot finalize linked native payload bytes');
      if (stat.isDirectory()) walk(file);
      else fs.chmodSync(file, stat.mode & 0o111 ? 0o555 : 0o444);
    }
    fs.chmodSync(directory, 0o555);
  };
  walk(root);
}
