import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dependencyReviewContext, dependencyReviewSummary, reviewDependencyChanges } from '../scripts/repository-security/dependency-review.ts';
import { evaluateTemplateDependencyAudits, parseTemplateDependencyPolicy } from '../scripts/template-dependency-security.mjs';

const context = { repository: 'voyager163/liftoff', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), token: 'nonfunctional-test-token' };
const endpoint = `https://api.github.com/repos/${context.repository}/dependency-graph/compare/${context.baseSha}...${context.headSha}`;
const advisory = { severity: 'high', advisory_ghsa_id: 'GHSA-gpj5-g38j-94v9' };

function change(overrides: Record<string, unknown> = {}) {
  return { change_type: 'added', manifest: 'package-lock.json', name: 'fixture', version: '1.0.0',
    ecosystem: 'npm', scope: 'runtime', vulnerabilities: [], ...overrides };
}

function response(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
}

describe('fail-closed native Dependency Review', () => {
  it('binds PR metadata to the receiving repository without requiring a same-repository head', () => {
    const event = {
      repository: { full_name: context.repository },
      pull_request: { base: { sha: context.baseSha, repo: { full_name: context.repository } },
        head: { sha: context.headSha, repo: { full_name: 'contributor/fork' } } }
    };
    expect(dependencyReviewContext(JSON.stringify(event), context.repository, context.token)).toEqual(context);
    expect(() => dependencyReviewContext(JSON.stringify(event), 'wrong/repository', context.token)).toThrow('repository-mismatch');
    expect(() => dependencyReviewContext('PRIVATE_ERROR_SENTINEL', context.repository, context.token)).toThrow('invalid-dependency-review-context');
  });

  it('assesses runtime, development and unknown scopes without severity downgrades', async () => {
    const changes = ['runtime', 'development', 'unknown'].map((scope, index) =>
      change({ name: `fixture-${index}`, scope, vulnerabilities: [advisory] }));
    const result = await reviewDependencyChanges(context, async (url, init) => {
      expect(url).toBe(`${endpoint}?per_page=100&page=1`);
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${context.token}` });
      return response(changes);
    });
    expect(result.passed).toBe(false);
    expect(result.blocking).toHaveLength(3);
    expect(result.currentGraphsAssessed).toBe(false);
  });

  it('tracks lower findings but does not block a removed vulnerable dependency', async () => {
    const result = await reviewDependencyChanges(context, async () => response([
      change({ vulnerabilities: [{ ...advisory, severity: 'low' }] }),
      change({ name: 'removed', change_type: 'removed', vulnerabilities: [advisory] })
    ]));
    expect(result).toMatchObject({ passed: true, added: 1, removed: 1, blocking: [] });
    expect(result.tracked).toHaveLength(1);
    expect(dependencyReviewSummary(result)).toMatchObject({
      triageOwner: 'voyager163', trackedAdvisories: [advisory.advisory_ghsa_id]
    });
  });

  it('keeps dependency-controlled strings and credentials out of public summaries', async () => {
    const result = await reviewDependencyChanges(context, async () => response([
      change({ name: 'PRIVATE_PACKAGE_SENTINEL', version: 'PRIVATE_VERSION_SENTINEL', vulnerabilities: [advisory] })
    ]));
    const summary = JSON.stringify(dependencyReviewSummary(result));
    expect(summary).not.toContain('PRIVATE_');
    expect(summary).not.toContain(context.token);
    expect(summary).toContain(advisory.advisory_ghsa_id);
    await expect(reviewDependencyChanges({ ...context, repository: '../..' }, async () => response([])))
      .rejects.toThrow('invalid-dependency-review-repository');
  });

  it('accepts a complete empty diff without pretending that the current graph is safe', async () => {
    const diff = await reviewDependencyChanges(context, async () => response([]));
    expect(diff).toMatchObject({ passed: true, coverage: 'native-dependency-diff', currentGraphsAssessed: false });
    const auditReport = JSON.parse(await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'template-dependency-audit', 'direct.json'), 'utf8'));
    const entry = { id: 'liftoff-cli', label: 'Liftoff CLI', pathParts: ['package-lock.json'] };
    const policy = parseTemplateDependencyPolicy({ schemaVersion: 1, exceptions: [] }, [entry]);
    expect(evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport }], policy, today: '2026-07-15', resolvedAdvisories: []
    }).ok).toBe(false);
  });

  it('rejects snapshot warnings even when the comparison has no findings', async () => {
    await expect(reviewDependencyChanges(context, async () => response([], {
      'x-github-dependency-graph-snapshot-warnings': Buffer.from('PRIVATE_WARNING_SENTINEL').toString('base64')
    }))).rejects.toThrow('incomplete-dependency-snapshots');
  });

  it.each([
    change({ vulnerabilities: undefined }),
    change({ vulnerabilities: [{ ...advisory, severity: undefined }] }),
    change({ vulnerabilities: [{ ...advisory, severity: 'unknown' }] }),
    change({ manifest: '../outside.json' })
  ])('fails missing or malformed native metadata without success-shaped defaults', async value => {
    await expect(reviewDependencyChanges(context, async () => response([value]))).rejects.toThrow('Security evidence rejected');
  });

  it('follows only exact same-origin comparison pagination and accepts nonpaginated large responses', async () => {
    let calls = 0;
    const result = await reviewDependencyChanges(context, async url => {
      calls++;
      if (calls === 1) return response([change()], { link: `<${endpoint}?per_page=100&page=2>; rel="next"` });
      expect(url).toBe(`${endpoint}?per_page=100&page=2`);
      return response([change({ name: 'second' })]);
    });
    expect(result.added).toBe(2);
    expect(calls).toBe(2);
    calls = 0;
    const unpaginated = await reviewDependencyChanges(context, async () => {
      calls++;
      return response(Array.from({ length: 104 }, (_, index) => change({ name: `fixture-${index}` })));
    });
    expect(unpaginated.added).toBe(104);
    expect(calls).toBe(1);
  });

  it.each([
    'https://example.invalid/collect?per_page=100&page=2',
    `${endpoint}?per_page=100&page=1`,
    `${endpoint}?per_page=100&page=2&extra=token`,
    'https://api.github.com/repos/other/repo/dependency-graph/compare/a...b?per_page=100&page=2'
  ])('never forwards credentials to an untrusted next page', async target => {
    let calls = 0;
    await expect(reviewDependencyChanges(context, async () => {
      calls++;
      return response([], { link: `<${target}>; rel="next"` });
    })).rejects.toThrow('untrusted-dependency-review-pagination');
    expect(calls).toBe(1);
  });

  it('rejects outages, malformed and oversized reports without reflecting response details', async () => {
    await expect(reviewDependencyChanges(context, async () => { throw new Error('PRIVATE_TRANSPORT_SENTINEL'); }))
      .rejects.toThrow('dependency-review-request-failed');
    await expect(reviewDependencyChanges(context, async () => new Response('PRIVATE_SERVER_SENTINEL', { status: 503 })))
      .rejects.toThrow('dependency-review-api-error');
    await expect(reviewDependencyChanges(context, async () => new Response('PRIVATE_JSON_SENTINEL', {
      headers: { 'content-type': 'application/json' }
    }))).rejects.toThrow('invalid-dependency-review-json');
    await expect(reviewDependencyChanges(context, async () => new Response(' '.repeat(4 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' }
    }))).rejects.toThrow('dependency-review-report-too-large');
    await expect(reviewDependencyChanges(context, async () => response([change(), change()])))
      .rejects.toThrow('duplicate-dependency-change');
  });
});
