import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import * as historical from '../src/application/governance/inspection.js';
import * as inputs from '../src/adapters/filesystem/governance-records.js';
import * as plans from '../src/governance-activation/public-plans.js';
import * as installed from '../src/application/governance/modern-installed-preflight.js';
import * as publication from '../src/application/governance/modern-local-publication.js';
import * as revalidation from '../src/application/update/modern-revalidation-publication.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { writeModernInstalledProject, writeModernSuccessor } from './fixtures/modern-installed-project.js';
import { originalFiles } from './modern-openspec-fixtures.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import { workflowByteDigest } from '../src/governance-activation/workflow-binding.js';

const roots: { path: string; dev: number; ino: number }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of roots.splice(0)) {
    const current = await fs.lstat(owner.path);
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    expect([current.dev, current.ino]).toEqual([owner.dev, owner.ino]);
    await fs.rm(owner.path, { recursive: true });
  }
});
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modern-governance-')));
  const stat = await fs.lstat(root);
  roots.push({ path: root, dev: stat.dev, ino: stat.ino });
  return root;
}
async function invoke(root: string, args: string[], jsonMode = true) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner();
  const code = await runCommand(parseArgs(['governance', ...args, ...(jsonMode ? ['--json'] : [])]), {
    cwd: root, stdout, stderr, runner
  });
  expect(runner.calls).toEqual([]);
  return { code, stdout: stdout.text(), stderr: stderr.text(), report: jsonMode && stdout.text() ? JSON.parse(stdout.text()) : null };
}

function workflowReviewRequest() {
  const content = 'name: Isolated reviewed source\non: workflow_dispatch\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --check backend/application.js\n';
  const createdAt = new Date();
  return {
    schemaVersion: 1, kind: 'review-workflow-source5', phaseId: 'bootstrap-workflow-source-ready',
    executionId: randomUUID(), createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1000).toISOString(),
    configuration: { schemaVersion: 1, phases: {}, budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } },
    origin: null, remainingFrom: null,
    effects: [{ action: 'git.workflow-source.publish-reviewed', binding: {
      repository: 'owner/repo', repositoryId: 123, ref: 'ci/liftoff-workflows-public-review',
      parentSha: 'a'.repeat(40), sourceTransmissionApproved: true,
      files: [{ path: '.github/workflows/review.yml', content, digest: workflowByteDigest(content), beforeDigest: null }]
    } }]
  };
}

describe('modern public governance inspection', () => {
  it.each(['single-maintainer-gitflow', 'team-gitflow'] as const)(
    'offers %s exact workflow review values, not approval, current prerequisites or execution', async profile => {
      const f = await writeModernInstalledProject(await directory(), 'manual', profile);
      await f.write(['governance', 'activation-state.json'], canonicalJson(f.state));
      const inputFile = path.join(await directory(), 'workflow-review.json');
      await fs.writeFile(inputFile, canonicalJson(workflowReviewRequest()));
      const before = await originalFiles(f.root), old = vi.spyOn(historical, 'inspectGovernance');
      const load = vi.spyOn(plans, 'loadGovernancePreview'), save = vi.spyOn(plans, 'saveGovernancePreview');
      const result = await invoke(f.root, ['plan', '--scope', 'activation', '--inputs', inputFile]);
      expect(result.code, result.stderr).toBe(2);
      expect(result.report).toMatchObject({
        schemaVersion: 1, kind: 'liftoff-modern-workflow-review', status: 'blocked', readOnly: true,
        projectWrites: false, externalMetadataWrites: false, providerWrites: false, workloadExecution: false,
        activationComplete: false, phaseComplete: false, matrixComplete: false, executionAuthorized: false,
        recordedProgressIsCurrentProof: false,
        review: { execution: 'not-authorized', prerequisites: { status: 'not-observed' },
          plan: { identity: { profile }, approval: { required: true, envelopeId: null } } }
      });
      expect(result.report.blockers.map((blocker: { code: string }) => blocker.code))
        .toContain('workflow-current-prerequisite-observer-unavailable');
      expect(Date.parse(result.report.observations.beforeObservedAt)).toBeGreaterThanOrEqual(Date.parse(result.report.observations.startedAt));
      expect(Date.parse(result.report.observations.afterObservedAt)).toBeLessThanOrEqual(Date.parse(result.report.observations.endedAt));
      expect(old).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
      expect(await originalFiles(f.root)).toEqual(before);
    });

  it.each(['execute', 'plan', 'protected-stdin', 'recover-phase', 'revalidation-publication'] as const)(
    'refuses workflow review with --%s before reading an input file', async flag => {
      const f = await writeModernInstalledProject(await directory());
      const read = vi.spyOn(inputs, 'readPublicGovernanceInputs');
      const extra = flag === 'execute' || flag === 'protected-stdin' ? [`--${flag}`] :
        [`--${flag}`, flag === 'recover-phase' ? 'dev-proof' : 'a'.repeat(64)];
      const args = ['plan', '--scope', 'activation', '--inputs', 'must-not-be-read.json', ...extra];
      if (flag === 'recover-phase') {
        const result = await invoke(f.root, args);
        expect(result.code).toBe(1);
        expect(result.report.diagnostics.join(' ')).toContain('without approval, execution or recovery');
      } else {
        expect(() => parseArgs(['governance', ...args, '--json'])).toThrow(`Flag --${flag}`);
      }
      expect(read).not.toHaveBeenCalled();
    });

  it('does not turn a fresh project into an existing anchor or source publication plan', async () => {
    const f = await writeModernInstalledProject(await directory());
    const inputFile = path.join(await directory(), 'workflow-review.json');
    await fs.writeFile(inputFile, canonicalJson(workflowReviewRequest()));
    const before = await originalFiles(f.root);
    const result = await invoke(f.root, ['plan', '--scope', 'activation', '--inputs', inputFile]);
    expect(result.code).toBe(1);
    expect(result.report.diagnostics.join(' ')).toContain('complete exact current installed snapshot');
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('refuses physical installed-state replacement between the two actual observations', async () => {
    const f = await writeModernInstalledProject(await directory());
    await f.write(['governance', 'activation-state.json'], canonicalJson(f.state));
    const inputFile = path.join(await directory(), 'workflow-review.json');
    await fs.writeFile(inputFile, canonicalJson(workflowReviewRequest()));
    const original = installed.inspectModernInstalledActivation;
    let observations = 0;
    vi.spyOn(installed, 'inspectModernInstalledActivation').mockImplementation(async root => {
      if (++observations === 2) {
        const target = path.join(root, 'governance', 'activation-state.json'), replacement = `${target}.replacement`;
        await fs.writeFile(replacement, await fs.readFile(target));
        await fs.rename(replacement, target);
      }
      return original(root);
    });
    const result = await invoke(f.root, ['plan', '--scope', 'activation', '--inputs', inputFile]);
    expect(result.code).toBe(1);
    expect(result.report.diagnostics.join(' ')).toContain('physical file identities changed');
    expect(observations).toBe(2);
  });

  it.each(['manual', 'openspec', 'spec-kit'] as const)(
    'keeps %s source inspection out of historical graphs and does not manufacture local proof', async workflow => {
      const f = await writeModernInstalledProject(await directory(), workflow);
      const before = await originalFiles(f.root), old = vi.spyOn(historical, 'inspectGovernance');
      for (const command of ['status', 'resume', 'verify']) {
        const result = await invoke(f.root, [command, '--scope', 'local']);
        expect(result.code, result.stderr).toBe(command === 'verify' ? 2 : 0);
        expect(result.report).toMatchObject({
          schemaVersion: 3, readOnly: true, consistent: true, complete: false, outcome: 'incomplete',
          source: { status: 'observed', classification: 'fresh' },
          localComplete: false, workloadExecution: false, projectWrites: false, providerWrites: false,
          publication: { status: 'absent', committed: false }, recordedProgressIsCurrentProof: false
        });
        expect(result.stderr).toBe('');
      }
      expect(old).not.toHaveBeenCalled();
      expect(await originalFiles(f.root)).toEqual(before);
    }
  );

  it.each(['none', 'single-maintainer-gitflow', 'team-gitflow'] as const)(
    'keeps selected scopes distinct for %s', async profile => {
      const f = await writeModernInstalledProject(await directory(), 'manual', profile);
      for (const scope of ['local', 'activation', 'lifecycle']) {
        const result = await invoke(f.root, ['verify', '--scope', scope]);
        const complete = profile === 'none' && scope !== 'local';
        expect(result.code).toBe(complete ? 0 : 2);
        expect(result.report).toMatchObject({ scope, complete, localComplete: false, activationComplete: false, lifecycleComplete: false });
      }
    }
  );

  it('reports stored modern phases without treating them as freshly verified progress', async () => {
    const f = await writeModernInstalledProject(await directory());
    await f.write(['governance', 'activation-state.json'], canonicalJson(f.state));
    const before = await originalFiles(f.root), result = await invoke(f.root, ['status', '--scope', 'local']);
    expect(result.code).toBe(0);
    expect(result.report.source.classification).toBe('current');
    expect(result.report.recordedPhases.length).toBeGreaterThan(0);
    expect(result.report.recordedPhases.every((phase: { state: string }) => phase.state === 'pending')).toBe(true);
    expect(result.report.localComplete).toBe(false);
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it.each([
    ['plan'], ['approve', '--plan', 'a'.repeat(64)], ['apply-next', '--execute'],
    ['credential-enroll', '--plan', 'a'.repeat(64)], ['recover', '--plan', 'a'.repeat(64), '--execute']
  ].map(args => ({ args })))('rejects unqualified modern operation $args before historical authority reads', async ({ args }) => {
    const f = await writeModernInstalledProject(await directory()), before = await originalFiles(f.root);
    const load = vi.spyOn(plans, 'loadGovernancePreview'), inspect = vi.spyOn(historical, 'inspectGovernance');
    const result = await invoke(f.root, args);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ schemaVersion: 3, consistent: false, complete: null, outcome: 'invalid' });
    expect(result.report.diagnostics.join(' ')).toContain('inspection only');
    expect(result.report.diagnostics.join(' ')).toContain('read-only workflow review via plan --scope activation --inputs');
    expect(load).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it.each(['status', 'resume', 'verify'])('rejects %s activation inputs without reading the named file', async command => {
    const f = await writeModernInstalledProject(await directory()), before = await originalFiles(f.root);
    const read = vi.spyOn(inputs, 'readPublicActivationInputs');
    const result = await invoke(f.root, [command, '--inputs', 'must-not-be-read.json']);
    expect(result.code).toBe(1);
    expect(result.report.diagnostics.join(' ')).toContain('accepts no activation inputs');
    expect(read).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('refuses a successor publication selector on a fresh project before reading its store', async () => {
    const f = await writeModernInstalledProject(await directory()), read = vi.spyOn(revalidation, 'inspectModernSuccessorRevalidationPublication');
    const result = await invoke(f.root, ['verify', '--revalidation-publication', 'b'.repeat(64)]);
    expect(result.code).toBe(1);
    expect(result.report.diagnostics.join(' ')).toContain('activation-history successor');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not discover successor publication authority from matching installed progress', async () => {
    const f = await writeModernSuccessor(await directory(), 3), before = await originalFiles(f.root);
    const read = vi.spyOn(revalidation, 'inspectModernSuccessorRevalidationPublication');
    const fresh = vi.spyOn(publication, 'inspectModernLocalCompletion');
    const result = await invoke(f.root, ['verify', '--scope', 'local']);
    expect(result.code, result.stderr).toBe(2);
    expect(result.report).toMatchObject({
      source: { classification: 'successor' }, publication: null, localVerification: 'not-observed', complete: false
    });
    expect(result.report.blockers.join(' ')).toContain('--revalidation-publication');
    expect(read).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('routes only the exact selected successor publication and surfaces missing authority', async () => {
    const f = await writeModernSuccessor(await directory(), 3), before = await originalFiles(f.root);
    const read = vi.spyOn(revalidation, 'inspectModernSuccessorRevalidationPublication');
    const result = await invoke(f.root, ['verify', '--scope', 'local', '--revalidation-publication', 'c'.repeat(64)]);
    expect(result.code).toBe(1);
    expect(read).toHaveBeenCalledExactlyOnceWith(f.root, 'c'.repeat(64));
    expect(result.report).toMatchObject({ complete: null, outcome: 'invalid' });
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('refuses damaged core before consulting local completion proof', async () => {
    const f = await writeModernInstalledProject(await directory());
    await fs.unlink(path.join(f.root, ...f.manifest.managedArtifacts[0].pathParts));
    const before = await originalFiles(f.root), read = vi.spyOn(publication, 'inspectModernLocalCompletion');
    const result = await invoke(f.root, ['verify', '--scope', 'local']);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ consistent: false, complete: null, source: { status: 'blocked' } });
    expect(read).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('rejects a source change between family selection and bounded capture', async () => {
    const f = await writeModernInstalledProject(await directory()), inspect = installed.inspectModernInstalledActivation;
    vi.spyOn(installed, 'inspectModernInstalledActivation').mockImplementation(async root => {
      await f.write(['liftoff.manifest.json'], canonicalJson({ ...f.manifest, liftoffVersion: '0.14.0' }));
      return inspect(root);
    });
    const result = await invoke(f.root, ['verify']);
    expect(result.code).toBe(1);
    expect(result.report.blockers.join(' ')).toContain('differs from the selected modern project');
  });

  it('does not turn a malformed native receipt into absent proof or successful status', async () => {
    const f = await writeModernInstalledProject(await directory());
    await f.write(['.liftoff', 'local-completion.json'], '{}\n');
    const before = await originalFiles(f.root), result = await invoke(f.root, ['status', '--scope', 'local']);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ consistent: false, complete: null, outcome: 'invalid' });
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('retains blocked transaction attribution instead of proceeding to installed interpretation', async () => {
    const f = await writeModernInstalledProject(await directory());
    await f.write(['.liftoff', 'local-verification-transaction.json'], '{}\n');
    const before = await originalFiles(f.root), read = vi.spyOn(installed, 'inspectModernInstalledActivation');
    const result = await invoke(f.root, ['status']);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ complete: null, consistent: false, transaction: { status: 'blocked' } });
    expect(read).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });

  it('detects source changes while local publication is being inspected', async () => {
    const f = await writeModernInstalledProject(await directory()), inspect = publication.inspectModernLocalCompletion;
    vi.spyOn(publication, 'inspectModernLocalCompletion').mockImplementation(async root => {
      const result = await inspect(root);
      await f.write(['liftoff.manifest.json'], canonicalJson({ ...f.manifest, liftoffVersion: '0.14.0' }));
      return result;
    });
    const result = await invoke(f.root, ['verify', '--scope', 'local']);
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ consistent: false, complete: null, publication: { status: 'absent' } });
    expect(result.report.blockers.join(' ')).toContain('changed during publication inspection');
  });

  it('prints incomplete human output without running or offering historical phases', async () => {
    const f = await writeModernInstalledProject(await directory());
    const result = await invoke(f.root, ['verify', '--scope', 'local'], false);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('incomplete');
    expect(result.stdout).toContain('Recorded phases are not current proof');
    expect(result.stdout).not.toContain('apply-next --execute');
  });

  it.each([
    ['status', '--revalidation-publication', 'short'],
    ['verify', '--revalidation-publication', 'A'.repeat(64)],
    ['plan', '--revalidation-publication', 'a'.repeat(64)],
    ['assess', '--revalidation-publication', 'a'.repeat(64)],
    ['recover', '--revalidation-publication', 'a'.repeat(64)]
  ].map(args => ({ args })))('rejects invalid publication syntax before project access: $args', ({ args }) => {
    expect(() => parseArgs(['governance', ...args])).toThrow(/revalidation-publication/);
  });
});
