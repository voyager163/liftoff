import { parseDocument } from 'yaml';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import {
  GitHubActivationError, GitHubActivationClient, githubRef, object, positiveId, safeGitHubFailure, text
} from '../adapters/github/activation-rest.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from './transition-ports.js';
import { cloneState, readbackProof } from './transition-records.js';
import { clientFor, githubOperation, repositoryConfiguration, sourceSha } from './github-config.js';
import { inspectGitRepository, reviewedPushUrl } from './phase-publication.js';
import { githubRepositoryFromPushUrl } from '../domain/governance/activation/inputs.js';
import { hasGeneratedWorkload, isApiManifestWorkload } from '../domain/project/manifest/applicability.js';
import { missingGeneratedLocalEngine } from './seed-lifecycle.js';

interface DiscoveryObservation {
  status: 'observed' | 'unknown';
  values?: unknown;
  prerequisite?: string;
}

export async function classifyGitHubWorkload(
  inspection: Pick<GovernanceTransitionInspection, 'projectRoot' | 'manifest'> & Partial<Pick<GovernanceTransitionInspection, 'state'>>
): Promise<Record<string, unknown>> {
  const workload = inspection.manifest.project.workload;
  if (!isApiManifestWorkload(workload)) {
    return {
      kind: 'components', artifactKind: 'unknown', commandsExecutedByDiscovery: false,
      missing: [missingGeneratedLocalEngine],
      environments: []
    };
  }
  if (!hasGeneratedWorkload(inspection.manifest)) {
    return {
      kind: workload.kind, stack: workload.apiStack, environments: workload.environments, frontend: workload.frontend,
      artifactKind: 'unknown', commandsExecutedByDiscovery: false, localBaseline: 'missing-local-engine',
      missing: [missingGeneratedLocalEngine], files: [], containers: []
    };
  }
  const stack = workload.apiStack;
  const paths = stack === 'node-fastify' ? ['backend/package.json', 'backend/package-lock.json'] :
    stack === 'python-fastapi' ? ['backend/pyproject.toml', 'backend/uv.lock'] : ['backend/go.mod', 'backend/go.sum'];
  const files: { path: string; digest: string }[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    const bytes = await readProjectFile(inspection.projectRoot, path.split('/'));
    if (!bytes) { missing.push(path); continue; }
    files.push({ path, digest: canonicalSha256(bytes.toString('base64')) });
  }
  let commands: { build: readonly string[]; test: readonly string[] };
  if (stack === 'node-fastify') {
    const bytes = await readProjectFile(inspection.projectRoot, ['backend', 'package.json']);
    const packageJson = bytes ? object(JSON.parse(bytes.toString('utf8')), 'Workload package.json') : {};
    const scripts = object(packageJson.scripts ?? {}, 'Workload scripts');
    for (const id of ['build', 'test']) if (typeof scripts[id] !== 'string' || !scripts[id]) missing.push(`backend/package.json scripts.${id}`);
    commands = { build: ['npm', '--prefix', 'backend', 'run', 'build'], test: ['npm', '--prefix', 'backend', 'test'] };
  } else if (stack === 'python-fastapi') {
    commands = { build: ['uv', 'sync', '--frozen', '--project', 'backend'], test: ['uv', 'run', '--project', 'backend', 'pytest'] };
  } else if (stack === 'go-huma') {
    commands = { build: ['go', '-C', 'backend', 'build', './...'], test: ['go', '-C', 'backend', 'test', './...'] };
  } else throw new GitHubActivationError('unsupported-workload', 'Activation supports the recorded node-fastify, python-fastapi, and go-huma container workloads; an unknown workload needs an explicit producer recipe.');
  const dockerfiles = inspection.manifest.projectArtifacts.filter((artifact) =>
    artifact.pathParts.at(-1) === 'Dockerfile' && artifact.pathParts[0] !== 'frontend');
  const containers: { path: string; digest: string }[] = [];
  for (const artifact of dockerfiles) {
    const bytes = await readProjectFile(inspection.projectRoot, [...artifact.pathParts]);
    if (bytes) containers.push({ path: artifact.pathParts.join('/'), digest: canonicalSha256(bytes.toString('base64')) });
  }
  if (!containers.length) missing.push('recorded application Dockerfile');
  return {
    artifactKind: containers.length ? 'container-image' : 'unknown', stack, kind: workload.kind,
    environments: workload.environments, frontend: workload.frontend, files, containers, commands,
    commandsExecutedByDiscovery: false,
    localBaseline: inspection.state?.phases['seed-verified'].state === 'verified' ? 'verified-predecessor' : 'not-current',
    healthDepth: 'requires-deployment-probe', missing
  };
}

async function observed(probe: () => Promise<unknown>): Promise<DiscoveryObservation> {
  try { return { status: 'observed', values: await probe() }; }
  catch (error) { return { status: 'unknown', prerequisite: safeGitHubFailure(error) }; }
}

function project(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]]));
}

async function readWorkflowSource(client: GitHubActivationClient, repository: string, path: string, ref: string): Promise<{
  path: string; digest: string; jobs: readonly { id: string; name: string }[];
}> {
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(path)) {
    throw new GitHubActivationError('workflow-source', 'A listed workflow has an unsupported source path; source coverage is unknown.');
  }
  const response = await client.get(`/repos/${repository}/contents/${path}?ref=${ref}`);
  if (response.encoding !== 'base64' || typeof response.content !== 'string' || Number(response.size) > 256 * 1024) {
    throw new GitHubActivationError('workflow-source', 'The listed workflow source is unavailable or exceeds the inspection bound.');
  }
  const bytes = Buffer.from(response.content, 'base64');
  const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true, maxAliasCount: 0 } as never);
  if (document.errors.length) throw new GitHubActivationError('workflow-source', 'The listed workflow contains invalid YAML.');
  const source = object(document.toJS({ maxAliasCount: 0 }), 'Workflow');
  const jobs = object(source.jobs, 'Workflow jobs');
  return {
    path, digest: canonicalSha256(bytes.toString('base64')),
    jobs: Object.entries(jobs).map(([id, value]) => ({ id, name: String(object(value).name ?? id).slice(0, 200) }))
  };
}

export async function observeGitHubPhase0(input: PhasePlanningInput | PhaseAdapterExecutionInput): Promise<{
  repository: Record<string, unknown>;
  workload: Record<string, unknown>;
  observations: Record<string, DiscoveryObservation>;
}> {
  const config = repositoryConfiguration(input.inspection);
  const client = clientFor(input);
  const repo = await client.get(`/repos/${config.name}`);
  if (repo.full_name !== config.name || input.inspection.state.remoteBinding?.id !== String(repo.id)) {
    throw new GitHubActivationError('phase0-binding', 'Phase 0 repository identity differs from independently verified publication.');
  }
  const workload = await classifyGitHubWorkload(input.inspection);
  const repository = {
    id: positiveId(repo.id), name: config.name, defaultBranch: githubRef(repo.default_branch), private: repo.private,
    owner: project(object(repo.owner), ['login', 'type', 'id']),
    permissions: project(object(repo.permissions ?? {}), ['admin', 'push', 'pull', 'maintain']),
    security: repo.security_and_analysis ? Object.fromEntries(Object.entries(object(repo.security_and_analysis)).map(([key, value]) =>
      [key, project(object(value), ['status'])])) : null
  };
  const branches: Record<string, unknown>[] = [];
  const observations: Record<string, DiscoveryObservation> = {};
  observations.branches = await observed(async () => {
    branches.push(...await client.list(`/repos/${config.name}/branches`));
    return branches.map((branch) => ({ name: text(branch.name, 'Branch name'), sha: sourceSha(object(branch.commit).sha), protected: branch.protected }));
  });
  const probes: [string, () => Promise<unknown>][] = [
    ['identity', async () => project(await client.get('/user'), ['id', 'login', 'type'])],
    ['workflows', async () => {
      const workflows = await client.list(`/repos/${config.name}/actions/workflows`, 'workflows');
      return Promise.all(workflows.map(async (workflow) => ({
        ...project(workflow, ['id', 'name', 'path', 'state']),
        source: await readWorkflowSource(client, config.name, text(workflow.path, 'Workflow path'), String(repo.default_branch))
      })));
    }],
    ['rulesets', async () => {
      const rulesets = await client.list(`/repos/${config.name}/rulesets?includes_parents=true`);
      const result = [];
      for (const rule of rulesets) {
        const summary = project(rule, ['id', 'name', 'source_type', 'source', 'target', 'enforcement']);
        if (rule.source_type === 'Repository') {
          const payload = await client.get(`/repos/${config.name}/rulesets/${positiveId(rule.id)}`);
          result.push({ ...summary, payload: project(payload, ['bypass_actors', 'conditions', 'rules']) });
        } else result.push({ ...summary, ownership: 'external-inherited-control-not-modifiable' });
      }
      return result;
    }],
    ['tags', async () => (await client.list(`/repos/${config.name}/tags`)).map((tag) =>
      ({ name: text(tag.name, 'Tag name'), sha: sourceSha(object(tag.commit).sha) }))],
    ['releases', async () => (await client.list(`/repos/${config.name}/releases`)).map((release) =>
      project(release, ['id', 'tag_name', 'target_commitish', 'draft', 'prerelease', 'published_at']))],
    ['environments', async () => {
      const environments = await client.list(`/repos/${config.name}/environments`, 'environments');
      return environments.map((environment) => ({
        ...project(environment, ['id', 'name', 'deployment_branch_policy']),
        protectionRules: Array.isArray(environment.protection_rules) ? environment.protection_rules.map((value) => {
          const rule = object(value);
          return { type: rule.type, reviewers: Array.isArray(rule.reviewers) ? rule.reviewers.length : 0, waitTimer: rule.wait_timer ?? 0 };
        }) : null
      }));
    }],
    ['deployments', async () => (await client.list(`/repos/${config.name}/deployments`)).map((deployment) =>
      project(deployment, ['id', 'sha', 'ref', 'environment', 'transient_environment', 'production_environment', 'created_at']))],
    ['actionsPermissions', async () => ({
      actions: project(await client.get(`/repos/${config.name}/actions/permissions`), ['enabled', 'allowed_actions']),
      token: project(await client.get(`/repos/${config.name}/actions/permissions/workflow`), ['default_workflow_permissions', 'can_approve_pull_request_reviews'])
    })],
    ['codeScanning', async () => {
      const alerts = await client.list(`/repos/${config.name}/code-scanning/alerts?state=open`);
      return { openAlerts: alerts.length, tools: [...new Set(alerts.map((alert) => String(object(alert.tool).name)))] };
    }],
    ['secretProtection', async () => ({
      openAlerts: (await client.list(`/repos/${config.name}/secret-scanning/alerts?state=open`)).length,
      configuration: repository.security
    })],
    ['dependencySecurity', async () => ({ openAlerts: (await client.list(`/repos/${config.name}/dependabot/alerts?state=open`)).length })],
    ['runners', async () => ({
      hosted: (await client.list(`/orgs/${config.name.split('/')[0]}/actions/hosted-runners`, 'runners')).map((runner) =>
        project(runner, ['id', 'name', 'runner_group_id', 'image_details', 'machine_size_details', 'status', 'maximum_runners', 'public_ip_enabled'])),
      groups: (await client.list(`/orgs/${config.name.split('/')[0]}/actions/runner-groups?visible_to_repository=${config.name.split('/')[1]}`, 'runner_groups')).map((group) =>
        project(group, ['id', 'name', 'visibility', 'network_configuration_id', 'restricted_to_workflows', 'selected_workflows', 'inherited', 'allows_public_repositories']))
    })],
    ['networkConfigurations', async () => (await client.list(
      `/orgs/${config.name.split('/')[0]}/settings/network-configurations`, 'network_configurations'
    )).map((network) => project(network, ['id', 'name', 'compute_service', 'network_settings_ids']))]
  ];
  // Bounded sequential reads avoid rate-limit spikes; each inventory has its own completeness outcome.
  for (const [name, probe] of probes) observations[name] = await observed(probe);
  observations.contexts = await observed(async () => {
    if (observations.branches!.status !== 'observed') throw new GitHubActivationError('branches-unknown', 'Branches are unreadable; required-context coverage cannot be inferred.');
    const result = [];
    for (const branch of branches.filter((branch) => /^(?:develop|main|release\/.+|hotfix\/.+)$/u.test(String(branch.name)))) {
      const sha = sourceSha(object(branch.commit).sha);
      const checks = await client.list(`/repos/${config.name}/commits/${sha}/check-runs?filter=latest`, 'check_runs');
      result.push({
        ref: branch.name, sha, checks: checks.map((check) => ({
          ...project(check, ['id', 'name', 'status', 'conclusion', 'head_sha']),
          appId: positiveId(object(check.app).id), appSlug: object(check.app).slug
        }))
      });
    }
    return result;
  });
  return { repository, workload, observations };
}

export async function planGitHubDiscovery(input: PhasePlanningInput): Promise<{ operations: readonly ReturnType<typeof githubOperation>[] }> {
  let repository: string;
  try {
    const git = await inspectGitRepository(input.inspection.projectRoot, input.runner);
    repository = githubRepositoryFromPushUrl(reviewedPushUrl(git));
  } catch {
    repository = repositoryConfiguration(input.inspection).name;
  }
  return { operations: [githubOperation(input, 'github.phase0.discover', 'github-read', {
    repository, coverage: ['source', 'branches', 'contexts', 'workflows', 'rulesets', 'tags', 'releases', 'environments',
      'deployments', 'security', 'actions-permissions', 'identity', 'runners', 'network-configurations']
  }, { type: 'repository', identity: repository, repository })] };
}

export async function executeGitHubDiscovery(input: PhaseAdapterExecutionInput): Promise<PhaseAdapterOutcome> {
  const report = await observeGitHubPhase0(input);
  const facts = [
    { id: 'repository.id', value: String(report.repository.id) },
    { id: 'repository.nameWithOwner', value: String(report.repository.name) },
    { id: 'repository.defaultBranch', value: String(report.repository.defaultBranch) },
    { id: 'repository.isPrivate', value: Boolean(report.repository.private) }
  ];
  const state = cloneState(input.inspection.state);
  // Azure/state applicability is deliberately left to its independent producer.
  const resourceId = `/repos/${report.repository.name}`;
  const unknown = Object.entries(report.observations).filter(([, value]) => value.status === 'unknown').map(([name]) => name);
  const missing = report.workload.missing as string[];
  const mandatory = unknown.filter((name) => !['runners', 'networkConfigurations'].includes(name));
  if (mandatory.length || missing.length) {
    return {
      status: 'blocked', completedOperations: input.plan.operations.filter((entry) => entry.actionId === 'github.phase0.discover'),
      blocker: `Phase 0 has incomplete authoritative GitHub coverage: ${[...mandatory, ...missing].join(', ')}. Grant the named read capabilities or prepare the exact missing workload inputs; no unknown was treated as absent.`,
      evidencePayload: { kind: 'phase-0-discovery.v1', facts, github: report }
    };
  }
  return {
    status: 'completed', resultState: 'verified', stateOverride: state,
    completedOperations: input.plan.operations.filter((entry) => entry.actionId === 'github.phase0.discover'),
    evidencePayload: { kind: 'phase-0-discovery.v1', facts, github: report },
    outputs: { values: { repositoryId: Number(report.repository.id), repository: String(report.repository.name), workload: String(report.workload.stack),
      githubCoverageComplete: unknown.length === 0 }, resources: [{ provider: 'github', resourceType: 'repository', resourceId }] },
    liveReadback: [readbackProof(input, 'github', 'repository', resourceId, report)]
  };
}
