import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('telemetry container contract', () => {
  it('pins Node 24 by digest and runs only the runtime package as non-root', async () => {
    const dockerfile = await readFile(path.join(serviceRoot, 'Dockerfile'), 'utf8');
    const pinnedBase = 'node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';
    expect(dockerfile.split(pinnedBase)).toHaveLength(3);
    expect(dockerfile).toContain('npm ci --prefix services/telemetry-ingest --ignore-scripts');
    expect(dockerfile).toContain('npm run package --prefix services/telemetry-ingest');
    expect(dockerfile).toContain('COPY --from=build --chown=node:node');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(dockerfile).not.toMatch(
      /(?:ARG|ENV)\s+[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)/i
    );
  });

  it('contains no Azure Functions host dependency or configuration', async () => {
    const [packageJson, lockfile] = await Promise.all([
      readFile(path.join(serviceRoot, 'package.json'), 'utf8'),
      readFile(path.join(serviceRoot, 'package-lock.json'), 'utf8')
    ]);
    expect(packageJson).not.toContain('@azure/functions');
    expect(lockfile).not.toContain('@azure/functions');
    await expect(readFile(path.join(serviceRoot, 'host.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('warms managed identity before opening the production listener', async () => {
    const index = await readFile(path.join(serviceRoot, 'src', 'index.ts'), 'utf8');
    const warmUp = index.indexOf('await dependencies.warmUp()');
    const listen = index.indexOf('await listenTelemetryServer(server)');
    expect(warmUp).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(warmUp);
  });
});
