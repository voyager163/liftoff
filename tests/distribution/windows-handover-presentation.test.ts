import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/args.js';
import { installationCommand } from '../../src/cli/commands/installation.js';
import type { MigrationRecoveryInspection } from '../../src/application/distribution/recover-migration.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { createStructuredContinuation, validateStructuredContinuation } from '../../src/protocol/continuation.js';
import { PresentationSession } from '../../src/terminal.js';
import { CaptureStream } from '../helpers.js';

const observers = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('../../src/application/distribution/recover-migration.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/application/distribution/recover-migration.js')>(),
  inspectMigrationRecovery: observers.inspect
}));
afterEach(() => observers.inspect.mockReset());

function presentationFixture(json: boolean): MigrationRecoveryInspection {
  const root = 'C:\\Owned Installations';
  const destination = `${root}\\Liftoff`;
  const launcherPath = `${destination}\\bin\\liftoff.exe`;
  const payload = `${destination}\\versions\\0.13.0-${'a'.repeat(16)}`;
  const upgradeContinuation = createStructuredContinuation({
    executable: `${payload}\\bin\\liftoff.exe`, args: ['upgrade', ...json ? ['--json'] : []],
    cwd: root, scope: 'installation', targetScope: 'installation', userInstallTarget: destination,
    requiredAuthority: ['dedicated-owner-upgrade'], compatibilityIdentity: 'b'.repeat(64), platform: 'win32'
  });
  return {
    schemaVersion: 1, mode: 'recovery-inspection', operation: 'native-upgrade',
    recordId: '10000000-0000-4000-8000-000000000001',
    record: {
      schemaVersion: 1, operation: 'native-upgrade', operationId: '10000000-0000-4000-8000-000000000001',
      planFingerprint: 'b'.repeat(64), revision: 1, owner: 'direct', packageId: 'liftoff',
      previousVersion: '0.13.0', targetVersion: '0.14.0', manifestDigest: 'c'.repeat(64),
      provenanceDigest: 'd'.repeat(64), sourceDigest: 'e'.repeat(64), ownerDigest: 'f'.repeat(64),
      transactionRoot: root, destinationDirectory: destination, launcherPath,
      expiresAt: '2026-09-14T00:30:00.000Z', startedAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z', status: 'failed',
      completedEffects: ['stage-candidate'], uncertainEffects: ['install-target-owner'],
      retainedPaths: [payload], processSettlement: 'settled'
    },
    currentOwner: 'direct', remainingEffects: ['install-target-owner', 'verify-target-installation'],
    isRecoverable: true, legacyPackage: 'not-applicable', launcher: 'original', transaction: 'absent', issues: [],
    remedy: 'Close the affected stable launcher, then use this exact independently observed owned payload. Presentation fixture only; no Windows execution evidence.',
    upgradeContinuation
  };
}

describe('Windows close/handover guidance presentation only, not owner or host qualification', () => {
  it.each([false, true])('renders the exact versioned-PE retry without a new approval flag (JSON=%s)', async (json) => {
    const inspected = presentationFixture(json);
    const inspect = observers.inspect.mockResolvedValue(inspected);
    const stdout = new CaptureStream(), stderr = new CaptureStream();
    const cwd = path.resolve('tests');
    const code = await installationCommand(parseArgs([
      'installation', 'migrate', '--recover', ...json ? ['--json'] : []
    ]), {
      cwd, env: {}, stdout, stderr, installationDetector: new InstallationDetector({ cwd, env: {}, ownerAdapters: [] }),
      presentation: new PresentationSession({ stdout, stderr, env: {}, color: false })
    });
    expect(code).toBe(0);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ json }));
    const continuation = validateStructuredContinuation(inspected.upgradeContinuation);
    expect(continuation.args).toEqual(['upgrade', ...json ? ['--json'] : []]);
    expect(continuation.args).not.toContain('--approve-plan');
    expect(continuation.args).not.toContain('--project');
    expect(continuation.requiredAuthority).toEqual(['dedicated-owner-upgrade']);
    if (!('operationId' in inspected.record)) throw new Error('Presentation fixture must retain its native upgrade record.');
    expect(continuation.executable).not.toBe(inspected.record.launcherPath);
    if (json) {
      expect(JSON.parse(stdout.text())).toMatchObject({
        mode: 'recovery-inspection', status: 'inspected', nextActions: [continuation]
      });
      expect(stdout.text().trim().split('\n')).toHaveLength(1);
      expect(stderr.text()).toBe('');
    } else {
      expect(stdout.text()).toContain('Receipt-owned close/handover retry');
      expect(stdout.text()).toContain(continuation.displayCommand);
      expect(stdout.text()).toContain(continuation.cwd);
      expect(stdout.text()).not.toContain('--approve-plan');
    }
  });

  it('cannot invent a retry executable when read-only recovery cannot verify the owner or settlement', async () => {
    const { upgradeContinuation: _continuation, ...inspected } = presentationFixture(true);
    observers.inspect.mockResolvedValue({
      ...inspected, isRecoverable: false, launcher: 'changed', issues: ['Process settlement remains unconfirmed.'],
      remedy: 'Preserve the exact original record and all payloads.'
    });
    const stdout = new CaptureStream(), stderr = new CaptureStream(), cwd = path.resolve('tests');
    expect(await installationCommand(parseArgs(['installation', 'migrate', '--recover', '--json']), {
      cwd, env: {}, stdout, stderr, installationDetector: new InstallationDetector({ cwd, env: {}, ownerAdapters: [] }),
      presentation: new PresentationSession({ stdout, stderr, env: {}, color: false })
    })).toBe(1);
    expect(JSON.parse(stdout.text()).nextActions).toEqual([]);
  });
});
