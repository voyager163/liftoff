import { afterEach, describe, expect, it } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { planInstallationMigration } from '../../src/application/distribution/plan-migration.js';
import { executeInstallationMigration } from '../../src/application/distribution/execute-migration.js';
import { HomebrewAdapter } from '../../src/adapters/distribution/homebrew-adapter.js';
import { WinGetAdapter } from '../../src/adapters/distribution/winget-adapter.js';
import { NpmInstallationAdapter } from '../../src/adapters/distribution/npm-installation.js';
import { readTree, sha, signedFixture, type SignedFixture } from './native-fixture.js';
import path from 'node:path';
import { homebrewFixture } from './manager-fixture.js';

const fixtures: SignedFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture(name: string) { const value = await signedFixture(name); fixtures.push(value); return value; }

describe('exact registered native manager observations', () => {
  it('uses actual prefix, publisher-owned cask definition, installed records, and explicit plus PATH readback', async () => {
    const value = await fixture('brew-cutover');
    const manager = await homebrewFixture(value);
    const plan = await planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, now: value.reviewNow
    });
    expect(plan.targetInstallation.targetPackage).toBe(manager.packageId);
    expect(plan.targetInstallation.destinationDirectory).toBe(manager.targetRoot);
    expect(plan.legacyInstallation.prefix).toBe(value.prefix);
    const record = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint, json: true });
    expect(record.status, record.failure?.message).toBe('completed');
    const invocations = value.runner.calls.filter((call) => ['install', 'uninstall'].includes(call.command.args[0]));
    expect(invocations.map((call) => call.command.args[0])).toEqual(['uninstall', 'install']);
    expect(invocations[1].command.args).toEqual(['install', '--cask', manager.packageId]);
    expect(invocations[1].options?.env).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_FROM_API: '1' });
    const installed = await manager.detector.inspectInstallation(manager.targetRoot);
    expect(installed.installation).toMatchObject({ owner: 'homebrew-cask', packageName: manager.packageId, version: '0.13.0' });
  });

  it('rejects bare tokens, other taps, formula records, changed definitions and cask dependencies before effects', async () => {
    const value = await fixture('brew-identity-conflicts');
    const manager = await homebrewFixture(value);
    const candidate = await manager.admission.admitBundle(value.candidate);
    for (const patch of [
      { full_token: 'liftoff' }, { tap: 'another/liftoff' }, { depends_on: { formula: ['node'] } }
    ]) {
      await manager.rewriteCask(patch);
      await expect(manager.adapter.select(candidate, 'install')).rejects.toThrow();
    }
    await manager.rewriteCask({});
    const selected = await manager.adapter.select(candidate, 'install');
    await writeFile(manager.definitionPath, `${await readFile(manager.definitionPath, 'utf8')}\n# changed source\n`);
    await expect(manager.adapter.execute(selected)).rejects.toThrow(/signed publisher-owned definition/);
    expect(value.runner.calls.some((call) => call.command.args[0] === 'install')).toBe(false);
    await access(value.legacyLauncher);
  });

  it('does not report manager zero exit as successful native registration or replacement', async () => {
    const value = await fixture('manager-false-success');
    const manager = await homebrewFixture(value, false);
    const plan = await planInstallationMigration({
      toOwner: 'homebrew-cask', detector: manager.detector, receiptStore: value.store, runner: value.runner,
      candidatePath: value.candidate, now: value.reviewNow
    });
    const result = await executeInstallationMigration({ plan, approvePlan: plan.planFingerprint });
    expect(result.status).toBe('failed');
    expect(result.completedEffects).toContain('retire-legacy-package');
    expect(result.verification).toBeUndefined();
    await expect(access(value.packageRoot)).rejects.toHaveProperty('code', 'ENOENT');
    await access(value.candidate);
  });

  it('never turns absent WinGet registration or the wrong host into source agreement acceptance', async () => {
    const value = await fixture('winget-blocked');
    const candidate = await value.admission.admitBundle(value.candidate);
    const adapter = new WinGetAdapter({ admission: value.admission, runner: value.runner, env: value.env, cwd: value.project });
    await expect(adapter.select(candidate, 'install')).rejects.toThrow(/Windows native target/);
    expect(value.runner.calls.some((call) => call.command.executable.includes('winget'))).toBe(false);
  });

  it('uses the real installed npm read-only owner protocol without changing the isolated home or project', async () => {
    const value = await fixture('actual-npm-readonly');
    const before = (await readTree(value.home)).map((file) => ({ path: file.path, sha: sha(file.bytes), mode: file.mode }));
    const npm = new NpmInstallationAdapter({
      cwd: value.project, runner: value.runner,
      env: {
        ...value.env, PATH: process.env.PATH, NPM_CONFIG_PREFIX: value.prefix,
        NPM_CONFIG_USERCONFIG: path.join(value.home, 'absent-user-npmrc'),
        NPM_CONFIG_GLOBALCONFIG: path.join(value.home, 'absent-global-npmrc'),
        NPM_CONFIG_CACHE: path.join(value.home, 'selected-cache')
      }
    });
    const observed = await npm.inspect(path.join(value.packageRoot, 'dist', 'cli.js'));
    expect(observed?.facts.prefix).toBe(value.prefix);
    const after = (await readTree(value.home)).map((file) => ({ path: file.path, sha: sha(file.bytes), mode: file.mode }));
    expect(after).toEqual(before);
    expect(value.runner.calls.every((call) => !['install', 'uninstall'].includes(call.command.args[0]))).toBe(true);
  });
});
