import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

/*
 * Dependency rules for the built-in plugin modules and their composition, enforced for the modules
 * this change owns. The repository-wide import policy is maintained separately.
 */

const sourceRoot = path.resolve('src');
const relative = (file: string) => path.relative(sourceRoot, file).split(path.sep).join('/');

interface ModuleImport {
  readonly specifier: string;
  readonly target?: string;
  readonly runtime: boolean;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files.sort();
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(from), specifier);
  return resolved.endsWith('.js') ? `${resolved.slice(0, -3)}.ts` : resolved;
}

async function importsOf(file: string): Promise<ModuleImport[]> {
  const ast = parseAst(await readFile(file, 'utf8'), { lang: 'ts' }, file);
  return ast.body.flatMap((node): ModuleImport[] => {
    if (node.type !== 'ImportDeclaration' && node.type !== 'ExportAllDeclaration' && node.type !== 'ExportNamedDeclaration') return [];
    if (!node.source || typeof node.source.value !== 'string') return [];
    const typeOnly = ('importKind' in node && node.importKind === 'type') ||
      ('exportKind' in node && node.exportKind === 'type') ||
      ('specifiers' in node && node.specifiers.length > 0 && node.specifiers.every((specifier) =>
        'importKind' in specifier && specifier.importKind === 'type'));
    return [{ specifier: node.source.value, target: resolveImport(file, node.source.value), runtime: !typeOnly }];
  });
}

const within = (target: string | undefined, ...parts: string[]) =>
  target !== undefined && target.startsWith(`${path.join(sourceRoot, ...parts)}${path.sep}`);

const ownedBuiltins = async () => (await sourceFiles(path.join(sourceRoot, 'plugins', 'builtin')))
  .filter((file) => path.basename(file) !== 'assets.ts');
const compositionModules = [
  path.join(sourceRoot, 'application', 'project', 'plugins.ts'),
  path.join(sourceRoot, 'application', 'project', 'modern-plugins.ts'),
  path.join(sourceRoot, 'application', 'project', 'plugin-renderers.ts'),
  path.join(sourceRoot, 'adapters', 'packaged-assets', 'plugin-assets.ts'),
  path.join(sourceRoot, 'domain', 'project', 'artifact-path-tokens.ts')
];

describe('built-in plugin module boundaries', () => {
  it('keeps built-in descriptors as data over plugin contracts and pure domain tables', async () => {
    const violations: string[] = [];
    for (const file of await ownedBuiltins()) {
      for (const entry of await importsOf(file)) {
        if (!within(entry.target, 'plugins') && !within(entry.target, 'domain')) violations.push(`${relative(file)} -> ${entry.specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the path-token module pure and the reader free of runtime plugin imports', async () => {
    const tokens = await importsOf(path.join(sourceRoot, 'domain', 'project', 'artifact-path-tokens.ts'));
    expect(tokens.filter((entry) => !within(entry.target, 'domain')).map((entry) => entry.specifier)).toEqual([]);
    const reader = await importsOf(path.join(sourceRoot, 'adapters', 'packaged-assets', 'plugin-assets.ts'));
    expect(reader.filter((entry) => entry.runtime && within(entry.target, 'plugins')).map((entry) => entry.specifier)).toEqual([]);
    expect(reader.filter((entry) => entry.runtime && entry.target?.endsWith(`${path.sep}template-assets.ts`))).toEqual([]);
  });

  it('constructs registries only in the declared composition roots', async () => {
    const callers: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      if (file === path.join(sourceRoot, 'plugins', 'registry.ts')) continue;
      const source = await readFile(file, 'utf8');
      if (/\bcreatePluginRegistry\s*\(/.test(source)) callers.push(relative(file));
    }
    expect(callers).toEqual([
      'application/project/modern-plugins.ts',
      'application/project/plugins.ts'
    ]);
  });

  it('binds only canonical generators and reaches plugins from templates.ts only through application', async () => {
    const bindings = await importsOf(path.join(sourceRoot, 'application', 'project', 'plugin-renderers.ts'));
    const runtimeTargets = bindings.filter((entry) => entry.runtime).map((entry) => relative(entry.target ?? entry.specifier));
    expect(runtimeTargets.filter((target) => !target.startsWith('generators/') && target !== 'application/project/plugins.ts')).toEqual([]);
    const templates = await importsOf(path.join(sourceRoot, 'templates.ts'));
    expect(templates.filter((entry) => entry.runtime && within(entry.target, 'plugins')).map((entry) => entry.specifier)).toEqual([]);
    expect(templates.filter((entry) => entry.runtime && entry.target?.endsWith(`${path.sep}template-assets.ts`))).toEqual([]);
    expect(templates.filter((entry) => within(entry.target, 'application')).map((entry) => relative(entry.target as string)).sort())
      .toEqual([
        'application/project/catalog.ts', 'application/project/manifest-writer.ts',
        'application/project/manifest.ts', 'application/project/modern-managed-core.ts',
        'application/project/modern-plugins.ts', 'application/project/plugin-renderers.ts',
        'application/project/plugins.ts'
      ]);
  });

  it('discovers nothing at runtime and never reads host platform state', async () => {
    for (const file of [...await ownedBuiltins(), ...compositionModules]) {
      const code = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, relative(file)).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\breaddir|\bopendir|\bglob\b|process\.(platform|arch|env|cwd)/);
    }
  });
});
