import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  buildSavedTransitionPlan,
  buildFineGrainedPatCredentialPolicy,
  canonicalCredentialRepository,
  credentialPolicyPathParts,
  calculatePhaseReadiness,
  canonicalApprovalEnvelopeHash,
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity,
  evidenceHeaderDigest,
  evidenceBodyDigest,
  activationEvidenceContexts,
  readActivationInputSnapshot,
  loadActivationState,
  phaseIds,
  previewApplyNext,
  rollbackPlanFromCompletedOperations,
  transitionPlanForPhase,
  validateSavedTransitionPlan,
  type ApprovalEnvelope,
  type EvidenceHeader,
  type GovernancePhaseAdapter,
  type GovernanceSourceOfTruthInspection,
  type GovernanceTransitionInspection,
  type LiveReadbackProof,
  type PhaseEvidenceRecord,
  type PhaseId,
  type TransitionOperation,
  type UserActivationState
} from '../src/governance-activation/index.js';
import { renderCanonicalGovernancePolicy } from '../src/repository-governance.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import { NodeCommandRunner, formatCommand } from '../src/process-runner.js';
import { executeRulesetPhase } from '../src/governance-activation/phase-governance.js';
import type { ExternalCommand, LiftoffManifest } from '../src/types.js';
import { loadManifest } from '../src/application/project/manifest.js';
import {
  fixtureContext as evidenceContextForPhase, fixtureHeader, fixturePayload, fixtureRemoteBinding,
  bindFixtureEvidence, persistFixtureEvidence, writeBootstrapFixture, writeIndependentInfrastructureFixture
} from './governance-activation-fixtures.js';

const scratchRoot = path.join(process.cwd(), '.cache', `governance-transition-tests-${process.pid}`);
afterAll(async () => { await rm(scratchRoot, { recursive: true, force: true }); });
const now = new Date('2026-09-04T00:00:00.000Z');
const isolatedGitEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
  GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: ''
};
let counter = 0;

function nextRoot(name: string): string {
  counter += 1;
  return path.join(scratchRoot, `${name}-${process.pid}-${counter}`);
}

function manifest(projectName: string): LiftoffManifest {
  return {
    artifactVersion: 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name: projectName,
      workload: {
        kind: 'standard',
        apiStack: 'node-fastify',
        cloud: 'azure',
        region: 'eastus',
        frontend: false,
        environments: ['dev']
      },
      specWorkflow: 'openspec',
      agents: ['github-copilot']
    },
    framework: {
      state: 'initialized',
      adapter: 'openspec',
      contractVersion: '1.11.0'
    },
    governance: {
      profile: 'single-maintainer-gitflow',
      policyVersion: '6',
      activationIdentity: currentActivationIdentity,
      state: 'handoff-partial'
    },
    managedArtifacts: [{
      logicalName: 'repository-governance-policy',
      category: 'governance',
      pathParts: ['.liftoff', 'governance', 'policy.md'],
      contentHash: `sha256:${'a'.repeat(64)}`
    }],
    projectArtifacts: []
  };
}

async function writeProject(projectName = 'demo'): Promise<string> {
  const root = nextRoot(projectName);
  await mkdir(path.join(root, '.liftoff', 'governance'), { recursive: true });
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest(projectName), null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, '.liftoff', 'governance', 'policy.md'), renderCanonicalGovernancePolicy(), 'utf8');
  await writeIndependentInfrastructureFixture(root);
  await writeSeed(root, projectName);
  return root;
}

async function writeSeed(root: string, projectName: string): Promise<void> {
  const change = `bootstrap-${projectName}`;
  const capability = 'node-fastify-application-baseline';
  const base = path.join(root, 'openspec', 'changes', change);
  await mkdir(path.join(base, 'specs', capability), { recursive: true });
  await writeFile(path.join(base, '.openspec.yaml'), 'schema: spec-driven\n', 'utf8');
  await writeFile(path.join(base, 'proposal.md'), `## Capabilities\n\n### New Capabilities\n\n- \`${capability}\`: generated baseline\n`, 'utf8');
  await writeFile(path.join(base, 'design.md'), '## Context\nGenerated baseline only.\n', 'utf8');
  await writeFile(path.join(base, 'specs', capability, 'spec.md'), '## ADDED Requirements\n\n### Requirement: Baseline exists\n', 'utf8');
  await writeFile(path.join(base, 'tasks.md'), [
    '- [ ] 1.1 Confirm files',
    '- [ ] 1.2 Confirm deferred behavior',
    '- [ ] 2.1 Run Liftoff manifest validation',
    '- [ ] 2.2 Run backend tests',
    '- [ ] 2.3 Run worker tests',
    '- [ ] 2.4 Run frontend build',
    '- [ ] 2.5 Validate Docker Compose configuration',
    '- [ ] 2.6 Check OpenTofu formatting',
    '- [ ] 2.7 Initialize OpenTofu',
    '- [ ] 2.8 Validate OpenTofu',
    '- [ ] 2.9 Run strict OpenSpec validation',
    '- [ ] 3.1 Archive seed',
    ''
  ].join('\n'), 'utf8');
}

function emptyPhases(): UserActivationState['phases'] {
  return Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
    state: 'pending',
    updatedAt: now.toISOString(),
    evidence: [],
    approvals: [],
    blockers: []
  }])) as UserActivationState['phases'];
}

function validState(overrides: Partial<UserActivationState> = {}): UserActivationState {
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      name: 'owner/repo',
      defaultBranch: 'develop'
    },
    activeChange: null,
    remoteBinding: fixtureRemoteBinding,
    applicability: {
      statePath: 'none',
      privateStagingDast: false,
      credentialRequired: false
    },
    phases: emptyPhases(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function header(phaseId: PhaseId, state = validState(), result: EvidenceHeader['result'] = 'verified'): EvidenceHeader {
  return fixtureHeader(phaseId, { repositoryId: state.repository.id, result });
}

function evidenceRecord(
  phaseId: PhaseId,
  state = validState(),
  result: EvidenceHeader['result'] = 'verified',
  payload?: unknown,
  liveReadback?: readonly LiveReadbackProof[]
): PhaseEvidenceRecord {
  const body = payload ?? fixturePayload(phaseId);
  return {
    evidenceId: `${phaseId}-evidence`,
    header: { ...header(phaseId, state, result), bodyDigest: evidenceBodyDigest(body, liveReadback) },
    payload: body,
    ...(liveReadback ? { liveReadback } : {})
  };
}

function liveProof(phaseId: PhaseId, provider: LiveReadbackProof['provider'], state = validState()): LiveReadbackProof {
  const base = header(phaseId, state);
  return {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: base.repositoryId,
    identity: base.identity,
    phaseGraphHash: base.phaseGraphHash,
    phaseId,
    baselineSha: base.baselineSha,
    inputDigest: base.inputDigest,
    transition: base.transition,
    observedAt: now.toISOString(),
    provider,
    resourceType: provider === 'github' ? 'ruleset' : 'azure-resource',
    resourceId: provider === 'github' ? 'owner/repo/rulesets/1' : '/subscriptions/000/resourceGroups/rg',
    sourceDigest: 'b'.repeat(64),
    readbackDigest: 'b'.repeat(64),
    matches: true
  };
}

async function writeState(root: string, state: UserActivationState): Promise<void> {
  await mkdir(path.join(root, 'governance'), { recursive: true });
  await writeFile(path.join(root, 'governance', 'activation-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function writeEvidence(root: string, record: PhaseEvidenceRecord): Promise<void> {
  const state = (await loadActivationState(root))?.state ?? validState();
  await persistFixtureEvidence(root, state, record);
  await writeState(root, state);
}

async function writeApproval(root: string, state: UserActivationState, phaseId: PhaseId): Promise<ApprovalEnvelope> {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const manifest = await loadManifest(root);
  const context = activationEvidenceContexts(canonicalPhaseGraph, state, await readActivationInputSnapshot(root, manifest), now)[phaseId];
  const plan = transitionPlanForPhase(phase, state, context.transition, root, context.publicationDestination);
  const approval: ApprovalEnvelope = {
    schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
    id: `${phaseId}-approval`,
    ...plan,
    expiresAt: '2030-01-01T00:00:00.000Z',
    approvedAt: now.toISOString(),
    approver: 'owner'
  };
  await mkdir(path.join(root, 'governance', 'approvals'), { recursive: true });
  await writeFile(path.join(root, 'governance', 'approvals', `${approval.id}.json`), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return approval;
}

async function fingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      hash.update(childRelative);
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        hash.update(await readFile(child));
      }
    }
  }
  await visit(root, '');
  return hash.digest('hex');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(args: string[], cwd: string, runner?: CommandRunner): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const native = new NodeCommandRunner();
  const localOnlyRunner: CommandRunner = runner ?? {
    async run(command, options) {
      if (['gh', 'az'].includes(command.executable) ||
        command.executable === 'git' && ['push', 'ls-remote', 'fetch', 'pull', 'clone'].includes(command.args[0]!)) {
        throw new Error('External provider access requires an explicit local fixture transport.');
      }
      return native.run(command, {
        ...options,
        ...(command.executable === 'git' ? { env: { ...options?.env, ...isolatedGitEnvironment } } : {})
      });
    }
  };
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    terminal: { snapshot: true, columns: 100 },
    runner: localOnlyRunner
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

class FailingOpenSpecRunner extends ReadyInitRunner {
  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable === 'openspec' && command.args[0] === 'validate') {
      const base = await super.run(command, options);
      return { ...base, status: 1, stderr: 'strict validation failed\n' };
    }
    return await super.run(command, options);
  }
}

class Phase0Runner extends ReadyInitRunner {
  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable === 'git') {
      this.calls.push(command);
      const args = command.args.join(' ');
      const stdout = args === 'rev-parse --show-toplevel' ? options!.cwd! :
        args === 'rev-parse --verify HEAD' ? 'a'.repeat(40) :
          args === 'symbolic-ref --quiet --short HEAD' ? 'develop' :
            args === 'remote -v' ? 'origin https://github.com/owner/phase0.git (fetch)\norigin https://github.com/owner/phase0.git (push)' :
              args === 'remote get-url --push --all origin' ? 'https://github.com/owner/phase0.git' : '';
      return this.result(command, { stdout });
    }
    if (command.executable === 'gh') {
      this.calls.push(command);
      return this.result(command, {
        stdout: `${JSON.stringify({
          id: 'R_phase0',
          nameWithOwner: 'owner/phase0',
          defaultBranchRef: { name: 'develop' },
          isPrivate: true
        })}\n`
      });
    }
    if (command.executable === 'az' && command.args[0] === 'account') {
      this.calls.push(command);
      return this.result(command, { stdout: '{"id":"sub"}\n' });
    }
    return await super.run(command, options);
  }

  private result(command: ExternalCommand, values: Partial<CommandResult> = {}): CommandResult {
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
}

function sourceNone(): GovernanceSourceOfTruthInspection {
  return {
    status: 'none',
    selected: null,
    candidates: [],
    createPlan: {
      status: 'blocked',
      reason: 'not needed',
      changeId: 'governance-demo',
      workflowKind: 'openspec',
      requiredFacts: []
    }
  };
}

function sourceSelected(): GovernanceSourceOfTruthInspection {
  return {
    status: 'selected',
    selected: {
      changeId: 'governance-demo',
      workflowKind: 'openspec',
      pathParts: ['openspec', 'changes', 'governance-demo'],
      status: 'compatible',
      issues: []
    },
    candidates: [],
    recordActiveChangeOnNextMutation: false,
    reconciliation: {
      status: 'not-required',
      approvalRequired: false,
      preservedPhaseIds: phaseIds,
      invalidPhaseIds: [],
      issues: []
    },
    supersession: {
      records: [],
      invalidRecords: [],
      selectedChangeId: null,
      issues: []
    }
  };
}

async function inspectionFor(input: {
  root: string;
  phaseId: PhaseId;
  state?: UserActivationState;
  evidence?: readonly PhaseEvidenceRecord[];
  approvals?: readonly ApprovalEnvelope[];
  source?: GovernanceSourceOfTruthInspection;
}): Promise<GovernanceTransitionInspection> {
  const state = input.state ?? validState();
  const manifest = await loadManifest(input.root);
  const contexts = activationEvidenceContexts(canonicalPhaseGraph, state, await readActivationInputSnapshot(input.root, manifest), now);
  const evidence: PhaseEvidenceRecord[] = [];
  const plans = [];
  for (const original of input.evidence ?? []) {
    const bound = await bindFixtureEvidence(input.root, state, original);
    evidence.push(bound.record);
    plans.push(bound.plan);
    const reference = { phaseId: original.header.phaseId, evidenceId: original.evidenceId,
      headerDigest: evidenceHeaderDigest(bound.record.header), result: original.header.result };
    state.phases[original.header.phaseId].evidence = [reference];
    contexts[original.header.phaseId].evidenceReferences = [reference];
    if (state.bootstrapState?.remoteImportEvidenceId === original.evidenceId) state.bootstrapState.remoteImportEvidenceDigest = reference.headerDigest;
  }
  for (const phase of phaseIds) contexts[phase].reviewedPlans = plans;
  return {
    projectRoot: input.root,
    manifest,
    graph: canonicalPhaseGraph,
    graphHash: canonicalPhaseGraphHash,
    state,
    approvals: input.approvals ?? [],
    evidence,
    contexts,
    readiness: {
      nextReadyPhase: input.phaseId,
      phases: Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
        state: phaseId === input.phaseId ? 'ready' : 'blocked',
        blockers: []
      }])) as GovernanceTransitionInspection['readiness']['phases']
    },
    sourceOfTruth: input.source ?? sourceSelected()
  };
}

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
});

describe('controlled governance apply-next transitions', () => {
  it('previews exact mutations and requires --execute before any write', async () => {
    const root = await writeProject('preview');
    const before = await fingerprint(root);
    const result = await run(['governance', 'apply-next', '--json'], root);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out);
    expect(body).toMatchObject({
      execute: false,
      applied: false,
      reason: 'execute-required',
      selectedPhase: 'seed-valid',
      noWrites: true,
      nextReadyPhase: 'seed-valid'
    });
    expect(body.proposedMutations.operations.map((op: { actionId: string }) => op.actionId)).toEqual([
      'openspec.seed.validate',
      'governance.evidence.write',
      'governance.activation-state.write'
    ]);
    expect(await fingerprint(root)).toBe(before);
  });

  it('executes at most one seed phase and persists a strict saved plan, evidence, and state', async () => {
    const root = await writeProject('seeded');
    await writeSeed(root, 'seeded');
    const result = await run(['governance', 'apply-next', '--json', '--execute'], root, new ReadyInitRunner());
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out);
    expect(body).toMatchObject({
      applied: true,
      selectedPhase: 'seed-valid',
      executedPhase: 'seed-valid',
      nextReadyPhase: 'seed-valid',
      evidence: { result: 'verified' }
    });
    const planPath = path.join(root, ...body.savedPlan.pathParts);
    expect(validateSavedTransitionPlan(JSON.parse(await readFile(planPath, 'utf8')))).toMatchObject({
      schemaVersion: 1,
      phaseId: 'seed-valid',
      noSecrets: true
    });
    const state = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')) as UserActivationState;
    expect(state.phases['seed-valid'].state).toBe('verified');
    expect(state.phases['seed-verified'].state).toBe('pending');
    expect(body.executedOperations.map((op: { actionId: string }) => op.actionId)).not.toContain('openspec.seed.archive');
  });

  it('persists one stable blocker and does not retry a failed phase automatically', async () => {
    const root = await writeProject('blocked');
    await writeSeed(root, 'blocked');
    const first = await run(['governance', 'apply-next', '--json', '--execute'], root, new FailingOpenSpecRunner());
    expect(first.code).toBe(1);
    expect(JSON.parse(first.out)).toMatchObject({
      selectedPhase: 'seed-valid',
      executedPhase: null
    });
    const state = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')) as UserActivationState;
    expect(state.phases['seed-valid'].state).toBe('blocked');
    expect(state.phases['seed-valid'].blockers).toHaveLength(1);

    const second = await run(['governance', 'apply-next', '--json'], root, new ReadyInitRunner());
    const body = JSON.parse(second.out);
    expect(second.code).toBe(0);
    expect(body.reason).toBe('execute-required');
    expect(body.noWrites).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8'))).toEqual(state);
  });

  it('blocks adapter results that are not terminal states for the phase', async () => {
    const root = await writeProject('illegal-adapter-result');
    const adapter: GovernancePhaseAdapter = {
      phaseId: 'seed-valid',
      async execute() {
        return {
          status: 'completed',
          resultState: 'inapplicable',
          completedOperations: []
        };
      }
    };
    const base = await inspectionFor({ root, phaseId: 'seed-valid', source: sourceNone() });

    const result = await import('../src/governance-activation/transitions.js').then((module) =>
      module.executeApplyNext({
        inspection: base,
        reinspect: async () => base,
        adapters: { phases: { 'seed-valid': adapter } },
        now
      })
    );

    expect(result).toMatchObject({
      applied: false,
      reason: 'blocked',
      evidence: null,
      blockers: [expect.stringContaining('not an allowed terminal state')]
    });
    const state = JSON.parse(
      await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')
    ) as UserActivationState;
    expect(state.phases['seed-valid']).toMatchObject({
      state: 'blocked',
      evidence: []
    });
  });

  it('rejects credential-shaped outcome data before writing evidence or state', async () => {
    const root = await writeProject('secret-shaped-outcome');
    const base = await inspectionFor({ root, phaseId: 'seed-valid', source: sourceNone() });
    const synthetic = ['github', '_pat_', 'SYNTHETIC_VALUE_FOR_TESTS_ONLY_1234567890'].join('');
    await expect(import('../src/governance-activation/transitions.js').then(({ executeApplyNext }) => executeApplyNext({
      inspection: base,
      reinspect: async () => base,
      now,
      adapters: { phases: { 'seed-valid': {
        phaseId: 'seed-valid',
        async execute() {
          return { status: 'completed', resultState: 'verified', evidencePayload: { kind: 'seed-valid.v1', secret: synthetic } };
        }
      } } }
    }))).rejects.toThrow(/Governance evidence contains credential-shaped content/);
    expect(await exists(path.join(root, 'governance', 'activation-state.json'))).toBe(false);
    expect(await exists(path.join(root, 'governance', 'evidence'))).toBe(false);
  });

  it('rolls back local file mutations when evidence/state transaction fails', async () => {
    const root = await writeProject('rollback');
    const adapter: GovernancePhaseAdapter = {
      phaseId: 'workflow-source-ready',
      async execute() {
        return {
          status: 'completed',
          resultState: 'verified',
          evidencePayload: { kind: 'workflow-source-ready.v1', rulesetSourceDigest: 'b'.repeat(64) },
          fileMutations: [
            { type: 'write', pathParts: ['.github', 'workflows', 'marker.yml'], content: 'created\n' },
            { type: 'write', pathParts: ['.github', 'workflows', 'marker.yml', 'child.txt'], content: 'fail\n' }
          ],
          completedOperations: []
        };
      }
    };
    const base = await inspectionFor({ root, phaseId: 'workflow-source-ready' });
    await expect(buildSavedTransitionPlan({ inspection: base, now })).resolves.toBeTruthy();
    await expect(import('../src/governance-activation/transitions.js').then((module) =>
      module.executeApplyNext({
        inspection: base,
        reinspect: async () => base,
        adapters: { phases: { 'workflow-source-ready': adapter } },
        now
      })
    )).rejects.toThrow(/rolled back|Project update failed/);
    expect(await exists(path.join(root, '.github', 'workflows', 'marker.yml'))).toBe(false);
    expect(await exists(path.join(root, 'governance', 'activation-state.json'))).toBe(false);
  });
});

describe('initial Git adapters', () => {
  function git(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnvironment } });
    if (result.status !== 0) {
      throw new Error(`${args.join(' ')} failed: ${result.stderr}`);
    }
  }

  async function prepareCommittedReadyProject(name: string): Promise<{ root: string; state: UserActivationState }> {
    const root = await writeProject(name);
    await writeBootstrapFixture(root, name, true);
    await rm(path.join(root, 'openspec', 'changes', `bootstrap-${name}`), { recursive: true });
    git(root, ['init', '-b', 'develop']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Governance Test']);
    await writeFile(path.join(root, 'README.md'), '# demo\n', 'utf8');
    const state = validState();
    await writeState(root, state);
    for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived'] as const) {
      await writeEvidence(root, evidenceRecord(phaseId, state));
    }
    await writeApproval(root, state, 'committed');
    return { root, state };
  }

  it('commits reviewed project paths without reset, rebase, force, or governance state leakage', async () => {
    const { root } = await prepareCommittedReadyProject('git-clean');
    const result = await run(['governance', 'apply-next', '--json', '--execute'], root);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out);
    expect(body.executedOperations.map((op: { actionId: string }) => op.actionId)).toContain('git.commit-reviewed');
    const forbidden = JSON.stringify(body.executedOperations);
    expect(forbidden).not.toMatch(/reset|rebase|force/);
    const log = spawnSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' });
    expect(log.stdout).toContain('Initial Liftoff baseline');
    const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout;
    expect(tracked).toContain('README.md');
    expect(tracked).not.toContain('governance/activation-state.json');
    const status = await run(['governance', 'status', '--json'], root);
    expect(status.code, status.out + status.err).toBe(0);
    for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived', 'committed']) {
      expect(JSON.parse(status.out).evidenceFreshness.find((entry: { phaseId: string }) => entry.phaseId === phaseId))
        .toMatchObject({ status: 'fresh', selectedResult: 'verified', issues: [] });
    }
    const receipt = JSON.parse(await readFile(path.join(root, ...body.evidence.pathParts), 'utf8'));
    const actualHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    expect(receipt.payload.head).toBe(actualHead);
    expect(receipt.header.baselineSha).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.header.baselineSha).not.toBe(actualHead);
  });

  it('pushes only the approved origin branch and blocks dirty deletion or unexpected branches', async () => {
    const { root } = await prepareCommittedReadyProject('git-push');
    expect((await run(['governance', 'apply-next', '--json', '--execute'], root)).code).toBe(0);
    const remote = path.join(scratchRoot, 'remote.git');
    git(scratchRoot, ['init', '--bare', remote]);
    const reviewedUrl = 'https://github.com/owner/repo.git';
    git(root, ['remote', 'add', 'origin', reviewedUrl]);
    await writeApproval(root, (await loadActivationState(root))!.state, 'pushed');
    const transport = new NodeCommandRunner();
    const localGitTransport: CommandRunner = {
      async run(command, options) {
        if (['gh', 'az'].includes(command.executable) ||
          command.executable === 'git' && ['fetch', 'pull', 'clone'].includes(command.args[0]!)) {
          throw new Error('Unexpected external read is forbidden by the local Git fixture transport.');
        }
        let local = command;
        if (command.executable === 'git' && ['push', 'ls-remote'].includes(command.args[0]!)) {
          const destinationIndex = command.args[0] === 'push' ? 1 : 2;
          if (command.args[destinationIndex] !== reviewedUrl) throw new Error('Unreviewed fixture destination; network transport is forbidden.');
          local = { ...command, args: command.args.map((argument, index) => index === destinationIndex ? remote : argument) };
        }
        const result = await transport.run(local, {
          ...options,
          ...(command.executable === 'git' ? { env: { ...options?.env, ...isolatedGitEnvironment } } : {})
        });
        return { ...result, command, displayCommand: formatCommand(command) };
      }
    };
    const pushed = await run(['governance', 'apply-next', '--json', '--execute'], root, localGitTransport);
    expect(pushed.code, pushed.out + pushed.err).toBe(0);
    const pushedBody = JSON.parse(pushed.out);
    expect(pushedBody.executedOperations.map((op: { actionId: string }) => op.actionId)).toContain('git.push-approved-ref');
    const remoteHeads = spawnSync('git', ['--git-dir', remote, 'show-ref', 'refs/heads/develop'], { encoding: 'utf8' });
    expect(remoteHeads.status).toBe(0);
    const status = await run(['governance', 'status', '--json'], root, localGitTransport);
    expect(status.code, status.out + status.err).toBe(0);
    for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed']) {
      expect(JSON.parse(status.out).evidenceFreshness.find((entry: { phaseId: string }) => entry.phaseId === phaseId))
        .toMatchObject({ status: 'fresh', selectedResult: 'verified', issues: [] });
    }

    const dirtyRoot = (await prepareCommittedReadyProject('git-dirty')).root;
    git(dirtyRoot, ['add', 'README.md']);
    git(dirtyRoot, ['commit', '-m', 'baseline']);
    await rm(path.join(dirtyRoot, 'README.md'));
    const dirty = await run(['governance', 'apply-next', '--json'], dirtyRoot);
    expect(dirty.code).toBe(1);
    expect(JSON.parse(dirty.out).message).toContain('Unknown file deletion');

    const branchRoot = (await prepareCommittedReadyProject('git-branch')).root;
    git(branchRoot, ['checkout', '-b', 'feature']);
    const branch = await run(['governance', 'apply-next', '--json'], branchRoot);
    expect(branch.code).toBe(1);
    expect(JSON.parse(branch.out).message).toContain('Expected branch develop');
  });
});

describe('phase 0, rulesets, rollback, and retention guards', () => {
  it('blocks remote readiness when the selected import proof reports failure', async () => {
    const root = await writeProject('failed-import');
    const state = validState({
      applicability: { statePath: 'bootstrap-local', privateStagingDast: true, credentialRequired: false }
    });
    const inspection = await inspectionFor({
      root, phaseId: 'remote-ready', state,
      evidence: [evidenceRecord('remote-import-verified', state, 'failed', {
        kind: 'remote-import-verified.v1'
      }, [liveProof('remote-import-verified', 'azure', state)])]
    });
    const before = await fingerprint(root);
    const preview = await previewApplyNext({ inspection, now, execute: false });
    expect(preview.authorized).toBe(false);
    expect(preview.message).toContain('successful proof from the selected backend path');
    expect(await fingerprint(root)).toBe(before);
  });

  it('does not label missing selected-bootstrap retention as inapplicable', async () => {
    const root = await writeProject('missing-retention');
    const state = validState({
      applicability: { statePath: 'bootstrap-local', privateStagingDast: true, credentialRequired: false }
    });
    const approval = await writeApproval(root, state, 'bootstrap-state-disposed');
    const inspection = await inspectionFor({
      root, phaseId: 'bootstrap-state-disposed', state, approvals: [approval]
    });
    const result = await import('../src/governance-activation/transitions.js').then(({ executeApplyNext }) =>
      executeApplyNext({ inspection, reinspect: async () => inspection, now }));
    expect(result.applied).toBe(false);
    expect(result.evidence).toBeNull();
    expect(result.message).toContain('recorded retention inventory');
  });

  it('runs Phase 0 through read-only literal commands and writes no active change before approval', async () => {
    const root = await writeProject('phase0');
    const runner = new Phase0Runner();
    const inspection = await inspectionFor({ root, phaseId: 'phase-0-complete', source: sourceNone() });
    const result = await import('../src/governance-activation/transitions.js').then(({ executeApplyNext }) =>
      executeApplyNext({ inspection, reinspect: async () => inspection, runner, now }));
    expect(result.applied, result.message).toBe(true);
    const commands = runner.calls.map((command) => `${command.executable} ${command.args.join(' ')}`);
    expect(commands).toContain('gh repo view owner/phase0 --json id,nameWithOwner,defaultBranchRef,isPrivate');
    expect(commands).not.toContain('az account show --output json');
    expect(commands.some((command) => /\b(gh repo create|gh api --method (POST|PATCH)|az deployment|tofu apply)\b/u.test(command))).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')).activeChange).toBeNull();
    expect((await readdir(path.join(root, 'openspec', 'changes'))).some((name) => name.startsWith('governance-'))).toBe(false);
  });

  it('requires exact green/red proof and live ruleset readback matching saved source', async () => {
    const root = await writeProject('rulesets');
    const state = validState();
    state.phases['enforcement-approved'].state = 'approved';
    const sourceDigest = 'b'.repeat(64);
    const evidence = [
      evidenceRecord('workflow-source-ready', state, 'verified', {
        kind: 'workflow-source-ready.v1',
        rulesetSourceDigest: sourceDigest
      }),
      evidenceRecord('green-red-proof', state, 'verified', {
        kind: 'green-red-proof.v1',
        green: { conclusion: 'success', checkName: 'required' },
        deliberateRed: { conclusion: 'failure', deliberate: true, checkName: 'required' }
      }, [liveProof('green-red-proof', 'github', state)])
    ];
    const approval = await writeApproval(root, state, 'rulesets-applied');
    const inspection = await inspectionFor({
      root,
      phaseId: 'rulesets-applied',
      state,
      evidence,
      approvals: [approval]
    });
    const intactSource = inspection.evidence[0]!;
    inspection.evidence = [{
      ...intactSource,
      payload: { ...(intactSource.payload as Record<string, unknown>), rulesetSourceDigest: 'c'.repeat(64) }
    }, ...inspection.evidence];
    const expiringPlan = (await buildSavedTransitionPlan({ inspection, now }))!;
    let unexpectedProviderAccess = false;
    const expired = await executeRulesetPhase({
      inspection, plan: expiringPlan,
      phase: canonicalPhaseGraph.phases.find((phase) => phase.id === 'rulesets-applied')!,
      runner: new ReadyInitRunner(), now, clock: () => new Date(expiringPlan.expiresAt),
      adapters: { githubRulesets: {
        async applyRuleset() { unexpectedProviderAccess = true; throw new Error('Expired plan cannot access a provider.'); },
        async readRuleset() { unexpectedProviderAccess = true; throw new Error('Expired plan cannot access a provider.'); }
      } }
    });
    expect(expired?.status).toBe('blocked');
    expect(expired?.blocker).toContain('expired');
    expect(unexpectedProviderAccess).toBe(false);
    const expiredApproval = await executeRulesetPhase({
      inspection: { ...inspection, approvals: inspection.approvals.map((envelope) => ({
        ...envelope, expiresAt: new Date(now.getTime() + 1000).toISOString()
      })) },
      plan: expiringPlan,
      phase: canonicalPhaseGraph.phases.find((phase) => phase.id === 'rulesets-applied')!,
      runner: new ReadyInitRunner(), now, clock: () => new Date(now.getTime() + 2000),
      adapters: { githubRulesets: {
        async applyRuleset() { unexpectedProviderAccess = true; throw new Error('Expired approval cannot access a provider.'); },
        async readRuleset() { unexpectedProviderAccess = true; throw new Error('Expired approval cannot access a provider.'); }
      } }
    });
    expect(expiredApproval?.blocker).toContain('approval is no longer valid');
    expect(unexpectedProviderAccess).toBe(false);
    const module = await import('../src/governance-activation/transitions.js');
    const result = await module.executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      now,
      adapters: {
        githubRulesets: {
          async applyRuleset(input) {
            expect(input.sourceDigest).toBe(sourceDigest);
            return { resourceId: '/repos/owner/repo/rulesets/1', sourceDigest, readbackDigest: sourceDigest };
          },
          async readRuleset() {
            return { resourceId: '/repos/owner/repo/rulesets/1', sourceDigest, readbackDigest: sourceDigest };
          }
        }
      }
    });
    expect(result.applied).toBe(true);
    expect(result.evidence?.result).toBe('verified');

    const skippedRoot = await writeProject('rulesets-skipped');
    const skippedApproval = await writeApproval(skippedRoot, state, 'rulesets-applied');
    const skipped = await inspectionFor({
      root: skippedRoot,
      phaseId: 'rulesets-applied',
      state,
      evidence: [
        evidence[0]!,
        evidenceRecord('green-red-proof', state, 'verified', {
          kind: 'green-red-proof.v1',
          green: { conclusion: 'skipped', checkName: 'required' },
          deliberateRed: { conclusion: 'failure', deliberate: true, checkName: 'required' }
        }, [liveProof('green-red-proof', 'github', state)])
      ],
      approvals: [skippedApproval]
    });
    const blocked = await module.executeApplyNext({
      inspection: skipped,
      reinspect: async () => skipped,
      now,
      adapters: {
        githubRulesets: {
          async applyRuleset() {
            return { resourceId: '/repos/owner/repo/rulesets/1', sourceDigest, readbackDigest: sourceDigest };
          },
          async readRuleset() {
            return { resourceId: '/repos/owner/repo/rulesets/1', sourceDigest, readbackDigest: sourceDigest };
          }
        }
      }
    });
    expect(blocked.applied).toBe(false);
    expect(blocked.message).toContain('Skipped, cancelled, and neutral');
  });

  it.each([false, true])('keeps unavailable credential enrollment/readback blocked even with policy metadata present=%s', async (policyPresent) => {
    const root = await writeProject(`credential-${policyPresent}`);
    if (policyPresent) {
      const policy = buildFineGrainedPatCredentialPolicy({
        repository: canonicalCredentialRepository({ id: 'R_REMOTE', owner: 'owner', name: 'repo' }),
        allowedWorkflows: [{ path: '.github/workflows/preflight.yml', jobs: ['runner-preflight'] }],
        createdAt: now,
        proof: { verifiedAt: now.toISOString(), readbackDigest: 'a'.repeat(64), readbackProvider: 'adapter-fixture', payloadFree: true }
      });
      await mkdir(path.join(root, ...credentialPolicyPathParts.slice(0, -1)), { recursive: true });
      await writeFile(path.join(root, ...credentialPolicyPathParts), JSON.stringify(policy));
    }
    const state = validState({
      applicability: {
        statePath: 'none',
        privateStagingDast: false,
        credentialRequired: true
      }
    });
    const approval = await writeApproval(root, state, 'credential-ready');
    const inspection = await inspectionFor({
      root,
      phaseId: 'credential-ready',
      state,
      approvals: [approval]
    });
    const module = await import('../src/governance-activation/transitions.js');
    const result = await module.executeApplyNext({
      inspection,
      reinspect: async () => inspection,
      now
    });
    expect(result.applied).toBe(false);
    expect(result.message).toMatch(/credential (?:enrollment|readback).*unavailable/i);
    expect(result.message).not.toContain('secure masked input channel');
    expect(result.evidence).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/github_pat_|gh[pousr]_/);
  });

  it('excludes retained provider registrations from rollback and keeps day-30 disposal pending until due', async () => {
    const providerOperation: TransitionOperation = {
      adapter: 'azure-opentofu',
      actionId: 'azure.provider.ensure-ready',
      mutationClass: 'azure-provider-register',
      phaseId: 'provider-ready',
      inputs: {},
      destination: { type: 'subscription', identity: 'sub', subscriptionId: 'sub' },
      remote: true,
      destructive: false
    };
    const rollback = rollbackPlanFromCompletedOperations('provider-ready', 'retain', null, [providerOperation]);
    expect(rollback.operations).toHaveLength(0);
    expect(rollback.retained[0]).toContain('provider-registration');
    expect(JSON.stringify(rollback)).not.toMatch(/unregister/i);

    const root = await writeProject('retention');
    const state = validState({
      applicability: {
        statePath: 'bootstrap-local',
        privateStagingDast: true,
        credentialRequired: false
      }
    });
    const remoteImport = evidenceRecord('remote-import-verified', state, 'verified', {
      kind: 'remote-import-verified.v1',
      encryptedStatePathParts: [['infrastructure', 'bootstrap.tfstate.enc']],
      encryptionKeyPathParts: [['infrastructure', 'bootstrap.key']],
      remoteBackendDigest: 'c'.repeat(64),
      noChangePlanDigest: 'd'.repeat(64)
    }, [liveProof('remote-import-verified', 'azure', state)]);
    const remoteReady = await inspectionFor({
      root,
      phaseId: 'remote-ready',
      state,
      evidence: [remoteImport]
    });
    const module = await import('../src/governance-activation/transitions.js');
    const retained = await module.executeApplyNext({
      inspection: remoteReady,
      reinspect: async () => remoteReady,
      now
    });
    expect(retained.applied).toBe(true);
    const retainedState = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')) as UserActivationState;
    expect(retainedState.bootstrapState?.disposeAfter).toBe('2026-10-04T00:00:00.000Z');

    const readiness = calculatePhaseReadiness({
      state: retainedState,
      approvals: [],
      evidence: [],
      transitionContexts: activationEvidenceContexts(canonicalPhaseGraph, retainedState, await readActivationInputSnapshot(root, await loadManifest(root))),
      now: new Date('2026-10-03T23:59:59.000Z')
    });
    expect(readiness.phases['bootstrap-state-disposed'].state).toBe('blocked');
    expect(readiness.phases['bootstrap-state-disposed'].blockers[0]).toContain('not disposable until');

    const disposalRoot = await writeProject('disposal');
    const retainedForDisposal = validState({
      applicability: {
        statePath: 'bootstrap-local',
        privateStagingDast: true,
        credentialRequired: false
      }
    });
    const retainedImport = evidenceRecord('remote-import-verified', retainedForDisposal, 'verified', {
      kind: 'remote-import-verified.v1',
      encryptedStatePathParts: [['infrastructure', 'bootstrap.tfstate.enc']],
      encryptionKeyPathParts: [['infrastructure', 'bootstrap.key']],
      remoteBackendDigest: 'c'.repeat(64),
      noChangePlanDigest: 'd'.repeat(64)
    }, [liveProof('remote-import-verified', 'azure', retainedForDisposal)]);
    retainedForDisposal.bootstrapState = {
      status: 'retained',
      remoteImportEvidenceId: retainedImport.evidenceId,
      remoteImportEvidenceDigest: evidenceHeaderDigest(retainedImport.header),
      retainedAt: now.toISOString(),
      disposeAfter: '2026-10-04T00:00:00.000Z',
      encryptedStatePathParts: [['infrastructure', 'bootstrap.tfstate.enc']],
      encryptionKeyPathParts: [['infrastructure', 'bootstrap.key']]
    };
    await mkdir(path.join(disposalRoot, 'infrastructure'), { recursive: true });
    await writeFile(path.join(disposalRoot, 'infrastructure', 'bootstrap.tfstate.enc'), 'encrypted-state\n', 'utf8');
    await writeFile(path.join(disposalRoot, 'infrastructure', 'bootstrap.key'), 'key-id-only\n', 'utf8');
    const disposalApproval = await writeApproval(disposalRoot, retainedForDisposal, 'bootstrap-state-disposed');
    const disposalInspection = await inspectionFor({
      root: disposalRoot,
      phaseId: 'bootstrap-state-disposed',
      state: retainedForDisposal,
      evidence: [retainedImport],
      approvals: [disposalApproval]
    });
    const badPathsRoot = await writeProject('disposal-unbound-path');
    await writeFile(path.join(badPathsRoot, 'protected.txt'), 'preserve this file\n');
    const badPathsState = structuredClone(retainedForDisposal);
    badPathsState.bootstrapState!.encryptedStatePathParts = [['protected.txt']];
    const badPathsApproval = await writeApproval(badPathsRoot, badPathsState, 'bootstrap-state-disposed');
    const badPaths = await inspectionFor({
      root: badPathsRoot, phaseId: 'bootstrap-state-disposed', state: badPathsState,
      evidence: [retainedImport], approvals: [badPathsApproval]
    });
    const refused = await module.executeApplyNext({
      inspection: badPaths, reinspect: async () => badPaths, now: new Date('2026-10-04T00:00:00.000Z')
    });
    expect(refused.applied).toBe(false);
    expect(refused.message).toContain('Disposal paths differ');
    expect(await readFile(path.join(badPathsRoot, 'protected.txt'), 'utf8')).toBe('preserve this file\n');
    const disposed = await module.executeApplyNext({
      inspection: disposalInspection,
      reinspect: async () => disposalInspection,
      now: new Date('2026-10-04T00:00:00.000Z')
    });
    expect(disposed.applied).toBe(true);
    expect(disposed.evidence?.result).toBe('disposed');
    expect(await exists(path.join(disposalRoot, 'infrastructure', 'bootstrap.tfstate.enc'))).toBe(false);
    expect(await exists(path.join(disposalRoot, 'infrastructure', 'bootstrap.key'))).toBe(false);
    const deletionEvidence = JSON.parse(await readFile(path.join(disposalRoot, ...disposed.evidence!.pathParts), 'utf8'));
    expect(deletionEvidence.payload).toMatchObject({
      kind: 'bootstrap-state-disposed.v1',
      payloadFree: true,
      remoteBackendDigest: 'c'.repeat(64),
      noChangePlanDigest: 'd'.repeat(64)
    });
  });
});
