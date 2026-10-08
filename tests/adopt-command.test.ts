import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const now = new Date('2026-10-19T06:00:00.000Z');
const selection = [
  '--type', 'standard',
  '--api', 'node',
  '--cloud', 'azure',
  '--region', 'eastus',
  '--environments', 'dev',
  '--spec', 'manual',
  '--agents', 'none',
  '--governance', 'none',
  '--no-frontend'
] as const;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function fixture(options: { manifest?: boolean } = {}) {
  const root = await directory('liftoff-adopt-command-');
  const home = await directory('liftoff-adopt-home-');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const plan = buildCurrentProjectPlan({
    projectName: path.basename(root),
    projectType: 'standard',
    apiStack: 'node',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'manual',
    agents: [],
    governanceProfile: 'none',
    includeFrontend: false
  }, { requireProjectName: true });
  for (const artifact of buildCurrentArtifacts(plan)) {
    if (artifact.logicalName === 'manifest' && !options.manifest) continue;
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
    const target = path.join(root, entry);
    try {
      files[entry] = (await readFile(target)).toString('base64');
    } catch {
      // Directories are represented by the recursive entry list.
    }
  }
  return { entries, files };
}

async function invoke(
  argv: string[],
  cwd: string,
  home: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(argv), {
    cwd,
    stdout,
    stderr,
    updateNow: () => now,
    updatePreview: { homedir: home, env: {} }
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('public reviewed adoption command', () => {
  it('emits a schema-1 JSON preview, preserves project bytes, and saves only external review records', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const result = await invoke(
      ['adopt', project.root, ...selection, '--json'],
      path.dirname(project.root),
      project.home
    );
    expect(result).toMatchObject({ code: 2, stderr: '' });
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption',
      command: 'adopt',
      operation: 'preview',
      readOnly: true,
      projectRoot: project.root,
      projectKind: 'git',
      status: 'compatibility-review-required',
      exitCode: 2,
      layoutPlan: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-layout-plan',
        status: 'ready-for-candidate-inspection',
        compatibility: 'not-verified',
        deployment: 'planning-only',
        gitHistory: 'not-read-or-modified'
      },
      mappingReview: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-mapping-review',
        status: 'explicit-review-required',
        dynamicReferencesReviewed: false,
        verificationSelection: 'not-provided',
        compatibility: 'not-verified',
        publication: 'not-authorized'
      },
      review: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-preview',
        projectRoot: project.root,
        verification: 'not-performed',
        publication: 'not-authorized'
      },
      destinationPlan: {
        schemaVersion: 1,
        kind: 'liftoff-adoption-destination-plan',
        status: 'ready-for-independent-verification',
        verification: 'not-performed',
        approval: 'not-requested',
        publication: 'not-authorized'
      },
      approval: { requestedFingerprint: null, status: 'not-requested' },
      recovery: { requested: false, status: 'not-requested' }
    });
    expect(report.candidate.status).toBe('candidate-observed-unverified');
    expect(report.destinationPlan.blockers).toEqual([]);
    expect(report.layoutPlan.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'observed-preserved' }),
      expect.objectContaining({ status: 'planning-only-excluded' })
    ]));
    expect(await snapshot(project.root)).toEqual(before);
    expect(await readdir(project.home, { recursive: true })).not.toEqual([]);
  });

  it('keeps bare non-TTY execution preview-only and emits no approval-shaped result', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const result = await invoke(
      ['adopt', '--project', project.root, ...selection],
      project.root,
      project.home
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Reviewed in-place adoption');
    expect(result.stdout).toContain('compatibility-review-required');
    expect(result.stdout).toContain('Mapping review');
    expect(result.stdout).toContain('Per-file review draft');
    expect(result.stdout).toContain('Reference review draft');
    expect(result.stdout).toContain('grants no verification, file approval');
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('fails closed on approval and recovery before touching a selected project', async () => {
    const home = await directory('liftoff-adopt-authority-home-');
    const missing = path.join(await directory('liftoff-adopt-authority-parent-'), 'missing');
    const fingerprint = 'a'.repeat(64);
    const approval = await invoke(
      ['adopt', '--project', missing, '--approve-plan', fingerprint, '--json'],
      path.dirname(missing),
      home
    );
    expect(approval.code).toBe(1);
    expect(JSON.parse(approval.stdout)).toMatchObject({
      operation: 'approve',
      status: 'approval-unavailable',
      approval: {
        requestedFingerprint: fingerprint,
        status: 'unavailable-before-complete-plan'
      }
    });
    const recovery = await invoke(
      ['adopt', '--project', missing, '--recover', '--approve-plan', fingerprint, '--json'],
      path.dirname(missing),
      home
    );
    expect(recovery.code).toBe(1);
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      operation: 'recover',
      status: 'recovery-unavailable',
      recovery: {
        requested: true,
        status: 'unavailable-before-authenticated-transaction'
      }
    });
    await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(home)).toEqual([]);
  });

  it('routes an existing Liftoff project to update and repair without re-adoption', async () => {
    const project = await fixture({ manifest: true });
    const before = await snapshot(project.root);
    const result = await invoke(
      ['adopt', project.root, ...selection, '--json'],
      project.root,
      project.home
    );
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      projectKind: 'liftoff',
      status: 'existing-liftoff-project',
      review: null,
      destinationPlan: null
    });
    expect(report.nextActions.map((action: { command: string[] }) => action.command.slice(0, 2)))
      .toEqual([['liftoff', 'update'], ['liftoff', 'repair']]);
    expect(await snapshot(project.root)).toEqual(before);
    expect(await readdir(project.home)).toEqual([]);
  });

  it('requires an explicit path for a non-Git application boundary', async () => {
    const root = await directory('liftoff-adopt-non-git-');
    const home = await directory('liftoff-adopt-non-git-home-');
    await writeFile(path.join(root, 'README.md'), 'application\n');
    const implicit = await invoke(['adopt', ...selection, '--json'], root, home);
    expect(implicit.code).toBe(1);
    expect(JSON.parse(implicit.stdout)).toMatchObject({ status: 'error', projectKind: 'unavailable' });
    const explicit = await invoke(['adopt', root, ...selection, '--json'], root, home);
    expect(explicit.code).toBe(2);
    expect(JSON.parse(explicit.stdout)).toMatchObject({
      projectRoot: root,
      projectKind: 'explicit-non-git',
      status: 'blocked',
      layoutPlan: {
        status: 'blocked',
        blockers: [{ code: 'supported-application-binding-unobserved' }]
      },
      mappingReview: null,
      review: null,
      candidate: null,
      destinationPlan: null
    });
  });

  it('rejects contradictory or malformed authority syntax during parsing', () => {
    const fingerprint = 'a'.repeat(64);
    for (const argv of [
      ['adopt', '.', '--project', '.'],
      ['adopt', '--approve-plan', 'short'],
      ['adopt', '--check', '--approve-plan', fingerprint],
      ['adopt', '--check', '--recover', '--approve-plan', fingerprint],
      ['adopt', '--recover'],
      ['adopt', '--yes'],
      ['adopt', '--force'],
      ['adopt', '--configure-openspec-profile']
    ]) {
      expect(() => parseArgs(argv)).toThrow();
    }
  });
});
