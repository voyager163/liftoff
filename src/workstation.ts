import { packagedSupportedStack as supportedStack } from './adapters/packaged-assets/supported-stack.js';
import {
  workstationRequirementCatalog,
  type RequirementSeverity,
  type WorkstationRequirementId
} from './workstation-catalog.js';
import { compareVersions } from './domain/workstation/versions.js';
import type {
  ReadinessNotice,
  RequirementProbeResult,
  SelectedRequirement,
  WorkstationScope
} from './domain/workstation/contracts.js';
import type {
  ApiStackId,
  CodingAgentId,
  ProviderId,
  ProjectPlan,
  SpecWorkflowId
} from './domain/project/contracts.js';

export { extractVersion } from './domain/workstation/versions.js';
export { nativeExecutableObserver } from './adapters/filesystem/executables.js';
export type { ExecutableObserver, ExecutableObservationContext } from './domain/workstation/executables.js';
export type { RemediationRecipe } from './workstation-catalog.js';
export type {
  ExecutableIdentity,
  InstallationOrigin,
  NoProgressRemediationAttempt,
  RemediationAttempt,
  RemediationOperation,
  RemediationProgress,
  RequirementReasonCode,
  ToolProbeObservation,
  ToolUpdateObservation,
  WorkstationScope,
  WorkstationNoProgressStore
} from './domain/workstation/contracts.js';
export type {
  HostEnvironment,
  InstallResult,
  InstallState,
  ReadinessNotice,
  RemediationSelection,
  RequirementProbeResult,
  RequirementState,
  SelectedRequirement
} from './domain/workstation/contracts.js';
export {
  probeRequirement,
  probeWorkstation,
  type WorkstationProbeOptions
} from './application/workstation/probe.js';
export {
  installRequirement,
  selectRemediation,
  type InstallContext
} from './application/workstation/remediation.js';
export {
  compareRequirementObservations,
  parseLinuxFamily
} from './domain/workstation/remediation.js';
export { detectHostEnvironment } from './adapters/filesystem/host-environment.js';

export interface WorkstationRequirementSelection {
  workload: {
    kind: 'genai' | 'standard';
    apiStack: { id: ApiStackId };
    provider: { id: ProviderId };
    frontend?: boolean;
  };
  specWorkflow: { id: SpecWorkflowId | 'manual' };
  framework: { version: string } | null;
  agents: Array<{ id: CodingAgentId; label: string }>;
}

export interface RequirementSelectionOptions {
  includeFramework?: boolean;
  scope?: WorkstationScope;
  requiredTools?: readonly WorkstationRequirementId[];
}

const REQUIREMENT_ORDER: WorkstationRequirementId[] = [
  'node',
  'npm',
  'python',
  'go',
  'uv',
  'docker',
  'opentofu',
  'azure-cli',
  'openspec',
  'spec-kit',
  'github-copilot',
  'claude',
  'codex',
  'github-cli'
];

export function selectLiftoffRuntimeRequirements(): SelectedRequirement[] {
  const definition = workstationRequirementCatalog.node;
  return [{
    id: 'node',
    definition,
    severity: definition.severity,
    reasons: ['Liftoff runtime'],
    minimumVersion: definition.minimumVersion,
    releaseLine: definition.releaseLine,
    allowPrerelease: definition.allowPrerelease ?? false
  }];
}

export function selectWorkstationRequirements(
  plan: ProjectPlan | WorkstationRequirementSelection,
  options: RequirementSelectionOptions = {}
): SelectedRequirement[] {
  if (!['openspec', 'spec-kit', 'manual'].includes(plan.specWorkflow.id)) {
    throw new Error('Workstation prerequisite selection requires a supported workflow.');
  }
  const scope = options.scope ?? 'initialization';
  const selected = new Map<WorkstationRequirementId, SelectedRequirement>();
  const add = (
    id: WorkstationRequirementId,
    reason: string,
    overrides: { severity?: RequirementSeverity; minimumVersion?: string; exactVersion?: string } = {}
  ) => {
    const definition = workstationRequirementCatalog[id];
    const existing = selected.get(id);
    const minimumVersion = overrides.minimumVersion ?? definition.minimumVersion;
    const exactVersion = overrides.exactVersion ?? definition.exactVersion;
    if (existing) {
      existing.reasons.push(reason);
      if (overrides.severity === 'blocking') existing.severity = 'blocking';
      if (minimumVersion && (!existing.minimumVersion || compareVersions(minimumVersion, existing.minimumVersion) > 0)) {
        existing.minimumVersion = minimumVersion;
      }
      return;
    }
    selected.set(id, {
      id,
      definition,
      severity: overrides.severity ?? definition.severity,
      reasons: [reason],
      ...(minimumVersion ? { minimumVersion } : {}),
      ...(exactVersion ? { exactVersion } : {}),
      ...(definition.releaseLine ? { releaseLine: definition.releaseLine } : {}),
      allowPrerelease: definition.allowPrerelease ?? false,
      scope
    });
  };

  const workload = typeof plan.workload === 'string'
    ? {
        kind: plan.workload,
        apiStack: { id: plan.apiStack.id },
        provider: { id: plan.provider.id }
      }
    : plan.workload;
  const includeFrontend = typeof plan.workload === 'string'
    ? plan.includeFrontend
    : plan.workload.frontend ?? false;
  add('node', 'Liftoff runtime', {
    minimumVersion: supportedStack.runtimes.node.minimumVersion
  });
  if (scope === 'activation' || scope === 'migration' || scope === 'lifecycle') {
    if (scope !== 'lifecycle') add('opentofu', `${scope} infrastructure operations`, { severity: 'blocking' });
    if (scope === 'activation') {
      add('github-cli', 'approved GitHub activation operations', { severity: 'blocking' });
      if (workload.provider.id === 'azure') add('azure-cli', 'approved Azure activation operations', { severity: 'blocking' });
    }
    for (const id of options.requiredTools ?? []) add(id, `required ${scope} operation`, { severity: 'blocking' });
    return REQUIREMENT_ORDER.flatMap((id) => selected.has(id) ? [selected.get(id)!] : []);
  }
  if (workload.apiStack.id === 'node-fastify') {
    add('npm', 'selected Node.js API dependency manager');
  }
  if (includeFrontend) {
    add('npm', 'selected frontend dependency manager');
  }
  if (workload.apiStack.id === 'python-fastapi') {
    add('python', 'selected Python API stack', {
      minimumVersion: supportedStack.runtimes.python.minimumVersion
    });
    add('uv', 'locked Python dependency manager');
  } else if (workload.apiStack.id === 'go-huma') {
    add('go', 'selected Go API stack', {
      minimumVersion: supportedStack.runtimes.go.minimumVersion
    });
  }

  if (plan.specWorkflow.id === 'openspec') {
    add('npm', 'OpenSpec installer and launcher');
    add('node', 'OpenSpec runtime', {
      minimumVersion: supportedStack.runtimes.node.minimumVersion
    });
    if (options.includeFramework !== false) {
      if (!plan.framework) throw new Error('OpenSpec prerequisite selection requires its framework contract.');
      add('openspec', 'selected spec-driven framework', { exactVersion: plan.framework.version });
    }
  } else if (plan.specWorkflow.id === 'spec-kit') {
    add('python', 'Spec Kit runtime', {
      minimumVersion: supportedStack.runtimes.python.minimumVersion
    });
    add('uv', 'Spec Kit installer and launcher');
    if (options.includeFramework !== false) {
      if (!plan.framework) throw new Error('Spec Kit prerequisite selection requires its framework contract.');
      add('spec-kit', 'selected spec-driven framework', { exactVersion: plan.framework.version });
    }
  }

  add('docker', scope === 'local' ? 'local Docker Compose configuration check' : 'generated local development stack',
    { severity: scope === 'local' ? 'blocking' : 'advisory' });
  add('opentofu', scope === 'local' ? 'local backend-disabled infrastructure checks' : 'generated infrastructure',
    { severity: scope === 'local' ? 'blocking' : 'advisory' });
  if (scope === 'initialization' && workload.provider.id === 'azure') {
    add('azure-cli', 'selected Azure cloud');
  }
  for (const agent of plan.agents) {
    add(agent.id, `selected ${agent.label} coding agent`);
  }
  for (const id of options.requiredTools ?? []) add(id, `required ${scope} operation`, { severity: 'blocking' });

  return REQUIREMENT_ORDER.flatMap((id) => {
    const requirement = selected.get(id);
    return requirement ? [requirement] : [];
  });
}

export function blockingReadinessFailures(results: RequirementProbeResult[]): RequirementProbeResult[] {
  return results.filter((result) =>
    result.requirement.severity === 'blocking' && (result.state !== 'ready' || result.reasonCode !== 'compatible')
  );
}

export interface WorkstationScopeReadiness {
  scope: WorkstationScope;
  ready: boolean;
  toolFailures: RequirementProbeResult[];
  authenticationFailures: Array<{ requirementId: WorkstationRequirementId; notice: ReadinessNotice }>;
}

/** Workstation prerequisites only; provider permissions, private access, and protected state remain separate gates. */
export function workstationScopeReadiness(
  results: RequirementProbeResult[],
  scope: WorkstationScope
): WorkstationScopeReadiness {
  const toolFailures = blockingReadinessFailures(results);
  const authenticationFailures: WorkstationScopeReadiness['authenticationFailures'] = [];
  if (scope === 'activation' || scope === 'migration' || scope === 'lifecycle') {
    for (const result of results) {
      if (result.requirement.severity !== 'blocking' || result.state !== 'ready' ||
          (result.requirement.id !== 'azure-cli' && result.requirement.id !== 'github-cli')) continue;
      const notice = result.notices.find((item) => item.code === 'authentication') ?? {
        code: 'authentication',
        label: `${result.requirement.definition.label} authentication`,
        state: 'not-observable',
        detail: 'The required authentication capability has not been observed.'
      };
      if (notice.state !== 'ready') authenticationFailures.push({ requirementId: result.requirement.id, notice });
    }
  }
  return { scope, ready: toolFailures.length === 0 && authenticationFailures.length === 0, toolFailures, authenticationFailures };
}
