import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { runnerPreflightSecretName, type CredentialPolicy, type TransitionOperation, type ExternalOperationState } from '../../domain/governance/activation/types.js';
import {
  buildGitHubAppCredentialPolicy, canonicalCredentialRepository, credentialPolicyPathParts
} from '../../governance-activation/credentials.js';
import { clientFor, githubOperation, repositoryConfiguration } from '../../governance-activation/github-config.js';
import { githubPorts } from '../../governance-activation/github-ports.js';
import { readbackProof } from '../../governance-activation/transition-records.js';
import { activationFileHash } from '../../governance-activation/transition-files.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanBuild, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { captureProjectFileSnapshot } from '../filesystem/project-transaction.js';
import type { UpdatePreviewOptions } from '../filesystem/update-previews.js';
import { GitHubActivationError, object, safeGitHubFailure } from '../github/activation-rest.js';
import { assertCredentialAuthority } from './credential-authority.js';
import {
  assertCredentialPolicyPrecondition, credentialPolicyBytes, parseCredentialPolicyBytes, planCredentialPolicyTransaction,
  stageCredentialPolicyTransaction, type CredentialPolicyTransactionPlan
} from './credential-policy-transaction.js';
import {
  credentialPrincipal, credentialReference, credentialUuid, enrollGitHubCredential, githubCliSecretWriter,
  inspectGitHubCredentialTarget, validateGitHubCredentialTarget, parseGitHubCredentialConfiguration, readGitHubSecretMetadata, credentialProductionContractGaps,
  type CredentialEnrollmentPlan, type GitHubCredentialConfiguration, type GitHubCredentialTarget, type GitHubSecretMetadata,
  type GitHubSecretWriter
} from './github-enrollment.js';
import { privateTtyCredentialChannel, protectedStdinCredentialChannel, type ProtectedCredentialChannel } from './protected-input.js';
import {
  credentialUsageJob, credentialUsageWorkflowPath, parseCredentialUsageChallenge, verifyCredentialUsageChallenge,
  parseCredentialUsageSelection, credentialWorkflowRunBinding, credentialUsageActionId,
  type CredentialUsageChallenge, type CredentialArtifactReference
} from './credential-usage-challenge.js';
import {
  assertCredentialUsageIssued, credentialUsageDispatchPlan, prepareCredentialUsageDispatch, recordCredentialUsageDispatch,
  recordCredentialUsageArtifact, readCredentialArtifactReference, readCredentialUsageSecretPrecondition, credentialUsageOperationEffects
} from './credential-usage-authority.js';
import { dispatchApprovedWorkflowRun, WorkflowDispatchReadbackPendingError } from '../github/production-checks.js';
import { readWorkflowEffect } from '../../application/repository-governance/workflow-checkpoints.js';
import { validateCredentialPolicy } from '../../domain/governance/activation/validators.js';
import {
  credentialPermissionBoundary, assertCredentialProviderPolicyPermitted,
  type CredentialProviderPermissionBoundary
} from './credential-permissions.js';
import { assertLegacyCredentialEffectAdmission } from './credential-legacy-effects.js';
import {
  credentialEnrollmentStageReviewOutcome, credentialUsageStageReviewOutcome,
  credentialRunReadbackPendingOutcome, credentialTerminalReadbackBlockedOutcome
} from './credential-stage-review.js';

export interface ProductionCredentialConfiguration {
  mode: 'enroll' | 'challenge' | 'verify';
  credential: GitHubCredentialConfiguration;
  principal: GitHubCredentialTarget['principal'];
  /** Existing App material is consumed by the approved workflow; it is never rewritten by readiness. */
  source: GitHubCredentialTarget['source'];
  protectedReference: string;
  custodyVersion: string | null;
  /** Renews the public App policy review window only, preserving credential and policy creation identities. */
  policyAction: 'verify' | 'renew-owned';
  challenge?: CredentialUsageChallenge | Omit<CredentialUsageChallenge, 'runId'>;
}

export interface CredentialReadinessPlan {
  kind: 'github-credential-readiness.v1';
  target: GitHubCredentialTarget;
  expectedSecret: GitHubSecretMetadata;
  challenge: CredentialUsageChallenge;
  artifact: CredentialArtifactReference;
  policy: CredentialPolicy;
  policyObservation: { contentHash: string; mode: number } | null;
  policyTransaction: CredentialPolicyTransactionPlan | null;
}

export interface CredentialPermissionReviewPlan {
  kind: 'github-credential-permission-review.v1';
  target: GitHubCredentialTarget;
  permissionBoundary: CredentialProviderPermissionBoundary;
}

export interface CredentialProductionOptions {
  storage?: UpdatePreviewOptions;
}

export interface ProductionCredentialEnrollmentInput extends CredentialProductionOptions {
  executionInput: PhaseAdapterExecutionInput;
  channel?: ProtectedCredentialChannel;
  secretWriter?: GitHubSecretWriter;
}

export function parseProductionCredentialConfiguration(value: unknown): ProductionCredentialConfiguration {
  const config = object(value, 'Credential phase configuration');
  const keys = ['mode', 'credential', 'principal', 'source', 'protectedReference', 'custodyVersion', ...(config.mode !== 'enroll' ? ['challenge'] : []),
    ...(Object.hasOwn(config, 'policyAction') ? ['policyAction'] : [])];
  if (!['enroll', 'challenge', 'verify'].includes(String(config.mode)) || Object.keys(config).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(config, key))) {
    throw new GitHubActivationError('credential-config', 'Select an explicit enroll, challenge or verify plan with exact credential, principal and protected reference/version. Only verification supplies an already recorded provider run ID.');
  }
  if (!['protected-input', 'existing-app-private-key', 'custody-envelope-v1'].includes(String(config.source)) ||
    config.mode === 'enroll' && config.source !== 'protected-input' ||
    config.mode !== 'enroll' && config.source === 'protected-input' ||
    config.policyAction !== undefined && (config.mode !== 'verify' || !['verify', 'renew-owned'].includes(String(config.policyAction)))) {
    throw new GitHubActivationError('credential-config', 'Credential material and public-policy action must be explicitly supported for this mode.');
  }
  return {
    mode: config.mode as ProductionCredentialConfiguration['mode'], credential: parseGitHubCredentialConfiguration(config.credential),
    source: config.source as GitHubCredentialTarget['source'],
    principal: credentialPrincipal(config.principal), protectedReference: credentialReference(config.protectedReference),
    custodyVersion: config.source === 'existing-app-private-key' && config.custodyVersion === null ? null : credentialUuid(config.custodyVersion),
    policyAction: config.policyAction === 'renew-owned' ? 'renew-owned' : 'verify',
    ...(config.mode === 'verify' ? { challenge: parseCredentialUsageChallenge(config.challenge) } :
      config.mode === 'challenge' ? { challenge: parseCredentialUsageSelection(config.challenge) } : {})
  };
}

function configuration(input: PhasePlanningInput | PhaseAdapterExecutionInput): ProductionCredentialConfiguration {
  return parseProductionCredentialConfiguration(input.inspection.activationInputs?.phases['credential-ready']);
}

async function inspectTarget(input: PhasePlanningInput | PhaseAdapterExecutionInput, config: ProductionCredentialConfiguration) {
  const binding = input.inspection.state.remoteBinding;
  if (!binding) throw new GitHubActivationError('credential-publication', 'An independently published exact repository binding is required before credential work.');
  return inspectGitHubCredentialTarget({
    client: clientFor(input), repository: repositoryConfiguration(input.inspection).name, publishedRepositoryId: binding.id,
    configuration: config.credential, principal: config.principal, source: config.source,
    protectedReference: config.protectedReference, custodyVersion: config.custodyVersion,
    now: 'clock' in input ? input.clock?.() ?? input.now : input.now
  });
}

function policyFor(
  target: GitHubCredentialTarget, now: Date,
  allowedWorkflows: CredentialPolicy['allowedWorkflows'] = [{ path: credentialUsageWorkflowPath, jobs: [credentialUsageJob] }]
): CredentialPolicy {
  assertCredentialProviderPolicyPermitted(target.metadata.observedPermissions);
  if (target.configuration.kind === 'fine-grained-pat') {
    throw new GitHubActivationError('credential-pat-lifetime', 'Approved-grant access time is not token creation time. Exact PAT identity and thirty-day lifetime remain unproven.');
  }
  const [owner, name] = target.repository.split('/') as [string, string];
  const repository = canonicalCredentialRepository({ id: String(target.repositoryId), owner, name });
  // This digest commits public independent permission observations, never credential bytes and never alleged usage.
  const readbackDigest = canonicalSha256(target);
  return buildGitHubAppCredentialPolicy({
    repository, identity: currentActivationIdentity, createdAt: now, allowedWorkflows,
    installation: {
      installationId: target.configuration.installationId, appSlug: target.metadata.appSlug!,
      approved: true, verified: true, selection: 'selected-repository', repositories: [repository],
      permissions: { repository: ['metadata:read'], organization: ['organization_administration:read', 'organization_network_configurations:read'] },
      observedPermissions: target.metadata.observedPermissions,
      permissionsVerifiedAt: now.toISOString(), readbackDigest, token: { canGenerate: true, ttlSeconds: 3600 }
    }
  });
}

function assertPolicyTarget(policy: CredentialPolicy, target: GitHubCredentialTarget, now: Date): void {
  assertCredentialProviderPolicyPermitted(target.metadata.observedPermissions);
  credentialPolicyBytes(policy);
  const workflow = policy.allowedWorkflows.find((entry) => entry.path === credentialUsageWorkflowPath);
  if (policy.repository.id !== String(target.repositoryId) || policy.repository.fullName !== target.repository ||
    canonicalSha256(policy.providerPermissions) !== canonicalSha256(target.metadata.observedPermissions) ||
    policy.authKind !== target.configuration.kind || canonicalSha256(policy.identity) !== canonicalSha256(currentActivationIdentity) ||
    policy.status !== 'active' || Date.parse(policy.createdAt) > now.getTime() || Date.parse(policy.expiresAt) <= now.getTime() ||
    policy.authKind === 'fine-grained-pat' && Date.parse(policy.expiresAt) - Date.parse(policy.createdAt) !== 30 * 86400_000 ||
    policy.proof.readbackProvider !== 'github-api' || Date.parse(policy.proof.verifiedAt) > now.getTime() ||
    !workflow || !workflow.jobs.includes(credentialUsageJob) ||
    target.configuration.kind === 'github-app' && (policy.app?.installationId !== target.configuration.installationId ||
      policy.app.appSlug !== target.metadata.appSlug)) {
    throw new GitHubActivationError('credential-policy-binding', 'Credential policy class, repository, allowed source or lifetime does not match the exact reviewed credential.');
  }
}

/** Enrollment and post-usage policy finalization are separate exact reviews; no unknown after-bytes are approved. */
export async function planProductionCredentialReadiness(input: PhasePlanningInput): Promise<PhasePlanBuild> {
  try {
    if (input.phase.id !== 'credential-ready') throw new GitHubActivationError('credential-phase', 'This planner owns only credential-ready.');
    await assertLegacyCredentialEffectAdmission(input);
    const config = configuration(input);
    const target = await inspectTarget(input, config);
    const permissionBoundary = credentialPermissionBoundary(target.metadata.observedPermissions);
    const secret = await readGitHubSecretMetadata(clientFor(input), target.repository);
    if (config.mode === 'enroll') {
      if (secret) throw new GitHubActivationError('credential-preserve-existing', 'The selected secret exists. Enrollment never overwrites an existing value or guesses its version.');
      const enrollment: CredentialEnrollmentPlan = { kind: 'github-credential-enrollment.v1', target, expectedSecret: null, permissionBoundary };
      return {
        operations: [githubOperation(input, 'github.credential.enroll-masked', 'github-secret-write', { enrollment })],
        blockers: [
          ...permissionBoundary.blockers,
          ...(target.configuration.kind === 'fine-grained-pat' ? [credentialProductionContractGaps.patIdentity] : []),
          credentialProductionContractGaps.conditionalCreate
        ]
      };
    }
    if (!secret) throw new GitHubActivationError('credential-secret-absent', 'The exact secret reference is absent; metadata alone would not prove usage even if present.');
    if (config.mode === 'challenge') {
      const selected = parseCredentialUsageSelection(config.challenge);
      const usage = credentialUsageDispatchPlan(target, selected, secret);
      return {
        operations: [githubOperation(input, credentialUsageActionId, 'github-workflow-dispatch', {
          usage, workflow: credentialWorkflowRunBinding(target, selected), dispatchInputs: { challenge: selected.challengeId }
        }, undefined, credentialUsageOperationEffects(target))],
        blockers: [
          ...permissionBoundary.blockers,
          ...(!input.phase.allowedMutations.remote.includes('github-write') ?
            ['The App recipe explicitly issues and revokes installation tokens (github-write). The coordinator must admit these exact effects before dispatch; neither secret replacement nor a read-only label is substituted. Existing artifact verification performs no token writes.'] : [])
        ]
      };
    }
    if (permissionBoundary.blockers.length) {
      const permissionReview: CredentialPermissionReviewPlan = {
        kind: 'github-credential-permission-review.v1', target, permissionBoundary
      };
      return {
        operations: [githubOperation(input, 'github.credential.verify-policy', 'github-read', { permissionReview })],
        blockers: permissionBoundary.blockers
      };
    }
    const snapshot = await captureProjectFileSnapshot(input.inspection.projectRoot, [...credentialPolicyPathParts]);
    if (canonicalSha256(await readCredentialUsageSecretPrecondition(input, target,
      parseCredentialUsageChallenge(config.challenge).challengeId, githubPorts(input).storage)) !== canonicalSha256(secret)) {
      throw new GitHubActivationError('credential-secret-drift', 'The existing secret changed after the approved usage challenge; review a fresh challenge rather than reusing old proof.');
    }
    const previous = snapshot.content ? parseCredentialPolicyBytes(snapshot.content) : null;
    const renewal = config.policyAction === 'renew-owned';
    const policy = renewal && previous ? validateCredentialPolicy({
      ...policyFor(target, input.now, previous.allowedWorkflows), createdAt: previous.createdAt
    }) :
      previous ?? policyFor(target, input.now);
    assertPolicyTarget(policy, target, input.now);
    const transaction = !snapshot.content || renewal ? await planCredentialPolicyTransaction(input.inspection.projectRoot, policy, {
      action: renewal ? 'renew-owned' : 'create', storage: githubPorts(input).storage
    }) : null;
    const readiness: CredentialReadinessPlan = {
      kind: 'github-credential-readiness.v1', target, expectedSecret: secret, challenge: parseCredentialUsageChallenge(config.challenge),
      artifact: await readCredentialArtifactReference(input, target, parseCredentialUsageChallenge(config.challenge), githubPorts(input).storage),
      policy, policyObservation: !transaction && snapshot.content ? { contentHash: activationFileHash(snapshot.content)!, mode: snapshot.mode! } : null,
      policyTransaction: transaction?.plan ?? null
    };
    const operations = [githubOperation(input, 'github.credential.verify-policy', 'github-read', { readiness })];
    if (transaction) operations.push({
      phaseId: 'credential-ready', adapter: 'local-state', actionId: 'local.credential-policy.write',
      mutationClass: 'write-credential-policy', inputs: { policyTransaction: transaction.plan },
      destination: { type: 'local', identity: credentialPolicyPathParts.join('/'), pathParts: credentialPolicyPathParts },
      remote: false, destructive: false
    });
    return {
      operations, ...(transaction ? { fileMutations: [transaction.mutation], filePreconditions: [transaction.snapshot] } : {}),
      ...(target.configuration.kind === 'fine-grained-pat' ? { blockers: [credentialProductionContractGaps.patIdentity] } : {})
    };
  } catch (error) {
    return { operations: [], blockers: [safeGitHubFailure(error)] };
  }
}

function withCredentialStorage(input: PhaseAdapterExecutionInput, storage?: UpdatePreviewOptions): PhaseAdapterExecutionInput {
  return { ...input, adapters: { ...input.adapters,
    githubActivation: { ...githubPorts(input), ...(storage ? { storage } : {}) } } };
}

/** Uses the repository producer's real dispatcher and immutable ledger; never a second remote write implementation. */
export async function executeProductionCredentialChallenge(
  supplied: PhaseAdapterExecutionInput, options: CredentialProductionOptions = {}
): Promise<PhaseAdapterOutcome> {
  const storage = options.storage ?? githubPorts(supplied).storage;
  const input = withCredentialStorage(supplied, storage);
  let external: ExternalOperationState | undefined;
  let completed: TransitionOperation[] = [];
  let dispatchedOperation: TransitionOperation | undefined;
  try {
    await assertLegacyCredentialEffectAdmission(input);
    const operation = exactOperation(input, credentialUsageActionId);
    const plannedTarget = validateGitHubCredentialTarget(object(operation.inputs.usage).target);
    assertCredentialProviderPolicyPermitted(plannedTarget.metadata.observedPermissions);
    await assertCredentialAuthority(input, operation, storage);
    const config = configuration(input);
    if (config.mode !== 'challenge') throw new GitHubActivationError('credential-mode', 'Stored-secret use requires its independently reviewed dispatch plan.');
    const target = await inspectTarget(input, config);
    assertCredentialProviderPolicyPermitted(target.metadata.observedPermissions);
    const selected = parseCredentialUsageSelection(config.challenge);
    const secret = await readGitHubSecretMetadata(clientFor(input), target.repository);
    if (!secret) throw new GitHubActivationError('credential-secret-absent', 'The existing App secret is absent.');
    const expected = credentialUsageDispatchPlan(target, selected, secret);
    if (canonicalSha256(operation.inputs.usage) !== canonicalSha256(expected)) {
      throw new GitHubActivationError('credential-dispatch-target', 'The stored credential target differs from the exact reviewed dispatch scope.');
    }
    const client = clientFor(input);
    const usage = await prepareCredentialUsageDispatch(input, operation, client, storage);
    const workflow = credentialWorkflowRunBinding(target, selected);
    const dispatchInputs = { challenge: selected.challengeId };
    dispatchedOperation = operation;
    const result = await dispatchApprovedWorkflowRun(input, operation, workflow, dispatchInputs);
    external = result.operation;
    completed = [operation];
    if (canonicalSha256(await readGitHubSecretMetadata(client, target.repository)) !== canonicalSha256(usage.expectedSecret)) {
      throw new GitHubActivationError('credential-secret-drift', 'The existing App secret changed during the recorded dispatch. Preserve the operation; its old proof cannot complete current readiness.');
    }
    const effect = await readWorkflowEffect(input, operation, {
      repositoryId: target.repositoryId, ref: `${selected.ref}:${selected.workflowId}`, purpose: 'workflow-dispatch', step: 'dispatch'
    }, { workflow, dispatchInputs });
    if (result.status === 'pending' && result.pendingReason === 'run-readback-unavailable') {
      return credentialRunReadbackPendingOutcome(operation, result.operation, result.correlationId, effect);
    }
    if (!effect?.observed?.providerId) throw new GitHubActivationError('credential-dispatch-record', 'The shared dispatcher has no independently observed exact provider run.');
    const challenge = await recordCredentialUsageDispatch(input, usage, client, {
      operation: result.operation,
      providerRequestId: effect.response?.requestId ?? null, correlationId: effect.prepared.correlationId
    }, storage);
    if (result.status === 'pending') {
      if (result.operation.status !== 'running') throw new GitHubActivationError('credential-operation-state', 'Only an actual running workflow may return pending credential work.');
      return {
        status: 'pending', operation: external, completedOperations: completed,
        blocker: 'The exact credential challenge is still running; recover by bounded readback, never by redispatch.',
        cleanupWarnings: ['No policy was changed by dispatch. Provider run identity and original private approval records are retained.']
      };
    }
    if (result.operation.status !== 'completed' || result.run.conclusion !== 'success') {
      throw new GitHubActivationError('credential-operation-failed', 'A failed or uncertain credential workflow cannot authorize next-stage review.');
    }
    const proof = await verifyCredentialUsageChallenge({
      client, target, challenge, operation: result.operation,
      dispatchCorrelationId: effect.prepared.correlationId, now: input.clock?.() ?? input.now
    });
    await recordCredentialUsageArtifact(input, target, challenge, proof, storage);
    return credentialUsageStageReviewOutcome(input.plan.planDigest, operation, target, challenge, result.operation, proof);
  } catch (error) {
    if (error instanceof WorkflowDispatchReadbackPendingError && dispatchedOperation) {
      return credentialTerminalReadbackBlockedOutcome(dispatchedOperation, error);
    }
    return { status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: completed,
      ...(external ? { operation: external } : {}),
      cleanupWarnings: ['Preserve the immutable shared dispatch and credential records. Unknown submissions cannot be repeated.'] };
  }
}

function exactOperation(input: PhaseAdapterExecutionInput, actionId: string): TransitionOperation {
  const operations = input.plan.operations.filter((entry) => entry.actionId === actionId);
  if (operations.length !== 1) throw new GitHubActivationError('credential-plan', 'The saved plan does not contain one exact required credential operation.');
  return operations[0]!;
}

async function assertReadinessPolicySnapshot(input: PhaseAdapterExecutionInput, readiness: CredentialReadinessPlan): Promise<void> {
  if (readiness.policyTransaction) {
    if (readiness.policyObservation !== null ||
      canonicalSha256(readiness.policyTransaction.policy) !== canonicalSha256(readiness.policy)) {
      throw new GitHubActivationError('credential-policy-plan', 'The policy to be committed is not the independently verified policy.');
    }
    await assertCredentialPolicyPrecondition(input.inspection.projectRoot, readiness.policyTransaction, githubPorts(input).storage);
  } else {
    const snapshot = await captureProjectFileSnapshot(input.inspection.projectRoot, [...credentialPolicyPathParts]);
    if (!snapshot.content || !readiness.policyObservation || snapshot.mode !== readiness.policyObservation.mode ||
      Object.keys(readiness.policyObservation).sort().join(',') !== 'contentHash,mode' ||
      activationFileHash(snapshot.content) !== readiness.policyObservation.contentHash ||
      canonicalSha256(parseCredentialPolicyBytes(snapshot.content)) !== canonicalSha256(readiness.policy)) {
      throw new GitHubActivationError('credential-policy-drift', 'Existing policy bytes or mode changed after review; it was not rewritten.');
    }
  }
}

export async function executeProductionCredentialEnrollment(input: ProductionCredentialEnrollmentInput): Promise<PhaseAdapterOutcome> {
  const execution = input.executionInput;
  const storage = input.storage ?? githubPorts(execution).storage;
  try {
    await assertLegacyCredentialEffectAdmission(withCredentialStorage(execution, storage));
    const operation = exactOperation(execution, 'github.credential.enroll-masked');
    await assertCredentialAuthority(execution, operation, storage);
    if (configuration(execution).mode !== 'enroll') throw new GitHubActivationError('credential-mode', 'A read-only readiness plan cannot authorize enrollment.');
    const enrollment = object(operation.inputs.enrollment) as unknown as CredentialEnrollmentPlan;
    if (canonicalSha256(await inspectTarget(execution, configuration(execution))) !== canonicalSha256(enrollment.target)) {
      throw new GitHubActivationError('credential-config-drift', 'The exact enrollment target is not the configured and published credential target.');
    }
    const ports = githubPorts(execution);
    const result = await enrollGitHubCredential({
      executionInput: execution, operation, plan: enrollment, client: clientFor(execution),
      channel: input.channel ?? ports.protectedCredentialChannel ??
        (execution.credentialEnrollment?.protectedStdin ? protectedStdinCredentialChannel(true) : privateTtyCredentialChannel()),
      secretWriter: input.secretWriter ?? ports.secretWriter ?? githubCliSecretWriter(execution.runner, execution.inspection.projectRoot),
      credentialTransport: ports.credentialTransport, storage
    });
    return credentialEnrollmentStageReviewOutcome(execution.plan.planDigest, operation, result, execution.clock?.() ?? execution.now);
  } catch (error) {
    return { status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: [],
      cleanupWarnings: ['Existing secret and policy are not rolled back or replaced. Any durable pre-effect record remains authoritative; uncertain enrollment must not be retried.'] };
  }
}

export async function verifyProductionCredentialReadiness(
  input: PhaseAdapterExecutionInput, options: CredentialProductionOptions = {}
): Promise<PhaseAdapterOutcome> {
  const storage = options.storage ?? githubPorts(input).storage;
  input = withCredentialStorage(input, storage);
  try {
    await assertLegacyCredentialEffectAdmission(input);
    const operation = exactOperation(input, 'github.credential.verify-policy');
    await assertCredentialAuthority(input, operation, storage);
    const config = configuration(input);
    if (config.mode !== 'verify') throw new GitHubActivationError('credential-mode', 'Use the separately reviewed readiness plan after credential challenge execution.');
    if (Object.hasOwn(operation.inputs, 'permissionReview')) {
      const target = await inspectTarget(input, config);
      const permissionReview: CredentialPermissionReviewPlan = {
        kind: 'github-credential-permission-review.v1', target,
        permissionBoundary: credentialPermissionBoundary(target.metadata.observedPermissions)
      };
      if (Object.keys(operation.inputs).join(',') !== 'permissionReview' ||
        canonicalSha256(operation.inputs.permissionReview) !== canonicalSha256(permissionReview)) {
        throw new GitHubActivationError('credential-permission-drift', 'Actual raw provider grants or their declared read reach changed after review.');
      }
      assertCredentialProviderPolicyPermitted(target.metadata.observedPermissions);
    }
    const readiness = object(operation.inputs.readiness) as unknown as CredentialReadinessPlan;
    if (readiness.kind !== 'github-credential-readiness.v1' ||
      Object.keys(readiness).sort().join(',') !== ['kind', 'target', 'expectedSecret', 'challenge', 'artifact', 'policy', 'policyObservation', 'policyTransaction'].sort().join(',') ||
      canonicalSha256(await inspectTarget(input, config)) !== canonicalSha256(readiness.target) ||
      canonicalSha256(readiness.challenge) !== canonicalSha256(config.challenge)) {
      throw new GitHubActivationError('credential-readiness-plan', 'Credential readiness inputs differ from the exact reviewed target, actor or run.');
    }
    const now = input.clock?.() ?? input.now;
    assertPolicyTarget(readiness.policy, readiness.target, now);
    const client = clientFor(input);
    const before = await readGitHubSecretMetadata(client, readiness.target.repository);
    if (!before || canonicalSha256(before) !== canonicalSha256(readiness.expectedSecret)) {
      throw new GitHubActivationError('credential-secret-drift', 'Secret metadata changed since review; no current stored-secret proof can be admitted.');
    }
    await assertReadinessPolicySnapshot(input, readiness);
    const issuance = await assertCredentialUsageIssued(input, readiness.target, readiness.challenge, storage);
    if (canonicalSha256(issuance.expectedSecret) !== canonicalSha256(before)) {
      throw new GitHubActivationError('credential-secret-drift', 'The stored secret changed after challenge approval; old artifact proof cannot authorize policy completion.');
    }
    if (canonicalSha256(await readCredentialArtifactReference(input, readiness.target, readiness.challenge, storage)) !== canonicalSha256(readiness.artifact)) {
      throw new GitHubActivationError('credential-artifact-changed', 'The reviewed credential artifact binding changed.');
    }
    const usage = await verifyCredentialUsageChallenge({
      client, target: readiness.target, challenge: readiness.challenge, dispatchCorrelationId: issuance.correlationId,
      operation: issuance.operation, expectedArtifact: readiness.artifact, now
    });
    await assertCredentialAuthority(input, operation, storage);
    if (canonicalSha256(await readGitHubSecretMetadata(client, readiness.target.repository)) !== canonicalSha256(before)) {
      throw new GitHubActivationError('credential-secret-drift', 'The secret changed during independent usage readback.');
    }
    await assertReadinessPolicySnapshot(input, readiness);
    const staged = readiness.policyTransaction ? await stageCredentialPolicyTransaction(
      input, exactOperation(input, 'local.credential-policy.write'), readiness.policyTransaction, storage
    ) : {};
    return {
      status: 'completed', resultState: 'verified', ...staged,
      evidencePayload: { kind: 'credential-ready.v1', policyDigest: canonicalSha256(readiness.policy),
        secretName: runnerPreflightSecretName, usage },
      liveReadback: [readbackProof(input, 'github', 'workflow-run',
        `/repos/${usage.repository}/actions/runs/${usage.runId}/attempts/${usage.runAttempt}`, usage)],
      ...(now.getTime() >= Date.parse(readiness.policy.rotationDueAt) ? {
        cleanupWarnings: ['Credential policy review or rotation is due. Existing values remain untouched; rotation requires a separately supported exact custody transition.']
      } : {}),
      completedOperations: [operation, ...(readiness.policyTransaction ? [exactOperation(input, 'local.credential-policy.write')] : [])]
    };
  } catch (error) {
    return { status: 'blocked', blocker: safeGitHubFailure(error), completedOperations: [] };
  }
}
