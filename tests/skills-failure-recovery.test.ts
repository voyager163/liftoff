import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { assertSafeSkillPath, captureSkillFile } from '../src/adapters/skills/discovery.js';
import { createSkillDeliveryPlan } from '../src/application/skills/planning.js';
import { executeSkillDeliveryPlan, recoverSkillDeliveryTransaction, type SkillExecutionDependencies } from '../src/application/skills/execution.js';
import { executeSkillsUseCase } from '../src/application/skills/use-case.js';
import { inspectReviewedUpdateTransaction, type ReviewedUpdateTransactionCheckpoint } from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { userScopeMutationLockPath, withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { skillOwnershipPathParts, loadOwnershipStore } from '../src/application/skills/ownership.js';
import { canonicalJson, sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { getCanonicalSkill, loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';
import { projectSkillForHost } from '../src/adapters/skills/host-projections.js';
import type { SkillDeliveryPlan } from '../src/domain/skills/contracts.js';
import { fixtureApprovalStore, skillsFixture, stageSkillCatalog } from './helpers/skills-fixture.js';

vi.mock('node:fs/promises', { spy: true });

describe('Skills filesystem, approval, interruption, and sealed recovery boundaries', () => {
  let fixture: Awaited<ReturnType<typeof skillsFixture>>;
  beforeEach(async () => { fixture = await skillsFixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });
  const parts = ['.claude', 'commands', 'liftoff-assess.md'];
  const journalParts = ['.liftoff', 'reviewed-skills-transaction.json'];

  async function plan(skillIds: ['assess'] | ['assess', 'repair'] = ['assess']) {
    return createSkillDeliveryPlan({
      scope: 'user', targetRoot: fixture.home, hosts: ['claude'], skillIds
    }, { now: fixture.dependencies.now });
  }
  function execute(review: SkillDeliveryPlan, hooks: Partial<SkillExecutionDependencies> = {}) {
    return executeSkillDeliveryPlan(review, { approvePlan: review.fingerprint }, {
      approvalStore: fixtureApprovalStore(fixture.home), ...hooks
    });
  }

  async function interrupted(phase: ReviewedUpdateTransactionCheckpoint['phase'], index?: number) {
    const sourceRoot = new URL('../src/', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { transformSync } from 'rolldown/utils';
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (context.parentURL?.startsWith(${JSON.stringify(sourceRoot)}) && specifier.endsWith('.js')) {
            return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url.startsWith(${JSON.stringify(sourceRoot)}) && url.endsWith('.ts')) {
            return { format: 'module', shortCircuit: true, source: transformSync(
              url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }
            ).code };
          }
          return nextLoad(url, context);
        }
      });
      const { createSkillDeliveryPlan } = await import(${JSON.stringify(new URL('../src/application/skills/planning.ts', import.meta.url).href)});
      const { executeSkillDeliveryPlan } = await import(${JSON.stringify(new URL('../src/application/skills/execution.ts', import.meta.url).href)});
      const { createSkillsTransactionApprovalStore } = await import(${JSON.stringify(new URL('../src/adapters/filesystem/update-previews.ts', import.meta.url).href)});
      const home = ${JSON.stringify(fixture.home)};
      const now = () => new Date('2026-09-14T12:01:00.000Z');
      const review = await createSkillDeliveryPlan({
        scope: 'user', targetRoot: home, hosts: ['claude'], skillIds: ['assess']
      }, { now });
      const result = await executeSkillDeliveryPlan(review, { approvePlan: review.fingerprint }, {
        approvalStore: createSkillsTransactionApprovalStore(home, 'user', { env: {}, homedir: home, clock: now }),
        onCheckpoint: async checkpoint => {
          if (checkpoint.phase === ${JSON.stringify(phase)} && checkpoint.index === ${JSON.stringify(index)}) {
            process.stdout.write(JSON.stringify({ fingerprint: review.fingerprint }) + '\\n');
            process.exit(73);
          }
        }
      });
      process.stderr.write(JSON.stringify(result));
      process.exitCode = 9;
    `], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, TMPDIR: fixture.root, LIFTOFF_TELEMETRY_DISABLED: '1' }
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(73);
    const fingerprint = (JSON.parse(child.stdout.trim()) as { fingerprint: string }).fingerprint;
    const lock = await userScopeMutationLockPath(fixture.home);
    const before = await fs.lstat(lock);
    const lockBytes = await fs.readFile(lock);
    expect(JSON.parse(lockBytes.toString('utf8')).pid).toBe(child.pid);
    expect((await fs.lstat(lock)).ino).toBe(before.ino);
    expect(await fs.readFile(lock)).toEqual(lockBytes);
    // The test owns this exact fixture and observed this child exit; production never removes stale locks by PID.
    await fs.unlink(lock);
    return { fingerprint, approvalStore: fixtureApprovalStore(fixture.home) };
  }

  it('does not accept a generic Yes or interactive Boolean as plan authority', async () => {
    const review = await plan();
    for (const options of [{ yes: true }, { interactive: true, approvePrompt: async () => true }, { force: true }]) {
      await expect(executeSkillDeliveryPlan(review, options as never, {
        approvalStore: fixtureApprovalStore(fixture.home)
      })).rejects.toThrow(/generic Yes|interactive booleans/);
    }
    expect(await fs.readdir(fixture.home)).toEqual([]);
  });

  it('rejects forged plan data instead of trusting action paths, target hashes, or conflict flags', async () => {
    const review = await plan();
    const forged = structuredClone(review);
    forged.actions[0].absolutePath = path.join(fixture.cwd, 'unowned.md');
    forged.actions[0].targetContentHash = '0'.repeat(64);
    forged.hasConflicts = false;
    await expect(execute(forged)).rejects.toThrow(/immutable plan produced by the current planner/);
    expect(await fs.readdir(fixture.cwd)).toEqual([]);
    expect(await fs.readdir(fixture.home)).toEqual([]);
  });

  it('expires approval and requires a fresh plan rather than silently refreshing its validity', async () => {
    let now = new Date('2026-09-14T12:01:00.000Z');
    const review = await createSkillDeliveryPlan({
      scope: 'user', targetRoot: fixture.home, hosts: ['claude'], skillIds: ['assess']
    }, { now: () => now });
    now = new Date(review.expiresAt);
    await expect(execute(review)).rejects.toThrow(/expired/);
    expect(await fs.readdir(fixture.home)).toEqual([]);
  });

  it.each(['body', 'metadata', 'mode'] as const)('rechecks actual packaged %s instead of trusting cached canonical data', async (change) => {
    const cached = structuredClone(loadCanonicalSkillCatalog());
    const catalogRoot = await stageSkillCatalog(fixture.root, cached);
    const review = await createSkillDeliveryPlan({
      scope: 'user', targetRoot: fixture.home, hosts: ['claude'], skillIds: ['assess']
    }, { now: fixture.dependencies.now, catalogRoot, loadCatalog: () => cached });
    const source = path.join(catalogRoot, 'assets', 'skills', 'assess', 'SKILL.md');
    if (change === 'body') await fs.writeFile(source, 'Changed canonical instructions after approval.');
    if (change === 'mode') await fs.chmod(source, 0o444);
    if (change === 'metadata') {
      const metadataPath = path.join(catalogRoot, 'assets', 'skills', 'catalog.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.skills[0].description = 'Changed canonical metadata.';
      await fs.writeFile(metadataPath, JSON.stringify(metadata));
    }
    await expect(execute(review)).rejects.toThrow(/changed|Cached content|cached metadata/);
    expect(await fs.readdir(fixture.home)).toEqual([]);
  });

  it('stops a changed canonical source between writes and rolls back only attributable target bytes', async () => {
    const cached = structuredClone(loadCanonicalSkillCatalog());
    const catalogRoot = await stageSkillCatalog(fixture.root, cached);
    const review = await createSkillDeliveryPlan({
      scope: 'user', targetRoot: fixture.home, hosts: ['claude'], skillIds: ['assess', 'repair']
    }, { now: fixture.dependencies.now, catalogRoot, loadCatalog: () => cached });
    const source = path.join(catalogRoot, 'assets', 'skills', 'assess', 'SKILL.md');
    const changed = 'The canonical source was replaced concurrently.';
    const result = await execute(review, {
      onCheckpoint: async ({ phase, index }) => {
        if (phase === 'after-mutation' && index === 0) await fs.writeFile(source, changed);
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: false, uncertain: false });
    expect(await fs.readFile(source, 'utf8')).toBe(changed);
    await expect(fs.readFile(path.join(fixture.home, ...parts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds relevant directory inventory and refuses a concurrent neighbor added after review', async () => {
    await fs.mkdir(path.join(fixture.home, '.claude', 'commands'), { recursive: true });
    const review = await plan();
    const neighbor = path.join(fixture.home, '.claude', 'commands', 'custom.md');
    await fs.writeFile(neighbor, 'new user file');
    await expect(execute(review)).rejects.toThrow(/changed after review/);
    expect(await fs.readFile(neighbor, 'utf8')).toBe('new user file');
  });

  it.each(['outside', 'inside', 'root'] as const)('rejects %s symlink/junction aliases without touching their targets', async (kind) => {
    const actual = kind === 'outside' ? fixture.cwd : path.join(fixture.home, 'actual');
    if (kind !== 'outside') await fs.mkdir(actual);
    if (kind === 'root') {
      const alias = path.join(fixture.root, 'home-alias');
      await fs.symlink(fixture.home, alias, 'dir');
      await expect(createSkillDeliveryPlan({
        scope: 'user', targetRoot: alias, hosts: ['claude'], skillIds: ['assess']
      })).rejects.toThrow(/symlink|junction|alias/);
    } else {
      await fs.symlink(actual, path.join(fixture.home, '.claude'), 'dir');
      await expect(assertSafeSkillPath(fixture.home, parts)).rejects.toThrow(/symlink|junction/);
    }
    expect(await fs.readdir(actual)).toEqual([]);
  });

  it('rejects case and Unicode aliases rather than accepting their normalized spelling', async () => {
    await fs.mkdir(path.join(fixture.home, '.CLAUDE'));
    await expect(assertSafeSkillPath(fixture.home, parts)).rejects.toThrow(/Case or Unicode normalization collision/);
  });

  it('rejects multiply linked files and exact path escapes', async () => {
    const userFile = path.join(fixture.cwd, 'user.md');
    await fs.writeFile(userFile, 'other owner');
    await fs.mkdir(path.join(fixture.home, '.claude', 'commands'), { recursive: true });
    await fs.link(userFile, path.join(fixture.home, ...parts));
    await expect(plan()).rejects.toThrow(/hard-link|single-link/);
    await expect(assertSafeSkillPath(fixture.home, ['..', 'escape'])).rejects.toThrow();
    expect(await fs.readFile(userFile, 'utf8')).toBe('other owner');
  });

  it('propagates EACCES instead of misclassifying a failed read as absence', async () => {
    await fs.mkdir(path.join(fixture.home, '.claude', 'commands'), { recursive: true });
    await fs.writeFile(path.join(fixture.home, ...parts), 'user bytes');
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(captureSkillFile(fixture.home, parts)).rejects.toMatchObject({ code: 'EACCES' });
    vi.restoreAllMocks();
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toBe('user bytes');
  });

  it('does not accept a forged valid-format managed hash without private ownership authority', async () => {
    expect((await fixture.apply()).ok).toBe(true);
    const store = await loadOwnershipStore('user', fixture.home);
    const record = store.projections[parts.join('/')];
    const changed = 'custom bytes and a project-local ownership claim';
    await fs.writeFile(path.join(fixture.home, ...parts), changed);
    record.projectedContentHash = sha256Hex(changed);
    await fs.writeFile(path.join(fixture.home, ...skillOwnershipPathParts), canonicalJson(store));
    await expect(fixture.preview({ subcommand: 'update' })).rejects.toThrow(/no matching private identity-bound approval/);
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toBe(changed);
  });

  it('uses the same target exclusion for a user install and a concurrent project writer', async () => {
    const review = await plan();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = withProjectMutationLock(fixture.home, async () => { started.resolve(); await release.promise; });
    await started.promise;
    try {
      const result = await execute(review);
      expect(result).toMatchObject({ outcome: 'failed', committed: false });
      expect(result.message).toContain('cooperating Liftoff');
      expect(await fs.readdir(fixture.home)).toEqual([]);
    } finally { release.resolve(); await writer; }
  });

  it('rolls back only unchanged transaction writes after a genuine mid-transaction failure', async () => {
    const review = await plan(['assess', 'repair']);
    const result = await execute(review, {
      onCheckpoint: async ({ phase, index }) => { if (phase === 'after-mutation' && index === 0) throw new Error('injected I/O failure'); }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: false, uncertain: false });
    expect(result.recovery.status).toBe('complete');
    await expect(fs.readFile(path.join(fixture.home, ...parts))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(fixture.home, ...journalParts))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(path.join(fixture.home, '.claude', 'commands'))).isDirectory()).toBe(true);
  });

  it('preserves concurrent newer bytes during rollback and leaves exact recoverable evidence', async () => {
    const review = await plan(['assess', 'repair']);
    const newer = 'a concurrent user edit after the first committed file';
    const result = await execute(review, {
      onCheckpoint: async ({ phase, index }) => {
        if (phase === 'after-mutation' && index === 0) {
          await fs.writeFile(path.join(fixture.home, ...parts), newer);
          throw new Error('stop after user edit');
        }
      }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: false, uncertain: true });
    expect(result.recovery.status).toBe('blocked');
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toBe(newer);
    const recovered = await recoverSkillDeliveryTransaction(fixture.home, 'user', review.fingerprint, fixtureApprovalStore(fixture.home));
    expect(recovered.status).toBe('blocked');
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toBe(newer);
    await fs.writeFile(path.join(fixture.home, ...parts), projectSkillForHost(getCanonicalSkill('assess'), 'claude', 'user').renderedContent);
    expect((await recoverSkillDeliveryTransaction(fixture.home, 'user', review.fingerprint, fixtureApprovalStore(fixture.home))).status).toBe('rolled-back');
  });

  it.each([
    ['prepared', undefined], ['staged', 0], ['after-mutation', 0], ['before-commit', undefined]
  ] as const)('recovers a real stopped process at %s without orphaned file writes or broad directory cleanup', async (phase, index) => {
    const stopped = await interrupted(phase, index);
    const before = await inspectReviewedUpdateTransaction(fixture.home, {
      transactionKind: 'skills', skillsScope: 'user', approvalStore: stopped.approvalStore
    });
    expect(before.status).toBe('interrupted');
    const result = await recoverSkillDeliveryTransaction(fixture.home, 'user', stopped.fingerprint, stopped.approvalStore);
    expect(result.status, JSON.stringify(result)).toBe('rolled-back');
    expect(result.committed).toBe(false);
    await expect(fs.readFile(path.join(fixture.home, ...parts))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(fixture.home, ...skillOwnershipPathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(fixture.home, ...journalParts))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps committed effects through process interruption and independently verifies before cleanup', async () => {
    const stopped = await interrupted('committed');
    const target = path.join(fixture.home, ...parts);
    const beforeBytes = await fs.readFile(target);
    const beforeStat = await fs.lstat(target);
    const result = await recoverSkillDeliveryTransaction(fixture.home, 'user', stopped.fingerprint, stopped.approvalStore);
    expect(result).toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
    expect(await fs.readFile(target)).toEqual(beforeBytes);
    expect((await fs.lstat(target)).ino).toBe(beforeStat.ino);
  });

  it('retains known commit and uncertainty when later user bytes prevent recovery readback', async () => {
    const stopped = await interrupted('committed');
    const target = path.join(fixture.home, ...parts);
    await fs.writeFile(target, 'newer bytes after a committed skills transaction');
    const result = await executeSkillsUseCase({
      subcommand: 'install', hosts: ['claude'], skillId: 'assess', approvePlan: stopped.fingerprint
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result.outcome).toBe('recovered');
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({ status: 'committed', committed: true, verified: false, uncertain: true });
    expect(await fs.readFile(target, 'utf8')).toBe('newer bytes after a committed skills transaction');
  });

  it('refuses recovery after an attested created directory is replaced, preserving both trees', async () => {
    const stopped = await interrupted('after-mutation', 0);
    const commands = path.join(fixture.home, '.claude', 'commands');
    const moved = path.join(fixture.home, '.claude', 'saved-commands');
    await fs.rename(commands, moved);
    await fs.mkdir(commands);
    await fs.writeFile(path.join(fixture.home, ...parts), 'newer replacement-directory content');
    const beforeJournal = await fs.readFile(path.join(fixture.home, ...journalParts));
    const result = await recoverSkillDeliveryTransaction(fixture.home, 'user', stopped.fingerprint, stopped.approvalStore);
    expect(result.status).toBe('blocked');
    expect(result.rollbackFailures.join('\n')).toContain('directory changed');
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toBe('newer replacement-directory content');
    expect(await fs.readFile(path.join(moved, 'liftoff-assess.md'), 'utf8')).toContain('Liftoff');
    expect(await fs.readFile(path.join(fixture.home, ...journalParts))).toEqual(beforeJournal);
  });

  it('rejects a forged directory checkpoint even if the last mutation checkpoint remains sealed', async () => {
    const stopped = await interrupted('after-mutation', 0);
    const journal = path.join(fixture.home, ...journalParts);
    const frames = (await fs.readFile(journal, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    const directory = frames.find((frame) => frame.phase === 'skills-directory');
    directory.inode += 1;
    const tampered = frames.map((frame) => canonicalJson(frame)).join('');
    await fs.writeFile(journal, tampered);
    const result = await recoverSkillDeliveryTransaction(fixture.home, 'user', stopped.fingerprint, stopped.approvalStore);
    expect(result.status).toBe('blocked');
    expect(await fs.readFile(journal, 'utf8')).toBe(tampered);
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toContain('Liftoff');
  });

  it('reports postcommit failure as committed and verified rather than rolling back or claiming full success', async () => {
    const review = await plan();
    const result = await execute(review, {
      onCheckpoint: async ({ phase }) => { if (phase === 'committed') throw new Error('postcommit interruption'); }
    });
    expect(result).toMatchObject({ outcome: 'failed', committed: true, verified: true, uncertain: false });
    expect(result.recovery.cleanupFailures.join('\n')).toContain('postcommit interruption');
    expect(await fs.readFile(path.join(fixture.home, ...parts), 'utf8')).toContain('Liftoff');
    expect((await recoverSkillDeliveryTransaction(fixture.home, 'user', review.fingerprint, fixtureApprovalStore(fixture.home))).status).toBe('committed');
  });

  it('recovers only the original approved transaction through the public operation, without starting a replacement plan', async () => {
    const stopped = await interrupted('after-mutation', 0);
    const wrong = await executeSkillsUseCase({
      subcommand: 'remove', hosts: ['claude'], skillId: 'assess', approvePlan: stopped.fingerprint
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(wrong.outcome).toBe('recovery-required');
    const result = await executeSkillsUseCase({
      subcommand: 'install', hosts: ['claude'], skillId: 'assess', approvePlan: stopped.fingerprint
    }, { cwd: fixture.cwd }, fixture.dependencies);
    expect(result.outcome).toBe('recovered');
    expect(result.exitCode).toBe(2);
    expect(result.result).toMatchObject({ status: 'rolled-back' });
    await expect(fs.readFile(path.join(fixture.home, ...parts))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fixture.apply()).ok).toBe(true);
  });
});
