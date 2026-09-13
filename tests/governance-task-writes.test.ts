import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildArtifacts } from '../src/templates.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import type { PhaseEvidenceRecord, SavedTransitionPlan, TransitionOperation } from '../src/domain/governance/activation/types.js';
import { evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../src/domain/governance/activation/approvals.js';
import { evidenceBodyDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { assertPlanOperationsAllowed, governanceTaskProjectionAction, planDigestFor, taskProjectionContract } from '../src/domain/governance/activation/operations.js';
import { validateApprovalEnvelope } from '../src/domain/governance/activation/validators.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import { finalizeActivationHistoryMigration, planActivationHistoryMigration } from '../src/governance-activation/migration-history.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import { evidenceWriteOperation, stateWriteOperation } from '../src/governance-activation/transition-records.js';
import { governanceTaskLayoutHash } from '../src/governance-activation/task-projection.js';
import type { CommandRunner } from '../src/process-runner.js';
import { writeHistoricalV2Fixture } from './fixtures/activation-v2/fixture.js';
import { createActivationSuccessorRuntime } from './fixtures/activation-successor-runtime.js';
import { frameworkIntegrationPaths } from '../src/framework-validation.js';
import { planGovernanceTaskProjection } from '../src/governance-activation/task-writes.js';

const roots = new Set<string>();
const cacheRoot = path.resolve('tests', `.task-writes-loader-${process.pid}-${randomUUID()}`);
let loader: ViteDevServer;
let commands: typeof import('../src/governance-activation/commands.js');
let transitions: typeof import('../src/governance-activation/transitions.js');
beforeAll(async () => {
  loader = await createActivationSuccessorRuntime(cacheRoot);
  commands = await loader.ssrLoadModule('/src/governance-activation/commands.ts');
  transitions = await loader.ssrLoadModule('/src/governance-activation/transitions.ts');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
afterAll(async () => { await loader?.close(); await rm(cacheRoot, { recursive: true, force: true }); });

async function put(root: string, parts: readonly string[], value: string | Buffer | object) {
  const file = path.join(root, ...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value));
}

async function fixture(workflow: 'openspec' | 'spec-kit' = 'openspec') {
  const container = path.resolve('tests', `.task-writes-${process.pid}-${randomUUID()}`);
  roots.add(container);
  const root = path.join(container, 'project');
  const home = path.join(container, 'home');
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, 'state'), LOCALAPPDATA: path.join(home, 'local')
  })) vi.stubEnv(key, value);
  const historical = await writeHistoricalV2Fixture(root, { workflow });
  await mkdir(path.join(root, '.git'), { recursive: true });
  const runner: CommandRunner = {
    async run(command) {
      if (['az', 'gh', 'curl'].includes(command.executable) ||
        command.args.some((arg) => ['commit', 'push', 'apply', 'install', 'init', 'state'].includes(arg))) {
        throw new Error('No live or installation operations are permitted in task-write tests.');
      }
      const stdout = command.executable === 'git'
        ? command.args.includes('--show-toplevel') ? root
          : command.args[0] === 'symbolic-ref' ? 'develop' : command.args.includes('--verify') ? 'a'.repeat(40) : ''
        : '';
      return { command, displayCommand: `${command.executable} ${command.args.join(' ')}`, status: 0, signal: null, stdout, stderr: '', timedOut: false };
    }
  };
  const project = buildProjectPlan({
    projectName: 'Flight Log', projectType: 'standard', apiStack: 'node', specWorkflow: workflow,
    ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}),
    agents: ['github-copilot'], environments: ['dev', 'staging', 'prod'], includeFrontend: false
  }, { requireProjectName: true });
  const artifacts = buildArtifacts(project);
  const generated = JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content);
  // Existing v2-era application/provenance remains independent of its new control-plane identity.
  const sourceManifest = {
    ...historical.manifest,
    projectArtifacts: generated.projectArtifacts.map((artifact: object) => ({ ...artifact, generatedBy: '0.11.3' }))
  };
  await put(root, ['liftoff.manifest.json'], sourceManifest);
  for (const artifact of artifacts) {
    if ((artifact.lifecycle === 'project' || workflow === 'spec-kit' && ['seed', 'framework'].includes(artifact.lifecycle)) &&
      artifact.pathParts[0] !== 'openspec') await put(root, artifact.pathParts, artifact.content);
  }
  if (workflow === 'spec-kit') {
    for (const marker of [...project.framework.baseMarkers, ...frameworkIntegrationPaths(workflow, 'github-copilot')]) {
      if (marker.join('/') !== '.specify/integration.json') await put(root, marker, 'Official initialized framework marker fixture.\n');
    }
  }
  const planned = await planActivationHistoryMigration(root);
  if (planned.status !== 'eligible') throw new Error(JSON.stringify(planned));
  const migrated = finalizeActivationHistoryMigration(planned, canonicalSha256({ approved: planned.planDigest }), new Date('2026-09-12T00:00:00.000Z'));
  for (const mutation of migrated.mutations) {
    if (mutation.type === 'delete') await rm(path.join(root, ...mutation.pathParts));
    else await put(root, mutation.pathParts, mutation.content);
  }
  for (const artifact of artifacts.filter((entry) => entry.lifecycle === 'managed-core')) await put(root, artifact.pathParts, artifact.content);
  const manifest = parseManifest({ ...sourceManifest, liftoffVersion: '0.12.0', governance: { ...sourceManifest.governance, activationIdentity: currentActivationIdentity } });
  await put(root, ['liftoff.manifest.json'], manifest);
  const state = structuredClone(migrated.successor);
  state.remoteBinding = { id: 'R_CURRENT', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: '2026-09-12T00:00:00.000Z' };
  const snapshot = await readActivationInputSnapshot(root, manifest, runner);
  state.baselineAnchor = snapshot.baselineSha;
  const now = new Date('2026-09-12T00:01:00.000Z');
  for (const phaseId of ['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed', 'phase-0-complete'] as const) {
    const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
    const context = activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now)[phaseId];
    const action = {
      'seed-valid': 'openspec.seed.validate', 'seed-verified': 'openspec.seed.baseline-verify',
      'seed-archived': 'openspec.seed.archive', committed: 'git.verify-existing-commit',
      pushed: 'git.verify-existing-push', 'phase-0-complete': 'github.phase0.discover'
    }[phaseId];
    const remote = phaseId === 'pushed' || phaseId === 'phase-0-complete';
    const ops: TransitionOperation[] = [{
      phaseId, actionId: action, adapter: phaseId === 'phase-0-complete' ? 'github' : ['committed', 'pushed'].includes(phaseId) ? 'git' : 'selected-spec-workflow',
      mutationClass: remote ? 'github-read' : 'read-worktree',
      inputs: phaseId === 'seed-verified' ? { checks: [{ id: 'backend-tests', taskId: '2.2', applicable: true }] } : {},
      destination: remote ? { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' } : { type: 'local', identity: root },
      remote, destructive: false
    }, evidenceWriteOperation(phase, ['governance', 'evidence', `${phaseId}-current.json`]), stateWriteOperation(phase)];
    const request = transitionPlanForPhase(phase, state, context.transition, root, undefined, { operations: ops, fileChanges: [] });
    const approvals = phase.approvalGate.required ? [validateApprovalEnvelope({
      ...request, schemaVersion: 3, id: `${phaseId}-approval`, approvedAt: now.toISOString(),
      expiresAt: '2026-09-13T00:00:00.000Z', approver: 'fixture-owner'
    })] : [];
    for (const approval of approvals) {
      await put(root, ['governance', 'approvals', `${approval.id}.json`], approval);
      await writeGovernanceApprovalAuthority(root, canonicalSha256({ request }), approval);
    }
    const evaluation = evaluateApprovalForTransitionPlan(request, approvals, { now });
    const plan: SavedTransitionPlan = {
      schemaVersion: 2, scope: phaseId.startsWith('seed-') ? 'local' : 'activation', phaseId, createdAt: now.toISOString(),
      expiresAt: '2026-09-13T00:00:00.000Z', identity: currentActivationIdentity, graphHash: currentActivationIdentity.phaseGraphHash,
      stateHash: canonicalSha256(state), baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
      transitionDigest: context.transition.transitionDigest,
      planDigest: planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations: ops, approvalPlanDigest: request.planDigest }),
      mutationClasses: phase.allowedMutations, operations: ops, fileChanges: [],
      approval: { gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation, envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash },
      rollbackPlan: { phaseId, strategy: 'none', target: null, operations: [], retained: [], cleanupWarnings: [] }, noSecrets: true
    };
    const payload = {
      kind: phaseId === 'phase-0-complete' ? 'phase-0-discovery.v1' : `${phaseId}.v1`,
      planDigest: plan.planDigest, savedPlanDigest: canonicalSha256(plan),
      ...(phaseId === 'seed-verified' ? { checks: [{ id: 'backend-tests', taskId: '2.2', status: 'passed' }] } : {}),
      ...(phaseId === 'seed-archived' && snapshot.workflowSpecDigest ? { synchronizedSpecDigest: snapshot.workflowSpecDigest } : {}),
      ...(['committed', 'pushed'].includes(phaseId) ? { head: 'a'.repeat(40), pushUrl: 'https://github.com/owner/repo.git' } : {}),
      ...(phaseId === 'phase-0-complete' ? { facts: [
        { id: 'repository.id', value: 'R_CURRENT' }, { id: 'repository.nameWithOwner', value: 'owner/repo' }, { id: 'repository.defaultBranch', value: 'develop' }
      ] } : {})
    };
    const readback = remote ? [{
      schemaVersion: 3, identity: state.identity, repositoryId: state.repository.id, phaseGraphHash: state.identity.phaseGraphHash,
      phaseId, baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
      observedAt: now.toISOString(), provider: 'github' as const, resourceType: 'repository', resourceId: 'owner/repo',
      sourceDigest: canonicalSha256(payload), readbackDigest: canonicalSha256(payload), matches: true
    }] : [];
    const record: PhaseEvidenceRecord = {
      evidenceId: `${phaseId}-current`, payload, liveReadback: readback,
      header: {
        schemaVersion: 3, scope: plan.scope, identity: state.identity, repositoryId: state.repository.id,
        phaseGraphHash: state.identity.phaseGraphHash, phaseId, phaseContractDigest: context.phaseContractDigest,
        baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
        producedAt: now.toISOString(), producer: 'validated-transport-fixture', result: 'verified', bodyDigest: evidenceBodyDigest(payload, readback),
        ...(phaseId === 'phase-0-complete' ? { remoteBindingDigest: context.remoteBindingDigest } : {})
      }
    };
    state.phases[phaseId] = { state: 'verified', updatedAt: now.toISOString(), blockers: [], approvals: approvals.map((entry) => entry.id),
      evidence: [{ phaseId, evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), result: 'verified' }] };
    const validity = validateEvidenceFreshness(record, { ...context, evidenceReferences: state.phases[phaseId].evidence, reviewedPlans: [plan] });
    expect(validity, JSON.stringify(validity)).toMatchObject({ valid: true });
    await put(root, ['governance', 'plans', `${phaseId}-current.json`], plan);
    await put(root, ['governance', 'evidence', `${record.evidenceId}.json`], record);
  }
  await put(root, ['governance', 'activation-state.json'], state);
  let ticks = 0;
  const clock = () => new Date(Date.parse('2026-09-12T00:02:00.000Z') + ticks++ * 1000);
  const inspect = (scope: 'local' | 'activation' = 'activation') => commands.inspectGovernanceTransition(root, { runner, now: clock(), scope });
  return { root, runner, inspect, clock, historical, migrated };
}

async function approveInitial(f: Awaited<ReturnType<typeof fixture>>) {
  const before = await f.inspect();
  const plan = await transitions.buildSavedTransitionPlan({ inspection: before, runner: f.runner, now: f.clock() });
  if (!plan) throw new Error(`Expected initial current source plan: ${JSON.stringify({
    seedValid: before.readiness.phases['seed-valid'], seedVerified: before.readiness.phases['seed-verified'],
    seedArchived: before.readiness.phases['seed-archived'], phase0: before.readiness.phases['phase-0-complete'],
    source: before.sourceOfTruth.status
  })}`);
  expect(plan.phaseId).toBe('activation-approved');
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === plan.phaseId)!;
  const request = transitionPlanForPhase(phase, before.state, before.contexts[phase.id].transition, f.root, undefined, {
    operations: plan.operations, fileChanges: plan.fileChanges, configuration: plan.configuration, recovery: plan.recovery
  });
  const approval = validateApprovalEnvelope({
    ...request, schemaVersion: 3, id: 'activation-source-approved', approvedAt: f.clock().toISOString(),
    expiresAt: '2026-09-13T00:00:00.000Z', approver: 'fixture-owner'
  });
  await put(f.root, ['governance', 'approvals', `${approval.id}.json`], approval);
  await writeGovernanceApprovalAuthority(f.root, canonicalSha256({ reviewedPlan: plan.planDigest }), approval);
  const inspection = await f.inspect();
  const result = await transitions.executeApplyNext({ inspection, reinspect: () => f.inspect(), runner: f.runner, clock: f.clock });
  expect(result, JSON.stringify(result)).toMatchObject({ applied: true, executedPhase: 'activation-approved' });
  const state = JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8'));
  const task = path.join(f.root, ...(state.taskProjection.taskPathParts as string[]));
  return { result, state, task, contract: taskProjectionContract(result.proposedMutations.operations)! };
}

describe('approved current governance task writes', { timeout: 90_000 }, () => {
  it.each(['openspec', 'spec-kit'] as const)('creates initial %s tasks from fresh post-approval readiness atomically after migration', async (workflow) => {
    const f = await fixture(workflow);
    const source = await approveInitial(f);
    const markdown = await readFile(source.task, 'utf8');
    expect(source.state.successorHistory).toEqual(f.migrated.successor.successorHistory);
    expect(source.state.taskProjection).toMatchObject({ status: 'complete', purpose: 'projection-audit-only' });
    expect(markdown).toContain('[x] 7.1');
    expect(source.state.taskProjection.states['activation-approved']).toBe('approved');
    expect(source.state.taskProjection.states['credential-ready']).toBe('blocked');
    expect(source.result.proposedMutations.operations.some((operation) => operation.actionId === governanceTaskProjectionAction)).toBe(true);
    expect(source.contract.source).toBe('create');
    if (source.contract.source === 'create') expect(source.contract.template).not.toContain('[x]');
    expect(source.result.executedOperations.some((operation) => operation.actionId === governanceTaskProjectionAction)).toBe(true);
  });

  it('keeps projection authority stable for derived checkbox changes, but not changes to other text', async () => {
    const f = await fixture();
    const initial = await approveInitial(f);
    const inspection = await f.inspect();
    const phase = canonicalPhaseGraph.phases.find((node) => node.id === 'rulesets-applied')!;
    const first = await planGovernanceTaskProjection(inspection, phase);
    const original = await readFile(initial.task, 'utf8');
    await writeFile(initial.task, original.replace(/\[x\]/g, '[ ]'));
    expect(await planGovernanceTaskProjection(inspection, phase)).toEqual(first);
    await writeFile(initial.task, `${original}\nAn edited source paragraph.\n`);
    expect(await planGovernanceTaskProjection(inspection, phase)).not.toEqual(first);
  });

  it('rejects unbounded paths and simultaneous generic task replacement in a projection plan', async () => {
    const f = await fixture();
    const inspection = await f.inspect();
    const plan = await transitions.buildSavedTransitionPlan({ inspection, runner: f.runner, now: f.clock() });
    if (!plan) throw new Error('Expected current source plan.');
    const projection = plan.operations.find((operation) => operation.actionId === governanceTaskProjectionAction)!;
    const contract = taskProjectionContract([projection])!;
    expect(() => taskProjectionContract([{
      ...projection, inputs: { projection: { ...contract, taskPathParts: ['backend', 'src', 'index.ts'] } }
    }])).toThrow(/exact current governance/);
    const phase = canonicalPhaseGraph.phases.find((node) => node.id === plan.phaseId)!;
    expect(() => assertPlanOperationsAllowed({
      ...plan, fileChanges: [...plan.fileChanges ?? [], { pathParts: contract.taskPathParts, beforeHash: null, afterHash: 'a'.repeat(64) }]
    }, phase)).toThrow(/generic task-file replacement/);
  });

  it('unchecks invalidated and unknown phases while preserving CRLF and all other task text', async () => {
    const f = await fixture();
    const initial = await approveInitial(f);
    const custom = (await readFile(initial.task, 'utf8')).replace(/\n/g, '\r\n') + '\r\nDeveloper-owned trailing text.\r\n';
    await writeFile(initial.task, custom);
    const metadata = JSON.parse(await readFile(path.join(path.dirname(initial.task), 'liftoff-governance.json'), 'utf8'));
    const layout = governanceTaskLayoutHash(custom, metadata);
    const seed = path.join(f.root, 'openspec', 'changes', 'archive', '20260830-bootstrap-flight-log', 'design.md');
    await writeFile(seed, `${await readFile(seed, 'utf8')}\nChanged current seed input.\n`);
    const inspection = await f.inspect('local');
    expect(inspection.readiness.nextReadyPhase).toBe('seed-valid');
    const result = await transitions.executeApplyNext({
      inspection, reinspect: () => f.inspect('local'), runner: f.runner, clock: f.clock,
      adapters: { phases: { 'seed-valid': { phaseId: 'seed-valid', async execute(input) {
        return { status: 'completed', resultState: 'verified', evidencePayload: { kind: 'seed-valid.v1' },
          completedOperations: input.plan.operations.filter((operation) => operation.actionId === 'openspec.seed.validate') };
      } } } }
    });
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true });
    const after = await readFile(initial.task, 'utf8');
    expect(governanceTaskLayoutHash(after, metadata)).toBe(layout);
    expect(after.endsWith('\r\nDeveloper-owned trailing text.\r\n')).toBe(true);
    expect(after).toContain('- [x] 1.1');
    expect(after).toContain('- [ ] 2.1');
    expect(after).toContain('- [ ] 7.1');
    const state = JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8'));
    expect(state.taskProjection.states['seed-verified']).not.toBe('verified');
  });

  it('preserves concurrent task edits and records an explicit resumable failure without successful proof', async () => {
    const f = await fixture();
    const initial = await approveInitial(f);
    const seed = path.join(f.root, 'openspec', 'changes', 'archive', '20260830-bootstrap-flight-log', 'design.md');
    await writeFile(seed, `${await readFile(seed, 'utf8')}\nNew verification input.\n`);
    const inspection = await f.inspect('local');
    const concurrent = `${await readFile(initial.task, 'utf8')}\nConcurrent developer text.\n`;
    const result = await transitions.executeApplyNext({
      inspection, reinspect: () => f.inspect('local'), runner: f.runner, clock: f.clock,
      adapters: { phases: { 'seed-valid': { phaseId: 'seed-valid', async execute(input) {
        await writeFile(initial.task, concurrent);
        return { status: 'completed', resultState: 'verified', evidencePayload: { kind: 'seed-valid.v1' },
          completedOperations: input.plan.operations.filter((operation) => operation.actionId === 'openspec.seed.validate') };
      } } } }
    });
    expect(result.applied).toBe(false);
    expect(result.evidence).toBeNull();
    expect(await readFile(initial.task, 'utf8')).toBe(concurrent);
    const state = JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8'));
    expect(state.phases['seed-valid'].state).toBe('blocked');
    expect(state.taskProjection.status).toBe('blocked');
  });

  it('projects a failed local operation as unchecked without inventing successful evidence', async () => {
    const f = await fixture();
    const initial = await approveInitial(f);
    const seed = path.join(f.root, 'openspec', 'changes', 'archive', '20260830-bootstrap-flight-log', 'design.md');
    await writeFile(seed, `${await readFile(seed, 'utf8')}\nA changed input.\n`);
    const inspection = await f.inspect('local');
    const result = await transitions.executeApplyNext({
      inspection, reinspect: () => f.inspect('local'), runner: f.runner, clock: f.clock,
      adapters: { phases: { 'seed-valid': { phaseId: 'seed-valid', async execute() {
        return { status: 'blocked', blocker: 'Fixture local check failed.', completedOperations: [] };
      } } } }
    });
    expect(result.applied).toBe(false);
    expect(result.evidence).toBeNull();
    expect(await readFile(initial.task, 'utf8')).toContain('- [ ] 1.1');
    expect(result.executedOperations.some((operation) => operation.actionId === governanceTaskProjectionAction)).toBe(true);
  });
});
