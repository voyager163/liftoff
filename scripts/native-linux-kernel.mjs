#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { bundleFile, readBundleFile } from './native-bundle-contract.mjs';
import { verifyNativeArchiveSubjects } from './native-release.mjs';
import { nativeLinuxUserspaceImages } from './native-package-report.mjs';
import { installedPlanCases, planContractIssues } from './package-smoke-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'distribution/linux/qualification');
const digestPattern = /^[a-f0-9]{64}$/;

export function parseLinuxKernelGuestOptions(args) {
  assert.ok(args.length >= 6 && (args.length - 6) % 2 === 0,
    'Usage: native-linux-kernel.mjs <native-archive-directory> <release-manifest-sha256> <commit> <kernel-image> <kernel-sha256> <new-output> [--kernel-version 4.18.0|4.18.20] [--hvf-qemu /absolute/qemu-system-aarch64 | --kvm-qemu /absolute/qemu-system-x86_64]');
  const options = { kernelVersion: '4.18.20', accelerator: 'tcg', qemu: null };
  const seen = new Set();
  for (let index = 6; index < args.length; index += 2) {
    const [flag, value] = args.slice(index, index + 2);
    assert.ok(!seen.has(flag), 'Duplicate guest option.');
    seen.add(flag);
    if (flag === '--kernel-version') {
      assert.ok(['4.18.0', '4.18.20'].includes(value), 'Unsupported guest kernel version.');
      options.kernelVersion = value;
    } else if (flag === '--hvf-qemu' || flag === '--kvm-qemu') {
      assert.equal(options.accelerator, 'tcg', 'Hardware accelerators are mutually exclusive.');
      assert.ok(path.isAbsolute(value), `An absolute ${flag === '--hvf-qemu' ? 'HVF' : 'KVM'} QEMU executable is required.`);
      options.accelerator = flag === '--hvf-qemu' ? 'hvf' : 'kvm';
      options.qemu = value;
    } else {
      assert.fail('Unknown guest option.');
    }
  }
  return options;
}

export function assertLinuxKernelHvfHost(platform, architecture, guestArchitecture) {
  assert.ok(platform === 'darwin' && architecture === 'arm64' && guestArchitecture === 'arm64',
    'HVF requires native Apple Silicon macOS and an ARM64 guest; no emulation fallback is permitted.');
}

export function assertLinuxKernelHvfEmulator(version, accelerators) {
  assert.equal(version.split(/\r?\n/)[0], 'QEMU emulator version 11.1.2', 'HVF requires QEMU 11.1.2.');
  assert.ok(accelerators.split(/\r?\n/).includes('hvf'), 'This QEMU does not advertise HVF.');
}

export function assertLinuxKernelKvmHost(platform, architecture, guestArchitecture) {
  assert.ok(platform === 'linux' && architecture === 'x64' && guestArchitecture === 'x64',
    'KVM requires native x64 Linux and an x64 guest; no emulation fallback is permitted.');
}

export function assertLinuxKernelKvmEmulator(version, accelerators) {
  assert.match(version.split(/\r?\n/)[0],
    /^QEMU emulator version 8\.2\.2(?: \(Debian 1:8\.2\.2\+ds-0ubuntu[0-9.]+\))?$/,
    'KVM requires QEMU 8.2.2.');
  assert.ok(accelerators.split(/\r?\n/).includes('kvm'), 'This QEMU does not advertise KVM.');
}

export function linuxKernelKvmDeviceIdentity(info) {
  assert.ok(info.isCharacterDevice() && info.uid === 0n && info.nlink === 1n
    && info.rdev === 2792n && (info.mode & 0o6002n) === 0n,
  'KVM requires the root-owned, single-link, non-world-writable /dev/kvm character device (10:232).');
  return Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'rdev', 'nlink', 'mtimeNs', 'ctimeNs']
    .map(field => [field, info[field].toString()]));
}

export async function captureLinuxKernelKvmDevice() {
  assertLinuxKernelKvmHost(process.platform, process.arch, 'x64');
  const before = linuxKernelKvmDeviceIdentity(await lstat('/dev/kvm', { bigint: true }));
  const handle = await open('/dev/kvm', constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(linuxKernelKvmDeviceIdentity(await handle.stat({ bigint: true })), before,
      'KVM device changed while opening.');
    assert.deepEqual(linuxKernelKvmDeviceIdentity(await lstat('/dev/kvm', { bigint: true })), before,
      'KVM device path changed while opening.');
    return before;
  } finally {
    await handle.close();
  }
}

export function assertLinuxKernelImage(bytes, architecture) {
  assert.ok(['x64', 'arm64'].includes(architecture), 'Unsupported guest architecture.');
  if (architecture === 'arm64') {
    assert.ok(bytes.length >= 64 && bytes.readUInt32LE(56) === 0x644d5241, 'An ARM64 Linux Image is required.');
  } else {
    assert.ok(bytes.length >= 0x238 && bytes.readUInt16LE(0x1fe) === 0xaa55
      && bytes.subarray(0x202, 0x206).toString('ascii') === 'HdrS'
      && (bytes.readUInt16LE(0x236) & 1) === 1, 'A 64-bit x86 Linux bzImage is required.');
  }
}

export function assertLinuxKernelGuestTranscript(stdout, expected) {
  const kernelVersion = expected.kernelVersion ?? '4.18.20', accelerator = expected.accelerator ?? 'tcg';
  assert.ok(['4.18.0', '4.18.20'].includes(kernelVersion), 'Unsupported guest kernel version.');
  assert.ok(['tcg', 'hvf', 'kvm'].includes(accelerator), 'Unsupported guest accelerator.');
  assert.ok(accelerator !== 'hvf' || expected.architecture === 'arm64', 'HVF requires an ARM64 guest.');
  assert.ok(accelerator !== 'kvm' || expected.architecture === 'x64', 'KVM requires an x64 guest.');
  assert.match(expected.commit ?? '', /^[a-f0-9]{40}$/);
  for (const field of ['manifestSha256', 'inventorySha256']) assert.match(expected[field] ?? '', digestPattern);
  assert.ok(['x64', 'arm64'].includes(expected.architecture));
  assert.match(expected.version ?? '', /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  const lines = stdout.split(/\r?\n/);
  const prefix = 'LIFTOFF_GUEST_REPORT_GZIP=';
  const reportLines = lines.filter(line => line.startsWith(prefix));
  assert.equal(reportLines.length, 1, 'Exactly one complete guest report is required.');
  assert.deepEqual(lines.filter(line => line.startsWith('LIFTOFF_GUEST_INIT=')), ['LIFTOFF_GUEST_INIT=started']);
  assert.deepEqual(lines.filter(line => line.startsWith('LIFTOFF_GUEST_EXIT=')), ['LIFTOFF_GUEST_EXIT=0']);
  const encoded = reportLines[0].slice(prefix.length);
  assert.ok(encoded.length > 0 && encoded.length <= 7168, 'Guest serial frame exceeds its bound.');
  const compressed = Buffer.from(encoded, 'base64');
  assert.equal(compressed.toString('base64'), encoded, 'Guest serial encoding is not canonical.');
  const report = JSON.parse(gunzipSync(compressed, { maxOutputLength: 1024 * 1024 }).toString('utf8'));
  assert.equal(report.kind, 'liftoff-linux-kernel-guest-probe');
  assert.equal(report.schemaVersion, 2, 'Current guest diagnostics require actual policy3 HCL execution.');
  assert.deepEqual(report.observed, {
    platform: 'linux', architecture: expected.architecture, runtimeVersion: '24.21.0',
    osVersion: kernelVersion, nativeArchitecture: expected.architecture === 'arm64' ? 'aarch64' : 'x86_64',
    glibcVersion: '2.28'
  });
  for (const field of ['commit', 'manifestSha256', 'inventorySha256']) assert.equal(report[field], expected[field]);
  assert.equal(report.uid, 1000);
  assert.equal(report.gid, 1000);
  assert.equal(report.version, `Liftoff ${expected.version}`);
  assert.equal(report.libraries.length, 2);
  const suffix = expected.architecture === 'arm64' ? '.aarch64' : '.x86_64';
  for (const prefix of ['glibc:2.28-', 'libstdc++:8.5.0-']) {
    assert.equal(report.libraries.filter(value => value.startsWith(prefix) && value.endsWith(suffix)).length, 1);
  }
  assert.equal(report.emulated, accelerator === 'tcg', 'Guest execution mode differs.');
  for (const field of ['bundleReadOnly', 'kernelExecution', 'developmentInstallRecovered',
    'controllerResolved', 'hclExecuted', 'publicInstallationRefused']) assert.equal(report[field], true);
  for (const field of ['hclQualifiedRuntimeRefused', 'minimumHostQualified', 'publicDistributionQualified']) assert.equal(report[field], false);
  assert.deepEqual(report.hcl, { policyVersion: 3, protocolVersion: 2,
    parsed: [{ locals: [{ enabled: true }] }, { locals: [{ policy: '${file("./policy.json")}' }] }],
    expressionCounts: [1, 1], fileExpressionType: 'template' });
  assert.deepEqual(report.plans.map(plan => plan.id), installedPlanCases.map(plan => plan.id));
  for (const plan of installedPlanCases) {
    assert.deepEqual(planContractIssues(report.plans.find(item => item.id === plan.id).stdout, plan), []);
  }
  assert.match(stdout, /random: crng init done/);
  assert.match(stdout, /reboot: Power down/);
  return report;
}

export function linuxKernelGuestArguments(architecture, { accelerator = 'tcg', kernel = '/work/kernel',
  initrd = '/work/guest.cpio.gz' } = {}) {
  assert.ok(['arm64', 'x64'].includes(architecture), 'Unsupported guest architecture.');
  assert.ok(['tcg', 'hvf', 'kvm'].includes(accelerator), 'Unsupported guest accelerator.');
  assert.ok(accelerator !== 'hvf' || architecture === 'arm64', 'HVF requires an ARM64 guest.');
  assert.ok(accelerator !== 'kvm' || architecture === 'x64', 'KVM requires an x64 guest.');
  assert.ok(path.isAbsolute(kernel) && path.isAbsolute(initrd), 'Absolute guest input paths are required.');
  const hvf = accelerator === 'hvf';
  return [
    architecture === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64',
    '-machine', hvf ? 'virt-11.1,gic-version=3,highmem=off' : architecture === 'arm64' ? 'virt-8.2,gic-version=2' : 'pc-i440fx-8.2',
    '-cpu', accelerator !== 'tcg' ? 'host' : architecture === 'arm64' ? 'cortex-a72' : 'Nehalem',
    '-accel', accelerator === 'tcg' ? 'tcg,thread=multi' : accelerator, '-smp', '2', '-m', '2048',
    '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-nic', 'none', '-no-reboot',
    '-object', 'rng-random,filename=/dev/urandom,id=rng0',
    '-device', architecture === 'arm64' ? 'virtio-rng-device,rng=rng0' : 'virtio-rng-pci,rng=rng0',
    '-kernel', kernel, '-initrd', initrd,
    '-append', `console=${architecture === 'arm64' ? 'ttyAMA0' : 'ttyS0'} rdinit=/init panic=-1`
  ];
}

export function assertLinuxKernelGuestContainerIdentity(container, name, nonce, imageId) {
  assert.match(container.Id ?? '', /^[a-f0-9]{64}$/, 'Container identity is unavailable.');
  assert.equal(container.Name, `/${name}`, 'Container name differs.');
  assert.equal(container.Image, imageId, 'Container image differs.');
  assert.equal(container.Config?.Labels?.['liftoff.kernel-guest.invocation'], nonce,
    'Container is not owned by this invocation.');
}

export async function runLinuxKernelGuest(args) {
  const options = parseLinuxKernelGuestOptions(args);
  if (options.accelerator === 'kvm') assertLinuxKernelKvmHost(process.platform, process.arch, 'x64');
  assert.ok(['linux', 'darwin'].includes(process.platform) && process.getuid() > 0 && process.geteuid() > 0,
    'Use an unprivileged macOS or Linux contributor account.');
  const [archiveInput, releaseSha256, commit, kernelInput, kernelSha256, outputInput] = args;
  assert.match(kernelSha256, digestPattern, 'An independently established kernel digest is required.');
  const archive = await realpath(archiveInput), kernel = await realpath(kernelInput);
  const record = await verifyNativeArchiveSubjects(archive, releaseSha256, commit);
  assert.ok(['linux-arm64', 'linux-x64'].includes(record.target), 'A Linux development archive is required.');
  const architecture = record.target.slice('linux-'.length);
  let qemu, qemuIdentity, kvmDevice;
  if (options.accelerator !== 'tcg') {
    if (options.accelerator === 'hvf') assertLinuxKernelHvfHost(process.platform, process.arch, architecture);
    else assertLinuxKernelKvmHost(process.platform, process.arch, architecture);
    qemu = await realpath(options.qemu);
    qemuIdentity = await bundleFile(qemu, 128 * 1024 * 1024);
    assert.ok((qemuIdentity.mode & 0o111) !== 0, 'QEMU is not executable.');
    if (options.accelerator === 'kvm') kvmDevice = await captureLinuxKernelKvmDevice();
  }
  const capturedKernel = await readBundleFile(kernel, 128 * 1024 * 1024);
  assert.equal(capturedKernel.identity.sha256, kernelSha256, 'Kernel digest differs.');
  assertLinuxKernelImage(capturedKernel.content, architecture);
  const output = path.resolve(outputInput);
  const parent = await realpath(path.dirname(output));
  const relative = path.relative(root, parent);
  assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    'Guest evidence must remain outside the checkout.');
  assert.equal(path.join(parent, path.basename(output)), output, 'Output must have a physical parent.');
  assert.ok(!output.includes(','), 'Docker bind paths cannot contain commas.');
  await mkdir(output, { mode: 0o700 });
  const nonce = randomUUID();
  const tag = `liftoff-linux-kernel-guest:${nonce}`;
  const rootfsContainer = `liftoff-linux-rootfs-${nonce}`;
  const guestContainer = `liftoff-linux-guest-${nonce}`;
  const label = `liftoff.kernel-guest.invocation=${nonce}`;
  const commands = [];
  function execute(name, commandArgs, timeout = 180_000, executable = 'docker') {
    const result = spawnSync(executable, commandArgs, { shell: false, timeout, maxBuffer: 32 * 1024 * 1024,
      ...(executable === qemu ? { cwd: output, env: {
        PATH: '/usr/bin:/bin', HOME: output, TMPDIR: output, LANG: 'C', LC_ALL: 'C'
      }, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] } : {}) });
    commands.push({ name, executable, args: commandArgs, status: result.status, signal: result.signal, error: result.error?.message ?? null });
    return { result, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
  }
  async function checked(name, commandArgs, timeout, executable) {
    const captured = execute(name, commandArgs, timeout, executable);
    await writeFile(path.join(output, `${name}.stdout`), captured.stdout, { flag: 'wx' });
    await writeFile(path.join(output, `${name}.stderr`), captured.stderr, { flag: 'wx' });
    assert.equal(captured.result.error, undefined, `${name}: ${captured.result.error?.message}`);
    assert.equal(captured.result.signal, null, `${name} was interrupted.`);
    assert.equal(captured.result.status, 0, `${name}: ${captured.stderr.toString().slice(-4000)}`);
    return captured.stdout.toString('utf8');
  }
  const owned = new Map();
  const cleanupErrors = [];
  let completed, failure;
  try {
    if (qemu) {
      const version = await checked(`${options.accelerator}-version`, ['--version'], 10_000, qemu);
      const accelerators = await checked(`${options.accelerator}-accelerators`, ['-accel', 'help'], 10_000, qemu);
      if (options.accelerator === 'hvf') assertLinuxKernelHvfEmulator(version, accelerators);
      else assertLinuxKernelKvmEmulator(version, accelerators);
      assert.deepEqual(await bundleFile(qemu, 128 * 1024 * 1024), qemuIdentity, 'QEMU changed.');
    }
    const image = nativeLinuxUserspaceImages[architecture];
    const imageIdentity = JSON.parse(await checked('userspace-image', ['image', 'inspect', image, '--format', '{{json .}}']));
    assert.equal(imageIdentity.Os, 'linux');
    assert.equal(imageIdentity.Architecture, architecture === 'arm64' ? 'arm64' : 'amd64');
    assert.ok(imageIdentity.RepoDigests.includes(image.replace('docker.io/', '')));
    await writeFile(path.join(output, 'kernel'), capturedKernel.content, { flag: 'wx', mode: 0o600 });
    await mkdir(path.join(output, 'archive'));
    for (const name of ['native-release.json', ...record.files.map(file => file.filename)]) {
      await copyFile(path.join(archive, name), path.join(output, 'archive', name));
    }
    await verifyNativeArchiveSubjects(path.join(output, 'archive'), releaseSha256, commit);
    const fixtureIdentities = {};
    for (const name of ['init', 'guest-probe.mjs', 'Dockerfile']) {
      const captured = await readBundleFile(path.join(fixtures, name));
      fixtureIdentities[name] = captured.identity;
      await writeFile(path.join(output, name), captured.content, { flag: 'wx' });
    }
    const expected = { architecture, commit, kernelVersion: options.kernelVersion, accelerator: options.accelerator,
      manifestSha256: record.manifestSha256,
      inventorySha256: record.inventorySha256, version: record.version, plans: installedPlanCases };
    await writeFile(path.join(output, 'guest-input.json'), JSON.stringify(expected) + '\n', { flag: 'wx' });
    await checked('toolbox-build', ['build', '--tag', tag, '--file', path.join(output, 'Dockerfile'), output], 600_000);
    const toolbox = JSON.parse(await checked('toolbox-image', ['image', 'inspect', tag, '--format', '{{json .}}']));
    await checked('toolbox-packages', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', toolbox.Id, 'dpkg-query', '-W']);
    owned.set(rootfsContainer, imageIdentity.Id);
    const rootfsId = (await checked('rootfs-create', ['create', '--name', rootfsContainer, '--label', label,
      '--network=none', imageIdentity.Id, '/bin/true'])).trim();
    assert.match(rootfsId, /^[a-f0-9]{64}$/);
    await checked('rootfs-export', ['export', '--output', path.join(output, 'rootfs.tar'), rootfsId]);
    await checked('rootfs-remove', ['rm', rootfsId]);
    owned.delete(rootfsContainer);
    const preparation = [
      'tar --no-same-owner -xf /work/rootfs.tar -C /guest',
      'mkdir /guest/liftoff',
      'tar --no-same-owner -xzf "/work/archive/$LIFTOFF_ARCHIVE" -C /guest/liftoff',
      'cp /work/init /guest/init',
      'cp /work/guest-probe.mjs /work/guest-input.json /guest/',
      'chmod 755 /guest/init',
      'cd /guest',
      'find . -print0 | LC_ALL=C sort -z | cpio --null -o --format=newc --owner=0:0 | gzip -1 > /work/guest.cpio.gz'
    ].join('; ');
    const preparationContainer = `liftoff-linux-preparation-${nonce}`;
    owned.set(preparationContainer, toolbox.Id);
    await checked('initramfs-build', ['run', '--name', preparationContainer, '--label', label,
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--cap-add=DAC_OVERRIDE', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--cpus=2',
      '--tmpfs', '/guest:rw,nosuid,nodev,exec,size=1073741824,mode=0755',
      '--mount', `type=bind,source=${output},target=/work`, '--env', `LIFTOFF_ARCHIVE=${record.files[0].filename}`,
      toolbox.Id, 'timeout', '--signal=TERM', '--kill-after=10s', '120s',
      '/bin/bash', '-euxo', 'pipefail', '-c', preparation]);
    const before = {};
    for (const name of ['kernel', 'rootfs.tar', 'guest.cpio.gz', 'init', 'guest-probe.mjs', 'guest-input.json']) {
      before[name] = await bundleFile(path.join(output, name), 512 * 1024 * 1024);
    }
    let stdout;
    if (qemu) {
      assert.deepEqual(await bundleFile(qemu, 128 * 1024 * 1024), qemuIdentity, 'QEMU changed before execution.');
      if (kvmDevice) assert.deepEqual(await captureLinuxKernelKvmDevice(), kvmDevice, 'KVM device changed before execution.');
      stdout = await checked('guest', linuxKernelGuestArguments(architecture, {
        accelerator: options.accelerator, kernel: path.join(output, 'kernel'), initrd: path.join(output, 'guest.cpio.gz')
      }).slice(1), 120_000, qemu);
      assert.deepEqual(await bundleFile(qemu, 128 * 1024 * 1024), qemuIdentity, 'QEMU changed during execution.');
      if (kvmDevice) assert.deepEqual(await captureLinuxKernelKvmDevice(), kvmDevice, 'KVM device changed during execution.');
    } else {
      owned.set(guestContainer, toolbox.Id);
      stdout = await checked('guest', ['run', '--name', guestContainer, '--label', label, '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=3g', '--cpus=2',
        '--user', `${process.getuid()}:${process.getgid()}`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=4194304', '--mount', `type=bind,source=${output},target=/work,readonly`,
        toolbox.Id, 'timeout', '--signal=TERM', '--kill-after=10s', '840s',
        ...linuxKernelGuestArguments(architecture)], 880_000);
    }
    assert.equal(await readFile(path.join(output, 'guest.stderr'), 'utf8'), '', 'Unexpected QEMU diagnostic.');
    const report = assertLinuxKernelGuestTranscript(stdout, expected);
    for (const [name, identity] of Object.entries(before)) {
      assert.deepEqual(await bundleFile(path.join(output, name), 512 * 1024 * 1024), identity, 'Guest input changed.');
    }
    assert.deepEqual(await bundleFile(kernel, 128 * 1024 * 1024), capturedKernel.identity, 'Original kernel changed.');
    for (const [name, identity] of Object.entries(fixtureIdentities)) {
      assert.deepEqual(await bundleFile(path.join(fixtures, name)), identity, 'Contributor fixture changed.');
    }
    await verifyNativeArchiveSubjects(archive, releaseSha256, commit);
    completed = { receipt: {
      schemaVersion: 1, kind: qemu ? `liftoff-${options.accelerator}-linux-kernel-observation` : 'liftoff-emulated-linux-kernel-observation', report,
      subjects: before, fixtureIdentities, image, imageId: imageIdentity.Id, toolboxImageId: toolbox.Id,
      ...(qemu ? { [options.accelerator]: { executable: qemu, identity: qemuIdentity,
        accelerator: options.accelerator, cpu: 'host', tcgFallback: false,
        ...(kvmDevice ? { device: { path: '/dev/kvm', identity: kvmDevice } } : {}) } } : {}),
      releaseManifestSha256: releaseSha256, kernelAuthenticatedByRunner: false,
      qualifiedNativeHost: false, releaseReady: false
    }, result: { output, target: record.target, observed: report.observed, releaseReady: false, qualifiedNativeHost: false } };
  } catch (error) {
    failure = error;
  } finally {
    for (const [name, imageId] of owned) {
      const listed = execute(`cleanup-list-${name}`, ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
      if (listed.result.status === 0 && listed.stdout.toString().trim() === '') continue;
      const inspected = execute(`cleanup-inspect-${name}`, ['container', 'inspect', name, '--format', '{{json .}}']);
      if (listed.result.status !== 0 || listed.stdout.toString().trim() !== name || inspected.result.status !== 0) {
        cleanupErrors.push(`Cannot verify invocation-owned container ${name}: ${inspected.stderr.toString()}`);
        continue;
      }
      let container;
      try {
        container = JSON.parse(inspected.stdout.toString());
        assertLinuxKernelGuestContainerIdentity(container, name, nonce, imageId);
      } catch (error) {
        cleanupErrors.push(`Container cleanup refused for ${name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const stopped = execute(`cleanup-${name}`, ['rm', '--force', container.Id]);
      if (stopped.result.status !== 0) cleanupErrors.push(`Cannot remove ${name}: ${stopped.stderr.toString()}`);
    }
    await writeFile(path.join(output, 'commands.json'), JSON.stringify(commands, null, 2) + '\n', { flag: 'wx' });
  }
  if (failure || cleanupErrors.length) {
    const errors = [...(failure ? [failure] : []), ...cleanupErrors.map(message => new Error(message))];
    throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
  }
  assert.ok(completed, 'The guest observation did not complete.');
  await writeFile(path.join(output, 'report.json'), JSON.stringify(completed.receipt, null, 2) + '\n', { flag: 'wx' });
  return completed.result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLinuxKernelGuest(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(`Linux kernel guest failed: ${error.message}`); process.exitCode = 1; });
}
