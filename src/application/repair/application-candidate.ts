import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { ApplicationInspectionError, applicationPathKey } from './application-files.js';
import {
  applicationBounds, type ApplicationDirectoryObservation, type ApplicationPatchCandidate
} from './application-types.js';

export function applicationCandidateFiles(candidate: ApplicationPatchCandidate): ProjectFileSnapshot[] {
  const files = new Map(candidate.snapshots.map((snapshot) => [applicationPathKey(snapshot.pathParts), snapshot]));
  for (const mutation of candidate.mutations) {
    files.set(applicationPathKey(mutation.pathParts), mutation.type === 'delete'
      ? { pathParts: mutation.pathParts } : {
        pathParts: mutation.pathParts,
        content: typeof mutation.content === 'string' ? Buffer.from(mutation.content, 'utf8') : mutation.content,
        mode: mutation.mode
      });
  }
  return [...files.values()];
}

export function applicationCandidateDirectories(candidate: ApplicationPatchCandidate): ApplicationDirectoryObservation[] {
  const directories = new Map(candidate.scope.directoryInventory.filter((item) => item.exists)
    .map((item) => [applicationPathKey(item.pathParts), structuredClone(item)]));
  for (const mutation of candidate.mutations) {
    if (mutation.type === 'write') {
      for (let index = 1; index < mutation.pathParts.length; index++) {
        const parts = mutation.pathParts.slice(0, index), key = applicationPathKey(parts);
        if (!directories.has(key)) {
          directories.set(key, { pathParts: parts, exists: true, mode: null, entries: [] });
          const parent = directories.get(applicationPathKey(parts.slice(0, -1)))!;
          if (!parent.entries.some((entry) => entry.name === parts.at(-1))) {
            parent.entries.push({ name: parts.at(-1)!, kind: 'directory' });
          }
        }
      }
    }
    const parent = directories.get(applicationPathKey(mutation.pathParts.slice(0, -1)));
    if (!parent) throw new ApplicationInspectionError('Application candidate has an unobserved mutation parent.');
    parent.entries = parent.entries.filter((entry) => entry.name !== mutation.pathParts.at(-1));
    if (mutation.type === 'write') parent.entries.push({ name: mutation.pathParts.at(-1)!, kind: 'file' });
  }
  return [...directories.values()];
}

export function assertApplicationCandidateBounds(candidate: ApplicationPatchCandidate): void {
  const files = applicationCandidateFiles(candidate).filter((item) => item.content !== undefined);
  const directories = applicationCandidateDirectories(candidate);
  if (files.length > applicationBounds.files ||
      files.reduce((total, item) => total + item.content!.byteLength, 0) > applicationBounds.totalBytes ||
      directories.length > applicationBounds.directories ||
      directories.some((item) => item.entries.length > applicationBounds.directoryEntries)) {
    throw new ApplicationInspectionError('The resulting application would exceed the bounded inventory; the complete candidate cannot be approved.');
  }
}
