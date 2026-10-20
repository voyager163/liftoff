import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureLinuxKernelKvmDevice, runLinuxKernelGuest } from '../scripts/native-linux-kernel.mjs';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, lstat: vi.fn(original.lstat), open: vi.fn(original.open) };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff-kvm-device-contract-'));
  await writeFile(path.join(directory, 'synthetic-device'), 'not a KVM device');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', architecture);
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
afterAll(async () => { await rm(directory, { recursive: true }); });

async function syntheticDevice() {
  const filename = path.join(directory, 'synthetic-device');
  const info = Object.assign(await stat(filename, { bigint: true }), {
    isCharacterDevice: () => true, mode: 0o20660n, uid: 0n, nlink: 1n, rdev: 2792n
  });
  const handle = await open(filename, 'r');
  const actualClose = handle.close.bind(handle);
  const close = vi.spyOn(handle, 'close');
  vi.spyOn(handle, 'stat').mockResolvedValue(info);
  vi.mocked(lstat).mockResolvedValue(info);
  vi.mocked(open).mockResolvedValue(handle);
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  Object.defineProperty(process, 'arch', { ...architecture, value: 'x64' });
  return { info, handle, close, actualClose };
}

describe('synthetic KVM device capture controls, not hardware execution', () => {
  it('captures the fixed device through a no-follow nonblocking handle and closes it', async () => {
    const { close } = await syntheticDevice();
    const identity = await captureLinuxKernelKvmDevice();
    expect(identity.rdev).toBe('2792');
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('/dev/kvm', constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
  it('rejects an opened device identity change and still closes the handle', async () => {
    const { info, handle, close } = await syntheticDevice();
    const changed = Object.assign(await stat(path.join(directory, 'synthetic-device'), { bigint: true }), info,
      { ino: info.ino + 1n });
    vi.mocked(handle.stat).mockResolvedValue(changed);
    await expect(captureLinuxKernelKvmDevice()).rejects.toThrow('changed while opening');
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
  it('rejects a path identity change after open and still closes the handle', async () => {
    const { info, close } = await syntheticDevice();
    const changed = Object.assign(await stat(path.join(directory, 'synthetic-device'), { bigint: true }), info,
      { ctimeNs: info.ctimeNs + 1n });
    vi.mocked(lstat).mockResolvedValueOnce(info).mockResolvedValueOnce(changed);
    await expect(captureLinuxKernelKvmDevice()).rejects.toThrow('path changed while opening');
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
  it('propagates a rejected handle close instead of publishing an identity', async () => {
    const { close, actualClose } = await syntheticDevice();
    close.mockImplementationOnce(async () => {
      await actualClose();
      throw new Error('synthetic close rejection');
    });
    await expect(captureLinuxKernelKvmDevice()).rejects.toThrow('synthetic close rejection');
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });
  it('propagates denied device access without a permission or acceleration fallback', async () => {
    const { handle, close } = await syntheticDevice();
    await handle.close();
    close.mockClear();
    vi.mocked(open).mockRejectedValueOnce(new Error('synthetic EACCES'));
    await expect(captureLinuxKernelKvmDevice()).rejects.toThrow('synthetic EACCES');
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
  it('refuses a non-character path before opening it', async () => {
    const info = await stat(path.join(directory, 'synthetic-device'), { bigint: true });
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'arch', { ...architecture, value: 'x64' });
    vi.mocked(lstat).mockResolvedValueOnce(info);
    await expect(captureLinuxKernelKvmDevice()).rejects.toThrow('character device');
    expect(open).not.toHaveBeenCalled();
  });
  it('refuses a foreign host before filesystem access or a CLI output side effect', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' });
    await expect(captureLinuxKernelKvmDevice()).rejects.toThrow('native x64 Linux');
    await expect(runLinuxKernelGuest(['archive', 'b'.repeat(64), 'a'.repeat(40), 'kernel', 'c'.repeat(64),
      'output', '--kvm-qemu', path.resolve(directory, 'qemu')])).rejects.toThrow('native x64 Linux');
    expect(lstat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
