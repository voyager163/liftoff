import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { canonicalNativeRoot, hashNativeFile, ioCode, type NativeFileSnapshot } from './native-files.js';
import { NATIVE_LAUNCHER_MAX_BYTES } from './native-launcher-limits.js';

export type LauncherObservation =
  | { path: string; state: 'absent' }
  | { path: string; state: 'file'; file: NativeFileSnapshot }
  | { path: string; state: 'link'; device: number; inode: number; mode: number; link: string; resolved: string };

export function environmentValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const keys = Object.keys(env).filter((entry) => platform === 'win32' ? entry.toLowerCase() === key.toLowerCase() : entry === key);
  if (keys.length > 1) throw new DistributionError('Ambiguous case aliases in the native process environment.', 'unsafe_path');
  return keys.length ? env[keys[0]] : undefined;
}

export async function observeLauncher(launcherPath: string): Promise<LauncherObservation> {
  const parentPath = path.dirname(launcherPath);
  const name = path.basename(launcherPath);
  const aliases = (await readdir(parentPath)).filter((entry) => entry.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase());
  if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== name) throw new DistributionError('Launcher has a case or Unicode alias.', 'unsafe_path');
  let before;
  try { before = await lstat(launcherPath); }
  catch (error) { if (ioCode(error) === 'ENOENT') return { path: launcherPath, state: 'absent' }; throw error; }
  const parent = await canonicalNativeRoot(parentPath);
  if (before.isSymbolicLink()) {
    const link = await readlink(launcherPath);
    const resolved = await realpath(launcherPath);
    const after = await lstat(launcherPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
        before.ctimeMs !== after.ctimeMs || await readlink(launcherPath) !== link) {
      throw new DistributionError('Launcher link changed while observing its target.', 'stale_plan');
    }
    return { path: launcherPath, state: 'link', device: before.dev, inode: before.ino, mode: before.mode & 0o7777, link, resolved };
  }
  return { path: launcherPath, state: 'file', file: await hashNativeFile(parent, [name], NATIVE_LAUNCHER_MAX_BYTES) };
}

export function launcherDigest(value: LauncherObservation): string { return canonicalSha256(value); }

export function pathLauncherCandidates(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform): string[] {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const pathValue = environmentValue(env, 'PATH', platform);
  if (pathValue === undefined) return [];
  const directories = pathValue.split(platform === 'win32' ? ';' : ':');
  const extensions = platform === 'win32'
    ? (environmentValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').map((entry) => entry.toLowerCase())
    : [''];
  if (directories.length > 1024 || extensions.length > 32 || extensions.some((entry) => entry && !/^\.[a-z0-9]+$/u.test(entry))) {
    throw new DistributionError('PATH or PATHEXT exceeds supported native resolution bounds.', 'unsafe_path');
  }
  return directories.flatMap((directory) => {
    const unquoted = platform === 'win32' && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
    const resolved = api.resolve(cwd, unquoted || '.');
    return extensions.map((extension) => api.join(resolved, `liftoff${extension}`));
  }).filter((entry, index, all) => all.indexOf(entry) === index);
}

export async function observePathLaunchers(env: NodeJS.ProcessEnv, cwd: string, platform = process.platform): Promise<LauncherObservation[]> {
  const result: LauncherObservation[] = [];
  for (const candidate of pathLauncherCandidates(env, cwd, platform)) {
    try {
      const observation = await observeLauncher(candidate);
      if (observation.state === 'absent') continue;
      if (platform !== 'win32' && observation.state === 'file' && (observation.file.mode & 0o111) === 0) continue;
      result.push(observation);
    } catch (error) {
      if (ioCode(error) === 'ENOENT' || ioCode(error) === 'ENOTDIR') continue;
      throw error;
    }
  }
  return result;
}
