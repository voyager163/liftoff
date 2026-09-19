import { readFileSync } from 'node:fs';
import { resolvePackageFile } from './adapters/packaged-assets/package-root.js';

export const liftoffVersion: string = (
  JSON.parse(readFileSync(resolvePackageFile('package.json'), 'utf8')) as { version: string }
).version;
