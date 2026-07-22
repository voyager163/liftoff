import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
import { compareSemver } from '../src/semver.js';
import { CaptureStream } from './helpers.js';

const sha = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function fixtureProject(): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Update App',
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

async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), { cwd, stdout, stderr });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function editJson(filePath: string, mutate: (value: any) => void): Promise<void> {
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  mutate(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

  it('rejects --force without --apply', async () => {
    const root = await fixtureProject();
    const result = await run(['update', '--force'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--force requires --apply');
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

  it('normalizes legacy GenAI identity during update', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      delete manifest.project.projectType;
      delete manifest.project.apiStack;
    });
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      delete config.projectType;
      delete config.apiStack;
    });

    const result = await run(['update'], root);
    expect(result.code).toBe(0);
    expect(result.out).toContain('No drift');
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
