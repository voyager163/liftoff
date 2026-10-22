import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateTemplateDependencyAudits,
  normalizeNpmAuditReport,
  parseTemplateDependencyPolicy,
  templateDependencyInventory
} from '../scripts/template-dependency-security.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const entry = templateDependencyInventory[0];
const advisory = {
  source: 1, dependency: 'leaf', title: 'Fixture advisory', severity: 'high',
  url: 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC', range: '<2.0.0'
};
function vulnerability(
  name: string, isDirect: boolean, effects: string[],
  via: Array<string | typeof advisory> = [advisory]
) {
  return { name, isDirect, effects, via, nodes: [`node_modules/${name}`], severity: 'high' };
}
function report(vulnerabilities: Record<string, ReturnType<typeof vulnerability>>) {
  return {
    auditReportVersion: 2, vulnerabilities,
    metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } }
  };
}
const directCycle = () => report({
  leaf: vulnerability('leaf', true, ['peer']),
  peer: vulnerability('peer', true, ['leaf'], ['leaf'])
});
function exceptionFor(dependencyChains: string[][]) {
  return {
    advisoryId: 'GHSA-AAAA-BBBB-CCCC', package: 'leaf',
    manifestPathParts: entry.pathParts, dependencyChains,
    disposition: 'vulnerable-code-not-used',
    rationale: 'Synthetic fixture behavior is not invoked.',
    mitigation: 'Keep the fixture behavior unreachable.',
    owner: 'fixture-maintainer', reviewedAt: '2026-07-01', reviewBy: '2026-07-31',
    upstreamReference: advisory.url
  };
}

describe('rooted npm audit dependency graphs', () => {
  it('retains every finite simple direct dependency chain through mutual peers', () => {
    const findings = normalizeNpmAuditReport(entry, directCycle());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      advisoryId: 'GHSA-AAAA-BBBB-CCCC', package: 'leaf', severity: 'high',
      affectedNodes: ['node_modules/leaf'],
      dependencyChains: [['leaf'], ['peer', 'leaf']]
    });
  });

  it('accepts an indirect cycle with a real direct root independently of member order', () => {
    const records = {
      leaf: vulnerability('leaf', false, ['middle']),
      middle: vulnerability('middle', false, ['leaf', 'root'], ['leaf']),
      root: vulnerability('root', true, [], ['middle'])
    };
    const findings = normalizeNpmAuditReport(entry, report(records));
    expect(findings[0].dependencyChains).toEqual([['root', 'middle', 'leaf']]);
    expect(normalizeNpmAuditReport(entry,
      report(Object.fromEntries(Object.entries(records).reverse())))).toEqual(findings);
  });

  it('accepts a direct self-reference without fabricating a repeated-name chain', () => {
    expect(normalizeNpmAuditReport(entry, report({
      leaf: vulnerability('leaf', true, ['leaf'], [advisory, 'leaf'])
    }))[0].dependencyChains).toEqual([['leaf']]);
  });

  it('rejects an advisory-bearing cycle disconnected from the actual direct root', () => {
    expect(() => normalizeNpmAuditReport(entry, report({
      leaf: vulnerability('leaf', false, ['peer']),
      peer: vulnerability('peer', false, ['leaf'], ['leaf']),
      root: vulnerability('root', true, [])
    }))).toThrow('cycle');
  });

  it('rejects an outgoing unrooted cycle even when the direct root points into it', () => {
    expect(() => normalizeNpmAuditReport(entry, report({
      root: vulnerability('root', true, ['leaf']),
      leaf: vulnerability('leaf', false, ['peer']),
      peer: vulnerability('peer', false, ['leaf'], ['leaf'])
    }))).toThrow('cycle');
  });

  it('still rejects a rooted via cycle without any actual advisory record', () => {
    expect(() => normalizeNpmAuditReport(entry, report({
      leaf: vulnerability('leaf', true, ['peer'], ['peer']),
      peer: vulnerability('peer', false, ['leaf'], ['leaf'])
    }))).toThrow('no resolvable advisory record');
  });

  it('keeps cyclic findings unreviewed and requires exceptions to cover every chain', () => {
    const auditReport = directCycle();
    const evaluate = (exceptions: ReturnType<typeof exceptionFor>[]) => evaluateTemplateDependencyAudits({
      auditResults: [{ entry, auditReport }],
      policy: parseTemplateDependencyPolicy({ schemaVersion: 1, exceptions }, [entry]),
      today: new Date('2026-07-15T00:00:00Z'), resolvedAdvisories: [], sets: []
    });
    const unreviewed = evaluate([]);
    expect(unreviewed.ok).toBe(false);
    expect(unreviewed.issues).toMatchObject([{ code: 'unreviewed-finding' }]);
    const partial = evaluate([exceptionFor([['leaf']])]);
    expect(partial.ok).toBe(false);
    expect(partial.issues).toMatchObject([{ code: 'dependency-chain-mismatch' }]);
    const exact = evaluate([exceptionFor([['leaf'], ['peer', 'leaf']])]);
    expect(exact.ok).toBe(true);
    expect(exact.reviewed).toHaveLength(1);
  });
});

describe('complete npm audit scope', () => {
  it('includes every dependency type in actual audit commands despite production or omit settings', async () => {
    const tools = await mkdtemp(path.join(os.tmpdir(), 'liftoff-audit-command-'));
    const requests = path.join(tools, 'requests.jsonl');
    const executable = path.join(tools, 'npm-fixture.cjs');
    try {
      await writeFile(executable, [
        'const { appendFileSync } = require("node:fs");',
        'appendFileSync(process.env.LIFTOFF_AUDIT_TEST_REQUESTS, JSON.stringify({ directory: process.cwd(), args: process.argv.slice(2) }) + "\\n");',
        `process.stdout.write(${JSON.stringify(JSON.stringify(report({})))});`
      ].join('\n'));
      const launcher = path.join(tools, process.platform === 'win32' ? 'npm.cmd' : 'npm');
      await writeFile(launcher, process.platform === 'win32'
        ? '@echo off\r\nnode "%LIFTOFF_AUDIT_TEST_EXECUTABLE%" %*\r\nexit /b %errorlevel%\r\n'
        : '#!/bin/sh\nexec node "$LIFTOFF_AUDIT_TEST_EXECUTABLE" "$@"\n');
      if (process.platform !== 'win32') await chmod(launcher, 0o755);
      const result = spawnSync(process.execPath, ['scripts/audit-template-dependencies.mjs'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: [tools, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter),
          NODE_ENV: 'production',
          npm_config_omit: 'dev',
          NPM_CONFIG_OMIT: 'dev',
          LIFTOFF_NPM_AUDIT_REGISTRY: 'https://registry.npmjs.org',
          LIFTOFF_AUDIT_TEST_EXECUTABLE: executable,
          LIFTOFF_AUDIT_TEST_REQUESTS: requests,
          GITHUB_STEP_SUMMARY: ''
        },
        encoding: 'utf8',
        timeout: 10_000
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      const calls = (await readFile(requests, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as { directory: string; args: string[] });
      expect(calls.map(call => path.resolve(call.directory))).toEqual(
        templateDependencyInventory.map(inventory =>
          path.dirname(path.join(repositoryRoot, ...inventory.pathParts))));
      for (const call of calls) {
        expect(call.args).toEqual([
          'audit', '--package-lock-only', '--ignore-scripts',
          '--include=prod', '--include=dev', '--include=optional', '--include=peer',
          '--json', '--registry=https://registry.npmjs.org/'
        ]);
      }
    } finally {
      await rm(tools, { recursive: true, force: true });
    }
  }, 15_000);
});
