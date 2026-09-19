import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/cli/commands/dispatch.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const clock = new Date('2026-09-14T16:00:00Z');

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const parent = path.resolve('tests', `.public-adoption-${randomUUID()}`);
  roots.push(parent);
  const project = path.join(parent, 'existing Vue');
  const home = path.join(parent, 'isolated home');
  await mkdir(project, { recursive: true });
  await mkdir(home);
  const source = '<template><main>Existing customer dashboard</main></template>\n';
  const manifest = JSON.stringify({
    name: 'existing-vue', private: true, type: 'module', dependencies: { vue: '^3.5.0' }
  });
  await writeFile(path.join(project, 'package.json'), manifest);
  await writeFile(path.join(project, 'App.vue'), source);
  return { parent, project, home, source, manifest };
}

async function invoke(source: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({
    argv: args, cwd: source.parent, stdout, stderr, env: { LIFTOFF_TELEMETRY: '0' },
    execute: (parsed, context) => runCommand(parsed, {
      ...context,
      updateNow: () => clock,
      updatePreview: { homedir: source.home, env: {}, repositoryRoot: source.project }
    })
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('public adoption command wiring', () => {
  it('previews the explicit existing component without creating Git or project metadata', async () => {
    const source = await fixture();
    const preview = await invoke(source, [
      'adopt', 'existing Vue', '--profile', 'vue-component', '--check', '--json'
    ]);
    expect(preview.code).toBe(2);
    const report = JSON.parse(preview.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1, command: 'adopt', status: 'planned', committed: false,
      projectRoot: source.project, plan: { component: { profile: { id: 'vue-component' } } }
    });
    expect(await readdir(source.project)).toEqual(['App.vue', 'package.json']);
    expect(await readFile(path.join(source.project, 'App.vue'), 'utf8')).toBe(source.source);
    expect(preview.stdout).not.toContain('Existing customer dashboard');
  });

  it('commits only reviewed metadata with truthful component provenance and unchanged business files', async () => {
    const source = await fixture();
    const preview = await invoke(source, [
      'adopt', source.project, '--profile', 'vue-component', '--check', '--json'
    ]);
    expect(preview.code).toBe(2);
    const fingerprint = JSON.parse(preview.stdout).plan.fingerprint;
    const applied = await invoke(source, [
      'adopt', '--project', source.project, '--approve-plan', fingerprint, '--json'
    ]);
    expect(applied.code, applied.stderr || applied.stdout).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ command: 'adopt', committed: true, complete: true });
    const manifest = await loadManifest(source.project);
    expect(manifest.artifactVersion).toBe(8);
    expect(manifest.project.workload).toEqual({ kind: 'components' });
    for (const artifact of manifest.projectArtifacts) {
      expect(artifact).not.toHaveProperty('generationHash');
      expect(artifact).not.toHaveProperty('generatedBy');
    }
    expect(await readFile(path.join(source.project, 'package.json'), 'utf8')).toBe(source.manifest);
    expect(await readFile(path.join(source.project, 'App.vue'), 'utf8')).toBe(source.source);
    expect(await readdir(source.project)).not.toContain('.git');
  });

  it('rejects stale machine approval without overwriting changed source or fabricating a manifest', async () => {
    const source = await fixture();
    const preview = await invoke(source, [
      'adopt', source.project, '--profile', 'vue-component', '--check', '--json'
    ]);
    expect(preview.code).toBe(2);
    const fingerprint = JSON.parse(preview.stdout).plan.fingerprint;
    const edited = '<template><main>Newer user work</main></template>\n';
    await writeFile(path.join(source.project, 'App.vue'), edited);
    const applied = await invoke(source, [
      'adopt', source.project, '--approve-plan', fingerprint, '--json'
    ]);
    expect(applied.code).toBe(1);
    expect(JSON.parse(applied.stdout).committed).toBe(false);
    expect(await readFile(path.join(source.project, 'App.vue'), 'utf8')).toBe(edited);
    expect(await readdir(source.project)).not.toContain('liftoff.manifest.json');
  });

  it('does not mistake a Go string literal and unused dependency for an observed Huma application', async () => {
    const source = await fixture();
    const component = path.join(source.project, 'tool');
    await mkdir(component);
    await writeFile(path.join(component, 'go.mod'),
      'module example.test/tool\n\ngo 1.26.0\n\nrequire github.com/danielgtaylor/huma/v2 v2.34.1\n');
    const code = 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("github.com/danielgtaylor/huma/v2") }\n';
    await writeFile(path.join(component, 'main.go'), code);
    const before = await readdir(source.project, { recursive: true });
    const preview = await invoke(source, [
      'adopt', source.project, '--component', 'tool', '--profile', 'go-huma', '--check', '--json'
    ]);
    expect(preview.code, preview.stderr || preview.stdout).toBe(2);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      schemaVersion: 1, command: 'adopt', status: 'blocked', committed: false
    });
    expect(await readdir(source.project, { recursive: true })).toEqual(before);
    expect(await readFile(path.join(component, 'main.go'), 'utf8')).toBe(code);
  });

  it.each([false, true])('requires real non-test Go application usage rather than a Huma marker (test-only: %s)', async (testOnly) => {
    const source = await fixture();
    const component = path.join(source.project, 'api');
    const plan = buildProjectPlan({
      projectName: 'Existing API', projectType: 'standard', apiStack: 'go',
      agents: ['copilot'], environments: ['dev'], governanceProfile: 'none'
    }, { requireProjectName: true });
    for (const artifact of buildArtifacts(plan).filter((entry) => entry.pathParts[0] === 'backend' &&
      (entry.pathParts.at(-1)!.endsWith('.go') || ['go.mod', 'go.sum'].includes(entry.pathParts.at(-1)!)))) {
      const relative = artifact.pathParts.slice(1);
      if (testOnly && relative.at(-1)!.endsWith('.go') && !relative.at(-1)!.endsWith('_test.go')) {
        relative[relative.length - 1] = relative.at(-1)!.replace(/\.go$/u, '_test.go');
      }
      const destination = path.join(component, ...relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, artifact.content);
    }
    const before = await readdir(source.project, { recursive: true });
    const preview = await invoke(source, [
      'adopt', source.project, '--component', 'api', '--profile', 'go-huma', '--check', '--json'
    ]);
    expect(preview.code, preview.stderr || preview.stdout).toBe(2);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      schemaVersion: 1, command: 'adopt', status: testOnly ? 'blocked' : 'planned', committed: false
    });
    expect(await readdir(source.project, { recursive: true })).toEqual(before);
  });
});
