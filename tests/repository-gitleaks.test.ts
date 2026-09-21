import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fixtureGitEnvironment, fixtureGitOptions, fixtureMetadataTemplate, GITLEAKS_FIXTURE_PINS,
  installPinnedFixtureGitleaks, parseGitleaksFixtureOutput, qualifyFixtureOutputProbe,
  qualifyGitleaksFixture, captureSuppressionFreeFixtureGitleaks, createPrivateFixtureWorkspace,
  type PinnedFixtureTool
} from '../scripts/repository-security/gitleaks.ts';

const sentinel = 'LIFTOFF_NONFUNCTIONAL_FIXTURE_000000000000000000000000';
const commit = 'a'.repeat(40);
const root = path.join(process.cwd(), '.cache', 'fixture with spaces');
const row = [0, 0, 0, 1, 1, 1, 54, 1];
const encode = (data: unknown) => Buffer.from(JSON.stringify(data));

describe('fixture-only Gitleaks contract', () => {
  it('pins official immutable platform artifacts, not a latest URL or a global install', () => {
    expect(GITLEAKS_FIXTURE_PINS['darwin-arm64']).toEqual({
      version: '8.30.1',
      url: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz',
      sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'
    });
    expect(GITLEAKS_FIXTURE_PINS['linux-x64'].sha256).toBe('551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb');
    expect(Object.isFrozen(GITLEAKS_FIXTURE_PINS)).toBe(true);
    expect(Object.isFrozen(GITLEAKS_FIXTURE_PINS['darwin-arm64'])).toBe(true);
  });

  it('constructs an allowlisted Git environment rather than filtering an inherited environment', () => {
    vi.stubEnv('GIT_DIR', '/do-not-read');
    vi.stubEnv('GIT_WORK_TREE', '/do-not-read');
    vi.stubEnv('GIT_INDEX_FILE', '/do-not-read');
    vi.stubEnv('GIT_OBJECT_DIRECTORY', '/do-not-read');
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', '/do-not-read');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
    vi.stubEnv('GITLEAKS_CONFIG_TOML', sentinel);
    vi.stubEnv('GH_TOKEN', sentinel);
    try {
      const env = fixtureGitEnvironment(root, path.join(root, 'bin'));
      expect(env.HOME).toBe(path.join(root, 'home'));
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_ATTR_NOSYSTEM).toBe('1');
      expect(env.GIT_CONFIG_GLOBAL).toBe(path.join(root, 'empty'));
      expect(env.GIT_CONFIG_SYSTEM).toBe(path.join(root, 'empty'));
      expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GIT_AUTHOR_NAME).toBe('Liftoff Fixture');
      expect(env.GIT_AUTHOR_EMAIL).toBe('fixture@invalid.example');
      expect(env.GIT_COMMITTER_EMAIL).toBe('fixture@invalid.example');
      expect(env.GIT_AUTHOR_DATE).toBe('2020-01-01T00:00:00Z');
      expect(env.TMPDIR).toBe(path.join(root, 'scratch'));
      for (const forbidden of [
        'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK',
        'GITLEAKS_CONFIG', 'GITLEAKS_CONFIG_TOML', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS'
      ]) expect(env).not.toHaveProperty(forbidden);
      expect(JSON.stringify(env)).not.toContain(sentinel);
    } finally { vi.unstubAllEnvs(); }
  });

  it('disables hooks, signing, helpers, protocols, auto-maintenance and external diff per command', () => {
    const options = fixtureGitOptions(root);
    for (const setting of [
      `core.hooksPath=${path.join(root, 'empty-directory')}`, `init.templateDir=${path.join(root, 'empty-directory')}`,
      `core.attributesFile=${path.join(root, 'empty')}`, 'commit.gpgSign=false', 'tag.gpgSign=false',
      'credential.helper=', 'credential.interactive=false', 'core.askPass=', 'core.fsmonitor=false',
      'gc.auto=0', 'maintenance.auto=false', 'protocol.allow=never', 'protocol.file.allow=never', 'diff.external='
    ]) {
      const index = options.indexOf(setting);
      expect(index).toBeGreaterThan(0);
      expect(options[index - 1]).toBe('-c');
    }
    expect(options).not.toContain('--global');
    expect(options).not.toContain('--system');
  });

  it('renders only integer metadata, never even ostensibly safe scanner strings', () => {
    const template = fixtureMetadataTemplate([commit], path.join(root, 'tree', 'fixture.txt'));
    expect(template).not.toMatch(/\{\{\.?(?:Match|Line|Fragment|Author|Email|Message|Description|Fingerprint|Tags)\}\}/);
    expect(template).not.toMatch(/\{\{\.(?:File|Commit|RuleID|Secret)\}\}/);
    expect(template).toContain('{{if eq .Secret "REDACTED"}}1{{else}}0{{end}}');
    expect(template).toContain(`{{if eq .Commit "${commit}"}}0{{else}}-1{{end}}`);
    expect(template).not.toContain(sentinel);
    const actions = [...template.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1] ?? '');
    const interpolations = actions.filter(action => !/^(?:if |else$|end$|range )/.test(action));
    expect(interpolations).toEqual(['.StartLine', '.StartColumn', '.EndLine', '.EndColumn']);
  });

  it.each([
    [], [commit, commit], [sentinel], ['../history'], ['a'.repeat(39)], ['A'.repeat(40)]
  ])('rejects unsafe or duplicate template commit registry %j', (...commits) => {
    expect(() => fixtureMetadataTemplate(commits, path.join(root, 'fixture.txt'))).toThrow(/invalid-input/);
  });

  it('accepts only empty success or a distinct finding exit, not scanner error exit 1', () => {
    expect(parseGitleaksFixtureOutput(encode([]), 0, 1)).toEqual([]);
    const result = parseGitleaksFixtureOutput(encode([row]), 42, 1);
    expect(result).toEqual([{ commitIndex: 0, line: 1, column: 1, endLine: 1, endColumn: 54 }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    ['scanner error with hits', [row], 1],
    ['scanner error without hits', [], 1],
    ['findings with success exit', [row], 0],
    ['nonzero with empty report', [], 42],
    ['unknown error code', [], 2],
    ['unknown metadata object', { findings: [row], match: sentinel }, 42],
    ['native raw finding schema', [{ RuleID: sentinel, Match: sentinel, Secret: sentinel }], 42],
    ['raw match array', [[sentinel]], 42],
    ['extra metadata column', [[...row, sentinel]], 42],
    ['extra numeric column', [[...row, 1]], 42],
    ['missing column', [row.slice(1)], 42],
    ['duplicate finding', [row, row], 42],
    ['unknown rule', [[1, ...row.slice(1)]], 42],
    ['unknown file', [[0, 1, ...row.slice(2)]], 42],
    ['unknown commit', [[0, 0, 1, ...row.slice(3)]], 42],
    ['unredacted secret', [[...row.slice(0, 7), 0]], 42],
    ['zero start line', [[0, 0, 0, 0, 1, 1, 54, 1]], 42],
    ['zero start column', [[0, 0, 0, 1, 0, 1, 54, 1]], 42],
    ['negative value', [[-1, ...row.slice(1)]], 42],
    ['noninteger', [[0.1, ...row.slice(1)]], 42],
    ['numeric string', [['0', ...row.slice(1)]], 42],
    ['boolean', [[false, ...row.slice(1)]], 42],
    ['null', [[null, ...row.slice(1)]], 42],
    ['oversized line', [[0, 0, 0, 10_000_001, 1, 10_000_001, 54, 1]], 42],
    ['backwards range', [[0, 0, 0, 2, 2, 1, 1, 1]], 42],
    ['backwards column', [[0, 0, 0, 1, 2, 1, 1, 1]], 42],
    ['too many findings', Array.from({ length: 9 }, (_, i) => [0, 0, 0, i + 1, 1, i + 1, 54, 1]), 42]
  ])('rejects %s without exposing raw content', (_name, data, exit) => {
    let rejection: unknown;
    try { parseGitleaksFixtureOutput(encode(data), exit, 1); } catch (error: unknown) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toBe('GitleaksFixtureError: Gitleaks fixture rejected: invalid-report.');
    expect(JSON.stringify(rejection)).not.toContain(sentinel);
    expect(rejection).not.toHaveProperty('cause');
  });

  it.each([
    Buffer.from(`{"unterminated":"${sentinel}`), Buffer.from(sentinel), Buffer.from('[] []'),
    new Uint8Array([0xff]), new Uint8Array(), Buffer.alloc(65_537, 32)
  ])('rejects malformed/oversized bytes without native parser error text %#', bytes => {
    expect(() => parseGitleaksFixtureOutput(bytes, 0, 1)).toThrow('Gitleaks fixture rejected: invalid-report.');
  });

  it('will not qualify a caller-invented executable handle', async () => {
    const forged: PinnedFixtureTool = {
      version: '8.30.1', platform: 'darwin-arm64', archiveDigest: 'a'.repeat(64), binaryDigest: 'b'.repeat(64),
      async cleanup() {}
    };
    await expect(qualifyGitleaksFixture(forged, process.cwd(), '/usr/bin/git')).rejects.toThrow(/invalid-input/);
  });
});

describe('real pipe/error boundary qualification without scanning', () => {
  it.each(['source', 'cwd', 'after-registration'] as const)('rejects %s suppression before invoking any tool', async location => {
    const owned = await createPrivateFixtureWorkspace(process.cwd());
    try {
      const source = await owned.directory('source');
      const configuration = { path: await owned.write('detector.toml', 'trusted-fixture-only'), contents: 'trusted-fixture-only' };
      const template = { path: await owned.write('report.tmpl', '[]'), contents: '[]' };
      await writeFile(path.join(source, 'fixture.txt'), 'nonfunctional fixture');
      await owned.register();
      await writeFile(path.join(location === 'cwd' ? owned.root : source, '.gitleaksignore'), 'nonfunctional suppression');
      if (location !== 'after-registration') await owned.register();
      const forged: PinnedFixtureTool = {
        version: '8.30.1', platform: 'darwin-arm64', archiveDigest: 'a'.repeat(64), binaryDigest: 'b'.repeat(64),
        async cleanup() {}
      };
      await expect(captureSuppressionFreeFixtureGitleaks(forged, owned, { source, configuration, template }))
        .rejects.toThrow(location === 'after-registration' ? 'workspace-changed' : 'candidate-suppression');
    } finally { await owned.register(); await owned.cleanup(); }
  });

  it.each([
    ['stdout', 'invalid-report'], ['stderr', 'unsafe-stderr'], ['oversize', 'output-limit'],
    ['timeout', 'timeout'], ['failure', 'invalid-report']
  ] as const)('quarantines %s and removes only its registered workspace', async (kind, code) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = path.join(process.cwd(), '.cache');
    await mkdir(cache, { recursive: true });
    const neighbor = path.join(cache, `gitleaks-probe-neighbor-${randomUUID()}`);
    await writeFile(neighbor, 'separately owned probe marker', { flag: 'wx', mode: 0o600 });
    try {
      let rejection: unknown;
      try { await qualifyFixtureOutputProbe(process.cwd(), kind); } catch (failure: unknown) { rejection = failure; }
      // Awaited cleanup failure replaces the original error, so this also
      // verifies successful removal of the probe's registered root.
      expect(String(rejection)).toBe(`GitleaksFixtureError: Gitleaks fixture rejected: ${code}.`);
      expect(JSON.stringify(rejection)).not.toContain(sentinel);
      expect(rejection).not.toHaveProperty('cause');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(await readFile(neighbor, 'utf8')).toBe('separately owned probe marker');
    } finally { await unlink(neighbor); }
  });
});

// Explicit opt-in: never downloads/scans as part of ordinary offline tests.
it.runIf(process.env.LIFTOFF_REAL_GITLEAKS_FIXTURE === '1')(
  'qualifies pinned real Gitleaks against added-then-removed nonfunctional history only',
  async () => {
    const tool = await installPinnedFixtureGitleaks(process.cwd());
    try {
      const result = await qualifyGitleaksFixture(tool, process.cwd(), '/usr/bin/git');
      expect(result).toMatchObject({
        scope: 'new-disposable-synthetic-repository-only',
        operationalRepositoryScanned: false, nativePushOrForkProof: false, defaultProviderRulesQualified: false,
        scannerVersion: '8.30.1', currentTreeFindingCount: 0, introducedHistoryFindingCount: 1,
        cleanup: 'completed', result: { assessment: 'qualified', gate: 'blocked', protection: 'not-established' }
      });
      expect(result.fixtureCommits).toEqual([
        'db09aa30041eb5bd488cc612686862dea367f651',
        '45d4a32e68099c70afac3573b11d5c5e6f05ddee',
        '456271496a29834737d08ed21f5e81dfe181a43a'
      ]);
      expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.observedAt));
      expect(result.result.findings[0]?.commit).toBe(result.fixtureCommits[1]);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain('fixture@invalid.example');
      console.log(JSON.stringify(result));
    } finally { await tool.cleanup(); }
  },
  120_000
);
