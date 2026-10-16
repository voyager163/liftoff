import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../../../src/application/project/manifest.js';
import { writeGovernanceApprovalAuthority } from '../../../src/governance-activation/authority-records.js';
import {
  activationEvidenceContexts, approvalRequestForSavedPlan, canonicalPhaseGraph, canonicalPhaseGraphHash, canonicalSha256,
  currentActivationIdentity, phaseIds, readActivationInputSnapshot, type ActivationConfiguration, type ApprovalEnvelope,
  type GovernanceSourceOfTruthInspection, type GovernanceTransitionInspection, type PhaseEvidenceRecord, type PhaseId,
  type SavedTransitionPlan, type UserActivationState
} from '../../../src/governance-activation/index.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions } from '../../../src/process-runner.js';
import { renderCanonicalGovernancePolicy } from '../../../src/repository-governance.js';
import type { ExternalCommand, LiftoffManifest } from '../../../src/types.js';
import { liftoffVersion } from '../../../src/version.js';
import { writeIndependentInfrastructureFixture } from '../../governance-activation-fixtures.js';

export const coverageNow = new Date('2026-09-04T00:00:00.000Z');
export const coverageSubscription = '00000000-0000-4000-8000-000000000001';
export const coverageTenant = '00000000-0000-4000-8000-000000000002';
export const coveragePrincipal = '00000000-0000-4000-8000-000000000003';
export const coverageRemoteBinding = {
  id: 'R_REMOTE', name: 'owner/repo', defaultBranch: 'develop', pushUrl: 'https://github.com/owner/repo.git',
  verifiedAt: '2026-09-03T00:00:00.000Z'
};

export function scratchDirectory(label: string): string {
  return path.join(process.cwd(), '.cache', 'governance-coverage', `${label}-${process.pid}`);
}

/**
 * Redirects user-local approval/preview records to a disposable directory outside every repository,
 * so tests never read or write the developer's real profile.
 */
export async function isolateUserLocalStorage(): Promise<{ root: string; restore: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-governance-coverage-')));
  const keys = ['HOME', 'USERPROFILE', 'XDG_STATE_HOME', 'LOCALAPPDATA'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = path.join(root, 'home');
  process.env.USERPROFILE = path.join(root, 'home');
  process.env.XDG_STATE_HOME = path.join(root, 'state');
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
  return {
    root,
    restore: async () => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await rm(root, { recursive: true, force: true });
    }
  };
}

/** Lists user-local record files (for example governance-approval-*) below an isolated storage root. */
export async function userLocalRecordNames(root: string): Promise<string[]> {
  const names: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(current, entry.name));
      else names.push(entry.name);
    }
  }
  await visit(root);
  return names.sort();
}

/** Simulates authority issued before this release: an approval file plus its project-bound user-local record. */
export async function issuePriorApproval(root: string, state: UserActivationState, plan: SavedTransitionPlan): Promise<ApprovalEnvelope> {
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === plan.phaseId)!;
  const envelope: ApprovalEnvelope = {
    ...approvalRequestForSavedPlan(plan, phase, state),
    schemaVersion: currentActivationIdentity.approvalEnvelopeSchemaVersion,
    id: `${plan.phaseId}-prior-approval`,
    approvedAt: coverageNow.toISOString(),
    expiresAt: new Date(coverageNow.getTime() + 10 * 60_000).toISOString(),
    approver: 'owner'
  };
  await mkdir(path.join(root, 'governance', 'approvals'), { recursive: true });
  await writeFile(path.join(root, 'governance', 'approvals', `${envelope.id}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
  await writeGovernanceApprovalAuthority(root, canonicalSha256({ priorApproval: envelope.id }), envelope);
  return envelope;
}

export class ProviderContactError extends Error {}

/** Local Git is allowed; any GitHub/Azure CLI call or network Git command fails the test. */
export class LocalOnlyRunner implements CommandRunner {
  readonly providerCalls: ExternalCommand[] = [];
  private readonly native = new NodeCommandRunner();

  constructor(private readonly gitEnvironment: NodeJS.ProcessEnv) {}

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (['gh', 'az', 'tofu', 'terraform'].includes(command.executable) ||
      command.executable === 'git' && ['push', 'ls-remote', 'fetch', 'pull', 'clone'].includes(command.args[0]!)) {
      this.providerCalls.push(command);
      throw new ProviderContactError(`Provider access is forbidden in coverage tests: ${command.executable} ${command.args[0] ?? ''}`);
    }
    return this.native.run(command, {
      ...options,
      ...(command.executable === 'git' ? { env: { ...options?.env, ...this.gitEnvironment } } : {})
    });
  }
}

/** Local runner plus the bounded Azure identity/resource reads for an independently absent environment. */
export class AbsentAzureEnvironmentRunner implements CommandRunner {
  readonly azureCalls: ExternalCommand[] = [];
  readonly local: LocalOnlyRunner;

  constructor(gitEnvironment: NodeJS.ProcessEnv) {
    this.local = new LocalOnlyRunner(gitEnvironment);
  }

  get providerCalls(): readonly ExternalCommand[] {
    return this.local.providerCalls;
  }

  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable !== 'az') return this.local.run(command, options);
    this.azureCalls.push(command);
    const key = command.args.join(' ');
    const success = (value: unknown): CommandResult => ({
      command,
      displayCommand: [command.executable, ...command.args].join(' '),
      status: 0,
      signal: null,
      stdout: JSON.stringify(value),
      stderr: '',
      timedOut: false
    });
    if (key.startsWith('account show ')) return success({
      id: coverageSubscription,
      tenantId: coverageTenant,
      state: 'Enabled',
      environmentName: 'AzureCloud',
      user: { type: 'user', name: 'developer@example.test' }
    });
    if (key.startsWith('cloud show ')) return success({
      name: 'AzureCloud',
      resourceManager: 'https://management.azure.com/',
      resourceManagerAudience: 'https://management.core.windows.net/'
    });
    if (key.startsWith('rest --method GET ')) return success({
      subscriptionId: coverageSubscription,
      tenantId: coverageTenant,
      state: 'Enabled'
    });
    if (key.startsWith('ad signed-in-user show ')) return success({
      id: coveragePrincipal,
      userPrincipalName: 'developer@example.test'
    });
    if (key.startsWith('group exists ')) return success(false);
    throw new Error(`Unexpected Azure ownership command: ${key}`);
  }
}

export async function isolatedGitEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const config = path.join(root, 'empty.gitconfig');
  await mkdir(root, { recursive: true });
  await writeFile(config, '');
  return {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: ''
  };
}

export function coverageManifest(projectName: string): LiftoffManifest {
  return {
    artifactVersion: 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name: projectName,
      workload: {
        kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus', frontend: false, environments: ['dev']
      },
      specWorkflow: 'openspec',
      agents: ['github-copilot']
    },
    framework: { state: 'initialized', adapter: 'openspec', contractVersion: '1.11.0' },
    governance: {
      profile: 'single-maintainer-gitflow', policyVersion: '6', activationIdentity: currentActivationIdentity, state: 'handoff-partial'
    },
    managedArtifacts: [{
      logicalName: 'repository-governance-policy', category: 'governance',
      pathParts: ['.liftoff', 'governance', 'policy.md'], contentHash: `sha256:${'a'.repeat(64)}`
    }],
    projectArtifacts: []
  };
}

async function writeSeed(root: string, projectName: string): Promise<void> {
  const capability = 'node-fastify-application-baseline';
  const base = path.join(root, 'openspec', 'changes', `bootstrap-${projectName}`);
  await mkdir(path.join(base, 'specs', capability), { recursive: true });
  await writeFile(path.join(base, '.openspec.yaml'), 'schema: spec-driven\n', 'utf8');
  await writeFile(path.join(base, 'proposal.md'), `## Capabilities\n\n### New Capabilities\n\n- \`${capability}\`: generated baseline\n`, 'utf8');
  await writeFile(path.join(base, 'design.md'), '## Context\nGenerated baseline only.\n', 'utf8');
  await writeFile(path.join(base, 'specs', capability, 'spec.md'), '## ADDED Requirements\n\n### Requirement: Baseline exists\n', 'utf8');
  await writeFile(path.join(base, 'tasks.md'), '- [ ] 1.1 Confirm files\n- [ ] 2.1 Run Liftoff manifest validation\n', 'utf8');
}

export async function writeCoverageProject(root: string, projectName = 'coverage'): Promise<string> {
  await mkdir(path.join(root, '.liftoff', 'governance'), { recursive: true });
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify(coverageManifest(projectName), null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, '.liftoff', 'governance', 'policy.md'), renderCanonicalGovernancePolicy(), 'utf8');
  await writeIndependentInfrastructureFixture(root);
  await writeSeed(root, projectName);
  return root;
}

export function coverageActivationInputs(): ActivationConfiguration {
  return {
    schemaVersion: 1,
    phases: {
      'state-path-selected': {
        statePath: 'existing-private',
        resourceGroup: 'rg-liftoff-state',
        storageAccount: 'stliftoffstate',
        container: 'tfstate',
        key: 'coverage/dev/terraform.tfstate',
        principalId: coveragePrincipal
      }
    },
    azure: { subscriptionId: coverageSubscription, tenantId: coverageTenant, region: 'eastus' }
  };
}

export function coverageState(overrides: Partial<UserActivationState> = {}): UserActivationState {
  return {
    schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
    identity: currentActivationIdentity,
    repository: { id: 'R_123', name: 'owner/repo', defaultBranch: 'develop' },
    activeChange: null,
    remoteBinding: { ...coverageRemoteBinding },
    applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: false },
    phases: Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
      state: 'pending', updatedAt: coverageNow.toISOString(), evidence: [], approvals: [], blockers: []
    }])) as unknown as UserActivationState['phases'],
    createdAt: coverageNow.toISOString(),
    updatedAt: coverageNow.toISOString(),
    ...overrides
  };
}

export function selectedSource(): GovernanceSourceOfTruthInspection {
  return {
    status: 'selected',
    selected: {
      changeId: 'governance-demo', workflowKind: 'openspec',
      pathParts: ['openspec', 'changes', 'governance-demo'], status: 'compatible', issues: []
    },
    candidates: [],
    recordActiveChangeOnNextMutation: false,
    reconciliation: { status: 'not-required', approvalRequired: false, preservedPhaseIds: phaseIds, invalidPhaseIds: [], issues: [] },
    supersession: { records: [], invalidRecords: [], selectedChangeId: null, issues: [] }
  };
}

export async function coverageInspection(input: {
  root: string;
  phaseId: PhaseId;
  state: UserActivationState;
  approvals?: readonly ApprovalEnvelope[];
  evidence?: readonly PhaseEvidenceRecord[];
  reviewedPlans?: readonly SavedTransitionPlan[];
  activationInputs?: ActivationConfiguration;
  source?: GovernanceSourceOfTruthInspection;
  scope?: GovernanceTransitionInspection['scope'];
}): Promise<GovernanceTransitionInspection> {
  const manifest = await loadManifest(input.root);
  const contexts = activationEvidenceContexts(
    canonicalPhaseGraph, input.state, await readActivationInputSnapshot(input.root, manifest), coverageNow
  );
  for (const phase of phaseIds) contexts[phase].reviewedPlans = [...input.reviewedPlans ?? []];
  return {
    projectRoot: input.root,
    manifest,
    graph: canonicalPhaseGraph,
    graphHash: canonicalPhaseGraphHash,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.activationInputs ? { activationInputs: input.activationInputs } : {}),
    state: input.state,
    approvals: input.approvals ?? [],
    evidence: input.evidence ?? [],
    contexts,
    readiness: {
      nextReadyPhase: input.phaseId,
      phases: Object.fromEntries(phaseIds.map((phaseId) => [phaseId, {
        state: phaseId === input.phaseId ? 'ready' : 'blocked', blockers: []
      }])) as unknown as GovernanceTransitionInspection['readiness']['phases']
    },
    sourceOfTruth: input.source ?? selectedSource()
  };
}

/** Content fingerprint of every file below root, used to prove refused operations wrote nothing. */
export async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      hash.update(childRelative);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) hash.update(await readFile(child));
    }
  }
  await visit(root, '');
  return hash.digest('hex');
}

export async function readState(root: string): Promise<UserActivationState | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, 'governance', 'activation-state.json'), 'utf8')) as UserActivationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function resetDirectory(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}
