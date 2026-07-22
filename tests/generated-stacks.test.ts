import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function availableCommand(commands: string[]): string | undefined {
  return commands.find((command) => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
}

function checkedSpawn(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = 300_000
): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout
  });
  expect(
    result.status,
    `${command} ${args.join(' ')} failed in ${cwd}\n${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
  ).toBe(0);
}

async function filesUnder(root: string, extension: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(extension)) {
        files.push(fullPath);
      }
    }
  };
  await walk(root);
  return files;
}

describe('generated standard stack smoke checks', () => {
  it('parses generated Python source when Python is available', async () => {
    if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-python-smoke-'));
    const projectRoot = path.join(tempRoot, 'python-api');
    try {
      const plan = buildProjectPlan({
        projectName: "Bob's Python API",
        projectType: 'standard',
        apiStack: 'python',
        cloud: 'azure'
      }, { requireProjectName: true });
      await writeArtifacts(projectRoot, buildArtifacts(plan));

      const result = spawnSync('python3', ['-m', 'compileall', '-q', 'backend'], {
        cwd: projectRoot,
        encoding: 'utf8'
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('parses generated Node.js TypeScript and JSON configuration', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-node-smoke-'));
    const projectRoot = path.join(tempRoot, 'node-api');
    try {
      const plan = buildProjectPlan({
        projectName: "Bob's Node API",
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      }, { requireProjectName: true });
      await writeArtifacts(projectRoot, buildArtifacts(plan));

      JSON.parse(await readFile(path.join(projectRoot, 'backend', 'package.json'), 'utf8'));
      JSON.parse(await readFile(path.join(projectRoot, 'backend', 'tsconfig.json'), 'utf8'));
      for (const filePath of await filesUnder(path.join(projectRoot, 'backend'), '.ts')) {
        const source = await readFile(filePath, 'utf8');
        const result = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
          reportDiagnostics: true,
          fileName: filePath
        });
        expect(result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []).toEqual([]);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('formats and tests a fresh generated Go project without rewriting module metadata', async () => {
    if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-go-smoke-'));
    const projectRoot = path.join(tempRoot, 'go-api');
    try {
      const plan = buildProjectPlan({
        projectName: "Bob's Go API",
        projectType: 'standard',
        apiStack: 'go',
        cloud: 'azure'
      }, { requireProjectName: true });
      await writeArtifacts(projectRoot, buildArtifacts(plan));

      const goFiles = await filesUnder(path.join(projectRoot, 'backend'), '.go');
      const result = spawnSync('gofmt', ['-d', ...goFiles], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');

      const modulePath = path.join(projectRoot, 'backend', 'go.mod');
      const checksumPath = path.join(projectRoot, 'backend', 'go.sum');
      const metadataBefore = await Promise.all([
        readFile(modulePath, 'utf8'),
        readFile(checksumPath, 'utf8')
      ]);
      checkedSpawn('go', ['test', './...'], path.join(projectRoot, 'backend'));
      expect(await Promise.all([
        readFile(modulePath, 'utf8'),
        readFile(checksumPath, 'utf8')
      ])).toEqual(metadataBefore);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 600_000);

  it('installs and tests fresh Python, GenAI, and Function worker projects', async () => {
    const pythonCommand = availableCommand(['python3', 'python']);
    if (!pythonCommand) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-python-test-'));
    const standardRoot = path.join(tempRoot, 'python-api');
    const ragRoot = path.join(tempRoot, 'rag-api');
    const virtualEnvironment = path.join(tempRoot, 'venv');
    try {
      await writeArtifacts(standardRoot, buildArtifacts(buildProjectPlan({
        projectName: 'Python Smoke',
        projectType: 'standard',
        apiStack: 'python',
        cloud: 'azure'
      }, { requireProjectName: true })));
      await writeArtifacts(ragRoot, buildArtifacts(buildProjectPlan({
        projectName: 'RAG Smoke',
        pattern: 'rag',
        cloud: 'azure'
      }, { requireProjectName: true })));

      checkedSpawn(pythonCommand, ['-m', 'venv', virtualEnvironment], tempRoot);
      const virtualPython = path.join(
        virtualEnvironment,
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python'
      );
      const functionRoot = path.join(ragRoot, 'functions', 'rag-worker');
      for (const installArguments of [
        ['-e', `${path.join(standardRoot, 'backend')}[test]`],
        ['-e', `${path.join(ragRoot, 'backend')}[test]`],
        ['-r', path.join(functionRoot, 'requirements.txt')]
      ]) {
        checkedSpawn(virtualPython, [
          '-m',
          'pip',
          'install',
          '--quiet',
          '--disable-pip-version-check',
          '--prefer-binary',
          ...installArguments
        ], tempRoot, process.env, 900_000);
      }

      const testEnvironment = {
        ...process.env,
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/liftoff_test',
        REDIS_URL: 'redis://localhost:6379/0',
        PYDANTIC_AI_MODEL: '',
        LANGFUSE_PUBLIC_KEY: '',
        LANGFUSE_SECRET_KEY: ''
      };
      checkedSpawn(virtualPython, ['-m', 'pytest', '-q'], path.join(standardRoot, 'backend'), testEnvironment);
      checkedSpawn(virtualPython, ['-m', 'pytest', '-q'], path.join(ragRoot, 'backend'), testEnvironment);
      checkedSpawn(virtualPython, ['-m', 'pytest', '-q'], functionRoot, testEnvironment);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 1_800_000);

  it('installs, builds, and tests a fresh generated Node.js project', async () => {
    if (spawnSync(npmCommand, ['--version'], { encoding: 'utf8' }).status !== 0) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-node-test-'));
    const projectRoot = path.join(tempRoot, 'node-api');
    try {
      await writeArtifacts(projectRoot, buildArtifacts(buildProjectPlan({
        projectName: 'Node Smoke',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      }, { requireProjectName: true })));
      const backendRoot = path.join(projectRoot, 'backend');
      checkedSpawn(
        npmCommand,
        ['install', '--no-audit', '--no-fund', '--prefer-offline'],
        backendRoot,
        process.env,
        600_000
      );
      checkedSpawn(npmCommand, ['run', 'build', '--silent'], backendRoot);
      checkedSpawn(npmCommand, ['test', '--silent'], backendRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 900_000);

  it('installs and production-builds a fresh generated frontend', async () => {
    if (spawnSync(npmCommand, ['--version'], { encoding: 'utf8' }).status !== 0) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-frontend-test-'));
    const projectRoot = path.join(tempRoot, 'rag-ui');
    try {
      await writeArtifacts(projectRoot, buildArtifacts(buildProjectPlan({
        projectName: 'RAG Frontend Smoke',
        pattern: 'rag',
        cloud: 'azure',
        includeFrontend: true
      }, { requireProjectName: true })));
      const frontendRoot = path.join(projectRoot, 'frontend');
      checkedSpawn(
        npmCommand,
        ['install', '--no-audit', '--no-fund', '--prefer-offline'],
        frontendRoot,
        process.env,
        600_000
      );
      checkedSpawn(npmCommand, ['run', 'build', '--silent'], frontendRoot, {
        ...process.env,
        VITE_API_BASE_URL: 'https://api.example.test'
      });
      expect(await readFile(path.join(frontendRoot, 'dist', 'index.html'), 'utf8')).toContain('RAG Frontend Smoke');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 900_000);

  it('keeps machine-readable artifact paths portable for every stack', () => {
    for (const apiStack of ['python', 'node', 'go']) {
      const artifacts = buildArtifacts(buildProjectPlan({
        projectName: `${apiStack} paths`,
        projectType: 'standard',
        apiStack,
        cloud: 'azure'
      }, { requireProjectName: true }));

      for (const artifact of artifacts) {
        expect(artifact.pathParts.every((part) => !part.includes('/') && !part.includes('\\'))).toBe(true);
      }
    }

    expect(path.win32.join('project', 'backend', 'src', 'server.ts')).toBe('project\\backend\\src\\server.ts');
  });

  it('formats and validates representative OpenTofu output when OpenTofu is available', async () => {
    if (spawnSync('tofu', ['version'], { encoding: 'utf8' }).status !== 0) {
      return;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-tofu-smoke-'));
    try {
      const plans = [
        buildProjectPlan({
          projectName: 'Worker Frontend Infrastructure',
          pattern: 'rag',
          cloud: 'azure',
          includeFrontend: true,
          environments: ['dev']
        }, { requireProjectName: true }),
        buildProjectPlan({
          projectName: 'Standard Infrastructure',
          projectType: 'standard',
          apiStack: 'node',
          cloud: 'azure',
          environments: ['dev']
        }, { requireProjectName: true })
      ];

      for (const [index, plan] of plans.entries()) {
        const projectRoot = path.join(tempRoot, `project-${index}`);
        await writeArtifacts(projectRoot, buildArtifacts(plan));
        const tofuRoot = path.join(projectRoot, 'infrastructure', 'opentofu', 'azure');
        checkedSpawn('tofu', ['fmt', '-check', '-recursive', '-no-color'], tofuRoot);
        const tofuEnvironment = { ...process.env, TF_IN_AUTOMATION: '1' };
        checkedSpawn(
          'tofu',
          ['init', '-backend=false', '-input=false', '-no-color'],
          tofuRoot,
          tofuEnvironment,
          600_000
        );
        checkedSpawn('tofu', ['validate', '-no-color'], tofuRoot, tofuEnvironment);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 1_200_000);
});
