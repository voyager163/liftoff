import { readFileSync } from 'node:fs';
import { resolvePackageFileUrl } from './package-root.js';

// The supplied single-maintainer standard is read once when governance rendering loads.
export const packagedGovernancePolicy = readFileSync(
  resolvePackageFileUrl('assets', 'governance', 'single-maintainer-gitflow', 'policy.md'),
  'utf8'
).replace(/\r\n/g, '\n').trimEnd();
