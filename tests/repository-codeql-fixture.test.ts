import { lstat, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureCodeqlFixtureProcess, CodeqlFixtureProcessError, codeqlFixtureEnvironment, createCodeqlFixtureArea, parseCodeqlFixtureCoverage,
  resumeCodeqlFixtureArea, restoreCodeqlFixtureTool, codeqlFixturePin, evaluateCodeqlFixtureSarif, inspectCodeqlFixtureSarif
} from '../scripts/repository-security/codeql-fixture.ts';

const sentinel = 'PRIVATE_CODEQL_FIXTURE_SENTINEL';
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function fixtureResult(name: 'clean' | 'insecure') {
  const source = JSON.stringify({
    version: '2.1.0',
    runs: [{
      automationDetails: { id: 'fixture/javascript/' },
      tool: { driver: { name: 'CodeQL', semanticVersion: codeqlFixturePin.version,
        rules: [{ id: codeqlFixturePin.query, properties: { 'security-severity': '7.8' } }] } },
      invocations: [{ executionSuccessful: true }],
      results: name === 'clean' ? [] : [{
        ruleId: codeqlFixturePin.query, message: { text: sentinel },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'fixture.js' }, region: { startLine: 2 } } }]
      }]
    }]
  });
  const execution = {
    startedAt: '2026-09-20T11:00:00.000Z', completedAt: '2026-09-20T11:01:00.000Z',
    exitCode: 0 as const, stdoutBytes: 1, stderrBytes: 1
  };
  return {
    source,
    actual: {
      name, tool: { ...codeqlFixturePin, languages: ['javascript'] }, extraction: execution, analysis: execution,
      inputDigest: name === 'clean'
        ? 'sha256:1a57c4064b48004b64acc16b18daf037fcd6ab387d060cb3ab33e0bb276d0a9b'
        : 'sha256:5443147868a2d7f23b17eb38ab463f5227e10b0c36f8d94ed2bb750f5ee06a12',
      sourcePaths: [['fixture.js']], extractedPaths: [['fixture.js']], platform: `${process.platform}-${process.arch}`,
      reportDigest: hash(source), coverageQueryDigest: 'sha256:27017ad8ea27391acaf981bc2713cd83fd8d376426d496347d7604f4f138a222'
    }
  };
}

describe('isolated CodeQL fixture process boundary (offline)', () => {
  it('registers owned output trees and discards stdout/stderr without claiming unsupported native privacy qualification', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      const root = await lstat(area.root);
      expect(root.isDirectory()).toBe(true);
      expect(root.isSymbolicLink()).toBe(false);
      expect(root.ino).toBe(area.registration.inode);
      expect(root.dev).toBe(area.registration.device);
      await expect(area.verify()).resolves.toBeUndefined();
      if (process.platform === 'win32') {
        await expect(restoreCodeqlFixtureTool(area)).rejects.toThrow('codeql-fixture-platform-unqualified');
      } else expect(root.mode & 0o777).toBe(0o700);
      const result = await captureCodeqlFixtureProcess(area, process.execPath, [
        '-e', `process.stdout.write('${sentinel}'); process.stderr.write('${sentinel}')`
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdoutBytes).toBe(sentinel.length);
      expect(result.stderrBytes).toBe(sentinel.length);
      expect(JSON.stringify(result)).not.toContain(sentinel);
    } finally { await area.cleanup(); }
    await expect(lstat(area.root)).rejects.toThrow();
  });

  it.each([
    { args: ['-e', `throw new Error('${sentinel}')`], timeout: 5_000, limit: 4096, error: 'process-failed' },
    { args: ['-e', `process.stdout.write('${sentinel}');setInterval(()=>{},100)`], timeout: 250, limit: 4096, error: 'timeout' },
    { args: ['-e', `process.stdout.write('${sentinel}'.repeat(100))`], timeout: 5_000, limit: 32, error: 'output-limit' },
    { args: ['-e', `process.stderr.write('${sentinel}'.repeat(100))`], timeout: 5_000, limit: 32, error: 'output-limit' }
  ])('sanitizes $error without returning captured content', async ({ args, timeout, limit, error }) => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      let failure: unknown;
      try { await captureCodeqlFixtureProcess(area, process.execPath, args, timeout, limit); }
      catch (caught) { failure = caught; }
      expect(String(failure)).toContain(`codeql-fixture-${error}`);
      expect(String(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain(sentinel);
    } finally { await area.cleanup(); }
  });

  it('does not expose a failed executable path or inherited credentials/configuration', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      const environment = codeqlFixtureEnvironment(area);
      expect(environment).not.toHaveProperty('GITHUB_TOKEN');
      expect(environment).not.toHaveProperty('NODE_OPTIONS');
      expect(environment.HOME).toBe(area.slots.home);
      expect(environment.TMPDIR).toBe(area.slots.scratch);
      let failure: unknown;
      try { await captureCodeqlFixtureProcess(area, path.join(area.slots.tool, sentinel), []); }
      catch (caught) { failure = caught; }
      expect(String(failure)).toContain('codeql-fixture-spawn');
      expect(String(failure)).not.toContain(sentinel);
    } finally { await area.cleanup(); }
  });

  it('retains only allowlisted failure classes and numeric process metadata', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      let failure: unknown;
      try {
        await captureCodeqlFixtureProcess(area, process.execPath, [
          '-e', `process.stderr.write('Java heap space: ${sentinel}');process.exit(2)`
        ]);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CodeqlFixtureProcessError);
      if (!(failure instanceof CodeqlFixtureProcessError)) throw new Error('expected bounded failure');
      expect(failure.diagnostics).toEqual(['memory-exhausted']);
      expect(failure.execution.exitCode).toBe(2);
      expect(JSON.stringify(failure)).not.toContain(sentinel);
      expect(failure).not.toHaveProperty('cause');
      expect(Object.keys(failure)).not.toContain('stderr');
    } finally { await area.cleanup(); }
  });

  it('rejects unregistered root entries and never follows output symlinks during cleanup', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    const foreign = path.join(area.root, 'unregistered');
    const target = path.join(area.slots.clean, 'sentinel');
    await writeFile(foreign, sentinel);
    await expect(area.cleanup()).rejects.toThrow('codeql-fixture-registration');
    expect(await readFile(foreign, 'utf8')).toBe(sentinel);
    await unlink(foreign);
    await writeFile(target, sentinel);
    await symlink(area.slots.clean, path.join(area.slots.insecure, 'link'));
    await area.cleanup();
    await expect(lstat(area.root)).rejects.toThrow();
  });

  it('reopens only an explicit unchanged registration', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    try {
      const resumed = await resumeCodeqlFixtureArea(structuredClone(area.registration));
      expect(resumed.root).toBe(area.root);
      await expect(resumeCodeqlFixtureArea({ ...area.registration, inode: -1 })).rejects.toThrow('registration');
    } finally { await area.cleanup(); }
  });

  it('requires one actual parsed file and zero parse errors from the coverage query', () => {
    const coverage = (tuples: unknown[][]) => JSON.stringify({
      '#select': { columns: [{ kind: 'String' }, { kind: 'Integer' }, { kind: 'Integer' }], tuples }
    });
    expect(parseCodeqlFixtureCoverage(coverage([['fixture.js', 1, 0]]))).toEqual([['fixture.js']]);
    for (const invalid of [
      sentinel, '{}', coverage([]), coverage([['fixture.js', 0, 0]]), coverage([['fixture.js', 1, 1]]),
      coverage([['outside.js', 1, 0]]), coverage([['fixture.js', 1, 0], ['extra.js', 1, 0]])
    ]) {
      expect(() => parseCodeqlFixtureCoverage(invalid)).toThrow('codeql-fixture-extraction-coverage');
    }
  });

  it('separates native analysis completion from clean and blocking finding outcomes', () => {
    for (const name of ['clean', 'insecure'] as const) {
      const { source, actual } = fixtureResult(name);
      const result = evaluateCodeqlFixtureSarif(source, actual, new Date('2026-09-20T12:00:00Z'));
      expect(result.analysisExitCode).toBe(0);
      expect(result.passed).toBe(name === 'clean');
      expect(result.blocking).toBe(name === 'clean' ? 0 : 1);
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
  });

  it('keeps observed source, native report and expected fixture identity independent', () => {
    const { source, actual } = fixtureResult('clean');
    const evaluate = (changed: Partial<typeof actual>) =>
      evaluateCodeqlFixtureSarif(source, { ...actual, ...changed }, new Date('2026-09-20T12:00:00Z'));
    expect(() => evaluate({ inputDigest: hash('different source') })).toThrow('identity-mismatch');
    expect(() => evaluate({ extractedPaths: [] })).toThrow('incomplete-codeql-source-coverage');
    expect(() => evaluate({ reportDigest: hash('different report') })).toThrow('codeql-execution-mismatch');
    expect(() => evaluate({ coverageQueryDigest: hash('different query') })).toThrow('identity-mismatch');
    expect(() => evaluate({ platform: 'unqualified-platform' })).toThrow('coverage-mismatch');
    expect(() => evaluateCodeqlFixtureSarif(sentinel, actual)).toThrow('invalid-sarif-json');
    expect(() => evaluateCodeqlFixtureSarif(sentinel.repeat(200_000), actual)).toThrow('sarif-too-large');
  });

  it('rejects absent language or query evidence even when the native clean report has no findings', () => {
    const { source, actual } = fixtureResult('clean');
    expect(() => evaluateCodeqlFixtureSarif(source, {
      ...actual, tool: { ...actual.tool, languages: [] }
    }, new Date('2026-09-20T12:00:00Z'))).toThrow('codeql-fixture-language-coverage');
    const data = JSON.parse(source);
    data.runs[0].tool.driver.rules = [];
    const emptyQueries = JSON.stringify(data);
    expect(() => evaluateCodeqlFixtureSarif(emptyQueries, {
      ...actual, reportDigest: hash(emptyQueries)
    }, new Date('2026-09-20T12:00:00Z'))).toThrow('codeql-fixture-query-coverage');
  });

  it('sanitizes missing, malformed, oversized and linked native reports', async () => {
    const area = await createCodeqlFixtureArea(path.dirname(process.cwd()));
    const report = path.join(area.slots.clean, 'result.sarif');
    try {
      await expect(inspectCodeqlFixtureSarif(area, 'clean')).rejects.toThrow('codeql-fixture-report-unreadable');
      await writeFile(report, sentinel);
      await expect(inspectCodeqlFixtureSarif(area, 'clean')).rejects.toThrow('codeql-fixture-report-json');
      await writeFile(report, sentinel.repeat(200_000));
      await expect(inspectCodeqlFixtureSarif(area, 'clean')).rejects.toThrow('codeql-fixture-report-unreadable');
      await unlink(report);
      await symlink(path.join(area.slots.insecure, 'absent'), report);
      await expect(inspectCodeqlFixtureSarif(area, 'clean')).rejects.toThrow('codeql-fixture-report-unreadable');
    } finally { await area.cleanup(); }
  });
});
