import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

async function run(args: string[], cwd: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    runner: new ReadyInitRunner()
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('Power Apps maintenance presentation', () => {
  it('snapshots ready, skipped, advisory, malformed, and offline states', async () => {
    const previousRegistry = process.env.LIFTOFF_REGISTRY;
    process.env.LIFTOFF_REGISTRY = 'http://127.0.0.1:1';
    const root = await createFixtureProject({
      projectName: 'Maintenance Snapshot',
      projectType: 'power-apps-code-app',
      specWorkflow: 'openspec',
      agents: ['copilot', 'claude'],
      codeAppsPlugin: true
    });
    try {
      const doctorJson = await run(['doctor', '--json'], root);
      const report = JSON.parse(doctorJson.stdout) as {
        layers: Array<{
          title: string;
          checks: Array<{
            id?: string;
            label: string;
            severity: string;
            state?: string;
          }>;
        }>;
        summary: { failures: number; warnings: number };
      };
      const stableDoctor = {
        layers: report.layers.map((layer) => ({
          title: layer.title,
          checks: layer.checks.map((check) => ({
            id: check.id,
            label: check.label,
            severity: check.severity,
            state: check.state
          }))
        })),
        summary: report.summary
      };
      expect(stableDoctor).toMatchSnapshot('doctor JSON states');

      const doctorHuman = await run(['doctor'], root);
      const humanStateLines = doctorHuman.stdout
        .split('\n')
        .filter((line) =>
          line === 'Runtime' ||
          line === 'Optional Code Apps plugin' ||
          line.includes('Power Apps starter:') ||
          line.includes('Power Apps project:') ||
          line.includes('Power Apps CLI:') ||
          line.includes('Code Apps plugin') ||
          line.includes('code-apps-preview') ||
          line.includes('Doctor summary:')
        );
      expect(humanStateLines).toMatchSnapshot('doctor human states');

      const readyValidation = await run(['validate', '--json'], root);
      const readyReport = JSON.parse(readyValidation.stdout);
      expect({
        code: readyValidation.code,
        valid: readyReport.valid,
        issues: readyReport.issues
      }).toMatchSnapshot('validate ready JSON');

      const lockPath = path.join(root, 'package-lock.json');
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      lock.name = 'malformed-project';
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const productionEditJson = await run(['validate', '--json'], root);
      const productionEditReport = JSON.parse(productionEditJson.stdout);
      const productionEditHuman = await run(['validate'], root);
      expect({
        json: {
          code: productionEditJson.code,
          valid: productionEditReport.valid,
          issues: productionEditReport.issues
        },
        human: {
          code: productionEditHuman.code,
          stdout: productionEditHuman.stdout.split('\n').filter((line) => line.includes('VALIDATE')),
          stderr: productionEditHuman.stderr
            .replaceAll(root, '<project>')
            .split('\n')
            .filter(Boolean)
        }
      }).toMatchSnapshot('validate project-owned edit states');
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.LIFTOFF_REGISTRY;
      } else {
        process.env.LIFTOFF_REGISTRY = previousRegistry;
      }
      await rm(path.dirname(root), { recursive: true, force: true });
    }
  }, 30_000);
});
