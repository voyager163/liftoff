import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { parseProjectManifest, resolveModernManifestV8SourceContract } from '../src/application/project/manifest.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import type { GeneratedArtifact, ProjectOptions } from '../src/domain/project/contracts.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { createModernGovernanceContextContract } from '../src/domain/governance/policy/modern-context.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { bindApplicationArtifactContext } from '../src/governance-activation/application-artifact-context.js';
import {
  applicationArtifactContextStep, applicationContextBounds, applicationContextPaths
} from '../src/governance-activation/application-artifact-context-recipe.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const workloads: ProjectOptions[] = [
  { projectType: 'standard', apiStack: 'python-fastapi' },
  { projectType: 'standard', apiStack: 'node-fastify' },
  { projectType: 'standard', apiStack: 'go-huma' },
  ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
];
function generated(workload: ProjectOptions, governanceProfile = 'single-maintainer-gitflow') {
  const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
    projectName: 'Actual Artifact', ...workload, governanceProfile, cloud: 'azure', region: 'eastus',
    environments: ['dev'], includeFrontend: false, specWorkflow: 'manual', agents: []
  }, { requireProjectName: true }));
  const manifest = parseProjectManifest(JSON.parse(artifacts.find(file => file.logicalName === 'manifest')!.content));
  const files = artifacts.filter(file => file.logicalName === 'backend-dockerfile' ||
    file.logicalName === 'root-dockerignore' || ['backend', 'database'].includes(file.pathParts[0]!));
  return { manifest, files, paths: files.map(file => file.pathParts.join('/')),
    readme: artifacts.find(file => file.logicalName === 'root-readme')!.content };
}
async function prepare(files: readonly GeneratedArtifact[]) {
  const allocation = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-artifact-context-')));
  roots.push(allocation);
  const project = path.join(allocation, 'project with spaces'), temporary = path.join(allocation, 'runner temporary');
  await mkdir(project); await mkdir(temporary);
  const runner = new NodeCommandRunner(), config = path.join(allocation, 'empty.gitconfig');
  await writeFile(config, '');
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0' };
  for (const file of files) {
    const target = path.join(project, ...file.pathParts);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  for (const args of [['init', '--initial-branch=develop'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Actual source']]) {
    const result = await runner.run({ executable: 'git', args }, { cwd: project, env });
    expect(result.status, result.stderr).toBe(0);
  }
  const sha = (await runner.run({ executable: 'git', args: ['rev-parse', 'HEAD'] }, { cwd: project, env })).stdout.trim();
  async function projectFiles(paths: readonly string[], sourceSha = sha, outputPath?: string) {
    const step = applicationArtifactContextStep(paths);
    const prefix = "node --input-type=module <<'LIFTOFF_APPLICATION_CONTEXT'\n";
    expect(step.run.startsWith(prefix)).toBe(true);
    expect(step.run.endsWith('\nLIFTOFF_APPLICATION_CONTEXT')).toBe(true);
    const program = step.run.slice(prefix.length, -'\nLIFTOFF_APPLICATION_CONTEXT'.length);
    const executable = path.join(allocation, 'projection.mjs'), output = outputPath ?? path.join(temporary, 'workflow-output');
    await writeFile(executable, program);
    if (outputPath === undefined) await writeFile(output, '');
    const result = await runner.run({ executable: process.execPath, args: [executable] }, {
      cwd: project, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, stream: false,
      env: { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        LIFTOFF_SOURCE_SHA: sourceSha, LIFTOFF_CONTEXT_PATHS: step.env.LIFTOFF_CONTEXT_PATHS,
        RUNNER_TEMP: temporary, GITHUB_OUTPUT: output }
    });
    const published = await readFile(output, 'utf8');
    return { result, directory: published.startsWith('path=') ? published.slice(5).trim() : null };
  }
  return { allocation, project, temporary, runner, env, sha, projectFiles };
}
async function inventory(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(root, relative));
    else files.push(relative);
  }
  return files.sort();
}

describe('manifest-bound exact application context', () => {
  it('preserves expression-like literal filenames through source, serialized workflow and actual Git-blob projection', async () => {
    const filename = '${{ github.run_id }}.ts';
    const paths = [`backend/${filename}`];
    const step = applicationArtifactContextStep(paths);
    expect(step.env.LIFTOFF_CONTEXT_PATHS).not.toContain('${{');
    expect(JSON.parse(step.env.LIFTOFF_CONTEXT_PATHS)).toEqual(paths);
    const serialized = stringify(step);
    expect(serialized).not.toContain('${{ github.run_id }}');
    const decoded: unknown = parse(serialized);
    if (!isRecord(decoded) || !isRecord(decoded.env)) throw new Error('Expected exact serialized step environment.');
    expect(decoded.env.LIFTOFF_CONTEXT_PATHS).toBe(step.env.LIFTOFF_CONTEXT_PATHS);
    const file = { logicalName: 'expression-like-literal', category: 'runtime', pathParts: ['backend', filename],
      content: 'exact reviewed literal source\n', lifecycle: 'project' as const, provisioningGroup: 'base' as const };
    const f = await prepare([file]);
    const { result, directory } = await f.projectFiles(paths);
    expect(result.status, result.stderr).toBe(0);
    expect(await inventory(directory!)).toEqual(paths);
    expect(await readFile(path.join(directory!, ...file.pathParts), 'utf8')).toBe(file.content);
  });
  for (const profile of ['single-maintainer-gitflow', 'team-gitflow']) {
    it.each(workloads)(`projects the actual generated Dockerfile and source for ${profile} %j`, async workload => {
      const source = generated(workload, profile);
      const binding = bindApplicationArtifactContext(source.manifest, source.paths, 'Dockerfile');
      expect(binding).toEqual({ contextPaths: [...source.paths].sort(), sourceManifestDigest: canonicalSha256(source.manifest) });
      const f = await prepare(source.files);
      const { result, directory } = await f.projectFiles(binding.contextPaths);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(directory).not.toBeNull();
      expect(await inventory(directory!)).toEqual([...source.paths].sort());
      for (const file of source.files) {
        expect(await readFile(path.join(directory!, ...file.pathParts), 'utf8')).toBe(file.content);
        if (process.platform !== 'win32') expect((await lstat(path.join(directory!, ...file.pathParts))).mode & 0o777).toBe(0o644);
      }
      const dockerfile = await readFile(path.join(directory!, 'Dockerfile'), 'utf8');
      expect(dockerfile).toContain('COPY backend');
      expect(dockerfile).toContain('COPY database');
      expect(source.manifest.governance.profile).toBe(profile);
      expect(source.readme).toContain('exact manifest-bound inventory');
      expect(source.readme).toContain('`.dockerignore` alone is not source-transmission authority');
    });
  }
  it.each([
    [], ['.'], ['../secret'], ['/tmp/private'], ['backend/.env'], ['backend/.env.example'],
    ['backend/state/owned.tfstate'], ['.liftoff/evidence/receipt.json'], ['governance/evidence/private.json'],
    ['.github/workflows/publish.yml'], ['openspec/changes/private.md'], ['liftoff.manifest.json'],
    ['backend/main.ts', 'BACKEND/main.ts'], ['backend', 'backend/main.ts'], ['backend/credentials.json'],
    ['backend/ß.ts', 'backend/ss.ts']
  ].map(paths => ({ paths })))('refuses invalid or sensitive positive inventory $paths', ({ paths }) => {
    expect(() => applicationContextPaths(paths)).toThrow();
  });
  it('rejects unbound files and does not treat generation history as current path authority', () => {
    const source = generated(workloads[0]!);
    expect(() => bindApplicationArtifactContext(source.manifest, ['Dockerfile', 'unbound/custom.py'], 'Dockerfile')).toThrow(/layout/);
    expect(() => bindApplicationArtifactContext(source.manifest, source.paths, 'backend/Dockerfile')).toThrow(/layout/);
    if (source.manifest.artifactVersion !== 8) throw new Error('Expected current source.');
    const unresolved = { ...source.manifest, activeLayout: { schemaVersion: 1 as const, state: 'unresolved' as const, bindings: [] as const } };
    expect(() => bindApplicationArtifactContext(unresolved, source.paths, 'Dockerfile')).toThrow();
  });
  it('uses actual current relocated component/artifact bindings rather than frozen generation paths', () => {
    const source = generated(workloads[0]!);
    if (source.manifest.artifactVersion !== 8) throw new Error('Expected current source.');
    function relocated(parts: readonly string[]): string[] {
      if (parts[0] === 'backend') return ['services', 'api', ...parts.slice(1)];
      if (parts[0] === 'database') return ['application-data', ...parts.slice(1)];
      if (parts.join('/') === 'Dockerfile') return ['containers', 'Dockerfile'];
      return [...parts];
    }
    const activeLayout = { ...source.manifest.activeLayout,
      bindings: source.manifest.activeLayout.bindings.map(binding => ({ ...binding, pathParts: relocated(binding.pathParts) })) };
    const context = createModernGovernanceContextContract({
      catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract
    }).buildModernGovernanceContext({
      selection: { project: source.manifest.project, framework: source.manifest.framework, profile: source.manifest.governance.profile },
      plugins: source.manifest.plugins, activeLayout
    });
    const current = parseProjectManifest({ ...source.manifest, activeLayout,
      governance: { ...source.manifest.governance, activationIdentity: context.governance.activationIdentity } });
    const paths = source.files.map(file => relocated(file.pathParts).join('/'));
    expect(bindApplicationArtifactContext(current, paths, 'containers/Dockerfile')).toEqual({
      contextPaths: [...paths].sort(), sourceManifestDigest: canonicalSha256(current)
    });
    expect(() => bindApplicationArtifactContext(current, source.paths, 'Dockerfile')).toThrow(/layout/);
    expect(current.projectArtifacts).toEqual(source.manifest.projectArtifacts);
  });
  it('accepts exactly the file-count bound and refuses excess, sparse or decorated inventories', () => {
    const paths = Array.from({ length: applicationContextBounds.files }, (_, index) => `backend/file-${index}.ts`);
    expect(applicationContextPaths(paths)).toHaveLength(applicationContextBounds.files);
    expect(() => applicationContextPaths([...paths, 'backend/excess.ts'])).toThrow();
    expect(() => applicationContextPaths(new Array<string>(2))).toThrow();
    expect(() => applicationContextPaths(Object.assign(['backend/main.ts'], { extra: 'private' }))).toThrow();
  });
  it.each([8, 9])('enforces the exact per-file and aggregate byte bounds for %i one-MiB files', async count => {
    const files = Array.from({ length: count }, (_, index) => ({
      logicalName: `source-${index}`, category: 'runtime', pathParts: ['backend', `file-${index}.txt`],
      content: 'x'.repeat(applicationContextBounds.fileBytes), lifecycle: 'project' as const, provisioningGroup: 'base' as const
    }));
    expect(applicationContextBounds.totalBytes).toBe(8 * applicationContextBounds.fileBytes);
    const f = await prepare(files);
    const { result, directory } = await f.projectFiles(files.map(file => file.pathParts.join('/')));
    if (count === 8) {
      expect(result.status, result.stderr).toBe(0);
      expect(await inventory(directory!)).toHaveLength(8);
      for (const file of files) expect(await readFile(path.join(directory!, ...file.pathParts), 'utf8')).toBe(file.content);
    } else {
      expect(result.status).not.toBe(0);
      expect(directory).toBeNull();
      expect((await readdir(f.temporary)).filter(entry => entry.startsWith('liftoff-application-context-'))).toEqual([]);
    }
  });
  it.each(['outside', 'linked-parent'] as const)('refuses a %s workflow-output boundary without publishing a context', async kind => {
    const source = generated(workloads[0]!);
    const f = await prepare(source.files);
    const outside = path.join(f.allocation, 'outside');
    await mkdir(outside);
    const output = path.join(outside, 'workflow-output');
    await writeFile(output, '');
    const link = path.join(f.temporary, 'linked-output');
    if (kind === 'linked-parent') await symlink(outside, link, 'junction');
    const { result, directory } = await f.projectFiles(source.paths, f.sha,
      kind === 'outside' ? output : path.join(link, 'workflow-output'));
    expect(result.status).not.toBe(0);
    expect(directory).toBeNull();
    expect(await readFile(output, 'utf8')).toBe('');
    expect((await readdir(f.temporary)).filter(entry => entry.startsWith('liftoff-application-context-'))).toEqual([]);
  });
  it('reads raw original Git blobs and modes without attributes, worktree edits or private unselected files', async () => {
    const executable = { logicalName: 'custom', category: 'runtime', pathParts: ['backend', 'custom.sh'],
      content: "printf '%s\\n' '$Format:%H$'\n", lifecycle: 'project' as const, provisioningGroup: 'base' as const };
    const files = [executable,
      { ...executable, pathParts: ['.gitattributes'], content: 'backend/custom.sh export-subst\n' },
      { ...executable, pathParts: ['backend', '.env'], content: 'PRIVATE_FIXTURE_ONLY\n' },
      { ...executable, pathParts: ['.liftoff', 'state', 'private.tfstate'], content: 'PRIVATE_STATE_FIXTURE_ONLY\n' }];
    const f = await prepare(files);
    await chmod(path.join(f.project, 'backend', 'custom.sh'), 0o755);
    expect((await f.runner.run({ executable: 'git', args: ['add', 'backend/custom.sh'] }, { cwd: f.project, env: f.env })).status).toBe(0);
    expect((await f.runner.run({ executable: 'git',
      args: ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Exact executable mode'] },
    { cwd: f.project, env: f.env })).status).toBe(0);
    const sha = (await f.runner.run({ executable: 'git', args: ['rev-parse', 'HEAD'] }, { cwd: f.project, env: f.env })).stdout.trim();
    await writeFile(path.join(f.project, 'backend', 'custom.sh'), 'PRESERVED_WORKTREE_CUSTOMIZATION\n');
    await writeFile(path.join(f.project, 'backend', 'untracked.key'), 'PRIVATE_UNTRACKED_FIXTURE_ONLY\n');
    const { result, directory } = await f.projectFiles(['backend/custom.sh'], sha);
    expect(result.status, result.stderr).toBe(0);
    expect(await inventory(directory!)).toEqual(['backend/custom.sh']);
    expect(await readFile(path.join(directory!, 'backend', 'custom.sh'), 'utf8')).toBe(executable.content);
    if (process.platform !== 'win32') expect((await lstat(path.join(directory!, 'backend', 'custom.sh'))).mode & 0o777).toBe(0o755);
    expect(await readFile(path.join(f.project, 'backend', 'custom.sh'), 'utf8')).toBe('PRESERVED_WORKTREE_CUSTOMIZATION\n');
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_');
  });
  it.each(['absent', 'directory', 'symlink', 'oversized', 'wrong-source'] as const)(
    'fails before context publication for an actual %s Git source', async kind => {
      const file = { logicalName: 'source', category: 'runtime', pathParts: ['backend', 'main.ts'],
        content: kind === 'oversized' ? 'x'.repeat(applicationContextBounds.fileBytes + 1) : 'original\n',
        lifecycle: 'project' as const, provisioningGroup: 'base' as const };
      const f = await prepare([file]);
      let sha = f.sha;
      if (kind === 'symlink') {
        await symlink('main.ts', path.join(f.project, 'backend', 'link.ts'));
        expect((await f.runner.run({ executable: 'git', args: ['add', '.'] }, { cwd: f.project, env: f.env })).status).toBe(0);
        expect((await f.runner.run({ executable: 'git',
          args: ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Unsupported link'] },
        { cwd: f.project, env: f.env })).status).toBe(0);
        sha = (await f.runner.run({ executable: 'git', args: ['rev-parse', 'HEAD'] }, { cwd: f.project, env: f.env })).stdout.trim();
      }
      const selected = kind === 'absent' ? 'backend/absent.ts' : kind === 'directory' ? 'backend' :
        kind === 'symlink' ? 'backend/link.ts' : 'backend/main.ts';
      const { result, directory } = await f.projectFiles([selected], kind === 'wrong-source' ? 'a'.repeat(40) : sha);
      expect(result.status).not.toBe(0);
      expect(directory).toBeNull();
      expect((await readdir(f.temporary)).filter(entry => entry.startsWith('liftoff-application-context-'))).toEqual([]);
      expect(createHash('sha256').update(await readFile(path.join(f.project, 'backend', 'main.ts'))).digest('hex'))
        .toBe(createHash('sha256').update(file.content).digest('hex'));
    }
  );
});
