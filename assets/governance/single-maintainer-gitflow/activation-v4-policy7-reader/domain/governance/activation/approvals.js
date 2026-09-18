import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from './graph.js';
import { githubRepositoryFromPushUrl, remoteRepository } from './inputs.js';
             
                          
                                 
                  
                     
                      
                           
                   
                     
                   
                        
                             
                             
                 
          
                          
                      
                    
                      
                     
                    
import { phaseIds, phaseScope } from './types.js';

                                                                

const destinationTypes = new Set                                  ([
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
}                                  ;

export const approvalEnvelopeV4Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mission-control.local/liftoff/governance/approval-envelope.schema.v4.json',
  title: 'Liftoff governance approval envelope v4',
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
    scope: { enum: ['local', 'repository', 'activation', 'lifecycle'] },
    coveredPhases: { type: 'array', uniqueItems: true, items: { enum: phaseIds } },
    operationDigests: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
    phasePlanDigests: { type: 'object', additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
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
}         ;

/** @deprecated Naming facade only; current execution uses approvalEnvelopeV4Schema. */
export const approvalEnvelopeV3Schema = approvalEnvelopeV4Schema;
export const approvalEnvelopeV2Schema = approvalEnvelopeV4Schema;
/** @deprecated Use the immutable historical contracts to read v1 artifacts. */
export const approvalEnvelopeV1Schema = approvalEnvelopeV4Schema;

function cleanString(value        , path        )         {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  const cleaned = value.trim();
  if (cleaned.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return cleaned;
}

function sortedUnique   (
  values              ,
  path        ,
  normalize                                ,
  keyFor                      
)      {
  const normalized = values.map((value, index) => normalize(value, index));
  const seen = new Set        ();
  for (const value of normalized) {
    const key = keyFor(value);
    if (seen.has(key)) {
      throw new Error(`${path} must not contain duplicate ${key}.`);
    }
    seen.add(key);
  }
  return [...normalized].sort((left, right) => keyFor(left).localeCompare(keyFor(right), 'en'));
}

function normalizeResource(resource                       , index        )                        {
  return {
    type: cleanString(resource.type, `approvalEnvelope.resources[${index}].type`).toLowerCase(),
    identity: cleanString(resource.identity, `approvalEnvelope.resources[${index}].identity`)
  };
}

function resourceKey(resource                       )         {
  return canonicalJson(resource);
}

function normalizeDestination(destination                          , index        )                           {
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

function destinationKey(destination                          )         {
  return canonicalJson(destination);
}

function normalizePermission(permission        , index        )         {
  return cleanString(permission, `approvalEnvelope.permissions[${index}]`).toLowerCase();
}

function normalizePlainScope(scope        , index        , field                                         )         {
  return cleanString(scope, `approvalEnvelope.${field}[${index}]`);
}

function identityDigest(identity                    )         {
  return canonicalSha256(identity);
}

function sameIdentity(left                    , right                    )          {
  return identityDigest(left) === identityDigest(right);
}

function digest(value        , path        )         {
  if (!hex64Pattern.test(value)) {
    throw new Error(`${path} must be a SHA-256 hex digest.`);
  }
  return value;
}

function timestamp(value        , path        )         {
  if (!isoLikePattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid ISO timestamp.`);
  }
  return value;
}

export function normalizeApprovalCostCeiling(cost                     )                      {
  const currency = cleanString(cost.currency, 'approvalEnvelope.costCeiling.currency');
  if (!currencyPattern.test(currency)) {
    throw new Error('approvalEnvelope.costCeiling.currency must be a three-letter uppercase ISO currency code.');
  }
  for (const key of ['fixedMonthlyCents', 'usageMonthlyCents']         ) {
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

export function normalizeApprovalResources(resources                                  )                          {
  return sortedUnique(resources, 'approvalEnvelope.resources', normalizeResource, resourceKey);
}

export function normalizeApprovalDestinations(destinations                                     )                             {
  return sortedUnique(destinations, 'approvalEnvelope.destinations', normalizeDestination, destinationKey);
}

export function normalizeApprovalPermissions(permissions                   )           {
  return sortedUnique(permissions, 'approvalEnvelope.permissions', normalizePermission, (value) => value);
}

export function normalizeApprovalPolicyExceptions(exceptions                   )           {
  return sortedUnique(
    exceptions,
    'approvalEnvelope.policyExceptions',
    (value, index) => normalizePlainScope(value, index, 'policyExceptions'),
    (value) => value
  );
}

export function normalizeApprovalDestructiveScope(scope                   )           {
  return sortedUnique(
    scope,
    'approvalEnvelope.destructiveScope',
    (value, index) => normalizePlainScope(value, index, 'destructiveScope'),
    (value) => value
  );
}

export function normalizeApprovalScope(scope               )                          {
  const coveredPhases = scope.coveredPhases === undefined ? undefined : sortedUnique(
    scope.coveredPhases, 'approvalEnvelope.coveredPhases', (value) => {
      if (!phaseIds.includes(value)) throw new Error(`Unsupported covered phase ${value}.`);
      return value;
    }, (value) => value
  );
  const operationDigests = scope.operationDigests === undefined ? undefined : sortedUnique(
    scope.operationDigests, 'approvalEnvelope.operationDigests',
    (value) => digest(value, 'approvalEnvelope.operationDigests'), (value) => value
  );
  const phasePlanDigests                                   = {};
  if (scope.phasePlanDigests) {
    for (const id of Object.keys(scope.phasePlanDigests)) {
      if (!(phaseIds                     ).includes(id)) throw new Error('An approval bundle contains an unknown phase.');
      phasePlanDigests[id           ] = digest(scope.phasePlanDigests[id           ] , `approvalEnvelope.phasePlanDigests.${id}`);
    }
  }
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
    destructiveScope: normalizeApprovalDestructiveScope(scope.destructiveScope),
    ...(scope.scope === undefined ? {} : { scope: scope.scope }),
    ...(coveredPhases ? { coveredPhases } : {}),
    ...(operationDigests ? { operationDigests } : {}),
    ...(scope.phasePlanDigests ? { phasePlanDigests } : {})
  };
}

/**
 * Authorization references also bind the authorization interval and approver.
 */
export function canonicalApprovalEnvelopeScope(envelope                  )                          {
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
    ...(normalized.scope === undefined ? {} : { scope: normalized.scope }),
    ...(normalized.coveredPhases === undefined ? {} : { coveredPhases: normalized.coveredPhases }),
    ...(normalized.operationDigests === undefined ? {} : { operationDigests: normalized.operationDigests }),
    ...(normalized.phasePlanDigests === undefined ? {} : { phasePlanDigests: normalized.phasePlanDigests }),
    expiresAt: timestamp(envelope.expiresAt, 'approvalEnvelope.expiresAt'),
    approvedAt: timestamp(envelope.approvedAt, 'approvalEnvelope.approvedAt'),
    approver: cleanString(envelope.approver, 'approvalEnvelope.approver')
  };
}

export function canonicalApprovalEnvelopeHash(envelope                  )         {
  return canonicalSha256(canonicalApprovalEnvelopeScope(envelope));
}

export const approvalEnvelopeHash = canonicalApprovalEnvelopeHash;

export function questionKindForApprovalGate(gateKind                  )                                    {
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

export function determineHumanAuthorityQuestion(plan                         )                                    {
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

function containsAll   (approved              , requested              , keyFor                      )           {
  const approvedKeys = new Set(approved.map((value) => keyFor(value)));
  return requested.map((value) => keyFor(value)).filter((key) => !approvedKeys.has(key));
}

function expansionReasons(approved                         , requested                         )           {
  const reasons           = [];
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
  const phaseMisses = containsAll(approved.coveredPhases ?? [approved.phaseId], requested.coveredPhases ?? [requested.phaseId], (value) => value);
  reasons.push(...phaseMisses.map((phase) => `phase scope expanded: ${phase}`));
  const operationMisses = containsAll(approved.operationDigests ?? [], requested.operationDigests ?? [], (value) => value);
  reasons.push(...operationMisses.map((operation) => `operation scope expanded: ${operation}`));
  return reasons;
}

function invalidationReasons(approved                         , requested                         )           {
  const reasons           = [];
  if (!sameIdentity(approved.identity, requested.identity)) {
    reasons.push('activation identity changed');
  }
  if (approved.phaseId !== requested.phaseId && !approved.coveredPhases?.includes(requested.phaseId)) {
    reasons.push(`phase changed from ${approved.phaseId} to ${requested.phaseId}`);
  }
  if ((approved.scope ?? phaseScope(approved.phaseId)) !== (requested.scope ?? phaseScope(requested.phaseId))) {
    reasons.push('governance execution scope changed');
  }
  if (approved.gateKind !== requested.gateKind) {
    reasons.push(`approval gate changed from ${approved.gateKind} to ${requested.gateKind}`);
  }
  if (approved.baselineSha !== requested.baselineSha) {
    reasons.push('baseline SHA changed');
  }
  if (approved.planDigest !== requested.planDigest &&
    (requested.phasePlanDigests !== undefined || approved.phasePlanDigests?.[requested.phaseId] !== requested.planDigest)) {
    reasons.push('plan authority digest changed');
  }
  return reasons;
}

function noApprovalRequired(plan                         )                     {
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
  plan                         ,
  envelopes                             ,
  options                 = {}
)                     {
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

  let best                            = null;
  for (const envelope of candidates) {
    const approvedAt = Date.parse(envelope.approvedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) ||
      approvedAt >= expiresAt || approvedAt > now.getTime() || expiresAt <= now.getTime()) {
      best ??= {
        phaseId: requested.phaseId, gateKind: requested.gateKind, questionKind,
        approvalRequired: true, status: 'expired', envelopeId: envelope.id, envelopeHash: null,
        reasons: [`Approval ${envelope.id} requires a valid approvedAt <= now < expiresAt interval.`],
        expansionReasons: []
      };
      continue;
    }
    const approved = normalizeApprovalScope(envelope);
    const hash = canonicalApprovalEnvelopeHash(envelope);
    const reasons = invalidationReasons(approved, requested);
    const expansions = expansionReasons(approved, requested);
    if (Date.parse(envelope.expiresAt) <= now.getTime()) {
      const expired                     = {
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
    const invalidated                     = {
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
  phase                ,
  state                     ,
  publicationDestination         
)                             {
  const destinations = new Map                                  ();
  for (const mutation of [...phase.allowedMutations.local, ...phase.allowedMutations.remote]) {
    if (mutation === 'none' || mutation === 'read-worktree') {
      continue;
    }
    if (mutation.startsWith('git-') || mutation.startsWith('github-')) {
      if (phase.id === 'committed') {
        destinations.set('local', { type: 'local', identity: state.repository.id, repository: null, subscriptionId: null });
        continue;
      }
      destinations.set('repository', {
        type: 'repository',
        identity: phase.id === 'pushed' && publicationDestination ? publicationDestination : remoteRepository(state).name,
        repository: phase.id === 'pushed' && publicationDestination ? githubRepositoryFromPushUrl(publicationDestination) : remoteRepository(state).name,
        subscriptionId: null
      });
    } else if (mutation.startsWith('azure-') || mutation.startsWith('backend-state-') || mutation === 'registry-publish') {
      const subscriptionId = state.activationInputs?.azure?.subscriptionId;
      if (!subscriptionId) continue;
      destinations.set('subscription', {
        type: 'subscription',
        identity: subscriptionId,
        repository: null,
        subscriptionId
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

export function authorityOperations(operations                                )                                 {
  return operations.filter((operation) =>
    operation.actionId !== 'governance.evidence.write' && operation.actionId !== 'governance.activation-state.write'
  );
}

export function transitionAuthorityDigest(input   
                        
                           
                                              
                                          
                                                        
                                   
                                             
                     
 )         {
  return canonicalSha256({
    scope: phaseScope(input.phase.id),
    phaseId: input.phase.id,
    gateKind: input.phase.approvalGate.kind,
    transitionDigest: input.transitionDigest,
    allowedMutations: input.phase.allowedMutations,
    operations: input.operations === undefined ? null : authorityOperations(input.operations),
    configuration: input.configuration ?? null,
    configurationBinding: input.configurationBinding ?? null,
    selectionScope: input.selectionScope ?? phaseScope(input.phase.id),
    fileChanges: input.fileChanges ?? [],
    recovery: input.recovery ?? false
  });
}

export function transitionPlanForPhase(
  phase                ,
  state                     ,
  transition                            ,
  _projectRoot         ,
  publicationDestination         ,
  planned    
                                               
                                            
                                                          
                                     
                                               
                       
   
)                          {
  const operations = planned === undefined ? undefined : authorityOperations(planned.operations);
  const effects = operations?.flatMap((operation) => [operation, ...(operation.effects ?? [])]);
  const mutations = effects ? [...new Set(effects.map((effect) => effect.mutationClass))] :
    [...phase.allowedMutations.local, ...phase.allowedMutations.remote].filter((mutation) => mutation !== 'none');
  const destinations = effects === undefined ? destinationsForPhase(phase, state, publicationDestination) :
    [...new Map(effects.map(({ destination }) => {
      const scope                           = {
        type: destination.type, identity: destination.identity,
        repository: destination.repository ?? null, subscriptionId: destination.subscriptionId ?? null
      };
      return [canonicalJson(scope), scope];
    })).values()];
  const budget = (phase.approvalGate.kind === 'activation-plan' || phase.approvalGate.kind === 'infrastructure-cost')
    ? planned?.configuration?.budget ?? state.activationInputs?.budget : undefined;
  return normalizeApprovalScope({
    scope: phaseScope(phase.id),
    phaseId: phase.id,
    coveredPhases: [phase.id],
    ...(operations ? { operationDigests: [...new Set(operations.map((operation) => canonicalSha256(operation)))] } : {}),
    gateKind: phase.approvalGate.kind,
    identity: state.identity,
    baselineSha: transition.baselineSha,
    planDigest: transitionAuthorityDigest({
      phase, transitionDigest: transition.transitionDigest,
      operations, configuration: planned?.configuration, configurationBinding: planned?.configurationBinding,
      selectionScope: planned?.selectionScope, fileChanges: planned?.fileChanges, recovery: planned?.recovery
    }),
    resources: effects ? [...new Map(effects.map((effect) => {
      const resource = { type: effect.mutationClass, identity: effect.destination.identity };
      return [canonicalJson(resource), resource];
    })).values()] : mutations.map((mutation) => ({
      type: mutation,
      identity: `${phase.id}:${mutation}`
    })),
    destinations,
    permissions: mutations,
    costCeiling: budget ?? {
      currency: 'USD',
      fixedMonthlyCents: 0,
      usageMonthlyCents: 0
    },
    policyExceptions: [],
    destructiveScope: phase.approvalGate.kind === 'destructive-disposal'
      ? [...(state.bootstrapState?.encryptedStatePathParts ?? []), ...(state.bootstrapState?.encryptionKeyPathParts ?? [])]
        .map((parts) => parts.join('/'))
      : []
  });
}

export function approvalRequestForSavedPlan(plan                     , phase                , state                     )                          {
  const primary = transitionPlanForPhase(phase, state, {
    phaseId: plan.phaseId, baselineSha: plan.baselineDigest,
    inputDigest: plan.inputDigest, transitionDigest: plan.transitionDigest
  }, undefined, undefined, { operations: plan.operations, configuration: plan.configuration,
    configurationBinding: plan.configurationBinding, selectionScope: plan.selectionScope,
    fileChanges: plan.fileChanges, recovery: plan.recovery });
  if (!plan.approvalBundle?.length) return primary;
  const secondary = plan.approvalBundle.map((entry) => {
    const node = canonicalPhaseForApproval(entry.phaseId);
    return transitionPlanForPhase(node, state, {
      phaseId: entry.phaseId, baselineSha: plan.baselineDigest, inputDigest: entry.inputDigest,
      transitionDigest: entry.transitionDigest
    }, undefined, undefined, { operations: entry.operations, configuration: plan.configuration,
      configurationBinding: plan.configurationBinding, selectionScope: plan.selectionScope, fileChanges: entry.fileChanges });
  });
  return combineApprovalRequests([primary, ...secondary]);
}

export function savedPlanAuthorityDigest(plan                     , phase                )         {
  const primary = transitionAuthorityDigest({
    phase, transitionDigest: plan.transitionDigest, operations: plan.operations,
    configuration: plan.configuration, configurationBinding: plan.configurationBinding, selectionScope: plan.selectionScope,
    fileChanges: plan.fileChanges, recovery: plan.recovery
  });
  if (!plan.approvalBundle?.length) return primary;
  const phasePlanDigests = Object.fromEntries([
    [phase.id, primary],
    ...plan.approvalBundle.map((entry) => [entry.phaseId, transitionAuthorityDigest({
      phase: canonicalPhaseForApproval(entry.phaseId), transitionDigest: entry.transitionDigest,
      operations: entry.operations, fileChanges: entry.fileChanges, configuration: plan.configuration,
      configurationBinding: plan.configurationBinding, selectionScope: plan.selectionScope
    })])
  ]);
  return canonicalSha256({ scope: phaseScope(phase.id), phasePlanDigests });
}

function canonicalPhaseForApproval(id         )                 {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === id);
  if (!phase) throw new Error(`Unknown approval phase ${id}.`);
  return phase;
}

export function combineApprovalRequests(plans                                    )                          {
  if (plans.length === 0) throw new Error('An approval bundle must name at least one resolved phase plan.');
  const requests = plans.map(normalizeApprovalScope);
  const first = requests[0] ;
  if (requests.some((request) => !sameIdentity(first.identity, request.identity) ||
    request.baselineSha !== first.baselineSha || request.gateKind !== first.gateKind ||
    (request.scope ?? phaseScope(request.phaseId)) !== (first.scope ?? phaseScope(first.phaseId)) ||
    request.costCeiling.currency !== first.costCeiling.currency || request.phasePlanDigests !== undefined)) {
    throw new Error('An approval bundle requires one identity, baseline, scope, authority gate, and currency; nested bundles are not supported.');
  }
  if (new Set(requests.map((request) => request.phaseId)).size !== requests.length) throw new Error('An approval bundle cannot repeat a phase.');
  const distinct =    (values              ) => [...new Map(values.map((value) => [canonicalJson(value), value])).values()];
  const phasePlanDigests = Object.fromEntries(requests.map((request) => [request.phaseId, request.planDigest]));
  return normalizeApprovalScope({
    ...first,
    planDigest: canonicalSha256({ scope: first.scope ?? phaseScope(first.phaseId), phasePlanDigests }),
    coveredPhases: requests.map((request) => request.phaseId),
    operationDigests: distinct(requests.flatMap((request) => request.operationDigests ?? [])),
    phasePlanDigests,
    resources: distinct(requests.flatMap((request) => request.resources)),
    destinations: distinct(requests.flatMap((request) => request.destinations)),
    permissions: distinct(requests.flatMap((request) => request.permissions)),
    policyExceptions: distinct(requests.flatMap((request) => request.policyExceptions)),
    destructiveScope: distinct(requests.flatMap((request) => request.destructiveScope)),
    costCeiling: {
      currency: first.costCeiling.currency,
      fixedMonthlyCents: requests.reduce((sum, request) => sum + request.costCeiling.fixedMonthlyCents, 0),
      usageMonthlyCents: requests.reduce((sum, request) => sum + request.costCeiling.usageMonthlyCents, 0)
    }
  });
}
