import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import {
  executeLocalRevalidation, previewLocalRevalidation,
  type LocalRevalidationPreview, type LocalRevalidationProgress
} from '../src/application/update/revalidation.js';
import { writeArtifacts, writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { evidenceBodyDigest, evidenceHeaderDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { historicalActivationIdentities } from '../src/domain/governance/policy/identity.js';
import { phaseIds, type UserActivationState } from '../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import type { ExternalCommand, LiftoffManifest, ProjectOptions } from '../src/domain/project/contracts.js';
import { retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import { inspectGovernanceTransition } from '../src/governance-activation/commands.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import { validateMigrationJournal } from '../src/governance-activation/history-contracts.js';
import {
  finalizeActivationHistoryMigration, inspectActivationMigrationHistory, planActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { readActivationEvidence, readReviewedTransitionPlans } from '../src/governance-activation/read-only.js';
import {
  generatedSeedCapabilityId, generatedSeedChangeName, selectSeedBaselineChecks
} from '../src/governance-activation/seed-lifecycle.js';
import { completedSpecKitTasks, specKitBootstrapPath } from '../src/governance-activation/spec-kit-seed.js';
import { buildSavedTransitionPlan, executeApplyNext } from '../src/governance-activation/transitions.js';
import { formatCommand, type CommandResult, type CommandRunner, type RunCommandOptions } from '../src/process-runner.js';
import { buildArtifacts } from '../src/templates.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream } from './helpers.js';
import { writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';

const roots: string[] = [];
let sequence = 0;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class LocalRunner implements CommandRunner {
  readonly calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];

  constructor(
    private readonly before?: (command: ExternalCommand, options?: RunCommandOptions) => Promise<Partial<CommandResult> | void>
  ) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    if (['az', 'gh', 'curl', 'npm-install', 'specify'].includes(command.executable) ||
      command.args.some((argument) => ['install', 'init', 'archive', 'commit', 'push', 'apply'].includes(argument))) {
      throw new Error(`Forbidden migration operation: ${formatCommand(command)}`);
    }
    const overrides = await this.before?.(command, options);
    return {
      command, displayCommand: formatCommand(command), status: 0, signal: null,
      stdout: '', stderr: '', timedOut: false, ...overrides
    };
  }
}

async function tree(root: string, ignored: readonly string[] = []): Promise<readonly { path: string; digest: string }[]> {
  const files: { path: string; digest: string }[] = [];
  async function visit(parts: string[]): Promise<void> {
    for (const entry of (await readdir(path.join(root, ...parts), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = [...parts, entry.name];
      const relative = child.join('/');
      if (ignored.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) await visit(child);
      else files.push({ path: relative, digest: createHash('sha256').update(await readFile(path.join(root, ...child))).digest('hex') });
    }
  }
  await visit([]);
  return files;
}

async function fixture(options: {
  workflow?: 'openspec' | 'spec-kit';
  archived?: boolean;
  completedTasks?: boolean;
  api?: ProjectOptions['apiStack'];
  frontend?: boolean;
  installed?: boolean;
  pattern?: string;
} = {}) {
  const name = `migration-revalidation-${++sequence}`;
  const root = path.join(process.cwd(), '.cache', `${name}-${process.pid}`);
  roots.push(root);
  const plan = buildProjectPlan({
    projectName: name,
    ...(options.pattern ? { projectType: 'genai', pattern: options.pattern } : { projectType: 'standard', apiStack: options.api ?? 'node' }),
    specWorkflow: options.workflow ?? 'openspec', agents: ['copilot'],
    ...(options.workflow === 'spec-kit' ? { defaultAgent: 'copilot' } : {}),
    environments: ['dev'], includeFrontend: options.frontend ?? false
  }, { requireProjectName: true });
  await writeArtifacts(root, buildArtifacts(plan));
  for (const marker of [...plan.framework.baseMarkers, ...plan.framework.agentMarkers['github-copilot']]) {
    await writeProjectFile(root, marker, 'official initialization marker fixture\n');
  }
  if (plan.specWorkflow.id === 'spec-kit') {
    await writeProjectFile(root, ['.specify', 'integration.json'], JSON.stringify({
      default_integration: 'copilot', installed_integrations: ['copilot']
    }));
    if (options.completedTasks !== false) {
      const tasks = await readFile(path.join(root, ...specKitBootstrapPath, 'tasks.md'), 'utf8');
      await writeProjectFile(root, [...specKitBootstrapPath, 'tasks.md'], completedSpecKitTasks(tasks));
    }
  }
  const manifest = await loadManifest(root);
  if (manifest.project.specWorkflow === 'openspec' && options.archived !== false) {
    const changeName = generatedSeedChangeName(manifest);
    const capability = generatedSeedCapabilityId(manifest.project.workload);
    const active = path.join(root, 'openspec', 'changes', changeName);
    const archive = path.join(root, 'openspec', 'changes', 'archive', `2026-08-01-${changeName}`);
    const delta = await readFile(path.join(active, 'specs', capability, 'spec.md'), 'utf8');
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(active, archive);
    await writeProjectFile(root, ['openspec', 'specs', capability, 'spec.md'],
      `# ${capability}\n\n${delta.replace('## ADDED Requirements', '## Requirements')}`);
  }
  if (options.installed !== false) {
    await mkdir(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev', '.terraform'), { recursive: true });
    const python = manifest.project.workload.kind === 'genai' || manifest.project.workload.apiStack === 'python-fastapi';
    await mkdir(path.join(root, 'backend', python ? '.venv' : 'node_modules'), { recursive: true });
    if (options.frontend) await mkdir(path.join(root, 'frontend', 'node_modules'), { recursive: true });
  }
  const createdAt = '2026-09-01T00:00:00.000Z';
  const state = validateUserActivationState({
    schemaVersion: 2, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name, defaultBranch: 'develop' },
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
      state: 'pending', updatedAt: createdAt, evidence: [], approvals: [], blockers: []
    }])),
    createdAt, updatedAt: createdAt
  });
  await writeState(root, state);
  let ticks = 0;
  const clock = () => new Date(Date.parse('2026-09-08T12:00:00.000Z') + ticks++);
  return { root, manifest, state, clock };
}

async function writeState(root: string, state: UserActivationState): Promise<void> {
  await writeProjectFile(root, ['governance', 'activation-state.json'], `${JSON.stringify(state, null, 2)}\n`);
}

async function approval(root: string, clock: () => Date, reuse = false) {
  const ignored = ['governance', 'liftoff.manifest.json', '.git'];
  const binding = canonicalSha256(await tree(root, ignored));
  const targetManifest = await loadManifest(root);
  const runner = new LocalRunner();
  const inspection = reuse ? await inspectGovernanceTransition(root, { runner, now: clock() }) : undefined;
  const preview = await previewLocalRevalidation({ projectRoot: root, targetManifest, protectedInputBinding: binding, inspection });
  return {
    preview,
    protectedInputs: {
      binding,
      async assertUnchanged() {
        if (canonicalSha256(await tree(root, ignored)) !== binding) throw new Error('Protected source inputs changed after preview.');
      }
    }
  };
}

describe('bounded migration local revalidation', {
  timeout: process.platform === 'win32' ? 90_000 : 30_000
}, () => {
  it('previews exact archived operations without commands, records, or project changes', async () => {
    const { root, clock } = await fixture();
    const before = await tree(root);
    const first = await approval(root, clock);
    const second = await approval(root, clock);
    expect(first.preview).toEqual(second.preview);
    expect(await tree(root)).toEqual(before);
    expect(first.preview.phases.map((phase) => phase.phaseId)).toEqual(['seed-valid', 'seed-verified', 'seed-archived']);
    expect(first.preview.phases.every((phase) => phase.operation.mutationClass === 'read-worktree' && !phase.operation.remote)).toBe(true);
    const commands = first.preview.phases.flatMap((phase) => phase.commands);
    expect(commands.some(({ command }) => command.args.includes('init') || command.args.includes('install') || command.args.includes('archive'))).toBe(false);
    expect(commands.filter(({ command }) => command.executable === 'openspec').every(({ command }) =>
      command.args.join(' ') === 'validate --all --strict')).toBe(true);
    expect(commands.find(({ command }) => command.executable === 'npm')).toMatchObject({
      command: { args: ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', 'test'] },
      cwdPathParts: ['backend'], env: { npm_config_offline: 'true', npm_config_ignore_scripts: 'true' }
    });
  });

  it('binds fresh v2 plans and evidence to the committed successor while retaining historical source bytes', async () => {
    const { root, manifest, clock, state } = await fixture();
    const originalManifest = { ...manifest, governance: {
      ...manifest.governance, activationIdentity: historicalActivationIdentities[0]
    } };
    const originalBytes = `${JSON.stringify(originalManifest, null, 4)}\r\n`;
    await writeProjectFile(root, ['liftoff.manifest.json'], originalBytes);
    const binding = canonicalSha256('reviewed successor transaction and protected local source inputs');
    const beforeSeed = await tree(path.join(root, 'openspec'));
    const preview = await previewLocalRevalidation({ projectRoot: root, targetManifest: manifest, protectedInputBinding: binding });
    await writeProjectFile(root, ['governance', 'history', 'reviewed-source', 'files', 'liftoff.manifest.json'], originalBytes);
    await writeProjectFile(root, ['liftoff.manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
    const committedStateHash = (await loadActivationState(root))!.contentHash;
    const runner = new LocalRunner();
    const progress: LocalRevalidationProgress[] = [];
    const result = await executeLocalRevalidation({
      approvedPreview: preview, protectedInputs: { binding, assertUnchanged() {} }, runner, clock,
      onProgress: (event) => { progress.push(event); }
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    expect(result.phaseResults.map((phase) => phase.status)).toEqual(['verified', 'verified', 'verified']);
    expect(progress.map((event) => event.status)).toEqual(['running', 'running', 'running', 'complete']);
    expect(await tree(path.join(root, 'openspec'))).toEqual(beforeSeed);
    expect(await readFile(path.join(root, 'governance', 'history', 'reviewed-source', 'files', 'liftoff.manifest.json'), 'utf8')).toBe(originalBytes);
    const inspection = await inspectGovernanceTransition(root, { runner, now: clock() });
    expect(inspection.state.repository.id).toBe(state.repository.id);
    expect(inspection.state.remoteBinding).toBeUndefined();
    expect(inspection.state.applicability.credentialRequired).toBe('unknown');
    const plans = await readReviewedTransitionPlans(root);
    expect(plans.find((plan) => plan.phaseId === 'seed-valid')?.stateHash).toBe(committedStateHash);
    expect(plans.every((plan) => plan.operations.every((operation) =>
      ['read-worktree', 'write-evidence', 'write-activation-state'].includes(operation.mutationClass)))).toBe(true);
    const records = await readActivationEvidence(root);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.header.schemaVersion).toBe(2);
      expect(record.header.identity.activationContractVersion).toBe(2);
      expect(record.header.bodyDigest).toBe(evidenceBodyDigest(record.payload, record.liveReadback));
      expect(validateEvidenceFreshness(record, inspection.contexts[record.header.phaseId]).valid).toBe(true);
    }
    const baseline = records.find((record) => record.header.phaseId === 'seed-verified');
    expect(baseline).toBeDefined();
    if (!baseline || !isRecord(baseline.payload)) throw new Error('Expected baseline payload.');
    const baselinePlan = plans.find((plan) => plan.phaseId === 'seed-verified');
    expect(baselinePlan).toBeDefined();
    const tamperedPayload = { ...baseline.payload, checks: [] };
    const tampered = { ...baseline, payload: tamperedPayload,
      header: { ...baseline.header, bodyDigest: evidenceBodyDigest(tamperedPayload) } };
    expect(validateEvidenceFreshness(tampered, { ...inspection.contexts['seed-verified'], evidenceReferences: [{
      phaseId: 'seed-verified', evidenceId: tampered.evidenceId, headerDigest: evidenceHeaderDigest(tampered.header), result: 'verified'
    }] }).valid).toBe(false);
    expect(runner.calls.every((call) => call.options?.timeoutMs === 120_000)).toBe(true);
  });

  it('observes completed Spec Kit work without projecting tasks or invoking OpenSpec', async () => {
    const { root, clock } = await fixture({ workflow: 'spec-kit' });
    const approved = await approval(root, clock);
    const tasks = await readFile(path.join(root, ...specKitBootstrapPath, 'tasks.md'), 'utf8');
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({ approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    expect(await readFile(path.join(root, ...specKitBootstrapPath, 'tasks.md'), 'utf8')).toBe(tasks);
    expect(runner.calls.some(({ command }) => command.executable === 'openspec')).toBe(false);
    expect((await readReviewedTransitionPlans(root)).some((plan) => plan.operations.some((operation) => operation.actionId === 'seed.tasks.project'))).toBe(false);
  });

  it('revalidates an authentic historical successor and journals unavailable baseline proof without inheriting publication approval', async () => {
    const root = path.join(process.cwd(), '.cache', `authentic-revalidation-${process.pid}-${++sequence}`);
    roots.push(root);
    const historical = await writeHistoricalV1Fixture(root);
    const migration = await planActivationHistoryMigration(root);
    expect(migration.status, JSON.stringify(migration)).toBe('eligible');
    if (migration.status !== 'eligible') throw new Error('Expected the exact supported historical fixture.');
    const core = buildArtifacts(buildProjectPlan({
      projectName: 'Flight Log', projectType: 'standard', apiStack: 'node-fastify',
      cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'],
      specWorkflow: 'openspec', agents: ['copilot'], includeFrontend: false
    }, { requireProjectName: true })).filter((artifact) => artifact.lifecycle === 'managed-core');
    const targetManifest: LiftoffManifest = {
      ...migration.inventory.manifest,
      liftoffVersion,
      governance: {
        profile: 'single-maintainer-gitflow', policyVersion: '6', state: 'handoff-generated',
        activationIdentity: currentActivationIdentity
      },
      managedArtifacts: core.map((artifact) => ({
        logicalName: artifact.logicalName, category: artifact.category, pathParts: [...artifact.pathParts],
        contentHash: `sha256:${createHash('sha256').update(artifact.content).digest('hex')}`
      }))
    };
    const binding = canonicalSha256({ historyPlan: migration.planDigest, source: 'reviewed historical fixture inputs' });
    const preview = await previewLocalRevalidation({ projectRoot: root, targetManifest, protectedInputBinding: binding });
    expect(preview.phases.find((phase) => phase.phaseId === 'seed-verified')?.blockers.join(' ')).toContain('migration-required');
    let ticks = 0;
    const clock = () => new Date(Date.parse('2026-09-08T13:00:00.000Z') + ticks++);
    const finalized = finalizeActivationHistoryMigration(
      migration, canonicalSha256({ migration: migration.semanticPlan, revalidation: preview }), clock()
    );
    for (const mutation of finalized.mutations) {
      const destination = path.join(root, ...mutation.pathParts);
      if (mutation.type === 'delete') await rm(destination);
      else {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, mutation.content, { mode: mutation.mode });
        await chmod(destination, mutation.mode);
      }
    }
    for (const artifact of core) await writeProjectFile(root, [...artifact.pathParts], artifact.content);
    await writeProjectFile(root, ['liftoff.manifest.json'], JSON.stringify(targetManifest));
    const runner = new LocalRunner();
    const beforeInputs = await readActivationInputSnapshot(root, targetManifest, runner);
    let journal = finalized.journal;
    const result = await executeLocalRevalidation({
      approvedPreview: preview, protectedInputs: { binding, assertUnchanged() {} }, runner, clock,
      async onProgress(progress) {
        journal = validateMigrationJournal({
          ...journal,
          revalidation: {
            status: progress.status, updatedAt: clock().toISOString(),
            nextAction: progress.status === 'complete' ? null : 'Repair the local prerequisite, then preview and approve remaining work.',
            phases: journal.revalidation.phases.map((phase) => {
              const completed = progress.phaseResults.find((entry) => entry.phaseId === phase.phaseId);
              if (completed) return {
                phaseId: phase.phaseId,
                status: completed.status === 'blocked' ? 'blocked' : 'complete',
                evidenceIds: completed.evidence ? [completed.evidence.evidenceId] : [],
                blockers: completed.blockers
              };
              if (phase.phaseId === progress.phaseId) return {
                phaseId: phase.phaseId, status: progress.status === 'running' ? 'running' : 'blocked',
                evidenceIds: [], blockers: progress.status === 'blocked' ? progress.blockers : []
              };
              return phase;
            })
          }
        });
        await writeProjectFile(root, ['governance', 'migration-state.json'], JSON.stringify(journal));
      }
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-verified' });
    expect(await inspectActivationMigrationHistory(root)).toMatchObject({
      status: 'committed',
      journal: { transaction: { status: 'committed' }, revalidation: { status: 'blocked' } },
      state: {
        schemaVersion: 2, repository: { id: finalized.successor.repository.id },
        phases: { 'seed-valid': { state: 'verified' }, committed: { state: 'pending', evidence: [], approvals: [] } }
      }
    });
    expect(await readActivationInputSnapshot(root, targetManifest, runner)).toEqual(beforeInputs);
    expect((await readActivationEvidence(root)).map((record) => record.header.phaseId)).toEqual(['seed-valid']);
    for (const file of migration.index.files) {
      expect(await readFile(path.join(root, ...file.copyPathParts))).toEqual(historical.files.get(file.originalPathParts.join('/')));
    }
    expect(await readFile(path.join(root, 'backend', 'src', 'index.ts'))).toEqual(historical.files.get('backend/src/index.ts'));
    expect(await readFile(path.join(root, 'governance', 'evidence', 'notes.txt'))).toEqual(historical.files.get('governance/evidence/notes.txt'));
    expect(runner.calls.map(({ command }) => formatCommand(command))).toEqual(['openspec validate --all --strict']);
  });

  it('preserves an active OpenSpec seed and stops before its separately reviewed archive transition', async () => {
    const { root, clock } = await fixture({ archived: false });
    const before = await tree(path.join(root, 'openspec'));
    const approved = await approval(root, clock);
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({ approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-archived' });
    expect(result.blockers.join(' ')).toContain('not already archived');
    expect(await tree(path.join(root, 'openspec'))).toEqual(before);
    expect((await readActivationEvidence(root)).map((record) => record.header.phaseId).sort()).toEqual(['seed-valid', 'seed-verified']);
  });

  it('blocks incomplete Spec Kit projection without writing the missing completion', async () => {
    const { root, clock } = await fixture({ workflow: 'spec-kit', completedTasks: false });
    const approved = await approval(root, clock);
    const before = await tree(path.join(root, 'specs'));
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({ approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-verified' });
    expect(result.blockers.join(' ')).toContain('projection');
    expect(runner.calls).toHaveLength(0);
    expect(await tree(path.join(root, 'specs'))).toEqual(before);
  });

  it('keeps ordinary setup recipes and task-write authority unchanged by default', async () => {
    const { root, manifest, clock } = await fixture({ workflow: 'spec-kit' });
    const ordinary = selectSeedBaselineChecks(manifest);
    expect(ordinary.some((check) => check.id === 'tofu-init' && check.applicability.applicable &&
      check.applicability.command.args.join(' ') === 'init -backend=false')).toBe(true);
    expect(ordinary.find((check) => check.id === 'backend-tests')?.applicability).toMatchObject({
      command: { executable: 'npm', args: ['test'] }
    });
    const runner = new LocalRunner();
    let inspection = await inspectGovernanceTransition(root, { runner, now: clock() });
    await executeApplyNext({ inspection, runner, clock, reinspect: () => inspectGovernanceTransition(root, { runner, now: clock() }) });
    inspection = await inspectGovernanceTransition(root, { runner, now: clock() });
    const plan = await buildSavedTransitionPlan({ inspection, runner, now: clock() });
    expect(plan?.operations.some((operation) => operation.actionId === 'seed.tasks.project' && operation.mutationClass === 'write-seed-tasks')).toBe(true);
    const local = await buildSavedTransitionPlan({ inspection, runner, now: clock(), localRevalidation: true });
    expect(local?.operations.some((operation) => operation.actionId === 'seed.tasks.project')).toBe(false);
  });

  it('rejects approval/binding changes and hook failures before writing a saved transition plan', async () => {
    const { root, clock } = await fixture();
    const approved = await approval(root, clock);
    const before = await tree(root);
    const runner = new LocalRunner();
    const mismatch = await executeLocalRevalidation({
      approvedPreview: approved.preview,
      protectedInputs: { ...approved.protectedInputs, binding: canonicalSha256('other source inputs') }, runner, clock
    });
    expect(mismatch.status).toBe('blocked');
    expect(await tree(root)).toEqual(before);
    const inspection = await inspectGovernanceTransition(root, { runner, now: clock() });
    await expect(executeApplyNext({
      inspection, runner, clock, localRevalidation: true,
      reinspect: () => inspectGovernanceTransition(root, { runner, now: clock() }),
      assertProtectedInputs() {},
      assertReviewedPlan() { throw new Error('Changed planned operations require fresh approval.'); }
    })).rejects.toThrow('fresh approval');
    expect(await tree(root)).toEqual(before);
  });

  const failures: { label: string; result: Partial<CommandResult> }[] = [
    { label: 'failed', result: { status: 1, stderr: 'A current backend check failed.' } },
    { label: 'missing tool', result: { status: null, errorCode: 'ENOENT', errorMessage: 'npm is not available' } },
    { label: 'interrupted', result: { status: null, signal: 'SIGINT', aborted: true } },
    { label: 'aborted with a success-shaped exit', result: { status: 0, aborted: true } },
    { label: 'truncated', result: { status: 0, outputLimitExceeded: true } }
  ];
  it.each(failures)('retains v2 without baseline proof after a $label local check', async ({ result: failure }) => {
    const { root, clock, state } = await fixture();
    const approved = await approval(root, clock);
    const runner = new LocalRunner(async (command) => command.executable === 'npm' ? failure : undefined);
    const progress: LocalRevalidationProgress[] = [];
    const outcome = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock,
      onProgress: (event) => { progress.push(event); }
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-verified' });
    const loaded = await loadActivationState(root);
    expect(loaded?.state).toMatchObject({
      schemaVersion: 2, repository: { id: state.repository.id },
      phases: { 'seed-valid': { state: 'verified' }, 'seed-verified': { state: 'blocked', evidence: [] } }
    });
    expect((await readActivationEvidence(root)).map((record) => record.header.phaseId)).toEqual(['seed-valid']);
    expect(progress.at(-1)?.status).toBe('blocked');
    expect(progress.some((event) => event.status === 'complete')).toBe(false);
  });

  it('obtains a new remaining-work preview after failure and reuses only fresh v2 proof', async () => {
    const { root, clock, state } = await fixture();
    const approved = await approval(root, clock);
    const failed = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, clock,
      runner: new LocalRunner(async (command) => command.executable === 'npm' ? { status: 1 } : undefined)
    });
    expect(failed.status).toBe('blocked');
    const firstEvidence = await readActivationEvidence(root);
    const fresh = await approval(root, clock, true);
    expect(fresh.preview.phases.map((phase) => phase.phaseId)).toEqual(['seed-verified', 'seed-archived']);
    expect(fresh.preview.reusedPhases.map((phase) => phase.phaseId)).toEqual(['seed-valid']);
    const runner = new LocalRunner();
    const retried = await executeLocalRevalidation({
      approvedPreview: fresh.preview, protectedInputs: fresh.protectedInputs, runner, clock
    });
    expect(retried, JSON.stringify(retried)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    expect(retried.phaseResults[0]?.status).toBe('already-complete');
    expect((await loadActivationState(root))?.state.repository.id).toBe(state.repository.id);
    expect((await readActivationEvidence(root)).find((record) => record.header.phaseId === 'seed-valid')).toEqual(firstEvidence[0]);
    expect(runner.calls.filter(({ command }) => command.executable === 'openspec')).toHaveLength(2);
  });

  it('does not count running state as success and re-observes it under a fresh local preview', async () => {
    const { root, clock, state } = await fixture();
    state.phases['seed-valid'].state = 'running';
    await writeState(root, state);
    const before = await tree(root);
    const inspected = await inspectGovernanceTransition(root, { runner: new LocalRunner(), now: clock() });
    expect(inspected.readiness.phases['seed-valid'].state).toBe('running');
    expect(inspected.readiness.nextReadyPhase).toBeNull();
    expect(await tree(root)).toEqual(before);
    const approved = await approval(root, clock, true);
    expect(approved.preview.reusedPhases).toEqual([]);
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    expect(runner.calls.filter(({ command }) => command.executable === 'openspec')).toHaveLength(3);
    expect((await readActivationEvidence(root)).find((record) => record.header.phaseId === 'seed-valid')?.header.result).toBe('verified');
  });

  it('keeps an interrupted execution incomplete and retries it without treating its saved plan as proof', async () => {
    const { root, clock, state } = await fixture();
    const approved = await approval(root, clock);
    const interrupted = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, clock,
      runner: new LocalRunner(async () => { throw new Error('Process interrupted before any completed check.'); })
    });
    expect(interrupted).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-valid' });
    expect(await readReviewedTransitionPlans(root)).toHaveLength(1);
    expect(await readActivationEvidence(root)).toHaveLength(0);
    expect((await loadActivationState(root))?.state).toEqual(state);
    const fresh = await approval(root, clock, true);
    const result = await executeLocalRevalidation({
      approvedPreview: fresh.preview, protectedInputs: fresh.protectedInputs, clock, runner: new LocalRunner()
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    expect(await readReviewedTransitionPlans(root)).toHaveLength(4);
    expect(await readActivationEvidence(root)).toHaveLength(3);
  });

  it.each(['source', 'seed-checkbox', 'new-source'])('preserves unexpected %s edits and withholds stale proof', async (kind) => {
    const { root, clock } = await fixture();
    const approved = await approval(root, clock);
    const manifest = await loadManifest(root);
    const seedTasks = ['openspec', 'changes', 'archive', `2026-08-01-${generatedSeedChangeName(manifest)}`, 'tasks.md'];
    const parts = kind === 'seed-checkbox' ? seedTasks : ['backend', kind === 'source' ? 'package.json' : 'unexpected.ts'];
    const old = kind === 'new-source' ? '' : await readFile(path.join(root, ...parts), 'utf8');
    const changed = kind === 'seed-checkbox' ? old.replace('- [ ]', '- [x]') :
      kind === 'source' ? `${old}\n` : 'export const unexpected = true;\n';
    let changedOnce = false;
    const runner = new LocalRunner(async (command) => {
      if (command.executable === 'npm' && !changedOnce) {
        changedOnce = true;
        await writeProjectFile(root, parts, changed);
      }
    });
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, runner, clock,
      protectedInputs: { binding: approved.protectedInputs.binding, assertUnchanged() {} }
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: kind === 'seed-checkbox' ? 'seed-verified' : 'seed-valid' });
    expect(result.blockers.join(' ')).toContain(parts.join('/'));
    expect(result.blockers.join(' ')).toContain('preserved');
    expect(await readFile(path.join(root, ...parts), 'utf8')).toBe(changed);
    expect((await readActivationEvidence(root)).some((record) => record.header.phaseId === 'seed-verified')).toBe(false);
    expect(runner.calls.some(({ command }) => command.executable === 'tofu')).toBe(false);
    const repaired = await approval(root, clock, true);
    expect(repaired.preview.phases[0]?.phaseId).toBe(kind === 'seed-checkbox' ? 'seed-verified' : 'seed-valid');
  });

  it('blocks missing installed prerequisites rather than implicitly installing them or claiming inapplicability', async () => {
    const { root, clock } = await fixture({ installed: false });
    const approved = await approval(root, clock);
    const baseline = approved.preview.phases.find((phase) => phase.phaseId === 'seed-verified');
    expect(baseline?.blockers.join(' ')).toContain('.terraform');
    expect(baseline?.blockers.join(' ')).toContain('node_modules');
    expect(baseline?.commands.some(({ command }) => command.executable === 'tofu' && command.args[0] === 'validate')).toBe(true);
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-verified' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command.executable).toBe('openspec');
  });

  it('blocks legacy shared-state infrastructure without migrating, initializing, or marking it inapplicable', async () => {
    const { root, manifest, clock } = await fixture();
    const priorInfrastructure = await tree(path.join(root, 'infrastructure'));
    manifest.projectArtifacts = [
      ...manifest.projectArtifacts.filter((artifact) => artifact.category !== 'infrastructure'),
      ...retiredFlatRootInfrastructureIdentities.map((identity) => ({
        ...identity, pathParts: [...identity.pathParts], generatedBy: '0.10.0',
        generationHash: `sha256:${'a'.repeat(64)}`
      }))
    ];
    await writeProjectFile(root, ['liftoff.manifest.json'], JSON.stringify(manifest));
    const approved = await approval(root, clock);
    expect(approved.preview.phases.find((phase) => phase.phaseId === 'seed-verified')?.blockers.join(' ')).toContain('legacy-shared');
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-verified' });
    expect(result.blockers.join(' ')).toContain('migration-required');
    expect(await tree(path.join(root, 'infrastructure'))).toEqual(priorInfrastructure);
    expect(runner.calls.some(({ command }) => command.executable === 'tofu')).toBe(false);
  });

  it.each(['python', 'go', 'node'])('uses disclosed noninstalling %s recipes while preserving ordinary defaults', async (api) => {
    const { root, manifest, clock } = await fixture({ api, frontend: true });
    const approved = await approval(root, clock);
    const checks = approved.preview.phases.find((phase) => phase.phaseId === 'seed-verified')?.commands ?? [];
    const backend = checks.find((entry) => ['uv', 'go'].includes(entry.command.executable) ||
      entry.command.executable === 'npm' && entry.cwdPathParts.join('/') === 'backend');
    if (api === 'python') expect(backend).toMatchObject({
      command: { executable: 'uv', args: ['run', '--no-sync', '--offline', '--project', 'backend', 'python', '-m', 'pytest', '-q', 'backend/tests'] },
      env: { UV_PYTHON_DOWNLOADS: 'never' }
    });
    if (api === 'go') expect(backend).toMatchObject({
      command: { executable: 'go', args: ['test', '-mod=readonly', './...'] },
      env: { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOVCS: '*:off' }
    });
    const ordinary = selectSeedBaselineChecks(manifest).find((check) => check.id === 'backend-tests');
    expect(ordinary?.applicability.applicable && ordinary.applicability.command.args).not.toContain('--offline');
    expect(checks.find((entry) => entry.cwdPathParts.join('/') === 'frontend')).toMatchObject({
      command: { executable: 'npm', args: ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', 'run', 'build'] }
    });
    expect(checks.filter(({ command }) => command.executable === 'tofu').some(({ command }) => command.args[0] === 'init')).toBe(false);
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, clock, runner: new LocalRunner()
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete' });
  });

  it('uses the same noninstalling recipe for generated Python workers', async () => {
    const { root, clock } = await fixture({ pattern: 'workflow' });
    const approved = await approval(root, clock);
    const worker = approved.preview.phases.flatMap((phase) => phase.commands)
      .find((entry) => entry.cwdPathParts[0] === 'functions');
    expect(worker).toMatchObject({
      command: { executable: 'uv', args: ['run', '--no-sync', '--offline', '--project', '../../backend', '--directory', '.', 'python', '-m', 'pytest', '-q'] },
      cwdPathParts: ['functions', 'workflow-worker'], env: { UV_PYTHON_DOWNLOADS: 'never' }
    });
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, clock, runner: new LocalRunner()
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete' });
  });

  it('does not execute a recomputed malicious preview or an expanded command set', async () => {
    const { root, clock } = await fixture();
    const approved = await approval(root, clock);
    const first = approved.preview.phases[0];
    if (!first) throw new Error('Expected initial local phase.');
    const expanded: LocalRevalidationPreview = {
      ...approved.preview, phases: [{ ...first, commands: [
        ...first.commands, { command: { executable: 'npm', args: ['install'] }, cwdPathParts: ['backend'], env: {} }
      ] }, ...approved.preview.phases.slice(1)]
    };
    const { fingerprint: _fingerprint, ...semantic } = expanded;
    expanded.fingerprint = canonicalSha256(semantic);
    const before = await tree(root);
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({
      approvedPreview: expanded, protectedInputs: approved.protectedInputs, clock, runner
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.blockers.join(' ')).toContain('changed');
    expect(await tree(root)).toEqual(before);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects changed working directories and a different committed target before plan persistence', async () => {
    const { root, manifest, clock } = await fixture();
    const approved = await approval(root, clock);
    const first = approved.preview.phases[0];
    if (!first || !first.commands[0]) throw new Error('Expected initial validation command.');
    const altered = {
      ...approved.preview,
      phases: [{
        ...first,
        commands: [{ ...first.commands[0], cwdPathParts: ['backend'] }]
      }, ...approved.preview.phases.slice(1)]
    };
    const { fingerprint: _fingerprint, ...semantic } = altered;
    altered.fingerprint = canonicalSha256(semantic);
    const before = await tree(root);
    const runner = new LocalRunner();
    const changedDirectory = await executeLocalRevalidation({
      approvedPreview: altered, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(changedDirectory.status).toBe('blocked');
    expect(await tree(root)).toEqual(before);
    await writeProjectFile(root, ['liftoff.manifest.json'], JSON.stringify({ ...manifest, liftoffVersion: '0.11.9' }));
    const changedTarget = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(changedTarget).toMatchObject({ status: 'blocked' });
    expect(changedTarget.blockers.join(' ')).toContain('committed target');
    expect(runner.calls).toHaveLength(0);
    expect(await readReviewedTransitionPlans(root)).toHaveLength(0);
    expect((await loadManifest(root)).liftoffVersion).toBe('0.11.9');
  });

  it('requires already archived, nonempty, matching artifacts rather than historical success flags', async () => {
    const { root, manifest, state, clock } = await fixture();
    const change = generatedSeedChangeName(manifest);
    await writeProjectFile(root, ['openspec', 'changes', 'archive', `2026-08-01-${change}`, 'proposal.md'],
      '## Capabilities\n\n### New Capabilities\n\n- `different-capability`: unrelated historical declaration\n');
    state.phases['seed-valid'].state = 'verified';
    state.phases['seed-verified'].state = 'verified';
    state.phases['seed-archived'].state = 'verified';
    await writeState(root, state);
    const approved = await approval(root, clock, true);
    expect(approved.preview.reusedPhases).toEqual([]);
    expect(approved.preview.phases[0]?.blockers.join(' ')).toContain('must declare exactly');
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'blocked', nextIncompletePhase: 'seed-valid' });
    expect(await readActivationEvidence(root)).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('allows only the disclosed read-only Git metadata commands and never follows remote resource hints', async () => {
    const { root, clock } = await fixture();
    await mkdir(path.join(root, '.git'));
    const approved = await approval(root, clock);
    const metadata = new Map([
      ['rev-parse --show-toplevel', root],
      ['rev-parse --verify HEAD', 'a'.repeat(40)],
      ['symbolic-ref --quiet --short HEAD', 'develop'],
      ['remote', 'origin'],
      ['remote get-url --push --all origin', 'https://github.com/historical-owner/historical-repository.git']
    ]);
    const runner = new LocalRunner(async (command) => {
      if (command.executable !== 'git') return;
      const stdout = metadata.get(command.args.join(' '));
      if (stdout === undefined) throw new Error('Unexpected Git command.');
      return { stdout };
    });
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    const allowed = approved.preview.inspectionCommands.map(({ command }) => formatCommand(command));
    expect(runner.calls.filter(({ command }) => command.executable === 'git').every(({ command }) => allowed.includes(formatCommand(command)))).toBe(true);
    expect((await loadActivationState(root))?.state.remoteBinding).toBeUndefined();
  }, 60_000);

  it('blocks source edits during read-only metadata inspection before any validation command', async () => {
    const { root, clock } = await fixture();
    await mkdir(path.join(root, '.git'));
    await writeProjectFile(root, ['scripts', 'baseline.mjs'], 'export const approved = true;\n');
    const approved = await approval(root, clock);
    const metadata = new Map([
      ['rev-parse --show-toplevel', root],
      ['rev-parse --verify HEAD', 'a'.repeat(40)],
      ['symbolic-ref --quiet --short HEAD', 'develop'],
      ['remote', 'origin'],
      ['remote get-url --push --all origin', 'https://github.com/example/project.git']
    ]);
    let edited = false;
    const runner = new LocalRunner(async (command) => {
      if (command.executable !== 'git') throw new Error('Changed sources must not reach validation.');
      if (!edited) {
        edited = true;
        await writeProjectFile(root, ['scripts', 'baseline.mjs'], 'export const approved = false;\n');
      }
      return { stdout: metadata.get(command.args.join(' ')) ?? '' };
    });
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result.status).toBe('blocked');
    expect(result.blockers.join(' ')).toMatch(/Protected.*changed/i);
    expect(runner.calls.every(({ command }) => command.executable === 'git')).toBe(true);
    expect(await readActivationEvidence(root)).toEqual([]);
    expect(await readFile(path.join(root, 'scripts', 'baseline.mjs'), 'utf8')).toContain('false');
  });

  it('retains current successful proof when only final progress persistence fails', async () => {
    const { root, clock } = await fixture();
    const approved = await approval(root, clock);
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, clock, runner: new LocalRunner(),
      onProgress(event) {
        if (event.status === 'complete') throw new Error('Unable to persist final migration progress.');
      }
    });
    expect(result).toMatchObject({ status: 'blocked', phaseId: null, nextIncompletePhase: 'committed' });
    expect(result.blockers.join(' ')).toContain('persist final migration progress');
    expect(result.phaseResults.every((phase) => phase.status === 'verified')).toBe(true);
    expect(await readActivationEvidence(root)).toHaveLength(3);
  });

  it('does not let journal timestamps or immutable retained history invalidate phase inputs', async () => {
    const { root, manifest } = await fixture();
    const runner = new LocalRunner();
    const before = await readActivationInputSnapshot(root, manifest, runner);
    await writeProjectFile(root, ['governance', 'migration-state.json'], JSON.stringify({ recordedAt: '2026-09-08T12:00:01.000Z' }));
    await writeProjectFile(root, ['governance', 'history', 'retained', 'source.txt'], 'original historical bytes');
    const after = await readActivationInputSnapshot(root, manifest, runner);
    expect(after).toEqual(before);
    await writeProjectFile(root, ['governance', 'migration-state.json'], JSON.stringify({ recordedAt: '2026-09-08T12:00:02.000Z' }));
    expect(await readActivationInputSnapshot(root, manifest, runner)).toEqual(before);
  });

  it('keeps status, resume, and verify read-only and distinguishes local completion from full governance', async () => {
    const { root, clock } = await fixture();
    const approved = await approval(root, clock);
    const runner = new LocalRunner();
    const result = await executeLocalRevalidation({
      approvedPreview: approved.preview, protectedInputs: approved.protectedInputs, runner, clock
    });
    expect(result.status).toBe('complete');
    const before = await tree(root);
    const callsBefore = runner.calls.length;
    for (const command of ['status', 'resume', 'verify']) {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runCommand(parseArgs(['governance', command, '--json']), { cwd: root, stdout, stderr, runner });
      expect(code, stdout.text() + stderr.text()).toBe(0);
      const output: unknown = JSON.parse(stdout.text());
      if (!isRecord(output)) throw new Error('Expected read-only governance output.');
      expect(output.readOnly).toBe(true);
      if (command === 'verify') {
        expect(output.consistent).toBe(true);
        expect(output.complete).toBe(false);
      }
    }
    expect(await tree(root)).toEqual(before);
    expect(runner.calls.length).toBe(callsBefore);
  });
});
