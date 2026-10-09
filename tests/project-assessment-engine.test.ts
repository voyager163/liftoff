import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessProject, projectAssessmentProfile } from '../src/application/assessment/engine.js';
import { ApplicationFiles } from '../src/application/repair/application-files.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import { modernProjectSourceInput } from '../src/application/project/source-context.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import type { ProjectAssessmentReport } from '../src/domain/assessment/report.js';
import type { LiftoffManifestV8 } from '../src/domain/project/manifest/v8.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import { projectInventoryBounds } from '../src/application/assessment/inventory-types.js';

const roots: string[] = [];
const historicalManifests = new URL('./fixtures/contract-baseline-0.12.3/manifests/', import.meta.url);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'liftoff-assess-engine-'));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}
async function current(options: Partial<ProjectOptions> = {}) {
  const plan = buildCurrentProjectPlan({
    projectName: 'Assessment specimen', projectType: 'standard', apiStack: 'node', specWorkflow: 'manual',
    agents: [], governanceProfile: 'none', environments: ['dev'], ...options
  }, { requireProjectName: true });
  const artifacts = buildCurrentArtifacts(plan);
  const root = await fixture(Object.fromEntries(artifacts.map(artifact => [artifact.pathParts.join('/'), artifact.content])));
  const parsed = parseProjectManifest(JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')));
  if (parsed.artifactVersion !== 8) throw new Error('Expected actual current generated manifest.');
  return { root, manifest: parsed };
}
async function save(root: string, manifest: LiftoffManifestV8) {
  parseProjectManifest(manifest);
  await writeFile(path.join(root, 'liftoff.manifest.json'), JSON.stringify(manifest, null, 2));
}
const find = (report: ProjectAssessmentReport, id: string) => {
  const finding = report.findings.find(item => item.id === id);
  if (!finding) throw new Error(`Missing actual finding ${id}.`);
  return finding;
};

describe('bounded installed-target whole-project producer', () => {
  it.each(readdirSync(historicalManifests).filter(name => name.endsWith('.json')).sort())(
    'assesses frozen historical metadata without relabeling its provenance: %s', async name => {
      const bytes = await readFile(new URL(name, historicalManifests));
      const manifest = parseProjectManifest(JSON.parse(bytes.toString('utf8')));
      const root = await fixture({ 'liftoff.manifest.json': bytes.toString('utf8') });
      const report = await assessProject({ start: root, explicitRoot: true });
      expect(report).toMatchObject({ outcome: 'partial', exitCode: 2,
        project: { kind: 'liftoff', manifestVersion: manifest.artifactVersion },
        target: { manifestVersion: 8, selectedPlugins: null, layoutDescriptorDigest: null } });
      expect(find(report, 'project.manifest')).toMatchObject({
        classification: 'outdated', observed: { value: manifest.artifactVersion },
        remediation: { previewCommand: ['liftoff', 'update', '--project', root, '--check'] }
      });
      expect(find(report, 'layout.selection').classification).toBe('not-observed');
      expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(bytes);
    }
  );
  it.each(['node', 'python', 'go'] as const)('assesses a real generated Manual %s project without tools or manufactured completion', async apiStack => {
    const { root, manifest } = await current({ apiStack });
    const before = await readFile(path.join(root, 'liftoff.manifest.json'));
    const result = await assessProject({ start: root, explicitRoot: true });
    expect(result).toMatchObject({ command: 'assess', readOnly: true, outcome: 'partial', exitCode: 2,
      project: { kind: 'liftoff', manifestVersion: 8, recordedProfile: 'none' },
      target: { profile: 'none', profileSelection: 'recorded', selectedPlugins: { resolutionDigest: manifest.plugins.resolutionDigest } } });
    expect(find(result, 'project.manifest').classification).toBe('aligned');
    expect(find(result, 'workflow.marker').classification).toBe('inapplicable');
    expect(find(result, 'agents.behavior').classification).toBe('inapplicable');
    expect(find(result, 'references.compatibility').classification).toBe('not-observed');
    expect(find(result, 'runtime.declarations').classification).toBe('not-observed');
    expect(find(result, 'infrastructure.deployment').remediation).toMatchObject({ available: false, previewCommand: null });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(before);
    expect(await assessProject({ start: root, explicitRoot: true })).toEqual(result);
  });
  it.each(['single-maintainer-gitflow', 'team-gitflow', 'none'] as const)(
    'treats explicit %s comparison as advisory without changing project selection', async governance => {
      const { root, manifest } = await current();
      const before = await readFile(path.join(root, 'liftoff.manifest.json'));
      const result = await assessProject({ start: root, explicitRoot: true, governance });
      expect(result.target).toMatchObject({ profile: governance, profileSelection: 'explicit' });
      expect(result.project.recordedProfile).toBe(manifest.governance.profile);
      expect(find(result, 'project.profile').classification).toBe(governance === 'none' ? 'aligned' : 'conflicting');
      expect(find(result, 'project.profile').remediation.available).toBe(false);
      expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(before);
    }
  );
  it('preserves customized explicit bindings and original generation provenance without claiming reference equivalence', async () => {
    const { root, manifest } = await current();
    const originalHistory = manifest.projectArtifacts;
    const custom: LiftoffManifestV8 = {
      ...manifest,
      activeLayout: {
        schemaVersion: 1, state: 'bound',
        bindings: manifest.activeLayout.bindings.map(binding => ({
          ...binding, pathParts: binding.pathParts[0] === 'backend'
            ? ['services', 'custom api', ...binding.pathParts.slice(1)] : [...binding.pathParts]
        }))
      }
    };
    await mkdir(path.join(root, 'services', 'custom api'), { recursive: true });
    await writeFile(path.join(root, 'services', 'custom api', 'package.json'), '{"dependencies":{"fastify":"^5.12.5"}}');
    await save(root, custom);
    const report = await assessProject({ start: root, explicitRoot: true });
    expect(find(report, 'layout.component.backend')).toMatchObject({
      pathParts: ['services', 'custom api'], classification: 'aligned', observed: { value: 'directory' }
    });
    expect(find(report, 'references.compatibility').classification).toBe('not-observed');
    const observed = parseProjectManifest(JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')));
    if (observed.artifactVersion !== 8) throw new Error('Unexpected changed manifest.');
    expect(observed.projectArtifacts).toEqual(originalHistory);
    expect(observed.activeLayout).toEqual(custom.activeLayout);
  });
  it('keeps unresolved active bindings unknown even when canonical application folders exist', async () => {
    const { root, manifest } = await current();
    await save(root, { ...manifest, activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] } });
    const result = await assessProject({ start: root, explicitRoot: true });
    expect(find(result, 'layout.component.backend')).toMatchObject({ classification: 'not-observed', pathParts: null });
    expect(result.exitCode).toBe(2);
  });
  it('compares actual managed bytes and distinguishes absence from changed content without writes', async () => {
    const { root, manifest } = await current({ agents: ['copilot'] });
    const core = buildModernManagedCore(modernProjectSourceInput(manifest));
    expect(core.length).toBeGreaterThan(0);
    const artifact = core[0], target = path.join(root, ...artifact.pathParts);
    const before = await readFile(target);
    const aligned = await assessProject({ start: root, explicitRoot: true });
    expect(find(aligned, `managed.${artifact.logicalName}`).classification).toBe('aligned');
    await writeFile(target, 'changed-user-content');
    const changed = await assessProject({ start: root, explicitRoot: true });
    expect(find(changed, `managed.${artifact.logicalName}`)).toMatchObject({ classification: 'conflicting',
      remediation: { category: 'managed-update', available: true, previewCommand: ['liftoff', 'update', '--project', root, '--check'] } });
    expect(await readFile(target, 'utf8')).toBe('changed-user-content');
    await rm(target);
    expect(find(await assessProject({ start: root, explicitRoot: true }), `managed.${artifact.logicalName}`).classification).toBe('missing');
    expect(before.length).toBeGreaterThan(0);
  });
  it('keeps bounded managed-content failure unobserved rather than falsely absent or aligned', async () => {
    const { root, manifest } = await current({ agents: ['copilot'] });
    const artifact = buildModernManagedCore(modernProjectSourceInput(manifest))[0];
    const target = path.join(root, ...artifact.pathParts);
    await writeFile(target, 'x'.repeat(projectInventoryBounds.fileBytes + 1));
    const report = await assessProject({ start: root, explicitRoot: true });
    expect(report).toMatchObject({ outcome: 'partial', exitCode: 2 });
    expect(find(report, `managed.${artifact.logicalName}`)).toMatchObject({
      classification: 'not-observed', observed: { availability: 'not-observed', source: null }
    });
    expect(report.diagnostics.some(item => item.code === `managed-content-bound:${artifact.logicalName}`)).toBe(true);
    expect((await readFile(target)).length).toBe(projectInventoryBounds.fileBytes + 1);
  });
  it('reads exact managed metadata under the excluded control tree without opening state, credentials or telemetry', async () => {
    const { root, manifest } = await current({ governanceProfile: 'single-maintainer-gitflow' });
    const core = buildModernManagedCore(modernProjectSourceInput(manifest));
    await mkdir(path.join(root, '.liftoff'), { recursive: true });
    for (const name of ['activation-state.json', 'telemetry.json', 'credentials.json']) {
      await writeFile(path.join(root, '.liftoff', name), 'PRIVATE_CONTROL_PAYLOAD');
    }
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    const report = await assessProject({ start: root, explicitRoot: true });
    for (const artifact of core) expect(find(report, `managed.${artifact.logicalName}`).classification).toBe('aligned');
    const calls = read.mock.calls.map(([parts]) => parts.join('/'));
    expect(calls).not.toContain('.liftoff/activation-state.json');
    expect(calls).not.toContain('.liftoff/telemetry.json');
    expect(calls).not.toContain('.liftoff/credentials.json');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CONTROL_PAYLOAD');
    expect(find(report, 'governance.proof').classification).toBe('not-observed');
  });
  it('rejects a linked managed parent without opening neighboring payloads', async () => {
    const { root, manifest } = await current({ agents: ['copilot'] });
    const artifact = buildModernManagedCore(modernProjectSourceInput(manifest))
      .find(item => item.pathParts[0] === '.github');
    if (!artifact) throw new Error('Expected an actual selected GitHub integration.');
    const outside = await fixture({ 'credentials.json': 'PRIVATE_LINK_TARGET' });
    await rm(path.join(root, '.github'), { recursive: true });
    await symlink(outside, path.join(root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    await expect(assessProject({ start: root, explicitRoot: true })).rejects.toThrow(/unsafe link, junction/);
    expect(read.mock.calls.some(([parts]) => parts[0] === '.github')).toBe(false);
    expect(await readFile(path.join(outside, 'credentials.json'), 'utf8')).toBe('PRIVATE_LINK_TARGET');
  });
  it('preserves the exact readable historical-v8 family while comparing installed plugins separately', async () => {
    const baseline: { cases: { manifest: unknown }[] } = JSON.parse(await readFile(
      new URL('./fixtures/template-security-source-baseline.json', import.meta.url), 'utf8'
    ));
    const source = parseProjectManifest(baseline.cases[0].manifest);
    if (source.artifactVersion !== 8) throw new Error('Expected actual frozen v8 family.');
    const root = await fixture({
      'liftoff.manifest.json': JSON.stringify(source, null, 2),
      ...Object.fromEntries(buildModernManagedCore(modernProjectSourceInput(source)).map(artifact =>
        [artifact.pathParts.join('/'), artifact.content]))
    });
    const before = await readFile(path.join(root, 'liftoff.manifest.json'));
    const report = await assessProject({ start: root, explicitRoot: true });
    expect(find(report, 'plugins.selection')).toMatchObject({
      classification: 'outdated', observed: { value: source.plugins.resolutionDigest },
      remediation: { category: 'workflow-profile-migration', available: false, previewCommand: null }
    });
    expect(report.target?.selectedPlugins?.resolutionDigest).not.toBe(source.plugins.resolutionDigest);
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(before);
  });
  it('assesses explicit non-Git and ordinary Git roots without inventing workload selection or adoption authority', async () => {
    const root = await fixture({ 'package.json': '{"dependencies":{"fastify":"^5.12.5"}}', 'main.ts': 'throw NOT_EXECUTED' });
    const nonGit = await assessProject({ start: root, explicitRoot: true });
    expect(nonGit.project.kind).toBe('non-git');
    expect(nonGit.target?.selectedPlugins).toBeNull();
    expect(find(nonGit, 'project.manifest')).toMatchObject({ classification: 'missing',
      remediation: {
        category: 'adoption',
        available: true,
        previewCommand: ['liftoff', 'adopt', '--project', root, '--check', '--governance', 'single-maintainer-gitflow']
      } });
    await mkdir(path.join(root, '.git'));
    expect((await assessProject({ start: root, explicitRoot: false })).project.kind).toBe('git');
  });
  it('stops at malformed inner project metadata instead of falling through to an outer Git boundary', async () => {
    const root = await fixture({ 'inner/liftoff.manifest.json': '{"artifactVersion":99}' });
    await mkdir(path.join(root, '.git'));
    await expect(assessProject({ start: path.join(root, 'inner'), explicitRoot: false })).rejects.toThrow('Unsupported manifest');
  });
  it('does not follow a worktree pointer or nested project declarations', async () => {
    const root = await fixture({ '.git': 'gitdir: /unread/credentials', 'package.json': '{}',
      'nested/liftoff.manifest.json': 'malformed', 'nested/package.json': 'private malformed package' });
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    const report = await assessProject({ start: root, explicitRoot: false });
    expect(report.project.kind).toBe('git');
    expect(read.mock.calls.map(([parts]) => parts.join('/'))).not.toContain('.git');
    expect(read.mock.calls.some(([parts]) => parts[0] === 'nested')).toBe(false);
  });
  it('rejects linked roots and aliased inner markers before accessing an outer project', async () => {
    const root = await fixture({ 'real/liftoff.manifest.json': '{}' });
    await symlink(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assessProject({ start: path.join(root, 'alias'), explicitRoot: true })).rejects.toThrow('links or junctions');
    const alias = await fixture({ 'Liftoff.manifest.json': '{}' });
    await expect(assessProject({ start: alias, explicitRoot: true })).rejects.toThrow('aliased project boundary');
  });
  it('rejects an unsafe inner Git marker rather than selecting an outer manifest', async () => {
    const { root } = await current();
    const outside = await fixture();
    await mkdir(path.join(root, 'inner'));
    await symlink(outside, path.join(root, 'inner', '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assessProject({ start: path.join(root, 'inner'), explicitRoot: false })).rejects.toThrow('unsafe or aliased project boundary');
  });
  it('selects the nearest unchanged Liftoff boundary from a nested working directory', async () => {
    const { root } = await current();
    await mkdir(path.join(root, 'nested', 'working'), { recursive: true });
    expect((await assessProject({ start: path.join(root, 'nested', 'working'), explicitRoot: false })).project.root).toBe(root);
  });
  it('detects declaration drift between bounded passes instead of publishing an apparently current report', async () => {
    const { root } = await current({ agents: ['copilot'] });
    const original = ApplicationFiles.prototype.read;
    let changed = false;
    vi.spyOn(ApplicationFiles.prototype, 'read').mockImplementation(async function (this: ApplicationFiles, parts, limit) {
      if (!changed && parts[0] === '.github') {
        changed = true;
        await writeFile(path.join(root, 'backend', 'package.json'), '{"dependencies":{"other-package":"1.0.0"}}');
      }
      return original.call(this, parts, limit);
    });
    await expect(assessProject({ start: root, explicitRoot: true })).rejects.toThrow('inputs changed');
    expect(changed).toBe(true);
  });
  it('rejects a newly appeared inner boundary rather than publishing the originally selected outer project', async () => {
    const { root } = await current();
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    const original = ApplicationFiles.prototype.assertUnchanged;
    let changed = false;
    vi.spyOn(ApplicationFiles.prototype, 'assertUnchanged').mockImplementation(async function (this: ApplicationFiles) {
      if (!changed) {
        changed = true;
        await writeFile(path.join(nested, 'liftoff.manifest.json'), '{"artifactVersion":99}');
      }
      return original.call(this);
    });
    await expect(assessProject({ start: nested, explicitRoot: false })).rejects.toThrow(/changed/);
    expect(changed).toBe(true);
  });
  it('does not convert malformed dependencies or incomplete inventory into absence or alignment', async () => {
    const root = await fixture({ 'package.json': 'not JSON', 'main.ts': 'private application' });
    const report = await assessProject({ start: root, explicitRoot: true });
    expect(find(report, 'dependency.package.json')).toMatchObject({ classification: 'not-observed',
      observed: { availability: 'not-observed' } });
    expect(report).toMatchObject({ outcome: 'partial', exitCode: 2 });
    expect(report.diagnostics.some(item => item.code === 'incomplete-static-inventory')).toBe(true);
  });
  it('rejects unsupported comparison targets and live mode without effects', async () => {
    expect(() => projectAssessmentProfile('automatic-contributor-detection')).toThrow('comparison target');
    await expect(assessProject({ start: 'missing', explicitRoot: true, live: true })).rejects.toThrow('no network or credential access');
  });
});
