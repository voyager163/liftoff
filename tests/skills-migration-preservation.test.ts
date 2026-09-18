import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { inspectLegacyIntegrations, planSkillMigration, executeSkillMigration } from '../src/application/skills/migration.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts, buildManifest } from '../src/templates.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { governanceAgentIntegrations } from '../src/domain/project/catalog.js';
import { sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { CaptureStream } from './helpers.js';
import { skillsFixture } from './helpers/skills-fixture.js';

describe('Project skill transport migration preserves registered and unowned identities', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { await fixture.cleanup(); });
  const oldPath = '.github/prompts/liftoff-setup.prompt.md';

  async function generatedProject(olderManagedRepair = false): Promise<void> {
    const plan = buildProjectPlan({
      projectName: 'Skills migration fixture', projectType: 'standard', apiStack: 'go', cloud: 'azure',
      includeFrontend: false, agents: ['github-copilot']
    }, { requireProjectName: true });
    const artifacts = buildArtifacts(plan);
    if (olderManagedRepair) {
      const repair = artifacts.find((artifact) => artifact.logicalName === governanceAgentIntegrations['github-copilot'].repair.logicalName)!;
      repair.content += '\nPrevious managed instruction revision.\n';
      const manifest = artifacts.find((artifact) => artifact.logicalName === 'manifest')!;
      manifest.content = `${JSON.stringify(buildManifest(plan, artifacts.filter((artifact) => artifact.logicalName !== 'manifest')), null, 2)}\n`;
    }
    for (const artifact of artifacts) {
      const file = path.join(fixture.project, ...artifact.pathParts);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, artifact.content);
    }
  }

  async function update(args: string[]) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['update', '--project', fixture.project, '--json', ...args]), {
      cwd: fixture.cwd, stdout, stderr, env: { LIFTOFF_TELEMETRY_DISABLED: '1' },
      terminal: { layout: 'plain', color: false },
      updatePreview: { homedir: fixture.home, env: {}, repositoryRoot: fixture.project },
      runner: { run: async () => { throw new Error('Native integration maintenance must not execute project, Git, or provider commands.'); } }
    });
    return { code, report: JSON.parse(stdout.text()), stderr: stderr.text() };
  }

  it('does not treat a familiar legacy filename or file presence as managed ownership', async () => {
    const file = path.join(fixture.project, oldPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'An unowned custom setup prompt.');
    const inspected = await inspectLegacyIntegrations(fixture.project);
    const entry = inspected.find((candidate) => candidate.relativeDestination === oldPath)!;
    expect(entry).toMatchObject({
      exists: true, ownership: 'unowned', logicalName: 'liftoff-setup-copilot', invocation: '/liftoff-setup'
    });
    const plan = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    expect(plan.summary.eligible).toBe(0);
    expect(plan.items[0].reason).toContain('Source is unowned');
    const execution = await executeSkillMigration(plan, { approvePlan: plan.fingerprint });
    expect(execution).toMatchObject({ outcome: 'blocked', committed: false, migratedCount: 0 });
    expect(await readFile(file, 'utf8')).toBe('An unowned custom setup prompt.');
    await expect(readdir(path.join(fixture.project, '.liftoff'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recognizes current retained native transports without inventing a migration target', async () => {
    await generatedProject();
    const file = path.join(fixture.project, oldPath);
    const manifest = path.join(fixture.project, 'liftoff.manifest.json');
    const beforeFile = await readFile(file);
    const beforeManifest = await readFile(manifest);
    const plan = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    expect(plan.items.find((item) => item.oldPath === oldPath)?.ownership).toBe('managed');
    expect(plan.execution).toBe('not-required');
    expect(plan.items.every((item) => item.action === 'retain' && item.transport === 'retained')).toBe(true);
    for (const item of plan.items) {
      expect(item.maintenancePath).toBe(item.oldPath);
      expect(item.maintenanceLogicalId).toBe(item.oldLogicalId);
      expect(item).not.toHaveProperty('proposedPath');
    }
    expect(await executeSkillMigration(plan, { approvePlan: plan.fingerprint })).toMatchObject({
      outcome: 'not-required', committed: false, migratedCount: 0
    });
    expect(await readFile(file)).toEqual(beforeFile);
    expect(await readFile(manifest)).toEqual(beforeManifest);
    expect(await readdir(fixture.home)).toEqual([]);
  });

  it('binds source/destination bytes and modes, preserving customized sources, collisions, and provenance', async () => {
    await generatedProject();
    const originalManifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    const before = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    const old = path.join(fixture.project, oldPath);
    const destination = path.join(fixture.project, '.github', 'skills', 'liftoff-setup', 'SKILL.md');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'Unknown successor occupant.');
    await writeFile(old, 'User-modified old prompt.');
    const after = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.items.find((item) => item.oldPath === oldPath)?.ownership).toBe('modified');
    await expect(executeSkillMigration(before, { approvePlan: before.fingerprint })).rejects.toThrow(/observations changed/);
    expect(after.items.find((item) => item.oldPath === oldPath)?.standaloneDiscoveryPath)
      .toBe('.github/skills/liftoff-setup/SKILL.md');
    expect(await readFile(destination, 'utf8')).toBe('Unknown successor occupant.');
    expect(await readFile(old, 'utf8')).toBe('User-modified old prompt.');
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(originalManifest);
  });

  it.each([false, true])('executes separately approved same-path native maintenance through the real update command (older bytes: %s)', async (olderManagedRepair) => {
    await generatedProject(olderManagedRepair);
    await mkdir(path.join(fixture.project, '.git'));
    const native = governanceAgentIntegrations['github-copilot'].repair;
    const repairPath = path.join(fixture.project, ...native.pathParts);
    if (!olderManagedRepair) await unlink(repairPath);
    const backend = path.join(fixture.project, 'backend', 'custom-business.go');
    await writeFile(backend, 'package main\n// preserved business extension\n');
    const source = await loadManifest(fixture.project);
    const setupBytes = await readFile(path.join(fixture.project, oldPath));
    const initialManifest = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));

    const inspection = await executeSkillsUseCase({
      subcommand: 'migrate', project: fixture.project, hosts: ['github-copilot'], skillId: 'repair'
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(inspection.outcome).toBe('migration-not-required');
    expect(inspection.exitCode).toBe(2);
    if (inspection.outcome !== 'migration-not-required') return;
    expect(inspection.result.summary).toMatchObject({ eligible: 0, maintenance: 1, blocked: 0 });
    const continuation = inspection.result.nextActions[0];
    expect(continuation).toMatchObject({
      executable: 'liftoff', args: ['update', '--check', '--project', fixture.project, '--json'],
      project: fixture.project, cwd: fixture.project, capability: 'update', commandResultSchema: 3,
      authority: 'separate-reviewed-update'
    });
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(initialManifest);
    expect(await readdir(fixture.home)).toEqual([]);

    const preview = await update(['--check']);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    expect(preview.report.schemaVersion).toBe(3);
    const approved = preview.report.plans.find((entry: { mode: string }) => entry.mode === 'normal').fingerprint;
    const applied = await update(['--approve-plan', approved]);
    expect(applied.code, JSON.stringify(applied.report)).toBe(0);
    const maintained = await loadManifest(fixture.project);
    expect(maintained.managedArtifacts.find((entry) => entry.logicalName === native.logicalName)?.pathParts).toEqual(native.pathParts);
    expect(maintained.projectArtifacts).toEqual(source.projectArtifacts);
    if (source.artifactVersion === 8 && maintained.artifactVersion === 8) expect(maintained.provenance).toEqual(source.provenance);
    expect(await readFile(path.join(fixture.project, oldPath))).toEqual(setupBytes);
    expect(await readFile(backend, 'utf8')).toBe('package main\n// preserved business extension\n');
    expect(await readFile(repairPath, 'utf8')).not.toContain('Previous managed instruction revision.');
    await expect(readdir(path.join(fixture.project, '.github', 'skills', 'liftoff-repair'))).rejects.toMatchObject({ code: 'ENOENT' });
    const beforeNoop = await lstat(repairPath);
    const manifestBeforeNoop = await readFile(path.join(fixture.project, 'liftoff.manifest.json'));
    expect((await update([])).code).toBe(0);
    expect((await lstat(repairPath)).mtimeMs).toBe(beforeNoop.mtimeMs);
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(manifestBeforeNoop);
  });

  it('does not treat a matching standalone projection as a registered successor or deletion permission', async () => {
    await generatedProject();
    const standalone = path.join(fixture.project, '.github', 'skills', 'liftoff-setup', 'SKILL.md');
    await mkdir(path.dirname(standalone), { recursive: true });
    const original = await readFile(path.join(fixture.project, oldPath));
    await writeFile(standalone, original);
    const plan = await planSkillMigration(fixture.project, { hosts: ['github-copilot'], skillIds: ['setup'] });
    expect(plan.execution).toBe('blocked');
    expect(plan.items[0].reason).toContain('not a registered successor');
    expect((await executeSkillMigration(plan, { approvePlan: plan.fingerprint })).ok).toBe(false);
    expect(await readFile(standalone)).toEqual(original);
    expect(await readFile(path.join(fixture.project, oldPath))).toEqual(original);
  });

  it('blocks pending transactions and rejects forged or stale transport observations', async () => {
    await generatedProject();
    const plan = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    await expect(executeSkillMigration(structuredClone(plan), { approvePlan: plan.fingerprint })).rejects.toThrow(/current planner/);
    await expect(executeSkillMigration(plan, { approvePlan: '0'.repeat(64) })).rejects.toThrow(/fingerprint does not match/);
    const journal = path.join(fixture.project, '.liftoff', 'reviewed-update-transaction.json');
    await writeFile(journal, 'preserved pending evidence', { mode: 0o600 });
    const blocked = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    expect(blocked.execution).toBe('blocked');
    expect(blocked.blockers.join('\n')).toContain('original registered recovery');
    expect(await readFile(journal, 'utf8')).toBe('preserved pending evidence');
  });

  it.each([false, true])('executes the registered legacy transition through update with preserved history (source present: %s)', async (sourcePresent) => {
    const historicalBytes = await readFile(new URL('./fixtures/manifest-v6-governed-released.json', import.meta.url));
    const historical = JSON.parse(historicalBytes.toString('utf8'));
    let sourceBytes = historicalBytes;
    const alias = historical.managedArtifacts.find((artifact: { logicalName: string }) =>
      artifact.logicalName === 'repository-governance-copilot-launcher');
    const aliasPath = path.join(fixture.project, ...alias.pathParts);
    if (sourcePresent) {
      const content = '# /liftoff-repository-governance\n\nPrevious managed setup instructions.\n';
      alias.contentHash = `sha256:${sha256Hex(content)}`;
      sourceBytes = Buffer.from(`${JSON.stringify(historical, null, 2)}\n`);
      await mkdir(path.dirname(aliasPath), { recursive: true });
      await writeFile(aliasPath, content);
    }
    const workload = historical.project.workload;
    const desired = buildProjectPlan({
      projectName: historical.project.name, projectType: workload.kind, apiStack: workload.apiStack,
      cloud: workload.cloud, region: workload.region, environments: workload.environments,
      includeFrontend: workload.frontend, agents: historical.project.agents,
      specWorkflow: historical.project.specWorkflow, governanceProfile: historical.governance.profile
    }, { requireProjectName: true });
    const config = buildArtifacts(desired).find((artifact) => artifact.pathParts.join('/') === 'liftoff.config.json')!;
    await writeFile(path.join(fixture.project, 'liftoff.config.json'), config.content);
    await writeFile(path.join(fixture.project, 'liftoff.manifest.json'), sourceBytes);
    await mkdir(path.join(fixture.project, '.git'));
    const custom = path.join(fixture.project, 'business.txt');
    await writeFile(custom, 'existing application remains project-owned\n');

    const inspection = await planSkillMigration(fixture.project, { hosts: ['github-copilot'], skillIds: ['setup'] });
    expect(inspection.execution).toBe('owning-update-required');
    expect(inspection.registeredTransitions).toEqual([
      expect.objectContaining({
        sourceLogicalId: 'repository-governance-copilot-launcher',
        sourcePath: '.github/prompts/liftoff-repository-governance.prompt.md',
        sourceState: sourcePresent ? 'unchanged' : 'absent', targetLogicalId: 'liftoff-setup-copilot',
        targetPath: '.github/prompts/liftoff-setup.prompt.md', owner: 'update', status: 'review-update'
      })
    ]);
    expect(await executeSkillMigration(inspection, { approvePlan: inspection.fingerprint }))
      .toMatchObject({ outcome: 'owning-update-required', committed: false, migratedCount: 0 });
    const routed = await executeSkillsUseCase({
      subcommand: 'migrate', project: fixture.project, hosts: ['github-copilot'], skillId: 'setup', check: true
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(routed).toMatchObject({ outcome: 'migration-update-required', exitCode: 2, ok: false });
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(sourceBytes);

    const preview = await update(['--check']);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    const fingerprint = preview.report.plans.find((entry: { mode: string }) => entry.mode === 'normal').fingerprint;
    const wrongAuthority = await update(['--approve-plan', inspection.fingerprint]);
    expect(wrongAuthority.code, JSON.stringify(wrongAuthority.report)).toBe(1);
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(sourceBytes);
    const applied = await update(['--approve-plan', fingerprint]);
    expect(applied.code, JSON.stringify(applied.report)).toBe(0);
    const maintained = await loadManifest(fixture.project);
    expect(maintained.managedArtifacts.some((artifact) => artifact.logicalName === 'repository-governance-copilot-launcher')).toBe(false);
    expect(maintained.managedArtifacts.find((artifact) => artifact.logicalName === 'liftoff-setup-copilot')?.pathParts)
      .toEqual(['.github', 'prompts', 'liftoff-setup.prompt.md']);
    expect(maintained.artifactVersion).toBe(8);
    if (maintained.artifactVersion !== 8 || maintained.provenance.kind !== 'generated' ||
        maintained.provenance.origin.kind !== 'historical-manifest') throw new Error('Expected truthful preserved manifest origin.');
    expect(await readFile(path.join(fixture.project, ...maintained.provenance.origin.historyPathParts))).toEqual(sourceBytes);
    expect(await readFile(custom, 'utf8')).toBe('existing application remains project-owned\n');
    await expect(readFile(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(fixture.project, '.github', 'skills', 'liftoff-setup'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a modified historically registered alias instead of giving retirement authority to its filename', async () => {
    const source = await readFile(new URL('./fixtures/manifest-v6-governed-released.json', import.meta.url));
    await writeFile(path.join(fixture.project, 'liftoff.manifest.json'), source);
    const alias = path.join(fixture.project, '.github', 'prompts', 'liftoff-repository-governance.prompt.md');
    await mkdir(path.dirname(alias), { recursive: true });
    await writeFile(alias, 'user-modified historical integration');
    const plan = await planSkillMigration(fixture.project, { hosts: ['github-copilot'], skillIds: ['setup'] });
    expect(plan.execution).toBe('blocked');
    expect(plan.registeredTransitions[0]).toMatchObject({ sourceState: 'modified', status: 'blocked' });
    expect((await executeSkillMigration(plan, { approvePlan: plan.fingerprint })).outcome).toBe('blocked');
    expect(await readFile(alias, 'utf8')).toBe('user-modified historical integration');
    expect(await readFile(path.join(fixture.project, 'liftoff.manifest.json'))).toEqual(source);
  });

  it('does not acquire ownership of an unrecorded retired alias beside current native integrations', async () => {
    await generatedProject();
    const alias = path.join(fixture.project, '.github', 'prompts', 'liftoff-repository-governance.prompt.md');
    await writeFile(alias, 'unowned custom legacy command');
    const plan = await planSkillMigration(fixture.project, { hosts: ['github-copilot'] });
    expect(plan.execution).toBe('not-required');
    expect(plan.registeredTransitions).toEqual([]);
    await executeSkillMigration(plan);
    expect(await readFile(alias, 'utf8')).toBe('unowned custom legacy command');
  });

  it('blocks implicit project transport replacement during normal install and keeps old invocation identity', async () => {
    const file = path.join(fixture.project, oldPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'Custom setup invocation.');
    const result = await executeSkillsUseCase({
      subcommand: 'install', project: fixture.project, hosts: ['github-copilot'], skillId: 'setup', check: true
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result.outcome).toBe('blocked-plan');
    if (result.outcome === 'blocked-plan') expect(result.result.actions[0].reason).toContain('registered identity');
    expect(await readFile(file, 'utf8')).toBe('Custom setup invocation.');
  });

  it('does not convert an unsafe linked legacy observation into absence', async () => {
    const source = path.join(fixture.cwd, 'custom.md');
    await writeFile(source, 'Outside content.');
    const old = path.join(fixture.project, oldPath);
    await mkdir(path.dirname(old), { recursive: true });
    await symlink(source, old);
    await expect(inspectLegacyIntegrations(fixture.project)).rejects.toThrow(/symlink|junction/);
    expect(await readFile(source, 'utf8')).toBe('Outside content.');
  });

  it('keeps catalog/inspection read-only and does not revive retired integration aliases', async () => {
    const result = await executeSkillsUseCase({
      subcommand: 'inspect', project: fixture.project, hosts: ['github-copilot']
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result.ok).toBe(true);
    for (const entry of await inspectLegacyIntegrations(fixture.project)) {
      expect(entry.logicalName).not.toContain('repository-governance');
      expect(entry.invocation).not.toBe('/liftoff-repository-governance');
    }
    expect(await readdir(fixture.project)).toEqual([]);
    expect(await readdir(fixture.home)).toEqual([]);
  });
});
