import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import {
  activationStateFilePathParts,
  canonicalJson,
  canonicalPhaseGraph,
  canonicalPhaseContractDigests,
  canonicalSha256,
  currentActivationIdentity,
  createActivationIdentity,
  evidenceContextForPhase,
  phaseContractDigests,
  phaseIds,
  planHistoricalActivationStateMigration,
  preservingPhaseContractMappings,
  validateGovernanceCompatibilityMetadata,
  historicalActivationIdentities,
  validateActivationIdentity,
  validateReadableActivationIdentity,
  validateManifestActivationForExecution,
  minimumLiftoffForManifestV7,
  executeApplyNext,
  type GovernanceTransitionInspection
} from '../src/governance-activation/index.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import type {
  EvidenceHeader,
  HistoricalActivationStateMigration,
  ManagedPhaseGraph,
  PhaseId,
  UserActivationState
} from '../src/governance-activation/index.js';
import { CaptureStream } from './helpers.js';
import { applyProjectFileTransaction } from '../src/adapters/filesystem/project-transaction.js';
import { writeArtifacts } from '../src/adapters/filesystem/project-files.js';
import { createManifestReader } from '../src/domain/project/manifest/reader.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { governanceArtifactPaths, governancePolicyVersion } from '../src/repository-governance.js';
import { inspectCurrentActivationEvidence } from '../src/governance-activation/read-only.js';
import { governanceDoctorChecks } from '../src/governance-activation/doctor.js';

const scratchRoot = path.join(process.cwd(), '.cache', 'governance-migration-tests');
let counter = 0;

const testHistoricalPhaseGraph = {
  ...canonicalPhaseGraph,
  phases: canonicalPhaseGraph.phases.map((phase) =>
    phase.id === 'seed-valid'
      ? { ...phase, label: 'Test-only historical seed label' }
      : phase
  )
} as ManagedPhaseGraph;
const testHistoricalPhaseGraphHash = canonicalSha256(testHistoricalPhaseGraph);
const testHistoricalActivationIdentity = createActivationIdentity(testHistoricalPhaseGraphHash);

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
});

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function fixtureProject(workload: 'standard' | 'genai' = 'standard'): Promise<string> {
  counter += 1;
  const root = path.join(scratchRoot, `project-${process.pid}-${counter}`);
  const plan = buildProjectPlan({
    projectName: 'Migration App',
    projectType: workload,
    apiStack: workload === 'standard' ? 'node' : 'python',
    ...(workload === 'genai' ? { pattern: 'chatbot' } : {}),
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  }, { requireProjectName: true });
  await writeArtifacts(root, buildArtifacts(plan));
  return root;
}

async function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    env
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function editJson(pathname: string, mutate: (value: any) => void): Promise<void> {
  const value = JSON.parse(await readFile(pathname, 'utf8'));
  mutate(value);
  await writeJson(pathname, value);
}

async function downgradeManifest(root: string, artifactVersion: 2 | 3 | 4 | 5 | 6): Promise<void> {
  await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
    if (artifactVersion <= 5) {
      manifest.artifacts = [
        ...manifest.managedArtifacts,
        ...manifest.projectArtifacts.map((artifact: any) => ({
          logicalName: artifact.logicalName,
          category: artifact.category,
          pathParts: artifact.pathParts,
          contentHash: artifact.generationHash
        }))
      ];
      delete manifest.managedArtifacts;
      delete manifest.projectArtifacts;
    }
    if (artifactVersion <= 4) {
      manifest.artifacts = manifest.artifacts.filter((artifact: { category: string }) => artifact.category !== 'governance');
      delete manifest.governance;
    } else {
      delete manifest.governance.activationIdentity;
    }
    if (artifactVersion <= 3) {
      const project = manifest.project;
      const workload = project.workload;
      manifest.project = {
        name: project.name,
        ...(workload.kind === 'standard' || artifactVersion === 3
          ? { projectType: workload.kind, apiStack: workload.apiStack }
          : {}),
        ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
        cloud: workload.cloud,
        region: workload.region,
        frontend: workload.frontend,
        environments: workload.environments,
        specWorkflow: project.specWorkflow,
        ...(artifactVersion === 3 ? { agents: project.agents } : {})
      };
    }
    if (artifactVersion === 2) {
      delete manifest.framework;
    }
    manifest.artifactVersion = artifactVersion;
  });
  if (artifactVersion <= 4) {
    await rm(path.join(root, '.liftoff', 'governance'), { recursive: true, force: true });
    await rm(path.join(root, '.github', 'prompts', 'liftoff-setup.prompt.md'), { force: true });
    await rm(path.join(root, '.github', 'prompts', 'liftoff-repository-governance.prompt.md'), { force: true });
    await rm(path.join(root, '.claude', 'commands', 'liftoff-setup.md'), { force: true });
    await rm(path.join(root, '.claude', 'commands', 'liftoff-repository-governance.md'), { force: true });
  }
}

function stateWithIdentity(identity = testHistoricalActivationIdentity): UserActivationState {
  const phases = Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
    state: phaseId === 'seed-valid' ? 'verified' : 'pending',
    updatedAt: '2026-09-04T00:00:00.000Z',
    evidence: phaseId === 'seed-valid'
      ? [{
          phaseId,
          evidenceId: 'seed-valid-historical',
          headerDigest: 'a'.repeat(64),
          result: 'verified'
        }]
      : [],
    approvals: [],
    blockers: []
  }])) as unknown as UserActivationState['phases'];
  return {
    schemaVersion: identity.activationStateSchemaVersion,
    identity,
    repository: {
      id: 'R_migration',
      name: 'owner/migration-app',
      defaultBranch: 'develop'
    },
    activeChange: null,
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: true,
      credentialRequired: false
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z'
  };
}

function evidenceHeader(phaseId: PhaseId): EvidenceHeader {
  const context = evidenceContextForPhase(phaseId, {
    repositoryId: 'R_migration',
    identity: testHistoricalActivationIdentity,
    phaseGraphHash: testHistoricalActivationIdentity.phaseGraphHash,
    baselineSha: 'b'.repeat(64),
    inputDigest: 'c'.repeat(64),
    transitionDigest: 'd'.repeat(64)
  });
  return {
    schemaVersion: testHistoricalActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: 'R_migration',
    identity: testHistoricalActivationIdentity,
    phaseGraphHash: testHistoricalActivationIdentity.phaseGraphHash,
    phaseId,
    phaseContractDigest: canonicalPhaseContractDigests[phaseId],
    inputDigest: context.inputDigest,
    baselineSha: context.baselineSha,
    transition: context.transition,
    producedAt: '2026-09-04T00:00:00.000Z',
    producer: 'vitest',
    bodyDigest: canonicalSha256({ payload: null, liveReadback: [] }),
    result: 'verified'
  };
}

async function installHistoricalState(root: string): Promise<void> {
  const header = evidenceHeader('seed-valid');
  const state = stateWithIdentity();
  state.phases['seed-valid'] = {
    ...state.phases['seed-valid'],
    evidence: [{
      phaseId: 'seed-valid',
      evidenceId: 'seed-valid-historical',
      headerDigest: canonicalSha256(header),
      result: 'verified'
    }]
  };
  await writeJson(path.join(root, ...activationStateFilePathParts), state);
  await writeJson(path.join(root, 'governance', 'evidence', 'seed-valid-historical.json'), {
    evidenceId: 'seed-valid-historical',
    header
  });
}

async function treeFingerprint(root: string): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  const visit = async (parts: string[]): Promise<void> => {
    const directory = path.join(root, ...parts);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        const content = await readFile(path.join(root, ...child));
        fingerprints.set(child.join('/'), createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  await visit([]);
  return new Map([...fingerprints.entries()].sort((left, right) => left[0].localeCompare(right[0], 'en')));
}

function testHistoricalStateMigration(): HistoricalActivationStateMigration {
  const fromDigests = phaseContractDigests(testHistoricalPhaseGraph);
  const graphMapping = {
    fromGraphHash: testHistoricalPhaseGraphHash,
    toGraphHash: currentActivationIdentity.phaseGraphHash,
    fromIdentity: testHistoricalActivationIdentity,
    toIdentity: currentActivationIdentity,
    phaseMappings: preservingPhaseContractMappings().map((mapping) => ({
      ...mapping,
      fromContractDigest: fromDigests[mapping.phaseId]
    })),
    preservation: 'phase-contract-digest' as const
  };
  return {
    fromIdentity: testHistoricalActivationIdentity,
    toIdentity: currentActivationIdentity,
    stateSchemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    graphMapping,
    transaction: 'managed-update-write-set',
    evidence: 'preserve-bytes',
    unversionedImport: 'requires-explicit-import-mapping'
  };
}

async function planTestHistoricalMigration(root: string) {
  return planHistoricalActivationStateMigration(
    root,
    '2026-09-04T00:00:00.000Z',
    { historicalStateMigrations: [testHistoricalStateMigration()] }
  );
}

describe('governance managed migration framework', () => {
  it.each(['historical', 'future', 'mixed'] as const)('describes %s doctor incompatibility without mislabeling it as v1', async (kind) => {
    const root = await fixtureProject();
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const state = stateWithIdentity(kind === 'historical' ? historicalActivationIdentities[0] : currentActivationIdentity);
    if (kind === 'future') state.schemaVersion = currentActivationIdentity.activationStateSchemaVersion + 1;
    if (kind === 'mixed') state.identity = { ...state.identity, evidenceHeaderSchemaVersion: 1 };
    await writeJson(path.join(root, ...activationStateFilePathParts), state);
    const before = await treeFingerprint(root);
    const check = (await governanceDoctorChecks(root, manifest)).find((entry) => entry.id === 'governance-identity-incompatible');
    expect(check?.remedy).toMatch(/^Preserve user-owned state and evidence bytes\./);
    expect(check?.remedy?.includes('Historical activation v1')).toBe(kind === 'historical');
    expect(await treeFingerprint(root)).toEqual(before);
  });

  it('separates readable historical metadata from executable identity and rejects mixed or unknown tuples', () => {
    expect(validateReadableActivationIdentity(currentActivationIdentity)).toEqual(currentActivationIdentity);
    const historical = historicalActivationIdentities[0];
    const input = structuredClone(historical);
    const before = JSON.stringify(input);
    expect(validateReadableActivationIdentity(input)).toEqual(historical);
    expect(JSON.stringify(input)).toBe(before);
    expect(validateReadableActivationIdentity(input)).not.toBe(input);
    expect(() => validateActivationIdentity(input)).toThrow(/diagnostic-only/);
    for (const invalid of [
      { ...historical, evidenceHeaderSchemaVersion: 2 },
      { ...historical, phaseGraphHash: '9'.repeat(64) },
      { ...historical, liftoffVersion: '0.99.0' },
      { ...historical, extra: true },
      { ...currentActivationIdentity, activationContractVersion: 3 }
    ]) expect(() => validateReadableActivationIdentity(invalid)).toThrow();
  });

  it.each(['standard', 'genai'] as const)('reads a known v1 %s manifest through the injected reader without granting execution or scope', async (workload) => {
    const root = await fixtureProject(workload);
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    raw.governance.activationIdentity = historicalActivationIdentities[0];
    await writeJson(manifestPath, raw);
    const before = await treeFingerprint(root);
    const reader = createManifestReader({
      catalog: projectCatalog, policyVersion: governancePolicyVersion, minimumLiftoffVersion: minimumLiftoffForManifestV7,
      validateActivationIdentity: validateReadableActivationIdentity,
      governanceArtifactPaths: new Map<string, readonly string[]>([
        ['repository-governance-policy', governanceArtifactPaths.policy],
        ['repository-governance-context', governanceArtifactPaths.context],
        ['repository-governance-guide', governanceArtifactPaths.guide],
        ['repository-governance-phase-graph', governanceArtifactPaths.phaseGraph],
        ['repository-governance-compatibility', governanceArtifactPaths.compatibility],
        ['repository-governance-credential-policy-schema', governanceArtifactPaths.credentialPolicySchema],
        ['liftoff-setup-copilot', governanceArtifactPaths.setup['github-copilot']],
        ['liftoff-setup-claude', governanceArtifactPaths.setup.claude],
        ['liftoff-governance-assess-copilot', governanceArtifactPaths.assessment['github-copilot']],
        ['liftoff-governance-assess-claude', governanceArtifactPaths.assessment.claude]
      ])
    });
    const parsed = reader.parseManifest(raw);
    expect(parsed.artifactVersion).toBe(7);
    expect(parsed.project.workload.kind).toBe(workload);
    expect(parsed.governance).toMatchObject({ activationIdentity: historicalActivationIdentities[0] });
    expect(() => validateManifestActivationForExecution(parsed)).toThrow(/diagnostic-only/);
    await expect(inspectCurrentActivationEvidence(root, parsed)).rejects.toThrow(/diagnostic-only/);
    let reinspected = false;
    await expect(executeApplyNext({
      inspection: { projectRoot: root, manifest: parsed } as GovernanceTransitionInspection,
      reinspect: async () => { reinspected = true; throw new Error('Historical metadata cannot reach execution inspection.'); }
    })).rejects.toThrow(/diagnostic-only/);
    expect(reinspected).toBe(false);
    expect(await treeFingerprint(root)).toEqual(before);
  });

  it('preserves known activation v1 as diagnostic-only even when an injected mapping is offered', async () => {
    const root = await fixtureProject();
    const historical = stateWithIdentity(historicalActivationIdentities[0]!);
    const statePath = path.join(root, ...activationStateFilePathParts);
    await writeJson(statePath, historical);
    const evidencePath = path.join(root, 'governance', 'evidence', 'preserved-v1.json');
    await writeJson(evidencePath, { schemaVersion: 1, identity: historical.identity, baselineSha: '0'.repeat(64) });
    const before = await readFile(statePath);
    const originalEvidence = await readFile(evidencePath);
    const offered = testHistoricalStateMigration();
    offered.fromIdentity = historical.identity;
    offered.graphMapping = { ...offered.graphMapping, fromIdentity: historical.identity, fromGraphHash: historical.identity.phaseGraphHash };
    const planned = await planHistoricalActivationStateMigration(root, '2026-09-04T00:00:00.000Z', {
      historicalStateMigrations: [offered]
    });
    expect(planned).toMatchObject({ status: 'blocked', mutations: [], report: { diagnosticOnly: true, evidencePolicy: 'preserve-bytes' } });
    for (const command of ['status', 'resume', 'apply-next']) {
      const result = await run(['governance', command, '--json', ...(command === 'apply-next' ? ['--execute'] : [])], root);
      expect(result.code).toBe(1);
      expect(result.out + result.err).toContain('diagnostic-only');
      expect(await readFile(statePath)).toEqual(before);
      expect(await readFile(evidencePath)).toEqual(originalEvidence);
    }
  });
  it('packages strict compatibility metadata with manifest/update inventory and no skill version', async () => {
    const root = await fixtureProject();
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const compatibilityArtifact = manifest.managedArtifacts.find(
      (artifact: { logicalName: string }) => artifact.logicalName === 'repository-governance-compatibility'
    );
    expect(compatibilityArtifact).toMatchObject({
      category: 'governance',
      pathParts: ['.liftoff', 'governance', 'compatibility.json']
    });
    const compatibilityContent = await readFile(path.join(root, ...compatibilityArtifact.pathParts), 'utf8');
    expect(`sha256:${createHash('sha256').update(compatibilityContent).digest('hex')}`)
      .toBe(compatibilityArtifact.contentHash);
    const compatibility = validateGovernanceCompatibilityMetadata(JSON.parse(compatibilityContent));
    expect(compatibility.schemaVersion).toBe(2);
    expect(compatibility.activation.historicalReadability.execution).toBe('diagnostic-only');
    expect(compatibility.manifest.readVersions).toEqual([2, 3, 4, 5, 6, 7]);
    expect(compatibility.manifest.writeVersion).toBe(7);
    expect(compatibility.activation.currentCompatibleTuples).toEqual([currentActivationIdentity]);
    expect(compatibility.activation.recognizedGraphHashes).toEqual([currentActivationIdentity.phaseGraphHash]);
    expect(compatibility.activation.graphMappings).toEqual([]);
    expect(compatibility.activation.historicalStateMigrations).toEqual([]);
    expect(compatibility.managedCore.validation.checkModeWritesBytes).toBe(0);
    expect(JSON.stringify(compatibility)).not.toMatch(/skillVersion|setupSkillVersion/);
  });

  it.each([2, 3, 4, 5, 6, 7] as const)(
    'reads manifest v%s in check mode and updates transactionally to v7',
    async (artifactVersion) => {
      const root = await fixtureProject();
      if (artifactVersion !== 7) {
        await downgradeManifest(root, artifactVersion);
      }
      const before = await treeFingerprint(root);

      const check = await run(['update', '--check', '--json'], root);
      expect([0, 2]).toContain(check.code);
      expect(await treeFingerprint(root)).toEqual(before);

      const applied = await run(['update', '--json'], root);
      expect(applied.code, `${applied.out}${applied.err}`).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
      expect(manifest.artifactVersion).toBe(7);
      expect(manifest.governance).toMatchObject({
        profile: 'single-maintainer-gitflow',
        policyVersion: '6',
        activationIdentity: currentActivationIdentity
      });
      expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
        artifact.logicalName === 'repository-governance-compatibility'
      )).toBe(true);
    }
  );

  it('blocks non-current versioned activation state by default without changing any byte', async () => {
    const root = await fixtureProject();
    await installHistoricalState(root);
    const before = await treeFingerprint(root);

    const result = await run(['update', '--json'], root);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.status).toBe('blocked');
    expect(report.activationStateMigration).toMatchObject({
      status: 'blocked',
      reasonCode: 'unsupported-activation-identity',
      path: 'governance/activation-state.json',
      checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes'
    });
    expect(report.activationStateMigration.issues.join(' ')).toMatch(/explicit compatibility\/migration mapping|declares no historical activation-state mappings/i);
    expect(await treeFingerprint(root)).toEqual(before);
  });

  it('previews an injected compatible v2 graph reconciliation without changing any byte', async () => {
    const root = await fixtureProject();
    await installHistoricalState(root);
    const before = await treeFingerprint(root);

    const plan = await planTestHistoricalMigration(root);

    expect(plan.report).toMatchObject({
      status: 'migrate',
      path: 'governance/activation-state.json',
      checkModeWritesBytes: 0,
      evidencePolicy: 'preserve-bytes'
    });
    expect(plan.status).toBe('migrate');
    expect(await treeFingerprint(root)).toEqual(before);
  });

  it('applies an injected v2 graph reconciliation transactionally while preserving evidence bytes', async () => {
    const root = await fixtureProject();
    await installHistoricalState(root);
    const evidencePath = path.join(root, 'governance', 'evidence', 'seed-valid-historical.json');
    const evidenceBefore = await readFile(evidencePath, 'utf8');

    const plan = await planTestHistoricalMigration(root);
    expect(plan.status).toBe('migrate');
    await applyProjectFileTransaction(root, plan.mutations, { preconditions: plan.preconditions });

    expect(plan.mutations.map((mutation) => mutation.pathParts.join('/'))).toEqual(expect.arrayContaining([
      'governance/activation-state.json',
      expect.stringMatching(/^governance\/reconciliation\//)
    ]));
    const state = JSON.parse(await readFile(path.join(root, ...activationStateFilePathParts), 'utf8'));
    expect(state.identity).toEqual(currentActivationIdentity);
    expect(state.phases['seed-valid'].state).toBe('verified');
    expect(await readFile(evidencePath, 'utf8')).toBe(evidenceBefore);
    const mapping = testHistoricalStateMigration().graphMapping;
    const reconciliationPath = path.join(
      root,
      'governance',
      'reconciliation',
      `${mapping.fromGraphHash.slice(0, 12)}-to-${mapping.toGraphHash.slice(0, 12)}.json`
    );
    const reconciliation = JSON.parse(await readFile(reconciliationPath, 'utf8'));
    expect(reconciliation).toMatchObject({
      fromGraphHash: mapping.fromGraphHash,
      toGraphHash: mapping.toGraphHash,
      fromIdentity: testHistoricalActivationIdentity,
      toIdentity: currentActivationIdentity,
      reconciledAt: expect.any(String),
      producer: 'liftoff-managed-update'
    });
    expect(reconciliation.phaseMappings.every((entry: { preserveEvidence: boolean }) =>
      entry.preserveEvidence
    )).toBe(true);
  });

  it('rolls back old state and reconciliation files when injected migration fails before every mutation', async () => {
    const probeRoot = await fixtureProject();
    await installHistoricalState(probeRoot);
    const mutationCount = (await planTestHistoricalMigration(probeRoot)).mutations.length;
    expect(mutationCount).toBeGreaterThan(1);

    for (const stage of Array.from({ length: mutationCount }, (_value, index) => index)) {
      const root = await fixtureProject();
      await installHistoricalState(root);
      const before = await treeFingerprint(root);

      const plan = await planTestHistoricalMigration(root);
      await expect(applyProjectFileTransaction(root, plan.mutations, {
        preconditions: plan.preconditions,
        onBeforeMutation: async (_mutation, index) => {
          if (index === stage) {
            throw new Error(`injected migration failure before mutation ${stage}`);
          }
        }
      })).rejects.toThrow(`injected migration failure before mutation ${stage}`);

      expect(await treeFingerprint(root)).toEqual(before);
    }
  });

  it('blocks ad hoc activation state without importing checkboxes, filenames, or prose', async () => {
    const root = await fixtureProject();
    await writeJson(path.join(root, ...activationStateFilePathParts), {
      tasks: ['[x] provider ready'],
      evidence: ['governance/evidence/provider-ready.json'],
      prose: 'looks done'
    });
    const before = await treeFingerprint(root);

    const result = await run(['update', '--json'], root);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.status).toBe('blocked');
    expect(report.activationStateMigration.reasonCode).toBe('ad-hoc-state');
    expect(report.activationStateMigration.issues.join(' ')).toMatch(/checkboxes, filenames, and prose are not evidence/i);
    expect(await treeFingerprint(root)).toEqual(before);
  });

  it('rejects future activation-state schema without rewriting managed or user bytes', async () => {
    const root = await fixtureProject();
    await writeJson(path.join(root, ...activationStateFilePathParts), {
      ...stateWithIdentity(currentActivationIdentity),
      schemaVersion: currentActivationIdentity.activationStateSchemaVersion + 1
    });
    const before = await treeFingerprint(root);

    const result = await run(['update', '--json'], root);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.status).toBe('blocked');
    expect(report.activationStateMigration.reasonCode).toBe('future-state-schema');
    expect(report.activationStateMigration.checkModeWritesBytes).toBe(0);
    expect(await treeFingerprint(root)).toEqual(before);
  });
});
