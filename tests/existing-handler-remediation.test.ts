import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { inspectApplicationLayout } from '../src/application/repair/application-inventory.js';
import { applicationPathKey } from '../src/application/repair/application-files.js';
import { applicationPackageSources, applicationPreparationBounds } from '../src/application/repair/application-preparation-policy.js';
import type { ApplicationPatchDocument, ApplicationPatchMapping } from '../src/application/repair/application-types.js';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import type { RepairWorkspaceStorageOptions } from '../src/application/repair/workspaces-types.js';
import { reconcileProject } from '../src/reconcile.js';
import { buildUpdateArtifacts } from '../src/application/update/planning.js';
import {
  NodeCommandRunner, type CommandResult, type CommandRunner, type ExternalCommand, type RunCommandOptions
} from '../src/process-runner.js';
import { CaptureStream } from './helpers.js';
import { putApplicationFixtureFile } from './fixtures/repair-application.js';
import { existingFastifyHandlers, fastifyVerificationSource, observationMarker, pricingPolicy } from './fixtures/existing-fastify.js';
import { ApiFixtureLifecycle } from './helpers/api-fixture-lifecycle.mjs';

const handlerParts = ['backend', 'src', 'app.ts'];
const verificationArgs = ['--allow-dependency-preparation', '--allow-network'];
const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];
const fixtureDrainTimeoutMs = applicationPreparationBounds.preparationTimeoutMs;

class RecordingNativeRunner implements CommandRunner {
  readonly calls: Array<{ command: ExternalCommand; options?: RunCommandOptions; result?: CommandResult; startedAt: number; completedAt?: number }> = [];
  readonly native = new NodeCommandRunner();
  pending = 0;
  uncertain = false;

  async run(command: ExternalCommand, options?: RunCommandOptions) {
    const call: (typeof this.calls)[number] = { command, options, startedAt: performance.now() };
    this.calls.push(call);
    this.pending++;
    try {
      const result = await this.native.run(command, options);
      call.result = result;
      if (options?.ensureProcessTreeSettled && result.processTreeSettled !== true) this.uncertain = true;
      return result;
    } catch (error) {
      this.uncertain = true;
      throw error;
    } finally { call.completedAt = performance.now(); this.pending--; }
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    // A test timeout is still a failure; let its already-authorized CLI finally release its cleanup lease.
    await fixture.lifecycle.drain(fixtureDrainTimeoutMs);
    const inspection = await inspectRepairVerificationWorkspaces(fixture.root, fixture.storage);
    if (fixture.lifecycle.pending || fixture.runner.pending || fixture.runner.uncertain || inspection.issues.length ||
        inspection.workspaces.some((workspace) => !workspace.cleanupComplete)) {
      throw new Error(`Unsettled or retained verification workspace; preserving fixture ${fixture.directory}`);
    }
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, fixtureDrainTimeoutMs + applicationPreparationBounds.probeTimeoutMs);

function selectedPackageSource(): 'npmjs' | 'microsoft-npm' {
  const selected = process.env.npm_config_registry;
  if (!selected) return 'npmjs';
  const source = (['npmjs', 'microsoft-npm'] as const)
    .find((id) => applicationPackageSources[id].registry === `${selected.replace(/\/+$/, '')}/`);
  if (!source) throw new Error('Local validation selected an unregistered npm source; explicit supported preparation is required');
  return source;
}

async function createFixture(signal: AbortSignal) {
  const directory = path.resolve('tests', `.existing Fastify remediation ${randomUUID()}`);
  const root = path.join(directory, 'project');
  const stage = path.join(directory, 'stage');
  const home = path.join(directory, 'private-records-home');
  const plan = buildProjectPlan({
    projectName: 'Custom Pricing Service', projectType: 'standard', apiStack: 'node',
    cloud: 'azure', region: 'eastus', environments: ['dev'], specWorkflow: 'openspec',
    agents: ['github-copilot'], governanceProfile: 'none', includeFrontend: false
  }, { requireProjectName: true });
  const artifacts = buildArtifacts(plan);
  const handlers = existingFastifyHandlers(artifacts.find((item) => item.logicalName === 'node-backend-app')!.content);
  const lifecycle = new ApiFixtureLifecycle(directory, signal);
  const cleanup = { startedAt: 0, operations: { scan: 0, unlink: 0, rmdir: 0 } };
  const storage: RepairWorkspaceStorageOptions = {
    homedir: home, env: {}, repositoryRoot: root,
    beforeWorkspaceOperation: async (operation) => {
      if (operation === 'mkdir') return;
      cleanup.startedAt ||= performance.now();
      cleanup.operations[operation]++;
    }
  };
  const runner = new RecordingNativeRunner();
  const fixture = {
    directory, root, stage, storage, plan, handlers, runner, lifecycle,
    async cli(command: 'repair' | 'update', args: string[]) {
      return lifecycle.run(async () => {
        const stdout = new CaptureStream(), stderr = new CaptureStream();
        const startedAt = performance.now();
        const code = await runCommand(parseArgs([command, root, ...args, '--json']), {
          cwd: directory, stdout, stderr, runner, env: process.env, updatePreview: storage
        });
        if (args.includes('--verify-plan') && cleanup.startedAt) {
          const nativeMs = runner.calls.filter((call) => call.options?.ensureProcessTreeSettled && call.completedAt)
            .reduce((total, call) => total + call.completedAt! - call.startedAt, 0);
          console.info('Real Fastify verification lifecycle:', JSON.stringify({
            totalMs: Math.round(performance.now() - startedAt), nativeCommandMs: Math.round(nativeMs),
            cleanupMs: Math.round(performance.now() - cleanup.startedAt), cleanupOperations: cleanup.operations
          }));
        }
        return { code, report: JSON.parse(stdout.text()), stderr: stderr.text() };
      });
    }
  };
  fixtures.push(fixture);
  return lifecycle.run(async () => {
    await Promise.all([root, stage, home].map((item) => mkdir(item, { recursive: true, mode: 0o700 })));
    await writeArtifacts(root, artifacts);
    await putApplicationFixtureFile(root, handlerParts, handlers.before);
    await putApplicationFixtureFile(root, ['backend', 'src', 'original-app.ts'],
      await readFile(path.join(root, ...handlerParts)));
    await putApplicationFixtureFile(root, ['backend', 'src', 'pricing-policy.ts'], pricingPolicy);
    await putApplicationFixtureFile(root, ['backend', 'src', 'unrelated-business.ts'], "export const accountLimit = 7;\n");
    await putApplicationFixtureFile(root, ['docs', 'custom-enterprise-policy.txt'], 'Unrelated enterprise policy remains byte-identical.\n');
    await putApplicationFixtureFile(root, ['backend', 'test', 'business-and-routes.test.mjs'], fastifyVerificationSource);
    await putApplicationFixtureFile(root, ['backend', 'test', 'api-routing.mjs'],
      await readFile(path.resolve('tests/helpers/api-routing.mjs'), 'utf8'));
    await putApplicationFixtureFile(root, ['backend', 'node_modules', 'live-project-only.txt'], 'Excluded original dependency tree; never copied into verification.\n');
    await putApplicationFixtureFile(root, ['.env'], 'DATABASE_URL=postgresql://localhost/original\nREDIS_URL=redis://localhost:6379/0\n');
    return fixture;
  });
}

async function stagePatch(
  fixture: Awaited<ReturnType<typeof createFixture>>, source: string, name: string, reviewReferences = true
) {
  return fixture.lifecycle.run(async () => {
    const manifest = await loadManifest(fixture.root);
    const inspection = await inspectApplicationLayout(fixture.root, manifest);
    expect(inspection.report.blockers).toEqual([]);
    expect(inspection.report.complete).toBe(true);
    const observed = inspection.report.files.find((file) => applicationPathKey(file.pathParts) === applicationPathKey(handlerParts))!;
    const references = inspection.report.references
      .filter((entry) => applicationPathKey(entry.sourcePathParts) === applicationPathKey(handlerParts));
    expect(references.some((entry) => entry.targetPathParts.at(-1) === 'pricing-policy.ts')).toBe(true);
    const replacement = [`${name}-app.ts`];
    await putApplicationFixtureFile(fixture.stage, replacement, source, 0o600);
    const mapping: ApplicationPatchMapping = {
      sourcePathParts: handlerParts, targetPathParts: handlerParts, stagedPathParts: replacement,
      expectedSourceDigest: observed.digest, expectedSourceMode: observed.mode, targetMode: observed.mode,
      role: 'application', targetIdentity: { kind: 'generated-artifact', logicalName: 'node-backend-app' },
      customization: source === fixture.handlers.before ? 'preserved' : 'reviewed-edit',
      references: reviewReferences ? references.map((entry) => ({
        referenceId: entry.id, disposition: 'unchanged-reviewed', afterTargetPathParts: entry.targetPathParts
      })) : []
    };
    const document: ApplicationPatchDocument = {
      schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: inspection.report.projectRoot,
      inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target!.digest,
      dynamicReferencesReviewed: true, unresolvedMappings: [], mappings: [mapping],
      verification: {
        preparation: [{
          provider: 'npm-ci', version: 1, cwdPathParts: ['backend'],
          packageSource: selectedPackageSource(), network: true, lifecycle: 'disabled'
        }],
        commands: [
          { executable: 'npm', args: ['run', 'build', '--ignore-scripts'], cwdPathParts: ['backend'], timeoutMs: 30_000, maxOutputBytes: 65_536, network: false },
          { executable: 'npm', args: ['test', '--ignore-scripts'], cwdPathParts: ['backend'], timeoutMs: 30_000, maxOutputBytes: 65_536, network: false },
          { executable: 'node', args: ['--test', 'test/business-and-routes.test.mjs'], cwdPathParts: ['backend'], timeoutMs: 30_000, maxOutputBytes: 65_536, network: true }
        ]
      }
    };
    const patchParts = [`${name}-patch.json`];
    await putApplicationFixtureFile(fixture.stage, patchParts, `${JSON.stringify(document, null, 2)}\n`, 0o600);
    return { patchPath: path.join(fixture.stage, ...patchParts), inspection };
  });
}

function assertVerified(
  fixture: Awaited<ReturnType<typeof createFixture>>, result: Awaited<ReturnType<typeof fixture.cli>>
) {
  const failure = fixture.runner.calls.findLast((call) => call.result && call.result.status !== 0);
  expect(result.code, `${JSON.stringify(result.report.blockers)}\n${failure?.result?.stdout ?? ''}\n${failure?.result?.stderr ?? ''}`).toBe(0);
  expect(result.report.status).toBe('verified');
  expect(result.report.committed).toBe(false);
  expect(result.report.verification).toBe('passed');
  expect(result.report.verificationEffects).toMatchObject({
    dependencyPreparationAuthorized: true, networkAuthorized: true, outcome: 'passed'
  });
  const verification = result.report.verificationResult;
  expect(verification.preparation.map((entry: { provider: string; status: string }) => [entry.provider, entry.status]))
    .toEqual([['npm-ci', 'passed']]);
  expect(verification.commands).toHaveLength(3);
  expect(verification.commands.every((entry: { passed: boolean; status: number }) => entry.passed && entry.status === 0)).toBe(true);
  expect(verification.cleanupComplete).toBe(true);
  expect(verification.inspectedProjectUnchanged).toBe(true);
  const call = fixture.runner.calls.findLast((entry) => entry.command.args.includes('test/business-and-routes.test.mjs'))!;
  expect(call.result?.processTreeSettled).toBe(true);
  const workspace = path.dirname(call.options!.env!.HOME!);
  expect(path.basename(workspace)).toBe(verification.workspaceId);
  expect(call.options!.cwd).toBe(path.join(workspace, 'project', 'backend'));
  expect(call.options!.cwd).not.toBe(path.join(fixture.root, 'backend'));
  const observations = call.result!.stdout.split('\n').filter((line) => line.includes(observationMarker))
    .map((line) => JSON.parse(line.slice(line.indexOf(observationMarker) + observationMarker.length)));
  expect(observations, call.result!.stderr).toHaveLength(2);
  for (const actual of observations) {
    expect(actual.workspaceId).toBe(verification.workspaceId);
    expect(actual.quotes.map((quote: { totalCents: number }) => quote.totalCents)).toEqual([22500, 120000, 22500, 120000]);
  }
  expect(observations[0].routing).toBe('defect-reproduced');
  return { before: observations[0], after: observations[1] };
}

async function assertOriginalDependenciesExcluded(fixture: Awaited<ReturnType<typeof createFixture>>) {
  expect(await readFile(path.join(fixture.root, 'backend', 'node_modules', 'live-project-only.txt'), 'utf8'))
    .toContain('Excluded original dependency tree');
  await expect(lstat(path.join(fixture.root, 'backend', 'node_modules', 'fastify'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(path.join(fixture.root, 'backend', 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('OpenSpec 8.8/15.5: real existing Fastify remediation and update ownership', () => {
  it('preserves real quotes and schema through reviewed private preparation/checks and an exact one-file commit', async ({ signal }) => {
    const fixture = await createFixture(signal);
    const patch = await stagePatch(fixture, fixture.handlers.corrected, 'corrected');
    expect(await readFile(path.join(fixture.root, 'backend', 'src', 'original-app.ts'), 'utf8')).toBe(fixture.handlers.before);
    const rawManifest = await readFile(path.join(fixture.root, 'liftoff.manifest.json'));
    const rawConfig = await readFile(path.join(fixture.root, 'liftoff.config.json'));
    const liveEnv = await readFile(path.join(fixture.root, '.env'));
    const preview = await fixture.cli('repair', ['--check', '--application-patch', patch.patchPath]);
    expect(preview.code).toBe(2);
    expect(preview.report.blockers, preview.stderr).toEqual([]);
    expect(preview.report.status).toBe('available');
    expect(preview.report.application.effects).toHaveLength(1);
    expect(preview.report.application.effects[0].targetPathParts).toEqual(handlerParts);
    const fingerprint = preview.report.fingerprint;
    const installsBefore = fixture.runner.calls.filter((call) => call.command.args.includes('ci')).length;
    const premature = await fixture.cli('repair', ['--approve-plan', fingerprint]);
    expect(premature.code).toBe(2);
    expect(premature.report.committed).toBe(false);
    for (const flags of [[], ['--allow-network'], ['--allow-dependency-preparation']]) {
      const denied = await fixture.cli('repair', ['--verify-plan', fingerprint, ...flags]);
      expect(denied.code).toBe(2);
      expect(denied.report.verificationEffects.attempted).toBe(false);
    }
    expect(fixture.runner.calls.filter((call) => call.command.args.includes('ci'))).toHaveLength(installsBefore);

    const verification = await fixture.cli('repair', ['--verify-plan', fingerprint, ...verificationArgs]);
    const { before, after } = assertVerified(fixture, verification);
    expect(after.schema).toEqual(before.schema);
    expect(after.fastifyVersion).toBe(before.fastifyVersion);
    expect(after.routing).toBe('passed');
    expect(after.checks).toBeGreaterThan(100);
    expect(await readFile(path.join(fixture.root, ...handlerParts), 'utf8')).toBe(fixture.handlers.before);
    await assertOriginalDependenciesExcluded(fixture);

    const applied = await fixture.cli('repair', ['--approve-plan', fingerprint]);
    expect(applied.code, JSON.stringify(applied.report.blockers)).toBe(0);
    expect(applied.report.status).toBe('applied');
    expect(applied.report.committed).toBe(true);
    expect(await readFile(path.join(fixture.root, ...handlerParts), 'utf8')).toBe(fixture.handlers.corrected);
    for (const snapshot of patch.inspection.snapshots) {
      if (snapshot.content && applicationPathKey(snapshot.pathParts) !== applicationPathKey(handlerParts)) {
        expect(await readFile(path.join(fixture.root, ...snapshot.pathParts)), applicationPathKey(snapshot.pathParts)).toEqual(snapshot.content);
      }
    }
    expect(await readFile(path.join(fixture.root, 'liftoff.manifest.json'))).toEqual(rawManifest);
    expect(await readFile(path.join(fixture.root, 'liftoff.config.json'))).toEqual(rawConfig);
    expect(await readFile(path.join(fixture.root, '.env'))).toEqual(liveEnv);

    const manifest = await loadManifest(fixture.root);
    const reconciliation = await reconcileProject(manifest, buildUpdateArtifacts(fixture.plan, manifest), fixture.root);
    expect(reconciliation.find((entry) => applicationPathKey(entry.pathParts) === applicationPathKey(handlerParts))).toBeUndefined();
    const updateCheck = await fixture.cli('update', ['--check']);
    expect(updateCheck.code, JSON.stringify(updateCheck.report)).toBe(0);
    const update = await fixture.cli('update', []);
    expect(update.code, JSON.stringify(update.report)).toBe(0);
    expect(await readFile(path.join(fixture.root, ...handlerParts), 'utf8')).toBe(fixture.handlers.corrected);
    await assertOriginalDependenciesExcluded(fixture);
  }, 180_000);

  it('fails real candidate verification for a broken discount and refuses the real-project commit', async ({ signal }) => {
    const fixture = await createFixture(signal);
    const staged = await stagePatch(fixture, fixture.handlers.broken, 'broken');
    const preview = await fixture.cli('repair', ['--check', '--application-patch', staged.patchPath]);
    expect(preview.report.status, JSON.stringify(preview.report.blockers)).toBe('available');
    const fingerprint = preview.report.fingerprint;
    const verification = await fixture.cli('repair', ['--verify-plan', fingerprint, ...verificationArgs]);
    expect(verification.code).toBe(2);
    expect(verification.report.verification).toBe('incomplete');
    expect(verification.report.verificationReceipt).toBeUndefined();
    expect(verification.report.verificationResult.preparation[0].status).toBe('passed');
    expect(verification.report.verificationResult.commands.map((entry: { passed: boolean }) => entry.passed)).toEqual([true, true, false]);
    expect(verification.report.verificationResult.commands[2].status).toBe(1);
    expect(verification.report.verificationResult.cleanupComplete).toBe(true);
    const failed = fixture.runner.calls.findLast((call) => call.command.args.includes('test/business-and-routes.test.mjs'))!;
    expect(failed.result?.stdout).toContain('exported volume-tier calculation at quantity 20');
    expect(failed.result?.stdout).toContain('actual Fastify quote for quantity 25');
    expect(failed.result?.processTreeSettled).toBe(true);
    expect(path.basename(path.dirname(failed.options!.env!.HOME!))).toBe(verification.report.verificationResult.workspaceId);
    const approval = await fixture.cli('repair', ['--approve-plan', fingerprint]);
    expect(approval.code).toBe(2);
    expect(approval.report.committed).toBe(false);
    expect(await readFile(path.join(fixture.root, ...handlerParts), 'utf8')).toBe(fixture.handlers.before);
    for (const snapshot of staged.inspection.snapshots) {
      if (snapshot.content) expect(await readFile(path.join(fixture.root, ...snapshot.pathParts))).toEqual(snapshot.content);
    }
    await assertOriginalDependenciesExcluded(fixture);
  }, 180_000);

  it('blocks a real handler mapping with unreviewed references before preparation or checks', async ({ signal }) => {
    const fixture = await createFixture(signal);
    const staged = await stagePatch(fixture, fixture.handlers.corrected, 'unreviewed', false);
    const preview = await fixture.cli('repair', ['--check', '--application-patch', staged.patchPath]);
    expect(preview.code).toBe(2);
    expect(preview.report.blockers.join(' ')).toContain('every observed outgoing reference requires exactly one reviewed disposition');
    expect(fixture.runner.calls.some((call) => call.command.args.includes('ci') || call.command.args.includes('--test'))).toBe(false);
    expect(await readFile(path.join(fixture.root, ...handlerParts), 'utf8')).toBe(fixture.handlers.before);
  });
});
