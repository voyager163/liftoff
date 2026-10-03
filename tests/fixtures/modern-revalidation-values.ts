import path from 'node:path';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import {
  localRevalidationPolicy, revalidationPhaseIds, revalidationPublicationFingerprint,
  type LocalRevalidationIntent, type LocalRevalidationResult, type LocalRevalidationConsent,
  type LocalRevalidationState, type LocalRevalidationTarget
} from '../../src/domain/governance/activation/modern-revalidation-publication.js';

export const h = (letter = 'a') => letter.repeat(64), root = path.resolve('wire-only-no-project');
export const at = (offset: number) => new Date(Date.parse('2026-10-01T12:00:00.000Z') + offset).toISOString();
export const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
export function resignIntent(value: LocalRevalidationIntent) {
  const { fingerprint: _old, ...body } = value;
  return { ...body, fingerprint: canonicalSha256(body) };
}
export function resignResult(value: LocalRevalidationResult) {
  const { publicationFingerprint: _old, resultDigest: _digest, ...body } = value;
  const result = { ...body, targetSetDigest: canonicalSha256(body.targets) };
  const published = { ...result, publicationFingerprint: revalidationPublicationFingerprint(result) };
  return { ...published, resultDigest: canonicalSha256(published) };
}

// Wire fixtures establish decoder/coordinator behavior, never native execution or publication proof.
export function fixture(complete = true, projectRoot = root) {
  const intent = resignIntent({
    kind: 'liftoff-local-revalidation-preview', schemaVersion: 1, operationKind: 'revalidate-successor', projectRoot,
    operationId: id('1'), createdAt: at(0), expiresAt: at(900000), fingerprint: h(), sourceBinding: h('b'), sourcePlanFingerprint: h('c'),
    originalTransitionDigest: h('d'), originalPreparationDigest: h('e'), protectedSetDigest: h('f'), policyDigest: canonicalSha256(localRevalidationPolicy),
    execution: {
      projectRoot, rootIdentity: '1:2:3:4:5:6:7:8', operationId: id('2'), executionFingerprint: h(), previewDigest: h(), consentDigest: h(),
      stateDigest: h(), resultDigest: h(), installedBinding: h(), observationDigest: h(), physicalDigest: h(), baselineDigest: h(), recipeDigest: h(),
      policyDigest: h(), toolSetDigest: h(), preparationDigest: h(), outputRolesDigest: h(), checkSetDigest: h(), selectedPlanDigest: h(),
      startedAt: at(-10000), completedAt: at(-1000)
    }
  });
  const phases: LocalRevalidationResult['phases'] = revalidationPhaseIds.map((phaseId, index) => ({
    phaseId, status: index === 2 && !complete ? 'blocked' : 'complete',
    evidenceId: index === 2 && !complete ? null : id(String(index + 3)), blockers: index === 2 && !complete ? ['Incomplete framework source.'] : []
  }));
  const targets: LocalRevalidationTarget[] = [];
  for (const [index, prefix] of (['input', 'baseline', 'completion'] as const).entries()) {
    for (const kind of ['plan', 'evidence'] as const) {
      if (kind === 'evidence' && phases[index].status === 'blocked') continue;
      targets.push({ pathParts: ['governance', `${kind}s`.replace('evidences', 'evidence'), `${kind === 'plan' ? h(String(index + 1)) : phases[index].evidenceId}.json`],
        operation: 'write', original: { exists: false, rawDigest: null, bytes: 0, mode: null },
        target: { exists: true, rawDigest: h(), bytes: 2, mode: 0o600 }, artifactKey: h(), purpose: `${prefix}-${kind}` });
    }
  }
  for (const purpose of ['state', 'migration-journal'] as const) targets.push({
    pathParts: ['governance', purpose === 'state' ? 'activation-state.json' : 'migration-state.json'], purpose, operation: 'write',
    original: { exists: true, rawDigest: h('b'), bytes: 1, mode: 0o600 }, target: { exists: true, rawDigest: h(), bytes: 2, mode: 0o600 }, artifactKey: h()
  });
  const result = resignResult({
    kind: 'liftoff-local-revalidation-result', schemaVersion: 1, projectRoot, operationId: intent.operationId, fingerprint: intent.fingerprint,
    execution: intent.execution, originalTransitionDigest: intent.originalTransitionDigest, originalPreparationDigest: intent.originalPreparationDigest,
    startedAt: at(0), completedAt: at(1000), protectedIndexKey: h(), protectedSetDigest: intent.protectedSetDigest, phases, targets,
    targetSetDigest: h(), candidateBinding: h(), candidateSize: { kind: 'journal', mutationCount: targets.length, suppliedPreconditionCount: 12,
      snapshotBytes: 40, headerBytes: 40, mutationFrameBytes: 100, commitFrameBytes: 1, completeJournalBytes: 200 },
    reviewCreatedAt: at(2000), reviewExpiresAt: at(902000), publicationFingerprint: h(), resultDigest: h()
  });
  const consent: LocalRevalidationConsent = {
    kind: 'liftoff-local-revalidation-publication-consent', schemaVersion: 1, projectRoot, intentFingerprint: intent.fingerprint,
    resultDigest: result.resultDigest, publicationFingerprint: result.publicationFingerprint, candidateBinding: result.candidateBinding,
    targetSetDigest: result.targetSetDigest, executionConsentDigest: result.execution.consentDigest, executionResultDigest: result.execution.resultDigest,
    approvedAt: at(3000), expiresAt: result.reviewExpiresAt, scopes: { publishLocalRecords: true, workflowWrites: false, projectCode: false,
      dependencyPreparation: false, dependencyNetwork: false, protectedStateAccess: false, providerAccess: false }
  };
  const state: LocalRevalidationState = {
    kind: 'liftoff-local-revalidation-state', schemaVersion: 1, projectRoot, operationId: intent.operationId, intentFingerprint: intent.fingerprint,
    publicationFingerprint: result.publicationFingerprint, candidateBinding: result.candidateBinding, ownerTokenDigest: h(),
    phase: complete ? 'complete' : 'incomplete', startedAt: at(4000), updatedAt: at(6000), transactionDigest: h('b'),
    commitObservation: { publicationFingerprint: result.publicationFingerprint, transactionDigest: h('b'), observedAt: at(5000),
      source: 'local-verification-inspector', committed: true }, readbackDigest: h('c'), cleanupPending: false
  };
  return { intent, result, consent, state };
}
