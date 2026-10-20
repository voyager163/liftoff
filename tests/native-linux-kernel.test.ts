import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  assertLinuxKernelGuestContainerIdentity, assertLinuxKernelGuestTranscript,
  assertLinuxKernelHvfEmulator, assertLinuxKernelHvfHost,
  assertLinuxKernelKvmEmulator, assertLinuxKernelKvmHost, linuxKernelKvmDeviceIdentity,
  assertLinuxKernelImage, linuxKernelGuestArguments, parseLinuxKernelGuestOptions, runLinuxKernelGuest
} from '../scripts/native-linux-kernel.mjs';
import { installedPlanCases } from '../scripts/package-smoke-contract.mjs';
import { nativeLinuxUserspaceImages } from '../scripts/native-package-report.mjs';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

let cwd: string;
let plans: { id: string; stdout: string }[];
beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'liftoff-kernel-contract-'));
  plans = [];
  for (const plan of installedPlanCases) {
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['plan', ...plan.args]), {
      cwd, stdout, stderr, runner: new ReadyInitRunner(), terminal: { layout: 'plain', color: false }
    });
    expect(code, stderr.text()).toBe(0);
    plans.push({ id: plan.id, stdout: stdout.text() });
  }
});
afterAll(async () => { if (cwd) await rm(cwd, { recursive: true }); });

function fixture(architecture: 'arm64' | 'x64' = 'arm64') {
  const expected = { architecture, commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64),
    inventorySha256: 'c'.repeat(64), version: '0.13.0-dev.0' };
  const report = {
    kind: 'liftoff-linux-kernel-guest-probe', schemaVersion: 2,
    observed: { platform: 'linux', architecture, runtimeVersion: '24.21.0', osVersion: '4.18.20',
      nativeArchitecture: architecture === 'arm64' ? 'aarch64' : 'x86_64', glibcVersion: '2.28' },
    commit: expected.commit, manifestSha256: expected.manifestSha256, inventorySha256: expected.inventorySha256,
    version: `Liftoff ${expected.version}`, plans: structuredClone(plans),
    libraries: [`glibc:2.28-251.${architecture === 'arm64' ? 'aarch64' : 'x86_64'}`,
      `libstdc++:8.5.0-22.${architecture === 'arm64' ? 'aarch64' : 'x86_64'}`],
    uid: 1000, gid: 1000, bundleReadOnly: true, kernelExecution: true, emulated: true,
    developmentInstallRecovered: true, controllerResolved: true, hclExecuted: true,
    hclQualifiedRuntimeRefused: false, publicInstallationRefused: true,
    hcl: { policyVersion: 3, protocolVersion: 2,
      parsed: [{ locals: [{ enabled: true }] }, { locals: [{ policy: '${file("./policy.json")}' }] }],
      expressionCounts: [1, 1], fileExpressionType: 'template' },
    minimumHostQualified: false, publicDistributionQualified: false
  };
  const transcript = () => [
    '[4.0] random: crng init done', 'LIFTOFF_GUEST_INIT=started',
    `LIFTOFF_GUEST_REPORT_GZIP=${gzipSync(JSON.stringify(report), { level: 9 }).toString('base64')}`,
    'LIFTOFF_GUEST_EXIT=0', '[100.0] reboot: Power down', ''
  ].join('\r\n');
  return { expected, report, transcript };
}

describe('emulated Linux kernel observation contract', () => {
  it('pins the x64 kernel compiler to the independently declared qualification userspace', async () => {
    const dockerfile = await readFile(path.join(process.cwd(), 'distribution/linux/qualification/Kernel.Dockerfile'), 'utf8');
    expect(dockerfile.split(/\r?\n/)[0]).toBe(`FROM ${nativeLinuxUserspaceImages.x64}`);
  });
  it('requires exact name, image and invocation label before container cleanup', () => {
    const container = { Id: 'a'.repeat(64), Name: '/own', Image: 'sha256:one',
      Config: { Labels: { 'liftoff.kernel-guest.invocation': 'nonce' } } };
    expect(() => assertLinuxKernelGuestContainerIdentity(container, 'own', 'nonce', 'sha256:one')).not.toThrow();
    for (const changed of [
      { ...container, Id: '../foreign' }, { ...container, Name: '/foreign' }, { ...container, Image: 'sha256:foreign' },
      { ...container, Config: {} }, { ...container, Config: { Labels: { 'liftoff.kernel-guest.invocation': 'foreign' } } }
    ]) {
      expect(() => assertLinuxKernelGuestContainerIdentity(changed, 'own', 'nonce', 'sha256:one')).toThrow();
    }
  });
  it('refuses wrong, empty and cross-architecture kernel images before execution', () => {
    const arm64 = Buffer.alloc(64), x64 = Buffer.alloc(0x238);
    arm64.writeUInt32LE(0x644d5241, 56);
    x64.writeUInt16LE(0xaa55, 0x1fe);
    x64.write('HdrS', 0x202, 'ascii');
    x64.writeUInt16LE(1, 0x236);
    expect(() => assertLinuxKernelImage(arm64, 'arm64')).not.toThrow();
    expect(() => assertLinuxKernelImage(x64, 'x64')).not.toThrow();
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(64), x64]) {
      expect(() => assertLinuxKernelImage(bytes, 'arm64')).toThrow();
    }
    for (const bytes of [Buffer.alloc(0), arm64, Buffer.alloc(0x238)]) {
      expect(() => assertLinuxKernelImage(bytes, 'x64')).toThrow();
    }
    x64.writeUInt16LE(0, 0x236);
    expect(() => assertLinuxKernelImage(x64, 'x64')).toThrow('64-bit');
    expect(() => assertLinuxKernelImage(arm64, 'riscv64')).toThrow('Unsupported');
  });
  it.each(['arm64', 'x64'] as const)('admits a complete %s contract without release authority or native-host credit', architecture => {
    const value = fixture(architecture), before = structuredClone(value.report);
    expect(assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toEqual(before);
    expect(value.report).toEqual(before);
  });
  it.each(['4.18.0', '4.18.20'])('binds an explicit %s HVF observation without native-host or release qualification', kernelVersion => {
    const value = fixture();
    value.report.observed.osVersion = kernelVersion;
    value.report.emulated = false;
    const expected = { ...value.expected, kernelVersion, accelerator: 'hvf' };
    const before = structuredClone(value.report);
    expect(assertLinuxKernelGuestTranscript(value.transcript(), expected)).toEqual(before);
    expect(value.report).toEqual(before);
    expect(value.report.minimumHostQualified).toBe(false);
    expect(value.report.publicDistributionQualified).toBe(false);
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...expected, accelerator: 'tcg' })).toThrow();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), {
      ...expected, kernelVersion: kernelVersion === '4.18.0' ? '4.18.20' : '4.18.0'
    })).toThrow();
    value.report.emulated = true;
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), expected)).toThrow();
  });
  it.each(['4.18.0', '4.18.20'])('binds a %s KVM contract fixture without granting native-host or release qualification', kernelVersion => {
    const value = fixture('x64');
    value.report.observed.osVersion = kernelVersion;
    value.report.emulated = false;
    const expected = { ...value.expected, kernelVersion, accelerator: 'kvm' };
    const before = structuredClone(value.report);
    expect(assertLinuxKernelGuestTranscript(value.transcript(), expected)).toEqual(before);
    expect(value.report).toEqual(before);
    expect(value.report.minimumHostQualified).toBe(false);
    expect(value.report.publicDistributionQualified).toBe(false);
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...expected, accelerator: 'tcg' })).toThrow();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...expected, accelerator: 'hvf' })).toThrow();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), {
      ...expected, kernelVersion: kernelVersion === '4.18.0' ? '4.18.20' : '4.18.0'
    })).toThrow();
    value.report.emulated = true;
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), expected)).toThrow();
  });
  it('does not reinterpret an original 4.18.20 TCG report as the exact floor or a hardware observation', () => {
    const value = fixture();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...value.expected, kernelVersion: '4.18.0' })).toThrow();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...value.expected, accelerator: 'hvf' })).toThrow();
    for (const expected of [
      { ...value.expected, kernelVersion: '4.18' },
      { ...value.expected, kernelVersion: 'latest' },
      { ...value.expected, accelerator: 'auto' },
      { ...value.expected, accelerator: 'kvm' },
      { ...value.expected, accelerator: 'hvf', architecture: 'x64' }
    ]) expect(() => assertLinuxKernelGuestTranscript(value.transcript(), expected)).toThrow();
  });
  it.each(['', 'LIFTOFF_GUEST_EXIT=0\n', 'LIFTOFF_GUEST_REPORT_GZIP={}\n'])(
    'refuses absent or summary-only observations %j', transcript => {
      expect(() => assertLinuxKernelGuestTranscript(transcript, fixture().expected)).toThrow();
    });
  it.each(['LIFTOFF_GUEST_REPORT_GZIP=', 'LIFTOFF_GUEST_INIT=', 'LIFTOFF_GUEST_EXIT='])(
    'rejects missing and duplicate %s markers', prefix => {
      const value = fixture(), line = value.transcript().split('\r\n').find(entry => entry.startsWith(prefix))!;
      expect(() => assertLinuxKernelGuestTranscript(value.transcript().replace(line, ''), value.expected)).toThrow();
      expect(() => assertLinuxKernelGuestTranscript(value.transcript() + line + '\n', value.expected)).toThrow();
    });
  it.each(['schemaVersion', 'commit', 'manifestSha256', 'inventorySha256', 'version', 'uid', 'gid',
    'bundleReadOnly', 'kernelExecution', 'emulated', 'developmentInstallRecovered', 'controllerResolved',
    'hclExecuted', 'hclQualifiedRuntimeRefused', 'publicInstallationRefused', 'minimumHostQualified',
    'publicDistributionQualified'] as const)('rejects changed or absent %s', field => {
      const value = fixture();
      Reflect.set(value.report, field, typeof value.report[field] === 'boolean' ? !value.report[field] : 'foreign');
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
      Reflect.deleteProperty(value.report, field);
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
    });
    it('rejects historical refusal, missing HCL and forged current summaries without rewriting them', () => {
      for (const change of [
        (report: ReturnType<typeof fixture>['report']) => { report.schemaVersion = 1; },
        (report: ReturnType<typeof fixture>['report']) => { report.hclExecuted = false; report.hclQualifiedRuntimeRefused = true; },
        (report: ReturnType<typeof fixture>['report']) => { Reflect.deleteProperty(report, 'hcl'); },
        (report: ReturnType<typeof fixture>['report']) => { report.hcl.policyVersion = 2; },
        (report: ReturnType<typeof fixture>['report']) => { report.hcl.expressionCounts = [0, 0]; },
        (report: ReturnType<typeof fixture>['report']) => { report.hcl.fileExpressionType = 'success'; },
        (report: ReturnType<typeof fixture>['report']) => { report.hcl.parsed.reverse(); }
      ]) {
        const value = fixture();
        change(value.report);
        const before = structuredClone(value.report);
        expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
        expect(value.report).toEqual(before);
      }
    });
  it.each(['platform', 'architecture', 'runtimeVersion', 'osVersion', 'nativeArchitecture', 'glibcVersion'] as const)(
    'refuses a different observed %s', field => {
      const value = fixture();
      Reflect.set(value.report.observed, field, 'foreign');
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
    });
  it('refuses incomplete, duplicated, reordered and changed plans despite a passing process marker', () => {
    for (const mutate of [
      (rows: typeof plans) => rows.pop(), (rows: typeof plans) => rows.push(rows[0]),
      (rows: typeof plans) => rows.reverse(), (rows: typeof plans) => { rows[0].stdout = 'success'; }
    ]) {
      const value = fixture();
      mutate(value.report.plans);
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
    }
  });
  it('refuses failed process, missing entropy, missing shutdown and foreign libraries', () => {
    for (const [from, to] of [
      ['LIFTOFF_GUEST_EXIT=0', 'LIFTOFF_GUEST_EXIT=1'],
      ['random: crng init done', 'random: uninitialized'],
      ['reboot: Power down', 'reboot: failed']
    ]) {
      const value = fixture();
      expect(() => assertLinuxKernelGuestTranscript(value.transcript().replace(from, to), value.expected)).toThrow();
    }
    for (const libraries of [
      ['glibc:2.29-251.aarch64', 'libstdc++:8.5.0-22.aarch64'],
      ['glibc:2.28-251.aarch64', 'libstdc++:9.0.0-22.aarch64']
    ]) {
      const value = fixture();
      value.report.libraries = libraries;
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
    }
  });
  it('bounds the actual encoded report and refuses broken, noncanonical and oversized compressed frames', () => {
    const value = fixture();
    const prefix = 'LIFTOFF_GUEST_REPORT_GZIP=';
    const frame = value.transcript().split('\r\n').find(line => line.startsWith(prefix))!;
    const encoded = frame.slice(prefix.length);
    expect(encoded.length).toBeLessThanOrEqual(7168);
    for (const replacement of [
      '', 'a'.repeat(7169), encoded + ' ', 'not-gzip',
      gzipSync('not json').toString('base64'),
      gzipSync('"' + 'x'.repeat(1024 * 1024) + '"').toString('base64')
    ]) {
      expect(() => assertLinuxKernelGuestTranscript(value.transcript().replace(frame, prefix + replacement), value.expected)).toThrow();
    }
  });
  it('retains surrounding kernel diagnostics but never repairs an interleaved serial frame', () => {
    const value = fixture();
    const transcript = value.transcript();
    const prefix = 'LIFTOFF_GUEST_REPORT_GZIP=';
    const frame = transcript.split('\r\n').find(line => line.startsWith(prefix))!;
    const warning = '[  150.278445] serial8250: too much work for irq4\r\n';
    expect(assertLinuxKernelGuestTranscript(warning + transcript, value.expected)).toEqual(value.report);
    const interrupted = frame.slice(0, 4096) + warning + frame.slice(4096);
    expect(() => assertLinuxKernelGuestTranscript(transcript.replace(frame, interrupted), value.expected)).toThrow();
    const legacy = 'LIFTOFF_GUEST_REPORT=' + JSON.stringify(value.report);
    expect(legacy.length).toBeGreaterThan(8192);
    const originalFailure = legacy.slice(0, 8192) + warning + legacy.slice(8192);
    expect(() => assertLinuxKernelGuestTranscript(transcript.replace(frame, originalFailure), value.expected)).toThrow();
  });
  it.each(['arm64', 'x64'] as const)('fixes bounded, network-free %s emulation without KVM/native claims', architecture => {
    const args = linuxKernelGuestArguments(architecture);
    expect(args).toContain(architecture === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64');
    expect(args.slice(args.indexOf('-accel'), args.indexOf('-accel') + 2)).toEqual(['-accel', 'tcg,thread=multi']);
    expect(args.slice(args.indexOf('-nic'), args.indexOf('-nic') + 2)).toEqual(['-nic', 'none']);
    expect(args).toContain(architecture === 'arm64' ? 'virtio-rng-device,rng=rng0' : 'virtio-rng-pci,rng=rng0');
    expect(() => linuxKernelGuestArguments('riscv64')).toThrow('Unsupported guest architecture');
  });
  it('selects only HVF with the native CPU and literal physical inputs, without a fallback or host mount', () => {
    const kernel = path.resolve(cwd, 'kernel with spaces'), initrd = path.resolve(cwd, 'guest with spaces.cpio.gz');
    const args = linuxKernelGuestArguments('arm64', { accelerator: 'hvf', kernel, initrd });
    for (const [flag, value] of [
      ['-machine', 'virt-11.1,gic-version=3,highmem=off'], ['-cpu', 'host'], ['-accel', 'hvf'],
      ['-smp', '2'], ['-m', '2048'], ['-nic', 'none'], ['-display', 'none'], ['-monitor', 'none'],
      ['-kernel', kernel], ['-initrd', initrd]
    ]) expect(args.slice(args.indexOf(flag), args.indexOf(flag) + 2)).toEqual([flag, value]);
    expect(args.filter(value => value === '-accel')).toHaveLength(1);
    expect(args.filter(value => value.startsWith('-'))).toEqual([
      '-machine', '-cpu', '-accel', '-smp', '-m', '-display', '-monitor', '-serial', '-nic', '-no-reboot',
      '-object', '-device', '-kernel', '-initrd', '-append'
    ]);
    expect(() => linuxKernelGuestArguments('x64', { accelerator: 'hvf' })).toThrow('ARM64');
    expect(() => linuxKernelGuestArguments('arm64', { accelerator: 'auto' })).toThrow('accelerator');
    expect(() => linuxKernelGuestArguments('arm64', { kernel: 'relative' })).toThrow('Absolute');
    expect(() => linuxKernelGuestArguments('arm64', { initrd: 'relative' })).toThrow('Absolute');
  });
  it('selects only x64 KVM with the native CPU and unchanged direct-guest resource and network bounds', () => {
    const kernel = path.resolve(cwd, 'kernel with spaces'), initrd = path.resolve(cwd, 'guest with spaces.cpio.gz');
    const args = linuxKernelGuestArguments('x64', { accelerator: 'kvm', kernel, initrd });
    for (const [flag, value] of [
      ['-machine', 'pc-i440fx-8.2'], ['-cpu', 'host'], ['-accel', 'kvm'],
      ['-smp', '2'], ['-m', '2048'], ['-nic', 'none'], ['-display', 'none'], ['-monitor', 'none'],
      ['-kernel', kernel], ['-initrd', initrd]
    ]) expect(args.slice(args.indexOf(flag), args.indexOf(flag) + 2)).toEqual([flag, value]);
    expect(args.filter(value => value === '-accel')).toHaveLength(1);
    expect(args.filter(value => value.startsWith('-'))).toEqual([
      '-machine', '-cpu', '-accel', '-smp', '-m', '-display', '-monitor', '-serial', '-nic', '-no-reboot',
      '-object', '-device', '-kernel', '-initrd', '-append'
    ]);
    expect(args).not.toContain('tcg');
    expect(() => linuxKernelGuestArguments('arm64', { accelerator: 'kvm' })).toThrow('x64');
  });
  it.each([
    ['darwin', 'x64', 'arm64'], ['darwin', 'arm64', 'x64'], ['linux', 'arm64', 'arm64'],
    ['linux', 'x64', 'arm64'], ['win32', 'arm64', 'arm64']
  ])('refuses HVF host/guest %s/%s/%s rather than substituting emulation', (platform, host, guest) => {
    expect(() => assertLinuxKernelHvfHost(platform, host, guest)).toThrow('no emulation fallback');
  });
  it('admits only the pinned HVF emulator metadata, including its actual newline-delimited version', () => {
    expect(() => assertLinuxKernelHvfHost('darwin', 'arm64', 'arm64')).not.toThrow();
    expect(() => assertLinuxKernelHvfEmulator('QEMU emulator version 11.1.2\nCopyright\n',
      'Accelerators supported in QEMU binary:\nhvf\ntcg\n')).not.toThrow();
    expect(() => assertLinuxKernelHvfEmulator('QEMU emulator version 11.1.2\r\n', 'hvf\r\n')).not.toThrow();
    for (const [version, accelerators] of [
      ['', 'hvf\n'], ['QEMU emulator version 8.2.2\n', 'hvf\n'],
      ['QEMU emulator version 11.1.2-extra\n', 'hvf\n'],
      ['QEMU emulator version 11.1.2\n', 'tcg\n'], ['QEMU emulator version 11.1.2\n', 'hvf-disabled\n']
    ]) expect(() => assertLinuxKernelHvfEmulator(version, accelerators)).toThrow();
  });
  it.each([
    ['darwin', 'x64', 'x64'], ['darwin', 'arm64', 'x64'], ['linux', 'arm64', 'x64'],
    ['linux', 'x64', 'arm64'], ['win32', 'x64', 'x64']
  ])('refuses KVM host/guest %s/%s/%s rather than substituting emulation', (platform, host, guest) => {
    expect(() => assertLinuxKernelKvmHost(platform, host, guest)).toThrow('no emulation fallback');
  });
  it('admits only the exact KVM emulator version and explicitly advertised acceleration', () => {
    expect(() => assertLinuxKernelKvmHost('linux', 'x64', 'x64')).not.toThrow();
    for (const version of [
      'QEMU emulator version 8.2.2\nCopyright\n',
      'QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.18)\r\nCopyright\r\n'
    ]) expect(() => assertLinuxKernelKvmEmulator(version, 'Accelerators supported in QEMU binary:\nkvm\ntcg\n')).not.toThrow();
    for (const [version, accelerators] of [
      ['', 'kvm\n'], ['QEMU emulator version 11.1.2\n', 'kvm\n'],
      ['QEMU emulator version 8.2.20\n', 'kvm\n'], ['QEMU emulator version 8.2.2-extra\n', 'kvm\n'],
      ['QEMU emulator version 8.2.2 (foreign)\n', 'kvm\n'],
      ['QEMU emulator version 8.2.2\n', 'tcg\n'], ['QEMU emulator version 8.2.2\n', 'kvm-disabled\n']
    ]) expect(() => assertLinuxKernelKvmEmulator(version, accelerators)).toThrow();
  });
  it('bounds KVM device metadata and retains every physical identity field without claiming actual device execution', () => {
    const info = { isCharacterDevice: () => true, dev: 1n, ino: 2n, mode: 0o20660n, uid: 0n, gid: 108n,
      rdev: 2792n, nlink: 1n, mtimeNs: 3n, ctimeNs: 4n };
    const identity = linuxKernelKvmDeviceIdentity(info);
    expect(identity).toEqual({ dev: '1', ino: '2', mode: String(0o20660), uid: '0', gid: '108',
      rdev: '2792', nlink: '1', mtimeNs: '3', ctimeNs: '4' });
    for (const changed of [
      { ...info, isCharacterDevice: () => false }, { ...info, uid: 1000n }, { ...info, nlink: 2n },
      { ...info, rdev: 1n }, { ...info, mode: 0o20662n }, { ...info, mode: 0o24660n }, { ...info, mode: 0o22660n }
    ]) expect(() => linuxKernelKvmDeviceIdentity(changed)).toThrow('character device');
    for (const field of ['dev', 'ino', 'gid', 'mtimeNs', 'ctimeNs'] as const) {
      const changed = { ...info, [field]: info[field] + 1n };
      expect(linuxKernelKvmDeviceIdentity(changed)).not.toEqual(identity);
    }
    expect(linuxKernelKvmDeviceIdentity(info)).toEqual(identity);
  });
  it('preserves six-argument defaults and requires explicit, mutually exclusive hardware options', () => {
    const positional = Array.from({ length: 6 }, (_, index) => `input-${index}`);
    expect(parseLinuxKernelGuestOptions(positional)).toEqual({ kernelVersion: '4.18.20', accelerator: 'tcg', qemu: null });
    const qemu = path.resolve(cwd, 'QEMU with spaces');
    for (const flags of [
      ['--kernel-version', '4.18.0', '--hvf-qemu', qemu],
      ['--hvf-qemu', qemu, '--kernel-version', '4.18.0']
    ]) expect(parseLinuxKernelGuestOptions([...positional, ...flags])).toEqual({ kernelVersion: '4.18.0', accelerator: 'hvf', qemu });
    for (const flags of [
      ['--kernel-version'], ['--kernel-version', '4.18'], ['--kernel-version', 'latest'],
      ['--kernel-version', '4.18.0', '--kernel-version', '4.18.20'], ['--hvf-qemu', 'relative'],
      ['--hvf-qemu', qemu, '--hvf-qemu', qemu], ['--accel', 'tcg'], ['--unknown', 'value']
    ]) expect(() => parseLinuxKernelGuestOptions([...positional, ...flags])).toThrow();
    expect(parseLinuxKernelGuestOptions([...positional, '--kvm-qemu', qemu, '--kernel-version', '4.18.0']))
      .toEqual({ kernelVersion: '4.18.0', accelerator: 'kvm', qemu });
    for (const flags of [
      ['--kvm-qemu', 'relative'], ['--kvm-qemu', qemu, '--kvm-qemu', qemu],
      ['--kvm-qemu', qemu, '--hvf-qemu', qemu], ['--hvf-qemu', qemu, '--kvm-qemu', qemu]
    ]) expect(() => parseLinuxKernelGuestOptions([...positional, ...flags])).toThrow();
  });
  it('refuses incomplete CLI input before invoking Docker or writing output', async () => {
    await expect(runLinuxKernelGuest([])).rejects.toThrow('Usage:');
  });
});
