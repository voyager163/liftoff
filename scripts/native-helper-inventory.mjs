export const WINDOWS_JOB_CONTROLLER_DIGEST = 'a7aa404d84d1e0a9188b8c9d487533cacee830b4d58172ef959d159895c2d909';

export const NATIVE_HELPER_INVENTORY = [
  {
    id: 'windows-job-controller',
    path: 'assets/repair/windows-job-controller.ps1',
    description: 'Win32 Job Object process-tree execution supervisor on Windows',
    measurement: 'native-powershell-process-controller',
    v8Measured: false,
    requiredPlatform: 'win32',
    expectedDigest: WINDOWS_JOB_CONTROLLER_DIGEST
  },
  {
    id: 'windows-launcher',
    path: 'scripts/distribution/windows-launcher.go',
    finalBinary: 'bin/liftoff.exe',
    description: 'Win32 Go PE native launcher executable (x64 and arm64)',
    measurement: 'native-go-pe-binary',
    v8Measured: false,
    requiredPlatform: 'win32'
  },
  {
    id: 'posix-launcher',
    path: 'bin/liftoff',
    description: 'Relocatable POSIX shell launcher for macOS and Linux',
    measurement: 'native-shell-launcher',
    v8Measured: false,
    requiredPlatform: 'posix'
  },
  {
    id: 'darwin-state-system',
    path: 'src/adapters/state/darwin-system-program.ts',
    compiledPath: 'dist/adapters/state/darwin-system-program.js',
    programExport: 'darwinStateSystemProgram',
    description: 'Embedded CPython macOS volume and Keychain observer',
    measurement: 'native-python-state-custody',
    v8Measured: false,
    requiredPlatform: 'darwin'
  },
  {
    id: 'darwin-posix-state-lock',
    path: 'src/adapters/state/posix-lock-program.ts',
    compiledPath: 'dist/adapters/state/posix-lock-program.js',
    programExport: 'posixStateLockProgram',
    description: 'Original embedded CPython macOS state-lock owner',
    measurement: 'native-python-state-lock',
    v8Measured: false,
    requiredPlatform: 'darwin'
  },
  {
    id: 'linux-posix-state-lock',
    path: 'src/adapters/state/posix-lock-program.ts',
    compiledPath: 'dist/adapters/state/posix-lock-program.js',
    programExport: 'linuxPosixStateLockProgram',
    description: 'Distinct embedded CPython Linux state-lock owner',
    measurement: 'native-python-state-lock',
    v8Measured: false,
    requiredPlatform: 'linux'
  },
  {
    id: 'linux-readonly-process',
    path: 'src/adapters/state/linux-readonly-process-program.ts',
    compiledPath: 'dist/adapters/state/linux-readonly-process-program.js',
    programExport: 'linuxReadonlyProcessProgram',
    description: 'Embedded CPython Linux Landlock content and entry write-denial guard',
    measurement: 'native-python-landlock-process',
    v8Measured: false,
    requiredPlatform: 'linux'
  },
  {
    id: 'posix-state-python-probe',
    path: 'src/adapters/state/native-system.ts',
    compiledPath: 'dist/adapters/state/native-system.js',
    programExport: 'nativeStatePythonVersionProbe',
    description: 'Embedded CPython implementation and version inspection for native private-state tools',
    measurement: 'native-python-tool-inspection',
    v8Measured: false,
    requiredPlatform: 'posix'
  }
];

export const EMBEDDED_NATIVE_HELPERS = NATIVE_HELPER_INVENTORY.filter((helper) => helper.programExport);

export function nativeHelpersForPlatform(platform) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`Unsupported native helper platform: ${platform}`);
  return NATIVE_HELPER_INVENTORY.filter((helper) =>
    helper.requiredPlatform === platform || helper.requiredPlatform === 'posix' && platform !== 'win32');
}
