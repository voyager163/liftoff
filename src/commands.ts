import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatCommandHelp, readBooleanFlag, readListFlag, readStringFlag } from './args.js';
import { apiStacks, listRegions, patterns, providers, searchRegions } from './catalogs.js';
import {
  artifactPath,
  assertNewOrEmptyDirectory,
  deleteProjectFile,
  findProjectRoot,
  loadManifest,
  manifestDisplayPath,
  resolveProjectPath,
  resolveTargetRoot,
  validateGeneratedProject,
  writeArtifacts,
  writeProjectFile
} from './file-system.js';
import { confirmPlan, promptForCreateOptions } from './interactive.js';
import { renderMigrationChecklist, renderMigrationProposal, renderMigrationTasks, seedMigrationGroups } from './migrate-plan.js';
import { buildProjectPlan, formatProjectPlan, loadConfigOptions, mergeOptions, PlanValidationError } from './planner.js';
import { scanDefaults, scanLegacyProject } from './scan.js';
import { hasDrift, reconcileProject } from './reconcile.js';
import type { ReconcileEntry } from './reconcile.js';
import { compareSemver } from './semver.js';
import { buildArtifacts, buildManifest } from './templates.js';
import type { ApiStackId, LiftoffManifest, ParsedArgs, ProjectOptions } from './types.js';
import { liftoffVersion } from './version.js';

export interface CommandContext {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function runCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  try {
    if (parsed.command && readBooleanFlag(parsed.flags, 'help')) {
      context.stdout.write(formatCommandHelp(parsed.command));
      return 0;
    }
    switch (parsed.command) {
      case undefined:
      case 'help':
      case '--help':
        if (parsed.positional[0]) {
          context.stdout.write(formatCommandHelp(parsed.positional[0]));
        } else {
          printHelp(context.stdout);
        }
        return 0;
      case 'version':
        context.stdout.write(`Liftoff ${liftoffVersion}\n`);
        return 0;
      case 'create':
        return await createCommand(parsed, context);
      case 'plan':
        return await planCommand(parsed, context);
      case 'patterns':
        return patternsCommand(context);
      case 'providers':
        return providersCommand(context);
      case 'regions':
        return regionsCommand(parsed, context);
      case 'validate':
        return await validateCommand(parsed, context);
      case 'update':
        return await updateCommand(parsed, context);
      case 'migrate':
        return await migrateCommand(parsed, context);
      case 'doctor':
        return await doctorCommand(parsed, context);
      case 'dev':
        return helperCommand(parsed, context, 'docker compose');
      case 'infra':
        return helperCommand(parsed, context, 'tofu');
      default:
        context.stderr.write(`Unknown command: ${parsed.command}\n\n`);
        printHelp(context.stderr);
        return 1;
    }
  } catch (error) {
    if (error instanceof PlanValidationError) {
      context.stderr.write(`${error.issues.join('\n')}\n`);
      return 1;
    }
    context.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

async function createCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const initial = await optionsFromParsedArgs(parsed, context.cwd, true);
  const needsPrompts = !initial.yes && hasMissingCreateInputs(initial);
  const options = needsPrompts ? await promptForCreateOptions(initial) : initial;
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const confirmed = await confirmPlan(plan, options.yes);
  if (!confirmed) {
    context.stdout.write('Generation cancelled.\n');
    return 0;
  }

  const targetRoot = resolveTargetRoot(context.cwd, plan.safeProjectName);
  const artifacts = buildArtifacts(plan);
  await writeArtifacts(targetRoot, artifacts);
  const issues = await validateGeneratedProject(targetRoot);
  if (issues.length > 0) {
    context.stderr.write(`Generated project validation failed:\n${issues.join('\n')}\n`);
    return 1;
  }

  context.stdout.write(`Created ${plan.projectName} at ${targetRoot}\n`);
  return 0;
}

async function planCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const options = await optionsFromParsedArgs(parsed, context.cwd, false);
  const plan = buildProjectPlan(options, { requireProjectName: false });
  const artifacts = buildArtifacts(plan);
  context.stdout.write(`${formatProjectPlan(plan)}\n\nArtifacts (${artifacts.length}):\n`);
  for (const artifact of artifacts) {
    context.stdout.write(`- ${artifact.logicalName}: ${artifact.pathParts.join('/')}\n`);
  }
  return 0;
}

function patternsCommand(context: CommandContext): number {
  context.stdout.write('Patterns:\n');
  for (const pattern of patterns) {
    context.stdout.write(`- ${pattern.id}: ${pattern.label} [${pattern.scaffoldStatus}]\n`);
  }
  return 0;
}

function providersCommand(context: CommandContext): number {
  context.stdout.write('Providers:\n');
  for (const provider of providers) {
    context.stdout.write(`- ${provider.id}: ${provider.label} [${provider.status}]\n`);
  }
  return 0;
}

function regionsCommand(parsed: ParsedArgs, context: CommandContext): number {
  const cloud = readStringFlag(parsed.flags, 'cloud') ?? 'azure';
  if (cloud !== 'azure') {
    context.stderr.write(`${cloud} regions are not available until the provider adapter is implemented.\n`);
    return 1;
  }

  const query = parsed.positional[0] ?? readStringFlag(parsed.flags, 'region');
  const regions = parsed.subcommand === 'search' && query ? searchRegions('azure', query) : listRegions('azure');
  for (const region of regions) {
    context.stdout.write(`${region.slug}\t${region.displayName}\t${region.geography}\n`);
  }
  return 0;
}

async function validateCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const explicit = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project');
  const projectRoot = explicit
    ? path.resolve(context.cwd, explicit)
    : (await findProjectRoot(context.cwd)) ?? context.cwd;
  const issues = await validateGeneratedProject(projectRoot);
  if (issues.length > 0) {
    context.stderr.write(`${issues.join('\n')}\n`);
    return 1;
  }
  context.stdout.write('Generated project manifest is valid.\n');
  return 0;
}

const STAGING_EXCLUDES = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);

async function migrateCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const sourceArg = parsed.positional[0];
  if (!sourceArg) {
    context.stderr.write('Usage: liftoff migrate <path-to-existing-project>\n');
    return 1;
  }
  const sourceRoot = path.resolve(context.cwd, sourceArg);
  let sourceDetails;
  try {
    sourceDetails = await stat(sourceRoot);
  } catch {
    context.stderr.write(`Source project not found: ${sourceRoot}\n`);
    return 1;
  }
  if (!sourceDetails.isDirectory()) {
    context.stderr.write(`Source path is not a directory: ${sourceRoot}\n`);
    return 1;
  }
  if (existsSync(path.join(sourceRoot, 'liftoff.manifest.json'))) {
    context.stderr.write(`${sourceRoot} is already a Liftoff project. Use liftoff update instead.\n`);
    return 1;
  }

  const inventory = await scanLegacyProject(sourceRoot);
  const { options: defaults, provenance } = scanDefaults(inventory);
  context.stdout.write('Scan defaults (override in prompts or with flags):\n');
  for (const item of provenance) {
    context.stdout.write(`  - ${item.field}: ${item.value}  (detected: ${item.evidence})\n`);
  }
  context.stdout.write('\n');

  const flagOptions = await optionsFromParsedArgs(parsed, context.cwd, false);
  const initial = mergeOptions(defaults, flagOptions);
  if (flagOptions.pattern && flagOptions.projectType === undefined) {
    initial.projectType = 'genai';
    if (flagOptions.apiStack === undefined) {
      initial.apiStack = undefined;
    }
  } else if (flagOptions.apiStack && flagOptions.projectType === undefined) {
    initial.projectType = 'standard';
    initial.pattern = undefined;
  }
  if (flagOptions.projectType === 'standard' && flagOptions.pattern === undefined) {
    initial.pattern = undefined;
  }
  if (flagOptions.projectType === 'genai' && flagOptions.apiStack === undefined) {
    initial.apiStack = undefined;
  }
  const needsPrompts = !initial.yes && hasMissingCreateInputs(initial);
  const options = needsPrompts ? await promptForCreateOptions(initial) : initial;
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const confirmed = await confirmPlan(plan, options.yes);
  if (!confirmed) {
    context.stdout.write('Migration cancelled.\n');
    return 0;
  }

  const parentDir = path.dirname(sourceRoot);
  let targetRoot = path.resolve(parentDir, plan.safeProjectName);
  if (targetRoot === sourceRoot) {
    targetRoot = path.resolve(parentDir, `${plan.safeProjectName}-liftoff`);
  }

  const artifacts = buildArtifacts(plan);
  await writeArtifacts(targetRoot, artifacts);
  const issues = await validateGeneratedProject(targetRoot);
  if (issues.length > 0) {
    context.stderr.write(`Generated scaffold validation failed:\n${issues.join('\n')}\n`);
    return 1;
  }

  const stagingRoot = path.join(targetRoot, 'migration', 'legacy');
  await cp(sourceRoot, stagingRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (!relative) {
        return true;
      }
      return !relative.split(path.sep).some((part) => STAGING_EXCLUDES.has(part));
    }
  });

  const groups = seedMigrationGroups(inventory, plan);
  let planLocation: string;
  if (plan.specWorkflow.id === 'openspec') {
    const changeDir = path.join(targetRoot, 'openspec', 'changes', 'migrate-to-liftoff');
    await mkdir(changeDir, { recursive: true });
    await writeFile(path.join(changeDir, 'proposal.md'), renderMigrationProposal(plan, inventory), 'utf8');
    await writeFile(path.join(changeDir, 'tasks.md'), renderMigrationTasks(groups), 'utf8');
    planLocation = 'openspec/changes/migrate-to-liftoff/ (run it with your agent workflow, e.g. /opsx:apply migrate-to-liftoff)';
  } else {
    await writeFile(path.join(targetRoot, 'MIGRATION.md'), renderMigrationChecklist(plan, inventory, groups), 'utf8');
    planLocation = 'MIGRATION.md';
  }

  context.stdout.write(`Created ${plan.projectName} at ${targetRoot}\n\n`);
  context.stdout.write('Next steps:\n');
  context.stdout.write(`  1. Optional - preserve history: copy the .git directory from ${sourceRoot} into ${targetRoot}, then commit the migration on top (git rename detection preserves file history).\n`);
  context.stdout.write(`  2. Execute the migration plan: ${planLocation}\n`);
  context.stdout.write('  3. Verify compliance: liftoff validate && liftoff doctor\n');
  context.stdout.write(`The source project was not modified. Rolling back is deleting ${targetRoot}.\n`);
  return 0;
}

interface UpdateSummary {
  new: number;
  missing: number;
  upgrade: number;
  conflict: number;
  moved: number;
  orphan: number;
  refresh: number;
  unchanged: number;
}

function summarizeEntries(entries: ReconcileEntry[]): UpdateSummary {
  const summary: UpdateSummary = { new: 0, missing: 0, upgrade: 0, conflict: 0, moved: 0, orphan: 0, refresh: 0, unchanged: 0 };
  for (const entry of entries) {
    if (entry.status === 'unchanged') {
      if (entry.refreshHash) {
        summary.refresh += 1;
      } else {
        summary.unchanged += 1;
      }
      continue;
    }
    if (entry.status === 'moved' && !entry.cleanMove) {
      summary.conflict += 1;
      continue;
    }
    summary[entry.status] += 1;
  }
  return summary;
}

function entryMarker(entry: ReconcileEntry): string {
  switch (entry.status) {
    case 'new':
    case 'missing':
      return '+';
    case 'upgrade':
      return '~';
    case 'conflict':
      return '!';
    case 'moved':
      return entry.cleanMove ? '>' : '!';
    case 'orphan':
      return '-';
    default:
      return '~';
  }
}

function entryDisplay(entry: ReconcileEntry): string {
  if (entry.status === 'moved' && entry.previousPathParts) {
    return `${manifestDisplayPath(entry.previousPathParts)} => ${manifestDisplayPath(entry.pathParts)}`;
  }
  return manifestDisplayPath(entry.pathParts);
}

function isDirtyGitWorktree(projectRoot: string): boolean {
  if (!existsSync(path.join(projectRoot, '.git'))) {
    return false;
  }
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function preflightUpdate(
  projectRoot: string,
  entries: ReconcileEntry[],
  force: boolean
): Promise<void> {
  for (const entry of entries) {
    const writesDestination =
      entry.status === 'new' ||
      entry.status === 'missing' ||
      entry.status === 'upgrade' ||
      entry.status === 'moved' && (entry.cleanMove === true || force) ||
      entry.status === 'conflict' && force;
    if (writesDestination) {
      await resolveProjectPath(projectRoot, entry.pathParts);
    }
    if (
      entry.previousPathParts &&
      (entry.status === 'moved' && (entry.cleanMove === true || force) || entry.status === 'conflict' && force)
    ) {
      await resolveProjectPath(projectRoot, entry.previousPathParts);
    }
  }
  await resolveProjectPath(projectRoot, ['liftoff.manifest.json']);
}

async function updateCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const apply = readBooleanFlag(parsed.flags, 'apply') ?? false;
  const force = readBooleanFlag(parsed.flags, 'force') ?? false;
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  if (force && !apply) {
    context.stderr.write('--force requires --apply.\n');
    return 1;
  }

  const explicit = parsed.positional[0] ?? readStringFlag(parsed.flags, 'project');
  const projectRoot = explicit ? path.resolve(context.cwd, explicit) : await findProjectRoot(context.cwd);
  if (!projectRoot) {
    context.stderr.write(`No liftoff.manifest.json found in ${context.cwd} or any parent directory.\n`);
    return 1;
  }

  const manifest = await loadManifest(projectRoot);
  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    context.stderr.write(
      `This project was written by Liftoff ${manifest.liftoffVersion}, which is newer than this CLI (${liftoffVersion}). Upgrade the CLI first.\n`
    );
    return 1;
  }

  const config = await loadConfigOptions('liftoff.config.json', projectRoot);
  const plan = buildProjectPlan(config, { requireProjectName: true });
  if (plan.projectType.id !== manifest.project.projectType) {
    context.stderr.write(
      `Project type changes (${manifest.project.projectType} -> ${plan.projectType.id}) are a migration, not an update. Run liftoff migrate instead.\n`
    );
    return 1;
  }
  if (plan.apiStack.id !== manifest.project.apiStack) {
    context.stderr.write(
      `API stack changes (${manifest.project.apiStack} -> ${plan.apiStack.id}) are a migration, not an update. Run liftoff migrate instead.\n`
    );
    return 1;
  }
  if (plan.pattern?.id !== manifest.project.pattern) {
    context.stderr.write(
      `Pattern changes (${manifest.project.pattern ?? 'none'} -> ${plan.pattern?.id ?? 'none'}) are a migration, not an update. Run liftoff migrate instead.\n`
    );
    return 1;
  }

  const render = buildArtifacts(plan);
  const entries = await reconcileProject(manifest, render, projectRoot);
  const summary = summarizeEntries(entries);
  const drift = hasDrift(entries);
  const visible = entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash);

  if (!apply) {
    if (jsonMode) {
      context.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        mode: 'check',
        cliVersion: liftoffVersion,
        projectVersion: manifest.liftoffVersion,
        entries: visible.map((entry) => ({
          logicalName: entry.logicalName,
          status: entry.status,
          path: manifestDisplayPath(entry.pathParts),
          previousPath: entry.previousPathParts ? manifestDisplayPath(entry.previousPathParts) : undefined,
          reason: entry.reason
        })),
        summary
      }, null, 2)}\n`);
      return drift ? 2 : 0;
    }

    context.stdout.write(`Liftoff ${liftoffVersion} - project generated by ${manifest.liftoffVersion}\n\n`);
    if (!drift) {
      context.stdout.write(`No drift: ${summary.unchanged} artifacts match the current templates and configuration.\n`);
      return 0;
    }
    for (const entry of visible) {
      context.stdout.write(`  ${entryMarker(entry)} ${entryDisplay(entry)}  ${entry.reason}\n`);
    }
    const toWrite = summary.new + summary.missing + summary.upgrade + summary.moved + summary.refresh;
    context.stdout.write(
      `\n  ${toWrite} to write, ${summary.conflict} conflict(s), ${summary.orphan} orphan(s), ${summary.unchanged} unchanged\n`
    );
    context.stdout.write('  Run `liftoff update --apply` to apply the safe changes.\n');
    return 2;
  }

  if (isDirtyGitWorktree(projectRoot)) {
    context.stdout.write('Hint: the project worktree has uncommitted changes - consider committing before applying.\n');
  }
  await preflightUpdate(projectRoot, entries, force);

  const written: ReconcileEntry[] = [];
  const skipped: ReconcileEntry[] = [];
  for (const entry of entries) {
    switch (entry.status) {
      case 'new':
      case 'missing':
      case 'upgrade':
        await writeProjectFile(projectRoot, entry.pathParts, entry.rendered!.content);
        written.push(entry);
        break;
      case 'moved':
        if (entry.cleanMove || force) {
          if (!entry.destinationMatches) {
            await writeProjectFile(projectRoot, entry.pathParts, entry.rendered!.content);
          }
          await deleteProjectFile(projectRoot, entry.previousPathParts!);
          written.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      case 'conflict':
        if (force) {
          await writeProjectFile(projectRoot, entry.pathParts, entry.rendered!.content);
          if (entry.previousPathParts) {
            await deleteProjectFile(projectRoot, entry.previousPathParts);
          }
          written.push(entry);
        } else {
          skipped.push(entry);
        }
        break;
      default:
        break;
    }
  }

  const oldByName = new Map(manifest.artifacts.map((artifact) => [artifact.logicalName, artifact]));
  const skippedByName = new Map(skipped.map((entry) => [entry.logicalName, entry]));
  const nextManifest = buildManifest(plan, render.filter((artifact) => artifact.logicalName !== 'manifest'));
  nextManifest.artifacts = nextManifest.artifacts.flatMap((artifact) => {
    // config is user-owned after create: carry the recorded entry forward untouched
    if (artifact.logicalName === 'liftoff-config') {
      return [oldByName.get('liftoff-config') ?? artifact];
    }
    if (!skippedByName.has(artifact.logicalName)) {
      return [artifact];
    }
    const previous = oldByName.get(artifact.logicalName);
    if (!previous) {
      return [];
    }
    return [{ ...artifact, pathParts: previous.pathParts, contentHash: previous.contentHash }];
  });
  for (const entry of entries) {
    if (entry.status === 'orphan') {
      nextManifest.artifacts.push(oldByName.get(entry.logicalName)!);
    }
  }
  await writeProjectFile(projectRoot, ['liftoff.manifest.json'], `${JSON.stringify(nextManifest, null, 2)}\n`);

  if (jsonMode) {
    context.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      mode: 'apply',
      cliVersion: liftoffVersion,
      projectVersion: manifest.liftoffVersion,
      written: written.map((entry) => manifestDisplayPath(entry.pathParts)),
      skipped: skipped.map((entry) => ({ path: manifestDisplayPath(entry.pathParts), reason: entry.reason })),
      summary
    }, null, 2)}\n`);
    return 0;
  }

  for (const entry of written) {
    context.stdout.write(`  wrote ${entryDisplay(entry)}\n`);
  }
  for (const entry of skipped) {
    context.stdout.write(`  skipped ${entryDisplay(entry)}  ${entry.reason}${force ? '' : ' (use --apply --force to overwrite)'}\n`);
  }
  for (const entry of entries) {
    if (entry.status === 'orphan') {
      context.stdout.write(`  orphan ${entryDisplay(entry)}  ${entry.reason}\n`);
    }
  }
  context.stdout.write(`Updated: ${written.length} written, ${skipped.length} skipped, ${summary.orphan} orphan(s). Manifest recorded at ${liftoffVersion}.\n`);
  return 0;
}

interface DoctorCheck {
  label: string;
  severity: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  remedy?: string;
}

interface DoctorLayer {
  title: string;
  checks: DoctorCheck[];
}

function binaryCheck(command: string, args: string[], remedy: string, cwd?: string): DoctorCheck {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status === 0) {
    return { label: command, severity: 'ok', detail: (result.stdout || result.stderr).split('\n')[0].trim() };
  }
  return { label: command, severity: 'fail', detail: 'not found', remedy };
}

function versionedBinaryCheck(
  label: string,
  command: string,
  args: string[],
  minimum: readonly [number, number],
  remedy: string
): DoctorCheck {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return { label, severity: 'fail', detail: 'not found', remedy };
  }

  const output = (result.stdout || result.stderr).split('\n')[0].trim();
  const match = output.match(/(\d+)\.(\d+)/);
  if (!match) {
    return { label, severity: 'fail', detail: `unable to determine version from "${output}"`, remedy };
  }
  const found: readonly [number, number] = [Number(match[1]), Number(match[2])];
  if (found[0] < minimum[0] || found[0] === minimum[0] && found[1] < minimum[1]) {
    return { label, severity: 'fail', detail: `${output} is below ${minimum.join('.')}`, remedy };
  }
  return { label, severity: 'ok', detail: output };
}

function pythonRuntime(): { command: string; versionArgs: string[]; commandArgs: string[] } | undefined {
  const candidates = process.platform === 'win32'
    ? [
      { command: 'py', versionArgs: ['-3', '--version'], commandArgs: ['-3'] },
      { command: 'python', versionArgs: ['--version'], commandArgs: [] },
      { command: 'python3', versionArgs: ['--version'], commandArgs: [] }
    ]
    : [
      { command: 'python3', versionArgs: ['--version'], commandArgs: [] },
      { command: 'python', versionArgs: ['--version'], commandArgs: [] }
    ];
  return candidates.find((candidate) =>
    versionedBinaryCheck('python', candidate.command, candidate.versionArgs, [3, 12], 'install Python 3.12 or newer').severity === 'ok'
  ) ?? candidates.find((candidate) => binaryPresent(candidate.command));
}

function environmentLayer(apiStack?: ApiStackId): DoctorLayer {
  const python = pythonRuntime();
  const runtimeChecks = apiStack === 'go-huma'
    ? [versionedBinaryCheck('go', 'go', ['version'], [1, 23], 'install Go 1.23 or newer')]
    : apiStack === 'node-fastify'
      ? []
      : [python
        ? versionedBinaryCheck('python', python.command, python.versionArgs, [3, 12], 'install Python 3.12 or newer')
        : { label: 'python', severity: 'fail' as const, detail: 'not found', remedy: 'install Python 3.12 or newer' }];
  return {
    title: 'Environment',
    checks: [
      versionedBinaryCheck('node', 'node', ['--version'], [20, 0], 'install Node.js 20 or newer'),
      ...runtimeChecks,
      binaryCheck('docker', ['--version'], 'install Docker'),
      binaryCheck('tofu', ['--version'], 'install OpenTofu')
    ]
  };
}

function stackProjectCheck(projectRoot: string, apiStack: ApiStackId): DoctorCheck {
  let result: { status: number | null; stdout: string; stderr: string };
  switch (apiStack) {
    case 'python-fastapi':
      {
        const python = pythonRuntime();
        if (!python) {
          return { label: 'python project', severity: 'skipped', detail: 'python is unavailable' };
        }
        result = runReadOnly(
          python.command,
          [...python.commandArgs, '-c', 'from pathlib import Path; p=Path("backend/apis/main.py"); compile(p.read_text(), str(p), "exec")'],
          projectRoot
        );
      }
      break;
    case 'node-fastify':
      result = runReadOnly(
        'node',
        ['-e', 'const f=require("fs"); JSON.parse(f.readFileSync("backend/package.json")); JSON.parse(f.readFileSync("backend/tsconfig.json"));'],
        projectRoot
      );
      break;
    case 'go-huma':
      if (!binaryPresent('go')) {
        return { label: 'go project', severity: 'skipped', detail: 'go is unavailable' };
      }
      result = runReadOnly('go', ['mod', 'edit', '-json'], path.join(projectRoot, 'backend'));
      break;
  }

  if (result.status === 0) {
    return { label: `${apiStack} project`, severity: 'ok', detail: 'stack configuration is valid' };
  }
  return {
    label: `${apiStack} project`,
    severity: 'fail',
    detail: (result.stderr || result.stdout || 'stack validation failed').split('\n')[0],
    remedy: `repair the generated ${apiStack} backend configuration`
  };
}

function runReadOnly(command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function binaryPresent(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { encoding: 'utf8' }).status === 0;
}

function azureCloudChecks(): DoctorCheck[] {
  if (!binaryPresent('az')) {
    return [{ label: 'az', severity: 'fail', detail: 'Azure CLI not found', remedy: 'install the Azure CLI' }];
  }
  const auth = spawnSync('az', ['account', 'show', '-o', 'none', '--only-show-errors'], { encoding: 'utf8' });
  if (auth.status === 0) {
    return [{ label: 'azure auth', severity: 'ok', detail: 'authenticated' }];
  }
  return [{ label: 'azure auth', severity: 'fail', detail: 'not authenticated', remedy: 'run az login' }];
}

// ponytail: provider-keyed map so aws/gcp checks slot in when their adapters land
const CLOUD_CHECKS: Record<string, () => DoctorCheck[]> = {
  azure: azureCloudChecks
};

function cloudLayer(cloud: string): DoctorLayer {
  const checks = CLOUD_CHECKS[cloud]
    ? CLOUD_CHECKS[cloud]()
    : [{ label: cloud, severity: 'skipped' as const, detail: `${cloud} provider checks are not available yet` }];
  return { title: `Cloud - ${cloud}`, checks };
}

async function lookupLatestPublishedVersion(): Promise<string | undefined> {
  const registry = process.env.LIFTOFF_REGISTRY ?? 'https://registry.npmjs.org';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${registry}/@msn-control%2fliftoff/latest`, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as { version?: string };
    return data.version;
  } catch {
    return undefined; // offline or unreachable: doctor stays quiet about freshness
  } finally {
    clearTimeout(timer);
  }
}

async function cliLayer(): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [
    { label: 'version', severity: 'ok', detail: `Liftoff ${liftoffVersion}` }
  ];
  const latest = await lookupLatestPublishedVersion();
  if (!latest) {
    return { title: 'CLI', checks };
  }

  if (compareSemver(latest, liftoffVersion) > 0) {
    checks.push({
      label: 'cli freshness',
      severity: 'warn',
      detail: `Liftoff ${latest} is published, this CLI is ${liftoffVersion}`,
      remedy: `install Liftoff ${latest} from an approved registry that exposes it; where direct public npm access is permitted: npm install -g @msn-control/liftoff@${latest} --registry=https://registry.npmjs.org`
    });
  } else {
    checks.push({
      label: 'cli freshness',
      severity: 'ok',
      detail: `running ${liftoffVersion}, latest stable ${latest}`
    });
  }
  return { title: 'CLI', checks };
}

async function projectLayer(projectRoot: string, manifest: LiftoffManifest): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [];

  const issues = await validateGeneratedProject(projectRoot);
  if (issues.length > 0) {
    checks.push({
      label: 'manifest',
      severity: 'fail',
      detail: `${issues.length} issue(s): ${issues[0]}${issues.length > 1 ? ' ...' : ''}`,
      remedy: 'restore missing artifacts or run liftoff update --apply'
    });
  } else {
    checks.push({ label: 'manifest', severity: 'ok', detail: `valid, ${manifest.artifacts.length} artifacts present` });
  }

  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    checks.push({
      label: 'version',
      severity: 'warn',
      detail: `project written by Liftoff ${manifest.liftoffVersion}, CLI is ${liftoffVersion}`,
      remedy: 'upgrade the CLI: npm install -g @msn-control/liftoff@latest'
    });
  } else {
    checks.push({ label: 'version', severity: 'ok', detail: `generated by ${manifest.liftoffVersion}, CLI ${liftoffVersion}` });
  }

  checks.push(stackProjectCheck(projectRoot, manifest.project.apiStack));

  try {
    const config = await loadConfigOptions('liftoff.config.json', projectRoot);
    const plan = buildProjectPlan(config, { requireProjectName: true });
    const render = buildArtifacts(plan);
    const entries = await reconcileProject(manifest, render, projectRoot);
    const driftCount = entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash).length;
    if (driftCount > 0) {
      checks.push({
        label: 'scaffold drift',
        severity: 'warn',
        detail: `${driftCount} update(s) available`,
        remedy: 'run liftoff update'
      });
    } else {
      checks.push({ label: 'scaffold drift', severity: 'ok', detail: 'project matches the current templates' });
    }
  } catch (error) {
    checks.push({
      label: 'scaffold drift',
      severity: 'fail',
      detail: `liftoff.config.json could not be evaluated: ${(error as Error).message.split('\n')[0]}`,
      remedy: 'repair liftoff.config.json'
    });
  }

  return { title: 'Project', checks };
}

async function runtimeLayer(projectRoot: string, dockerAvailable: boolean): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [];

  if (existsSync(path.join(projectRoot, '.env.example'))) {
    if (existsSync(path.join(projectRoot, '.env'))) {
      checks.push({ label: '.env', severity: 'ok', detail: 'present' });
    } else {
      checks.push({ label: '.env', severity: 'fail', detail: 'missing', remedy: 'copy .env.example to .env' });
    }
  } else {
    checks.push({ label: '.env', severity: 'skipped', detail: 'no .env.example in this project' });
  }

  if (!existsSync(path.join(projectRoot, 'docker-compose.yml'))) {
    checks.push({ label: 'compose', severity: 'skipped', detail: 'no docker-compose.yml in this project' });
  } else if (!dockerAvailable) {
    checks.push({ label: 'compose', severity: 'skipped', detail: 'docker is not installed, compose config not checked' });
  } else {
    const result = spawnSync('docker', ['compose', 'config', '-q'], { cwd: projectRoot, encoding: 'utf8' });
    if (result.status === 0) {
      checks.push({ label: 'compose', severity: 'ok', detail: 'docker compose config is valid' });
    } else {
      checks.push({
        label: 'compose',
        severity: 'fail',
        detail: (result.stderr || 'docker compose config failed').split('\n')[0],
        remedy: 'fix docker-compose.yml'
      });
    }
  }

  return { title: 'Runtime', checks };
}

const severityMarker: Record<DoctorCheck['severity'], string> = {
  ok: '[ok]',
  warn: '[warn]',
  fail: '[fail]',
  skipped: '[skip]'
};

function renderDoctorLayers(layers: DoctorLayer[], stream: NodeJS.WritableStream): void {
  for (const layer of layers) {
    stream.write(`${layer.title}\n`);
    for (const check of layer.checks) {
      const remedy = check.remedy ? ` - ${check.remedy}` : '';
      stream.write(`  ${severityMarker[check.severity].padEnd(6)} ${check.label}: ${check.detail}${remedy}\n`);
    }
  }
}

export function doctorExitCode(layers: DoctorLayer[]): number {
  return layers.some((layer) => layer.checks.some((check) => check.severity === 'fail')) ? 1 : 0;
}

async function doctorCommand(parsed: ParsedArgs, context: CommandContext): Promise<number> {
  const jsonMode = readBooleanFlag(parsed.flags, 'json') ?? false;
  const cloudOverride = readStringFlag(parsed.flags, 'cloud');
  const layers: DoctorLayer[] = [];

  const projectRoot = await findProjectRoot(context.cwd);
  let manifest: LiftoffManifest | undefined;
  let manifestError: Error | undefined;
  if (projectRoot) {
    try {
      manifest = await loadManifest(projectRoot);
    } catch (error) {
      manifestError = error as Error;
    }
  }

  layers.push(await cliLayer());
  const environment = environmentLayer(manifest?.project.apiStack);
  layers.push(environment);
  const dockerAvailable = environment.checks.some((check) => check.label === 'docker' && check.severity === 'ok');

  if (projectRoot) {
    if (manifestError) {
      layers.push({
        title: 'Project',
        checks: [{ label: 'manifest', severity: 'fail', detail: manifestError.message, remedy: 'regenerate the project or use a matching CLI version' }]
      });
    }

    if (manifest) {
      layers.push(await projectLayer(projectRoot, manifest));
      layers.push(await runtimeLayer(projectRoot, dockerAvailable));

      const cloud = cloudOverride ?? manifest.project.cloud;
      const cloudChecks = cloudLayer(cloud);
      const pattern = patterns.find((candidate) => candidate.id === manifest.project.pattern);
      if (pattern?.worker && cloud === 'azure') {
        cloudChecks.checks.push(
          binaryPresent('func')
            ? { label: 'functions tooling', severity: 'ok', detail: 'Azure Functions Core Tools installed' }
            : { label: 'functions tooling', severity: 'warn', detail: 'Azure Functions Core Tools not found', remedy: 'npm install -g azure-functions-core-tools@4' }
        );
      }
      layers.push(cloudChecks);
    }
  } else if (cloudOverride) {
    layers.push(cloudLayer(cloudOverride));
  }

  const failures = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'fail').length, 0);
  const warnings = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'warn').length, 0);

  if (jsonMode) {
    context.stdout.write(`${JSON.stringify({ schemaVersion: 1, layers, summary: { failures, warnings } }, null, 2)}\n`);
  } else {
    renderDoctorLayers(layers, context.stdout);
    context.stdout.write(`${failures} failure(s), ${warnings} warning(s)\n`);
  }

  return doctorExitCode(layers);
}

function helperCommand(parsed: ParsedArgs, context: CommandContext, tool: 'docker compose' | 'tofu'): number {
  const command = parsed.command === 'dev' ? buildDevCommand(parsed) : buildInfraCommand(parsed);
  context.stdout.write(`${tool} helper command:\n${command}\n`);
  return 0;
}

function buildDevCommand(parsed: ParsedArgs): string {
  switch (parsed.subcommand) {
    case 'down':
      return 'docker compose down';
    case 'logs':
      return 'docker compose logs -f';
    case 'reset':
      return 'docker compose down --volumes';
    case 'up':
    default: {
      const profile = readStringFlag(parsed.flags, 'profile');
      return profile ? `docker compose --profile ${profile} up --build` : 'docker compose up --build';
    }
  }
}

function buildInfraCommand(parsed: ParsedArgs): string {
  const env = readStringFlag(parsed.flags, 'env') ?? 'dev';
  switch (parsed.subcommand) {
    case 'apply':
      return `tofu apply -var-file=environments/${env}.tfvars`;
    case 'output':
      return 'tofu output';
    case 'init':
      return 'tofu init';
    case 'plan':
    default:
      return `tofu plan -var-file=environments/${env}.tfvars`;
  }
}

async function optionsFromParsedArgs(parsed: ParsedArgs, cwd: string, includeProjectName: boolean): Promise<ProjectOptions> {
  const configPath = readStringFlag(parsed.flags, 'config');
  const configOptions = configPath ? await loadConfigOptions(configPath, cwd) : {};
  const flagOptions: ProjectOptions = {
    projectName: includeProjectName ? parsed.positional[0] ?? readStringFlag(parsed.flags, 'project') : readStringFlag(parsed.flags, 'project'),
    projectType: readBooleanFlag(parsed.flags, 'genai') === undefined
      ? undefined
      : readBooleanFlag(parsed.flags, 'genai') ? 'genai' : 'standard',
    apiStack: readStringFlag(parsed.flags, 'api'),
    pattern: readStringFlag(parsed.flags, 'pattern'),
    cloud: readStringFlag(parsed.flags, 'cloud'),
    region: readStringFlag(parsed.flags, 'region'),
    includeFrontend: readBooleanFlag(parsed.flags, 'frontend'),
    environments: readListFlag(parsed.flags, 'environments'),
    specWorkflow: readStringFlag(parsed.flags, 'spec'),
    configPath,
    yes: readBooleanFlag(parsed.flags, 'yes') ?? false
  };

  return mergeOptions(configOptions, flagOptions);
}

function hasMissingCreateInputs(options: ProjectOptions): boolean {
  const projectType = options.projectType ?? (options.pattern ? 'genai' : options.apiStack ? 'standard' : undefined);
  const missingTypeSpecific = projectType === 'genai' ? !options.pattern : projectType === 'standard' ? !options.apiStack : true;
  return !options.projectName || missingTypeSpecific || !options.cloud || options.includeFrontend === undefined || !options.specWorkflow || !options.environments;
}

function printHelp(stream: NodeJS.WritableStream): void {
  stream.write(`Mission Control Liftoff ${liftoffVersion}\n\n`);
  stream.write(`Global options:\n`);
  stream.write(`  --version   Show the installed Liftoff version\n`);
  stream.write(`  --help      Show general help\n\n`);
  stream.write(`Commands:\n`);
  stream.write(`  create      Generate a new project\n`);
  stream.write(`  plan        Preview generated artifacts\n`);
  stream.write(`  patterns    List GenAI patterns\n`);
  stream.write(`  providers   List cloud providers\n`);
  stream.write(`  regions     List or search provider regions\n`);
  stream.write(`  validate    Validate a generated project manifest\n`);
  stream.write(`  update      Reconcile a project with the current templates (check by default; --apply, --force)\n`);
  stream.write(`  migrate     Adopt an existing project: fresh scaffold + staged copy + migration plan\n`);
  stream.write(`  doctor      Check local readiness\n`);
  stream.write(`  dev         Print Docker Compose helper commands\n`);
  stream.write(`  infra       Print OpenTofu helper commands\n`);
  stream.write(`\nProject types: GenAI (Python/FastAPI/PydanticAI) or standard API\n`);
  stream.write(`Standard API stacks: ${apiStacks.map((stack) => stack.label).join(', ')}\n`);
}

export async function createFixtureProject(options: ProjectOptions): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-'));
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const target = artifactPath(tempRoot, [plan.safeProjectName]);
  await mkdir(target, { recursive: true });
  await assertNewOrEmptyDirectory(target);
  await rm(target, { recursive: true, force: true });
  await writeArtifacts(target, buildArtifacts(plan));
  return target;
}