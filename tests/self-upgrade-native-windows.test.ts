import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readWindowsInstallerLayout } from '../src/adapters/distribution/native-windows.js';
import { assertWinGetOwnership, createNativeUpgradePort, nativePolicy,
  type NativeOwnerReaders, type WinGetOwnershipObservation } from '../src/adapters/distribution/native.js';
import { windowsReceiptWorld } from './fixtures/windows-native-installation.js';

describe('Windows installer local attribution and independent WinGet ownership', () => {
  const read = (world: ReturnType<typeof windowsReceiptWorld>, selected = world.stableLauncher, signal = new AbortController().signal) =>
    readWindowsInstallerLayout(world.dependencies, world.installation, world.policy, selected, signal);

  it('consumes the exact producer receipt and CRLF pointer without any manager or signature claim', async () => {
    const world = windowsReceiptWorld();
    expect(world.produced.receipt).not.toHaveProperty('source');
    const observed = await read(world);
    expect(observed).toMatchObject({
      installRoot: world.installRoot, stableLauncher: world.stableLauncher,
      receiptSha256: world.winget.installerRegistration.receiptSha256,
      currentSha256: world.winget.installerRegistration.currentSha256,
      stableLauncherSha256: world.winget.installerRegistration.launcherSha256
    });
    expect(observed).not.toHaveProperty('owner');
    expect(observed).not.toHaveProperty('source');
    expect(world.runner.run).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive selection of the stable entry, never the inner launcher', async () => {
    const world = windowsReceiptWorld();
    await expect(read(world, world.stableLauncher.toUpperCase())).resolves.toHaveProperty('installRoot', world.installRoot);
    await expect(read(world, world.installation.launcher)).rejects.toMatchObject({ reasonCode: 'executable_selection' });
    await expect(read(world, 'C:\\other\\liftoff.exe')).rejects.toMatchObject({ reasonCode: 'executable_selection' });
  });

  it('keeps receipt-only default ownership unknown without invoking WinGet or refreshing a catalog', async () => {
    const world = windowsReceiptWorld();
    await expect(createNativeUpgradePort(world.dependencies).inspect(world.packageRoot, '0.12.3', 'C:\\fixture\\neutral'))
      .rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    expect(world.runner.run).toHaveBeenCalledTimes(1);
    expect(world.runner.run.mock.calls[0][0].executable).toBe(world.installation.runtime);
    expect(world.runner.run.mock.calls[0][1]).toMatchObject({ inheritEnvironment: false, ensureProcessTreeSettled: true });
  });

  it('classifies only after independent user-scope source/signer/registration observations', async () => {
    const world = windowsReceiptWorld();
    const reader = vi.fn<NonNullable<NativeOwnerReaders['winget']>>(async () => world.winget);
    const installed = await createNativeUpgradePort(world.dependencies, { winget: reader })
      .inspect(world.packageRoot, '0.12.3', 'C:\\fixture\\neutral');
    expect(installed).toMatchObject({ owner: 'winget', managerSource: 'fixture-source', managerScope: 'user',
      windowsInstaller: { installRoot: world.installRoot, stableLauncher: world.stableLauncher } });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0]).toMatchObject({ bundleRoot: world.installation.bundleRoot });
    expect(() => assertWinGetOwnership(world.winget, world.installation, world.policy)).toThrow('unsupported_installation');
  });

  it.each(['pointer', 'selection', 'policy'] as const)('rechecks %s after the bounded manager observation', async kind => {
    const world = windowsReceiptWorld();
    const reader: NonNullable<NativeOwnerReaders['winget']> = async () => {
      if (kind === 'pointer') world.files.set(world.pointerFile, Buffer.from('changed\r\n'));
      if (kind === 'selection') world.dependencies.resolveLiftoff = async () => world.installation.launcher;
      if (kind === 'policy') world.policy.approvedSigningKeySha256 = 'f'.repeat(64);
      return world.winget;
    };
    await expect(createNativeUpgradePort(world.dependencies, { winget: reader })
      .inspect(world.packageRoot, '0.12.3', 'C:\\fixture\\neutral')).rejects.toMatchObject({ reasonCode: 'owner_changed' });
  });

  it.each(['../escape', '0.12.3+unreviewed', '0.12.3\r\n', 'a'.repeat(129)])(
    'refuses unsafe or producer-unsupported version %j', async version => {
      const world = windowsReceiptWorld();
      world.installation.version = version;
      await expect(read(world)).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    }
  );

  it.each(['packageIdentifier', 'publisher', 'appId', 'certificateSha256', 'source', 'scope', 'installLocation',
    'bundleRoot', 'launcher', 'receiptSha256', 'currentSha256', 'launcherSha256', 'missing registration',
    'signature invalid', 'signature unknown', 'signature missing'] as const)(
    'refuses independent %s mismatch instead of trusting the local receipt', async field => {
      const world = windowsReceiptWorld();
      const layout = await read(world);
      const observed: WinGetOwnershipObservation = { ...world.winget, installerRegistration: { ...world.winget.installerRegistration } };
      if (field === 'scope') observed.scope = 'machine';
      else if (field.startsWith('signature ')) {
        observed.signatureStatus = field === 'signature missing' ? undefined : field === 'signature invalid' ? 'invalid' : 'unknown';
      }
      else if (field === 'missing registration') Reflect.deleteProperty(observed, 'installerRegistration');
      else if (['receiptSha256', 'currentSha256', 'launcherSha256'].includes(field)) {
        Reflect.set(observed.installerRegistration!, field, 'f'.repeat(64));
      } else Reflect.set(observed, field, field === 'source' ? 'unsafe source' : 'foreign');
      expect(() => assertWinGetOwnership(observed, { ...world.installation, windowsInstaller: layout }, world.policy))
        .toThrow('unsupported_installation');
    }
  );

  it.each(['schemaVersion', 'kind', 'scope', 'package', 'packageIdentifier', 'appId', 'publisher',
    'certificateSha256', 'version', 'sourceCommit', 'manifestSha256', 'inventorySha256', 'versionDirectory',
    'launcher', 'runtime', 'stableLauncher', 'stableLauncherSha256', 'extra field', 'missing field'] as const)(
    'refuses exact receipt %s mutation before an inventory child', async field => {
      const world = windowsReceiptWorld();
      const receipt = { ...world.produced.receipt };
      if (field === 'missing field') Reflect.deleteProperty(receipt, 'runtime');
      else Reflect.set(receipt, field, 'foreign');
      world.files.set(world.receiptFile, Buffer.from(JSON.stringify(receipt)));
      await expect(createNativeUpgradePort(world.dependencies).inspect(world.packageRoot, '0.12.3', 'C:\\fixture\\neutral'))
        .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
      expect(world.runner.run).not.toHaveBeenCalled();
    }
  );

  it.each(['LF-only', 'trailing bytes', 'wrong version', 'wrong digest', 'BOM'] as const)(
    'refuses %s current pointer', async kind => {
      const world = windowsReceiptWorld();
      const pointer = kind === 'LF-only' ? `${world.produced.versionName}\n`
        : kind === 'trailing bytes' ? `${world.produced.pointer} `
        : kind === 'wrong version' ? `0.12.2-${world.installation.manifestSha256}\r\n`
        : kind === 'wrong digest' ? `0.12.3-${'f'.repeat(64)}\r\n` : `\ufeff${world.produced.pointer}`;
      world.files.set(world.pointerFile, Buffer.from(pointer));
      await expect(read(world)).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    }
  );

  it.each(['stable bytes', 'inner bytes', 'receipt link', 'pointer link', 'launcher link', 'hard link',
    'version junction', 'ancestor junction', 'changed pointer', 'changed receipt', 'changed directory'] as const)(
    'refuses %s without manager effects', async kind => {
      const world = windowsReceiptWorld();
      if (kind === 'stable bytes' || kind === 'inner bytes') {
        world.files.set(kind === 'stable bytes' ? world.stableLauncher : world.installation.launcher, Buffer.from('changed'));
      } else if (kind.endsWith(' link') && kind !== 'hard link') {
        const filename = kind === 'receipt link' ? world.receiptFile : kind === 'pointer link' ? world.pointerFile : world.stableLauncher;
        world.world.nodes.set(filename, { kind: 'symlink', target: filename });
      } else if (kind === 'version junction' || kind === 'ancestor junction') {
        const directory = kind === 'version junction' ? world.installation.bundleRoot : path.win32.dirname(world.installRoot);
        world.world.nodes.set(directory, { kind: 'symlink', target: directory });
      } else if (kind === 'hard link' || kind === 'changed directory') {
        const lstat = world.dependencies.lstatBigInt;
        let visits = 0;
        world.dependencies.lstatBigInt = async filename => {
          const stat = await lstat(filename);
          if (filename === (kind === 'hard link' ? world.pointerFile : world.installRoot)) {
            Object.assign(stat, kind === 'hard link' ? { nlink: 2n } : { ino: BigInt(++visits) });
          }
          return stat;
        };
      } else {
        const filename = kind === 'changed pointer' ? world.pointerFile : world.receiptFile;
        const readBytes = world.dependencies.readBytes.getMockImplementation()!;
        let visits = 0;
        world.dependencies.readBytes.mockImplementation(async (file, maximum) => {
          const bytes = await readBytes(file, maximum);
          return file === filename && ++visits > 1 ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;
        });
      }
      await expect(read(world)).rejects.toMatchObject({
        reasonCode: kind.startsWith('changed ') ? 'owner_changed' : 'unsupported_installation'
      });
      expect(world.runner.run).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'ambiguous', 'relative', 'UNC', 'traversal', 'alternate stream'] as const)(
    'refuses %s LOCALAPPDATA attribution', async kind => {
      const world = windowsReceiptWorld();
      const local = world.dependencies.environment.LOCALAPPDATA;
      world.dependencies.environment = kind === 'missing' ? { LOCALAPPDATA: '' }
        : kind === 'ambiguous' ? { LOCALAPPDATA: local, LocalAppData: local }
        : { LOCALAPPDATA: kind === 'relative' ? 'relative' : kind === 'UNC' ? '\\\\server\\share'
          : kind === 'traversal' ? `${local}\\..\\Local` : `${local}:alternate` };
      await expect(read(world)).rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    }
  );

  it('detects directory replacement whose native identities round to the same Number', async () => {
    const world = windowsReceiptWorld();
    const lstat = world.dependencies.lstatBigInt;
    let visits = 0;
    world.dependencies.lstatBigInt = async filename => {
      const stat = await lstat(filename);
      if (filename === world.installRoot) stat.ino = visits++ ? 9007199254740993n : 9007199254740992n;
      return stat;
    };
    expect(Number(9007199254740992n)).toBe(Number(9007199254740993n));
    await expect(read(world)).rejects.toMatchObject({ reasonCode: 'owner_changed' });
  });

  it('refuses unapproved policy and cancelled reads before examining local material', async () => {
    const world = windowsReceiptWorld();
    const unqualified = structuredClone(world.policy);
    unqualified.winget.certificateSha256 = null;
    await expect(readWindowsInstallerLayout(world.dependencies, world.installation, unqualified, world.stableLauncher,
      new AbortController().signal)).rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    await expect(read(world, world.stableLauncher, AbortSignal.abort())).rejects.toMatchObject({ reasonCode: 'native_timeout' });
    expect(world.dependencies.readBytes).not.toHaveBeenCalled();
  });

  it('matches producer AppId/publisher constraints without changing any approved policy values', () => {
    const world = windowsReceiptWorld();
    expect(nativePolicy(world.policy).winget.installerAppId).toBe('Fixture.Liftoff');
    for (const appId of ['../foreign', 'foreign/key', 'foreign:key', 'foreign key', '"quoted"']) {
      expect(() => nativePolicy({ ...world.policy, winget: { ...world.policy.winget, installerAppId: appId } })).toThrow('native_invalid');
    }
    expect(() => nativePolicy({ ...world.policy, winget: { ...world.policy.winget, publisher: '"quoted"' } })).toThrow('native_invalid');
  });
});
