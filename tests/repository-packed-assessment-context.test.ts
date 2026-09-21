import { describe, expect, it } from 'vitest';
import { packedAssessmentContext } from '../scripts/repository-security/packed-assessment-context.ts';

const source = { commit: 'a'.repeat(40), dirty: false }, digest = `sha256:${'b'.repeat(64)}`;
const now = new Date('2026-09-21T15:00:00.000Z');
function runner(): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'voyager163/liftoff',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: source.commit, GITHUB_WORKFLOW_SHA: 'c'.repeat(40),
    GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '2', LIFTOFF_RELEASE_DRY_RUN: 'true'
  };
}

describe('actual packed-assessment run identity', () => {
  it('uses the actual workflow revision, run and attempt without claiming authenticated or adopted-policy evidence', () => {
    const result = packedAssessmentContext(source, digest, runner(), now);
    expect(result.identity).toMatchObject({
      sourceSha: source.commit, workflowSha: 'c'.repeat(40), runId: '123456789', attempt: 2
    });
    expect(result).toMatchObject({
      adoptedPolicyAuthority: false, independentlyAuthenticated: false, publicationQualified: false,
      provenance: 'actual-runner-metadata-not-independent-producer-authentication'
    });
  });
  it('keeps local dirty observations explicitly separate from a hosted run', () => {
    expect(packedAssessmentContext({ ...source, dirty: true }, digest, {}, now)).toMatchObject({
      invocation: null, provenance: 'local-observation-not-hosted-run',
      identity: { runId: String(now.getTime()), attempt: 1 }, publicationQualified: false
    });
  });
  it.each([
    ['missing run', 'GITHUB_RUN_ID', undefined],
    ['bad attempt', 'GITHUB_RUN_ATTEMPT', '0'],
    ['wrong checkout', 'GITHUB_SHA', 'd'.repeat(40)],
    ['missing workflow revision', 'GITHUB_WORKFLOW_SHA', undefined],
    ['another repository', 'GITHUB_REPOSITORY', 'example/other'],
    ['unsupported event', 'GITHUB_EVENT_NAME', 'push'],
    ['unknown dry-run intent', 'LIFTOFF_RELEASE_DRY_RUN', undefined],
    ['incomplete runner context', 'GITHUB_ACTIONS', undefined]
  ])('fails closed on %s', (_label, name, value) => {
    const env = runner();
    if (value === undefined) delete env[name!]; else env[name!] = value;
    expect(() => packedAssessmentContext(source, digest, env, now)).toThrow();
  });
  it('allows a read-only manual candidate without granting publication for an arbitrary branch', () => {
    const env = { ...runner(), GITHUB_REF: 'refs/heads/candidate' };
    expect(packedAssessmentContext(source, digest, env, now).publicationQualified).toBe(false);
    expect(() => packedAssessmentContext(source, digest, { ...env, LIFTOFF_RELEASE_DRY_RUN: 'false' }, now)).toThrow();
    expect(() => packedAssessmentContext({ ...source, dirty: true }, digest, runner(), now)).toThrow();
  });
});
