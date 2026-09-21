import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planTagProtection, publicationEventDecision, tagOperationAllowedByPlan, verifyTagProtectionBoundary } from '../scripts/repository-security/tag-policy.ts';

describe('prepared publisher and tag authority boundaries', () => {
  it('records actual missing qualification without inventing an App or enrolled credential', async () => {
    const feasibility = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'publisher-feasibility.json'), 'utf8'));
    expect(feasibility.status).toBe('blocked-pending-qualified-publisher');
    expect(feasibility.observed.verifiedPublisherAppId).toBeNull();
    expect(feasibility.observed.environments).toEqual([]);
    expect(feasibility.proposedBoundary).toMatchObject({
      sourceRef: 'refs/heads/main', requiredReviewers: [], broadPatFallback: false,
      ordinaryBranchBypass: false, tagUpdateOrDeletionBypass: false, untrustedCodeExecutionInPublisher: false
    });
    expect(feasibility.effectsPerformed).toEqual([]);
  });

  it('keeps a creator exception completely separate from mutation denial', () => {
    const plan = planTagProtection(12345);
    expect(plan.publisherQualified).toBe(false);
    expect(plan.status).toBe('prepared-not-applied');
    expect(plan.rulesets[0]?.rules).toEqual([{ type: 'creation' }]);
    expect(plan.rulesets[1]?.bypass_actors).toEqual([]);
    expect(tagOperationAllowedByPlan(plan.rulesets, 12345, { type: 'Integration', id: 12345 }, 'creation')).toBe(true);
    for (const actor of [{ type: 'Integration', id: 12345 }, { type: 'Integration', id: 15368 }, { type: 'User', id: 1 }] as const) {
      expect(tagOperationAllowedByPlan(plan.rulesets, 12345, actor, 'update')).toBe(false);
      expect(tagOperationAllowedByPlan(plan.rulesets, 12345, actor, 'deletion')).toBe(false);
    }
    expect(tagOperationAllowedByPlan(plan.rulesets, 12345, { type: 'Integration', id: 15368 }, 'creation')).toBe(false);
  });

  it('rejects blank identity, broad actor rights or combined creation/mutation bypass', () => {
    expect(() => planTagProtection(0)).toThrow('verified-publisher-app-id-required');
    expect(() => planTagProtection(15368)).toThrow('shared-actions-publisher-unqualified');
    const rulesets = planTagProtection(12345).rulesets;
    rulesets[1]!.bypass_actors = [...rulesets[0]!.bypass_actors];
    expect(() => verifyTagProtectionBoundary(rulesets, 12345)).toThrow('tag-authority-boundary-mismatch');
    const combined = planTagProtection(12345).rulesets;
    combined[0]!.rules.push({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
    expect(() => verifyTagProtectionBoundary(combined, 12345)).toThrow('tag-authority-boundary-mismatch');
    const reordered = planTagProtection(12345).rulesets.reverse();
    reordered[0]!.rules.reverse();
    expect(() => verifyTagProtectionBoundary(reordered, 12345)).not.toThrow();
  });

  it('does not turn a tag event, arbitrary ref or dry-run into publication authority', () => {
    for (const [event, ref, dryRun] of [
      ['push', 'refs/tags/v0.12.3', false],
      ['workflow_dispatch', 'refs/heads/feature', false],
      ['workflow_dispatch', 'refs/heads/main', true],
      ['pull_request', 'refs/heads/main', false]
    ] as const) {
      expect(publicationEventDecision(event, ref, dryRun).publicationRequested).toBe(false);
    }
    expect(publicationEventDecision('workflow_dispatch', 'refs/heads/main', false)).toMatchObject({
      publicationRequested: true, qualificationRequired: true, publisherIdentityRequired: true,
      explicitFollowOnRequired: true, tagPushIsPublicationAuthority: false
    });
  });
});
