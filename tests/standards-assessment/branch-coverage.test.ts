import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectCaseCollision,
  findGitRoot,
  resolveAssessmentTarget
} from '../../src/adapters/filesystem/standards-assessment/boundary.js';
import { captureInputsFile } from '../../src/adapters/filesystem/standards-assessment/inputs.js';
import { InputsError } from '../../src/adapters/filesystem/standards-assessment/errors.js';
import { scanInventory } from '../../src/adapters/filesystem/standards-assessment/scanner.js';
import { extractEvidence, detectProjectFramework } from '../../src/adapters/filesystem/standards-assessment/evidence.js';
import { resolveTargetProfile } from '../../src/application/standards-assessment/profile-resolver.js';
import { generateRecommendations } from '../../src/application/standards-assessment/recommendations.js';
import { assessProject } from '../../src/application/standards-assessment/runner.js';
import { listSupportedProfiles } from '../../src/domain/standards-assessment/catalog.js';
import { loadPackagedProfilesCatalog } from '../../src/adapters/packaged-assets/resource-catalog.js';
import type { AssessmentFinding, AssessmentTarget } from '../../src/domain/standards-assessment/types.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.branch-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('standards assessment branch coverage targets', () => {
  it('covers boundary path resolution with componentPath and stopAt', async () => {
    const dir = createFixtureDir('boundary-branches');
    const comp = path.join(dir, 'sub');
    await mkdir(comp, { recursive: true });

    // Component resolution
    const target = await resolveAssessmentTarget({
      targetPath: dir,
      componentPath: 'sub'
    });
    expect(target.componentPath).toBe('sub');
    expect(target.scanRoot).toBe(comp);

    // Absolute component path -> BoundaryError
    await expect(
      resolveAssessmentTarget({ targetPath: dir, componentPath: '/absolute/sub' })
    ).rejects.toThrow(/must be relative/);

    // findGitRoot stopAt
    const root = await findGitRoot(comp, dir);
    expect(root).toBeNull();
  });

  it('covers inputs error branches for directory target and relative paths', async () => {
    const dir = createFixtureDir('inputs-branches');
    const subDir = path.join(dir, 'a-dir');
    await mkdir(subDir, { recursive: true });

    // Directory as inputs file -> InputsError
    await expect(captureInputsFile('a-dir', dir)).rejects.toThrow(InputsError);
    await expect(captureInputsFile('a-dir', dir)).rejects.toThrow(/must be a bounded regular file/);
  });

  it('does not infer lock integrity from minimal pnpm and poetry marker files', async () => {
    const dir = createFixtureDir('lock-types');
    await mkdir(dir, { recursive: true });

    await writeFile(path.join(dir, 'package.json'), '{"name":"pnpm-app"}');
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 5.4');
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "py-app"');
    await writeFile(path.join(dir, 'poetry.lock'), 'package = []');

    const inventory = await scanInventory(dir);
    const target = {
      targetPath: dir,
      projectRoot: dir,
      repositoryRoot: null,
      componentPath: null,
      scanRoot: dir,
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };
    const evidence = extractEvidence(target, inventory);
    expect(evidence.dependencies?.matching).toBe(false);
    expect(evidence.dependencies?.components?.every((entry) => entry.integrityVerified === false)).toBe(true);
  });

  it('covers route patterns for Chi r.Get, FastAPI @router.get, and Fastify app.route', async () => {
    const dir = createFixtureDir('route-patterns');
    await mkdir(dir, { recursive: true });

    await writeFile(path.join(dir, 'go.mod'), 'module demo\ngo 1.27\nrequire github.com/danielgtaylor/huma/v2 v2.28.0\n');
    await writeFile(path.join(dir, 'go.sum'), 'demo 1.0.0\n');
    await writeFile(
      path.join(dir, 'main.go'),
      `package main
import (
  "context"
  "net/http"
  "github.com/go-chi/chi/v5"
  "github.com/danielgtaylor/huma/v2"
  "github.com/danielgtaylor/huma/v2/adapters/humachi"
)
func main() {
  r := chi.NewRouter()
  api := humachi.New(r, huma.DefaultConfig("Example", "1.0.0"))
  r.Get("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
  huma.Register(api, huma.Operation{OperationID: "example-schema", Method: "GET", Path: "/openapi.json"},
    func(ctx context.Context, input *struct{}) (*struct{}, error) { return &struct{}{}, nil })
}`
    );

    const inventory = await scanInventory(dir);
    const target = {
      targetPath: dir,
      projectRoot: dir,
      repositoryRoot: null,
      componentPath: null,
      scanRoot: dir,
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };
    const evidence = extractEvidence(target, inventory);
    expect(evidence.endpoints?.healthRoutes.length).toBeGreaterThan(0);
    expect(evidence.endpoints?.docsRoutes.length).toBeGreaterThan(0);
  });

  it('covers profile-resolver with compatible and incompatible targets for each stack', async () => {
    const dir = createFixtureDir('resolver-branches');
    await mkdir(dir, { recursive: true });

    // 1. Python GenAI project
    await writeFile(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = ["fastapi>=0.115.0", "pydantic-ai>=0.0.18"]\n'
    );
    await writeFile(
      path.join(dir, 'main.py'),
      'from fastapi import FastAPI\nfrom pydantic_ai import Agent\napp = FastAPI()\nagent = Agent("provider:model")\n@app.post("/api/ai/run")\nasync def invoke(): return await agent.run("request")\n'
    );

    const inventory = await scanInventory(dir);
    const target = {
      targetPath: dir,
      projectRoot: dir,
      repositoryRoot: null,
      componentPath: null,
      scanRoot: dir,
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };

    // Auto-detect GenAI
    const autoGenAi = resolveTargetProfile(target, inventory);
    expect(autoGenAi.profile.id).toBe('genai-generic');

    // Explicit compatible target
    const explicitGenAi = resolveTargetProfile(target, inventory, 'genai-generic');
    expect(explicitGenAi.profile.id).toBe('genai-generic');

    // Explicit incompatible target (Go Huma requested on Python code)
    const incompat = resolveTargetProfile(target, inventory, 'go-huma');
    expect(incompat.diagnostics.some((d) => d.code === 'INCOMPATIBLE_PROFILE_TARGET')).toBe(true);

    // 2. Go Huma compatible target
    const dirGo = createFixtureDir('go-compatible');
    await mkdir(dirGo, { recursive: true });
    await writeFile(path.join(dirGo, 'go.mod'), 'module demo\ngo 1.27\nrequire github.com/danielgtaylor/huma/v2 v2.28.0\n');
    await writeFile(path.join(dirGo, 'main.go'), 'package main\nimport "github.com/danielgtaylor/huma/v2"\nfunc main(){huma.Register(nil, huma.Operation{}, nil)}\n');
    const invGo = await scanInventory(dirGo);
    const targetGo = { targetPath: dirGo, projectRoot: dirGo, repositoryRoot: null, componentPath: null, scanRoot: dirGo, hasGit: false, hasManifest: false, manifestVersion: null };
    const goResult = resolveTargetProfile(targetGo, invGo, 'go-huma');
    expect(goResult.profile.id).toBe('go-huma');

    // 3. Vue compatible target
    const dirVue = createFixtureDir('vue-compatible');
    await mkdir(dirVue, { recursive: true });
    await writeFile(path.join(dirVue, 'package.json'), '{"name":"vue-app","dependencies":{"vue":"^3.0.0"}}');
    await writeFile(path.join(dirVue, 'App.vue'), '<template></template>');
    const invVue = await scanInventory(dirVue);
    const targetVue = { targetPath: dirVue, projectRoot: dirVue, repositoryRoot: null, componentPath: null, scanRoot: dirVue, hasGit: false, hasManifest: false, manifestVersion: null };
    const vueResult = resolveTargetProfile(targetVue, invVue, 'vue');
    expect(vueResult.profile.id).toBe('vue-component');
  });

  it('covers recommendation filtering when sensitive content is detected in recommendation', () => {
    const profile = listSupportedProfiles(loadPackagedProfilesCatalog())[0];
    const target: any = {
      targetPath: '/test',
      projectRoot: '/test',
      repositoryRoot: null,
      componentPath: null,
      scanRoot: '/test',
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };

    const diagnostics: any[] = [];
    const recs = generateRecommendations({
      target,
      profile,
      observedProfiles: [profile],
      findings: [],
      inputsReference: '/path/to/ghp_123456789012345678901234567890_token.json',
      inputsDigest: 'sha256:123',
      diagnostics
    });

    // The recommendation containing ghp_ token in inputsReference must be withheld with a diagnostic!
    expect(diagnostics.some((d) => d.code === 'RECOMMENDATION_PAYLOAD_PROTECTED')).toBe(true);
  });

  it('covers timeout and byte limits in scanner', async () => {
    const dir = createFixtureDir('scanner-limits');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'file1.txt'), 'content 1');
    await writeFile(path.join(dir, 'file2.txt'), 'content 2');

    // Very small maxScanBytes
    const byteLimited = await scanInventory(dir, { maxScanBytes: 5 });
    expect(byteLimited.unobserved.some((u) => u.reason === 'size_limit_exceeded')).toBe(true);

    // Very small timeout
    const timeLimited = await scanInventory(dir, { scanTimeoutMs: 0 });
    expect(timeLimited.unobserved.some((u) => u.reason === 'time_limit_exceeded')).toBe(true);
  });

  it('covers containers, frameworks, and infrastructure evidence branches', async () => {
    const dir = createFixtureDir('container-framework-infra');
    await mkdir(path.join(dir, 'openspec'), { recursive: true });
    await mkdir(path.join(dir, '.specify'), { recursive: true });
    await mkdir(path.join(dir, 'infrastructure', 'opentofu'), { recursive: true });

    await writeFile(path.join(dir, 'Dockerfile'), 'FROM node:24\n');
    await writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
    await writeFile(path.join(dir, 'openspec', 'config.yaml'), 'version: 1\n');
    await writeFile(path.join(dir, '.specify', 'init-options.json'), '{}');
    await writeFile(path.join(dir, 'infrastructure', 'opentofu', 'main.tf'), 'terraform {}');
    await writeFile(path.join(dir, 'extra.tf'), 'variable "env" {}');

    const inventory = await scanInventory(dir);
    const target = {
      targetPath: dir,
      projectRoot: dir,
      repositoryRoot: null,
      componentPath: null,
      scanRoot: dir,
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };
    const evidence = extractEvidence(target, inventory);

    expect(evidence.containers?.dockerfile).toBeDefined();
    expect(evidence.containers?.compose).toBeDefined();
    expect(evidence.frameworks?.openspec).toBeDefined();
    expect(evidence.frameworks?.specKit).toBeDefined();
    expect(evidence.infrastructure?.opentofu).toBeUndefined();
    expect(evidence.infrastructure?.terraformFiles.length).toBeGreaterThan(0);
  });

  it('covers assessProject with valid inputsPath and componentPath', async () => {
    const dir = createFixtureDir('assess-with-valid-inputs');
    const backend = path.join(dir, 'backend');
    await mkdir(backend, { recursive: true });
    await writeFile(path.join(backend, 'package.json'), '{"name":"app","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(backend, 'package-lock.json'), '{"name":"app","lockfileVersion":3}');
    await writeFile(path.join(backend, 'server.ts'), 'import fastify from "fastify"; const app = fastify();');
    await writeFile(path.join(dir, 'inputs.json'), '{"environment":"staging"}');

    const result = await assessProject({
      projectRoot: dir,
      componentPath: 'backend',
      inputsPath: path.join(dir, 'inputs.json'),
      invocationCwd: dir
    });

    expect(result.capturedInputs).toBeDefined();
    expect(result.capturedInputs?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.target.componentPath).toBe('backend');
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('covers Django detection and Go same-component lock matching', async () => {
    // Django detection
    const dirDj = createFixtureDir('django-cov');
    await mkdir(dirDj, { recursive: true });
    await writeFile(path.join(dirDj, 'pyproject.toml'), '[project]\nname="dj"\ndependencies=["django>=5.0"]');
    await writeFile(path.join(dirDj, 'asgi.py'), 'from django.core.asgi import get_asgi_application\napplication = get_asgi_application()\n');
    const invDj = await scanInventory(dirDj);
    const targetDj = { targetPath: dirDj, projectRoot: dirDj, repositoryRoot: null, componentPath: null, scanRoot: dirDj, hasGit: false, hasManifest: false, manifestVersion: null };
    const resDj = resolveTargetProfile(targetDj, invDj);
    expect(resDj.profile.id).toBe('django');

    // Go same-component lock matching
    const dirGo = createFixtureDir('go-lock-match');
    await mkdir(dirGo, { recursive: true });
    await writeFile(path.join(dirGo, 'go.mod'), 'module demo\ngo 1.27\n');
    await writeFile(path.join(dirGo, 'go.sum'), 'demo 1.0\n');
    const invGo = await scanInventory(dirGo);
    const targetGo = { targetPath: dirGo, projectRoot: dirGo, repositoryRoot: null, componentPath: null, scanRoot: dirGo, hasGit: false, hasManifest: false, manifestVersion: null };
    const evGo = extractEvidence(targetGo, invGo);
    expect(evGo.dependencies?.matching).toBe(false);
    expect(evGo.dependencies?.components?.every((entry) => entry.integrityVerified === false)).toBe(true);
  });

  it('covers empty inputs file and concurrent modification recheck in inputs', async () => {
    const dir = createFixtureDir('inputs-empty-recheck');
    await mkdir(dir, { recursive: true });
    const emptyFile = path.join(dir, 'empty.json');
    await writeFile(emptyFile, '');

    const captured = await captureInputsFile(emptyFile, dir);
    expect(captured.content).toBe('');
    expect(captured.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Mismatched metadata recheck -> InputsError
    const { recheckCapturedInputs } = await import('../../src/adapters/filesystem/standards-assessment/inputs.js');
    await expect(
      recheckCapturedInputs(emptyFile, { ...captured.metadata, size: 9999 })
    ).rejects.toThrow(InputsError);
  });

  it('does not turn asserted recipe names without source eligibility into repair commands', () => {
    const profile = listSupportedProfiles(loadPackagedProfilesCatalog())[0];
    const targetWithManifest: AssessmentTarget = {
      targetPath: '/test',
      projectRoot: '/test',
      repositoryRoot: null,
      componentPath: null,
      scanRoot: '/test',
      hasGit: false,
      hasManifest: true,
      manifestVersion: 7
    };

    const localLayoutFinding: AssessmentFinding = {
      ruleId: 'STD-INFRA-OPENTOFU',
      title: 'Layout',
      targetProfile: profile.id, scope: 'project', severity: 'warning',
      classification: 'unknown', expected: 'Observed infrastructure layout',
      observed: { facts: { recipe: 'azure-local-layout' }, references: [], limitations: [] }
    };

    const recsLayout = generateRecommendations({
      target: targetWithManifest,
      profile,
      observedProfiles: [profile],
      findings: [localLayoutFinding]
    });

    expect(recsLayout.some((recommendation) => recommendation.capability === 'repair')).toBe(false);

    const appPatchFinding: AssessmentFinding = {
      ruleId: 'application-layout-patch',
      title: 'App Patch',
      targetProfile: profile.id, scope: 'project', severity: 'warning',
      classification: 'unknown', expected: 'Actual reviewed mappings',
      observed: { facts: {}, references: [], limitations: [] }
    };

    const recsPatch = generateRecommendations({
      target: targetWithManifest,
      profile,
      observedProfiles: [profile],
      findings: [appPatchFinding]
    });

    expect(recsPatch.some((recommendation) => recommendation.capability === 'repair')).toBe(false);
    expect([...recsLayout, ...recsPatch].some((recommendation) =>
      recommendation.args.includes('--recipe') || recommendation.args.includes('--approve-plan'))).toBe(false);
  });

  it('covers dangling symlink and deleted file recheck in inputs', async () => {
    const dir = createFixtureDir('inputs-symlink-recheck');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'input.json');
    await writeFile(file, '{"val":1}');

    const symlinkPath = path.join(dir, 'sym.json');
    await symlink(file, symlinkPath);

    // O_NOFOLLOW open fails on symlink
    await expect(captureInputsFile(symlinkPath, dir)).rejects.toThrow(InputsError);

    // Non-existent file
    await expect(captureInputsFile(path.join(dir, 'missing.json'), dir)).rejects.toThrow(InputsError);

    // Deleted file recheck
    const captured = await captureInputsFile(file, dir);
    await rm(file);
    const { recheckCapturedInputs } = await import('../../src/adapters/filesystem/standards-assessment/inputs.js');
    await expect(recheckCapturedInputs(file, captured.metadata)).rejects.toThrow(InputsError);
  });

  it('covers checkPathSafety with non-directory ancestor and nonexistent target', async () => {
    const dir = createFixtureDir('ancestor-safety');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'not a dir');

    const { checkPathSafety } = await import('../../src/adapters/filesystem/standards-assessment/boundary.js');
    await expect(checkPathSafety(path.join(file, 'child'))).rejects.toThrow();
    await expect(checkPathSafety(path.join(dir, 'missing-path'))).rejects.toThrow(/does not exist/);
  });
});
