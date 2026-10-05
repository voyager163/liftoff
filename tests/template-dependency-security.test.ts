import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  resolveTemplateDependencyAuditRegistry,
  resolveTemplateDependencyPath,
  TemplateDependencyPolicyError,
  TemplateDependencyStructureError,
  templateDependencyInventory,
  templateDependencySets,
  templateDependencyStructure,
  validateTemplateDependencyInventory,
  validateTemplateDependencyStructure
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

// A deliberate single-set structure for fixture audits: fixture inventories keep their own
// explicit structure instead of relying on the real C1 declarations or any default.
function fixtureStructure(id = 'fixture') {
  const owner = { kind: 'core' };
  return {
    assets: [
      { owner, id: `${id}-manifest`, pathParts: ['assets', id, 'package.json'], set: id, role: 'manifest' },
      { owner, id: `${id}-lock`, pathParts: ['assets', id, 'package-lock.json'], set: id, role: 'lock' }
    ],
    sets: [{ id, ecosystem: 'npm', audit: { mode: 'npm-audit', inventoryId: id } }]
  };
}

async function writeFixturePackageManifest(
  root: string,
  structure: ReturnType<typeof fixtureStructure>
): Promise<void> {
  const files = structure.assets.map((asset) => asset.pathParts.join('/'));
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'fixture-root', files }, null, 2)}\n`);
}

function countingAudit() {
  const calls: string[] = [];
  return {
    calls,
    runAudit: async (entry: { id: string }) => {
      calls.push(entry.id);
      return { status: 0, stdout: JSON.stringify(fixture('clean.json')), stderr: '', timedOut: false };
    }
  };
}

interface StructureMember {
  readonly owner: Record<string, string>;
  readonly id: string;
  readonly pathParts: readonly string[];
  readonly set: string;
  readonly role: string;
}

interface StructureSet {
  readonly id: string;
  readonly ecosystem: string;
  readonly audit: Record<string, string>;
}

const realAssets = templateDependencyStructure.assets as readonly StructureMember[];
const realSets = templateDependencySets as readonly StructureSet[];
const realMembers = realAssets.map((asset) => ({ set: asset.set, path: asset.pathParts.join('/') }));
const mirrorFiles = [
  ['package.json'],
  ['package-lock.json'],
  ['services', 'telemetry-ingest', 'package.json'],
  ['services', 'telemetry-ingest', 'package-lock.json'],
  ...realAssets.map((asset) => [...asset.pathParts])
];

// An owned temporary copy of the files the real audit reads: the root manifest, the four
// inventory locks with their manifests, and every C1 member. Removed after each use.
async function withMirror(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-structure-mirror-'));
  try {
    for (const parts of mirrorFiles) {
      await mkdir(path.join(root, ...parts.slice(0, -1)), { recursive: true });
      await copyFile(path.join(repositoryRoot, ...parts), path.join(root, ...parts));
    }
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type IssueTriple = [string, string | null, string | null];

async function structureIssues(action: () => Promise<unknown>): Promise<IssueTriple[]> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TemplateDependencyStructureError);
  expect(caught).toBeInstanceOf(TemplateDependencyPolicyError);
  return (caught as { issues: Array<{ code: string; set: string | null; path: string | null }> }).issues
    .map((issue): IssueTriple => [issue.code, issue.set, issue.path]);
}

// Runs the real audit entry point with a counting runner and proves that no request was made.
async function auditStructureIssues(
  root: string,
  options: { inventory?: unknown; structure?: unknown } = {}
): Promise<IssueTriple[]> {
  const audit = countingAudit();
  const issues = await structureIssues(() => auditTemplateDependencyInventory({
    repositoryRoot: root,
    inventory: options.inventory ?? templateDependencyInventory,
    structure: options.structure ?? templateDependencyStructure,
    runAudit: audit.runAudit
  }));
  expect(audit.calls).toEqual([]);
  return issues;
}

describe('template dependency security', () => {
  it('defaults audits to canonical npm and validates managed-registry overrides', () => {
    expect(resolveTemplateDependencyAuditRegistry(undefined))
      .toBe('https://registry.npmjs.org');
    expect(resolveTemplateDependencyAuditRegistry(
      'https://packagefeedproxy.microsoft.io/npm/'
    )).toBe('https://packagefeedproxy.microsoft.io/npm/');
    expect(() => resolveTemplateDependencyAuditRegistry(
      'http://packagefeedproxy.microsoft.io/npm/'
    )).toThrow(/credential-free HTTPS URL/);
    expect(() => resolveTemplateDependencyAuditRegistry(
      'https://token@example.test/npm/'
    )).toThrow(/credential-free HTTPS URL/);
  });

  it('tracks exactly the packaged npm template lockfiles', async () => {
    const packagedPaths = [
      'assets/plugins/node-fastify/node-backend/package-lock.json',
      'assets/templates/common/frontend/package-lock.json'
    ];

    const resolved = await validateTemplateDependencyInventory(
      repositoryRoot,
      templateDependencyInventory,
      packagedPaths
    );

    expect(resolved.map((entry) => entry.id)).toEqual([
      'liftoff-cli',
      'telemetry-ingest',
      'node-backend',
      'standard-frontend'
    ]);
    await expect(validateTemplateDependencyInventory(
      repositoryRoot,
      templateDependencyInventory,
      [...packagedPaths, 'assets/untracked/package-lock.json']
    )).rejects.toThrow('untracked packaged locks');
  });

  it('resolves inventory path parts with Windows and POSIX path semantics', () => {
    const parts = ['assets', 'templates', 'common', 'frontend', 'package-lock.json'];

    expect(resolveTemplateDependencyPath('C:\\repo', parts, path.win32))
      .toBe('C:\\repo\\assets\\templates\\common\\frontend\\package-lock.json');
    expect(resolveTemplateDependencyPath('/repo', parts, path.posix))
      .toBe('/repo/assets/templates/common/frontend/package-lock.json');
  });

  it('strictly parses the checked-in exception policy', () => {
    const source = readFileSync(
      path.join(repositoryRoot, 'security', 'template-dependency-exceptions.json'),
      'utf8'
    );
    const policy = parseTemplateDependencyPolicy(source, templateDependencyInventory);

    expect(policy.schemaVersion).toBe(1);
    expect(policy.exceptions).toHaveLength(0);
    expect(policy.exceptions.map((entry) => ({
      advisoryId: entry.advisoryId,
      package: entry.package,
      disposition: entry.disposition
    }))).toEqual([]);
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
      resolvedAdvisories: [],
      sets: []
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
      resolvedAdvisories: [],
      sets: []
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
      resolvedAdvisories: [],
      sets: []
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
      resolvedAdvisories: [],
      sets: []
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
        resolvedAdvisories: [],
        sets: []
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
      resolvedAdvisories: [],
      sets: []
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
    })).toThrow('unsupported response: registry unavailable');
    expect(() => parseNpmAuditCommandResult(entry, {
      status: 1,
      stdout: '{"message":"request failed","error":{"summary":""}}',
      stderr: '',
      timedOut: false
    })).toThrow('unsupported response: request failed');
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
    const structure = fixtureStructure();
    const directory = path.join(tempRoot, 'assets', 'fixture');
    const packagePath = path.join(directory, 'package.json');
    const lockPath = path.join(directory, 'package-lock.json');
    try {
      await mkdir(directory, { recursive: true });
      await writeFixturePackageManifest(tempRoot, structure);
      await writeFile(packagePath, '{"name":"fixture","version":"1.0.0"}\n');
      await writeFile(lockPath, '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');

      const auditResults = await auditTemplateDependencyInventory({
        repositoryRoot: tempRoot,
        inventory: [entry],
        structure,
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
      const structure = fixtureStructure();
      const directory = path.join(tempRoot, 'assets', 'fixture');
      try {
        await mkdir(directory, { recursive: true });
        await writeFixturePackageManifest(tempRoot, structure);
        await writeFile(path.join(directory, 'package.json'), '{"name":"fixture"}\n');
        await writeFile(
          path.join(directory, 'package-lock.json'),
          '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'
        );
        await expect(auditTemplateDependencyInventory({
          repositoryRoot: tempRoot,
          inventory: [entry],
          structure,
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

  it('locks the reviewed backend and frontend baseline dependency lines', () => {
    const backendPackage = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'plugins', 'node-fastify', 'node-backend', 'package.json'),
      'utf8'
    )) as { dependencies: Record<string, string> };
    const backendLock = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'plugins', 'node-fastify', 'node-backend', 'package-lock.json'),
      'utf8'
    )) as { packages: Record<string, { version?: string }> };
    const frontendPackage = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'templates', 'common', 'frontend', 'package.json'),
      'utf8'
    )) as { dependencies: Record<string, string> };
    const frontendLock = JSON.parse(readFileSync(
      path.join(repositoryRoot, 'assets', 'templates', 'common', 'frontend', 'package-lock.json'),
      'utf8'
    )) as { packages: Record<string, { version?: string }> };

    expect(backendPackage.dependencies['drizzle-orm']).toBe('^0.45.2');
    expect(backendLock.packages['node_modules/drizzle-orm']?.version).toBe('0.45.2');
    expect(frontendPackage.dependencies.vite).toBe('^8.2.2');
    expect(frontendPackage.dependencies['@vitejs/plugin-vue']).toBe('^6.0.8');
    expect(frontendPackage.dependencies.tailwindcss).toBe('^4.3.3');
    expect(frontendLock.packages['node_modules/vite']?.version).toBe('8.2.2');
    expect(frontendLock.packages['node_modules/@vitejs/plugin-vue']?.version).toBe('6.0.8');
    expect(frontendLock.packages['node_modules/tailwindcss']?.version).toBe('4.3.3');
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
      resolvedAdvisories: [],
      sets: []
    });

    expect(formatTemplateDependencyAudit(result)).toContain('Template dependency audit: PASS');
    expect(formatTemplateDependencyAudit(result)).toContain('[reviewed]');

    const unreviewed = evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport: fixture('direct.json') }],
      policy: parseTemplateDependencyPolicy({ schemaVersion: 1, exceptions: [] }, [entry]),
      today: '2026-07-15',
      resolvedAdvisories: [],
      sets: []
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

describe('template dependency structure preflight', () => {
  it('validates the real six dependency sets against C1 and the checkout without auditing', async () => {
    const summary = await validateTemplateDependencyStructure({
      repositoryRoot,
      inventory: templateDependencyInventory,
      structure: templateDependencyStructure
    }) as Array<StructureSet & { members: Array<{ path: string }> }>;

    expect(Object.isFrozen(summary)).toBe(true);
    expect(summary.map((set) => set.id)).toEqual([
      'node-backend', 'frontend', 'python-standard', 'python-genai', 'go-backend', 'opentofu-azure'
    ]);
    expect(summary.flatMap((set) => set.members.map((member) => member.path)).sort())
      .toEqual(realMembers.map((member) => member.path).sort());
    expect(summary.filter((set) => set.audit.mode === 'npm-audit').map((set) => [set.id, set.audit.inventoryId]))
      .toEqual([['node-backend', 'node-backend'], ['frontend', 'standard-frontend']]);
    const unaudited = summary.filter((set) => set.audit.mode === 'unaudited');
    expect(unaudited.map((set) => [set.id, set.ecosystem])).toEqual([
      ['python-standard', 'pypi'], ['python-genai', 'pypi'], ['go-backend', 'go'], ['opentofu-azure', 'opentofu']
    ]);
    for (const set of unaudited) expect(set.audit.reason.trim(), set.id).not.toBe('');
  });

  it('runs the real preflight before auditing exactly the four inventory locks', async () => {
    const audit = countingAudit();
    const results = await auditTemplateDependencyInventory({
      repositoryRoot,
      inventory: templateDependencyInventory,
      structure: templateDependencyStructure,
      runAudit: audit.runAudit
    });

    expect(audit.calls).toEqual(['liftoff-cli', 'telemetry-ingest', 'node-backend', 'standard-frontend']);
    expect(results).toHaveLength(4);
  });

  it('accepts an owned mirror of the real structure, so each negative mirror differs by one change', async () => {
    await withMirror(async (root) => {
      const audit = countingAudit();
      await auditTemplateDependencyInventory({
        repositoryRoot: root,
        inventory: templateDependencyInventory,
        structure: templateDependencyStructure,
        runAudit: audit.runAudit
      });
      expect(audit.calls).toEqual(['liftoff-cli', 'telemetry-ingest', 'node-backend', 'standard-frontend']);
    });
  });

  it('refuses a missing member of every dependency set before any audit request', async () => {
    for (const member of realMembers) {
      await withMirror(async (root) => {
        await rm(path.join(root, ...member.path.split('/')));
        expect(await auditStructureIssues(root), member.path)
          .toEqual([['missing-dependency-member', member.set, member.path]]);
      });
    }
    const exportPath = 'assets/plugins/python-fastapi/python-genai/function-requirements.txt';
    await withMirror(async (root) => {
      await rm(path.join(root, ...exportPath.split('/')));
      await mkdir(path.join(root, ...exportPath.split('/')));
      expect(await auditStructureIssues(root))
        .toEqual([['non-regular-dependency-member', 'python-genai', exportPath]]);
    });
  });

  it('refuses missing sets and invalid declarations before reading the filesystem', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-structure-declarations-'));
    // Never created: if any declaration case reached the filesystem, it would report other issues.
    const absentRoot = path.join(parent, 'absent');
    const setWith = (id: string, values: Record<string, unknown>) =>
      realSets.map((set) => (set.id === id ? { ...set, ...values } : set));
    const assetWith = (id: string, values: Record<string, unknown>) =>
      realAssets.map((asset) => (asset.id === id ? { ...asset, ...values } : asset));
    const standardLock = realAssets.find((asset) => asset.id === 'python-standard-lock')!;
    const standardDirectory = 'assets/plugins/python-fastapi/python-standard';
    const cases: Array<[string, { inventory?: unknown; structure: unknown }, IssueTriple[]]> = [
      ['metadata without a declared C1 set',
        { structure: { assets: realAssets, sets: realSets.filter((set) => set.id !== 'go-backend') } },
        [['undeclared-dependency-set', 'go-backend', null]]],
      ['metadata for a set without C1 members',
        { structure: { assets: realAssets, sets: [...realSets, { id: 'extra-set', ecosystem: 'pypi', audit: { mode: 'unaudited', reason: 'Fixture set.' } }] } },
        [['empty-dependency-set', 'extra-set', null]]],
      ['a C1 set without its lock',
        { structure: { assets: realAssets.filter((asset) => asset.id !== 'python-genai-lock'), sets: realSets } },
        [['dependency-set-shape', 'python-genai', null]]],
      ['a duplicate set id',
        { structure: { assets: realAssets, sets: [...realSets, realSets[0]] } },
        [['invalid-dependency-set', 'node-backend', null]]],
      ['an unknown ecosystem',
        { structure: { assets: realAssets, sets: setWith('go-backend', { ecosystem: 'cargo' }) } },
        [['invalid-dependency-set', 'go-backend', null]]],
      ['npm audit for a PyPI set',
        { structure: { assets: realAssets, sets: setWith('python-standard', { audit: { mode: 'npm-audit', inventoryId: 'node-backend' } }) } },
        [['invalid-dependency-set', 'python-standard', null]]],
      ['an empty unaudited reason',
        { structure: { assets: realAssets, sets: setWith('opentofu-azure', { audit: { mode: 'unaudited', reason: '  ' } }) } },
        [['invalid-dependency-set', 'opentofu-azure', null]]],
      ['an npm manifest that npm audit would not read',
        { structure: { assets: assetWith('node-backend-package-manifest', { pathParts: ['assets', 'plugins', 'node-fastify', 'node-backend', 'manifest.json'] }), sets: realSets } },
        [['npm-set-layout', 'node-backend', 'assets/plugins/node-fastify/node-backend/manifest.json']]],
      ['an npm-audit set without an inventory entry',
        { inventory: templateDependencyInventory.filter((entry) => entry.id !== 'standard-frontend'), structure: templateDependencyStructure },
        [['missing-audit-inventory', 'frontend', null]]],
      ['an inventory lock that differs from C1',
        { inventory: templateDependencyInventory.map((entry) => (entry.id === 'node-backend' ? { ...entry, pathParts: ['assets', 'plugins', 'node-fastify', 'node-backend', 'other-lock.json'] } : entry)), structure: templateDependencyStructure },
        [['audit-inventory-mismatch', 'node-backend', 'assets/plugins/node-fastify/node-backend/other-lock.json']]],
      ['an asset inventory entry no set audits',
        { inventory: [...templateDependencyInventory, { id: 'stray', label: 'Stray', pathParts: ['assets', 'stray', 'package-lock.json'] }], structure: templateDependencyStructure },
        [['unowned-audit-inventory', null, 'assets/stray/package-lock.json']]],
      ['a repeated owner and id',
        { structure: { assets: [...realAssets, { ...standardLock }], sets: realSets } },
        [['duplicate-dependency-member', 'python-standard', `${standardDirectory}/uv.lock`]]],
      ['a case-alias path',
        { structure: { assets: [...realAssets, { ...standardLock, id: 'alias-lock', pathParts: ['assets', 'plugins', 'python-fastapi', 'python-standard', 'UV.LOCK'] }], sets: realSets } },
        [['duplicate-dependency-member', 'python-standard', `${standardDirectory}/UV.LOCK`]]]
    ];
    // Extra rows that are not portable names; the real rows keep every set valid.
    for (const part of ['C:uv.lock', 'uv.lock:stream', '..', '', 'CON', 'nul.txt', 'uv.lock.', 'uv lock', 'uv\\lock', 'caf\u00e9.lock']) {
      cases.push([`unsafe path part ${JSON.stringify(part)}`,
        { structure: { assets: [...realAssets, { ...standardLock, id: 'unsafe-lock', pathParts: ['assets', 'plugins', 'python-fastapi', 'python-standard', part] }], sets: realSets } },
        [['invalid-dependency-member', 'python-standard', `${standardDirectory}/${part}`]]]);
    }
    cases.push(
      ['a member outside the assets root',
        { structure: { assets: [...realAssets, { ...standardLock, id: 'outside-lock', pathParts: ['plugins', 'python-standard', 'uv.lock'] }], sets: realSets } },
        [['invalid-dependency-member', 'python-standard', 'plugins/python-standard/uv.lock']]],
      ['an unknown member role',
        { structure: { assets: [...realAssets, { ...standardLock, id: 'readme', role: 'readme', pathParts: ['assets', 'plugins', 'python-fastapi', 'python-standard', 'README.md'] }], sets: realSets } },
        [['invalid-dependency-member', 'python-standard', `${standardDirectory}/README.md`]]],
      ['an incomplete plugin owner',
        { structure: { assets: [...realAssets, { ...standardLock, id: 'ownerless', owner: { kind: 'plugin' }, pathParts: ['assets', 'plugins', 'python-fastapi', 'python-standard', 'other.lock'] }], sets: realSets } },
        [['invalid-dependency-member', 'python-standard', `${standardDirectory}/other.lock`]]],
      ['a case alias of the assets root in the audit inventory',
        { inventory: [...templateDependencyInventory, { id: 'alias', label: 'Alias', pathParts: ['ASSETS', 'plugins', 'node-fastify', 'node-backend', 'package-lock.json'] }], structure: templateDependencyStructure },
        [['unowned-audit-inventory', null, 'ASSETS/plugins/node-fastify/node-backend/package-lock.json']]]
    );
    // Undefined parts, holes and other non-string parts are refused without a path, like null.
    const sparseParts = ['assets', 'plugins', , 'python-standard', 'sparse.lock'];
    const sparseProbe = ['assets', , 'fixture', 'uv.lock'];
    expect(Object.hasOwn(sparseParts, 2)).toBe(false);
    expect(Object.hasOwn(sparseProbe, 1)).toBe(false);
    for (const [label, pathParts] of [
      ['an undefined path part', ['assets', 'plugins', 'python-fastapi', undefined, 'probe.lock']],
      ['a sparse path part', sparseParts],
      ['a null path part', ['assets', 'plugins', 'python-fastapi', null, 'probe.lock']],
      ['a numeric path part', ['assets', 'plugins', 'python-fastapi', 7, 'probe.lock']],
      ['the reviewed undefined shape', ['assets', 'fixture', undefined, 'uv.lock']],
      ['the reviewed sparse shape', sparseProbe]
    ] as Array<[string, unknown[]]>) {
      cases.push([label,
        { structure: { assets: [...realAssets, { ...standardLock, id: 'probe-lock', pathParts }], sets: realSets } },
        [['invalid-dependency-member', 'python-standard', null]]]);
    }
    try {
      for (const [label, options, expected] of cases) {
        expect(await auditStructureIssues(absentRoot, options), label).toEqual(expected);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('refuses a set whose optional member is no longer declared while its file is still packaged', async () => {
    const exportPath = 'assets/plugins/python-fastapi/python-genai/function-requirements.txt';
    expect(await auditStructureIssues(repositoryRoot, {
      structure: {
        assets: realAssets.filter((asset) => asset.id !== 'python-genai-function-requirements'),
        sets: realSets
      }
    })).toEqual([['unexpected-package-entry', 'python-genai', exportPath]]);
  });

  it('refuses members omitted from package.json files before any audit request', async () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      files: string[];
    };
    const writeFiles = (root: string, files: string[]) =>
      writeFile(path.join(root, 'package.json'), `${JSON.stringify({ ...packageJson, files }, null, 2)}\n`);
    for (const member of realMembers) {
      await withMirror(async (root) => {
        await writeFiles(root, packageJson.files.filter((entry) => entry !== member.path));
        expect(await auditStructureIssues(root), member.path)
          .toEqual([['undeclared-package-member', member.set, member.path]]);
      });
    }
    const goDirectory = 'assets/plugins/go-huma/go-backend';
    await withMirror(async (root) => {
      await writeFiles(root, [...packageJson.files.filter((entry) => !entry.startsWith(`${goDirectory}/`)), goDirectory]);
      expect(await auditStructureIssues(root)).toEqual([
        ['undeclared-package-member', 'go-backend', `${goDirectory}/go.mod`],
        ['undeclared-package-member', 'go-backend', `${goDirectory}/go.sum`],
        ['unexpected-package-entry', 'go-backend', goDirectory]
      ]);
    });
    await withMirror(async (root) => {
      await writeFiles(root, [...packageJson.files, `${goDirectory}/extra.txt`]);
      expect(await auditStructureIssues(root))
        .toEqual([['unexpected-package-entry', 'go-backend', `${goDirectory}/extra.txt`]]);
    });
    await withMirror(async (root) => {
      await writeFiles(root, [...packageJson.files, 'assets/plugins/**']);
      expect(await auditStructureIssues(root)).toEqual(
        ['go-backend', 'node-backend', 'opentofu-azure', 'python-genai', 'python-standard']
          .map((set): IssueTriple => ['unexpected-package-entry', set, 'assets/plugins/**'])
      );
    });
    await withMirror(async (root) => {
      await rm(path.join(root, 'package.json'));
      expect(await auditStructureIssues(root)).toEqual([['unreadable-package-manifest', null, 'package.json']]);
    });
    await withMirror(async (root) => {
      await writeFile(path.join(root, 'package.json'), '{ "files": ');
      expect(await auditStructureIssues(root)).toEqual([['unreadable-package-manifest', null, 'package.json']]);
    });
  });

  it('refuses portable case aliases of set directories and members in package.json files', async () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      files: string[];
    };
    const writeFiles = (root: string, files: string[]) =>
      writeFile(path.join(root, 'package.json'), `${JSON.stringify({ ...packageJson, files }, null, 2)}\n`);
    const pluginSets = ['go-backend', 'node-backend', 'opentofu-azure', 'python-genai', 'python-standard'];
    const goModule = 'assets/plugins/go-huma/go-backend/go.mod';
    for (const alias of ['ASSETS/plugins', 'Assets/Plugins']) {
      for (const files of [[...packageJson.files, alias], [alias, ...packageJson.files]]) {
        await withMirror(async (root) => {
          await writeFiles(root, files);
          expect(await auditStructureIssues(root), alias)
            .toEqual(pluginSets.map((set): IssueTriple => ['unexpected-package-entry', set, alias]));
        });
      }
    }
    const moduleAlias = 'ASSETS/plugins/go-huma/go-backend/go.mod';
    await withMirror(async (root) => {
      await writeFiles(root, [...packageJson.files, moduleAlias]);
      expect(await auditStructureIssues(root)).toEqual([['unexpected-package-entry', 'go-backend', moduleAlias]]);
    });
    await withMirror(async (root) => {
      await writeFiles(root, packageJson.files.map((entry) => (entry === goModule ? moduleAlias : entry)));
      expect(await auditStructureIssues(root)).toEqual([
        ['undeclared-package-member', 'go-backend', goModule],
        ['unexpected-package-entry', 'go-backend', moduleAlias]
      ]);
    });
  });

  it('requires an explicit structure for audits and explicit sets for evaluation', async () => {
    const audit = countingAudit();
    await expect(auditTemplateDependencyInventory({
      repositoryRoot,
      inventory: templateDependencyInventory,
      runAudit: audit.runAudit
    })).rejects.toThrow(TypeError);
    await expect(auditTemplateDependencyInventory({
      repositoryRoot,
      inventory: templateDependencyInventory,
      structure: {},
      runAudit: audit.runAudit
    })).rejects.toThrow(TypeError);
    expect(audit.calls).toEqual([]);
    const policy = parseTemplateDependencyPolicy({ schemaVersion: 1, exceptions: [] }, templateDependencyInventory);
    expect(() => evaluateTemplateDependencyAudits({ auditResults: [], policy })).toThrow(TypeError);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'propagates an unexpected filesystem error instead of reporting a policy issue (POSIX, non-root only)',
    async () => {
      await withMirror(async (root) => {
        const directory = path.join(root, 'assets', 'plugins', 'python-fastapi', 'python-genai');
        const audit = countingAudit();
        await chmod(directory, 0o000);
        let failure: unknown;
        try {
          failure = await auditTemplateDependencyInventory({
            repositoryRoot: root,
            inventory: templateDependencyInventory,
            structure: templateDependencyStructure,
            runAudit: audit.runAudit
          }).then(() => undefined, (error: unknown) => error);
        } finally {
          await chmod(directory, 0o755);
        }
        expect(failure).toMatchObject({ code: 'EACCES' });
        expect(failure).not.toBeInstanceOf(TemplateDependencyPolicyError);
        expect(audit.calls).toEqual([]);
      });
    }
  );
});

describe('template dependency advisory coverage', () => {
  const cleanResults = () => templateDependencyInventory.map((entry) => ({
    entry,
    auditReport: fixture('clean.json')
  }));
  const emptyPolicy = () =>
    parseTemplateDependencyPolicy({ schemaVersion: 1, exceptions: [] }, templateDependencyInventory);

  it('lists the four non-npm sets as not audited without counting them as audited or clean', () => {
    const result = evaluateTemplateDependencyAudits({
      auditResults: cleanResults(),
      policy: emptyPolicy(),
      today: '2026-07-15',
      resolvedAdvisories: [],
      sets: templateDependencySets
    });

    expect(result.ok).toBe(true);
    expect(result.audited).toBe(4);
    expect(result.unaudited).toEqual([
      { id: 'python-standard', ecosystem: 'pypi', reason: 'No PyPI advisory source is configured for this release.' },
      { id: 'python-genai', ecosystem: 'pypi', reason: 'No PyPI advisory source is configured for this release.' },
      { id: 'go-backend', ecosystem: 'go', reason: 'No Go module advisory source is configured for this release.' },
      { id: 'opentofu-azure', ecosystem: 'opentofu', reason: 'No OpenTofu provider advisory source is configured for this release.' }
    ]);
    const lines = formatTemplateDependencyAudit(result).trimEnd().split('\n');
    expect(lines[1]).toBe('Audited 4 templates: 0 fixed, 0 reviewed, 4 clean, 0 issues.');
    expect(lines.filter((line) => line.startsWith('[clean] ')))
      .toEqual(templateDependencyInventory.map((entry) => `[clean] ${entry.pathParts.join('/')}`));
    expect(lines.filter((line) => line.startsWith('[not audited] '))).toEqual(
      result.unaudited.map((entry: { id: string; ecosystem: string; reason: string }) =>
        `[not audited] ${entry.id} (${entry.ecosystem}): ${entry.reason}`)
    );
    const markdown = formatTemplateDependencyAuditMarkdown(result);
    expect(markdown).toContain('\n### Not audited\n\n');
    for (const entry of result.unaudited as Array<{ id: string; ecosystem: string; reason: string }>) {
      expect(markdown).toContain(`- \`${entry.id}\` (${entry.ecosystem}): ${entry.reason}`);
    }

    const withoutSets = evaluateTemplateDependencyAudits({
      auditResults: cleanResults(),
      policy: emptyPolicy(),
      today: '2026-07-15',
      resolvedAdvisories: [],
      sets: []
    });
    expect(withoutSets.unaudited).toEqual([]);
    expect(formatTemplateDependencyAudit(withoutSets))
      .toBe(`${lines.filter((line) => !line.startsWith('[not audited] ')).join('\n')}\n`);
    expect(formatTemplateDependencyAuditMarkdown(withoutSets)).not.toContain('Not audited');
  });

  it('rejects a declared npm-audit set without an audit result', () => {
    expect(() => evaluateTemplateDependencyAudits({
      auditResults: cleanResults().filter(({ entry }) => entry.id !== 'standard-frontend'),
      policy: emptyPolicy(),
      today: '2026-07-15',
      resolvedAdvisories: [],
      sets: templateDependencySets
    })).toThrow(TemplateDependencyPolicyError);
  });
});
