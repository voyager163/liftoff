import { currentActivationRecordValidators, currentTaskProjectionContract } from './record-validation.js';
import {
  canonicalPhaseGraph,
  currentActivationIdentity
} from './graph.js';
import {
  activationContractVersion,
  approvalEnvelopeSchemaVersion,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  phaseGraphSchemaVersion,
  isHistoricalActivationIdentity,
  type ReadableActivationIdentity
} from '../policy/identity.js';
import type {
  ActivationConfiguration,
  ActivationIdentity,
  ApprovalGateKind,
  InvalidationInputKind,
  LiveReadbackProvider,
  ManagedPhaseGraph,
  MutationClass,
  PhaseGraphNode,
  PhaseId,
  GovernanceTaskProjectionContract,
  RollbackKind,
  TerminalPhaseState
} from './types.js';
import { containsSensitiveText } from '../assessment/sanitize.js';
import type { LiftoffManifest } from '../../project/contracts.js';
import {
  approvalGateKinds,
  governanceScopes,
  invalidationInputKinds,
  mutationClasses,
  phaseIds,
  phaseScope,
  rollbackKinds
} from './types.js';

const recordValidators = currentActivationRecordValidators();
export const {
  validateActivationIdentity, validateActivationConfiguration, validateGovernanceTaskProjectionRecord,
  validateUserActivationState, validateEvidenceHeader, validateLiveReadbackProof, validateApprovalEnvelope,
  validateSavedTransitionPlan, validateSupersessionRecord, validateGraphReconciliationRecord, validateCredentialPolicy
} = recordValidators;
const {
  stringArray, exact, enumValue, stringField, record, requireVersion,
  booleanField, exactStringSet, safePathParts, hexDigest, publicJson
} = recordValidators;

const phaseIdSet = new Set<string>(phaseIds);
const terminalPhaseStateSet = new Set<string>(['approved', 'verified', 'failed', 'inapplicable', 'retained', 'disposed']);
const liveReadbackProviderSet = new Set<string>(['github', 'azure']);
const githubRemoteWriteMutations = new Set<MutationClass>([
  'git-push', 'github-write', 'github-repository-create', 'github-workflow-dispatch',
  'github-secret-write', 'github-ruleset-write'
]);
const azureRemoteWriteMutations = new Set<MutationClass>([
  'azure-provider-register',
  'azure-network-provision',
  'azure-state-import',
  'azure-resource-provision'
]);
const publicCredentialValuePattern =
  /https?:\/\/[^/\s]*@|[?&](?:token|key|secret|sig)=|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;

// The public boundary screens with both the public-JSON value pattern and the shared sensitive-text
// patterns; neither is a complete credential detector.
function publicInputCredentialShaped(text: string): boolean {
  return publicCredentialValuePattern.test(text) || containsSensitiveText(text);
}

function screenPublicPhaseInput(value: unknown, location: string): void {
  if (typeof value === 'string') {
    if (publicInputCredentialShaped(value)) {
      throw new Error(`${location} contains credential material in a nested value; use protected credential enrollment instead.`);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) screenPublicPhaseInput(entry, location);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (publicInputCredentialShaped(key)) {
        throw new Error(`${location} contains credential material in a field name; use protected credential enrollment instead.`);
      }
      screenPublicPhaseInput(entry, location);
    }
  }
}

/**
 * Validates newly supplied public activation inputs. Persisted state and saved plans keep using
 * validateActivationConfiguration, whose acceptance this boundary screen does not change.
 */
export function validatePublicActivationInputs(value: unknown): ActivationConfiguration {
  const configuration = validateActivationConfiguration(value);
  for (const [phaseId, inputs] of Object.entries(configuration.phases)) {
    screenPublicPhaseInput(inputs, `activationInputs.phases.${phaseId}`);
  }
  const strings: ReadonlyArray<readonly [string, string | undefined]> = [
    ['activationInputs.repository.name', configuration.repository?.name],
    ['activationInputs.repository.defaultBranch', configuration.repository?.defaultBranch],
    ['activationInputs.azure.subscriptionId', configuration.azure?.subscriptionId],
    ['activationInputs.azure.tenantId', configuration.azure?.tenantId],
    ['activationInputs.azure.region', configuration.azure?.region],
    ['activationInputs.budget.currency', configuration.budget?.currency]
  ];
  for (const [location, text] of strings) {
    if (text !== undefined && publicInputCredentialShaped(text)) {
      throw new Error(`${location} contains credential material; use protected credential enrollment instead.`);
    }
  }
  return configuration;
}

/** Manifest readability is not execution compatibility; historical vectors are never retagged. */
export function validateReadableActivationIdentity(value: unknown): ReadableActivationIdentity {
  if (isHistoricalActivationIdentity(value)) return { ...value };
  return validateActivationIdentity(value);
}

export function validateManifestActivationForExecution(manifest: Pick<LiftoffManifest, 'governance'>): void {
  const governance = manifest.governance;
  if (governance.profile !== 'none' && governance.profile !== 'unspecified' && governance.activationIdentity !== undefined) {
    validateActivationIdentity(governance.activationIdentity);
  }
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
  const discriminator = enumValue<Extract<PhaseGraphNode['applicability'], { kind: 'conditional' }>['discriminator']>(
    applicability.discriminator,
    new Set(['state-path', 'private-staging-dast', 'credential-required', 'cloud-state-required', 'private-runner-required']),
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
  const graph = exact(value, ['schemaVersion', 'versions', 'phases', 'completionGroups'], 'phaseGraph');
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
  const groups = exact(graph.completionGroups, governanceScopes, 'phaseGraph.completionGroups');
  const completionGroups = {} as ManagedPhaseGraph['completionGroups'];
  for (const scope of governanceScopes) {
    completionGroups[scope] = exactStringSet(
      stringArray(groups[scope], `phaseGraph.completionGroups.${scope}`),
      phaseIds.filter((id) => phaseScope(id) === scope),
      `phaseGraph.completionGroups.${scope}`
    ) as readonly PhaseId[];
  }
  return {
    schemaVersion: phaseGraphSchemaVersion,
    versions: {
      liftoffVersion: liftoffActivationPackageVersion,
      policyVersion: governanceActivationPolicyVersion,
      activationContractVersion,
      phaseGraphSchemaVersion
    },
    phases: nodes,
    completionGroups
  };
}

export function assertCanonicalGraphValid(): void {
  validateManagedPhaseGraph(canonicalPhaseGraph);
}

export function validateGovernanceTaskProjectionContract(value: unknown): GovernanceTaskProjectionContract {
  return currentTaskProjectionContract(value);
}

export function validFixtureIdentity(): ActivationIdentity {
  return currentActivationIdentity;
}
