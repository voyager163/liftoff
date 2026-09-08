import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  EnvironmentId,
  LiftoffManifest,
  ManifestProjectArtifact
} from '../src/domain/project/contracts.js';
import {
  assessInfrastructureLayout,
  currentInfrastructureIdentities,
  environmentRootInfrastructureIdentities,
  infrastructureProvisioningGate,
  retiredFlatRootInfrastructureIdentities,
  retainedInfrastructureIdentities,
  sharedApplicationModuleIdentities,
  type InfrastructureArtifactIdentity
} from '../src/domain/project/infrastructure-layout.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import {
  buildUpdateArtifacts,
  inspectProvisioningGroups,
  requestedProvisioningGroups
} from '../src/application/update/planning.js';
import { buildArtifacts } from '../src/templates.js';
import {
  buildDevCommand,
  buildInfraCommand
} from '../src/cli/commands/helpers.js';
import {
  commandShellForPlatform,
  formatShellCommand
} from '../src/adapters/process/shell-command.js';

const hash = `sha256:${'a'.repeat(64)}`;

function recorded(
  identity: InfrastructureArtifactIdentity
): ManifestProjectArtifact {
  return {
    logicalName: identity.logicalName,
    category: identity.category,
    pathParts: [...identity.pathParts],
    generatedBy: '0.11.0',
    generationHash: hash,
    provisioningGroup: identity.provisioningGroup
  };
}

function manifest(
  environments: EnvironmentId[],
  projectArtifacts: ManifestProjectArtifact[]
): LiftoffManifest {
  return {
    artifactVersion: 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion: '0.11.0',
    project: {
      name: 'Layout Test',
      workload: {
        kind: 'standard',
        apiStack: 'node-fastify',
        cloud: 'azure',
        region: 'eastus',
        frontend: false,
        environments
      },
      specWorkflow: 'openspec',
      agents: ['github-copilot']
    },
    framework: {
      state: 'initialized',
      adapter: 'openspec',
      contractVersion: '1.11.0'
    },
    governance: { profile: 'none', state: 'disabled' },
    managedArtifacts: [],
    projectArtifacts
  };
}

describe('infrastructure layout contract', () => {
  it('recognizes only complete recorded independent roots', () => {
    const identities = [
      ...sharedApplicationModuleIdentities,
      ...environmentRootInfrastructureIdentities('prod')
    ];
    const project = manifest(['prod'], identities.map(recorded));

    expect(assessInfrastructureLayout(project)).toMatchObject({
      kind: 'independent',
      canProvisionEnvironment: true
    });

    expect(infrastructureProvisioningGate(project, 'staging').status).toBe('ready');
  });

  it('gates only newly requested environment provisioning', async () => {
    const plan = buildProjectPlan({
      projectName: 'Layout Test',
      projectType: 'standard',
      apiStack: 'node-fastify',
      cloud: 'azure',
      region: 'eastus',
      includeFrontend: false,
      environments: ['dev', 'prod'],
      specWorkflow: 'openspec',
      agents: ['github-copilot'],
      governanceProfile: 'none'
    }, { requireProjectName: true });
    const current = manifest(['dev'], [
      ...sharedApplicationModuleIdentities,
      ...environmentRootInfrastructureIdentities('dev')
    ].map(recorded));
    const legacy = manifest(
      ['dev'],
      retiredFlatRootInfrastructureIdentities.map(recorded)
    );

    expect(requestedProvisioningGroups(current, plan)).toEqual([
      { group: 'environment:prod', status: 'ready' }
    ]);
    const sharedPaths = new Set(
      sharedApplicationModuleIdentities.map((identity) =>
        identity.pathParts.join('/')
      )
    );
    await expect(inspectProvisioningGroups(
      'project',
      buildArtifacts(plan),
      requestedProvisioningGroups(current, plan),
      {
        readFile: async (_root, pathParts) =>
          sharedPaths.has(pathParts.join('/')) ? Buffer.from('present') : undefined
      }
    )).resolves.toMatchObject([{
      group: 'environment:prod',
      blocked: false,
      entries: expect.arrayContaining([
        expect.objectContaining({
          status: 'create',
          rendered: expect.objectContaining({
            logicalName: 'opentofu-prod-tfvars',
            pathParts: [
              'infrastructure',
              'opentofu',
              'azure',
              'environments',
              'prod',
              'prod.tfvars'
            ]
          })
        })
      ])
    }]);
    await expect(inspectProvisioningGroups(
      'project',
      buildArtifacts(plan),
      requestedProvisioningGroups(current, plan),
      { readFile: async () => undefined }
    )).resolves.toMatchObject([{
      group: 'environment:prod',
      blocked: true,
      entries: [],
      reason: expect.stringContaining('shared application module files are missing')
    }]);
    const legacyRequests = requestedProvisioningGroups(legacy, plan);
    expect(legacyRequests).toEqual([{
      group: 'environment:prod',
      status: 'migration-required',
      reason: expect.stringContaining('legacy shared-state')
    }]);
    await expect(inspectProvisioningGroups(
      'must-not-be-read',
      buildArtifacts(plan),
      legacyRequests
    )).resolves.toMatchObject([{
      group: 'environment:prod',
      blocked: true,
      entries: [],
      reason: expect.stringContaining('prod environment was not provisioned')
    }]);
  });

  it('treats an exact retired flat-root identity as legacy shared state', () => {
    const legacy = retiredFlatRootInfrastructureIdentities.map(recorded);
    const project = manifest(['dev'], legacy);

    expect(assessInfrastructureLayout(project)).toMatchObject({
      kind: 'legacy-shared',
      canProvisionEnvironment: false
    });
    expect(infrastructureProvisioningGate(project, 'prod')).toMatchObject({
      status: 'migration-required',
      reason: expect.stringContaining('prod environment was not provisioned')
    });
    expect(project.projectArtifacts).toEqual(legacy);
  });

  it('blocks partial or unrecognized provenance without inferring paths', () => {
    const partial = sharedApplicationModuleIdentities.slice(0, 1).map(recorded);
    const project = manifest(['dev'], partial);

    expect(assessInfrastructureLayout(project)).toMatchObject({
      kind: 'unknown',
      canProvisionEnvironment: false
    });
    expect(infrastructureProvisioningGate(project, 'staging').status)
      .toBe('migration-required');

    const priorGeneration = manifest(['dev'], [
      ...sharedApplicationModuleIdentities,
      ...environmentRootInfrastructureIdentities('dev')
    ].map((identity) => ({
      ...recorded(identity),
      generatedBy: '0.10.4'
    })));
    expect(assessInfrastructureLayout(priorGeneration).kind).toBe('unknown');
  });

  it('projects the recorded layout into managed governance context', () => {
    const plan = buildProjectPlan({
      projectName: 'Layout Test',
      projectType: 'standard',
      apiStack: 'node-fastify',
      cloud: 'azure',
      region: 'eastus',
      includeFrontend: false,
      environments: ['dev'],
      specWorkflow: 'openspec',
      agents: ['github-copilot'],
      governanceProfile: 'single-maintainer-gitflow'
    }, { requireProjectName: true });
    const legacy = manifest(
      ['dev'],
      retiredFlatRootInfrastructureIdentities.map(recorded)
    );
    const independent = manifest(['dev'], [
      ...sharedApplicationModuleIdentities,
      ...environmentRootInfrastructureIdentities('dev')
    ].map(recorded));
    const unknown = manifest(['dev'], []);
    const context = (project: LiftoffManifest) => {
      const artifact = buildUpdateArtifacts(plan, project).find((entry) =>
        entry.logicalName === 'repository-governance-context'
      );
      if (!artifact) throw new Error('Missing governance context.');
      return JSON.parse(artifact.content) as {
        commands: Array<{
          id: string;
          cwdPathParts: string[];
          executable: string;
        }>;
        generatedBoundaries: {
          opentofu: {
            layout: string;
            provenance?: string;
            compatibility?: string;
            environmentRoots?: unknown[];
          };
        };
      };
    };

    expect(context(legacy).generatedBoundaries.opentofu).toMatchObject({
      layout: 'legacy-shared',
      provenance: 'recorded-generation',
      compatibility: 'migration-required',
      environmentRoots: []
    });
    const independentContext = context(independent);
    expect(independentContext.generatedBoundaries.opentofu).toMatchObject({
      layout: 'independent',
      provenance: 'current-generation',
      sharedApplicationModulePathParts: [
        'infrastructure',
        'opentofu',
        'azure',
        'modules',
        'application'
      ],
      environmentRoots: [{
        environment: 'dev',
        pathParts: [
          'infrastructure',
          'opentofu',
          'azure',
          'environments',
          'dev'
        ],
        tfvarsPathParts: [
          'infrastructure',
          'opentofu',
          'azure',
          'environments',
          'dev',
          'dev.tfvars'
        ]
      }]
    });
    expect(independentContext.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'opentofu-initialize-dev' }),
      expect.objectContaining({ id: 'opentofu-validate-dev' })
    ]));
    const unknownContext = context(unknown);
    expect(unknownContext.generatedBoundaries.opentofu).toMatchObject({
      layout: 'unknown',
      compatibility: 'migration-required'
    });
    expect(unknownContext.commands.some((command) =>
      command.executable === 'tofu'
    )).toBe(false);
  });

  it('enumerates the reviewed finite environment inventory', () => {
    expect(environmentRootInfrastructureIdentities('dev').map((entry) => [
      entry.logicalName,
      entry.pathParts.join('/'),
      entry.provisioningGroup
    ])).toEqual([
      ['opentofu-dev-versions', 'infrastructure/opentofu/azure/environments/dev/versions.tf', 'environment:dev'],
      ['opentofu-dev-provider-lock', 'infrastructure/opentofu/azure/environments/dev/.terraform.lock.hcl', 'environment:dev'],
      ['opentofu-dev-providers', 'infrastructure/opentofu/azure/environments/dev/providers.tf', 'environment:dev'],
      ['opentofu-dev-variables', 'infrastructure/opentofu/azure/environments/dev/variables.tf', 'environment:dev'],
      ['opentofu-dev-main', 'infrastructure/opentofu/azure/environments/dev/main.tf', 'environment:dev'],
      ['opentofu-dev-outputs', 'infrastructure/opentofu/azure/environments/dev/outputs.tf', 'environment:dev'],
      ['opentofu-dev-local-state', 'infrastructure/opentofu/azure/environments/dev/backend.local.tf', 'environment:dev'],
      ['opentofu-dev-remote-state-example', 'infrastructure/opentofu/azure/environments/dev/backend.remote.example.tf', 'environment:dev'],
      ['opentofu-dev-tfvars', 'infrastructure/opentofu/azure/environments/dev/dev.tfvars', 'environment:dev']
    ]);
  });

  it('enumerates exact base, retained, and retired infrastructure identities', () => {
    expect(sharedApplicationModuleIdentities.map((entry) => [
      entry.logicalName,
      entry.pathParts.join('/'),
      entry.provisioningGroup
    ])).toEqual([
      ['opentofu-application-versions', 'infrastructure/opentofu/azure/modules/application/versions.tf', 'base'],
      ['opentofu-application-variables', 'infrastructure/opentofu/azure/modules/application/variables.tf', 'base'],
      ['opentofu-application-main', 'infrastructure/opentofu/azure/modules/application/main.tf', 'base'],
      ['opentofu-application-outputs', 'infrastructure/opentofu/azure/modules/application/outputs.tf', 'base']
    ]);
    expect(retainedInfrastructureIdentities).toEqual([{
      logicalName: 'opentofu-readme',
      category: 'infrastructure',
      pathParts: ['infrastructure', 'opentofu', 'azure', 'README.md'],
      provisioningGroup: 'base'
    }]);
    expect(retiredFlatRootInfrastructureIdentities.map((entry) =>
      entry.logicalName
    )).toEqual([
      'opentofu-versions',
      'opentofu-provider-lock',
      'opentofu-providers',
      'opentofu-variables',
      'opentofu-main',
      'opentofu-outputs',
      'opentofu-local-state',
      'opentofu-remote-state-example'
    ]);
    expect(currentInfrastructureIdentities(['dev'])).toHaveLength(14);
  });
});

describe('infrastructure helper recipes', () => {
  const shell = commandShellForPlatform(process.platform);

  it('selects the exact prod root without a dev fallback', () => {
    const parsed = {
      command: 'infra',
      subcommand: 'plan',
      positional: [],
      flags: { env: 'prod' }
    };
    const root = path.join('project root', 'with spaces');
    const result = buildInfraCommand(parsed, {
      root,
      environments: ['prod']
    });
    expect(result).toBe(formatShellCommand({
      executable: 'tofu',
      args: [
        `-chdir=${path.join(root, 'infrastructure', 'opentofu', 'azure', 'environments', 'prod')}`,
        'plan',
        '-var-file=prod.tfvars'
      ]
    }, shell));
    expect(result).not.toContain('environments/dev');
  });

  it('keeps operational init backend-aware and quotes literal profiles', () => {
    const init = buildInfraCommand({
      command: 'infra',
      subcommand: 'init',
      positional: [],
      flags: { env: 'staging' }
    });
    expect(init).toContain('environments/staging');
    expect(init).not.toContain('-backend=false');

    const dev = buildDevCommand({
      command: 'dev',
      subcommand: 'up',
      positional: [],
      flags: { profile: 'observability profile' }
    });
    expect(dev).toBe(formatShellCommand({
      executable: 'docker',
      args: ['compose', '--profile', 'observability profile', 'up', '--build']
    }, shell));
    expect(formatShellCommand({
      executable: 'tofu',
      args: [
        '-chdir=C:\\Project Files\\infra\\environments\\prod',
        'plan',
        '-var-file=prod.tfvars'
      ]
    }, 'powershell')).toBe(
      "& 'tofu' '-chdir=C:\\Project Files\\infra\\environments\\prod' 'plan' '-var-file=prod.tfvars'"
    );
  });
});
