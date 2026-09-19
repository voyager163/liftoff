import { readFileSync } from 'node:fs';
import { resolvePackageFileUrl } from './package-root.js';

export const suppliedPolicy = readFileSync(
  resolvePackageFileUrl('assets', 'governance', 'single-maintainer-gitflow', 'policy.md'),
  'utf8'
).replace(/\r\n/g, '\n').trimEnd();
