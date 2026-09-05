import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
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
import {
  canonicalJson,
  createActivationIdentity,
  currentActivationIdentity,
  phaseIds,
  renderGovernanceChangeWritePlan,
  type UserActivationState
} from '../src/governance-activation/index.js';
import {
  CaptureStream,
  scriptedTtyInput,
  ttyCaptureStream
} from './helpers.js';

const sha = (content: string) =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
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

async function powerAppsFixtureProject(codeAppsPlugin = false): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Power Apps Update App',
    projectType: 'power-apps-code-app',
    specWorkflow: 'openspec',
    agents: ['copilot'],
    codeAppsPlugin
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
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    ...(runner ? { runner } : {}),
    ...(env ? { env } : {})
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function runInteractive(
  args: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string }> {
  const stdout = ttyCaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdin: scriptedTtyInput(''),
    stdout,
    stderr
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

class TriggerCaptureStream extends CaptureStream {
  private triggered = false;

  constructor(
    private readonly trigger: string,
    private readonly action: () => void
  ) {
    super();
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const value = String(chunk);
    this.chunks.push(value);
    if (this.triggered || !value.includes(this.trigger)) {
      callback();
      return;
    }
    this.triggered = true;
    try {
      this.action();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
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

    const result = await run(['update'], root);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Liftoff core is current');
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
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
      schemaVersion: 2,
      mode: 'check',
      scope: 'managed-core',
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
    expect((await run(['update', '--check', '--json'], root, authorityRunner)).code).toBe(0);
    expect((await run(['update', '--force', '--json'], root, authorityRunner)).code).toBe(0);
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
      schemaVersion: 2,
      scope: 'managed-core',
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
    expect(skipped.out).toContain('Skipped Liftoff core conflicts');
    expect(await readFile(policyPath, 'utf8')).toBe('# local governance policy\n');

    const forced = await run(['update', '--force'], root);
    expect(forced.code).toBe(0);
    expect(await readFile(policyPath, 'utf8')).toBe(currentPolicy);
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
      schemaVersion: 2,
      mode: 'check',
      scope: 'managed-core',
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
    expect(check.out).toContain('Unowned destinations remain protected');
    expect(check.out).toContain('--force cannot overwrite it');
    expect(check.out).not.toContain('liftoff update --force');
    for (const args of [['update'], ['update', '--force']]) {
      const applied = await run(args, root);
      expect(applied.code).toBe(0);
      expect(applied.out).toContain('protected unowned destination');
      expect(applied.out).toContain('--force cannot overwrite it');
      expect(applied.out).not.toContain('use --force to overwrite');
      expect(await readFile(path.join(root, ...identity.pathParts), 'utf8')).toBe(custom);
      expect((await loadManifest(root)).managedArtifacts.some((entry) =>
        entry.logicalName === identity.logicalName
      )).toBe(false);
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
    expect(check.out).toContain('liftoff update --force');
    expect(check.out).toContain('Unowned destinations remain protected');
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
    await writeProjectOwnedFile(root, evidence, '{\r\n  "userOwned": true\r\n}\r\n');
    const protectedPaths = [...active.paths, evidence];
    const before = await pathFingerprints(root, protectedPaths);
    const managed = (await loadManifest(root)).managedArtifacts.map((entry) => entry.pathParts);
    const rollbackPaths = [['liftoff.manifest.json'], ...managed, ...protectedPaths];
    const rollbackBefore = await pathFingerprints(root, rollbackPaths);

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(2);
    expect(await pathFingerprints(root, rollbackPaths)).toEqual(rollbackBefore);
    const failed = await run(
      ['update', '--json'],
      root,
      undefined,
      { ...process.env, LIFTOFF_UPDATE_INJECT_FAILURE: 'before-path:liftoff.manifest.json' }
    );
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('All applied changes were rolled back');
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
    expect(failed.err).toContain('All applied changes were rolled back');
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
      ['infrastructure', 'opentofu', 'azure', 'environments', 'dev.tfvars']
    ];
    const before = await pathFingerprints(root, watched);

    for (const args of [['update'], ['update', '--force']]) {
      const result = await run(args, root);
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
      const result = await run(args, root);
      expect(result.code).toBe(1);
      expect(result.err).toContain('cannot be disabled');
      expect(result.err).toContain('separately supported deactivation');
      expect(result.err).toContain('does not infer deactivation');
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
      schemaVersion: 2,
      entries: [],
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
      schemaVersion: 2,
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

  it('records a Power Apps plugin preference without rewriting project guidance', async () => {
    const root = await powerAppsFixtureProject(false);
    const readmePath = path.join(root, 'README.md');
    const readme = '# production Power Apps guidance\n';
    await writeFile(readmePath, readme);
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.codeAppsPlugin = true;
    });

    expect((await run(['update'], root)).code).toBe(0);
    expect(await readFile(readmePath, 'utf8')).toBe(readme);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.project.workload.codeAppsPlugin).toBe(true);
  });

  it('ignores Power Apps starter and dependency edits during ordinary checks', async () => {
    const root = await powerAppsFixtureProject(false);
    const packagePath = path.join(root, 'package.json');
    const appPath = path.join(root, 'src', 'App.tsx');
    const packageContent = '{"name":"production-power-app","private":true}\n';
    const appContent = 'export default function App() { return null; }\n';
    await writeFile(packagePath, packageContent);
    await writeFile(appPath, appContent);

    const check = await run(['update', '--check', '--json'], root);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.out).entries).toEqual([]);
    expect((await run(['update', '--force'], root)).code).toBe(0);
    expect(await readFile(packagePath, 'utf8')).toBe(packageContent);
    expect(await readFile(appPath, 'utf8')).toBe(appContent);
  });

  it('keeps check mode read-only and versions JSON around managed-core scope', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const policyPath = path.join(root, ...governanceArtifactPaths.policy);
    await writeFile(policyPath, '# local policy\n');
    const before = await readFile(manifestPath, 'utf8');

    const result = await run(['update', '--check', '--json'], root);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: 2,
      mode: 'check',
      scope: 'managed-core',
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
    await writeProjectOwnedFile(root, ['governance', 'evidence', 'manual-evidence.json'], '{"user":"evidence"}\n');
    await writeProjectOwnedFile(root, ['governance', 'approvals', 'manual-approval.json'], '{"user":"approval"}\n');
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
    expect(check.code).toBe(2);
    expect(await pathFingerprints(root, userFiles)).toEqual(before);

    const applied = await run(['update', '--force', '--json'], root);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.out).written).toContain('.liftoff/governance/policy.md');
    expect(await pathFingerprints(root, userFiles)).toEqual(before);
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

    const result = await run(['update', '--json'], root);

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

    const result = await run(['update', '--json'], root);

    expect(result.code).toBe(1);
    expect(result.err).toContain('explicit compatibility map');
    expect(result.err).toContain('recognized graph hashes');
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('rejects unsafe identity changes before mutation', async () => {
    const root = await standardFixtureProject('go');
    const sourcePath = path.join(root, 'backend', 'internal', 'api', 'api.go');
    const source = await readFile(sourcePath, 'utf8');
    await editJson(path.join(root, 'liftoff.config.json'), (config) => {
      config.apiStack = 'node-fastify';
    });

    const result = await run(['update', '--force'], root);
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

      const result = await run(['update', '--force'], root);
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

    const result = await run(['update'], root);
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
    const stdout = new TriggerCaptureStream(
      'Apply safe Liftoff core changes',
      () => writeFileSync(policyPath, '# concurrent policy\n')
    );
    const stderr = new CaptureStream();

    const code = await runCommand(parseArgs(['update']), {
      cwd: root,
      stdout,
      stderr
    });

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
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-reconcile-'));
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
