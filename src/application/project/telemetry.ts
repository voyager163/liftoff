import { createManifestV8Reader } from '../../domain/project/manifest/v8.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { parseProjectTelemetryPolicy, type ProjectTelemetryPolicy } from '../../telemetry/contract.js';
import { projectCatalog } from './catalog.js';
import { resolveModernManifestV8SourceContract } from './manifest.js';
import { modernSourceRegistry } from './modern-plugins.js';

export type ProjectTelemetryDimensions = Readonly<ProjectTelemetryPolicy & {
  templateSetDigest: string;
}>;

const reader = createManifestV8Reader({
  catalog: projectCatalog,
  resolveSourceContract: resolveModernManifestV8SourceContract
});

/** Validates source metadata only; root identity, consent and reporting eligibility remain separate. */
export function projectTelemetryDimensions(value: unknown): ProjectTelemetryDimensions {
  const manifest = reader.parseManifestV8(value);
  const governance = manifest.governance;
  const policy = parseProjectTelemetryPolicy(
    governance.profile, governance.profile === 'none' ? 'none' : Number(governance.policyVersion)
  );
  if (!policy) {
    throw new FileSystemError('The validated source policy is not supported by the project telemetry contract.');
  }
  return Object.freeze({
    ...policy,
    // The selection digest encodes project choices; the registry digest identifies the whole release.
    templateSetDigest: modernSourceRegistry().registryDigest
  });
}
