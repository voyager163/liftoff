import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../src/application/context.js';
import type { SelfUpgradeRequest } from '../src/application/upgrade/self-upgrade.js';
import { executeUpgrade } from '../src/application/upgrade/use-case.js';
import type { SelfUpgradeResult } from '../src/domain/distribution/liftoff-upgrade.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream } from './helpers.js';

// Production never injects `context.selfUpgrade`, so the default executor is the
// shipped path. Only the orchestration entry point is replaced, so no npm runs.
const runSelfUpgrade = vi.hoisted(() => vi.fn());

vi.mock('../src/application/upgrade/self-upgrade.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/application/upgrade/self-upgrade.js')>()),
  runSelfUpgrade
}));

const current: SelfUpgradeResult = {
  schemaVersion: 1, mode: 'check', status: 'current', currentVersion: liftoffVersion, reasonCode: 'current'
};

const context = (overrides: Partial<ExecutionContext> = {}): ExecutionContext =>
  ({ cwd: '/', stdout: new CaptureStream(), stderr: new CaptureStream(), ...overrides }) as unknown as ExecutionContext;

beforeEach(() => {
  runSelfUpgrade.mockReset();
});

describe('default upgrade executor', () => {
  it('delegates to the orchestration with exactly the context environment and no other host overrides', async () => {
    runSelfUpgrade.mockResolvedValue(current);
    const environment = { PATH: '/fixture/bin', npm_config_registry: 'https://registry.example.test/' };
    const value = context({ env: environment });

    await expect(executeUpgrade({ mode: 'check', json: true }, value)).resolves.toBe(current);

    expect(runSelfUpgrade).toHaveBeenCalledTimes(1);
    const [request, dependencies] = runSelfUpgrade.mock.calls[0] as [SelfUpgradeRequest, { environment: NodeJS.ProcessEnv }];
    expect(request).toEqual({
      mode: 'check', currentVersion: liftoffVersion, stdout: value.stdout, stderr: value.stderr, json: true
    });
    expect(Object.keys(dependencies)).toEqual(['environment']);
    expect(dependencies.environment).toBe(environment);
  });

  it('falls back to the process environment only when the context carries none', async () => {
    runSelfUpgrade.mockResolvedValue(current);

    await executeUpgrade({ mode: 'check', json: true }, context());

    expect(runSelfUpgrade.mock.calls[0]?.[1]).toEqual({ environment: process.env });
    expect((runSelfUpgrade.mock.calls[0]?.[1] as { environment: NodeJS.ProcessEnv }).environment).toBe(process.env);
  });

  it('sends no progress callbacks for a human request without an observer', async () => {
    runSelfUpgrade.mockResolvedValue({ ...current, mode: 'apply' });

    await executeUpgrade({ mode: 'apply', json: false }, context({ env: {} }));

    expect(Object.keys(runSelfUpgrade.mock.calls[0]?.[0] as SelfUpgradeRequest).sort())
      .toEqual(['currentVersion', 'json', 'mode', 'stderr', 'stdout']);
  });

  it('turns a rejected default orchestration into the stable schema-1 failure instead of rethrowing', async () => {
    runSelfUpgrade.mockRejectedValue(new Error('fixture orchestration failure'));

    await expect(executeUpgrade({ mode: 'apply', json: true }, context({ env: {} }))).resolves.toEqual({
      schemaVersion: 1, mode: 'apply', status: 'failed', currentVersion: liftoffVersion, reasonCode: 'verification_failed'
    });
  });
});
