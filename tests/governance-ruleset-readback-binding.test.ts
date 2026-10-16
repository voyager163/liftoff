import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { loadManifest } from '../src/application/project/manifest.js';
import { buildArtifacts } from '../src/templates.js';
import {
  activationEvidenceContexts, canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity,
  evidenceBodyDigest, evidenceHeaderDigest, phaseIds, readActivationInputSnapshot,
  type GovernanceTransitionInspection, type LiveReadbackProof, type PhaseEvidenceRecord,
  type PhaseId, type UserActivationState
} from '../src/governance-activation/index.js';
import { buildSavedTransitionPlan } from '../src/governance-activation/transition-planning.js';
import { evidenceHeaderFor } from '../src/governance-activation/transition-records.js';
import { executeRulesetPhase } from '../src/governance-activation/phase-governance.js';
import type { PhaseAdapterExecutionInput, GitHubRulesetAdapter, GitHubRulesetWriteResult } from '../src/governance-activation/transition-ports.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { bindFixtureEvidence, fixtureHeader, fixtureRemoteBinding } from './governance-activation-fixtures.js';
import { ReadyInitRunner } from './helpers.js';

const scratch = path.join(process.cwd(), '.cache', `ruleset-reader-${process.pid}`);
const sourceDigest = 'b'.repeat(64);
const resourceId = '/repos/owner/repo/rulesets/1';
const originalNow = '2026-09-04T00:00:00.000Z';
let sequence = 0;
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

async function readerInput(): Promise<PhaseAdapterExecutionInput> {
  const root = path.join(scratch, String(++sequence));
  await mkdir(root, { recursive: true });
  const artifacts = buildArtifacts(buildProjectPlan({
    projectName: 'ruleset-reader', projectType: 'standard', apiStack: 'node', cloud: 'azure',
    specWorkflow: 'openspec', agents: ['copilot'], governanceProfile: 'single-maintainer-gitflow'
  }, { requireProjectName: true }));
  for (const artifact of artifacts) {
    const file = path.join(root, ...artifact.pathParts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, artifact.content);
  }
  const manifest = await loadManifest(root);
  const state: UserActivationState = {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: structuredClone(currentActivationIdentity),
    repository: { id: 'R_123', name: 'owner/repo', defaultBranch: 'develop' },
    remoteBinding: structuredClone(fixtureRemoteBinding),
    activeChange: null,
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
    phases: Object.fromEntries(phaseIds.map((phaseId): [PhaseId, UserActivationState['phases'][PhaseId]] => [phaseId, {
      state: 'pending', updatedAt: originalNow, evidence: [], approvals: [], blockers: []
    }])) as UserActivationState['phases'],
    createdAt: originalNow, updatedAt: originalNow
  };
  const now = new Date(originalNow);
  const contexts = activationEvidenceContexts(canonicalPhaseGraph, state, await readActivationInputSnapshot(root, manifest), now);
  const records: PhaseEvidenceRecord[] = [];
  const plans = [];
  for (const phaseId of ['workflow-source-ready', 'green-red-proof'] as const) {
    const payload = phaseId === 'workflow-source-ready'
      ? { kind: 'workflow-source-ready.v1', rulesetSourceDigest: sourceDigest }
      : { kind: 'green-red-proof.v1', green: { conclusion: 'success', checkName: 'required' },
        deliberateRed: { conclusion: 'failure', deliberate: true, checkName: 'required' } };
    const header = fixtureHeader(phaseId);
    const liveReadback: LiveReadbackProof[] = phaseId === 'green-red-proof' ? [{
      schemaVersion: header.schemaVersion, repositoryId: header.repositoryId,
      identity: header.identity, phaseGraphHash: header.phaseGraphHash, phaseId,
      baselineSha: header.baselineSha, inputDigest: header.inputDigest, transition: header.transition,
      observedAt: originalNow, provider: 'github', resourceType: 'ruleset', resourceId,
      sourceDigest, readbackDigest: sourceDigest, matches: true
    }] : [];
    const record: PhaseEvidenceRecord = {
      evidenceId: `${phaseId}-original`,
      header: { ...header, bodyDigest: evidenceBodyDigest(payload, liveReadback) },
      payload, liveReadback
    };
    const bound = await bindFixtureEvidence(root, state, record);
    records.push(bound.record);
    plans.push(bound.plan);
    const reference = { phaseId, evidenceId: record.evidenceId,
      headerDigest: evidenceHeaderDigest(bound.record.header), result: bound.record.header.result };
    contexts[phaseId].evidenceReferences = [reference];
    state.phases[phaseId].evidence = [reference];
  }
  for (const phaseId of phaseIds) contexts[phaseId].reviewedPlans = plans;
  const inspection: GovernanceTransitionInspection = {
    projectRoot: root, manifest, graph: structuredClone(canonicalPhaseGraph), graphHash: canonicalPhaseGraphHash,
    state, approvals: [], evidence: records, contexts,
    readiness: {
      nextReadyPhase: 'live-readback',
      phases: Object.fromEntries(phaseIds.map((phaseId): [PhaseId, GovernanceTransitionInspection['readiness']['phases'][PhaseId]] => [phaseId, {
        state: phaseId === 'live-readback' ? 'ready' : 'blocked', blockers: []
      }])) as GovernanceTransitionInspection['readiness']['phases']
    },
    sourceOfTruth: {
      status: 'none', selected: null, candidates: [],
      createPlan: { status: 'blocked', reason: 'Not selected by this reader.', changeId: 'governance-reader',
        workflowKind: 'openspec', requiredFacts: [] }
    }
  };
  const plan = await buildSavedTransitionPlan({ inspection, now, runner: new ReadyInitRunner() });
  if (!plan) throw new Error('Live ruleset reader fixture did not produce a saved plan.');
  const phase = inspection.graph.phases.find(node => node.id === 'live-readback');
  if (!phase) throw new Error('Canonical graph omitted live ruleset readback.');
  return { inspection, plan, phase, now, runner: new ReadyInitRunner(), adapters: {} };
}

type ReadRequest = Parameters<GitHubRulesetAdapter['readRuleset']>[0];
type WriteRequest = Parameters<GitHubRulesetAdapter['applyRuleset']>[0];

async function atBoundary(
  boundary: 'lease' | 'read',
  mutate: (input: PhaseAdapterExecutionInput) => void,
  readback: GitHubRulesetWriteResult = { resourceId, sourceDigest, readbackDigest: sourceDigest },
  prepare: (input: PhaseAdapterExecutionInput) => void = () => {}
) {
  const input = await readerInput();
  prepare(input);
  const expectedHeader = structuredClone(evidenceHeaderFor({
    inspection: input.inspection, phase: input.phase, plan: input.plan, result: 'verified', now: input.now
  }));
  const expectedOperations = structuredClone(input.plan.operations.filter(op => op.actionId === 'github.ruleset.readback'));
  const reads: ReadRequest[] = [];
  const writes: WriteRequest[] = [];
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  input.adapters.githubRulesets = {
    async readRuleset(request) {
      reads.push(structuredClone(request));
      if (boundary === 'read') { entered.resolve(); await resume.promise; }
      return readback;
    },
    async applyRuleset(request) {
      writes.push(structuredClone(request));
      return readback;
    }
  };
  const settled = await withProjectMutationLock(input.inspection.projectRoot, async lease => {
    input.lease = {
      async assertHeld() {
        await lease.assertHeld();
        if (boundary === 'lease') { entered.resolve(); await resume.promise; }
      }
    };
    const pending = executeRulesetPhase(input);
    await entered.promise;
    mutate(input);
    resume.resolve();
    return pending.then(
      result => ({ status: 'fulfilled' as const, result }),
      error => ({ status: 'rejected' as const, error: error instanceof Error ? error.message : String(error) })
    );
  });
  return { input, result: settled.status === 'fulfilled' ? settled.result : undefined,
    error: settled.status === 'rejected' ? settled.error : undefined, reads, writes, expectedHeader, expectedOperations };
}

function expectOriginalRead(observed: Awaited<ReturnType<typeof atBoundary>>): void {
  expect(observed.writes).toEqual([]);
  expect(observed.error).toBeUndefined();
  expect(observed.reads).toEqual([{ repository: 'owner/repo', sourceDigest }]);
  expect(observed.result).toMatchObject({
    status: 'completed', resultState: 'verified',
    evidencePayload: { kind: 'live-readback.v1', sourceDigest, resourceId, readbackDigest: sourceDigest }
  });
  expect(observed.result?.liveReadback).toEqual([{
    schemaVersion: observed.expectedHeader.schemaVersion,
    repositoryId: observed.expectedHeader.repositoryId,
    identity: observed.expectedHeader.identity,
    phaseGraphHash: observed.expectedHeader.phaseGraphHash,
    phaseId: 'live-readback',
    baselineSha: observed.expectedHeader.baselineSha,
    inputDigest: observed.expectedHeader.inputDigest,
    transition: observed.expectedHeader.transition,
    observedAt: observed.expectedHeader.producedAt,
    provider: 'github', resourceType: 'ruleset', resourceId, sourceDigest, readbackDigest: sourceDigest, matches: true
  }]);
  expect(observed.result?.fileMutations).toBeUndefined();
  expect(observed.result?.stateOverride).toBeUndefined();
  expect(observed.result?.completedOperations).toEqual(observed.expectedOperations);
}

describe('live ruleset readback original-input binding', () => {
  it('keeps unchanged native-lease observation read-only', async () => {
    expectOriginalRead(await atBoundary('lease', () => {}));
  });

  it('cannot adopt an enforcement phase while its native lease assertion is suspended', async () => {
    const observed = await atBoundary('lease', input => {
      Object.assign(input.phase, { id: 'rulesets-applied' });
    });
    expectOriginalRead(observed);
    expect(observed.input.phase.id).toBe('rulesets-applied');
  });

  it.each(['lease', 'read'] as const)('cannot adopt another repository at the %s boundary', async boundary => {
    const observed = await atBoundary(boundary, input => {
      Object.assign(input.inspection.state.remoteBinding!, { name: 'other/repository' });
    });
    expectOriginalRead(observed);
    expect(observed.input.inspection.state.remoteBinding?.name).toBe('other/repository');
  });

  it('cannot relabel an original readback as enforcement after provider suspension', async () => {
    const observed = await atBoundary('read', input => {
      Object.assign(input.phase, { id: 'rulesets-applied' });
    });
    expectOriginalRead(observed);
    expect(observed.input.phase.id).toBe('rulesets-applied');
  });

  it('retains the original reader method when the injected adapter is replaced', async () => {
    const observed = await atBoundary('lease', input => {
      const replacement = async () => { throw new Error('Replacement adapter must not run.'); };
      input.adapters.githubRulesets!.readRuleset = replacement;
      input.adapters.githubRulesets = { applyRuleset: replacement, readRuleset: replacement };
    });
    expectOriginalRead(observed);
  });

  it('does not acquire an injected writer property for observation', async () => {
    expectOriginalRead(await atBoundary('lease', input => {
      Object.defineProperty(input.adapters.githubRulesets, 'applyRuleset', {
        get() { throw new Error('Readback must not acquire a writer.'); }
      });
      Object.assign(input.phase, { id: 'rulesets-applied' });
    }));
  });

  it.each(['lease', 'read'] as const)('retains original header identity and context at the %s boundary', async boundary => {
    const observed = await atBoundary(boundary, input => {
      Object.assign(input.inspection.state.repository, { id: 'R_OTHER' });
      Object.assign(input.inspection.state.identity, { liftoffVersion: '99.0.0', evidenceHeaderSchemaVersion: 999 });
      input.inspection.graphHash = 'd'.repeat(64);
      Object.assign(input.inspection.contexts['live-readback'].transition, {
        baselineSha: 'e'.repeat(64), inputDigest: 'f'.repeat(64), transitionDigest: 'a'.repeat(64)
      });
      Object.assign(input.plan, { baselineDigest: 'e'.repeat(64), inputDigest: 'f'.repeat(64) });
      input.now.setUTCFullYear(2030);
    });
    expectOriginalRead(observed);
    expect(observed.input.inspection.state.repository.id).toBe('R_OTHER');
    expect(observed.input.inspection.state.identity.evidenceHeaderSchemaVersion).toBe(999);
    expect(observed.input.now.getUTCFullYear()).toBe(2030);
  });

  it('retains original completed read operations without adopting a write or nested input mutation', async () => {
    const observed = await atBoundary('read', input => {
      const operation = input.plan.operations.find(op => op.actionId === 'github.ruleset.readback');
      if (!operation) throw new Error('Original read operation missing.');
      Object.assign(operation.destination, { identity: 'other/repository', repository: 'other/repository' });
      Object.assign(operation.inputs, { repository: 'other/repository', sourceDigest: 'c'.repeat(64) });
      Object.assign(input.plan, { operations: [
        { ...operation, actionId: 'github.ruleset.apply', mutationClass: 'github-ruleset-write' },
        operation
      ] });
    });
    expectOriginalRead(observed);
    expect(observed.result?.completedOperations?.some(op => op.actionId === 'github.ruleset.apply')).toBe(false);
    expect(observed.input.plan.operations[0]?.actionId).toBe('github.ruleset.apply');
  });

  it('retains original accepted evidence when the caller replaces its evidence collection', async () => {
    const observed = await atBoundary('lease', input => { input.inspection.evidence = []; });
    expectOriginalRead(observed);
    expect(observed.input.inspection.evidence).toEqual([]);
  });

  it('does not adopt replacement input, inspection, phase, plan, clock or lease objects', async () => {
    const replacement = await readerInput();
    Object.assign(replacement.phase, { id: 'rulesets-applied' });
    Object.assign(replacement.inspection.state.repository, { id: 'R_OTHER' });
    Object.assign(replacement.inspection.state.remoteBinding!, { name: 'other/repository' });
    const observed = await atBoundary('lease', input => {
      Object.assign(input, replacement, {
        now: new Date('2030-01-01T00:00:00.000Z'),
        clock: () => new Date('2030-01-01T00:00:00.000Z'),
        lease: { async assertHeld() { throw new Error('Replacement lease must not run.'); } }
      });
    });
    expectOriginalRead(observed);
    expect(observed.input.inspection).toBe(replacement.inspection);
  });

  it('cannot extend an original expired plan while lease validation is suspended', async () => {
    const observed = await atBoundary('lease', input => {
      input.plan.expiresAt = '2030-01-01T00:00:00.000Z';
    }, undefined, input => { input.plan.expiresAt = originalNow; });
    expect(observed.error).toBeUndefined();
    expect(observed.result).toMatchObject({ status: 'blocked', blocker: 'The reviewed ruleset plan expired before provider access.', completedOperations: [] });
    expect(observed.reads).toEqual([]);
    expect(observed.writes).toEqual([]);
  });

  it('uses the captured original clock to refuse real expiry before provider access', async () => {
    let time = new Date(originalNow);
    const observed = await atBoundary('lease', input => {
      time = new Date(input.plan.expiresAt);
      input.clock = () => new Date(originalNow);
      input.plan.expiresAt = '2030-01-01T00:00:00.000Z';
    }, undefined, input => { input.clock = () => time; });
    expect(observed.result).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(observed.result?.blocker).toContain('expired');
    expect(observed.reads).toEqual([]);
    expect(observed.writes).toEqual([]);
  });

  it.each(['sourceDigest', 'readbackDigest'] as const)('refuses a mismatched provider %s without an effect claim', async key => {
    const observed = await atBoundary('read', () => {}, {
      resourceId, sourceDigest, readbackDigest: sourceDigest, [key]: 'c'.repeat(64)
    });
    expect(observed.error).toBeUndefined();
    expect(observed.writes).toEqual([]);
    expect(observed.reads).toEqual([{ repository: 'owner/repo', sourceDigest }]);
    expect(observed.result).toMatchObject({ status: 'blocked', completedOperations: observed.expectedOperations });
    expect(observed.result?.liveReadback).toBeUndefined();
    expect(observed.result?.evidencePayload).toBeUndefined();
  });

  it('preserves native released-lease refusal before any provider access', async () => {
    const input = await readerInput();
    await withProjectMutationLock(input.inspection.projectRoot, async lease => { input.lease = lease; });
    let calls = 0;
    const provider = async () => { calls++; throw new Error('Provider must not run.'); };
    input.adapters.githubRulesets = { applyRuleset: provider, readRuleset: provider };
    await expect(executeRulesetPhase(input)).rejects.toThrow('no longer held');
    expect(calls).toBe(0);
  });

  it.each(['green-red-proof', 'workflow-source-ready'] as const)('preserves original missing %s refusal', async phaseId => {
    const input = await readerInput();
    input.inspection.evidence = input.inspection.evidence.filter(record => record.header.phaseId !== phaseId);
    let calls = 0;
    const provider = async () => { calls++; throw new Error('Provider must not run.'); };
    input.adapters.githubRulesets = { applyRuleset: provider, readRuleset: provider };
    const result = await executeRulesetPhase(input);
    expect(result).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(result?.blocker).toContain(phaseId === 'green-red-proof' ? 'green-red-proof' : 'saved ruleset source digest');
    expect(calls).toBe(0);
  });

  it('preserves the lack of a default production ruleset adapter', async () => {
    const input = await readerInput();
    expect(await executeRulesetPhase(input)).toMatchObject({
      status: 'blocked',
      blocker: 'No injected GitHub ruleset adapter is configured; refusing live ruleset calls in this execution context.',
      completedOperations: []
    });
  });
});
