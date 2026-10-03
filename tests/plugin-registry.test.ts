import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createProjectCatalog } from '../src/domain/project/catalog.js';
import type { GeneratedArtifact } from '../src/domain/project/contracts.js';
import { buildProjectPlanWithCatalog, PlanValidationError } from '../src/domain/project/planning.js';
import {
  PluginRegistryError,
  pluginIssueCodes,
  pluginRegistryLimits,
  type PluginIssueCode,
  type PluginRegistry,
  type PluginRegistryInput,
  type PluginResolution,
  type PluginSelection
} from '../src/plugins/contracts.js';
import { createPluginRegistry, pluginContentDigest } from '../src/plugins/registry.js';
import {
  allHosts,
  bytesEntryOf,
  bytesOf,
  descriptorOf,
  minimalRegistryInput,
  minimalSelection,
  refreshRelease,
  registryInput,
  reversedInput,
  selectionOf,
  sha256Of,
  sharedAssetOf,
  type MutableInput
} from './plugin-registry-fixtures.js';

const observedCodes = new Set<PluginIssueCode>();
const host = { platform: 'linux/x64' };

function build(input: MutableInput): PluginRegistry {
  return createPluginRegistry(input as unknown as PluginRegistryInput);
}

function failure(action: () => unknown): PluginRegistryError {
  try {
    action();
  } catch (error) {
    if (!(error instanceof PluginRegistryError)) throw error;
    for (const issue of error.issues) observedCodes.add(issue.code);
    return error;
  }
  throw new Error('expected a PluginRegistryError');
}

function codesOf(error: PluginRegistryError): string[] {
  return [...new Set(error.issues.map((issue) => issue.code))].sort();
}

/** Refreshes release digests when the content is digestible; structurally malformed content is not. */
function tryRefresh(input: MutableInput): MutableInput {
  try {
    return refreshRelease(input);
  } catch (error) {
    if (!(error instanceof PluginRegistryError)) throw error;
    return input;
  }
}

function registryFailure(mutate: (input: MutableInput) => void, refresh = true): PluginRegistryError {
  const input = registryInput();
  mutate(input);
  if (refresh) tryRefresh(input);
  return failure(() => build(input));
}

function expectOnly(error: PluginRegistryError, code: PluginIssueCode, subject?: string): void {
  expect(codesOf(error)).toEqual([code]);
  if (subject !== undefined) expect(error.issues.map((issue) => issue.subject)).toContain(subject);
}

function resolve(registry: PluginRegistry, overrides: Partial<PluginSelection> = {}, on = host): PluginResolution {
  const selection = selectionOf(overrides) as Record<string, unknown>;
  for (const key of Object.keys(selection)) if (selection[key] === undefined) delete selection[key];
  return registry.resolveSelection(selection as unknown as PluginSelection, on);
}

function rendered(resolution: PluginResolution): GeneratedArtifact[] {
  return resolution.artifacts.map((artifact) => ({
    logicalName: artifact.logicalName,
    category: artifact.category,
    pathParts: [...artifact.pathParts],
    lifecycle: artifact.lifecycle,
    ...(artifact.provisioningGroup === undefined ? {} : { provisioningGroup: artifact.provisioningGroup }),
    content: `content of ${artifact.logicalName}\n`
  }) as GeneratedArtifact).reverse();
}

function oracleJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (typeof entry === 'object' && entry !== null) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonical((entry as Record<string, unknown>)[key])]));
    }
    return entry;
  };
  return `${JSON.stringify(canonical(value))}\n`;
}

function oracleDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(oracleJson(value)).digest('hex')}`;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('bundled plugin registry: valid composition', () => {
  it('builds a frozen canonical inventory without granting authority', () => {
    const registry = build(registryInput());
    expect(registry.apiVersion).toBe(1);
    expect(registry.inventory.map((entry) => `${entry.category}:${entry.id}`)).toEqual([
      'stack:stack-alpha',
      'stack:stack-beta',
      'cloud:cloud-gamma',
      'workflow:flow-delta',
      'workflow:flow-epsilon',
      'agent:agent-kappa',
      'agent:agent-lambda'
    ]);
    for (const digest of [registry.pluginSetDigest, registry.coreContributionDigest, registry.registryDigest]) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(Object.isFrozen(registry)).toBe(true);
    expect(isDeepFrozen(registry.inventory)).toBe(true);
    expect(Object.keys(registry).sort()).toEqual([
      'apiVersion',
      'assetsFor',
      'coreContributionDigest',
      'inventory',
      'pluginSetDigest',
      'registryDigest',
      'resolveSelection',
      'verifyComposedArtifacts'
    ]);
    const alpha = registry.inventory[0];
    expect(alpha.artifacts.map((artifact) => `${artifact.logicalName}:${artifact.pathParts.join('/')}`)).toEqual([
      'backend-main:backend/main.py',
      'backend-observability:backend/obs/plain.py',
      'backend-observability:backend/obs/variant.py',
      'pattern-route:backend/routes/var_a.py',
      'pattern-route:backend/routes/var_b.py'
    ]);
    expect(alpha.assets).toEqual([{ id: 'alpha-lock', sha256: sha256Of(bytesOf('version = 1\n')) }]);
  });

  it('is independent of registration, declaration and condition-value order', () => {
    const input = registryInput();
    const forward = build(input);
    const reversed = build(reversedInput(input));
    expect(reversed.inventory).toEqual(forward.inventory);
    expect(reversed.pluginSetDigest).toBe(forward.pluginSetDigest);
    expect(reversed.coreContributionDigest).toBe(forward.coreContributionDigest);
    expect(reversed.registryDigest).toBe(forward.registryDigest);
    const first = resolve(forward);
    const second = resolve(reversed, { agents: ['agent-kappa', 'agent-lambda'], environments: ['env-one', 'env-two'] });
    expect(second).toEqual(first);
  });

  it('matches an independent canonical digest oracle for every documented digest domain', () => {
    const input = registryInput();
    const registry = build(input);
    const sha = (location: string): string => sha256Of(bytesEntryOf(input, location).bytes);
    const alpha = descriptorOf(input, 'stack-alpha');
    const alphaContent = {
      kind: 'liftoff-plugin-content',
      schemaVersion: 1,
      category: 'stack',
      id: 'stack-alpha',
      apiVersion: 1,
      contentVersion: 1,
      hostPlatforms: [...allHosts].sort(),
      supports: [{ workload: ['wl-plain'] }, { workload: ['wl-variants'] }],
      artifacts: [
        { logicalName: 'backend-main', category: 'backend', pathParts: ['backend', 'main.py'], lifecycle: 'project', provisioningGroup: 'base' },
        { logicalName: 'backend-observability', category: 'backend', pathParts: ['backend', 'obs', 'plain.py'], lifecycle: 'project', provisioningGroup: 'base', when: { workload: ['wl-plain'] } },
        { logicalName: 'backend-observability', category: 'backend', pathParts: ['backend', 'obs', 'variant.py'], lifecycle: 'project', provisioningGroup: 'base', when: { workload: ['wl-variants'] } },
        { logicalName: 'pattern-route', category: 'pattern', pathParts: ['backend', 'routes', 'var_a.py'], lifecycle: 'project', provisioningGroup: 'base', when: { variant: ['var-a'] } },
        { logicalName: 'pattern-route', category: 'pattern', pathParts: ['backend', 'routes', 'var_b.py'], lifecycle: 'project', provisioningGroup: 'base', when: { variant: ['var-b'] } }
      ],
      assets: [{ id: 'alpha-lock', sha256: sha('assets/plugins/stack-alpha/uv.lock') }],
      sharedAssets: [],
      checks: [{ id: 'alpha-project', version: 1, operation: 'op-doctor', effects: ['local-tool', 'project-read'] }],
      recipes: [{ operation: 'op-repair', id: 'recipe-layout', version: 1 }]
    };
    expect(alpha.id).toBe('stack-alpha');
    expect(registry.inventory[0].contentDigest).toBe(oracleDigest(alphaContent));
    expect(pluginContentDigest(registry.inventory[0])).toBe(oracleDigest(alphaContent));
    expect(registry.pluginSetDigest).toBe(oracleDigest({
      kind: 'liftoff-plugin-set',
      schemaVersion: 1,
      pluginApiVersion: 1,
      plugins: registry.inventory.map(({ category, id, apiVersion, contentVersion, contentDigest }) =>
        ({ category, id, apiVersion, contentVersion, contentDigest }))
    }));
    const sharedAssets = [
      { id: 'shared-frontend-lock', sha256: sha('assets/shared/frontend/package-lock.json') },
      { id: 'shared-readme-template', sha256: sha('assets/shared/templates/README.md') }
    ];
    const coreArtifacts = [...input.core.artifacts]
      .map((artifact) => ({ ...artifact, pathParts: [...artifact.pathParts] }))
      .sort((left, right) => (left.logicalName < right.logicalName ? -1 : left.logicalName > right.logicalName ? 1 : 0));
    expect(registry.coreContributionDigest).toBe(oracleDigest({
      kind: 'liftoff-core-contribution',
      schemaVersion: 1,
      artifacts: coreArtifacts,
      sharedAssets,
      managedCore: [
        { logicalName: 'agent-kappa-skill', pathParts: ['.kappa', 'skills', 'liftoff.md'] },
        { logicalName: 'core-governance-policy', pathParts: ['.liftoff', 'governance', 'policy.md'] }
      ],
      retiredLogicalNames: ['retired-thing']
    }));
    expect(registry.registryDigest).toBe(oracleDigest({
      kind: 'liftoff-plugin-registry',
      schemaVersion: 1,
      pluginSetDigest: registry.pluginSetDigest,
      coreContributionDigest: registry.coreContributionDigest,
      selectionSpace: {
        workloads: [{ id: 'wl-plain', variants: [] }, { id: 'wl-variants', variants: ['var-a', 'var-b'] }],
        environments: ['env-one', 'env-two'],
        governanceProfiles: ['gov-off', 'gov-on']
      },
      operations: [
        { id: 'op-doctor', permittedCheckEffects: ['local-tool', 'project-read'], recipes: [] },
        { id: 'op-repair', permittedCheckEffects: ['project-read'], recipes: [{ id: 'recipe-cleanup', version: 2 }, { id: 'recipe-layout', version: 1 }] }
      ]
    }));
    const resolution = resolve(registry);
    const { digest, hostPlatform, ...semantic } = resolution;
    expect(hostPlatform).toBe('linux/x64');
    expect(digest).toBe(oracleDigest({ kind: 'liftoff-plugin-resolution', schemaVersion: 1, pluginApiVersion: 1, ...semantic }));
  });

  it('keeps every content identity stable when only packaged asset locations move', () => {
    const before = build(registryInput());
    const moved = registryInput();
    const alpha = descriptorOf(moved, 'stack-alpha');
    alpha.assets[0].pathParts = ['assets', 'relocated', 'alpha', 'uv.lock'];
    bytesEntryOf(moved, 'assets/plugins/stack-alpha/uv.lock').pathParts = ['assets', 'relocated', 'alpha', 'uv.lock'];
    sharedAssetOf(moved, 'shared-frontend-lock').pathParts = ['assets', 'relocated', 'shared', 'package-lock.json'];
    bytesEntryOf(moved, 'assets/shared/frontend/package-lock.json').pathParts = ['assets', 'relocated', 'shared', 'package-lock.json'];
    refreshRelease(moved);
    const after = build(moved);
    expect(after.inventory).toEqual(before.inventory);
    expect(after.pluginSetDigest).toBe(before.pluginSetDigest);
    expect(after.coreContributionDigest).toBe(before.coreContributionDigest);
    expect(after.registryDigest).toBe(before.registryDigest);
    expect(resolve(after).digest).toBe(resolve(before).digest);
    expect(moved.release.sharedAssets.find((record) => record.id === 'shared-frontend-lock')?.pathParts)
      .toEqual(['assets', 'relocated', 'shared', 'package-lock.json']);
  });

  it('changes content identity for every behavior-bearing descriptor field', () => {
    const baseline = build(registryInput()).inventory[0].contentDigest;
    const mutations: [string, (input: MutableInput) => void][] = [
      ['contentVersion', (input) => { descriptorOf(input, 'stack-alpha').contentVersion = 2; }],
      ['hostPlatforms', (input) => { descriptorOf(input, 'stack-alpha').hostPlatforms = allHosts.filter((entry) => entry !== 'win32/x64'); }],
      ['supports', (input) => { descriptorOf(input, 'stack-alpha').supports[1] = { workload: ['wl-plain'], frontend: ['included'] }; }],
      ['artifact logical name', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].logicalName = 'backend-entry'; }],
      ['artifact category', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].category = 'runtime'; }],
      ['artifact path', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].pathParts = ['backend', 'app.py']; }],
      ['artifact lifecycle', (input) => {
        const artifact = descriptorOf(input, 'stack-alpha').artifacts[0];
        artifact.lifecycle = 'framework';
        delete artifact.provisioningGroup;
      }],
      ['provisioning group', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].provisioningGroup = 'frontend'; }],
      ['artifact condition', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { frontend: ['included'] }; }],
      ['asset bytes', (input) => { bytesEntryOf(input, 'assets/plugins/stack-alpha/uv.lock').bytes = bytesOf('version = 2\n'); }],
      ['shared asset reference', (input) => { descriptorOf(input, 'stack-alpha').sharedAssets = ['shared-frontend-lock']; }],
      ['shared asset bytes', (input) => {
        descriptorOf(input, 'stack-alpha').sharedAssets = ['shared-frontend-lock'];
        bytesEntryOf(input, 'assets/shared/frontend/package-lock.json').bytes = bytesOf('{"lockfileVersion":2}\n');
      }],
      ['check version', (input) => { descriptorOf(input, 'stack-alpha').checks[0].version = 2; }],
      ['check effects', (input) => { descriptorOf(input, 'stack-alpha').checks[0].effects = ['project-read']; }],
      ['check condition', (input) => { descriptorOf(input, 'stack-alpha').checks[0].when = { governanceProfile: ['gov-on'] }; }],
      ['recipe condition', (input) => { descriptorOf(input, 'stack-alpha').recipes[0].when = { frontend: ['omitted'] }; }]
    ];
    const seen = new Set([baseline]);
    for (const [label, mutate] of mutations) {
      const input = registryInput();
      mutate(input);
      const digest = build(refreshRelease(input)).inventory[0].contentDigest;
      expect(digest, label).not.toBe(baseline);
      seen.add(digest);
    }
    expect(seen.size).toBe(mutations.length + 1);
  });

  it('preserves exact asset text including a leading BOM, CRLF and supplementary characters', () => {
    const input = registryInput();
    const original = new Uint8Array([
      0xef, 0xbb, 0xbf,
      ...bytesOf('line one\r\nline two '),
      0xf0, 0x9f, 0x98, 0x80,
      ...bytesOf('\r\n')
    ]);
    bytesEntryOf(input, 'assets/plugins/stack-alpha/uv.lock').bytes = original;
    const registry = build(refreshRelease(input));
    const text = registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'stack-alpha' }).own['alpha-lock'];
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toBe('\uFEFFline one\r\nline two \u{1F600}\r\n');
    expect([...new TextEncoder().encode(text)]).toEqual([...original]);
    expect(registry.inventory[0].assets[0].sha256).toBe(sha256Of(original));
  });

  it('accepts equal bytes under distinct explicit asset identities', () => {
    const input = registryInput();
    const same = bytesOf('same bytes\n');
    bytesEntryOf(input, 'assets/plugins/stack-beta/go.mod').bytes = same;
    bytesEntryOf(input, 'assets/plugins/cloud-gamma/.terraform.lock.hcl').bytes = same;
    const registry = build(refreshRelease(input));
    const beta = registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'stack-beta' });
    const gamma = registry.assetsFor({ kind: 'plugin', category: 'cloud', id: 'cloud-gamma' });
    expect(beta.own['beta-module']).toBe('same bytes\n');
    expect(gamma.own['gamma-lock']).toBe('same bytes\n');
    expect(registry.inventory[1].assets[0].sha256).toBe(registry.inventory[2].assets[0].sha256);
  });

  it('exposes only owner-scoped verified asset texts', () => {
    const registry = build(registryInput());
    const core = registry.assetsFor({ kind: 'core' });
    expect(core).toEqual({
      own: { 'shared-frontend-lock': '{"lockfileVersion":3}\n', 'shared-readme-template': '# Template\n' },
      shared: {}
    });
    const beta = registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'stack-beta' });
    expect(beta).toEqual({
      own: { 'beta-module': 'module example.invalid/beta\n' },
      shared: { 'shared-frontend-lock': '{"lockfileVersion":3}\n' }
    });
    expect(isDeepFrozen(beta)).toBe(true);
    expectOnly(failure(() => registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'stack-zeta' })), 'unknown-plugin');
    expectOnly(failure(() => registry.assetsFor({ kind: 'plugin', category: 'cloud', id: 'stack-beta' })), 'wrong-category');
    expectOnly(failure(() => registry.assetsFor({ kind: 'core', id: 'stack-beta' } as never)), 'invalid-selection');
    expectOnly(failure(() => registry.assetsFor({ kind: 'plugin' } as never)), 'invalid-selection');
    expectOnly(failure(() => registry.assetsFor('core' as never)), 'invalid-selection');
  });

  it('shares no mutable state with its inputs', () => {
    const input = registryInput();
    const registry = build(input);
    const inventory = structuredClone(registry.inventory);
    const resolution = resolve(registry);
    descriptorOf(input, 'stack-alpha').artifacts[0].pathParts[1] = 'changed.py';
    bytesEntryOf(input, 'assets/plugins/stack-alpha/uv.lock').bytes[0] = 0x21;
    input.core.artifacts.length = 0;
    expect(registry.inventory).toEqual(inventory);
    expect(registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'stack-alpha' }).own['alpha-lock']).toBe('version = 1\n');
    expect(resolve(registry)).toEqual(resolution);
  });

  it('keeps the current public catalog identifiers usable as bundled plugin ids', () => {
    const catalog = createProjectCatalog({
      frameworkVersions: { openspec: '1.0.0', 'spec-kit': '1.0.0' },
      governancePolicyVersion: '1'
    });
    const ids = [
      ...catalog.apiStacks.map((stack) => stack.id),
      ...catalog.providers.filter((provider) => provider.status === 'available').map((provider) => provider.id),
      ...catalog.specWorkflows.map((workflow) => workflow.id),
      ...catalog.codingAgents.map((agent) => agent.id)
    ];
    expect(ids).toEqual(['python-fastapi', 'node-fastify', 'go-huma', 'azure', 'openspec', 'spec-kit', 'github-copilot', 'claude', 'codex']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(id.length).toBeLessThanOrEqual(pluginRegistryLimits.maxIdLength);
    }
  });
});

describe('bundled plugin registry: bounded plain-data intake', () => {
  it('rejects accessors without invoking them', () => {
    let invoked = false;
    const input = registryInput();
    Object.defineProperty(descriptorOf(input, 'stack-alpha'), 'entry', {
      enumerable: true,
      get: () => {
        invoked = true;
        return './plugins/evil.js';
      }
    });
    const error = failure(() => build(input));
    expectOnly(error, 'invalid-descriptor');
    expect(error.issues[0].detail).toContain('enumerable data properties');
    const elementAccessor = registryInput();
    Object.defineProperty(descriptorOf(elementAccessor, 'stack-beta').sharedAssets, '0', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'shared-frontend-lock';
      }
    });
    expectOnly(failure(() => build(elementAccessor)), 'invalid-descriptor');
    const limitsAccessor = registryInput() as unknown as Record<string, unknown>;
    Object.defineProperty(limitsAccessor, 'limits', {
      enumerable: true,
      get: () => {
        invoked = true;
        return {};
      }
    });
    expectOnly(failure(() => createPluginRegistry(limitsAccessor as unknown as PluginRegistryInput)), 'invalid-registry-input');
    expect(invoked).toBe(false);
  });

  it('rejects executable, symbolic, sparse and non-plain values explicitly', () => {
    const cases: [string, (input: MutableInput) => void, PluginIssueCode, string][] = [
      ['plugin entry point', (input) => { Object.assign(descriptorOf(input, 'stack-alpha'), { entry: './plugins/evil.js' }); }, 'invalid-descriptor', 'unknown field(s): entry'],
      ['function value', (input) => { Object.assign(descriptorOf(input, 'stack-alpha').artifacts[0], { render: () => 'code' }); }, 'invalid-descriptor', 'function values are not accepted'],
      ['symbol key', (input) => { Object.assign(descriptorOf(input, 'stack-alpha'), { [Symbol('hidden')]: true }); }, 'invalid-descriptor', 'symbol-keyed properties'],
      ['class instance', (input) => { Object.assign(input.selectionSpace, { workloads: new Map() }); }, 'invalid-registry-input', 'values must be plain objects'],
      ['array subclass', (input) => { class Listing extends Array<string> {} descriptorOf(input, 'stack-beta').sharedAssets = Listing.from(['shared-frontend-lock']); }, 'invalid-descriptor', 'arrays must be plain arrays'],
      ['extra array property', (input) => { Object.assign(descriptorOf(input, 'stack-beta').sharedAssets, { extra: true }); }, 'invalid-descriptor', 'holes or extra properties'],
      ['array hole', (input) => {
        const holes = ['shared-frontend-lock', 'unused'];
        delete (holes as unknown as Record<string, unknown>)['0'];
        Object.assign(holes, { extra: true });
        descriptorOf(input, 'stack-beta').sharedAssets = holes;
      }, 'invalid-descriptor', 'array entries must be enumerable data properties'],
      ['non-enumerable field', (input) => { Object.defineProperty(descriptorOf(input, 'stack-alpha'), 'hidden', { value: 1, enumerable: false }); }, 'invalid-descriptor', 'object fields must be enumerable data properties'],
      ['non-finite number', (input) => { descriptorOf(input, 'stack-alpha').contentVersion = Number.NaN; }, 'invalid-descriptor', 'numbers must be finite'],
      ['undefined value', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = undefined; }, 'invalid-descriptor', 'undefined values are not accepted'],
      ['non-byte view', (input) => { input.assets[0].bytes = new Int16Array(2) as unknown as Uint8Array; }, 'invalid-registry-input', 'packaged asset bytes must be a Uint8Array'],
      ['bytes outside assets', (input) => { Object.assign(input.selectionSpace, { environments: new Uint8Array(1) }); }, 'invalid-registry-input', 'binary data is accepted only as packaged asset bytes']
    ];
    for (const [label, mutate, code, detail] of cases) {
      const error = registryFailure(mutate, false);
      expect(codesOf(error), label).toContain(code);
      expect(error.issues.some((issue) => issue.detail.includes(detail)), label).toBe(true);
    }
  });

  it('rejects cyclic input but accepts shared acyclic references', () => {
    const cyclic = registryFailure((input) => {
      const condition: Record<string, unknown> = { workload: ['wl-plain'] };
      condition.self = condition;
      descriptorOf(input, 'stack-beta').supports = [condition as never];
    }, false);
    expect(codesOf(cyclic)).toContain('invalid-descriptor');
    expect(cyclic.issues.some((issue) => issue.detail === 'cyclic references are not accepted')).toBe(true);
    const shared = registryInput();
    const alternative = { workload: ['wl-plain'] };
    descriptorOf(shared, 'stack-beta').supports = [alternative];
    descriptorOf(shared, 'stack-beta').artifacts[1].when = alternative;
    expect(() => build(refreshRelease(shared))).not.toThrow();
  });

  it('fails closed with only the exceeded bound at every input and work limit', () => {
    const withRecipes = (input: MutableInput): void => {
      input.operations[1].recipes.push({ id: 'recipe-extra', version: 1 });
      descriptorOf(input, 'stack-alpha').recipes.push({ operation: 'op-repair', id: 'recipe-extra', version: 1 });
    };
    const cases: [keyof typeof pluginRegistryLimits, number, (input: MutableInput) => void][] = [
      ['maxNodes', 10, () => undefined],
      ['maxDepth', 3, () => undefined],
      ['maxStringLength', 5, () => undefined],
      ['maxAssetBytes', 4, () => undefined],
      ['maxTotalAssetBytes', 40, () => undefined],
      ['maxDescriptors', 3, () => undefined],
      ['maxArtifactsPerOwner', 4, () => undefined],
      ['maxArtifacts', 20, () => undefined],
      ['maxAssetsPerOwner', 1, (input) => { descriptorOf(input, 'stack-alpha').assets.push({ id: 'alpha-extra', pathParts: ['assets', 'plugins', 'stack-alpha', 'extra.txt'] }); }],
      ['maxChecksPerPlugin', 1, (input) => { descriptorOf(input, 'stack-alpha').checks.push({ id: 'alpha-second', version: 1, operation: 'op-doctor', effects: [] }); }],
      ['maxRecipesPerPlugin', 1, withRecipes],
      ['maxSupportAlternatives', 1, () => undefined],
      ['maxConditionValues', 1, () => undefined],
      ['maxPathParts', 2, () => undefined],
      ['maxSelectionContexts', 100, () => undefined],
      ['maxConflictPairs', 3, () => undefined],
      ['maxSatisfiabilityWork', 1000, () => undefined]
    ];
    for (const [limit, bound, mutate] of cases) {
      const input = registryInput();
      mutate(input);
      Object.assign(input, { limits: { [limit]: bound } });
      const error = failure(() => build(input));
      expect(error.issues, limit).toEqual([{
        code: 'validation-limit-exceeded',
        subject: `limit:${limit}`,
        detail: `input exceeds the ${limit} bound of ${bound}; validation stopped without a partial result`
      }]);
    }
  });

  it('accepts only lowered limits and rejects non-object registry input', () => {
    for (const limits of [
      { maxNodes: pluginRegistryLimits.maxNodes + 1 },
      { maxNodes: 0 },
      { maxNodes: 1.5 },
      { unknownBound: 1 },
      { maxNodes: () => 1 }
    ]) {
      const input = registryInput();
      Object.assign(input, { limits });
      expectOnly(failure(() => build(input)), 'invalid-registry-input');
    }
    for (const value of [null, [], 'registry', 7]) {
      expectOnly(failure(() => createPluginRegistry(value as unknown as PluginRegistryInput)), 'invalid-registry-input', 'input');
    }
    const lowered = registryInput();
    Object.assign(lowered, { limits: { maxIdLength: 32 } });
    expect(build(lowered).inventory).toHaveLength(7);
    const unknownRoot = registryFailure((input) => { Object.assign(input, { plugins: [] }); }, false);
    expect(unknownRoot.issues[0].detail).toBe('unknown field(s): plugins');
    const missingRoot = registryFailure((input) => { delete (input as Partial<MutableInput>).release; }, false);
    expect(missingRoot.issues[0].detail).toBe('missing field(s): release');
  });
});

describe('bundled plugin registry: identities and versions', () => {
  it('rejects duplicate plugin ids within and across categories', () => {
    const within = registryFailure((input) => { input.descriptors.push(structuredClone(descriptorOf(input, 'stack-beta'))); }, false);
    expect(codesOf(within)).toEqual(['duplicate-plugin-id']);
    expect(within.issues[0]).toMatchObject({ subject: 'plugin-id:stack-beta' });
    const across = registryFailure((input) => {
      input.descriptors.push({ ...structuredClone(descriptorOf(input, 'cloud-gamma')), category: 'agent' });
    }, false);
    expect(codesOf(across)).toEqual(['duplicate-plugin-id', 'missing-category']);
    expect(across.issues.map((issue) => issue.subject)).toEqual(['plugin-id:cloud-gamma', 'category:cloud']);
  });

  it('rejects unknown categories, invalid ids and incompatible or invalid versions', () => {
    const cases: [string, (input: MutableInput) => void, PluginIssueCode][] = [
      ['unknown category', (input) => { Object.assign(descriptorOf(input, 'flow-epsilon'), { category: 'manual' }); }, 'unknown-category'],
      ['uppercase id', (input) => { descriptorOf(input, 'flow-epsilon').id = 'Flow-Epsilon'; }, 'invalid-plugin-id'],
      ['path-like id', (input) => { descriptorOf(input, 'flow-epsilon').id = './plugins/evil'; }, 'invalid-plugin-id'],
      ['overlong id', (input) => { descriptorOf(input, 'flow-epsilon').id = `f${'x'.repeat(64)}`; }, 'invalid-plugin-id'],
      ['future api', (input) => { descriptorOf(input, 'flow-epsilon').apiVersion = 2; }, 'incompatible-api-version'],
      ['zero api', (input) => { descriptorOf(input, 'flow-epsilon').apiVersion = 0; }, 'incompatible-api-version'],
      ['zero content version', (input) => { descriptorOf(input, 'flow-epsilon').contentVersion = 0; }, 'invalid-content-version'],
      ['fractional content version', (input) => { descriptorOf(input, 'flow-epsilon').contentVersion = 1.5; }, 'invalid-content-version'],
      ['unqualified host', (input) => { descriptorOf(input, 'flow-epsilon').hostPlatforms = ['plan9/x64' as never]; }, 'unsupported-host-platform']
    ];
    for (const [label, mutate, code] of cases) {
      const error = registryFailure(mutate, false);
      expect(codesOf(error), label).toContain(code);
    }
  });

  it('rejects malformed descriptor fields', () => {
    const cases: [string, (input: MutableInput) => void][] = [
      ['non-object descriptor', (input) => { input.descriptors.push('stack-omega' as never); }],
      ['string api version', (input) => { Object.assign(descriptorOf(input, 'flow-epsilon'), { apiVersion: '1' }); }],
      ['empty hosts', (input) => { descriptorOf(input, 'flow-epsilon').hostPlatforms = []; }],
      ['duplicate hosts', (input) => { descriptorOf(input, 'flow-epsilon').hostPlatforms = ['linux/x64', 'linux/x64']; }],
      ['non-string shared references', (input) => { Object.assign(descriptorOf(input, 'flow-epsilon'), { sharedAssets: [1] }); }],
      ['empty supports', (input) => { descriptorOf(input, 'flow-epsilon').supports = []; }],
      ['non-array supports', (input) => { Object.assign(descriptorOf(input, 'flow-epsilon'), { supports: {} }); }],
      ['missing fields', (input) => { delete (descriptorOf(input, 'flow-epsilon') as Partial<MutableInput['descriptors'][number]>).checks; }]
    ];
    for (const [label, mutate] of cases) {
      expect(codesOf(registryFailure(mutate, false)), label).toEqual(['invalid-descriptor']);
    }
  });

  it('aggregates independent issues in a deterministic order', () => {
    const mutate = (input: MutableInput): void => {
      descriptorOf(input, 'stack-alpha').recipes[0].version = 9;
      descriptorOf(input, 'stack-alpha').checks[0].operation = 'op-repair';
      refreshRelease(input);
      input.descriptors.push(structuredClone(descriptorOf(input, 'flow-epsilon')));
      input.assets = input.assets.filter((entry) => entry.pathParts.join('/') !== 'assets/plugins/cloud-gamma/.terraform.lock.hcl');
    };
    const input = registryInput();
    mutate(input);
    const forward = failure(() => build(input));
    const backward = failure(() => build(reversedInput(input)));
    expect(codesOf(forward)).toEqual(['duplicate-plugin-id', 'missing-asset', 'unknown-recipe', 'unpermitted-effect']);
    expect(backward.issues).toEqual(forward.issues);
    expect(forward.message).toBe(backward.message);
    expect(forward.stage).toBe('registry');
    expect(forward.message.split('\n')[0]).toBe('Bundled plugin registry validation failed:');
    const sorted = [...forward.issues].sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0);
    expect(forward.issues).toEqual(sorted);
  });
});

describe('bundled plugin registry: conditions and exact satisfiability', () => {
  it('rejects malformed and unregistered condition values', () => {
    const cases: [string, (input: MutableInput) => void][] = [
      ['set dimension in supports', (input) => { descriptorOf(input, 'flow-epsilon').supports = [{ agent: ['agent-kappa'] } as never]; }],
      ['unknown dimension', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { plugin: ['x'] } as never; }],
      ['unregistered plugin value', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { stack: ['stack-zeta'] }; }],
      ['unregistered agent value', (input) => { input.core.artifacts[0].when = { agent: ['agent-zeta'] }; }],
      ['empty list', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { frontend: [] }; }],
      ['duplicate values', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { frontend: ['included', 'included'] }; }],
      ['non-string values', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { frontend: [1] } as never; }],
      ['variant outside listed workload', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { workload: ['wl-plain'], variant: ['var-a'] }; }],
      ['unknown workload', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { workload: ['wl-zeta'] }; }],
      ['unknown variant', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { variant: ['var-zeta'] }; }],
      ['unknown frontend', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { frontend: ['maybe'] } as never; }],
      ['unknown governance profile', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].when = { governanceProfile: ['gov-team'] }; }],
      ['unknown environment', (input) => { input.core.artifacts[0].when = { environment: ['env-zeta'] }; }],
      ['duplicate support alternatives', (input) => { descriptorOf(input, 'stack-beta').supports = [{ workload: ['wl-plain'] }, { workload: ['wl-plain'] }]; }]
    ];
    for (const [label, mutate] of cases) {
      expect(codesOf(registryFailure(mutate)), label).toEqual(['invalid-condition']);
    }
  });

  it('reports plugins and declarations that can never apply without inventing a witness', () => {
    const deadPlugin = registryFailure((input) => {
      descriptorOf(input, 'flow-epsilon').supports = [{ stack: ['stack-beta'] }];
      descriptorOf(input, 'flow-epsilon').hostPlatforms = ['darwin/arm64'];
      descriptorOf(input, 'stack-beta').hostPlatforms = ['linux/x64'];
    });
    expectOnly(deadPlugin, 'unsatisfiable-condition', 'plugin:workflow:flow-epsilon');
    const deadDeclarations = registryFailure((input) => {
      descriptorOf(input, 'stack-beta').artifacts[1].when = { workload: ['wl-variants'] };
      descriptorOf(input, 'stack-beta').checks.push({ id: 'beta-check', version: 1, operation: 'op-doctor', effects: [], when: { stack: ['stack-alpha'] } });
      descriptorOf(input, 'stack-beta').recipes.push({ operation: 'op-repair', id: 'recipe-layout', version: 1, when: { variant: ['var-a'] } });
    });
    expectOnly(deadDeclarations, 'unsatisfiable-condition');
    expect(deadDeclarations.issues.map((issue) => issue.subject)).toEqual([
      'artifact:plugin:stack:stack-beta:beta-module',
      'check:plugin:stack:stack-beta:beta-check',
      'recipe:plugin:stack:stack-beta:op-repair:recipe-layout@1'
    ]);
  });

  it('reports no supported selection when required categories share no host platform', () => {
    const error = registryFailure((input) => {
      for (const id of ['stack-alpha', 'stack-beta']) descriptorOf(input, id).hostPlatforms = ['darwin/arm64'];
      descriptorOf(input, 'cloud-gamma').hostPlatforms = ['linux/x64'];
    });
    expect(error.issues).toEqual([{
      code: 'no-supported-selection',
      subject: 'registry',
      detail: 'no stack, cloud, workflow and agent combination shares a supported host platform and matching support alternatives'
    }]);
  });

  it('treats different agents and environments as co-selectable, reporting a concrete witness', () => {
    const agents = registryFailure((input) => {
      input.core.artifacts.push(
        { logicalName: 'core-kappa-notes', category: 'documentation', pathParts: ['AGENTS.md'], lifecycle: 'seed', when: { agent: ['agent-kappa'] } },
        { logicalName: 'core-lambda-notes', category: 'documentation', pathParts: ['agents.md'], lifecycle: 'seed', when: { agent: ['agent-lambda'] } }
      );
    });
    expectOnly(agents, 'path-alias-collision', 'path:agents.md');
    expect(agents.issues[0].detail).toContain('agents=agent-kappa,agent-lambda');
    expect(agents.issues[0].detail).toMatch(/host=(darwin|linux|win32)\/(arm64|x64)$/);
    const environments = registryFailure((input) => {
      input.core.artifacts.push(
        { logicalName: 'core-env-note', category: 'documentation', pathParts: ['env-one.md'], lifecycle: 'seed', when: { environment: ['env-one'] } },
        { logicalName: 'core-env-note', category: 'documentation', pathParts: ['env-two.md'], lifecycle: 'seed', when: { environment: ['env-two'] } }
      );
    });
    expectOnly(environments, 'duplicate-logical-name', 'artifact:core-env-note');
    expect(environments.issues[0].detail).toContain('environments=env-one,env-two');
  });

  it('honours the supports and common host of every selected agent', () => {
    const agentDeclarations = (input: MutableInput): void => {
      input.core.artifacts.push(
        { logicalName: 'core-kappa-notes', category: 'documentation', pathParts: ['AGENTS.md'], lifecycle: 'seed', when: { agent: ['agent-kappa'] } },
        { logicalName: 'core-lambda-notes', category: 'documentation', pathParts: ['AGENTS.md'], lifecycle: 'seed', when: { agent: ['agent-lambda'] } }
      );
    };
    const disjointSupports = registryInput();
    agentDeclarations(disjointSupports);
    descriptorOf(disjointSupports, 'agent-kappa').supports = [{ workflow: ['flow-delta'] }];
    descriptorOf(disjointSupports, 'agent-lambda').supports = [{ workflow: ['flow-epsilon'] }];
    expect(() => build(refreshRelease(disjointSupports))).not.toThrow();
    const disjointHosts = registryInput();
    agentDeclarations(disjointHosts);
    descriptorOf(disjointHosts, 'agent-kappa').hostPlatforms = ['darwin/arm64'];
    descriptorOf(disjointHosts, 'agent-lambda').hostPlatforms = ['linux/x64'];
    expect(() => build(refreshRelease(disjointHosts))).not.toThrow();
    const sharedHost = registryInput();
    agentDeclarations(sharedHost);
    descriptorOf(sharedHost, 'agent-kappa').hostPlatforms = ['darwin/arm64', 'linux/x64'];
    descriptorOf(sharedHost, 'agent-lambda').hostPlatforms = ['linux/x64'];
    const collision = failure(() => build(refreshRelease(sharedHost)));
    expectOnly(collision, 'path-alias-collision', 'path:agents.md');
    expect(collision.issues[0].detail).toMatch(/agents=agent-kappa,agent-lambda environments=env-one host=linux\/x64$/);
  });

  it('combines owner implications with the supports of other owners', () => {
    const declarations = (input: MutableInput): void => {
      descriptorOf(input, 'agent-kappa').artifacts.push({
        logicalName: 'kappa-shared',
        category: 'documentation',
        pathParts: ['SHARED.md'],
        lifecycle: 'seed',
        when: { workflow: ['flow-delta'] }
      });
      input.core.artifacts.push({ logicalName: 'core-shared', category: 'documentation', pathParts: ['SHARED.md'], lifecycle: 'seed', when: { agent: ['agent-lambda'] } });
    };
    const collision = registryFailure(declarations);
    expectOnly(collision, 'path-alias-collision', 'path:shared.md');
    expect(collision.issues[0].detail).toContain('workflow=flow-delta');
    expect(collision.issues[0].detail).toContain('agents=agent-kappa,agent-lambda');
    const separated = registryInput();
    declarations(separated);
    descriptorOf(separated, 'agent-lambda').supports = [{ workflow: ['flow-epsilon'] }];
    expect(() => build(refreshRelease(separated))).not.toThrow();
  });

  it('accepts repeated logical names only under truly disjoint scalar alternatives', () => {
    const input = registryInput();
    input.core.artifacts.push(
      { logicalName: 'core-ui-note', category: 'documentation', pathParts: ['UI.md'], lifecycle: 'seed', when: { frontend: ['included'] } },
      { logicalName: 'core-ui-note', category: 'documentation', pathParts: ['NO-UI.md'], lifecycle: 'seed', when: { frontend: ['omitted'] } }
    );
    for (const id of ['stack-alpha', 'stack-beta']) {
      descriptorOf(input, id).artifacts.push({ logicalName: 'backend-dockerfile', category: 'runtime', pathParts: ['backend', 'Dockerfile'], lifecycle: 'project', provisioningGroup: 'base' });
    }
    const registry = build(refreshRelease(input));
    expect(registry.inventory[0].artifacts.filter((artifact) => artifact.logicalName === 'pattern-route')).toHaveLength(2);
    expect(registry.inventory[3].artifacts.filter((artifact) => artifact.logicalName === 'delta-stack-seed')).toHaveLength(2);
    const overlapping = registryFailure((entry) => {
      entry.core.artifacts.push(
        { logicalName: 'core-ui-note', category: 'documentation', pathParts: ['UI.md'], lifecycle: 'seed', when: { frontend: ['included'] } },
        { logicalName: 'core-ui-note', category: 'documentation', pathParts: ['UI-2.md'], lifecycle: 'seed', when: { governanceProfile: ['gov-on'] } }
      );
    });
    expectOnly(overlapping, 'duplicate-logical-name', 'artifact:core-ui-note');
  });

  it('rejects case aliases and file-versus-directory prefixes before rendering', () => {
    const alias = registryFailure((input) => {
      input.core.artifacts.push({ logicalName: 'core-readme-lower', category: 'documentation', pathParts: ['readme.md'], lifecycle: 'seed' });
    });
    expectOnly(alias, 'path-alias-collision', 'path:readme.md');
    const prefix = registryFailure((input) => {
      input.core.artifacts.push({ logicalName: 'core-backend-file', category: 'documentation', pathParts: ['Backend'], lifecycle: 'seed' });
    });
    expectOnly(prefix, 'path-prefix-collision', 'path:backend');
    expect(prefix.issues.every((issue) => issue.detail.includes('use one path as both a file and a directory'))).toBe(true);
  });
});

describe('bundled plugin registry: artifact declarations', () => {
  it('rejects non-portable or inconsistent artifact identities', () => {
    const artifact = (input: MutableInput): MutableInput['descriptors'][number]['artifacts'][number] =>
      descriptorOf(input, 'stack-alpha').artifacts[0];
    const cases: [string, (input: MutableInput) => void][] = [
      ['logical name', (input) => { artifact(input).logicalName = 'Backend_Main'; }],
      ['category', (input) => { artifact(input).category = 'Backend'; }],
      ['traversal', (input) => { artifact(input).pathParts = ['..', 'main.py']; }],
      ['embedded separator', (input) => { artifact(input).pathParts = ['backend/main.py']; }],
      ['drive prefix', (input) => { artifact(input).pathParts = ['C:', 'main.py']; }],
      ['reserved name', (input) => { artifact(input).pathParts = ['backend', 'con']; }],
      ['trailing dot', (input) => { artifact(input).pathParts = ['backend', 'main.']; }],
      ['non-ASCII part', (input) => { artifact(input).pathParts = ['backend', 'caf\u00e9.py']; }],
      ['empty path', (input) => { artifact(input).pathParts = []; }],
      ['non-string path', (input) => { artifact(input).pathParts = [1] as never; }],
      ['unknown lifecycle', (input) => { artifact(input).lifecycle = 'generated' as never; }],
      ['plugin manifest', (input) => { Object.assign(artifact(input), { lifecycle: 'manifest', provisioningGroup: undefined }); delete artifact(input).provisioningGroup; }],
      ['plugin desired state', (input) => { artifact(input).lifecycle = 'desired-state'; delete artifact(input).provisioningGroup; }],
      ['project without group', (input) => { delete artifact(input).provisioningGroup; }],
      ['non-project with group', (input) => { artifact(input).lifecycle = 'seed'; }],
      ['unknown group', (input) => { artifact(input).provisioningGroup = 'environment:env-zeta' as never; }],
      ['inexact environment condition', (input) => {
        Object.assign(artifact(input), { provisioningGroup: 'environment:env-one', when: { environment: ['env-one', 'env-two'] } });
      }],
      ['missing environment condition', (input) => { Object.assign(artifact(input), { provisioningGroup: 'environment:env-one' }); }],
      ['unknown field', (input) => { Object.assign(artifact(input), { owner: 'stack-alpha' }); }]
    ];
    for (const [label, mutate] of cases) {
      expect(codesOf(registryFailure(mutate, false)), label).toEqual(['invalid-artifact']);
    }
    const invalidCondition = registryFailure((input) => {
      Object.assign(artifact(input), { provisioningGroup: 'environment:env-one', when: { environment: [] } });
    }, false);
    expect(codesOf(invalidCondition)).toEqual(['invalid-condition']);
  });

  it('binds managed-core declarations to the exact core inventory and never reuses retired names', () => {
    const cases: [string, (input: MutableInput) => void, PluginIssueCode][] = [
      ['unregistered managed-core', (input) => {
        descriptorOf(input, 'agent-lambda').artifacts.push({ logicalName: 'agent-lambda-skill', category: 'governance', pathParts: ['.lambda', 'skill.md'], lifecycle: 'managed-core' });
      }, 'unregistered-managed-core'],
      ['moved managed-core', (input) => { descriptorOf(input, 'agent-kappa').artifacts[1].pathParts = ['.kappa', 'skills', 'moved.md']; }, 'unregistered-managed-core'],
      ['undeclared inventory identity', (input) => { descriptorOf(input, 'agent-kappa').artifacts.pop(); }, 'unregistered-managed-core'],
      ['managed-core name with project lifecycle', (input) => {
        Object.assign(descriptorOf(input, 'agent-kappa').artifacts[1], { lifecycle: 'project', provisioningGroup: 'base' });
      }, 'unregistered-managed-core'],
      ['retired name', (input) => { descriptorOf(input, 'stack-alpha').artifacts[0].logicalName = 'retired-thing'; }, 'retired-logical-name'],
      ['retired inventory identity', (input) => { input.core.retiredLogicalNames.push('agent-kappa-skill'); }, 'retired-logical-name']
    ];
    for (const [label, mutate, code] of cases) {
      expect(codesOf(registryFailure(mutate)), label).toContain(code);
    }
  });

  it('rejects malformed core declarations', () => {
    const cases: [string, (input: MutableInput) => void][] = [
      ['duplicate managed-core entry', (input) => { input.core.managedCore.push(structuredClone(input.core.managedCore[0])); }],
      ['invalid managed-core name', (input) => { input.core.managedCore[0].logicalName = 'Bad Name'; }],
      ['invalid managed-core path', (input) => { input.core.managedCore[0].pathParts = ['..']; }],
      ['duplicate retired name', (input) => { input.core.retiredLogicalNames.push('retired-thing'); }],
      ['invalid retired name', (input) => { input.core.retiredLogicalNames.push('Retired Thing'); }],
      ['non-object core', (input) => { Object.assign(input, { core: [] }); }],
      ['invalid core artifact', (input) => { input.core.artifacts[0].pathParts = ['..']; }]
    ];
    for (const [label, mutate] of cases) {
      expect(codesOf(registryFailure(mutate, false)), label).toEqual([label === 'invalid core artifact' ? 'invalid-artifact' : 'invalid-registry-input']);
    }
  });
});

describe('bundled plugin registry: assets and release inventory', () => {
  it('requires explicit portable asset identities with one canonical location each', () => {
    expect(codesOf(registryFailure((input) => {
      descriptorOf(input, 'stack-alpha').assets[0].pathParts = ['locks', 'stack-alpha', 'uv.lock'];
    }, false))).toEqual(['invalid-asset']);
    expect(codesOf(registryFailure((input) => { descriptorOf(input, 'stack-alpha').assets[0].pathParts = ['assets']; }, false))).toEqual(['invalid-asset']);
    expect(codesOf(registryFailure((input) => { descriptorOf(input, 'stack-alpha').assets[0].id = 'Alpha Lock'; }, false))).toEqual(['invalid-asset']);
    const duplicate = registryFailure((input) => {
      descriptorOf(input, 'stack-alpha').assets.push({ id: 'alpha-lock', pathParts: ['assets', 'plugins', 'stack-alpha', 'second.lock'] });
      input.assets.push({ pathParts: ['assets', 'plugins', 'stack-alpha', 'second.lock'], bytes: bytesOf('second\n') });
    }, false);
    expect(codesOf(duplicate)).toContain('duplicate-asset-id');
    expect(duplicate.issues.map((issue) => issue.subject)).toContain('asset:plugin:stack:stack-alpha:alpha-lock');
  });

  it('rejects conflicting ownership of a location instead of inferring it from content', () => {
    const cases: [string, (input: MutableInput) => void, string, PluginIssueCode[]][] = [
      ['plugin asset at a shared location', (input) => {
        descriptorOf(input, 'stack-alpha').assets.push({ id: 'alpha-frontend-lock', pathParts: ['assets', 'shared', 'frontend', 'package-lock.json'] });
      }, 'asset-path:assets/shared/frontend/package-lock.json', ['asset-location-conflict']],
      ['case alias of another location', (input) => {
        descriptorOf(input, 'stack-beta').assets.push({ id: 'beta-alias', pathParts: ['assets', 'plugins', 'stack-alpha', 'UV.LOCK'] });
      }, 'asset-path:assets/plugins/stack-alpha/uv.lock', ['asset-location-conflict', 'missing-asset']],
      ['two plugins claiming one location', (input) => {
        descriptorOf(input, 'cloud-gamma').assets.push({ id: 'gamma-copy', pathParts: ['assets', 'plugins', 'stack-beta', 'go.mod'] });
      }, 'asset-path:assets/plugins/stack-beta/go.mod', ['asset-location-conflict']],
      ['file used as a directory', (input) => {
        descriptorOf(input, 'cloud-gamma').assets.push({ id: 'gamma-nested', pathParts: ['assets', 'plugins', 'stack-beta', 'go.mod', 'nested.txt'] });
        input.assets.push({ pathParts: ['assets', 'plugins', 'stack-beta', 'go.mod', 'nested.txt'], bytes: bytesOf('nested\n') });
      }, 'asset-path:assets/plugins/stack-beta/go.mod', ['asset-location-conflict']]
    ];
    for (const [label, mutate, subject, codes] of cases) {
      const error = registryFailure(mutate);
      expect(codesOf(error), label).toEqual(codes);
      expect(error.issues.map((issue) => issue.subject), label).toContain(subject);
    }
  });

  it('requires explicit, distinct references to existing core shared assets', () => {
    const unknown = registryFailure((input) => { descriptorOf(input, 'stack-alpha').sharedAssets = ['shared-missing']; });
    expectOnly(unknown, 'unknown-shared-asset', 'plugin:stack:stack-alpha');
    const repeated = registryFailure((input) => { descriptorOf(input, 'stack-beta').sharedAssets = ['shared-frontend-lock', 'shared-frontend-lock']; });
    expectOnly(repeated, 'unknown-shared-asset', 'plugin:stack:stack-beta');
    expect(repeated.issues[0].detail).toContain('referenced more than once');
  });

  it('requires exactly the declared bytes and exact round-trippable UTF-8', () => {
    expectOnly(registryFailure((input) => {
      input.assets = input.assets.filter((entry) => !entry.pathParts.includes('stack-alpha'));
    }), 'missing-asset', 'asset:plugin:stack:stack-alpha:alpha-lock');
    expectOnly(registryFailure((input) => {
      input.assets.push({ pathParts: ['assets', 'plugins', 'stack-alpha', 'extra.txt'], bytes: bytesOf('extra\n') });
    }), 'undeclared-asset', 'asset-path:assets/plugins/stack-alpha/extra.txt');
    expect(codesOf(registryFailure((input) => {
      bytesEntryOf(input, 'assets/plugins/stack-alpha/uv.lock').pathParts = ['assets', 'plugins', 'stack-alpha', 'UV.lock'];
    }))).toEqual(['missing-asset', 'undeclared-asset']);
    for (const bytes of [new Uint8Array([0xff, 0xfe]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xc0, 0xaf])]) {
      expectOnly(registryFailure((input) => {
        bytesEntryOf(input, 'assets/plugins/stack-alpha/uv.lock').bytes = bytes;
      }), 'invalid-asset-encoding', 'asset:plugin:stack:stack-alpha:alpha-lock');
    }
    expectOnly(registryFailure((input) => { input.assets.push(structuredClone(input.assets[0])); }, false), 'invalid-registry-input');
    expectOnly(registryFailure((input) => { Object.assign(input.assets[0], { bytes: 'text' }); }, false), 'invalid-registry-input');
    expectOnly(registryFailure((input) => { input.assets[0].pathParts = ['elsewhere', 'file.txt']; }, false), 'invalid-registry-input');
  });

  it('verifies the release inventory exactly without trusting recorded digests', () => {
    const stale = (mutate: (input: MutableInput) => void): PluginRegistryError => registryFailure(mutate, false);
    expectOnly(stale((input) => { input.release.plugins = input.release.plugins.filter((record) => record.id !== 'cloud-gamma'); }),
      'missing-release-record', 'release:plugin:cloud:cloud-gamma');
    expectOnly(stale((input) => { input.release.plugins.push({ ...structuredClone(input.release.plugins[0]), id: 'stack-omega' }); }),
      'unexpected-release-record', 'release:plugin:stack:stack-omega');
    expectOnly(stale((input) => { input.release.plugins[1].category = 'cloud'; }), 'release-record-mismatch', 'release:plugin:stack:stack-beta');
    expectOnly(stale((input) => { input.release.plugins[1].apiVersion = 2; }), 'release-record-mismatch');
    expectOnly(stale((input) => { input.release.plugins[1].contentVersion = 2; }), 'release-record-mismatch');
    expectOnly(stale((input) => { input.release.plugins[0].assets = []; }), 'release-record-mismatch');
    expectOnly(stale((input) => {
      input.release.plugins[0].assets.push({ id: 'alpha-extra', pathParts: ['assets', 'plugins', 'stack-alpha', 'extra.lock'], sha256: sha256Of(bytesOf('x')) });
    }), 'release-record-mismatch');
    expectOnly(stale((input) => { input.release.plugins[0].assets[0].pathParts = ['assets', 'plugins', 'moved', 'uv.lock']; }),
      'release-record-mismatch', 'release-asset:plugin:stack:stack-alpha:alpha-lock');
    expectOnly(stale((input) => { input.release.plugins[0].assets[0].sha256 = sha256Of(bytesOf('other')); }),
      'digest-mismatch', 'release-asset:plugin:stack:stack-alpha:alpha-lock');
    expectOnly(stale((input) => { descriptorOf(input, 'stack-alpha').artifacts[0].category = 'runtime'; }),
      'digest-mismatch', 'release:plugin:stack:stack-alpha');
    expectOnly(stale((input) => { bytesEntryOf(input, 'assets/plugins/stack-alpha/uv.lock').bytes = bytesOf('tampered\n'); }),
      'digest-mismatch');
    expectOnly(stale((input) => { input.release.sharedAssets = []; }), 'missing-release-record', 'release-asset:core:shared-frontend-lock');
    expectOnly(stale((input) => {
      input.release.sharedAssets.push({ id: 'shared-extra', pathParts: ['assets', 'shared', 'extra.txt'], sha256: sha256Of(bytesOf('x')) });
    }), 'unexpected-release-record', 'release-asset:core:shared-extra');
    expectOnly(stale((input) => {
      const record = input.release.sharedAssets.find((entry) => entry.id === 'shared-frontend-lock');
      if (record !== undefined) record.sha256 = sha256Of(bytesOf('other'));
    }),
      'digest-mismatch', 'release-asset:core:shared-frontend-lock');
    const malformed: ((input: MutableInput) => void)[] = [
      (input) => { Object.assign(input.release, { schemaVersion: 2 }); },
      (input) => { Object.assign(input.release.plugins[0], { contentDigest: 'md5:abc' }); },
      (input) => { input.release.plugins.push(structuredClone(input.release.plugins[0])); },
      (input) => { Object.assign(input.release.plugins[0], { extra: true }); },
      (input) => { Object.assign(input.release.plugins[0].assets[0], { sha256: 'sha256:short' }); },
      (input) => { input.release.plugins[0].assets.push(structuredClone(input.release.plugins[0].assets[0])); },
      (input) => { input.release.plugins[0].assets[0].pathParts = ['..']; },
      (input) => { Object.assign(input.release, { plugins: {} }); }
    ];
    for (const mutate of malformed) expectOnly(stale(mutate), 'invalid-registry-input');
  });
});

describe('bundled plugin registry: checks and recipes', () => {
  it('binds checks and recipes to exact core operations without granting effects', () => {
    const cases: [string, (input: MutableInput) => void, PluginIssueCode][] = [
      ['unknown check operation', (input) => { descriptorOf(input, 'stack-alpha').checks[0].operation = 'op-deploy'; }, 'unknown-operation'],
      ['unknown recipe operation', (input) => { descriptorOf(input, 'stack-alpha').recipes[0].operation = 'op-deploy'; }, 'unknown-operation'],
      ['unpermitted effect', (input) => { descriptorOf(input, 'stack-alpha').checks[0].effects = ['project-read', 'network']; }, 'unpermitted-effect'],
      ['unknown recipe id', (input) => { descriptorOf(input, 'stack-alpha').recipes[0].id = 'recipe-other'; }, 'unknown-recipe'],
      ['unknown recipe version', (input) => { descriptorOf(input, 'stack-alpha').recipes[0].version = 2; }, 'unknown-recipe'],
      ['duplicate check id', (input) => { descriptorOf(input, 'stack-alpha').checks.push({ ...structuredClone(descriptorOf(input, 'stack-alpha').checks[0]), version: 2 }); }, 'invalid-check'],
      ['duplicate recipe reference', (input) => { descriptorOf(input, 'stack-alpha').recipes.push(structuredClone(descriptorOf(input, 'stack-alpha').recipes[0])); }, 'invalid-recipe']
    ];
    for (const [label, mutate, code] of cases) {
      expectOnly(registryFailure(mutate), code);
      expect(label).toBeTruthy();
    }
  });

  it('rejects malformed checks, recipes and operation catalogs', () => {
    const checkCases: ((input: MutableInput) => void)[] = [
      (input) => { descriptorOf(input, 'stack-alpha').checks[0].version = 0; },
      (input) => { descriptorOf(input, 'stack-alpha').checks[0].id = 'Alpha'; },
      (input) => { descriptorOf(input, 'stack-alpha').checks[0].effects = ['root' as never]; },
      (input) => { descriptorOf(input, 'stack-alpha').checks[0].effects = ['project-read', 'project-read']; },
      (input) => { Object.assign(descriptorOf(input, 'stack-alpha').checks[0], { command: 'rm -rf /' }); }
    ];
    for (const mutate of checkCases) expect(codesOf(registryFailure(mutate, false))).toEqual(['invalid-check']);
    const recipeCases: ((input: MutableInput) => void)[] = [
      (input) => { descriptorOf(input, 'stack-alpha').recipes[0].version = 1.5; },
      (input) => { descriptorOf(input, 'stack-alpha').recipes[0].operation = 'Op Repair'; },
      (input) => { Object.assign(descriptorOf(input, 'stack-alpha').recipes[0], { script: './fix.sh' }); }
    ];
    for (const mutate of recipeCases) expect(codesOf(registryFailure(mutate, false))).toEqual(['invalid-recipe']);
    const catalogCases: ((input: MutableInput) => void)[] = [
      (input) => { input.operations.push(structuredClone(input.operations[0])); },
      (input) => { input.operations[0].permittedCheckEffects = ['sudo' as never]; },
      (input) => { input.operations[1].recipes.push({ id: 'recipe-layout', version: 1 }); },
      (input) => { input.operations[1].recipes[0].version = 0; },
      (input) => { Object.assign(input.operations[1].recipes[0], { extra: true }); },
      (input) => { Object.assign(input.operations[0], { extra: true }); },
      (input) => { Object.assign(input.operations[0], { recipes: {} }); },
      (input) => { input.operations[0].id = 'Op'; },
      (input) => { Object.assign(input, { operations: {} }); }
    ];
    for (const mutate of catalogCases) expectOnly(registryFailure(mutate, false), 'invalid-registry-input');
  });

  it('rejects malformed selection spaces', () => {
    const cases: ((input: MutableInput) => void)[] = [
      (input) => { input.selectionSpace.workloads = []; },
      (input) => { input.selectionSpace.workloads.push(structuredClone(input.selectionSpace.workloads[0])); },
      (input) => { input.selectionSpace.workloads[1].variants = ['var-a']; },
      (input) => { input.selectionSpace.workloads[0].id = 'WL'; },
      (input) => { input.selectionSpace.workloads[0].variants = ['Var A']; },
      (input) => { Object.assign(input.selectionSpace.workloads[0], { extra: true }); },
      (input) => { input.selectionSpace.environments = []; },
      (input) => { input.selectionSpace.governanceProfiles = ['gov-on', 'gov-on']; },
      (input) => { Object.assign(input.selectionSpace, { workloads: {} }); },
      (input) => { Object.assign(input, { selectionSpace: [] }); }
    ];
    for (const mutate of cases) expectOnly(registryFailure(mutate, false), 'invalid-registry-input');
  });
});

describe('bundled plugin registry: selection resolution', () => {
  it('resolves exact owner-qualified declarations for a concrete selection', () => {
    const registry = build(registryInput());
    const resolution = resolve(registry);
    expect(resolution.selection).toEqual({
      workload: 'wl-variants',
      variant: 'var-a',
      stack: 'stack-alpha',
      cloud: 'cloud-gamma',
      workflow: 'flow-delta',
      agents: ['agent-kappa', 'agent-lambda'],
      frontend: 'included',
      governanceProfile: 'gov-on',
      environments: ['env-one', 'env-two']
    });
    expect(resolution.plugins.map((plugin) => `${plugin.category}:${plugin.id}`)).toEqual([
      'stack:stack-alpha',
      'cloud:cloud-gamma',
      'workflow:flow-delta',
      'agent:agent-kappa',
      'agent:agent-lambda'
    ]);
    expect(resolution.artifacts.map((artifact) => `${artifact.logicalName}@${artifact.pathParts.join('/')}`)).toEqual([
      'agent-kappa-skill@.kappa/skills/liftoff.md',
      'core-governance-policy@.liftoff/governance/policy.md',
      'backend-main@backend/main.py',
      'backend-observability@backend/obs/variant.py',
      'pattern-route@backend/routes/var_a.py',
      'core-frontend-app@frontend/app.ts',
      'core-env-one-main@infra/env-one/main.tf',
      'core-env-two-main@infra/env-two/main.tf',
      'cloud-main@infra/main.tf',
      'agent-kappa-instructions@KAPPA.md',
      'agent-lambda-instructions@LAMBDA.md',
      'core-config@liftoff.config.json',
      'core-manifest@liftoff.manifest.json',
      'core-readme@README.md',
      'delta-stack-seed@specs/delta/alpha.md',
      'delta-seed@specs/delta/seed.md'
    ]);
    expect(resolution.artifacts.find((artifact) => artifact.logicalName === 'core-readme')?.owner).toEqual({ kind: 'core' });
    expect(resolution.artifacts.find((artifact) => artifact.logicalName === 'cloud-main')?.owner).toEqual({ kind: 'plugin', category: 'cloud', id: 'cloud-gamma' });
    expect(resolution.checks).toEqual([{
      owner: { category: 'stack', id: 'stack-alpha' },
      id: 'alpha-project',
      version: 1,
      operation: 'op-doctor',
      effects: ['local-tool', 'project-read']
    }]);
    expect(resolution.recipes).toEqual([{ owner: { category: 'stack', id: 'stack-alpha' }, operation: 'op-repair', id: 'recipe-layout', version: 1 }]);
    expect(resolution.operations.map((operation) => operation.id)).toEqual(['op-doctor', 'op-repair']);
    expect(resolution.sharedAssets).toEqual([
      { id: 'shared-frontend-lock', sha256: sha256Of(bytesOf('{"lockfileVersion":3}\n')) },
      { id: 'shared-readme-template', sha256: sha256Of(bytesOf('# Template\n')) }
    ]);
    expect(isDeepFrozen(resolution)).toBe(true);
    const plain = resolve(registry, {
      workload: 'wl-plain',
      variant: undefined,
      stack: 'stack-beta',
      frontend: 'omitted',
      governanceProfile: 'gov-off',
      agents: ['agent-lambda'],
      environments: ['env-two']
    });
    expect(plain.selection).not.toHaveProperty('variant');
    expect(plain.artifacts.map((artifact) => artifact.logicalName)).toEqual([
      'beta-module',
      'backend-main',
      'core-env-two-main',
      'cloud-main',
      'agent-lambda-instructions',
      'core-config',
      'core-manifest',
      'core-readme',
      'delta-stack-seed',
      'delta-seed'
    ]);
    expect(plain.checks).toEqual([]);
    expect(plain.operations).toEqual([]);
  });

  it('keeps resolution identity independent of input order and host platform', () => {
    const registry = build(registryInput());
    const first = resolve(registry, {}, { platform: 'darwin/arm64' });
    const second = resolve(registry, { agents: ['agent-kappa', 'agent-lambda'], environments: ['env-one', 'env-two'] }, { platform: 'win32/x64' });
    expect(second.digest).toBe(first.digest);
    expect([first.hostPlatform, second.hostPlatform]).toEqual(['darwin/arm64', 'win32/x64']);
    expect(resolve(registry, { frontend: 'omitted' }).digest).not.toBe(first.digest);
  });

  it('rejects unregistered, mis-categorized, incomplete or unsupported selections before rendering', () => {
    const input = registryInput();
    descriptorOf(input, 'stack-beta').hostPlatforms = ['linux/x64'];
    const registry = build(refreshRelease(input));
    const cases: [string, Partial<PluginSelection> | Record<string, unknown>, PluginIssueCode, { platform: string }?][] = [
      ['plugin path', { stack: './plugins/evil.js' }, 'unknown-plugin'],
      ['planned provider', { cloud: 'aws' }, 'unknown-plugin'],
      ['wrong category', { stack: 'cloud-gamma' }, 'wrong-category'],
      ['duplicate agents', { agents: ['agent-kappa', 'agent-kappa'] }, 'invalid-selection'],
      ['non-string agent', { agents: [7] }, 'invalid-selection'],
      ['unknown agent', { agents: ['agent-zeta'] }, 'unknown-plugin'],
      ['agent plugin path', { agents: ['./plugins/evil-agent.js'] }, 'unknown-plugin'],
      ['agent of another category', { agents: ['stack-alpha'] }, 'wrong-category'],
      ['non-string plugin', { workflow: 7 }, 'invalid-selection'],
      ['non-string workload', { workload: 7 }, 'invalid-selection'],
      ['non-list agents', { agents: 'agent-kappa' }, 'invalid-selection'],
      ['null agents', { agents: null }, 'invalid-selection'],
      ['missing variant', { variant: undefined }, 'invalid-selection'],
      ['variant on plain workload', { workload: 'wl-plain', stack: 'stack-beta' }, 'invalid-selection'],
      ['unknown workload', { workload: 'wl-zeta' }, 'invalid-selection'],
      ['unknown variant', { variant: 'var-zeta' }, 'invalid-selection'],
      ['unknown environment', { environments: ['env-zeta'] }, 'invalid-selection'],
      ['no environments', { environments: [] }, 'invalid-selection'],
      ['unknown frontend', { frontend: 'maybe' }, 'invalid-selection'],
      ['unknown governance profile', { governanceProfile: 'gov-team' }, 'invalid-selection'],
      ['unexpected field', { pluginPath: './plugins' }, 'invalid-selection'],
      ['unqualified host', {}, 'unsupported-host-platform', { platform: 'plan9/x64' }],
      ['plugin without the host', { workload: 'wl-plain', variant: undefined, stack: 'stack-beta' }, 'unsupported-host-platform', { platform: 'darwin/arm64' }],
      ['unsupported combination', { stack: 'stack-beta' }, 'unsupported-combination']
    ];
    for (const [label, overrides, code, on] of cases) {
      const selection = { ...selectionOf(), ...overrides } as Record<string, unknown>;
      if ('variant' in overrides && overrides.variant === undefined) delete selection.variant;
      const error = failure(() => registry.resolveSelection(selection as unknown as PluginSelection, on ?? host));
      expect(error.stage, label).toBe('selection');
      expect(codesOf(error), label).toEqual([code]);
    }
    const explicitUndefined = failure(() => registry.resolveSelection({ ...selectionOf(), variant: undefined } as unknown as PluginSelection, host));
    expect(explicitUndefined.issues.some((issue) => issue.detail === 'undefined values are not accepted')).toBe(true);
    expectOnly(failure(() => registry.resolveSelection('selection' as never, host)), 'invalid-selection');
    expectOnly(failure(() => registry.resolveSelection(selectionOf() as PluginSelection, { platform: 'linux/x64', extra: true } as never)), 'invalid-selection');
  });
});

describe('bundled plugin registry: agent-free selections', () => {
  const names = (resolution: PluginResolution): string[] => resolution.artifacts.map((artifact) => artifact.logicalName);

  it('resolves and verifies an explicit empty agent list without agent plugins, contributions or agent conditions', () => {
    const input = registryInput();
    input.core.artifacts.push({ logicalName: 'core-kappa-hint', category: 'documentation', pathParts: ['KAPPA-HINT.md'], lifecycle: 'seed', when: { agent: ['agent-kappa'] } });
    descriptorOf(input, 'stack-alpha').checks.push({ id: 'alpha-agent-lint', version: 1, operation: 'op-doctor', effects: ['project-read'], when: { agent: ['agent-lambda'] } });
    descriptorOf(input, 'stack-alpha').recipes.push({ operation: 'op-repair', id: 'recipe-cleanup', version: 2, when: { agent: ['agent-kappa'] } });
    const registry = build(refreshRelease(input));
    const withAgents = resolve(registry);
    const agentFree = resolve(registry, { agents: [] });

    expect(agentFree.selection.agents).toEqual([]);
    expect(agentFree.plugins.map((plugin) => `${plugin.category}:${plugin.id}`)).toEqual([
      'stack:stack-alpha',
      'cloud:cloud-gamma',
      'workflow:flow-delta'
    ]);
    expect(agentFree.artifacts.map((artifact) => `${artifact.logicalName}@${artifact.pathParts.join('/')}`)).toEqual([
      'core-governance-policy@.liftoff/governance/policy.md',
      'backend-main@backend/main.py',
      'backend-observability@backend/obs/variant.py',
      'pattern-route@backend/routes/var_a.py',
      'core-frontend-app@frontend/app.ts',
      'core-env-one-main@infra/env-one/main.tf',
      'core-env-two-main@infra/env-two/main.tf',
      'cloud-main@infra/main.tf',
      'core-config@liftoff.config.json',
      'core-manifest@liftoff.manifest.json',
      'core-readme@README.md',
      'delta-stack-seed@specs/delta/alpha.md',
      'delta-seed@specs/delta/seed.md'
    ]);
    expect(agentFree.artifacts.some((artifact) => artifact.owner.kind === 'plugin' && artifact.owner.category === 'agent')).toBe(false);

    // Positive agent conditions on core and non-agent plugin declarations stay inactive.
    expect(names(withAgents)).toContain('core-kappa-hint');
    expect(withAgents.checks.map((check) => check.id)).toEqual(['alpha-agent-lint', 'alpha-project']);
    expect(agentFree.checks.map((check) => check.id)).toEqual(['alpha-project']);
    expect(withAgents.recipes.map((recipe) => `${recipe.id}@${recipe.version}`)).toEqual(['recipe-cleanup@2', 'recipe-layout@1']);
    expect(agentFree.recipes.map((recipe) => `${recipe.id}@${recipe.version}`)).toEqual(['recipe-layout@1']);
    const agentOnly = new Set(['agent-kappa-instructions', 'agent-kappa-skill', 'agent-lambda-instructions', 'core-kappa-hint']);
    expect(agentFree.artifacts).toEqual(withAgents.artifacts.filter((artifact) => !agentOnly.has(artifact.logicalName)));
    expect(agentFree.sharedAssets).toEqual(withAgents.sharedAssets);
    expect(agentFree.operations).toEqual(withAgents.operations);

    const { digest, hostPlatform, ...semantic } = agentFree;
    expect(hostPlatform).toBe('linux/x64');
    expect(digest).toBe(oracleDigest({ kind: 'liftoff-plugin-resolution', schemaVersion: 1, pluginApiVersion: 1, ...semantic }));
    expect(resolve(registry, { agents: [] }, { platform: 'win32/x64' }).digest).toBe(digest);
    expect(digest).not.toBe(withAgents.digest);
    expect(isDeepFrozen(agentFree)).toBe(true);
    expect(() => registry.verifyComposedArtifacts(agentFree, rendered(agentFree))).not.toThrow();
  });

  it('refuses agent contributions forged into an agent-free composition', () => {
    const registry = build(registryInput());
    const withAgents = resolve(registry);
    const agentFree = resolve(registry, { agents: [] });
    const kappa = rendered(withAgents).find((artifact) => artifact.logicalName === 'agent-kappa-instructions') as GeneratedArtifact;
    expectOnly(failure(() => registry.verifyComposedArtifacts(agentFree, [...rendered(agentFree), kappa])),
      'undeclared-artifact', 'artifact:agent-kappa-instructions');
    const relabelled = { ...withAgents, selection: { ...withAgents.selection, agents: [] } } as PluginResolution;
    const relabelling = failure(() => registry.verifyComposedArtifacts(relabelled, rendered(withAgents)));
    expectOnly(relabelling, 'resolution-mismatch', 'resolution');
    expect(relabelling.issues[0].detail).toContain('in: artifacts, digest, plugins');
    const claimed = { ...agentFree, plugins: withAgents.plugins } as PluginResolution;
    const claiming = failure(() => registry.verifyComposedArtifacts(claimed, rendered(agentFree)));
    expectOnly(claiming, 'resolution-mismatch', 'resolution');
    expect(claiming.issues[0].detail).toContain('in: plugins');
  });

  it('keeps agent host/support validation and non-empty environments', () => {
    const input = registryInput();
    descriptorOf(input, 'agent-lambda').hostPlatforms = ['linux/x64'];
    descriptorOf(input, 'agent-kappa').supports = [{ workload: ['wl-variants'] }];
    const registry = build(refreshRelease(input));
    const plain = { workload: 'wl-plain', variant: undefined, stack: 'stack-beta' };
    expectOnly(failure(() => resolve(registry, { agents: ['agent-lambda'] }, { platform: 'darwin/arm64' })),
      'unsupported-host-platform', 'plugin:agent:agent-lambda');
    expectOnly(failure(() => resolve(registry, { ...plain, agents: ['agent-kappa'] })),
      'unsupported-combination', 'plugin:agent:agent-kappa');
    expectOnly(failure(() => resolve(registry, { agents: [], environments: [] })), 'invalid-selection', 'selection');
    expect(resolve(registry, { ...plain, agents: [] }).plugins.map((plugin) => plugin.id)).toEqual(['stack-beta', 'cloud-gamma', 'flow-delta']);
    expect(resolve(registry, { agents: [] }, { platform: 'darwin/arm64' }).selection.agents).toEqual([]);
    const outside = failure(() => resolve(registry, { ...plain, agents: [] }, { platform: 'darwin/arm64' }));
    expect(outside.stage).toBe('selection');
    expectOnly(outside, 'unsupported-combination', 'selection');
    expect(outside.issues[0].detail).toMatch(/^no bundled agent plugin supports workload=wl-plain stack=stack-beta .* on host darwin\/arm64/);
  });

  it('accepts agent-free selections only inside release-validated combinations', () => {
    const input = registryInput();
    descriptorOf(input, 'agent-kappa').supports = [{ frontend: ['included'], governanceProfile: ['gov-on'] }];
    descriptorOf(input, 'agent-lambda').supports = [{ frontend: ['omitted'], governanceProfile: ['gov-off'] }];
    input.core.artifacts.push(
      { logicalName: 'core-included-note', category: 'documentation', pathParts: ['NOTE.md'], lifecycle: 'seed', when: { frontend: ['included'] } },
      { logicalName: 'core-gov-off-note', category: 'documentation', pathParts: ['note.md'], lifecycle: 'seed', when: { governanceProfile: ['gov-off'] } }
    );
    // The notes alias only for frontend=included with gov-off. No agent supports that combination, so
    // construction never analyzes it; resolving it without an agent would compose both notes.
    const registry = build(refreshRelease(input));
    const includedOn = resolve(registry, { agents: [], frontend: 'included', governanceProfile: 'gov-on' });
    expect(names(includedOn)).toContain('core-included-note');
    expect(names(includedOn)).not.toContain('core-gov-off-note');
    const omittedOff = resolve(registry, { agents: [], frontend: 'omitted', governanceProfile: 'gov-off' });
    expect(names(omittedOff)).toContain('core-gov-off-note');
    expect(names(omittedOff)).not.toContain('core-included-note');
    const outside = failure(() => resolve(registry, { agents: [], frontend: 'included', governanceProfile: 'gov-off' }));
    expectOnly(outside, 'unsupported-combination', 'selection');
    expect(outside.issues[0].detail).toContain('frontend=included governanceProfile=gov-off on host linux/x64');
    expectOnly(failure(() => resolve(registry, { agents: ['agent-kappa'], frontend: 'included', governanceProfile: 'gov-off' })),
      'unsupported-combination', 'plugin:agent:agent-kappa');
    const moved = { ...includedOn, selection: { ...includedOn.selection, governanceProfile: 'gov-off' } } as PluginResolution;
    const refused = failure(() => registry.verifyComposedArtifacts(moved, rendered(includedOn)));
    expectOnly(refused, 'resolution-mismatch', 'resolution');
    expect(refused.issues[0].detail).toContain('(unsupported-combination)');
  });

  it('leaves fresh project planning of an explicit empty agent list refused', () => {
    const catalog = createProjectCatalog({ frameworkVersions: { openspec: '1.0.0', 'spec-kit': '1.0.0' }, governancePolicyVersion: '1' });
    const plan = (agents: string[]) => buildProjectPlanWithCatalog(
      { projectName: 'Agent Free', projectType: 'standard', apiStack: 'node', cloud: 'azure', agents },
      { requireProjectName: true },
      catalog
    );
    expect(plan(['codex']).agents.map((agent) => agent.id)).toEqual(['codex']);
    let refusal: unknown;
    try {
      plan([]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PlanValidationError);
    expect((refusal as PlanValidationError).issues).toContain('At least one AI coding agent is required.');
  });
});

describe('bundled plugin registry: composition verification', () => {
  it('accepts exactly the recomputed declarations in any rendering order', () => {
    const registry = build(registryInput());
    const resolution = resolve(registry);
    const artifacts = rendered(resolution);
    artifacts[0] = { ...artifacts[0], content: 'x'.repeat(pluginRegistryLimits.maxStringLength * 4) };
    expect(() => registry.verifyComposedArtifacts(resolution, artifacts)).not.toThrow();
  });

  it('rejects undeclared, missing, mismatched, duplicated and aliased rendered artifacts', () => {
    const registry = build(registryInput());
    const resolution = resolve(registry);
    const verify = (mutate: (artifacts: GeneratedArtifact[]) => GeneratedArtifact[]): PluginRegistryError =>
      failure(() => registry.verifyComposedArtifacts(resolution, mutate(rendered(resolution))));
    expectOnly(verify((artifacts) => [...artifacts, { logicalName: 'forged', category: 'backend', pathParts: ['forged.py'], lifecycle: 'project', provisioningGroup: 'base', content: '' }]),
      'undeclared-artifact', 'artifact:forged');
    expectOnly(verify((artifacts) => artifacts.filter((artifact) => artifact.logicalName !== 'cloud-main')), 'missing-artifact', 'artifact:cloud-main');
    for (const field of ['category', 'pathParts', 'lifecycle', 'provisioningGroup'] as const) {
      const error = verify((artifacts) => artifacts.map((artifact) => {
        if (artifact.logicalName !== 'backend-main') return artifact;
        const changed = { ...artifact } as Record<string, unknown>;
        changed[field] = field === 'pathParts' ? ['backend', 'other.py'] : field === 'lifecycle' ? 'framework' : field === 'category' ? 'runtime' : 'frontend';
        return changed as unknown as GeneratedArtifact;
      }));
      expect(codesOf(error), field).toContain('artifact-identity-mismatch');
      expect(error.issues.find((issue) => issue.code === 'artifact-identity-mismatch')?.detail, field).toContain(field);
    }
    expectOnly(verify((artifacts) => [...artifacts, artifacts[0]]), 'duplicate-artifact');
    const aliased = verify((artifacts) => artifacts.map((artifact) =>
      artifact.logicalName === 'core-readme' ? { ...artifact, pathParts: ['KAPPA.MD'] } : artifact));
    expect(codesOf(aliased)).toEqual(['artifact-identity-mismatch', 'path-alias-collision']);
    expect(codesOf(verify(() => 'not-a-list' as never))).toEqual(['artifact-identity-mismatch']);
    expect(codesOf(verify((artifacts) => [...artifacts.slice(1), { ...artifacts[0], logicalName: 7 } as never]))).toContain('artifact-identity-mismatch');
    expect(codesOf(verify((artifacts) => [{ ...artifacts[0], owner: 'core' } as never, ...artifacts.slice(1)]))).toContain('artifact-identity-mismatch');
  });

  it('never trusts supplied resolution lists, even with the original digest', () => {
    const registry = build(registryInput());
    const resolution = resolve(registry);
    const forgedArtifact = { owner: { kind: 'core' }, logicalName: 'forged', category: 'backend', pathParts: ['forged.py'], lifecycle: 'project', provisioningGroup: 'base' };
    const forged = { ...resolution, artifacts: [...resolution.artifacts, forgedArtifact] } as unknown as PluginResolution;
    const forgedRender = [...rendered(resolution), { logicalName: 'forged', category: 'backend', pathParts: ['forged.py'], lifecycle: 'project', provisioningGroup: 'base', content: '' } as GeneratedArtifact];
    const listForgery = failure(() => registry.verifyComposedArtifacts(forged, forgedRender));
    expectOnly(listForgery, 'resolution-mismatch', 'resolution');
    expect(listForgery.issues[0].detail).toContain('in: artifacts');
    expectOnly(failure(() => registry.verifyComposedArtifacts(resolution, forgedRender)), 'undeclared-artifact');
    const forgedDigest = { ...resolution, digest: `sha256:${'0'.repeat(64)}` } as PluginResolution;
    expect(failure(() => registry.verifyComposedArtifacts(forgedDigest, rendered(resolution))).issues[0].detail).toContain('in: digest');
    const editedSelection = { ...resolution, selection: { ...resolution.selection, agents: ['agent-kappa'] } } as PluginResolution;
    expectOnly(failure(() => registry.verifyComposedArtifacts(editedSelection, rendered(resolution))), 'resolution-mismatch');
    const missingField: Record<string, unknown> = { ...resolution };
    delete missingField.plugins;
    expect(failure(() => registry.verifyComposedArtifacts(missingField as unknown as PluginResolution, rendered(resolution))).issues[0].detail).toContain('in: plugins');
    expectOnly(failure(() => registry.verifyComposedArtifacts({ ...resolution, approved: true } as never, rendered(resolution))), 'resolution-mismatch');
    expectOnly(failure(() => registry.verifyComposedArtifacts('resolution' as never, rendered(resolution))), 'resolution-mismatch');
    const unresolvable = { ...resolution, selection: { ...resolution.selection, stack: 'stack-zeta' } } as PluginResolution;
    expect(failure(() => registry.verifyComposedArtifacts(unresolvable, rendered(resolution))).issues[0].detail).toContain('(unknown-plugin)');
  });

  it('rejects resolutions produced by a registry with different selected semantics', () => {
    const original = build(registryInput());
    const resolution = resolve(original);
    const changedInput = registryInput();
    changedInput.core.artifacts[0].pathParts = ['READ-ME.md'];
    const changed = build(refreshRelease(changedInput));
    expect(changed.pluginSetDigest).toBe(original.pluginSetDigest);
    expect(changed.coreContributionDigest).not.toBe(original.coreContributionDigest);
    const error = failure(() => changed.verifyComposedArtifacts(resolution, rendered(resolution)));
    expectOnly(error, 'resolution-mismatch');
    expect(error.stage).toBe('composition');
    expect(error.issues[0].detail).toContain('artifacts');
    expect(error.issues[0].detail).toContain('digest');
  });

  it('applies the work bound to verification input as well', () => {
    const input = registryInput();
    Object.assign(input, { limits: { maxNodes: 2000 } });
    const registry = build(input);
    const resolution = resolve(registry);
    const oversized = Array.from({ length: 400 }, () => rendered(resolution)[0]);
    const error = failure(() => registry.verifyComposedArtifacts(resolution, oversized));
    expect(error.issues).toEqual([{
      code: 'validation-limit-exceeded',
      subject: 'limit:maxNodes',
      detail: 'input exceeds the maxNodes bound of 2000; validation stopped without a partial result'
    }]);
  });
});

describe('bundled plugin registry: remaining structural and resolution edges', () => {
  it('resolves agent-conditioned declarations and orders multiple checks and recipes canonically', () => {
    const input = registryInput();
    input.core.artifacts.push({ logicalName: 'core-lambda-hint', category: 'documentation', pathParts: ['LAMBDA-HINT.md'], lifecycle: 'seed', when: { agent: ['agent-lambda'] } });
    descriptorOf(input, 'stack-alpha').checks.push({ id: 'alpha-lint', version: 1, operation: 'op-doctor', effects: ['project-read'] });
    descriptorOf(input, 'cloud-gamma').checks.push({ id: 'gamma-auth', version: 1, operation: 'op-doctor', effects: ['local-tool'] });
    descriptorOf(input, 'stack-alpha').recipes.push({ operation: 'op-repair', id: 'recipe-cleanup', version: 2 });
    descriptorOf(input, 'cloud-gamma').recipes.push({ operation: 'op-repair', id: 'recipe-layout', version: 1 });
    const registry = build(refreshRelease(input));
    const withLambda = resolve(registry);
    expect(withLambda.artifacts.map((artifact) => artifact.logicalName)).toContain('core-lambda-hint');
    expect(withLambda.checks.map((check) => `${check.owner.id}:${check.id}`)).toEqual([
      'stack-alpha:alpha-lint',
      'stack-alpha:alpha-project',
      'cloud-gamma:gamma-auth'
    ]);
    expect(withLambda.recipes.map((recipe) => `${recipe.id}@${recipe.version}:${recipe.owner.id}`)).toEqual([
      'recipe-cleanup@2:stack-alpha',
      'recipe-layout@1:stack-alpha',
      'recipe-layout@1:cloud-gamma'
    ]);
    const withoutLambda = resolve(registry, { agents: ['agent-kappa'] });
    expect(withoutLambda.artifacts.map((artifact) => artifact.logicalName)).not.toContain('core-lambda-hint');
  });

  it('reports structural input problems at their exact location', () => {
    const registry = build(registryInput());
    const rootFunction = failure(() => registry.resolveSelection((() => 1) as never, host));
    expect(rootFunction.issues.map((issue) => issue.subject)).toContain('input');
    expectOnly(failure(() => registry.assetsFor({ kind: () => 'core' } as never)), 'invalid-selection');
    const resolution = resolve(registry);
    expectOnly(failure(() => registry.verifyComposedArtifacts({ ...resolution, digest: () => resolution.digest } as never, rendered(resolution))), 'resolution-mismatch');
    const functionContent = rendered(resolution).map((artifact, index) => index === 0 ? { ...artifact, content: () => '' } : artifact);
    expectOnly(failure(() => registry.verifyComposedArtifacts(resolution, functionContent as never)), 'artifact-identity-mismatch');
    const conditionValues = registryInput();
    conditionValues.core.artifacts.push({ logicalName: 'core-many', category: 'documentation', pathParts: ['MANY.md'], lifecycle: 'seed', when: { stack: ['a', 'b', 'c'] } });
    Object.assign(conditionValues, { limits: { maxConditionValues: 2 } });
    expect(failure(() => build(conditionValues)).issues).toEqual([{
      code: 'validation-limit-exceeded',
      subject: 'limit:maxConditionValues',
      detail: 'input exceeds the maxConditionValues bound of 2; validation stopped without a partial result'
    }]);
    const shapes: [string, (input: MutableInput) => void, PluginIssueCode][] = [
      ['non-string operation id', (input) => { Object.assign(input.operations[0], { id: 7 }); }, 'invalid-registry-input'],
      ['non-string logical name', (input) => { Object.assign(descriptorOf(input, 'stack-alpha').artifacts[0], { logicalName: 7 }); }, 'invalid-artifact'],
      ['non-object asset', (input) => { descriptorOf(input, 'stack-alpha').assets = ['asset' as never]; }, 'invalid-asset'],
      ['non-string asset id', (input) => { Object.assign(descriptorOf(input, 'stack-alpha').assets[0], { id: 7 }); }, 'invalid-asset'],
      ['non-string check id', (input) => { Object.assign(descriptorOf(input, 'stack-alpha').checks[0], { id: 7 }); }, 'invalid-check'],
      ['non-object managed-core entry', (input) => { input.core.managedCore.push('entry' as never); }, 'invalid-registry-input'],
      ['non-array retired names', (input) => { Object.assign(input.core, { retiredLogicalNames: 'retired-thing' }); }, 'invalid-registry-input'],
      ['non-array release assets', (input) => { Object.assign(input.release.plugins[0], { assets: {} }); }, 'invalid-registry-input'],
      ['non-array shared release assets', (input) => { Object.assign(input.release, { sharedAssets: {} }); }, 'invalid-registry-input'],
      ['non-object release', (input) => { Object.assign(input, { release: [] }); }, 'invalid-registry-input'],
      ['non-array bytes', (input) => { Object.assign(input, { assets: {} }); }, 'invalid-registry-input']
    ];
    for (const [label, mutate, code] of shapes) {
      expect(codesOf(registryFailure(mutate, false)), label).toEqual([code]);
    }
  });
});

function spyOn(target: object, key: PropertyKey, value: unknown, counter: { reads: number }): void {
  Object.defineProperty(target, key, {
    configurable: true,
    get() {
      counter.reads += 1;
      return value;
    }
  });
}

/** ES2024 resizable buffers; the repository TypeScript lib targets ES2022. */
const ResizableArrayBuffer = ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) =>
  ArrayBuffer & { resize(length: number): void };

function detachedBytes(): Uint8Array {
  const bytes = Uint8Array.of(1);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  return bytes;
}

function limitOnly(error: PluginRegistryError, limit: keyof typeof pluginRegistryLimits, bound: number): void {
  expect(error.issues).toEqual([{
    code: 'validation-limit-exceeded',
    subject: `limit:${limit}`,
    detail: `input exceeds the ${limit} bound of ${bound}; validation stopped without a partial result`
  }]);
}

/** Observation probe only: counts Proxy traps to prove where intake stopped walking. */
function trapCounter(target: object): { proxy: object; counter: { traps: number } } {
  const counter = { traps: 0 };
  const handler: ProxyHandler<object> = {};
  for (const trap of ['get', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'has', 'ownKeys'] as const) {
    (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
      counter.traps += 1;
      return (Reflect[trap] as (...values: unknown[]) => unknown)(...args);
    };
  }
  return { proxy: new Proxy(target, handler), counter };
}

function bytesIssue(detail: string, subject = 'assets[0].bytes'): { code: PluginIssueCode; subject: string; detail: string } {
  return { code: 'invalid-registry-input', subject, detail };
}

describe('bundled plugin registry: review regression - rendered content', () => {
  it('requires string content for every rendered artifact', () => {
    const registry = build(registryInput());
    const resolution = resolve(registry);
    const withContent = (content: unknown): GeneratedArtifact[] => rendered(resolution).map((artifact) =>
      artifact.logicalName === 'core-readme' ? { ...artifact, content } as unknown as GeneratedArtifact : artifact);
    for (const content of [null, 17, false, {}, []]) {
      const error = failure(() => registry.verifyComposedArtifacts(resolution, withContent(content)));
      expect(error.stage).toBe('composition');
      expect(error.issues, JSON.stringify(content)).toEqual([{
        code: 'artifact-identity-mismatch',
        subject: 'artifact:core-readme',
        detail: 'rendered artifact content must be a string'
      }]);
    }
    const index = rendered(resolution).findIndex((artifact) => artifact.logicalName === 'core-readme');
    const undefinedContent = failure(() => registry.verifyComposedArtifacts(resolution, withContent(undefined)));
    expect(undefinedContent.issues).toEqual([{
      code: 'artifact-identity-mismatch',
      subject: `[${index}].content`,
      detail: 'undefined values are not accepted'
    }]);
    const missing = rendered(resolution).map((artifact) => {
      if (artifact.logicalName !== 'core-readme') return artifact;
      const { content, ...rest } = artifact;
      expect(content).toContain('core-readme');
      return rest as unknown as GeneratedArtifact;
    });
    const missingContent = failure(() => registry.verifyComposedArtifacts(resolution, missing));
    expect(missingContent.issues).toEqual([{
      code: 'artifact-identity-mismatch',
      subject: `rendered[${index}]`,
      detail: 'missing field(s): content'
    }]);
    expect(() => registry.verifyComposedArtifacts(resolution, withContent(''))).not.toThrow();
  });
});

describe('bundled plugin registry: review regression - packaged byte views', () => {
  it('bounds the actual view length without invoking an own byteLength accessor', () => {
    const counter = { reads: 0 };
    const bytes = Uint8Array.of(97, 98);
    const input = minimalRegistryInput([{ id: 'one', bytes }]);
    spyOn(bytes, 'byteLength', 0, counter);
    Object.assign(input, { limits: { maxAssetBytes: 1, maxTotalAssetBytes: 1 } });
    limitOnly(failure(() => build(input)), 'maxAssetBytes', 1);
    Object.assign(input, { limits: { maxTotalAssetBytes: 1 } });
    limitOnly(failure(() => build(input)), 'maxTotalAssetBytes', 1);
    expect(counter.reads).toBe(0);
  });

  it('ignores own and inherited metadata overrides on genuine Uint8Array bytes', () => {
    const baseline = build(minimalRegistryInput([{ id: 'one', bytes: Uint8Array.of(97, 98) }]));
    const counter = { reads: 0 };
    const own = Uint8Array.of(97, 98);
    const ownInput = minimalRegistryInput([{ id: 'one', bytes: own }]);
    for (const [key, value] of [['byteLength', 0], ['byteOffset', 1], ['length', 0], ['buffer', new ArrayBuffer(0)], [Symbol.toStringTag, 'Int16Array']] as const) {
      spyOn(own, key, value, counter);
    }
    const ownRegistry = build(ownInput);
    expect(ownRegistry.assetsFor({ kind: 'core' }).own.one).toBe('ab');
    expect(ownRegistry.registryDigest).toBe(baseline.registryDigest);
    class SpoofedBytes extends Uint8Array {
      override get byteLength(): number { counter.reads += 1; return 0; }
      override get byteOffset(): number { counter.reads += 1; return 1; }
      override get length(): number { counter.reads += 1; return 0; }
      override get buffer(): ArrayBuffer { counter.reads += 1; return new ArrayBuffer(0); }
      static get [Symbol.species](): Uint8ArrayConstructor { counter.reads += 1; return Uint8Array; }
    }
    const backing = new ArrayBuffer(2);
    new Uint8Array(backing).set([97, 98]);
    Object.defineProperty(backing, 'constructor', { get() { counter.reads += 1; return ArrayBuffer; } });
    const inheritedInput = minimalRegistryInput([{ id: 'one', bytes: Uint8Array.of(97, 98) }]);
    inheritedInput.assets[0].bytes = new SpoofedBytes(backing);
    counter.reads = 0;
    const inherited = build(inheritedInput);
    expect(inherited.assetsFor({ kind: 'core' }).own.one).toBe('ab');
    expect(inherited.registryDigest).toBe(baseline.registryDigest);
    expect(counter.reads).toBe(0);
  });

  it('rejects byte views that are not genuine, non-shared Uint8Arrays', () => {
    const spoofed = new Int16Array([0x6261]);
    Object.setPrototypeOf(spoofed, Uint8Array.prototype);
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set([97, 98]);
    const cases: [string, ArrayBufferView, string][] = [
      ['Int16Array with a Uint8Array prototype', spoofed, 'packaged asset bytes must be a Uint8Array'],
      ['DataView', new DataView(new ArrayBuffer(2)), 'packaged asset bytes must be a Uint8Array'],
      ['Uint8ClampedArray', Uint8ClampedArray.of(97, 98), 'packaged asset bytes must be a Uint8Array'],
      ['Float64Array', Float64Array.of(1), 'packaged asset bytes must be a Uint8Array'],
      ['shared memory', shared, 'packaged asset bytes must not use shared memory']
    ];
    for (const [label, view, detail] of cases) {
      const input = minimalRegistryInput([{ id: 'one', bytes: Uint8Array.of(97, 98) }]);
      input.assets[0].bytes = view as Uint8Array;
      expect(failure(() => build(input)).issues, label).toEqual([bytesIssue(detail)]);
    }
  });

  it('accepts Buffer, offset, resizable and cross-realm Uint8Arrays with identical identity', () => {
    const text = 'version = 1\n';
    const baseline = build(minimalRegistryInput([{ id: 'one', bytes: bytesOf(text) }]));
    const backing = new Uint8Array([0x7a, ...bytesOf(text), 0x7a]);
    const resizable = new ResizableArrayBuffer(text.length, { maxByteLength: 64 });
    new Uint8Array(resizable).set(bytesOf(text));
    const variants: [string, Uint8Array][] = [
      ['Buffer', Buffer.from(text)],
      ['offset view', new Uint8Array(backing.buffer, 1, text.length)],
      ['resizable length-tracking view', new Uint8Array(resizable)],
      ['cross-realm Uint8Array', runInNewContext(`new Uint8Array(${JSON.stringify([...bytesOf(text)])})`) as Uint8Array]
    ];
    for (const [label, bytes] of variants) {
      const registry = build(minimalRegistryInput([{ id: 'one', bytes }]));
      expect(registry.registryDigest, label).toBe(baseline.registryDigest);
      expect(registry.assetsFor({ kind: 'core' }).own.one, label).toBe(text);
      bytes[0] = 0x21;
      expect(registry.assetsFor({ kind: 'core' }).own.one, `${label} after source mutation`).toBe(text);
      expect(Object.isFrozen(bytes), label).toBe(false);
    }
  });
});

describe('bundled plugin registry: review regression - cumulative byte bounds', () => {
  it('fails on the exhausted cumulative bound before copying any later view', () => {
    const input = minimalRegistryInput([
      { id: 'first', bytes: Uint8Array.of(97, 98) },
      { id: 'second', bytes: Uint8Array.of(1) }
    ]);
    input.assets[1].bytes = detachedBytes();
    Object.assign(input, { limits: { maxTotalAssetBytes: 1 } });
    limitOnly(failure(() => build(input)), 'maxTotalAssetBytes', 1);
  });

  it('stops walking at the exhausted bound even for repeated references to one view', () => {
    const view = new Uint8Array(64 * 1024);
    const input = minimalRegistryInput(Array.from({ length: 64 }, (_, index) => ({ id: `repeat-${index}`, bytes: view })));
    const probes = [0, 1, 2].map(() => trapCounter({ pathParts: ['assets', 'shared', 'probe.txt'] }));
    input.assets.splice(1, 0, probes[0].proxy as never);
    input.assets.splice(3, 0, probes[1].proxy as never);
    input.assets.splice(5, 0, probes[2].proxy as never);
    Object.assign(input, { limits: { maxTotalAssetBytes: 128 * 1024 } });
    limitOnly(failure(() => build(input)), 'maxTotalAssetBytes', 128 * 1024);
    expect(probes[0].counter.traps).toBeGreaterThan(0);
    expect(probes[1].counter.traps).toBeGreaterThan(0);
    expect(probes[2].counter.traps).toBe(0);
  });

  it('reports detached, out-of-bounds and shared views within budget as structured issues', () => {
    const resizable = new ResizableArrayBuffer(4, { maxByteLength: 8 });
    const outOfBounds = new Uint8Array(resizable, 2, 2);
    resizable.resize(1);
    for (const [label, bytes] of [['detached', detachedBytes()], ['out of bounds', outOfBounds]] as const) {
      const input = minimalRegistryInput([{ id: 'one', bytes: Uint8Array.of(1) }]);
      input.assets[0].bytes = bytes;
      expect(failure(() => build(input)).issues, label)
        .toEqual([bytesIssue('packaged asset bytes must be an attached, in-bounds Uint8Array')]);
    }
    const input = minimalRegistryInput([{ id: 'one', bytes: Uint8Array.of(1) }, { id: 'two', bytes: Uint8Array.of(2) }]);
    input.assets[0].bytes = detachedBytes();
    input.assets[1].bytes = new Uint8Array(new SharedArrayBuffer(1));
    expect(failure(() => build(input)).issues).toEqual([
      bytesIssue('packaged asset bytes must be an attached, in-bounds Uint8Array'),
      bytesIssue('packaged asset bytes must not use shared memory', 'assets[1].bytes')
    ]);
  });

  it('reports exactly the first exceeded bound in traversal order, deterministically', () => {
    const run = (): PluginRegistryError => {
      const input = registryInput();
      Object.assign(input, { limits: { maxAssetBytes: 1, maxStringLength: 2 } });
      return failure(() => build(input));
    };
    const first = run();
    limitOnly(first, 'maxAssetBytes', 1);
    expect(run().issues).toEqual(first.issues);
  });

  it('reserves node budget for array and record fan-out before enumerating keys', () => {
    const wideArray = registryInput();
    wideArray.core.retiredLogicalNames = Array.from({ length: 5000 }, (_, index) => `retired-${index}`);
    Object.assign(wideArray, { limits: { maxNodes: 400 } });
    limitOnly(failure(() => build(wideArray)), 'maxNodes', 400);
    const wideRecord = minimalRegistryInput([]);
    Object.assign(wideRecord.selectionSpace.workloads[0], Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`k${index}`, 1])));
    Object.assign(wideRecord, { limits: { maxNodes: 400 } });
    limitOnly(failure(() => build(wideRecord)), 'maxNodes', 400);
  });
});

describe('bundled plugin registry: review regression - diagnostics for object-valued fields', () => {
  it('formats object-valued host platforms safely in selection and composition', () => {
    const registry = build(registryInput());
    const selection = selectionOf() as PluginSelection;
    const supported = 'the host platform is not qualified; supported: darwin/arm64, darwin/x64, linux/arm64, linux/x64, win32/x64';
    for (const [platform, shown] of [[{}, '<object>'], [[{}], '<array>'], [null, 'null'], [7, '7'], [true, 'true']] as const) {
      const error = failure(() => registry.resolveSelection(selection, { platform } as never));
      expect(error.stage).toBe('selection');
      expect(error.issues).toEqual([{ code: 'unsupported-host-platform', subject: `host:${shown}`, detail: supported }]);
    }
    const resolution = resolve(registry);
    const composition = failure(() => registry.verifyComposedArtifacts({ ...resolution, hostPlatform: {} } as never, rendered(resolution)));
    expect(composition.stage).toBe('composition');
    expect(composition.issues).toEqual([{
      code: 'resolution-mismatch',
      subject: 'resolution',
      detail: 'the supplied selection does not resolve in this registry (unsupported-host-platform)'
    }]);
  });

  it('reports object-valued identities as structured issues at the appropriate stage', () => {
    const recipe = registryFailure((input) => {
      descriptorOf(input, 'stack-alpha').recipes[0] = { operation: {}, id: 'recipe', version: 1 } as never;
    });
    expect(recipe.stage).toBe('registry');
    expectOnly(recipe, 'invalid-recipe', 'recipe:plugin:stack:stack-alpha:<object>:recipe@1');
    expectOnly(registryFailure((input) => {
      descriptorOf(input, 'stack-alpha').recipes[0] = { operation: 'op-repair', id: [{}], version: {} } as never;
    }), 'invalid-recipe', 'recipe:plugin:stack:stack-alpha:op-repair:<array>@<object>');
    const operation = registryFailure((input) => { input.operations[1].recipes[0] = { id: {}, version: [{}] } as never; }, false);
    expect(operation.issues).toEqual([{
      code: 'invalid-registry-input',
      subject: 'operation:op-repair',
      detail: 'recipe <object>@<array> requires a distinct identifier and positive integer version'
    }]);
    expectOnly(registryFailure((input) => {
      Object.assign(input.release.plugins[0], { category: {}, id: [{}] });
    }, false), 'invalid-registry-input', 'release:plugin:<object>:<array>');
    const registry = build(registryInput());
    const workload = failure(() => registry.resolveSelection({ ...selectionOf(), workload: {} } as never, host));
    expect(workload.issues).toContainEqual({ code: 'invalid-selection', subject: 'selection', detail: 'workload object is not a registered workload' });
    expectOnly(failure(() => registry.assetsFor({ kind: 'plugin', category: {}, id: [] } as never)), 'invalid-selection');
  });

  it('validates public content digest input structurally without invoking accessors', () => {
    const entry = build(registryInput()).inventory[0];
    const counter = { reads: 0 };
    const withAccessor = { ...entry };
    spyOn(withAccessor, 'hostPlatforms', entry.hostPlatforms, counter);
    expect(failure(() => pluginContentDigest(withAccessor)).issues).toEqual([{
      code: 'invalid-descriptor',
      subject: 'hostPlatforms',
      detail: 'object fields must be enumerable data properties'
    }]);
    expect(counter.reads).toBe(0);
    const malformed = failure(() => pluginContentDigest({ ...entry, recipes: [{ operation: Object.create(null), id: 'recipe', version: 1 }] } as never));
    expect(malformed.stage).toBe('registry');
    expect(malformed.issues).toEqual([{
      code: 'invalid-descriptor',
      subject: 'content:stack:stack-alpha',
      detail: 'recipes is not well-formed plugin content'
    }]);
    expect(failure(() => pluginContentDigest({ ...entry, entry: './plugin.js' } as never)).issues[0].detail).toBe('unknown field(s): entry');
    expect(failure(() => pluginContentDigest('stack-alpha' as never)).issues[0].detail).toBe('must be an object');
    expect(failure(() => pluginContentDigest({ ...entry, contentDigest: 7 } as never)).issues[0].detail).toBe('contentDigest must be a string when present');
    expect(pluginContentDigest({ ...entry, contentDigest: `sha256:${'0'.repeat(64)}` })).toBe(entry.contentDigest);
    const { contentDigest, ...content } = entry;
    expect(pluginContentDigest(content)).toBe(contentDigest);
  });

  it('never surfaces raw errors from any public entry point under structural fuzzing', () => {
    const replacements = [() => ({}), () => Object.create(null) as object, () => [{}], () => [Object.create(null) as object], () => null, () => 7, () => true, () => 'x'];
    const paths = (value: unknown, prefix: string[] = []): string[][] =>
      ArrayBuffer.isView(value) || typeof value !== 'object' || value === null
        ? []
        : Object.keys(value).flatMap((key) => [[...prefix, key], ...paths((value as Record<string, unknown>)[key], [...prefix, key])]);
    const assign = (target: unknown, keys: string[], value: unknown): void => {
      let cursor = target as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
      cursor[keys[keys.length - 1]] = value;
    };
    const raw: string[] = [];
    let calls = 0;
    const fuzz = (name: string, base: unknown, call: (value: never) => unknown, prepare?: (value: never) => unknown): void => {
      for (const keys of paths(base)) {
        for (const make of replacements) {
          const value = structuredClone(base);
          assign(value, keys, make());
          if (prepare !== undefined) {
            try {
              prepare(value as never);
            } catch {
              // The synthetic fixture helper is not an API; its dereference failures are irrelevant here.
            }
          }
          calls += 1;
          try {
            call(value as never);
          } catch (error) {
            if (!(error instanceof PluginRegistryError)) raw.push(`${name} ${keys.join('.')}: ${String(error)}`);
          }
        }
      }
    };
    fuzz('createPluginRegistry', registryInput(), (value) => createPluginRegistry(value), (value) => refreshRelease(value));
    const registry = build(registryInput());
    const { contentDigest, ...content } = structuredClone(registry.inventory[0]);
    expect(contentDigest).toMatch(/^sha256:/);
    fuzz('pluginContentDigest', content, (value) => pluginContentDigest(value));
    const selection = structuredClone(selectionOf());
    fuzz('resolveSelection', { selection, host }, (value: { selection: PluginSelection; host: { platform: string } }) =>
      registry.resolveSelection(value.selection, value.host));
    const resolution = registry.resolveSelection(selection as PluginSelection, host);
    fuzz('verifyComposedArtifacts', { resolution: structuredClone(resolution), rendered: rendered(resolution) },
      (value: { resolution: PluginResolution; rendered: GeneratedArtifact[] }) => registry.verifyComposedArtifacts(value.resolution, value.rendered));
    fuzz('assetsFor', { owner: { kind: 'plugin', category: 'stack', id: 'stack-alpha' } }, (value: { owner: never }) => registry.assetsFor(value.owner));
    const minimal = build(minimalRegistryInput([{ id: 'one', bytes: bytesOf('one\n') }]));
    fuzz('minimal resolveSelection', { selection: minimalSelection(), host }, (value: { selection: PluginSelection; host: { platform: string } }) =>
      minimal.resolveSelection(value.selection, value.host));
    expect(calls).toBeGreaterThan(8000);
    expect(raw).toEqual([]);
  });
});

describe('bundled plugin registry: failure coverage', () => {
  it('exercises every published issue code', () => {
    expect([...observedCodes].sort()).toEqual([...pluginIssueCodes].sort());
  });
});
