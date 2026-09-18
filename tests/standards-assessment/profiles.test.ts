import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAssessmentTarget } from '../../src/adapters/filesystem/standards-assessment/boundary.js';
import { scanInventory } from '../../src/adapters/filesystem/standards-assessment/scanner.js';
import { resolveTargetProfile } from '../../src/application/standards-assessment/profile-resolver.js';
import {
  getSupportedProfile,
  listSupportedProfiles
} from '../../src/domain/standards-assessment/catalog.js';
import { loadPackagedProfilesCatalog } from '../../src/adapters/packaged-assets/resource-catalog.js';
import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../../src/domain/standards/profile-schema.js';
import { detectProjectComponents, detectProjectFramework, extractEvidence } from '../../src/adapters/filesystem/standards-assessment/evidence.js';
import { buildProjectPlan } from '../../src/planner.js';
import { buildArtifacts } from '../../src/templates.js';
import { assessmentEvidenceBounds } from '../../src/domain/standards-assessment/evaluation.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.profiles-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('standards assessment profile resolution and evidence', () => {
  it('pins all 13 actual installed standards profiles without a synthetic identity fallback', () => {
    const catalog = loadPackagedProfilesCatalog();
    const profiles = listSupportedProfiles(catalog);
    expect(profiles.map((p) => p.id)).toEqual(SUPPORTED_STANDARDS_PROFILE_IDS);
    expect(profiles).toHaveLength(13);

    for (const profile of profiles) {
      expect(profile.schemaVersion).toBe(1);
      expect(profile.revision).toBe('2026.09.01');
      expect(profile.status).toBe('supported');
      expect(profile.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(getSupportedProfile(profile.id, catalog)?.digest).toBe(profile.digest);
      expect(profile.declaredRuleCoverage.length).toBeGreaterThan(0);
    }
  });

  it('detects Python FastAPI from pyproject.toml declaration and source import', async () => {
    const dir = createFixtureDir('fastapi-evidence');
    await mkdir(path.join(dir, 'backend', 'apis'), { recursive: true });
    await writeFile(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = ["fastapi>=0.115.0"]\n'
    );
    await writeFile(
      path.join(dir, 'backend', 'apis', 'main.py'),
      'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health(): return {"status":"ok"}\n'
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('python-fastapi');
    expect(result.profile.status).toBe('supported');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('detects Node.js Fastify from package.json and TypeScript source import', async () => {
    const dir = createFixtureDir('fastify-evidence');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\napp.get('/health', async () => ({ status: 'ok' }));\n"
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('node-fastify');
    expect(result.profile.status).toBe('supported');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('detects Go Huma from go.mod and Go source usage', async () => {
    const dir = createFixtureDir('go-huma-evidence');
    await mkdir(path.join(dir, 'cmd', 'server'), { recursive: true });
    await writeFile(
      path.join(dir, 'go.mod'),
      'module demo\n\ngo 1.27.0\n\nrequire github.com/danielgtaylor/huma/v2 v2.28.0\n'
    );
    await writeFile(
      path.join(dir, 'cmd', 'server', 'main.go'),
      'package main\nimport "github.com/danielgtaylor/huma/v2"\nfunc main() {\n  // huma.New()\n  huma.Register(nil, huma.Operation{}, nil)\n}\n'
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('go-huma');
    expect(result.profile.status).toBe('supported');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('detects Vue frontend from package.json and .vue components', async () => {
    const dir = createFixtureDir('vue-evidence');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-ui', dependencies: { vue: '^3.5.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'App.vue'),
      '<template><div>Hello Liftoff</div></template><script setup lang="ts"></script>\n'
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('vue-component');
    expect(result.profile.status).toBe('supported');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('detects GenAI backend when PydanticAI patterns accompany FastAPI', async () => {
    const dir = createFixtureDir('genai-evidence');
    await mkdir(path.join(dir, 'backend'), { recursive: true });
    await writeFile(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "demo-genai"\ndependencies = ["fastapi>=0.115.0", "pydantic-ai>=0.0.18"]\n'
    );
    await writeFile(
      path.join(dir, 'backend', 'main.py'),
      'from fastapi import FastAPI\nfrom pydantic_ai import Agent\napp = FastAPI()\nagent = Agent("openai:gpt-4o")\n@app.post("/api/ai/run")\nasync def invoke(): return await agent.run("hello")\n'
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('genai-generic');
    expect(result.profile.status).toBe('supported');
  });

  it('verifies comments and filename resemblance do not establish framework support', async () => {
    const dir = createFixtureDir('resemblance-not-evidence');
    await mkdir(path.join(dir, 'src'), { recursive: true });

    // package.json does NOT contain fastify
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'custom-tool', dependencies: { lodash: '^4.17.21' } })
    );

    // File named fastify.ts with only a comment
    await writeFile(
      path.join(dir, 'src', 'fastify.ts'),
      '// We plan to migrate this module to Fastify in the future\nexport const placeholder = true;\n'
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    // Must NOT be resolved as Fastify!
    expect(result.profile.id).not.toBe('node-fastify');
    expect(result.profile.status).toBe('unresolved');
  });

  it('identifies Express as unsupported stack without converting to Fastify', async () => {
    const dir = createFixtureDir('unsupported-express');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'express-app', dependencies: { express: '^4.21.0' } })
    );
    await writeFile(
      path.join(dir, 'src', 'app.js'),
      "const express = require('express');\nconst app = express();\n"
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('express');
    expect(result.profile.status).toBe('unsupported');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('UNSUPPORTED_STACK_OBSERVED');
    expect(result.diagnostics[0].message).toMatch(/express/i);
    expect(result.diagnostics[0].message).toContain('does not infer automatic conversion');
  });

  it('identifies Flask as unsupported stack without converting to FastAPI', async () => {
    const dir = createFixtureDir('unsupported-flask');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "flask-app"\ndependencies = ["flask>=3.0.0"]\n'
    );
    await writeFile(
      path.join(dir, 'app.py'),
      'from flask import Flask\napp = Flask(__name__)\n'
    );

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory);

    expect(result.profile.id).toBe('flask');
    expect(result.profile.status).toBe('unsupported');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('UNSUPPORTED_STACK_OBSERVED');
  });

  it('supports explicit --profile override for supported profile', async () => {
    const dir = createFixtureDir('explicit-profile');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'demo.py'), 'print(1)\n');

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory, 'fastapi');

    expect(result.profile.id).toBe('python-fastapi');
    expect(result.profile.status).toBe('supported');
    expect(result.observedProfiles).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('PROFILE_SOURCE_UNOBSERVED');
  });

  it('rejects invalid explicit profile with fatal error diagnostic', async () => {
    const dir = createFixtureDir('invalid-explicit-profile');
    await mkdir(dir, { recursive: true });

    const target = await resolveAssessmentTarget({ targetPath: dir });
    const inventory = await scanInventory(dir);
    const result = await resolveTargetProfile(target, inventory, 'unknown-framework');

    expect(result.profile.status).toBe('unsupported');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe('error');
    expect(result.diagnostics[0].code).toBe('INVALID_PROFILE_SELECTION');
  });

  it.each([
    ['pyproject.toml', '[project]\nname = "fastapi-flask"\ndescription = "fastapi"\ndependencies = ["requests==2.32.0"]\n# fastapi>=0.115\n', 'app.py', 'from fastapi import FastAPI\napp = FastAPI()\n'],
    ['requirements.txt', '# fastapi==0.115.0\nrequests==2.32.0\n', 'app.py', 'from fastapi import FastAPI\napp = FastAPI()\n'],
    ['package.json', '{"name":"fastify","description":"fastify","keywords":["fastify"],"dependencies":{"lodash":"^4.0.0"}}', 'app.js', 'import fastify from "fastify"; const app = fastify();'],
    ['go.mod', 'module example.test/tool\n// require github.com/danielgtaylor/huma/v2 v2.34.1\nrequire example.test/other v1.0.0\n', 'main.go', 'package main\nimport h "github.com/danielgtaylor/huma/v2"\nfunc main(){ h.DefaultConfig("tool", "1") }\n']
  ])('does not infer a declaration from comments or metadata in %s', async (manifestName, declaration, sourceName, source) => {
    const dir = createFixtureDir('declaration-impostor');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, manifestName), declaration);
    await writeFile(path.join(dir, sourceName), source);
    const target = await resolveAssessmentTarget({ targetPath: dir });
    const result = resolveTargetProfile(target, await scanInventory(dir));
    expect(result.profile.status).toBe('unresolved');
    expect(result.observedProfiles).toEqual([]);
  });

  it('ignores Flask metadata and comments when the actual Python dependency is FastAPI', async () => {
    const dir = createFixtureDir('python-metadata');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname="flask-tool"\ndescription="Django and Flask migration notes"\ndependencies=["fastapi==0.115.0"]\n# flask>=3\n');
    await writeFile(path.join(dir, 'app.py'), 'from fastapi import FastAPI as API\nservice = API()\n');
    const target = await resolveAssessmentTarget({ targetPath: dir });
    expect(resolveTargetProfile(target, await scanInventory(dir)).profile.id).toBe('python-fastapi');
  });

  it('recognizes aliased multiline Fastify import, typed factory and real route object without truncating URLs', async () => {
    const dir = createFixtureDir('multiline-fastify');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"pricing","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'server.ts'), `
import {
  fastify as makeService
} from
  "fastify";
const help = "https://example.test/docs#health";
const service: ReturnType<typeof makeService> =
  makeService({ logger: false });
service.route({
  method: "GET",
  url: "/health",
  handler: async () => ({ status: "ok", help })
});
service.get(
  "/openapi.json",
  async () => ({ unverified: true })
);
`);
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    expect(resolveTargetProfile(target, inventory).profile.id).toBe('node-fastify');
    const evidence = extractEvidence(target, inventory);
    expect(evidence.endpoints?.healthRoutes.map((route) => route.path)).toEqual(['/health']);
    expect(evidence.endpoints?.docsRoutes.map((route) => route.path)).toEqual(['/openapi.json']);
  });

  it('recognizes aliased Python import blocks, multiline configuration and decorator registrations', async () => {
    const dir = createFixtureDir('multiline-python');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname="api"\ndependencies=["fastapi==0.115.0"]\n');
    await writeFile(path.join(dir, 'main.py'), `
from fastapi import (
    FastAPI as Server,
    APIRouter as Routes,
)
metadata_url = "https://example.test/docs#overview"
service = Server(
    docs_url="/docs",
    openapi_url="/openapi.json",
)
routes = Routes(prefix="/api")
@routes.get(
    "/health"
)
def health():
    return {"status": "ok", "documentation": metadata_url}
service.include_router(routes)
`);
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    expect(resolveTargetProfile(target, inventory).profile.id).toBe('python-fastapi');
    const evidence = extractEvidence(target, inventory);
    expect(evidence.endpoints?.healthRoutes.map((entry) => entry.path)).toEqual(['/api/health']);
    expect(evidence.endpoints?.docsRoutes.map((entry) => entry.path).sort()).toEqual(['/docs', '/openapi.json']);
  });

  it.each([
    ['generic', '/api/ai/run'], ['rag', '/api/rag/query'], ['chatbot', '/api/chat/run'],
    ['agent', '/api/agent/run'], ['prompt', '/api/invoke/run'], ['multi-agent', '/api/multi-agent/run'],
    ['fine-tuned', '/api/fine-tuned/run'], ['streaming', '/api/stream'], ['workflow', '/api/workflows/run']
  ])('identifies the actual declared %s GenAI route without using the requested target as source', async (pattern, route) => {
    const dir = createFixtureDir(`genai-${pattern}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname="custom-ai"\ndependencies=["fastapi==0.115.0","pydantic-ai-slim==2.0.0"]\n');
    await writeFile(path.join(dir, 'api.py'), `from fastapi import FastAPI as Service\nfrom pydantic_ai import Agent as Model\nservice = Service()\nmodel = Model("provider:model")\n@service.${pattern === 'streaming' ? 'get' : 'post'}("${route}")\nasync def invoke():\n    return await model.run("request")\n`);
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    const observed = resolveTargetProfile(target, inventory);
    expect(observed.profile.id).toBe(`genai-${pattern}`);
    expect(observed.observedProfiles[0]?.componentRoot).toBe('.');
    const explicit = resolveTargetProfile(target, inventory, pattern === 'rag' ? 'genai-chatbot' : 'genai-rag');
    expect(explicit.observedProfiles.map((entry) => entry.id)).toEqual([`genai-${pattern}`]);
    expect(explicit.diagnostics.some((entry) => entry.code === 'INCOMPATIBLE_PROFILE_TARGET')).toBe(true);
  });

  it('retains every distinct backend and Vue root rather than selecting the first declaration file', async () => {
    const dir = createFixtureDir('multi-component');
    for (const root of ['pricing', 'reporting', 'web']) await mkdir(path.join(dir, root), { recursive: true });
    await writeFile(path.join(dir, 'pricing', 'package.json'), '{"name":"pricing","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'pricing', 'app.ts'), 'import server from "fastify"; export const app = server();');
    await writeFile(path.join(dir, 'reporting', 'pyproject.toml'), '[project]\nname="reporting"\ndependencies=["fastapi==0.115.0"]\n');
    await writeFile(path.join(dir, 'reporting', 'app.py'), 'import fastapi as api\napp = api.FastAPI()\n');
    await writeFile(path.join(dir, 'web', 'package.json'), '{"name":"web","dependencies":{"vue":"^3.5.0"}}');
    await writeFile(path.join(dir, 'web', 'App.vue'), '<template><section>Custom pricing UI</section></template>');
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    const resolution = resolveTargetProfile(target, inventory);
    expect(resolution.profile.status).toBe('unresolved');
    expect(resolution.observedProfiles.map((entry) => [entry.id, entry.componentRoot])).toEqual([
      ['node-fastify', 'pricing'], ['python-fastapi', 'reporting'], ['vue-component', 'web']
    ]);
    expect(resolveTargetProfile(target, { ...inventory, files: [...inventory.files].reverse() })).toEqual(resolution);
    expect(detectProjectFramework(target, inventory).detectedFramework).toBe('unknown');
    expect(detectProjectComponents(target, inventory)).toHaveLength(3);
    const explicit = resolveTargetProfile(target, inventory, 'node-fastify');
    expect(explicit.profile.componentRoot).toBeUndefined();
    expect(explicit.diagnostics.some((entry) => entry.code === 'PROFILE_SCOPE_AMBIGUOUS')).toBe(true);
  });

  it('does not borrow framework source from a sibling or an overlapping nested declaration root', async () => {
    const dir = createFixtureDir('source-scope');
    await mkdir(path.join(dir, 'backend'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"root-app","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'backend', 'package.json'), '{"name":"nested-tool","dependencies":{"lodash":"^4.0.0"}}');
    await writeFile(path.join(dir, 'backend', 'app.js'), 'import fastify from "fastify"; const app = fastify();');
    const target = await resolveAssessmentTarget({ targetPath: dir });
    const result = resolveTargetProfile(target, await scanInventory(dir));
    expect(result.profile.status).toBe('unresolved');
    expect(result.observedProfiles).toEqual([]);
  });

  it('uses only captured content after the on-disk source changes', async () => {
    const dir = createFixtureDir('captured-only');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"captured","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'app.ts'), 'import fastify from "fastify"; const app = fastify(); app.get("/health", async()=>({status:"ok"}));');
    const target = await resolveAssessmentTarget({ targetPath: dir }), captured = await scanInventory(dir);
    await writeFile(path.join(dir, 'app.ts'), 'throw new Error("must not be reread or executed");');
    expect(resolveTargetProfile(target, captured).profile.id).toBe('node-fastify');
    expect(extractEvidence(target, captured).endpoints?.healthRoutes).toHaveLength(1);
  });

  it('recognizes captured GenAI implementation imports inside an actual runner class', async () => {
    const dir = createFixtureDir('genai-local-import');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname="ai"\ndependencies=["fastapi==0.115.0","pydantic-ai-slim==2.0.0"]\n');
    await writeFile(path.join(dir, 'runner.py'), 'class Runner:\n    def __init__(self):\n        from pydantic_ai import Agent\n        self._agent = Agent("provider:model")\n');
    await writeFile(path.join(dir, 'app.py'), 'from fastapi import FastAPI\nfrom runner import Runner\napp = FastAPI()\nrunner = Runner()\n@app.post("/api/ai/run")\nasync def invoke(): return await runner._agent.run("request")\n');
    const target = await resolveAssessmentTarget({ targetPath: dir });
    expect(resolveTargetProfile(target, await scanInventory(dir)).profile.id).toBe('genai-generic');
  });

  it('uses slash-separated project-relative component roots, with dot reserved for the project root', async () => {
    const dir = createFixtureDir('logical-component-root');
    const component = path.join(dir, 'services', 'pricing');
    await mkdir(component, { recursive: true });
    await writeFile(path.join(component, 'package.json'), '{"name":"pricing","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(component, 'app.ts'), 'import createServer from "fastify"; const service = createServer();');
    const target = await resolveAssessmentTarget({ projectRoot: dir, componentPath: 'services/pricing' });
    const inventory = await scanInventory(target.scanRoot);
    const result = resolveTargetProfile(target, inventory);
    expect(result.profile.componentRoot).toBe('services/pricing');
    expect(result.observedProfiles.map((entry) => entry.componentRoot)).toEqual(['services/pricing']);
    expect(result.observedProfiles.some((entry) => path.isAbsolute(entry.componentRoot))).toBe(false);
  });

  it('does not turn bounded component output into a misleading single adoption observation', async () => {
    const dir = createFixtureDir('component-output-bound');
    for (let index = 0; index <= assessmentEvidenceBounds.observedComponents; index++) {
      const root = path.join(dir, `api-${String(index).padStart(3, '0')}`);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'package.json'), '{"name":"api","dependencies":{"fastify":"^5.0.0"}}');
      await writeFile(path.join(root, 'main.ts'), 'import Fastify from "fastify"; const api = Fastify();');
    }
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    const automatic = resolveTargetProfile(target, inventory);
    expect(automatic.profile.status).toBe('unresolved');
    expect(automatic.observedProfiles).toEqual([]);
    expect(automatic.diagnostics.some((entry) => entry.code === 'PROFILE_EVIDENCE_LIMIT')).toBe(true);
    const explicit = resolveTargetProfile(target, inventory, 'node-fastify');
    expect(explicit.profile.id).toBe('node-fastify');
    expect(explicit.profile.componentRoot).toBeUndefined();
    expect(explicit.observedProfiles).toEqual([]);
    expect(explicit.diagnostics.length).toBeLessThanOrEqual(assessmentEvidenceBounds.profileDiagnostics);
  });

  it.each(SUPPORTED_STANDARDS_PROFILE_IDS)('assesses captured current generated %s source without replacing unavailable evidence with its manifest label', async (profileId) => {
    const dir = createFixtureDir(`generated-${profileId}`);
    await mkdir(dir, { recursive: true });
    const pattern = profileId.startsWith('genai-') ? profileId.slice('genai-'.length) : undefined;
    const plan = buildProjectPlan({
      projectName: 'captured-generated-component',
      ...(pattern ? { projectType: 'genai', pattern } : {
        projectType: 'standard',
        apiStack: profileId === 'python-fastapi' ? 'python' : profileId === 'go-huma' ? 'go' : 'node',
        includeFrontend: profileId === 'vue-component'
      }),
      cloud: 'azure', governanceProfile: 'none'
    }, { requireProjectName: true });
    const root = profileId === 'vue-component' ? 'frontend' : 'backend';
    for (const artifact of buildArtifacts(plan).filter((entry) => entry.pathParts[0] === root)) {
      const file = path.join(dir, ...artifact.pathParts.slice(1));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, artifact.content);
    }
    const target = await resolveAssessmentTarget({ targetPath: dir }), inventory = await scanInventory(dir);
    const result = resolveTargetProfile(target, inventory);
    expect(result.profile.id, JSON.stringify({
      diagnostics: result.diagnostics, unobserved: inventory.unobserved,
      sourceLimitations: extractEvidence(target, inventory).sourceLimitations
    })).toBe(profileId);
    expect(result.observedProfiles[0]?.componentRoot).toBe('.');
    expect(target.hasManifest).toBe(false);
  });
});
