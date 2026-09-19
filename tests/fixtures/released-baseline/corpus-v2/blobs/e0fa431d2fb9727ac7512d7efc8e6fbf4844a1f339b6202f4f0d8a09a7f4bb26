import type { ManifestManagedArtifact, ManifestProjectArtifact, ProjectProvisioningGroup } from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { validateArtifactPathParts } from '../paths.js';
import { isManagedCoreLogicalName, isRetiredManagedCoreArtifactIdentity, isRetiredManagedCoreLogicalName,
  isUnknownRetiredManagedCoreAliasLogicalName } from '../artifact-lifecycle.js';
import type { ManifestContractContext } from './context.js';
import { assertOnlyFields, isRecord, requiredString, SEMVER_PATTERN } from './fields.js';

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function createManifestArtifactReader(catalog: ManifestContractContext['catalog']) {
  const { getEnvironment } = catalog;

  function normalizeManifestManagedArtifacts(
    value: unknown,
    scopeRoot: string
  ): ManifestManagedArtifact[] {
    if (!Array.isArray(value)) {
      throw new FileSystemError(`${scopeRoot} must be an array.`);
    }

    const logicalNames = new Set<string>();
    const paths = new Set<string>();
    return value.map((entry, index) => {
      const scope = `${scopeRoot}[${index}]`;
      if (!isRecord(entry)) {
        throw new FileSystemError(`${scope} must be a JSON object.`);
      }
      assertOnlyFields(
        entry,
        ['logicalName', 'category', 'pathParts', 'contentHash'],
        scope
      );
      const logicalName = requiredString(entry, 'logicalName', scope);
      const category = requiredString(entry, 'category', scope);
      const pathParts = validateArtifactPathParts(entry.pathParts, `${scope}.pathParts`);
      const contentHash = requiredString(entry, 'contentHash', scope);
      if (!CONTENT_HASH_PATTERN.test(contentHash)) {
        throw new FileSystemError(`${scope}.contentHash must be a sha256-prefixed lowercase hexadecimal digest.`);
      }
      if (logicalNames.has(logicalName)) {
        throw new FileSystemError(`Manifest contains duplicate logicalName ${JSON.stringify(logicalName)}.`);
      }
      logicalNames.add(logicalName);
      const pathKey = pathParts.join('\0');
      if (paths.has(pathKey)) {
        throw new FileSystemError(`Manifest contains duplicate artifact path ${pathParts.join('/')}.`);
      }
      paths.add(pathKey);
      return { logicalName, category, pathParts, contentHash };
    });
  }

  function normalizeManifestProjectArtifacts(value: unknown): ManifestProjectArtifact[] {
    if (!Array.isArray(value)) {
      throw new FileSystemError('Manifest.projectArtifacts must be an array.');
    }

    const logicalNames = new Set<string>();
    const paths = new Set<string>();
    return value.map((entry, index) => {
      const scope = `Manifest.projectArtifacts[${index}]`;
      if (!isRecord(entry)) {
        throw new FileSystemError(`${scope} must be a JSON object.`);
      }
      assertOnlyFields(
        entry,
        [
          'logicalName',
          'category',
          'pathParts',
          'generatedBy',
          'generationHash',
          'provisioningGroup'
        ],
        scope
      );
      const logicalName = requiredString(entry, 'logicalName', scope);
      const category = requiredString(entry, 'category', scope);
      const pathParts = validateArtifactPathParts(entry.pathParts, `${scope}.pathParts`);
      const generatedBy = requiredString(entry, 'generatedBy', scope);
      if (!SEMVER_PATTERN.test(generatedBy)) {
        throw new FileSystemError(`${scope}.generatedBy must be a valid semantic version.`);
      }
      const generationHash = requiredString(entry, 'generationHash', scope);
      if (!CONTENT_HASH_PATTERN.test(generationHash)) {
        throw new FileSystemError(
          `${scope}.generationHash must be a sha256-prefixed lowercase hexadecimal digest.`
        );
      }
      const provisioningGroup = normalizeProjectProvisioningGroup(
        requiredString(entry, 'provisioningGroup', scope),
        scope
      );
      if (logicalNames.has(logicalName)) {
        throw new FileSystemError(`Manifest contains duplicate logicalName ${JSON.stringify(logicalName)}.`);
      }
      logicalNames.add(logicalName);
      const pathKey = pathParts.join('\0');
      if (paths.has(pathKey)) {
        throw new FileSystemError(`Manifest contains duplicate artifact path ${pathParts.join('/')}.`);
      }
      paths.add(pathKey);
      return {
        logicalName,
        category,
        pathParts,
        generatedBy,
        generationHash,
        provisioningGroup
      };
    });
  }

  function normalizeProjectProvisioningGroup(
    value: string,
    scope: string
  ): ProjectProvisioningGroup {
    if (
      value === 'base' ||
      value === 'frontend'
    ) {
      return value;
    }
    const prefix = 'environment:';
    if (value.startsWith(prefix)) {
      const environmentValue = value.slice(prefix.length);
      const environment = getEnvironment(environmentValue);
      if (environment?.id === environmentValue) {
        return `environment:${environment.id}`;
      }
    }
    throw new FileSystemError(`${scope}.provisioningGroup is invalid.`);
  }

  function validateV6AndV7ArtifactAuthority(
    managedArtifacts: readonly ManifestManagedArtifact[],
    projectArtifacts: readonly ManifestProjectArtifact[]
  ): void {
    for (const artifact of managedArtifacts) {
      if (isManagedCoreLogicalName(artifact.logicalName)) {
        continue;
      }
      if (isRetiredManagedCoreLogicalName(artifact.logicalName)) {
        if (
          !isRetiredManagedCoreArtifactIdentity(
            artifact.logicalName,
            artifact.category,
            artifact.pathParts
          )
        ) {
          throw new FileSystemError(
            `Retired managed-core artifact ${artifact.logicalName} has invalid identity.`
          );
        }
        continue;
      }
      if (isUnknownRetiredManagedCoreAliasLogicalName(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest managed artifact ${artifact.logicalName} is an unknown retired managed-core alias logical name.`
        );
      }
      throw new FileSystemError(
        `Manifest managed artifact ${artifact.logicalName} is not an explicit managed-core logical name.`
      );
    }
    for (const artifact of projectArtifacts) {
      if (isManagedCoreLogicalName(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest project artifact ${artifact.logicalName} cannot contain a managed-core logical name.`
        );
      }
      if (isRetiredManagedCoreLogicalName(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest project artifact ${artifact.logicalName} cannot contain a retired managed-core logical name.`
        );
      }
      if (isUnknownRetiredManagedCoreAliasLogicalName(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest project artifact ${artifact.logicalName} cannot contain an unknown retired managed-core alias logical name.`
        );
      }
    }
  }

  function validateManifestArtifactUniqueness(
    managedArtifacts: readonly ManifestManagedArtifact[],
    projectArtifacts: readonly ManifestProjectArtifact[]
  ): void {
    const logicalNames = new Set<string>();
    const paths = new Set<string>();
    for (const artifact of [...managedArtifacts, ...projectArtifacts]) {
      if (logicalNames.has(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest contains duplicate logicalName ${JSON.stringify(artifact.logicalName)}.`
        );
      }
      logicalNames.add(artifact.logicalName);
      const pathKey = artifact.pathParts.join('\0');
      if (paths.has(pathKey)) {
        throw new FileSystemError(
          `Manifest contains duplicate artifact path ${artifact.pathParts.join('/')}.`
        );
      }
      paths.add(pathKey);
    }
  }

  return { normalizeManifestManagedArtifacts, normalizeManifestProjectArtifacts,
    validateV6AndV7ArtifactAuthority, validateManifestArtifactUniqueness };
}
