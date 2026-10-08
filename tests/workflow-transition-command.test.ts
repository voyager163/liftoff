import {
  mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  projectMutationLockPath
} from '../src/adapters/filesystem/project-lock.js';
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
  clock = now,
  approval?: (
    config: { message: string; default: false }
  ) => Promise<boolean>
) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (approval) {
    stdin.isTTY = true;
    (stderr as CaptureStream & { isTTY?: boolean }).isTTY = true;
  }
  const code = await runCommand(parseArgs(argv), {
    cwd,
    stdout,
    stderr,
    ...(approval
      ? {
          stdin,
          approveWorkflowTransitionPlan: approval
        }
      : {}),
    updateNow: () => clock,
    updatePreview: { homedir: home, env: {}, clock: () => clock }
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function interruptTransition(
  project: { root: string; home: string },
  fingerprint: string,
  phase: 'after-mutation' | 'committed',
  index?: number
) {
  const loaderUrl = new URL(
    './fixtures/source-typescript-loader.mjs',
    import.meta.url
  ).href;
  const planUrl = new URL(
    '../src/application/workflow-transition/plan.ts',
    import.meta.url
  ).href;
  const authorityUrl = new URL(
    '../src/application/workflow-transition/transaction-authority.ts',
    import.meta.url
  ).href;
  const transactionUrl = new URL(
    '../src/adapters/filesystem/reviewed-update-transaction.ts',
    import.meta.url
  ).href;
  const child = spawnSync(
    process.execPath,
    ['--import', loaderUrl, '--input-type=module', '-e', `
      const {
        assertWorkflowTransitionPlanCurrent,
        readWorkflowTransitionPlan,
        rebuildWorkflowTransitionExecution
      } = await import(${JSON.stringify(planUrl)});
      const {
        createWorkflowTransitionTransactionAuthorityStore
      } = await import(${JSON.stringify(authorityUrl)});
      const {
        applyWorkflowTransitionTransaction
      } = await import(${JSON.stringify(transactionUrl)});
      const now = new Date(${JSON.stringify(now.toISOString())});
      const storage = {
        homedir: ${JSON.stringify(project.home)},
        env: {},
        clock: () => now
      };
      const plan = await readWorkflowTransitionPlan(
        ${JSON.stringify(project.root)},
        ${JSON.stringify(fingerprint)},
        now,
        storage
      );
      const candidate = await rebuildWorkflowTransitionExecution(plan);
      const authorityStore =
        createWorkflowTransitionTransactionAuthorityStore(
          plan.projectRoot,
          storage
        );
      await applyWorkflowTransitionTransaction(
        plan.projectRoot,
        candidate.mutations,
        {
          planFingerprint: plan.fingerprint,
          authorityStore,
          preconditions: candidate.preconditions,
          expectedCandidateBinding:
            plan.execution.transactionCandidateBinding,
          validateCurrentInputs: async stage => {
            if (stage !== 'before-commit') {
              await assertWorkflowTransitionPlanCurrent(plan);
            }
          },
          onCheckpoint: async checkpoint => {
            if (checkpoint.phase === ${JSON.stringify(phase)} &&
                checkpoint.index === ${JSON.stringify(index)}) {
              process.exit(73);
            }
          }
        }
      );
      process.exitCode = 9;
    `],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000
    }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(73);
  await rm(await projectMutationLockPath(project.root), { force: true });
}

describe('reviewed workflow transition command', () => {
  it('documents exact transition authority without generic override flags', async () => {
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
        execution: { status: 'unavailable' },
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      planStoragePath: expect.any(String)
    });
    expect(await snapshot(project.root)).toEqual(before);
    expect(await readdir(project.home, { recursive: true })).not.toEqual([]);
  });

  it('keeps transitions into external frameworks unavailable', async () => {
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

  for (const source of ['openspec', 'spec-kit'] as const) {
    it(`transitions initialized ${source} to Manual while preserving framework and unrelated bytes`, async () => {
      const project = await fixture(source);
      const before = await snapshot(project.root);
      const preview = await invoke([
        'workflow', 'set', 'manual', project.root,
        '--check', '--json'
      ], project.root, project.home);
      expect(preview).toMatchObject({ code: 2, stderr: '' });
      const reviewed = JSON.parse(preview.stdout);
      expect(reviewed).toMatchObject({
        status: 'review-required',
        projectWrites: false,
        plan: {
          source: {
            workflow: source,
            frameworkState: 'initialized'
          },
          target: {
            workflow: 'manual',
            frameworkState: 'not-required',
            agents: ['github-copilot'],
            defaultAgent: null
          },
          execution: {
            status: 'ready-for-file-approval',
            transition: 'external-framework-to-manual',
            manifestPublishedLast: true,
            frameworkDocuments: 'preserved-on-disk',
            sharedTools: 'unchanged',
            targetLocalReadiness:
              'manual-native-framework-inapplicable',
            transactionCandidateBinding:
              expect.stringMatching(/^[a-f0-9]{64}$/u),
            effects: expect.arrayContaining([
              expect.objectContaining({
                logicalName: 'liftoff-config',
                kind: 'desired-state',
                operation: 'write',
                pathParts: ['liftoff.config.json']
              }),
              expect.objectContaining({
                logicalName: 'manifest',
                kind: 'manifest',
                operation: 'write',
                pathParts: ['liftoff.manifest.json']
              })
            ])
          }
        }
      });
      const effects = reviewed.plan.execution.effects as Array<{
        pathParts: string[];
      }>;
      expect(effects.at(-1)?.pathParts).toEqual([
        'liftoff.manifest.json'
      ]);
      expect(effects.some(effect =>
        ['openspec', '.specify', 'specs'].includes(
          effect.pathParts[0] ?? ''
        ))).toBe(false);
        expect(reviewed.plan.frameworkInventory).toMatchObject({
          status: 'preserved',
          workflow: source,
          activeWork: {
            identifiers: [expect.any(String)],
            reconciliation:
              'preserve-on-disk-as-non-authoritative'
          },
          fileCount: expect.any(Number),
          directoryCount: expect.any(Number),
          totalBytes: expect.any(Number),
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        });

      const applied = await invoke([
        'workflow', 'set', 'manual', project.root,
        '--approve-plan', reviewed.plan.fingerprint, '--json'
      ], project.root, project.home);
      expect(applied).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(applied.stdout)).toMatchObject({
        operation: 'apply',
        status: 'applied',
        readOnly: false,
        projectWrites: true,
        transaction: {
          operation: 'apply',
          status: 'committed',
          committed: true,
          transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          readbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          rollbackFailures: [],
          cleanupFailures: [],
          readbackFailures: []
        }
      });
      const manifest = JSON.parse(await readFile(
        path.join(project.root, 'liftoff.manifest.json'),
        'utf8'
      ));
      expect(manifest).toMatchObject({
        project: {
          specWorkflow: 'manual',
          agents: ['github-copilot']
        },
        framework: { state: 'not-required' }
      });
      expect(manifest.project).not.toHaveProperty('defaultAgent');
      expect(JSON.parse(await readFile(
        path.join(project.root, 'liftoff.config.json'),
        'utf8'
      ))).toMatchObject({
        specWorkflow: 'manual',
        agents: ['github-copilot']
      });
      const after = await snapshot(project.root);
      const changed = new Set(
        effects.map(effect => effect.pathParts.join('/'))
      );
      for (const [file, bytes] of Object.entries(before.files)) {
        if (!changed.has(file)) {
          expect(after.files[file], file).toBe(bytes);
        }
      }
      for (const file of Object.keys(before.files).filter(file =>
        file.startsWith('openspec/') ||
        file.startsWith('.specify/') ||
        file.startsWith('specs/'))) {
        expect(after.files[file], file).toBe(before.files[file]);
      }
    });
  }

  it('uses genuine interactive default-No consent for an executable Manual transition', async () => {
    const project = await fixture('openspec');
    const before = await snapshot(project.root);
    let prompt: { message: string; default: false } | undefined;
    const result = await invoke([
      'workflow', 'set', 'manual', project.root
    ], project.root, project.home, now, async config => {
      prompt = config;
      return false;
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('declined');
    expect(prompt).toMatchObject({
      default: false,
      message: expect.stringContaining('Apply this exact workflow transition')
    });
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('rejects drifted managed integrations before issuing executable authority', async () => {
    const project = await fixture('openspec');
    const manifest = JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    ));
    const managed = manifest.managedArtifacts[0];
    await writeFile(
      path.join(project.root, ...managed.pathParts),
      'developer-owned drift\n'
    );
    const result = await invoke([
      'workflow', 'set', 'manual', project.root,
      '--check', '--json'
    ], project.root, project.home);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'blocked',
      projectWrites: false
    });
    expect(JSON.parse(result.stdout).diagnostics.join(' '))
      .toContain('differs from its recorded Liftoff bytes');
  });

  it('binds preserved framework bytes and blocks unknown active-work shapes', async () => {
    const project = await fixture('openspec');
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'manual', project.root,
      '--check', '--json'
    ], project.root, project.home)).stdout);
    const proposal = path.join(
      project.root,
      'openspec',
      'changes',
      preview.plan.frameworkInventory.activeWork.identifiers[0],
      'proposal.md'
    );
    await writeFile(proposal, `${await readFile(proposal, 'utf8')}\nchanged\n`);
    const stale = await invoke([
      'workflow', 'set', 'manual', project.root,
      '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).diagnostics.join(' '))
      .toContain('framework documents or active work changed');

    const unknown = await fixture('openspec');
    await writeFile(
      path.join(unknown.root, 'openspec', 'changes', 'unowned.txt'),
      'unknown active work\n'
    );
    const blocked = await invoke([
      'workflow', 'set', 'manual', unknown.root,
      '--check', '--json'
    ], unknown.root, unknown.home);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout).diagnostics.join(' '))
      .toContain('Unknown OpenSpec active work entry');
  });

  it('reports absent recovery for an executable plan without manufacturing a transaction', async () => {
    const project = await fixture('spec-kit');
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'manual', project.root,
      '--check', '--json'
    ], project.root, project.home)).stdout);
    const recovery = await invoke([
      'workflow', 'set', 'manual', project.root,
      '--recover', '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(recovery.code).toBe(1);
    expect(JSON.parse(recovery.stdout)).toMatchObject({
      operation: 'recover',
      status: 'recovery-unavailable',
      projectWrites: false,
      transaction: {
        operation: 'recover',
        status: 'absent',
        committed: false
      }
    });
  });

  it('recovers an interrupted transition only through its authenticated lane', async () => {
    const project = await fixture('openspec');
    const before = await snapshot(project.root);
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'manual', project.root,
      '--check', '--json'
    ], project.root, project.home)).stdout);
    await interruptTransition(
      project,
      preview.plan.fingerprint,
      'after-mutation',
      0
    );
    const recovered = await invoke([
      'workflow', 'set', 'manual', project.root,
      '--recover', '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      operation: 'recover',
      status: 'recovered',
      projectWrites: false,
      transaction: {
        operation: 'recover',
        status: 'rolled-back',
        committed: false,
        transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('recovers committed transition cleanup with native Manual readback', async () => {
    const project = await fixture('spec-kit');
    const preview = JSON.parse((await invoke([
      'workflow', 'set', 'manual', project.root,
      '--check', '--json'
    ], project.root, project.home)).stdout);
    await interruptTransition(
      project,
      preview.plan.fingerprint,
      'committed'
    );
    const recovered = await invoke([
      'workflow', 'set', 'manual', project.root,
      '--recover', '--approve-plan', preview.plan.fingerprint, '--json'
    ], project.root, project.home);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      operation: 'recover',
      status: 'recovered',
      projectWrites: true,
      transaction: {
        operation: 'recover',
        status: 'committed',
        committed: true,
        transactionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        readbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        cleanupFailures: [],
        readbackFailures: []
      },
      plan: {
        frameworkInventory: {
          workflow: 'spec-kit',
          activeWork: {
            reconciliation:
              'preserve-on-disk-as-non-authoritative'
          }
        }
      }
    });
    expect(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    ))).toMatchObject({
      project: { specWorkflow: 'manual' },
      framework: { state: 'not-required' }
    });
  });
});
