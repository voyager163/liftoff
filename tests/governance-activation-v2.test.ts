import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { writeArtifacts, writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import type { CommandRunner } from '../src/process-runner.js';
import {
  canonicalPhaseGraph, canonicalSha256, currentActivationIdentity, evidenceBodyDigest,
  evidenceContextForPhase, phaseCapabilities, readActivationInputSnapshot, selectLatestPhaseEvidence,
  validateEvidenceFreshness, type EvidenceHeader, type PhaseEvidenceRecord,
  evaluateApprovalForTransitionPlan, transitionPlanForPhase, phaseIds, type UserActivationState,
  executeApplyNext, buildSavedTransitionPlan, loadActivationState, activationEvidenceContexts,
  type GovernanceTransitionInspection,
  historicalActivationIdentities,
  selectSeedBaselineChecks,
  verifyGeneratedSeedBaselineForPhase,
  sha256Hex
} from '../src/governance-activation/index.js';
import { inspectCurrentActivationEvidence, readActivationEvidence, readReviewedTransitionPlans } from '../src/governance-activation/read-only.js';
import { ignoredByRules, parseGitIgnore } from '../src/governance-activation/git-ignore.js';
import { dependencySatisfied } from '../src/domain/governance/activation/readiness.js';
import { projectMutationLockPath, withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { assessInfrastructureLayout, retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const roots: string[] = [];
let counter = 0;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const plan = buildProjectPlan({
    projectName: `activation-proof-${++counter}`, projectType: 'standard', apiStack: 'node',
    specWorkflow: 'spec-kit', agents: ['copilot'], defaultAgent: 'copilot',
    environments: ['prod'], includeFrontend: false
  }, { requireProjectName: true });
  const root = path.join(process.cwd(), '.cache', `activation-v2-${process.pid}-${counter}`);
  roots.push(root);
  await writeArtifacts(root, buildArtifacts(plan));
  for (const marker of [...plan.framework.baseMarkers, ...plan.framework.agentMarkers['github-copilot']]) {
    await writeProjectFile(root, marker, 'official marker fixture\n');
  }
  await writeProjectFile(root, ['.specify', 'integration.json'], JSON.stringify({
    default_integration: 'copilot', installed_integrations: ['copilot']
  }));
  return root;
}

async function cli(root: string, command: string[], runner: CommandRunner = new ReadyInitRunner()) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['governance', ...command, '--json']), {
    cwd: root, stdout, stderr, runner
  });
  return { code, output: stdout.text(), error: stderr.text(), json: JSON.parse(stdout.text() || '{}') };
}

async function assertCurrentEvidence(root: string, expected: readonly string[], runner: CommandRunner) {
  const status = await cli(root, ['status'], runner);
  expect(status.code, status.output + status.error).toBe(0);
  for (const phaseId of expected) {
    expect(status.json.evidenceFreshness.find((entry: { phaseId: string }) => entry.phaseId === phaseId))
      .toMatchObject({ status: 'fresh', selectedResult: 'verified', issues: [] });
  }
  const verified = await cli(root, ['verify'], runner);
  expect(verified.json.consistent, verified.output + verified.error).toBe(true);
  return status.json;
}

function record(result: EvidenceHeader['result'] = 'verified', producedAt = '2026-09-08T01:00:00.000Z'): PhaseEvidenceRecord {
  const context = evidenceContextForPhase('seed-valid', {
    repositoryId: 'local:fixture', baselineSha: canonicalSha256('baseline'), inputDigest: canonicalSha256('inputs')
  });
  const payload = { kind: 'seed-valid.v1', validated: true };
  return {
    evidenceId: `seed-${producedAt}-${result}`, payload,
    header: {
      schemaVersion: 2, repositoryId: context.repositoryId, identity: currentActivationIdentity,
      phaseGraphHash: context.phaseGraphHash, phaseId: 'seed-valid', phaseContractDigest: context.phaseContractDigest,
      baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
      producedAt, producer: 'fixture', result, bodyDigest: evidenceBodyDigest(payload)
    }
  };
}

describe('activation-v2 authoritative contracts', () => {
  it('rejects placeholder context construction and commits the canonical body', () => {
    expect(() => evidenceContextForPhase('seed-valid')).toThrow(/explicit/);
    const proof = record();
    const context = evidenceContextForPhase('seed-valid', {
      repositoryId: proof.header.repositoryId, baselineSha: proof.header.baselineSha, inputDigest: proof.header.inputDigest
    });
    expect(validateEvidenceFreshness(proof, context).valid).toBe(true);
    expect(validateEvidenceFreshness({ ...proof, payload: { kind: 'seed-valid.v1', validated: false } }, context).valid).toBe(false);
    expect(validateEvidenceFreshness(proof, { ...context, evidenceReferences: [] }).valid).toBe(false);
  });

  it('selects current evidence without stale history poisoning and blocks equally authoritative contradictions', () => {
    const proof = record();
    const context = evidenceContextForPhase('seed-valid', {
      repositoryId: proof.header.repositoryId, baselineSha: proof.header.baselineSha, inputDigest: proof.header.inputDigest
    });
    const old = record('failed', '2026-09-07T01:00:00.000Z');
    old.header.baselineSha = canonicalSha256('old');
    old.header.transition.baselineSha = old.header.baselineSha;
    expect(selectLatestPhaseEvidence([old, proof], context)).toMatchObject({
      selected: { evidenceId: proof.evidenceId }, issues: []
    });
    expect(selectLatestPhaseEvidence([proof, record('failed')], context).selected).toBeNull();
  });

  it('declares the 26-phase production capability inventory honestly', () => {
    expect(Object.keys(phaseCapabilities)).toHaveLength(26);
    expect(Object.values(phaseCapabilities).filter((entry) => entry.executor === 'built-in')).toHaveLength(10);
    expect(Object.values(phaseCapabilities).filter((entry) => entry.executor === 'injected-only')).toHaveLength(2);
    expect(Object.values(phaseCapabilities).filter((entry) => entry.executor === 'unavailable')).toHaveLength(14);
    expect(canonicalPhaseGraph.phases.find((phase) => phase.id === 'activation-approved')!.allowedMutations.local)
      .toContain('write-openspec-governance');
    const dependency = canonicalPhaseGraph.phases.find((phase) => phase.id === 'remote-ready')!.dependencies[0]!;
    const states = {
      'existing-private-path': { phaseId: 'existing-private-path' as const, state: 'blocked' as const, blockers: ['No private proof'] },
      'remote-import-verified': { phaseId: 'remote-import-verified' as const, state: 'inapplicable' as const, blockers: [] }
    };
    const selected = { applicability: { statePath: 'existing-private' } } as UserActivationState;
    expect(dependencySatisfied(dependency, states, selected)).toBe(false);
    expect(dependencySatisfied(dependency, { ...states, 'existing-private-path': {
      phaseId: 'existing-private-path', state: 'verified', blockers: []
    } }, selected)).toBe(true);
  });

  it('honors ignored directories, nested patterns, and explicit unignored paths before initial staging', () => {
    const rules = parseGitIgnore('node_modules/\n.env\n*.log\n!keep.log\n/backend/private/\n', '');
    expect(ignoredByRules('backend/node_modules', true, rules)).toBe(true);
    expect(ignoredByRules('.env', false, rules)).toBe(true);
    expect(ignoredByRules('backend/private', true, rules)).toBe(true);
    expect(ignoredByRules('backend/keep.log', false, rules)).toBe(false);
    expect(ignoredByRules('.secret', false, parseGitIgnore('*', ''))).toBe(true);
    expect(ignoredByRules('backend/.hidden', false, parseGitIgnore('**/*', ''))).toBe(true);
    expect(ignoredByRules('backend/a/b/cache.dat', false, parseGitIgnore('backend/**/cache.?at', ''))).toBe(true);
  });

  it('accepts only currently valid approval intervals and does not expand narrower authorized scope', () => {
    const state = { repository: { id: 'local:fixture', name: 'owner/repo', defaultBranch: 'develop' } } as UserActivationState;
    state.identity = currentActivationIdentity;
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'committed')!;
    const plan = transitionPlanForPhase(phase, state, record().header.transition);
    const now = new Date('2026-09-08T12:00:00.000Z');
    const envelope = { ...plan, schemaVersion: 2, id: 'approval-fixture', approver: 'owner',
      approvedAt: '2026-09-08T11:00:00.000Z', expiresAt: '2026-09-08T13:00:00.000Z' };
    expect(evaluateApprovalForTransitionPlan({ ...plan, permissions: plan.permissions.slice(0, 1) }, [envelope], { now }).status).toBe('reused');
    for (const interval of [
      { approvedAt: '2026-09-08T12:01:00.000Z' },
      { approvedAt: '2026-09-08T14:00:00.000Z' },
      { expiresAt: now.toISOString() },
      { expiresAt: 'invalid' }
    ]) {
      expect(evaluateApprovalForTransitionPlan(plan, [{ ...envelope, ...interval }], { now }).approvalRequired).toBe(true);
    }
  });
});

describe('activation-v2 local production adapter', () => {
  it.each(['legacy-shared', 'unknown'] as const)('withholds infrastructure recipes for recorded %s layout without moving project files', async (layout) => {
    const root = await fixture();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = await loadManifest(root);
    if (layout === 'legacy-shared') {
      const identity = retiredFlatRootInfrastructureIdentities.find((entry) => entry.logicalName === 'opentofu-main')!;
      const content = '// Existing shared root; do not move or initialize.\n';
      await writeProjectFile(root, [...identity.pathParts], content);
      manifest.projectArtifacts.push({
        ...identity, pathParts: [...identity.pathParts], generatedBy: '0.10.0', generationHash: `sha256:${sha256Hex(content)}`
      });
    } else {
      manifest.projectArtifacts = manifest.projectArtifacts.filter((entry) => entry.logicalName !== 'opentofu-application-main');
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect(assessInfrastructureLayout(manifest).kind).toBe(layout);
    expect(() => selectSeedBaselineChecks(manifest)).toThrow(new RegExp(`migration-required \\(${layout}\\)`));
    const source = await readActivationInputSnapshot(root, manifest);
    const manifestBytes = await readFile(manifestPath);
    const runner = new ReadyInitRunner();
    const baseline = await verifyGeneratedSeedBaselineForPhase(root, runner);
    expect(baseline).toMatchObject({ status: 'blocked', checks: [] });
    expect(baseline.status === 'blocked' ? baseline.issues.join(' ') : '').toContain(`migration-required (${layout})`);
    expect(runner.calls).toEqual([]);
    const status = await cli(root, ['status'], runner);
    expect(status.json.phases.find((phase: { id: string }) => phase.id === 'seed-verified'))
      .toMatchObject({ state: 'blocked', blockers: [expect.stringContaining(`migration-required (${layout})`)] });
    expect(await readFile(manifestPath)).toEqual(manifestBytes);
    expect(await readActivationInputSnapshot(root, manifest)).toEqual(source);
    await expect(readFile(path.join(root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds source inputs but excludes receipts, caches, credentials and task projection output', async () => {
    const root = await fixture();
    const manifest = await loadManifest(root);
    const before = await readActivationInputSnapshot(root, manifest);
    await writeProjectFile(root, ['.env'], 'TEST_SECRET=not-a-real-credential\n');
    await writeProjectFile(root, ['governance', 'evidence', 'ignored.json'], '{}');
    await writeProjectFile(root, ['backend', 'node_modules', 'ignored.js'], 'cache');
    const taskParts = ['specs', '000-liftoff-bootstrap', 'tasks.md'];
    await writeProjectFile(root, taskParts, (await readFile(path.join(root, ...taskParts), 'utf8')).replaceAll('[ ]', '[x]'));
    expect((await readActivationInputSnapshot(root, manifest)).baselineSha).toBe(before.baselineSha);
    await writeProjectFile(root, ['backend', 'src', 'changed.ts'], 'export const changed = true;\n');
    expect((await readActivationInputSnapshot(root, manifest)).baselineSha).not.toBe(before.baselineSha);
  });

  it('excludes only exact nested sibling reservation names rather than user lock files', async () => {
    const root = await fixture();
    const manifest = await loadManifest(root);
    const before = await readActivationInputSnapshot(root, manifest);
    const reservation = `.liftoff-mutation-${'a'.repeat(64)}.lock`;
    await writeProjectFile(root, ['backend', reservation], 'nested reservation\n');
    expect((await readActivationInputSnapshot(root, manifest)).baselineSha).toBe(before.baselineSha);
    const userFile = `.liftoff-mutation-${'a'.repeat(63)}.lock`;
    await writeProjectFile(root, ['backend', userFile], 'user input\n');
    await writeProjectFile(root, ['governance', 'rulesets', '.liftoff-review.lock'], 'reviewed governance input\n');
    const current = await readActivationInputSnapshot(root, manifest);
    expect(current.baselineSha).not.toBe(before.baselineSha);
    expect(current.files.map(({ path }) => path)).toEqual(expect.arrayContaining([
      `backend/${userFile}`, 'governance/rulesets/.liftoff-review.lock'
    ]));
    expect(current.files.some(({ path }) => path.endsWith(reservation))).toBe(false);
  });

  it('keeps read-only commands lock-free and reuses an existing lease for activation writes', async () => {
    const root = await fixture();
    const lockPath = await projectMutationLockPath(root);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const foreign = 'reservation held by an external fixture writer\n';
    await writeFile(lockPath, foreign, { flag: 'wx' });
    try {
      for (const command of ['status', 'resume', 'verify']) {
        const result = await cli(root, [command]);
        expect(result.code, result.output + result.error).toBe(0);
        expect(await readFile(lockPath, 'utf8')).toBe(foreign);
      }
      await expect(readFile(path.join(root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (await readFile(lockPath, 'utf8') === foreign) await rm(lockPath);
    }
    await withProjectMutationLock(root, async (lease) => {
      const original = await readFile(lockPath, 'utf8');
      const executed = await cli(root, ['apply-next', '--execute']);
      expect(executed.code, executed.output + executed.error).toBe(0);
      expect(executed.json.executedPhase).toBe('seed-valid');
      expect(await readFile(lockPath, 'utf8')).toBe(original);
      await lease.assertHeld();
    });
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never replaces an anchor created after a stale not-started inspection', async () => {
    const root = await fixture();
    expect((await cli(root, ['apply-next', '--execute'])).code).toBe(0);
    const manifest = await loadManifest(root);
    const loaded = (await loadActivationState(root))!;
    const before = await readFile(path.join(root, 'governance', 'activation-state.json'));
    const stale = {
      projectRoot: root,
      manifest,
      state: { ...loaded.state, repository: { ...loaded.state.repository, id: 'unbound' } },
      readiness: { nextReadyPhase: 'seed-valid', phases: {} }
    } as GovernanceTransitionInspection;
    let reinspected = false;
    await expect(executeApplyNext({
      inspection: stale,
      reinspect: async () => { reinspected = true; throw new Error('A replaced anchor must never reach reinspection.'); }
    })).rejects.toThrow(/changed after review/);
    expect(reinspected).toBe(false);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'))).toEqual(before);
  });

  it('executes Spec Kit local checks and handoff without OpenSpec or Git mutations and reuses its own evidence', async () => {
    const root = await fixture();
    const runner = new ReadyInitRunner();
    const initial = await cli(root, ['status'], runner);
    expect(initial.code, initial.output + initial.error).toBe(0);
    await expect(readFile(path.join(root, 'governance', 'activation-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const completed: string[] = [];
    let anchor: string | undefined;
    for (const phase of ['seed-valid', 'seed-verified', 'seed-archived']) {
      const result = await cli(root, ['apply-next', '--execute'], runner);
      expect(result.code, result.output + result.error).toBe(0);
      expect(result.json.executedPhase).toBe(phase);
      completed.push(phase);
      const status = await assertCurrentEvidence(root, completed, runner);
      anchor ??= status.executionAnchor;
      expect(status.executionAnchor).toBe(anchor);
    }
    expect(runner.calls.some((command) => command.executable === 'openspec')).toBe(false);
    expect(runner.calls.some((command) => command.executable === 'git' && ['init', 'commit', 'push'].includes(command.args[0]!))).toBe(false);
    const tasks = await readFile(path.join(root, 'specs', '000-liftoff-bootstrap', 'tasks.md'), 'utf8');
    expect(tasks.match(/- \[x\] B00[1-6]/g)).toHaveLength(6);
    await expect(readFile(path.join(root, 'openspec', 'config.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    const resumed = await cli(root, ['resume'], runner);
    expect(resumed.json.readOnly ?? true).toBe(true);
    expect(resumed.output).toContain('verified');
    const verified = await cli(root, ['verify'], runner);
    expect(verified.json.consistent, verified.output).toBe(true);
    expect(await readFile(path.join(root, 'specs', '000-liftoff-bootstrap', 'tasks.md'), 'utf8')).toBe(tasks);
    const tofuCalls = runner.callDetails.filter(({ command }) => command.executable === 'tofu' && command.args[0] !== 'fmt');
    expect(tofuCalls.length).toBe(2);
    expect(tofuCalls.every(({ options }) => options?.cwd?.endsWith(path.join('environments', 'prod')))).toBe(true);
  });

  it('reports adoption-required without silently creating a missing bundle', async () => {
    const root = await fixture();
    await rm(path.join(root, 'specs', '000-liftoff-bootstrap', 'plan.md'));
    const result = await cli(root, ['apply-next', '--execute']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('seed-adoption-required');
    await expect(readFile(path.join(root, 'specs', '000-liftoff-bootstrap', 'plan.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks current source before persisting baseline success or task projection', async () => {
    const root = await fixture();
    expect((await cli(root, ['apply-next', '--execute'])).code).toBe(0);
    const tasksPath = path.join(root, 'specs', '000-liftoff-bootstrap', 'tasks.md');
    const original = await readFile(tasksPath, 'utf8');
    const delegate = new ReadyInitRunner();
    const runner: CommandRunner = { async run(command, options) {
      if (command.executable === 'npm' && command.args[0] === 'test') {
        await writeFile(path.join(root, 'backend', 'src', 'concurrent.ts'), 'export const concurrent = true;\n');
      }
      return delegate.run(command, options);
    } };
    const result = await cli(root, ['apply-next', '--execute'], runner);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('inputs changed during execution');
    expect(await readFile(tasksPath, 'utf8')).toBe(original);
    const state = JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8'));
    expect(state.phases['seed-verified'].state).not.toBe('verified');
  });

  it('keeps inspection and resume read-only while an active local failure is explicitly retried', async () => {
    const root = await fixture();
    await cli(root, ['apply-next', '--execute']);
    const failing = await cli(root, ['apply-next', '--execute'], new ReadyInitRunner({ missing: ['npm'] }));
    expect(failing.code).not.toBe(0);
    const statePath = path.join(root, 'governance', 'activation-state.json');
    const original = await readFile(statePath, 'utf8');
    const resumed = await cli(root, ['resume']);
    expect(await readFile(statePath, 'utf8')).toBe(original);
    expect(resumed.json.phases.find((phase: { id: string }) => phase.id === 'seed-verified').retryable).toBe(true);
    const retried = await cli(root, ['apply-next', '--execute']);
    expect(retried.code, retried.output).toBe(0);
    expect(retried.json.executedPhase).toBe('seed-verified');
    const tasksPath = path.join(root, 'specs', '000-liftoff-bootstrap', 'tasks.md');
    const changed = (await readFile(tasksPath, 'utf8')).replace('[x] B003', '[ ] B003');
    await writeFile(tasksPath, changed);
    const verification = await cli(root, ['verify']);
    expect(verification.json.consistent).toBe(false);
    expect(await readFile(tasksPath, 'utf8')).toBe(changed);
  });

  it('preserves historical v1 state byte-for-byte and rejects execution', async () => {
    const root = await fixture();
    const history = `${JSON.stringify({ schemaVersion: 1, identity: historicalActivationIdentities[0] }, null, 2)}\n`;
    await mkdir(path.join(root, 'governance'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'activation-state.json'), history);
    const result = await cli(root, ['apply-next', '--execute']);
    expect(result.code).not.toBe(0);
    expect(result.output + result.error).toContain('diagnostic-only');
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')).toBe(history);
  });

  it('keeps the local anchor and local receipts valid when Phase 0 establishes a verified remote binding', async () => {
    const root = await fixture();
    expect((await cli(root, ['apply-next', '--execute'])).code).toBe(0);
    const prior = (await loadActivationState(root))!;
    await mkdir(path.join(root, '.git'));
    const manifest = await loadManifest(root);
    const url = 'https://github.com/owner/repository.git';
    let pushUrls = [url];
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command) {
        const key = `${command.executable} ${command.args.join(' ')}`;
        calls.push(key);
        let stdout = '';
        let status = 0;
        if (key === 'git rev-parse --show-toplevel') stdout = root;
        else if (key === 'git rev-parse --verify HEAD') stdout = 'a'.repeat(40);
        else if (key === 'git symbolic-ref --quiet --short HEAD') stdout = 'develop';
        else if (key.includes('git rev-parse --abbrev-ref')) status = 128;
        else if (key === 'git remote') stdout = 'origin';
        else if (key === 'git remote -v') stdout = `origin ${url} (fetch)\norigin ${url} (push)\n`;
        else if (key === 'git remote get-url --push --all origin') stdout = pushUrls.join('\n');
        else if (key.startsWith('git ls-remote')) stdout = `${'a'.repeat(40)}\trefs/heads/develop`;
        else if (key.startsWith('gh repo view owner/repository ')) stdout = JSON.stringify({
          id: 'R_REMOTE', nameWithOwner: 'owner/repository', defaultBranchRef: { name: 'develop' }, isPrivate: true
        });
        return { command, displayCommand: key, status, signal: null, stdout, stderr: '', timedOut: false };
      }
    };
    async function inspection(): Promise<GovernanceTransitionInspection> {
      const loaded = (await loadActivationState(root))!;
      const snapshot = await readActivationInputSnapshot(root, manifest, runner);
      const contexts = activationEvidenceContexts(canonicalPhaseGraph, loaded.state, snapshot);
      const plans = await readReviewedTransitionPlans(root);
      for (const id of phaseIds) contexts[id].reviewedPlans = plans;
      return {
        projectRoot: root, manifest, graph: canonicalPhaseGraph, graphHash: currentActivationIdentity.phaseGraphHash,
        loadedState: loaded, state: loaded.state, approvals: [], evidence: await readActivationEvidence(root), contexts,
        readiness: { nextReadyPhase: 'phase-0-complete', phases: Object.fromEntries(phaseIds.map((id) =>
          [id, { state: id === 'phase-0-complete' ? 'ready' : 'pending', blockers: [] }])) as GovernanceTransitionInspection['readiness']['phases'] },
        sourceOfTruth: { status: 'none', selected: null, candidates: [], createPlan: {
          status: 'blocked', changeId: 'unbound', workflowKind: 'spec-kit', reason: 'Phase 0 not yet recorded', requiredFacts: []
        } }
      };
    }
    const completed = ['seed-valid'];
    for (const phase of ['seed-verified', 'seed-archived']) {
      const local = await cli(root, ['apply-next', '--execute'], runner);
      expect(local.code, local.output).toBe(0);
      expect(local.json.executedPhase).toBe(phase);
      completed.push(phase);
      expect((await assertCurrentEvidence(root, completed, runner)).executionAnchor).toBe(prior.state.repository.id);
    }
    for (const phaseId of ['committed', 'pushed'] as const) {
      const current = await inspection();
      const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
      const requested = transitionPlanForPhase(phase, current.state, current.contexts[phaseId].transition, root,
        current.contexts[phaseId].publicationDestination);
      await writeProjectFile(root, ['governance', 'approvals', `${phaseId}.json`], JSON.stringify({
        ...requested, schemaVersion: 2, id: `${phaseId}-fixture-approval`, approver: 'fixture-owner',
        approvedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
      }));
      const published = await cli(root, ['apply-next', '--execute'], runner);
      expect(published.code, published.output).toBe(0);
      expect(published.json.executedPhase).toBe(phaseId);
      completed.push(phaseId);
      expect((await assertCurrentEvidence(root, completed, runner)).executionAnchor).toBe(prior.state.repository.id);
    }
    const result = await cli(root, ['apply-next', '--execute'], runner);
    expect(result.json.applied, result.output).toBe(true);
    expect(result.json.executedPhase).toBe('phase-0-complete');
    completed.push('phase-0-complete');
    expect((await assertCurrentEvidence(root, completed, runner)).executionAnchor).toBe(prior.state.repository.id);
    const verified = await cli(root, ['verify'], runner);
    expect(verified.json.consistent, verified.output).toBe(true);
    const observed = await inspectCurrentActivationEvidence(root, manifest, { runner });
    expect(observed.status).toBe('inspected');
    if (observed.status !== 'inspected') throw new Error('Missing persisted inspection');
    expect(observed.state.repository).toEqual(prior.state.repository);
    expect(observed.state.remoteBinding).toMatchObject({ id: 'R_REMOTE', name: 'owner/repository', pushUrl: url });
    expect(observed.state.applicability).toEqual({ statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' });
    expect(observed.selections['seed-valid']!.selected).not.toBeNull();
    expect(observed.selections['phase-0-complete']!.selected).not.toBeNull();
    expect(calls.some((call) => call.startsWith('az ') || /^git (?:push|init|commit) /.test(call))).toBe(false);

    const stateBytes = await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8');
    const rejected = await executeApplyNext({
      inspection: await inspection(), reinspect: inspection, runner,
      adapters: { phases: { 'phase-0-complete': { phaseId: 'phase-0-complete', async execute() {
        return { status: 'completed', resultState: 'verified', evidencePayload: {
          kind: 'phase-0-discovery.v1', facts: [
            { id: 'repository.id', value: 'R_REMOTE' }, { id: 'repository.nameWithOwner', value: 'owner/repository' },
            { id: 'repository.defaultBranch', value: 'develop' }
          ]
        } };
      } } } }
    });
    expect(rejected.applied).toBe(false);
    expect(rejected.message).toContain('requires github live readback');
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')).toBe(stateBytes);
    await expect(executeApplyNext({
      inspection: await inspection(), reinspect: inspection, runner,
      adapters: { phases: { 'phase-0-complete': { phaseId: 'phase-0-complete', async execute() {
        return { status: 'completed', fileMutations: [{ type: 'write', pathParts: ['unreviewed.txt'], content: 'unreviewed' }] };
      } } } }
    })).rejects.toThrow(/outside the reviewed plan/);
    await expect(readFile(path.join(root, 'unreviewed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const beforeBindingChange = await inspection();
    beforeBindingChange.readiness.nextReadyPhase = 'pushed';
    beforeBindingChange.approvals = [JSON.parse(await readFile(path.join(root, 'governance', 'approvals', 'pushed.json'), 'utf8'))];
    await expect(executeApplyNext({
      inspection: beforeBindingChange, runner,
      reinspect: async () => {
        pushUrls = ['https://github.com/unreviewed/changed.git'];
        const changed = await inspection();
        changed.readiness.nextReadyPhase = 'pushed';
        changed.approvals = beforeBindingChange.approvals;
        return changed;
      }
    })).rejects.toThrow(/push URL|push destination/);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')).toBe(stateBytes);
    expect(calls.some((call) => call.startsWith('git push '))).toBe(false);

    for (const destinations of [['https://github.com/other/destination.git'], [url, 'https://github.com/other/destination.git']]) {
      pushUrls = destinations;
      const pushed = await inspection();
      pushed.readiness.nextReadyPhase = 'pushed';
      await expect(buildSavedTransitionPlan({ inspection: pushed, runner })).rejects.toThrow(/push URL|push destination/);
    }
  });
});
