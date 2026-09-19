import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { formatUpdateCommand } from '../src/application/update/command-guidance.js';
import { validateManifestActivationForExecution } from '../src/domain/governance/activation/validators.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { captureTreeState } from '../src/init-filesystem.js';
import { assessGovernance } from '../src/governance-assessment/engine.js';
import { inspectAssessmentProject } from '../src/governance-assessment/project.js';
import { AssessmentFiles } from '../src/governance-assessment/readers.js';
import * as currentEvidence from '../src/governance-activation/read-only.js';
import * as migrationHistory from '../src/governance-activation/migration-history.js';
import * as live from '../src/governance-assessment/live.js';
import type { CommandRunner } from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const cases = [
  { file: 'manifest-v5-governed-released.json', version: 5, policy: '1', writer: '0.8.0' },
  { file: 'manifest-v6-governed-released.json', version: 6, policy: '5', writer: '0.9.9' }
] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(file: typeof cases[number]['file']) {
  const root = path.resolve('tests', `.static-handoff-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { mode: 0o700 });
  const bytes = await readFile(path.resolve('tests/fixtures', file));
  const index = JSON.parse(await readFile(path.resolve('tests/fixtures/manifest-history-index.json'), 'utf8')) as {
    implementationBaseline: { commit: string };
    entries: Array<{ path: string; sha256: string }>;
  };
  expect(index.implementationBaseline.commit).toBe('70d10881b46d873118d825735696f39b6d35ebe0');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(index.entries.find((entry) => entry.path === file)?.sha256);
  await writeFile(path.join(root, 'liftoff.manifest.json'), bytes);
  const manifest = parseManifest(JSON.parse(bytes.toString('utf8')));
  const runner: CommandRunner = { run: vi.fn(async () => { throw new Error('Static handoff assessment cannot invoke a process or provider.'); }) };
  return { root, bytes, manifest, runner };
}

describe('released policy-only governance handoffs', () => {
  it('retains governance opt-out but rejects a spliced policy/current-identity combination', () => {
    expect(() => validateManifestActivationForExecution({ governance: { profile: 'none', state: 'disabled' } })).not.toThrow();
    expect(() => validateManifestActivationForExecution({ governance: {
      profile: 'single-maintainer-gitflow', state: 'handoff-generated', policyVersion: '5',
      activationIdentity: currentActivationIdentity
    } })).toThrow(/policyVersion does not match/);
  });

  it.each(cases)('reads manifest $version without granting current activation execution', async ({ file, version, policy, writer }) => {
    const f = await fixture(file);
    const before = await captureTreeState(f.root);
    expect(f.manifest).toMatchObject({
      artifactVersion: version, liftoffVersion: writer,
      governance: { profile: 'single-maintainer-gitflow', policyVersion: policy }
    });
    expect(f.manifest.governance).not.toHaveProperty('activationIdentity');
    expect(f.manifest.managedArtifacts.filter((entry) => entry.category === 'governance').map((entry) => entry.logicalName).sort()).toEqual([
      'repository-governance-context', 'repository-governance-copilot-launcher',
      'repository-governance-guide', 'repository-governance-policy'
    ]);
    expect(() => validateManifestActivationForExecution(f.manifest)).toThrow(/no recorded activation identity/);
    await expect(currentEvidence.inspectCurrentActivationEvidence(f.root, f.manifest, { runner: f.runner }))
      .rejects.toThrow(/no recorded activation identity/);
    expect(await migrationHistory.planActivationHistoryMigration(f.root)).toEqual({ status: 'not-present' });
    expect(await captureTreeState(f.root)).toEqual(before);
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it.each(cases)('assesses manifest $version as a readable handoff, not fabricated activation history', async ({ file, version, policy, writer }) => {
    const f = await fixture(file);
    const before = await captureTreeState(f.root);
    const current = vi.spyOn(currentEvidence, 'inspectCurrentActivationEvidence');
    const migration = vi.spyOn(migrationHistory, 'planActivationHistoryMigration');
    const provider = vi.spyOn(live, 'collectLiveAssessment');
    const project = await inspectAssessmentProject(new AssessmentFiles(f.root));
    expect(project).toMatchObject({
      identity: { availability: 'unsupported', stateSource: 'unsupported', recordedActivationIdentity: null },
      state: null, stateIdentity: null, evidence: [], approvals: [], plans: []
    });
    expect(project.historicalActivation).toBeUndefined();
    for (const liveMode of [false, true]) {
      const report = await assessGovernance(f.root, { runner: f.runner, live: liveMode });
      expect(report, JSON.stringify(report.diagnostics)).toMatchObject({
        readOnly: true, outcome: 'partial', exitCode: 2,
        projectIdentity: {
          availability: 'unsupported', manifestVersion: version, policyVersion: policy,
          cliVersion: writer, recordedActivationIdentity: null, stateSource: 'unsupported'
        },
        snapshot: { repository: null, inputsStable: true }
      });
      const handoff = report.diagnostics.find((entry) => entry.code === 'activation-identity-unrecorded');
      expect(handoff?.message).toContain(formatUpdateCommand(f.root, 'check'));
      expect(report.diagnostics.some((entry) =>
        ['activation-history-diagnostic-only', 'activation-migration-eligible', 'activation-migration-blocked'].includes(entry.code)
      )).toBe(false);
      expect(report.findings.find((entry) => entry.controlId === 'evidence.governance')?.classification).toBe('not-observed');
    }
    expect(current).not.toHaveBeenCalled();
    expect(migration).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({
      repository: null, refs: [], runner: null, azure: []
    }), expect.any(Object));
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(await captureTreeState(f.root)).toEqual(before);
    expect(await readFile(path.join(f.root, 'liftoff.manifest.json'))).toEqual(f.bytes);
  });

  it('keeps public assessment read-only and preserves unversioned records without promoting them', async () => {
    const f = await fixture('manifest-v6-governed-released.json');
    await mkdir(path.join(f.root, 'governance', 'approvals'), { recursive: true });
    await writeFile(path.join(f.root, 'governance', 'activation-state.json'), '{"unversioned":"not current activation evidence"}\n');
    await writeFile(path.join(f.root, 'governance', 'approvals', 'unversioned.json'), '{"unversioned":"not execution authority"}\n');
    const before = await captureTreeState(f.root);
    const stdout = new CaptureStream();
    const code = await runCommand(parseArgs(['governance', 'assess', '--json']), {
      cwd: f.root, stdout, stderr: new CaptureStream(), runner: f.runner,
      env: { LIFTOFF_TELEMETRY_DISABLED: '1' }
    });
    const report = JSON.parse(stdout.text());
    expect(code, stdout.text()).toBe(2);
    expect(report.projectIdentity.recordedActivationIdentity).toBeNull();
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'activation-identity-unrecorded' }));
    expect(report.diagnostics.some((entry: { code: string }) => entry.code === 'unsupported-approval')).toBe(false);
    expect(await captureTreeState(f.root)).toEqual(before);
    expect(f.runner.run).not.toHaveBeenCalled();
  });
});
