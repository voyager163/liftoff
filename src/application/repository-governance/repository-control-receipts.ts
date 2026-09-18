import { lstat, realpath } from 'node:fs/promises';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { evidenceBodyDigest } from '../../domain/governance/activation/evidence.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan } from '../../domain/governance/activation/validators.js';
import type { ApprovalEnvelope, SavedTransitionPlan } from '../../domain/governance/activation/types.js';
import {
  buildRepositoryControlPlan,
  type RepositoryControlPlan, type RepositoryControlWriteResult
} from '../../adapters/github/production-rulesets.js';
import { GitHubActivationError } from '../../adapters/github/activation-rest.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import type { ObservedMainUpdateHold } from './producer-main-hold.js';
import { readRepositoryControlOwnership } from './repository-control-checkpoints.js';

export interface RepositoryControlReceipt {
  schemaVersion: 1;
  kind: 'github-repository-control-readback';
  projectRoot: string;
  projectIdentity: { device: string; inode: string; birthtime: string };
  activationIdentityDigest: string;
  scope: 'repository' | 'activation';
  controlPlan: RepositoryControlPlan;
  executionPlan: SavedTransitionPlan;
  approval: ApprovalEnvelope;
  result: RepositoryControlWriteResult;
  mainHold: ObservedMainUpdateHold | null;
  replacedHoldDigest: string | null;
  observedAt: string;
}

type ControlInput = PhasePlanningInput | PhaseAdapterExecutionInput;

async function identity(input: ControlInput) {
  const stat = await lstat(input.inspection.projectRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitHubActivationError('control-receipt', 'Control receipt project identity is no longer a regular directory.');
  return {
    projectRoot: await realpath(input.inspection.projectRoot),
    projectIdentity: { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) }
  };
}

export async function writeRepositoryControlReceipt(input: PhaseAdapterExecutionInput, values: {
  controlPlan: RepositoryControlPlan;
  result: RepositoryControlWriteResult;
  mainHold: ObservedMainUpdateHold | null;
  replacedHoldDigest: string | null;
}): Promise<{ digest: string; receipt: RepositoryControlReceipt }> {
  if (!input.lease) throw new GitHubActivationError('lease-required', 'Control readback persistence requires the real project mutation lease.');
  await input.lease.assertHeld();
  const approval = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
  if (!approval || canonicalApprovalEnvelopeHash(approval) !== input.plan.approval.envelopeHash) {
    throw new GitHubActivationError('control-receipt', 'Control readback has no exact issued enforcement approval.');
  }
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, approval, githubPorts(input).storage);
  const receipt: RepositoryControlReceipt = {
    schemaVersion: 1, kind: 'github-repository-control-readback', ...await identity(input),
    activationIdentityDigest: canonicalSha256(currentActivationIdentity), scope: values.controlPlan.scope,
    ...values, executionPlan: input.plan, approval, observedAt: (input.clock?.() ?? input.now).toISOString()
  };
  const digest = canonicalSha256(receipt);
  await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage).write(digest, receipt);
  return { digest, receipt };
}

export async function readRepositoryControlReceipt(
  input: ControlInput, digest: string
): Promise<RepositoryControlReceipt> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new GitHubActivationError('control-receipt', 'A complete exact private control receipt digest is required.');
  const saved = await createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', githubPorts(input).storage).read(digest);
  const expected = await identity(input);
  const receipt = saved?.value;
  if (!saved || !isRecord(receipt) || canonicalSha256(receipt) !== digest || Object.keys(receipt).length !== 13 ||
    receipt.schemaVersion !== 1 || receipt.kind !== 'github-repository-control-readback' ||
    receipt.projectRoot !== expected.projectRoot || saved.projectRoot !== expected.projectRoot ||
    canonicalSha256(receipt.projectIdentity) !== canonicalSha256(expected.projectIdentity) ||
    receipt.activationIdentityDigest !== canonicalSha256(currentActivationIdentity) ||
    !isRecord(receipt.controlPlan) || !isRecord(receipt.result) ||
    receipt.controlPlan.scope !== receipt.scope ||
    !(receipt.scope === 'repository' || receipt.scope === 'activation')) {
    throw new GitHubActivationError('control-receipt', 'The retained private control receipt is missing, changed or copied from another project identity.');
  }
  const plan = validateSavedTransitionPlan(receipt.executionPlan);
  const approval = validateApprovalEnvelope(receipt.approval, { expectedIdentity: currentActivationIdentity });
  const controlPlan = receipt.controlPlan as unknown as RepositoryControlPlan;
  if (canonicalSha256(buildRepositoryControlPlan(controlPlan)) !== canonicalSha256(controlPlan) ||
    plan.scope !== receipt.scope || plan.approval.envelopeId !== approval.id ||
    plan.approval.envelopeHash !== canonicalApprovalEnvelopeHash(approval) ||
    !plan.operations.some((operation) => operation.actionId === 'github.ruleset.readback' &&
      canonicalSha256(operation.inputs.controlPlan) === canonicalSha256(controlPlan)) ||
    receipt.result.sourceDigest !== controlPlan.sourceDigest || receipt.result.readbackDigest !== controlPlan.sourceDigest ||
    controlPlan.baseline.binding.repository !== input.inspection.state.remoteBinding?.name ||
    String(controlPlan.baseline.binding.repositoryId) !== input.inspection.state.remoteBinding?.id) {
    throw new GitHubActivationError('control-receipt', 'The private control receipt does not bind its exact published repository, source plan and issued approval.');
  }
  await assertGovernanceApprovalIssued(input.inspection.projectRoot, approval, githubPorts(input).storage);
  const ownership = await readRepositoryControlOwnership(input, controlPlan.baseline.binding);
  const owned = receipt.result.ownedControls;
  if (!Array.isArray(owned) || owned.length !== controlPlan.desiredRulesets.length ||
    new Set(owned.map((entry) => isRecord(entry) ? entry.name : undefined)).size !== owned.length ||
    owned.some((entry) => !isRecord(entry) || !ownership.some((known) => canonicalSha256(known) === canonicalSha256(entry)))) {
    throw new GitHubActivationError('control-receipt', 'The result inventory is not backed by actual retained private provider-response ownership. Names, source digests and copied receipts cannot establish owned IDs.');
  }
  return receipt as unknown as RepositoryControlReceipt;
}

export async function latestOwnedRepositoryControlReceipt(
  input: ControlInput
): Promise<{ digest: string; receipt: RepositoryControlReceipt } | null> {
  const records = input.inspection.evidence.filter((record) =>
    ['repository-rulesets-applied', 'rulesets-applied'].includes(record.header.phaseId) &&
    record.header.result === 'verified' && canonicalSha256(record.header.identity) === canonicalSha256(currentActivationIdentity) &&
    record.header.bodyDigest === evidenceBodyDigest(record.payload, record.liveReadback) &&
    input.inspection.state.phases[record.header.phaseId]?.evidence.some((reference) =>
      reference.evidenceId === record.evidenceId && reference.headerDigest === canonicalSha256(record.header)) &&
    isRecord(record.payload) && typeof record.payload.controlReceiptDigest === 'string'
  ).sort((left, right) => Date.parse(right.header.producedAt) - Date.parse(left.header.producedAt));
  const latest = records[0];
  if (!latest || !isRecord(latest.payload)) return null;
  const digest = String(latest.payload.controlReceiptDigest);
  if (records[1]?.header.producedAt === latest.header.producedAt &&
    isRecord(records[1].payload) && records[1].payload.controlReceiptDigest !== digest) {
    throw new GitHubActivationError('control-receipt', 'Conflicting equally current ownership receipts cannot select a control inventory.');
  }
  return { digest, receipt: await readRepositoryControlReceipt(input, digest) };
}
