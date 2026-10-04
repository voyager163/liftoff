import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { loadProjectManifest, parseProjectManifest } from '../src/application/project/manifest.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import { inspectApplicationLayout } from '../src/application/repair/application-inventory.js';
import { inspectApplicationPatch, verifyApplicationPatch } from '../src/application/repair/application-patch.js';
import { buildRepairPreview } from '../src/application/repair/preview.js';
import type { ApplicationPatchDocument } from '../src/application/repair/application-types.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { repairRecipes } from '../src/domain/repair/identity.js';
import { NodeCommandRunner, type CommandRunner, type RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const now = new Date('2026-10-04T12:00:00Z');
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function put(root: string, parts: readonly string[], content: string) {
  const file = path.join(root, ...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(options: { custom?: boolean; governed?: boolean; failing?: boolean; agent?: boolean } = {}) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff current repair ')));
  roots.push(parent);
  const root = path.join(parent, 'project'), stage = path.join(parent, 'staged patch'), home = path.join(parent, 'home');
  await Promise.all([root, stage, home].map(directory => mkdir(directory)));
  const plan = buildCurrentProjectPlan({
    projectName: 'Current repair', projectType: 'standard', apiStack: 'node',
    specWorkflow: 'manual', agents: options.agent ? ['claude'] : [],
    governanceProfile: options.governed ? 'single-maintainer-gitflow' : 'none',
    includeFrontend: false, environments: ['dev']
  }, { requireProjectName: true });
  await writeArtifacts(root, buildCurrentArtifacts(plan));
  let manifest = await loadProjectManifest(root);
  if (manifest.artifactVersion !== 8) throw new Error('Expected current fixture.');
  const backend = options.custom ? ['services', 'business'] : ['backend'];
  if (options.custom) {
    await mkdir(path.join(root, 'services'));
    await rename(path.join(root, 'backend'), path.join(root, ...backend));
    const next = parseProjectManifest({
      ...manifest,
      activeLayout: { ...manifest.activeLayout, bindings: manifest.activeLayout.bindings.map(binding =>
        binding.pathParts[0] === 'backend'
          ? { ...binding, pathParts: [...backend, ...binding.pathParts.slice(1)] } : binding) }
    });
    if (next.artifactVersion !== 8) throw new Error('Expected current custom fixture.');
    manifest = next;
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const source = [...backend, 'package.json'], check = ['checks', 'repair.test.mjs'];
  const before = await readFile(path.join(root, ...source));
  const after = `${JSON.stringify({ ...JSON.parse(before.toString('utf8')), description: 'Reviewed customization' }, null, 2)}\n`;
  await put(root, check, [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    `test('checks actual staged project bytes', () => assert.equal(JSON.parse(readFileSync(${JSON.stringify(source.join('/'))}, 'utf8')).description, ${JSON.stringify(options.failing ? 'Incorrect expected value' : 'Reviewed customization')}));`,
    ''
  ].join('\n'));
  const inspection = await inspectApplicationLayout(root, manifest);
  expect(inspection.report.blockers).toEqual([]);
  const observed = inspection.report.files.find(file => file.pathParts.join('/') === source.join('/'))!;
  const target = inspection.report.target!.artifacts.find(artifact => artifact.pathParts.join('/') === source.join('/'))!;
  await put(stage, ['package.json'], after);
  const document: ApplicationPatchDocument = {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: root,
    inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target!.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [],
    mappings: [{
      sourcePathParts: source, targetPathParts: source, stagedPathParts: ['package.json'],
      expectedSourceDigest: observed.digest, expectedSourceMode: observed.mode, targetMode: observed.mode,
      role: 'application', targetIdentity: { kind: 'generated-artifact', logicalName: target.logicalName },
      customization: 'reviewed-edit',
      references: inspection.report.references.filter(reference => reference.sourcePathParts.join('/') === source.join('/'))
        .map(reference => ({ referenceId: reference.id, disposition: 'unchanged-reviewed', afterTargetPathParts: reference.targetPathParts }))
    }],
    verification: { commands: [{
      executable: 'node', args: ['--test', check.join('/')], cwdPathParts: [],
      timeoutMs: 30_000, maxOutputBytes: 16_384, network: false
    }] }
  };
  const patch = path.join(stage, 'patch.json');
  await writeFile(patch, `${JSON.stringify(document, null, 2)}\n`);
  return {
    root, stage, home, manifest, patch, document, source, before, after, target,
    controlsBefore: await Promise.all(manifest.managedArtifacts.map(async artifact => ({
      pathParts: artifact.pathParts, content: await readFile(path.join(root, ...artifact.pathParts))
    }))),
    manifestBefore: await readFile(path.join(root, 'liftoff.manifest.json')),
    configBefore: await readFile(path.join(root, 'liftoff.config.json'))
  };
}

class Runner implements CommandRunner {
  readonly calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];
  readonly native = new NodeCommandRunner();
  async run(command: ExternalCommand, options?: RunCommandOptions) {
    this.calls.push({ command, options });
    return this.native.run(command, options);
  }
}

async function run(project: Awaited<ReturnType<typeof fixture>>, args: string[], runner = new Runner()) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({
    argv: ['repair', project.root, ...args, '--json'],
    cwd: path.dirname(project.root), stdout, stderr, env: { ...process.env, LIFTOFF_TELEMETRY: '0' },
    execute: (parsed, context) => runCommand(parsed, {
      ...context, runner, updateNow: () => now, updatePreview: { homedir: project.home, env: {} }
    })
  });
  return { code, report: JSON.parse(stdout.text()), stderr: stderr.text(), runner };
}

async function unchanged(project: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(path.join(project.root, ...project.source))).toEqual(project.before);
  expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.manifestBefore);
  expect(await readFile(path.join(project.root, 'liftoff.config.json'))).toEqual(project.configBefore);
}

describe('current active-layout application repair', () => {
  it.each([false, true])('keeps bare/check/explicit inspection read-only with custom paths=%s', async custom => {
    const project = await fixture({ custom }), runner = new Runner();
    for (const args of [[], ['--check'], ['--inspect-layout']]) {
      const result = await run(project, args, runner);
      expect(result.code, JSON.stringify(result.report)).toBe(0);
      expect(result.report).toMatchObject({
        schemaVersion: 2, status: 'inspected', committed: false, requestedScope: 'application-layout',
        identity: { recipe: repairRecipes['application-active-layout-patch'] },
        application: { complete: true, target: { id: 'liftoff-active-application-artifacts-v1' } }
      });
      const observed = result.report.application.files.find((file: { pathParts: string[] }) =>
        file.pathParts.join('/') === project.source.join('/'));
      expect(observed).toMatchObject({
        currentTargetLogicalName: project.target.logicalName,
        provenance: { logicalName: project.target.logicalName, pathParts: ['backend', 'package.json'], identity: 'current-artifact' }
      });
      expect(result.report.nextActions.filter((action: { kind: string }) => action.kind === 'agent')).toEqual([]);
    }
    expect(runner.calls).toEqual([]);
    await unchanged(project);
    await expect(stat(path.join(project.root, '.liftoff', 'governance'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { custom: false, governed: false }, { custom: true, governed: false }, { custom: false, governed: true }
  ])('verifies staged behavior and commits only an approved in-place patch, custom=$custom, governed=$governed', async options => {
    const project = await fixture(options), runner = new Runner();
    const preview = await run(project, ['--check', '--application-patch', project.patch], runner);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    expect(preview.report).toMatchObject({
      status: 'available', identity: { recipe: repairRecipes['application-active-layout-patch'] }
    });
    const fingerprint = preview.report.fingerprint;
    expect((await run(project, ['--approve-plan', fingerprint], runner)).code).toBe(2);
    expect(runner.calls).toEqual([]);
    const verified = await run(project, ['--verify-plan', fingerprint], runner);
    expect(verified.code, JSON.stringify(verified.report)).toBe(0);
    expect(verified.report).toMatchObject({ status: 'verified', committed: false, verification: 'passed' });
    expect(runner.calls).toHaveLength(1);
    expect(path.relative(project.root, runner.calls[0].options!.cwd!).startsWith('..')).toBe(true);
    await unchanged(project);
    const applied = await run(project, ['--approve-plan', fingerprint], runner);
    expect(applied.code, JSON.stringify(applied.report)).toBe(0);
    expect(applied.report).toMatchObject({ status: 'applied', committed: true, repairScopeComplete: true });
    expect(runner.calls).toHaveLength(1);
    expect(await readFile(path.join(project.root, ...project.source), 'utf8')).toBe(project.after);
    expect(await readFile(path.join(project.root, 'liftoff.manifest.json'))).toEqual(project.manifestBefore);
    expect(await readFile(path.join(project.root, 'liftoff.config.json'))).toEqual(project.configBefore);
    if (!options.governed) {
      await expect(stat(path.join(project.root, '.liftoff', 'governance'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const control of project.controlsBefore) {
      expect(await readFile(path.join(project.root, ...control.pathParts))).toEqual(control.content);
    }
    await expect(stat(path.join(project.root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const history = JSON.parse(await readFile(path.join(applied.report.historyPath, 'receipt.json'), 'utf8'));
    expect(history).toMatchObject({ recipe: repairRecipes['application-active-layout-patch'], activationEvidence: 'not-issued' });
  }, 30_000);

  it('inspects an older current guide and updates only its approved managed content without activation', async () => {
    const project = await fixture({ agent: true }), runner = new Runner();
    const legacy = JSON.parse(await readFile(new URL('./fixtures/current-repair-legacy-guide.json', import.meta.url), 'utf8'));
    expect(createHash('sha256').update(legacy.artifact.content).digest('hex')).toBe(legacy.contentSha256);
    const guide = project.manifest.managedArtifacts.find(artifact => artifact.logicalName === legacy.artifact.logicalName)!;
    const expected = await readFile(path.join(project.root, ...guide.pathParts), 'utf8');
    expect(expected).toContain('`application-active-layout-patch` v1');
    expect(legacy.artifact.content).not.toContain('application-active-layout-patch');
    await put(project.root, guide.pathParts, legacy.artifact.content);
    const oldManifest = {
      ...project.manifest, managedArtifacts: project.manifest.managedArtifacts.map(artifact =>
        artifact.logicalName === guide.logicalName
          ? { ...artifact, contentHash: `sha256:${legacy.contentSha256}` } : artifact)
    };
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify(oldManifest));
    expect((await run(project, ['--inspect-layout'], runner)).code).toBe(0);
    async function update(args: string[]) {
      const stdout = new CaptureStream(), stderr = new CaptureStream();
      const code = await runCli({
        argv: ['update', project.root, ...args, '--json'], cwd: project.root,
        env: { LIFTOFF_TELEMETRY: '0' }, stdout, stderr,
        execute: (parsed, context) => runCommand(parsed, {
          ...context, runner, updateNow: () => now, updatePreview: { homedir: project.home, env: {} }
        })
      });
      return { code, report: JSON.parse(stdout.text()) };
    }
    const preview = await update(['--check']);
    expect(preview, JSON.stringify(preview)).toMatchObject({ code: 2, report: { status: 'update-available' } });
    expect(await readFile(path.join(project.root, ...guide.pathParts), 'utf8')).toBe(legacy.artifact.content);
    const applied = await update(['--approve-plan', preview.report.plans[0].fingerprint]);
    expect(applied, JSON.stringify(applied)).toMatchObject({ code: 0, report: {
      status: 'committed', publicationCommitted: true, localComplete: false
    } });
    expect(await readFile(path.join(project.root, ...guide.pathParts), 'utf8')).toBe(expected);
    const next = await loadProjectManifest(project.root);
    if (next.artifactVersion !== 8) throw new Error('Current guide maintenance must preserve manifest v8.');
    expect(next.projectArtifacts).toEqual(project.manifest.projectArtifacts);
    expect(next.activeLayout).toEqual(project.manifest.activeLayout);
    expect(next.governance).toEqual({ profile: 'none', state: 'disabled' });
    expect(await readFile(path.join(project.root, ...project.source))).toEqual(project.before);
    expect(await readFile(path.join(project.root, 'liftoff.config.json'))).toEqual(project.configBefore);
    await expect(stat(path.join(project.root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runner.calls).toEqual([]);
  });

  it('does not turn failing native checks into file authority', async () => {
    const project = await fixture({ failing: true }), runner = new Runner();
    const preview = await run(project, ['--check', '--application-patch', project.patch], runner);
    const verified = await run(project, ['--verify-plan', preview.report.fingerprint], runner);
    expect(verified.code).toBe(2);
    expect(verified.report).toMatchObject({ committed: false, verification: 'incomplete' });
    expect(runner.calls).toHaveLength(1);
    expect((await run(project, ['--approve-plan', preview.report.fingerprint], runner)).code).toBe(2);
    expect(runner.calls).toHaveLength(1);
    await unchanged(project);
  }, 30_000);

  it('refuses actively bound file moves without publishing or guessing a replacement binding', async () => {
    const project = await fixture({ custom: true });
    const moved = [...project.source.slice(0, -1), 'relocated-package.json'];
    project.document.mappings[0].targetPathParts = moved;
    project.document.mappings[0].targetIdentity.kind = 'custom-component';
    await writeFile(project.patch, JSON.stringify(project.document));
    const result = await run(project, ['--check', '--application-patch', project.patch]);
    expect(result.code).toBe(2);
    expect(result.report.blockers).toContainEqual(expect.stringContaining('separate reviewed binding publication'));
    expect(result.runner.calls).toEqual([]);
    await unchanged(project);
    await expect(stat(path.join(project.root, ...moved))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates the exact preview when active bindings change before verification', async () => {
    const project = await fixture(), runner = new Runner();
    const preview = await run(project, ['--check', '--application-patch', project.patch], runner);
    const changed = {
      ...project.manifest,
      activeLayout: { ...project.manifest.activeLayout, bindings: project.manifest.activeLayout.bindings.map(binding =>
        binding.kind === 'artifact' && binding.logicalName === 'root-readme'
          ? { ...binding, pathParts: ['OTHER.md'] } : binding) }
    };
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify(changed));
    const result = await run(project, ['--verify-plan', preview.report.fingerprint], runner);
    expect(result.code).not.toBe(0);
    expect(result.report.committed).toBe(false);
    expect(runner.calls).toEqual([]);
    expect(await readFile(path.join(project.root, ...project.source))).toEqual(project.before);
    expect(JSON.parse(await readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'))).toEqual(changed);
  });

  it('does not retag a historical application preview as a current repair', async () => {
    const project = await fixture(), runner = new Runner();
    const candidate = await inspectApplicationPatch(project.root, project.manifest, project.patch);
    expect(candidate.blockers).toEqual([]);
    const preview = buildRepairPreview({
      projectRoot: project.root, recipe: 'application-layout-patch', applicationPatchPath: project.patch,
      snapshots: candidate.snapshots, mutations: candidate.mutations, scope: candidate.scope,
      verificationPolicy: candidate.verificationPolicy, live: false, now
    });
    const storage = { homedir: project.home, env: {}, clock: () => now };
    await createScopedUserLocalRecordStore(project.root, 'repair-preview', storage).write(preview.fingerprint, preview);
    const dispatched = await run(project, ['--verify-plan', preview.fingerprint], runner);
    expect(dispatched.code).toBe(1);
    expect(dispatched.report.blockers).toContainEqual(expect.stringContaining('exact reviewed recipe'));
    const direct = await verifyApplicationPatch(project.root, candidate, runner, {
      preview, storage, assertCurrent: async () => {}, allowProjectCode: true,
      allowDependencyPreparation: false, allowNetwork: false
    });
    expect(direct.status).toBe('blocked');
    expect(direct.blockers).toContainEqual(expect.stringContaining('[stale-preview]'));
    expect(runner.calls).toEqual([]);
    await unchanged(project);
  });

  it('keeps enabled governance records outside repair and does not infer completion', async () => {
    const project = await fixture({ governed: true });
    const result = await run(project, ['--inspect-layout']);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
    expect(result.report.repairScopeComplete).toBe(false);
    expect(result.report.application.files.some((file: { pathParts: string[] }) => file.pathParts[0] === '.liftoff')).toBe(false);
    expect(result.runner.calls).toEqual([]);
    await unchanged(project);
  });

  it('excludes custom infrastructure-bound directories without reading their payloads', async () => {
    const project = await fixture();
    const bindings = project.manifest.activeLayout.bindings.filter(binding =>
      !(binding.kind === 'artifact' && binding.pathParts.includes('application') && binding.pathParts[0] === 'infrastructure'));
    const changed = parseProjectManifest({
      ...project.manifest,
      activeLayout: { ...project.manifest.activeLayout, bindings: bindings.map(binding =>
        binding.kind === 'component' && binding.component === 'opentofu-application'
          ? { ...binding, pathParts: ['operations'] } : binding) }
    });
    await put(project.root, ['operations', 'unread.txt'], 'private custom infrastructure input\n');
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify(changed));
    const result = await run(project, ['--inspect-layout']);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
    expect(result.report.application.exclusions).toContainEqual({
      pathParts: ['operations'], kind: 'directory', reason: 'excluded-current-control-or-infrastructure-binding'
    });
    expect(JSON.stringify(result.report)).not.toContain('private custom infrastructure input');
    expect(result.report.application.files.some((file: { pathParts: string[] }) => file.pathParts[0] === 'operations')).toBe(false);
    expect(result.runner.calls).toEqual([]);
  });

  it('does not substitute generation paths for unresolved active layout', async () => {
    const project = await fixture();
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify({
      ...project.manifest, activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] }
    }));
    const result = await run(project, ['--check']);
    expect(result.code).toBe(2);
    expect(result.report.application.files).toEqual([]);
    expect(result.report.blockers).toContainEqual(expect.stringContaining('requires explicit active bindings'));
    expect(result.runner.calls).toEqual([]);
  });

  it('does not infer artifact targets from component-only bindings', async () => {
    const project = await fixture();
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify({
      ...project.manifest, activeLayout: {
        ...project.manifest.activeLayout, bindings: project.manifest.activeLayout.bindings.filter(binding => binding.kind === 'component')
      }
    }));
    const result = await run(project, ['--check']);
    expect(result.code).toBe(2);
    expect(result.report.application.target).toBeNull();
    expect(result.report.blockers).toContainEqual(expect.stringContaining('No editable application artifacts have explicit active bindings'));
    expect(result.runner.calls).toEqual([]);
    expect(await readFile(path.join(project.root, ...project.source))).toEqual(project.before);
  });

  it('does not invent a component root when only artifact paths are bound', async () => {
    const project = await fixture();
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify({
      ...project.manifest, activeLayout: {
        ...project.manifest.activeLayout, bindings: project.manifest.activeLayout.bindings.filter(binding => binding.kind === 'artifact')
      }
    }));
    const result = await run(project, ['--check']);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
    expect(result.report.application.target.artifacts.find((artifact: { logicalName: string }) =>
      artifact.logicalName === project.target.logicalName)).toMatchObject({
      component: 'backend', pathParts: project.source, componentRootPathParts: []
    });
    expect(result.runner.calls).toEqual([]);
    expect(await readFile(path.join(project.root, ...project.source))).toEqual(project.before);
  });

  it('refuses current infrastructure discovery instead of ignoring its explicit scope', async () => {
    const project = await fixture();
    const result = await run(project, ['--check', '--live', '--subscription', '00000000-0000-4000-8000-000000000001']);
    expect(result.code).toBe(2);
    expect(result.report.message).toContain('not available');
    expect(result.runner.calls).toEqual([]);
    await unchanged(project);
  });

  it.each(['future', 'malformed'])('refuses %s current sources before command dispatch', async kind => {
    const project = await fixture();
    const changed = kind === 'future' ? { ...project.manifest, artifactVersion: 9 } :
      { ...project.manifest, activeLayout: { ...project.manifest.activeLayout, unexpected: true } };
    await writeFile(path.join(project.root, 'liftoff.manifest.json'), JSON.stringify(changed));
    const result = await run(project, ['--inspect-layout']);
    expect(result.code).toBe(1);
    expect(result.report.committed).toBe(false);
    expect(result.runner.calls).toEqual([]);
    expect(canonicalSha256(JSON.parse(await readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'))))
      .toBe(canonicalSha256(changed));
  });
});
