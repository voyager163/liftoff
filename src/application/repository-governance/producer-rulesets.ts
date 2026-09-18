import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { latestRecordWithPayload } from '../../domain/governance/activation/evidence.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import {
  buildRepositoryControlPlan, ProductionGitHubRulesetAdapter, readOwnedRepositoryControls,
  assertRepositoryControlObservationUnchanged, repositoryControlMutationBlockers,
  type RepositoryControlPlan, type RepositoryControlWriteResult
} from '../../adapters/github/production-rulesets.js';
import {
  boundedRepositoryControlClient, controlObservationDigest, observeRepositoryControls, repositorySettings, type RepositoryControlSnapshot
} from '../../adapters/github/repository-control-observation.js';
import { GitHubActivationError, positiveId, safeGitHubFailure } from '../../adapters/github/activation-rest.js';
import {
  clientFor, githubOperation, phaseConfiguration, repositoryConfiguration
} from '../../governance-activation/github-config.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import type {
  PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { controlReadbackProof } from './control-readback.js';
import {
  createRepositoryControlJournal, readPrivateOwnedRepositoryControls, repositoryControlChangeOperation, repositoryControlOperationState,
  unresolvedRepositoryControlPlan, verifiedRepositoryControlProgress
} from './repository-control-checkpoints.js';
import { assertRepositoryControlAuthority } from './repository-control-authority.js';
import { repositoryControlSource } from './repository-control-source.js';
import {
  latestOwnedRepositoryControlReceipt, readRepositoryControlReceipt, writeRepositoryControlReceipt,
  type RepositoryControlReceipt
} from './repository-control-receipts.js';
import { evaluateMainHoldReplacement, observedMainUpdateHold, ownedControlsForMainHold } from './producer-main-hold.js';
import type { FailedWorkflowArtifactRequest, OriginalCheckFixturePlanReference } from '../../adapters/github/production-checks.js';
import type { SourceCheckFixtureArtifactReadback } from './source-check-artifact.js';
import { pendingRepositoryArtifactOperation } from './repository-control-artifact-readback.js';

function scopedPhase(input: PhasePlanningInput | PhaseAdapterExecutionInput, readback = false): 'repository' | 'activation' {
  const repository = input.phase.id === (readback ? 'repository-live-readback' : 'repository-rulesets-applied');
  if (!repository && input.phase.id !== (readback ? 'live-readback' : 'rulesets-applied') ||
    (input.inspection.scope ?? 'activation') !== (repository ? 'repository' : 'activation')) {
    throw new GitHubActivationError('control-scope', 'Repository-only and full enforcement use their own exact selected phases, sources and authority.');
  }
  return repository ? 'repository' : 'activation';
}

function configuration(input: PhasePlanningInput) {
  const value = phaseConfiguration(input.inspection, input.phase.id, ['settings', 'mainHold']);
  if (!['hold', 'replace', 'qualified'].includes(String(value.mainHold))) {
    throw new GitHubActivationError('main-hold-selection', 'Select the displayed mainHold mode explicitly: hold for deferred production, replace for a separately approved existing hold, or qualified for genuine full activation without a prior hold.');
  }
  return { settings: repositorySettings(value.settings), mainHold: value.mainHold as RepositoryControlPlan['mainHold']['mode'] };
}

function controlPlanOperation(
  input: PhasePlanningInput, plan: RepositoryControlPlan, failedWorkflowArtifacts?: readonly FailedWorkflowArtifactRequest[],
  originalFixturePlans?: readonly OriginalCheckFixturePlanReference[]
): TransitionOperation {
  return githubOperation(input, 'github.ruleset.readback', 'github-read', {
    repository: plan.baseline.binding.repository, sourceDigest: plan.sourceDigest, controlPlan: plan,
    ...(plan.source.qualificationReferences ? { qualificationReferences: plan.source.qualificationReferences } : {}),
    ...(originalFixturePlans?.length ? { originalFixturePlans } : {}),
    ...(failedWorkflowArtifacts?.length ? { failedWorkflowArtifacts } : {})
  });
}

function operationsFor(
  input: PhasePlanningInput, plan: RepositoryControlPlan, failedWorkflowArtifacts?: readonly FailedWorkflowArtifactRequest[],
  originalFixturePlans?: readonly OriginalCheckFixturePlanReference[]
): readonly TransitionOperation[] {
  const destination: TransitionOperation['destination'] = {
    type: 'repository', identity: plan.baseline.binding.repository, repository: plan.baseline.binding.repository
  };
  return [
    ...plan.changes.map((change) => githubOperation(input,
      change.kind === 'settings' ? 'github.repository.settings.apply' : 'github.ruleset.apply',
      change.kind === 'settings' ? 'github-write' : 'github-ruleset-write',
      { repository: plan.baseline.binding.repository, controlPlanDigest: canonicalSha256(plan), change },
      destination
    )),
    controlPlanOperation(input, plan, failedWorkflowArtifacts, originalFixturePlans)
  ];
}

function reviewedControlPlan(operations: readonly TransitionOperation[]): { plan: RepositoryControlPlan; read: TransitionOperation } {
  const reads = operations.filter((entry) => entry.actionId === 'github.ruleset.readback' && isRecord(entry.inputs.controlPlan));
  if (reads.length !== 1) throw new GitHubActivationError('control-plan', 'The reviewed plan must contain one exact complete control/readback inventory.');
  const read = reads[0]!;
  const plan = read.inputs.controlPlan as unknown as RepositoryControlPlan;
  if (canonicalSha256(buildRepositoryControlPlan(plan)) !== canonicalSha256(plan) ||
    read.inputs.repository !== plan.baseline.binding.repository || read.inputs.sourceDigest !== plan.sourceDigest) {
    throw new GitHubActivationError('control-plan', 'The exact desired control bytes, identities or ordered effects changed after review.');
  }
  for (const change of plan.changes) repositoryControlChangeOperation(plan, change, operations);
  if (operations.filter((entry) => entry.adapter === 'github').length !== plan.changes.length + 1) {
    throw new GitHubActivationError('control-plan', 'Unregistered or duplicate provider effects cannot be appended to control reconciliation.');
  }
  return { plan, read };
}

function currentHoldControls(observation: RepositoryControlSnapshot, receipt: RepositoryControlReceipt): readonly unknown[] {
  return ownedControlsForMainHold({
    controls: receipt.result.ownedControls.map((owned) => {
      const current = observation.rulesets.find((entry) => entry.definition.id === owned.id && entry.definition.node_id === owned.nodeId);
      if (!current) throw new GitHubActivationError('main-hold-drift', 'A held owned provider identity disappeared; no hold replacement is authorized.');
      return current;
    })
  });
}

function assertHoldBaseline(
  observation: RepositoryControlSnapshot, prior: RepositoryControlReceipt | null,
  mode: RepositoryControlPlan['mainHold']['mode']
): void {
  if (mode === 'replace' && !prior?.mainHold ||
    mode === 'qualified' && prior?.mainHold?.status === 'active') {
    throw new GitHubActivationError('main-hold-approval', 'A retained installed hold requires the explicit separately reviewed replacement path; qualified mode cannot silently remove it.');
  }
  if (mode !== 'replace' || !prior?.mainHold) return;
  if (observation.mainSha !== prior.mainHold.boundMainSha ||
    observation.binding.repositoryId !== prior.mainHold.repositoryId ||
    canonicalSha256(currentHoldControls(observation, prior)) !== prior.mainHold.ownedControlsDigest ||
    Object.entries(prior.controlPlan.desiredSettings).some(([name, value]) => observation.settings[name] !== value)) {
    throw new GitHubActivationError('main-hold-drift', 'Current main, exact held control identities/definitions or owned settings changed; the hold was retained.');
  }
}

export async function planRepositoryRulesets(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    const scope = scopedPhase(input);
    const config = configuration(input);
    if (scope === 'repository' && config.mainHold !== 'hold') {
      throw new GitHubActivationError('main-hold-selection', 'Repository-only authority cannot replace a production hold or claim full qualification.');
    }
    const state = input.inspection.state.phases[input.phase.id];
    const recovery = input.inspection.recoverPhase === input.phase.id || state?.state === 'running' ||
      state?.state === 'blocked' && state.executionPlanDigest !== undefined;
    const remoteId = input.inspection.state.remoteBinding?.id;
    if (!remoteId || !/^[1-9]\d*$/u.test(remoteId)) {
      throw new GitHubActivationError('repository-binding', 'Control planning requires the actual independently published numeric repository ID.');
    }
    const unresolved = await unresolvedRepositoryControlPlan(input, positiveId(Number(remoteId)));
    if (unresolved && !recovery) {
      throw new GitHubActivationError('control-recovery', 'A durable control intent has no settled outcome; inspect its exact original recovery plan before further mutation.');
    }
    let recoveryPlan: { plan: RepositoryControlPlan; operations: readonly TransitionOperation[] } | undefined;
    if (recovery) {
      const pendingRead = state.operation?.status === 'failed' && input.inspection.contexts[input.phase.id].reviewedPlans?.find((entry) =>
        entry.planDigest === state.executionPlanDigest && entry.operations.some((operation) =>
          operation.actionId === 'github.ruleset.readback' && Array.isArray(operation.inputs.failedWorkflowArtifacts) &&
          operation.inputs.failedWorkflowArtifacts.some((request) => isRecord(request) &&
            canonicalSha256(request.operation) === canonicalSha256(state.operation))));
      const original = input.inspection.contexts[input.phase.id].reviewedPlans?.find((plan) =>
        plan.phaseId === input.phase.id && plan.planDigest === (unresolved ?? (pendingRead ? pendingRead.planDigest : state.operation?.planDigest) ?? state.executionPlanDigest));
      if (!original) throw new GitHubActivationError('control-recovery', 'Control recovery requires the original reviewed plan and retained private checkpoints.');
      const { plan } = reviewedControlPlan(original.operations);
      recoveryPlan = { plan, operations: original.operations };
      if (unresolved) {
        if (canonicalSha256(config.settings) !== canonicalSha256(plan.desiredSettings) || config.mainHold !== plan.mainHold.mode) {
          throw new GitHubActivationError('control-recovery', 'An unresolved control plan cannot change its exact desired settings or hold mode.');
        }
        return { operations: original.operations.filter((operation) => operation.adapter === 'github') };
      }
    }
    const repository = repositoryConfiguration(input.inspection).name;
    const client = boundedRepositoryControlClient(clientFor(input));
    const baseline = await observeRepositoryControls(client, repository, positiveId(Number(remoteId)));
    const source = await repositoryControlSource(input, client, baseline.binding, config.mainHold, undefined, { kind: 'plan' });
    if (recoveryPlan && canonicalSha256(config.settings) === canonicalSha256(recoveryPlan.plan.desiredSettings) &&
      config.mainHold === recoveryPlan.plan.mainHold.mode && canonicalSha256(source.source) === canonicalSha256(recoveryPlan.plan.source)) {
      const progress = await verifiedRepositoryControlProgress(input, recoveryPlan.plan);
      if (progress && controlObservationDigest(progress) === controlObservationDigest(baseline)) {
        return { operations: recoveryPlan.operations.filter((operation) => operation.adapter === 'github') };
      }
    }
    const prior = await latestOwnedRepositoryControlReceipt(input);
    assertHoldBaseline(baseline, prior?.receipt ?? null, config.mainHold);
    const ownedControls = await readPrivateOwnedRepositoryControls(input, baseline.binding, recovery ? 'known-recovery' : 'current');
    const plan = buildRepositoryControlPlan({
      scope, baseline, source: source.source, desiredRulesets: source.desiredRulesets, desiredSettings: config.settings, ownedControls,
      mainHold: { mode: config.mainHold, priorReceiptDigest: prior?.digest ?? null }
    });
    if (plan.changes.some((change) => change.kind === 'settings') && !input.phase.allowedMutations.remote.includes('github-write')) {
      return { operations: [], blockers: ['The frozen full rulesets-applied phase does not authorize repository-settings mutations. Establish the exact settings in their repository-scoped approved path; no effect is relabeled as read or ruleset-write.'] };
    }
    return { operations: operationsFor(input, plan, source.failedWorkflowArtifacts, source.originalFixturePlans), blockers: repositoryControlMutationBlockers(plan) };
  } catch (error) {
    return { operations: [], blockers: [safeGitHubFailure(error)] };
  }
}

function outcomeEvidence(
  input: PhaseAdapterExecutionInput, receipt: RepositoryControlReceipt, digest: string,
  result: RepositoryControlWriteResult, artifactReadbacks: readonly SourceCheckFixtureArtifactReadback[] = []
): Pick<PhaseAdapterOutcome, 'evidencePayload' | 'liveReadback' | 'outputs'> {
  const repository = result.observation.binding.repository;
  const settings = Object.fromEntries(Object.keys(receipt.controlPlan.desiredSettings).map((name) => [name, result.observation.settings[name]]));
  const settingsId = `/repos/${repository}`;
  const mainId = `/repos/${repository}/git/ref/heads/main`;
  return {
    evidencePayload: {
      kind: `${input.phase.id}.v1`, scope: receipt.scope,
      repository, repositoryId: result.observation.binding.repositoryId,
      actor: result.observation.binding.actor, sourceDigest: result.sourceDigest, readbackDigest: result.readbackDigest,
      publishedRulesetFileDigest: receipt.controlPlan.source.fileInventoryDigest,
      sourceSha: receipt.controlPlan.source.sourceSha, qualificationDigest: receipt.controlPlan.source.qualificationDigest,
      resourceId: result.resourceId, ownedControls: result.ownedControls,
      desiredRulesets: receipt.controlPlan.desiredRulesets, settings, mainSha: result.observation.mainSha,
      mainHold: receipt.mainHold, replacedHoldDigest: receipt.replacedHoldDigest, controlReceiptDigest: digest,
      ...(artifactReadbacks.length ? { artifactReadbacks } : {})
    },
    liveReadback: [
      controlReadbackProof(input, result.sourceDigest, result, repository),
      readbackProof(input, 'github', 'repository-settings', settingsId, { repositoryId: result.observation.binding.repositoryId, settings }),
      readbackProof(input, 'github', 'main-baseline', mainId, {
        repositoryId: result.observation.binding.repositoryId, mainSha: result.observation.mainSha, mainHold: receipt.mainHold
      }),
      ...artifactReadbacks.map((artifact) => readbackProof(input, 'github', 'workflow-artifact',
        `/repos/${repository}/actions/artifacts/${artifact.request.artifact.artifactId}`, artifact))
    ],
    outputs: {
      values: { controlReceiptDigest: digest, rulesetDigest: result.readbackDigest, mainSha: result.observation.mainSha,
        mainHoldStatus: receipt.mainHold?.status ?? 'qualified-without-hold' },
      resources: [
        { provider: 'github', resourceType: 'ruleset', resourceId: result.resourceId },
        { provider: 'github', resourceType: 'repository-settings', resourceId: settingsId },
        { provider: 'github', resourceType: 'main-baseline', resourceId: mainId },
        ...artifactReadbacks.map((artifact) => ({
          provider: 'github' as const, resourceType: 'workflow-artifact',
          resourceId: `/repos/${repository}/actions/artifacts/${artifact.request.artifact.artifactId}`
        }))
      ]
    }
  };
}

export async function executeRepositoryRulesets(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const completed: TransitionOperation[] = [];
  let artifactReadbacks: readonly SourceCheckFixtureArtifactReadback[] = [];
  let activePlan: RepositoryControlPlan | undefined;
  try {
    const scope = scopedPhase(input);
    const { plan, read } = reviewedControlPlan(input.plan.operations);
    activePlan = plan;
    const config = configuration(input);
    if (scope !== plan.scope || config.mainHold !== plan.mainHold.mode ||
      canonicalSha256(config.settings) !== canonicalSha256(plan.desiredSettings)) {
      throw new GitHubActivationError('control-plan', 'The selected scope, exact settings or main-hold mode changed after approval.');
    }
    await assertRepositoryControlAuthority(input, read);
    const client = boundedRepositoryControlClient(clientFor(input));
    const prior = plan.mainHold.priorReceiptDigest ? await readRepositoryControlReceipt(input, plan.mainHold.priorReceiptDigest) : null;
    const revalidate = async () => {
      const source = await repositoryControlSource(input, client, plan.baseline.binding, plan.mainHold.mode, plan.source,
        { kind: 'readback', authority: { execution: input, operation: read } });
      artifactReadbacks = source.artifactReadbacks ?? [];
      if (canonicalSha256(source.source) !== canonicalSha256(plan.source) ||
        canonicalSha256(buildRepositoryControlPlan({ ...plan, desiredRulesets: source.desiredRulesets }).desiredRulesets) !== canonicalSha256(plan.desiredRulesets)) {
        throw new GitHubActivationError('control-proof-drift', 'Current scope-specific workflow/check/production qualification differs from the reviewed source; the main hold remains.');
      }
      if (plan.mainHold.mode === 'replace') {
        if (!prior?.mainHold) throw new GitHubActivationError('main-hold-approval', 'The separately approved replacement has no retained installed hold.');
        const evaluation = evaluateMainHoldReplacement({
          hold: prior.mainHold, currentMainSha: plan.baseline.mainSha, currentOwnedControls: currentHoldControls(plan.baseline, prior),
          qualificationEvidence: input.inspection.evidence, qualificationContexts: input.inspection.contexts,
          replacementPlan: input.plan, state: input.inspection.state,
          replacementApproval: input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId),
          now: input.clock?.() ?? input.now
        });
        if (!evaluation.canRelease) throw new GitHubActivationError('main-hold-approval', evaluation.reasons.join(' '));
      }
    };
    assertHoldBaseline(plan.baseline, prior, plan.mainHold.mode);
    const journal = createRepositoryControlJournal(input, plan, read, completed, revalidate);
    const adapter = new ProductionGitHubRulesetAdapter({
      client, desiredRulesets: plan.desiredRulesets, ownedControls: plan.ownedControls,
      controlExecution: {
        plan, approvalEnvelopeId: input.plan.approval.envelopeId!, journal,
        recovery: input.recovery === true && input.plan.recovery === true
      }
    });
    const result = await adapter.applyRuleset({
      repository: plan.baseline.binding.repository, sourceDigest: plan.sourceDigest,
      approvalEnvelopeId: input.plan.approval.envelopeId!
    }) as RepositoryControlWriteResult;
    const mainHold = plan.mainHold.mode === 'hold'
      ? prior?.mainHold && prior.mainHold.ownedControlsDigest === canonicalSha256(ownedControlsForMainHold(result)) &&
        prior.mainHold.boundMainSha === result.observation.mainSha && prior.mainHold.settingsDigest === canonicalSha256(plan.desiredSettings)
        ? prior.mainHold
        : observedMainUpdateHold({
          plan, result, planDigest: input.plan.planDigest, approvalEnvelopeId: input.plan.approval.envelopeId!,
          approvalEnvelopeHash: input.plan.approval.envelopeHash!, priorHold: prior?.mainHold, now: input.clock?.() ?? input.now
        })
      : null;
    const saved = await writeRepositoryControlReceipt(input, {
      controlPlan: plan, result, mainHold,
      replacedHoldDigest: plan.mainHold.mode === 'replace' && prior?.mainHold ? canonicalSha256(prior.mainHold) : null
    });
    completed.push(read);
    return {
      status: 'completed', resultState: 'verified', completedOperations: completed,
      ...outcomeEvidence(input, saved.receipt, saved.digest, result, artifactReadbacks)
    };
  } catch (error) {
    let operation: PhaseAdapterOutcome['operation'];
    if (activePlan) {
      try { operation = await repositoryControlOperationState(input, activePlan); }
      catch { /* Preserve the original failure and the unreadable private checkpoint. */ }
    }
    operation ??= pendingRepositoryArtifactOperation(error);
    return {
      status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: completed,
      ...(operation ? { operation } : {}),
      cleanupWarnings: ['Retain all exact control IDs and private pre-effect/response/readback records. Unknown outcomes authorize neither retry nor automatic protection removal.']
    };
  }
}

async function readbackReceipt(input: PhasePlanningInput) {
  const scope = scopedPhase(input, true);
  const phase = scope === 'repository' ? 'repository-rulesets-applied' : 'rulesets-applied';
  const record = latestRecordWithPayload(input.inspection, phase);
  if (!record || record.header.result !== 'verified' || record.header.scope !== scope ||
    !isRecord(record.payload) || typeof record.payload.controlReceiptDigest !== 'string') {
    throw new GitHubActivationError('control-readback-source', 'Independent readback requires the current same-scope approved enforcement receipt with exact owned IDs, desired definitions, settings and main baseline.');
  }
  const receipt = await readRepositoryControlReceipt(input, record.payload.controlReceiptDigest);
  if (receipt.scope !== scope) throw new GitHubActivationError('control-readback-scope', 'Repository enforcement is not a full-activation control receipt.');
  return { digest: record.payload.controlReceiptDigest, receipt };
}

export async function planRepositoryLiveReadback(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    const { digest, receipt } = await readbackReceipt(input);
    const originalRead = reviewedControlPlan(receipt.executionPlan.operations).read;
    return { operations: [githubOperation(input, 'github.ruleset.readback', 'github-read', {
      repository: receipt.controlPlan.baseline.binding.repository, rulesetSourceDigest: receipt.controlPlan.sourceDigest,
      controlReceiptDigest: digest,
      ...(receipt.controlPlan.source.qualificationReferences
        ? { qualificationReferences: receipt.controlPlan.source.qualificationReferences } : {}),
      ...(originalRead.inputs.failedWorkflowArtifacts !== undefined
        ? { failedWorkflowArtifacts: structuredClone(originalRead.inputs.failedWorkflowArtifacts) } : {}),
      ...(originalRead.inputs.originalFixturePlans !== undefined
        ? { originalFixturePlans: structuredClone(originalRead.inputs.originalFixturePlans) } : {})
    })] };
  } catch (error) {
    return { operations: [], blockers: [safeGitHubFailure(error)] };
  }
}

export async function executeRepositoryLiveReadback(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  try {
    const { digest, receipt } = await readbackReceipt(input);
    const currentPlan = await planRepositoryLiveReadback(input);
    const read = currentPlan.operations[0];
    if (!read || !input.plan.operations.some((entry) => canonicalSha256(entry) === canonicalSha256(read)) ||
      input.plan.operations.filter((entry) => entry.adapter === 'github').length !== 1) {
      throw new GitHubActivationError('control-readback-plan', 'The exact same-scope receipt-bound readback operation changed.');
    }
    await assertRepositoryControlAuthority(input, read);
    const now = input.clock?.() ?? input.now;
    if (Date.parse(receipt.approval.expiresAt) <= now.getTime() ||
      !input.inspection.approvals.some((entry) => canonicalApprovalEnvelopeHash(entry) === canonicalApprovalEnvelopeHash(receipt.approval))) {
      throw new GitHubActivationError('control-readback-approval', 'The original exact enforcement approval is no longer current; fresh control review is required.');
    }
    const client = boundedRepositoryControlClient(clientFor(input));
    const source = await repositoryControlSource(input, client, receipt.controlPlan.baseline.binding,
      receipt.controlPlan.mainHold.mode, receipt.controlPlan.source,
      { kind: 'readback', authority: { execution: input, operation: read } });
    if (canonicalSha256(source.source) !== canonicalSha256(receipt.controlPlan.source)) {
      throw new GitHubActivationError('control-readback-proof', 'Current workflow/check/qualification proof no longer matches the approved enforcement receipt.');
    }
    const result = await readOwnedRepositoryControls(client, receipt.controlPlan, receipt.result.ownedControls);
    assertRepositoryControlObservationUnchanged(result.observation, receipt.result.observation);
    if (receipt.mainHold && (receipt.mainHold.boundMainSha !== result.observation.mainSha ||
      receipt.mainHold.ownedControlsDigest !== canonicalSha256(ownedControlsForMainHold(result)))) {
      throw new GitHubActivationError('main-hold-readback', 'The installed hold or current main/owned control baseline changed.');
    }
    if (receipt.scope === 'activation' && receipt.mainHold?.status === 'active') {
      throw new GitHubActivationError('main-hold-retained', 'Full activation cannot finish while the deferred-production main hold remains; its qualified replacement needs separate exact approval.');
    }
    return { status: 'completed', resultState: 'verified', completedOperations: [read],
      ...outcomeEvidence(input, receipt, digest, result, source.artifactReadbacks) };
  } catch (error) {
    const operation = pendingRepositoryArtifactOperation(error);
    return { status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: [], ...(operation ? { operation } : {}) };
  }
}
