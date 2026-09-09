import { readFileSync } from 'node:fs';
import type {
  GeneratedArtifact,
  ProjectPlan
} from './domain/project/contracts.js';
import { packagedSupportedStack as supportedStack } from './adapters/packaged-assets/supported-stack.js';
import { resolvePackageFileUrl } from './adapters/packaged-assets/package-root.js';
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
  'liftoff-governance-assess-copilot',
  'liftoff-governance-assess-claude'
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
  assessment: {
    'github-copilot': ['.github', 'prompts', 'liftoff-governance-assess.prompt.md'],
    claude: ['.claude', 'commands', 'liftoff-governance-assess.md']
  }
} as const;

const suppliedPolicy = readFileSync(
  resolvePackageFileUrl('assets', 'governance', 'single-maintainer-gitflow', 'policy.md'),
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

export interface GovernanceContextOptions {
  infrastructureLayout?: 'independent' | 'legacy-shared' | 'unknown';
}

const azureInfrastructureRoot = ['infrastructure', 'opentofu', 'azure'];

function infrastructureCommands(
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

function apiCommands(
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

function governanceContext(plan: ProjectPlan, options: GovernanceContextOptions): Record<string, unknown> {
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

export function renderGovernanceContext(plan: ProjectPlan, options: GovernanceContextOptions = {}): string {
  const value = governanceContext(plan, options);
  validateGovernanceContext(value);
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  assertGovernanceContentSafe(rendered);
  return rendered;
}

function renderGovernanceGuide(plan: ProjectPlan): string {
  const launchers = plan.agents.map((agent) =>
    agent.id === 'github-copilot'
      ? '- GitHub Copilot: `/liftoff-setup`.'
      : '- Claude Code: `/liftoff-setup`.'
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
The seed's completion means the applicable local checks passed and the
${plan.specWorkflow.id === 'openspec'
    ? 'OpenSpec bootstrap seed was synchronized and archived.'
    : 'real Spec Kit bundle at `specs/000-liftoff-bootstrap/` was finalized locally, without an OpenSpec archive or new Git branch.'}
It does not mean product behavior, infrastructure, or enforcement exists.
An older Spec Kit project without that bundle needs separately reviewed seed
adoption; update, force, and assessment never create it or infer completion.

Questions are limited to repository publication, credentials, billed resources
or policy exceptions, final enforcement, destructive cleanup, and external
blockers. Only explicit execution retries repaired local failures; status,
resume, and verify remain read-only. Current unchanged proof may be reused.
Unavailable production executors and public approval/credential entry points
remain capability blockers; the phase graph does not claim they are implemented.

For an older supported activation, use \`liftoff update --check\` to review the
exact history-preserving migration. The check changes no project bytes but
discloses an external preview receipt. Explicitly approved update creates a
linked v2 successor; old state, plans, evidence, and approvals remain historical,
not current authorization. Failed local revalidation retains blocked, resumable
v2. Repair the named cause and approve a fresh preview rather than reset history.
Only the named local revalidation is automatic; no provider, commit, or push is
authorized by the migration plan. \`--json\` is optional formatting, and CI
approval uses \`--approve-plan <fingerprint>\`. Force cannot bypass these gates.

Runner-preflight credentials are deterministic. Setup first prefers an existing
verified selected-repository GitHub App with the required read permissions. If a
fine-grained PAT is required, use display name
\`${runnerPreflightDisplayNameTemplate}\`, secret
\`${runnerPreflightSecretName}\`, 30-day lifetime, current repository only,
repository metadata read, organization hosted-runner and network-configuration
read, no writes, and the recorded workflow/job allowlist. This is a policy
contract, not a public enrollment command. No masked credential-input channel
is exposed by this release. Never paste or show a credential in chat, argv,
command arguments, logs, evidence, files, or screenshots. A leaked value must be
revoked and rotated through its owner-controlled system, not fabricated state.

Live status must be proven from user-owned activation evidence and GitHub
read-back, never inferred from these local files.

${renderGovernanceAssessmentGuide()}
`;
}

export function renderGovernanceAssessmentGuide(): string {
  return `## Read-only governance assessment

\`/liftoff-setup\` remains the primary post-init path. For a separate comparison,
use \`/liftoff-governance-assess\` in a selected agent or run:

\`\`\`bash
liftoff governance assess --json
\`\`\`

The pinned target is the installed CLI's packaged policy, activation identity,
phase graph, and assessment control catalog, never registry latest. The report
separates that target from the recorded baseline, declared project configuration,
and observed enforcement. It includes expected and observed values, provenance,
scope, impact, and ownership-aware advisory remediation.
The project policy version is shown when available. JSON observations may also
retain optional normalized \`facts\` alongside evaluator predicate values;
these are sanitized details, not raw provider payloads.

The default is local-only with no network access or cloud/GitHub credentials.
It works in any Git repository without initialization, a Liftoff manifest, or
generated agent wrappers, including before the first commit. The installed
single-maintainer policy is the explicit target; absent Liftoff identity and
baseline are missing proof, not an opt-out. An invalid or retired inner manifest
blocks fallback to an outer repository. It does not run the bootstrap baseline
or install wrappers. All assessment invocations, including live mode and help, skip
telemetry and disclosure entirely. Local Git reads inspect only repository
root, HEAD, and origin metadata, never \`git status\`, which can execute clean
filters. Only after an explicit request for live reads, use:

\`\`\`bash
liftoff governance assess --live --json
\`\`\`

Live mode permits bounded read-only GitHub/Azure metadata access using existing
permissions and verified repository/environment/resource bindings. No login,
credential enrollment, permission expansion, provider registration, state-blob
access, or resource mutation is authorized. Missing access, unknown applicability,
stale evidence, and unsupported evaluators remain visible coverage gaps, not
proof of absence or alignment.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts that bind their canonical
payload and readback body to current inputs. Placeholder digests, historical v1
receipts, future-dated approvals, and inferred bindings cannot establish proof. Missing
bindings stay \`not-observed\`; do not fabricate or hand-edit activation state,
baselines, receipts, or evidence to make assessment pass. Collect missing proof
through separately approved setup or governance work.

| Finding | Meaning |
| --- | --- |
| \`aligned\` | Every required proof layer is fresh and matches the target |
| \`outdated\` | A recognized older baseline or recorded managed artifact differs |
| \`missing\` | Complete authoritative observation proves an applicable requirement absent |
| \`conflicting\` | Known settings contradict the target or another observed layer |
| \`approved-exception\` | An exact, valid, unexpired permitted exception covers a difference |
| \`inapplicable\` | Validated workload facts prove a control does not apply |
| \`not-observed\` | Applicability or required proof is unknown, stale, denied, or unsupported |

Coverage distinguishes local matches from unobserved live proof; a matching
workflow file is not proof of enforcement. Provider access failures do not erase
independently observed local or other-resource findings. Unsupported controls
stay visible rather than being removed to produce a green result.
Local-only reports will normally be
\`partial\`. Exit 0 means fully observed \`aligned\` or explicitly disabled
\`not-applicable\` governance (not an alignment claim); exit 2 means \`partial\`
coverage or \`differences\`, including approved exceptions; exit 1 means \`error\`.
Exit 2 is advisory, not permission to repair anything.

Assessment writes reports to stdout only. It never updates or upgrades anything,
changes project files, Git, activation state, approvals, or evidence, or runs
recommendations. Reports cannot complete Phase 0 or any other phase.
For compatible older inventories, install the new selected-agent integration
through \`liftoff update --check\`, then \`liftoff update\` with explicit approval
of the matching plan. Check discloses its external preview receipt; it is not approval.
Unowned collisions stay unowned even with \`--force\`; modified managed entries
retain the existing reviewed force rules. Neither installation nor assessment
activates governance. Unsupported mappings remain diagnostic: no migration is
available unless explicitly supported, and force cannot bypass compatibility
or overwrite project-owned configuration. A future governance upgrade needs
fresh observations, its own reviewed plan, and separate approval.
`;
}

function renderSetupIntegration(): string {
  return `# /liftoff-setup

Use the Liftoff governance engine.

1. Work from the current directory; the CLI resolves the root.
2. Invoke only: \`liftoff governance status --json\`,
   \`liftoff governance plan --json\`, \`liftoff governance apply-next --json\`,
   \`liftoff governance apply-next --json --execute\`,
   \`liftoff governance resume --json\`, and \`liftoff governance verify --json\`.
3. Explain reported blockers and approvals. Inspection never executes work.
4. Use \`liftoff governance apply-next --json\` only to preview operations.
   If ready and its approval status is \`not-required\` or \`reused\`, run
   \`liftoff governance apply-next --json --execute\`, then verify.
   \`selectedPhase\` is attempted; \`executedPhase\` succeeded.
   Reinspect: \`nextReadyPhase\` is not post-transition readiness.
5. Stop on failure. Retry only on request after repair;
   do not repeatedly retry an unchanged failure.
6. For supported historical migration, propose \`liftoff update --check\`.
   It preserves project bytes and saves an external receipt, not approval.
   \`liftoff update\` needs explicit matching-plan approval; never run it
   implicitly from setup.
7. Tasks and prose are not proof. Missing executors or authorization stay blocked.
   Never invent commands, write evidence/state manually, or collect credentials
   in chat to bypass a gate.
`;
}

function renderAssessmentIntegration(): string {
  return `# /liftoff-governance-assess

Explain a read-only governance assessment, not setup or an upgrade.
The installed CLI is the target authority. In a Liftoff project, recorded context
also includes \`.liftoff/governance/policy.md\`,
\`.liftoff/governance/context.json\`, and \`.liftoff/governance/README.md\`.

Contract:

1. Work from the current directory; the CLI resolves the nearest Git or Liftoff
   boundary. No commit, push, activation, or credential enrollment is required.
   Initialization and a manifest are not prerequisites. Invalid or retired manifests block
   fallback. Never install this wrapper into an unrelated repository.
2. Invoke only \`liftoff governance assess --json\`. This defaults to local-only,
   no-network comparison against the installed CLI's packaged target.
3. Only when the developer explicitly requests live reads, invoke
   \`liftoff governance assess --live --json\` instead. This permits bounded,
   scoped reads with existing permissions, never credential or permission changes.
4. Explain the CLI report's target, recorded identity and policy version, declared
   configuration, expected/observed values, normalized facts when present,
   provenance, coverage, findings, impact, and advisory recommendations.
   Preserve classifications exactly; never invent findings or turn not-observed,
   partial coverage, or approved-exception into alignment.
5. Explain exit 0 as aligned or explicitly disabled (not-applicable), exit 2 as
   partial coverage or differences including approved exceptions, and exit 1 as
   an error. A report is not activation evidence and does not complete any phase.
6. Stop after explaining the report. Never execute its recommendations or shell
   instructions, update, upgrade, activation, remediation, Git/GitHub/Azure
   mutations, project scripts, or writes to project files, state, or evidence.
   Keep \`/liftoff-setup\` as the separate primary post-init setup path.
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
  const assessmentIntegration = `${renderAssessmentIntegration().trimEnd()}\n`;
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
    ...plan.agents.map((agent): GeneratedArtifact => ({
      logicalName: agent.id === 'github-copilot'
        ? 'liftoff-setup-copilot'
        : 'liftoff-setup-claude',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.setup[agent.id]],
      content: setupIntegration
    })),
    ...plan.agents.map((agent): GeneratedArtifact => ({
      logicalName: agent.id === 'github-copilot'
        ? 'liftoff-governance-assess-copilot'
        : 'liftoff-governance-assess-claude',
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.assessment[agent.id]],
      content: assessmentIntegration
    }))
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
