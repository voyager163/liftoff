import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { telemetryNoticeVersion } from './contract.js';

const configDirectoryName = 'liftoff';
const configFileName = 'config.json';
let temporarySequence = 0;

type JsonObject = Record<string, unknown>;

export interface TelemetryConfigPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}

export interface TelemetryConfigFileSystem {
  readText(filePath: string): Promise<string>;
  makeDirectory(directoryPath: string): Promise<void>;
  writeExclusive(filePath: string, content: string): Promise<void>;
  replaceFile(sourcePath: string, targetPath: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
}

export interface TelemetryConfigOptions extends TelemetryConfigPathOptions {
  configPath?: string;
  fileSystem?: TelemetryConfigFileSystem;
}

export const nodeTelemetryConfigFileSystem: TelemetryConfigFileSystem = {
  readText: (filePath) => readFile(filePath, 'utf8'),
  makeDirectory: async (directoryPath) => {
    await mkdir(directoryPath, { recursive: true });
  },
  writeExclusive: async (filePath, content) => {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  },
  replaceFile: (sourcePath, targetPath) => rename(sourcePath, targetPath),
  removeFile: async (filePath) => {
    await rm(filePath, { force: true });
  }
};

type ConfigReadResult =
  | { status: 'missing'; config: JsonObject }
  | { status: 'valid'; config: JsonObject }
  | { status: 'invalid'; config: JsonObject };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function getTelemetryConfigPath(options: TelemetryConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = platformPath(platform);
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return paths.join(xdgConfigHome, configDirectoryName, configFileName);
  }

  const homedir = options.homedir ?? os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA ?? paths.join(homedir, 'AppData', 'Roaming');
    return paths.join(appData, configDirectoryName, configFileName);
  }
  return paths.join(homedir, '.config', configDirectoryName, configFileName);
}

function resolveConfigPath(options: TelemetryConfigOptions): string {
  return options.configPath ?? getTelemetryConfigPath(options);
}

async function readConfig(options: TelemetryConfigOptions): Promise<ConfigReadResult> {
  const fileSystem = options.fileSystem ?? nodeTelemetryConfigFileSystem;
  try {
    const parsed = JSON.parse(await fileSystem.readText(resolveConfigPath(options))) as unknown;
    return isJsonObject(parsed)
      ? { status: 'valid', config: parsed }
      : { status: 'invalid', config: {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', config: {} };
    }
    return { status: 'invalid', config: {} };
  }
}

export async function readTelemetryNoticeVersion(
  options: TelemetryConfigOptions = {}
): Promise<number | undefined> {
  const result = await readConfig(options);
  if (result.status !== 'valid') {
    return undefined;
  }
  const telemetry = result.config.telemetry;
  if (!isJsonObject(telemetry)) {
    return undefined;
  }
  return Number.isInteger(telemetry.noticeVersion) && Number(telemetry.noticeVersion) >= 0
    ? Number(telemetry.noticeVersion)
    : undefined;
}

export async function recordTelemetryNotice(
  options: TelemetryConfigOptions = {}
): Promise<boolean> {
  const fileSystem = options.fileSystem ?? nodeTelemetryConfigFileSystem;
  const configPath = resolveConfigPath(options);
  const result = await readConfig(options);
  if (result.status === 'invalid') {
    return false;
  }

  const existingTelemetry = isJsonObject(result.config.telemetry)
    ? result.config.telemetry
    : {};
  const config = {
    ...result.config,
    telemetry: {
      ...existingTelemetry,
      noticeVersion: telemetryNoticeVersion
    }
  };
  const paths = platformPath(options.platform ?? process.platform);
  const directory = paths.dirname(configPath);
  temporarySequence += 1;
  const temporaryPath = paths.join(
    directory,
    `.${paths.basename(configPath)}.${process.pid}.${temporarySequence}.tmp`
  );

  try {
    await fileSystem.makeDirectory(directory);
    await fileSystem.writeExclusive(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    await fileSystem.replaceFile(temporaryPath, configPath);
    return true;
  } catch {
    await fileSystem.removeFile(temporaryPath).catch(() => undefined);
    return false;
  }
}
