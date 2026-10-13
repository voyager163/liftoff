import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { inspectModernInstalledActivation } from '../../src/application/governance/modern-installed-preflight.js';
import { canonicalJson, canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { plannedApprovalDestinations, plannedApprovalMutations, plannedApprovalResources } from '../../src/domain/governance/activation/source-values.js';
import type { ModernPlanInput } from '../../src/domain/governance/activation/modern-records.js';
import {
  createSource5WorkflowContext, source5ApprovalHash, source5PreviewFingerprint
} from '../../src/governance-activation/workflow-source5-context.js';
import {
  source5WorkflowOperation, source5WorkflowCheckpointOperation, source5WorkflowControlKey, source5WorkflowProjectOperations
} from '../../src/governance-activation/workflow-source5-operations.js';
import type { Source5WorkflowControlBinding } from '../../src/governance-activation/workflow-source5-operations.js';
import type { Source5WorkflowAction, Source5WorkflowOrigin } from '../../src/governance-activation/workflow-source5-operations.js';
import type { Source5WorkflowPhase } from '../../src/governance-activation/workflow-source5-context.js';
import { createWorkflowSource5ControlStore, resolveUpdatePreviewLocation } from '../../src/adapters/filesystem/update-previews.js';
import { writeModernInstalledProject } from './modern-installed-project.js';
import { workflowByteDigest } from '../../src/governance-activation/workflow-binding.js';

/** Isolated current5 record/protocol fixtures, not host or live-provider qualification. */
export async function workflowSource5JournalFixture(options: {
  initializeProject?: (projectRoot: string, fixtureRoot: string) => Promise<void>;
} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-source5-journal-')));
  const projectRoot = path.join(root, 'project'), homedir = path.join(root, 'home');
  await mkdir(projectRoot, { mode: 0o700 }); await mkdir(homedir, { mode: 0o700 });
  await options.initializeProject?.(projectRoot, root);
  const storage = { homedir, env: {} }, installed = await writeModernInstalledProject(projectRoot);
  await installed.write(['governance', 'activation-state.json'], canonicalJson(installed.state));
  const identity = installed.api!.identity;
  const context = createSource5WorkflowContext(projectCatalog, { recordedIdentity: identity,
    profile: 'single-maintainer-gitflow', policyVersion: identity.policyVersion,
    selection: { ...installed.input.selection, profile: 'single-maintainer-gitflow' },
    pluginResolutionDigest: identity.pluginResolutionDigest, activeLayoutDigest: identity.activeLayoutDigest });
  const observed = await inspectModernInstalledActivation(projectRoot);
  if (observed.status !== 'observed' || !observed.current) throw new Error('Expected original readable fixture state.');
  const baselineDigest = observed.binding;
  const content = 'name: Isolated source fixture\non: workflow_dispatch\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo source-fixture\n';
  const binding = { repository: 'owner/repo', repositoryId: 123, ref: 'ci/liftoff-workflows-journal',
    parentSha: 'a'.repeat(40), sourceTransmissionApproved: true,
    files: [{ path: '.github/workflows/source-fixture.yml', beforeDigest: null, digest: workflowByteDigest(content), content }] };
  function review(request: { phaseId?: Source5WorkflowPhase; origin?: Source5WorkflowOrigin;
    remainingFrom?: Source5WorkflowControlBinding['remainingFrom']; effects?:
    readonly { action: Source5WorkflowAction; binding: unknown }[] } = {}) {
    const phaseId = request.phaseId ?? 'bootstrap-workflow-source-ready', phase = context.records.graph.phases.find(phase => phase.id === phaseId)!;
    const keyInput = { executionId: randomUUID(), repositoryAnchor: installed.state!.repository.id, phaseId, projectKey } as const;
    const control: Source5WorkflowControlBinding = { ...keyInput, schemaVersion: 1, kind: 'workflow-source5-control.v1',
      controlKey: source5WorkflowControlKey(keyInput), reviewKind: request.remainingFrom ? 'remaining-only' :
        request.origin ? 'bound-source' : 'publication',
      remainingFrom: request.remainingFrom ?? null, origin: request.origin ?? null };
    const selected = request.effects ?? [{ action: 'git.workflow-source.publish-reviewed' as const, binding }];
    const operation = source5WorkflowOperation(phaseId, selected[0]!.action, selected[0]!.binding);
    const checkpoint = source5WorkflowCheckpointOperation(control);
    const operations = [...selected.map(entry => source5WorkflowOperation(phaseId, entry.action, entry.binding)), checkpoint,
      ...source5WorkflowProjectOperations(control)];
    const effects = operations.flatMap(operation => [operation, ...(operation.effects ?? [])]);
    const input: ModernPlanInput = { phaseId, createdAt: '2026-09-01T12:00:00.000Z', expiresAt: '2026-09-01T13:00:00.000Z',
      stateHash: canonicalSha256(installed.state), baselineDigest, inputDigest: canonicalSha256(selected),
      transitionDigest: canonicalSha256({ control, selected }), operations, noSecrets: true,
      configuration: { schemaVersion: 1, phases: {}, budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 } },
      approval: { gateKind: phase.approvalGate.kind, required: true, envelopeId: null, envelopeHash: null,
        evaluation: { phaseId, gateKind: phase.approvalGate.kind, questionKind: null, approvalRequired: true,
          status: 'approval-required', envelopeId: null, envelopeHash: null, reasons: [], expansionReasons: [] } },
      rollbackPlan: { phaseId, strategy: phase.rollback.kind, target: phase.rollback.target, operations: [], retained: [], cleanupWarnings: [] } };
    const draft = context.records.createPlan(input);
    const approval = context.records.createApproval({ plan: draft, id: `source5-${control.controlKey}`,
      approvedAt: input.createdAt, expiresAt: input.expiresAt, approver: 'isolated-fixture-human',
      resources: plannedApprovalResources(effects), destinations: plannedApprovalDestinations(effects), permissions: plannedApprovalMutations(effects),
      costCeiling: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 0 }, policyExceptions: [], destructiveScope: [] });
    const envelopeHash = source5ApprovalHash(context, approval);
    const plan = context.records.createPlan({ ...input, approval: { ...input.approval, envelopeId: approval.id, envelopeHash,
      evaluation: { ...input.approval.evaluation, status: 'reused', envelopeId: approval.id, envelopeHash } } }, { approvals: [approval] });
    return { root, projectRoot, storage, context, plan, approval, operation, control, binding,
      previewFingerprint: source5PreviewFingerprint(projectRoot, plan), repositoryAnchor: keyInput.repositoryAnchor,
      now: new Date('2026-09-01T12:05:00.000Z'), store: createWorkflowSource5ControlStore(projectRoot, storage), installed };
  }
  const projectKey = (await resolveUpdatePreviewLocation(projectRoot, storage)).projectKey;
  return { ...review(), review };
}
