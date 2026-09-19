import { projectCatalog } from './catalog.js';
import { readManifestFile } from '../../adapters/filesystem/manifest-file.js';
import { createManifestReader } from '../../domain/project/manifest/reader.js';
import { governancePolicyVersion } from '../../repository-governance.js';
import { minimumLiftoffForManifestV7 } from '../../governance-activation/compatibility.js';
import { validateReadableActivationIdentity } from '../../domain/governance/activation/validators.js';
import { managedCoreArtifactPaths } from '../../domain/project/artifact-lifecycle.js';

const manifestReader = createManifestReader({
  catalog: projectCatalog,
  policyVersion: governancePolicyVersion,
  minimumLiftoffVersion: minimumLiftoffForManifestV7,
  validateActivationIdentity: validateReadableActivationIdentity,
  governanceArtifactPaths: managedCoreArtifactPaths
});

export const { parseManifest, normalizeManifestProject, normalizeManifestFramework } = manifestReader;

export async function loadManifest(projectRoot: string) {
  return parseManifest(await readManifestFile(projectRoot));
}
