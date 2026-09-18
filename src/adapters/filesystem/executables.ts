import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import type { ExecutableIdentity } from '../../domain/workstation/contracts.js';
import {
  executableCandidates,
  hostPath,
  originFromPath,
  unavailable,
  type ExecutableObservationContext,
  type ExecutableObserver
} from '../../domain/workstation/executables.js';

async function npmShim(candidate: string, packageId: string): Promise<boolean> {
  const file = await open(candidate, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8_192) return false;
    const content = await file.readFile('utf8');
    const normalized = content.replaceAll('\\', '/').toLowerCase();
    const pkg = packageId.toLowerCase();
    return /^@echo off\b/i.test(content) &&
      (normalized.includes(`%dp0%/node_modules/${pkg}/`) ||
       normalized.includes(`%~dp0/node_modules/${pkg}/`) ||
       normalized.includes(`%~dp0node_modules/${pkg}/`));
  } finally {
    await file.close();
  }
}

export const nativeExecutableObserver: ExecutableObserver = {
  async inspect(candidate, context) {
    const nativePath = hostPath(context.platform);
    const executable = nativePath.basename(candidate);
    if (!nativePath.isAbsolute(candidate) || context.platform !== process.platform) {
      return unavailable(executable, 'not-observable');
    }
    try {
      const info = await stat(candidate);
      if (!info.isFile()) return unavailable(executable, 'missing');
      await access(candidate, context.platform === 'win32' ? constants.F_OK : constants.X_OK);
      const target = await realpath(candidate);
      const kind = /\.(?:cmd|bat)$/i.test(candidate) ? 'shim' : 'executable';
      let origin = originFromPath(target, context);
      if (origin === 'unknown' && kind === 'shim' && context.definition.packageIdentities?.npm) {
        try {
          if (await npmShim(candidate, context.definition.packageIdentities.npm)) origin = 'npm';
        } catch {
          // A readable version probe does not imply permission to inspect its launcher.
        }
      }
      return {
        executable,
        resolution: 'resolved',
        resolvedPath: candidate,
        realPath: target,
        kind,
        origin,
        evidence: 'documented-location'
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return unavailable(executable, code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'not-observable');
    }
  },
  async resolve(executable, context) {
    let unobservable = false;
    for (const candidate of executableCandidates(executable, context)) {
      const identity = await this.inspect(candidate, context);
      if (identity.resolution === 'resolved') return { ...identity, executable, evidence: 'path-search' };
      if (identity.resolution === 'not-observable') unobservable = true;
    }
    return unavailable(executable, unobservable ? 'not-observable' : 'missing');
  }
};
