import { createHash } from 'node:crypto';
import path from 'node:path';
import { commandFailed, comparisonPath } from '../../domain/distribution/liftoff-npm-installation.js';
import { SelfUpgradeFailure, selfUpgradeProbeTimeoutMs } from '../../domain/distribution/liftoff-upgrade.js';
import type { NativeBundleInventory, NativeReleasePolicy, WindowsInstallerLayout } from '../../domain/distribution/native-upgrade.js';
import type { SelfUpgradeDependencies } from './upgrade-host.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new SelfUpgradeFailure('blocked', 'unsupported_installation');
const same = (left: string, right: string) => comparisonPath(left, 'win32') === comparisonPath(right, 'win32');
const drivePath = (value: string) => /^[A-Za-z]:\\/.test(value) &&
  !/[/\u0000-\u001f<>:"|?*]/.test(value.slice(3)) && path.win32.normalize(value) === value;

/** Local installer attribution only; neither a WinGet source observation nor publisher authentication. */
export async function readWindowsInstallerLayout(
  dependencies: SelfUpgradeDependencies, installation: NativeBundleInventory, policy: NativeReleasePolicy,
  selectedLauncher: string | null, signal: AbortSignal
): Promise<WindowsInstallerLayout> {
  const approved = policy.winget;
  if (!policy.approvedSigningKeySha256 || !approved.packageIdentifier || !approved.installerAppId ||
    !approved.publisher || !approved.certificateSha256) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  if (dependencies.platform !== 'win32' || installation.target !== 'win32-x64') throw invalid();
  if (!dependencies.readBytes || !dependencies.lstatBigInt) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
  const localValues = Object.entries(dependencies.environment).filter(([key]) => key.toLowerCase() === 'localappdata');
  const local = localValues[0]?.[1];
  if (localValues.length !== 1 || !local || !drivePath(local)) throw invalid();
  const installRoot = path.win32.join(local, 'Programs', 'Liftoff');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(installation.version) ||
    installation.version.length > 128 || !/^[a-f0-9]{64}$/.test(installation.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(installation.inventorySha256) || !/^[a-f0-9]{40}$/.test(installation.sourceCommit)) throw invalid();
  const versionName = `${installation.version}-${installation.manifestSha256}`;
  const versionDirectory = `versions/${versionName}`;
  const stableLauncher = path.win32.join(installRoot, 'bin', 'liftoff.exe');
  if (versionName.length > 193 || !same(installation.bundleRoot, path.win32.join(installRoot, 'versions', versionName)) ||
    !same(installation.launcher, path.win32.join(installation.bundleRoot, 'bin', 'liftoff.exe')) ||
    !same(installation.runtime, path.win32.join(installation.bundleRoot, 'runtime', 'node.exe'))) throw invalid();
  if (!selectedLauncher || !same(selectedLauncher, stableLauncher)) {
    throw new SelfUpgradeFailure('blocked', 'executable_selection');
  }
  const directories = new Map<string, string>();
  const files = new Map<string, { bytes: Buffer; maximum: number }>();
  const check = () => {
    if (signal.aborted) throw new SelfUpgradeFailure('failed', 'native_timeout');
  };
  const inspectDirectory = async (directory: string) => {
    check();
    const stat = await dependencies.lstatBigInt!(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await dependencies.realpath(directory), directory)) throw invalid();
    const identity = JSON.stringify([stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.birthtimeNs].map(value => value.toString()));
    const previous = directories.get(directory);
    if (previous && previous !== identity) throw new SelfUpgradeFailure('blocked', 'owner_changed');
    directories.set(directory, identity);
  };
  const inspectAncestors = async (directory: string) => {
    for (;;) {
      await inspectDirectory(directory);
      const parent = path.win32.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  };
  const read = async (filename: string, maximum: number) => {
    await inspectAncestors(path.win32.dirname(filename));
    const stat = await dependencies.lstatBigInt!(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      !same(await dependencies.realpath(filename), filename)) throw invalid();
    const bytes = await dependencies.readBytes!(filename, maximum);
    if (!bytes.length || bytes.length > maximum) throw invalid();
    check();
    const previous = files.get(filename);
    if (previous && !previous.bytes.equals(bytes)) throw new SelfUpgradeFailure('blocked', 'owner_changed');
    files.set(filename, { bytes: Buffer.from(bytes), maximum });
    return bytes;
  };
  const receiptBytes = await read(path.win32.join(installRoot, 'native-install.json'), 16 * 1024);
  let receipt: unknown;
  try { receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)); }
  catch { throw invalid(); }
  const pointer = await read(path.win32.join(installRoot, 'current.txt'), 256);
  if (!pointer.equals(Buffer.from(`${versionName}\r\n`, 'ascii'))) throw invalid();
  const stableBytes = await read(stableLauncher, 8 * 1024 * 1024);
  const innerBytes = await read(installation.launcher, 8 * 1024 * 1024);
  if (!stableBytes.equals(innerBytes)) throw invalid();
  const stableLauncherSha256 = hash(stableBytes);
  const expected = {
    schemaVersion: 1, kind: 'liftoff-windows-install-receipt', scope: 'user',
    package: '@msn-control/liftoff', packageIdentifier: approved.packageIdentifier, appId: approved.installerAppId,
    publisher: approved.publisher, certificateSha256: approved.certificateSha256, version: installation.version,
    sourceCommit: installation.sourceCommit, manifestSha256: installation.manifestSha256,
    inventorySha256: installation.inventorySha256, versionDirectory,
    launcher: `${versionDirectory}/bin/liftoff.exe`, runtime: `${versionDirectory}/runtime/node.exe`,
    stableLauncher: 'bin/liftoff.exe', stableLauncherSha256
  };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    Object.keys(receipt).sort().join() !== Object.keys(expected).sort().join() ||
    Object.entries(expected).some(([key, value]) => Reflect.get(receipt, key) !== value)) throw invalid();
  for (const [filename, previous] of files) await read(filename, previous.maximum);
  for (const directory of directories.keys()) await inspectDirectory(directory);
  check();
  const receiptSha256 = hash(receiptBytes), currentSha256 = hash(pointer);
  const policySha256 = hash(Buffer.from(JSON.stringify(policy)));
  return {
    installRoot, stableLauncher, receiptSha256, currentSha256, stableLauncherSha256, policySha256,
    identity: JSON.stringify([installRoot, receiptSha256, currentSha256, stableLauncherSha256, policySha256, [...directories]])
  };
}

const registrationScript = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$ProgressPreference = 'SilentlyContinue'
$phase = 'bootstrap'
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Unsupported PowerShell.' }
  Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
  $phase = 'policy'
  $policy = Microsoft.PowerShell.Security\Get-ExecutionPolicy
  if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') { throw 'Script execution is restricted.' }
  $phase = 'bootstrap'
  Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $inputData = Microsoft.PowerShell.Utility\ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INPUT__')))
  $base = $null
  $key = $null
  $stream = $null
  try {
    $phase = 'registration'
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    $key = $base.OpenSubKey(('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $inputData.appId + '_is1'), $false)
    if ($null -eq $key) { throw 'Missing user installer registration.' }
    function Read-String([string] $name) {
      if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Invalid registration type.' }
      return $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
    $names = @('InstallLocation', 'DisplayVersion', 'Publisher', 'LiftoffReceiptSha256', 'LiftoffCurrentSha256', 'LiftoffLauncherSha256', 'LiftoffCertificateSha256')
    $values = @{}
    foreach ($name in $names) { $values[$name] = Read-String $name }
    $phase = 'launcher'
    $stream = [IO.File]::Open($inputData.launcher, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -le 0 -or $stream.Length -gt 8388608) { throw 'Unbounded launcher.' }
    function Hash-Stream {
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $stream.Position = 0
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
      } finally { $sha.Dispose() }
    }
    $launcherSha256 = Hash-Stream
    if ($launcherSha256 -cne $inputData.launcherSha256) { throw 'Changed launcher.' }
    $phase = 'signature'
    $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $inputData.launcher -ErrorAction Stop
    if ($signature.Status.ToString() -cne 'Valid' -or $signature.SignatureType.ToString() -cne 'Authenticode' -or $null -eq $signature.SignerCertificate) { throw 'Unverified embedded signature.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $certificateSha256 = ([BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    if ((Hash-Stream) -cne $launcherSha256) { throw 'Changed launcher.' }
    $phase = 'recheck'
    $key.Dispose()
    $key = $base.OpenSubKey(('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $inputData.appId + '_is1'), $false)
    if ($null -eq $key) { throw 'Changed registration.' }
    foreach ($name in $names) {
      if ($values[$name] -cne (Read-String $name)) { throw 'Changed registration.' }
    }
    $result = [ordered]@{
      schemaVersion = 1
      kind = 'liftoff-windows-installer-registration-observation'
      scope = 'user'
      appId = $inputData.appId
      installLocation = $values['InstallLocation']
      version = $values['DisplayVersion']
      publisher = $values['Publisher']
      receiptSha256 = $values['LiftoffReceiptSha256']
      currentSha256 = $values['LiftoffCurrentSha256']
      registeredLauncherSha256 = $values['LiftoffLauncherSha256']
      registeredCertificateSha256 = $values['LiftoffCertificateSha256']
      launcherSha256 = $launcherSha256
      certificateSha256 = $certificateSha256
      signatureStatus = 'valid'
      signatureType = 'Authenticode'
    }
    [Console]::Write((Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $result -Compress -Depth 3))
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $key) { $key.Dispose() }
    if ($null -ne $base) { $base.Dispose() }
  }
} catch {
  [Console]::Error.WriteLine("Windows installer registration observation unavailable ($phase).")
  exit 1
}
`;

/** HKCU and exact-byte signer evidence only; never manager/source attribution. */
export async function readWindowsInstallerRegistration(
  dependencies: SelfUpgradeDependencies, installation: NativeBundleInventory, policy: NativeReleasePolicy,
  neutralDirectory: string, signal: AbortSignal
): Promise<Readonly<{ identity: string; signatureStatus: 'valid'; certificateSha256: string }>> {
  const check = () => {
    if (signal.aborted) throw new SelfUpgradeFailure('failed', 'native_timeout');
  };
  check();
  const layout = installation.windowsInstaller;
  if (!layout) throw invalid();
  const certificateSha256 = policy.winget.certificateSha256;
  if (!certificateSha256) throw new SelfUpgradeFailure('blocked', 'native_unqualified');
  if (!drivePath(neutralDirectory)) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
  const before = await readWindowsInstallerLayout(dependencies, installation, policy,
    await dependencies.resolveLiftoff?.() ?? null, signal);
  if (before.identity !== layout.identity) throw new SelfUpgradeFailure('blocked', 'owner_changed');
  const roots = Object.entries(dependencies.environment).filter(([key]) => key.toLowerCase() === 'systemroot');
  const root = roots[0]?.[1];
  if (roots.length !== 1 || !root || !drivePath(root)) {
    throw new SelfUpgradeFailure('blocked', 'native_unavailable');
  }
  const home = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0');
  const executable = path.win32.join(home, 'powershell.exe');
  const executableStat = await dependencies.lstat(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink() ||
    !same(await dependencies.realpath(executable), executable)) throw new SelfUpgradeFailure('blocked', 'native_unavailable');
  const timeoutMs = dependencies.probeTimeoutMs ?? selfUpgradeProbeTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new SelfUpgradeFailure('failed', 'native_invalid');
  }
  const payload = Buffer.from(JSON.stringify({
    appId: policy.winget.installerAppId, launcher: layout.stableLauncher, launcherSha256: layout.stableLauncherSha256
  })).toString('base64');
  const encoded = Buffer.from(registrationScript.replace('__INPUT__', payload), 'utf16le').toString('base64');
  check();
  const result = await dependencies.runner.run({
    executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  }, {
    cwd: neutralDirectory, timeoutMs, signal, maxOutputBytes: 16 * 1024,
    inheritEnvironment: false, ensureProcessTreeSettled: true, redactArgIndices: [4],
    env: {
      SystemRoot: root, PATH: `${home};${path.win32.join(root, 'System32')}`,
      PSModulePath: path.win32.join(home, 'Modules'), POWERSHELL_TELEMETRY_OPTOUT: '1',
      USERPROFILE: neutralDirectory, HOME: neutralDirectory, APPDATA: neutralDirectory, LOCALAPPDATA: neutralDirectory,
      TEMP: neutralDirectory, TMP: neutralDirectory, DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '0', CI: 'true',
      NODE_OPTIONS: '', NODE_PATH: ''
    }
  });
  check();
  if (commandFailed(result)) throw new SelfUpgradeFailure('failed', result.timedOut ? 'native_timeout' : 'native_unavailable');
  let observed: unknown;
  try { observed = JSON.parse(result.stdout); }
  catch { throw new SelfUpgradeFailure('failed', 'native_invalid'); }
  const expected = {
    schemaVersion: 1, kind: 'liftoff-windows-installer-registration-observation', scope: 'user',
    appId: policy.winget.installerAppId, installLocation: layout.installRoot, version: installation.version,
    publisher: policy.winget.publisher, receiptSha256: layout.receiptSha256, currentSha256: layout.currentSha256,
    registeredLauncherSha256: layout.stableLauncherSha256, registeredCertificateSha256: policy.winget.certificateSha256,
    launcherSha256: layout.stableLauncherSha256, certificateSha256: policy.winget.certificateSha256,
    signatureStatus: 'valid', signatureType: 'Authenticode'
  };
  if (!observed || typeof observed !== 'object' || Array.isArray(observed) ||
    Object.keys(observed).sort().join() !== Object.keys(expected).sort().join() ||
    Object.entries(expected).some(([key, value]) => key === 'installLocation'
      ? typeof Reflect.get(observed, key) !== 'string' || !same(Reflect.get(observed, key), layout.installRoot)
      : Reflect.get(observed, key) !== value)) throw invalid();
  try {
    const after = await readWindowsInstallerLayout(dependencies, installation, policy,
      await dependencies.resolveLiftoff?.() ?? null, signal);
    if (after.identity !== layout.identity) throw new SelfUpgradeFailure('blocked', 'owner_changed');
  } catch (error) {
    if (error instanceof SelfUpgradeFailure && ['unsupported_installation', 'executable_selection'].includes(error.reasonCode)) {
      throw new SelfUpgradeFailure('blocked', 'owner_changed');
    }
    throw error;
  }
  check();
  return Object.freeze({ identity: hash(Buffer.from(JSON.stringify([expected, layout.identity]))),
    signatureStatus: 'valid', certificateSha256 });
}
