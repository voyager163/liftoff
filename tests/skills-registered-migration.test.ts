import { mkdir, readFile, readdir, writeFile, lstat, unlink, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts } from '../src/templates.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { notStartedState } from '../src/application/repository-governance/inspection.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { prepareUpdateReview } from '../src/application/update/review-plan.js';
import { activationStateFilePathParts, loadActivationState } from '../src/governance-activation/activation-state.js';
import { migrationStateFilePathParts } from '../src/governance-activation/history-contracts.js';
import { activeActivationRecordsWithoutState } from '../src/governance-activation/migration-history.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { validateSupersessionRecord } from '../src/domain/governance/activation/validators.js';
import { canonicalJson, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { skillAliasHistoryPaths, validateSkillsExecutionIdentity } from '../src/domain/skills/identity.js';
import { createSkillsTransactionApprovalStore } from '../src/adapters/filesystem/update-previews.js';
import { prepareRegisteredSkillMigration, registeredMigrationState } from '../src/application/skills/registered-migration.js';
import { executeRegisteredSkillMigration } from '../src/application/skills/migration-execution.js';
import { recoverSkillDeliveryTransaction } from '../src/application/skills/execution.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { applyReviewedUpdateTransaction } from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { CaptureStream } from './helpers.js';
import { skillsFixture, terminalStreams } from './helpers/skills-fixture.js';

const aliasParts = ['.github', 'prompts', 'liftoff-repository-governance.prompt.md'];
const replacementParts = ['.github', 'prompts', 'liftoff-setup.prompt.md'];
const originalAlias = '# /liftoff-repository-governance\n\nPreviously managed setup alias.\n';
const controlStates = [
  { label: 'activation', parts: activationStateFilePathParts },
  { label: 'migration', parts: migrationStateFilePathParts }
];
const orphanRecords = [
  { label: 'plans', parts: ['governance', 'plans', 'orphan.json'] },
  { label: 'evidence', parts: ['governance', 'evidence', 'orphan.json'] },
  { label: 'approvals', parts: ['governance', 'approvals', 'orphan.json'] },
  { label: 'reconciliation', parts: ['governance', 'reconciliation', 'orphan.json'] },
  { label: 'credential policy', parts: ['governance', 'credentials', 'preflight-policy.json'] },
  { label: 'activation baseline', parts: ['governance', 'activation-baseline.json'] },
  { label: 'unrecognized supersession', parts: ['governance', 'supersessions', 'orphan.json'] }
];

describe('Direct registered skill retirement uses production planners and guarded effects', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fixture.cleanup(); });

  async function update(args: string[]) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['update', '--project', fixture.project, '--json', ...args]), {
      cwd: fixture.cwd, stdout, stderr, env: { LIFTOFF_TELEMETRY: '0' },
      updatePreview: { homedir: fixture.home, env: {}, repositoryRoot: fixture.project },
      terminal: { layout: 'plain', color: false },
      runner: { run: async () => { throw new Error('This fixture authorizes no project, Git, or provider commands.'); } }
    });
    return { code, report: JSON.parse(stdout.text()) };
  }

  async function currentProjectWithRetainedAlias() {
    const historical = JSON.parse(await readFile(new URL('./fixtures/manifest-v6-governed-released.json', import.meta.url), 'utf8'));
    historical.managedArtifacts.find((entry: { logicalName: string }) =>
      entry.logicalName === 'repository-governance-copilot-launcher').contentHash = `sha256:${sha256Hex(originalAlias)}`;
    const workload = historical.project.workload;
    const desired = buildProjectPlan({
      projectName: historical.project.name, projectType: workload.kind, apiStack: workload.apiStack,
      cloud: workload.cloud, region: workload.region, environments: workload.environments,
      includeFrontend: workload.frontend, agents: historical.project.agents, specWorkflow: historical.project.specWorkflow
    }, { requireProjectName: true });
    const config = buildArtifacts(desired).find((entry) => entry.pathParts.join('/') === 'liftoff.config.json')!;
    await writeFile(path.join(fixture.project, 'liftoff.config.json'), config.content);
    await writeFile(path.join(fixture.project, 'liftoff.manifest.json'), `${JSON.stringify(historical, null, 2)}\n`);
    await mkdir(path.join(fixture.project, '.git'));
    await mkdir(path.join(fixture.project, '.github', 'prompts'), { recursive: true });
    await writeFile(path.join(fixture.project, ...aliasParts), `${originalAlias}\nUser customization retained during normal update.\n`);
    const preview = await update(['--check']);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    const fingerprint = preview.report.plans.find((entry: { mode: string }) => entry.mode === 'normal').fingerprint;
    const applied = await update(['--approve-plan', fingerprint]);
    expect(applied.code, JSON.stringify({
      status: applied.report.status, reasonCode: applied.report.reasonCode, message: applied.report.message
    })).toBe(0);
    expect(applied.report.status).toBe('partial');
    const manifest = await loadManifest(fixture.project);
    expect(manifest.artifactVersion).toBe(8);
    expect(manifest.managedArtifacts.some((entry) => entry.logicalName === 'repository-governance-copilot-launcher')).toBe(true);
    await writeFile(path.join(fixture.project, ...aliasParts), originalAlias);
  }

  function planningDependencies() {
    return { storage: { homedir: fixture.home, env: {}, repositoryRoot: fixture.project }, now: fixture.dependencies.now };
  }

  async function prepared() {
    const result = await prepareRegisteredSkillMigration(fixture.project, { hosts: ['github-copilot'], skillIds: ['setup'] }, planningDependencies());
    expect(result.status, result.status === 'ready' ? '' : result.reason).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    return result.plan;
  }

  function approvalStore() {
    return createSkillsTransactionApprovalStore(fixture.project, 'project', planningDependencies().storage);
  }

  async function writeControlState(parts: readonly string[], content: string | Buffer) {
    const file = path.join(fixture.project, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { mode: 0o600 });
    return file;
  }

  async function interrupted(phase: 'after-retirement' | 'committed') {
    const sourceRoot = new URL('../src/', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { transformSync } from 'rolldown/utils';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (context.parentURL?.startsWith(${JSON.stringify(sourceRoot)}) && specifier.endsWith('.js')) {
            return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url.startsWith(${JSON.stringify(sourceRoot)}) && url.endsWith('.ts')) return {
            format: 'module', shortCircuit: true,
            source: transformSync(url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }).code
          };
          return nextLoad(url, context);
        }
      });
      const { prepareRegisteredSkillMigration } = await import(${JSON.stringify(new URL('../src/application/skills/registered-migration.ts', import.meta.url).href)});
      const { executeRegisteredSkillMigration } = await import(${JSON.stringify(new URL('../src/application/skills/migration-execution.ts', import.meta.url).href)});
      const { createSkillsTransactionApprovalStore } = await import(${JSON.stringify(new URL('../src/adapters/filesystem/update-previews.ts', import.meta.url).href)});
      const root = ${JSON.stringify(fixture.project)};
      const storage = { homedir: ${JSON.stringify(fixture.home)}, repositoryRoot: root, env: {} };
      const prepared = await prepareRegisteredSkillMigration(root, { hosts: ['github-copilot'], skillIds: ['setup'] }, { storage });
      if (prepared.status !== 'ready') throw new Error(prepared.reason);
      const result = await executeRegisteredSkillMigration(prepared.plan, { approvePlan: prepared.plan.fingerprint }, {
        approvalStore: createSkillsTransactionApprovalStore(root, 'project', storage),
        onCheckpoint: async checkpoint => {
          const stop = ${JSON.stringify(phase)} === 'committed' ? checkpoint.phase === 'committed' :
            checkpoint.phase === 'after-mutation' && prepared.plan.effects[checkpoint.index]?.type === 'delete';
          if (stop) {
            process.stdout.write(JSON.stringify({ fingerprint: prepared.plan.fingerprint, identity: prepared.plan.identity }) + '\\n');
            process.exit(73);
          }
        }
      });
      process.stderr.write(result.message);
      process.exitCode = 9;
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, env: { ...process.env, TMPDIR: fixture.root, LIFTOFF_TELEMETRY: '0' } });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(73);
    const result = JSON.parse(child.stdout.trim());
    const lock = await projectMutationLockPath(fixture.project);
    const owned = await lstat(lock);
    const bytes = await readFile(lock);
    expect(JSON.parse(bytes.toString('utf8')).pid).toBe(child.pid);
    expect((await lstat(lock)).ino).toBe(owned.ino);
    expect(await readFile(lock)).toEqual(bytes);
    // Only this stopped child and its exact isolated test lock are being released.
    await unlink(lock);
    return result as { fingerprint: string };
  }

  it('executes only registered source retirement, immutable history, and the exact manifest effect', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const sourceManifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    const native = path.join(fixture.project, ...replacementParts);
    const before = { bytes: await readFile(native), stat: await lstat(native) };
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, { approvalStore: approvalStore() });
    expect(result, result.message).toMatchObject({ outcome: 'applied', committed: true, verified: true, uncertain: false });
    expect(result.appliedCount).toBe(1);
    await expect(readFile(path.join(fixture.project, ...aliasParts))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(native)).toEqual(before.bytes);
    expect([(await lstat(native)).ino, (await lstat(native)).mtimeMs]).toEqual([before.stat.ino, before.stat.mtimeMs]);
    const history = skillAliasHistoryPaths(plan.identity);
    expect(await readFile(path.join(fixture.project, ...history.manifest))).toEqual(sourceManifest);
    expect(await readFile(path.join(fixture.project, ...history.sources[0].pathParts), 'utf8')).toBe(originalAlias);
    const manifest = await loadManifest(fixture.project);
    expect(manifest.managedArtifacts.some((entry) => entry.logicalName === 'repository-governance-copilot-launcher')).toBe(false);
    await expect(readFile(path.join(fixture.project, '.liftoff', 'skills-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses actual current activation state even when the real review needs no revalidation', async () => {
    await currentProjectWithRetainedAlias();
    const manifest = await loadManifest(fixture.project);
    const state = notStartedState(manifest);
    state.repository.id = `local:${randomUUID()}`;
    const statePath = path.join(fixture.project, ...activationStateFilePathParts);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, canonicalJson(state));
    expect((await loadActivationState(fixture.project))?.state).toEqual(state);
    const inspection = await inspectProjectUpdate(fixture.project, { storage: planningDependencies().storage });
    const review = await prepareUpdateReview(inspection, false, { now: fixture.dependencies.now() });
    expect(inspection.historyMigration.status).toBe('current');
    expect(review.summary.eligible).toBe(true);
    expect(review.needsRevalidation).toBe(false);
    expect(review.revalidation).toBeUndefined();
    const before = {
      manifest: await readFile(path.join(fixture.project, 'liftoff.manifest.json')),
      state: await readFile(statePath),
      privateFiles: await readdir(fixture.home, { recursive: true })
    };
    const result = await prepareRegisteredSkillMigration(fixture.project, {
      hosts: ['github-copilot'], skillIds: ['setup']
    }, planningDependencies());
    expect(result.status).toBe('owning-update-required');
    if (result.status !== 'ready') expect(result.reason).toMatch(/activation.*state/i);
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(before.manifest);
    expect(await readFile(statePath)).toEqual(before.state);
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
    expect(await readdir(fixture.home, { recursive: true })).toEqual(before.privateFiles);
  });

  it('binds exact activation and migration control-state absence into the skills plan and transaction', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const state = registeredMigrationState(plan);
    for (const parts of [activationStateFilePathParts, migrationStateFilePathParts]) {
      expect(plan.files).toContainEqual({ pathParts: [...parts], state: 'absent' });
      expect(state.preconditions).toContainEqual({ pathParts: [...parts] });
    }
  });

  it.each(controlStates)(
    'preserves existing $label state without parsing it into retirement permission', async ({ parts }) => {
      await currentProjectWithRetainedAlias();
      const bytes = Buffer.from([0xff, 0x00, 0x0a]);
      const file = await writeControlState(parts, bytes);
      const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
      const privateFiles = await readdir(fixture.home, { recursive: true });
      const result = await prepareRegisteredSkillMigration(fixture.project, {
        hosts: ['github-copilot'], skillIds: ['setup']
      }, planningDependencies());
      expect(result.status).toBe('owning-update-required');
      if (result.status !== 'ready') expect(result.reason).toContain(parts.join('/'));
      expect(await readFile(file)).toEqual(bytes);
      expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
      expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
      expect(await readdir(fixture.home, { recursive: true })).toEqual(privateFiles);
    }
  );

  it('does not convert a linked control-state observation into absence', async () => {
    await currentProjectWithRetainedAlias();
    const outside = path.join(fixture.root, 'external-state.json');
    await writeFile(outside, 'unowned external state');
    const file = path.join(fixture.project, ...activationStateFilePathParts);
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(outside, file);
    await expect(prepareRegisteredSkillMigration(fixture.project, {
      hosts: ['github-copilot'], skillIds: ['setup']
    }, planningDependencies())).rejects.toThrow(/link|alias/i);
    expect(await readFile(outside, 'utf8')).toBe('unowned external state');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('does not hide deferred agent intent behind an otherwise exact alias-only update', async () => {
    await currentProjectWithRetainedAlias();
    const file = path.join(fixture.project, 'liftoff.config.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...config, agents: ['github-copilot', 'codex'] }));
    const inspection = await inspectProjectUpdate(fixture.project, { storage: planningDependencies().storage });
    const review = await prepareUpdateReview(inspection, false, { now: fixture.dependencies.now() });
    expect(inspection.deferredAgentRepair).toMatchObject({ addAgents: ['codex'] });
    expect(review.summary.eligible).toBe(true);
    expect(review.writePlan.mutations).toHaveLength(2);
    const result = await prepareRegisteredSkillMigration(fixture.project, {
      hosts: ['github-copilot'], skillIds: ['setup']
    }, planningDependencies());
    expect(result.status).toBe('owning-update-required');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
    await expect(readFile(path.join(fixture.project, '.agents', 'skills', 'liftoff-setup', 'SKILL.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat an eligible review as permission to skip explicit reconciliation', async () => {
    await currentProjectWithRetainedAlias();
    const inspection = await inspectProjectUpdate(fixture.project, { storage: planningDependencies().storage });
    const pending = {
      ...inspection,
      reconciliation: { ...inspection.reconciliation, status: 'reconciliation-required' as const }
    };
    const review = await prepareUpdateReview(pending, false, { now: fixture.dependencies.now() });
    expect(review.summary.eligible).toBe(true);
    expect(review.writePlan.mutations).toHaveLength(2);
    vi.spyOn(await import('../src/application/update/inspection.js'), 'inspectProjectUpdate').mockResolvedValueOnce(pending);
    const result = await prepareRegisteredSkillMigration(fixture.project, {
      hosts: ['github-copilot'], skillIds: ['setup']
    }, planningDependencies());
    expect(result.status).toBe('owning-update-required');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it.each(controlStates)(
    'rechecks absent $label state before the first approved file effect', async ({ parts }) => {
      await currentProjectWithRetainedAlias();
      await mkdir(path.join(fixture.project, ...parts.slice(0, -1)), { recursive: true });
      const plan = await prepared();
      const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
      const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
        approvalStore: approvalStore(),
        onBeforeMutation: async (_mutation, index) => {
          if (index === 0) await writeControlState(parts, 'new unowned control state');
        }
      });
      expect(result).toMatchObject({ outcome: 'failed', committed: false, verified: false });
      expect(await readFile(path.join(fixture.project, ...parts), 'utf8')).toBe('new unowned control state');
      expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
      expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
    }
  );

  it.each(orphanRecords)(
    'rejects reader-detected $label orphan before the first mutation under the real lease', async ({ parts }) => {
      await currentProjectWithRetainedAlias();
      await mkdir(path.join(fixture.project, ...parts.slice(0, -1)), { recursive: true });
      expect(await activeActivationRecordsWithoutState(fixture.project)).toEqual([]);
      const plan = await prepared();
      const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
      const native = await readFile(path.join(fixture.project, ...replacementParts));
      const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
        approvalStore: approvalStore(),
        onBeforeMutation: async (_mutation, index) => {
          if (index !== 0) return;
          const lease = JSON.parse(await readFile(await projectMutationLockPath(fixture.project), 'utf8'));
          expect(lease.pid).toBe(process.pid);
          await writeControlState(parts, 'newer orphan record');
          expect(await activeActivationRecordsWithoutState(fixture.project)).toContainEqual(parts);
        }
      });
      expect(result).toMatchObject({ outcome: 'failed', committed: false, verified: false });
      expect(await readFile(path.join(fixture.project, ...parts), 'utf8')).toBe('newer orphan record');
      expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
      expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(native);
      expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
    }
  );

  it('routes pre-existing orphan records to owning update without changing them', async () => {
    await currentProjectWithRetainedAlias();
    const parts = ['governance', 'credentials', 'preflight-policy.json'];
    const orphan = await writeControlState(parts, 'unowned credential policy record');
    const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    const result = await prepareRegisteredSkillMigration(fixture.project, {
      hosts: ['github-copilot'], skillIds: ['setup']
    }, planningDependencies());
    expect(result.status).toBe('owning-update-required');
    if (result.status !== 'ready') expect(result.reason).toContain(parts.join('/'));
    expect(await readFile(orphan, 'utf8')).toBe('unowned credential policy record');
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('rejects an orphan introduced between private staging and the first rename', async () => {
    await currentProjectWithRetainedAlias();
    const parts = ['governance', 'plans', 'during-stage.json'];
    await mkdir(path.join(fixture.project, ...parts.slice(0, -1)), { recursive: true });
    const plan = await prepared();
    const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: approvalStore(),
      onCheckpoint: async ({ phase, index }) => {
        if (phase === 'staged' && index === 0) await writeControlState(parts, 'orphan during private staging');
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: false, verified: false });
    expect(await readFile(path.join(fixture.project, ...parts), 'utf8')).toBe('orphan during private staging');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
    await expect(readFile(path.join(fixture.project, ...skillAliasHistoryPaths(plan.identity).manifest)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves recognized current supersessions and unrelated governance content without granting authority', async () => {
    await currentProjectWithRetainedAlias();
    const supersession = validateSupersessionRecord({
      schemaVersion: currentActivationIdentity.supersessionSchemaVersion,
      identity: currentActivationIdentity,
      supersededChangeId: 'earlier-source',
      supersedingChangeId: 'current-source',
      reason: 'Fixture current-reader exception, not retirement approval',
      approvedAt: fixture.dependencies.now!().toISOString(),
      approver: 'fixture operator'
    });
    const bytes = canonicalJson(supersession);
    const record = await writeControlState(['governance', 'supersessions', 'current.json'], bytes);
    const unrelated = await writeControlState(['governance', 'project-notes.json'], 'unrelated project-owned notes');
    expect(await activeActivationRecordsWithoutState(fixture.project)).toEqual([]);
    const plan = await prepared();
    expect(await executeRegisteredSkillMigration(plan, {}, { approvalStore: approvalStore() }))
      .toMatchObject({ outcome: 'approval-required', committed: false });
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: approvalStore()
    });
    expect(result).toMatchObject({ outcome: 'applied', committed: true, verified: true, uncertain: false });
    expect(await readFile(record, 'utf8')).toBe(bytes);
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated project-owned notes');
  });

  it('retains committed history and journal when an orphan appears during committed readback', async () => {
    await currentProjectWithRetainedAlias();
    const parts = ['governance', 'reconciliation', 'after-commit.json'];
    await mkdir(path.join(fixture.project, ...parts.slice(0, -1)), { recursive: true });
    const plan = await prepared();
    const native = await readFile(path.join(fixture.project, ...replacementParts));
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: approvalStore(),
      onCheckpoint: async ({ phase }) => {
        if (phase === 'committed') await writeControlState(parts, 'newer orphan reconciliation');
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: true, verified: false, uncertain: true });
    const journal = path.join(fixture.project, '.liftoff', 'reviewed-skills-transaction.json');
    const journalBytes = await readFile(journal);
    expect(await recoverSkillDeliveryTransaction(fixture.project, 'project', plan.fingerprint, approvalStore()))
      .toMatchObject({ status: 'blocked', committed: true, verified: false, uncertain: true });
    expect(await readFile(journal)).toEqual(journalBytes);
    expect(await readFile(path.join(fixture.project, ...parts), 'utf8')).toBe('newer orphan reconciliation');
    expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(native);
    await unlink(path.join(fixture.project, ...parts));
    expect(await recoverSkillDeliveryTransaction(fixture.project, 'project', plan.fingerprint, approvalStore()))
      .toMatchObject({ status: 'committed', committed: true, verified: true, uncertain: false });
    await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['after-retirement', 'committed'] as const)(
    'blocks reader-detected orphans before recovery of a real stopped %s transaction', async (phase) => {
      await currentProjectWithRetainedAlias();
      const parts = ['governance', 'approvals', 'after-interruption.json'];
      await mkdir(path.join(fixture.project, ...parts.slice(0, -1)), { recursive: true });
      const stopped = await interrupted(phase);
      const orphan = await writeControlState(parts, 'newer orphan approval record');
      const journal = path.join(fixture.project, '.liftoff', 'reviewed-skills-transaction.json');
      const journalBytes = await readFile(journal);
      const native = await readFile(path.join(fixture.project, ...replacementParts));
      const blocked = await recoverSkillDeliveryTransaction(fixture.project, 'project', stopped.fingerprint, approvalStore());
      expect(blocked).toMatchObject({
        status: 'blocked', committed: phase === 'committed', verified: false, uncertain: true
      });
      expect(await readFile(journal)).toEqual(journalBytes);
      await expect(readFile(path.join(fixture.project, ...aliasParts))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(orphan, 'utf8')).toBe('newer orphan approval record');
      expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(native);
      await unlink(orphan);
      expect(await recoverSkillDeliveryTransaction(fixture.project, 'project', stopped.fingerprint, approvalStore()))
        .toMatchObject({
          status: phase === 'committed' ? 'committed' : 'rolled-back',
          committed: phase === 'committed', verified: true, uncertain: false
        });
      expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(native);
    }
  );

  it.each(controlStates)(
    'retains a committed journal until conflicting $label state is removed', async ({ parts }) => {
      await currentProjectWithRetainedAlias();
      await mkdir(path.join(fixture.project, ...parts.slice(0, -1)), { recursive: true });
      const plan = await prepared();
      const native = await readFile(path.join(fixture.project, ...replacementParts));
      const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
        approvalStore: approvalStore(),
        onCheckpoint: async ({ phase }) => {
          if (phase === 'committed') await writeControlState(parts, 'newer control state');
        }
      });
      expect(result).toMatchObject({ outcome: 'failed', committed: true, verified: false, uncertain: true });
      const journal = path.join(fixture.project, '.liftoff', 'reviewed-skills-transaction.json');
      const journalBytes = await readFile(journal);
      const blocked = await recoverSkillDeliveryTransaction(fixture.project, 'project', plan.fingerprint, approvalStore());
      expect(blocked).toMatchObject({ status: 'blocked', committed: true, verified: false, uncertain: true });
      expect(await readFile(journal)).toEqual(journalBytes);
      expect(await readFile(path.join(fixture.project, ...parts), 'utf8')).toBe('newer control state');
      expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(native);
      await unlink(path.join(fixture.project, ...parts));
      const recovered = await recoverSkillDeliveryTransaction(fixture.project, 'project', plan.fingerprint, approvalStore());
      expect(recovered).toMatchObject({ status: 'committed', committed: true, verified: true, uncertain: false });
      await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(native);
    }
  );

  it('blocks rollback before restoring any bytes when activation appears after a stopped retirement', async () => {
    await currentProjectWithRetainedAlias();
    await mkdir(path.join(fixture.project, ...activationStateFilePathParts.slice(0, -1)), { recursive: true });
    const stopped = await interrupted('after-retirement');
    const statePath = await writeControlState(activationStateFilePathParts, 'new activation after interruption');
    const journal = path.join(fixture.project, '.liftoff', 'reviewed-skills-transaction.json');
    const journalBytes = await readFile(journal);
    const blocked = await recoverSkillDeliveryTransaction(fixture.project, 'project', stopped.fingerprint, approvalStore());
    expect(blocked).toMatchObject({ status: 'blocked', committed: false, verified: false, uncertain: true });
    expect(await readFile(journal)).toEqual(journalBytes);
    await expect(readFile(path.join(fixture.project, ...aliasParts))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(statePath, 'utf8')).toBe('new activation after interruption');
    await unlink(statePath);
    expect(await recoverSkillDeliveryTransaction(fixture.project, 'project', stopped.fingerprint, approvalStore()))
      .toMatchObject({ status: 'rolled-back', committed: false, verified: true, uncertain: false });
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('rejects unrelated approval and stays read-only without explicit authority', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    const entries = await readdir(fixture.project, { recursive: true });
    const privateEntries = await readdir(fixture.home, { recursive: true });
    expect(await executeRegisteredSkillMigration(plan, {}, { approvalStore: approvalStore() }))
      .toMatchObject({ outcome: 'approval-required', committed: false });
    expect(await executeRegisteredSkillMigration(plan, { approvePlan: plan.updatePlanFingerprint }, { approvalStore: approvalStore() }))
      .toMatchObject({ outcome: 'blocked', committed: false });
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
    expect(await readdir(fixture.project, { recursive: true })).toEqual(entries);
    expect(await readdir(fixture.home, { recursive: true })).toEqual(privateEntries);
  });

  it.each(['expired', 'invalid'] as const)('rejects an %s review clock before migration effects', async (clockState) => {
    await currentProjectWithRetainedAlias();
    let now = new Date('2026-09-14T12:01:00.000Z');
    const result = await prepareRegisteredSkillMigration(fixture.project, {
      hosts: ['github-copilot'], skillIds: ['setup']
    }, { ...planningDependencies(), now: () => now });
    expect(result.status, result.status === 'ready' ? '' : result.reason).toBe('ready');
    if (result.status !== 'ready') return;
    now = clockState === 'expired' ? new Date(result.plan.expiresAt) : new Date(Number.NaN);
    await expect(executeRegisteredSkillMigration(result.plan, { approvePlan: result.plan.fingerprint }, {
      approvalStore: approvalStore()
    })).rejects.toThrow(/expired/);
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('rejects unregistered recipe scope and active-transport mutations at the real transaction boundary', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    expect(() => validateSkillsExecutionIdentity({ ...plan.identity, scope: 'user' })).toThrow();
    expect(() => validateSkillsExecutionIdentity({ ...plan.identity, retiredAliases: ['unregistered-alias'] })).toThrow();
    const state = registeredMigrationState(plan);
    const mutations = state.mutations.map((mutation) => mutation.type === 'delete'
      ? { type: 'write' as const, pathParts: [...replacementParts], content: 'forbidden transport replacement' }
      : mutation);
    const before = await readFile(path.join(fixture.project, ...replacementParts));
    await expect(applyReviewedUpdateTransaction(fixture.project, mutations, {
      transactionKind: 'skills', skillsIdentity: plan.identity,
      planFingerprint: plan.fingerprint, approvalStore: approvalStore(),
      skillsDirectories: plan.directories.map((directory) => directory.state === 'absent'
        ? { pathParts: [...directory.pathParts], state: 'absent' }
        : { pathParts: [...directory.pathParts], state: 'directory', device: directory.device!, inode: directory.inode!, mode: directory.mode! })
    })).rejects.toThrow(/never active native transports/);
    expect(await readFile(path.join(fixture.project, ...replacementParts))).toEqual(before);
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('supports the actual CLI plan -> exact approval -> unchanged repeat without touching active transports', async () => {
    await currentProjectWithRetainedAlias();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.home);
    const args = ['skills', 'migrate', '--project', fixture.project, '--host', 'copilot', '--skill', 'setup', '--json'];
    const invoke = async (extra: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runCli({ argv: [...args, ...extra], cwd: fixture.cwd, stdout, stderr, env: { LIFTOFF_TELEMETRY: '0' } });
      return { code, report: JSON.parse(stdout.text()) };
    };
    const preview = await invoke(['--check']);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    expect(preview.report.outcome).toBe('migration-planned');
    const applied = await invoke(['--approve-plan', preview.report.result.fingerprint]);
    expect(applied.code, JSON.stringify(applied.report)).toBe(0);
    expect(applied.report).toMatchObject({ outcome: 'migration-executed', result: { committed: true, verified: true } });
    const manifest = await lstat(path.join(fixture.project, 'liftoff.manifest.json'));
    const unchanged = await invoke([]);
    expect(unchanged).toMatchObject({ code: 0, report: { outcome: 'migration-not-required' } });
    expect((await lstat(path.join(fixture.project, 'liftoff.manifest.json'))).mtimeMs).toBe(manifest.mtimeMs);
    expect(await readdir(fixture.cwd)).toEqual([]);
  });

  it('shows the exact effects before a genuine default-No decision and keeps decline write-free', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const streams = terminalStreams();
    const order: string[] = [];
    const result = await executeRegisteredSkillMigration(plan, {}, {
      approvalStore: approvalStore(),
      approvalContext: {
        stdin: streams.stdin, stderr: streams.stderr,
        approveUpdatePlan: async (prompt) => {
          order.push('prompt');
          expect(prompt.default).toBe(false);
          expect(prompt.message).toContain('will not be overwritten');
          expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
          return false;
        }
      },
      presentMigrationPlan: async (shown) => {
        order.push('plan');
        expect(shown.fingerprint).toBe(plan.fingerprint);
        expect(shown.effects.some((effect) => effect.pathParts.join('/') === replacementParts.join('/'))).toBe(false);
      }
    });
    expect(result).toMatchObject({ outcome: 'declined', committed: false });
    expect(order).toEqual(['plan', 'prompt']);
    await expect(readFile(path.join(fixture.project, ...skillAliasHistoryPaths(plan.identity).record))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never incorporates broader update effects or modified native replacements', async () => {
    await currentProjectWithRetainedAlias();
    await writeFile(path.join(fixture.project, ...replacementParts), 'modified active setup transport');
    const blocked = await prepareRegisteredSkillMigration(fixture.project, { hosts: ['github-copilot'], skillIds: ['setup'] }, planningDependencies());
    expect(blocked.status).toBe('owning-update-required');
    expect(await readFile(path.join(fixture.project, ...replacementParts), 'utf8')).toBe('modified active setup transport');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('requires owning update when another managed control needs a write', async () => {
    await currentProjectWithRetainedAlias();
    const guide = path.join(fixture.project, '.liftoff', 'governance', 'README.md');
    await unlink(guide);
    const blocked = await prepareRegisteredSkillMigration(fixture.project, { hosts: ['github-copilot'], skillIds: ['setup'] }, planningDependencies());
    expect(blocked.status).toBe('owning-update-required');
    if (blocked.status !== 'ready') expect(blocked.reason).toContain('outside these exact alias retirements');
    await expect(readFile(guide)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('refuses an occupied history target without overwriting it or retiring sources', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const record = path.join(fixture.project, ...skillAliasHistoryPaths(plan.identity).record);
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, 'unowned history');
    await expect(executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, { approvalStore: approvalStore() }))
      .rejects.toThrow(/changed after review/);
    expect(await readFile(record, 'utf8')).toBe('unowned history');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
  });

  it('preserves newer alias bytes during interrupted rollback and reports exact recovery scope', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: approvalStore(),
      onCheckpoint: async ({ phase, index }) => {
        if (phase === 'after-mutation' && index !== undefined && plan.effects[index].type === 'delete') {
          await writeFile(path.join(fixture.project, ...aliasParts), 'newer user alias bytes');
          throw new Error('stop after concurrent source replacement');
        }
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: false, uncertain: true });
    expect(result.recovery.status).toBe('blocked');
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe('newer user alias bytes');
    const recovery = await recoverSkillDeliveryTransaction(fixture.project, 'project', plan.fingerprint, approvalStore());
    expect(recovery.uncertain).toBe(true);
    expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe('newer user alias bytes');
  });

  it.each(['after-retirement', 'committed'] as const)('recovers a real stopped process at %s using the registered identity', async (phase) => {
    await currentProjectWithRetainedAlias();
    const native = path.join(fixture.project, ...replacementParts);
    const nativeBytes = await readFile(native);
    const nativeStat = await lstat(native);
    const manifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    const stopped = await interrupted(phase);
    let recovery;
    if (phase === 'committed') {
      vi.spyOn(os, 'homedir').mockReturnValue(fixture.home);
      const stdout = new CaptureStream();
      const code = await runCli({
        argv: ['skills', 'migrate', '--project', fixture.project, '--host', 'copilot', '--skill', 'setup', '--approve-plan', stopped.fingerprint, '--json'],
        cwd: fixture.cwd, stdout, stderr: new CaptureStream(), env: { LIFTOFF_TELEMETRY: '0' }
      });
      expect(code, stdout.text()).toBe(0);
      const report = JSON.parse(stdout.text());
      expect(report.outcome).toBe('recovered');
      recovery = report.result;
    } else {
      recovery = await recoverSkillDeliveryTransaction(fixture.project, 'project', stopped.fingerprint, approvalStore());
    }
    expect(recovery, JSON.stringify(recovery)).toMatchObject({
      status: phase === 'committed' ? 'committed' : 'rolled-back',
      committed: phase === 'committed', verified: true, uncertain: false
    });
    expect(await readFile(native)).toEqual(nativeBytes);
    expect((await lstat(native)).ino).toBe(nativeStat.ino);
    if (phase === 'after-retirement') {
      expect(await readFile(path.join(fixture.project, ...aliasParts), 'utf8')).toBe(originalAlias);
      expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifest);
    } else {
      await expect(readFile(path.join(fixture.project, ...aliasParts))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('blocks coherent-looking rewritten history before journal cleanup and preserves newer bytes', async () => {
    await currentProjectWithRetainedAlias();
    const plan = await prepared();
    const history = skillAliasHistoryPaths(plan.identity);
    const recordPath = path.join(fixture.project, ...history.record);
    const sourcePath = path.join(fixture.project, ...history.sources[0].pathParts);
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: approvalStore(),
      onCheckpoint: async ({ phase }) => {
        if (phase !== 'committed') return;
        const changed = 'concurrently changed preserved source';
        const record = JSON.parse(await readFile(recordPath, 'utf8'));
        record.sources[0].hash = sha256Hex(changed);
        await writeFile(sourcePath, changed);
        await writeFile(recordPath, canonicalJson(record));
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: true, verified: false, uncertain: true });
    expect(result.recovery.status).toBe('blocked');
    expect(await readFile(sourcePath, 'utf8')).toBe('concurrently changed preserved source');
    expect(await readFile(path.join(fixture.project, '.liftoff', 'reviewed-skills-transaction.json'), 'utf8')).toContain('registered-project-skill-alias-retirement');
  });

  it('retains committed recovery material when loadManifest rejects changed original provenance', async () => {
    await currentProjectWithRetainedAlias();
    const manifest = await loadManifest(fixture.project);
    if (manifest.artifactVersion !== 8 || manifest.provenance.kind !== 'generated' ||
        manifest.provenance.origin.kind !== 'historical-manifest') {
      throw new Error('The fixture must retain real historical-generated provenance.');
    }
    const originalHistory = path.join(fixture.project, ...manifest.provenance.origin.historyPathParts);
    const plan = await prepared();
    const result = await executeRegisteredSkillMigration(plan, { approvePlan: plan.fingerprint }, {
      approvalStore: approvalStore(),
      onCheckpoint: async ({ phase }) => {
        if (phase === 'committed') await writeFile(originalHistory, 'newer original-history bytes');
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: true, verified: false, uncertain: true });
    const journal = path.join(fixture.project, '.liftoff', 'reviewed-skills-transaction.json');
    const journalBytes = await readFile(journal);
    const recovery = await recoverSkillDeliveryTransaction(fixture.project, 'project', plan.fingerprint, approvalStore());
    expect(recovery).toMatchObject({ status: 'committed', committed: true, verified: false, uncertain: true });
    expect(recovery.rollbackFailures).toEqual([]);
    expect(recovery.cleanupFailures.length).toBeGreaterThan(0);
    expect(await readFile(journal)).toEqual(journalBytes);
    expect(await readFile(originalHistory, 'utf8')).toBe('newer original-history bytes');
  });
});
