import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const typescriptCli = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const fixtureRoot = path.resolve('tests', '.stack-fixtures', randomUUID());
beforeAll(async () => { await mkdir(fixtureRoot, { recursive: true }); });
afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });

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

async function verifyNativeServer(command: string, args: string[], cwd: string): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test port.');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = { ...process.env, PORT: String(port) };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  delete env.LIFTOFF_ENV_FILE;
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError || child.exitCode !== null) throw new Error(`Native startup failed: ${spawnError?.message ?? output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          expect(await response.json()).toMatchObject({ status: 'ready' });
          ready = true;
          break;
        }
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, output).toBe(true);
    for (const route of ['/health', '/api', '/scalar', '/openapi.json']) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1000) });
      expect(response.status, route).toBe(200);
    }
  } finally {
    if (child.exitCode === null && !spawnError) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }
}

describe('generated standard stack smoke checks', () => {
  it('parses generated Python source when Python is available', async ({ skip }) => {
    if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) {
      return skip();
    }

    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-python-smoke-'));
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
    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-node-smoke-'));
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
      checkedSpawn(process.execPath, [
        typescriptCli,
        '--ignoreConfig',
        '--noCheck',
        '--noEmit',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        '--target', 'ES2022',
        ...await filesUnder(path.join(projectRoot, 'backend'), '.ts')
      ], projectRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('formats and tests a fresh generated Go project without rewriting module metadata', async ({ skip }) => {
    if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
      return skip();
    }

    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-go-smoke-'));
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
      await copyFile(path.join(projectRoot, 'runtime.config.example.json'), path.join(projectRoot, 'runtime.config.json'));
      const binary = path.join(projectRoot, process.platform === 'win32' ? 'native-api.exe' : 'native-api');
      checkedSpawn('go', ['build', '-o', binary, './cmd/api'], path.join(projectRoot, 'backend'));
      await verifyNativeServer(binary, [], path.join(projectRoot, 'backend'));
      expect(await Promise.all([
        readFile(modulePath, 'utf8'),
        readFile(checksumPath, 'utf8')
      ])).toEqual(metadataBefore);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 600_000);

  it('installs and tests frozen Python, GenAI, and Function worker projects', async ({ skip }) => {
    const uvCommand = availableCommand(['uv']);
    if (!uvCommand) {
      return skip();
    }

    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-python-test-'));
    const standardRoot = path.join(tempRoot, 'python-api');
    const ragRoot = path.join(tempRoot, 'rag-api');
    const genericRoot = path.join(tempRoot, 'generic-api');
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
      await writeArtifacts(genericRoot, buildArtifacts(buildProjectPlan({
        projectName: 'Generic Smoke',
        pattern: 'generic',
        cloud: 'azure'
      }, { requireProjectName: true })));

      const standardMetadata = await Promise.all([
        readFile(path.join(standardRoot, 'backend', 'pyproject.toml')),
        readFile(path.join(standardRoot, 'backend', 'uv.lock'))
      ]);
      checkedSpawn(uvCommand, [
        'sync',
        '--frozen',
        '--project',
        path.join(standardRoot, 'backend'),
        '--extra',
        'test'
      ], tempRoot, process.env, 900_000);
      expect(await Promise.all([
        readFile(path.join(standardRoot, 'backend', 'pyproject.toml')),
        readFile(path.join(standardRoot, 'backend', 'uv.lock'))
      ])).toEqual(standardMetadata);

      const genAiMetadata = await Promise.all([
        readFile(path.join(ragRoot, 'backend', 'pyproject.toml')),
        readFile(path.join(ragRoot, 'backend', 'uv.lock'))
      ]);
      checkedSpawn(uvCommand, [
        'sync',
        '--frozen',
        '--project',
        path.join(ragRoot, 'backend'),
        '--extra',
        'test',
        '--extra',
        'functions'
      ], tempRoot, process.env, 900_000);
      expect(await Promise.all([
        readFile(path.join(ragRoot, 'backend', 'pyproject.toml')),
        readFile(path.join(ragRoot, 'backend', 'uv.lock'))
      ])).toEqual(genAiMetadata);

      const genericMetadata = await Promise.all([
        readFile(path.join(genericRoot, 'backend', 'pyproject.toml')),
        readFile(path.join(genericRoot, 'backend', 'uv.lock'))
      ]);
      checkedSpawn(uvCommand, [
        'sync',
        '--frozen',
        '--project',
        path.join(genericRoot, 'backend'),
        '--extra',
        'test'
      ], tempRoot, process.env, 900_000);
      expect(await Promise.all([
        readFile(path.join(genericRoot, 'backend', 'pyproject.toml')),
        readFile(path.join(genericRoot, 'backend', 'uv.lock'))
      ])).toEqual(genericMetadata);

      const functionRoot = path.join(ragRoot, 'functions', 'rag-worker');
      const testEnvironment = {
        ...process.env,
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/liftoff_test',
        REDIS_URL: 'redis://localhost:6379/0',
        PYDANTIC_AI_MODEL: '',
        LANGFUSE_PUBLIC_KEY: '',
        LANGFUSE_SECRET_KEY: ''
      };
      checkedSpawn(uvCommand, [
        'run',
        '--project',
        path.join(standardRoot, 'backend'),
        'python',
        '-m',
        'pytest',
        '-q'
      ], path.join(standardRoot, 'backend'), testEnvironment);
      checkedSpawn(uvCommand, [
        'run',
        '--project',
        path.join(ragRoot, 'backend'),
        'python',
        '-m',
        'pytest',
        '-q'
      ], path.join(ragRoot, 'backend'), testEnvironment);
      checkedSpawn(uvCommand, [
        'run',
        '--project',
        path.join(genericRoot, 'backend'),
        'python',
        '-m',
        'pytest',
        '-q'
      ], path.join(genericRoot, 'backend'), testEnvironment);
      checkedSpawn(uvCommand, [
        'run',
        '--project',
        path.join(ragRoot, 'backend'),
        '--directory',
        functionRoot,
        'python',
        '-m',
        'pytest',
        '-q'
      ], functionRoot, testEnvironment);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 1_800_000);

  it('installs, builds, and tests a fresh generated Node.js project', async ({ skip }) => {
    if (spawnSync(npmCommand, ['--version'], { encoding: 'utf8' }).status !== 0) {
      return skip();
    }

    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-node-test-'));
    const projectRoot = path.join(tempRoot, 'node-api');
    try {
      await writeArtifacts(projectRoot, buildArtifacts(buildProjectPlan({
        projectName: 'Node Smoke',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      }, { requireProjectName: true })));
      const backendRoot = path.join(projectRoot, 'backend');
      await copyFile(path.join(projectRoot, '.env.example'), path.join(projectRoot, '.env'));
      checkedSpawn(
        npmCommand,
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        backendRoot,
        process.env,
        600_000
      );
      checkedSpawn(npmCommand, ['run', 'build', '--silent'], backendRoot);
      checkedSpawn(npmCommand, ['test', '--silent'], backendRoot);
      await verifyNativeServer(process.execPath, ['dist/server.js'], backendRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 900_000);

  it('installs and production-builds specialized and generic generated frontends', async ({ skip }) => {
    if (spawnSync(npmCommand, ['--version'], { encoding: 'utf8' }).status !== 0) {
      return skip();
    }

    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-frontend-test-'));
    try {
      for (const [directory, projectName, pattern] of [
        ['rag-ui', 'RAG Frontend Smoke', 'rag'],
        ['generic-ui', 'Generic Frontend Smoke', 'generic']
      ] as const) {
        const projectRoot = path.join(tempRoot, directory);
        await writeArtifacts(projectRoot, buildArtifacts(buildProjectPlan({
          projectName,
          pattern,
          cloud: 'azure',
          includeFrontend: true
        }, { requireProjectName: true })));
        const frontendRoot = path.join(projectRoot, 'frontend');
        checkedSpawn(
          npmCommand,
          ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          frontendRoot,
          process.env,
          600_000
        );
        checkedSpawn(npmCommand, ['run', 'build', '--silent'], frontendRoot, {
          ...process.env,
          VITE_API_BASE_URL: 'https://api.example.test'
        });
        expect(await readFile(path.join(frontendRoot, 'dist', 'index.html'), 'utf8'))
          .toContain(projectName);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 1_200_000);

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

    const genericArtifacts = buildArtifacts(buildProjectPlan({
      projectName: 'Generic paths',
      pattern: 'generic',
      cloud: 'azure'
    }, { requireProjectName: true }));
    for (const artifact of genericArtifacts) {
      expect(
        artifact.pathParts.every((part) => !part.includes('/') && !part.includes('\\'))
      ).toBe(true);
    }

    expect(path.win32.join('project', 'backend', 'src', 'server.ts')).toBe('project\\backend\\src\\server.ts');
  });

  it('formats and validates representative OpenTofu output when OpenTofu is available', async ({ skip }) => {
    if (spawnSync('tofu', ['version'], { encoding: 'utf8' }).status !== 0) {
      return skip();
    }

    const tempRoot = await mkdtemp(path.join(fixtureRoot, 'liftoff-tofu-smoke-'));
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
        }, { requireProjectName: true }),
        buildProjectPlan({
          projectName: 'Generic Infrastructure',
          pattern: 'generic',
          cloud: 'azure',
          environments: ['dev']
        }, { requireProjectName: true })
      ];

      for (const [index, plan] of plans.entries()) {
        const projectRoot = path.join(tempRoot, `project-${index}`);
        await writeArtifacts(projectRoot, buildArtifacts(plan));
        const tofuRoot = path.join(projectRoot, 'infrastructure', 'opentofu', 'azure', 'environments', 'dev');
        const providerLock = path.join(tofuRoot, '.terraform.lock.hcl');
        const providerLockBefore = await readFile(providerLock);
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
        expect(await readFile(providerLock)).toEqual(providerLockBefore);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 1_200_000);
});
