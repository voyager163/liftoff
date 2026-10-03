import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectTelemetryDimensions, type ProjectTelemetryDimensions } from '../src/application/project/telemetry.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { composeModernManifestPlugins } from '../src/application/project/plugins.js';
import { modernSourceRegistry } from '../src/application/project/modern-plugins.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import type { LiftoffManifestV8 } from '../src/domain/project/manifest/v8.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { toSafeProjectName } from '../src/domain/project/planning.js';
import type { GeneratedArtifact } from '../src/domain/project/contracts.js';
import type { ProjectTelemetryPolicy } from '../src/telemetry/contract.js';
import * as telemetryContract from '../src/telemetry/contract.js';

const profiles = ['none', 'single-maintainer-gitflow', 'team-gitflow'] as const;
const workflows = ['manual', 'openspec', 'spec-kit'] as const;
const registryDigest = 'sha256:790223d4fc3cfcfbf3a6e7cbc7a7889253fd67bcd94047d62ce5adcc339bc415';

function fixture(options: {
  profile?: (typeof profiles)[number];
  workflow?: (typeof workflows)[number];
  name?: string;
  apiStack?: string;
  agents?: string[];
  region?: string;
  frontend?: boolean;
  environments?: string[];
} = {}) {
  const profile = options.profile ?? 'none', workflow = options.workflow ?? 'manual';
  const agents = options.agents ?? (workflow === 'manual' ? [] : ['github-copilot']);
  const leaf = createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: {
      name: options.name ?? 'Telemetry source specimen',
      workload: {
        kind: 'standard', apiStack: options.apiStack ?? 'node-fastify', cloud: 'azure',
        region: options.region ?? 'eastus', frontend: options.frontend ?? false,
        environments: options.environments ?? ['dev']
      },
      specWorkflow: workflow, agents,
      ...(workflow === 'spec-kit' ? { defaultAgent: agents[0] } : {})
    },
    framework: workflow === 'manual' ? { state: 'not-required' } : {
      state: 'initialized', adapter: workflow, contractVersion: projectCatalog.getFrameworkDefinition(workflow).version
    }
  });
  const workload = leaf.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind, stack: workload.apiStack, cloud: workload.cloud, workflow, agents,
    frontend: workload.frontend ? 'included' : 'omitted', governanceProfile: profile,
    environments: workload.environments
  }, { safeProjectName: toSafeProjectName(leaf.project.name) });
  const source = modernActivationSourceContracts().find(({ identity }) =>
    identity.profile === profile && identity.workflow === workflow);
  const generatedArtifacts = composition.expected.filter((entry) => entry.lifecycle !== 'manifest')
    .map((entry): GeneratedArtifact => {
      // Supplied non-static bytes exercise the real metadata writer, not project generation or readiness.
      const content = entry.logicalName === 'repository-governance-policy' && source
        ? readFileSync(path.join(...source.policyPathParts), 'utf8')
        : entry.logicalName === 'repository-governance-phase-graph' && source
          ? canonicalJson(source.graph) : `Supplied specimen for ${entry.logicalName}\n`;
      const common = { logicalName: entry.logicalName, category: entry.category, pathParts: [...entry.pathParts], content };
      if (entry.lifecycle === 'project') {
        if (!entry.provisioningGroup) throw new Error('Expected a declared provisioning group.');
        return { ...common, lifecycle: 'project', provisioningGroup: entry.provisioningGroup };
      }
      return { ...common, lifecycle: entry.lifecycle };
    });
  return createManifestV8Candidate({ origin: 'fresh', selection: { ...leaf, profile }, generatedArtifacts });
}

describe('release-owned project telemetry dimensions', () => {
  it('exports metadata only, without identity, consent, storage or event authority', () => {
    expectTypeOf(projectTelemetryDimensions).parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf(projectTelemetryDimensions).returns.toEqualTypeOf<ProjectTelemetryDimensions>();
    expectTypeOf<keyof ProjectTelemetryDimensions>()
      .toEqualTypeOf<'policyProfile' | 'policyVersion' | 'templateSetDigest'>();
    expectTypeOf<ProjectTelemetryDimensions>().toExtend<Readonly<ProjectTelemetryPolicy>>();
  });

  it.each(profiles.flatMap((profile) => workflows.map((workflow) => ({ profile, workflow }))))(
    'resolves actual $profile/$workflow source contracts', ({ profile, workflow }) => {
      const candidate = fixture({ profile, workflow });
      const before = JSON.stringify(candidate);
      const dimensions = projectTelemetryDimensions(candidate.manifest);
      expect(dimensions).toEqual({
        policyProfile: profile,
        policyVersion: profile === 'none' ? 'none' : profile === 'single-maintainer-gitflow' ? 7 : 1,
        templateSetDigest: registryDigest
      });
      expect(Object.keys(dimensions).sort()).toEqual(['policyProfile', 'policyVersion', 'templateSetDigest']);
      expect(Object.isFrozen(dimensions)).toBe(true);
      expect(projectTelemetryDimensions(JSON.parse(candidate.content))).toEqual(dimensions);
      expect(JSON.stringify(candidate)).toBe(before);
    }
  );

  it('uses the validated whole registry, not the plugin-only or project-resolution digest', () => {
    const manifest = fixture().manifest;
    const registry = modernSourceRegistry();
    expect(projectTelemetryDimensions(manifest).templateSetDigest).toBe(registry.registryDigest);
    expect(registry.registryDigest).toBe(registryDigest);
    expect(registry.registryDigest).not.toBe(registry.pluginSetDigest);
    expect(registry.registryDigest).not.toBe(registry.coreContributionDigest);
    expect(registry.registryDigest).not.toBe(manifest.plugins.resolutionDigest);
  });

  it.each([
    { name: 'A distinct project name' },
    { apiStack: 'go-huma' },
    { apiStack: 'python-fastapi' },
    { workflow: 'openspec' as const },
    { workflow: 'spec-kit' as const, agents: ['claude', 'codex'] },
    { agents: ['github-copilot', 'claude', 'codex'] },
    { region: 'koreacentral' },
    { frontend: true },
    { environments: ['prod', 'staging', 'dev'] }
  ])('does not encode non-telemetry selections in the digest: %j', (options) => {
    const manifest = fixture(options).manifest;
    expect(projectTelemetryDimensions(manifest)).toEqual(projectTelemetryDimensions(fixture().manifest));
    expect(JSON.stringify(projectTelemetryDimensions(manifest))).not.toContain(manifest.project.name);
  });

  it('does not substitute the recorded scaffold version for the invoked CLI or invent a timestamp', () => {
    const manifest = JSON.parse(fixture().content);
    manifest.liftoffVersion = '0.0.1';
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      expect(projectTelemetryDimensions(manifest)).toEqual({
        policyProfile: 'none', policyVersion: 'none', templateSetDigest: registryDigest
      });
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      random.mockRestore();
    }
  });

  it('does not fingerprint preserved layouts or claim on-disk file verification', () => {
    const candidate = fixture();
    const manifest = JSON.parse(candidate.content);
    manifest.activeLayout = { schemaVersion: 1, state: 'bound', bindings: [
      { kind: 'component', component: 'backend', pathParts: ['Services', 'Custom API'] }
    ] };
    manifest.projectArtifacts = [];
    expect(projectTelemetryDimensions(manifest)).toEqual(projectTelemetryDimensions(candidate.manifest));
  });

  it.each([
    '0.3.4', '0.4.1', '0.7.0', '0.8.0', '0.9.9', '0.10.0', '0.11.3', '0.12.3'
  ])('does not infer a modern bundle from historical %s metadata', (version) => {
    const manifest = JSON.parse(readFileSync(path.join(
      'tests', 'fixtures', 'contract-baseline-0.12.3', 'manifests', `${version}-standard-go.json`
    ), 'utf8'));
    expect(() => projectTelemetryDimensions(manifest)).toThrow();
  });

  it.each([
    ['recorded digest', (manifest: LiftoffManifestV8) => {
      Reflect.set(manifest.plugins, 'resolutionDigest', `sha256:${'0'.repeat(64)}`);
    }],
    ['plugin content', (manifest: LiftoffManifestV8) => {
      Reflect.set(manifest.plugins.selections[0], 'contentVersion', manifest.plugins.selections[0].contentVersion + 1);
    }],
    ['unknown root property', (manifest: LiftoffManifestV8) => { Reflect.set(manifest, 'templateSetDigest', registryDigest); }],
    ['future schema', (manifest: LiftoffManifestV8) => { Reflect.set(manifest, 'artifactVersion', 9); }],
    ['arbitrary policy', (manifest: LiftoffManifestV8) => { Reflect.set(manifest.governance, 'profile', 'private-policy-name'); }],
    ['arbitrary policy version', (manifest: LiftoffManifestV8) => { Reflect.set(manifest.governance, 'policyVersion', 'private-value'); }],
    ['mismatched graph', (manifest: LiftoffManifestV8) => {
      if (manifest.governance.profile === 'none') throw new Error('Expected enabled governance specimen.');
      Reflect.set(manifest.governance.activationIdentity, 'phaseGraphHash', '0'.repeat(64));
    }]
  ] as const)('rejects %s before returning dimensions', (_name, change) => {
    const manifest = structuredClone(fixture({ profile: 'single-maintainer-gitflow' }).manifest);
    change(manifest);
    expect(() => projectTelemetryDimensions(manifest)).toThrow();
  });

  it('fails closed if the wire contract cannot represent an otherwise valid source policy', () => {
    const manifest = fixture({ profile: 'single-maintainer-gitflow' }).manifest;
    const policy = vi.spyOn(telemetryContract, 'parseProjectTelemetryPolicy').mockReturnValueOnce(undefined);
    try {
      expect(() => projectTelemetryDimensions(manifest)).toThrow('not supported by the project telemetry contract');
      expect(policy).toHaveBeenCalledExactlyOnceWith('single-maintainer-gitflow', 7);
    } finally {
      policy.mockRestore();
    }
  });

  it('rejects accessors without invoking them or accepting a caller-supplied digest', () => {
    const manifest = JSON.parse(fixture().content);
    const getter = vi.fn(() => registryDigest);
    Object.defineProperty(manifest, 'plugins', { enumerable: true, get: getter });
    expect(() => projectTelemetryDimensions(manifest)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
