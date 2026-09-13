import { projectCatalog } from './catalog.js';
import { readManifestFile } from '../../adapters/filesystem/manifest-file.js';
import { createManifestReader } from '../../domain/project/manifest/reader.js';
import { governanceArtifactPaths, governancePolicyVersion } from '../../repository-governance.js';
import { minimumLiftoffForManifestV7 } from '../../governance-activation/compatibility.js';
import { validateReadableActivationIdentity } from '../../domain/governance/activation/validators.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';

const manifestReader = createManifestReader({
  catalog: projectCatalog,
  policyVersion: governancePolicyVersion,
  minimumLiftoffVersion: minimumLiftoffForManifestV7,
  validateActivationIdentity: validateReadableActivationIdentity,
  governanceArtifactPaths: new Map<string, readonly string[]>([
    ['repository-governance-policy', governanceArtifactPaths.policy],
    ['repository-governance-context', governanceArtifactPaths.context],
    ['repository-governance-guide', governanceArtifactPaths.guide],
    ['repository-governance-phase-graph', governanceArtifactPaths.phaseGraph],
    ['repository-governance-compatibility', governanceArtifactPaths.compatibility],
    ['repository-governance-credential-policy-schema', governanceArtifactPaths.credentialPolicySchema],
    ...Object.values(governanceAgentIntegrations).flatMap((integration): Array<[string, readonly string[]]> => [
      [integration.setup.logicalName, integration.setup.pathParts],
      [integration.assessment.logicalName, integration.assessment.pathParts]
    ])
  ])
});

export const { parseManifest, normalizeManifestProject, normalizeManifestFramework } = manifestReader;

export async function loadManifest(projectRoot: string) {
  return parseManifest(await readManifestFile(projectRoot));
}
