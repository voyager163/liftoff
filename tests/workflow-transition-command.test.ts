import {
  mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const now = new Date('2026-10-21T08:00:00.000Z');

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function directory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function fixture(
  specWorkflow: 'openspec' | 'spec-kit' | 'manual' = 'manual'
) {
  const root = await directory('liftoff workflow project with spaces ');
  const home = await directory('liftoff workflow home with spaces ');
  const plan = buildCurrentProjectPlan({
    projectName: path.basename(root),
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    region: 'eastus',
    includeFrontend: false,
    environments: ['dev'],
    specWorkflow,
    agents: ['copilot'],
    ...(specWorkflow === 'spec-kit' ? { defaultAgent: 'copilot' } : {}),
    governanceProfile: 'none'
  }, { requireProjectName: true });
  for (const artifact of buildCurrentArtifacts(plan)) {
    const target = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
  }
  return { root, home };
}

async function snapshot(root: string) {
  const entries = (await readdir(root, { recursive: true })).sort();
  const files: Record<string, string> = {};
  for (const entry of entries) {
    try {
      files[entry] = (await readFile(path.join(root, entry))).toString('base64');
    } catch {
      // Directories are represented by the recursive entry list.
    }
  }
  return { entries, files };
}

async function invoke(
  argv: string[],
  cwd: string,
  home: string,
  clock = now
) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(argv), {
    cwd,
    stdout,
    stderr,
    updateNow: () => clock,
    updatePreview: { homedir: home, env: {}, clock: () => clock }
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('reviewed workflow transition command', () => {
  it('documents planning authority without advertising a transition executor', async () => {
    const project = await fixture();
    const result = await invoke(
      ['workflow', '--help'],
      project.root,
      project.home
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('workflow set');
    expect(result.stdout).toContain('--approve-plan');
    expect(result.stdout).toContain('--recover');
    expect(result.stdout).not.toContain('--force');
    expect(result.stdout).not.toContain('--yes');
  });

  it('registers exact set/check/apply/recovery grammar and rejects generic authority', () => {
    const fingerprint = 'a'.repeat(64);
    expect(parseArgs([
      'workflow', 'set', 'openspec', 'project with spaces', '--check'
    ])).toMatchObject({
      command: 'workflow',
      subcommand: 'set',
      positional: ['openspec', 'project with spaces'],
      flags: { check: true }
    });
    for (const argv of [
      ['workflow'],
      ['workflow', 'set'],
      ['workflow', 'set', 'unknown'],
      ['workflow', 'set', 'openspec', '--check', '--approve-plan', fingerprint],
      ['workflow', 'set', 'openspec', '--recover'],
      ['workflow', 'set', 'openspec', '--approve-plan', 'short'],
      ['workflow', 'set', 'openspec', 'one', '--project', 'two'],
      ['workflow', 'set', 'openspec', '--default-agent', 'copilot'],
      ['workflow', 'set', 'manual', '--default-agent', 'copilot'],
      ['workflow', 'set', 'openspec', '--force'],
      ['workflow', 'set', 'openspec', '--yes']
    ]) {
      expect(() => parseArgs(argv)).toThrow();
    }
  });

  it('saves an immutable source/target/agent/input/check/expiry plan without project writes', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const result = await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home);
    expect(result).toMatchObject({ code: 2, stderr: '' });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-workflow-transition',
      command: 'workflow set',
      operation: 'check',
      status: 'review-required',
      readOnly: true,
      projectWrites: false,
      transaction: 'not-started',
      plan: {
        schemaVersion: 1,
        kind: 'liftoff-workflow-transition-plan',
        projectRoot: project.root,
        source: {
          workflow: 'manual',
          agents: ['github-copilot'],
          defaultAgent: null,
          frameworkState: 'not-required'
        },
        target: {
          workflow: 'openspec',
          agents: ['github-copilot'],
          defaultAgent: null,
          frameworkState: 'initialization-required',
          pluginResolutionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
        },
        governanceProfile: 'none',
        inputs: [
          expect.objectContaining({
            pathParts: ['liftoff.manifest.json'],
            present: true,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
          }),
          expect.objectContaining({
            pathParts: ['liftoff.config.json'],
            present: true,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
          })
        ],
        checks: [
          { id: 'source-inputs-current', status: 'required' },
          { id: 'source-history-preserved', status: 'required' },
          { id: 'active-work-reconciled', status: 'required' },
          { id: 'target-framework-staged', status: 'required' },
          { id: 'target-integrations-verified', status: 'required' }
        ],
        applicationFiles: 'preserved',
        gitHistory: 'preserved',
        frameworkHistory: 'preserved',
        effects: 'not-authorized',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      planStoragePath: expect.any(String)
    });
    expect(await snapshot(project.root)).toEqual(before);
    expect(await readdir(project.home, { recursive: true })).not.toEqual([]);
  });

  it('revalidates exact inputs and refuses execution until a transition executor is registered', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home)).stdout);
    const result = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot',
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: 'apply',
      status: 'execution-unavailable',
      projectWrites: false,
      plan: { fingerprint: preview.plan.fingerprint }
    });
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('rejects stale inputs and mismatched target selection before any effect', async () => {
    const project = await fixture();
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home)).stdout);
    const wrong = await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.stdout).diagnostics.join(' ')).toContain('does not match');
    const manifestPath = path.join(project.root, 'liftoff.manifest.json');
    await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')}\n`);
    const stale = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).diagnostics.join(' ')).toContain('changed after preview');
  });

  it('binds an absent optional config and rejects its later creation', async () => {
    const project = await fixture();
    const configPath = path.join(project.root, 'liftoff.config.json');
    await rm(configPath);
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home)).stdout);
    expect(preview.plan.inputs[1]).toEqual({
      pathParts: ['liftoff.config.json'],
      present: false,
      digest: null,
      bytes: null,
      mode: null
    });
    await writeFile(configPath, '{}\n');
    const stale = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).diagnostics.join(' '))
      .toContain('liftoff.config.json changed after preview');
  });

  it('recognizes every already-current workflow selection', async () => {
    for (const target of ['manual', 'openspec', 'spec-kit'] as const) {
      const project = await fixture(target);
      const current = await invoke([
        'workflow', 'set', target, project.root, '--check', '--json'
      ], project.root, project.home);
      expect(current.code).toBe(0);
      expect(JSON.parse(current.stdout)).toMatchObject({
        status: 'current',
        projectWrites: false,
        plan: {
          source: { workflow: target },
          target: { workflow: target }
        }
      });
    }
  });

  it('reports unavailable recovery without manufacturing a transaction', async () => {
    const project = await fixture();
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home)).stdout);
    const recovery = await invoke([
      'workflow', 'set', 'openspec', project.root, '--recover',
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(recovery.code).toBe(1);
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      operation: 'recover',
      status: 'recovery-unavailable',
      projectWrites: false,
      transaction: 'not-started'
    });
  });

  it('rejects tampered or expired external plans without reading them as authority', async () => {
    const project = await fixture();
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home)).stdout);
    const saved = JSON.parse(await readFile(preview.planStoragePath, 'utf8'));
    saved.target.unexpected = true;
    await writeFile(preview.planStoragePath, JSON.stringify(saved));
    const tampered = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(tampered.code).toBe(1);
    expect(JSON.parse(tampered.stdout).diagnostics.join(' ')).toContain('target fields');

    const fresh = JSON.parse((await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--check', '--json'
    ], project.root, project.home)).stdout);
    const expired = await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--approve-plan', fresh.plan.fingerprint, '--json'
    ], project.root, project.home, new Date(now.getTime() + 31 * 60 * 1000));
    expect(expired.code).toBe(1);
    expect(JSON.parse(expired.stdout).diagnostics.join(' ')).toContain('expired');
  });
});
