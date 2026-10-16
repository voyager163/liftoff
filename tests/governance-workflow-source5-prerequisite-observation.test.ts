import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as installedReader from '../src/application/governance/modern-installed-preflight.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  createSource5WorkflowContext, source5ApprovalHash, source5WorkflowPhases
} from '../src/governance-activation/workflow-source5-context.js';
import { observeSource5WorkflowPrerequisites } from '../src/governance-activation/workflow-source5-prerequisite-observation.js';
import { localInputsPlanFixture, writeModernInstalledProject } from './fixtures/modern-installed-project.js';

describe('first-party original prerequisite observation without invented currentness', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-prerequisite-observation-'))); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
    profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
    const directory = await mkdtemp(path.join(root, 'project-'));
    const value = await writeModernInstalledProject(directory, workflow, profile);
    if (!value.api || !value.state) throw new Error('Expected governed source-format fixture.');
    await value.write(['governance', 'activation-state.json'], canonicalJson(value.state));
    const context = createSource5WorkflowContext(projectCatalog, {
      recordedIdentity: value.api.identity, profile, policyVersion: value.api.identity.policyVersion,
      selection: { ...value.input.selection, profile },
      pluginResolutionDigest: value.api.identity.pluginResolutionDigest,
      activeLayoutDigest: value.api.identity.activeLayoutDigest
    });
    return { value, context, projectRoot: directory };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['openspec', 'single-maintainer-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'team-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('independently observes both actual closures for %s/%s without issuing a session', async (workflow, profile) => {
    const { context, projectRoot } = await fixture(workflow, profile);
    const originalState = await readFile(path.join(projectRoot, 'governance', 'activation-state.json'), 'utf8');
    const reader = vi.spyOn(installedReader, 'inspectModernInstalledActivation');
    for (const phaseId of source5WorkflowPhases) {
      const graphPhase = context.records.graph.phases.find(phase => phase.id === phaseId)!;
      const result = await observeSource5WorkflowPrerequisites({ context, projectRoot, phaseId });
      expect(result).toMatchObject({
        status: 'blocked', currentness: 'not-observed', execution: 'not-authorized',
        projectWrites: false, providerReads: false, providerWrites: false, workloadExecution: false, prerequisiteSession: null
      });
      expect(result.dependencies.map(group => group.contract)).toEqual(graphPhase.dependencies);
      expect(result.dependencies.map(group => group.alternatives.map(ref => ref.phaseId)))
        .toEqual(graphPhase.dependencies.map(group => group.anyOf));
      expect(result.references.graphHash).toBe(context.records.identity.phaseGraphHash);
      expect(result.references.installedBinding).toBe(result.observations.installedBinding);
      expect(result.references.physicalDigest).toBe(result.observations.physicalDigest);
      expect(result.completionBlockers.map(blocker => blocker.code)).toEqual(
        graphPhase.evidence.liveReadbackProviders.includes('azure') ? ['workflow-current-azure-peer-reader-unavailable'] : []);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.dependencies)).toBe(true);
    }
    expect(reader).toHaveBeenCalledTimes(source5WorkflowPhases.length * 2);
    expect(await readFile(path.join(projectRoot, 'governance', 'activation-state.json'), 'utf8'))
      .toBe(originalState);
  });

  it('refuses injected readers, snapshots, proof bags and getters before even reading the project', async () => {
    const { context, projectRoot } = await fixture();
    const reader = vi.spyOn(installedReader, 'inspectModernInstalledActivation');
    const input = { context, projectRoot, phaseId: 'dev-proof' as const };
    for (const extra of [
      { nativeHostReader: async () => ({ status: 'qualified' }) },
      { azurePeer: { status: 'completed' } }, { installed: { status: 'observed' } },
      { prerequisites: { currentness: 'current', expiresAt: '2099-01-01T00:00:00.000Z' } }
    ]) await expect(Reflect.apply(observeSource5WorkflowPrerequisites, undefined, [{ ...input, ...extra }]))
      .rejects.toThrow(/caller readers|proof values/);
    const getter = { context, projectRoot };
    Object.defineProperty(getter, 'phaseId', { get: () => { throw new Error('Getter must not execute'); } });
    await expect(Reflect.apply(observeSource5WorkflowPrerequisites, undefined, [getter]))
      .rejects.toThrow(/caller readers|proof values/);
    const proxy = new Proxy(input, { getPrototypeOf: () => { throw new Error('Proxy trap must not execute'); } });
    await expect(observeSource5WorkflowPrerequisites(proxy)).rejects.toThrow(/caller readers|proof values/);
    await expect(observeSource5WorkflowPrerequisites({ ...input, context: { records: context.records } }))
      .rejects.toThrow(/constructed|context/);
    expect(reader).not.toHaveBeenCalled();
  });

  it('retains an admissible original approval as a reference, never as independently current authority', async () => {
    const { value, context, projectRoot } = await fixture();
    const phaseId = 'activation-approved', phase = context.records.graph.phases.find(phase => phase.id === phaseId)!;
    const input = {
      ...localInputsPlanFixture(context.records), phaseId,
      configuration: { schemaVersion: 1 as const, phases: {},
        budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } },
      approval: { gateKind: phase.approvalGate.kind, required: true, envelopeId: null, envelopeHash: null,
        evaluation: { phaseId, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: true,
          status: 'approval-required' as const, envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
      rollbackPlan: { phaseId, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] }
    } as const;
    const draft = context.records.createPlan(input);
    const approval = context.records.createApproval({
      plan: draft, id: 'format-only-original-approval', approvedAt: draft.createdAt, expiresAt: draft.expiresAt,
      approver: 'not-current-qualification', resources: [], destinations: [], permissions: [],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: []
    });
    const envelopeHash = source5ApprovalHash(context, approval);
    const plan = context.records.createPlan({
      ...input, approval: { ...input.approval, envelopeId: approval.id, envelopeHash,
        evaluation: { ...input.approval.evaluation, status: 'reused', envelopeId: approval.id, envelopeHash } }
    }, { approvals: [approval] });
    const state = context.records.stateAfterOutcome({
      state: value.state!, plan, phaseState: 'approved', updatedAt: plan.createdAt
    }, { plans: [plan], approvals: [approval] });
    for (const [parts, record] of [
      [['governance', 'plans', 'approval-plan.json'], plan],
      [['governance', 'approvals', `${approval.id}.json`], approval],
      [['governance', 'activation-state.json'], state]
    ] as const) await value.write(parts, canonicalJson(record));
    const result = await observeSource5WorkflowPrerequisites({ context, projectRoot, phaseId: 'bootstrap-workflow-source-ready' });
    expect(result.dependencies[0]!.alternatives[0]).toMatchObject({
      phaseId, recordedState: 'approved', recordedStateAccepted: true, currentness: 'not-observed',
      code: 'workflow-prerequisite-current-reader-unavailable'
    });
    expect(result.references.dependencies[0]!.alternatives[0]!.approvals[0]!.envelopeHash).toBe(envelopeHash);
    expect(result.prerequisiteSession).toBeNull();
  });

  it('reports the actual Azure dependency and separate phase-completion obligation without probing either', async () => {
    const { context, projectRoot } = await fixture();
    const development = await observeSource5WorkflowPrerequisites({ context, projectRoot, phaseId: 'dev-proof' });
    expect(development.dependencies[0]!.alternatives[0]).toMatchObject({
      phaseId: 'application-foundation', readbackProviders: ['azure'],
      readerCode: 'workflow-current-azure-peer-reader-unavailable'
    });
    expect(development.completionBlockers).toEqual([]);
    const staging = await observeSource5WorkflowPrerequisites({ context, projectRoot, phaseId: 'staging-qualified' });
    expect(staging.dependencies[0]!.alternatives[0]!.phaseId).toBe('dev-proof');
    expect(staging.completionBlockers[0]!.code).toBe('workflow-current-azure-peer-reader-unavailable');
    expect(staging.providerReads).toBe(false);
  });

  it('refuses real installed drift between its observations instead of issuing a fresh reference or session', async () => {
    const { value, context, projectRoot } = await fixture();
    const original = installedReader.inspectModernInstalledActivation;
    let observations = 0;
    vi.spyOn(installedReader, 'inspectModernInstalledActivation').mockImplementation(async directory => {
      const result = await original(directory);
      if (++observations === 1) {
        await value.write(['governance', 'activation-state.json'],
          canonicalJson({ ...value.state!, updatedAt: '2026-09-01T12:00:01.000Z' }));
      }
      return result;
    });
    await expect(observeSource5WorkflowPrerequisites({ context, projectRoot, phaseId: 'dev-proof' }))
      .rejects.toThrow(/changed during prerequisite observation/);
    expect(observations).toBe(2);
  });

  it('rejects an actual missing state and a different compiled profile without any provider fallback', async () => {
    const current = await fixture(), other = await fixture('manual', 'team-gitflow');
    await expect(observeSource5WorkflowPrerequisites({
      context: other.context, projectRoot: current.projectRoot, phaseId: 'dev-proof'
    })).rejects.toThrow(/exact selected current5/);
    await rm(path.join(current.projectRoot, 'governance', 'activation-state.json'));
    await expect(observeSource5WorkflowPrerequisites({
      context: current.context, projectRoot: current.projectRoot, phaseId: 'dev-proof'
    })).rejects.toThrow(/exact selected current5|installed|state/);
    expect(canonicalSha256(other.context.records.graph)).toBe(other.context.records.identity.phaseGraphHash);
  });
});
