import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';
import {
  installedPackageRoot,
  resolvePackageFile,
  resolvePackageFileUrl
} from '../src/adapters/packaged-assets/package-root.js';
import {
  explicitArtifactLifecycleIdentities
} from '../src/domain/project/artifact-lifecycle.js';
import { createProjectCatalog } from '../src/domain/project/catalog.js';

interface RuntimeDependency {
  specifier: string;
  target?: string;
}

type ParsedAst = ReturnType<typeof parseAst>;
type AstNode = ParsedAst['body'][number];
type StaticModuleNode = Extract<
  AstNode,
  {
    type:
      | 'ImportDeclaration'
      | 'ExportAllDeclaration'
      | 'ExportNamedDeclaration';
  }
>;

const sourceRoot = path.resolve('src');
const ioBuiltins = new Set([
  'node:child_process',
  'node:dgram',
  'node:dns',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:tls'
]);
const ioRootModules = new Set([
  'file-system.ts',
  'init-filesystem.ts',
  'process-runner.ts',
  'project-dependencies.ts',
  'published-verifier.ts',
  'self-upgrade.ts',
  'workstation.ts'
]);

async function sourceFiles(root = sourceRoot): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function isStaticModuleNode(node: AstNode): node is StaticModuleNode {
  return (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'ExportNamedDeclaration'
  );
}

function hasRuntimeBinding(node: StaticModuleNode): boolean {
  if (
    ('importKind' in node && node.importKind === 'type') ||
    ('exportKind' in node && node.exportKind === 'type')
  ) {
    return false;
  }
  if (!('specifiers' in node) || node.specifiers.length === 0) return true;
  return node.specifiers.some((specifier) =>
    !('importKind' in specifier) || specifier.importKind !== 'type'
  );
}

function resolveSourceImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(from), specifier);
  const candidate = resolved.endsWith('.js')
    ? `${resolved.slice(0, -3)}.ts`
    : resolved.endsWith('.ts')
      ? resolved
      : `${resolved}.ts`;
  return candidate.startsWith(`${sourceRoot}${path.sep}`) ? candidate : undefined;
}

async function runtimeDependencies(file: string): Promise<RuntimeDependency[]> {
  const source = await readFile(file, 'utf8');
  const ast = parseAst(source, { lang: 'ts' }, file);
  return ast.body.flatMap((node): RuntimeDependency[] => {
    if (
      !isStaticModuleNode(node) ||
      !node.source ||
      !hasRuntimeBinding(node)
    ) {
      return [];
    }
    const specifier = node.source.value;
    return typeof specifier === 'string'
      ? [{ specifier, target: resolveSourceImport(file, specifier) }]
      : [];
  });
}

async function runtimeDependencyMap(
  files: readonly string[]
): Promise<Map<string, RuntimeDependency[]>> {
  return new Map(
    await Promise.all(files.map(async (file) => [
      file,
      await runtimeDependencies(file)
    ] as const))
  );
}

function sourceLayer(target: string): string {
  return path.relative(sourceRoot, target).split(path.sep)[0] ?? '';
}

function isIoTarget(target: string): boolean {
  return (
    ['adapters', 'application', 'cli'].includes(sourceLayer(target)) ||
    path.dirname(target) === sourceRoot &&
      ioRootModules.has(path.basename(target))
  );
}

function transitiveIoPaths(
  start: string,
  dependencies: ReadonlyMap<string, readonly RuntimeDependency[]>
): string[] {
  const violations: string[] = [];
  const visit = (file: string, chain: readonly string[], visited: Set<string>): void => {
    if (visited.has(file)) return;
    const nextVisited = new Set(visited).add(file);
    for (const dependency of dependencies.get(file) ?? []) {
      const nextChain = [...chain, dependency.specifier];
      if (ioBuiltins.has(dependency.specifier)) {
        violations.push(nextChain.join(' -> '));
        continue;
      }
      if (!dependency.target) continue;
      if (isIoTarget(dependency.target)) {
        violations.push(nextChain.join(' -> '));
        continue;
      }
      visit(dependency.target, nextChain, nextVisited);
    }
  };
  visit(start, [path.relative(sourceRoot, start)], new Set());
  return [...new Set(violations)];
}

describe('source import boundaries', () => {
  it('has no runtime import cycles', async () => {
    const files = await sourceFiles();
    const dependencies = await runtimeDependencyMap(files);
    const graph = new Map<string, string[]>();
    for (const file of files) {
      graph.set(
        file,
        (dependencies.get(file) ?? [])
          .flatMap(({ target }) => target && files.includes(target) ? [target] : [])
      );
    }

    const complete = new Set<string>();
    const active: string[] = [];
    const visit = (file: string): void => {
      const cycleStart = active.indexOf(file);
      if (cycleStart >= 0) {
        throw new Error(
          `Runtime import cycle: ${[...active.slice(cycleStart), file]
            .map((entry) => path.relative(sourceRoot, entry))
            .join(' -> ')}`
        );
      }
      if (complete.has(file)) return;
      active.push(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency);
      active.pop();
      complete.add(file);
    };
    for (const file of files) visit(file);
  });

  it('keeps domain modules independent from I/O and transport layers', async () => {
    const domainRoot = path.join(sourceRoot, 'domain');
    const files = await sourceFiles();
    const dependencies = await runtimeDependencyMap(files);
    const violations = (await sourceFiles(domainRoot)).flatMap((file) =>
      transitiveIoPaths(file, dependencies)
    );
    expect(violations).toEqual([]);
  });

  it('keeps application runtime independent from CLI transport', async () => {
    const applicationRoot = path.join(sourceRoot, 'application');
    const cliRoot = path.join(sourceRoot, 'cli');
    const violations: string[] = [];
    for (const file of await sourceFiles(applicationRoot)) {
      for (const { specifier, target } of await runtimeDependencies(file)) {
        if (target?.startsWith(`${cliRoot}${path.sep}`)) {
          violations.push(
            `${path.relative(sourceRoot, file)} -> ${specifier}`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not route migrated namespaces through compatibility facades', async () => {
    const rules = [
      {
        root: sourceRoot,
        facades: new Set([
          'args.ts',
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'commands.ts',
          'file-system.ts',
          'planner.ts',
          'supported-stack.ts',
          'types.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'domain', 'project'),
        facades: new Set([
          'types.ts',
          'catalogs.ts',
          'planner.ts',
          'artifact-lifecycle.ts',
          'supported-stack.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'cli'),
        facades: new Set([
          'args.ts',
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'commands.ts',
          'planner.ts',
          'supported-stack.ts',
          'types.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'application'),
        facades: new Set([
          'args.ts',
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'commands.ts',
          'planner.ts',
          'supported-stack.ts',
          'types.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'adapters', 'packaged-assets'),
        facades: new Set(['supported-stack.ts'])
      },
      {
        root: path.join(sourceRoot, 'generators'),
        facades: new Set([
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'go-template-assets.ts',
          'npm-template-assets.ts',
          'opentofu-template-assets.ts',
          'planner.ts',
          'python-template-assets.ts',
          'supported-stack.ts',
          'templates.ts',
          'types.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'governance-activation'),
        facades: new Set([
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'planner.ts',
          'supported-stack.ts',
          'types.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'governance-assessment'),
        facades: new Set([
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'planner.ts',
          'supported-stack.ts',
          'types.ts'
        ])
      },
      {
        root: path.join(sourceRoot, 'domain', 'governance'),
        facades: new Set([
          'artifact-lifecycle.ts',
          'catalogs.ts',
          'planner.ts',
          'supported-stack.ts',
          'types.ts'
        ])
      }
    ];
    const violations: string[] = [];
    for (const rule of rules) {
      for (const file of await sourceFiles(rule.root)) {
        for (const { target } of await runtimeDependencies(file)) {
          if (
            target &&
            path.dirname(target) === sourceRoot &&
            rule.facades.has(path.basename(target))
          ) {
            violations.push(
              `${path.relative(sourceRoot, file)} -> ${path.relative(sourceRoot, target)}`
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('installed package root', () => {
  it('resolves package files consistently as paths and URLs', () => {
    expect(resolvePackageFile('package.json')).toBe(
      path.join(installedPackageRoot, 'package.json')
    );
    expect(fileURLToPath(resolvePackageFileUrl('assets', 'supported-stack.json')))
      .toBe(resolvePackageFile('assets', 'supported-stack.json'));
    expect(() => resolvePackageFile('..', 'outside')).toThrow(
      /Invalid packaged file path part/
    );
  });
});

describe('explicit project-domain identities', () => {
  it('keeps new Docker and Spec Kit artifacts in their exact lifecycles', () => {
    expect(explicitArtifactLifecycleIdentities).toEqual([
      {
        logicalName: 'root-dockerignore',
        category: 'runtime',
        pathParts: ['.dockerignore'],
        lifecycle: 'project',
        provisioningGroup: 'base'
      },
      {
        logicalName: 'frontend-dockerignore',
        category: 'frontend',
        pathParts: ['frontend', '.dockerignore'],
        lifecycle: 'project',
        provisioningGroup: 'frontend'
      },
      {
        logicalName: 'go-runtime-config-example',
        category: 'configuration',
        pathParts: ['runtime.config.example.json'],
        lifecycle: 'project',
        provisioningGroup: 'base'
      },
      {
        logicalName: 'node-backend-vitest-config',
        category: 'backend-test',
        pathParts: ['backend', 'vitest.config.ts'],
        lifecycle: 'project',
        provisioningGroup: 'base'
      },
      {
        logicalName: 'go-backend-migration-command',
        category: 'backend',
        pathParts: ['backend', 'cmd', 'migrate', 'main.go'],
        lifecycle: 'project',
        provisioningGroup: 'base'
      },
      {
        logicalName: 'spec-kit-bootstrap-spec',
        category: 'seed',
        pathParts: ['specs', '000-liftoff-bootstrap', 'spec.md'],
        lifecycle: 'seed'
      },
      {
        logicalName: 'spec-kit-bootstrap-plan',
        category: 'seed',
        pathParts: ['specs', '000-liftoff-bootstrap', 'plan.md'],
        lifecycle: 'seed'
      },
      {
        logicalName: 'spec-kit-bootstrap-tasks',
        category: 'seed',
        pathParts: ['specs', '000-liftoff-bootstrap', 'tasks.md'],
        lifecycle: 'seed'
      }
    ]);
  });

  it('records honest vector-store applicability in the pure catalog', () => {
    const catalog = createProjectCatalog({
      frameworkVersions: { openspec: '1.0.0', 'spec-kit': '1.0.0' },
      governancePolicyVersion: '1'
    });
    expect(catalog.getPattern('generic')?.requiresVectorStore).toBe(false);
    expect(catalog.getPattern('rag')?.requiresVectorStore).toBe(true);
    expect(
      catalog.patterns
        .filter((pattern) => pattern.id !== 'rag')
        .every((pattern) => pattern.requiresVectorStore === false)
    ).toBe(true);
  });
});
