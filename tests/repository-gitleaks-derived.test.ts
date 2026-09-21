import { describe, expect, it, vi } from 'vitest';
import {
  DERIVED_FIXTURE_PROFILE, derivedMetadataTemplate, fetchPinnedDerivedProfileSource,
  parseDerivedFixtureOutput, qualifyDerivedOutputProbe, qualifyDerivedProfileFixtures,
  type DerivedMetadataRegistry
} from '../scripts/repository-security/gitleaks-derived.ts';
import { installPinnedFixtureGitleaks, qualifyGitleaksFixture } from '../scripts/repository-security/gitleaks.ts';

const sentinel = 'NONFUNCTIONAL_DERIVED_OUTPUT_SENTINEL';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
function registry(): DerivedMetadataRegistry {
  return {
    rules: [{ id: 'aws-access-token', kind: 'content' }, { id: 'pkcs12-file', kind: 'path-only' }],
    files: [
      { pathParts: ['package-lock.json'], aliases: ['package-lock.json', '/fixture with spaces/package-lock.json'] },
      { pathParts: ['go.sum'], aliases: ['go.sum'] },
      { pathParts: ['fixture.svg'], aliases: ['fixture.svg'] },
      { pathParts: ['not-a-container.p12'], aliases: ['not-a-container.p12'] }
    ],
    commits: [first, second]
  };
}
const content = [0, 0, 0, 1, 4, 1, 23, 1];
const pathOnly = [1, 3, 0, 0, 0, 0, 0, 2];
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('derived-profile fixture metadata boundary', () => {
  it('binds the named derivation rather than claiming unchanged defaults', () => {
    expect(DERIVED_FIXTURE_PROFILE).toEqual({
      version: '8.30.1', commit: '83d9cd684c87d95d656c1458ef04895a7f1cbd8e',
      sha256: 'e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf',
      ruleCount: 222, removedAllowlistGroups: 14,
      preparedConfigSha256: 'd468a8e4dc13fb18c09603e3455f85af7f8044df30132d8e3391554b29357598'
    });
    expect(Object.isFrozen(DERIVED_FIXTURE_PROFILE)).toBe(true);
  });

  it('renders only integers and fixed markers, not arbitrary metadata strings or matches', () => {
    const output = derivedMetadataTemplate(registry());
    const actions = [...output.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1] ?? '');
    expect(actions.filter(action => !/^(?:if |else$|end$|range )/.test(action)))
      .toEqual(['.StartLine', '.StartColumn', '.EndLine', '.EndColumn']);
    expect(output).not.toMatch(/\{\{\.(?:File|Commit|RuleID|Secret|Match|Line|Author|Email|Message|Description)\}\}/);
    expect(output).toContain('eq .Secret "REDACTED"');
    expect(output).toContain('eq .Secret ""');
    expect(output).not.toContain(sentinel);
  });

  it('binds current-tree empty commit metadata only to one explicitly captured revision', () => {
    const current = { ...registry(), commits: [first] };
    expect(derivedMetadataTemplate(current, 'current-tree')).toContain('{{if eq .Commit ""}}0{{else}}-1{{end}}');
    expect(() => derivedMetadataTemplate(registry(), 'current-tree')).toThrow('invalid-registry');
  });

  it('accepts exact registered content and distinct path-only locations without fabricating line 1', () => {
    const found = parseDerivedFixtureOutput(bytes([content, pathOnly]), 42, registry());
    expect(found).toEqual([
      { ruleIndex: 0, fileIndex: 0, commitIndex: 0, kind: 'content', line: 1, column: 4, endLine: 1, endColumn: 23 },
      { ruleIndex: 1, fileIndex: 3, commitIndex: 0, kind: 'path-only', line: null, column: null, endLine: null, endColumn: null }
    ]);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found[0])).toBe(true);
    expect(JSON.stringify(found)).not.toContain(sentinel);
    expect(JSON.stringify(found)).not.toContain('package-lock.json');
  });

  it('also accepts a fully redacted marker for a path-only finding', () => {
    const found = parseDerivedFixtureOutput(bytes([[...pathOnly.slice(0, 7), 1]]), 42, registry());
    expect(found[0]?.kind).toBe('path-only');
  });

  it('canonicalizes parallel scanner result order for reproducible fixture identities', () => {
    expect(parseDerivedFixtureOutput(bytes([pathOnly, content]), 42, registry()))
      .toEqual(parseDerivedFixtureOutput(bytes([content, pathOnly]), 42, registry()));
  });

  it('accepts clean reports only with success exit', () => {
    expect(parseDerivedFixtureOutput(bytes([]), 0, registry())).toEqual([]);
  });

  it.each([
    ['unknown rule', [[2, ...content.slice(1)]], 42, 'unknown-identity'],
    ['unknown file', [[0, 4, ...content.slice(2)]], 42, 'unknown-identity'],
    ['unknown commit', [[0, 0, 2, ...content.slice(3)]], 42, 'unknown-identity'],
    ['unknown ordinal marker', [[-1, ...content.slice(1)]], 42, 'invalid-report'],
    ['unredacted content', [[...content.slice(0, 7), 0]], 42, 'unredacted-output'],
    ['empty content secret', [[...content.slice(0, 7), 2]], 42, 'unredacted-output'],
    ['unredacted path secret', [[...pathOnly.slice(0, 7), 0]], 42, 'unredacted-output'],
    ['unknown path-only position', [[1, 3, 0, 1, 1, 1, 1, 2]], 42, 'unsupported-path-only-shape'],
    ['path-only mixed coordinates', [[1, 3, 0, 0, 1, 0, 0, 2]], 42, 'unsupported-path-only-shape'],
    ['content with missing line', [[0, 0, 0, 0, 0, 0, 0, 1]], 42, 'invalid-report'],
    ['backwards content range', [[0, 0, 0, 2, 5, 1, 3, 1]], 42, 'invalid-report'],
    ['backwards columns', [[0, 0, 0, 1, 5, 1, 3, 1]], 42, 'invalid-report'],
    ['missing redaction field', [content.slice(0, 7)], 42, 'invalid-report'],
    ['extra numeric field', [[...content, 1]], 42, 'invalid-report'],
    ['string metadata', [[0, 0, 0, 1, sentinel, 1, 20, 1]], 42, 'invalid-report'],
    ['native raw finding', [{ Secret: sentinel, Match: sentinel, File: sentinel }], 42, 'invalid-report'],
    ['native error', { error: sentinel }, 42, 'invalid-report'],
    ['duplicate location', [content, content], 42, 'duplicate-finding'],
    ['finding with success exit', [content], 0, 'invalid-report'],
    ['empty findings with finding exit', [], 42, 'invalid-report'],
    ['scanner error with finding', [content], 1, 'invalid-report'],
    ['scanner error without finding', [], 1, 'invalid-report'],
    ['too many findings', Array.from({ length: 65 }, () => content), 42, 'invalid-report']
  ])('rejects %s instead of silently dropping coverage', (_name, data, exit, code) => {
    expect(() => parseDerivedFixtureOutput(bytes(data), exit, registry())).toThrow(`Derived Gitleaks fixture rejected: ${code}.`);
  });

  it.each([
    Buffer.from(`{"Secret":"${sentinel}`), Buffer.from(sentinel), Buffer.from('[] []'),
    Buffer.alloc(65537, 32), new Uint8Array(), new Uint8Array([0xff])
  ])('retains no raw parser error or invalid bytes %#', value => {
    let error: unknown;
    try { parseDerivedFixtureOutput(value, 0, registry()); } catch (failure: unknown) { error = failure; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('DerivedGitleaksFixtureError: Derived Gitleaks fixture rejected: invalid-report.');
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(sentinel);
    if (error instanceof Error) expect(error.stack).not.toContain(sentinel);
  });

  it.each([
    ['empty rules', (r: DerivedMetadataRegistry) => ({ ...r, rules: [] })],
    ['duplicate rules', (r: DerivedMetadataRegistry) => ({ ...r, rules: [...r.rules, ...r.rules] })],
    ['extra registry field', (r: DerivedMetadataRegistry) => ({ ...r, raw: sentinel })],
    ['unknown rule field', (r: DerivedMetadataRegistry) => ({ ...r, rules: r.rules.map(rule => ({ ...rule, raw: sentinel })) })],
    ['unknown file field', (r: DerivedMetadataRegistry) => ({ ...r, files: r.files.map(file => ({ ...file, raw: sentinel })) })],
    ['duplicate files', (r: DerivedMetadataRegistry) => ({ ...r, files: [...r.files, ...r.files] })],
    ['alias collision', (r: DerivedMetadataRegistry) => ({ ...r, files: r.files.map(file => ({ ...file, aliases: ['same'] })) })],
    ['case alias', (r: DerivedMetadataRegistry) => ({ ...r, files: [{ pathParts: ['a'], aliases: ['File', 'file'] }] })],
    ['traversal', (r: DerivedMetadataRegistry) => ({ ...r, files: [{ pathParts: ['..'], aliases: ['../file'] }] })],
    ['raw control characters', (r: DerivedMetadataRegistry) => ({ ...r, files: [{ pathParts: ['file'], aliases: [`${sentinel}\n`] }] })],
    ['duplicate commits', (r: DerivedMetadataRegistry) => ({ ...r, commits: [first, first] })],
    ['missing commit scope', (r: DerivedMetadataRegistry) => ({ ...r, commits: [] })],
    ['mutable commit scope', (r: DerivedMetadataRegistry) => ({ ...r, commits: ['HEAD'] })]
  ])('rejects %s before building the numeric template', (_name, change) => {
    expect(() => derivedMetadataTemplate(change(registry()))).toThrow(/invalid-registry/);
  });

  it('supports the full 222-rule registry without outputting rule names', () => {
    const r = { ...registry(), rules: Array.from({ length: 222 }, (_, index) => ({ id: `fixture-rule-${index}`, kind: 'content' as const })) };
    expect(derivedMetadataTemplate(r).length).toBeLessThan(65536);
    const found = parseDerivedFixtureOutput(bytes([[221, ...content.slice(1)]]), 42, r);
    expect(found[0]?.ruleIndex).toBe(221);
    expect(JSON.stringify(found)).not.toContain('fixture-rule');
  });
});

describe('derived output failure probes before scanning', () => {
  it.each(['stdout', 'stderr', 'parser', 'oversize'] as const)('quarantines %s with registered cleanup', async kind => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejection: unknown;
    try { await qualifyDerivedOutputProbe(process.cwd(), kind); } catch (failure: unknown) { rejection = failure; }
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toMatch(/Derived Gitleaks fixture rejected:/);
    expect(JSON.stringify(rejection)).not.toContain(sentinel);
    expect(rejection).not.toHaveProperty('cause');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

it.runIf(process.env.LIFTOFF_REAL_GITLEAKS_DERIVED_FIXTURE === '1')(
  'qualifies named derived profile only on formerly excluded surfaces and candidate suppression fixtures',
  async () => {
    const source = await fetchPinnedDerivedProfileSource();
    const tool = await installPinnedFixtureGitleaks(process.cwd());
    try {
      // Same installer/isolated Git helper must preserve the original fixture.
      const original = await qualifyGitleaksFixture(tool, process.cwd(), '/usr/bin/git');
      expect(original.currentTreeFindingCount).toBe(0);
      expect(original.introducedHistoryFindingCount).toBe(1);
      vi.stubEnv('GITLEAKS_CONFIG', '/nonfunctional-untrusted/config.toml');
      vi.stubEnv('GITLEAKS_CONFIG_TOML', 'nonfunctional untrusted inline configuration');
      vi.stubEnv('GITLEAKS_IGNORE_PATH', '/nonfunctional-untrusted/.gitleaksignore');
      vi.stubEnv('GIT_DIR', '/nonfunctional-untrusted/git');
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      const result = await qualifyDerivedProfileFixtures(tool, process.cwd(), '/usr/bin/git', source);
      expect(result).toMatchObject({
        fixtureQualification: 'passed', securityGate: 'blocked', profile: 'derived-configuration',
        behaviorChanged: true, unchangedUpstreamBehaviorClaim: false, entireProfileQualified: false,
        operationalRepositoryScanned: false, nativePushOrHostedForkProof: false, policyAdoption: 'not-performed',
        ruleCount: 222, removedAllowlistGroups: 14,
        currentTree: { expectedFiles: 6, inspectedFiles: 6, findings: 0 },
        introducedHistory: { expectedCommits: 2, inspectedCommits: 2, findings: 5 },
        currentTreeControls: {
          positiveFiles: 6, positiveFindings: 5, cleanFiles: 5, cleanFindings: 0,
          sourceIgnore: 'rejected-before-scanning', cwdIgnore: 'rejected-before-scanning',
          candidateConfig: 'scanned-as-data-not-authority', nativeSuppressedNegativeControl: 0,
          inputCapture: 'checked-at-invocation-and-after-exit'
        },
        executionLimits: { processTimeoutMs: 20000, scannerTimeoutSeconds: 15, reportBytes: 65536, maxDecodeDepth: 0, maxArchiveDepth: 0 },
        cleanup: 'completed'
      });
      expect(result.observations).toHaveLength(5);
      expect(result.observations.filter(item => item.rule === 'aws-access-token')).toHaveLength(4);
      expect(result.observations.filter(item => item.rule === 'pkcs12-file')).toHaveLength(1);
      expect(result.observations.every(item => item.disposition === 'unresolved' && item.proposalAuthority === 'none')).toBe(true);
      expect(JSON.stringify(result)).not.toContain(['AKIA', 'IOSFODNN7', 'EXAMPLE'].join(''));
      expect(JSON.stringify(result)).not.toContain(sentinel);
      const repeated = await qualifyDerivedProfileFixtures(tool, process.cwd(), '/usr/bin/git', source);
      expect(repeated.fixtureCommits).toEqual(result.fixtureCommits);
      expect(repeated.observations).toEqual(result.observations);
      console.log(JSON.stringify(result));
    } finally { vi.unstubAllEnvs(); await tool.cleanup(); }
  },
  180_000
);
