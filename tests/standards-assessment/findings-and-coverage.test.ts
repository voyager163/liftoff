import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessProject } from '../../src/application/standards-assessment/runner.js';
import { buildProjectPlan } from '../../src/planner.js';
import { buildArtifacts } from '../../src/templates.js';
import { loadPackagedProfilesCatalog } from '../../src/adapters/packaged-assets/resource-catalog.js';
import { getRuleDefinition } from '../../src/domain/standards-assessment/rules.js';
import { assessmentEvidenceBounds } from '../../src/domain/standards-assessment/evaluation.js';
import { resolveAssessmentTarget } from '../../src/adapters/filesystem/standards-assessment/boundary.js';
import { scanInventory } from '../../src/adapters/filesystem/standards-assessment/scanner.js';
import { extractEvidence } from '../../src/adapters/filesystem/standards-assessment/evidence.js';
import { sha256Hex } from '../../src/domain/standards-assessment/sanitizer.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.findings-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('standards assessment findings and coverage classification', () => {
  it('observes custom route declarations without requiring starter bytes or pretending runtime conformance', async () => {
    const dir = createFixtureDir('custom-code-conformance');
    await mkdir(path.join(dir, 'src', 'custom_handlers'), { recursive: true });

    // Custom package.json and lock
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'custom-fastify', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'custom-fastify', lockfileVersion: 3 })
    );

    // Custom business route that includes a health endpoint (completely different bytes from Liftoff starter template)
    await writeFile(
      path.join(dir, 'src', 'custom_handlers', 'routes.ts'),
      `import fastify from 'fastify';
       export function buildPricingApplication() {
         const app = fastify();
         app.get('/health', async () => ({ status: 'healthy', uptime: process.uptime() }));
         app.get('/docs', async () => ({ openapi: '3.0.0', paths: {} }));
         return app;
       }`
    );

    const result = await assessProject({ targetPath: dir });

    expect(result.profile.id).toBe('node-fastify');

    const healthFinding = result.findings.find((f) => f.ruleId.endsWith('API-HEALTH'));
    expect(healthFinding).toBeDefined();
    expect(healthFinding?.classification).toBe('unknown');
    expect(healthFinding?.observed.facts).toMatchObject({ registrationObserved: true, runtimeResponseVerified: false });

    const docsFinding = result.findings.find((f) => f.ruleId.endsWith('API-DOCS'));
    expect(docsFinding).toBeDefined();
    expect(docsFinding?.classification).toBe('unknown');
    expect(docsFinding?.observed.facts).toMatchObject({ schemaIdentityVerified: false });
  });

  it('distinguishes test suite presence from verified runtime behavior', async () => {
    const dir = createFixtureDir('test-presence-not-runtime');
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await writeFile(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = ["fastapi>=0.115.0"]\n'
    );
    await writeFile(path.join(dir, 'uv.lock'), 'version = 1\n');
    await writeFile(path.join(dir, 'app.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
    await writeFile(path.join(dir, 'tests', 'test_api.py'), 'def test_fake(): assert False\n');

    const result = await assessProject({ targetPath: dir });

    const testFinding = result.findings.find((f) => f.ruleId.endsWith('TEST-SUITE'));
    expect(testFinding).toBeDefined();
    expect(testFinding?.classification).toBe('unknown');
    expect(testFinding?.observed.facts).toMatchObject({ testDeclarationsCaptured: true, privateExecutionVerified: false });
    expect(testFinding?.observed.limitations).toContain(
      'Test suite declared in files; no fresh matching private execution or passing status was observed.'
    );
  });

  it('reports difference when documentation route returns SPA HTML instead of OpenAPI schema', async () => {
    const dir = createFixtureDir('spa-html-docs');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'spa-backend', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      `import fastify from 'fastify';
       const app = fastify();
       app.get('/openapi.json', (req, reply) => {
         reply.type('text/html').send('<html><body>SPA</body></html>');
       });`
    );

    const result = await assessProject({ targetPath: dir });

    const docsFinding = result.findings.find((f) => f.ruleId.endsWith('API-DOCS'));
    expect(docsFinding).toBeDefined();
    expect(docsFinding?.classification).toBe('difference');
    expect(docsFinding?.observed.limitations.some((l) => l.includes('HTML'))).toBe(true);
  });

  it('reports missing lockfile finding when dependencies are declared without lock', async () => {
    const dir = createFixtureDir('missing-lock');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'no-lock', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    const result = await assessProject({ targetPath: dir });

    const lockFinding = result.findings.find((f) => f.ruleId.endsWith('DEP-LOCK'));
    expect(lockFinding).toBeDefined();
    expect(lockFinding?.classification).toBe('missing');
    expect(lockFinding?.observed.limitations).toContain(
      'Lockfile is missing for declared dependencies'
    );
    expect(lockFinding?.remedy?.capability).toBe('repair');
  });

  it('classifies finding as unknown when affected scope is unobserved', async () => {
    const dir = createFixtureDir('unobserved-scope');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'large-app', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'package-lock.json'),
      'x'.repeat(1000)
    );
    await writeFile(
      path.join(dir, 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    // Max file size 500 will make package-lock.json unobserved with size_limit_exceeded
    const result = await assessProject({ targetPath: dir, maxFileSize: 500 });

    const lockFinding = result.findings.find((f) => f.ruleId.endsWith('DEP-LOCK'));
    expect(lockFinding).toBeDefined();
    expect(lockFinding?.classification).toBe('unknown');
    expect(lockFinding?.observed.limitations[0]).toContain('Scope unobserved');
  });

  it('retains the actual catalog descriptions and all declared rules in coverage', async () => {
    const catalog = loadPackagedProfilesCatalog();
    for (const profile of Object.values(catalog.profiles)) {
      for (const declared of profile.evaluationCoverage) {
        expect(getRuleDefinition(declared.id)?.description, declared.id).toBe(declared.description);
      }
    }
    const dir = createFixtureDir('genai-coverage');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname="rag"\ndependencies=["fastapi==0.115.0","pydantic-ai==2.0.0"]\n');
    await writeFile(path.join(dir, 'main.py'), 'from fastapi import FastAPI\nfrom pydantic_ai import Agent\napi = FastAPI()\nagent = Agent("provider:model")\n@api.post("/api/rag/query")\nasync def query(): return await agent.run("question")\n');
    const result = await assessProject({ targetPath: dir });
    expect(result.profile.id).toBe('genai-rag');
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual(catalog.profiles['genai-rag'].evaluationCoverage.map((rule) => rule.id).sort());
    expect(result.findings.find((finding) => finding.ruleId === 'RULE-GENAI-MODEL-CONFIG')?.classification).toBe('unknown');
    expect(result.findings.find((finding) => finding.ruleId === 'RULE-GENAI-PATTERN-CONTRACT')?.classification).toBe('unknown');
  });

  it('compares actual same-component generated lock metadata without claiming artifact integrity', async () => {
    const dir = createFixtureDir('actual-lock-metadata');
    await mkdir(dir, { recursive: true });
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'pricing-lock-proof', projectType: 'standard', apiStack: 'node', cloud: 'azure', governanceProfile: 'none'
    }, { requireProjectName: true }));
    for (const name of ['package.json', 'package-lock.json']) {
      const artifact = artifacts.find((entry) => entry.pathParts.join('/') === `backend/${name}`)!;
      await writeFile(path.join(dir, name), artifact.content);
    }
    await writeFile(path.join(dir, 'app.ts'), 'import createServer from "fastify"; export const app = createServer();');
    const result = await assessProject({ targetPath: dir });
    const finding = result.findings.find((entry) => entry.ruleId === 'RULE-DEP-LOCK')!;
    expect(finding.classification).toBe('unknown');
    expect(finding.observed.facts).toMatchObject({ lockMetadataConsistent: true, artifactIntegrityVerified: false });
    expect(finding.observed.references.map((entry) => entry.path).sort()).toEqual(['package-lock.json', 'package.json']);
    const lock = JSON.parse(artifacts.find((entry) => entry.pathParts.join('/') === 'backend/package-lock.json')!.content);
    lock.packages[''].dependencies.fastify = '^4.0.0';
    await writeFile(path.join(dir, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    const changed = await assessProject({ targetPath: dir });
    const conflict = changed.findings.find((entry) => entry.ruleId === 'RULE-DEP-LOCK');
    expect(conflict?.classification, JSON.stringify({ finding: conflict, unobserved: changed.inventory.unobserved })).toBe('difference');
  });

  it('never borrows a nested component bootstrap or build configuration for a parent Vue target', async () => {
    const dir = createFixtureDir('nested-frontend-evidence');
    await mkdir(path.join(dir, 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"parent","dependencies":{"vue":"^3.5.0"}}');
    await writeFile(path.join(dir, 'App.vue'), '<template><div>Parent component only</div></template>');
    await writeFile(path.join(dir, 'nested', 'package.json'), '{"name":"nested-tool","dependencies":{"lodash":"^4.0.0"}}');
    await writeFile(path.join(dir, 'nested', 'App.vue'), '<template><div>Unrelated child</div></template>');
    await writeFile(path.join(dir, 'nested', 'main.ts'), 'import {createApp} from "vue"; import App from "./App.vue"; createApp(App).mount("#app");');
    await writeFile(path.join(dir, 'nested', 'vite.config.ts'), 'import {defineConfig} from "vite"; import tailwind from "@tailwindcss/vite"; export default defineConfig({plugins:[tailwind()]});');
    const result = await assessProject({ targetPath: dir });
    expect(result.profile.id).toBe('vue-component');
    expect(result.findings.find((entry) => entry.ruleId === 'RULE-FRONTEND-ENTRY')?.classification).not.toBe('aligned');
    expect(result.findings.find((entry) => entry.ruleId === 'RULE-FRONTEND-BUILD')?.classification).not.toBe('aligned');
  });

  it('does not accept model or test-result files as private runtime evidence', async () => {
    const dir = createFixtureDir('model-proof-impostor');
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"pricing","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'app.ts'), 'import fastify from "fastify"; const app=fastify(); app.get("/health",async()=>({status:"ok"}));');
    await writeFile(path.join(dir, 'tests', 'results.json'), '{"passed":true,"privateWorkspaceVerified":true,"businessBehaviorSafe":true}');
    await writeFile(path.join(dir, 'tests', 'pretend.test.ts'), 'const example = "test(\\"everything passes\\", () => true)";');
    const result = await assessProject({ targetPath: dir });
    const testFinding = result.findings.find((entry) => entry.ruleId === 'RULE-TEST-SUITE')!;
    expect(testFinding.classification).toBe('unknown');
    expect(testFinding.observed.facts).toMatchObject({ testDeclarationsCaptured: false, privateExecutionVerified: false });
    expect(result.exitCode).toBe(2);
  });

  it('bounds real repeated source observations, references and fact arrays without claiming complete evidence', async () => {
    const dir = createFixtureDir('bounded-route-facts');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"api","dependencies":{"fastify":"^5.0.0"}}');
    const routeCount = 512;
    await writeFile(path.join(dir, 'main.ts'), [
      'import Fastify from "fastify"; const api = Fastify();',
      ...Array.from({ length: routeCount }, (_, index) => `api.get("/tenant-${index}/health", async () => ({ status: "ok" }));`)
    ].join('\n'));
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    const captured = extractEvidence(target, inventory);
    expect(captured.endpoints?.healthRoutes).toHaveLength(assessmentEvidenceBounds.routesPerSource);
    expect(captured.sourceEvidenceOmissions).toEqual([{ path: 'main.ts', count: routeCount - assessmentEvidenceBounds.routesPerSource }]);
    const result = await assessProject({ targetPath: dir });
    const health = result.findings.find((entry) => entry.ruleId === 'RULE-API-HEALTH')!;
    expect(health.classification).toBe('unknown');
    expect(health.scope).toBe('.');
    expect(health.observed.references.length).toBeLessThanOrEqual(assessmentEvidenceBounds.referencesPerFinding);
    expect(Buffer.byteLength(JSON.stringify(health.observed))).toBeLessThan(32_768);
    expect(health.observed.limitations.join(' ')).toContain('omitted');
    const facts = health.observed.facts;
    expect(Array.isArray(facts)).toBe(false);
    if (!Array.isArray(facts)) {
      expect(Array.isArray(facts.declaredRoutes)).toBe(true);
      if (Array.isArray(facts.declaredRoutes)) expect(facts.declaredRoutes.length).toBeLessThanOrEqual(assessmentEvidenceBounds.factArrayEntries);
    }
    expect(result.exitCode).toBe(2);
  });

  it('withholds decoded credentials and oversized source literals before publishing facts', async () => {
    const dir = createFixtureDir('bounded-private-facts');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"api","dependencies":{"fastify":"^5.0.0"}}');
    const credential = `ghp_${'a'.repeat(32)}`;
    const encodedRoute = `/\\u0067hp_${'a'.repeat(32)}/health`;
    const oversized = `/${'x'.repeat(2000)}/health`;
    await writeFile(path.join(dir, 'main.ts'), `import Fastify from "fastify"; const api = Fastify();
api.get("${encodedRoute}", async () => ({status:"ok"}));
api.get("${oversized}", async () => ({status:"ok"}));
`);
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    expect(inventory.contentMap?.has('main.ts')).toBe(true);
    const captured = extractEvidence(target, inventory);
    expect(captured.endpoints?.healthRoutes).toEqual([]);
    expect(captured.sourceEvidenceOmissions).toEqual([{ path: 'main.ts', count: 2 }]);
    const result = await assessProject({ targetPath: dir });
    const published = JSON.stringify(result);
    expect(published).not.toContain(credential);
    expect(published).not.toContain(oversized);
    expect(result.findings.find((entry) => entry.ruleId === 'RULE-API-HEALTH')?.observed.limitations.join(' ')).toContain('omitted');
  });

  it('uses the guarded root-manifest identity for a component without reading parent or sibling payloads', async () => {
    const dir = createFixtureDir('guarded-root-manifest');
    await mkdir(path.join(dir, 'backend'), { recursive: true });
    await mkdir(path.join(dir, 'sibling'), { recursive: true });
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'guarded-manifest', projectType: 'standard', apiStack: 'node', cloud: 'azure', governanceProfile: 'none'
    }, { requireProjectName: true }));
    const manifest = artifacts.find((entry) => entry.pathParts.join('/') === 'liftoff.manifest.json')!.content;
    const manifestPath = path.join(dir, 'liftoff.manifest.json');
    await writeFile(manifestPath, manifest);
    await writeFile(path.join(dir, 'backend', 'package.json'), '{"name":"backend","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'backend', 'app.ts'), 'import Fastify from "fastify"; const app = Fastify();');
    await writeFile(path.join(dir, 'sibling', 'private-business.ts'), 'throw new Error("outside selected component");');
    const result = await assessProject({ projectRoot: dir, componentPath: 'backend' });
    expect(result.target.manifestPath).toBe(manifestPath);
    expect(result.target.manifestDigest).toBe(`sha256:${sha256Hex(manifest)}`);
    expect(result.inventory.files.map((file) => file.path).sort()).toEqual(['app.ts', 'package.json']);
    const finding = result.findings.find((entry) => entry.ruleId === 'RULE-LIFTOFF-MANIFEST')!;
    expect(finding.scope).toBe('.');
    expect(finding.classification).toBe('unknown');
    expect(finding.observed.facts).toMatchObject({
      manifestPresent: true, manifestEvidenceSource: 'guarded-project-root', manifestSchemaValidated: true,
      manifestContentCapturedInInventory: false, lifecycleConformanceVerified: false
    });
    expect(finding.observed.references).toEqual([{ path: 'liftoff.manifest.json', digest: result.target.manifestDigest }]);
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest);

    const target = await resolveAssessmentTarget({ projectRoot: dir, componentPath: 'backend' });
    const inventory = await scanInventory(target.scanRoot);
    await writeFile(manifestPath, 'newer bytes must not be reread by evidence extraction');
    const evidence = extractEvidence(target, inventory);
    expect(evidence.manifest).toMatchObject({ present: true, digest: target.manifestDigest, source: 'guarded-project-root' });
    const unrelated = extractEvidence({ ...target, manifestPath: path.join(dir, 'sibling', 'liftoff.manifest.json') }, inventory);
    expect(unrelated.manifest?.present).toBeNull();
    expect(unrelated.manifest?.source).toBe('unobserved');
    const invalidDigest = extractEvidence({ ...target, manifestDigest: 'not-a-captured-digest' }, inventory);
    expect(invalidDigest.manifest?.present).toBeNull();
  });
});
