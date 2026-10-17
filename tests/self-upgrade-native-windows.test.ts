import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readWindowsInstallerLayout, readWindowsInstallerRegistration } from '../src/adapters/distribution/native-windows.js';
import { assertWinGetOwnership, createNativeUpgradePort, nativePolicy,
  type NativeOwnerReaders, type WinGetOwnershipObservation } from '../src/adapters/distribution/native.js';
import { windowsReceiptWorld } from './fixtures/windows-native-installation.js';
import { defaultSelfUpgradeDependencies } from '../src/adapters/distribution/upgrade-host.js';

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

    describe('independent user installer registration and embedded signer observation', () => {
      const inspect = async (world: ReturnType<typeof windowsReceiptWorld>, signal = new AbortController().signal) => {
        const layout = await readWindowsInstallerLayout(world.dependencies, world.installation, world.policy, world.stableLauncher, signal);
        return readWindowsInstallerRegistration(world.dependencies, { ...world.installation, windowsInstaller: layout },
          world.policy, 'C:\\fixture\\neutral', signal);
      };

      it('uses only bounded system PowerShell, HKCU and an exact-byte embedded signature, never WinGet', async () => {
        const world = windowsReceiptWorld();
        world.dependencies.environment.PSModulePath = 'C:\\hostile\\modules';
        world.dependencies.environment.NODE_OPTIONS = '--require=hostile';
        const observed = await inspect(world);
        expect(observed).toMatchObject({ signatureStatus: 'valid', certificateSha256: world.policy.winget.certificateSha256 });
        expect(observed).not.toHaveProperty('source');
        expect(observed).not.toHaveProperty('owner');
        expect(world.runner.run).toHaveBeenCalledTimes(1);
        const [command, options] = world.runner.run.mock.calls[0];
        expect(command.executable).toBe(world.powershell);
        expect(command.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
        expect(command.args).not.toContain('-ExecutionPolicy');
        const script = Buffer.from(command.args[4], 'base64').toString('utf16le');
        expect(script).toContain('[Microsoft.Win32.RegistryHive]::CurrentUser');
        expect(script).not.toContain('LocalMachine');
        expect(script).toContain(".OpenSubKey(('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $inputData.appId + '_is1'), $false)");
        expect(script).toContain('[IO.FileShare]::Read');
        expect(script).toContain('Get-AuthenticodeSignature -LiteralPath');
        expect(script).toContain("$signature.SignatureType.ToString() -cne 'Authenticode'");
        expect(script).toContain("$policy -eq 'Restricted' -or $policy -eq 'AllSigned'");
        expect(script).not.toMatch(/winget|Set-ExecutionPolicy|SetValue|CreateSubKey|Register-ObjectEvent|Invoke-Expression/i);
        expect(options).toMatchObject({
          cwd: 'C:\\fixture\\neutral', inheritEnvironment: false, ensureProcessTreeSettled: true,
          maxOutputBytes: 16 * 1024, redactArgIndices: [4],
          env: { NODE_OPTIONS: '', NODE_PATH: '', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0',
            PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
            LOCALAPPDATA: 'C:\\fixture\\neutral' }
        });
      });

      it.skipIf(process.platform !== 'win32')('parses the observation and refuses a unique absent HKCU key with real Windows PowerShell', async () => {
        const world = windowsReceiptWorld();
        await inspect(world);
        const source = Buffer.from(world.runner.run.mock.calls[0][0].args[4], 'base64').toString('utf16le');
        const input = Buffer.from(source).toString('base64');
        const parser = `$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'));` +
          '$tokens=$null;$errors=$null;$null=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);' +
          'if($errors.Count -ne 0){[Console]::Error.WriteLine(($errors | Out-String));exit 1};[Console]::Write("parsed")';
        const host = defaultSelfUpgradeDependencies();
        const root = host.environment.SystemRoot;
        if (!root) throw new Error('Actual Windows SystemRoot is required for the parser control.');
        const directory = await host.makeNeutralDirectory();
        try {
          const options = {
            cwd: directory, inheritEnvironment: false, ensureProcessTreeSettled: true, timeoutMs: 60_000, maxOutputBytes: 16 * 1024,
            env: { SystemRoot: root, TEMP: directory, TMP: directory, DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0',
              NODE_OPTIONS: '', NODE_PATH: '' }
          };
          const executable = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          const result = await host.runner.run({
            executable,
            args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')]
          }, options);
          expect(result).toMatchObject({ status: 0, stdout: 'parsed', timedOut: false, processTreeSettled: true });
          const payloadMatch = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(source);
          if (!payloadMatch) throw new Error('The exact observation payload is required.');
          const payload: Record<string, unknown> = JSON.parse(Buffer.from(payloadMatch[1], 'base64').toString('utf8'));
          payload.appId = `Liftoff.Observation.Absent.${randomUUID()}`;
          const observation = source.replace(payloadMatch[1], Buffer.from(JSON.stringify(payload)).toString('base64'));
          const absent = await host.runner.run({
            executable,
            args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(observation, 'utf16le').toString('base64')]
          }, options);
          expect(absent).toMatchObject({ status: 1, stdout: '', timedOut: false, processTreeSettled: true });
          expect(absent.stderr.trim()).toMatch(/^Windows installer registration observation unavailable \((?:registration|policy)\)\.$/);
        } finally {
          await host.removeNeutralDirectory(directory);
        }
      }, 120_000);

      it.each(['scope', 'appId', 'installLocation', 'version', 'publisher', 'receiptSha256', 'currentSha256',
        'registeredLauncherSha256', 'registeredCertificateSha256', 'launcherSha256', 'certificateSha256',
        'signatureStatus', 'signatureType', 'extra', 'missing'] as const)(
        'rejects independent %s mismatch even when the manager port claims valid ownership', async field => {
          const world = windowsReceiptWorld();
          if (field === 'missing') Reflect.deleteProperty(world.registration, 'receiptSha256');
          else Reflect.set(world.registration, field, field === 'signatureType' ? 'Catalog' : 'foreign');
          await expect(createNativeUpgradePort(world.dependencies, { winget: async () => world.winget })
            .inspect(world.packageRoot, '0.12.3', 'C:\\fixture\\neutral'))
            .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
        }
      );

      it.each(['missing', 'ambiguous', 'relative', 'UNC', 'stream', 'traversal'] as const)(
        'refuses %s system PowerShell attribution without a guessed fallback', async kind => {
          const world = windowsReceiptWorld();
          const environment = world.dependencies.environment;
          if (kind === 'missing') delete environment.SystemRoot;
          else if (kind === 'ambiguous') environment.SYSTEMROOT = environment.SystemRoot;
          else environment.SystemRoot = kind === 'relative' ? 'Windows' : kind === 'UNC' ? '\\\\server\\Windows'
            : kind === 'stream' ? 'C:\\Windows:alternate' : 'C:\\Windows\\..\\Windows';
          await expect(inspect(world)).rejects.toMatchObject({ reasonCode: 'native_unavailable' });
          expect(world.runner.run).not.toHaveBeenCalled();
        }
      );

      it.each(['linked PowerShell', 'redirected PowerShell', 'invalid timeout', 'unqualified certificate', 'cancelled'] as const)(
        'rejects %s before starting an observation process', async kind => {
          const world = windowsReceiptWorld();
          if (kind === 'linked PowerShell') world.world.nodes.set(world.powershell, { kind: 'symlink', target: world.powershell });
          if (kind === 'redirected PowerShell') {
            const realpath = world.dependencies.realpath;
            world.dependencies.realpath = async filename => filename === world.powershell ? 'C:\\foreign\\powershell.exe' : realpath(filename);
          }
          if (kind === 'invalid timeout') Object.assign(world.dependencies, { probeTimeoutMs: 0 });
          if (kind === 'unqualified certificate') world.policy.winget.certificateSha256 = null;
          await expect(inspect(world, kind === 'cancelled' ? AbortSignal.abort() : new AbortController().signal))
            .rejects.toMatchObject({
              reasonCode: kind === 'unqualified certificate' ? 'native_unqualified' : kind === 'cancelled' ? 'native_timeout'
                : kind === 'invalid timeout' ? 'native_invalid' : 'native_unavailable'
            });
          expect(world.runner.run).not.toHaveBeenCalled();
        }
      );

      it.each(['timeout', 'aborted', 'unsettled', 'output limit', 'invalid JSON'] as const)(
        'rejects %s process results without promoting receipt-only ownership', async kind => {
          const world = windowsReceiptWorld();
          const run = world.runner.run.getMockImplementation()!;
          world.runner.run.mockImplementation(async (command, options) => {
            const result = await run(command, options);
            return { ...result, ...(kind === 'timeout' ? { timedOut: true }
              : kind === 'aborted' ? { aborted: true } : kind === 'unsettled' ? { processTreeSettled: false }
              : kind === 'output limit' ? { outputLimitExceeded: true } : { stdout: '{invalid' }) };
          });
          await expect(inspect(world)).rejects.toMatchObject({
            reasonCode: kind === 'timeout' ? 'native_timeout' : kind === 'invalid JSON' ? 'native_invalid' : 'native_unavailable'
          });
        }
      );

      it.each(['pointer', 'selection', 'receipt', 'policy'] as const)(
        'rechecks %s after the OS signature and registry observation', async kind => {
          const world = windowsReceiptWorld();
          const run = world.runner.run.getMockImplementation()!;
          world.runner.run.mockImplementation(async (command, options) => {
            const result = await run(command, options);
            if (kind === 'pointer') world.files.set(world.pointerFile, Buffer.from('changed\r\n'));
            if (kind === 'selection') world.dependencies.resolveLiftoff = async () => world.installation.launcher;
            if (kind === 'receipt') world.files.set(world.receiptFile, Buffer.from('{}'));
            if (kind === 'policy') world.policy.approvedSigningKeySha256 = 'f'.repeat(64);
            return result;
          });
          await expect(inspect(world)).rejects.toMatchObject({
            reasonCode: 'owner_changed'
          });
        }
      );
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
