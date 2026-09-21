import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CHECKOV_FIXTURE_POLICY, checkovFixtureEnvironment, parseCheckovFixtureOutput,
  qualifyCheckovBoundaryProbe, qualifyCheckovFixtures, verifyCheckovGuardContract
} from '../scripts/repository-security/checkov.ts';

const sentinel = 'CHECKOV_NONFUNCTIONAL_BOUNDARY_SENTINEL_000000';
const root = path.join(process.cwd(), '.cache', 'checkov fixture with spaces');
// schema, framework, resources, passed, failed, skipped, errors, identity,
// record status, first/last line, engine success, native exit, denied IPv6 probe,
// exact private grammar cache, exact nonpersisting null-device writes, denied CPU probe.
const passed = [2, 1, 1, 1, 0, 0, 0, 1, 1, 1, 9, 1, 0, 1, 1, 1, 1, 1, 1];
const failed = [2, 1, 1, 0, 1, 0, 0, 1, 1, 1, 9, 1, 1, 1, 1, 1, 1, 1, 1];
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const withField = (index: number, value: unknown) => passed.map((n, i) => i === index ? value : n);

describe('Checkov fixture policy and metadata projection', () => {
  it('pins only the authorized installed version/framework/rule and finite bounds', () => {
    expect(CHECKOV_FIXTURE_POLICY).toMatchObject({
      version: '3.3.10', framework: 'terraform', rule: 'CKV_AZURE_3',
      attribute: 'enable_https_traffic_only', timeoutMs: 60_000, reportBytes: 4096
    });
    expect(Object.isFrozen(CHECKOV_FIXTURE_POLICY)).toBe(true);
  });

  it('isolates config/home and excludes Prisma, Bridgecrew, cloud, proxy and Python injection credentials', () => {
    for (const key of ['BC_API_KEY', 'PRISMA_API_URL', 'PRISMA_ACCESS_KEY', 'PRISMA_SECRET_KEY',
      'AWS_ACCESS_KEY_ID', 'AZURE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS',
      'HTTP_PROXY', 'HTTPS_PROXY', 'PYTHONPATH', 'CHECKOV_CONFIG_FILE', 'GIT_DIR']) {
      vi.stubEnv(key, sentinel);
    }
    try {
      const env = checkovFixtureEnvironment(root);
      expect(env.HOME).toBe(path.join(root, 'home'));
      expect(env.XDG_CONFIG_HOME).toBe(path.join(root, 'home'));
      expect(env.TMPDIR).toBe(path.join(root, 'scratch'));
      expect(env.DOWNLOAD_EXTERNAL_MODULES).toBe('False');
      expect(env.BC_SKIP_MAPPING).toBe('TRUE');
      expect(env.CKV_PARSE_ERROR_FAIL).toBe('true');
      expect(env.CKV_SKIP_PACKAGE_UPDATE_CHECK).toBe('true');
      expect(env.GIT_PYTHON_REFRESH).toBe('quiet');
      expect(env.CHECKOV_PARALLELIZATION_TYPE).toBe('none');
      expect(env.CHECKOV_WORKERS_NUMBER).toBe('1');
      expect(env.PYTHONNOUSERSITE).toBe('1');
      expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
      for (const key of ['BC_API_KEY', 'PRISMA_API_URL', 'PRISMA_ACCESS_KEY', 'PRISMA_SECRET_KEY',
        'AWS_ACCESS_KEY_ID', 'AZURE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS',
        'HTTP_PROXY', 'HTTPS_PROXY', 'PYTHONPATH', 'CHECKOV_CONFIG_FILE', 'GIT_DIR',
        'CKV_SKIP_CHECK', 'GITLEAKS_CONFIG', 'NODE_OPTIONS', 'SSLKEYLOGFILE']) expect(env).not.toHaveProperty(key);
      expect(JSON.stringify(env)).not.toContain(sentinel);
    } finally { vi.unstubAllEnvs(); }
  });

  it('requires an applicable successful check for the secure fixture', () => {
    const result = parseCheckovFixtureOutput(bytes(passed), 0);
    expect(result).toEqual({
      framework: 'terraform', rule: 'CKV_AZURE_3', assessment: 'qualified', gate: 'passed',
      resourceCount: 1, passed: 1, failed: 0, skipped: 0, parsingErrors: 0, line: 1, endLine: 9,
      deniedIpv6CapabilityProbes: 1, registeredGrammarCaches: 1, discardedNullWrites: 1,
      deniedProcessorCapabilityProbes: 1, deniedArchitectureCapabilityProbes: 1, deniedGitImportCapabilityProbes: 1
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('separates complete analysis with a blocking rule violation from incomplete execution', () => {
    expect(parseCheckovFixtureOutput(bytes(failed), 1)).toMatchObject({
      assessment: 'qualified', gate: 'blocked', rule: 'CKV_AZURE_3', passed: 0, failed: 1
    });
  });

  it.each([
    ['zero resources', withField(2, 0), 'incomplete-analysis'],
    ['multiple resources', withField(2, 2), 'incomplete-analysis'],
    ['no applicable checks', withField(3, 0), 'incomplete-analysis'],
    ['multiple applicable checks', withField(3, 2), 'incomplete-analysis'],
    ['passed and failed', withField(4, 1), 'incomplete-analysis'],
    ['skipped check', withField(5, 1), 'incomplete-analysis'],
    ['parsing errors', withField(6, 1), 'incomplete-analysis'],
    ['unregistered rule/resource/file', withField(7, 0), 'identity-mismatch'],
    ['suppression or unknown result', withField(8, 0), 'identity-mismatch'],
    ['engine failure', withField(11, 0), 'incomplete-analysis'],
    ['wrong framework', withField(1, 0), 'invalid-report'],
    ['wrong schema', withField(0, 1), 'invalid-report'],
    ['unknown capability probe count', withField(13, 2), 'invalid-report'],
    ['unregistered grammar cache', withField(14, 0), 'incomplete-analysis'],
    ['extra grammar cache', withField(14, 2), 'incomplete-analysis'],
    ['excess discard writes', withField(15, 101), 'invalid-report'],
    ['excess processor probes', withField(16, 5), 'invalid-report'],
    ['excess architecture probes', withField(17, 5), 'invalid-report'],
    ['repeated Git import probe', withField(18, 2), 'invalid-report'],
    ['invalid first line', withField(9, 0), 'invalid-report'],
    ['backwards lines', withField(9, 10), 'invalid-report'],
    ['outside fixture range', withField(10, 10), 'invalid-report'],
    ['unknown exit', withField(12, 2), 'process-error'],
    ['extra field', [...passed, 0], 'invalid-report'],
    ['missing field', passed.slice(1), 'invalid-report'],
    ['negative count', withField(3, -1), 'invalid-report'],
    ['fractional count', withField(3, 0.5), 'invalid-report'],
    ['string count', withField(3, '1'), 'invalid-report'],
    ['boolean count', withField(3, true), 'invalid-report'],
    ['null count', withField(3, null), 'invalid-report'],
    ['huge count', withField(3, 10001), 'invalid-report'],
    ['nested data', withField(3, [1]), 'invalid-report'],
    ['native JSON', { check_type: 'terraform', results: { code_block: sentinel } }, 'invalid-report'],
    ['arbitrary metadata string', withField(7, sentinel), 'invalid-report'],
    ['native error', { error: sentinel }, 'invalid-report']
  ])('rejects %s, never interpreting it as clean', (_name, value, code) => {
    expect(() => parseCheckovFixtureOutput(bytes(value), 0)).toThrow(`Checkov fixture rejected: ${code}.`);
  });

  it.each([
    ['generic tool error', [0, 1], 'process-error'],
    ['network attempt', [0, 2], 'network-attempt'],
    ['unexpected scanner output', [0, 3], 'unsafe-output'],
    ['different installed version', [0, 4], 'version-mismatch'],
    ['child process attempt', [0, 5], 'subprocess-attempt'],
    ['filesystem write/source read attempt', [0, 6], 'filesystem-attempt']
  ])('preserves metadata-only %s failures', (_name, value, code) => {
    expect(() => parseCheckovFixtureOutput(bytes(value), 2)).toThrow(`Checkov fixture rejected: ${code}.`);
  });

  it('reports only allowlisted network operation/family/installed-function identities', () => {
    let error: unknown;
    try { parseCheckovFixtureOutput(bytes([0, 2, 8, 3, 1]), 2); } catch (failure: unknown) { error = failure; }
    expect(String(error)).toBe('CheckovFixtureError: Checkov fixture rejected: network-attempt.');
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'CheckovFixtureError',
      code: 'network-attempt',
      networkDiagnostic: {
        operation: 'socket.bind', family: 'AF_INET6', installedFrame: 'urllib3.util.connection._has_ipv6'
      }
    });
  });

  it.each([
    [0, 2, 8, 3, sentinel], [0, 2, 8, sentinel, 1], [0, 2, sentinel, 3, 1],
    [0, 2, 10, 3, 1], [0, 2, 8, 4, 1], [0, 2, 8, 3, 3],
    [0, 2, 8, 3, 1, sentinel], [0, 1, 8, 3, 1]
  ])('rejects unregistered diagnostic values %#', (...row) => {
    expect(() => parseCheckovFixtureOutput(bytes(row), 2)).toThrow(/invalid-report/);
  });

  it.each([
    [passed, 1], [failed, 0], [passed, 2], [failed, 2], [passed, -1], [passed, 0.5]
  ])('rejects exit/result inconsistency %#', (value, code) => {
    expect(() => parseCheckovFixtureOutput(bytes(value), code)).toThrow(/process-error/);
  });

  it.each([
    Buffer.from(`{"code_block":"${sentinel}`), Buffer.from(sentinel), Buffer.from('[] []'),
    new Uint8Array([0xff]), new Uint8Array(), Buffer.alloc(4097, 32)
  ])('suppresses raw JSON/UTF8/parser errors %#', value => {
    let error: unknown;
    try { parseCheckovFixtureOutput(value, 0); } catch (failure: unknown) { error = failure; }
    expect(String(error)).toBe('CheckovFixtureError: Checkov fixture rejected: invalid-report.');
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(error).not.toHaveProperty('cause');
    if (error instanceof Error) expect(error.stack).not.toContain(sentinel);
  });
});

describe('shared real-process redaction and registered cleanup, before scanner execution', () => {
  it.each([
    ['stdout', 'invalid-report'], ['stderr', 'unsafe-output'], ['metadata', 'invalid-report'],
    ['oversize', 'unsafe-output'], ['timeout', 'timeout'], ['failure', 'invalid-report']
  ] as const)('blocks %s without exposing a sentinel or touching neighboring files', async (kind, code) => {
    const cache = path.join(process.cwd(), '.cache');
    await mkdir(cache, { recursive: true });
    const neighbor = path.join(cache, `checkov-probe-neighbor-${randomUUID()}`);
    await writeFile(neighbor, 'separately registered fixture marker', { flag: 'wx', mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let rejection: unknown;
      try { await qualifyCheckovBoundaryProbe(process.cwd(), kind); } catch (failure: unknown) { rejection = failure; }
      expect(String(rejection)).toBe(`CheckovFixtureError: Checkov fixture rejected: ${code}.`);
      expect(JSON.stringify(rejection)).not.toContain(sentinel);
      expect(rejection).not.toHaveProperty('cause');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(await readFile(neighbor, 'utf8')).toBe('separately registered fixture marker');
    } finally { await unlink(neighbor); }
  });
});

// Explicit opt-in: no installed Checkov/Python assumption in ordinary tests.
it.runIf(process.env.LIFTOFF_CHECKOV_GUARD_PROOF === '1')(
  'proves exact denied capability-probe accounting without scanner rule execution',
  async () => {
    const result = await verifyCheckovGuardContract(
      process.cwd(), process.env.LIFTOFF_CHECKOV_EXECUTABLE ?? '/opt/homebrew/bin/checkov'
    );
    expect(result).toMatchObject({
      scope: 'guard-contract-only', scannerRulesExecuted: false, outboundTrafficAllowed: false,
      predicateCases: 14, blockedOutboundAuditCases: 4, cleanup: 'completed'
    });
    expect(result).toMatchObject({ blockedSubprocessAuditCases: 4, optionalSubprocessesStarted: 0 });
    expect(result.ipv6ProbeModuleDigest).toBe(CHECKOV_FIXTURE_POLICY.ipv6ProbeModuleDigest);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    console.log(JSON.stringify(result));
  },
  180_000
);

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_FIXTURE === '1')(
  'qualifies installed Checkov 3.3.10 CKV_AZURE_3 on private nonfunctional transport fixtures only',
  async () => {
    const result = await qualifyCheckovFixtures(
      process.cwd(), process.env.LIFTOFF_CHECKOV_EXECUTABLE ?? '/opt/homebrew/bin/checkov'
    );
    expect(result).toMatchObject({
      scope: 'new-private-nonfunctional-fixtures-only', version: '3.3.10',
      framework: 'terraform', rule: 'CKV_AZURE_3', cleanup: 'completed',
      repositoryContentScanned: false, cloudOperations: false, osNetworkSandbox: false,
      toolchainClaim: 'installed-launcher-and-interpreter-only'
    });
    expect(result.results.map(item => [item.passed, item.failed, item.gate])).toEqual([
      [1, 0, 'passed'], [0, 1, 'blocked']
    ]);
    expect(result.launcherDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.interpreterDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('nonfunctional-fixture-group');
    expect(JSON.stringify(result)).not.toContain('code_block');
    console.log(JSON.stringify(result));
  },
  180_000
);
