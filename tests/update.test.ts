import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { loadManifest, validateGeneratedProject } from '../src/file-system.js';
import { compareSemver } from '../src/semver.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import {
  governanceArtifactPaths,
  renderCanonicalGovernancePolicy
} from '../src/repository-governance.js';
import { isManagedCoreLogicalName, retiredManagedCoreIdentities } from '../src/artifact-lifecycle.js';
import { reconcileProject } from '../src/reconcile.js';
import type { CommandRunner } from '../src/process-runner.js';
import type { GeneratedArtifact, LiftoffManifest } from '../src/types.js';
import { buildHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { formatUpdateCommand } from '../src/application/update/command-guidance.js';
import { readMigrationJournal } from '../src/governance-activation/migration-history.js';
import {
  canonicalJson,
  canonicalPhaseGraph,
  canonicalSha256,
  createActivationIdentity,
  currentActivationIdentity,
  evidenceBodyDigest,
  evidenceContextForPhase,
  historicalActivationIdentities,
  phaseIds,
  renderGovernanceChangeWritePlan,
  transitionPlanForPhase,
  validateApprovalEnvelope,
  validateEvidenceHeader,
  type PhaseEvidenceRecord,
  type UserActivationState
} from '../src/governance-activation/index.js';
import {
  CaptureStream,
  scriptedTtyInput,
  ttyCaptureStream
} from './helpers.js';
import {
  cleanupUpdateTestRoots,
  createReviewedUpdateFixture as createFixtureProject,
  createUpdateTestRoot,
  fingerprintUpdateTestProject,
  reviewedUpdateArguments,
  updateTestPreviewOptions
} from './reviewed-update-helpers.js';

const sha = (content: string) =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;

const cleanups: string[] = [];
afterEach(async () => {
  try {
    while (cleanups.length > 0) {
      await rm(cleanups.pop()!, { recursive: true, force: true });
    }
  } finally {
    await cleanupUpdateTestRoots();
  }
});

async function fixtureProject(includeFrontend = false): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Update App',
    pattern: 'prompt',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function standardFixtureProject(apiStack = 'go'): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Standard Update App',
    projectType: 'standard',
    apiStack,
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function run(
  args: string[],
  cwd: string,
  runner?: CommandRunner,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; out: string; err: string }> {
  const approved = await reviewedUpdateArguments(args, (previewArgs) =>
    runRaw(previewArgs, cwd, runner, env)
  );
  return runRaw(approved, cwd, runner, env);
}

async function runRaw(
  args: string[],
  cwd: string,
  runner?: CommandRunner,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    updatePreview: updateTestPreviewOptions(cwd),
    ...(runner ? { runner } : {}),
    ...(env ? { env } : {})
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function runInteractive(
  args: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string }> {
  const approved = await reviewedUpdateArguments(args, (previewArgs) => runRaw(previewArgs, cwd));
  const stdout = ttyCaptureStream();
  const stderr = ttyCaptureStream();
  const code = await runCommand(parseArgs(approved), {
    cwd,
    stdin: scriptedTtyInput(''),
    stdout,
    stderr,
    updatePreview: updateTestPreviewOptions(cwd)
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function editJson(
  filePath: string,
  mutate: (value: any) => void
): Promise<void> {
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  mutate(value);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const governancePathPartArrays = [
  governanceArtifactPaths.policy,
  governanceArtifactPaths.context,
  governanceArtifactPaths.guide,
  governanceArtifactPaths.phaseGraph,
  governanceArtifactPaths.compatibility,
  governanceArtifactPaths.credentialPolicySchema,
  governanceArtifactPaths.setup['github-copilot'],
  governanceArtifactPaths.setup.claude,
  governanceArtifactPaths.assessment['github-copilot'],
  governanceArtifactPaths.assessment.claude
] as const;

const assessmentIdentities = [
  {
    logicalName: 'liftoff-governance-assess-copilot',
    pathParts: governanceArtifactPaths.assessment['github-copilot']
  },
  {
    logicalName: 'liftoff-governance-assess-claude',
    pathParts: governanceArtifactPaths.assessment.claude
  }
] as const;

async function removeAssessmentInventory(
  root: string,
  options: { keepFiles?: boolean } = {}
): Promise<void> {
  const names = new Set<string>(assessmentIdentities.map((entry) => entry.logicalName));
  const paths = new Set(assessmentIdentities.map((entry) => entry.pathParts.join('\0')));
  const compatibilityPath = path.join(root, ...governanceArtifactPaths.compatibility);
  await editJson(compatibilityPath, (metadata) => {
    metadata.managedCore.logicalNameAllowlist = metadata.managedCore.logicalNameAllowlist.filter(
      (name: string) => !names.has(name)
    );
    metadata.managedCore.pathAllowlist = metadata.managedCore.pathAllowlist.filter(
      (parts: string[]) => !paths.has(parts.join('\0'))
    );
    metadata.managedCore.updateInventory = metadata.managedCore.updateInventory.filter(
      (entry: { logicalName: string }) => !names.has(entry.logicalName)
    );
  });
  const compatibilityHash = sha(await readFile(compatibilityPath, 'utf8'));
  await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
    manifest.managedArtifacts = manifest.managedArtifacts.filter(
      (entry: { logicalName: string }) => !names.has(entry.logicalName)
    );
    manifest.managedArtifacts.find(
      (entry: { logicalName: string }) => entry.logicalName === 'repository-governance-compatibility'
    ).contentHash = compatibilityHash;
  });
  if (!options.keepFiles) {
    await Promise.all(assessmentIdentities.map((identity) =>
      rm(path.join(root, ...identity.pathParts), { force: true })
    ));
  }
}

type RetiredAliasLogicalName = (typeof retiredManagedCoreIdentities)[number]['logicalName'];

const legacyAliasContent: Record<RetiredAliasLogicalName, string> = {
  'repository-governance-copilot-launcher': '# /liftoff-repository-governance\n\nRetired generated Copilot setup alias.\n',
  'repository-governance-claude-launcher': '# /liftoff-repository-governance\n\nRetired generated Claude setup alias.\n'
};

async function addRetiredAliasOwnership(
  root: string,
  options: {
    logicalNames?: readonly RetiredAliasLogicalName[];
    absent?: boolean;
    modified?: boolean;
  } = {}
): Promise<void> {
  const selected = retiredManagedCoreIdentities.filter((identity) =>
    options.logicalNames === undefined ||
    options.logicalNames.includes(identity.logicalName)
  );
  for (const identity of selected) {
    const content = legacyAliasContent[identity.logicalName];
    if (!options.absent) {
      await writeProjectOwnedFile(root, identity.pathParts, content);
      if (options.modified) {
        await writeProjectOwnedFile(
          root,
          identity.pathParts,
          `${content}Developer customization.\n`
        );
      }
    }
  }
  await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
    for (const identity of selected) {
      manifest.managedArtifacts.push({
        logicalName: identity.logicalName,
        category: identity.category,
        pathParts: identity.pathParts,
        contentHash: sha(legacyAliasContent[identity.logicalName])
      });
    }
  });
}

function convertV6ToV5(manifest: any): void {
  manifest.artifactVersion = 5;
  manifest.artifacts = [
    ...manifest.managedArtifacts,
    ...manifest.projectArtifacts.map((artifact: any) => ({
      logicalName: artifact.logicalName,
      category: artifact.category,
      pathParts: artifact.pathParts,
      contentHash: artifact.generationHash
    }))
  ];
  delete manifest.managedArtifacts;
  delete manifest.projectArtifacts;
  delete manifest.governance?.activationIdentity;
}

async function downgradeToV5(projectRoot: string): Promise<void> {
  await editJson(path.join(projectRoot, 'liftoff.manifest.json'), convertV6ToV5);
}

async function downgradeApiManifest(
  projectRoot: string,
  artifactVersion: 2 | 3 | 4 | 5
): Promise<void> {
  await editJson(path.join(projectRoot, 'liftoff.manifest.json'), (manifest) => {
    convertV6ToV5(manifest);
    if (artifactVersion < 5) {
      manifest.artifacts = manifest.artifacts.filter(
        (artifact: { category: string }) => artifact.category !== 'governance'
      );
      delete manifest.governance;
    }
    if (artifactVersion < 4) {
      const project = manifest.project;
      const workload = project.workload;
      manifest.project = {
        name: project.name,
        ...(artifactVersion === 3
          ? { projectType: workload.kind, apiStack: workload.apiStack }
          : {}),
        ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
        cloud: workload.cloud,
        region: workload.region,
        frontend: workload.frontend,
        environments: workload.environments,
        specWorkflow: project.specWorkflow,
        ...(artifactVersion === 3
          ? {
              agents: project.agents,
              ...(project.defaultAgent
                ? { defaultAgent: project.defaultAgent }
                : {})
            }
          : {})
      };
      if (artifactVersion === 2) {
        delete manifest.framework;
      }
    }
    manifest.artifactVersion = artifactVersion;
  });
  if (artifactVersion < 5) {
    await Promise.all(
      governancePathPartArrays.map((pathParts) =>
        rm(path.join(projectRoot, ...pathParts), { force: true })
      )
    );
  }
}

async function removeGovernanceMetadata(
  projectRoot: string,
  options: { keepFiles?: boolean } = {}
): Promise<void> {
  await editJson(path.join(projectRoot, 'liftoff.manifest.json'), (manifest) => {
    convertV6ToV5(manifest);
    manifest.artifactVersion = 4;
    delete manifest.governance;
    manifest.artifacts = manifest.artifacts.filter(
      (artifact: { category: string }) => artifact.category !== 'governance'
    );
  });
  await editJson(path.join(projectRoot, 'liftoff.config.json'), (config) => {
    delete config.governanceProfile;
  });
  if (!options.keepFiles) {
    await Promise.all(
      governancePathPartArrays.map((pathParts) =>
        rm(path.join(projectRoot, ...pathParts), { force: true })
      )
    );
  }
}

async function simulateCoreUpgrade(
  projectRoot: string,
  logicalName: string,
  pathParts: readonly string[],
  previousContent: string
): Promise<void> {
  await writeFile(path.join(projectRoot, ...pathParts), previousContent, 'utf8');
  await editJson(path.join(projectRoot, 'liftoff.manifest.json'), (manifest) => {
    const artifact = manifest.managedArtifacts.find(
      (entry: { logicalName: string }) => entry.logicalName === logicalName
    );
    artifact.contentHash = sha(previousContent);
  });
}

function currentActivationState(activeChangeId: string | null): UserActivationState {
  const phases = Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
    state: 'pending',
    updatedAt: '2026-09-04T00:00:00.000Z',
    evidence: [],
    approvals: [],
    blockers: []
  }])) as unknown as UserActivationState['phases'];
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: {
      id: 'R_update',
      name: 'owner/update-app',
      defaultBranch: 'develop'
    },
    activeChange: activeChangeId
      ? { id: activeChangeId, kind: 'openspec' }
      : null,
    applicability: {
      statePath: 'bootstrap-local',
      privateStagingDast: true,
      credentialRequired: false
    },
    phases,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z'
  };
}

function retainedCurrentEvidence(evidenceId: string): PhaseEvidenceRecord {
  const context = evidenceContextForPhase('seed-valid', {
    repositoryId: 'R_update',
    baselineSha: canonicalSha256('retained update fixture baseline'),
    inputDigest: canonicalSha256('retained update fixture inputs')
  });
  const payload = { kind: 'seed-valid.v1', validated: false };
  return {
    evidenceId,
    payload,
    header: validateEvidenceHeader({
      schemaVersion: currentActivationIdentity.evidenceHeaderSchemaVersion,
      repositoryId: context.repositoryId,
      identity: currentActivationIdentity,
      phaseGraphHash: context.phaseGraphHash,
      phaseId: context.phaseId,
      phaseContractDigest: context.phaseContractDigest,
      baselineSha: context.baselineSha,
      inputDigest: context.inputDigest,
      transition: context.transition,
      producedAt: '2026-09-04T00:00:00.000Z',
      producer: 'retained-update-fixture',
      result: 'failed',
      bodyDigest: evidenceBodyDigest(payload)
    })
  };
}

function retainedCurrentApproval() {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'activation-approved')!;
  const state = currentActivationState(null);
  const context = evidenceContextForPhase(phase.id, {
    repositoryId: state.repository.id,
    baselineSha: canonicalSha256('retained approval fixture baseline'),
    inputDigest: canonicalSha256('retained approval fixture inputs')
  });
  return validateApprovalEnvelope({
    ...transitionPlanForPhase(phase, state, context.transition),
    schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
    id: 'retained-update-approval',
    approvedAt: '2026-09-04T00:00:00.000Z',
    expiresAt: '2026-09-05T00:00:00.000Z',
    approver: 'fixture-maintainer'
  });
}

async function installDiagnosticActivationV1(
  root: string,
  governanceState?: 'handoff-generated' | 'handoff-partial'
): Promise<{
  identity: (typeof historicalActivationIdentities)[number];
  statePath: string;
  evidencePath: string;
}> {
  const identity = historicalActivationIdentities[0]!;
  await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
    manifest.governance.policyVersion = identity.policyVersion;
    manifest.governance.activationIdentity = identity;
    if (governanceState) manifest.governance.state = governanceState;
  });
  const statePath = path.join(root, 'governance', 'activation-state.json');
  const historical = buildHistoricalV1Fixture();
  const evidencePath = path.join(root, 'governance', 'evidence', `${historical.records[0].evidenceId}.json`);
  for (const [name, content] of historical.files) {
    if (name === 'governance/activation-state.json' || name.startsWith('governance/evidence/') ||
      name.startsWith('governance/plans/') || name.startsWith('governance/approvals/')) {
      await writeProjectOwnedFile(root, name.split('/'), content.toString('utf8'));
    }
  }
  return { identity, statePath, evidencePath };
}

async function writeProjectOwnedFile(root: string, parts: readonly string[], content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, ...parts)), { recursive: true });
  await writeFile(path.join(root, ...parts), content, 'utf8');
}

async function installActiveGovernanceChange(
  root: string,
  options: { historicalMetadata?: boolean } = {}
): Promise<{ changeId: string; paths: string[][] }> {
  const historicalIdentity = createActivationIdentity('e'.repeat(64));
  const writePlan = renderGovernanceChangeWritePlan({
    projectName: 'Update App',
    repositoryId: 'R_update',
    repositoryName: 'owner/update-app',
    defaultBranch: 'develop',
    workflowKind: 'openspec',
    baselineSha: 'a'.repeat(64),
    evidenceIds: ['phase-0'],
    approvedFacts: [
      { id: 'repositoryId', value: 'R_update' },
      { id: 'repositoryName', value: 'owner/update-app' }
    ],
    approvedAt: '2026-09-04T00:00:00.000Z',
    approver: 'owner'
  });
  for (const file of writePlan.files) {
    const value = options.historicalMetadata &&
      file.pathParts.at(-1) === 'liftoff-governance.json'
      ? `${canonicalJson({
          ...JSON.parse(file.content),
          activationIdentity: historicalIdentity,
          phaseGraphHash: historicalIdentity.phaseGraphHash
        })}\n`
      : file.content;
    await writeProjectOwnedFile(root, file.pathParts, value);
  }
  await writeProjectOwnedFile(
    root,
    ['governance', 'activation-state.json'],
    `${canonicalJson(currentActivationState(writePlan.changeId))}\n`
  );
  return {
    changeId: writePlan.changeId,
    paths: [
      ['governance', 'activation-state.json'],
      ...writePlan.files.map((file) => [...file.pathParts])
    ]
  };
}

async function pathFingerprints(root: string, paths: readonly (readonly string[])[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const parts of paths) {
    const content = await readFile(path.join(root, ...parts));
    result[parts.join('/')] = createHash('sha256').update(content).digest('hex');
  }
  return result;
}

describe('reviewed update argument helpers', () => {
  const normal = 'a1'.repeat(32);
  const force = 'b2'.repeat(32);
  const preview = (plans = [
    { mode: 'normal', fingerprint: normal },
    { mode: 'force', fingerprint: force }
  ], code = 2) => ({
    code,
    out: JSON.stringify({ schemaVersion: 3, scope: 'project-update', plans }),
    err: ''
  });

  it.each([
    { args: ['update', 'project with spaces', '--json'], project: 'project with spaces', fingerprint: normal },
    { args: ['update', '--project', 'C:\\Projects\\Claim App', '--force'], project: 'C:\\Projects\\Claim App', fingerprint: force }
  ])('reviews the exact target and mode before approving $args', async ({ args, project, fingerprint }) => {
    const invocations: string[][] = [];
    const approved = await reviewedUpdateArguments(args, async (checkArgs) => {
      invocations.push(checkArgs);
      return preview();
    });
    expect(invocations).toEqual([['update', '--check', '--json', '--project', project]]);
    expect(approved).toEqual([...args, '--approve-plan', fingerprint]);
    expect(args).not.toContain('--approve-plan');
  });

  it('leaves no-op apply without an approval flag', async () => {
    expect(await reviewedUpdateArguments(['update'], async () => preview([], 0)))
      .toEqual(['update']);
  });

  it.each([
    ['update', '--check', '--json'],
    ['update', '--approve-plan', normal],
    ['update', '--help']
  ])('does not generate a new preview for the explicit raw invocation %j', async (...args) => {
    const invoked: string[][] = [];
    expect(await reviewedUpdateArguments(args, async (checkArgs) => {
      invoked.push(checkArgs);
      return preview();
    })).toEqual(args);
    expect(invoked).toEqual([]);
  });

  it('never substitutes a normal fingerprint for a missing forced variant', async () => {
    await expect(reviewedUpdateArguments(
      ['update', '--force'],
      async () => preview([{ mode: 'normal', fingerprint: normal }])
    )).rejects.toThrow(/exactly one previewed force plan/);
  });

  it('does not manufacture approval after a rejected or malformed preview', async () => {
    await expect(reviewedUpdateArguments(['update'], async () => preview([], 1)))
      .rejects.toThrow(/Expected an eligible preview/);
    await expect(reviewedUpdateArguments(
      ['update'],
      async () => preview([{ mode: 'normal', fingerprint: 'short' }])
    )).rejects.toThrow();
  });
});

describe('semver comparison', () => {
  it('orders releases and prereleases correctly', () => {
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.2.0', '0.3.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.3.0-next.1', '0.3.0')).toBeLessThan(0);
    expect(compareSemver('0.3.0-next.2', '0.3.0-next.10')).toBeLessThan(0);
  });
});

describe('core-only update command', () => {
  it('reports no drift on a fresh schema-v7 project', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const before = await readFile(manifestPath, 'utf8');

    const result = await runRaw(['update'], root);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Liftoff core is current');
    expect(result.out).toContain('project files were not changed');
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('retains raw coverage for apply without a matching prior preview', async () => {
    const root = await fixtureProject();
    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );
    const watched = [['liftoff.manifest.json'], governanceArtifactPaths.policy];
    const before = await pathFingerprints(root, watched);

    const result = await runRaw(['update', '--json'], root);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 3,
      scope: 'project-update'
    });
    expect(await pathFingerprints(root, watched)).toEqual(before);
  });

  it('retains raw coverage for a preview without force or JSON implying consent', async () => {
    const root = await fixtureProject();
    await writeFile(path.join(root, ...governanceArtifactPaths.policy), '# modified managed policy\n');
    const watched = [['liftoff.manifest.json'], governanceArtifactPaths.policy];
    const before = await pathFingerprints(root, watched);
    const check = await runRaw(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'force', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    ]));

    const result = await runRaw(['update', '--force', '--json'], root);

    expect(result.code).toBe(1);
    expect(await pathFingerprints(root, watched)).toEqual(before);
  });

  it('keeps production files and intentional absences outside check, update, and force', async () => {
    const root = await standardFixtureProject('go');
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.includeFrontend = true;
    });
    expect((await run(['update'], root)).code).toBe(0);

    const apiPath = path.join(root, 'backend', 'internal', 'api', 'api.go');
    const frontendPath = path.join(root, 'frontend', 'src', 'App.vue');
    const modulePath = path.join(root, 'backend', 'go.mod');
    const dockerfilePath = path.join(root, 'Dockerfile');
    const infrastructurePath = path.join(
      root,
      'infrastructure',
      'opentofu',
      'azure',
      'modules',
      'application',
      'main.tf'
    );
    const productionApi = 'package api\n\n// production API\n';
    const productionFrontend = '<template>production portal</template>\n';
    const productionModule = 'module example.com/production\n\ngo 1.27\n';
    const productionDockerfile = 'FROM scratch\n';
    await writeFile(apiPath, productionApi);
    await writeFile(frontendPath, productionFrontend);
    await writeFile(modulePath, productionModule);
    await writeFile(dockerfilePath, productionDockerfile);
    await rm(infrastructurePath);

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.out)).toMatchObject({
      schemaVersion: 3,
      mode: 'check',
      scope: 'project-update',
      entries: [],
      provisioning: []
    });

    const commandRunnerCalls: string[] = [];
    const authorityRunner: CommandRunner = {
      async run(command) {
        commandRunnerCalls.push(`${command.executable} ${command.args.join(' ')}`);
        throw new Error('update must not invoke command runners or remote adapters');
      }
    };
    expect((await runRaw(['update', '--check', '--json'], root, authorityRunner)).code).toBe(0);
    expect((await runRaw(['update', '--force', '--json'], root, authorityRunner)).code).toBe(0);
    expect(commandRunnerCalls).toEqual([]);

    expect((await run(['update'], root)).code).toBe(0);
    expect((await run(['update', '--force'], root)).code).toBe(0);
    expect(await readFile(apiPath, 'utf8')).toBe(productionApi);
    expect(await readFile(frontendPath, 'utf8')).toBe(productionFrontend);
    expect(await readFile(modulePath, 'utf8')).toBe(productionModule);
    expect(await readFile(dockerfilePath, 'utf8')).toBe(productionDockerfile);
    await expect(access(infrastructurePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('upgrades, restores, skips, and force-replaces only managed core', async () => {
    const root = await fixtureProject();
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    const currentPolicy = renderCanonicalGovernancePolicy();

    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );
    const restored = await run(['update', '--json'], root);
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.out)).toMatchObject({
      schemaVersion: 3,
      scope: 'project-update',
      written: ['.liftoff/governance/policy.md']
    });
    expect(await readFile(policyPath, 'utf8')).toBe(currentPolicy);

    await rm(policyPath);
    expect((await run(['update'], root)).code).toBe(0);
    expect(await readFile(policyPath, 'utf8')).toBe(currentPolicy);

    await writeFile(policyPath, '# local governance policy\n');
    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).entries).toContainEqual(
      expect.objectContaining({
        logicalName: 'repository-governance-policy',
        status: 'conflict',
        path: '.liftoff/governance/policy.md'
      })
    );

    const skipped = await runInteractive(['update'], root);
    expect(skipped.code).toBe(0);
    expect(await readFile(policyPath, 'utf8')).toBe('# local governance policy\n');

    const forced = await run(['update', '--force'], root);
    expect(forced.code).toBe(0);
    expect(await readFile(policyPath, 'utf8')).toBe(currentPolicy);
    expect(skipped.out).toContain('Skipped Liftoff core conflicts');
  });

  it('previews and applies a policy-v2 handoff upgrade without hand-editing the manifest', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    const currentPolicy = renderCanonicalGovernancePolicy();
    const previousPolicy = currentPolicy.replace(
      'policyVersion: "6"',
      'policyVersion: "2"'
    );

    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      previousPolicy
    );
    await editJson(manifestPath, (manifest) => {
      manifest.artifactVersion = 6;
      manifest.liftoffVersion = '0.9.5';
      manifest.governance.policyVersion = '2';
      delete manifest.governance.activationIdentity;
    });
    const before = await readFile(manifestPath, 'utf8');

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out)).toMatchObject({
      schemaVersion: 3,
      mode: 'check',
      scope: 'project-update',
      projectVersion: '0.9.5',
      entries: expect.arrayContaining([
        expect.objectContaining({
          logicalName: 'repository-governance-policy',
          status: 'upgrade',
          path: '.liftoff/governance/policy.md'
        })
      ])
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(before);

    const applied = await run(['update', '--json'], root);
    expect(applied.code).toBe(0);
    expect(await readFile(policyPath, 'utf8')).toBe(currentPolicy);
    const upgradedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(upgradedManifest.governance).toEqual({
      profile: 'single-maintainer-gitflow',
      policyVersion: '6',
      activationIdentity: expect.any(Object),
      state: 'handoff-generated'
    });
  });

  it('adopts governance into a v4 project without acquiring project authority', async () => {
    const root = await fixtureProject();
    await removeGovernanceMetadata(root);
    const sourcePath = path.join(root, 'backend', 'apis', 'main.py');
    const source = '# production source\n';
    await writeFile(sourcePath, source);

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    const report = JSON.parse(check.out);
    expect(report.ownershipMigrationPending).toBe(true);
    expect(report.entries.every((entry: { logicalName: string }) =>
      isManagedCoreLogicalName(entry.logicalName)
    )).toBe(true);

    expect((await run(['update'], root)).code).toBe(0);
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.artifactVersion).toBe(7);
    expect(manifest.managedArtifacts.every((artifact: { logicalName: string }) =>
      isManagedCoreLogicalName(artifact.logicalName)
    )).toBe(true);
    expect(manifest.projectArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'backend-main'
    )).toBe(true);
  });

  it.each([5, 6, 7])('installs assessment integrations as safe drift from a supported v%s inventory', async (version) => {
    const root = await fixtureProject();
    const identity = assessmentIdentities[0];
    await removeAssessmentInventory(root);
    if (version === 5) {
      await downgradeToV5(root);
    } else if (version === 6) {
      await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
        manifest.artifactVersion = 6;
        delete manifest.governance.activationIdentity;
      });
    }
    const previous = await loadManifest(root);
    expect(previous.managedArtifacts.some((entry) => entry.logicalName === identity.logicalName)).toBe(false);
    expect(await validateGeneratedProject(root)).toEqual([]);
    const watched = [
      ['liftoff.manifest.json'],
      ...previous.managedArtifacts.map((entry) => entry.pathParts)
    ];
    const before = await pathFingerprints(root, watched);
    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).entries).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'new',
      path: identity.pathParts.join('/')
    }));
    expect(await pathFingerprints(root, watched)).toEqual(before);
    await expect(access(path.join(root, ...identity.pathParts))).rejects.toMatchObject({ code: 'ENOENT' });

    const applied = await run(['update', '--json'], root);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out).written).toContain(identity.pathParts.join('/'));
    const manifest = await loadManifest(root);
    expect(manifest.artifactVersion).toBe(7);
    expect(manifest.governance).toMatchObject({
      policyVersion: '6',
      activationIdentity: currentActivationIdentity,
      state: 'handoff-generated'
    });
    expect(manifest.managedArtifacts).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      category: 'governance',
      pathParts: [...identity.pathParts]
    }));
    expect(manifest.managedArtifacts.some((entry) => entry.logicalName === assessmentIdentities[1].logicalName)).toBe(false);
    expect(await validateGeneratedProject(root)).toEqual([]);
    expect((await run(['update', '--check', '--json'], root)).code).toBe(0);
  });

  it('adopts identical unrecorded assessment bytes without changing them', async () => {
    const root = await fixtureProject();
    const identity = assessmentIdentities[0];
    const destination = path.join(root, ...identity.pathParts);
    const before = await readFile(destination);
    await removeAssessmentInventory(root, { keepFiles: true });
    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).entries).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'unchanged',
      reason: expect.stringContaining('unrecorded destination already matches')
    }));
    expect((await run(['update', '--json'], root)).code).toBe(0);
    expect(await readFile(destination)).toEqual(before);
    expect((await loadManifest(root)).managedArtifacts).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      contentHash: sha(before.toString('utf8'))
    }));
  });

  it('preserves unowned assessment collisions and framework neighbors even under force', async () => {
    const root = await fixtureProject();
    const identity = assessmentIdentities[0];
    await removeAssessmentInventory(root);
    const custom = '# Project-owned assessment command\r\nDo not replace.\r\n';
    await writeProjectOwnedFile(root, identity.pathParts, custom);
    const neighbors = [
      ['.github', 'prompts', 'opsx-custom.prompt.md'],
      ['.claude', 'commands', 'spec-kit-custom.md'],
      ['governance', 'assessment-report.json']
    ];
    for (const parts of neighbors) {
      await writeProjectOwnedFile(root, parts, 'project-owned neighboring bytes\n');
    }
    const protectedPaths = [[...identity.pathParts], ...neighbors];
    const before = await pathFingerprints(root, protectedPaths);
    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).entries).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'conflict',
      reason: expect.stringContaining('not owned')
    }));
    for (const args of [['update', '--json'], ['update', '--force', '--json']]) {
      const applied = await run(args, root, undefined, {
        ...process.env,
        LIFTOFF_UPDATE_INJECT_FAILURE: `before-path:${identity.pathParts.join('/')}`
      });
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.out).skipped).toContainEqual(expect.objectContaining({
        logicalName: identity.logicalName,
        status: 'conflict'
      }));
      const manifest = await loadManifest(root);
      expect(manifest.governance.state).toBe('handoff-partial');
      expect(manifest.managedArtifacts.some((entry) => entry.logicalName === identity.logicalName)).toBe(false);
      expect(await pathFingerprints(root, protectedPaths)).toEqual(before);
      expect(await validateGeneratedProject(root)).toEqual([]);
    }
    await rm(path.join(root, ...identity.pathParts));
    expect((await run(['update', '--json'], root)).code).toBe(0);
    expect((await loadManifest(root)).governance.state).toBe('handoff-generated');
  });

  it('never suggests force can resolve an unowned assessment destination', async () => {
    const root = await fixtureProject();
    const identity = assessmentIdentities[0];
    await removeAssessmentInventory(root);
    const custom = '# Independently owned assessment\n';
    await writeProjectOwnedFile(root, identity.pathParts, custom);

    const check = await run(['update', '--check'], root);
    expect(check.code).toBe(2);
    const applyOutputs: string[] = [];
    for (const args of [['update'], ['update', '--force']]) {
      const applied = await run(args, root);
      expect(applied.code).toBe(0);
      applyOutputs.push(applied.out);
      expect(await readFile(path.join(root, ...identity.pathParts), 'utf8')).toBe(custom);
      expect((await loadManifest(root)).managedArtifacts.some((entry) =>
        entry.logicalName === identity.logicalName
      )).toBe(false);
    }
    expect(check.out).toContain('Unowned destinations remain protected');
    expect(check.out).toContain('--force cannot overwrite it');
    expect(check.out).not.toContain(formatUpdateCommand(root, 'force'));
    for (const output of applyOutputs) {
      expect(output).toContain('protected unowned destination');
      expect(output).toContain('--force cannot overwrite it');
      expect(output).not.toContain('use --force to overwrite');
    }
  });

  it('protects unowned common governance files during first forced adoption', async () => {
    const root = await fixtureProject();
    await removeGovernanceMetadata(root, { keepFiles: true });
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    const custom = '# Independently owned governance policy\n';
    await writeFile(policyPath, custom);

    const applied = await run(['update', '--force', '--json'], root, undefined, {
      ...process.env,
      LIFTOFF_UPDATE_INJECT_FAILURE: `before-path:${governanceArtifactPaths.policy.join('/')}`
    });
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out).skipped).toContainEqual(expect.objectContaining({
      logicalName: 'repository-governance-policy',
      status: 'conflict'
    }));
    expect(await readFile(policyPath, 'utf8')).toBe(custom);
    const manifest = await loadManifest(root);
    expect(manifest.governance.state).toBe('handoff-partial');
    expect(manifest.managedArtifacts.some((entry) => entry.logicalName === 'repository-governance-policy')).toBe(false);
    expect(await validateGeneratedProject(root)).toEqual([]);
  });

  it('force-updates owned conflicts while preserving neighboring unowned conflicts', async () => {
    const root = await fixtureProject();
    const identity = assessmentIdentities[0];
    await removeAssessmentInventory(root);
    const unowned = '# Independently owned assessment\n';
    await writeProjectOwnedFile(root, identity.pathParts, unowned);
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    const currentPolicy = await readFile(policyPath, 'utf8');
    await simulateCoreUpgrade(root, 'repository-governance-policy', governanceArtifactPaths.policy, '# Previous policy\n');
    await writeFile(policyPath, '# Modified previous policy\n');

    const check = await run(['update', '--check'], root);
    expect(check.code).toBe(2);
    const applied = await run(['update', '--force', '--json'], root);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out).written).toContain(governanceArtifactPaths.policy.join('/'));
    expect(JSON.parse(applied.out).written).not.toContain(identity.pathParts.join('/'));
    expect(JSON.parse(applied.out).skipped).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName
    }));
    expect(await readFile(policyPath, 'utf8')).toBe(currentPolicy);
    expect(await readFile(path.join(root, ...identity.pathParts), 'utf8')).toBe(unowned);
    const manifest = await loadManifest(root);
    expect(manifest.governance.state).toBe('handoff-partial');
    expect(manifest.managedArtifacts.some((entry) => entry.logicalName === identity.logicalName)).toBe(false);
    expect(await validateGeneratedProject(root)).toEqual([]);
    expect(check.out).toContain(formatUpdateCommand(root, 'force'));
    expect(check.out).toContain('Unowned destinations remain protected');
  });

  it('guards modified managed assessment integrations until explicit force', async () => {
    const root = await fixtureProject();
    const identity = assessmentIdentities[0];
    const destination = path.join(root, ...identity.pathParts);
    const current = await readFile(destination, 'utf8');
    await simulateCoreUpgrade(root, identity.logicalName, identity.pathParts, '# Prior managed assessment\n');
    const custom = '# Prior managed assessment\nDeveloper modification.\n';
    await writeFile(destination, custom);
    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).entries).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'conflict'
    }));
    expect((await run(['update', '--json'], root)).code).toBe(0);
    expect(await readFile(destination, 'utf8')).toBe(custom);
    expect((await loadManifest(root)).managedArtifacts.some((entry) => entry.logicalName === identity.logicalName)).toBe(true);
    expect((await run(['update', '--force', '--json'], root)).code).toBe(0);
    expect(await readFile(destination, 'utf8')).toBe(current);
    expect(await validateGeneratedProject(root)).toEqual([]);
  });

  it('preserves activation/evidence bytes and rolls back a failed assessment inventory adoption', async () => {
    const root = await fixtureProject();
    await removeAssessmentInventory(root);
    const active = await installActiveGovernanceChange(root);
    const evidence = ['governance', 'evidence', 'assessment-retained.json'];
    await writeProjectOwnedFile(root, evidence,
      `${JSON.stringify(retainedCurrentEvidence('assessment-retained'), null, 2).replaceAll('\n', '\r\n')}\r\n`);
    const protectedPaths = [...active.paths, evidence];
    const before = await pathFingerprints(root, protectedPaths);
    const managed = (await loadManifest(root)).managedArtifacts.map((entry) => entry.pathParts);
    const rollbackPaths = [['liftoff.manifest.json'], ...managed, ...protectedPaths];
    const rollbackBefore = await pathFingerprints(root, rollbackPaths);

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code, `${check.out}\n${check.err}`).toBe(2);
    expect(await pathFingerprints(root, rollbackPaths)).toEqual(rollbackBefore);
    const failed = await run(
      ['update', '--json'],
      root,
      undefined,
      { ...process.env, LIFTOFF_UPDATE_INJECT_FAILURE: 'before-path:liftoff.manifest.json' }
    );
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({
      schemaVersion: 3,
      scope: 'project-update',
      status: 'failed',
      committed: false,
      message: expect.stringContaining('All attributable changes were rolled back')
    });
    expect(await pathFingerprints(root, rollbackPaths)).toEqual(rollbackBefore);
    await expect(access(path.join(root, ...assessmentIdentities[0].pathParts)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run(['update', '--json'], root)).code).toBe(0);
    expect(await pathFingerprints(root, protectedPaths)).toEqual(before);
    expect((await loadManifest(root)).managedArtifacts.some((entry) =>
      protectedPaths.some((parts) => parts.join('\0') === entry.pathParts.join('\0'))
    )).toBe(false);
  });

  it('ignores an unrecorded retired alias file because it has no manifest ownership', async () => {
    const root = await fixtureProject();
    const identity = retiredManagedCoreIdentities[0];
    const launcherPath = path.join(
      root,
      ...identity.pathParts
    );
    await mkdir(path.dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, 'developer retained old launcher\n');

    expect((await run(['update'], root)).code).toBe(0);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance.state).toBe('handoff-generated');
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === identity.logicalName
    )).toBe(false);
    expect(await readFile(launcherPath, 'utf8')).toBe('developer retained old launcher\n');
  });

  it('checks and removes clean retired alias ownership without touching bytes in check mode', async () => {
    const root = await fixtureProject();
    await addRetiredAliasOwnership(root);
    const watched = [
      ['liftoff.manifest.json'],
      ...retiredManagedCoreIdentities.map((identity) => [...identity.pathParts])
    ];
    const before = await pathFingerprints(root, watched);

    const check = await run(['update', '--check', '--json'], root);

    expect(check.code).toBe(2);
    const checkReport = JSON.parse(check.out);
    expect(checkReport.entries).toEqual(expect.arrayContaining(
      retiredManagedCoreIdentities.map((identity) =>
        expect.objectContaining({
          logicalName: identity.logicalName,
          status: 'retired',
          path: identity.pathParts.join('/'),
          fileDeleted: true
        })
      )
    ));
    expect(checkReport.summary).toMatchObject({
      retired: 2,
      retiredRemoved: 2,
      retiredAbsent: 0,
      retiredConflict: 0
    });
    expect(await pathFingerprints(root, watched)).toEqual(before);

    const applied = await run(['update', '--json'], root);

    expect(applied.code).toBe(0);
    const applyReport = JSON.parse(applied.out);
    expect(applyReport.removed).toEqual(expect.arrayContaining(
      retiredManagedCoreIdentities.map((identity) =>
        expect.objectContaining({
          logicalName: identity.logicalName,
          status: 'retired',
          path: identity.pathParts.join('/'),
          fileDeleted: true
        })
      )
    ));
    for (const identity of retiredManagedCoreIdentities) {
      await expect(access(path.join(root, ...identity.pathParts)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance.state).toBe('handoff-generated');
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName.startsWith('repository-governance-') &&
      artifact.logicalName.endsWith('-launcher')
    )).toBe(false);
    expect(await validateGeneratedProject(root)).toEqual([]);
    expect((await run(['update', '--check', '--json'], root)).code).toBe(0);
  });

  it('retires already absent alias ownership without counting a file deletion', async () => {
    const root = await fixtureProject();
    await addRetiredAliasOwnership(root, {
      logicalNames: ['repository-governance-copilot-launcher'],
      absent: true
    });

    const applied = await run(['update', '--json'], root);

    expect(applied.code).toBe(0);
    const report = JSON.parse(applied.out);
    expect(report.removed).toContainEqual(expect.objectContaining({
      logicalName: 'repository-governance-copilot-launcher',
      status: 'retired-absent',
      path: '.github/prompts/liftoff-repository-governance.prompt.md',
      fileDeleted: false
    }));
    expect(report.summary).toMatchObject({
      retired: 1,
      retiredRemoved: 0,
      retiredAbsent: 1
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'repository-governance-copilot-launcher'
    )).toBe(false);
  });

  it('protects modified retired aliases unless force removes the exact alias', async () => {
    const root = await fixtureProject();
    const identity = retiredManagedCoreIdentities[0];
    await addRetiredAliasOwnership(root, {
      logicalNames: [identity.logicalName],
      modified: true
    });
    const aliasPath = path.join(root, ...identity.pathParts);
    const modified = await readFile(aliasPath, 'utf8');
    const watched = [['liftoff.manifest.json'], [...identity.pathParts]];
    const beforeCheck = await pathFingerprints(root, watched);

    const check = await run(['update', '--check', '--json'], root);

    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).entries).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'retired-conflict',
      path: identity.pathParts.join('/'),
      fileDeleted: true
    }));
    expect(await pathFingerprints(root, watched)).toEqual(beforeCheck);

    const plain = await run(['update', '--json'], root);

    expect(plain.code).toBe(0);
    const plainReport = JSON.parse(plain.out);
    expect(plainReport.status).toBe('partial');
    expect(plainReport.removed).toEqual([]);
    expect(plainReport.skipped).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'retired-conflict',
      path: identity.pathParts.join('/')
    }));
    expect(await readFile(aliasPath, 'utf8')).toBe(modified);
    let manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance.state).toBe('handoff-partial');
    expect(manifest.managedArtifacts).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      pathParts: identity.pathParts
    }));

    const forced = await run(['update', '--force', '--json'], root);

    expect(forced.code).toBe(0);
    const forcedReport = JSON.parse(forced.out);
    expect(forcedReport.removed).toContainEqual(expect.objectContaining({
      logicalName: identity.logicalName,
      status: 'force-retired',
      path: identity.pathParts.join('/'),
      fileDeleted: true
    }));
    await expect(access(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' });
    manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance.state).toBe('handoff-generated');
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === identity.logicalName
    )).toBe(false);
    expect(await validateGeneratedProject(root)).toEqual([]);
  });

  it('leaves unrelated managed-core orphans untouched', async () => {
    const root = await fixtureProject();
    const orphanPathParts = governanceArtifactPaths.policy;
    const orphanBefore = await readFile(path.join(root, ...orphanPathParts), 'utf8');
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
        artifact.logicalName === 'repository-governance-policy'
      )).toBe(true);
    });
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.governanceProfile = 'none';
    });

    const applied = await run(['update', '--force', '--json'], root);

    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out).summary.orphan).toBeGreaterThan(0);
    expect(await readFile(path.join(root, ...orphanPathParts), 'utf8'))
      .toBe(orphanBefore);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'repository-governance-policy'
    )).toBe(false);
  });

  it('rolls back retired alias deletion and manifest rewrite when the update transaction fails', async () => {
    const root = await fixtureProject();
    const identity = retiredManagedCoreIdentities[0];
    await addRetiredAliasOwnership(root, {
      logicalNames: [identity.logicalName]
    });
    const aliasPath = path.join(root, ...identity.pathParts);
    const aliasBefore = await readFile(aliasPath, 'utf8');
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');

    const failed = await run(
      ['update', '--json'],
      root,
      undefined,
      { ...process.env, LIFTOFF_UPDATE_INJECT_FAILURE: 'before-path:liftoff.manifest.json' }
    );

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({
      schemaVersion: 3,
      scope: 'project-update',
      status: 'failed',
      committed: false,
      message: expect.stringContaining('All attributable changes were rolled back')
    });
    expect(await readFile(aliasPath, 'utf8')).toBe(aliasBefore);
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore);
  });

  it('preserves governance files when the managed profile is disabled', async () => {
    const root = await fixtureProject();
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    const before = await readFile(policyPath);
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.governanceProfile = 'none';
    });

    expect((await run(['update'], root)).code).toBe(0);
    expect(await readFile(policyPath)).toEqual(before);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance).toEqual({
      profile: 'none',
      state: 'disabled'
    });
    expect(manifest.managedArtifacts).toEqual([]);
  });

  it.each([
    {
      label: 'project name',
      mutate: (config: any) => {
        config.projectName = 'Renamed Update App';
      },
      expected: 'Project name changes'
    },
    {
      label: 'cloud',
      mutate: (config: any) => {
        config.cloud = 'aws';
      },
      expected: 'Cloud changes'
    },
    {
      label: 'region',
      mutate: (config: any) => {
        config.region = 'westus2';
      },
      expected: 'Region changes'
    }
  ])('rejects $label identity changes before any update write', async ({
    mutate,
    expected
  }) => {
    const root = await fixtureProject();
    const configPath = path.join(root, 'liftoff.config.json');
    await editJson(configPath, mutate);
    const watched = [
      ['liftoff.config.json'],
      ['liftoff.manifest.json'],
      [...governanceArtifactPaths.context],
      ['infrastructure', 'opentofu', 'azure', 'environments', 'dev', 'dev.tfvars']
    ];
    const before = await pathFingerprints(root, watched);

    for (const args of [['update'], ['update', '--force']]) {
      const result = await runRaw(args, root);
      expect(result.code).toBe(1);
      expect(result.err).toContain(expected);
      expect(result.err).toContain('separately reviewed project migration');
      expect(await pathFingerprints(root, watched)).toEqual(before);
    }
  });

  it('refuses to disable governance while activation state exists', async () => {
    const root = await fixtureProject();
    const active = await installActiveGovernanceChange(root);
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.governanceProfile = 'none';
    });
    const watched = [
      ['liftoff.config.json'],
      ['liftoff.manifest.json'],
      [...governanceArtifactPaths.policy],
      ...active.paths
    ];
    const before = await pathFingerprints(root, watched);

    for (const args of [['update'], ['update', '--check'], ['update', '--force']]) {
      const result = await runRaw(args, root);
      expect(result.code).toBe(1);
      expect(result.err).toContain('cannot be disabled');
      expect(result.err).toContain('separately supported deactivation');
      expect(result.err).toContain('does not infer the absence of live enforcement');
      expect(await pathFingerprints(root, watched)).toEqual(before);
    }
  });

  it('migrates v5 ownership without changing modified or deleted project files', async () => {
    const root = await standardFixtureProject('go');
    await downgradeToV5(root);
    const apiPath = path.join(root, 'backend', 'internal', 'api', 'api.go');
    const infrastructurePath = path.join(
      root,
      'infrastructure',
      'opentofu',
      'azure',
      'modules',
      'application',
      'main.tf'
    );
    const production = 'package api\n\n// evolved production API\n';
    await writeFile(apiPath, production);
    await rm(infrastructurePath);
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const before = await readFile(manifestPath, 'utf8');

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out)).toMatchObject({
      schemaVersion: 3,
      entries: [{
        logicalName: 'repository-governance-context',
        status: 'upgrade',
        path: '.liftoff/governance/context.json'
      }],
      ownershipMigrationPending: true
    });

    expect(await readFile(manifestPath, 'utf8')).toBe(before);

    expect((await run(['update'], root)).code).toBe(0);
    expect(await readFile(apiPath, 'utf8')).toBe(production);
    await expect(access(infrastructurePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.artifactVersion).toBe(7);
    expect(manifest.projectArtifacts.find((artifact: { logicalName: string }) =>
      artifact.logicalName === 'go-backend-api'
    )).toMatchObject({
      generatedBy: expect.any(String),
      generationHash: expect.stringMatching(/^sha256:/)
    });
    const governanceContext = JSON.parse(
      await readFile(path.join(root, ...governanceArtifactPaths.context), 'utf8')
    );
    expect(governanceContext.generatedBoundaries.opentofu).toMatchObject({
      layout: 'unknown',
      compatibility: 'migration-required'
    });
    expect(governanceContext.commands.some(
      (command: { executable: string }) => command.executable === 'tofu'
    )).toBe(false);
  });

  it.each([2, 3, 4, 5] as const)(
    'migrates schema v%s without acquiring production authority',
    async (artifactVersion) => {
      const root = await fixtureProject();
      await downgradeApiManifest(root, artifactVersion);
      const sourcePath = path.join(root, 'backend', 'apis', 'main.py');
      const deletedPath = path.join(root, 'Dockerfile');
      const production = `# production source from schema v${artifactVersion}\n`;
      await writeFile(sourcePath, production);
      await rm(deletedPath);

      expect((await run(['update'], root)).code).toBe(0);
      expect(await readFile(sourcePath, 'utf8')).toBe(production);
      await expect(access(deletedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const manifest = JSON.parse(
        await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
      );
      expect(manifest.artifactVersion).toBe(7);
      expect(manifest.projectArtifacts.some((artifact: { logicalName: string }) =>
        artifact.logicalName === 'backend-main'
      )).toBe(true);
    }
  );

  it('defaults unknown legacy logical names to project provenance', async () => {
    const root = await fixtureProject();
    await downgradeToV5(root);
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      manifest.artifacts.push({
        logicalName: 'retired-production-topology',
        category: 'infrastructure',
        pathParts: ['retired', 'main.tf'],
        contentHash: sha('retired\n')
      });
    });

    expect((await run(['update'], root)).code).toBe(0);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.projectArtifacts).toContainEqual(
      expect.objectContaining({
        logicalName: 'retired-production-topology',
        generationHash: sha('retired\n')
      })
    );
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'retired-production-topology'
    )).toBe(false);
  });

  it('provisions a newly selected frontend once and never restores it', async () => {
    const root = await standardFixtureProject('go');
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.includeFrontend = true;
    });

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.out).provisioning).toContainEqual(
      expect.objectContaining({ group: 'frontend', status: 'ready' })
    );
    expect((await run(['update'], root)).code).toBe(0);

    const appPath = path.join(root, 'frontend', 'src', 'App.vue');
    await expect(access(appPath)).resolves.toBeUndefined();
    let manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.project.workload.frontend).toBe(true);
    expect(manifest.projectArtifacts.some((artifact: {
      provisioningGroup: string;
    }) => artifact.provisioningGroup === 'frontend')).toBe(true);

    await rm(appPath);
    expect((await run(['update'], root)).code).toBe(0);
    await expect(access(appPath)).rejects.toMatchObject({ code: 'ENOENT' });
    manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.project.workload.frontend).toBe(true);
  });

  it('adopts an identical provisioning destination without rewriting it', async () => {
    const root = await standardFixtureProject('go');
    const plan = buildProjectPlan({
      projectName: 'Standard Update App',
      projectType: 'standard',
      apiStack: 'go',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'openspec',
      includeFrontend: true
    }, { requireProjectName: true });
    const appArtifact = buildArtifacts(plan).find((artifact) =>
      artifact.logicalName === 'frontend-app'
    )!;
    const appPath = path.join(root, ...appArtifact.pathParts);
    await mkdir(path.dirname(appPath), { recursive: true });
    await writeFile(appPath, appArtifact.content);
    const before = await readFile(appPath);
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.includeFrontend = true;
    });

    const result = await run(['update', '--json'], root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).provisioning[0].entries).toContainEqual(
      expect.objectContaining({
        status: 'adopt',
        path: 'frontend/src/App.vue'
      })
    );
    expect(await readFile(appPath)).toEqual(before);
  });

  it('blocks a complete frontend provisioning group on collision even with force', async () => {
    const root = await standardFixtureProject('go');
    const appPath = path.join(root, 'frontend', 'src', 'App.vue');
    await mkdir(path.dirname(appPath), { recursive: true });
    await writeFile(appPath, '<template>existing production UI</template>\n');
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.includeFrontend = true;
    });
    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );

    const result = await run(['update', '--force', '--json'], root);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 3,
      status: 'partial',
      provisioning: [
        expect.objectContaining({ group: 'frontend', status: 'blocked' })
      ]
    });
    expect(JSON.parse(result.out).written).toContain(
      '.liftoff/governance/policy.md'
    );
    expect(await readFile(
      path.join(root, ...governanceArtifactPaths.policy),
      'utf8'
    )).toBe(renderCanonicalGovernancePolicy());
    expect(await readFile(appPath, 'utf8')).toContain('existing production UI');
    await expect(access(path.join(root, 'frontend', 'package.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.project.workload.frontend).toBe(false);
  });

  it('provisions an added environment and preserves it through disable and re-enable', async () => {
    const root = await standardFixtureProject('go');
    const configPath = path.join(root, 'liftoff.config.json');
    await editJson(configPath, (config) => {
      config.environments = ['dev', 'staging'];
    });
    expect((await run(['update'], root)).code).toBe(0);

    const backendEnv = path.join(root, 'environments', 'staging', 'backend.env');
    const tfvars = path.join(
      root,
      'infrastructure',
      'opentofu',
      'azure',
      'environments',
      'staging',
      'staging.tfvars'
    );
    await expect(access(backendEnv)).resolves.toBeUndefined();
    await expect(access(tfvars)).resolves.toBeUndefined();

    await editJson(configPath, (config) => {
      config.environments = ['dev'];
    });
    expect((await run(['update'], root)).code).toBe(0);
    await expect(access(backendEnv)).resolves.toBeUndefined();

    await rm(backendEnv);
    await editJson(configPath, (config) => {
      config.environments = ['dev', 'staging'];
    });
    expect((await run(['update'], root)).code).toBe(0);
    await expect(access(backendEnv)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(tfvars)).resolves.toBeUndefined();
  });

  it.each([
    ['update'],
    ['update', '--force']
  ])('rejects a retired manifest before force or ownership classification: %j', async (...args) => {
    const root = await createUpdateTestRoot();
    cleanups.push(root);
    const fixture = JSON.parse(
      await readFile(path.resolve('tests/fixtures/manifest-v4-power-apps.json'), 'utf8')
    );
    fixture.project.workload.starter = null;
    fixture.project.workload.codeAppsPlugin = { malformed: true };
    fixture.artifacts = [{
      logicalName: 'unsafe',
      category: 'governance',
      pathParts: ['..', 'outside'],
      contentHash: 'invalid'
    }];
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const sourcePath = path.join(root, 'production-app.txt');
    const manifestBytes = `${JSON.stringify(fixture, null, 2)}\n`;
    await writeFile(manifestPath, manifestBytes);
    await writeFile(sourcePath, 'production bytes\n');
    const runner: CommandRunner = {
      async run(command) {
        throw new Error(`Unexpected retired-project probe: ${command.executable}`);
      }
    };

    const result = await runRaw(args, root, runner);

    expect(result.code).toBe(1);
    expect(`${result.out}\n${result.err}`).toMatch(
      /Power Apps.*retired|retired.*Power Apps/i
    );
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBytes);
    expect(await readFile(sourcePath, 'utf8')).toBe('production bytes\n');
  });

  it('keeps check project-read-only and versions project-update JSON with managed-core summaries', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    await writeFile(policyPath, '# local policy\n');
    const before = await readFile(manifestPath, 'utf8');

    const result = await run(['update', '--check', '--json'], root);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 3,
      mode: 'check',
      scope: 'project-update',
      ownershipMigrationPending: false
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('preserves user-owned activation state, evidence, approvals, credentials, records, and active changes', async () => {
    const root = await fixtureProject();
    const active = await installActiveGovernanceChange(root);
    const userFiles = [
      ...active.paths,
      ['governance', 'evidence', 'manual-evidence.json'],
      ['governance', 'approvals', 'manual-approval.json'],
      ['governance', 'credentials', 'preflight-policy.json'],
      ['governance', 'supersessions', 'manual-supersession.json'],
      ['governance', 'reconciliation', 'manual-reconciliation.json']
    ];
    await writeProjectOwnedFile(root, ['governance', 'evidence', 'manual-evidence.json'],
      `${JSON.stringify(retainedCurrentEvidence('manual-evidence'), null, 4)}\n`);
    await writeProjectOwnedFile(root, ['governance', 'approvals', 'manual-approval.json'],
      `${JSON.stringify(retainedCurrentApproval(), null, 4)}\n`);
    await writeProjectOwnedFile(root, ['governance', 'credentials', 'preflight-policy.json'], '{"user":"credential-metadata"}\n');
    await writeProjectOwnedFile(root, ['governance', 'supersessions', 'manual-supersession.json'], '{"user":"supersession"}\n');
    await writeProjectOwnedFile(root, ['governance', 'reconciliation', 'manual-reconciliation.json'], '{"user":"reconciliation"}\n');
    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );
    const before = await pathFingerprints(root, userFiles);

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code, `${check.out}\n${check.err}`).toBe(2);
    expect(await pathFingerprints(root, userFiles)).toEqual(before);

    const applied = await run(['update', '--force', '--json'], root);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out).written).toContain('.liftoff/governance/policy.md');
    expect(await pathFingerprints(root, userFiles)).toEqual(before);
  });

  it.each(['evidence', 'approvals'])('rejects malformed current %s without rewriting any project bytes', async (directory) => {
    const root = await fixtureProject();
    const active = await installActiveGovernanceChange(root);
    const invalidPath = ['governance', directory, 'invalid-current.json'];
    await writeProjectOwnedFile(root, invalidPath, '{"userOwned":true}\n');
    await simulateCoreUpgrade(root, 'repository-governance-policy', governanceArtifactPaths.policy, '# previous policy\n');
    const watched = [['liftoff.manifest.json'], governanceArtifactPaths.policy, ...active.paths, invalidPath];
    const before = await pathFingerprints(root, watched);

    for (const args of [
      ['update', '--check', '--json'],
      ['update', '--force', '--json']
    ]) {
      const result = await runRaw(args, root);
      expect(result.code, result.out).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({
        schemaVersion: 3,
        scope: 'project-update',
        status: 'blocked',
        reasonCode: 'incompatible-update',
        committed: false,
        activationMigration: { reasonCode: 'invalid-current-proof' }
      });
      expect(await pathFingerprints(root, watched)).toEqual(before);
    }
  });

  it('blocks incomplete v1 history before managed-core or component writes', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const statePath = path.join(root, 'governance', 'activation-state.json');
    const evidencePath = path.join(root, 'governance', 'evidence', 'historical-v1.json');
    const historicalIdentity = historicalActivationIdentities[0]!;
    await editJson(manifestPath, (manifest) => {
      manifest.governance.policyVersion = historicalIdentity.policyVersion;
      manifest.governance.activationIdentity = historicalIdentity;
    });
    await writeProjectOwnedFile(root, ['governance', 'activation-state.json'], `${JSON.stringify({
      schemaVersion: 1,
      identity: historicalIdentity
    }, null, 2)}\n`);
    await writeProjectOwnedFile(root, ['governance', 'evidence', 'historical-v1.json'], `${JSON.stringify({
      schemaVersion: 1,
      identity: historicalIdentity,
      historical: true
    }, null, 2)}\n`);
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.includeFrontend = true;
    });
    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );
    const stateBefore = await readFile(statePath);
    const evidenceBefore = await readFile(evidencePath);

    const applied = await runRaw(['update', '--json'], root);

    expect(applied.code).toBe(1);
    expect(JSON.parse(applied.out)).toMatchObject({
      committed: false,
      activationMigration: { status: 'blocked' },
      reconciliation: { status: 'blocked' },
      provisioning: [{
        group: 'frontend',
        status: 'blocked',
        reason: expect.stringContaining('migration')
      }]
    });
    expect(await readFile(statePath)).toEqual(stateBefore);
    expect(await readFile(evidencePath)).toEqual(evidenceBefore);
    await expect(access(path.join(root, 'frontend', 'package.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const updatedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(updatedManifest.governance.activationIdentity).toEqual(historicalIdentity);
  });

  it('blocks a v1 successor when a required historical wrapper destination is unowned', async () => {
    const root = await createFixtureProject({
      projectName: 'Historical Partial',
      pattern: 'prompt',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'openspec',
      agents: ['copilot', 'claude'],
      includeFrontend: false
    });
    cleanups.push(path.dirname(root));
    await removeAssessmentInventory(root);
    const history = await installDiagnosticActivationV1(root, 'handoff-generated');
    const custom = '# Independently owned Copilot assessment wrapper\n';
    const conflict = path.join(root, ...assessmentIdentities[0].pathParts);
    await writeProjectOwnedFile(root, assessmentIdentities[0].pathParts, custom);
    const stateBefore = await readFile(history.statePath);
    const evidenceBefore = await readFile(history.evidencePath);

    const result = await runRaw(['update', '--check', '--json'], root);
    expect(result.code, result.out).toBe(1);

    const loaded = await loadManifest(root);
    expect(loaded.governance).toMatchObject({
      state: 'handoff-generated',
      activationIdentity: history.identity
    });
    expect(loaded.managedArtifacts.some((entry) =>
      entry.logicalName === assessmentIdentities[1].logicalName
    )).toBe(false);
    expect(loaded.managedArtifacts.some((entry) =>
      entry.logicalName === assessmentIdentities[0].logicalName
    )).toBe(false);
    expect(await readFile(conflict, 'utf8')).toBe(custom);
    expect(await readFile(history.statePath)).toEqual(stateBefore);
    expect(await readFile(history.evidencePath)).toEqual(evidenceBefore);
    expect((await runRaw(['update', '--force', '--json'], root)).code).toBe(1);
  });

  it('promotes an old partial handoff after historical wrappers become complete', async () => {
    const root = await createFixtureProject({
      projectName: 'Historical Complete',
      pattern: 'prompt',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      specWorkflow: 'openspec',
      agents: ['copilot', 'claude'],
      includeFrontend: false
    });
    cleanups.push(path.dirname(root));
    await removeAssessmentInventory(root);
    const history = await installDiagnosticActivationV1(root, 'handoff-partial');
    const stateBefore = await readFile(history.statePath);
    const evidenceBefore = await readFile(history.evidencePath);

    const result = await run(['update', '--json'], root, {
      run: async (command) => ({
        command, displayCommand: command.executable, status: 1, signal: null,
        stdout: '', stderr: 'Local validation is unavailable in this fixture.', timedOut: false
      })
    });
    expect(result.code, result.out).toBe(2);

    const loaded = await loadManifest(root);
    expect(loaded.governance).toMatchObject({
      state: 'handoff-generated',
      activationIdentity: currentActivationIdentity
    });
    for (const identity of assessmentIdentities) {
      expect(loaded.managedArtifacts.some((entry) =>
        entry.logicalName === identity.logicalName
      )).toBe(true);
    }
    const journal = await readMigrationJournal(root);
    expect(journal).toBeDefined();
    const snapshot = path.join(root, 'governance', 'history', journal!.snapshotId, 'files');
    expect(await readFile(path.join(snapshot, 'governance', 'activation-state.json'))).toEqual(stateBefore);
    expect(await readFile(path.join(snapshot, path.relative(root, history.evidencePath)))).toEqual(evidenceBefore);
    expect(await validateGeneratedProject(root)).toEqual([]);
    expect((await run(['update', '--check'], root)).code).toBe(2);
  });

  it('blocks active governance metadata with an undeclared old graph identity', async () => {
    const root = await fixtureProject();
    await installActiveGovernanceChange(root, { historicalMetadata: true });
    const watched = [
      ['liftoff.manifest.json'],
      ['governance', 'activation-state.json']
    ];
    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );
    const before = await pathFingerprints(root, watched);

    const result = await runRaw(['update', '--json'], root);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.status).toBe('blocked');
    expect(report.reconciliation).toMatchObject({
      status: 'blocked',
      remedy: expect.stringContaining('Upgrade')
    });
    expect(report.reconciliation.issues.join(' ')).toMatch(/recognized|phaseGraphHash|explicit compatibility/i);
    expect(await pathFingerprints(root, watched)).toEqual(before);
  });

  it('blocks unrecognized activation tuples without writing managed or user bytes', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    await editJson(manifestPath, (manifest) => {
      manifest.governance.activationIdentity.phaseGraphHash = 'f'.repeat(64);
    });
    const before = await readFile(manifestPath, 'utf8');

    const result = await runRaw(['update', '--json'], root);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 3,
      scope: 'project-update',
      status: 'failed',
      committed: false
    });
    expect(report.message).toContain('explicit compatibility map');
    expect(report.message).toContain('recognized graph hashes');
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects unsafe identity changes before mutation', async () => {
    const root = await standardFixtureProject('go');
    const sourcePath = path.join(root, 'backend', 'internal', 'api', 'api.go');
    const source = await readFile(sourcePath, 'utf8');
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.apiStack = 'node-fastify';
    });

    const result = await runRaw(['update', '--force'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('API stack changes');
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it.each([
    ['generic', 'rag'],
    ['prompt', 'generic']
  ])(
    'rejects the GenAI pattern migration %s -> %s without touching project files',
    async (recordedPattern, desiredPattern) => {
      const root = await createFixtureProject({
        projectName: 'Pattern Migration',
        pattern: recordedPattern,
        cloud: 'azure',
        region: 'eastus',
        environments: ['dev'],
        specWorkflow: 'openspec'
      });
      cleanups.push(path.dirname(root));
      const routePath = path.join(
        root,
        'backend',
        'apis',
        'routes',
        `${recordedPattern}.py`
      );
      const before = await readFile(routePath, 'utf8');
      await editJson(path.join(root, 'liftoff.config.json'), (config) => {
        config.pattern = desiredPattern;
      });

      const result = await runRaw(['update', '--force'], root);
      expect(result.code).toBe(1);
      expect(result.err).toContain(
        `Pattern changes (${recordedPattern} -> ${desiredPattern}) are a migration`
      );
      expect(await readFile(routePath, 'utf8')).toBe(before);
    }
  );

  it('rejects a project written by a newer CLI', async () => {
    const root = await fixtureProject();
    await editJson(path.join(root, 'liftoff.manifest.json'), (manifest) => {
      manifest.liftoffVersion = '999.0.0';
    });

    const result = await runRaw(['update'], root);
    expect(result.code).toBe(1);
    expect(result.err).toContain('newer than this CLI');
  });

  it('rejects incompatible check and force modes during argument parsing', () => {
    expect(() => parseArgs(['update', '--check', '--force']))
      .toThrow(/--check and --force cannot be combined/);
    expect(() => parseArgs(['update', '--apply']))
      .toThrow(/--apply was removed/);
  });

  it('discovers the project root from a subdirectory and honors explicit paths', async () => {
    const root = await fixtureProject();
    const nested = path.join(root, 'backend', 'apis');
    await mkdir(nested, { recursive: true });

    expect((await run(['update', '--check'], nested)).code).toBe(0);
    expect((await run(['update', '--check', root], path.dirname(root))).code).toBe(0);
  });

  it.each(['positional', 'flag'] as const)(
    'keeps %s project selection in preview, missing/stale, and approval follow-ups',
    async (selection) => {
      const original = await fixtureProject();
      const root = path.join(path.dirname(original), 'Reviewed project with spaces');
      await rename(original, root);
      const cwd = await fixtureProject();
      const otherBefore = await fingerprintUpdateTestProject(cwd);
      const target = selection === 'positional' ? [root] : ['--project', path.relative(cwd, root)];
      const policy = path.join(root, ...governanceArtifactPaths.policy);
      await simulateCoreUpgrade(root, 'repository-governance-policy', governanceArtifactPaths.policy, '# Previous policy\n');
      await writeFile(policy, '# Protected local policy\n');
      const before = await fingerprintUpdateTestProject(root);
      const checkCommand = formatUpdateCommand(root, 'check');

      for (const json of [false, true]) {
        const missing = await runRaw(['update', '--force', ...target, ...(json ? ['--json'] : [])], cwd);
        expect(missing.code).toBe(1);
        const output = json ? JSON.parse(missing.out) : { message: missing.err, remedy: missing.err };
        expect(output.message).toContain(checkCommand);
        expect(output.remedy).toContain(checkCommand);
        expect(output.message).toContain('No new project update was performed');
      }

      const preview = await runRaw(['update', '--check', ...target], cwd);
      expect(preview.code).toBe(2);
      expect(preview.out).toContain(formatUpdateCommand(root));
      expect(preview.out).toContain(formatUpdateCommand(root, 'force'));
      expect(preview.out).not.toContain(formatUpdateCommand(cwd));
      const unapproved = await runRaw(['update', '--force', ...target, '--json'], cwd);
      expect(unapproved.code).toBe(1);
      expect(JSON.parse(unapproved.out)).toMatchObject({
        projectRoot: root, reasonCode: 'approval-required'
      });
      expect(JSON.parse(unapproved.out).remedy).toContain(checkCommand);
      expect(await fingerprintUpdateTestProject(root)).toEqual(before);

      await writeFile(policy, '# Concurrently edited policy\n');
      for (const json of [false, true]) {
        const stale = await runRaw(['update', '--force', ...target, ...(json ? ['--json'] : [])], cwd);
        expect(stale.code).toBe(1);
        const output = json ? JSON.parse(stale.out) : { message: stale.err, remedy: stale.err };
        expect(output.message).toContain(checkCommand);
        expect(output.remedy).toContain(checkCommand);
      }
      expect(await readFile(policy, 'utf8')).toBe('# Concurrently edited policy\n');
      expect(await fingerprintUpdateTestProject(cwd)).toEqual(otherBefore);
    }
  );

  it('detects a concurrent core mutation and preserves the newer bytes', async () => {
    const root = await fixtureProject();
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    await simulateCoreUpgrade(
      root,
      'repository-governance-policy',
      governanceArtifactPaths.policy,
      '# previous policy\n'
    );
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');
    const approvedArgs = await reviewedUpdateArguments(
      ['update'],
      (previewArgs) => runRaw(previewArgs, root)
    );
    const fingerprint = parseArgs(approvedArgs).flags['approve-plan'];
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const stdout = new CaptureStream();
    const stderr = ttyCaptureStream();
    let prompted = false;

    const code = await runCommand(parseArgs(['update']), {
      cwd: root,
      stdin: scriptedTtyInput(''),
      stdout,
      stderr,
      updatePreview: updateTestPreviewOptions(root),
      approveUpdatePlan: async (config) => {
        prompted = true;
        expect(config.default).toBe(false);
        expect(config.message).toContain(fingerprint);
        await writeFile(policyPath, '# concurrent policy\n');
        return true;
      }
    });

    expect(prompted).toBe(true);
    expect(code).toBe(1);
    expect(await readFile(policyPath, 'utf8')).toBe('# concurrent policy\n');
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore);
    expect((await run(['update', '--force'], root)).code).toBe(0);
    expect(await readFile(policyPath, 'utf8')).toBe(renderCanonicalGovernancePolicy());
  });
});

describe('managed-core reconciliation states', () => {
  function syntheticManifest(
    managedArtifacts: LiftoffManifest['managedArtifacts']
  ): LiftoffManifest {
    return {
      artifactVersion: 6,
      generatedBy: 'Mission Control Liftoff',
      liftoffVersion: '0.9.0',
      project: {
        name: 'Synthetic',
        workload: {
          kind: 'standard',
          apiStack: 'go-huma',
          cloud: 'azure',
          region: 'eastus',
          frontend: false,
          environments: ['dev']
        },
        specWorkflow: 'openspec',
        agents: []
      },
      framework: {
        state: 'legacy',
        adapter: 'openspec'
      },
      governance: {
        profile: 'unspecified',
        state: 'unspecified'
      },
      managedArtifacts,
      projectArtifacts: []
    };
  }

  it('classifies clean managed-core moves and orphans without project artifacts', async () => {
    const root = await createUpdateTestRoot();
    cleanups.push(root);
    const oldParts = ['legacy', 'policy.md'];
    await mkdir(path.join(root, 'legacy'), { recursive: true });
    await writeFile(path.join(root, ...oldParts), 'old core\n');
    const manifest = syntheticManifest([
      {
        logicalName: 'synthetic-core',
        category: 'governance',
        pathParts: oldParts,
        contentHash: sha('old core\n')
      }
    ]);
    const render: GeneratedArtifact[] = [
      {
        logicalName: 'synthetic-core',
        category: 'governance',
        lifecycle: 'managed-core',
        pathParts: ['current', 'policy.md'],
        content: 'new core\n'
      },
      {
        logicalName: 'production-source',
        category: 'backend',
        lifecycle: 'project',
        provisioningGroup: 'base',
        pathParts: ['backend', 'main.go'],
        content: 'template source\n'
      }
    ];

    const moved = await reconcileProject(manifest, render, root);
    expect(moved).toEqual([
      expect.objectContaining({
        logicalName: 'synthetic-core',
        status: 'moved',
        cleanMove: true
      })
    ]);

    const orphaned = await reconcileProject(manifest, [], root);
    expect(orphaned).toEqual([
      expect.objectContaining({
        logicalName: 'synthetic-core',
        status: 'orphan'
      })
    ]);

    await mkdir(path.join(root, 'current'), { recursive: true });
    await writeFile(path.join(root, 'current', 'policy.md'), 'occupied\n');
    const occupied = await reconcileProject(manifest, render, root);
    expect(occupied).toEqual([
      expect.objectContaining({
        logicalName: 'synthetic-core',
        status: 'moved',
        cleanMove: false,
        destinationOccupied: true
      })
    ]);
  });
});
