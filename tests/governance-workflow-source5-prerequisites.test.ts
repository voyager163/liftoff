import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectModernInstalledActivation } from '../src/application/governance/modern-installed-preflight.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { canonicalJson, canonicalSha256, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { installedLocalBinding } from '../src/domain/governance/activation/modern-local-runtime.js';
import { modernPhaseContractDigests } from '../src/domain/governance/activation/modern-graph.js';
import {
  createSource5WorkflowContext, source5ApprovalHash, source5WorkflowPhases
} from '../src/governance-activation/workflow-source5-context.js';
import { source5WorkflowPrerequisiteReferences } from '../src/governance-activation/workflow-source5-prerequisites.js';
import { localInputsPlanFixture, writeModernInstalledProject } from './fixtures/modern-installed-project.js';

describe('source5 graph-selected prerequisite references without currentness authority', () => {
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-source5-prerequisites-')));
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function installedSelection(workflow: 'manual' | 'openspec' | 'spec-kit',
    profile: 'single-maintainer-gitflow' | 'team-gitflow') {
    const projectRoot = await mkdtemp(path.join(root, `${profile}-${workflow}-`));
    const fixture = await writeModernInstalledProject(projectRoot, workflow, profile);
    if (!fixture.api || !fixture.state) throw new Error('Expected isolated governed fixture records.');
    await fixture.write(['governance', 'activation-state.json'], canonicalJson(fixture.state));
    const observed = await inspectModernInstalledActivation(projectRoot);
    if (observed.status !== 'observed' || !observed.current) {
      throw new Error('Expected independently observed isolated current5 fixture.');
    }
    const context = createSource5WorkflowContext(projectCatalog, {
      recordedIdentity: fixture.api.identity, profile, policyVersion: fixture.api.identity.policyVersion,
      selection: { ...fixture.input.selection, profile },
      pluginResolutionDigest: fixture.api.identity.pluginResolutionDigest,
      activeLayoutDigest: fixture.api.identity.activeLayoutDigest
    });
    return { fixture, installed: observed, context };
  }

  async function recordedDependency() {
    const value = await installedSelection('manual', 'single-maintainer-gitflow');
    const { fixture, context } = value;
    const phaseId = 'dev-proof', phase = context.records.graph.phases.find(phase => phase.id === phaseId)!;
    const input = {
      ...localInputsPlanFixture(context.records), phaseId,
      configuration: { schemaVersion: 1 as const, phases: {},
        budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } },
      approval: { gateKind: phase.approvalGate.kind, required: true, envelopeId: null, envelopeHash: null,
        evaluation: { phaseId, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: true,
          status: 'approval-required' as const, envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
      rollbackPlan: { phaseId, strategy: phase.rollback.kind, target: phase.rollback.target,
        operations: [], retained: [], cleanupWarnings: [] }
    } as const;
    const draft = context.records.createPlan(input);
    const approval = context.records.createApproval({
      plan: draft, id: 'original-format-only-approval', approvedAt: draft.createdAt, expiresAt: draft.expiresAt,
      approver: 'record-format-fixture-not-live-qualification', resources: [], destinations: [], permissions: [],
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: []
    });
    const envelopeHash = source5ApprovalHash(context, approval);
    const plan = context.records.createPlan({
      ...input, approval: { ...input.approval, envelopeId: approval.id, envelopeHash,
        evaluation: { ...input.approval.evaluation, status: 'reused', envelopeId: approval.id, envelopeHash } }
    }, { approvals: [approval] });
    const evidence = context.records.createEvidence({
      plan, evidenceId: 'original-format-only-failure', repositoryId: fixture.state!.repository.id,
      producedAt: plan.createdAt, producer: 'record-format-fixture-not-live-qualification',
      result: 'failed', payload: { kind: 'dev-proof.v2', reason: 'Original fixture failure, not a current observation.' }
    }, { approvals: [approval] });
    const state = context.records.stateAfterOutcome({
      state: fixture.state!, plan, phaseState: 'failed', updatedAt: plan.createdAt, evidenceId: evidence.evidenceId
    }, { plans: [plan], approvals: [approval], evidence: [evidence] });
    for (const [parts, record] of [
      [['governance', 'plans', 'original.json'], plan],
      [['governance', 'approvals', `${approval.id}.json`], approval],
      [['governance', 'evidence', `${evidence.evidenceId}.json`], evidence],
      [['governance', 'activation-state.json'], state]
    ] as const) await fixture.write(parts, canonicalJson(record));
    const installed = await inspectModernInstalledActivation(fixture.root);
    if (installed.status !== 'observed' || !installed.current) {
      throw new Error(installed.status === 'blocked' ? installed.blockers.join(' ') : 'Missing original fixture state.');
    }
    return { context, installed, plan, draft, evidence, approval, fixture };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['openspec', 'single-maintainer-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'team-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('selects every workflow prerequisite from the actual %s/%s graph', async (workflow, profile) => {
    const { installed, context } = await installedSelection(workflow, profile);
    for (const phaseId of source5WorkflowPhases) {
      const phase = context.records.graph.phases.find(phase => phase.id === phaseId)!;
      const selected = source5WorkflowPrerequisiteReferences({ context, installed, phaseId });
      expect(selected.dependencies.map(dependency => dependency.contract)).toEqual(phase.dependencies);
      expect(selected.dependencies.map(dependency => dependency.alternatives.map(ref => ref.phaseId)))
        .toEqual(phase.dependencies.map(dependency => dependency.anyOf));
      expect(selected).toMatchObject({
        phaseId, graphHash: context.records.identity.phaseGraphHash,
        phaseContractDigest: modernPhaseContractDigests(context.records.graph)[phaseId],
        applicability: phase.applicability, approvalGate: phase.approvalGate,
        invalidationInputs: phase.invalidationInputs, readbackProviders: phase.evidence.liveReadbackProviders,
        currentness: 'not-observed', execution: 'not-authorized'
      });
      for (const dependency of selected.dependencies) for (const ref of dependency.alternatives) {
        expect(ref).toMatchObject({
          recordedState: 'pending', executionPlanDigest: null, savedPlans: [],
          evidence: [], approvals: []
        });
      }
      const { referenceDigest, currentness: _currentness, execution: _execution, ...binding } = selected;
      expect(referenceDigest).toBe(canonicalSha256(binding));
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.dependencies)).toBe(true);
      expect(Object.isFrozen(selected.dependencies[0]!.alternatives)).toBe(true);
    }
  });

  it('rejects structural contexts, stale captures, historical classifications and altered identities', async () => {
    const { installed, context } = await installedSelection('manual', 'single-maintainer-gitflow');
    const input = { context, installed, phaseId: 'dev-proof' as const };
    expect(() => source5WorkflowPrerequisiteReferences({ ...input, context: { records: context.records } }))
      .toThrow(/constructed|context/);
    expect(() => source5WorkflowPrerequisiteReferences({ ...input, installed: { ...installed, binding: '0'.repeat(64) } }))
      .toThrow(/exact selected current5/);
    for (const classification of ['fresh', 'successor', 'released-source', 'governance-none'] as const) {
      expect(() => source5WorkflowPrerequisiteReferences({ ...input, installed: { ...installed, classification } }))
        .toThrow(/exact selected current5/);
    }
    expect(() => source5WorkflowPrerequisiteReferences({ ...input, installed: { ...installed, current: null } }))
      .toThrow(/exact selected current5/);
    const changed = structuredClone(installed);
    Reflect.set(changed.current!.state.identity, 'activationContractVersion', 4);
    expect(() => source5WorkflowPrerequisiteReferences({
      ...input, installed: { ...changed, binding: installedLocalBinding(changed.snapshot) }
    })).toThrow(/exact selected current5/);
  });

  it('does not let a changed graph, selected phase or unvalidated record closure become prerequisite proof', async () => {
    const { installed, context } = await installedSelection('manual', 'single-maintainer-gitflow');
    const phaseId = 'green-red-proof';
    const copied = structuredClone(installed);
    Reflect.set(copied.current!.state.phases['production-rehearsed'], 'state', 'verified');
    expect(() => source5WorkflowPrerequisiteReferences({ context, installed: copied, phaseId }))
      .toThrow(/original outcome|original.*reference|evidence/);
    const invalid = { context, installed, phaseId };
    Reflect.set(invalid, 'phaseId', 'application-foundation');
    expect(() => source5WorkflowPrerequisiteReferences({
      ...invalid, phaseId: 'green-red-proof', context: { records: { ...context.records,
        graph: { ...context.records.graph, phases: [] } } }
    })).toThrow(/constructed|context/);
    expect(() => Reflect.apply(source5WorkflowPrerequisiteReferences, undefined, [invalid]))
      .toThrow(/exact selected current5/);
  });

  it('retains exact original plan, evidence body and approval identities without promoting their recorded outcome', async () => {
    const { context, installed, plan, evidence, approval } = await recordedDependency();
    const selected = source5WorkflowPrerequisiteReferences({ context, installed, phaseId: 'staging-qualified' });
    expect(selected.dependencies[0]!.alternatives).toEqual([{
      phaseId: 'dev-proof', recordedState: 'failed', executionPlanDigest: plan.planDigest,
      savedPlans: [{ savedPlanDigest: canonicalSha256(plan), pathParts: ['governance', 'plans', 'original.json'],
        operationDigests: plan.operations.map(operation => canonicalSha256(operation)),
        rawDigest: sha256Hex(canonicalJson(plan)) }],
      evidence: [{ evidenceId: evidence.evidenceId, headerDigest: canonicalSha256(evidence.header),
        recordDigest: canonicalSha256(evidence), pathParts: ['governance', 'evidence', `${evidence.evidenceId}.json`],
        rawDigest: sha256Hex(canonicalJson(evidence)) }],
      approvals: [{ id: approval.id, envelopeHash: source5ApprovalHash(context, approval),
        pathParts: ['governance', 'approvals', `${approval.id}.json`], rawDigest: sha256Hex(canonicalJson(approval)) }]
    }]);
    const ref = selected.dependencies[0]!.alternatives[0]!;
    expect(ref.savedPlans[0]!.rawDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(ref.evidence[0]!.rawDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(ref.approvals[0]!.rawDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected.currentness).toBe('not-observed');
    expect(selected.execution).toBe('not-authorized');
    const saved = structuredClone(selected);
    const changed = structuredClone(installed);
    Reflect.set(changed.current!.state.phases['dev-proof'], 'blockers', ['Later caller mutation']);
    expect(selected).toEqual(saved);
  });

  it.each(['plans', 'evidence', 'approvals'] as const)(
    'refuses a missing original %s closure rather than converting it into an absent or current reference', async key => {
      const { context, installed } = await recordedDependency();
      const changed = structuredClone(installed);
      Reflect.set(changed.current!.records, key, []);
      expect(() => source5WorkflowPrerequisiteReferences({
        context, installed: changed, phaseId: 'staging-qualified'
      })).toThrow(/original|missing|approval/);
    });

  it('retains every original saved record sharing one semantic plan authority instead of selecting the first', async () => {
    const { context, plan, draft, fixture } = await recordedDependency();
    expect(draft.planDigest).toBe(plan.planDigest);
    expect(canonicalSha256(draft)).not.toBe(canonicalSha256(plan));
    await fixture.write(['governance', 'plans', 'draft.json'], canonicalJson(draft));
    const installed = await inspectModernInstalledActivation(fixture.root);
    if (installed.status !== 'observed' || !installed.current) throw new Error('Expected valid multiple saved-record fixture.');
    const selected = source5WorkflowPrerequisiteReferences({ context, installed, phaseId: 'staging-qualified' });
    expect(selected.dependencies[0]!.alternatives[0]).toMatchObject({
      executionPlanDigest: plan.planDigest,
      savedPlans: expect.arrayContaining([
        expect.objectContaining({ savedPlanDigest: canonicalSha256(draft), pathParts: ['governance', 'plans', 'draft.json'] }),
        expect.objectContaining({ savedPlanDigest: canonicalSha256(plan), pathParts: ['governance', 'plans', 'original.json'] })
      ])
    });
  });

  it('refuses a readable summary whose original record is absent from the captured namespace', async () => {
    const { context, installed, evidence } = await recordedDependency();
    const changed = structuredClone(installed);
    Reflect.set(changed.snapshot, 'files', changed.snapshot.files.filter(file =>
      file.pathParts.join('/') !== `governance/evidence/${evidence.evidenceId}.json`));
    expect(() => source5WorkflowPrerequisiteReferences({
      context, installed: { ...changed, binding: installedLocalBinding(changed.snapshot) }, phaseId: 'staging-qualified'
    })).toThrow(/captured|missing|absent/);
  });
});
