import { isRecord } from './sanitize.js';
import type { ParsedWorkflow } from './yaml.js';

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
    (entry.source_type === undefined || entry.source_type === 'Repository'))) {
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

export function observedRequiredContexts(ruleValue: unknown, checkValue: unknown, defaultBranch: string | null = null): PredicateResult {
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
    const required = requiredCheckContexts(matching);
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
    for (const job of jobs) {
      const name = typeof job.name === 'string' ? job.name : String(job.id);
      if (!contexts.some((context) => context.name === name)) continue;
      matched.add(name);
      const steps = job.steps === undefined ? [] : records(job.steps);
      if (!steps) return result(null, `Required job steps are not interpretable in ${workflow.path}.`);
      for (const item of [job, ...steps]) {
        if (item['continue-on-error'] === true) return result(true, `Required job ${name} in ${workflow.path} permits continue-on-error.`);
        if (item['continue-on-error'] !== undefined && typeof item['continue-on-error'] !== 'boolean') unknown = true;
      }
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
