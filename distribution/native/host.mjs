import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import policy from './platforms.json' with { type: 'json' };

export function atLeastVersion(actual, minimum) {
  assert.match(actual ?? '', /^\d+(?:\.\d+){1,3}(?:[-+].*)?$/, 'Host version is unavailable or malformed.');
  const left = actual.split(/[-+]/)[0].split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return true;
}

function read(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 65_536
  });
  assert.equal(result.status, 0, `Cannot establish native host identity using ${command}: ${result.error?.code ?? result.status}`);
  return result.stdout.trim();
}

export function observeNativeHost() {
  const observed = {
    platform: process.platform, architecture: process.arch,
    runtimeVersion: process.versions.node, osVersion: os.release()
  };
  if (process.platform === 'darwin') {
    observed.osVersion = read('/usr/bin/sw_vers', ['-productVersion']);
    observed.nativeArchitecture = read('/usr/bin/uname', ['-m']);
    observed.appleSilicon = read('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
    observed.translated = read('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']);
  } else if (process.platform === 'linux') {
    observed.nativeArchitecture = read('/usr/bin/uname', ['-m']);
    observed.glibcVersion = process.report.getReport().header.glibcVersionRuntime ?? null;
  } else if (process.platform === 'win32') {
    const machine = os.machine();
    observed.nativeArchitecture = machine === 'x86_64' ? 'AMD64' : machine;
  }
  return observed;
}

export function assertNativeHost(observed, { publicInstallation = false } = {}) {
  const target = `${observed.platform}-${observed.architecture}`;
  const floor = policy.targets[target];
  assert.ok(floor, `Unsupported native target ${target}; keep the existing npm installation.`);
  assert.equal(observed.runtimeVersion, policy.runtimeVersion, 'Native qualification requires the pinned runtime.');
  assert.equal(observed.nativeArchitecture, floor.nativeArchitecture, 'Translated or foreign-architecture execution is not native qualification.');
  if (observed.platform === 'darwin') {
    assert.equal(observed.appleSilicon, '1', 'Native Apple Silicon hardware is required.');
    assert.ok(observed.translated === '' || observed.translated === '0', 'Rosetta execution is not qualified.');
    assert.ok(atLeastVersion(observed.osVersion, floor.minimumOs), `The runtime requires macOS ${floor.minimumOs} or newer.`);
  } else if (observed.platform === 'linux') {
    assert.ok(atLeastVersion(observed.osVersion, floor.minimumKernel), `The runtime requires Linux kernel ${floor.minimumKernel} or newer.`);
    assert.ok(observed.glibcVersion, 'musl or an unknown libc is unsupported; use a qualified glibc host.');
    assert.ok(atLeastVersion(observed.glibcVersion, floor.minimumGlibc), `The runtime requires glibc ${floor.minimumGlibc} or newer.`);
  } else {
    assert.ok(atLeastVersion(observed.osVersion, floor.minimumOs), 'The runtime requires Windows 10/Server 2016 or newer.');
  }
  if (publicInstallation) {
    assert.equal(floor.minimumHostQualified, true, 'The minimum host has not been qualified.');
    assert.equal(floor.publicDistributionQualified, true, 'This native distribution is not qualified for public installation.');
  }
  return { target, floor, observed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Host admission takes no authority flags.');
    assertNativeHost(observeNativeHost());
  } catch (error) {
    console.error(`Liftoff native host refused: ${error.message}`);
    process.exitCode = 1;
  }
}
