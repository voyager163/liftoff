import { readFileSync } from 'node:fs';
import type {
  GeneratedArtifact,
  ProjectPlan
} from './types.js';
import { supportedStack } from './supported-stack.js';

export const governancePolicySchemaVersion = 1 as const;
export const governancePolicyVersion = '2' as const;
export const governanceContextSchemaVersion = 1 as const;

export const governanceArtifactPaths = {
  policy: ['.liftoff', 'governance', 'policy.md'],
  context: ['.liftoff', 'governance', 'context.json'],
  guide: ['.liftoff', 'governance', 'README.md'],
  'github-copilot': [
    '.github',
    'prompts',
    'liftoff-repository-governance.prompt.md'
  ],
  claude: [
    '.claude',
    'commands',
    'liftoff-repository-governance.md'
  ]
} as const;

const suppliedPolicy = readFileSync(
  new URL(
    '../assets/governance/single-maintainer-gitflow/policy.md',
    import.meta.url
  ),
  'utf8'
).replace(/\r\n/g, '\n').trimEnd();

export function renderCanonicalGovernancePolicy(): string {
  const rendered = suppliedPolicy;
  validateGovernancePolicy(rendered);
  assertGovernanceContentSafe(rendered);
  return `${rendered.trimEnd()}\n`;
}

const requiredPolicyFragments = [
  'schemaVersion: 1',
  'profile: single-maintainer-gitflow',
  'policyVersion: "2"',
  'develop` is the integration branch and the **default branch**',
  'main` is production truth',
  'release/X.Y.Z',
  'hotfix/X.Y.Z',
  'required_approving_review_count: 0',
  'require_code_owner_review: false',
  'require_last_push_approval: false',
  'Do not create a `CODEOWNERS` file',
  'no required reviewers',
  'GITHUB_TOKEN',
  'Repository-scoped only',
  'One exception only:',
  'GitHub-hosted larger runner with',
  'Azure VNet injection',
  'Pre-answered platform defaults',
  'Dev LRS',
  'ZRS in every environment',
  'Production: zone-redundant HA',
  'User-assigned managed identity with OIDC federation',
  'Small — fewer than 1,000 users',
  'Cost-optimised with production safeguards',
  'GitHub Actions secret at the environment level',
  'Active LTS only',
  'Provision nothing that no code uses',
  'known service limits',
  'refactor the IaC to match the live resources and import',
  'GitHub Secret Protection',
  'Dependabot + Dependency Review',
  'CodeQL + Copilot Autofix',
  'Checkov',
  'Trivy',
  'Grype',
  'OWASP ZAP',
  'slsa-github-generator',
  'The SLSA L3 generator is the one approved exception to SHA-pinning',
  'expiring action-reference exception',
  'wildcard, blanket exemption',
  'OSSF Scorecard',
  'Explicitly excluded as duplicates',
  'build once',
  'qualified release or hotfix candidate SHA',
  'production `main` merge SHA',
  'explicitly dispatch',
  'zero traffic',
  'fresh baseline revision',
  'Rollback must never be gated',
  'Alerting is infrastructure as code',
  'Route everything to Slack',
  'Add a heartbeat',
  'Test that each alert fires',
  'shallow from deep checks',
  'DORA four keys',
  'trusted_root.jsonl',
  'Fail-closed sequencing.',
  'Prove each check fails',
  'STOP FOR EXPLICIT USER APPROVAL',
  'governance/activation-baseline.json',
  'rulesets idempotently last',
  'read the live rulesets'
] as const;

const forbiddenPolicyFragments = [
  'DAST must run on a self-hosted runner',
  'self-hosted runner group with Staging access exists'
] as const;

export function validateGovernancePolicy(policy: string): void {
  const missing = requiredPolicyFragments.filter((fragment) =>
    !policy.includes(fragment)
  );
  if (missing.length > 0) {
    throw new Error(
      `Governance policy is missing required contract fragment: ${missing[0]}`
    );
  }
  const forbidden = forbiddenPolicyFragments.find((fragment) =>
    policy.includes(fragment)
  );
  if (forbidden) {
    throw new Error(
      `Governance policy contains forbidden legacy contract fragment: ${forbidden}`
    );
  }
  if (
    !/No change in this repository\s+requires another person's approval/.test(policy) ||
    !policy.includes('Never enable a ruleset whose required contexts have not been observed green')
  ) {
    throw new Error('Governance policy does not preserve fail-closed single-maintainer invariants.');
  }
}

const secretValuePatterns = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/,
  /\bAccountKey=[^;\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
] as const;

export function assertGovernanceContentSafe(content: string): void {
  for (const pattern of secretValuePatterns) {
    if (pattern.test(content)) {
      throw new Error('Governance artifact contains a credential-shaped value.');
    }
  }
}

interface GovernanceCommand {
  id: string;
  cwdPathParts: string[];
  executable: string;
  args: string[];
}

function apiCommands(plan: Exclude<ProjectPlan, { workload: 'power-apps-code-app' }>): GovernanceCommand[] {
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
    {
      id: 'opentofu-format',
      cwdPathParts: ['infrastructure', 'opentofu', 'azure'],
      executable: 'tofu',
      args: ['fmt', '-check', '-recursive']
    },
    {
      id: 'opentofu-initialize',
      cwdPathParts: ['infrastructure', 'opentofu', 'azure'],
      executable: 'tofu',
      args: ['init', '-backend=false']
    },
    {
      id: 'opentofu-validate',
      cwdPathParts: ['infrastructure', 'opentofu', 'azure'],
      executable: 'tofu',
      args: ['validate']
    }
  ];
}

function governanceContext(plan: ProjectPlan): Record<string, unknown> {
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
      artifactForm: plan.workload === 'power-apps-code-app'
        ? 'browser-hosted-power-apps-code-app'
        : plan.includeFrontend
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

  if (plan.workload === 'power-apps-code-app') {
    return {
      ...common,
      supportedStack: {
        ...common.supportedStack,
        application: {
          react: supportedStack.npmProjects['power-apps-code-app']
            .resolved.dependencies.react,
          vite: supportedStack.npmProjects['power-apps-code-app']
            .resolved.devDependencies.vite,
          typescript: supportedStack.npmProjects['power-apps-code-app']
            .resolved.devDependencies.typescript,
          powerAppsSdk: supportedStack.npmProjects['power-apps-code-app']
            .resolved.dependencies['@microsoft/power-apps']
        }
      },
      source: {
        repository: plan.starter.repository,
        path: plan.starter.path,
        commit: plan.starter.commit
      },
      commands: [
        { id: 'root-install', cwdPathParts: [], executable: 'npm', args: ['ci'] },
        { id: 'root-lint', cwdPathParts: [], executable: 'npm', args: ['run', 'lint'] },
        { id: 'root-build', cwdPathParts: [], executable: 'npm', args: ['run', 'build'] }
      ],
      generatedBoundaries: {
        rootApplication: 'generated',
        backend: 'inapplicable',
        database: 'inapplicable',
        docker: 'inapplicable',
        opentofu: 'inapplicable',
        apiEnvironments: 'inapplicable',
        customContainerPromotion: 'inapplicable',
        apiDast: 'inapplicable',
        backendHealth: 'inapplicable',
        powerPlatformDeployment: 'live-discovery-required'
      },
      environments: []
    };
  }

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
    commands: apiCommands(plan),
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
      opentofu: {
        state: 'generated-not-deployed',
        pathParts: ['infrastructure', 'opentofu', 'azure']
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

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function renderGovernanceContext(plan: ProjectPlan): string {
  const value = governanceContext(plan);
  validateGovernanceContext(value);
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  assertGovernanceContentSafe(rendered);
  return rendered;
}

function renderGovernanceGuide(plan: ProjectPlan): string {
  const launchers = plan.agents.map((agent) =>
    agent.id === 'github-copilot'
      ? '- GitHub Copilot: `/liftoff-repository-governance` from the repository root.'
      : '- Claude Code: `/liftoff-repository-governance` from the repository root.'
  ).join('\n');
  return `# Repository governance handoff

State: **handoff generated; live enforcement is not active**.

Liftoff generated deterministic policy and workload context only. It did not
create or change branches, commits, tags, remotes, pull requests, releases,
rulesets, GitHub settings, security features, environments, runners, cloud
resources, deployments, monitoring, alerts, or Slack routes.

## Before activation

1. Review \`policy.md\` and \`context.json\`.
2. Commit the complete project and push it to its intended GitHub repository.
3. Invoke one selected-agent launcher:

${launchers}

4. The agent performs read-only Phase 0, reports evidence, gaps,
   inapplicable controls, the proposed current \`main\` activation SHA, and an
   ordered plan.
5. The agent stops. Explicitly approve or revise that conversational plan.
   This approval is required before implementation and is distinct from the
   policy's prohibition on human merge or deployment approval gates.
6. After approval, the agent creates a new ${plan.specWorkflow.label}
   governance change. Liftoff does not own or recreate that change.

Live status must be proven from user-owned activation evidence and GitHub
read-back, never inferred from these local files.
`;
}

function renderAgentLauncher(plan: ProjectPlan): string {
  return `# Activate Liftoff repository governance

Require a committed and pushed GitHub repository. Read
\`.liftoff/governance/policy.md\` and
\`.liftoff/governance/context.json\` as the canonical inputs.

Perform only the policy's read-only Phase 0. Report all evidence, gaps,
inapplicable controls, GitFlow or continuous-delivery conflicts, the proposed
current \`main\` activation baseline SHA, and the ordered implementation plan.
Then stop for explicit user approval.

Before approval, do not write files, create a ${plan.specWorkflow.label} change,
mutate Git, call a mutating GitHub API, configure security, deploy, or create
monitoring. After approval, create a new ${plan.specWorkflow.label} governance
change from the discovered facts. Never treat the Liftoff handoff as live
enforcement and never create or modify
\`governance/activation-baseline.json\` before approval.
`;
}

export function buildRepositoryGovernanceArtifacts(
  plan: ProjectPlan
): GeneratedArtifact[] {
  if (plan.governanceProfile.id === 'none') {
    return [];
  }
  const policy = renderCanonicalGovernancePolicy();
  const context = renderGovernanceContext(plan);
  const guide = `${renderGovernanceGuide(plan).trimEnd()}\n`;
  const launcher = `${renderAgentLauncher(plan).trimEnd()}\n`;
  const artifacts: GeneratedArtifact[] = [
    {
      logicalName: 'repository-governance-policy',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.policy],
      content: policy
    },
    {
      logicalName: 'repository-governance-context',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.context],
      content: context
    },
    {
      logicalName: 'repository-governance-guide',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.guide],
      content: guide
    },
    ...plan.agents.map((agent): GeneratedArtifact => ({
      logicalName: agent.id === 'github-copilot'
        ? 'repository-governance-copilot-launcher'
        : 'repository-governance-claude-launcher',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths[agent.id]],
      content: launcher
    }))
  ];
  for (const artifact of artifacts) {
    assertGovernanceContentSafe(artifact.content);
  }
  return artifacts;
}
