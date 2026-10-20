import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  assertLinuxKernelGuestContainerIdentity, assertLinuxKernelGuestTranscript,
  assertLinuxKernelHvfEmulator, assertLinuxKernelHvfHost,
  assertLinuxKernelImage, linuxKernelGuestArguments, parseLinuxKernelGuestOptions, runLinuxKernelGuest
} from '../scripts/native-linux-kernel.mjs';
import { installedPlanCases } from '../scripts/package-smoke-contract.mjs';
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
    kind: 'liftoff-linux-kernel-guest-probe',
    observed: { platform: 'linux', architecture, runtimeVersion: '24.21.0', osVersion: '4.18.20',
      nativeArchitecture: architecture === 'arm64' ? 'aarch64' : 'x86_64', glibcVersion: '2.28' },
    commit: expected.commit, manifestSha256: expected.manifestSha256, inventorySha256: expected.inventorySha256,
    version: `Liftoff ${expected.version}`, plans: structuredClone(plans),
    libraries: [`glibc:2.28-251.${architecture === 'arm64' ? 'aarch64' : 'x86_64'}`,
      `libstdc++:8.5.0-22.${architecture === 'arm64' ? 'aarch64' : 'x86_64'}`],
    uid: 1000, gid: 1000, bundleReadOnly: true, kernelExecution: true, emulated: true,
    developmentInstallRecovered: true, controllerResolved: true, hclExecuted: false,
    hclQualifiedRuntimeRefused: true, publicInstallationRefused: true,
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
  it.each(['4.18', '4.18.20'])('binds an explicit %s HVF observation without native-host or release qualification', kernelVersion => {
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
      ...expected, kernelVersion: kernelVersion === '4.18' ? '4.18.20' : '4.18'
    })).toThrow();
    value.report.emulated = true;
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), expected)).toThrow();
  });
  it('does not reinterpret an original 4.18.20 TCG report as the exact floor or a hardware observation', () => {
    const value = fixture();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...value.expected, kernelVersion: '4.18' })).toThrow();
    expect(() => assertLinuxKernelGuestTranscript(value.transcript(), { ...value.expected, accelerator: 'hvf' })).toThrow();
    for (const expected of [
      { ...value.expected, kernelVersion: '4.18.0' },
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
  it.each(['commit', 'manifestSha256', 'inventorySha256', 'version', 'uid', 'gid',
    'bundleReadOnly', 'kernelExecution', 'emulated', 'developmentInstallRecovered', 'controllerResolved',
    'hclExecuted', 'hclQualifiedRuntimeRefused', 'publicInstallationRefused', 'minimumHostQualified',
    'publicDistributionQualified'] as const)('rejects changed or absent %s', field => {
      const value = fixture();
      Reflect.set(value.report, field, typeof value.report[field] === 'boolean' ? !value.report[field] : 'foreign');
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
      Reflect.deleteProperty(value.report, field);
      expect(() => assertLinuxKernelGuestTranscript(value.transcript(), value.expected)).toThrow();
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
  it('preserves the original six-argument defaults and requires explicit bounded kernel/HVF options', () => {
    const positional = Array.from({ length: 6 }, (_, index) => `input-${index}`);
    expect(parseLinuxKernelGuestOptions(positional)).toEqual({ kernelVersion: '4.18.20', accelerator: 'tcg', qemu: null });
    const qemu = path.resolve(cwd, 'QEMU with spaces');
    for (const flags of [
      ['--kernel-version', '4.18', '--hvf-qemu', qemu],
      ['--hvf-qemu', qemu, '--kernel-version', '4.18']
    ]) expect(parseLinuxKernelGuestOptions([...positional, ...flags])).toEqual({ kernelVersion: '4.18', accelerator: 'hvf', qemu });
    for (const flags of [
      ['--kernel-version'], ['--kernel-version', '4.18.0'], ['--kernel-version', 'latest'],
      ['--kernel-version', '4.18', '--kernel-version', '4.18.20'], ['--hvf-qemu', 'relative'],
      ['--hvf-qemu', qemu, '--hvf-qemu', qemu], ['--accel', 'tcg'], ['--unknown', 'value']
    ]) expect(() => parseLinuxKernelGuestOptions([...positional, ...flags])).toThrow();
  });
  it('refuses incomplete CLI input before invoking Docker or writing output', async () => {
    await expect(runLinuxKernelGuest([])).rejects.toThrow('Usage:');
  });
});
