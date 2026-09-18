import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstallationContinuation } from '../../src/application/distribution/continuations.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { validateStructuredContinuation } from '../../src/protocol/continuation.js';
import { parseArgs } from '../../src/args.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

async function reviewedFixture(name: string) {
  const value = await signedFixture(name);
  fixtures.push(value);
  const plan = await planInstallationMigration({
    toOwner: 'direct', detector: value.detector, receiptStore: value.store, runner: value.runner,
    candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher,
    now: value.reviewNow
  });
  return { value, plan };
}

describe('admitted installation structured continuations', () => {
  it('retains exact literal targets and the admitted candidate instead of the legacy PATH command', async () => {
    const { value, plan } = await reviewedFixture("continuation ' $(literal); paths");
    const original = JSON.stringify(plan);
    const calls = value.runner.calls.length;
    const continuation = createInstallationContinuation(plan, 'migrate');
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
    expect(continuation).toMatchObject({
      executable: path.join(value.candidate, 'bin', 'liftoff'), cwd: value.project,
      scope: 'installation', targetScope: 'installation', userInstallTarget: value.installRoot,
      requiredAuthority: ['exact-installation-plan'], compatibilityIdentity: plan.planFingerprint
    });
    expect(parseArgs([...continuation.args])).toMatchObject({
      command: 'installation', subcommand: 'migrate', positional: [],
      flags: {
        to: 'direct', candidate: value.candidate, destination: value.installRoot, launcher: value.launcher,
        'approve-plan': plan.planFingerprint
      }
    });
    expect(continuation.project).toBeUndefined();
    expect(continuation.args).not.toContain('--project');
    expect(continuation.args).not.toContain('--scope');
    expect(continuation.args).not.toContain('--recover');
    expect(value.runner.calls).toHaveLength(calls);
    expect(JSON.stringify(plan)).toBe(original);
    await access(value.legacyLauncher);
    await expect(access(value.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('prepares only read-only inspection for the selected installed launcher without migration authority', async () => {
    const { value, plan } = await reviewedFixture('inspection-continuation');
    const continuation = createInstallationContinuation(plan, 'inspect', true);
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
    expect(continuation).toMatchObject({
      executable: value.launcher, args: ['installation', 'inspect', '--json'],
      cwd: value.project, userInstallTarget: value.installRoot, targetScope: 'installation', requiredAuthority: []
    });
    expect(continuation.project).toBeUndefined();
    expect(continuation.args).not.toContain('update');
    expect(continuation.args).not.toContain('--approve-plan');
  });

  it('does not issue exact-plan guidance for cloned or caller-authored plans', async () => {
    const { plan } = await reviewedFixture('forged-continuation');
    expect(() => createInstallationContinuation({ ...plan }, 'migrate')).toThrow(/internally prepared/);
  });
});
