import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import { githubRepository } from '../adapters/github/activation-rest.js';
import { captureWorkflowBinding, workflowByteDigest, workflowFailure, readWorkflowBytes } from './workflow-runtime.js';
import type { WorkflowRuntime } from './workflow-runtime.js';

export const protectedWorkflowFamilies = ['develop', 'main', 'release', 'hotfix'] as const;
export type ProtectedWorkflowFamily = typeof protectedWorkflowFamilies[number];

export interface WorkflowRequirementSource {
  profile: 'single-maintainer-gitflow' | 'team-gitflow';
  sourceDigest: string;
  files: readonly { path: string; digest: string }[];
  families: Readonly<Record<ProtectedWorkflowFamily, readonly string[]>>;
  integrations: Readonly<Record<ProtectedWorkflowFamily, Readonly<Record<string, number | null>>>>;
}

export interface WorkflowRequirementSourceReference {
  readonly repository: string;
  readonly repositoryId: number;
  readonly sourceSha: string;
  readonly treeSha: string;
  readonly files: readonly { readonly path: string; readonly digest: string }[];
}

export function captureWorkflowRequirementSourceReference(
  value: WorkflowRequirementSourceReference
): WorkflowRequirementSourceReference {
  const reference = captureWorkflowBinding(value);
  if (!isRecord(reference) ||
    canonicalSha256(Object.keys(reference).sort()) !== canonicalSha256(['files', 'repository', 'repositoryId', 'sourceSha', 'treeSha']) ||
    typeof reference.repository !== 'string' || !Number.isSafeInteger(reference.repositoryId) || reference.repositoryId <= 0 ||
    typeof reference.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(reference.sourceSha) ||
    typeof reference.treeSha !== 'string' || !/^[a-f0-9]{40}$/u.test(reference.treeSha) ||
    !Array.isArray(reference.files) || !reference.files.length || reference.files.length > 16 ||
    reference.files.some(file => !isRecord(file) ||
      canonicalSha256(Object.keys(file).sort()) !== canonicalSha256(['digest', 'path']) ||
      typeof file.path !== 'string' || !/^governance\/rulesets\/[A-Za-z0-9_-]+\.json$/u.test(file.path) ||
      typeof file.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(file.digest)) ||
    new Set(reference.files.map(file => file.path)).size !== reference.files.length) {
    return workflowFailure('workflow-required-source-reference',
      'Required-context source selectors need one exact repository/commit/tree and closed bounded unique file/digest references; context inventories and proof values are not inputs.');
  }
  githubRepository(reference.repository);
  return reference;
}

/** Complete immutable source readback only; neither semantic recipe qualification nor authority. */
export async function readRequiredWorkflowSource(
  runtime: Pick<WorkflowRuntime, 'client' | 'assertWithinDeadline'>,
  reference: WorkflowRequirementSourceReference,
  profile: WorkflowRequirementSource['profile']
): Promise<WorkflowRequirementSource> {
  runtime.assertWithinDeadline();
  reference = captureWorkflowRequirementSourceReference(reference);
  const commit = await runtime.client.get(`/repos/${reference.repository}/git/commits/${reference.sourceSha}`);
  runtime.assertWithinDeadline();
  if (commit.sha !== reference.sourceSha || !isRecord(commit.tree) || commit.tree.sha !== reference.treeSha) {
    return workflowFailure('workflow-proof-matrix', 'Actual source tree could not establish the complete required-context inventory.');
  }
  const tree = await runtime.client.get(`/repos/${reference.repository}/git/trees/${reference.treeSha}?recursive=1`);
  runtime.assertWithinDeadline();
  if (tree.sha !== reference.treeSha || tree.truncated !== false || !Array.isArray(tree.tree) ||
    tree.tree.some(entry => !isRecord(entry) || typeof entry.path !== 'string')) {
    return workflowFailure('workflow-proof-matrix', 'Incomplete/truncated source trees cannot prove that every required context was covered.');
  }
  const ruleFiles = tree.tree.filter(entry => isRecord(entry) && typeof entry.path === 'string' &&
    entry.path.startsWith('governance/rulesets/'));
  if (ruleFiles.some(entry => !isRecord(entry) || typeof entry.path !== 'string' ||
    !/^governance\/rulesets\/[A-Za-z0-9_-]+\.json$/u.test(entry.path) ||
    entry.type !== 'blob' || entry.mode !== '100644') ||
    canonicalSha256(ruleFiles.map(entry => String(entry.path)).sort()) !==
      canonicalSha256(reference.files.map(file => file.path).sort())) {
    return workflowFailure('workflow-proof-matrix', 'Required context source omitted or substituted actual committed ruleset files, or contains unsupported ruleset members.');
  }
  const fileReads = reference.files.map(async file => ({
    path: file.path, content: await readWorkflowBytes(runtime.client, reference.repository, reference.sourceSha, file.path, file.digest)
  }));
  const files = await Promise.all(fileReads).catch(async (error: unknown) => {
    await Promise.allSettled(fileReads);
    throw error;
  });
  runtime.assertWithinDeadline();
  const requirements = requiredWorkflowContextsFromSource(files, profile);
  runtime.assertWithinDeadline();
  return requirements;
}

export function requiredWorkflowContextsFromSource(
  files: readonly { path: string; content: Buffer }[],
  profile: WorkflowRequirementSource['profile']
): WorkflowRequirementSource {
  const families: Record<ProtectedWorkflowFamily, string[]> = { develop: [], main: [], release: [], hotfix: [] };
  const integrations: Record<ProtectedWorkflowFamily, Record<string, number | null>> = {
    develop: {}, main: {}, release: {}, hotfix: {}
  };
  if (!['single-maintainer-gitflow', 'team-gitflow'].includes(profile) ||
    !files.length || files.length > 16 || new Set(files.map((file) => file.path)).size !== files.length) {
    return workflowFailure('workflow-required-contexts', 'Required context inventory must come from the complete bounded unique immutable ruleset source, not a caller-selected subset.');
  }
  const patterns: Record<string, ProtectedWorkflowFamily> = {
    'refs/heads/develop': 'develop', 'refs/heads/main': 'main',
    'refs/heads/release/**': 'release', 'refs/heads/hotfix/**': 'hotfix'
  };
  for (const file of files) {
    if (!/^governance\/rulesets\/[A-Za-z0-9_-]+\.json$/u.test(file.path) || file.content.length > 128 * 1024) {
      return workflowFailure('workflow-required-contexts', 'Ruleset source inventory contains an unsupported path or oversized file.');
    }
    let value: unknown;
    try { value = JSON.parse(file.content.toString('utf8')); }
    catch { return workflowFailure('workflow-required-contexts', 'Ruleset context source must be actual unambiguous JSON.'); }
    if (!isRecord(value) || !Array.isArray(value.rules)) {
      return workflowFailure('workflow-required-contexts', 'Ruleset source has no actual provider rule inventory.');
    }
    if (value.target === 'tag') continue;
    if (value.target !== 'branch' || !Array.isArray(value.bypass_actors) || value.bypass_actors.length ||
      !isRecord(value.conditions) || !isRecord(value.conditions.ref_name) ||
      !Array.isArray(value.conditions.ref_name.include) || !value.conditions.ref_name.include.length ||
      !Array.isArray(value.conditions.ref_name.exclude) || value.conditions.ref_name.exclude.length ||
      value.conditions.ref_name.include.some((pattern) => typeof pattern !== 'string' || !Object.hasOwn(patterns, pattern))) {
      return workflowFailure('workflow-required-contexts', 'Protected context scope must name exact supported GitFlow families without exclusions or protected-branch bypass.');
    }
    const checks = value.rules.filter((rule) => isRecord(rule) && rule.type === 'required_status_checks');
    if (checks.length > 1) return workflowFailure('workflow-required-contexts', 'Ambiguous required-check rule inventories cannot establish proof requirements.');
    if (!checks.length) continue;
    const parameters = checks[0]!.parameters;
    if (!isRecord(parameters) || parameters.strict_required_status_checks_policy !== true ||
      !Array.isArray(parameters.required_status_checks) || !parameters.required_status_checks.length ||
      parameters.required_status_checks.some((check) => !isRecord(check) || typeof check.context !== 'string' ||
        !check.context || check.context.length > 100 ||
        check.integration_id !== undefined && (!Number.isSafeInteger(check.integration_id) || Number(check.integration_id) < 1))) {
      return workflowFailure('workflow-required-contexts', 'Required-check source must declare actual nonempty strict context names and valid optional integration IDs.');
    }
    const reviews = value.rules.filter((rule) => isRecord(rule) && rule.type === 'pull_request');
    if (reviews.length !== 1) {
      return workflowFailure('workflow-required-contexts', 'Each protected required-check source must retain its exact selected-profile pull-request rule.');
    }
    const review = reviews[0]!;
    {
      const parameters = review.parameters;
      const minimum = profile === 'single-maintainer-gitflow' ? 0 : 1;
      if (!isRecord(parameters) || !Number.isInteger(parameters.required_approving_review_count) ||
        Number(parameters.required_approving_review_count) !== minimum ||
        parameters.dismiss_stale_reviews_on_push !== true) {
        return workflowFailure('workflow-required-contexts', 'Ruleset source must preserve the selected profile review minimum and invalidate stale review. A source declaration is not an observed human approval.');
      }
    }
    for (const pattern of value.conditions.ref_name.include) {
      const family = patterns[String(pattern)]!;
      for (const check of parameters.required_status_checks) {
        const context = String(check.context);
        const integration = typeof check.integration_id === 'number' ? check.integration_id : null;
        const previous = Object.hasOwn(integrations[family], context) ? integrations[family][context] : undefined;
        if (previous !== undefined && previous !== null && integration !== null && previous !== integration) {
          return workflowFailure('workflow-required-contexts', 'The same context requires conflicting pinned integration identities.');
        }
        Object.defineProperty(integrations[family], context, {
          value: previous ?? integration, enumerable: true, configurable: true, writable: true
        });
        if (!families[family].includes(context)) families[family].push(context);
      }
    }
  }
  for (const family of protectedWorkflowFamilies) {
    if (!families[family].length) return workflowFailure('workflow-required-contexts', 'Missing required contexts on any protected family cannot become inapplicable or a vacuous green.');
    families[family].sort();
  }
  const digests = files.map((file) => ({ path: file.path, digest: workflowByteDigest(file.content) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { profile, sourceDigest: canonicalSha256({ profile, files: digests, families, integrations }),
    files: digests, families, integrations };
}
