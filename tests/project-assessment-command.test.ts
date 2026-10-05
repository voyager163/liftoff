import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { installedCapabilities } from '../src/application/capabilities.js';
import { canonicalTelemetryCommand, isTelemetryExcludedCommand } from '../src/telemetry/contract.js';
import * as telemetryConfig from '../src/telemetry/config.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'liftoff-assess-command-'));
  roots.push(root);
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { fastify: '^5.12.5' },
    scripts: { install: 'throw MUST_NOT_EXECUTE', test: 'throw MUST_NOT_EXECUTE' } }));
  return root;
}
async function invoke(argv: string[], cwd: string, telemetry?: CliTelemetryHooks) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await runCli({ argv, cwd, stdout, stderr, env: {}, telemetry });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('actual public read-only project assessment route', () => {
  it('emits one deterministic schema-1 JSON report without hooks, scripts, network or disclosure', async () => {
    const root = await fixture();
    const before = await readFile(path.join(root, 'package.json'));
    const runner = vi.spyOn(NodeCommandRunner.prototype, 'run').mockRejectedValue(new Error('Unexpected subprocess'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const read = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockRejectedValue(new Error('Unexpected notice'));
    const write = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockRejectedValue(new Error('Unexpected notice write'));
    const hooks: CliTelemetryHooks = {
      beforeCommand: vi.fn().mockResolvedValue(true), afterCommand: vi.fn().mockResolvedValue(undefined),
      afterSemanticCommand: vi.fn().mockResolvedValue(undefined)
    };
    const result = await invoke(['assess', root, '--json'], root, hooks);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-project-assessment', command: 'assess', readOnly: true,
      mode: 'local', outcome: 'partial', exitCode: 2,
      project: { root, kind: 'git', manifestVersion: null, recordedProfile: null },
      target: { profile: 'single-maintainer-gitflow', profileSelection: 'default' }
    });
    expect((await invoke(['assess', '--project', root, '--json'], root, hooks)).stdout).toBe(result.stdout);
    expect(report.findings.some((finding: { id: string; classification: string }) =>
      finding.id === 'project.manifest' && finding.classification === 'missing')).toBe(true);
    expect(result.stdout).not.toContain('MUST_NOT_EXECUTE');
    expect(await readFile(path.join(root, 'package.json'))).toEqual(before);
    for (const spy of [runner, fetch, read, write, hooks.beforeCommand, hooks.afterCommand, hooks.afterSemanticCommand]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
  it.each([['assess', '--help'], ['assess', '--help', '--json'], ['help', 'assess']])(
    'keeps %j available without a project and without telemetry', async (...argv) => {
      const hooks: CliTelemetryHooks = { beforeCommand: vi.fn().mockResolvedValue(true), afterCommand: vi.fn().mockResolvedValue(undefined) };
      const result = await invoke(argv, path.join(process.cwd(), 'package.json', 'missing'), hooks);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toContain('liftoff assess');
      expect(result.stdout).toContain('comparison');
      expect(hooks.beforeCommand).not.toHaveBeenCalled();
      expect(hooks.afterCommand).not.toHaveBeenCalled();
      expect(isTelemetryExcludedCommand(parseArgs(argv))).toBe(true);
      expect(canonicalTelemetryCommand(parseArgs(argv))).toBeUndefined();
    }
  );
  it('returns explicit JSON errors for conflicting paths, invalid profiles and unavailable live scope', async () => {
    const root = await fixture();
    for (const argv of [
      ['assess', root, '--project', root, '--json'],
      ['assess', root, '--governance', 'unsupported', '--json'],
      ['assess', root, '--live', '--json']
    ]) {
      const result = await invoke(argv, root);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ readOnly: true, outcome: 'error', exitCode: 1 });
    }
  });
  it('renders the same uncertainty and no-write contract for ordinary CLI-only users', async () => {
    const root = await fixture();
    const result = await invoke(['assess', root, '--governance', 'none'], root);
    expect(result.code).toBe(2);
    expect(result.stdout.toLowerCase()).toContain('assess');
    expect(result.stdout.toLowerCase()).toContain('partial');
    expect(result.stdout).toContain('No changes made');
    expect(result.stderr).toBe('');
  });
  it('binds every available recommendation to the selected project rather than the caller working directory', async () => {
    const baseline = await readFile(new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url));
    const root = await fixture();
    await writeFile(path.join(root, 'liftoff.manifest.json'), baseline);
    const result = await invoke(['assess', '--project', root, '--json'], path.dirname(root));
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as { findings: { remediation: { available: boolean; previewCommand: string[] | null } }[] };
    const recommendations = report.findings.filter(finding => finding.remediation.available);
    expect(recommendations.length).toBeGreaterThan(0);
    for (const { remediation } of recommendations) {
      expect(remediation.previewCommand).toEqual(['liftoff', 'update', '--project', root, '--check']);
      expect(parseArgs(remediation.previewCommand!.slice(1)).flags.project).toBe(root);
    }
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(baseline);
  });
  it.each([['assess', '--yes'], ['assess', '--force'], ['assess', '--approve-plan', 'a'.repeat(64)]])(
    'rejects unsupported authority %j before hooks or discovery', async (...argv) => {
      const hooks: CliTelemetryHooks = { beforeCommand: vi.fn().mockResolvedValue(true), afterCommand: vi.fn().mockResolvedValue(undefined) };
      const result = await invoke(argv, process.cwd(), hooks);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(hooks.beforeCommand).not.toHaveBeenCalled();
    }
  );
  it('advertises only the actual bounded local producer and preserves separate governance assessment', () => {
    const capabilities = installedCapabilities();
    expect(capabilities.schemas.projectAssessment).toMatchObject({
      command: 'assess', report: 1, modes: ['local'], readOnly: true,
      liveMetadata: false, projectExecution: false, projectWrites: false, telemetry: false
    });
    expect(capabilities.schemas.reports.governanceAssessment).toBe(1);
    expect(capabilities.boundaries.publicStatefulMigration).toBe(false);
    expect(capabilities.profiles.map(profile => profile.id)).toEqual(['single-maintainer-gitflow', 'none']);
  });
});
