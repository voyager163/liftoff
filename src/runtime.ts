import { compareSemver } from './semver.js';

export const minimumNodeVersion = '20.19.0';

export function nodeRuntimeError(observedVersion = process.versions.node): string | undefined {
  if (compareSemver(observedVersion, minimumNodeVersion) >= 0) {
    return undefined;
  }
  return `Liftoff requires Node.js ${minimumNodeVersion} or newer; found ${observedVersion}. Upgrade Node.js before retrying.`;
}
