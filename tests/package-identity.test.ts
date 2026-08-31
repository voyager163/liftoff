import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalManualInstallCommand,
  canonicalNpmRegistry,
  exactGlobalInstallCommand,
  liftoffBinaryName,
  liftoffPackageName,
  stableNpmTag,
  supportedNpmVersion
} from '../src/package-identity.js';
import { CANONICAL_NPM_REGISTRY } from '../src/published-verifier.js';
import { supportedStack } from '../src/supported-stack.js';

describe('canonical Liftoff package identity', () => {
  it('shares package, registry, stable channel, and npm baseline constants', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    expect(liftoffPackageName).toBe(packageJson.name);
    expect(liftoffBinaryName).toBe('liftoff');
    expect(packageJson.bin[liftoffBinaryName]).toBe('dist/cli.js');
    expect(canonicalNpmRegistry).toBe('https://registry.npmjs.org');
    expect(CANONICAL_NPM_REGISTRY).toBe(canonicalNpmRegistry);
    expect(stableNpmTag).toBe('latest');
    expect(supportedNpmVersion).toBe(
      supportedStack.packageManagers.npm.version
    );
  });

  it('renders exact automatic and canonical manual install commands', () => {
    expect(exactGlobalInstallCommand('1.2.3')).toBe(
      'npm install --global --ignore-scripts --no-audit --no-fund @msn-control/liftoff@1.2.3'
    );
    expect(canonicalManualInstallCommand()).toBe(
      'npm install --global --ignore-scripts --no-audit --no-fund @msn-control/liftoff@latest --registry=https://registry.npmjs.org'
    );
  });
});
