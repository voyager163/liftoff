import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function run(
  args: string[],
  cwd: string,
  runner = new ReadyInitRunner()
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), { cwd, stdout, stderr, runner });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function buildLegacyFixture(): Promise<{ parent: string; source: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-migrate-'));
  cleanups.push(parent);
  const source = path.join(parent, 'legacy-app');
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(path.join(source, 'tests'), { recursive: true });
  await mkdir(path.join(source, 'alembic'), { recursive: true });
  await mkdir(path.join(source, 'node_modules', 'junk'), { recursive: true });
  await mkdir(path.join(source, '.git'), { recursive: true });
  await writeFile(path.join(source, 'requirements.txt'), 'fastapi==0.111.0\npgvector==0.2.5\nazure-storage-blob==12.19.0\n');
  await writeFile(path.join(source, '.env'), 'DATABASE_URL=postgres://legacy\n');
  await writeFile(path.join(source, 'Dockerfile'), 'FROM python:3.12\n');
  await writeFile(path.join(source, 'src', 'main.py'), 'app = "legacy"\n');
  await writeFile(path.join(source, 'tests', 'test_main.py'), 'def test_ok():\n    assert True\n');
  await writeFile(path.join(source, 'alembic', 'env.py'), '# alembic env\n');
  await writeFile(path.join(source, 'node_modules', 'junk', 'index.js'), 'x\n');
  await writeFile(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return { parent, source };
}

async function buildStandardFixture(
  name: string,
  files: Record<string, string>
): Promise<{ parent: string; source: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-standard-migrate-'));
  cleanups.push(parent);
  const source = path.join(parent, name);
  await mkdir(source, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(source, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { parent, source };
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        hashes.set(path.relative(root, full), createHash('sha256').update(await readFile(full)).digest('hex'));
      }
    }
  };
  await walk(root);
  return hashes;
}

describe('migrate command', () => {
  it('scaffolds a compliant sibling project without touching the source', async () => {
    const { parent, source } = await buildLegacyFixture();
    const before = await hashTree(source);

    const result = await run(['migrate', source, '--region', 'eastus', '--yes'], parent);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Scan defaults');
    expect(result.out).toMatch(/pattern: rag.*retrieval dependency/);
    expect(result.out).toMatch(/cloud: azure.*azure-\* dependency/);

    const target = path.join(parent, 'legacy-app-liftoff');
    const validate = await run(['validate', target], parent);
    expect(validate.code).toBe(0);

    const manifest = JSON.parse(await readFile(path.join(target, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.artifactVersion).toBe(3);
    expect(manifest.project.pattern).toBe('rag');
    expect(manifest.framework).toMatchObject({
      state: 'initialized',
      adapter: 'openspec',
      contractVersion: '1.6.0'
    });

    const after = await hashTree(source);
    expect(after).toEqual(before);
  });

  it('stages a filtered legacy copy that git ignores', async () => {
    const { parent, source } = await buildLegacyFixture();
    await run(['migrate', source, '--region', 'eastus', '--yes'], parent);
    const target = path.join(parent, 'legacy-app-liftoff');
    const staging = path.join(target, 'migration', 'legacy');

    await access(path.join(staging, 'requirements.txt'));
    await access(path.join(staging, 'src', 'main.py'));
    await expect(access(path.join(staging, 'node_modules'))).rejects.toThrow();
    await expect(access(path.join(staging, '.git'))).rejects.toThrow();

    const gitignore = await readFile(path.join(target, '.gitignore'), 'utf8');
    expect(gitignore).toContain('migration/legacy/');
  });

  it('detects and migrates standard Python, Node.js, and Go API stacks', async () => {
    const fixtures = [
      {
        name: 'legacy-python',
        files: { 'requirements.txt': 'fastapi==0.111.0\nsqlalchemy==2.0.30\n' },
        stack: 'python-fastapi',
        expectedPath: ['backend', 'pyproject.toml']
      },
      {
        name: 'legacy-node',
        files: { 'package.json': JSON.stringify({ dependencies: { fastify: '^5.0.0' }, devDependencies: { typescript: '^5.5.0' } }) },
        stack: 'node-fastify',
        expectedPath: ['backend', 'package.json']
      },
      {
        name: 'legacy-go',
        files: {
          'go.mod': 'module example.com/legacy\n\ngo 1.23\n\nrequire github.com/danielgtaylor/huma/v2 v2.27.0\n',
          'cmd/api/main.go': 'package main\n\nimport _ "github.com/go-chi/chi/v5"\n'
        },
        stack: 'go-huma',
        expectedPath: ['backend', 'go.mod']
      }
    ];

    for (const fixture of fixtures) {
      const { parent, source } = await buildStandardFixture(fixture.name, fixture.files);
      const before = await hashTree(source);
      const result = await run(['migrate', source, '--region', 'eastus', '--yes'], parent);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`apiStack: ${fixture.stack}`);

      const target = path.join(parent, `${fixture.name}-liftoff`);
      const manifest = JSON.parse(await readFile(path.join(target, 'liftoff.manifest.json'), 'utf8'));
      expect(manifest.project.projectType).toBe('standard');
      expect(manifest.project.apiStack).toBe(fixture.stack);
      await access(path.join(target, ...fixture.expectedPath));

      const tasks = await readFile(path.join(target, 'openspec', 'changes', 'migrate-to-liftoff', 'tasks.md'), 'utf8');
      expect(tasks).toContain(fixture.expectedPath.join('/'));
      expect(tasks).not.toContain('backend/orchestration/retrieval');
      if (fixture.stack === 'go-huma') {
        expect(tasks).toContain('migration/legacy/cmd/api/main.go');
        expect(tasks).toContain('backend/cmd/api/');
      }
      expect(await hashTree(source)).toEqual(before);
    }
  });

  it('leaves weak and conflicting API evidence unresolved', async () => {
    const weak = await buildStandardFixture('legacy-weak', {
      'package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } })
    });
    const weakResult = await run(['migrate', weak.source, '--yes'], weak.parent);
    expect(weakResult.code).toBe(1);
    expect(weakResult.err).toContain('Project type is required');

    const conflicting = await buildStandardFixture('legacy-conflicting', {
      'package.json': JSON.stringify({ dependencies: { fastify: '^5.0.0' } }),
      'go.mod': 'module example.com/conflict\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.2.1\n'
    });
    const conflictResult = await run(['migrate', conflicting.source, '--yes'], conflicting.parent);
    expect(conflictResult.code).toBe(1);
    expect(conflictResult.out).toContain('apiStack: unresolved');
    expect(conflictResult.out).toContain('conflicting evidence');

    const genAiConflict = await buildStandardFixture('legacy-genai-conflicting', {
      'requirements.txt': 'pgvector==0.2.5\n',
      'package.json': JSON.stringify({ dependencies: { fastify: '^5.0.0' } })
    });
    const genAiConflictResult = await run(['migrate', genAiConflict.source, '--yes'], genAiConflict.parent);
    expect(genAiConflictResult.code).toBe(1);
    expect(genAiConflictResult.out).toContain('projectType: unresolved');
    expect(genAiConflictResult.out).toContain('conflicting GenAI and node-fastify evidence');
  });

  it('allows explicit flags to override detected GenAI defaults', async () => {
    const { parent, source } = await buildLegacyFixture();
    const result = await run([
      'migrate', source, '--no-genai', '--api', 'node', '--region', 'eastus', '--yes'
    ], parent);

    expect(result.code).toBe(0);
    const target = path.join(parent, 'legacy-app-liftoff');
    const manifest = JSON.parse(await readFile(path.join(target, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.project.projectType).toBe('standard');
    expect(manifest.project.apiStack).toBe('node-fastify');
    expect(manifest.project.pattern).toBeUndefined();

    const tasks = await readFile(path.join(target, 'openspec', 'changes', 'migrate-to-liftoff', 'tasks.md'), 'utf8');
    expect(tasks).not.toContain('backend/orchestration/retrieval');
  });

  it('emits an OpenSpec change seeded from the scan with nothing silently dropped', async () => {
    const { parent, source } = await buildLegacyFixture();
    await run(['migrate', source, '--region', 'eastus', '--yes'], parent);
    const target = path.join(parent, 'legacy-app-liftoff');

    const proposal = await readFile(path.join(target, 'openspec', 'changes', 'migrate-to-liftoff', 'proposal.md'), 'utf8');
    expect(proposal).toContain('Completion Gate');
    expect(proposal).toContain('liftoff validate');

    const tasks = await readFile(path.join(target, 'openspec', 'changes', 'migrate-to-liftoff', 'tasks.md'), 'utf8');
    expect(tasks).toContain('migration/legacy/requirements.txt');
    expect(tasks).toContain('backend/pyproject.toml');
    expect(tasks).toMatch(/Map variables from migration\/legacy\/\.env/);
    expect(tasks).toMatch(/Relocate tests from migration\/legacy\/tests/);
    expect(tasks).toContain('Rebase migration history from migration/legacy/alembic');
    expect(tasks).toContain('unique head');
    expect(tasks).toMatch(/Decide placement for migration\/legacy\/src/);
    expect(tasks).toContain('Delete migration/legacy/');
    expect(tasks).toMatch(/- \[ \] \d+\.\d+ /);
  });

  it('emits MIGRATION.md for non-OpenSpec workflows', async () => {
    const { parent, source } = await buildLegacyFixture();
    const result = await run(['migrate', source, '--region', 'eastus', '--spec', 'spec-kit', '--yes'], parent);
    expect(result.code).toBe(0);
    const target = path.join(parent, 'legacy-app-liftoff');

    await access(path.join(target, 'MIGRATION.md'));
    await expect(access(path.join(target, 'openspec', 'changes', 'migrate-to-liftoff'))).rejects.toThrow();
    const checklist = await readFile(path.join(target, 'MIGRATION.md'), 'utf8');
    expect(checklist).toContain('Completion Gate');
    expect(checklist).toContain('migration/legacy/requirements.txt');
  });

  it.each([
    {
      workflow: 'openspec',
      extra: [] as string[],
      expectedDefault: undefined,
      marker: ['.claude', 'skills', 'openspec-apply-change', 'SKILL.md']
    },
    {
      workflow: 'spec-kit',
      extra: ['--default-agent', 'claude'],
      expectedDefault: 'claude',
      marker: ['.claude', 'skills', 'speckit-specify', 'SKILL.md']
    }
  ])('uses official $workflow initialization for both selected agents', async ({
    workflow,
    extra,
    expectedDefault,
    marker
  }) => {
    const { parent, source } = await buildLegacyFixture();
    const before = await hashTree(source);
    const result = await run([
      'migrate', source, '--region', 'eastus', '--spec', workflow,
      '--agents', 'copilot,claude', ...extra, '--yes'
    ], parent);

    expect(result.code).toBe(0);
    const target = path.join(parent, 'legacy-app-liftoff');
    const manifest = JSON.parse(await readFile(path.join(target, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.project.agents).toEqual(['github-copilot', 'claude']);
    expect(manifest.project.defaultAgent).toBe(expectedDefault);
    await access(path.join(target, ...marker));
    await access(path.join(
      target,
      '.github',
      'skills',
      workflow === 'openspec' ? 'openspec-apply-change' : 'speckit-specify',
      'SKILL.md'
    ));
    expect(await hashTree(source)).toEqual(before);
  });

  it('blocks on a missing framework before target writes and leaves the source unchanged', async () => {
    const { parent, source } = await buildLegacyFixture();
    const before = await hashTree(source);
    const runner = new ReadyInitRunner({ missing: ['openspec'] });

    const result = await run(['migrate', source, '--region', 'eastus', '--yes'], parent, runner);

    expect(result.code).toBe(1);
    expect(result.err).toContain('OpenSpec: command not found');
    expect(result.err).toContain('liftoff migrate');
    await expect(access(path.join(parent, 'legacy-app-liftoff'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await hashTree(source)).toEqual(before);
    expect(runner.calls.some((command) => command.executable === 'openspec' && command.args[0] === 'init')).toBe(false);
  });

  it('uses separate tool-install consent without weakening source immutability', async () => {
    const { parent, source } = await buildLegacyFixture();
    const before = await hashTree(source);
    const runner = new ReadyInitRunner({ missing: ['openspec'] });

    const result = await run([
      'migrate', source, '--region', 'eastus', '--yes', '--install-tools'
    ], parent, runner);

    expect(result.code).toBe(0);
    expect(runner.calls.some((command) =>
      command.executable === 'npm' &&
      command.args[0] === 'install' &&
      command.args.some((argument) => argument.includes('@fission-ai/openspec'))
    )).toBe(true);
    await access(path.join(parent, 'legacy-app-liftoff', 'liftoff.manifest.json'));
    expect(await hashTree(source)).toEqual(before);
  });

  it('installs dependencies only under the fresh target and never runs commands from the source', async () => {
    const { parent, source } = await buildStandardFixture('legacy-node-dependencies', {
      'package.json': JSON.stringify({
        dependencies: { fastify: '^5.0.0' },
        devDependencies: { typescript: '^5.5.0' }
      })
    });
    const before = await hashTree(source);
    const runner = new ReadyInitRunner();

    const result = await run([
      'migrate', source, '--region', 'eastus', '--yes', '--install-dependencies'
    ], parent, runner);

    expect(result.code).toBe(0);
    const target = path.join(parent, 'legacy-node-dependencies-liftoff');
    expect(runner.callDetails.some(({ command, options }) =>
      command.executable === 'npm' &&
      command.args[0] === 'ci' &&
      options?.cwd === path.join(target, 'backend')
    )).toBe(true);
    for (const { options } of runner.callDetails) {
      if (!options?.cwd) continue;
      const relative = path.relative(source, options.cwd);
      expect(relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative)).toBe(false);
    }
    expect(await hashTree(source)).toEqual(before);
  });

  it('fails safely when the target directory already exists and is not empty', async () => {
    const { parent, source } = await buildLegacyFixture();
    const target = path.join(parent, 'legacy-app-liftoff');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep.txt'), 'existing\n');

    const result = await run(['migrate', source, '--region', 'eastus', '--yes'], parent);
    expect(result.code).toBe(1);
    expect(result.err).toContain('new or empty');
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('existing\n');

    const forced = await run(['migrate', source, '--region', 'eastus', '--yes', '--force'], parent);
    expect(forced.code).toBe(1);
    expect(forced.err).toContain('new or empty');
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('existing\n');
  });

  it('refuses to migrate a project that is already Liftoff-managed', async () => {
    const { parent, source } = await buildLegacyFixture();
    await writeFile(path.join(source, 'liftoff.manifest.json'), '{}\n');

    const result = await run(['migrate', source, '--yes'], parent);
    expect(result.code).toBe(1);
    expect(result.err).toContain('already a Liftoff project');
    expect(result.err).toContain('liftoff update');
  });

  it('requires a source path argument', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'liftoff-migrate-noarg-'));
    cleanups.push(elsewhere);
    const result = await run(['migrate'], elsewhere);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Usage: liftoff migrate');
  });
});
