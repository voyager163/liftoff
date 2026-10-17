import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli as runProductCli, type CliTelemetryHooks } from '../src/cli.js';
import {
  releasedTelemetryVersion,
  runReleasedTelemetryCli as runCli
} from './fixtures/released-telemetry.js';
import { CaptureStream } from './helpers.js';
import * as telemetryConfig from '../src/telemetry/config.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function telemetryHooks(): CliTelemetryHooks & {
  beforeCommand: ReturnType<typeof vi.fn<CliTelemetryHooks['beforeCommand']>>;
  afterCommand: ReturnType<typeof vi.fn<CliTelemetryHooks['afterCommand']>>;
} {
  return {
    beforeCommand: vi.fn<CliTelemetryHooks['beforeCommand']>().mockResolvedValue(true),
    afterCommand: vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined)
  };
}

describe('CLI telemetry integration', () => {
  it('keeps unpublished builds free of ordinary disclosure, hooks, and transport', async () => {
    const notice = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion');
    const record = vi.spyOn(telemetryConfig, 'recordTelemetryNotice');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const hooks = telemetryHooks();
    const semantic = vi.fn<NonNullable<CliTelemetryHooks['afterSemanticCommand']>>();

    expect(await runProductCli({
      argv: ['--version'],
      env: {},
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      telemetry: { ...hooks, afterSemanticCommand: semantic },
      execute: async () => 0
    })).toBe(0);

    expect(notice).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts only a bounded release version through the programmatic observation seam', async () => {
    const hooks = telemetryHooks();
    const semantic = vi.fn<NonNullable<CliTelemetryHooks['afterSemanticCommand']>>();
    expect(await runProductCli({
      argv: ['--version'],
      env: {},
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      telemetryReleaseVersion: '0.13.0-dev.0',
      telemetry: { ...hooks, afterSemanticCommand: semantic },
      execute: async () => 0
    })).toBe(0);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();

    expect(await runProductCli({
      argv: ['--version'],
      env: {},
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      telemetryReleaseVersion: releasedTelemetryVersion,
      telemetry: { ...hooks, afterSemanticCommand: semantic },
      execute: async () => 0
    })).toBe(0);
    expect(hooks.beforeCommand).toHaveBeenCalledTimes(1);
    expect(semantic).toHaveBeenCalledWith(expect.objectContaining({
      cliVersion: releasedTelemetryVersion,
      outcome: 'success'
    }), {});
  });

  it('bounds a nonsettling legacy hook and never starts a later semantic observer after expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const stdout = new CaptureStream(), stderr = new CaptureStream(), hooks = telemetryHooks();
    hooks.afterCommand.mockImplementation(() => new Promise<void>(() => {}));
    const semantic = vi.fn<NonNullable<CliTelemetryHooks['afterSemanticCommand']>>().mockResolvedValue(undefined);
    let settled = false;
    const result = runCli({
      argv: ['update', '--check', '--json'], env: {}, stdout, stderr,
      telemetry: { ...hooks, afterSemanticCommand: semantic },
      execute: async (_parsed, context) => { context.stdout.write('{"status":"update-available"}\n'); return 2; }
    }).then(code => { settled = true; return code; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false); expect(hooks.afterCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: 'update' }), 2, {}
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(2); expect(semantic).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('{"status":"update-available"}\n'); expect(stderr.text()).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares the same absolute deadline across legacy and semantic observers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const hooks = telemetryHooks();
    hooks.afterCommand.mockImplementation(() => new Promise<void>(resolve => { setTimeout(resolve, 700); }));
    const semantic = vi.fn<NonNullable<CliTelemetryHooks['afterSemanticCommand']>>(() => new Promise<void>(() => {}));
    let settled = false;
    const result = runCli({
      argv: ['--version'], env: {}, stdout: new CaptureStream(), stderr: new CaptureStream(),
      telemetry: { ...hooks, afterSemanticCommand: semantic }, execute: async () => 0
    }).then(code => { settled = true; return code; });
    await vi.advanceTimersByTimeAsync(700);
    expect(semantic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the delivery deadline after ordinary execution, not at invocation startup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const hooks = telemetryHooks();
    hooks.afterCommand.mockImplementation(() => new Promise<void>(() => {}));
    const result = runCli({
      argv: ['plan'], env: {}, stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => { await new Promise<void>(resolve => { setTimeout(resolve, 5_000); }); return 0; }
    });
    await vi.advanceTimersByTimeAsync(4_999); expect(hooks.afterCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(hooks.afterCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('sends one schema2 semantic event and remains failure-isolated under the shared deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const notice = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockResolvedValue(1);
    const record = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockResolvedValue(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const result = runCli({
      argv: ['update', '--check', '--json'], env: {}, stdout, stderr,
      execute: async (_parsed, context) => {
        context.outcome?.record('attention-required'); context.stdout.write('{"status":"update-available"}\n'); return 2;
      }
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(2); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      schemaVersion: 2, event: 'command_executed', command: 'update',
      cliVersion: '0.12.3', outcome: 'attention-required'
    });
    expect(notice).toHaveBeenCalledTimes(1); expect(record).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('{"status":"update-available"}\n'); expect(stderr.text()).toBe('');
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([['help'], ['upgrade', '--check']].map(argv => ({ argv })))('keeps default $argv delivery command-only', async ({ argv }) => {
    vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockResolvedValue(1);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    expect(await runCli({ argv, env: {}, stdout: new CaptureStream(), stderr: new CaptureStream(), execute: async () => 0 })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/api\/events$/);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      schemaVersion: 2, command: argv[0], outcome: 'success'
    });
  });

  it.each([
    { outcome: 'success', code: 0 },
    { outcome: 'attention-required', code: 2 },
    { outcome: 'cancelled', code: 0 },
    { outcome: 'failure', code: 2 }
  ] as const)('preserves ordinary output/exit for semantic $outcome with an unreachable endpoint', async ({ outcome, code }) => {
    vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockResolvedValue(1);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private network diagnostic'));
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    expect(await runCli({
      argv: ['update', '--check', '--json'], env: {}, stdout, stderr,
      execute: async (_parsed, context) => {
        context.outcome?.record(outcome);
        context.stdout.write('{"ordinary":"result"}\n');
        context.stderr.write('ordinary diagnostic\n');
        return code;
      }
    })).toBe(code);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      schemaVersion: 2, event: 'command_executed', command: 'update',
      cliVersion: '0.12.3', outcome
    });
    expect(stdout.text()).toBe('{"ordinary":"result"}\n');
    expect(stderr.text()).toBe('ordinary diagnostic\n');
  });

  it.each([
    { env: { LIFTOFF_TELEMETRY: '0' } }, { env: { DO_NOT_TRACK: '1' } },
    { env: { CI: 'true' } }, { env: { CI: 'true', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0' } }
  ])('performs no default disclosure/config/transport work for $env', async ({ env }) => {
    const notice = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockResolvedValue(1);
    const record = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockResolvedValue(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected transport'));
    expect(await runCli({ argv: ['--version'], env, stdout: new CaptureStream(), stderr: new CaptureStream(), execute: async () => 0 })).toBe(0);
    expect(notice).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['assess'], ['assess', '--live'], ['assess', '--help'], ['help', 'assess'],
    ['capabilities'], ['capabilities', '--json'], ['capabilities', '--help'], ['help', 'capabilities'],
    ['governance', 'assess'], ['governance', 'assess', '--live'],
    ['governance', 'assess', '--live', '--help'], ['repair', '--capabilities', '--help'],
    ['repair', '--inspect-layout', '--help'], ['repair', '--inspect-layout', '--json'],
    ['doctor'], ['doctor', '--json'], ['doctor', '--help'], ['help', 'doctor'],
    ['upgrade', '--help'], ['help', 'upgrade']
  ].map(argv => ({ argv })))('preserves default telemetry-free discovery/help $argv', async ({ argv }) => {
    const notice = vi.spyOn(telemetryConfig, 'readTelemetryNoticeVersion').mockResolvedValue(1);
    const record = vi.spyOn(telemetryConfig, 'recordTelemetryNotice').mockResolvedValue(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected transport'));
    expect(await runCli({ argv, env: {}, stdout: new CaptureStream(), stderr: new CaptureStream(), execute: async () => 0 })).toBe(0);
    expect(notice).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['--capabilities', '--inspect-layout'])('keeps repair %s free of telemetry and disclosure effects', async (flag) => {
    const hooks = telemetryHooks();
    const code = await runCli({
      argv: ['repair', flag, '--json'],
      env: {},
      stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 0
    });
    expect(code).toBe(0);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it.for([[], ['--live'], ['--help']])('does not run telemetry or disclosure for assessment %s', async (flags) => {
    const hooks = telemetryHooks();
    const code = await runCli({
      argv: ['governance', 'assess', ...flags],
      env: {},
      stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 2
    });
    expect(code).toBe(2);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it('runs disclosure before execution and tracks the original success', async () => {
    const calls: string[] = [];
    const hooks: CliTelemetryHooks = {
      beforeCommand: async () => { calls.push('notice'); return true; },
      afterCommand: async (_parsed, code) => { calls.push(`track:${code}`); }
    };
    const code = await runCli({
      argv: ['infra', 'plan'],
      env: {},
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      telemetry: hooks,
      execute: async () => {
        calls.push('command');
        return 0;
      }
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['notice', 'command', 'track:0']);
  });

  it('tracks nonzero and cancellation exit semantics unchanged', async () => {
    for (const expectedCode of [0, 1, 2]) {
      const hooks = telemetryHooks();
      const code = await runCli({
        argv: ['update'],
        env: {},
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        telemetry: hooks,
        execute: async () => expectedCode
      });

      expect(code).toBe(expectedCode);
      expect(hooks.afterCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'update' }),
        expectedCode,
        expect.any(Object)
      );
    }
  });

  it('tracks only the aggregate upgrade command for every exit state', async () => {
    for (const expectedCode of [0, 1, 2]) {
      const hooks = telemetryHooks();
      const code = await runCli({
        argv: ['upgrade', '--check'],
        env: {},
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        telemetry: hooks,
        execute: async () => expectedCode
      });
      expect(code).toBe(expectedCode);
      expect(hooks.afterCommand).toHaveBeenCalledTimes(1);
      expect(hooks.afterCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'upgrade',
          flags: { check: true }
        }),
        expectedCode,
        expect.any(Object)
      );
    }
  });

  it('suppresses disclosure and tracking when replacement verification disables telemetry', async () => {
    const hooks = telemetryHooks();
    hooks.beforeCommand.mockResolvedValue(false);
    const code = await runCli({
      argv: ['--version'],
      env: {
        CI: 'true',
        DO_NOT_TRACK: '1',
        LIFTOFF_TELEMETRY: '0'
      },
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      telemetry: hooks,
      execute: async () => 0
    });
    expect(code).toBe(0);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it.each([{ LIFTOFF_TELEMETRY: '0' }, { DO_NOT_TRACK: '1' }, { CI: 'true' }])(
    'does not delegate opt-out enforcement to injected hooks for %j', async env => {
      const hooks = telemetryHooks();
      const semantic = vi.fn<NonNullable<CliTelemetryHooks['afterSemanticCommand']>>();
      expect(await runCli({
        argv: ['--version'], env, stdout: new CaptureStream(), stderr: new CaptureStream(),
        telemetry: { ...hooks, afterSemanticCommand: semantic }, execute: async () => 0
      })).toBe(0);
      expect(hooks.beforeCommand).not.toHaveBeenCalled();
      expect(hooks.afterCommand).not.toHaveBeenCalled();
      expect(semantic).not.toHaveBeenCalled();
    }
  );

  it('rechecks disablement after ordinary execution before invoking delivery hooks', async () => {
    const env: NodeJS.ProcessEnv = {}, hooks = telemetryHooks();
    const semantic = vi.fn<NonNullable<CliTelemetryHooks['afterSemanticCommand']>>();
    expect(await runCli({
      argv: ['--version'], env, stdout: new CaptureStream(), stderr: new CaptureStream(),
      telemetry: { ...hooks, afterSemanticCommand: semantic },
      execute: async () => { env.DO_NOT_TRACK = '1'; return 0; }
    })).toBe(0);
    expect(hooks.beforeCommand).toHaveBeenCalledTimes(1);
    expect(hooks.afterCommand).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
  });

  it('does not run telemetry when parsing fails', async () => {
    const hooks = telemetryHooks();
    const stderr = new CaptureStream();
    const code = await runCli({
      argv: ['unknown'],
      env: {},
      stdout: new CaptureStream(),
      stderr,
      telemetry: hooks
    });
    expect(code).toBe(1);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
    expect(stderr.text()).toContain('Unknown command');
  });

  it('keeps JSON stdout valid when disclosure uses stderr', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const hooks: CliTelemetryHooks = {
      beforeCommand: async (target) => { target.write('telemetry notice\n'); return true; },
      afterCommand: async () => undefined
    };
    const code = await runCli({
      argv: ['validate', '--json'],
      env: {},
      stdout,
      stderr,
      telemetry: hooks,
      execute: async (_parsed, context) => {
        context.stdout.write('{"valid":true}\n');
        return 0;
      }
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({ valid: true });
    expect(stderr.text()).toBe('telemetry notice\n');
  });

  it('contains telemetry hook failures and still reports command failures', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const hooks: CliTelemetryHooks = {
      beforeCommand: async () => { throw new Error('notice failed'); },
      afterCommand: async () => { throw new Error('track failed'); }
    };
    const code = await runCli({
      argv: ['doctor'],
      env: {},
      stdout,
      stderr,
      telemetry: hooks,
      execute: async () => {
        throw new Error('command failed');
      }
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain('command failed');
    expect(stderr.text()).not.toContain('notice failed');
    expect(stderr.text()).not.toContain('track failed');
  });

  it('runs the command but skips collection when disclosure is unsuccessful', async () => {
    const afterCommand = vi.fn<CliTelemetryHooks['afterCommand']>().mockResolvedValue(undefined);
    const code = await runCli({
      argv: ['help'],
      env: {},
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      telemetry: {
        beforeCommand: async () => false,
        afterCommand
      },
      execute: async () => 0
    });
    expect(code).toBe(0);
    expect(afterCommand).not.toHaveBeenCalled();
  });
});
