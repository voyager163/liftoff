import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { applyModernSuccessorUpdate, previewModernSuccessorUpdate } from '../src/application/update/use-case.js';
import { buildModernManagedCore } from '../src/application/project/modern-managed-core.js';
import { renderProjectAssessmentIntegration } from '../src/generators/governance/integrations.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { projectMutationLockPath } from '../src/adapters/filesystem/project-lock.js';
import { inspectModernSuccessorUpdate } from '../src/application/update/inspection.js';
import { planManagedCoreWrites } from '../src/application/update/write-plan.js';
import type { SemanticTelemetryEvent } from '../src/telemetry/contract.js';
import {
  reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { CaptureStream, ttyCaptureStream } from './helpers.js';
import { approval, fixture, freshManifestFixture, inventory, now, write } from './fixtures/manifest-update.js';
import { cleanupUpdateTestRoots, createReviewedUpdateFixture, updateTestPreviewOptions } from './reviewed-update-helpers.js';
import { writeModernHistoricalSource, writeModernSuccessor, writePriorRepairOriginalTarget } from './fixtures/modern-installed-project.js';

afterEach(cleanupUpdateTestRoots);
afterEach(() => { vi.restoreAllMocks(); });

async function invoke(
  project: Pick<Awaited<ReturnType<typeof fixture>>, 'root' | 'options'>, argv: string[],
  options: { cwd?: string; confirm?: () => Promise<boolean> } = {}
) {
  const stdout = new CaptureStream(), stderr = options.confirm ? ttyCaptureStream() : new CaptureStream();
  const events: SemanticTelemetryEvent[] = [];
  const prompt = approval(options.confirm);
  const code = await runCli({
    argv: ['update', ...argv, '--json'], cwd: options.cwd ?? project.root, env: {},
    stdout, stderr, stdin: prompt.stdin,
    telemetry: {
      beforeCommand: async () => true, afterCommand: async () => {},
      afterSemanticCommand: async event => { events.push(event); }
    },
    execute: (parsed, context) => runCommand(parsed, {
      ...context, updatePreview: project.options, approveUpdatePlan: prompt.approveUpdatePlan,
      runner: { run: async () => { throw new Error('Current core update must not dispatch framework, application or provider commands.'); } }
    })
  });
  return { code, report: JSON.parse(stdout.text()), stderr: stderr.text(), outcome: events[0]?.outcome };
}

describe('public current-v8 project update', () => {
  it.each([1, 2, 3] as const)('publishes a historical activation-%s successor without reusing old proof', async version => {
    const project = await fixture();
    await writeModernHistoricalSource(project.root, version);
    const before = await inventory(project.root);
    expect(before['.github/prompts/liftoff-assess.prompt.md']).toBeUndefined();
    const preview = await invoke(project, ['--check']);
    expect(preview).toMatchObject({ code: 2, report: { scope: 'history-core-state-manifest-publication-only' } });
    const result = await invoke(project, ['--approve-plan', preview.report.plans[0].fingerprint]);
    expect(result).toMatchObject({ code: 2, outcome: 'attention-required', report: {
      status: 'committed-incomplete', publicationCommitted: true, localComplete: false
    } });
    const state = JSON.parse(await fs.readFile(path.join(project.root, 'governance', 'activation-state.json'), 'utf8'));
    expect(state.schemaVersion).toBe(4);
    const after = await inventory(project.root);
    expect(Object.entries(after).some(([name, file]) => name.startsWith('governance/history/') &&
      file.digest === before['governance/activation-state.json'].digest)).toBe(true);
    expect(after['application.txt']).toEqual(before['application.txt']);
    expect(after['package.json']).toEqual(before['package.json']);
    expect(await fs.readFile(path.join(project.root, '.github', 'prompts', 'liftoff-assess.prompt.md'), 'utf8'))
      .toBe(renderProjectAssessmentIntegration('github-copilot'));
  });

  it.each([1, 2, 3] as const)('maintains an active successor of family %s without retagging its original transition', async version => {
    const project = await fixture(), source = await writeModernSuccessor(project.root, version);
    await writePriorRepairOriginalTarget(source, 'Previously recorded core.\r\n');
    const before = await inventory(project.root);
    const preview = await invoke(project, ['--check']);
    expect(preview).toMatchObject({ code: 2, report: { scope: 'active-core-manifest-maintenance-only' } });
    expect(await invoke(project, ['--approve-plan', preview.report.plans[0].fingerprint])).toMatchObject({ code: 2, report: {
      status: 'committed-incomplete', publicationCommitted: true, localComplete: false
    } });
    const after = await inventory(project.root);
    for (const [name, bytes] of Object.entries(before).filter(([name]) => name.startsWith('governance/history/') ||
      name === 'governance/activation-state.json' || name === 'governance/migration-state.json')) {
      expect(after[name], name).toEqual(bytes);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.activationTargetHistory).toBeDefined();
  });
  it('previews the complete current v7 generator output rather than only manifest specimens', async () => {
    const root = await createReviewedUpdateFixture({
      projectName: 'Current generated source', projectType: 'standard', apiStack: 'go', cloud: 'azure',
      region: 'eastus', environments: ['dev'], specWorkflow: 'openspec', includeFrontend: false
    });
    const project = { root, options: updateTestPreviewOptions(root) };
    const inspection = await inspectModernSuccessorUpdate(root, { kind: 'recorded-project-intent' });
    const force = planManagedCoreWrites(inspection.entries, inspection.oldByName, true);
    const preview = await invoke(project, ['--check']);
    expect(preview.code, JSON.stringify({ report: preview.report, skipped: force.skipped }, null, 2)).toBe(2);
  });
  it.each(['0.3.4', '0.4.1', '0.7.0', '0.8.0', '0.9.9', '0.10.0', '0.11.3', '0.12.3'])(
    'publishes the approved %s successor while preserving original bytes and noncompletion', async version => {
      const project = await fixture(version), before = await inventory(project.root);
      const preview = await invoke(project, ['--check']);
      expect(preview).toMatchObject({ code: 2, outcome: 'attention-required', stderr: '', report: {
        schemaVersion: 4, kind: 'liftoff-current-project-update', status: 'update-available', targetManifestVersion: 8,
        publicationCommitted: false, projectFileEffectsUncertain: false, localComplete: false, executionRequested: false
      } });
      expect(await inventory(project.root)).toEqual(before);
      const result = await invoke(project, ['--approve-plan', preview.report.plans[0].fingerprint]);
      expect(result).toMatchObject({ code: 2, outcome: 'attention-required', stderr: '', report: {
        status: 'committed-incomplete', publicationCommitted: true, projectFileEffectsUncertain: false,
        operationComplete: false, localComplete: false, activationComplete: false, lifecycleComplete: false
      } });
      const manifest = JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'));
      expect(manifest.artifactVersion).toBe(8);
      expect(manifest.project).toEqual(project.manifest.project);
      const after = await inventory(project.root);
      expect(after['application.txt']).toEqual(before['application.txt']);
      expect(after['package.json']).toEqual(before['package.json']);
      expect(after['liftoff.config.json']).toBeUndefined();
      expect(await invoke(project, ['--check'])).toMatchObject({ code: 0, outcome: 'success', report: {
        status: 'current', publicationCommitted: false, localComplete: false, coreUpdateComplete: true
      } });
    }
  );

  it.each((['none', 'single-maintainer-gitflow', 'team-gitflow'] as const).flatMap(profile =>
    (['manual', 'openspec', 'spec-kit'] as const).map(workflow => ({ profile, workflow }))
  ))('maintains existing $profile/$workflow selection without starting activation', async ({ profile, workflow }) => {
    const project = await freshManifestFixture(profile, workflow);
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      specWorkflow: workflow, agents: project.selection.selection.project.agents, governanceProfile: profile
    }));
    const before = await inventory(project.root);
    expect(await invoke(project, ['--check'])).toMatchObject({ code: 0, report: {
      status: 'current', localComplete: false, configurationReview: { present: true, deferredFields: [] }
    } });
    expect(await invoke(project, [])).toMatchObject({ code: 0, report: { status: 'current', publicationCommitted: false } });
    expect(await inventory(project.root)).toEqual(before);
  });

  it.each(['required', 'declined', 'cancelled', 'mismatched'] as const)('preserves project bytes when approval is %s', async state => {
    const project = await fixture(), before = await inventory(project.root);
    await invoke(project, ['--check']);
    const confirm = state === 'declined' ? async () => false : state === 'cancelled' ? async () => {
      throw Object.assign(new Error('Test prompt cancellation.'), { name: 'ExitPromptError' });
    } : undefined;
    const result = await invoke(project, state === 'mismatched' ? ['--approve-plan', 'f'.repeat(64)] : [], { confirm });
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ status: 'approval-blocked', publicationCommitted: false, projectFileEffectsUncertain: false });
    expect(result.outcome).toBe(state === 'required' ? 'attention-required' : state === 'mismatched' ? 'failure' : 'cancelled');
    expect(await inventory(project.root)).toEqual(before);
  });

  it('selects the nearest nested project and leaves its sibling untouched', async () => {
    const project = await fixture(), sibling = await fixture('0.3.4');
    const nested = path.join(project.root, 'nested', 'work');
    await fs.mkdir(nested, { recursive: true });
    const before = await inventory(sibling.root);
    const preview = await invoke(project, ['--check'], { cwd: nested });
    expect(preview.report.projectRoot).toBe(project.root);
    expect(await invoke(project, ['--approve-plan', preview.report.plans[0].fingerprint], { cwd: nested })).toMatchObject({ code: 2 });
    expect(await inventory(sibling.root)).toEqual(before);
  });

  it.each(['required', 'declined', 'cancelled', 'mismatched'] as const)(
    'does not let deferred legacy agent intent hide %s approval', async state => {
      const project = await fixture('0.3.4');
      await write(project.root, ['liftoff.config.json'], '{"agents":["copilot"]}\n');
      const before = await inventory(project.root);
      const preview = await invoke(project, ['--check']);
      expect(preview.report.configurationReview.deferredFields).toEqual(['agents']);
      const confirm = state === 'declined' ? async () => false : state === 'cancelled' ? async () => {
        throw Object.assign(new Error('Test prompt cancellation.'), { name: 'ExitPromptError' });
      } : undefined;
      const result = await invoke(project, state === 'mismatched' ? ['--approve-plan', 'f'.repeat(64)] : [], { confirm });
      expect(result).toMatchObject({ code: 1, report: {
        status: 'approval-blocked', publicationCommitted: false, projectFileEffectsUncertain: false,
        coreUpdateComplete: false
      } });
      expect(result.outcome).toBe(state === 'required' ? 'attention-required' : state === 'mismatched' ? 'failure' : 'cancelled');
      expect(await inventory(project.root)).toEqual(before);
    }
  );

  it('exposes only a separately approved force variant for edited owned core', async () => {
    const project = await freshManifestFixture('single-maintainer-gitflow', 'openspec');
    const artifact = buildModernManagedCore(project.selection)[0];
    await write(project.root, artifact.pathParts, 'User-edited owned core.\n');
    const before = await inventory(project.root);
    const preview = await invoke(project, ['--check']);
    expect(preview.report.plans.map((plan: { mode: string }) => plan.mode)).toEqual(['force']);
    expect(await invoke(project, ['--approve-plan', preview.report.plans[0].fingerprint])).toMatchObject({ code: 1 });
    expect(await inventory(project.root)).toEqual(before);
    expect(await invoke(project, ['--force', '--approve-plan', preview.report.plans[0].fingerprint])).toMatchObject({ code: 0, report: {
      status: 'committed', publicationCommitted: true, coreUpdateComplete: true, localComplete: false
    } });
  });

  it('preserves compatible custom layout and original provenance through actual public maintenance', async () => {
    const project = await freshManifestFixture('single-maintainer-gitflow', 'openspec');
    const activeLayout = { schemaVersion: 1 as const, state: 'bound' as const,
      bindings: [{ kind: 'component' as const, component: 'backend' as const, pathParts: ['custom', 'existing-api'] }] };
    const selection = { ...project.selection, activeLayout };
    const contexts = createModernGovernanceContextContract({
      catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract
    });
    const manifest = { ...project.current, activeLayout, governance: {
      ...project.current.governance, activationIdentity: contexts.buildModernGovernanceContext(selection).governance.activationIdentity
    } };
    await write(project.root, ['liftoff.manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
    await write(project.root, ['custom', 'existing-api', 'user-code.txt'], 'Existing custom application.\r\n');
    const before = await inventory(project.root);
    const preview = await invoke(project, ['--check']);
    expect(preview.code, JSON.stringify(preview.report)).toBe(2);
    expect(await invoke(project, ['--approve-plan', preview.report.plans[0].fingerprint])).toMatchObject({
      code: 0, report: { status: 'committed', publicationCommitted: true, localComplete: false }
    });
    const current = JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8'));
    expect(current.activeLayout).toEqual(activeLayout);
    expect(current.projectArtifacts).toEqual(project.current.projectArtifacts);
    expect(current.adoptionObservations).toEqual(project.current.adoptionObservations);
    expect((await inventory(project.root))['custom/existing-api/user-code.txt']).toEqual(before['custom/existing-api/user-code.txt']);
  });

  it.each(['after-mutation', 'committed'] as const)('recovers actual interrupted public selection at %s only after explicit approval', async phase => {
    const project = await fixture(), before = await inventory(project.root);
    const preview = await invoke(project, ['--check']), fingerprint = preview.report.plans[0].fingerprint;
    const request = {
      projectRoot: project.root, selection: { kind: 'recorded-project-intent' }, force: false, approvePlan: fingerprint
    };
    const child = spawnSync(process.execPath, [
      '--import', new URL('./fixtures/source-typescript-loader.mjs', import.meta.url).href,
      '--input-type=module', '-e', `
        const { applyModernSuccessorUpdate } = await import(${JSON.stringify(new URL('../src/application/update/use-case.ts', import.meta.url).href)});
        await applyModernSuccessorUpdate(${JSON.stringify(request)}, { stderr: process.stderr }, {
          env: {}, homedir: ${JSON.stringify(project.home)}, clock: () => new Date(${JSON.stringify(now)}),
          onCheckpoint: async checkpoint => {
            if (checkpoint.phase === ${JSON.stringify(phase)} &&
              (${JSON.stringify(phase)} !== 'after-mutation' || checkpoint.index === 0)) process.exit(73);
          }
        });
        process.exitCode = 9;
      `
    ], { encoding: 'utf8', timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(73);
    const lock = await projectMutationLockPath(project.root), lockBytes = await fs.readFile(lock);
    expect(JSON.parse(lockBytes.toString('utf8')).pid).toBe(child.pid);
    const interrupted = await inventory(project.root);
    expect(await invoke(project, ['--approve-plan', fingerprint])).toMatchObject({ code: 1, report: {
      status: 'recovery-required', publicationCommitted: phase === 'committed', executionRequested: false
    } });
    expect(await invoke(project, ['--recover', '--approve-plan', fingerprint])).toMatchObject({ code: 1, report: {
      publicationCommitted: phase === 'committed', projectFileEffectsUncertain: true
    } });
    expect(await fs.readFile(lock)).toEqual(lockBytes);
    expect(await inventory(project.root)).toEqual(interrupted);
    // Only the exact stopped test child's lock is removed; production never reaps stale locks.
    await fs.unlink(lock);
    expect(await invoke(project, ['--recover', '--approve-plan', fingerprint])).toMatchObject({ code: 2, report: {
      status: 'recovered', publicationCommitted: phase === 'committed',
      projectFileEffectsUncertain: false, operationComplete: true, localComplete: false
    } });
    const after = await inventory(project.root);
    if (phase === 'after-mutation') expect(after).toEqual(before);
    else {
      expect(after['application.txt']).toEqual(before['application.txt']);
      expect(JSON.parse(await fs.readFile(path.join(project.root, 'liftoff.manifest.json'), 'utf8')).artifactVersion).toBe(8);
    }
  });

  it('does not implicitly recover a committed transaction and requires its exact saved fingerprint', async () => {
    const project = await fixture();
    const selection = { kind: 'recorded-project-intent' } as const;
    const preview = await previewModernSuccessorUpdate(project.root, selection, project.options);
    const fingerprint = preview.receipt.variants[0].fingerprint;
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection, force: false, approvePlan: fingerprint
    }, approval(), { ...project.options, onCheckpoint: async checkpoint => {
      if (checkpoint.phase === 'committed') throw new Error('Injected postcommit checkpoint failure.');
    } })).toMatchObject({ status: 'committed-cleanup-pending', committed: true });
    const before = await inventory(project.root);
    expect(await applyModernSuccessorUpdate({
      projectRoot: project.root, selection, force: false, approvePlan: fingerprint
    }, approval(), project.options)).toMatchObject({ status: 'recovery-required' });
    expect(await invoke(project, ['--approve-plan', fingerprint])).toMatchObject({ code: 1, report: {
      status: 'recovery-required', publicationCommitted: true, executionRequested: false
    } });
    expect(await invoke(project, ['--recover', '--approve-plan', 'f'.repeat(64)])).toMatchObject({ code: 1, outcome: 'failure' });
    expect(await inventory(project.root)).toEqual(before);
    const blocked = vi.spyOn(transactions, 'recoverReviewedUpdateTransaction').mockResolvedValueOnce({
      status: 'blocked', committed: false, rollbackFailures: ['Injected changed-journal refusal.'], cleanupFailures: []
    });
    expect(await invoke(project, ['--recover', '--approve-plan', fingerprint])).toMatchObject({
      code: 1, outcome: 'failure', report: { publicationCommitted: true, projectFileEffectsUncertain: true }
    });
    blocked.mockRestore();
    expect(await inventory(project.root)).toEqual(before);
    // Configuration is not a publication target, and recovery must not parse it.
    await write(project.root, ['liftoff.config.json'], '{partial');
    expect(await invoke(project, ['--recover', '--approve-plan', fingerprint])).toMatchObject({ code: 2, outcome: 'attention-required', report: {
      status: 'recovered', publicationCommitted: true, projectFileEffectsUncertain: false,
      operationComplete: true, coreUpdateComplete: false, localComplete: false
    } });
    expect(await fs.readFile(path.join(project.root, 'liftoff.config.json'), 'utf8')).toBe('{partial');
  });

  it('withholds credential-shaped output without hiding an actual publication commit', async () => {
    const original = await fixture();
    const root = path.join(original.parent, `synthetic-ghp_${'x'.repeat(36)}`);
    await fs.rename(original.root, root);
    const project = { ...original, root }, selection = { kind: 'recorded-project-intent' } as const;
    const preview = await previewModernSuccessorUpdate(root, selection, project.options);
    const result = await invoke(project, ['--approve-plan', preview.receipt.variants[0].fingerprint]);
    expect(result).toMatchObject({ code: 1, outcome: 'failure', report: {
      reasonCode: 'credential-output-withheld', publicationCommitted: true, projectRoot: null,
      operationComplete: false, coreUpdateComplete: false, localComplete: false
    } });
    expect(JSON.stringify(result)).not.toContain('ghp_');
    expect(JSON.parse(await fs.readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).artifactVersion).toBe(8);
  });

  it.each([reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts, localVerificationTransactionPathParts])(
    'refuses the pending %j journal before malformed manifest interpretation', async (...parts) => {
      const project = await fixture();
      await write(project.root, parts, 'Pending foreign or malformed transaction.\n');
      await write(project.root, ['liftoff.manifest.json'], '{partial');
      const before = await inventory(project.root);
      expect((await invoke(project, ['--check'])).code).toBe(1);
      expect(await inventory(project.root)).toEqual(before);
      expect(await fs.readdir(project.home)).toEqual([]);
    }
  );

  it.each([
    ['--recover'], ['--recover', '--force', '--approve-plan', 'a'.repeat(64)],
    ['--recover', '--check'], ['--recover', '--approve-plan', 'A'.repeat(64)],
    ['one', '--project', 'two']
  ])('rejects invalid authority arguments %j before dispatch', (...argv) => {
    expect(() => parseArgs(['update', ...argv])).toThrow();
  });
});
