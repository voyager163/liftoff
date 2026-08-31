import { compareSemver } from './semver.js';
import { supportedStack } from './supported-stack.js';

export const minimumNodeVersion = supportedStack.runtimes.node.minimumVersion ??
  supportedStack.runtimes.node.version;

export function nodeRuntimeError(observedVersion = process.versions.node): string | undefined {
  if (compareSemver(observedVersion, minimumNodeVersion) >= 0) {
    return undefined;
  }
  return `Liftoff requires Node.js ${minimumNodeVersion} or newer; found ${observedVersion}. Upgrade Node.js before retrying.`;
}
