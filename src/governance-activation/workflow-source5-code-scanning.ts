import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { workflowFailure } from './workflow-control-values.js';
import { captureWorkflowProviderSourceObservation } from './workflow-provider-source-observation.js';
import type { Source5WorkflowProviderSource } from './workflow-provider-source-observation.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';
import { assertWorkflowObservationRuntime } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';

export type Source5CodeScanningSource = Source5WorkflowProviderSource;

function boundedText(value: unknown): value is string {
  return metadataText(value) && value.length > 0;
}
function metadataText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function nullableText(value: unknown): value is string | null {
  return value === null || metadataText(value);
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function diagnostic(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 65536 && !value.includes('\0');
}
function invalidAnalysis(): never {
  return workflowFailure('workflow-code-scanning-analysis',
    'Code-scanning metadata requires a complete bounded unambiguous provider inventory; provider diagnostics and analysis payloads were withheld.');
}

/** Analysis metadata is not authenticated CodeQL, original SARIF, complete query coverage or phase proof. */
export async function observeSource5WorkflowCodeScanning(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly source: Source5CodeScanningSource;
}) {
  const observation = captureWorkflowProviderSourceObservation(input, 'code-scanning');
  const { context, runtime, source, client, prefix, ref } = observation;
  await observation.before();
  async function inventory() {
    const entries = await client.list(`${prefix}/code-scanning/analyses?ref=${ref}`);
    const ids = new Set<number>();
    const analyses = entries.map(entry => {
      if (!counter(entry.id) || entry.id === 0 || ids.has(entry.id) || entry.ref !== ref ||
        typeof entry.commit_sha !== 'string' || !/^[a-f0-9]{40}$/u.test(entry.commit_sha) ||
        !metadataText(entry.analysis_key) || !metadataText(entry.environment) ||
        Object.hasOwn(entry, 'category') && !metadataText(entry.category) ||
        !diagnostic(entry.error) || !diagnostic(entry.warning) ||
        !boundedText(entry.created_at) || !Number.isFinite(Date.parse(entry.created_at)) ||
        !counter(entry.results_count) || !counter(entry.rules_count) ||
        entry.url !== `https://api.github.com${prefix}/code-scanning/analyses/${entry.id}` ||
        !metadataText(entry.sarif_id) || typeof entry.deletable !== 'boolean' ||
        !isRecord(entry.tool) ||
        Object.hasOwn(entry.tool, 'name') && !metadataText(entry.tool.name) ||
        Object.hasOwn(entry.tool, 'version') && !nullableText(entry.tool.version) ||
        Object.hasOwn(entry.tool, 'guid') && !nullableText(entry.tool.guid)) invalidAnalysis();
      ids.add(entry.id);
      return {
        id: entry.id, commitSha: entry.commit_sha, matchesSelectedSource: entry.commit_sha === source.sourceSha,
        analysisKeyDigest: canonicalSha256(entry.analysis_key), environmentDigest: canonicalSha256(entry.environment),
        ...(Object.hasOwn(entry, 'category') ? { categoryDigest: canonicalSha256(entry.category) } : {}),
        createdAt: entry.created_at, resultsCount: entry.results_count, rulesCount: entry.rules_count,
        toolMetadataDigest: canonicalSha256(entry.tool),
        providerReportedError: entry.error.length > 0, providerReportedWarning: entry.warning.length > 0,
        metadataDigest: canonicalSha256(entry)
      };
    });
    return { digest: canonicalSha256(entries), analyses };
  }
  const first = await inventory(), second = await inventory();
  if (first.digest !== second.digest) {
    return workflowFailure('workflow-code-scanning-changed',
      'The actual complete code-scanning analysis inventory changed during observation; no stale or partial metadata was substituted.');
  }
  await observation.after();
  const selected = first.analyses.filter(analysis => analysis.matchesSelectedSource);
  const result = freezeModernValue({
    status: 'blocked' as const, source, graphHash: canonicalSha256(context.records.graph),
    inventoryDigest: first.digest, analyses: first.analyses, selectedSourceAnalyses: selected.length,
    coverage: 'provider-analysis-metadata-only' as const,
    sourceRefReadback: 'observed-during-this-invocation' as const,
    authenticatedCodeQLProgram: null, authenticatedQuerySubjects: null,
    originalSarif: 'not-observed' as const, completeLanguageAndQueryCoverage: 'not-validated' as const,
    requiredContextSemantics: 'not-validated' as const, prerequisiteSession: null,
    phaseProof: 'not-issued' as const, execution: 'not-authorized' as const,
    blockers: [
      ...(!selected.length ? [{ code: 'workflow-code-scanning-source-analysis-unavailable',
        message: 'No actual analysis in the complete selected-ref inventory names the exact source commit; an empty or historical inventory is not scan proof.' }] : []),
      ...(selected.some(analysis => analysis.providerReportedError || analysis.providerReportedWarning) ? [{
        code: 'workflow-code-scanning-diagnostics',
        message: 'An exact-source analysis reports an error or warning; summary counts cannot establish completed scan coverage.'
      }] : []),
      { code: 'workflow-code-scanning-program-unavailable',
        message: 'Tool names, versions and GUIDs are descriptive provider metadata, not authenticated CodeQL executable/query subjects or an approved integration mapping.' },
      { code: 'workflow-code-scanning-original-sarif-unavailable',
        message: 'The existing closed read transport returns analysis metadata, not the custom-media SARIF subset or authenticated original report. No media-type or publisher contract was widened.' },
      { code: 'workflow-code-scanning-coverage-unavailable',
        message: 'Neither positive rule/result counts nor zero results prove complete selected-language/query coverage, successful original execution or source-bound report provenance.' }
    ]
  });
  assertWorkflowObservationRuntime(runtime);
  return result;
}

export type Source5WorkflowCodeScanningObservation = Awaited<ReturnType<typeof observeSource5WorkflowCodeScanning>>;

/** GitHub returns a transformed subset, not the authenticated original SARIF upload. */
export async function observeSource5WorkflowCodeScanningSarif(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly source: Source5CodeScanningSource;
}) {
  const { context, runtime, source, client } = captureWorkflowProviderSourceObservation(input, 'code-scanning');
  const request = { context, runtime, source };
  const first = await observeSource5WorkflowCodeScanning(request);
  async function subset(analysisId: number) {
    const report = await client.codeScanningSarif(source.repository, analysisId);
    if (report.version !== '2.1.0' || !Array.isArray(report.runs) ||
      report.runs.some(run => !isRecord(run) || !isRecord(run.tool) ||
        !isRecord(run.tool.driver) || !boundedText(run.tool.driver.name))) {
      return workflowFailure('workflow-code-scanning-sarif',
        'The provider did not return a bounded SARIF 2.1.0 run envelope; metadata and report contents were withheld.');
    }
    return { documentDigest: canonicalSha256(report), runCount: report.runs.length };
  }
  const subsets = [];
  for (const analysis of first.analyses.filter(analysis => analysis.matchesSelectedSource)) {
    const report = await subset(analysis.id);
    subsets.push({ analysisId: analysis.id, analysisMetadataDigest: analysis.metadataDigest,
      ...report, readback: 'observed-twice-during-this-invocation' as const });
  }
  for (const report of subsets) {
    if (canonicalSha256(await subset(report.analysisId)) !==
      canonicalSha256({ documentDigest: report.documentDigest, runCount: report.runCount })) {
      return workflowFailure('workflow-code-scanning-sarif-changed',
        'The actual provider SARIF subset changed during observation; no cached or partial report was substituted.');
    }
  }
  const second = await observeSource5WorkflowCodeScanning(request);
  if (first.inventoryDigest !== second.inventoryDigest) {
    return workflowFailure('workflow-code-scanning-changed',
      'The complete code-scanning analysis inventory changed around SARIF observation; no report was rebound to different metadata.');
  }
  assertWorkflowObservationRuntime(runtime);
  return freezeModernValue({
    ...second,
    coverage: subsets.length ? 'provider-analysis-metadata-and-sarif-subsets-only' as const : second.coverage,
    providerSarifSubsets: subsets,
    blockers: second.blockers.map(blocker => blocker.code === 'workflow-code-scanning-original-sarif-unavailable' ? {
      code: blocker.code,
      message: 'The custom-media response is a provider-transformed subset with GitHub additions, not an authenticated original upload, complete report or executable/query provenance.'
    } : blocker)
  });
}

export type Source5WorkflowCodeScanningSarifObservation = Awaited<ReturnType<typeof observeSource5WorkflowCodeScanningSarif>>;
