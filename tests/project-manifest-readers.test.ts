import * as fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadManifest, loadProjectManifest, parseManifest, parseProjectManifest, validateGeneratedProject,
  SUPPORTED_MANIFEST_VERSIONS, SUPPORTED_PROJECT_MANIFEST_VERSIONS, manifestHadFilteredLegacyNonDurableOwnership
} from '../src/file-system.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { getCodingAgent } from '../src/application/project/catalog.js';
import * as installed from '../src/application/governance/modern-installed-preflight.js';
import { frameworkOutputPaths } from '../src/framework-validation.js';
import type { LiftoffManifestV8 } from '../src/domain/project/manifest/v8.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { writeModernInstalledProject, writeModernSuccessor } from './fixtures/modern-installed-project.js';
import { writeFixtureBytes } from './fixtures/activation-v3/fixture.js';
import { originalFiles } from './modern-openspec-fixtures.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const baseline = new URL('./fixtures/contract-baseline-0.12.3/manifests/', import.meta.url);
const roots: { path: string; dev: number; ino: number }[] = [];
const profiles = ['none', 'single-maintainer-gitflow', 'team-gitflow'] as const;
const workflows = ['manual', 'openspec', 'spec-kit'] as const;
async function root() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-manifest-readers-')));
  const owner = await fs.lstat(directory);
  roots.push({ path: directory, dev: owner.dev, ino: owner.ino });
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of roots.splice(0)) {
    const current = await fs.lstat(owner.path);
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    expect([current.dev, current.ino]).toEqual([owner.dev, owner.ino]);
    await fs.rm(owner.path, { recursive: true });
  }
});
async function markers(directory: string, manifest: LiftoffManifestV8) {
  if (manifest.framework.state !== 'initialized') return;
  const workflow = manifest.framework.adapter;
  for (const parts of frameworkOutputPaths({ workflow, agents: [...manifest.project.agents] })) {
    await writeFixtureBytes(directory, parts, 'Source-only marker fixture, not initializer provenance.\n');
  }
  if (workflow === 'spec-kit') {
    const ids = manifest.project.agents.map(agent => getCodingAgent(agent)!.integrationIds['spec-kit']);
    await writeFixtureBytes(directory, ['.specify', 'integration.json'], JSON.stringify({
      default_integration: getCodingAgent(manifest.project.defaultAgent!)!.integrationIds['spec-kit'],
      installed_integrations: ids
    }));
  }
}

describe('supported project manifest source boundary', () => {
  it.each(readdirSync(baseline).filter(name => name.endsWith('.json')).sort())('preserves frozen historical interpretation: %s', async name => {
    const bytes = readFileSync(new URL(name, baseline)), raw: unknown = JSON.parse(bytes.toString('utf8'));
    const before = JSON.stringify(raw), historical = parseManifest(raw), supported = parseProjectManifest(raw);
    expect(supported).toEqual(historical);
    if (supported.artifactVersion === 8) throw new Error('Expected a frozen historical source.');
    expect(manifestHadFilteredLegacyNonDurableOwnership(supported)).toBe(manifestHadFilteredLegacyNonDurableOwnership(historical));
    expect(JSON.stringify(raw)).toBe(before);
    const directory = await root();
    await fs.writeFile(path.join(directory, 'liftoff.manifest.json'), bytes);
    expect(await loadProjectManifest(directory)).toEqual(await loadManifest(directory));
    expect(await fs.readFile(path.join(directory, 'liftoff.manifest.json'))).toEqual(bytes);
  });

  it('keeps supported source versions separate from the historical API', async () => {
    expect(SUPPORTED_MANIFEST_VERSIONS).toEqual([2, 3, 4, 5, 6, 7]);
    expect(SUPPORTED_PROJECT_MANIFEST_VERSIONS).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(Object.isFrozen(SUPPORTED_PROJECT_MANIFEST_VERSIONS)).toBe(true);
    const f = await writeModernInstalledProject(await root());
    expect(parseProjectManifest(f.manifest)).toEqual(f.manifest);
    expect(() => parseManifest(f.manifest)).toThrow(/artifactVersion/);
    await expect(loadManifest(f.root)).rejects.toThrow(/artifactVersion/);
  });

  it.each([0, 1, 9, 99])('rejects unsupported version %s before inspecting any inner fields', version => {
    const access = vi.fn(() => { throw new Error('Must not inspect another family.'); });
    const raw = Object.defineProperty({ artifactVersion: version }, 'project', { enumerable: true, get: access });
    expect(() => parseProjectManifest(raw)).toThrow(/supported values are 2, 3, 4, 5, 6, 7, 8/);
    expect(access).not.toHaveBeenCalled();
  });

  it.each([null, [], '8', 8, {}, { artifactVersion: '8' }, { artifactVersion: 8.5 }, { artifactVersion: NaN }])(
    'does not coerce malformed source input %j', raw => {
      expect(() => parseProjectManifest(raw)).toThrow();
    }
  );

  it('rejects accessor, inherited, hidden and proxy version dispatch without invoking hooks', () => {
    const hook = vi.fn(() => 8);
    const accessor = Object.defineProperty({}, 'artifactVersion', { enumerable: true, get: hook });
    const inherited: unknown = Object.create({ artifactVersion: 8 });
    const hidden = Object.defineProperty({}, 'artifactVersion', { value: 8 });
    const proxy = new Proxy({ artifactVersion: 8 }, { getOwnPropertyDescriptor: () => {
      hook();
      return { enumerable: true, configurable: true, value: 8 };
    } });
    for (const raw of [accessor, inherited, hidden, proxy]) expect(() => parseProjectManifest(raw)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it('does not relabel a historical root as v8 or accept mixed modern identities', async () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('0.12.3-standard-go.json', baseline), 'utf8'));
    expect(() => parseProjectManifest({ ...parseManifest(raw), artifactVersion: 8 })).toThrow();
    const f = await writeModernInstalledProject(await root());
    expect(() => parseProjectManifest({ ...f.manifest, artifactVersion: 7 })).toThrow();
    expect(() => parseProjectManifest({ ...f.manifest, governance: { ...f.manifest.governance, policyVersion: 'future' } })).toThrow();
    expect(() => parseProjectManifest({ ...f.manifest, activeLayout: { schemaVersion: 1, state: 'bound',
      bindings: [{ kind: 'component', component: 'backend', pathParts: ['..', 'outside'] }] } })).toThrow();
  });
});

describe('public modern source validation', () => {
  it.each(profiles.flatMap(profile => workflows.map(workflow => ({ profile, workflow }))))(
    'validates $profile / $workflow through the actual CLI without execution or source writes', async ({ profile, workflow }) => {
      const f = await writeModernInstalledProject(await root(), workflow, profile);
      await markers(f.root, f.manifest);
      const before = await originalFiles(f.root), stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner();
      expect(await loadProjectManifest(f.root)).toEqual(f.manifest);
      const code = await runCommand(parseArgs(['validate', '--json', f.root]), { cwd: f.root, stdout, stderr, runner });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.text())).toEqual({ schemaVersion: 1, projectRoot: f.root, valid: true, issues: [] });
      expect(stderr.text()).toBe('');
      expect(runner.calls).toEqual([]);
      expect(await originalFiles(f.root)).toEqual(before);
    }
  );

  it.each([1, 2, 3] as const)('validates preserved history%s without reusing it as current execution proof', async version => {
    const f = await writeModernSuccessor(await root(), version);
    const manifest = f.plan.manifest.manifest;
    await markers(f.root, manifest);
    const before = await originalFiles(f.root);
    expect(await validateGeneratedProject(f.root)).toEqual([]);
    expect(await originalFiles(f.root)).toEqual(before);
    const observation = await installed.inspectModernInstalledActivation(f.root);
    expect(observation.status).toBe('observed');
    if (observation.status !== 'observed') throw new Error('Expected actual captured controls.');
    expect(observation.classification).toBe('successor');
    expect(observation.localPublication).toBe('codec-unavailable-not-authorized');
  });

  it.each(['managed-bytes', 'future-state', 'malformed-state', 'missing-framework'] as const)(
    'reports %s without changing project inputs', async fault => {
      const f = await writeModernInstalledProject(await root(), 'openspec');
      await markers(f.root, f.manifest);
      if (fault === 'managed-bytes') await f.write(f.manifest.managedArtifacts[0].pathParts, 'changed by the user\n');
      if (fault === 'future-state') await f.write(['governance', 'activation-state.json'], canonicalJson({ ...f.state, schemaVersion: 99 }));
      if (fault === 'malformed-state') await f.write(['governance', 'activation-state.json'], '{');
      if (fault === 'missing-framework') await fs.rm(path.join(f.root, ...frameworkOutputPaths({ workflow: 'openspec', agents: ['github-copilot'] })[0]));
      const before = await originalFiles(f.root), stdout = new CaptureStream(), runner = new ReadyInitRunner();
      expect(await runCommand(parseArgs(['validate', '--json', f.root]), { cwd: f.root, stdout, stderr: new CaptureStream(), runner })).toBe(1);
      expect(JSON.parse(stdout.text())).toMatchObject({ schemaVersion: 1, valid: false, issues: expect.arrayContaining([expect.any(String)]) });
      expect(runner.calls).toEqual([]);
      expect(await originalFiles(f.root)).toEqual(before);
    }
  );

  it('refuses a changed manifest between family selection and control capture', async () => {
    const f = await writeModernInstalledProject(await root()), inspect = installed.inspectModernInstalledActivation;
    vi.spyOn(installed, 'inspectModernInstalledActivation').mockImplementationOnce(async directory => {
      await f.write(['liftoff.manifest.json'], canonicalJson({ ...f.manifest, liftoffVersion: '0.13.1' }));
      return inspect(directory);
    });
    expect(await validateGeneratedProject(f.root)).toEqual([
      'The manifest changed during control validation; inspect the current project again.'
    ]);
  });

  it.each(['missing', 'invalid-json', 'future'] as const)('reports %s manifest without fallback to ordinary project handling', async fault => {
    const directory = await root();
    if (fault !== 'missing') await writeFixtureBytes(directory, ['liftoff.manifest.json'], fault === 'future' ? '{"artifactVersion":9}' : '{');
    const before = await originalFiles(directory);
    const inspector = vi.spyOn(installed, 'inspectModernInstalledActivation');
    expect(await validateGeneratedProject(directory)).toHaveLength(1);
    expect(await originalFiles(directory)).toEqual(before);
    await expect(loadProjectManifest(directory)).rejects.toThrow();
    expect(inspector).not.toHaveBeenCalled();
  });
});
