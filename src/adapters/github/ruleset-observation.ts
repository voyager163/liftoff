import { normalizeRuleset } from '../../domain/governance/assessment/live-normalize.js';
import { LiveFailure } from '../../domain/governance/assessment/errors.js';
import { GitHubActivationError, githubRepository, object, positiveId, type GitHubActivationClient } from './activation-rest.js';

export interface GitHubRulesetObservation {
  definition: Record<string, unknown>;
  metadata: {
    createdAt?: string;
    updatedAt?: string;
    currentUserCanBypass?: 'always' | 'pull_requests_only' | 'never' | 'exempt';
  };
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))) {
    throw new GitHubActivationError('invalid-response', 'Ruleset observation contains malformed provider timestamps.');
  }
  return value;
}

function validateLinks(value: unknown): void {
  const links = object(value, 'Ruleset links');
  for (const [name, entry] of Object.entries(links)) {
    if (!['self', 'html'].includes(name)) throw new GitHubActivationError('unsupported-response', 'Ruleset links contain an unsupported metadata field.');
    if (name === 'html' && entry === null) continue;
    const link = object(entry, 'Ruleset link');
    if (Object.keys(link).some((key) => key !== 'href')) throw new GitHubActivationError('unsupported-response', 'Ruleset link contains unsupported metadata.');
    if (!Object.hasOwn(link, 'href')) continue;
    if (typeof link.href !== 'string' || link.href.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(link.href)) {
      throw new GitHubActivationError('invalid-response', 'Ruleset link is not safe provider metadata.');
    }
    let url: URL;
    try { url = new URL(link.href); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new GitHubActivationError('invalid-response', 'Ruleset link is not a valid provider URL.');
    }
    if (url.protocol !== 'https:' || url.hostname !== (name === 'self' ? 'api.github.com' : 'github.com') ||
      url.username || url.password || url.port || url.search || url.hash) {
      throw new GitHubActivationError('invalid-response', 'Ruleset links must be credential-free GitHub metadata; links are never followed.');
    }
  }
}

export function normalizeGitHubRulesetObservation(value: unknown): GitHubRulesetObservation {
  const item = object(value, 'Ruleset response');
  const { created_at, updated_at, current_user_can_bypass, _links, ...definition } = item;
  const metadata: GitHubRulesetObservation['metadata'] = {};
  if (Object.hasOwn(item, 'created_at')) metadata.createdAt = timestamp(created_at);
  if (Object.hasOwn(item, 'updated_at')) metadata.updatedAt = timestamp(updated_at);
  if (Object.hasOwn(item, '_links')) validateLinks(_links);
  if (Object.hasOwn(item, 'current_user_can_bypass')) {
    if (current_user_can_bypass !== 'always' && current_user_can_bypass !== 'pull_requests_only' &&
      current_user_can_bypass !== 'never' && current_user_can_bypass !== 'exempt') {
      throw new GitHubActivationError('unsupported-response', 'Ruleset actor bypass observation contains an unknown or malformed value.');
    }
    metadata.currentUserCanBypass = current_user_can_bypass;
  }
  try {
    return { definition: object(normalizeRuleset(definition)), metadata };
  } catch (error) {
    if (!(error instanceof LiveFailure)) throw error;
    throw new GitHubActivationError(error.code, `Ruleset has unsupported enforcement; ${error.message}`);
  }
}

export async function readGitHubRulesetInventory(
  client: GitHubActivationClient, repositoryName: string
): Promise<GitHubRulesetObservation[]> {
  const repository = githubRepository(repositoryName);
  const summaries = await client.list(`/repos/${repository}/rulesets?includes_parents=true`);
  const ids = summaries.map((entry) => positiveId(entry.id, 'Ruleset ID'));
  if (new Set(ids).size !== ids.length) throw new GitHubActivationError('incomplete-observation', 'Ruleset inventory contains duplicate provider identities.');
  const observations: GitHubRulesetObservation[] = [];
  for (const summary of [...summaries].sort((left, right) => positiveId(left.id) - positiveId(right.id))) {
    const id = positiveId(summary.id);
    const observation = normalizeGitHubRulesetObservation(await client.get(`/repos/${repository}/rulesets/${id}`));
    const full = observation.definition;
    if (typeof full.source !== 'string') throw new GitHubActivationError('invalid-response', 'Ruleset observation omitted its provider source identity.');
    const source = full.source;
    if (full.id !== id || !['Repository', 'Organization', 'Enterprise'].includes(String(full.source_type)) ||
      ['name', 'target', 'enforcement', 'source_type', 'source'].some((key) => Object.hasOwn(summary, key) && full[key] !== summary[key]) ||
      full.source_type === 'Repository' && source.toLowerCase() !== repository.toLowerCase() ||
      full.source_type === 'Organization' && source.toLowerCase() !== repository.split('/')[0]!.toLowerCase()) {
      throw new GitHubActivationError('ruleset-binding', `Ruleset ${id} identity/source changed during discovery; foreign and changed protections were preserved.`);
    }
    observations.push(observation);
  }
  return observations;
}
