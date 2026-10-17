import type { BigIntStats, Stats } from 'node:fs';
import { lstat, mkdtemp, open, readlink, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NodeCommandRunner,
  type CommandRunner
} from '../../process-runner.js';
import {
  lookupStableRelease,
  type StableRelease
} from '../../stable-release.js';
import type { NativeUpgradePort } from '../../domain/distribution/native-upgrade.js';

export interface SelfUpgradeDependencies {
  runner: CommandRunner;
  lookupStableRelease(): Promise<StableRelease>;
  makeNeutralDirectory(): Promise<string>;
  removeNeutralDirectory(directory: string): Promise<void>;
  readJson(filePath: string): Promise<unknown>;
  lstat(filePath: string): Promise<Stats>;
  lstatBigInt?(filePath: string): Promise<BigIntStats>;
  realpath(filePath: string): Promise<string>;
  platform: NodeJS.Platform;
  architecture?: string;
  probeTimeoutMs?: number;
  execPath: string;
  environment: NodeJS.ProcessEnv;
  nativeUpgrade?: NativeUpgradePort;
  readBytes?(filePath: string, maximum: number): Promise<Buffer>;
  readlink?(filePath: string): Promise<string>;
  runningExecutable?: string;
  resolveLiftoff?: () => Promise<string | null>;
}

export async function readUpgradeBytes(filePath: string, maximum: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid upgrade material bound.');
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) {
    throw new Error('Upgrade material must be a bounded single-link regular file.');
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const same = (observed: BigIntStats) => {
      for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const) {
        if (observed[key] !== before[key]) throw new Error('Upgrade material changed during inspection.');
      }
    };
    same(await handle.stat({ bigint: true }));
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error('Upgrade material was truncated.');
      offset += read.bytesRead;
    }
    same(await handle.stat({ bigint: true }));
    same(await lstat(filePath, { bigint: true }));
    if (BigInt(bytes.length) !== before.size || bytes.length > maximum) throw new Error('Upgrade material changed.');
    return bytes;
  } finally {
    await handle.close();
  }
}

export function defaultSelfUpgradeDependencies(environment: NodeJS.ProcessEnv = process.env): SelfUpgradeDependencies {
  const scratch = new Map<string, BigIntStats>();
  return {
    runner: new NodeCommandRunner(),
    lookupStableRelease,
    makeNeutralDirectory: async () => {
      const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-upgrade-')));
      scratch.set(directory, await lstat(directory, { bigint: true }));
      return directory;
    },
    removeNeutralDirectory: async directory => {
      const expected = scratch.get(directory);
      const actual = await lstat(directory, { bigint: true });
      if (!expected || !actual.isDirectory() || actual.isSymbolicLink() || await realpath(directory) !== directory ||
        (['dev', 'ino', 'uid', 'gid', 'mode', 'birthtimeNs'] as const).some(key => actual[key] !== expected[key])) {
        throw new Error('Upgrade scratch ownership changed; material retained.');
      }
      await rm(directory, { recursive: true });
      scratch.delete(directory);
    },
    readJson: async (filePath) =>
      JSON.parse((await readUpgradeBytes(filePath, 8 * 1024 * 1024)).toString('utf8')) as unknown,
    readBytes: readUpgradeBytes,
    readlink,
    lstat,
    lstatBigInt: filePath => lstat(filePath, { bigint: true }),
    realpath,
    platform: process.platform,
    architecture: process.arch,
    execPath: process.execPath,
    environment,
    runningExecutable: process.argv[1],
    resolveLiftoff: () => resolveSelectedLiftoff(environment, process.platform)
  };
}

export async function resolveSelectedLiftoff(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const candidates = platform === 'win32' ? ['liftoff.exe', 'liftoff.com', 'liftoff.cmd', 'liftoff.bat'] : ['liftoff'];
  const paths = Object.entries(env).filter(([key]) => key.toLowerCase() === 'path');
  if (paths.length !== 1) throw new Error('Ambiguous executable search environment.');
  const selectedPath = paths[0][1];
  for (const directory of (selectedPath ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (!directory || !api.isAbsolute(directory)) throw new Error('Ambiguous executable search directory.');
    for (const candidate of candidates) {
      const file = api.join(directory, candidate);
      try {
        const details = await lstat(file);
        if (!details.isFile() && !details.isSymbolicLink()) throw new Error('Selected launcher is not a file.');
        if (platform !== 'win32' && !(details.mode & 0o111)) continue;
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return null;
}
