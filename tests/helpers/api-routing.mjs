import { createServer, request } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

const httpTimeoutMs = 5_000;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateOpenApiShape(schema, label = 'Schema') {
  if (!isObject(schema)) throw new Error(`${label} must be a non-null object, not an array or primitive`);
  if (Object.hasOwn(schema, 'openapi')
    ? typeof schema.openapi !== 'string' || !/^3\.\d+\.\d+$/.test(schema.openapi)
    : schema.swagger !== '2.0') {
    throw new Error(`${label} is missing a valid OpenAPI/Swagger version string`);
  }
  if (!isObject(schema.info)) throw new Error(`${label} is missing a valid 'info' object`);
  for (const key of ['title', 'version']) {
    if (typeof schema.info[key] !== 'string' || !schema.info[key].trim()) {
      throw new Error(`${label} info.${key} must be a non-empty string`);
    }
  }
  if (!isObject(schema.paths)) throw new Error(`${label} is missing a valid 'paths' object`);
  if (!Object.keys(schema.paths).length) throw new Error(`${label} paths object is empty; must contain declared routes`);
  for (const [key, item] of Object.entries(schema.paths)) {
    if (!key.startsWith('/') || !isObject(item)) throw new Error(`${label} contains invalid path '${key}'`);
  }
  if (Object.hasOwn(schema, 'components')) {
    if (!isObject(schema.components)) throw new Error(`${label} components must be an object when present (not null)`);
    for (const [key, value] of Object.entries(schema.components)) {
      if (!key.startsWith('x-') && !isObject(value)) throw new Error(`${label} components.${key} must be an object`);
    }
  }
}

export function validateSchemaResponse(contentType, bodyText) {
  const mediaType = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (!['application/json', 'application/openapi+json'].includes(mediaType)) {
    throw new Error(`Expected real JSON media type ('application/json' or 'application/openapi+json'), got '${contentType}'`);
  }
  if (typeof bodyText !== 'string' || !bodyText.trim()) throw new Error('Schema response body must be a non-empty string');
  if (/^\s*<(?:!doctype\s+html|html|body)\b/i.test(bodyText)) {
    throw new Error('Rejected SPA HTML response masquerading as schema with HTTP 200');
  }
  let schema;
  try { schema = JSON.parse(bodyText); }
  catch { throw new Error('Schema response is not valid JSON'); }
  validateOpenApiShape(schema, 'OpenAPI Document');
  return schema;
}

export function extractScalarSchemaReference(html) {
  const references = [...html.matchAll(/data-url=["']([^"']+)["']/gi)];
  if (!references.length) references.push(...html.matchAll(/"url"\s*:\s*["']([^"']+)["']/gi));
  if (references.length !== 1) throw new Error('Could not extract one unambiguous Scalar schema reference from documentation HTML');
  return references[0][1];
}

export function compareSchemas(direct, other) {
  if (!isObject(direct) || !isObject(other)) {
    validateOpenApiShape(direct);
    validateOpenApiShape(other);
  }
  if (Object.hasOwn(direct, 'components') !== Object.hasOwn(other, 'components')) {
    throw new Error('Schema components presence mismatch');
  }
  if (!isDeepStrictEqual(direct.components, other.components)) {
    throw new Error('Schema components content differs (including null/object mismatch)');
  }
  validateOpenApiShape(direct, 'Direct Schema');
  validateOpenApiShape(other, 'Compared Schema');
  if (!isDeepStrictEqual(Object.keys(direct.paths).sort(), Object.keys(other.paths).sort())) {
    throw new Error('Schema paths mismatch');
  }
  if (!isDeepStrictEqual(direct.paths, other.paths)) throw new Error('Schema paths definitions differ');
  if (direct.openapi !== other.openapi || direct.swagger !== other.swagger || !isDeepStrictEqual(direct.info, other.info)) {
    throw new Error('Schema version/info differs');
  }
}

export async function fetchText(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(httpTimeoutMs) });
  return { response, text: await response.text() };
}

export async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('HTTP listener startup exceeded its budget'));
    }, httpTimeoutMs);
    const onError = (error) => { clearTimeout(timer); reject(error); };
    server.once('error', onError);
    server.listen({ port: 0, host: '127.0.0.1', signal: controller.signal }, () => {
      clearTimeout(timer);
      server.off('error', onError);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

export async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned HTTP server did not close; fixture must be retained')), httpTimeoutMs);
    server.close((error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
    server.closeAllConnections();
  });
}

export function startPrefixStrippingProxy(backendPort, prefix) {
  if (!prefix.startsWith('/') || prefix.endsWith('/')) throw new Error('Proxy prefix must be a non-root URL path without a trailing slash');
  return createServer((req, res) => {
    const rawUrl = req.url || '/';
    if (rawUrl === prefix || rawUrl.startsWith(`${prefix}/`)) {
      const upstream = request({
        hostname: '127.0.0.1', port: backendPort,
        path: rawUrl.slice(prefix.length) || '/', method: req.method,
        headers: { ...req.headers, 'x-forwarded-prefix': prefix }
      }, (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.setTimeout(httpTimeoutMs, () => upstream.destroy(new Error('Upstream request timed out')));
      upstream.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Proxy forward error: ${error.message}`);
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><div id="spa">SPA Root Catchall 200</div></body></html>');
    }
  });
}

export async function qualifyAppRoutes({
  name, baseUrl, proxyUrl, proxyPrefix, expectedSchemaRoutes = [], expectedHttpRoutes = []
}) {
  const results = { name, checks: [] };
  const check = (desc, passed, detail = '') => {
    results.checks.push({ desc, passed, detail });
    if (!passed) throw new Error(`[FAIL] ${name}: ${desc} - ${detail}`);
  };
  const queries = ['', '?tag=alpha&tag=beta&empty=&flag&encoded=a%20b%26c%3Dd&slash=%2f&literal=%252F&plus=a+b'];
  const untrustedHeaders = {
    'x-forwarded-host': 'untrusted.invalid:9443', 'x-forwarded-proto': 'https',
    forwarded: 'for=192.0.2.1;host=untrusted.invalid:9443;proto=https'
  };
  let canonicalSchema;

  const readSchema = async (url, headers = {}) => {
    const { response, text } = await fetchText(url, { headers });
    check('Fetched extracted schema URL returns 200', response.status === 200, `url: ${url}, status: ${response.status}`);
    const schema = validateSchemaResponse(response.headers.get('content-type'), text);
    check('Schema has exact JSON media type and valid nonempty OpenAPI', true);
    if (canonicalSchema) compareSchemas(canonicalSchema, schema);
    return schema;
  };

  const readDocs = async (url, visibleBase, headers) => {
    const { response, text } = await fetchText(url, { headers });
    check('Documentation returns 200 HTML without another redirect', response.status === 200 &&
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html', `url: ${url}, status: ${response.status}`);
    const reference = extractScalarSchemaReference(text);
    check('Scalar HTML has prefix-safe schema reference', !/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(reference), `reference: ${reference}`);
    const resolved = new URL(reference, url);
    check('Schema reference stays within the actual origin', resolved.origin === new URL(visibleBase).origin, resolved.href);
    const schema = await readSchema(resolved, headers);
    check('Scalar references the canonical same-application schema, not an alias',
      resolved.href === `${visibleBase}/openapi.json`, `reference: ${reference}, resolved: ${resolved.href}`);
    return schema;
  };

  canonicalSchema = await readDocs(`${baseUrl}/scalar`, baseUrl, {});
  for (const visibleBase of [baseUrl, `${proxyUrl}${proxyPrefix}`]) {
    for (const headers of [{}, untrustedHeaders]) {
      for (const query of queries) {
        for (const route of ['scalar', 'openapi.json']) {
          const canonical = `${visibleBase}/${route}${query}`;
          const read = (url) => route === 'scalar' ? readDocs(url, visibleBase, headers) : readSchema(url, headers);
          compareSchemas(canonicalSchema, await read(canonical));
          const slashUrl = `${visibleBase}/${route}/${query}`;
          const { response } = await fetchText(slashUrl, { headers });
          check('Trailing-slash route returns a 307/308 redirect', [307, 308].includes(response.status), `url: ${slashUrl}, status: ${response.status}`);
          const location = response.headers.get('location');
          check('Redirect location preserves exact path and complex query without trusting forwarded hosts',
            location === `../${route}${query}`, `location: ${location}`);
          const followed = new URL(location, slashUrl).href;
          check('Following redirect preserves the exact visible prefix and query', followed === canonical, followed);
          compareSchemas(canonicalSchema, await read(followed));
          check('Canonical and followed routes preserve schema paths/components presence and content', true);
        }
      }
    }
    for (const entry of expectedHttpRoutes) {
      const route = typeof entry === 'string' ? { path: entry, status: 200 } : entry;
      const { response, text } = await fetchText(`${visibleBase}${route.path}`, {
        method: route.method ?? 'GET',
        headers: { ...untrustedHeaders, ...(route.body ? { 'content-type': 'application/json' } : {}) },
        ...(route.body ? { body: JSON.stringify(route.body) } : {})
      });
      check(`Business route ${route.method ?? 'GET'} ${route.path} has its exact expected status`,
        response.status === route.status, `status: ${response.status}`);
      if (route.json !== undefined) {
        check(`Business route ${route.path} preserves its response`, isDeepStrictEqual(JSON.parse(text), route.json), text);
      }
      if (route.jsonFields !== undefined) {
        const actual = JSON.parse(text);
        check(`Business route ${route.path} preserves its declared fields`,
          Object.entries(route.jsonFields).every(([key, value]) => isDeepStrictEqual(actual[key], value)), text);
      }
      if (route.status === 422) {
        check(`GenAI route ${route.path} validates the missing input without model credentials`,
          response.headers.get('content-type')?.split(';')[0] === 'application/json' &&
          Array.isArray(JSON.parse(text).detail) && JSON.parse(text).detail.length > 0, text);
      }
    }
  }
  for (const route of expectedSchemaRoutes) {
    check(`Schema preserves route ${route}`, Object.hasOwn(canonicalSchema.paths, route), Object.keys(canonicalSchema.paths).join(', '));
  }
  const spa = await fetchText(`${proxyUrl}/openapi.json`);
  check('Proxy origin-root fallback is actually HTML with HTTP 200', spa.response.status === 200 &&
    spa.response.headers.get('content-type')?.startsWith('text/html'), `status: ${spa.response.status}`);
  let rejected = false;
  try { validateSchemaResponse(spa.response.headers.get('content-type'), spa.text); }
  catch { rejected = true; }
  check('SPA catch-all HTML 200 is rejected as schema evidence', rejected);
  return results;
}
