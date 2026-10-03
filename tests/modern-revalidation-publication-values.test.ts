import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { rawLocalDigest } from '../src/domain/governance/activation/modern-local-inputs.js';
import {
  localRevalidationPolicy, revalidationPhaseIds, revalidationArtifactBytes,
  validateRevalidationIntent, validateRevalidationResult, validateRevalidationConsent, validateRevalidationState,
  type LocalRevalidationIntent, type LocalRevalidationResult, type LocalRevalidationConsent, type LocalRevalidationState,
  type LocalRevalidationArtifact
} from '../src/domain/governance/activation/modern-revalidation-publication.js';
import { h, root, at, id, resignIntent, resignResult, fixture } from './fixtures/modern-revalidation-values.js';

describe('closed successor revalidation publication values', () => {
  it.each([false, true])('reads complete=%s wire shapes without granting effects', complete => {
    const f = fixture(complete);
    expect(validateRevalidationIntent(f.intent, new Date(at(1)))).toEqual(f.intent);
    expect(validateRevalidationResult(f.result, f.intent)).toEqual(f.result);
    expect(validateRevalidationConsent(f.consent, f.result, new Date(at(4000)))).toEqual(f.consent);
    expect(validateRevalidationState(f.state, f.result)).toEqual(f.state);
    expect(Object.isFrozen(revalidationPhaseIds)).toBe(true);
    expect(Object.isFrozen(localRevalidationPolicy)).toBe(true);
  });

  it.each([
    ['wrong operation', (p: LocalRevalidationIntent) => Reflect.set(p, 'operationKind', 'finalize-local')],
    ['future intent', (p: LocalRevalidationIntent) => { p.createdAt = at(100); }],
    ['expired intent', (p: LocalRevalidationIntent) => { p.expiresAt = at(1); }],
    ['expanded lifetime', (p: LocalRevalidationIntent) => { p.expiresAt = at(900001); }],
    ['changed policy', (p: LocalRevalidationIntent) => { p.policyDigest = h(); }],
    ['foreign native root', (p: LocalRevalidationIntent) => { p.execution.projectRoot = path.resolve('another-wire-project'); }],
    ['native execution after construction', (p: LocalRevalidationIntent) => { p.execution.completedAt = at(100); }],
    ['missing selected plan', (p: LocalRevalidationIntent) => { p.execution.selectedPlanDigest = null; }],
    ['null native commitment', (p: LocalRevalidationIntent) => Reflect.set(p.execution, 'stateDigest', null)],
    ['extra authority', (p: LocalRevalidationIntent) => Reflect.set(p, 'force', true)]
  ] as const)('rejects %s after a caller recalculates the intent hash', (_name, change) => {
    const { intent } = fixture(); change(intent);
    expect(() => validateRevalidationIntent(resignIntent(intent), new Date(at(1)))).toThrow();
  });

  it.each([
    ['phase order', (r: LocalRevalidationResult) => r.phases.reverse()],
    ['incomplete native baseline', (r: LocalRevalidationResult) => Object.assign(r.phases[1], { status: 'blocked', evidenceId: null, blockers: ['failed native check'] })],
    ['complete without proof', (r: LocalRevalidationResult) => { r.phases[0].evidenceId = null; }],
    ['complete with blockers', (r: LocalRevalidationResult) => r.phases[0].blockers.push('blocked')],
    ['foreign transition', (r: LocalRevalidationResult) => { r.originalTransitionDigest = h(); }],
    ['unregistered effect', (r: LocalRevalidationResult) => { r.targets[0].pathParts = ['app.js']; }],
    ['workflow mutation', (r: LocalRevalidationResult) => { r.targets[0].pathParts = ['specs', '000-liftoff-bootstrap', 'tasks.md']; }],
    ['native receipt replacement', (r: LocalRevalidationResult) => { r.targets[0].pathParts = ['.liftoff', 'local-completion.json']; }],
    ['foreign evidence path', (r: LocalRevalidationResult) => { r.targets[1].pathParts[2] = `${id('9')}.json`; }],
    ['immutable overwrite', (r: LocalRevalidationResult) => { r.targets[0].original = { exists: true, rawDigest: h('b'), bytes: 1, mode: 0o600 }; }],
    ['missing prior state', (r: LocalRevalidationResult) => { r.targets.at(-2)!.original = { exists: false, rawDigest: null, bytes: 0, mode: null }; }],
    ['negative zero mode', (r: LocalRevalidationResult) => { r.targets[0].target.mode = -0; }],
    ['duplicate path', (r: LocalRevalidationResult) => { r.targets[2].pathParts = [...r.targets[0].pathParts]; }],
    ['duplicate purpose', (r: LocalRevalidationResult) => { r.targets[1].purpose = r.targets[0].purpose; }],
    ['unmeasured count', (r: LocalRevalidationResult) => { r.candidateSize.mutationCount--; }],
    ['construction after expiration', (r: LocalRevalidationResult) => { r.completedAt = at(900001); }],
    ['review before construction', (r: LocalRevalidationResult) => { r.reviewCreatedAt = at(1); }],
    ['expanded review lifetime', (r: LocalRevalidationResult) => { r.reviewExpiresAt = at(902001); }]
  ] as const)('rejects %s despite renewed result commitments', (_name, change) => {
    const { intent, result } = fixture(); change(result);
    expect(() => validateRevalidationResult(resignResult(result), intent)).toThrow();
  });

  it.each(['workflowWrites', 'projectCode', 'dependencyPreparation', 'dependencyNetwork', 'protectedStateAccess', 'providerAccess'] as const)(
    'never expands publication to %s', field => {
      const { consent, result } = fixture(); Reflect.set(consent.scopes, field, true);
      expect(() => validateRevalidationConsent(consent, result, new Date(at(4000)))).toThrow();
    }
  );
  it.each(['intentFingerprint', 'resultDigest', 'publicationFingerprint', 'candidateBinding', 'targetSetDigest', 'executionConsentDigest', 'executionResultDigest'] as const)(
    'binds exact consent field %s', field => {
      const { consent, result } = fixture(); consent[field] = h('f');
      expect(() => validateRevalidationConsent(consent, result, new Date(at(4000)))).toThrow();
    }
  );
  it('requires explicit publication scope, actual review time and unexpired consent', () => {
    const { consent, result } = fixture();
    expect(() => validateRevalidationConsent({ ...consent, approvedAt: at(1) }, result, new Date(at(4000)))).toThrow();
    expect(() => validateRevalidationConsent(consent, result, new Date(result.reviewExpiresAt))).toThrow();
    Reflect.set(consent.scopes, 'publishLocalRecords', false);
    expect(() => validateRevalidationConsent(consent, result, new Date(at(4000)))).toThrow();
  });

  it.each([
    ['no commit observation', (s: LocalRevalidationState) => { s.commitObservation = null; }],
    ['foreign commit', (s: LocalRevalidationState) => { s.commitObservation!.transactionDigest = h('d'); }],
    ['foreign review', (s: LocalRevalidationState) => { s.commitObservation!.publicationFingerprint = h('d'); }],
    ['not an actual commit', (s: LocalRevalidationState) => Reflect.set(s.commitObservation!, 'committed', false)],
    ['future observation', (s: LocalRevalidationState) => { s.commitObservation!.observedAt = at(7000); }],
    ['cleanup still pending', (s: LocalRevalidationState) => { s.cleanupPending = true; }],
    ['no readback', (s: LocalRevalidationState) => { s.readbackDigest = null; }],
    ['uncommitted readback', (s: LocalRevalidationState) => { s.phase = 'publishing'; s.commitObservation = null; }],
    ['premature completion', (s: LocalRevalidationState) => { s.phase = 'committed-readback-pending'; }],
    ['false incomplete outcome', (s: LocalRevalidationState) => { s.phase = 'incomplete'; }],
    ['rewound progress', (s: LocalRevalidationState) => { s.updatedAt = at(3000); }]
  ] as const)('rejects %s rather than inferring publication success', (_name, change) => {
    const { state, result } = fixture(); change(state);
    expect(() => validateRevalidationState(state, result)).toThrow();
  });
  it('distinguishes prepared and committed-but-unread publication from completion', () => {
    const { state, result } = fixture();
    const prepared = { ...state, phase: 'publishing' as const, commitObservation: null, readbackDigest: null };
    expect(validateRevalidationState(prepared, result)).toEqual(prepared);
    const pending = { ...state, phase: 'committed-readback-pending' as const, readbackDigest: null, cleanupPending: true };
    expect(validateRevalidationState(pending, result)).toEqual(pending);
  });

  it('validates actual artifact bytes and refuses role, mode, length, digest or base64 substitutions', () => {
    const { intent } = fixture(), bytes = Buffer.from('Exact wire-only bytes.\n');
    const artifact: LocalRevalidationArtifact = {
      kind: 'liftoff-local-revalidation-artifact', schemaVersion: 1, projectRoot: root, operationId: intent.operationId,
      intentFingerprint: intent.fingerprint, role: 'target', pathParts: ['governance', 'plans', `${h()}.json`], mode: 0o600,
      contentBase64: bytes.toString('base64'), bytes: bytes.length, rawDigest: rawLocalDigest(bytes)
    };
    expect(revalidationArtifactBytes(artifact, intent)).toEqual(bytes);
    for (const changed of [
      { ...artifact, bytes: bytes.length + 1 }, { ...artifact, rawDigest: h() }, { ...artifact, contentBase64: artifact.contentBase64 + '\n' },
      { ...artifact, mode: -0 }, { ...artifact, mode: 0o1000 }, { ...artifact, operationId: id('9') },
      { ...artifact, role: 'protected-index' as const }
    ]) expect(() => revalidationArtifactBytes(changed, intent)).toThrow();
    expect(revalidationArtifactBytes({ ...artifact, role: 'protected-index', pathParts: null, mode: null }, intent)).toEqual(bytes);
  });

  it('rejects accessors without invoking them and does not retain caller-owned references', () => {
    const { intent, result, consent, state } = fixture(), getter = vi.fn(() => true);
    for (const [value, validate] of [
      [intent, (value: unknown) => Reflect.apply(validateRevalidationIntent, undefined, [value, new Date(at(1))])],
      [result, (value: unknown) => Reflect.apply(validateRevalidationResult, undefined, [value, intent])],
      [consent, (value: unknown) => Reflect.apply(validateRevalidationConsent, undefined, [value, result, new Date(at(4000))])],
      [state, (value: unknown) => Reflect.apply(validateRevalidationState, undefined, [value, result])]
    ] as const) expect(() => validate(Object.defineProperty({ ...value }, 'force', { enumerable: true, get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const decoded = validateRevalidationState(state, result); state.commitObservation!.transactionDigest = h('d');
    expect(decoded.commitObservation!.transactionDigest).toBe(h('b'));
  });
});
