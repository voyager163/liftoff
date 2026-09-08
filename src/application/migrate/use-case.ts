import {
  createHash
} from 'node:crypto';
import {
  existsSync
} from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withProjectMutationLock } from '../../adapters/filesystem/project-lock.js';
import {
  initializeFramework
} from '../../framework-adapters.js';
import {
  assertNewOrEmptyDirectory
} from '../../adapters/filesystem/project-files.js';
import {
  loadManifest
} from '../project/manifest.js';
import {
  validateGeneratedProject
} from '../diagnose/generated-project.js';
import {
  InteractivePrompter
} from '../../interactive.js';
import {
  applyMergePreflight,
  assertSafeInitTarget,
  authorizeMergePreflight,
  buildMergePreflight,
  captureTreeState,
  validateStagedTree,
  withStagingArea,
  writeStagedArtifacts,
  type StagingArea
} from '../../init-filesystem.js';
import {
  migrationCapabilityId,
  migrationChangeName,
  renderMigrationChecklist,
  renderMigrationDesign,
  renderMigrationProposal,
  renderMigrationSpec,
  renderMigrationTasks,
  seedMigrationGroups
} from '../../migrate-plan.js';
import {
  OPEN_SPEC_WORKFLOW_IDS
} from '../../openspec-profile.js';
import {
  buildProjectPlan
} from '../project/planning.js';
import {
  mergeOptions,
  projectPlanEntries
} from '../../domain/project/planning.js';
import {
  formatCommand,
  NodeCommandRunner
} from '../../process-runner.js';
import {
  scanDefaults,
  scanLegacyProject
} from '../../scan.js';
import {
  buildArtifacts,
  partitionGeneratedArtifacts
} from '../../templates.js';
import type {
  ExecutionContext
} from '../context.js';
import type {
  ApiProjectPlan,
  GeneratedArtifact,
  ProjectOptions
} from '../../domain/project/contracts.js';
import { assertSupportedProjectOptions, hasMissingInitInputs } from '../initialize/inputs.js';
import {
  ensureOpenSpecProfileReady,
  ensureWorkstationReady,
  handleProjectDependencies
} from '../initialize/use-case.js';
import { isRetiredPowerAppsError } from '../../domain/project/retired-workload.js';
import { excludesMigrationDirectory } from '../../domain/migration/inventory.js';
import { resolveProjectTypeInput } from '../../domain/project/inputs.js';
import { getProjectType } from '../project/catalog.js';

type MigrationSourceSnapshot = Map<string, string>;

async function snapshotMigrationSource(sourceRoot: string): Promise<MigrationSourceSnapshot> {
  const snapshot: MigrationSourceSnapshot = new Map();
  const visit = async (pathParts: string[]): Promise<void> => {
    const current = path.join(sourceRoot, ...pathParts);
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const childParts = [...pathParts, entry.name];
      const relativePath = childParts.join('/');
      const childPath = path.join(sourceRoot, ...childParts);
      const details = await lstat(childPath);
      if (details.isSymbolicLink()) {
        snapshot.set(relativePath, `symlink:${await readlink(childPath)}`);
      } else if (details.isDirectory()) {
        snapshot.set(relativePath, 'directory');
        await visit(childParts);
      } else if (details.isFile()) {
        const hash = createHash('sha256').update(await readFile(childPath)).digest('hex');
        snapshot.set(relativePath, `file:${hash}`);
      } else {
        snapshot.set(relativePath, 'other');
      }
    }
  };
  await visit([]);
  return snapshot;
}

function sourceSnapshotChanges(
  before: MigrationSourceSnapshot,
  after: MigrationSourceSnapshot
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

async function withUnchangedMigrationSource<T>(
  sourceRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const before = await snapshotMigrationSource(sourceRoot);
  const assertUnchanged = async () => {
    const changes = sourceSnapshotChanges(before, await snapshotMigrationSource(sourceRoot));
    if (changes.length > 0) {
      throw new Error(
        `Migration source changed unexpectedly; refusing to continue:\n${changes.map((entry) => `- ${entry}`).join('\n')}`
      );
    }
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await assertUnchanged();
    throw error;
  }
  await assertUnchanged();
  return result;
}

async function stageMigrationSource(area: StagingArea, sourceRoot: string): Promise<void> {
  const destination = path.join(area.root, 'migration', 'legacy');
  await cp(sourceRoot, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (!relative) {
        return true;
      }
      return !relative.split(path.sep).some(excludesMigrationDirectory);
    }
  });
  for (const entry of (await captureTreeState(area.root)).values()) {
    if (
      entry.pathParts[0] === 'migration' &&
      entry.pathParts[1] === 'legacy' &&
      entry.type !== 'directory'
    ) {
      area.origins.set(entry.pathParts.join('/'), 'seed');
    }
  }
}

function migrationPlanArtifacts(
  plan: ApiProjectPlan,
  inventory: Awaited<ReturnType<typeof scanLegacyProject>>
): { artifacts: GeneratedArtifact[]; location: string } {
  const groups = seedMigrationGroups(inventory, plan);
  if (plan.specWorkflow.id === 'openspec') {
    return {
      artifacts: [
        {
          logicalName: 'migration-change-metadata',
          category: 'seed',
          lifecycle: 'seed',
          pathParts: ['openspec', 'changes', migrationChangeName, '.openspec.yaml'],
          content: 'schema: spec-driven\n'
        },
        {
          logicalName: 'migration-proposal',
          category: 'seed',
          lifecycle: 'seed',
          pathParts: ['openspec', 'changes', migrationChangeName, 'proposal.md'],
          content: renderMigrationProposal(plan, inventory)
        },
        {
          logicalName: 'migration-design',
          category: 'seed',
          lifecycle: 'seed',
          pathParts: ['openspec', 'changes', migrationChangeName, 'design.md'],
          content: renderMigrationDesign(plan, inventory)
        },
        {
          logicalName: 'migration-tasks',
          category: 'seed',
          lifecycle: 'seed',
          pathParts: ['openspec', 'changes', migrationChangeName, 'tasks.md'],
          content: renderMigrationTasks(groups)
        },
        {
          logicalName: 'migration-spec',
          category: 'seed',
          lifecycle: 'seed',
          pathParts: [
            'openspec',
            'changes',
            migrationChangeName,
            'specs',
            migrationCapabilityId,
            'spec.md'
          ],
          content: renderMigrationSpec()
        }
      ],
      location: `openspec/changes/${migrationChangeName}/ (run it with your agent workflow, e.g. /opsx:apply ${migrationChangeName})`
    };
  }
  return {
    artifacts: [{
      logicalName: 'migration-checklist',
      category: 'seed',
      lifecycle: 'seed',
      pathParts: ['MIGRATION.md'],
      content: renderMigrationChecklist(plan, inventory, groups)
    }],
    location: 'MIGRATION.md'
  };
}

async function executeMigration(
  flagOptions: ProjectOptions,
  context: ExecutionContext,
  sourceRoot: string
): Promise<number> {
  const { presentation } = context;
  presentation.stage('Scan legacy project', sourceRoot);
  const inventory = await scanLegacyProject(sourceRoot);
  if (inventory.diagnostics?.length) {
    presentation.bullets('Scan limitations', inventory.diagnostics.map((diagnostic) =>
      `${diagnostic.sourcePath}: ${diagnostic.message}`
    ));
  }
  const { options: defaults, provenance } = scanDefaults(inventory);
  if (presentation.stdout.layout === 'plain') {
    presentation.section(
      'Scan defaults (override in prompts or with flags)',
      provenance.map((item) =>
        `${item.field}: ${String(item.value)}  (detected: ${item.evidence})`
      )
    );
  } else {
    presentation.table(
      'Scan defaults (override in prompts or with flags)',
      ['Decision', 'Detected value', 'Evidence'],
      provenance.map((item) => [item.field, String(item.value), item.evidence])
    );
  }

  const initial = mergeOptions(defaults, flagOptions);
  const requestedType = resolveProjectTypeInput(flagOptions, getProjectType).projectType?.id;
  if (requestedType) initial.projectType = requestedType;
  if (requestedType === 'standard' && flagOptions.pattern === undefined) {
    initial.pattern = undefined;
  }
  if (requestedType === 'genai' && flagOptions.apiStack === undefined) {
    initial.apiStack = undefined;
  }
  const runner = context.runner ?? new NodeCommandRunner();
  const interactive = initial.yes !== true;
  const prompter = interactive
    ? new InteractivePrompter({
        input: context.stdin,
        output: context.stdout,
        presentation,
        cwd: context.cwd,
        runner
      })
    : undefined;
  try {
    const needsPrompts = interactive && hasMissingInitInputs(initial);
    if (needsPrompts) {
      presentation.stage('Configure migrated project');
    }
    const options = needsPrompts ? await prompter!.promptForInitOptions(initial) : initial;
    const plan = buildProjectPlan(options, { requireProjectName: true });
    presentation.stage('Review migration plan');
    const confirmed = options.yes === true
      ? (presentation.definitions('Resolved migration plan', projectPlanEntries(plan)), true)
      : await prompter!.confirmPlan(plan, undefined, 'Migrate project?');
    if (!confirmed) {
      presentation.cancellation('Migration stopped; the source and destination were not modified.');
      return 0;
    }

    presentation.stage('Resolve fresh migration target');
    const parentDir = path.dirname(sourceRoot);
    let targetRoot = path.resolve(parentDir, plan.safeProjectName);
    if (targetRoot === sourceRoot) {
      targetRoot = path.resolve(parentDir, `${plan.safeProjectName}-liftoff`);
    }
    const target = { root: targetRoot, mode: 'named-child' as const };
    await assertSafeInitTarget(target, parentDir);
    await assertNewOrEmptyDirectory(targetRoot);

    presentation.stage('Check workstation readiness');
    const readinessParent = process.env.LIFTOFF_STAGING_ROOT
      ? path.resolve(process.env.LIFTOFF_STAGING_ROOT)
      : os.tmpdir();
    await mkdir(readinessParent, { recursive: true });
    const readinessRoot = await mkdtemp(path.join(readinessParent, 'liftoff-migrate-readiness-'));
    const readiness = await (async () => {
      try {
        return await ensureWorkstationReady(
          plan,
          options,
          context,
          runner,
          presentation,
          prompter,
          `liftoff migrate ${JSON.stringify(sourceRoot)}`,
          readinessRoot
        );
      } finally {
        await rm(readinessRoot, { recursive: true, force: true });
      }
    })();
    if (!readiness.ready) {
      return 1;
    }
    const profileReadiness = await ensureOpenSpecProfileReady(
      plan,
      options,
      context,
      runner,
      presentation,
      prompter,
      `liftoff migrate ${JSON.stringify(sourceRoot)}`
    );
    if (!profileReadiness.ready) {
      return 1;
    }

    const migrationPlan = migrationPlanArtifacts(plan, inventory);
    return await withProjectMutationLock(targetRoot, async () => {
      presentation.stage('Stage fresh migration project');
      await withStagingArea(async (area) => {
        const partition = partitionGeneratedArtifacts(buildArtifacts(plan));
        await writeStagedArtifacts(area, partition.liftoff, 'liftoff');
        presentation.stage(
          'Initialize spec-driven framework',
          `${plan.specWorkflow.label} ${plan.framework.version}`
        );
        await initializeFramework(area, plan, runner, {
          env: context.env,
          ...presentation.childStreams(),
          onCommand: (command) => presentation.command(command)
        });
        await writeStagedArtifacts(area, partition.seed, 'seed');
        presentation.stage('Copy filtered legacy source', sourceRoot);
        await stageMigrationSource(area, sourceRoot);
        await writeStagedArtifacts(area, migrationPlan.artifacts, 'seed');
        await writeStagedArtifacts(area, [partition.manifest], 'liftoff');
        if (plan.specWorkflow.id === 'openspec') {
          const command = {
            executable: plan.framework.executable,
            args: ['validate', migrationChangeName, '--strict']
          };
          presentation.stage('Validate generated migration plan', migrationChangeName);
          presentation.command(formatCommand(command));
          const result = await runner.run(command, {
            cwd: area.root,
            env: context.env,
            timeoutMs: 30_000
          });
          if (result.status !== 0 || result.timedOut || result.errorCode) {
            const detail = result.timedOut
              ? 'command timed out'
              : result.errorMessage || result.stderr.trim().split(/\r?\n/)[0] ||
                `exit status ${result.status}`;
            throw new Error(
              `Generated migration plan failed strict validation: ${result.displayCommand}: ${detail}`
            );
          }
        }
        presentation.stage('Validate staged migration');
        await validateStagedTree(area);
        const stagedIssues = await validateGeneratedProject(area.root);
        if (stagedIssues.length > 0) {
          throw new Error(`Staged migration project validation failed:\n${stagedIssues.join('\n')}`);
        }

        const preflight = await buildMergePreflight(area, targetRoot);
        const existing = preflight.entries.filter((entry) => entry.destination.type !== 'missing');
        if (existing.length > 0) {
          throw new Error(
            `Migration target must remain new or empty; --force cannot replace existing content:\n` +
            existing.map((entry) => `- ${entry.relativePath}`).join('\n')
          );
        }
        const authorized = await authorizeMergePreflight(preflight, false);
        if (!authorized) {
          throw new Error('Migration target authorization failed.');
        }
        presentation.stage('Merge fresh migration target', targetRoot);
        await applyMergePreflight(authorized, { requireEmptyTarget: true });
      });

      const issues = await validateGeneratedProject(targetRoot);
      if (issues.length > 0) {
        presentation.error(`Migrated project validation failed:\n${issues.join('\n')}`);
        return 1;
      }

      const dependencyPhase = await handleProjectDependencies(
        plan,
        targetRoot,
        options,
        readiness.probes,
        context,
        runner,
        presentation,
        prompter
      );
      if (!dependencyPhase.success) {
        return 1;
      }

      presentation.bullets('Configured integrations', [
        `${plan.specWorkflow.label} ${plan.framework.version}`,
        ...plan.agents.map((agent) =>
          `${agent.label}${plan.defaultAgent?.id === agent.id ? ' (default)' : ''}`
        ),
        ...(plan.specWorkflow.id === 'openspec'
          ? [
              `OpenSpec global profile: ${profileReadiness.changed ? 'configured' : 'verified'}; ` +
                `${OPEN_SPEC_WORKFLOW_IDS.length} workflows; skills and commands`,
              ...(plan.agents.some((agent) => agent.id === 'github-copilot')
                ? [`GitHub Copilot cloud agent: ${plan.copilotCloud ? 'enabled' : 'disabled'}`]
                : [])
            ]
          : [])
      ]);
      if (readiness.deferred.length > 0) {
        presentation.bullets('Deferred advisory checks', readiness.deferred);
      }
      if (dependencyPhase.deferred.length > 0) {
        presentation.bullets('Deferred project dependencies', dependencyPhase.deferred);
      }
      presentation.bullets('Next steps', [
        `Optional - preserve history: copy the .git directory from ${sourceRoot} into ${targetRoot}, then commit the migration on top (git rename detection preserves file history).`,
        `Execute the migration plan: ${migrationPlan.location}`,
        'Verify compliance: liftoff validate && liftoff doctor'
      ]);
      presentation.completion(
        `Migrated ${plan.projectName}`,
        targetRoot,
        [
          { label: 'Target', value: targetRoot },
          { label: 'Source', value: `${sourceRoot} (not modified)` },
          { label: 'Rollback', value: `Delete ${targetRoot}` }
        ],
        'liftoff validate && liftoff doctor'
      );
      return 0;
    });
  } finally {
    prompter?.close();
  }
}

export interface MigrationRequest {
  source?: string;
  options: ProjectOptions;
}

export async function migrateProject(request: MigrationRequest, context: ExecutionContext): Promise<number> {
  const sourceArg = request.source;
  if (!sourceArg) {
    context.presentation.error(
      'Usage: liftoff migrate <path-to-existing-project>',
      'Run `liftoff migrate --help` for accepted migration options.'
    );
    return 1;
  }
  assertSupportedProjectOptions(request.options);
  const sourceRoot = path.resolve(context.cwd, sourceArg);
  let sourceDetails;
  try {
    sourceDetails = await stat(sourceRoot);
  } catch {
    context.presentation.error(`Source project not found: ${sourceRoot}`);
    return 1;
  }
  if (!sourceDetails.isDirectory()) {
    context.presentation.error(`Source path is not a directory: ${sourceRoot}`);
    return 1;
  }
  if (existsSync(path.join(sourceRoot, 'liftoff.manifest.json'))) {
    try {
      await loadManifest(sourceRoot);
    } catch (error) {
      if (isRetiredPowerAppsError(error)) {
        throw error;
      }
    }
    context.presentation.error(
      `${sourceRoot} is already a Liftoff project.`,
      'Use `liftoff update` for managed-core maintenance; in-place project template migration is not automated.'
    );
    return 1;
  }
  context.presentation.identity('Migrate an existing application into a fresh Liftoff project');
  return withUnchangedMigrationSource(sourceRoot, () => executeMigration(request.options, context, sourceRoot));
}
