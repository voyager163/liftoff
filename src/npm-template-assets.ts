import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type NpmTemplateId = 'node-backend' | 'frontend';

interface NpmPackageTemplate extends Record<string, unknown> {
  name: string;
}

interface NpmLockTemplate extends Record<string, unknown> {
  name: string;
  packages: Record<string, Record<string, unknown>>;
}

function readAsset<T>(template: NpmTemplateId, file: string): T {
  const assetPath = fileURLToPath(new URL(`../assets/locks/${template}/${file}`, import.meta.url));
  return JSON.parse(readFileSync(assetPath, 'utf8')) as T;
}

const packageTemplates: Record<NpmTemplateId, NpmPackageTemplate> = {
  'node-backend': readAsset<NpmPackageTemplate>('node-backend', 'package.json'),
  frontend: readAsset<NpmPackageTemplate>('frontend', 'package.json')
};

const lockTemplates: Record<NpmTemplateId, NpmLockTemplate> = {
  'node-backend': readAsset<NpmLockTemplate>('node-backend', 'package-lock.json'),
  frontend: readAsset<NpmLockTemplate>('frontend', 'package-lock.json')
};

export function renderNpmPackage(template: NpmTemplateId, name: string): string {
  return JSON.stringify({ ...packageTemplates[template], name }, null, 2);
}

export function renderNpmLock(template: NpmTemplateId, name: string): string {
  const lock = lockTemplates[template];
  return JSON.stringify({
    ...lock,
    name,
    packages: {
      ...lock.packages,
      '': {
        ...lock.packages[''],
        name
      }
    }
  }, null, 2);
}
