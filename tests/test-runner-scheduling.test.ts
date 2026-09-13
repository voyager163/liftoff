import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { NodeCommandRunner } from '../src/process-runner.js';

const roots: string[] = [];
const migrationFile = 'tests/migration-inspection.test.ts';
const repairFile = 'tests/repair-command.test.ts';
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: string[], verifyBarrier = false) {
  const cache = path.resolve('.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'test-runner-scheduling-'));
  roots.push(root);
  const configImport = path.relative(root, path.resolve('vitest.config.ts')).split(path.sep).join('/');
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(root, 'vitest.config.mjs'), `
import { createRootTestConfig } from ${JSON.stringify(configImport)};
export default { ...createRootTestConfig('win32'), root: ${JSON.stringify(root)} };
`);

  const ordinary = files.filter((file) => file !== migrationFile);
  const completed = ordinary.map((_, index) => path.join(root, `completed-${index}`));
  for (const file of files) {
    const destination = path.join(root, file);
    await mkdir(path.dirname(destination), { recursive: true });
    const source = file === migrationFile
      ? `
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
it('selected migration inspection', async () => {
  for (const marker of ${JSON.stringify(verifyBarrier ? completed : [])}) {
    expect(await readFile(marker, 'utf8')).toBe('done');
  }
  await writeFile(${JSON.stringify(path.join(root, 'selected-migration-ran'))}, 'done');
});
it('other migration inspection', () => {});
`
      : `
import { afterAll, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
afterAll(() => writeFile(${JSON.stringify(completed[ordinary.indexOf(file)])}, 'done'));
${(file === repairFile ? ['native backend-disabled', 'other repair'] : ['ordinary test'])
  .map((name) => `it(${JSON.stringify(name)}, () => delay(20));`).join('\n')}
`;
    await writeFile(destination, source);
  }
  for (const directory of ['node_modules', '.git']) {
    const ignored = path.join(root, 'tests', directory);
    await mkdir(ignored, { recursive: true });
    await writeFile(path.join(ignored, 'ignored.test.ts'), 'throw new Error("Default test exclusion was lost");\n');
  }
  return { root, files };
}

async function runCli(root: string, command: 'run' | 'list', args: string[]) {
  const result = await new NodeCommandRunner().run({
    executable: process.execPath,
    args: [vitestCli, command, ...args]
  }, { cwd: root, timeoutMs: 25_000, maxOutputBytes: 256 * 1024 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.outputLimitExceeded).not.toBe(true);
  return result.stdout;
}

async function runTests(root: string, filters: string[] = []): Promise<unknown> {
  const report = path.join(root, 'report.json');
  await runCli(root, 'run', [...filters, '--reporter=json', '--outputFile.json', report]);
  return JSON.parse(await readFile(report, 'utf8'));
}

function expectRun(report: unknown, root: string, files: string[], passed: number, skipped = 0) {
  expect(report).toMatchObject({
    success: true,
    numTotalTests: passed + skipped,
    numPassedTests: passed,
    numPendingTests: skipped,
    numFailedTests: 0
  });
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    throw new Error('Expected a Vitest test-results inventory.');
  }
  const observed = report.testResults.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      throw new Error('Expected an absolute Vitest test-file name.');
    }
    expect(path.isAbsolute(entry.name)).toBe(true);
    return path.relative(root, entry.name).split(path.sep).join('/');
  });
  expect(observed.sort()).toEqual([...files].sort());
}

async function ciCommand(name: string): Promise<string> {
  const workflow: unknown = parseYaml(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs.test) ||
    !Array.isArray(workflow.jobs.test.steps)) {
    throw new Error('Expected the platform test workflow.');
  }
  const step: unknown = workflow.jobs.test.steps.find((entry: unknown) => isRecord(entry) && entry.name === name);
  if (!isRecord(step) || typeof step.run !== 'string') throw new Error(`Missing CI command: ${name}`);
  return step.run.trim();
}

describe('Windows test-project execution and filters', () => {
  it('runs the intact migration file after all ordinary hooks in the same invocation', async () => {
    const current = await fixture([
      'tests/ordinary-a.test.ts', 'tests/ordinary-b.test.ts', repairFile, migrationFile
    ], true);
    expectRun(await runTests(current.root), current.root, current.files, 6);
    expect(await readFile(path.join(current.root, 'selected-migration-ran'), 'utf8')).toBe('done');
  });

  it.each([
    { label: 'file', filters: [migrationFile], passed: 2, skipped: 0 },
    { label: 'file and name', filters: [migrationFile, '-t', 'selected migration inspection'], passed: 1, skipped: 1 }
  ])('preserves direct $label filters across Windows projects', async ({ filters, passed, skipped }) => {
    const current = await fixture(['tests/ordinary.test.ts', migrationFile]);
    expectRun(await runTests(current.root, filters), current.root, [migrationFile], passed, skipped);
    expect(await readFile(path.join(current.root, 'selected-migration-ran'), 'utf8')).toBe('done');
  });

  it('preserves every existing Windows boundary CLI file selector exactly once', async () => {
    const command = (await ciCommand('Run Windows project and packaging boundary coverage')).split(/\s+/);
    expect(command.slice(0, 3)).toEqual(['npx', 'vitest', 'run']);
    const files = command.slice(3);
    expect(files).toContain(migrationFile);
    expect(files.every((file) => /^tests\/(?:[\w-]+\/)*[\w-]+\.test\.ts$/.test(file))).toBe(true);
    const current = await fixture(files);
    const selected: unknown = JSON.parse(await runCli(current.root, 'list', ['--filesOnly', ...files, '--json']));
    if (!Array.isArray(selected)) throw new Error('Expected the Vitest file-selection inventory.');
    const observed = selected.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.file !== 'string' || typeof entry.projectName !== 'string') {
        throw new Error('Expected an explicitly named Vitest project and file.');
      }
      expect(path.isAbsolute(entry.file)).toBe(true);
      return { file: path.relative(current.root, entry.file).split(path.sep).join('/'), projectName: entry.projectName };
    });
    const expected = files.map((file) => ({
      file, projectName: file === migrationFile ? 'migration-inspection' : 'root-tests'
    }));
    expect(observed.sort((a, b) => a.file.localeCompare(b.file)))
      .toEqual(expected.sort((a, b) => a.file.localeCompare(b.file)));
  });

  it('preserves the native repair CLI file and name filter', async () => {
    const command = await ciCommand('Validate local repair with native OpenTofu');
    const selector = /^npx vitest run (tests\/(?:[\w-]+\/)*[\w-]+\.test\.ts) -t "([^"]+)"$/.exec(command);
    if (!selector) throw new Error('Expected the existing native repair file/name selector.');
    expect(selector[1]).toBe(repairFile);
    const current = await fixture([repairFile, migrationFile]);
    expectRun(await runTests(current.root, [selector[1], '-t', selector[2]]), current.root, [repairFile], 1, 1);
  });
});
