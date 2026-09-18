import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessProject } from '../../src/application/standards-assessment/runner.js';
import { assessCommand, runAssess } from '../../src/cli/commands/assess.js';
import { PresentationSession } from '../../src/terminal.js';
import type { ExecutionContext } from '../../src/application/context.js';
import type { ParsedArgs } from '../../src/domain/project/contracts.js';
import { containsSensitiveText } from '../../src/domain/standards-assessment/sanitizer.js';
import { parseArgs } from '../../src/cli/args/parser.js';
import { runCommand } from '../../src/cli/commands/dispatch.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.recs-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function createMockContext(cwd: string, jsonMode = false) {
  let stdoutData = '';
  let stderrData = '';

  const stdout = {
    write: (chunk: string | Buffer) => {
      stdoutData += chunk.toString();
      return true;
    }
  } as unknown as NodeJS.WritableStream;

  const stderr = {
    write: (chunk: string | Buffer) => {
      stderrData += chunk.toString();
      return true;
    }
  } as unknown as NodeJS.WritableStream;

  const presentation = new PresentationSession({
    stdout,
    stderr,
    json: jsonMode
  });

  const context: ExecutionContext = {
    cwd,
    env: {},
    stdout,
    stderr,
    presentation
  };

  return {
    context,
    getStdout: () => stdoutData,
    getStderr: () => stderrData
  };
}

describe('standards assessment recommendations and CLI command', () => {
  it('generates context-bound adoption recommendation for uninitialized supported project', async () => {
    const dir = createFixtureDir('uninitialized-recs');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-app', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    const result = await assessProject({ targetPath: dir });

    const adoptRec = result.recommendations.find((r) => r.capability === 'adopt');
    expect(adoptRec).toBeDefined();
    expect(adoptRec?.executable).toBe('liftoff');
    expect(adoptRec?.args).toContain('adopt');
    expect(adoptRec?.scope).toBe('project-adoption');
    expect(adoptRec?.approval).toBe('required');
    expect(adoptRec?.compatibility).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(adoptRec?.commandSchema.resultSchemaVersion).toBe(1);
    expect(adoptRec?.engine).toBe('Project Evolution');
    expect(parseArgs(adoptRec!.args)).toMatchObject({ command: 'adopt', flags: { check: true, json: true, project: dir } });

    // Verify recommendations contain NO secret payloads
    expect(containsSensitiveText(JSON.stringify(result.recommendations))).toBe(false);
  });

  it('generates repair and update recommendations for initialized project with gaps', async () => {
    const dir = createFixtureDir('initialized-gaps-recs');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'liftoff.manifest.json'),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: 'Mission Control Liftoff',
        liftoffVersion: '0.12.3',
        project: {
          name: 'demo',
          workload: {
            kind: 'standard',
            apiStack: 'node-fastify',
            cloud: 'azure',
            region: 'eastus',
            frontend: false,
            environments: ['dev']
          },
          specWorkflow: 'openspec',
          agents: ['github-copilot']
        },
        framework: {
          state: 'initialized',
          adapter: 'openspec',
          contractVersion: '1.0.0'
        },
        governance: {
          profile: 'none',
          state: 'disabled'
        },
        managedArtifacts: [],
        projectArtifacts: []
      })
    );
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    const result = await assessProject({ targetPath: dir });

    // Initialized project gets update check
    const updateRec = result.recommendations.find((r) => r.capability === 'update');
    expect(updateRec).toBeDefined();
    expect(updateRec?.args).toEqual(['update', '--project', dir, '--check', '--json']);
    expect(updateRec?.commandSchema.resultSchemaVersion).toBe(3);

    const inventoryRec = result.recommendations.find((r) => r.capability === 'repair');
    expect(inventoryRec?.args).toEqual(['repair', dir, '--inspect-layout', '--json']);
    expect(inventoryRec?.commandSchema).toMatchObject({ resultSchemaVersion: 2, contractVersion: 1 });
    expect(inventoryRec?.args).not.toContain('--recipe');
    expect(inventoryRec?.args).not.toContain('--approve-plan');
    expect(parseArgs(inventoryRec!.args)).toMatchObject({ command: 'repair', flags: { 'inspect-layout': true, json: true } });
    const home = createFixtureDir('recommendation-home');
    await mkdir(home);
    const original = await readFile(path.join(dir, 'liftoff.manifest.json'));
    const cli = createMockContext(path.dirname(dir), true);
    const code = await runCommand(parseArgs(inventoryRec!.args), {
      ...cli.context, updatePreview: { homedir: home, env: {}, repositoryRoot: dir }
    });
    expect(code, cli.getStdout() || cli.getStderr()).not.toBe(1);
    const actual = JSON.parse(cli.getStdout());
    expect(actual).toMatchObject({
      schemaVersion: inventoryRec!.commandSchema.resultSchemaVersion, projectRoot: dir, operationKind: 'inspect-layout'
    });
    expect(actual.application.schemaVersion).toBe(1);
    expect(await readFile(path.join(dir, 'liftoff.manifest.json'))).toEqual(original);
  });

  it('emits no imaginary recommendations for unsupported stack', async () => {
    const dir = createFixtureDir('unsupported-recs');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'express-app', dependencies: { express: '^4.21.0' } })
    );
    await writeFile(path.join(dir, 'src', 'server.ts'),
      "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.json({ status: 'ok' }));\napp.listen(3000);\n");

    const result = await assessProject({ targetPath: dir });

    expect(result.profile.status).toBe('unsupported');
    expect(result.recommendations).toHaveLength(0);
  });

  it('executes assess CLI command in JSON mode and outputs schema-1 JSON to stdout', async () => {
    const dir = createFixtureDir('cli-json');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cli-demo', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'cli-demo', lockfileVersion: 3 })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    const { context, getStdout } = createMockContext(dir, true);

    const parsed: ParsedArgs = {
      command: 'assess',
      flags: { json: true },
      positional: [dir]
    };

    const exitCode = await assessCommand(parsed, context);

    expect(exitCode).toBe(2); // Valid assessment with missing items (uninitialized, etc.)
    const output = JSON.parse(getStdout());
    expect(output.schemaVersion).toBe(1);
    expect(output.command).toBe('assess');
    expect(output.target.targetPath).toBe(dir);
    expect(output.profile.id).toBe('node-fastify');
    expect(output.inventory.summary.totalFiles).toBeGreaterThan(0);
    expect(output.coverage.declaredRules).toBe(output.profile.declaredRuleCoverage.length);
  });

  it('executes assess CLI command in text mode and returns exit code', async () => {
    const dir = createFixtureDir('cli-text');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cli-text-demo', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    const { context, getStdout } = createMockContext(dir, false);

    const parsed: ParsedArgs = {
      command: 'assess',
      flags: {},
      positional: [dir]
    };

    const exitCode = await assessCommand(parsed, context);

    expect(exitCode).toBe(2);
    const stdout = getStdout();
    expect(stdout).toContain('assess');
    expect(stdout).toContain('Target Boundaries');
    expect(stdout).toContain('Standards Profile');
    expect(stdout).toContain('Inventory');
    expect(stdout).toContain('Rule Coverage');
  });
});
