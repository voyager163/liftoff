import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectWindowsControllerRuntime, revalidateWindowsControllerRuntime, windowsControllerRuntimePaths
} from '../src/adapters/process/windows-controller-runtime.js';

function fixture() {
  const root = 'C:\\Windows', paths = windowsControllerRuntimePaths(root);
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(3, 70); bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x22, 86); bytes.writeUInt16LE(0x20b, 88);
  const directory = { identity: 'directory:1', size: 0, file: false, directory: true, reparse: false };
  const executable = { identity: 'executable:1', size: bytes.length, file: true, directory: false, reparse: false };
  const fs = {
    async inspect(name: string) { return { ...(path.win32.basename(name) === 'powershell.exe' ? executable : directory) }; },
    async canonical(name: string) { return name; },
    async read() { return bytes; }
  };
  const inspect = () => inspectWindowsControllerRuntime(paths.executable, root, 'win32', fs);
  return { root, paths, bytes, directory, executable, fs, inspect };
}

describe('per-invocation system PowerShell runtime binding', () => {
  it('uses actual verified local binary bytes and the exact sibling builtin root, not a hosted-machine hash', async () => {
    const f = fixture(), result = await f.inspect();
    expect(result).toEqual({
      ...f.paths, binaryDigest: createHash('sha256').update(f.bytes).digest('hex'),
      architecture: 'x64', peMachine: 0x8664, pointerBytes: 8
    });
    expect(Object.isFrozen(result)).toBe(true);
    await expect(revalidateWindowsControllerRuntime(result, f.fs)).resolves.toBeUndefined();
    await expect(revalidateWindowsControllerRuntime({ ...result }, f.fs)).rejects.toThrow('Unsupported or changed');
  });
  it.each([
    '\\\\server\\Windows', 'C:\\Windows\\..\\Foreign', 'C:\\Windows\\', 'C:Windows',
    'C:\\Windows;C:\\Foreign', 'C:\\Windows\0'
  ])('rejects a noncanonical or foreign root %s', root => {
    expect(() => windowsControllerRuntimePaths(root)).toThrow('Unsupported or changed');
  });
  it.each([
    [0x14c, 'x86', 4], [0x8664, 'x64', 8], [0x1c4, 'arm32', 4],
    [0xaa64, 'arm64', 8], [0xa641, 'arm64ec', 8], [0xa64e, 'arm64x', 8]
  ])('binds actual PE machine %s independently of the Node caller without claiming native qualification', async (machine, architecture, pointerBytes) => {
    const f = fixture();
    f.bytes.writeUInt16LE(Number(machine), 68);
    f.bytes.writeUInt16LE(pointerBytes === 4 ? 0x10b : 0x20b, 88);
    await expect(f.inspect()).resolves.toMatchObject({ architecture, peMachine: machine, pointerBytes });
  });
  it('accepts only OS redirection to the exact alternate system runtime, never a caller/user search path', async () => {
    const f = fixture();
    const physical = path.win32.join(f.root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    f.fs.canonical = async name => name === f.paths.executable ? physical : name;
    f.bytes.writeUInt16LE(0x14c, 68); f.bytes.writeUInt16LE(0x10b, 88);
    const runtime = await f.inspect();
    expect(runtime).toMatchObject({ executable: physical, moduleRoot: path.win32.join(path.win32.dirname(physical), 'Modules'),
      architecture: 'x86', peMachine: 0x14c, pointerBytes: 4 });
    await expect(revalidateWindowsControllerRuntime(runtime, f.fs)).resolves.toBeUndefined();
  });
  it('does not turn non-Windows or custom user runtimes into system PowerShell', async () => {
    const f = fixture();
    await expect(inspectWindowsControllerRuntime(f.paths.executable, f.root, 'darwin', f.fs)).rejects.toThrow();
    await expect(inspectWindowsControllerRuntime(path.win32.join('C:\\Users', 'fixture', 'powershell.exe'),
      f.root, 'win32', f.fs)).rejects.toThrow();
  });
  it.each(['root-reparse', 'file-reparse', 'foreign-canonical', 'missing-directory', 'empty-binary', 'oversize',
    'unknown-machine', 'wrong-width', 'not-executable', 'dll', 'zero-sections', 'header-overflow', 'bad-pe', 'bad-offset'])(
    'rejects %s without a fallback', async fault => {
      const f = fixture();
      if (fault === 'root-reparse') f.directory.reparse = true;
      if (fault === 'file-reparse') f.executable.reparse = true;
      if (fault === 'foreign-canonical') f.fs.canonical = async () => 'C:\\Users\\fixture\\Modules';
      if (fault === 'missing-directory') f.directory.directory = false;
      if (fault === 'empty-binary') f.executable.size = 0;
      if (fault === 'oversize') f.executable.size = 16 * 1024 * 1024 + 1;
      if (fault === 'unknown-machine') f.bytes.writeUInt16LE(0, 68);
      if (fault === 'wrong-width') f.bytes.writeUInt16LE(0x10b, 88);
      if (fault === 'not-executable') f.bytes.writeUInt16LE(0, 86);
      if (fault === 'dll') f.bytes.writeUInt16LE(0x2002, 86);
      if (fault === 'zero-sections') f.bytes.writeUInt16LE(0, 70);
      if (fault === 'header-overflow') f.bytes.writeUInt16LE(512, 84);
      if (fault === 'bad-pe') f.bytes.writeUInt32LE(0, 64);
      if (fault === 'bad-offset') f.bytes.writeUInt32LE(0xffffffff, 0x3c);
      await expect(f.inspect()).rejects.toThrow();
    }
  );
  it('rejects metadata changes while hashing and byte/identity/ancestor drift before launch', async () => {
    const during = fixture();
    during.fs.read = async () => { during.executable.identity = 'replaced'; return during.bytes; };
    await expect(during.inspect()).rejects.toThrow();
    for (const fault of ['bytes', 'file', 'directory', 'ancestor']) {
      const f = fixture(), result = await f.inspect();
      if (fault === 'bytes') f.bytes[127] = 1;
      if (fault === 'file') f.executable.identity = 'replaced';
      if (fault === 'directory') f.directory.identity = 'replaced';
      if (fault === 'ancestor') f.directory.reparse = true;
      await expect(revalidateWindowsControllerRuntime(result, f.fs)).rejects.toThrow();
    }
    const changed = fixture(), binding = await changed.inspect();
    changed.fs.read = async () => { changed.executable.identity = 'changed-during-revalidation'; return changed.bytes; };
    await expect(revalidateWindowsControllerRuntime(binding, changed.fs)).rejects.toThrow();
  });
});
