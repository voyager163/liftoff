import { readFileSync } from 'node:fs';
import type {
  GeneratedArtifact,
  ProjectPlan
} from './types.js';
import { supportedStack } from './supported-stack.js';
import {
  canonicalJson
} from './governance-activation/canonical-json.js';
import {
  buildGovernanceCompatibilityMetadata,
  validateGovernanceCompatibilityMetadata,
  type ManagedCompatibilityInventoryEntry
} from './governance-activation/compatibility.js';
import {
  canonicalPhaseGraphJson,
  currentActivationIdentity
} from './governance-activation/graph.js';
import {
  activationContractVersion,
  activationStateSchemaVersion,
  approvalEnvelopeSchemaVersion,
  credentialPolicySchemaVersion,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  liftoffManifestArtifactVersion,
  phaseGraphSchemaVersion,
  supersessionSchemaVersion
} from './governance-activation/identity.js';
import {
  runnerPreflightDisplayNameTemplate,
  runnerPreflightOrganizationPermissions,
  runnerPreflightPatLifetimeDays,
  runnerPreflightRepositoryPermissions,
  runnerPreflightRotationLeadDays,
  runnerPreflightSecretName
} from './governance-activation/types.js';

export const governancePolicySchemaVersion = 1 as const;
export const governancePolicyVersion = '6' as const;
export const governanceContextSchemaVersion = 1 as const;
const governanceManagedCoreLogicalNames = [
  'repository-governance-policy',
  'repository-governance-context',
  'repository-governance-guide',
  'repository-governance-phase-graph',
  'repository-governance-compatibility',
  'repository-governance-credential-policy-schema',
  'liftoff-setup-copilot',
  'liftoff-setup-claude',
  'repository-governance-copilot-launcher',
  'repository-governance-claude-launcher'
] as const;

export const governanceArtifactPaths = {
  policy: ['.liftoff', 'governance', 'policy.md'],
  context: ['.liftoff', 'governance', 'context.json'],
  guide: ['.liftoff', 'governance', 'README.md'],
  phaseGraph: ['.liftoff', 'governance', 'phase-graph.json'],
  compatibility: ['.liftoff', 'governance', 'compatibility.json'],
  credentialPolicySchema: ['.liftoff', 'governance', 'credential-policy.schema.json'],
  setup: {
    'github-copilot': ['.github', 'prompts', 'liftoff-setup.prompt.md'],
    claude: ['.claude', 'commands', 'liftoff-setup.md']
  },
  alias: {
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
  }
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
  'policyVersion: "6"',
  'capability chapters, not execution order',
  'managed phase graph is the sole execution-order authority',
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
  'One provisioning exception only:',
  'GitHub-hosted larger runner with',
  'Azure VNet injection',
  'private Staging DAST genuinely applies',
  'If DAST is inapplicable, provision no runner networking',
  'consume it without creating a duplicate',
  'unresolved input is a blocker',
  'Every Azure runner-network resource, remote state',
  'Staging subscription.',
  "Do not share or depend on another repository's or subscription's firewall",
  'selected access for only this repository',
  'Azure Firewall Basic',
  'Azure NAT Gateway',
  'takes precedence for new outbound connections',
  'NAT Gateway and an NSG do not filter HTTPS',
  'Disable implicit default outbound access',
  'current GitHub meta endpoint',
  'deny all unsolicited inbound connections',
  'non-overlapping address space',
  'private DNS',
  'perform no TLS interception',
  'A standard hosted preflight checks assignment',
  'Do not mark the prerequisite satisfied until readback proves',
  'maximum concurrency of one',
  'Remove in dependency order',
  'live Staging reachability',
  'Prefer an existing approved',
  'bootstrap-local',
  'encrypted at rest on the approved workstation',
  'copy local bootstrap state through GitHub artifacts',
  'private Blob DNS and authenticated backend access',
  'reviewed declarative imports',
  'state locking and Blob',
  'clean checkout produces a no-change plan',
  'retention clock does not start',
  'Retained local state must never run plan or apply',
  'destroying the encryption key',
  'The deletion record must contain no state payload',
  'Pre-answered platform defaults',
  'Dev LRS',
  'ZRS in every environment',
  '30 days read-only after verified remote import',
  'Derive the minimal namespace set',
  'Microsoft.Network',
  'GitHub.Network',
  'resource_provider_registrations = "none"',
  'missing required namespace and no unrelated provider',
  'provider-ready',
  'terminal `Registered` readback',
  'directly or transitively after its namespace registration',
  'retained subscription capabilities',
  'teardown from unregistering them',
  'Register subscription features only for intended capabilities',
  'SubscriptionNotRegisteredForFeature',
  'Do not broaden subscription features',
  'Microsoft.Network/AllowBringYourOwnPublicIpAddress',
  'Do not register the BYOIP feature as a workaround',
  "Validate every network service tag's direction and action",
  'AzurePlatformDNS',
  'used only in a Deny rule',
  'Allow rule for that tag',
  'allow TCP and UDP port 53 to the exact resolver addresses',
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
  'self-hosted runner group with Staging access exists',
  'Consume it; never attempt to create it',
  'Treat it as an **external prerequisite**',
  'share a firewall across repository subscriptions',
  'NAT Gateway may coexist with Azure Firewall',
  'resource creation is sufficient proof of Staging connectivity',
  'retain local bootstrap state indefinitely',
  'upload local bootstrap state as a GitHub artifact',
  'delete local bootstrap state immediately after import',
  'retained local state remains an active backend',
  'provider registration may remain pending while resources are created',
  'approved minimum `bootstrap-local`; delegated private',
  'register all Azure providers',
  'unregister provider registrations during teardown',
  'resource_provider_registrations = "none" requires no explicit registrations',
  'register AllowBringYourOwnPublicIpAddress for every Standard public IP',
  'Allow AzurePlatformDNS in an outbound NSG rule',
  'register any feature named by SubscriptionNotRegisteredForFeature'
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
  /\bgh[orsup]_[A-Za-z0-9_]{20,}\b/,
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

function credentialPolicySchema(): Record<string, unknown> {
  const activationIdentityProperties = {
    liftoffVersion: { const: liftoffActivationPackageVersion },
    manifestArtifactVersion: { const: liftoffManifestArtifactVersion },
    policyVersion: { const: governanceActivationPolicyVersion },
    activationContractVersion: { const: activationContractVersion },
    phaseGraphSchemaVersion: { const: phaseGraphSchemaVersion },
    phaseGraphHash: { const: currentActivationIdentity.phaseGraphHash },
    activationStateSchemaVersion: { const: activationStateSchemaVersion },
    evidenceHeaderSchemaVersion: { const: evidenceHeaderSchemaVersion },
    approvalEnvelopeSchemaVersion: { const: approvalEnvelopeSchemaVersion },
    supersessionSchemaVersion: { const: supersessionSchemaVersion },
    credentialPolicySchemaVersion: { const: credentialPolicySchemaVersion }
  } satisfies Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://mission-control.local/liftoff/governance/credential-policy.schema.v1.json',
    title: 'Liftoff governance credential policy v1',
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'identity',
      'repository',
      'owner',
      'authKind',
      'displayNameTemplate',
      'displayName',
      'secretName',
      'createdAt',
      'expiresAt',
      'rotationLeadDays',
      'rotationDueAt',
      'permissions',
      'allowedWorkflows',
      'nonForwarding',
      'status',
      'proof',
      'app',
      'pat'
    ],
    properties: {
      schemaVersion: { const: credentialPolicySchemaVersion },
      identity: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(activationIdentityProperties),
        properties: activationIdentityProperties
      },
      repository: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'owner', 'name', 'fullName'],
        properties: {
          id: { type: 'string', minLength: 1 },
          owner: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          fullName: { type: 'string', minLength: 1 }
        }
      },
      owner: { type: 'string', minLength: 1 },
      authKind: { enum: ['github-app', 'fine-grained-pat'] },
      displayNameTemplate: { const: runnerPreflightDisplayNameTemplate },
      displayName: { type: 'string', pattern: '^[A-Za-z0-9_.-]+-runner-preflight-read$' },
      secretName: { const: runnerPreflightSecretName },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      rotationLeadDays: { const: runnerPreflightRotationLeadDays },
      rotationDueAt: { type: 'string', format: 'date-time' },
      permissions: {
        type: 'object',
        additionalProperties: false,
        required: ['repository', 'organization'],
        properties: {
          repository: {
            type: 'array',
            const: [...runnerPreflightRepositoryPermissions]
          },
          organization: {
            type: 'array',
            const: [...runnerPreflightOrganizationPermissions]
          }
        }
      },
      allowedWorkflows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'jobs'],
          properties: {
            path: { type: 'string', minLength: 1 },
            jobs: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              uniqueItems: true
            }
          }
        }
      },
      nonForwarding: { const: true },
      status: { enum: ['active', 'expiring', 'expired', 'compromised'] },
      proof: {
        type: 'object',
        additionalProperties: false,
        required: ['verifiedAt', 'readbackDigest', 'readbackProvider', 'payloadFree'],
        properties: {
          verifiedAt: { type: 'string', format: 'date-time' },
          readbackDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          readbackProvider: { enum: ['github-api', 'adapter-fixture'] },
          payloadFree: { const: true }
        }
      },
      app: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['installationId', 'appSlug', 'selection', 'repositoryFullName', 'permissionsVerifiedAt', 'token'],
            properties: {
              installationId: { type: 'integer', minimum: 1 },
              appSlug: { type: 'string', minLength: 1 },
              selection: { const: 'selected-repository' },
              repositoryFullName: { type: 'string', minLength: 1 },
              permissionsVerifiedAt: { type: 'string', format: 'date-time' },
              token: {
                type: 'object',
                additionalProperties: false,
                required: ['strategy', 'ttlSeconds', 'generatedBy'],
                properties: {
                  strategy: { const: 'installation-token' },
                  ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
                  generatedBy: { const: 'github-app' }
                }
              }
            }
          }
        ]
      },
      pat: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['lifetimeDays', 'selectedRepositoryOnly', 'createdBy'],
            properties: {
              lifetimeDays: { const: runnerPreflightPatLifetimeDays },
              selectedRepositoryOnly: { const: true },
              createdBy: { const: 'manual-masked-entry' }
            }
          }
        ]
      }
    },
    allOf: [
      {
        if: { properties: { authKind: { const: 'github-app' } }, required: ['authKind'] },
        then: {
          properties: {
            app: { type: 'object' },
            pat: { type: 'null' }
          }
        }
      },
      {
        if: { properties: { authKind: { const: 'fine-grained-pat' } }, required: ['authKind'] },
        then: {
          properties: {
            app: { type: 'null' },
            pat: { type: 'object' }
          }
        }
      }
    ]
  };
}

export function renderCredentialPolicySchema(): string {
  return canonicalJson(credentialPolicySchema());
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
      ? '- GitHub Copilot: `/liftoff-setup` (`/liftoff-repository-governance` remains an alias).'
      : '- Claude Code: `/liftoff-setup` (`/liftoff-repository-governance` remains an alias).'
  ).join('\n');
  return `# Liftoff deterministic setup

State: **managed setup generated; live enforcement is not active**.

Liftoff generated deterministic policy and workload context only. It did not
create or change branches, commits, tags, remotes, pull requests, releases,
rulesets, GitHub settings, security features, environments, runners, cloud
resources, deployments, monitoring, alerts, or Slack routes.

## Next command after init

\`\`\`text
liftoff init ${plan.safeProjectName}
cd ${plan.safeProjectName}
/liftoff-setup
\`\`\`

Use the generated setup integration from any selected agent:

${launchers}

\`/liftoff-repository-governance\` is preserved only as a compatibility alias
that enters the same Liftoff governance engine and user-owned activation state.

## What setup does

\`/liftoff-setup\` delegates every transition to
\`liftoff governance status|plan|apply-next|resume|verify\`. The CLI resolves
the project root, loads \`phase-graph.json\`, validates policy ${governancePolicyVersion},
and records no separate setup-integration version.

Before any live governance work, setup completes the deterministic baseline seed:
\`liftoff validate\`, applicable backend tests, frontend build,
\`docker compose config -q\`, \`tofu fmt -check -recursive\`,
\`tofu init -backend=false\`, \`tofu validate\`, and strict ${plan.specWorkflow.label}
checks. Missing project boundaries are recorded as inapplicable, not successful.
The seed's completion means generated files were locally verified and archived;
it does not mean product behavior, infrastructure, or enforcement exists.

Questions are limited to repository publication, credentials, billed resources
or policy exceptions, final enforcement, destructive cleanup, and external
blockers. Rerun \`/liftoff-setup\` to resume; verified phases are not repeated.

Runner-preflight credentials are deterministic. Setup first prefers an existing
verified selected-repository GitHub App with the required read permissions. If a
fine-grained PAT is required, use display name
\`${runnerPreflightDisplayNameTemplate}\`, secret
\`${runnerPreflightSecretName}\`, 30-day lifetime, current repository only,
repository metadata read, organization hosted-runner and network-configuration
read, no writes, and the recorded workflow/job allowlist. Enter the value only
through the masked input; never paste or show it in chat, argv, command
arguments, logs, evidence, files, or screenshots. A leaked value is compromised and must be
manually revoked and rotated.

Live status must be proven from user-owned activation evidence and GitHub
read-back, never inferred from these local files.
`;
}

function renderSetupIntegration(): string {
  return `# /liftoff-setup

Continue deterministic Liftoff setup for this repository through the same
deterministic Liftoff governance engine used by compatibility aliases.

Contract:

1. Work from the current directory; the Liftoff CLI resolves the nearest project root.
2. Invoke only these commands: \`liftoff governance status --json\`,
   \`liftoff governance plan --json\`, \`liftoff governance apply-next --json\`,
   \`liftoff governance resume --json\`, and \`liftoff governance verify --json\`.
3. Explain blockers, approval requirements, and permitted next actions exactly
   from command output.
4. If a blocker may have changed, run \`liftoff governance resume --json\`.
5. If a next transition is ready and approved, run
   \`liftoff governance apply-next --json\`, then
   \`liftoff governance verify --json\`.
6. Never infer phase completion from prose, tasks, or local files. Never use a
   separate activation state or duplicate the Liftoff engine.
`;
}

function renderGovernanceAlias(): string {
  return `# /liftoff-repository-governance

Compatibility alias for \`/liftoff-setup\`.

Enter the same deterministic Liftoff governance engine and user-owned activation
state. Follow the \`/liftoff-setup\` contract exactly: invoke only
\`liftoff governance status --json\`, \`liftoff governance plan --json\`,
\`liftoff governance apply-next --json\`, \`liftoff governance resume --json\`,
and \`liftoff governance verify --json\`; explain blockers, approvals, and
results from their output; and never infer completion or create a separate path.
`;
}

function managedCompatibilityInventory(
  artifacts: readonly GeneratedArtifact[]
): ManagedCompatibilityInventoryEntry[] {
  return artifacts.map((artifact) => ({
    logicalName: artifact.logicalName,
    pathParts: artifact.pathParts,
    lifecycle: 'managed-core',
    contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
  }));
}

function sortedGovernancePathAllowlist(
  artifacts: readonly GeneratedArtifact[]
): readonly string[][] {
  return artifacts.map((artifact) => [...artifact.pathParts]);
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
  const setupIntegration = `${renderSetupIntegration().trimEnd()}\n`;
  const alias = `${renderGovernanceAlias().trimEnd()}\n`;
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
    {
      logicalName: 'repository-governance-phase-graph',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.phaseGraph],
      content: canonicalPhaseGraphJson
    },
    {
      logicalName: 'repository-governance-compatibility',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.compatibility],
      content: ''
    },
    {
      logicalName: 'repository-governance-credential-policy-schema',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.credentialPolicySchema],
      content: renderCredentialPolicySchema()
    },
    ...plan.agents.flatMap((agent): GeneratedArtifact[] => [{
      logicalName: agent.id === 'github-copilot'
        ? 'liftoff-setup-copilot'
        : 'liftoff-setup-claude',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.setup[agent.id]],
      content: setupIntegration
    }, {
      logicalName: agent.id === 'github-copilot'
        ? 'repository-governance-copilot-launcher'
        : 'repository-governance-claude-launcher',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.alias[agent.id]],
      content: alias
    }])
  ];
  const compatibility = artifacts.find((artifact) =>
    artifact.logicalName === 'repository-governance-compatibility'
  );
  if (!compatibility) {
    throw new Error('Governance compatibility artifact was not rendered.');
  }
  const compatibilityMetadata = buildGovernanceCompatibilityMetadata(
    managedCompatibilityInventory(artifacts),
    governanceManagedCoreLogicalNames,
    sortedGovernancePathAllowlist(artifacts)
  );
  validateGovernanceCompatibilityMetadata(compatibilityMetadata, {
    logicalNameAllowlist: governanceManagedCoreLogicalNames,
    pathAllowlist: sortedGovernancePathAllowlist(artifacts),
    inventory: managedCompatibilityInventory(artifacts)
  });
  compatibility.content = `${canonicalJson(compatibilityMetadata)}\n`;
  for (const artifact of artifacts) {
    assertGovernanceContentSafe(artifact.content);
  }
  return artifacts;
}
