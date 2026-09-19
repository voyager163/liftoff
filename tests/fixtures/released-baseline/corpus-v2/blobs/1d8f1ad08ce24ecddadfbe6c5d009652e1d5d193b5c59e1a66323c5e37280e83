import type { AddArtifact } from '../../template-types.js';
import type { ArtifactLifecycle } from '../../domain/project/contracts.js';
import type { GeneratedArtifact } from '../../domain/project/contracts.js';
import type { ProjectProvisioningGroup } from '../../domain/project/contracts.js';

export function createArtifactAdder(
  artifacts: GeneratedArtifact[],
  lifecycle: ArtifactLifecycle,
  provisioningGroup?: ProjectProvisioningGroup
): AddArtifact {
  return (logicalName, category, pathParts, content) => {
    const normalizedContent = ensureTrailingNewline(content);
    if (lifecycle === 'project') {
      if (!provisioningGroup) {
        throw new Error(`Project artifact ${logicalName} is missing a provisioning group.`);
      }
      artifacts.push({
        logicalName,
        category,
        lifecycle,
        provisioningGroup,
        pathParts,
        content: normalizedContent
      });
      return;
    }
    artifacts.push({
      logicalName,
      category,
      lifecycle,
      pathParts,
      content: normalizedContent
    });
  };
}

export function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
