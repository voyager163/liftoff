import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { currentActivationIdentity } from './graph.js';
import type {
  ActivationIdentity,
  ApprovalCostCeiling,
  ApprovalDestinationScope,
  ApprovalEnvelope,
  ApprovalEvaluation,
  ApprovalGateKind,
  ApprovalResourceScope,
  EvidenceTransitionIdentity,
  HumanAuthorityQuestionKind,
  PhaseGraphNode,
  PhaseId,
  RequestedTransitionPlan,
  UserActivationState
} from './types.js';

type ApprovalScope = ApprovalEnvelope | RequestedTransitionPlan;

const destinationTypes = new Set<ApprovalDestinationScope['type']>([
  'repository',
  'subscription',
  'environment',
  'tenant',
  'local',
  'external'
]);
const currencyPattern = /^[A-Z]{3}$/u;
const hex64Pattern = /^[a-f0-9]{64}$/u;
const isoLikePattern = /^\d{4}-\d{2}-\d{2}T/u;

const activationIdentityProperties = {
  liftoffVersion: { const: currentActivationIdentity.liftoffVersion },
  manifestArtifactVersion: { const: currentActivationIdentity.manifestArtifactVersion },
  policyVersion: { const: currentActivationIdentity.policyVersion },
  activationContractVersion: { const: currentActivationIdentity.activationContractVersion },
  phaseGraphSchemaVersion: { const: currentActivationIdentity.phaseGraphSchemaVersion },
  phaseGraphHash: { const: currentActivationIdentity.phaseGraphHash },
  activationStateSchemaVersion: { const: currentActivationIdentity.activationStateSchemaVersion },
  evidenceHeaderSchemaVersion: { const: currentActivationIdentity.evidenceHeaderSchemaVersion },
  approvalEnvelopeSchemaVersion: { const: currentActivationIdentity.approvalEnvelopeSchemaVersion },
  supersessionSchemaVersion: { const: currentActivationIdentity.supersessionSchemaVersion },
  credentialPolicySchemaVersion: { const: currentActivationIdentity.credentialPolicySchemaVersion }
} satisfies Record<string, unknown>;

export const approvalEnvelopeV1Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mission-control.local/liftoff/governance/approval-envelope.schema.v1.json',
  title: 'Liftoff governance approval envelope v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'phaseId',
    'gateKind',
    'identity',
    'baselineSha',
    'planDigest',
    'resources',
    'destinations',
    'permissions',
    'costCeiling',
    'policyExceptions',
    'destructiveScope',
    'expiresAt',
    'approvedAt',
    'approver'
  ],
  properties: {
    schemaVersion: { const: currentActivationIdentity.approvalEnvelopeSchemaVersion },
    id: { type: 'string', minLength: 1 },
    phaseId: { type: 'string' },
    gateKind: { type: 'string' },
    identity: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(activationIdentityProperties),
      properties: activationIdentityProperties
    },
    baselineSha: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    planDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'identity'],
        properties: {
          type: { type: 'string', minLength: 1 },
          identity: { type: 'string', minLength: 1 }
        }
      }
    },
    destinations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'identity', 'repository', 'subscriptionId'],
        properties: {
          type: { enum: ['repository', 'subscription', 'environment', 'tenant', 'local', 'external'] },
          identity: { type: 'string', minLength: 1 },
          repository: { type: ['string', 'null'] },
          subscriptionId: { type: ['string', 'null'] }
        }
      }
    },
    permissions: { type: 'array', items: { type: 'string', minLength: 1 } },
    costCeiling: {
      type: 'object',
      additionalProperties: false,
      required: ['currency', 'fixedMonthlyCents', 'usageMonthlyCents'],
      properties: {
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        fixedMonthlyCents: { type: 'integer', minimum: 0 },
        usageMonthlyCents: { type: 'integer', minimum: 0 }
      }
    },
    policyExceptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    destructiveScope: { type: 'array', items: { type: 'string', minLength: 1 } },
    expiresAt: { type: 'string', format: 'date-time' },
    approvedAt: { type: 'string', format: 'date-time' },
    approver: { type: 'string', minLength: 1 }
  }
} as const;

function cleanString(value: string, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  const cleaned = value.trim();
  if (cleaned.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return cleaned;
}

function sortedUnique<T>(
  values: readonly T[],
  path: string,
  normalize: (value: T, index: number) => T,
  keyFor: (value: T) => string
): T[] {
  const normalized = values.map((value, index) => normalize(value, index));
  const seen = new Set<string>();
  for (const value of normalized) {
    const key = keyFor(value);
    if (seen.has(key)) {
      throw new Error(`${path} must not contain duplicate ${key}.`);
    }
    seen.add(key);
  }
  return [...normalized].sort((left, right) => keyFor(left).localeCompare(keyFor(right), 'en'));
}

function normalizeResource(resource: ApprovalResourceScope, index: number): ApprovalResourceScope {
  return {
    type: cleanString(resource.type, `approvalEnvelope.resources[${index}].type`).toLowerCase(),
    identity: cleanString(resource.identity, `approvalEnvelope.resources[${index}].identity`)
  };
}

function resourceKey(resource: ApprovalResourceScope): string {
  return canonicalJson(resource);
}

function normalizeDestination(destination: ApprovalDestinationScope, index: number): ApprovalDestinationScope {
  if (!destinationTypes.has(destination.type)) {
    throw new Error(`approvalEnvelope.destinations[${index}].type contains unsupported value ${JSON.stringify(destination.type)}.`);
  }
  return {
    type: destination.type,
    identity: cleanString(destination.identity, `approvalEnvelope.destinations[${index}].identity`),
    repository: destination.repository === null
      ? null
      : cleanString(destination.repository, `approvalEnvelope.destinations[${index}].repository`),
    subscriptionId: destination.subscriptionId === null
      ? null
      : cleanString(destination.subscriptionId, `approvalEnvelope.destinations[${index}].subscriptionId`)
  };
}

function destinationKey(destination: ApprovalDestinationScope): string {
  return canonicalJson(destination);
}

function normalizePermission(permission: string, index: number): string {
  return cleanString(permission, `approvalEnvelope.permissions[${index}]`).toLowerCase();
}

function normalizePlainScope(scope: string, index: number, field: 'policyExceptions' | 'destructiveScope'): string {
  return cleanString(scope, `approvalEnvelope.${field}[${index}]`);
}

function identityDigest(identity: ActivationIdentity): string {
  return canonicalSha256(identity);
}

function sameIdentity(left: ActivationIdentity, right: ActivationIdentity): boolean {
  return identityDigest(left) === identityDigest(right);
}

function digest(value: string, path: string): string {
  if (!hex64Pattern.test(value)) {
    throw new Error(`${path} must be a SHA-256 hex digest.`);
  }
  return value;
}

function timestamp(value: string, path: string): string {
  if (!isoLikePattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid ISO timestamp.`);
  }
  return value;
}

export function normalizeApprovalCostCeiling(cost: ApprovalCostCeiling): ApprovalCostCeiling {
  const currency = cleanString(cost.currency, 'approvalEnvelope.costCeiling.currency');
  if (!currencyPattern.test(currency)) {
    throw new Error('approvalEnvelope.costCeiling.currency must be a three-letter uppercase ISO currency code.');
  }
  for (const key of ['fixedMonthlyCents', 'usageMonthlyCents'] as const) {
    if (!Number.isSafeInteger(cost[key]) || cost[key] < 0) {
      throw new Error(`approvalEnvelope.costCeiling.${key} must be a non-negative safe integer number of cents.`);
    }
  }
  return {
    currency,
    fixedMonthlyCents: cost.fixedMonthlyCents,
    usageMonthlyCents: cost.usageMonthlyCents
  };
}

export function normalizeApprovalResources(resources: readonly ApprovalResourceScope[]): ApprovalResourceScope[] {
  return sortedUnique(resources, 'approvalEnvelope.resources', normalizeResource, resourceKey);
}

export function normalizeApprovalDestinations(destinations: readonly ApprovalDestinationScope[]): ApprovalDestinationScope[] {
  return sortedUnique(destinations, 'approvalEnvelope.destinations', normalizeDestination, destinationKey);
}

export function normalizeApprovalPermissions(permissions: readonly string[]): string[] {
  return sortedUnique(permissions, 'approvalEnvelope.permissions', normalizePermission, (value) => value);
}

export function normalizeApprovalPolicyExceptions(exceptions: readonly string[]): string[] {
  return sortedUnique(
    exceptions,
    'approvalEnvelope.policyExceptions',
    (value, index) => normalizePlainScope(value, index, 'policyExceptions'),
    (value) => value
  );
}

export function normalizeApprovalDestructiveScope(scope: readonly string[]): string[] {
  return sortedUnique(
    scope,
    'approvalEnvelope.destructiveScope',
    (value, index) => normalizePlainScope(value, index, 'destructiveScope'),
    (value) => value
  );
}

export function normalizeApprovalScope(scope: ApprovalScope): RequestedTransitionPlan {
  return {
    phaseId: scope.phaseId,
    gateKind: scope.gateKind,
    identity: scope.identity,
    baselineSha: digest(scope.baselineSha, 'approvalEnvelope.baselineSha'),
    planDigest: digest(scope.planDigest, 'approvalEnvelope.planDigest'),
    resources: normalizeApprovalResources(scope.resources),
    destinations: normalizeApprovalDestinations(scope.destinations),
    permissions: normalizeApprovalPermissions(scope.permissions),
    costCeiling: normalizeApprovalCostCeiling(scope.costCeiling),
    policyExceptions: normalizeApprovalPolicyExceptions(scope.policyExceptions),
    destructiveScope: normalizeApprovalDestructiveScope(scope.destructiveScope)
  };
}

/**
 * Returns the hashable approval scope. Explicit approver, approval time, and
 * envelope id are audit metadata and are intentionally excluded; changing them
 * cannot force an implementation/API-shape retry to ask again.
 */
export function canonicalApprovalEnvelopeScope(envelope: ApprovalEnvelope): Record<string, unknown> {
  const normalized = normalizeApprovalScope(envelope);
  return {
    schemaVersion: envelope.schemaVersion,
    phaseId: normalized.phaseId,
    gateKind: normalized.gateKind,
    identity: normalized.identity,
    baselineSha: normalized.baselineSha,
    planDigest: normalized.planDigest,
    resources: normalized.resources,
    destinations: normalized.destinations,
    permissions: normalized.permissions,
    costCeiling: normalized.costCeiling,
    policyExceptions: normalized.policyExceptions,
    destructiveScope: normalized.destructiveScope,
    expiresAt: timestamp(envelope.expiresAt, 'approvalEnvelope.expiresAt')
  };
}

export function canonicalApprovalEnvelopeHash(envelope: ApprovalEnvelope): string {
  return canonicalSha256(canonicalApprovalEnvelopeScope(envelope));
}

export const approvalEnvelopeHash = canonicalApprovalEnvelopeHash;

export function questionKindForApprovalGate(gateKind: ApprovalGateKind): HumanAuthorityQuestionKind | null {
  switch (gateKind) {
    case 'none':
      return null;
    case 'repository-publish':
      return 'repository-creation-initial-commit-push';
    case 'activation-plan':
    case 'infrastructure-cost':
      return 'billed-infrastructure-policy-exception-cost-ceiling';
    case 'credential-enrollment':
      return 'credential-enrollment';
    case 'enforcement':
      return 'final-enforcement';
    case 'destructive-disposal':
      return 'destructive-operation';
    case 'external-blocker':
      return 'external-blocker';
  }
}

export function determineHumanAuthorityQuestion(plan: RequestedTransitionPlan): HumanAuthorityQuestionKind | null {
  const normalized = normalizeApprovalScope(plan);
  const questionKind = questionKindForApprovalGate(normalized.gateKind);
  if (normalized.gateKind === 'none') {
    const authorityReasons = [
      ...(normalized.costCeiling.fixedMonthlyCents > 0 ? ['fixed monthly cost'] : []),
      ...(normalized.costCeiling.usageMonthlyCents > 0 ? ['usage monthly cost'] : []),
      ...(normalized.policyExceptions.length > 0 ? ['policy exception'] : []),
      ...(normalized.destructiveScope.length > 0 ? ['destructive scope'] : [])
    ];
    if (authorityReasons.length > 0) {
      throw new Error(`Approval gate none cannot request ${authorityReasons.join(', ')} authority.`);
    }
  }
  if (normalized.destructiveScope.length > 0 && normalized.gateKind !== 'destructive-disposal') {
    throw new Error('Destructive scope requires the destructive-disposal approval gate.');
  }
  if (
    (normalized.costCeiling.fixedMonthlyCents > 0 ||
      normalized.costCeiling.usageMonthlyCents > 0 ||
      normalized.policyExceptions.length > 0) &&
    normalized.gateKind !== 'activation-plan' &&
    normalized.gateKind !== 'infrastructure-cost'
  ) {
    throw new Error('Cost ceilings and policy exceptions require an activation-plan or infrastructure-cost approval gate.');
  }
  return questionKind;
}

function containsAll<T>(approved: readonly T[], requested: readonly T[], keyFor: (value: T) => string): string[] {
  const approvedKeys = new Set(approved.map((value) => keyFor(value)));
  return requested.map((value) => keyFor(value)).filter((key) => !approvedKeys.has(key));
}

function expansionReasons(approved: RequestedTransitionPlan, requested: RequestedTransitionPlan): string[] {
  const reasons: string[] = [];
  const resourceMisses = containsAll(approved.resources, requested.resources, resourceKey);
  reasons.push(...resourceMisses.map((key) => `resource scope expanded: ${key.trim()}`));
  const destinationMisses = containsAll(approved.destinations, requested.destinations, destinationKey);
  reasons.push(...destinationMisses.map((key) => `destination scope expanded: ${key.trim()}`));
  const permissionMisses = containsAll(approved.permissions, requested.permissions, (value) => value);
  reasons.push(...permissionMisses.map((permission) => `permission scope expanded: ${permission}`));
  if (approved.costCeiling.currency !== requested.costCeiling.currency) {
    reasons.push(`cost currency changed from ${approved.costCeiling.currency} to ${requested.costCeiling.currency}`);
  } else {
    if (requested.costCeiling.fixedMonthlyCents > approved.costCeiling.fixedMonthlyCents) {
      reasons.push(`fixed monthly cost ceiling increased from ${approved.costCeiling.fixedMonthlyCents} to ${requested.costCeiling.fixedMonthlyCents} ${approved.costCeiling.currency} cents`);
    }
    if (requested.costCeiling.usageMonthlyCents > approved.costCeiling.usageMonthlyCents) {
      reasons.push(`usage monthly cost ceiling increased from ${approved.costCeiling.usageMonthlyCents} to ${requested.costCeiling.usageMonthlyCents} ${approved.costCeiling.currency} cents`);
    }
  }
  const exceptionMisses = containsAll(approved.policyExceptions, requested.policyExceptions, (value) => value);
  reasons.push(...exceptionMisses.map((exception) => `policy exception added: ${exception}`));
  const destructiveMisses = containsAll(approved.destructiveScope, requested.destructiveScope, (value) => value);
  reasons.push(...destructiveMisses.map((scope) => `destructive scope expanded: ${scope}`));
  return reasons;
}

function invalidationReasons(approved: RequestedTransitionPlan, requested: RequestedTransitionPlan): string[] {
  const reasons: string[] = [];
  if (!sameIdentity(approved.identity, requested.identity)) {
    reasons.push('activation identity changed');
  }
  if (approved.phaseId !== requested.phaseId) {
    reasons.push(`phase changed from ${approved.phaseId} to ${requested.phaseId}`);
  }
  if (approved.gateKind !== requested.gateKind) {
    reasons.push(`approval gate changed from ${approved.gateKind} to ${requested.gateKind}`);
  }
  if (approved.baselineSha !== requested.baselineSha) {
    reasons.push('baseline SHA changed');
  }
  if (approved.planDigest !== requested.planDigest) {
    reasons.push('plan authority digest changed');
  }
  return reasons;
}

function noApprovalRequired(plan: RequestedTransitionPlan): ApprovalEvaluation {
  return {
    phaseId: plan.phaseId,
    gateKind: plan.gateKind,
    questionKind: null,
    approvalRequired: false,
    status: 'not-required',
    envelopeId: null,
    envelopeHash: null,
    reasons: ['approval gate is none'],
    expansionReasons: []
  };
}

export function evaluateApprovalForTransitionPlan(
  plan: RequestedTransitionPlan,
  envelopes: readonly ApprovalEnvelope[],
  options: { now?: Date } = {}
): ApprovalEvaluation {
  const requested = normalizeApprovalScope(plan);
  const questionKind = determineHumanAuthorityQuestion(requested);
  if (questionKind === null) {
    return noApprovalRequired(requested);
  }
  const now = options.now ?? new Date();
  const candidates = envelopes.filter((envelope) =>
    envelope.phaseId === requested.phaseId || envelope.gateKind === requested.gateKind
  );
  if (candidates.length === 0) {
    return {
      phaseId: requested.phaseId,
      gateKind: requested.gateKind,
      questionKind,
      approvalRequired: true,
      status: 'approval-required',
      envelopeId: null,
      envelopeHash: null,
      reasons: [`no approval envelope exists for ${requested.phaseId} (${requested.gateKind})`],
      expansionReasons: []
    };
  }

  let best: ApprovalEvaluation | null = null;
  for (const envelope of candidates) {
    const approved = normalizeApprovalScope(envelope);
    const hash = canonicalApprovalEnvelopeHash(envelope);
    const reasons = invalidationReasons(approved, requested);
    const expansions = expansionReasons(approved, requested);
    if (Date.parse(envelope.expiresAt) <= now.getTime()) {
      const expired: ApprovalEvaluation = {
        phaseId: requested.phaseId,
        gateKind: requested.gateKind,
        questionKind,
        approvalRequired: true,
        status: 'expired',
        envelopeId: envelope.id,
        envelopeHash: hash,
        reasons: [`approval envelope ${envelope.id} expired at ${envelope.expiresAt}`],
        expansionReasons: []
      };
      best ??= expired;
      continue;
    }
    if (reasons.length === 0 && expansions.length === 0) {
      return {
        phaseId: requested.phaseId,
        gateKind: requested.gateKind,
        questionKind,
        approvalRequired: false,
        status: 'reused',
        envelopeId: envelope.id,
        envelopeHash: hash,
        reasons: [`approval envelope ${envelope.id} covers the requested transition scope`],
        expansionReasons: []
      };
    }
    const invalidated: ApprovalEvaluation = {
      phaseId: requested.phaseId,
      gateKind: requested.gateKind,
      questionKind,
      approvalRequired: true,
      status: expansions.length > 0 ? 'approval-required' : 'invalidated',
      envelopeId: envelope.id,
      envelopeHash: hash,
      reasons: [...reasons, ...expansions],
      expansionReasons: expansions
    };
    if (
      best === null ||
      (best.status === 'expired' && invalidated.status !== 'expired') ||
      invalidated.reasons.length < best.reasons.length
    ) {
      best = invalidated;
    }
  }
  return best ?? {
    phaseId: requested.phaseId,
    gateKind: requested.gateKind,
    questionKind,
    approvalRequired: true,
    status: 'approval-required',
    envelopeId: null,
    envelopeHash: null,
    reasons: ['approval is required'],
    expansionReasons: []
  };
}

function destinationsForPhase(
  phase: PhaseGraphNode,
  state: UserActivationState
): ApprovalDestinationScope[] {
  const destinations = new Map<string, ApprovalDestinationScope>();
  for (const mutation of [...phase.allowedMutations.local, ...phase.allowedMutations.remote]) {
    if (mutation === 'none' || mutation === 'read-worktree') {
      continue;
    }
    if (mutation.startsWith('git-') || mutation.startsWith('github-')) {
      destinations.set('repository', {
        type: 'repository',
        identity: state.repository.name,
        repository: state.repository.name,
        subscriptionId: null
      });
    } else if (mutation.startsWith('azure-')) {
      destinations.set('subscription', {
        type: 'subscription',
        identity: 'phase-0-discovered-subscription',
        repository: null,
        subscriptionId: 'phase-0-discovered-subscription'
      });
    } else {
      destinations.set('local', {
        type: 'local',
        identity: state.repository.id,
        repository: null,
        subscriptionId: null
      });
    }
  }
  return [...destinations.values()];
}

export function transitionPlanForPhase(
  phase: PhaseGraphNode,
  state: UserActivationState,
  transition: EvidenceTransitionIdentity,
  _projectRoot?: string
): RequestedTransitionPlan {
  const mutations = [...phase.allowedMutations.local, ...phase.allowedMutations.remote]
    .filter((mutation) => mutation !== 'none');
  return normalizeApprovalScope({
    phaseId: phase.id,
    gateKind: phase.approvalGate.kind,
    identity: state.identity,
    baselineSha: transition.baselineSha,
    planDigest: canonicalSha256({
      phaseId: phase.id,
      gateKind: phase.approvalGate.kind,
      transitionDigest: transition.transitionDigest,
      allowedMutations: phase.allowedMutations
    }),
    resources: mutations.map((mutation) => ({
      type: mutation,
      identity: `${phase.id}:${mutation}`
    })),
    destinations: destinationsForPhase(phase, state),
    permissions: mutations,
    costCeiling: {
      currency: 'USD',
      fixedMonthlyCents: 0,
      usageMonthlyCents: 0
    },
    policyExceptions: [],
    destructiveScope: phase.approvalGate.kind === 'destructive-disposal'
      ? [`${phase.id}:declared-disposal-scope`]
      : []
  });
}
