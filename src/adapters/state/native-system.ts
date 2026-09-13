import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  type NativeLocalStateTools, type StateRegisteredExecutable
} from '../../domain/repair/stateful.js';
import { stateAssert, stateDigest, stateObjectDigest } from '../../domain/repair/stateful-invariants.js';
import { OwnedPrivateStateProcessRunner, spawnOwnedStateProcess } from './owned-process.js';

export const nativeLocalStateProtocol = Object.freeze({
  version: 'opentofu-1.12.6-posix-fcntl' as const,
  tofuVersion: '1.12.6' as const,
  sourceCommit: 'b4305e5a5dd2fb79a27897ae30784a181d3a26cb',
  lockSource: 'internal/flock/filesystem_lock_unix.go',
  lockBlob: 'c396e445a0eede26b32b97068216fe3691070d9f',
  stateSource: 'internal/states/statemgr/filesystem.go',
  stateBlob: '3f01209ea1635c9cad5f499f4f08ce356aef9a4c',
  lockOperation: 'F_SETLK/F_WRLCK/start=0/length=0',
  writeOperation: 'seek/truncate/write/sync on the same open inode'
});

export function nativeStateHostId(): string {
  return `native-host:${stateObjectDigest({ platform: process.platform, host: hostname(), uid: process.getuid?.() ?? null })}`;
}

export async function captureStateExecutable(filename: string): Promise<StateRegisteredExecutable> {
  stateAssert(path.isAbsolute(filename), 'tool-unavailable');
  const resolved = await realpath(filename);
  const info = await lstat(resolved);
  stateAssert(info.isFile() && (info.mode & 0o022) === 0 && (info.mode & 0o111) !== 0, 'tool-unavailable');
  return { path: resolved, sha256: stateDigest(await readFile(resolved)) };
}

export async function verifyStateExecutable(executable: StateRegisteredExecutable): Promise<void> {
  stateAssert((await captureStateExecutable(executable.path)).sha256 === executable.sha256, 'tool-unavailable');
}

export function isolatedStateEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: cwd, USERPROFILE: cwd,
    XDG_CONFIG_HOME: cwd, TMPDIR: cwd, TMP: cwd, TEMP: cwd,
    CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1', TF_LOG: 'OFF',
    TF_CLI_CONFIG_FILE: path.join(cwd, 'liftoff.private.tfrc'),
    TF_DATA_DIR: path.join(cwd, '.terraform'), LC_ALL: 'C'
  };
}

export async function startPrivateStateProcess(
  executable: StateRegisteredExecutable,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = isolatedStateEnvironment(cwd),
  role: 'command' | 'lease' = 'command'
): Promise<ChildProcessWithoutNullStreams> {
  await verifyStateExecutable(executable);
  stateAssert(path.isAbsolute(cwd) && args.every((arg) => !arg.includes('\0')), 'unsafe-path');
  return spawnOwnedStateProcess({ executable: executable.path, args, cwd, environment, role });
}

export async function runPrivateStateProcess(request: {
  executable: StateRegisteredExecutable;
  args: readonly string[];
  cwd: string;
  stdin?: Uint8Array;
  timeoutMs?: number;
  maximumBytes?: number;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const timeout = request.timeoutMs ?? 20_000;
  stateAssert(timeout > 0 && timeout <= 300_000, 'invalid-binding');
  await verifyStateExecutable(request.executable);
  return new OwnedPrivateStateProcessRunner().run({
    executable: request.executable.path, args: request.args, cwd: request.cwd,
    environment: request.environment ?? isolatedStateEnvironment(request.cwd), stdin: request.stdin,
    signal: request.signal, timeoutMs: timeout, maximumBytes: request.maximumBytes ?? 2 * 1024 * 1024
  });
}

export async function inspectNativeLocalStateTools(request: {
  pythonPath: string;
  tofuPath: string;
  workingDirectory: string;
  signal?: AbortSignal;
}): Promise<NativeLocalStateTools> {
  stateAssert(process.platform === 'darwin', 'unsupported-native-platform');
  const python = await captureStateExecutable(request.pythonPath);
  const tofu = await captureStateExecutable(request.tofuPath);
  const py = await runPrivateStateProcess({
    executable: python, args: ['-I', '-S', '-B', '-c', 'import json,platform,sys; print(json.dumps({"implementation":platform.python_implementation(),"version":".".join(map(str,sys.version_info[:3]))}))'],
    cwd: request.workingDirectory, signal: request.signal
  });
  let pythonVersion: string;
  try {
    const info = JSON.parse(Buffer.from(py.stdout).toString('utf8'));
    stateAssert(py.exitCode === 0 && info.implementation === 'CPython' && /^3\.14\.\d+$/.test(info.version), 'native-lock-provider-required');
    pythonVersion = info.version;
  } finally { py.stdout.fill(0); py.stderr.fill(0); }
  const tf = await runPrivateStateProcess({
    executable: tofu, args: ['version', '-json'], cwd: request.workingDirectory, signal: request.signal
  });
  try {
    const info = JSON.parse(Buffer.from(tf.stdout).toString('utf8'));
    stateAssert(tf.exitCode === 0 && info.terraform_version === nativeLocalStateProtocol.tofuVersion
      && info.platform === `darwin_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`, 'unqualified-combination');
  } finally { tf.stdout.fill(0); tf.stderr.fill(0); }
  return { python, tofu, pythonVersion, tofuVersion: '1.12.6', hostId: nativeStateHostId() };
}
