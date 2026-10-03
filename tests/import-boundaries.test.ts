import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
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
  /** A literal `import()` edge: it joins every direction check, but not the static cycle check. */
  dynamic?: boolean;
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
  // Inline `type` import and export specifiers are erased by tsc, so they bind nothing at runtime.
  return node.specifiers.some((specifier) =>
    !('importKind' in specifier && specifier.importKind === 'type') &&
    !('exportKind' in specifier && specifier.exportKind === 'type')
  );
}

function resolveSourceImport(from: string, specifier: string, root = sourceRoot): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(from), specifier);
  const candidate = resolved.endsWith('.js')
    ? `${resolved.slice(0, -3)}.ts`
    : resolved.endsWith('.ts')
      ? resolved
      : `${resolved}.ts`;
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : undefined;
}

function runtimeDependenciesOf(source: string, file: string, root = sourceRoot): RuntimeDependency[] {
  const ast = parseAst(source, { lang: 'ts' }, file);
  const staticDependencies = ast.body.flatMap((node): RuntimeDependency[] => {
    if (
      !isStaticModuleNode(node) ||
      !node.source ||
      !hasRuntimeBinding(node)
    ) {
      return [];
    }
    const specifier = node.source.value;
    return typeof specifier === 'string'
      ? [{ specifier, target: resolveSourceImport(file, specifier, root) }]
      : [];
  });
  // Literal `import()` edges defer evaluation but still load fixed modules. Computed specifiers
  // have no reviewable target and are rejected by the module-loading checks below.
  const lazyDependencies: RuntimeDependency[] = [];
  visitAst(ast.body, (node) => {
    const specifier = node.type === 'ImportExpression' ? stringLiteralValue(node.source) : undefined;
    if (specifier !== undefined) {
      lazyDependencies.push({ specifier, target: resolveSourceImport(file, specifier, root), dynamic: true });
    }
  });
  return [...staticDependencies, ...lazyDependencies];
}

async function runtimeDependencies(file: string): Promise<RuntimeDependency[]> {
  return runtimeDependenciesOf(await readFile(file, 'utf8'), file);
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
      // Literal lazy imports legitimately defer evaluation, so cycles stay a static-edge property.
      graph.set(
        file,
        (dependencies.get(file) ?? [])
          .flatMap(({ target, dynamic }) => !dynamic && target && files.includes(target) ? [target] : [])
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

// ---------------------------------------------------------------------------------------------
// 2.6 shared syntax helpers for the plugin and module-loading guards below (used by P, G and B).
//
// These are syntactic architectural regression guards over authored `src` modules: they fix the
// module targets authored source may load and reject named loading/evaluation primitives. They are
// not complete JavaScript data-flow or security proofs. They do not follow aliases through values,
// audit dependency internals, or cover Node preloading and startup-time resolution (NODE_OPTIONS,
// --import/--require, NODE_PATH, loader hooks). Bundled plugins are trusted first-party code, not
// sandboxed extensions.
// ---------------------------------------------------------------------------------------------

type AstRecord = { readonly type: string } & { readonly [key: string]: unknown };

function isAstRecord(value: unknown): value is AstRecord {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function recordAt(node: AstRecord, key: string): AstRecord | undefined {
  const value = node[key];
  return isAstRecord(value) ? value : undefined;
}

function recordsAt(node: AstRecord, key: string): AstRecord[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isAstRecord) : [];
}

function identifierName(node: unknown): string | undefined {
  return isAstRecord(node) && node.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;
}

function stringLiteralValue(node: unknown): string | undefined {
  return isAstRecord(node) && node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

function expressionFreeTemplateText(node: unknown): string | undefined {
  if (!isAstRecord(node) || node.type !== 'TemplateLiteral' || recordsAt(node, 'expressions').length > 0) return undefined;
  const cooked = (recordsAt(node, 'quasis')[0]?.value as { cooked?: unknown } | undefined)?.cooked;
  return typeof cooked === 'string' ? cooked : undefined;
}

/** The accessed member name when it is fixed syntax (`a.b`, `a['b']` or an expression-free template key). */
function staticMemberName(node: AstRecord): string | undefined {
  if (node.computed !== true) return identifierName(node.property);
  return stringLiteralValue(node.property) ?? expressionFreeTemplateText(node.property);
}

function parseProgram(source: string, file: string): AstRecord {
  return parseAst(source, { lang: 'ts' }, file) as unknown as AstRecord;
}

function lineOf(source: string, node: AstRecord): number {
  return typeof node.start === 'number' ? source.slice(0, node.start).split('\n').length : 0;
}

function relativeSource(file: string, root = sourceRoot): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function sourcePath(relative: string, root = sourceRoot): string {
  return path.join(root, ...relative.split('/'));
}

function dependencyLabel(dependency: RuntimeDependency): string {
  return dependency.dynamic === true ? `import(${dependency.specifier})` : dependency.specifier;
}

let sourceModuleCache: Promise<ReadonlyMap<string, string>> | undefined;

function sourceModules(): Promise<ReadonlyMap<string, string>> {
  sourceModuleCache ??= sourceFiles().then(async (files) => new Map(
    await Promise.all(files.map(async (file) => [file, await readFile(file, 'utf8')] as const))
  ));
  return sourceModuleCache;
}

/** Visits every syntax node, including erased type syntax. */
function visitAst(node: unknown, visit: (node: AstRecord) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) visitAst(child, visit);
    return;
  }
  if (!isAstRecord(node)) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) visitAst(value, visit);
  }
}

const erasedTypeKeys = new Set([
  'implements',
  'returnType',
  'superTypeArguments',
  'superTypeParameters',
  'typeAnnotation',
  'typeArguments',
  'typeParameters'
]);
const erasedExpressionWrappers = new Set([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion'
]);

/**
 * Visits nodes in runtime positions only. Erased type syntax, non-computed object and class keys,
 * non-computed member names, labels and module declarations are skipped, so data keys such as
 * `{ process: 1 }`, members such as `options.require` and types such as `Date` never match a
 * forbidden reference. Binding names are visited, which conservatively rejects shadowing names.
 */
function walkRuntime(node: unknown, visit: (node: AstRecord) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkRuntime(child, visit);
    return;
  }
  if (!isAstRecord(node)) return;
  const { type } = node;
  if (type.startsWith('TS')) {
    if (erasedExpressionWrappers.has(type) || type === 'TSExportAssignment') {
      walkRuntime(node.expression, visit);
    } else if (type === 'TSImportEqualsDeclaration') {
      visit(node);
    } else if (type === 'TSParameterProperty') {
      walkRuntime(node.decorators, visit);
      walkRuntime(node.parameter, visit);
    } else if (type === 'TSEnumDeclaration') {
      visitAst(node, (member) => {
        if (member.type === 'TSEnumMember') walkRuntime(member.initializer, visit);
      });
    } else if ((type === 'TSModuleDeclaration' && node.declare !== true) || type === 'TSModuleBlock') {
      walkRuntime(node.body, visit);
    }
    return;
  }
  visit(node);
  switch (type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'MetaProperty':
    case 'BreakStatement':
    case 'ContinueStatement':
      return;
    case 'ExportNamedDeclaration':
      walkRuntime(node.declaration, visit);
      return;
    case 'LabeledStatement':
      walkRuntime(node.body, visit);
      return;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
      walkRuntime(node.decorators, visit);
      if (node.computed === true) walkRuntime(node.key, visit);
      walkRuntime(node.value, visit);
      return;
    case 'MemberExpression':
      walkRuntime(node.object, visit);
      if (node.computed === true) walkRuntime(node.property, visit);
      return;
    default:
      for (const [key, value] of Object.entries(node)) {
        if (!erasedTypeKeys.has(key) && typeof value === 'object' && value !== null) walkRuntime(value, visit);
      }
  }
}

interface RuntimeImport {
  readonly specifier: string;
  readonly kind: 'default' | 'named' | 'namespace' | 'side-effect';
  readonly imported?: string;
  readonly local?: string;
  readonly line: number;
}

/** Runtime import bindings; whole-declaration and inline type-only imports are erased and skipped. */
function runtimeImports(source: string, file: string): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  for (const node of recordsAt(parseProgram(source, file), 'body')) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
    const specifier = stringLiteralValue(node.source) ?? '';
    const specifiers = recordsAt(node, 'specifiers');
    const line = lineOf(source, node);
    if (specifiers.length === 0) imports.push({ specifier, kind: 'side-effect', line });
    for (const entry of specifiers) {
      if (entry.importKind === 'type') continue;
      const local = identifierName(entry.local);
      if (entry.type === 'ImportSpecifier') {
        const imported = identifierName(entry.imported) ?? stringLiteralValue(entry.imported);
        imports.push({ specifier, kind: 'named', imported, local, line });
      } else {
        imports.push({ specifier, kind: entry.type === 'ImportDefaultSpecifier' ? 'default' : 'namespace', local, line });
      }
    }
  }
  return imports;
}

function isTypeOnlyModuleDeclaration(node: AstRecord, kindKey: 'exportKind' | 'importKind'): boolean {
  const specifiers = recordsAt(node, 'specifiers');
  return node[kindKey] === 'type' || (specifiers.length > 0 && specifiers.every((entry) => entry[kindKey] === 'type'));
}

/**
 * Ordinary global I/O, messaging and scheduling entry points. Plugin modules and the exact
 * packaged-read exception both reject direct references in runtime positions. Aliases are not
 * tracked, and this is not a sandbox.
 */
const ordinaryGlobalEffectIdentifiers: ReadonlySet<string> = new Set([
  'BroadcastChannel', 'console', 'EventSource', 'fetch', 'localStorage', 'MessageChannel', 'queueMicrotask',
  'sessionStorage', 'setImmediate', 'setInterval', 'setTimeout', 'WebSocket', 'Worker', 'XMLHttpRequest'
]);

/** An in-memory module graph for probes, independent of the real source tree and its edges. */
function syntheticModules(entries: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(entries).map(([relative, source]) => [sourcePath(relative), source] as const));
}

// ---------------------------------------------------------------------------------------------
// 2.6-P: the exact bundled-plugin data-leaf exception.
// ---------------------------------------------------------------------------------------------

/** Release-owned plugin declaration modules that must stay inert data; absent until created. */
const pluginDataLeaves: ReadonlySet<string> = new Set(['plugins/builtin/assets.ts']);

/**
 * Reviewed runtime consumers of plugin modules outside src/plugins. Every static or literal lazy
 * edge into src/plugins must be listed exactly. Importers may only live under application/** or
 * adapters/packaged-assets/**, and non-application importers may only target declared data leaves.
 * An entry need not be used yet. CLI, root, domain and generator modules never import plugins.
 */
const pluginRuntimeConsumers: ReadonlyMap<string, readonly string[]> = new Map([
  ['adapters/packaged-assets/template-assets.ts', ['plugins/builtin/assets.ts']],
  // The composition root builds the registry from the built-in descriptors and the C1 asset table.
  ['application/project/plugins.ts', [
    'plugins/builtin/assets.ts',
    'plugins/builtin/index.ts',
    'plugins/contracts.ts',
    'plugins/registry.ts'
  ]],
  ['application/project/modern-plugins.ts', [
    'plugins/builtin/modern.ts',
    'plugins/builtin/modern-release.ts',
    'plugins/contracts.ts',
    'plugins/registry.ts'
  ]]
]);
const pluginConsumerLayers = ['application/', 'adapters/packaged-assets/'];
/** Registry code never imports built-ins; application composition supplies them. */
const builtinFreePluginModules: ReadonlySet<string> = new Set(['plugins/contracts.ts', 'plugins/registry.ts']);

function isPluginModule(relative: string): boolean {
  return relative.startsWith('plugins/');
}

function pluginConsumerViolations(
  modules: ReadonlyMap<string, string>,
  consumers: ReadonlyMap<string, readonly string[]> = pluginRuntimeConsumers,
  leaves: ReadonlySet<string> = pluginDataLeaves,
  root = sourceRoot
): string[] {
  const violations: string[] = [];
  const present = new Set([...modules.keys()].map((file) => relativeSource(file, root)));
  for (const leaf of leaves) {
    if (!leaf.startsWith('plugins/builtin/') || !leaf.endsWith('.ts')) {
      violations.push(`data leaf ${leaf} must be a plugins/builtin/**/*.ts module`);
    }
  }
  for (const [importer, targets] of consumers) {
    if (!pluginConsumerLayers.some((layer) => importer.startsWith(layer))) {
      violations.push(`consumer ${importer} is outside application/** and adapters/packaged-assets/**`);
    }
    if (!present.has(importer)) violations.push(`consumer ${importer} does not exist`);
    for (const target of targets) {
      if (!isPluginModule(target)) violations.push(`consumer ${importer} lists non-plugin target ${target}`);
      if (!importer.startsWith('application/') && !leaves.has(target)) {
        violations.push(`consumer ${importer} may only target declared data leaves, not ${target}`);
      }
      if (!present.has(target) && !leaves.has(target)) violations.push(`consumer ${importer} lists missing target ${target}`);
    }
  }
  for (const [file, source] of modules) {
    const importer = relativeSource(file, root);
    for (const dependency of runtimeDependenciesOf(source, file, root)) {
      const target = dependency.target === undefined ? undefined : relativeSource(dependency.target, root);
      if (target === undefined || !isPluginModule(target)) continue;
      const edge = `${importer} -> ${dependencyLabel(dependency)}`;
      if (isPluginModule(importer)) {
        if (builtinFreePluginModules.has(importer) && target.startsWith('plugins/builtin/')) {
          violations.push(`${edge}: registry code must not import built-ins`);
        }
      } else if (!(consumers.get(importer) ?? []).includes(target)) {
        violations.push(`${edge}: not in the reviewed plugin consumer map`);
      }
    }
  }
  return violations;
}

interface DataLeafViolation {
  readonly line: number;
  readonly reason: string;
}

/**
 * Fail-closed grammar for plugin data leaves: type-only imports and exports, type declarations,
 * and `const` bindings initialized with plain data or exactly `Object.freeze(<data>)`, nested and
 * with `Object` unshadowed. It proves the module is inert, not that it is deeply frozen or correct.
 */
function dataLeafViolations(source: string, file: string): DataLeafViolation[] {
  const violations: DataLeafViolation[] = [];
  const consts = new Set<string>();
  const reject = (node: AstRecord, reason: string): void => {
    violations.push({ line: lineOf(source, node), reason });
  };
  const rejectObjectBinding = (node: AstRecord | undefined): void => {
    if (node !== undefined && identifierName(node) === 'Object') reject(node, 'binding named Object');
  };
  const isObjectFreeze = (node: AstRecord): boolean => {
    const callee = recordAt(node, 'callee');
    const args: unknown[] = Array.isArray(node.arguments) ? node.arguments : [];
    return node.optional !== true && callee?.type === 'MemberExpression' && callee.computed !== true &&
      callee.optional !== true && identifierName(callee.object) === 'Object' &&
      identifierName(callee.property) === 'freeze' && args.length === 1 &&
      isAstRecord(args[0]) && args[0].type !== 'SpreadElement';
  };
  const checkData = (node: AstRecord): void => {
    switch (node.type) {
      case 'Literal':
        if (node.regex !== undefined && node.regex !== null) reject(node, 'regular expression literal');
        else if (typeof node.value === 'bigint' || (node.bigint !== undefined && node.bigint !== null)) reject(node, 'bigint literal');
        else if (node.value !== null && !['boolean', 'number', 'string'].includes(typeof node.value)) reject(node, 'unsupported literal');
        return;
      case 'TemplateLiteral':
        if (recordsAt(node, 'expressions').length > 0) reject(node, 'template literal with expressions');
        return;
      case 'UnaryExpression': {
        const argument = recordAt(node, 'argument');
        if (node.operator !== '-' || argument?.type !== 'Literal' || typeof argument.value !== 'number') {
          reject(node, 'unary expression');
        }
        return;
      }
      case 'ArrayExpression':
        for (const element of Array.isArray(node.elements) ? node.elements as unknown[] : []) {
          if (!isAstRecord(element)) reject(node, 'array hole');
          else if (element.type === 'SpreadElement') reject(element, 'spread');
          else checkData(element);
        }
        return;
      case 'ObjectExpression':
        for (const property of recordsAt(node, 'properties')) {
          if (property.type !== 'Property') {
            reject(property, 'spread');
            continue;
          }
          const key = recordAt(property, 'key');
          const name = identifierName(key) ?? stringLiteralValue(key);
          const value = recordAt(property, 'value');
          if (property.kind !== 'init') reject(property, 'accessor property');
          else if (property.method === true) reject(property, 'method property');
          else if (property.shorthand === true) reject(property, 'shorthand property');
          else if (property.computed === true) reject(property, 'computed key');
          else if (name === undefined) reject(property, 'non-string key');
          else if (name === '__proto__') reject(property, '__proto__ key');
          else if (value !== undefined) checkData(value);
        }
        return;
      case 'Identifier': {
        const name = identifierName(node) ?? '';
        if (!consts.has(name)) reject(node, `identifier ${name}`);
        return;
      }
      case 'CallExpression': {
        const [argument] = recordsAt(node, 'arguments');
        if (!isObjectFreeze(node) || argument === undefined) reject(node, 'call other than Object.freeze(<data>)');
        else checkData(argument);
        return;
      }
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion': {
        const expression = recordAt(node, 'expression');
        if (expression !== undefined) checkData(expression);
        return;
      }
      default:
        reject(node, `${node.type} is not data`);
    }
  };
  for (const statement of recordsAt(parseProgram(source, file), 'body')) {
    if (statement.type === 'ImportDeclaration') {
      if (!isTypeOnlyModuleDeclaration(statement, 'importKind')) reject(statement, 'runtime import');
      for (const entry of recordsAt(statement, 'specifiers')) rejectObjectBinding(recordAt(entry, 'local'));
      continue;
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? recordAt(statement, 'declaration') : statement;
    if (declaration === undefined) {
      if (!isTypeOnlyModuleDeclaration(statement, 'exportKind')) {
        reject(statement, statement.source ? 'value re-export' : 'value export list');
      }
      continue;
    }
    if (declaration.type === 'ExportAllDeclaration' && declaration.exportKind === 'type') continue;
    if (declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration') {
      if (declaration.declare === true) reject(declaration, 'ambient declaration');
      continue;
    }
    if (declaration.type !== 'VariableDeclaration') {
      reject(declaration, `${declaration.type} is not data`);
      continue;
    }
    if (declaration.declare === true) {
      reject(declaration, 'ambient declaration');
      continue;
    }
    if (declaration.kind !== 'const') {
      reject(declaration, `${String(declaration.kind)} declaration`);
      continue;
    }
    for (const declarator of recordsAt(declaration, 'declarations')) {
      const id = recordAt(declarator, 'id');
      const name = identifierName(id);
      if (name === undefined) {
        reject(declarator, 'destructuring declaration');
        continue;
      }
      rejectObjectBinding(id);
      const init = recordAt(declarator, 'init');
      if (init === undefined) reject(declarator, 'uninitialized binding');
      else checkData(init);
      consts.add(name);
    }
  }
  return violations;
}

const packagedReadBindings: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['node:fs', new Set(['readFileSync'])],
  ['node:fs/promises', new Set(['readFile'])]
]);
const packageRootModule = 'adapters/packaged-assets/package-root.ts';
const packagedPathResolvers: ReadonlySet<string> = new Set(['resolvePackageFile', 'resolvePackageFileUrl']);
const ambientModuleIdentifiers: ReadonlySet<string> = new Set([
  '__dirname',
  '__filename',
  'createRequire',
  'eval',
  'exports',
  'Function',
  'global',
  'globalThis',
  'module',
  'process',
  'require'
]);

/**
 * A non-application plugin consumer is an exact packaged-file reader: named fs read bindings, the
 * package-root resolvers and its listed data leaves only. Every read takes a direct resolver call as
 * its path. It has no enumeration, ambient host state, ordinary global I/O or scheduling, or module
 * loading, and no read or resolver binding is shadowed, re-exported or used as a value.
 */
function exceptionImporterViolations(
  source: string,
  file: string,
  leafTargets: readonly string[],
  root = sourceRoot
): string[] {
  const violations: string[] = [];
  const readers = new Set<string>();
  const resolvers = new Set<string>();
  for (const entry of runtimeImports(source, file)) {
    const target = resolveSourceImport(file, entry.specifier, root);
    const targetPath = target === undefined ? undefined : relativeSource(target, root);
    if (entry.kind !== 'named' || entry.imported === undefined || entry.local === undefined) {
      violations.push(`line ${entry.line}: ${entry.kind} import from ${entry.specifier}`);
    } else if (packagedReadBindings.get(entry.specifier)?.has(entry.imported) === true) {
      readers.add(entry.local);
    } else if (targetPath === packageRootModule && packagedPathResolvers.has(entry.imported)) {
      resolvers.add(entry.local);
    } else if (targetPath === undefined || !leafTargets.includes(targetPath)) {
      violations.push(`line ${entry.line}: ${entry.imported} from ${entry.specifier} is not a permitted packaged-read binding`);
    }
  }
  const body = recordsAt(parseProgram(source, file), 'body');
  for (const statement of body) {
    const reexport = statement.type === 'ExportAllDeclaration' ||
      (statement.type === 'ExportNamedDeclaration' && statement.source !== null && statement.source !== undefined);
    if (reexport && !isTypeOnlyModuleDeclaration(statement, 'exportKind')) {
      violations.push(`line ${lineOf(source, statement)}: value re-export from ${stringLiteralValue(statement.source) ?? ''}`);
    }
    if (statement.type === 'ExportNamedDeclaration' && !reexport) {
      for (const entry of recordsAt(statement, 'specifiers')) {
        const local = identifierName(entry.local);
        if (local !== undefined && (readers.has(local) || resolvers.has(local))) {
          violations.push(`line ${lineOf(source, statement)}: exports ${local}`);
        }
      }
    }
  }
  const references = new Map<string, number>();
  const directReads = new Map<string, number>();
  const resolverCalls = new Map<string, number>();
  const count = (counts: Map<string, number>, name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  walkRuntime(body, (node) => {
    const line = `line ${lineOf(source, node)}`;
    if (node.type === 'ImportExpression') violations.push(`${line}: import()`);
    else if (node.type === 'MetaProperty' && identifierName(node.meta) === 'import') violations.push(`${line}: import.meta`);
    else if (node.type === 'TSImportEqualsDeclaration') violations.push(`${line}: import-equals declaration`);
    else if (node.type === 'Identifier') {
      const name = identifierName(node) ?? '';
      if (ambientModuleIdentifiers.has(name) || ordinaryGlobalEffectIdentifiers.has(name)) {
        violations.push(`${line}: identifier ${name}`);
      }
      if (readers.has(name) || resolvers.has(name)) count(references, name);
    } else if (node.type === 'CallExpression' && node.optional !== true) {
      const callee = identifierName(node.callee);
      if (callee !== undefined && resolvers.has(callee)) count(resolverCalls, callee);
      if (callee !== undefined && readers.has(callee)) {
        const [first] = Array.isArray(node.arguments) ? node.arguments as unknown[] : [];
        const inner = isAstRecord(first) && first.type === 'CallExpression' && first.optional !== true
          ? identifierName(first.callee)
          : undefined;
        if (inner !== undefined && resolvers.has(inner)) count(directReads, callee);
      }
    }
  });
  for (const reader of readers) {
    if ((references.get(reader) ?? 0) !== (directReads.get(reader) ?? 0)) {
      violations.push(`${reader} is used outside direct packaged reads such as readFileSync(resolvePackageFile(...))`);
    }
  }
  for (const resolver of resolvers) {
    if ((references.get(resolver) ?? 0) !== (resolverCalls.get(resolver) ?? 0)) {
      violations.push(`${resolver} is shadowed or used as a value`);
    }
  }
  return violations;
}

describe('bundled plugin data-leaf exception (2.6-P)', () => {
  it('limits runtime plugin imports to the exact reviewed consumers and keeps built-ins out of registry code', async () => {
    expect(pluginConsumerViolations(await sourceModules())).toEqual([]);
  });

  it('keeps declared plugin data leaves inert data', async () => {
    const modules = await sourceModules();
    const violations: string[] = [];
    for (const leaf of pluginDataLeaves) {
      const file = sourcePath(leaf);
      const source = modules.get(file);
      // A declared leaf may be absent until the task that creates it; nothing can import it meanwhile.
      if (source === undefined) continue;
      violations.push(...dataLeafViolations(source, file).map(({ line, reason }) => `${leaf}:${line}: ${reason}`));
    }
    expect(violations).toEqual([]);
  });

  it('confines non-application plugin consumers to exact packaged-file reads', async () => {
    const modules = await sourceModules();
    const violations: string[] = [];
    for (const [importer, targets] of pluginRuntimeConsumers) {
      if (importer.startsWith('application/')) continue;
      const file = sourcePath(importer);
      const source = modules.get(file);
      if (source === undefined) {
        violations.push(`${importer}: listed consumer is missing`);
        continue;
      }
      violations.push(...exceptionImporterViolations(source, file, targets).map((violation) => `${importer}: ${violation}`));
    }
    expect(violations).toEqual([]);
  });

  it('accepts the agreed built-in asset table and rejects executable data-leaf content', () => {
    const leaf = sourcePath('plugins/builtin/assets.ts');
    const reasons = (source: string): string[] => dataLeafViolations(source, leaf).map(({ reason }) => reason);
    const agreedTable = [
      "import type { ContributionOwner } from '../contracts.js';",
      "import { type PluginCategory } from '../contracts.js';",
      "export type { ContributionOwner } from '../contracts.js';",
      "export { type PluginCategory } from '../contracts.js';",
      '',
      'export interface BuiltinAssetDeclaration {',
      '  readonly owner: ContributionOwner;',
      '  readonly id: string;',
      '  readonly pathParts: readonly string[];',
      '  readonly set: string;',
      "  readonly role: 'manifest' | 'lock' | 'export';",
      '}',
      'export type BuiltinAssetCategory = PluginCategory;',
      '',
      "const nodeFastifyOwner = Object.freeze({ kind: 'plugin', category: 'stack', id: 'node-fastify' } as const);",
      '',
      'export const builtinAssets = Object.freeze([',
      '  Object.freeze({',
      '    owner: nodeFastifyOwner,',
      "    id: 'node-backend-package-manifest',",
      "    pathParts: Object.freeze(['assets', 'plugins', 'node-fastify', 'node-backend', 'package.json']),",
      "    set: 'node-backend',",
      "    role: 'manifest'",
      '  }),',
      '  Object.freeze({',
      "    owner: Object.freeze({ kind: 'core' } as const),",
      "    id: 'frontend-package-lock',",
      "    pathParts: Object.freeze(['assets', 'templates', 'common', 'frontend', 'package-lock.json']),",
      "    set: 'frontend',",
      "    role: 'lock'",
      '  })',
      '] as const) satisfies readonly BuiltinAssetDeclaration[];',
      '',
      "export const plainRows = [{ 'owner': { kind: 'core' }, id: 'x', pathParts: ['assets', 'x'], size: -1, none: null, flag: true, raw: `plain` }];",
      ''
    ].join('\n');
    expect(dataLeafViolations(agreedTable, leaf)).toEqual([]);

    const rejected: [string, string, string][] = [
      ['function declaration', 'export function rows() { return []; }', 'FunctionDeclaration is not data'],
      ['arrow function', 'export const rows = () => [];', 'ArrowFunctionExpression is not data'],
      ['class', 'export class Rows {}', 'ClassDeclaration is not data'],
      ['enum', "export enum Role { Manifest = 'manifest' }", 'TSEnumDeclaration is not data'],
      ['namespace', 'export namespace Rows { export const a = 1; }', 'TSModuleDeclaration is not data'],
      ['default export', 'export default [];', 'ExportDefaultDeclaration is not data'],
      ['let binding', 'export let rows = [];', 'let declaration'],
      ['var binding', 'var rows = [];', 'var declaration'],
      ['ambient const', 'export declare const rows: readonly string[];', 'ambient declaration'],
      ['destructuring', 'export const { a } = { a: 1 };', 'destructuring declaration'],
      ['expression statement', 'Object.freeze([]);', 'ExpressionStatement is not data'],
      ['directive', "'use strict';", 'ExpressionStatement is not data'],
      ['import-equals', "import fs = require('node:fs');", 'TSImportEqualsDeclaration is not data'],
      ['side-effect import', "import '../registry.js';", 'runtime import'],
      ['registry import', "import { createPluginRegistry } from '../registry.js';\nexport const rows = [];", 'runtime import'],
      ['generator import', "import { renderReadme } from '../../generators/common/readme.js';\nexport const rows = [];", 'runtime import'],
      ['mixed inline import', "import { type PluginCategory, pluginCategories } from '../contracts.js';\nexport const rows = [];", 'runtime import'],
      ['export star', "export * from '../contracts.js';", 'ExportAllDeclaration is not data'],
      ['value re-export', "export { pluginCategories } from '../contracts.js';", 'value re-export'],
      ['value export list', 'const rows = [];\nexport { rows };', 'value export list'],
      ['other call', 'export const rows = Object.values({});', 'call other than Object.freeze(<data>)'],
      ['parse call', "export const rows = JSON.parse('[]');", 'call other than Object.freeze(<data>)'],
      ['spread freeze argument', 'const base = [[]];\nexport const rows = Object.freeze(...base);', 'call other than Object.freeze(<data>)'],
      ['two freeze arguments', 'export const rows = Object.freeze([], []);', 'call other than Object.freeze(<data>)'],
      ['optional freeze', 'export const rows = Object.freeze?.([]);', 'ChainExpression is not data'],
      ['computed freeze', "export const rows = Object['freeze']([]);", 'call other than Object.freeze(<data>)'],
      ['global freeze', 'export const rows = globalThis.Object.freeze([]);', 'call other than Object.freeze(<data>)'],
      ['shadowed Object', 'const Object = { freeze: [] };\nexport const rows = [];', 'binding named Object'],
      ['imported Object', "import type { ContributionOwner as Object } from '../contracts.js';\nexport const rows = [];", 'binding named Object'],
      ['new', 'export const rows = new Array(1);', 'NewExpression is not data'],
      ['getter', "export const row = { get id() { return 'x'; } };", 'accessor property'],
      ['method', "export const row = { id() { return 'x'; } };", 'method property'],
      ['shorthand', "const id = 'x';\nexport const row = { id };", 'shorthand property'],
      ['computed key', "export const row = { ['id']: 'x' };", 'computed key'],
      ['numeric key', "export const row = { 1: 'x' };", 'non-string key'],
      ['__proto__ key', 'export const row = { __proto__: null };', '__proto__ key'],
      ['quoted __proto__ key', "export const row = { '__proto__': null };", '__proto__ key'],
      ['object spread', "const base = { id: 'x' };\nexport const row = { ...base };", 'spread'],
      ['array spread', "const base = ['x'];\nexport const rows = [...base];", 'spread'],
      ['array hole', "export const rows = ['a', , 'b'];", 'array hole'],
      ['template expression', "const id = 'x';\nexport const location = `assets/${id}`;", 'template literal with expressions'],
      ['tagged template', 'export const text = String.raw`x`;', 'TaggedTemplateExpression is not data'],
      ['regular expression', 'export const pattern = /x/;', 'regular expression literal'],
      ['bigint', 'export const size = 1n;', 'bigint literal'],
      ['operator', 'export const total = 1 + 2;', 'BinaryExpression is not data'],
      ['negation', 'export const flag = !0;', 'unary expression'],
      ['member access', "const table = { id: 'x' };\nexport const id = table.id;", 'MemberExpression is not data'],
      ['conditional', "export const choice = true ? 'a' : 'b';", 'ConditionalExpression is not data'],
      ['undefined identifier', 'export const missing = undefined;', 'identifier undefined'],
      ['ambient identifier', 'export const host = process;', 'identifier process'],
      ['forward reference', 'export const first = second;\nconst second = 1;', 'identifier second'],
      ['import.meta', 'export const meta = import.meta;', 'MetaProperty is not data'],
      ['import.meta member', 'export const url = import.meta.url;', 'MemberExpression is not data'],
      ['dynamic import', "export const loaded = import('../registry.js');", 'ImportExpression is not data'],
      ['await', 'export const value = await Promise.resolve(1);', 'AwaitExpression is not data']
    ];
    for (const [label, source, reason] of rejected) expect(reasons(source), label).toContain(reason);
  });

  it('rejects unlisted plugin importers, invalid consumer entries and built-in imports in registry code', () => {
    // A fixed consumer map, leaf set and module graph keep these probes independent of the real
    // tree's plugin edges and of later reviewed-map entries; the real map is checked above.
    const probeLeaves: ReadonlySet<string> = new Set(['plugins/builtin/assets.ts']);
    const probeConsumers: ReadonlyMap<string, readonly string[]> = new Map([
      ['adapters/packaged-assets/template-assets.ts', ['plugins/builtin/assets.ts']],
      ['application/project/plugins.ts', [
        'plugins/builtin/assets.ts',
        'plugins/builtin/index.ts',
        'plugins/contracts.ts',
        'plugins/registry.ts'
      ]]
    ]);
    const base: Readonly<Record<string, string>> = {
      'plugins/contracts.ts': "export const pluginCategories = Object.freeze(['stack', 'cloud', 'workflow', 'agent']);",
      'plugins/registry.ts': [
        "import { createHash } from 'node:crypto';",
        "import { pluginCategories } from './contracts.js';",
        'export function createPluginRegistry(): unknown { return [createHash, pluginCategories]; }'
      ].join('\n'),
      'plugins/builtin/assets.ts': [
        "import type { ContributionOwner } from '../contracts.js';",
        'export const builtinAssets: readonly { readonly owner: ContributionOwner }[] = Object.freeze([]);'
      ].join('\n'),
      'plugins/builtin/index.ts': "import { builtinAssets } from './assets.js';\nexport const builtinDescriptors = Object.freeze([builtinAssets]);",
      'application/project/plugins.ts': [
        "import { builtinAssets } from '../../plugins/builtin/assets.js';",
        "import { builtinDescriptors } from '../../plugins/builtin/index.js';",
        "import { pluginCategories } from '../../plugins/contracts.js';",
        "import { createPluginRegistry } from '../../plugins/registry.js';",
        'export const composition = [builtinAssets, builtinDescriptors, pluginCategories, createPluginRegistry];'
      ].join('\n'),
      'adapters/packaged-assets/package-root.ts': "export function resolvePackageFile(...parts: string[]): string { return parts.join('/'); }",
      'adapters/packaged-assets/template-assets.ts': [
        "import { readFileSync } from 'node:fs';",
        "import { builtinAssets } from '../../plugins/builtin/assets.js';",
        "import type { ContributionOwner } from '../../plugins/contracts.js';",
        "import { resolvePackageFile } from './package-root.js';",
        'export type Owner = ContributionOwner;',
        "export const texts = builtinAssets.map(() => readFileSync(resolvePackageFile('assets', 'lock'), 'utf8'));"
      ].join('\n'),
      'cli/probe-types.ts': [
        "import type { PluginRegistry } from '../plugins/contracts.js';",
        "import { type PluginSelection } from '../plugins/contracts.js';",
        "export { type PluginHost } from '../plugins/contracts.js';",
        'export type Probe = PluginRegistry | PluginSelection;'
      ].join('\n'),
      'cli/commands/dispatch.ts': 'export const dispatch = true;',
      'templates.ts': 'export const templates = true;',
      'adapters/packaged-assets/supported-stack.ts': 'export const supportedStack = true;',
      'application/project/planning.ts': 'export const planning = true;',
      'domain/project/paths.ts': 'export const paths = true;'
    };
    expect(pluginConsumerViolations(syntheticModules(base), probeConsumers, probeLeaves)).toEqual([]);

    const planted = syntheticModules({
      ...base,
      'plugins/registry.ts': `${base['plugins/registry.ts']}\nimport './builtin/assets.js';`,
      'adapters/packaged-assets/template-assets.ts': [
        base['adapters/packaged-assets/template-assets.ts'],
        "import { createPluginRegistry } from '../../plugins/registry.js';",
        'export const registry = createPluginRegistry;'
      ].join('\n'),
      'application/project/plugins.ts': [
        base['application/project/plugins.ts'],
        "import { builtinRelease } from '../../plugins/builtin/release.js';",
        'export const release = builtinRelease;'
      ].join('\n'),
      'cli/probe-direct.ts': "import { createPluginRegistry } from '../plugins/registry.js';\nexport const probe = createPluginRegistry;",
      'probe-root.ts': "import './plugins/contracts.js';",
      'domain/project/probe-domain.ts': "export { pluginCategories } from '../../plugins/contracts.js';",
      'generators/probe-lazy.ts': "export const load = () => import('../plugins/registry.js');",
      'application/project/probe-unlisted.ts': "import '../../plugins/registry.js';"
    });
    expect([...pluginConsumerViolations(planted, probeConsumers, probeLeaves)].sort()).toEqual([
      'adapters/packaged-assets/template-assets.ts -> ../../plugins/registry.js: not in the reviewed plugin consumer map',
      'application/project/plugins.ts -> ../../plugins/builtin/release.js: not in the reviewed plugin consumer map',
      'application/project/probe-unlisted.ts -> ../../plugins/registry.js: not in the reviewed plugin consumer map',
      'cli/probe-direct.ts -> ../plugins/registry.js: not in the reviewed plugin consumer map',
      'domain/project/probe-domain.ts -> ../../plugins/contracts.js: not in the reviewed plugin consumer map',
      'generators/probe-lazy.ts -> import(../plugins/registry.js): not in the reviewed plugin consumer map',
      'plugins/registry.ts -> ./builtin/assets.js: registry code must not import built-ins',
      'probe-root.ts -> ./plugins/contracts.js: not in the reviewed plugin consumer map'
    ]);

    // Invalid entries start from the fixed probe map, then override or extend exactly the probed entries.
    const invalid = new Map<string, readonly string[]>([
      ...probeConsumers,
      ['adapters/packaged-assets/template-assets.ts', ['plugins/builtin/assets.ts', 'plugins/registry.ts']],
      ['cli/commands/dispatch.ts', ['plugins/registry.ts']],
      ['templates.ts', ['plugins/builtin/assets.ts']],
      ['adapters/packaged-assets/supported-stack.ts', ['plugins/registry.ts']],
      ['application/probe-missing.ts', ['plugins/probe-missing.ts']],
      ['application/project/planning.ts', ['domain/project/paths.ts', 'plugins/builtin/assets.ts']]
    ]);
    expect(pluginConsumerViolations(syntheticModules(base), invalid, new Set([...probeLeaves, 'plugins/assets.ts']))).toEqual([
      'data leaf plugins/assets.ts must be a plugins/builtin/**/*.ts module',
      'consumer adapters/packaged-assets/template-assets.ts may only target declared data leaves, not plugins/registry.ts',
      'consumer cli/commands/dispatch.ts is outside application/** and adapters/packaged-assets/**',
      'consumer cli/commands/dispatch.ts may only target declared data leaves, not plugins/registry.ts',
      'consumer templates.ts is outside application/** and adapters/packaged-assets/**',
      'consumer adapters/packaged-assets/supported-stack.ts may only target declared data leaves, not plugins/registry.ts',
      'consumer application/probe-missing.ts does not exist',
      'consumer application/probe-missing.ts lists missing target plugins/probe-missing.ts',
      'consumer application/project/planning.ts lists non-plugin target domain/project/paths.ts'
    ]);
  });

  it('rejects packaged-read bindings that enumerate, escape, shadow or leave the packaged root', () => {
    const importer = sourcePath('adapters/packaged-assets/template-assets.ts');
    const check = (source: string): string[] => exceptionImporterViolations(source, importer, ['plugins/builtin/assets.ts'])
      .map((violation) => violation.replace(/^line \d+: /, ''));
    const header = "import { readFileSync } from 'node:fs';\nimport { resolvePackageFile } from './package-root.js';\n";
    const escapedRead = 'readFileSync is used outside direct packaged reads such as readFileSync(resolvePackageFile(...))';
    expect(check([
      "import { readFileSync, type Stats } from 'node:fs';",
      "import type { PathLike } from 'node:fs';",
      "import { readFile as readPackagedFile } from 'node:fs/promises';",
      "import { resolvePackageFile, resolvePackageFileUrl as packagedUrl } from './package-root.js';",
      "import { builtinAssets } from '../../plugins/builtin/assets.js';",
      'export type Input = PathLike | Stats;',
      "export function readPackagedText(...pathParts: string[]): string { return readFileSync(resolvePackageFile(...pathParts), 'utf8'); }",
      "export async function readPackagedUrl(name: string): Promise<string> { return readPackagedFile(packagedUrl('assets', name), 'utf8'); }",
      'export const firstAsset = builtinAssets[0];',
      "export const fixedLocation = resolvePackageFile('assets', 'supported-stack.json');",
      'export const options = { process: 1, require: 2, fetch: 3, console: 4, setTimeout: 5, WebSocket: 6 };',
      'export const flags = [options.fetch, options.console, options.setTimeout, options.WebSocket];',
      'export type Fetcher = typeof fetch;',
      'interface Scheduler { setTimeout(handler: () => void): void; console: Console }',
      'export type Plan = Scheduler;'
    ].join('\n'))).toEqual([]);

    const rejected: [string, string, string][] = [
      ['directory listing', "import { readdirSync } from 'node:fs';", 'readdirSync from node:fs is not a permitted packaged-read binding'],
      ['directory handle', "import { opendir } from 'node:fs/promises';", 'opendir from node:fs/promises is not a permitted packaged-read binding'],
      ['glob', "import { glob } from 'node:fs/promises';", 'glob from node:fs/promises is not a permitted packaged-read binding'],
      ['watch', "import { watch } from 'node:fs';", 'watch from node:fs is not a permitted packaged-read binding'],
      ['aliased listing', "import { readdirSync as readFileSync } from 'node:fs';", 'readdirSync from node:fs is not a permitted packaged-read binding'],
      ['namespace fs', "import * as fs from 'node:fs';", 'namespace import from node:fs'],
      ['default fs', "import fs from 'node:fs';", 'default import from node:fs'],
      ['side-effect import', "import 'node:fs';", 'side-effect import from node:fs'],
      ['unprefixed fs', "import { readFileSync } from 'fs';", 'readFileSync from fs is not a permitted packaged-read binding'],
      ['other module', "import { resolveProjectFile } from '../filesystem/project-files.js';", 'resolveProjectFile from ../filesystem/project-files.js is not a permitted packaged-read binding'],
      ['unlisted data leaf', "import { rows } from '../../plugins/builtin/other.js';", 'rows from ../../plugins/builtin/other.js is not a permitted packaged-read binding'],
      ['cwd path', header + "export const text = readFileSync(`${process.cwd()}/plugins/evil.json`, 'utf8');", 'identifier process'],
      ['cwd path read', header + "export const text = readFileSync(`${process.cwd()}/plugins/evil.json`, 'utf8');", escapedRead],
      ['indirect path', header + "const location = resolvePackageFile('assets');\nexport const text = readFileSync(location, 'utf8');", escapedRead],
      ['escaping read', header + 'export const reader = readFileSync;', escapedRead],
      ['forwarded read', header + "export const text = readFileSync.call(undefined, resolvePackageFile('x'));", escapedRead],
      ['optional read', header + "export const text = readFileSync?.(resolvePackageFile('x'));", escapedRead],
      ['shadowed read', header + "export function read(readFileSync: (file: string) => string): string { return readFileSync(resolvePackageFile('x')); }", escapedRead],
      ['shadowed resolver', header + "export function read(resolvePackageFile: (part: string) => string): string { return readFileSync(resolvePackageFile('/etc/passwd'), 'utf8'); }", 'resolvePackageFile is shadowed or used as a value'],
      ['escaping resolver', header + 'export const resolver = resolvePackageFile;', 'resolvePackageFile is shadowed or used as a value'],
      ['re-exported read', header + 'export { readFileSync as readAnything };', 'exports readFileSync'],
      ['re-exported fs', "export { readFileSync } from 'node:fs';", 'value re-export from node:fs'],
      ['export star', "export * from 'node:fs';", 'value re-export from node:fs'],
      ['import.meta', header + "export const text = readFileSync(new URL('./x', import.meta.url), 'utf8');", 'import.meta'],
      ['dynamic import', "export const load = () => import('node:fs');", 'import()'],
      ['require', "export const fs = require('node:fs');", 'identifier require'],
      ['import-equals', "import fs = require('node:fs');", 'import-equals declaration'],
      // Ordinary global I/O, messaging and scheduling; the first three are the reviewed reproductions.
      ['fetch', "export const bytes = fetch('https://example.invalid/not-executed');", 'identifier fetch'],
      ['WebSocket', "export const socket = new WebSocket('wss://example.invalid/not-executed');", 'identifier WebSocket'],
      ['console', "console.log('not executed');", 'identifier console'],
      ['EventSource', "export const events = new EventSource('https://example.invalid/not-executed');", 'identifier EventSource'],
      ['XMLHttpRequest', 'export const request = new XMLHttpRequest();', 'identifier XMLHttpRequest'],
      ['Worker', "export const worker = new Worker('./not-executed.js');", 'identifier Worker'],
      ['BroadcastChannel', "export const channel = new BroadcastChannel('assets');", 'identifier BroadcastChannel'],
      ['MessageChannel', 'export const channel = new MessageChannel();', 'identifier MessageChannel'],
      ['localStorage', "export const cached = localStorage.getItem('assets');", 'identifier localStorage'],
      ['sessionStorage', "export const cached = sessionStorage.getItem('assets');", 'identifier sessionStorage'],
      ['setTimeout', 'setTimeout(() => undefined, 1);', 'identifier setTimeout'],
      ['setInterval', 'setInterval(() => undefined, 1);', 'identifier setInterval'],
      ['setImmediate', 'setImmediate(() => undefined);', 'identifier setImmediate'],
      ['queueMicrotask', 'queueMicrotask(() => undefined);', 'identifier queueMicrotask'],
      ['effect in a computed key', 'export const table = { [fetch.name]: 1 };', 'identifier fetch'],
      ['effect inside a read helper', header + "export function readLogged(): string { console.log('asset'); return readFileSync(resolvePackageFile('x'), 'utf8'); }", 'identifier console']
    ];
    for (const [label, source, expected] of rejected) expect(check(source), label).toContain(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.6-G: bundled plugin purity and global module-loading guards.
// ---------------------------------------------------------------------------------------------

/** node:crypto bindings plugin modules may use: deterministic hashing only. */
const pluginCryptoBindings: ReadonlySet<string> = new Set(['createHash']);
const pluginForbiddenIdentifiers: ReadonlySet<string> = new Set([
  // Ambient host state, time, randomness and locale.
  'crypto', 'Date', 'global', 'globalThis', 'Intl', 'navigator', 'performance', 'process',
  // Module loading and code evaluation.
  '__dirname', '__filename', 'createRequire', 'eval', 'exports', 'Function', 'module', 'require', 'WebAssembly',
  // Ordinary global I/O, messaging and scheduling, shared with the packaged-read exception.
  ...ordinaryGlobalEffectIdentifiers
]);
const localeDependentMembers: ReadonlySet<string> = new Set([
  'localeCompare', 'toLocaleDateString', 'toLocaleLowerCase', 'toLocaleString', 'toLocaleTimeString', 'toLocaleUpperCase'
]);

function pluginPurityViolations(source: string, file: string): string[] {
  const violations: string[] = [];
  walkRuntime(recordsAt(parseProgram(source, file), 'body'), (node) => {
    const line = `line ${lineOf(source, node)}`;
    if (node.type === 'ImportExpression') violations.push(`${line}: import()`);
    else if (node.type === 'MetaProperty' && identifierName(node.meta) === 'import') violations.push(`${line}: import.meta`);
    else if (node.type === 'TSImportEqualsDeclaration') violations.push(`${line}: import-equals declaration`);
    else if (node.type === 'Identifier' && pluginForbiddenIdentifiers.has(identifierName(node) ?? '')) {
      violations.push(`${line}: identifier ${identifierName(node) ?? ''}`);
    } else if (node.type === 'MemberExpression') {
      const member = staticMemberName(node);
      if (identifierName(node.object) === 'Math' && member === 'random') violations.push(`${line}: Math.random`);
      if (member !== undefined && localeDependentMembers.has(member)) violations.push(`${line}: locale-dependent ${member}`);
    }
  });
  return violations;
}

/** Plugin modules import only plugins, domain and deterministic node:crypto hashing, transitively I/O-free. */
function pluginModuleViolations(modules: ReadonlyMap<string, string>, root = sourceRoot): string[] {
  const dependencies = new Map([...modules].map(([file, source]) => [file, runtimeDependenciesOf(source, file, root)] as const));
  const violations: string[] = [];
  for (const [file, source] of modules) {
    const relative = relativeSource(file, root);
    if (!isPluginModule(relative)) continue;
    for (const dependency of dependencies.get(file) ?? []) {
      const target = dependency.target === undefined ? undefined : relativeSource(dependency.target, root);
      const allowed = target === undefined
        ? dependency.specifier === 'node:crypto'
        : isPluginModule(target) || target.startsWith('domain/');
      if (!allowed) violations.push(`${relative} -> ${dependencyLabel(dependency)}`);
    }
    for (const entry of runtimeImports(source, file)) {
      if (entry.specifier !== 'node:crypto') continue;
      if (entry.kind !== 'named' || !pluginCryptoBindings.has(entry.imported ?? '')) {
        violations.push(`${relative}: ${entry.kind === 'named' ? entry.imported ?? '' : `${entry.kind} import`} from node:crypto`);
      }
    }
    for (const statement of recordsAt(parseProgram(source, file), 'body')) {
      const reexported = stringLiteralValue(statement.source);
      if ((statement.type === 'ExportAllDeclaration' || statement.type === 'ExportNamedDeclaration') &&
          reexported !== undefined && !reexported.startsWith('.') && !isTypeOnlyModuleDeclaration(statement, 'exportKind')) {
        violations.push(`${relative}: re-export from ${reexported}`);
      }
    }
    violations.push(...transitiveIoPaths(file, dependencies));
    violations.push(...pluginPurityViolations(source, file).map((violation) => `${relative}: ${violation}`));
  }
  return violations;
}

interface ModuleLoadingContext {
  readonly root: string;
  readonly present: ReadonlySet<string>;
  readonly dependencies: ReadonlySet<string>;
  readonly devDependencies: ReadonlySet<string>;
}

async function moduleLoadingContext(modules: ReadonlyMap<string, string>): Promise<ModuleLoadingContext> {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  return {
    root: sourceRoot,
    present: new Set(modules.keys()),
    dependencies: new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]),
    devDependencies: new Set(Object.keys(manifest.devDependencies ?? {}))
  };
}

/** Why a runtime specifier is not a fixed src module, `node:` builtin or declared runtime dependency. */
function moduleSpecifierViolation(specifier: string, file: string, context: ModuleLoadingContext): string | undefined {
  if (specifier.startsWith('.')) {
    const target = resolveSourceImport(file, specifier, context.root);
    if (target === undefined) return 'relative specifier leaves src';
    return context.present.has(target) ? undefined : 'relative specifier has no source module';
  }
  if (path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier)) return 'absolute specifier';
  if (specifier.startsWith('node:')) return isBuiltin(specifier) ? undefined : 'unknown node: builtin';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return 'URL specifier';
  if (isBuiltin(specifier)) return 'unprefixed builtin';
  const name = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*/.exec(specifier)?.[0];
  if (name === undefined) return 'invalid package specifier';
  const subpath = specifier.slice(name.length);
  if (subpath !== '' && !/^(?:\/[A-Za-z0-9_@][A-Za-z0-9._@-]*)+$/.test(subpath)) return 'unsafe package subpath';
  if (context.dependencies.has(name)) return undefined;
  return context.devDependencies.has(name) ? 'devDependency-only package' : 'undeclared package';
}

const codeLoadingBuiltins = ['inspector', 'module', 'repl', 'vm', 'wasi', 'worker_threads'];

/** In-process code loading/evaluation builtins, prefixed or not, including subpaths. */
function isCodeLoadingBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return codeLoadingBuiltins.some((name) => bare === name || bare.startsWith(`${name}/`));
}

const loaderIdentifiers: ReadonlySet<string> = new Set([
  '__dirname', '__filename', 'createRequire', 'eval', 'Function', 'require', 'WebAssembly'
]);
const processLoaderMembers: ReadonlySet<string> = new Set([
  '_linkedBinding', 'binding', 'dlopen', 'getBuiltinModule', 'mainModule'
]);
const globalObjectNames: ReadonlySet<string> = new Set(['global', 'globalThis']);

/**
 * Direct, computed and destructured references to code-loading or evaluation primitives. There is
 * no alias tracking: `const g = globalThis; g.eval(...)` or reflection are outside this guard.
 */
function loaderReferenceViolations(source: string, file: string): string[] {
  const violations: string[] = [];
  const checkDestructuring = (pattern: unknown, from: unknown, line: string): void => {
    const owner = identifierName(from);
    if (!isAstRecord(pattern) || pattern.type !== 'ObjectPattern' || owner === undefined) return;
    const forbidden = owner === 'process' ? processLoaderMembers : globalObjectNames.has(owner) ? loaderIdentifiers : undefined;
    if (forbidden === undefined) return;
    for (const property of recordsAt(pattern, 'properties')) {
      if (property.type !== 'Property') {
        violations.push(`${line}: rest destructuring of ${owner}`);
        continue;
      }
      const key = recordAt(property, 'key');
      const name = property.computed === true
        ? stringLiteralValue(key) ?? expressionFreeTemplateText(key)
        : identifierName(key) ?? stringLiteralValue(key);
      if (name === undefined) violations.push(`${line}: computed ${owner} destructuring`);
      else if (forbidden.has(name)) violations.push(`${line}: ${owner}.${name}`);
    }
  };
  walkRuntime(recordsAt(parseProgram(source, file), 'body'), (node) => {
    const line = `line ${lineOf(source, node)}`;
    if (node.type === 'ImportExpression' && stringLiteralValue(node.source) === undefined) {
      violations.push(`${line}: computed import() specifier`);
    } else if (node.type === 'TSImportEqualsDeclaration') {
      violations.push(`${line}: import-equals declaration`);
    } else if (node.type === 'Identifier' && loaderIdentifiers.has(identifierName(node) ?? '')) {
      violations.push(`${line}: identifier ${identifierName(node) ?? ''}`);
    } else if (node.type === 'MemberExpression') {
      const owner = identifierName(node.object);
      const member = staticMemberName(node);
      if (owner === 'process') {
        if (member === undefined) violations.push(`${line}: computed process member`);
        else if (processLoaderMembers.has(member)) violations.push(`${line}: process.${member}`);
      } else if (owner !== undefined && globalObjectNames.has(owner)) {
        if (member === undefined) violations.push(`${line}: computed ${owner} member`);
        else if (loaderIdentifiers.has(member)) violations.push(`${line}: ${owner}.${member}`);
      }
    } else if (node.type === 'VariableDeclarator') {
      checkDestructuring(node.id, node.init, line);
    } else if (node.type === 'AssignmentExpression') {
      checkDestructuring(node.left, node.right, line);
    }
  });
  return violations;
}

describe('bundled plugin purity and module loading (2.6-G)', () => {
  it('keeps bundled plugin modules pure, deterministic and domain-bound', async () => {
    expect(pluginModuleViolations(await sourceModules())).toEqual([]);
  });

  it('resolves every authored runtime specifier to a src module, node: builtin or declared runtime dependency', async () => {
    const modules = await sourceModules();
    const context = await moduleLoadingContext(modules);
    const violations: string[] = [];
    for (const [file, source] of modules) {
      for (const dependency of runtimeDependenciesOf(source, file)) {
        const problem = moduleSpecifierViolation(dependency.specifier, file, context);
        if (problem !== undefined) violations.push(`${relativeSource(file)} -> ${dependencyLabel(dependency)}: ${problem}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('bans in-process code-loading and evaluation primitives in authored source', async () => {
    const violations: string[] = [];
    for (const [file, source] of await sourceModules()) {
      const relative = relativeSource(file);
      for (const dependency of runtimeDependenciesOf(source, file)) {
        if (isCodeLoadingBuiltin(dependency.specifier)) {
          violations.push(`${relative} -> ${dependencyLabel(dependency)}: code-loading builtin`);
        }
      }
      violations.push(...loaderReferenceViolations(source, file).map((violation) => `${relative}: ${violation}`));
    }
    expect(violations).toEqual([]);
  });

  it('tags literal lazy edges for direction checks while cycles stay static-only', () => {
    const file = sourcePath('domain/project/lazy-probe.ts');
    const dependencies = runtimeDependenciesOf([
      "import type { ProjectOptions } from './contracts.js';",
      "import { type ProjectPlan } from './contracts.js';",
      "export { type GeneratedArtifact } from './contracts.js';",
      "export type Loader = typeof import('../../cli/args.js');",
      'export type Options = ProjectOptions | ProjectPlan;',
      "export async function load(): Promise<unknown> { return import('../../adapters/filesystem/project-config.js'); }",
      "export async function loadComputed(name: string): Promise<unknown> { return import(`./${name}.js`); }"
    ].join('\n'), file);
    expect(dependencies).toEqual([{
      specifier: '../../adapters/filesystem/project-config.js',
      target: sourcePath('adapters/filesystem/project-config.ts'),
      dynamic: true
    }]);
    expect(runtimeDependenciesOf("export { type ProjectPlan, buildProjectPlanWithCatalog } from './planning.js';", file)).toEqual([
      { specifier: './planning.js', target: sourcePath('domain/project/planning.ts') }
    ]);
    expect(transitiveIoPaths(file, new Map([[file, dependencies]]))).toEqual([
      [path.join('domain', 'project', 'lazy-probe.ts'), '../../adapters/filesystem/project-config.js'].join(' -> ')
    ]);
  });

  it('proves plugin purity and import checks fail closed without flagging keys, members or types', () => {
    const file = sourcePath('plugins/probe.ts');
    const purity = (source: string): string[] =>
      pluginPurityViolations(source, file).map((violation) => violation.replace(/^line \d+: /, ''));
    expect(purity([
      "import type { Clock } from '../domain/project/contracts.js';",
      'type Stamp = { at: Date; clock?: Clock; run: typeof setTimeout };',
      'interface Host { process: string; require(id: string): unknown; console: Console }',
      "const keys = { process: 1, console: 2, fetch: 3, Date: 4, require: 5, module: 6, globalThis: 7, 'Math.random': 8 };",
      'const values = [keys.process, keys.console, keys.fetch, keys.Date, keys.require, keys.module, keys.globalThis];',
      'class Recorder { process = 1; console(): number { return this.process; } }',
      'outer: for (const value of values) { if (value > 3) break outer; }',
      'export const largest = Math.max(...values);',
      'export type Result = Stamp | Host | Recorder;'
    ].join('\n'))).toEqual([]);
    const rejected: [string, string][] = [
      ['process.platform;', 'identifier process'],
      ['const { env } = process;', 'identifier process'],
      ['const holder = { process };', 'identifier process'],
      ['const holder = { [process.platform]: 1 };', 'identifier process'],
      ["globalThis.fetch('https://example.invalid');", 'identifier globalThis'],
      ["fetch('https://example.invalid');", 'identifier fetch'],
      ["new WebSocket('wss://example.invalid');", 'identifier WebSocket'],
      ["new EventSource('https://example.invalid');", 'identifier EventSource'],
      ["console.log('plugin');", 'identifier console'],
      ['Date.now();', 'identifier Date'],
      ['new Date();', 'identifier Date'],
      ['Math.random();', 'Math.random'],
      ["Math['random']();", 'Math.random'],
      ['setTimeout(() => undefined, 1);', 'identifier setTimeout'],
      ['queueMicrotask(() => undefined);', 'identifier queueMicrotask'],
      ['performance.now();', 'identifier performance'],
      ['crypto.randomUUID();', 'identifier crypto'],
      ['navigator.language;', 'identifier navigator'],
      ['new Intl.Collator();', 'identifier Intl'],
      ["'a'.localeCompare('b');", 'locale-dependent localeCompare'],
      ['(1).toLocaleString();', 'locale-dependent toLocaleString'],
      ["await import('./contracts.js');", 'import()'],
      ['import.meta.url;', 'import.meta'],
      ["import fs = require('node:fs');", 'import-equals declaration'],
      ["eval('1');", 'identifier eval'],
      ["new Function('return 1');", 'identifier Function'],
      ["require('node:fs');", 'identifier require'],
      ['module.exports = {};', 'identifier module'],
      ['exports.value = 1;', 'identifier exports'],
      ['__dirname;', 'identifier __dirname'],
      ['new WebAssembly.Memory({ initial: 1 });', 'identifier WebAssembly'],
      ['enum Flags { Stamp = Date.now() }', 'identifier Date'],
      ['namespace Host { export const id = process.pid; }', 'identifier process']
    ];
    for (const [source, expected] of rejected) expect(purity(source), source).toContain(expected);

    // A synthetic graph keeps the import probes independent of the real tree.
    const graph = syntheticModules({
      'domain/project/paths.ts': 'export function validateArtifactPathParts(parts: readonly string[]): readonly string[] { return parts; }',
      'domain/project/probe-io.ts': "import { readFile } from 'node:fs/promises';\nexport const read = readFile;",
      'plugins/contracts.ts': "export const pluginCategories = Object.freeze(['stack']);",
      'plugins/probe-types.ts': [
        "import type { CommandContext } from '../application/context.js';",
        "import { type ParsedArgs } from '../cli/args/parser.js';",
        "import { createHash } from 'node:crypto';",
        "import { validateArtifactPathParts } from '../domain/project/paths.js';",
        "import { pluginCategories } from './contracts.js';",
        'export type Probe = CommandContext | ParsedArgs;',
        'export const probe = [createHash, validateArtifactPathParts, pluginCategories];'
      ].join('\n'),
      'plugins/probe-io.ts': "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;",
      'plugins/probe-layers.ts': [
        "import { loadProjectConfigOptions } from '../adapters/filesystem/project-config.js';",
        "import { parseArgs } from '../cli/args/parser.js';",
        "import { buildProjectPlan } from '../application/project/planning.js';",
        'export const probe = [loadProjectConfigOptions, parseArgs, buildProjectPlan];'
      ].join('\n'),
      // Generators, root modules and governance-activation are not I/O layers: only the allowlist rejects them.
      'plugins/probe-non-io-layers.ts': [
        "import { frontendFiles } from '../generators/common/frontend.js';",
        "import { renderTemplates } from '../templates.js';",
        "import { activationContract } from '../governance-activation/types.js';",
        'export const probe = [frontendFiles, renderTemplates, activationContract];'
      ].join('\n'),
      'plugins/probe-crypto.ts': [
        "import { createHash, randomBytes } from 'node:crypto';",
        "import * as nodeCrypto from 'node:crypto';",
        "export { randomUUID } from 'node:crypto';",
        'export const probe = [createHash, randomBytes, nodeCrypto];'
      ].join('\n'),
      'plugins/probe-transitive.ts': "import { read } from '../domain/project/probe-io.js';\nexport const load = read;",
      'plugins/probe-lazy.ts': "export const load = () => import('../adapters/filesystem/project-config.js');",
      'plugins/probe-purity.ts': "export const stamp = Date.now();\nexport const log = (value: string): void => console.log(value);"
    });
    const chain = (file: string, ...specifiers: string[]): string => [path.join('plugins', file), ...specifiers].join(' -> ');
    expect(pluginModuleViolations(graph)).toEqual([
      'plugins/probe-io.ts -> node:fs',
      chain('probe-io.ts', 'node:fs'),
      'plugins/probe-layers.ts -> ../adapters/filesystem/project-config.js',
      'plugins/probe-layers.ts -> ../cli/args/parser.js',
      'plugins/probe-layers.ts -> ../application/project/planning.js',
      chain('probe-layers.ts', '../adapters/filesystem/project-config.js'),
      chain('probe-layers.ts', '../cli/args/parser.js'),
      chain('probe-layers.ts', '../application/project/planning.js'),
      'plugins/probe-non-io-layers.ts -> ../generators/common/frontend.js',
      'plugins/probe-non-io-layers.ts -> ../templates.js',
      'plugins/probe-non-io-layers.ts -> ../governance-activation/types.js',
      'plugins/probe-crypto.ts: randomBytes from node:crypto',
      'plugins/probe-crypto.ts: namespace import from node:crypto',
      'plugins/probe-crypto.ts: re-export from node:crypto',
      chain('probe-transitive.ts', '../domain/project/probe-io.js', 'node:fs/promises'),
      'plugins/probe-lazy.ts -> import(../adapters/filesystem/project-config.js)',
      chain('probe-lazy.ts', '../adapters/filesystem/project-config.js'),
      'plugins/probe-lazy.ts: line 1: import()',
      'plugins/probe-purity.ts: line 1: identifier Date',
      'plugins/probe-purity.ts: line 2: identifier console'
    ]);
  });

  it('proves specifier checks refuse escaping, URL, undeclared, traversing and code-loading targets', () => {
    const file = sourcePath('probe.ts');
    const context: ModuleLoadingContext = {
      root: sourceRoot,
      present: new Set([sourcePath('fixed.ts'), sourcePath('nested/fixed.ts')]),
      dependencies: new Set(['yaml', '@inquirer/prompts']),
      devDependencies: new Set(['vitest'])
    };
    const cases: [string, string | undefined][] = [
      ['./fixed.js', undefined],
      ['./nested/fixed.js', undefined],
      ['./missing.js', 'relative specifier has no source module'],
      ['./fixed.mjs', 'relative specifier has no source module'],
      ['./data.json', 'relative specifier has no source module'],
      ['../outside.js', 'relative specifier leaves src'],
      ['../assets/plugins/evil.js', 'relative specifier leaves src'],
      ['/tmp/plugins/evil.mjs', 'absolute specifier'],
      ['C:\\plugins\\evil.mjs', 'absolute specifier'],
      ['\\\\server\\share\\evil.mjs', 'absolute specifier'],
      ['file:///tmp/plugins/evil.mjs', 'URL specifier'],
      ['data:text/javascript,export default 1', 'URL specifier'],
      ['https://example.invalid/evil.mjs', 'URL specifier'],
      ['blob:nodedata:evil', 'URL specifier'],
      ['node:fs', undefined],
      ['node:fs/promises', undefined],
      ['node:plugins', 'unknown node: builtin'],
      ['fs', 'unprefixed builtin'],
      ['fs/promises', 'unprefixed builtin'],
      ['yaml', undefined],
      ['yaml/dist/index.js', undefined],
      ['@inquirer/prompts', undefined],
      ['vitest', 'devDependency-only package'],
      ['liftoff-plugin-evil', 'undeclared package'],
      ['@liftoff/plugin-evil', 'undeclared package'],
      ['yaml/../../plugins/evil.js', 'unsafe package subpath'],
      ['yaml/./util', 'unsafe package subpath'],
      ['yaml//util', 'unsafe package subpath'],
      ['yaml/dist\\index.js', 'unsafe package subpath'],
      ['@inquirer/prompts/../../../plugins/evil.js', 'unsafe package subpath'],
      ['yaml%2F..%2Fevil', 'unsafe package subpath'],
      ['#plugins/evil', 'invalid package specifier'],
      ['@evil', 'invalid package specifier']
    ];
    for (const [specifier, expected] of cases) expect(moduleSpecifierViolation(specifier, file, context), specifier).toBe(expected);
    for (const specifier of [
      'node:vm', 'vm', 'node:worker_threads', 'node:module', 'module', 'node:repl', 'node:wasi',
      'node:inspector', 'node:inspector/promises', 'inspector/promises'
    ]) {
      expect(isCodeLoadingBuiltin(specifier), specifier).toBe(true);
    }
    for (const specifier of ['node:fs', 'node:crypto', 'node:child_process', 'node:vmx', 'yaml', './vm.js']) {
      expect(isCodeLoadingBuiltin(specifier), specifier).toBe(false);
    }
  });

  it('proves code-loading reference checks catch direct, computed and destructured forms', () => {
    const file = sourcePath('probe.ts');
    const check = (source: string): string[] =>
      loaderReferenceViolations(source, file).map((violation) => violation.replace(/^line \d+: /, ''));
    expect(check([
      "const loader = { require: true, eval: 'text', Function: 1, dlopen: 2 };",
      'export const flags = [loader.require, loader.eval, loader.Function, loader.dlopen];',
      'type Callable = Function;',
      'interface Loader { require(id: string): unknown; eval: string }',
      "export const response = globalThis.fetch('https://example.invalid');",
      'export const bound = globalThis.fetch.bind(globalThis);',
      'export const platform = process.platform;',
      'export const home = process.env.HOME;',
      'const { platform: hostPlatform, env } = process;',
      "export const loaded = import('./fixed.js');",
      'export type Result = Callable | Loader | typeof hostPlatform | typeof env;'
    ].join('\n'))).toEqual([]);
    const rejected: [string, string][] = [
      ['await import(`./${name}.js`);', 'computed import() specifier'],
      ['await import(name);', 'computed import() specifier'],
      ["await import('./' + name);", 'computed import() specifier'],
      ['await import(`./fixed.js`);', 'computed import() specifier'],
      ["require('node:fs');", 'identifier require'],
      ['createRequire(import.meta.url);', 'identifier createRequire'],
      ["eval('1');", 'identifier eval'],
      ["(0, eval)('1');", 'identifier eval'],
      ["new Function('return 1');", 'identifier Function'],
      ["Function('return 1')();", 'identifier Function'],
      ["globalThis.eval('1');", 'globalThis.eval'],
      ["globalThis['eval']('1');", 'globalThis.eval'],
      ["globalThis[`Function`]('return 1');", 'globalThis.Function'],
      ["global.Function('return 1');", 'global.Function'],
      ['globalThis[name];', 'computed globalThis member'],
      ['const { eval: evaluate } = globalThis;', 'globalThis.eval'],
      ["const { ['Function']: make } = globalThis;", 'globalThis.Function'],
      ['const { [name]: anything } = globalThis;', 'computed globalThis destructuring'],
      ['const { ...everything } = globalThis;', 'rest destructuring of globalThis'],
      ["process.dlopen(handle, 'addon.node');", 'process.dlopen'],
      ["process.binding('fs');", 'process.binding'],
      ["process['_linkedBinding']('fs');", 'process._linkedBinding'],
      ["process.getBuiltinModule('node:vm');", 'process.getBuiltinModule'],
      ['process.mainModule;', 'process.mainModule'],
      ['process[name];', 'computed process member'],
      ['const { getBuiltinModule } = process;', 'process.getBuiltinModule'],
      ['let loader; ({ getBuiltinModule: loader } = process);', 'process.getBuiltinModule'],
      ['new WebAssembly.Module(bytes);', 'identifier WebAssembly'],
      ['__dirname;', 'identifier __dirname'],
      ['__filename;', 'identifier __filename'],
      ["import fs = require('node:fs');", 'import-equals declaration']
    ];
    for (const [source, expected] of rejected) expect(check(source), source).toContain(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.6-B: the composition root, registry direction and lazy packaged template reads.
//
// Syntactic guards over authored src modules, like 2.6-P and G; aliases and data flow are not
// tracked. They complement the behavioral read-count proof in tests/plugin-lazy-assets.test.ts and
// the registry-backed rejection-before-rendering tests in tests/plugin-composition.test.ts. They
// make no claim about installed-package startup or dependency internals.
// ---------------------------------------------------------------------------------------------

const registryModule = 'plugins/registry.ts';
/** The eager compat loader reads every packaged template asset when it is first imported. */
const eagerTemplateAssetLoader = 'adapters/packaged-assets/template-assets.ts';
const cliEntry = 'cli.ts';
/** The bundled-plugin composition root, its renderer bindings and its packaged byte reader. */
const pluginCompositionPathModules: readonly string[] = [
  'application/project/plugins.ts',
  'application/project/modern-plugins.ts',
  'application/project/plugin-renderers.ts',
  'adapters/packaged-assets/plugin-assets.ts'
];
const compositionPathBuiltins: ReadonlySet<string> = new Set(['node:fs', 'node:fs/promises', 'node:path']);
/** node:fs and node:fs/promises bindings that enumerate directories or observe changes. */
const directoryEnumerationBindings: ReadonlySet<string> = new Set([
  'Dir', 'glob', 'globSync', 'opendir', 'opendirSync', 'readdir', 'readdirSync', 'unwatchFile', 'watch', 'watchFile'
]);
/** Named fs bindings that expose a whole namespace object, such as fs.promises with its readdir. */
const fsNamespaceBindings: ReadonlySet<string> = new Set(['default', 'promises']);

/** Plugin modules never import registry code: the composition root hands the built-ins to it. */
function registryImporterViolations(modules: ReadonlyMap<string, string>, root = sourceRoot): string[] {
  const violations: string[] = [];
  for (const [file, source] of modules) {
    const importer = relativeSource(file, root);
    if (!isPluginModule(importer) || importer === registryModule) continue;
    for (const dependency of runtimeDependenciesOf(source, file, root)) {
      if (dependency.target !== undefined && relativeSource(dependency.target, root) === registryModule) {
        violations.push(`${importer} -> ${dependencyLabel(dependency)}: plugin modules never import registry code`);
      }
    }
  }
  return violations;
}

/**
 * Static and literal lazy runtime paths from the CLI entry to the eager template asset loader, one
 * shortest path per reaching importer. An absent entry fails closed.
 */
function eagerTemplateAssetChains(modules: ReadonlyMap<string, string>, entry = cliEntry, root = sourceRoot): string[] {
  const edges = new Map([...modules].map(([file, source]) => [
    relativeSource(file, root),
    runtimeDependenciesOf(source, file, root).flatMap((dependency) => dependency.target === undefined
      ? []
      : [{ target: relativeSource(dependency.target, root), dynamic: dependency.dynamic === true }])
  ] as const));
  if (!edges.has(entry)) return [`entry ${entry} is missing`];
  const chains: string[] = [];
  const visited = new Set([entry]);
  const queue: { readonly at: string; readonly hops: readonly string[] }[] = [{ at: entry, hops: [entry] }];
  while (queue.length > 0) {
    const { at, hops } = queue.shift() as { readonly at: string; readonly hops: readonly string[] };
    for (const { target, dynamic } of edges.get(at) ?? []) {
      const next = [...hops, dynamic ? `import(${target})` : target];
      if (target === eagerTemplateAssetLoader) chains.push(next.join(' -> '));
      else if (!visited.has(target)) {
        visited.add(target);
        queue.push({ at: target, hops: next });
      }
    }
  }
  return chains;
}

/**
 * Composition-path modules import only relative src modules and node:fs or node:path, bind neither
 * an fs namespace object nor directory enumeration or watching, and reference no ambient host state,
 * module loading or ordinary global effects directly. It checks named bindings and direct references
 * in each listed module's own source only: it does not follow aliases or reflection, and it does not
 * establish how relatively imported code derives the paths it returns.
 */
function compositionPathViolations(source: string, file: string): string[] {
  const violations: string[] = [];
  const body = recordsAt(parseProgram(source, file), 'body');
  for (const statement of body) {
    const specifier = stringLiteralValue(statement.source);
    if (specifier === undefined || specifier.startsWith('.')) continue;
    if (isTypeOnlyModuleDeclaration(statement, statement.type === 'ImportDeclaration' ? 'importKind' : 'exportKind')) continue;
    const line = `line ${lineOf(source, statement)}`;
    const bindings = recordsAt(statement, 'specifiers').filter((entry) => entry.importKind !== 'type');
    if (relativeSource(file) === 'application/project/modern-plugins.ts' &&
      specifier === 'node:crypto' && statement.type === 'ImportDeclaration' &&
      bindings.length > 0 && bindings.every((entry) => entry.type === 'ImportSpecifier' &&
        (identifierName(entry.imported) ?? stringLiteralValue(entry.imported)) === 'createHash')) continue;
    if (!compositionPathBuiltins.has(specifier)) violations.push(`${line}: ${specifier} is not a permitted composition-path import`);
    else if (statement.type !== 'ImportDeclaration') violations.push(`${line}: re-export from ${specifier}`);
  }
  for (const entry of runtimeImports(source, file)) {
    if (entry.specifier !== 'node:fs' && entry.specifier !== 'node:fs/promises') continue;
    if (entry.kind !== 'named') violations.push(`line ${entry.line}: ${entry.kind} import from ${entry.specifier}`);
    else if (fsNamespaceBindings.has(entry.imported ?? '')) {
      violations.push(`line ${entry.line}: ${entry.imported ?? ''} from ${entry.specifier} binds an fs namespace object`);
    } else if (directoryEnumerationBindings.has(entry.imported ?? '')) {
      violations.push(`line ${entry.line}: ${entry.imported ?? ''} from ${entry.specifier} enumerates directories or observes changes`);
    }
  }
  walkRuntime(body, (node) => {
    const line = `line ${lineOf(source, node)}`;
    if (node.type === 'ImportExpression') violations.push(`${line}: import()`);
    else if (node.type === 'MetaProperty' && identifierName(node.meta) === 'import') violations.push(`${line}: import.meta`);
    else if (node.type === 'TSImportEqualsDeclaration') violations.push(`${line}: import-equals declaration`);
    else if (node.type === 'Identifier') {
      const name = identifierName(node) ?? '';
      if (ambientModuleIdentifiers.has(name) || ordinaryGlobalEffectIdentifiers.has(name)) violations.push(`${line}: identifier ${name}`);
    }
  });
  return violations;
}

/** Every listed composition-path module must exist and satisfy the composition-path rule. */
function compositionPathModuleViolations(
  modules: ReadonlyMap<string, string>,
  listed: readonly string[] = pluginCompositionPathModules,
  root = sourceRoot
): string[] {
  return listed.flatMap((relative) => {
    const file = sourcePath(relative, root);
    const source = modules.get(file);
    return source === undefined
      ? [`${relative}: listed composition-path module is missing`]
      : compositionPathViolations(source, file).map((violation) => `${relative}: ${violation}`);
  });
}

describe('bundled plugin composition root and lazy packaged reads (2.6-B)', () => {
  it('keeps registry code a dependency of the composition root, never of plugin modules', async () => {
    expect(registryImporterViolations(await sourceModules())).toEqual([]);
  });

  it('keeps every CLI import path, static or literal lazy, off the eager template asset loader', async () => {
    expect(eagerTemplateAssetChains(await sourceModules())).toEqual([]);
  });

  it('keeps the plugin composition and packaged-byte read path free of discovery and ambient state', async () => {
    expect(compositionPathModuleViolations(await sourceModules())).toEqual([]);
  });

  it('proves the registry-direction and eager-loader guards fail closed', () => {
    const registryGraph = syntheticModules({
      'plugins/contracts.ts': "export const pluginCategories = Object.freeze(['stack']);",
      'plugins/registry.ts': [
        "import { pluginCategories } from './contracts.js';",
        'export function createPluginRegistry(): unknown { return pluginCategories; }',
        "export function pluginContentDigest(): string { return 'sha256:'; }"
      ].join('\n'),
      'plugins/builtin/index.ts': "import { createPluginRegistry } from '../registry.js';\nexport const registry = createPluginRegistry();",
      'plugins/builtin/release.ts': "import { pluginContentDigest } from '../registry.js';\nexport const digest = pluginContentDigest();",
      'plugins/builtin/types.ts': [
        "import type { PluginRegistry } from '../registry.js';",
        "import { type PluginResolution } from '../registry.js';",
        'export type Registry = PluginRegistry | PluginResolution;'
      ].join('\n'),
      'plugins/builtin/stacks/lazy.ts': "export const load = () => import('../../registry.js');",
      'plugins/builtin/stacks/reexport.ts': "export { createPluginRegistry } from '../../registry.js';",
      'application/project/plugins.ts': "import { createPluginRegistry } from '../../plugins/registry.js';\nexport const registry = createPluginRegistry();"
    });
    expect(registryImporterViolations(registryGraph)).toEqual([
      'plugins/builtin/index.ts -> ../registry.js: plugin modules never import registry code',
      'plugins/builtin/release.ts -> ../registry.js: plugin modules never import registry code',
      'plugins/builtin/stacks/lazy.ts -> import(../../registry.js): plugin modules never import registry code',
      'plugins/builtin/stacks/reexport.ts -> ../../registry.js: plugin modules never import registry code'
    ]);

    const eagerGraph = syntheticModules({
      'cli.ts': "import { dispatch } from './cli/commands/dispatch.js';\nexport const run = dispatch;",
      'cli/commands/dispatch.ts': [
        "import { initialize } from './initialize.js';",
        "export const dispatch = () => import('../../templates.js').then(() => initialize);"
      ].join('\n'),
      'cli/commands/initialize.ts': "import { assets } from '../../npm-template-assets.js';\nexport const initialize = assets;",
      'npm-template-assets.ts': "export { packagedTemplateAssets as assets } from './adapters/packaged-assets/template-assets.js';",
      'templates.ts': [
        "import type { PackagedTemplateAssetContext } from './adapters/packaged-assets/template-assets.js';",
        "import { packagedTemplateAssets } from './adapters/packaged-assets/template-assets.js';",
        'export const assets: PackagedTemplateAssetContext = packagedTemplateAssets;'
      ].join('\n'),
      'adapters/packaged-assets/template-assets.ts': 'export const packagedTemplateAssets = Object.freeze({});',
      'unreachable-compat.ts': "import { packagedTemplateAssets } from './adapters/packaged-assets/template-assets.js';\nexport const assets = packagedTemplateAssets;"
    });
    expect(eagerTemplateAssetChains(eagerGraph)).toEqual([
      'cli.ts -> cli/commands/dispatch.ts -> import(templates.ts) -> adapters/packaged-assets/template-assets.ts',
      'cli.ts -> cli/commands/dispatch.ts -> cli/commands/initialize.ts -> npm-template-assets.ts -> adapters/packaged-assets/template-assets.ts'
    ]);

    const lazyGraph = syntheticModules({
      'cli.ts': "import { buildArtifacts } from './templates.js';\nexport const run = buildArtifacts;",
      'templates.ts': [
        "import type { PackagedTemplateAssetContext } from './adapters/packaged-assets/template-assets.js';",
        "import { builtinTemplateAssets } from './application/project/plugins.js';",
        'export const buildArtifacts = (): PackagedTemplateAssetContext => builtinTemplateAssets();'
      ].join('\n'),
      'application/project/plugins.ts': "export const builtinTemplateAssets = (): never => { throw new Error('read on first render'); };",
      'adapters/packaged-assets/template-assets.ts': 'export const packagedTemplateAssets = Object.freeze({});',
      'compat-facade.ts': "export { packagedTemplateAssets } from './adapters/packaged-assets/template-assets.js';"
    });
    expect(eagerTemplateAssetChains(lazyGraph)).toEqual([]);
    expect(eagerTemplateAssetChains(lazyGraph, 'missing-entry.ts')).toEqual(['entry missing-entry.ts is missing']);
  });

  it('allows only named createHash in the exact modern source root', () => {
    const modernFile = sourcePath('application/project/modern-plugins.ts');
    expect(compositionPathBuiltins.has('node:crypto')).toBe(false);
    for (const source of [
      "import { createHash } from 'node:crypto';",
      "import { createHash as rawHash } from 'node:crypto';"
    ]) {
      expect(compositionPathViolations(source, modernFile)).toEqual([]);
      for (const file of ['application/project/plugins.ts', 'application/project/plugin-renderers.ts', 'adapters/packaged-assets/plugin-assets.ts']) {
        expect(compositionPathViolations(source, sourcePath(file))).toContain(
          'line 1: node:crypto is not a permitted composition-path import');
      }
    }
    for (const source of [
      "import { randomBytes } from 'node:crypto';",
      "import { randomUUID } from 'node:crypto';",
      "import { randomBytes as createHash } from 'node:crypto';",
      "import { createHash, randomUUID } from 'node:crypto';",
      "import crypto from 'node:crypto';",
      "import * as crypto from 'node:crypto';",
      "import { default as createHash } from 'node:crypto';",
      "import 'node:crypto';",
      "export { createHash } from 'node:crypto';",
      "export * from 'node:crypto';"
    ]) expect(compositionPathViolations(source, modernFile), source).toContain(
      'line 1: node:crypto is not a permitted composition-path import');
    expect(compositionPathViolations("const load = () => import('node:crypto');", modernFile)).toContain('line 1: import()');
    expect(compositionPathViolations("import crypto = require('node:crypto');", modernFile)).toContain('line 1: import-equals declaration');
    expect(compositionPathViolations("import { createHash } from 'node:crypto'; const value = process.env.SECRET;", modernFile))
      .toContain('line 1: identifier process');
  });

  it('proves the composition-path guard fails closed without flagging keys, members or types', () => {
    const file = sourcePath('adapters/packaged-assets/plugin-assets.ts');
    const check = (source: string): string[] =>
      compositionPathViolations(source, file).map((violation) => violation.replace(/^line \d+: /, ''));
    expect(check([
      "import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';",
      "import { readFile as readPackaged } from 'node:fs/promises';",
      "import type { Dirent } from 'node:fs';",
      "import { type Dir } from 'node:fs';",
      "import type { promises as fsPromises } from 'node:fs';",
      "import { type promises } from 'node:fs';",
      "import path from 'node:path';",
      "import { installedPackageRoot } from './package-root.js';",
      "export { type PathLike } from 'node:fs';",
      'export type Entry = Dirent | Dir;',
      "export type FsPromises = typeof fsPromises | typeof promises | typeof import('node:fs').promises;",
      'export const options = { process: 1, readdir: 2, env: 3, fetch: 4, module: 5, promises: 6 };',
      'export const flags = [options.process, options.readdir, options.env, options.fetch, options.module, options.promises];',
      'export function locate(parts: readonly string[]): string { return path.join(installedPackageRoot, ...parts); }',
      'export const reader = { openSync, fstatSync, readSync, closeSync, readPackaged, mode: constants.O_RDONLY };',
      'interface Host { process: string; cwd(): string }',
      'export type HostView = Host;'
    ].join('\n'))).toEqual([]);
    expect(check("import { openSync, readSync, closeSync } from 'node:fs';")).toEqual([]);

    const enumerates = (binding: string, from: string): string => `${binding} from ${from} enumerates directories or observes changes`;
    const namespace = (binding: string, from: string): string => `${binding} from ${from} binds an fs namespace object`;
    const rejected: [string, string][] = [
      // The reviewed fs.promises reproductions: direct, aliased with destructuring, and computed access.
      ["import { promises } from 'node:fs'; export const entries = promises.readdir('not-executed');", namespace('promises', 'node:fs')],
      ["import { promises as filesystem } from 'node:fs'; const { readdir } = filesystem; export const entries = readdir('not-executed');", namespace('promises', 'node:fs')],
      ["import { promises } from 'node:fs'; export const enumerate = promises['readdir'];", namespace('promises', 'node:fs')],
      ["import { default as fs } from 'node:fs';\nexport const list = fs.readdirSync;", namespace('default', 'node:fs')],
      ["import { default as fsp } from 'node:fs/promises';\nexport const list = fsp.readdir;", namespace('default', 'node:fs/promises')],
      ["import { readdirSync } from 'node:fs';", enumerates('readdirSync', 'node:fs')],
      ["import { readdir } from 'node:fs/promises';", enumerates('readdir', 'node:fs/promises')],
      ["import { opendir as openDirectory } from 'node:fs/promises';", enumerates('opendir', 'node:fs/promises')],
      ["import { opendirSync } from 'node:fs';", enumerates('opendirSync', 'node:fs')],
      ["import { glob } from 'node:fs/promises';", enumerates('glob', 'node:fs/promises')],
      ["import { globSync } from 'node:fs';", enumerates('globSync', 'node:fs')],
      ["import { watch } from 'node:fs/promises';", enumerates('watch', 'node:fs/promises')],
      ["import { watchFile } from 'node:fs';", enumerates('watchFile', 'node:fs')],
      ["import { Dir } from 'node:fs';", enumerates('Dir', 'node:fs')],
      ["import * as fs from 'node:fs';", 'namespace import from node:fs'],
      ["import fs from 'node:fs/promises';", 'default import from node:fs/promises'],
      ["import 'node:fs';", 'side-effect import from node:fs'],
      ["export { readdir } from 'node:fs/promises';", 're-export from node:fs/promises'],
      ["export * from 'node:fs';", 're-export from node:fs'],
      ["import { homedir } from 'node:os';", 'node:os is not a permitted composition-path import'],
      ["import { spawnSync } from 'node:child_process';", 'node:child_process is not a permitted composition-path import'],
      ["import { request } from 'node:https';", 'node:https is not a permitted composition-path import'],
      ["import { fileURLToPath } from 'node:url';", 'node:url is not a permitted composition-path import'],
      ["import { parse } from 'yaml';", 'yaml is not a permitted composition-path import'],
      ["import { globSync } from 'glob';", 'glob is not a permitted composition-path import'],
      ['export const root = process.cwd();', 'identifier process'],
      ['export const override = process.env.LIFTOFF_PLUGIN_PATH;', 'identifier process'],
      ['const { env } = process;\nexport const plugins = env.LIFTOFF_PLUGINS;', 'identifier process'],
      ['export const host = globalThis.process;', 'identifier globalThis'],
      ['export const here = import.meta.url;', 'import.meta'],
      ['export const load = (name: string) => import(name);', 'import()'],
      ["export const load = () => import('./plugins/evil.js');", 'import()'],
      ["export const plugin = require('./plugins/evil.js');", 'identifier require'],
      ["export const bytes = fetch('https://example.invalid/not-executed');", 'identifier fetch'],
      ["console.log('not executed');", 'identifier console'],
      ["import fs = require('node:fs');", 'import-equals declaration']
    ];
    for (const [source, expected] of rejected) expect(check(source), source).toContain(expected);

    expect(compositionPathModuleViolations(syntheticModules({
      'application/project/plugins.ts': "import { readdirSync } from 'node:fs';\nexport const list = readdirSync;",
      'application/project/plugin-renderers.ts': 'export const bindings = Object.freeze({});'
    }))).toEqual([
      `application/project/plugins.ts: line 1: ${enumerates('readdirSync', 'node:fs')}`,
      'application/project/modern-plugins.ts: listed composition-path module is missing',
      'adapters/packaged-assets/plugin-assets.ts: listed composition-path module is missing'
    ]);
  });
});
