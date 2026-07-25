import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
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
});

async function fixture(): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Presentation App',
    pattern: 'prompt',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
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
  } = {}
): Promise<{ code: number; out: string; err: string }> {
  const stdout = options.answers === undefined
    ? new CaptureStream()
    : ttyCaptureStream();
  const stderr = new CaptureStream();
  const normalize = (value: string) => value.replaceAll(cwd, '<project>');
  const code = await runCommand(parseArgs(args), {
    cwd,
    ...(options.answers === undefined
      ? {}
      : { stdin: scriptedTtyInput(options.answers) }),
    stdout,
    stderr,
    runner: options.runner ?? new ReadyInitRunner(),
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
  config.environments = ['dev', 'test'];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

describe('maintenance presentation', () => {
  for (const [name, columns] of [['rich', 100], ['plain', 50]] as const) {
    it(`snapshots ${name} update drift`, async () => {
      const projectRoot = await fixture();
      await addDrift(projectRoot);
      const result = await run(['update'], projectRoot, columns);

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
        ['update', '--apply'],
        projectRoot,
        columns,
        { runner }
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
    it(`snapshots ${name} interactive update impact and decline`, async () => {
      const projectRoot = await fixture();
      await addDrift(projectRoot);
      const result = await run(['update'], projectRoot, columns, {
        answers: 'n\n',
        color,
        snapshot: false
      });

      expect(result.code).toBe(2);
      expect(result.out).toContain('Update impact');
      expect(result.out).toContain('Apply these 2 safe update actions now?');
      expect(result.out).toContain('no project files were changed');
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
    const result = await run(['update', '--force'], projectRoot, 100);

    expect(result.code).toBe(1);
    expect(result.out).toContain('LIFTOFF / UPDATE');
    expect(result.out).not.toContain('--force requires --apply');
    expect(result.err).toContain('--force requires --apply');
    expect(result.err).toContain('Remedy');
  });

  it('keeps every maintenance JSON surface byte-pure', async () => {
    const projectRoot = await fixture();
    await addDrift(projectRoot);

    for (const command of [['update', '--json'], ['doctor', '--json']]) {
      const result = await run(command, projectRoot, 100);
      const parsed = JSON.parse(result.out);
      expect(parsed.schemaVersion).toBe(1);
      expect(result.out.startsWith('{')).toBe(true);
      expect(result.out.endsWith('}\n')).toBe(true);
      expect(result.out).not.toContain('LIFTOFF');
      expect(result.out).not.toMatch(/\u001B\[/);
      expect(result.err).toBe('');
    }
  });

  it('reports JSON-mode failures on plain stderr without contaminating stdout', async () => {
    const projectRoot = await fixture();
    const result = await run(['update', '--json', '--force'], projectRoot, 100);

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('--force requires --apply');
    expect(result.err).not.toMatch(/\u001B\[/);
    expect(result.err).not.toMatch(/[┌┐└┘│]/);
  });
});
