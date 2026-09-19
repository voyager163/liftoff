import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from './transition-ports.js';
import { cloneState, evidenceHeaderFor } from './transition-records.js';
import type { ProjectFileMutation } from '../adapters/filesystem/project-transaction.js';
import { buildApprovedPhase0FactsFromState, renderGovernanceChangeWritePlan } from './source-of-truth.js';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { credentialPolicyPathParts, detectCredentialLeaks } from './credentials.js';
import type { PhaseEvidenceRecord, TransitionOperation, LiveReadbackProof } from '../domain/governance/activation/types.js';
import { latestRecordWithPayload, rulesetSourceDigestFromEvidence, selectLatestPhaseEvidence } from '../domain/governance/activation/evidence.js';
import { isRecord } from '../domain/governance/activation/canonical-json.js';
import { errorMessage } from './transition-process.js';
import { remoteRepository } from '../domain/governance/activation/inputs.js';
import { approvalRequestForSavedPlan, evaluateApprovalForTransitionPlan } from '../domain/governance/activation/approvals.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { assertMatchingControlReadback } from '../application/repository-governance/control-readback.js';
import {
  executeRepositoryLiveReadback, executeRepositoryRulesets
} from '../application/repository-governance/producer-rulesets.js';

export async function executeActivationApproval(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  const phaseId = input.phase.id as string;
  if (phaseId !== 'activation-approved' && phaseId !== 'repository-enforcement-approved') return null;
  if (phaseId === 'repository-enforcement-approved') {
    if (!input.plan.approval.envelopeId || input.plan.scope !== 'repository') {
      return { status: 'blocked', blocker: 'Repository enforcement requires its own exact reviewed approval.', completedOperations: [] };
    }
    return { status: 'completed', resultState: 'approved', stateOverride: cloneState(input.inspection.state), completedOperations: [] };
  }
  const { taskProjectionContract } = await import('../domain/governance/activation/operations.js');
  if (!taskProjectionContract(input.plan.operations)) {
    return { status: 'blocked', blocker: 'Activation source approval requires its exact reviewed current-task projection contract.', completedOperations: [] };
  }
  const state = cloneState(input.inspection.state);
  const fileMutations: ProjectFileMutation[] = [];
  if (input.inspection.sourceOfTruth.status === 'none') {
    const facts = buildApprovedPhase0FactsFromState(
      input.inspection.manifest, input.inspection.state, input.inspection.evidence, input.inspection.contexts['phase-0-complete']
    );
    if (!facts || input.inspection.sourceOfTruth.createPlan.status !== 'ready') {
      return { status: 'blocked', blocker: input.inspection.sourceOfTruth.createPlan.reason, completedOperations: [] };
    }
    const writePlan = renderGovernanceChangeWritePlan(facts);
    const { governanceSourceFilesWithoutTasks } = await import('./task-writes.js');
    for (const file of governanceSourceFilesWithoutTasks(writePlan)) {
      if (await readProjectFile(input.inspection.projectRoot, [...file.pathParts]) !== undefined) {
        return { status: 'blocked', blocker: `Refusing to overwrite existing governance artifact ${file.pathParts.join('/')}.`, completedOperations: [] };
      }
      fileMutations.push({ type: 'write', pathParts: [...file.pathParts], content: file.content });
    }
    state.activeChange = { id: writePlan.changeId, kind: writePlan.workflowKind === 'openspec' ? 'openspec' : 'spec-kit' };
  } else if (input.inspection.sourceOfTruth.status === 'selected') {
    state.activeChange = {
      id: input.inspection.sourceOfTruth.selected.changeId,
      kind: input.inspection.sourceOfTruth.selected.workflowKind === 'openspec' ? 'openspec' : 'spec-kit'
    };
  } else {
    return {
      status: 'blocked',
      blocker: 'A compatible governance source of truth is required before activation approval can be recorded.',
      completedOperations: []
    };
  }
  return {
    status: 'completed', resultState: 'approved', stateOverride: state, fileMutations,
    filePreconditions: fileMutations.map((mutation) => ({ pathParts: [...mutation.pathParts] })),
    completedOperations: input.plan.operations.filter((op) => op.actionId.endsWith('governance.create-change'))
  };
}

export async function executeCredentialReady(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  if (input.phase.id !== 'credential-ready') return null;
  const policy = await readProjectFile(input.inspection.projectRoot, [...credentialPolicyPathParts]);
  if (policy === undefined) {
    return {
      status: 'blocked',
      blocker: 'Public credential enrollment and independent credential readback are unavailable; no credential policy is present. Do not supply a token through setup or fabricate policy proof.',
      completedOperations: []
    };
  }
  const scan = detectCredentialLeaks([{ source: 'imported-evidence', label: credentialPolicyPathParts.join('/'), text: policy.toString('utf8') }]);
  if (scan.status === 'compromised') return { status: 'blocked', blocker: scan.guidance.join(' '), completedOperations: [] };
  return {
    status: 'blocked',
    blocker: 'Independent credential readback and public credential enrollment are unavailable; a policy file cannot establish credential readiness.',
    completedOperations: []
  };
}

function assertGreenRedProof(input: PhaseAdapterExecutionInput): PhaseEvidenceRecord {
  const record = latestRecordWithPayload(input.inspection, 'green-red-proof');
  if (!record || !isRecord(record.payload) || record.payload.kind !== 'green-red-proof.v1') {
    throw new Error('Ruleset enforcement requires current green-red-proof evidence with typed proof payload.');
  }
  const green = isRecord(record.payload.green) ? record.payload.green : null;
  const red = isRecord(record.payload.deliberateRed) ? record.payload.deliberateRed : null;
  const greenConclusion = green?.conclusion;
  const redConclusion = red?.conclusion;
  if ([greenConclusion, redConclusion].some((value) => value === 'skipped' || value === 'cancelled' || value === 'neutral')) {
    throw new Error('Skipped, cancelled, and neutral checks cannot satisfy green/red proof.');
  }
  if (!red || greenConclusion !== 'success' || redConclusion !== 'failure' || red.deliberate !== true) {
    throw new Error('Ruleset enforcement requires green success and deliberate red failure proof.');
  }
  return record;
}

export async function executeRulesetPhase(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome | null> {
  const phaseId = input.phase.id as string;
  if (phaseId !== 'rulesets-applied' && phaseId !== 'live-readback' &&
      phaseId !== 'repository-rulesets-applied' && phaseId !== 'repository-live-readback') return null;
  if (!input.adapters.githubRulesets) {
    return phaseId === 'rulesets-applied' || phaseId === 'repository-rulesets-applied'
      ? executeRepositoryRulesets(input) : executeRepositoryLiveReadback(input);
  }
  const isRepositoryScope = phaseId.startsWith('repository-') || input.plan.scope === 'repository';
  if (!isRepositoryScope) {
    try {
      assertGreenRedProof(input);
    } catch (error) {
      return { status: 'blocked', blocker: errorMessage(error), completedOperations: [] };
    }
  }
  const sourceDigest = rulesetSourceDigestFromEvidence(input.inspection, isRepositoryScope ? 'repository' : 'activation');
  if (!sourceDigest) {
    return { status: 'blocked', blocker: 'Ruleset enforcement requires a current exact ruleset source digest; no fallback source can grant authority.', completedOperations: [] };
  }
  const adapter = input.adapters.githubRulesets;
  const envelopeId = input.plan.approval.envelopeId;
  const isWritePhase = phaseId === 'rulesets-applied' || phaseId === 'repository-rulesets-applied';
  if (isWritePhase && !envelopeId) {
    return { status: 'blocked', blocker: 'Ruleset enforcement requires a persisted enforcement approval envelope.', completedOperations: [] };
  }
  const completed: TransitionOperation[] = [];
  await input.lease?.assertHeld();
  const executionTime = input.clock?.() ?? input.now;
  if (Date.parse(input.plan.expiresAt) <= executionTime.getTime()) {
    return { status: 'blocked', blocker: 'The reviewed ruleset plan expired before provider access.', completedOperations: [] };
  }
  if (input.phase.approvalGate.required) {
    const requested = approvalRequestForSavedPlan(input.plan, input.phase, input.inspection.state);
    const authorization = evaluateApprovalForTransitionPlan(
      requested,
      input.inspection.approvals,
      { now: executionTime }
    );
    if (authorization.approvalRequired || authorization.envelopeHash !== input.plan.approval.envelopeHash) {
      return { status: 'blocked', blocker: 'Ruleset approval is no longer valid immediately before provider access.', completedOperations: [] };
    }
  }
  const write = isWritePhase
    ? await adapter.applyRuleset({ repository: remoteRepository(input.inspection.state).name, sourceDigest, approvalEnvelopeId: envelopeId ?? 'ungated-readback' })
    : await adapter.readRuleset({ repository: remoteRepository(input.inspection.state).name, sourceDigest });
  completed.push(...input.plan.operations.filter((op) => isWritePhase
    ? op.actionId === 'github.ruleset.apply' || op.actionId === 'github.ruleset.readback'
    : op.actionId === 'github.ruleset.readback'));
  try {
    assertMatchingControlReadback(sourceDigest, write, remoteRepository(input.inspection.state).name);
  } catch {
    return { status: 'blocked', blocker: 'Post-write live ruleset readback did not match the saved source digest.', completedOperations: completed };
  }
  const header = evidenceHeaderFor({ inspection: input.inspection, phase: input.phase, plan: input.plan, result: 'verified', now: input.now });
  const liveReadback: LiveReadbackProof = {
    schemaVersion: input.inspection.state.identity.evidenceHeaderSchemaVersion,
    repositoryId: header.repositoryId, identity: header.identity, phaseGraphHash: header.phaseGraphHash,
    phaseId: header.phaseId, baselineSha: header.baselineSha, inputDigest: header.inputDigest,
    transition: header.transition, observedAt: input.now.toISOString(), provider: 'github',
    resourceType: 'ruleset', resourceId: write.resourceId, sourceDigest, readbackDigest: write.readbackDigest, matches: true
  };
  return {
    status: 'completed', resultState: 'verified', liveReadback: [liveReadback],
    evidencePayload: { kind: `${input.phase.id}.v1`, sourceDigest, resourceId: write.resourceId, readbackDigest: write.readbackDigest },
    completedOperations: completed
  };
}
