import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { loadManifest, parseManifest } from '../src/application/project/manifest.js';
import type { LiftoffManifestV8 } from '../src/domain/project/contracts.js';
import { hasGeneratedWorkload, isApiManifestWorkload } from '../src/domain/project/manifest/applicability.js';
import { adoptionExecutionIdentity } from '../src/domain/project-evolution/adoption/identity.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { captureTreeState } from '../src/init-filesystem.js';
import {
  archiveGeneratedSeedForPhase, completeGeneratedSeedLifecycle, discoverGeneratedSeed,
  generatedSeedChangeName, inspectArchivedSeedIntegrity, missingGeneratedLocalEngine,
  previewLocalSeedPhase, seedInfrastructureBaselineBlocker, selectSeedBaselineChecks,
  validateGeneratedSeedForPhase, verifyGeneratedSeedBaselineForPhase
} from '../src/governance-activation/seed-lifecycle.js';
import { readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import { classifyGitHubWorkload } from '../src/governance-activation/github-discovery.js';
import type { CommandRunner } from '../src/process-runner.js';
import { liftoffVersion } from '../src/version.js';
import { runCommand } from '../src/commands.js';
import { parseArgs } from '../src/args.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function adoptedFixture(
  workflow: 'openspec' | 'spec-kit', workload: 'standard' | 'genai' | 'components'
) {
  const root = await realpath(await createFixtureProject({
    projectName: 'Recorded API facts', projectType: workload === 'genai' ? 'genai' : 'standard',
    apiStack: workload === 'genai' ? 'python-fastapi' : 'node-fastify',
    ...(workload === 'genai' ? { pattern: 'chatbot' } : {}),
    specWorkflow: workflow, agents: ['codex'], ...(workflow === 'spec-kit' ? { defaultAgent: 'codex' } : {}),
    environments: ['dev'], includeFrontend: false
  }));
  roots.push(path.dirname(root));
  const original = await loadManifest(root);
  if (original.artifactVersion !== 8) throw new Error('Expected the actual current generated manifest.');
  const seedName = generatedSeedChangeName(original);
  const recordId = canonicalSha256({ fixture: 'adopted-governance', root, workflow, workload });
  const observationDigest = canonicalSha256({ fixture: 'observed-source', root });
  const adopted: LiftoffManifestV8 = {
    ...original, projectArtifacts: [],
    ...(workload === 'components' ? {
      project: { ...original.project, workload: { kind: 'components' } as const }
    } : {}),
    provenance: { kind: 'adopted', recordId, observationDigest, repairs: [] }
  };
  const manifest = parseManifest(adopted);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(root, 'liftoff.manifest.json'), bytes);
  const identity = await lstat(root);
  const history = path.join(root, '.liftoff', 'adoption-history', recordId);
  await mkdir(history, { recursive: true });
  await writeFile(path.join(history, 'record.json'), JSON.stringify({
    schemaVersion: 1, kind: 'liftoff-adoption-record', ...adoptionExecutionIdentity(liftoffVersion),
    recordId, projectRoot: root,
    projectIdentity: { device: String(identity.dev), inode: String(identity.ino), birthtime: String(identity.birthtimeMs) },
    fingerprint: canonicalSha256('fixture-adoption-plan'), reviewedAt: '2026-09-15T08:00:00.000Z',
    standards: adopted.standards, assessmentDigest: observationDigest, source: [], effects: [],
    verification: { status: 'not-required', digest: null }, backup: null,
    authorization: { namespace: 'adoption-approval', fingerprint: canonicalSha256('fixture-adoption-plan'), boundary: 'exact-transaction-digest' },
    manifestHash: createHash('sha256').update(bytes).digest('hex'), activationEvidence: 'not-issued'
  }));
  expect(await loadManifest(root)).toEqual(manifest);
  const run = vi.fn(async () => { throw new Error('An adopted manifest cannot authorize a generated verification process.'); });
  const runner: CommandRunner = { run };
  return { root, manifest, original, seedName, runner, run };
}

describe('governance separates adopted API facts from generated seed authority', () => {
  it.each([
    ['openspec', 'standard'], ['spec-kit', 'standard'], ['openspec', 'genai'], ['spec-kit', 'genai'],
    ['openspec', 'components'], ['spec-kit', 'components']
  ] as const)('blocks %s seed lifecycle for adopted %s provenance without touching a lookalike seed', async (workflow, workload) => {
    const f = await adoptedFixture(workflow, workload);
    expect(hasGeneratedWorkload(f.manifest)).toBe(false);
    expect(isApiManifestWorkload(f.manifest.project.workload)).toBe(workload !== 'components');
    const before = await captureTreeState(f.root);
    expect(await discoverGeneratedSeed(f.root, f.manifest)).toEqual({
      state: 'blocked', changeName: null, issues: [missingGeneratedLocalEngine]
    });
    expect(await inspectArchivedSeedIntegrity(f.root, f.manifest)).toEqual({
      status: 'not-applicable', changeName: null, issues: []
    });
    expect(seedInfrastructureBaselineBlocker(f.manifest)).toBe(missingGeneratedLocalEngine);
    expect(() => generatedSeedChangeName(f.manifest)).toThrow(/missing-local-engine/);
    expect(() => selectSeedBaselineChecks(f.manifest)).toThrow(/missing-local-engine/);
    for (const phase of ['seed-valid', 'seed-verified', 'seed-archived'] as const) {
      await expect(previewLocalSeedPhase(f.root, f.manifest, phase)).rejects.toThrow(/missing-local-engine/);
    }
    for (const execute of [
      validateGeneratedSeedForPhase, verifyGeneratedSeedBaselineForPhase,
      archiveGeneratedSeedForPhase, completeGeneratedSeedLifecycle
    ]) {
      expect(await execute(f.root, f.runner)).toMatchObject({
        status: 'blocked', changeName: null, issues: [missingGeneratedLocalEngine]
      });
    }
    expect(f.run).not.toHaveBeenCalled();
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it('does not normalize adopted source files as generated seed evidence or reuse generated input authority', async () => {
    const f = await adoptedFixture('openspec', 'standard');
    const generated = await readActivationInputSnapshot(f.root, f.original, f.runner);
    const adopted = await readActivationInputSnapshot(f.root, f.manifest, f.runner);
    expect(generated.files.some((file) => file.path.startsWith('seed/'))).toBe(true);
    expect(adopted.files.some((file) => file.path.startsWith('seed/'))).toBe(false);
    expect(adopted.workflowSpecDigest).toBeUndefined();
    expect(adopted.project).toHaveProperty('generatedSeedAuthority', false);
    expect(adopted.baselineSha).not.toBe(generated.baselineSha);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('preserves valid adopted API discovery facts without inventing default backend paths or build/test commands', async () => {
    const f = await adoptedFixture('openspec', 'standard');
    const before = await captureTreeState(f.root);
    const report = await classifyGitHubWorkload({
      projectRoot: f.root, manifest: f.manifest
    });
    expect(report).toMatchObject({
      kind: 'standard', stack: 'node-fastify', environments: ['dev'], frontend: false,
      artifactKind: 'unknown', commandsExecutedByDiscovery: false, localBaseline: 'missing-local-engine',
      missing: [missingGeneratedLocalEngine], files: [], containers: []
    });
    expect(report).not.toHaveProperty('commands');
    expect(await captureTreeState(f.root)).toEqual(before);
  });

  it.each(['local', 'repository', 'activation'] as const)(
    'reports the missing adopted local engine through public %s verification without seed or provider effects', async (scope) => {
      const f = await adoptedFixture('openspec', 'standard');
      const before = await captureTreeState(f.root);
      const stdout = new CaptureStream(), stderr = new CaptureStream();
      const code = await runCommand(parseArgs(['governance', 'verify', '--json',
        ...(scope === 'activation' ? [] : ['--scope', scope])]), {
        cwd: f.root, runner: f.runner, stdout, stderr,
        env: { LIFTOFF_TELEMETRY_DISABLED: '1' },
        updatePreview: { homedir: path.dirname(f.root), repositoryRoot: f.root, env: {} }
      });
      const report = JSON.parse(stdout.text() || '{}');
      expect(code, stdout.text() + stderr.text()).toBe(2);
      expect(report).toMatchObject({ schemaVersion: 3, scope, consistent: true, complete: false });
      expect(stdout.text()).toContain('missing-local-engine');
      expect(report.nextReadyPhase).toBeNull();
      expect(f.run).not.toHaveBeenCalled();
      expect(await captureTreeState(f.root)).toEqual(before);
    }
  );

  it.each(['manifest-v2.json', 'manifest-v3.json', 'manifest-v4-genai.json',
    'manifest-v5-standard-released.json', 'manifest-v6-genai-released.json', 'manifest-v7-governed-released.json'])(
    'retains historical generated source applicability without rewriting %s', async (file) => {
      const filename = path.resolve('tests', 'fixtures', file);
      const bytes = await readFile(filename);
      const manifest = parseManifest(JSON.parse(bytes.toString('utf8')));
      expect(hasGeneratedWorkload(manifest)).toBe(true);
      expect(() => generatedSeedChangeName(manifest)).not.toThrow();
      expect(await readFile(filename)).toEqual(bytes);
    }
  );
});
