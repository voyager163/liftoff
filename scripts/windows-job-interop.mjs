import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const windowsJobInteropSdkVersion = '10.0.402';
const assemblyName = 'Liftoff.WindowsJob.Interop.dll';

export function extractWindowsJobInteropSource(controller) {
  const matches = [...controller.toString('utf8').matchAll(/\$win32TypeDef = @"\r?\n([\s\S]+?)\r?\n"@/gu)];
  assert.equal(matches.length, 1, 'Expected exactly one literal Windows Job interop source.');
  return Buffer.from(matches[0][1]);
}

export async function buildWindowsJobInterop({ write = false } = {}) {
  const source = extractWindowsJobInteropSource(await readFile(path.join(root, 'assets/repair/windows-job-controller.ps1')));
  const workspace = await mkdtemp(path.join(tmpdir(), 'liftoff-interop-build-'));
  const environment = {
    ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_NOLOGO: '1',
    DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1',
    DOTNET_CLI_HOME: path.join(workspace, 'home'), NUGET_PACKAGES: path.join(workspace, 'packages')
  };
  const run = (args, cwd) => {
    const result = spawnSync('dotnet', args, {
      cwd, env: environment, encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 180_000, maxBuffer: 1024 * 1024
    });
    if (result.error) throw new Error(`Windows interop rebuild could not run dotnet: ${result.error.message}`);
    assert.equal(result.status, 0, `Windows interop rebuild failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    const outputs = [];
    for (const name of ['first', 'second']) {
      const directory = path.join(workspace, name);
      await mkdir(directory);
      await writeFile(path.join(directory, 'global.json'), JSON.stringify({
        sdk: { version: windowsJobInteropSdkVersion, rollForward: 'disable', allowPrerelease: false }
      }));
      await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources></configuration>');
      await copyFile(path.join(root, 'scripts/windows-job-interop/Interop.csproj'), path.join(directory, 'Interop.csproj'));
      await copyFile(path.join(root, 'scripts/windows-job-interop/packages.lock.json'), path.join(directory, 'packages.lock.json'));
      await writeFile(path.join(directory, 'Win32JobNative.cs'), source);
      assert.equal(run(['--version'], directory), windowsJobInteropSdkVersion, 'Unexpected interop compiler SDK.');
      run(['restore', 'Interop.csproj', '--locked-mode', '--configfile', 'NuGet.Config', '--verbosity', 'quiet'], directory);
      run(['build', 'Interop.csproj', '--configuration', 'Release', '--no-restore', '--no-incremental',
        '--disable-build-servers', '--output', 'output', '--verbosity', 'quiet'], directory);
      outputs.push(await readFile(path.join(directory, 'output', assemblyName)));
    }
    assert.deepEqual(outputs[0], outputs[1], 'Independent Windows interop rebuilds differ.');
    const target = path.join(root, 'assets/repair', assemblyName);
    if (write) await writeFile(target, outputs[0], { mode: 0o644 });
    else assert.deepEqual(outputs[0], await readFile(target), 'Packaged Windows interop differs from its literal C# rebuild.');
    const receipt = {
      sdk: windowsJobInteropSdkVersion, targetFramework: 'net462', referenceAssemblyPackage: '1.0.3',
      csharpSha256: createHash('sha256').update(source).digest('hex'),
      bytes: outputs[0].length, sha256: createHash('sha256').update(outputs[0]).digest('hex'),
      independentRebuilds: 2, windowsExecutionQualified: false
    };
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally {
    await rm(workspace, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--write'),
      'Usage: node scripts/windows-job-interop.mjs [--write]');
    await buildWindowsJobInterop({ write: args[0] === '--write' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
