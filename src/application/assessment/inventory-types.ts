import type { ProjectInventoryExclusion, ProjectInventoryRole } from '../../domain/assessment/inventory.js';
import type { ApplicationEntryKind } from '../repair/application-types.js';

export const projectInventoryBounds = {
  files: 512, directories: 256, directoryEntries: 256, entries: 4096,
  depth: 12, pathBytes: 1024, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024,
  dependencyNames: 2048
} as const;

export interface ProjectInventoryEntry {
  pathParts: string[];
  kind: 'file' | 'directory';
  roles: ProjectInventoryRole[];
}

export interface ProjectDependencyObservation {
  pathParts: string[];
  dialect: 'node' | 'python' | 'go';
  availability: 'observed' | 'uninterpretable' | 'not-observed';
  names: string[];
  digest: string | null;
  bytes: number | null;
  mode: number | null;
  diagnostic: string | null;
}

export interface ProjectInventory {
  schemaVersion: 1;
  kind: 'liftoff-project-inventory';
  readOnly: true;
  projectRoot: string;
  rootMarkers: {
    git: 'directory-marker' | 'file-marker' | 'absent' | 'not-observed';
    liftoff: 'file-marker' | 'absent' | 'not-observed';
  };
  complete: boolean;
  inspectionDigest: string;
  entries: ProjectInventoryEntry[];
  directories: { pathParts: string[]; entries: number; mode: number }[];
  dependencies: ProjectDependencyObservation[];
  exclusions: { pathParts: string[]; kind: ApplicationEntryKind; reason: ProjectInventoryExclusion }[];
  coverage: {
    metadata: 'bounded-selected-root';
    dependencyContents: 'bounded-static-name-extraction';
    applicationContents: 'not-observed';
    references: 'not-observed';
    limits: { pathParts: string[]; bound: keyof typeof projectInventoryBounds }[];
  };
  limitations: string[];
  bounds: typeof projectInventoryBounds;
}
