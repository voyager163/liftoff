import { canonicalPhaseGraphHash } from '../graph.js';
import { activationStateSchemaVersion } from '../../policy/identity.js';
                                                                                                                                                                                                                                    
import { sha256Hex } from '../canonical-json.js';
import { phaseIds, phaseStates } from '../types.js';
import { phaseIdSet, resultStateSet, hex64Pattern, liveReadbackProviderSet, record, exact, exactWithOptional, stringField, booleanField, stringArray, pathPartsArray, safePathParts, publicJson, enumValue, requireVersion, hexDigest, isoTimestamp } from './common.js';
import { validateActivationConfiguration, validateActivationConfigurationBinding } from './configuration.js';
import { validateActivationIdentity } from './identity.js';

export function validateExternalOperation(value         , path        )                         {
  const item = exactWithOptional(value,
    ['provider', 'actionId', 'operationId', 'resourceId', 'startedAt', 'observedAt', 'status'], ['pollUrl', 'planDigest'], path);
  const pollUrl = item.pollUrl === undefined ? undefined : stringField(item, 'pollUrl', path);
  if (pollUrl !== undefined) {
    publicJson(pollUrl, `${path}.pollUrl`);
    const url = new URL(pollUrl);
    if (url.protocol !== 'https:' || !['api.github.com', 'management.azure.com'].includes(url.hostname) ||
      url.username || url.password || url.port) throw new Error(`${path}.pollUrl must be a credential-free supported provider URL.`);
  }
  const startedAt = isoTimestamp(item.startedAt, `${path}.startedAt`);
  const observedAt = isoTimestamp(item.observedAt, `${path}.observedAt`);
  if (Date.parse(observedAt) < Date.parse(startedAt)) throw new Error(`${path}.observedAt must not precede startedAt.`);
  return {
    provider: enumValue(item.provider, liveReadbackProviderSet, `${path}.provider`),
    actionId: stringField(item, 'actionId', path),
    operationId: stringField(item, 'operationId', path),
    resourceId: stringField(item, 'resourceId', path),
    startedAt, observedAt,
    status: enumValue(item.status, new Set(['running', 'completed', 'failed']), `${path}.status`),
    ...(pollUrl ? { pollUrl } : {}),
    ...(item.planDigest === undefined ? {} : { planDigest: hexDigest(item.planDigest, `${path}.planDigest`) })
  };
}

export function validateOutputBindings(value         , path        )                      {
  const outputs = exact(value, ['values', 'resources'], path);
  const values                                                   = {};
  for (const [key, item] of Object.entries(record(publicJson(outputs.values, `${path}.values`), `${path}.values`))) {
    if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && typeof item !== 'number') {
      throw new Error(`${path}.values.${key} must be a public primitive value.`);
    }
    values[key] = item;
  }
  if (!Array.isArray(outputs.resources)) throw new Error(`${path}.resources must be an array.`);
  return {
    values,
    resources: outputs.resources.map((entry, index) => {
      const resource = exact(entry, ['provider', 'resourceType', 'resourceId'], `${path}.resources[${index}]`);
      return {
        provider: enumValue                      (resource.provider, liveReadbackProviderSet, `${path}.resources[${index}].provider`),
        resourceType: stringField(resource, 'resourceType', path),
        resourceId: stringField(resource, 'resourceId', path)
      };
    })
  };
}

export function validateEvidenceReference(value         , path        )                    {
  const reference = exact(value, ['phaseId', 'evidenceId', 'headerDigest', 'result'], path);
  const phaseId = enumValue         (reference.phaseId, phaseIdSet, `${path}.phaseId`);
  const result = enumValue                             (reference.result, resultStateSet, `${path}.result`);
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

export function validateGovernanceTaskProjectionContract(value         )                                   {
  const label = 'taskProjectionContract';
  const raw = record(value, label);
  const source = enumValue                       (raw.source, new Set(['existing', 'create']), `${label}.source`);
  const item = exact(value, [
    'schemaVersion', 'derivation', 'source', 'changeId', 'workflowKind', 'taskPathParts',
    'metadataPathParts', 'metadataHash', 'layoutHash', ...(source === 'create' ? ['template', 'metadataText'] : [])
  ], label);
  requireVersion(item.schemaVersion, 1, `${label}.schemaVersion`);
  if (item.derivation !== 'validated-current-readiness') throw new Error(`${label} requires the bounded current-readiness derivation.`);
  const changeId = stringField(item, 'changeId', label);
  safePathParts([changeId], `${label}.changeId`);
  const workflowKind = enumValue                         (item.workflowKind, new Set(['openspec', 'spec-kit']), `${label}.workflowKind`);
  if (changeId === 'archive' || changeId.startsWith('bootstrap-') || changeId === '000-liftoff-bootstrap') {
    throw new Error(`${label} cannot target seed tasks or an archive.`);
  }
  const base = workflowKind === 'openspec' ? ['openspec', 'changes', changeId] : ['specs', changeId];
  const taskPathParts = safePathParts(item.taskPathParts, `${label}.taskPathParts`);
  const metadataPathParts = safePathParts(item.metadataPathParts, `${label}.metadataPathParts`);
  if (taskPathParts.join('/') !== [...base, 'tasks.md'].join('/') ||
    metadataPathParts.join('/') !== [...base, 'liftoff-governance.json'].join('/')) {
    throw new Error(`${label} must target the exact current governance task and metadata paths.`);
  }
  const common = {
    schemaVersion: 1         , derivation: 'validated-current-readiness'         ,
    changeId, workflowKind, taskPathParts, metadataPathParts,
    metadataHash: hexDigest(item.metadataHash, `${label}.metadataHash`),
    layoutHash: hexDigest(item.layoutHash, `${label}.layoutHash`)
  };
  if (source === 'existing') return { ...common, source };
  const template = stringField(item, 'template', label);
  const metadataText = stringField(item, 'metadataText', label);
  if (template.length > 262_144 || metadataText.length > 262_144 || sha256Hex(metadataText) !== common.metadataHash) {
    throw new Error(`${label} has oversized or inconsistently bound creation sources.`);
  }
  publicJson(template, `${label}.template`);
  publicJson(metadataText, `${label}.metadataText`);
  return { ...common, source, template, metadataText };
}

export function validateGovernanceTaskProjectionRecord(value         )                                 {
  const label = 'taskProjectionRecord';
  const item = exact(value, [
    'schemaVersion', 'purpose', 'phaseId', 'planDigest', 'contractDigest', 'taskPathParts', 'metadataHash',
    'layoutHash', 'status', 'observedAt', 'beforeHash', 'afterHash', 'states', 'blockers'
  ], label);
  requireVersion(item.schemaVersion, 1, `${label}.schemaVersion`);
  if (item.purpose !== 'projection-audit-only') throw new Error(`${label} is not execution authority.`);
  const status = enumValue                        (item.status, new Set(['complete', 'blocked']), `${label}.status`);
  const blockers = stringArray(publicJson(item.blockers, `${label}.blockers`), `${label}.blockers`);
  let states                                           = null;
  if (item.states !== null) {
    const raw = exact(item.states, phaseIds, `${label}.states`);
    states = Object.fromEntries(phaseIds.map((id) => [
      id, enumValue                                      (raw[id], new Set([...phaseStates, 'identity-incompatible']), `${label}.states.${id}`)
    ]))                                                         ;
  }
  const beforeHash = item.beforeHash === null ? null : hexDigest(item.beforeHash, `${label}.beforeHash`);
  const afterHash = item.afterHash === null ? null : hexDigest(item.afterHash, `${label}.afterHash`);
  const taskPathParts = safePathParts(item.taskPathParts, `${label}.taskPathParts`);
  const registered = taskPathParts.length === 4 && taskPathParts[0] === 'openspec' && taskPathParts[1] === 'changes' &&
    taskPathParts[2] !== 'archive' && !taskPathParts[2].startsWith('bootstrap-') ||
    taskPathParts.length === 3 && taskPathParts[0] === 'specs' && taskPathParts[1] !== '000-liftoff-bootstrap';
  if (!registered || taskPathParts.at(-1) !== 'tasks.md') throw new Error(`${label} cannot name an unregistered task destination.`);
  if (status === 'complete' ? states === null || afterHash === null || blockers.length !== 0 :
    states !== null || afterHash !== null || blockers.length === 0) {
    throw new Error(`${label} must distinguish completed projection from blocked, uncommitted task output.`);
  }
  return {
    schemaVersion: 1, purpose: 'projection-audit-only',
    phaseId: enumValue         (item.phaseId, phaseIdSet, `${label}.phaseId`),
    planDigest: hexDigest(item.planDigest, `${label}.planDigest`), contractDigest: hexDigest(item.contractDigest, `${label}.contractDigest`),
    taskPathParts,
    metadataHash: hexDigest(item.metadataHash, `${label}.metadataHash`), layoutHash: hexDigest(item.layoutHash, `${label}.layoutHash`),
    status, observedAt: isoTimestamp(item.observedAt, `${label}.observedAt`), beforeHash, afterHash, states, blockers
  };
}

export function validateUserActivationState(value         )                      {
  const state = exactWithOptional(value, [
    'schemaVersion',
    'identity',
    'repository',
    'activeChange',
    'applicability',
    'phases',
    'createdAt',
    'updatedAt'
  ], ['bootstrapState', 'remoteBinding', 'baselineAnchor', 'activationInputs', 'configurationBinding', 'phaseOutputs', 'successorHistory', 'taskProjection'], 'activationState');
  requireVersion(state.schemaVersion, activationStateSchemaVersion, 'activationState.schemaVersion');
  if (state.configurationBinding !== undefined && state.activationInputs === undefined) {
    throw new Error('Activation state configuration binding requires its exact normalized public configuration.');
  }
  const identity = validateActivationIdentity(state.identity);
  if (identity.phaseGraphHash !== canonicalPhaseGraphHash) {
    throw new Error('activationState.identity.phaseGraphHash does not match canonical graph.');
  }
  const repository = exact(state.repository, ['id', 'name', 'defaultBranch'], 'activationState.repository');
  if (repository.id === 'unbound') throw new Error('Persisted activation state must have an explicitly established immutable local execution anchor.');
  let remoteBinding                                      ;
  if (state.remoteBinding !== undefined) {
    const binding = exact(state.remoteBinding, ['id', 'name', 'defaultBranch', 'pushUrl', 'verifiedAt'], 'activationState.remoteBinding');
    remoteBinding = {
      id: stringField(binding, 'id', 'activationState.remoteBinding'),
      name: stringField(binding, 'name', 'activationState.remoteBinding'),
      defaultBranch: stringField(binding, 'defaultBranch', 'activationState.remoteBinding'),
      pushUrl: stringField(binding, 'pushUrl', 'activationState.remoteBinding'),
      verifiedAt: isoTimestamp(binding.verifiedAt, 'activationState.remoteBinding.verifiedAt')
    };
    const remote = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteBinding.pushUrl);
    if (!remote || remote[1] .toLowerCase() !== remoteBinding.name.toLowerCase()) {
      throw new Error('activationState.remoteBinding must match one credential-free GitHub push destination.');
    }
  }
  let activeChange                                      = null;
  if (state.activeChange !== null) {
    const change = exact(state.activeChange, ['id', 'kind'], 'activationState.activeChange');
    activeChange = {
      id: stringField(change, 'id', 'activationState.activeChange'),
      kind: enumValue(change.kind, new Set(['openspec', 'spec-kit']), 'activationState.activeChange.kind')
    };
  }
  let successorHistory                                         ;
  if (state.successorHistory !== undefined) {
    const history = exact(state.successorHistory, [
      'schemaVersion', 'snapshotId', 'journalPathParts', 'historyIndexPathParts', 'historyIndexDigest', 'sourceActiveChange'
    ], 'activationState.successorHistory');
    requireVersion(history.schemaVersion, 1, 'activationState.successorHistory.schemaVersion');
    const snapshotId = hexDigest(history.snapshotId, 'activationState.successorHistory.snapshotId');
    const journalPath = safePathParts(history.journalPathParts, 'activationState.successorHistory.journalPathParts');
    const indexPath = safePathParts(history.historyIndexPathParts, 'activationState.successorHistory.historyIndexPathParts');
    if (journalPath.join('/') !== 'governance/migration-state.json' ||
      indexPath.join('/') !== `governance/history/${snapshotId}/index.json`) {
      throw new Error('activationState.successorHistory must name its exact registered migration journal and snapshot index.');
    }
    let sourceActiveChange                                                                             = null;
    if (history.sourceActiveChange !== null) {
      const source = exact(history.sourceActiveChange, ['id', 'kind'], 'activationState.successorHistory.sourceActiveChange');
      const id = stringField(source, 'id', 'activationState.successorHistory.sourceActiveChange');
      safePathParts([id], 'activationState.successorHistory.sourceActiveChange.id');
      sourceActiveChange = {
        id, kind: enumValue(source.kind, new Set(['openspec', 'spec-kit']), 'activationState.successorHistory.sourceActiveChange.kind')
      };
    }
    successorHistory = {
      schemaVersion: 1, snapshotId, journalPathParts: ['governance', 'migration-state.json'],
      historyIndexPathParts: indexPath,
      historyIndexDigest: hexDigest(history.historyIndexDigest, 'activationState.successorHistory.historyIndexDigest'),
      sourceActiveChange
    };
  }
  const applicability = exactWithOptional(state.applicability, [
    'statePath',
    'privateStagingDast',
    'credentialRequired'
  ], ['cloudStateRequired', 'privateRunnerRequired'], 'activationState.applicability');
  const phases = record(state.phases, 'activationState.phases');
  const phaseStatesById = {}                                 ;
  for (const id of phaseIds) {
    if (!Object.hasOwn(phases, id)) {
      throw new Error(`activationState.phases.${id} is required.`);
    }
    const phase = exactWithOptional(phases[id], ['state', 'updatedAt', 'evidence', 'approvals', 'blockers'], ['operation', 'executionPlanDigest'], `activationState.phases.${id}`);
    const phaseState = enumValue            (phase.state, new Set        (phaseStates), `activationState.phases.${id}.state`);
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
      blockers: stringArray(phase.blockers, `activationState.phases.${id}.blockers`),
      ...(phase.operation === undefined ? {} : { operation: validateExternalOperation(phase.operation, `activationState.phases.${id}.operation`) }),
      ...(phase.executionPlanDigest === undefined ? {} : { executionPlanDigest: hexDigest(phase.executionPlanDigest, `activationState.phases.${id}.executionPlanDigest`) })
    };
  }
  const phaseOutputs                                                   = {};
  if (state.phaseOutputs !== undefined) {
    for (const [id, outputs] of Object.entries(record(state.phaseOutputs, 'activationState.phaseOutputs'))) {
      phaseOutputs[enumValue         (id, phaseIdSet, 'activationState.phaseOutputs')] =
        validateOutputBindings(outputs, `activationState.phaseOutputs.${id}`);
    }
  }
  for (const key of Object.keys(phases)) {
    if (!phaseIdSet.has(key)) {
      throw new Error(`activationState.phases.${key} is not a canonical phase.`);
    }
  }
  let bootstrapState                                       ;
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
    const status = enumValue                         (
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
      privateStagingDast: applicability.privateStagingDast === 'unknown' ? 'unknown' : booleanField(applicability, 'privateStagingDast', 'activationState.applicability'),
      credentialRequired: applicability.credentialRequired === 'unknown' ? 'unknown' : booleanField(applicability, 'credentialRequired', 'activationState.applicability'),
      ...(applicability.cloudStateRequired === undefined ? {} : {
        cloudStateRequired: applicability.cloudStateRequired === 'unknown' ? 'unknown'          : booleanField(applicability, 'cloudStateRequired', 'activationState.applicability')
      }),
      ...(applicability.privateRunnerRequired === undefined ? {} : {
        privateRunnerRequired: applicability.privateRunnerRequired === 'unknown' ? 'unknown'          : booleanField(applicability, 'privateRunnerRequired', 'activationState.applicability')
      })
    },
    ...(remoteBinding ? { remoteBinding } : {}),
    ...(bootstrapState ? { bootstrapState } : {}),
    ...(state.baselineAnchor === undefined ? {} : { baselineAnchor: hexDigest(state.baselineAnchor, 'activationState.baselineAnchor') }),
    ...(successorHistory ? { successorHistory } : {}),
    ...(state.taskProjection === undefined ? {} : { taskProjection: validateGovernanceTaskProjectionRecord(state.taskProjection) }),
    ...(state.activationInputs === undefined ? {} : { activationInputs: validateActivationConfiguration(state.activationInputs) }),
    ...(state.configurationBinding === undefined ? {} : { configurationBinding: validateActivationConfigurationBinding(state.configurationBinding) }),
    ...(state.phaseOutputs === undefined ? {} : { phaseOutputs }),
    phases: phaseStatesById,
    createdAt: stringField(state, 'createdAt', 'activationState'),
    updatedAt: stringField(state, 'updatedAt', 'activationState')
  };
}
