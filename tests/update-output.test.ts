import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandShellForPlatform,
  formatShellCommand
} from '../src/adapters/process/shell-command.js';
import {
  formatUpdateCommand,
  formatUpdateGuidanceText,
  formatRevalidationPhaseBlocker,
  formatUpdateValidationCommands,
  type ResolvedUpdateGuidanceContext
} from '../src/application/update/command-guidance.js';
import { inspectProjectUpdate, UpdatePlanError } from '../src/application/update/inspection.js';
import { formatUpdatePreviewRemedy, UpdatePreviewError } from '../src/application/update/preview.js';
import {
  buildUpdateReport,
  renderUpdateApprovalScope,
  renderDeferredAgentRepair,
  renderUpdatePreview,
  type UpdateMigrationSummary,
  type UpdateRevalidationSummary
} from '../src/application/update/output.js';
import { prepareUpdateReview } from '../src/application/update/review-plan.js';
import { previewLocalRevalidation } from '../src/application/update/revalidation.js';
import { formatRepairCommand } from '../src/application/repair/guidance.js';
import { retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
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
  it('distinguishes a blocked next phase from a genuinely different approved phase', () => {
    const blocked = formatRevalidationPhaseBlocker('seed-verified', null, 'seed-verified', ['Legacy layout needs repair.']);
    expect(blocked).toContain('Local baseline verification (seed-verified) is the next incomplete phase but is not ready');
    expect(blocked).toContain('Legacy layout needs repair.');
    expect(blocked).not.toContain('but the approved operation');
    const mismatch = formatRevalidationPhaseBlocker('seed-valid', 'seed-valid', 'seed-verified', ['Bootstrap inputs changed.']);
    expect(mismatch).toContain('next incomplete phase is Bootstrap validation (seed-valid)');
    expect(mismatch).toContain('approved operation is Local baseline verification (seed-verified)');
    expect(mismatch).toContain('Bootstrap inputs changed.');
    expect(mismatch).toContain('phase order cannot be skipped');
    expect(formatRevalidationPhaseBlocker(null, null, 'seed-verified', [])).toContain('next incomplete phase is none');
    expect(formatRevalidationPhaseBlocker('seed-verified', 'seed-verified', 'seed-verified', [])).toBeUndefined();
  });

  it.each([
    ['linux', "/projects/User's $project [draft]", `liftoff repair '/projects/User'"'"'s $project [draft]' --check`],
    ['darwin', '/Users/person/Project with spaces', "liftoff repair '/Users/person/Project with spaces' --check"],
    ['win32', "C:\\Projects\\User's $project [draft]", "& 'liftoff' 'repair' 'C:\\Projects\\User''s $project [draft]' '--check'"],
    ['win32', '\\\\server\\share\\Project with spaces', "& 'liftoff' 'repair' '\\\\server\\share\\Project with spaces' '--check'"]
  ] as const)('quotes positional repair targets on %s', (platform, root, expected) => {
    expect(formatRepairCommand(root, 'check', platform)).toBe(expected);
    expect(formatRepairCommand(root, 'recover', platform)).toBe(expected.replace('--check', '--recover'));
    const context: ResolvedUpdateGuidanceContext = {
      state: 'resolved', projectRoot: root, requestedProjectRoot: root,
      invocationDirectory: root, implicitProjectRoot: root
    };
    expect(formatRepairCommand(root, 'check', platform, context)).toBe(expected);
    expect(formatRepairCommand(root, 'check', platform, {
      ...context, implicitProjectRoot: `${root}-other`
    })).toBe(expected);
    expect(formatRepairCommand(root, 'check', platform, {
      state: 'unresolved', detail: 'Unknown invocation boundary'
    })).toBe(expected);
  });

  it.each([
    {
      platform: 'linux' as const,
      root: "/tmp/User's $project [draft]",
      normal: `liftoff update --project '/tmp/User'"'"'s $project [draft]'`,
      check: `liftoff update --check --project '/tmp/User'"'"'s $project [draft]'`,
      force: `liftoff update --force --project '/tmp/User'"'"'s $project [draft]'`,
      validation: `cd -- '/tmp/User'"'"'s $project [draft]' && liftoff validate --project '/tmp/User'"'"'s $project [draft]' && liftoff doctor`
    },
    {
      platform: 'darwin' as const,
      root: '/Users/person/Project with spaces',
      normal: "liftoff update --project '/Users/person/Project with spaces'",
      check: "liftoff update --check --project '/Users/person/Project with spaces'",
      force: "liftoff update --force --project '/Users/person/Project with spaces'",
      validation: "cd -- '/Users/person/Project with spaces' && liftoff validate --project '/Users/person/Project with spaces' && liftoff doctor"
    },
    {
      platform: 'win32' as const,
      root: "C:\\Projects\\User's $project [draft]",
      normal: "& 'liftoff' 'update' '--project' 'C:\\Projects\\User''s $project [draft]'",
      check: "& 'liftoff' 'update' '--check' '--project' 'C:\\Projects\\User''s $project [draft]'",
      force: "& 'liftoff' 'update' '--force' '--project' 'C:\\Projects\\User''s $project [draft]'",
      validation: "Set-Location -LiteralPath 'C:\\Projects\\User''s $project [draft]'; if ($?) { & 'liftoff' 'validate' '--project' 'C:\\Projects\\User''s $project [draft]'; if ($?) { & 'liftoff' 'doctor' } }"
    },
    {
      platform: 'win32' as const,
      root: '\\\\server\\share\\Project with spaces',
      normal: "& 'liftoff' 'update' '--project' '\\\\server\\share\\Project with spaces'",
      check: "& 'liftoff' 'update' '--check' '--project' '\\\\server\\share\\Project with spaces'",
      force: "& 'liftoff' 'update' '--force' '--project' '\\\\server\\share\\Project with spaces'",
      validation: "Set-Location -LiteralPath '\\\\server\\share\\Project with spaces'; if ($?) { & 'liftoff' 'validate' '--project' '\\\\server\\share\\Project with spaces'; if ($?) { & 'liftoff' 'doctor' } }"
    }
  ])('quotes literal native targets on $platform: $root', (entry) => {
    for (const mode of ['normal', 'check', 'force'] as const) {
      expect(formatUpdateCommand(entry.root, mode, entry.platform)).toBe(entry[mode]);
    }
    expect(formatUpdateValidationCommands(entry.root, entry.platform)).toBe(entry.validation);

    const context: ResolvedUpdateGuidanceContext = {
      state: 'resolved',
      requestedProjectRoot: entry.root,
      projectRoot: entry.root,
      invocationDirectory: entry.root,
      implicitProjectRoot: entry.root
    };
    for (const mode of ['normal', 'check', 'force'] as const) {
      const expected = entry[mode];
      expect(formatUpdateCommand(entry.root, mode, entry.platform, context)).toBe(expected);
      expect(formatUpdateCommand(entry.root, mode, entry.platform, {
        ...context, invocationDirectory: (entry.platform === 'win32' ? path.win32 : path.posix).join(entry.root, 'backend')
      })).toBe(expected);
      expect(formatUpdateCommand(entry.root, mode, entry.platform, {
        state: 'unresolved', detail: 'No trustworthy invocation context'
      })).toBe(entry[mode]);
      expect(formatUpdateCommand(entry.root, mode, entry.platform, {
        ...context, implicitProjectRoot: `${entry.root}-other`
      })).toBe(entry[mode]);
      expect(formatUpdateCommand(entry.root, mode, entry.platform, {
        ...context, requestedProjectRoot: `${entry.root}-other`, projectRoot: `${entry.root}-other`
      })).toBe(entry[mode]);
    }
    expect(formatUpdateValidationCommands(entry.root, entry.platform, context)).toBe(entry.validation);
    expect(formatUpdateValidationCommands(entry.root, entry.platform, {
      ...context, invocationDirectory: (entry.platform === 'win32' ? path.win32 : path.posix).join(entry.root, 'backend')
    })).toBe(entry.validation);
    expect(formatUpdateValidationCommands(entry.root, entry.platform, {
      state: 'unresolved', detail: 'No trustworthy invocation context'
    })).toBe(entry.validation);
  });

  it.each([
    ['/projects/Preview with spaces', 'linux'],
    ["C:\\Projects\\Preview's $literal [path]", 'win32'],
    ['\\\\server\\share\\Preview with spaces', 'win32']
  ] as const)('renders lower-layer errors for %s independently of the current host', (root, platform) => {
    const check = formatUpdateCommand(root, 'check', platform);
    const apply = formatUpdateCommand(root, 'normal', platform);
    const remedy = ['Run ', { projectRoot: root, mode: 'check' as const }, ' again.'];
    expect(formatUpdateGuidanceText(remedy)).toBe(`Run ${check} again.`);
    expect(new UpdatePlanError('Inputs changed.', 'inputs-changed', remedy).remedy)
      .toBe(`Run ${check} again.`);
    for (const code of ['preview-missing', 'preview-mismatch', 'preview-storage',
      'preview-invalid', 'preview-unsupported', 'preview-busy'] as const) {
      const error = new UpdatePreviewError(code, 'Original failure.', { projectRoot: root });
      expect(error.code).toBe(code);
      expect(error.detail).toBe('Original failure.');
      expect(error.message).toContain(check);
      if (code === 'preview-missing' || code === 'preview-mismatch') expect(error.message).toContain(apply);
    }
    const wrongPlatform = platform === 'win32' ? 'linux' : 'win32';
    expect(() => formatUpdateGuidanceText(remedy, undefined, wrongPlatform))
      .toThrow(/different hosts/);
    expect(() => new UpdatePreviewError('preview-mismatch', 'Original failure.', {
      projectRoot: root, platform: wrongPlatform
    })).toThrow(/different hosts/);
  });

  it('renders structured lower-layer remedies without altering standalone guidance', () => {
    const root = path.resolve('project');
    const context: ResolvedUpdateGuidanceContext = {
      state: 'resolved', projectRoot: root, requestedProjectRoot: root,
      invocationDirectory: root, implicitProjectRoot: root
    };
    const error = new UpdatePlanError('Inputs changed.', 'inputs-changed',
      ['Preserve the edits and run ', { projectRoot: root, mode: 'check' }, ' again.']);
    const explicit = `Preserve the edits and run ${formatUpdateCommand(root, 'check')} again.`;
    expect(error.message).toBe('Inputs changed.');
    expect(error.remedy).toBe(explicit);
    expect(error.formatRemedy(context)).toBe(
      `Preserve the edits and run ${formatUpdateCommand(root, 'check', process.platform, context)} again.`
    );
    expect(error.remedy).toBe(explicit);
    const previewError = new UpdatePreviewError('preview-mismatch', 'The reviewed inputs changed.', {
      projectRoot: root
    });
    expect(previewError.message).toContain(formatUpdateCommand(root, 'check'));
    expect(previewError.detail).toBe('The reviewed inputs changed.');
    expect(formatUpdatePreviewRemedy('preview-missing', root, context, 'force'))
      .toContain(formatUpdateCommand(root, 'force', process.platform, context));
    expect(formatUpdatePreviewRemedy('preview-missing', root, context)).not.toContain('&&');
  });
});

describe('human reviewed scope', () => {
  it('reports agent installation as unimplemented without recommending unsupported commands', async () => {
    const root = await createReviewedUpdateFixture({
      projectName: 'Agent Guidance', projectType: 'standard', apiStack: 'node',
      agents: ['copilot'], environments: ['dev']
    });
    const inspection = await inspectProjectUpdate(root);
    inspection.deferredAgentRepair = {
      kind: 'agent-integration', status: 'separate-repair-required',
      recordedAgents: ['github-copilot'], requestedAgents: ['github-copilot', 'codex'],
      addAgents: ['codex'], recordedDefaultAgent: null, requestedDefaultAgent: null,
      changesDefault: false, executable: false,
      limitation: 'Agent installation and framework default changes are not implemented by the public repair coordinator.'
    };
    const report = buildUpdateReport({
      mode: 'check', status: 'partial', reasonCode: 'agent-repair-required', projectRoot: root
    }, inspection);
    expect(report.deferredAgentRepair).toMatchObject({
      executable: false, limitation: expect.stringContaining('not implemented')
    });
    expect(report.deferredAgentRepair).not.toHaveProperty('command');
    const stdout = new CaptureStream();
    renderDeferredAgentRepair(new PresentationSession({
      stdout, stderr: new CaptureStream(), layout: 'plain', color: false
    }), inspection);
    expect(stdout.text()).toContain('not implemented');
    expect(stdout.text()).not.toContain('--add-agents');
    expect(JSON.stringify(report)).not.toContain('--add-agents');
  });

  it('explains legacy infrastructure independently of migration and retains truthful committed JSON', async () => {
    const root = await createReviewedUpdateFixture({
      projectName: 'Repair Guidance', projectType: 'standard', apiStack: 'node',
      agents: ['copilot'], environments: ['dev']
    });
    const inspection = await inspectProjectUpdate(root);
    inspection.manifest.projectArtifacts = [
      ...inspection.manifest.projectArtifacts.filter((artifact) => artifact.category !== 'infrastructure'),
      ...retiredFlatRootInfrastructureIdentities.map((identity) => ({
        ...identity, pathParts: [...identity.pathParts], generatedBy: '0.10.0',
        generationHash: `sha256:${'a'.repeat(64)}`
      }))
    ];
    const migration: UpdateMigrationSummary = {
      status: 'committed', sourceIdentity: historicalActivationIdentities[0],
      targetIdentity: currentActivationIdentity, historyPaths: ['governance/history/original'], issues: []
    };
    const revalidation: UpdateRevalidationSummary = {
      status: 'blocked', nextPhase: 'seed-verified',
      issues: ['Legacy infrastructure requires separate repair.']
    };
    const report = buildUpdateReport({
      mode: 'apply', status: 'partial', reasonCode: 'revalidation-blocked',
      projectRoot: root, committed: true, migration, revalidation
    }, inspection);
    expect(report).toMatchObject({
      committed: true, activationMigration: { status: 'committed' },
      revalidation: {
        status: 'blocked', nextPhase: 'seed-verified', nextPhaseLabel: 'Local baseline verification',
        description: expect.stringContaining('not an OpenSpec feature change')
      },
      infrastructureRepair: {
        layout: 'legacy-shared', checkCommand: formatRepairCommand(root),
        resumeCommand: formatUpdateCommand(root, 'check')
      }
    });
    expect(report.revalidation.nextActions.join(' ')).toContain(formatRepairCommand(root));
    expect(report.revalidation.nextActions.join(' ')).toContain(formatUpdateCommand(root, 'check'));

    const stdout = new CaptureStream();
    const presentation = new PresentationSession({
      stdout, stderr: new CaptureStream(), layout: 'plain', color: false
    });
    renderUpdatePreview(presentation, inspection, [], migration, revalidation);
    expect(stdout.text()).toContain('Local baseline verification');
    expect(stdout.text()).toContain(formatRepairCommand(root));
    expect(stdout.text()).toContain(formatUpdateCommand(root, 'check'));

    stdout.chunks.length = 0;
    const noRevalidation: UpdateRevalidationSummary = { status: 'not-required', nextPhase: null, issues: [] };
    renderUpdatePreview(presentation, inspection, [], { ...migration, status: 'not-required' }, noRevalidation);
    const current = buildUpdateReport({
      mode: 'check', status: 'current', reasonCode: 'no-update', projectRoot: root,
      revalidation: noRevalidation
    }, inspection);
    expect(current.revalidation.status).toBe('not-required');
    expect(current.infrastructureRepair?.checkCommand).toBe(formatRepairCommand(root));
    expect(stdout.text()).toContain('Local baseline verification requires separate infrastructure repair');
  });

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
      'Approval may commit the displayed successor identity while these known revalidation gaps remain blocked',
      'Next incomplete phase: seed-valid'
    ];
    for (const detail of details) {
      expect(stdout.text()).toContain(detail);
      expect(stderr.text()).toContain(detail);
    }
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
  });
});
