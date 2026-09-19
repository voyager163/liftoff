import { readFileSync } from 'node:fs';
import { governanceAgentIntegrations, governanceArtifactPaths } from './domain/project/catalog.js';
import { managedCoreLogicalNames } from './domain/project/artifact-lifecycle.js';
import { repairContractVersion, repairRecipes, repairSchemaVersions } from './domain/repair/identity.js';
export { governanceAgentIntegrations, governanceArtifactPaths };
import type {
  CodingAgentId,
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
const governanceManagedCoreLogicalNames = managedCoreLogicalNames;

export function governanceInvocationGuide(
  plan: Pick<ProjectPlan, 'agents'>,
  operation: 'setup' | 'assessment' | 'repair' = 'setup'
): string {
  if (plan.agents.length === 0) {
    const name = operation === 'assessment' ? 'liftoff-governance-assess' : `liftoff-${operation}`;
    return `No native \`${name}\` integration is recorded.`;
  }
  return plan.agents.map((agent) =>
    `${agent.label}: \`${governanceAgentIntegrations[agent.id][operation].invocation}\``
  ).join('; ');
}

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
    `- ${agent.label}: \`${governanceAgentIntegrations[agent.id].setup.invocation}\`.`
  ).join('\n');
  const primaryAgent = plan.agents.find((agent) => agent.id === plan.defaultAgent?.id) ?? plan.agents[0];
  const primary = primaryAgent ? governanceAgentIntegrations[primaryAgent.id] : undefined;
  const nextAction = primary ? `## Next action after init

From this project, enter the native setup invocation in a selected coding agent,
not in a shell. There is no \`liftoff setup\` CLI command. \`liftoff init\` creates a
new scaffold; do not reinitialize an existing Liftoff application to repair it.

\`\`\`text
${primary.setup.invocation}
\`\`\`

Use the generated setup integration from any selected agent:

${launchers}` : `## Legacy project handoff

No native setup integration is recorded for this legacy project. This managed-core
update does not initialize the framework or install coding-agent integrations.
Inspect the current local boundary without executing setup:

\`\`\`bash
liftoff governance status --scope local --json
\`\`\`

Review the CLI's supported diagnostics and separately approved framework adoption
requirements. The journey below applies only after the required framework and
native integration are established; no agent or prior completion is inferred.`;
  return `# Liftoff deterministic setup

State: **${primary ? 'managed setup generated' : 'managed handoff generated; no native integration recorded'}; live enforcement is not active**.

Liftoff generated deterministic policy and workload context only. It did not
create or change branches, commits, tags, remotes, pull requests, releases,
rulesets, GitHub settings, security features, environments, runners, cloud
resources, deployments, monitoring, alerts, or Slack routes.

${nextAction}

## Separate native repair

${governanceInvocationGuide(plan, 'repair')}

Use the repair integration for actual application-layout review, not setup or
assessment as an alias. It negotiates \`liftoff repair --capabilities --json\`
before project access. Missing contract/recipe/mode support requires an explicit
\`liftoff upgrade --check --json\` remedy, not agent-emulated project writes.
The integration inventories actual custom source and current target artifact
identities, imports/module paths, build/tests, Docker/Compose contexts, scripts,
CI and documentation. Exact replacements and the strict patch document stay in
external staging until CLI preview, independently approved staged verification
(network separately authorized), and separate exact file approval. Staging is
not an OS or network sandbox: trusted project code can affect the host and access
the network. Declaring \`network: false\` is not proof scripts cannot access the
network. Review those effects before consent. Unknown mappings stay plan-only.
Unsupported mandatory isolation blocks verification; trust is not a substitute
for required OS or network isolation.
The application-patch transaction preserves private rollback material, original
manifest/provenance, activation proof and immutable history.
That restriction does not remove the deterministic Azure recipe's separately
registered, reviewed manifest/history writes.
Missing verification tools or dependencies are explicit blockers. Repair does not
supply npm ci/install or Python environment preparation. Go test/vet may download
modules; declare and separately approve those network effects. Never infer install,
live dependency-tree copying or lock-regeneration authority.
Generic repair requests, unrelated approval,
autopilot and agent-generated Yes do not supply action consent.
Repair works with governance disabled without creating governance artifacts or
activation state; its managed hash is not a separate release identity.

## What setup does

\`liftoff-setup\` delegates every transition to the Liftoff CLI, beginning with
\`liftoff governance status --scope local --json\`. The CLI resolves
the project root, loads \`phase-graph.json\`, validates policy ${governancePolicyVersion},
and uses activation contract ${activationContractVersion} from package
${liftoffActivationPackageVersion}. Native integration changes use managed content
hashes, not an independent version.

Prefer the CLI's supported \`nextActions\`: preserve each \`command.executable\`,
argument array, \`cwd\`, \`scope\`, and \`approvalRequired\`. A
\`nextPlannablePhase\` can be previewed before approval; execution uses only a
currently ready action with its required authority. Never invent flags or edit
approval/state JSON.
Unscoped governance commands default to activation; local inspection, execution,
and verification must retain \`--scope local\`. Supported scopes are \`local\`,
\`activation\`, and \`lifecycle\`.
\`governance plan\` saves a disclosed external preview, not approval, and does not
execute its proposed effects. \`apply-next\` without \`--execute\` is strictly
read-only. When public planning inputs are requested, follow the reported
\`--inputs <public-json-file>\` action and its documented public schema; never
put credentials or invented approval/state records in that file.
${plan.agents.some((agent) => agent.id === 'codex')
  ? 'Codex skills use their dollar-prefixed names or the `/skills` picker, not global custom prompts.\n'
  : ''}

Before publication and activation, setup verifies the deterministic baseline seed:
\`liftoff validate\`, applicable backend tests, frontend build,
\`docker compose config -q\`, \`tofu fmt -check -recursive\`,
\`tofu init -backend=false\`, \`tofu validate\`, and strict ${plan.specWorkflow.label}
checks. Missing project boundaries are recorded as inapplicable, not successful.
The seed's completion means the applicable local checks passed and the
${plan.specWorkflow.id === 'openspec'
    ? 'OpenSpec bootstrap seed was synchronized and archived.'
    : 'real Spec Kit bundle at `specs/000-liftoff-bootstrap/` was finalized locally, without an OpenSpec archive or new Git branch.'}
It does not mean product behavior, infrastructure, or enforcement exists.
Local-ready is a milestone, not the end of a requested full journey. After local
verification, present \`liftoff governance plan --scope activation --json\` and
continue only through separately approved actions. A local-only request or
declined later authority preserves local completion without publication or
provider effects.
An older Spec Kit project without that bundle needs separately reviewed seed
adoption; update, force, and assessment never create it or infer completion.
If infrastructure conformance blocks **Local baseline verification**, this is
not an OpenSpec feature change. Before retrying the blocked check, negotiate
\`liftoff repair --capabilities --json\`, then run \`liftoff repair --check --json\`
from this project.
Ordinary check makes no cloud calls. Only when explicitly authorized, use
\`liftoff repair --check --live --subscription <UUID> --json\` for bounded
metadata discovery with existing authentication. The supported local recipe
preserves legacy flat-root OpenTofu semantics while creating the shared
application module and selected independent environment roots. It requires
authoritatively absent resource groups in that subscription and absent local
state/backend metadata; missing state files alone do not prove safety.
Metadata discovery is bounded to 120 seconds overall, 30 seconds per command,
and at most 24 resource groups. Approved repair checks a compatible stable
OpenTofu release line, then runs \`tofu fmt -check -recursive\` on the whole staged
Azure root. Each selected staged environment runs
\`tofu init -backend=false -input=false -lockfile=readonly -no-color\`, then
\`tofu validate -json\`. These checks never initialize the original backend.
For normal human execution, use \`liftoff repair\` with genuine input and stderr TTYs.
It displays the exact immutable plan, then asks action-specific Yes/No with
default No. Explicit Yes authorizes only that displayed plan's internal
fingerprint; humans do not copy or enter approval hashes.
Retain separately approved \`--live --subscription <UUID>\` options in the
interactive infrastructure invocation when metadata discovery is needed.
For an externally staged application patch, use
\`liftoff repair --application-patch <external-patch.json>\`: verification,
declared network effects, and exact local file writes have separate prompts.
No/Ctrl-C/EOF declines the current action without unapproved project writes.
Previously approved verification may already have caused its disclosed host
effects. If verification ran before file-prompt cancellation, report those
executed checks and observed effects separately from no file transaction committed;
never say nothing happened. Changed inputs after a prompt still refuse stale
approval and require fresh review. Never use generic yes flags or piped answers as authority.
Agents using optional JSON automation must obtain independent user approval for
each displayed scope before using returned \`--verify-plan\` or \`--approve-plan\`
fingerprints internally; this is not the primary human path.
Then run \`liftoff update --check --json\`, review any separate update plan, and
inspect \`liftoff governance status --scope local --json\`,
\`liftoff governance verify --scope local --json\`, and
\`liftoff governance resume --scope local --json\` before the next local plan
and its ready apply action. These reads do not run project scripts or advance proof.
Keep the same project target in every command; repair accepts a positional
project path. \`--check\` stays read-only. JSON/nonTTY bare repair previews only,
never prompts, consumes piped approval, or hangs waiting for input. Execution in
JSON/nonTTY requires exact explicit execution flags and their independent consent.
Interrupted repair uses \`liftoff repair --recover\` for this project, not update
recovery. Repair does not support \`--force\`, \`--yes\`, or \`--add-agents\`.
Agent installation and the public stateful migration coordinator are not
implemented. An existing internal stateful engine is not an executable public
command. Deployed, unknown, or unsupported transformations stay plan-only with
their source and state untouched; report the limitation without inventing commands.

Questions are limited to exact repair/migration plans, state-read authority,
independent tool/dependency/global-profile permissions, repository publication,
credentials, billed resources or policy exceptions, final enforcement,
destructive recovery/cleanup, and external blockers.
Use the CLI-provided repair preview and eligibility actions, never a fresh
starter copied over the project or fabricated machine metadata. Local repair
approval does not authorize sensitive-state reads, backend writes, or resources.
Never recommend manual state moves to bypass a repair blocker.
Unknown or unsupported transformations stay plan-only.
Only explicit execution retries repaired local failures; status,
resume, and verify remain read-only. Current unchanged proof may be reused.
Do not repeat an unchanged failure or ineffective installer. Actual missing
capabilities, permissions, quota, or execution paths remain resumable blockers.

Schema-2 results distinguish \`scope\`, \`localSetup\`, \`activation\`,
\`migration\`, and \`lifecycle\`. Verification exits 0 for a consistent complete
selected scope, 2 for consistent incomplete progress, and 1 for inconsistency or
inspection failure. Status, plan, and resume can exit 0 while work remains.
\`selectedPhase\` identifies the attempt; \`executedPhase\` records success;
\`nextReadyPhase\` comes from post-operation inspection. If an operation committed
but inspection failed, retain that partial outcome and indeterminate readiness.
Use only the reported reviewed recovery action, never a blind retry or assumed
rollback of remote effects.

For an older supported activation, use \`liftoff update --check\` to review the
exact history-preserving migration. The check changes no project bytes but
discloses an external preview receipt. Explicitly approved update creates a
linked v${activationContractVersion} successor from a declared v1/v2 source. Old state, plans,
evidence, and approvals remain historical, not current authorization.
Failed local revalidation retains blocked, resumable
v${activationContractVersion}. Repair the named cause and approve a fresh preview rather than reset history.
Only the named local revalidation is automatic; no provider, commit, or push is
authorized by the migration plan. \`--json\` is optional formatting, and CI
approval uses \`--approve-plan <fingerprint>\`. Force cannot bypass these gates.

Runner-preflight credentials are deterministic. Setup first prefers an existing
verified selected-repository GitHub App with the required read permissions. If a
fine-grained PAT is required, use display name
\`${runnerPreflightDisplayNameTemplate}\`, secret
\`${runnerPreflightSecretName}\`, 30-day lifetime, current repository only,
repository metadata read, organization hosted-runner and network-configuration
read, no writes, and the recorded workflow/job allowlist.
Use the CLI-provided \`liftoff governance approve --plan <fingerprint>\` only
after the developer explicitly approves the exact displayed plan; never
automatically approve it. Approval persists authority but does not execute.
Credential enrollment uses \`liftoff governance credential-enroll --plan <fingerprint>\`
through the private operator channel. Automation must explicitly select
\`--protected-stdin\` and supply the value through an operator-controlled protected
channel, never chat or argv. Observe actual permitted use/readback,
not just a secret name. Never paste or show a credential in chat, argv,
command arguments, logs, evidence, source files, or screenshots. A leaked value must be
revoked and rotated through its owner-controlled system, not fabricated state.

Live status must be proven from user-owned activation evidence and GitHub
read-back, never inferred from these local files.
Full immediate setup is complete only when requested migration and actual
deployment, qualification, and matching live enforcement are verified.
Future retained-state disposal and other \`lifecycle\` obligations stay visible
separately; activation does not wait for a retention deadline.

${renderGovernanceAssessmentGuide(plan)}
`;
}

export function renderGovernanceAssessmentGuide(plan?: Pick<ProjectPlan, 'agents'>): string {
  const setup = plan ? governanceInvocationGuide(plan) : 'Copilot/Claude: `/liftoff-setup`; Codex: `$liftoff-setup`';
  const assessment = plan ? governanceInvocationGuide(plan, 'assessment') : 'Copilot/Claude: `/liftoff-governance-assess`; Codex: `$liftoff-governance-assess`';
  const repair = plan ? governanceInvocationGuide(plan, 'repair') : 'Copilot/Claude: `/liftoff-repair`; Codex: `$liftoff-repair`';
  const entryPoint = plan?.agents.length === 0
    ? `No native setup or assessment integration is recorded for this legacy project.
Managed-core maintenance does not initialize the framework or install integrations.
For a read-only comparison, use the CLI directly:`
    : `Native setup (${setup}) remains the primary post-init path. For a separate
comparison, use ${assessment}, or run:`;
  return `## Read-only governance assessment

${entryPoint}

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
payload and readback body to current inputs. Placeholder digests, historical v1/v2
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
For layout concerns, explain the separate native repair journey (${repair}).
Do not invoke it from assessment. Actual application inventory, external staged
patches, independent verification consent and separate exact file approval belong
to that journey; an assessment recommendation authorizes none of them.
For compatible older inventories, restore an already selected Liftoff integration
through \`liftoff update --check\`, then \`liftoff update\` with explicit approval
of the matching plan. Check discloses its external preview receipt; it is not approval.
Adding another agent or changing the framework default is not implemented by the
public repair coordinator; ordinary update does not install framework integrations.
Report this limitation without recommending an unsupported repair command.
Unowned collisions stay unowned even with \`--force\`; modified managed entries
retain the existing reviewed force rules. Neither installation nor assessment
activates governance. Unsupported mappings remain diagnostic: no migration is
available unless explicitly supported, and force cannot bypass compatibility
or overwrite project-owned configuration. A future governance upgrade needs
fresh observations, its own reviewed plan, and separate approval.
`;
}

function nativeIntegrationHeader(agent: CodingAgentId, operation: 'setup' | 'assessment' | 'repair'): string {
  const integration = governanceAgentIntegrations[agent];
  const skillName = operation === 'assessment' ? 'liftoff-governance-assess' : `liftoff-${operation}`;
  const description = operation === 'setup'
    ? 'Guide local readiness and separately approved repair, migration and activation.'
    : operation === 'assessment'
      ? 'Explain the Liftoff governance assessment without executing repairs, activation, or other mutations.'
      : 'Guide capability-checked project repair with staged verification and separate file approval.';
  const metadata = integration.kind === 'skill'
    ? `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n`
    : '';
  return `${metadata}# ${integration[operation].invocation}\n`;
}

function renderRepairIntegration(agent: CodingAgentId): string {
  return `${nativeIntegrationHeader(agent, 'repair')}
The CLI owns repair decisions/writes. This is not setup, assessment or agent
installation. Managed hashes identify the integration; no separate version.

1. First run \`liftoff repair --capabilities --json\`, before project access.
   Require \`schemaVersion: ${repairSchemaVersions.capabilities}\`, \`kind: liftoff-repair-capabilities\`,
   \`cliVersion\` and \`repairContractVersion: ${repairContractVersion}\`.
   Read \`schemas\`: report/preview/history/journal ${repairSchemaVersions.report} and
   applicationInventory/applicationPatch/applicationVerification ${repairSchemaVersions.applicationInventory}.
   Read \`preparation\` provider and toolchain matrix (\`npm-ci\`, \`uv-locked-sync\`, \`go-mod-download\` v1; package sources: \`npmjs\`, \`microsoft-npm\`, \`pypi\`, \`microsoft-pypi\`, \`go-proxy\`).
   \`recipes\` must match the selected recipe/layout:
   \`${repairRecipes['azure-local-layout'].id}\` v${repairRecipes['azure-local-layout'].version} or
   \`${repairRecipes['application-layout-patch'].id}\` v${repairRecipes['application-layout-patch'].version}
   \`modes\` must support the action, including \`interactive-repair\`.
   Require the actual capability contract and matrix; do not assume prior CLI releases contain them.
   There is no released minimum CLI version yet: require the actual capability contract and matrix.
   Missing support: STOP; offer \`liftoff upgrade --check --json\`. Upgrade needs separate
   permission; recheck afterwards. Never emulate missing features with direct edits,
   commands or receipts, or infer support from package version.
2. Preserve the exact project target and schema-${repairSchemaVersions.report} \`nextActions\`,
   \`command.executable\`, \`command.args\`, \`cwd\`, \`scope\`,
   \`approvalRequired\` and effects. Use argument arrays or CLI-native shell
   rendering, not concatenated paths or project prose. Repair paths are positional.
3. Prefer \`liftoff repair <project>\` in the developer's interactive terminal.
   Prompts require genuine input and stderr TTYs: exact immutable plan first,
   action-specific Yes/No, default No. Explicit Yes binds only that internal fingerprint.
   No/Ctrl-C/EOF declines without unapproved writes. Do not ask humans to copy hashes.
   \`liftoff repair <project> --check --json\` stays read-only and makes no cloud calls.
   JSON/nonTTY bare repair previews only; execution requires exact explicit execution flags.
   Never prompt or wait for input there.
   Never use a generic yes flag or piped answers as authority.
   Separately approved live metadata reads use
   \`liftoff repair <project> --live --subscription <UUID>\` interactively, or
   \`liftoff repair <project> --check --live --subscription <UUID> --json\` read-only,
   with existing authentication. State/backend metadata stay protected; deployed/unknown
   stays plan-only. Missing files prove no absence; no public stateful migration exists.
4. Run \`liftoff repair <project> --inspect-layout --json\` for actual application inventory:
   current target artifact IDs and paths, source provenance, digests/modes, directory
   inventory, customizations and every source mapping. Review imports/module paths,
   build/test, Docker/Compose contexts, scripts, CI and documentation references.
   Respect exclusions and bounded coverage; never infer historical layouts or
   replace customized code with starters.
   Unresolved mappings or reference coverage remain plan-only; never guess a move.
5. Author exact replacement bytes and a strict schema-${repairSchemaVersions.applicationPatch} application patch
   document in external isolated staging OUTSIDE the project using the installed format.
   Bind each source/destination, digest/mode, staged bytes, target identity, references
   and exact checks. No wildcard ownership or recursive moves.
   Interactive review:
   \`liftoff repair <project> --application-patch <external-patch.json>\`.
   Optional read-only preview:
   \`liftoff repair <project> --check --application-patch <external-patch.json> --json\`.
   Explain the diff, references and limits. The expiring plan binds bytes, modes,
   directory inventory, identities, toolchain and verification. Even after Yes,
   stale-after-prompt inputs refuse execution and require fresh review.
6. Before checks, obtain independent consent for locked dependency preparation (when declared),
   exact project-code execution, and separately for declared network effects: Yes/No, default No.
   Registered providers (npm-ci v1, uv-locked-sync v1, go-mod-download v1) restore locked
   dependencies into private environments with lifecycle scripts suppressed (lifecycle: disabled);
   no arbitrary installer, global installs, live dependency reuse, credential inheritance, or lock upgrades.
   Missing tools, locks, or unsupported hooks/sources are explicit blockers.
   Staging is NOT an OS or network sandbox: trusted dependency/project code
   can affect the host and access the network. Declaring \`network: false\` is not proof
   scripts cannot access the network.
   Mandatory isolation unsupported by this executor blocks verification.
   Preparation and network approval imply no file approval. Failed checks apply no patch.
7. After fresh matching successful verification, let the CLI ask SEPARATELY about
   exact file writes; explicit Yes binds only those effects. If a later No/Ctrl-C/EOF
   follows approved verification, report earlier commands and observed effects
   separately from no file transaction committed. Never report "nothing happened":
   cancellation cannot undo prior host/network effects.
   The confined transaction alone applies the patch, never direct edits followed
   by retrospective approval. No force/yes bypass.
   Never edit manifest/provenance, desired state, framework or managed integrations,
   activation proof, history, state or secrets through an application patch.
   This does not prohibit the Azure recipe's registered reviewed manifest/history writes.
   Never fabricate evidence or retag old records.
   Optional agent automation: use fingerprints internally only for the same immutable
   plan and action scopes the actual user separately approved. Generic repair requests,
   unrelated approval, autopilot, agent-generated Yes and piped input grant no consent.
   \`liftoff repair <project> --verify-plan <fingerprint> --json\`, adding
   \`--allow-dependency-preparation\` and/or \`--allow-network\` only for their
   independently approved declared effects;
   After fresh successful verification and separate file approval:
   \`liftoff repair <project> --approve-plan <fingerprint> --json\`.
   Optional automation/backward compatibility only; no human hash entry.
8. Distinguish inventory, proposed, verified and committed scope, including cleanup
   limitations. Report only declared checks actually executed and their results.
   Declared checks are not full application/cloud conformance or activation.
   Build-only evidence is not tests. Preserve private rollback material and immutable history.
   \`liftoff repair <project> --recover --json\` is only for the CLI's reported interrupted
   repair scope, not generic cleanup or rollback. Never delete user staging, backups or
   history, guess cleanup paths, or rerun verification through recovery.
   Post-commit fixes need a new reviewed patch or user-controlled version-history recovery,
   never blind rollback. Retain partial outcomes and prior effects.
9. Resume with \`liftoff update --project <project> --check --json\`; approval is
   separate. For enabled governance, follow returned
   \`liftoff governance status --scope local --json\`,
   \`liftoff governance verify --scope local --json\` and
   \`liftoff governance resume --scope local --json\` actions with the same project
   target, then native setup. Explain Local baseline verification, not raw phase IDs.
   Deployment/activation consent stays separate.
   Governance none stays disabled: do not create policy, setup, assessment, state
   or evidence to use repair. Never invent agent installation, shell setup or
   state-migration commands. Missing selected integrations need reviewed additive
   update; unowned collisions and neighboring skills stay protected.
`;
}

function renderSetupIntegration(agent: CodingAgentId): string {
  return `${nativeIntegrationHeader(agent, 'setup')}
Use the Liftoff governance engine; read \`.liftoff/governance/README.md\`, \`policy.md\`, \`context.json\`.

1. Start \`liftoff governance status --scope local --json\`;
   Unscoped governance defaults to activation: \`liftoff governance status --json\`.
   Preserve schema-2 \`nextActions\`: \`command.executable\`, \`command.args\`, \`cwd\`, \`scope\`, \`approvalRequired\`.
   \`nextReadyPhase\` is post-operation readiness, not \`nextPlannablePhase\`.
   Scopes: \`localSetup\`, \`migration\`, \`activation\`, \`lifecycle\`.
2. Local baseline verification is not an OpenSpec feature change.
   Use separate native repair (liftoff-repair); no direct edits.
   Preview \`liftoff repair --check --json\`.
   Ordinary check makes no cloud calls. Explicit live:
   \`liftoff repair --check --live --subscription <UUID> --json\`.
   Normally use \`liftoff repair\`: exact immutable plan, then Yes/No, default No.
   No/Ctrl-C/EOF blocks unapproved writes; report prior verification effects.
   JSON/nonTTY bare previews only. No copied hashes or piped approval.
   Verification/network/file consent stays separate.
   Then \`liftoff update --check --json\`; update approval is separate.
   Resume: \`liftoff governance resume --scope local --json\`.
   Same project; positional repair path. Recover: \`liftoff repair --recover\`.
   Agent installation and the public stateful migration coordinator are not implemented.
   Blocked stays plan-only.
3. Preview \`liftoff governance plan --scope local --json\` and \`liftoff governance apply-next --scope local --json\`.
   \`selectedPhase\` is attempted; \`executedPhase\` succeeded.
   Only for a reported ready, approval-free local action:
   \`liftoff governance apply-next --scope local --json --execute\`.
   Plan saves a disclosed external preview, not approval.
   Apply-next without \`--execute\` is strictly read-only.
4. Honor a local-only request or declined later authority; else
   \`liftoff governance plan --scope activation --json\`
   with \`--inputs <public-json-file>\` if requested.
   Never automatically approve a plan. With consent:
   \`liftoff governance approve --plan <fingerprint>\`; approval does not execute.
5. \`liftoff governance credential-enroll --plan <fingerprint>\`:
   \`--protected-stdin\` via an operator-controlled protected channel (private operator channel), never chat.
6. Verify \`liftoff governance verify --scope local --json\` or
   \`liftoff governance verify --scope activation --json\` (\`liftoff governance verify --json\`).
   Exit 0 is complete; exit 2 means consistent but
   incomplete (indeterminate readiness).
   Full completion: actual deployment, matching live enforcement and readback;
   deferred retention is not failed activation (future lifecycle work).
7. Do not repeat an unchanged failure. Approved recovery:
   \`liftoff governance recover --plan <fingerprint> --execute\`.
`;
}

function renderAssessmentIntegration(agent: CodingAgentId): string {
  return `${nativeIntegrationHeader(agent, 'assessment')}
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
   instructions, update, upgrade, repair, migration, activation, remediation, Git/GitHub/Azure
   mutations, project scripts, or writes to project files, state, or evidence.
   Explain separate native repair for layout concerns: Copilot/Claude \`/liftoff-repair\`;
   Codex \`$liftoff-repair\`. Do not invoke it, inventory source or stage a patch here.
   Separate primary post-init setup: Copilot/Claude \`/liftoff-setup\`; Codex \`$liftoff-setup\`.
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
  const repairArtifacts = plan.agents.map((agent): GeneratedArtifact => ({
    logicalName: governanceAgentIntegrations[agent.id].repair.logicalName,
    category: 'governance',
    lifecycle: 'managed-core',
    pathParts: [...governanceArtifactPaths.repair[agent.id]],
    content: `${renderRepairIntegration(agent.id).trimEnd()}\n`
  }));
  for (const artifact of repairArtifacts) assertGovernanceContentSafe(artifact.content);
  if (plan.governanceProfile.id === 'none') {
    return repairArtifacts;
  }
  const policy = renderCanonicalGovernancePolicy();
  const context = renderGovernanceContext(plan);
  const guide = `${renderGovernanceGuide(plan).trimEnd()}\n`;
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
      logicalName: governanceAgentIntegrations[agent.id].setup.logicalName,
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.setup[agent.id]],
      content: `${renderSetupIntegration(agent.id).trimEnd()}\n`
    })),
    ...plan.agents.map((agent): GeneratedArtifact => ({
      logicalName: governanceAgentIntegrations[agent.id].assessment.logicalName,
      category: 'governance',
      lifecycle: 'managed-core',
      pathParts: [...governanceArtifactPaths.assessment[agent.id]],
      content: `${renderAssessmentIntegration(agent.id).trimEnd()}\n`
    })),
    ...repairArtifacts
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
    inventory: managedCompatibilityInventory(artifacts),
    agents: plan.agents.map((agent) => agent.id)
  });
  compatibility.content = `${canonicalJson(compatibilityMetadata)}\n`;
  for (const artifact of artifacts) {
    assertGovernanceContentSafe(artifact.content);
  }
  return artifacts;
}
