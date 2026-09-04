import {
  activationCompatibility,
  canonicalPhaseGraph,
  canonicalPhaseGraphHash,
  currentActivationIdentity
} from './graph.js';
import {
  activationContractVersion,
  activationStateSchemaVersion,
  approvalEnvelopeSchemaVersion,
  credentialPolicySchemaVersion,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  liftoffManifestArtifactVersion,
  phaseGraphSchemaVersion,
  resolveActivationCompatibility,
  supersessionSchemaVersion
} from './identity.js';
import {
  normalizeApprovalCostCeiling,
  normalizeApprovalDestinations,
  normalizeApprovalDestructiveScope,
  normalizeApprovalPermissions,
  normalizeApprovalPolicyExceptions,
  normalizeApprovalResources
} from './approvals.js';
import type {
  ActivationIdentity,
  ApprovalEnvelope,
  ApprovalEvaluation,
  ApprovalGateKind,
  CredentialPolicy,
  CredentialRepositoryIdentity,
  EvidenceTransitionIdentity,
  EvidenceReference,
  EvidenceHeader,
  GraphReconciliationRecord,
  InvalidationInputKind,
  LiveReadbackProof,
  LiveReadbackProvider,
  ManagedPhaseGraph,
  MutationClass,
  PhaseGraphNode,
  PhaseId,
  PhaseState,
  SavedTransitionPlan,
  RollbackKind,
  TransitionOperation,
  TransitionOperationDestination,
  TransitionRollbackPlan,
  SupersessionRecord,
  TerminalPhaseState,
  UserActivationState
} from './types.js';
import {
  approvalGateKinds,
  invalidationInputKinds,
  mutationClasses,
  phaseIds,
  phaseStates,
  rollbackKinds
  ,
  runnerPreflightDisplayNameTemplate,
  runnerPreflightOrganizationPermissions,
  runnerPreflightPatLifetimeDays,
  runnerPreflightRepositoryPermissions,
  runnerPreflightRotationLeadDays,
  runnerPreflightSecretName
} from './types.js';

const phaseIdSet = new Set<string>(phaseIds);
const terminalPhaseStateSet = new Set<string>(['approved', 'verified', 'failed', 'inapplicable', 'retained', 'disposed']);
const resultStateSet = new Set<string>(['verified', 'failed', 'inapplicable', 'retained', 'disposed']);
const hex64Pattern = /^[a-f0-9]{64}$/;
const isoLikePattern = /^\d{4}-\d{2}-\d{2}T/;
const liveReadbackProviderSet = new Set<string>(['github', 'azure']);
const githubRemoteWriteMutations = new Set<MutationClass>(['github-write', 'github-secret-write', 'github-ruleset-write']);
const azureRemoteWriteMutations = new Set<MutationClass>([
  'azure-provider-register',
  'azure-network-provision',
  'azure-state-import',
  'azure-resource-provision'
]);
const transitionAdapterIds = new Set<string>([
  'local-evidence',
  'selected-spec-workflow',
  'git',
  'github',
  'azure-opentofu',
  'local-state'
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, requiredKeys: readonly string[], path: string): Record<string, unknown> {
  const item = record(value, path);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not allowed.`);
    }
  }
  return item;
}

function exactWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string
): Record<string, unknown> {
  const item = record(value, path);
  for (const key of requiredKeys) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not allowed.`);
    }
  }
  return item;
}

function stringField(item: Record<string, unknown>, key: string, path: string): string {
  const value = item[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  return value;
}

function booleanField(item: Record<string, unknown>, key: string, path: string): boolean {
  const value = item[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${path}.${key} must be a boolean.`);
  }
  return value;
}

function numberField(item: Record<string, unknown>, key: string, path: string): number {
  const value = item[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}.${key} must be a finite number.`);
  }
  return value;
}

function integerField(item: Record<string, unknown>, key: string, path: string): number {
  const value = numberField(item, key, path);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${path}.${key} must be a safe integer.`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, path);
}

function pathPartsArray(value: unknown, path: string): readonly string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value.map((entry, index) => stringArray(entry, `${path}[${index}]`));
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${path} contains unsupported value ${JSON.stringify(value)}.`);
  }
  return value as T;
}

function requireVersion(value: unknown, expected: string | number, path: string): void {
  if (value !== expected) {
    throw new Error(`${path} must be ${JSON.stringify(expected)}.`);
  }
}

function validateActivationIdentityShape(value: unknown, path: string): ActivationIdentity {
  const identity = exact(value, [
    'liftoffVersion',
    'manifestArtifactVersion',
    'policyVersion',
    'activationContractVersion',
    'phaseGraphSchemaVersion',
    'phaseGraphHash',
    'activationStateSchemaVersion',
    'evidenceHeaderSchemaVersion',
    'approvalEnvelopeSchemaVersion',
    'supersessionSchemaVersion',
    'credentialPolicySchemaVersion'
  ], path);
  requireVersion(identity.liftoffVersion, liftoffActivationPackageVersion, `${path}.liftoffVersion`);
  requireVersion(identity.manifestArtifactVersion, liftoffManifestArtifactVersion, `${path}.manifestArtifactVersion`);
  requireVersion(identity.policyVersion, governanceActivationPolicyVersion, `${path}.policyVersion`);
  requireVersion(identity.activationContractVersion, activationContractVersion, `${path}.activationContractVersion`);
  requireVersion(identity.phaseGraphSchemaVersion, phaseGraphSchemaVersion, `${path}.phaseGraphSchemaVersion`);
  requireVersion(identity.activationStateSchemaVersion, activationStateSchemaVersion, `${path}.activationStateSchemaVersion`);
  requireVersion(identity.evidenceHeaderSchemaVersion, evidenceHeaderSchemaVersion, `${path}.evidenceHeaderSchemaVersion`);
  requireVersion(identity.approvalEnvelopeSchemaVersion, approvalEnvelopeSchemaVersion, `${path}.approvalEnvelopeSchemaVersion`);
  requireVersion(identity.supersessionSchemaVersion, supersessionSchemaVersion, `${path}.supersessionSchemaVersion`);
  requireVersion(identity.credentialPolicySchemaVersion, credentialPolicySchemaVersion, `${path}.credentialPolicySchemaVersion`);
  const phaseGraphHash = stringField(identity, 'phaseGraphHash', path);
  if (!hex64Pattern.test(phaseGraphHash)) {
    throw new Error(`${path}.phaseGraphHash must be a SHA-256 hex digest.`);
  }
  return {
    liftoffVersion: identity.liftoffVersion as ActivationIdentity['liftoffVersion'],
    manifestArtifactVersion: identity.manifestArtifactVersion as ActivationIdentity['manifestArtifactVersion'],
    policyVersion: identity.policyVersion as ActivationIdentity['policyVersion'],
    activationContractVersion: identity.activationContractVersion as ActivationIdentity['activationContractVersion'],
    phaseGraphSchemaVersion: identity.phaseGraphSchemaVersion as ActivationIdentity['phaseGraphSchemaVersion'],
    phaseGraphHash,
    activationStateSchemaVersion: identity.activationStateSchemaVersion as ActivationIdentity['activationStateSchemaVersion'],
    evidenceHeaderSchemaVersion: identity.evidenceHeaderSchemaVersion as ActivationIdentity['evidenceHeaderSchemaVersion'],
    approvalEnvelopeSchemaVersion: identity.approvalEnvelopeSchemaVersion as ActivationIdentity['approvalEnvelopeSchemaVersion'],
    supersessionSchemaVersion: identity.supersessionSchemaVersion as ActivationIdentity['supersessionSchemaVersion'],
    credentialPolicySchemaVersion: identity.credentialPolicySchemaVersion as ActivationIdentity['credentialPolicySchemaVersion']
  };
}

export function validateActivationIdentity(value: unknown): ActivationIdentity {
  const typed = validateActivationIdentityShape(value, 'identity');
  const compatibility = resolveActivationCompatibility(typed, activationCompatibility);
  if (!compatibility.compatible) {
    throw new Error(compatibility.reason);
  }
  return typed;
}

function hexDigest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !hex64Pattern.test(value)) {
    throw new Error(`${path} must be a SHA-256 hex digest.`);
  }
  return value;
}

function isoTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !isoLikePattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${path} must be a valid ISO timestamp.`);
  }
  return value;
}

function dateDaysBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / (24 * 60 * 60 * 1000);
}

function addDaysIso(start: string, days: number): string {
  return new Date(Date.parse(start) + days * 24 * 60 * 60 * 1000).toISOString();
}

function exactStringSet(
  value: readonly string[],
  expected: readonly string[],
  path: string
): readonly string[] {
  const sortedValue = [...value].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedValue.length !== sortedExpected.length ||
    sortedValue.some((entry, index) => entry !== sortedExpected[index])
  ) {
    throw new Error(`${path} must exactly equal ${expected.join(', ')}.`);
  }
  return expected;
}

function assertNoDuplicateStrings(value: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const entry of value) {
    if (seen.has(entry)) {
      throw new Error(`${path} contains duplicate value ${entry}.`);
    }
    seen.add(entry);
  }
}

function validateCredentialRepositoryIdentity(value: unknown, path: string): CredentialRepositoryIdentity {
  const repository = exact(value, ['id', 'owner', 'name', 'fullName'], path);
  const owner = stringField(repository, 'owner', path);
  const name = stringField(repository, 'name', path);
  const fullName = stringField(repository, 'fullName', path);
  if (fullName !== `${owner}/${name}`) {
    throw new Error(`${path}.fullName must equal owner/name.`);
  }
  return {
    id: stringField(repository, 'id', path),
    owner,
    name,
    fullName
  };
}

function assertTimestampNotExpired(value: string, path: string, now: Date): void {
  if (Date.parse(value) <= now.getTime()) {
    throw new Error(`${path} must be in the future.`);
  }
}

function validateEvidenceTransitionIdentity(value: unknown, path: string): EvidenceTransitionIdentity {
  const transition = exact(value, ['phaseId', 'baselineSha', 'inputDigest', 'transitionDigest'], path);
  return {
    phaseId: enumValue<PhaseId>(transition.phaseId, phaseIdSet, `${path}.phaseId`),
    baselineSha: hexDigest(transition.baselineSha, `${path}.baselineSha`),
    inputDigest: hexDigest(transition.inputDigest, `${path}.inputDigest`),
    transitionDigest: hexDigest(transition.transitionDigest, `${path}.transitionDigest`)
  };
}

function validateDependency(value: unknown, path: string): PhaseGraphNode['dependencies'][number] {
  const dependency = exact(value, ['anyOf', 'accepts', 'description'], path);
  const anyOf = stringArray(dependency.anyOf, `${path}.anyOf`).map((id) =>
    enumValue<PhaseId>(id, phaseIdSet, `${path}.anyOf`)
  );
  if (anyOf.length === 0) {
    throw new Error(`${path}.anyOf must not be empty.`);
  }
  const accepts = stringArray(dependency.accepts, `${path}.accepts`).map((state) =>
    enumValue<TerminalPhaseState>(state, terminalPhaseStateSet, `${path}.accepts`)
  );
  if (accepts.length === 0) {
    throw new Error(`${path}.accepts must not be empty.`);
  }
  return { anyOf, accepts, description: stringField(dependency, 'description', path) };
}

function validateApplicability(value: unknown, path: string): PhaseGraphNode['applicability'] {
  const base = record(value, path);
  if (base.kind === 'always') {
    exact(value, ['kind'], path);
    return { kind: 'always' };
  }
  const applicability = exact(value, [
    'kind',
    'discriminator',
    'when',
    'inapplicableWhen',
    'exclusiveWith'
  ], path);
  enumValue(applicability.kind, new Set(['conditional']), `${path}.kind`);
  const discriminator = enumValue<'state-path' | 'private-staging-dast' | 'credential-required'>(
    applicability.discriminator,
    new Set(['state-path', 'private-staging-dast', 'credential-required']),
    `${path}.discriminator`
  );
  const exclusiveWith = stringArray(applicability.exclusiveWith, `${path}.exclusiveWith`).map((id) =>
    enumValue<PhaseId>(id, phaseIdSet, `${path}.exclusiveWith`)
  );
  return {
    kind: 'conditional',
    discriminator,
    when: stringField(applicability, 'when', path),
    inapplicableWhen: stringField(applicability, 'inapplicableWhen', path),
    exclusiveWith
  };
}

function validateMutations(value: unknown, path: string): PhaseGraphNode['allowedMutations'] {
  const mutations = exact(value, ['local', 'remote'], path);
  const mutationSet = new Set<string>(mutationClasses);
  const local = stringArray(mutations.local, `${path}.local`).map((entry) =>
    enumValue<MutationClass>(entry, mutationSet, `${path}.local`)
  );
  const remote = stringArray(mutations.remote, `${path}.remote`).map((entry) =>
    enumValue<MutationClass>(entry, mutationSet, `${path}.remote`)
  );
  for (const [label, entries] of [['local', local], ['remote', remote]] as const) {
    if (entries.length === 0) {
      throw new Error(`${path}.${label} must not be empty.`);
    }
    if (entries.includes('none') && entries.length > 1) {
      throw new Error(`${path}.${label} cannot combine none with other mutations.`);
    }
  }
  return { local, remote };
}

function validateNode(value: unknown, path: string): PhaseGraphNode {
  const node = exact(value, [
    'id',
    'label',
    'dependencies',
    'applicability',
    'allowedMutations',
    'evidence',
    'approvalGate',
    'invalidationInputs',
    'rollback',
    'terminalStates'
  ], path);
  const id = enumValue<PhaseId>(node.id, phaseIdSet, `${path}.id`);
  const label = stringField(node, 'label', path);
  if (!Array.isArray(node.dependencies)) {
    throw new Error(`${path}.dependencies must be an array.`);
  }
  const dependencies = node.dependencies.map((dependency, index) =>
    validateDependency(dependency, `${path}.dependencies[${index}]`)
  );
  const applicability = validateApplicability(node.applicability, `${path}.applicability`);
  const allowedMutations = validateMutations(node.allowedMutations, `${path}.allowedMutations`);
  const evidence = exact(node.evidence, ['schema', 'required', 'headerSchemaVersion', 'liveReadbackProviders'], `${path}.evidence`);
  requireVersion(evidence.headerSchemaVersion, evidenceHeaderSchemaVersion, `${path}.evidence.headerSchemaVersion`);
  const liveReadbackProviders = stringArray(evidence.liveReadbackProviders, `${path}.evidence.liveReadbackProviders`).map((provider) =>
    enumValue<LiveReadbackProvider>(provider, liveReadbackProviderSet, `${path}.evidence.liveReadbackProviders`)
  );
  if (new Set(liveReadbackProviders).size !== liveReadbackProviders.length) {
    throw new Error(`${path}.evidence.liveReadbackProviders must not contain duplicates.`);
  }
  const approvalGate = exact(node.approvalGate, ['kind', 'required', 'envelopeSchemaVersion'], `${path}.approvalGate`);
  const approvalKind = enumValue<ApprovalGateKind>(
    approvalGate.kind,
    new Set<string>(approvalGateKinds),
    `${path}.approvalGate.kind`
  );
  requireVersion(approvalGate.envelopeSchemaVersion, approvalEnvelopeSchemaVersion, `${path}.approvalGate.envelopeSchemaVersion`);
  const invalidationSet = new Set<string>(invalidationInputKinds);
  const invalidationInputs = stringArray(node.invalidationInputs, `${path}.invalidationInputs`).map((entry) =>
    enumValue<InvalidationInputKind>(entry, invalidationSet, `${path}.invalidationInputs`)
  );
  const rollback = exact(node.rollback, ['kind', 'target', 'description'], `${path}.rollback`);
  const rollbackKind = enumValue<RollbackKind>(rollback.kind, new Set<string>(rollbackKinds), `${path}.rollback.kind`);
  const target = rollback.target === null
    ? null
    : enumValue<PhaseId>(rollback.target, phaseIdSet, `${path}.rollback.target`);
  const terminalStates = stringArray(node.terminalStates, `${path}.terminalStates`).map((state) =>
    enumValue<TerminalPhaseState>(state, terminalPhaseStateSet, `${path}.terminalStates`)
  );
  if (terminalStates.length === 0) {
    throw new Error(`${path}.terminalStates must not be empty.`);
  }
  return {
    id,
    label,
    dependencies,
    applicability,
    allowedMutations,
    evidence: {
      schema: stringField(evidence, 'schema', `${path}.evidence`),
      required: booleanField(evidence, 'required', `${path}.evidence`),
      headerSchemaVersion: evidenceHeaderSchemaVersion,
      liveReadbackProviders
    },
    approvalGate: {
      kind: approvalKind,
      required: booleanField(approvalGate, 'required', `${path}.approvalGate`),
      envelopeSchemaVersion: approvalEnvelopeSchemaVersion
    },
    invalidationInputs,
    rollback: {
      kind: rollbackKind,
      target,
      description: stringField(rollback, 'description', `${path}.rollback`)
    },
    terminalStates
  };
}

function hasDependency(node: PhaseGraphNode, phaseId: PhaseId): boolean {
  return node.dependencies.some((dependency) => dependency.anyOf.includes(phaseId));
}

function assertReachableToFinal(nodes: readonly PhaseGraphNode[]): void {
  const adjacency = new Map<PhaseId, PhaseId[]>();
  for (const id of phaseIds) {
    adjacency.set(id, []);
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      for (const parent of dependency.anyOf) {
        adjacency.get(parent)?.push(node.id);
      }
    }
  }
  for (const start of phaseIds) {
    if (start === 'bootstrap-state-disposed') {
      continue;
    }
    let reachesFinal = false;
    const seen = new Set<PhaseId>();
    const stack: PhaseId[] = [start];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === 'bootstrap-state-disposed') {
        reachesFinal = true;
        break;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      stack.push(...(adjacency.get(id) ?? []));
    }
    if (!reachesFinal) {
      throw new Error(`${start} cannot reach terminal bootstrap-state-disposed.`);
    }
  }
}

export function validateManagedPhaseGraph(value: unknown): ManagedPhaseGraph {
  const graph = exact(value, ['schemaVersion', 'versions', 'phases'], 'phaseGraph');
  requireVersion(graph.schemaVersion, phaseGraphSchemaVersion, 'phaseGraph.schemaVersion');
  const versions = exact(graph.versions, [
    'liftoffVersion',
    'policyVersion',
    'activationContractVersion',
    'phaseGraphSchemaVersion'
  ], 'phaseGraph.versions');
  requireVersion(versions.liftoffVersion, liftoffActivationPackageVersion, 'phaseGraph.versions.liftoffVersion');
  requireVersion(versions.policyVersion, governanceActivationPolicyVersion, 'phaseGraph.versions.policyVersion');
  requireVersion(versions.activationContractVersion, activationContractVersion, 'phaseGraph.versions.activationContractVersion');
  requireVersion(versions.phaseGraphSchemaVersion, phaseGraphSchemaVersion, 'phaseGraph.versions.phaseGraphSchemaVersion');
  if (!Array.isArray(graph.phases)) {
    throw new Error('phaseGraph.phases must be an array.');
  }
  const nodes = graph.phases.map((node, index) => validateNode(node, `phaseGraph.phases[${index}]`));
  if (nodes.length !== phaseIds.length) {
    throw new Error('phaseGraph must declare every canonical phase exactly once.');
  }
  const seen = new Set<PhaseId>();
  for (const [index, node] of nodes.entries()) {
    if (seen.has(node.id)) {
      throw new Error(`Duplicate phase id ${node.id}.`);
    }
    seen.add(node.id);
    if (node.id !== phaseIds[index]) {
      throw new Error(`Phase ${node.id} is not in canonical order at index ${index}.`);
    }
    for (const dependency of node.dependencies) {
      for (const dependencyId of dependency.anyOf) {
        const dependencyIndex = phaseIds.indexOf(dependencyId);
        if (dependencyIndex >= index) {
          throw new Error(`Reversed dependency order: ${node.id} depends on ${dependencyId}.`);
        }
      }
    }
    if (node.rollback.target !== null && phaseIds.indexOf(node.rollback.target) >= index) {
      throw new Error(`Rollback target for ${node.id} must be an earlier phase.`);
    }
    if (node.approvalGate.required && node.approvalGate.kind === 'none') {
      throw new Error(`${node.id} cannot require approval gate none.`);
    }
    if (!node.approvalGate.required && node.approvalGate.kind !== 'none') {
      throw new Error(`${node.id} has a non-none optional approval gate.`);
    }
    const requiredLiveReadbackProviders = [
      ...(node.allowedMutations.remote.some((mutation) => githubRemoteWriteMutations.has(mutation)) ? ['github'] as const : []),
      ...(node.allowedMutations.remote.some((mutation) => azureRemoteWriteMutations.has(mutation)) ? ['azure'] as const : [])
    ];
    for (const provider of requiredLiveReadbackProviders) {
      if (!node.evidence.liveReadbackProviders.includes(provider)) {
        throw new Error(`${node.id} must declare ${provider} live readback proof for remote mutation evidence.`);
      }
    }
    if (requiredLiveReadbackProviders.length === 0 && node.evidence.liveReadbackProviders.length > 0) {
      throw new Error(`${node.id} declares live readback proof without a GitHub or Azure remote mutation.`);
    }
    if (node.applicability.kind === 'conditional') {
      for (const exclusiveId of node.applicability.exclusiveWith) {
        const other = nodes.find((candidate) => candidate.id === exclusiveId);
        if (!other || other.applicability.kind !== 'conditional') {
          throw new Error(`${node.id} exclusive phase ${exclusiveId} must be conditional.`);
        }
      }
      if (!node.terminalStates.includes('inapplicable')) {
        throw new Error(`${node.id} conditional phase must permit inapplicable terminal state.`);
      }
    }
  }
  for (const id of phaseIds) {
    if (!seen.has(id)) {
      throw new Error(`Missing canonical phase ${id}.`);
    }
  }
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node])) as Record<PhaseId, PhaseGraphNode>;
  if (!hasDependency(byId['bootstrap-local'], 'provider-ready')) {
    throw new Error('bootstrap-local must depend on provider-ready.');
  }
  if (!hasDependency(byId['private-backend-proof'], 'runner-ready')) {
    throw new Error('private-backend-proof must depend on runner-ready.');
  }
  if (!hasDependency(byId['remote-import-verified'], 'private-backend-proof')) {
    throw new Error('remote-import-verified must depend on private-backend-proof.');
  }
  if (!hasDependency(byId['remote-ready'], 'remote-import-verified')) {
    throw new Error('remote-ready must depend on remote-import-verified.');
  }
  const visiting = new Set<PhaseId>();
  const visited = new Set<PhaseId>();
  const visit = (id: PhaseId): void => {
    if (visiting.has(id)) {
      throw new Error(`Cycle detected at ${id}.`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId[id].dependencies) {
      for (const dependencyId of dependency.anyOf) {
        visit(dependencyId);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of phaseIds) {
    visit(id);
  }
  assertReachableToFinal(nodes);
  return {
    schemaVersion: phaseGraphSchemaVersion,
    versions: {
      liftoffVersion: liftoffActivationPackageVersion,
      policyVersion: governanceActivationPolicyVersion,
      activationContractVersion,
      phaseGraphSchemaVersion
    },
    phases: nodes
  };
}

export function assertCanonicalGraphValid(): void {
  validateManagedPhaseGraph(canonicalPhaseGraph);
}

function validateEvidenceReference(value: unknown, path: string): EvidenceReference {
  const reference = exact(value, ['phaseId', 'evidenceId', 'headerDigest', 'result'], path);
  const phaseId = enumValue<PhaseId>(reference.phaseId, phaseIdSet, `${path}.phaseId`);
  const result = enumValue<EvidenceReference['result']>(reference.result, resultStateSet, `${path}.result`);
  const headerDigest = stringField(reference, 'headerDigest', path);
  if (!hex64Pattern.test(headerDigest)) {
    throw new Error(`${path}.headerDigest must be a SHA-256 hex digest.`);
  }
  return {
    phaseId,
    evidenceId: stringField(reference, 'evidenceId', path),
    headerDigest,
    result
  };
}

export function validateUserActivationState(value: unknown): UserActivationState {
  const state = exactWithOptional(value, [
    'schemaVersion',
    'identity',
    'repository',
    'activeChange',
    'applicability',
    'phases',
    'createdAt',
    'updatedAt'
  ], ['bootstrapState'], 'activationState');
  requireVersion(state.schemaVersion, activationStateSchemaVersion, 'activationState.schemaVersion');
  const identity = validateActivationIdentity(state.identity);
  if (identity.phaseGraphHash !== canonicalPhaseGraphHash) {
    throw new Error('activationState.identity.phaseGraphHash does not match canonical graph.');
  }
  const repository = exact(state.repository, ['id', 'name', 'defaultBranch'], 'activationState.repository');
  let activeChange: UserActivationState['activeChange'] = null;
  if (state.activeChange !== null) {
    const change = exact(state.activeChange, ['id', 'kind'], 'activationState.activeChange');
    activeChange = {
      id: stringField(change, 'id', 'activationState.activeChange'),
      kind: enumValue(change.kind, new Set(['openspec', 'spec-kit']), 'activationState.activeChange.kind')
    };
  }
  const applicability = exact(state.applicability, [
    'statePath',
    'privateStagingDast',
    'credentialRequired'
  ], 'activationState.applicability');
  const phases = record(state.phases, 'activationState.phases');
  const phaseStatesById = {} as UserActivationState['phases'];
  for (const id of phaseIds) {
    if (!Object.hasOwn(phases, id)) {
      throw new Error(`activationState.phases.${id} is required.`);
    }
    const phase = exact(phases[id], ['state', 'updatedAt', 'evidence', 'approvals', 'blockers'], `activationState.phases.${id}`);
    const phaseState = enumValue<PhaseState>(phase.state, new Set<string>(phaseStates), `activationState.phases.${id}.state`);
    if (!Array.isArray(phase.evidence) || !Array.isArray(phase.approvals) || !Array.isArray(phase.blockers)) {
      throw new Error(`activationState.phases.${id} evidence, approvals, and blockers must be arrays.`);
    }
    phaseStatesById[id] = {
      state: phaseState,
      updatedAt: stringField(phase, 'updatedAt', `activationState.phases.${id}`),
      evidence: phase.evidence.map((entry, index) =>
        validateEvidenceReference(entry, `activationState.phases.${id}.evidence[${index}]`)
      ),
      approvals: stringArray(phase.approvals, `activationState.phases.${id}.approvals`),
      blockers: stringArray(phase.blockers, `activationState.phases.${id}.blockers`)
    };
  }
  for (const key of Object.keys(phases)) {
    if (!phaseIdSet.has(key)) {
      throw new Error(`activationState.phases.${key} is not a canonical phase.`);
    }
  }
  let bootstrapState: UserActivationState['bootstrapState'];
  if (state.bootstrapState !== undefined) {
    const retention = exactWithOptional(state.bootstrapState, [
      'status',
      'remoteImportEvidenceId',
      'remoteImportEvidenceDigest',
      'retainedAt',
      'disposeAfter',
      'encryptedStatePathParts',
      'encryptionKeyPathParts'
    ], ['disposedAt', 'deletionEvidenceId', 'incompleteCleanup'], 'activationState.bootstrapState');
    const retainedAt = isoTimestamp(retention.retainedAt, 'activationState.bootstrapState.retainedAt');
    const disposeAfter = isoTimestamp(retention.disposeAfter, 'activationState.bootstrapState.disposeAfter');
    if (Date.parse(disposeAfter) - Date.parse(retainedAt) !== 30 * 24 * 60 * 60 * 1000) {
      throw new Error('activationState.bootstrapState.disposeAfter must be exactly 30 days after retainedAt.');
    }
    const status = enumValue<'retained' | 'disposed'>(
      retention.status,
      new Set(['retained', 'disposed']),
      'activationState.bootstrapState.status'
    );
    if (status === 'disposed' && retention.disposedAt === undefined) {
      throw new Error(
        'activationState.bootstrapState.disposedAt is required when status is disposed.'
      );
    }
    bootstrapState = {
      status,
      remoteImportEvidenceId: stringField(retention, 'remoteImportEvidenceId', 'activationState.bootstrapState'),
      remoteImportEvidenceDigest: hexDigest(retention.remoteImportEvidenceDigest, 'activationState.bootstrapState.remoteImportEvidenceDigest'),
      retainedAt,
      disposeAfter,
      encryptedStatePathParts: pathPartsArray(retention.encryptedStatePathParts, 'activationState.bootstrapState.encryptedStatePathParts'),
      encryptionKeyPathParts: pathPartsArray(retention.encryptionKeyPathParts, 'activationState.bootstrapState.encryptionKeyPathParts'),
      ...(retention.disposedAt !== undefined ? { disposedAt: isoTimestamp(retention.disposedAt, 'activationState.bootstrapState.disposedAt') } : {}),
      ...(retention.deletionEvidenceId !== undefined ? { deletionEvidenceId: stringField(retention, 'deletionEvidenceId', 'activationState.bootstrapState') } : {}),
      ...(retention.incompleteCleanup !== undefined ? { incompleteCleanup: stringArray(retention.incompleteCleanup, 'activationState.bootstrapState.incompleteCleanup') } : {})
    };
  }
  return {
    schemaVersion: activationStateSchemaVersion,
    identity,
    repository: {
      id: stringField(repository, 'id', 'activationState.repository'),
      name: stringField(repository, 'name', 'activationState.repository'),
      defaultBranch: stringField(repository, 'defaultBranch', 'activationState.repository')
    },
    activeChange,
    applicability: {
      statePath: enumValue(applicability.statePath, new Set(['existing-private', 'bootstrap-local', 'none']), 'activationState.applicability.statePath'),
      privateStagingDast: booleanField(applicability, 'privateStagingDast', 'activationState.applicability'),
      credentialRequired: booleanField(applicability, 'credentialRequired', 'activationState.applicability')
    },
    ...(bootstrapState ? { bootstrapState } : {}),
    phases: phaseStatesById,
    createdAt: stringField(state, 'createdAt', 'activationState'),
    updatedAt: stringField(state, 'updatedAt', 'activationState')
  };
}

export function validateEvidenceHeader(value: unknown): EvidenceHeader {
  const header = exact(value, [
    'schemaVersion',
    'repositoryId',
    'identity',
    'phaseGraphHash',
    'phaseId',
    'phaseContractDigest',
    'inputDigest',
    'baselineSha',
    'transition',
    'producedAt',
    'producer',
    'result'
  ], 'evidenceHeader');
  requireVersion(header.schemaVersion, evidenceHeaderSchemaVersion, 'evidenceHeader.schemaVersion');
  const identity = validateActivationIdentityShape(header.identity, 'evidenceHeader.identity');
  const phaseGraphHash = hexDigest(header.phaseGraphHash, 'evidenceHeader.phaseGraphHash');
  if (phaseGraphHash !== identity.phaseGraphHash) {
    throw new Error('evidenceHeader.phaseGraphHash must match evidenceHeader.identity.phaseGraphHash.');
  }
  const phaseId = enumValue<PhaseId>(header.phaseId, phaseIdSet, 'evidenceHeader.phaseId');
  const phaseContractDigest = hexDigest(header.phaseContractDigest, 'evidenceHeader.phaseContractDigest');
  const inputDigest = hexDigest(header.inputDigest, 'evidenceHeader.inputDigest');
  const baselineSha = hexDigest(header.baselineSha, 'evidenceHeader.baselineSha');
  const transition = validateEvidenceTransitionIdentity(header.transition, 'evidenceHeader.transition');
  if (transition.phaseId !== phaseId) {
    throw new Error('evidenceHeader.transition.phaseId must match evidenceHeader.phaseId.');
  }
  if (transition.baselineSha !== baselineSha) {
    throw new Error('evidenceHeader.transition.baselineSha must match evidenceHeader.baselineSha.');
  }
  if (transition.inputDigest !== inputDigest) {
    throw new Error('evidenceHeader.transition.inputDigest must match evidenceHeader.inputDigest.');
  }
  return {
    schemaVersion: evidenceHeaderSchemaVersion,
    repositoryId: stringField(header, 'repositoryId', 'evidenceHeader'),
    identity,
    phaseGraphHash,
    phaseId,
    phaseContractDigest,
    inputDigest,
    baselineSha,
    transition,
    producedAt: isoTimestamp(header.producedAt, 'evidenceHeader.producedAt'),
    producer: stringField(header, 'producer', 'evidenceHeader'),
    result: enumValue(header.result, resultStateSet, 'evidenceHeader.result')
  };
}

export function validateLiveReadbackProof(value: unknown): LiveReadbackProof {
  const proof = exact(value, [
    'schemaVersion',
    'repositoryId',
    'identity',
    'phaseGraphHash',
    'phaseId',
    'baselineSha',
    'inputDigest',
    'transition',
    'observedAt',
    'provider',
    'resourceType',
    'resourceId',
    'sourceDigest',
    'readbackDigest',
    'matches'
  ], 'liveReadbackProof');
  requireVersion(proof.schemaVersion, evidenceHeaderSchemaVersion, 'liveReadbackProof.schemaVersion');
  const identity = validateActivationIdentityShape(proof.identity, 'liveReadbackProof.identity');
  const phaseGraphHash = hexDigest(proof.phaseGraphHash, 'liveReadbackProof.phaseGraphHash');
  if (phaseGraphHash !== identity.phaseGraphHash) {
    throw new Error('liveReadbackProof.phaseGraphHash must match liveReadbackProof.identity.phaseGraphHash.');
  }
  const phaseId = enumValue<PhaseId>(proof.phaseId, phaseIdSet, 'liveReadbackProof.phaseId');
  const baselineSha = hexDigest(proof.baselineSha, 'liveReadbackProof.baselineSha');
  const inputDigest = hexDigest(proof.inputDigest, 'liveReadbackProof.inputDigest');
  const transition = validateEvidenceTransitionIdentity(proof.transition, 'liveReadbackProof.transition');
  if (transition.phaseId !== phaseId) {
    throw new Error('liveReadbackProof.transition.phaseId must match liveReadbackProof.phaseId.');
  }
  if (transition.baselineSha !== baselineSha) {
    throw new Error('liveReadbackProof.transition.baselineSha must match liveReadbackProof.baselineSha.');
  }
  if (transition.inputDigest !== inputDigest) {
    throw new Error('liveReadbackProof.transition.inputDigest must match liveReadbackProof.inputDigest.');
  }
  return {
    schemaVersion: evidenceHeaderSchemaVersion,
    repositoryId: stringField(proof, 'repositoryId', 'liveReadbackProof'),
    identity,
    phaseGraphHash,
    phaseId,
    baselineSha,
    inputDigest,
    transition,
    observedAt: isoTimestamp(proof.observedAt, 'liveReadbackProof.observedAt'),
    provider: enumValue(proof.provider, new Set(['github', 'azure']), 'liveReadbackProof.provider'),
    resourceType: stringField(proof, 'resourceType', 'liveReadbackProof'),
    resourceId: stringField(proof, 'resourceId', 'liveReadbackProof'),
    sourceDigest: hexDigest(proof.sourceDigest, 'liveReadbackProof.sourceDigest'),
    readbackDigest: hexDigest(proof.readbackDigest, 'liveReadbackProof.readbackDigest'),
    matches: booleanField(proof, 'matches', 'liveReadbackProof')
  };
}

function validateApprovalResource(value: unknown, path: string): ApprovalEnvelope['resources'][number] {
  const resource = exact(value, ['type', 'identity'], path);
  return {
    type: stringField(resource, 'type', path),
    identity: stringField(resource, 'identity', path)
  };
}

function validateApprovalDestination(value: unknown, path: string): ApprovalEnvelope['destinations'][number] {
  const destination = exact(value, ['type', 'identity', 'repository', 'subscriptionId'], path);
  return {
    type: enumValue(destination.type, new Set(['repository', 'subscription', 'environment', 'tenant', 'local', 'external']), `${path}.type`),
    identity: stringField(destination, 'identity', path),
    repository: destination.repository === null ? null : stringField(destination, 'repository', path),
    subscriptionId: destination.subscriptionId === null ? null : stringField(destination, 'subscriptionId', path)
  };
}

function identityMatches(left: ActivationIdentity, right: ActivationIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateApprovalEnvelope(
  value: unknown,
  options: { expectedIdentity?: ActivationIdentity; now?: Date; requireUnexpired?: boolean } = {}
): ApprovalEnvelope {
  const envelope = exact(value, [
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
  ], 'approvalEnvelope');
  requireVersion(envelope.schemaVersion, approvalEnvelopeSchemaVersion, 'approvalEnvelope.schemaVersion');
  const cost = exact(envelope.costCeiling, [
    'currency',
    'fixedMonthlyCents',
    'usageMonthlyCents'
  ], 'approvalEnvelope.costCeiling');
  const baselineSha = stringField(envelope, 'baselineSha', 'approvalEnvelope');
  const planDigest = stringField(envelope, 'planDigest', 'approvalEnvelope');
  if (!hex64Pattern.test(baselineSha) || !hex64Pattern.test(planDigest)) {
    throw new Error('approvalEnvelope baselineSha and planDigest must be SHA-256 hex digests.');
  }
  const identity = validateActivationIdentity(envelope.identity);
  if (options.expectedIdentity && !identityMatches(identity, options.expectedIdentity)) {
    throw new Error('approvalEnvelope.identity does not match the active activation identity.');
  }
  const expiresAt = isoTimestamp(envelope.expiresAt, 'approvalEnvelope.expiresAt');
  if (options.requireUnexpired) {
    assertTimestampNotExpired(expiresAt, 'approvalEnvelope.expiresAt', options.now ?? new Date());
  }
  const resources = Array.isArray(envelope.resources)
    ? normalizeApprovalResources(envelope.resources.map((entry, index) =>
      validateApprovalResource(entry, `approvalEnvelope.resources[${index}]`)
    ))
    : (() => { throw new Error('approvalEnvelope.resources must be an array.'); })();
  const destinations = Array.isArray(envelope.destinations)
    ? normalizeApprovalDestinations(envelope.destinations.map((entry, index) =>
      validateApprovalDestination(entry, `approvalEnvelope.destinations[${index}]`)
    ))
    : (() => { throw new Error('approvalEnvelope.destinations must be an array.'); })();
  const permissions = normalizeApprovalPermissions(stringArray(envelope.permissions, 'approvalEnvelope.permissions'));
  const policyExceptions = normalizeApprovalPolicyExceptions(stringArray(envelope.policyExceptions, 'approvalEnvelope.policyExceptions'));
  const destructiveScope = normalizeApprovalDestructiveScope(stringArray(envelope.destructiveScope, 'approvalEnvelope.destructiveScope'));
  const costCeiling = normalizeApprovalCostCeiling({
    currency: stringField(cost, 'currency', 'approvalEnvelope.costCeiling'),
    fixedMonthlyCents: integerField(cost, 'fixedMonthlyCents', 'approvalEnvelope.costCeiling'),
    usageMonthlyCents: integerField(cost, 'usageMonthlyCents', 'approvalEnvelope.costCeiling')
  });
  const phaseId = enumValue<PhaseId>(envelope.phaseId, phaseIdSet, 'approvalEnvelope.phaseId');
  const gateKind = enumValue<ApprovalGateKind>(envelope.gateKind, new Set<string>(approvalGateKinds), 'approvalEnvelope.gateKind');
  const expectedGateKind = canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)?.approvalGate.kind;
  if (expectedGateKind !== gateKind) {
    throw new Error(`approvalEnvelope.gateKind ${gateKind} does not match phase ${phaseId} gate ${expectedGateKind}.`);
  }
  return {
    schemaVersion: approvalEnvelopeSchemaVersion,
    id: stringField(envelope, 'id', 'approvalEnvelope'),
    phaseId,
    gateKind,
    identity,
    baselineSha,
    planDigest,
    resources,
    destinations,
    permissions,
    costCeiling,
    policyExceptions,
    destructiveScope,
    expiresAt,
    approvedAt: isoTimestamp(envelope.approvedAt, 'approvalEnvelope.approvedAt'),
    approver: stringField(envelope, 'approver', 'approvalEnvelope')
  };
}

function validateOperationDestination(value: unknown, path: string): TransitionOperationDestination {
  const destination = exactWithOptional(value, ['type', 'identity'], ['pathParts', 'repository', 'subscriptionId', 'ref'], path);
  const normalized: TransitionOperationDestination = {
    type: enumValue(destination.type, new Set(['local', 'repository', 'subscription', 'environment', 'tenant', 'external']), `${path}.type`),
    identity: stringField(destination, 'identity', path),
    ...(destination.pathParts !== undefined ? { pathParts: stringArray(destination.pathParts, `${path}.pathParts`) } : {}),
    ...(destination.repository !== undefined ? { repository: stringField(destination, 'repository', path) } : {}),
    ...(destination.subscriptionId !== undefined ? { subscriptionId: stringField(destination, 'subscriptionId', path) } : {}),
    ...(destination.ref !== undefined ? { ref: stringField(destination, 'ref', path) } : {})
  };
  return normalized;
}

function validateTransitionOperation(value: unknown, path: string): TransitionOperation {
  const operation = exact(value, [
    'adapter',
    'actionId',
    'mutationClass',
    'phaseId',
    'inputs',
    'destination',
    'remote',
    'destructive'
  ], path);
  return {
    adapter: enumValue(operation.adapter, transitionAdapterIds, `${path}.adapter`) as TransitionOperation['adapter'],
    actionId: stringField(operation, 'actionId', path),
    mutationClass: enumValue<MutationClass>(operation.mutationClass, new Set<string>(mutationClasses), `${path}.mutationClass`),
    phaseId: enumValue<PhaseId>(operation.phaseId, phaseIdSet, `${path}.phaseId`),
    inputs: record(operation.inputs, `${path}.inputs`),
    destination: validateOperationDestination(operation.destination, `${path}.destination`),
    remote: booleanField(operation, 'remote', path),
    destructive: booleanField(operation, 'destructive', path)
  };
}

function validateApprovalEvaluation(value: unknown, path: string): ApprovalEvaluation {
  const evaluation = exact(value, [
    'phaseId',
    'gateKind',
    'questionKind',
    'approvalRequired',
    'status',
    'envelopeId',
    'envelopeHash',
    'reasons',
    'expansionReasons'
  ], path);
  const question = evaluation.questionKind === null
    ? null
    : enumValue(evaluation.questionKind, new Set([
      'repository-creation-initial-commit-push',
      'credential-enrollment',
      'billed-infrastructure-policy-exception-cost-ceiling',
      'final-enforcement',
      'destructive-operation',
      'external-blocker'
    ]), `${path}.questionKind`);
  const envelopeHash = evaluation.envelopeHash === null
    ? null
    : hexDigest(evaluation.envelopeHash, `${path}.envelopeHash`);
  return {
    phaseId: enumValue<PhaseId>(evaluation.phaseId, phaseIdSet, `${path}.phaseId`),
    gateKind: enumValue<ApprovalGateKind>(evaluation.gateKind, new Set<string>(approvalGateKinds), `${path}.gateKind`),
    questionKind: question as ApprovalEvaluation['questionKind'],
    approvalRequired: booleanField(evaluation, 'approvalRequired', path),
    status: enumValue(evaluation.status, new Set(['not-required', 'approval-required', 'reused', 'expired', 'invalidated']), `${path}.status`),
    envelopeId: evaluation.envelopeId === null ? null : stringField(evaluation, 'envelopeId', path),
    envelopeHash,
    reasons: stringArray(evaluation.reasons, `${path}.reasons`),
    expansionReasons: stringArray(evaluation.expansionReasons, `${path}.expansionReasons`)
  };
}

function validateRollbackPlan(value: unknown, path: string): TransitionRollbackPlan {
  const rollbackPlan = exact(value, [
    'phaseId',
    'strategy',
    'target',
    'operations',
    'retained',
    'cleanupWarnings'
  ], path);
  return {
    phaseId: enumValue<PhaseId>(rollbackPlan.phaseId, phaseIdSet, `${path}.phaseId`),
    strategy: enumValue<RollbackKind>(rollbackPlan.strategy, new Set<string>(rollbackKinds), `${path}.strategy`),
    target: rollbackPlan.target === null ? null : enumValue<PhaseId>(rollbackPlan.target, phaseIdSet, `${path}.target`),
    operations: Array.isArray(rollbackPlan.operations)
      ? rollbackPlan.operations.map((operation, index) => {
          const validated = validateTransitionOperation(operation, `${path}.operations[${index}]`);
          return {
            adapter: validated.adapter,
            actionId: validated.actionId,
            mutationClass: validated.mutationClass,
            phaseId: validated.phaseId,
            inputs: validated.inputs,
            destination: validated.destination,
            remote: validated.remote,
            destructive: validated.destructive
          };
        })
      : (() => { throw new Error(`${path}.operations must be an array.`); })(),
    retained: stringArray(rollbackPlan.retained, `${path}.retained`),
    cleanupWarnings: stringArray(rollbackPlan.cleanupWarnings, `${path}.cleanupWarnings`)
  };
}

export function validateSavedTransitionPlan(value: unknown): SavedTransitionPlan {
  const plan = exact(value, [
    'schemaVersion',
    'phaseId',
    'createdAt',
    'expiresAt',
    'identity',
    'graphHash',
    'stateHash',
    'baselineDigest',
    'inputDigest',
    'transitionDigest',
    'planDigest',
    'mutationClasses',
    'operations',
    'approval',
    'rollbackPlan',
    'noSecrets'
  ], 'transitionPlan');
  requireVersion(plan.schemaVersion, 1, 'transitionPlan.schemaVersion');
  const identity = validateActivationIdentity(plan.identity);
  const graphHash = hexDigest(plan.graphHash, 'transitionPlan.graphHash');
  if (graphHash !== identity.phaseGraphHash) {
    throw new Error('transitionPlan.graphHash must match identity.phaseGraphHash.');
  }
  const phaseId = enumValue<PhaseId>(plan.phaseId, phaseIdSet, 'transitionPlan.phaseId');
  const mutationClassesValue = exact(plan.mutationClasses, ['local', 'remote'], 'transitionPlan.mutationClasses');
  const approval = exact(plan.approval, [
    'gateKind',
    'required',
    'evaluation',
    'envelopeId',
    'envelopeHash'
  ], 'transitionPlan.approval');
  const operations = Array.isArray(plan.operations)
    ? plan.operations.map((operation, index) => validateTransitionOperation(operation, `transitionPlan.operations[${index}]`))
    : (() => { throw new Error('transitionPlan.operations must be an array.'); })();
  for (const operation of operations) {
    if (operation.phaseId !== phaseId) {
      throw new Error(`transitionPlan operation ${operation.actionId} phaseId must match ${phaseId}.`);
    }
  }
  const evaluation = validateApprovalEvaluation(approval.evaluation, 'transitionPlan.approval.evaluation');
  const envelopeHash = approval.envelopeHash === null
    ? null
    : hexDigest(approval.envelopeHash, 'transitionPlan.approval.envelopeHash');
  return {
    schemaVersion: 1,
    phaseId,
    createdAt: isoTimestamp(plan.createdAt, 'transitionPlan.createdAt'),
    expiresAt: isoTimestamp(plan.expiresAt, 'transitionPlan.expiresAt'),
    identity,
    graphHash,
    stateHash: plan.stateHash === null ? null : hexDigest(plan.stateHash, 'transitionPlan.stateHash'),
    baselineDigest: hexDigest(plan.baselineDigest, 'transitionPlan.baselineDigest'),
    inputDigest: hexDigest(plan.inputDigest, 'transitionPlan.inputDigest'),
    transitionDigest: hexDigest(plan.transitionDigest, 'transitionPlan.transitionDigest'),
    planDigest: hexDigest(plan.planDigest, 'transitionPlan.planDigest'),
    mutationClasses: {
      local: stringArray(mutationClassesValue.local, 'transitionPlan.mutationClasses.local').map((entry) =>
        enumValue<MutationClass>(entry, new Set<string>(mutationClasses), 'transitionPlan.mutationClasses.local')
      ),
      remote: stringArray(mutationClassesValue.remote, 'transitionPlan.mutationClasses.remote').map((entry) =>
        enumValue<MutationClass>(entry, new Set<string>(mutationClasses), 'transitionPlan.mutationClasses.remote')
      )
    },
    operations,
    approval: {
      gateKind: enumValue<ApprovalGateKind>(approval.gateKind, new Set<string>(approvalGateKinds), 'transitionPlan.approval.gateKind'),
      required: booleanField(approval, 'required', 'transitionPlan.approval'),
      evaluation,
      envelopeId: approval.envelopeId === null ? null : stringField(approval, 'envelopeId', 'transitionPlan.approval'),
      envelopeHash
    },
    rollbackPlan: validateRollbackPlan(plan.rollbackPlan, 'transitionPlan.rollbackPlan'),
    noSecrets: plan.noSecrets === true ? true : (() => { throw new Error('transitionPlan.noSecrets must be true.'); })()
  };
}

export function validateSupersessionRecord(value: unknown): SupersessionRecord {
  const supersession = exact(value, [
    'schemaVersion',
    'identity',
    'supersededChangeId',
    'supersedingChangeId',
    'reason',
    'approvedAt',
    'approver'
  ], 'supersession');
  requireVersion(supersession.schemaVersion, supersessionSchemaVersion, 'supersession.schemaVersion');
  return {
    schemaVersion: supersessionSchemaVersion,
    identity: validateActivationIdentity(supersession.identity),
    supersededChangeId: stringField(supersession, 'supersededChangeId', 'supersession'),
    supersedingChangeId: stringField(supersession, 'supersedingChangeId', 'supersession'),
    reason: stringField(supersession, 'reason', 'supersession'),
    approvedAt: stringField(supersession, 'approvedAt', 'supersession'),
    approver: stringField(supersession, 'approver', 'supersession')
  };
}

export function validateGraphReconciliationRecord(
  value: unknown,
  recognizedGraphHashes: ReadonlySet<string> = new Set([canonicalPhaseGraphHash])
): GraphReconciliationRecord {
  const reconciliation = exact(value, [
    'schemaVersion',
    'fromGraphHash',
    'toGraphHash',
    'fromIdentity',
    'toIdentity',
    'phaseMappings',
    'reconciledAt',
    'producer'
  ], 'graphReconciliation');
  requireVersion(reconciliation.schemaVersion, activationStateSchemaVersion, 'graphReconciliation.schemaVersion');
  const fromGraphHash = hexDigest(reconciliation.fromGraphHash, 'graphReconciliation.fromGraphHash');
  const toGraphHash = hexDigest(reconciliation.toGraphHash, 'graphReconciliation.toGraphHash');
  if (!recognizedGraphHashes.has(fromGraphHash)) {
    throw new Error(`graphReconciliation.fromGraphHash is not a recognized graph hash: ${fromGraphHash}.`);
  }
  if (!recognizedGraphHashes.has(toGraphHash)) {
    throw new Error(`graphReconciliation.toGraphHash is not a recognized graph hash: ${toGraphHash}.`);
  }
  const fromIdentity = validateActivationIdentityShape(reconciliation.fromIdentity, 'graphReconciliation.fromIdentity');
  const toIdentity = validateActivationIdentityShape(reconciliation.toIdentity, 'graphReconciliation.toIdentity');
  if (fromIdentity.phaseGraphHash !== fromGraphHash) {
    throw new Error('graphReconciliation.fromIdentity.phaseGraphHash must match fromGraphHash.');
  }
  if (toIdentity.phaseGraphHash !== toGraphHash) {
    throw new Error('graphReconciliation.toIdentity.phaseGraphHash must match toGraphHash.');
  }
  if (!Array.isArray(reconciliation.phaseMappings)) {
    throw new Error('graphReconciliation.phaseMappings must be an array.');
  }
  const seen = new Set<PhaseId>();
  const phaseMappings = reconciliation.phaseMappings.map((entry, index) => {
    const mapping = exact(entry, [
      'phaseId',
      'fromContractDigest',
      'toContractDigest',
      'preserveEvidence'
    ], `graphReconciliation.phaseMappings[${index}]`);
    const phaseId = enumValue<PhaseId>(mapping.phaseId, phaseIdSet, `graphReconciliation.phaseMappings[${index}].phaseId`);
    if (seen.has(phaseId)) {
      throw new Error(`graphReconciliation.phaseMappings contains duplicate phase ${phaseId}.`);
    }
    seen.add(phaseId);
    const fromContractDigest = hexDigest(
      mapping.fromContractDigest,
      `graphReconciliation.phaseMappings[${index}].fromContractDigest`
    );
    const toContractDigest = hexDigest(
      mapping.toContractDigest,
      `graphReconciliation.phaseMappings[${index}].toContractDigest`
    );
    const preserveEvidence = booleanField(
      mapping,
      'preserveEvidence',
      `graphReconciliation.phaseMappings[${index}]`
    );
    if (preserveEvidence && fromContractDigest !== toContractDigest) {
      throw new Error(`graphReconciliation.phaseMappings[${index}] cannot preserve evidence for changed phase ${phaseId}.`);
    }
    return {
      phaseId,
      fromContractDigest,
      toContractDigest,
      preserveEvidence
    };
  });
  for (const phaseId of phaseIds) {
    if (!seen.has(phaseId)) {
      throw new Error(`graphReconciliation.phaseMappings.${phaseId} is required.`);
    }
  }
  return {
    schemaVersion: activationStateSchemaVersion,
    fromGraphHash,
    toGraphHash,
    fromIdentity,
    toIdentity,
    phaseMappings,
    reconciledAt: isoTimestamp(reconciliation.reconciledAt, 'graphReconciliation.reconciledAt'),
    producer: stringField(reconciliation, 'producer', 'graphReconciliation')
  };
}

export function validateCredentialPolicy(value: unknown): CredentialPolicy {
  const policy = exact(value, [
    'schemaVersion',
    'identity',
    'repository',
    'owner',
    'authKind',
    'displayNameTemplate',
    'displayName',
    'secretName',
    'createdAt',
    'expiresAt',
    'rotationLeadDays',
    'rotationDueAt',
    'permissions',
    'allowedWorkflows',
    'nonForwarding',
    'status',
    'proof',
    'app',
    'pat'
  ], 'credentialPolicy');
  requireVersion(policy.schemaVersion, credentialPolicySchemaVersion, 'credentialPolicy.schemaVersion');
  const permissions = exact(policy.permissions, ['repository', 'organization'], 'credentialPolicy.permissions');
  if (policy.nonForwarding !== true) {
    throw new Error('credentialPolicy.nonForwarding must be true.');
  }
  if (policy.secretName !== runnerPreflightSecretName) {
    throw new Error(`credentialPolicy.secretName must be ${runnerPreflightSecretName}.`);
  }
  if (policy.displayNameTemplate !== runnerPreflightDisplayNameTemplate) {
    throw new Error(`credentialPolicy.displayNameTemplate must be ${runnerPreflightDisplayNameTemplate}.`);
  }
  if (!Array.isArray(policy.allowedWorkflows)) {
    throw new Error('credentialPolicy.allowedWorkflows must be an array.');
  }
  if (policy.allowedWorkflows.length === 0) {
    throw new Error('credentialPolicy.allowedWorkflows must contain at least one workflow.');
  }
  const repository = validateCredentialRepositoryIdentity(policy.repository, 'credentialPolicy.repository');
  if (policy.owner !== repository.owner) {
    throw new Error('credentialPolicy.owner must match credentialPolicy.repository.owner.');
  }
  const displayName = stringField(policy, 'displayName', 'credentialPolicy');
  if (displayName !== `${repository.name.toLowerCase()}-runner-preflight-read`) {
    throw new Error('credentialPolicy.displayName must be derived from the canonical repository name.');
  }
  const createdAt = isoTimestamp(policy.createdAt, 'credentialPolicy.createdAt');
  const expiresAt = isoTimestamp(policy.expiresAt, 'credentialPolicy.expiresAt');
  const rotationLeadDays = integerField(policy, 'rotationLeadDays', 'credentialPolicy');
  requireVersion(rotationLeadDays, runnerPreflightRotationLeadDays, 'credentialPolicy.rotationLeadDays');
  const rotationDueAt = isoTimestamp(policy.rotationDueAt, 'credentialPolicy.rotationDueAt');
  if (rotationDueAt !== addDaysIso(expiresAt, -runnerPreflightRotationLeadDays)) {
    throw new Error('credentialPolicy.rotationDueAt must equal expiresAt minus the rotation lead.');
  }
  const repositoryPermissions = stringArray(permissions.repository, 'credentialPolicy.permissions.repository');
  const organizationPermissions = stringArray(permissions.organization, 'credentialPolicy.permissions.organization');
  assertNoDuplicateStrings(repositoryPermissions, 'credentialPolicy.permissions.repository');
  assertNoDuplicateStrings(organizationPermissions, 'credentialPolicy.permissions.organization');
  exactStringSet(repositoryPermissions, runnerPreflightRepositoryPermissions, 'credentialPolicy.permissions.repository');
  exactStringSet(organizationPermissions, runnerPreflightOrganizationPermissions, 'credentialPolicy.permissions.organization');
  const authKind = enumValue<'github-app' | 'fine-grained-pat'>(
    policy.authKind,
    new Set(['github-app', 'fine-grained-pat']),
    'credentialPolicy.authKind'
  );
  const proof = exact(policy.proof, ['verifiedAt', 'readbackDigest', 'readbackProvider', 'payloadFree'], 'credentialPolicy.proof');
  if (proof.payloadFree !== true) {
    throw new Error('credentialPolicy.proof.payloadFree must be true.');
  }
  const app = policy.app === null
    ? null
    : exact(policy.app, [
        'installationId',
        'appSlug',
        'selection',
        'repositoryFullName',
        'permissionsVerifiedAt',
        'token'
      ], 'credentialPolicy.app');
  const pat = policy.pat === null
    ? null
    : exact(policy.pat, [
        'lifetimeDays',
        'selectedRepositoryOnly',
        'createdBy'
      ], 'credentialPolicy.pat');
  if (authKind === 'github-app') {
    if (app === null || pat !== null) {
      throw new Error('credentialPolicy.github-app requires app metadata and no PAT metadata.');
    }
    if (integerField(app, 'installationId', 'credentialPolicy.app') <= 0) {
      throw new Error('credentialPolicy.app.installationId must be positive.');
    }
    if (app.selection !== 'selected-repository') {
      throw new Error('credentialPolicy.app.selection must be selected-repository.');
    }
    if (stringField(app, 'repositoryFullName', 'credentialPolicy.app') !== repository.fullName) {
      throw new Error('credentialPolicy.app.repositoryFullName must match the policy repository.');
    }
  } else {
    if (pat === null || app !== null) {
      throw new Error('credentialPolicy.fine-grained-pat requires PAT metadata and no App metadata.');
    }
    requireVersion(pat.lifetimeDays, runnerPreflightPatLifetimeDays, 'credentialPolicy.pat.lifetimeDays');
    if (dateDaysBetween(createdAt, expiresAt) !== runnerPreflightPatLifetimeDays) {
      throw new Error('credentialPolicy fine-grained PAT expiry must be exactly 30 days after creation.');
    }
    if (pat.selectedRepositoryOnly !== true) {
      throw new Error('credentialPolicy.pat.selectedRepositoryOnly must be true.');
    }
    if (pat.createdBy !== 'manual-masked-entry') {
      throw new Error('credentialPolicy.pat.createdBy must be manual-masked-entry.');
    }
  }
  const typedApp = app === null
    ? null
    : {
        installationId: integerField(app, 'installationId', 'credentialPolicy.app'),
        appSlug: stringField(app, 'appSlug', 'credentialPolicy.app'),
        selection: enumValue<'selected-repository'>(app.selection, new Set(['selected-repository']), 'credentialPolicy.app.selection'),
        repositoryFullName: stringField(app, 'repositoryFullName', 'credentialPolicy.app'),
        permissionsVerifiedAt: isoTimestamp(app.permissionsVerifiedAt, 'credentialPolicy.app.permissionsVerifiedAt'),
        token: (() => {
          const token = exact(app.token, ['strategy', 'ttlSeconds', 'generatedBy'], 'credentialPolicy.app.token');
          const ttlSeconds = integerField(token, 'ttlSeconds', 'credentialPolicy.app.token');
          if (ttlSeconds <= 0 || ttlSeconds > 3600) {
            throw new Error('credentialPolicy.app.token.ttlSeconds must be between 1 and 3600.');
          }
          return {
            strategy: enumValue<'installation-token'>(token.strategy, new Set(['installation-token']), 'credentialPolicy.app.token.strategy'),
            ttlSeconds,
            generatedBy: enumValue<'github-app'>(token.generatedBy, new Set(['github-app']), 'credentialPolicy.app.token.generatedBy')
          };
        })()
      };
  return {
    schemaVersion: credentialPolicySchemaVersion,
    identity: validateActivationIdentity(policy.identity),
    repository,
    owner: stringField(policy, 'owner', 'credentialPolicy'),
    authKind,
    displayNameTemplate: runnerPreflightDisplayNameTemplate,
    displayName,
    secretName: runnerPreflightSecretName,
    createdAt,
    expiresAt,
    rotationLeadDays: runnerPreflightRotationLeadDays,
    rotationDueAt,
    permissions: {
      repository: [...runnerPreflightRepositoryPermissions],
      organization: [...runnerPreflightOrganizationPermissions]
    },
    allowedWorkflows: (() => {
      const workflowPaths = new Set<string>();
      return policy.allowedWorkflows.map((entry, index) => {
      const workflow = exact(entry, ['path', 'jobs'], `credentialPolicy.allowedWorkflows[${index}]`);
      const jobs = stringArray(workflow.jobs, `credentialPolicy.allowedWorkflows[${index}].jobs`);
      if (jobs.length === 0) {
        throw new Error(`credentialPolicy.allowedWorkflows[${index}].jobs must contain at least one job.`);
      }
      assertNoDuplicateStrings(jobs, `credentialPolicy.allowedWorkflows[${index}].jobs`);
      const workflowPath = stringField(workflow, 'path', `credentialPolicy.allowedWorkflows[${index}]`);
      if (!workflowPath.startsWith('.github/workflows/')) {
        throw new Error(`credentialPolicy.allowedWorkflows[${index}].path must be a GitHub Actions workflow path.`);
      }
      if (workflowPaths.has(workflowPath)) {
        throw new Error(`credentialPolicy.allowedWorkflows contains duplicate workflow ${workflowPath}.`);
      }
      workflowPaths.add(workflowPath);
      return {
        path: workflowPath,
        jobs
      };
      });
    })(),
    nonForwarding: true,
    status: enumValue(policy.status, new Set(['active', 'expiring', 'expired', 'compromised']), 'credentialPolicy.status'),
    proof: {
      verifiedAt: isoTimestamp(proof.verifiedAt, 'credentialPolicy.proof.verifiedAt'),
      readbackDigest: hexDigest(proof.readbackDigest, 'credentialPolicy.proof.readbackDigest'),
      readbackProvider: enumValue(proof.readbackProvider, new Set(['github-api', 'adapter-fixture']), 'credentialPolicy.proof.readbackProvider'),
      payloadFree: true
    },
    app: typedApp,
    pat: pat === null
      ? null
      : {
          lifetimeDays: runnerPreflightPatLifetimeDays,
          selectedRepositoryOnly: true,
          createdBy: 'manual-masked-entry'
        }
  };
}

export function validFixtureIdentity(): ActivationIdentity {
  return currentActivationIdentity;
}
