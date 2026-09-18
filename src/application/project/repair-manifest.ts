import { createHash } from 'node:crypto';
import type { LiftoffManifest, LiftoffManifestV8, ManifestGeneratedProjectArtifact } from '../../domain/project/contracts.js';
import { assessInfrastructureLayout, retiredFlatRootInfrastructureIdentities } from '../../domain/project/infrastructure-layout.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { repairRecipes } from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import { parseManifest } from './manifest.js';
import { compareSemver } from '../../semver.js';

export const manifestRepairLinkPath = (recordId: string): string[] => ['.liftoff', 'manifest-repairs', `${recordId}.json`];

export function buildRepairedManifestV8(
  source: LiftoffManifest, original: Buffer, artifacts: readonly ManifestGeneratedProjectArtifact[]
): string {
  if (source.artifactVersion !== 8) {
    throw new Error('Run liftoff update --check and approve the manifest-8 metadata upgrade before a new infrastructure repair. Historical journal recovery does not perform this upgrade.');
  }
  if (compareSemver(source.liftoffVersion, liftoffVersion) > 0) throw new Error('A newer manifest writer requires a compatible CLI before any repair metadata rewrite.');
  if (canonicalSha256(parseManifest(parseStrictManifestJson(original.toString('utf8')))) !== canonicalSha256(source)) {
    throw new Error('Original manifest bytes changed during repair inspection.');
  }
  const sourceManifestHash = `sha256:${createHash('sha256').update(original).digest('hex')}`;
  const recipe = repairRecipes['azure-local-layout'];
  const recordId = canonicalSha256({
    kind: 'liftoff-manifest-repair', sourceManifestHash, recipe, cliVersion: liftoffVersion, artifacts
  });
  const replaced = new Set(artifacts.map((artifact) => artifact.logicalName));
  const retired = new Set(retiredFlatRootInfrastructureIdentities.map((identity) => `${identity.logicalName}\0${identity.pathParts.join('/')}`));
  const next: LiftoffManifestV8 = {
    ...structuredClone(source), liftoffVersion,
    provenance: {
      ...structuredClone(source.provenance),
      repairs: [...source.provenance.repairs, { recordId, recipe: recipe.id, recipeVersion: recipe.version, sourceManifestHash }]
    },
    projectArtifacts: [
      ...source.projectArtifacts.filter((artifact) => !replaced.has(artifact.logicalName) && !retired.has(`${artifact.logicalName}\0${artifact.pathParts.join('/')}`)),
      ...structuredClone(artifacts)
    ]
  };
  parseManifest(next);
  if (assessInfrastructureLayout(next).kind !== 'independent') throw new Error('Repair candidate does not establish the complete registered independent infrastructure inventory.');
  return `${JSON.stringify(next, null, 2)}\n`;
}
