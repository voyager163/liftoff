import type { ManifestContractContext } from '../domain/project/manifest/context.js';
import type { ManifestSourceHistoryReference } from '../domain/project/manifest/history.js';
import type { ModernActivationSourceInput, ModernActivationState, ModernPhaseId, ReadableModernActivationIdentity } from '../domain/governance/activation/modern-record-contracts.js';
import { createModernActivationRecordContract, type ModernRelatedRecords } from '../domain/governance/activation/modern-records.js';
import { createModernActivationIdentityReader } from '../domain/governance/activation/modern-identity.js';
import { freezeModernValue, modernPhaseContractDigests } from '../domain/governance/activation/modern-graph.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { assertModernRecordData } from '../domain/governance/activation/source-values.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity, releasedV3ActivationIdentity,
  isHistoricalV1ActivationIdentity, isHistoricalV2ActivationIdentity, isReleasedV3ActivationIdentity, type ReleasedActivationIdentity,
  modernActivationSourceContracts } from '../domain/governance/policy/identity.js';
import {
  historyArray, historyDigest, historyEnum, historyExact, historyFail, historyLiteral,
  historyRecordId, historyString, historyStrings, historyTimestamp
} from './history-contracts.js';
import { historicalV1PhaseContractDigests } from './historical-v1-phase-contracts.js';
import { historicalV2PhaseContractDigest } from './historical-v2.js';
import { historicalV3PhaseContractDigest, historicalV3PhaseGraph } from './historical-v3.js';

export const modernLocalRevalidationPhases = ['local-inputs-valid', 'local-baseline-verified', 'local-complete'] as const;
export type ModernSuccessorLane = 'activation-v1-to-v4' | 'activation-v2-to-v4' | 'activation-v3-to-v4';
export interface SuccessorPreparationV1 {
  readonly schemaVersion: 1;
  readonly preparationId: string;
  readonly preparedAt: string;
  readonly localRepositoryId: string;
}
export interface ModernSemanticTransitionInput {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-activation-semantic-transition';
  readonly laneId: ModernSuccessorLane;
  readonly sourceIdentity: ReleasedActivationIdentity;
  readonly targetIdentity: ReadableModernActivationIdentity;
  readonly history: { readonly snapshotId: string; readonly historyIndexPathParts: readonly string[]; readonly historyIndexDigest: string };
  readonly targetManifestDigest: string;
  readonly sourceGraphHash: string;
  readonly targetGraphHash: string;
  readonly phaseMappingDigest: string;
  readonly transitionPolicyDigest: string;
}
export interface ModernMigrationJournalV2 {
  readonly schemaVersion: 2;
  readonly semanticInput: ModernSemanticTransitionInput;
  readonly semanticTransitionDigest: string;
  readonly preparation: SuccessorPreparationV1;
  readonly successor: { readonly repositoryId: string; readonly createdAt: string };
  readonly revalidation: {
    readonly status: 'pending' | 'running' | 'blocked' | 'complete';
    readonly updatedAt: string;
    readonly phases: readonly {
      readonly phaseId: typeof modernLocalRevalidationPhases[number];
      readonly status: 'pending' | 'running' | 'blocked' | 'complete';
      readonly evidenceIds: readonly string[];
      readonly blockers: readonly string[];
    }[];
    readonly nextAction: string | null;
  };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function isProtectedSourceAnchor(value: string): boolean {
  return value.startsWith('local:') && uuid.test(value.slice(6));
}
export function validateSuccessorPreparation(value: unknown, observedAt: string): SuccessorPreparationV1 {
  assertModernRecordData(value, 'successor preparation');
  const item = historyExact(value, ['schemaVersion', 'preparationId', 'preparedAt', 'localRepositoryId'], 'successor preparation');
  historyLiteral(item.schemaVersion, 1, 'preparation.schemaVersion');
  const preparationId = historyString(item.preparationId, 'preparation.preparationId');
  const localRepositoryId = historyString(item.localRepositoryId, 'preparation.localRepositoryId');
  if (!uuid.test(preparationId) || !isProtectedSourceAnchor(localRepositoryId)) historyFail('preparation', 'requires real supplied UUID v4 preparation and local anchor values.');
  const preparedAt = historyTimestamp(item.preparedAt, 'preparation.preparedAt');
  const now = historyTimestamp(observedAt, 'preparation.observedAt');
  if (Date.parse(preparedAt) > Date.parse(now)) historyFail('preparation', 'construction time is in the future.', 'invalid-successor-preparation');
  return Object.freeze({ schemaVersion: 1, preparationId, preparedAt, localRepositoryId });
}
export function releasedSuccessorLane(identity: unknown) {
  assertModernRecordData(identity, 'released source identity');
  if (isHistoricalV1ActivationIdentity(identity)) return { laneId: 'activation-v1-to-v4' as const, sourceIdentity: { ...historicalV1ActivationIdentity } };
  if (isHistoricalV2ActivationIdentity(identity)) return { laneId: 'activation-v2-to-v4' as const, sourceIdentity: { ...historicalV2ActivationIdentity } };
  if (isReleasedV3ActivationIdentity(identity)) return { laneId: 'activation-v3-to-v4' as const, sourceIdentity: { ...releasedV3ActivationIdentity } };
  return historyFail('modern source lane', 'requires an exact released v1/v2/v3 source.', 'unsupported-historical-identity');
}

export function createModernHistoryContract(catalog: ManifestContractContext['catalog'], context: ModernActivationSourceInput) {
  const identity = createModernActivationIdentityReader(catalog).validateReadableModernActivationIdentity(context);
  if (identity.profile !== 'single-maintainer-gitflow' || identity.workflow === 'manual') {
    historyFail('modern successor', 'only same-intent external single-maintainer successors have lanes.', 'unsupported-migration-target');
  }
  const source = modernActivationSourceContracts().find(source => source.identity.phaseGraphHash === identity.phaseGraphHash)!;
  const records = createModernActivationRecordContract(catalog, context);
  const targetDigests = modernPhaseContractDigests(source.graph);
  const policy = freezeModernValue({
    kind: 'preserve-released-activation-source', schemaVersion: 1,
    profile: identity.profile, workflow: identity.workflow, preserve: 'original-bytes-modes-and-lifecycle-times',
    proof: 'source-only-no-inheritance', activeChange: null, remoteAuthority: 'not-inherited',
    anchor: 'preserve-valid-local-otherwise-supplied', revalidation: modernLocalRevalidationPhases
  });
  function mapping(originalIdentity: ReleasedActivationIdentity) {
    const originalPhases = isReleasedV3ActivationIdentity(originalIdentity) ? historicalV3PhaseGraph().phases.map(phase => phase.id) :
      Object.keys(historicalV1PhaseContractDigests) as (keyof typeof historicalV1PhaseContractDigests)[];
    const sources = originalPhases.map(id => {
      const target: ModernPhaseId = id === 'seed-valid' ? 'local-inputs-valid' : id === 'seed-verified' ? 'local-baseline-verified' : id === 'seed-archived' ? 'local-complete' : id;
      return {
        sourcePhaseId: id, sourceContractDigest: isHistoricalV1ActivationIdentity(originalIdentity)
          ? historicalV1PhaseContractDigests[id as keyof typeof historicalV1PhaseContractDigests]
          : isHistoricalV2ActivationIdentity(originalIdentity) ? historicalV2PhaseContractDigest(id) : historicalV3PhaseContractDigest(id),
        targetPhaseId: target, targetContractDigest: targetDigests[target], proofDisposition: 'retain-source-only'
      };
    });
    return freezeModernValue({ source: sources, target: source.graph.phases.map(phase => ({
      phaseId: phase.id, contractDigest: targetDigests[phase.id], initialState: 'pending'
    })) });
  }
  function semanticInput(originalIdentity: unknown, reference: ManifestSourceHistoryReference, targetManifestDigest: string): ModernSemanticTransitionInput {
    assertModernRecordData({ originalIdentity, reference, targetManifestDigest }, 'semantic input');
    const lane = releasedSuccessorLane(originalIdentity);
    if (reference.kind !== 'activation-history') historyFail('successor history', 'requires activation source history.');
    return freezeModernValue({
      schemaVersion: 1, kind: 'liftoff-activation-semantic-transition', ...lane, targetIdentity: identity,
      history: { snapshotId: historyDigest(reference.snapshotId, 'snapshotId'),
        historyIndexPathParts: ['governance', 'history', reference.snapshotId, 'index.json'],
        historyIndexDigest: historyDigest(reference.indexDigest, 'indexDigest') },
      targetManifestDigest: historyDigest(targetManifestDigest, 'targetManifestDigest'),
      sourceGraphHash: lane.sourceIdentity.phaseGraphHash, targetGraphHash: identity.phaseGraphHash,
      phaseMappingDigest: canonicalSha256(mapping(lane.sourceIdentity)), transitionPolicyDigest: canonicalSha256(policy)
    });
  }
  function readSemantic(value: unknown): ModernSemanticTransitionInput {
    assertModernRecordData(value, 'semantic transition');
    const item = historyExact(value, ['schemaVersion', 'kind', 'laneId', 'sourceIdentity', 'targetIdentity', 'history', 'targetManifestDigest',
      'sourceGraphHash', 'targetGraphHash', 'phaseMappingDigest', 'transitionPolicyDigest'], 'semantic transition');
    const history = historyExact(item.history, ['snapshotId', 'historyIndexPathParts', 'historyIndexDigest'], 'semantic history');
    const expected = semanticInput(item.sourceIdentity, { schemaVersion: 1, kind: 'activation-history',
      snapshotId: historyDigest(history.snapshotId, 'snapshotId'), indexDigest: historyDigest(history.historyIndexDigest, 'indexDigest') },
    historyDigest(item.targetManifestDigest, 'targetManifestDigest'));
    if (canonicalSha256(item) !== canonicalSha256(expected)) historyFail('semantic transition', 'does not match its exact source/target graph, mapping and policy.', 'invalid-semantic-transition');
    return expected;
  }
  function readJournal(value: unknown, expected: ModernSemanticTransitionInput, observedAt: string,
    progress?: { state: ModernActivationState; records: ModernRelatedRecords }): ModernMigrationJournalV2 {
    assertModernRecordData(value, 'modern journal');
    const item = historyExact(value, ['schemaVersion', 'semanticInput', 'semanticTransitionDigest', 'preparation', 'successor', 'revalidation'], 'modern journal');
    historyLiteral(item.schemaVersion, 2, 'modern journal.schemaVersion');
    const semantic = readSemantic(item.semanticInput), preparation = validateSuccessorPreparation(item.preparation, observedAt);
    if (canonicalSha256(semantic) !== canonicalSha256(readSemantic(expected)) || item.semanticTransitionDigest !== canonicalSha256(semantic)) {
      historyFail('modern journal', 'semantic T differs from independently supplied original transition.', 'invalid-semantic-transition');
    }
    const successor = historyExact(item.successor, ['repositoryId', 'createdAt'], 'modern journal.successor');
    if (successor.repositoryId !== preparation.localRepositoryId || successor.createdAt !== preparation.preparedAt) {
      historyFail('modern journal.successor', 'must describe actual candidate construction, not commit.');
    }
    const raw = historyExact(item.revalidation, ['status', 'updatedAt', 'phases', 'nextAction'], 'modern revalidation');
    const statuses = ['pending', 'running', 'blocked', 'complete'] as const;
    const status = historyEnum(raw.status, statuses, 'revalidation.status'), updatedAt = historyTimestamp(raw.updatedAt, 'revalidation.updatedAt');
    if (Date.parse(updatedAt) < Date.parse(preparation.preparedAt) || Date.parse(updatedAt) > Date.parse(observedAt)) historyFail('revalidation time', 'is outside the observed construction interval.');
    const phases = historyArray(raw.phases, 'revalidation.phases').map((entry, index) => {
      const phase = historyExact(entry, ['phaseId', 'status', 'evidenceIds', 'blockers'], 'revalidation.phase');
      const phaseId = historyEnum(phase.phaseId, modernLocalRevalidationPhases, 'phaseId');
      if (phaseId !== modernLocalRevalidationPhases[index]) historyFail('revalidation phases', 'must keep the exact local phase order.');
      const status = historyEnum(phase.status, statuses, 'phase.status');
      const evidenceIds = historyStrings(phase.evidenceIds, 'phase.evidenceIds').map(id => historyRecordId(id, 'phase evidence ID'));
      const blockers = historyStrings(phase.blockers, 'phase.blockers');
      if (new Set(evidenceIds).size !== evidenceIds.length || status === 'pending' && (evidenceIds.length || blockers.length) ||
        status === 'complete' && (!evidenceIds.length || blockers.length) || status === 'blocked' && !blockers.length) {
        historyFail('revalidation phase', 'status must retain its actual evidence/blocker distinction.');
      }
      return { phaseId, status, evidenceIds, blockers };
    });
    if (phases.length !== 3 || (status === 'pending' || status === 'complete') && phases.some(phase => phase.status !== status) ||
      (status === 'running' || status === 'blocked') && !phases.some(phase => phase.status === status)) historyFail('revalidation', 'aggregate progress contradicts its phases.');
    const nextAction = raw.nextAction === null ? null : historyString(raw.nextAction, 'revalidation.nextAction');
    if ((status === 'complete') !== (nextAction === null)) historyFail('revalidation', 'next action must distinguish complete/incomplete work.');
    if (status !== 'pending') {
      if (!progress) historyFail('modern progress', 'actual state and records are required; journal data is not proof.');
      assertModernRecordData(progress, 'modern progress');
      historyExact(progress, ['state', 'records'], 'modern progress');
      const state = records.readState(progress.state, progress.records);
      if (state.repository.id !== preparation.localRepositoryId || state.createdAt !== preparation.preparedAt ||
        !state.successorHistory || state.successorHistory.snapshotId !== semantic.history.snapshotId ||
        state.successorHistory.historyIndexDigest !== semantic.history.historyIndexDigest) historyFail('modern progress', 'state does not belong to the constructed successor.');
      const evidence = progress.records.evidence?.map(value => records.readEvidence(value, progress.records)) ?? [];
      for (const phase of phases) for (const id of phase.evidenceIds) {
        const proof = evidence.find(record => record.evidenceId === id);
        if (!proof || proof.header.phaseId !== phase.phaseId || proof.header.repositoryId !== state.repository.id ||
          phase.status === 'complete' && proof.header.result !== 'verified' ||
          !state.phases[phase.phaseId].evidence.some(ref => ref.evidenceId === id && ref.phaseId === phase.phaseId &&
            ref.result === proof.header.result && ref.headerDigest === canonicalSha256(proof.header))) {
          historyFail('modern progress', 'named evidence lacks its actual same-phase state/header relationship.');
        }
      }
    }
    return freezeModernValue({ schemaVersion: 2, semanticInput: semantic, semanticTransitionDigest: canonicalSha256(semantic),
      preparation, successor: { repositoryId: preparation.localRepositoryId, createdAt: preparation.preparedAt },
      revalidation: { status, updatedAt, phases, nextAction } });
  }
  return Object.freeze({ semanticInput, readSemantic, readJournal, mapping, policy });
}
