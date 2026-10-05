import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as declarationModule from '../src/plugins/builtin/assets.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import type { ContributionOwner } from '../src/plugins/contracts.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import type { ProjectOptions } from '../src/types.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Core-owned files outside the template dependency sets, including modern shared source assets.
// Their readers and the PowerShell helper's pinned-digest verifier retain exact file ownership.
const coreAncillaryAssets = [
  'assets/governance/modern/source-contracts.json',
  'assets/governance/single-maintainer-gitflow/activation-v2-graph.json',
  'assets/governance/single-maintainer-gitflow/activation-v3-graph.json',
  'assets/governance/single-maintainer-gitflow/assessment-controls.json',
  'assets/governance/single-maintainer-gitflow/policy-v7.md',
  'assets/governance/single-maintainer-gitflow/policy.md',
  'assets/governance/team-gitflow/policy-v1.md',
  'assets/repair/windows-job-controller.ps1',
  'assets/skills/assessment.md',
  'assets/skills/governance-assessment.md',
  'assets/skills/repair.md',
  'assets/skills/setup.md',
  'assets/supported-stack.json'
];

// Unreferenced setuptools output without an owner, retained byte-for-byte in the repository and
// excluded from the package.
const unownedRetainedAssets = [
  'assets/locks/python-genai/liftoff_template_python_genai.egg-info/PKG-INFO',
  'assets/locks/python-genai/liftoff_template_python_genai.egg-info/SOURCES.txt',
  'assets/locks/python-genai/liftoff_template_python_genai.egg-info/dependency_links.txt',
  'assets/locks/python-genai/liftoff_template_python_genai.egg-info/requires.txt',
  'assets/locks/python-genai/liftoff_template_python_genai.egg-info/top_level.txt'
];

const declaredPaths = builtinAssets.map((asset) => asset.pathParts.join('/'));
const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function ownerKey(owner: ContributionOwner): string {
  return owner.kind === 'core' ? 'core' : `${owner.category}:${owner.id}`;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

// Tracked plus untracked, non-ignored paths: an unstaged relocation is inventoried exactly
// without requiring or performing staging.
function gitAssetView(root: string): string[] {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'assets']);
  return [...new Set(listed.split('\0').filter(Boolean))].sort();
}

interface AssetEntryReport {
  readonly present: string[];
  /** Links and every other non-regular entry are reported, never skipped. */
  readonly nonRegular: string[];
  /** Listed by Git but absent from the working tree, such as a relocated path before staging. */
  readonly absent: string[];
}

function classifyAssetEntries(root: string, entries: readonly string[]): AssetEntryReport {
  const report: AssetEntryReport = { present: [], nonRegular: [], absent: [] };
  for (const entry of entries) {
    let info;
    try {
      info = lstatSync(path.join(root, ...entry.split('/')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      report.absent.push(entry);
      continue;
    }
    (info.isFile() ? report.present : report.nonRegular).push(entry);
  }
  return report;
}

// Git lists a link to a directory as one entry and does not list sockets or FIFOs at all, so the
// working tree is also walked with lstat, starting with the root entry itself: a linked or
// non-directory root is reported and never traversed. This describes a non-racing tree; it is
// not atomic protection against concurrent filesystem changes.
function nonRegularEntriesUnder(root: string, start: readonly string[]): string[] {
  if (!lstatSync(path.join(root, ...start)).isDirectory()) return [start.join('/')];
  const found: string[] = [];
  const visit = (parts: readonly string[]): void => {
    for (const name of readdirSync(path.join(root, ...parts)).sort()) {
      const child = [...parts, name];
      const info = lstatSync(path.join(root, ...child));
      if (info.isDirectory()) visit(child);
      else if (!info.isFile()) found.push(child.join('/'));
    }
  };
  visit(start);
  return found.sort();
}

function checkedAttributes(root: string, files: readonly string[]): Map<string, Record<string, string>> {
  const attributes = new Map<string, Record<string, string>>();
  for (const line of git(root, ['check-attr', 'text', 'eol', '--', ...files]).split('\n').filter(Boolean)) {
    const [file, name, value] = line.split(': ');
    attributes.set(file, { ...attributes.get(file), [name]: value });
  }
  return attributes;
}

describe('packaged template asset declarations', () => {
  it('declares each template dependency-set asset once with an explicit owner inside that owner root', () => {
    const identities = builtinAssets.map((asset) => `${ownerKey(asset.owner)}\u0000${asset.id}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(new Set(builtinAssets.map((asset) => asset.id)).size).toBe(builtinAssets.length);
    const aliasKeys = builtinAssets.map((asset) =>
      asset.pathParts.map((part) => part.normalize('NFC').toLowerCase()).join('/'));
    expect(new Set(aliasKeys).size).toBe(aliasKeys.length);

    for (const asset of builtinAssets) {
      const label = `${ownerKey(asset.owner)}/${asset.id}`;
      const ownerRoot = asset.owner.kind === 'core'
        ? ['assets', 'templates', 'common']
        : ['assets', 'plugins', asset.owner.id];
      expect(asset.pathParts.slice(0, ownerRoot.length), label).toEqual(ownerRoot);
      expect(asset.pathParts, `${label} must be <owner root>/<set>/<file>`).toHaveLength(ownerRoot.length + 2);
      expect(asset.pathParts.at(-2), label).toBe(asset.set);
      for (const part of asset.pathParts) {
        expect(part, label).toMatch(/^[a-z0-9._-]+$/);
        expect(['.', '..'], label).not.toContain(part);
      }
    }

    const sets = new Map<string, typeof builtinAssets[number][]>();
    for (const asset of builtinAssets) sets.set(asset.set, [...(sets.get(asset.set) ?? []), asset]);
    const directories = new Set<string>();
    for (const [set, members] of sets) {
      expect(new Set(members.map((member) => ownerKey(member.owner))).size, `${set} owners`).toBe(1);
      const directory = new Set(members.map((member) => member.pathParts.slice(0, -1).join('/')));
      expect(directory.size, `${set} directories`).toBe(1);
      directories.add([...directory][0]);
      const roles = members.map((member) => member.role);
      expect(roles.filter((role) => role === 'manifest'), `${set} manifest`).toHaveLength(1);
      expect(roles.filter((role) => role === 'lock'), `${set} lock`).toHaveLength(1);
      expect(roles.filter((role) => role === 'export').length, `${set} export`).toBeLessThanOrEqual(1);
    }
    expect(directories.size).toBe(sets.size);
  });

  it('keeps the declaration table a deeply frozen, data-only leaf', () => {
    expect(Object.keys(declarationModule)).toEqual(['builtinAssets']);
    expect(Object.isFrozen(builtinAssets)).toBe(true);
    for (const asset of builtinAssets) {
      expect(Object.isFrozen(asset)).toBe(true);
      expect(Object.isFrozen(asset.owner)).toBe(true);
      expect(Object.isFrozen(asset.pathParts)).toBe(true);
    }
    const source = readFileSync(path.join(repositoryRoot, 'src', 'plugins', 'builtin', 'assets.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const imports = source.match(/^\s*import\b.*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !/^\s*import\s+type\s/.test(line))).toEqual([]);
    // String literal contents (asset ids and path parts) are data, not code.
    const code = source.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    expect(code).not.toMatch(/\bfunction\b|=>|\bclass\b|\bnew\b|\brequire\s*\(|\bimport\s*\(/);
  });
});

describe('working-tree asset inventory', () => {
  it('matches the declared, core ancillary and retained assets exactly without staging', () => {
    const report = classifyAssetEntries(repositoryRoot, gitAssetView(repositoryRoot));
    const nonRegular = [...new Set([
      ...report.nonRegular,
      ...nonRegularEntriesUnder(repositoryRoot, ['assets'])
    ])].sort();
    expect(nonRegular, 'links and other non-regular entries under assets/').toEqual([]);

    const expected = [...declaredPaths, ...coreAncillaryAssets, ...unownedRetainedAssets].sort();
    expect(new Set(expected).size).toBe(expected.length);
    expect(report.present.sort()).toEqual(expected);
    // Git may still list relocated paths until the change is staged; a declared asset never may be absent.
    expect(report.absent.filter((entry) => expected.includes(entry))).toEqual([]);
  });

  it('reports links and other non-regular entries instead of skipping them', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'asset-inventory-'));
    cleanups.push(root);
    mkdirSync(path.join(root, 'assets', 'real'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'real', 'kept.txt'), 'kept\n');
    symlinkSync(path.join(root, 'assets', 'real'), path.join(root, 'assets', 'linked-dir'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const entries = ['assets/real/kept.txt', 'assets/linked-dir', 'assets/relocated.txt'];
    const links = ['assets/linked-dir'];
    if (process.platform !== 'win32') {
      symlinkSync('kept.txt', path.join(root, 'assets', 'real', 'linked-file.txt'));
      entries.push('assets/real/linked-file.txt');
      links.push('assets/real/linked-file.txt');
    }

    const report = classifyAssetEntries(root, entries);
    expect(report.present).toEqual(['assets/real/kept.txt']);
    expect(report.absent).toEqual(['assets/relocated.txt']);
    expect(report.nonRegular.sort()).toEqual(links.sort());
    expect(nonRegularEntriesUnder(root, ['assets'])).toEqual(links.sort());
  });

  it('refuses a linked or non-directory assets root without traversing it', () => {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const root = mkdtempSync(path.join(os.tmpdir(), 'asset-root-link-'));
    cleanups.push(root);
    const target = path.join(root, 'owned-target');
    mkdirSync(path.join(target, 'nested'), { recursive: true });
    writeFileSync(path.join(target, 'nested', 'kept.txt'), 'kept\n');
    // Reported as assets/inner-link only if the walk wrongly traversed the linked root.
    symlinkSync(path.join(target, 'nested'), path.join(target, 'inner-link'), linkType);
    symlinkSync(target, path.join(root, 'assets'), linkType);
    expect(lstatSync(path.join(root, 'assets')).isSymbolicLink()).toBe(true);
    expect(nonRegularEntriesUnder(root, ['assets'])).toEqual(['assets']);
    expect(classifyAssetEntries(root, ['assets']).nonRegular).toEqual(['assets']);

    const fileRoot = mkdtempSync(path.join(os.tmpdir(), 'asset-root-file-'));
    cleanups.push(fileRoot);
    writeFileSync(path.join(fileRoot, 'assets'), 'not a directory\n');
    expect(nonRegularEntriesUnder(fileRoot, ['assets'])).toEqual(['assets']);
  });
});

describe('package asset declarations', () => {
  it('declares exactly the template and core ancillary assets as regular-file entries', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      files: string[];
    };
    // Normalized like npm would read it, so separators, prefixes, patterns and portable case aliases
    // of the asset root (ASSETS/, Assets/) cannot hide an entry from the exact comparison below.
    const assetEntries = packageJson.files.filter((entry) => {
      const normalized = entry.replaceAll('\\', '/').replace(/^(?:!|\.\/|\/)+/, '');
      return normalized.split('/')[0].normalize('NFKC').toLowerCase() === 'assets' || /[*?[\]{}()!+@]/.test(entry);
    });
    expect(new Set(assetEntries).size).toBe(assetEntries.length);
    expect([...assetEntries].sort()).toEqual([...declaredPaths, ...coreAncillaryAssets].sort());
    // File or directory comes from lstat, never from the entry name.
    expect(classifyAssetEntries(repositoryRoot, assetEntries))
      .toEqual({ present: assetEntries, nonRegular: [], absent: [] });
    for (const retained of unownedRetainedAssets) {
      expect(assetEntries.filter((entry) => entry === retained || retained.startsWith(`${entry}/`)), retained)
        .toEqual([]);
    }

    expect(declaredPaths.filter((entry) => coreAncillaryAssets.includes(entry))).toEqual([]);
    const ownerRoots = [...new Set(builtinAssets.map((asset) => (asset.owner.kind === 'core'
      ? ['assets', 'templates', 'common']
      : ['assets', 'plugins', asset.owner.id]).join('/')))];
    for (const ancillary of coreAncillaryAssets) {
      expect(ownerRoots.filter((root) => ancillary.startsWith(`${root}/`)), ancillary).toEqual([]);
    }
  });
});

describe('template asset bytes and attributes', () => {
  it('preserves the frozen v3 graph and original CRLF record capture at checkout', () => {
    const graph = 'assets/governance/single-maintainer-gitflow/activation-v3-graph.json';
    const records = 'tests/fixtures/activation-v3/records.json';
    const attributes = checkedAttributes(repositoryRoot, [graph, records]);
    expect(attributes.get(graph)).toEqual({ text: 'set', eol: 'lf' });
    expect(attributes.get(records)).toEqual({ text: 'unset', eol: 'unspecified' });
    expect(readFileSync(path.join(repositoryRoot, graph)).includes(13)).toBe(false);
    const captured = readFileSync(path.join(repositoryRoot, records), 'utf8');
    expect(captured).toContain('\r\n');
    expect(captured.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });

  it('stores every declared template asset as LF-only UTF-8 with LF checkout attributes', () => {
    const attributes = checkedAttributes(repositoryRoot, declaredPaths);
    for (const asset of builtinAssets) {
      const relative = asset.pathParts.join('/');
      const absolute = path.join(repositoryRoot, ...asset.pathParts);
      const info = lstatSync(absolute);
      expect(info.isFile() && !info.isSymbolicLink(), `${relative} is a regular file`).toBe(true);
      const bytes = readFileSync(absolute);
      expect(bytes.includes(13), `${relative} contains a carriage return`).toBe(false);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${relative} starts with a BOM`).toBe(false);
      expect(bytes.at(-1), `${relative} ends with a line feed`).toBe(10);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      expect(Buffer.from(text, 'utf8').equals(bytes), `${relative} is exact UTF-8`).toBe(true);
      expect(attributes.get(relative), relative).toEqual({ text: 'set', eol: 'lf' });
    }
  });
});

describe('generated project layout', () => {
  it('never places the packaged asset layout inside generated projects', () => {
    const selections: Partial<ProjectOptions>[] = [
      { projectType: 'standard', apiStack: 'python' },
      { projectType: 'standard', apiStack: 'node', includeFrontend: true },
      { projectType: 'standard', apiStack: 'go' },
      { pattern: 'rag', includeFrontend: true, specWorkflow: 'spec-kit' }
    ];
    for (const selection of selections) {
      const plan = buildProjectPlan({
        projectName: 'Asset Layout', cloud: 'azure', region: 'eastus', ...selection
      }, { requireProjectName: true });
      const files = buildArtifacts(plan).map((artifact) => artifact.pathParts.join('/'));
      expect(files.filter((file) => /^assets\/(?:plugins|templates)\//.test(file))).toEqual([]);
    }
  });
});
