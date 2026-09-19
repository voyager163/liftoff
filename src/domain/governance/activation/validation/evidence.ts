import { evidenceHeaderSchemaVersion } from '../../policy/identity.js';
import type { EvidenceHeader, GovernanceScope, LiveReadbackProof, PhaseId } from '../types.js';
import { phaseScope } from '../types.js';
import { phaseIdSet, resultStateSet, exact, exactWithOptional, stringField, booleanField, enumValue, requireVersion, hexDigest, isoTimestamp } from './common.js';
import { validateActivationIdentity } from './identity.js';
import { validateFileChanges, validateGitInput, validateEvidenceTransitionIdentity } from './bindings.js';

export function validateEvidenceHeader(value: unknown): EvidenceHeader {
  const header = exactWithOptional(value, [
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
    'bodyDigest',
    'result'
  ], ['remoteBindingDigest', 'scope', 'inputBindings'], 'evidenceHeader');
  requireVersion(header.schemaVersion, evidenceHeaderSchemaVersion, 'evidenceHeader.schemaVersion');
  const identity = validateActivationIdentity(header.identity);
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
  let inputBindings: EvidenceHeader['inputBindings'];
  if (header.inputBindings !== undefined) {
    const bindings = exactWithOptional(header.inputBindings, ['beforeDigest', 'afterDigest', 'files'], ['git'], 'evidenceHeader.inputBindings');
    const git = bindings.git === undefined ? undefined : exact(bindings.git, ['before', 'after'], 'evidenceHeader.inputBindings.git');
    inputBindings = {
      beforeDigest: hexDigest(bindings.beforeDigest, 'evidenceHeader.inputBindings.beforeDigest'),
      afterDigest: hexDigest(bindings.afterDigest, 'evidenceHeader.inputBindings.afterDigest'),
      files: validateFileChanges(bindings.files, 'evidenceHeader.inputBindings.files'),
      ...(git ? { git: {
        before: validateGitInput(git.before, 'evidenceHeader.inputBindings.git.before'),
        after: validateGitInput(git.after, 'evidenceHeader.inputBindings.git.after')
      } } : {})
    };
    if (inputBindings.beforeDigest !== transition.inputDigest || inputBindings.afterDigest !== inputDigest) {
      throw new Error('evidenceHeader.inputBindings must bind the reviewed before-input and observed after-input.');
    }
    if (inputBindings.beforeDigest !== inputBindings.afterDigest && !inputBindings.git &&
      !inputBindings.files.some((file) => file.beforeHash !== file.afterHash)) {
      throw new Error('Changed phase inputs require a concrete reviewed file or Git transition binding.');
    }
  }
  if (!inputBindings && transition.inputDigest !== inputDigest) {
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
    bodyDigest: hexDigest(header.bodyDigest, 'evidenceHeader.bodyDigest'),
    ...(header.remoteBindingDigest !== undefined ? {
      remoteBindingDigest: hexDigest(header.remoteBindingDigest, 'evidenceHeader.remoteBindingDigest')
    } : {}),
    ...(header.scope === undefined ? {} : {
      scope: enumValue<GovernanceScope>(header.scope, new Set([phaseScope(phaseId)]), 'evidenceHeader.scope')
    }),
    ...(inputBindings ? { inputBindings } : {}),
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
  const identity = validateActivationIdentity(proof.identity);
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
