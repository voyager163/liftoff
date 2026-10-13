import {
  canonicalSha256, isRecord
} from '../domain/governance/activation/canonical-json.js';
import {
  approvalRequestForSavedPlan, authorityOperations, evaluateApprovalForTransitionPlan
} from '../domain/governance/activation/approvals.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from './transition-ports.js';
import { assertGovernanceApprovalIssued } from './authority-records.js';
import { AzureDiscoveryError, expectedAzureEnvironmentBindings } from './azure-discovery.js';
import { azureBackendConfiguration, observeBackendIdentity } from './azure-backend-readiness.js';
import { protectedStateCustodyRequest } from './protected-state-handover.js';
import {
  assertProtectedStateCustodyProof, protectedStateCustodyIdentityDigest
} from './protected-state-custody.js';
import {
  evidenceHeaderDigest, latestRecordWithPayload
} from '../domain/governance/activation/evidence.js';
import { GitHubActivationError } from '../adapters/github/activation-rest.js';
import { readbackProof } from './transition-records.js';

export function applicationError(code: string, message: string): never {
  throw new AzureDiscoveryError(code, message);
}

export function applicationConfiguration(
  input: PhasePlanningInput | PhaseAdapterExecutionInput,
  phase: 'application-prerequisites-ready' | 'application-artifact-ready',
  fields: readonly string[]
): Record<string, unknown> {
  const value = (input.inspection.activationInputs ?? input.inspection.state.activationInputs)?.phases[phase];
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    return applicationError('application-configuration', `${phase} requires exact declarative inputs; unknown fields and commands are prohibited.`);
  }
  return value;
}

export function applicationText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || value.length > 512 || !pattern.test(value)) {
    return applicationError('application-configuration', `${label} is absent or invalid.`);
  }
  return value;
}

export function applicationEnvironment(
  input: PhasePlanningInput | PhaseAdapterExecutionInput, value: unknown
) {
  const environment = expectedAzureEnvironmentBindings(input).find((entry) => entry.environment === value);
  if (!environment) return applicationError('application-environment', 'Application work must select one exact declared environment.');
  return environment;
}

export function applicationBudget(input: PhasePlanningInput | PhaseAdapterExecutionInput) {
  const budget = (input.inspection.activationInputs ?? input.inspection.state.activationInputs)?.budget;
  if (!budget || budget.fixedMonthlyCents <= 0 || budget.usageMonthlyCents <= 0) {
    return applicationError('application-cost', 'Application work requires separately reviewed nonzero fixed and usage monthly ceilings.');
  }
  return budget;
}

export function applicationProtectionBlocker(input: Pick<PhaseAdapterExecutionInput, 'adapters'>): string | null {
  return !input.adapters.protectedStateHandover || !input.adapters.protectedStateCustody
    ? 'Application writes require both production protected handover and custody capabilities; missing storage, non-exporting keys, locking or due-time disposal cannot fall back to project files or an ambient host.'
    : null;
}

export function assertApplicationProgressPorts(input: PhaseAdapterExecutionInput): void {
  if (!input.recordApplicationDispatchIntent || !input.recordApplicationProgress) {
    return applicationError('application-progress-unavailable',
      'Application production dispatch requires engine-owned durable intent and confirmed-provider progress writers; standalone adapters cannot publish without resumable metadata.');
  }
}

export function applicationDispatchPlan(input: Pick<PhaseAdapterExecutionInput, 'inspection' | 'phase' | 'plan'>) {
  const state = input.inspection.state.phases[input.phase.id];
  const previous = state.operation;
  if (!previous) return input.plan;
  const plans = [...input.inspection.contexts[input.phase.id].reviewedPlans ?? [], input.plan];
  const dispatched = plans.find((plan) => plan.planDigest === previous.planDigest);
  const observed = plans.find((plan) => plan.planDigest === state.executionPlanDigest);
  if (!dispatched || !observed || [dispatched, observed].some((plan) =>
    plan.phaseId !== input.phase.id || plan.scope !== input.plan.scope ||
    plan.graphHash !== input.plan.graphHash ||
    canonicalSha256(plan.identity) !== canonicalSha256(input.plan.identity) ||
    canonicalSha256(plan.configuration ?? null) !== canonicalSha256(input.plan.configuration ?? null) ||
    canonicalSha256(authorityOperations(plan.operations)) !== canonicalSha256(authorityOperations(input.plan.operations)))) {
    return applicationError('application-operation', 'Application observation does not match the original reviewed dispatch and exact current source/resource authority; no dispatch or historical handle retagging is permitted.');
  }
  return dispatched;
}

export async function assertApplicationAuthority(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation
): Promise<void> {
  await input.lease?.assertHeld();
  const now = input.clock?.() ?? input.now;
  const configuration = input.inspection.activationInputs ?? input.inspection.state.activationInputs;
  const evaluation = evaluateApprovalForTransitionPlan(
    approvalRequestForSavedPlan(input.plan, input.phase, input.inspection.state),
    input.inspection.approvals, { now }
  );
  if (input.plan.scope !== 'activation' || operation.phaseId !== input.phase.id ||
    input.plan.phaseId !== input.phase.id || Date.parse(input.plan.expiresAt) <= now.getTime() ||
    canonicalSha256(input.plan.configuration ?? null) !== canonicalSha256(configuration ?? null) ||
    !input.plan.operations.some((planned) => canonicalSha256(planned) === canonicalSha256(operation)) ||
    evaluation.approvalRequired || evaluation.envelopeHash !== input.plan.approval.envelopeHash) {
    return applicationError('application-authority', 'Application authority is missing, expired or changed; no new effect is permitted.');
  }
  const envelope = input.inspection.approvals.find((entry) => entry.id === evaluation.envelopeId);
  if (!envelope) return applicationError('application-authority', 'Application work requires its independently issued exact approval.');
  try {
    await assertGovernanceApprovalIssued(input.inspection.projectRoot, envelope);
  } catch {
    return applicationError('application-authority', 'Application approval has no current project-bound external authority; imported receipts are not permission.');
  }
}

export async function observeApplicationProtection(input: PhaseAdapterExecutionInput) {
  input = applicationDeadlineInput(input);
  const blocker = applicationProtectionBlocker(input);
  if (blocker) return applicationError('application-producer-unavailable', blocker);
  if (input.inspection.state.applicability.statePath !== 'bootstrap-local') {
    return applicationError('application-host-unsupported',
      'This source producer requires the qualified same-operation protected bootstrap handover; existing-private application execution has no qualified custody binding yet.');
  }
  const retained = latestRecordWithPayload(input.inspection, 'remote-import-verified');
  if (!retained || retained.header.result !== 'verified' ||
    !isRecord(retained.payload) || retained.payload.kind !== 'remote-import-verified.v1' ||
    !['verified', 'retained'].includes(input.inspection.state.phases['remote-ready'].state) ||
    !input.inspection.state.bootstrapState ||
    input.inspection.state.bootstrapState.remoteImportEvidenceId !== retained.evidenceId ||
    input.inspection.state.bootstrapState.remoteImportEvidenceDigest !== evidenceHeaderDigest(retained.header) ||
    input.inspection.state.bootstrapState.status !== 'retained' ||
    Date.parse(input.inspection.state.bootstrapState.disposeAfter) -
      Date.parse(input.inspection.state.bootstrapState.retainedAt) !== 30 * 86_400_000) {
    return applicationError('application-backend-unready', 'Application effects require actual retained protected handover evidence and its unchanged exact 30-day disposal obligation.');
  }
  const request = protectedStateCustodyRequest(input);
  const qualification = await input.adapters.protectedStateCustody!.qualify(request);
  if (qualification.status === 'blocked') {
    return applicationError('application-host-unready',
      `Protected application execution was refused (${qualification.reason}); no source transmission or resource write was dispatched.`);
  }
  assertProtectedStateCustodyProof(qualification.proof, {
    bindingDigest: request.bindingDigest, runner: request.runner
  }, input.clock?.() ?? input.now);
  if (protectedStateCustodyIdentityDigest(qualification.proof) !==
    input.inspection.state.phaseOutputs?.['remote-import-verified']?.values.custodyIdentityDigest) {
    return applicationError('application-custody-drift', 'Application execution changed the protected host, storage, key, locking or disposal identity established by handover.');
  }
  const backend = azureBackendConfiguration(input, 'bootstrap-local');
  const identity = await observeBackendIdentity(input, backend);
  if (qualification.proof.hostId !== identity.execution.hostId) {
    return applicationError('application-host-unsupported',
      'Application execution is not running on the independently qualified protected host; a remote custody assertion cannot authorize an ambient workstation process.');
  }
  return { request, custody: qualification.proof, backend, identity: identity.identity };
}

export function isApplicationProviderError(error: unknown): error is AzureDiscoveryError | GitHubActivationError {
  return error instanceof AzureDiscoveryError || error instanceof GitHubActivationError;
}

export function applicationDeadlineInput(input: PhaseAdapterExecutionInput): PhaseAdapterExecutionInput {
  if (boundedApplicationRunners.has(input.runner)) return input;
  const deadline = Date.now() + 180_000;
  async function withinDeadline<T>(call: () => Promise<T>): Promise<T> {
    const remaining = Math.min(30_000, deadline - Date.now());
    if (remaining <= 0) return applicationError('application-deadline', 'Application observation reached its three-minute deadline; dispatched work must be observed, never repeated.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([call(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AzureDiscoveryError('application-deadline',
          'Application provider observation exceeded its bounded deadline; acceptance may be uncertain and no repeated effect is permitted.')), remaining);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const bounded: PhaseAdapterExecutionInput = {
    ...input,
    runner: {
      async run(command, options) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return applicationError('application-deadline', 'Application observation reached its three-minute deadline; retain and observe dispatched work rather than repeat it.');
        return input.runner.run(command, {
          ...options, timeoutMs: Math.min(options?.timeoutMs ?? 30_000, 30_000, remaining),
          maxOutputBytes: Math.min(options?.maxOutputBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024),
          stream: false
        });
      }
    }
  };
  const transport = input.adapters.githubActivation?.transport;
  const custody = input.adapters.protectedStateCustody;
  bounded.adapters = {
    ...input.adapters,
    ...(transport ? { githubActivation: { ...input.adapters.githubActivation,
      transport: { request: (request) => withinDeadline(() => transport.request(request)) }
    } } : {}),
    ...(custody ? { protectedStateCustody: {
      qualify: (request) => withinDeadline(() => custody.qualify(request)),
      dispose: (request) => custody.dispose(request)
    } } : {})
  };
  boundedApplicationRunners.add(bounded.runner);
  return bounded;
}

const boundedApplicationRunners = new WeakSet<PhaseAdapterExecutionInput['runner']>();

export function applicationReadbackProof(
  input: PhaseAdapterExecutionInput,
  provider: Parameters<typeof readbackProof>[1],
  resourceType: string,
  resourceId: string,
  observed: unknown
) {
  return readbackProof({ ...input, now: input.clock?.() ?? input.now }, provider, resourceType, resourceId, observed);
}
