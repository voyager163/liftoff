import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { observeRunningRuntime } from '../src/application/workstation/running-runtime.js';
import { InteractivePrompter, type AgentCheckboxPrompt } from '../src/interactive.js';
import { selectCurrentWorkstationRequirements } from '../src/workstation.js';
import { minimumNodeVersion } from '../src/runtime.js';
import type { CodingAgentId } from '../src/domain/project/contracts.js';
import { CaptureStream, ReadyInitRunner, scriptedTtyInput, ttyCaptureStream } from './helpers.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff manual onboarding '));
  roots.push(root);
  return root;
}
const forbidden = ['node', 'npm', 'npm.cmd', 'npx', 'openspec', 'specify', 'copilot', 'claude', 'codex'];
function manual({ agents = 'none', api = 'go', frontend = false, governance = 'none' } = {}) {
  return ['--spec', 'manual', '--agents', agents, '--type', 'standard', '--api', api,
    frontend ? '--frontend' : '--no-frontend', '--environments', 'dev', '--governance', governance];
}
async function run(args: string[], cwd: string, runner = new ReadyInitRunner({ missing: forbidden })) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({
    argv: args, cwd, stdout, stderr, env: { LIFTOFF_TELEMETRY: '0' },
    execute: (parsed, context) => runCommand(parsed, {
      ...context, runner,
      workstationProbe: { includeHealthNotices: false },
      stableReleaseLookup: async () => { throw new Error('Offline onboarding fixture.'); },
      updatePreview: { homedir: path.join(cwd, 'receipt-home'), env: {} }
    })
  });
  return { code, out: stdout.text(), err: stderr.text(), runner };
}
function noUnselectedProbes(runner: ReadyInitRunner) {
  expect(runner.calls.filter(command => forbidden.includes(command.executable))).toEqual([]);
}

describe('public current project onboarding', () => {
  it.each(['none', 'single-maintainer-gitflow'])('initializes and diagnoses Manual %s without external Node, frameworks or agents', async governance => {
    const cwd = await directory();
    const result = await run(['init', 'manual-app', ...manual({ governance }), '--yes'], cwd);
    expect(result.code, result.err).toBe(0);
    noUnselectedProbes(result.runner);
    expect(result.out).toContain('None (CLI only)');
    expect(result.out).not.toContain('Initialize spec-driven framework');
    expect(result.out).not.toContain('Use the setup invocation shown above');
    const root = path.join(cwd, 'manual-app');
    const raw = await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    expect(manifest).toMatchObject({
      artifactVersion: 8, framework: { state: 'not-required' },
      project: { specWorkflow: 'manual', agents: [] },
      governance: { profile: governance, state: governance === 'none' ? 'disabled' : 'handoff-generated' }
    });
    if (governance === 'none') {
      await expect(lstat(path.join(root, '.liftoff', 'governance'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const entry of ['openspec', '.specify', 'specs', '.agents', '.claude', '.github']) {
      await expect(lstat(path.join(root, entry))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await run(['validate', root], cwd)).code).toBe(0);
    const doctor = await run(['doctor', '--json'], root);
    expect(doctor.code, doctor.out).toBe(0);
    noUnselectedProbes(doctor.runner);
    const report = JSON.parse(doctor.out);
    expect(report.layers.flatMap((layer: { checks: unknown[] }) => layer.checks)).toContainEqual(expect.objectContaining({
      id: 'liftoff-runtime', severity: 'ok', observedVersion: process.versions.node
    }));
    const status = await run(['governance', 'status', '--scope', 'local', '--json'], root);
    expect([0, 2], status.err).toContain(status.code);
    noUnselectedProbes(status.runner);
    const assessed = await run(['governance', 'assess', '--json'], root);
    const assessment = JSON.parse(assessed.out);
    expect(assessed.code, assessed.out + assessed.err).toBe(governance === 'none' ? 0 : 2);
    expect(assessment).toMatchObject({
      schemaVersion: 1, readOnly: true, outcome: governance === 'none' ? 'not-applicable' : 'partial',
      projectIdentity: { availability: 'known', manifestVersion: 8, profile: governance, stateSource: 'unsupported' },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'modern-proof-not-reused' })])
    });
    expect(assessment.projectIdentity.recordedActivationIdentity)
      .toEqual(governance === 'none' ? null : manifest.governance.activationIdentity);
    noUnselectedProbes(assessed.runner);
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe(raw);
    const update = await run(['update', root, '--check', '--json'], cwd);
    expect(update.code, update.out).toBe(0);
    expect(JSON.parse(update.out)).toMatchObject({
      schemaVersion: 4, status: 'current', publicationCommitted: false, localComplete: false
    });
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe(raw);
  });

  it.each(['malformed-current', 'future'])('does not treat %s manifests as valid current assessment metadata', async variant => {
    const cwd = await directory();
    expect((await run(['init', 'invalid-assessment', ...manual(), '--yes'], cwd)).code).toBe(0);
    const root = path.join(cwd, 'invalid-assessment'), manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (variant === 'future') manifest.artifactVersion = 9;
    else manifest.framework = { state: 'initialized', adapter: 'openspec', contractVersion: '1.11.0' };
    const raw = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath, raw);
    const result = await run(['governance', 'assess', '--json'], root);
    expect(result.code, result.out + result.err).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ outcome: 'error', projectIdentity: { availability: 'unavailable' } });
    expect(result.runner.calls).toEqual([]);
    expect(await readFile(manifestPath, 'utf8')).toBe(raw);
  });

  it('previews Manual without effects or unselected tool discovery', async () => {
    const root = await directory();
    const result = await run(['plan', ...manual()], root);
    expect(result.code, result.err).toBe(0);
    expect(result.runner.calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect(result.out).toContain('None (CLI only)');
    expect(result.out).not.toContain('OpenSpec:');
    expect(result.out).not.toContain('npm:');
  });

  it('preserves unselected framework files and their modes in an existing target', async () => {
    const cwd = await directory(), target = path.join(cwd, 'manual-app');
    const protectedFiles = ['openspec/config.yaml', '.specify/init-options.json', '.agents/skills/custom/SKILL.md'];
    const before = new Map<string, { content: Buffer; mode: number }>();
    for (const file of protectedFiles) {
      const absolute = path.join(target, file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, `Preserve unrelated ${file}\n`, { mode: 0o600 });
      before.set(file, { content: await readFile(absolute), mode: (await lstat(absolute)).mode });
    }
    const result = await run(['init', 'manual-app', ...manual(), '--yes'], cwd);
    expect(result.code, result.err).toBe(0);
    noUnselectedProbes(result.runner);
    for (const file of protectedFiles) {
      expect(await readFile(path.join(target, file))).toEqual(before.get(file)!.content);
      expect((await lstat(path.join(target, file))).mode).toBe(before.get(file)!.mode);
    }
  });

  it('rejects a case-alias collision even with force and preserves the existing file', async () => {
    const cwd = await directory(), target = path.join(cwd, 'manual-app');
    await mkdir(target);
    await writeFile(path.join(target, 'readme.md'), 'Developer-owned lowercase file\n');
    const result = await run(['init', 'manual-app', ...manual(), '--yes', '--force'], cwd);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/alias|case|spelling/i);
    expect(await readFile(path.join(target, 'readme.md'), 'utf8')).toBe('Developer-owned lowercase file\n');
    expect(await readdir(target)).toEqual(['readme.md']);
    noUnselectedProbes(result.runner);
  });

  it.each(['copilot', 'claude', 'codex'])('initializes only the selected Manual %s integration beside custom skills', async agent => {
    const cwd = await directory(), target = path.join(cwd, 'manual-app');
    const custom = path.join(target, '.agents', 'skills', 'custom', 'SKILL.md');
    await mkdir(path.dirname(custom), { recursive: true });
    await writeFile(custom, 'Custom skill, not owned by Liftoff\n');
    const runner = new ReadyInitRunner({ missing: forbidden.filter(executable => executable !== agent) });
    const result = await run(['init', 'manual-app', ...manual({ agents: agent }), '--yes'], cwd, runner);
    expect(result.code, result.err).toBe(0);
    expect(runner.calls.some(command => command.executable === agent && command.args.includes('--version'))).toBe(true);
    expect(runner.calls.filter(command => forbidden.includes(command.executable) && command.executable !== agent)).toEqual([]);
    expect(await readFile(custom, 'utf8')).toBe('Custom skill, not owned by Liftoff\n');
    const manifest = JSON.parse(await readFile(path.join(target, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.project.agents).toEqual([agent === 'copilot' ? 'github-copilot' : agent]);
    expect(manifest.managedArtifacts.map((entry: { logicalName: string }) => entry.logicalName))
      .toEqual([`liftoff-assess-${agent}`, `liftoff-repair-${agent}`]);
  });

  it('migrates to a fresh Manual sibling with a local checklist and unchanged source', async () => {
    const cwd = await directory(), source = path.join(cwd, 'legacy');
    await mkdir(source);
    await writeFile(path.join(source, 'go.mod'), 'module example.com/legacy\n\ngo 1.27\n');
    await writeFile(path.join(source, 'main.go'), 'package main\nfunc main() {}\n', { mode: 0o600 });
    const before = await readFile(path.join(source, 'main.go'));
    const mode = (await lstat(path.join(source, 'main.go'))).mode;
    const result = await run(['migrate', source, ...manual(), '--yes'], cwd);
    expect(result.code, result.err).toBe(0);
    noUnselectedProbes(result.runner);
    const target = path.join(cwd, 'legacy-liftoff');
    expect(JSON.parse(await readFile(path.join(target, 'liftoff.manifest.json'), 'utf8')))
      .toMatchObject({ artifactVersion: 8, framework: { state: 'not-required' }, project: { agents: [] } });
    const checklist = await readFile(path.join(target, 'MIGRATION.md'), 'utf8');
    expect(checklist).toContain('the checklist is finalized locally');
    expect(checklist).toContain('- [ ]');
    expect(checklist).not.toContain('- [x]');
    expect(await readFile(path.join(target, 'migration', 'legacy', 'main.go'))).toEqual(before);
    expect(await readFile(path.join(source, 'main.go'))).toEqual(before);
    expect((await lstat(path.join(source, 'main.go'))).mode).toBe(mode);
    expect(await readdir(source)).toEqual(['go.mod', 'main.go']);
  });

  it.each(['none,claude', 'none,none', 'none,', ',none', '', 'claude,,codex'])('rejects malformed or mixed agent selection %j without creating a project', async agents => {
    const root = await directory();
    const result = await run(['init', 'invalid', ...manual({ agents }), '--yes'], root);
    expect(result.code).toBe(1);
    noUnselectedProbes(result.runner);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['--default-agent', 'claude'], ['--copilot-cloud'], ['--no-copilot-cloud'], ['--configure-openspec-profile']
  ])('rejects Manual framework-only flags %j before project or framework effects', async (...flags) => {
    const root = await directory();
    const result = await run(['init', 'invalid', ...manual(), ...flags, '--yes'], root);
    expect(result.code).toBe(1);
    noUnselectedProbes(result.runner);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([undefined, []].map(agents => [agents] as const))('loads actual Manual configuration with agents %j', async agents => {
    const root = await directory();
    await writeFile(path.join(root, 'project.json'), JSON.stringify({
      projectType: 'standard', apiStack: 'go-huma', specWorkflow: 'manual', governanceProfile: 'none',
      includeFrontend: false, environments: ['dev'], ...(agents ? { agents } : {})
    }));
    const result = await run(['init', 'configured', '--config', 'project.json', '--yes'], root);
    expect(result.code, result.err).toBe(0);
    noUnselectedProbes(result.runner);
    expect(JSON.parse(await readFile(path.join(root, 'configured', 'liftoff.config.json'), 'utf8')).agents).toEqual([]);
  });

  it.each(['node-fastify', 'go-huma', 'python-fastapi'])('retains genuine workload and frontend prerequisites for %s', apiStack => {
    for (const includeFrontend of [false, true]) {
      const plan = buildCurrentProjectPlan({
        projectName: 'Tools', projectType: 'standard', apiStack, includeFrontend,
        specWorkflow: 'manual', agents: [], governanceProfile: 'none'
      }, { requireProjectName: true });
      const ids = selectCurrentWorkstationRequirements(plan).map(requirement => requirement.id);
      expect(ids.includes('node')).toBe(apiStack === 'node-fastify' || includeFrontend);
      expect(ids.includes('npm')).toBe(apiStack === 'node-fastify' || includeFrontend);
      expect(ids.includes('go')).toBe(apiStack === 'go-huma');
      expect(ids.includes('python')).toBe(apiStack === 'python-fastapi');
      expect(ids.includes('uv')).toBe(apiStack === 'python-fastapi');
    }
  });

  it.each([{ api: 'node' }, { frontend: true }])('blocks real initialization when required external Node is missing: %j', async selection => {
    const cwd = await directory();
    const result = await run(['init', 'missing-runtime', ...manual(selection), '--yes'], cwd);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Workstation readiness is incomplete');
    expect(result.runner.calls.some(command => command.executable === 'node')).toBe(true);
    expect(await readdir(cwd)).toEqual([]);
  });

  it('observes the actual CLI runtime rather than presenting an external tool probe as evidence', () => {
    expect(observeRunningRuntime()).toMatchObject({ ready: true, observedVersion: process.versions.node });
    expect(observeRunningRuntime(minimumNodeVersion).ready).toBe(true);
    expect(observeRunningRuntime('20.0.0').ready).toBe(false);
    expect(observeRunningRuntime('not-observed').ready).toBe(false);
  });
});

describe('Manual agent prompts', () => {
  const initial = {
    projectName: 'Prompt', projectType: 'standard', apiStack: 'go-huma', cloud: 'azure', region: 'eastus',
    includeFrontend: false, environments: ['dev'], governanceProfile: 'none', specWorkflow: 'manual'
  };
  const selections: CodingAgentId[][] = [[], ['claude']];
  it.each(selections.map(agents => [agents] as const))('uses a genuine TTY checkbox with no discovery or default selections: %j', async agents => {
    const runner = new ReadyInitRunner(), checkbox = vi.fn<AgentCheckboxPrompt>().mockResolvedValue(agents);
    const prompter = new InteractivePrompter({
      input: scriptedTtyInput(''), output: ttyCaptureStream(), runner, checkboxPrompt: checkbox
    });
    try {
      const result = await prompter.promptForInitOptions(initial);
      expect(result.agents).toEqual(agents);
      expect(runner.calls).toEqual([]);
      const config = checkbox.mock.calls[0]![0];
      expect(config.required).toBe(false);
      expect(config.validate([])).toBe(true);
      expect(config.choices.every(choice => !choice.checked)).toBe(true);
    } finally { prompter.close(); }
  });
  it.each(['\n', 'none\n'])('permits no agents using the non-TTY line fallback %j', async input => {
    const runner = new ReadyInitRunner(), checkbox = vi.fn<AgentCheckboxPrompt>();
    const prompter = new InteractivePrompter({
      input: Readable.from([input]), output: new CaptureStream(), runner, checkboxPrompt: checkbox
    });
    try {
      expect((await prompter.promptForInitOptions(initial)).agents).toEqual([]);
      expect(runner.calls).toEqual([]);
      expect(checkbox).not.toHaveBeenCalled();
    } finally { prompter.close(); }
  });
  it('does not silently filter empty or mixed-none entries from interactive selection', async () => {
    const runner = new ReadyInitRunner(), output = new CaptureStream();
    const prompter = new InteractivePrompter({
      input: Readable.from(['none,claude\n1,,2\n2\n']), output, runner
    });
    try {
      expect((await prompter.promptForInitOptions(initial)).agents).toEqual(['claude']);
      expect(output.text().match(/Please choose valid agent options/g)).toHaveLength(2);
      expect(runner.calls).toEqual([]);
    } finally { prompter.close(); }
  });
});
