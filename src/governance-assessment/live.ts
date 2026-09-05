import { NodeCommandRunner } from '../process-runner.js';
import {
  azureBinding, boolean, id, list, normalizeProtection, normalizeResource,
  normalizeRule, normalizeRuleset, record, sorted, text, type ValidatedAzureBinding
} from './live-normalize.js';
import { LiveFailure, LiveTransport } from './live-transport.js';
import { isRecord, jsonValue, notObserved, observed, source } from './sanitize.js';
import {
  assessmentLimits, type AssessmentDiagnostic, type JsonValue, type LiveAssessmentOptions,
  type LiveAssessmentResult, type LiveAssessmentScope, type Observation, type ObservationSource
} from './types.js';

const families = [
  'github.repository', 'github.actions-app', 'github.rulesets', 'github.branches', 'github.checks', 'github.environments',
  'github.workflows', 'github.security', 'github.runner', 'azure.providers', 'azure.resources'
] as const;

function branchName(value: unknown): string {
  let name = text(value);
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,1023}$/u.test(name) ||
      name.startsWith('refs/') || name.includes('..') || name.includes('//') ||
      name.endsWith('/') || name.endsWith('.') ||
      name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    throw new LiveFailure('unsafe-ref', 'A requested ref was not a safe, exact branch name.');
  }
  return name;
}

function sha(value: unknown): string {
  const commit = text(value).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new LiveFailure('invalid-response', 'The provider did not supply a valid exact commit SHA.');
  }
  return commit;
}

function environmentName(value: unknown): string {
  const name = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,254}$/u.test(name) || name.includes('..')) {
    throw new LiveFailure('unsafe-environment', 'A deployment environment name was not safe for a scoped metadata read.');
  }
  return name;
}

function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LiveFailure('invalid-response', 'Expected bounded numeric metadata was not available.');
  }
  return value;
}

function repositoryScope(value: LiveAssessmentScope['repository']): NonNullable<LiveAssessmentScope['repository']> {
  if (!value) throw new LiveFailure('repository-unbound', 'No repository binding was available; live discovery was not attempted.');
  const owner = text(value.owner);
  const name = text(value.name);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/u.test(name) || name === '.' || name === '..') {
    throw new LiveFailure('unsafe-repository', 'The repository binding was not a safe GitHub owner and repository name.');
  }
  if (value.id !== null && (typeof value.id !== 'string' || !/^(?:[1-9]\d*|R_[A-Za-z0-9_-]{1,180})$/u.test(text(value.id)))) {
    throw new LiveFailure('unsafe-repository', 'The expected repository identity was not a supported node ID or numeric ID.');
  }
  return { owner, name, id: value.id };
}

function runnerScope(
  value: LiveAssessmentScope['runner'], repository: NonNullable<LiveAssessmentScope['repository']>
): NonNullable<LiveAssessmentScope['runner']> {
  if (!value || value.groupId === null || value.networkConfigurationId === null) {
    throw new LiveFailure('runner-unbound', 'Exact existing runner, group and network bindings were not available; organization discovery was not attempted.');
  }
  const organization = text(value.organization);
  const networkConfigurationId = text(value.networkConfigurationId);
  if (organization.toLowerCase() !== repository.owner.toLowerCase() ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(networkConfigurationId)) {
    throw new LiveFailure('unsafe-runner-scope', 'The runner organization or network binding did not match the verified repository scope.');
  }
  return { organization, runnerId: id(value.runnerId), groupId: id(value.groupId), networkConfigurationId };
}

class Observations {
  readonly values: Record<string, Observation> = {};
  readonly diagnostics: AssessmentDiagnostic[] = [];

  constructor(readonly capturedAt: string) {}

  fail(key: string, error: unknown, location: string | null = null): void {
    const failure = error instanceof LiveFailure ? error
      : new LiveFailure('invalid-response', 'Required live metadata could not be safely normalized; raw error details were withheld.');
    this.values[key] = notObserved(failure.message, location === null ? null :
      source(key.startsWith('azure.') ? 'azure' : 'github', location, this.capturedAt));
    this.diagnostics.push({
      code: `live-${failure.code}`, severity: 'warning', source: key, message: failure.message
    });
  }

  put(key: string, value: JsonValue, location: string, revision: string | null = null): void {
    if (Buffer.byteLength(JSON.stringify(value)) > assessmentLimits.responseBytes) {
      throw new LiveFailure('size-limit', 'Normalized observation metadata exceeded the byte limit.');
    }
    const from = source(key.startsWith('azure.') ? 'azure' : 'github', location, this.capturedAt, value, revision);
    const result = observed(value, from);
    if (result.availability !== 'observed') {
      throw new LiveFailure('sensitive-response', 'The normalized observation contained sensitive data and was withheld.');
    }
    this.values[key] = result;
  }

  retainFacts(key: string, facts: JsonValue, location: string, revision: string | null = null): void {
    const unavailable = this.values[key];
    if (unavailable?.availability !== 'not-observed') return;
    try {
      this.put(key, facts, location, revision);
      const normalized = this.values[key]!;
      this.values[key] = { ...unavailable, facts: normalized.value, source: normalized.source };
    } catch (error) {
      this.fail(key, error, location);
    }
  }

  missing(key: string, reason: string, from: ObservationSource): void {
    this.values[key] = { availability: 'missing', value: null, source: from, reason };
  }

  async capture<T extends JsonValue>(
    key: string, location: string, collect: () => Promise<T>, revision: string | null = null
  ): Promise<T | undefined> {
    try {
      const value = await collect();
      this.put(key, value, location, revision);
      return value;
    } catch (error) {
      this.fail(key, error, location);
      return undefined;
    }
  }

  finish(refsStable: boolean): LiveAssessmentResult {
    return {
      observations: Object.fromEntries(Object.entries(this.values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      diagnostics: sorted(this.diagnostics),
      refsStable
    };
  }
}

function normalizeSecurity(value: unknown): JsonValue {
  const input = record(value);
  const features: Record<string, JsonValue> = {};
  for (const name of [
    'advanced_security', 'code_security', 'secret_scanning', 'secret_scanning_push_protection',
    'secret_scanning_validity_checks', 'secret_scanning_non_provider_patterns', 'secret_scanning_ai_detection'
  ]) {
    if (!Object.hasOwn(input, name)) continue;
    const status = text(record(input[name]).status);
    if (status !== 'enabled' && status !== 'disabled') {
      throw new LiveFailure('unsupported-response', 'An unrecognized repository security-feature status was returned.');
    }
    features[name] = { status };
  }
  if (!Object.keys(features).length) {
    throw new LiveFailure('security-unavailable', 'Repository security-feature visibility was not granted by the response.');
  }
  return features;
}

function normalizeCheck(value: unknown, commit: string): { key: string; value: JsonValue } {
  const check = record(value);
  const key = String(id(check.id));
  if (sha(check.head_sha) !== commit) {
    throw new LiveFailure('scope-mismatch', 'A check run did not match the exact requested commit SHA.');
  }
  const status = text(check.status);
  if (!['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending'].includes(status)) {
    throw new LiveFailure('unsupported-response', 'The check-run status was not understood by this collector.');
  }
  const conclusion = check.conclusion === null ? null : text(check.conclusion);
  if (conclusion !== null && ![
    'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure', 'stale'
  ].includes(conclusion)) {
    throw new LiveFailure('unsupported-response', 'The check-run conclusion was not understood by this collector.');
  }
  const app = check.app === null ? null : record(check.app);
  const appSlug = app?.slug === undefined || app.slug === null ? null : text(app.slug);
  return {
    key,
    value: {
      name: text(check.name), appId: app === null ? null : id(app.id),
      ...(appSlug === null ? {} : { appSlug }), status, conclusion
    }
  };
}

interface EnvironmentValue {
  name: string;
  reviewers: number | null;
  deploymentBranchPolicy: JsonValue;
  [key: string]: JsonValue;
}

function normalizeEnvironment(value: unknown, selected: readonly string[]): { key: string; value: EnvironmentValue } {
  const input = record(value);
  const actualName = environmentName(input.name);
  const name = selected.find((entry) => entry.toLowerCase() === actualName.toLowerCase());
  if (name === undefined) {
    return { key: actualName.toLowerCase(), value: { name: actualName, reviewers: null, deploymentBranchPolicy: null } };
  }
  const protections = list(input.protection_rules).map(record);
  if (protections.some((rule) => !['required_reviewers', 'wait_timer', 'branch_policy'].includes(text(rule.type)))) {
    throw new LiveFailure('unsupported-response', 'An unrecognized environment protection rule prevents complete reviewer observation.');
  }
  const reviewerRules = protections.filter((rule) => rule.type === 'required_reviewers');
  if (reviewerRules.length > 1) throw new LiveFailure('invalid-response', 'Environment reviewer metadata was ambiguous.');
  const reviewers = reviewerRules.length === 0 ? 0 : list(reviewerRules[0]!.reviewers).map((entry) => {
    const reviewer = record(entry);
    if (!['User', 'Team'].includes(text(reviewer.type))) {
      throw new LiveFailure('unsupported-response', 'An unrecognized environment reviewer type was returned.');
    }
    return id(record(reviewer.reviewer).id);
  }).length;
  let deploymentBranchPolicy: JsonValue = null;
  if (input.deployment_branch_policy !== null) {
    const policy = record(input.deployment_branch_policy);
    deploymentBranchPolicy = {
      protected_branches: boolean(policy.protected_branches),
      custom_branch_policies: boolean(policy.custom_branch_policies)
    };
  }
  return { key: name.toLowerCase(), value: { name, reviewers, deploymentBranchPolicy } };
}

export async function collectLiveAssessment(
  scope: LiveAssessmentScope, options: LiveAssessmentOptions = {}
): Promise<LiveAssessmentResult> {
  const now = options.now ?? (() => new Date());
  const results = new Observations(now().toISOString());
  let repository: NonNullable<LiveAssessmentScope['repository']>;
  try {
    repository = repositoryScope(scope.repository);
  } catch (error) {
    for (const family of families) results.fail(family, error);
    return results.finish(scope.repository === null && scope.refs.length === 0);
  }

  let refs: string[] = [];
  let environments: string[] = [];
  let runner: LiveAssessmentScope['runner'] = null;
  let refsValid = true;
  let environmentsValid = true;
  let azureScopeValid = true;
  try { refs = [...new Set(list(scope.refs).map(branchName))].sort(); } catch (error) {
    refsValid = false;
    results.fail('github.branches', error);
    results.fail('github.checks', error);
  }
  try {
    environments = [...new Map(list(scope.environments).map(environmentName).sort()
      .map((name) => [name.toLowerCase(), name])).values()];
  } catch (error) {
    environmentsValid = false;
    results.fail('github.environments', error);
  }
  try { runner = runnerScope(scope.runner, repository); } catch (error) { results.fail('github.runner', error); }

  const bindings = new Map<string, ValidatedAzureBinding>();
  const conflictingBindings = new Set<string>();
  try {
    for (const input of list(scope.azure)) {
      try {
        const bound = azureBinding(record(input) as unknown as LiveAssessmentScope['azure'][number], environments);
        const key = bound.resourceId.toLowerCase();
        const previous = bindings.get(key);
        if (conflictingBindings.has(key) || (previous && (previous.environment !== bound.environment || previous.role !== bound.role))) {
          bindings.delete(key);
          conflictingBindings.add(key);
          throw new LiveFailure('unsafe-azure-scope', 'The same ARM resource had conflicting environment or role bindings.');
        }
        if (!previous || JSON.stringify(bound) < JSON.stringify(previous)) bindings.set(key, bound);
      } catch (error) {
        azureScopeValid = false;
        results.fail('azure.resources', error);
        results.fail('azure.providers', error);
      }
    }
  } catch (error) {
    azureScopeValid = false;
    results.fail('azure.resources', error);
    results.fail('azure.providers', error);
  }
  const azure = [...bindings.values()].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
  const providerScopes = [...new Map(azure.flatMap((binding) => {
    const namespaces = binding.resourceType === 'GitHub.Network/networkSettings'
      ? [binding.namespace, 'Microsoft.Network'] : [binding.namespace];
    return namespaces.map((namespace) => [
      `${binding.subscriptionId.toLowerCase()}/${namespace}`,
      {
        subscriptionId: binding.subscriptionId, namespace,
        providerUrl: `https://management.azure.com/subscriptions/${binding.subscriptionId}/providers/${namespace}?api-version=2021-04-01`
      }
    ] as const);
  })).values()];
  const validatedScope: LiveAssessmentScope = { repository, refs, environments, runner, azure };
  const transport = new LiveTransport(
    options.runner ?? new NodeCommandRunner(), now, validatedScope,
    new Set([...azure.map((binding) => binding.url), ...providerScopes.map((binding) => binding.providerUrl)]),
    (diagnostic) => results.diagnostics.push(diagnostic)
  );
  const repositoryUrl = transport.githubUrl('repository').href;
  let repositoryData: Record<string, unknown> | undefined;
  const repositoryValue = await results.capture('github.repository', repositoryUrl, async () => {
    const input = record(await transport.github('repository'));
    const numericId = id(input.id);
    const nodeId = text(input.node_id);
    const fullName = text(input.full_name);
    if (fullName.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase() ||
        (repository.id !== null && (repository.id.startsWith('R_') ? nodeId !== repository.id : String(numericId) !== repository.id))) {
      throw new LiveFailure('repository-identity', 'The resolved GitHub repository did not match the expected full name and identity.');
    }
    const value = { id: numericId, nodeId, fullName, defaultBranch: branchName(input.default_branch) };
    repositoryData = input;
    return value;
  });
  if (!repositoryValue || !repositoryData) {
    for (const family of families.filter((key) => key !== 'github.repository')) {
      results.fail(family, new LiveFailure('unverified-scope', 'Repository identity was not verified; dependent live reads were withheld.'));
    }
    return results.finish(false);
  }
  transport.verifyRepository();
  try {
    results.put('github.security', normalizeSecurity(repositoryData.security_and_analysis), repositoryUrl);
  } catch (error) { results.fail('github.security', error, repositoryUrl); }
  repositoryData = undefined;

  const heads = new Map<string, { sha: string; protected: boolean }>();
  let refsStable = refsValid;
  const base = `https://api.github.com/repos/${repository.owner}/${repository.name}`;

  const collectActionsApp = async () => results.capture(
    'github.actions-app', transport.githubUrl('actions-app').href, async () => {
      const app = record(await transport.github('actions-app'));
      const slug = text(app.slug);
      if (slug !== 'github-actions') {
        throw new LiveFailure('scope-mismatch', 'The public app response did not identify the requested GitHub Actions application.');
      }
      return { id: id(app.id), slug };
    }
  );

  const collectRulesets = async () => results.capture('github.rulesets', `${base}/rulesets`, async () => {
    const inventory = await transport.pages('rulesets', null, (value) => {
      const input = record(value);
      const numericId = id(input.id);
      return {
        key: String(numericId),
        value: {
          id: numericId,
          ...(Object.hasOwn(input, 'source_type') ? { source_type: text(input.source_type) } : {}),
          ...(Object.hasOwn(input, 'source') ? { source: text(input.source) } : {})
        }
      };
    });
    const rulesets: JsonValue[] = [];
    let size = 0;
    for (const summary of inventory.sort((a, b) => a.id - b.id)) {
      const numericId = summary.id;
      const details = { ...record(await transport.github('ruleset', numericId)) };
      for (const field of ['source_type', 'source'] as const) {
        if (Object.hasOwn(summary, field) && Object.hasOwn(details, field) &&
            text(summary[field]).toLowerCase() !== text(details[field]).toLowerCase()) {
          throw new LiveFailure('scope-mismatch', 'Ruleset source identity disagreed between inventory and detail reads.');
        }
        if (!Object.hasOwn(details, field) && Object.hasOwn(summary, field)) details[field] = summary[field];
      }
      const ruleset = record(normalizeRuleset(details));
      if (ruleset.id !== numericId ||
          !['Repository', 'Organization', 'Enterprise'].includes(text(ruleset.source_type)) ||
          (ruleset.source_type === 'Repository' &&
            text(ruleset.source).toLowerCase() !== repositoryValue.fullName.toLowerCase()) ||
          (ruleset.source_type === 'Organization' &&
            text(ruleset.source).toLowerCase() !== repository.owner.toLowerCase())) {
        throw new LiveFailure('scope-mismatch', 'Ruleset details did not match the requested repository and ruleset identity.');
      }
      const value = jsonValue(ruleset);
      size += Buffer.byteLength(JSON.stringify(value));
      if (size > assessmentLimits.responseBytes) throw new LiveFailure('size-limit', 'Normalized ruleset metadata exceeded the byte limit.');
      rulesets.push(value);
    }
    return sorted(rulesets);
  });

  const collectBranches = async () => {
    if (!refsValid) { refsStable = false; return; }
    if (!refs.length) {
      const error = new LiveFailure('refs-unbound', 'No exact branch refs were supplied; branch and check discovery was not attempted.');
      results.fail('github.branches', error);
      results.fail('github.checks', error);
      return;
    }
    const branches: JsonValue[] = [];
    let completeBranches = 0;
    const checks: JsonValue[] = [];
    for (const ref of refs) {
      const branchKey = `github.branch.${ref}`;
      const checkKey = `github.checks.${ref}`;
      const branchUrl = transport.githubUrl('branch', ref).href;
      let branch: { name: string; sha: string; protected: boolean };
      try {
        const input = record(await transport.github('branch', ref));
        if (text(input.name) !== ref) throw new LiveFailure('scope-mismatch', 'Branch metadata did not match the exact requested ref.');
        branch = { name: ref, sha: sha(record(input.commit).sha), protected: boolean(input.protected) };
        heads.set(ref, { sha: branch.sha, protected: branch.protected });
        transport.bindSha(branch.sha);
      } catch (error) {
        results.fail(branchKey, error, branchUrl);
        results.fail(checkKey, new LiveFailure('unverified-ref', 'The branch SHA could not be verified; check reads were withheld.'));
        refsStable = false;
        continue;
      }
      const [protection, runs] = await Promise.all([
        results.capture(branchKey, branchUrl, async () => {
          const effectiveRules = sorted(await transport.pages('branch-rules', null, (value) => {
            const rule = normalizeRule(value);
            return { key: JSON.stringify(rule), value: rule };
          }, ref));
          const classic = branch.protected ? normalizeProtection(await transport.github('protection', ref)) : null;
          if (!branch.protected && effectiveRules.length) {
            throw new LiveFailure('inconsistent-response', 'Branch protection metadata changed or contradicted the effective rules.');
          }
          return {
            ...branch, protection: branch.protected ? { classic, effectiveRules } : null, protectionObserved: true
          };
        }, branch.sha),
        results.capture(checkKey, transport.githubUrl('checks', branch.sha).href, async () => ({
          ref, name: ref, sha: branch.sha,
          checks: sorted(await transport.pages('checks', 'check_runs', (value) => normalizeCheck(value, branch.sha), branch.sha))
        }), branch.sha)
      ]);
      if (protection !== undefined) {
        branches.push(protection);
        completeBranches += 1;
      } else {
        const facts = { ...branch, protection: null, protectionObserved: false };
        branches.push(facts);
        results.retainFacts(branchKey, facts, branchUrl, branch.sha);
      }
      if (runs !== undefined) checks.push(runs);
    }
    if (completeBranches === refs.length) {
      try { results.put('github.branches', sorted(branches), `${base}/branches`); } catch (error) { results.fail('github.branches', error); }
    } else {
      results.fail('github.branches', new LiveFailure('incomplete-branches', 'One or more requested branches lacked complete protection metadata.'));
      if (branches.length) results.retainFacts('github.branches', sorted(branches), `${base}/branches`);
    }
    if (checks.length === refs.length) {
      try { results.put('github.checks', sorted(checks), `${base}/commits`); } catch (error) { results.fail('github.checks', error); }
    } else results.fail('github.checks', new LiveFailure('incomplete-checks', 'One or more requested refs lacked complete SHA-bound check metadata.'));
  };

  const collectEnvironments = async () => {
    if (!environmentsValid) return;
    if (!environments.length) {
      results.fail('github.environments', new LiveFailure('environments-unbound', 'No deployment environment scope was supplied.'));
      return;
    }
    await results.capture('github.environments', `${base}/environments`, async () => {
      const inventory = await transport.pages('environments', 'environments', (value) => normalizeEnvironment(value, environments));
      const selected = sorted(inventory.filter((entry) => environments.includes(entry.name)));
      for (const entry of selected) {
        if (isRecord(entry.deploymentBranchPolicy) && entry.deploymentBranchPolicy.custom_branch_policies === true) {
          const policies = await transport.pages('environment-policies', 'branch_policies', (value) => {
            const policy = record(value);
            const numericId = id(policy.id);
            const type = text(policy.type);
            if (type !== 'branch' && type !== 'tag') throw new LiveFailure('unsupported-response', 'An unknown deployment policy type was returned.');
            return { key: String(numericId), value: { id: numericId, name: text(policy.name), type } };
          }, entry.name);
          entry.deploymentBranchPolicy = jsonValue({ ...entry.deploymentBranchPolicy, branchPolicies: sorted(policies) });
        }
      }
      for (const name of environments) {
        const entry = selected.find((value) => value.name === name);
        if (entry) results.put(`github.environment.${name}`, entry, `${base}/environments`);
        else results.missing(
          `github.environment.${name}`, 'The complete repository environment inventory did not contain the scoped environment.',
          source('github', `${base}/environments`, results.capturedAt, selected)
        );
      }
      return sorted(selected);
    });
  };

  const collectWorkflows = async () => results.capture('github.workflows', `${base}/actions/workflows`, async () => sorted(
    await transport.pages('workflows', 'workflows', (value) => {
      const workflow = record(value);
      const numericId = id(workflow.id);
      return {
        key: String(numericId),
        value: { id: numericId, name: text(workflow.name), path: text(workflow.path), state: text(workflow.state) }
      };
    })
  ));

  const collectRunner = async () => {
    if (!runner) return;
    const bound = runner;
    const location = transport.githubUrl('runner').href;
    await results.capture('github.runner', location, async () => {
      const rawRunner = record(await transport.github('runner'));
      if (id(rawRunner.id) !== bound.runnerId || id(rawRunner.runner_group_id) !== bound.groupId) {
        throw new LiveFailure('scope-mismatch', 'The hosted runner did not match the exact bound runner and group IDs.');
      }
      const group = record(await transport.github('runner-group'));
      if (id(group.id) !== bound.groupId || text(group.network_configuration_id) !== bound.networkConfigurationId) {
        throw new LiveFailure('scope-mismatch', 'The runner group did not match the exact bound group and network IDs.');
      }
      const network = record(await transport.github('runner-network'));
      if (text(network.id) !== bound.networkConfigurationId) {
        throw new LiveFailure('scope-mismatch', 'Network metadata did not match its existing bound identity.');
      }
      // GitHub's assignment read is filtered to this repository, never an all-org inventory.
      const assignedGroups = await transport.pages('runner-assignment', 'runner_groups', (value) => {
        const group = record(value);
        const numericId = id(group.id);
        if (numericId === bound.groupId && group.network_configuration_id !== undefined &&
            text(group.network_configuration_id) !== bound.networkConfigurationId) {
          throw new LiveFailure('scope-mismatch', 'The repository assignment changed its network configuration during observation.');
        }
        return { key: String(numericId), value: numericId };
      });
      const size = rawRunner.machine_size_details === undefined || rawRunner.machine_size_details === null
        ? null : record(rawRunner.machine_size_details);
      return {
        organization: repository.owner, repository: repositoryValue.fullName,
        runnerId: bound.runnerId, groupId: bound.groupId, networkConfigurationId: bound.networkConfigurationId,
        repositoryAssigned: assignedGroups.includes(bound.groupId!),
        runner: {
          id: bound.runnerId, name: text(rawRunner.name), status: text(rawRunner.status),
          runnerGroupId: bound.groupId, networkConfigurationId: bound.networkConfigurationId,
          labels: rawRunner.labels === undefined ? null
            : sorted(list(rawRunner.labels).map((entry) => text(typeof entry === 'string' ? entry : record(entry).name))),
          maximumRunners: rawRunner.maximum_runners === undefined ? null : numeric(rawRunner.maximum_runners),
          publicIpEnabled: rawRunner.public_ip_enabled === undefined ? null : boolean(rawRunner.public_ip_enabled),
          machineSize: size === null ? null : {
            id: text(size.id), cpuCores: numeric(size.cpu_cores), memoryGb: numeric(size.memory_gb), storageGb: numeric(size.storage_gb)
          }
        },
        group: {
          id: bound.groupId, name: text(group.name), visibility: text(group.visibility),
          networkConfigurationId: bound.networkConfigurationId,
          allowsPublicRepositories: boolean(group.allows_public_repositories),
          restrictedToWorkflows: boolean(group.restricted_to_workflows),
          selectedWorkflows: sorted(list(group.selected_workflows).map(text)),
          inherited: group.inherited === undefined ? null : boolean(group.inherited)
        },
        network: {
          id: bound.networkConfigurationId, name: text(network.name), computeService: text(network.compute_service),
          networkSettingsIds: sorted(list(network.network_settings_ids).map(text)),
          failoverNetworkSettingsIds: network.failover_network_settings_ids === undefined ? null
            : sorted(list(network.failover_network_settings_ids).map(text)),
          failoverNetworkEnabled: network.failover_network_enabled === undefined ? null : boolean(network.failover_network_enabled)
        }
      };
    });
  };

  const collectAzure = async () => {
    if (!azure.length) {
      if (azureScopeValid) {
        const error = new LiveFailure('azure-unbound', 'No explicit subscription, environment and resource bindings were available; Azure discovery was not attempted.');
        results.fail('azure.providers', error);
        results.fail('azure.resources', error);
      }
      return;
    }
    const providers: JsonValue[] = [];
    for (const binding of providerScopes) {
      const value = await results.capture(
        `azure.provider.${binding.subscriptionId}.${binding.namespace}`, binding.providerUrl, async () => {
          const provider = record(await transport.azure(binding.providerUrl));
          if (text(provider.namespace).toLowerCase() !== binding.namespace.toLowerCase() ||
              (provider.id !== undefined && text(provider.id).toLowerCase() !==
                `/subscriptions/${binding.subscriptionId}/providers/${binding.namespace}`.toLowerCase())) {
            throw new LiveFailure('scope-mismatch', 'Provider metadata did not match the explicitly scoped subscription and namespace.');
          }
          return {
            subscriptionId: binding.subscriptionId, namespace: binding.namespace, registrationState: text(provider.registrationState)
          };
        }
      );
      if (value !== undefined) providers.push(value);
    }
    const resources: JsonValue[] = [];
    for (const binding of azure) {
      const value = await results.capture(
        `azure.resource.${binding.environment}.${binding.resourceId}`, binding.url,
        async () => normalizeResource(await transport.azure(binding.url), binding)
      );
      if (value !== undefined) resources.push(value);
    }
    if (azureScopeValid && providers.length === providerScopes.length) {
      try { results.put('azure.providers', sorted(providers), 'https://management.azure.com (explicit subscription/provider bindings)'); }
      catch (error) { results.fail('azure.providers', error); }
    } else results.fail('azure.providers', new LiveFailure('incomplete-providers', 'Not every explicitly scoped provider could be observed.'));
    if (azureScopeValid && resources.length === azure.length) {
      try { results.put('azure.resources', sorted(resources), 'https://management.azure.com (explicit environment/resource bindings)'); }
      catch (error) { results.fail('azure.resources', error); }
    } else results.fail('azure.resources', new LiveFailure('incomplete-resources', 'Not every explicitly scoped resource could be observed.'));
  };

  await Promise.all([
    collectActionsApp(), collectRulesets(), collectBranches(), collectEnvironments(), collectWorkflows(), collectRunner(), collectAzure()
  ]);

  for (const [ref, original] of heads) {
    try {
      const current = record(await transport.github('branch', ref));
      if (text(current.name) !== ref || sha(record(current.commit).sha) !== original.sha) {
        throw new LiveFailure('ref-moved', 'A scoped branch moved during live collection; its branch and check observations were withheld.');
      }
      if (boolean(current.protected) !== original.protected) {
        throw new LiveFailure('branch-changed', 'Scoped branch protection metadata changed during live collection; its snapshot was withheld.');
      }
    } catch (error) {
      refsStable = false;
      results.fail(`github.branch.${ref}`, error, transport.githubUrl('branch', ref).href);
      results.fail(`github.checks.${ref}`, error);
      results.fail('github.branches', new LiveFailure('unstable-refs', 'Requested refs could not be verified as stable across live collection.'));
      results.fail('github.checks', new LiveFailure('unstable-refs', 'Commit-bound check proof was withheld because ref stability was not established.'));
    }
  }
  return results.finish(refsStable);
}
