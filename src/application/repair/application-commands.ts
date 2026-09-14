import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { ApplicationInspectionError, applicationPathKey } from './application-files.js';
import type { ApplicationDirectoryObservation, ApplicationVerificationCommand } from './application-types.js';

export const applicationVerificationLimitation =
  'Verification covers only the explicitly declared checks when run against the bounded candidate copy. ' +
  'Live dependency trees are excluded; permitting a command is not dependency preparation or framework qualification. ' +
  'Trusted project scripts can read/write host files, start processes, and access the network. ' +
  'This is not an operating-system or network sandbox: network: false is a declaration, not enforced network isolation. ' +
  'Mandatory operating-system or network isolation is unsupported and must block execution when required. ' +
  'inspectedProjectUnchanged compares only bounded application inventory using the originally supplied manifest metadata. ' +
  'Excluded raw manifest/config/state/control/credential contents and other project/host/network effects are not proven unchanged; callers must independently recheck raw manifest and configuration. ' +
  'Results do not establish application-wide, setup, activation, deployment, or live conformance.';

export function validateApplicationCommands(
  commands: readonly ApplicationVerificationCommand[],
  snapshots: readonly ProjectFileSnapshot[],
  directories: readonly ApplicationDirectoryObservation[]
): void {
  const files = new Set(snapshots.filter((item) => item.content !== undefined).map((item) => applicationPathKey(item.pathParts)));
  const dirs = new Set(['', ...directories.filter((item) => item.exists).map((item) => applicationPathKey(item.pathParts))]);
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index++) dirs.add(parts.slice(0, index).join('/'));
  }
  for (const command of commands) {
    const cwd = applicationPathKey(command.cwdPathParts);
    if (!dirs.has(cwd)) throw new ApplicationInspectionError('Verification working directory is not in the exact candidate copy.');
    if (!['node', 'python', 'python3', 'go', 'npm'].includes(command.executable)) {
      throw new ApplicationInspectionError('Verification supports only bounded Node, Python, Go, and npm check commands; no shell, installer, Git, cloud, or state commands.');
    }
    const args = command.args;
    if (!args.length || args.some((arg) => !arg || arg.length > 1024 || /[\u0000-\u001f\u007f;&|`$<>\\]/u.test(arg))) {
      throw new ApplicationInspectionError('Verification arguments must be bounded literal arguments, not shell programs.');
    }
    const relative = (value: string): string => {
      if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
        throw new ApplicationInspectionError('Verification arguments cannot name absolute external paths.');
      }
      const normalized = path.posix.normalize(path.posix.join(cwd || '.', value));
      if (normalized === '..' || normalized.startsWith('../')) {
        throw new ApplicationInspectionError('Verification arguments cannot escape the candidate copy.');
      }
      return normalized === '.' ? '' : normalized;
    };
    for (const argument of args) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument;
      if (value.includes('/') || value.startsWith('..') || /^[A-Za-z]:/u.test(value)) relative(value);
    }
    const script = (value: string | undefined, extension: RegExp) => {
      if (!value || value.startsWith('-') || !extension.test(value) || !files.has(relative(value))) {
        throw new ApplicationInspectionError('Verification must invoke an exact inspected or staged local check file.');
      }
    };
    if (command.executable === 'node') {
      if (args[0] === '--test') {
        let checks = 0;
        for (const arg of args.slice(1)) {
          if (/^--test-(?:concurrency=[1-8]|reporter=(?:tap|spec|dot))$/u.test(arg)) continue;
          script(arg, /\.(?:[cm]?[jt]s|tsx)$/u);
          checks++;
        }
        if (!checks) throw new ApplicationInspectionError('Node verification must name at least one exact local test file.');
      } else {
        script(args[0], /\.(?:[cm]?[jt]s|tsx)$/u);
      }
    } else if (command.executable === 'python' || command.executable === 'python3') {
      const start = args.findIndex((arg) => !['-I', '-B'].includes(arg));
      if (start === -1) {
        throw new ApplicationInspectionError('Python verification must name a check script or -m pytest/unittest.');
      }
      if (args[start] === '-m') {
        if (!['pytest', 'unittest'].includes(args[start + 1] ?? '')) {
          throw new ApplicationInspectionError('Python verification permits pytest/unittest modules, not package or tool installers.');
        }
        for (const testArg of args.slice(start + 2)) {
          if (['-c', '--command'].includes(testArg) || testArg.startsWith('-c=') || testArg.startsWith('--command=')) {
            throw new ApplicationInspectionError('Inline Python verification programs are unsupported.');
          }
          if (testArg.startsWith('-')) {
            if (/\.py$/u.test(testArg)) {
              throw new ApplicationInspectionError('Verification must invoke an exact inspected or staged local check file.');
            }
            continue;
          }
          if (/\.py$/u.test(testArg)) script(testArg, /\.py$/u);
        }
      } else {
        script(args[start], /\.py$/u);
      }
    } else if (command.executable === 'go') {
      if (!['test', 'vet'].includes(args[0]!)) {
        throw new ApplicationInspectionError('Go verification permits test/vet only; downloads require declared network and never install a toolchain.');
      }
      if (args.slice(1).some((arg) => arg.startsWith('-exec') || arg.startsWith('-toolexec') ||
          arg.startsWith('-overlay') || arg.startsWith('-modfile') || arg.startsWith('-mod=') || arg === '-mod' ||
          arg.startsWith('-buildvcs') || arg.startsWith('-C') || arg.startsWith('-o'))) {
        throw new ApplicationInspectionError('Go verification cannot override executors, module files, working roots, or output locations.');
      }
    } else {
      const allowed = new Set(['test', 'build', 'check', 'lint']);
      const valid = args[0] === 'test' && args.length === 2 && args[1] === '--ignore-scripts' ||
        args[0] === 'run' && allowed.has(args[1] ?? '') && args.length === 3 && args[2] === '--ignore-scripts';
      if (!valid || !files.has(path.posix.join(cwd, 'package.json'))) {
        throw new ApplicationInspectionError('npm verification requires a local package and exact test/run test|build|check|lint with --ignore-scripts; installation and lifecycle hooks are not authorized.');
      }
    }
  }
}
