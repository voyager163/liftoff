import type { ProjectPlan } from '../../domain/project/contracts.js';
import { packagedSupportedStack as supportedStack } from '../../adapters/packaged-assets/supported-stack.js';
import { governancePolicyVersion, assertGovernanceContentSafe } from '../../domain/governance/policy/content-validation.js';

export const governanceContextSchemaVersion = 1 as const;

export interface GovernanceContextOptions {
  infrastructureLayout?: 'independent' | 'legacy-shared' | 'unknown';
}

export interface GovernanceCommand {
  id: string;
  cwdPathParts: string[];
  executable: string;
  args: string[];
}

export const azureInfrastructureRoot = ['infrastructure', 'opentofu', 'azure'];

export function infrastructureCommands(
  plan: ProjectPlan,
  layout: NonNullable<GovernanceContextOptions['infrastructureLayout']>
): GovernanceCommand[] {
  if (layout !== 'independent') return [];
  const roots = plan.environments.map(environment => ({
    suffix: `-${environment.id}`,
    pathParts: [...azureInfrastructureRoot, 'environments', environment.id]
  }));
  return [
    {
      id: 'opentofu-format',
      cwdPathParts: azureInfrastructureRoot,
      executable: 'tofu',
      args: ['fmt', '-check', '-recursive']
    },
    ...roots.flatMap(root => [
      {
        id: `opentofu-initialize${root.suffix}`,
        cwdPathParts: root.pathParts,
        executable: 'tofu',
        args: ['init', '-backend=false']
      },
      {
        id: `opentofu-validate${root.suffix}`,
        cwdPathParts: root.pathParts,
        executable: 'tofu',
        args: ['validate']
      }
    ])
  ];
}

export function apiCommands(
  plan: ProjectPlan,
  infrastructureLayout: NonNullable<GovernanceContextOptions['infrastructureLayout']>
): GovernanceCommand[] {
  const backend = plan.apiStack.id === 'python-fastapi'
    ? [
        {
          id: 'backend-install',
          cwdPathParts: ['backend'],
          executable: 'uv',
          args: [
            'sync',
            '--frozen',
            '--extra',
            'test',
            ...(plan.workload === 'genai' && plan.pattern.worker
              ? ['--extra', 'functions']
              : [])
          ]
        },
        {
          id: 'backend-test',
          cwdPathParts: ['backend'],
          executable: 'uv',
          args: ['run', 'python', '-m', 'pytest', '-q']
        }
      ]
    : plan.apiStack.id === 'node-fastify'
      ? [
          {
            id: 'backend-install',
            cwdPathParts: ['backend'],
            executable: 'npm',
            args: ['ci']
          },
          {
            id: 'backend-build',
            cwdPathParts: ['backend'],
            executable: 'npm',
            args: ['run', 'build']
          },
          {
            id: 'backend-test',
            cwdPathParts: ['backend'],
            executable: 'npm',
            args: ['test']
          }
        ]
      : [
          {
            id: 'backend-install',
            cwdPathParts: ['backend'],
            executable: 'go',
            args: ['mod', 'download']
          },
          {
            id: 'backend-test',
            cwdPathParts: ['backend'],
            executable: 'go',
            args: ['test', './...']
          }
        ];
  return [
    ...backend,
    ...(plan.includeFrontend
      ? [
          {
            id: 'frontend-install',
            cwdPathParts: ['frontend'],
            executable: 'npm',
            args: ['ci']
          },
          {
            id: 'frontend-build',
            cwdPathParts: ['frontend'],
            executable: 'npm',
            args: ['run', 'build']
          }
        ]
      : []),
    ...(plan.workload === 'genai' && plan.pattern.worker
      ? [{
          id: 'function-worker-test',
          cwdPathParts: ['functions', `${plan.pattern.id}-worker`],
          executable: 'uv',
          args: [
            'run',
            '--project',
            '../../backend',
            '--directory',
            '.',
            'python',
            '-m',
            'pytest',
            '-q'
          ]
        }]
      : []),
    {
      id: 'local-stack-validate',
      cwdPathParts: [],
      executable: 'docker',
      args: ['compose', 'config', '-q']
    },
    ...infrastructureCommands(plan, infrastructureLayout)
  ];
}

export function governanceContext(plan: ProjectPlan, options: GovernanceContextOptions): Record<string, unknown> {
  const infrastructureLayout = options.infrastructureLayout ?? 'independent';
  if (!['independent', 'legacy-shared', 'unknown'].includes(infrastructureLayout)) {
    throw new Error(`Unsupported governance infrastructure layout: ${JSON.stringify(infrastructureLayout)}.`);
  }
  const common = {
    schemaVersion: governanceContextSchemaVersion,
    policy: {
      profile: plan.governanceProfile.id,
      version: governancePolicyVersion,
      state: 'handoff-generated',
      liveEnforcement: 'not-active'
    },
    project: {
      name: plan.projectName,
      safeName: plan.safeProjectName,
      workload: plan.workload,
      artifactForm: plan.includeFrontend
        ? 'containerized-api-with-web-frontend'
        : 'containerized-api'
    },
    supportedStack: {
      id: supportedStack.id,
      verifiedOn: supportedStack.verifiedOn,
      node: supportedStack.runtimes.node.version,
      npm: supportedStack.packageManagers.npm.version,
      framework: {
        id: plan.framework.id,
        version: plan.framework.version
      }
    },
    agents: plan.agents.map((agent) => agent.id),
    framework: {
      id: plan.specWorkflow.id,
      version: plan.framework.version,
      ...(plan.defaultAgent
        ? { defaultAgent: plan.defaultAgent.id }
        : {})
    },
    discovery: {
      githubRepository: 'undiscovered',
      defaultBranch: 'undiscovered',
      refs: 'undiscovered',
      workflowsAndExactChecks: 'undiscovered',
      rulesets: 'undiscovered',
      releasesAndTags: 'undiscovered',
      licensedSecurityFeatures: 'undiscovered',
      privateRunnerAccess: 'undiscovered',
      liveDeployments: 'undiscovered',
      parallelVersionCapability: 'undiscovered',
      canaryTrafficVolume: 'undiscovered',
      monitoringAndAlerts: 'undiscovered',
      slackSeverityRoutes: 'undiscovered',
      providerStatus: 'undiscovered'
    }
  };

  const worker = plan.workload === 'genai' && plan.pattern.worker;
  return {
    ...common,
    supportedStack: {
      ...common.supportedStack,
      backendRuntime: plan.apiStack.id === 'python-fastapi'
        ? supportedStack.runtimes.python.version
        : plan.apiStack.id === 'node-fastify'
          ? supportedStack.runtimes.node.version
          : supportedStack.runtimes.go.version,
      opentofu: supportedStack.runtimes.opentofu.version
    },
    api: {
      stack: plan.apiStack.id,
      ...(plan.workload === 'genai'
        ? { pattern: plan.pattern.id }
        : {})
    },
    commands: apiCommands(plan, infrastructureLayout),
    generatedBoundaries: {
      backend: {
        state: 'generated',
        pathParts: ['backend']
      },
      frontend: plan.includeFrontend
        ? { state: 'generated', pathParts: ['frontend'] }
        : { state: 'inapplicable' },
      worker: worker
        ? {
            state: 'generated',
            pathParts: ['functions', `${plan.pattern.id}-worker`]
          }
        : { state: 'inapplicable' },
      docker: {
        state: 'generated',
        pathParts: ['docker-compose.yml']
      },
      opentofu: infrastructureLayout === 'unknown'
        ? {
            state: 'not-observed',
            layout: infrastructureLayout,
            compatibility: 'migration-required',
            reason: 'No supported recorded infrastructure layout; no infrastructure commands are proposed.'
          }
        : {
            state: 'generated-not-deployed',
            pathParts: azureInfrastructureRoot,
            layout: infrastructureLayout,
            provenance: options.infrastructureLayout === undefined ? 'current-generation' : 'recorded-generation',
            filesystemObservation: 'not-performed',
            ...(infrastructureLayout === 'independent'
              ? {
                  sharedApplicationModulePathParts: [...azureInfrastructureRoot, 'modules', 'application'],
                  environmentRoots: plan.environments.map(environment => ({
                    environment: environment.id,
                    pathParts: [...azureInfrastructureRoot, 'environments', environment.id],
                    tfvarsPathParts: [...azureInfrastructureRoot, 'environments', environment.id, `${environment.id}.tfvars`]
                  }))
                }
              : {
                  compatibility: 'migration-required',
                  reason: 'Recorded infrastructure shares one state root. Environment isolation requires a separate reviewed migration.',
                  environmentRoots: []
                })
          }
    },
    environments: plan.environments.map((environment) => environment.id),
    deployment: {
      provider: plan.provider.id,
      region: plan.region.slug,
      liveState: 'undiscovered',
      customContainerPromotion: 'requires-live-discovery',
      apiDast: 'requires-live-staging-and-runner-discovery'
    },
    health: [
      {
        component: 'backend',
        path: '/health',
        depth: 'shallow'
      },
      {
        component: 'backend',
        path: '/ready',
        depth: 'shallow',
        gap: 'generated endpoint does not prove dependency reachability'
      }
    ]
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateGovernanceContext(value: unknown): void {
  if (!isRecord(value) || value.schemaVersion !== governanceContextSchemaVersion) {
    throw new Error('Governance context must use schemaVersion 1.');
  }
  if (!isRecord(value.policy)) {
    throw new Error('Governance context policy identity is missing.');
  }
  if (
    value.policy.profile !== 'single-maintainer-gitflow' ||
    value.policy.version !== governancePolicyVersion ||
    value.policy.state !== 'handoff-generated' ||
    value.policy.liveEnforcement !== 'not-active'
  ) {
    throw new Error('Governance context cannot claim live enforcement.');
  }
  if (!isRecord(value.discovery)) {
    throw new Error('Governance context discovery state is missing.');
  }
  if (Object.values(value.discovery).some((entry) => entry !== 'undiscovered')) {
    throw new Error('Governance context contains a fabricated live discovery fact.');
  }
  if (!Array.isArray(value.commands) || value.commands.length === 0) {
    throw new Error('Governance context must contain real generated commands.');
  }
  if (!isRecord(value.generatedBoundaries)) {
    throw new Error('Governance context generated boundaries are missing.');
  }
}

export function renderGovernanceContext(plan: ProjectPlan, options: GovernanceContextOptions = {}): string {
  const value = governanceContext(plan, options);
  validateGovernanceContext(value);
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  assertGovernanceContentSafe(rendered);
  return rendered;
}
