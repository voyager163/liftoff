import { lstat, readdir, readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { loadManifest } from '../application/project/manifest.js';
import { readProjectFile, writeProjectFile } from '../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import { captureProjectFileSnapshot, type ProjectFileMutation, type ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { withProjectMutationLock, type ProjectMutationLease } from '../adapters/filesystem/project-lock.js';
import { completedSpecKitTasks, inspectSpecKitBootstrap, specKitBootstrapId, specKitBootstrapPath } from './spec-kit-seed.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome } from './transition-ports.js';
import { getPattern } from '../application/project/catalog.js';
import { toSafeProjectName } from '../domain/project/planning.js';
import { assessInfrastructureLayout } from '../domain/project/infrastructure-layout.js';
import type { CommandResult, CommandRunner } from '../process-runner.js';
import { formatCommand } from '../process-runner.js';
import { detectCredentialLeaks } from './credentials.js';
import type { TransitionOperation } from '../domain/governance/activation/types.js';
import type {
  ExternalCommand,
  LiftoffManifest,
  ManifestWorkload
} from '../domain/project/contracts.js';

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
  | { applicable: true; command: ExternalCommand; cwdPathParts: readonly string[]; env?: Readonly<Record<string, string>> }
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
      env?: Readonly<Record<string, string>>;
      result: CommandResult;
    }
  | {
      id: SeedBaselineCheckId;
      taskId: string;
      label: string;
      status: 'failed';
      command: ExternalCommand;
      cwdPathParts: readonly string[];
      env?: Readonly<Record<string, string>>;
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

export type ArchivedSeedIntegrity =
  | { status: 'not-applicable' | 'not-archived'; changeName: string; issues: readonly [] }
  | { status: 'valid'; changeName: string; capabilityId: string; contentDigest: string; issues: readonly [] }
  | { status: 'invalid'; changeName: string; capabilityId: string; issues: readonly string[] };

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
  | { status: 'passed'; changeName: string; checks: readonly SeedBaselineCheckOutcome[]; fileMutations?: readonly ProjectFileMutation[]; filePreconditions?: readonly ProjectFileSnapshot[] }
  | { status: 'blocked'; changeName: string; issues: readonly string[]; checks: readonly SeedBaselineCheckOutcome[] };

export type SeedPhaseArchiveResult =
  | {
      status: 'archived' | 'already-archived';
      changeName: string;
      capabilityId?: string;
      archive?: CommandResult;
      archiveSyncBehavior?: string;
      detail: string;
      synchronizedSpecDigest?: string;
      validation?: CommandResult;
    }
  | {
      status: 'blocked';
      changeName: string;
      issues: readonly string[];
      retryableAfterRepair?: boolean;
      archiveCompleted?: boolean;
    };

export type LocalSeedPhaseId = 'seed-valid' | 'seed-verified' | 'seed-archived';

export interface LocalSeedCommand {
  command: ExternalCommand;
  cwdPathParts: readonly string[];
  env: Readonly<Record<string, string>>;
}

export interface LocalSeedPhasePreview {
  phaseId: LocalSeedPhaseId;
  operation: TransitionOperation;
  commands: readonly LocalSeedCommand[];
  blockers: readonly string[];
}

interface SeedExecutionOptions {
  localRevalidation?: boolean;
}

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
  if (manifest.project.specWorkflow === 'spec-kit') return specKitBootstrapId;
  return `bootstrap-${toSafeProjectName(manifest.project.name)}`;
}

export function generatedSeedCapabilityId(workload: ManifestWorkload): string {
  if (workload.kind === 'standard') {
    return `${workload.apiStack}-application-baseline`;
  }
  return `${workload.pattern}-application-baseline`;
}

function isWorkerWorkload(workload: ManifestWorkload): workload is Extract<ManifestWorkload, { kind: 'genai' }> {
  return workload.kind === 'genai' && getPattern(workload.pattern)?.worker === true;
}

export function seedInfrastructureBaselineBlocker(manifest: LiftoffManifest): string | undefined {
  const layout = assessInfrastructureLayout(manifest);
  return layout.kind === 'independent' ? undefined :
    `Infrastructure layout migration-required (${layout.kind}): ${layout.reason} ` +
      'No baseline infrastructure recipe is available; existing roots and state are not moved or initialized.';
}

export function selectSeedBaselineChecks(
  manifest: LiftoffManifest,
  changeName = generatedSeedChangeName(manifest),
  seedState: 'active' | 'archived' = 'active',
  options: SeedExecutionOptions = {}
): SeedBaselineCheck[] {
  const layoutBlocker = seedInfrastructureBaselineBlocker(manifest);
  if (layoutBlocker) throw new Error(layoutBlocker);
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

  if (workload.kind === 'genai' || workload.apiStack === 'python-fastapi') {
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

  if (workload.frontend) {
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

  {
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
    applicability: manifest.project.specWorkflow === 'spec-kit' ? {
      applicable: false,
      reason: 'Spec Kit validates its real bootstrap bundle and official markers locally; OpenSpec is inapplicable.'
    } : {
      applicable: true,
      command: {
        executable: 'openspec',
        args: seedState === 'archived'
          ? ['validate', '--all', '--strict']
          : ['validate', changeName, '--strict']
      },
      cwdPathParts: []
    }
  });

  const environmentChecks = manifest.project.workload.environments.flatMap((environment, index): SeedBaselineCheck[] => {
    const cwdPathParts = ['infrastructure', 'opentofu', 'azure', 'environments', environment];
    return [
      { id: 'tofu-init', taskId: `2.7.${index + 1}`, label: `Initialize ${environment} OpenTofu without a backend`, applicability: {
        applicable: true, command: { executable: 'tofu', args: ['init', '-backend=false'] }, cwdPathParts
      } },
      { id: 'tofu-validate', taskId: `2.8.${index + 1}`, label: `Validate ${environment} OpenTofu without plan or apply`, applicability: {
        applicable: true, command: { executable: 'tofu', args: ['validate'] }, cwdPathParts
      } }
    ];
  });
  const firstInit = checks.findIndex((check) => check.id === 'tofu-init');
  const selected = [...checks.slice(0, firstInit), ...environmentChecks, ...checks.slice(firstInit + 2)];
  if (!options.localRevalidation) return selected;
  return selected.filter((check) => check.id !== 'tofu-init').map((check) => {
    if (!check.applicability.applicable) return check;
    const applicability = check.applicability;
    const command = applicability.command;
    if (command.executable === 'uv') return {
      ...check,
      applicability: {
        ...applicability,
        command: { executable: 'uv', args: ['run', '--no-sync', '--offline', ...command.args.slice(1)] },
        env: { UV_PYTHON_DOWNLOADS: 'never' }
      }
    };
    if (command.executable === 'go') return {
      ...check,
      applicability: {
        ...applicability,
        command: { executable: 'go', args: ['test', '-mod=readonly', './...'] },
        env: { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GONOPROXY: 'none', GOVCS: '*:off', GOFLAGS: '', GOWORK: 'off' }
      }
    };
    if (command.executable === 'npm') return {
      ...check,
      applicability: {
        ...applicability,
        command: { executable: 'npm', args: ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...command.args] },
        env: { npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' }
      }
    };
    if (command.executable === 'tofu') return {
      ...check,
      label: check.id === 'tofu-validate'
        ? `Observe already initialized OpenTofu at ${applicability.cwdPathParts.join('/')} with validate (no init)`
        : check.label,
      applicability: {
        ...applicability,
        env: { TF_CLI_ARGS: '', TF_CLI_ARGS_validate: '', TF_CLI_ARGS_fmt: '', TF_DATA_DIR: '.terraform', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
      }
    };
    return check;
  });
}

export async function previewLocalSeedPhase(
  projectRoot: string,
  manifest: LiftoffManifest,
  phaseId: LocalSeedPhaseId
): Promise<LocalSeedPhasePreview> {
  const discovery = await discoverGeneratedSeed(projectRoot, manifest);
  const blockers: string[] = discovery.state === 'blocked' ? [...discovery.issues] : [];
  const changeName = generatedSeedChangeName(manifest);
  const commands: LocalSeedCommand[] = [];
  const observations: (readonly string[])[] = [];
  let checks: SeedBaselineCheck[] = [];
  if (discovery.state === 'archived') {
    const integrity = await inspectArchivedSeedIntegrity(projectRoot, manifest);
    if (integrity.status !== 'valid') blockers.push(...(integrity.status === 'invalid'
      ? integrity.issues : ['The archived seed is no longer independently observable.']));
    const archiveRoot = ['openspec', 'changes', 'archive'];
    const archives = (await readdir(await resolveProjectPath(projectRoot, archiveRoot), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && (entry.name === changeName || entry.name.endsWith(`-${changeName}`)));
    if (archives.length !== 1) blockers.push('The exact archived seed location changed during inspection.');
    else {
      const archived = [...archiveRoot, archives[0]!.name];
      const capability = generatedSeedCapabilityId(manifest.project.workload);
      const artifacts = [
        ['.openspec.yaml'], ['proposal.md'], ['design.md'], ['tasks.md'], ['specs', capability, 'spec.md']
      ].map((parts) => [...archived, ...parts]);
      observations.push(...artifacts, ['openspec', 'specs', capability, 'spec.md']);
      for (const parts of artifacts) {
        if (!(await readRequiredProjectText(projectRoot, parts)).trim()) blockers.push(`Archived seed artifact ${parts.join('/')} is empty.`);
      }
      const declared = extractDeclaredCapabilities(await readRequiredProjectText(projectRoot, [...archived, 'proposal.md']));
      if (declared.length !== 1 || declared[0] !== capability) blockers.push(`Archived seed proposal must declare exactly the generated capability ${capability}.`);
    }
  } else if (discovery.state === 'active') {
    observations.push(discovery.changePathParts);
  }
  if (phaseId === 'seed-verified') {
    const infrastructureBlocker = seedInfrastructureBaselineBlocker(manifest);
    if (infrastructureBlocker) blockers.push(infrastructureBlocker);
    else checks = selectSeedBaselineChecks(manifest, changeName, discovery.state === 'archived' ? 'archived' : 'active', { localRevalidation: true });
    for (const check of checks) {
      if (!check.applicability.applicable) continue;
      const { command, cwdPathParts, env } = check.applicability;
      commands.push({ command, cwdPathParts, env: env ?? {} });
    }
    for (const environment of manifest.project.workload.environments) {
      const root = ['infrastructure', 'opentofu', 'azure', 'environments', environment];
      if (await readProjectFile(projectRoot, [...root, 'main.tf']) === undefined) {
        blockers.push(`Missing selected OpenTofu environment root ${[...root, 'main.tf'].join('/')}.`);
      }
      await requireInstalledDirectory([...root, '.terraform'], 'OpenTofu initialization');
    }
    if (manifest.project.workload.kind === 'genai' || manifest.project.workload.apiStack === 'python-fastapi') {
      await requireInstalledDirectory(['backend', '.venv'], 'Python environment');
    } else if (manifest.project.workload.apiStack === 'node-fastify') {
      await requireInstalledDirectory(['backend', 'node_modules'], 'Backend dependencies');
    }
    if (manifest.project.workload.frontend) await requireInstalledDirectory(['frontend', 'node_modules'], 'Frontend dependencies');
  } else if (manifest.project.specWorkflow === 'openspec') {
    if (phaseId === 'seed-archived' && discovery.state !== 'archived') {
      blockers.push('The seed is not already archived. Review liftoff governance plan and complete its separate setup/archive transition; update revalidation never archives or edits seed files.');
    } else {
      commands.push({
        command: { executable: 'openspec', args: discovery.state === 'archived'
          ? ['validate', '--all', '--strict'] : ['validate', changeName, '--strict'] },
        cwdPathParts: [], env: {}
      });
    }
  }
  if (manifest.project.specWorkflow === 'spec-kit' && phaseId !== 'seed-valid') {
    const bundle = await inspectSpecKitBootstrap(projectRoot, manifest);
    if (bundle.tasks !== undefined && completedSpecKitTasks(bundle.tasks) !== bundle.tasks) {
      blockers.push('Spec Kit bootstrap tasks are not already the completed matching projection. Review the separate governance setup transition; update revalidation does not write tasks.');
    }
  }
  const actionId = phaseId === 'seed-valid' ? 'openspec.seed.validate'
    : phaseId === 'seed-verified' ? 'openspec.seed.baseline-verify' : 'openspec.seed.archive';
  const operation: TransitionOperation = {
    adapter: 'selected-spec-workflow', actionId, mutationClass: 'read-worktree', phaseId,
    inputs: {
      changeName, localRevalidation: true, workflow: manifest.project.specWorkflow,
      seedState: discovery.state, observations, commands,
      ...(phaseId === 'seed-verified' ? {
        checks: checks.map((check) => ({
          id: check.id, taskId: check.taskId, label: check.label,
          applicable: check.applicability.applicable,
          ...(check.applicability.applicable ? {
            command: check.applicability.command, cwdPathParts: check.applicability.cwdPathParts,
            env: check.applicability.env ?? {}
          } : { reason: check.applicability.reason })
        }))
      } : {})
    },
    destination: { type: 'local', identity: projectRoot },
    remote: false, destructive: false
  };
  return { phaseId, operation, commands, blockers };

  async function requireInstalledDirectory(parts: string[], label: string): Promise<void> {
    const target = await resolveProjectPath(projectRoot, parts);
    try {
      if (!(await lstat(target)).isDirectory()) throw new Error(`${parts.join('/')} must be an existing regular directory.`);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      blockers.push(`${label} is unavailable at ${parts.join('/')}. Install or initialize it separately, then run liftoff update --check; revalidation never installs dependencies or runs tofu init.`);
    }
  }
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

function mainSpecPurpose(markdown: string): string | null {
  const match = markdown.match(/^## Purpose\s*\r?\n+([\s\S]*?)(?=\r?\n##\s+)/mu);
  return match?.[1]?.trim() || null;
}

export async function inspectArchivedSeedIntegrity(
  projectRoot: string,
  suppliedManifest?: LiftoffManifest
): Promise<ArchivedSeedIntegrity> {
  const manifest = suppliedManifest ?? await loadManifest(projectRoot);
  const changeName = generatedSeedChangeName(manifest);
  if (manifest.project.specWorkflow !== 'openspec') {
    return { status: 'not-applicable', changeName, issues: [] };
  }
  if (!(await archivedBootstrapChangeExists(projectRoot, changeName))) {
    return { status: 'not-archived', changeName, issues: [] };
  }
  const capabilityId = generatedSeedCapabilityId(manifest.project.workload);
  const pathParts = ['openspec', 'specs', capabilityId, 'spec.md'] as const;
  let spec: string;
  try {
    spec = await readRequiredProjectText(projectRoot, pathParts);
  } catch (error) {
    return {
      status: 'invalid',
      changeName,
      capabilityId,
      issues: [
        `Archived seed ${changeName} has no synchronized main capability spec at ${pathParts.join('/')}: ${errorMessage(error)}`
      ]
    };
  }
  const purpose = mainSpecPurpose(spec);
  if (!purpose || purpose.startsWith('TBD - created by archiving change')) {
    return {
      status: 'invalid',
      changeName,
      capabilityId,
      issues: [
        `Archived seed ${changeName} has no concrete Purpose in ${pathParts.join('/')}; repair the synchronized main spec before setup continues.`
      ]
    };
  }
  return { status: 'valid', changeName, capabilityId, contentDigest: canonicalSha256(spec.replace(/\r\n/g, '\n')), issues: [] };
}

export async function discoverGeneratedSeed(projectRoot: string, suppliedManifest?: LiftoffManifest): Promise<GeneratedSeedDiscovery> {
  const manifest = suppliedManifest ?? await loadManifest(projectRoot);
  const changeName = generatedSeedChangeName(manifest);
  if (manifest.project.specWorkflow !== 'openspec') {
    const bundle = await inspectSpecKitBootstrap(projectRoot, manifest);
    return bundle.issues.length ? { state: 'blocked', changeName, issues: bundle.issues } : {
      state: 'active', changeName, changePathParts: specKitBootstrapPath,
      capabilityId: generatedSeedCapabilityId(manifest.project.workload)
    };
  }

  const active = await activeBootstrapChanges(projectRoot);
  if (active.length === 0) {
    if (await archivedBootstrapChangeExists(projectRoot, changeName)) {
      const archiveRoot = await resolveProjectPath(projectRoot, ['openspec', 'changes', 'archive']);
      const archives = (await readdir(archiveRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && (entry.name === changeName || entry.name.endsWith(`-${changeName}`)));
      const issues: string[] = [];
      if (archives.length !== 1) {
        issues.push(`Expected exactly one archived generated seed ${changeName}; found ${archives.length}.`);
      } else {
        const archived = ['openspec', 'changes', 'archive', archives[0]!.name];
        for (const parts of [
          ['.openspec.yaml'], ['proposal.md'], ['design.md'], ['tasks.md'],
          ['specs', generatedSeedCapabilityId(manifest.project.workload), 'spec.md']
        ]) {
          try { await readRequiredProjectText(projectRoot, [...archived, ...parts]); }
          catch (error) { issues.push(errorMessage(error)); }
        }
      }
      if (issues.length) return { state: 'blocked', changeName, issues };
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
  if (await archivedBootstrapChangeExists(projectRoot, changeName)) {
    return { state: 'blocked', changeName, issues: [`Generated seed ${changeName} has both active and archived copies; resolve ownership explicitly without deleting or inventing history.`] };
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
  if (result.command.executable === 'openspec') {
    const condition = result.timedOut ? 'command timed out' : `exit status ${result.status ?? 'unknown'}`;
    const output = [result.errorCode, result.errorMessage, result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n');
    const diagnostic = sanitizeOpenSpecDiagnostic(output);
    return diagnostic ? `${condition}; ${diagnostic}` : condition;
  }

  if (result.timedOut) {
    return 'command timed out';
  }
  if (result.aborted) return 'command was interrupted or cancelled';
  if (result.outputLimitExceeded) return 'command output exceeded the supported limit';
  if (result.signal) return `command terminated by ${result.signal}`;
  if (result.errorCode || result.errorMessage) {
    return [result.errorCode, result.errorMessage].filter(Boolean).join(': ');
  }
  return `exit status ${result.status ?? 'unknown'}`;
}

function commandSucceeded(result: CommandResult): boolean {
  return result.status === 0 && !result.signal && !result.timedOut && !result.errorCode &&
    !result.errorMessage && !result.aborted && !result.outputLimitExceeded;
}

function localValidationObservation(result: CommandResult) {
  return {
    command: result.command,
    exitStatus: result.status,
    outputDigest: canonicalSha256({ stdout: result.stdout, stderr: result.stderr })
  };
}

function sanitizeOpenSpecDiagnostic(output: string): string {
  const plain = stripVTControlCharacters(output)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .trim();
  const scan = detectCredentialLeaks([{
    source: 'process-log',
    label: 'OpenSpec failure diagnostic',
    text: plain
  }]);
  if (scan.status === 'compromised') {
    return `OpenSpec diagnostic withheld: credential-shaped content detected. ${scan.guidance.join(' ')}`;
  }
  const limit = 2048;
  const suffix = '\n[truncated]';
  return plain.length > limit ? `${plain.slice(0, limit - suffix.length)}${suffix}` : plain;
}

async function validateAllOpenSpecAfterArchive(
  projectRoot: string,
  runner: CommandRunner,
  changeName: string
): Promise<
  | { status: 'passed'; command: CommandResult }
  | { status: 'blocked'; issues: readonly string[]; retryableAfterRepair: true }
> {
  const command = {
    executable: 'openspec',
    args: ['validate', '--all', '--strict']
  };
  const result = await runner.run(command, { cwd: projectRoot });
  if (!commandSucceeded(result)) {
    return {
      status: 'blocked',
      issues: [
        `OpenSpec post-archive strict validation failed: ${formatCommand(command)} (${checkFailureDetail(result)}). ` +
          `The seed ${changeName} is archived; repair the synchronized main spec, then rerun setup so the archived seed is revalidated.`
      ],
      retryableAfterRepair: true
    };
  }
  return { status: 'passed', command: result };
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
  const result = await runner.run(check.applicability.command, {
    cwd, ...(check.applicability.env ? { env: check.applicability.env } : {})
  });
  if (commandSucceeded(result)) {
    return {
      id: check.id,
      taskId: check.taskId,
      label: check.label,
      status: 'passed',
      command: check.applicability.command,
      cwdPathParts: check.applicability.cwdPathParts,
      ...(check.applicability.env ? { env: check.applicability.env } : {}),
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
    ...(check.applicability.env ? { env: check.applicability.env } : {}),
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
    '2.7.1',
    '2.7.2',
    '2.7.3',
    '2.8.1',
    '2.8.2',
    '2.8.3',
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
  runner: CommandRunner,
  options: SeedExecutionOptions = {}
): Promise<SeedPhaseValidationResult> {
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'archived') {
    if (options.localRevalidation) {
      const integrity = await inspectArchivedSeedIntegrity(projectRoot);
      if (integrity.status !== 'valid') return {
        status: 'blocked', changeName: discovery.changeName,
        issues: integrity.status === 'invalid' ? integrity.issues : ['The archived seed is no longer independently observable.']
      };
      const validation = await validateAllOpenSpecAfterArchive(projectRoot, runner, discovery.changeName);
      if (validation.status === 'blocked') return { status: 'blocked', changeName: discovery.changeName, issues: validation.issues };
      return { status: 'passed', changeName: discovery.changeName, command: validation.command,
        detail: 'Existing archived seed artifacts are present and synchronized main specifications are strict-valid; no archive was replayed.' };
    }
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
  const manifest = await loadManifest(projectRoot);
  if (manifest.project.specWorkflow === 'spec-kit') {
    return { status: 'passed', changeName: discovery.changeName, detail: 'Real Spec Kit bootstrap bundle and independent official initialization markers are valid.' };
  }
  const command = { executable: 'openspec', args: ['validate', discovery.changeName, '--strict'] };
  const result = await runner.run(command, { cwd: projectRoot });
  if (!commandSucceeded(result)) {
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
  runner: CommandRunner,
  options: SeedExecutionOptions = {}
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
  if (discovery.state === 'archived') {
    const integrity = await inspectArchivedSeedIntegrity(projectRoot, manifest);
    if (integrity.status !== 'valid') {
      return {
        status: 'blocked',
        changeName: discovery.changeName,
        issues: integrity.status === 'invalid'
          ? integrity.issues
          : ['Archived seed changed during baseline discovery; rerun setup after restoring the archive.'],
        checks: []
      };
    }
  }
  const layoutBlocker = seedInfrastructureBaselineBlocker(manifest);
  if (layoutBlocker) return { status: 'blocked', changeName: discovery.changeName, checks: [], issues: [layoutBlocker] };
  if (options.localRevalidation) {
    const preview = await previewLocalSeedPhase(projectRoot, manifest, 'seed-verified');
    if (preview.blockers.length) return { status: 'blocked', changeName: discovery.changeName, checks: [], issues: preview.blockers };
  }
  const checks = selectSeedBaselineChecks(manifest, discovery.changeName, discovery.state, options);
  for (const environment of manifest.project.workload.environments) {
    const parts = ['infrastructure', 'opentofu', 'azure', 'environments', environment, 'main.tf'];
    if (await readProjectFile(projectRoot, parts) === undefined) {
      return { status: 'blocked', changeName: discovery.changeName, checks: [], issues: [`Missing selected OpenTofu environment root ${parts.join('/')}.`] };
    }
  }
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
  if (manifest.project.specWorkflow === 'spec-kit') {
    const bundle = await inspectSpecKitBootstrap(projectRoot, manifest);
    if (bundle.issues.length || bundle.tasks === undefined) return { status: 'blocked', changeName: discovery.changeName, checks: outcomes, issues: bundle.issues };
    const snapshot = await captureProjectFileSnapshot(projectRoot, [...specKitBootstrapPath, 'tasks.md']);
    if (snapshot.content?.toString('utf8') !== bundle.tasks) return {
      status: 'blocked', changeName: discovery.changeName, checks: outcomes, issues: ['Spec Kit tasks changed during baseline finalization; concurrent bytes were preserved.']
    };
    return {
      status: 'passed', changeName: discovery.changeName, checks: outcomes,
      fileMutations: [{ type: 'write', pathParts: [...specKitBootstrapPath, 'tasks.md'], content: completedSpecKitTasks(bundle.tasks) }],
      filePreconditions: [snapshot]
    };
  }
  return { status: 'passed', changeName: discovery.changeName, checks: outcomes };
}

export async function archiveGeneratedSeedForPhase(
  projectRoot: string,
  runner: CommandRunner,
  options: SeedExecutionOptions = {}
): Promise<SeedPhaseArchiveResult> {
  return withProjectMutationLock(projectRoot, (lease) => archiveGeneratedSeedForPhaseLocked(projectRoot, runner, lease, options));
}

async function archiveGeneratedSeedForPhaseLocked(
  projectRoot: string, runner: CommandRunner, lease: ProjectMutationLease, options: SeedExecutionOptions
): Promise<SeedPhaseArchiveResult> {
  const manifest = await loadManifest(projectRoot);
  if (manifest.project.specWorkflow === 'spec-kit') {
    const bundle = await inspectSpecKitBootstrap(projectRoot, manifest);
    if (bundle.issues.length || !bundle.tasks || /^\s*- \[ \] B00[1-6] /m.test(bundle.tasks)) {
      return { status: 'blocked', changeName: specKitBootstrapId, issues: [
        ...bundle.issues, 'The explicit Spec Kit local baseline task projection must be finalized by successful baseline execution.'
      ] };
    }
    return { status: 'already-archived', changeName: specKitBootstrapId,
      detail: 'Spec Kit local bootstrap handoff is finalized; no OpenSpec archive or Git branch was created.' };
  }
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'archived') {
    const integrity = await inspectArchivedSeedIntegrity(projectRoot);
    if (integrity.status === 'invalid' || options.localRevalidation && integrity.status !== 'valid') {
      return {
        status: 'blocked',
        changeName: discovery.changeName,
        issues: integrity.status === 'invalid' ? integrity.issues : ['The archived seed is no longer independently observable.'],
        retryableAfterRepair: true
      };
    }
    const validation = await validateAllOpenSpecAfterArchive(
      projectRoot,
      runner,
      discovery.changeName
    );
    if (validation.status === 'blocked') {
      return {
        status: 'blocked',
        changeName: discovery.changeName,
        issues: validation.issues,
        retryableAfterRepair: validation.retryableAfterRepair
      };
    }
    return {
      status: 'already-archived',
      changeName: discovery.changeName,
      ...(integrity.status === 'valid' ? { synchronizedSpecDigest: integrity.contentDigest } : {}),
      ...(options.localRevalidation ? { validation: validation.command } : {}),
      detail: `${discovery.detail} The synchronized main specs remain strict-valid.`
    };
  }
  if (discovery.state === 'blocked') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: discovery.issues
    };
  }
  if (options.localRevalidation) return {
    status: 'blocked', changeName: discovery.changeName,
    issues: ['The seed is not already archived. Review the separate governance setup/archive transition; update revalidation never archives or edits seed files.']
  };

  const taskPathParts = [...discovery.changePathParts, 'tasks.md'];
  const originalTasks = await readRequiredProjectText(projectRoot, taskPathParts);
  const completedTasks = markAllSeedTasksForArchive(originalTasks);
  await writeProjectFile(projectRoot, taskPathParts, completedTasks);

  const archiveCommand = { executable: 'openspec', args: ['archive', discovery.changeName, '--yes', '--json'] };
  await lease.assertHeld();
  const archive = await runner.run(archiveCommand, { cwd: projectRoot });
  if (archive.status !== 0 || archive.timedOut || archive.errorCode) {
    const remaining = await readProjectFile(projectRoot, taskPathParts);
    const archiveCompleted = remaining === undefined && await archivedBootstrapChangeExists(projectRoot, discovery.changeName);
    const restored = remaining?.toString('utf8') === completedTasks;
    if (restored) await writeProjectFile(projectRoot, taskPathParts, originalTasks);
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      retryableAfterRepair: true,
      archiveCompleted,
      issues: [
        `OpenSpec archive failed: ${formatCommand(archiveCommand)} (${checkFailureDetail(archive)}). ` +
          (archiveCompleted ? 'The seed was already moved to the archive; explicit retry revalidates it without recreating an active seed.' :
            restored ? 'Seed tasks were restored and the seed remains active.' :
              'Concurrent or uncertain seed task changes were preserved; no original task bytes were written over them.')
      ]
    };
  }
  const integrity = await inspectArchivedSeedIntegrity(projectRoot);
  if (integrity.status !== 'valid') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: integrity.status === 'invalid' ? integrity.issues : ['Archive success was not independently observed; the seed handoff remains incomplete.'],
      retryableAfterRepair: true,
      archiveCompleted: true
    };
  }
  const validation = await validateAllOpenSpecAfterArchive(
    projectRoot,
    runner,
    discovery.changeName
  );
  if (validation.status === 'blocked') {
    return {
      status: 'blocked',
      changeName: discovery.changeName,
      issues: validation.issues,
      retryableAfterRepair: validation.retryableAfterRepair,
      archiveCompleted: true
    };
  }
  return {
    status: 'archived',
    changeName: discovery.changeName,
    synchronizedSpecDigest: integrity.contentDigest,
    capabilityId: discovery.capabilityId,
    archive,
    archiveSyncBehavior: 'OpenSpec archive updates main specs as part of archive; the lifecycle engine intentionally never passes --skip-specs.',
    detail: 'Generated seed was archived and the synchronized main specs passed strict validation.'
  };
}

export async function executeSeedOperations(
  input: PhaseAdapterExecutionInput, options: SeedExecutionOptions = {}
): Promise<PhaseAdapterOutcome | null> {
  if (!input.phase.id.startsWith('seed-')) return null;
  if (input.phase.id === 'seed-valid') {
    const result = await validateGeneratedSeedForPhase(input.inspection.projectRoot, input.runner, options);
    if (result.status === 'blocked') {
      return { status: 'blocked', blocker: result.issues[0] ?? 'Seed validation failed.', completedOperations: [] };
    }
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'seed-valid.v1', changeName: result.changeName, detail: result.detail,
        ...(options.localRevalidation && result.command ? { validation: localValidationObservation(result.command) } : {})
      },
      completedOperations: input.plan.operations.filter((op) => op.actionId === 'openspec.seed.validate')
    };
  }
  if (input.phase.id === 'seed-verified') {
    const result = await verifyGeneratedSeedBaselineForPhase(input.inspection.projectRoot, input.runner, options);
    if (result.status === 'blocked') {
      return { status: 'blocked', blocker: result.issues[0] ?? 'Seed baseline verification failed.', completedOperations: [] };
    }
    if (options.localRevalidation) {
      for (const mutation of result.fileMutations ?? []) {
        const current = await readProjectFile(input.inspection.projectRoot, mutation.pathParts);
        if (mutation.type !== 'write' || current?.toString('utf8') !== mutation.content) return {
          status: 'blocked',
          blocker: 'The baseline requires a differing Spec Kit task projection. Review the separate setup transition; revalidation preserved the existing tasks.',
          completedOperations: []
        };
      }
    }
    return {
      status: 'completed',
      resultState: 'verified',
      evidencePayload: {
        kind: 'seed-verified.v1',
        checks: result.checks.map((check) => ({
          id: check.id, taskId: check.taskId, status: check.status,
          ...(options.localRevalidation && check.status === 'passed' ? {
            label: check.label, cwdPathParts: check.cwdPathParts, env: check.env ?? {},
            ...localValidationObservation(check.result)
          } : {})
        }))
      },
      completedOperations: input.plan.operations.filter((op) => op.actionId === 'openspec.seed.baseline-verify' || op.actionId === 'seed.tasks.project'),
      fileMutations: options.localRevalidation ? undefined : result.fileMutations,
      filePreconditions: result.filePreconditions
    };
  }
  const result = await archiveGeneratedSeedForPhase(input.inspection.projectRoot, input.runner, options);
  if (result.status === 'blocked') {
    return {
      status: 'blocked',
      blocker: result.issues[0] ?? 'Seed archive failed.',
      completedOperations: result.archiveCompleted ? input.plan.operations.filter((op) => op.actionId === 'openspec.seed.archive') : [],
      retryableWithoutStateMutation: result.retryableAfterRepair
    };
  }
  return {
    status: 'completed',
    resultState: 'verified',
    evidencePayload: {
      kind: 'seed-archived.v1',
      ...(result.synchronizedSpecDigest ? { synchronizedSpecDigest: result.synchronizedSpecDigest } : {}),
      archiveSyncBehavior: result.archiveSyncBehavior ?? null,
      ...(options.localRevalidation ? {
        observation: result.detail,
        ...(result.validation ? { validation: localValidationObservation(result.validation) } : {})
      } : {})
    },
    completedOperations: input.plan.operations.filter((op) => op.actionId === 'openspec.seed.archive')
  };
}

export async function completeGeneratedSeedLifecycle(
  projectRoot: string,
  runner: CommandRunner
): Promise<GeneratedSeedLifecycleResult> {
  return withProjectMutationLock(projectRoot, () => completeGeneratedSeedLifecycleLocked(projectRoot, runner));
}

async function completeGeneratedSeedLifecycleLocked(projectRoot: string, runner: CommandRunner): Promise<GeneratedSeedLifecycleResult> {
  const manifest = await loadManifest(projectRoot);
  if (manifest.project.specWorkflow === 'spec-kit') {
    return {
      status: 'blocked', changeName: specKitBootstrapId, checks: [],
      issues: ['Spec Kit local completion requires the explicitly planned governance apply-next --execute phases so task projection and the body-bound baseline receipt are persisted together. No standalone archive is supported.']
    };
  }
  const discovery = await discoverGeneratedSeed(projectRoot);
  if (discovery.state === 'archived') {
    const archive = await archiveGeneratedSeedForPhase(projectRoot, runner);
    if (archive.status === 'blocked') {
      return {
        status: 'blocked',
        changeName: archive.changeName,
        issues: archive.issues,
        checks: []
      };
    }
    return {
      status: 'already-archived',
      changeName: archive.changeName,
      detail: archive.detail
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
