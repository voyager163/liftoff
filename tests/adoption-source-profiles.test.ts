import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { inspectAdoption } from '../src/application/project-evolution/adoption/planning.js';
import { adoptProject } from '../src/application/project-evolution/adoption/use-case.js';
import { ApplicationFiles } from '../src/application/repair/application-files.js';
import { inspectApplicationReferences } from '../src/application/repair/application-references.js';
import { createAdoptionVerificationWorkspace } from '../src/application/repair/workspaces.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { adoptionExecutionIdentity } from '../src/domain/project-evolution/adoption/identity.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { PresentationSession } from '../src/terminal.js';
import { buildArtifacts } from '../src/templates.js';
import {
  adoptionFixtureClock, adoptionFixtureProposal, adoptionFixtureStorage, createAdoptionFixture, invokeAdoptionFixture
} from './adoption-fixtures.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
const fastapi = 'from fastapi import FastAPI\napp = FastAPI()\n';
const genai = `${fastapi}from pydantic_ai import Agent\nagent = Agent()\n`;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('adoption current source profile observations', () => {
  it.each([
    { name: 'FastAPI requirements', profile: 'python-fastapi', supported: true, files: { 'requirements.txt': 'fastapi>=0.115\n', 'app.py': fastapi } },
    { name: 'FastAPI alias', profile: 'fastapi', supported: true, files: { 'requirements.txt': 'fastapi>=0.115\n', 'app.py': fastapi } },
    { name: 'FastAPI pyproject', profile: 'python-fastapi', supported: true, files: { 'pyproject.toml': '[project]\nname = "custom-api"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n', 'app.py': fastapi } },
    { name: 'missing pyproject dependencies', profile: 'python-fastapi', supported: false, files: { 'pyproject.toml': '[project]\nname = "custom-api"\n', 'app.py': fastapi } },
    { name: 'missing pyproject table', profile: 'python-fastapi', supported: false, files: { 'pyproject.toml': '[tool.example]\nname = "not-dependencies"\n', 'app.py': fastapi } },
    { name: 'malformed pyproject', profile: 'python-fastapi', supported: false, files: { 'pyproject.toml': '[project\nbroken', 'app.py': fastapi } },
    { name: 'non-array dependencies', profile: 'python-fastapi', supported: false, files: { 'pyproject.toml': '[project]\ndependencies = 42\n', 'app.py': fastapi } },
    { name: 'comment-only requirement', profile: 'python-fastapi', supported: false, files: { 'requirements.txt': '# fastapi>=0.115\n', 'app.py': fastapi } },
    { name: 'dependency without imports', profile: 'python-fastapi', supported: false, files: { 'requirements.txt': 'fastapi>=0.115\n', 'app.py': 'print("from fastapi import FastAPI")\n' } },
    { name: 'actual unsupported Flask source', profile: 'python-fastapi', supported: false, files: { 'requirements.txt': 'flask>=3\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' } },
    { name: 'GenAI requirements', profile: 'genai-generic', supported: true, files: { 'requirements.txt': 'fastapi>=0.115\npydantic-ai>=1\n', 'app.py': genai } },
    { name: 'GenAI pyproject', profile: 'genai-generic', supported: true, files: { 'pyproject.toml': '[project]\nname = "custom-agent"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115", "pydantic-ai>=1"]\n', 'app.py': genai } },
    { name: 'GenAI dependency missing', profile: 'genai-generic', supported: false, files: { 'requirements.txt': 'fastapi>=0.115\n', 'app.py': genai } },
    { name: 'GenAI import missing', profile: 'genai-generic', supported: false, files: { 'requirements.txt': 'fastapi>=0.115\npydantic-ai>=1\n', 'app.py': fastapi } }
  ])('admits only the independently observed framework for $name', async ({ files, profile, supported }) => {
    const current = await createAdoptionFixture(roots, files);
    const before = await readdir(current.root, { recursive: true });
    const run = vi.fn(async () => { throw new Error('Source observation cannot run a check or installer.'); });
    const result = await invokeAdoptionFixture(current, { profile, check: true }, { runner: { run } });
    expect(result.code, result.report.blockers.join(' ')).toBe(2);
    expect(result.report.status).toBe(supported ? 'planned' : 'blocked');
    expect(result.report.committed).toBe(false);
    expect(result.report.effects).toEqual({ preparationCommands: 0, projectCommands: 0, networkAuthorized: false, frameworkCommands: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(current.root, { recursive: true })).toEqual(before);
    for (const [name, bytes] of Object.entries(files)) expect(await readFile(path.join(current.root, name), 'utf8')).toBe(bytes);
    if (supported) {
      const inspection = await inspectAdoption({ project: current.root, profile, now: adoptionFixtureClock });
      expect(inspection.manifest.project.workload).toEqual({ kind: 'components' });
      for (const artifact of inspection.manifest.projectArtifacts) expect(artifact).not.toHaveProperty('generationHash');
    }
  });

  it('resolves the documented Vue alias without inventing a backend', async () => {
    const current = await createAdoptionFixture(roots);
    const result = await inspectAdoption({
      project: current.root, component: '.', profile: 'vue', now: adoptionFixtureClock
    });
    expect(result.plan.component.profile.id).toBe('vue-component');
    expect(result.plan.component.rootPathParts).toEqual([]);
    expect(result.manifest.project.workload).toEqual({ kind: 'components' });
    expect(await readdir(current.root)).toEqual(['App.vue', 'package.json']);
  });

  it('rejects a missing project or invalid clock before creating a preview', async () => {
    const current = await createAdoptionFixture(roots);
    await expect(inspectAdoption({ project: '', now: adoptionFixtureClock })).rejects.toThrow(/explicitly selected/);
    await expect(inspectAdoption({ project: current.root, now: new Date('invalid') })).rejects.toThrow(/clock is invalid/);
    expect(await readdir(current.home)).toEqual([]);
  });

  it.each(['absolute', 'windows-absolute', 'traversal'])('rejects an %s component boundary before inspecting it', async (kind) => {
    const current = await createAdoptionFixture(roots);
    const component = kind === 'absolute' ? current.parent : kind === 'windows-absolute' ? 'C:\\outside' : '../outside';
    await expect(inspectAdoption({
      project: current.root, profile: 'vue-component', component, now: adoptionFixtureClock
    })).rejects.toThrow(/relative|path|traversal/i);
    expect(await readdir(current.root)).toEqual(['App.vue', 'package.json']);
  });
});

describe('adoption exact referenced additions', () => {
  it.each(['absent', 'identical'] as const)('verifies and records an exact %s referenced addition using real candidate checks', async (precondition) => {
    const current = await createAdoptionFixture(roots);
    const feature = 'export { value } from "./value.mjs";\n';
    await writeFile(path.join(current.root, 'value.mjs'), 'export const value = 42;\n');
    await writeFile(path.join(current.root, 'check.mjs'),
      'import assert from "node:assert/strict";\nassert.equal((await import("./feature.mjs")).value, 42);\n');
    const mode = process.platform === 'win32' ? 0o666 : 0o600;
    if (precondition === 'identical') await writeFile(path.join(current.root, 'feature.mjs'), feature, { mode });
    await writeFile(path.join(current.staging, 'feature.mjs'), feature, { mode });
    const baseline = await inspectAdoption({ project: current.root, profile: 'vue-component', now: adoptionFixtureClock });
    const staged = await new ApplicationFiles(current.staging).read(['feature.mjs']);
    const candidate = baseline.application.snapshots.filter((file) => file.pathParts.join('/') !== 'feature.mjs');
    const outgoing = inspectApplicationReferences(
      [...candidate, staged], baseline.application.scope.directoryInventory
    ).filter((reference) => reference.sourcePathParts.join('/') === 'feature.mjs');
    expect(outgoing).toHaveLength(1);
    const proposal = await adoptionFixtureProposal(current);
    proposal.additions = [{
      logicalName: 'referenced-feature', componentId: baseline.plan.component.id,
      targetPathParts: ['feature.mjs'], stagedPathParts: ['feature.mjs'], targetMode: mode, precondition,
      references: outgoing.map((reference) => ({
        referenceId: reference.id, disposition: 'updated', afterTargetPathParts: reference.targetPathParts
      }))
    }];
    proposal.verification.commands = [{
      executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 8192, network: false
    }];
    const proposalPath = path.join(current.staging, 'proposal.json');
    await writeFile(proposalPath, JSON.stringify(proposal));
    const preview = await invokeAdoptionFixture(current, { proposal: proposalPath, check: true });
    expect(preview.report.blockers).toEqual([]);
    if (!preview.report.plan) throw new Error('Missing exact addition preview.');
    const verified = await invokeAdoptionFixture(current, { verifyPlan: preview.report.plan.fingerprint }, { runner: new NodeCommandRunner() });
    expect(verified.report.status, verified.report.blockers.join(' ')).toBe('verified');
    expect(await readdir(current.root)).not.toContain('liftoff.manifest.json');
    const committed = await invokeAdoptionFixture(current, { approvePlan: preview.report.plan.fingerprint });
    expect(committed.code, committed.report.blockers.join(' ')).toBe(0);
    const manifest = await loadManifest(current.root);
    const artifact = manifest.projectArtifacts.find((entry) => entry.logicalName === 'referenced-feature');
    expect(artifact).not.toHaveProperty('generationHash');
    expect(precondition === 'identical' ? artifact?.adoption : artifact?.addition).toBeDefined();
    expect(await readFile(path.join(current.root, 'feature.mjs'), 'utf8')).toBe(feature);
    expect(await readFile(path.join(current.root, 'value.mjs'), 'utf8')).toBe('export const value = 42;\n');
  });

  it.each(['missing', 'wrong-id', 'wrong-target'] as const)('blocks %s reference review before running checks or writing additions', async (condition) => {
    const current = await createAdoptionFixture(roots);
    await writeFile(path.join(current.root, 'value.mjs'), 'export const value = 42;\n');
    await writeFile(path.join(current.root, 'check.mjs'), 'process.exitCode = 0;\n');
    await writeFile(path.join(current.staging, 'feature.mjs'), 'export { value } from "./value.mjs";\n');
    const baseline = await inspectAdoption({ project: current.root, profile: 'vue-component', now: adoptionFixtureClock });
    const staged = await new ApplicationFiles(current.staging).read(['feature.mjs']);
    const reference = inspectApplicationReferences(
      [...baseline.application.snapshots, staged], baseline.application.scope.directoryInventory
    ).find((entry) => entry.sourcePathParts.join('/') === 'feature.mjs');
    if (!reference) throw new Error('Missing real candidate reference.');
    const proposal = await adoptionFixtureProposal(current);
    proposal.additions = [{
      logicalName: 'referenced-feature', componentId: baseline.plan.component.id,
      targetPathParts: ['feature.mjs'], stagedPathParts: ['feature.mjs'],
      targetMode: process.platform === 'win32' ? 0o666 : 0o600, precondition: 'absent',
      references: condition === 'missing' ? [] : [{
        referenceId: condition === 'wrong-id' ? 'a'.repeat(64) : reference.id,
        disposition: 'updated', afterTargetPathParts: condition === 'wrong-target' ? ['other.mjs'] : reference.targetPathParts
      }]
    }];
    proposal.verification.commands = [{
      executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 1000, maxOutputBytes: 1024, network: false
    }];
    const proposalPath = path.join(current.staging, 'proposal.json');
    await writeFile(proposalPath, JSON.stringify(proposal));
    const run = vi.fn(async () => { throw new Error('Unreviewed references cannot authorize a check.'); });
    const result = await invokeAdoptionFixture(current, { proposal: proposalPath, check: true }, { runner: { run } });
    expect(result.code).toBe(1);
    expect(result.report.blockers.join(' ')).toMatch(/reference|candidate target/);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(current.root)).not.toContain('feature.mjs');
    expect(await readdir(current.root)).not.toContain('liftoff.manifest.json');
  });
});

describe('adoption cooperating writers and readback', () => {
  it('keeps non-TTY human mode default-No without depending on an injected clock', async () => {
    const current = await createAdoptionFixture(roots);
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const code = await adoptProject({ project: current.root, profile: 'vue-component' }, {
      cwd: current.parent, stdout, stderr, env: {},
      presentation: new PresentationSession({ stdout, stderr }),
      updatePreview: { homedir: current.home, repositoryRoot: current.root }
    });
    expect(code).toBe(2);
    expect(stdout.text()).toContain('not committed');
    expect(await readdir(current.root)).toEqual(['App.vue', 'package.json']);
  });

  it('refuses an existing generated manifest even when its application files are customized', async () => {
    const current = await createAdoptionFixture(roots);
    const plan = buildProjectPlan({
      projectName: 'existing-generated', projectType: 'standard', apiStack: 'node-fastify',
      includeFrontend: false, governanceProfile: 'none'
    }, { requireProjectName: true });
    const marker = buildArtifacts(plan).find((artifact) => artifact.logicalName === 'manifest');
    if (!marker) throw new Error('Missing real generated manifest.');
    await writeFile(path.join(current.root, 'liftoff.manifest.json'), marker.content);
    const result = await invokeAdoptionFixture(current, { profile: 'vue-component', check: true });
    expect(result.code).toBe(1);
    expect(result.report.blockers.join(' ')).toMatch(/existing manifest|uninitialized adoption source/);
    expect(await readFile(path.join(current.root, 'liftoff.manifest.json'), 'utf8')).toBe(marker.content);
  });

  it('respects an already held cooperating project lock', async () => {
    const current = await createAdoptionFixture(roots);
    await withProjectMutationLock(current.root, async () => {
      const result = await invokeAdoptionFixture(current, { profile: 'vue-component', check: true });
      expect(result.code).toBe(1);
      expect(result.report.blockers.join(' ')).toMatch(/cooperating writer/);
      expect(await readdir(current.root)).not.toContain('liftoff.manifest.json');
    });
  });

  it('blocks new adoption while a real registered verification workspace is owned', async () => {
    const current = await createAdoptionFixture(roots);
    await writeFile(path.join(current.root, 'check.mjs'), 'process.exitCode = 0;\n');
    const proposal = await adoptionFixtureProposal(current);
    proposal.verification.commands = [{
      executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 1000, maxOutputBytes: 1024, network: false
    }];
    const proposalPath = path.join(current.staging, 'proposal.json');
    await writeFile(proposalPath, JSON.stringify(proposal));
    const inspection = await inspectAdoption({
      project: current.root, proposal: proposalPath, now: adoptionFixtureClock,
      storage: adoptionFixtureStorage(current), runner: new NodeCommandRunner()
    });
    const workspace = await createAdoptionVerificationWorkspace(current.root, {
      planFingerprint: inspection.plan.fingerprint, adoptionIdentity: adoptionExecutionIdentity(inspection.plan.cliVersion),
      patchStagingRoot: current.staging,
      bindings: {
        inputDigest: inspection.plan.inspectionDigest, verificationPolicyDigest: inspection.plan.verificationDigest,
        providerDigest: canonicalSha256(inspection.application.scope.preparation), toolchainDigest: inspection.plan.toolchainDigest
      },
      approvedScopes: { projectCode: true, dependencyPreparation: false, network: false, lifecycle: false }
    }, adoptionFixtureStorage(current));
    try {
      const result = await invokeAdoptionFixture(current, { profile: 'vue-component', check: true });
      expect(result.code).toBe(1);
      expect(result.report.blockers.join(' ')).toMatch(/private verification workspaces block/);
      expect(await readdir(current.root)).not.toContain('liftoff.manifest.json');
    } finally {
      await workspace.releaseOwner();
      expect((await workspace.cleanup()).cleanupComplete).toBe(true);
    }
  });

  it('preserves missing committed metadata and refuses recovery without an attributable journal', async () => {
    const current = await createAdoptionFixture(roots);
    const preview = await invokeAdoptionFixture(current, { profile: 'vue-component', check: true });
    if (!preview.report.plan) throw new Error('Missing metadata preview.');
    expect((await invokeAdoptionFixture(current, { approvePlan: preview.report.plan.fingerprint })).code).toBe(0);
    const marker = await readFile(path.join(current.root, 'liftoff.manifest.json'));
    const history = path.join(current.root, '.liftoff', 'adoption-history', preview.report.plan.recordId, 'record.json');
    const original = await readFile(history);
    await rm(path.join(current.root, 'liftoff.config.json'));
    const repeated = await invokeAdoptionFixture(current, {});
    expect(repeated.code).toBe(2);
    expect(repeated.report.status).toBe('incomplete');
    expect(repeated.report.blockers).toContain('liftoff.config.json');
    const recovery = await invokeAdoptionFixture(current, { recover: true });
    expect(recovery.code).toBe(1);
    expect(recovery.report.blockers.join(' ')).toMatch(/cannot rewrite newer bytes/);
    expect(await readFile(path.join(current.root, 'liftoff.manifest.json'))).toEqual(marker);
    expect(await readFile(history)).toEqual(original);
    expect(await readdir(current.root)).not.toContain('liftoff.config.json');
  });

  it('treats recovery of a matching completed adoption as a read-only no-op', async () => {
    const current = await createAdoptionFixture(roots);
    const preview = await invokeAdoptionFixture(current, { profile: 'vue-component', check: true });
    if (!preview.report.plan) throw new Error('Missing metadata preview.');
    expect((await invokeAdoptionFixture(current, { approvePlan: preview.report.plan.fingerprint })).code).toBe(0);
    const marker = await readFile(path.join(current.root, 'liftoff.manifest.json'));
    const recovery = await invokeAdoptionFixture(current, { recover: true });
    expect(recovery.code, recovery.report.blockers.join(' ')).toBe(0);
    expect(recovery.report.status).toBe('recovered');
    expect(await readFile(path.join(current.root, 'liftoff.manifest.json'))).toEqual(marker);
  });
});
