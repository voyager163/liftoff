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
  NodeCommandRunner,
  type CommandRunner
} from '../../process-runner.js';
import {
  compareSemver
} from '../../semver.js';
import { runNativeOwnerUpgrade, type NativeUpgradeResult } from '../distribution/native-upgrade.js';
import {
  packagedSupportedStack as supportedStack
} from '../../adapters/packaged-assets/supported-stack.js';
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
  LiftoffManifest,
  ProviderId
} from '../../domain/project/contracts.js';
import {
  liftoffVersion
} from '../../version.js';
import {
  isRetiredPowerAppsError
} from '../../domain/project/retired-workload.js';
import {
  probeWorkstation,
  observeLiftoffRuntime,
  selectWorkstationRequirements,
  workstationScopeReadiness,
  type ExecutableIdentity,
  type RequirementReasonCode,
  type RequirementProbeResult,
  type WorkstationRequirementSelection
} from '../../workstation.js';
import type { InstallationOwner } from '../../domain/distribution/contracts.js';
import { inspectProjectUpdate, UpdatePlanError } from '../update/inspection.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { bindGovernanceTransitionContext } from '../../governance-activation/transition-context.js';

interface DoctorCheck {
  id?: string;
  label: string;
  severity: 'ok' | 'warn' | 'fail' | 'skipped';
  state?: string;
  requirementSeverity?: 'blocking' | 'advisory';
  detail: string;
  nativeUpgrade?: NativeUpgradeResult;
  remedy?: string;
  reasonCode?: RequirementReasonCode;
  executable?: ExecutableIdentity;
  required?: RequirementProbeResult['required'];
  observedVersion?: string;
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
    reasonCode: probe.reasonCode,
    executable: probe.identity,
    required: probe.required,
    ...(probe.detectedVersion ? { observedVersion: probe.detectedVersion } : {}),
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

function workstationSelectionFromManifest(
  manifest: LiftoffManifest,
  options?: { cloudOverride?: string }
): WorkstationRequirementSelection {
  const framework = getFrameworkDefinition(manifest.project.specWorkflow);
  const workload = manifest.project.workload;
  const agents = manifest.framework.state === 'initialized'
    ? manifest.project.agents.map((id) => {
        const agent = getCodingAgent(id);
        if (!agent) {
          throw new Error(`Manifest references unknown coding agent ${id}.`);
        }
        return { id: agent.id, label: agent.label };
      })
    : [];

  if (workload.kind === 'components') {
    const components = 'standards' in manifest && manifest.standards?.components
      ? manifest.standards.components.map((c) => ({
          id: c.id,
          profileId: c.profile.id
        }))
      : [];
    const provider = options?.cloudOverride ? { id: options.cloudOverride as ProviderId } : undefined;
    return {
      workload: {
        kind: 'components',
        components,
        ...(provider ? { provider } : {})
      },
      specWorkflow: { id: manifest.project.specWorkflow },
      framework: { version: framework.version },
      agents
    };
  }

  return {
    workload: {
      kind: workload.kind,
      apiStack: { id: workload.apiStack },
      provider: { id: (options?.cloudOverride ?? workload.cloud) as ProviderId },
      frontend: workload.frontend
    },
    specWorkflow: { id: manifest.project.specWorkflow },
    framework: { version: framework.version },
    agents
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

  if (manifest.framework.state === 'uninitialized') {
    const frameworkLabel = getSpecWorkflow(manifest.framework.adapter)?.label ?? manifest.framework.adapter;
    return [{
      id: 'framework-uninitialized-state',
      label: 'framework state',
      severity: 'warn',
      state: 'uninitialized',
      detail: `Manifest records ${frameworkLabel} adapter without established integration.`,
      remedy: `Run the official ${frameworkLabel} initializer to establish integrations.`
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
  nativeCheck: () => Promise<NativeUpgradeResult>
): Promise<DoctorLayer> {
  const checks: DoctorCheck[] = [
    { label: 'version', severity: 'ok', detail: `Liftoff ${liftoffVersion}` },
    { ...doctorCheckFromProbe(observeLiftoffRuntime()), id: 'cli-runtime-node', label: 'CLI runtime' }
  ];
  let observed: NativeUpgradeResult;
  try {
    observed = await nativeCheck();
  } catch {
    checks.push({
      label: 'cli freshness', severity: 'warn', state: 'native-observation-error',
      detail: 'Native installation and release availability could not be verified; no freshness claim is available.',
      remedy: 'run liftoff installation inspect --json; preserve any retained owner-operation recovery records'
    });
    return { title: 'CLI', checks };
  }
  const nativeOwner = ['homebrew-cask', 'winget', 'direct'].includes(observed.owner);
  const ownerLabels: Record<InstallationOwner, string> = {
    'homebrew-cask': 'Homebrew cask', winget: 'WinGet', direct: 'Receipt-owned direct installation',
    npm: 'Historical npm installation', unlinked: 'Unlinked native candidate', unknown: 'Unverified installation origin'
  };
  const identityMatches = observed.currentVersion === liftoffVersion;
  const inspectionOnly = observed.schemaVersion === 1 && observed.distribution === 'native' &&
    observed.mode === 'check' && observed.status !== 'upgraded';
  checks.push({
    id: 'installation-owner', label: 'installation owner',
    severity: inspectionOnly && identityMatches && nativeOwner &&
      ['current', 'update-available'].includes(observed.status) ? 'ok' : 'warn',
    state: observed.owner, detail: ownerLabels[observed.owner]
  });
  if (!inspectionOnly) {
    checks.push({
      label: 'cli freshness', severity: 'fail', state: 'unexpected-native-operation',
      detail: 'The native checker returned an incompatible operation result; inspection cannot be treated as upgrade execution.',
      nativeUpgrade: observed,
      remedy: 'run liftoff installation inspect --json and inspect any original owner-operation record before further work'
    });
  } else if (observed.owner === 'npm') {
    checks.push({
      label: 'cli freshness', severity: 'warn', state: 'migration-required', nativeUpgrade: observed,
      detail: 'Historical npm does not discover current native releases.',
      remedy: 'use a verified unlinked native bundle for liftoff installation inspect --json; review exact owner migration separately'
    });
  } else if (!identityMatches) {
    checks.push({
      label: 'cli freshness', severity: 'warn', state: 'installation-version-mismatch', nativeUpgrade: observed,
      detail: 'The running CLI and observed installation versions differ; another PATH installation cannot establish freshness.',
      remedy: 'run liftoff installation inspect --json and resolve the exact installation identity'
    });
  } else if (nativeOwner && observed.status === 'current' &&
      observed.upstreamAvailability === 'current' && observed.ownerAvailability === 'current') {
    checks.push({
      label: 'cli freshness', severity: 'ok', state: 'native-current', nativeUpgrade: observed,
      detail: `running ${liftoffVersion}; verified native release and current owner agree`
    });
  } else if (nativeOwner && observed.status === 'update-available' &&
      observed.upstreamAvailability === 'available' && observed.ownerAvailability === 'available' && observed.targetVersion) {
    checks.push({
      label: 'cli freshness', severity: 'warn', state: 'native-update-available', nativeUpgrade: observed,
      detail: `Native Liftoff ${observed.targetVersion} is available through the current owner; running ${liftoffVersion}`,
      remedy: 'run liftoff upgrade --check; invoke liftoff upgrade only when owner-preserving replacement is requested'
    });
  } else {
    checks.push({
      label: 'cli freshness', severity: 'warn',
      state: observed.status === 'current' || observed.status === 'update-available'
        ? 'native-observation-incomplete' : observed.reasonCode,
      nativeUpgrade: observed,
      detail: `Native availability is unresolved or blocked (${observed.reasonCode}); upstream: ${observed.upstreamAvailability}, owner source: ${observed.ownerAvailability}.`,
      remedy: observed.recoveryRequired
        ? 'run liftoff installation inspect --json; preserve prior effects and use only the original owner-specific recovery'
        : 'run liftoff installation inspect --json; owner-source lag, policy and unavailable release authority require their scoped remedy, never npm fallback or automatic source refresh'
    });
  }
  return { title: 'CLI', checks };
}

async function componentProjectChecks(
  projectRoot: string,
  manifest: LiftoffManifest,
  _runner: CommandRunner
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const components = 'standards' in manifest && manifest.standards?.components
    ? manifest.standards.components
    : [];

  if (components.length === 0) {
    const rootPkg = path.join(projectRoot, 'package.json');
    if (existsSync(rootPkg)) {
      try {
        const pkg = JSON.parse(readFileSync(rootPkg, 'utf8'));
        checks.push({
          label: 'component package',
          severity: 'ok',
          detail: `valid package configuration (${pkg.name ?? 'root'})`
        });
      } catch (error) {
        checks.push({
          label: 'component package',
          severity: 'fail',
          detail: `invalid package.json at root: ${(error as Error).message}`,
          remedy: 'repair package.json'
        });
      }
    }
    return checks;
  }

  for (const component of components) {
    const relPath = component.rootPathParts.join('/') || '.';
    const componentRoot = path.join(projectRoot, ...component.rootPathParts);
    const profileId = component.profile.id;
    const label = component.id === profileId
      ? `${component.id} component`
      : `${component.id} (${profileId}) component`;

    if (profileId === 'vue-component' || profileId === 'frontend') {
      const pkgPath = path.join(componentRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        checks.push({
          label,
          severity: 'fail',
          detail: `missing package.json at ${relPath}`,
          remedy: `restore or repair package.json at ${relPath}`
        });
      } else {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          checks.push({
            label,
            severity: 'ok',
            detail: `valid component package configuration (${pkg.name ?? component.id})`
          });
        } catch (error) {
          checks.push({
            label,
            severity: 'fail',
            detail: `invalid package.json at ${relPath}: ${(error as Error).message}`,
            remedy: `repair package.json at ${relPath}`
          });
        }
      }
    } else if (profileId === 'python-fastapi' || profileId.startsWith('genai-')) {
      const pyprojectPath = path.join(componentRoot, 'pyproject.toml');
      if (!existsSync(pyprojectPath)) {
        checks.push({
          label,
          severity: 'fail',
          detail: `missing pyproject.toml at ${relPath}`,
          remedy: `restore or repair pyproject.toml at ${relPath}`
        });
      } else {
        checks.push({
          label,
          severity: 'ok',
          detail: `valid component configuration at ${relPath}`
        });
      }
    } else if (profileId === 'go-huma') {
      const modPath = path.join(componentRoot, 'go.mod');
      if (!existsSync(modPath)) {
        checks.push({
          label,
          severity: 'fail',
          detail: `missing go.mod at ${relPath}`,
          remedy: `restore or repair go.mod at ${relPath}`
        });
      } else {
        checks.push({
          label,
          severity: 'ok',
          detail: `valid component configuration at ${relPath}`
        });
      }
    } else if (profileId === 'node-fastify') {
      const pkgPath = path.join(componentRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        checks.push({
          label,
          severity: 'fail',
          detail: `missing package.json at ${relPath}`,
          remedy: `restore or repair package.json at ${relPath}`
        });
      } else {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          checks.push({
            label,
            severity: 'ok',
            detail: `valid component package configuration (${pkg.name ?? component.id})`
          });
        } catch (error) {
          checks.push({
            label,
            severity: 'fail',
            detail: `invalid package.json at ${relPath}: ${(error as Error).message}`,
            remedy: `repair package.json at ${relPath}`
          });
        }
      }
    } else {
      if (!existsSync(componentRoot)) {
        checks.push({
          label,
          severity: 'fail',
          detail: `component root missing at ${relPath}`,
          remedy: `restore or repair component root directory at ${relPath}`
        });
      } else {
        checks.push({
          label,
          severity: 'ok',
          detail: `component root present at ${relPath}`
        });
      }
    }
  }

  return checks;
}

async function projectLayer(
  projectRoot: string,
  manifest: LiftoffManifest,
  runner: CommandRunner,
  storage?: UpdatePreviewOptions
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
      remedy: 'run liftoff upgrade --check for the verified native owner; request an owner-preserving upgrade only if its source offers the required version. Preserve the project; legacy npm requires separately reviewed native handover.'
    });
  } else {
    checks.push({ label: 'version', severity: 'ok', detail: `manifest written by ${manifest.liftoffVersion}, CLI ${liftoffVersion}` });
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
    checks.push(...await governanceDoctorChecks(projectRoot, manifest, undefined, storage));
  }

  checks.push(...await frameworkDoctorChecks(projectRoot, manifest));
  if (manifest.project.workload.kind !== 'components' &&
    !(manifest.artifactVersion === 8 && manifest.provenance.kind === 'adopted')) {
    checks.push(await stackProjectCheck(
      projectRoot,
      manifest.project.workload.apiStack,
      runner
    ));
  } else {
    checks.push(...await componentProjectChecks(projectRoot, manifest, runner));
  }

  try {
    const inspection = await inspectProjectUpdate(projectRoot, { runner, storage });
    const { entries, provisioningPlans } = inspection;
    for (const group of provisioningPlans.filter((candidate) =>
      candidate.blocked && candidate.reason
    )) {
      checks.push({
        id: `project-component:${group.group}`,
        label: `project component ${group.group}`,
        severity: 'fail',
        state: 'migration-required',
        detail: group.reason!,
        remedy: 'Run liftoff update --check and follow its migration guidance; --force cannot relocate state or overwrite project-owned files.'
      });
    }
    const driftCount =
      entries.filter((entry) => entry.status !== 'unchanged' || entry.refreshHash).length +
      provisioningPlans.length +
      (inspection.ownershipMigrationPending ? 1 : 0);
    if (driftCount > 0) {
      checks.push({
        label: 'managed core',
        severity: 'warn',
        detail: `${driftCount} core maintenance action(s) available`,
        remedy: 'run liftoff update --check'
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
      severity: error instanceof UpdatePlanError && error.reasonCode === 'newer-project' ? 'warn' : 'fail',
      detail: `Update inspection failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`,
      remedy: error instanceof UpdatePlanError ? error.remedy : 'Repair the named input, then run liftoff update --check.'
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

export async function diagnoseProject(
  request: DoctorRequest,
  context: ExecutionContext
): Promise<number> {
  const { json: jsonMode, cloud: cloudOverride } = request;
  const layers: DoctorLayer[] = [];
  context.presentation.commandIdentity('doctor', 'Inspect CLI, workstation, project, runtime, and cloud readiness');
  const runner = context.runner ?? new NodeCommandRunner();

  const projectRoot = await findProjectRoot(context.cwd);
  let manifest: LiftoffManifest | undefined;
  let manifestError: Error | undefined;
  if (projectRoot && !manifest) {
    try {
      manifest = await loadManifest(projectRoot);
    } catch (error) {
      manifestError = error as Error;
      if (isRetiredPowerAppsError(error)) {
        throw error;
      }
    }
  }

  layers.push(await cliLayer(context.nativeUpgradeCheck ?? (() => runNativeOwnerUpgrade({
    mode: 'check', currentVersion: liftoffVersion, json: true, stdout: context.stdout, stderr: context.stderr
  }, { env: context.env, cwd: context.cwd, runner }))));
  const selectedRequirements = manifest
    ? selectWorkstationRequirements(
        workstationSelectionFromManifest(manifest, { cloudOverride }),
        { includeFramework: manifest.framework.state === 'initialized', scope: 'initialization' }
      ).filter((requirement) => requirement.id !== 'docker' || ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']
        .some((name) => existsSync(path.join(projectRoot!, name))))
    : [];
  const externalNode = selectedRequirements.some((requirement) => requirement.id === 'npm') ||
    selectedRequirements.some((requirement) => requirement.id === 'node' &&
      requirement.reasons.some((reason) => reason !== 'Liftoff runtime'));
  const requirements = selectedRequirements
    .filter((requirement) => requirement.id !== 'node' || externalNode)
    .map((requirement) => {
      if (requirement.id !== 'node') return requirement;
      const reasons = requirement.reasons.filter((reason) => reason !== 'Liftoff runtime');
      return { ...requirement, reasons: reasons.length ? reasons : ['Project dependency manager runtime'] };
    });
  const probes = await probeWorkstation(requirements, runner, {
    ...context.workstationProbe, cwd: projectRoot ?? context.cwd, env: context.env ?? context.workstationProbe?.env
  });
  const readiness = workstationScopeReadiness(probes, manifest ? 'local' : 'initialization');
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
      const { storage } = bindGovernanceTransitionContext({
        storage: { ...context.updatePreview, env: context.updatePreview?.env ?? context.env }
      });
      layers.push(await projectLayer(projectRoot, manifest, runner, storage));
      layers.push(await runtimeLayer(projectRoot, dockerAvailable, runner, manifest));

      {
        const workload = manifest.project.workload;
        const cloud = cloudOverride ?? (workload.kind !== 'components' ? workload.cloud : undefined);
        if (cloud) {
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
    }
  } else if (cloudOverride) {
    layers.push(await cloudLayer(cloudOverride, runner));
  }

  const failures = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'fail').length, 0);
  const warnings = layers.reduce((count, layer) => count + layer.checks.filter((check) => check.severity === 'warn').length, 0);

  if (jsonMode) {
    context.presentation.rawStdout(
      `${JSON.stringify({
        schemaVersion: 1, layers, summary: { failures, warnings },
        workstation: {
          scope: readiness.scope, ready: readiness.ready,
          blockingTools: readiness.toolFailures.map((probe) => ({ id: probe.requirement.id, reasonCode: probe.reasonCode })),
          authenticationRequiredForLocal: false
        }
      }, null, 2)}\n`
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
