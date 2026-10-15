import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { captureTreeState } from '../src/init-filesystem.js';
import {
  heartbeatInventoryPath, heartbeatWorkflowPath, parseHeartbeatInventory, qualifiedHeartbeatTooling,
  renderHeartbeatEntry, renderHeartbeatWorkflow, updateHeartbeatEntry, validateHeartbeatTooling,
  heartbeatReportingEntry, heartbeatWorkflowDigest, heartbeatWorkflowHasJobs, heartbeatWorkflowText, validateHeartbeatWorkflow,
  type HeartbeatInventory
} from '../src/domain/project/telemetry-heartbeat.js';
import { CaptureStream } from './helpers.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { applyHeartbeatPlan, buildHeartbeatEnablementPlan, heartbeatRemovalTarget, heartbeatReviewBindings } from '../src/application/telemetry/heartbeat-plan.js';
import { observeProjectTelemetry } from '../src/application/telemetry/project-reporting.js';
import { assertHeartbeatTargetsWritable, heartbeatReportProofAllows, readHeartbeatRepository, readQualifiedHeartbeatReportProof } from '../src/adapters/filesystem/telemetry-heartbeat.js';
import { telemetryReviewFingerprint } from '../src/domain/project/telemetry-consent.js';
import { getTelemetryConfigPath } from '../src/telemetry/config.js';
import * as telemetryFiles from '../src/adapters/filesystem/telemetry-consent.js';

const roots: string[] = [];
const firstId = '12345678-1234-4123-8123-123456789abc', secondId = '12345678-1234-4123-8123-123456789abd';
const manifest = buildCurrentArtifacts(buildCurrentProjectPlan({
  projectName: 'Heartbeat consent specimen', projectType: 'standard', apiStack: 'node',
  specWorkflow: 'manual', agents: [], governanceProfile: 'none', environments: ['dev']
}, { requireProjectName: true })).find(artifact => artifact.logicalName === 'manifest')!.content;

// This closed grammar specimen is deliberately unpublished and never supplies release qualification.
const specimen: HeartbeatInventory = {
  schemaVersion: 1, repository: 'specimen/repository',
  tooling: {
    cliVersion: '0.0.0',
    archiveUrl: 'https://github.com/voyager163/liftoff/releases/download/v0.0.0/UNPUBLISHED_TEST_SPECIMEN.tar.gz',
    archiveSha256: '0'.repeat(64), checkoutAction: `actions/checkout@${'0'.repeat(40)}`
  },
  entries: [{ projectId: firstId, pathParts: ['apps', 'one'] }, { projectId: secondId, pathParts: ['apps', 'two'] }]
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function invoke(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({ argv, cwd, env, stdout, stderr });
  return { code, err: stderr.text(), out: stdout.text(), report: stdout.text() ? JSON.parse(stdout.text()) : undefined };
}

async function fixture(withInventory = false, crlf = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-heartbeat-')));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: path.join(root, 'external-config') };
  const repository = path.join(root, 'repository');
  const project = path.join(repository, 'apps', 'one');
  await mkdir(project, { recursive: true }); await writeFile(path.join(project, 'liftoff.manifest.json'), manifest);
  const git = await new NodeCommandRunner().run({ executable: 'git', args: ['init', '--quiet'] }, { cwd: repository });
  expect(git.status, git.stderr).toBe(0);
  const plan = await invoke(['telemetry', 'enroll', '--check', '--json'], project, env);
  const enrolled = await invoke(['telemetry', 'enroll', '--approve-plan', plan.report.fingerprint, '--json'], project, env);
  expect(enrolled.code, enrolled.err).toBe(0);
  const inventory: HeartbeatInventory = {
    ...specimen, entries: [{ projectId: enrolled.report.projectId, pathParts: ['apps', 'one'] }, specimen.entries[1]]
  };
  const inventoryFile = path.join(repository, ...heartbeatInventoryPath), workflowFile = path.join(repository, ...heartbeatWorkflowPath);
  const custom = '\n  custom_job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo retained\n# custom trailing comment\n';
  const workflow = (renderHeartbeatWorkflow(inventory) + custom).replaceAll('\n', crlf ? '\r\n' : '\n');
  if (withInventory) {
    await mkdir(path.dirname(inventoryFile), { recursive: true }); await mkdir(path.dirname(workflowFile), { recursive: true });
    await writeFile(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
    await writeFile(workflowFile, workflow);
  }
  return { root, repository, project, env, inventory, inventoryFile, workflowFile, workflow };
}

describe('unqualified heartbeat refusal and independent repository removal', () => {
  it('never promotes candidate syntax, enrollment or an explicit heartbeat flag into publication/CI authority', async () => {
    const f = await fixture(), before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch');
    expect(qualifiedHeartbeatTooling).toBeUndefined();
    expect(validateHeartbeatTooling(specimen.tooling)).toEqual(specimen.tooling);
    const enable = await invoke(['telemetry', 'heartbeat', 'enable', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(enable.code).toBe(2);
    expect(enable.report).toMatchObject({ status: 'blocked', reason: 'publication-not-qualified', projectEnrolled: true, scheduleInstalled: false });
    expect((await invoke(['telemetry', 'report', '--heartbeat', '--json'], f.project, f.env)).report.reason).toBe('heartbeat-not-qualified');
    expect(await captureTreeState(f.root)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ CI: 'true' }, { CI: 'true', DO_NOT_TRACK: '1' }, { CI: 'true', LIFTOFF_TELEMETRY: '0' }])(
    'ordinary CI and both opt-outs still prevent heartbeat state/transport: %j', async disabled => {
      const f = await fixture(true), before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch');
      for (const action of ['status', 'enable', 'disable']) {
        const result = await invoke(['telemetry', 'heartbeat', action, '--repository', f.repository, '--json'], f.project, { ...f.env, ...disabled });
        expect(result.report.status).toBe('disabled');
      }
      const report = await invoke(['telemetry', 'report', '--heartbeat', '--json'], f.project, { ...f.env, ...disabled });
      expect(report.report).toMatchObject({ status: 'disabled', attempted: false });
      expect(await captureTreeState(f.root)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])('removes only the separately approved nested entry, preserving other entries and custom bytes (CRLF=%s)', async crlf => {
    const f = await fixture(true, crlf), fetch = vi.spyOn(globalThis, 'fetch');
    const before = await captureTreeState(f.root);
    const preview = await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(preview.code).toBe(2);
    expect(preview.report.plan.selectedRoot).toEqual(['apps', 'one']);
    expect(await captureTreeState(f.root)).toEqual(before);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--approve-plan', preview.report.fingerprint, '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(0);
    expect(result.report).toMatchObject({ status: 'disabled', entryRemoved: true, otherEntriesPreserved: true, customWorkflowBytesPreserved: true });
    const section = renderHeartbeatEntry(f.inventory.entries[0], f.inventory.tooling, f.inventory.repository).replaceAll('\n', crlf ? '\r\n' : '\n');
    expect(await readFile(f.workflowFile, 'utf8')).toBe(f.workflow.replace(section, ''));
    expect(JSON.parse(await readFile(f.inventoryFile, 'utf8')).entries).toEqual([specimen.entries[1]]);
    expect((await invoke(['telemetry', 'status', '--json'], f.project, f.env)).report.status).toBe('enabled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires explicit independently verified repository scope and rejects projects outside it', async () => {
    const f = await fixture(true), before = await captureTreeState(f.root);
    expect((await invoke(['telemetry', 'heartbeat', 'disable', '--json'], f.project, f.env)).err).toContain('--repository');
    const wrongRoot = await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.project, '--json'], f.project, f.env);
    expect(wrongRoot.code).toBe(1); expect(wrongRoot.err).toContain('independently verified');
    const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'liftoff.manifest.json'), manifest);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', outside, '--repository', f.repository, '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.err).toContain('outside');
    await rm(outside, { recursive: true });
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('refuses stale approvals, identity mismatch and edited owned blocks without replacing custom bytes', async () => {
    const f = await fixture(true), preview = await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    await writeFile(f.workflowFile, `${f.workflow}# a later custom edit\n`);
    const changed = await readFile(f.workflowFile);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--approve-plan', preview.report.fingerprint, '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.report.status).toBe('mismatch');
    expect(await readFile(f.workflowFile)).toEqual(changed);
    await writeFile(f.workflowFile, f.workflow.replace('timeout-minutes: 5', 'timeout-minutes: 6'));
    expect((await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--check', '--json'], f.project, f.env)).err).toContain('owned entry bytes changed');
    await writeFile(f.inventoryFile, JSON.stringify({ ...f.inventory, entries: [{ projectId: firstId, pathParts: ['apps', 'one'] }] }));
    expect((await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--check', '--json'], f.project, f.env)).err).toContain('identity disagree');
  });

  it('sanitizes malformed inventories and treats missing entries as disabled without writes', async () => {
    const f = await fixture(true);
    await writeFile(f.inventoryFile, '{"credential":"PRIVATE_TEST_SPECIMEN" malformed}');
    const result = await invoke(['telemetry', 'heartbeat', 'status', '--repository', f.repository, '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.err).toContain('invalid JSON');
    expect(result.out + result.err).not.toContain('PRIVATE_TEST_SPECIMEN');
    await writeFile(f.inventoryFile, JSON.stringify({ ...f.inventory, entries: [specimen.entries[1]] }));
    const before = await captureTreeState(f.root);
    expect((await invoke(['telemetry', 'heartbeat', 'disable', '--repository', f.repository, '--json'], f.project, f.env)).report.reason).toBe('entry-absent');
    expect(await captureTreeState(f.root)).toEqual(before);
  });
});

describe('candidate heartbeat inventory and deterministic exact-byte edits (not publication qualification)', () => {
  it('renders only explicit roots with monthly cadence, immutable tooling and no application execution', () => {
    expect(renderHeartbeatWorkflow(specimen)).toBe(renderHeartbeatWorkflow(specimen));
    const workflow = renderHeartbeatWorkflow(specimen);
    expect(workflow).toContain('cron: "0 0 1 * *"'); expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('contents: read'); expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow.match(/telemetry report/gu)).toHaveLength(2);
    expect(workflow).toContain("telemetry report 'apps/one' --heartbeat --json");
    expect(workflow).not.toMatch(/npm (?:install|run)|liftoff (?:update|repair|upgrade)|tofu|az deployment|find .*manifest/u);
    expect(qualifiedHeartbeatTooling).toBeUndefined();
  });

  describe('synthetic SOURCE producer foundation, never release or CI qualification', () => {
    async function sourcePlan(crlf = false, existing = true) {
      const f = await fixture(false, crlf);
      const git = await new NodeCommandRunner().run({
        executable: 'git', args: ['config', 'remote.origin.url', 'https://github.com/specimen/repository.git']
      }, { cwd: f.repository });
      expect(git.status, git.stderr).toBe(0);
      if (existing) {
        const inventory = { ...f.inventory, entries: [specimen.entries[1]] };
        await mkdir(path.dirname(f.inventoryFile), { recursive: true });
        await mkdir(path.dirname(f.workflowFile), { recursive: true });
        await writeFile(f.inventoryFile, JSON.stringify(inventory));
        await writeFile(f.workflowFile, (renderHeartbeatWorkflow(inventory) + '# custom bytes retained\n')
          .replaceAll('\n', crlf ? '\r\n' : '\n'));
      }
      const repository = await readHeartbeatRepository(f.repository, f.env);
      const project = await observeProjectTelemetry(f.project, '.', f.env);
      const plan = buildHeartbeatEnablementPlan(repository, project, specimen.tooling);
      const bindings = heartbeatReviewBindings(repository, project);
      const assertCurrent = async () => {
        if (f.env.DO_NOT_TRACK === '1' || f.env.LIFTOFF_TELEMETRY === '0') throw new Error('Opted out during preparation.');
        const currentRepository = await readHeartbeatRepository(f.repository, f.env);
        const currentProject = await observeProjectTelemetry(f.project, '.', f.env);
        if (JSON.stringify(heartbeatReviewBindings(currentRepository, currentProject)) !== JSON.stringify(bindings)) {
          throw new Error('Source fixture review changed.');
        }
      };
      return { ...f, repositoryObservation: repository, projectObservation: project, plan, assertCurrent };
    }

    it.each([false, true])('applies one separately approved candidate entry with exact readback and retained other/custom bytes (CRLF=%s)', async crlf => {
      const f = await sourcePlan(crlf), beforeWorkflow = await readFile(f.workflowFile, 'utf8');
      const beforeConfig = await readFile(getTelemetryConfigPath({ env: f.env }));
      const beforeRecord = await readFile(path.join(f.project, '.liftoff/telemetry/project.json'));
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No SOURCE transport.'));
      expect(f.plan.selectedRoot).toEqual(['apps', 'one']);
      expect(f.plan.repositoryIdentity).toBe('specimen/repository');
      expect(f.plan.config.digest).toMatch(/^[a-f0-9]{64}$/u);
      await applyHeartbeatPlan(f.repositoryObservation, f.plan, telemetryReviewFingerprint(f.plan), f.assertCurrent);
      const inventory: HeartbeatInventory = JSON.parse(await readFile(f.inventoryFile, 'utf8'));
      const workflow = await readFile(f.workflowFile, 'utf8');
      expect(inventory.entries).toEqual([specimen.entries[1], f.plan.targetInventory.entries[1]]);
      const section = renderHeartbeatEntry(inventory.entries[1], inventory.tooling, inventory.repository)
        .replaceAll('\n', crlf ? '\r\n' : '\n');
      expect(workflow.replace(section, '')).toBe(beforeWorkflow);
      validateHeartbeatWorkflow(inventory, workflow);
      expect(heartbeatReportingEntry({ inventory, workflow, repository: 'specimen/repository',
        selectedRoot: ['apps', 'one'], projectId: f.projectObservation.record!.projectId,
        enabled: true, tooling: specimen.tooling })).toEqual(inventory.entries[1]);
      expect(await readFile(getTelemetryConfigPath({ env: f.env }))).toEqual(beforeConfig);
      expect(await readFile(path.join(f.project, '.liftoff/telemetry/project.json'))).toEqual(beforeRecord);
      expect(fetch).not.toHaveBeenCalled(); expect(qualifiedHeartbeatTooling).toBeUndefined();
    });

    it('creates only one explicit root from absent files without enrolling or touching another project', async () => {
      const f = await sourcePlan(false, false), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No SOURCE transport.'));
      await applyHeartbeatPlan(f.repositoryObservation, f.plan, telemetryReviewFingerprint(f.plan), f.assertCurrent);
      expect(JSON.parse(await readFile(f.inventoryFile, 'utf8')).entries).toEqual([{
        projectId: f.projectObservation.record!.projectId, pathParts: ['apps', 'one']
      }]);
      expect(await readFile(f.workflowFile, 'utf8')).toBe(f.plan.targetWorkflow);
      expect(fetch).not.toHaveBeenCalled(); expect(qualifiedHeartbeatTooling).toBeUndefined();
    });

    it.each(['approval', 'config', 'record', 'workflow', 'origin', 'opt-out', 'read-only'] as const)(
      'rejects changed/invalid %s before candidate writes', async change => {
        const f = await sourcePlan();
        if (change === 'config') await writeFile(getTelemetryConfigPath({ env: f.env }), '{}');
        if (change === 'record') await writeFile(path.join(f.project, '.liftoff/telemetry/project.json'), JSON.stringify({
          ...f.projectObservation.record, enabled: false
        }));
        if (change === 'workflow') await writeFile(f.workflowFile, f.plan.targetWorkflow + '# later edit\n');
        if (change === 'origin') {
          const result = await new NodeCommandRunner().run({ executable: 'git',
            args: ['config', 'remote.origin.url', 'https://github.com/specimen/other.git'] }, { cwd: f.repository });
          expect(result.status, result.stderr).toBe(0);
        }
        if (change === 'opt-out') f.env.DO_NOT_TRACK = '1';
        if (change === 'read-only') await chmod(f.workflowFile, 0o444);
        const before = await captureTreeState(f.root);
        await expect(applyHeartbeatPlan(f.repositoryObservation, f.plan,
          change === 'approval' ? '0'.repeat(64) : telemetryReviewFingerprint(f.plan), f.assertCurrent)).rejects.toThrow();
        expect(await captureTreeState(f.root)).toEqual(before);
        if (change === 'read-only') await chmod(f.workflowFile, 0o644);
      }
    );

    it('refuses orphan/custom workflows, mismatched tooling and absent local consent rather than overwrite or implicitly upgrade', async () => {
      const f = await sourcePlan();
      const noConsent = { ...f.projectObservation, consent: false };
      expect(() => buildHeartbeatEnablementPlan(f.repositoryObservation, noConsent, specimen.tooling)).toThrow(/consent/u);
      expect(() => buildHeartbeatEnablementPlan(f.repositoryObservation, f.projectObservation, {
        ...specimen.tooling, archiveSha256: '1'.repeat(64)
      })).toThrow(/implicit/u);
      await rm(f.inventoryFile);
      const orphan = await readHeartbeatRepository(f.repository, f.env);
      expect(() => buildHeartbeatEnablementPlan(orphan, f.projectObservation, specimen.tooling)).toThrow(/ownership/u);
    });

    it.each([false, true])('deletes only fully owned files after separately reviewed last-entry removal (CRLF=%s)', async crlf => {
      const f = await fixture(true, crlf), inventory = { ...f.inventory, entries: [f.inventory.entries[0]] };
      const workflow = renderHeartbeatWorkflow(inventory).replaceAll('\n', crlf ? '\r\n' : '\n');
      await writeFile(f.inventoryFile, JSON.stringify(inventory)); await writeFile(f.workflowFile, workflow);
      const preview = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
      expect(preview.code, preview.err).toBe(2);
      expect(preview.report.plan.removeOwnedFiles).toBe(true);
      const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository,
        '--approve-plan', preview.report.fingerprint, '--json'], f.project, f.env);
      expect(result.code, result.err).toBe(0);
      expect(result.report.ownedFilesRemoved).toBe(true);
      await expect(readFile(f.inventoryFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(f.workflowFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await invoke(['telemetry', 'status', '--json'], f.project, f.env)).report.status).toBe('enabled');
    });

    it('keeps custom jobs on last-entry removal and refuses deleting custom comment-only content', () => {
      const inventory = { ...specimen, entries: [specimen.entries[0]] }, owned = renderHeartbeatWorkflow(inventory);
      const custom = '\n  custom_job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo retained\n';
      const target = heartbeatRemovalTarget(inventory, owned + custom, inventory.entries[0]);
      expect(target.removeOwnedFiles).toBe(false); expect(target.targetWorkflow).toContain(custom);
      expect(() => heartbeatRemovalTarget(inventory, owned + '# unowned comment\n', inventory.entries[0])).toThrow(/separate workflow review/u);
    });

    it.each(['disabled', 'entry', 'identity', 'tooling', 'schedule', 'owned-block', 'duplicate-marker', 'duplicate-job', 'invalid-yaml', 'aliased-job'] as const)(
      'rejects candidate proof data with %s without minting CI authority', change => {
        let inventory = specimen, workflow = renderHeartbeatWorkflow(specimen), repository = specimen.repository;
        let selectedRoot = specimen.entries[0].pathParts, enabled = true;
        if (change === 'disabled') enabled = false;
        if (change === 'entry') selectedRoot = ['other'];
        if (change === 'identity') repository = 'specimen/other';
        if (change === 'tooling') inventory = { ...specimen, tooling: { ...specimen.tooling, archiveSha256: '1'.repeat(64) } };
        if (change === 'schedule') workflow = workflow.replace('0 0 1 * *', '* * * * *');
        if (change === 'owned-block') workflow = workflow.replace('timeout-minutes: 5', 'timeout-minutes: 6');
        if (change === 'duplicate-marker') workflow += `  # liftoff-heartbeat:${firstId}:begin\n`;
        if (change === 'duplicate-job') workflow += `  project_${firstId.replaceAll('-', '_')}:\n    runs-on: ubuntu-24.04\n`;
        if (change === 'invalid-yaml') workflow += '  custom: [broken\n';
        if (change === 'aliased-job') workflow += '  custom: *unreviewed\n';
        expect(() => heartbeatReportingEntry({ inventory, workflow, repository, selectedRoot, enabled,
          projectId: firstId, tooling: specimen.tooling })).toThrow();
        expect(qualifiedHeartbeatTooling).toBeUndefined();
      }
    );

    it('never grants a public exception from candidate bytes, forged CI bindings or caller release-pin fields', async () => {
      const f = await sourcePlan(false, false);
      await applyHeartbeatPlan(f.repositoryObservation, f.plan, telemetryReviewFingerprint(f.plan), f.assertCurrent);
      const env = { ...f.env, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'specimen/repository',
        GITHUB_WORKSPACE: f.repository, GITHUB_JOB: `project_${f.projectObservation.record!.projectId.replaceAll('-', '_')}`,
        GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule',
        GITHUB_WORKFLOW_REF: 'specimen/repository/.github/workflows/liftoff-project-heartbeat.yml@refs/heads/main' };
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No SOURCE transport.'));
      const before = await captureTreeState(f.root);
      const result = await invoke(['telemetry', 'report', '.', '--heartbeat', '--repository', f.repository, '--json'], f.project, env);
      expect(result.code, result.err).toBe(0);
      expect(result.report).toMatchObject({ status: 'disabled', attempted: false, reason: 'heartbeat-not-qualified' });
      const event = { schemaVersion: 2 as const, event: 'project_observed' as const,
        projectId: f.projectObservation.record!.projectId, cliVersion: '0.0.0', ...f.projectObservation.dimensions, source: 'ci-heartbeat' as const };
      expect(await readQualifiedHeartbeatReportProof({
        projectRoot: f.project, repositoryRoot: f.repository, env,
        manifest: f.plan.manifest, event
      })).toBeUndefined();
      expect(await Reflect.apply(heartbeatReportProofAllows, undefined, [{ event, tooling: specimen.tooling }, event, env])).toBe(false);
      expect(await captureTreeState(f.root)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
      expect(qualifiedHeartbeatTooling).toBeUndefined();
    });

    it('binds CLI repository reporting only to the explicit heartbeat route, never mutation authority', () => {
      expect(parseArgs(['telemetry', 'report', '.', '--heartbeat', '--repository', '.']).flags.repository).toBe('.');
      expect(() => parseArgs(['telemetry', 'report', '.', '--repository', '.'])).toThrow(/only/u);
      expect(() => parseArgs(['telemetry', 'report', '.', '--heartbeat', '--approve-plan', '0'.repeat(64)])).toThrow(/mutation authority/u);
      expect(() => parseArgs(['telemetry', 'report', '.', '--heartbeat', '--qualified-tooling', 'candidate'])).toThrow(/Unknown flag/u);
    });
    it('refuses redirected Git configuration and cancelled reads before consulting repository metadata', async () => {
      const f = await fixture(false);
      await expect(readHeartbeatRepository(f.repository, { ...f.env, GIT_CONFIG_COUNT: '1' })).rejects.toThrow(/redirected/u);
      await expect(readHeartbeatRepository('absent root', f.env, true, AbortSignal.abort())).rejects.toThrow(/cancelled/u);
    });
  });

  it.each([
    { schemaVersion: 2 }, { repository: 'not-a-repository' }, { entries: [specimen.entries[0], specimen.entries[0]] },
    { entries: [specimen.entries[0], { projectId: secondId, pathParts: ['APPS', 'ONE'] }] },
    { entries: [{ projectId: firstId, pathParts: ['..'] }] },
    { entries: [{ projectId: firstId, pathParts: ['${{ secrets.TOKEN }}'] }] },
    { entries: [{ projectId: 'not-a-uuid', pathParts: [] }] }
  ])('rejects unsupported, duplicate, alias or expression inventory: %j', change => {
    expect(() => parseHeartbeatInventory({ ...specimen, ...change })).toThrow();
  });

  it.each([
    { checkoutAction: 'actions/checkout@main' }, { archiveSha256: 'latest' },
    { cliVersion: '0.0.0-preview' }, { archiveUrl: 'http://invalid.test/cli.tar.gz' }
  ])('rejects mutable/unsupported candidate tooling: %j', change => {
    expect(() => validateHeartbeatTooling({ ...specimen.tooling, ...change })).toThrow(/immutable/u);
  });

  it('updates one exact entry while rejecting ambiguity, unsupported endings and oversized workflows', () => {
    const initial = { ...specimen, entries: [specimen.entries[0]] }, workflow = renderHeartbeatWorkflow(initial) + '# retained\n';
    const added = updateHeartbeatEntry(initial, workflow, specimen.entries[1], 'add');
    expect(added.inventory.entries).toEqual(specimen.entries);
    expect(added.workflow).toContain('# retained\n');
    expect(updateHeartbeatEntry(added.inventory, added.workflow, specimen.entries[1], 'remove').workflow).toBe(workflow);
    expect(() => updateHeartbeatEntry(initial, workflow, specimen.entries[0], 'add')).toThrow(/already present/u);
    expect(() => updateHeartbeatEntry(initial, workflow, specimen.entries[1], 'remove')).toThrow(/absent/u);
    expect(() => updateHeartbeatEntry(initial, `${workflow}\njobs:\n`, specimen.entries[1], 'add')).toThrow(/ambiguous/u);
    expect(() => updateHeartbeatEntry(initial, `${workflow}${renderHeartbeatEntry(specimen.entries[0], specimen.tooling, specimen.repository)}`, specimen.entries[0], 'remove')).toThrow(/ambiguous/u);
    expect(() => updateHeartbeatEntry(initial, workflow.replaceAll('\n', '\r'), specimen.entries[0], 'remove')).toThrow(/line endings/u);
    expect(() => updateHeartbeatEntry(initial, 'x'.repeat(256 * 1024) + '\r\n', specimen.entries[0], 'remove')).toThrow(/bounded size/u);
  });
});

describe('private SOURCE removal ownership and resulting workflow consistency', () => {
  const customJob = '\n  custom_job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo retained\n# custom comment retained\n';
  const markerCases = [false, true].flatMap(crlf => ['same', 'other'].flatMap(id =>
    ['begin', 'end'].flatMap(edge => ['before', 'after', 'within'].map(position => ({ crlf, id, edge, position })))));

  async function oneEntry(crlf = false, custom = '') {
    const f = await fixture(true, crlf), inventory = { ...f.inventory, entries: [f.inventory.entries[0]] };
    const workflow = (renderHeartbeatWorkflow(inventory) + custom).replaceAll('\n', crlf ? '\r\n' : '\n');
    await writeFile(f.inventoryFile, JSON.stringify(inventory));
    await writeFile(f.workflowFile, workflow);
    return { ...f, inventory, workflow };
  }

  it.each(markerCases)('refuses marker ambiguity without any writes: $crlf/$id/$edge/$position', async ({ crlf, id, edge, position }) => {
    const f = await oneEntry(false, customJob);
    const selected = f.inventory.entries[0], section = renderHeartbeatEntry(selected, f.inventory.tooling, f.inventory.repository);
    const marker = `  # liftoff-heartbeat:${id === 'same' ? selected.projectId : secondId}:${edge}\n`;
    const workflow = (position === 'within'
      ? f.workflow.replace('    steps:\n', `    steps:\n${marker}`)
      : f.workflow.replace(section, position === 'before' ? marker + section : section + marker))
      .replaceAll('\n', crlf ? '\r\n' : '\n');
    await writeFile(f.workflowFile, workflow);
    const before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch');
    expect(() => heartbeatRemovalTarget(f.inventory, workflow, selected)).toThrow(/markers|owned entry/u);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(1);
    expect(await captureTreeState(f.root)).toEqual(before);
    expect(await readFile(f.workflowFile, 'utf8')).toBe(workflow);
    expect(fetch).not.toHaveBeenCalled(); expect(qualifiedHeartbeatTooling).toBeUndefined();
  });

  it.each([
    'malformed', 'duplicate-owned-job', 'jobs-sequence', 'duplicate-jobs',
    'missing-dependency', 'cyclic-dependencies', 'paired-cycle', 'non-string-needs', 'aliased-needs',
    'removed-job-dependency-string', 'removed-job-dependency-sequence'
  ])('refuses current/result invalid or contradictory YAML before writes: %s', async change => {
    const f = await oneEntry(), entry = f.inventory.entries[0], job = `project_${entry.projectId.replaceAll('-', '_')}`;
    let workflow = f.workflow;
    if (change === 'malformed') workflow += '  custom_job: [unfinished\n';
    if (change === 'duplicate-owned-job') workflow += `  ${job}:\n    runs-on: ubuntu-24.04\n`;
    if (change === 'jobs-sequence') workflow += '  - impossible-job\n';
    if (change === 'duplicate-jobs') workflow += '\njobs:\n  custom_job:\n    runs-on: ubuntu-24.04\n';
    if (change === 'missing-dependency') workflow += customJob.replace('    steps:', '    needs: absent_job\n    steps:');
    if (change === 'cyclic-dependencies') workflow += customJob.replace('    steps:', '    needs: custom_job\n    steps:');
    if (change === 'paired-cycle') workflow += customJob.replace('    steps:', '    needs: other_custom_job\n    steps:') +
      '\n  other_custom_job:\n    needs: custom_job\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo retained\n';
    if (change === 'non-string-needs') workflow += customJob.replace('    steps:', '    needs: [true]\n    steps:');
    if (change === 'aliased-needs') workflow += customJob.replace('    steps:', '    needs: *ambiguous_dependency\n    steps:');
    if (change === 'removed-job-dependency-string') workflow += customJob.replace('    steps:', `    needs: ${job}\n    steps:`);
    if (change === 'removed-job-dependency-sequence') workflow += customJob.replace('    steps:', `    needs: [${job}]\n    steps:`);
    await writeFile(f.workflowFile, workflow);
    const before = await captureTreeState(f.root);
    if (change.startsWith('removed-job')) validateHeartbeatWorkflow(f.inventory, workflow);
    expect(() => heartbeatRemovalTarget(f.inventory, workflow, entry)).toThrow();
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(1);
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it.each(['', 'not-a-complete-marker'])('rejects malformed reserved markers without rewriting custom bytes: %j', async suffix => {
    const f = await oneEntry(false, customJob), workflow = f.workflow + `  # liftoff-heartbeat:${suffix}\n`;
    await writeFile(f.workflowFile, workflow);
    const before = await captureTreeState(f.root);
    expect(() => heartbeatRemovalTarget(f.inventory, workflow, f.inventory.entries[0])).toThrow(/markers/u);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(1); expect(await captureTreeState(f.root)).toEqual(before);
  });

  it.each([false, true])('preserves custom bytes and valid dependencies on other entries exactly (CRLF=%s)', async crlf => {
    const f = await fixture(true), selected = f.inventory.entries[0], other = f.inventory.entries[1];
    const custom = customJob.replace('    steps:', `    needs: [project_${other.projectId.replaceAll('-', '_')}]\n    steps:`);
    const workflow = (renderHeartbeatWorkflow(f.inventory) + custom).replaceAll('\n', crlf ? '\r\n' : '\n');
    await writeFile(f.workflowFile, workflow);
    const preview = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(preview.code, preview.err).toBe(2); expect(preview.report.plan.removeOwnedFiles).toBe(false);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository,
      '--approve-plan', preview.report.fingerprint, '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(0);
    const section = renderHeartbeatEntry(selected, f.inventory.tooling, f.inventory.repository).replaceAll('\n', crlf ? '\r\n' : '\n');
    const currentWorkflow = await readFile(f.workflowFile, 'utf8');
    expect(currentWorkflow).toBe(workflow.replace(section, ''));
    const currentInventory: HeartbeatInventory = JSON.parse(await readFile(f.inventoryFile, 'utf8'));
    expect(currentInventory.entries).toEqual([other]);
    validateHeartbeatWorkflow(currentInventory, currentWorkflow);
    expect(() => heartbeatReportingEntry({ inventory: currentInventory, workflow: currentWorkflow, repository: f.inventory.repository,
      selectedRoot: selected.pathParts, projectId: selected.projectId, enabled: true, tooling: f.inventory.tooling })).toThrow(/separately enabled/u);
  });

  it.each([false, true])('preserves a custom-only workflow with an empty consistent inventory after last removal (CRLF=%s)', async crlf => {
    const f = await oneEntry(crlf, customJob);
    const preview = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(preview.code, preview.err).toBe(2); expect(preview.report.plan.removeOwnedFiles).toBe(false);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository,
      '--approve-plan', preview.report.fingerprint, '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(0);
    const currentInventory: HeartbeatInventory = JSON.parse(await readFile(f.inventoryFile, 'utf8'));
    const currentWorkflow = await readFile(f.workflowFile, 'utf8');
    expect(currentInventory.entries).toEqual([]);
    expect(currentWorkflow).toBe((renderHeartbeatWorkflow({ ...f.inventory, entries: [] }) + customJob)
      .replaceAll('\n', crlf ? '\r\n' : '\n'));
    validateHeartbeatWorkflow(currentInventory, currentWorkflow);
    expect(currentWorkflow).not.toContain('# liftoff-heartbeat:');
    expect((await invoke(['telemetry', 'heartbeat', 'status', '.', '--repository', f.repository, '--json'], f.project, f.env)).report.configuredEntry).toBe(false);
  });

  it.each(['mixed-line-endings', 'invalid-utf8'])('refuses byte-normalizing removal before writes: %s', async change => {
    const f = await oneEntry();
    const bytes = change === 'mixed-line-endings'
      ? Buffer.from(renderHeartbeatWorkflow(f.inventory).replaceAll('\n', '\r\n') + customJob)
      : Buffer.concat([Buffer.from(f.workflow + customJob + '# custom byte '), Buffer.from([0xff]), Buffer.from('\n')]);
    await writeFile(f.workflowFile, bytes);
    const before = await captureTreeState(f.root);
    expect(() => heartbeatRemovalTarget(f.inventory, bytes, f.inventory.entries[0])).toThrow(/UTF-8|mixed line endings/u);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(1);
    expect(await readFile(f.workflowFile)).toEqual(bytes); expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('rejects stale approval when a fully owned deletion becomes a custom-preserving update', async () => {
    const f = await oneEntry();
    const preview = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(preview.code, preview.err).toBe(2); expect(preview.report.plan.removeOwnedFiles).toBe(true);
    await writeFile(f.workflowFile, f.workflow + customJob);
    const before = await captureTreeState(f.root);
    const result = await invoke(['telemetry', 'heartbeat', 'disable', '.', '--repository', f.repository,
      '--approve-plan', preview.report.fingerprint, '--json'], f.project, f.env);
    expect(result.code, result.err).toBe(1); expect(result.report.status).toBe('mismatch');
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('reports contradictory synthetic post-commit readback rather than success after a disposable owned deletion', async () => {
    const f = await oneEntry(), repository = await readHeartbeatRepository(f.repository, f.env, false);
    const plan = { repositoryRoot: repository.root,
      ...heartbeatRemovalTarget(f.inventory, await readFile(f.workflowFile), f.inventory.entries[0]) };
    const original = telemetryFiles.readTelemetryFile;
    vi.spyOn(telemetryFiles, 'readTelemetryFile').mockImplementation(async (root, parts, maximumBytes) => {
      const snapshot = await original(root, parts, maximumBytes);
      return root === f.repository && JSON.stringify(parts) === JSON.stringify(heartbeatWorkflowPath) && snapshot.content === undefined
        ? { ...snapshot, content: Buffer.from('Synthetic contradictory readback, not a real concurrent edit.') } : snapshot;
    });
    await expect(applyHeartbeatPlan(repository, plan, telemetryReviewFingerprint(plan), async () => {})).rejects.toThrow(/did not read back/u);
    await expect(readFile(f.workflowFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(f.inventoryFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(qualifiedHeartbeatTooling).toBeUndefined();
  });
});

describe('private SOURCE workflow byte preservation, never published enablement or reporting authority', () => {
  const custom = '\n  custom_unicode_job:\n    runs-on: ubuntu-24.04\n    steps:\n' +
    '      - run: echo "caf\u00e9 \u4e16\u754c \ud83d\ude80 e\u0301 \ufffd"\n# reviewed Unicode: \u00e9 \u4e16\u754c \ud83d\ude80 \ufffd\n';

  async function enablementFixture(crlf = false) {
    const f = await fixture(false), inventory = { ...f.inventory, entries: [specimen.entries[1]] };
    const git = await new NodeCommandRunner().run({ executable: 'git',
      args: ['config', 'remote.origin.url', 'https://github.com/specimen/repository.git'] }, { cwd: f.repository });
    expect(git.status, git.stderr).toBe(0);
    const workflow = Buffer.from((renderHeartbeatWorkflow(inventory) + custom).replaceAll('\n', crlf ? '\r\n' : '\n'), 'utf8');
    await mkdir(path.dirname(f.inventoryFile), { recursive: true });
    await mkdir(path.dirname(f.workflowFile), { recursive: true });
    await writeFile(f.inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
    await writeFile(f.workflowFile, workflow);
    const repositoryObservation = await readHeartbeatRepository(f.repository, f.env);
    const projectObservation = await observeProjectTelemetry(f.project, '.', f.env);
    return { ...f, inventory, workflow, repositoryObservation, projectObservation };
  }

  it.each([
    'invalid-continuation', 'truncated-sequence', 'overlong-sequence', 'encoded-surrogate',
    'mixed-lf-owned-crlf-custom', 'mixed-crlf-owned-lf-custom', 'bare-cr'
  ])('refuses %s before existing-workflow enablement, model reporting or repository reads and leaves all bytes untouched', async change => {
    const f = await enablementFixture();
    let bytes = f.workflow;
    if (change.startsWith('mixed-')) {
      bytes = Buffer.from(change === 'mixed-lf-owned-crlf-custom'
        ? renderHeartbeatWorkflow(f.inventory) + custom.replaceAll('\n', '\r\n')
        : renderHeartbeatWorkflow(f.inventory).replaceAll('\n', '\r\n') + custom);
    } else {
      const invalid = change === 'invalid-continuation' ? [0xff]
        : change === 'truncated-sequence' ? [0xe2, 0x82]
        : change === 'overlong-sequence' ? [0xc0, 0xaf]
        : change === 'encoded-surrogate' ? [0xed, 0xa0, 0x80] : [0x0d, 0x78];
      bytes = Buffer.concat([f.workflow, Buffer.from('# unchanged custom byte '), Buffer.from(invalid), Buffer.from('\n')]);
    }
    await writeFile(f.workflowFile, bytes);
    const before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No SOURCE transport.'));
    const rawRepository = { ...f.repositoryObservation, workflowFile: { ...f.repositoryObservation.workflowFile, content: bytes } };
    expect(() => buildHeartbeatEnablementPlan(rawRepository, f.projectObservation, specimen.tooling)).toThrow(/UTF-8|line endings/u);
    expect(() => updateHeartbeatEntry(f.inventory, bytes,
      { projectId: f.projectObservation.record!.projectId, pathParts: ['apps', 'one'] }, 'add')).toThrow(/UTF-8|line endings/u);
    expect(() => validateHeartbeatWorkflow(f.inventory, bytes)).toThrow(/UTF-8|line endings/u);
    expect(() => heartbeatWorkflowHasJobs(bytes)).toThrow(/UTF-8|line endings/u);
    expect(() => heartbeatWorkflowDigest(bytes)).toThrow(/UTF-8|line endings/u);
    expect(() => heartbeatReportingEntry({ inventory: f.inventory, workflow: bytes, repository: f.inventory.repository,
      selectedRoot: ['apps', 'two'], projectId: secondId, enabled: true, tooling: specimen.tooling })).toThrow(/UTF-8|line endings/u);
    await expect(readHeartbeatRepository(f.repository, f.env)).rejects.toThrow(/UTF-8|line endings/u);
    await expect(readHeartbeatRepository(f.repository, f.env, false)).rejects.toThrow(/UTF-8|line endings/u);
    for (const operation of ['status', 'enable', 'disable']) {
      const result = await invoke(['telemetry', 'heartbeat', operation, '.', '--repository', f.repository, '--json'], f.project, f.env);
      expect(result.code, result.err).toBe(1); expect(result.err).toMatch(/UTF-8|line endings/u);
    }
    const report = await invoke(['telemetry', 'report', '.', '--heartbeat', '--repository', f.repository, '--json'],
      f.project, { ...f.env, CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(report.report).toMatchObject({ status: 'disabled', attempted: false, reason: 'heartbeat-not-qualified' });
    expect(await captureTreeState(f.root)).toEqual(before); expect(await readFile(f.workflowFile)).toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled(); expect(qualifiedHeartbeatTooling).toBeUndefined();
  });

  it.each([false, true])('preserves valid custom Unicode, literal replacement characters and every LF/CRLF byte when inserting one synthetic candidate entry (CRLF=%s)', async crlf => {
    const f = await enablementFixture(crlf), before = await captureTreeState(f.root);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No SOURCE transport.'));
    const beforeRecord = await readFile(path.join(f.project, '.liftoff/telemetry/project.json'));
    const beforeConfig = await readFile(getTelemetryConfigPath({ env: f.env }));
    expect(Buffer.from(heartbeatWorkflowText(f.workflow), 'utf8')).toEqual(f.workflow);
    expect(heartbeatWorkflowDigest(f.workflow)).toBe(createHash('sha256').update(f.workflow).digest('hex'));
    expect(f.repositoryObservation.workflowFile.content).toEqual(f.workflow);
    const plan = buildHeartbeatEnablementPlan(f.repositoryObservation, f.projectObservation, specimen.tooling);
    expect(await captureTreeState(f.root)).toEqual(before);
    const publicEnable = await invoke(['telemetry', 'heartbeat', 'enable', '.', '--repository', f.repository, '--check', '--json'], f.project, f.env);
    expect(publicEnable.code, publicEnable.err).toBe(2); expect(publicEnable.report.reason).toBe('publication-not-qualified');
    expect(await captureTreeState(f.root)).toEqual(before);
    const bindings = heartbeatReviewBindings(f.repositoryObservation, f.projectObservation);
    const assertCurrent = async () => {
      const repository = await readHeartbeatRepository(f.repository, f.env), project = await observeProjectTelemetry(f.project, '.', f.env);
      expect(heartbeatReviewBindings(repository, project)).toEqual(bindings);
    };
    await applyHeartbeatPlan(f.repositoryObservation, plan, telemetryReviewFingerprint(plan), assertCurrent);
    const current = await readFile(f.workflowFile), text = heartbeatWorkflowText(current);
    const entry = plan.targetInventory.entries[1], section = renderHeartbeatEntry(entry, specimen.tooling, specimen.repository)
      .replaceAll('\n', crlf ? '\r\n' : '\n');
    const expected = Buffer.from(f.workflow.toString('utf8').replace(crlf ? 'jobs:\r\n' : 'jobs:\n',
      (crlf ? 'jobs:\r\n' : 'jobs:\n') + section), 'utf8');
    expect(current).toEqual(expected);
    expect(Buffer.from(text.replace(section, ''), 'utf8')).toEqual(f.workflow);
    validateHeartbeatWorkflow(plan.targetInventory, current);
    expect(heartbeatReportingEntry({ inventory: plan.targetInventory, workflow: current, repository: specimen.repository,
      selectedRoot: ['apps', 'one'], projectId: entry.projectId, enabled: true, tooling: specimen.tooling })).toEqual(entry);
    const reread = await readHeartbeatRepository(f.repository, f.env);
    expect(reread.workflowFile.content).toEqual(current);
    expect(heartbeatRemovalTarget(plan.targetInventory, current, entry).targetWorkflow).toBe(f.workflow.toString('utf8'));
    expect(await readFile(path.join(f.project, '.liftoff/telemetry/project.json'))).toEqual(beforeRecord);
    expect(await readFile(getTelemetryConfigPath({ env: f.env }))).toEqual(beforeConfig);
    const report = await invoke(['telemetry', 'report', '.', '--heartbeat', '--repository', f.repository, '--json'],
      f.project, { ...f.env, CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(report.report).toMatchObject({ status: 'disabled', attempted: false, reason: 'heartbeat-not-qualified' });
    expect(fetch).not.toHaveBeenCalled(); expect(qualifiedHeartbeatTooling).toBeUndefined();
  });

  it.each(['invalid-bytes', 'mixed-endings'])('refuses revalidation before a reviewed synthetic plan writes after later %s drift', async change => {
    const f = await enablementFixture(), plan = buildHeartbeatEnablementPlan(f.repositoryObservation, f.projectObservation, specimen.tooling);
    const bytes = change === 'invalid-bytes'
      ? Buffer.concat([f.workflow, Buffer.from('# later invalid byte '), Buffer.from([0xff]), Buffer.from('\n')])
      : Buffer.from(f.workflow.toString('utf8') + '# later CRLF comment\r\n');
    await writeFile(f.workflowFile, bytes);
    const before = await captureTreeState(f.root);
    await expect(applyHeartbeatPlan(f.repositoryObservation, plan, telemetryReviewFingerprint(plan), async () => {
      await readHeartbeatRepository(f.repository, f.env);
    })).rejects.toThrow(/UTF-8|line endings/u);
    expect(await captureTreeState(f.root)).toEqual(before); expect(await readFile(f.workflowFile)).toEqual(bytes);
  });

  it.each(['\ud800', '\udfff'])('rejects unpaired model surrogate %j instead of manufacturing replacement bytes', unpaired => {
    const inventory = { ...specimen, entries: [specimen.entries[1]] }, workflow = renderHeartbeatWorkflow(inventory) + '# custom ' + unpaired + '\n';
    expect(() => heartbeatWorkflowText(workflow)).toThrow(/UTF-8/u);
    expect(() => updateHeartbeatEntry(inventory, workflow, specimen.entries[0], 'add')).toThrow(/UTF-8/u);
    expect(() => validateHeartbeatWorkflow(inventory, workflow)).toThrow(/UTF-8/u);
    expect(qualifiedHeartbeatTooling).toBeUndefined();
  });

  it('rejects lossy-equivalent synthetic postcommit readback instead of accepting invalid bytes as a literal replacement character', async () => {
    const f = await enablementFixture(), plan = buildHeartbeatEnablementPlan(f.repositoryObservation, f.projectObservation, specimen.tooling);
    const expected = Buffer.from(plan.targetWorkflow), replacement = Buffer.from('\ufffd'), at = expected.indexOf(replacement);
    expect(at).toBeGreaterThanOrEqual(0);
    const invalid = Buffer.concat([expected.subarray(0, at), Buffer.from([0xff]), expected.subarray(at + replacement.length)]);
    expect(invalid.toString('utf8')).toBe(plan.targetWorkflow); expect(invalid.equals(expected)).toBe(false);
    const original = telemetryFiles.readTelemetryFile;
    vi.spyOn(telemetryFiles, 'readTelemetryFile').mockImplementation(async (root, parts, maximumBytes) => {
      const snapshot = await original(root, parts, maximumBytes);
      return root === f.repository && JSON.stringify(parts) === JSON.stringify(heartbeatWorkflowPath) && snapshot.content?.equals(expected)
        ? { ...snapshot, content: invalid } : snapshot;
    });
    await expect(applyHeartbeatPlan(f.repositoryObservation, plan, telemetryReviewFingerprint(plan), async () => {})).rejects.toThrow(/did not read back/u);
    expect(await readFile(f.workflowFile)).toEqual(expected);
    expect(qualifiedHeartbeatTooling).toBeUndefined();
  });

  it('shares the unchanged byte-size ceiling for raw UTF-8, multibyte strings and job validation', () => {
    const oversized = [Buffer.alloc(256 * 1024 + 1, 0x61), '\u00e9'.repeat(128 * 1024 + 1)];
    for (const workflow of oversized) {
      expect(() => heartbeatWorkflowText(workflow)).toThrow(/bounded size/u);
      expect(() => heartbeatWorkflowHasJobs(workflow)).toThrow(/bounded size/u);
      expect(() => validateHeartbeatWorkflow(specimen, workflow)).toThrow(/bounded size/u);
    }
  });
});
