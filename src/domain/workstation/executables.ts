import path from 'node:path';
import type { SupportedPlatform, WorkstationRequirementDefinition } from '../../workstation-catalog.js';
import type { ExecutableIdentity, InstallationOrigin } from './contracts.js';

export interface ExecutableObservationContext {
  platform: SupportedPlatform;
  cwd: string;
  env: NodeJS.ProcessEnv;
  definition: WorkstationRequirementDefinition;
}

export interface ExecutableObserver {
  resolve(executable: string, context: ExecutableObservationContext): Promise<ExecutableIdentity>;
  inspect(candidate: string, context: ExecutableObservationContext): Promise<ExecutableIdentity>;
}

export const unavailableExecutableObserver: ExecutableObserver = {
  async resolve(executable) {
    return unavailable(executable, 'not-observable');
  },
  async inspect(candidate) {
    return unavailable(candidate, 'not-observable');
  }
};

export function hostPath(platform: SupportedPlatform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function environmentValue(env: NodeJS.ProcessEnv, name: string, platform: SupportedPlatform): string | undefined {
  const key = platform === 'win32'
    ? Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase())
    : name;
  return key === undefined ? undefined : env[key];
}

export function executableCandidates(executable: string, context: ExecutableObservationContext): string[] {
  const nativePath = hostPath(context.platform);
  const hasPath = /[/\\]/.test(executable);
  if (!hasPath && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executable)) return [];
  const extensionList = (environmentValue(context.env, 'PATHEXT', context.platform) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => /^\.(?:exe|com|cmd|bat)$/i.test(extension));
  const extensions = context.platform === 'win32' && !nativePath.extname(executable)
    ? extensionList
    : [''];
  const directories = hasPath
    ? ['']
    : [
        ...(context.platform === 'win32' ? [context.cwd] : []),
        ...(environmentValue(context.env, 'PATH', context.platform) ?? '')
          .slice(0, 32_768).split(nativePath.delimiter).slice(0, 256)
      ];
  return [...new Set(directories.flatMap((directory) => {
    const root = directory.replace(/^"(.*)"$/, '$1');
    const candidate = hasPath
      ? nativePath.resolve(context.cwd, executable)
      : nativePath.resolve(context.cwd, root, executable);
    return extensions.map((extension) => `${candidate}${extension}`);
  }))];
}

export function originFromPath(target: string, context: ExecutableObservationContext): InstallationOrigin {
  const normalized = target.replaceAll('\\', '/');
  const value = context.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const identities = context.definition.packageIdentities;
  const npm = identities?.npm;
  if (npm && value.includes(`/node_modules/${context.platform === 'win32' ? npm.toLowerCase() : npm}/`)) return 'npm';
  const brew = identities?.brew;
  if (brew && (value.includes(`/Cellar/${brew}/`) || value.includes(`/Caskroom/${brew}/`))) return 'brew';
  const uv = identities?.uv;
  if (uv && value.includes(`/uv/tools/${uv}/`)) return 'uv';
  const winget = identities?.winget?.toLowerCase();
  if (winget && value.includes(`/microsoft/winget/packages/${winget}_`)) return 'winget';
  if (context.definition.id === 'claude' && value.includes('/.local/share/claude/versions/')) return 'standalone';
  return 'unknown';
}

export function unavailable(executable: string, resolution: 'missing' | 'not-observable'): ExecutableIdentity {
  return { executable, resolution, origin: 'unknown', evidence: 'unavailable' };
}
