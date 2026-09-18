import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAdmission } from '../../src/adapters/distribution/native-admission.js';
import { NativeReleaseClient } from '../../src/adapters/distribution/native-release-client.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { DirectInstallerAdapter } from '../../src/adapters/distribution/direct-installer-adapter.js';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { inspectMigrationRecovery } from '../../src/application/distribution/recover-migration.js';
import { runNativeOwnerUpgrade } from '../../src/application/distribution/native-upgrade.js';
import { parseManifest } from '../../src/application/project/manifest.js';
import {
  capturedTree, materializeReleasedFiles, releasedBytes, releasedCase
} from '../fixtures/released-baseline/corpus.js';
import { CaptureStream } from '../helpers.js';
import { signedFixture, writeFixtureFile, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const manifests = [
  [2, 'manifest-v2.json'],
  [3, 'manifest-v3.json'],
  [4, 'manifest-v4-genai.json'],
  [5, 'manifest-v5-standard-released.json'],
  [6, 'manifest-v6-genai-released.json'],
  [7, 'manifest-v7-governed-released.json']
] as const;
const retainedCases = [
  'activation-v1',
  'activation-v2-retained',
  'activation-v2-disposed-spec-kit',
  'activation-v3-with-v2-v1-history',
  'update-v0.11.2-schema1-interrupted',
  'update-v0.12.3-schema1-committed',
  'repair-v0.12.2-schema1-interrupted',
  'repair-v0.12.3-azure-schema2-committed',
  'repair-v0.12.3-application-schema2-interrupted'
] as const;

async function fixture(name: string) {
  const value = await signedFixture(name);
  fixtures.push(value);
  const original = releasedCase('activation-v3-local');
  const manifest = original.files.find((file) => file.path === 'liftoff.manifest.json');
  if (!manifest) throw new Error('The immutable released project must contain its original manifest.');
  await writeFixtureFile(path.join(value.project, manifest.path), releasedBytes(manifest), manifest.mode);
  await materializeReleasedFiles(value.project, original.files.filter((file) => file !== manifest));
  for (const [version, filename] of manifests) {
    const bytes = await readFile(new URL(`../fixtures/${filename}`, import.meta.url));
    expect(parseManifest(JSON.parse(bytes.toString('utf8'))).artifactVersion).toBe(version);
    await writeFixtureFile(path.join(value.project, 'older projects', `manifest-${version}`, 'liftoff.manifest.json'), bytes);
  }
  for (const id of retainedCases) {
    await materializeReleasedFiles(path.join(value.project, 'retained projects', id), releasedCase(id).files);
  }
  const before = await capturedTree(value.project);
  expect(before.some((file) => file.path === 'backend/package.json')).toBe(true);
  expect(before.some((file) => file.path === 'backend/package-lock.json')).toBe(true);
  expect(before.some((file) => file.path.startsWith('node_modules/'))).toBe(true);
  expect(before.some((file) => file.path.includes('/governance/history/'))).toBe(true);
  expect(before.some((file) => file.path.startsWith('openspec/') && file.path.endsWith('/tasks.md'))).toBe(true);
  expect(before.some((file) => file.path.endsWith('governance/activation-state.json'))).toBe(true);
  const options = {
    toOwner: 'direct' as const, detector: value.detector, receiptStore: value.store, runner: value.runner,
    candidatePath: value.candidate, destinationDirectory: value.installRoot, launcherPath: value.launcher,
    now: value.reviewNow
  };
  async function assertUnchanged() {
    expect(await capturedTree(value.project)).toEqual(before);
    expect(value.runner.calls.every((call) => {
      const cwd = call.options?.cwd;
      return cwd !== value.project && !cwd?.startsWith(`${value.project}${path.sep}`);
    })).toBe(true);
  }
  return { value, options, assertUnchanged };
}

describe('retained project preservation through native file transactions, not release qualification', () => {
  it('preserves exact released projects through reviewed npm handover and subsequent owner-preserving upgrade', async () => {
    const { value, options, assertUnchanged } = await fixture('released-project-handover');
    const plan = await planInstallationMigration(options);
    await assertUnchanged();
    const record = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(record.status, record.failure?.message).toBe('completed');
    await assertUnchanged();
    const previous = await value.store.loadDirectReceipt(value.installRoot);
    if (!previous) throw new Error('The actual migration did not establish the direct owner.');

    await value.registerRelease('0.14.0');
    value.trust.stableVersion = '0.14.0';
    const admission = new NativeAdmission({
      releaseClient: new NativeReleaseClient({ trust: value.trust, source: value.source }),
      runner: value.runner, env: value.env, cwd: value.project
    });
    const detector = new InstallationDetector({
      admission, runner: value.runner, env: value.env, cwd: value.project,
      entrypoint: path.join(previous.versionRoot, 'dist', 'cli.js'),
      receiptStore: value.store, ownerAdapters: [], npmAdapter: value.npmAdapter
    });
    const upgraded = await runNativeOwnerUpgrade({
      mode: 'apply', currentVersion: '0.13.0', stdout: new CaptureStream(), stderr: new CaptureStream(), json: true
    }, { detector, runner: value.runner, receiptStore: value.store });
    expect(upgraded).toMatchObject({ status: 'upgraded', owner: 'direct', targetVersion: '0.14.0' });
    expect((await value.store.loadDirectReceipt(value.installRoot))?.version).toBe('0.14.0');
    await access(previous.versionRoot);
    await assertUnchanged();
  }, 90_000);

  it('preserves original histories and state through interruption, read-only recovery and separately approved retry', async () => {
    const { value, options, assertUnchanged } = await fixture('released-project-recovery');
    const directInstaller = new DirectInstallerAdapter({
      admission: value.admission, receiptStore: value.store, runner: value.runner, env: value.env, cwd: value.project,
      onCheckpoint: async (checkpoint) => {
        if (checkpoint.phase === 'staged' && checkpoint.index === 1) throw new Error('Isolated native handover interruption.');
      }
    });
    const plan = await planInstallationMigration({ ...options, directInstaller });
    const failed = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(failed.status).toBe('failed');
    expect(failed.completedEffects).toContain('retire-legacy-package');
    await assertUnchanged();
    const privateRecords = await capturedTree(value.store.baseDirectory);
    const inspected = await inspectMigrationRecovery({ detector: value.detector, receiptStore: value.store });
    expect(inspected.record).toEqual(failed);
    expect(await capturedTree(value.store.baseDirectory)).toEqual(privateRecords);
    await assertUnchanged();

    const retry = await planInstallationMigration(options);
    expect(retry.planFingerprint).not.toBe(plan.planFingerprint);
    expect(retry.recovery).toMatchObject({ migrationId: failed.migrationId, sourceRetired: true });
    expect(retry.orderedEffects.some((effect) => effect.id === 'retire-legacy-package')).toBe(false);
    const completed = await executeInstallationMigration({ plan: retry, approvePlan: retry.planFingerprint });
    expect(completed.status, completed.failure?.message).toBe('completed');
    expect(value.runner.calls.filter((call) => call.command.args[0] === 'uninstall')).toHaveLength(1);
    expect(await value.store.loadMigrationRecord(failed.migrationId)).toEqual(failed);
    await value.store.assertNoPendingRecord();
    await assertUnchanged();
  }, 90_000);
});
