import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyInstallationOwner } from '../../src/domain/distribution/installation-owner.js';
import { InstallationDetector } from '../../src/adapters/distribution/installation-detector.js';
import { signedFixture, type SignedFixture } from './native-fixture.js';

const fixtures: SignedFixture[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('native installation ownership evidence', () => {
  it.each([
    { isCaskroomPresent: true }, { isWinGetRecordPresent: true }, { hasDirectReceipt: true },
    { packageName: '@msn-control/liftoff' }, { isNpxCache: true }, { isDevelopmentCheckout: true },
    { isSymlinkedDevelopment: true }, {}
  ])('never turns diagnostic hints into native replacement authority %#', (hints) => {
    expect(classifyInstallationOwner({ executablePath: '/anything/liftoff', ...hints }).owner).toBe('unknown');
  });

  it('does not identify Node, Caskroom, WinGet names, or arbitrary bytes as Liftoff ownership', async () => {
    const root = path.resolve('tests', `.native-owner-${randomUUID()}`);
    roots.push(root);
    for (const name of ['Caskroom/liftoff/0.13.0/node', 'WinGet/Packages/voyager163.liftoff/liftoff', 'other/liftoff']) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'unknown bytes');
      const detector = new InstallationDetector({ entrypoint: file, cwd: root, env: { HOME: root, PATH: '' }, ownerAdapters: [] });
      const result = await detector.inspectInstallation();
      expect(result.installation.owner).toBe('unknown');
      expect(result.executable.version).toBeUndefined();
      expect(result.executable.isPrivateRuntime).toBe(false);
    }
  });

  it('distinguishes a real verified unlinked native entrypoint from the ordinary legacy command', async () => {
    const fixture = await signedFixture('owner-real');
    fixtures.push(fixture);
    const result = await fixture.detector.inspectInstallation();
    expect(result.executable.resolvedPath).toBe(path.join(fixture.candidate, 'dist', 'cli.js'));
    expect(result.executable.resolvedPath).not.toBe(process.execPath);
    expect(result.status).toBe('unlinked-candidate');
    expect(result.pathResolution.effectiveLauncher).toBe(fixture.legacyLauncher);
    expect(result.pathResolution.resolvesToRunning).toBe(false);
    const legacy = await fixture.detector.observeLegacyInstallation();
    expect(legacy.facts.prefix).toBe(fixture.prefix);
    expect(legacy.facts.packageRoot).toBe(fixture.packageRoot);
    expect(legacy.facts.installedVersion).toBe('0.12.3');
    await expect(access(fixture.store.baseDirectory)).rejects.toHaveProperty('code', 'ENOENT');
  });
});
