import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { powerAppsCodeAppStarter } from './catalogs.js';

export interface PowerAppsStarterAsset {
  logicalName: string;
  pathParts: string[];
  assetPath: string;
  sha256: string;
  provenance: 'upstream' | 'generated-lockfile';
}

export interface PowerAppsStarterCatalog {
  schemaVersion: 1;
  source: {
    repository: string;
    path: string;
    commit: string;
    archiveSha256: string;
  };
  license: {
    spdx: 'MIT';
    assetPath: string;
    sha256: string;
  };
  lockfile: {
    nodeBaseline: string;
    npmVersion: string;
    sha256: string;
  };
  files: PowerAppsStarterAsset[];
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ASSET_ROOT = `../assets/power-apps-code-app/${powerAppsCodeAppStarter.commit}/`;
const catalogUrl = new URL(`${ASSET_ROOT}catalog.json`, import.meta.url);

function hash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePathParts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty path-part array.`);
  }
  return value.map((part, index) => {
    if (
      typeof part !== 'string' ||
      part.length === 0 ||
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      part.includes('\0')
    ) {
      throw new Error(`${label}[${index}] is not a portable path part.`);
    }
    return part;
  });
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string.`);
  }
  return value;
}

function parseCatalog(): PowerAppsStarterCatalog {
  const parsed = JSON.parse(readFileSync(fileURLToPath(catalogUrl), 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error('Power Apps starter catalog must use schema version 1.');
  }
  if (!isRecord(parsed.source) || !isRecord(parsed.license) || !isRecord(parsed.lockfile)) {
    throw new Error('Power Apps starter catalog metadata is incomplete.');
  }
  const source = {
    repository: requiredString(parsed.source, 'repository', 'catalog.source'),
    path: requiredString(parsed.source, 'path', 'catalog.source'),
    commit: requiredString(parsed.source, 'commit', 'catalog.source'),
    archiveSha256: requiredString(parsed.source, 'archiveSha256', 'catalog.source')
  };
  if (
    source.repository !== powerAppsCodeAppStarter.repository ||
    source.path !== powerAppsCodeAppStarter.path ||
    source.commit !== powerAppsCodeAppStarter.commit
  ) {
    throw new Error('Power Apps starter catalog identity does not match the pinned workload catalog.');
  }
  if (!HASH_PATTERN.test(source.archiveSha256)) {
    throw new Error('Power Apps starter archive hash is invalid.');
  }

  const license = {
    spdx: requiredString(parsed.license, 'spdx', 'catalog.license'),
    assetPath: requiredString(parsed.license, 'assetPath', 'catalog.license'),
    sha256: requiredString(parsed.license, 'sha256', 'catalog.license')
  };
  if (license.spdx !== 'MIT' || !HASH_PATTERN.test(license.sha256)) {
    throw new Error('Power Apps starter license metadata is invalid.');
  }
  const lockfile = {
    nodeBaseline: requiredString(parsed.lockfile, 'nodeBaseline', 'catalog.lockfile'),
    npmVersion: requiredString(parsed.lockfile, 'npmVersion', 'catalog.lockfile'),
    sha256: requiredString(parsed.lockfile, 'sha256', 'catalog.lockfile')
  };
  if (!HASH_PATTERN.test(lockfile.sha256)) {
    throw new Error('Power Apps starter lockfile hash is invalid.');
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('Power Apps starter catalog files must be a non-empty array.');
  }

  const logicalNames = new Set<string>();
  const paths = new Set<string>();
  const files = parsed.files.map((value, index): PowerAppsStarterAsset => {
    if (!isRecord(value)) {
      throw new Error(`catalog.files[${index}] must be an object.`);
    }
    const logicalName = requiredString(value, 'logicalName', `catalog.files[${index}]`);
    const pathParts = validatePathParts(value.pathParts, `catalog.files[${index}].pathParts`);
    const assetPath = requiredString(value, 'assetPath', `catalog.files[${index}]`);
    const sha256 = requiredString(value, 'sha256', `catalog.files[${index}]`);
    const provenance = requiredString(value, 'provenance', `catalog.files[${index}]`);
    if (provenance !== 'upstream' && provenance !== 'generated-lockfile') {
      throw new Error(`catalog.files[${index}].provenance is invalid.`);
    }
    const isGitignore = pathParts.length === 1 && pathParts[0] === '.gitignore';
    const expectedAssetPath = isGitignore
      ? assetPath === 'packaged/gitignore'
      : assetPath.startsWith('starter/');
    if (!expectedAssetPath || assetPath.includes('..') || !HASH_PATTERN.test(sha256)) {
      throw new Error(`catalog.files[${index}] contains unsafe asset metadata.`);
    }
    const pathKey = pathParts.join('\0');
    if (logicalNames.has(logicalName) || paths.has(pathKey)) {
      throw new Error(`Power Apps starter catalog contains duplicate entry ${logicalName}.`);
    }
    logicalNames.add(logicalName);
    paths.add(pathKey);
    return { logicalName, pathParts, assetPath, sha256, provenance };
  });

  return {
    schemaVersion: 1,
    source,
    license: { spdx: 'MIT', assetPath: license.assetPath, sha256: license.sha256 },
    lockfile,
    files
  };
}

export const powerAppsStarterCatalog = parseCatalog();

function readVerifiedAsset(assetPath: string, expectedHash: string): string {
  const bytes = readFileSync(fileURLToPath(new URL(`${ASSET_ROOT}${assetPath}`, import.meta.url)));
  const actualHash = hash(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(`Packaged Power Apps asset ${assetPath} failed integrity validation.`);
  }
  return bytes.toString('utf8');
}

export function readPowerAppsStarterAsset(asset: PowerAppsStarterAsset): string {
  return readVerifiedAsset(asset.assetPath, asset.sha256);
}

export function readPowerAppsStarterLicense(): string {
  return readVerifiedAsset(
    powerAppsStarterCatalog.license.assetPath,
    powerAppsStarterCatalog.license.sha256
  );
}
