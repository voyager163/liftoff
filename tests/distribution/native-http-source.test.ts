import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpNativeArtifactSource, nativeArtifactMaximumRedirects
} from '../../src/adapters/distribution/native-release-client.js';

const initial = 'https://github.com/voyager163/liftoff/releases/download/v0.13.0/manifest.json';
const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/1234/fixture';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('bounded explicit GitHub asset delivery', () => {
  it('uses the default fetch path across a GitHub asset redirect without forwarding caller credentials', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'must-not-be-forwarded');
    vi.stubEnv('GH_TOKEN', 'must-not-be-forwarded');
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, options });
      if (url === initial) return new Response(null, {
        status: 302, headers: { location: `${cdn}?sig=server-issued-asset-query`, 'set-cookie': 'not-forwarded=1' }
      });
      return new Response('exact final bytes');
    };
    vi.stubGlobal('fetch', fetchFn);
    expect((await new HttpNativeArtifactSource().readBytes(initial, 64)).toString()).toBe('exact final bytes');
    expect(calls.map((call) => call.url)).toEqual([initial, `${cdn}?sig=server-issued-asset-query`]);
    for (const call of calls) {
      expect(call.options).toMatchObject({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(call.options?.headers).toEqual({
        Accept: 'application/octet-stream, application/json', 'User-Agent': 'liftoff-cli'
      });
    }
  });

  it.each([
    'http://release-assets.githubusercontent.com/github-production-release-asset/1234/fixture',
    'https://unregistered.example/payload',
    'https://release-assets.githubusercontent.com.attacker.example/github-production-release-asset/1234/fixture',
    'https://user:secret@release-assets.githubusercontent.com/github-production-release-asset/1234/fixture',
    'https://release-assets.githubusercontent.com:444/github-production-release-asset/1234/fixture',
    'https://release-assets.githubusercontent.com/not-a-release-asset/fixture',
    'https://github.com/another/repository/releases/download/v1.0.0/payload',
    `${cdn}#fragment`,
    '/relative/redirect'
  ])('rejects unregistered redirect %s before contacting it', async (location) => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(new HttpNativeArtifactSource(fetchFn).readBytes(initial, 64)).rejects.toMatchObject({ kind: 'redirect_rejected' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not turn arbitrary configured HTTPS origins into redirect authorities', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: cdn } }));
    await expect(new HttpNativeArtifactSource(fetchFn).readBytes('https://approved.example/index.json', 64))
      .rejects.toMatchObject({ kind: 'redirect_rejected' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('bounds redirect hops and refuses loops or a changed CDN asset path', async () => {
    let calls = 0;
    const endless: typeof fetch = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: `${cdn}?attempt=${calls}` } });
    };
    await expect(new HttpNativeArtifactSource(endless).readBytes(initial, 64)).rejects.toMatchObject({ kind: 'redirect_rejected' });
    expect(calls).toBe(nativeArtifactMaximumRedirects + 1);
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: cdn } }));
    await expect(new HttpNativeArtifactSource(loop).readBytes(initial, 64)).rejects.toMatchObject({ kind: 'redirect_rejected' });
    expect(loop).toHaveBeenCalledTimes(2);
    let changed = 0;
    await expect(new HttpNativeArtifactSource(async () => new Response(null, {
      status: 302, headers: { location: ++changed === 1 ? cdn : `${cdn}-other` }
    })).readBytes(initial, 64)).rejects.toMatchObject({ kind: 'redirect_rejected' });
    expect(changed).toBe(2);
  });

  it('keeps one deadline across redirect and body work', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const fetchFn: typeof fetch = async () => ++requests === 1
      ? new Response(null, { status: 302, headers: { location: cdn } })
      : new Response(new ReadableStream<Uint8Array>({ pull() {} }));
    const pending = new HttpNativeArtifactSource(fetchFn, 20).readBytes(initial, 64);
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(requests).toBe(2);
  });

  it('applies the exact body bound after redirect and does not leak transport details', async () => {
    let requests = 0;
    const fetchFn: typeof fetch = async () => ++requests % 2 === 1
      ? new Response(null, { status: 302, headers: { location: cdn } })
      : new Response('12345');
    expect((await new HttpNativeArtifactSource(fetchFn).readBytes(initial, 5)).toString()).toBe('12345');
    await expect(new HttpNativeArtifactSource(fetchFn).readBytes(initial, 4)).rejects.toMatchObject({ kind: 'invalid_manifest' });
    await expect(new HttpNativeArtifactSource(async () => { throw new Error('secret-response-must-not-escape'); }).readBytes(initial, 64))
      .rejects.toThrow('Native source transport failed.');
    await expect(new HttpNativeArtifactSource().readBytes('https://127.0.0.1/file', 10)).rejects.toThrow(/public named/);
  });

  it.runIf(process.env.LIFTOFF_NATIVE_HTTP_INTEGRATION === '1')(
    'reads a real public GitHub release asset through the default anonymous transport, not native publication authority',
    async () => {
      const bytes = await new HttpNativeArtifactSource(undefined, 30_000).readBytes(
        'https://github.com/cli/cli/releases/download/v2.74.2/gh_2.74.2_checksums.txt', 1024 * 1024
      );
      expect(bytes.toString('utf8')).toMatch(/^[a-f0-9]{64}\s+gh_2\.74\.2_/mu);
    }, 35_000
  );
});
