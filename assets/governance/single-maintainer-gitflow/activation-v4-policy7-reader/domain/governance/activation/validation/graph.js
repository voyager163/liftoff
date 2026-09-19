import { canonicalPhaseGraph } from '../graph.js';
import { activationContractVersion, approvalEnvelopeSchemaVersion, evidenceHeaderSchemaVersion, governanceActivationPolicyVersion, liftoffActivationPackageVersion, phaseGraphSchemaVersion } from '../../policy/identity.js';
                                                                                                                                                                                              
import { approvalGateKinds, governanceScopes, invalidationInputKinds, mutationClasses, phaseIds, phaseInScope, repositoryPhaseIds, rollbackKinds } from '../types.js';
import { phaseIdSet, terminalPhaseStateSet, liveReadbackProviderSet, githubRemoteWriteMutations, azureRemoteWriteMutations, record, exact, stringField, booleanField, stringArray, enumValue, requireVersion, exactStringSet } from './common.js';

export function validateDependency(value         , path        )                                         {
  const dependency = exact(value, ['anyOf', 'accepts', 'description'], path);
  const anyOf = stringArray(dependency.anyOf, `${path}.anyOf`).map((id) =>
    enumValue         (id, phaseIdSet, `${path}.anyOf`)
  );
  if (anyOf.length === 0) {
    throw new Error(`${path}.anyOf must not be empty.`);
  }
  const accepts = stringArray(dependency.accepts, `${path}.accepts`).map((state) =>
    enumValue                    (state, terminalPhaseStateSet, `${path}.accepts`)
  );
  if (accepts.length === 0) {
    throw new Error(`${path}.accepts must not be empty.`);
  }
  return { anyOf, accepts, description: stringField(dependency, 'description', path) };
}

export function validateApplicability(value         , path        )                                  {
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
  const discriminator = enumValue                                                                                    (
    applicability.discriminator,
    new Set(['state-path', 'private-staging-dast', 'credential-required', 'cloud-state-required', 'private-runner-required']),
    `${path}.discriminator`
  );
  const exclusiveWith = stringArray(applicability.exclusiveWith, `${path}.exclusiveWith`).map((id) =>
    enumValue         (id, phaseIdSet, `${path}.exclusiveWith`)
  );
  return {
    kind: 'conditional',
    discriminator,
    when: stringField(applicability, 'when', path),
    inapplicableWhen: stringField(applicability, 'inapplicableWhen', path),
    exclusiveWith
  };
}

export function validateMutations(value         , path        )                                     {
  const mutations = exact(value, ['local', 'remote'], path);
  const mutationSet = new Set        (mutationClasses);
  const local = stringArray(mutations.local, `${path}.local`).map((entry) =>
    enumValue               (entry, mutationSet, `${path}.local`)
  );
  const remote = stringArray(mutations.remote, `${path}.remote`).map((entry) =>
    enumValue               (entry, mutationSet, `${path}.remote`)
  );
  for (const [label, entries] of [['local', local], ['remote', remote]]         ) {
    if (entries.length === 0) {
      throw new Error(`${path}.${label} must not be empty.`);
    }
    if (entries.includes('none') && entries.length > 1) {
      throw new Error(`${path}.${label} cannot combine none with other mutations.`);
    }
  }
  return { local, remote };
}

export function validateNode(value         , path        )                 {
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
  const id = enumValue         (node.id, phaseIdSet, `${path}.id`);
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
    enumValue                      (provider, liveReadbackProviderSet, `${path}.evidence.liveReadbackProviders`)
  );
  if (new Set(liveReadbackProviders).size !== liveReadbackProviders.length) {
    throw new Error(`${path}.evidence.liveReadbackProviders must not contain duplicates.`);
  }
  const approvalGate = exact(node.approvalGate, ['kind', 'required', 'envelopeSchemaVersion'], `${path}.approvalGate`);
  const approvalKind = enumValue                  (
    approvalGate.kind,
    new Set        (approvalGateKinds),
    `${path}.approvalGate.kind`
  );
  requireVersion(approvalGate.envelopeSchemaVersion, approvalEnvelopeSchemaVersion, `${path}.approvalGate.envelopeSchemaVersion`);
  const invalidationSet = new Set        (invalidationInputKinds);
  const invalidationInputs = stringArray(node.invalidationInputs, `${path}.invalidationInputs`).map((entry) =>
    enumValue                       (entry, invalidationSet, `${path}.invalidationInputs`)
  );
  const rollback = exact(node.rollback, ['kind', 'target', 'description'], `${path}.rollback`);
  const rollbackKind = enumValue              (rollback.kind, new Set        (rollbackKinds), `${path}.rollback.kind`);
  const target = rollback.target === null
    ? null
    : enumValue         (rollback.target, phaseIdSet, `${path}.rollback.target`);
  const terminalStates = stringArray(node.terminalStates, `${path}.terminalStates`).map((state) =>
    enumValue                    (state, terminalPhaseStateSet, `${path}.terminalStates`)
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

export function hasDependency(node                , phaseId         )          {
  return node.dependencies.some((dependency) => dependency.anyOf.includes(phaseId));
}

export function assertReachableToFinal(nodes                           )       {
  const adjacency = new Map                    ();
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
    const terminal = (repositoryPhaseIds                      ).includes(start)
      ? 'repository-live-readback' : 'bootstrap-state-disposed';
    if (start === terminal) {
      continue;
    }
    let reachesFinal = false;
    const seen = new Set         ();
    const stack            = [start];
    while (stack.length > 0) {
      const id = stack.pop() ;
      if (id === terminal) {
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
      throw new Error(`${start} cannot reach terminal ${terminal}.`);
    }
  }
}

export function validateManagedPhaseGraph(value         )                    {
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
  const seen = new Set         ();
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
      ...(node.allowedMutations.remote.some((mutation) => githubRemoteWriteMutations.has(mutation)) ? ['github']          : []),
      ...(node.allowedMutations.remote.some((mutation) => azureRemoteWriteMutations.has(mutation)) ? ['azure']          : [])
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
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]))                                   ;
  for (const id of ['repository-workflow-source-ready', 'bootstrap-workflow-source-ready', 'workflow-source-ready']         ) {
    const source = byId[id];
    if (!source.approvalGate.required || source.approvalGate.kind !== 'repository-publish' ||
      !source.evidence.required || !source.evidence.liveReadbackProviders.includes('github') ||
      !(['github-read', 'github-write', 'git-push']         ).every((mutation) => source.allowedMutations.remote.includes(mutation))) {
      throw new Error(`${id} requires exact publication approval and independently observed GitHub source publication.`);
    }
  }
  for (const id of ['repository-rulesets-applied', 'rulesets-applied']         ) {
    const enforcement = byId[id];
    if (!enforcement.approvalGate.required || enforcement.approvalGate.kind !== 'enforcement' ||
      !enforcement.evidence.required || !enforcement.evidence.liveReadbackProviders.includes('github') ||
      !(['github-ruleset-write', 'github-write', 'github-read']         ).every((mutation) => enforcement.allowedMutations.remote.includes(mutation))) {
      throw new Error(`${id} requires its exact enforcement approval and independent readback for owned settings and ruleset mutations.`);
    }
  }
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
  const visiting = new Set         ();
  const visited = new Set         ();
  const visit = (id         )       => {
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
  const completionGroups = {}                                         ;
  for (const scope of governanceScopes) {
    completionGroups[scope] = exactStringSet(
      stringArray(groups[scope], `phaseGraph.completionGroups.${scope}`),
      phaseIds.filter((id) => phaseInScope(id, scope)),
      `phaseGraph.completionGroups.${scope}`
    )                      ;
  }
  for (const node of nodes.filter((node) => (repositoryPhaseIds                      ).includes(node.id))) {
    if (node.dependencies.some((dependency) => dependency.anyOf.some((id) => !phaseInScope(id, 'repository', true))) ||
      node.allowedMutations.remote.some((mutation) => mutation.startsWith('azure-') || mutation.startsWith('backend-state-') || mutation === 'registry-publish') ||
      node.evidence.liveReadbackProviders.includes('azure')) {
      throw new Error(`${node.id} cannot acquire Azure or production dependencies through repository scope.`);
    }
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

export function assertCanonicalGraphValid()       {
  validateManagedPhaseGraph(canonicalPhaseGraph);
}
