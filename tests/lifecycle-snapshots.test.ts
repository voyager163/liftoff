import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const cleanups: string[] = [];
const layouts = [
  { name: 'rich', columns: 100 },
  { name: 'compact', columns: 80 },
  { name: 'plain', columns: 50 }
] as const;

afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(value);
  return value;
}

async function runScreen(
  args: string[],
  cwd: string,
  columns: number,
  options: {
    input?: string;
    runner?: ReadyInitRunner;
  } = {}
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    ...(options.input ? { stdin: Readable.from([options.input]) } : {}),
    stdout,
    stderr,
    runner: options.runner ?? new ReadyInitRunner(),
    terminal: { snapshot: true, columns }
  });
  const normalize = (value: string) => value.replaceAll(cwd, '<workspace>');
  return { code, out: normalize(stdout.text()), err: normalize(stderr.text()) };
}

const standardPlan = [
  'plan',
  '--no-genai',
  '--api',
  'go',
  '--cloud',
  'azure',
  '--region',
  'eastus',
  '--no-frontend',
  '--environments',
  'dev',
  '--spec',
  'openspec',
  '--agents',
  'copilot'
];

const standardInit = [
  'init',
  'snapshot-app',
  '--no-genai',
  '--api',
  'go',
  '--cloud',
  'azure',
  '--region',
  'eastus',
  '--no-frontend',
  '--environments',
  'dev',
  '--spec',
  'openspec',
  '--agents',
  'copilot'
];

describe('complete onboarding screens', () => {
  for (const layout of layouts) {
    it(`snapshots the ${layout.name} plan screen`, async () => {
      const workspace = await root('liftoff-plan-screen-');
      const result = await runScreen(standardPlan, workspace, layout.columns);
      expect(result).toMatchSnapshot();
    });

    it(`snapshots the ${layout.name} init readiness and completion screen`, async () => {
      const workspace = await root('liftoff-init-screen-');
      const result = await runScreen(
        [...standardInit, '--yes'],
        workspace,
        layout.columns
      );
      expect(result).toMatchSnapshot();
    });

    it(`snapshots the ${layout.name} conflict consent and cancellation screen`, async () => {
      const workspace = await root('liftoff-consent-screen-');
      const target = path.join(workspace, 'snapshot-app');
      await mkdir(target);
      await writeFile(path.join(target, 'README.md'), 'developer-owned\n');

      const result = await runScreen(
        standardInit,
        workspace,
        layout.columns,
        { input: 'y\nn\n' }
      );
      expect(result).toMatchSnapshot();
    });

    it(`snapshots the ${layout.name} handled readiness failure screen`, async () => {
      const workspace = await root('liftoff-failure-screen-');
      const result = await runScreen(
        [...standardInit, '--yes'],
        workspace,
        layout.columns,
        { runner: new ReadyInitRunner({ missing: ['openspec'] }) }
      );
      expect(result).toMatchSnapshot();
    });

    it(`snapshots the ${layout.name} migration provenance and completion screen`, async () => {
      const workspace = await root('liftoff-migration-screen-');
      const source = path.join(workspace, 'legacy-node');
      await mkdir(source);
      await writeFile(path.join(source, 'package.json'), JSON.stringify({
        dependencies: { fastify: '^5.0.0' },
        devDependencies: { typescript: '^5.5.0' }
      }));

      const result = await runScreen([
        'migrate',
        source,
        '--region',
        'eastus',
        '--yes'
      ], workspace, layout.columns);
      expect(result).toMatchSnapshot();
    });
  }
});
