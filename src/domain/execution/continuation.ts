import path from 'node:path';
import { commandShellForPlatform, formatShellCommand, quoteCommandArgument } from './shell-command.js';

export class ContinuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationError';
  }
}

export class ContinuationSecretError extends ContinuationError {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationSecretError';
  }
}

const secretPatterns: readonly RegExp[] = [
  /ghp_[A-Za-z0-9_]{30,}/,
  /gho_[A-Za-z0-9_]{30,}/,
  /github_pat_[A-Za-z0-9_]{60,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /^Bearer\s+[A-Za-z0-9._~+/=-]+$/i,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
];

const secretFlagNames: readonly string[] = [
  '--token',
  '--pat',
  '--secret',
  '--password',
  '--api-key',
  '--apikey',
  '--private-key',
  '--client-secret'
];

/**
 * Asserts that arguments contain no raw secret values.
 * Opaque references (e.g. env var names, paths, or urns) are permitted.
 */
export function assertNoSecretValues(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Check for inline secret flags: --token=xyz
    for (const flag of secretFlagNames) {
      if (arg.startsWith(`${flag}=`)) {
        const val = arg.slice(flag.length + 1).trim();
        if (val.length > 0 && !val.startsWith('$') && !val.startsWith('ref:')) {
          throw new ContinuationSecretError(
            `Secret value commands are forbidden in continuation contracts: flag ${flag} contained raw value.`
          );
        }
      }
    }

    // Check for separate secret flags: --token xyz
    if (secretFlagNames.includes(arg) && i + 1 < args.length) {
      const next = args[i + 1];
      if (next.length > 0 && !next.startsWith('$') && !next.startsWith('ref:')) {
        throw new ContinuationSecretError(
          `Secret value commands are forbidden in continuation contracts: flag ${arg} followed by raw secret value.`
        );
      }
    }

    // Check for raw secret tokens in any argument
    for (const pattern of secretPatterns) {
      if (pattern.test(arg)) {
        throw new ContinuationSecretError(
          'Secret value commands are forbidden in continuation contracts: token pattern matched in arguments.'
        );
      }
    }
  }
}

/**
 * Protocol admission rule:
 * Absent governance scope must resolve to 'activation'.
 */
export function resolveGovernanceScope(command: string, explicitScope?: string): string | undefined {
  if (command === 'governance assess') {
    if (explicitScope !== undefined && explicitScope !== 'governance-assessment') {
      throw new ContinuationError('Governance assessment cannot claim an activation or enforcement scope.');
    }
    return 'governance-assessment';
  }
  if (command === 'governance' || command.startsWith('governance ')) {
    if (explicitScope !== undefined && !['local', 'repository', 'activation', 'lifecycle'].includes(explicitScope)) {
      throw new ContinuationError('Unknown governance continuation scope.');
    }
    return explicitScope ?? 'activation';
  }
  return explicitScope;
}

export function canonicalizePathBoundary(targetPath: string, rootBoundary?: string): string {
  if (targetPath.includes('\0')) {
    throw new ContinuationError('Invalid path containing null bytes.');
  }
  if (!targetPath || targetPath.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(targetPath) ||
      targetPath !== targetPath.normalize('NFKC') || /^\\\\[?.]\\/.test(targetPath) ||
      /^[a-z]:($|[^\\/])/iu.test(targetPath) || targetPath.startsWith('//')) {
    throw new ContinuationError('Invalid, noncanonical, or ambiguous native path boundary.');
  }
  const windows = /^[a-z]:/iu.test(targetPath) || targetPath.startsWith('\\') ||
    rootBoundary !== undefined && (/^[a-z]:/iu.test(rootBoundary) || rootBoundary.startsWith('\\'));
  const nativePath = windows ? path.win32 : path.posix;
  if (windows && targetPath.startsWith('\\') && !/^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/u.test(targetPath)) {
    throw new ContinuationError('Windows paths require an explicit drive or complete UNC share.');
  }
  const normalized = nativePath.normalize(targetPath);
  if (rootBoundary) {
    const canonicalRoot = canonicalizePathBoundary(rootBoundary);
    const relative = nativePath.relative(canonicalRoot, normalized);
    if (relative === '..' || relative.startsWith(`..${nativePath.sep}`) || nativePath.isAbsolute(relative)) {
      throw new ContinuationError('Path traversal detected: target escapes its declared root boundary.');
    }
  }

  return normalized;
}

export function quoteShellArgument(arg: string, platform: NodeJS.Platform = process.platform): string {
  return quoteCommandArgument(arg, commandShellForPlatform(platform));
}

export function formatNativeSafeCommandLine(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  assertNoSecretValues([executable, ...args]);
  return formatShellCommand({ executable, args: [...args] }, commandShellForPlatform(platform));
}
