import { createHash } from 'node:crypto';
import { captureProjectFileSnapshot, type ProjectFileMutation } from '../../adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  activationBaselineDigest,
  activationInputPathIsObserved,
  activationInputTextDigest,
  readActivationInputSnapshot,
  type ActivationInputSnapshot
} from '../../governance-activation/inputs.js';
import { inspectGovernanceTransition } from '../../governance-activation/commands.js';
import type { CommandRunner } from '../../process-runner.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import type { RunCommandOptions } from '../../process-runner.js';
import { reviewedUpdateTargetMode } from '../../adapters/filesystem/reviewed-update-transaction.js';
import { activationHistoryIndexPathParts } from '../../governance-activation/history-contracts.js';
import {
  acceptDeclaredCommandOutputs, captureRetainedProjectInputs, changedRetainedProjectInputs,
  isRetainedProjectInput, outputsForLocalCommand, type RetainedProjectInput
} from './protected-source.js';
import { UpdatePlanError, type UpdateInspection } from './inspection.js';
import { previewLocalRevalidation, type LocalRevalidationPreview } from './revalidation.js';
import type { UpdateWritePlan } from './write-plan.js';

export interface PreparedUpdateRevalidation {
  preview: LocalRevalidationPreview;
  expectedInputSnapshot: ActivationInputSnapshot;
  expectedRetainedSource: RetainedProjectInput[];
}

interface ExpectedProtectedFile {
  pathParts: string[];
  digest: string | null;
  mode?: number;
}

function rawDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function expectedInputSnapshot(
  source: ActivationInputSnapshot,
  plan: UpdateWritePlan
): ActivationInputSnapshot {
  const files = new Map(source.files.map((file) => [file.path, file.digest]));
  for (const mutation of plan.mutations) {
    if (!activationInputPathIsObserved(mutation.pathParts)) continue;
    const name = mutation.pathParts.join('/');
    if (mutation.type === 'delete') files.delete(name);
    else files.set(name, activationInputTextDigest(
      typeof mutation.content === 'string' ? mutation.content : mutation.content.toString('utf8')
    ));
  }
  const project = {
    project: plan.nextManifest.project,
    framework: plan.nextManifest.framework,
    governance: plan.nextManifest.governance.profile
  };
  const inventory = [...files].sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([filePath, digest]) => ({ path: filePath, digest }));
  return {
    ...source,
    project,
    files: inventory,
    baselineSha: activationBaselineDigest(project, inventory)
  };
}

export async function prepareUpdateRevalidation(
  inspection: UpdateInspection,
  writePlan: UpdateWritePlan,
  options: { runner?: CommandRunner; now?: Date } = {}
): Promise<PreparedUpdateRevalidation | undefined> {
  if (!inspection.revalidationSource) return undefined;
  const expected = expectedInputSnapshot(inspection.revalidationSource, writePlan);
  const retained = new Map((inspection.retainedSource ?? []).map((entry) => [entry.pathParts.join('/'), entry]));
  for (const mutation of writePlan.mutations) {
    if (!isRetainedProjectInput(mutation.pathParts)) continue;
    const key = mutation.pathParts.join('/');
    if (mutation.type === 'delete') retained.delete(key);
    else retained.set(key, {
      pathParts: [...mutation.pathParts], digest: rawDigest(mutation.content),
      mode: reviewedUpdateTargetMode(mutation.mode, retained.get(key)?.mode)
    });
  }
  if (inspection.historyMigration.status === 'eligible') {
    const history = inspection.historyMigration;
    for (const file of history.index.files) {
      retained.set(file.copyPathParts.join('/'), {
        pathParts: [...file.copyPathParts], digest: file.digest,
        mode: reviewedUpdateTargetMode(history.semanticPlan.targetModes.historyCopy)
      });
    }
    const indexPath = activationHistoryIndexPathParts(history.index.snapshotId);
    retained.set(indexPath.join('/'), {
      pathParts: indexPath, digest: history.indexDigest,
      mode: reviewedUpdateTargetMode(history.semanticPlan.targetModes.historyIndex)
    });
    for (const retirement of history.requiredRetirements) retained.delete(retirement.pathParts.join('/'));
  }
  const expectedRetainedSource = [...retained.values()].sort((a, b) =>
    a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en'));
  const currentInspection = inspection.historyMigration.status === 'current' &&
    inspection.historyMigration.history.status === 'committed' &&
    writePlan.mutations.length === 0 && writePlan.skipped.length === 0
    ? await inspectGovernanceTransition(inspection.projectRoot, options)
    : undefined;
  const preview = await previewLocalRevalidation({
    projectRoot: inspection.projectRoot,
    targetManifest: writePlan.nextManifest,
    protectedInputBinding: canonicalSha256({ activation: expected, retained: expectedRetainedSource }),
    inspection: currentInspection
  });
  return { preview, expectedInputSnapshot: expected, expectedRetainedSource };
}

function isMutablePhaseRecord(parts: readonly string[]): boolean {
  return parts[0] === 'governance' && (
    parts.length === 2 && (parts[1] === 'activation-state.json' || parts[1] === 'migration-state.json') ||
    parts[1] === 'plans' || parts[1] === 'evidence'
  );
}

export function postUpdateProtectedInputs(
  inspection: UpdateInspection,
  writePlan: UpdateWritePlan,
  prepared: PreparedUpdateRevalidation,
  mutations: readonly ProjectFileMutation[],
  runner?: CommandRunner
): {
  binding: string;
  assertUnchanged: () => Promise<void>;
  afterCommand: (command: ExternalCommand, options?: RunCommandOptions) => Promise<void>;
} {
  let retained = prepared.expectedRetainedSource;
  const expected = new Map<string, ExpectedProtectedFile>();
  for (const snapshot of inspection.snapshots) {
    if (isMutablePhaseRecord(snapshot.pathParts)) continue;
    expected.set(snapshot.pathParts.join('\0'), {
      pathParts: [...snapshot.pathParts],
      digest: snapshot.content === undefined ? null : rawDigest(snapshot.content),
      ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
    });
  }
  for (const mutation of mutations) {
    if (isMutablePhaseRecord(mutation.pathParts)) continue;
    const previous = expected.get(mutation.pathParts.join('\0'));
    expected.set(mutation.pathParts.join('\0'), {
      pathParts: [...mutation.pathParts],
      digest: mutation.type === 'delete' ? null : rawDigest(mutation.content),
      ...(mutation.type === 'write' && mutation.mode !== undefined ? { mode: mutation.mode } :
        mutation.type === 'write' && previous?.mode !== undefined ? { mode: previous.mode } : {})
    });
  }
  return {
    binding: prepared.preview.protectedInputBinding,
    assertUnchanged: async () => {
      for (const file of expected.values()) {
        const current = await captureProjectFileSnapshot(inspection.projectRoot, file.pathParts);
        const currentDigest = current.content === undefined ? null : rawDigest(current.content);
        if (file.digest !== currentDigest ||
          file.digest !== null && file.mode !== undefined && current.mode !== file.mode) {
          throw new UpdatePlanError(
            `Protected update input changed before or during revalidation: ${file.pathParts.join('/')}`,
            'revalidation-inputs-changed', 'Preserve the edit and run liftoff update --check again.'
          );
        }
      }
      const actual = await readActivationInputSnapshot(inspection.projectRoot, writePlan.nextManifest, runner);
      if (canonicalSha256(actual) !== canonicalSha256(prepared.expectedInputSnapshot)) {
        throw new UpdatePlanError(
          'Protected application inputs changed after the reviewed update.',
          'revalidation-inputs-changed', 'Preserve the edits and run liftoff update --check again.'
        );
      }
      const changed = changedRetainedProjectInputs(retained, await captureRetainedProjectInputs(inspection.projectRoot));
      if (changed.length) {
        throw new UpdatePlanError(
          `Protected project scripts or sources changed after review: ${changed.join(', ')}`,
          'revalidation-inputs-changed', 'Preserve the edits and run liftoff update --check again.'
        );
      }
    },
    afterCommand: async (command, options) => {
      retained = acceptDeclaredCommandOutputs(
        retained, await captureRetainedProjectInputs(inspection.projectRoot),
        outputsForLocalCommand(inspection.projectRoot, command, options)
      );
    }
  };
}
