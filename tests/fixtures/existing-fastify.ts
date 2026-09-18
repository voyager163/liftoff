import assert from 'node:assert/strict';

export const pricingPolicy = "export const pricingCustomization = 'enterprise-volume-tier-applied';\n";
export const observationMarker = 'FASTIFY_APPLICATION_OBSERVATION ';

function replaceOnce(source: string, before: string, after: string): string {
  assert.equal(source.split(before).length, 2, `Expected one real generator insertion point: ${before}`);
  return source.replace(before, after);
}

export function existingFastifyHandlers(generatedApp: string) {
  let corrected = replaceOnce(generatedApp, "import Fastify from 'fastify';",
    "import Fastify from 'fastify';\nimport { pricingCustomization } from './pricing-policy.js';");
  corrected = replaceOnce(corrected, 'const scalarPage =', `export function calculateVolumeDiscount(quantity: number, unitCents: number): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantity required');
  if (quantity >= 100) return Math.round(unitCents * 0.80);
  if (quantity >= 20) return Math.round(unitCents * 0.90);
  return unitCents;
}

const scalarPage =`);
  corrected = replaceOnce(corrected, '  const statusSchema =', `  app.addSchema({
    $id: 'VolumeQuote',
    type: 'object',
    additionalProperties: false,
    required: ['quantity', 'unitCents', 'effectiveUnitCents', 'totalCents', 'customization'],
    properties: {
      quantity: { type: 'integer' },
      unitCents: { type: 'integer' },
      effectiveUnitCents: { type: 'integer' },
      totalCents: { type: 'integer' },
      customization: { type: 'string', const: 'enterprise-volume-tier-applied' }
    }
  });
  app.post<{ Body: { quantity: number; unitCents: number } }>('/api/v1/quote', {
    schema: {
      summary: 'Calculate volume discount quote',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['quantity', 'unitCents'],
        properties: {
          quantity: { type: 'integer', minimum: 1 },
          unitCents: { type: 'integer', minimum: 0 }
        }
      },
      response: { 200: { $ref: 'VolumeQuote#' } }
    }
  }, async (request) => {
    const { quantity, unitCents } = request.body;
    const effectiveUnitCents = calculateVolumeDiscount(quantity, unitCents);
    return { quantity, unitCents, effectiveUnitCents, totalCents: quantity * effectiveUnitCents, customization: pricingCustomization };
  });

  const statusSchema =`);
  // This existing service keeps its documentation plumbing out of its business OpenAPI document.
  for (const route of ['/scalar', '/scalar/', '/openapi.json', '/openapi.json/']) {
    corrected = replaceOnce(corrected, `app.get('${route}',`, `app.get('${route}', { schema: { hide: true } },`);
  }
  let before = replaceOnce(corrected, '../scalar', '/scalar');
  before = replaceOnce(before, '../openapi.json', '/openapi.json');
  before = replaceOnce(before, './openapi.json', '/openapi.json');
  const broken = replaceOnce(corrected,
    'if (quantity >= 20) return Math.round(unitCents * 0.90);', 'if (quantity >= 20) return 0;');
  return { before, corrected, broken };
}

export const fastifyVerificationSource = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, calculateVolumeDiscount } from '../dist/app.js';
import { buildApp as buildOriginalApp, calculateVolumeDiscount as originalDiscount } from '../dist/original-app.js';
import { loadConfig } from '../dist/config.js';
import {
  closeHttpServer, compareSchemas, fetchText, listenOnLoopback, qualifyAppRoutes,
  startPrefixStrippingProxy, validateSchemaResponse
} from './api-routing.mjs';

const applications = [
  { name: 'original', buildApp: buildOriginalApp, calculateVolumeDiscount: originalDiscount, corrected: false },
  { name: 'candidate', buildApp, calculateVolumeDiscount, corrected: true }
];
const quotes = [
  { quantity: 25, unitCents: 1000, effectiveUnitCents: 900, totalCents: 22500, customization: 'enterprise-volume-tier-applied' },
  { quantity: 150, unitCents: 1000, effectiveUnitCents: 800, totalCents: 120000, customization: 'enterprise-volume-tier-applied' }
];

test('executes the exported calculation from the actual candidate build', () => {
  for (const application of applications) {
    for (const [quantity, effective] of [[1, 1000], [19, 1000], [20, 900], [25, 900], [99, 900], [100, 800], [150, 800]]) {
      assert.equal(application.calculateVolumeDiscount(quantity, 1000), effective,
        application.name + ' exported volume-tier calculation at quantity ' + quantity);
    }
    assert.throws(() => application.calculateVolumeDiscount(0, 1000), /quantity required/);
    assert.throws(() => application.calculateVolumeDiscount(1.5, 1000), /quantity required/);
  }
});

test('preserves the actual Fastify business handler, plugins, schemas and direct/proxy routes', async () => {
  assert.equal(process.env.LIFTOFF_APPLICATION_VERIFICATION, '1');
  const backend = fileURLToPath(new URL('../', import.meta.url));
  const workspace = path.dirname(process.env.HOME);
  assert.equal(path.resolve(backend, '../..'), workspace, 'the compiled app must run in the registered private candidate');
  assert.equal(path.resolve(process.cwd()), path.resolve(backend));
  assert.equal(existsSync(path.join(backend, 'node_modules', 'live-project-only.txt')), false, 'live dependencies must not be copied');
  assert.equal(existsSync(path.join(backend, '..', '.env')), false, 'live configuration must not be copied');
  const require = createRequire(import.meta.url);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const name of ['fastify', '@fastify/swagger', '@fastify/cors']) {
    const installed = require(name + '/package.json');
    assert.equal(installed.version, lock.packages['node_modules/' + name].version, 'the actual generated lock must supply ' + name);
    const resolved = realpathSync(require.resolve(name + '/package.json'));
    assert.equal(resolved, path.join(backend, 'node_modules', ...name.split('/'), 'package.json'));
  }
  let originalSchema;
  for (const application of applications) {
  const app = await application.buildApp(loadConfig({
    DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost:6379/0',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173'
  }));
  let proxy;
  try {
    const cors = await app.inject({
      method: 'OPTIONS', url: '/api/v1/quote',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' }
    });
    assert.equal(cors.statusCode, 204);
    assert.equal(cors.headers['access-control-allow-origin'], 'http://localhost:5173');
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/quote', payload: { quantity: 0, unitCents: 1000 } });
    assert.equal(invalid.statusCode, 400, 'real Fastify JSON-schema validation must reject invalid quantity');
    for (const expected of quotes) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/quote', payload: { quantity: expected.quantity, unitCents: expected.unitCents }
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), expected, 'actual Fastify quote for quantity ' + expected.quantity);
    }

    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const proxyPrefix = '/tenant/pricing';
    proxy = startPrefixStrippingProxy(app.server.address().port, proxyPrefix);
    const proxyUrl = await listenOnLoopback(proxy);
    const actualQuotes = [];
    for (const visibleBase of [baseUrl, proxyUrl + proxyPrefix]) {
      for (const expected of quotes) {
        const response = await fetchText(visibleBase + '/api/v1/quote', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ quantity: expected.quantity, unitCents: expected.unitCents })
        });
        assert.equal(response.response.status, 200);
        assert.equal(response.response.headers.get('content-type').split(';')[0], 'application/json');
        const actual = JSON.parse(response.text);
        assert.deepEqual(actual, expected, 'real HTTP quote for quantity ' + expected.quantity);
        actualQuotes.push(actual);
      }
    }
    const response = await fetchText(baseUrl + '/openapi.json');
    assert.equal(response.response.status, 200);
    const schema = validateSchemaResponse(response.response.headers.get('content-type'), response.text);
    compareSchemas(schema, app.swagger());
    assert.ok(schema.paths['/health'].get);
    assert.ok(schema.paths['/ready'].get);
    assert.ok(schema.paths['/api/v1/quote'].post.requestBody);
    assert.ok(schema.paths['/api/v1/quote'].post.responses['200']);
    const quoteModel = Object.values(schema.components.schemas).find((model) => model.properties?.effectiveUnitCents);
    assert.equal(quoteModel.properties.customization.type, 'string');
    assert.equal(quoteModel.properties.effectiveUnitCents.type, 'integer');
    assert.ok(quoteModel.required.includes('totalCents'));
    if (application.corrected) compareSchemas(originalSchema, schema);
    else originalSchema = schema;
    const options = {
      name: 'Existing Fastify pricing service', baseUrl, proxyUrl, proxyPrefix,
      expectedSchemaRoutes: ['/health', '/ready', '/api/v1/quote'],
      expectedHttpRoutes: quotes.map((quote) => ({
        path: '/api/v1/quote', method: 'POST',
        body: { quantity: quote.quantity, unitCents: quote.unitCents }, status: 200, json: quote
      }))
    };
    let checks = 0;
    if (application.corrected) {
      const matrix = await qualifyAppRoutes(options);
      assert.ok(matrix.checks.every((check) => check.passed));
      checks = matrix.checks.length;
    } else {
      await assert.rejects(qualifyAppRoutes(options), /prefix-safe schema reference/);
      const slash = await fetchText(baseUrl + '/scalar/?tag=alpha&tag=beta&empty=');
      assert.equal(slash.response.headers.get('location'), '/scalar?tag=alpha&tag=beta&empty=');
    }
    console.log('FASTIFY_APPLICATION_OBSERVATION ' + JSON.stringify({
      schema, quotes: actualQuotes, checks, fastifyVersion: require('fastify/package.json').version,
      workspaceId: path.basename(workspace), routing: application.corrected ? 'passed' : 'defect-reproduced'
    }));
  } finally {
    try { if (proxy) await closeHttpServer(proxy); }
    finally { await app.close(); }
  }
  }
});
`;
