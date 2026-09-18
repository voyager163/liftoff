import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { AssessmentInputError, LiveFailure } from '../../domain/governance/assessment/errors.js';
import {
  boolean, minimumApprovals, normalizeProtection, text as publicText, type JsonValue
} from '../../domain/governance/assessment/live-normalize.js';
import { parseAssessmentWorkflow } from '../../domain/governance/assessment/yaml.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import {
  apiPath, expectStatus, GitHubActivationClient, GitHubActivationError,
  githubName, githubRef, githubRepository, object, positiveId
} from './activation-rest.js';
import { readbackWorkflowContent } from './production-workflows.js';
import { readGitHubRulesetInventory, type GitHubRulesetObservation } from './ruleset-observation.js';

export interface RepositoryIdentityDiscovery {
  id: number;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  owner: { login: string; type: 'User' | 'Organization'; id: number };
  permissions: Readonly<Record<string, boolean>> | null;
  securityAndAnalysis: Readonly<Record<string, { status: 'enabled' | 'disabled' }>> | null;
}

export interface DiscoveredBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface DiscoveredCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  appId: number;
  appSlug: string;
}

export interface DiscoveredWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  sourceSha: string;
  blobSha: string;
  sourceDigest: string;
  jobs: readonly { id: string; name: string }[];
}

export interface RepositoryGovernanceDiscoveryReport {
  repository: RepositoryIdentityDiscovery;
  branches: readonly DiscoveredBranch[];
  branchProtections: Readonly<Record<string, JsonValue>>;
  rulesets: readonly Record<string, unknown>[];
  rulesetMetadata: Readonly<Record<string, GitHubRulesetObservation['metadata']>>;
  workflows: readonly DiscoveredWorkflow[];
  checksByRef: Readonly<Record<string, readonly DiscoveredCheckRun[]>>;
  capabilities: {
    actionsEnabled: boolean;
    allowedActions: 'all' | 'local_only' | 'selected' | null;
    selectedActions: {
      githubOwnedAllowed: boolean;
      verifiedAllowed: boolean;
      patternsAllowed: readonly string[];
    } | null;
    tokenPermissions: {
      default_workflow_permissions: 'read' | 'write';
      can_approve_pull_request_reviews: boolean;
    };
  };
  unobserved: readonly string[];
  observationDigest: string;
  observedAt: string;
}

type RepositorySnapshot = Omit<RepositoryGovernanceDiscoveryReport, 'observedAt' | 'observationDigest'>;
const maxDiscoveryRequests = 160;
const discoveryTimeLimitMs = 120_000;

function unique<T>(entries: readonly T[], key: (entry: T) => string | number, label: string): T[] {
  const keys = entries.map(key);
  if (new Set(keys).size !== keys.length) {
    throw new GitHubActivationError('incomplete-observation', `${label} contains duplicate identities; discovery is not a complete stable inventory.`);
  }
  return [...entries].sort((left, right) => String(key(left)).localeCompare(String(key(right)), 'en'));
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  for (const candidate of values) if (value === candidate) return candidate;
  throw new GitHubActivationError('unsupported-response', `${label} contains an unknown or malformed provider value.`);
}

async function repositoryIdentity(
  client: GitHubActivationClient, target: string, expectedRepositoryId?: number
): Promise<RepositoryIdentityDiscovery> {
  const value = await client.get(`/repos/${target}`);
  const name = githubRepository(value.full_name);
  const owner = object(value.owner, 'Repository owner');
  const login = githubName(owner.login, 'Repository owner login');
  const id = positiveId(value.id, 'Repository ID');
  if (expectedRepositoryId !== undefined && id !== expectedRepositoryId) {
    throw new GitHubActivationError('repository-binding', 'Repository discovery differs from the independently verified publication binding.');
  }
  if (name.toLowerCase() !== target.toLowerCase() ||
    name.split('/')[0]!.toLowerCase() !== login.toLowerCase() ||
    value.name !== name.split('/')[1]) {
    throw new GitHubActivationError('repository-binding', 'Observed repository/owner identity differs from the exact requested repository.');
  }
  let permissions: Record<string, boolean> | null = null;
  if (value.permissions !== undefined) {
    const entries = object(value.permissions, 'Repository permissions');
    if (Object.keys(entries).some((key) => !['admin', 'maintain', 'push', 'triage', 'pull'].includes(key))) {
      throw new GitHubActivationError('unsupported-response', 'Repository permissions contain an unsupported authority field.');
    }
    permissions = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, boolean(entry)]));
  }
  let securityAndAnalysis: Record<string, { status: 'enabled' | 'disabled' }> | null = null;
  if (value.security_and_analysis !== undefined && value.security_and_analysis !== null) {
    securityAndAnalysis = Object.fromEntries(Object.entries(object(value.security_and_analysis)).map(([key, entry]) => {
      if (!/^[a-z][a-z0-9_]{0,99}$/u.test(key)) {
        throw new GitHubActivationError('unsupported-response', 'Repository security capability has an unsupported name.');
      }
      const control = object(entry);
      if (Object.keys(control).some((field) => field !== 'status')) {
        throw new GitHubActivationError('unsupported-response', 'Repository security capability contains unsupported configuration.');
      }
      return [key, { status: oneOf(control.status, ['enabled', 'disabled'], 'Security capability') }];
    }));
  }
  return {
    id, name,
    defaultBranch: githubRef(value.default_branch), isPrivate: boolean(value.private),
    owner: { login, type: oneOf(owner.type, ['User', 'Organization'], 'Repository owner type'), id: positiveId(owner.id, 'Owner ID') },
    permissions, securityAndAnalysis
  };
}

function knownProtectionFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = object(value, 'Branch protection');
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new GitHubActivationError('unsupported-response', 'Branch protection contains unknown enforcement metadata; complete discovery is blocked.');
  }
  return record;
}

function validateProtectionFields(value: unknown): void {
  const toggles = [
    'enforce_admins', 'required_linear_history', 'allow_force_pushes', 'allow_deletions', 'block_creations',
    'required_conversation_resolution', 'required_signatures', 'lock_branch', 'allow_fork_syncing'
  ];
  const protection = knownProtectionFields(value, ['url', 'required_status_checks', 'required_pull_request_reviews', 'restrictions', ...toggles]);
  for (const key of toggles) if (Object.hasOwn(protection, key)) knownProtectionFields(protection[key], ['url', 'enabled']);
  if (protection.required_status_checks !== undefined && protection.required_status_checks !== null) {
    const checks = knownProtectionFields(protection.required_status_checks, ['url', 'contexts_url', 'strict', 'contexts', 'checks']);
    if (Array.isArray(checks.checks)) {
      for (const check of checks.checks) knownProtectionFields(check, ['context', 'app_id']);
    }
  }
  const actors = ['url', 'users_url', 'teams_url', 'apps_url', 'users', 'teams', 'apps'];
  if (protection.restrictions !== undefined && protection.restrictions !== null) knownProtectionFields(protection.restrictions, actors);
  if (protection.required_pull_request_reviews !== undefined && protection.required_pull_request_reviews !== null) {
    const reviews = knownProtectionFields(protection.required_pull_request_reviews, [
      'url', 'dismissal_restrictions', 'dismiss_stale_reviews', 'require_code_owner_reviews',
      'required_approving_review_count', 'require_last_push_approval', 'bypass_pull_request_allowances'
    ]);
    minimumApprovals(reviews.required_approving_review_count);
    for (const key of ['dismissal_restrictions', 'bypass_pull_request_allowances']) {
      if (Object.hasOwn(reviews, key)) knownProtectionFields(reviews[key], actors);
    }
  }
}

async function branchProtection(client: GitHubActivationClient, repository: string, branch: DiscoveredBranch): Promise<JsonValue> {
  const endpoint = `/repos/${repository}/branches/${encodeURIComponent(branch.name)}/protection`;
  const response = await client.transport.request({ method: 'GET', path: apiPath(endpoint) });
  // A generic masked 404 is not authoritative absence of classic protection.
  if (response.status === 404 && object(response.data).message === 'Branch not protected') return null;
  const data = expectStatus(response, [200], `Read protection for ${branch.name}`).data;
  validateProtectionFields(data);
  return normalizeProtection(data);
}

async function snapshot(client: GitHubActivationClient, target: string, expectedRepositoryId?: number): Promise<RepositorySnapshot> {
  const repository = await repositoryIdentity(client, target, expectedRepositoryId);
  const branches = unique((await client.list(`/repos/${target}/branches`)).map((branch) => ({
    name: githubRef(branch.name), sha: sourceSha(object(branch.commit).sha), protected: boolean(branch.protected)
  })), (branch) => branch.name, 'Branch inventory');
  const defaultBranch = branches.find((branch) => branch.name === repository.defaultBranch);
  if (!defaultBranch) throw new GitHubActivationError('incomplete-observation', 'The observed default branch is absent from the complete branch inventory.');

  const workflows: DiscoveredWorkflow[] = [];
  const workflowSummaries = unique(await client.list(`/repos/${target}/actions/workflows`, 'workflows'),
    (workflow) => positiveId(workflow.id, 'Workflow ID'), 'Workflow inventory');
  for (const workflow of workflowSummaries) {
    const path = publicText(workflow.path);
    const source = await readbackWorkflowContent(client, target, path, defaultBranch.sha);
    const parsed = parseAssessmentWorkflow(source.content, path);
    const jobs = object(parsed.value.jobs, 'Workflow jobs');
    if (Object.keys(jobs).length === 0 || Object.keys(jobs).length > 64) {
      throw new GitHubActivationError('bounded-discovery', 'Workflow job inventory is empty or exceeds the 64-job discovery bound.');
    }
    workflows.push({
      id: positiveId(workflow.id, 'Workflow ID'), name: publicText(workflow.name), path,
      state: oneOf(workflow.state, ['active', 'deleted', 'disabled_fork', 'disabled_inactivity', 'disabled_manually'], 'Workflow state'),
      sourceSha: source.sourceSha, blobSha: source.blobSha, sourceDigest: source.contentDigest,
      jobs: Object.entries(jobs).map(([id, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(id)) throw new GitHubActivationError('unsupported-response', 'Workflow job has an unsupported identifier.');
        const job = object(value, 'Workflow job');
        return { id, name: job.name === undefined ? id : publicText(job.name) };
      }).sort((left, right) => left.id.localeCompare(right.id, 'en'))
    });
  }
  unique(workflows, (workflow) => workflow.path, 'Workflow source inventory');
  const controls = await readGitHubRulesetInventory(client, target);
  const rulesets = controls.map((control) => control.definition);
  const rulesetMetadata = Object.fromEntries(controls.map((control) => [String(control.definition.id), control.metadata]));
  const checksByRef: Record<string, DiscoveredCheckRun[]> = {};
  const branchProtections: Record<string, JsonValue> = {};
  for (const branch of branches.filter((entry) => /^(?:develop|main|release\/.+|hotfix\/.+)$/u.test(entry.name))) {
    branchProtections[branch.name] = await branchProtection(client, target, branch);
    const runs = await client.list(`/repos/${target}/commits/${branch.sha}/check-runs?filter=latest`, 'check_runs');
    checksByRef[branch.name] = unique(runs.map((run) => {
      const app = object(run.app, 'Check run App');
      const headSha = sourceSha(run.head_sha);
      if (headSha !== branch.sha) throw new GitHubActivationError('check-binding', 'A check run belongs to a different observed branch commit.');
      const status = oneOf(run.status, ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'], 'Check status');
      const conclusion = run.conclusion === null ? null : oneOf(run.conclusion,
        ['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'skipped', 'startup_failure'], 'Check conclusion');
      if ((status === 'completed') !== (conclusion !== null)) {
        throw new GitHubActivationError('incomplete-observation', 'A check run has contradictory status and conclusion.');
      }
      return {
        id: positiveId(run.id, 'Check run ID'), name: publicText(run.name), status, conclusion, headSha,
        appId: positiveId(app.id, 'Check run App ID'), appSlug: publicText(app.slug)
      };
    }), (run) => run.id, 'Check run inventory');
  }
  const actions = await client.get(`/repos/${target}/actions/permissions`);
  const actionsEnabled = boolean(actions.enabled);
  const allowedActions = actions.allowed_actions === undefined && !actionsEnabled ? null :
    oneOf(actions.allowed_actions, ['all', 'local_only', 'selected'], 'Actions permission policy');
  let selectedActions: RepositoryGovernanceDiscoveryReport['capabilities']['selectedActions'] = null;
  if (allowedActions === 'selected') {
    const selected = await client.get(`/repos/${target}/actions/permissions/selected-actions`);
    if (!Array.isArray(selected.patterns_allowed) || selected.patterns_allowed.length > 1000) {
      throw new GitHubActivationError('incomplete-observation', 'Selected Actions allowlist is absent or exceeds the bounded inventory.');
    }
    selectedActions = {
      githubOwnedAllowed: boolean(selected.github_owned_allowed), verifiedAllowed: boolean(selected.verified_allowed),
      patternsAllowed: unique(selected.patterns_allowed.map(publicText), (entry) => entry, 'Selected Actions allowlist')
    };
  }
  const token = await client.get(`/repos/${target}/actions/permissions/workflow`);
  const tokenPermissions = {
    default_workflow_permissions: oneOf(token.default_workflow_permissions, ['read', 'write'], 'Workflow token permissions'),
    can_approve_pull_request_reviews: boolean(token.can_approve_pull_request_reviews)
  };
  return {
    repository, branches, branchProtections, workflows, rulesets, rulesetMetadata, checksByRef,
    capabilities: { actionsEnabled, allowedActions, selectedActions, tokenPermissions },
    unobserved: [
      ...(repository.permissions === null ? ['repository.permissions'] : []),
      ...(repository.securityAndAnalysis === null ? ['repository.security_and_analysis'] : [])
    ]
  };
}

export async function discoverRepositoryGovernance(
  client: GitHubActivationClient,
  repositoryName: string,
  now: Date = new Date(),
  expectedRepositoryId?: number
): Promise<RepositoryGovernanceDiscoveryReport> {
  const target = githubRepository(repositoryName);
  if (expectedRepositoryId !== undefined) positiveId(expectedRepositoryId, 'Expected repository ID');
  if (!Number.isFinite(now.getTime())) throw new GitHubActivationError('invalid-input', 'Discovery requires a valid observation timestamp.');
  const deadline = performance.now() + discoveryTimeLimitMs;
  let requests = 0;
  const bounded = new GitHubActivationClient({
    async request(request) {
      if (request.method !== 'GET' || request.body !== undefined || request.binary ||
        request.path !== `/repos/${target}` && !request.path.startsWith(`/repos/${target}/`)) {
        throw new GitHubActivationError('discovery-scope', 'Repository discovery can only read the exact selected repository; no organization or Azure access is permitted.');
      }
      if (++requests > maxDiscoveryRequests || performance.now() >= deadline) {
        throw new GitHubActivationError('bounded-discovery', 'Repository discovery exceeded its 160-request or two-minute observation budget; no partial inventory is complete.');
      }
      const response = await client.transport.request({ ...request, path: apiPath(request.path) });
      if (performance.now() >= deadline) throw new GitHubActivationError('bounded-discovery', 'Repository discovery exceeded its observation deadline.');
      return response;
    }
  });
  try {
    const first = await snapshot(bounded, target, expectedRepositoryId);
    const second = await snapshot(bounded, target, expectedRepositoryId);
    if (canonicalSha256(first) !== canonicalSha256(second)) {
      throw new GitHubActivationError('discovery-changed', 'Repository identity, refs, workflow bytes, controls or capabilities changed during discovery; repeat inspection against stable provider state.');
    }
    return { ...second, observationDigest: canonicalSha256(second), observedAt: now.toISOString() };
  } catch (error) {
    if (error instanceof LiveFailure || error instanceof AssessmentInputError) {
      throw new GitHubActivationError(error.code, `Repository discovery could not normalize required public metadata: ${error.message}`);
    }
    if (error instanceof GitHubActivationError && error.status === 404 && requests === 1) {
      throw new GitHubActivationError('repository-missing', `Repository ${target} is absent or not visible to the authorized identity. Check the exact repository and permissions.`);
    }
    if (error instanceof GitHubActivationError && error.status === 403 && requests === 1) {
      throw new GitHubActivationError('insufficient-permissions', `The authorized identity lacks read access to repository ${target}.`);
    }
    throw error;
  }
}
