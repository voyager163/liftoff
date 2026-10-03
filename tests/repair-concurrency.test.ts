import { chmod, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as transactions from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { getUpdatePreviewDirectory } from '../src/adapters/filesystem/update-previews.js';
import { putApplicationFixtureFile } from './fixtures/repair-application.js';
import {
  TemporaryDirectories, ScriptedRunner, backendNpmCi, createCommandFlowFixture, historicalRepairPathParts, historicalRepairReceipt,
  isToolProbe, repairHuman, repairJson, snapshotTree, userRecordFiles, type CommandFlowFixture
} from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(async () => {
  vi.restoreAllMocks();
  await directories.cleanup();
});

async function verifiedPlan(options: Parameters<typeof createCommandFlowFixture>[1] = {}) {
  const f = await createCommandFlowFixture(await directories.make('lf conc '), options);
  const runner = new ScriptedRunner();
  const check = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
  const fingerprint = check.report.fingerprint!;
  const verified = await repairJson(f.root, ['--verify-plan', fingerprint], { home: f.home, runner });
  expect(verified.code, verified.report.blockers.join('; ')).toBe(0);
  return { f, runner, fingerprint, project: await snapshotTree(f.root) };
}

const historyRoot = (f: CommandFlowFixture) => path.join(f.root, '.liftoff', 'repair-history');
async function expectOriginalLayout(f: CommandFlowFixture): Promise<void> {
  expect(await readFile(path.join(f.root, ...f.source), 'utf8')).toBe(f.sourceBytes);
  expect(await readFile(path.join(f.root, ...f.check), 'utf8')).toBe(f.oldTest);
  await expect(lstat(path.join(f.root, ...f.target))).rejects.toMatchObject({ code: 'ENOENT' });
}
async function expectAppliedOnce(f: CommandFlowFixture, fingerprint: string): Promise<void> {
  expect(await readFile(path.join(f.root, ...f.target), 'utf8')).toBe(f.sourceBytes);
  expect(await readFile(path.join(f.root, ...f.check), 'utf8')).toBe(f.newTest);
  await expect(lstat(path.join(f.root, ...f.source))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(historyRoot(f))).sort()).toEqual([historicalRepairPathParts[2]!, fingerprint].sort());
  expect((await readdir(path.join(historyRoot(f), fingerprint))).sort()).toEqual(['manifest.json', 'receipt.json']);
  expect(await readFile(path.join(f.root, ...historicalRepairPathParts), 'utf8')).toBe(historicalRepairReceipt);
}
async function expectNoNewHistory(f: CommandFlowFixture): Promise<void> {
  expect(await readdir(historyRoot(f))).toEqual([historicalRepairPathParts[2]]);
  expect(await readFile(path.join(f.root, ...historicalRepairPathParts), 'utf8')).toBe(historicalRepairReceipt);
}
async function expectNoInterruptedTransaction(f: CommandFlowFixture, runner: ScriptedRunner): Promise<void> {
  const recovery = await repairJson(f.root, ['--recover'], { home: f.home, runner });
  expect(recovery.code).toBe(0);
  expect(recovery.report.message).toBe('No interrupted local repair transaction exists.');
}

describe('concurrent edits between verification and file approval', () => {
  it.each([
    ['source mode', async (f: CommandFlowFixture) => chmod(path.join(f.root, ...f.source), process.platform === 'win32' ? 0o444 : 0o755)],
    ['new empty directory', async (f: CommandFlowFixture) => mkdir(path.join(f.root, 'concurrent-directory'))],
    ['unrelated inventoried file', async (f: CommandFlowFixture) =>
      putApplicationFixtureFile(f.root, ['docs', 'concurrent.md'], 'concurrent developer edit\n')],
    ['newly occupied destination', async (f: CommandFlowFixture) =>
      putApplicationFixtureFile(f.root, f.target, 'export const concurrentDestination = true;\n')]
  ])('treats the reviewed patch as stale plan-only input after %s drift and preserves it', async (_name, drift) => {
    const { f, runner, fingerprint } = await verifiedPlan();
    await drift(f);
    const drifted = await snapshotTree(f.root);
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(2);
    expect(apply.report).toMatchObject({ status: 'blocked', committed: false });
    expect(apply.report.message).toContain('plan-only');
    expect(apply.report.blockers.join(' ')).toContain('stale inspection');
    expect(apply.report.backupPath).toBeUndefined();
    expect(await snapshotTree(f.root)).toEqual(drifted);
    await expectNoNewHistory(f);
    expect(runner.effects()).toHaveLength(1);
  });

  it('refuses the saved plan when staged replacement modes drift after verification', async () => {
    const { f, runner, fingerprint, project } = await verifiedPlan();
    await chmod(path.join(f.stage, 'replacement-0.mjs'), process.platform === 'win32' ? 0o444 : 0o644);
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(1);
    expect(apply.report).toMatchObject({ status: 'failed', committed: false });
    expect(apply.report.blockers.join(' ')).toContain('changed after preview');
    expect(apply.report.backupPath).toBeUndefined();
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(runner.effects()).toHaveLength(1);
  });
});

describe('concurrent writers around the reviewed transaction', () => {
  it('stops before any project write when an edit lands while the mutation lock is acquired', async () => {
    const { f, runner, fingerprint } = await verifiedPlan();
    const actual = transactions.applyReviewedUpdateTransaction;
    vi.spyOn(transactions, 'applyReviewedUpdateTransaction').mockImplementation(async (...args) => {
      await putApplicationFixtureFile(f.root, ['docs', 'concurrent.md'], 'edited while the lock was requested\n');
      return actual(...args);
    });
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(1);
    expect(apply.report).toMatchObject({ status: 'failed', committed: false });
    expect(apply.report.blockers.join(' ')).toContain('no substitute plan was approved');
    expect(apply.report.backupPath).toBeDefined();
    expect(path.relative(f.root, apply.report.backupPath!).startsWith('..')).toBe(true);
    expect((await lstat(apply.report.backupPath!)).isFile()).toBe(true);
    await expectOriginalLayout(f);
    expect(await readFile(path.join(f.root, 'docs', 'concurrent.md'), 'utf8')).toBe('edited while the lock was requested\n');
    await expectNoNewHistory(f);
    vi.restoreAllMocks();
    await expectNoInterruptedTransaction(f, runner);
  });

  it('refuses while a cooperating writer holds the project lock, then applies the unchanged plan once', async () => {
    const { f, runner, fingerprint, project } = await verifiedPlan();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const writer = withProjectMutationLock(f.root, async () => { acquired(); await held; });
    await ready;
    let busy;
    try { busy = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner }); }
    finally {
      release();
      await writer;
    }
    expect(busy.code).toBe(1);
    expect(busy.report).toMatchObject({ status: 'failed', committed: false });
    expect(busy.report.blockers.join(' ')).toContain('Another cooperating Liftoff mutation is already in progress');
    expect(await snapshotTree(f.root)).toEqual(project);
    const retry = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(retry.code, retry.report.blockers.join('; ')).toBe(0);
    expect(retry.report).toMatchObject({ status: 'applied', committed: true });
    await expectAppliedOnce(f, fingerprint);
    expect(runner.effects()).toHaveLength(1);
  });

  it('never overwrites an existing immutable history record for the same fingerprint', async () => {
    const { f, runner, fingerprint } = await verifiedPlan();
    const forged = '{"forged":"history is not approval"}\r\n';
    await putApplicationFixtureFile(f.root, ['.liftoff', 'repair-history', fingerprint, 'receipt.json'], forged);
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(1);
    expect(apply.report).toMatchObject({ status: 'failed', committed: false });
    expect(apply.report.blockers.join(' ')).toContain('Repair history already exists and is immutable');
    expect(apply.report.backupPath).toBeUndefined();
    expect(await readFile(path.join(historyRoot(f), fingerprint, 'receipt.json'), 'utf8')).toBe(forged);
    await expect(lstat(path.join(historyRoot(f), fingerprint, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expectOriginalLayout(f);
  });

  it('reports committed files honestly when protected configuration changes after the commit', async () => {
    const { f, runner, fingerprint } = await verifiedPlan();
    const manifest = await readFile(path.join(f.root, 'liftoff.manifest.json'));
    const actual = transactions.applyReviewedUpdateTransaction;
    vi.spyOn(transactions, 'applyReviewedUpdateTransaction').mockImplementation(async (...args) => {
      const outcome = await actual(...args);
      await putApplicationFixtureFile(f.root, ['liftoff.config.json'], '{"concurrent":"post-commit edit"}\n');
      return outcome;
    });
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(2);
    expect(apply.report).toMatchObject({ status: 'partial', committed: true, verification: 'incomplete', repairScopeComplete: false });
    expect(apply.report.message).toContain('No blind restoration was attempted.');
    expect(apply.report.blockers.join(' ')).toContain('protected manifest/configuration changed during final inspection');
    await expectAppliedOnce(f, fingerprint);
    expect(await readFile(path.join(f.root, 'liftoff.config.json'), 'utf8')).toBe('{"concurrent":"post-commit edit"}\n');
    expect(await readFile(path.join(historyRoot(f), fingerprint, 'manifest.json'))).toEqual(manifest);
  });

  it.each([
    ['an uncommitted outcome with rollback failures', { status: 'blocked' as const, committed: false, rollbackFailures: ['simulated rollback failure'], cleanupFailures: [] },
      { status: 'partial', committed: false }],
    ['a committed outcome with journal cleanup failures', null, { status: 'partial', committed: true, repairScopeComplete: false }]
  ])('reports %s as partial with only the recorded recovery action', async (_name, replacement, expected) => {
    const { f, runner, fingerprint } = await verifiedPlan();
    const actual = transactions.applyReviewedUpdateTransaction;
    vi.spyOn(transactions, 'applyReviewedUpdateTransaction').mockImplementation(async (...args) => {
      if (replacement) return replacement;
      const outcome = await actual(...args);
      return { ...outcome, cleanupFailures: [...outcome.cleanupFailures, 'simulated journal cleanup failure'] };
    });
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(2);
    expect(apply.report).toMatchObject(expected);
    expect(apply.report.blockers.join(' ')).toMatch(/simulated (?:rollback|journal cleanup) failure/u);
    expect(apply.report.nextActions.map((action) => action.id)).toEqual(['repair-recover']);
    if (replacement) await expectOriginalLayout(f);
    else await expectAppliedOnce(f, fingerprint);
  });

  it('never double-applies when two exact approvals race', async () => {
    const { f, runner, fingerprint } = await verifiedPlan();
    const results = await Promise.all([1, 2].map(() => repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner })));
    const committed = results.filter((result) => result.report.committed);
    expect(committed.length).toBeLessThanOrEqual(1);
    for (const result of results.filter((entry) => !entry.report.committed)) {
      expect(result.code).not.toBe(0);
      expect(result.report.status).not.toBe('applied');
    }
    if (!committed.length) {
      const retry = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
      expect(retry.code, retry.report.blockers.join('; ')).toBe(0);
    }
    await expectAppliedOnce(f, fingerprint);
    await expectNoInterruptedTransaction(f, runner);
  });
});

describe('verification authority revoked concurrently', () => {
  async function removeVerificationReceipts(home: string): Promise<void> {
    const directory = getUpdatePreviewDirectory({ homedir: home, env: {} });
    for (const name of await userRecordFiles(home, 'repair-verification')) await rm(path.join(directory, name));
  }

  it('refuses the file transaction when the receipt disappears while file consent is open', async () => {
    const f = await createCommandFlowFixture(await directories.make('lf conc '));
    const runner = new ScriptedRunner();
    let prompts = 0;
    const result = await repairHuman(f.root, ['--application-patch', f.patch], { home: f.home, runner }, async () => {
      if (++prompts === 2) await removeVerificationReceipts(f.home);
      return true;
    });
    expect(prompts).toBe(2);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Matching verification is no longer available; no application file transaction was authorized.');
    expect(result.stdout).toContain('Any earlier approved verification effects and retained private backups are reported separately.');
    expect(runner.effects()).toHaveLength(1);
    expect(await userRecordFiles(f.home, 'repair-backup')).toEqual([]);
    await expectOriginalLayout(f);
    await expectNoNewHistory(f);
  });

  it('refuses the transaction when the receipt disappears after the lock is requested', async () => {
    const { f, runner, fingerprint } = await verifiedPlan();
    const actual = transactions.applyReviewedUpdateTransaction;
    vi.spyOn(transactions, 'applyReviewedUpdateTransaction').mockImplementation(async (...args) => {
      await removeVerificationReceipts(f.home);
      return actual(...args);
    });
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(1);
    expect(apply.report).toMatchObject({ status: 'failed', committed: false });
    expect(apply.report.blockers.join(' ')).toContain('Application verification no longer matches the approved transaction.');
    await expectOriginalLayout(f);
    await expectNoNewHistory(f);
  });
});

it('issues no preview when protected desired state changes during read-only inspection', async () => {
  const f = await createCommandFlowFixture(await directories.make('lf conc '), { preparation: [backendNpmCi()] });
  let edited = false;
  const runner = new ScriptedRunner(async (call) => {
    if (isToolProbe(call.command) && !edited) {
      edited = true;
      await putApplicationFixtureFile(f.root, ['liftoff.config.json'], '{"concurrent":"inspection-time edit"}\n');
    }
    return undefined;
  });
  const check = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
  expect(edited).toBe(true);
  expect(check.code).toBe(1);
  expect(check.report).toMatchObject({ status: 'failed', committed: false });
  expect(check.report.blockers.join(' ')).toContain('Project manifest or desired state changed during application inspection');
  expect(check.report.fingerprint).toBeUndefined();
  expect(await userRecordFiles(f.home, 'repair-preview')).toEqual([]);
  expect(await readFile(path.join(f.root, 'liftoff.config.json'), 'utf8')).toBe('{"concurrent":"inspection-time edit"}\n');
  expect(runner.effects()).toEqual([]);
});
