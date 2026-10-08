import {
  mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile
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
import {
  createScopedUserLocalRecordStore
} from '../src/adapters/filesystem/update-previews.js';
import {
  canonicalSha256
} from '../src/domain/governance/activation/canonical-json.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import {
  assertWorkflowTransitionTargetFrameworkCommitted,
  readWorkflowTransitionPlan
} from '../src/application/workflow-transition/plan.js';
import {
  specKitIntegrationPaths
} from '../src/framework-validation.js';
import {
  OPEN_SPEC_WORKFLOW_IDS,
  openSpecIntegrationPaths
} from '../src/openspec-profile.js';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { workstationRequirementCatalog } from '../src/workstation-catalog.js';
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
  specWorkflow: 'openspec' | 'spec-kit' | 'manual' = 'manual',
  agents: readonly ('copilot' | 'claude' | 'codex')[] = ['copilot']
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
    agents,
    ...(specWorkflow === 'spec-kit'
      ? { defaultAgent: agents[0]! }
      : {}),
    governanceProfile: 'none'
  }, { requireProjectName: true });
  for (const artifact of buildCurrentArtifacts(plan)) {
    const target = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content);
  }
  if (specWorkflow !== 'manual') {
    const runner = new WorkflowFrameworkRunner();
    const options = { cwd: root };
    if (specWorkflow === 'openspec') {
      const integrations = agents.map(agent =>
        agent === 'copilot' ? 'github-copilot' : agent
      );
      await runner.run({
        executable: 'openspec',
        args: [
          'init',
          '--tools',
          integrations.join(','),
          '--profile',
          'custom'
        ]
      }, options);
    } else {
      await runner.run({
        executable: 'specify',
        args: [
          'init',
          '.',
          '--integration',
          agents[0]!,
          '--here',
          '--force'
        ]
      }, options);
      for (const agent of agents.slice(1)) {
        await runner.run({
          executable: 'specify',
          args: ['integration', 'install', agent, '--force']
        }, options);
      }
      await runner.run({
        executable: 'specify',
        args: ['integration', 'use', agents[0]!]
      }, options);
    }
  }
  return { root, home };
}

async function snapshot(root: string) {
  const observed = await readdir(root, { recursive: true });
  const entries = observed.map(entry =>
    entry.split(path.sep).join('/')
  ).sort();
  const files: Record<string, string> = {};
  for (const entry of observed) {
    try {
      files[entry.split(path.sep).join('/')] = (await readFile(
        path.join(root, entry)
      )).toString('base64');
    } catch {
      // Directories are represented by the recursive entry list.
    }
  }
  return { entries, files };
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await readFile(file);
  } catch {
    await write(file, content);
  }
}

function commandResult(
  command: Parameters<CommandRunner['run']>[0],
  values: Partial<CommandResult> = {}
): CommandResult {
  return {
    command,
    displayCommand: [command.executable, ...command.args].join(' '),
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...values
  };
}

class WorkflowFrameworkRunner implements CommandRunner {
  readonly calls: string[] = [];
  private defaultIntegration?: string;
  private installedIntegrations: string[] = [];

  constructor(
    private profile = {
      profile: 'custom',
      delivery: 'both',
      workflows: [...OPEN_SPEC_WORKFLOW_IDS]
    },
    private openspecReady = true,
    private invalidOpenSpecOutput = false,
    private unknownOpenSpecOutput = false
  ) {}

  setOpenSpecReady(value: boolean): void {
    this.openspecReady = value;
  }

  setProfile(value: {
    profile: string;
    delivery: string;
    workflows: string[];
  }): void {
    this.profile = value;
  }

  async run(
    command: Parameters<CommandRunner['run']>[0],
    options?: RunCommandOptions
  ): Promise<CommandResult> {
    const display = [command.executable, ...command.args].join(' ');
    this.calls.push(display);
    if (display === 'node --version') {
      return commandResult(command, { stdout: 'v24.21.0\n' });
    }
    if (display === 'npm --version') {
      return commandResult(command, { stdout: '12.0.2\n' });
    }
    if (display === 'python3 --version') {
      return commandResult(command, { stdout: 'Python 3.14.0\n' });
    }
    if (display === 'uv --version') {
      return commandResult(command, { stdout: 'uv 0.12.7\n' });
    }
    if (display === 'openspec --version') {
      if (!this.openspecReady) {
        return commandResult(command, {
          status: null,
          errorCode: 'ENOENT',
          errorMessage: 'openspec not found'
        });
      }
      return commandResult(command, {
        stdout:
          `OpenSpec CLI version ${workstationRequirementCatalog.openspec.exactVersion}\n`
      });
    }
    if (display ===
        `npm install -g @fission-ai/openspec@${workstationRequirementCatalog.openspec.exactVersion}`) {
      this.openspecReady = true;
      return commandResult(command);
    }
    if (display === 'specify --version') {
      return commandResult(command, {
        stdout:
          `specify-cli version ${workstationRequirementCatalog['spec-kit'].exactVersion}\n`
      });
    }
    if (display === 'openspec config list --json') {
      return commandResult(command, {
        stdout: `${JSON.stringify(this.profile)}\n`
      });
    }
    if (command.executable === 'openspec' &&
        command.args[0] === 'config' &&
        command.args[1] === 'set') {
      const field = command.args[2] as keyof typeof this.profile;
      const raw = command.args[3]!;
      this.profile = {
        ...this.profile,
        [field]: field === 'workflows'
          ? JSON.parse(raw) as string[]
          : raw
      };
      return commandResult(command);
    }
    if (!options?.cwd) return commandResult(command);
    if (command.executable === 'openspec' &&
        command.args[0] === 'init') {
      const tools = command.args[
        command.args.indexOf('--tools') + 1
      ]?.split(',') ?? [];
      if (!this.invalidOpenSpecOutput) {
        await write(
          path.join(options.cwd, 'openspec', 'config.yaml'),
          'schema: spec-driven\n'
        );
      }
      if (this.unknownOpenSpecOutput) {
        await write(
          path.join(options.cwd, 'openspec', 'unexpected.txt'),
          'unexpected\n'
        );
      }
      for (const agent of [
        'github-copilot', 'claude', 'codex'
      ] as const) {
        if (!tools.includes(agent)) continue;
        for (const parts of openSpecIntegrationPaths(agent)) {
          await writeIfMissing(
            path.join(options.cwd, ...parts),
            `${agent}\n`
          );
        }
      }
      return commandResult(command);
    }
    if (command.executable === 'specify') {
      if (command.args[0] === 'init') {
        this.defaultIntegration = command.args[
          command.args.indexOf('--integration') + 1
        ];
        this.installedIntegrations = [this.defaultIntegration!];
        await write(
          path.join(options.cwd, '.specify', 'init-options.json'),
          '{}\n'
        );
        await write(
          path.join(
            options.cwd,
            '.specify',
            'templates',
            'spec-template.md'
          ),
          'official spec\n'
        );
        await write(
          path.join(
            options.cwd,
            '.specify',
            'templates',
            'plan-template.md'
          ),
          'official plan\n'
        );
      } else {
        try {
          const state = JSON.parse(
            await readFile(
              path.join(options.cwd, '.specify', 'integration.json'),
              'utf8'
            )
          ) as {
            default_integration?: string;
            installed_integrations?: string[];
          };
          this.defaultIntegration =
            state.default_integration ?? this.defaultIntegration;
          this.installedIntegrations =
            state.installed_integrations ?? this.installedIntegrations;
        } catch {
          // A missing state file remains invalid framework output.
        }
        const integration = command.args[2]!;
        if (command.args[1] === 'use') {
          this.defaultIntegration = integration;
        } else if (!this.installedIntegrations.includes(integration)) {
          this.installedIntegrations.push(integration);
        }
      }
      const agents = {
        copilot: 'github-copilot',
        claude: 'claude',
        codex: 'codex'
      } as const;
      for (const integration of this.installedIntegrations) {
        const agent = agents[integration as keyof typeof agents];
        for (const parts of specKitIntegrationPaths(agent)) {
          await writeIfMissing(
            path.join(options.cwd, ...parts),
            `${integration}\n`
          );
        }
      }
      await write(
        path.join(options.cwd, '.specify', 'integration.json'),
        `${JSON.stringify({
          integration_state_schema: 1,
          integration: this.defaultIntegration,
          default_integration: this.defaultIntegration,
          installed_integrations: this.installedIntegrations,
          integration_settings: {}
        }, null, 2)}\n`
      );
      return commandResult(command);
    }
    return commandResult(command, {
      status: 1,
      stderr: `unexpected command: ${display}`
    });
  }
}

async function invoke(
  argv: string[],
  cwd: string,
  home: string,
  clock = now,
  approval?: (
    config: { message: string; default: false }
  ) => Promise<boolean>,
  runner?: CommandRunner
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
          approveWorkflowTransitionPlan: approval,
          approveRepairPlan: approval
        }
      : {}),
    ...(runner ? { runner } : {}),
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
      const { mkdir, writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
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
      const openSpecPaths = ${JSON.stringify(
        openSpecIntegrationPaths('github-copilot')
      )};
      const runner = {
        async run(command, options) {
          const displayCommand = [command.executable, ...command.args].join(' ');
          const base = {
            command, displayCommand, status: 0, signal: null,
            stdout: '', stderr: '', timedOut: false
          };
          if (displayCommand === 'node --version') {
            return { ...base, stdout: 'v24.21.0\\n' };
          }
          if (displayCommand === 'npm --version') {
            return { ...base, stdout: '12.0.2\\n' };
          }
          if (displayCommand === 'openspec --version') {
            return {
              ...base,
              stdout: 'OpenSpec CLI version ${workstationRequirementCatalog.openspec.exactVersion}\\n'
            };
          }
          if (displayCommand === 'openspec config list --json') {
            return {
              ...base,
              stdout: JSON.stringify({
                profile: 'custom',
                delivery: 'both',
                workflows: ${JSON.stringify(OPEN_SPEC_WORKFLOW_IDS)}
              }) + '\\n'
            };
          }
          if (command.executable === 'openspec' &&
              command.args[0] === 'init' &&
              options?.cwd) {
            const files = [
              [['openspec', 'config.yaml'], 'schema: spec-driven\\n'],
              ...openSpecPaths.map(parts => [parts, 'github-copilot\\n'])
            ];
            for (const [parts, content] of files) {
              const target = path.join(options.cwd, ...parts);
              await mkdir(path.dirname(target), { recursive: true });
              await writeFile(target, content);
            }
          }
          return base;
        }
      };
      const plan = await readWorkflowTransitionPlan(
        ${JSON.stringify(project.root)},
        ${JSON.stringify(fingerprint)},
        now,
        storage
      );
      const candidate = await rebuildWorkflowTransitionExecution(
        plan,
        { runner }
      );
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
              await assertWorkflowTransitionPlanCurrent(
                plan,
                { runner }
              );
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
    expect(result.stdout).toContain('--install-tools');
    expect(result.stdout).toContain('--configure-openspec-profile');
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
      ['workflow', 'set', 'openspec', '--check', '--install-tools'],
      ['workflow', 'set', 'openspec', '--approve-plan', fingerprint, '--install-tools'],
      ['workflow', 'set', 'manual', '--install-tools'],
      ['workflow', 'set', 'spec-kit', '--configure-openspec-profile'],
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
        schemaVersion: 3,
        kind: 'liftoff-workflow-transition-plan',
        operation: 'workflow-transition',
        repairAgents: [],
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

  it('keeps external transitions unavailable while pinned preparation is incomplete', async () => {
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

  it('retains strict read support for saved schema-2 workflow plans', async () => {
    const project = await fixture();
    const report = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root, '--check', '--json'
    ], project.root, project.home)).stdout);
    const {
      operation: _operation,
      repairAgents: _repairAgents,
      fingerprint: _fingerprint,
      ...current
    } = report.plan;
    const unsigned = { ...current, schemaVersion: 2 };
    const legacy = {
      ...unsigned,
      fingerprint: canonicalSha256(unsigned)
    };
    await createScopedUserLocalRecordStore(
      project.root,
      'workflow-transition-plan',
      {
        homedir: project.home,
        env: {},
        clock: () => now
      }
    ).write(legacy.fingerprint, legacy);
    await expect(readWorkflowTransitionPlan(
      project.root,
      legacy.fingerprint,
      now,
      {
        homedir: project.home,
        env: {},
        clock: () => now
      }
    )).resolves.toMatchObject({
      schemaVersion: 2,
      operation: 'workflow-transition',
      repairAgents: [],
      fingerprint: legacy.fingerprint
    });
  });

  for (const target of ['openspec', 'spec-kit'] as const) {
    it(`initializes a Manual project into ${target} through exact official staging`, async () => {
      const project = await fixture();
      const before = await snapshot(project.root);
      const runner = new WorkflowFrameworkRunner();
      const args = [
        'workflow', 'set', target, project.root,
        '--agents', 'copilot',
        ...(target === 'spec-kit'
          ? ['--default-agent', 'copilot']
          : []),
        '--check', '--json'
      ];
      const preview = await invoke(
        args,
        project.root,
        project.home,
        now,
        undefined,
        runner
      );
      expect(preview).toMatchObject({ code: 2, stderr: '' });
      const reviewed = JSON.parse(preview.stdout);
      expect(reviewed).toMatchObject({
        status: 'review-required',
        machineWrites: false,
        plan: {
          schemaVersion: 3,
          source: { workflow: 'manual' },
          target: {
            workflow: target,
            frameworkState: 'initialization-required'
          },
          targetFrameworkInventory: {
            status: 'absent',
            workflow: target,
            activeWork: {
              identifiers: [],
              reconciliation: 'no-existing-history'
            }
          },
          preparation: {
            status: 'ready',
            tools: expect.any(Array)
          },
          execution: {
            status: 'ready-for-file-approval',
            transition: 'manual-to-external-framework',
            frameworkDocuments:
              'official-staged-with-existing-history-preserved',
            targetLocalReadiness: 'official-framework-initialized',
            officialStage: {
              commands: expect.any(Array),
              fileCount: expect.any(Number),
              totalBytes: expect.any(Number),
              digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
            },
            manifestPublishedLast: true,
            effects: expect.arrayContaining([
              expect.objectContaining({
                kind: 'framework',
                operation: 'write'
              }),
              expect.objectContaining({
                kind: 'manifest',
                pathParts: ['liftoff.manifest.json']
              })
            ])
          }
        }
      });
      const applied = await invoke([
        'workflow', 'set', target, project.root,
        '--agents', 'copilot',
        ...(target === 'spec-kit'
          ? ['--default-agent', 'copilot']
          : []),
        '--approve-plan', reviewed.plan.fingerprint,
        '--json'
      ], project.root, project.home, now, undefined, runner);
      expect(applied, applied.stdout).toMatchObject({
        code: 0,
        stderr: ''
      });
      expect(JSON.parse(applied.stdout)).toMatchObject({
        status: 'applied',
        projectWrites: true,
        machineWrites: false,
        transaction: {
          status: 'committed',
          committed: true,
          readbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }
      });
      const manifest = JSON.parse(await readFile(
        path.join(project.root, 'liftoff.manifest.json'),
        'utf8'
      ));
      expect(manifest).toMatchObject({
        project: {
          specWorkflow: target,
          agents: ['github-copilot'],
          ...(target === 'spec-kit'
            ? { defaultAgent: 'github-copilot' }
            : {})
        },
        framework: {
          state: 'initialized',
          adapter: target
        }
      });
      const effects = reviewed.plan.execution.effects as Array<{
        pathParts: string[];
      }>;
      const changed = new Set(
        effects.map(effect => effect.pathParts.join('/'))
      );
      const after = await snapshot(project.root);
      for (const [file, bytes] of Object.entries(before.files)) {
        if (!changed.has(file)) {
          expect(after.files[file], file).toBe(bytes);
        }
      }
    });
  }

  it('binds the complete external target inventory at commit', async () => {
    const project = await fixture();
    const runner = new WorkflowFrameworkRunner();
    const reviewed = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--check', '--json'
    ], project.root, project.home, now, undefined, runner)).stdout);
    const storage = {
      homedir: project.home,
      env: {},
      clock: () => now
    };
    const plan = await readWorkflowTransitionPlan(
      project.root,
      reviewed.plan.fingerprint,
      now,
      storage
    );
    const applied = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot',
      '--approve-plan', reviewed.plan.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(applied.code, applied.stdout).toBe(0);
    await expect(
      assertWorkflowTransitionTargetFrameworkCommitted(plan)
    ).resolves.toBeUndefined();
    await write(
      path.join(project.root, 'openspec', 'changes', 'concurrent', 'proposal.md'),
      '# Concurrent\n'
    );
    await expect(
      assertWorkflowTransitionTargetFrameworkCommitted(plan)
    ).rejects.toThrow(
      'Target framework history or committed output changed during transition'
    );
  });

  it('keeps OpenSpec global-profile permission separate from project approval', async () => {
    const project = await fixture();
    const runner = new WorkflowFrameworkRunner({
      profile: 'minimal',
      delivery: 'skills',
      workflows: []
    });
    const unavailable = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--check', '--json'
    ], project.root, project.home, now, undefined, runner)).stdout);
    expect(unavailable.plan).toMatchObject({
      preparation: {
        status: 'required',
        openSpecProfile: {
          status: 'configuration-required'
        }
      },
      execution: { status: 'unavailable' }
    });
    expect(runner.calls.some(call =>
      call.startsWith('openspec config set '))).toBe(false);

    const prepared = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot',
      '--configure-openspec-profile', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(prepared.code).toBe(2);
    const report = JSON.parse(prepared.stdout);
    expect(report).toMatchObject({
      status: 'review-required',
      readOnly: false,
      projectWrites: false,
      machineWrites: true,
      machineChanges: [expect.stringContaining('OpenSpec global profile')],
      plan: {
        preparation: {
          status: 'ready',
          openSpecProfile: { status: 'ready' }
        },
        execution: { status: 'ready-for-file-approval' }
      }
    });
    expect(runner.calls.some(call =>
      call.startsWith('openspec config set '))).toBe(true);
    expect(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    )).toContain('"specWorkflow": "manual"');
  });

  it('keeps pinned framework installation separate from project-file approval', async () => {
    const project = await fixture();
    const runner = new WorkflowFrameworkRunner(undefined, false);
    const unavailable = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--check', '--json'
    ], project.root, project.home, now, undefined, runner)).stdout);
    expect(unavailable.plan).toMatchObject({
      preparation: {
        status: 'required',
        tools: expect.arrayContaining([
          expect.objectContaining({
            id: 'openspec',
            state: 'missing',
            reasonCode: 'missing-executable',
            installCommand: expect.stringContaining('npm install -g')
          })
        ])
      },
      execution: { status: 'unavailable' }
    });
    expect(runner.calls.some(call =>
      call.startsWith('npm install -g @fission-ai/openspec@'))).toBe(false);

    const prepared = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--install-tools', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(prepared.code).toBe(2);
    expect(JSON.parse(prepared.stdout)).toMatchObject({
      status: 'review-required',
      readOnly: false,
      projectWrites: false,
      machineWrites: true,
      machineChanges: [expect.stringContaining('OpenSpec')],
      plan: {
        preparation: {
          status: 'ready',
          tools: expect.arrayContaining([
            expect.objectContaining({
              id: 'openspec',
              state: 'ready',
              reasonCode: 'compatible'
            })
          ])
        },
        execution: { status: 'ready-for-file-approval' }
      }
    });
    expect(runner.calls.some(call =>
      call.startsWith('npm install -g @fission-ai/openspec@'))).toBe(true);
    expect(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    )).toContain('"specWorkflow": "manual"');
  });

  it('moves between reconciled external frameworks while preserving the source tree', async () => {
    const project = await fixture('openspec');
    const changesRoot = path.join(project.root, 'openspec', 'changes');
    for (const entry of await readdir(changesRoot, {
      withFileTypes: true
    })) {
      if (entry.isDirectory() && entry.name !== 'archive') {
        await rm(path.join(changesRoot, entry.name), {
          recursive: true,
          force: true
        });
      }
    }
    const sourceBefore = await snapshot(
      path.join(project.root, 'openspec')
    );
    const runner = new WorkflowFrameworkRunner();
    const preview = await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(preview.code).toBe(2);
    const reviewed = JSON.parse(preview.stdout);
    expect(reviewed.plan).toMatchObject({
      source: { workflow: 'openspec' },
      target: { workflow: 'spec-kit' },
      frameworkInventory: {
        status: 'preserved',
        activeWork: { identifiers: [] }
      },
      execution: {
        status: 'ready-for-file-approval',
        transition: 'external-framework-to-external-framework'
      }
    });
    const applied = await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--approve-plan', reviewed.plan.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(applied.code, applied.stdout).toBe(0);
    expect(await snapshot(path.join(project.root, 'openspec')))
      .toEqual(sourceBefore);
    expect(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    ))).toMatchObject({
      project: { specWorkflow: 'spec-kit' },
      framework: { state: 'initialized', adapter: 'spec-kit' }
    });
  });

  it('round-trips official Spec Kit installation with a durable specs root', async () => {
    const project = await fixture();
    const runner = new WorkflowFrameworkRunner();
    const specKitPreview = JSON.parse((await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--check', '--json'
    ], project.root, project.home, now, undefined, runner)).stdout);
    const specKitApplied = await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--approve-plan', specKitPreview.plan.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(specKitApplied.code, specKitApplied.stdout).toBe(0);
    expect(await readFile(
      path.join(project.root, 'specs', '.gitkeep')
    )).toEqual(Buffer.alloc(0));
    const specKitBefore = {
      specify: await snapshot(path.join(project.root, '.specify')),
      specs: await snapshot(path.join(project.root, 'specs'))
    };

    const openSpecPreview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--check', '--json'
    ], project.root, project.home, now, undefined, runner)).stdout);
    expect(openSpecPreview.plan).toMatchObject({
      source: { workflow: 'spec-kit' },
      frameworkInventory: {
        status: 'preserved',
        activeWork: { identifiers: [] }
      },
      execution: {
        status: 'ready-for-file-approval',
        transition: 'external-framework-to-external-framework'
      }
    });
    const openSpecApplied = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot',
      '--approve-plan', openSpecPreview.plan.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(openSpecApplied.code, openSpecApplied.stdout).toBe(0);
    expect(await snapshot(path.join(project.root, '.specify')))
      .toEqual(specKitBefore.specify);
    expect(await snapshot(path.join(project.root, 'specs')))
      .toEqual(specKitBefore.specs);

    const roundTrip = await invoke([
      'workflow', 'set', 'spec-kit', project.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(roundTrip.code, roundTrip.stdout).toBe(2);
    expect(JSON.parse(roundTrip.stdout).plan).toMatchObject({
      targetFrameworkInventory: {
        status: 'preserved',
        activeWork: { identifiers: [] }
      },
      execution: { status: 'ready-for-file-approval' }
    });
  });

  it('preserves the generated Spec Kit bootstrap as inactive source history', async () => {
    const project = await fixture('spec-kit');
    const sourceBefore = {
      specify: await snapshot(path.join(project.root, '.specify')),
      specs: await snapshot(path.join(project.root, 'specs'))
    };
    const runner = new WorkflowFrameworkRunner();
    const preview = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(preview.code, preview.stdout).toBe(2);
    const reviewed = JSON.parse(preview.stdout);
    expect(reviewed.plan).toMatchObject({
      source: { workflow: 'spec-kit' },
      frameworkInventory: {
        status: 'preserved',
        activeWork: { identifiers: [] }
      },
      execution: {
        status: 'ready-for-file-approval',
        transition: 'external-framework-to-external-framework'
      }
    });
    const applied = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot',
      '--approve-plan', reviewed.plan.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(applied.code, applied.stdout).toBe(0);
    expect(await snapshot(path.join(project.root, '.specify')))
      .toEqual(sourceBefore.specify);
    expect(await snapshot(path.join(project.root, 'specs')))
      .toEqual(sourceBefore.specs);
  });

  it('blocks occupied output and active preserved target work before project effects', async () => {
    const collision = await fixture();
    const collisionRunner = new WorkflowFrameworkRunner();
    await write(
      path.join(collision.root, 'openspec', 'config.yaml'),
      'developer-owned\n'
    );
    const collided = await invoke([
      'workflow', 'set', 'openspec', collision.root,
      '--agents', 'copilot', '--check', '--json'
    ], collision.root, collision.home, now, undefined, collisionRunner);
    expect(collided.code).toBe(1);
    expect(JSON.parse(collided.stdout).diagnostics.join(' '))
      .toContain('collides with existing bytes');

    const active = await fixture();
    const activeRunner = new WorkflowFrameworkRunner();
    await write(
      path.join(
        active.root,
        'openspec',
        'changes',
        'in-progress',
        'proposal.md'
      ),
      '# In progress\n'
    );
    const blocked = await invoke([
      'workflow', 'set', 'openspec', active.root,
      '--agents', 'copilot', '--check', '--json'
    ], active.root, active.home, now, undefined, activeRunner);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout).diagnostics.join(' '))
      .toContain('Active openspec work overlaps');

    const partial = await fixture();
    const partialRunner = new WorkflowFrameworkRunner();
    await write(
      path.join(partial.root, '.specify', 'history.md'),
      'partial history\n'
    );
    const unsupported = await invoke([
      'workflow', 'set', 'spec-kit', partial.root,
      '--agents', 'copilot', '--default-agent', 'copilot',
      '--check', '--json'
    ], partial.root, partial.home, now, undefined, partialRunner);
    expect(unsupported.code).toBe(1);
    expect(JSON.parse(unsupported.stdout).diagnostics.join(' '))
      .toContain('every framework root must be present or absent');
  });

  it('rejects incomplete official staged output without a project write', async () => {
    const project = await fixture();
    const before = await snapshot(project.root);
    const runner = new WorkflowFrameworkRunner(undefined, true, true);
    const result = await invoke([
      'workflow', 'set', 'openspec', project.root,
      '--agents', 'copilot', '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'blocked',
      projectWrites: false
    });
    expect(JSON.parse(result.stdout).diagnostics.join(' '))
      .toContain('did not produce the tested contract');
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('rejects changed pinned tools or global profile after exact preview', async () => {
    const toolProject = await fixture();
    const toolRunner = new WorkflowFrameworkRunner();
    const toolPreview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', toolProject.root,
      '--agents', 'copilot', '--check', '--json'
    ], toolProject.root, toolProject.home, now, undefined, toolRunner)).stdout);
    toolRunner.setOpenSpecReady(false);
    const changedTool = await invoke([
      'workflow', 'set', 'openspec', toolProject.root,
      '--agents', 'copilot',
      '--approve-plan', toolPreview.plan.fingerprint, '--json'
    ], toolProject.root, toolProject.home, now, undefined, toolRunner);
    expect(changedTool.code).toBe(1);
    expect(JSON.parse(changedTool.stdout).diagnostics.join(' '))
      .toContain('tool or global-profile preparation changed');

    const profileProject = await fixture();
    const profileRunner = new WorkflowFrameworkRunner();
    const profilePreview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', profileProject.root,
      '--agents', 'copilot', '--check', '--json'
    ], profileProject.root, profileProject.home, now, undefined, profileRunner)).stdout);
    profileRunner.setProfile({
      profile: 'minimal',
      delivery: 'skills',
      workflows: []
    });
    const changedProfile = await invoke([
      'workflow', 'set', 'openspec', profileProject.root,
      '--agents', 'copilot',
      '--approve-plan', profilePreview.plan.fingerprint, '--json'
    ], profileProject.root, profileProject.home, now, undefined, profileRunner);
    expect(changedProfile.code).toBe(1);
    expect(JSON.parse(changedProfile.stdout).diagnostics.join(' '))
      .toContain('tool or global-profile preparation changed');
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
          identifiers: source === 'spec-kit'
            ? []
            : [expect.any(String)],
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

  it('recovers interrupted and committed official external transitions through the same authenticated lane', async () => {
    const interrupted = await fixture();
    const interruptedBefore = await snapshot(interrupted.root);
    const interruptedRunner = new WorkflowFrameworkRunner();
    const interruptedPreview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', interrupted.root,
      '--agents', 'copilot', '--check', '--json'
    ], interrupted.root, interrupted.home, now, undefined, interruptedRunner)).stdout);
    await interruptTransition(
      interrupted,
      interruptedPreview.plan.fingerprint,
      'after-mutation',
      0
    );
    const rolledBack = await invoke([
      'workflow', 'set', 'openspec', interrupted.root,
      '--agents', 'copilot', '--recover',
      '--approve-plan', interruptedPreview.plan.fingerprint, '--json'
    ], interrupted.root, interrupted.home, now, undefined, interruptedRunner);
    expect(rolledBack.code).toBe(0);
    expect(JSON.parse(rolledBack.stdout)).toMatchObject({
      status: 'recovered',
      projectWrites: false,
      transaction: {
        status: 'rolled-back',
        committed: false
      }
    });
    expect(await snapshot(interrupted.root)).toEqual(interruptedBefore);

    const committed = await fixture();
    const committedRunner = new WorkflowFrameworkRunner();
    const committedPreview = JSON.parse((await invoke([
      'workflow', 'set', 'openspec', committed.root,
      '--agents', 'copilot', '--check', '--json'
    ], committed.root, committed.home, now, undefined, committedRunner)).stdout);
    await interruptTransition(
      committed,
      committedPreview.plan.fingerprint,
      'committed'
    );
    const finalized = await invoke([
      'workflow', 'set', 'openspec', committed.root,
      '--agents', 'copilot', '--recover',
      '--approve-plan', committedPreview.plan.fingerprint, '--json'
    ], committed.root, committed.home, now, undefined, committedRunner);
    expect(finalized.code, finalized.stdout).toBe(0);
    expect(JSON.parse(finalized.stdout)).toMatchObject({
      status: 'recovered',
      projectWrites: true,
      transaction: {
        status: 'committed',
        committed: true,
        readbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        cleanupFailures: [],
        readbackFailures: []
      }
    });
    expect(JSON.parse(await readFile(
      path.join(committed.root, 'liftoff.manifest.json'),
      'utf8'
    ))).toMatchObject({
      project: { specWorkflow: 'openspec' },
      framework: { state: 'initialized', adapter: 'openspec' }
    });
  });

  it('adds Manual agent integrations without replacing existing agents or unrelated files', async () => {
    const project = await fixture('manual');
    await write(path.join(project.root, 'src', 'owned.ts'), 'keep\n');
    const previewResult = await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home);
    expect(previewResult.code, previewResult.stdout).toBe(2);
    const preview = JSON.parse(previewResult.stdout);
    expect(preview).toMatchObject({
      requestedScope: 'agent-integration',
      status: 'available',
      committed: false,
      agentPlan: {
        operation: 'agent-repair',
        repairAgents: ['codex'],
        source: {
          workflow: 'manual',
          agents: ['github-copilot']
        },
        target: {
          workflow: 'manual',
          agents: ['github-copilot', 'codex']
        },
        execution: {
          status: 'ready-for-file-approval',
          transition: 'agent-integration-repair',
          officialStage: null
        }
      }
    });
    const applied = await invoke([
      'repair', project.root,
      '--approve-plan', preview.fingerprint, '--json'
    ], project.root, project.home);
    expect(applied.code, applied.stdout).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      requestedScope: 'agent-integration',
      status: 'applied',
      committed: true,
      repairScopeComplete: true,
      verification: 'passed'
    });
    expect(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    ))).toMatchObject({
      project: {
        specWorkflow: 'manual',
        agents: ['github-copilot', 'codex']
      }
    });
    expect(await readFile(
      path.join(
        project.root,
        '.agents',
        'skills',
        'liftoff-repair',
        'SKILL.md'
      ),
      'utf8'
    )).toContain('liftoff-repair');
    expect(await readFile(
      path.join(project.root, 'src', 'owned.ts'),
      'utf8'
    )).toBe('keep\n');
  });

  it('uses genuine default-No repair approval without fingerprint entry', async () => {
    const project = await fixture('manual');
    let prompt: { message: string; default: false } | undefined;
    const result = await invoke([
      'repair', project.root, '--agents', 'codex'
    ], project.root, project.home, now, async value => {
      prompt = value;
      return true;
    });
    expect(result.code, result.stdout).toBe(0);
    expect(prompt).toMatchObject({
      default: false,
      message: expect.stringContaining('additive agent repair')
    });
    expect(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    ))).toMatchObject({
      project: { agents: ['github-copilot', 'codex'] }
    });
  });

  it('uses official OpenSpec staging for additive repair while preserving active work', async () => {
    const project = await fixture('openspec');
    const runner = new WorkflowFrameworkRunner();
    const active = path.join(
      project.root,
      'openspec',
      'changes',
      'active-feature',
      'proposal.md'
    );
    await write(active, '# Keep active work\n');
    const previewResult = await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(previewResult.code, previewResult.stdout).toBe(2);
    const preview = JSON.parse(previewResult.stdout);
    expect(preview.agentPlan).toMatchObject({
      operation: 'agent-repair',
      source: { workflow: 'openspec' },
      target: {
        workflow: 'openspec',
        agents: ['github-copilot', 'codex']
      },
      execution: {
        status: 'ready-for-file-approval',
        transition: 'agent-integration-repair',
        frameworkDocuments:
          'official-integration-staged-with-history-preserved',
        officialStage: {
          commands: [
            expect.stringContaining('openspec init --tools')
          ]
        }
      }
    });
    const applied = await invoke([
      'repair', project.root,
      '--approve-plan', preview.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(applied.code, applied.stdout).toBe(0);
    expect(await readFile(active, 'utf8')).toBe('# Keep active work\n');
    for (const parts of openSpecIntegrationPaths('codex')) {
      expect(await readFile(
        path.join(project.root, ...parts),
        'utf8'
      )).toBe('codex\n');
    }
  });

  it('adds a Spec Kit agent and changes the default only when explicitly requested', async () => {
    const project = await fixture('spec-kit');
    const runner = new WorkflowFrameworkRunner();
    const previewResult = await invoke([
      'repair', project.root, '--agents', 'codex',
      '--default-agent', 'codex', '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(previewResult.code, previewResult.stdout).toBe(2);
    const preview = JSON.parse(previewResult.stdout);
    expect(preview.agentPlan).toMatchObject({
      operation: 'agent-repair',
      source: {
        workflow: 'spec-kit',
        defaultAgent: 'github-copilot'
      },
      target: {
        workflow: 'spec-kit',
        agents: ['github-copilot', 'codex'],
        defaultAgent: 'codex'
      },
      execution: {
        officialStage: {
          commands: [
            expect.stringContaining(
              'specify integration install codex'
            ),
            expect.stringContaining(
              'specify integration use codex'
            )
          ]
        }
      }
    });
    const applied = await invoke([
      'repair', project.root,
      '--approve-plan', preview.fingerprint, '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(applied.code, applied.stdout).toBe(0);
    expect(JSON.parse(await readFile(
      path.join(project.root, '.specify', 'integration.json'),
      'utf8'
    ))).toMatchObject({
      default_integration: 'codex',
      installed_integrations: ['copilot', 'codex']
    });
    expect(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    ))).toMatchObject({
      project: {
        agents: ['github-copilot', 'codex'],
        defaultAgent: 'codex'
      }
    });
  });

  it('preserves the Spec Kit default when additive repair omits an exact default change', async () => {
    const project = await fixture('spec-kit');
    const runner = new WorkflowFrameworkRunner();
    const preview = JSON.parse((await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home, now, undefined, runner)).stdout);
    expect(preview.agentPlan).toMatchObject({
      source: { defaultAgent: 'github-copilot' },
      target: {
        agents: ['github-copilot', 'codex'],
        defaultAgent: 'github-copilot'
      }
    });
  });

  it('repairs a missing native integration even when the requested agent is already recorded', async () => {
    const project = await fixture('manual', ['codex']);
    const missing = path.join(
      project.root,
      '.agents',
      'skills',
      'liftoff-repair',
      'SKILL.md'
    );
    await unlink(missing);
    const previewResult = await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home);
    expect(previewResult.code, previewResult.stdout).toBe(2);
    const preview = JSON.parse(previewResult.stdout);
    expect(preview.agentPlan).toMatchObject({
      source: { agents: ['codex'] },
      target: { agents: ['codex'] },
      execution: {
        status: 'ready-for-file-approval',
        effects: expect.arrayContaining([
          expect.objectContaining({
            logicalName: 'liftoff-repair-codex',
            operation: 'write'
          })
        ])
      }
    });
    const applied = await invoke([
      'repair', project.root,
      '--approve-plan', preview.fingerprint, '--json'
    ], project.root, project.home);
    expect(applied.code, applied.stdout).toBe(0);
    expect(await readFile(missing, 'utf8')).toContain('liftoff-repair');
  });

  it('recovers only the authenticated additive agent transaction', async () => {
    const project = await fixture('manual');
    const before = await snapshot(project.root);
    const preview = JSON.parse((await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home)).stdout);
    await interruptTransition(
      project,
      preview.agentPlan.fingerprint,
      'after-mutation',
      0
    );
    const recovered = await invoke([
      'repair', project.root, '--recover',
      '--approve-plan', preview.agentPlan.fingerprint, '--json'
    ], project.root, project.home);
    expect(recovered.code, recovered.stdout).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      requestedScope: 'agent-integration',
      status: 'recovered',
      committed: false,
      agentTransaction: {
        operation: 'recover',
        status: 'rolled-back',
        committed: false
      }
    });
    expect(await snapshot(project.root)).toEqual(before);
  });

  it('rejects agent removal and occupied additive integration destinations', async () => {
    const project = await fixture('manual');
    expect(() => parseArgs([
      'repair', project.root, '--agents', 'none', '--check', '--json'
    ])).toThrow(/cannot select none or remove agents/u);

    const occupied = path.join(
      project.root,
      '.agents',
      'skills',
      'liftoff-repair',
      'SKILL.md'
    );
    await write(occupied, 'custom\n');
    const collision = await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home);
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.stdout)).toMatchObject({
      requestedScope: 'agent-integration',
      status: 'failed',
      committed: false,
      blockers: [
        expect.stringContaining('occupied by different bytes')
      ]
    });
    expect(await readFile(occupied, 'utf8')).toBe('custom\n');
  });

  it('rejects a recomputed saved plan that removes an existing agent', async () => {
    const project = await fixture('manual');
    const preview = JSON.parse((await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home)).stdout);
    const {
      fingerprint: _fingerprint,
      ...unsigned
    } = preview.agentPlan;
    const tamperedUnsigned = {
      ...unsigned,
      target: {
        ...unsigned.target,
        agents: ['codex']
      }
    };
    const tampered = {
      ...tamperedUnsigned,
      fingerprint: canonicalSha256(tamperedUnsigned)
    };
    await createScopedUserLocalRecordStore(
      project.root,
      'workflow-transition-plan',
      {
        homedir: project.home,
        env: {},
        clock: () => now
      }
    ).write(tampered.fingerprint, tampered);
    const result = await invoke([
      'repair', project.root,
      '--approve-plan', tampered.fingerprint, '--json'
    ], project.root, project.home);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).blockers.join(' ')).toContain(
      'preserve its workflow and every existing agent'
    );
  });

  it('rejects unknown official output from additive framework repair', async () => {
    const project = await fixture('openspec');
    const runner = new WorkflowFrameworkRunner(
      undefined,
      true,
      false,
      true
    );
    const result = await invoke([
      'repair', project.root, '--agents', 'codex', '--check', '--json'
    ], project.root, project.home, now, undefined, runner);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestedScope: 'agent-integration',
      status: 'failed',
      committed: false,
      blockers: [
        expect.stringMatching(/unexpected|inventoried/u)
      ]
    });
  });
});
