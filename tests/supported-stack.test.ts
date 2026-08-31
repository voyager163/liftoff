import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  containerIds,
  frameworkIds,
  generatedContainerPlatforms,
  githubActionIds,
  goModuleIds,
  npmProjectIds,
  opentofuProviderIds,
  packageManagerIds,
  parseSupportedStackBaseline,
  pythonProjectIds,
  runtimeIds,
  supportedHostPlatforms,
  upstreamIds,
  supportedStack
} from '../src/supported-stack.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { assertImmutableGeneratedContainerReferences } from '../src/container-validation.js';

const version = (
  value: string,
  releaseLine: string,
  channel: 'stable' | 'lts' = 'stable',
  minimumVersion?: string
) => ({
  version: value,
  ...(minimumVersion ? { minimumVersion } : {}),
  releaseLine,
  channel,
  source: 'https://example.test/releases'
});

function fixture(): Record<string, unknown> {
  const npmProject = (id: string) => ({
    manifestPathParts: ['assets', id, 'package.json'],
    lockPathParts: ['assets', id, 'package-lock.json'],
    freshnessPolicy: 'latest',
    requirements: {
      dependencies: { example: '^1.2.3' },
      devDependencies: {}
    },
    resolved: {
      dependencies: { example: '1.2.4' },
      devDependencies: {}
    }
  });
  return {
    schemaVersion: 1,
    id: '2026.08.31',
    verifiedOn: '2026-08-31',
    supportedHostPlatforms: [...supportedHostPlatforms],
    runtimes: Object.fromEntries(runtimeIds.map((id) => [id, version('1.2.3', '1')])),
    packageManagers: Object.fromEntries(
      packageManagerIds.map((id) => [id, version('1.2.3', '1')])
    ),
    frameworks: Object.fromEntries(frameworkIds.map((id) => [id, version('1.2.3', '1')])),
    npmProjects: Object.fromEntries(npmProjectIds.map((id) => [id, npmProject(id)])),
    pythonProjects: Object.fromEntries(pythonProjectIds.map((id) => [id, {
      lockTemplatePathParts: ['assets', id, 'uv.lock'],
      requiresPython: '>=3.14,<3.15',
      dependencies: { fastapi: '1.2.3' },
      optionalDependencies: { test: { pytest: '1.2.3' } }
    }])),
    goModules: Object.fromEntries(goModuleIds.map((id) => [id, {
      moduleTemplatePathParts: ['assets', id, 'go.mod'],
      goVersion: '1.27.0',
      dependencies: { 'example.test/module': '1.2.3' },
      tools: { 'example.test/tool': '1.2.3' }
    }])),
    opentofu: {
      version: version('1.12.6', '1.12'),
      lockPlatforms: ['darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_arm64', 'windows_amd64'],
      providers: Object.fromEntries(opentofuProviderIds.map((id) => [id, {
        source: `example/${id}`,
        version: '1.2.3'
      }]))
    },
    githubActions: Object.fromEntries(githubActionIds.map((id) => [id, {
      repository: `example/${id}`,
      ref: 'v1',
      commit: 'b'.repeat(40),
      source: 'https://example.test/actions'
    }])),
    containers: Object.fromEntries(containerIds.map((id) => [id, {
      image: `example/${id}`,
      tag: '1.2.3',
      digest: `sha256:${'a'.repeat(64)}`,
      platforms: [...generatedContainerPlatforms],
      source: 'https://example.test/images'
    }])),
    upstreams: Object.fromEntries(upstreamIds.map((id) => [id, {
      repository: 'https://example.test/repository',
      path: 'templates/starter',
      commit: 'a'.repeat(40),
      compatibleSourceCommits: ['a'.repeat(40), 'b'.repeat(40)],
      source: 'https://example.test/repository/commit'
    }]))
  };
}

describe('supported stack baseline', () => {
  it('parses the complete explicit inventory', () => {
    const baseline = parseSupportedStackBaseline(fixture());

    expect(Object.keys(baseline.runtimes)).toEqual(runtimeIds);
    expect(Object.keys(baseline.packageManagers)).toEqual(packageManagerIds);
    expect(Object.keys(baseline.frameworks)).toEqual(frameworkIds);
    expect(Object.keys(baseline.npmProjects)).toEqual(npmProjectIds);
    expect(Object.keys(baseline.pythonProjects)).toEqual(pythonProjectIds);
    expect(Object.keys(baseline.goModules)).toEqual(goModuleIds);
    expect(Object.keys(baseline.opentofu.providers)).toEqual(opentofuProviderIds);
    expect(Object.keys(baseline.githubActions)).toEqual(githubActionIds);
    expect(Object.keys(baseline.containers)).toEqual(containerIds);
    expect(Object.keys(baseline.upstreams)).toEqual(upstreamIds);
  });

  it('rejects missing, unknown, unstable, and unsafe values', () => {
    const cases: Array<[string, (value: any) => void, RegExp]> = [
      ['schema', (value) => { value.schemaVersion = 2; }, /schemaVersion/],
      ['unknown', (value) => { value.unexpected = true; }, /unsupported unexpected/],
      ['date', (value) => { value.verifiedOn = '2026-02-30'; }, /valid calendar date/],
      ['prerelease', (value) => { value.runtimes.node.version = '24.0.0-rc.1'; }, /stable semantic version/],
      ['path separator', (value) => {
        value.npmProjects.frontend.manifestPathParts = ['assets/frontend', 'package.json'];
      }, /safe portable path part/],
      ['latest image', (value) => { value.containers.redis.tag = 'latest'; }, /non-latest image/],
      ['digest', (value) => { value.containers.redis.digest = 'sha256:short'; }, /sha256 digest/],
      ['commit', (value) => { value.upstreams['power-apps-code-app'].commit = 'main'; }, /full lowercase Git commit SHA/],
      ['credential URL', (value) => {
        value.frameworks.openspec.source = 'https://token@example.test/releases';
      }, /credential-free HTTPS URL/],
      ['go prerelease', (value) => {
        value.goModules['go-backend'].dependencies['example.test/module'] = 'v1.2.3-rc.1';
      }, /stable Go module version/],
      ['selection mismatch', (value) => {
        value.npmProjects.frontend.selectionExceptions = {
          example: {
            selectedVersion: '9.9.9',
            reviewedCandidateVersion: '10.0.0',
            reason: 'Incompatible major.'
          }
        };
      }, /must match its resolved direct dependency/]
    ];

    for (const [, mutate, expected] of cases) {
      const value = fixture();
      mutate(value);
      expect(() => parseSupportedStackBaseline(value)).toThrow(expected);
    }
  });

  it('rejects duplicate or unsupported platforms', () => {
    const duplicate = fixture();
    duplicate.supportedHostPlatforms = ['linux/x64', 'linux/x64'];
    expect(() => parseSupportedStackBaseline(duplicate)).toThrow(/must not contain duplicates/);

    const unsupported = fixture();
    unsupported.containers.redis.platforms = ['windows/amd64'];
    expect(() => parseSupportedStackBaseline(unsupported)).toThrow(/unsupported/);
  });

  it('keeps inventory paths portable', () => {
    const baseline = parseSupportedStackBaseline(fixture());
    const parts = baseline.npmProjects.frontend.lockPathParts!;

    expect(path.posix.join('/repo', ...parts)).toBe('/repo/assets/frontend/package-lock.json');
    expect(path.win32.join('C:\\repo', ...parts)).toBe(
      'C:\\repo\\assets\\frontend\\package-lock.json'
    );
  });

  it('keeps workflow runtimes and action pins aligned with the baseline', () => {
    const workflows = [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/template-dependency-audit.yml',
      '.github/workflows/supported-stack-freshness.yml'
    ].map((file) => readFileSync(path.resolve(file), 'utf8')).join('\n');

    expect(workflows).toContain(`node-version: "${supportedStack.runtimes.node.version}"`);
    expect(workflows).toContain(`python-version: "${supportedStack.runtimes.python.version}"`);
    expect(workflows).toContain(`go-version: "${supportedStack.runtimes.go.version}"`);
    expect(workflows).toContain(`tofu_version: ${supportedStack.runtimes.opentofu.version}`);
    expect(workflows).toContain(
      `npm install --global "npm@${supportedStack.packageManagers.npm.version}"`
    );
    for (const action of Object.values(supportedStack.githubActions)) {
      expect(workflows).toContain(`uses: ${action.repository}@${action.commit} # ${action.ref}`);
    }
    expect(workflows).not.toMatch(/uses:\s+[^@\s]+@v\d+/);
  });

  it('keeps repository infrastructure and telemetry images aligned with the baseline', () => {
    const infrastructure = [
      readFileSync(path.resolve('infrastructure/opentofu/bootstrap/versions.tf'), 'utf8'),
      readFileSync(path.resolve('infrastructure/opentofu/telemetry/versions.tf'), 'utf8')
    ];
    for (const source of infrastructure) {
      for (const provider of Object.values(supportedStack.opentofu.providers)) {
        expect(source).toContain(`version = "${provider.version}"`);
      }
    }

    const telemetryDockerfile = readFileSync(
      path.resolve('services/telemetry-ingest/Dockerfile'),
      'utf8'
    );
    const telemetryImage = supportedStack.containers['telemetry-node'];
    expect(telemetryDockerfile.split(
      `${telemetryImage.image}:${telemetryImage.tag}@${telemetryImage.digest}`
    )).toHaveLength(3);
  });

  it('matches every explicit npm manifest and lock inventory entry', () => {
    for (const project of Object.values(supportedStack.npmProjects)) {
      const packageJson = JSON.parse(
        readFileSync(path.resolve(...project.manifestPathParts), 'utf8')
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const lock = JSON.parse(
        readFileSync(path.resolve(...project.lockPathParts!), 'utf8')
      ) as {
        packages: Record<string, { version?: string; resolved?: string }>;
      };
      expect(packageJson.dependencies ?? {}).toEqual(project.requirements.dependencies);
      expect(packageJson.devDependencies ?? {}).toEqual(project.requirements.devDependencies);
      for (const [name, version] of Object.entries({
        ...project.resolved.dependencies,
        ...project.resolved.devDependencies
      })) {
        expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
      }
      for (const entry of Object.values(lock.packages)) {
        if (entry.resolved) {
          expect(new URL(entry.resolved).host).toBe('registry.npmjs.org');
        }
      }
    }
    expect(
      supportedStack.npmProjects['power-apps-code-app']
        .selectionExceptions?.['@microsoft/power-apps']
    ).toMatchObject({
      selectedVersion: '1.2.7',
      reviewedCandidateVersion: '1.3.0'
    });
  });

  it('matches Python and Go dependency assets', () => {
    for (const [id, project] of Object.entries(supportedStack.pythonProjects)) {
      const lock = readFileSync(path.resolve(...project.lockTemplatePathParts), 'utf8');
      for (const [name, version] of Object.entries({
        ...project.dependencies,
        ...Object.assign({}, ...Object.values(project.optionalDependencies))
      })) {
        expect(lock, `${id}:${name}`).toContain(`name = "${name}"`);
        expect(lock, `${id}:${name}@${version}`).toContain(`version = "${version}"`);
      }
    }

    const goModule = supportedStack.goModules['go-backend'];
    const goMod = readFileSync(path.resolve(...goModule.moduleTemplatePathParts), 'utf8');
    expect(goMod).toContain(`go ${goModule.goVersion}`);
    for (const [name, version] of Object.entries(goModule.dependencies)) {
      expect(goMod).toContain(`${name} ${version}`);
    }
  });

  it('renders immutable container references for every generated stack', () => {
    const plans = [
      buildProjectPlan({
        projectName: 'GenAI Images',
        pattern: 'rag',
        cloud: 'azure',
        includeFrontend: true
      }, { requireProjectName: true }),
      ...(['python', 'node', 'go'] as const).map((apiStack) =>
        buildProjectPlan({
          projectName: `${apiStack} images`,
          projectType: 'standard',
          apiStack,
          cloud: 'azure',
          includeFrontend: true
        }, { requireProjectName: true })
      )
    ];

    for (const plan of plans) {
      const artifacts = buildArtifacts(plan);
      for (const artifact of artifacts.filter((candidate) =>
        candidate.pathParts.at(-1) === 'Dockerfile' ||
        candidate.pathParts.at(-1) === 'docker-compose.yml'
      )) {
        const references = artifact.content.matchAll(
          /^\s*(?:FROM|image:)\s+(\S+)/gm
        );
        for (const match of references) {
          expect(match[1], artifact.pathParts.join('/')).toMatch(
            /:[^@\s]+@sha256:[0-9a-f]{64}$/
          );
        }
        expect(artifact.content).not.toMatch(/:latest(?:\s|$)/m);
      }
    }
  });

  it('rejects mutable and vacuous generated container artifacts', () => {
    expect(() => assertImmutableGeneratedContainerReferences([{
      logicalName: 'backend-dockerfile',
      category: 'runtime',
      pathParts: ['Dockerfile'],
      content: 'FROM node:24-alpine\n'
    }])).toThrow(/mutable image reference/);
    expect(() => assertImmutableGeneratedContainerReferences([{
      logicalName: 'docker-compose',
      category: 'local-development',
      pathParts: ['docker-compose.yml'],
      content: 'services: {}\n'
    }])).toThrow(/contains no image reference/);
  });
});
