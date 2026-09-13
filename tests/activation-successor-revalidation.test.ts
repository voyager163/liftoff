import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ViteDevServer } from 'vite';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { writeArtifacts, writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import { buildArtifacts } from '../src/templates.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { phaseIds } from '../src/domain/governance/activation/types.js';
import { validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { generatedSeedCapabilityId, generatedSeedChangeName } from '../src/governance-activation/seed-lifecycle.js';
import { captureMigrationRetainedProjectInputs } from '../src/governance-activation/historical-inputs.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { LocalRevalidationPreview, LocalRevalidationProgress } from '../src/application/update/revalidation.js';
import { createActivationSuccessorRuntime } from './fixtures/activation-successor-runtime.js';

const roots = new Set<string>();
const cacheRoot = path.resolve('tests', `.activation-successor-loader-${process.pid}-${randomUUID()}`);
let loader: ViteDevServer;
let revalidation: typeof import('../src/application/update/revalidation.js');
let governance: typeof import('../src/governance-activation/commands.js');

beforeAll(async () => {
  loader = await createActivationSuccessorRuntime(cacheRoot);
  revalidation = await loader.ssrLoadModule('/src/application/update/revalidation.ts');
  governance = await loader.ssrLoadModule('/src/governance-activation/commands.ts');
});

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
afterAll(async () => {
  await loader?.close();
  await rm(cacheRoot, { recursive: true, force: true });
});

class LocalRunner implements CommandRunner {
  calls: ExternalCommand[] = [];
  constructor(private readonly before?: (command: ExternalCommand, options?: RunCommandOptions) => Promise<Partial<CommandResult> | void>) {}
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    if (['az', 'gh', 'curl'].includes(command.executable) ||
      command.executable === 'docker' && !command.args.includes('config') ||
      command.args.some((arg) => ['install', 'ci', 'init', 'archive', 'commit', 'push', 'apply', 'import', 'state'].includes(arg))) {
      throw new Error(`Forbidden provider, state, installation, or publication operation: ${command.executable} ${command.args.join(' ')}.`);
    }
    const result = await this.before?.(command, options);
    return {
      command, displayCommand: [command.executable, ...command.args].join(' '),
      status: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...result
    };
  }
}

async function fixture() {
  const root = path.resolve('tests', `.activation-successor-local-${process.pid}-${randomUUID()}`);
  roots.add(root);
  const plan = buildProjectPlan({
    projectName: 'Successor local proof', projectType: 'standard', apiStack: 'node',
    specWorkflow: 'openspec', agents: ['github-copilot'], environments: ['dev'], includeFrontend: false
  }, { requireProjectName: true });
  await writeArtifacts(root, buildArtifacts(plan));
  for (const marker of [...plan.framework.baseMarkers, ...plan.framework.agentMarkers['github-copilot']]) {
    await writeProjectFile(root, marker, 'official framework marker fixture\n');
  }
  const generated = await loadManifest(root);
  // A successor keeps its v2-era project provenance; only its control plane is v3.
  const manifest = {
    ...generated,
    projectArtifacts: generated.projectArtifacts.map((artifact) => ({ ...artifact, generatedBy: '0.11.3' }))
  };
  await writeProjectFile(root, ['liftoff.manifest.json'], JSON.stringify(manifest));
  const change = generatedSeedChangeName(manifest);
  const capability = generatedSeedCapabilityId(manifest.project.workload);
  const active = path.join(root, 'openspec', 'changes', change);
  const archive = path.join(root, 'openspec', 'changes', 'archive', `20260901-${change}`);
  const spec = await readFile(path.join(active, 'specs', capability, 'spec.md'), 'utf8');
  await mkdir(path.dirname(archive), { recursive: true });
  await rename(active, archive);
  await writeProjectFile(root, ['openspec', 'specs', capability, 'spec.md'],
    `# ${capability}\n\n${spec.replace('## ADDED Requirements', '## Requirements')}`);
  await mkdir(path.join(root, 'backend', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev', '.terraform'), { recursive: true });
  const createdAt = '2026-09-01T00:00:00.000Z';
  const state = validateUserActivationState({
    schemaVersion: 3, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name: manifest.project.name, defaultBranch: 'develop' },
    activeChange: null, applicability: { statePath: 'none', privateStagingDast: 'unknown', credentialRequired: 'unknown' },
    phases: Object.fromEntries(phaseIds.map((id) => [id, {
      state: 'pending', updatedAt: createdAt, evidence: [], approvals: [], blockers: []
    }])), createdAt, updatedAt: createdAt
  });
  await writeProjectFile(root, ['governance', 'activation-state.json'], JSON.stringify(state));
  let ticks = 0;
  const clock = () => new Date(Date.parse('2026-09-12T00:00:00.000Z') + ticks++ * 1_000);
  return { root, manifest, state, clock };
}

async function preview(f: Awaited<ReturnType<typeof fixture>>, reuse = false) {
  const protectedSource = await captureMigrationRetainedProjectInputs(f.root);
  const binding = canonicalSha256(protectedSource);
  const inspection = reuse ? await governance.inspectGovernanceTransition(f.root, { runner: new LocalRunner(), now: f.clock(), scope: 'local' }) : undefined;
  const approvedPreview = await revalidation.previewLocalRevalidation({
    projectRoot: f.root, targetManifest: f.manifest, protectedInputBinding: binding, inspection
  });
  return {
    approvedPreview,
    protectedInputs: {
      binding,
      async assertUnchanged() {
        const actual = await captureMigrationRetainedProjectInputs(f.root);
        if (canonicalSha256(actual) !== binding) throw new Error('Protected source changed during local verification; edits were preserved.');
        return actual;
      }
    }
  };
}

describe('current-contract finite local revalidation without provider access', { timeout: 60_000 }, () => {
  it('produces fresh v3 body-bound proof for each local phase without re-archiving or installing anything', async () => {
    const f = await fixture();
    const before = await captureMigrationRetainedProjectInputs(f.root);
    const approved = await preview(f);
    const runner = new LocalRunner();
    const result = await revalidation.executeLocalRevalidation({ ...approved, runner, clock: f.clock });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'complete', nextIncompletePhase: 'committed' });
    expect(result.phaseResults.map((phase) => phase.phaseId)).toEqual(['seed-valid', 'seed-verified', 'seed-archived']);
    for (const phase of result.phaseResults) {
      expect(phase.status).toBe('verified');
      const record = JSON.parse(await readFile(path.join(f.root, ...phase.evidence!.pathParts), 'utf8'));
      expect(record.header).toMatchObject({ schemaVersion: 3, identity: currentActivationIdentity, scope: 'local' });
      expect(record.header.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(runner.calls.some((command) => command.executable === 'npm')).toBe(true);
    expect(await captureMigrationRetainedProjectInputs(f.root)).toEqual(before);
    const established = JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8'));
    const firstPlan = JSON.parse(await readFile(path.join(f.root, ...result.phaseResults[0].savedPlan!.pathParts), 'utf8'));
    expect(established.baselineAnchor).toBe(firstPlan.baselineDigest);
  });

  it('keeps earlier verified work and resumes only remaining finite checks after a failure', async () => {
    const f = await fixture();
    const progress: LocalRevalidationProgress[] = [];
    const first = await revalidation.executeLocalRevalidation({
      ...await preview(f), clock: f.clock,
      runner: new LocalRunner(async (command) => command.executable === 'npm' ? { status: 1, stderr: 'fixture baseline failed' } : undefined),
      onProgress(value) { progress.push(value); }
    });
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'blocked', phaseId: 'seed-verified' });
    expect(first.phaseResults[0]).toMatchObject({ phaseId: 'seed-valid', status: 'verified' });
    expect(progress.at(-1)?.status).toBe('blocked');
    const retry = await preview(f, true);
    expect(retry.approvedPreview.reusedPhases.map((phase) => phase.phaseId)).toEqual(['seed-valid']);
    const second = await revalidation.executeLocalRevalidation({ ...retry, runner: new LocalRunner(), clock: f.clock });
    expect(second, JSON.stringify(second)).toMatchObject({ status: 'complete' });
    expect(second.phaseResults[0]).toMatchObject({ phaseId: 'seed-valid', status: 'already-complete' });
    const clean = await preview(f, true);
    expect(clean.approvedPreview.phases).toHaveLength(0);
    const noCalls = new LocalRunner();
    expect(await revalidation.executeLocalRevalidation({ ...clean, runner: noCalls, clock: f.clock })).toMatchObject({ status: 'complete' });
    expect(noCalls.calls).toHaveLength(0);
  });

  it('preserves unexpected project-script edits and blocks affected proof', async () => {
    const f = await fixture();
    const result = await revalidation.executeLocalRevalidation({
      ...await preview(f), clock: f.clock,
      runner: new LocalRunner(async (command) => {
        if (command.executable === 'npm') await writeFile(path.join(f.root, 'backend', 'src', 'index.ts'), 'project-script edit; do not roll this back\n');
      })
    });
    expect(result.status).toBe('blocked');
    expect(result.blockers.join(' ')).toContain('Protected source changed');
    expect(await readFile(path.join(f.root, 'backend', 'src', 'index.ts'), 'utf8')).toContain('do not roll this back');
    expect(JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8')).identity).toEqual(currentActivationIdentity);
  });

  it('rejects an expanded or incomplete phase inventory even with a recomputed internal fingerprint', async () => {
    const f = await fixture();
    const approved = await preview(f);
    const incomplete: LocalRevalidationPreview = { ...approved.approvedPreview, phases: approved.approvedPreview.phases.slice(1) };
    const { fingerprint: _fingerprint, ...semantic } = incomplete;
    incomplete.fingerprint = canonicalSha256(semantic);
    const runner = new LocalRunner();
    const result = await revalidation.executeLocalRevalidation({
      ...approved, approvedPreview: incomplete, clock: f.clock, runner
    });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.blockers.join(' ')).toContain('each local phase exactly once');
    expect(runner.calls).toHaveLength(0);
  });

  it('withholds sensitive command output before it can become current evidence or diagnostics', async () => {
    const f = await fixture();
    const privateOutput = 'Bearer DO_NOT_RETAIN_THIS_FIXTURE_CREDENTIAL';
    const result = await revalidation.executeLocalRevalidation({
      ...await preview(f), clock: f.clock,
      runner: new LocalRunner(async () => ({ stdout: privateOutput }))
    });
    expect(result.status).toBe('blocked');
    expect(result.blockers.join(' ')).toContain('prohibited sensitive output');
    expect(JSON.stringify(result)).not.toContain(privateOutput);
    expect(JSON.parse(await readFile(path.join(f.root, 'governance', 'activation-state.json'), 'utf8')).phases['seed-valid'].evidence).toHaveLength(0);
  });
});
