import { types } from 'node:util';
import {
  GitHubActivationClient, githubRepository, positiveId
} from '../adapters/github/activation-rest.js';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { freezeModernValue } from '../domain/governance/activation/modern-graph.js';
import { captureWorkflowBinding, workflowFailure } from './workflow-control-values.js';
import { workflowRequirementObservationClient } from './workflow-requirement-source-observation.js';
import { assertWorkflowObservationRuntime } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';
import { assertSource5WorkflowContext } from './workflow-source5-context.js';
import type { Source5WorkflowContext } from './workflow-source5-context.js';

export interface Source5DependencyReviewComparison {
  readonly repository: string;
  readonly repositoryId: number;
  readonly baseSha: string;
  readonly baseTreeSha: string;
  readonly headSha: string;
  readonly headTreeSha: string;
}

export interface Source5DependencyReviewObservation {
  readonly status: 'observed';
  readonly comparison: Source5DependencyReviewComparison;
  readonly graphHash: string;
  readonly diffDigest: string;
  readonly changes: { readonly added: number; readonly removed: number };
  readonly introducedVulnerabilities: Readonly<Record<'critical' | 'high' | 'moderate' | 'low', number>>;
  readonly verdict: 'no-added-known-vulnerabilities' | 'added-known-vulnerabilities';
  readonly coverage: 'provider-dependency-diff-only';
  readonly licensePolicy: 'not-evaluated';
  readonly sourceRefCurrentness: 'not-observed';
  readonly requiredContextSemantics: 'not-validated';
  readonly prerequisiteSession: null;
  readonly phaseProof: 'not-issued';
  readonly execution: 'not-authorized';
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableText(value: unknown): boolean {
  return value === null || boundedText(value);
}

function invalidDiff(): never {
  return workflowFailure('workflow-dependency-review-diff',
    'Dependency review requires a complete, unambiguous provider diff with explicit vulnerability metadata; provider payloads were withheld.');
}

/** A provider-diff verdict is neither complete SCA/license coverage nor a required-context proof. */
export async function observeSource5WorkflowDependencyReview(input: {
  readonly context: Source5WorkflowContext;
  readonly runtime: WorkflowRuntime;
  readonly comparison: Source5DependencyReviewComparison;
}): Promise<Source5DependencyReviewObservation> {
  if (typeof input !== 'object' || input === null || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 3 ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['context', 'runtime', 'comparison'].includes(key)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(field =>
      !field.enumerable || !Object.hasOwn(field, 'value'))) {
    return workflowFailure('workflow-dependency-review-request',
      'Dependency review accepts only the constructed current5 context, original read-only runtime and exact immutable comparison references.');
  }
  const { context, runtime } = input;
  assertSource5WorkflowContext(context);
  assertWorkflowObservationRuntime(runtime);
  const comparison = captureWorkflowBinding(input.comparison);
  if (!isRecord(comparison) || canonicalSha256(Object.keys(comparison).sort()) !==
    canonicalSha256(['baseSha', 'baseTreeSha', 'headSha', 'headTreeSha', 'repository', 'repositoryId']) ||
    [comparison.baseSha, comparison.baseTreeSha, comparison.headSha, comparison.headTreeSha]
      .some(value => typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) ||
    comparison.baseSha === comparison.headSha) {
    return workflowFailure('workflow-dependency-review-reference',
      'Dependency review requires distinct full base/head commits, their exact trees and a literal repository ID/name; refs, reports and policy overrides are not inputs.');
  }
  githubRepository(comparison.repository);
  positiveId(comparison.repositoryId);
  const client = workflowRequirementObservationClient(runtime);
  const prefix = `/repos/${comparison.repository}`;
  async function repository() {
    const actual = await client.get(prefix);
    if (actual.id !== comparison.repositoryId || actual.full_name !== comparison.repository) {
      return workflowFailure('workflow-dependency-review-repository', 'The actual comparison repository differs from its exact selected ID/name.');
    }
  }
  await repository();
  for (const [sha, tree] of [[comparison.baseSha, comparison.baseTreeSha], [comparison.headSha, comparison.headTreeSha]]) {
    const actual = await client.get(`${prefix}/git/commits/${sha}`);
    if (actual.sha !== sha || !isRecord(actual.tree) || actual.tree.sha !== tree) {
      return workflowFailure('workflow-dependency-review-commit', 'The actual comparison commit/tree differs from its immutable selected subject.');
    }
  }
  const comparePath = `${prefix}/compare/${comparison.baseSha}...${comparison.headSha}`;
  async function lineage() {
    const actual = await client.get(comparePath);
    if (actual.status !== 'ahead' || actual.behind_by !== 0 ||
      !Number.isSafeInteger(actual.total_commits) || Number(actual.total_commits) < 1 || Number(actual.total_commits) > 250 ||
      actual.ahead_by !== actual.total_commits || !isRecord(actual.base_commit) ||
      actual.base_commit.sha !== comparison.baseSha || !isRecord(actual.merge_base_commit) ||
      actual.merge_base_commit.sha !== comparison.baseSha || !Array.isArray(actual.commits) ||
      actual.commits.length !== actual.total_commits ||
      actual.commits.some(commit => !isRecord(commit) || typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(commit.sha)) ||
      new Set(actual.commits.map(commit => commit.sha)).size !== actual.commits.length ||
      actual.commits.at(-1)?.sha !== comparison.headSha) {
      return workflowFailure('workflow-dependency-review-lineage',
        'Dependency review requires a complete bounded actual ancestor-to-head comparison, not a divergent merge-base substitution or truncated commit list.');
    }
    return canonicalSha256({
      base: actual.base_commit.sha, mergeBase: actual.merge_base_commit.sha,
      commits: actual.commits.map(commit => commit.sha)
    });
  }
  const originalLineage = await lineage();
  const diffPath = `${prefix}/dependency-graph/compare/${comparison.baseSha}...${comparison.headSha}`;
  const diffClient = new GitHubActivationClient({ async request(request) {
    const response = await client.transport.request(request);
    if (response.headers['x-github-dependency-graph-snapshot-warnings']) {
      return workflowFailure('workflow-dependency-review-snapshot',
        'The provider reported incomplete dependency snapshots; no retry, warning suppression or successful diff verdict is implicit.');
    }
    return response;
  } });
  async function readDiff() {
    const entries = await diffClient.list(diffPath);
    const keys = new Set<string>();
    const changes = { added: 0, removed: 0 }, introduced = { critical: 0, high: 0, moderate: 0, low: 0 };
    for (const entry of entries) {
      if (typeof entry.change_type !== 'string' || !['added', 'removed'].includes(entry.change_type) ||
        ![entry.manifest, entry.ecosystem, entry.name, entry.version].every(boundedText) ||
        ![entry.package_url, entry.license, entry.source_repository_url].every(nullableText) ||
        typeof entry.scope !== 'string' || !['unknown', 'runtime', 'development'].includes(entry.scope) ||
        !Array.isArray(entry.vulnerabilities) || entry.vulnerabilities.length > 1000) invalidDiff();
      const key = canonicalSha256([entry.change_type, entry.manifest, entry.ecosystem, entry.name, entry.version]);
      if (keys.has(key)) invalidDiff();
      keys.add(key);
      const advisories = new Set<string>();
      for (const vulnerability of entry.vulnerabilities) {
        if (!isRecord(vulnerability) || typeof vulnerability.severity !== 'string' ||
          !['critical', 'high', 'moderate', 'low'].includes(vulnerability.severity) ||
          typeof vulnerability.advisory_ghsa_id !== 'string' ||
          !/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u.test(vulnerability.advisory_ghsa_id) ||
          !boundedText(vulnerability.advisory_summary) ||
          vulnerability.advisory_url !== `https://github.com/advisories/${vulnerability.advisory_ghsa_id}` ||
          advisories.has(vulnerability.advisory_ghsa_id)) invalidDiff();
        advisories.add(vulnerability.advisory_ghsa_id);
        if (entry.change_type === 'added') {
          if (vulnerability.severity === 'critical') introduced.critical++;
          else if (vulnerability.severity === 'high') introduced.high++;
          else if (vulnerability.severity === 'moderate') introduced.moderate++;
          else if (vulnerability.severity === 'low') introduced.low++;
        }
      }
      if (entry.change_type === 'added') changes.added++;
      else changes.removed++;
    }
    assertWorkflowObservationRuntime(runtime);
    return { digest: canonicalSha256(entries), changes, introduced };
  }
  const first = await readDiff(), second = await readDiff();
  if (first.digest !== second.digest || originalLineage !== await lineage()) {
    return workflowFailure('workflow-dependency-review-changed',
      'The actual dependency diff or immutable comparison changed during observation; no stale or newly broadened verdict qualifies.');
  }
  await repository();
  const result: Source5DependencyReviewObservation = freezeModernValue({
    status: 'observed', comparison, graphHash: canonicalSha256(context.records.graph), diffDigest: first.digest,
    changes: first.changes, introducedVulnerabilities: first.introduced,
    verdict: Object.values(first.introduced).some(count => count > 0) ? 'added-known-vulnerabilities' : 'no-added-known-vulnerabilities',
    coverage: 'provider-dependency-diff-only', licensePolicy: 'not-evaluated', sourceRefCurrentness: 'not-observed',
    requiredContextSemantics: 'not-validated', prerequisiteSession: null, phaseProof: 'not-issued', execution: 'not-authorized'
  });
  assertWorkflowObservationRuntime(runtime);
  return result;
}
