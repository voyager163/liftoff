import path from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  approveModernManualNativeExecution, localExecutionStore, prepareModernManualNativeExecution
} from '../src/application/governance/modern-local-approval.js';
import { executeModernLocalExecution } from '../src/application/governance/modern-local-execution.js';
import * as manualPreparation from '../src/application/governance/modern-manual-preparation.js';
import * as workspaces from '../src/adapters/filesystem/modern-local-workspaces.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { generatedManualFixture, manualScopes } from './fixtures/modern-manual-project.js';

const lane = process.env.LIFTOFF_HCL_TEST_LANE ?? 'auto';
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (!['auto', 'portable', 'native'].includes(lane) || lane === 'native' && !qualified) {
  throw new Error('Invalid Manual control host/lane.');
}
const nativeIt = it.skipIf(!qualified || lane === 'portable');

describe('actual Manual control failures before any project or preparation dispatch', () => {
  nativeIt.each(['configuration-bytes', 'configuration-mode', 'replaced-output-root', 'unexpected-control'] as const)(
    'rejects %s in the newly owned environment', async mutation => {
      const fixture = await generatedManualFixture();
      const preview = await prepareModernManualNativeExecution(fixture.project, {
        kind: 'verify-manual-native', preparation: fixture.preparation
      });
      await approveModernManualNativeExecution(fixture.project, preview.fingerprint, manualScopes);
      const createEnvironment = manualPreparation.createManualInfrastructureEnvironment;
      const originalRun = NodeCommandRunner.prototype.run;
      let commandsBeforeMutation: number | undefined;
      const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
        // A broken admission guard must fail this test, never start its consented network preparation.
        if (commandsBeforeMutation !== undefined) throw new Error('Unexpected dispatch after the negative control mutation.');
        return originalRun.call(this, command, options);
      });
      vi.spyOn(manualPreparation, 'createManualInfrastructureEnvironment').mockImplementation(async (workspace, input) => {
        const environment = await createEnvironment(workspace, input);
        const controls = path.join(workspace, 'cache', 'manual-init');
        if (mutation === 'configuration-bytes') await writeFile(path.join(controls, 'tofu.rc'), 'changed\n');
        else if (mutation === 'configuration-mode') await chmod(path.join(controls, 'tofu.rc'), 0o644);
        else if (mutation === 'replaced-output-root') {
          const root = path.join(workspace, ...input.roots[0]!.dataPathParts);
          await rename(root, path.join(workspace, 'scratch', 'displaced-empty-data'));
          await mkdir(root, { mode: 0o700 });
        } else await writeFile(path.join(controls, 'unapproved'), 'not provider output');
        commandsBeforeMutation = run.mock.calls.length;
        return environment;
      });
      const result = await executeModernLocalExecution(fixture.project, preview.fingerprint);
      expect(commandsBeforeMutation).toBeGreaterThan(0);
      expect(run).toHaveBeenCalledTimes(commandsBeforeMutation!);
      expect(result).toMatchObject({ schemaVersion: 5, status: 'failed', complete: false,
        inputsUnchanged: true, cleanupComplete: true, retainedWorkspace: null, preparation: [],
        infrastructure: { outputs: [] } });
      expect(result.checks.every(check => check.status === 'blocked' || check.status === 'inapplicable')).toBe(true);
      for (const artifact of fixture.artifacts) {
        expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
      }
      fixture.retained.complete = true;
    }, 90_000
  );
  nativeIt('rejects a changed captured provider lock before workspace allocation or tool dispatch', async () => {
    const fixture = await generatedManualFixture();
    const preview = await prepareModernManualNativeExecution(fixture.project, {
      kind: 'verify-manual-native', preparation: fixture.preparation
    });
    await approveModernManualNativeExecution(fixture.project, preview.fingerprint, manualScopes);
    if (preview.schemaVersion !== 6) throw new Error('Missing native Manual input binding.');
    const lock = path.join(fixture.project, ...preview.manualInputs.infrastructure.roots[0]!.lockPathParts);
    const changed = await readFile(lock, 'utf8') + '\n';
    await writeFile(lock, changed);
    const create = vi.spyOn(workspaces, 'createModernLocalWorkspace');
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run').mockRejectedValue(new Error('Stale source must not dispatch.'));
    await expect(executeModernLocalExecution(fixture.project, preview.fingerprint)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(await localExecutionStore(fixture.project).readState(preview.fingerprint)).toBeNull();
    expect(await readFile(lock, 'utf8')).toBe(changed);
    fixture.retained.complete = true;
  }, 90_000);
  nativeIt('retains unknown settlement rather than turning a missing dispatcher response into success', async () => {
    const fixture = await generatedManualFixture();
    const preview = await prepareModernManualNativeExecution(fixture.project, {
      kind: 'verify-manual-native', preparation: fixture.preparation
    });
    await approveModernManualNativeExecution(fixture.project, preview.fingerprint, manualScopes);
    const createEnvironment = manualPreparation.createManualInfrastructureEnvironment, originalRun = NodeCommandRunner.prototype.run;
    let allocated = false, preventedDispatches = 0;
    vi.spyOn(manualPreparation, 'createManualInfrastructureEnvironment').mockImplementation(async (workspace, input) => {
      const environment = await createEnvironment(workspace, input);
      allocated = true;
      return environment;
    });
    vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation(async function (this: NodeCommandRunner, command, options) {
      if (allocated) {
        preventedDispatches++;
        throw new Error('Deliberately withheld dispatcher response; no actual project process started in this test.');
      }
      return originalRun.call(this, command, options);
    });
    const result = await executeModernLocalExecution(fixture.project, preview.fingerprint);
    expect(preventedDispatches).toBe(1);
    expect(result).toMatchObject({ schemaVersion: 5, status: 'uncertain', complete: false, failureCode: 'unsettled',
      inputsUnchanged: true, cleanupComplete: false, infrastructure: { outputs: [] } });
    expect(result.preparation).toHaveLength(1);
    expect(result.preparation[0]).toMatchObject({ status: 'uncertain', code: 'unsettled', processTreeSettled: false });
    expect(result.retainedWorkspace).not.toBeNull();
    expect((await lstat(result.retainedWorkspace!)).isDirectory()).toBe(true);
    expect((await localExecutionStore(fixture.project).readState(preview.fingerprint))?.value)
      .toMatchObject({ phase: 'uncertain' });
    for (const artifact of fixture.artifacts) {
      expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
    }
    // Only the test's pre-dispatch interceptor establishes that its owned fixture has no project child.
    fixture.retained.complete = true;
  }, 90_000);
});
