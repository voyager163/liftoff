import { types } from 'node:util';
import type { ApprovalDestinationValueV1 } from './approval-values.js';
import { canonicalJson, canonicalSha256, isRecord } from './canonical-json.js';
import { cleanString, sortedUnique, resourceKey, destinationKey, normalizeApprovalCostCeiling, normalizeApprovalResources,
  normalizeApprovalDestinations, normalizeApprovalPermissions, normalizeApprovalPolicyExceptions,
  normalizeApprovalDestructiveScope } from './approval-values.js';
import type * as R from './record-contracts.js';
import type { RecordOperation, RecordGraph } from './modern-record-contracts.js';

type Scope<I extends R.ActivationIdentityFieldsV1, P extends string> = Omit<R.ApprovalEnvelopeFieldsV3<I, P>,
  'id' | 'schemaVersion' | 'expiresAt' | 'approvedAt' | 'approver'>;
const hex64Pattern = /^[a-f0-9]{64}$/u;
const isoLikePattern = /^\d{4}-\d{2}-\d{2}T/u;

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

export function normalizeApprovalScopeValues<I extends R.ActivationIdentityFieldsV1, PhaseId extends string>(
  scope: Scope<I, PhaseId>, phaseIds: readonly PhaseId[]
): Scope<I, PhaseId> {
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
  const phasePlanDigests: Partial<Record<PhaseId, string>> = {};
  if (scope.phasePlanDigests) {
    for (const id of Object.keys(scope.phasePlanDigests)) {
      if (!(phaseIds as readonly string[]).includes(id)) throw new Error('An approval bundle contains an unknown phase.');
      phasePlanDigests[id as PhaseId] = digest(scope.phasePlanDigests[id as PhaseId]!, `approvalEnvelope.phasePlanDigests.${id}`);
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

export function canonicalApprovalEnvelopeValues<I extends R.ActivationIdentityFieldsV1, P extends string>(
  envelope: R.ApprovalEnvelopeFieldsV3<I, P>, normalized: Scope<I, P>
): Record<string, unknown> {
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

export function authorityOperationValues<O extends { actionId: string }>(operations: readonly O[]): readonly O[] {
  return operations.filter((operation) =>
    operation.actionId !== 'governance.evidence.write' && operation.actionId !== 'governance.activation-state.write'
  );
}

export function transitionAuthorityValues<P extends string, M extends string = R.ReleasedMutationClassV3>(input: {
  phase: RecordGraph<P, M>['phases'][number];
  transitionDigest: string;
  operations?: readonly RecordOperation<P, M>[];
  configuration?: R.ActivationConfigurationFieldsV1<P>;
  fileChanges?: readonly R.PlannedFileChangeFieldsV1[];
  recovery?: boolean;
}, scope: R.ReleasedGovernanceScopeV3): string {
  return canonicalSha256({
    scope: scope,
    phaseId: input.phase.id,
    gateKind: input.phase.approvalGate.kind,
    transitionDigest: input.transitionDigest,
    allowedMutations: input.phase.allowedMutations,
    operations: input.operations === undefined ? null : authorityOperationValues(input.operations),
    configuration: input.configuration ?? null,
    fileChanges: input.fileChanges ?? [],
    recovery: input.recovery ?? false
  });
}

export function semanticPlanDigest(input: {
  phase: { id: string }; transitionDigest: string; operations: readonly unknown[]; approvalPlanDigest: string;
}): string {
  return canonicalSha256({
    phaseId: input.phase.id,
    transitionDigest: input.transitionDigest,
    approvalPlanDigest: input.approvalPlanDigest,
    operations: input.operations
  });
}

export function approvalOperationDigests(operations: readonly { actionId: string }[]): string[] {
  return [...new Set(operations.map((operation) => canonicalSha256(operation)))];
}

export function approvalBundleDigest(scope: R.ReleasedGovernanceScopeV3, phasePlanDigests: object): string {
  return canonicalSha256({ scope, phasePlanDigests });
}

export function outputBindingsMatch<I extends R.ActivationIdentityFieldsV1, P extends string>(
  record: R.PhaseEvidenceRecordFieldsV3<I, P>, id: P,
  references: readonly R.EvidenceReferenceFieldsV3<P>[], outputs: R.PhaseOutputBindingsFieldsV1
): boolean {
  return record.header.phaseId === id && record.header.result === 'verified' &&
    references.some((reference) => reference.evidenceId === record.evidenceId && reference.headerDigest === canonicalSha256(record.header)) &&
    isRecord(record.payload) && canonicalSha256(record.payload.outputBindings ?? null) === canonicalSha256(outputs);
}

export function outputResourcesMatch<I extends R.ActivationIdentityFieldsV1, P extends string>(
  outputs: R.PhaseOutputBindingsFieldsV1, bound: R.PhaseEvidenceRecordFieldsV3<I, P> | undefined
): boolean {
  return !!bound && !outputs.resources.some((resource) => !bound.liveReadback?.some((proof) =>
    proof.provider === resource.provider && proof.resourceId === resource.resourceId &&
    proof.resourceType === resource.resourceType && proof.matches));
}

export function assertGraphMappingDigests<P extends string>(
  mappings: readonly { phaseId: P; fromContractDigest: string; toContractDigest: string }[],
  fromDigests: Readonly<Partial<Record<P, string>>>, toDigests: Readonly<Partial<Record<P, string>>>
): void {
  for (const mapping of mappings) {
    if (fromDigests[mapping.phaseId] !== mapping.fromContractDigest) {
      throw new Error(`graphReconciliation phase ${mapping.phaseId} fromContractDigest does not match the recognized source graph.`);
    }

    if (toDigests[mapping.phaseId] !== mapping.toContractDigest) {
      throw new Error(`graphReconciliation phase ${mapping.phaseId} toContractDigest does not match the recognized target graph.`);
    }
  }
}

export function projectionOperation<P extends string, M extends string = R.ReleasedMutationClassV3>(operations: readonly RecordOperation<P, M>[]) {
  const projections = operations.filter((operation) => operation.actionId === 'governance.tasks.project');
  if (projections.length > 1) throw new Error('A phase can project only one exact current governance task document.');
  if (!projections.length) return undefined;
  const operation = projections[0];
  if (Object.keys(operation.inputs).join(',') !== 'projection') throw new Error('Task projection has no unbounded adapter inputs.');
  return operation;
}

export function assertProjectionDestination<P extends string, M extends string = R.ReleasedMutationClassV3>(
  operation: RecordOperation<P, M>, contract: R.TaskProjectionSourceFieldsV1
): void {
  if (operation.adapter !== 'local-evidence' || operation.mutationClass !== 'project-governance-tasks' ||
    operation.remote || operation.destructive || operation.effects?.length ||
    operation.destination.type !== 'local' || operation.destination.identity !== contract.taskPathParts.join('/') ||
    operation.destination.pathParts?.join('/') !== contract.taskPathParts.join('/') ||
    Object.keys(operation.destination).some((key) => !['type', 'identity', 'pathParts'].includes(key))) {
    throw new Error('Task projection must name only its exact local checkbox destination.');
  }
}

export interface PhaseTaskMapping<P extends string> {
  phaseId: P;
  taskId: string;
}

export type PhaseProjectionState = R.ReleasedPhaseStateV3 | 'identity-incompatible';
export type PhaseProjectionInput = PhaseProjectionState | { state: PhaseProjectionState };

export interface TaskProjectionChange<P extends string> {
  phaseId: P;
  taskId: string;
  fromChecked: boolean;
  toChecked: boolean;
  state: PhaseProjectionState;
}

export interface TaskProjectionResult<P extends string> {
  markdown: string;
  changes: readonly TaskProjectionChange<P>[];
}

const checkedStates = new Set<PhaseProjectionState>([
  'approved',
  'verified',
  'inapplicable',
  'retained',
  'disposed'
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectedChecked(state: PhaseProjectionState): boolean {
  return checkedStates.has(state);
}

function projectionState(value: PhaseProjectionInput | undefined, currentPhaseStates: readonly string[]): PhaseProjectionState | undefined {
  if (value === undefined) {
    return undefined;
  }
  const state = typeof value === 'string' ? value : value.state;
  if (state !== 'identity-incompatible' && !currentPhaseStates.some((entry) => entry === state)) {
    throw new Error('Task projection requires an explicit calculated current phase state, not historical or unknown progress.');
  }
  return state;
}

function validateMappings<P extends string>(mappings: readonly PhaseTaskMapping<P>[], phaseIds: readonly P[]): void {
  const phases = new Set<P>();
  const tasks = new Set<string>();
  for (const mapping of mappings) {
    if (!phaseIds.some((id) => id === mapping.phaseId)) throw new Error('Task projection contains an unknown current phase.');
    if (phases.has(mapping.phaseId)) {
      throw new Error(`Task projection contains duplicate mapping for phase ${mapping.phaseId}.`);
    }
    if (tasks.has(mapping.taskId)) {
      throw new Error(`Task projection contains duplicate mapping for task ${mapping.taskId}.`);
    }
    if (mapping.taskId.trim().length === 0) {
      throw new Error(`Task projection task id for phase ${mapping.phaseId} must be non-empty.`);
    }
    phases.add(mapping.phaseId);
    tasks.add(mapping.taskId);
  }
}

export function projectTaskCheckboxValues<P extends string>(
  markdown: string,
  mappings: readonly PhaseTaskMapping<P>[],
  phaseStates: Partial<Record<P, PhaseProjectionInput>>, phaseIds: readonly P[], currentPhaseStates: readonly string[]
): TaskProjectionResult<P> {
  validateMappings(mappings, phaseIds);
  const lines = markdown.split('\n');
  const changes: TaskProjectionChange<P>[] = [];
  for (const mapping of mappings) {
    const state = projectionState(phaseStates[mapping.phaseId], currentPhaseStates);
    if (!state) {
      throw new Error(`Task projection is missing calculated phase state for ${mapping.phaseId}.`);
    }
    const pattern = new RegExp(`^(\\s*[-*]\\s+\\[)([ xX])(\\]\\s+${escapeRegex(mapping.taskId)}(?=\\s|$).*)$`);
    const matches = lines
      .map((line, index) => ({ line, index, match: (line.endsWith('\r') ? line.slice(0, -1) : line).match(pattern) }))
      .filter((entry): entry is { line: string; index: number; match: RegExpMatchArray } => entry.match !== null);
    if (matches.length === 0) {
      throw new Error(`Task projection mapping for ${mapping.phaseId} cannot find task ${mapping.taskId}.`);
    }
    if (matches.length > 1) {
      throw new Error(`Task projection mapping for ${mapping.phaseId} is ambiguous for task ${mapping.taskId}.`);
    }
    const [match] = matches;
    const fromChecked = match.match[2]!.toLowerCase() === 'x';
    const toChecked = projectedChecked(state);
    if (fromChecked !== toChecked) {
      const position = match.match[1].length;
      lines[match.index] = `${match.line.slice(0, position)}${toChecked ? 'x' : ' '}${match.line.slice(position + 1)}`;
      changes.push({
        phaseId: mapping.phaseId,
        taskId: mapping.taskId,
        fromChecked,
        toChecked,
        state
      });
    }
  }
  return {
    markdown: lines.join('\n'),
    changes
  };
}

export function assertTaskMarkers(markdown: string, mappings: readonly { taskId: string; marker: string }[]): void {
  for (const mapping of mappings) {
    const task = new RegExp(`^\\s*[-*]\\s+\\[[ xX]\\]\\s+${escapeRegex(mapping.taskId)}(?=\\s|$)`);
    const rows = markdown.split(/\r?\n/u).filter((line) => task.test(line));
    if (rows.length !== 1 || !rows[0].includes(mapping.marker) || markdown.split(mapping.marker).length !== 2) {
      throw new Error(`Current task ${mapping.taskId} must have exactly its registered phase marker.`);
    }
  }
}

export function validatePhasePayloadValues<I extends R.ActivationIdentityFieldsV1, P extends string>(record: R.PhaseEvidenceRecordFieldsV3<I, P>): string[] {
  if (record.header.result === 'failed' || record.header.result === 'inapplicable') return [];
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return [`${record.header.phaseId} requires a phase-specific evidence payload.`];
  }

  const value = payload as Record<string, unknown>;
  const expected = record.header.phaseId === 'phase-0-complete' ? 'phase-0-discovery.v1' : `${record.header.phaseId}.v1`;
  const issues = value.kind === expected ? [] : [`${record.header.phaseId} payload kind must be ${expected}.`];
  if (record.header.phaseId === 'seed-verified') {
    if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.some((check) =>
      typeof check !== 'object' || check === null || !['passed', 'inapplicable'].includes(String(check.status)))) {
      issues.push('Local baseline evidence requires successful applicable check outcomes.');
    }
  }
  if (record.header.phaseId === 'phase-0-complete') {
    if (!Array.isArray(value.facts) || !['repository.id', 'repository.nameWithOwner', 'repository.defaultBranch']
      .every((id) => (value.facts as Array<{ id?: unknown; value?: unknown }>).some((fact) => fact.id === id && typeof fact.value === 'string' && fact.value))) {
      issues.push('Phase 0 requires independently observed repository identity facts.');
    }
  }
  if (['committed', 'pushed'].includes(record.header.phaseId) &&
    (typeof value.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.head))) {
    issues.push('Publication evidence must record the actual Git HEAD separately from the SHA-256 baseline.');
  }
  if (['committed', 'pushed'].includes(record.header.phaseId) && record.header.inputBindings?.git &&
    value.head !== record.header.inputBindings.git.after.head) {
    issues.push('Publication evidence must match the independently observed resulting Git object ID.');
  }
  if (record.header.phaseId === 'runner-ready') {
    if (typeof value.organization !== 'string' || !Number.isInteger(value.runnerId) || Number(value.runnerId) <= 0 ||
      !(value.groupId === null || Number.isInteger(value.groupId)) ||
      !(value.networkConfigurationId === null || typeof value.networkConfigurationId === 'string')) {
      issues.push('Runner proof requires an explicit organization, runner ID, group, and network-configuration binding.');
    }
    if (!(record.liveReadback ?? []).some((proof) => proof.provider === 'github' &&
      (proof.resourceId === String(value.runnerId) || proof.resourceId.endsWith(`/hosted-runners/${value.runnerId}`)))) {
      issues.push('Runner payload ID has no matching independent runner resource readback.');
    }
  }
  if (record.header.phaseId === 'state-path-selected' && !['existing-private', 'bootstrap-local'].includes(String(value.statePath))) {
    issues.push('State-path selection requires an explicit applicable backend path.');
  }
  if (record.header.phaseId === 'workflow-source-ready' && (typeof value.rulesetSourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.rulesetSourceDigest))) {
    issues.push('Workflow-source evidence must bind the reviewed ruleset source digest.');
  }
  if (record.header.phaseId === 'credential-ready' && (typeof value.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.policyDigest))) {
    issues.push('Credential evidence must bind the public credential policy and independent readback.');
  }
  const scope = typeof value.assessmentScope === 'object' && value.assessmentScope !== null
    ? value.assessmentScope as Record<string, unknown> : undefined;
  if (scope?.azure !== undefined) {
    if (!Array.isArray(scope.azure)) issues.push('Azure evidence scope must be an explicit resource inventory.');
    else for (const resource of scope.azure) {
      if (typeof resource !== 'object' || resource === null ||
        typeof resource.resourceId !== 'string' || typeof resource.resourceType !== 'string' ||
        !['dev', 'staging', 'prod'].includes(resource.environment) || typeof resource.role !== 'string' ||
        !(record.liveReadback ?? []).some((proof) => proof.provider === 'azure' && proof.resourceId === resource.resourceId && proof.resourceType === resource.resourceType)) {
        issues.push('Azure payload scope requires an explicit environment/role and matching resource readback.');
      }
    }
  }
  return issues;
}

/** Modern intake rejects executable hooks before any field can be evaluated by shared decoders. */
export function assertModernRecordData(value: unknown, label = 'modern record', depth = 0): void {
  if (depth > 20) throw new Error(`${label} exceeds the supported JSON nesting depth.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string' ||
    typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || types.isProxy(value) ||
    ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must contain only plain JSON data.`);
  }
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1)) {
    throw new Error(`${label} must be a dense plain JSON array.`);
  }
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
      ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key) ||
      array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error(`${label} requires own enumerable JSON data fields without hooks.`);
    }
    assertModernRecordData(descriptor.value, `${label}.${key}`, depth + 1);
  }
}

const credentialText = [
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAccountKey=[^;\s]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9_.~-]{16,}/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/u,
  /[?&]sig=[A-Za-z0-9%+/=]{16,}/iu
];
const sensitiveKeys = new Set([
  'password', 'passwd', 'secret', 'secretvalue', 'credentialvalue', 'tokenvalue',
  'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey', 'encryptionkey',
  'accountkey', 'connectionstring', 'rawstate', 'statepayload', 'terraformstate',
  'tfstate', 'savedplan', 'planpayload', 'sensitiveplan'
]);

/** Reject rather than redact: redacted bytes cannot be called an immutable source snapshot. */
export function assertSafeControlRecord(value: unknown, reject: () => never): void {
  let nodes = 0;
  const fail = reject;
  function visit(entry: unknown, depth: number): void {
    if (++nodes > 200_000 || depth > 64) fail();
    if (typeof entry === 'string') {
      if (entry.length > 8 * 1024 * 1024 || credentialText.some((pattern) => pattern.test(entry))) fail();
      // Payloads serialized inside another JSON string are still payloads.
      let parsedJson = false;
      if (/^\s*[{[]/u.test(entry)) {
        try {
          const parsed: unknown = JSON.parse(entry);
          visit(parsed, depth + 1);
          parsedJson = true;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (!parsedJson && (/"(?:terraform_version|planned_values|resource_changes|prior_state)"\s*:/u.test(entry) ||
        /"serial"\s*:/u.test(entry) && /"lineage"\s*:/u.test(entry) && /"(?:resources|outputs)"\s*:/u.test(entry))) fail();
    } else if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item, depth + 1));
    } else if (isRecord(entry)) {
      if ((Object.hasOwn(entry, 'serial') && Object.hasOwn(entry, 'lineage') &&
        (Object.hasOwn(entry, 'resources') || Object.hasOwn(entry, 'outputs'))) ||
        Object.hasOwn(entry, 'terraform_version') && (Object.hasOwn(entry, 'values') || Object.hasOwn(entry, 'resources')) ||
        Object.hasOwn(entry, 'planned_values') || Object.hasOwn(entry, 'resource_changes') ||
        Object.hasOwn(entry, 'prior_state') || Object.hasOwn(entry, 'root_module')) fail();
      for (const [key, item] of Object.entries(entry)) {
        const normalized = key.replace(/[-_]/gu, '').toLowerCase();
        if ((sensitiveKeys.has(normalized) || normalized === 'token' && typeof item === 'string') &&
          item !== null && item !== false && item !== '') fail();
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
    }
  }
  visit(value, 0);
}


function containsAll<T>(approved: readonly T[], requested: readonly T[], keyFor: (value: T) => string): string[] {
  const approvedKeys = new Set(approved.map((value) => keyFor(value)));
  return requested.map((value) => keyFor(value)).filter((key) => !approvedKeys.has(key));
}

export function approvalScopeExpansionReasons<I extends R.ActivationIdentityFieldsV1, P extends string>(approved: Scope<I, P>, requested: Scope<I, P>): string[] {
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
  const phaseMisses = containsAll(approved.coveredPhases ?? [approved.phaseId], requested.coveredPhases ?? [requested.phaseId], (value) => value);
  reasons.push(...phaseMisses.map((phase) => `phase scope expanded: ${phase}`));
  const operationMisses = containsAll(approved.operationDigests ?? [], requested.operationDigests ?? [], (value) => value);
  reasons.push(...operationMisses.map((operation) => `operation scope expanded: ${operation}`));
  return reasons;
}

type ApprovalEffect<M extends string> = { mutationClass: M; destination: R.TransitionOperationDestinationFieldsV1 };
export function plannedApprovalMutations<M extends string>(effects: readonly ApprovalEffect<M>[]): M[] {
  return [...new Set(effects.map((effect) => effect.mutationClass))];
}
export function plannedApprovalDestinations<M extends string>(effects: readonly ApprovalEffect<M>[]) {
  return [...new Map(effects.map(({ destination }) => {
      const scope: ApprovalDestinationValueV1 = {
        type: destination.type, identity: destination.identity,
        repository: destination.repository ?? null, subscriptionId: destination.subscriptionId ?? null
      };
      return [canonicalJson(scope), scope];
    })).values()];
}
export function plannedApprovalResources<M extends string>(effects: readonly ApprovalEffect<M>[]) {
  return [...new Map(effects.map((effect) => {
      const resource = { type: effect.mutationClass, identity: effect.destination.identity };
      return [canonicalJson(resource), resource];
    })).values()];
}
