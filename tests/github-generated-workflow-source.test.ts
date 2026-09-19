import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import type { GitHubRequest } from '../src/adapters/github/activation-rest.js';
import {
  materializeWorkflowPublicationReview, reviewGeneratedWorkflowPublication, type WorkflowPublicationPlan
} from '../src/adapters/github/production-workflows.js';
import {
  applicationBuildWorkflowRecipeId, applicationBuildWorkflowSource, type ApplicationBuildWorkflowRecipe
} from '../src/application/azure-activation/application-build-workflow.js';
import {
  renderEnvironmentRuntimeWorkflow, type EnvironmentRuntimeRecipe
} from '../src/application/azure-activation/environment-runtime-workflow.js';
import {
  stagingSecurityWorkflowRecipeId, stagingSecurityWorkflowSource, stagingSecurityWorkflowDispatchInputs,
  type StagingSecurityWorkflowRecipe
} from '../src/application/azure-activation/staging-security-workflow.js';
import { decodeWorkflow } from '../src/adapters/github/workflow-check-recipes.js';
import { object } from '../src/adapters/github/activation-rest.js';
import {
  executeRepositoryWorkflowSource, planRepositoryWorkflowSource, type WorkflowSourceEvidencePayload, type WorkflowSourceConfiguration
} from '../src/application/repository-governance/producer-workflow-source.js';
import type { PhaseAdapterExecutionInput } from '../src/governance-activation/transition-ports.js';
import { activationProducerFixture } from './helpers/activation-producer-fixture.js';
import { WorkflowGitHubFixture, workflowFixtureNow } from './helpers/workflow-publication-fixture.js';

const generatedPath = '.github/workflows/build-artifacts.yml';
const frontendGeneratedPath = '.github/workflows/build-frontend.yml';
const runtimePath = '.github/workflows/liftoff-environment-dev.yml';
const stagingPath = '.github/workflows/liftoff-staging-security.yml';
const rulesetPath = '.github/rulesets/develop.json';
const fixtures: Awaited<ReturnType<typeof activationProducerFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });

function recipe(): ApplicationBuildWorkflowRecipe {
  return {
    schemaVersion: 1, recipe: applicationBuildWorkflowRecipeId, workflowPath: generatedPath,
    repository: 'owner/repo', repositoryId: 42, actorId: 7, ref: 'develop',
    azure: {
      tenantId: '11111111-2222-4333-8444-555555555551', clientId: '11111111-2222-4333-8444-555555555552',
      principalId: '11111111-2222-4333-8444-555555555553'
    },
    registry: {
      resourceId: '/subscriptions/11111111-2222-4333-8444-555555555554/resourceGroups/build/providers/Microsoft.ContainerRegistry/registries/buildfixture',
      loginServer: 'buildfixture.azurecr.io', location: 'eastus', repository: 'team/app'
    },
    artifactName: 'application-build', platform: 'linux/amd64', context: '.', dockerfile: 'Dockerfile',
    tools: { dockerVersion: '28.0.0', buildxVersion: 'v0.22.0', buildkitImage: `moby/buildkit@sha256:${'b'.repeat(64)}` },
    uploadArtifactActionSha: 'a'.repeat(40),
    budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 },
    limits: { maxRunMinutes: 5, httpTimeoutSeconds: 1, commandTimeoutSeconds: 2, buildTimeoutSeconds: 2 }
  };
}

function runtimeRecipe(): EnvironmentRuntimeRecipe {
  return {
    workflowPath: runtimePath, environment: 'dev',
    resourceId: '/subscriptions/11111111-2222-4333-8444-555555555554/resourceGroups/runtime-source/providers/Microsoft.App/containerApps/runtime-source',
    fqdn: 'runtime-source.fixture.eastus.azurecontainerapps.io', healthPath: '/health', schemaPath: '/openapi.json',
    runner: { group: 'runtime-source-group', label: 'runtime-source-linux' }, uploadArtifactActionSha: 'f'.repeat(40)
  };
}

function stagingRecipe(): StagingSecurityWorkflowRecipe {
  return {
    schemaVersion: 1, recipe: stagingSecurityWorkflowRecipeId, workflowPath: stagingPath,
    repository: 'owner/repo', repositoryId: 42, actorId: 7, ref: 'develop', workflowId: null, sourceSha: null,
    azure: {
      subscriptionId: '11111111-2222-4333-8444-555555555554', tenantId: '11111111-2222-4333-8444-555555555551',
      clientId: '11111111-2222-4333-8444-555555555552', principalId: '11111111-2222-4333-8444-555555555553'
    },
    environment: 'staging',
    target: {
      resourceId: '/subscriptions/11111111-2222-4333-8444-555555555554/resourceGroups/staging-source/providers/Microsoft.App/containerApps/staging-source',
      fqdn: null, appName: 'staging-source', healthPath: '/health', schemaPath: '/openapi.json', privateIp: null
    },
    image: { loginServer: 'buildfixture.azurecr.io', repository: 'team/app', digest: null },
    database: { cacheDirectory: '/srv/liftoff/trivy', databaseSha256: null, metadataSha256: null, maxAgeHours: 24 },
    runner: { group: 'staging-source-group', label: 'staging-source-linux' },
    tools: {
      containerScanner: { name: 'trivy', executable: '/usr/bin/trivy', version: '0.59.1', expectedSha256: `sha256:${'b'.repeat(64)}` },
      dastScanner: { name: 'zap-baseline', executable: '/opt/zap/zap-baseline.py', version: '2.14.0', expectedSha256: `sha256:${'c'.repeat(64)}` },
      azureCli: { name: 'az', executable: '/usr/bin/az', version: '2.74.0', expectedSha256: `sha256:${'e'.repeat(64)}` },
      azureLoginActionSha: 'e'.repeat(40), uploadArtifactActionSha: 'f'.repeat(40)
    },
    authority: {
      allowedNetworkTargets: null, budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 },
      limits: { maxRunMinutes: 15, commandTimeoutSeconds: 60, scanTimeoutSeconds: 300, httpTimeoutSeconds: 15 }
    },
    policy: { failOnSeverities: ['CRITICAL', 'HIGH'], failOnDastRisk: ['HIGH', 'MEDIUM'] }
  };
}

class GeneratedWorkflowProtocol extends WorkflowGitHubFixture {
  override async request(request: GitHubRequest) {
    const registered = [{ path: generatedPath, id: 82 }, { path: runtimePath, id: 83 }, { path: stagingPath, id: 84 },
      { path: frontendGeneratedPath, id: 85 }]
      .find((workflow) => [`/repos/owner/repo/actions/workflows/${workflow.path.split('/').at(-1)}`,
        `/repos/owner/repo/actions/workflows/${workflow.id}`].includes(request.path));
    if (request.method === 'GET' && registered) {
      this.requests.push(structuredClone(request));
      const commit = this.commits.get(this.refs.get('develop')!);
      const tree = commit ? this.trees.get((commit.tree as { sha: string }).sha) : undefined;
      const present = this.workflowVisible && tree?.some((entry) => entry.path === registered.path);
      return { status: present ? 200 : 404, headers: {},
        data: present ? { id: registered.id, path: registered.path, state: this.workflowState } : { message: 'Not registered in fixture' } };
    }
    return super.request(request);
  }
}

async function sourceFixture<T extends Record<string, unknown>>(
  phaseId: 'workflow-source-ready' | 'bootstrap-workflow-source-ready' | 'repository-workflow-source-ready',
  phaseInputs: T, protocol: GeneratedWorkflowProtocol
) {
  const f = await activationProducerFixture(phaseId, phaseInputs, protocol.runner);
  fixtures.push(f);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === phaseId)!;
  const plan = () => planRepositoryWorkflowSource({ inspection: f.inspection, phase, runner: f.runner, now: f.now });
  const approve = async () => {
    const input = await f.approve();
    input.adapters.githubActivation = { storage: f.storage };
    return input;
  };
  const execute = (input: PhaseAdapterExecutionInput) => withProjectMutationLock(f.projectRoot,
    (lease) => executeRepositoryWorkflowSource({ ...input, lease }));
  return { ...f, protocol, phaseInputs, plan, approve, execute };
}

async function generatedFixture(phaseId: 'workflow-source-ready' | 'bootstrap-workflow-source-ready' = 'workflow-source-ready') {
  const protocol = new GeneratedWorkflowProtocol();
  const applicationBuild = recipe();
  const phaseInputs = {
    sourceSha: protocol.baseSha, paths: [generatedPath, rulesetPath], applicationBuild,
    publication: {
      featureBranch: 'automation/generated-build-source', repositoryId: 42, actorId: 7,
      commitTime: workflowFixtureNow, commitMessage: 'Publish exact registered build workflow'
    }
  };
  const f = await sourceFixture(phaseId, phaseInputs, protocol);
  await mkdir(path.dirname(path.join(f.projectRoot, rulesetPath)), { recursive: true });
  await writeFile(path.join(f.projectRoot, rulesetPath), rulesetSource);
  await f.refreshInputs();
  return { ...f, applicationBuild, generatedFile: path.join(f.projectRoot, generatedPath) };
}

type GeneratedFamily = 'applicationBuild' | 'environmentRuntime' | 'stagingSecurity';
const rulesetSource = '{"name":"Reviewed source control","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/develop"],"exclude":[]}},"rules":[{"type":"deletion"}]}\n';

async function expandedFixture(
  families: readonly GeneratedFamily[],
  options: { missingRuleset?: boolean; phaseId?: 'workflow-source-ready' | 'bootstrap-workflow-source-ready' | 'repository-workflow-source-ready' } = {}
) {
  const protocol = new GeneratedWorkflowProtocol();
  const applicationBuild = recipe(), environmentRuntime = runtimeRecipe(), stagingSecurity = stagingRecipe();
  const paths = families.map((family) => family === 'applicationBuild' ? generatedPath : family === 'environmentRuntime' ? runtimePath : stagingPath);
  const phaseInputs = {
    sourceSha: protocol.baseSha, paths: [...paths, rulesetPath],
    publication: { featureBranch: 'automation/generated-source-families', repositoryId: 42, actorId: 7,
      commitTime: workflowFixtureNow, commitMessage: 'Publish exact registered source families' },
    ...(families.includes('applicationBuild') ? { applicationBuild } : {}),
    ...(families.includes('environmentRuntime') ? { environmentRuntime: { recipe: environmentRuntime } } : {}),
    ...(families.includes('stagingSecurity') ? { stagingSecurity } : {})
  } satisfies WorkflowSourceConfiguration;
  const f = await sourceFixture(options.phaseId ?? 'workflow-source-ready', phaseInputs, protocol);
  if (!options.missingRuleset) {
    await mkdir(path.dirname(path.join(f.projectRoot, rulesetPath)), { recursive: true });
    await writeFile(path.join(f.projectRoot, rulesetPath), rulesetSource);
    await f.refreshInputs();
  }
  return { ...f, applicationBuild, environmentRuntime, stagingSecurity, paths };
}

describe('registered generated workflow publication', () => {
  it('publishes both explicitly bound backend/frontend build sources without replacing the singular contract or creating local files', async () => {
    const protocol = new GeneratedWorkflowProtocol();
    const backend = recipe();
    const frontend: ApplicationBuildWorkflowRecipe = {
      ...recipe(), workflowPath: frontendGeneratedPath, artifactName: 'frontend-build', context: 'frontend',
      dockerfile: 'frontend/Dockerfile', registry: { ...recipe().registry, repository: 'team/frontend' }
    };
    const phaseInputs = {
      sourceSha: protocol.baseSha, paths: [generatedPath, frontendGeneratedPath, rulesetPath],
      applicationBuilds: [backend, frontend],
      publication: { featureBranch: 'automation/reviewed-component-builds', repositoryId: 42, actorId: 7,
        commitTime: workflowFixtureNow, commitMessage: 'Publish exact backend and frontend build source' }
    };
    const f = await sourceFixture('workflow-source-ready', phaseInputs, protocol);
    await mkdir(path.dirname(path.join(f.projectRoot, rulesetPath)), { recursive: true });
    await writeFile(path.join(f.projectRoot, rulesetPath), rulesetSource);
    await f.refreshInputs();
    const planned = await f.plan();
    expect(planned.blockers).toBeUndefined();
    expect(planned.operations[0]!.inputs.generatedSources).toEqual([backend, frontend].map((value) => ({
      recipe: applicationBuildWorkflowRecipeId,
      recipeDigest: applicationBuildWorkflowSource(value).recipeDigest,
      remoteOnlyPaths: [value.workflowPath]
    })));
    const input = await f.approve();
    expect((await f.execute(input)).status).toBe('pending');
    protocol.merge(1);
    const result = await f.execute(input);
    expect(result).toMatchObject({
      status: 'completed', outputs: { values: { workflowCount: 2, generatedSourceCount: 2, generatedRemoteOnlyCount: 2 } }
    });
    expect(result.liveReadback?.filter((proof) => proof.resourceType === 'workflow').map((proof) => proof.resourceId).sort()).toEqual([
      '/repos/owner/repo/actions/workflows/82', '/repos/owner/repo/actions/workflows/85'
    ]);
    for (const value of [backend, frontend]) await expect(readFile(path.join(f.projectRoot, value.workflowPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(protocol.refs.get('main')).toBe(protocol.mainSha);
  });

  it.each(['empty', 'too-many', 'duplicate-path', 'mixed-contracts'])('rejects %s plural build source before publication', async (fault) => {
    const f = await generatedFixture();
    const phase = f.inspection.activationInputs!.phases['workflow-source-ready']!;
    phase.applicationBuilds = fault === 'empty' ? [] : fault === 'too-many' ?
      [f.applicationBuild, f.applicationBuild, f.applicationBuild] : [f.applicationBuild, f.applicationBuild];
    if (fault !== 'mixed-contracts') delete phase.applicationBuild;
    expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.any(String)] });
    expect(f.protocol.requests).toEqual([]);
  });

  it('plans exact remote-only generated bytes without a local workflow or any file mutation', async () => {
    const f = await generatedFixture();
    const planned = await f.plan();
    expect(planned.blockers).toBeUndefined();
    expect(planned.fileMutations).toBeUndefined();
    const source = applicationBuildWorkflowSource(f.applicationBuild);
    const operation = planned.operations[0]!;
    expect(operation).toMatchObject({
      actionId: 'github.workflow-source.publish', mutationClass: 'github-write', remote: true,
      inputs: { generatedSource: { recipe: applicationBuildWorkflowRecipeId, recipeDigest: source.recipeDigest, remoteOnlyPaths: [generatedPath] } }
    });
    const publication = operation.inputs.publication as WorkflowPublicationPlan;
    expect(publication).not.toHaveProperty('representation');
    expect(publication.files.find((file) => file.path === generatedPath)).toMatchObject({ ...source.files[0], beforeBlobSha: null });
    await expect(readFile(f.generatedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  describe('registered runtime and staging source publication', () => {
    it.each(['environmentRuntime', 'stagingSecurity'] as const)('publishes and re-reads remote-only %s with actual ruleset/workflow IDs and no local source creation', async (family) => {
      const f = await expandedFixture([family]);
      const expected = family === 'environmentRuntime' ? {
        recipe: 'environmentRuntime', recipeDigest: canonicalSha256(f.environmentRuntime),
        files: [{ path: runtimePath, content: renderEnvironmentRuntimeWorkflow(f.environmentRuntime),
          digest: canonicalSha256(renderEnvironmentRuntimeWorkflow(f.environmentRuntime)) }]
      } : stagingSecurityWorkflowSource(f.stagingSecurity);
      const before = canonicalSha256(f.phaseInputs);
      const input = await f.approve();
      const planned = input.plan.operations.find((operation) => operation.actionId === 'github.workflow-source.publish')!;
      expect(planned.inputs.generatedSource).toEqual({ recipe: expected.recipe, recipeDigest: expected.recipeDigest, remoteOnlyPaths: f.paths });
      const publication = materializeWorkflowPublicationReview(planned.inputs.publication, expected.files);
      expect(publication.files.find((file) => file.path === f.paths[0])).toMatchObject(expected.files[0]!);
      expect(await f.execute(input)).toMatchObject({ status: 'pending', blocker: expect.stringContaining('remote-only') });
      expect((await f.execute(input)).status).toBe('pending');
      const merged = f.protocol.merge(1);
      const result = await f.execute(input);
      expect(result).toMatchObject({
        status: 'completed', resultState: 'verified', evidencePayload: {
          sourceSha: merged, rulesetSourceDigest: canonicalSha256([{ path: rulesetPath, digest: canonicalSha256(rulesetSource) }]),
          generatedSource: { recipe: expected.recipe, recipeDigest: expected.recipeDigest, remoteOnlyPaths: f.paths },
          workflows: [{ path: f.paths[0], workflowId: family === 'environmentRuntime' ? 83 : 84, sourceSha: merged }]
        }
      });
      expect(canonicalSha256(f.phaseInputs)).toBe(before);
      await expect(readFile(path.join(f.projectRoot, f.paths[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(f.projectRoot, rulesetPath), 'utf8')).toBe(rulesetSource);
      expect(f.protocol.requests.filter((request) => request.method !== 'GET').map((request) => request.path)).toEqual([
        '/repos/owner/repo/git/trees', '/repos/owner/repo/git/commits', '/repos/owner/repo/git/refs', '/repos/owner/repo/pulls'
      ]);

      const { publication: _publication, ...readback } = f.phaseInputs;
      f.inspection.activationInputs!.phases['workflow-source-ready'] = { ...readback, sourceSha: merged };
      await f.refreshInputs();
      expect((await f.execute(await f.approve())).status).toBe('completed');
      expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toHaveLength(4);
    });

    it('publishes all three families in one reviewed transaction with separate recipe disclosures', async () => {
      const f = await expandedFixture(['applicationBuild', 'environmentRuntime', 'stagingSecurity']);
      const input = await f.approve();
      const operation = input.plan.operations.find((entry) => entry.actionId === 'github.workflow-source.publish')!;
      expect(Buffer.byteLength(canonicalJson(input.plan))).toBeLessThan(64 * 1024);
      const reviewed = object(operation.inputs.publication);
      expect(reviewed.representation).toBe('registered-generated-source.v1');
      expect((reviewed.files as Array<Record<string, unknown>>).filter((file) => file.contentSource === 'registered-generator')).toHaveLength(3);
      expect((reviewed.files as Array<Record<string, unknown>>).find((file) => file.path === rulesetPath)!.content).toBe(rulesetSource);
      expect(operation.inputs.generatedSource).toBeUndefined();
      expect(operation.inputs.generatedSources).toEqual([
        { recipe: applicationBuildWorkflowRecipeId, recipeDigest: applicationBuildWorkflowSource(f.applicationBuild).recipeDigest,
          remoteOnlyPaths: [generatedPath] },
        { recipe: 'environmentRuntime', recipeDigest: canonicalSha256(f.environmentRuntime), remoteOnlyPaths: [runtimePath] },
        { recipe: stagingSecurityWorkflowRecipeId, recipeDigest: stagingSecurityWorkflowSource(f.stagingSecurity).recipeDigest,
          remoteOnlyPaths: [stagingPath] }
      ]);
      expect((await f.execute(input)).status).toBe('pending');
      f.protocol.merge(1);
      const outcome = await f.execute(input);
      expect(outcome).toMatchObject({
        status: 'completed', evidencePayload: { generatedSources: operation.inputs.generatedSources },
        outputs: { values: { workflowCount: 3, generatedSourceCount: 3, generatedRemoteOnlyCount: 3,
          generatedSourcesDigest: canonicalSha256(operation.inputs.generatedSources) } }
      });
      expect((outcome.evidencePayload as WorkflowSourceEvidencePayload).generatedSource).toBeUndefined();
      for (const name of f.paths) await expect(readFile(path.join(f.projectRoot, name))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toHaveLength(4);
    });

    it.each(['environmentRuntime', 'stagingSecurity'] as const)('accepts exact local %s bytes but preserves and rejects conflicts', async (family) => {
      const f = await expandedFixture([family]);
      const content = family === 'environmentRuntime' ? renderEnvironmentRuntimeWorkflow(f.environmentRuntime) :
        stagingSecurityWorkflowSource(f.stagingSecurity).files[0]!.content;
      const file = path.join(f.projectRoot, f.paths[0]!);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      await f.refreshInputs();
      expect((await f.plan()).operations[0]!.inputs.generatedSource).toMatchObject({ remoteOnlyPaths: [] });
      const conflict = `${content}\n# Preserved user-owned source\n`;
      await writeFile(file, conflict);
      expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('preserved; no overwrite or adoption')] });
      expect(await readFile(file, 'utf8')).toBe(conflict);
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it.each(['environmentRuntime', 'stagingSecurity'] as const)('requires exact selected %s and actual file-backed ruleset paths', async (family) => {
      const missingRule = await expandedFixture([family], { missingRuleset: true });
      expect(await missingRule.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('is absent')] });
      expect(missingRule.protocol.requests).toEqual([]);
      const unselected = await expandedFixture([family]);
      unselected.phaseInputs.paths = [rulesetPath];
      expect(await unselected.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('explicitly selected')] });
      expect(unselected.protocol.requests).toEqual([]);
    });

    it.each(['bootstrap-workflow-source-ready', 'repository-workflow-source-ready'] as const)('does not admit new families through %s authority', async (phaseId) => {
      for (const family of ['environmentRuntime', 'stagingSecurity'] as const) {
        const f = await expandedFixture([family], { phaseId });
        expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('only to workflow-source-ready')] });
        expect(f.protocol.requests).toEqual([]);
      }
    });

    it.each(['repository', 'repositoryId', 'actorId', 'ref'] as const)('rejects staging %s drift from the publication binding', async (field) => {
      const f = await expandedFixture(['stagingSecurity']);
      if (field === 'repository') f.stagingSecurity.repository = 'other/repo';
      if (field === 'repositoryId') f.stagingSecurity.repositoryId = 43;
      if (field === 'actorId') f.stagingSecurity.actorId = 8;
      if (field === 'ref') f.stagingSecurity.ref = 'main';
      expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('publication binding')] });
      expect(f.protocol.requests).toEqual([]);
    });

    it('binds runtime-only source to the real repository/actor publication rather than inventing recipe principal fields', async () => {
      const f = await expandedFixture(['environmentRuntime']);
      f.phaseInputs.publication.actorId = 8;
      expect((await f.plan()).operations).toEqual([]);
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('keeps all future staging facts null and out of source, while dispatch still requires exact later values', async () => {
      const f = await expandedFixture(['stagingSecurity']);
      const source = stagingSecurityWorkflowSource(f.stagingSecurity);
      expect(() => stagingSecurityWorkflowDispatchInputs(f.stagingSecurity)).toThrow(/actual published workflow/);
      const jobs = object(decodeWorkflow(source.files[0]!.content).jobs);
      const steps = object(jobs.security_dast).steps;
      if (!Array.isArray(steps)) throw new Error('Registered staging source has no steps.');
      const environment = steps.map((step) => object(step).env).find((value) =>
        value !== undefined && Object.hasOwn(object(value), 'LIFTOFF_STAGING_SECURITY_RECIPE'));
      const embedded = JSON.parse(String(object(environment).LIFTOFF_STAGING_SECURITY_RECIPE));
      expect(embedded).not.toHaveProperty('sourceSha');
      expect(embedded).not.toHaveProperty('workflowId');
      expect(embedded.target).not.toHaveProperty('fqdn');
      expect(embedded.image).not.toHaveProperty('digest');
      expect(embedded.database).not.toHaveProperty('databaseSha256');
      expect(embedded.database).not.toHaveProperty('metadataSha256');
      expect(embedded.authority).not.toHaveProperty('allowedNetworkTargets');
      expect(embedded.runner).toEqual(f.stagingSecurity.runner);
      expect(embedded.runner).not.toHaveProperty('runnerId');
      expect(embedded.runner).not.toHaveProperty('runnerGroupId');
      const later = structuredClone(f.stagingSecurity);
      later.workflowId = 987;
      later.sourceSha = '9'.repeat(40);
      later.target.fqdn = 'later.fixture.eastus.azurecontainerapps.io';
      later.image.digest = `sha256:${'9'.repeat(64)}`;
      later.database.databaseSha256 = '8'.repeat(64);
      later.database.metadataSha256 = '7'.repeat(64);
      later.runner = { ...later.runner, runnerId: null, runnerGroupId: 12 };
      later.authority.allowedNetworkTargets = [later.target.fqdn, 'api.github.com', later.image.loginServer];
      expect(stagingSecurityWorkflowSource(later)).toEqual(source);
      expect(stagingSecurityWorkflowDispatchInputs(later)).toMatchObject({
        workflow_id: '987', source_sha: '9'.repeat(40), image_digest: `sha256:${'9'.repeat(64)}`,
        runner_group_id: '12', runner_id: 'none'
      });
      expect((await f.plan()).operations[0]!.inputs.generatedSource).toMatchObject({ recipeDigest: source.recipeDigest });
      expect(f.stagingSecurity.workflowId).toBeNull();
      expect(f.stagingSecurity.sourceSha).toBeNull();
      expect(f.stagingSecurity.target.fqdn).toBeNull();
    });

    it.each(['environmentRuntime', 'stagingSecurity'] as const)('rejects %s static recipe drift after review before any provider write', async (family) => {
      const f = await expandedFixture([family]);
      const input = await f.approve();
      if (family === 'environmentRuntime') f.environmentRuntime.healthPath = '/new-health';
      else f.stagingSecurity.tools.containerScanner.version = '0.60.0';
      expect((await f.execute(input)).status).toBe('blocked');
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('does not let two generated families claim the same exact path', async () => {
      const f = await expandedFixture(['applicationBuild', 'environmentRuntime']);
      f.applicationBuild.workflowPath = runtimePath;
      f.phaseInputs.paths = [runtimePath, rulesetPath];
      expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('same generated workflow path')] });
      expect(f.protocol.requests).toEqual([]);
    });

    it('rejects arbitrary environment wrapper fields instead of accepting unregistered source bytes or authority flags', async () => {
      const f = await expandedFixture(['environmentRuntime']);
      Object.assign(f.phaseInputs.environmentRuntime!, { approved: true, content: 'unregistered: yaml' });
      expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('only its registered recipe')] });
      expect(f.protocol.requests).toEqual([]);
    });

    it('keeps approved generated byte references exact and cannot substitute ruleset or arbitrary local content', async () => {
      const f = await expandedFixture(['stagingSecurity']);
      const planned = await f.plan();
      const reviewed = planned.operations[0]!.inputs.publication;
      const generated = stagingSecurityWorkflowSource(f.stagingSecurity).files;
      const publication = materializeWorkflowPublicationReview(reviewed, generated);
      expect(() => reviewGeneratedWorkflowPublication(publication, [rulesetPath])).toThrow(/never ruleset/);
      expect(() => materializeWorkflowPublicationReview(reviewed, [])).toThrow(/current trusted renderer inventory/);
      for (const change of ['digest', 'blobSha', 'inline', 'encoding'] as const) {
        const altered = object(structuredClone(reviewed));
        const file = (altered.files as Array<Record<string, unknown>>).find((entry) => entry.path === stagingPath)!;
        if (change === 'digest') file.digest = '9'.repeat(64);
        if (change === 'blobSha') file.blobSha = '9'.repeat(40);
        if (change === 'inline') file.content = generated[0]!.content;
        if (change === 'encoding') file.contentSource = 'unregistered-generator';
        expect(() => materializeWorkflowPublicationReview(altered, generated)).toThrow();
      }
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('recovers the exact compact staged publication after a lost PR response without repeating writes', async () => {
      const f = await expandedFixture(['stagingSecurity']);
      const input = await f.approve();
      f.protocol.loseResponseFor = 'POST /repos/owner/repo/pulls';
      expect((await f.execute(input)).status).toBe('blocked');
      f.inspection.state.phases['workflow-source-ready'].executionPlanDigest = input.plan.planDigest;
      f.inspection.contexts['workflow-source-ready'].reviewedPlans = [input.plan];
      const original = input.plan.operations.find((operation) => operation.actionId === 'github.workflow-source.publish')!;
      expect((await f.plan()).operations[0]).toEqual(original);
      expect(await f.execute(input)).toMatchObject({ status: 'pending',
        operation: { operationId: '1', resourceId: '/repos/owner/repo/pulls/1' } });
      f.protocol.merge(1);
      expect((await f.execute(input)).status).toBe('completed');
      expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toHaveLength(4);
    });

    it('requires a new review when combined generated/local disclosure changes despite identical file bytes', async () => {
      const f = await expandedFixture(['environmentRuntime', 'stagingSecurity']);
      const input = await f.approve();
      await mkdir(path.dirname(path.join(f.projectRoot, runtimePath)), { recursive: true });
      await writeFile(path.join(f.projectRoot, runtimePath), renderEnvironmentRuntimeWorkflow(f.environmentRuntime));
      expect(await f.execute(input)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('local/remote-only source disclosure changed') });
      expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
    });
  });

  it('publishes and recovers the exact generated workflow through the existing PR/checkpoint path, without local writes', async () => {
    const f = await generatedFixture();
    const input = await f.approve();
    expect(await f.execute(input)).toMatchObject({ status: 'pending', blocker: expect.stringContaining('remote-only'),
      operation: { operationId: '1', resourceId: '/repos/owner/repo/pulls/1' } });
    expect((await f.execute(input)).status).toBe('pending');
    const merged = f.protocol.merge(1);
    const outcome = await f.execute(input);
    expect(outcome).toMatchObject({
      status: 'completed', resultState: 'verified', evidencePayload: {
        sourceSha: merged, generatedSource: { recipe: applicationBuildWorkflowRecipeId, remoteOnlyPaths: [generatedPath] },
        workflows: [{ path: generatedPath, workflowId: 82, sourceSha: merged }]
      }, outputs: { values: { generatedRemoteOnlyCount: 1 } }
    });
    expect(outcome.fileMutations).toBeUndefined();
    await expect(readFile(f.generatedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.protocol.requests.filter((request) => request.method !== 'GET').map((request) => request.path)).toEqual([
      '/repos/owner/repo/git/trees', '/repos/owner/repo/git/commits', '/repos/owner/repo/git/refs', '/repos/owner/repo/pulls'
    ]);

    f.inspection.activationInputs!.phases['workflow-source-ready'] = {
      sourceSha: merged, paths: [generatedPath, rulesetPath], applicationBuild: f.applicationBuild
    };
    await f.refreshInputs();
    const readback = await f.approve();
    expect(readback.plan.operations.some((operation) => operation.actionId === 'github.workflow-source.publish')).toBe(false);
    expect((await f.execute(readback)).status).toBe('completed');
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toHaveLength(4);
    await expect(readFile(f.generatedFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts matching local bytes but refuses a differing local file without overwriting or adopting it', async () => {
    const f = await generatedFixture();
    await mkdir(path.dirname(f.generatedFile), { recursive: true });
    const content = applicationBuildWorkflowSource(f.applicationBuild).files[0]!.content;
    await writeFile(f.generatedFile, content);
    await f.refreshInputs();
    expect((await f.plan()).operations[0]!.inputs.generatedSource).toMatchObject({ remoteOnlyPaths: [] });
    const different = `${content}\n# User-owned difference\n`;
    await writeFile(f.generatedFile, different);
    expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('preserved; no overwrite or adoption')] });
    expect(await readFile(f.generatedFile, 'utf8')).toBe(different);
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['repository', 'repositoryId', 'actorId', 'ref'] as const)('rejects recipe %s outside the reviewed publication binding', async (field) => {
    const f = await generatedFixture();
    if (field === 'repository') f.applicationBuild.repository = 'other/repo';
    if (field === 'repositoryId') f.applicationBuild.repositoryId = 43;
    if (field === 'actorId') f.applicationBuild.actorId = 8;
    if (field === 'ref') f.applicationBuild.ref = 'main';
    expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('publication binding')] });
    expect(f.protocol.requests).toEqual([]);
  });

  it('requires an explicitly selected exact generated path and the owning application source phase', async () => {
    const unselected = await generatedFixture();
    unselected.phaseInputs.paths = ['.github/workflows/unrelated.yml'];
    expect(await unselected.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('explicitly selected')] });
    const wrongPhase = await generatedFixture('bootstrap-workflow-source-ready');
    expect(await wrongPhase.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('only to workflow-source-ready')] });
    expect(unselected.protocol.requests).toEqual([]);
    expect(wrongPhase.protocol.requests).toEqual([]);
  });

  it('refuses unregistered recipe fields rather than treating arbitrary generated bytes as trusted', async () => {
    const f = await generatedFixture();
    Object.assign(f.applicationBuild, { unregisteredCommand: 'not a recipe field' });
    const planned = await f.plan();
    expect(planned.operations).toEqual([]);
    expect(planned.blockers).toHaveLength(1);
    expect(f.protocol.requests).toEqual([]);
  });

  it('keeps ruleset source file-backed and its inventory digest independent from generated metadata', async () => {
    const f = await generatedFixture();
    await unlink(path.join(f.projectRoot, rulesetPath));
    expect(await f.plan()).toMatchObject({ operations: [], blockers: [expect.stringContaining('is absent')] });
    const content = '{"name":"reviewed-source","target":"branch"}\n';
    await mkdir(path.dirname(path.join(f.projectRoot, rulesetPath)), { recursive: true });
    await writeFile(path.join(f.projectRoot, rulesetPath), content);
    await f.refreshInputs();
    const input = await f.approve();
    expect((await f.execute(input)).status).toBe('pending');
    f.protocol.merge(1);
    const outcome = await f.execute(input);
    expect(outcome.status).toBe('completed');
    const payload = outcome.evidencePayload as WorkflowSourceEvidencePayload;
    expect(payload.rulesetSourceDigest).toBe(canonicalSha256([{ path: rulesetPath, digest: canonicalSha256(content) }]));
    expect(await readFile(path.join(f.projectRoot, rulesetPath), 'utf8')).toBe(content);
  });

  it('does not publish application workflows as a complete phase without reviewed ruleset source', async () => {
    const f = await generatedFixture();
    f.phaseInputs.paths = [generatedPath];
    expect(await f.plan()).toMatchObject({
      operations: [], blockers: [expect.stringContaining('requires exact reviewed ruleset source paths')]
    });
    expect(f.protocol.requests).toEqual([]);
    await expect(readFile(f.generatedFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects generated recipe changes after approval before any provider write', async () => {
    const f = await generatedFixture();
    const input = await f.approve();
    f.applicationBuild.tools.dockerVersion = '29.0.0';
    expect((await f.execute(input)).status).toBe('blocked');
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('preserves a conflicting file introduced after review instead of overwriting it during execution', async () => {
    const f = await generatedFixture();
    const input = await f.approve();
    await mkdir(path.dirname(f.generatedFile), { recursive: true });
    await writeFile(f.generatedFile, 'unreviewed local source\n');
    expect((await f.execute(input)).status).toBe('blocked');
    expect(await readFile(f.generatedFile, 'utf8')).toBe('unreviewed local source\n');
    expect(f.protocol.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
