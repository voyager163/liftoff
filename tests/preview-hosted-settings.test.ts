import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createGhReadonlyTransport, previewHostedSettings } from '../scripts/preview-hosted-settings.mjs';
import { HOSTED_READ_ENDPOINTS, HOSTED_STATE_LIMITS } from '../scripts/repository-security/hosted-state.ts';

function executor(stdout: string, error: unknown = null) {
  return vi.fn((_file, _args, _options, callback) => callback(error, stdout, 'PRIVATE STDERR'));
}
const http = (body: string, status = 200) => `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\nPrivate-Header: DO_NOT_RETAIN\r\n\r\n${body}`;

describe('production gh transport is bounded and GET-only', () => {
  it.each(Object.values(HOSTED_READ_ENDPOINTS))('allows only the fixed endpoint %s', async endpoint => {
    const execute = executor(http('{}'));
    const transport = createGhReadonlyTransport(execute);
    expect(await transport.get(endpoint)).toEqual({ kind: 'response', status: 200, body: '{}' });
    expect(Object.keys(transport)).toEqual(['get']);
    expect(execute).toHaveBeenCalledOnce();
    const [file, args, options] = execute.mock.calls[0]!;
    expect(file).toBe('gh');
    expect(args).toEqual([
      'api', '--hostname', 'github.com', '--method', 'GET', '--include',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint
    ]);
    expect(options).toMatchObject({
      shell: false, encoding: 'utf8', timeout: 10_000, maxBuffer: 80 * 1024,
      killSignal: 'SIGKILL', windowsHide: true,
      env: { GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    });
    for (const forbidden of ['--input', '--field', '--raw-field', '--paginate', 'PUT', 'POST', 'PATCH', 'DELETE']) {
      expect(args).not.toContain(forbidden);
    }
  });
  it.each([
    '/repos/other/repo/actions/permissions', '/repos/voyager163/liftoff/rulesets',
    '/repos/voyager163/liftoff/secret-scanning/alerts', '/repos/voyager163/liftoff/actions/permissions?ref=main',
    '/repos/voyager163/liftoff/actions/permissions/../workflow', 'https://github.com/repos/voyager163/liftoff',
    '--method=PUT', `${HOSTED_READ_ENDPOINTS.execution}\nPOST`
  ])('rejects arbitrary endpoint/method/ref input %s before execution', async endpoint => {
    const execute = executor(http('{}'));
    expect(await createGhReadonlyTransport(execute).get(endpoint)).toEqual({ kind: 'error', reason: 'invalid-response' });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409])('preserves HTTP %s without forwarding stderr or headers', async status => {
    const execute = executor(http('{"message":"PRIVATE BODY"}', status), { code: 1 });
    const transport = createGhReadonlyTransport(execute);
    const result = await previewHostedSettings([], transport);
    const preview = JSON.parse(result.output);
    expect(preview.settings.allowlist.observations[0].httpStatus).toBe(status);
    expect(preview.settings.allowlist.status).toBe('unavailable');
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toMatch(/PRIVATE|DO_NOT_RETAIN/);
  });
  it.each([
    [{ code: 'ENOENT', message: 'PRIVATE' }, '', 'transport-error'],
    [{ killed: true, signal: 'SIGKILL' }, http('{}'), 'timeout'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, http('{}'), 'output-limit'],
    [{ code: 1 }, http('{}'), 'transport-error'],
    [null, 'PRIVATE malformed response', 'invalid-response'],
    [null, `HTTP/2.0 200 OK\nX: ${'x'.repeat(16 * 1024)}\n\n{}`, 'invalid-response'],
    [null, 'x'.repeat(HOSTED_STATE_LIMITS.processOutputBytes + 1), 'output-limit'],
    [null, http('x'.repeat(HOSTED_STATE_LIMITS.responseBytes + 1)), 'output-limit']
  ])('sanitizes subprocess failures and bounds output', async (error, stdout, reason) => {
    const result = await createGhReadonlyTransport(executor(stdout as string, error)).get(HOSTED_READ_ENDPOINTS.workflow);
    expect(result).toEqual({ kind: 'error', reason });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('sanitizes synchronous subprocess launch failures', async () => {
    const result = await createGhReadonlyTransport(() => { throw new Error('PRIVATE'); }).get(HOSTED_READ_ENDPOINTS.immutable);
    expect(result).toEqual({ kind: 'error', reason: 'transport-error' });
  });
  it('accepts HTTP/1.1 and LF output without retaining headers', async () => {
    const result = await createGhReadonlyTransport(executor('HTTP/1.1 200 OK\nPrivate: SECRET\n\n{}'))
      .get(HOSTED_READ_ENDPOINTS.execution);
    expect(result).toEqual({ kind: 'response', status: 200, body: '{}' });
  });
});

describe('local preview command boundary', () => {
  it.each([['--apply'], ['--method', 'PUT'], ['--endpoint', HOSTED_READ_ENDPOINTS.execution], ['--ref', 'main'], ['--output', 'file']])(
    'rejects arguments before performing any GET', async (...args) => {
      const get = vi.fn();
      await expect(previewHostedSettings(args, { get })).rejects.toThrow('preview-takes-no-arguments');
      expect(get).not.toHaveBeenCalled();
    });
  it('returns JSON only and exits zero solely for complete observation, never authorization', async () => {
    const get = vi.fn(async (endpoint: string) => {
      const value = endpoint === HOSTED_READ_ENDPOINTS.execution
        ? { enabled: true, allowed_actions: 'all', sha_pinning_required: false }
        : endpoint === HOSTED_READ_ENDPOINTS.allowlist
          ? { github_owned_allowed: false, verified_allowed: false, patterns_allowed: [] }
          : endpoint === HOSTED_READ_ENDPOINTS.workflow
            ? { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }
            : endpoint === HOSTED_READ_ENDPOINTS.immutable
              ? { enabled: false, enforced_by_owner: false }
              : { approval_policy: 'first_time_contributors' };
      return { kind: 'response', status: 200, body: JSON.stringify(value) };
    });
    const result = await previewHostedSettings([], { get });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(HOSTED_STATE_LIMITS.previewBytes);
    expect(JSON.parse(result.output)).toMatchObject({
      status: 'blocked', readbackComplete: true, liveEffects: false, applyAuthorized: false,
      settings: { execution: { status: 'pending' }, forkApproval: { proposal: null } }
    });
    expect(get).toHaveBeenCalledTimes(10);
  });
  it('runs its actual entrypoint with rejected arguments without authentication or writes', () => {
    try {
      execFileSync(process.execPath, ['scripts/preview-hosted-settings.mjs', '--apply'], {
        shell: false, timeout: 10_000, maxBuffer: HOSTED_STATE_LIMITS.processOutputBytes,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
      expect.fail('must reject an apply command');
    } catch (error) {
      expect(error).toMatchObject({ status: 1, stdout: '' });
      expect(String((error as { stderr: string }).stderr)).toBe(
        'Hosted settings preview unavailable: arguments, local inputs or execution rejected. No writes attempted.\n'
      );
    }
  });
  it('registers only the new runtime inputs in the existing control plane', async () => {
    const controls = JSON.parse(await readFile(new URL('../security/control-plane.json', import.meta.url), 'utf8'));
    expect(controls.controlInputs).toContainEqual(['scripts', 'preview-hosted-settings.mjs']);
    expect(controls.controlInputs).toContainEqual(['scripts', 'repository-security', 'hosted-state.ts']);
    expect(controls.controlInputs).toContainEqual(['scripts', 'repository-security', 'hosted-settings-schema.ts']);
  });
});
