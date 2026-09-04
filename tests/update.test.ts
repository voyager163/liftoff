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
import { compareSemver } from '../src/semver.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import {
  governanceArtifactPaths,
  renderCanonicalGovernancePolicy
} from '../src/repository-governance.js';
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
  runner?: CommandRunner
): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    ...(runner ? { runner } : {})
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
  governanceArtifactPaths.alias['github-copilot'],
  governanceArtifactPaths.alias.claude
] as const;

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
      entry.logicalName.startsWith('repository-governance-') ||
      entry.logicalName.startsWith('liftoff-setup-')
    )).toBe(true);

    expect((await run(['update'], root)).code).toBe(0);
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.artifactVersion).toBe(7);
    expect(manifest.managedArtifacts.every((artifact: { logicalName: string }) =>
      artifact.logicalName.startsWith('repository-governance-') ||
      artifact.logicalName.startsWith('liftoff-setup-')
    )).toBe(true);
    expect(manifest.projectArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'backend-main'
    )).toBe(true);
  });

  it('preserves an unrecorded governance launcher conflict as a partial handoff', async () => {
    const root = await fixtureProject();
    await removeGovernanceMetadata(root);
    const launcherPath = path.join(
      root,
      ...governanceArtifactPaths.alias['github-copilot']
    );
    await mkdir(path.dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, 'developer launcher\n');

    expect((await run(['update'], root)).code).toBe(0);
    let manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance.state).toBe('handoff-partial');
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'repository-governance-copilot-launcher'
    )).toBe(false);
    expect(await readFile(launcherPath, 'utf8')).toBe('developer launcher\n');

    await rm(launcherPath);
    expect((await run(['update'], root)).code).toBe(0);
    manifest = JSON.parse(
      await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8')
    );
    expect(manifest.governance.state).toBe('handoff-generated');
    expect(manifest.managedArtifacts.some((artifact: { logicalName: string }) =>
      artifact.logicalName === 'repository-governance-copilot-launcher'
    )).toBe(true);
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
      config.environments = ['dev', 'test'];
    });
    expect((await run(['update'], root)).code).toBe(0);

    const backendEnv = path.join(root, 'environments', 'test', 'backend.env');
    const tfvars = path.join(
      root,
      'infrastructure',
      'opentofu',
      'azure',
      'environments',
      'test.tfvars'
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
      config.environments = ['dev', 'test'];
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
