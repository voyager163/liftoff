import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';
import { runCommand } from '../src/commands.js';
import { captureTreeState } from '../src/init-filesystem.js';
import { getTelemetryConfigPath, recordTelemetryNotice } from '../src/telemetry/config.js';
import { projectTelemetryRecordPath, parseProjectTelemetryRecord, projectConsentBindings } from '../src/domain/project/telemetry-consent.js';
import * as storage from '../src/adapters/filesystem/telemetry-consent.js';
import { createTelemetryDelivery, maximumTelemetryDeliveryMs } from '../src/telemetry/delivery.js';
import { reportProjectObservation } from '../src/application/telemetry/project-reporting.js';
import { projectTelemetryDimensions } from '../src/application/project/telemetry.js';
import { isProjectTelemetryEvent } from '../src/telemetry/contract.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { runSelfUpgrade } from '../src/self-upgrade.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';
import * as telemetryConfig from '../src/telemetry/config.js';

const roots: string[] = [];
const generated = buildCurrentArtifacts(buildCurrentProjectPlan({
  projectName: 'Consent specimen', projectType: 'standard', apiStack: 'node',
  specWorkflow: 'manual', agents: [], governanceProfile: 'none', environments: ['dev']
}, { requireProjectName: true }));
const manifest = generated.find(artifact => artifact.logicalName === 'manifest')!.content;
const recordPath = (project: string) => path.join(project, ...projectTelemetryRecordPath);

afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-project-consent-')));
  roots.push(root);
  const project = path.join(root, 'project'), env = { XDG_CONFIG_HOME: path.join(root, 'config') };
  await mkdir(project);
  await writeFile(path.join(project, 'liftoff.manifest.json'), manifest);
  return { root, project, env, config: getTelemetryConfigPath({ env }) };
}
async function invoke(argv: string[], project: string, env: NodeJS.ProcessEnv) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({ argv, cwd: project, env, stdout, stderr });
  return { code, out: stdout.text(), err: stderr.text(), report: argv.includes('--json') && stdout.text() ? JSON.parse(stdout.text()) : undefined };
}
async function approve(operation: 'enroll' | 'disable', project: string, env: NodeJS.ProcessEnv, flags: string[] = []) {
  const preview = await invoke(['telemetry', operation, '--check', '--json', ...flags], project, env);
  expect(preview.code, preview.err).toBe(2);
  const applied = await invoke(['telemetry', operation, '--json', '--approve-plan', preview.report.fingerprint, ...flags], project, env);
  expect(applied.code, applied.out + applied.err).toBe(0);
  return applied.report;
}

describe('explicit project enrollment and external checkout consent', () => {
  it('keeps deterministic generation and every status/preview free of random identity and writes', async () => {
    const f = await fixture(), random = vi.spyOn(storage, 'newProjectTelemetryId');
    const before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch');
    expect(buildCurrentArtifacts(buildCurrentProjectPlan({
      projectName: 'Consent specimen', projectType: 'standard', apiStack: 'node',
      specWorkflow: 'manual', agents: [], governanceProfile: 'none', environments: ['dev']
    }, { requireProjectName: true }))).toEqual(generated);
    expect(generated.some(artifact => artifact.pathParts.includes('telemetry'))).toBe(false);
    expect(generated.map(artifact => artifact.content).join('\n')).toContain('Configuration changes never enroll telemetry.');
    expect((await invoke(['telemetry', 'status', '--json'], f.project, f.env)).report.status).toBe('disabled');
    const preview = await invoke(['telemetry', 'enroll', '--json'], f.project, f.env);
    expect(preview.code).toBe(2);
    expect(preview.report).toMatchObject({ schemaVersion: 1, status: 'review-required', plan: { heartbeatEnabled: false } });
    expect(preview.report.disclosure).toMatch(/pseudonymous.*not anonymous/u);
    expect(random).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('creates one UUID only after exact approval, preserves unknown config and reads back local consent', async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.config), { recursive: true });
    await writeFile(f.config, JSON.stringify({ future: { retained: true }, telemetry: { noticeVersion: 1, future: 'retained' } }));
    const random = vi.spyOn(storage, 'newProjectTelemetryId'), fetch = vi.spyOn(globalThis, 'fetch');
    const result = await approve('enroll', f.project, f.env);
    expect(result.status).toBe('enrolled'); expect(random).toHaveBeenCalledTimes(1);
    const record = parseProjectTelemetryRecord(JSON.parse(await readFile(recordPath(f.project), 'utf8')));
    expect(record.projectId).toBe(result.projectId);
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    expect(config).toMatchObject({ future: { retained: true }, telemetry: { future: 'retained', noticeVersion: 1 } });
    expect(projectConsentBindings(config)).toEqual([{ projectRoot: f.project, projectId: record.projectId, disclosureVersion: 1 }]);
    expect((await invoke(['telemetry', 'status', '--json'], f.project, f.env)).report.status).toBe('enabled');
    expect(fetch).not.toHaveBeenCalled();
    expect(await recordTelemetryNotice({ env: f.env })).toBe(true);
    expect(projectConsentBindings(JSON.parse(await readFile(f.config, 'utf8')))).toEqual(projectConsentBindings(config));
  });

  it('uses private permissions for new consent files on POSIX without treating Windows modes as ACL proof', async () => {
    const f = await fixture();
    await approve('enroll', f.project, f.env);
    if (process.platform !== 'win32') {
      expect((await lstat(f.config)).mode & 0o777).toBe(0o600);
      expect((await lstat(recordPath(f.project))).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects generic yes and old notice state as enrollment approval', async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.config), { recursive: true });
    await writeFile(f.config, '{"telemetry":{"noticeVersion":999},"unknown":true}');
    expect(() => parseArgs(['telemetry', 'enroll', '--yes'])).toThrow(/Unknown flag/u);
    const bare = await invoke(['telemetry', 'enroll'], f.project, f.env);
    expect(bare.code).toBe(2);
    await expect(readFile(recordPath(f.project))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await invoke(['telemetry', 'report', '--json'], f.project, f.env)).report.reason).toBe('not-enrolled');
  });

  it('preserves clone/worktree measurement identity only after a separate explicit local binding', async () => {
    const f = await fixture(), enrolled = await approve('enroll', f.project, f.env);
    const clone = path.join(f.root, 'clone');
    await cp(f.project, clone, { recursive: true });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    expect((await invoke(['telemetry', 'report', '--json'], clone, f.env)).report.reason).toBe('local-consent-required');
    expect(fetch).not.toHaveBeenCalled();
    const implicit = await invoke(['telemetry', 'enroll', '--json'], clone, f.env);
    expect(implicit.code).toBe(1); expect(implicit.err).toContain('--preserve-identity');
    const preserved = await approve('enroll', clone, f.env, ['--preserve-identity']);
    expect(preserved.projectId).toBe(enrolled.projectId);
    const explicit = await invoke(['telemetry', 'report', '--json'], clone, f.env);
    expect(explicit.report.status).toBe('delivered'); expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/projects$/u);
    const event = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(isProjectTelemetryEvent(event)).toBe(true);
    expect(event).toEqual({ schemaVersion: 2, event: 'project_observed', projectId: enrolled.projectId,
      cliVersion: '0.12.3', ...projectTelemetryDimensions(JSON.parse(manifest)), source: 'cli' });
    expect(JSON.stringify(event)).not.toContain(f.root);
  });

  it('gives independent fork/copy and monorepo roots deliberately separate random identities', async () => {
    const f = await fixture(), first = await approve('enroll', f.project, f.env);
    const copied = path.join(f.root, 'fork'), nested = path.join(f.project, 'nested');
    await cp(f.project, copied, { recursive: true });
    const fork = await approve('enroll', copied, f.env, ['--new-identity']);
    await mkdir(nested); await writeFile(path.join(nested, 'liftoff.manifest.json'), manifest);
    const independent = await approve('enroll', nested, f.env);
    expect(new Set([first.projectId, fork.projectId, independent.projectId]).size).toBe(3);
    expect(JSON.parse(await readFile(recordPath(f.project), 'utf8')).projectId).toBe(first.projectId);
  });

  it('preserves the tracked measurement ID in an actual local Git clone and worktree only after each checkout approves consent', async () => {
    const f = await fixture(), enrolled = await approve('enroll', f.project, f.env);
    const runner = new NodeCommandRunner(), gitEnv = {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(f.root, 'unused-git-config'),
      GIT_DIR: undefined, GIT_WORK_TREE: undefined
    };
    const git = async (args: string[]) => {
      const result = await runner.run({ executable: 'git', args: ['-c', 'core.fsmonitor=false', ...args] }, {
        cwd: f.project, env: gitEnv, timeoutMs: 5_000, maxOutputBytes: 8192
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.timedOut).toBe(false);
    };
    await git(['init', '--quiet', '--template=']);
    await git(['add', '--', 'liftoff.manifest.json', '.liftoff/telemetry/project.json']);
    await git(['-c', 'user.name=Consent specimen', '-c', 'user.email=consent@specimen.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Share approved measurement identity']);
    const clone = path.join(f.root, 'actual-clone'), worktree = path.join(f.root, 'actual-worktree');
    await git(['clone', '--quiet', '--no-hardlinks', '--', f.project, clone]);
    await git(['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const checkout of [clone, worktree]) {
      expect((await invoke(['telemetry', 'report', '--json'], checkout, f.env)).report.reason).toBe('local-consent-required');
      expect((await approve('enroll', checkout, f.env, ['--preserve-identity'])).projectId).toBe(enrolled.projectId);
      expect((await invoke(['telemetry', 'status', '--json'], checkout, f.env)).report.status).toBe('enabled');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(projectConsentBindings(JSON.parse(await readFile(f.config, 'utf8'))).map(binding => binding.projectId))
      .toEqual([enrolled.projectId, enrolled.projectId, enrolled.projectId]);
  });

  it('invalidates moved checkout review receipts without changing measurement identity', async () => {
    const f = await fixture(), enrolled = await approve('enroll', f.project, f.env);
    const preview = await invoke(['telemetry', 'enroll', '--preserve-identity', '--check', '--json'], f.project, f.env);
    const moved = path.join(f.root, 'moved');
    await rename(f.project, moved);
    const stale = await invoke(['telemetry', 'enroll', '--preserve-identity', '--json', '--approve-plan', preview.report.fingerprint], moved, f.env);
    expect(stale.code).toBe(1); expect(stale.report.status).toBe('mismatch');
    expect((await invoke(['telemetry', 'status', '--json'], moved, f.env)).report.reason).toBe('local-consent-required');
    expect((await approve('enroll', moved, f.env, ['--preserve-identity'])).projectId).toBe(enrolled.projectId);
  });

  it('disables future reporting while retaining the ID, other roots, unknown fields and historical-deletion distinction', async () => {
    const f = await fixture(), enrolled = await approve('enroll', f.project, f.env);
    const other = path.join(f.root, 'other');
    await mkdir(other); await writeFile(path.join(other, 'liftoff.manifest.json'), manifest);
    const independent = await approve('enroll', other, f.env);
    const result = await approve('disable', f.project, f.env);
    expect(result).toMatchObject({ status: 'disabled', projectId: enrolled.projectId });
    expect(projectConsentBindings(JSON.parse(await readFile(f.config, 'utf8')))).toEqual([
      { projectRoot: other, projectId: independent.projectId, disclosureVersion: 1 }
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await invoke(['telemetry', 'report', '--json'], f.project, f.env)).report.reason).toBe('not-enrolled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ DO_NOT_TRACK: '1' }, { LIFTOFF_TELEMETRY: '0' }, { CI: 'true' }])(
    'allows no consent/notice/transport side effects when disabled by %j', async disabled => {
      const f = await fixture(), before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch');
      for (const operation of ['status', 'enroll', 'disable', 'report']) {
        expect((await invoke(['telemetry', operation, '--json'], f.project, { ...f.env, ...disabled })).report.status).toBe('disabled');
      }
      for (const argv of [['telemetry', 'report', '--heartbeat', '--json'], ['telemetry', 'heartbeat', 'enable', '--json']]) {
        expect((await invoke(argv, f.project, { ...f.env, ...disabled })).report.status).toBe('disabled');
      }
      expect(await captureTreeState(f.root)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each(['{broken', '[]', '{"telemetry":false}', '{"telemetry":{"projectConsents":[{}]}}', '{"telemetry":{"noticeVersion":"bad"}}'])(
    'blocks invalid config without overwriting it: %s', async content => {
      const f = await fixture(); await mkdir(path.dirname(f.config), { recursive: true }); await writeFile(f.config, content);
      expect((await invoke(['telemetry', 'enroll', '--json'], f.project, f.env)).code).toBe(1);
      expect(await readFile(f.config, 'utf8')).toBe(content);
      await expect(readFile(recordPath(f.project))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('never echoes malformed manifest, project record or external configuration contents', async () => {
    const f = await fixture(), sensitive = '{"credential":"PRIVATE_TEST_SPECIMEN" malformed}';
    await mkdir(path.dirname(f.config), { recursive: true });
    await writeFile(f.config, sensitive);
    let result = await invoke(['telemetry', 'status', '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.err).toContain('invalid JSON');
    expect(result.out + result.err).not.toContain('PRIVATE_TEST_SPECIMEN');
    await writeFile(f.config, '{}');
    await mkdir(path.dirname(recordPath(f.project)), { recursive: true });
    await writeFile(recordPath(f.project), sensitive);
    result = await invoke(['telemetry', 'status', '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.out + result.err).not.toContain('PRIVATE_TEST_SPECIMEN');
    await rm(recordPath(f.project));
    await writeFile(path.join(f.project, 'liftoff.manifest.json'), sensitive);
    result = await invoke(['telemetry', 'status', '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.out + result.err).not.toContain('PRIVATE_TEST_SPECIMEN');
  });

  it('does not fall through from an explicit non-project root to an outer enrolled project', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const nested = path.join(f.project, 'not-a-project'); await mkdir(nested);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await invoke(['telemetry', 'report', nested, '--json'], f.project, f.env);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ status: 'failed', attempted: false, reason: 'project-or-consent-unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses consent-lock contention without changing either enrollment record or configuration', async () => {
    const f = await fixture(), before = await invoke(['telemetry', 'enroll', '--check', '--json'], f.project, f.env);
    await mkdir(path.dirname(f.config), { recursive: true });
    const lock = path.join(path.dirname(f.config), '.project-consent.lock');
    await writeFile(lock, 'existing owner');
    const state = await captureTreeState(f.root);
    const result = await invoke(['telemetry', 'enroll', '--json', '--approve-plan', before.report.fingerprint], f.project, f.env);
    expect(result.code).toBe(1); expect(result.report.reason).toBe('consent-publication-failed');
    expect(await captureTreeState(f.root)).toEqual(state);
    expect(await readFile(lock, 'utf8')).toBe('existing owner');
  });

  it('blocks read-only config before record/consent writes and blocks delivery with unwritable consent', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    if (process.platform === 'win32') return;
    const original = await readFile(f.config); await chmod(f.config, 0o400);
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await invoke(['telemetry', 'report', '--json'], f.project, f.env)).report.reason).toBe('local-consent-required');
    const preview = await invoke(['telemetry', 'disable', '--check', '--json'], f.project, f.env);
    const applied = await invoke(['telemetry', 'disable', '--json', '--approve-plan', preview.report.fingerprint], f.project, f.env);
    expect(applied.code).toBe(1);
    expect(applied.report.reason).toBe('consent-publication-failed');
    expect(await readFile(f.config)).toEqual(original);
    expect(JSON.parse(await readFile(recordPath(f.project), 'utf8')).enabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); await chmod(f.config, 0o600);
  });

  it('rejects consent storage inside the project, relative config paths and malformed/unsupported records', async () => {
    const f = await fixture();
    expect((await invoke(['telemetry', 'enroll', '--json'], f.project, { XDG_CONFIG_HOME: f.project })).code).toBe(1);
    expect((await invoke(['telemetry', 'enroll', '--json'], f.project, { XDG_CONFIG_HOME: 'relative' })).code).toBe(1);
    await mkdir(path.dirname(recordPath(f.project)), { recursive: true });
    for (const value of [{ schemaVersion: 99 }, { schemaVersion: 1, disclosureVersion: 2, projectId: 'bad', enabled: true }]) {
      await writeFile(recordPath(f.project), JSON.stringify(value));
      expect((await invoke(['telemetry', 'status', '--json'], f.project, f.env)).code).toBe(1);
    }
  });

  it('refuses unsafe record/config aliases without following them', async () => {
    const f = await fixture(), outside = path.join(f.root, 'outside.json');
    await writeFile(outside, '{}');
    await mkdir(path.dirname(recordPath(f.project)), { recursive: true });
    try { await symlink(outside, recordPath(f.project)); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    expect((await invoke(['telemetry', 'enroll', '--json'], f.project, f.env)).code).toBe(1);
    expect(await readFile(outside, 'utf8')).toBe('{}');
  });

  it('rechecks source and config under the lock after visible default-No approval', async () => {
    const f = await fixture(), stdout = new CaptureStream(), stderr = ttyCaptureStream();
    const random = vi.spyOn(storage, 'newProjectTelemetryId');
    const code = await runCli({
      argv: ['telemetry', 'enroll'], cwd: f.project, env: f.env, stdout, stderr, stdin: scriptedTtyInput(''),
      execute: (parsed, context) => runCommand(parsed, { ...context, approveTelemetryPlan: async question => {
        expect(question.default).toBe(false);
        expect(stdout.text()).toContain('pseudonymous');
        await writeFile(path.join(f.project, 'liftoff.manifest.json'), `${manifest} `);
        return true;
      } })
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('Telemetry review changed');
    expect(random).not.toHaveBeenCalled();
    await expect(readFile(recordPath(f.project))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never allows telemetry ID or receipt to authorize ordinary project update', async () => {
    const f = await fixture(), enrolled = await approve('enroll', f.project, f.env);
    expect(() => parseArgs(['update', '--approve-plan', enrolled.projectId])).toThrow(/64/u);
    const review = await invoke(['telemetry', 'disable', '--check', '--json'], f.project, f.env);
    const updated = await invoke(['update', '--approve-plan', review.report.fingerprint, '--json'], f.project, { ...f.env, DO_NOT_TRACK: '1' });
    expect(updated.code).toBe(1);
    expect(JSON.parse(await readFile(recordPath(f.project), 'utf8')).enabled).toBe(true);
  });

  it('returns bounded explicit failures without aggregate recursion or retaining events', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const before = await captureTreeState(f.root);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private transport error'));
    const result = await invoke(['telemetry', 'report', '--json'], f.project, f.env);
    expect(result.code).toBe(1); expect(result.report).toMatchObject({ status: 'failed', reason: 'network', attempted: true });
    expect(result.out + result.err).not.toContain('private transport error');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('dispatches at most one project slot in an existing ordinary-command budget', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const delivery = createTelemetryDelivery({ env: f.env });
    try {
      expect((await reportProjectObservation({ cwd: f.project, env: f.env, delivery })).status).toBe('delivered');
      expect(await reportProjectObservation({ cwd: f.project, env: f.env, delivery })).toMatchObject({ status: 'failed', reason: 'duplicate-channel', attempted: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { delivery.close(); }
  });

  it.each(['reporter', 'cli'] as const)('retains truthful attempted state after a started transport exhausts the one-second deadline through %s', async route => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const before = await captureTreeState(f.root);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let started!: () => void;
    const transportStarted = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      started(); return new Promise<Response>(() => {});
    });
    const start = performance.now();
    let settled = false;
    const result = (route === 'reporter'
      ? reportProjectObservation({ cwd: f.project, env: f.env })
      : invoke(['telemetry', 'report', '--json'], f.project, f.env)
    ).then(value => { settled = true; return value; });
    await transportStarted;
    await vi.advanceTimersByTimeAsync(maximumTelemetryDeliveryMs - 1);
    expect(settled).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const completed = await result;
    const expected = { status: 'failed', reason: 'budget-expired', attempted: true };
    if ('code' in completed) {
      expect(completed.code).toBe(1); expect(completed.report).toMatchObject(expected);
      expect(completed.err).toBe('');
    } else expect(completed).toEqual(expected);
    expect(performance.now() - start).toBe(maximumTelemetryDeliveryMs);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/projects$/u);
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('reports attempted false when collection consumes the shared deadline before any fetch', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let started!: () => void;
    const collectionStarted = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(storage, 'readTelemetryConsentConfig').mockImplementation(() => {
      started(); return new Promise<storage.TelemetryConsentConfig>(() => {});
    });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const start = performance.now(), result = reportProjectObservation({ cwd: f.project, env: f.env });
    await collectionStarted;
    await vi.advanceTimersByTimeAsync(maximumTelemetryDeliveryMs);
    expect(await result).toEqual({ status: 'failed', reason: 'budget-expired', attempted: false });
    expect(performance.now() - start).toBe(maximumTelemetryDeliveryMs);
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps assessment/live/help/capabilities/status telemetry-free in an enrolled checkout', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const before = await captureTreeState(f.root), fetch = vi.spyOn(globalThis, 'fetch');
    for (const argv of [
      ['assess', '--json'], ['assess', '--live', '--json'], ['assess', '--help'], ['help', 'assess'],
      ['governance', 'assess', '--json'], ['governance', 'assess', '--help'],
      ['capabilities', '--json'], ['repair', '--capabilities', '--json'], ['repair', '--inspect-layout', '--json'],
      ['telemetry', 'status', '--json'], ['telemetry', '--help'], ['help', 'telemetry'],
      ['doctor', '--help'], ['help', 'doctor'], ['upgrade', '--help'], ['help', 'upgrade']
    ]) await invoke(argv, f.project, f.env);
    expect(fetch).not.toHaveBeenCalled(); expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('keeps actual owner-aware doctor free of disclosure and both reporting channels in an enrolled checkout', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const upgrade = upgradeWorld(), before = await captureTreeState(f.root);
    const notice = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion');
    const fetch = vi.spyOn(globalThis, 'fetch'), stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCli({
      argv: ['doctor', '--json'], cwd: f.project, env: f.env, stdout, stderr,
      execute: (parsed, context) => runCommand(parsed, {
        ...context,
        runner: { run: async command => ({
          command, displayCommand: 'isolated diagnostic', status: 127, signal: null,
          stdout: '', stderr: '', timedOut: false, processSpawned: false
        }) },
        selfUpgrade: request => runSelfUpgrade({
          ...request, runningPackageRoot: upgrade.request.runningPackageRoot
        }, upgrade.dependencies)
      })
    });
    expect(code).toBe(1);
    expect(JSON.parse(stdout.text()).summary.failures).toBeGreaterThan(0);
    expect(notice).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(upgrade.world.installed).toBe(false);
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('reports actual owner-aware upgrade availability only as one anonymous aggregate without project reporting', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    await recordTelemetryNotice({ env: f.env });
    const upgrade = upgradeWorld(), before = await captureTreeState(f.root);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCli({
      argv: ['upgrade', '--check', '--json'], cwd: f.project, env: f.env, stdout, stderr,
      execute: (parsed, context) => runCommand(parsed, {
        ...context, selfUpgrade: request => runSelfUpgrade({
          ...request, runningPackageRoot: upgrade.request.runningPackageRoot
        }, upgrade.dependencies)
      })
    });
    expect(code).toBe(2);
    expect(JSON.parse(stdout.text())).toMatchObject({
      schemaVersion: 2, installationOwner: 'npm', status: 'update-available', effects: 'none'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/events$/u);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      schemaVersion: 2, event: 'command_executed', command: 'upgrade',
      cliVersion: '0.12.3', outcome: 'attention-required'
    });
    expect(upgrade.world.installed).toBe(false);
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('bounds ordinary reporting to the same command deadline without changing ordinary output or exit', async () => {
    const f = await fixture(); await approve('enroll', f.project, f.env);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await runCli({ argv: ['update', '--check', '--json'], cwd: f.project, env: f.env, stdout, stderr,
      execute: async (_parsed, context) => { context.outcome?.record('attention-required'); stdout.write('{"ordinary":true}\n'); return 2; } });
    expect(code).toBe(2); expect(stdout.text()).toBe('{"ordinary":true}\n');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/api\/events$/u), expect.stringMatching(/\/api\/projects$/u)
    ]));
    expect(fetch.mock.calls[0][1]?.signal).toBe(fetch.mock.calls[1][1]?.signal);
  });

  it.each([
    ['telemetry'], ['telemetry', 'status', '--check'], ['telemetry', 'report', '--approve-plan', 'a'.repeat(64)],
    ['telemetry', 'enroll', '--preserve-identity', '--new-identity'], ['telemetry', 'disable', '--new-identity'],
    ['telemetry', 'enroll', '--approve-plan', 'bad'], ['telemetry', 'enroll', '--check', '--approve-plan', 'a'.repeat(64)],
    ['telemetry', 'status', '--heartbeat'], ['telemetry', 'enroll', '--repository', '.'],
    ['telemetry', 'status', '.', '--project', '.'], ['telemetry', 'heartbeat', 'invalid'],
    ['telemetry', 'heartbeat', 'status', '--check'], ['telemetry', 'heartbeat', 'status', '--approve-plan', 'a'.repeat(64)],
    ['telemetry', 'heartbeat', 'status', '.', '--project', '.']
  ])('rejects invalid authority before project access: %j', argv => { expect(() => parseArgs(argv)).toThrow(); });
});
