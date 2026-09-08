export const migrationExcludedDirectories: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next'
]);

const familiarProjectFiles: ReadonlySet<string> = new Set([
  '.ds_store', '.gitignore',
  'readme', 'readme.md', 'readme.rst', 'readme.txt',
  'license', 'license.md', 'license.txt'
]);

export function excludesMigrationDirectory(name: string): boolean {
  return migrationExcludedDirectories.has(name.toLowerCase());
}

export function needsMigrationPlacement(name: string): boolean {
  return !excludesMigrationDirectory(name) && !familiarProjectFiles.has(name.toLowerCase());
}
