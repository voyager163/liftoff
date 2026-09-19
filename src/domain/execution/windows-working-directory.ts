export const windowsWorkingDirectoryLimit = 260;
export const windowsWorkingDirectoryErrorCode = 'WINDOWS_CWD_TOO_LONG';
export const windowsWorkingDirectoryRemedy =
  'The resolved Windows working directory exceeds the Win32 process-creation limit of 260 UTF-16 code units including its trailing separator and terminator. No controller or target command was started. For new work, explicitly select a shorter user-state storage location and obtain a fresh review. Preserve existing storage and records for their original recovery; do not move them or substitute path aliases.';

export function windowsWorkingDirectoryFits(directory: string): boolean {
  const separator = /[\\/]$/u.test(directory) ? 0 : 1;
  return directory.length + separator + 1 <= windowsWorkingDirectoryLimit;
}
