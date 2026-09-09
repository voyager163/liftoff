import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { isRetiredManagedCoreLogicalName, managedCoreLogicalNames } from '../../domain/project/artifact-lifecycle.js';
import { assessmentLogicalNames, preAssessmentManagedCoreLogicalNames } from '../../domain/project/manifest/governance.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../../adapters/filesystem/project-paths.js';
import { errorCode, errorMessage } from '../../adapters/filesystem/errors.js';
import { validateFrameworkInstallation } from '../../framework-validation.js';
import { validateGovernanceCompatibilityMetadata, type ManagedCompatibilityInventoryEntry } from '../../governance-activation/compatibility.js';
import { loadManifest } from '../project/manifest.js';

export async function validateGeneratedProject(projectRoot: string): Promise<string[]> {
  let manifest: LiftoffManifest;
  try {
    manifest = await loadManifest(projectRoot);
  } catch (error) {
    return [(error as Error).message];
  }

  const issues: string[] = [];
  for (const artifact of manifest.managedArtifacts) {
    if (isRetiredManagedCoreLogicalName(artifact.logicalName)) {
      try {
        await resolveProjectPath(projectRoot, artifact.pathParts);
      } catch (error) {
        issues.push(
          `Unsafe retired managed-core path for ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`
        );
      }
      continue;
    }
    try {
      const targetPath = await resolveProjectPath(projectRoot, artifact.pathParts);
      const bytes = await readFile(targetPath);
      const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actualHash !== artifact.contentHash) {
        issues.push(
          `Artifact hash mismatch for ${artifact.logicalName} at ${artifact.pathParts.join('/')}`
        );
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        issues.push(`Missing artifact ${artifact.logicalName} at ${artifact.pathParts.join('/')}`);
      } else {
        issues.push(`Unable to access artifact ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`);
      }
    }
  }
  const compatibilityArtifact = manifest.managedArtifacts.find((artifact) =>
    artifact.logicalName === 'repository-governance-compatibility'
  );
  if (
    compatibilityArtifact &&
    manifest.governance.profile !== 'none' &&
    manifest.governance.profile !== 'unspecified'
  ) {
    try {
      const bytes = await readProjectFile(projectRoot, compatibilityArtifact.pathParts);
      if (bytes === undefined) {
        issues.push(
          `Missing artifact ${compatibilityArtifact.logicalName} at ${compatibilityArtifact.pathParts.join('/')}`
        );
      } else {
        const hasRetiredManagedArtifacts = manifest.managedArtifacts.some((artifact) =>
          isRetiredManagedCoreLogicalName(artifact.logicalName)
        );
        const currentManagedArtifacts = manifest.managedArtifacts.filter((artifact) =>
          !isRetiredManagedCoreLogicalName(artifact.logicalName)
        );
        const expectedInventory: ManagedCompatibilityInventoryEntry[] =
          currentManagedArtifacts.map((artifact) => ({
            logicalName: artifact.logicalName,
            pathParts: artifact.pathParts,
            lifecycle: 'managed-core',
            contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
          }));
        const compatibility = validateGovernanceCompatibilityMetadata(
          JSON.parse(bytes.toString('utf8')) as unknown
        );
        const predatesAssessment = !currentManagedArtifacts.some((artifact) =>
          assessmentLogicalNames.some((logicalName) => artifact.logicalName === logicalName)
        ) && compatibility.managedCore.logicalNameAllowlist.join('\0') ===
          preAssessmentManagedCoreLogicalNames.join('\0');
        const logicalNameAllowlist = predatesAssessment
          ? preAssessmentManagedCoreLogicalNames
          : managedCoreLogicalNames;
        validateGovernanceCompatibilityMetadata(
          compatibility,
          hasRetiredManagedArtifacts
            ? undefined
            : manifest.governance.state === 'handoff-generated'
            ? {
                logicalNameAllowlist,
                pathAllowlist: currentManagedArtifacts.map((artifact) => artifact.pathParts),
                inventory: expectedInventory
              }
            : {
                logicalNameAllowlist
              }
        );
      }
    } catch (error) {
      issues.push(`Invalid repository-governance-compatibility at ${compatibilityArtifact.pathParts.join('/')}: ${errorMessage(error)}`);
    }
  }
  for (const artifact of manifest.projectArtifacts) {
    try {
      await resolveProjectPath(projectRoot, artifact.pathParts);
    } catch (error) {
      issues.push(
        `Unsafe project provenance path for ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`
      );
    }
  }

  if (manifest.framework.state === 'initialized') {
    issues.push(...await validateFrameworkInstallation(projectRoot, {
      workflow: manifest.framework.adapter,
      agents: manifest.project.agents,
      ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
    }));
  }
  return issues;
}
