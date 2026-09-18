import type { GovernanceTransitionInspection, GovernanceTransitionAdapters, ApplyNextPreview, PhasePlanBuild } from './transition-ports.js';
import { phaseScope, phaseInScope, type PhaseId, type PhaseGraphNode, type TransitionOperation, type MutationClass, type SavedTransitionPlan } from '../domain/governance/activation/types.js';
import { type CommandRunner, NodeCommandRunner } from '../process-runner.js';
import { evidencePathParts, safeTimestamp, evidenceWriteOperation, stateWriteOperation, assertNoSecrets } from './transition-records.js';
import { remoteRepository, githubRepositoryFromPushUrl } from '../domain/governance/activation/inputs.js';
import {
  operation, transitionDestination, phaseById, phaseUsesProvider, planDigestFor, rollbackPlanForPhase, assertPlanOperationsAllowed
} from '../domain/governance/activation/operations.js';
import { generatedSeedChangeName, previewLocalSeedPhase, selectSeedBaselineChecks } from './seed-lifecycle.js';
import { gitCommitOperations, gitPushOperations, reviewedPushUrl, inspectGitRepository } from './phase-publication.js';
import { credentialPolicyPathParts } from './credentials.js';
import { latestRecordWithPayload, rulesetSourceDigestFromEvidence } from '../domain/governance/activation/evidence.js';
import { validateManifestActivationForExecution, validateSavedTransitionPlan } from '../domain/governance/activation/validators.js';
import { transitionPlanForPhase, evaluateApprovalForTransitionPlan, combineApprovalRequests } from '../domain/governance/activation/approvals.js';
import { phaseCapabilities } from '../domain/governance/activation/capabilities.js';
import { errorMessage } from './transition-process.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { planAzurePhase } from './phase-azure.js';
import { planGitHubPhase } from './phase-github.js';
import { plannedFileChanges } from './transition-files.js';
import { completedSpecKitTasks, inspectSpecKitBootstrap, specKitBootstrapPath } from './spec-kit-seed.js';
import { captureProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { buildApprovedPhase0FactsFromState, renderGovernanceChangeWritePlan } from './source-of-truth.js';
import { protectedLocalInputBlockers } from './inputs.js';
import { planGovernanceTaskProjection, withoutDerivedTaskWrites } from './task-writes.js';
import { taskProjectionContract } from '../domain/governance/activation/operations.js';
import { planHistoricalPublicationReadback } from '../application/repository-governance/publication-revalidation.js';
import { bindGovernanceTransitionContext } from './transition-context.js';
import { planCompositePhase } from './phase-composite.js';

const planLifetimeMs = 15 * 60 * 1000;

async function phaseOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner,
  createdAt: string,
  localRevalidation = false
): Promise<TransitionOperation[]> {
  const repositoryName = remoteRepository(inspection.state).name;
  const baseEvidencePath = evidencePathParts(`${phase.id}-${safeTimestamp(createdAt)}`);
  const writeOps = () => [evidenceWriteOperation(phase, baseEvidencePath), stateWriteOperation(phase)];
  const repositoryStep = (actionId: string, mutationClass: MutationClass, inputs: Record<string, unknown>, repository = repositoryName) =>
    operation({
      adapter: 'github', actionId, mutationClass, phaseId: phase.id, inputs,
      destination: transitionDestination('repository', repository, { repository }),
      remote: true, destructive: false
    });
  const subscriptionStep = (
    actionId: string,
    mutationClass: MutationClass,
    inputs: Record<string, unknown>,
    subscriptionId = inspection.activationInputs?.azure?.subscriptionId ?? inspection.state.activationInputs?.azure?.subscriptionId
  ) => operation({
    adapter: 'azure-opentofu', actionId, mutationClass, phaseId: phase.id, inputs,
    destination: transitionDestination('subscription', subscriptionId ?? 'unresolved', { ...(subscriptionId ? { subscriptionId } : {}) }),
    remote: true, destructive: false
  });
  const localStep = (
    actionId: string,
    mutationClass: MutationClass,
    inputs: Record<string, unknown>,
    destination: TransitionOperation['destination'],
    adapter: TransitionOperation['adapter'] = 'selected-spec-workflow',
    destructive = false
  ) => operation({ adapter, actionId, mutationClass, phaseId: phase.id, inputs, destination, remote: false, destructive });

  if (localRevalidation) {
    if (phase.id !== 'seed-valid' && phase.id !== 'seed-verified' && phase.id !== 'seed-archived') {
      throw new Error(`Local revalidation stops before ${phase.id}; review its separate governance transition.`);
    }
    const preview = await previewLocalSeedPhase(inspection.projectRoot, inspection.manifest, phase.id);
    if (preview.blockers.length) throw new Error(preview.blockers.join(' '));
    return [preview.operation, ...writeOps()];
  }

  switch (phase.id) {
    case 'repository-enforcement-approved':
      return [stateWriteOperation(phase)];
    case 'repository-discovered':
    case 'repository-workflow-source-ready':
    case 'repository-checks-qualified':
    case 'repository-rulesets-applied':
    case 'repository-live-readback':
      throw new Error(`Phase ${phase.id} requires its concrete repository producer.`);
    case 'seed-valid':
      return [
        localStep('openspec.seed.validate', 'read-worktree',
          { changeName: generatedSeedChangeName(inspection.manifest) }, transitionDestination('local', inspection.projectRoot)),
        ...writeOps()
      ];
    case 'seed-verified':
      return [
        localStep('openspec.seed.baseline-verify', 'read-worktree', {
          changeName: generatedSeedChangeName(inspection.manifest),
          checks: selectSeedBaselineChecks(inspection.manifest).map((check) => ({
            id: check.id, taskId: check.taskId, applicable: check.applicability.applicable
          }))
        }, transitionDestination('local', inspection.projectRoot)),
        ...(inspection.manifest.project.specWorkflow === 'spec-kit' ? [
          localStep('seed.tasks.project', 'write-seed-tasks', { pathParts: ['specs', '000-liftoff-bootstrap', 'tasks.md'] },
            transitionDestination('local', 'specs/000-liftoff-bootstrap/tasks.md', { pathParts: ['specs', '000-liftoff-bootstrap', 'tasks.md'] }))
        ] : []),
        ...writeOps()
      ];
    case 'seed-archived':
      return [
        localStep('openspec.seed.archive', inspection.manifest.project.specWorkflow === 'spec-kit' ? 'read-worktree' : 'write-openspec-seed',
          { changeName: generatedSeedChangeName(inspection.manifest) },
          transitionDestination('local', inspection.manifest.project.specWorkflow === 'spec-kit' ? 'specs/000-liftoff-bootstrap' : 'openspec/changes')),
        ...writeOps()
      ];
    case 'committed':
      return [...await gitCommitOperations(inspection, phase, runner), ...writeOps()];
    case 'pushed':
      return [...await gitPushOperations(inspection, phase, runner), ...writeOps()];
    case 'phase-0-complete': {
      const repository = githubRepositoryFromPushUrl(reviewedPushUrl(await inspectGitRepository(inspection.projectRoot, runner)));
      return [repositoryStep('github.phase0.discover', 'github-read', { repository }, repository), ...writeOps()];
    }
    case 'activation-approved': {
      const actionId = inspection.manifest.project.specWorkflow === 'openspec'
        ? 'openspec.governance.create-change' : 'spec-kit.governance.create-change';
      const changeId = inspection.sourceOfTruth.status === 'none' ? inspection.sourceOfTruth.createPlan.changeId :
        inspection.sourceOfTruth.status === 'selected' ? inspection.sourceOfTruth.selected.changeId : null;
      if (!changeId) throw new Error('A reviewed governance change destination is required.');
      const changePath = inspection.manifest.project.specWorkflow === 'openspec'
        ? ['openspec', 'changes', changeId] : ['specs', changeId];
      return [
        localStep(actionId, 'write-openspec-governance', { workflowKind: inspection.manifest.project.specWorkflow },
          transitionDestination('local', changePath.join('/'), { pathParts: changePath })),
        stateWriteOperation(phase)
      ];
    }
    case 'bootstrap-workflow-source-ready':
    case 'application-prerequisites-ready':
    case 'application-artifact-ready':
      throw new Error(`Phase ${phase.id} requires its concrete production planner.`);
    case 'credential-ready':
      return [repositoryStep('github.credential.verify-policy', 'github-read', { policyPathParts: credentialPolicyPathParts }), ...writeOps()];
    case 'provider-ready':
      return [subscriptionStep('azure.provider.ensure-ready', 'azure-provider-register', { retainedCapability: true }), ...writeOps()];
    case 'state-path-selected':
      return [subscriptionStep('azure.state-path.select', 'azure-read', { allowed: ['existing-private', 'bootstrap-local'] }), ...writeOps()];
    case 'existing-private-path':
      return [subscriptionStep('azure.existing-private-path.verify', 'azure-read', { statePath: 'existing-private' }), ...writeOps()];
    case 'bootstrap-local':
      return [
        subscriptionStep('azure.bootstrap-local.apply', 'azure-network-provision', { boundedLocalBootstrap: true }),
        ...writeOps()
      ];
    case 'runner-ready':
      return [repositoryStep('github.runner.ensure-ready', 'github-write', { restrictedRunner: true }), ...writeOps()];
    case 'private-backend-proof':
      return [repositoryStep('github.runner.backend-proof', 'github-read', { requiredConclusion: 'success' }), ...writeOps()];
    case 'remote-import-verified':
      return [subscriptionStep('azure.remote-import.verify', 'azure-state-import', { noChangePlanRequired: true }), ...writeOps()];
    case 'remote-ready': {
      const statePath = inspection.state.applicability.statePath;
      if (statePath === 'none') throw new Error('Remote readiness requires an explicitly selected backend path.');
      const selectedPath = statePath === 'bootstrap-local' ? 'remote-import-verified' : 'existing-private-path';
      const selected = latestRecordWithPayload(inspection, selectedPath);
      if (selected?.header.result !== 'verified') throw new Error('Remote readiness requires successful proof from the selected backend path.');
      const proof = selected.liveReadback?.find((entry) => entry.provider === 'azure');
      const subscriptionId = proof?.resourceId.match(/^\/subscriptions\/([a-f0-9-]+)\//i)?.[1];
      if (!subscriptionId) throw new Error('Remote readiness requires the selected backend proof to bind a verified subscription destination.');
      return [subscriptionStep('azure.remote-ready.verify', 'azure-read', { retainBootstrapStateForDays: 30 }, subscriptionId), ...writeOps()];
    }
    case 'application-foundation':
      return [subscriptionStep('azure.application-foundation.apply', 'azure-resource-provision', { noProviderUnregisterRollback: true }), ...writeOps()];
    case 'workflow-source-ready':
      return [
        localStep('local.workflow-source.write', 'write-workflows', { path: '.github/workflows' },
          transitionDestination('local', '.github/workflows', { pathParts: ['.github', 'workflows'] }), 'local-state'),
        localStep('local.ruleset-source.write', 'write-ruleset-source', { path: '.github/rulesets' },
          transitionDestination('local', '.github/rulesets', { pathParts: ['.github', 'rulesets'] }), 'local-state'),
        ...writeOps()
      ];
    case 'dev-proof':
      return [repositoryStep('github.checks.dev-proof', 'github-read', { acceptedConclusions: ['success'] }), ...writeOps()];
    case 'staging-qualified':
      return [repositoryStep('github.checks.staging', 'github-read', { acceptedConclusions: ['success'] }), ...writeOps()];
    case 'production-rehearsed':
      return [repositoryStep('github.checks.production-rehearsal', 'github-read', { acceptedConclusions: ['success'] }), ...writeOps()];
    case 'green-red-proof':
      return [repositoryStep('github.checks.green-red-proof', 'github-read', { required: ['green-success', 'deliberate-red-failure'] }), ...writeOps()];
    case 'enforcement-approved':
      return [stateWriteOperation(phase)];
    case 'rulesets-applied':
      return [
        repositoryStep('github.ruleset.apply', 'github-ruleset-write', { sourceDigest: rulesetSourceDigestFromEvidence(inspection) ?? 'missing' }),
        repositoryStep('github.ruleset.readback', 'github-read', { sourceDigest: rulesetSourceDigestFromEvidence(inspection) ?? 'missing' }),
        ...writeOps()
      ];
    case 'live-readback':
      return [repositoryStep('github.ruleset.readback', 'github-read', { sourceDigest: rulesetSourceDigestFromEvidence(inspection) ?? 'missing' }), ...writeOps()];
    case 'bootstrap-state-disposed': {
      const paths = {
        encryptedStatePathParts: inspection.state.bootstrapState?.encryptedStatePathParts ?? [],
        encryptionKeyPathParts: inspection.state.bootstrapState?.encryptionKeyPathParts ?? []
      };
      const destinations = [...paths.encryptedStatePathParts, ...paths.encryptionKeyPathParts];
      return [
        ...destinations.map((destination) => localStep('local.bootstrap-state.dispose', 'delete-local-state', paths,
          transitionDestination('local', destination.join('/'), { pathParts: destination }), 'local-state', true)),
        ...writeOps()
      ];
    }
  }
}

async function buildBasePhaseOperations(
  inspection: GovernanceTransitionInspection,
  phase: PhaseGraphNode,
  runner: CommandRunner,
  createdAt: string,
  localRevalidation: boolean,
  adapters: GovernanceTransitionAdapters
): Promise<PhasePlanBuild> {
  if (!localRevalidation && (phase.id === 'committed' || phase.id === 'pushed')) {
    const publication = await planHistoricalPublicationReadback(inspection, phase.id, runner, adapters.githubActivation?.storage);
    if (publication) {
      return { operations: [...publication,
        evidenceWriteOperation(phase, evidencePathParts(`${phase.id}-${safeTimestamp(createdAt)}`)), stateWriteOperation(phase)] };
    }
  }
  if (!localRevalidation && phaseScope(phase.id) !== 'local') {
    const input = { inspection, phase, runner, now: new Date(createdAt), adapters };
    const engines = adapters.providerEngines;
    const composite = await (engines ? engines.azureActivation.planCompositePhase(input) : planCompositePhase(input));
    const planned: Array<PhasePlanBuild | null> = composite ? [composite] : [];
    if (!composite) {
      const azure = phaseUsesProvider(phase, 'azure')
        ? await (engines ? engines.azureActivation.planPhase(input) : planAzurePhase(input)) : null;
      if (azure?.blockers?.length) throw new Error(azure.blockers.join(' '));
      planned.push(azure, phaseUsesProvider(phase, 'github')
        ? await (engines ? engines.repositoryGovernance.planPhase(input) : planGitHubPhase(input)) : null);
    }
    const providers = planned.filter((build): build is PhasePlanBuild => build !== null);
    if (providers.length > 0) {
      const blockers = providers.flatMap((build) => build.blockers ?? []);
      if (blockers.length) throw new Error(blockers.join(' '));
      return {
        operations: [
          ...providers.flatMap((build) => build.operations),
          evidenceWriteOperation(phase, evidencePathParts(`${phase.id}-${safeTimestamp(createdAt)}`)),
          stateWriteOperation(phase)
        ],
        fileMutations: providers.flatMap((build) => build.fileMutations ?? []),
        filePreconditions: providers.flatMap((build) => build.filePreconditions ?? [])
      };
    }
  }
  const operations = await phaseOperations(inspection, phase, runner, createdAt, localRevalidation);
  if (phase.id === 'activation-approved' && inspection.sourceOfTruth.status === 'none') {
    const facts = buildApprovedPhase0FactsFromState(
      inspection.manifest, inspection.state, inspection.evidence, inspection.contexts['phase-0-complete']
    );
    if (!facts) throw new Error('Current verified Phase 0 facts are required to preview governance change creation.');
    const write = renderGovernanceChangeWritePlan(facts);
    return {
      operations,
      fileMutations: write.files.map((file) => ({ type: 'write', pathParts: [...file.pathParts], content: file.content })),
      filePreconditions: write.files.map((file) => ({ pathParts: [...file.pathParts] }))
    };
  }
  if (!localRevalidation && phase.id === 'seed-verified' && inspection.manifest.project.specWorkflow === 'spec-kit') {
    const bundle = await inspectSpecKitBootstrap(inspection.projectRoot, inspection.manifest);
    if (bundle.issues.length || bundle.tasks === undefined) {
      throw new Error(`Spec Kit bootstrap tasks must be valid before planning their verified projection: ${bundle.issues.join(' ')}`);
    }
    const pathParts = [...specKitBootstrapPath, 'tasks.md'];
    return {
      operations,
      fileMutations: [{ type: 'write', pathParts, content: completedSpecKitTasks(bundle.tasks) }],
      filePreconditions: [await captureProjectFileSnapshot(inspection.projectRoot, pathParts)]
    };
  }
  if (!localRevalidation && phase.id === 'bootstrap-state-disposed' && inspection.state.bootstrapState) {
    const paths = [
      ...inspection.state.bootstrapState.encryptedStatePathParts,
      ...inspection.state.bootstrapState.encryptionKeyPathParts
    ];
    return {
      operations,
      fileMutations: paths.map((pathParts) => ({ type: 'delete', pathParts: [...pathParts] })),
      filePreconditions: await Promise.all(paths.map((pathParts) => captureProjectFileSnapshot(inspection.projectRoot, [...pathParts])))
    };
  }
  return { operations };
}

async function buildPhaseOperations(
  inspection: GovernanceTransitionInspection, phase: PhaseGraphNode, runner: CommandRunner,
  createdAt: string, localRevalidation: boolean, adapters: GovernanceTransitionAdapters
): Promise<PhasePlanBuild> {
  const build = await buildBasePhaseOperations(inspection, phase, runner, createdAt, localRevalidation, adapters);
  if (localRevalidation) return build;
  const projection = await planGovernanceTaskProjection(inspection, phase);
  const contract = projection && taskProjectionContract([projection]);
  return {
    ...build, operations: [...build.operations, ...(projection ? [projection] : [])],
    fileMutations: withoutDerivedTaskWrites(build.fileMutations ?? [], projection),
    filePreconditions: build.filePreconditions?.filter((entry) => entry.pathParts.join('/') !== contract?.taskPathParts.join('/'))
  };
}

export async function buildSavedTransitionPlan(input: {
  inspection: GovernanceTransitionInspection;
  adapters?: GovernanceTransitionAdapters;
  runner?: CommandRunner;
  now?: Date;
  localRevalidation?: boolean;
  phaseId?: PhaseId;
  createdAt?: string;
}): Promise<SavedTransitionPlan | null> {
  validateManifestActivationForExecution(input.inspection.manifest);
  const phaseId = input.phaseId ?? input.inspection.recoverPhase ?? input.inspection.readiness.nextPlannablePhase ?? input.inspection.readiness.nextReadyPhase;
  if (!phaseId) return null;
  if (input.inspection.manifest.governance.profile === 'none' && phaseScope(phaseId) === 'activation') {
    throw new Error('Governance activation is explicitly disabled. A local repair, JSON flag, or existing approval cannot enable the profile.');
  }
  if (input.inspection.scope === 'local' && phaseScope(phaseId) !== 'local') {
    throw new Error(`The local scope cannot plan or execute ${phaseId}.`);
  }
  if (input.inspection.scope === 'lifecycle' && phaseScope(phaseId) !== 'lifecycle') {
    throw new Error(`The lifecycle scope cannot plan or execute ${phaseId}.`);
  }
  if (input.inspection.scope === 'activation' && phaseScope(phaseId) === 'lifecycle') {
    throw new Error(`The activation scope cannot plan or execute ${phaseId}.`);
  }
  if (input.inspection.scope === 'repository' && !phaseInScope(phaseId, 'repository', true) ||
    input.inspection.scope === 'activation' && phaseScope(phaseId) === 'repository') {
    throw new Error(`The ${input.inspection.scope} scope cannot plan or execute ${phaseId}.`);
  }
  if (phaseId === 'seed-verified') {
    const blockers = protectedLocalInputBlockers(input.inspection.sensitivePathExclusions ?? []);
    if (blockers.length) throw new Error(blockers.join(' '));
  }
  if (input.inspection.recoverPhase && !input.inspection.readiness.phases[phaseId]?.plannable &&
    !['ready', 'running'].includes(input.inspection.readiness.phases[phaseId]?.state ?? '')) {
    throw new Error(`Recovery of ${phaseId} is not plannable: ${input.inspection.readiness.phases[phaseId]?.blockers?.join(' ') ?? ''}`);
  }
  const runner = input.runner ?? new NodeCommandRunner();
  const phase = phaseById(input.inspection.graph, phaseId);
  const createdAt = input.createdAt ?? (input.now ?? new Date()).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + planLifetimeMs).toISOString();
  const context = input.inspection.contexts[phaseId];
  const { adapters } = bindGovernanceTransitionContext({ adapters: input.adapters });
  const build = await buildPhaseOperations(input.inspection, phase, runner, createdAt, input.localRevalidation ?? false, adapters);
  const operations = build.operations;
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const configurationBinding = input.inspection.configurationBinding ?? input.inspection.state.configurationBinding;
  const selectionScope = input.inspection.scope ?? phaseScope(phaseId);
  const recovery = input.inspection.recoverPhase === phaseId;
  const fileChanges = await plannedFileChanges(input.inspection.projectRoot, build.fileMutations ?? [], build.filePreconditions);
  const primaryApproval = transitionPlanForPhase(
    phase, input.inspection.state, context.transition, input.inspection.projectRoot,
    phase.id === 'pushed' ? operations.find((operation) => operation.adapter === 'git')?.destination.identity : undefined,
    { operations, configuration, configurationBinding, selectionScope, fileChanges, recovery }
  );
  const approvalBundle: NonNullable<SavedTransitionPlan['approvalBundle']>[number][] = [];
  const approvalRequests = [primaryApproval];
  if ((phase.id === 'enforcement-approved' || phase.id === 'repository-enforcement-approved') && !recovery) {
    const rulesets = phaseById(input.inspection.graph, phase.id === 'repository-enforcement-approved' ? 'repository-rulesets-applied' : 'rulesets-applied');
    const sourceDigest = rulesetSourceDigestFromEvidence(input.inspection, selectionScope);
    if (!sourceDigest) throw new Error('Final enforcement approval requires a current reviewed ruleset source digest.');
    const child = await buildPhaseOperations(input.inspection, rulesets, runner, createdAt, false, adapters);
    const childChanges = await plannedFileChanges(input.inspection.projectRoot, child.fileMutations ?? [], child.filePreconditions);
    const childContext = input.inspection.contexts[rulesets.id];
    approvalBundle.push({
      phaseId: rulesets.id, inputDigest: childContext.inputDigest, transitionDigest: childContext.transition.transitionDigest,
      operations: child.operations, fileChanges: childChanges
    });
    approvalRequests.push(transitionPlanForPhase(rulesets, input.inspection.state, childContext.transition,
      input.inspection.projectRoot, undefined, { operations: child.operations, configuration, configurationBinding, selectionScope, fileChanges: childChanges }));
  }
  const approvalPlan = approvalRequests.length > 1 ? combineApprovalRequests(approvalRequests) : primaryApproval;
  const evaluation = evaluateApprovalForTransitionPlan(approvalPlan, input.inspection.approvals, { now: input.now });
  const digest = planDigestFor({ phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: approvalPlan.planDigest });
  const plan = validateSavedTransitionPlan({
    schemaVersion: 2, scope: phaseScope(phaseId), selectionScope, phaseId, createdAt, expiresAt,
    identity: input.inspection.state.identity,
    graphHash: input.inspection.graphHash,
    stateHash: input.inspection.loadedState?.contentHash ?? null,
    baselineDigest: context.baselineSha, inputDigest: context.inputDigest,
    transitionDigest: context.transition.transitionDigest, planDigest: digest,
    mutationClasses: phase.allowedMutations, operations,
    approval: {
      gateKind: phase.approvalGate.kind, required: phase.approvalGate.required, evaluation,
      envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash
    },
    rollbackPlan: rollbackPlanForPhase(phase),
    ...(configuration ? { configuration } : {}),
    ...(configurationBinding ? { configurationBinding } : {}),
    fileChanges,
    recovery,
    ...(approvalBundle.length ? { approvalBundle } : {}),
    noSecrets: true
  });
  assertPlanOperationsAllowed(plan, phase);
  assertNoSecrets(plan);
  return plan;
}

export async function previewApplyNext(input: {
  inspection: GovernanceTransitionInspection;
  adapters?: GovernanceTransitionAdapters;
  runner?: CommandRunner;
  now?: Date;
  execute: boolean;
  localRevalidation?: boolean;
}): Promise<ApplyNextPreview> {
  let plan: SavedTransitionPlan | null = null;
  const blockers: string[] = [];
  try {
    plan = await buildSavedTransitionPlan(input);
    if (plan && phaseCapabilities[plan.phaseId].blocker) blockers.push(phaseCapabilities[plan.phaseId].blocker!);
  } catch (error) {
    blockers.push(errorMessage(error));
  }
  const nextReadyPhase = input.inspection.readiness.nextReadyPhase;
  const selectedPhase = plan?.phaseId ?? input.inspection.readiness.nextPlannablePhase ?? nextReadyPhase;
  if (!selectedPhase && blockers.length === 0) {
    const first = input.inspection.graph.phases.find((phase) =>
      (!input.inspection.scope || phaseInScope(phase.id, input.inspection.scope, true)) &&
      (input.inspection.readiness.phases[phase.id]?.blockers.length ?? 0) > 0);
    if (first) blockers.push(...(input.inspection.readiness.phases[first.id]?.blockers ?? []));
  }
  if (!selectedPhase || blockers.length > 0 || !plan) {
    return {
      schemaVersion: 3, scope: input.inspection.scope, command: 'governance apply-next', projectRoot: input.inspection.projectRoot,
      execute: input.execute, applied: false, authorized: false, reason: 'blocked',
      message: blockers[0] ?? 'No phase is ready for execution.', selectedPhase, nextReadyPhase,
      approval: plan?.approval ?? null,
      proposedMutations: {
        local: plan?.mutationClasses.local ?? ['none'], remote: plan?.mutationClasses.remote ?? ['none'], operations: plan?.operations ?? []
      },
      savedPlan: null, noWrites: true,
      blockers: blockers.length > 0 ? blockers : ['No phase is ready for execution.']
    };
  }
  if (plan.approval.evaluation.approvalRequired) {
    return {
      schemaVersion: 3, scope: input.inspection.scope, command: 'governance apply-next', projectRoot: input.inspection.projectRoot,
      execute: input.execute, applied: false, authorized: false, reason: 'approval-required',
      message: plan.approval.evaluation.reasons.join('; '), selectedPhase, nextReadyPhase, approval: plan.approval,
      proposedMutations: { local: plan.mutationClasses.local, remote: plan.mutationClasses.remote, operations: plan.operations },
      savedPlan: null, noWrites: true, blockers: plan.approval.evaluation.reasons
    };
  }
  return {
    schemaVersion: 3, scope: input.inspection.scope, command: 'governance apply-next', projectRoot: input.inspection.projectRoot,
    execute: input.execute, applied: false, authorized: true,
    reason: input.execute ? 'execute-requested' : 'execute-required',
    message: input.execute
      ? 'Execution requested; the plan must be saved and revalidated before any mutation.'
      : 'Preview only. Rerun with --execute to save this plan and execute at most one phase.',
    selectedPhase, nextReadyPhase, approval: plan.approval,
    proposedMutations: { local: plan.mutationClasses.local, remote: plan.mutationClasses.remote, operations: plan.operations },
    savedPlan: null, noWrites: true, blockers: []
  };
}

export function comparePlanFreshness(saved: SavedTransitionPlan, fresh: SavedTransitionPlan | null): string[] {
  if (!fresh) return ['No phase remained ready after saving the transition plan.'];
  const issues: string[] = [];
  if (saved.phaseId !== fresh.phaseId) issues.push(`Ready phase changed from ${saved.phaseId} to ${fresh.phaseId}.`);
  for (const field of ['stateHash', 'baselineDigest', 'inputDigest', 'transitionDigest'] as const) {
    if (saved[field] !== fresh[field]) issues.push(`${field} changed after plan save.`);
  }
  if (canonicalSha256(saved.operations) !== canonicalSha256(fresh.operations)) issues.push('Proposed operations changed after plan save.');
  if (saved.scope !== fresh.scope || saved.selectionScope !== fresh.selectionScope ||
    canonicalSha256(saved.configurationBinding ?? null) !== canonicalSha256(fresh.configurationBinding ?? null) ||
    canonicalSha256(saved.configuration ?? null) !== canonicalSha256(fresh.configuration ?? null) ||
    canonicalSha256(saved.fileChanges ?? []) !== canonicalSha256(fresh.fileChanges ?? []) ||
    canonicalSha256(saved.approvalBundle ?? []) !== canonicalSha256(fresh.approvalBundle ?? [])) {
    issues.push('Selected scope, configuration, or reviewed file outputs changed after plan save.');
  }
  if (saved.approval.evaluation.approvalRequired || fresh.approval.evaluation.approvalRequired) {
    issues.push('Approval was not valid immediately before execution.');
  }
  return issues;
}
