import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMergePreflight,
  authorizeMergePreflight,
  buildMergePreflight,
  InitFileSystemError,
  withStagingArea,
  writeStagedArtifacts,
  type PreflightEntry
} from '../src/init-filesystem.js';
import { PluginRegistryError, type PluginRegistryInput } from '../src/plugins/contracts.js';
import { createPluginRegistry } from '../src/plugins/registry.js';
import { buildArtifacts } from '../src/templates.js';
import { matrixPlan, pluginGenerationMatrix, type MatrixCase } from './fixtures/plugin-generation-matrix.js';
import {
  capabilityLabel,
  caseClass,
  createDirectoryLink,
  createOwnedRoot,
  describeNativeCapabilities,
  lstatWalk,
  materializeGroup,
  nativeCapabilities,
  normalizationClass,
  removeAllOwnedRoots,
  type NativeEntryKind
} from './fixtures/native-path-capabilities.js';
import { descriptorOf, refreshRelease, registryInput, type MutableInput } from './plugin-registry-fixtures.js';

// Host-neutral rows (the registry) are identical everywhere and are not native evidence. Native rows
// report only what this host's probed temporary directory did; lanes that did not run are unrun.

afterEach(() => {
  vi.unstubAllEnvs();
  removeAllOwnedRoots();
});

afterAll(() => {
  console.info(describeNativeCapabilities());
});

interface ComposedPlan {
  readonly entry: MatrixCase;
  readonly pathParts: readonly (readonly string[])[];
}

// Rendered once at collection: the portable parts of every artifact of the fixed matrix cases.
const composed: readonly ComposedPlan[] = pluginGenerationMatrix.map((entry) => ({
  entry,
  pathParts: buildArtifacts(matrixPlan(entry)).map((artifact) => [...artifact.pathParts])
}));

interface GroupEntry {
  readonly name: string;
  readonly kind: NativeEntryKind;
}

// Data selection only: the entries each rendered directory holds, keeping a name used both as a
// file and as a directory twice so that materialization fails loudly.
function siblingGroups(pathParts: readonly (readonly string[])[]): GroupEntry[][] {
  const groups = new Map<string, Map<string, GroupEntry>>();
  for (const parts of pathParts) {
    parts.forEach((name, index) => {
      const parent = parts.slice(0, index).join('/');
      const kind: NativeEntryKind = index === parts.length - 1 ? 'file' : 'directory';
      const group = groups.get(parent) ?? new Map<string, GroupEntry>();
      groups.set(parent, group);
      group.set(`${kind}:${name}`, { name, kind });
    });
  }
  return [...groups.values()].map((group) => [...group.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.kind < right.kind ? -1 : 1));
}

const distinctGroups: readonly GroupEntry[][] = (() => {
  const distinct = new Map<string, GroupEntry[]>();
  for (const plan of composed) {
    for (const group of siblingGroups(plan.pathParts)) distinct.set(JSON.stringify(group), group);
  }
  return [...distinct.values()];
})();
const groupEntryCount = distinctGroups.reduce((total, group) => total + group.length, 0);
const groupWidth = String(distinctGroups.length).length;
const t1RootPattern = path.join(os.tmpdir(), 'liftoff-native-t1-XXXXXX');
const longestGroupName = Math.max(...distinctGroups.flat().map((entry) => entry.name.length));
const t1LongestAbsolute = path.join(t1RootPattern, `g${'0'.repeat(groupWidth)}`, 'x'.repeat(longestGroupName)).length;

function registryCodes(input: MutableInput): string[] {
  try {
    createPluginRegistry(input as unknown as PluginRegistryInput);
  } catch (error) {
    if (!(error instanceof PluginRegistryError)) throw error;
    return [...new Set(error.issues.map((issue) => issue.code))].sort();
  }
  return [];
}

function coreCorpusInput(entries: readonly { readonly logicalName: string; readonly name: string }[]): MutableInput {
  const input = registryInput();
  for (const entry of entries) {
    input.core.artifacts.push({
      logicalName: entry.logicalName,
      category: 'documentation',
      pathParts: ['native-corpus', entry.name],
      lifecycle: 'seed'
    });
  }
  return refreshRelease(input);
}

const windowsForms = [
  'backend\\main.py',
  '\\\\srv\\share',
  '\\\\?\\C:\\x',
  'C:main.py',
  'main.py:zone',
  'main.py ',
  'MAIN~1.PY',
  'nul.txt',
  'COM1',
  'LPT9.log',
  'CONIN$',
  'CLOCK$',
  'COM\u00b9'
];

// Names outside the Win32 device list with ordinary-file semantics only; no potential device name is created.
const acceptedCorpus = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789', '_', '-',
  '.a', 'a.b', 'a..b', '..a', '_.-',
  'com10', 'lpt10', 'conx', 'nul1', 'aux0', 'prn0', 'con-', 'nul_'
];
const letters = [...'abcdefghijklmnopqrstuvwxyz'];

describe('composed plugin identities on the native filesystem', () => {
  it('refuses Windows alias and escape forms in plugin artifacts, core artifacts and asset declarations (host-neutral)', () => {
    const places: readonly [string, string, (input: MutableInput, form: string) => void][] = [
      ['plugin artifact', 'invalid-artifact', (input, form) => { descriptorOf(input, 'stack-alpha').artifacts[0].pathParts = ['backend', form]; }],
      ['core artifact', 'invalid-artifact', (input, form) => { input.core.artifacts[0].pathParts = ['docs', form]; }],
      ['asset declaration', 'invalid-asset', (input, form) => {
        descriptorOf(input, 'stack-alpha').assets[0].pathParts = ['assets', 'plugins', 'stack-alpha', form];
      }]
    ];
    for (const [place, code, mutate] of places) {
      for (const form of windowsForms) {
        const input = registryInput();
        mutate(input, form);
        expect(registryCodes(input), `${place} ${JSON.stringify(form)}`).toEqual([code]);
      }
    }
  });

  it(`materializes every distinct composed sibling group exactly (${distinctGroups.length} groups, ${groupEntryCount} entries, ` +
    `${composed.length} rendered plans; probed directory ${caseClass}, ${normalizationClass}; ` +
    `longest absolute path created ${t1LongestAbsolute} code units, no length claim)`, () => {
    const root = createOwnedRoot('t1');
    expect(root.length).toBe(t1RootPattern.length);
    const mismatches: unknown[] = [];
    let longestCreated = 0;
    distinctGroups.forEach((group, index) => {
      const directory = path.join(root, `g${String(index).padStart(groupWidth, '0')}`);
      mkdirSync(directory);
      const result = materializeGroup(directory, group);
      const expected = {
        errors: [],
        listing: group.map((entry) => entry.name).sort(),
        kinds: Object.fromEntries(group.map((entry) => [entry.name, entry.kind]))
      };
      if (!isDeepStrictEqual({ ...result, kinds: { ...result.kinds } }, expected)) mismatches.push({ group, result });
      for (const entry of group) longestCreated = Math.max(longestCreated, path.join(directory, entry.name).length);
    });
    expect(mismatches).toEqual([]);
    expect(longestCreated).toBe(t1LongestAbsolute);
  }, 120_000);

  it(`detects an exact duplicate on every host and a case pair only where the probed directory folds case (${caseClass})`, () => {
    const root = createOwnedRoot('t1-sanity');
    const duplicate = path.join(root, 'duplicate');
    mkdirSync(duplicate);
    expect(materializeGroup(duplicate, [{ name: 'x', kind: 'file' }, { name: 'x', kind: 'file' }]))
      .toEqual({ errors: [{ name: 'x', code: 'EEXIST' }], listing: ['x'], kinds: { x: 'file' } });
    const pair = path.join(root, 'pair');
    mkdirSync(pair);
    expect(materializeGroup(pair, [{ name: 'a', kind: 'file' }, { name: 'A', kind: 'file' }])).toEqual(
      nativeCapabilities.caseInsensitive
        ? { errors: [{ name: 'A', code: 'EEXIST' }], listing: ['a'], kinds: { a: 'file' } }
        : { errors: [], listing: ['A', 'a'], kinds: { A: 'file', a: 'file' } }
    );
  });

  it(`accepts the 51-name portable corpus and materializes it without native aliasing (probed directory ${caseClass}, ${normalizationClass})`, () => {
    expect(acceptedCorpus).toHaveLength(51);
    expect(new Set(acceptedCorpus).size).toBe(51);
    expect(registryCodes(coreCorpusInput(acceptedCorpus.map((name, index) => ({ logicalName: `core-native-${index}`, name })))))
      .toEqual([]);
    const root = createOwnedRoot('t2a');
    const directory = path.join(root, 'corpus');
    mkdirSync(directory);
    const sorted = [...acceptedCorpus].sort();
    expect(materializeGroup(directory, acceptedCorpus.map((name) => ({ name, kind: 'file' as const }))))
      .toEqual({ errors: [], listing: sorted, kinds: Object.fromEntries(sorted.map((name) => [name, 'file'])) });
  });

  it(`reports all 26 letter-case pairs as portable aliases, and every native collision here is one of them (${caseClass})`, () => {
    let failure: PluginRegistryError | undefined;
    try {
      createPluginRegistry(coreCorpusInput(letters.flatMap((letter) => [
        { logicalName: `core-native-lower-${letter}`, name: letter },
        { logicalName: `core-native-upper-${letter}`, name: letter.toUpperCase() }
      ])) as unknown as PluginRegistryInput);
    } catch (error) {
      if (!(error instanceof PluginRegistryError)) throw error;
      failure = error;
    }
    expect(failure).toBeInstanceOf(PluginRegistryError);
    expect([...new Set(failure!.issues.map((issue) => issue.code))]).toEqual(['path-alias-collision']);
    const portableAliases = failure!.issues.map((issue) => issue.subject).sort();
    expect(portableAliases).toEqual(letters.map((letter) => `path:native-corpus/${letter}`));

    const root = createOwnedRoot('t2b');
    const directory = path.join(root, 'pairs');
    mkdirSync(directory);
    const result = materializeGroup(directory, [
      ...letters.map((letter) => ({ name: letter, kind: 'file' as const })),
      ...letters.map((letter) => ({ name: letter.toUpperCase(), kind: 'file' as const }))
    ]);
    expect(result.errors.every((error) => error.code === 'EEXIST')).toBe(true);
    const nativeCollisions = result.errors.map((error) => error.name.toLowerCase()).sort();
    // Uniform, and exactly what the probe classified: all 26 collide or none do.
    expect(nativeCollisions).toEqual(nativeCapabilities.caseInsensitive ? letters : []);
    expect(result.listing).toEqual(nativeCapabilities.caseInsensitive
      ? letters
      : [...letters.map((letter) => letter.toUpperCase()), ...letters]);
    expect(nativeCollisions.every((letter) => portableAliases.includes(`path:native-corpus/${letter}`))).toBe(true);
  });
});

function directoriesOf(pathParts: readonly (readonly string[])[]): Set<string> {
  const directories = new Set<string>();
  for (const parts of pathParts) {
    for (let index = 0; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  return directories;
}

function nativeDirectory(root: string, directory: string): string {
  return directory === '' ? root : path.join(root, ...directory.split('/'));
}

function sharedChildPair(pathParts: readonly (readonly string[])[]): { d1: string; d2: string; child: string } | undefined {
  const files = new Map<string, Set<string>>();
  for (const parts of pathParts) {
    const directory = parts.slice(0, -1).join('/');
    const names = files.get(directory) ?? new Set<string>();
    files.set(directory, names);
    names.add(parts[parts.length - 1]);
  }
  const directories = [...files.keys()].filter((directory) => directory !== '').sort();
  for (const [index, d1] of directories.entries()) {
    for (const d2 of directories.slice(index + 1)) {
      if (d2.startsWith(`${d1}/`) || d1.startsWith(`${d2}/`)) continue;
      const shared = [...files.get(d1)!].filter((name) => files.get(d2)!.has(name)).sort();
      if (shared.length > 0) return { d1, d2, child: shared[0] };
    }
  }
  return undefined;
}

const unownedPrefix = 'zz-liftoff-unowned';
// A selection bound for test paths, not a claim about any host's maximum path length.
const selectionBound = 240;

interface CoverPlan extends ComposedPlan {
  readonly index: number;
  readonly planRoot: string;
  readonly directories: Set<string>;
  readonly longest: number;
}

function coverSelection(root: string) {
  const plans: CoverPlan[] = composed.map((plan, index) => {
    const planRoot = path.join(root, `p${String(index).padStart(3, '0')}`);
    const target = path.join(planRoot, 'target');
    const stagingArea = path.join(planRoot, 'staging', 'liftoff-init-XXXXXX');
    const longest = Math.max(...plan.pathParts.map((parts) =>
      Math.max(path.join(target, ...parts).length, path.join(stagingArea, ...parts).length)));
    return { ...plan, index, planRoot, directories: directoriesOf(plan.pathParts), longest };
  });
  const included = plans.filter((plan) => plan.longest <= selectionBound);
  const excluded = plans.filter((plan) => plan.longest > selectionBound);
  const universe = new Set(included.flatMap((plan) => [...plan.directories]));
  const uncovered = new Set(universe);
  const chosen: CoverPlan[] = [];
  while (uncovered.size > 0) {
    let best: CoverPlan | undefined;
    let gain = 0;
    for (const plan of included) {
      const covers = [...plan.directories].filter((directory) => uncovered.has(directory)).length;
      if (covers > gain) {
        best = plan;
        gain = covers;
      }
    }
    chosen.push(best!);
    for (const directory of best!.directories) uncovered.delete(directory);
  }
  const notCovered = [...new Set(excluded.flatMap((plan) => [...plan.directories]))]
    .filter((directory) => !universe.has(directory)).sort();
  // Covered directories that hold no generated file themselves, only generated subdirectories.
  const fileDirectories = new Set(included.flatMap((plan) => plan.pathParts.map((parts) => parts.slice(0, -1).join('/'))));
  const directoryOnly = [...universe].filter((directory) => !fileDirectories.has(directory)).sort();
  return { chosen, excluded, universe, notCovered, directoryOnly };
}

async function initialize(plan: CoverPlan, prepare: (target: string, directories: readonly string[]) => void) {
  const target = path.join(plan.planRoot, 'target');
  const staging = path.join(plan.planRoot, 'staging');
  mkdirSync(target, { recursive: true });
  mkdirSync(staging);
  vi.stubEnv('LIFTOFF_STAGING_ROOT', staging);
  const directories = [...plan.directories].sort();
  for (const directory of directories) mkdirSync(nativeDirectory(target, directory), { recursive: true });
  prepare(target, directories);
  const before = lstatWalk(target);
  const artifacts = buildArtifacts(matrixPlan(plan.entry));
  let entries: readonly PreflightEntry[] = [];
  let reported: string[] = [];
  await withStagingArea(async (area) => {
    await writeStagedArtifacts(area, artifacts, 'liftoff');
    const preflight = await buildMergePreflight(area, target);
    entries = preflight.entries;
    const authorized = await authorizeMergePreflight(preflight, false);
    expect(authorized, plan.entry.id).toBe(preflight);
    const result = await applyMergePreflight(authorized!);
    expect([result.replaced, result.identical], plan.entry.id).toEqual([[], []]);
    reported = [...result.created, ...result.mergedDirectories];
  });
  return { target, before, after: lstatWalk(target), artifacts, entries, reported };
}

const mentions = (value: string, name: string): boolean => value.split(/[\\/]/).some((part) => part.startsWith(name));

describe('composed plugin destinations on the native filesystem', () => {
  it.skipIf(!nativeCapabilities.directoryLinks.available)(
    `refuses composed contributions that would collide through a destination directory link ${capabilityLabel('directory links', nativeCapabilities.directoryLinks)}`,
    async () => {
      const selected = composed.map((plan) => ({ plan, pair: sharedChildPair(plan.pathParts) })).find((candidate) => candidate.pair);
      expect(selected, 'a rendered plan with two non-nested directories that share a child file name').toBeDefined();
      const { plan, pair } = selected!;
      const root = createOwnedRoot('j1');
      const target = path.join(root, 'target');
      const staging = path.join(root, 'staging');
      mkdirSync(target);
      mkdirSync(staging);
      vi.stubEnv('LIFTOFF_STAGING_ROOT', staging);
      const d1 = nativeDirectory(target, pair!.d1);
      const d2 = nativeDirectory(target, pair!.d2);
      mkdirSync(d1, { recursive: true });
      mkdirSync(path.dirname(d2), { recursive: true });
      createDirectoryLink(d1, d2);
      const before = lstatWalk(target);

      await withStagingArea(async (area) => {
        await writeStagedArtifacts(area, buildArtifacts(matrixPlan(plan.entry)), 'liftoff');
        const preflight = await buildMergePreflight(area, target);
        const throughLink = preflight.entries.filter((entry) => {
          const portable = entry.pathParts.join('/');
          return portable === pair!.d2 || portable.startsWith(`${pair!.d2}/`);
        });
        expect(throughLink.map((entry) => entry.pathParts.join('/')), plan.entry.id)
          .toContain(`${pair!.d2}/${pair!.child}`);
        expect(preflight.blocked.map((entry) => [entry.relativePath, entry.detail]))
          .toEqual(throughLink.map((entry) => [entry.relativePath, `symlink at ${pair!.d2}`]));
        await expect(authorizeMergePreflight(preflight, true)).rejects.toThrow(InitFileSystemError);
        await expect(authorizeMergePreflight(preflight, true)).rejects.toThrow(/structural or symlink conflicts/);
      });

      expect(lstatWalk(target)).toEqual(before);
      console.info(`J1 ${plan.entry.id}: ${pair!.d2} linked to ${pair!.d1}, shared child ${pair!.child}`);
    },
    60_000
  );

  it(`leaves unowned files, subdirectories and modes untouched in every composed directory (greedy cover; ` +
    `${selectionBound}-code-unit path selection bound, not a MAX_PATH claim)`, async () => {
    const root = createOwnedRoot('n1');
    const { chosen, excluded, universe, notCovered, directoryOnly } = coverSelection(root);
    for (const plan of composed) {
      expect(plan.pathParts.flat().filter((part) => part.startsWith(unownedPrefix)), plan.entry.id).toEqual([]);
    }
    const seeded = new Set<string>();
    for (const plan of chosen) {
      mkdirSync(plan.planRoot);
      const run = await initialize(plan, (target, directories) => {
        directories.forEach((directory, index) => {
          const base = nativeDirectory(target, directory);
          const file = path.join(base, `${unownedPrefix}-${index}.txt`);
          writeFileSync(file, `unowned ${plan.entry.id} ${directory}\n`, { flag: 'wx' });
          if (process.platform !== 'win32') chmodSync(file, 0o640);
          const subdirectory = path.join(base, `${unownedPrefix}-dir-${index}`);
          mkdirSync(subdirectory);
          writeFileSync(path.join(subdirectory, 'inner.txt'), `inner ${index}\n`, { flag: 'wx' });
          if (process.platform !== 'win32') chmodSync(subdirectory, 0o750);
          seeded.add(directory);
        });
      });
      expect(run.entries.filter((entry) => entry.pathParts.some((part) => part.startsWith(unownedPrefix))), plan.entry.id).toEqual([]);
      expect(run.entries.filter((entry) => entry.action !== 'create' && entry.action !== 'merge-directory')
        .map((entry) => [entry.relativePath, entry.action, entry.detail]), plan.entry.id).toEqual([]);
      expect(run.reported.filter((relative) => mentions(relative, unownedPrefix)), plan.entry.id).toEqual([]);
      for (const key of Object.keys(run.before)) expect(run.after[key], `${plan.entry.id} ${key}`).toBe(run.before[key]);
      const generated = new Map(run.artifacts.map((artifact) => [artifact.pathParts.join('/'), artifact.content]));
      expect(Object.keys(run.after).sort(), plan.entry.id).toEqual([...new Set([...Object.keys(run.before), ...generated.keys()])].sort());
      for (const [key, content] of generated) {
        expect(readFileSync(nativeDirectory(run.target, key), 'utf8'), `${plan.entry.id} ${key}`).toBe(content);
      }
      expect(readdirSync(plan.planRoot).sort(), plan.entry.id).toEqual(['staging', 'target']);
    }
    expect([...seeded].sort()).toEqual([...universe].sort());
    console.info(`N1 cover: ${chosen.length} plans (${chosen.map((plan) => plan.entry.id).join(', ')}) seeded ${universe.size} directories; ` +
      `excluded ${excluded.length} (${excluded.map((plan) => `${plan.entry.id} longest ${plan.longest}`).join(', ') || 'none'}); ` +
      `not covered ${notCovered.length}: ${notCovered.join(', ') || 'none'}; ` +
      `seeded directory-only directories ${directoryOnly.length}: ${directoryOnly.join(', ') || 'none'}`);
  }, 300_000);

  it.skipIf(!nativeCapabilities.directoryLinks.available)(
    `never follows, reports or changes an unowned directory link inside a composed directory ${capabilityLabel('directory links', nativeCapabilities.directoryLinks)}`,
    async () => {
      const root = createOwnedRoot('nj');
      const outside = createOwnedRoot('nj-outside');
      writeFileSync(path.join(outside, 'sentinel.txt'), 'outside\n', { flag: 'wx' });
      const outsideBefore = lstatWalk(outside);
      const [plan] = coverSelection(root).chosen;
      const deepest = [...plan.directories].filter((directory) => directory !== '')
        .sort((left, right) => right.split('/').length - left.split('/').length || (left < right ? -1 : left > right ? 1 : 0))[0];
      const linkName = `${unownedPrefix}-link`;
      mkdirSync(plan.planRoot);
      const run = await initialize(plan, (target) => {
        createDirectoryLink(outside, path.join(nativeDirectory(target, deepest), linkName));
      });
      const linkKey = `${deepest}/${linkName}`;
      expect(run.before[linkKey]).toMatch(/^link:/);
      expect(run.after[linkKey]).toBe(run.before[linkKey]);
      expect(run.entries.filter((entry) => entry.pathParts.includes(linkName))).toEqual([]);
      expect(run.reported.filter((relative) => mentions(relative, linkName))).toEqual([]);
      expect(lstatWalk(outside)).toEqual(outsideBefore);
      expect(readdirSync(plan.planRoot).sort()).toEqual(['staging', 'target']);
      console.info(`N1-J ${plan.entry.id}: unowned link in ${deepest}`);
    },
    120_000
  );
});
