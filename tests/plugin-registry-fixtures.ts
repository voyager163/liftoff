import { createHash } from 'node:crypto';
import { supportedHostPlatforms } from '../src/domain/project/supported-stack.js';
import type {
  ArtifactDeclaration,
  PluginDescriptor,
  PluginRegistryInput,
  PluginSelection,
  Sha256Digest
} from '../src/plugins/contracts.js';
import { pluginContentDigest } from '../src/plugins/registry.js';

/*
 * Synthetic bundled-plugin registry inputs. Every identifier is deliberately fictional so these
 * fixtures never stand in for, or bless, the real first-party built-ins registered later.
 */

export type DeepMutable<T> = T extends Uint8Array
  ? Uint8Array
  : T extends readonly (infer Entry)[]
    ? DeepMutable<Entry>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

export type MutableInput = DeepMutable<PluginRegistryInput>;
export type MutableDescriptor = DeepMutable<PluginDescriptor>;

export const allHosts = [...supportedHostPlatforms];

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256Of(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function project(logicalName: string, category: string, pathParts: string[], extra: Partial<ArtifactDeclaration> = {}): DeepMutable<ArtifactDeclaration> {
  return { logicalName, category, pathParts, lifecycle: 'project', provisioningGroup: 'base', ...extra } as DeepMutable<ArtifactDeclaration>;
}

function descriptor(category: PluginDescriptor['category'], id: string, extra: Partial<MutableDescriptor>): MutableDescriptor {
  return {
    category,
    id,
    apiVersion: 1,
    contentVersion: 1,
    hostPlatforms: [...allHosts],
    supports: [{}],
    artifacts: [],
    assets: [],
    sharedAssets: [],
    checks: [],
    recipes: [],
    ...extra
  };
}

const assetTexts: Record<string, string> = {
  'assets/shared/frontend/package-lock.json': '{"lockfileVersion":3}\n',
  'assets/shared/templates/README.md': '# Template\n',
  'assets/plugins/stack-alpha/uv.lock': 'version = 1\n',
  'assets/plugins/stack-beta/go.mod': 'module example.invalid/beta\n',
  'assets/plugins/cloud-gamma/.terraform.lock.hcl': '# synthetic provider lock\n',
  'assets/plugins/cloud-gamma/versions.tf': 'terraform {}\n'
};

export function registryInput(): MutableInput {
  const input: MutableInput = {
    selectionSpace: {
      workloads: [
        { id: 'wl-variants', variants: ['var-a', 'var-b'] },
        { id: 'wl-plain', variants: [] }
      ],
      environments: ['env-one', 'env-two'],
      governanceProfiles: ['gov-on', 'gov-off']
    },
    operations: [
      { id: 'op-doctor', permittedCheckEffects: ['project-read', 'local-tool'], recipes: [] },
      {
        id: 'op-repair',
        permittedCheckEffects: ['project-read'],
        recipes: [{ id: 'recipe-layout', version: 1 }, { id: 'recipe-cleanup', version: 2 }]
      }
    ],
    core: {
      artifacts: [
        project('core-readme', 'documentation', ['README.md']),
        { logicalName: 'core-manifest', category: 'manifest', pathParts: ['liftoff.manifest.json'], lifecycle: 'manifest' },
        { logicalName: 'core-config', category: 'configuration', pathParts: ['liftoff.config.json'], lifecycle: 'desired-state' },
        project('core-frontend-app', 'frontend', ['frontend', 'app.ts'], { provisioningGroup: 'frontend', when: { frontend: ['included'] } }),
        {
          logicalName: 'core-governance-policy',
          category: 'governance',
          pathParts: ['.liftoff', 'governance', 'policy.md'],
          lifecycle: 'managed-core',
          when: { governanceProfile: ['gov-on'] }
        },
        project('core-env-one-main', 'infrastructure', ['infra', 'env-one', 'main.tf'], {
          provisioningGroup: 'environment:env-one' as ArtifactDeclaration['provisioningGroup'],
          when: { environment: ['env-one'] }
        }),
        project('core-env-two-main', 'infrastructure', ['infra', 'env-two', 'main.tf'], {
          provisioningGroup: 'environment:env-two' as ArtifactDeclaration['provisioningGroup'],
          when: { environment: ['env-two'] }
        })
      ],
      sharedAssets: [
        { id: 'shared-readme-template', pathParts: ['assets', 'shared', 'templates', 'README.md'] },
        { id: 'shared-frontend-lock', pathParts: ['assets', 'shared', 'frontend', 'package-lock.json'] }
      ],
      managedCore: [
        { logicalName: 'core-governance-policy', pathParts: ['.liftoff', 'governance', 'policy.md'] },
        { logicalName: 'agent-kappa-skill', pathParts: ['.kappa', 'skills', 'liftoff.md'] }
      ],
      retiredLogicalNames: ['retired-thing']
    },
    descriptors: [
      descriptor('stack', 'stack-alpha', {
        supports: [{ workload: ['wl-variants'] }, { workload: ['wl-plain'] }],
        artifacts: [
          project('backend-main', 'backend', ['backend', 'main.py']),
          project('pattern-route', 'pattern', ['backend', 'routes', 'var_a.py'], { when: { variant: ['var-a'] } }),
          project('pattern-route', 'pattern', ['backend', 'routes', 'var_b.py'], { when: { variant: ['var-b'] } }),
          project('backend-observability', 'backend', ['backend', 'obs', 'plain.py'], { when: { workload: ['wl-plain'] } }),
          project('backend-observability', 'backend', ['backend', 'obs', 'variant.py'], { when: { workload: ['wl-variants'] } })
        ],
        assets: [{ id: 'alpha-lock', pathParts: ['assets', 'plugins', 'stack-alpha', 'uv.lock'] }],
        checks: [{ id: 'alpha-project', version: 1, operation: 'op-doctor', effects: ['project-read', 'local-tool'] }],
        recipes: [{ operation: 'op-repair', id: 'recipe-layout', version: 1 }]
      }),
      descriptor('stack', 'stack-beta', {
        supports: [{ workload: ['wl-plain'] }],
        artifacts: [
          project('backend-main', 'backend', ['backend', 'main.go']),
          project('beta-module', 'backend', ['backend', 'go.mod'])
        ],
        assets: [{ id: 'beta-module', pathParts: ['assets', 'plugins', 'stack-beta', 'go.mod'] }],
        sharedAssets: ['shared-frontend-lock']
      }),
      descriptor('cloud', 'cloud-gamma', {
        artifacts: [project('cloud-main', 'infrastructure', ['infra', 'main.tf'])],
        assets: [
          { id: 'gamma-versions', pathParts: ['assets', 'plugins', 'cloud-gamma', 'versions.tf'] },
          { id: 'gamma-lock', pathParts: ['assets', 'plugins', 'cloud-gamma', '.terraform.lock.hcl'] }
        ]
      }),
      descriptor('workflow', 'flow-delta', {
        artifacts: [
          { logicalName: 'delta-seed', category: 'seed', pathParts: ['specs', 'delta', 'seed.md'], lifecycle: 'seed' },
          { logicalName: 'delta-stack-seed', category: 'seed', pathParts: ['specs', 'delta', 'alpha.md'], lifecycle: 'seed', when: { stack: ['stack-alpha'] } },
          { logicalName: 'delta-stack-seed', category: 'seed', pathParts: ['specs', 'delta', 'beta.md'], lifecycle: 'seed', when: { stack: ['stack-beta'] } }
        ]
      }),
      descriptor('workflow', 'flow-epsilon', {
        artifacts: [{ logicalName: 'epsilon-template', category: 'framework', pathParts: ['.epsilon', 'template.md'], lifecycle: 'framework' }]
      }),
      descriptor('agent', 'agent-kappa', {
        artifacts: [
          project('agent-kappa-instructions', 'documentation', ['KAPPA.md']),
          {
            logicalName: 'agent-kappa-skill',
            category: 'governance',
            pathParts: ['.kappa', 'skills', 'liftoff.md'],
            lifecycle: 'managed-core',
            when: { governanceProfile: ['gov-on'] }
          }
        ]
      }),
      descriptor('agent', 'agent-lambda', {
        artifacts: [project('agent-lambda-instructions', 'documentation', ['LAMBDA.md'])]
      })
    ],
    assets: Object.entries(assetTexts).map(([location, text]) => ({ pathParts: location.split('/'), bytes: bytesOf(text) })),
    release: { schemaVersion: 1, sharedAssets: [], plugins: [] }
  };
  return refreshRelease(input);
}

/**
 * The smallest valid registry: one plugin per category and only the given core shared assets, in
 * the given byte-entry order. Release digests are computed from the bytes supplied here, so callers
 * that later tamper with view metadata keep an honest expected inventory.
 */
export function minimalRegistryInput(assets: readonly { id: string; bytes: Uint8Array }[]): MutableInput {
  const locations = assets.map((asset) => ['assets', 'shared', `${asset.id}.txt`]);
  const input: MutableInput = {
    selectionSpace: { workloads: [{ id: 'wl-only', variants: [] }], environments: ['env-only'], governanceProfiles: ['gov-only'] },
    operations: [],
    core: {
      artifacts: [],
      sharedAssets: assets.map((asset, index) => ({ id: asset.id, pathParts: locations[index] })),
      managedCore: [],
      retiredLogicalNames: []
    },
    descriptors: [
      descriptor('stack', 'stack-only', {}),
      descriptor('cloud', 'cloud-only', {}),
      descriptor('workflow', 'flow-only', {}),
      descriptor('agent', 'agent-only', {})
    ],
    assets: assets.map((asset, index) => ({ pathParts: locations[index], bytes: asset.bytes })),
    release: { schemaVersion: 1, sharedAssets: [], plugins: [] }
  };
  return refreshRelease(input);
}

export function minimalSelection(): DeepMutable<PluginSelection> {
  return {
    workload: 'wl-only',
    stack: 'stack-only',
    cloud: 'cloud-only',
    workflow: 'flow-only',
    agents: ['agent-only'],
    frontend: 'omitted',
    governanceProfile: 'gov-only',
    environments: ['env-only']
  };
}

/** Recomputes the expected release inventory from the current declarations and bytes. */
export function refreshRelease(input: MutableInput): MutableInput {
  const bytesAt = new Map(input.assets.map((entry) => [entry.pathParts.join('/'), entry.bytes]));
  const digestAt = (pathParts: readonly string[]): Sha256Digest => sha256Of(bytesAt.get(pathParts.join('/')) ?? new Uint8Array());
  const sharedDigests = new Map(input.core.sharedAssets.map((asset) => [asset.id, digestAt(asset.pathParts)]));
  input.release = {
    schemaVersion: 1,
    sharedAssets: input.core.sharedAssets.map((asset) => ({
      id: asset.id,
      pathParts: [...asset.pathParts],
      sha256: digestAt(asset.pathParts)
    })),
    plugins: input.descriptors.map((entry) => ({
      category: entry.category,
      id: entry.id,
      apiVersion: entry.apiVersion,
      contentVersion: entry.contentVersion,
      contentDigest: pluginContentDigest({
        category: entry.category,
        id: entry.id,
        apiVersion: entry.apiVersion,
        contentVersion: entry.contentVersion,
        hostPlatforms: entry.hostPlatforms,
        supports: entry.supports,
        artifacts: entry.artifacts,
        assets: entry.assets.map((asset) => ({ id: asset.id, sha256: digestAt(asset.pathParts) })),
        sharedAssets: entry.sharedAssets.map((id) => ({ id, sha256: sharedDigests.get(id) ?? digestAt([]) })),
        checks: entry.checks,
        recipes: entry.recipes
      }),
      assets: entry.assets.map((asset) => ({ id: asset.id, pathParts: [...asset.pathParts], sha256: digestAt(asset.pathParts) }))
    }))
  };
  return input;
}

export function descriptorOf(input: MutableInput, id: string): MutableDescriptor {
  const found = input.descriptors.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`fixture descriptor ${id} is missing`);
  return found;
}

export function sharedAssetOf(input: MutableInput, id: string): MutableInput['core']['sharedAssets'][number] {
  const found = input.core.sharedAssets.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`fixture shared asset ${id} is missing`);
  return found;
}

export function bytesEntryOf(input: MutableInput, location: string): MutableInput['assets'][number] {
  const found = input.assets.find((entry) => entry.pathParts.join('/') === location);
  if (found === undefined) throw new Error(`fixture bytes ${location} are missing`);
  return found;
}

export function selectionOf(overrides: Partial<PluginSelection> = {}): DeepMutable<PluginSelection> {
  return {
    workload: 'wl-variants',
    variant: 'var-a',
    stack: 'stack-alpha',
    cloud: 'cloud-gamma',
    workflow: 'flow-delta',
    agents: ['agent-lambda', 'agent-kappa'],
    frontend: 'included',
    governanceProfile: 'gov-on',
    environments: ['env-two', 'env-one'],
    ...overrides
  } as DeepMutable<PluginSelection>;
}

/** Reverses every order-bearing list so registration/declaration order independence can be proven. */
export function reversedInput(input: MutableInput): MutableInput {
  const reverseCondition = (condition: Record<string, string[]> | undefined): void => {
    for (const values of Object.values(condition ?? {})) values.reverse();
  };
  const copy = structuredClone(input);
  copy.descriptors.reverse();
  copy.assets.reverse();
  copy.core.artifacts.reverse();
  copy.core.managedCore.reverse();
  copy.release.plugins.reverse();
  copy.release.sharedAssets.reverse();
  copy.operations.reverse();
  copy.selectionSpace.workloads.reverse();
  copy.selectionSpace.environments.reverse();
  copy.selectionSpace.governanceProfiles.reverse();
  for (const artifact of copy.core.artifacts) reverseCondition(artifact.when as Record<string, string[]> | undefined);
  for (const entry of copy.descriptors) {
    entry.hostPlatforms.reverse();
    entry.supports.reverse();
    entry.artifacts.reverse();
    entry.assets.reverse();
    entry.checks.reverse();
    entry.recipes.reverse();
    entry.sharedAssets.reverse();
    for (const alternative of entry.supports) reverseCondition(alternative as Record<string, string[]>);
    for (const artifact of entry.artifacts) reverseCondition(artifact.when as Record<string, string[]> | undefined);
    for (const check of entry.checks) check.effects.reverse();
  }
  for (const record of copy.release.plugins) record.assets.reverse();
  return copy;
}
