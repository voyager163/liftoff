import { readdir, readFile } from 'node:fs/promises';
import {
  loadManifest,
  resolveProjectPath,
  writeProjectFile
} from '../file-system.js';
import { getPattern } from '../catalogs.js';
import { toSafeProjectName } from '../planner.js';
import type { CommandResult, CommandRunner } from '../process-runner.js';
import { formatCommand } from '../process-runner.js';
import type {
  ExternalCommand,
  LiftoffManifest,
  ManifestWorkload
} from '../types.js';

export type SeedBaselineCheckId =
  | 'liftoff-validate'
  | 'backend-tests'
  | 'worker-tests'
  | 'frontend-build'
  | 'docker-compose-config'
  | 'tofu-fmt'
  | 'tofu-init'
  | 'tofu-validate'
  | 'openspec-strict';

export type SeedBaselineCheckApplicability =
  | { applicable: true; command: ExternalCommand; cwdPathParts: readonly string[] }
  | { applicable: false; reason: string };

export interface SeedBaselineCheck {
  id: SeedBaselineCheckId;
  taskId: string;
  label: string;
  applicability: SeedBaselineCheckApplicability;
}

export type SeedBaselineCheckOutcome =
  | {
      id: SeedBaselineCheckId;
      taskId: string;
      label: string;
      status: 'passed';
      command: ExternalCommand;
      cwdPathParts: readonly string[];
      result: CommandResult;
    }
  | {
      id: SeedBaselineCheckId;
      taskId: string;
      label: string;
      status: 'failed';
      command: ExternalCommand;
      cwdPathParts: readonly string[];
      result: CommandResult;
      detail: string;
    }
  | {
      id: SeedBaselineCheckId;
      taskId: string;
      label: string;
      status: 'inapplicable';
      reason: string;
    };

export type GeneratedSeedDiscovery =
  | {
      state: 'active';
      changeName: string;
      changePathParts: readonly string[];
      capabilityId: string;
    }
  | { state: 'archived'; changeName: string; detail: string }
  | { state: 'blocked'; changeName: string; issues: readonly string[] };

export type GeneratedSeedLifecycleResult =
  | {
      status: 'archived';
      changeName: string;
      capabilityId: string;
      checks: readonly SeedBaselineCheckOutcome[];
      archive: CommandResult;
      archiveSyncBehavior: string;
    }
  | {
      status: 'blocked';
      changeName: string;
      issues: readonly string[];
      checks: readonly SeedBaselineCheckOutcome[];
    }
  | {
      status: 'already-archived';
      changeName: string;
      detail: string;
    };

export type SeedPhaseValidationResult =
  | { status: 'passed'; changeName: string; capabilityId?: string; command?: CommandResult; detail: string }
  | { status: 'blocked'; changeName: string; issues: readonly string[] };

export type SeedPhaseVerificationResult =
  | { status: 'passed'; changeName: string; checks: readonly SeedBaselineCheckOutcome[] }
  | { status: 'blocked'; changeName: string; issues: readonly string[]; checks: readonly SeedBaselineCheckOutcome[] };

export type SeedPhaseArchiveResult =
  | {
      status: 'archived' | 'already-archived';
      changeName: string;
      capabilityId?: string;
      archive?: CommandResult;
      archiveSyncBehavior?: string;
      detail: string;
    }
  | { status: 'blocked'; changeName: string; issues: readonly string[] };

const seedChangePathParts = (changeName: string) => ['openspec', 'changes', changeName] as const;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function generatedSeedChangeName(manifest: LiftoffManifest): string {
  return `bootstrap-${toSafeProjectName(manifest.project.name)}`;
}

export function generatedSeedCapabilityId(workload: ManifestWorkload): string {
  if (workload.kind === 'power-apps-code-app') {
    return 'power-apps-code-app-baseline';
  }
  if (workload.kind === 'standard') {
    return `${workload.apiStack}-application-baseline`;
  }
  return `${workload.pattern}-application-baseline`;
}

function isWorkerWorkload(workload: ManifestWorkload): workload is Extract<ManifestWorkload, { kind: 'genai' }> {
  return workload.kind === 'genai' && getPattern(workload.pattern)?.worker === true;
}

export function selectSeedBaselineChecks(
  manifest: LiftoffManifest,
  changeName = generatedSeedChangeName(manifest)
): SeedBaselineCheck[] {
  const workload = manifest.project.workload;
  const checks: SeedBaselineCheck[] = [
    {
      id: 'liftoff-validate',
      taskId: '2.1',
      label: 'Run Liftoff manifest validation',
      applicability: {
        applicable: true,
        command: { executable: 'liftoff', args: ['validate'] },
        cwdPathParts: []
      }
    }
  ];

  if (workload.kind === 'power-apps-code-app') {
    checks.push({
      id: 'backend-tests',
      taskId: '2.2',
      label: 'Record backend tests as inapplicable',
      applicability: {
        applicable: false,
        reason: 'no Liftoff backend is generated for Power Apps code apps'
      }
    });
  } else if (workload.kind === 'genai' || workload.apiStack === 'python-fastapi') {
    checks.push({
      id: 'backend-tests',
      taskId: '2.2',
      label: 'Run backend tests',
      applicability: {
        applicable: true,
        command: { executable: 'uv', args: ['run', '--project', 'backend', 'python', '-m', 'pytest', '-q', 'backend/tests'] },
        cwdPathParts: []
      }
    });
  } else if (workload.apiStack === 'node-fastify') {
    checks.push({
      id: 'backend-tests',
      taskId: '2.2',
      label: 'Run backend tests',
      applicability: {
        applicable: true,
        command: { executable: 'npm', args: ['test'] },
        cwdPathParts: ['backend']
      }
    });
  } else {
    checks.push({
      id: 'backend-tests',
      taskId: '2.2',
      label: 'Run backend tests',
      applicability: {
        applicable: true,
        command: { executable: 'go', args: ['test', './...'] },
        cwdPathParts: ['backend']
      }
    });
  }

  if (isWorkerWorkload(workload)) {
    checks.push({
      id: 'worker-tests',
      taskId: '2.3',
      label: 'Run generated worker tests',
      applicability: {
        applicable: true,
        command: { executable: 'uv', args: ['run', '--project', '../../backend', '--directory', '.', 'python', '-m', 'pytest', '-q'] },
        cwdPathParts: ['functions', `${workload.pattern}-worker`]
      }
    });
  } else {
    checks.push({
      id: 'worker-tests',
      taskId: '2.3',
      label: 'Record worker tests as inapplicable',
      applicability: {
        applicable: false,
        reason: 'no generated worker boundary is present'
      }
    });
  }

  if (workload.kind === 'power-apps-code-app') {
    checks.push({
      id: 'frontend-build',
      taskId: '2.4',
      label: 'Run frontend build',
      applicability: {
        applicable: true,
        command: { executable: 'npm', args: ['run', 'build'] },
        cwdPathParts: []
      }
    });
  } else if (workload.frontend) {
    checks.push({
      id: 'frontend-build',
      taskId: '2.4',
      label: 'Run frontend build',
      applicability: {
        applicable: true,
        command: { executable: 'npm', args: ['run', 'build'] },
        cwdPathParts: ['frontend']
      }
    });
  } else {
    checks.push({
      id: 'frontend-build',
      taskId: '2.4',
      label: 'Record frontend build as inapplicable',
      applicability: {
        applicable: false,
        reason: 'no generated frontend is present'
      }
    });
  }

  if (workload.kind === 'power-apps-code-app') {
    for (const [id, taskId, label] of [
      ['docker-compose-config', '2.5', 'Record Docker Compose validation as inapplicable'],
      ['tofu-fmt', '2.6', 'Record OpenTofu formatting as inapplicable'],
      ['tofu-init', '2.7', 'Record OpenTofu initialization as inapplicable'],
      ['tofu-validate', '2.8', 'Record OpenTofu validation as inapplicable']
    ] as const) {
      checks.push({
        id,
        taskId,
        label,
        applicability: {
          applicable: false,
          reason: id === 'docker-compose-config'
            ? 'no generated Docker Compose boundary is present'
            : 'no generated OpenTofu boundary is present'
        }
      });
    }
  } else {
    checks.push(
      {
        id: 'docker-compose-config',
        taskId: '2.5',
        label: 'Validate Docker Compose configuration without startup',
        applicability: {
          applicable: true,
          command: { executable: 'docker', args: ['compose', 'config', '-q'] },
          cwdPathParts: []
        }
      },
      {
        id: 'tofu-fmt',
        taskId: '2.6',
        label: 'Check OpenTofu formatting',
        applicability: {
          applicable: true,
          command: { executable: 'tofu', args: ['fmt', '-check', '-recursive'] },
          cwdPathParts: ['infrastructure', 'opentofu', 'azure']
        }
      },
      {
        id: 'tofu-init',
        taskId: '2.7',
        label: 'Initialize OpenTofu without a remote backend',
        applicability: {
          applicable: true,
          command: { executable: 'tofu', args: ['init', '-backend=false'] },
          cwdPathParts: ['infrastructure', 'opentofu', 'azure']
        }
      },
      {
        id: 'tofu-validate',
        taskId: '2.8',
        label: 'Validate OpenTofu configuration without plan or apply',
        applicability: {
          applicable: true,
          command: { executable: 'tofu', args: ['validate'] },
          cwdPathParts: ['infrastructure', 'opentofu', 'azure']
        }
      }
    );
  }

  checks.push({
    id: 'openspec-strict',
    taskId: '2.9',
    label: 'Run strict OpenSpec validation',
    applicability: {
      applicable: true,
      command: { executable: 'openspec', args: ['validate', changeName, '--strict'] },
      cwdPathParts: []
    }
  });

  return checks;
}

function extractDeclaredCapabilities(proposal: string): string[] {
  const capabilities: string[] = [];
  const lines = proposal.split(/\r?\n/);
  let inNewCapabilities = false;
  for (const line of lines) {
    if (/^###\s+New Capabilities\s*$/i.test(line.trim())) {
      inNewCapabilities = true;
      continue;
    }
    if (inNewCapabilities && /^###\s+/.test(line.trim())) {
      break;
    }
    if (!inNewCapabilities) {
      continue;
    }
    const match = line.match(/^\s*-\s+`([^`]+)`:/);
    if (match) {
      capabilities.push(match[1]!);
    }
  }
  return capabilities;
}

async function readRequiredProjectText(projectRoot: string, pathParts: readonly string[]): Promise<string> {
  const filePath = await resolveProjectPath(projectRoot, [...pathParts]);
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new Error(`Missing required seed artifact ${pathParts.join('/')}.`);
    }
    throw new Error(`Unable to read seed artifact ${pathParts.join('/')}: ${errorMessage(error)}.`);
  }
}

async function activeBootstrapChanges(projectRoot: string): Promise<string[]> {
  const changesRoot = await resolveProjectPath(projectRoot, ['openspec', 'changes']);
  let entries;
  try {
    entries = await readdir(changesRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to inspect openspec/changes: ${errorMessage(error)}.`);
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('bootstrap-') && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort();
}

async function archivedBootstrapChangeExists(projectRoot: string, changeName: string): Promise<boolean> {
  const archiveRoot = await resolveProjectPath(projectRoot, ['openspec', 'changes', 'archive']);
  let entries;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw new Error(`Unable to inspect openspec/changes/archive: ${errorMessage(error)}.`);
  }
  return entries.some((entry) => entry.isDirectory() && entry.name.endsWith(changeName));
}

export async function discoverGeneratedSeed(projectRoot: string): Promise<GeneratedSeedDiscovery> {
  const manifest = await loadManifest(projectRoot);
  const changeName = generatedSeedChangeName(manifest);
  if (manifest.project.specWorkflow !== 'openspec') {
    return {
      state: 'blocked',
      changeName,
      issues: ['The generated project does not use OpenSpec, so no OpenSpec bootstrap seed can be completed.']
    };
  }

  const active = await activeBootstrapChanges(projectRoot);
  if (active.length === 0) {
    if (await archivedBootstrapChangeExists(projectRoot, changeName)) {
      return {
        state: 'archived',
        changeName,
        detail: 'The generated bootstrap seed is already archived.'
      };
    }
    return {
      state: 'blocked',
      changeName,
      issues: [`Generated seed ${changeName} is absent from openspec/changes and not archived.`]
    };
  }
  if (active.length !== 1 || active[0] !== changeName) {
    return {
      state: 'blocked',
      changeName,
      issues: [`Expected exactly active generated seed ${changeName}; found ${active.join(', ')}.`]
    };
  }

  const changePathParts = seedChangePathParts(changeName);
  const issues: string[] = [];
  let proposal = '';
  for (const artifact of ['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md'] as const) {
    try {
      const content = await readRequiredProjectText(projectRoot, [...changePathParts, artifact]);
      if (artifact === 'proposal.md') {
        proposal = content;
      }
    } catch (error) {
      issues.push(errorMessage(error));
    }
  }

  const declaredCapabilities = proposal ? extractDeclaredCapabilities(proposal) : [];
  if (declaredCapabilities.length !== 1) {
    issues.push(
      `Expected exactly one proposal-declared bootstrap capability; found ${declaredCapabilities.length}.`
    );
  }
  const expectedCapability = generatedSeedCapabilityId(manifest.project.workload);
  const capabilityId = declaredCapabilities[0] ?? expectedCapability;
  if (capabilityId !== expectedCapability) {
    issues.push(
      `Proposal declares ${capabilityId}, but manifest workload requires ${expectedCapability}.`
    );
  }
  try {
    await readRequiredProjectText(projectRoot, [...changePathParts, 'specs', capabilityId, 'spec.md']);
  } catch (error) {
    issues.push(errorMessage(error));
  }

  if (issues.length > 0) {
    return { state: 'blocked', changeName, issues };
  }
  return { state: 'active', changeName, changePathParts, capabilityId };
}

function checkFailureDetail(result: CommandResult): string {
  if (result.timedOut) {
    return 'command timed out';
  }
  if (result.errorCode || result.errorMessage) {
    return [result.errorCode, result.errorMessage].filter(Boolean).join(': ');
  }
  return `exit status ${result.status ?? 'unknown'}`;
}

async function runSeedBaselineCheck(
  projectRoot: string,
  runner: CommandRunner,
  check: SeedBaselineCheck
): Promise<SeedBaselineCheckOutcome> {
  if (!check.applicability.applicable) {
    return {
      id: check.id,
      taskId: check.taskId,
      label: check.label,
      status: 'inapplicable',
      reason: check.applicability.reason
    };
  }
  const cwd = check.applicability.cwdPathParts.length === 0
    ? projectRoot
    : await resolveProjectPath(projectRoot, [...check.applicability.cwdPathParts]);
  const result = await runner.run(check.applicability.command, { cwd });
  if (result.status === 0 && !result.timedOut && !result.errorCode) {
    return {
      id: check.id,
      taskId: check.taskId,
      label: check.label,
      status: 'passed',
      command: check.applicability.command,
      cwdPathParts: check.applicability.cwdPathParts,
      result
    };
  }
  return {
    id: check.id,
    taskId: check.taskId,
    label: check.label,
    status: 'failed',
    command: check.applicability.command,
    cwdPathParts: check.applicability.cwdPathParts,
    result,
    detail: checkFailureDetail(result)
  };
}

export async function runSeedBaselineChecks(
  projectRoot: string,
  runner: CommandRunner,
  checks: readonly SeedBaselineCheck[]
): Promise<SeedBaselineCheckOutcome[]> {
  const outcomes: SeedBaselineCheckOutcome[] = [];
  for (const check of checks) {
    const outcome = await runSeedBaselineCheck(projectRoot, runner, check);
    outcomes.push(outcome);
  }
  return outcomes;
}

function checkboxPattern(taskId: string): RegExp {
  return new RegExp(`^(\\s*-\\s+\\[)([ xX])(\\]\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s.*)$`);
}

export function markSuccessfulSeedTasks(markdown: string, outcomes: readonly SeedBaselineCheckOutcome[]): string {
  const successfulTaskIds = new Set([
    '1.1',
    '1.2',
    ...outcomes
      .filter((outcome) => outcome.status === 'passed' || outcome.status === 'inapplicable')
      .map((outcome) => outcome.taskId),
    '3.1'
  ]);
  const lines = markdown.split('\n');
  for (const taskId of successfulTaskIds) {
    const pattern = checkboxPattern(taskId);
    const matches = lines
      .map((line, index) => ({ line, index, match: line.match(pattern) }))
      .filter((entry): entry is { line: string; index: number; match: RegExpMatchArray } => entry.match !== null);
    if (matches.length !== 1) {
      throw new Error(`Seed task ${taskId} must appear exactly once before completion; found ${matches.length}.`);
    }
    const [match] = matches;
    lines[match.index] = `${match.match[1]}x${match.match[3]}`;
  }
  return lines.join('\n');
}

export function markAllSeedTasksForArchive(markdown: string): string {
  const taskIds = [
    '1.1',
    '1.2',
    '2.1',
    '2.2',
    '2.3',
    '2.4',
    '2.5',
    '2.6',
    '2.7',
    '2.8',
    '2.9',
    '3.1'
  ];
  const lines = markdown.split('\n');
  for (const taskId of taskIds) {
    const pattern = checkboxPattern(taskId);
    const matches = lines
      .map((line, index) => ({ line, index, match: line.match(pattern) }))
      .filter((entry): entry is { line: string; index: number; match: RegExpMatchArray } => entry.match !== null);
    if (matches.length === 0) {
      continue;
    }
    if (matches.length > 1) {
      throw new Error(`Seed task ${taskId} must appear at most once before archive; found ${matches.length}.`);
    }
    const [match] = matches;
    lines[match.index] = `${match.match[1]}x${match.match[3]}`;
  }
  return lines.join('\n');
}

export async function validateGeneratedSeedForPhase(
  projectRoot: string,
  runner: CommandRunner
): Promise<SeedPhaseValidationResult> {
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'archived') {
    return {
      status: 'passed',
      changeName: discovery.changeName,
      detail: discovery.detail
    };
  }
  if (discovery.state === 'blocked') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: discovery.issues
    };
  }
  const command = { executable: 'openspec', args: ['validate', discovery.changeName, '--strict'] };
  const result = await runner.run(command, { cwd: projectRoot });
  if (result.status !== 0 || result.timedOut || result.errorCode) {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: [
        `OpenSpec strict validation failed: ${formatCommand(command)} (${checkFailureDetail(result)}).`
      ]
    };
  }
  return {
    status: 'passed',
    changeName: discovery.changeName,
    capabilityId: discovery.capabilityId,
    command: result,
    detail: 'Generated seed artifacts are present and strict-valid.'
  };
}

export async function verifyGeneratedSeedBaselineForPhase(
  projectRoot: string,
  runner: CommandRunner
): Promise<SeedPhaseVerificationResult> {
  const manifest = await loadManifest(projectRoot);
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'blocked') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: discovery.issues,
      checks: []
    };
  }
  const checks = selectSeedBaselineChecks(manifest, discovery.changeName);
  const outcomes = await runSeedBaselineChecks(projectRoot, runner, checks);
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  if (failures.length > 0) {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: failures.map((failure) =>
        `${failure.label} failed: ${formatCommand(failure.command)} (${failure.detail})`
      ),
      checks: outcomes
    };
  }
  return { status: 'passed', changeName: discovery.changeName, checks: outcomes };
}

export async function archiveGeneratedSeedForPhase(
  projectRoot: string,
  runner: CommandRunner
): Promise<SeedPhaseArchiveResult> {
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'archived') {
    return {
      status: 'already-archived',
      changeName: discovery.changeName,
      detail: discovery.detail
    };
  }
  if (discovery.state === 'blocked') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: discovery.issues
    };
  }

  const taskPathParts = [...discovery.changePathParts, 'tasks.md'];
  const originalTasks = await readRequiredProjectText(projectRoot, taskPathParts);
  const completedTasks = markAllSeedTasksForArchive(originalTasks);
  await writeProjectFile(projectRoot, taskPathParts, completedTasks);

  const archiveCommand = { executable: 'openspec', args: ['archive', discovery.changeName, '--yes', '--json'] };
  const archive = await runner.run(archiveCommand, { cwd: projectRoot });
  if (archive.status !== 0 || archive.timedOut || archive.errorCode) {
    await writeProjectFile(projectRoot, taskPathParts, originalTasks);
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: [
        `OpenSpec archive failed: ${formatCommand(archiveCommand)} (${checkFailureDetail(archive)}). ` +
          'Seed tasks were restored and the seed remains active.'
      ]
    };
  }
  return {
    status: 'archived',
    changeName: discovery.changeName,
    capabilityId: discovery.capabilityId,
    archive,
    archiveSyncBehavior: 'OpenSpec archive updates main specs as part of archive; the lifecycle engine intentionally never passes --skip-specs.',
    detail: 'Generated seed was archived after prior seed validation and baseline verification evidence.'
  };
}

export async function completeGeneratedSeedLifecycle(
  projectRoot: string,
  runner: CommandRunner
): Promise<GeneratedSeedLifecycleResult> {
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'archived') {
    return {
      status: 'already-archived',
      changeName: discovery.changeName,
      detail: discovery.detail
    };
  }
  if (discovery.state === 'blocked') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: discovery.issues,
      checks: []
    };
  }

  const verification = await verifyGeneratedSeedBaselineForPhase(projectRoot, runner);
  if (verification.status === 'blocked') {
    return {
      status: 'blocked',
      changeName: verification.changeName,
      issues: verification.issues,
      checks: verification.checks
    };
  }

  const archive = await archiveGeneratedSeedForPhase(projectRoot, runner);
  if (archive.status === 'blocked') {
    return {
      status: 'blocked',
      changeName: archive.changeName,
      issues: archive.issues,
      checks: verification.checks
    };
  }

  return {
    status: 'archived',
    changeName: archive.changeName,
    capabilityId: archive.capabilityId ?? discovery.capabilityId,
    checks: verification.checks,
    archive: archive.archive!,
    archiveSyncBehavior: archive.archiveSyncBehavior!
  };
}
