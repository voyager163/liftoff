import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliTelemetryHooks } from '../src/cli.js';
import { CaptureStream } from './helpers.js';

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
  it('runs disclosure before execution and tracks the original success', async () => {
    const calls: string[] = [];
    const hooks: CliTelemetryHooks = {
      beforeCommand: async () => { calls.push('notice'); return true; },
      afterCommand: async (_parsed, code) => { calls.push(`track:${code}`); }
    };
    const code = await runCli({
      argv: ['infra', 'plan'],
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

  it('does not run telemetry when parsing fails', async () => {
    const hooks = telemetryHooks();
    const stderr = new CaptureStream();
    const code = await runCli({
      argv: ['unknown'],
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
