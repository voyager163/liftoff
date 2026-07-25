import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditTemplateDependencyInventory,
  evaluateTemplateDependencyAudits,
  formatTemplateDependencyAudit,
  formatTemplateDependencyAuditMarkdown,
  normalizeNpmAuditReport,
  parseNpmAuditCommandResult,
  parseTemplateDependencyPolicy,
  resolveTemplateDependencyPath,
  templateDependencyInventory,
  validateTemplateDependencyInventory
} from '../scripts/template-dependency-security.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturesRoot = new URL('./fixtures/template-dependency-audit/', import.meta.url);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, fixturesRoot), 'utf8')) as Record<string, unknown>;
}

function inventoryEntry(
  id: string,
  pathParts: string[] = ['assets', id, 'package-lock.json']
) {
  return { id, label: `${id} template`, pathParts };
}

function exceptionFor(
  entry: ReturnType<typeof inventoryEntry>,
  values: Partial<Record<string, unknown>> = {}
) {
  return {
    advisoryId: 'GHSA-AAAA-BBBB-CCCC',
    package: 'direct-package',
    manifestPathParts: entry.pathParts,
    dependencyChains: [['direct-package']],
    disposition: 'vulnerable-code-not-used',
    rationale: 'Fixture vulnerable behavior is not invoked.',
    mitigation: 'Keep the fixture behavior unreachable.',
    owner: 'maintainer',
    reviewedAt: '2026-07-01',
    reviewBy: '2026-07-31',
    upstreamReference: 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC',
    ...values
  };
}

describe('template dependency security', () => {
  it('tracks exactly the packaged npm template lockfiles', async () => {
    const packagedPaths = [
      'assets/locks/node-backend/package-lock.json',
      'assets/locks/frontend/package-lock.json',
      'assets/power-apps-code-app/3438c352483e40982f6c5c0fc36fd71f8e7adbbb/starter/package-lock.json'
    ];

    const resolved = await validateTemplateDependencyInventory(
      repositoryRoot,
      templateDependencyInventory,
      packagedPaths
    );

    expect(resolved.map((entry) => entry.id)).toEqual([
      'node-backend',
      'standard-frontend',
      'power-apps-code-app'
    ]);
    await expect(validateTemplateDependencyInventory(
      repositoryRoot,
      templateDependencyInventory,
      [...packagedPaths, 'assets/untracked/package-lock.json']
    )).rejects.toThrow('untracked packaged locks');
  });

  it('resolves inventory path parts with Windows and POSIX path semantics', () => {
    const parts = ['assets', 'locks', 'frontend', 'package-lock.json'];

    expect(resolveTemplateDependencyPath('C:\\repo', parts, path.win32))
      .toBe('C:\\repo\\assets\\locks\\frontend\\package-lock.json');
    expect(resolveTemplateDependencyPath('/repo', parts, path.posix))
      .toBe('/repo/assets/locks/frontend/package-lock.json');
  });

  it('strictly parses the checked-in exception policy', () => {
    const source = readFileSync(
      path.join(repositoryRoot, 'security', 'template-dependency-exceptions.json'),
      'utf8'
    );
    const policy = parseTemplateDependencyPolicy(source, templateDependencyInventory);

    expect(policy.schemaVersion).toBe(1);
    expect(policy.exceptions).toHaveLength(4);
    expect(policy.exceptions.map((entry) => entry.advisoryId)).toEqual([
      'GHSA-67MH-4WV8-2F99',
      'GHSA-QWWW-VCR4-C8H2',
      'GHSA-W5HQ-G745-H8PQ',
      'GHSA-MH99-V99M-4GVG'
    ]);
    expect(policy.exceptions.at(-1)?.dependencyChains).toHaveLength(3);
  });

  it('rejects malformed, duplicate, and out-of-inventory policy entries', () => {
    const entry = inventoryEntry('fixture');
    const base = exceptionFor(entry);

    expect(() => parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [base, base]
    }, [entry])).toThrow('duplicates');
    expect(() => parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [{ ...base, manifestPathParts: ['assets', 'other', 'package-lock.json'] }]
    }, [entry])).toThrow('not in the packaged lockfile inventory');
    expect(() => parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [{ ...base, reviewedAt: '2026-02-30' }]
    }, [entry])).toThrow('not a valid calendar date');
    expect(() => parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [{
        ...base,
        dependencyChains: [
          ['direct-package'],
          ['direct-package']
        ]
      }]
    }, [entry])).toThrow('duplicate chain');
    expect(() => parseTemplateDependencyPolicy('{"schemaVersion":')).toThrow('not valid JSON');
  });

  it('normalizes direct and transitive advisory chains deterministically', () => {
    const directEntry = inventoryEntry('direct');
    const direct = normalizeNpmAuditReport(directEntry, fixture('direct.json'));
    expect(direct).toMatchObject([{
      advisoryId: 'GHSA-AAAA-BBBB-CCCC',
      package: 'direct-package',
      severity: 'high',
      affectedNodes: ['node_modules/direct-package'],
      dependencyChains: [['direct-package']]
    }]);

    const transitive = normalizeNpmAuditReport(
      inventoryEntry('transitive'),
      fixture('transitive.json')
    );
    expect(transitive).toMatchObject([{
      advisoryId: 'GHSA-DDDD-EEEE-FFFF',
      package: 'leaf-package',
      affectedNodes: ['node_modules/leaf-package'],
      dependencyChains: [['root-package', 'middle-package', 'leaf-package']]
    }]);
    const mixed = normalizeNpmAuditReport(
      inventoryEntry('mixed-direct-transitive'),
      fixture('mixed-direct-transitive.json')
    );
    expect(mixed).toMatchObject([{
      advisoryId: 'GHSA-DDDD-EEEE-FFFF',
      package: 'leaf-package',
      dependencyChains: [
        ['leaf-package'],
        ['root-package', 'leaf-package']
      ]
    }]);
    expect(() => normalizeNpmAuditReport(
      inventoryEntry('unidentified'),
      fixture('unidentified.json')
    )).toThrow('has no GHSA identifier');
    expect(() => normalizeNpmAuditReport(inventoryEntry('dangling'), {
      auditReportVersion: 2,
      vulnerabilities: {
        wrapper: {
          name: 'wrapper',
          severity: 'high',
          isDirect: true,
          via: ['missing'],
          effects: [],
          nodes: ['node_modules/wrapper']
        }
      },
      metadata: {
        vulnerabilities: {
          total: 1
        }
      }
    })).toThrow('references unknown vulnerability missing');
  });

  it('rejects incomplete dependency graphs and contradictory metadata', () => {
    const entry = inventoryEntry('malformed-graph');
    const advisory = {
      source: 1,
      dependency: 'leaf-package',
      title: 'Malformed graph fixture advisory',
      url: 'https://github.com/advisories/GHSA-DDDD-EEEE-FFFF',
      severity: 'high',
      range: '<2.0.0'
    };
    const reportFor = (vulnerability: Record<string, unknown>) => ({
      auditReportVersion: 2,
      vulnerabilities: {
        'leaf-package': {
          name: 'leaf-package',
          severity: 'high',
          isDirect: false,
          via: [advisory],
          effects: [],
          nodes: ['node_modules/leaf-package'],
          fixAvailable: false,
          ...vulnerability
        }
      },
      metadata: {
        vulnerabilities: {
          high: 1,
          total: 1
        }
      }
    });

    expect(() => normalizeNpmAuditReport(
      entry,
      reportFor({ effects: ['missing-parent'] })
    )).toThrow('references unknown parent missing-parent');
    expect(() => normalizeNpmAuditReport(
      entry,
      reportFor({ effects: [] })
    )).toThrow('does not reach a direct dependency');
    expect(() => normalizeNpmAuditReport(entry, {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          total: 1
        }
      }
    })).toThrow('claims 1 vulnerabilities but contains 0 records');
  });

  it('requires an independent exception for the same advisory in each manifest', () => {
    const first = inventoryEntry('first');
    const second = inventoryEntry('second');
    const policy = parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [exceptionFor(first)]
    }, [first, second]);
    const result = evaluateTemplateDependencyAudits({
      auditResults: [
        { entry: first, auditReport: fixture('direct.json') },
        { entry: second, auditReport: fixture('direct.json') }
      ],
      policy,
      today: '2026-07-15',
      resolvedAdvisories: []
    });

    expect(result.ok).toBe(false);
    expect(result.reviewed).toHaveLength(1);
    expect(result.issues).toMatchObject([{
      code: 'unreviewed-finding',
      finding: { manifestId: 'second' }
    }]);
  });

  it('requires exceptions to review the complete dependency-chain set', () => {
    const entry = inventoryEntry('multiple-chains');
    const auditReport = fixture('multiple-chains.json');
    const findings = normalizeNpmAuditReport(entry, auditReport);
    const expectedChains = [
      ['root-package', 'middle-a', 'leaf-package'],
      ['root-package', 'middle-b', 'leaf-package']
    ];
    expect(findings).toMatchObject([{
      advisoryId: 'GHSA-DDDD-EEEE-FFFF',
      package: 'leaf-package',
      dependencyChains: expectedChains
    }]);

    const partialPolicy = parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [exceptionFor(entry, {
        advisoryId: 'GHSA-DDDD-EEEE-FFFF',
        package: 'leaf-package',
        dependencyChains: [expectedChains[0]]
      })]
    }, [entry]);
    const partial = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport }],
      policy: partialPolicy,
      today: '2026-07-15',
      resolvedAdvisories: []
    });
    expect(partial.issues).toMatchObject([{ code: 'dependency-chain-mismatch' }]);

    const exactPolicy = parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [exceptionFor(entry, {
        advisoryId: 'GHSA-DDDD-EEEE-FFFF',
        package: 'leaf-package',
        dependencyChains: [...expectedChains].reverse()
      })]
    }, [entry]);
    const exact = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport }],
      policy: exactPolicy,
      today: '2026-07-15',
      resolvedAdvisories: []
    });
    expect(exact.ok).toBe(true);
    expect(exact.reviewed).toHaveLength(1);

    const mixedEntry = inventoryEntry('mixed-direct-transitive');
    const mixedAuditReport = fixture('mixed-direct-transitive.json');
    const directOnlyPolicy = parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [exceptionFor(mixedEntry, {
        advisoryId: 'GHSA-DDDD-EEEE-FFFF',
        package: 'leaf-package',
        dependencyChains: [['leaf-package']]
      })]
    }, [mixedEntry]);
    const directOnly = evaluateTemplateDependencyAudits({
      auditResults: [{ entry: mixedEntry, auditReport: mixedAuditReport }],
      policy: directOnlyPolicy,
      today: '2026-07-15',
      resolvedAdvisories: []
    });
    expect(directOnly.issues).toMatchObject([{ code: 'dependency-chain-mismatch' }]);
  });

  it('enforces dependency chains, expiry, maximum windows, and stale entries', () => {
    const entry = inventoryEntry('fixture');
    const auditResults = [{ entry, auditReport: fixture('direct.json') }];

    for (const [values, code] of [
      [{ dependencyChains: [['other-package', 'direct-package']] }, 'dependency-chain-mismatch'],
      [{ reviewBy: '2026-08-01' }, 'overlong-exception'],
      [{ reviewedAt: '2026-06-01', reviewBy: '2026-07-01' }, 'expired-exception'],
      [{ reviewedAt: '2026-07-16', reviewBy: '2026-07-31' }, 'future-review']
    ] as const) {
      const policy = parseTemplateDependencyPolicy({
        schemaVersion: 1,
        exceptions: [exceptionFor(entry, values)]
      }, [entry]);
      const result = evaluateTemplateDependencyAudits({
        auditResults,
        policy,
        today: '2026-07-15',
        resolvedAdvisories: []
      });
      expect(result.issues.map((issue) => issue.code)).toContain(code);
    }

    const stalePolicy = parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [exceptionFor(entry)]
    }, [entry]);
    const stale = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport: fixture('clean.json') }],
      policy: stalePolicy,
      today: '2026-07-15',
      resolvedAdvisories: []
    });
    expect(stale.issues).toMatchObject([{ code: 'stale-exception' }]);
  });

  it('distinguishes findings from process, registry, and JSON failures', () => {
    const entry = inventoryEntry('fixture');
    const clean = JSON.stringify(fixture('clean.json'));

    expect(parseNpmAuditCommandResult(entry, {
      status: 0,
      stdout: clean,
      stderr: '',
      timedOut: false
    })).toMatchObject({ auditReportVersion: 2 });
    expect(parseNpmAuditCommandResult(entry, {
      status: 1,
      stdout: clean,
      stderr: '',
      timedOut: false
    })).toMatchObject({ auditReportVersion: 2 });
    expect(() => parseNpmAuditCommandResult(entry, {
      status: 2,
      stdout: '',
      stderr: 'registry unavailable',
      timedOut: false
    })).toThrow('exit code 2');
    expect(() => parseNpmAuditCommandResult(entry, {
      status: 1,
      stdout: readFileSync(new URL('malformed.txt', fixturesRoot), 'utf8'),
      stderr: '',
      timedOut: false
    })).toThrow('malformed JSON');
    expect(() => parseNpmAuditCommandResult(entry, {
      status: 1,
      stdout: '{"error":{"summary":"registry unavailable"}}',
      stderr: '',
      timedOut: false
    })).toThrow('unsupported response');
    expect(() => parseNpmAuditCommandResult(entry, {
      status: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })).toThrow('timed out');
    expect(() => parseNpmAuditCommandResult(entry, {
      status: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      errorMessage: 'spawn npm ENOENT'
    })).toThrow('could not start');
  });

  it('keeps package metadata and node_modules untouched during an audit', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-template-audit-'));
    const entry = inventoryEntry('fixture');
    const directory = path.join(tempRoot, 'assets', 'fixture');
    const packagePath = path.join(directory, 'package.json');
    const lockPath = path.join(directory, 'package-lock.json');
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(packagePath, '{"name":"fixture","version":"1.0.0"}\n');
      await writeFile(lockPath, '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');

      const auditResults = await auditTemplateDependencyInventory({
        repositoryRoot: tempRoot,
        inventory: [entry],
        runAudit: async () => ({
          status: 0,
          stdout: JSON.stringify(fixture('clean.json')),
          stderr: '',
          timedOut: false
        })
      });

      expect(auditResults).toHaveLength(1);
      expect(await readFile(packagePath, 'utf8')).toBe('{"name":"fixture","version":"1.0.0"}\n');
      expect(await readFile(lockPath, 'utf8')).toBe(
        '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'
      );
      await expect(readFile(path.join(directory, 'node_modules'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects audit-time package mutation and node_modules creation', async () => {
    for (const mutation of ['lockfile', 'node_modules']) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-template-audit-mutation-'));
      const entry = inventoryEntry('fixture');
      const directory = path.join(tempRoot, 'assets', 'fixture');
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'package.json'), '{"name":"fixture"}\n');
        await writeFile(
          path.join(directory, 'package-lock.json'),
          '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'
        );
        await expect(auditTemplateDependencyInventory({
          repositoryRoot: tempRoot,
          inventory: [entry],
          runAudit: async () => {
            if (mutation === 'lockfile') {
              await writeFile(path.join(directory, 'package-lock.json'), '{"mutated":true}\n');
            } else {
              await mkdir(path.join(directory, 'node_modules'));
            }
            return {
              status: 0,
              stdout: JSON.stringify(fixture('clean.json')),
              stderr: '',
              timedOut: false
            };
          }
        })).rejects.toThrow(
          mutation === 'lockfile' ? 'modified package metadata' : 'created node_modules'
        );
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it('locks the minimal patched Drizzle and Vite dependency lines', () => {
    const backendPackage = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'locks', 'node-backend', 'package.json'),
      'utf8'
    )) as { dependencies: Record<string, string> };
    const backendLock = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'locks', 'node-backend', 'package-lock.json'),
      'utf8'
    )) as { packages: Record<string, { version?: string }> };
    const frontendPackage = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'locks', 'frontend', 'package.json'),
      'utf8'
    )) as { dependencies: Record<string, string> };
    const frontendLock = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'locks', 'frontend', 'package-lock.json'),
      'utf8'
    )) as { packages: Record<string, { version?: string }> };

    expect(backendPackage.dependencies['drizzle-orm']).toBe('^0.45.2');
    expect(backendLock.packages['node_modules/drizzle-orm']?.version).toBe('0.45.2');
    expect(frontendPackage.dependencies.vite).toBe('^6.4.3');
    expect(frontendPackage.dependencies['@vitejs/plugin-vue']).toBe('^5.0.5');
    expect(frontendLock.packages['node_modules/vite']?.version).toMatch(/^6\./);
    expect(frontendLock.packages['node_modules/esbuild']?.version).toMatch(/^0\.(2[5-9]|[3-9]\d)\./);
    expect(frontendLock.packages['node_modules/@vitejs/plugin-vue']?.version).toMatch(/^5\./);
  });

  it('formats fixed, reviewed, clean, and failing outcomes distinctly', () => {
    const entry = inventoryEntry('fixture');
    const policy = parseTemplateDependencyPolicy({
      schemaVersion: 1,
      exceptions: [exceptionFor(entry)]
    }, [entry]);
    const result = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport: fixture('direct.json') }],
      policy,
      today: '2026-07-15',
      resolvedAdvisories: []
    });

    expect(formatTemplateDependencyAudit(result)).toContain('Template dependency audit: PASS');
    expect(formatTemplateDependencyAudit(result)).toContain('[reviewed]');

    const unreviewed = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport: fixture('direct.json') }],
      policy: parseTemplateDependencyPolicy({ schemaVersion: 1, exceptions: [] }, [entry]),
      today: '2026-07-15',
      resolvedAdvisories: []
    });
    const consoleOutput = formatTemplateDependencyAudit(unreviewed);
    const markdownOutput = formatTemplateDependencyAuditMarkdown(unreviewed);
    for (const output of [consoleOutput, markdownOutput]) {
      expect(output).toContain('severity high');
      expect(output).toContain('node_modules/direct-package');
      expect(output).toContain('direct-package');
    }
  });
});
