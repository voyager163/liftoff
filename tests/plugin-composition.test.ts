import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDeclaredAssetBytes } from '../src/adapters/packaged-assets/plugin-assets.js';
import { PackagedAssetReadError } from '../src/adapters/packaged-assets/plugin-assets.js';
import {
  PluginCompositionError,
  builtinPluginRegistry,
  builtinTemplateAssets,
  composeProjectPlugins,
  createBuiltinPluginRegistry,
  pluginSelectionForPlan,
  templateAssetsFromRegistry,
  type BuiltinAssetReader
} from '../src/application/project/plugins.js';
import { boundRenderers, builtinRendererBindings } from '../src/application/project/plugin-renderers.js';
import {
  artifactPathTokenIssues,
  bootstrapChangeToken,
  concreteArtifactPathIssues,
  materializeArtifactPathParts
} from '../src/domain/project/artifact-path-tokens.js';
import type { GeneratedArtifact, ProjectPlan } from '../src/domain/project/contracts.js';
import { supportedHostPlatforms } from '../src/domain/project/supported-stack.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { builtinCore, builtinRegistryInput } from '../src/plugins/builtin/index.js';
import {
  PluginRegistryError,
  pluginRegistryLimits,
  type ArtifactDeclaration,
  type PackagedAssetBytes,
  type PluginRegistry,
  type PluginRegistryLimits,
  type PluginResolution
} from '../src/plugins/contracts.js';
import { createPluginRegistry } from '../src/plugins/registry.js';
import { buildArtifacts } from '../src/templates.js';
import { matrixPlan, pluginGenerationMatrix } from './fixtures/plugin-generation-matrix.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

// Pass-through observation of the first core renderer, the plugin-bound workflow renderers and the
// generator context, plus a switchable fault in the default asset reader. Behavior is unchanged
// while `fault.mode` is 'none'.
const observed = vi.hoisted(() => ({ calls: [] as string[], fault: { mode: 'none' as 'none' | 'drop-one' | 'flip-byte' } }));
vi.mock('../src/generators/common/base.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/generators/common/base.js')>();
  return {
    ...actual,
    addBaseArtifacts: (...args: Parameters<typeof actual.addBaseArtifacts>) => {
      observed.calls.push('render:base');
      return actual.addBaseArtifacts(...args);
    }
  };
});
vi.mock('../src/generators/common/spec-workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/generators/common/spec-workflow.js')>();
  return {
    ...actual,
    addOpenSpecArtifacts: (...args: Parameters<typeof actual.addOpenSpecArtifacts>) => {
      observed.calls.push('render:openspec');
      return actual.addOpenSpecArtifacts(...args);
    },
    addSpecKitArtifacts: (...args: Parameters<typeof actual.addSpecKitArtifacts>) => {
      observed.calls.push('render:spec-kit');
      return actual.addSpecKitArtifacts(...args);
    }
  };
});
vi.mock('../src/generators/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/generators/context.js')>();
  return {
    ...actual,
    createGeneratorContext: (...args: Parameters<typeof actual.createGeneratorContext>) => {
      observed.calls.push('context');
      return actual.createGeneratorContext(...args);
    }
  };
});
vi.mock('../src/adapters/packaged-assets/plugin-assets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/packaged-assets/plugin-assets.js')>();
  return {
    ...actual,
    readDeclaredAssetBytes: (...args: Parameters<typeof actual.readDeclaredAssetBytes>) => {
      const bytes = actual.readDeclaredAssetBytes(...args);
      if (observed.fault.mode === 'drop-one') return bytes.slice(1);
      if (observed.fault.mode === 'flip-byte') {
        return bytes.map((entry, index) => index === 0
          ? { pathParts: entry.pathParts, bytes: Uint8Array.from(entry.bytes, (byte, position) => (position === 0 ? byte ^ 0x01 : byte)) }
          : entry);
      }
      return bytes;
    }
  };
});

const readBounds = {
  maxAssetBytes: pluginRegistryLimits.maxAssetBytes,
  maxTotalAssetBytes: pluginRegistryLimits.maxTotalAssetBytes,
  maxPathParts: pluginRegistryLimits.maxPathParts,
  maxPartLength: pluginRegistryLimits.maxStringLength
};
const installedBytes = (): PackagedAssetBytes[] => readDeclaredAssetBytes(builtinAssets, readBounds);

const identity = (artifact: { logicalName: string; category: string; lifecycle: string; provisioningGroup?: string; pathParts: readonly string[] }) =>
  JSON.stringify([artifact.logicalName, artifact.category, artifact.lifecycle, artifact.provisioningGroup ?? null, artifact.pathParts]);
const sorted = (values: Iterable<string>) => [...values].sort();
const semantic = (resolution: PluginResolution) => {
  const { hostPlatform: _host, ...rest } = resolution;
  return JSON.stringify(rest);
};

function plan(options: Record<string, unknown> = {}): ProjectPlan {
  return matrixPlan({ id: 'custom', group: 'M4', options: {
    projectName: 'Composition Case', cloud: 'azure', region: 'eastus', projectType: 'standard', apiStack: 'python-fastapi',
    agents: ['github-copilot'], ...options
  } });
}

/** A registry built from the built-ins plus extra core literal declarations. */
function registryWithCore(extra: readonly ArtifactDeclaration[]): PluginRegistry {
  const input = builtinRegistryInput(installedBytes());
  return createPluginRegistry({ ...input, core: { ...builtinCore, artifacts: [...builtinCore.artifacts, ...extra] } });
}

function compositionFailure(action: () => unknown): PluginCompositionError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginCompositionError);
    return error as PluginCompositionError;
  }
  throw new Error('expected a composition failure');
}

function registryFailure(action: () => unknown): PluginRegistryError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginRegistryError);
    return error as PluginRegistryError;
  }
  throw new Error('expected a registry failure');
}

const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
  observed.fault.mode = 'none';
});

describe('built-in composition against the unchanged renderers', () => {
  it('expects exactly the rendered identities and verifies every matrix plan without mutating it', () => {
    for (const entry of pluginGenerationMatrix) {
      const current = matrixPlan(entry);
      const composition = composeProjectPlugins(current);
      const artifacts = buildArtifacts(current);
      expect(sorted(composition.expected.map(identity)), entry.id).toEqual(sorted(artifacts.map(identity)));
      const before = structuredClone(artifacts);
      const objects = [...artifacts];
      expect(() => composition.verify(artifacts), entry.id).not.toThrow();
      expect(artifacts).toEqual(before);
      expect(artifacts.every((artifact, index) => artifact === objects[index])).toBe(true);
    }
  });

  it('materializes the bootstrap change from the plan and keeps the declared form project-neutral', () => {
    const current = plan({ projectName: 'My App 2' });
    const composition = composeProjectPlugins(current);
    const seeds = composition.expected.filter((artifact) => artifact.pathParts[1] === 'changes');
    expect(seeds.map((artifact) => artifact.pathParts.slice(0, 3).join('/'))).toEqual(
      Array(5).fill('openspec/changes/bootstrap-my-app-2'));
    expect(composition.resolution.artifacts.filter((artifact) => artifact.pathParts.includes(bootstrapChangeToken)))
      .toHaveLength(5);
    expect(JSON.stringify(composition.resolution)).not.toContain('my-app-2');
    expect(composeProjectPlugins(plan({ projectName: 'Other Name' })).resolution.digest).toBe(composition.resolution.digest);
  });
});

describe('host-neutral resolution (H1)', () => {
  it('resolves every selection identically on every qualified host apart from the host field', () => {
    const registry = builtinPluginRegistry();
    for (const entry of pluginGenerationMatrix.filter((candidate) => candidate.group !== 'M1')) {
      const selection = pluginSelectionForPlan(matrixPlan(entry));
      const resolutions = supportedHostPlatforms.map((platform) => registry.resolveSelection(selection, { platform }));
      expect(resolutions.map((resolution) => resolution.hostPlatform)).toEqual([...supportedHostPlatforms]);
      expect(new Set(resolutions.map((resolution) => resolution.digest)).size).toBe(1);
      expect(new Set(resolutions.map(semantic)).size).toBe(1);
    }
  });

  it('generates identically, with no host value in output or errors, on an unqualified host', () => {
    const current = plan({ projectType: 'genai', pattern: 'rag', apiStack: undefined });
    const expected = buildArtifacts(current);
    const composed = composeProjectPlugins(current);
    for (const [key, value] of [['platform', 'win32'], ['arch', 'arm64']] as const) {
      const original = Object.getOwnPropertyDescriptor(process, key) as PropertyDescriptor;
      Object.defineProperty(process, key, { ...original, value });
      restorers.push(() => Object.defineProperty(process, key, original));
    }
    expect(`${process.platform}/${process.arch}`).toBe('win32/arm64');
    expect(buildArtifacts(current)).toEqual(expected);
    const again = composeProjectPlugins(current);
    expect(again.resolution).toEqual(composed.resolution);
    expect(JSON.stringify(expected)).not.toContain('win32/arm64');
    const failure = registryFailure(() => composeProjectPlugins({ ...current, provider: { ...current.provider, id: 'aws' } }));
    expect(failure.message).not.toContain('arm64');
    expect(failure.message).not.toContain('win32');
  });
});

describe('agentless selections (A1 guard)', () => {
  const scalarContexts = [
    { workload: 'standard', stack: 'python-fastapi' },
    { workload: 'standard', stack: 'node-fastify' },
    { workload: 'standard', stack: 'go-huma' },
    ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
      .map((variant) => ({ workload: 'genai', variant, stack: 'python-fastapi' }))
  ].flatMap((workload) => ['openspec', 'spec-kit'].flatMap((workflow) => (['omitted', 'included'] as const).flatMap((frontend) =>
    ['single-maintainer-gitflow', 'none'].map((governanceProfile) => ({
      ...workload, cloud: 'azure', workflow, frontend, governanceProfile, agents: [], environments: ['dev', 'staging', 'prod']
    })))));

  it('resolves all 96 scalar contexts with no agent on all 5 hosts', () => {
    const registry = builtinPluginRegistry();
    expect(scalarContexts).toHaveLength(96);
    let resolved = 0;
    for (const selection of scalarContexts) {
      const resolutions = supportedHostPlatforms.map((platform) => registry.resolveSelection(selection, { platform }));
      resolved += resolutions.length;
      for (const resolution of resolutions) {
        expect(resolution.selection.agents).toEqual([]);
        expect(resolution.plugins.some((plugin) => plugin.category === 'agent')).toBe(false);
      }
      expect(new Set(resolutions.map(semantic)).size).toBe(1);
    }
    expect(resolved).toBe(480);
  });

  it('renders and verifies each M1 plan without agents, minus exactly the agent-owned identities', () => {
    for (const entry of pluginGenerationMatrix.filter((candidate) => candidate.group === 'M1')) {
      const withAgents = matrixPlan(entry);
      const agentless: ProjectPlan = { ...withAgents, agents: [], defaultAgent: undefined };
      const composition = composeProjectPlugins(agentless);
      const artifacts = buildArtifacts(agentless);
      composition.verify(artifacts);
      const all = new Set(buildArtifacts(withAgents).map(identity));
      const remaining = new Set(artifacts.map(identity));
      const removed = [...all].filter((key) => !remaining.has(key));
      expect([...remaining].filter((key) => !all.has(key)), entry.id).toEqual([]);
      const agentOwned = composeProjectPlugins(withAgents).expected
        .filter((artifact) => artifact.owner.kind === 'plugin' && artifact.owner.category === 'agent').map(identity);
      expect(sorted(removed), entry.id).toEqual(sorted(agentOwned));
      expect(removed).toHaveLength(withAgents.governanceProfile.id === 'none' ? 3 : 9);
    }
  });
});

describe('rejection before rendering', () => {
  it('propagates registry errors for unknown, wrong-category, unsupported and invalid selections', () => {
    const standard = plan();
    const genai = plan({ projectType: 'genai', pattern: 'rag', apiStack: undefined });
    const node = plan({ apiStack: 'node-fastify' });
    const cases: Array<[ProjectPlan, string]> = [
      [{ ...standard, provider: { ...standard.provider, id: 'aws' } }, 'unknown-plugin'],
      [{ ...standard, apiStack: { ...standard.apiStack, id: 'azure' as never } }, 'wrong-category'],
      [{ ...genai, apiStack: node.apiStack }, 'unsupported-combination'],
      [{ ...standard, environments: [] }, 'invalid-selection'],
      [{ ...standard, governanceProfile: { ...standard.governanceProfile, id: 'custom' as never } }, 'invalid-selection']
    ];
    for (const [candidate, code] of cases) {
      const failure = registryFailure(() => composeProjectPlugins(candidate));
      expect(failure.stage).toBe('selection');
      expect(failure.issues.map((issue) => issue.code)).toContain(code);
    }
  });

  it('refuses a workflow that differs from the framework adapter', () => {
    const standard = plan();
    const spec = plan({ specWorkflow: 'spec-kit' });
    const failure = compositionFailure(() => composeProjectPlugins({ ...standard, framework: spec.framework }));
    expect([failure.stage, failure.issues.map((issue) => issue.code)]).toEqual(['pre-render', ['workflow-framework-mismatch']]);
  });
});

describe('reserved bootstrap token and concrete path collisions', () => {
  const literal = (logicalName: string, pathParts: string[]): ArtifactDeclaration =>
    ({ logicalName, category: 'documentation', pathParts, lifecycle: 'project', provisioningGroup: 'base' });

  it('fails a literal that collides with the materialized change only for the colliding project', () => {
    const registry = registryWithCore([literal('fixture-literal-proposal', ['openspec', 'changes', 'bootstrap-demo', 'proposal.md'])]);
    const failure = compositionFailure(() => composeProjectPlugins(plan({ projectName: 'demo' }), registry));
    expect(failure.stage).toBe('pre-render');
    expect(failure.issues).toEqual([{
      code: 'path-alias-collision',
      subject: 'path:openspec/changes/bootstrap-demo/proposal.md',
      detail: 'claimed by fixture-literal-proposal, openspec-seed-proposal'
    }]);
    const other = composeProjectPlugins(plan({ projectName: 'other' }), registry);
    expect(other.expected.map((artifact) => artifact.pathParts.join('/'))).toContain('openspec/changes/bootstrap-other/proposal.md');
  });

  it('fails case aliases and file-directory prefixes of the materialized change', () => {
    const alias = registryWithCore([literal('fixture-alias', ['openspec', 'changes', 'Bootstrap-Demo', 'proposal.md'])]);
    expect(compositionFailure(() => composeProjectPlugins(plan({ projectName: 'demo' }), alias)).issues.map((issue) => issue.code))
      .toEqual(['path-alias-collision']);
    const prefix = registryWithCore([literal('fixture-prefix', ['openspec', 'changes', 'bootstrap-demo'])]);
    const failure = compositionFailure(() => composeProjectPlugins(plan({ projectName: 'demo' }), prefix));
    expect(new Set(failure.issues.map((issue) => issue.code))).toEqual(new Set(['path-prefix-collision']));
    expect(failure.issues.every((issue) => issue.subject === 'path:openspec/changes/bootstrap-demo')).toBe(true);
    expect(() => composeProjectPlugins(plan({ projectName: 'other' }), prefix)).not.toThrow();
  });

  it('fails misplaced, unreserved and embedded tokens before materializing', () => {
    const cases: Array<[ArtifactDeclaration, string]> = [
      [literal('fixture-misplaced', ['docs', bootstrapChangeToken, 'notes.md']), 'token-misplaced'],
      [literal('fixture-unreserved', ['openspec', 'changes', bootstrapChangeToken, 'extra.md']), 'token-misplaced'],
      [literal('fixture-final', ['docs', bootstrapChangeToken]), 'token-misplaced'],
      [literal('fixture-embedded', ['docs', `x${bootstrapChangeToken}y.md`]), 'token-embedded']
    ];
    for (const [declaration, code] of cases) {
      const failure = compositionFailure(() => composeProjectPlugins(plan({ projectName: 'demo' }), registryWithCore([declaration])));
      expect([failure.stage, failure.issues.map((issue) => [issue.code, issue.subject])])
        .toEqual(['pre-render', [[code, `artifact:${declaration.logicalName}`]]]);
    }
    // A token file where the change directory is declared never reaches composition: registry
    // construction already rejects the declared file/directory prefix collision.
    const prefix = registryFailure(() => registryWithCore([literal('fixture-token-file', ['openspec', 'changes', bootstrapChangeToken])]));
    expect([prefix.stage, [...new Set(prefix.issues.map((issue) => issue.code))]]).toEqual(['registry', ['path-prefix-collision']]);
    // The placement rule itself, for reserved names, on the pure domain validator.
    expect(artifactPathTokenIssues([
      { logicalName: 'openspec-seed-proposal', pathParts: ['openspec', 'changes', bootstrapChangeToken] },
      { logicalName: 'openspec-seed-proposal', pathParts: ['openspec', 'specs', bootstrapChangeToken, 'proposal.md'] },
      { logicalName: 'openspec-seed-proposal', pathParts: ['openspec', 'changes', bootstrapChangeToken, 'proposal.md'] }
    ]).map((issue) => issue.code)).toEqual(['token-misplaced', 'token-misplaced']);
    expect(materializeArtifactPathParts(['openspec', 'changes', bootstrapChangeToken, 'tasks.md'], { safeProjectName: 'demo' }))
      .toEqual(['openspec', 'changes', 'bootstrap-demo', 'tasks.md']);
    expect(concreteArtifactPathIssues([
      { logicalName: 'a', pathParts: ['docs', 'Read Me.md'] },
      { logicalName: 'b', pathParts: ['docs', '..'] },
      { logicalName: 'c', pathParts: ['docs', `x${bootstrapChangeToken}`] },
      { logicalName: 'd', pathParts: ['DOCS', 'same.md'] },
      { logicalName: 'e', pathParts: ['docs', 'same.md'] }
    ]).map((issue) => [issue.code, issue.subject])).toEqual([
      ['non-portable-path', 'artifact:a'],
      ['non-portable-path', 'artifact:b'],
      ['token-unmaterialized', 'artifact:c'],
      ['path-alias-collision', 'path:docs/same.md']
    ]);
  });
});

describe('post-render verification', () => {
  const current = plan({ projectName: 'demo' });
  const rendered = () => buildArtifacts(current);
  const failing = (mutate: (artifacts: GeneratedArtifact[]) => GeneratedArtifact[]) => {
    const composition = composeProjectPlugins(current);
    return registryFailure(() => composition.verify(mutate(rendered())));
  };

  it('keeps the registry authoritative for undeclared, missing, duplicate and mismatched artifacts', () => {
    const extra = { logicalName: 'unexpected', category: 'documentation', lifecycle: 'project', provisioningGroup: 'base', pathParts: ['EXTRA.md'], content: 'x\n' } as GeneratedArtifact;
    const cases: Array<[string, (artifacts: GeneratedArtifact[]) => GeneratedArtifact[]]> = [
      ['undeclared-artifact', (artifacts) => [...artifacts, extra]],
      ['missing-artifact', (artifacts) => artifacts.filter((artifact) => artifact.logicalName !== 'root-readme')],
      ['duplicate-artifact', (artifacts) => [...artifacts, artifacts[0]]],
      ['artifact-identity-mismatch', (artifacts) => artifacts.map((artifact) =>
        artifact.logicalName === 'root-readme' ? { ...artifact, category: 'project' } : artifact)],
      ['artifact-identity-mismatch', (artifacts) => artifacts.map((artifact) =>
        artifact.logicalName === 'openspec-seed-proposal'
          ? { ...artifact, pathParts: ['openspec', 'changes', 'bootstrap-other', 'proposal.md'] }
          : artifact)]
    ];
    for (const [code, mutate] of cases) {
      const failure = failing(mutate);
      expect(failure.stage).toBe('composition');
      expect(failure.issues.map((issue) => issue.code)).toContain(code);
    }
  });

  it('refuses an unmaterialized token in any rendered path', () => {
    const composition = composeProjectPlugins(current);
    const leaked = rendered().map((artifact) => artifact.logicalName === 'openspec-seed-design'
      ? { ...artifact, pathParts: ['openspec', 'changes', bootstrapChangeToken, 'design.md'] }
      : artifact);
    const failure = compositionFailure(() => composition.verify(leaked));
    expect([failure.stage, failure.issues.map((issue) => [issue.code, issue.subject])])
      .toEqual(['post-render', [['token-leak', 'artifact:openspec-seed-design']]]);
  });

  it('rejects a resolution that this registry would not produce', () => {
    const composition = composeProjectPlugins(current);
    const forged = { ...composition.resolution, artifacts: composition.resolution.artifacts.slice(1) };
    const failure = registryFailure(() => builtinPluginRegistry().verifyComposedArtifacts(forged, rendered()));
    expect(failure.issues.map((issue) => issue.code)).toEqual(['resolution-mismatch']);
  });
});

describe('registry construction boundary', () => {
  it('fails closed on a missing asset, a flipped byte or an undeclared asset, and passes reader errors through', () => {
    const bytes = installedBytes();
    const missing = registryFailure(() => createBuiltinPluginRegistry(() => bytes.slice(1)));
    expect(missing.issues.map((issue) => issue.code)).toEqual(['missing-asset']);
    const flipped = bytes.map((entry, index) => index === 0
      ? { pathParts: entry.pathParts, bytes: Uint8Array.from(entry.bytes, (byte, position) => (position === 0 ? byte ^ 0x01 : byte)) }
      : entry);
    expect(createHash('sha256').update(flipped[0].bytes).digest('hex'))
      .not.toBe(createHash('sha256').update(bytes[0].bytes).digest('hex'));
    const digest = registryFailure(() => createBuiltinPluginRegistry(() => flipped));
    expect(digest.issues.map((issue) => issue.code)).toContain('digest-mismatch');
    const undeclared = registryFailure(() => createBuiltinPluginRegistry(() => [
      ...bytes, { pathParts: ['assets', 'plugins', 'unknown', 'extra.txt'], bytes: new Uint8Array([10]) }
    ]));
    expect(undeclared.issues.map((issue) => issue.code)).toEqual(['undeclared-asset']);
    const readerError = new PackagedAssetReadError(builtinAssets[0], 'missing', { code: 'ENOENT' });
    let thrown: unknown;
    try {
      createBuiltinPluginRegistry(() => { throw readerError; });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(readerError);
  });

  it('passes lowered limits to the registry and to the reader bounds', () => {
    let seen: unknown;
    const registry = createBuiltinPluginRegistry((declarations, bounds) => {
      seen = bounds;
      return readDeclaredAssetBytes(declarations, bounds);
    }, { maxAssetBytes: 460_000, maxTotalAssetBytes: 1_200_000 });
    expect(seen).toEqual({ maxAssetBytes: 460_000, maxTotalAssetBytes: 1_200_000, maxPathParts: 32, maxPartLength: 255 });
    expect(registry.registryDigest).toBe(builtinPluginRegistry().registryDigest);
    const tooSmall = registryFailure(() => createBuiltinPluginRegistry(() => installedBytes(), { maxAssetBytes: 459_997 }));
    expect(tooSmall.issues.map((issue) => issue.code)).toContain('validation-limit-exceeded');
  });

  it('refuses malformed, raised, unknown and non-plain limit overrides before the reader is invoked', () => {
    let reads = 0;
    const reader: BuiltinAssetReader = () => {
      reads += 1;
      return installedBytes();
    };
    let accessorInvoked = false;
    const accessor = Object.defineProperty({}, 'maxAssetBytes', {
      enumerable: true,
      get: () => {
        accessorInvoked = true;
        return 1024;
      }
    });
    const hidden = Object.defineProperty({}, 'maxAssetBytes', { enumerable: false, value: 1024 });
    class Limits {
      maxAssetBytes = 1024;
    }
    const numeric = (name: keyof PluginRegistryLimits): [string, string] => [`limits.${name}`,
      `must be an enumerable data property holding a positive safe integer no greater than the default ${pluginRegistryLimits[name]}`];
    const shape: [string, string] = ['limits', 'limit overrides must be a plain object of known registry limits'];
    const cases: [string, unknown, [string, string][]][] = [
      ['NaN', { maxAssetBytes: Number.NaN }, [numeric('maxAssetBytes')]],
      ['Infinity', { maxTotalAssetBytes: Number.POSITIVE_INFINITY }, [numeric('maxTotalAssetBytes')]],
      ['-Infinity', { maxNodes: Number.NEGATIVE_INFINITY }, [numeric('maxNodes')]],
      ['explicit undefined', { maxAssetBytes: undefined }, [numeric('maxAssetBytes')]],
      ['zero', { maxPathParts: 0 }, [numeric('maxPathParts')]],
      ['negative', { maxDepth: -1 }, [numeric('maxDepth')]],
      ['fraction', { maxStringLength: 1.5 }, [numeric('maxStringLength')]],
      ['numeric string', { maxAssetBytes: '1024' }, [numeric('maxAssetBytes')]],
      ['bigint', { maxAssetBytes: 1024n }, [numeric('maxAssetBytes')]],
      ['raised by one', { maxAssetBytes: pluginRegistryLimits.maxAssetBytes + 1 }, [numeric('maxAssetBytes')]],
      ['raised to the largest safe integer', { maxSatisfiabilityWork: Number.MAX_SAFE_INTEGER }, [numeric('maxSatisfiabilityWork')]],
      ['accessor', accessor, [numeric('maxAssetBytes')]],
      ['non-enumerable', hidden, [numeric('maxAssetBytes')]],
      ['unknown limit', { maxPlugins: 1 }, [['limits.maxPlugins', 'is not a bundled plugin registry limit']]],
      ['symbol key', { [Symbol('limit')]: 1 }, [['limits', 'symbol-keyed limit overrides are not accepted']]],
      ['null', null, [shape]],
      ['array', [1024], [shape]],
      ['number', 1024, [shape]],
      ['class instance', new Limits(), [shape]],
      ['reviewed reproduction', { maxAssetBytes: Number.NaN, maxTotalAssetBytes: Number.NaN },
        [numeric('maxAssetBytes'), numeric('maxTotalAssetBytes')]]
    ];
    for (const [label, limits, issues] of cases) {
      const failure = compositionFailure(() => createBuiltinPluginRegistry(reader, limits as Partial<PluginRegistryLimits>));
      expect(failure.stage, label).toBe('pre-render');
      expect(failure.issues.map((issue) => [issue.code, issue.subject, issue.detail]), label)
        .toEqual(issues.map(([subject, detail]) => ['invalid-registry-limit', subject, detail]));
    }
    expect(reads).toBe(0);
    expect(accessorInvoked).toBe(false);
    expect(compositionFailure(() => createBuiltinPluginRegistry(reader, { maxAssetBytes: Number.NaN })).message).toBe([
      'Bundled plugin composition failed before rendering:',
      '- invalid-registry-limit limits.maxAssetBytes: must be an enumerable data property holding a positive safe integer no greater than the default 4194304'
    ].join('\n'));
  });

  it('forwards valid overrides exactly, without clamping, and preserves registry and reader errors', () => {
    const seen: unknown[] = [];
    const reader: BuiltinAssetReader = (declarations, bounds) => {
      seen.push(bounds);
      return readDeclaredAssetBytes(declarations, bounds);
    };
    const registries = [
      createBuiltinPluginRegistry(reader, { ...pluginRegistryLimits }),
      createBuiltinPluginRegistry(reader, { maxAssetBytes: 1_000_000, maxTotalAssetBytes: 2_000_000, maxPathParts: 16, maxStringLength: 128 }),
      createBuiltinPluginRegistry(reader, undefined),
      createBuiltinPluginRegistry(reader, {})
    ];
    const defaults = { maxAssetBytes: 4_194_304, maxTotalAssetBytes: 33_554_432, maxPathParts: 32, maxPartLength: 255 };
    expect(seen).toEqual([
      defaults,
      { maxAssetBytes: 1_000_000, maxTotalAssetBytes: 2_000_000, maxPathParts: 16, maxPartLength: 128 },
      defaults,
      defaults
    ]);
    for (const registry of registries) expect(registry.registryDigest).toBe(builtinPluginRegistry().registryDigest);
    // A well-formed override below the largest asset reaches the real reader, which refuses it itself.
    const largest = Math.max(...installedBytes().map((entry) => entry.bytes.length));
    let refusal: unknown;
    try {
      createBuiltinPluginRegistry(undefined, { maxAssetBytes: largest - 1 });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PackagedAssetReadError);
    expect((refusal as PackagedAssetReadError).reason).toBe('too-large');
  });
});

describe('fail-closed composition boundaries', () => {
  const resolved = () => composeProjectPlugins(plan()).resolution;

  it('refuses a missing renderer binding, a missing workload binding and a mismatched workload', () => {
    const resolution = resolved();
    const failure = (action: () => unknown) => compositionFailure(action).issues.map((issue) => [issue.code, issue.subject]);
    expect(failure(() => boundRenderers(resolution, { ...builtinRendererBindings, cloud: {} })))
      .toEqual([['missing-renderer-binding', 'plugin:cloud:azure']]);
    expect(failure(() => boundRenderers(resolution, { ...builtinRendererBindings, stack: { 'python-fastapi': { genai: builtinRendererBindings.stack['python-fastapi'].genai } } })))
      .toEqual([['missing-renderer-binding', 'plugin:stack:python-fastapi']]);
    expect(failure(() => boundRenderers({ ...resolution, plugins: resolution.plugins.filter((entry) => entry.category !== 'workflow') })))
      .toEqual([['missing-renderer-binding', 'category:workflow']]);
    const renderers = boundRenderers(resolution);
    const genaiPlan = plan({ projectType: 'genai', pattern: 'rag', apiStack: undefined });
    expect(failure(() => renderers.renderGenAiStack(() => undefined, genaiPlan as never, {} as never)))
      .toEqual([['missing-renderer-binding', 'plugin:stack:python-fastapi']]);
    const genai = boundRenderers(composeProjectPlugins(genaiPlan).resolution);
    expect(failure(() => genai.renderStandardStack(() => undefined, plan() as never, {} as never)))
      .toEqual([['missing-renderer-binding', 'plugin:stack:python-fastapi']]);
  });

  it('refuses a selection whose semantic resolution depends on the host platform', () => {
    const real = builtinPluginRegistry();
    const hostDependent: PluginRegistry = {
      ...real,
      resolveSelection: (selection, host) => {
        const resolution = real.resolveSelection(selection, host);
        return host.platform === 'win32/x64' ? { ...resolution, artifacts: resolution.artifacts.slice(1) } : resolution;
      }
    };
    expect(compositionFailure(() => composeProjectPlugins(plan(), hostDependent)).issues).toEqual([{
      code: 'host-dependent-resolution',
      subject: 'selection',
      detail: 'the selection resolves differently across qualified host platforms'
    }]);
  });

  it('refuses a template asset identity that the registry holds no verified text for', () => {
    const real = builtinPluginRegistry();
    const incomplete: PluginRegistry = { ...real, assetsFor: () => ({ own: {}, shared: {} }) };
    expect(compositionFailure(() => templateAssetsFromRegistry(incomplete)).issues.map((issue) => [issue.code, issue.subject]))
      .toEqual([['missing-asset-text', 'asset:stack:node-fastify:node-backend-package-manifest']]);
    expect(templateAssetsFromRegistry(real)).toEqual(builtinTemplateAssets());
  });
});

describe('wired generation (buildArtifacts)', () => {
  const issueCodes = (error: unknown) => ((error as { issues?: { code: string }[] }).issues ?? []).map((issue) => issue.code);
  const thrown = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('expected generation to fail');
  };

  it('renders through the bound renderers in the unchanged order', () => {
    observed.calls.length = 0;
    buildArtifacts(plan({ specWorkflow: 'spec-kit' }));
    expect(observed.calls).toEqual(['context', 'render:base', 'render:spec-kit']);
  });

  it('rejects unknown, wrong-category, unsupported and mismatched selections before any renderer runs', () => {
    const standard = plan();
    const genai = plan({ projectType: 'genai', pattern: 'rag', apiStack: undefined });
    const node = plan({ apiStack: 'node-fastify' });
    const spec = plan({ specWorkflow: 'spec-kit' });
    const cases: Array<[ProjectPlan, string, string]> = [
      [{ ...standard, provider: { ...standard.provider, id: 'aws' } }, 'PluginRegistryError', 'unknown-plugin'],
      [{ ...standard, apiStack: { ...standard.apiStack, id: 'azure' as never } }, 'PluginRegistryError', 'wrong-category'],
      [{ ...genai, apiStack: node.apiStack }, 'PluginRegistryError', 'unsupported-combination'],
      [{ ...standard, framework: spec.framework }, 'PluginCompositionError', 'workflow-framework-mismatch']
    ];
    for (const [candidate, name, code] of cases) {
      observed.calls.length = 0;
      const error = thrown(() => buildArtifacts(candidate));
      expect([(error as Error).name, issueCodes(error)], code).toEqual([name, [code]]);
      expect(observed.calls.filter((call) => call.startsWith('render:')), code).toEqual([]);
    }
  });

  it('fails closed on a missing or altered packaged asset before the generator context or any renderer', async () => {
    for (const [mode, code] of [['drop-one', 'missing-asset'], ['flip-byte', 'digest-mismatch']] as const) {
      vi.resetModules();
      observed.fault.mode = mode;
      observed.calls.length = 0;
      const fresh = await import('../src/templates.js');
      const error = thrown(() => fresh.buildArtifacts(plan()));
      expect((error as Error).name, mode).toBe('PluginRegistryError');
      expect(issueCodes(error), mode).toContain(code);
      expect(observed.calls, mode).toEqual([]);
      // A failed build is never cached: the same module graph retries and succeeds once bytes are sound.
      observed.fault.mode = 'none';
      expect(fresh.buildArtifacts(plan()).length).toBe(buildArtifacts(plan()).length);
    }
  });

  it('returns failure from init with an owned runner: no destination, and today\'s lock and staging cleanup', async () => {
    vi.resetModules();
    observed.fault.mode = 'flip-byte';
    const { runCommand } = await import('../src/commands.js');
    const { parseArgs } = await import('../src/args.js');
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-plugin-init-'));
    const staging = await mkdtemp(path.join(os.tmpdir(), 'liftoff-plugin-staging-'));
    const previous = process.env.LIFTOFF_STAGING_ROOT;
    process.env.LIFTOFF_STAGING_ROOT = staging;
    try {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const runner = new ReadyInitRunner();
      const code = await runCommand(
        parseArgs(['init', 'claims-api', '--pattern', 'prompt', '--cloud', 'azure', '--region', 'eastus', '--spec', 'openspec', '--no-frontend', '--yes']),
        { cwd: parent, stdout, stderr, runner }
      );
      expect(code).toBe(1);
      expect(stderr.text()).toContain('Bundled plugin registry validation failed');
      expect(stderr.text()).toContain('digest-mismatch');
      expect(await readdir(parent)).toEqual([]);
      expect(await readdir(staging)).toEqual([]);
      expect(runner.calls.some((command) => command.executable === 'openspec' && command.args[0] === 'init')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LIFTOFF_STAGING_ROOT; else process.env.LIFTOFF_STAGING_ROOT = previous;
      await rm(parent, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  });
});
