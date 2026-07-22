import { createHash } from 'node:crypto';
import { readProjectFile } from './file-system.js';
import type { GeneratedArtifact, LiftoffManifest } from './types.js';

export type ReconcileStatus = 'unchanged' | 'new' | 'missing' | 'upgrade' | 'conflict' | 'moved' | 'orphan';

export interface ReconcileEntry {
  logicalName: string;
  status: ReconcileStatus;
  pathParts: string[];
  previousPathParts?: string[];
  reason: string;
  rendered?: GeneratedArtifact;
  cleanMove?: boolean;
  refreshHash?: boolean;
  destinationMatches?: boolean;
}

const hashBytes = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

async function readDisk(projectRoot: string, pathParts: string[]): Promise<Buffer | undefined> {
  return readProjectFile(projectRoot, pathParts);
}

export async function reconcileProject(
  manifest: LiftoffManifest,
  render: GeneratedArtifact[],
  projectRoot: string
): Promise<ReconcileEntry[]> {
  const recordedByName = new Map(manifest.artifacts.map((artifact) => [artifact.logicalName, artifact]));
  const entries: ReconcileEntry[] = [];

  for (const artifact of render) {
    const recorded = recordedByName.get(artifact.logicalName);
    recordedByName.delete(artifact.logicalName);
    // the manifest is rewritten wholesale on apply; liftoff.config.json is user-owned
    // desired state; seed content is gifted once and follows its own lifecycle -
    // none of them are reconciled
    if (artifact.logicalName === 'manifest' || artifact.logicalName === 'liftoff-config' || artifact.category === 'seed') {
      continue;
    }
    const renderHash = hashBytes(artifact.content);

    if (!recorded) {
      const destination = await readDisk(projectRoot, artifact.pathParts);
      if (destination !== undefined && destination.toString('utf8') === artifact.content) {
        entries.push({
          logicalName: artifact.logicalName,
          status: 'unchanged',
          pathParts: artifact.pathParts,
          reason: 'unrecorded destination already matches the current template; recorded state catches up',
          rendered: artifact,
          refreshHash: true,
          destinationMatches: true
        });
        continue;
      }
      if (destination !== undefined) {
        entries.push({
          logicalName: artifact.logicalName,
          status: 'conflict',
          pathParts: artifact.pathParts,
          reason: 'destination exists but is not owned by the recorded state',
          rendered: artifact
        });
        continue;
      }
      entries.push({
        logicalName: artifact.logicalName,
        status: 'new',
        pathParts: artifact.pathParts,
        reason: 'not present in the recorded state',
        rendered: artifact
      });
      continue;
    }

    const samePath = recorded.pathParts.join('\0') === artifact.pathParts.join('\0');
    if (!samePath) {
      const priorDisk = await readDisk(projectRoot, recorded.pathParts);
      const newDisk = await readDisk(projectRoot, artifact.pathParts);
      if (priorDisk === undefined) {
        if (newDisk !== undefined && newDisk.toString('utf8') === artifact.content) {
          entries.push({
            logicalName: artifact.logicalName,
            status: 'unchanged',
            pathParts: artifact.pathParts,
            previousPathParts: recorded.pathParts,
            reason: 'already at the new location; recorded state catches up',
            rendered: artifact,
            refreshHash: true,
            destinationMatches: true
          });
        } else if (newDisk !== undefined) {
          entries.push({
            logicalName: artifact.logicalName,
            status: 'conflict',
            pathParts: artifact.pathParts,
            previousPathParts: recorded.pathParts,
            reason: 'recorded source is absent and the new destination contains different bytes',
            rendered: artifact
          });
        } else {
          entries.push({
            logicalName: artifact.logicalName,
            status: 'missing',
            pathParts: artifact.pathParts,
            previousPathParts: recorded.pathParts,
            reason: 'absent at both old and new locations; restoring the template version',
            rendered: artifact
          });
        }
        continue;
      }

      const cleanMove = hashBytes(priorDisk) === recorded.contentHash;
      const destinationMatches = newDisk !== undefined && newDisk.toString('utf8') === artifact.content;
      if (newDisk !== undefined && !destinationMatches) {
        entries.push({
          logicalName: artifact.logicalName,
          status: 'moved',
          pathParts: artifact.pathParts,
          previousPathParts: recorded.pathParts,
          cleanMove: false,
          reason: cleanMove
            ? 'relocated by the current templates but the destination contains user-owned bytes'
            : 'relocated by the current templates, modified locally, and the destination contains different bytes',
          rendered: artifact
        });
        continue;
      }
      entries.push({
        logicalName: artifact.logicalName,
        status: 'moved',
        pathParts: artifact.pathParts,
        previousPathParts: recorded.pathParts,
        cleanMove,
        reason: cleanMove
          ? destinationMatches
            ? 'relocated by the current templates; destination already matches'
            : 'relocated by the current templates'
          : 'relocated by the current templates but modified locally',
        rendered: artifact,
        destinationMatches
      });
      continue;
    }

    const disk = await readDisk(projectRoot, artifact.pathParts);
    if (disk === undefined) {
      entries.push({
        logicalName: artifact.logicalName,
        status: 'missing',
        pathParts: artifact.pathParts,
        reason: 'file deleted locally; restoring the template version',
        rendered: artifact
      });
      continue;
    }

    if (disk.toString('utf8') === artifact.content) {
      entries.push({
        logicalName: artifact.logicalName,
        status: 'unchanged',
        pathParts: artifact.pathParts,
        reason: 'matches the current template',
        rendered: artifact,
        refreshHash: hashBytes(disk) !== recorded.contentHash
      });
      continue;
    }

    if (hashBytes(disk) === recorded.contentHash) {
      entries.push({
        logicalName: artifact.logicalName,
        status: 'upgrade',
        pathParts: artifact.pathParts,
        reason: 'untouched since generation; template changed',
        rendered: artifact
      });
      continue;
    }

    entries.push({
      logicalName: artifact.logicalName,
      status: 'conflict',
      pathParts: artifact.pathParts,
      reason: 'modified locally and the template also changed',
      rendered: artifact
    });
  }

  for (const recorded of recordedByName.values()) {
    const disk = await readDisk(projectRoot, recorded.pathParts);
    if (disk === undefined) {
      continue; // already removed by the user; nothing to report or retain
    }
    entries.push({
      logicalName: recorded.logicalName,
      status: 'orphan',
      pathParts: recorded.pathParts,
      reason: 'no longer generated for this configuration; delete manually if unwanted'
    });
  }

  return entries;
}

export function hasDrift(entries: ReconcileEntry[]): boolean {
  return entries.some((entry) => entry.status !== 'unchanged' || entry.refreshHash === true);
}
