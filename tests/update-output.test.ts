import { afterEach, describe, expect, it } from 'vitest';
import {
  commandShellForPlatform,
  formatShellCommand
} from '../src/adapters/process/shell-command.js';
import {
  formatUpdateCommand,
  formatUpdateValidationCommands
} from '../src/application/update/command-guidance.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import {
  buildUpdateReport,
  renderUpdateApprovalScope,
  renderUpdatePreview,
  type UpdateMigrationSummary,
  type UpdateRevalidationSummary
} from '../src/application/update/output.js';
import { prepareUpdateReview } from '../src/application/update/review-plan.js';
import { previewLocalRevalidation } from '../src/application/update/revalidation.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { historicalActivationIdentities } from '../src/domain/governance/policy/identity.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';
import {
  cleanupUpdateTestRoots,
  createReviewedUpdateFixture,
  fingerprintUpdateTestProject
} from './reviewed-update-helpers.js';

afterEach(cleanupUpdateTestRoots);

describe('project-bound update command guidance', () => {
  it.each([
    {
      platform: 'linux' as const,
      root: "/tmp/User's $project [draft]",
      normal: `liftoff update --project '/tmp/User'"'"'s $project [draft]'`,
      check: `liftoff update --check --project '/tmp/User'"'"'s $project [draft]'`,
      force: `liftoff update --force --project '/tmp/User'"'"'s $project [draft]'`,
      validation: `cd -- '/tmp/User'"'"'s $project [draft]' && liftoff validate && liftoff doctor`
    },
    {
      platform: 'darwin' as const,
      root: '/Users/person/Project with spaces',
      normal: "liftoff update --project '/Users/person/Project with spaces'",
      check: "liftoff update --check --project '/Users/person/Project with spaces'",
      force: "liftoff update --force --project '/Users/person/Project with spaces'",
      validation: "cd -- '/Users/person/Project with spaces' && liftoff validate && liftoff doctor"
    },
    {
      platform: 'win32' as const,
      root: "C:\\Projects\\User's $project [draft]",
      normal: "& 'liftoff' 'update' '--project' 'C:\\Projects\\User''s $project [draft]'",
      check: "& 'liftoff' 'update' '--check' '--project' 'C:\\Projects\\User''s $project [draft]'",
      force: "& 'liftoff' 'update' '--force' '--project' 'C:\\Projects\\User''s $project [draft]'",
      validation: "Set-Location -LiteralPath 'C:\\Projects\\User''s $project [draft]'; if ($?) { & 'liftoff' 'validate'; if ($?) { & 'liftoff' 'doctor' } }"
    },
    {
      platform: 'win32' as const,
      root: '\\\\server\\share\\Project with spaces',
      normal: "& 'liftoff' 'update' '--project' '\\\\server\\share\\Project with spaces'",
      check: "& 'liftoff' 'update' '--check' '--project' '\\\\server\\share\\Project with spaces'",
      force: "& 'liftoff' 'update' '--force' '--project' '\\\\server\\share\\Project with spaces'",
      validation: "Set-Location -LiteralPath '\\\\server\\share\\Project with spaces'; if ($?) { & 'liftoff' 'validate'; if ($?) { & 'liftoff' 'doctor' } }"
    }
  ])('quotes literal native targets on $platform: $root', (entry) => {
    for (const mode of ['normal', 'check', 'force'] as const) {
      expect(formatUpdateCommand(entry.root, mode, entry.platform)).toBe(entry[mode]);
    }
    expect(formatUpdateValidationCommands(entry.root, entry.platform)).toBe(entry.validation);
  });
});

describe('human reviewed scope', () => {
  it('discloses structured migration and revalidation details identically in preview and approval', async () => {
    const root = await createReviewedUpdateFixture({
      projectName: 'Review Details',
      pattern: 'prompt',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'openspec',
      includeFrontend: true
    });
    const before = await fingerprintUpdateTestProject(root);
    const inspection = await inspectProjectUpdate(root);
    const review = await prepareUpdateReview(inspection, false);
    const preview = await previewLocalRevalidation({
      projectRoot: root,
      targetManifest: inspection.manifest,
      protectedInputBinding: 'a'.repeat(64)
    });
    const migration: UpdateMigrationSummary = {
      status: 'available',
      sourceIdentity: historicalActivationIdentities[0],
      targetIdentity: currentActivationIdentity,
      snapshotId: 'history-under-review',
      historyPaths: ['governance/activation-state.json'],
      operations: [{ type: 'write', path: 'governance/migration-state.json' }],
      issues: ['Historical proof remains non-executable.']
    };
    const revalidation: UpdateRevalidationSummary = {
      status: 'blocked',
      nextPhase: 'seed-valid',
      issues: ['seed-valid: A named prerequisite is missing.'],
      preview
    };
    const report = buildUpdateReport({
      mode: 'check', status: 'update-available', reasonCode: 'review-required',
      projectRoot: root, migration, revalidation
    }, inspection, review.writePlan);
    expect(report.revalidation.preview).toEqual(preview);
    expect(report.activationMigration).toEqual(migration);

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const presentation = new PresentationSession({ stdout, stderr, layout: 'plain', color: false });
    renderUpdatePreview(presentation, inspection, [review.summary], migration, revalidation);
    renderUpdateApprovalScope(presentation, true, review.summary, review.writePlan, migration, revalidation);
    const details = [
      JSON.stringify(migration.sourceIdentity),
      JSON.stringify(migration.targetIdentity),
      migration.snapshotId!,
      'write "governance/migration-state.json"',
      ...preview.effects,
      ...preview.inspectionCommands.map((entry) =>
        `Read-only inspection: ${formatShellCommand(entry.command, commandShellForPlatform(process.platform))} (directory: ${JSON.stringify(entry.cwdPathParts.join('/') || '.')}); environment overrides: ${JSON.stringify(entry.env)}`
      ),
      ...preview.phases.flatMap((phase) => phase.commands.map((entry) =>
        `${phase.phaseId}: ${formatShellCommand(entry.command, commandShellForPlatform(process.platform))} (directory: ${JSON.stringify(entry.cwdPathParts.join('/') || '.')}); environment overrides: ${JSON.stringify(entry.env)}`
      )),
      ...Object.values(preview.recordWrites),
      `${preview.commandLimits.timeoutMs} ms; ${preview.commandLimits.maxOutputBytes} output bytes`,
      ...preview.outputPolicy.map((policy) =>
        `Generated-output policy for ${policy.executable} from ${JSON.stringify(policy.cwd.join('/') || '.')}: ${policy.outputs.map((parts) => JSON.stringify(parts.join('/'))).join(', ')}; only after a listed matching command executes.`
      ),
      preview.boundary,
      'Known revalidation gap: seed-valid: A named prerequisite is missing.',
      'Approval may commit v2 while these known revalidation gaps remain blocked.',
      'Next incomplete phase: seed-valid'
    ];
    for (const detail of details) {
      expect(stdout.text()).toContain(detail);
      expect(stderr.text()).toContain(detail);
    }
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });
});
