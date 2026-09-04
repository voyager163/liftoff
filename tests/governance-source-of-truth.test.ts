import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  canonicalSha256,
  currentActivationIdentity,
  deterministicGovernanceChangeId,
  governanceChangeMetadataFileName,
  inspectGovernanceSourceOfTruth,
  phaseContractDigests,
  phaseIds,
  reconcileActiveGovernanceChange,
  renderGovernanceChangeWritePlan,
  stateWithSelectedActiveChange,
  validateGovernanceChangeMetadata,
  writeGovernanceChangeArtifacts,
  type ApprovedPhase0Facts,
  type EvidenceHeader,
  type ManagedPhaseGraph,
  type PhaseEvidenceRecord,
  type UserActivationState
} from '../src/governance-activation/index.js';
import { renderCanonicalGovernancePolicy } from '../src/repository-governance.js';
import type { LiftoffManifest, SpecWorkflowId } from '../src/types.js';
import { liftoffVersion } from '../src/version.js';

const scratchRoot = path.join(process.cwd(), '.cache', 'governance-source-of-truth-tests');
const baselineSha = 'a'.repeat(64);
let counter = 0;

function nextRoot(name: string): string {
  counter += 1;
  return path.join(scratchRoot, `${name}-${process.pid}-${counter}`);
}

function manifest(projectName: string, workflowKind: SpecWorkflowId = 'openspec'): LiftoffManifest {
  return {
    artifactVersion: 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name: projectName,
      workload: {
        kind: 'standard',
        apiStack: 'node-fastify',
        cloud: 'azure',
        region: 'eastus',
        frontend: false,
        environments: ['dev']
      },
      specWorkflow: workflowKind,
      agents: ['github-copilot']
    },
    framework: {
      state: 'initialized',
      adapter: workflowKind,
      contractVersion: '1.0.0'
    },
    governance: {
      profile: 'single-maintainer-gitflow',
      policyVersion: '6',
      activationIdentity: currentActivationIdentity,
      state: 'handoff-partial'
    },
    managedArtifacts: [],
    projectArtifacts: []
  };
}

function state(overrides: Partial<UserActivationState> = {}): UserActivationState {
  const phases = Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
    state: 'pending',
    updatedAt: '2026-09-04T00:00:00.000Z',
    evidence: [],
    approvals: [],
    blockers: []
  }])) as UserActivationState['phases'];
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_123',
      name: 'owner/demo',
      defaultBranch: 'main'
    },
    activeChange: null,
    applicability: {
      statePath: 'none',
      privateStagingDast: false,
      credentialRequired: false
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  };
}

function facts(workflowKind: SpecWorkflowId = 'openspec'): ApprovedPhase0Facts {
  return {
    projectName: 'demo',
    repositoryId: 'R_123',
    repositoryName: 'owner/demo',
    defaultBranch: 'main',
    workflowKind,
    baselineSha,
    evidenceIds: ['phase0'],
    approvedFacts: [
      { id: 'repository.visibility', value: 'private' },
      { id: 'defaultBranch', value: 'main' }
    ],
    approvedAt: '2026-09-04T00:00:00.000Z',
    approver: 'owner'
  };
}

function phase0Evidence(): PhaseEvidenceRecord {
  const inputDigest = '1'.repeat(64);
  const transitionDigest = canonicalSha256({
    baselineSha,
    inputDigest,
    phaseId: 'phase-0-complete'
  });
  const header: EvidenceHeader = {
    schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
    repositoryId: 'R_123',
    identity: currentActivationIdentity,
    phaseGraphHash: canonicalPhaseGraphHash,
    phaseId: 'phase-0-complete',
    phaseContractDigest: phaseContractDigests(canonicalPhaseGraph)['phase-0-complete'],
    inputDigest,
    baselineSha,
    transition: {
      phaseId: 'phase-0-complete',
      baselineSha,
      inputDigest,
      transitionDigest
    },
    producedAt: '2026-09-04T00:00:00.000Z',
    producer: 'phase0-review',
    result: 'verified'
  };
  return { evidenceId: 'phase0', header };
}

async function writeProject(projectName: string, workflowKind: SpecWorkflowId = 'openspec'): Promise<string> {
  const root = nextRoot(projectName);
  await mkdir(path.join(root, '.liftoff', 'governance'), { recursive: true });
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(manifest(projectName, workflowKind), null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, '.liftoff', 'governance', 'policy.md'), renderCanonicalGovernancePolicy(), 'utf8');
  return root;
}

async function writePlan(root: string, plan = renderGovernanceChangeWritePlan(facts())): Promise<void> {
  await writeGovernanceChangeArtifacts(root, plan);
}

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
});

describe('governance active source-of-truth inspection', () => {
  it('blocks governance creation while the generated OpenSpec seed is unfinished', async () => {
    const root = await writeProject('seeded');
    await mkdir(path.join(root, 'openspec', 'changes', 'bootstrap-seeded'), { recursive: true });
    const result = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('seeded'),
      state: state(),
      evidence: []
    });
    expect(result.status).toBe('seed-blocked');
    expect(result.status === 'seed-blocked' ? result.blockers[0] : '').toContain('still active');
  });

  it('selects one compatible governance change repeatedly and prepares state recording for the next mutation', async () => {
    const root = await writeProject('demo');
    await writePlan(root);
    const first = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('demo'),
      state: state(),
      evidence: []
    });
    const second = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('demo'),
      state: state(),
      evidence: []
    });
    expect(first.status).toBe('selected');
    expect(second.status).toBe('selected');
    expect(first.status === 'selected' ? first.selected.changeId : '').toBe(renderGovernanceChangeWritePlan(facts()).changeId);
    expect(second.status === 'selected' ? second.selected.changeId : '').toBe(first.status === 'selected' ? first.selected.changeId : '');
    expect(first.status === 'selected' ? first.recordActiveChangeOnNextMutation : false).toBe(true);
    const updated = stateWithSelectedActiveChange(state(), first.status === 'selected' ? first.selected : second.status === 'selected' ? second.selected : neverCandidate());
    expect(updated.activeChange?.id).toBe(renderGovernanceChangeWritePlan(facts()).changeId);
  });

  it('blocks ambiguous compatible changes unless schema-valid supersession records select one', async () => {
    const root = await writeProject('demo');
    const first = renderGovernanceChangeWritePlan(facts());
    const secondFacts = { ...facts(), baselineSha: 'b'.repeat(64) };
    const second = renderGovernanceChangeWritePlan(secondFacts);
    await writePlan(root, first);
    await writePlan(root, second);

    const ambiguous = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('demo'),
      state: state(),
      evidence: []
    });
    expect(ambiguous.status).toBe('ambiguous');

    await mkdir(path.join(root, 'governance', 'supersessions'), { recursive: true });
    await writeFile(path.join(root, 'governance', 'supersessions', 'choose-second.json'), `${JSON.stringify({
      schemaVersion: currentActivationIdentity.supersessionSchemaVersion,
      identity: currentActivationIdentity,
      supersededChangeId: first.changeId,
      supersedingChangeId: second.changeId,
      reason: 'owner selected the second active source of truth',
      approvedAt: '2026-09-04T00:00:00.000Z',
      approver: 'owner'
    }, null, 2)}\n`, 'utf8');

    const selected = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('demo'),
      state: state(),
      evidence: []
    });
    expect(selected.status).toBe('selected');
    expect(selected.status === 'selected' ? selected.selected.changeId : '').toBe(second.changeId);

    await writeFile(path.join(root, 'governance', 'supersessions', 'invalid.json'), '{"schemaVersion":2}\n', 'utf8');
    const invalid = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('demo'),
      state: state(),
      evidence: []
    });
    expect(invalid.status).toBe('ambiguous');
    expect(invalid.status === 'ambiguous' ? invalid.blockers.join('\n') : '').toContain('invalid.json');
  });

  it('reports no active change as a deterministic create-change plan after seed archive', async () => {
    const root = await writeProject('archived');
    await mkdir(path.join(root, 'openspec', 'changes', 'archive', '20260904-bootstrap-archived'), { recursive: true });
    const result = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('archived'),
      state: state(),
      evidence: [phase0Evidence()]
    });
    expect(result.status).toBe('none');
    expect(result.status === 'none' ? result.createPlan : undefined).toMatchObject({
      status: 'ready',
      changeId: deterministicGovernanceChangeId({ ...facts(), projectName: 'archived' })
    });
  });

  it('uses only latest freshness-validated Phase 0 evidence to prepare governance creation', async () => {
    const root = await writeProject('phase0-freshness');
    await mkdir(path.join(root, 'openspec', 'changes', 'archive', '20260904-bootstrap-phase0-freshness'), { recursive: true });
    const staleVerified = phase0Evidence();
    staleVerified.evidenceId = 'phase0-stale';
    staleVerified.header.repositoryId = 'R_other';
    const olderFailure = phase0Evidence();
    olderFailure.evidenceId = 'phase0-older-failure';
    olderFailure.header.result = 'failed';
    olderFailure.header.producedAt = '2026-09-04T00:01:00.000Z';
    const currentVerified = phase0Evidence();
    currentVerified.evidenceId = 'phase0-current';
    currentVerified.header.producedAt = '2026-09-04T00:02:00.000Z';

    const staleOnly = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('phase0-freshness'),
      state: state(),
      evidence: [staleVerified]
    });
    expect(staleOnly.status === 'none' ? staleOnly.createPlan.status : '').toBe('blocked');

    const latestFailed = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('phase0-freshness'),
      state: state(),
      evidence: [currentVerified, { ...olderFailure, header: { ...olderFailure.header, producedAt: '2026-09-04T00:03:00.000Z' } }]
    });
    expect(latestFailed.status === 'none' ? latestFailed.createPlan.status : '').toBe('blocked');

    const recovered = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('phase0-freshness'),
      state: state(),
      evidence: [staleVerified, olderFailure, currentVerified]
    });
    expect(recovered.status === 'none' ? recovered.createPlan : undefined).toMatchObject({
      status: 'ready',
      changeId: deterministicGovernanceChangeId({ ...facts(), projectName: 'phase0-freshness' })
    });
  });

  it('blocks active changes that lack or mismatch the installed activation identity', async () => {
    const root = await writeProject('demo');
    const plan = renderGovernanceChangeWritePlan(facts());
    await writePlan(root, plan);
    const metadataPath = path.join(root, 'openspec', 'changes', plan.changeId, governanceChangeMetadataFileName);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { activationIdentity: { phaseGraphHash: string }; phaseGraphHash: string };
    metadata.activationIdentity.phaseGraphHash = '9'.repeat(64);
    metadata.phaseGraphHash = '9'.repeat(64);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    const result = await inspectGovernanceSourceOfTruth({
      projectRoot: root,
      manifest: manifest('demo'),
      state: state(),
      evidence: []
    });
    expect(result.status).toBe('incompatible');
    expect(result.status === 'incompatible' ? result.blockers.join('\n') : '').toContain('phaseGraphHash');
  });
});

describe('canonical governance change rendering and reconciliation', () => {
  it('renders strict OpenSpec metadata, proposal, design, spec, and task markers', async () => {
    const plan = renderGovernanceChangeWritePlan(facts());
    expect(plan.changeId).toBe('governance-demo-aaaaaaaaaaaa');
    expect(plan.files.map((file) => file.pathParts.join('/'))).toEqual([
      `openspec/changes/${plan.changeId}/.openspec.yaml`,
      `openspec/changes/${plan.changeId}/${governanceChangeMetadataFileName}`,
      `openspec/changes/${plan.changeId}/proposal.md`,
      `openspec/changes/${plan.changeId}/design.md`,
      `openspec/changes/${plan.changeId}/specs/liftoff-governance-activation/spec.md`,
      `openspec/changes/${plan.changeId}/tasks.md`
    ]);
    expect(() => validateGovernanceChangeMetadata(plan.metadata)).not.toThrow();
    expect(plan.files.find((file) => file.pathParts.at(-1) === 'tasks.md')?.content)
      .toContain('<!-- liftoff-phase: phase-0-complete -->');
    expect(plan.files.find((file) => file.pathParts.at(-1) === 'design.md')?.content)
      .toContain(currentActivationIdentity.phaseGraphHash);
  });

  it('rolls back governance change files and created directories through the project transaction', async () => {
    const root = await writeProject('transactional-write');
    const plan = renderGovernanceChangeWritePlan(facts());
    const brokenPlan = {
      ...plan,
      files: [
        { pathParts: ['rollback', 'created', 'first.txt'], content: 'first\n' },
        { pathParts: ['rollback', 'created', 'first.txt', 'child.txt'], content: 'child\n' }
      ]
    };

    await expect(writeGovernanceChangeArtifacts(root, brokenPlan))
      .rejects.toThrow(/rolled back|Unable to write governance change artifacts transactionally/);
    await expect(access(path.join(root, 'rollback'))).rejects.toThrow();
  });

  it('validates rendered OpenSpec change strictly when OpenSpec is available', async () => {
    const probe = spawnSync('openspec', ['--version'], { cwd: process.cwd(), encoding: 'utf8' });
    if (probe.status !== 0) {
      return;
    }
    const root = await writeProject('demo');
    await mkdir(path.join(root, 'openspec'), { recursive: true });
    await writeFile(path.join(root, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
    const plan = renderGovernanceChangeWritePlan(facts());
    await writePlan(root, plan);
    const validation = spawnSync('openspec', ['validate', plan.changeId, '--strict'], {
      cwd: root,
      encoding: 'utf8'
    });
    expect(`${validation.stdout}\n${validation.stderr}`).toContain(plan.changeId);
    expect(validation.status).toBe(0);
  });

  it('renders Spec Kit governance artifacts without inventing an OpenSpec change', () => {
    const plan = renderGovernanceChangeWritePlan(facts('spec-kit'));
    expect(plan.workflowKind).toBe('spec-kit');
    expect(plan.files.every((file) => file.pathParts[0] === 'specs')).toBe(true);
    expect(plan.files.some((file) => file.pathParts[0] === 'openspec')).toBe(false);
    expect(plan.files.map((file) => file.pathParts.at(-1))).toEqual([
      governanceChangeMetadataFileName,
      'spec.md',
      'plan.md',
      'tasks.md'
    ]);
  });

  it('preserves compatible predecessor evidence and invalidates only changed descendants', () => {
    const wrapperGraph = structuredClone(canonicalPhaseGraph) as ManagedPhaseGraph;
    wrapperGraph.phases.find((phase) => phase.id === 'seed-valid')!.label += '.';
    const wrapperHash = canonicalSha256(wrapperGraph);
    const wrapperMetadata = {
      ...renderGovernanceChangeWritePlan(facts()).metadata,
      activationIdentity: { ...currentActivationIdentity, phaseGraphHash: wrapperHash },
      phaseGraphHash: wrapperHash
    };
    const wrapperResult = reconcileActiveGovernanceChange({
      metadata: validateGovernanceChangeMetadata(wrapperMetadata),
      evidence: [],
      fromGraph: wrapperGraph,
      toGraph: canonicalPhaseGraph,
      recognizedGraphHashes: new Set([wrapperHash, canonicalPhaseGraphHash]),
      reconciledAt: '2026-09-05T00:00:00.000Z'
    });
    expect(wrapperResult.status).toBe('required');
    expect(wrapperResult.status === 'required' ? wrapperResult.preservedPhaseIds : []).toContain('seed-valid');
    expect(wrapperResult.status === 'required' ? wrapperResult.invalidPhaseIds : []).toEqual([]);
    expect(wrapperResult.status === 'required' ? wrapperResult.record.reconciledAt : '')
      .toBe('2026-09-05T00:00:00.000Z');

    const missingOldGraph = reconcileActiveGovernanceChange({
      metadata: validateGovernanceChangeMetadata(wrapperMetadata),
      evidence: [],
      recognizedGraphHashes: new Set([wrapperHash, canonicalPhaseGraphHash]),
      reconciledAt: '2026-09-05T00:00:00.000Z'
    });
    expect(missingOldGraph.status).toBe('blocked');
    expect(missingOldGraph.status === 'blocked' ? missingOldGraph.preservedPhaseIds : []).toEqual([]);
    expect(missingOldGraph.issues.join(' ')).toMatch(/no recognized source graph|explicit mapping/i);

    const changedGraph = structuredClone(canonicalPhaseGraph) as ManagedPhaseGraph;
    changedGraph.phases.find((phase) => phase.id === 'provider-ready')!
      .allowedMutations.local = ['write-evidence', 'write-local-state'];
    const changedHash = canonicalSha256(changedGraph);
    const changedMetadata = {
      ...renderGovernanceChangeWritePlan(facts()).metadata,
      activationIdentity: { ...currentActivationIdentity, phaseGraphHash: changedHash },
      phaseGraphHash: changedHash
    };
    const changedResult = reconcileActiveGovernanceChange({
      metadata: validateGovernanceChangeMetadata(changedMetadata),
      evidence: [],
      fromGraph: changedGraph,
      toGraph: canonicalPhaseGraph,
      recognizedGraphHashes: new Set([changedHash, canonicalPhaseGraphHash]),
      reconciledAt: '2026-09-05T00:00:00.000Z'
    });
    expect(changedResult.status).toBe('required');
    expect(changedResult.status === 'required' ? changedResult.invalidPhaseIds : []).toEqual(expect.arrayContaining([
      'provider-ready',
      'state-path-selected',
      'bootstrap-local',
      'remote-ready'
    ]));
    expect(changedResult.status === 'required' ? changedResult.invalidPhaseIds : []).not.toContain('seed-valid');
  });
});

function neverCandidate(): never {
  throw new Error('Expected selected candidate.');
}
