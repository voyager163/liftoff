import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertLinuxKernelGuestContainerIdentity, assertLinuxKernelGuestTranscript,
  assertLinuxKernelImage, linuxKernelGuestArguments, runLinuxKernelGuest
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
    `LIFTOFF_GUEST_REPORT=${JSON.stringify(report)}`, 'LIFTOFF_GUEST_EXIT=0', '[100.0] reboot: Power down', ''
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
  it.each(['', 'LIFTOFF_GUEST_EXIT=0\n', 'LIFTOFF_GUEST_REPORT={}\n'])(
    'refuses absent or summary-only observations %j', transcript => {
      expect(() => assertLinuxKernelGuestTranscript(transcript, fixture().expected)).toThrow();
    });
  it.each(['LIFTOFF_GUEST_REPORT=', 'LIFTOFF_GUEST_INIT=', 'LIFTOFF_GUEST_EXIT='])(
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
      ['reboot: Power down', 'reboot: failed'], ['glibc:2.28-', 'glibc:2.29-'],
      ['libstdc++:8.5.0-', 'libstdc++:9.0.0-']
    ]) {
      const value = fixture();
      expect(() => assertLinuxKernelGuestTranscript(value.transcript().replace(from, to), value.expected)).toThrow();
    }
  });
  it.each(['arm64', 'x64'] as const)('fixes bounded, network-free %s emulation without KVM/native claims', architecture => {
    const args = linuxKernelGuestArguments(architecture);
    expect(args).toContain(architecture === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64');
    expect(args.slice(args.indexOf('-accel'), args.indexOf('-accel') + 2)).toEqual(['-accel', 'tcg,thread=multi']);
    expect(args.slice(args.indexOf('-nic'), args.indexOf('-nic') + 2)).toEqual(['-nic', 'none']);
    expect(args).toContain(architecture === 'arm64' ? 'virtio-rng-device,rng=rng0' : 'virtio-rng-pci,rng=rng0');
    expect(() => linuxKernelGuestArguments('riscv64')).toThrow('Unsupported guest architecture');
  });
  it('refuses incomplete CLI input before invoking Docker or writing output', async () => {
    await expect(runLinuxKernelGuest([])).rejects.toThrow('Usage:');
  });
});
