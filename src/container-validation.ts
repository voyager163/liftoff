import type { GeneratedArtifact } from './types.js';

const containerArtifactNames = new Set([
  'backend-dockerfile',
  'docker-compose',
  'frontend-dockerfile'
]);
const immutableReferencePattern = /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/;

export function assertImmutableGeneratedContainerReferences(
  artifacts: readonly GeneratedArtifact[]
): void {
  for (const artifact of artifacts) {
    if (!containerArtifactNames.has(artifact.logicalName)) {
      continue;
    }
    const references = [
      ...artifact.content.matchAll(/^\s*FROM\s+(\S+)/gm),
      ...artifact.content.matchAll(/^\s*image:\s*(\S+)/gm)
    ].map((match) => match[1]);
    if (references.length === 0) {
      throw new Error(
        `Generated container artifact ${artifact.logicalName} contains no image reference.`
      );
    }
    for (const reference of references) {
      if (!immutableReferencePattern.test(reference)) {
        throw new Error(
          `Generated container artifact ${artifact.logicalName} contains mutable image reference ${reference}.`
        );
      }
    }
  }
}
