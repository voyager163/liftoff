import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { createUpdateContinuation } from '../src/application/update/command-guidance.js';
import { repairCommandAction } from '../src/application/repair/guidance.js';
import { validateStructuredContinuation } from '../src/protocol/continuation.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { CaptureStream } from './helpers.js';
import {
  cleanupUpdateTestRoots,
  createReviewedUpdateFixture,
  fingerprintUpdateTestProject
} from './reviewed-update-helpers.js';

const roots: string[] = [];
afterEach(async () => {
  await cleanupUpdateTestRoots();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

class NoSubprocesses implements CommandRunner {
  calls = 0;
  async run(command: ExternalCommand): Promise<CommandResult> {
    this.calls += 1;
    throw new Error(`Read-only continuation unexpectedly dispatched ${command.executable}.`);
  }
}

describe('legacy reports adapted to shared continuation context', () => {
  it('executes copied update and repair inspection actions against the original project from an unrelated cwd', async () => {
    const projectRoot = await createReviewedUpdateFixture({
      projectName: 'Continuation target', projectType: 'standard', apiStack: 'node',
      agents: ['copilot'], environments: ['dev'], governanceProfile: 'none'
    });
    const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-continuation-context-')));
    roots.push(workspace);
    const home = path.join(workspace, 'home');
    const elsewhere = path.join(workspace, 'unrelated');
    await Promise.all([mkdir(home), mkdir(elsewhere)]);
    const before = await fingerprintUpdateTestProject(projectRoot);
    const repair = repairCommandAction(projectRoot, ['--inspect-layout'], {
      id: 'inventory', label: 'Inspect', description: 'Read-only current application inventory.',
      scope: 'application-layout'
    });
    if (repair.kind !== 'command' || !repair.continuation) throw new Error('Missing repair continuation.');
    const runner = new NoSubprocesses();
    for (const continuation of [createUpdateContinuation(projectRoot, 'check'), repair.continuation]) {
      expect(validateStructuredContinuation(continuation)).toEqual(continuation);
      expect(continuation.requiredAuthority).toEqual([]);
      const stdout = new CaptureStream(), stderr = new CaptureStream();
      const code = await runCommand(parseArgs([
        ...continuation.args, ...(continuation.args.includes('--json') ? [] : ['--json'])
      ]), {
        cwd: elsewhere, stdout, stderr, runner, env: {},
        updatePreview: { homedir: home, env: {}, repositoryRoot: projectRoot }
      });
      expect(code, stderr.text()).not.toBe(1);
      const report = JSON.parse(stdout.text());
      expect(report.projectRoot).toBe(projectRoot);
      expect(report.schemaVersion).toBe(continuation.args[0] === 'update' ? 3 : 2);
      if (continuation.args[0] === 'update') {
        expect(report.continuations.length).toBeGreaterThan(0);
        for (const next of report.continuations) {
          expect(validateStructuredContinuation(next).project).toBe(projectRoot);
        }
      } else {
        for (const next of report.nextActions) {
          if (next.kind === 'command' && !next.requiresInput?.length) {
            expect(validateStructuredContinuation(next.continuation).project).toBe(projectRoot);
          }
        }
      }
    }
    expect(runner.calls).toBe(0);
    expect(await fingerprintUpdateTestProject(projectRoot)).toEqual(before);
  });

  it('distinguishes independent verification, preparation, network, file and original recovery authority', () => {
    const cases = [
      { args: ['--check'], authority: [] },
      { args: ['--verify-plan', 'a'.repeat(64), '--allow-dependency-preparation', '--allow-network'],
        authority: ['verification-plan-approval', 'dependency-preparation-consent', 'declared-network-consent'] },
      { args: ['--approve-plan', 'a'.repeat(64)], authority: ['file-plan-approval'] },
      { args: ['--recover'], authority: ['original-recorded-effect-recovery'] },
      { args: ['--live', '--subscription', '11111111-2222-3333-4444-555555555555', '--check'],
        authority: ['live-metadata-consent'] },
      { args: [], authority: ['reviewed-plan'] }
    ];
    for (const entry of cases) {
      const action = repairCommandAction('/work/project', entry.args, {
        id: 'repair', label: 'Repair', description: 'Only the selected authority.', approvalRequired: false
      }, 'linux');
      if (action.kind !== 'command' || !action.continuation) throw new Error('Missing complete command context.');
      expect(validateStructuredContinuation(action.continuation).requiredAuthority).toEqual(entry.authority);
      expect(action.approvalRequired).toBe(entry.authority.length > 0);
      expect(parseArgs([...action.continuation.args]).command).toBe('repair');
    }
  });

  it('never treats a placeholder command as an executable continuation', () => {
    const action = repairCommandAction('/work/project', ['--check', '--live', '--subscription', '<subscription-id>'], {
      id: 'select-subscription', label: 'Select actual subscription', description: 'Confirm the exact target first.',
      requiresInput: ['subscription-id'], approvalRequired: true
    }, 'linux');
    expect(action).not.toHaveProperty('continuation');
    expect(action).toMatchObject({ requiresInput: ['subscription-id'], approvalRequired: true });
  });

  it('requires the captured external patch digest instead of rereading or losing its configuration reference', () => {
    const action = repairCommandAction('/work/project', ['--application-patch', '/work/staging/proposal.json'], {
      id: 'review-patch', label: 'Review patch', description: 'Separate default-No consent.',
      configPath: '/work/staging/proposal.json', configDigest: 'c'.repeat(64)
    }, 'linux');
    if (action.kind !== 'command' || !action.continuation) throw new Error('Missing patch continuation.');
    expect(validateStructuredContinuation(action.continuation)).toMatchObject({
      configPath: '/work/staging/proposal.json', configDigest: 'c'.repeat(64),
      compatibilityIdentity: 'repair-contract-v1', requiredAuthority: ['reviewed-plan']
    });
    expect(() => repairCommandAction('/work/project', ['--application-patch', '/work/staging/proposal.json'], {
      id: 'missing-binding', label: 'Unsafe', description: 'Must not emit a complete command without captured identity.'
    }, 'linux')).toThrow(/reference and digest/);
  });
});
