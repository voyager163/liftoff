import path from 'node:path';
import { SelfUpgradeFailure } from '../../domain/distribution/liftoff-upgrade.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';

export function createCaskFileObservation(dependencies: SelfUpgradeDependencies, prefix: string, signal: AbortSignal) {
  const directories = new Map<string, string>();
  const files = new Map<string, { bytes: Buffer; maximum: number }>();
  const invalid = () => new SelfUpgradeFailure('blocked', 'unsupported_installation');
  const changed = () => new SelfUpgradeFailure('blocked', 'owner_changed');
  if (prefix !== '/opt/homebrew' && prefix !== '/usr/local') throw invalid();
  const checkSignal = () => {
    if (signal.aborted) throw new SelfUpgradeFailure('failed', 'native_unavailable');
  };
  const directoryIdentity = async (directory: string) => {
    checkSignal();
    const stat = await dependencies.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await dependencies.realpath(directory) !== directory) throw invalid();
    checkSignal();
    return JSON.stringify([stat.dev, stat.ino, stat.uid, stat.mode]);
  };
  const inspectDirectories = async (directory: string) => {
    const relative = path.posix.relative(prefix, directory);
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) throw invalid();
    for (const item of [prefix, ...relative.split('/').map((_, index, parts) =>
      path.posix.join(prefix, ...parts.slice(0, index + 1)))]) {
      const identity = await directoryIdentity(item);
      const before = directories.get(item);
      if (before && before !== identity) throw changed();
      directories.set(item, identity);
    }
  };
  const file = async (filename: string, maximum: number) => {
    if (!dependencies.readBytes) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
    await inspectDirectories(path.posix.dirname(filename));
    const stat = await dependencies.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || await dependencies.realpath(filename) !== filename) throw invalid();
    const bytes = await dependencies.readBytes(filename, maximum);
    if (bytes.length > maximum) throw invalid();
    checkSignal();
    const before = files.get(filename);
    if (before && !before.bytes.equals(bytes)) throw changed();
    files.set(filename, { bytes: Buffer.from(bytes), maximum });
    return bytes;
  };
  return {
    checkSignal, inspectDirectories, file,
    recheck: async () => {
      for (const [filename, before] of files) await file(filename, before.maximum);
      for (const [directory, before] of directories) {
        if (await directoryIdentity(directory) !== before) throw changed();
      }
    },
    identity: () => JSON.stringify([...directories])
  };
}
