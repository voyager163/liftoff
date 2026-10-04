import { extractVersion } from '../../domain/workstation/versions.js';
import { formatRequirementVersion } from '../../domain/workstation/constraints.js';
import { minimumNodeVersion, nodeRuntimeError } from '../../runtime.js';

export function observeRunningRuntime(version = process.versions.node) {
  const required = { minimumVersion: minimumNodeVersion };
  const parsed = extractVersion(version, 'node');
  const ready = parsed !== undefined && nodeRuntimeError(parsed) === undefined;
  return {
    ready,
    observedVersion: version,
    required,
    detail: `Running Liftoff runtime: Node.js ${version}; requires ${formatRequirementVersion(required)}. ` +
      'This is not evidence that external node or npm is installed.',
    ...(ready ? {} : {
      remedy: 'Reinstall Liftoff through its installation channel, or use a supported runtime for an npm installation.'
    })
  };
}
