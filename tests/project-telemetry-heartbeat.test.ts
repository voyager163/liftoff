import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { captureTreeState } from '../src/init-filesystem.js';
import {
  heartbeatInventoryPath, heartbeatWorkflowPath, parseHeartbeatInventory, qualifiedHeartbeatTooling,
  renderHeartbeatEntry, renderHeartbeatWorkflow, updateHeartbeatEntry, validateHeartbeatTooling,
  type HeartbeatInventory
} from '../src/domain/project/telemetry-heartbeat.js';
import { CaptureStream } from './helpers.js';

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
  const env = { XDG_CONFIG_HOME: path.join(root, 'external-config') }, repository = path.join(root, 'repository');
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
