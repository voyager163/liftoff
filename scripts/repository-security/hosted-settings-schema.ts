import { canonicalDigest } from './admission.ts';
import { record, SecurityEvidenceError } from './evidence.ts';

export const hostedSettingsSchemaSource = Object.freeze({
  commit: '338cb199baa4f326790b0b1c246d8d4f481a82a0',
  digest: 'sha256:4fbdc7d0102276803a07f9880d14ed543ba1afc10a4c9fd7bd3782408d9abaf7',
  path: 'descriptions/api.github.com/api.github.com.json'
});

interface RequiredCheck { context: string; integration_id: number; }
interface ScanningTool {
  tool: string;
  alerts_threshold: 'none' | 'errors' | 'errors_and_warnings' | 'all';
  security_alerts_threshold: 'high_or_higher' | 'medium_or_higher' | 'all';
}
export interface BranchPayloadExpectation {
  branch: 'develop' | 'main';
  checks: readonly RequiredCheck[];
  mergeMethods: readonly ('squash' | 'rebase')[];
  linearHistory: boolean;
  codeScanningTools: readonly ScanningTool[];
}

function fail(code: string): never { throw new SecurityEvidenceError(`hosted-settings-${code}`); }
function list(value: unknown, maximum = 100): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid-list');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.trim() !== value || /[\0-\x1f\x7f]/.test(value)) fail('invalid-text');
  return value;
}
function same(left: unknown, right: unknown) { return canonicalDigest(left) === canonicalDigest(right); }
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) fail('duplicate-identity');
}
function checks(value: unknown): RequiredCheck[] {
  const result = list(value).map(value => {
    const item = record(value, ['context', 'integration_id'], 'hosted-settings-check');
    if (!Number.isSafeInteger(item.integration_id) || Number(item.integration_id) < 1) fail('unbound-check-app');
    return { context: text(item.context), integration_id: Number(item.integration_id) };
  });
  if (!result.length) fail('empty-checks');
  unique(result.map(item => item.context));
  return result.sort((a, b) => a.context < b.context ? -1 : a.context > b.context ? 1 : 0);
}
function tools(value: unknown): ScanningTool[] {
  const result = list(value, 10).map(value => {
    const item = record(value, ['tool', 'alerts_threshold', 'security_alerts_threshold'], 'hosted-settings-scanning-tool');
    const alerts = (['none', 'errors', 'errors_and_warnings', 'all'] as const).find(value => value === item.alerts_threshold);
    const severity = (['high_or_higher', 'medium_or_higher', 'all'] as const).find(value => value === item.security_alerts_threshold);
    if (!alerts || !severity) fail('weakened-scanning-threshold');
    return { tool: text(item.tool), alerts_threshold: alerts, security_alerts_threshold: severity };
  });
  unique(result.map(item => item.tool));
  return result.sort((a, b) => a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);
}

function proposal<T>(method: 'POST' | 'PUT', endpoint: string, payload: T) {
  return {
    kind: 'validated-hosted-payload-data' as const, method, endpoint, payload: structuredClone(payload),
    payloadDigest: canonicalDigest(payload), schemaSource: hostedSettingsSchemaSource,
    expectationAuthentication: 'not-established-by-schema-validation' as const,
    capabilityQualified: false, checkBehaviorQualified: false, applyAuthorized: false, liveEffects: false
  };
}

/**
 * Validates proposal semantics only. Expected checks/tools must still receive
 * independent producer/behavior qualification before any activation.
 */
export function validateBranchRulesetPayload(value: unknown, expected: BranchPayloadExpectation) {
  if (!['develop', 'main'].includes(expected.branch) || typeof expected.linearHistory !== 'boolean' ||
      expected.branch === 'main' && !expected.linearHistory) fail('branch-contract');
  const expectedChecks = checks(expected.checks), expectedTools = tools(expected.codeScanningTools);
  const mergeMethods = list(expected.mergeMethods).map(text).sort();
  if (!mergeMethods.length || mergeMethods.some(method => !['squash', 'rebase'].includes(method))) fail('merge-method');
  unique(mergeMethods);
  const payload = record(value, ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules'], 'hosted-settings-ruleset');
  text(payload.name);
  if (payload.target !== 'branch' || payload.enforcement !== 'active' || list(payload.bypass_actors).length) fail('branch-authority');
  const conditions = record(payload.conditions, ['ref_name'], 'hosted-settings-conditions');
  const refs = record(conditions.ref_name, ['include', 'exclude'], 'hosted-settings-ref-condition');
  if (!same(refs.include, [`refs/heads/${expected.branch}`]) || !same(refs.exclude, [])) fail('branch-target');
  const rules = list(payload.rules, 10);
  const types: string[] = [];
  for (const value of rules) {
    if (!value || typeof value !== 'object' || !('type' in value)) fail('rule-shape');
    const type = text(value.type);
    types.push(type);
    if (['deletion', 'non_fast_forward', 'required_linear_history'].includes(type)) {
      record(value, ['type'], 'hosted-settings-rule');
    } else if (type === 'pull_request') {
      const rule = record(value, ['type', 'parameters'], 'hosted-settings-pr-rule');
      const params = record(rule.parameters, [
        'allowed_merge_methods', 'dismiss_stale_reviews_on_push', 'require_code_owner_review',
        'require_last_push_approval', 'required_approving_review_count', 'required_review_thread_resolution'
      ], 'hosted-settings-pr-parameters');
      if (typeof params.dismiss_stale_reviews_on_push !== 'boolean' || params.require_code_owner_review !== false ||
          params.require_last_push_approval !== false || params.required_approving_review_count !== 0 ||
          params.required_review_thread_resolution !== true ||
          !same(list(params.allowed_merge_methods).map(text).sort(), mergeMethods)) fail('single-maintainer-pr-contract');
    } else if (type === 'required_status_checks') {
      const rule = record(value, ['type', 'parameters'], 'hosted-settings-check-rule');
      const params = record(rule.parameters, [
        'required_status_checks', 'strict_required_status_checks_policy', 'do_not_enforce_on_create'
      ], 'hosted-settings-check-parameters');
      if (params.strict_required_status_checks_policy !== true || params.do_not_enforce_on_create !== false ||
          !same(checks(params.required_status_checks), expectedChecks)) fail('check-set-or-strictness');
    } else if (type === 'code_scanning') {
      const rule = record(value, ['type', 'parameters'], 'hosted-settings-code-scanning-rule');
      const params = record(rule.parameters, ['code_scanning_tools'], 'hosted-settings-code-scanning-parameters');
      if (!expectedTools.length || !same(tools(params.code_scanning_tools), expectedTools)) fail('scanning-tool-set');
    } else {
      // In particular, an update restriction without bypass would lock all merges.
      fail('unsupported-or-locking-rule');
    }
  }
  unique(types);
  const required = [
    'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks',
    ...(expected.linearHistory ? ['required_linear_history'] : []),
    ...(expectedTools.length ? ['code_scanning'] : [])
  ];
  if (!same(types.sort(), required.sort())) fail('incomplete-rule-set');
  return proposal('POST', '/repos/voyager163/liftoff/rulesets', payload);
}

export function validateActionsPayload(
  endpoint: 'permissions' | 'selected-actions' | 'workflow', value: unknown,
  approvedReferences: readonly string[] = []
) {
  let payload: Record<string, unknown>;
  if (endpoint === 'permissions') {
    payload = record(value, ['enabled', 'allowed_actions', 'sha_pinning_required'], 'hosted-settings-actions');
    if (payload.enabled !== true || payload.allowed_actions !== 'selected' || payload.sha_pinning_required !== true) fail('actions-policy');
  } else if (endpoint === 'workflow') {
    payload = record(value, ['default_workflow_permissions', 'can_approve_pull_request_reviews'], 'hosted-settings-token');
    if (payload.default_workflow_permissions !== 'read' || payload.can_approve_pull_request_reviews !== false) fail('token-authority');
  } else if (endpoint === 'selected-actions') {
    const pattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)?@[a-f0-9]{40}$/;
    const references = list(approvedReferences).map(text);
    if (!references.length || references.some(value => !pattern.test(value))) fail('unqualified-action-reference');
    unique(references);
    payload = record(value, ['github_owned_allowed', 'verified_allowed', 'patterns_allowed'], 'hosted-settings-selected-actions');
    const proposed = list(payload.patterns_allowed).map(text);
    unique(proposed);
    if (payload.github_owned_allowed !== false || payload.verified_allowed !== false ||
        !same(proposed.sort(), [...references].sort())) fail('action-allowlist');
  } else return fail('unknown-actions-endpoint');
  return proposal('PUT', `/repos/voyager163/liftoff/actions/permissions${endpoint === 'permissions' ? '' : `/${endpoint}`}`, payload);
}

export function validateImmutableReleaseEnablement(body: unknown) {
  if (body !== null) fail('immutable-enable-is-bodyless');
  return proposal('PUT', '/repos/voyager163/liftoff/immutable-releases', null);
}
