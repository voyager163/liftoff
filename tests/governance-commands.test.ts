import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  canonicalApprovalEnvelopeHash,
  canonicalSha256,
  currentActivationIdentity,
  evidenceContextForPhase,
  governanceChangeMetadataFileName,
  phaseIds,
  renderGovernanceChangeWritePlan,
  transitionPlanForPhase,
  writeGovernanceChangeArtifacts,
  type ApprovedPhase0Facts,
  type ApprovalEnvelope,
  type EvidenceHeader,
  type LiveReadbackProof,
  type PhaseId,
  type UserActivationState
} from '../src/governance-activation/index.js';
import { renderCanonicalGovernancePolicy } from '../src/repository-governance.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import type { CommandRunner, CommandResult, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

const scratchRoot = path.join(process.cwd(), '.cache', 'governance-command-tests');
let counter = 0;

function nextRoot(name: string): string {
  counter += 1;
  return path.join(scratchRoot, `${name}-${process.pid}-${counter}`);
}

function manifest(projectName: string): string {
  return `${JSON.stringify({
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
  }, null, 2)}\n`;
}

async function writeProject(name = 'demo-app'): Promise<string> {
  const root = nextRoot(name);
  await mkdir(path.join(root, '.liftoff', 'governance'), { recursive: true });
  await writeFile(path.join(root, 'liftoff.manifest.json'), manifest(name), 'utf8');
  await writeFile(path.join(root, '.liftoff', 'governance', 'policy.md'), renderCanonicalGovernancePolicy(), 'utf8');
  return root;
}

function validState(overrides: Partial<UserActivationState> = {}): UserActivationState {
  const phases = {} as UserActivationState['phases'];
  for (const phaseId of phaseIds) {
    phases[phaseId] = {
      state: 'pending',
      updatedAt: '2026-09-04T00:00:00.000Z',
      evidence: [],
      approvals: [],
      blockers: []
    };
  }
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      name: 'owner/repo',
      defaultBranch: 'develop'
    },
    activeChange: null,
    applicability: {
      statePath: 'none',
      privateStagingDast: false,
      credentialRequired: false
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  };
}

function header(phaseId: PhaseId, overrides: Partial<EvidenceHeader> = {}): EvidenceHeader {
  const context = evidenceContextForPhase(phaseId, {
    repositoryId: 'R_123',
    identity: currentActivationIdentity,
    phaseGraphHash: canonicalPhaseGraphHash
  });
  return {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: context.repositoryId,
    identity: context.identity,
    phaseGraphHash: context.phaseGraphHash,
    phaseId,
    phaseContractDigest: context.phaseContractDigest,
    inputDigest: context.inputDigest,
    baselineSha: context.baselineSha,
    transition: context.transition,
    producedAt: '2026-09-04T00:00:00.000Z',
    producer: 'vitest',
    result: 'verified',
    ...overrides
  };
}

function phase0Facts(projectName: string, baselineSha = 'a'.repeat(64)): ApprovedPhase0Facts {
  return {
    projectName,
    repositoryId: 'R_123',
    repositoryName: 'owner/repo',
    defaultBranch: 'develop',
    workflowKind: 'openspec',
    baselineSha,
    evidenceIds: ['phase0'],
    approvedFacts: [
      { id: 'repositoryId', value: 'R_123' },
      { id: 'repositoryName', value: 'owner/repo' },
      { id: 'defaultBranch', value: 'develop' }
    ],
    approvedAt: '2026-09-04T00:00:00.000Z',
    approver: 'owner'
  };
}

async function writeGovernancePlan(root: string, projectName: string, baselineSha = 'a'.repeat(64)): Promise<string> {
  const plan = renderGovernanceChangeWritePlan(phase0Facts(projectName, baselineSha));
  await writeGovernanceChangeArtifacts(root, plan);
  return plan.changeId;
}

function liveProof(phaseId: PhaseId, provider: LiveReadbackProof['provider'], matches = true): LiveReadbackProof {
  const base = header(phaseId);
  return {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: base.repositoryId,
    identity: base.identity,
    phaseGraphHash: base.phaseGraphHash,
    phaseId,
    baselineSha: base.baselineSha,
    inputDigest: base.inputDigest,
    transition: base.transition,
    observedAt: '2026-09-04T00:00:00.000Z',
    provider,
    resourceType: provider === 'github' ? 'ruleset' : 'azure-resource',
    resourceId: provider === 'github' ? 'owner/repo/rulesets/1' : '/subscriptions/000/resourceGroups/rg',
    sourceDigest: 'b'.repeat(64),
    readbackDigest: 'b'.repeat(64),
    matches
  };
}

async function writeState(root: string, state: UserActivationState): Promise<void> {
  await mkdir(path.join(root, 'governance'), { recursive: true });
  await writeFile(path.join(root, 'governance', 'activation-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function writeEvidence(root: string, name: string, value: unknown): Promise<void> {
  await mkdir(path.join(root, 'governance', 'evidence'), { recursive: true });
  await writeFile(path.join(root, 'governance', 'evidence', `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeApproval(
  root: string,
  phaseId: PhaseId,
  state: UserActivationState = validState()
): Promise<ApprovalEnvelope> {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const context = evidenceContextForPhase(phaseId, {
    repositoryId: state.repository.id,
    identity: currentActivationIdentity,
    phaseGraphHash: currentActivationIdentity.phaseGraphHash
  });
  const plan = transitionPlanForPhase(phase, state, context.transition);
  const approval: ApprovalEnvelope = {
    schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
    id: `${phaseId}-approval`,
    ...plan,
    expiresAt: '2030-01-01T00:00:00.000Z',
    approvedAt: '2026-09-04T00:00:00.000Z',
    approver: 'owner'
  };
  await mkdir(path.join(root, 'governance', 'approvals'), { recursive: true });
  await writeFile(
    path.join(root, 'governance', 'approvals', `${approval.id}.json`),
    `${JSON.stringify(approval, null, 2)}\n`,
    'utf8'
  );
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
      } else {
        hash.update('other');
      }
    }
  }
  await visit(root, '');
  return hash.digest('hex');
}

async function run(
  args: string[],
  cwd: string,
  runner?: CommandRunner
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    terminal: { snapshot: true, columns: 100 },
    ...(runner ? { runner } : {})
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

class AuthorityBoundaryRunner extends ReadyInitRunner {
  forbidden: string[] = [];

  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    const key = `${command.executable} ${command.args.join(' ')}`;
    if (
      command.executable === 'gh' ||
      (command.executable === 'git' && /(?:^| )(init|commit|push|remote|reset|rebase|branch)(?: |$)/u.test(key)) ||
      (command.executable === 'az' && !key.startsWith('az version')) ||
      /(?:secret|credential|ruleset|enforcement)/iu.test(key)
    ) {
      this.forbidden.push(key);
    }
    return await super.run(command, options);
  }
}

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
});

describe('governance command parsing and discovery', () => {
  it('strictly parses governance subcommands, flags, project arguments, and help', async () => {
    expect(parseArgs(['governance', 'status', '--json']).subcommand).toBe('status');
    expect(parseArgs(['governance', 'apply-next', '--execute']).flags.execute).toBe(true);
    expect(parseArgs(['governance', 'plan', 'project', '--project', 'other']).flags.project).toBe('other');
    expect(() => parseArgs(['governance', 'stats'])).toThrow(/Unsupported governance subcommand/);
    expect(() => parseArgs(['governance', 'status', '--unknown'])).toThrow(/Unknown flag/);
    expect(() => parseArgs(['governance', 'status', 'one', 'two'])).toThrow(/Too many positional/);

    const missing = await run(['governance', '--json'], scratchRoot);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Missing governance subcommand');

    const help = await run(['governance', '--help'], scratchRoot);
    expect(help.code).toBe(0);
    expect(help.out).toContain('status');
    expect(help.out).toContain('apply-next');
  });

  it('resolves root, nested cwd, explicit paths, and rejects outside directories without writes', async () => {
    const root = await writeProject('discover');
    const nested = path.join(root, 'src', 'deep');
    await mkdir(nested, { recursive: true });
    const outsideBefore = await fingerprint(scratchRoot);

    const fromRoot = await run(['governance', 'status', '--json'], root);
    const fromNested = await run(['governance', 'status', '--json'], nested);
    const explicit = await run(['governance', 'status', '--json', root], scratchRoot);
    const outside = await run(['governance', 'status', '--json'], scratchRoot);

    expect(fromRoot.code).toBe(0);
    expect(JSON.parse(fromRoot.out).projectRoot).toBe(root);
    expect(JSON.parse(fromNested.out).projectRoot).toBe(root);
    expect(JSON.parse(explicit.out).projectRoot).toBe(root);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain('No liftoff.manifest.json found');
    expect(outside.err).toContain('Run this command inside a Liftoff project or provide its path explicitly');
    expect(await fingerprint(scratchRoot)).toBe(outsideBefore);
  });
});

describe('governance status, plan, resume, verify, and apply-next', () => {
  it('emits status schema v1 identity, graph hash, blockers, approvals, and evidence freshness without setup skill version', async () => {
    const root = await writeProject('status');
    const result = await run(['governance', 'status', '--json'], root);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out);
    expect(body.schemaVersion).toBe(1);
    expect(body.activationIdentity).toEqual(currentActivationIdentity);
    expect(body.graphHash).toBe(canonicalPhaseGraphHash);
    expect(body.nextReadyPhase).toBe('seed-valid');
    expect(body.activeChange).toBeNull();
    expect(body.phases).toHaveLength(phaseIds.length);
    expect(body.phases[0].approval).toMatchObject({
      questionKind: null,
      approvalRequired: false,
      status: 'not-required',
      envelopeHash: null
    });
    expect(body.evidenceFreshness[0]).toMatchObject({ phaseId: 'seed-valid', status: 'missing' });
    expect(JSON.stringify(body)).not.toMatch(/setup[-_]?skill/i);
    expect(result.err).toBe('');
  });

  it('distinguishes consistent verification from setup completion before activation starts', async () => {
    const root = await writeProject('verify-not-started');

    const result = await run(['governance', 'verify', '--json'], root);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      consistent: true,
      verificationStatus: 'consistent',
      complete: false,
      setupStatus: 'not-started',
      stateSource: 'not-started',
      nextReadyPhase: 'seed-valid',
      summary: expect.stringContaining('setup has not started')
    });
  });

  it('reports setup in progress until every phase reaches a successful terminal state', async () => {
    const root = await writeProject('verify-in-progress');
    const state = validState();
    const evidence = header('seed-valid');
    state.phases['seed-valid'] = {
      state: 'verified',
      updatedAt: '2026-09-04T00:00:00.000Z',
      evidence: [{
        phaseId: 'seed-valid',
        evidenceId: 'seed-valid-current',
        headerDigest: canonicalSha256(evidence),
        result: 'verified'
      }],
      approvals: [],
      blockers: []
    };
    await writeState(root, state);
    await writeEvidence(root, 'seed-valid-current', evidence);

    const result = await run(['governance', 'verify', '--json'], root);

    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: true,
      verificationStatus: 'consistent',
      complete: false,
      setupStatus: 'in-progress',
      stateSource: 'user',
      nextReadyPhase: 'seed-verified'
    });
  });

  it('reports setup complete only when every phase is successfully terminal', async () => {
    const root = await writeProject('verify-complete');
    const state = validState();
    for (const phase of canonicalPhaseGraph.phases) {
      const phaseId = phase.id;
      if (phase.applicability.kind !== 'always') {
        continue;
      }
      const resultState = phase.terminalStates.find((candidate) => candidate !== 'failed')!;
      if (resultState === 'approved') {
        state.phases[phaseId] = {
          state: resultState,
          updatedAt: '2026-09-04T00:00:00.000Z',
          evidence: [],
          approvals: [],
          blockers: []
        };
        continue;
      }
      const evidence = header(phaseId, { result: resultState });
      const evidenceId = `${phaseId}-complete`;
      const providers = phase.evidence.liveReadbackProviders;
      state.phases[phaseId] = {
        state: resultState,
        updatedAt: '2026-09-04T00:00:00.000Z',
        evidence: [{
          phaseId,
          evidenceId,
          headerDigest: canonicalSha256(evidence),
          result: resultState
        }],
        approvals: [],
        blockers: []
      };
      await writeEvidence(
        root,
        evidenceId,
        providers.length === 0
          ? evidence
          : {
              evidenceId,
              header: evidence,
              liveReadback: providers.map((provider) => liveProof(phaseId, provider))
            }
      );
    }
    for (const phaseId of [
      'committed',
      'pushed',
      'activation-approved',
      'application-foundation',
      'enforcement-approved',
      'rulesets-applied'
    ] as const) {
      const approval = await writeApproval(root, phaseId, state);
      state.phases[phaseId] = {
        ...state.phases[phaseId],
        approvals: [approval.id]
      };
    }
    await writeState(root, state);

    const result = await run(['governance', 'verify', '--json'], root);

    expect(result.code, result.out).toBe(0);
    expect(JSON.parse(result.out), result.out).toMatchObject({
      ok: true,
      verificationStatus: 'consistent',
      complete: true,
      setupStatus: 'complete',
      stateSource: 'user',
      nextReadyPhase: null
    });
  });

  it('rejects terminal states that the phase graph does not allow', async () => {
    const root = await writeProject('verify-illegal-terminal');
    const state = validState();
    const evidence = header('seed-valid', { result: 'inapplicable' });
    state.phases['seed-valid'] = {
      state: 'inapplicable',
      updatedAt: '2026-09-04T00:00:00.000Z',
      evidence: [{
        phaseId: 'seed-valid',
        evidenceId: 'seed-valid-illegal',
        headerDigest: canonicalSha256(evidence),
        result: 'inapplicable'
      }],
      approvals: [],
      blockers: []
    };
    await writeState(root, state);
    await writeEvidence(root, 'seed-valid-illegal', evidence);

    const status = await run(['governance', 'status', '--json'], root);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({
      nextReadyPhase: null
    });
    expect(JSON.parse(status.out).phases.find((phase: { id: string }) =>
      phase.id === 'seed-valid'
    )).toMatchObject({
      state: 'blocked',
      blockers: [expect.stringContaining('not an allowed terminal state')]
    });

    const result = await run(['governance', 'verify', '--json'], root);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      verificationStatus: 'inconsistent',
      setupStatus: 'in-progress',
      complete: false
    });
    expect(JSON.parse(result.out).checks.find((check: { id: string }) =>
      check.id === 'phase-terminal-state'
    ).issues).toContainEqual(expect.stringContaining('not an allowed terminal state'));
  });

  it('rejects forbidden evidence before conditional applicability can mask it', async () => {
    const root = await writeProject('verify-inapplicable-illegal-evidence');
    await writeState(root, validState());
    const evidence = header('state-path-selected', { result: 'disposed' });
    await writeEvidence(root, 'state-path-selected-illegal', evidence);

    const status = await run(['governance', 'status', '--json'], root);

    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).phases.find((phase: { id: string }) =>
      phase.id === 'state-path-selected'
    )).toMatchObject({
      state: 'blocked',
      blockers: [expect.stringContaining('not an allowed terminal state')]
    });

    const verify = await run(['governance', 'verify', '--json'], root);
    expect(verify.code).toBe(1);
    expect(JSON.parse(verify.out).checks.find((check: { id: string }) =>
      check.id === 'phase-terminal-state'
    )).toMatchObject({
      status: 'failed',
      issues: [expect.stringContaining('Evidence state-path-selected-illegal reports disposed')]
    });
  });

  it('renders concise human output for every subcommand and keeps apply-next preview read-only', async () => {
    const root = await writeProject('human');
    for (const subcommand of ['status', 'plan', 'resume', 'verify'] as const) {
      const result = await run(['governance', subcommand], root);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`GOVERNANCE ${subcommand.toUpperCase()}`);
      if (subcommand === 'verify') {
        expect(result.out).toContain('setup-completion');
        expect(result.out).toContain('setup has not started');
      }
      expect(result.err).toBe('');
    }

    const apply = await run(['governance', 'apply-next'], root);
    expect(apply.code).toBe(0);
    expect(apply.out).toContain('Preview only');
    expect(apply.err).toBe('');

    const applyJson = await run(['governance', 'apply-next', '--json'], root);
    expect(applyJson.code).toBe(0);
    expect(JSON.parse(applyJson.out)).toMatchObject({
      applied: false,
      reason: 'execute-required',
      noWrites: true
    });
    expect(applyJson.err).toBe('');
  });

  it('keeps status, plan, verify, resume, and blocked apply-next read-only', async () => {
    const root = await writeProject('readonly');
    const before = await fingerprint(root);
    for (const subcommand of ['status', 'plan', 'verify', 'resume', 'apply-next'] as const) {
      await run(['governance', subcommand, '--json'], root);
    }
    expect(await fingerprint(root)).toBe(before);
  });

  it('keeps governance reads and fail-closed apply-next outside external authority adapters', async () => {
    const runner = new AuthorityBoundaryRunner();
    const projectRoot = await writeProject('authority-read');
    for (const subcommand of ['status', 'plan', 'verify', 'resume', 'apply-next'] as const) {
      await run(['governance', subcommand, '--json'], projectRoot, runner);
    }

    expect(runner.forbidden).toEqual([]);
  });

  it('reports seed blockers and deterministic create-change plans without writing', async () => {
    const root = await writeProject('seeded');
    await mkdir(path.join(root, 'openspec', 'changes', 'bootstrap-seeded'), { recursive: true });
    const beforeSeed = await fingerprint(root);
    const seedStatus = await run(['governance', 'status', '--json'], root);
    expect(seedStatus.code).toBe(0);
    expect(JSON.parse(seedStatus.out).activeSourceOfTruth).toMatchObject({
      status: 'seed-blocked',
      seedChangeId: 'bootstrap-seeded'
    });
    const seedVerify = await run(['governance', 'verify', '--json'], root);
    expect(seedVerify.code).toBe(1);
    expect(JSON.parse(seedVerify.out).checks.find((check: { id: string }) => check.id === 'active-source-of-truth').issues.join('\n'))
      .toContain('still active');
    expect(await fingerprint(root)).toBe(beforeSeed);

    await rm(path.join(root, 'openspec', 'changes', 'bootstrap-seeded'), { recursive: true, force: true });
    await mkdir(path.join(root, 'openspec', 'changes', 'archive', '20260904-bootstrap-seeded'), { recursive: true });
    const beforePlan = await fingerprint(root);
    const plan = await run(['governance', 'plan', '--json'], root);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.out).activeSourceOfTruth).toMatchObject({
      status: 'none',
      createPlan: {
        status: 'blocked',
        changeId: 'governance-seeded-000000000000'
      }
    });
    expect(await fingerprint(root)).toBe(beforePlan);
  });

  it('selects one active governance source, blocks ambiguity, honors supersession, and rejects stale identity read-only', async () => {
    const root = await writeProject('selected');
    const first = await writeGovernancePlan(root, 'selected');
    const selected = await run(['governance', 'status', '--json'], root);
    const selectedAgain = await run(['governance', 'status', '--json'], root);
    expect(JSON.parse(selected.out).activeSourceOfTruth).toMatchObject({
      status: 'selected',
      selected: { changeId: first },
      recordActiveChangeOnNextMutation: true,
      reconciliation: { status: 'not-required' }
    });
    expect(JSON.parse(selectedAgain.out).activeSourceOfTruth.selected.changeId).toBe(first);

    const second = await writeGovernancePlan(root, 'selected', 'b'.repeat(64));
    const ambiguous = await run(['governance', 'plan', '--json'], root);
    expect(JSON.parse(ambiguous.out).activeSourceOfTruth.status).toBe('ambiguous');

    await mkdir(path.join(root, 'governance', 'supersessions'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'supersessions', 'choose-second.json'), `${JSON.stringify({
      schemaVersion: currentActivationIdentity.supersessionSchemaVersion,
      identity: currentActivationIdentity,
      supersededChangeId: first,
      supersedingChangeId: second,
      reason: 'owner supersession',
      approvedAt: '2026-09-04T00:00:00.000Z',
      approver: 'owner'
    }, null, 2)}\n`, 'utf8');
    const superseded = await run(['governance', 'status', '--json'], root);
    expect(JSON.parse(superseded.out).activeSourceOfTruth.selected.changeId).toBe(second);

    const metadataPath = path.join(root, 'openspec', 'changes', second, governanceChangeMetadataFileName);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { activationIdentity: { phaseGraphHash: string }; phaseGraphHash: string };
    metadata.activationIdentity.phaseGraphHash = '9'.repeat(64);
    metadata.phaseGraphHash = '9'.repeat(64);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const beforeMismatch = await fingerprint(root);
    const verify = await run(['governance', 'verify', '--json'], root);
    expect(verify.code).toBe(1);
    expect(JSON.parse(verify.out).activeSourceOfTruth.status).toBe('incompatible');
    expect(await fingerprint(root)).toBe(beforeMismatch);
  });

  it('reports plan ready and blocked phases with evidence, approvals, mutations, and cost relevance', async () => {
    const root = await writeProject('plan');
    const result = await run(['governance', 'plan', '--json'], root);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out);
    expect(body.readOnly).toBe(true);
    expect(body.noWrites).toBe(true);
    expect(body.readyPhases[0]).toMatchObject({
      id: 'seed-valid',
      requiredEvidence: { schema: 'seed-valid.v1', required: true },
      approvalGate: { kind: 'none', required: false },
      approval: { questionKind: null, approvalRequired: false, status: 'not-required' },
      permittedMutations: { local: ['read-worktree', 'write-evidence', 'write-activation-state'], remote: ['none'] },
      costEnvelope: { relevant: false }
    });
    expect(body.blockedPhases.length).toBeGreaterThan(0);
  });

  it('reports approval question, reuse, expiry, envelope hash, and reasons without prompting', async () => {
    const root = await writeProject('approval-output');
    const activationState = validState();
    await writeState(root, activationState);
    await writeEvidence(root, 'seed-valid', header('seed-valid'));
    await writeEvidence(root, 'seed-verified', header('seed-verified'));
    await writeEvidence(root, 'seed-archived', header('seed-archived'));

    const blocked = await run(['governance', 'plan', '--json'], root);
    const blockedCommitted = JSON.parse(blocked.out).blockedPhases
      .find((phase: { id: string }) => phase.id === 'committed');
    expect(blockedCommitted.approval).toMatchObject({
      questionKind: 'repository-creation-initial-commit-push',
      approvalRequired: true,
      status: 'approval-required',
      envelopeHash: null
    });
    expect(blockedCommitted.approval.reasons.join('\n')).toContain('no approval envelope');

    const approval = await writeApproval(root, 'committed');
    const approved = await run(['governance', 'plan', '--json'], root);
    const readyCommitted = JSON.parse(approved.out).readyPhases
      .find((phase: { id: string }) => phase.id === 'committed');
    expect(readyCommitted.approval).toMatchObject({
      questionKind: 'repository-creation-initial-commit-push',
      approvalRequired: false,
      status: 'reused',
      envelopeId: approval.id,
      envelopeHash: canonicalApprovalEnvelopeHash(approval)
    });

    approval.expiresAt = '2020-01-01T00:00:00.000Z';
    await writeFile(
      path.join(root, 'governance', 'approvals', `${approval.id}.json`),
      `${JSON.stringify(approval, null, 2)}\n`,
      'utf8'
    );
    const expired = await run(['governance', 'apply-next', '--json'], root);
    expect(JSON.parse(expired.out)).toMatchObject({
      applied: false,
      authorized: false,
      noWrites: true,
      approval: null
    });
    const status = await run(['governance', 'status', '--json'], root);
    expect(JSON.parse(status.out).approvals[0]).toMatchObject({
      status: 'expired',
      envelopeHash: canonicalApprovalEnvelopeHash(approval)
    });
  });

  it('loads managed graph fixtures strictly and rejects malformed state and evidence', async () => {
    const root = await writeProject('malformed');
    await writeFile(
      path.join(root, '.liftoff', 'governance', 'phase-graph.json'),
      `${JSON.stringify(canonicalPhaseGraph, null, 2)}\n`,
      'utf8'
    );
    expect((await run(['governance', 'status', '--json'], root)).code).toBe(0);

    await writeFile(path.join(root, '.liftoff', 'governance', 'phase-graph.json'), '{bad', 'utf8');
    const badGraph = await run(['governance', 'verify', '--json'], root);
    expect(badGraph.code).toBe(1);
    expect(JSON.parse(badGraph.out)).toMatchObject({
      ok: false,
      consistent: false,
      verificationStatus: 'inconsistent',
      complete: false,
      setupStatus: 'indeterminate',
      stateSource: 'unavailable',
      summary: expect.stringContaining('completion is indeterminate')
    });
    expect(JSON.parse(badGraph.out).checks[0].issues[0])
      .toContain('Unable to parse .liftoff/governance/phase-graph.json');

    await writeFile(
      path.join(root, '.liftoff', 'governance', 'phase-graph.json'),
      `${JSON.stringify(canonicalPhaseGraph, null, 2)}\n`,
      'utf8'
    );
    await writeState(root, { ...validState(), identity: { ...currentActivationIdentity, phaseGraphHash: '9'.repeat(64) } });
    const badState = await run(['governance', 'status', '--json'], root);
    expect(badState.code).toBe(1);
    expect(badState.err).toContain('Invalid governance/activation-state.json');

    await rm(path.join(root, 'governance', 'activation-state.json'), { force: true });
    await writeEvidence(root, 'bad', { schemaVersion: 1, extra: true });
    const badEvidence = await run(['governance', 'verify', '--json'], root);
    expect(badEvidence.code).toBe(1);
    expect(JSON.parse(badEvidence.out).checks[0].issues[0]).toContain('Invalid governance/evidence/bad.json');
  });

  it('keeps the verification failure envelope when a later verification check throws', async () => {
    const root = await writeProject('malformed-task-projection');
    await writeState(root, validState({
      activeChange: { id: 'governance-activation', kind: 'openspec' }
    }));
    await mkdir(path.join(root, 'openspec', 'changes', 'governance-activation'), { recursive: true });
    await writeFile(
      path.join(root, 'openspec', 'changes', 'governance-activation', 'tasks.md'),
      '- [ ] 1.1 Unknown phase <!-- liftoff-phase: not-a-phase -->\n',
      'utf8'
    );

    const result = await run(['governance', 'verify', '--json'], root);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      consistent: false,
      verificationStatus: 'inconsistent',
      complete: false,
      setupStatus: 'indeterminate',
      stateSource: 'unavailable',
      summary: expect.stringContaining('completion is indeterminate')
    });
    expect(JSON.parse(result.out).checks[0].issues[0])
      .toContain('Task projection references unknown phase not-a-phase');
  });

  it('detects stale evidence, missing live readback, and checked tasks without authoritative evidence', async () => {
    const root = await writeProject('verify');
    const phases = validState().phases;
    phases['seed-valid'].state = 'verified';
    phases['rulesets-applied'].state = 'verified';
    await writeState(root, validState({
      activeChange: { id: 'governance-activation', kind: 'openspec' },
      phases
    }));
    const staleSeed = header('seed-valid');
    staleSeed.baselineSha = '9'.repeat(64);
    staleSeed.transition = { ...staleSeed.transition, baselineSha: staleSeed.baselineSha };
    await writeEvidence(root, 'stale-seed', staleSeed);
    await writeEvidence(root, 'source-only-ruleset', header('rulesets-applied'));
    await mkdir(path.join(root, 'openspec', 'changes', 'governance-activation'), { recursive: true });
    await writeFile(
      path.join(root, 'openspec', 'changes', 'governance-activation', 'tasks.md'),
      '- [x] 1.1 Seed valid <!-- liftoff-phase: seed-valid -->\n',
      'utf8'
    );

    const status = await run(['governance', 'status', '--json'], root);
    expect(JSON.parse(status.out).evidenceFreshness.find((entry: { phaseId: string }) => entry.phaseId === 'seed-valid'))
      .toMatchObject({ status: 'stale' });

    const verify = await run(['governance', 'verify', '--json'], root);
    expect(verify.code).toBe(1);
    const checks = JSON.parse(verify.out).checks as Array<{ id: string; status: string; issues: string[] }>;
    expect(checks.find((check) => check.id === 'evidence-freshness')?.status).toBe('failed');
    expect(checks.find((check) => check.id === 'live-readback')?.issues.join('\n')).toContain('github live readback proof');
    expect(checks.find((check) => check.id === 'task-projection')?.issues.join('\n')).toContain('checked');

    await writeEvidence(root, 'ruleset-live', {
      evidenceId: 'ruleset-live',
      header: header('rulesets-applied'),
      liveReadback: [liveProof('rulesets-applied', 'github')]
    });
    const resume = await run(['governance', 'resume', '--json'], root);
    const resumeBody = JSON.parse(resume.out);
    expect(resumeBody.executedOperations).toEqual([]);
    expect(resumeBody.noWrites).toBe(true);
  });

  it('treats latest current evidence as authoritative while old stale records remain informational', async () => {
    const root = await writeProject('latest-evidence');
    const phases = validState().phases;
    phases['seed-valid'].state = 'verified';
    await writeState(root, validState({ phases }));
    const stale = header('seed-valid', {
      producedAt: '2026-09-03T00:00:00.000Z',
      baselineSha: '9'.repeat(64),
      transition: {
        ...header('seed-valid').transition,
        baselineSha: '9'.repeat(64)
      }
    });
    await writeEvidence(root, 'old-stale', stale);
    await writeEvidence(root, 'current-valid', header('seed-valid', {
      producedAt: '2026-09-04T00:00:00.000Z'
    }));

    const status = await run(['governance', 'status', '--json'], root);
    expect(JSON.parse(status.out).evidenceFreshness.find((entry: { phaseId: string }) => entry.phaseId === 'seed-valid'))
      .toMatchObject({ status: 'fresh', selectedEvidenceId: 'current-valid' });
    const verify = await run(['governance', 'verify', '--json'], root);
    expect(verify.code, verify.out).toBe(0);
    const checks = JSON.parse(verify.out).checks as Array<{ id: string; status: string; issues: string[] }>;
    expect(checks.find((check) => check.id === 'evidence-freshness')?.status).toBe('passed');
    expect(checks.find((check) => check.id === 'state-evidence')?.status).toBe('passed');

    await writeEvidence(root, 'newer-failed', header('seed-valid', {
      producedAt: '2026-09-04T00:10:00.000Z',
      result: 'failed'
    }));
    const failedVerify = await run(['governance', 'verify', '--json'], root);
    expect(failedVerify.code).toBe(1);
    const failedChecks = JSON.parse(failedVerify.out).checks as Array<{ id: string; status: string; issues: string[] }>;
    expect(failedChecks.find((check) => check.id === 'state-evidence')).toMatchObject({
      status: 'failed',
      issues: [expect.stringContaining('seed-valid')]
    });
  });
});
