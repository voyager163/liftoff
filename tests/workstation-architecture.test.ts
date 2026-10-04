import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';
import * as facade from '../src/workstation.js';
import * as probeEngine from '../src/application/workstation/probe.js';
import * as remediationEngine from '../src/application/workstation/remediation.js';
import * as remediationRules from '../src/domain/workstation/remediation.js';
import * as versions from '../src/domain/workstation/versions.js';
import * as hostEnvironment from '../src/adapters/filesystem/host-environment.js';
import * as executables from '../src/adapters/filesystem/executables.js';
import { EngineHarness, requirementFor } from './fixtures/workstation-engine.js';

const sourceRoot = path.resolve('src');
type ModuleNode = {
  type: string; source?: { value: unknown }; importKind?: string; exportKind?: string; kind?: string;
  specifiers?: Array<{ importKind?: string; exportKind?: string }>;
  declaration?: ModuleNode | null; id?: { name: string } | null;
  declarations?: Array<{ id: { name: string }; init?: { type: string; callee?: { name?: string } } | null }>;
};

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

function declaredNames(node: ModuleNode): string[] {
  const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node.type === 'ImportDeclaration' ? null : node;
  if (!declaration) return [];
  return declaration.declarations?.map((item) => item.id.name) ?? [declaration.id?.name ?? `<${declaration.type}>`];
}

const engineModules = async () => [
  ...await sourceFiles(path.join(sourceRoot, 'domain', 'workstation')),
  ...await sourceFiles(path.join(sourceRoot, 'application', 'workstation')),
  path.join(sourceRoot, 'adapters', 'filesystem', 'host-environment.ts')
];

const frozenRuntimeNames = [
  'blockingReadinessFailures', 'compareRequirementObservations', 'detectHostEnvironment', 'extractVersion',
  'installRequirement', 'nativeExecutableObserver', 'parseLinuxFamily', 'probeRequirement', 'probeWorkstation',
  'selectLiftoffRuntimeRequirements', 'selectRemediation', 'selectWorkstationRequirements', 'workstationScopeReadiness'
];

describe('workstation compatibility facade', () => {
  it('preserves pre-extraction aliases and explicitly adds current requirement selection', () => {
    expect(Object.keys(facade).sort()).toEqual([...frozenRuntimeNames, 'selectCurrentWorkstationRequirements'].sort());
    const canonical: Record<string, Record<string, unknown>> = {
      probeRequirement: probeEngine, probeWorkstation: probeEngine,
      selectRemediation: remediationEngine, installRequirement: remediationEngine,
      compareRequirementObservations: remediationRules, parseLinuxFamily: remediationRules,
      detectHostEnvironment: hostEnvironment, extractVersion: versions, nativeExecutableObserver: executables
    };
    for (const [name, module] of Object.entries(canonical)) {
      expect(module[name], name).toBeDefined();
      expect((facade as Record<string, unknown>)[name], name).toBe(module[name]);
    }
  });

  it('implements only the deferred requirement selection and readiness rules itself', async () => {
    const nodes = await moduleNodes(path.join(sourceRoot, 'workstation.ts'));
    expect(nodes.flatMap(declaredNames).sort()).toEqual([
      'REQUIREMENT_ORDER', 'RequirementSelectionOptions', 'WorkstationRequirementSelection', 'WorkstationScopeReadiness',
      'blockingReadinessFailures', 'resolveWorkstationRequirements', 'selectCurrentWorkstationRequirements',
      'selectLiftoffRuntimeRequirements', 'selectWorkstationRequirements', 'workstationScopeReadiness'
    ]);
    expect(nodes.every((node) => ['ImportDeclaration', 'ExportNamedDeclaration', 'VariableDeclaration', 'FunctionDeclaration'].includes(node.type))).toBe(true);
  });

  it('shares one in-process remediation attempt ledger between the facade and the canonical module', async () => {
    const harness = new EngineHarness('darwin');
    const requirement = requirementFor('node');
    const formula = requirement.definition.packageIdentities!.brew!;
    const runner = harness.runner({ 'brew --version': 'Homebrew 4.6.0\n', [`brew install ${formula}`]: 'installed\n', [`brew --prefix ${formula}`]: '\n' });
    const before = await facade.probeRequirement(requirement, runner, harness.options());
    const context = { ...harness.options(), host: harness.options().host!, authorized: true, runner };
    expect(await facade.installRequirement(requirement, before, context)).toMatchObject({ state: 'unchanged', reasonCode: 'no-progress' });
    const ran = harness.events.length;
    const repeated = await remediationEngine.installRequirement(requirement, before, context);
    expect(repeated).toMatchObject({ state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged' });
    expect(repeated.detail).toContain('it was not run again');
    expect(harness.events.slice(ran)).toEqual([]);
  });
});

describe('workstation engine responsibility boundaries', () => {
  it('never routes the extracted engine back through a root compatibility facade', async () => {
    const violations: string[] = [];
    for (const file of await engineModules()) {
      for (const { target } of await dependencies(file)) {
        if (['workstation.ts', 'self-upgrade.ts', 'package-identity.ts'].includes(target)) {
          violations.push(`${path.relative(sourceRoot, file)} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps workstation rules free of adapters, application, CLI and I/O even at the type level', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(sourceRoot, 'domain', 'workstation'))) {
      for (const { target, runtime } of await dependencies(file)) {
        const layer = target.split(path.sep)[0]!;
        if (['adapters', 'application', 'cli'].includes(layer) || runtime && (target.startsWith('node:')
          ? !['node:path', 'node:util'].includes(target) : !target.startsWith(`domain${path.sep}`))) {
          violations.push(`${path.relative(sourceRoot, file)} -> ${target}${runtime ? '' : ' (type)'}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps host detection an adapter over domain rules only', async () => {
    const dependencySet = await dependencies(path.join(sourceRoot, 'adapters', 'filesystem', 'host-environment.ts'));
    expect(dependencySet).toEqual([
      { target: 'node:fs/promises', runtime: true },
      { target: path.join('domain', 'workstation', 'contracts.ts'), runtime: false },
      { target: path.join('domain', 'workstation', 'remediation.ts'), runtime: true }
    ]);
  });

  it('keeps the application engine off CLI transport and terminal presentation', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(sourceRoot, 'application', 'workstation'))) {
      for (const { target, runtime } of await dependencies(file)) {
        if (runtime && (target === 'terminal.ts' || target.split(path.sep)[0] === 'cli')) {
          violations.push(`${path.relative(sourceRoot, file)} -> ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('holds module-level collections only as constant lookups and the single attempt ledger', async () => {
    const collections: string[] = [];
    for (const file of [...await engineModules(), path.join(sourceRoot, 'workstation.ts')]) {
      for (const node of await moduleNodes(file)) {
        const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
        if (declaration?.type !== 'VariableDeclaration') continue;
        expect(declaration.kind, path.relative(sourceRoot, file)).toBe('const');
        for (const item of declaration.declarations ?? []) {
          if (item.init?.type === 'NewExpression' && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(item.init.callee?.name ?? '')) {
            collections.push(`${path.relative(sourceRoot, file)}:${item.id.name}:${item.init.callee!.name}`);
          }
        }
      }
    }
    expect(collections.sort()).toEqual([
      `${path.join('application', 'workstation', 'remediation.ts')}:attemptsByRunner:WeakMap`,
      `${path.join('domain', 'workstation', 'probe-classification.ts')}:MISSING_ERROR_CODES:Set`,
      `${path.join('domain', 'workstation', 'versions.ts')}:agentIds:Set`
    ]);
  });
});
