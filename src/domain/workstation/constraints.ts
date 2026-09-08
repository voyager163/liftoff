export interface VersionConstraint {
  exactVersion?: string;
  minimumVersion?: string;
  releaseLine?: string;
}

export function formatRequirementVersion(requirement: VersionConstraint): string {
  if (requirement.exactVersion) return `exactly ${requirement.exactVersion}`;
  if (!requirement.minimumVersion) return 'available';
  return `${requirement.minimumVersion}+${requirement.releaseLine ? ` (${requirement.releaseLine}.x)` : ''}`;
}
