import { createHash } from 'node:crypto';
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
import { formatUpdateCommand } from './command-guidance.js';

export interface PreparedUpdateRevalidation {
  preview: LocalRevalidationPreview;
  expectedInputSnapshot: ActivationInputSnapshot;
  expectedRetainedSource: RetainedProjectInput[];
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

export function postUpdateProtectedInputs(
  inspection: UpdateInspection,
  writePlan: UpdateWritePlan,
  prepared: PreparedUpdateRevalidation,
  runner?: CommandRunner
): {
  binding: string;
  assertUnchanged: () => Promise<readonly RetainedProjectInput[]>;
  afterCommand: (command: ExternalCommand, options?: RunCommandOptions) => Promise<readonly RetainedProjectInput[]>;
} {
  let retained = prepared.expectedRetainedSource;
  return {
    binding: prepared.preview.protectedInputBinding,
    assertUnchanged: async () => {
      const actual = await readActivationInputSnapshot(inspection.projectRoot, writePlan.nextManifest, runner);
      if (canonicalSha256(actual) !== canonicalSha256(prepared.expectedInputSnapshot)) {
        throw new UpdatePlanError(
          'Protected application inputs changed after the reviewed update.',
          'revalidation-inputs-changed',
          `Preserve the edits and run ${formatUpdateCommand(inspection.projectRoot, 'check')} again.`
        );
      }
      const observed = await captureRetainedProjectInputs(inspection.projectRoot);
      const changed = changedRetainedProjectInputs(retained, observed);
      if (changed.length) {
        throw new UpdatePlanError(
          `Protected project scripts or sources changed after review: ${changed.join(', ')}`,
          'revalidation-inputs-changed',
          `Preserve the edits and run ${formatUpdateCommand(inspection.projectRoot, 'check')} again.`
        );
      }
      return observed;
    },
    afterCommand: async (command, options) => {
      retained = acceptDeclaredCommandOutputs(
        retained, await captureRetainedProjectInputs(inspection.projectRoot),
        outputsForLocalCommand(inspection.projectRoot, command, options)
      );
      return retained;
    }
  };
}
