import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { assessProject } from '../src/application/assessment/engine.js';
import type { DoctorLayer } from '../src/application/diagnose/doctor.js';
import { parseProjectManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { createManifestV8Candidate } from '../src/application/project/manifest-writer.js';
import { matchesHistoricalModernPlugins, modernSourceRegistry } from '../src/application/project/modern-plugins.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { pluginSelectionForPlan } from '../src/application/project/plugins.js';
import { modernProjectSourceInput, resolveModernManifestSourceContext } from '../src/application/project/source-context.js';
import { projectTelemetryDimensions } from '../src/application/project/telemetry.js';
import { inspectApplicationLayout } from '../src/application/repair/application-patch.js';
import { previewModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import type { AssetDigest, PluginResolution, ResolvedPlugin } from '../src/plugins/contracts.js';
import { modernPreviousRelease } from '../src/plugins/builtin/modern-previous-release.js';
import { fixture, inventory, write } from './fixtures/manifest-update.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

interface FrozenFamily {
  sourceRevision: string;
  declarationsDigest: string;
  sharedAssets: AssetDigest[];
  plugins: ResolvedPlugin[];
  cases: { options: ProjectOptions; manifest: unknown; rawManifestSha256?: string; rawManifestBytes?: number }[];
}
const bytes = readFileSync(new URL('./fixtures/template-esbuild-source-baseline.json', import.meta.url));
const accepted: FrozenFamily = JSON.parse(bytes.toString('utf8'));
const original: FrozenFamily = JSON.parse(readFileSync(
  new URL('./fixtures/template-security-source-baseline.json', import.meta.url), 'utf8'
));
const families = [['pre-security', original], ['post-security', accepted]] as const;

function specimen(entry: FrozenFamily['cases'][number]) {
  const manifest = parseProjectManifest(entry.manifest);
  if (manifest.artifactVersion !== 8) throw new Error('Expected an actual frozen v8 manifest.');
  const plan = buildCurrentProjectPlan(entry.options, { requireProjectName: true });
  const target = modernSourceRegistry().resolveSelection(pluginSelectionForPlan(plan), { platform: 'linux/arm64' });
  return { manifest, target, input: modernProjectSourceInput(manifest) };
}

describe('content-only esbuild refresh preserves complete historical source families', () => {
  it('pins the actual captured accepted family and original manifest bytes', () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('5f9851f9fd5794ae81cad64b1c9556c84f2d80a42e79c2633cbc66a5f220bc43');
    expect(accepted.sourceRevision).toBe(modernPreviousRelease.sourceRevision);
    expect(accepted.declarationsDigest).toBe(modernPreviousRelease.declarationsDigest);
    expect(accepted.sharedAssets).toEqual(modernPreviousRelease.sharedAssets);
    expect(accepted.plugins).toEqual(modernPreviousRelease.plugins);
    expect(accepted.cases).toHaveLength(10);
    for (const entry of accepted.cases) {
      const raw = Buffer.from(JSON.stringify(entry.manifest, null, 2) + '\n');
      expect(raw.length).toBe(entry.rawManifestBytes);
      expect(createHash('sha256').update(raw).digest('hex')).toBe(entry.rawManifestSha256);
    }
  });

  for (const [name, family] of families) {
    it.each(family.cases.map((entry, index) => ({ ...entry, index })))(
      `retains exact ${name} source $index against the actual installed registry`, entry => {
        const before = canonicalJson(entry.manifest);
        const { manifest, target, input } = specimen(entry);
        expect(matchesHistoricalModernPlugins(manifest.plugins, target)).toBe(true);
        const source = resolveModernManifestV8SourceContract({ selection: input.selection, recordedPlugins: input.plugins });
        const shared = resolveModernManifestSourceContext(manifest);
        expect(shared.source).toEqual(source);
        expect(shared.plugins).toEqual(manifest.plugins);
        expect(shared.activeLayout).toEqual(manifest.activeLayout);
        expect(buildModernManagedCore(input).map(artifact => artifact.logicalName))
          .toEqual(source.managedArtifacts.map(artifact => artifact.logicalName));
        const maintained = createManifestV8Candidate({
          origin: 'maintenance', source: entry.manifest,
          managed: manifest.managedArtifacts.map(({ logicalName }) => ({ kind: 'retain', logicalName }))
        }).manifest;
        expect(maintained.plugins).toEqual(manifest.plugins);
        expect(maintained.projectArtifacts).toEqual(manifest.projectArtifacts);
        expect(maintained.activeLayout).toEqual(manifest.activeLayout);
        expect(canonicalJson(entry.manifest)).toBe(before);
      }
    );

    it.each(family.cases.map((entry, index) => ({ ...entry, index })))(
      `observes actual ${name} source $index through update, repair, doctor and assessment without changing it`, async entry => {
        const project = await fixture(), { manifest, input } = specimen(entry);
        await write(project.root, ['liftoff.manifest.json'], JSON.stringify(entry.manifest, null, 2) + '\n');
        for (const artifact of buildModernManagedCore(input)) await write(project.root, artifact.pathParts, artifact.content);
        await write(project.root, ['backend', 'package.json'], '{"private":true,"scripts":{"test":"node MUST-NOT-EXECUTE.js"}}\n');
        await write(project.root, ['backend', 'package-lock.json'], '{"customer":"preserve exactly"}\n');
        const before = await inventory(project.root);
        const preview = await previewModernSuccessorUpdate(project.root, input, project.options);
        expect(preview.scope).toBe('core-manifest-maintenance-only');
        expect(preview.plans.every(plan => plan.writeCount === 0)).toBe(true);
        const layout = await inspectApplicationLayout(project.root, manifest);
        expect(layout.report.target?.id).toBe('liftoff-active-application-artifacts-v1');
        expect(layout.report.target?.workload).toEqual(manifest.project.workload);
        const assessment = await assessProject({ start: project.root, explicitRoot: true });
        expect(assessment).toMatchObject({ outcome: 'partial', exitCode: 2, project: { kind: 'liftoff', manifestVersion: 8 } });
        if (manifest.plugins.selections.some(plugin => plugin.id === 'node-fastify')) {
          expect(assessment.findings).toContainEqual(expect.objectContaining({
            id: 'plugins.selection', classification: 'outdated',
            remediation: expect.objectContaining({ available: false, previewCommand: null })
          }));
          expect(() => projectTelemetryDimensions(manifest)).toThrow('Historical source plugin metadata');
        }
        const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner();
        await runCommand(parseArgs(['doctor', '--json']), {
          cwd: project.root, stdout, stderr, runner,
          stableReleaseLookup: async () => { throw new Error('offline fixture'); }
        });
        const doctor = JSON.parse(stdout.text()) as { layers: DoctorLayer[] };
        const projectChecks = doctor.layers.find(layer => layer.title === 'Project')?.checks;
        expect(projectChecks).toContainEqual(expect.objectContaining({
          label: 'manifest', severity: manifest.framework.state === 'initialized' ? 'fail' : 'ok'
        }));
        if (manifest.framework.state === 'initialized') {
          expect(projectChecks).toContainEqual(expect.objectContaining({
            id: 'framework-markers', severity: 'fail', state: 'unhealthy'
          }));
        }
        expect(doctor.layers.some(layer => layer.title === 'Runtime')).toBe(true);
        expect(runner.calls.some(command =>
          ['npm', 'node', 'docker', 'tofu', 'openspec', 'specify'].includes(command.executable) &&
          command.args.some(arg => ['ci', 'install', 'run', 'test', 'init', 'apply', 'plan'].includes(arg))
        )).toBe(false);
        expect(stderr.text()).toBe('');
        expect(await inventory(project.root)).toEqual(before);
        expect(JSON.parse(await readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'))).toEqual(entry.manifest);
      }
    );
  }

  it.each(['apiVersion', 'contentVersion', 'contentDigest', 'resolutionDigest'])(
    'refuses mutated recorded %s in either family', field => {
      for (const [, family] of families) {
        const { manifest, target, input } = specimen(family.cases[0]);
        const recorded = structuredClone(manifest.plugins);
        if (field === 'resolutionDigest') Reflect.set(recorded, field, `sha256:${'f'.repeat(64)}`);
        else Reflect.set(recorded.selections[0], field, field === 'contentDigest' ? `sha256:${'f'.repeat(64)}` : 99);
        expect(matchesHistoricalModernPlugins(recorded, target)).toBe(false);
        expect(() => resolveModernManifestV8SourceContract({ selection: input.selection, recordedPlugins: recorded })).toThrow();
      }
    }
  );

  it.each([
    ['environment', (target: PluginResolution) => Reflect.set(target.selection, 'environments', ['staging'])],
    ['frontend', (target: PluginResolution) => Reflect.set(target.selection, 'frontend', 'omitted')],
    ['artifact', (target: PluginResolution) => Reflect.set(target.artifacts[0], 'pathParts', ['changed'])],
    ['check', (target: PluginResolution) => Reflect.set(target, 'checks', [{ operation: 'foreign' }])],
    ['shared source', (target: PluginResolution) => Reflect.set(target.sharedAssets[0], 'sha256', `sha256:${'e'.repeat(64)}`)],
    ['plugin ID', (target: PluginResolution) => Reflect.set(target.plugins[0], 'id', 'foreign')],
    ['target API', (target: PluginResolution) => Reflect.set(target.plugins[0], 'apiVersion', 99)]
  ] as const)('refuses changed %s semantics rather than borrowing source authority', (_label, change) => {
    for (const [, family] of families) {
      const { manifest, target } = specimen(family.cases[0]);
      const changed = structuredClone(target);
      change(changed);
      expect(matchesHistoricalModernPlugins(manifest.plugins, changed)).toBe(false);
    }
  });

  it('normalizes a qualified host without retagging the source', () => {
    const { manifest, target } = specimen(accepted.cases[0]);
    const changed = structuredClone(target), before = canonicalJson(manifest);
    Reflect.set(changed, 'hostPlatform', 'win32/x64');
    expect(matchesHistoricalModernPlugins(manifest.plugins, changed)).toBe(true);
    expect(canonicalJson(manifest)).toBe(before);
  });

  it('binds the actual installed Node contribution to only the qualified asset refresh', () => {
    const registry = modernSourceRegistry();
    expect(registry.inventory.find(plugin => plugin.id === 'node-fastify')).toMatchObject({
      contentVersion: 3, contentDigest: 'sha256:2140749905f08e15db0e18c0b0b97ffd72a9f7fb30ae5469c7678822e1dcee7c'
    });
    const assets = registry.assetsFor({ kind: 'plugin', category: 'stack', id: 'node-fastify' });
    expect(JSON.parse(assets.own['node-backend-package-manifest']).overrides)
      .toEqual({ '@esbuild-kit/core-utils': { esbuild: '0.25.12' } });
    expect(JSON.parse(assets.own['node-backend-package-lock']).packages[
      'node_modules/@esbuild-kit/core-utils/node_modules/esbuild'
    ].version).toBe('0.25.12');
  });
});
