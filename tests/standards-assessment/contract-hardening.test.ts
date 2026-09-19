import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessProject } from '../../src/application/standards-assessment/runner.js';
import { captureInputsFile } from '../../src/adapters/filesystem/standards-assessment/inputs.js';
import { InputsError } from '../../src/adapters/filesystem/standards-assessment/errors.js';
import { scanInventory } from '../../src/adapters/filesystem/standards-assessment/scanner.js';
import { extractEvidence, isActualGoHumaImportAndUsage } from '../../src/adapters/filesystem/standards-assessment/evidence.js';
import { evaluateProfileRules } from '../../src/domain/standards-assessment/evaluation.js';
import { getSupportedProfile } from '../../src/domain/standards-assessment/catalog.js';
import { loadPackagedProfilesCatalog } from '../../src/adapters/packaged-assets/resource-catalog.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.hardening-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('standards assessment contract hardening and negative behavior tests', () => {
  it('confines --component to selected component directory without inventorying siblings', async () => {
    const dir = createFixtureDir('component-confinement');
    const backend = path.join(dir, 'backend');
    const frontend = path.join(dir, 'frontend');
    const docs = path.join(dir, 'docs');
    await mkdir(backend, { recursive: true });
    await mkdir(frontend, { recursive: true });
    await mkdir(docs, { recursive: true });

    await writeFile(path.join(backend, 'package.json'), '{"name":"backend","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(backend, 'package-lock.json'), '{"name":"backend","lockfileVersion":3}');
    await writeFile(path.join(frontend, 'package.json'), '{"name":"frontend","dependencies":{"vue":"^3.0.0"}}');
    await writeFile(path.join(docs, 'README.md'), '# Documentation');

    const result = await assessProject({
      projectRoot: dir,
      componentPath: 'backend'
    });

    expect(result.target.componentPath).toBe('backend');
    expect(result.target.scanRoot).toBe(backend);

    const paths = result.inventory.files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('package-lock.json');
    // Siblings MUST NOT be in inventory
    expect(paths.some((p) => p.includes('frontend'))).toBe(false);
    expect(paths.some((p) => p.includes('docs'))).toBe(false);
  });

  it('rejects oversized inputs files with InputsError', async () => {
    const dir = createFixtureDir('inputs-oversized');
    await mkdir(dir, { recursive: true });
    const inputsPath = path.join(dir, 'large-inputs.json');
    await writeFile(inputsPath, 'x'.repeat(1024 * 1024 + 10));

    await expect(captureInputsFile(inputsPath, dir)).rejects.toThrow(InputsError);
    await expect(captureInputsFile(inputsPath, dir)).rejects.toThrow(/exceeds the 1 MiB contract bound/);
  });

  it('rejects protected credential filenames as inputs file with InputsError', async () => {
    const dir = createFixtureDir('inputs-protected');
    await mkdir(dir, { recursive: true });
    const envPath = path.join(dir, '.env');
    await writeFile(envPath, 'KEY=VAL');

    await expect(captureInputsFile(envPath, dir)).rejects.toThrow(InputsError);
    await expect(captureInputsFile(envPath, dir)).rejects.toThrow(/targets protected credentials/);
  });

  it('rejects inputs files containing raw sensitive credentials with InputsError', async () => {
    const dir = createFixtureDir('inputs-sensitive');
    await mkdir(dir, { recursive: true });
    const secretInputs = path.join(dir, 'inputs.json');
    await writeFile(secretInputs, '{"token":"ghp_123456789012345678901234567890"}');

    await expect(captureInputsFile(secretInputs, dir)).rejects.toThrow(InputsError);
    await expect(captureInputsFile(secretInputs, dir)).rejects.toThrow(/contains prohibited sensitive credentials/);
  });

  it('binds absolute reference and digest for valid inputs file against invocation cwd', async () => {
    const dir = createFixtureDir('inputs-valid');
    await mkdir(dir, { recursive: true });
    const inputsFile = path.join(dir, 'config.json');
    await writeFile(inputsFile, '{"environment":"dev"}');

    const captured = await captureInputsFile('config.json', dir);
    expect(captured.reference).toBe(inputsFile);
    expect(captured.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('records build and dist directories in unobserved with excluded_directory', async () => {
    const dir = createFixtureDir('excluded-dirs');
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await mkdir(path.join(dir, 'build'), { recursive: true });
    await writeFile(path.join(dir, 'dist', 'bundle.js'), 'console.log()');
    await writeFile(path.join(dir, 'build', 'output.js'), 'console.log()');
    await writeFile(path.join(dir, 'main.js'), 'console.log()');

    const inventory = await scanInventory(dir);

    const distUnobserved = inventory.unobserved.find((u) => u.path === 'dist');
    const buildUnobserved = inventory.unobserved.find((u) => u.path === 'build');
    expect(distUnobserved).toBeDefined();
    expect(distUnobserved?.reason).toBe('excluded_directory');
    expect(buildUnobserved).toBeDefined();
    expect(buildUnobserved?.reason).toBe('excluded_directory');
  });

  it('does not turn Express source into observed Fastify when explicit target is node-fastify', async () => {
    const dir = createFixtureDir('target-not-observed');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"express-app","dependencies":{"express":"^4.21.0"}}');
    await writeFile(path.join(dir, 'server.js'), "const express = require('express');\nconst app = express();\n");

    const result = await assessProject({
      targetPath: dir,
      profile: 'node-fastify'
    });

    // Profile target is node-fastify
    expect(result.profile.id).toBe('node-fastify');
    // But observed framework is Express!
    expect(result.observedProfiles.some((p) => p.id === 'express')).toBe(true);
    // Diagnostic emitted warning of incompatibility
    const incompatDiag = result.diagnostics.find((d) => d.code === 'INCOMPATIBLE_PROFILE_TARGET');
    expect(incompatDiag).toBeDefined();
    // Must NOT be adoption qualified
    expect(result.recommendations.some((r) => r.capability === 'adopt')).toBe(false);
    expect(result.outcome).toBe('differences');
    expect(result.exitCode).toBe(2);
  });

  it('rejects comment and literal string impostors from counting as route registrations', async () => {
    const dir = createFixtureDir('route-impostors');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"impostor","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'package-lock.json'), '{"name":"impostor","lockfileVersion":3}');

    // File containing string literals and comments mentioning /health, but NO route registrations
    await writeFile(
      path.join(dir, 'server.ts'),
      `/*
         GET /health - this is just a comment
       */
       // app.get('/health', ...)
       const url = "http://external-service.com/health";
       const redirect = '/api/health';
       console.log('Checking /livez');
      `
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

    // No health route should be detected!
    expect(evidence.endpoints?.healthRoutes).toHaveLength(0);
  });

  it('rejects cross-component lockfile matching when declaration is in subcomponent and lock is at root', async () => {
    const dir = createFixtureDir('cross-component-lock');
    const backend = path.join(dir, 'backend');
    await mkdir(backend, { recursive: true });

    // Root lockfile
    await writeFile(path.join(dir, 'package-lock.json'), '{"name":"root","lockfileVersion":3}');
    // Backend declaration WITHOUT its own lockfile
    await writeFile(path.join(backend, 'package.json'), '{"name":"backend","dependencies":{"fastify":"^5.0.0"}}');

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

    // Matching must be FALSE because backend/package.json has no backend/package-lock.json!
    expect(evidence.dependencies?.matching).toBe(false);
  });

  it('reports ambiguous stack when both express and fastify are declared in package.json', async () => {
    const dir = createFixtureDir('ambiguous-stack');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      '{"name":"ambiguous","dependencies":{"express":"^4.0.0","fastify":"^5.0.0"}}'
    );

    const result = await assessProject({ targetPath: dir });
    expect(result.profile.status).toBe('unresolved');
    expect(result.outcome).toBe('differences');
    expect(result.exitCode).toBe(2);
  });

  it('retains null for hasGit and hasManifest when boundary inspection fails', async () => {
    const dir = createFixtureDir('uninspected-boundary');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'liftoff.manifest.json'), '{ malformed json');

    const result = await assessProject({ targetPath: dir });
    expect(result.outcome).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.target.hasGit).toBeNull();
    expect(result.target.hasManifest).toBeNull();
  });

  it('does not mistake a Go string literal and unused dependency for an observed Huma application', async () => {
    const dir = createFixtureDir('go-string-literal');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'go.mod'),
      'module example.test/tool\n\ngo 1.26.0\n\nrequire github.com/danielgtaylor/huma/v2 v2.34.1\n'
    );
    // Only imports fmt and prints the huma module URL as a string literal
    await writeFile(
      path.join(dir, 'main.go'),
      'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("github.com/danielgtaylor/huma/v2") }\n'
    );

    const result = await assessProject({ targetPath: dir });

    // Framework detection must NOT identify go-huma from unused dependency + string literal
    expect(result.observedProfiles.some((p) => p.id === 'go-huma')).toBe(false);
    expect(result.profile.id).not.toBe('go-huma');
    expect(result.recommendations.some((r) => r.capability === 'adopt')).toBe(false);
  });

  it.each([
    'package main\nimport h "github.com/danielgtaylor/huma/v2"\nfunc main(){h.DefaultConfig("pricing","1")}\n',
    'package main\nimport (\n "fmt"\n api "github.com/danielgtaylor/huma/v2"\n)\nfunc main(){api.Register(nil, api.Operation{Path:"/health"}, nil);fmt.Println("configured")}\n',
    'package main\nimport api `github.com/danielgtaylor/huma/v2`\nfunc main(){api.Register[int,string](nil,api.Operation{},nil)}\n',
    'package main\nimport hc "github.com/danielgtaylor/huma/v2/adapters/humachi"\nfunc main(){hc.New(nil,nil)}\n'
  ])('accepts actual Go Huma import/alias use through the shared helper', (source) => {
    expect(isActualGoHumaImportAndUsage(source)).toBe(true);
  });

  it.each([
    'package main\nimport "fmt"\nfunc main(){fmt.Println("github.com/danielgtaylor/huma/v2")}\n',
    'package main\n/* import "github.com/danielgtaylor/huma/v2" */\nfunc main(){ /* huma.Register(nil,nil,nil) */ }\n',
    'package main\nimport h "github.com/danielgtaylor/huma/v2"\nvar example = `h.Register(nil, h.Operation{}, nil)`\n',
    'package main\nimport "fmt"\nvar example = "import h \\"github.com/danielgtaylor/huma/v2\\"; h.Register(nil,nil,nil)"\n',
    'package main\nimport _ "github.com/danielgtaylor/huma/v2"\nfunc main(){huma.Register(nil,nil,nil)}\n',
    'package main\nimport h "github.com/danielgtaylor/huma/v2"\nfunc main(){ h := "not a package"; h.Register(nil,nil,nil) }\n',
    'package main\nimport h "github.com/danielgtaylor/huma/v2"\nfunc example(h SomeOtherType){h.Register(nil,nil,nil)}\n'
  ])('rejects Go import/usage impostors and shadowed aliases through the shared helper', (source) => {
    expect(isActualGoHumaImportAndUsage(source)).toBe(false);
  });

  it.each([
    'const sample = "import fastify from \'fastify\'; const app = fastify(); app.get(\'/health\', handler)";',
    'const sample = `import fastify from "fastify"; const app = fastify(); app.get("/health", handler)`;',
    'const sample = /import fastify from "fastify"; fastify\\(\\)/;',
    '/* import fastify from "fastify"; const app=fastify(); */\nconsole.log("https://example.test/#fastify");'
  ])('does not count JavaScript strings, templates, regexes or comments as imports', async (source) => {
    const dir = createFixtureDir('js-import-impostor');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"impostor","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'server.ts'), source);
    const result = await assessProject({ targetPath: dir });
    expect(result.observedProfiles.some((entry) => entry.id === 'node-fastify')).toBe(false);
  });

  it('retains genuine imports around URLs/templates but ignores literal route-registration strings', async () => {
    const dir = createFixtureDir('route-string-templates');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"actual","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'server.ts'), `
import fastify from "fastify";
const app = fastify();
const documentation = "https://example.test/health#fragment";
const fake = "app.get('/health', async () => ({status:'ok'}))";
const template = \`app.get('/openapi.json', () => \${JSON.stringify({})})\`;
app.get("/other", async () => ({ documentation, fake, template }));
`);
    const inventory = await scanInventory(dir);
    const target = { targetPath: dir, projectRoot: dir, repositoryRoot: null, componentPath: null, scanRoot: dir, hasGit: false, hasManifest: false, manifestVersion: null };
    const evidence = extractEvidence(target, inventory);
    expect(evidence.endpoints?.healthRoutes).toEqual([]);
    expect(evidence.endpoints?.docsRoutes).toEqual([]);
    const result = await assessProject({ targetPath: dir });
    expect(result.profile.id).toBe('node-fastify');
    expect(result.findings.find((entry) => entry.ruleId === 'RULE-API-HEALTH')?.classification).toBe('unknown');
  });

  it('does not turn absent captured content or a partial scan into absence or integrity proof', async () => {
    const dir = createFixtureDir('incomplete-capture');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"partial","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'app.ts'), 'import fastify from "fastify"; const app=fastify();');
    const report = await assessProject({ targetPath: dir, profile: 'node-fastify', maxFiles: 1 });
    expect(report.exitCode).toBe(2);
    expect(report.findings.some((finding) => finding.classification === 'missing')).toBe(false);
    expect(report.findings.some((finding) => finding.classification === 'aligned')).toBe(false);
    const inventory = await scanInventory(dir);
    inventory.contentMap!.delete('package.json');
    const target = { targetPath: dir, projectRoot: dir, repositoryRoot: null, componentPath: null, scanRoot: dir, hasGit: false, hasManifest: false, manifestVersion: null };
    const evidence = extractEvidence(target, inventory);
    expect(evidence.components?.some((entry) => entry.isSupported)).toBe(false);
    expect(evidence.dependencies?.matching).toBe(false);
    const findings = evaluateProfileRules(getSupportedProfile('node-fastify', loadPackagedProfilesCatalog())!, target, inventory, evidence);
    expect(findings.some((finding) => finding.classification === 'missing')).toBe(false);
  });

  it('does not mistake an unrelated type helper for an HTML schema response', async () => {
    const dir = createFixtureDir('response-association');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"api","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'app.ts'), `
import fastify from "fastify";
const app = fastify();
app.get("/openapi.json", async (request, reply) => {
  validator.type("text/html");
  return app.swagger();
});
`);
    const result = await assessProject({ targetPath: dir });
    const docs = result.findings.find((entry) => entry.ruleId === 'RULE-API-DOCS')!;
    expect(docs.classification).toBe('unknown');
    expect(docs.observed.facts).toMatchObject({ declaredHtmlSchema: false, runtimeResponseVerified: false });
  });

  it.each([
    'example = "from fastapi import FastAPI\\napp = FastAPI()"\n',
    'example = """\nfrom fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health(): return {"status":"ok"}\n"""\n',
    "# from fastapi import FastAPI\n# app = FastAPI()\nurl = 'https://example.test/#fastapi'\n"
  ])('rejects Python comment, escaped-string and docstring imports as application evidence', async (source) => {
    const dir = createFixtureDir('python-source-impostor');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname="api"\ndependencies=["fastapi==0.115.0"]\n');
    await writeFile(path.join(dir, 'main.py'), source);
    const result = await assessProject({ targetPath: dir });
    expect(result.observedProfiles.some((entry) => entry.id === 'python-fastapi')).toBe(false);
    expect(result.profile.status).toBe('unresolved');
  });

  it('reports malformed captured Compose declarations as unknown, not absent or aligned', async () => {
    const dir = createFixtureDir('malformed-compose');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"api","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'main.ts'), 'import server from "fastify"; const app = server();');
    await writeFile(path.join(dir, 'docker-compose.yml'), 'services: *missing');
    const result = await assessProject({ targetPath: dir });
    expect(result.exitCode).toBe(2);
    const finding = result.findings.find((entry) => entry.ruleId === 'RULE-CONT-COMPOSE')!;
    expect(finding.classification).toBe('unknown');
    expect(finding.observed.limitations.join(' ')).toContain('malformed');
  });

  it('does not report parent-project declarations absent when only a component was selected', async () => {
    const dir = createFixtureDir('component-project-evidence');
    await mkdir(path.join(dir, 'backend'), { recursive: true });
    await writeFile(path.join(dir, 'backend', 'package.json'), '{"name":"backend","dependencies":{"fastify":"^5.0.0"}}');
    await writeFile(path.join(dir, 'backend', 'server.ts'), 'import server from "fastify"; const app = server();');
    await writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  api:\n    image: api:1\n  database:\n    image: postgres:17\n');
    const result = await assessProject({ projectRoot: dir, componentPath: 'backend' });
    expect(result.profile.id).toBe('node-fastify');
    expect(result.inventory.files.some((file) => file.path === '../docker-compose.yml')).toBe(false);
    const compose = result.findings.find((entry) => entry.ruleId === 'RULE-CONT-COMPOSE')!;
    expect(compose.classification).toBe('unknown');
    expect(compose.observed.facts).toMatchObject({ projectScopeCaptured: false });
  });
});
