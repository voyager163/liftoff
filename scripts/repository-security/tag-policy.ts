import { SecurityEvidenceError } from './evidence.ts';
import { canonicalDigest } from './admission.ts';

export interface TagRuleset {
  name: string;
  target: 'tag';
  enforcement: 'active';
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: Array<{ actor_type: 'Integration'; actor_id: number; bypass_mode: 'always' }>;
  rules: Array<{ type: 'creation' | 'deletion' } | { type: 'update'; parameters: { update_allows_fetch_and_merge: false } }>;
}

export function planTagProtection(publisherAppId: number) {
  if (!Number.isSafeInteger(publisherAppId) || publisherAppId <= 0) {
    throw new SecurityEvidenceError('verified-publisher-app-id-required');
  }
  if (publisherAppId === 15368) throw new SecurityEvidenceError('shared-actions-publisher-unqualified');
  const creation: TagRuleset = {
    name: 'Liftoff release tag creation', target: 'tag', enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [{ actor_type: 'Integration', actor_id: publisherAppId, bypass_mode: 'always' }],
    rules: [{ type: 'creation' }]
  };
  const mutation: TagRuleset = {
    name: 'Liftoff release tag integrity', target: 'tag', enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [], rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }, { type: 'deletion' }]
  };
  return {
    status: 'prepared-not-applied' as const,
    publisherQualified: false as const,
    requiresIndependentActorProof: true as const,
    rulesets: [creation, mutation]
  };
}

export function verifyTagProtectionBoundary(rulesets: readonly TagRuleset[], publisherAppId: number): void {
  const expected = planTagProtection(publisherAppId).rulesets;
  const normalize = (values: readonly TagRuleset[]) => values.map(value => ({
    ...value,
    rules: [...value.rules].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (canonicalDigest(normalize(rulesets)) !== canonicalDigest(normalize(expected))) throw new SecurityEvidenceError('tag-authority-boundary-mismatch');
}

export function tagOperationAllowedByPlan(
  rulesets: readonly TagRuleset[], publisherAppId: number, actor: { type: 'Integration' | 'User'; id: number },
  operation: 'creation' | 'update' | 'deletion'
): boolean {
  verifyTagProtectionBoundary(rulesets, publisherAppId);
  return operation === 'creation' && actor.type === 'Integration' && actor.id === publisherAppId;
}

export function publicationEventDecision(event: 'workflow_dispatch' | 'push' | 'pull_request', ref: string, dryRun: boolean) {
  if (!['workflow_dispatch', 'push', 'pull_request'].includes(event) || typeof ref !== 'string' ||
      ref.length > 500 || !ref.startsWith('refs/') || /[\x00-\x20\x7f]/.test(ref) || typeof dryRun !== 'boolean') {
    throw new SecurityEvidenceError('invalid-release-event-context');
  }
  if (event !== 'workflow_dispatch' || ref !== 'refs/heads/main' || dryRun) {
    return { publicationRequested: false, tagPushIsPublicationAuthority: false, explicitFollowOnRequired: true } as const;
  }
  return {
    publicationRequested: true,
    qualificationRequired: true,
    publisherIdentityRequired: true,
    tagPushIsPublicationAuthority: false,
    explicitFollowOnRequired: true
  } as const;
}
