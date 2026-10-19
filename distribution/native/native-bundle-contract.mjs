import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

/** @type {Readonly<{ entries: number, depth: number, fileBytes: number, totalBytes: number }>} */
export const nativeBundleLimits = Object.freeze({
  entries: 20_000,
  depth: 32,
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024
});

export const nativeBundleCases = Object.freeze([
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

export function assertNativeTestReport(report) {
  assert.ok(report && typeof report === 'object' && !Array.isArray(report), 'Native qualification requires a test report.');
  assert.equal(report.success, true, 'Native qualification did not succeed.');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  assert.ok(Array.isArray(report.testResults) && report.testResults.length > 0, 'Native qualification requires test file records.');
  const actual = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
  const files = new Set();
  for (const file of report.testResults) {
    assert.ok(file && typeof file.name === 'string' && file.name.length > 0, 'Native report has an invalid test file name.');
    const name = file.name.replaceAll('\\', '/');
    assert.ok(!files.has(name), 'Native report contains duplicate test file records.');
    files.add(name);
    assert.equal(file.status, 'passed', 'Native report contains a failed or incomplete test file.');
    assert.ok(Array.isArray(file.assertionResults), 'Native test file has no assertion records.');
    for (const test of file.assertionResults) {
      actual.numTotalTests++;
      switch (test?.status) {
        case 'passed': actual.numPassedTests++; break;
        case 'failed': actual.numFailedTests++; break;
        case 'pending':
        case 'skipped': actual.numPendingTests++; break;
        case 'todo': actual.numTodoTests++; break;
        default: assert.fail('Native report contains an unsupported assertion status.');
      }
    }
  }
  assert.equal(actual.numFailedTests, 0, 'Native report contains failed assertions despite its summary.');
  assert.ok(actual.numPassedTests > 0, 'Native qualification executed no passing tests.');
  for (const [key, count] of Object.entries(actual)) {
    assert.ok(Number.isSafeInteger(report[key]) && report[key] >= 0, 'Native test counts must be nonnegative safe integers.');
    assert.equal(report[key], count, `Native report ${key} differs from its assertion records.`);
  }
}

export function assertNativeBundleReport(report) {
  assertNativeTestReport(report);
  const files = report.testResults.filter(file =>
    file.name.replaceAll('\\', '/').endsWith('/tests/native-bundle-installed.test.ts'));
  assert.equal(files.length, 1, 'Native qualification report must contain exactly one installed suite.');
  const cases = files[0].assertionResults;
  assert.deepEqual(cases.map(test => test.title).sort(), [...nativeBundleCases].sort(),
    'Native qualification cases are missing, duplicated or unexpected.');
  assert.ok(cases.every(test => test.status === 'passed'), 'Native qualification cannot contain skipped or failed cases.');
  return { cases: cases.length, passed: cases.length };
}

export function nativeBundleHost(platform = process.platform, architecture = process.arch) {
  assert.ok((platform === 'darwin' && architecture === 'arm64') ||
    (platform === 'win32' && architecture === 'x64') ||
    (platform === 'linux' && ['x64', 'arm64'].includes(architecture)),
  'Unsupported native development target; Intel macOS and translated runtimes are not qualified.');
  return { platform, architecture };
}

export function nativeRuntimeInput(inputs, host) {
  const matches = [inputs.runtime, ...inputs.additionalRuntimes].filter(input =>
    input.platform === host.platform && input.architecture === host.architecture);
  assert.equal(matches.length, 1, 'Native runtime policy must contain exactly one input for this host.');
  return matches[0];
}

export function nativeArchiveTool(platform = process.platform, windowsRoot = process.env.SystemRoot) {
  if (platform !== 'win32') {
    assert.ok(['linux', 'darwin'].includes(platform), 'Unsupported native archiving host.');
    return '/usr/bin/tar';
  }
  assert.ok(typeof windowsRoot === 'string' && /^[A-Za-z]:\\/.test(windowsRoot) &&
    path.win32.normalize(windowsRoot) === windowsRoot && !/[\u0000-\u001f]/.test(windowsRoot),
  'Native Windows archiving requires the explicit local SystemRoot.');
  return path.win32.join(windowsRoot, 'System32', 'tar.exe');
}

export function nativeArchiveMembers(output) {
  assert.equal(typeof output, 'string', 'Native archive member output must be text.');
  return output.replace(/\r?\n$/, '').split(/\r?\n/).map(bundlePath).sort();
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
  return checkedFile(file, maximum, false);
}

export async function readBundleFile(file, maximum = 8 * 1024 * 1024) {
  return checkedFile(file, maximum, true);
}

/**
 * @template {boolean} Capture
 * @param {string} file
 * @param {number} maximum
 * @param {Capture} capture
 * @returns {Promise<Capture extends true
 *   ? { identity: { bytes: number, sha256: string, mode: number }, content: Buffer }
 *   : { bytes: number, sha256: string, mode: number }>}
 */
async function checkedFile(file, maximum, capture) {
  const before = await lstat(file);
  assert.ok(before.isFile() && before.nlink === 1, `Bundle input must be a single-link regular file: ${file}`);
  assert.equal(before.mode & 0o7000, 0, 'Native material cannot have special permission bits.');
  assert.ok(before.size <= maximum, `Bundle input exceeds its byte limit: ${file}`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[key], before[key], `Bundle input changed before opening: ${file}`);
    }
    const hash = createHash('sha256');
    const chunks = [];
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, before.size)));
    let bytes = 0;
    while (bytes < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - bytes), bytes);
      assert.ok(result.bytesRead > 0, `Bundle input changed during reading: ${file}`);
      hash.update(buffer.subarray(0, result.bytesRead));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      bytes += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    for (const observed of [after, current]) {
      for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs']) {
        assert.equal(observed[key], before[key], `Bundle input changed during reading: ${file}`);
      }
    }
    const identity = { bytes, sha256: hash.digest('hex'), mode: before.mode & 0o777 };
    return capture ? { identity, content: Buffer.concat(chunks) } : identity;
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
        assert.equal(stat.mode & 0o7000, 0, 'Native directory cannot have special permission bits.');
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

export function assertLinuxRuntimeLibraries(linked, versions, floor) {
  const libraries = [];
  for (const line of linked.trim().split('\n')) {
    if (/^\s*linux-vdso\.so\.1 \(0x[a-f0-9]+\)$/.test(line)) continue;
    const match = /^\s*(?:\S+ => )?(\/\S+) \(0x[a-f0-9]+\)$/.exec(line);
    assert.ok(match, 'Missing or unrecognized Linux runtime library.');
    const name = match[1];
    assert.ok(/^\/(?:usr\/)?lib(?:64)?\//.test(name) && !name.split('/').includes('..'),
      'Linux runtime depends on a non-system library.');
    libraries.push(name);
  }
  assert.ok(libraries.some(name => name.endsWith('/libc.so.6')) &&
    libraries.some(name => name.endsWith('/libstdc++.so.6')), 'Linux system-library evidence is incomplete.');
  const needs = { GLIBC: [], GLIBCXX: [] };
  for (const match of versions.matchAll(/Name:\s+(GLIBCXX|GLIBC)_(\d+(?:\.\d+)+)\b/g)) {
    needs[match[1]].push(match[2]);
  }
  const atMost = (actual, declared) => {
    const left = actual.split('.').map(Number), right = declared.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0);
    }
    return true;
  };
  for (const [kind, declared] of [['GLIBC', floor.minimumGlibc], ['GLIBCXX', floor.minimumGlibcxx]]) {
    assert.ok(needs[kind].length > 0 && needs[kind].every(version => atMost(version, declared)),
      `Linux runtime ${kind} requirements exceed or do not establish the declared upstream floor.`);
  }
  return { linked: libraries, requiredVersions: needs };
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
