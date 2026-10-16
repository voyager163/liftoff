import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { observeSource5WorkflowSecretProtectionHistory } from '../src/governance-activation/workflow-source5-secret-protection-history.js';
import { createWorkflowRequiredSourceFixture } from './fixtures/workflow-required-source.js';

const buckets = ['incremental_scans', 'pattern_update_scans', 'backfill_scans',
  'custom_pattern_backfill_scans', 'generic_secrets_backfill_scans'] as const;
const scan = () => ({ type: 'git', status: 'completed',
  started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:00Z' });

describe('actual latest Secret Protection history, never exact-source scan or licensing authority', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-secret-history-'))); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
    profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
    const value = await createWorkflowRequiredSourceFixture(root, workflow, profile);
    const source = { repository: value.source.repository, repositoryId: value.source.repositoryId,
      sourceSha: value.source.sourceSha, treeSha: value.source.treeSha, ref: 'develop' };
    const branchPath = '/repos/owner/repo/git/ref/heads/develop';
    const branch = { ref: 'refs/heads/develop', object: { type: 'commit', sha: source.sourceSha } };
    const historyPath = '/repos/owner/repo/secret-scanning/scan-history';
    const history = Object.fromEntries(buckets.map(bucket => [bucket, [scan()]]));
    value.routes.set(branchPath, branch); value.routes.set(historyPath, history);
    return { ...value, source, branch, branchPath, history, historyPath,
      request: () => observeSource5WorkflowSecretProtectionHistory({ context: value.context, runtime: value.runtime, source }) };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'single-maintainer-gitflow'], ['openspec', 'team-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('observes real GET-only latest metadata for %s/%s without a completed-label verdict', async (workflow, profile) => {
    const value = await fixture(workflow, profile);
    try {
      const result = await value.request();
      expect(result).toMatchObject({
        status: 'blocked', source: value.source, graphHash: canonicalSha256(value.context.records.graph),
        historyDigest: canonicalSha256(value.history), coverage: 'provider-latest-scan-history-only',
        sourceRefReadback: 'observed-during-this-invocation',
        exactCommitScanBinding: 'not-provided-by-observed-contract', completeDetectorCoverage: 'not-authenticated',
        licensedProgramSubjects: null, approvedNonCredentialNegativeControl: null, scanVerdict: 'not-issued',
        requiredContextSemantics: 'not-validated', prerequisiteSession: null, phaseProof: 'not-issued',
        execution: 'not-authorized', unknownFields: []
      });
      expect(result.buckets).toEqual(buckets.map(bucket => ({ bucket, presence: 'present',
        entries: [{ metadataDigest: canonicalSha256(scan()), typeDigest: canonicalSha256('git'),
          statusDigest: canonicalSha256('completed'), startedAt: scan().started_at, completedAt: scan().completed_at }] })));
      expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.buckets[0]!.entries![0])).toBe(true);
      expect(value.calls).toEqual([
        { method: 'GET', path: '/repos/owner/repo' },
        { method: 'GET', path: `/repos/owner/repo/git/commits/${value.source.sourceSha}` },
        { method: 'GET', path: value.branchPath }, { method: 'GET', path: value.historyPath },
        { method: 'GET', path: value.historyPath }, { method: 'GET', path: value.branchPath },
        { method: 'GET', path: `/repos/owner/repo/git/commits/${value.source.sourceSha}` },
        { method: 'GET', path: '/repos/owner/repo' }
      ]);
      expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });
  it('retains custom patterns, unknown fields and literal __proto__ metadata only as digests', async () => {
    const value = await fixture();
    try {
      const custom = { ...scan(), pattern_name: 'private-pattern', pattern_scope: 'private-scope', future: { private: true } };
      const actual = { ...value.history, custom_pattern_backfill_scans: [custom],
        ...Object.fromEntries([['__proto__', { private: 'private-future-metadata' }]]) };
      value.routes.set(value.historyPath, actual);
      const result = await value.request();
      expect(result.historyDigest).toBe(canonicalSha256(actual));
      expect(result.buckets.find(bucket => bucket.bucket === 'custom_pattern_backfill_scans')!.entries![0]!.metadataDigest)
        .toBe(canonicalSha256(custom));
      expect(result.unknownFields).toEqual([{ fieldDigest: canonicalSha256('__proto__'),
        metadataDigest: canonicalSha256({ private: 'private-future-metadata' }) }]);
      expect(JSON.stringify(result)).not.toMatch(/private-|private-pattern|private-scope/);
      expect(result.blockers.some(item => item.code === 'workflow-secret-protection-history-fields-unsupported')).toBe(true);
    } finally { await value.close(); }
  });
  it.each(['develop', 'main', 'release/1.2.3', 'hotfix/1.2.4'])(
    'reobserves literal protected-family selector %s without binding repository history to it', async ref => {
      const value = await fixture();
      try {
        value.source.ref = ref;
        const branchPath = `/repos/owner/repo/git/ref/heads/${ref}`;
        value.routes.set(branchPath, { ref: `refs/heads/${ref}`, object: { type: 'commit', sha: value.source.sourceSha } });
        expect(await value.request()).toMatchObject({ status: 'blocked', source: value.source,
          exactCommitScanBinding: 'not-provided-by-observed-contract', prerequisiteSession: null });
        expect(value.calls.filter(call => call.path === branchPath)).toHaveLength(2);
        expect(value.calls.filter(call => call.path === value.historyPath)).toHaveLength(2);
      } finally { await value.close(); }
    });
  it.each(['absent', 'empty', 'pending', 'future-status', 'claimed-source'] as const)(
    'keeps %s metadata blocked without a default-success inference', async kind => {
      const value = await fixture();
      try {
        const actual = kind === 'absent' ? {} : kind === 'empty' ? Object.fromEntries(buckets.map(bucket => [bucket, []]))
          : kind === 'claimed-source' ? { ...value.history, commit_sha: value.source.sourceSha, clean: true, licensed: true }
            : { ...value.history, incremental_scans: [{ ...scan(), status: kind === 'pending' ? 'pending' : 'future-status' }] };
        value.routes.set(value.historyPath, actual);
        const result = await value.request();
        expect(result).toMatchObject({ status: 'blocked', historyDigest: canonicalSha256(actual),
          exactCommitScanBinding: 'not-provided-by-observed-contract', scanVerdict: 'not-issued',
          licensedProgramSubjects: null, prerequisiteSession: null, phaseProof: 'not-issued' });
        expect(result.buckets.every(bucket => bucket.presence === 'absent')).toBe(kind === 'absent');
        expect(result.blockers.some(item => item.code === 'workflow-secret-protection-history-fields-unavailable'))
          .toBe(kind === 'absent');
        if (kind === 'empty') expect(result.buckets.every(bucket => bucket.entries?.length === 0)).toBe(true);
      } finally { await value.close(); }
    });
  it('preserves absent fields, empty descriptive text and explicit null timestamps without inventing subjects', async () => {
    const value = await fixture();
    try {
      const entries = [{}, { type: '', status: '', started_at: null, completed_at: null }];
      value.routes.set(value.historyPath, { incremental_scans: entries });
      const result = await value.request();
      expect(result.buckets[0]!.entries).toEqual([{ metadataDigest: canonicalSha256({}) }, {
        metadataDigest: canonicalSha256(entries[1]), typeDigest: canonicalSha256(''), statusDigest: canonicalSha256(''),
        startedAt: null, completedAt: null
      }]);
      expect(result.buckets.slice(1).every(bucket => bucket.presence === 'absent')).toBe(true);
    } finally { await value.close(); }
  });
  it.each(buckets)('refuses nonarrays, nonrecords and oversized %s instead of a partial history', async bucket => {
    for (const entries of [null, {}, [null], [17], Array.from({ length: 1001 }, scan)]) {
      const value = await fixture();
      try {
        value.routes.set(value.historyPath, { ...value.history, [bucket]: entries });
        await expect(value.request()).rejects.toMatchObject({ code: 'workflow-secret-protection-history-response' });
      } finally { await value.close(); }
    }
  });
  it.each([{ type: 17 }, { status: null }, { type: 'line\nbreak' }, { status: 'x'.repeat(4097) },
    { started_at: 17 }, { completed_at: 'bad-date' }, { completed_at: '2026-01-01' },
    { started_at: '2026-01-01T00:00:00Z private-marker' }])('refuses malformed supported scan metadata %j', async patch => {
    const value = await fixture();
    try {
      value.routes.set(value.historyPath, { incremental_scans: [{ ...scan(), ...patch }] });
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-secret-protection-history-response' });
    } finally { await value.close(); }
  });
  it.each([null, [], 'not-history'])('refuses invalid response shape %j', async actual => {
    const value = await fixture();
    try {
      value.routes.set(value.historyPath, actual);
      await expect(value.request()).rejects.toThrow();
    } finally { await value.close(); }
  });
  it.each([401, 403, 404, 429, 503])('keeps HTTP%s unavailable rather than an empty licensed scan', async status => {
    const value = await fixture();
    try {
      value.replyStatuses.set(value.historyPath, status);
      await expect(value.request()).rejects.toMatchObject({ code: 'provider-response', status });
      expect(value.calls.filter(call => call.path === value.historyPath)).toHaveLength(1);
    } finally { await value.close(); }
  });
  it.each(['changed', 'added', 'removed', 'unknown-field'] as const)('refuses actually %s latest metadata at readback', async kind => {
    const value = await fixture();
    try {
      let count = 0;
      value.hooks.afterResponse = observed => {
        if (observed !== value.historyPath || ++count !== 1) return;
        const actual = { ...value.history };
        if (kind === 'changed') actual.incremental_scans = [{ ...scan(), status: 'pending' }];
        if (kind === 'added') actual.incremental_scans = [scan(), scan()];
        if (kind === 'removed') delete actual.backfill_scans;
        value.routes.set(value.historyPath, kind === 'unknown-field' ? { ...actual, opaque_future: true } : actual);
      };
      await expect(value.request()).rejects.toMatchObject({ code: 'workflow-secret-protection-history-changed' });
    } finally { await value.close(); }
  });
  it.each(['repository-id', 'repository-name', 'commit', 'tree', 'ref-name', 'ref-type', 'ref-sha'] as const)(
    'refuses initial and late %s substitution under the common source guard', async kind => {
      for (const late of [false, true]) {
        const value = await fixture();
        try {
          const mutate = () => {
            if (kind === 'repository-id') value.state.repository.id++;
            if (kind === 'repository-name') value.state.repository.full_name = 'other/repo';
            if (kind === 'commit') value.state.commit.sha = 'c'.repeat(40);
            if (kind === 'tree') value.state.commit.tree.sha = 'c'.repeat(40);
            if (kind === 'ref-name') value.branch.ref = 'refs/heads/other';
            if (kind === 'ref-type') value.branch.object.type = 'tag';
            if (kind === 'ref-sha') value.branch.object.sha = 'c'.repeat(40);
          };
          if (late) value.hooks.afterResponse = observed => { if (observed === value.historyPath) mutate(); };
          else mutate();
          await expect(value.request()).rejects.toMatchObject({
            code: `workflow-secret-protection-history-${kind.startsWith('repository') ? 'repository'
              : kind.startsWith('ref') ? 'ref' : 'commit'}`
          });
        } finally { await value.close(); }
      }
    });
  it('captures selectors before awaits and refuses reports, controls, commands, authority and input hooks', async () => {
    const value = await fixture();
    try {
      const original = { ...value.source };
      value.hooks.afterResponse = observed => { if (observed === '/repos/owner/repo') value.source.ref = 'main'; };
      expect((await value.request()).source).toEqual(original);
      value.calls.splice(0);
      const request = { context: value.context, runtime: value.runtime, source: original }, hook = vi.fn();
      const getter = { ...request }; Object.defineProperty(getter, 'source', { enumerable: true, get: hook });
      for (const input of [null, [], { ...request, report: {} }, { ...request, completed: true },
        { ...request, control: 'dummy-secret' }, { ...request, command: 'echo pass' }, { ...request, proof: {} },
        getter, new Proxy(request, { getPrototypeOf: hook }), { ...request, context: { ...value.context } },
        { ...request, runtime: { ...value.runtime } }, { ...request, source: { ...original, reportDigest: 'a'.repeat(64) } },
        { ...request, source: { ...original, ref: 'unknown' } }, { ...request, source: { ...original, treeSha: 'main' } }]) {
        await expect(Reflect.apply(observeSource5WorkflowSecretProtectionHistory, undefined, [input])).rejects.toThrow();
      }
      expect(hook).not.toHaveBeenCalled(); expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });
});
