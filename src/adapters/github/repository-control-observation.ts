import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  expectStatus, GitHubActivationClient, GitHubActivationError, githubName, githubRepository, object, positiveId, text,
  type GitHubResponse
} from './activation-rest.js';
import { readGitHubRulesetInventory, type GitHubRulesetObservation } from './ruleset-observation.js';

export interface RepositoryControlBinding {
  repository: string;
  repositoryId: number;
  repositoryNodeId: string;
  ownerId: number;
  actor: { id: number; login: string; type: 'User' | 'Bot' };
  actionsApp: { id: number; slug: 'github-actions'; ownerId: number };
}

export interface RepositoryRulesetState extends GitHubRulesetObservation {
  etag: string | null;
}

export interface ObservedRepositoryRuleset extends RepositoryRulesetState {
  requestId: string | null;
}

export interface RepositoryControlSnapshot {
  binding: RepositoryControlBinding;
  mainSha: string;
  developSha: string;
  settings: Record<string, unknown>;
  settingsEtag: string | null;
  collectionEtag: string | null;
  rulesets: readonly RepositoryRulesetState[];
}

export interface RepositoryControlObservation extends RepositoryControlSnapshot {
  rulesets: readonly ObservedRepositoryRuleset[];
}

export const ownedRepositorySettingNames = [
  'default_branch', 'allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge',
  'allow_auto_merge', 'delete_branch_on_merge'
] as const;

export type OwnedRepositorySettings = Partial<Record<typeof ownedRepositorySettingNames[number], boolean | string>>;

export const repositoryControlLimits = { maxRequests: 1024, maxDurationMs: 120_000 } as const;

export class RepositoryControlNotDispatched extends GitHubActivationError {
  constructor() {
    super('control-request-not-dispatched', 'The repository-control request was not sent because its bounded execution window ended. Retain the undispatched checkpoint and review exact recovery.');
  }
}

export function boundedRepositoryControlClient(client: GitHubActivationClient): GitHubActivationClient {
  const started = performance.now();
  let requests = 0;
  return new GitHubActivationClient({
    async request(request) {
      if (++requests > repositoryControlLimits.maxRequests || performance.now() - started >= repositoryControlLimits.maxDurationMs) {
        throw new RepositoryControlNotDispatched();
      }
      return client.transport.request(request);
    }
  });
}

export function repositorySettings(value: unknown): OwnedRepositorySettings {
  const settings = object(value, 'Reviewed repository settings');
  if (Object.keys(settings).length === 0 ||
    Object.keys(settings).some((key) => !ownedRepositorySettingNames.includes(key as typeof ownedRepositorySettingNames[number])) ||
    Object.entries(settings).some(([key, entry]) => key === 'default_branch' ? entry !== 'develop' : typeof entry !== 'boolean') ||
    settings.allow_merge_commit === false) {
    throw new GitHubActivationError('settings-plan', 'Only explicitly selected GitFlow repository settings are writable; develop and true merge commits cannot be disabled.');
  }
  return structuredClone(settings);
}

export function providerRequestId(response: GitHubResponse): string | null {
  const id = response.headers['x-github-request-id'];
  if (id === undefined) return null;
  if (!/^[A-Za-z0-9:-]{1,160}$/u.test(id)) {
    throw new GitHubActivationError('invalid-response', 'GitHub returned a malformed request identity; no client identity can replace it.');
  }
  return id;
}

export function providerEtag(response: GitHubResponse): string | null {
  const etag = response.headers.etag;
  if (etag === undefined) return null;
  if (!/^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/u.test(etag)) {
    throw new GitHubActivationError('invalid-response', 'GitHub returned malformed observation concurrency metadata.');
  }
  return etag;
}

function commit(value: unknown, ref: string): string {
  const record = object(value, 'Protected ref');
  const target = object(record.object, 'Protected ref target');
  if (record.ref !== `refs/heads/${ref}` || target.type !== 'commit' ||
    typeof target.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(target.sha)) {
    throw new GitHubActivationError('main-baseline', 'The exact current main/develop commit baseline is unavailable; no branch update is permitted.');
  }
  return target.sha;
}

// Only known server-maintained counters/times are excluded from settings.
// Unknown settings and every observed enforcement field remain visible.
export function stableRepositorySettings(value: Record<string, unknown>): Record<string, unknown> {
  const volatileMetadata = new Set([
    'updated_at', 'stargazers_count', 'watchers_count', 'watchers', 'subscribers_count',
    'network_count', 'forks_count', 'forks', 'open_issues_count', 'open_issues', 'size'
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !volatileMetadata.has(key)));
}

export function reviewedRepositoryControlSnapshot(observation: RepositoryControlSnapshot): RepositoryControlSnapshot {
  return {
    ...observation,
    rulesets: observation.rulesets.map(({ definition, metadata, etag }) => ({ definition, metadata, etag }))
  };
}

export function controlObservationDigest(observation: RepositoryControlSnapshot): string {
  return canonicalSha256(reviewedRepositoryControlSnapshot(observation));
}

export async function observeRepositoryControlBoundary(
  client: GitHubActivationClient, repositoryName: string, expectedRepositoryId: number
): Promise<Omit<RepositoryControlObservation, 'rulesets' | 'collectionEtag'>> {
  const repository = githubRepository(repositoryName);
  const response = expectStatus(await client.transport.request({ method: 'GET', path: `/repos/${repository}` }), [200], 'Observe repository controls');
  const repo = object(response.data, 'Repository');
  const owner = object(repo.owner, 'Repository owner');
  const repositoryId = positiveId(repo.id, 'Repository ID');
  if (repositoryId !== positiveId(expectedRepositoryId) || githubRepository(repo.full_name).toLowerCase() !== repository.toLowerCase() ||
    githubName(owner.login).toLowerCase() !== repository.split('/')[0]!.toLowerCase() ||
    repo.archived !== false || repo.disabled !== false) {
    throw new GitHubActivationError('repository-binding', 'The exact active published repository identity changed or is not available for enforcement.');
  }
  const actor = await client.get('/user');
  if (actor.type !== 'User' && actor.type !== 'Bot') throw new GitHubActivationError('actor-binding', 'Enforcement requires an observed authenticated GitHub actor.');
  const app = await client.get('/apps/github-actions');
  if (app.slug !== 'github-actions') throw new GitHubActivationError('actor-binding', 'Release-tag creation must resolve the actual GitHub Actions application, never a guessed integration ID.');
  const binding: RepositoryControlBinding = {
    repository, repositoryId, repositoryNodeId: text(repo.node_id, 'Repository node ID'), ownerId: positiveId(owner.id),
    actor: { id: positiveId(actor.id), login: githubName(actor.login), type: actor.type },
    actionsApp: { id: positiveId(app.id), slug: 'github-actions', ownerId: positiveId(object(app.owner).id) }
  };
  const mainSha = commit(await client.get(`/repos/${repository}/git/ref/heads/main`), 'main');
  const developSha = commit(await client.get(`/repos/${repository}/git/ref/heads/develop`), 'develop');
  return { binding, mainSha, developSha, settings: stableRepositorySettings(repo), settingsEtag: providerEtag(response) };
}

export async function observeRepositoryControls(
  client: GitHubActivationClient, repositoryName: string, expectedRepositoryId: number
): Promise<RepositoryControlObservation> {
  const boundary = await observeRepositoryControlBoundary(client, repositoryName, expectedRepositoryId);
  const repository = boundary.binding.repository;
  const etags = new Map<number, { etag: string | null; requestId: string | null }>();
  let collectionEtag: string | null = null;
  const observer = new GitHubActivationClient({
    async request(request) {
      if (request.method !== 'GET') throw new GitHubActivationError('read-only', 'Control observation cannot mutate GitHub.');
      const result = await client.transport.request(request);
      const detail = /\/rulesets\/([1-9]\d*)(?:\?|$)/u.exec(request.path);
      if (detail) etags.set(Number(detail[1]), { etag: providerEtag(result), requestId: providerRequestId(result) });
      else if (request.path.startsWith(`/repos/${repository}/rulesets?`)) collectionEtag = providerEtag(result);
      return result;
    }
  });
  const inventory = await readGitHubRulesetInventory(observer, repository);
  if (inventory.length > 64) throw new GitHubActivationError('bounded-controls', 'Repository enforcement supports at most 64 observed rulesets; the larger inventory was preserved.');
  const rulesets = inventory.map((control) => ({
    ...control, ...etags.get(positiveId(control.definition.id))!
  }));
  return {
    ...boundary, collectionEtag, rulesets
  };
}
