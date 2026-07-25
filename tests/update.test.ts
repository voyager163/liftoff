import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
import { compareSemver } from '../src/semver.js';
import {
  CaptureStream,
  scriptedTtyInput,
  ttyCaptureStream
} from './helpers.js';

const sha = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function fixtureProject(includeFrontend = false): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Update App',
    pattern: 'prompt',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function standardFixtureProject(apiStack = 'node'): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Standard Update App',
    projectType: 'standard',
    apiStack,
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function powerAppsFixtureProject(codeAppsPlugin = false): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Power Apps Update App',
    projectType: 'power-apps-code-app',
    specWorkflow: 'openspec',
    agents: ['copilot'],
    codeAppsPlugin
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), { cwd, stdout, stderr });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function runInteractive(
  args: string[],
  cwd: string,
  answers: string
): Promise<{ code: number; out: string; err: string }> {
  const stdout = ttyCaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdin: scriptedTtyInput(answers),
    stdout,
    stderr
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function editJson(filePath: string, mutate: (value: any) => void): Promise<void> {
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  mutate(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function simulateManagedUpgrade(
  projectRoot: string,
  logicalName: string,
  pathParts: string[],
  previousContent: string
): Promise<void> {
  await writeFile(path.join(projectRoot, ...pathParts), previousContent, 'utf8');
  await editJson(path.join(projectRoot, 'liftoff.manifest.json'), (manifest) => {
    const artifact = manifest.artifacts.find(
      (entry: { logicalName: string }) => entry.logicalName === logicalName
    );
    artifact.contentHash = sha(previousContent);
  });
}

async function downgradeApiManifest(
  projectRoot: string,
  artifactVersion: 2 | 3
): Promise<void> {
  await editJson(path.join(projectRoot, 'liftoff.manifest.json'), (manifest) => {
    const project = manifest.project;
    const workload = project.workload;
    manifest.artifactVersion = artifactVersion;
    manifest.project = {
      name: project.name,
      ...(artifactVersion === 3 ? { projectType: workload.kind, apiStack: workload.apiStack } : {}),
      ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
      cloud: workload.cloud,
      region: workload.region,
      frontend: workload.frontend,
      environments: workload.environments,
      specWorkflow: project.specWorkflow,
      ...(artifactVersion === 3 ? {
        agents: project.agents,
        ...(project.defaultAgent ? { defaultAgent: project.defaultAgent } : {})
      } : {})
    };
    if (artifactVersion === 2) {
      delete manifest.framework;
    }
  });
}

describe('semver comparison', () => {
  it('orders releases and prereleases correctly', () => {
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.2.0', '0.3.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.3.0-next.1', '0.3.0')).toBeLessThan(0);
    expect(compareSemver('0.3.0-next.2', '0.3.0-next.10')).toBeLessThan(0);
    expect(compareSemver('0.3.0-alpha', '0.3.0-next')).toBeLessThan(0);
    expect(compareSemver('0.3.0-next.1', '0.2.9')).toBeGreaterThan(0);
  });
});

describe('update command', () => {
  it('reports no drift on a fresh project and exits 0', async () => {
    const root = await fixtureProject();
    const result = await run(['update'], root);
    expect(result.code).toBe(0);
    expect(result.out).toContain('No drift');
  });

  it('reports no drift on a fresh standard project', async () => {
    const root = await standardFixtureProject();
    const result = await run(['update'], root);
    expect(result.code).toBe(0);
    expect(result.out).toContain('No drift');
  });

  it('reconciles a clean Power Apps starter entirely from packaged offline assets', async () => {
    const root = await powerAppsFixtureProject();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const check = await run(['update'], root);
      expect(check.code).toBe(0);
      expect(check.out).toContain('No drift');

      const apply = await run(['update', '--apply'], root);
      expect(apply.code).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await run(['validate'], root)).toMatchObject({ code: 0 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe('interactive consent', () => {
    it('explains and applies safe dependency updates in the same invocation', async () => {
      const root = await fixtureProject(true);
      const oldPackage = '{"name":"old-frontend"}\n';
      const oldLock = '{"name":"old-frontend","lockfileVersion":3}\n';
      await simulateManagedUpgrade(
        root,
        'frontend-package',
        ['frontend', 'package.json'],
        oldPackage
      );
      await simulateManagedUpgrade(
        root,
        'frontend-lock',
        ['frontend', 'package-lock.json'],
        oldLock
      );

      const result = await runInteractive(['update'], root, 'y\n');

      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toContain('Update impact');
      expect(result.out).toContain('2 (2 replaces)');
      expect(result.out).toContain('Local or user-owned files at risk');
      expect(result.out).toContain('frontend/package.json');
      expect(result.out).toContain('frontend/package-lock.json');
      expect(result.out).toContain('Dependencies installed');
      expect(result.out).toContain('No');
      expect(result.out).toContain('Apply these 2 safe update actions now?');
      expect(await readFile(path.join(root, 'frontend', 'package.json'), 'utf8'))
        .not.toBe(oldPackage);
      expect(await readFile(path.join(root, 'frontend', 'package-lock.json'), 'utf8'))
        .not.toBe(oldLock);
    });

    it('leaves every byte unchanged when safe updates are declined', async () => {
      const root = await fixtureProject();
      const previous = '# previous template\n';
      const manifestPath = path.join(root, 'liftoff.manifest.json');
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);
      const beforeManifest = await readFile(manifestPath, 'utf8');

      const result = await runInteractive(['update'], root, '\n');

      expect(result.code).toBe(2);
      expect(result.out).toContain('Update declined; no project files were changed');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8')).toBe(previous);
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest);
    });

    it('applies safe changes while preserving separately declined conflicts', async () => {
      const root = await fixtureProject();
      const oldDockerfile = '# previous template\n';
      const localReadme = '# local readme\n';
      await simulateManagedUpgrade(
        root,
        'backend-dockerfile',
        ['Dockerfile'],
        oldDockerfile
      );
      await writeFile(path.join(root, 'README.md'), localReadme, 'utf8');

      const result = await runInteractive(['update'], root, 'y\nn\n');

      expect(result.code).toBe(0);
      expect(result.out).toContain('Local or user-owned files at risk');
      expect(result.out).toContain('README.md');
      expect(result.out).toContain('keeps no backup after success');
      expect(result.out).toContain('Overwrite all 1 listed conflict?');
      expect(result.out).toContain('skipped README.md');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8'))
        .not.toBe(oldDockerfile);
      expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe(localReadme);
    });

    it('reviews conflict-only drift and overwrites only after explicit consent', async () => {
      const declinedRoot = await fixtureProject();
      const declinedPath = path.join(declinedRoot, 'README.md');
      const original = await readFile(declinedPath, 'utf8');
      const local = '# local conflict\n';
      await writeFile(declinedPath, local, 'utf8');

      const declined = await runInteractive(['update'], declinedRoot, 'n\n');
      expect(declined.code).toBe(2);
      expect(declined.out).not.toContain('Apply these');
      expect(declined.out).toContain('Overwrite all 1 listed conflict?');
      expect(await readFile(declinedPath, 'utf8')).toBe(local);

      const accepted = await runInteractive(['update'], declinedRoot, 'y\n');
      expect(accepted.code).toBe(0);
      expect(await readFile(declinedPath, 'utf8')).toBe(original);
    });

    it('aborts before preflight when interactive input closes', async () => {
      const root = await fixtureProject();
      const previous = '# previous template\n';
      const manifestPath = path.join(root, 'liftoff.manifest.json');
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);
      const beforeManifest = await readFile(manifestPath, 'utf8');

      const result = await runInteractive(['update'], root, '');

      expect(result.code).toBe(0);
      expect(result.out).toContain('stopped before authorization');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8')).toBe(previous);
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest);
    });

    it('collects conflict consent before applying an accepted safe subset', async () => {
      const root = await fixtureProject();
      const oldDockerfile = '# previous template\n';
      const localReadme = '# local readme\n';
      const manifestPath = path.join(root, 'liftoff.manifest.json');
      await simulateManagedUpgrade(
        root,
        'backend-dockerfile',
        ['Dockerfile'],
        oldDockerfile
      );
      await writeFile(path.join(root, 'README.md'), localReadme, 'utf8');
      const beforeManifest = await readFile(manifestPath, 'utf8');

      const result = await runInteractive(['update'], root, 'y\n');

      expect(result.code).toBe(0);
      expect(result.out).toContain('stopped before authorization');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8')).toBe(oldDockerfile);
      expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe(localReadme);
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest);
    });

    it('aborts if a reviewed target changes while consent is pending', async () => {
      const root = await fixtureProject();
      const dockerfilePath = path.join(root, 'Dockerfile');
      const previous = '# previous template\n';
      const changedDuringPrompt = '# changed while prompt was open\n';
      const manifestPath = path.join(root, 'liftoff.manifest.json');
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);
      const beforeManifest = await readFile(manifestPath, 'utf8');
      const input = new PassThrough() as PassThrough & {
        isTTY: true;
        setRawMode: (mode: boolean) => PassThrough;
      };
      input.isTTY = true;
      input.setRawMode = () => input;
      const stdout = ttyCaptureStream();
      const stderr = new CaptureStream();

      const command = runCommand(parseArgs(['update']), {
        cwd: root,
        stdin: input,
        stdout,
        stderr
      });
      await vi.waitFor(() => {
        expect(stdout.text()).toContain('Apply these 1 safe update action now?');
      });
      await writeFile(dockerfilePath, changedDuringPrompt, 'utf8');
      input.end('y\n');

      expect(await command).toBe(1);
      expect(stderr.text()).toContain('changed after review');
      expect(await readFile(dockerfilePath, 'utf8')).toBe(changedDuringPrompt);
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest);
    });

    it('discloses both physical files at risk for a modified move collision', async () => {
      const root = await fixtureProject();
      const destinationPath = path.join(root, 'README.md');
      const oldParts = ['legacy', 'README.md'];
      const oldPath = path.join(root, ...oldParts);
      await mkdir(path.dirname(oldPath), { recursive: true });
      await rename(destinationPath, oldPath);
      await writeFile(oldPath, '# modified source\n', 'utf8');
      await writeFile(destinationPath, '# occupied destination\n', 'utf8');
      await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
        manifest.artifacts.find(
          (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
        ).pathParts = oldParts;
      });

      const result = await runInteractive(['update'], root, 'n\n');

      expect(result.code).toBe(2);
      expect(result.out).toContain('Local or user-owned files at risk');
      expect(result.out).toContain('2 (requires separate consent)');
      expect(result.out).toContain('legacy/README.md');
      expect(result.out).toContain('README.md');
      expect(result.out).toContain('Overwrite all 2 listed conflicts?');
      expect(await readFile(oldPath, 'utf8')).toBe('# modified source\n');
      expect(await readFile(destinationPath, 'utf8')).toBe('# occupied destination\n');
    });

    it('does not prompt or mutate for orphan-only drift', async () => {
      const root = await fixtureProject();
      const orphanPath = path.join(root, 'retired.txt');
      const orphanContent = 'retired template\n';
      await writeFile(orphanPath, orphanContent, 'utf8');
      await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
        manifest.artifacts.push({
          logicalName: 'retired-template',
          category: 'backend',
          pathParts: ['retired.txt'],
          contentHash: sha(orphanContent)
        });
      });
      const beforeManifest = await readFile(
        path.join(root, 'liftoff.manifest.json'),
        'utf8'
      );

      const result = await runInteractive(['update'], root, 'y\n');

      expect(result.code).toBe(2);
      expect(result.out).not.toContain('Apply these');
      expect(result.out).not.toContain('Overwrite all');
      expect(result.out).not.toContain('liftoff update --apply');
      expect(await readFile(orphanPath, 'utf8')).toBe(orphanContent);
      expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'))
        .toBe(beforeManifest);
    });

    it('prompts for a recorded-state-only refresh', async () => {
      const root = await fixtureProject();
      await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
        manifest.artifacts.find(
          (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
        ).contentHash = `sha256:${'0'.repeat(64)}`;
      });

      const result = await runInteractive(['update'], root, 'y\n');

      expect(result.code).toBe(0);
      expect(result.out).toContain('1 recorded-state refresh');
      expect(result.out).toContain('Apply these 1 safe update action now?');
      expect((await run(['update'], root)).code).toBe(0);
    });

    it('guards a reviewed hash-refresh file even when it needs no content write', async () => {
      const root = await fixtureProject();
      const readmePath = path.join(root, 'README.md');
      const manifestPath = path.join(root, 'liftoff.manifest.json');
      await editJson(manifestPath, (manifest) => {
        manifest.artifacts.find(
          (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
        ).contentHash = `sha256:${'0'.repeat(64)}`;
      });
      const beforeManifest = await readFile(manifestPath, 'utf8');
      const changedDuringPrompt = '# changed during hash refresh consent\n';
      const input = new PassThrough() as PassThrough & {
        isTTY: true;
        setRawMode: (mode: boolean) => PassThrough;
      };
      input.isTTY = true;
      input.setRawMode = () => input;
      const stdout = ttyCaptureStream();
      const stderr = new CaptureStream();

      const command = runCommand(parseArgs(['update']), {
        cwd: root,
        stdin: input,
        stdout,
        stderr
      });
      await vi.waitFor(() => {
        expect(stdout.text()).toContain('Apply these 1 safe update action now?');
      });
      await writeFile(readmePath, changedDuringPrompt, 'utf8');
      input.end('y\n');

      expect(await command).toBe(1);
      expect(stderr.text()).toContain('changed after review');
      expect(await readFile(readmePath, 'utf8')).toBe(changedDuringPrompt);
      expect(await readFile(manifestPath, 'utf8')).toBe(beforeManifest);
    });

    it('never prompts when either input or output is redirected', async () => {
      const root = await fixtureProject();
      const previous = '# previous template\n';
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);

      const ttyOutput = ttyCaptureStream();
      const redirectedInputError = new CaptureStream();
      const redirectedInputCode = await runCommand(parseArgs(['update']), {
        cwd: root,
        stdin: Readable.from(['y\n']),
        stdout: ttyOutput,
        stderr: redirectedInputError
      });
      expect(redirectedInputCode).toBe(2);
      expect(ttyOutput.text()).not.toContain('Apply these');

      const redirectedOutput = new CaptureStream();
      const redirectedOutputError = new CaptureStream();
      const redirectedOutputCode = await runCommand(parseArgs(['update']), {
        cwd: root,
        stdin: scriptedTtyInput('y\n'),
        stdout: redirectedOutput,
        stderr: redirectedOutputError
      });
      expect(redirectedOutputCode).toBe(2);
      expect(redirectedOutput.text()).not.toContain('Apply these');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8')).toBe(previous);
    });

    it('keeps explicit apply prompt-free in a TTY', async () => {
      const root = await fixtureProject();
      const previous = '# previous template\n';
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);

      const result = await runInteractive(['update', '--apply'], root, '');

      expect(result.code).toBe(0);
      expect(result.out).not.toContain('Update impact');
      expect(result.out).not.toContain('Apply these');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8')).not.toBe(previous);
    });

    it('keeps JSON check output byte-pure and prompt-free in a TTY', async () => {
      const root = await fixtureProject();
      const previous = '# previous template\n';
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);
      const stdout = ttyCaptureStream();
      const stderr = new CaptureStream();

      const code = await runCommand(parseArgs(['update', '--json']), {
        cwd: root,
        stdin: scriptedTtyInput('y\n'),
        stdout,
        stderr
      });

      expect(code).toBe(2);
      expect(JSON.parse(stdout.text())).toMatchObject({
        schemaVersion: 1,
        mode: 'check'
      });
      expect(stdout.text()).not.toContain('Apply these');
      expect(stderr.text()).toBe('');
      expect(await readFile(path.join(root, 'Dockerfile'), 'utf8')).toBe(previous);
    });

    it('applies standard API config drift interactively', async () => {
      const root = await standardFixtureProject();
      await editJson(path.join(root, 'liftoff.config.json'), (config) => {
        config.environments = ['dev', 'test'];
      });

      const result = await runInteractive(['update'], root, 'y\n');

      expect(result.code).toBe(0);
      expect(result.out).toContain('Update impact');
      await access(path.join(root, 'environments', 'test', 'backend.env'));
      expect((await run(['update'], root)).code).toBe(0);
    });

    it('shows the dirty-worktree warning before impact and consent', async () => {
      const root = await fixtureProject();
      const previous = '# previous template\n';
      await simulateManagedUpgrade(root, 'backend-dockerfile', ['Dockerfile'], previous);
      expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);

      const result = await runInteractive(['update'], root, 'n\n');

      expect(result.code).toBe(2);
      expect(result.out.indexOf('uncommitted changes')).toBeGreaterThan(-1);
      expect(result.out.indexOf('uncommitted changes'))
        .toBeLessThan(result.out.indexOf('Update impact'));
    });
  });

  it('rejects Power Apps workload and immutable starter identity edits before artifact access', async () => {
    const sourceRoot = await powerAppsFixtureProject();
    const appPath = path.join(sourceRoot, 'src', 'App.tsx');
    await rm(appPath);
    await mkdir(appPath);
    await editJson(path.join(sourceRoot, 'liftoff.manifest.json'), (manifest) => {
      manifest.project.workload.starter.commit = 'a'.repeat(40);
    });

    const sourceResult = await run(['update'], sourceRoot);
    expect(sourceResult.code).toBe(1);
    expect(sourceResult.err).toContain('recorded immutable source');
    expect(sourceResult.err).not.toContain('Unable to read src/App.tsx');

    const typeRoot = await powerAppsFixtureProject();
    await editJson(path.join(typeRoot, 'liftoff.config.json'), (config) => {
      config.projectType = 'standard';
      delete config.codeAppsPlugin;
      config.apiStack = 'node-fastify';
      config.cloud = 'azure';
      config.region = 'eastus';
      config.includeFrontend = false;
      config.environments = ['dev'];
    });
    const typeResult = await run(['update'], typeRoot);
    expect(typeResult.code).toBe(1);
    expect(typeResult.err).toContain('Project type changes');
  });

  it('reconciles the Power Apps plugin preference through guidance and manifest intent only', async () => {
    const root = await powerAppsFixtureProject();
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.codeAppsPlugin = true;
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toContain('README.md');
    expect(check.out).not.toContain('backend/');
    expect(check.out).not.toContain('infrastructure/');

    const apply = await runInteractive(['update'], root, 'y\n');
    expect(apply.code).toBe(0);
    const readme = await readFile(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('/plugin marketplace add microsoft/power-platform-skills');
    expect(readme).toContain('/plugin install code-apps-preview@power-platform-skills');
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.project.workload.codeAppsPlugin).toBe(true);
    await expect(access(path.join(root, 'backend'))).rejects.toThrow();
    await expect(access(path.join(root, 'infrastructure'))).rejects.toThrow();
    expect((await run(['update'], root)).code).toBe(0);
  });

  it('classifies Power Apps starter upgrade, missing, new, moved, and orphan states by logical name', async () => {
    const root = await powerAppsFixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const oldApp = '// simulated older starter App\n';
    await writeFile(path.join(root, 'src', 'App.tsx'), oldApp);
    await unlink(path.join(root, 'src', 'index.css'));
    await unlink(path.join(root, 'src', 'assets', 'react.svg'));
    const movedParts = ['legacy', 'main.tsx'];
    await mkdir(path.join(root, 'legacy'));
    await rename(path.join(root, 'src', 'main.tsx'), path.join(root, ...movedParts));
    const orphanContent = 'retired starter file\n';
    await writeFile(path.join(root, 'retired.txt'), orphanContent);
    await editJson(manifestPath, (manifest) => {
      manifest.artifacts.find(
        (entry: { logicalName: string }) => entry.logicalName === 'power-apps-starter-src-app-tsx'
      ).contentHash = sha(oldApp);
      manifest.artifacts = manifest.artifacts.filter(
        (entry: { logicalName: string }) =>
          entry.logicalName !== 'power-apps-starter-src-assets-react-svg'
      );
      manifest.artifacts.find(
        (entry: { logicalName: string }) => entry.logicalName === 'power-apps-starter-src-main-tsx'
      ).pathParts = movedParts;
      manifest.artifacts.push({
        logicalName: 'power-apps-retired-starter-file',
        category: 'power-apps-starter',
        pathParts: ['retired.txt'],
        contentHash: sha(orphanContent)
      });
    });

    const check = await run(['update', '--json'], root);
    expect(check.code).toBe(2);
    const report = JSON.parse(check.out);
    const states = new Map(
      report.entries.map((entry: { logicalName: string; status: string }) =>
        [entry.logicalName, entry.status]
      )
    );
    expect(states.get('power-apps-starter-src-app-tsx')).toBe('upgrade');
    expect(states.get('power-apps-starter-src-index-css')).toBe('missing');
    expect(states.get('power-apps-starter-src-assets-react-svg')).toBe('new');
    expect(states.get('power-apps-starter-src-main-tsx')).toBe('moved');
    expect(states.get('power-apps-retired-starter-file')).toBe('orphan');

    const apply = await runInteractive(['update'], root, 'y\n');
    expect(apply.code).toBe(0);
    expect(await readFile(path.join(root, 'src', 'App.tsx'), 'utf8')).not.toBe(oldApp);
    await access(path.join(root, 'src', 'index.css'));
    await access(path.join(root, 'src', 'assets', 'react.svg'));
    await access(path.join(root, 'src', 'main.tsx'));
    await expect(access(path.join(root, ...movedParts))).rejects.toThrow();
    await access(path.join(root, 'retired.txt'));
  });

  it('preserves Power Apps conflicts without force, replaces them with force, and retries after failure', async () => {
    const root = await powerAppsFixtureProject();
    const appPath = path.join(root, 'src', 'App.tsx');
    const localEdit = '// developer-owned App edit\n';
    await writeFile(appPath, localEdit);

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toMatch(/! src\/App\.tsx.*modified locally/);
    expect((await run(['update', '--apply'], root)).code).toBe(0);
    expect(await readFile(appPath, 'utf8')).toBe(localEdit);

    const forced = await run(['update', '--apply', '--force'], root);
    expect(forced.code).toBe(0);
    expect(await readFile(appPath, 'utf8')).not.toBe(localEdit);

    await unlink(path.join(root, 'src', 'index.css'));
    await mkdir(path.join(root, 'src', 'index.css'));
    const failed = await run(['update', '--apply'], root);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('Unable to read src/index.css');
    await rm(path.join(root, 'src', 'index.css'), { recursive: true });
    expect((await run(['update', '--apply'], root)).code).toBe(0);
    expect((await run(['update'], root)).code).toBe(0);
  });

  it('rejects --force without --apply', async () => {
    const root = await fixtureProject();
    const result = await run(['update', '--force'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--force requires --apply');
  });

  it('rejects framework integration drift instead of claiming uninitialized agents', async () => {
    const root = await fixtureProject();
    const configPath = path.join(root, 'liftoff.config.json');
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const before = await readFile(manifestPath, 'utf8');
    await editJson(configPath, (config) => {
      config.agents = ['copilot', 'claude'];
    });

    const result = await run(['update', '--apply'], root);

    expect(result.code).toBe(1);
    expect(result.err).toContain('official framework initialization');
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
    await expect(access(path.join(root, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconciles an added environment from config drift', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.environments = ['dev', 'test'];
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toContain('environments/test/backend.env');
    expect(check.out).not.toContain('! liftoff.config.json');

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    await access(path.join(root, 'environments', 'test', 'backend.env'));

    const recheck = await run(['update'], root);
    expect(recheck.code).toBe(0);

    const validate = await run(['validate', root], root);
    expect(validate.code).toBe(0);
  });

  it('reports removed environments as orphans and never deletes them', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.environments = ['dev', 'test'];
    });
    await run(['update', '--apply'], root);

    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.environments = ['dev'];
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toMatch(/- environments\/test\/backend\.env.*no longer generated/);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    await access(path.join(root, 'environments', 'test', 'backend.env'));

    const recheck = await run(['update'], root);
    expect(recheck.code).toBe(2);
    expect(recheck.out).toContain('orphan');
  });

  it('upgrades untouched files when the template changed and restores deleted files', async () => {
    const root = await fixtureProject();
    const dockerfilePath = path.join(root, 'Dockerfile');
    const simulatedOld = '# simulated older template rendering\n';
    await writeFile(dockerfilePath, simulatedOld, 'utf8');
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      const entry = manifest.artifacts.find((artifact: { logicalName: string }) => artifact.logicalName === 'backend-dockerfile');
      entry.contentHash = sha(simulatedOld);
    });
    await unlink(path.join(root, 'README.md'));

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toMatch(/~ Dockerfile.*untouched since generation/);
    expect(check.out).toMatch(/\+ README\.md.*restoring/);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    expect(await readFile(dockerfilePath, 'utf8')).not.toBe(simulatedOld);
    await access(path.join(root, 'README.md'));

    const recheck = await run(['update'], root);
    expect(recheck.code).toBe(0);
  });

  it('skips conflicts on apply, keeps flagging them, and overwrites with --force', async () => {
    const root = await fixtureProject();
    const readmePath = path.join(root, 'README.md');
    const localEdit = '# my local readme\n';
    await writeFile(readmePath, localEdit, 'utf8');

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toMatch(/! README\.md.*modified locally/);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    expect(apply.out).toContain('skipped README.md');
    expect(await readFile(readmePath, 'utf8')).toBe(localEdit);

    const recheck = await run(['update'], root);
    expect(recheck.code).toBe(2);
    expect(recheck.out).toContain('! README.md');

    const forced = await run(['update', '--apply', '--force'], root);
    expect(forced.code).toBe(0);
    expect(await readFile(readmePath, 'utf8')).not.toBe(localEdit);

    const clean = await run(['update'], root);
    expect(clean.code).toBe(0);
  });

  it('preserves an untracked destination for a newly generated artifact', async () => {
    const root = await fixtureProject();
    const readmePath = path.join(root, 'README.md');
    const userContent = '# user-owned destination\n';
    await writeFile(readmePath, userContent, 'utf8');
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (artifact: { logicalName: string }) => artifact.logicalName !== 'root-readme'
      );
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toMatch(/! README\.md.*not owned by the recorded state/);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    expect(apply.out).toContain('skipped README.md');
    expect(await readFile(readmePath, 'utf8')).toBe(userContent);
    const skippedManifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    expect(skippedManifest.artifacts.some(
      (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
    )).toBe(false);

    const forced = await run(['update', '--apply', '--force'], root);
    expect(forced.code).toBe(0);
    expect(await readFile(readmePath, 'utf8')).not.toBe(userContent);
  });

  it('adopts an unrecorded destination that already matches the current render', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      manifest.artifacts = manifest.artifacts.filter(
        (artifact: { logicalName: string }) => artifact.logicalName !== 'root-readme'
      );
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toContain('recorded state catches up');

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    expect(apply.out).not.toContain('wrote README.md');
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.artifacts.some(
      (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
    )).toBe(true);
    expect((await run(['update'], root)).code).toBe(0);
  });

  it('adds every newly tracked starter artifact to older manifests', async () => {
    const scenarios = [
      {
        root: await fixtureProject(),
        artifacts: [
          { logicalName: 'backend-test-messaging', pathParts: ['backend', 'tests', 'test_messaging.py'] },
          { logicalName: 'backend-test-tracing', pathParts: ['backend', 'tests', 'test_tracing.py'] },
          { logicalName: 'pattern-agent-test', pathParts: ['backend', 'tests', 'test_prompt_orchestration.py'] }
        ]
      },
      {
        root: await standardFixtureProject('go'),
        artifacts: [
          { logicalName: 'go-backend-checksums', pathParts: ['backend', 'go.sum'] }
        ]
      },
      {
        root: await createFixtureProject({
          projectName: 'Frontend Update App',
          projectType: 'standard',
          apiStack: 'node',
          cloud: 'azure',
          region: 'eastus',
          environments: ['dev'],
          specWorkflow: 'openspec',
          includeFrontend: true
        }),
        artifacts: [
          { logicalName: 'frontend-env-example', pathParts: ['frontend', '.env.example'] }
        ]
      }
    ];
    cleanups.push(path.dirname(scenarios[2]!.root));

    for (const scenario of scenarios) {
      const logicalNames = new Set(scenario.artifacts.map((artifact) => artifact.logicalName));
      await editJson(path.join(scenario.root, 'liftoff.manifest.json'), (manifest) => {
        manifest.artifacts = manifest.artifacts.filter(
          (artifact: { logicalName: string }) => !logicalNames.has(artifact.logicalName)
        );
      });
      for (const artifact of scenario.artifacts) {
        await unlink(path.join(scenario.root, ...artifact.pathParts));
      }

      const check = await run(['update'], scenario.root);
      expect(check.code).toBe(2);
      for (const artifact of scenario.artifacts) {
        expect(check.out).toContain(artifact.pathParts.join('/'));
      }

      const apply = await run(['update', '--apply'], scenario.root);
      expect(apply.code).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(scenario.root, 'liftoff.manifest.json'), 'utf8'));
      for (const artifact of scenario.artifacts) {
        expect(manifest.artifacts.some(
          (entry: { logicalName: string }) => entry.logicalName === artifact.logicalName
        )).toBe(true);
        await access(path.join(scenario.root, ...artifact.pathParts));
      }
      expect((await run(['update'], scenario.root)).code).toBe(0);
    }
  });

  it('moves cleanly relocated artifacts detected by logical name', async () => {
    const root = await fixtureProject();
    const oldParts = ['docker', 'Dockerfile'];
    await mkdir(path.join(root, 'docker'), { recursive: true });
    await rename(path.join(root, 'Dockerfile'), path.join(root, ...oldParts));
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      const entry = manifest.artifacts.find((artifact: { logicalName: string }) => artifact.logicalName === 'backend-dockerfile');
      entry.pathParts = oldParts;
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toContain('docker/Dockerfile => Dockerfile');

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    await access(path.join(root, 'Dockerfile'));
    await expect(access(path.join(root, 'docker', 'Dockerfile'))).rejects.toThrow();
  });

  it('preserves an occupied destination when a clean artifact is relocated', async () => {
    const root = await fixtureProject();
    const oldParts = ['legacy', 'README.md'];
    const oldPath = path.join(root, ...oldParts);
    const destinationPath = path.join(root, 'README.md');
    const userContent = '# user-owned destination\n';
    await mkdir(path.dirname(oldPath), { recursive: true });
    await rename(destinationPath, oldPath);
    await writeFile(destinationPath, userContent, 'utf8');
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      const entry = manifest.artifacts.find(
        (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
      );
      entry.pathParts = oldParts;
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);
    expect(check.out).toMatch(/! legacy\/README\.md => README\.md.*destination contains user-owned bytes/);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    expect(await readFile(destinationPath, 'utf8')).toBe(userContent);
    await access(oldPath);

    const forced = await run(['update', '--apply', '--force'], root);
    expect(forced.code).toBe(0);
    expect(await readFile(destinationPath, 'utf8')).not.toBe(userContent);
    await expect(access(oldPath)).rejects.toThrow();
  });

  it('preflights every destination before writing any new artifacts', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.includeFrontend = true;
    });
    await mkdir(path.join(root, 'frontend'));
    await writeFile(path.join(root, 'frontend', 'src'), 'blocks generated directory\n', 'utf8');
    const manifestBefore = await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8');

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(1);
    expect(apply.err).toContain('Artifact path parent is not a directory');
    expect(apply.out).not.toContain('Updated:');
    await expect(access(path.join(root, 'frontend', 'package.json'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe(manifestBefore);
  });

  it('reports filesystem failures and converges after the problem is corrected', async () => {
    const root = await fixtureProject();
    const readmePath = path.join(root, 'README.md');
    await unlink(readmePath);
    await mkdir(readmePath);
    const manifestBefore = await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8');

    const failed = await run(['update', '--apply'], root);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('Unable to read README.md');
    expect(failed.out).not.toContain('Updated:');
    expect(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')).toBe(manifestBefore);

    await rm(readmePath, { recursive: true });
    const retry = await run(['update', '--apply'], root);
    expect(retry.code).toBe(0);
    await access(readmePath);
    expect((await run(['update'], root)).code).toBe(0);
  });

  it('refreshes a stale manifest hash when disk already matches the template', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      const entry = manifest.artifacts.find((artifact: { logicalName: string }) => artifact.logicalName === 'backend-dockerfile');
      entry.contentHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    });

    const check = await run(['update'], root);
    expect(check.code).toBe(2);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);

    const recheck = await run(['update'], root);
    expect(recheck.code).toBe(0);
  });

  it('refuses pattern changes and points at migrate', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.pattern = 'chatbot';
    });

    const result = await run(['update'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('migration');
    expect(result.err).toContain('liftoff migrate');
  });

  it('refuses standard project-type and API-stack changes', async () => {
    const typeRoot = await standardFixtureProject();
    await editJson(path.join(typeRoot, 'liftoff.config.json'), (config) => {
      config.projectType = 'genai';
      config.apiStack = 'python-fastapi';
      config.pattern = 'prompt';
    });
    const typeResult = await run(['update'], typeRoot);
    expect(typeResult.code).toBe(1);
    expect(typeResult.err).toContain('Project type changes');
    expect(typeResult.err).toContain('liftoff migrate');

    const stackRoot = await standardFixtureProject();
    await editJson(path.join(stackRoot, 'liftoff.config.json'), (config) => {
      config.apiStack = 'go-huma';
    });
    const stackResult = await run(['update'], stackRoot);
    expect(stackResult.code).toBe(1);
    expect(stackResult.err).toContain('API stack changes');
    expect(stackResult.err).toContain('liftoff migrate');
  });

  it('upgrades schema-v3 manifests to schema v4 on apply', async () => {
    const root = await fixtureProject();
    await downgradeApiManifest(root, 3);
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const v3Manifest = await readFile(manifestPath, 'utf8');

    const check = await run(['update'], root);
    expect(check.code).toBe(0);
    expect(await readFile(manifestPath, 'utf8')).toBe(v3Manifest);

    const result = await run(['update', '--apply'], root);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    );
    expect(manifest).toMatchObject({
      artifactVersion: 4,
      project: {
        workload: { kind: 'genai', apiStack: 'python-fastapi' },
        agents: ['github-copilot']
      },
      framework: { state: 'initialized', adapter: 'openspec' }
    });
  });

  it('preserves legacy framework uncertainty without fabricating ownership during validate and update', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const configPath = path.join(root, 'liftoff.config.json');
    const frameworkMarker = path.join(root, '.github', 'skills', 'openspec-apply-change', 'SKILL.md');
    const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const recordedReadmeHash = originalManifest.artifacts.find(
      (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
    ).contentHash;
    const localReadme = '# developer-owned legacy README\n';
    await writeFile(path.join(root, 'README.md'), localReadme);
    await downgradeApiManifest(root, 2);
    await editJson(configPath, (config) => {
      delete config.agents;
      delete config.defaultAgent;
      config.environments = ['dev', 'test'];
    });
    await unlink(frameworkMarker);

    const before = await run(['validate'], root);
    expect(before.code).toBe(0);

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      artifactVersion: 4,
      project: {
        workload: { kind: 'genai', apiStack: 'python-fastapi' },
        agents: []
      },
      framework: { state: 'legacy', adapter: 'openspec' }
    });
    expect(manifest.artifacts.find(
      (artifact: { logicalName: string }) => artifact.logicalName === 'root-readme'
    ).contentHash).toBe(recordedReadmeHash);
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe(localReadme);
    await expect(access(frameworkMarker)).rejects.toMatchObject({ code: 'ENOENT' });

    const after = await run(['validate'], root);
    expect(after.code).toBe(0);
  });

  it('validates Spec Kit agent markers without allowing update to own or recreate them', async () => {
    const root = await createFixtureProject({
      projectName: 'Spec Kit Update App',
      projectType: 'standard',
      apiStack: 'node',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'spec-kit',
      agents: ['copilot', 'claude'],
      defaultAgent: 'copilot',
      includeFrontend: false
    });
    cleanups.push(path.dirname(root));
    const marker = path.join(root, '.claude', 'skills', 'speckit-specify', 'SKILL.md');
    await unlink(marker);

    const before = await run(['validate'], root);
    expect(before.code).toBe(1);
    expect(before.err).toContain('Missing framework marker');
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.environments = ['dev', 'test'];
    });

    const update = await run(['update', '--apply'], root);
    expect(update.code).toBe(0);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.artifacts.some((artifact: { pathParts: string[] }) =>
      artifact.pathParts.join('/') === '.claude/skills/speckit-specify/SKILL.md'
    )).toBe(false);

    const after = await run(['validate'], root);
    expect(after.code).toBe(1);
    expect(after.err).toContain('Missing framework marker');
  });

  it('refuses projects written by a newer CLI', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      manifest.liftoffVersion = '99.0.0';
    });

    const result = await run(['update'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('99.0.0');
    expect(result.err).toContain('Upgrade the CLI');
  });

  it('rejects unsupported manifest versions with the remedy', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      manifest.artifactVersion = 1;
    });

    const result = await run(['update'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Unsupported manifest artifactVersion 1');
  });

  it('discovers the project root from a subdirectory and honors explicit paths', async () => {
    const root = await fixtureProject();
    const fromSubdir = await run(['update'], path.join(root, 'backend', 'apis'));
    expect(fromSubdir.code).toBe(0);
    expect(fromSubdir.out).toContain('No drift');

    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'liftoff-elsewhere-'));
    cleanups.push(elsewhere);
    const explicit = await run(['update', root], elsewhere);
    expect(explicit.code).toBe(0);

    const nowhere = await run(['update'], elsewhere);
    expect(nowhere.code).toBe(1);
    expect(nowhere.err).toContain('No liftoff.manifest.json found');
  });

  it('emits versioned JSON reports in check mode', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.environments = ['dev', 'test'];
    });

    const result = await run(['update', '--json'], root);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out);
    expect(report.schemaVersion).toBe(1);
    expect(report.mode).toBe('check');
    expect(report.summary.new).toBeGreaterThan(0);
    expect(report.entries.some((entry: { path: string }) => entry.path === 'environments/test/backend.env')).toBe(true);
  });
});
