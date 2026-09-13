import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import * as updateStorage from '../src/adapters/filesystem/update-previews.js';
import { formatUpdateCommand } from '../src/application/update/command-guidance.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { inspectCurrentActivationEvidence } from '../src/governance-activation/read-only.js';
import * as migrationHistory from '../src/governance-activation/migration-history.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import * as live from '../src/governance-assessment/live.js';
import { inspectAssessmentProject } from '../src/governance-assessment/project.js';
import { AssessmentFiles } from '../src/governance-assessment/readers.js';
import type { CommandRunner } from '../src/process-runner.js';
import { historicalFixtureIdentity, writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const now = () => new Date('2026-09-09T00:00:00.000Z');

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(maintainedCoreCompatibilitySchema?: 2 | 3) {
  const root = path.resolve('tests', `.assessment-history-${process.pid}-${randomUUID()}`);
  roots.push(root);
  const projectRoot = path.join(root, "project with spaces 'quoted'");
  const home = path.join(root, 'home');
  const state = path.join(root, 'user-state');
  const localAppData = path.join(root, 'local-app-data');
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, XDG_STATE_HOME: state, LOCALAPPDATA: localAppData
  })) vi.stubEnv(key, value);
  for (const directory of [
    path.join(home, '.local', 'state', 'liftoff', 'update-previews'),
    path.join(home, 'Library', 'Application Support', 'liftoff', 'update-previews'),
    path.join(localAppData, 'liftoff', 'update-previews'),
    path.join(state, 'liftoff', 'update-previews')
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'existing-receipt.json'), '{"untouched":"receipt"}\n');
    await writeFile(path.join(directory, 'existing-approval.json'), '{"untouched":"approval"}\n');
  }
  const historical = await writeHistoricalV1Fixture(projectRoot, { maintainedCoreCompatibilitySchema });
  const stores = [
    vi.spyOn(updateStorage, 'createUpdateTransactionApprovalStore'),
    vi.spyOn(updateStorage, 'issueUpdatePreviewReceipt'),
    vi.spyOn(updateStorage, 'loadUpdatePreviewReceipt'),
    vi.spyOn(updateStorage, 'consumeUpdatePreviewReceipt')
  ];
  for (const store of stores) store.mockImplementation(() => {
    throw new Error('Assessment must not access update receipt or approval stores.');
  });
  const runner = {
    run: vi.fn<CommandRunner['run']>(async (command) => {
      throw new Error(`Assessment must not run external commands for this fixture: ${command.executable}`);
    })
  };
  return { root, projectRoot, historical, stores, runner };
}

async function snapshot(root: string) {
  const entries = new Map<string, { kind: string; mode: number; bytes?: string }>();
  async function visit(parts: string[]) {
    for (const entry of await readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, entry.name];
      const file = path.join(root, ...next);
      const mode = (await lstat(file)).mode;
      entries.set(next.join('/'), entry.isFile()
        ? { kind: 'file', mode, bytes: (await readFile(file)).toString('hex') }
        : { kind: entry.isDirectory() ? 'directory' : 'other', mode });
      if (entry.isDirectory()) await visit(next);
    }
  }
  await visit([]);
  return entries;
}

function noAuthority(f: Awaited<ReturnType<typeof fixture>>) {
  for (const store of f.stores) expect(store).not.toHaveBeenCalled();
  expect(f.runner.run).not.toHaveBeenCalled();
}

describe('historical activation assessment eligibility', () => {
  it.each([undefined, 2, 3] as const)(
    'diagnoses the authentic v1 inventory with maintained core schema %s without current or provider authority',
    async (maintainedSchema) => {
      const f = await fixture(maintainedSchema);
      const before = await snapshot(f.root);
      const project = await inspectAssessmentProject(new AssessmentFiles(f.projectRoot));
      expect(project).toMatchObject({
        manifest: { governance: { activationIdentity: historicalFixtureIdentity } },
        identity: { availability: 'unsupported', stateSource: 'unsupported' },
        state: null, stateIdentity: null, evidence: [], approvals: [], plans: []
      });
      await expect(inspectCurrentActivationEvidence(f.projectRoot, project.manifest!, { runner: f.runner }))
        .rejects.toThrow(/diagnostic-only/);
      const collector = vi.spyOn(live, 'collectLiveAssessment');
      const reports = [
        await assessGovernance(f.projectRoot, { runner: f.runner, now }),
        await assessGovernance(f.projectRoot, { live: true, runner: f.runner, now })
      ];
      for (const report of reports) {
        expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
          schemaVersion: 1, readOnly: true, outcome: 'partial', exitCode: 2,
          projectIdentity: {
            availability: 'unsupported', stateSource: 'unsupported',
            cliVersion: maintainedSchema ? '0.11.1' : '0.10.0',
            recordedActivationIdentity: historicalFixtureIdentity
          },
          target: { activationIdentity: currentActivationIdentity },
          snapshot: { repository: null, inputsStable: true }
        });
        const eligibility = report.diagnostics.find((entry) => entry.code === 'activation-migration-eligible');
        expect(eligibility?.message).toContain('complete historical inventory');
        expect(eligibility?.message).toContain(historicalFixtureIdentity.phaseGraphHash);
        expect(eligibility?.message).toContain(currentActivationIdentity.phaseGraphHash);
        expect(eligibility?.message).toContain(formatUpdateCommand(f.projectRoot, 'check'));
        expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'activation-history-diagnostic-only' }));
        expect(report.diagnostics.some((entry) =>
          ['unsupported-activation', 'unsupported-approval', 'activation-migration-blocked'].includes(entry.code)
        )).toBe(false);
        expect(report.findings.find((entry) => entry.controlId === 'evidence.governance')?.classification).toBe('not-observed');
        expect(report.findings.some((entry) =>
          entry.controlId === 'identity.managed-core' && entry.observations.recorded?.availability === 'observed'
        )).toBe(true);
        expect(JSON.stringify(report)).not.toContain(f.historical.state.repository.id);
        expect(JSON.stringify(report)).not.toContain(f.historical.approvals[0].id);
      }
      expect(collector).toHaveBeenCalledWith(expect.objectContaining({
        repository: null, refs: [], runner: null, azure: []
      }), expect.any(Object));
      expect(await snapshot(f.root)).toEqual(before);
      noAuthority(f);
    }
  );

  it.each([
    ['missing-evidence', 'missing-historical-record'],
    ['missing-state', 'missing-historical-record'],
    ['missing-plan', 'missing-historical-record'],
    ['missing-approval', 'missing-historical-record'],
    ['malformed-evidence', 'malformed-history-json'],
    ['malformed-approval', 'malformed-history-json'],
    ['mixed-evidence', 'unsupported-historical-identity'],
    ['future-state', 'unsupported-historical-identity'],
    ['unsafe-state-reference', 'unsafe-history-path']
  ])('reports the actual %s blocker without changing project or user-state bytes', async (scenario, reasonCode) => {
    const f = await fixture(3);
    const evidence = f.historical.records[0];
    const approval = f.historical.approvals[0];
    const statePath = path.join(f.projectRoot, 'governance', 'activation-state.json');
    const evidencePath = path.join(f.projectRoot, 'governance', 'evidence', `${evidence.evidenceId}.json`);
    const approvalPath = path.join(f.projectRoot, 'governance', 'approvals', `${approval.id}.json`);
    let detail = 'governance/activation-state.json';
    if (scenario === 'missing-state') await rm(statePath);
    else if (scenario === 'missing-plan') {
      const plan = [...f.historical.files.keys()].find((name) => name.startsWith('governance/plans/seed-valid-'))!;
      await rm(path.join(f.projectRoot, ...plan.split('/')));
      detail = 'required reviewed historical transition plan';
    } else if (scenario.endsWith('approval')) {
      if (scenario === 'missing-approval') await rm(approvalPath);
      else await writeFile(approvalPath, '{');
      detail = approval.id;
    } else if (scenario === 'future-state') {
      await writeFile(statePath, JSON.stringify({ ...f.historical.state, schemaVersion: 99 }));
    } else if (scenario === 'unsafe-state-reference') {
      const changed = structuredClone(f.historical.state);
      changed.phases['seed-valid'].evidence[0].evidenceId = '../outside';
      await writeFile(statePath, JSON.stringify(changed));
    } else {
      if (scenario === 'missing-evidence') await rm(evidencePath);
      else if (scenario === 'malformed-evidence') await writeFile(evidencePath, '{');
      else await writeFile(evidencePath, JSON.stringify({
        ...evidence, header: { ...evidence.header, identity: currentActivationIdentity }
      }));
      detail = evidence.evidenceId;
    }
    const before = await snapshot(f.root);
    const report = await assessGovernance(f.projectRoot, { live: true, runner: f.runner, now });
    expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
      outcome: 'partial', projectIdentity: { availability: 'unsupported', stateSource: 'unsupported' },
      snapshot: { repository: null, inputsStable: true }
    });
    const blocker = report.diagnostics.find((entry) => entry.code === 'activation-migration-blocked');
    expect(blocker?.message).toContain(reasonCode);
    expect(blocker?.message).toContain(detail);
    expect(blocker?.message).toContain(formatUpdateCommand(f.projectRoot, 'check'));
    expect(report.diagnostics.some((entry) => entry.code === 'activation-migration-eligible')).toBe(false);
    expect(report.findings.find((entry) => entry.controlId === 'evidence.governance')?.classification).toBe('not-observed');
    expect(await snapshot(f.root)).toEqual(before);
    noAuthority(f);
  });

  it('includes only planner-validated unreferenced records in diagnostic eligibility', async () => {
    const f = await fixture();
    await writeFile(path.join(f.projectRoot, 'governance', 'evidence', 'prior-recognized-attempt.json'), JSON.stringify({
      ...f.historical.records[0], evidenceId: 'prior-recognized-attempt'
    }));
    const before = await snapshot(f.root);
    const report = await assessGovernance(f.projectRoot, { runner: f.runner, now });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'activation-migration-eligible' }));
    expect(await snapshot(f.root)).toEqual(before);
    noAuthority(f);
  });

  it('preserves an explicitly selected project in human and JSON eligibility remedies', async () => {
    const f = await fixture();
    const before = await snapshot(f.root);
    const human = new CaptureStream();
    const json = new CaptureStream();
    for (const [flags, stdout] of [[[], human], [['--json'], json]] as const) {
      expect(await runCommand(parseArgs(['governance', 'assess', '--project', f.projectRoot, ...flags]), {
        cwd: f.root, stdout, stderr: new CaptureStream(), runner: f.runner
      })).toBe(2);
    }
    const report = JSON.parse(json.text());
    const eligibility = report.diagnostics.find((entry: { code: string }) => entry.code === 'activation-migration-eligible');
    expect(human.text()).toContain(eligibility.message);
    expect(human.text()).toContain('diagnostic-only');
    expect(human.text()).toContain(formatUpdateCommand(f.projectRoot, 'check'));
    expect(eligibility.message).not.toContain('--json');
    expect(await snapshot(f.root)).toEqual(before);
    noAuthority(f);
  });

  it('withholds eligibility if immutable historical inputs change during collection', async () => {
    const f = await fixture();
    const removed = `governance/evidence/${f.historical.records[0].evidenceId}.json`;
    const expected = await snapshot(f.root);
    expected.delete(`${path.relative(f.root, f.projectRoot).split(path.sep).join('/')}/${removed}`);
    vi.spyOn(live, 'collectLiveAssessment').mockImplementation(async () => {
      await rm(path.join(f.projectRoot, ...removed.split('/')));
      return { observations: {}, diagnostics: [], refsStable: true };
    });
    const report = await assessGovernance(f.projectRoot, { live: true, runner: f.runner, now });
    expect(report.snapshot.inputsStable).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'activation-history-changed' }));
    expect(report.diagnostics.find((entry) => entry.code === 'activation-history-changed')?.message)
      .toContain(formatUpdateCommand(f.projectRoot, 'check'));
    expect(report.diagnostics.some((entry) => entry.code === 'activation-migration-eligible')).toBe(false);
    expect(await snapshot(f.root)).toEqual(expected);
    noAuthority(f);
  });

  it('surfaces an unexpected history reinspection failure instead of claiming an input change', async () => {
    const f = await fixture();
    const before = await snapshot(f.root);
    const inspect = migrationHistory.planActivationHistoryMigration;
    vi.spyOn(migrationHistory, 'planActivationHistoryMigration')
      .mockImplementationOnce(inspect)
      .mockRejectedValueOnce(new Error('Historical inventory could not be read.'));
    const report = await assessGovernance(f.projectRoot, { runner: f.runner, now });
    expect(report).toMatchObject({
      outcome: 'error', exitCode: 1, snapshot: { inputsStable: false }
    });
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: 'assessment-error', message: 'Historical inventory could not be read.'
      })
    ]);
    expect(await snapshot(f.root)).toEqual(before);
    noAuthority(f);
  });

  it.each(['future-identity', 'unknown-format', 'mixed-identity'])(
    'preserves %s manifests without claiming a supported historical lane',
    async (scenario) => {
      const f = await fixture();
      const manifest = structuredClone(f.historical.manifest);
      const changed = scenario === 'unknown-format' ? { ...manifest, artifactVersion: 99 }
        : {
          ...manifest, governance: {
            ...manifest.governance,
            activationIdentity: {
              ...manifest.governance.activationIdentity,
              ...(scenario === 'future-identity' ? { liftoffVersion: '99.0.0' } : { evidenceHeaderSchemaVersion: 2 })
            }
          }
        };
      await writeFile(path.join(f.projectRoot, 'liftoff.manifest.json'), JSON.stringify(changed));
      const before = await snapshot(f.root);
      const planner = vi.spyOn(migrationHistory, 'planActivationHistoryMigration');
      const report = await assessGovernance(f.projectRoot, { live: true, runner: f.runner, now });
      expect(report).toMatchObject({ outcome: 'error', exitCode: 1 });
      expect(report.diagnostics.some((entry) => entry.code.startsWith('activation-migration-'))).toBe(false);
      expect(planner).not.toHaveBeenCalled();
      expect(await snapshot(f.root)).toEqual(before);
      noAuthority(f);
    }
  );
});
