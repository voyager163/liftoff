import {
  existsSync,
  readFileSync
} from 'node:fs';
import path from 'node:path';
import {
  getCodingAgent,
  getFrameworkDefinition,
  getSpecWorkflow,
  patterns
} from '../project/catalog.js';
import {
  validateFrameworkInstallation
} from '../../framework-validation.js';
import {
  findProjectRoot
} from '../../adapters/filesystem/project-discovery.js';
import {
  loadManifest
} from '../project/manifest.js';
import {
  validateGeneratedProject
} from './generated-project.js';
import {
  buildProjectPlan,
  loadConfigOptions
} from '../project/planning.js';
import {
  NodeCommandRunner,
  type CommandRunner
} from '../../process-runner.js';
import {
  reconcileProject
} from '../../reconcile.js';
import {
  compareSemver
} from '../../semver.js';
import {
  checkConfiguredRegistryTarget,
  type ConfiguredRegistryTargetLookup
} from '../../self-upgrade.js';
import {
  canonicalManualInstallCommand,
  canonicalNpmRegistry
} from '../../package-identity.js';
import {
  lookupStableRelease,
  type StableRelease
} from '../../stable-release.js';
import {
  packagedSupportedStack as supportedStack
} from '../../adapters/packaged-assets/supported-stack.js';
import {
  buildArtifacts
} from '../../templates.js';
import {
  PresentationSession
} from '../../terminal.js';
import type {
  ExecutionContext
} from '../context.js';
import {
  governanceDoctorChecks
} from '../../governance-activation/doctor.js';
import type {
  ApiStackId,
  LiftoffManifest
} from '../../domain/project/contracts.js';
import {
  liftoffVersion
} from '../../version.js';
import {
  isRetiredPowerAppsError
} from '../../domain/project/retired-workload.js';
import {
  probeWorkstation,
  selectLiftoffRuntimeRequirements,
  selectWorkstationRequirements,
  type RequirementProbeResult,
  type WorkstationRequirementSelection
} from '../../workstation.js';
import {
  inspectProvisioningGroups,
  requestedProvisioningGroups
} from '../update/planning.js';

interface DoctorCheck {
  id?: string;
  label: string;
  severity: 'ok' | 'warn' | 'fail' | 'skipped';
  state?: string;
  requirementSeverity?: 'blocking' | 'advisory';
  detail: string;
  remedy?: string;
}

export interface DoctorLayer {
  title: string;
  checks: DoctorCheck[];
}

const doctorProbeTimeoutMs = 15_000;

async function versionedBinaryCheck(
  label: string,
  command: string,
  args: string[],
  minimum: readonly [number, number],
  remedy: string,
  runner: CommandRunner
): Promise<{ check: DoctorCheck; available: boolean }> {
  const result = await runner.run(
    { executable: command, args },
    { timeoutMs: doctorProbeTimeoutMs }
  );
  if (result.timedOut) {
    return {
      check: { label, severity: 'fail', detail: 'version probe timed out', remedy },
      available: false
    };
  }
  if (result.status !== 0) {
    return {
      check: { label, severity: 'fail', detail: 'not found', remedy },
      available: result.errorCode !== 'ENOENT'
    };
  }

  const output = (result.stdout || result.stderr).split('\n')[0].trim();
  const match = output.match(/(\d+)\.(\d+)/);
  if (!match) {
    return {
      check: { label, severity: 'fail', detail: `unable to determine version from "${output}"`, remedy },
      available: true
    };
  }
  const found: readonly [number, number] = [Number(match[1]), Number(match[2])];
  if (found[0] < minimum[0] || found[0] === minimum[0] && found[1] < minimum[1]) {
    return {
      check: { label, severity: 'fail', detail: `${output} is below ${minimum.join('.')}`, remedy },
      available: true
    };
  }
  return {
    check: { label, severity: 'ok', detail: output },
    available: true
  };
}

async function pythonRuntime(
  runner: CommandRunner
): Promise<{ command: string; versionArgs: string[]; commandArgs: string[] } | undefined> {
  const [major, minor] = (
    supportedStack.runtimes.python.minimumVersion ??
    supportedStack.runtimes.python.version
  ).split('.');
  const minimum: readonly [number, number] = [Number(major), Number(minor)];
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
  let available: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    const probe = await versionedBinaryCheck(
      'python',
      candidate.command,
      candidate.versionArgs,
      minimum,
      `install Python ${major}.${minor} or newer`,
      runner
    );
    if (probe.check.severity === 'ok') {
      return candidate;
    }
    if (probe.available && !available) {
      available = candidate;
    }
  }
  return available;
}

function doctorCheckFromProbe(probe: RequirementProbeResult): DoctorCheck {
  const severity = probe.state === 'ready'
    ? 'ok'
    : probe.requirement.severity === 'blocking'
      ? 'fail'
      : 'warn';
  return {
    id: probe.requirement.id,
    label: probe.requirement.id,
    severity,
    state: probe.state,
    requirementSeverity: probe.requirement.severity,
    detail: probe.detail,
    ...(probe.remedy ? { remedy: probe.remedy } : {})
  };
}

function noticeId(requirementId: string, label: string): string {
  const suffix = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${requirementId}:${suffix}`;
}

function workstationLayer(probes: RequirementProbeResult[]): DoctorLayer {
  const checks = probes.flatMap((probe): DoctorCheck[] => [
    doctorCheckFromProbe(probe),
    ...probe.notices.map((notice): DoctorCheck => ({
      id: noticeId(probe.requirement.id, notice.label),
      label: notice.label,
      severity: notice.state === 'ready' ? 'ok' : 'warn',
      state: notice.state,
      requirementSeverity: 'advisory',
      detail: notice.detail,
      ...(notice.remedy ? { remedy: notice.remedy } : {})
    }))
  ]);
  return { title: 'Environment', checks };
}

function workstationSelectionFromManifest(manifest: LiftoffManifest): WorkstationRequirementSelection {
  const framework = getFrameworkDefinition(manifest.project.specWorkflow);
  const workload = manifest.project.workload;
  return {
    workload: {
      kind: workload.kind,
      apiStack: { id: workload.apiStack },
      provider: { id: workload.cloud }
    },
    specWorkflow: { id: manifest.project.specWorkflow },
    framework: { version: framework.version },
    agents: manifest.framework.state === 'initialized'
      ? manifest.project.agents.map((id) => {
          const agent = getCodingAgent(id);
          if (!agent) {
            throw new Error(`Manifest references unknown coding agent ${id}.`);
          }
          return { id: agent.id, label: agent.label };
        })
      : []
  };
}

async function frameworkDoctorChecks(
  projectRoot: string,
  manifest: LiftoffManifest
): Promise<DoctorCheck[]> {
  if (manifest.framework.state === 'legacy') {
    return [{
      id: 'framework-legacy-state',
      label: 'framework state',
      severity: 'warn',
      state: 'not-observable',
      detail: `Legacy v${manifest.artifactVersion} manifest does not prove official ${manifest.framework.adapter} initialization or configured coding agents.`,
      remedy: 'Reinitialize the framework explicitly before recording a v3 initialized framework contract.'
    }];
  }

  const expected = getFrameworkDefinition(manifest.framework.adapter);
  const frameworkLabel = getSpecWorkflow(manifest.framework.adapter)?.label ?? manifest.framework.adapter;
  const contract = manifest.framework.contractVersion === expected.version
    ? {
        id: 'framework-contract',
        label: 'framework contract',
        severity: 'ok' as const,
        state: 'ready',
        detail: `${frameworkLabel} ${expected.version}`
      }
    : {
        id: 'framework-contract',
        label: 'framework contract',
        severity: 'fail' as const,
        state: 'outdated',
        detail: `Manifest records ${manifest.framework.contractVersion}; this Liftoff version requires ${expected.version}.`,
        remedy: `Install ${frameworkLabel} ${expected.version} and reinitialize its integrations.`
      };
  const markerIssues = await validateFrameworkInstallation(projectRoot, {
    workflow: manifest.framework.adapter,
    agents: manifest.project.agents,
    ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
  });
  const markers: DoctorCheck = markerIssues.length === 0
    ? {
        id: 'framework-markers',
        label: 'framework markers',
        severity: 'ok',
        state: 'ready',
        detail: `${manifest.project.agents.length} selected integration${manifest.project.agents.length === 1 ? '' : 's'} verified`
      }
    : {
        id: 'framework-markers',
        label: 'framework markers',
        severity: 'fail',
        state: 'unhealthy',
        detail: `${markerIssues.length} issue(s): ${markerIssues[0]}`,
        remedy: `Run the official ${frameworkLabel} initializer for the selected integrations.`
      };
  return [
    contract,
    {
      id: 'selected-agents',
      label: 'selected agents',
      severity: 'ok',
      state: 'ready',
      detail: manifest.project.agents.join(', ')
    },
    markers
  ];
}

async function stackProjectCheck(
  projectRoot: string,
  apiStack: ApiStackId,
  runner: CommandRunner
): Promise<DoctorCheck> {
  const requiredMetadata: Record<ApiStackId, string[]> = {
    'python-fastapi': ['backend/pyproject.toml', 'backend/uv.lock'],
    'node-fastify': ['backend/package.json', 'backend/package-lock.json'],
    'go-huma': ['backend/go.mod', 'backend/go.sum']
  };
  const missingMetadata = requiredMetadata[apiStack].find(
    (relativePath) => !existsSync(path.join(projectRoot, ...relativePath.split('/')))
  );
  if (missingMetadata) {
    return {
      label: `${apiStack} project`,
      severity: 'fail',
      detail: `missing locked dependency metadata: ${missingMetadata}`,
      remedy: `restore or repair the project-owned ${missingMetadata}`
    };
  }
  if (apiStack === 'python-fastapi') {
    const pyproject = readFileSync(path.join(projectRoot, 'backend', 'pyproject.toml'), 'utf8');
    const lock = readFileSync(path.join(projectRoot, 'backend', 'uv.lock'), 'utf8');
    const projectName = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const lockedProjectName = lock.match(
      /\[\[package\]\]\s+name\s*=\s*"([^"]+)"\s+version\s*=\s*"[^"]+"\s+source\s*=\s*\{\s*editable\s*=\s*"\."\s*\}/m
    )?.[1];
    if (!projectName || lockedProjectName !== projectName) {
      return {
        label: `${apiStack} project`,
        severity: 'fail',
        detail: 'pyproject.toml and uv.lock do not identify the same project',
        remedy: 'repair the project-owned backend/pyproject.toml and backend/uv.lock'
      };
    }
  }
  let result: Awaited<ReturnType<CommandRunner['run']>>;
  switch (apiStack) {
    case 'python-fastapi':
      {
        const python = await pythonRuntime(runner);
        if (!python) {
          return { label: 'python project', severity: 'skipped', detail: 'python is unavailable' };
        }

        result = await runReadOnly(
          python.command,
          [...python.commandArgs, '-c', 'from pathlib import Path; p=Path("backend/apis/main.py"); compile(p.read_text(), str(p), "exec")'],
          projectRoot,
          runner
        );
      }
      break;
    case 'node-fastify':
      result = await runReadOnly(
        'node',
        ['-e', 'const f=require("fs"); JSON.parse(f.readFileSync("backend/package.json")); JSON.parse(f.readFileSync("backend/tsconfig.json"));'],
        projectRoot,
        runner
      );
      break;
    case 'go-huma':
      result = await runReadOnly(
        'go',
        ['mod', 'edit', '-json'],
        path.join(projectRoot, 'backend'),
        runner
      );
      if (result.errorCode === 'ENOENT') {
        return { label: 'go project', severity: 'skipped', detail: 'go is unavailable' };
      }
      break;
  }

  if (result.timedOut) {
    return {
      label: `${apiStack} project`,
      severity: 'fail',
      detail: 'stack validation timed out',
      remedy: `repair the generated ${apiStack} backend configuration`
    };
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

function runReadOnly(
  command: string,
  args: string[],
  cwd: string,
  runner: CommandRunner
): Promise<Awaited<ReturnType<CommandRunner['run']>>> {
  return runner.run(
    { executable: command, args },
    { cwd, timeoutMs: doctorProbeTimeoutMs }
  );
}

async function binaryPresent(command: string, runner: CommandRunner): Promise<boolean> {
  const result = await runner.run(
    { executable: command, args: ['--version'] },
    { timeoutMs: doctorProbeTimeoutMs }
  );
  return result.status === 0 && !result.timedOut;
}

async function azureCloudChecks(runner: CommandRunner): Promise<DoctorCheck[]> {
  const auth = await runner.run(
    { executable: 'az', args: ['account', 'show', '-o', 'none', '--only-show-errors'] },
    { timeoutMs: 15_000 }
  );
  if (auth.errorCode === 'ENOENT') {
    return [{ label: 'az', severity: 'warn', detail: 'Azure CLI not found', remedy: 'install the Azure CLI' }];
  }
  if (auth.status === 0) {
    return [{ label: 'azure auth', severity: 'ok', detail: 'authenticated' }];
  }
  return [{ label: 'azure auth', severity: 'warn', detail: 'not authenticated', remedy: 'run az login' }];
}

// ponytail: provider-keyed map so aws/gcp checks slot in when their adapters land
const CLOUD_CHECKS: Record<string, (runner: CommandRunner) => Promise<DoctorCheck[]>> = {
  azure: azureCloudChecks
};

async function cloudLayer(cloud: string, runner: CommandRunner): Promise<DoctorLayer> {
  const checks = CLOUD_CHECKS[cloud]
    ? await CLOUD_CHECKS[cloud](runner)
    : [{ label: cloud, severity: 'skipped' as const, detail: `${cloud} provider checks are not available yet` }];
  return { title: `Cloud - ${cloud}`, checks };
}

async function cliLayer(
  releaseLookup: () => Promise<StableRelease>,
  configuredRegistryLookup: ConfiguredRegistryTargetLookup
): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [
    { label: 'version', severity: 'ok', detail: `Liftoff ${liftoffVersion}` }
  ];
  let latest: string;
  try {
    latest = (await releaseLookup()).version;
  } catch {
    return { title: 'CLI', checks };
  }

  if (compareSemver(latest, liftoffVersion) > 0) {
    let registryState: Awaited<ReturnType<ConfiguredRegistryTargetLookup>> = {
      status: 'unavailable'
    };
    try {
      registryState = await configuredRegistryLookup(latest);
    } catch {
      // Canonical freshness remains useful when local npm registry inspection fails.
    }
    const manual = canonicalManualInstallCommand(latest);
    checks.push({
      label: 'cli freshness',
      severity: 'warn',
      detail: registryState.status === 'stale'
        ? `Liftoff ${latest} is published, but the configured npm registry does not expose it`
        : `Liftoff ${latest} is published, this CLI is ${liftoffVersion}`,
      remedy: registryState.status === 'stale'
        ? 'ask the managed registry owner to synchronize the canonical target, then run liftoff upgrade --check'
        : `run liftoff upgrade --check, then liftoff upgrade; manual fallback where canonical npm is permitted: ${manual}`
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

async function projectLayer(
  projectRoot: string,
  manifest: LiftoffManifest,
  runner: CommandRunner
): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [];

  const issues = await validateGeneratedProject(projectRoot);
  if (issues.length > 0) {
    checks.push({
      label: 'manifest',
      severity: 'fail',
      detail: `${issues.length} issue(s): ${issues[0]}${issues.length > 1 ? ' ...' : ''}`,
      remedy: 'restore the manifest or run liftoff update for managed-core repair'
    });
  } else {
    checks.push({
      label: 'manifest',
      severity: 'ok',
      detail: `valid, ${manifest.managedArtifacts.length} managed core and ${manifest.projectArtifacts.length} project provenance entries`
    });
  }

  if (compareSemver(manifest.liftoffVersion, liftoffVersion) > 0) {
    checks.push({
      label: 'version',
      severity: 'warn',
      detail: `project written by Liftoff ${manifest.liftoffVersion}, CLI is ${liftoffVersion}`,
      remedy: `run liftoff upgrade --check, then liftoff upgrade; manual fallback: ${canonicalManualInstallCommand(manifest.liftoffVersion)}`
    });
  } else {
    checks.push({ label: 'version', severity: 'ok', detail: `generated by ${manifest.liftoffVersion}, CLI ${liftoffVersion}` });
  }

  if (manifest.governance.profile === 'unspecified') {
    checks.push({
      id: 'repository-governance',
      label: 'repository governance',
      severity: 'warn',
      state: 'not-observable',
      detail: 'manifest predates local governance handoff state',
      remedy: 'run liftoff update --check to inspect default handoff adoption'
    });
  } else if (manifest.governance.profile === 'none') {
    checks.push({
      id: 'repository-governance',
      label: 'repository governance',
      severity: 'ok',
      state: 'disabled',
      detail: 'disabled; no local handoff or live-enforcement claim'
    });
  } else {
    const governanceIssue = issues.find((issue) =>
      /governance|repository-governance/i.test(issue)
    );
    const partialHandoff = manifest.governance.state === 'handoff-partial';
    const severity = governanceIssue ? 'fail' : partialHandoff ? 'warn' : 'ok';
    const detail = governanceIssue ??
      (partialHandoff
        ? `local ${manifest.governance.profile} policy ${manifest.governance.policyVersion} handoff is incomplete; one or more exact destinations remain outside Liftoff ownership`
        : `local ${manifest.governance.profile} policy ${manifest.governance.policyVersion} handoff is intact; live enforcement is not inferred`);
    const remedy = governanceIssue
      ? 'inspect with liftoff update --check; run liftoff update for safe repairs or use --force only after reviewing exact already-managed conflicts; unowned destinations require manual resolution; neither activates GitHub governance'
      : partialHandoff
        ? 'inspect liftoff update --check; resolve unowned destinations manually; liftoff update --force may replace only already-managed conflicts or remove exact retired aliases after review'
        : undefined;
    checks.push({
      id: 'repository-governance',
      label: 'repository governance',
      severity,
      state: governanceIssue ? 'unhealthy' : manifest.governance.state,
      detail,
      ...(remedy ? { remedy } : {})
    });
    checks.push(...await governanceDoctorChecks(projectRoot, manifest));
  }

  checks.push(...await frameworkDoctorChecks(projectRoot, manifest));
  checks.push(await stackProjectCheck(
    projectRoot,
    manifest.project.workload.apiStack,
    runner
  ));

  try {
    const config = await loadConfigOptions('liftoff.config.json', projectRoot);
    const plan = buildProjectPlan(config, { requireProjectName: true });
    const render = buildArtifacts(plan);
    const entries = await reconcileProject(manifest, render, projectRoot);
    const provisioningPlans = await inspectProvisioningGroups(
      projectRoot,
      render,
      requestedProvisioningGroups(manifest, plan)
    );
    for (const group of provisioningPlans.filter((candidate) =>
      candidate.blocked && candidate.reason
    )) {
      checks.push({
        id: `project-component:${group.group}`,
        label: `project component ${group.group}`,
        severity: 'fail',
        state: 'migration-required',
        detail: group.reason!,
        remedy: 'Plan an explicit reviewed infrastructure migration; update and --force cannot relocate state or rewrite project-owned infrastructure.'
      });
    }
    const driftCount =
      entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash).length +
      provisioningPlans.length +
      (manifest.artifactVersion === 7 ? 0 : 1);
    if (driftCount > 0) {
      checks.push({
        label: 'managed core',
        severity: 'warn',
        detail: `${driftCount} core maintenance action(s) available`,
        remedy: 'run liftoff update'
      });
    } else {
      checks.push({
        label: 'managed core',
        severity: 'ok',
        detail: 'Liftoff core is current; project templates are not compared'
      });
    }
  } catch (error) {
    checks.push({
      label: 'managed core',
      severity: 'fail',
      detail: `liftoff.config.json could not be evaluated: ${(error as Error).message.split('\n')[0]}`,
      remedy: 'repair liftoff.config.json'
    });
  }

  return { title: 'Project', checks };
}

async function runtimeLayer(
  projectRoot: string,
  dockerAvailable: boolean,
  runner: CommandRunner,
  manifest: LiftoffManifest
): Promise<DoctorLayer> {
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
    const result = await runner.run(
      { executable: 'docker', args: ['compose', 'config', '-q'] },
      { cwd: projectRoot, timeoutMs: 15_000 }
    );
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

function renderDoctorLayers(layers: DoctorLayer[], presentation: PresentationSession): void {
  const statusKind = {
    ok: 'success',
    warn: 'warning',
    fail: 'error',
    skipped: 'pending'
  } as const;
  for (const layer of layers) {
    presentation.section(layer.title, layer.checks.flatMap((check) => {
      const remedy = check.remedy ? ` - ${check.remedy}` : '';
      return presentation.stdout
        .status(statusKind[check.severity], check.label, `${check.detail}${remedy}`)
        .trimEnd()
        .split('\n');
    }));
  }
}

export function doctorExitCode(layers: DoctorLayer[]): number {
  return layers.some((layer) => layer.checks.some((check) => check.severity === 'fail')) ? 1 : 0;
}

export interface DoctorRequest {
  json: boolean;
  cloud?: string;
}

export async function diagnoseProject(request: DoctorRequest, context: ExecutionContext): Promise<number> {
  const { json: jsonMode, cloud: cloudOverride } = request;
  const layers: DoctorLayer[] = [];
  context.presentation.commandIdentity('doctor', 'Inspect CLI, workstation, project, runtime, and cloud readiness');
  const runner = context.runner ?? new NodeCommandRunner();

  const projectRoot = await findProjectRoot(context.cwd);
  let manifest: LiftoffManifest | undefined;
  let manifestError: Error | undefined;
  if (projectRoot) {
    try {
      manifest = await loadManifest(projectRoot);
    } catch (error) {
      manifestError = error as Error;
      if (isRetiredPowerAppsError(error)) {
        throw error;
      }
    }
  }

  const releaseLookup = context.stableReleaseLookup ?? (() =>
    lookupStableRelease({ registry: canonicalNpmRegistry }));
  const configuredRegistryLookup =
    context.configuredRegistryTargetLookup ??
    ((targetVersion) => checkConfiguredRegistryTarget(targetVersion, {
      runner,
      environment: context.env ?? process.env
    }));
  layers.push(await cliLayer(releaseLookup, configuredRegistryLookup));
  const requirements = manifest
    ? selectWorkstationRequirements(
        workstationSelectionFromManifest(manifest),
        { includeFramework: manifest.framework.state === 'initialized' }
      )
    : selectLiftoffRuntimeRequirements();
  const probes = await probeWorkstation(requirements, runner);
  const environment = workstationLayer(probes);
  layers.push(environment);
  const dockerAvailable = probes.some((probe) => probe.requirement.id === 'docker' && probe.state === 'ready');

  if (projectRoot) {
    if (manifestError) {
      layers.push({
        title: 'Project',
        checks: [{ label: 'manifest', severity: 'fail', detail: manifestError.message, remedy: 'regenerate the project or use a matching CLI version' }]
      });
    }

    if (manifest) {
      layers.push(await projectLayer(projectRoot, manifest, runner));
      layers.push(await runtimeLayer(projectRoot, dockerAvailable, runner, manifest));

      {
        const workload = manifest.project.workload;
        const cloud = cloudOverride ?? workload.cloud;
        const cloudChecks = await cloudLayer(cloud, runner);
        const pattern = workload.kind === 'genai'
          ? patterns.find((candidate) => candidate.id === workload.pattern)
          : undefined;
        if (pattern?.worker && cloud === 'azure') {
          const functionsAvailable = await binaryPresent('func', runner);
          cloudChecks.checks.push(
            functionsAvailable
              ? { label: 'functions tooling', severity: 'ok', detail: 'Azure Functions Core Tools installed' }
              : { label: 'functions tooling', severity: 'warn', detail: 'Azure Functions Core Tools not found', remedy: 'npm install -g azure-functions-core-tools@4' }
          );
        }
        layers.push(cloudChecks);
      }
    }
  } else if (cloudOverride) {
    layers.push(await cloudLayer(cloudOverride, runner));
  }

  const failures = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'fail').length, 0);
  const warnings = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'warn').length, 0);

  if (jsonMode) {
    context.presentation.rawStdout(
      `${JSON.stringify({ schemaVersion: 1, layers, summary: { failures, warnings } }, null, 2)}\n`
    );
  } else {
    renderDoctorLayers(layers, context.presentation);
    context.presentation.status(
      failures > 0 ? 'error' : warnings > 0 ? 'warning' : 'success',
      'Doctor summary',
      `${failures} failure(s), ${warnings} warning(s)`
    );
  }

  return doctorExitCode(layers);
}
