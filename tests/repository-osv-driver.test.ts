import { link, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createSecurityWorkspace } from '../scripts/repository-security/workspace.ts';
import { readOsvSource, summarizeRepositoryOsv } from '../scripts/repository-security/osv-driver.ts';
import { osvRelease } from '../scripts/repository-security/osv.ts';
import { type RepositoryOsvAssessment } from '../scripts/repository-security/osv-fixture.ts';
import { type EvidenceIdentity, type SecurityReport } from '../scripts/repository-security/evidence.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const identity: EvidenceIdentity = {
  repository: 'voyager163/liftoff', event: 'workflow_dispatch', sourceSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), runId: '123', attempt: 1,
  policyDigest: hash, inventoryDigest: hash, configurationDigest: hash
};
const now = new Date('2026-09-20T12:00:00.000Z');
function assessment(graph: string): RepositoryOsvAssessment {
  const report: SecurityReport = {
    schemaVersion: 1, role: 'non-npm-dependencies', identity, complete: true,
    tool: { name: 'osv-scanner', version: osvRelease.version, database: hash },
    generatedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z',
    units: [{ id: graph, inputDigest: hash, count: 1, platform: 'all' }], findings: []
  };
  return { graph, components: 1, inputDigest: hash, status: 'complete',
    report, transport: { simulated: true }, passed: true, blocking: 0, tracked: 0 };
}
const complete = () => ['standard-backend', 'genai-backend', 'function-worker', 'go-backend'].map(assessment);
const inputs = [{ pathParts: ['fixture.lock'], digest: hash }];

describe('full declared non-npm assessment accounting', () => {
  it('requires all exact graph identities without presenting local results as adopted/hosted qualification', () => {
    expect(summarizeRepositoryOsv(identity, inputs, complete(), [], now)).toMatchObject({
      analysisComplete: true, findingsPassed: true, missingGraphs: [],
      hostedQualification: false, publicationQualified: false,
      policy: 'strict-no-exceptions-not-adopted-policy-authorization'
    });
    const summary = summarizeRepositoryOsv(identity, inputs, complete(), [], now);
    expect(summary.reporting?.analysis).toMatchObject({ status: 'complete', expectedCount: 4 });
    expect(summary.reporting?.authority.publicationAuthorization).toBe('none');
    expect(summary.reporting?.reportedAdmission).toBeNull();
    expect(summary.ownerActions).toEqual([]);
  });

  it('never turns missing graphs or unknown severity into a clean assessment', () => {
    const missing = summarizeRepositoryOsv(identity, inputs, complete().slice(0, 3), [], now);
    expect(missing).toMatchObject({ analysisComplete: false, findingsPassed: null, missingGraphs: ['go-backend'] });
    expect(missing.reporting).toBeNull();
    expect(missing.ownerActions).toContainEqual({ owner: 'voyager163', graph: 'go-backend', action: 'rerun-complete-graph' });
    const values = complete();
    values[3] = { graph: 'go-backend', components: 1, inputDigest: hash,
      status: 'error', code: 'osv-unknown-severity', passed: false };
    expect(summarizeRepositoryOsv(identity, inputs, values, [], now))
      .toMatchObject({ analysisComplete: false, findingsPassed: null, missingGraphs: [] });
    expect(summarizeRepositoryOsv(identity, inputs, complete(), ['osv-api-unavailable'], now).analysisComplete).toBe(false);
  });

  it('rejects duplicates, unregistered graphs, mismatched coverage and forged verdicts', () => {
    expect(() => summarizeRepositoryOsv(identity, inputs, [...complete(), assessment('go-backend')], [], now)).toThrow('graph-inventory');
    expect(() => summarizeRepositoryOsv(identity, inputs, [assessment('unregistered')], [], now)).toThrow('graph-inventory');
    const values = complete();
    values[0]!.components = 2;
    expect(() => summarizeRepositoryOsv(identity, inputs, values, [], now)).toThrow('coverage-mismatch');
    const forged = complete();
    if (forged[0]!.status === 'complete') forged[0]!.blocking = 1;
    expect(() => summarizeRepositoryOsv(identity, inputs, forged, [], now)).toThrow('assessment-status');
    const wrong = { ...identity, sourceSha: 'd'.repeat(40) };
    expect(() => summarizeRepositoryOsv(wrong, inputs, complete(), [], now)).toThrow('identity-mismatch');
    expect(() => summarizeRepositoryOsv(identity, inputs, complete(), [], new Date('2026-09-22T12:00:00.000Z')))
      .toThrow('stale-evidence');
  });

  it('preserves a real finding block independently of successful complete analysis', () => {
    const values = complete(), first = values[0]!;
    if (first.status !== 'complete') throw new Error('invalid deterministic fixture');
    first.report.findings.push({
      id: 'fixture-advisory', kind: 'vulnerability', tool: 'osv-scanner', rule: 'GHSA-fixture',
      scope: first.graph, component: 'fixture', version: '1.0.0', chains: [['root', 'fixture']],
      location: ['fixture.lock'], artifactDigest: hash, severity: 'high', owner: 'voyager163'
    });
    first.passed = false;
    first.blocking = 1;
    expect(summarizeRepositoryOsv(identity, inputs, values, [], now))
      .toMatchObject({ analysisComplete: true, findingsPassed: false });
    const reported = summarizeRepositoryOsv(identity, inputs, values, [], now);
    expect(reported.reporting?.actualFindings.reportedStatus).toBe('blocked');
    expect(reported.ownerActions).toContainEqual({
      owner: 'voyager163', graph: first.graph, action: 'triage-blocking-findings'
    });
  });
});

describe.skipIf(process.platform === 'win32')('bounded no-follow source reader', () => {
  it('reads only a registered regular single-link file in a path containing spaces', async () => {
    const workspace = await createSecurityWorkspace(os.tmpdir());
    try {
      await workspace.write(['folder with spaces', 'lock.json'], '{"fixture":true}\n');
      expect(await readOsvSource(workspace.root, ['folder with spaces', 'lock.json'])).toBe('{"fixture":true}\n');
      await expect(readOsvSource(workspace.root, ['..', 'outside'])).rejects.toThrow('unsafe-location');
      await expect(readOsvSource(workspace.root, ['folder with spaces'])).rejects.toThrow('osv-source-file-identity');
    } finally { await workspace.cleanup(); }
  });

  it('refuses symlink and hardlink aliases before reading their contents', async () => {
    const workspace = await createSecurityWorkspace(os.tmpdir());
    const alias = path.join(workspace.root, 'alias');
    try {
      await workspace.write(['source'], 'NONFUNCTIONAL_SOURCE_READER_SENTINEL');
      await symlink(path.join(workspace.root, 'source'), alias);
      await expect(readOsvSource(workspace.root, ['alias'])).rejects.toThrow('osv-source-file-unreadable');
      await unlink(alias);
      await link(path.join(workspace.root, 'source'), alias);
      await expect(readOsvSource(workspace.root, ['alias'])).rejects.toThrow('osv-source-file-identity');
    } finally {
      await unlink(alias).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await workspace.cleanup();
    }
  });
});
