import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves from src/ (tests), dist/ (built), and the packed npm layout alike:
// package.json is always one level above this module's directory.
const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const liftoffVersion: string = (JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }).version;
