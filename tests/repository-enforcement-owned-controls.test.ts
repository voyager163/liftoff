import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it as registerTest, vi } from 'vitest';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildManifest } from '../src/templates.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { githubSourceFixture } from './helpers/github-source-fixture.js';
import { sourceCheckFailureLog } from './helpers/workflow-publication-fixture.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import {
  evaluateApprovalForTransitionPlan, transitionPlanForPhase
} from '../src/domain/governance/activation/approvals.js';
import { validateApprovalEnvelope, validateSavedTransitionPlan, validateUserActivationState } from '../src/domain/governance/activation/validators.js';
import { planDigestFor, rollbackPlanForPhase } from '../src/domain/governance/activation/operations.js';
import { evidenceBodyDigest, validateEvidenceFreshness } from '../src/domain/governance/activation/evidence.js';
import { phaseIds, type ActivationConfiguration, type PhaseEvidenceRecord, type PhaseId, type TransitionOperation } from '../src/domain/governance/activation/types.js';
import type { GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import type { CommandRunner } from '../src/process-runner.js';
import { activationEvidenceContexts, readActivationInputSnapshot } from '../src/governance-activation/inputs.js';
import { loadActivationState } from '../src/governance-activation/activation-state.js';
import { planGitHubPhase, executeGitHubPhase } from '../src/governance-activation/phase-github.js';
import { saveGovernancePreview, approveGovernancePreview } from '../src/governance-activation/public-plans.js';
import { bindGovernanceTransitionContext } from '../src/governance-activation/transition-context.js';
import { blockedState, evidenceHeaderFor, nextStateForOutcome, readbackProof, writeOutcomeTransaction } from '../src/governance-activation/transition-records.js';
import { writeGovernanceApprovalAuthority } from '../src/governance-activation/authority-records.js';
import * as runtimeReceipts from '../src/application/azure-activation/environment-runtime-receipt.js';
import { AzureActivationAdmissionError } from '../src/application/azure-activation/authority.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem } from '../src/adapters/filesystem/update-previews.js';
import {
  GitHubActivationClient, GitHubActivationError, type GitHubActivationTransport, type GitHubRequest
} from '../src/adapters/github/activation-rest.js';
import {
  buildCanonicalGitFlowRulesets, buildRepositoryControlPlan, productionRulesetSourceDigest,
  repositoryControlMutationBlockers, repositoryControlWriteRequest, observeRepositoryControlWriteResponse,
  type RepositoryControlPlan
} from '../src/adapters/github/production-rulesets.js';
import { observeRepositoryControls } from '../src/adapters/github/repository-control-observation.js';
import {
  executeRepositoryRulesets, planRepositoryLiveReadback, planRepositoryRulesets
} from '../src/application/repository-governance/producer-rulesets.js';
import {
  readPrivateOwnedRepositoryControls, readRepositoryControlCheckpoint
} from '../src/application/repository-governance/repository-control-checkpoints.js';
import { readRepositoryControlReceipt } from '../src/application/repository-governance/repository-control-receipts.js';
import {
  createMainUpdateHold, evaluateMainHoldReplacement
} from '../src/application/repository-governance/producer-main-hold.js';
import {
  controlledNodeTestFixture, controlledSourceCheckFixtures, deriveRequiredSourceChecks, protectedRefFamilies,
  sourceCheckFixtureArtifact,
  type SourceCheckRecipe, type SourceCheckDirectory, type RequiredWorkflowCheck
} from '../src/adapters/github/workflow-check-recipes.js';
import { readbackWorkflowContent, type WorkflowPublicationPlan } from '../src/adapters/github/production-workflows.js';
import { treeWithFiles, workflowCommitSha } from '../src/adapters/github/workflow-git-objects.js';
import {
  qualifyRepositorySourceChecks, repositoryCheckContextsFromQualification,
  type BoundRepositoryCheckFixture, type RepositoryChecksEvidencePayload, type ProtectedRefFamily
} from '../src/adapters/github/production-checks.js';
import { prepareWorkflowEffect, recordWorkflowProviderResult } from '../src/application/repository-governance/workflow-checkpoints.js';
import { repositoryControlSource } from '../src/application/repository-governance/repository-control-source.js';
import { revalidateApprovedRepositoryChecks } from '../src/application/repository-governance/repository-check-revalidation.js';
import { assertFullControlQualification } from '../src/application/repository-governance/full-control-qualification.js';

let activeTestBodies = 0;

function it(name: string, body: () => void | Promise<void>) {
  return registerTest(name, async () => {
    activeTestBodies++;
    try { await body(); }
    finally { activeTestBodies--; }
  });
}

it.each = <T extends string>(values: readonly T[]) =>
  (name: string, body: (value: T) => void | Promise<void>) => {
    for (const value of values) it(name.replace('%s', value), () => body(value));
  };

async function fixtureDirectoryIdentity(directory: string) {
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Preserving fixture scope with changed directory type: ${directory}`);
  return { path: await realpath(directory), device: stat.dev, inode: stat.ino, birthtime: stat.birthtimeNs, user: stat.uid };
}

function assertFixtureDirectoryIdentity(
  expected: Awaited<ReturnType<typeof fixtureDirectoryIdentity>>,
  actual: Awaited<ReturnType<typeof fixtureDirectoryIdentity>>
): void {
  if (expected.path !== actual.path || expected.device !== actual.device || expected.inode !== actual.inode ||
    expected.birthtime !== actual.birthtime || expected.user !== actual.user) {
    throw new Error(`Preserving fixture scope whose creation identity changed: ${expected.path}`);
  }
}

async function isolatedControlProject(phaseId: PhaseId, phaseInputs: Record<string, unknown>, runner: CommandRunner) {
  const parentIdentity = await fixtureDirectoryIdentity(path.resolve('tests'));
  const root = path.join(parentIdentity.path, `.repository-enforcement-${randomUUID()}`);
  const projectRoot = path.join(root, 'project');
  const home = path.join(root, 'home');
  const project = buildProjectPlan({
    projectName: 'Owned repository enforcement', projectType: 'standard', apiStack: 'node-fastify', cloud: 'azure',
    region: 'eastus', environments: ['dev'], includeFrontend: false, specWorkflow: 'openspec', agents: ['github-copilot']
  }, { requireProjectName: true });
  const manifestInput = buildManifest(project, []);
  if (manifestInput.governance.profile !== 'none' && manifestInput.governance.profile !== 'unspecified') {
    manifestInput.governance.state = 'handoff-partial';
  }
  const manifest = parseManifest(manifestInput);
  await mkdir(root, { mode: 0o700 });
  const creationIdentity = await fixtureDirectoryIdentity(root);
  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const now = new Date('2026-09-15T00:00:00.000Z');
  const storage = { homedir: home, repositoryRoot: projectRoot, env: {}, clock: () => now };
  const configuration: ActivationConfiguration = { schemaVersion: 1, phases: { [phaseId]: phaseInputs } };
  const state = validateUserActivationState({
    schemaVersion: 4, identity: currentActivationIdentity,
    repository: { id: `local:${randomUUID()}`, name: 'enforcement', defaultBranch: 'develop' },
    remoteBinding: { id: '42', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git', verifiedAt: now.toISOString() },
    activeChange: null, applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
    activationInputs: configuration,
    phases: Object.fromEntries(phaseIds.map((id) => [id, { state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: [] }])),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  });
  await writeFile(path.join(projectRoot, 'liftoff.manifest.json'), canonicalJson(manifest));
  await mkdir(path.join(projectRoot, 'governance'));
  await writeFile(path.join(projectRoot, 'governance', 'activation-state.json'), canonicalJson(state));
  const localReads: CommandRunner = { async run(command) {
    return {
      command, displayCommand: 'isolated fixture metadata read', status: 128, signal: null, timedOut: false,
      stdout: '', stderr: 'isolated fixture has no Git repository'
    };
  } };
  const snapshot = await readActivationInputSnapshot(projectRoot, manifest, localReads);
  const inspection: GovernanceTransitionInspection = {
    projectRoot, manifest, graph: canonicalPhaseGraph, graphHash: canonicalPhaseGraphHash, scope: 'repository',
    activationInputs: configuration, state, loadedState: await loadActivationState(projectRoot),
    approvals: [], evidence: [], contexts: activationEvidenceContexts(canonicalPhaseGraph, state, snapshot, now),
    readiness: { nextReadyPhase: null, nextPlannablePhase: phaseId, phases: structuredClone(state.phases) },
    sourceOfTruth: { status: 'none', selected: null, candidates: [], createPlan: { status: 'blocked', changeId: 'isolated-enforcement', workflowKind: 'openspec', reason: 'Fixture only.', requiredFacts: [] } }
  };
  return {
    root, projectRoot, home, storage, inspection, now, runner, creationIdentity,
    async refreshInputs() {
      const retainedContexts = inspection.contexts;
      inspection.state.activationInputs = inspection.activationInputs;
      inspection.contexts = activationEvidenceContexts(canonicalPhaseGraph, inspection.state,
        await readActivationInputSnapshot(projectRoot, manifest, localReads), now);
      for (const id of phaseIds) inspection.contexts[id].reviewedPlans = retainedContexts[id].reviewedPlans;
      inspection.loadedState = await loadActivationState(projectRoot);
    },
    async cleanup() {
      if (activeTestBodies !== 0) {
        throw new Error(`Preserving fixture scope while owning test work is unsettled: ${root}`);
      }
      assertFixtureDirectoryIdentity(parentIdentity, await fixtureDirectoryIdentity(parentIdentity.path));
      assertFixtureDirectoryIdentity(creationIdentity, await fixtureDirectoryIdentity(root));
      await rm(creationIdentity.path, { recursive: true });
    }
  };
}

const fixtures: Awaited<ReturnType<typeof isolatedControlProject>>[] = [];
afterEach(async () => {
  while (fixtures.length) {
    await fixtures[0]!.cleanup();
    fixtures.shift();
  }
});

async function fixture(
  scope: 'repository' | 'activation' = 'repository',
  recipe?: SourceCheckRecipe,
  directory: SourceCheckDirectory = 'backend',
  familyDepth: 'recursive' | 'single' | 'all' | 'unfiltered' = 'recursive'
) {
  const phaseId: PhaseId = scope === 'repository' ? 'repository-rulesets-applied' : 'rulesets-applied';
  const mainSha = 'b'.repeat(40);
  const sourceSha = 'a'.repeat(40);
  const requests: GitHubRequest[] = [];
  const f = await isolatedControlProject(phaseId, {
    settings: { default_branch: 'develop', allow_merge_commit: true },
    mainHold: scope === 'repository' ? 'hold' : 'qualified'
  }, { async run() { throw new Error('This isolated fixture cannot execute processes or contact a live provider.'); } });
  fixtures.push(f);
  f.inspection.scope = scope;
  delete f.inspection.activationInputs!.azure;
  const definitions = buildCanonicalGitFlowRulesets({ requiredChecks: ['verify-source'], actionsAppId: 15368 });
  const sourceFiles = new Map<string, string>(definitions.map((definition) =>
    [`.github/rulesets/${definition.name}.json`, JSON.stringify(definition, null, 2)]));
  const validationSources = new Map<string, string>();
  const fixtureSources = new Map<string, Map<string, string>>();
  let boundFixtures: BoundRepositoryCheckFixture[] = [];
  const families: readonly ProtectedRefFamily[] = familyDepth === 'all' ? protectedRefFamilies :
    familyDepth === 'single' ? ['develop', 'main', 'release/*', 'hotfix/*'] :
      ['develop', 'main', 'release/**', 'hotfix/**'];
  const validator = recipe === 'vitest.v1' ? 'npm test' : recipe === 'pytest.v1'
    ? 'uv run --frozen pytest -q' : recipe === 'go-test.v1' ? 'go test ./...' : 'node --test';
  if (recipe === 'vitest.v1') validationSources.set(directory === '.' ? 'package.json' : `${directory}/package.json`,
    JSON.stringify({ name: 'isolated-validation', private: true, scripts: { test: 'vitest run' } }));
  sourceFiles.set('.github/workflows/verify.yml', [
    'name: Verify', 'on:',
    ...(familyDepth === 'unfiltered' ? ['  pull_request: {}'] : ['  pull_request:', `    branches: [${families.join(', ')}]`]),
    'permissions:', '  contents: read', 'jobs:', '  verify:', '    name: verify-source',
    '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '    steps:', '      - name: Checkout',
    `        uses: actions/checkout@${'d'.repeat(40)}`, '      - name: Source validation',
    ...(recipe && directory !== '.' ? [`        working-directory: ${directory}`] : []),
    `        run: ${validator}`, ''
  ].join('\n'));
  for (const [name, content] of [...sourceFiles, ...validationSources]) {
    const file = path.join(f.projectRoot, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await f.refreshInputs();
  const workflowDigest = canonicalSha256(sourceFiles.get('.github/workflows/verify.yml')!);
  const requirements = families.map((refFamily) => ({
    context: 'verify-source', appId: 15368, refFamily, workflowPath: '.github/workflows/verify.yml',
    workflowId: 19, workflowDigest, jobName: 'verify-source'
  }));
  const requiredChecks = [{
    workflowPath: '.github/workflows/verify.yml', workflowId: 19, workflowDigest,
    workflowBlobSha: githubSourceFixture('.github/workflows/verify.yml', sourceFiles.get('.github/workflows/verify.yml')!).sha,
    producerSourceSha: sourceSha, jobId: 'verify', context: 'verify-source', validationStep: 'Source validation',
    refFamilies: families
  }];
  const positiveChecks = requirements.map((entry, index) => ({
    ...entry, actorId: 7, runId: 100 + index, runAttempt: 1, jobId: 200 + index, checkRunId: 300 + index,
    headSha: canonicalSha256(['positive', index]).slice(0, 40), conclusion: 'success' as const,
    producerSourceSha: sourceSha, jobKey: 'verify', repositoryId: 42, appSlug: 'github-actions',
    fixtureRef: `liftoff/qualification/positive-${index}`, pullRequestNumber: 700 + index,
    validationStep: { number: 2, name: 'Source validation', conclusion: 'success' as const }, verifiedAt: f.now.toISOString()
  }));
  const controlledNegativeChecks = requirements.map((entry, index) => ({
    ...entry, actorId: 7, runId: 400 + index, runAttempt: 1, jobId: 500 + index, checkRunId: 600 + index,
    headSha: canonicalSha256(['negative', index]).slice(0, 40), conclusion: 'failure' as const, deliberateFailure: true,
    producerSourceSha: sourceSha, jobKey: 'verify', repositoryId: 42, appSlug: 'github-actions',
    fixtureRef: `liftoff/qualification/negative-${index}`, pullRequestNumber: 800 + index,
    validationStep: { number: 2, name: 'Source validation', conclusion: 'failure' as const }, verifiedAt: f.now.toISOString()
  }));
  const files = [...sourceFiles].map(([name, content]) => ({
    path: name, digest: canonicalSha256(content), readbackDigest: canonicalSha256(content),
    blobSha: githubSourceFixture(name, content).sha
  })).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const sourcePayload = {
    repository: 'owner/repo', repositoryId: 42, actorId: 7, actorLogin: 'source-publisher', ref: 'develop', sourceSha, files,
    workflows: files.filter((file) => file.path.startsWith('.github/workflows/')).map((file) => ({
      path: file.path, workflowId: 19, digest: file.digest, blobSha: file.blobSha, sourceSha
    })),
    rulesetSourceDigest: canonicalSha256(files.filter((file) => file.path.startsWith('.github/rulesets/')).map(({ path, digest }) => ({ path, digest })))
  };
  function addEvidence(id: PhaseId, payload: Record<string, unknown>) {
    const context = f.inspection.contexts[id];
    const liveReadback = (context.liveReadbackProviders ?? ['github']).map((provider) => ({
      schemaVersion: 4 as const, repositoryId: context.repositoryId, identity: currentActivationIdentity,
      phaseGraphHash: canonicalPhaseGraphHash, phaseId: id, baselineSha: context.baselineSha,
      inputDigest: context.inputDigest, transition: context.transition, observedAt: f.now.toISOString(),
      provider, resourceType: 'isolated-provider-fixture', resourceId: provider === 'github'
        ? `/repos/owner/repo/fixture/${id}` : '/subscriptions/11111111-2222-4333-8444-555555555555',
      sourceDigest: canonicalSha256(payload), readbackDigest: canonicalSha256(payload), matches: true as const
    }));
    const body = { kind: `${id}.v1`, ...payload };
    const record: PhaseEvidenceRecord = {
      evidenceId: `${id}-${randomUUID()}`, payload: body, liveReadback,
      header: {
        schemaVersion: 4, repositoryId: context.repositoryId, identity: currentActivationIdentity,
        phaseGraphHash: canonicalPhaseGraphHash, phaseId: id, phaseContractDigest: context.phaseContractDigest,
        baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
        producedAt: f.now.toISOString(), producer: 'isolated-enforcement-proof-fixture', result: 'verified', scope,
        bodyDigest: evidenceBodyDigest(body, liveReadback), remoteBindingDigest: context.remoteBindingDigest
      }
    };
    f.inspection.evidence = [...f.inspection.evidence.filter((entry) => entry.header.phaseId !== id), record];
    f.inspection.state.phases[id] = {
      state: 'verified', updatedAt: f.now.toISOString(), blockers: [], approvals: [],
      evidence: [{ evidenceId: record.evidenceId, phaseId: id, headerDigest: canonicalSha256(record.header), result: 'verified' }]
    };
    context.evidenceReferences = f.inspection.state.phases[id].evidence;
    const validation = validateEvidenceFreshness(record, context);
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
    return record;
  }
  const artifactDigest = `sha256:${'c'.repeat(64)}`;
  const sourceRecord = addEvidence(scope === 'repository' ? 'repository-workflow-source-ready' : 'workflow-source-ready', sourcePayload);
  let checks = addEvidence(scope === 'repository' ? 'repository-checks-qualified' : 'green-red-proof', {
    repository: 'owner/repo', repositoryId: 42, actorId: 7, sourceSha, artifactDigest, qualifiedAt: f.now.toISOString(),
    requiredChecks, positiveChecks, controlledNegativeChecks
  });
  if (scope === 'activation') {
    addEvidence('staging-qualified', { sourceSha, artifactDigest });
    addEvidence('production-rehearsed', { sourceSha, artifactDigest });
  }
  const repository: Record<string, unknown> = {
    id: 42, node_id: 'R_fixture42', name: 'repo', full_name: 'owner/repo', owner: { id: 9, login: 'owner', type: 'Organization' },
    archived: false, disabled: false, default_branch: 'develop', allow_merge_commit: true,
    allow_squash_merge: true, allow_rebase_merge: true, allow_auto_merge: false,
    delete_branch_on_merge: false, permissions: { admin: true, push: true, pull: true },
    security_and_analysis: { secret_scanning: { status: 'enabled' } },
    another_owner_setting: { retained: 'unchanged' }
  };
  const actor = { id: 7, login: 'reviewed-owner', type: 'User' };
  const qualificationActor = { id: 7 };
  const refShas = { main: mainSha, develop: sourceSha };
  const foreign = {
    id: 900, node_id: 'RS_foreign900', name: 'owner-custom-tags', target: 'tag', enforcement: 'active',
    source_type: 'Repository', source: 'owner/repo',
    conditions: { ref_name: { include: ['refs/tags/internal-*'], exclude: [] } },
    bypass_actors: [], rules: [{ type: 'deletion' }]
  };
  const rulesets = new Map<number, Record<string, unknown>>([[900, foreign]]);
  let responseId = 0;
  let providerId = 1000;
  let approved: PhaseAdapterExecutionInput | undefined;
  let loseResponse: string | undefined;
  let rejected: string | undefined;
  let failReadback: string | undefined;
  let malformedResponse: string | undefined;
  let failNextRead = false;
  let beforePost: (() => Promise<void> | void) | undefined;
  let beforeRead: ((request: GitHubRequest) => Promise<void> | void) | undefined;
  let responseTransform: ((name: string, value: Record<string, unknown>) => Record<string, unknown>) | undefined;
  let checkConclusion: string | undefined;
  let setupConclusion = 'success';
  let checkOutput: Record<string, unknown> | undefined;
  let checkAppId = 15368;
  let jobIdOffset = 0;
  let prState = 'open';
  let prMerged = false;
  const transport: GitHubActivationTransport = {
    async request(request) {
      requests.push(structuredClone(request));
      const respond = (data: unknown, status = 200) => ({
        status, data: structuredClone(data),
        headers: { etag: `"${canonicalSha256(data)}"`, 'x-github-request-id': `PROVIDER:${++responseId}` }
      });
      if (request.method !== 'GET') {
        expect(['POST', 'PUT', 'PATCH']).toContain(request.method);
        expect(request).not.toHaveProperty('headers');
        expect(approved).toBeDefined();
        const body = request.body as Record<string, unknown>;
        const name = request.method === 'PATCH' ? 'repository-settings' : String(body.name);
        const checkpoint = await readRepositoryControlCheckpoint(approved!, 42, name);
        expect(checkpoint?.prepared.approvalEnvelopeId).toBe(approved!.plan.approval.envelopeId);
        expect(checkpoint?.response).toBeNull();
        await beforePost?.();
        if (name === rejected) return respond({ message: 'fixture rejection' }, 403);
        let result: Record<string, unknown>;
        if (request.method === 'PATCH') {
          expect(request.path).toBe('/repos/owner/repo');
          Object.assign(repository, structuredClone(body));
          result = repository;
        } else {
          const id = request.method === 'POST' ? providerId++ : Number(request.path.split('/').at(-1));
          if (request.method === 'POST') expect(request.path).toBe('/repos/owner/repo/rulesets');
          else expect(rulesets.has(id)).toBe(true);
          const previous = rulesets.get(id);
          result = {
            ...structuredClone(body), id, node_id: previous?.node_id ?? `RS_provider${id}`,
            source_type: 'Repository', source: 'owner/repo', current_user_can_bypass: 'never',
            created_at: previous?.created_at ?? f.now.toISOString(), updated_at: f.now.toISOString()
          };
          rulesets.set(id, result);
        }
        if (name === loseResponse) throw new GitHubActivationError('bounded-request', 'Isolated fixture lost the provider response.');
        if (name === failReadback) failNextRead = true;
        const returned = responseTransform?.(name, structuredClone(result)) ?? result;
        return respond(name === malformedResponse ? { ...returned, unsupported_enforcement: true } : returned, request.method === 'POST' ? 201 : 200);
      }
      await beforeRead?.(request);
      if (failNextRead && request.path === '/repos/owner/repo') {
        failNextRead = false;
        return respond({ message: 'fixture readback unavailable' }, 503);
      }
      if (request.path === '/user') return respond(actor);
      if (request.path === '/apps/github-actions') return respond({ id: 15368, slug: 'github-actions', owner: { id: 991 } });
      if (request.path === '/repos/owner/repo') return respond(repository);
      if (request.path.startsWith('/repos/owner/repo/git/ref/heads/')) {
        const branch = request.path.split('/').at(-1)! as keyof typeof refShas;
        return respond({ ref: `refs/heads/${branch}`, node_id: `REF_${branch}`, object: { type: 'commit', sha: refShas[branch] } });
      }
      if (request.path.startsWith('/repos/owner/repo/contents/')) {
        const sourcePath = request.path.slice('/repos/owner/repo/contents/'.length).split('?')[0]!;
        const ref = request.path.split('?ref=')[1]!;
        const fixtureContent = fixtureSources.get(ref)?.get(sourcePath);
        if (fixtureContent !== undefined) return respond(githubSourceFixture(sourcePath, fixtureContent));
        if (validationSources.has(sourcePath)) return respond(githubSourceFixture(sourcePath, validationSources.get(sourcePath)!));
        if (sourcePath === 'test/liftoff-repository-check.test.mjs') {
          const sha = request.path.split('?ref=')[1];
          const negative = controlledNegativeChecks.some((check) => check.headSha === sha);
          return respond(githubSourceFixture(sourcePath, controlledNodeTestFixture(negative ? 'negative' : 'positive').content));
        }
        const content = sourceFiles.get(sourcePath);
        return content === undefined ? respond({ message: 'fixture missing source' }, 404) : respond(githubSourceFixture(sourcePath, content));
      }
      const proofs = [...positiveChecks, ...controlledNegativeChecks];
      const prId = /\/pulls\/(\d+)$/u.exec(request.path);
      const runId = /\/actions\/runs\/(\d+)(?:\/attempts\/1(?:\/jobs(?:\?.*)?)?)?$/u.exec(request.path);
      const checkId = /\/check-runs\/(\d+)$/u.exec(request.path);
      const logId = /\/actions\/jobs\/(\d+)\/logs$/u.exec(request.path);
      if (logId && request.text && controlledNegativeChecks.some((proof) => proof.jobId === Number(logId[1]))) {
        const file = sourceCheckFixtureArtifact('verify', recipe ?? 'node-test.v1', recipe ? directory : '.');
        const response = respond(sourceCheckFailureLog(file.path));
        return { ...response, headers: { ...response.headers, 'content-type': 'text/plain' } };
      }
      const proof = proofs.find((entry) => prId ? entry.pullRequestNumber === Number(prId[1]) :
        runId ? entry.runId === Number(runId[1]) : checkId ? entry.checkRunId === Number(checkId[1]) : false);
      if (proof) {
        const fixturePlan = boundFixtures.find((entry) => entry.publication.commitSha === proof.headSha)?.publication;
        const baseRef = fixturePlan?.targetBranch ?? proof.refFamily.replace('/**', '/maintenance/1.2.3').replace('/*', '/1.2.3');
        const baseSha = fixturePlan?.baseSha ?? (baseRef === 'main' ? refShas.main : refShas.develop);
        const conclusion = checkConclusion ?? proof.conclusion;
        if (prId) return respond({
          number: proof.pullRequestNumber, state: prState, merged: prMerged, draft: true, user: { id: qualificationActor.id },
          head: { ref: proof.fixtureRef, sha: proof.headSha, repo: { id: 42, full_name: 'owner/repo' } },
          base: { ref: baseRef, sha: baseSha, repo: { id: 42, full_name: 'owner/repo' } }
        });
        if (checkId) return respond({
          id: proof.checkRunId, name: proof.context, head_sha: proof.headSha, status: 'completed', conclusion,
          check_suite: { id: proof.runId + 5000 }, app: { id: checkAppId, slug: 'github-actions' }, ...(checkOutput ? { output: checkOutput } : {})
        });
        if (request.path.includes('/jobs')) return respond({
          total_count: 1, jobs: [{
            id: proof.jobId + jobIdOffset, name: proof.context, run_id: proof.runId, head_sha: proof.headSha,
            status: 'completed', conclusion, check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${proof.checkRunId}`,
            steps: [
              { number: 1, name: 'Checkout', status: 'completed', conclusion: setupConclusion },
              { ...proof.validationStep, status: 'completed', conclusion }
            ]
          }]
        });
        return respond({
          id: proof.runId, run_attempt: 1, workflow_id: 19, path: proof.workflowPath,
          head_sha: proof.headSha, head_branch: proof.fixtureRef, event: 'pull_request',
          repository: { id: 42, full_name: 'owner/repo' }, actor: { id: qualificationActor.id }, triggering_actor: { id: qualificationActor.id },
          status: 'completed', conclusion, check_suite_id: proof.runId + 5000,
          created_at: proof.verifiedAt, updated_at: proof.verifiedAt,
          pull_requests: [{ number: proof.pullRequestNumber, head: { sha: proof.headSha }, base: { sha: baseSha } }]
        });
      }
      if (request.path.startsWith('/repos/owner/repo/rulesets?')) return respond([...rulesets.values()]);
      const id = /\/rulesets\/(\d+)$/u.exec(request.path);
      if (id) return rulesets.has(Number(id[1])) ? respond(rulesets.get(Number(id[1]))) : respond({ message: 'fixture missing rule' }, 404);
      throw new Error(`Unexpected isolated read: ${request.path}`);
    }
  };
  const adapters = { githubActivation: { transport, storage: f.storage } };
  const planning = (id: PhaseId = phaseId): PhasePlanningInput => ({
    inspection: f.inspection, phase: canonicalPhaseGraph.phases.find((phase) => phase.id === id)!,
    runner: f.runner, now: f.now, adapters
  });
  async function issue(operations: readonly TransitionOperation[], id: PhaseId = phaseId, options: { issued?: boolean; recovery?: boolean } = {}) {
    const input = planning(id);
    const context = f.inspection.contexts[id];
    const details = {
      operations, configuration: f.inspection.activationInputs, selectionScope: scope,
      ...(options.recovery ? { recovery: true } : {})
    };
    const request = transitionPlanForPhase(input.phase, f.inspection.state, context.transition, undefined, undefined, details);
    const expiresAt = new Date(f.now.getTime() + 600_000).toISOString();
    const envelope = input.phase.approvalGate.required ? validateApprovalEnvelope({
      ...request, schemaVersion: 4, id: randomUUID(), approvedAt: f.now.toISOString(), expiresAt,
      approver: 'isolated-explicit-control-review'
    }, { now: f.now, requireUnexpired: true }) : null;
    const evaluation = evaluateApprovalForTransitionPlan(request, envelope ? [envelope] : [], { now: f.now });
    const plan = validateSavedTransitionPlan({
      schemaVersion: 2, scope, selectionScope: scope, phaseId: id, identity: currentActivationIdentity, graphHash: canonicalPhaseGraphHash,
      createdAt: f.now.toISOString(), expiresAt, stateHash: canonicalSha256(f.inspection.state),
      baselineDigest: context.baselineSha, inputDigest: context.inputDigest, transitionDigest: context.transition.transitionDigest,
      planDigest: planDigestFor({ phase: input.phase, transitionDigest: context.transition.transitionDigest, operations, approvalPlanDigest: request.planDigest }),
      mutationClasses: input.phase.allowedMutations, operations, configuration: f.inspection.activationInputs,
      ...(options.recovery ? { recovery: true } : {}),
      approval: {
        gateKind: input.phase.approvalGate.kind, required: input.phase.approvalGate.required, evaluation,
        envelopeId: evaluation.envelopeId, envelopeHash: evaluation.envelopeHash
      },
      rollbackPlan: rollbackPlanForPhase(input.phase), noSecrets: true
    });
    if (envelope) {
      f.inspection.approvals = [...f.inspection.approvals, envelope];
      if (options.issued !== false) await writeGovernanceApprovalAuthority(f.projectRoot, canonicalSha256(plan), envelope, f.storage);
    }
    approved = { ...input, plan, adapters, ...(options.recovery ? { recovery: true } : {}) };
    return approved;
  }
  async function approve(options: { issued?: boolean; recovery?: boolean } = {}) {
    await f.refreshInputs();
    const planned = await planRepositoryRulesets(planning());
    expect(planned.blockers ?? []).toEqual([]);
    return issue(planned.operations, phaseId, options);
  }
  async function approvePublicPlan() {
    await f.refreshInputs();
    const context = bindGovernanceTransitionContext({ storage: f.storage, adapters });
    const before = requests.filter((request) => request.method !== 'GET').length;
    const preview = await saveGovernancePreview(f.inspection, { runner: f.runner, now: f.now, ...context });
    if (!preview) throw new Error('The default public planner did not produce an enforcement preview.');
    const consent = await approveGovernancePreview({
      projectRoot: f.projectRoot, fingerprint: preview.preview.fingerprint,
      inspect: async () => f.inspection, runner: f.runner, now: f.now, ...context
    });
    f.inspection.approvals = [...f.inspection.approvals, consent.envelope];
    expect(requests.filter((request) => request.method !== 'GET')).toHaveLength(before);
    approved = { ...planning(), plan: consent.plan, adapters: context.adapters };
    return approved;
  }
  const execute = (input: PhaseAdapterExecutionInput) => withProjectMutationLock(f.projectRoot, (lease) =>
    executeRepositoryRulesets({ ...input, lease }));
  async function persist(input: PhaseAdapterExecutionInput, outcome: PhaseAdapterOutcome) {
    expect(outcome.status, outcome.blocker).toBe('completed');
    const payload = {
      ...(outcome.evidencePayload as Record<string, unknown>), ...(outcome.outputs ? { outputBindings: outcome.outputs } : {}),
      planDigest: input.plan.planDigest, savedPlanDigest: canonicalSha256(input.plan)
    };
    const header = evidenceHeaderFor({
      inspection: f.inspection, phase: input.phase, plan: input.plan, now: f.now,
      result: 'verified', payload, liveReadback: outcome.liveReadback
    });
    const record: PhaseEvidenceRecord = { evidenceId: `control-result-${randomUUID()}`, header, payload, liveReadback: outcome.liveReadback };
    const next = nextStateForOutcome({
      inspection: f.inspection, phase: input.phase, plan: input.plan, resultState: 'verified', now: f.now,
      outputs: outcome.outputs,
      evidenceReference: { phaseId: input.phase.id, evidenceId: record.evidenceId, headerDigest: canonicalSha256(header), result: 'verified' }
    });
    await writeOutcomeTransaction({
      projectRoot: f.projectRoot, plan: input.plan, nextState: next, evidenceRecord: record,
      evidencePathParts: ['governance', 'evidence', `${record.evidenceId}.json`],
      expectedStateHash: f.inspection.loadedState!.contentHash
    });
    f.inspection.state = next;
    f.inspection.loadedState = await loadActivationState(f.projectRoot);
    f.inspection.evidence = [...f.inspection.evidence, record];
    const context = f.inspection.contexts[input.phase.id];
    context.evidenceReferences = next.phases[input.phase.id].evidence;
    context.reviewedPlans = [input.plan];
    const validated = validateEvidenceFreshness(record, context);
    expect(validated.valid, JSON.stringify(validated)).toBe(true);
    f.now.setTime(f.now.getTime() + 1000);
    return record;
  }
  async function persistBlocked(input: PhaseAdapterExecutionInput, outcome: PhaseAdapterOutcome) {
    expect(outcome.status).toBe('blocked');
    const next = blockedState({
      inspection: f.inspection, phase: input.phase, plan: input.plan, now: f.now,
      blocker: outcome.blocker!, executionStarted: true, operation: outcome.operation
    });
    await writeOutcomeTransaction({
      projectRoot: f.projectRoot, plan: input.plan, nextState: next,
      expectedStateHash: f.inspection.loadedState!.contentHash
    });
    f.inspection.state = next;
    f.inspection.loadedState = await loadActivationState(f.projectRoot);
    f.inspection.recoverPhase = phaseId;
    f.inspection.contexts[phaseId].reviewedPlans = [input.plan];
    f.now.setTime(f.now.getTime() + 1000);
  }
  const control = (name: string) => {
    const value = [...rulesets.values()].find((entry) => entry.name === name);
    if (!value) throw new Error(`Missing isolated control ${name}.`);
    return value;
  };
  const reviewParameters = (name: string): Record<string, unknown> => {
    const rule = (control(name).rules as Array<Record<string, unknown>>).find((entry) => entry.type === 'pull_request');
    if (!rule || !rule.parameters) throw new Error('The isolated control has no pull-request rule.');
    return rule.parameters as Record<string, unknown>;
  };
  let originalCheckPlan: PhaseAdapterExecutionInput | undefined;
  let currentChecks: readonly RequiredWorkflowCheck[] = [];
  if (recipe) {
    const client = new GitHubActivationClient(transport);
    currentChecks = await deriveRequiredSourceChecks(client, 'owner/repo',
      await readbackWorkflowContent(client, 'owner/repo', '.github/workflows/verify.yml', sourceSha), 19);
    const baseTree = treeWithFiles([], [...sourceFiles, ...validationSources].map(([path, content]) => ({
      path, blobSha: githubSourceFixture(path, content).sha
    })));
    const publications: WorkflowPublicationPlan[] = [];
    const fixtureBindings: Array<{ featureBranch: string; polarity: 'positive' | 'negative'; refFamily: typeof requirements[number]['refFamily'] }> = [];
    for (const [index, requirement] of requirements.entries()) for (const polarity of ['positive', 'negative'] as const) {
      const proof = (polarity === 'positive' ? positiveChecks : controlledNegativeChecks)[index]!;
      const files = controlledSourceCheckFixtures(currentChecks, polarity).map((file) => ({
        ...file, blobSha: githubSourceFixture(file.path, file.content).sha, beforeBlobSha: null
      }));
      const targetBranch = requirement.refFamily.endsWith('/**')
        ? requirement.refFamily.replace('/**', '/maintenance/1.2.3') : requirement.refFamily.replace('/*', '/1.2.3');
      const baseSha = targetBranch === 'main' ? mainSha : sourceSha;
      const treeSha = treeWithFiles(baseTree.entries, files).sha;
      const commitMessage = `Qualify ${recipe} ${index} ${polarity}`;
      const commitTime = f.now.toISOString();
      const actorLogin = 'qualification-owner';
      const featureBranch = `feature/qualification/${recipe}/${index}/${polarity}`;
      const publication: WorkflowPublicationPlan = {
        schemaVersion: 1, recipe: 'gitflow-source-check-fixture.v1', repository: 'owner/repo', repositoryId: 42,
        actorId: qualificationActor.id, actorLogin, targetBranch, featureBranch, baseSha, mainSha,
        baseTreeSha: baseTree.sha, treeSha,
        commitSha: workflowCommitSha({ treeSha, parentSha: baseSha, message: commitMessage, actorLogin,
          actorId: qualificationActor.id, commitTime }).sha,
        commitTime, commitMessage, controlsDigest: canonicalSha256(foreign), requiredChecks: [], files
      };
      proof.headSha = publication.commitSha;
      proof.fixtureRef = featureBranch;
      publications.push(publication);
      fixtureBindings.push({ featureBranch, polarity, refFamily: requirement.refFamily });
      fixtureSources.set(publication.commitSha, new Map(files.map((file) => [file.path, file.content])));
      boundFixtures.push({ publication, polarity, refFamily: requirement.refFamily, pullRequestNumber: proof.pullRequestNumber, runs: [] });
    }
    f.inspection.activationInputs!.phases['repository-checks-qualified'] = {
      sourceSha, repositoryId: 42, actorId: qualificationActor.id, workflowPaths: ['.github/workflows/verify.yml'],
      fixtures: requirements.map((entry, index) => ({
        refFamily: entry.refFamily, targetBranch: publications[index * 2]!.targetBranch,
        baseSha: publications[index * 2]!.baseSha,
        positiveBranch: publications[index * 2]!.featureBranch, negativeBranch: publications[index * 2 + 1]!.featureBranch,
        commitTime: f.now.toISOString()
      }))
    };
    await f.refreshInputs();
    const destination = { type: 'repository' as const, identity: 'owner/repo', repository: 'owner/repo' };
    const operation: TransitionOperation = {
      phaseId: 'repository-checks-qualified', adapter: 'github', actionId: 'github.checks.repository-qualified',
      mutationClass: 'github-workflow-dispatch', remote: true, destructive: false, destination,
      inputs: { repository: 'owner/repo', repositoryId: 42, actorId: qualificationActor.id, sourceSha,
        requiredChecks: currentChecks, fixtures: publications, fixtureBindings },
      effects: ['github-read', 'github-write', 'git-push'].map((mutationClass) => ({
        mutationClass: mutationClass as 'github-read' | 'github-write' | 'git-push', destination, remote: true, destructive: false
      }))
    };
    originalCheckPlan = await issue([operation], 'repository-checks-qualified');
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      const execution = { ...originalCheckPlan!, lease };
      for (const fixture of boundFixtures) {
        const publication = fixture.publication;
        const prIdentity = { repositoryId: 42, ref: publication.featureBranch, purpose: 'check-fixture' as const, step: 'pull-request' as const };
        const prRequest = { method: 'POST', path: '/repos/owner/repo/pulls', body: {
          head: publication.featureBranch, base: publication.targetBranch, title: publication.commitMessage,
          body: `Reviewed Liftoff ${publication.recipe}\n\nSource: ${publication.baseSha}\nPayload: ${canonicalSha256(publication)}\n\nNo bypass, protected-ref push, release or tag is authorized.`,
          maintainer_can_modify: false, draft: true
        } };
        const preparedPr = await prepareWorkflowEffect(execution, operation, prIdentity, prRequest);
        const pr = await client.get(`/repos/owner/repo/pulls/${fixture.pullRequestNumber}`);
        await recordWorkflowProviderResult(execution, operation, prIdentity, preparedPr, 'observed', {
          status: 200, requestId: null, providerId: String(pr.number), resourceId: `/repos/owner/repo/pulls/${pr.number}`
        });
        const check = currentChecks[0]!;
        const binding = {
          repository: 'owner/repo', repositoryId: 42, workflowPath: check.workflowPath, workflowId: check.workflowId,
          workflowDigest: check.workflowDigest, sourceSha: publication.commitSha, producerSourceSha: sourceSha,
          ref: publication.featureBranch, actorId: qualificationActor.id, event: 'pull_request' as const,
          expectedJobs: currentChecks.map((entry) => entry.context), runAttempt: 1
        };
        const identity = { repositoryId: 42, ref: `${binding.ref}:${binding.workflowId}`, purpose: 'check-fixture' as const, step: 'dispatch' as const };
        const prepared = await prepareWorkflowEffect(execution, operation, identity, { binding, fixtureDigest: canonicalSha256(publication) });
        const proof = [...positiveChecks, ...controlledNegativeChecks].find((entry) => entry.headSha === publication.commitSha)!;
        const run = await client.get(`/repos/owner/repo/actions/runs/${proof.runId}/attempts/1`);
        await recordWorkflowProviderResult(execution, operation, identity, prepared, 'observed', {
          status: 200, requestId: null, providerId: String(run.id), resourceId: `/repos/owner/repo/actions/runs/${run.id}`
        });
        fixture.runs = [{ binding, operation: {
          provider: 'github', actionId: operation.actionId, operationId: String(run.id),
          resourceId: `/repos/owner/repo/actions/runs/${run.id}`, startedAt: prepared.preparedAt,
          observedAt: f.now.toISOString(), status: fixture.polarity === 'positive' ? 'completed' : 'failed',
          planDigest: execution.plan.planDigest
        } }];
      }
    });
    const qualification = await qualifyRepositorySourceChecks({
      client, repository: 'owner/repo', requiredChecks: currentChecks, fixtures: boundFixtures, now: f.now
    });
    const payload: RepositoryChecksEvidencePayload = { kind: 'repository-checks-qualified.v1', ...qualification, boundFixtures };
    checks = await persist(originalCheckPlan, {
      status: 'completed', resultState: 'verified', evidencePayload: payload,
      liveReadback: [readbackProof(originalCheckPlan, 'github', 'check-run', `/repos/owner/repo/commits/${sourceSha}/check-runs`, qualification)],
      completedOperations: [operation]
    });
  }
  return {
    ...f, scope, phaseId, definitions, sourceFiles, sourceRecord, checks, requirements, controlledNegativeChecks,
    repository, actor, qualificationActor, refShas, rulesets, foreign, requests, planning, issue, approve, approvePublicPlan, execute, persist, persistBlocked,
    transport, adapters, addEvidence, control, reviewParameters, boundFixtures, originalCheckPlan, currentChecks,
    setFixtureSource: (commit: string, file: string, content: string) => {
      const sources = fixtureSources.get(commit);
      if (!sources) throw new Error('Unknown exact fixture commit.');
      sources.set(file, content);
    },
    rewriteQualification: (change: (payload: Record<string, unknown>) => void) => {
      change(checks.payload as Record<string, unknown>);
      checks.header.bodyDigest = evidenceBodyDigest(checks.payload, checks.liveReadback);
      const phase = checks.header.phaseId;
      const references = f.inspection.state.phases[phase].evidence.map((reference) =>
        reference.evidenceId === checks.evidenceId ? { ...reference, headerDigest: canonicalSha256(checks.header) } : reference);
      f.inspection.state.phases[phase].evidence = references;
      f.inspection.contexts[phase].evidenceReferences = references;
    },
    checkFault: (fault?: 'infrastructure' | 'setup' | 'skipped' | 'closed' | 'merged' | 'app' | 'job') => {
      checkOutput = fault === 'infrastructure' ? { summary: 'Runner lost communication with GitHub' } : undefined;
      setupConclusion = fault === 'setup' ? 'failure' : 'success';
      checkConclusion = fault === 'skipped' ? 'skipped' : undefined;
      prState = fault === 'closed' ? 'closed' : 'open'; prMerged = fault === 'merged';
      checkAppId = fault === 'app' ? 15369 : 15368; jobIdOffset = fault === 'job' ? 1 : 0;
    },
    writes: () => requests.filter((request) => request.method !== 'GET'),
    lose: (name?: string) => { loseResponse = name; },
    reject: (name?: string) => { rejected = name; },
    failReadback: (name?: string) => { failReadback = name; },
    malformedResponse: (name?: string) => { malformedResponse = name; },
    beforePost: (hook: () => Promise<void> | void) => { beforePost = hook; },
    beforeRead: (hook?: (request: GitHubRequest) => Promise<void> | void) => { beforeRead = hook; },
    response: (hook?: (name: string, value: Record<string, unknown>) => Record<string, unknown>) => { responseTransform = hook; }
  };
}

describe('owned repository enforcement with released private approval and checkpoints', () => {
  it('preserves its exact fixture while owning test work has not settled', async () => {
    const f = await fixture();
    await expect(f.cleanup()).rejects.toThrow(/owning test work is unsettled/u);
    expect((await lstat(f.root)).isDirectory()).toBe(true);
  });

  it('refuses changed fixture creation identities without deleting any path', async () => {
    const f = await fixture();
    const current = await fixtureDirectoryIdentity(f.root);
    expect(() => assertFixtureDirectoryIdentity(f.creationIdentity, { ...current, inode: current.inode + 1n }))
      .toThrow(/creation identity changed/u);
    expect((await lstat(f.root)).isDirectory()).toBe(true);
  });

  it('hashes explicit fixture configuration edits rather than the prior validated state copy', async () => {
    const f = await fixture();
    const previous = f.inspection.contexts[f.phaseId].inputDigest;
    f.inspection.activationInputs!.phases[f.phaseId] = {
      ...f.inspection.activationInputs!.phases[f.phaseId],
      settings: { default_branch: 'develop', allow_merge_commit: true, allow_auto_merge: true }
    };
    await f.refreshInputs();
    expect(f.inspection.state.activationInputs).toEqual(f.inspection.activationInputs);
    expect(f.inspection.contexts[f.phaseId].inputDigest).not.toBe(previous);
    expect(f.writes()).toEqual([]);
  });

  it.each(['node-test.v1', 'vitest.v1', 'pytest.v1', 'go-test.v1'] as const)(
    'consumes original approved %s fixtures through the shared read-only qualifier', async (recipe) => {
      const directory = recipe === 'go-test.v1' ? '.' : 'backend';
      const f = await fixture('repository', recipe, directory);
      const original = canonicalJson(f.checks);
      const planned = await planRepositoryRulesets(f.planning());
      expect(planned.blockers).toEqual([]);
      expect(planned.operations).toHaveLength(6);
      expect(f.currentChecks[0]).toMatchObject({ recipe, workingDirectory: directory });
      expect(f.boundFixtures.map((entry) => entry.publication.targetBranch)).toContain('release/maintenance/1.2.3');
      expect(f.boundFixtures.map((entry) => entry.publication.targetBranch)).toContain('hotfix/maintenance/1.2.3');
      const green = f.boundFixtures.find((entry) => entry.polarity === 'positive')!.publication.files[0]!;
      const red = f.boundFixtures.find((entry) => entry.polarity === 'negative')!.publication.files[0]!;
      const assertions = {
        'node-test.v1': ["assert.equal('valid', 'valid')", "assert.equal('controlled-invalid', 'valid')"],
        'vitest.v1': ["expect('valid').toBe('valid')", "expect('controlled-invalid').toBe('valid')"],
        'pytest.v1': ["assert 'valid' == 'valid'", "assert 'controlled-invalid' == 'valid'"],
        'go-test.v1': ['if "valid" != "valid"', 'if "controlled-invalid" != "valid"']
      };
      expect(green.path).toBe(red.path);
      expect(green.content).toContain(assertions[recipe][0]);
      expect(red.content).toContain(assertions[recipe][1]);
      expect(green.blobSha).not.toBe(red.blobSha);
      expect(canonicalJson(f.checks)).toBe(original);
      expect(f.writes()).toEqual([]);
    }
  );

  it.each(['legacy', 'node-test.v1', 'vitest.v1', 'pytest.v1', 'go-test.v1'] as const)(
    'preserves actual unfiltered recursive defaults for %s receipts', async (lane) => {
      const f = await fixture('repository', lane === 'legacy' ? undefined : lane, 'backend', 'unfiltered');
      const original = canonicalJson(f.checks);
      const client = new GitHubActivationClient(f.transport);
      const source = await readbackWorkflowContent(client, 'owner/repo', '.github/workflows/verify.yml', f.refShas.develop);
      const derived = await deriveRequiredSourceChecks(client, 'owner/repo', source, 19);
      expect(source.content).toContain('pull_request: {}');
      expect(derived[0]?.refFamilies).toEqual(['develop', 'main', 'release/**', 'hotfix/**']);
      const planned = await planRepositoryRulesets(f.planning());
      expect(planned.blockers).toEqual([]);
      expect(planned.operations).toHaveLength(6);
      expect(canonicalJson(f.checks)).toBe(original);
      expect(f.writes()).toEqual([]);
    }
  );

  it.each(['legacy', 'node-test.v1', 'vitest.v1', 'pytest.v1', 'go-test.v1'] as const)(
    'preserves all six explicitly distinct protected selectors for %s receipts', async (lane) => {
      const f = await fixture('repository', lane === 'legacy' ? undefined : lane, 'backend', 'all');
      const original = canonicalJson(f.checks);
      expect(f.requirements.map((entry) => entry.refFamily)).toEqual([
        'develop', 'main', 'release/*', 'hotfix/*', 'release/**', 'hotfix/**'
      ]);
      const planned = await planRepositoryRulesets(f.planning());
      expect(planned.blockers).toEqual([]);
      expect(planned.operations).toHaveLength(6);
      expect(canonicalJson(f.checks)).toBe(original);
      expect(f.writes()).toEqual([]);
    }
  );

  it('does not promote explicit single-level legacy filters or rehashed receipts into recursive scope', async () => {
    const f = await fixture('repository', undefined, 'backend', 'single');
    const narrow = await planRepositoryRulesets(f.planning());
    expect(narrow.blockers?.join(' ')).toMatch(/each applicable protected ref family/u);
    f.rewriteQualification((payload) => {
      const check = (payload.requiredChecks as Array<Record<string, unknown>>)[0]!;
      check.refFamilies = (check.refFamilies as string[]).map((family) => family.replace('/*', '/**'));
    });
    const relabeled = await planRepositoryRulesets(f.planning());
    expect(relabeled.blockers?.join(' ')).toMatch(/exact immutable workflow source/u);
    expect(f.writes()).toEqual([]);
  });

  it('does not promote a narrow legacy receipt using an unfiltered workflow default', async () => {
    const f = await fixture('repository', undefined, 'backend', 'unfiltered');
    f.rewriteQualification((payload) => {
      const check = (payload.requiredChecks as Array<Record<string, unknown>>)[0]!;
      check.refFamilies = (check.refFamilies as string[]).map((family) => family.replace('/**', '/*'));
    });
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/exact immutable workflow source/u);
    expect(f.writes()).toEqual([]);
  });

  it('executes owned enforcement with the original Vitest recipe rather than a check-name guess', async () => {
    const f = await fixture('repository', 'vitest.v1', 'frontend');
    f.actor.id = 8;
    const approved = await f.approvePublicPlan();
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executeGitHubPhase({ ...approved, lease }));
    expect(result?.status, result?.blocker).toBe('completed');
    expect(f.writes()).toHaveLength(5);
    const plan = approved.plan.operations.find((operation) => operation.actionId === 'github.ruleset.readback')!.inputs.controlPlan as RepositoryControlPlan;
    expect(plan.baseline.binding.actor.id).toBe(8);
    expect(plan.source.qualificationActorId).toBe(7);
    expect(f.currentChecks[0]?.validationManifest?.path).toBe('frontend/package.json');
  });

  it.each(['infrastructure', 'setup', 'skipped', 'closed', 'merged', 'app', 'job'] as const)(
    'rejects %s drift in a retained non-Node qualification before enforcement', async (fault) => {
      const f = await fixture('repository', 'pytest.v1');
      f.checkFault(fault);
      const planned = await planRepositoryRulesets(f.planning());
      expect(planned.operations).toEqual([]);
      expect(planned.blockers?.length).toBe(1);
      expect(f.writes()).toEqual([]);
    }
  );

  it('rejects an executed Vitest manifest that differs from the exact original source descriptor', async () => {
    const f = await fixture('repository', 'vitest.v1');
    const negative = f.boundFixtures.find((entry) => entry.polarity === 'negative')!;
    f.setFixtureSource(negative.publication.commitSha, 'backend/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/executed test script differs/u);
    expect(f.writes()).toEqual([]);
  });

  it.each(['recipe', 'directory', 'actor', 'fixture'] as const)(
    'does not accept rehashed public %s changes as an original approved qualification', async (changed) => {
      const f = await fixture('repository', 'vitest.v1');
      f.rewriteQualification((payload) => {
        const checks = payload.requiredChecks as Array<Record<string, unknown>>;
        if (changed === 'recipe') checks[0]!.recipe = 'go-test.v1';
        if (changed === 'directory') {
          checks[0]!.workingDirectory = 'frontend';
          (checks[0]!.validationManifest as Record<string, unknown>).path = 'frontend/package.json';
        }
        if (changed === 'actor') {
          payload.actorId = 9;
          for (const proof of [...payload.positiveChecks as Array<Record<string, unknown>>, ...payload.controlledNegativeChecks as Array<Record<string, unknown>>]) {
            proof.actorId = 9;
          }
        }
        if (changed === 'fixture') {
          const fixtures = payload.boundFixtures as BoundRepositoryCheckFixture[];
          fixtures[0]!.publication.requiredChecks = [{ context: 'unreviewed-extra-context', appId: 15368 }];
        }
      });
      const planned = await planRepositoryRulesets(f.planning());
      expect(planned.operations).toEqual([]);
      expect(planned.blockers?.join(' ')).toMatch(changed === 'recipe' || changed === 'directory'
        ? /qualification.*conflicting source, actor, app, ref-family or provider proof/u
        : /original.*(?:reviewed|approved)|reviewed.*(?:operation|plan)/u);
      expect(f.writes()).toEqual([]);
    }
  );

  it('rejects a rehashed qualification observation later than its original receipt before provider revalidation', async () => {
    const f = await fixture('repository', 'pytest.v1');
    const client = new GitHubActivationClient(f.transport);
    const observed = await observeRepositoryControls(client, 'owner/repo', 42);
    f.rewriteQualification((payload) => {
      payload.qualifiedAt = new Date(Date.parse(f.checks.header.producedAt) + 1).toISOString();
    });
    const before = f.requests.length;
    await expect(revalidateApprovedRepositoryChecks(f.planning(), client, f.checks, observed.binding, f.refShas.develop))
      .rejects.toMatchObject({
        code: 'check-evidence-admission',
        message: 'Qualification observation time cannot be after its original authoritative receipt.'
      });
    expect(f.requests).toHaveLength(before);
    expect(f.writes()).toEqual([]);
  });

  it('requires actual original private qualification issuance, not only a re-readable provider result', async () => {
    const f = await fixture('repository', 'go-test.v1');
    const unrelatedHome = path.join(f.root, 'other-owned-empty-home');
    await mkdir(unrelatedHome, { mode: 0o700 });
    f.adapters.githubActivation.storage = { ...f.storage, homedir: unrelatedHome };
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/original qualification approval.*private issuance/u);
    expect(f.writes()).toEqual([]);
  });

  it('does not reuse a fully bound repository recipe receipt as full-activation proof', async () => {
    const f = await fixture('repository', 'pytest.v1');
    const client = new GitHubActivationClient(f.transport);
    const observed = await observeRepositoryControls(client, 'owner/repo', 42);
    const before = f.requests.length;
    await expect(revalidateApprovedRepositoryChecks({
      ...f.planning('rulesets-applied'), inspection: { ...f.inspection, scope: 'activation' }
    }, client, f.checks, observed.binding, f.refShas.develop)).rejects.toThrow(/full-activation/u);
    expect(f.requests).toHaveLength(before);
    expect(f.writes()).toEqual([]);
  });

  it('rejects missing retained fixture inventory for an explicitly declared non-Node recipe', async () => {
    const f = await fixture('repository', 'pytest.v1');
    f.rewriteQualification((payload) => { delete payload.boundFixtures; });
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/requires its original reviewed boundFixtures/u);
    expect(f.writes()).toEqual([]);
  });

  it('does not promote genuinely qualified single-level fixtures into recursive protected-ref enforcement', async () => {
    const f = await fixture('repository', 'go-test.v1', '.', 'single');
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/each applicable protected ref family/u);
    expect(f.currentChecks[0]?.refFamilies).toContain('release/*');
    expect(f.currentChecks[0]?.refFamilies).not.toContain('release/**');
    expect(f.writes()).toEqual([]);
  });

  it.each(['run', 'pr', 'job', 'check'] as const)(
    'rejects rehashed public %s identities against private origin or independent provider readback', async (identity) => {
      const f = await fixture('repository', 'go-test.v1');
      f.rewriteQualification((payload) => {
        const positive = (payload.positiveChecks as Array<Record<string, unknown>>)[0]!;
        const fixture = (payload.boundFixtures as BoundRepositoryCheckFixture[])[0]!;
        if (identity === 'run') {
          positive.runId = 9999;
          fixture.runs[0]!.operation.operationId = '9999';
          fixture.runs[0]!.operation.resourceId = '/repos/owner/repo/actions/runs/9999';
        }
        if (identity === 'pr') {
          positive.pullRequestNumber = 9999;
          fixture.pullRequestNumber = 9999;
        }
        if (identity === 'job') positive.jobId = 9999;
        if (identity === 'check') positive.checkRunId = 9999;
        delete payload.requiredContexts;
        payload.requiredContexts = repositoryCheckContextsFromQualification(payload);
      });
      const planned = await planRepositoryRulesets(f.planning());
      expect(planned.operations).toEqual([]);
      expect(planned.blockers?.join(' ')).toMatch(/original private|retained qualified evidence/u);
      expect(f.writes()).toEqual([]);
    }
  );

  it('plans exact desired bytes, actual actor/application IDs, source digests, main baseline and per-control effects', async () => {
    const f = await fixture();
    const result = await planRepositoryRulesets(f.planning());
    expect(result.blockers).toEqual([]);
    expect(f.writes()).toEqual([]);
    expect(result.operations).toHaveLength(6);
    const controlPlan = result.operations.at(-1)!.inputs.controlPlan as RepositoryControlPlan;
    expect(controlPlan.baseline.binding).toMatchObject({ repositoryId: 42, repositoryNodeId: 'R_fixture42', actor: { id: 7 }, actionsApp: { id: 15368 } });
    expect(controlPlan.baseline.mainSha).toBe('b'.repeat(40));
    expect(controlPlan.baseline.collectionEtag).toMatch(/^"/u);
    expect(controlPlan.baseline.rulesets.every((entry) => !Object.hasOwn(entry, 'requestId'))).toBe(true);
    const repeated = await planRepositoryRulesets(f.planning());
    expect(repeated.operations).toEqual(result.operations);
    const retained = {
      ...controlPlan,
      baseline: await observeRepositoryControls(new GitHubActivationClient(f.transport), 'owner/repo', 42)
    };
    expect(retained.baseline.rulesets.every((entry) => entry.requestId !== null)).toBe(true);
    expect(buildRepositoryControlPlan(retained)).toEqual(retained);
    expect(controlPlan.source.fileInventoryDigest).not.toBe(controlPlan.sourceDigest);
    expect(controlPlan.source.publication).toMatchObject({ repositoryId: 42, actorId: 7, actorLogin: 'source-publisher' });
    expect(controlPlan.source.qualificationActorId).toBe(7);
    expect(controlPlan.source.files.every((file) => /^[a-f0-9]{40}$/u.test(file.blobSha))).toBe(true);
    expect(controlPlan.sourceDigest).toBe(productionRulesetSourceDigest(controlPlan.desiredRulesets));
    expect(controlPlan.changes[0]).toMatchObject({ name: 'liftoff-gitflow-main', mode: 'create' });
    for (const change of controlPlan.changes) {
      expect(change.payload).toBe(JSON.stringify(JSON.parse(canonicalJson(change.desired))));
      if (change.kind === 'ruleset') for (const rule of change.desired.rules) {
        if (rule.type === 'required_status_checks') expect(rule.parameters?.required_status_checks).toEqual([{ context: 'verify-source', integration_id: 15368 }]);
      }
    }
  });

  it('creates the approved hold first, checkpoints every POST before effect, records actual IDs and reads back each write', async () => {
    const f = await fixture();
    const input = await f.approve();
    const before = canonicalJson(f.foreign);
    const outcome = await f.execute(input);
    expect(outcome.status, outcome.blocker).toBe('completed');
    expect(f.writes()).toHaveLength(5);
    expect(f.requests.length).toBeLessThan(1024);
    expect((f.writes()[0]!.body as Record<string, unknown>).name).toBe('liftoff-gitflow-main');
    expect(canonicalJson(f.rulesets.get(900))).toBe(before);
    expect(f.repository.another_owner_setting).toEqual({ retained: 'unchanged' });
    expect(f.refShas.main).toBe('b'.repeat(40));
    expect(outcome.evidencePayload).toMatchObject({
      scope: 'repository', mainSha: 'b'.repeat(40),
      mainHold: { status: 'active', repositoryId: 42, control: { id: 1000, nodeId: 'RS_provider1000' } }
    });
    for (const write of f.writes()) {
      const checkpoint = await readRepositoryControlCheckpoint(input, 42, String((write.body as Record<string, unknown>).name));
      expect(checkpoint?.response?.requestId).toMatch(/^PROVIDER:/u);
      expect(checkpoint?.settled?.outcome).toBe('verified');
      expect(checkpoint?.settled?.observation?.rulesets.every((entry) => entry.requestId !== null)).toBe(true);
      expect(checkpoint?.response?.control?.definition.id).toBeGreaterThanOrEqual(1000);
      expect(checkpoint?.prepared.digest).not.toBe(checkpoint?.response?.requestId);
    }
    const record = await f.persist(input, outcome);
    const persisted = JSON.parse(await readFile(path.join(f.projectRoot, 'governance', 'evidence', `${record.evidenceId}.json`), 'utf8'));
    expect(persisted.payload.controlReceiptDigest).toBe((outcome.evidencePayload as Record<string, unknown>).controlReceiptDigest);
    expect(persisted.payload).not.toHaveProperty('productionQualified');
    expect(f.requests.every((request) => !/\/(?:tags|releases|pulls)$/u.test(request.path))).toBe(true);
  });

  it('reconciles already matching private-owned controls with zero provider writes, including supported neutral defaults', async () => {
    const f = await fixture();
    const first = await f.approve();
    await f.persist(first, await f.execute(first));
    for (const rule of f.rulesets.values()) for (const member of rule.rules as Array<Record<string, unknown>>) {
      if (member.type === 'pull_request') Object.assign(member.parameters as object, {
        dismissal_restriction: { enabled: false, allowed_actors: [] }, required_reviewers: [],
        require_extra_approval_for_unattributed_changes: true
      });
    }
    const planning = await planRepositoryRulesets(f.planning());
    expect(planning.blockers).toEqual([]);
    expect(planning.operations).toHaveLength(1);
    const second = await f.issue(planning.operations);
    const before = f.writes().length;
    const outcome = await f.execute(second);
    expect(outcome.status, outcome.blocker).toBe('completed');
    expect(f.writes()).toHaveLength(before);
    expect((outcome.evidencePayload as Record<string, unknown>).ownedControls).toHaveLength(5);
  });

  it('does not infer ownership from matching names, definitions, source files or explicitly guessed provider IDs', async () => {
    const f = await fixture();
    f.rulesets.set(901, {
      ...structuredClone(f.definitions[0]), id: 901, node_id: 'RS_unowned901',
      source_type: 'Repository', source: 'owner/repo'
    });
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/same-named foreign ruleset/u);
    expect(f.writes()).toEqual([]);
    expect(f.rulesets.has(901)).toBe(true);
  });

  it('binds publication, qualification and enforcement actors independently without accepting mixed-principal check proof', async () => {
    const f = await fixture();
    const sourcePayload = f.sourceRecord.payload as Record<string, unknown>;
    f.addEvidence('repository-workflow-source-ready', { ...sourcePayload, actorId: 8, actorLogin: 'separate-publisher' });
    const checkPayload = f.checks.payload as Record<string, unknown>;
    const positive = checkPayload.positiveChecks as Array<Record<string, unknown>>;
    const negative = checkPayload.controlledNegativeChecks as Array<Record<string, unknown>>;
    for (const proof of [...positive, ...negative]) proof.actorId = 9;
    f.qualificationActor.id = 9;
    f.addEvidence('repository-checks-qualified', { ...checkPayload, actorId: 9 });
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers).toEqual([]);
    const plan = planned.operations.at(-1)!.inputs.controlPlan as RepositoryControlPlan;
    expect(plan.baseline.binding.actor.id).toBe(7);
    expect(plan.source.publication.actorId).toBe(8);
    expect(plan.source.qualificationActorId).toBe(9);
    negative[0]!.actorId = 10;
    f.addEvidence('repository-checks-qualified', { ...checkPayload, actorId: 9 });
    expect((await planRepositoryRulesets(f.planning())).blockers?.join(' ')).toMatch(/stale actor/u);
    expect(f.writes()).toEqual([]);
  });

  it('keeps the published file-inventory digest independent of actor and observed blob metadata', async () => {
    const f = await fixture();
    const payload = f.sourceRecord.payload as Record<string, unknown>;
    const files = payload.files as Array<{ path: string; digest: string; readbackDigest: string; blobSha: string }>;
    const original = payload.rulesetSourceDigest;
    const file = files.find((entry) => entry.path === '.github/rulesets/liftoff-gitflow-main.json')!;
    file.blobSha = 'f'.repeat(40);
    f.addEvidence('repository-workflow-source-ready', { ...payload, actorId: 8, actorLogin: 'separate-publisher' });
    expect(canonicalSha256(files.filter((file) => file.path.startsWith('.github/rulesets/')).map(({ path, digest }) => ({ path, digest })))).toBe(original);
    expect((await planRepositoryRulesets(f.planning())).blockers?.join(' ')).toMatch(/observed blob identity/u);
    expect(f.writes()).toEqual([]);
  });

  it('does not treat a supplied internally conflicting required-context projection as authority', async () => {
    const f = await fixture();
    f.addEvidence('repository-checks-qualified', { ...(f.checks.payload as Record<string, unknown>),
      requiredContexts: [{ context: 'invented-context', appId: 99 }] });
    expect((await planRepositoryRulesets(f.planning())).blockers?.join(' ')).toMatch(/cannot supply required contexts/u);
    expect(f.writes()).toEqual([]);
  });

  it.each(['main', 'actor', 'repository', 'foreign', 'source'] as const)('rejects changed %s before any control write', async (changed) => {
    const f = await fixture();
    const approved = await f.approve();
    if (changed === 'main') f.refShas.main = 'c'.repeat(40);
    if (changed === 'actor') f.actor.id = 8;
    if (changed === 'repository') f.repository.id = 43;
    if (changed === 'foreign') f.foreign.rules.push({ type: 'update' });
    if (changed === 'source') f.sourceFiles.set('.github/rulesets/liftoff-gitflow-main.json', `${f.sourceFiles.get('.github/rulesets/liftoff-gitflow-main.json')}\n`);
    expect((await f.execute(approved)).status).toBe('blocked');
    expect(f.writes()).toEqual([]);
  });

  it('rejects imported approval JSON, an expired plan and a missing project lease before provider mutation', async () => {
    const imported = await fixture();
    const noIssuance = await imported.approve({ issued: false });
    expect(await imported.execute(noIssuance)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('private issuance') });
    expect(imported.writes()).toEqual([]);
    const current = await fixture();
    const approved = await current.approve();
    expect(await executeRepositoryRulesets(approved)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('lease') });
    expect(await current.execute({ ...approved, clock: () => new Date(approved.plan.expiresAt) })).toMatchObject({ status: 'blocked' });
    expect(current.writes()).toEqual([]);
  });

  it('fails before POST when the released private pre-effect record cannot be durably written', async () => {
    const f = await fixture();
    const approved = await f.approve();
    approved.adapters.githubActivation = {
      ...f.adapters.githubActivation,
      storage: {
        ...f.storage, fileSystem: {
          ...nodeUpdatePreviewFileSystem,
          async openFile(file, access, mode) {
            if (access === 'create-exclusive' && file.includes('governance-operation-')) {
              throw Object.assign(new Error('Isolated private record failure.'), { code: 'EACCES' });
            }
            return nodeUpdatePreviewFileSystem.openFile(file, access, mode);
          }
        }
      }
    };
    expect((await f.execute(approved)).status).toBe('blocked');
    expect(f.writes()).toEqual([]);
  });

  it('rejects altered approved payload bytes even if the repository and actor are unchanged', async () => {
    const f = await fixture();
    const approved = await f.approve();
    const changed = structuredClone(approved.plan);
    const change = changed.operations[0]!.inputs.change as Record<string, unknown>;
    change.payload = '{}';
    expect((await f.execute({ ...approved, plan: changed })).status).toBe('blocked');
    expect(f.writes()).toEqual([]);
  });

  it('records truthful partial writes and never removes the installed main hold after a later rejection', async () => {
    const f = await fixture();
    f.reject('liftoff-gitflow-develop');
    const approved = await f.approve();
    const outcome = await f.execute(approved);
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [expect.objectContaining({ actionId: 'github.ruleset.apply' })] });
    expect(f.writes()).toHaveLength(2);
    expect(f.rulesets.get(1000)?.rules).toContainEqual({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
    const rejected = await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-develop');
    expect(rejected?.settled).toEqual({ outcome: 'rejected', observation: null });
    expect((await f.execute(approved)).status).toBe('blocked');
    expect(f.writes()).toHaveLength(2);
    f.reject();
    const recovery = await f.issue(approved.plan.operations, f.phaseId, { recovery: true });
    expect(recovery.plan.approval.envelopeHash).not.toBe(approved.plan.approval.envelopeHash);
    const recovered = await f.execute(recovery);
    expect(recovered.status, recovered.blocker).toBe('completed');
    expect(f.writes()).toHaveLength(6);
    expect((await readRepositoryControlCheckpoint(recovery, 42, 'liftoff-gitflow-develop'))?.prepared.sequence).toBe(1);
    expect(f.requests.some((request) => request.method === 'DELETE' || request.method === 'PUT')).toBe(false);
  });

  it('retains lost-response creations without adopting a same-named rule or permitting retry under new approval', async () => {
    const f = await fixture();
    f.lose('liftoff-gitflow-main');
    const approved = await f.approve();
    expect((await f.execute(approved)).status).toBe('blocked');
    expect(f.rulesets.has(1000)).toBe(true);
    const checkpoint = await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-main');
    expect(checkpoint?.response).toBeNull();
    expect(checkpoint?.settled).toBeNull();
    const recovery = await f.issue(approved.plan.operations, f.phaseId, { recovery: true });
    expect(await f.execute(recovery)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('unknown outcome') });
    expect(f.writes()).toHaveLength(1);
  });

  it('recovers a retained response by exact provider ID with independent readback, without duplicate creation', async () => {
    const f = await fixture();
    f.failReadback('liftoff-gitflow-main');
    const approved = await f.approve();
    expect((await f.execute(approved)).status).toBe('blocked');
    expect((await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-main'))?.response?.control?.definition.id).toBe(1000);
    const readOnlyRecovery = await f.execute(approved);
    expect(readOnlyRecovery).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('separately approved recovery') });
    expect(f.writes()).toHaveLength(1);
    f.failReadback();
    const recovery = await f.issue(approved.plan.operations, f.phaseId, { recovery: true });
    expect((await f.execute(recovery)).status).toBe('completed');
    expect(f.writes()).toHaveLength(5);
    expect(f.writes().filter((request) => (request.body as Record<string, unknown>).name === 'liftoff-gitflow-main')).toHaveLength(1);
  });

  it('retains actual provider identities even when the write response cannot be semantically decoded', async () => {
    const f = await fixture();
    f.malformedResponse('liftoff-gitflow-main');
    const approved = await f.approve();
    expect(await f.execute(approved)).toMatchObject({
      status: 'blocked', operation: { resourceId: '/repos/owner/repo/rulesets/1000', operationId: expect.stringMatching(/^PROVIDER:/u) }
    });
    const recorded = await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-main');
    expect(recorded?.response).toMatchObject({
      resource: { id: 1000, nodeId: 'RS_provider1000' }, control: null, requestId: expect.stringMatching(/^PROVIDER:/u)
    });
    f.malformedResponse();
    const recovery = await f.issue(approved.plan.operations, f.phaseId, { recovery: true });
    const outcome = await f.execute(recovery);
    expect(outcome.status, outcome.blocker).toBe('completed');
    expect(f.writes()).toHaveLength(5);
  });

  it('reports a post-write concurrent foreign change without rolling back the new hold or the owner edit', async () => {
    const f = await fixture();
    const approved = await f.approve();
    f.beforePost(() => { f.foreign.rules.push({ type: 'update' }); });
    const outcome = await f.execute(approved);
    expect(outcome).toMatchObject({ status: 'blocked', operation: { resourceId: '/repos/owner/repo/rulesets/1000' } });
    expect(f.writes()).toHaveLength(1);
    expect(f.rulesets.get(1000)).toBeDefined();
    expect(f.foreign.rules).toContainEqual({ type: 'update' });
    expect(f.requests.some((request) => request.method === 'DELETE' || request.method === 'PUT')).toBe(false);
  });

  it('requires genuinely bound positive and controlled-negative proof for every proposed protected ref family', async () => {
    const f = await fixture();
    const payload = f.checks.payload as Record<string, unknown>;
    const negatives = payload.controlledNegativeChecks as typeof f.controlledNegativeChecks;
    negatives[0]!.validationStep.conclusion = 'success' as 'failure';
    f.addEvidence('repository-checks-qualified', { ...payload });
    expect((await planRepositoryRulesets(f.planning())).blockers?.join(' ')).toMatch(/failed validation step/u);
    expect(f.writes()).toEqual([]);
  });

  it('rejects changed qualification commitments before reading replacement provider proof', async () => {
    const f = await fixture();
    const approved = await f.approve();
    f.addEvidence('repository-checks-qualified', {
      ...(f.checks.payload as Record<string, unknown>), qualifiedAt: new Date(f.now.getTime() - 1).toISOString()
    });
    const before = f.requests.length;
    const result = await f.execute(approved);
    expect(result).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('commitments changed after review') });
    expect(f.requests.slice(before).some((request) => /\/(?:actions|contents|pulls)\//u.test(request.path))).toBe(false);
    expect(f.writes()).toEqual([]);
  });

  it('preserves meaningful foreign review restrictions and reports their policy conflict before writes', async () => {
    const f = await fixture();
    const foreign = structuredClone(f.definitions[0]!);
    const reviews = foreign.rules.find((rule) => rule.type === 'pull_request')!.parameters!;
    reviews.required_reviewers = [{ reviewer: { id: 991, type: 'Team' }, minimum_approvals: 1, file_patterns: ['**'] }];
    f.rulesets.set(901, { ...foreign, id: 901, node_id: 'RS_inherited', name: 'organization-required-review',
      source_type: 'Organization', source: 'owner' });
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/foreign or inherited protection conflicts/u);
    expect(f.writes()).toEqual([]);
    expect(f.rulesets.get(901)?.rules).toEqual(foreign.rules);
  });

  it('does not discard unknown source fields while overlaying an explicitly selected main hold', async () => {
    const f = await fixture();
    const path = '.github/rulesets/liftoff-gitflow-main.json';
    const source = JSON.parse(f.sourceFiles.get(path)!);
    source.rules.push({ type: 'update', parameters: { unknown_enforcement: true } });
    f.sourceFiles.set(path, JSON.stringify(source));
    const payload = f.sourceRecord.payload as Record<string, unknown>;
    const files = payload.files as Array<{ path: string; digest: string; readbackDigest: string; blobSha: string }>;
    const file = files.find((file) => file.path === path)!;
    file.digest = canonicalSha256(f.sourceFiles.get(path)!);
    file.readbackDigest = file.digest;
    file.blobSha = githubSourceFixture(path, f.sourceFiles.get(path)!).sha;
    payload.rulesetSourceDigest = canonicalSha256(files.filter((file) => file.path.startsWith('.github/rulesets/')).map(({ path, digest }) => ({ path, digest })));
    f.addEvidence('repository-workflow-source-ready', payload);
    expect((await planRepositoryRulesets(f.planning())).operations).toEqual([]);
    expect(f.writes()).toEqual([]);
  });

  it('routes receipt-bound repository readback through default GitHub phase dispatch', async () => {
    const f = await fixture();
    const approved = await f.approve();
    const outcome = await f.execute(approved);
    await f.persist(approved, outcome);
    const readPhase = 'repository-live-readback';
    const planned = await planGitHubPhase(f.planning(readPhase));
    if (!planned) throw new Error('The default GitHub phase planner did not route repository live readback.');
    expect(planned.blockers).toBeUndefined();
    const read = await f.issue(planned.operations, readPhase);
    expect(read.adapters.githubRulesets).toBeUndefined();
    for (const control of f.rulesets.values()) for (const rule of control.rules as Array<Record<string, unknown>>) {
      if (rule.type === 'pull_request') Object.assign(rule.parameters as object, {
        dismissal_restriction: { enabled: false }, required_reviewers: [],
        require_extra_approval_for_unattributed_changes: true
      });
    }
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executeGitHubPhase({ ...read, lease }));
    if (!result) throw new Error('The default GitHub phase executor did not route repository live readback.');
    expect(result.status, result.blocker).toBe('completed');
    expect(result.evidencePayload).toMatchObject({ scope: 'repository', mainHold: { control: { id: 1000 } } });
    expect(result.liveReadback?.map((proof) => proof.resourceType)).toEqual(['ruleset', 'repository-settings', 'main-baseline']);
    f.repository.allow_merge_commit = false;
    expect(await withProjectMutationLock(f.projectRoot, (lease) => executeGitHubPhase({ ...read, lease }))).toMatchObject({ status: 'blocked' });
    expect(f.writes()).toHaveLength(5);
  });

  it('plans documented settings updates with exact prior values and no fictional conditional-write guarantee', async () => {
    const f = await fixture();
    f.repository.allow_merge_commit = false;
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.operations.some((operation) => operation.actionId === 'github.repository.settings.apply')).toBe(true);
    expect(planned.blockers).toEqual([]);
    expect(f.writes()).toEqual([]);
    const binding = await observeRepositoryControls(new GitHubActivationClient(f.transport), 'owner/repo', 42);
    expect(await readPrivateOwnedRepositoryControls(f.planning(), binding.binding)).toEqual([]);
    const plan = planned.operations.at(-1)!.inputs.controlPlan as RepositoryControlPlan;
    expect(plan.concurrency).toBe('authoritative-pre-read-and-independent-readback');
    expect(plan.changes.find((change) => change.kind === 'settings')).toMatchObject({
      prior: { repositoryId: 42, nodeId: 'R_fixture42', values: { allow_merge_commit: false } },
      desired: { allow_merge_commit: true }
    });
    expect(repositoryControlMutationBlockers(plan)).toEqual([]);
    expect(buildRepositoryControlPlan(plan)).toEqual(plan);
    expect(repositoryControlMutationBlockers({ ...plan, concurrency: 'additive-create-and-independent-readback' })).toEqual([
      expect.stringContaining('retained create-only plan cannot authorize')
    ]);
    const change = plan.changes.find((entry) => entry.kind === 'settings')!;
    const request = repositoryControlWriteRequest('owner/repo', change);
    expect(request).toEqual({ method: 'PATCH', path: '/repos/owner/repo', body: { allow_merge_commit: true } });
    expect(JSON.stringify(request.body)).toBe(change.payload);
    const accepted = observeRepositoryControlWriteResponse(plan.baseline.binding, change, {
      status: 200, headers: { 'x-github-request-id': 'PROVIDER:settings' },
      data: { ...f.repository, allow_merge_commit: true }
    });
    expect(accepted).toMatchObject({ kind: 'response', record: {
      status: 200, requestId: 'PROVIDER:settings', repository: { id: 42, nodeId: 'R_fixture42', name: 'owner/repo' }
    } });
    const different = observeRepositoryControlWriteResponse(plan.baseline.binding, change, {
      status: 200, headers: { 'x-github-request-id': 'PROVIDER:different-repository' },
      data: { ...f.repository, id: 43, allow_merge_commit: true }
    });
    expect(different).toMatchObject({ kind: 'invalid-response', record: { repository: { id: 43 } } });
    expect(() => repositoryControlWriteRequest('owner/repo', { ...change, payload: '{}' })).toThrow(/reviewed desired bytes/u);
  });

  it('reconciles an exact receipt-owned ruleset by documented PUT and retains its original ownership and hold', async () => {
    const f = await fixture();
    const initial = await f.approve();
    const initialOutcome = await f.execute(initial);
    await f.persist(initial, initialOutcome);
    const receiptDigest = String((initialOutcome.evidencePayload as Record<string, unknown>).controlReceiptDigest);
    const originalReceipt = await readRepositoryControlReceipt(initial, receiptDigest);
    const id = f.control('liftoff-gitflow-develop').id;
    f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution = true;
    const approved = await f.approve();
    const changes = (approved.plan.operations.at(-1)!.inputs.controlPlan as RepositoryControlPlan).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'ruleset', mode: 'update', prior: { definition: { id } } });
    const result = await f.execute(approved);
    expect(result.status, result.blocker).toBe('completed');
    expect(f.requests.filter((request) => request.method === 'PUT')).toMatchObject([
      { path: `/repos/owner/repo/rulesets/${id}` }
    ]);
    expect(f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution).toBe(false);
    expect(f.control('liftoff-gitflow-main').rules).toContainEqual({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
    expect((result.evidencePayload as Record<string, unknown>).ownedControls).toEqual(originalReceipt.result.ownedControls);
    expect((await readRepositoryControlReceipt(approved, receiptDigest)).result.ownedControls).toEqual(originalReceipt.result.ownedControls);
    expect((await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-develop'))?.prepared.sequence).toBe(1);
    expect((await f.execute(approved)).status).toBe('completed');
    expect(f.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(f.requests.some((request) => request.method === 'DELETE' || 'headers' in request)).toBe(false);
  });

  it('applies repository PATCH through public approval and default GitHub dispatch with private checkpoints', async () => {
    const f = await fixture();
    f.repository.allow_merge_commit = false;
    const approved = await f.approvePublicPlan();
    expect(approved.adapters.githubRulesets).toBeUndefined();
    const result = await withProjectMutationLock(f.projectRoot, (lease) => executeGitHubPhase({ ...approved, lease }));
    if (!result) throw new Error('The default GitHub dispatcher did not route repository enforcement.');
    expect(result.status, result.blocker).toBe('completed');
    const patches = f.requests.filter((request) => request.method === 'PATCH');
    expect(patches).toEqual([{ method: 'PATCH', path: '/repos/owner/repo', body: { allow_merge_commit: true } }]);
    expect(f.repository.allow_merge_commit).toBe(true);
    expect(f.repository.another_owner_setting).toEqual({ retained: 'unchanged' });
    const checkpoint = await readRepositoryControlCheckpoint(approved, 42, 'repository-settings');
    expect(checkpoint).toMatchObject({
      response: { status: 200, repository: { id: 42, nodeId: 'R_fixture42', name: 'owner/repo' } },
      settled: { outcome: 'verified' }
    });
    expect((result.evidencePayload as Record<string, unknown>).mainHold).toMatchObject({ status: 'active', boundMainSha: 'b'.repeat(40) });
    expect(await withProjectMutationLock(f.projectRoot, (lease) => executeGitHubPhase({ ...approved, lease }))).toMatchObject({ status: 'completed' });
    expect(f.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it('updates only explicitly selected settings and reconciles the matching result with zero further writes', async () => {
    const f = await fixture();
    const initial = await f.approve();
    await f.persist(initial, await f.execute(initial));
    f.inspection.activationInputs!.phases[f.phaseId] = {
      ...f.inspection.activationInputs!.phases[f.phaseId],
      settings: { default_branch: 'develop', allow_merge_commit: true, allow_auto_merge: true }
    };
    const approved = await f.approve();
    const result = await f.execute(approved);
    expect(result.status, result.blocker).toBe('completed');
    expect(f.requests.filter((request) => request.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/repos/owner/repo', body: { allow_auto_merge: true } }
    ]);
    expect(f.repository.allow_squash_merge).toBe(true);
    expect(f.repository.allow_rebase_merge).toBe(true);
    await f.persist(approved, result);
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers).toEqual([]);
    expect(planned.operations.map((operation) => operation.actionId)).toEqual(['github.ruleset.readback']);
    const noOp = await f.issue(planned.operations);
    expect((await f.execute(noOp)).status).toBe('completed');
    expect(f.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });

  it.each(['lost-response', 'mismatched-readback', 'different-repository'] as const)(
    'retains a %s settings outcome without automatic retry or rollback', async (fault) => {
      const f = await fixture();
      const initial = await f.approve();
      await f.persist(initial, await f.execute(initial));
      f.inspection.activationInputs!.phases[f.phaseId] = {
        ...f.inspection.activationInputs!.phases[f.phaseId],
        settings: { default_branch: 'develop', allow_merge_commit: true, allow_auto_merge: true }
      };
      const approved = await f.approve();
      if (fault === 'lost-response') f.lose('repository-settings');
      else f.response((name, response) => {
        if (name !== 'repository-settings') return response;
        if (fault === 'different-repository') return { ...response, id: 43 };
        f.repository.allow_auto_merge = false;
        return response;
      });
      const result = await f.execute(approved);
      expect(result.status).toBe('blocked');
      const checkpoint = await readRepositoryControlCheckpoint(approved, 42, 'repository-settings');
      if (fault === 'lost-response') expect(checkpoint?.response).toBeNull();
      if (fault === 'mismatched-readback') expect(checkpoint?.settled?.outcome).toBe('mismatched');
      if (fault === 'different-repository') expect(checkpoint?.response?.repository?.id).toBe(43);
      expect((await f.execute(approved)).status).toBe('blocked');
      expect(f.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
      expect(f.requests.some((request) => request.method === 'DELETE')).toBe(false);
      expect(f.control('liftoff-gitflow-main').rules).toContainEqual({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
    }
  );

  it('refuses post-approval and post-checkpoint drift, then requires a fresh current-prior recovery plan', async () => {
    const f = await fixture();
    const initial = await f.approve();
    await f.persist(initial, await f.execute(initial));
    f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution = true;
    const approved = await f.approve();
    const id = Number(f.control('liftoff-gitflow-develop').id);
    f.beforeRead(async (request) => {
      if (request.path !== `/repos/owner/repo/rulesets/${id}`) return;
      const current = await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-develop');
      if (current?.prepared.sequence === 1 && !current.response && !current.settled) {
        f.reviewParameters('liftoff-gitflow-develop').required_approving_review_count = 1;
        f.beforeRead();
      }
    });
    const blocked = await f.execute(approved);
    expect(blocked.status).toBe('blocked');
    expect(f.requests.filter((request) => request.method === 'PUT')).toEqual([]);
    expect(f.reviewParameters('liftoff-gitflow-develop').required_approving_review_count).toBe(1);
    expect((await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-develop'))?.settled?.outcome).toBe('not-dispatched');
    expect((await f.execute(approved)).status).toBe('blocked');
    await f.persistBlocked(approved, blocked);
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers).toEqual([]);
    const plan = planned.operations.at(-1)!.inputs.controlPlan as RepositoryControlPlan;
    expect(plan.changes[0]).toMatchObject({ prior: { definition: { id } } });
    const priorRule = plan.changes[0];
    if (priorRule.kind !== 'ruleset') throw new Error('Expected exact ruleset recovery.');
    expect((priorRule.prior!.definition.rules as Array<Record<string, unknown>>).find((rule) => rule.type === 'pull_request')?.parameters)
      .toMatchObject({ required_approving_review_count: 1 });
    const recovery = await f.issue(planned.operations, f.phaseId, { recovery: true });
    const result = await f.execute(recovery);
    expect(result.status, result.blocker).toBe('completed');
    expect(f.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect((await readRepositoryControlCheckpoint(recovery, 42, 'liftoff-gitflow-develop'))?.prepared.sequence).toBe(2);
  });

  it('classifies a lost owned update response without retrying even when current settings now match', async () => {
    const f = await fixture();
    const initial = await f.approve();
    await f.persist(initial, await f.execute(initial));
    f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution = true;
    const approved = await f.approve();
    f.lose('liftoff-gitflow-develop');
    const blocked = await f.execute(approved);
    expect(blocked.status).toBe('blocked');
    expect(f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution).toBe(false);
    const checkpoint = await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-develop');
    expect(checkpoint?.response).toBeNull();
    expect(checkpoint?.settled).toBeNull();
    await f.persistBlocked(approved, blocked);
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.operations).toEqual(approved.plan.operations.filter((operation) => operation.adapter === 'github'));
    const recovery = await f.issue(planned.operations, f.phaseId, { recovery: true });
    expect(await f.execute(recovery)).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('unknown outcome') });
    expect(f.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('records independently observed post-write mismatches and preserves them until separately reviewed recovery', async () => {
    const f = await fixture();
    const initial = await f.approve();
    await f.persist(initial, await f.execute(initial));
    f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution = true;
    const approved = await f.approve();
    f.response((name, response) => {
      if (name === 'liftoff-gitflow-develop') f.reviewParameters(name).required_approving_review_count = 1;
      return response;
    });
    const blocked = await f.execute(approved);
    expect(blocked.status).toBe('blocked');
    expect((await readRepositoryControlCheckpoint(approved, 42, 'liftoff-gitflow-develop'))?.settled?.outcome).toBe('mismatched');
    expect(f.reviewParameters('liftoff-gitflow-develop').required_approving_review_count).toBe(1);
    expect((await f.execute(approved)).status).toBe('blocked');
    expect(f.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    f.response();
    await f.persistBlocked(approved, blocked);
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers).toEqual([]);
    const recovery = await f.issue(planned.operations, f.phaseId, { recovery: true });
    const result = await f.execute(recovery);
    expect(result.status, result.blocker).toBe('completed');
    expect(f.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
    expect(f.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('does not broaden a retained create-only plan into an owned ruleset update', async () => {
    const f = await fixture();
    const initial = await f.approve();
    await f.persist(initial, await f.execute(initial));
    f.reviewParameters('liftoff-gitflow-develop').required_review_thread_resolution = true;
    const current = await planRepositoryRulesets(f.planning());
    const operations = structuredClone(current.operations);
    const read = operations.at(-1)!;
    const plan = read.inputs.controlPlan as RepositoryControlPlan;
    plan.concurrency = 'additive-create-and-independent-readback';
    for (const operation of operations.slice(0, -1)) operation.inputs.controlPlanDigest = canonicalSha256(plan);
    const approved = await f.issue(operations);
    const result = await f.execute(approved);
    expect(result).toMatchObject({ status: 'blocked', blocker: expect.stringContaining('retained create-only plan cannot authorize') });
    expect(f.requests.filter((request) => request.method === 'PUT')).toEqual([]);
  });

  it('never accepts pure hold metadata or repository evidence as authority to remove a production hold', async () => {
    const f = await fixture();
    const pure = createMainUpdateHold({
      repository: 'owner/repo', mainSha: 'b'.repeat(40), ownedControls: ['liftoff-gitflow-main'],
      approvalEnvelopeId: 'metadata-only', now: f.now
    });
    expect(evaluateMainHoldReplacement({
      hold: pure, currentMainSha: pure.boundMainSha, currentOwnedControls: ['liftoff-gitflow-main'],
      qualificationEvidence: f.inspection.evidence, qualificationContexts: f.inspection.contexts, now: f.now
    })).toMatchObject({ canRelease: false, holdRetained: true });
    const approved = await f.approve();
    const outcome = await f.execute(approved);
    const digest = String((outcome.evidencePayload as Record<string, unknown>).controlReceiptDigest);
    const receipt = await readRepositoryControlReceipt(approved, digest);
    expect(receipt.mainHold?.control.id).toBe(1000);
    f.inspection.scope = 'activation';
    expect((await planRepositoryLiveReadback(f.planning('live-readback'))).blockers?.join(' ')).toMatch(/same-scope approved enforcement receipt/u);
    expect(f.writes()).toHaveLength(5);
  });

  it('rejects copied receipt IDs without their exact retained private provider-response ownership', async () => {
    const f = await fixture();
    const approved = await f.approve();
    const outcome = await f.execute(approved);
    expect(outcome.status, outcome.blocker).toBe('completed');
    const receipt = await readRepositoryControlReceipt(approved, String((outcome.evidencePayload as Record<string, unknown>).controlReceiptDigest));
    const copied = structuredClone(receipt);
    copied.result.ownedControls = copied.result.ownedControls.map((entry, index) => index === 0 ? { ...entry, id: 900 } : entry);
    const copiedDigest = canonicalSha256(copied);
    await createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage).write(copiedDigest, copied);
    await expect(readRepositoryControlReceipt(approved, copiedDigest)).rejects.toThrow(/private provider-response ownership/u);
    expect(f.writes()).toHaveLength(5);
  });

  it('requires genuine full source/artifact/native qualification, not bare staging metadata or repository completion', async () => {
    const f = await fixture('activation');
    const planned = await planRepositoryRulesets(f.planning());
    expect(planned.blockers?.join(' ')).toMatch(/genuine source\/artifact\/environment-bound workflow operation/u);
    expect(f.writes()).toEqual([]);
    const absent = await fixture('activation');
    absent.inspection.evidence = absent.inspection.evidence.filter((record) => record.header.phaseId !== 'production-rehearsed');
    expect((await planRepositoryRulesets(absent.planning())).blockers?.join(' ')).toMatch(/production-rehearsed/u);
    expect(absent.writes()).toEqual([]);
  });

  it('delegates only the original verifier source pair independently of the application claim and current reader', async () => {
    const f = await fixture('activation');
    const sourceSha = 'b'.repeat(40);
    const producerSourceSha = f.refShas.develop;
    const executionSourceSha = 'c'.repeat(40);
    const artifactDigest = `sha256:${'c'.repeat(64)}`;
    const workflow = {
      repository: 'owner/repo', repositoryId: 42, actorId: 9,
      producerSourceSha, sourceSha: executionSourceSha
    };
    const operation: TransitionOperation = {
      phaseId: 'staging-qualified', adapter: 'github', actionId: 'github.checks.staging',
      mutationClass: 'github-workflow-dispatch', remote: true, destructive: false,
      destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' },
      inputs: { workflow }
    };
    const subscriptionId = '11111111-2222-4333-8444-555555555555';
    const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/rg-isolated-runtime/providers/Microsoft.App/containerApps/isolated-runtime`;
    const readback: TransitionOperation = {
      phaseId: 'staging-qualified', adapter: 'azure-opentofu', actionId: 'azure.staging.readback',
      mutationClass: 'azure-read', remote: true, destructive: false,
      destination: { type: 'subscription', identity: resourceId, subscriptionId },
      inputs: { workflow }
    };
    const approved = await f.issue([operation, readback], 'staging-qualified');
    const liveReadback = f.inspection.contexts['staging-qualified'].liveReadbackProviders!.map((provider) =>
      readbackProof(approved, provider, 'isolated-reader-routing',
        provider === 'github' ? '/repos/owner/repo/actions/runs/901' : resourceId, { routingOnly: true }));
    const payload = {
      kind: 'staging-qualified.v1', sourceSha, artifactDigest,
      planDigest: approved.plan.planDigest, savedPlanDigest: canonicalSha256(approved.plan),
      runtimeObservation: {
        kind: 'environment-runtime-observation.v1', executionSourceSha, workflow
      }
    };
    const record = await f.persist(approved, {
      status: 'completed', resultState: 'verified', evidencePayload: payload, liveReadback, completedOperations: [operation, readback]
    });
    const reference = {
      evidenceId: record.evidenceId, headerDigest: canonicalSha256(record.header), bodyDigest: record.header.bodyDigest
    };
    const client = new GitHubActivationClient(f.transport);
    const observed = await observeRepositoryControls(client, 'owner/repo', 42);
    const current = f.planning();
    const callsBefore = f.requests.length;
    const reader = vi.spyOn(runtimeReceipts, 'readEnvironmentRuntimeReceipt')
      .mockRejectedValue(new AzureActivationAdmissionError('fixture-reader', 'The exact runtime reader refused the isolated fixture.'));
    try {
      await expect(assertFullControlQualification(current, client, observed.binding, record, sourceSha, artifactDigest, reference))
        .rejects.toThrow(/exact runtime reader refused/u);
      expect(reader).toHaveBeenCalledOnce();
      expect(reader.mock.calls[0]![0]).toBe(current);
      expect(reader.mock.calls[0]![2]).toEqual({
        phaseId: 'staging-qualified', reference,
        verifierSource: { producerSourceSha, executionSourceSha }, artifactDigest
      });
      const readOnly = reader.mock.calls[0]![1];
      await expect(readOnly.transport.request({ method: 'POST', path: '/repos/owner/repo/actions/workflows/19/dispatches' }))
        .rejects.toThrow(/cannot dispatch or mutate/u);
      await expect(assertFullControlQualification(current, client, observed.binding, record, sourceSha, artifactDigest,
        { ...reference, headerDigest: 'e'.repeat(64) })).rejects.toThrow(/exact original receipt reference/u);
      for (const field of ['producerSourceSha', 'sourceSha'] as const) {
        const changed = structuredClone(record);
        const changedPayload = changed.payload as Record<string, unknown>;
        const observation = changedPayload.runtimeObservation as Record<string, unknown>;
        (observation.workflow as Record<string, unknown>)[field] = 'e'.repeat(40);
        if (field === 'sourceSha') observation.executionSourceSha = 'e'.repeat(40);
        changed.header.bodyDigest = evidenceBodyDigest(changed.payload, changed.liveReadback);
        const changedReference = {
          evidenceId: changed.evidenceId, headerDigest: canonicalSha256(changed.header), bodyDigest: changed.header.bodyDigest
        };
        f.inspection.evidence = [...f.inspection.evidence.filter((entry) => entry.evidenceId !== changed.evidenceId), changed];
        const references = f.inspection.state.phases['staging-qualified'].evidence.map((entry) =>
          entry.evidenceId === changed.evidenceId ? { ...entry, headerDigest: changedReference.headerDigest } : entry);
        f.inspection.state.phases['staging-qualified'].evidence = references;
        f.inspection.contexts['staging-qualified'].evidenceReferences = references;
        await expect(assertFullControlQualification(current, client, observed.binding, changed, sourceSha, artifactDigest, changedReference))
          .rejects.toThrow(/exact original approved workflow operation/u);
      }
      expect(reader).toHaveBeenCalledOnce();
      expect(f.requests).toHaveLength(callsBefore);
    } finally {
      reader.mockRestore();
    }
    f.inspection.contexts['staging-qualified'].reviewedPlans = [];
    await expect(assertFullControlQualification(current, client, observed.binding, record, sourceSha, artifactDigest, reference))
      .rejects.toThrow(/original activation receipt/u);
    expect(f.writes()).toEqual([]);
  });
});
