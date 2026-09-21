import { SecurityEvidenceError } from './evidence.ts';

function fail(code: string): never { throw new SecurityEvidenceError(`generated-health-${code}`); }

/** Local process/configuration endpoints only, not external-service or orchestrator readiness. */
export async function verifyGeneratedHealthResponses(origin: string, frontend: boolean, request: typeof fetch = fetch) {
  let url: URL;
  try { url = new URL(origin); } catch { return fail('origin'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      Number(url.port) < 1 || Number(url.port) > 65535) fail('origin');
  const fetchBody = async (target: string) => {
    try {
      const selected = new URL(target, origin);
      if (selected.origin !== url.origin || selected.username || selected.password) fail('external-target');
      const response = await request(selected, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (!response.ok || !response.body) fail('status');
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 4 * 1024 * 1024) { await reader.cancel(); fail('body-limit'); }
          chunks.push(chunk.value);
        }
        return { body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          contentType: response.headers.get('content-type') };
      } finally { reader.releaseLock(); for (const chunk of chunks) chunk.fill(0); }
    } catch (error) {
      if (error instanceof SecurityEvidenceError) throw error;
      return fail('request-or-body');
    }
  };
  if (frontend) {
    const response = await fetchBody('/');
    if (!response.contentType?.includes('text/html') || !/\bid=["']app["']/.test(response.body)) fail('frontend-index');
    const entry = /<script\b[^>]*\bsrc=["']([^"']+)["']/.exec(response.body)?.[1];
    if (!entry) fail('frontend-entry');
    const asset = await fetchBody(entry);
    if (!/(?:java|ecma)script/i.test(asset.contentType ?? '') || !asset.body.trim()) fail('frontend-module');
    return ['frontend-index', 'local-frontend-module'] as const;
  }
  for (const endpoint of ['/health', '/ready', '/openapi.json']) {
    const response = await fetchBody(endpoint);
    let document: unknown;
    try { document = JSON.parse(response.body); } catch { return fail('json'); }
    if (!document || typeof document !== 'object' || Array.isArray(document)) fail('schema');
    if (endpoint === '/openapi.json') {
      if (!('openapi' in document) || typeof document.openapi !== 'string' || !/^3\.[0-9]+\.[0-9]+$/.test(document.openapi)) fail('openapi');
    } else if (!('status' in document) || document.status !== (endpoint === '/health' ? 'ok' : 'ready')) fail('status-semantic');
  }
  return ['health-ok', 'ready-ready', 'openapi-v3'] as const;
}
