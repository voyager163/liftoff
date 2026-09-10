import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { createUpdatePreviewDescriptor } from '../src/application/update/preview.js';
import { executeLocalRevalidation, previewLocalRevalidation, type LocalRevalidationProgress } from '../src/application/update/revalidation.js';
import { issueUpdatePreviewReceipt } from '../src/adapters/filesystem/update-previews.js';
import { writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import { commandShellForPlatform, formatShellCommand } from '../src/adapters/process/shell-command.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import type { LiftoffManifest } from '../src/domain/project/contracts.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { governanceDoctorChecks } from '../src/governance-activation/doctor.js';
import {
  migrationRevalidationPhaseIds, migrationStateFilePathParts, rawHistoryDigest,
  validateMigrationJournal, type MigrationRevalidationStatus
} from '../src/governance-activation/history-contracts.js';
import {
  finalizeActivationHistoryMigration, inspectActivationMigrationHistory, planActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { readActivationEvidence } from '../src/governance-activation/read-only.js';
import { formatCommand, type CommandRunner } from '../src/process-runner.js';
import { buildArtifacts } from '../src/templates.js';
import { liftoffVersion } from '../src/version.js';
import { writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { writeIndependentInfrastructureFixture } from './governance-activation-fixtures.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const subcommands = ['status', 'resume', 'verify'] as const;
const journalOnlyBlocker = 'Local revalidation progress is unavailable; repair the journal write prerequisite before retrying.';
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bytes(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function visit(parts: string[]): Promise<void> {
    for (const entry of await readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isDirectory()) await visit(child);
      else result.set(child.join('/'), await readFile(path.join(root, ...child)));
    }
  }
  await visit([]);
  return result;
}

function jsonReport(text: string): Record<string, unknown> {
  const result: unknown = JSON.parse(text);
  if (!isRecord(result)) throw new Error('Expected a governance inspection report.');
  return result;
}

async function linkedFixture(status: MigrationRevalidationStatus) {
  const base = path.resolve('.cache', `migration-inspection-${process.pid}-${randomUUID()}`);
  roots.push(base);
  const root = path.join(base, 'project with spaces');
  const userState = path.join(base, 'user-state');
  await writeHistoricalV1Fixture(root);
  await writeIndependentInfrastructureFixture(root);
  const project = buildProjectPlan({
    projectName: 'Flight Log', projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'],
    specWorkflow: 'openspec', agents: ['copilot'], includeFrontend: false
  }, { requireProjectName: true });
  for (const marker of [...project.framework.baseMarkers, ...project.framework.agentMarkers['github-copilot']]) {
    await writeProjectFile(root, marker, 'Official local initialization fixture\n');
  }
  await mkdir(path.join(root, 'backend', 'node_modules'), { recursive: true });
  for (const environment of ['dev', 'staging', 'prod']) {
    await mkdir(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', environment, '.terraform'), { recursive: true });
  }
  const migration = await planActivationHistoryMigration(root);
  if (migration.status !== 'eligible') throw new Error(`Expected frozen v1 eligibility: ${JSON.stringify(migration)}`);
  const sourceBytes = await bytes(root);
  const core = buildArtifacts(project).filter((artifact) => artifact.lifecycle === 'managed-core');
  const targetManifest: LiftoffManifest = {
    ...migration.inventory.manifest,
    liftoffVersion,
    governance: {
      profile: 'single-maintainer-gitflow', policyVersion: '6', state: 'handoff-generated',
      activationIdentity: currentActivationIdentity
    },
    managedArtifacts: core.map((artifact) => ({
      logicalName: artifact.logicalName, category: artifact.category, pathParts: [...artifact.pathParts],
      contentHash: `sha256:${rawHistoryDigest(Buffer.from(artifact.content))}`
    }))
  };
  let ticks = 0;
  const startedAt = Date.now() - 60_000;
  const clock = () => new Date(startedAt + ticks++);
  const updatePreview = {
    homedir: userState, env: { XDG_STATE_HOME: userState, LOCALAPPDATA: userState },
    repositoryRoot: root, clock
  };
  const descriptor = createUpdatePreviewDescriptor({
    projectRoot: root, cliVersion: liftoffVersion, mode: 'normal',
    source: migration.semanticPlan.preconditions, target: targetManifest, operations: migration.semanticPlan
  });
  const receipt = await issueUpdatePreviewReceipt(root, [descriptor], updatePreview);
  const finalized = finalizeActivationHistoryMigration(migration, descriptor.fingerprint, clock());
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
  let journal = finalized.journal;
  async function recordProgress(progress: LocalRevalidationProgress): Promise<void> {
    const activePhase = progress.phaseId ?? (progress.status === 'blocked' ? 'seed-valid' : null);
    journal = validateMigrationJournal({
      ...journal,
      revalidation: {
        status: progress.status, updatedAt: clock().toISOString(),
        nextAction: progress.status === 'complete' ? null : 'Repair the named local prerequisite and review the remaining work.',
        phases: journal.revalidation.phases.map((phase) => {
          const result = progress.phaseResults.find((entry) => entry.phaseId === phase.phaseId);
          if (result) return {
            phaseId: phase.phaseId, status: result.status === 'blocked' ? 'blocked' : 'complete',
            evidenceIds: result.evidence ? [result.evidence.evidenceId] : [], blockers: result.blockers
          };
          if (phase.phaseId === activePhase) return {
            phaseId: phase.phaseId, status: progress.status,
            evidenceIds: [], blockers: progress.blockers
          };
          return phase;
        })
      }
    });
    await writeProjectFile(root, [...migrationStateFilePathParts], JSON.stringify(journal));
  }
  if (status === 'running') {
    await recordProgress({
      status: 'running', phaseId: 'seed-valid', phaseResults: [],
      nextIncompletePhase: 'seed-valid', blockers: []
    });
  } else if (status === 'blocked' || status === 'complete') {
    const binding = canonicalSha256('Reviewed local fixture inputs');
    const preview = await previewLocalRevalidation({ projectRoot: root, targetManifest, protectedInputBinding: binding });
    const approvedCommands = new Set(preview.phases.flatMap((phase) =>
      phase.commands.map((entry) => formatCommand(entry.command))
    ));
    const runner: CommandRunner = {
      async run(command) {
        if (!approvedCommands.has(formatCommand(command)) || ['az', 'gh', 'curl'].includes(command.executable) ||
          command.args.some((arg) => ['install', 'init', 'archive', 'commit', 'push', 'apply'].includes(arg))) {
          throw new Error(`Unexpected local validation operation: ${formatCommand(command)}`);
        }
        return { command, displayCommand: formatCommand(command), status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      }
    };
    const result = await executeLocalRevalidation({
      approvedPreview: preview,
      protectedInputs: {
        binding,
        assertUnchanged() {
          if (status === 'blocked') throw new Error(journalOnlyBlocker);
        }
      },
      runner, clock, onProgress: recordProgress
    });
    expect(result, JSON.stringify(result)).toMatchObject({ status });
  }
  expect(await inspectActivationMigrationHistory(root)).toMatchObject({ status: 'committed', journal });
  for (const file of migration.index.files) {
    expect(await readFile(path.join(root, ...file.copyPathParts))).toEqual(sourceBytes.get(file.originalPathParts.join('/')));
  }
  expect(journal.sourceIdentity).toMatchObject({
    liftoffVersion: '0.10.0', activationContractVersion: 1,
    activationStateSchemaVersion: 1, evidenceHeaderSchemaVersion: 1, approvalEnvelopeSchemaVersion: 1
  });
  expect(journal.targetIdentity).toEqual(currentActivationIdentity);
  const inspectionRunner = { run: vi.fn<CommandRunner['run']>(async () => {
    throw new Error('Read-only inspection must not execute validation commands or contact a provider.');
  }) };
  async function inspect(command: typeof subcommands[number], json: boolean) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const code = await runCommand(parseArgs(['governance', command, '--project', root, ...(json ? ['--json'] : [])]), {
      cwd: base, stdout, stderr, runner: inspectionRunner, updatePreview,
      terminal: { layout: 'plain', color: false }
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }
  return { root, userState, journal, receipt, inspect, inspectionRunner };
}

describe('linked migration inspection', {
  timeout: process.platform === 'win32' ? 90_000 : 30_000
}, () => {
  it.each(['pending', 'running', 'blocked', 'complete'] as const)(
    'reports %s journal progress consistently without changing project or external receipt bytes',
    async (status) => {
      const fixture = await linkedFixture(status);
      const { root, userState, journal, inspect, inspectionRunner } = fixture;
      const projectBefore = await bytes(root);
      const receiptsBefore = await bytes(userState);
      expect(receiptsBefore.size).toBeGreaterThan(0);
      const state = (await loadActivationState(root))!.state;
      expect(state.repository.id).toBe(journal.successor.repositoryId);
      expect(state.remoteBinding).toBeUndefined();
      expect(state.applicability).toMatchObject({ privateStagingDast: 'unknown', credentialRequired: 'unknown' });
      expect(state.phases.committed).toMatchObject({ state: 'pending', evidence: [], approvals: [] });
      if (status === 'blocked') {
        expect(state.phases['seed-valid']).toMatchObject({ state: 'pending', evidence: [], blockers: [] });
        expect(await readActivationEvidence(root)).toEqual([]);
      }
      const checkCommand = formatShellCommand({
        executable: 'liftoff', args: ['update', '--check', '--project', root]
      }, commandShellForPlatform(process.platform));
      let sharedSummary: unknown;
      for (const command of subcommands) {
        const structured = await inspect(command, true);
        expect(structured.code, structured.stdout + structured.stderr).toBe(0);
        expect(structured.stderr).toBe('');
        const report = jsonReport(structured.stdout);
        expect(report).toMatchObject({ schemaVersion: 1, command: `governance ${command}`, readOnly: true, migration: journal });
        expect(report.migrationSummary).toMatchObject({
          localCommit: journal.transaction,
          snapshot: {
            id: journal.snapshotId, indexPathParts: journal.historyIndexPathParts,
            indexDigest: journal.historyIndexDigest, linkage: 'validated', successor: journal.successor
          },
          revalidation: journal.revalidation,
          nextRecordedPhase: status === 'complete' ? null : 'seed-valid',
          currentProofRequired: true,
          remedy: status === 'complete' ? null : expect.stringContaining(checkCommand)
        });
        if (sharedSummary === undefined) sharedSummary = report.migrationSummary;
        else expect(report.migrationSummary).toEqual(sharedSummary);
        if (command === 'verify') {
          expect(report).toMatchObject({ consistent: true, complete: false, setupStatus: 'in-progress' });
        } else {
          expect(report.approvals).toEqual([]);
          expect(report.remoteBinding).toBeNull();
          expect(report.nextReadyPhase).toBe(status === 'complete' ? null : 'seed-valid');
          expect(report.phases).toEqual(expect.arrayContaining(migrationRevalidationPhaseIds.map((id) => expect.objectContaining({
            id, storedState: status === 'complete' ? 'verified' : 'pending',
            evidence: expect.objectContaining({ freshness: expect.objectContaining({ status: status === 'complete' ? 'fresh' : 'missing' }) })
          }))));
        }
        const human = await inspect(command, false);
        expect(human.code, human.stdout + human.stderr).toBe(0);
        expect(human.stderr).toBe('');
        expect(human.stdout).toContain('Migration progress (journal)');
        expect(human.stdout).toContain(`Local migration: committed at ${journal.transaction.committedAt}`);
        expect(human.stdout).toContain(journal.snapshotId);
        expect(human.stdout).toContain(journal.historyIndexPathParts.join('/'));
        expect(human.stdout).toContain(journal.historyIndexDigest);
        expect(human.stdout).toContain(`validated; successor ${journal.successor.repositoryId}`);
        expect(human.stdout).toContain(`Recorded revalidation: ${status}`);
        expect(human.stdout).toContain('not current proof, governance completion, approval, or provider authority');
        for (const phase of journal.revalidation.phases) {
          expect(human.stdout).toContain(`Phase: ${phase.phaseId} | Progress: ${phase.status}`);
          for (const blocker of phase.blockers) expect(human.stdout).toContain(blocker);
        }
        if (journal.revalidation.nextAction) expect(human.stdout).toContain(journal.revalidation.nextAction);
        if (status !== 'complete') {
          expect(human.stdout).toContain(checkCommand);
          expect(human.stdout).toContain('fresh preview');
          expect(human.stdout).toContain('explicitly approve the exact remaining local plan');
        }
      }
      const doctor = await governanceDoctorChecks(root, await loadManifest(root));
      expect(doctor.find((check) => check.id === 'governance-migration-progress')).toMatchObject({
        state: status === 'complete' ? 'migration-committed' : 'revalidation-blocked',
        severity: status === 'complete' ? 'ok' : 'fail'
      });
      expect(doctor.some((check) => check.id === 'governance-identity-incompatible')).toBe(false);
      const assessment = await assessGovernance(root, { runner: inspectionRunner });
      expect(assessment).toMatchObject({
        readOnly: true, mode: 'local', projectIdentity: { availability: 'known', stateSource: 'user' },
        snapshot: { inputsStable: true }
      });
      expect(assessment.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
        code: status === 'complete' ? 'activation-migration-committed' : 'activation-revalidation-blocked'
      })]));
      expect(assessment.diagnostics.some((entry) => entry.code === 'activation-history-diagnostic-only')).toBe(false);
      expect(assessment.coverage.unobserved).toBeGreaterThan(0);
      expect(inspectionRunner.run).not.toHaveBeenCalled();
      expect(await bytes(root)).toEqual(projectBefore);
      expect(await bytes(userState)).toEqual(receiptsBefore);
    }
  );

  it('does not promote a complete journal to current proof after local inputs change', async () => {
    const { root, userState, journal, inspect, inspectionRunner } = await linkedFixture('complete');
    await writeProjectFile(root, ['backend', 'src', 'index.ts'], '// User-owned changes require fresh local proof.\n');
    const projectBefore = await bytes(root);
    const receiptsBefore = await bytes(userState);
    for (const command of subcommands) {
      const structured = await inspect(command, true);
      expect(structured.code, structured.stdout + structured.stderr).toBe(command === 'verify' ? 1 : 0);
      const report = jsonReport(structured.stdout);
      expect(report).toMatchObject({
        migration: journal,
        migrationSummary: {
          revalidation: { status: 'complete' }, nextRecordedPhase: null, currentProofRequired: true,
          remedy: expect.stringContaining('fresh preview')
        }
      });
      if (command === 'verify') {
        expect(report).toMatchObject({ consistent: false, complete: false, setupStatus: 'in-progress' });
        expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({
          id: 'evidence-freshness', status: 'failed'
        })]));
      } else {
        expect(report.phases).toEqual(expect.arrayContaining([expect.objectContaining({
          id: 'seed-valid', state: 'ready', storedState: 'verified',
          evidence: expect.objectContaining({ freshness: expect.objectContaining({ status: 'stale' }) })
        })]));
      }
      const human = await inspect(command, false);
      expect(human.code).toBe(structured.code);
      expect(human.stdout).toContain('Recorded revalidation: complete');
      expect(human.stdout).toContain('stale current proof');
      expect(human.stdout).toContain('explicitly approve the exact remaining local plan');
    }
    const doctor = await governanceDoctorChecks(root, await loadManifest(root));
    expect(doctor).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'governance-evidence-stale', severity: 'fail'
    })]));
    const assessment = await assessGovernance(root, { runner: inspectionRunner });
    expect(assessment.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-current-evidence' })]));
    expect(inspectionRunner.run).not.toHaveBeenCalled();
    expect(await bytes(root)).toEqual(projectBefore);
    expect(await bytes(userState)).toEqual(receiptsBefore);
  });

  it('refuses a damaged declared history link instead of displaying a validated migration', async () => {
    const { root, userState, inspect, inspectionRunner, journal } = await linkedFixture('pending');
    await writeProjectFile(root, [...journal.historyIndexPathParts], '{}\n');
    const projectBefore = await bytes(root);
    const receiptsBefore = await bytes(userState);
    for (const command of subcommands) {
      for (const json of [false, true]) {
        const result = await inspect(command, json);
        expect(result.code).toBe(1);
        expect(result.stdout + result.stderr).toContain('activationHistoryIndex');
        expect(result.stdout).not.toContain('Migration progress (journal)');
        expect(result.stdout).not.toContain('"linkage": "validated"');
        if (command === 'verify' && json) {
          expect(jsonReport(result.stdout)).toMatchObject({
            consistent: false, complete: false, setupStatus: 'indeterminate'
          });
        }
      }
    }
    expect(inspectionRunner.run).not.toHaveBeenCalled();
    expect(await bytes(root)).toEqual(projectBefore);
    expect(await bytes(userState)).toEqual(receiptsBefore);
  });
});
