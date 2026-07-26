import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('telemetry container contract', () => {
  it('pins Node 22 by digest and runs only the runtime package as non-root', async () => {
    const dockerfile = await readFile(path.join(serviceRoot, 'Dockerfile'), 'utf8');
    const pinnedBase = 'node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';
    expect(dockerfile.split(pinnedBase)).toHaveLength(3);
    expect(dockerfile).toContain('npm ci --prefix services/telemetry-ingest --ignore-scripts');
    expect(dockerfile).toContain('npm run package --prefix services/telemetry-ingest');
    expect(dockerfile).toContain('COPY --from=build --chown=node:node');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(dockerfile).not.toMatch(/ARG|ENV.*(?:TOKEN|KEY|SECRET|PASSWORD)/i);
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
});
