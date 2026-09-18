import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { CaptureStream } from './helpers.js';
import { liftoffVersion } from '../src/version.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff public assessment ')));
  roots.push(parent);
  const project = path.join(parent, 'existing project');
  const component = path.join(project, 'frontend');
  const sibling = path.join(project, 'other-component');
  await mkdir(component, { recursive: true });
  await mkdir(sibling);
  await writeFile(path.join(component, 'package.json'), JSON.stringify({
    name: 'existing-vue', dependencies: { vue: '^3.5.0' }
  }));
  await writeFile(path.join(component, 'App.vue'), '<template><div>Original view</div></template>\n');
  await writeFile(path.join(sibling, 'private-business.txt'), 'Sibling data must not enter the selected component report.\n');
  return { parent, project, component, sibling };
}

async function invoke(source: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const hooks: CliTelemetryHooks = {
    beforeCommand: vi.fn<CliTelemetryHooks['beforeCommand']>().mockResolvedValue(true),
    afterCommand: vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined)
  };
  const code = await runCli({
    argv: args, cwd: source.parent, stdout, stderr, env: {}, telemetry: hooks
  });
  expect(hooks.beforeCommand).not.toHaveBeenCalled();
  expect(hooks.afterCommand).not.toHaveBeenCalled();
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('public read-only project assessment', () => {
  it('confines a selected component and retains the invocation-relative public input binding', async () => {
    const source = await fixture();
    const config = path.join(source.parent, 'public inputs.json');
    const bytes = '{"schemaVersion":1,"phases":{}}\n';
    await writeFile(config, bytes);
    const before = await readdir(source.project, { recursive: true });
    const result = await invoke(source, [
      'assess', 'existing project', '--component', 'frontend', '--profile', 'vue-component',
      '--inputs', 'public inputs.json', '--json'
    ]);
    expect(result.code, result.stderr || result.stdout).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1, command: 'assess',
      cliVersion: liftoffVersion, capabilityProtocolSchemaVersion: 1,
      target: { scanRoot: source.component, hasGit: false, hasManifest: false },
      capturedInputs: { reference: config }
    });
    expect(report.capturedInputs.digest.replace(/^sha256:/, ''))
      .toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(report.inventory.files.map((file: { path: string }) => file.path).sort())
      .toEqual(['App.vue', 'package.json']);
    expect(result.stdout).not.toContain('Sibling data must not enter');
    expect(result.stdout).not.toContain('Original view');
    expect(report.recommendations).toEqual(expect.arrayContaining([expect.objectContaining({
      capabilityId: 'project-adoption', status: 'blocked', executable: null, args: [],
      inputs: { reference: config, digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }
    })]));
    expect(report.recommendations.every((entry: { continuation?: unknown }) => entry.continuation === undefined)).toBe(true);
    expect(await readdir(source.project, { recursive: true })).toEqual(before);
    expect(await readFile(config, 'utf8')).toBe(bytes);
  });

  it.each([
    { artifactVersion: 8 },
    { artifactVersion: 4, project: { workload: { kind: 'power-apps-code-app' } } }
  ])('rejects a malformed or retired inner manifest before claiming an ordinary project: %j', async (manifest) => {
    const source = await fixture();
    const manifestPath = path.join(source.component, 'liftoff.manifest.json');
    const bytes = JSON.stringify(manifest);
    await writeFile(manifestPath, bytes);
    const result = await invoke(source, ['assess', source.component, '--json']);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.outcome).toBe('error');
    expect(report.target.hasManifest).not.toBe(false);
    expect(report.inventory.files).toEqual([]);
    expect(await readFile(manifestPath, 'utf8')).toBe(bytes);
  });

  it('refuses a linked manifest instead of reading or replacing its external target', async () => {
    const source = await fixture();
    const external = path.join(source.parent, 'external-manifest.json');
    await writeFile(external, '{"artifactVersion":8}');
    await symlink(external, path.join(source.component, 'liftoff.manifest.json'));
    const result = await invoke(source, ['assess', source.component, '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).outcome).toBe('error');
    expect(await readFile(external, 'utf8')).toBe('{"artifactVersion":8}');
  });
});
