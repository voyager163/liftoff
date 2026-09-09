import type { ParsedWorkflow } from './yaml.js';
import { isRecord } from './sanitize.js';

export interface PredicateResult {
  value: boolean | null;
  reason: string;
  exceptionResource?: string;
  absent?: boolean;
}

function result(value: boolean | null, reason: string): PredicateResult {
  return { value, reason };
}
function records(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}
function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string') ? value : null;
}
function ruleList(ruleset: Record<string, unknown>): Record<string, unknown>[] | null {
  return records(ruleset.rules);
}
function scopePatterns(ruleset: Record<string, unknown>): { include: string[]; exclude: string[] } | null {
  if (!isRecord(ruleset.conditions) || !isRecord(ruleset.conditions.ref_name)) return null;
  if (Object.keys(ruleset.conditions).some((key) => key !== 'ref_name')) return null;
  const include = strings(ruleset.conditions.ref_name.include);
  const exclude = strings(ruleset.conditions.ref_name.exclude);
  return include && exclude ? { include, exclude } : null;
}
function parameters(rule: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(rule.parameters) ? rule.parameters : null;
}
function zeroReviewers(rule: Record<string, unknown>): boolean | null {
  const values = parameters(rule);
  if (!values || typeof values.required_approving_review_count !== 'number' ||
      typeof values.require_code_owner_review !== 'boolean' || typeof values.require_last_push_approval !== 'boolean' ||
      typeof values.dismiss_stale_reviews_on_push !== 'boolean') return null;
  return values.required_approving_review_count === 0 &&
    values.require_code_owner_review === false && values.require_last_push_approval === false &&
    values.dismiss_stale_reviews_on_push === true;
}

function refMatches(pattern: string, ref: string, defaultBranch: string | null): boolean | null {
  if (pattern === '~ALL' || pattern === ref) return true;
  if (pattern === '~DEFAULT_BRANCH') return defaultBranch === null ? null : ref === `refs/heads/${defaultBranch}`;
  if (pattern === 'refs/heads/release/**' || pattern === 'refs/heads/hotfix/**') return ref.startsWith(pattern.slice(0, -2));
  if (/[*?[\]{}]/u.test(pattern)) return null;
  return false;
}

function matchingBranchRules(
  rulesets: Record<string, unknown>[], ref: string, defaultBranch: string | null
): { matching: Record<string, unknown>[]; uncertain: boolean } {
  const matching: Record<string, unknown>[] = [];
  let uncertain = false;
  for (const ruleset of rulesets.filter((entry) => entry.target === 'branch' && entry.enforcement === 'active' &&
    (entry.source_type === undefined ||
      ['Repository', 'Organization', 'Enterprise'].includes(String(entry.source_type))))) {
    const patterns = scopePatterns(ruleset);
    if (!patterns) { uncertain = true; continue; }
    if (ref.endsWith('/**') && patterns.exclude.some((pattern) =>
      pattern.startsWith(ref.slice(0, -2)) || pattern.startsWith('~') || /[*?[\]{}]/u.test(pattern)
    )) {
      uncertain = true;
      continue;
    }
    const include = patterns.include.map((pattern) => refMatches(pattern, ref, defaultBranch));
    const exclude = patterns.exclude.map((pattern) => refMatches(pattern, ref, defaultBranch));
    if (exclude.includes(true)) continue;
    if (exclude.includes(null) || (!include.includes(true) && include.includes(null))) { uncertain = true; continue; }
    if (include.includes(true)) matching.push(ruleset);
  }
  return { matching, uncertain };
}

export function protectedRefs(value: unknown, defaultBranch: string | null = null): PredicateResult {
  const rulesets = records(value);
  if (!rulesets) return result(null, 'Ruleset inventory is not interpretable.');
  const refs = ['refs/heads/develop', 'refs/heads/main', 'refs/heads/release/**', 'refs/heads/hotfix/**'];
  for (const ref of refs) {
    const { matching, uncertain } = matchingBranchRules(rulesets, ref, defaultBranch);
    if (!matching.length) return { ...result(uncertain ? null : false, `No proven active protection covers ${ref}.`), absent: !uncertain };
    const rules: Record<string, unknown>[] = [];
    for (const ruleset of matching) {
      const members = ruleList(ruleset);
      if (!members || !Array.isArray(ruleset.bypass_actors)) return result(null, 'Required rule or bypass metadata is unavailable.');
      if (ruleset.bypass_actors.length) return result(false, `Protection for ${ref} permits bypass actors.`);
      rules.push(...members);
    }
    if (!['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'].every((type) => rules.some((rule) => rule.type === type))) {
      return result(false, `Required protection rules are absent for ${ref}.`);
    }
    const checks = rules.filter((rule) => rule.type === 'required_status_checks');
    if (!checks.some((rule) => {
      const config = parameters(rule);
      return config?.strict_required_status_checks_policy === true && config.do_not_enforce_on_create === true &&
        Array.isArray(config.required_status_checks) && config.required_status_checks.length > 0;
    })) return result(false, `Strict, non-empty required checks are not configured for ${ref}.`);
  }
  return result(true, 'Required GitFlow refs have active non-bypassable repository protections.');
}

function classicRequiredContexts(value: unknown): Array<{ name: string; appId: number | null }> | null {
  if (value === null) return [];
  if (!isRecord(value)) return null;
  const required = value.required_status_checks;
  if (required === null) return [];
  if (!isRecord(required) || required.strict !== true) return null;
  const checks = records(required.checks);
  const contexts = strings(required.contexts);
  if (!checks || !contexts) return null;
  const result: Array<{ name: string; appId: number | null }> = [];
  for (const check of checks) {
    if (typeof check.context !== 'string' ||
        (check.app_id !== null && typeof check.app_id !== 'number')) return null;
    result.push({ name: check.context, appId: check.app_id as number | null });
  }
  for (const context of contexts) {
    if (!result.some((entry) => entry.name === context)) {
      result.push({ name: context, appId: null });
    }
  }
  return result;
}

function classicProtection(value: unknown): boolean | null {
  if (value === null) return true;
  if (!isRecord(value)) return null;
  const force = isRecord(value.allow_force_pushes) ? value.allow_force_pushes.enabled : undefined;
  const deletion = isRecord(value.allow_deletions) ? value.allow_deletions.enabled : undefined;
  const reviews = value.required_pull_request_reviews;
  const checks = classicRequiredContexts(value);
  if (typeof force !== 'boolean' || typeof deletion !== 'boolean' || checks === null) return null;
  if (force || deletion || checks.length === 0 || reviews === null) return false;
  if (!isRecord(reviews) ||
      typeof reviews.required_approving_review_count !== 'number' ||
      typeof reviews.require_code_owner_reviews !== 'boolean' ||
      typeof reviews.require_last_push_approval !== 'boolean' ||
      typeof reviews.dismiss_stale_reviews !== 'boolean') return null;
  return reviews.required_approving_review_count === 0 &&
    reviews.require_code_owner_reviews === false &&
    reviews.require_last_push_approval === false &&
    reviews.dismiss_stale_reviews === true;
}

export function effectiveProtectedRefs(
  rulesetValue: unknown,
  branchValue: unknown,
  familyValue: unknown,
  defaultBranch: string | null = null
): PredicateResult {
  const declared = protectedRefs(rulesetValue, defaultBranch);
  if (declared.value === false) return declared;
  const branches = records(branchValue);
  if (!branches) return result(null, 'Exact branch and classic/effective protection observations are unavailable.');
  if (!isRecord(familyValue) || familyValue.complete !== true) {
    return result(null, 'Release and hotfix branch-family enumeration is incomplete.');
  }
  const prefixes = strings(familyValue.prefixes);
  const familyRefs = strings(familyValue.refs);
  if (!prefixes || !familyRefs || !['release/', 'hotfix/'].every((prefix) => prefixes.includes(prefix))) {
    return result(null, 'Release and hotfix branch-family coverage is not authoritative.');
  }
  const requiredRefs = [...new Set(['develop', 'main', ...familyRefs])];
  for (const ref of requiredRefs) {
    const branch = branches.find((entry) => entry.name === ref);
    if (!branch) {
      return ref === 'develop' || ref === 'main'
        ? { ...result(false, `Required protected branch ${ref} was absent.`), absent: true }
        : result(null, `Enumerated branch ${ref} lacked protection metadata.`);
    }
    if (branch.protected !== true || branch.protectionObserved !== true || !isRecord(branch.protection)) {
      return result(false, `Branch ${ref} is not proven protected by complete effective/classic metadata.`);
    }
    const protection = branch.protection;
    const classic = classicProtection(protection.classic);
    if (classic === false) return result(false, `Classic branch protection contradicts the target on ${ref}.`);
    if (classic === null) return result(null, `Classic branch protection is incomplete on ${ref}.`);
    const effectiveRules = records(protection.effectiveRules);
    if (!effectiveRules) return result(null, `Effective branch rules are incomplete on ${ref}.`);
  }
  return declared.value === null
    ? declared
    : result(true, 'Repository, inherited/effective, and classic protections cover every exact assessed ref.');
}

export function singleMaintainer(value: unknown): PredicateResult {
  const rulesets = records(value);
  if (!rulesets) return result(null, 'Pull request rules are not observable.');
  const reviews: Record<string, unknown>[] = [];
  for (const ruleset of rulesets.filter((entry) => entry.target === 'branch' && entry.enforcement === 'active')) {
    const rules = ruleList(ruleset);
    if (!rules) return result(null, 'Ruleset rule details are missing.');
    reviews.push(...rules.filter((rule) => rule.type === 'pull_request'));
  }
  if (!reviews.length) return { ...result(false, 'No active pull request rule was observed.'), absent: true };
  const results = reviews.map(zeroReviewers);
  if (results.includes(false)) return result(false, 'A pull request rule requires a human or code-owner approval.');
  return result(results.includes(null) ? null : true, results.includes(null) ? 'Review settings are incomplete.' : 'Observed pull request rules use zero required human reviewers.');
}

export function tagControls(value: unknown, actionsAppId?: number): PredicateResult {
  const rulesets = records(value);
  if (!rulesets) return result(null, 'Tag rule details are unavailable.');
  const matching = rulesets.filter((ruleset) => {
    const patterns = scopePatterns(ruleset);
    return ruleset.target === 'tag' && ruleset.enforcement === 'active' && patterns?.exclude.length === 0 &&
      (patterns.include.includes('refs/tags/v*') || patterns.include.includes('~ALL'));
  });
  if (!matching.length) return { ...result(false, 'No active release-tag rules were observed.'), absent: true };
  let creation = false;
  let immutable = false;
  for (const ruleset of matching) {
    const rules = ruleList(ruleset);
    const actors = records(ruleset.bypass_actors);
    if (!rules || !actors) return result(null, 'Tag rule or bypass actor details are unavailable.');
    if (rules.some((rule) => rule.type === 'creation') && actors.length === 1) {
      creation ||= actors[0]!.actor_type === 'Integration' && typeof actors[0]!.actor_id === 'number' &&
        (actionsAppId === undefined || actors[0]!.actor_id === actionsAppId) &&
        !rules.some((rule) => ['deletion', 'non_fast_forward'].includes(String(rule.type)));
    }
    immutable ||= actors.length === 0 && ['deletion', 'non_fast_forward'].every((type) => rules.some((rule) => rule.type === type));
  }
  return result(creation && immutable, 'Release tags require separate automation-only creation and non-bypassable immutability rules.');
}

export function requiredCheckContexts(value: unknown): Array<{ name: string; appId: number | null }> | null {
  const rulesets = records(value);
  if (!rulesets) return null;
  const contexts: Array<{ name: string; appId: number | null }> = [];
  for (const ruleset of rulesets.filter((entry) => entry.target === 'branch' && entry.enforcement === 'active')) {
    const rules = ruleList(ruleset);
    if (!rules) return null;
    for (const rule of rules.filter((entry) => entry.type === 'required_status_checks')) {
      const checks = records(parameters(rule)?.required_status_checks);
      if (!checks) return null;
      for (const check of checks) {
        if (typeof check.context !== 'string' || !check.context || (check.integration_id !== null && check.integration_id !== undefined && typeof check.integration_id !== 'number')) return null;
        contexts.push({ name: check.context, appId: typeof check.integration_id === 'number' ? check.integration_id : null });
      }
    }
  }
  return contexts;
}

export function requiredContextBindings(
  value: unknown, refs: readonly string[], defaultBranch: string | null
): Array<{ ref: string; contexts: Array<{ name: string; appId: number | null }> }> | null {
  const rulesets = records(value);
  if (!rulesets || !refs.length) return null;
  const bindings: Array<{ ref: string; contexts: Array<{ name: string; appId: number | null }> }> = [];
  for (const ref of [...new Set(refs)].sort()) {
    const { matching, uncertain } = matchingBranchRules(rulesets, `refs/heads/${ref}`, defaultBranch);
    const contexts = requiredCheckContexts(matching);
    if (uncertain || contexts === null) return null;
    const normalized = [...new Map(contexts.map((context) => [`${context.name}\0${context.appId}`, context])).values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.appId ?? -1) - (b.appId ?? -1));
    bindings.push({ ref, contexts: normalized });
  }
  return bindings;
}

export function effectiveRequiredContextBindings(
  ruleValue: unknown,
  branchValue: unknown,
  refs: readonly string[],
  defaultBranch: string | null
): Array<{ ref: string; contexts: Array<{ name: string; appId: number | null }> }> | null {
  const bindings = requiredContextBindings(ruleValue, refs, defaultBranch);
  const branches = records(branchValue);
  if (!bindings || !branches) return null;
  const resultBindings = [];
  for (const binding of bindings) {
    const branch = branches.find((entry) => entry.name === binding.ref);
    if (!branch || !isRecord(branch.protection)) {
      resultBindings.push(binding);
      continue;
    }
    const classic = classicRequiredContexts(branch.protection.classic);
    if (classic === null) return null;
    const contexts = [...new Map([...binding.contexts, ...classic]
      .map((context) => [`${context.name}\0${context.appId}`, context])).values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.appId ?? -1) - (b.appId ?? -1));
    resultBindings.push({ ref: binding.ref, contexts });
  }
  return resultBindings;
}

export function observedRequiredContexts(
  ruleValue: unknown,
  checkValue: unknown,
  defaultBranch: string | null = null,
  branchValue?: unknown
): PredicateResult {
  const rulesets = records(ruleValue);
  const refs = records(checkValue);
  if (!rulesets || !refs?.length) return result(null, 'Required contexts or commit-bound check observations are unavailable.');
  for (const ref of refs) {
    if (typeof ref.ref !== 'string' || typeof ref.sha !== 'string' || !/^[a-f0-9]{40,64}$/iu.test(ref.sha)) {
      return result(null, 'Check observations are not bound to known refs and commit SHAs.');
    }
    const checks = records(ref.checks);
    if (!checks) return result(null, 'Check run metadata is incomplete.');
    const { matching, uncertain } = matchingBranchRules(rulesets, `refs/heads/${ref.ref}`, defaultBranch);
    let required = requiredCheckContexts(matching);
    if (required !== null && branchValue !== undefined) {
      const branch = records(branchValue)?.find((entry) => entry.name === ref.ref);
      if (branch && isRecord(branch.protection)) {
        const classic = classicRequiredContexts(branch.protection.classic);
        if (classic === null) return result(null, `Classic required checks for ${ref.ref} are unresolved.`);
        required = [...new Map([...required, ...classic]
          .map((context) => [`${context.name}\0${context.appId}`, context])).values()];
      }
    }
    if (uncertain || required === null) return result(null, `Required context scope for ${ref.ref} is unresolved.`);
    if (!required.length) return { ...result(false, `No required contexts are configured for ${ref.ref}.`), absent: true };
    if (!required.every((context) => checks.some((check) =>
      check.name === context.name && (context.appId === null || context.appId === check.appId) &&
      check.status === 'completed' && check.conclusion === 'success'
    ))) return result(false, `Required contexts do not have matching successful checks on ${ref.ref}@${ref.sha}.`);
  }
  return result(true, 'Required contexts match successful check runs on each exact assessed ref and commit.');
}

function workflowJobs(workflow: ParsedWorkflow): Record<string, unknown>[] | null {
  if (!isRecord(workflow.value.jobs) || Object.keys(workflow.value.jobs).length === 0) return null;
  const values = Object.entries(workflow.value.jobs);
  if (values.some(([, job]) => !isRecord(job))) return null;
  return values.map(([id, job]) => ({ ...(isRecord(job) ? job : {}), id }));
}
function permission(value: unknown): boolean | null {
  if (value === 'write-all') return false;
  if (value === 'read-all') return true;
  if (!isRecord(value)) return null;
  const entries = Object.values(value);
  return entries.every((entry) => ['read', 'write', 'none'].includes(String(entry))) ? true : null;
}

export function workflowPermissions(workflows: ParsedWorkflow[]): PredicateResult {
  if (!workflows.length) return result(false, 'No workflow files were found.');
  let unknown = false;
  for (const workflow of workflows) {
    const top = permission(workflow.value.permissions);
    const jobs = workflowJobs(workflow);
    if (!jobs) return result(null, `Jobs cannot be interpreted in ${workflow.path}.`);
    for (const job of jobs) {
      const found = job.permissions === undefined ? top : permission(job.permissions);
      if (found === false) return result(false, `Broad write-all permissions in ${workflow.path}.`);
      unknown ||= found === null;
    }
  }
  return result(unknown ? null : true, unknown ? 'Effective workflow permissions are not explicitly known.' : 'Workflow permissions are explicitly bounded.');
}

export function actionReferences(workflows: ParsedWorkflow[]): string[] | null {
  const refs: string[] = [];
  for (const workflow of workflows) {
    const jobs = workflowJobs(workflow);
    if (!jobs) return null;
    for (const job of jobs) {
      if (job.uses !== undefined) {
        if (typeof job.uses !== 'string') return null;
        refs.push(job.uses);
      }
      if (job.steps !== undefined) {
        const steps = records(job.steps);
        if (!steps) return null;
        for (const step of steps) {
          if (step.uses === undefined) continue;
          if (typeof step.uses !== 'string') return null;
          refs.push(step.uses);
        }
      }
    }
  }
  return [...new Set(refs)].sort();
}

export function pinnedActions(workflows: ParsedWorkflow[]): PredicateResult {
  const refs = actionReferences(workflows);
  if (!refs || !refs.length) return result(null, 'No interpretable action reference inventory was found.');
  if (refs.some((ref) => ref.includes('${{'))) return result(null, 'Dynamic action references cannot be resolved safely.');
  const unpinned = refs.filter((ref) => !ref.startsWith('./') &&
    !/^[^@\s]+@[a-f0-9]{40}$/iu.test(ref) && !/^docker:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/iu.test(ref));
  const value = result(unpinned.length === 0, unpinned.length ? `Unpinned action references: ${unpinned.join(', ')}` : 'External action references are content-pinned.');
  if (unpinned.length === 1 && /^slsa-framework\/slsa-github-generator\/\.github\/workflows\/[a-zA-Z0-9_-]+\.yml@v\d+\.\d+\.\d+$/u.test(unpinned[0]!)) {
    value.exceptionResource = unpinned[0];
  }
  return value;
}

export function failOpenFlags(workflows: ParsedWorkflow[], rules: unknown): PredicateResult {
  const contexts = requiredCheckContexts(rules);
  if (!contexts?.length) return result(null, 'Exact required contexts are needed to distinguish gates from diagnostic/report-only jobs.');
  const matched = new Set<string>();
  let unknown = false;
  for (const workflow of workflows) {
    const jobs = workflowJobs(workflow);
    if (!jobs) return result(null, `Jobs cannot be interpreted in ${workflow.path}.`);
    const byId = new Map(jobs.map((job) => [String(job.id), job]));
    const visit = (
      job: Record<string, unknown>,
      requiredName: string,
      visiting: Set<string>
    ): PredicateResult | null => {
      const id = String(job.id);
      if (visiting.has(id)) return result(null, `Required job ${requiredName} has a cyclic needs graph in ${workflow.path}.`);
      if (job.uses !== undefined || job.strategy !== undefined || job.if !== undefined ||
          (typeof job.name === 'string' && job.name.includes('${{'))) {
        return result(null, `Required job ${requiredName} has reusable, matrix, dynamic-name, or conditional semantics in ${workflow.path}.`);
      }
      const steps = job.steps === undefined ? [] : records(job.steps);
      if (!steps) return result(null, `Required job steps are not interpretable in ${workflow.path}.`);
      for (const item of [job, ...steps]) {
        if (item['continue-on-error'] === true) {
          return result(true, `Required job ${requiredName} or a transitive dependency permits continue-on-error in ${workflow.path}.`);
        }
        if (item['continue-on-error'] !== undefined && typeof item['continue-on-error'] !== 'boolean') {
          return result(null, `Required job ${requiredName} has dynamic continue-on-error semantics in ${workflow.path}.`);
        }
        if (item !== job && (item.if !== undefined || item.uses !== undefined &&
            typeof item.uses === 'string' && item.uses.includes('${{'))) {
          return result(null, `Required job ${requiredName} has unresolved step conditions or dynamic actions in ${workflow.path}.`);
        }
      }
      const needs = job.needs === undefined
        ? []
        : typeof job.needs === 'string'
          ? [job.needs]
          : strings(job.needs);
      if (needs === null) return result(null, `Required job ${requiredName} has dynamic needs semantics in ${workflow.path}.`);
      const next = new Set(visiting).add(id);
      for (const dependencyId of needs) {
        const dependency = byId.get(dependencyId);
        if (!dependency) return result(null, `Required job ${requiredName} references unresolved dependency ${dependencyId}.`);
        const dependencyResult = visit(dependency, requiredName, next);
        if (dependencyResult) return dependencyResult;
      }
      return null;
    };
    for (const context of contexts) {
      const matching = jobs.filter((job) => {
        const name = typeof job.name === 'string' ? job.name : String(job.id);
        return context.name === name;
      });
      if (matching.length !== 1) continue;
      matched.add(context.name);
      const check = visit(matching[0]!, context.name, new Set());
      if (check?.value === true) return check;
      if (check?.value === null) unknown = true;
    }
  }
  const unresolved = contexts.some((context) => !matched.has(context.name));
  return result(unresolved || unknown ? null : false, unresolved || unknown
    ? 'Some required-job flag semantics are unresolved.' : 'No continue-on-error flags were observed in identified required jobs; script semantics require separate proof.');
}

export function securityPipeline(workflows: ParsedWorkflow[]): PredicateResult {
  const refs = actionReferences(workflows);
  if (!refs || !workflows.length) return result(null, 'Security workflow inventory is unavailable.');
  const forbidden = ['gitleaks/gitleaks-action', 'semgrep/semgrep-action', 'microsoft/security-devops-action'];
  if (refs.some((ref) => forbidden.some((repo) => ref.toLowerCase().startsWith(`${repo}@`)))) {
    return result(false, 'A policy-excluded duplicate security scanner is declared.');
  }
  return result(null, 'Action inventory is observable, but complete stage/tool roles and script-backed gates require explicit execution evidence.');
}

export function runnerAlignment(value: unknown, repository: string | null): PredicateResult {
  if (!isRecord(value)) return result(null, 'Hosted-runner metadata is unavailable.');
  if (value.repositoryAssigned === false) {
    return { ...result(false, 'The bound runner group is authoritatively not assigned to this repository.'), absent: true };
  }
  if (value.repositoryAssigned !== true || typeof value.runnerId !== 'number' ||
      typeof value.groupId !== 'number' || typeof value.networkConfigurationId !== 'string' ||
      typeof value.repository !== 'string' || !repository ||
      value.repository.toLowerCase() !== repository.toLowerCase()) {
    return result(null, 'Exact runner, group, network, and repository assignment is incomplete.');
  }
  if (!isRecord(value.runner) || !isRecord(value.group) || !isRecord(value.network)) {
    return result(null, 'Runner capacity, group restrictions, or network metadata is incomplete.');
  }
  const runner = value.runner;
  const group = value.group;
  const network = value.network;
  const labels = strings(runner.labels);
  const selectedWorkflows = strings(group.selectedWorkflows);
  const networkSettings = strings(network.networkSettingsIds);
  const size = isRecord(runner.machineSize) ? runner.machineSize : null;
  if (!labels || !selectedWorkflows || !networkSettings || !size ||
      typeof runner.maximumRunners !== 'number' || typeof runner.publicIpEnabled !== 'boolean' ||
      typeof runner.status !== 'string' || typeof size.cpuCores !== 'number' ||
      typeof size.memoryGb !== 'number' || typeof group.visibility !== 'string' ||
      typeof group.allowsPublicRepositories !== 'boolean' ||
      typeof group.restrictedToWorkflows !== 'boolean' ||
      typeof group.inherited !== 'boolean' || typeof network.computeService !== 'string') {
    return result(null, 'Runner labels, capacity, status, restrictions, or network facts are incomplete.');
  }
  const aligned = ['ready', 'online', 'idle'].includes(runner.status.toLowerCase()) &&
    labels.includes('private-staging') &&
    runner.maximumRunners === 1 &&
    runner.publicIpEnabled === false &&
    size.cpuCores >= 4 &&
    size.memoryGb >= 16 &&
    group.visibility === 'selected' &&
    group.allowsPublicRepositories === false &&
    group.restrictedToWorkflows === true &&
    group.inherited === false &&
    selectedWorkflows.length > 0 &&
    selectedWorkflows.every((workflow) =>
      workflow.toLowerCase().startsWith(`${repository.toLowerCase()}/.github/workflows/`)
    ) &&
    network.computeService === 'actions' &&
    networkSettings.length > 0;
  return result(
    aligned,
    aligned
      ? 'Runner assignment, labels, capacity, status, repository/workflow restrictions, and network binding match policy.'
      : 'Runner identity alone is insufficient; one or more labels, capacity, status, restrictions, workflow bindings, or network facts conflict.'
  );
}
