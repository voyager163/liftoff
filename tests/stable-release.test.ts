import { describe, expect, it, vi } from 'vitest';
import {
  isStableSemver,
  lookupStableRelease,
  StableReleaseLookupError
} from '../src/stable-release.js';

const metadata = (version: string, name = '@msn-control/liftoff') =>
  new Response(JSON.stringify({ name, version }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

describe('canonical stable release lookup', () => {
  it.each(['0.7.0', '0.8.0', '99.0.0'])(
    'accepts stable metadata for %s',
    async (version) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValue(metadata(version));
      await expect(lookupStableRelease({ fetch, timeoutMs: 100 }))
        .resolves.toEqual({ name: '@msn-control/liftoff', version });
      expect(String(fetch.mock.calls[0][0])).toBe(
        'https://registry.npmjs.org/%40msn-control%2Fliftoff/latest'
      );
      expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    }
  );

  it('rejects prerelease, malformed, missing, and wrong-package metadata', async () => {
    for (const response of [
      metadata('0.8.0-rc.1'),
      metadata('latest'),
      metadata(''),
      metadata('0.8.0', '@other/liftoff'),
      new Response('{}', { status: 200 }),
      new Response('[]', { status: 200 })
    ]) {
      await expect(lookupStableRelease({
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
        timeoutMs: 100
      })).rejects.toMatchObject({
        name: 'StableReleaseLookupError',
        code: 'invalid_metadata'
      });
    }
    expect(isStableSemver('1.2.3')).toBe(true);
    expect(isStableSemver('1.2.3-beta.1')).toBe(false);
  });

  it('distinguishes HTTP, malformed JSON, network, and timeout failures', async () => {
    await expect(lookupStableRelease({
      fetch: vi.fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('', { status: 503 })),
      timeoutMs: 100
    })).rejects.toMatchObject({ code: 'http_failure' });

    await expect(lookupStableRelease({
      fetch: vi.fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('{', { status: 200 })),
      timeoutMs: 100
    })).rejects.toMatchObject({ code: 'invalid_metadata' });

    await expect(lookupStableRelease({
      fetch: vi.fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error('private network detail')),
      timeoutMs: 100
    })).rejects.toMatchObject({
      code: 'network_failure',
      message: 'Canonical npm stable release lookup failed.'
    });

    const never: typeof globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        );
      });
    await expect(lookupStableRelease({ fetch: never, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it('validates timeout configuration without starting transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(lookupStableRelease({ fetch, timeoutMs: 0 }))
      .rejects.toBeInstanceOf(StableReleaseLookupError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
