import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { getUpdatePreviewDirectory } from '../src/adapters/filesystem/update-previews.js';
import {
  cleanupUpdateTestRoots, createReviewedUpdateFixture, reviewedUpdateArguments,
  updateTestPreviewOptions
} from './reviewed-update-helpers.js';
import {
  CaptureStream,
  ReadyInitRunner,
  scriptedTtyInput,
  ttyCaptureStream
} from './helpers.js';

const cleanups: string[] = [];
const previousRegistry = process.env.LIFTOFF_REGISTRY;

beforeAll(() => {
  process.env.LIFTOFF_REGISTRY = 'http://127.0.0.1:1';
});

afterAll(() => {
  if (previousRegistry === undefined) {
    delete process.env.LIFTOFF_REGISTRY;
  } else {
    process.env.LIFTOFF_REGISTRY = previousRegistry;
  }
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
  await cleanupUpdateTestRoots();
});

async function fixture(): Promise<string> {
  const projectRoot = await createReviewedUpdateFixture({
    projectName: 'Presentation App',
    pattern: 'prompt',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  return projectRoot;
}

function normalizeMaintenanceOutput(value: string, cwd: string, previewDirectory: string): string {
  return value.replaceAll(cwd, '<project>')
    .replaceAll(`${previewDirectory}${path.win32.sep}`, '<preview-store>/')
    .replaceAll(`${previewDirectory}${path.posix.sep}`, '<preview-store>/')
    .replaceAll(previewDirectory, '<preview-store>')
    .replace(/[a-f0-9]{64}/g, 'a'.repeat(64));
}

async function run(
  args: string[],
  cwd: string,
  columns: number,
  options: {
    answers?: string;
    color?: boolean;
    snapshot?: boolean;
    runner?: ReadyInitRunner;
    reviewed?: boolean;
  } = {}
): Promise<{ code: number; out: string; err: string }> {
  const stdout = options.answers === undefined
    ? new CaptureStream()
    : ttyCaptureStream();
  const stderr = new CaptureStream();
  const updatePreview = updateTestPreviewOptions(cwd);
  const normalize = (value: string) => normalizeMaintenanceOutput(value, cwd, getUpdatePreviewDirectory(updatePreview));
  const reviewedArgs = options.reviewed ? await reviewedUpdateArguments(args, async (rawArgs) => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runCommand(parseArgs(rawArgs), { cwd, stdout: out, stderr: err, updatePreview });
    return { code, out: out.text(), err: err.text() };
  }) : args;
  const code = await runCommand(parseArgs(reviewedArgs), {
    cwd,
    ...(options.answers === undefined
      ? {}
      : { stdin: scriptedTtyInput(options.answers) }),
    stdout,
    stderr,
    updatePreview,
    runner: options.runner ?? new ReadyInitRunner(),
    stableReleaseLookup: async () => {
      throw new Error('offline');
    },
    terminal: {
      snapshot: options.snapshot ?? true,
      columns,
      ...(options.color === undefined ? {} : { color: options.color }),
      env: {},
      normalize
    }
  });
  return {
    code,
    out: normalize(stdout.text()),
    err: normalize(stderr.text())
  };
}

async function addDrift(projectRoot: string): Promise<void> {
  const configPath = path.join(projectRoot, 'liftoff.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.environments = ['dev', 'staging'];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

describe('maintenance presentation', () => {
  it.each([
    { label: 'Windows', paths: path.win32, root: 'C:\\fixture' },
    { label: 'POSIX', paths: path.posix, root: '/fixture' }
  ])('normalizes only the $label receipt path separator in snapshots', ({ paths, root }) => {
    const project = paths.join(root, 'project');
    const directory = paths.join(root, 'receipt-home', 'liftoff', 'update-previews');
    const receipt = paths.join(directory, `${'b'.repeat(64)}.json`);
    expect(normalizeMaintenanceOutput(`Location: ${receipt}`, project, directory))
      .toBe(`Location: <preview-store>/${'a'.repeat(64)}.json`);
  });

  for (const [name, columns] of [['rich', 100], ['plain', 50]] as const) {
    it(`snapshots ${name} update drift`, async () => {
      const projectRoot = await fixture();
      await addDrift(projectRoot);
      const result = await run(['update', '--check'], projectRoot, columns);

      expect(result.code).toBe(2);
      expect(result.err).toBe('');
      expect(result).toMatchSnapshot();
    });

    it(`snapshots ${name} doctor layers and remedies`, async () => {
      const projectRoot = await fixture();
      const result = await run(['doctor'], projectRoot, columns);

      expect(result.code).toBe(1);
      expect(result.out).toContain('.env');
      expect(result.out).toContain('copy .env.example to .env');
      expect(result.err).toBe('');
      expect(result).toMatchSnapshot();
    });

    it(`snapshots ${name} update completion recommendation`, async () => {
      const projectRoot = await fixture();
      await addDrift(projectRoot);
      const runner = new ReadyInitRunner();
      const result = await run(
        ['update'],
        projectRoot,
        columns,
        { runner, reviewed: true }
      );

      expect(result.code).toBe(0);
      expect(result.out).toContain('Next recommended command');
      expect(result.out).toContain('$ liftoff validate && liftoff doctor');
      expect(result.err).toBe('');
      expect(runner.calls).toEqual([]);
      expect(result).toMatchSnapshot();
    });
  }

  for (const [name, columns, color] of [
    ['rich color', 100, true],
    ['rich no-color', 100, false],
    ['narrow color', 50, true],
    ['narrow no-color', 50, false]
  ] as const) {
    it(`snapshots ${name} prompt-free update check`, async () => {
      const projectRoot = await fixture();
      await addDrift(projectRoot);
      const result = await run(['update', '--check'], projectRoot, columns, {
        answers: 'y\n',
        color,
        snapshot: false
      });

      expect(result.code).toBe(2);
      expect(result.out).toContain('Liftoff core maintenance available');
      expect(result.out).not.toContain('Update impact');
      expect(result.out).not.toContain('Apply these');
      expect(result.err).toBe('');
      if (color) {
        expect(result.out).toMatch(/\u001B\[/);
      } else {
        expect(result.out).not.toMatch(/\u001B\[/);
      }
      expect(result).toMatchSnapshot();
    });
  }

  it('keeps expected update failures on stderr and informational identity on stdout', async () => {
    const projectRoot = await fixture();
    const manifestPath = path.join(projectRoot, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.liftoffVersion = '99.0.0';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await run(['update'], projectRoot, 100);

    expect(result.code).toBe(1);
    expect(result.out).toContain('LIFTOFF / UPDATE');
    expect(result.err).toContain('newer than this CLI');
    expect(result.err).toContain('Remedy');
  });

  it('keeps every maintenance JSON surface byte-pure', async () => {
    const projectRoot = await fixture();
    await addDrift(projectRoot);

    for (const command of [['update', '--check', '--json'], ['doctor', '--json']]) {
      const result = await run(command, projectRoot, 100);
      const parsed = JSON.parse(result.out);
      expect(parsed.schemaVersion).toBe(command[0] === 'update' ? 3 : 1);
      expect(result.out.startsWith('{')).toBe(true);
      expect(result.out.endsWith('}\n')).toBe(true);
      expect(result.out).not.toContain('LIFTOFF');
      expect(result.out).not.toMatch(/\u001B\[/);
      expect(result.err).toBe('');
    }
  });

  it('reports JSON-mode failures as one versioned result', async () => {
    const projectRoot = await fixture();
    const manifestPath = path.join(projectRoot, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.liftoffVersion = '99.0.0';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await run(['update', '--json'], projectRoot, 100);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.schemaVersion).toBe(3);
    expect(report.reasonCode).toBe('newer-project');
    expect(report.message).toContain('newer than this CLI');
    expect(report.committed).toBe(false);
    expect(result.err).toBe('');
    expect(result.err).not.toMatch(/\u001B\[/);
    expect(result.err).not.toMatch(/[┌┐└┘│]/);
  });
});
