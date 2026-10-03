import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';
import * as selfUpgradeFacade from '../src/self-upgrade.js';
import * as identityFacade from '../src/package-identity.js';
import * as identity from '../src/domain/distribution/liftoff-package.js';
import * as contract from '../src/domain/distribution/liftoff-upgrade.js';
import * as npmRules from '../src/domain/distribution/liftoff-npm-installation.js';
import * as orchestration from '../src/application/upgrade/self-upgrade.js';
import { packagedSupportedStack } from '../src/adapters/packaged-assets/supported-stack.js';

const sourceRoot = path.resolve('src');
type ModuleNode = { type: string; source?: { value: unknown }; importKind?: string; exportKind?: string;
  specifiers?: Array<{ importKind?: string; exportKind?: string }>; declaration?: unknown };

async function moduleNodes(file: string): Promise<ModuleNode[]> {
  return parseAst(await readFile(file, 'utf8'), { lang: 'ts' }, file).body as unknown as ModuleNode[];
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith('.ts') ? [absolute] : [];
  }))).flat().sort();
}

/** Every static import/export source with whether it survives type erasure. */
async function dependencies(file: string): Promise<Array<{ target: string; runtime: boolean }>> {
  return (await moduleNodes(file)).flatMap((node) => {
    if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) return [];
    const specifier = String(node.source.value);
    if (!specifier.startsWith('.')) return [{ target: specifier, runtime: true }];
    const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/u, '.ts'));
    const typeOnly = node.importKind === 'type' || node.exportKind === 'type' ||
      (node.specifiers?.length ?? 0) > 0 && node.specifiers!.every((item) => item.importKind === 'type' || item.exportKind === 'type');
    return [{ target: path.relative(sourceRoot, resolved), runtime: !typeOnly }];
  });
}

const facadeRuntimeNames = [
  'buildGlobalNpmInstallCommand', 'checkConfiguredRegistryTarget', 'expectedGlobalPackageRoot', 'pathIsContained',
  'runSelfUpgrade', 'selfUpgradeExitCode', 'selfUpgradeInstallTimeoutMs', 'selfUpgradeProbeTimeoutMs',
  'selfUpgradeRemedy', 'selfUpgradeSchemaVersion', 'selfUpgradeSummary', 'selfUpgradeVerificationTimeoutMs'
];
const identityNames = [
  'canonicalManualInstallCommand', 'canonicalNpmRegistry', 'exactGlobalInstallCommand', 'liftoffBinaryName',
  'liftoffPackageName', 'liftoffPackageScope', 'liftoffScopedRegistryKey', 'npmExecutableForPlatform',
  'npmRegistryOverrideArgs', 'stableNpmTag'
];

describe('CLI self-upgrade compatibility facades', () => {
  it('keeps the exact pre-extraction runtime export set as direct aliases of canonical modules', () => {
    expect(Object.keys(selfUpgradeFacade).sort()).toEqual(facadeRuntimeNames);
    const canonical: Record<string, unknown> = { ...contract, ...npmRules, ...orchestration };
    for (const name of facadeRuntimeNames) {
      expect(canonical[name], name).toBeDefined();
      expect((selfUpgradeFacade as Record<string, unknown>)[name], name).toBe(canonical[name]);
    }
  });

  it('keeps package identity names aliased while the packaged npm version stays adapter-derived', () => {
    expect(Object.keys(identityFacade).sort()).toEqual([...identityNames, 'supportedNpmVersion'].sort());
    for (const name of identityNames) {
      expect((identityFacade as Record<string, unknown>)[name], name).toBe((identity as Record<string, unknown>)[name]);
    }
    expect(Object.keys(identity).sort()).toEqual(identityNames);
    expect(identityFacade.supportedNpmVersion).toBe(packagedSupportedStack.packageManagers.npm.version);
  });

  it('keeps implementation out of the facades', async () => {
    for (const node of await moduleNodes(path.join(sourceRoot, 'self-upgrade.ts'))) {
      expect(node.type).toBe('ExportNamedDeclaration');
      expect(node.source, 'self-upgrade.ts only re-exports').toBeDefined();
    }
    const identityNodes = await moduleNodes(path.join(sourceRoot, 'package-identity.ts'));
    expect(identityNodes.map((node) => [node.type, Boolean(node.source), Boolean(node.declaration)])).toEqual([
      ['ImportDeclaration', true, false],
      ['ExportNamedDeclaration', true, false],
      ['ExportNamedDeclaration', false, true]
    ]);
  });
});

describe('CLI self-upgrade responsibility boundaries', () => {
  it('never routes canonical modules or migrated consumers back through the facades', async () => {
    const consumers = [
      ...await sourceFiles(path.join(sourceRoot, 'domain', 'distribution')),
      ...await sourceFiles(path.join(sourceRoot, 'adapters', 'distribution')),
      ...await sourceFiles(path.join(sourceRoot, 'application', 'upgrade')),
      path.join(sourceRoot, 'cli', 'commands', 'upgrade.ts'),
      path.join(sourceRoot, 'application', 'diagnose', 'doctor.ts'),
      path.join(sourceRoot, 'stable-release.ts')
    ];
    const violations: string[] = [];
    for (const file of consumers) {
      for (const { target } of await dependencies(file)) {
        if (target === 'self-upgrade.ts' || target === 'package-identity.ts') violations.push(`${path.relative(sourceRoot, file)} -> ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps distribution rules free of adapters, application, CLI and I/O even at the type level', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(sourceRoot, 'domain', 'distribution'))) {
      for (const { target, runtime } of await dependencies(file)) {
        const layer = target.split(path.sep)[0];
        if (['adapters', 'application', 'cli'].includes(layer!) ||
            runtime && (target.startsWith('node:') && target !== 'node:path' || !target.startsWith('node:') && !target.startsWith('domain'))) {
          violations.push(`${path.relative(sourceRoot, file)} -> ${target}${runtime ? '' : ' (type)'}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps distribution adapters independent of application and CLI', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(sourceRoot, 'adapters', 'distribution'))) {
      for (const { target } of await dependencies(file)) {
        if (['application', 'cli'].includes(target.split(path.sep)[0]!)) violations.push(`${path.relative(sourceRoot, file)} -> ${target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('renders upgrade results only in the CLI', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(sourceRoot, 'application', 'upgrade'))) {
      for (const { target, runtime } of await dependencies(file)) {
        if (runtime && (target === 'terminal.ts' || target === 'process-runner.ts' || target.split(path.sep)[0] === 'cli')) {
          violations.push(`${path.relative(sourceRoot, file)} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
    const cli = await readFile(path.join(sourceRoot, 'cli', 'commands', 'upgrade.ts'), 'utf8');
    expect(cli).toContain('export function renderSelfUpgradeResult(');
    expect(await readFile(path.join(sourceRoot, 'application', 'upgrade', 'use-case.ts'), 'utf8')).not.toContain('presentation');
  });
});
