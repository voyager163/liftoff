import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { workflowFailure } from './workflow-control-values.js';
import { captureWorkflowProviderSourceObservation } from './workflow-provider-source-observation.js';
import type { Source5WorkflowProviderSource } from './workflow-provider-source-observation.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';
import { assertWorkflowObservationRuntime } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';

export type Source5SecretProtectionHistorySource = Source5WorkflowProviderSource;

const buckets = ['incremental_scans', 'pattern_update_scans', 'backfill_scans',
  'custom_pattern_backfill_scans', 'generic_secrets_backfill_scans'] as const;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function timestamp(value: unknown): value is string | null {
  return value === null || typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}
function invalidHistory(): never {
  return workflowFailure('workflow-secret-protection-history-response',
    'Secret Protection history requires bounded actual latest-scan metadata; malformed provider records were withheld, not converted to a successful or empty scan.');
}

/** Latest scan history has no documented exact-commit or complete detector-coverage binding. */
export async function observeSource5WorkflowSecretProtectionHistory(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly source: Source5SecretProtectionHistorySource;
}) {
  const observation = captureWorkflowProviderSourceObservation(input, 'secret-protection-history');
  const { context, runtime, source, client, prefix } = observation;
  await observation.before();
  async function history() {
    const actual = await client.get(`${prefix}/secret-scanning/scan-history`);
    const observed = buckets.map(bucket => {
      if (!Object.hasOwn(actual, bucket)) return { bucket, presence: 'absent' as const };
      const entries = actual[bucket];
      if (!Array.isArray(entries) || entries.length > 1000) invalidHistory();
      return {
        bucket, presence: 'present' as const,
        entries: entries.map(entry => {
          if (!isRecord(entry)) invalidHistory();
          const metadataDigest = canonicalSha256(entry);
          if (bucket === 'custom_pattern_backfill_scans') return { metadataDigest };
          if (Object.hasOwn(entry, 'type') && !text(entry.type) ||
            Object.hasOwn(entry, 'status') && !text(entry.status) ||
            Object.hasOwn(entry, 'started_at') && !timestamp(entry.started_at) ||
            Object.hasOwn(entry, 'completed_at') && !timestamp(entry.completed_at)) invalidHistory();
          return {
            metadataDigest,
            ...(Object.hasOwn(entry, 'type') ? { typeDigest: canonicalSha256(entry.type) } : {}),
            ...(Object.hasOwn(entry, 'status') ? { statusDigest: canonicalSha256(entry.status) } : {}),
            ...(timestamp(entry.started_at) ? { startedAt: entry.started_at } : {}),
            ...(timestamp(entry.completed_at) ? { completedAt: entry.completed_at } : {})
          };
        })
      };
    });
    const supported = new Set<string>(buckets);
    return {
      digest: canonicalSha256(actual), buckets: observed,
      unknownFields: Object.entries(actual).filter(([field]) => !supported.has(field))
        .map(([field, value]) => ({ fieldDigest: canonicalSha256(field), metadataDigest: canonicalSha256(value) }))
    };
  }
  const first = await history(), second = await history();
  if (first.digest !== second.digest) {
    return workflowFailure('workflow-secret-protection-history-changed',
      'Actual latest-scan metadata changed during observation; no prior, incomplete or caller-supplied scan history was substituted.');
  }
  await observation.after();
  const result = freezeModernValue({
    status: 'blocked' as const, source, graphHash: canonicalSha256(context.records.graph),
    historyDigest: first.digest, buckets: first.buckets, unknownFields: first.unknownFields,
    coverage: 'provider-latest-scan-history-only' as const,
    sourceRefReadback: 'observed-during-this-invocation' as const,
    exactCommitScanBinding: 'not-provided-by-observed-contract' as const,
    completeDetectorCoverage: 'not-authenticated' as const,
    licensedProgramSubjects: null, approvedNonCredentialNegativeControl: null,
    scanVerdict: 'not-issued' as const, requiredContextSemantics: 'not-validated' as const,
    prerequisiteSession: null, phaseProof: 'not-issued' as const, execution: 'not-authorized' as const,
    blockers: [
      ...(first.buckets.some(bucket => bucket.presence === 'absent') ? [{
        code: 'workflow-secret-protection-history-fields-unavailable',
        message: 'An absent latest-scan bucket is not an observed empty bucket or complete scan history.'
      }] : []),
      ...(first.unknownFields.length ? [{
        code: 'workflow-secret-protection-history-fields-unsupported',
        message: 'Additional actual provider fields remain represented by digests, not silently interpreted as supported scan proof.'
      }] : []),
      { code: 'workflow-secret-protection-history-source-binding-unavailable',
        message: 'The documented latest scan types/statuses/timestamps have no exact commit/tree selector or scan binding. Source-ref readback does not bind these scans to that source.' },
      { code: 'workflow-secret-protection-history-coverage-unavailable',
        message: 'Latest incremental/backfill/pattern metadata, completed labels and enabled flags do not authenticate complete licensed detector coverage or a source-bound negative result.' },
      { code: 'workflow-secret-protection-history-control-unavailable',
        message: 'No actual platform-supported explicitly approved non-credential negative control or complete source-bound verifier is available. No substitute scanner, alert-secret retrieval or bypass is permitted.' }
    ]
  });
  assertWorkflowObservationRuntime(runtime);
  return result;
}

export type Source5WorkflowSecretProtectionHistoryObservation =
  Awaited<ReturnType<typeof observeSource5WorkflowSecretProtectionHistory>>;
