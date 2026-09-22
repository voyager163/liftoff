import path from 'node:path';

export const windowsNativeCwdLimit = 260;
export const windowsNativeCwdGuidance =
  'The selected Windows working directory exceeds the native process-launch path limit (260 UTF-16 code units including a trailing separator and terminator). ' +
  'Select a shorter supported user-local storage location explicitly before requesting a new repair preview, or use a supported shorter declared working directory. ' +
  'Existing workspace records stay at their original locations; no state is moved or removed automatically.';

export class WindowsNativeCwdError extends Error {
  readonly code = 'UNSUPPORTED_NATIVE_CWD';
  constructor() { super(windowsNativeCwdGuidance); this.name = 'WindowsNativeCwdError'; }
}

/** JavaScript string length counts UTF-16 code units, matching the native WCHAR contract. */
export function windowsNativeCwdUnits(directory: string): number {
  if (typeof directory !== 'string' || !path.win32.isAbsolute(directory) ||
      path.win32.normalize(directory) !== directory || /[\0-\x1f]/.test(directory) ||
      directory.startsWith('\\\\?\\') || directory.startsWith('\\\\.\\') ||
      !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)$/.test(path.win32.parse(directory).root)) {
    throw new Error('Native Windows cwd admission requires a resolved ordinary absolute path.');
  }
  return directory.length + (directory.endsWith('\\') ? 0 : 1) + 1;
}

export function assertWindowsNativeCwd(directory: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32' && windowsNativeCwdUnits(directory) > windowsNativeCwdLimit) throw new WindowsNativeCwdError();
}
