import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { writeArtifacts } from '../src/adapters/filesystem/project-files.js';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from '../src/domain/governance/activation/graph.js';
import {
  phaseIds,
  type PhaseEvidenceRecord,
  type SavedTransitionPlan,
  type UserActivationState
} from '../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import {
  assessGovernance,
  findAssessmentException,
  rejectedAssessmentExceptionDiagnostic,
  resolveAssessmentLiveScope,
  selectBoundAssessmentEvidence
} from '../src/governance-assessment/engine.js';
import { inspectAssessmentProject } from '../src/governance-assessment/project.js';
import { resolveAssessmentBoundary } from '../src/adapters/git/governance-assessment.js';
import { AssessmentFiles } from '../src/governance-assessment/readers.js';
import { observed, source } from '../src/governance-assessment/sanitize.js';
import { loadAssessmentCatalog } from '../src/governance-assessment/catalog.js';
import * as liveModule from '../src/governance-assessment/live.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { planDigestFor } from '../src/domain/governance/activation/operations.js';
import { remoteBindingDigest } from '../src/domain/governance/activation/inputs.js';
import type { EvidenceFreshnessContext } from '../src/domain/governance/activation/evidence.js';
import { historicalActivationIdentities } from '../src/domain/governance/policy/identity.js';
import {
  activationEvidenceContexts,
  readActivationInputSnapshot
} from '../src/governance-activation/read-only.js';
import {
  canonicalApprovalEnvelopeHash,
  evaluateApprovalForTransitionPlan,
  transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import {
  evidenceBodyDigest,
  evidenceContextForPhase,
  selectLatestPhaseEvidence
} from '../src/domain/governance/activation/evidence.js';
import type { ProjectOptions, ExternalCommand } from '../src/types.js';
import type { CommandRunner } from '../src/process-runner.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const roots: string[] = [];
const now = () => new Date('2026-09-05T00:00:00.000Z');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporaryRoot(prefix: string): Promise<string> {
  await mkdir(path.join(process.cwd(), '.cache'), { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache', prefix));
  roots.push(root);
  return root;
}
async function fixture(options: Partial<ProjectOptions> = {}) {
  const root = await temporaryRoot('assessment-engine ');
  const plan = buildProjectPlan({
    projectName: 'Assessment Project', specWorkflow: 'openspec', agents: ['copilot'],
    projectType: 'standard', apiStack: options.projectType === 'genai' ? 'python' : 'go',
    cloud: 'azure', region: 'eastus', includeFrontend: false,
    ...options
  }, { requireProjectName: true });
  await writeArtifacts(root, buildArtifacts(plan));
  return root;
}
function savedAssessmentPlan(
  phaseId: (typeof phaseIds)[number],
  current: UserActivationState,
  context: EvidenceFreshnessContext,
  approvals: Parameters<typeof evaluateApprovalForTransitionPlan>[1] = [],
  operations: SavedTransitionPlan['operations'] = []
): SavedTransitionPlan {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const authority = transitionPlanForPhase(phase, current, context.transition);
  const evaluation = evaluateApprovalForTransitionPlan(authority, approvals, {
    now: now()
  });
  return {
    schemaVersion: 1,
    phaseId,
    createdAt: now().toISOString(),
    expiresAt: '2026-09-05T00:15:00.000Z',
    identity: currentActivationIdentity,
    graphHash: canonicalPhaseGraphHash,
    stateHash: null,
    baselineDigest: context.baselineSha,
    inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest,
    planDigest: planDigestFor({
      phase,
      transitionDigest: context.transition.transitionDigest,
      operations,
      approvalPlanDigest: authority.planDigest
    }),
    mutationClasses: phase.allowedMutations,
    operations,
    approval: {
      gateKind: phase.approvalGate.kind,
      required: phase.approvalGate.required,
      evaluation,
      envelopeId: evaluation.envelopeId,
      envelopeHash: evaluation.envelopeHash
    },
    rollbackPlan: {
      phaseId,
      strategy: phase.rollback.kind,
      target: phase.rollback.target,
      operations: [],
      retained: [],
      cleanupWarnings: []
    },
    noSecrets: true
  };
}
async function tree(root: string): Promise<string> {
  const entries: Array<[string, string]> = [];
  async function visit(parts: string[]) {
    for (const entry of await readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) entries.push([child.join('/'), await readFile(path.join(root, ...child), 'utf8')]);
    }
  }
  await visit([]);
  return canonicalSha256(entries.sort(([a], [b]) => a.localeCompare(b, 'en')));
}
const noCommands: CommandRunner = {
  async run(command) { throw new Error(`Unexpected external command: ${command.executable}`); }
};
const missingGitRunner: CommandRunner = {
  async run(command) {
    if (command.executable !== 'git') {
      throw new Error(`Unexpected external command: ${command.executable}`);
    }
    return {
      command,
      displayCommand: `git ${command.args.join(' ')}`,
      status: 128,
      signal: null,
      stdout: '',
      stderr: 'not a git repository',
      timedOut: false
    };
  }
};
function ordinaryGitRunner(root: string, origin?: string): CommandRunner & { calls: ExternalCommand[] } {
  const calls: ExternalCommand[] = [];
  return {
    calls,
    async run(command) {
      calls.push(command);
      const args = command.args.join(' ');
      if (args.endsWith('rev-parse --show-toplevel')) {
        return {
          command, displayCommand: 'git rev-parse --show-toplevel', status: 0,
          signal: null, stdout: `${root}\n`, stderr: '', timedOut: false
        };
      }
      if (args.endsWith('rev-parse --verify HEAD')) {
        return {
          command, displayCommand: 'git rev-parse --verify HEAD', status: 128,
          signal: null, stdout: '', stderr: 'unborn branch', timedOut: false
        };
      }
      if (args.endsWith('config --local --get remote.origin.url')) {
        return {
          command, displayCommand: 'git config --local --get remote.origin.url',
          status: origin ? 0 : 1, signal: null, stdout: origin ? `${origin}\n` : '',
          stderr: '', timedOut: false
        };
      }
      if (args.endsWith('remote get-url --push --all origin')) {
        return {
          command, displayCommand: 'git remote get-url --push --all origin',
          status: origin ? 0 : 2, signal: null, stdout: origin ? `${origin}\n` : '',
          stderr: '', timedOut: false
        };
      }
      throw new Error(`Unexpected ordinary Git command: ${args}`);
    }
  };
}
function state() {
  return validateUserActivationState({
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: { id: 'R_assessment', name: 'owner/repo', defaultBranch: 'develop' },
    activeChange: null, applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: now().toISOString(), evidence: [], approvals: [], blockers: []
    }])),
    createdAt: now().toISOString(), updatedAt: now().toISOString()
  });
}

describe('read-only assessment command', () => {
  it('assesses the nearest ordinary unborn Git boundary without initialization or invented identity', async () => {
    const root = await temporaryRoot('ordinary-git-assessment ');
    await mkdir(path.join(root, '.git'));
    const nested = path.join(root, 'packages', 'api');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, 'README.md'), 'ordinary repository\n');
    const runner = ordinaryGitRunner(root);
    const before = await tree(root);
    const stdout = new CaptureStream();

    const code = await runCommand(parseArgs(['governance', 'assess', '--json']), {
      cwd: nested,
      stdout,
      stderr: new CaptureStream(),
      runner
    });
    const report = JSON.parse(stdout.text());

    expect(code).toBe(2);
    expect(report).toMatchObject({
      schemaVersion: 1,
      readOnly: true,
      projectRoot: root,
      target: { profile: 'single-maintainer-gitflow', catalogSchemaVersion: 1 },
      projectIdentity: {
        availability: 'unavailable',
        manifestVersion: null,
        cliVersion: null,
        profile: null,
        policyVersion: null,
        recordedActivationIdentity: null,
        stateSource: 'unavailable'
      },
      snapshot: { repository: null, localHead: null, inputsStable: true },
      outcome: 'partial',
      exitCode: 2,
      coverage: { total: 30, unsupported: 10 }
    });
    expect(report.findings).toHaveLength(30);
    expect(report.findings.filter((finding: { unsupported: boolean; applicability: string }) =>
      finding.unsupported && finding.applicability === 'applicable'
    )).toHaveLength(6);
    expect(runner.calls.every((command) => command.executable === 'git')).toBe(true);
    expect(runner.calls.some((command) => command.args.includes('status'))).toBe(false);
    expect(await tree(root)).toBe(before);

    const human = new CaptureStream();
    expect(await runCommand(parseArgs(['governance', 'assess']), {
      cwd: nested,
      stdout: human,
      stderr: new CaptureStream(),
      runner
    })).toBe(2);
    expect(human.text()).toContain('single-maintainer-gitflow');
  });

  it('assesses Liftoff itself as an ordinary Git repository without initialization', async () => {
    const root = process.cwd();
    const stdout = new CaptureStream();
    const code = await runCommand(parseArgs([
      'governance', 'assess', root, '--json'
    ]), {
      cwd: path.join(root, 'src', 'governance-assessment'),
      stdout,
      stderr: new CaptureStream()
    });
    const report = JSON.parse(stdout.text());

    expect(code).toBe(2);
    expect(report).toMatchObject({
      projectRoot: root,
      target: { profile: 'single-maintainer-gitflow' },
      projectIdentity: {
        availability: 'unavailable',
        manifestVersion: null,
        profile: null
      },
      outcome: 'partial',
      coverage: { total: 30 }
    });
  });

  it('treats a linked-worktree marker as an ordinary Git boundary', async () => {
    const root = await temporaryRoot('linked-git-assessment ');
    await writeFile(path.join(root, '.git'), 'gitdir: ../worktrees/linked\n');
    const nested = path.join(root, 'src');
    await mkdir(nested);

    await expect(resolveAssessmentBoundary(nested)).resolves.toEqual({
      kind: 'git',
      root
    });
    const report = await assessGovernance(root, {
      runner: ordinaryGitRunner(root),
      now
    });
    expect(report).toMatchObject({
      outcome: 'partial',
      projectIdentity: { availability: 'unavailable' }
    });
  });

  it('binds ordinary-Git live reads only to a credential-free GitHub origin', async () => {
    const root = await temporaryRoot('bound-git-assessment ');
    await mkdir(path.join(root, '.git'));
    const runner = ordinaryGitRunner(root, 'https://github.com/octo-org/policy.git');
    const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {},
      diagnostics: [],
      refsStable: true
    });

    await assessGovernance(root, { live: true, runner, now });

    expect(collector).toHaveBeenCalledWith({
      repository: {
        owner: 'octo-org',
        name: 'policy',
        id: null
      },
      refs: ['develop', 'main'],
      refPrefixes: ['release/', 'hotfix/'],
      environments: [],
      runner: null,
      azure: []
    }, expect.objectContaining({ runner }));
    expect(runner.calls.every((command) => command.executable === 'git')).toBe(true);
  });

  it('withholds provider scope for an unsupported ordinary-Git remote', async () => {
    const root = await temporaryRoot('unbound-git-assessment ');
    await mkdir(path.join(root, '.git'));
    const runner = ordinaryGitRunner(root, 'ssh://internal.example/owner/repo.git');
    const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {},
      diagnostics: [],
      refsStable: true
    });

    const report = await assessGovernance(root, { live: true, runner, now });

    expect(collector).toHaveBeenCalledWith(expect.objectContaining({
      repository: null,
      runner: null,
      azure: []
    }), expect.any(Object));
    expect(report.diagnostics.some((entry) =>
      entry.message.includes('matching credential-free GitHub fetch and push binding')
    )).toBe(true);
  });

  it('stops at a malformed inner manifest instead of falling back to an outer Git repository', async () => {
    const outer = await temporaryRoot('outer-git-assessment ');
    await mkdir(path.join(outer, '.git'));
    const inner = path.join(outer, 'packages', 'damaged');
    const nested = path.join(inner, 'src');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(inner, 'liftoff.manifest.json'), '{');
    const runner: CommandRunner & { calls: ExternalCommand[] } = {
      calls: [],
      async run(command) {
        this.calls.push(command);
        throw new Error('Git fallback must not run past a manifest boundary.');
      }
    };
    const stdout = new CaptureStream();

    const code = await runCommand(parseArgs([
      'governance', 'assess', inner, '--json', '--live'
    ]), {
      cwd: outer,
      stdout,
      stderr: new CaptureStream(),
      runner
    });
    const report = JSON.parse(stdout.text());

    expect(code).toBe(1);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'malformed-json',
      severity: 'error'
    }));
    expect(runner.calls).toEqual([]);
    expect(await resolveAssessmentBoundary(nested)).toEqual({
      kind: 'liftoff',
      root: inner
    });
  });

  it('treats a symlinked inner manifest as an error boundary before Git fallback', async ({ skip }) => {
    if (process.platform === 'win32') {
      skip();
      return;
    }
    const outer = await temporaryRoot('symlink-manifest-assessment ');
    await mkdir(path.join(outer, '.git'));
    const inner = path.join(outer, 'packages', 'linked');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(outer, 'outside-manifest.json'), '{}');
    await symlink(
      path.join(outer, 'outside-manifest.json'),
      path.join(inner, 'liftoff.manifest.json')
    );
    const runner: CommandRunner & { calls: ExternalCommand[] } = {
      calls: [],
      async run(command) {
        this.calls.push(command);
        throw new Error('Git fallback must not run past a symlinked manifest.');
      }
    };

    const report = await assessGovernance(inner, { live: true, runner, now });

    expect(report).toMatchObject({
      outcome: 'error',
      exitCode: 1,
      diagnostics: [expect.objectContaining({
        severity: 'error'
      })]
    });
    expect(runner.calls).toEqual([]);
  });

  it.each([
    { projectType: 'standard', apiStack: 'go' },
    { projectType: 'standard', apiStack: 'node' },
    { projectType: 'genai', pattern: 'prompt' }
  ] satisfies Partial<ProjectOptions>[])('assesses fresh workload %j offline without running baseline or changing files', async (options) => {
    const root = await fixture(options);
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
      schemaVersion: 1, readOnly: true, mode: 'local', outcome: 'partial', exitCode: 2,
      projectIdentity: { stateSource: 'not-started' }
    });
    expect(new Set(report.findings.map((item) => item.controlId))).toEqual(
      new Set(loadAssessmentCatalog().catalog.controls.map((control) => control.id))
    );
    expect(report.findings.filter((item) => item.controlId === 'identity.managed-core').every((item) => item.classification === 'aligned')).toBe(true);
    expect(report.findings.find((item) => item.controlId === 'gitflow.default-branch')?.classification).toBe('not-observed');
    expect(await tree(root)).toBe(before);
    expect(report.findings.find((item) => item.controlId === 'runner.private-assignment')?.applicability)
      .toBe('unknown');
  });

  it('rejects a retired manifest before ordinary Git fallback, deeper fields, or live collection', async () => {
    const root = await temporaryRoot('retired-assessment ');
    await mkdir(path.join(root, '.git'));
    const raw = JSON.parse(
      await readFile(path.resolve('tests/fixtures/manifest-v4-power-apps.json'), 'utf8')
    );
    raw.project.workload.starter = null;
    raw.project.workload.codeAppsPlugin = { malformed: true };
    raw.artifacts = [{
      logicalName: 'unsafe-retired-artifact',
      category: 'governance',
      pathParts: ['..', 'outside'],
      contentHash: 'not-a-hash'
    }];
    await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(raw, null, 2)}\n`);
    await writeFile(path.join(root, 'production-app.txt'), 'preserve\n');
    const before = await tree(root);
    const collector = vi.spyOn(liveModule, 'collectLiveAssessment');

    const report = await assessGovernance(root, { live: true, runner: noCommands, now });

    expect(report).toMatchObject({ outcome: 'error', exitCode: 1 });
    expect(JSON.stringify(report)).toMatch(/Power Apps.*retired|retired.*Power Apps/i);
    expect(collector).not.toHaveBeenCalled();
    expect(await tree(root)).toBe(before);
  });

  it('does not query live services or activate a disabled profile even with --live', async () => {
    const root = await fixture({ governanceProfile: 'none' });
    const before = await tree(root);
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'not-applicable', exitCode: 0, findings: [] });
    expect(await tree(root)).toBe(before);
  });

  it('distinguishes conflicting managed content from unchanged CLI versions', async () => {
    const root = await fixture();
    const file = path.join(root, '.liftoff', 'governance', 'policy.md');
    await writeFile(file, `${await readFile(file, 'utf8')}\nProject customization\n`);
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report.projectIdentity.cliVersion).toBe(report.target?.cliVersion);
    expect(report.findings.find((item) => item.controlId === 'identity.managed-core' && item.scope.resource === '.liftoff/governance/policy.md')?.classification)
      .toBe('conflicting');
    expect(await tree(root)).toBe(before);
  });

  it('does not let denied live reads erase an independently proven local conflict', async () => {
    const root = await fixture();
    const policy = path.join(root, '.liftoff', 'governance', 'policy.md');
    await writeFile(policy, `${await readFile(policy, 'utf8')}\nlocal conflict\n`);
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.repository': {
          availability: 'not-observed',
          value: null,
          source: null,
          reason: 'The scoped read was denied.'
        }
      },
      diagnostics: [{
        code: 'live-denied',
        severity: 'warning',
        message: 'The scoped read was denied.',
        source: 'github.repository'
      }],
      refsStable: false
    });

    const report = await assessGovernance(root, {
      live: true,
      runner: noCommands,
      now
    });

    expect(report.snapshot.inputsStable).toBe(true);
    expect(report.findings.find((finding) =>
      finding.controlId === 'identity.managed-core' &&
      finding.scope.resource === '.liftoff/governance/policy.md'
    )).toMatchObject({
      classification: 'conflicting'
    });
    expect(report.outcome).toBe('partial');
  });

  it('retains a proven storage violation when an unrelated Azure read is denied', async () => {
    const root = await fixture();
    const azureSource = source(
      'azure',
      'https://management.azure.com (partial explicit bindings)',
      now().toISOString()
    );
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'azure.resources': {
          availability: 'not-observed',
          value: null,
          source: azureSource,
          reason: 'Another explicitly bound resource was denied.',
          facts: [{
            resourceType: 'Microsoft.Storage/storageAccounts',
            role: 'state',
            environment: 'staging',
            sku: { name: 'Standard_LRS' }
          }]
        }
      },
      diagnostics: [],
      refsStable: true
    });

    const report = await assessGovernance(root, {
      live: true,
      runner: noCommands,
      now
    });
    const storage = report.findings.find((finding) =>
      finding.controlId === 'azure.storage-redundancy'
    );

    expect(storage).toMatchObject({
      classification: 'conflicting',
      missingProof: ['live']
    });
    expect(storage?.reasons.join(' ')).toContain('prove a difference');
  });

  it('rejects a mixed activation identity without relaxing the strict current reader', async () => {
    const root = await fixture();
    const file = path.join(root, 'liftoff.manifest.json');
    const manifest = await loadManifest(root);
    if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') throw new Error('Expected governed fixture.');
    await writeFile(file, JSON.stringify({
      ...manifest, governance: { ...manifest.governance, policyVersion: '99', activationIdentity: { ...currentActivationIdentity, policyVersion: '99' } }
    }));
    const before = await tree(root);
    await expect(loadManifest(root)).rejects.toThrow(/policyVersion|identity/);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
      outcome: 'error',
      projectIdentity: { availability: 'unavailable' }
    });
    expect(report.diagnostics.some((entry) =>
      entry.code === 'malformed-identity'
    )).toBe(true);
    expect(await tree(root)).toBe(before);
  });

  it('preserves opaque future state and does not expose its payload', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'governance'));
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify({
      schemaVersion: 99, secret: `github_pat_${'x'.repeat(40)}`
    }));
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'partial', projectIdentity: { stateSource: 'unsupported' } });
    expect(JSON.stringify(report)).not.toContain('github_pat_');
    expect(await tree(root)).toBe(before);

    const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {},
      diagnostics: [],
      refsStable: true
    });
    await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(collector).toHaveBeenCalledWith(expect.objectContaining({
      repository: null,
      runner: null,
      azure: []
    }), expect.any(Object));
  });

  it('keeps historical activation-v1 state diagnostic-only and byte-preserved', async () => {
    const root = await fixture();
    const statePath = path.join(root, 'governance', 'activation-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    const historical = {
      ...state(),
      schemaVersion: 1,
      identity: historicalActivationIdentities[0]
    };
    const bytes = `${JSON.stringify(historical, null, 2)}\n`;
    await writeFile(statePath, bytes);
    const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {},
      diagnostics: [],
      refsStable: true
    });

    const report = await assessGovernance(root, {
      live: true,
      runner: noCommands,
      now
    });

    expect(report).toMatchObject({
      outcome: 'partial',
      projectIdentity: {
        availability: 'unsupported',
        stateSource: 'unsupported'
      }
    });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'activation-history-diagnostic-only'
    }));
    expect(collector).toHaveBeenCalledWith(expect.objectContaining({
      repository: null,
      runner: null,
      azure: []
    }), expect.any(Object));
    expect(await readFile(statePath, 'utf8')).toBe(bytes);
  });

  it.each(['seed-valid', 'blocked', 'archived', 'completed'] as const)(
    'assesses recorded setup state without advancing phases (%s)',
    async (progress) => {
      const root = await fixture();
      const initialized = await runCommand(parseArgs(['governance', 'apply-next', '--json', '--execute']), {
        cwd: root, stdout: new CaptureStream(), stderr: new CaptureStream(), runner: new ReadyInitRunner()
      });
      expect(initialized).toBe(0);
      const statePath = path.join(root, 'governance', 'activation-state.json');
      const current = validateUserActivationState(JSON.parse(await readFile(statePath, 'utf8')));
      if (progress === 'blocked') {
        current.phases['seed-verified'] = {
          ...current.phases['seed-verified'], state: 'blocked', blockers: ['Recorded local baseline failure.']
        };
      }
      if (progress === 'archived') {
        const archived = path.join(root, 'openspec', 'changes', 'archive', '2026-09-05-bootstrap-assessment-project');
        await mkdir(path.dirname(archived), { recursive: true });
        await rename(path.join(root, 'openspec', 'changes', 'bootstrap-assessment-project'), archived);
        current.phases['seed-archived'].state = 'verified';
      }
      if (progress === 'completed') {
        for (const phase of canonicalPhaseGraph.phases) {
          current.phases[phase.id].state = phase.terminalStates.find((value) => value !== 'failed')!;
        }
      }
      await writeFile(statePath, JSON.stringify(current));
      const before = await tree(root);
      const report = await assessGovernance(root, { runner: noCommands, now });
      expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
        outcome: 'partial', projectIdentity: { stateSource: 'user' }
      });
      expect(report.findings.find((entry) => entry.controlId === 'evidence.governance')?.classification).toBe('not-observed');
      expect(await tree(root)).toBe(before);
    }
  );

  it.each([2, 3, 4, 5, 6] as const)('assesses supported manifest schema %s without migration', async (version) => {
    const root = await fixture({ projectType: 'genai', pattern: 'prompt', apiStack: 'python' });
    const manifest = await loadManifest(root);
    if (manifest.project.workload.kind === 'power-apps-code-app' || manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') throw new Error('Wrong legacy fixture.');
    const workload = manifest.project.workload;
    const historicalManaged = manifest.managedArtifacts.filter((entry) => !entry.logicalName.startsWith('liftoff-governance-assess-'));
    const artifacts = [...historicalManaged, ...manifest.projectArtifacts.map((entry) => ({
      logicalName: entry.logicalName, category: entry.category, pathParts: entry.pathParts, contentHash: entry.generationHash
    }))];
    const raw: Record<string, unknown> = {
      ...manifest, artifactVersion: version, managedArtifacts: historicalManaged,
      governance: { profile: manifest.governance.profile, state: manifest.governance.state, policyVersion: manifest.governance.policyVersion }
    };
    if (version <= 5) {
      raw.artifacts = artifacts;
      delete raw.managedArtifacts; delete raw.projectArtifacts;
    }
    if (version <= 4) delete raw.governance;
    if (version <= 3) raw.project = {
      name: manifest.project.name, ...(version === 3 ? { projectType: 'genai', apiStack: workload.apiStack, agents: manifest.project.agents } : {}),
      pattern: 'prompt', cloud: workload.cloud, region: workload.region, frontend: workload.frontend,
      environments: workload.environments, specWorkflow: manifest.project.specWorkflow
    };
    if (version === 2) delete raw.framework;
    await writeFile(path.join(root, 'liftoff.manifest.json'), JSON.stringify(raw));
    const before = await tree(root);
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({ outcome: 'partial', projectIdentity: { manifestVersion: version } });
    expect(await tree(root)).toBe(before);
  });

  it('returns a JSON error before unsafe or unknown-manifest paths can be used', async () => {
    const root = await fixture();
    const file = path.join(root, 'liftoff.manifest.json');
    const manifest = await loadManifest(root);
    manifest.managedArtifacts[0]!.pathParts = ['..', 'outside-secret'];
    await writeFile(file, JSON.stringify(manifest));
    expect(await assessGovernance(root, { runner: noCommands, now })).toMatchObject({ outcome: 'error', exitCode: 1 });
    await writeFile(file, JSON.stringify({ ...manifest, artifactVersion: 99 }));
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'error', diagnostics: [expect.objectContaining({ code: 'unsupported-manifest' })] });
  });

  it('refuses escaping symlinks and malformed workflow YAML without executing helpers', async ({ skip }) => {
    if (process.platform === 'win32') { skip(); return; }
    const root = await fixture();
    const outside = await fixture();
    const file = path.join(root, '.liftoff', 'governance', 'policy.md');
    await rm(file);
    await symlink(path.join(outside, 'README.md'), file);
    expect(await assessGovernance(root, { runner: noCommands, now })).toMatchObject({ outcome: 'error' });
  });

  it('rejects escaping workflow-directory symlinks or Windows junctions', async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(path.join(outside, '.github'), path.join(root, '.github', 'workflows'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const report = await assessGovernance(root, { runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'error', exitCode: 1 });
  });

  it('disables Git execution hooks and optional index writes during local inspection', async () => {
    const root = await fixture();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git(['init', '--initial-branch=develop']);
    git(['add', 'README.md']);
    const marker = path.join(root, 'hook-executed');
    const monitor = path.join(root, 'monitor.cjs');
    await writeFile(monitor, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    const hook = `"${process.execPath.replaceAll('\\', '/')}" "${monitor.replaceAll('\\', '/')}"`;
    git(['config', '--local', 'core.fsmonitor', hook]);
    git(['config', '--local', 'diff.external', hook]);
    const before = await tree(root);
    const report = await assessGovernance(root, { now });
    expect(report.outcome).toBe('partial');
    expect(await tree(root)).toBe(before);
    expect((await readdir(root)).includes('hook-executed')).toBe(false);
  });

  it('never runs repository-configured clean/process filters during assessment', async () => {
    const root = await fixture();
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    git(['init', '--initial-branch=develop']);
    const marker = path.join(root, 'filter-executed');
    const filter = path.join(root, 'filter.cjs');
    await writeFile(filter, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(fs.readFileSync(0));\n`);
    git(['config', '--local', 'filter.assessment.clean',
      `"${process.execPath.replaceAll('\\', '/')}" "${filter.replaceAll('\\', '/')}"`]);
    await writeFile(path.join(root, '.gitattributes'), '*.md filter=assessment\n');
    git(['add', 'README.md']);
    expect(await readFile(marker, 'utf8')).toBe('executed');
    await rm(marker);
    await writeFile(path.join(root, 'README.md'), 'Changed worktree contents\n');
    const before = await tree(root);
    const report = await assessGovernance(root, { now });
    expect(report.outcome).toBe('partial');
    expect(await tree(root)).toBe(before);
    expect((await readdir(root)).includes('filter-executed')).toBe(false);
  });

  it('withholds mixed snapshots when a live collector overlaps local changes', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    const workflow = path.join(root, '.github', 'workflows', 'checks.yml');
    await writeFile(workflow, 'name: Before\njobs: {test: {steps: []}}\n');
    vi.spyOn(liveModule, 'collectLiveAssessment').mockImplementation(async () => {
      await writeFile(workflow, 'name: After\njobs: {test: {steps: []}}\n');
      return { observations: {}, diagnostics: [], refsStable: true };
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report).toMatchObject({ outcome: 'partial', snapshot: { inputsStable: false } });
    expect(report.findings.filter((item) => item.applicability !== 'inapplicable').every((item) => item.classification === 'not-observed')).toBe(true);
  });

  it('invalidates changed local-file proof without erasing independent live violations', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    const workflow = path.join(root, '.github', 'workflows', 'checks.yml');
    await writeFile(workflow, 'name: Before\njobs: {test: {steps: []}}\n');
    const azureSource = source(
      'azure',
      'https://management.azure.com/bound-resource',
      now().toISOString()
    );
    vi.spyOn(liveModule, 'collectLiveAssessment').mockImplementation(async () => {
      await writeFile(workflow, 'name: After\njobs: {test: {steps: []}}\n');
      return {
        observations: {
          'azure.resources': observed([{
            resourceType: 'Microsoft.Storage/storageAccounts',
            role: 'state',
            environment: 'staging',
            sku: { name: 'Standard_LRS' }
          }], azureSource)
        },
        diagnostics: [],
        refsStable: true
      };
    });

    const report = await assessGovernance(root, {
      live: true,
      runner: noCommands,
      now
    });

    expect(report.snapshot.inputsStable).toBe(false);
    expect(report.findings.find((finding) =>
      finding.controlId === 'azure.storage-redundancy'
    )?.classification).toBe('conflicting');
    expect(report.findings.find((finding) =>
      finding.controlId === 'security.workflow-permissions'
    )?.classification).toBe('not-observed');
  });

  it.each([
    ['unchanged', true],
    ['evidence-deleted', false],
    ['evidence-payload-changed', false],
    ['reviewed-plan-clock-changed', false],
    ['source-input-changed', false]
  ] as const)('rechecks activation authority after live collection: %s', async (
    mutation,
    expectedStable
  ) => {
    const root = await fixture();
    const initialized = await runCommand(parseArgs([
      'governance', 'apply-next', '--json', '--execute'
    ]), {
      cwd: root,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      runner: new ReadyInitRunner()
    });
    expect(initialized).toBe(0);
    const evidenceRoot = path.join(root, 'governance', 'evidence');
    const plansRoot = path.join(root, 'governance', 'plans');
    const evidencePath = path.join(
      evidenceRoot,
      (await readdir(evidenceRoot)).find((name) => name.endsWith('.json'))!
    );
    const planPath = path.join(
      plansRoot,
      (await readdir(plansRoot)).find((name) => name.endsWith('.json'))!
    );
    const githubSource = source(
      'github',
      'https://api.github.com/repos/owner/repo',
      now().toISOString()
    );
    vi.spyOn(liveModule, 'collectLiveAssessment').mockImplementation(async () => {
      if (mutation === 'evidence-deleted') {
        await rm(evidencePath);
      } else if (mutation === 'evidence-payload-changed') {
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
        evidence.payload = { ...evidence.payload, changedDuringCollection: true };
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      } else if (mutation === 'reviewed-plan-clock-changed') {
        const plan = JSON.parse(await readFile(planPath, 'utf8'));
        plan.createdAt = '2026-09-04T23:59:59.000Z';
        await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      } else if (mutation === 'source-input-changed') {
        const sourcePath = path.join(root, 'backend', 'go.mod');
        await writeFile(
          sourcePath,
          `${await readFile(sourcePath, 'utf8')}\n// changed during assessment\n`
        );
      }
      return {
        observations: {
          'github.repository': observed({
            defaultBranch: 'develop'
          }, githubSource)
        },
        diagnostics: [],
        refsStable: true
      };
    });

    const report = await assessGovernance(root, {
      live: true,
      runner: noCommands,
      now
    });

    expect(report.snapshot.inputsStable).toBe(expectedStable);
    expect(report.findings.find((finding) =>
      finding.controlId === 'gitflow.default-branch'
    )?.classification).toBe('aligned');
    if (expectedStable) {
      expect(report.diagnostics.some((entry) =>
        entry.code === 'activation-authority-changed'
      )).toBe(false);
    } else {
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: 'activation-authority-changed'
      }));
      expect(report.findings.find((finding) =>
        finding.controlId === 'evidence.governance'
      )?.classification).toBe('not-observed');
    }
  });

  it.each([
    'evidence-deleted',
    'applicability-state-changed'
  ] as const)('invalidates evidence-derived inapplicability when authority changes: %s', async (
    mutation
  ) => {
    const root = await fixture();
    const manifest = await loadManifest(root);
    const current = state();
    current.remoteBinding = {
      id: 'R_assessment',
      name: 'owner/repo',
      defaultBranch: 'develop',
      pushUrl: 'https://github.com/owner/repo.git',
      verifiedAt: '2026-09-04T00:00:00Z'
    };
    current.applicability.privateStagingDast = false;
    const snapshot = await readActivationInputSnapshot(
      root,
      manifest,
      missingGitRunner
    );
    const contexts = activationEvidenceContexts(
      canonicalPhaseGraph,
      current,
      snapshot,
      now()
    );
    const phaseId = 'phase-0-complete';
    const context = contexts[phaseId];
    const plan = savedAssessmentPlan(phaseId, current, context, [], [{
      adapter: 'github',
      actionId: 'github.phase0.discover',
      mutationClass: 'github-read',
      phaseId,
      inputs: { sourceDigest: 'c'.repeat(64) },
      destination: {
        type: 'repository',
        identity: 'owner/repo',
        repository: 'owner/repo'
      },
      remote: true,
      destructive: false
    }]);
    const payload = {
      kind: 'phase-0-discovery.v1',
      planDigest: plan.planDigest,
      savedPlanDigest: canonicalSha256(plan),
      facts: [
        { id: 'repository.id', value: current.repository.id },
        { id: 'repository.nameWithOwner', value: current.repository.name },
        { id: 'repository.defaultBranch', value: current.repository.defaultBranch }
      ]
    };
    const readback = [{
      schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
      repositoryId: current.repository.id,
      identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash,
      phaseId,
      baselineSha: context.baselineSha,
      inputDigest: context.inputDigest,
      transition: context.transition,
      observedAt: now().toISOString(),
      provider: 'github' as const,
      resourceType: 'repository',
      resourceId: 'owner/repo',
      sourceDigest: 'c'.repeat(64),
      readbackDigest: 'c'.repeat(64),
      matches: true
    }];
    const evidence: PhaseEvidenceRecord = {
      evidenceId: 'phase0-applicability',
      header: {
        schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
        repositoryId: current.repository.id,
        identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash,
        phaseId,
        phaseContractDigest: context.phaseContractDigest,
        baselineSha: context.baselineSha,
        inputDigest: context.inputDigest,
        transition: context.transition,
        producedAt: now().toISOString(),
        producer: 'test',
        bodyDigest: evidenceBodyDigest(payload, readback),
        remoteBindingDigest: remoteBindingDigest(current.remoteBinding),
        result: 'verified'
      },
      payload,
      liveReadback: readback
    };
    current.phases[phaseId] = {
      ...current.phases[phaseId],
      state: 'verified',
      evidence: [{
        phaseId,
        evidenceId: evidence.evidenceId,
        headerDigest: canonicalSha256(evidence.header),
        result: 'verified'
      }]
    };
    const statePath = path.join(root, 'governance', 'activation-state.json');
    const evidenceRoot = path.join(root, 'governance', 'evidence');
    const plansRoot = path.join(root, 'governance', 'plans');
    const evidencePath = path.join(evidenceRoot, 'phase0.json');
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(plansRoot, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(
      path.join(plansRoot, 'phase0.json'),
      `${JSON.stringify(plan, null, 2)}\n`
    );

    const before = await assessGovernance(root, {
      runner: missingGitRunner,
      now
    });
    const controlId = 'runner.private-reachability';
    expect(before.findings.find((finding) =>
      finding.controlId === controlId
    )).toMatchObject({
      applicability: 'inapplicable',
      classification: 'inapplicable',
      missingProof: []
    });
    vi.spyOn(liveModule, 'collectLiveAssessment').mockImplementation(async () => {
      if (mutation === 'evidence-deleted') {
        await rm(evidencePath);
      } else {
        const changed = JSON.parse(await readFile(statePath, 'utf8'));
        changed.applicability.privateStagingDast = 'unknown';
        await writeFile(statePath, `${JSON.stringify(changed, null, 2)}\n`);
      }
      return {
        observations: {},
        diagnostics: [],
        refsStable: true
      };
    });

    const report = await assessGovernance(root, {
      live: true,
      runner: missingGitRunner,
      now
    });
    const finding = report.findings.find((entry) =>
      entry.controlId === controlId
    );

    expect(report.snapshot.inputsStable).toBe(false);
    expect(finding).toMatchObject({
      applicability: 'unknown',
      classification: 'not-observed',
      missingProof: ['evidence']
    });
    expect(report.coverage.unknownApplicability)
      .toBeGreaterThan(before.coverage.unknownApplicability);
  });

  it('withholds live reads without a verified Git origin even when requested', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'governance'));
    const current = state();
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify(current));
    const before = await tree(root);
    const calls: ExternalCommand[] = [];
    const runner: CommandRunner = {
      async run(command) {
        calls.push(command);
        return {
          command, displayCommand: command.executable, status: 0, signal: null,
          stdout: JSON.stringify({ id: 123, node_id: 'R_assessment', full_name: 'owner/repo', default_branch: 'develop' }),
          stderr: '', timedOut: false
        };
      }
    };
    await assessGovernance(root, { runner, now });
    expect(calls).toHaveLength(0);
    const live = await assessGovernance(root, { live: true, runner, now });
    expect(live.mode).toBe('live');
    expect(calls).toEqual([]);
    expect(live.diagnostics).toContainEqual(expect.objectContaining({
      code: 'live-repository-unbound'
    }));
    expect(await tree(root)).toBe(before);
  });

  it('renders the same versioned report through strict project-aware CLI routing', async () => {
    const root = await fixture();
    const stdout = new CaptureStream();
    const code = await runCommand(parseArgs(['governance', 'assess', '--json']), {
      cwd: root, stdout, stderr: new CaptureStream(), runner: noCommands
    });
    expect(code).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({ command: 'governance assess', schemaVersion: 1, outcome: 'partial' });
  });

  it('requires exact identity, baseline, resource, scope and expiry for exceptions', () => {
    const control = loadAssessmentCatalog().catalog.controls.find((entry) => entry.id === 'security.action-pinning')!;
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'workflow-source-ready')!;
    const current = state();
    const context = evidenceContextForPhase(phase.id, {
      repositoryId: current.repository.id,
      baselineSha: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      now: now()
    });
    const plan = transitionPlanForPhase(phase, current, context.transition);
    const action = 'slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.1.0';
    const approval = {
      schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
      id: 'action-exception', ...plan,
      resources: [{ type: 'action-reference', identity: action }],
      destinations: [{ type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo', subscriptionId: null }],
      policyExceptions: [control.id], approvedAt: '2026-09-04T00:00:00Z', expiresAt: '2026-10-04T00:00:00Z', approver: 'owner'
    };
    const scope = { repository: 'owner/repo', environment: null, resource: null };
    expect(findAssessmentException(control, [approval], scope, plan.baselineSha, action, now())).toMatchObject({ id: approval.id });
    expect(findAssessmentException(control, [approval], { ...scope, repository: 'other/repo' }, plan.baselineSha, action, now())).toBeNull();
    expect(findAssessmentException(control, [approval], scope, 'f'.repeat(64), action, now())).toBeNull();
    expect(findAssessmentException(control, [{ ...approval, expiresAt: '2026-09-04T00:00:00Z' }], scope, plan.baselineSha, action, now())).toBeNull();
    expect(rejectedAssessmentExceptionDiagnostic(
      control,
      [{ ...approval, expiresAt: '2026-09-04T00:00:00Z' }],
      null
    )).toMatchObject({
      code: 'rejected-exception',
      severity: 'warning',
      source: control.id,
      message: expect.stringContaining('was rejected')
    });
  });

  it('does not classify different declared and enforced check bindings as aligned', async () => {
    const root = await fixture();
    const ruleset = (context: string) => ({
      target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context, integration_id: 42 }] } }]
    });
    await mkdir(path.join(root, 'governance', 'rulesets'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'rulesets', 'checks.json'), JSON.stringify(ruleset('Security Scan')));
    const origin = source('github', 'https://api.github.com/repos/owner/repo', now().toISOString());
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.repository': observed({ defaultBranch: 'develop' }, origin),
        'github.rulesets': observed([ruleset('Lint')], origin),
        'github.checks': observed(['develop', 'main'].map((ref) => ({
          ref, sha: 'a'.repeat(40), checks: [{ name: 'Lint', appId: 42, status: 'completed', conclusion: 'success' }]
        })), origin)
      }, diagnostics: [], refsStable: true
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report.findings.find((item) => item.controlId === 'governance.required-contexts')?.classification).toBe('conflicting');
  });

  it('retains a known ruleset mismatch when check-run proof is unavailable', async () => {
    const root = await fixture();
    const ruleset = (context: string) => ({
      target: 'branch', enforcement: 'active', bypass_actors: [],
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context, integration_id: 42 }] } }]
    });
    await mkdir(path.join(root, 'governance', 'rulesets'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'rulesets', 'checks.json'), JSON.stringify(ruleset('Security Scan')));
    const origin = source('github', 'https://api.github.com/repos/owner/repo', now().toISOString());
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.repository': observed({ defaultBranch: 'develop' }, origin),
        'github.rulesets': observed([ruleset('Lint')], origin)
      }, diagnostics: [], refsStable: true
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    const finding = report.findings.find((item) => item.controlId === 'governance.required-contexts');
    expect(finding).toMatchObject({ classification: 'conflicting', missingProof: ['live'] });
    expect(finding?.reasons.join(' ')).toContain('bindings differ');
    expect(report.outcome).toBe('partial');
  });

  it('binds declared tag bypass to the same verified Actions app as live rules', async () => {
    const root = await fixture();
    const creation = (actor: number) => ({
      target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [{ actor_type: 'Integration', actor_id: actor, bypass_mode: 'always' }],
      rules: [{ type: 'creation' }]
    });
    const immutable = {
      target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }]
    };
    await mkdir(path.join(root, 'governance', 'rulesets'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'rulesets', 'creation.json'), JSON.stringify(creation(999999)));
    await writeFile(path.join(root, 'governance', 'rulesets', 'immutable.json'), JSON.stringify(immutable));
    const origin = source('github', 'https://api.github.com/repos/owner/repo/rulesets', now().toISOString());
    vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {
        'github.actions-app': observed({ id: 15368, slug: 'github-actions' }, origin),
        'github.rulesets': observed([creation(15368), immutable], origin)
      }, diagnostics: [], refsStable: true
    });
    const report = await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(report.findings.find((item) => item.controlId === 'release.tag-controls')?.classification).toBe('conflicting');
  });

  it('does not let future or unbound approvals authorize Azure collection', async () => {
    const root = await fixture();
    const current = state();
    current.remoteBinding = {
      id: 'R_assessment',
      name: 'owner/repo',
      defaultBranch: 'develop',
      pushUrl: 'https://github.com/owner/repo.git',
      verifiedAt: '2026-09-04T00:00:00Z'
    };
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'provider-ready')!;
    const plan = transitionPlanForPhase(phase, current, evidenceContextForPhase(phase.id, {
      repositoryId: current.repository.id,
      baselineSha: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      now: now()
    }).transition);
    const subscriptionId = '00000000-0000-0000-0000-000000000001';
    const approval = {
      schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
      id: 'future', ...plan,
      approvedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', approver: 'owner',
      resources: [{ type: 'Microsoft.Storage/storageAccounts', identity: `/subscriptions/${subscriptionId}/resourceGroups/app/providers/Microsoft.Storage/storageAccounts/state` }],
      destinations: [
        { type: 'repository', identity: 'owner/repo', repository: 'owner/repo', subscriptionId: null },
        { type: 'environment', identity: 'staging', repository: 'owner/repo', subscriptionId },
        { type: 'subscription', identity: subscriptionId, repository: 'owner/repo', subscriptionId }
      ]
    };
    await mkdir(path.join(root, 'governance', 'approvals'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify(current));
    await writeFile(path.join(root, 'governance', 'approvals', 'future.json'), JSON.stringify(approval));
    const collector = vi.spyOn(liveModule, 'collectLiveAssessment').mockResolvedValue({
      observations: {}, diagnostics: [], refsStable: true
    });
    await assessGovernance(root, { live: true, runner: noCommands, now });
    expect(collector).toHaveBeenCalledWith(expect.objectContaining({ azure: [], runner: null }), expect.any(Object));
  });

  it('selects only referenced evidence bound to a real baseline and saved phase context', async () => {
    const root = await fixture();
    const current = state();
    current.remoteBinding = {
      id: 'R_assessment',
      name: 'owner/repo',
      defaultBranch: 'develop',
      pushUrl: 'https://github.com/owner/repo.git',
      verifiedAt: '2026-09-04T00:00:00Z'
    };
    const phaseId = 'phase-0-complete';
    const baselineSha = 'a'.repeat(64);
    const inputDigest = 'b'.repeat(64);
    const contexts = Object.fromEntries(phaseIds.map((id) => [id,
      evidenceContextForPhase(id, {
        repositoryId: current.repository.id,
        baselineSha,
        inputDigest,
        remoteBindingDigest: remoteBindingDigest(current.remoteBinding),
        now: now()
      })
    ])) as Record<(typeof phaseIds)[number], EvidenceFreshnessContext>;
    const plan = savedAssessmentPlan(phaseId, current, contexts[phaseId], [], [{
      adapter: 'github',
      actionId: 'github.phase0.discover',
      mutationClass: 'github-read',
      phaseId,
      inputs: { sourceDigest: 'c'.repeat(64) },
      destination: {
        type: 'repository',
        identity: 'owner/repo',
        repository: 'owner/repo'
      },
      remote: true,
      destructive: false
    }]);
    const context = contexts[phaseId];
    const payload = {
      kind: 'phase-0-discovery.v1',
      planDigest: plan.planDigest,
      savedPlanDigest: canonicalSha256(plan),
      facts: [
        { id: 'repository.id', value: current.repository.id },
        { id: 'repository.nameWithOwner', value: current.repository.name },
        { id: 'repository.defaultBranch', value: current.repository.defaultBranch }
      ]
    };
    const liveReadback = [{
      schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
      repositoryId: current.repository.id,
      identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash,
      phaseId,
      baselineSha,
      inputDigest,
      transition: context.transition,
      observedAt: now().toISOString(),
      provider: 'github' as const,
      resourceType: 'repository',
      resourceId: 'owner/repo',
      sourceDigest: 'c'.repeat(64),
      readbackDigest: 'c'.repeat(64),
      matches: true
    }];
    const record: PhaseEvidenceRecord = {
      evidenceId: 'bound-discovery',
      header: {
        schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
        repositoryId: current.repository.id, identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash, phaseId, phaseContractDigest: context.phaseContractDigest,
        baselineSha, inputDigest, transition: context.transition,
        producedAt: now().toISOString(), producer: 'test',
        bodyDigest: evidenceBodyDigest(payload, liveReadback),
        remoteBindingDigest: remoteBindingDigest(current.remoteBinding),
        result: 'verified'
      },
      payload,
      liveReadback
    };
    current.phases[phaseId] = {
      ...current.phases[phaseId], state: 'verified',
      evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }]
    };
    await mkdir(path.join(root, 'governance', 'plans'), { recursive: true });
    await mkdir(path.join(root, 'governance', 'evidence'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'plans', 'discovery.json'), JSON.stringify(plan));
    await writeFile(path.join(root, 'governance', 'evidence', 'discovery.json'), JSON.stringify(record));
    await writeFile(path.join(root, 'governance', 'activation-state.json'), JSON.stringify(current));
    const project = await inspectAssessmentProject(new AssessmentFiles(root));
    expect(project.approvals).toEqual([]);
    const selectionContext = {
      ...context,
      evidenceReferences: current.phases[phaseId].evidence,
      reviewedPlans: [plan],
      liveReadbackProviders: ['github'] as const
    };
    const invalidFirst = {
      ...record,
      payload: {
        ...payload,
        facts: [{ id: 'repository.id', value: 'tampered' }]
      }
    };
    const selection = selectLatestPhaseEvidence(
      [invalidFirst, record],
      selectionContext
    );
    expect(selection.issues).toEqual([]);
    expect(selection.historicalIssues).not.toEqual([]);
    expect(selection.selected?.payload).toEqual(payload);
    project.bindingBaseline = baselineSha;
    project.state = current;
    project.evidence = [invalidFirst, record];
    project.plans = [plan];
    project.evidenceContexts = {
      ...contexts,
      [phaseId]: selectionContext
    };
    project.activationSelections = {
      [phaseId]: selection
    };
    expect(selectBoundAssessmentEvidence(project, phaseId, now())?.evidenceId).toBe(record.evidenceId);
    expect(selectBoundAssessmentEvidence(project, phaseId, now())?.payload).toEqual(payload);

    project.activationSelections = {
      [phaseId]: selectLatestPhaseEvidence([record], {
        ...selectionContext,
        reviewedPlans: []
      })
    };
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();

    project.activationSelections = {
      [phaseId]: selectLatestPhaseEvidence([record], {
        ...selectionContext,
        reviewedPlans: [{
          ...plan,
          createdAt: '2026-09-04T23:59:59.000Z'
        }]
      })
    };
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();

    project.activationSelections = {
      [phaseId]: selectLatestPhaseEvidence([record], {
        ...selectionContext,
        evidenceReferences: []
      })
    };
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();
    project.bindingBaseline = null;
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).toBeNull();
  });

  it('does not infer Azure assessment roles from approval phase names alone', async () => {
    const root = await fixture();
    const current = state();
    current.remoteBinding = {
      id: 'R_assessment',
      name: 'owner/repo',
      defaultBranch: 'develop',
      pushUrl: 'https://github.com/owner/repo.git',
      verifiedAt: '2026-09-04T00:00:00Z'
    };
    current.applicability.privateStagingDast = true;
    const phaseId = 'provider-ready';
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
    const baselineSha = 'a'.repeat(64);
    const inputDigest = 'b'.repeat(64);
    const contexts = Object.fromEntries(phaseIds.map((id) => [id,
      evidenceContextForPhase(id, {
        repositoryId: current.repository.id,
        baselineSha,
        inputDigest,
        remoteBindingDigest: remoteBindingDigest(current.remoteBinding),
        now: now()
      })
    ])) as Record<(typeof phaseIds)[number], EvidenceFreshnessContext>;
    const authority = transitionPlanForPhase(phase, current, contexts[phaseId].transition);
    const subscriptionId = '00000000-0000-0000-0000-000000000001';
    const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/app/providers/Microsoft.Storage/storageAccounts/app`;
    const approval = {
      schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
      id: 'approved-resources', ...authority,
      approvedAt: '2026-09-04T00:00:00Z', expiresAt: '2026-10-04T00:00:00Z', approver: 'owner',
      resources: [...authority.resources, { type: 'Microsoft.Storage/storageAccounts', identity: resourceId }],
      destinations: [
        ...authority.destinations,
        { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo', subscriptionId: null },
        { type: 'environment' as const, identity: 'staging', repository: 'owner/repo', subscriptionId },
        { type: 'subscription' as const, identity: subscriptionId, repository: 'owner/repo', subscriptionId }
      ]
    };
    const plan = savedAssessmentPlan(phaseId, current, contexts[phaseId], [approval], [{
      adapter: 'azure-opentofu',
      actionId: 'azure.provider.ensure-ready',
      mutationClass: 'azure-provider-register',
      phaseId,
      inputs: { sourceDigest: 'c'.repeat(64) },
      destination: {
        type: 'subscription',
        identity: subscriptionId,
        subscriptionId
      },
      remote: true,
      destructive: false
    }]);
    expect(plan?.approval.evaluation.status).toBe('reused');
    expect(plan?.planDigest).not.toBe(approval.planDigest);
    current.phases[phaseId].approvals = [approval.id];
    const project = await inspectAssessmentProject(new AssessmentFiles(root));
    project.state = current;
    project.bindingBaseline = baselineSha;
    project.inputSnapshot = {
      schemaVersion: 2,
      project: {},
      files: [],
      git: {
        head: null,
        branch: 'develop',
        pushUrls: ['https://github.com/owner/repo.git']
      },
      baselineSha
    };
    project.evidenceContexts = contexts;
    project.plans = [plan!];
    project.approvals = [approval];
    const git = {
      isRepository: true,
      repository: { owner: 'owner', name: 'repo', id: null },
      pushUrls: ['https://github.com/owner/repo.git'],
      head: null,
      issues: [],
      originState: 'verified' as const
    };
    expect(resolveAssessmentLiveScope(project, git, now()).azure).toEqual([]);
    const readback = {
      schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
      repositoryId: current.repository.id,
      identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash,
      phaseId,
      baselineSha,
      inputDigest,
      transition: contexts[phaseId].transition,
      observedAt: now().toISOString(),
      provider: 'azure' as const,
      resourceType: 'Microsoft.Storage/storageAccounts',
      resourceId,
      sourceDigest: 'c'.repeat(64),
      readbackDigest: 'c'.repeat(64),
      matches: true
    };
    const payload = {
      kind: 'provider-ready.v1',
      planDigest: plan.planDigest,
      savedPlanDigest: canonicalSha256(plan),
      assessmentScope: {
        azure: [{
          subscriptionId,
          environment: 'staging',
          resourceId,
          resourceType: 'Microsoft.Storage/storageAccounts',
          role: 'application'
        }]
      }
    };
    const evidence: PhaseEvidenceRecord = {
      evidenceId: 'provider-scope',
      header: {
        schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
        repositoryId: current.repository.id,
        identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash,
        phaseId,
        phaseContractDigest: contexts[phaseId].phaseContractDigest,
        baselineSha,
        inputDigest,
        transition: contexts[phaseId].transition,
        producedAt: now().toISOString(),
        producer: 'test',
        bodyDigest: evidenceBodyDigest(payload, [readback]),
        remoteBindingDigest: remoteBindingDigest(current.remoteBinding),
        result: 'verified'
      },
      payload,
      liveReadback: [readback]
    };
    current.phases[phaseId] = {
      ...current.phases[phaseId],
      state: 'verified',
      evidence: [{
        phaseId,
        evidenceId: evidence.evidenceId,
        headerDigest: canonicalSha256(evidence.header),
        result: 'verified'
      }]
    };
    project.evidence = [evidence];
    const providerContext = {
      ...contexts[phaseId],
      evidenceReferences: current.phases[phaseId].evidence,
      reviewedPlans: [plan],
      liveReadbackProviders: ['azure']
    };
    const providerSelection = selectLatestPhaseEvidence(
      [evidence],
      providerContext
    );
    expect(providerSelection.issues).toEqual([]);
    project.evidenceContexts = {
      ...contexts,
      [phaseId]: providerContext
    };
    project.activationSelections = {
      [phaseId]: providerSelection
    };
    expect(selectBoundAssessmentEvidence(project, phaseId, now())).not.toBeNull();
    expect(resolveAssessmentLiveScope(project, git, now()).azure).toContainEqual({
      subscriptionId,
      environment: 'staging',
      resourceId,
      resourceType: 'Microsoft.Storage/storageAccounts',
      role: 'application'
    });
    project.inputSnapshot = {
      ...project.inputSnapshot,
      git: {
        ...project.inputSnapshot.git,
        pushUrls: ['https://github.com/other/repo.git']
      }
    };
    expect(resolveAssessmentLiveScope(project, git, now()).azure).toEqual([]);
    project.inputSnapshot = {
      ...project.inputSnapshot,
      git: {
        ...project.inputSnapshot.git,
        pushUrls: ['https://github.com/owner/repo.git']
      }
    };
    project.approvals = [{ ...approval, approvedAt: '2026-10-01T00:00:00Z' }];
    expect(resolveAssessmentLiveScope(project, git, now()).azure).toEqual([]);
  });
});
