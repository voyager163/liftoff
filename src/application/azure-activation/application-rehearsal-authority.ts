import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { canonicalApprovalEnvelopeHash } from '../../domain/governance/activation/approvals.js';
import type { TransitionOperation } from '../../domain/governance/activation/types.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from '../../governance-activation/transition-ports.js';
import { currentProjectMutationLease } from '../../adapters/filesystem/project-lock.js';
import { assertGitHubPhaseAuthority } from '../repository-governance/workflow-authority.js';
import { assertAzurePhaseAuthority } from './authority.js';
import { applicationPrivateAssert as must, type ApplicationPrivateAuthority } from './application-private-contracts.js';
import { applicationPrivateInputs, applicationPrivateReadResourceIds } from './application-private-inputs.js';
import { planApplicationPrivateResources } from './application-private-planning.js';
import { inspectApplicationPrivateSource, verifyApplicationPrivateSource } from './application-private-source.js';
import { qualificationExecutionWindow, type DisposableQualificationAuthority } from './qualification-authority.js';
import {
  applicationRehearsalBuildContext, applicationRehearsalCompanionOperations, applicationRehearsalInputs,
  applicationRehearsalProtocol, applicationRehearsalResourceActions, requireApplicationRehearsalStaging
} from './application-rehearsal-inputs.js';

export interface ApplicationRehearsalPrivateAuthority extends ApplicationPrivateAuthority {
  readonly protocol: typeof applicationRehearsalProtocol;
  readonly disposable: DisposableQualificationAuthority;
  readonly additionalOperations: readonly [TransitionOperation, TransitionOperation];
}

const issuedAuthorities = new WeakMap<ApplicationRehearsalPrivateAuthority, string>();

/** The core owner must call this at admission and from EVERY native/backend pre-effect authority check. */
export async function assertIssuedApplicationRehearsalAuthority(authority: ApplicationRehearsalPrivateAuthority): Promise<void> {
  must(issuedAuthorities.get(authority) === canonicalSha256({
    disposable: authority.disposable, additionalOperations: authority.additionalOperations
  }), 'rehearsal-authentic-issued-authority-required');
  await authority.assertCurrent();
}

/** Genuine project lock, also required by read-only verification of retained private records. */
export async function assertApplicationRehearsalProjectLease(input: PhaseAdapterExecutionInput): Promise<void> {
  const held = await currentProjectMutationLease(input.inspection.projectRoot);
  must(held && input.lease, 'rehearsal-real-project-lease');
  await held.assertHeld();
  await input.lease.assertHeld();
}

export async function prepareApplicationRehearsalExecution(input: PhasePlanningInput) {
  const config = applicationRehearsalInputs(input);
  requireApplicationRehearsalStaging(input, config);
  applicationRehearsalBuildContext(input, config.rehearsal.candidate, true);
  applicationRehearsalBuildContext(input, config.rehearsal.baseline.artifact, false);
  const native = applicationPrivateInputs(input);
  const source = await inspectApplicationPrivateSource(input.inspection.projectRoot, input.inspection.manifest, native);
  const build = config.rehearsal.stage === 'verify' ? { operations: [] } : await planApplicationPrivateResources(input);
  must(!build.blockers?.length && (config.rehearsal.stage === 'verify' || build.operations.length > 0), 'rehearsal-core-plan-unavailable');
  if (config.rehearsal.stage !== 'verify') {
    const control = build.operations[0], apply = config.privateExecution.mode === 'apply';
    must(control && build.operations.length === (apply ? 2 : 1) &&
      control.actionId === (config.privateExecution.mode === 'prepare' ? 'azure.application-private.prepare' :
        apply ? 'azure.application-private.state' : 'azure.application-private.recover') &&
      canonicalSha256(control.inputs.applicationPrivate) === canonicalSha256(config.privateExecution) &&
      (!apply || build.operations[1]!.actionId === applicationRehearsalResourceActions[config.rehearsal.stage] &&
        build.operations[1]!.destination.identity === config.disposableTarget.target.resourceId &&
        build.operations[1]!.mutationClass === 'azure-resource-provision'), 'rehearsal-distinct-core-operation');
  }
  const companions = applicationRehearsalCompanionOperations(input, config, source.digest, applicationPrivateReadResourceIds(native));
  return { config, source, companions, operations: [...build.operations, ...companions] };
}

/** Admission derives its own source and operations; caller-authored preparation cannot mint authority. */
export async function createApplicationRehearsalAuthority(input: PhaseAdapterExecutionInput) {
  const prepared = await prepareApplicationRehearsalExecution({ ...input, now: input.clock?.() ?? input.now });
  const { config, operations, companions, source } = prepared;
  const configurationDigest = canonicalSha256(config), planDigest = canonicalSha256(input.plan);
  const check = async () => {
    await assertApplicationRehearsalProjectLease(input);
    must(canonicalSha256(input.plan) === planDigest && canonicalSha256(applicationRehearsalInputs(input)) === configurationDigest &&
      canonicalSha256(input.plan.operations.filter((entry) => entry.remote)) === canonicalSha256(operations) &&
      Boolean(input.recovery) === (config.privateExecution.mode === 'recover') &&
      Boolean(input.plan.recovery) === (config.privateExecution.mode === 'recover'), 'rehearsal-exact-operation-authority');
    for (const operation of operations) {
      if (operation.adapter === 'github') await assertGitHubPhaseAuthority(input, operation);
      else await assertAzurePhaseAuthority(input, operation);
    }
    const envelopes = input.inspection.approvals.filter((entry) => entry.id === input.plan.approval.envelopeId);
    const envelope = envelopes[0];
    must(envelopes.length === 1 && envelope && canonicalApprovalEnvelopeHash(envelope) === input.plan.approval.envelopeHash,
      'rehearsal-issued-disposable-approval');
    const effects = operations.flatMap((entry) => [entry, ...entry.effects ?? []]).filter((entry) => entry.remote);
    const mutations = [...new Set(effects.map((effect) => effect.mutationClass))].sort();
    const target = config.disposableTarget, window = qualificationExecutionWindow(target, input.plan, envelope);
    const now = (input.clock?.() ?? input.now).getTime();
    must(target.actor.operator === envelope.approver &&
      canonicalSha256(mutations) === canonicalSha256([...target.permittedEffects].sort()) &&
      mutations.every((mutation) => envelope.permissions.includes(mutation)) &&
      envelope.resources.some((resource) => resource.identity === target.target.resourceId) &&
      effects.some((effect) => effect.destination.identity === target.target.resourceId &&
        effect.destination.subscriptionId === target.target.subscriptionId) &&
      Number.isFinite(now) && now >= Date.parse(window.notBefore) && now < Date.parse(window.expiresAt),
    'rehearsal-exact-disposable-actors-effects-spend-time');
    requireApplicationRehearsalStaging({ ...input, now: new Date(now) }, config);
    applicationRehearsalBuildContext({ ...input, now: new Date(now) }, config.rehearsal.candidate, true);
    applicationRehearsalBuildContext({ ...input, now: new Date(now) }, config.rehearsal.baseline.artifact, false);
    await verifyApplicationPrivateSource(input.inspection.projectRoot, source);
  };
  await check();
  const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId)!;
  const disposable: DisposableQualificationAuthority = {
    ...structuredClone(config.disposableTarget), executionWindow: qualificationExecutionWindow(config.disposableTarget, input.plan, envelope),
    approval: {
      envelopeId: envelope.id, envelopeHash: canonicalApprovalEnvelopeHash(envelope), approvedAt: envelope.approvedAt,
      planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan)
    }
  };
  const authority: ApplicationRehearsalPrivateAuthority = Object.freeze({
    protocol: applicationRehearsalProtocol, input, operation: operations[0]!, operations,
    additionalOperations: companions, disposable, assertCurrent: check, assertRelease: check
  });
  issuedAuthorities.set(authority, canonicalSha256({ disposable, additionalOperations: companions }));
  return { prepared: structuredClone(prepared), authority };
}
