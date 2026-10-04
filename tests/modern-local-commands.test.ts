import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { createCommandOutcome } from '../src/application/command-outcome.js';
import * as approval from '../src/application/governance/modern-local-approval.js';
import * as execution from '../src/application/governance/modern-local-execution.js';
import * as historical from '../src/application/governance/inspection.js';
import * as oldInputs from '../src/adapters/filesystem/governance-records.js';
import * as oldPlans from '../src/governance-activation/public-plans.js';
import { resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { renderOpenSpecConfig, renderSeedTasks, renderSeedDesign, renderSeedProposal, renderSeedSpec } from '../src/generators/common/spec-workflow.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import type { LocalExecutionPreviewV1, LocalExecutionResultV1, LocalExecutionScopes } from '../src/domain/governance/activation/modern-local-runtime.js';
import { createLocalExecutionRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { writeModernInstalledProject, writeModernHistoricalSource } from './fixtures/modern-installed-project.js';
import { writeModernLocalFixtureInputs } from './fixtures/modern-local-project.js';
import { createOpenSpecExecutionFixture, selected, capability, spec, originalFiles } from './modern-openspec-fixtures.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const roots: { path: string; dev: number; ino: number }[] = [];
const fingerprint = 'a'.repeat(64);
const scopes: LocalExecutionScopes = {
  projectCode: true, hostCapabilitiesAcknowledged: true, dependencyPreparation: false, dependencyNetwork: false,
  workflowFinalization: false, publishLocalRecords: false
};
const native = process.env.LIFTOFF_PUBLIC_LOCAL_TESTS === '1';
if (native && (process.env.LIFTOFF_HCL_TEST_LANE === 'portable' ||
    process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.21.0')) {
  throw new Error('Public local native qualification requires the actual qualified runtime and native HCL admission.');
}
const nativeIt = it.skipIf(!native), nativeCases: string[] = [];
afterAll(() => {
  if (native) expect(nativeCases.sort()).toEqual(['archived', 'failure', 'initialized', 'manual', 'openspec', 'spec-kit', 'stale']);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0).reverse()) {
    const stat = await fs.lstat(root.path);
    expect([stat.dev, stat.ino, stat.isDirectory(), stat.isSymbolicLink()]).toEqual([root.dev, root.ino, true, false]);
    await fs.rm(root.path, { recursive: true });
  }
});
async function directory() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'public-local-'))), stat = await fs.lstat(root);
  roots.push({ path: root, dev: stat.dev, ino: stat.ino });
  return root;
}
async function invoke(root: string, args: string[], jsonMode = true) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner(), outcome = createCommandOutcome();
  const code = await runCommand(parseArgs(['governance', ...args, '--scope', 'local', '--local-operation', 'verify',
    ...(jsonMode ? ['--json'] : [])]), { cwd: root, stdout, stderr, runner, outcome });
  expect(runner.calls).toEqual([]);
  return { code, stdout: stdout.text(), stderr: stderr.text(), semantic: outcome.finish(code),
    report: jsonMode && stdout.text() ? JSON.parse(stdout.text()) : undefined };
}
async function inputFiles(root: string, kind = 'verify-local', initialized = false) {
  const request = path.join(path.dirname(root), 'request.json'), consent = path.join(path.dirname(root), 'consent.json');
  await fs.writeFile(request, JSON.stringify({ kind, preparation: [] }));
  await fs.writeFile(consent, JSON.stringify(initialized
    ? { kind: 'approve-openspec-initialized', scopes: { ...scopes, dependencyPreparation: true },
      bootstrapScopeAttestation: { generatedBaselineReviewed: true, domainBehaviorDeferred: true } }
    : { kind: 'approve-local-execution', scopes }));
  return { request, consent };
}

// Application response specimens exercise routing only, never native proof or real authority.
function routingPreview(root: string): LocalExecutionPreviewV1 {
  return {
    kind: 'liftoff-local-execution-preview', schemaVersion: 1, operationKind: 'verify-local', projectRoot: root,
    operationId: '11111111-1111-4111-8111-111111111111', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T00:15:00.000Z',
    fingerprint, installedBinding: fingerprint, observationDigest: fingerprint, physicalDigest: fingerprint,
    baselineDigest: fingerprint, recipeDigest: fingerprint, policyDigest: fingerprint, checks: [], tools: [],
    preparation: [], preparationDigest: fingerprint, outputRoles: [], selectedPlan: null, selectedPlanDigest: null
  };
}
function routingResult(root: string, status: LocalExecutionResultV1['status']): LocalExecutionResultV1 {
  return {
    kind: 'liftoff-local-execution-result', schemaVersion: 1, projectRoot: root, fingerprint,
    operationId: '11111111-1111-4111-8111-111111111111', status, complete: status === 'checks-verified',
    startedAt: '2026-10-01T00:01:00.000Z', completedAt: '2026-10-01T00:02:00.000Z', checks: [], preparation: [],
    inputsUnchanged: true, cleanupComplete: true, retainedWorkspace: null, policyDigest: fingerprint,
    baselineDigest: fingerprint, selectedPlanDigest: null, resultDigest: fingerprint,
    failureCode: status === 'checks-verified' ? null : 'process-failed'
  };
}
async function controlFixture() {
  const root = path.join(await directory(), 'project');
  return writeModernInstalledProject(root);
}

describe('public modern local application routing', () => {
  it.each([
    ['verify-local', 'prepareModernLocalExecution'],
    ['verify-openspec-local', 'prepareModernOpenSpecExecution'],
    ['verify-openspec-initialized', 'prepareModernOpenSpecInitializedBaseline'],
    ['verify-openspec-archived', 'prepareModernArchivedOpenSpecExecution']
  ] as const)('routes %s to only its explicit producer', async (kind, producer) => {
    const f = await controlFixture(), files = await inputFiles(f.root, kind), before = await originalFiles(f.root);
    const spies = {
      prepareModernLocalExecution: vi.spyOn(approval, 'prepareModernLocalExecution'),
      prepareModernOpenSpecExecution: vi.spyOn(approval, 'prepareModernOpenSpecExecution'),
      prepareModernOpenSpecInitializedBaseline: vi.spyOn(approval, 'prepareModernOpenSpecInitializedBaseline'),
      prepareModernArchivedOpenSpecExecution: vi.spyOn(approval, 'prepareModernArchivedOpenSpecExecution')
    };
    spies[producer].mockRejectedValue(new Error('Exact producer refused this routing specimen.'));
    const old = vi.spyOn(historical, 'inspectGovernance'), oldInput = vi.spyOn(oldInputs, 'readPublicActivationInputs');
    const result = await invoke(f.root, ['plan', '--inputs', files.request]);
    expect(result.code).toBe(1);
    expect(result.semantic).toBe('failure');
    expect(result.report).toMatchObject({ schemaVersion: 4, status: 'failed', executionRequested: false,
      externalMetadataWriteRequested: true, verificationComplete: false, localComplete: false });
    for (const [name, spy] of Object.entries(spies)) {
      if (name === producer) expect(spy).toHaveBeenCalledWith(f.root, { kind, preparation: [] });
      else expect(spy).not.toHaveBeenCalled();
    }
    expect(old).not.toHaveBeenCalled(); expect(oldInput).not.toHaveBeenCalled();
    expect(await originalFiles(f.root)).toEqual(before);
  });
  it('renders the exact producer preview in human and JSON output without inferring approval', async () => {
    const f = await controlFixture(), files = await inputFiles(f.root), preview = routingPreview(f.root);
    vi.spyOn(approval, 'prepareModernLocalExecution').mockResolvedValue(preview);
    const approve = vi.spyOn(approval, 'approveModernLocalExecution'), execute = vi.spyOn(execution, 'executeModernLocalExecution');
    const result = await invoke(f.root, ['plan', '--inputs', files.request]);
    expect(result.report).toMatchObject({ status: 'planned', preview, operationComplete: true, verificationComplete: false,
      executionRequested: false, localComplete: false, publicationAuthorized: false });
    expect(result.semantic).toBe('success');
    const human = await invoke(f.root, ['plan', '--inputs', files.request], false);
    expect(human.code).toBe(0); expect(human.stdout).toContain(fingerprint); expect(human.stdout).toContain('not a sandbox');
    expect(approve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('passes the separately decoded ordinary consent to its producer without executing', async () => {
    const f = await controlFixture(), files = await inputFiles(f.root), preview = routingPreview(f.root);
    vi.spyOn(approval, 'loadLocalExecutionPreview').mockResolvedValue(preview);
    const approve = vi.spyOn(approval, 'approveModernLocalExecution').mockResolvedValue({
      kind: 'liftoff-local-execution-consent', schemaVersion: 1, projectRoot: f.root, fingerprint,
      approvedAt: preview.createdAt, expiresAt: preview.expiresAt, scopes
    });
    const initialized = vi.spyOn(approval, 'approveModernOpenSpecInitializedBaseline'), execute = vi.spyOn(execution, 'executeModernLocalExecution');
    const result = await invoke(f.root, ['approve', '--plan', fingerprint, '--inputs', files.consent]);
    expect(result.code).toBe(0);
    expect(approve).toHaveBeenCalledWith(f.root, fingerprint, scopes);
    expect(result.report).toMatchObject({ status: 'approved', executionRequested: false, operationComplete: true, verificationComplete: false });
    expect(initialized).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('rejects initialized attestation against an ordinary saved preview before saving consent', async () => {
    const f = await controlFixture(), files = await inputFiles(f.root, 'verify-local', true);
    vi.spyOn(approval, 'loadLocalExecutionPreview').mockResolvedValue(routingPreview(f.root));
    const approve = vi.spyOn(approval, 'approveModernOpenSpecInitializedBaseline');
    const result = await invoke(f.root, ['approve', '--plan', fingerprint, '--inputs', files.consent]);
    expect(result.code).toBe(1);
    expect(result.report.externalMetadataWriteRequested).toBe(false);
    expect(result.report.diagnostics.join(' ')).toContain('consent kind');
    expect(approve).not.toHaveBeenCalled();
  });
  it.each(['checks-verified', 'blocked', 'failed', 'uncertain'] as const)('preserves producer %s without publication claims', async status => {
    const f = await controlFixture(), receipt = routingResult(f.root, status);
    const execute = vi.spyOn(execution, 'executeModernLocalExecution').mockResolvedValue(receipt);
    const old = vi.spyOn(oldPlans, 'loadGovernancePreview');
    const result = await invoke(f.root, ['apply-next', '--plan', fingerprint, '--execute']);
    expect(result.code).toBe(status === 'checks-verified' ? 0 : 1);
    expect(result.semantic).toBe(status === 'checks-verified' ? 'success' : 'failure');
    expect(result.report).toMatchObject({ status, result: receipt, executionRequested: true, externalMetadataWriteRequested: true,
      verificationComplete: receipt.complete, localComplete: false, publicationAuthorized: false });
    expect(execute).toHaveBeenCalledWith(f.root, fingerprint); expect(old).not.toHaveBeenCalled();
  });
  it.each([[], ['--execute=false']])('keeps absent progress nonexecuting with %j', async (...flags) => {
    const f = await controlFixture(), before = await originalFiles(f.root), execute = vi.spyOn(execution, 'executeModernLocalExecution');
    const result = await invoke(f.root, ['apply-next', '--plan', fingerprint, ...flags]);
    expect(result.code).toBe(0); expect(result.semantic).toBe('attention-required');
    expect(result.report).toMatchObject({ status: 'not-executed', executionRequested: false, externalMetadataWriteRequested: false,
      inspection: { status: 'absent' }, verificationComplete: false, recordedProgressIsCurrentProof: false });
    expect(execute).not.toHaveBeenCalled(); expect(await originalFiles(f.root)).toEqual(before);
  });
  it('refuses a historical family before opening the public request or either authority store', async () => {
    const root = await writeModernHistoricalSource(await directory(), 3);
    const read = vi.spyOn(oldInputs, 'readPublicGovernanceInputs'), old = vi.spyOn(oldPlans, 'loadGovernancePreview');
    const prepare = vi.spyOn(approval, 'prepareModernLocalExecution');
    const result = await invoke(root, ['plan', '--inputs', 'must-not-read.json']);
    expect(result.code).toBe(1); expect(result.stderr).toContain('only by modern v8');
    expect(read).not.toHaveBeenCalled(); expect(old).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it('rejects malformed public consent without reading an authority record or issuing tools', async () => {
    const f = await controlFixture(), files = await inputFiles(f.root);
    await fs.writeFile(files.consent, '{"kind":"approve-local-execution","scopes":true}');
    const load = vi.spyOn(approval, 'loadLocalExecutionPreview'), run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const result = await invoke(f.root, ['approve', '--plan', fingerprint, '--inputs', files.consent]);
    expect(result.code).toBe(1); expect(result.report.externalMetadataWriteRequested).toBe(false);
    expect(load).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
});

async function baseline(workflow: 'manual' | 'spec-kit') {
  const root = path.join(await directory(), 'project'), options = { frontend: true };
  const seed = await writeModernInstalledProject(root, workflow, 'single-maintainer-gitflow', options);
  const source = resolveModernManifestV8SourceContract({ selection: seed.input.selection, recordedPlugins: seed.input.plugins });
  const components = new Map(source.layoutDescriptor.components.map(component => [component, ['Source Space', component.replace(':', ' ')]]));
  const f = await writeModernInstalledProject(root, workflow, 'single-maintainer-gitflow', {
    ...options, activeLayout: { schemaVersion: 1, state: 'bound', bindings: [
      ...[...components].map(([component, pathParts]) => ({ kind: 'component' as const, component, pathParts })),
      { kind: 'artifact', logicalName: 'docker-compose', pathParts: ['compose.yml'] }
    ] }
  });
  await writeModernLocalFixtureInputs(f.input.selection, components, ['compose.yml'], f.write);
  return f;
}
async function publicJourney(root: string, kind: string, initialized = false) {
  const files = await inputFiles(root, kind, initialized), before = await originalFiles(root);
  const planned = await invoke(root, ['plan', '--inputs', files.request]);
  expect(planned.code, planned.stdout + planned.stderr).toBe(0);
  const key = planned.report.fingerprint;
  expect(key).toMatch(/^[a-f0-9]{64}$/u);
  const store = createLocalExecutionRecordStore(root);
  expect(await store.read('consent', key)).toBeNull(); expect(await store.readState(key)).toBeNull();
  const approved = await invoke(root, ['approve', '--plan', key, '--inputs', files.consent]);
  expect(approved.code, approved.stdout + approved.stderr).toBe(0);
  expect(await store.readState(key)).toBeNull();
  const held = await invoke(root, ['apply-next', '--plan', key]);
  expect(held.report.executionRequested).toBe(false); expect(await store.readState(key)).toBeNull();
  const result = await invoke(root, ['apply-next', '--plan', key, '--execute']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.report).toMatchObject({ localComplete: false, publicationAuthorized: false, operationComplete: true,
    verificationComplete: !initialized, result: { complete: true, inputsUnchanged: true, cleanupComplete: true, retainedWorkspace: null } });
  expect(await originalFiles(root)).toEqual(before);
  const observed = await invoke(root, ['apply-next', '--plan', key, '--execute=false']);
  expect(observed.report).toMatchObject({ verificationComplete: false, recordedProgressIsCurrentProof: false,
    inspection: { status: 'retained', result: { complete: true } } });
  console.info('PUBLIC_LOCAL_ACTUAL ' + JSON.stringify({ kind, planned: planned.report, approved: approved.report, result: result.report }));
  return result;
}

describe('actual public modern local verification', () => {
  nativeIt.each(['manual', 'spec-kit'] as const)('executes the real %s public plan/approve/apply-next path', async workflow => {
    nativeCases.push(workflow);
    await publicJourney((await baseline(workflow)).root, 'verify-local');
  }, 180000);
  nativeIt('executes the real complete active OpenSpec public path', async () => {
    nativeCases.push('openspec');
    const f = await createOpenSpecExecutionFixture(roots);
    await publicJourney(f.root, 'verify-openspec-local');
  }, 180000);
  nativeIt('preserves initialized OpenSpec scope rather than claiming domain verification', async () => {
    nativeCases.push('initialized');
    const f = await createOpenSpecExecutionFixture(roots);
    const plan = buildProjectPlan({ projectName: f.manifest.project.name, projectType: 'standard', apiStack: 'node-fastify',
      cloud: 'azure', region: 'eastus', includeFrontend: true, environments: ['dev'], specWorkflow: 'openspec',
      agents: ['github-copilot'], copilotCloud: false, governanceProfile: 'none' }, { requireProjectName: true });
    const base = ['openspec', 'changes', selected];
    await f.put(['openspec', 'config.yaml'], renderOpenSpecConfig(plan));
    for (const [file, content] of [['proposal.md', renderSeedProposal(plan)], ['design.md', renderSeedDesign(plan)],
      ['tasks.md', renderSeedTasks(plan)], [`specs/${capability}/spec.md`, renderSeedSpec(plan)]]) {
      await f.put([...base, ...file.split('/')], content);
    }
    const result = await publicJourney(f.root, 'verify-openspec-initialized', true);
    expect(result.report).toMatchObject({ status: 'initialization-obligations-observed', verificationScope: 'generated-initialization-obligations' });
  }, 180000);
  nativeIt('validates archived OpenSpec through the exact public archive mode without rewriting history', async () => {
    nativeCases.push('archived');
    const f = await createOpenSpecExecutionFixture(roots), archive = `2026-10-01-${selected}`;
    await fs.rename(path.join(f.root, 'openspec', 'changes', selected), path.join(f.root, 'openspec', 'changes', 'archive', archive));
    await f.put(['openspec', 'changes', 'archive', archive, 'tasks.md'], '- [x] 1.1 Review source.\n- [x] 1.2 Historical task; not execution proof.\n');
    await f.put(['openspec', 'specs', capability, 'spec.md'], spec('Preserve ' + capability));
    await f.put(['openspec', 'config.yaml'], 'schema: spec-driven\ngithubCopilot:\n  cloudAgent: false\ncontext: |\n  Preserve existing source.\nrules:\n  proposal:\n    - Preserve intent.\n  specs:\n    - Preserve requirements.\n');
    await publicJourney(f.root, 'verify-openspec-archived');
  }, 180000);
  nativeIt('refuses missing consent and stale approved source before an execution claim', async () => {
    nativeCases.push('stale');
    const f = await baseline('manual'), files = await inputFiles(f.root);
    const planned = await invoke(f.root, ['plan', '--inputs', files.request]);
    expect(planned.code, planned.stdout).toBe(0);
    const key = planned.report.fingerprint, store = createLocalExecutionRecordStore(f.root);
    const denied = await invoke(f.root, ['apply-next', '--plan', key, '--execute']);
    expect(denied.code).toBe(1); expect(await store.readState(key)).toBeNull();
    expect((await invoke(f.root, ['approve', '--plan', key, '--inputs', files.consent])).code).toBe(0);
    await f.write(['Source Space', 'backend', 'tests', 'source.txt'], 'Changed after explicit consent.\n');
    const before = await originalFiles(f.root), stale = await invoke(f.root, ['apply-next', '--plan', key, '--execute']);
    expect(stale.code).toBe(1); expect(stale.semantic).toBe('failure');
    expect(await store.readState(key)).toBeNull(); expect(await originalFiles(f.root)).toEqual(before);
  }, 180000);
  nativeIt('reports actual project test failure without leaking output or claiming completion', async () => {
    nativeCases.push('failure');
    const f = await baseline('manual');
    await f.write(['Source Space', 'backend', 'tests', 'source.test.js'], 'process.stdout.write("PRIVATE_PUBLIC_TEST_OUTPUT");process.exit(7);\n');
    const files = await inputFiles(f.root), before = await originalFiles(f.root);
    const planned = await invoke(f.root, ['plan', '--inputs', files.request]);
    expect(planned.code, planned.stdout).toBe(0);
    const key = planned.report.fingerprint;
    expect((await invoke(f.root, ['approve', '--plan', key, '--inputs', files.consent])).code).toBe(0);
    const result = await invoke(f.root, ['apply-next', '--plan', key, '--execute']);
    expect(result.code).toBe(1); expect(result.semantic).toBe('failure');
    expect(result.report).toMatchObject({ status: 'failed', verificationComplete: false, localComplete: false,
      result: { complete: false, inputsUnchanged: true, cleanupComplete: true, retainedWorkspace: null } });
    expect(result.report.result.checks.some((check: { status: string }) => check.status === 'failed')).toBe(true);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_PUBLIC_TEST_OUTPUT');
    expect(await originalFiles(f.root)).toEqual(before);
  }, 180000);
});
