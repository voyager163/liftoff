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
  it.each(['--capabilities', '--inspect-layout'])('keeps repair %s free of telemetry and disclosure effects', async (flag) => {
    const hooks = telemetryHooks();
    const code = await runCli({
      argv: ['repair', flag, '--json'],
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
      stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 2
    });
    expect(code).toBe(2);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['installation', 'inspect'],
    ['installation', 'inspect', '--json'],
    ['installation', 'migrate', '--to', 'direct'],
    ['installation', 'migrate', '--to', 'homebrew-cask', '--json'],
    ['installation', 'migrate', '--to', 'winget', '--check'],
    ['installation', 'migrate', '--recover', '--json'],
    ['installation', 'migrate', '--help'],
    ['help', 'installation']
  ])('keeps installation preview %j free of disclosure and transport', async (...argv) => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv, stdout: new CaptureStream(), stderr: new CaptureStream(),
      telemetry: hooks, execute: async () => 2
    })).toBe(2);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it('emits only one aggregate event for exact machine-selected migration', async () => {
    const hooks = telemetryHooks();
    const argv = ['installation', 'migrate', '--to', 'direct', '--approve-plan', 'a'.repeat(64), '--json'];
    expect(await runCli({
      argv, stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 1
    })).toBe(1);
    expect(hooks.beforeCommand).toHaveBeenCalledOnce();
    expect(hooks.afterCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'installation', subcommand: 'migrate' }), 1, expect.any(Object)
    );
  });

  it.each([
    ['skills'],
    ['skills', 'list', '--json'],
    ['skills', 'inspect', '--json'],
    ['skills', 'plan', '--host', 'copilot'],
    ['skills', 'install', '--host', 'copilot', '--check'],
    ['skills', 'install', '--host', 'copilot', '--json'],
    ['skills', 'update', '--host', 'claude'],
    ['skills', 'remove', '--host', 'codex', '--check'],
    ['skills', 'migrate', '--host', 'copilot', '--scope', 'project', '--check'],
    ['skills', 'install', '--help'],
    ['help', 'skills']
  ])('excludes read-only skills inspection or preview %j', async (...argv) => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv, stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 2
    })).toBe(2);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it('retains one eligible event for an exact skills file operation without adding plan details', async () => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv: ['skills', 'install', '--host', 'copilot', '--approve-plan', 'a'.repeat(64), '--json'],
      stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 0
    })).toBe(0);
    expect(hooks.beforeCommand).toHaveBeenCalledOnce();
    expect(hooks.afterCommand).toHaveBeenCalledOnce();
  });

  it.each([
    ['adopt', 'existing-project', '--check'],
    ['adopt', 'existing-project', '--json'],
    ['adopt', 'existing-project'],
    ['adopt', '--help'],
    ['help', 'adopt']
  ])('does not disclose or collect during adoption previews %j', async (...argv) => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv, stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 2
    })).toBe(2);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it.each(['--approve-plan', '--verify-plan'])('records one aggregate adoption event for exact %s', async (flag) => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv: ['adopt', 'existing-project', flag, 'c'.repeat(64), '--json'],
      stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 0
    })).toBe(0);
    expect(hooks.beforeCommand).toHaveBeenCalledOnce();
    expect(hooks.afterCommand).toHaveBeenCalledOnce();
  });

  it.each([
    ['assess'],
    ['assess', 'existing-project', '--json'],
    ['assess', '--help'],
    ['help', 'assess']
  ])('keeps whole-project assessment free of telemetry and disclosure %j', async (...argv) => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv, stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 2
    })).toBe(2);
    expect(hooks.beforeCommand).not.toHaveBeenCalled();
    expect(hooks.afterCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['capabilities'],
    ['capabilities', '--json'],
    ['capabilities', '--help'],
    ['help', 'capabilities']
  ])('excludes capability negotiation from telemetry and notice state %j', async (...argv) => {
    const hooks = telemetryHooks();
    expect(await runCli({
      argv, stdout: new CaptureStream(), stderr: new CaptureStream(), telemetry: hooks,
      execute: async () => 0
    })).toBe(0);
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

  it('tracks only the aggregate upgrade command for every exit state', async () => {
    for (const expectedCode of [0, 1, 2]) {
      const hooks = telemetryHooks();
      const code = await runCli({
        argv: ['upgrade', '--check'],
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

  it.each([
    ['doctor', '--json'],
    ['upgrade', '--check', '--json'],
    ['update', '--check', '--json'],
    ['repair', '--check', '--json'],
    ['governance', 'plan', '--json'],
    ['governance', 'verify', '--json'],
    ['governance', 'apply-next', '--json'],
    ['plan', '--help']
  ])('passes a non-persisting disclosure policy for %j', async (...argv) => {
    const hooks = telemetryHooks();
    const stderr = new CaptureStream();
    expect(await runCli({
      argv, env: {}, stdout: new CaptureStream(), stderr, telemetry: hooks, execute: async () => 2
    })).toBe(2);
    expect(hooks.beforeCommand).toHaveBeenCalledWith(stderr, {}, { persistNotice: false });
    expect(hooks.afterCommand).toHaveBeenCalledOnce();
  });

  it('retains notice persistence for a write-capable command', async () => {
    const hooks = telemetryHooks();
    const stderr = new CaptureStream();
    await runCli({
      argv: ['init'], env: {}, stdout: new CaptureStream(), stderr,
      telemetry: hooks, execute: async () => 0
    });
    expect(hooks.beforeCommand).toHaveBeenCalledWith(stderr, {}, { persistNotice: true });
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
    expect(hooks.afterCommand).not.toHaveBeenCalled();
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
