import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { assertNativeHost, observeNativeHost } from '/liftoff/installation/host.mjs';
import { bundleFile, bundleInventory } from '/liftoff/installation/native-bundle-contract.mjs';
import { installOwnedBundle, inspectOwnedInstallation, recoverOwnedInstallation } from '/liftoff/installation/native-install.mjs';
import { hclComputationPolicy, parseIsolatedHcl } from '/liftoff/application/dist/adapters/hcl/isolated-parser.js';
import { verifyWindowsJobControllerAsset } from '/liftoff/application/dist/adapters/process/windows-job-runner.js';

const expected = JSON.parse(await readFile('/guest-input.json', 'utf8'));
const kernelVersion = expected.kernelVersion ?? '4.18.20', accelerator = expected.accelerator ?? 'tcg';
assert.ok(['4.18.0', '4.18.20'].includes(kernelVersion));
assert.ok(['tcg', 'hvf', 'kvm'].includes(accelerator));
assert.ok(accelerator !== 'hvf' || expected.architecture === 'arm64');
assert.ok(accelerator !== 'kvm' || expected.architecture === 'x64');
assert.equal(process.getuid(), 1000);
assert.equal(process.getgid(), 1000);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile('/liftoff/bundle.json');
const manifest = JSON.parse(manifestBytes);
assert.equal(digest(manifestBytes), expected.manifestSha256);
assert.equal(manifest.source.commit, expected.commit);
assert.equal(manifest.source.dirty, false);
assert.deepEqual(manifest.platform, { platform: 'linux', architecture: expected.architecture });
assert.equal(manifest.inventory.sha256, expected.inventorySha256);
const observed = observeNativeHost();
assert.equal(observed.platform, 'linux');
assert.equal(observed.architecture, expected.architecture);
assert.equal(observed.osVersion, kernelVersion);
assert.equal(observed.glibcVersion, '2.28');
assert.equal(observed.runtimeVersion, '24.21.0');
assert.equal(os.release(), observed.osVersion);
assertNativeHost(observed);
assert.throws(() => assertNativeHost(observed, { publicInstallation: true }), /minimum host/);
assert.deepEqual(await bundleInventory('/liftoff'), manifest.inventory);
const mounts = (await readFile('/proc/mounts', 'utf8')).split('\n').map(line => line.split(' '));
const tmpfs = mounts.find(row => row[1] === '/tmp');
assert.equal(tmpfs?.[2], 'tmpfs');
for (const option of ['rw', 'nosuid', 'nodev']) assert.ok(tmpfs[3].split(',').includes(option));
assert.ok(!tmpfs[3].split(',').includes('noexec'));
assert.ok(mounts.find(row => row[1] === '/liftoff')?.[3].split(',').includes('ro'));
await mkdir('/tmp/home');
await mkdir('/tmp/foreign cwd');
const invoke = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: '/tmp/foreign cwd', env: process.env, shell: false,
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
const version = invoke('/liftoff/bin/liftoff', ['--version']).trim();
assert.equal(version, 'Liftoff ' + manifest.package.version);
assert.ok(invoke('/liftoff/bin/liftoff', ['--help']).includes('liftoff'));
const capabilities = JSON.parse(invoke('/liftoff/bin/liftoff', ['capabilities', '--json']));
assert.equal(capabilities.runtime.nativeDistribution, false);
const libraries = invoke('/usr/bin/rpm', ['-q', '--qf', '%{NAME}:%{VERSION}-%{RELEASE}.%{ARCH}\n',
  'glibc', 'libstdc++']).trim().split('\n');
assert.ok(libraries.some(value => value.startsWith('glibc:2.28-')));
assert.ok(libraries.some(value => value.startsWith('libstdc++:8.5.0-')));
const plans = expected.plans.map(plan => ({
  id: plan.id, stdout: invoke('/liftoff/bin/liftoff', ['plan', ...plan.args])
}));
const parsedHcl = await parseIsolatedHcl([
  'locals { enabled = true }\n', 'locals { policy = file("./policy.json") }\n'
]);
const hcl = {
  policyVersion: hclComputationPolicy.version, protocolVersion: hclComputationPolicy.protocolVersion,
  parsed: parsedHcl.map(result => result.parsed), expressionCounts: parsedHcl.map(result => result.expressions.size),
  fileExpressionType: parsedHcl[1]?.expressions.get('${file("./policy.json")}')?.type
};
assert.deepEqual(hcl, { policyVersion: 3, protocolVersion: 2,
  parsed: [{ locals: [{ enabled: true }] }, { locals: [{ policy: '${file("./policy.json")}' }] }],
  expressionCounts: [1, 1], fileExpressionType: 'template' });
assert.equal(await verifyWindowsJobControllerAsset(),
  '/liftoff/application/assets/repair/windows-job-controller.ps1');
const prefix = '/tmp/private-prefix';
await mkdir(prefix, { mode: 0o700 });
await assert.rejects(installOwnedBundle({
  source: '/liftoff', prefix, expectedManifestSha256: expected.manifestSha256,
  expectedCurrent: null, development: true,
  admitHost: () => assertNativeHost(observeNativeHost()), interruptAt: 'after-switch'
}), /Interrupted/);
assert.ok((await inspectOwnedInstallation(prefix)).startsWith('versions/' + manifest.package.version + '-'));
assert.equal(invoke(prefix + '/bin/liftoff', ['--version']).trim(), version);
await recoverOwnedInstallation({
  prefix, expectedJournalSha256: (await bundleFile(prefix + '/.native-install-transaction.json')).sha256
});
assert.equal(await inspectOwnedInstallation(prefix), null);
assert.deepEqual(await bundleInventory('/liftoff'), manifest.inventory);
assert.equal(digest(await readFile('/liftoff/bundle.json')), expected.manifestSha256);
const report = {
  kind: 'liftoff-linux-kernel-guest-probe', schemaVersion: 2, observed, version, libraries, plans, hcl,
  manifestSha256: expected.manifestSha256, commit: expected.commit,
  inventorySha256: manifest.inventory.sha256, uid: process.getuid(), gid: process.getgid(),
  bundleReadOnly: true, kernelExecution: true, emulated: accelerator === 'tcg', developmentInstallRecovered: true,
  controllerResolved: true, hclExecuted: true, hclQualifiedRuntimeRefused: false,
  publicInstallationRefused: true, minimumHostQualified: false, publicDistributionQualified: false
};
const encoded = gzipSync(JSON.stringify(report), { level: 9 }).toString('base64');
assert.ok(encoded.length <= 7168, 'Guest report exceeds the bounded serial frame.');
console.log('LIFTOFF_GUEST_REPORT_GZIP=' + encoded);
