import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export const minimumNativeMacosVersion = '13.5';

/** @type {Readonly<{ entries: number, depth: number, fileBytes: number, totalBytes: number }>} */
export const nativeBundleLimits = Object.freeze({
  entries: 20_000,
  depth: 32,
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024
});

export const nativeBundleCases = Object.freeze([
  'binds native Apple Silicon and minimum macOS qualification before installed behavior',
  'runs actual help, version and capabilities through direct and linked launchers with an empty PATH',
  'runs every existing installed planning contract without global Node/npm or framework tools',
  'keeps installed live assessment help project-independent and tool-free',
  'assesses explicit local and unbound live projects without global tools or project/user-state changes',
  'initializes and validates real Manual/no-agent Go output using external Go, never private Node as a toolchain',
  'still probes and requires external Node/npm for a selected Node workload before writing a project',
  'requires an explicitly selected Manual agent without adding a framework or external Node requirement',
  'executes the installed isolated HCL parser and resolves the controller from the installed boundary',
  'refuses missing template, controller and HCL material without borrowing checkout or global assets',
  'rejects edited release claims, runtime pins, package identity and license inventories',
  'rejects non-executable and changed private runtime bytes even with a recomputed inventory'
]);

export function assertNativeBundleReport(report) {
  assert.equal(report.success, true, 'Native qualification did not succeed.');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  const files = report.testResults.filter(file =>
    file.name.replaceAll('\\', '/').endsWith('/tests/native-bundle-installed.test.ts'));
  assert.equal(files.length, 1, 'Native qualification report must contain exactly one installed suite.');
  const cases = files[0].assertionResults;
  assert.deepEqual(cases.map(test => test.title).sort(), [...nativeBundleCases].sort(),
    'Native qualification cases are missing, duplicated or unexpected.');
  assert.ok(cases.every(test => test.status === 'passed'), 'Native qualification cannot contain skipped or failed cases.');
  return { cases: cases.length, passed: cases.length };
}

function numericVersion(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string.`);
  assert.match(value, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/, `${label} is invalid.`);
  return value.split('.').map(Number);
}

function compareNumericVersions(left, right) {
  const a = numericVersion(left, 'Observed macOS version');
  const b = numericVersion(right, 'Minimum macOS version');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function hostCommand(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 65_536
  });
  assert.equal(result.error, undefined, `Native host inspection failed: ${result.error?.message ?? executable}`);
  return result;
}

function observedNativeMacosHost() {
  assert.equal(process.platform, 'darwin', 'This development bundle requires qualified native Apple Silicon macOS.');
  const version = hostCommand('/usr/bin/sw_vers', ['-productVersion']);
  assert.equal(version.status, 0, `Cannot determine the macOS release: ${version.stderr}`);
  const translation = hostCommand('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']);
  if (translation.status !== 0) {
    assert.notEqual(process.arch, 'arm64',
      `Cannot determine whether the Apple Silicon process is translated: ${translation.stderr}`);
  }
  const translated = translation.status === 0 ? translation.stdout.trim() : '0';
  assert.ok(['0', '1'].includes(translated), 'The macOS translation observation is invalid.');
  return {
    platform: process.platform,
    architecture: process.arch,
    operatingSystemVersion: version.stdout.trim(),
    translated: translated === '1'
  };
}

export function nativeBundleHost(observation = observedNativeMacosHost(),
  minimumOperatingSystemVersion = minimumNativeMacosVersion) {
  assert.ok(observation && typeof observation === 'object', 'Native host observation is required.');
  assert.equal(observation.platform, 'darwin',
    'This development bundle requires qualified native Apple Silicon macOS.');
  assert.equal(typeof observation.translated, 'boolean', 'The macOS translation state must be observed.');
  assert.equal(observation.translated, false,
    'Translated or emulated macOS execution is not qualified for this development bundle.');
  assert.equal(observation.architecture, 'arm64',
    'Intel macOS is not qualified for this development bundle.');
  numericVersion(minimumOperatingSystemVersion, 'Minimum macOS version');
  numericVersion(observation.operatingSystemVersion, 'Observed macOS version');
  assert.ok(compareNumericVersions(observation.operatingSystemVersion, minimumOperatingSystemVersion) >= 0,
    `macOS ${minimumOperatingSystemVersion} or newer is required; observed ${observation.operatingSystemVersion}.`);
  return {
    platform: observation.platform,
    architecture: observation.architecture,
    operatingSystemVersion: observation.operatingSystemVersion,
    translated: false,
    minimumOperatingSystemVersion
  };
}

export function assertNativeRuntimeArchitectures(output) {
  assert.equal(typeof output, 'string');
  const architectures = output.trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(architectures, ['arm64'],
    'The private runtime must be a thin native Apple Silicon Mach-O executable.');
  return architectures;
}

export function assertNativeRuntimeBuildVersion(output,
  minimumOperatingSystemVersion = minimumNativeMacosVersion) {
  assert.equal(typeof output, 'string');
  const blocks = output.split(/(?=Load command \d+\n)/)
    .filter(block => /^\s*cmd LC_BUILD_VERSION\s*$/m.test(block));
  assert.equal(blocks.length, 1, 'The private runtime must contain one LC_BUILD_VERSION command.');
  const block = blocks[0];
  const field = name => new RegExp(`^\\s*${name}\\s+(\\S+)\\s*$`, 'm').exec(block)?.[1];
  const platformCode = field('platform');
  const minimumMacosVersion = field('minos');
  const sdkVersion = field('sdk');
  assert.equal(platformCode, '1', 'The private runtime LC_BUILD_VERSION platform must be macOS.');
  assert.equal(minimumMacosVersion, minimumOperatingSystemVersion,
    'The private runtime minimum macOS version differs from release policy.');
  numericVersion(sdkVersion, 'Runtime build SDK version');
  return {
    format: 'Mach-O',
    architectures: ['arm64'],
    platform: 'macos',
    platformCode: 1,
    minimumMacosVersion,
    sdkVersion
  };
}

export function assertPortableProductionDependencies(files) {
  assert.ok(Array.isArray(files), 'Production dependency files are required.');
  const nativeMagic = new Set([
    'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe',
    'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', '7f454c46'
  ]);
  const native = files.flatMap(file => {
    const record = typeof file === 'string' ? { path: file, header: '' } : file;
    const name = bundlePath(record.path);
    assert.match(record.header ?? '', /^(?:[a-f0-9]{2}){0,4}$/,
      'Production dependency header evidence is invalid.');
    const extension = /\.(?:node|dylib|dll|exe|so(?:\.\d+)*)$/i.test(name);
    const magic = nativeMagic.has(record.header) || record.header?.startsWith('4d5a');
    return extension || magic ? [name] : [];
  });
  assert.deepEqual(native, [],
    'The production dependency closure contains an unqualified native addon or library.');
  return { nativeAddons: [] };
}

export function bundlePath(value) {
  assert.equal(typeof value, 'string', 'Bundle path must be a string.');
  assert.ok(value.length > 0 && value.length <= 1024, 'Bundle path is empty or oversized.');
  for (const part of value.split('/')) {
    assert.ok(part && part !== '.' && part !== '..' &&
      !/[\\:*?"<>|\u0000-\u001f]/.test(part) && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    `Bundle path is not portable: ${value}`);
  }
  return value;
}

function contained(root, target) {
  const relative = path.relative(root, target);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative), 'Bundle link escapes its installed boundary.');
}

export async function bundleFile(file, maximum = nativeBundleLimits.fileBytes) {
  const before = await lstat(file);
  assert.ok(before.isFile() && before.nlink === 1, `Bundle input must be a single-link regular file: ${file}`);
  assert.ok(before.size <= maximum, `Bundle input exceeds its byte limit: ${file}`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[key], before[key], `Bundle input changed before opening: ${file}`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, before.size)));
    let bytes = 0;
    while (bytes < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - bytes), bytes);
      assert.ok(result.bytesRead > 0, `Bundle input changed during reading: ${file}`);
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    for (const observed of [after, current]) {
      for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs']) {
        assert.equal(observed[key], before[key], `Bundle input changed during reading: ${file}`);
      }
    }
    return { bytes, sha256: hash.digest('hex'), mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function bundleInventory(directory, limits = nativeBundleLimits) {
  assert.ok((await lstat(directory)).isDirectory(), 'Bundle root must be a directory, not a link.');
  const root = await realpath(directory);
  const entries = [];
  const aliases = new Set();
  let totalBytes = 0;
  async function visit(parts) {
    assert.ok(parts.length <= limits.depth, 'Bundle exceeds its depth limit.');
    const names = (await readdir(path.join(root, ...parts))).sort();
    for (const name of names) {
      if (parts.length === 0 && name === 'bundle.json') continue;
      const relative = bundlePath([...parts, name].join('/'));
      const alias = relative.normalize('NFC').toLowerCase();
      assert.ok(!aliases.has(alias), `Case or Unicode alias in bundle: ${relative}`);
      aliases.add(alias);
      assert.ok(aliases.size <= limits.entries, 'Bundle exceeds its entry limit.');
      const file = path.join(root, ...parts, name);
      const stat = await lstat(file);
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
        await visit([...parts, name]);
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(file);
        assert.ok(!path.isAbsolute(target) && !target.includes('\\') && !/[\u0000-\u001f]/.test(target),
          `Bundle link must have a relative portable target: ${relative}`);
        contained(root, path.resolve(path.dirname(file), target));
        contained(root, await realpath(file));
        entries.push({ path: relative, kind: 'symlink', target });
      } else {
        const identity = await bundleFile(file, limits.fileBytes);
        totalBytes += identity.bytes;
        assert.ok(totalBytes <= limits.totalBytes, 'Bundle exceeds its total byte limit.');
        entries.push({ path: relative, kind: 'file', ...identity });
      }
    }
  }
  await visit([]);
  return {
    entries,
    totalBytes,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  };
}

export function assertSystemRuntimeLibraries(output) {
  assert.equal(typeof output, 'string');
  const libraries = output.trim().split('\n').slice(1).map(line => {
    const match = /^\s+(\S+) \(compatibility version /.exec(line);
    assert.ok(match, 'Unrecognized runtime library inspection output.');
    const name = match[1];
    assert.ok(name.startsWith('/usr/lib/') || name.startsWith('/System/Library/Frameworks/'),
      `Native runtime still requires a non-system library: ${name}`);
    assert.ok(!name.split('/').includes('..'), 'Runtime library path contains traversal.');
    return name;
  });
  assert.ok(libraries.includes('/usr/lib/libSystem.B.dylib'), 'Runtime system-library evidence is incomplete.');
  return libraries;
}

export function assertDependencyClosure(installed, lock) {
  assert.equal(installed.lockfileVersion, 3, 'Installed dependency inventory must use lockfile version 3.');
  assert.equal(lock.lockfileVersion, 3, 'Source dependency lock must use version 3.');
  assert.ok(installed.packages && lock.packages, 'Dependency inventories are missing.');
  const rows = [];
  for (const name of Object.keys(installed.packages).sort()) {
    bundlePath(name);
    assert.ok(name.startsWith('node_modules/'), 'Dependency inventory contains a non-package path.');
    const actual = installed.packages[name];
    const expected = lock.packages[name];
    assert.ok(expected && !expected.dev && !actual.dev && !actual.link && !expected.link,
      `Unexpected, development-only or linked dependency: ${name}`);
    for (const key of ['version', 'integrity']) {
      assert.equal(typeof expected[key], 'string', `Locked dependency lacks ${key}: ${name}`);
      assert.equal(actual[key], expected[key], `Installed dependency ${key} differs from its lock: ${name}`);
    }
    assert.match(actual.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Dependency integrity must be SHA-512.');
    const integrityBytes = Buffer.from(actual.integrity.slice(7), 'base64');
    assert.ok(integrityBytes.length === 64 && `sha512-${integrityBytes.toString('base64')}` === actual.integrity,
      'Dependency integrity must be a canonical SHA-512 digest.');
    // npm may omit resolved and use its configured registry; retain that distinction.
    assert.equal(actual.resolved, expected.resolved, `Installed dependency resolved differs from its lock: ${name}`);
    if (expected.resolved !== undefined) {
      assert.equal(typeof expected.resolved, 'string', 'Locked dependency locator must be a string.');
      const url = new URL(actual.resolved);
      assert.ok(url.protocol === 'https:' && !url.username && !url.password,
        'Locked dependency must use a credential-free HTTPS artifact.');
    }
    rows.push({ path: name, version: actual.version, integrity: actual.integrity });
  }
  assert.ok(rows.length > 0, 'Production dependency closure is empty.');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name && !entry.dev && !entry.optional && !entry.devOptional) {
      assert.ok(installed.packages[name], `Required production dependency is absent: ${name}`);
    }
  }
  return rows;
}
