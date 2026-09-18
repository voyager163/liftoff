import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../adapters/filesystem/update-previews.js';
import { withProjectMutationLock } from '../adapters/filesystem/project-lock.js';
import { applyProjectFileTransaction, captureProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { canonicalJson, canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan, canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan
} from '../domain/governance/activation/approvals.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../domain/governance/activation/validators.js';
import { phaseById } from '../domain/governance/activation/operations.js';
import type { ApprovalEnvelope, SavedTransitionPlan } from '../domain/governance/activation/types.js';
import type { CommandRunner } from '../process-runner.js';
import type { GovernanceTransitionAdapters, GovernanceTransitionInspection } from './transition-ports.js';
import { buildSavedTransitionPlan } from './transition-planning.js';
import { assertNoSecrets, transitionPlanPathParts } from './transition-records.js';
import { assertGovernanceApprovalIssued, writeGovernanceApprovalAuthority } from './authority-records.js';
import { assertGovernanceConfigurationBinding } from '../application/repository-governance/configuration.js';
import { bindGovernanceTransitionContext } from './transition-context.js';
export { assertGovernanceApprovalIssued } from './authority-records.js';

export interface GovernancePlanPreview {
  schemaVersion: 1;
  kind: 'liftoff-governance-preview';
  projectRoot: string;
  fingerprint: string;
  plan: SavedTransitionPlan;
}

function fingerprintFor(projectRoot: string, plan: SavedTransitionPlan): string {
  return canonicalSha256({ schemaVersion: 1, kind: 'liftoff-governance-preview', projectRoot, plan });
}

export async function saveGovernancePreview(
  inspection: GovernanceTransitionInspection,
  options: { runner?: CommandRunner; now?: Date; storage?: UpdatePreviewOptions; adapters?: GovernanceTransitionAdapters } = {}
): Promise<{ preview: GovernancePlanPreview; path: string } | null> {
  const { storage, adapters } = bindGovernanceTransitionContext(options);
  const plan = await buildSavedTransitionPlan({ inspection, runner: options.runner, now: options.now, adapters });
  if (!plan) return null;
  assertNoSecrets(plan);
  const projectRoot = await realpath(inspection.projectRoot);
  const fingerprint = fingerprintFor(projectRoot, plan);
  const preview: GovernancePlanPreview = {
    schemaVersion: 1, kind: 'liftoff-governance-preview', projectRoot, fingerprint, plan
  };
  const stored = await createScopedUserLocalRecordStore(projectRoot, 'governance-preview', storage).write(fingerprint, preview);
  return { preview, path: stored.path };
}

export async function loadGovernancePreview(
  projectRoot: string,
  fingerprint: string,
  options: { now?: Date; storage?: UpdatePreviewOptions } = {}
): Promise<GovernancePlanPreview> {
  const { storage } = bindGovernanceTransitionContext(options);
  const stored = await createScopedUserLocalRecordStore(projectRoot, 'governance-preview', storage).read(fingerprint);
  if (!stored) throw new Error('No matching external governance preview exists for this project; run governance plan first.');
  const value = stored.value;
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'fingerprint,kind,plan,projectRoot,schemaVersion' ||
    value.schemaVersion !== 1 || value.kind !== 'liftoff-governance-preview' ||
    value.projectRoot !== stored.projectRoot || value.fingerprint !== fingerprint) {
    throw new Error('Governance preview has an invalid contract or belongs to another project.');
  }
  const plan = validateSavedTransitionPlan(value.plan);
  if (plan.configurationBinding) await assertGovernanceConfigurationBinding(plan.configurationBinding);
  assertNoSecrets(plan);
  if (fingerprintFor(stored.projectRoot, plan) !== fingerprint) throw new Error('Governance preview fingerprint does not match its exact plan.');
  const now = options.now ?? new Date();
  if (Date.parse(plan.createdAt) > now.getTime() || Date.parse(plan.expiresAt) <= now.getTime()) {
    throw new Error('Governance preview is expired or dated in the future; request a fresh plan.');
  }
  return { schemaVersion: 1, kind: 'liftoff-governance-preview', projectRoot: stored.projectRoot, fingerprint, plan };
}

export async function approveGovernancePreview(input: {
  projectRoot: string;
  fingerprint: string;
  inspect: () => Promise<GovernanceTransitionInspection>;
  runner?: CommandRunner;
  now?: Date;
  storage?: UpdatePreviewOptions;
  adapters?: GovernanceTransitionAdapters;
}): Promise<{ envelope: ApprovalEnvelope; plan: SavedTransitionPlan; pathParts: readonly string[] }> {
  const { storage, adapters } = bindGovernanceTransitionContext(input);
  const now = input.now ?? new Date();
  const preview = await loadGovernancePreview(input.projectRoot, input.fingerprint, { now, storage });
  return withProjectMutationLock(input.projectRoot, async (lease) => {
    const inspection = await input.inspect();
    const fresh = await buildSavedTransitionPlan({
      inspection, runner: input.runner, now, createdAt: preview.plan.createdAt, adapters
    });
    if (!fresh || fresh.planDigest !== preview.plan.planDigest || fresh.stateHash !== preview.plan.stateHash ||
      fresh.scope !== preview.plan.scope || fresh.selectionScope !== preview.plan.selectionScope ||
      canonicalSha256(fresh.configurationBinding ?? null) !== canonicalSha256(preview.plan.configurationBinding ?? null) ||
      canonicalSha256(fresh.fileChanges ?? []) !== canonicalSha256(preview.plan.fileChanges ?? [])) {
      throw new Error('Governance plan inputs or exact operations changed after preview; no approval was written.');
    }
    const phase = phaseById(inspection.graph, fresh.phaseId);
    if (!phase.approvalGate.required) throw new Error('This phase needs explicit execution, not an approval envelope.');
    const request = approvalRequestForSavedPlan(fresh, phase, inspection.state);
    const existing = evaluateApprovalForTransitionPlan(request, inspection.approvals, { now });
    if (!existing.approvalRequired) {
      const envelope = inspection.approvals.find((entry) => entry.id === existing.envelopeId)!;
      await assertGovernanceApprovalIssued(input.projectRoot, envelope, storage);
      return { envelope, plan: fresh, pathParts: ['governance', 'approvals', `${envelope.id}.json`] };
    }
    const envelope = validateApprovalEnvelope({
      ...request,
      schemaVersion: inspection.state.identity.approvalEnvelopeSchemaVersion,
      id: randomUUID(),
      approvedAt: now.toISOString(),
      expiresAt: fresh.expiresAt,
      approver: 'local-cli-explicit-plan-approval'
    }, { expectedIdentity: inspection.state.identity, now, requireUnexpired: true });
    const evaluation = evaluateApprovalForTransitionPlan(request, [envelope], { now });
    const plan = validateSavedTransitionPlan({
      ...fresh,
      approval: { ...fresh.approval, evaluation, envelopeId: envelope.id, envelopeHash: evaluation.envelopeHash }
    });
    const planPath = transitionPlanPathParts(plan);
    const pathParts = ['governance', 'approvals', `${envelope.id}.json`];
    const before = await captureProjectFileSnapshot(input.projectRoot, planPath);
    if (before.content !== undefined && before.content.toString('utf8') !== `${canonicalJson(plan)}\n`) {
      throw new Error('The approval target plan already contains different bytes; it was preserved.');
    }
    await writeGovernanceApprovalAuthority(input.projectRoot, input.fingerprint, envelope, storage);
    await lease.assertHeld();
    await applyProjectFileTransaction(input.projectRoot, [
      ...(before.content === undefined ? [{ type: 'write' as const, pathParts: planPath, content: `${canonicalJson(plan)}\n` }] : []),
      { type: 'write', pathParts, content: `${canonicalJson(envelope)}\n` }
    ], { preconditions: [before, { pathParts }] });
    return { envelope, plan, pathParts };
  });
}
