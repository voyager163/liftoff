import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

interface RuntimeEntry {
  identity: string;
  size: number;
  file: boolean;
  directory: boolean;
  reparse: boolean;
}
interface RuntimeFilesystem {
  inspect(file: string): Promise<RuntimeEntry>;
  canonical(file: string): Promise<string>;
  read(file: string): Promise<Uint8Array>;
}
const filesystem: RuntimeFilesystem = {
  async inspect(file) {
    const stat = await lstat(file, { bigint: true });
    return {
      identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
      size: Number(stat.size), file: stat.isFile(), directory: stat.isDirectory(), reparse: stat.isSymbolicLink()
    };
  },
  canonical: file => realpath(file),
  read: file => readFile(file)
};
export interface WindowsControllerRuntime {
  executable: string;
  moduleRoot: string;
  binaryDigest: string;
  architecture: 'x86' | 'x64' | 'arm32' | 'arm64' | 'arm64ec' | 'arm64x';
  peMachine: number;
  pointerBytes: 4 | 8;
}
const issued = new WeakMap<WindowsControllerRuntime, {
  executableIdentity: string; moduleIdentity: string; snapshot: string;
}>();
function reject(): never { throw new Error('Unsupported or changed Windows controller runtime.'); }
function samePath(left: string, right: string) { return left.toLowerCase() === right.toLowerCase(); }

export function windowsControllerRuntimePaths(systemRoot: string) {
  if (!/^[A-Za-z]:\\/.test(systemRoot) || /[\0-\x1f";]/.test(systemRoot) ||
      path.win32.normalize(systemRoot) !== systemRoot || systemRoot.endsWith('\\')) reject();
  const home = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  return { executable: path.win32.join(home, 'powershell.exe'), moduleRoot: path.win32.join(home, 'Modules') };
}

async function inspectDirectoryTree(directory: string, fs: RuntimeFilesystem) {
  let current = path.win32.parse(directory).root;
  const names = [current];
  for (const part of directory.slice(current.length).split('\\')) {
    current = path.win32.join(current, part);
    names.push(current);
  }
  let selected: RuntimeEntry | undefined;
  for (const name of names) {
    const entry = await fs.inspect(name);
    if (!entry.directory || entry.file || entry.reparse || !samePath(await fs.canonical(name), name)) reject();
    selected = entry;
  }
  return selected!;
}

const machineTypes = [
  { peMachine: 0x14c, architecture: 'x86', pointerBytes: 4 },
  { peMachine: 0x8664, architecture: 'x64', pointerBytes: 8 },
  { peMachine: 0x1c4, architecture: 'arm32', pointerBytes: 4 },
  { peMachine: 0xaa64, architecture: 'arm64', pointerBytes: 8 },
  { peMachine: 0xa641, architecture: 'arm64ec', pointerBytes: 8 },
  { peMachine: 0xa64e, architecture: 'arm64x', pointerBytes: 8 }
] as const;

/** Captures the actual system image, including OS redirection, not the Node caller's architecture. */
export async function inspectWindowsControllerRuntime(
  executable: string, systemRoot: string,
  platform: NodeJS.Platform = process.platform,
  fs: RuntimeFilesystem = filesystem
): Promise<WindowsControllerRuntime> {
  if (platform !== 'win32') reject();
  const expected = windowsControllerRuntimePaths(systemRoot);
  if (!samePath(executable, expected.executable) || path.win32.normalize(executable) !== executable) reject();
  const actualExecutable = await fs.canonical(executable);
  const redirected = path.win32.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!samePath(actualExecutable, expected.executable) && !samePath(actualExecutable, redirected)) reject();
  const moduleRoot = path.win32.join(path.win32.dirname(actualExecutable), 'Modules');
  const module = await inspectDirectoryTree(moduleRoot, fs);
  // Read through the canonical system path rather than introducing a search fallback.
  executable = actualExecutable;
  const before = await fs.inspect(executable);
  if (!before.file || before.directory || before.reparse || before.size < 64 || before.size > 16 * 1024 * 1024 ||
      !samePath(await fs.canonical(executable), executable)) reject();
  const bytes = Buffer.from(await fs.read(executable));
  if (bytes.length !== before.size || bytes.readUInt16LE(0) !== 0x5a4d) reject();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550) reject();
  const machine = machineTypes.find(value => value.peMachine === bytes.readUInt16LE(pe + 4));
  const sections = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20);
  const characteristics = bytes.readUInt16LE(pe + 22), magic = bytes.readUInt16LE(pe + 24);
  if (!machine || sections < 1 || sections > 96 || optionalSize < (machine.pointerBytes === 4 ? 96 : 112) ||
      pe + 24 + optionalSize > bytes.length || !(characteristics & 2) || (characteristics & 0x2000) ||
      magic !== (machine.pointerBytes === 4 ? 0x10b : 0x20b)) reject();
  const after = await fs.inspect(executable), finalModule = await inspectDirectoryTree(moduleRoot, fs);
  if (after.identity !== before.identity || finalModule.identity !== module.identity) reject();
  const result: WindowsControllerRuntime = Object.freeze({
    executable, moduleRoot, binaryDigest: createHash('sha256').update(bytes).digest('hex'), ...machine
  });
  issued.set(result, { executableIdentity: before.identity, moduleIdentity: module.identity, snapshot: JSON.stringify(result) });
  return result;
}

export async function revalidateWindowsControllerRuntime(runtime: WindowsControllerRuntime, fs: RuntimeFilesystem = filesystem) {
  const original = issued.get(runtime);
  if (!original || original.snapshot !== JSON.stringify(runtime)) reject();
  const module = await inspectDirectoryTree(runtime.moduleRoot, fs), executable = await fs.inspect(runtime.executable);
  if (module.identity !== original.moduleIdentity || executable.identity !== original.executableIdentity ||
      !executable.file || executable.reparse || !samePath(await fs.canonical(runtime.executable), runtime.executable) ||
      createHash('sha256').update(await fs.read(runtime.executable)).digest('hex') !== runtime.binaryDigest) reject();
  if ((await fs.inspect(runtime.executable)).identity !== original.executableIdentity ||
      (await inspectDirectoryTree(runtime.moduleRoot, fs)).identity !== original.moduleIdentity) reject();
}
