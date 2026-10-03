import type { Stats } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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

export interface SelfUpgradeDependencies {
  runner: CommandRunner;
  lookupStableRelease(): Promise<StableRelease>;
  makeNeutralDirectory(): Promise<string>;
  removeNeutralDirectory(directory: string): Promise<void>;
  readJson(filePath: string): Promise<unknown>;
  lstat(filePath: string): Promise<Stats>;
  realpath(filePath: string): Promise<string>;
  platform: NodeJS.Platform;
  execPath: string;
  environment: NodeJS.ProcessEnv;
}

export function defaultSelfUpgradeDependencies(): SelfUpgradeDependencies {
  return {
    runner: new NodeCommandRunner(),
    lookupStableRelease,
    makeNeutralDirectory: () =>
      mkdtemp(path.join(os.tmpdir(), 'liftoff-upgrade-')),
    removeNeutralDirectory: (directory) =>
      rm(directory, { recursive: true, force: true }),
    readJson: async (filePath) =>
      JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    lstat,
    realpath,
    platform: process.platform,
    execPath: process.execPath,
    environment: process.env
  };
}
