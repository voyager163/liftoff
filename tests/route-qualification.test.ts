import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { writeArtifacts } from '../src/file-system.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import {
  checkPrerequisite, closeHttpServer, compareSchemas, createRouteQualification, extractScalarSchemaReference,
  genAiPatterns, listenOnLoopback, qualifyAppRoutes, validateOpenApiShape, validateSchemaResponse
} from '../scripts/qualify-docs-routing.mjs';

const runner = new NodeCommandRunner();
let qualification: Awaited<ReturnType<typeof createRouteQualification>>;
beforeAll(async () => {
  qualification = await createRouteQualification({
    generators: { buildProjectPlan, buildArtifacts, writeArtifacts }, runner, env: process.env
  });
});
afterAll(async () => { await qualification?.close(); });

const schema = {
  openapi: '3.1.0', info: { title: 'Schema validator negative-control API', version: '1' },
  paths: { '/health': { get: { responses: { 200: { description: 'Healthy' } } } } },
  components: { schemas: { Status: { type: 'object', properties: { status: { type: 'string' } } } } }
};

describe('OpenSpec 8.7/15.5: schema identity and negative routing controls', () => {
  it('accepts only exact JSON media types, including case and charset parameters', () => {
    for (const mediaType of ['application/json', 'application/openapi+json', 'Application/JSON; charset=utf-8']) {
      expect(validateSchemaResponse(mediaType, JSON.stringify(schema))).toEqual(schema);
    }
    for (const mediaType of [null, undefined, '', 'text/plain', 'text/html', 'text/javascript',
      'application/jsonp', 'application/json+html', 'application/json, text/html', 'x-application/json']) {
      expect(() => validateSchemaResponse(mediaType, JSON.stringify(schema))).toThrow(/real JSON media type/);
    }
  });

  it('rejects SPA HTML 200 responses, even when mislabeled as JSON', () => {
    const html = '<!doctype html><html><body><div id="app">SPA Root</div></body></html>';
    expect(() => validateSchemaResponse('text/html', html)).toThrow(/real JSON media type/);
    expect(() => validateSchemaResponse('application/json', html)).toThrow(/Rejected SPA HTML response/);
    expect(() => validateSchemaResponse('application/openapi+json', '<body>Error</body>')).toThrow(/Rejected SPA HTML response/);
  });

  it('rejects malformed or empty OAS rather than accepting a version substring', () => {
    expect(() => validateSchemaResponse('application/json', '{invalid')).toThrow(/not valid JSON/);
    for (const value of [null, [], 'hello', 123]) expect(() => validateOpenApiShape(value)).toThrow(/non-null object/);
    for (const version of ['3.1.0junk', '3.1', '2.0', '', null]) {
      expect(() => validateOpenApiShape({ ...schema, openapi: version })).toThrow(/version string/);
    }
    expect(() => validateOpenApiShape({ openapi: '3.1.0' })).toThrow(/'info'/);
    expect(() => validateOpenApiShape({ ...schema, info: { title: '', version: '1' } })).toThrow(/non-empty string/);
    expect(() => validateOpenApiShape({ ...schema, paths: {} })).toThrow(/paths object is empty/);
    for (const paths of [[], null, 'paths']) expect(() => validateOpenApiShape({ ...schema, paths })).toThrow(/'paths'/);
    for (const paths of [{ health: {} }, { '/health': null }, { '/health': [] }]) {
      expect(() => validateOpenApiShape({ ...schema, paths })).toThrow(/invalid path/);
    }
    expect(() => validateOpenApiShape({ ...schema, components: null })).toThrow(/components must be an object/);
    expect(() => validateOpenApiShape({ ...schema, components: { schemas: [] } })).toThrow(/components.schemas/);
  });

  it('compares actual paths/components structurally and rejects losses or changes', () => {
    expect(() => compareSchemas(schema, structuredClone(schema))).not.toThrow();
    expect(() => compareSchemas(schema, {
      ...schema, paths: { ...schema.paths, '/extra': {} }
    })).toThrow(/Schema paths mismatch/);
    expect(() => compareSchemas(schema, {
      ...schema, paths: { '/health': { get: { summary: 'Changed' } } }
    })).toThrow(/Schema paths definitions differ/);
    expect(() => compareSchemas(schema, {
      ...schema, components: { schemas: { Status: { type: 'string' } } }
    })).toThrow(/Schema components content differs/);
    expect(() => compareSchemas(schema, { ...schema, info: { ...schema.info, title: 'Different application' } })).toThrow(/version\/info/);
    const reordered = {
      ...schema, components: { schemas: { Status: { properties: { status: { type: 'string' } }, type: 'object' } } }
    };
    expect(() => compareSchemas(schema, reordered)).not.toThrow();
  });

  it('distinguishes absent, null, undefined and empty components without normalization', () => {
    const { components: _components, ...absent } = schema;
    const empty = { ...absent, components: {} };
    for (const present of [empty, { ...absent, components: null }, { ...absent, components: undefined }]) {
      expect(() => compareSchemas(absent, present)).toThrow(/components presence mismatch/);
      expect(() => compareSchemas(present, absent)).toThrow(/components presence mismatch/);
    }
    expect(() => compareSchemas({ ...absent, components: null }, empty)).toThrow(/components content differs/);
    expect(() => compareSchemas(absent, { ...absent })).not.toThrow();
    expect(() => compareSchemas(empty, structuredClone(empty))).not.toThrow();
    expect(() => compareSchemas({ ...absent, components: null }, { ...absent, components: null })).toThrow(/components must be an object/);
  });

  it('extracts the Scalar reference without evaluating scripts and rejects ambiguous references', () => {
    expect(extractScalarSchemaReference('<script id="api-reference" data-url="./openapi.json"></script>')).toBe('./openapi.json');
    expect(extractScalarSchemaReference('Scalar.createApiReference("#app", {"url": "./openapi.json"})')).toBe('./openapi.json');
    expect(() => extractScalarSchemaReference('<html></html>')).toThrow(/unambiguous Scalar/);
    expect(() => extractScalarSchemaReference('<script data-url="./one.json"></script><script data-url="./two.json"></script>')).toThrow(/unambiguous Scalar/);
  });

  it.each([
    { name: 'origin-root schema reference', reference: '/openapi.json', error: /prefix-safe schema reference/ },
    { name: 'absolute forwarded-host schema reference', reference: 'https://untrusted.invalid/openapi.json', error: /prefix-safe schema reference/ },
    { name: 'broken extracted reference', reference: './missing.json', error: /Fetched extracted schema URL returns 200/ },
    { name: 'wrong reference even if it returns valid identical OAS', reference: './wrong.json', error: /canonical same-application schema/ },
    { name: 'SPA schema fallback with status 200', reference: './spa.json', error: /real JSON media type/ },
    { name: 'untrusted forwarded host in redirects', redirect: 'https://untrusted.invalid/scalar', error: /without trusting forwarded hosts/ },
    { name: 'query loss on canonicalization', dropQuery: true, error: /preserves exact path and complex query/ },
    { name: 'similar but incorrect canonical redirect', redirect: '../scalar-other', error: /preserves exact path/ }
  ])('rejects $name (negative-control HTTP server, not framework qualification)', async (defect) => {
    const server = createServer((request, response) => {
      const parsed = new URL(request.url!, 'http://localhost');
      if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
        const canonical = parsed.pathname.slice(0, -1).slice(1);
        response.writeHead(307, {
          location: defect.redirect ?? `../${canonical}${defect.dropQuery ? '' : parsed.search}`
        });
      } else if (parsed.pathname === '/scalar') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.write(`<script id="api-reference" data-url="${defect.reference ?? './openapi.json'}"></script>`);
      } else if (['/openapi.json', '/wrong.json'].includes(parsed.pathname)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(JSON.stringify(schema));
      } else if (parsed.pathname === '/spa.json') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<html><body>SPA</body></html>');
      } else response.writeHead(404);
      response.end();
    });
    try {
      const baseUrl = await listenOnLoopback(server);
      await expect(qualifyAppRoutes({
        name: defect.name, baseUrl, proxyUrl: baseUrl, proxyPrefix: '/tenant/pricing'
      })).rejects.toThrow(defect.error);
    } finally { await closeHttpServer(server); }
  });

  it('imports helpers without executing tools or loading built generator output', async () => {
    const script = pathToFileURL(path.resolve('scripts/qualify-docs-routing.mjs')).href;
    const result = await runner.run({
      executable: process.execPath,
      args: ['--input-type=module', '--eval', `
        import childProcess from 'node:child_process';
        import { registerHooks, syncBuiltinESMExports } from 'node:module';
        childProcess.spawn = childProcess.spawnSync = () => { throw new Error('Import-time process execution'); };
        syncBuiltinESMExports();
        registerHooks({ resolve(specifier, context, next) {
          if (specifier.includes('/dist/')) throw new Error('Import-time built output dependency');
          return next(specifier, context);
        } });
        await import(${JSON.stringify(script)});
        console.log('pure helper import');
      `]
    }, { cwd: qualification.directory, timeoutMs: 10_000, maxOutputBytes: 8192, ensureProcessTreeSettled: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.processTreeSettled).toBe(true);
    expect(result.stdout).toContain('pure helper import');
  });

  it('reports a missing required executable as prerequisite failure, never a skipped pass', async () => {
    await expect(checkPrerequisite(runner, path.join(qualification.directory, 'nonexistent-required-tool')))
      .rejects.toThrow(/Missing prerequisite/);
  });
});

describe('OpenSpec 8.7/15.5: current generated applications over real direct/proxy HTTP', () => {
  it.each(['go', 'node', 'python'])('qualifies the real %s standard backend', async (apiStack) => {
    const result = await qualification.qualify({ apiStack });
    expect(result.checks.length).toBeGreaterThan(100);
    expect(result.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  }, 180_000);

  it.each(genAiPatterns)('qualifies the real GenAI $pattern runtime without model credentials', async (input) => {
    const result = await qualification.qualify(input);
    expect(result.checks.length).toBeGreaterThan(100);
    expect(result.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  }, 180_000);
});
