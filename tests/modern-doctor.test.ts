import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import type { DoctorLayer } from '../src/application/diagnose/doctor.js';
import * as historicalGovernance from '../src/governance-activation/doctor.js';
import * as historicalUpdate from '../src/application/update/inspection.js';
import * as localInputs from '../src/application/governance/modern-local-inputs.js';
import { selectWorkstationRequirements, type WorkstationRequirementSelection } from '../src/workstation.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { createOpenSpecExecutionFixture, originalFiles } from './modern-openspec-fixtures.js';
import { writeModernInstalledProject } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
const roots: { path: string; dev: number; ino: number }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of roots.splice(0)) {
    const current = await fs.lstat(owner.path);
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    expect([current.dev, current.ino]).toEqual([owner.dev, owner.ino]);
    await fs.rm(owner.path, { recursive: true });
  }
});
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modern-doctor-')));
  const owner = await fs.lstat(root);
  roots.push({ path: root, dev: owner.dev, ino: owner.ino });
  return root;
}
async function run(root: string) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner();
  const code = await runCommand(parseArgs(['doctor', '--json']), {
    cwd: root, stdout, stderr, runner, stableReleaseLookup: async () => { throw new Error('offline fixture'); }
  });
  const report = JSON.parse(stdout.text()) as { schemaVersion: number; layers: DoctorLayer[]; summary: { failures: number; warnings: number } };
  expect(report.schemaVersion).toBe(1);
  expect(stderr.text()).toBe('');
  expect(runner.calls.some(command =>
    command.executable === 'node' && command.args.includes('-e') ||
    command.executable === 'docker' && command.args.includes('compose') ||
    command.executable === 'tofu' && command.args.some(arg => ['init', 'fmt', 'validate', 'plan', 'apply'].includes(arg)) ||
    command.executable === 'npm' && command.args.some(arg => ['run', 'test', 'ci', 'install'].includes(arg))
  )).toBe(false);
  return { code, report, runner, output: stdout.text() };
}
function checks(report: { layers: DoctorLayer[] }, title: string) {
  const layer = report.layers.find(candidate => candidate.title === title);
  if (!layer) throw new Error(`Missing ${title} doctor layer.`);
  return layer.checks;
}

describe('modern public doctor source interpretation', () => {
  it.each(['none', 'single-maintainer-gitflow', 'team-gitflow'] as const)(
    'observes actual bound %s source without historical graph routing or workload execution', async profile => {
      const f = await createOpenSpecExecutionFixture(roots, profile), before = await originalFiles(f.root);
      const oldGovernance = vi.spyOn(historicalGovernance, 'governanceDoctorChecks');
      const oldUpdate = vi.spyOn(historicalUpdate, 'inspectProjectUpdate');
      const result = await run(f.root);
      expect(result.code, JSON.stringify(result.report)).toBe(0);
      expect(result.output).not.toContain('@msn-control/liftoff@0.13.0-dev.0');
      expect(checks(result.report, 'Project')).toContainEqual(expect.objectContaining({
        label: 'version', remedy: expect.stringContaining('not a verified available installation target')
      }));
      expect(checks(result.report, 'Project')).toContainEqual(expect.objectContaining({ label: 'manifest', severity: 'ok' }));
      expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({
        id: 'project-inputs', state: 'observed', detail: expect.stringContaining('source inventory, not workload verification')
      }));
      expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({
        id: 'local-verification', severity: 'skipped', state: 'not-executed'
      }));
      expect(oldGovernance).not.toHaveBeenCalled();
      expect(oldUpdate).not.toHaveBeenCalled();
      expect(await originalFiles(f.root)).toEqual(before);
    }
  );

  it('keeps selected Manual agents in the actual doctor prerequisite scope', async () => {
    const f = await writeModernInstalledProject(await directory(), 'manual', 'none', { agents: ['claude'] });
    const before = await originalFiles(f.root), result = await run(f.root);
    expect(checks(result.report, 'Environment').map(check => check.id)).toContain('claude');
    expect(result.runner.calls.some(command => command.executable === 'claude' && command.args.includes('--version'))).toBe(true);
    expect(result.runner.calls.some(command => ['openspec', 'specify', 'uv', 'python', 'python3'].includes(command.executable))).toBe(false);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it.each(['manual', 'spec-kit'] as const)('successfully diagnoses bound %s source while leaving native verification unexecuted', async workflow => {
    const compose = ['Local deployment', 'compose.yml'];
    const f = await writeModernInstalledProject(await directory(), workflow, 'none', {
      ...(workflow === 'spec-kit' ? { frameworkVersion: projectCatalog.getFrameworkDefinition(workflow).version } : {}),
      activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
        { kind: 'component', component: 'backend', pathParts: ['Application source'] },
        { kind: 'component', component: 'database', pathParts: ['Database source'] },
        { kind: 'component', component: 'opentofu-application', pathParts: ['Infrastructure source', 'shared'] },
        { kind: 'component', component: 'opentofu-environment:dev', pathParts: ['Infrastructure source', 'dev'] },
        { kind: 'artifact', logicalName: 'docker-compose', pathParts: compose }
      ] }
    });
    const components = new Map(f.manifest.activeLayout.bindings.flatMap(binding =>
      binding.kind === 'component' ? [[binding.component, [...binding.pathParts]] as const] : []));
    await writeModernLocalFixtureInputs(f.input.selection, components, compose, f.write);
    const before = await originalFiles(f.root), result = await run(f.root);
    expect(result.code, JSON.stringify(result.report)).toBe(0);
    expect(checks(result.report, 'Project')).toContainEqual(expect.objectContaining({
      id: workflow === 'manual' ? 'framework-not-required' : 'framework-markers', severity: 'ok'
    }));
    expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'project-inputs', state: 'observed' }));
    expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'local-verification', state: 'not-executed' }));
    expect(result.runner.calls.some(command => ['openspec', 'specify'].includes(command.executable) && command.args.includes('init'))).toBe(false);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it.each(['none', 'single-maintainer-gitflow', 'team-gitflow'] as const)(
    'diagnoses Manual %s source without invented framework requirements or markers', async profile => {
      const f = await writeModernInstalledProject(await directory(), 'manual', profile), before = await originalFiles(f.root);
      const result = await run(f.root), environment = checks(result.report, 'Environment').map(check => check.id);
      expect(checks(result.report, 'Project')).toContainEqual(expect.objectContaining({ id: 'framework-not-required', state: 'not-required', severity: 'ok' }));
      expect(environment).not.toEqual(expect.arrayContaining(['python', 'uv']));
      for (const id of ['openspec', 'spec-kit', 'python', 'uv', 'github-copilot', 'claude', 'codex']) expect(environment).not.toContain(id);
      expect(result.runner.calls.some(command => ['openspec', 'specify', 'uv', 'python', 'python3'].includes(command.executable))).toBe(false);
      expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'active-layout', severity: 'fail', detail: 'Active layout is unresolved.' }));
      expect(result.code).toBe(1);
      expect(await originalFiles(f.root)).toEqual(before);
      await expect(fs.lstat(path.join(f.root, 'openspec'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(path.join(f.root, '.specify'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('does not replace a missing binding with a plausible default backend', async () => {
    const f = await createOpenSpecExecutionFixture(roots);
    await f.put(['liftoff.manifest.json'], canonicalJson({ ...f.manifest,
      activeLayout: { ...f.manifest.activeLayout, bindings: f.manifest.activeLayout.bindings.filter(binding =>
        binding.kind !== 'component' || binding.component !== 'backend') }
    }));
    await f.put(['backend', 'package.json'], 'Do not read or execute this unbound source.');
    const before = await originalFiles(f.root), opens = vi.mocked(fs.open).mockClear(), reads = vi.mocked(fs.readFile).mockClear();
    const result = await run(f.root), unbound = path.join(f.root, 'backend');
    expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'active-layout', severity: 'fail', detail: expect.stringContaining('backend') }));
    expect(opens.mock.calls.some(([file]) => String(file).startsWith(unbound))).toBe(false);
    expect(reads.mock.calls.some(([file]) => String(file).startsWith(unbound))).toBe(false);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('reports bounded coverage without reading or printing excluded secret contents', async () => {
    const f = await createOpenSpecExecutionFixture(roots);
    const backend = f.manifest.activeLayout.bindings.find(binding => binding.kind === 'component' && binding.component === 'backend')!;
    const parts = [...backend.pathParts, '.env'], canary = 'DOCTOR_SECRET_CANARY_MUST_NOT_BE_READ';
    await f.put(parts, canary);
    const before = await originalFiles(f.root), opens = vi.mocked(fs.open).mockClear(), reads = vi.mocked(fs.readFile).mockClear();
    const result = await run(f.root), secret = path.join(f.root, ...parts);
    expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'project-inputs', state: 'observed', detail: expect.stringContaining('excluded entries were not read') }));
    expect(result.output).not.toContain(canary);
    expect(opens.mock.calls.some(([file]) => String(file) === secret)).toBe(false);
    expect(reads.mock.calls.some(([file]) => String(file) === secret)).toBe(false);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('does not downgrade unsupported source to historical runtime or ordinary Git handling', async () => {
    const f = await createOpenSpecExecutionFixture(roots), inspect = vi.spyOn(localInputs, 'inspectModernLocalRuntime');
    await f.put(['liftoff.manifest.json'], '{"artifactVersion":99}');
    const before = await originalFiles(f.root), result = await run(f.root);
    expect(result.code).toBe(1);
    expect(checks(result.report, 'Project')).toContainEqual(expect.objectContaining({ label: 'manifest', severity: 'fail', detail: expect.stringContaining('supported values are 2, 3, 4, 5, 6, 7, 8') }));
    expect(result.report.layers.some(layer => layer.title === 'Runtime')).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('surfaces actual unsafe-source and invalid-control blockers without reporting verification', async () => {
    const f = await createOpenSpecExecutionFixture(roots, 'single-maintainer-gitflow');
    await f.put(['governance', 'activation-state.json'], '{"schemaVersion":99}');
    const before = await originalFiles(f.root), result = await run(f.root);
    expect(result.code).toBe(1);
    expect(checks(result.report, 'Project')).toContainEqual(expect.objectContaining({ label: 'manifest', severity: 'fail' }));
    expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'project-inputs', severity: 'fail', state: 'not-observable' }));
    expect(checks(result.report, 'Runtime')).toContainEqual(expect.objectContaining({ id: 'local-verification', state: 'not-executed' }));
    expect(await originalFiles(f.root)).toEqual(before);
  });
});

describe('Manual workstation source selection', () => {
  const selection: WorkstationRequirementSelection = {
    workload: { kind: 'standard', apiStack: { id: 'go-huma' }, provider: { id: 'azure' }, frontend: false },
    specWorkflow: { id: 'manual' }, framework: null, agents: []
  };
  it('selects real workload tools and optional agents without an external framework fallback', () => {
    const requirements = selectWorkstationRequirements({ ...selection, agents: [{ id: 'claude', label: 'Claude' }] });
    const ids = requirements.map(requirement => requirement.id);
    expect(ids).toContain('go');
    expect(ids).toContain('claude');
    for (const id of ['npm', 'python', 'uv', 'openspec', 'spec-kit']) expect(ids).not.toContain(id);
    expect(requirements.find(requirement => requirement.id === 'node')?.reasons).toEqual(['Liftoff runtime']);
  });
  it.each(['openspec', 'spec-kit'] as const)('requires a real %s contract when its framework is requested', workflow => {
    expect(() => selectWorkstationRequirements({ ...selection, specWorkflow: { id: workflow } })).toThrow(/framework contract/);
    expect(() => selectWorkstationRequirements({ ...selection, specWorkflow: { id: workflow } }, { includeFramework: false })).not.toThrow();
  });
  it('rejects an unknown runtime workflow rather than treating it as Manual', () => {
    expect(() => Reflect.apply(selectWorkstationRequirements, undefined, [{ ...selection, specWorkflow: { id: 'future' } }])).toThrow(/supported workflow/);
  });
});
