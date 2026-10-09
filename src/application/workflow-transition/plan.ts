import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  assertBoundProjectPath,
  readBoundProjectFileDigest,
  readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import {
  inspectWorkflowTransitionTransactionCandidate,
  workflowTransitionTransactionPathParts
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  createScopedUserLocalRecordStore,
  type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  validateStagedTree,
  withStagingArea,
  type StagingArea
} from '../../init-filesystem.js';
import type {
  ProjectFileMutation,
  ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  canonicalJson,
  canonicalSha256,
  isRecord
} from '../../domain/governance/activation/canonical-json.js';
import {
  specKitBootstrapId
} from '../../domain/governance/activation/local-check-values.js';
import type {
  CodingAgentId,
  CurrentProjectPlan,
  ProjectPlan
} from '../../domain/project/contracts.js';
import {
  governanceAgentIntegrations,
  projectAssessmentAgentIntegrations
} from '../../domain/project/catalog.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  readManifestPluginMetadata
} from '../../domain/project/manifest/plugins.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { PlanValidationError } from '../../domain/project/planning.js';
import {
  buildOpenSpecInitCommand,
  buildSpecKitDefaultCommand,
  buildSpecKitIntegrationInstallCommand,
  executeFrameworkCommands,
  initializeFramework
} from '../../framework-adapters.js';
import {
  frameworkIntegrationPaths,
  frameworkOutputPaths,
  OPEN_SPEC_CODEX_TARGET_PATH,
  SPEC_KIT_CODEX_CONFIG_PATH
} from '../../framework-validation.js';
import { renderLiftoffConfig } from '../../generators/common/base.js';
import {
  NodeCommandRunner,
  type CommandRunner,
  type RunCommandOptions
} from '../../process-runner.js';
import type {
  WorkstationNoProgressStore,
  WorkstationProbeOptions
} from '../../workstation.js';
import { projectCatalog } from '../project/catalog.js';
import { buildCurrentProjectPlan } from '../project/planning.js';
import {
  createManifestV8Candidate,
  type ManagedManifestDecision
} from '../project/manifest-writer.js';
import {
  buildModernManagedCore
} from '../project/modern-managed-core.js';
import {
  parseProjectManifest
} from '../project/manifest.js';
import { composeModernManifestPlugins } from '../project/plugins.js';
import {
  prepareWorkflowTransitionEnvironment,
  type WorkflowTransitionPreparationOptions,
  type WorkflowTransitionPreparationReport
} from './preparation.js';

export const workflowTransitionPlanSchemaVersion = 3 as const;
export const workflowTransitionPlanLifetimeMs = 30 * 60 * 1000;

export type WorkflowTransitionTarget = 'openspec' | 'spec-kit' | 'manual';

export interface WorkflowTransitionInput {
  readonly pathParts: readonly string[];
  readonly present: boolean;
  readonly digest: string | null;
  readonly bytes: number | null;
  readonly mode: number | null;
}

export type WorkflowTransitionFrameworkInventory =
  | {
      readonly status: 'not-applicable';
      readonly workflow: 'manual';
      readonly roots: readonly (readonly string[])[];
      readonly activeWork: {
        readonly identifiers: readonly string[];
        readonly reconciliation: 'not-applicable';
      };
      readonly fileCount: 0;
      readonly directoryCount: 0;
      readonly totalBytes: 0;
      readonly digest: null;
    }
  | {
      readonly status: 'preserved';
      readonly workflow: 'openspec' | 'spec-kit';
      readonly roots: readonly (readonly string[])[];
      readonly activeWork: {
        readonly identifiers: readonly string[];
        readonly reconciliation:
          'preserve-on-disk-as-non-authoritative';
      };
      readonly fileCount: number;
      readonly directoryCount: number;
      readonly totalBytes: number;
      readonly digest: string;
    }
  | {
      readonly status: 'unavailable';
      readonly workflow: 'openspec' | 'spec-kit';
      readonly roots: readonly (readonly string[])[];
      readonly activeWork: {
        readonly identifiers: readonly string[];
        readonly reconciliation: 'unavailable';
      };
      readonly fileCount: 0;
      readonly directoryCount: 0;
      readonly totalBytes: 0;
      readonly digest: null;
    };

export type WorkflowTransitionTargetFrameworkInventory =
  | Extract<
      WorkflowTransitionFrameworkInventory,
      { readonly status: 'not-applicable' | 'preserved' }
    >
  | {
      readonly status: 'absent';
      readonly workflow: 'openspec' | 'spec-kit';
      readonly roots: readonly (readonly string[])[];
      readonly activeWork: {
        readonly identifiers: readonly string[];
        readonly reconciliation: 'no-existing-history';
      };
      readonly fileCount: 0;
      readonly directoryCount: 0;
      readonly totalBytes: 0;
      readonly digest: null;
    };

export interface WorkflowTransitionPlanReport {
  readonly schemaVersion: 2 | 3;
  readonly kind: 'liftoff-workflow-transition-plan';
  readonly operation: 'workflow-transition' | 'agent-repair';
  readonly repairAgents: readonly CodingAgentId[];
  readonly projectRoot: string;
  readonly source: {
    readonly workflow: WorkflowTransitionTarget;
    readonly agents: readonly CodingAgentId[];
    readonly defaultAgent: CodingAgentId | null;
    readonly frameworkState: 'not-required' | 'legacy' | 'initialized';
    readonly frameworkContractVersion: string | null;
  };
  readonly target: {
    readonly workflow: WorkflowTransitionTarget;
    readonly agents: readonly CodingAgentId[];
    readonly defaultAgent: CodingAgentId | null;
    readonly frameworkState: 'not-required' | 'initialization-required';
    readonly pluginResolutionDigest: string;
  };
  readonly governanceProfile:
    | 'none'
    | 'single-maintainer-gitflow'
    | 'team-gitflow';
  readonly inputs: readonly WorkflowTransitionInput[];
  readonly frameworkInventory: WorkflowTransitionFrameworkInventory;
  readonly targetFrameworkInventory:
    WorkflowTransitionTargetFrameworkInventory;
  readonly preparation: WorkflowTransitionPreparationReport;
  readonly checks: readonly {
    readonly id:
      | 'source-inputs-current'
      | 'source-history-preserved'
      | 'active-work-reconciled'
      | 'target-framework-staged'
      | 'target-integrations-verified';
    readonly status: 'required' | 'not-applicable';
  }[];
  readonly applicationFiles: 'preserved';
  readonly gitHistory: 'preserved';
  readonly frameworkHistory: 'preserved';
  readonly execution:
    | {
        readonly status: 'not-required' | 'unavailable';
      }
    | WorkflowTransitionExecutionReport;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface WorkflowTransitionEffect {
  readonly logicalName: string;
  readonly kind:
    | 'managed-core'
    | 'desired-state'
    | 'framework'
    | 'repository-placeholder'
    | 'manifest';
  readonly operation: 'write' | 'delete';
  readonly pathParts: readonly string[];
  readonly contentDigest: string | null;
  readonly contentBytes: number | null;
  readonly mode: number | null;
}

export interface WorkflowTransitionExecutionReport {
  readonly status: 'ready-for-file-approval';
  readonly transition:
    | 'external-framework-to-manual'
    | 'manual-to-external-framework'
    | 'external-framework-to-external-framework'
    | 'agent-integration-repair';
  readonly preconditionDigest: string;
  readonly preconditionCount: number;
  readonly transactionCandidateBinding: string;
  readonly transactionCandidateDigest: string;
  readonly transactionSize: {
    readonly mutationCount: number;
    readonly suppliedPreconditionCount: number;
    readonly snapshotBytes: number;
    readonly completeJournalBytes: number;
  };
  readonly effects: readonly WorkflowTransitionEffect[];
  readonly manifestPublishedLast: true;
  readonly frameworkDocuments:
    | 'preserved-on-disk'
    | 'official-staged-with-existing-history-preserved'
    | 'official-integration-staged-with-history-preserved';
  readonly sharedTools: 'unchanged';
  readonly targetLocalReadiness:
    | 'manual-native-framework-inapplicable'
    | 'official-framework-initialized'
    | 'agent-integrations-verified';
  readonly officialStage: null | {
    readonly commands: readonly string[];
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly digest: string;
  };
  readonly targetFrameworkCommitInventory:
    WorkflowTransitionFrameworkInventory | null;
  readonly recovery: {
    readonly transactionKind: 'workflow-transition';
    readonly journalPathParts: readonly string[];
    readonly selectedBy:
      'plan-fingerprint-and-observed-transaction-digest';
  };
}

export interface WorkflowTransitionExecutionCandidate {
  readonly report: WorkflowTransitionExecutionReport;
  readonly mutations: readonly ProjectFileMutation[];
  readonly preconditions: readonly ProjectFileSnapshot[];
}

export class WorkflowTransitionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTransitionPlanError';
  }
}

const maximumInputBytes = 2 * 1024 * 1024;
const maximumFrameworkFileBytes = 8 * 1024 * 1024;
const maximumFrameworkBytes = 64 * 1024 * 1024;
const maximumFrameworkFiles = 4096;
const maximumFrameworkDirectories = 1024;
const maximumFrameworkDirectoryEntries = 1024;

function fileSystemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function frameworkRoots(
  workflow: WorkflowTransitionTarget
): readonly (readonly string[])[] {
  return workflow === 'openspec'
    ? Object.freeze([Object.freeze(['openspec'])])
    : workflow === 'spec-kit'
      ? Object.freeze([
          Object.freeze(['.specify']),
          Object.freeze(['specs'])
        ])
      : Object.freeze([]);
}

function unavailableFrameworkInventory(
  workflow: 'openspec' | 'spec-kit'
): WorkflowTransitionPlanReport['frameworkInventory'] {
  return Object.freeze({
    status: 'unavailable',
    workflow,
    roots: Object.freeze([]),
    activeWork: Object.freeze({
      identifiers: Object.freeze([]),
      reconciliation: 'unavailable'
    }),
    fileCount: 0,
    directoryCount: 0,
    totalBytes: 0,
    digest: null
  });
}

async function inspectFrameworkInventory(
  projectRoot: string,
  workflow: WorkflowTransitionTarget
): Promise<WorkflowTransitionFrameworkInventory> {
  if (workflow === 'manual') {
    return Object.freeze({
      status: 'not-applicable',
      workflow,
      roots: Object.freeze([]),
      activeWork: Object.freeze({
        identifiers: Object.freeze([]),
        reconciliation: 'not-applicable'
      }),
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      digest: null
    });
  }
  const roots = frameworkRoots(workflow);
  const pending = roots.map(parts => [...parts]);
  const directories: {
    pathParts: string[];
    mode: number;
    entries: { name: string; kind: 'file' | 'directory' }[];
  }[] = [];
  const files: {
    pathParts: readonly string[];
    bytes: number;
    mode: number;
    digest: string;
  }[] = [];
  const activeWork: string[] = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    if (directories.length >= maximumFrameworkDirectories) {
      invalid('Framework preservation inventory exceeds its directory bound.');
    }
    const pathParts = pending.shift()!;
    await assertBoundProjectPath(projectRoot, pathParts, {
      pathLabel: `workflow framework inventory ${pathParts.join('/')}`,
      invalid
    });
    const absolute = path.join(projectRoot, ...pathParts);
    let before;
    try {
      before = await lstat(absolute, { bigint: true });
    } catch (error) {
      if (fileSystemCode(error) === 'ENOENT') {
        invalid(
          `Initialized ${workflow} framework root ${pathParts.join('/')} is absent.`
        );
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      invalid(
        `Framework preservation root ${pathParts.join('/')} must be a regular directory.`
      );
    }
    const observed = await readdir(absolute, { withFileTypes: true });
    if (observed.length > maximumFrameworkDirectoryEntries) {
      invalid(
        `Framework directory ${pathParts.join('/')} exceeds its entry bound.`
      );
    }
    const aliases = new Set<string>();
    const entries = observed
      .map(entry => {
        const alias = entry.name.normalize('NFC').toLowerCase();
        if (aliases.has(alias)) {
          invalid(
            `Framework directory ${pathParts.join('/')} contains a case or Unicode collision.`
          );
        }
        aliases.add(alias);
        if (entry.isSymbolicLink() ||
            !entry.isFile() && !entry.isDirectory()) {
          invalid(
            `Framework preservation inventory does not permit links or special entries: ${[...pathParts, entry.name].join('/')}.`
          );
        }
        return {
          name: entry.name,
          kind: entry.isDirectory()
            ? 'directory' as const
            : 'file' as const
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const key = pathParts.join('/');
    if (workflow === 'openspec' && key === 'openspec/changes') {
      for (const entry of entries) {
        if (entry.name === 'archive') {
          if (entry.kind !== 'directory') {
            invalid('OpenSpec archive history must remain a regular directory.');
          }
        } else if (entry.kind !== 'directory') {
          invalid(
            `Unknown OpenSpec active work entry ${entry.name} requires explicit reconciliation.`
          );
        } else {
          activeWork.push(entry.name);
        }
      }
    }
    if (workflow === 'spec-kit' && key === 'specs') {
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          if (entry.name !== specKitBootstrapId) {
            activeWork.push(entry.name);
          }
          continue;
        }
        if (entry.name !== '.gitkeep') {
          invalid(
            `Unknown Spec Kit work entry ${entry.name} requires explicit reconciliation.`
          );
        }
      }
    }
    for (const entry of entries) {
      const child = [...pathParts, entry.name];
      if (entry.kind === 'directory') {
        pending.push(child);
        continue;
      }
      if (files.length >= maximumFrameworkFiles) {
        invalid('Framework preservation inventory exceeds its file bound.');
      }
      const snapshot = await readBoundProjectFileDigest(
        projectRoot,
        child,
        {
          maximumBytes: maximumFrameworkFileBytes,
          linkPolicy: 'single-link',
          diagnostics: {
            pathLabel: `workflow framework file ${child.join('/')}`,
            invalid
          }
        }
      );
      totalBytes += snapshot.bytes;
      if (totalBytes > maximumFrameworkBytes) {
        invalid('Framework preservation inventory exceeds its byte bound.');
      }
      files.push({
        pathParts: Object.freeze([...snapshot.pathParts]),
        bytes: snapshot.bytes,
        mode: snapshot.mode,
        digest: snapshot.digest
      });
    }
    const after = await lstat(absolute, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.mode !== before.mode || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs) {
      invalid(
        `Framework directory ${pathParts.join('/')} changed while being inventoried.`
      );
    }
    directories.push({
      pathParts: Object.freeze([...pathParts]) as string[],
      mode: Number(before.mode & 0o7777n),
      entries: Object.freeze(entries) as {
        name: string;
        kind: 'file' | 'directory';
      }[]
    });
  }
  directories.sort((left, right) =>
    left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en'));
  files.sort((left, right) =>
    left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en'));
  activeWork.sort((left, right) => left.localeCompare(right, 'en'));
  return Object.freeze({
    status: 'preserved',
    workflow,
    roots,
    activeWork: Object.freeze({
      identifiers: Object.freeze(activeWork),
      reconciliation: 'preserve-on-disk-as-non-authoritative'
    }),
    fileCount: files.length,
    directoryCount: directories.length,
    totalBytes,
    digest: canonicalSha256({
      schemaVersion: 1,
      kind: 'liftoff-workflow-framework-preservation-inventory',
      workflow,
      roots,
      directories,
      files
    })
  });
}

async function inspectTargetFrameworkInventory(
  projectRoot: string,
  workflow: WorkflowTransitionTarget
): Promise<WorkflowTransitionTargetFrameworkInventory> {
  if (workflow === 'manual') {
    const inventory = await inspectFrameworkInventory(
      projectRoot,
      workflow
    );
    if (inventory.status !== 'not-applicable') {
      invalid('Manual target framework inventory must be inapplicable.');
    }
    return inventory;
  }
  const roots = frameworkRoots(workflow);
  const present: boolean[] = [];
  for (const pathParts of roots) {
    await assertBoundProjectPath(projectRoot, pathParts, {
      pathLabel: `workflow target framework root ${pathParts.join('/')}`,
      invalid
    });
    try {
      const details = await lstat(path.join(projectRoot, ...pathParts));
      if (!details.isDirectory() || details.isSymbolicLink()) {
        invalid(
          `Target framework root ${pathParts.join('/')} must be a regular directory when present.`
        );
      }
      present.push(true);
    } catch (error) {
      if (fileSystemCode(error) !== 'ENOENT') throw error;
      present.push(false);
    }
  }
  if (present.every(value => !value)) {
    return Object.freeze({
      status: 'absent',
      workflow,
      roots,
      activeWork: Object.freeze({
        identifiers: Object.freeze([]),
        reconciliation: 'no-existing-history'
      }),
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      digest: null
    });
  }
  if (present.some(value => !value)) {
    invalid(
      `Existing ${workflow} history is incomplete; every framework root must be present or absent before transition.`
    );
  }
  const inventory = await inspectFrameworkInventory(projectRoot, workflow);
  if (inventory.status !== 'preserved') {
    invalid('Target framework history inventory is unavailable.');
  }
  if (inventory.activeWork.identifiers.length > 0) {
    invalid(
      `Active ${workflow} work overlaps the requested workflow transition: ${inventory.activeWork.identifiers.join(', ')}. Reconcile it before creating a new plan.`
    );
  }
  return inventory;
}

function invalid(message: string): never {
  throw new WorkflowTransitionPlanError(message);
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function inputReport(snapshot: ProjectFileSnapshot): WorkflowTransitionInput {
  return Object.freeze({
    pathParts: Object.freeze([...snapshot.pathParts]),
    present: snapshot.content !== undefined,
    digest: snapshot.content === undefined ? null : digest(snapshot.content),
    bytes: snapshot.content?.length ?? null,
    mode: snapshot.mode ?? null
  });
}

async function readInput(
  projectRoot: string,
  pathParts: readonly string[],
  required: boolean
): Promise<ProjectFileSnapshot> {
  const snapshot = await readBoundProjectFileSnapshot(projectRoot, pathParts, {
    maximumBytes: maximumInputBytes,
    linkPolicy: 'single-link',
    diagnostics: {
      pathLabel: `workflow transition input ${pathParts.join('/')}`,
      invalid
    }
  });
  if (required && snapshot.content === undefined) {
    invalid(`Workflow transition requires ${pathParts.join('/')}.`);
  }
  return snapshot;
}

function targetSelection(
  manifest: LiftoffManifestV8,
  target: WorkflowTransitionTarget,
  requestedAgents?: readonly string[],
  requestedDefaultAgent?: string,
  mode: 'replace' | 'additive' = 'replace'
) {
  const requested = requestedAgents === undefined
    ? []
    : projectCatalog.canonicalizeCodingAgents(
        requestedAgents.map(agent => agent.trim())
      ).agents.map(agent => agent.id);
  const canonicalDefault = requestedDefaultAgent === undefined
    ? undefined
    : projectCatalog.getCodingAgent(requestedDefaultAgent)?.id;
  if (requestedDefaultAgent !== undefined &&
      canonicalDefault === undefined) {
    invalid(
      `Unknown workflow default agent: ${requestedDefaultAgent.trim()}.`
    );
  }
  const existingAgents = new Set<string>(manifest.project.agents);
  const agents: string[] = mode === 'additive'
    ? [
        ...manifest.project.agents,
        ...requested.filter(agent =>
          !existingAgents.has(agent)
        ),
        ...(canonicalDefault &&
            !existingAgents.has(canonicalDefault) &&
            !requested.includes(canonicalDefault)
          ? [canonicalDefault]
          : [])
      ]
    : requestedAgents === undefined
      ? [...manifest.project.agents]
      : requested;
  const workload = manifest.project.workload;
  const profile = manifest.governance.profile;
  const plan = buildCurrentProjectPlan({
    projectName: manifest.project.name,
    projectType: workload.kind,
    apiStack: workload.apiStack,
    ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
    cloud: workload.cloud,
    region: workload.region,
    includeFrontend: workload.frontend,
    environments: [...workload.environments],
    specWorkflow: target,
    agents,
    ...(target === 'spec-kit'
      ? {
          defaultAgent: canonicalDefault ??
            (manifest.project.defaultAgent && agents.includes(manifest.project.defaultAgent)
              ? manifest.project.defaultAgent
              : agents.length === 1 ? agents[0] : undefined)
        }
      : {}),
    governanceProfile: profile
  }, { requireProjectName: true });
  const composition = composeModernManifestPlugins({
    workload: plan.workload,
    ...(plan.workload === 'genai' ? { variant: plan.pattern.id } : {}),
    stack: plan.apiStack.id,
    cloud: plan.provider.id,
    workflow: plan.specWorkflow.id,
    agents: plan.agents.map(agent => agent.id),
    frontend: plan.includeFrontend ? 'included' : 'omitted',
    governanceProfile: plan.governanceProfile.id,
    environments: plan.environments.map(environment => environment.id)
  }, { safeProjectName: plan.safeProjectName });
  const plugins = readManifestPluginMetadata({
    schemaVersion: 1,
    resolutionDigest: composition.resolution.digest,
    selections: composition.resolution.plugins
  }, {
    stack: plan.apiStack.id,
    cloud: plan.provider.id,
    workflow: plan.specWorkflow.id,
    agents: plan.agents.map(agent => agent.id)
  });
  const {
    specWorkflow: _sourceWorkflow,
    agents: _sourceAgents,
    defaultAgent: _sourceDefaultAgent,
    ...projectIdentity
  } = manifest.project;
  const selection = {
    project: {
      ...projectIdentity,
      specWorkflow: plan.specWorkflow.id,
      agents: plan.agents.map(agent => agent.id),
      ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {})
    },
    framework: plan.framework
      ? {
          state: 'initialized' as const,
          adapter: plan.framework.id,
          contractVersion: plan.framework.version
        }
      : { state: 'not-required' as const },
    profile
  };
  return {
    plan,
    plugins,
    selection,
    target: Object.freeze({
      workflow: target,
      agents: Object.freeze(plan.agents.map(agent => agent.id)),
      defaultAgent: plan.defaultAgent?.id ?? null,
      frameworkState: target === 'manual'
        ? 'not-required' as const
        : 'initialization-required' as const,
      pluginResolutionDigest: composition.resolution.digest
    })
  };
}

function snapshotDescriptor(snapshot: ProjectFileSnapshot) {
  return {
    pathParts: [...snapshot.pathParts],
    digest: snapshot.content === undefined ? null : digest(snapshot.content),
    mode: snapshot.mode ?? null
  };
}

function samePath(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return canonicalSha256(left) === canonicalSha256(right);
}

async function buildManualExecution(
  projectRoot: string,
  manifest: LiftoffManifestV8,
  manifestSnapshot: ProjectFileSnapshot,
  configSnapshot: ProjectFileSnapshot,
  selected: ReturnType<typeof targetSelection>
): Promise<WorkflowTransitionExecutionCandidate> {
  if (manifest.framework.state !== 'initialized' ||
      manifest.project.specWorkflow === 'manual' ||
      selected.target.workflow !== 'manual') {
    invalid(
      'Executable workflow transition requires an initialized external framework and an exact Manual target.'
    );
  }
  const activeLayout = manifest.activeLayout;
  const managed = buildModernManagedCore({
    selection: selected.selection,
    plugins: selected.plugins,
    activeLayout
  });
  const targetNames = new Set(managed.map(artifact => artifact.logicalName));
  const decisions: ManagedManifestDecision[] = [
    ...managed.map(artifact => ({
      kind: 'bytes' as const,
      logicalName: artifact.logicalName,
      category: artifact.category,
      pathParts: [...artifact.pathParts],
      content: artifact.content
    })),
    ...manifest.managedArtifacts
      .filter(artifact => !targetNames.has(artifact.logicalName))
      .map(artifact => ({
        kind: 'retire' as const,
        logicalName: artifact.logicalName
      }))
  ];
  const candidateManifest = createManifestV8Candidate({
    origin: 'workflow-transition',
    source: manifest,
    selection: selected.selection,
    activeLayout,
    managed: decisions
  });
  const configContent = `${renderLiftoffConfig(selected.plan)}\n`;
  const sourceByPath = new Map(
    manifest.managedArtifacts.map(artifact => [
      artifact.pathParts.join('/'),
      artifact
    ])
  );
  const targetByPath = new Map(
    managed.map(artifact => [artifact.pathParts.join('/'), artifact])
  );
  const managedPaths = new Map<string, readonly string[]>();
  for (const artifact of [
    ...manifest.managedArtifacts,
    ...managed
  ]) {
    managedPaths.set(artifact.pathParts.join('/'), artifact.pathParts);
  }
  const snapshots = new Map<string, ProjectFileSnapshot>([
    ['liftoff.manifest.json', manifestSnapshot],
    ['liftoff.config.json', configSnapshot]
  ]);
  for (const [key, pathParts] of managedPaths) {
    snapshots.set(key, await readInput(projectRoot, pathParts, false));
  }
  for (const artifact of manifest.managedArtifacts) {
    const snapshot = snapshots.get(artifact.pathParts.join('/'));
    if (!snapshot?.content ||
        `sha256:${digest(snapshot.content)}` !== artifact.contentHash) {
      invalid(
        `Managed workflow integration ${artifact.pathParts.join('/')} differs from its recorded Liftoff bytes; reconcile it before transition.`
      );
    }
  }
  for (const artifact of managed) {
    const key = artifact.pathParts.join('/');
    const snapshot = snapshots.get(key);
    if (!sourceByPath.has(key) && snapshot?.content !== undefined) {
      invalid(
        `Target workflow integration ${key} is occupied by a non-source file.`
      );
    }
  }
  const mutations: ProjectFileMutation[] = [];
  const identities: Array<Pick<
    WorkflowTransitionEffect,
    'logicalName' | 'kind' | 'operation' | 'pathParts'
  >> = [];
  for (const artifact of manifest.managedArtifacts
    .filter(source => !targetByPath.has(source.pathParts.join('/')))
    .sort((left, right) =>
      left.pathParts.join('/').localeCompare(right.pathParts.join('/')))) {
    mutations.push({
      type: 'delete',
      pathParts: [...artifact.pathParts]
    });
    identities.push({
      logicalName: artifact.logicalName,
      kind: 'managed-core',
      operation: 'delete',
      pathParts: [...artifact.pathParts]
    });
  }
  for (const artifact of [...managed].sort((left, right) =>
    left.pathParts.join('/').localeCompare(right.pathParts.join('/')))) {
    const snapshot = snapshots.get(artifact.pathParts.join('/'));
    if (snapshot?.content?.toString('utf8') === artifact.content) continue;
    mutations.push({
      type: 'write',
      pathParts: [...artifact.pathParts],
      content: artifact.content
    });
    identities.push({
      logicalName: artifact.logicalName,
      kind: 'managed-core',
      operation: 'write',
      pathParts: [...artifact.pathParts]
    });
  }
  if (configSnapshot.content?.toString('utf8') !== configContent) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.config.json'],
      content: configContent
    });
    identities.push({
      logicalName: 'liftoff-config',
      kind: 'desired-state',
      operation: 'write',
      pathParts: ['liftoff.config.json']
    });
  }
  if (manifestSnapshot.content?.toString('utf8') !==
      candidateManifest.content) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.manifest.json'],
      content: candidateManifest.content
    });
    identities.push({
      logicalName: 'manifest',
      kind: 'manifest',
      operation: 'write',
      pathParts: ['liftoff.manifest.json']
    });
  }
  if (mutations.length === 0 ||
      identities.at(-1)?.kind !== 'manifest' ||
      !samePath(mutations.at(-1)!.pathParts, ['liftoff.manifest.json'])) {
    invalid(
      'Executable Manual transition requires one exact final manifest mutation.'
    );
  }
  const preconditions = [...snapshots.values()];
  const transaction = await inspectWorkflowTransitionTransactionCandidate(
    projectRoot,
    mutations,
    preconditions
  );
  if (transaction.size.kind !== 'journal' ||
      transaction.payload.mutations.length !== mutations.length ||
      identities.length !== mutations.length) {
    invalid('Workflow transition transaction measurement is incomplete.');
  }
  const effects = identities.map((identity, index) => {
    const measured = transaction.payload.mutations[index]?.target;
    if (!measured) invalid('Workflow transition effect measurement is missing.');
    const write = identity.operation === 'write';
    if (write !== (measured.kind === 'file')) {
      invalid('Workflow transition effect operation differs from its measured target.');
    }
    return Object.freeze({
      ...identity,
      pathParts: Object.freeze([...identity.pathParts]),
      contentDigest: measured.kind === 'file' ? measured.sha256 : null,
      contentBytes: measured.kind === 'file'
        ? Buffer.byteLength(
            (mutations[index] as Extract<
              ProjectFileMutation, { type: 'write' }
            >).content
          )
        : null,
      mode: measured.kind === 'file' ? measured.mode : null
    });
  });
  const report: WorkflowTransitionExecutionReport = Object.freeze({
    status: 'ready-for-file-approval',
    transition: 'external-framework-to-manual',
    preconditionDigest: canonicalSha256(
      preconditions.map(snapshotDescriptor)
    ),
    preconditionCount: preconditions.length,
    transactionCandidateBinding: transaction.binding,
    transactionCandidateDigest: canonicalSha256(transaction.payload),
    transactionSize: Object.freeze({
      mutationCount: transaction.size.mutationCount,
      suppliedPreconditionCount:
        transaction.size.suppliedPreconditionCount,
      snapshotBytes: transaction.size.snapshotBytes,
      completeJournalBytes: transaction.size.completeJournalBytes
    }),
    effects: Object.freeze(effects),
    manifestPublishedLast: true,
    frameworkDocuments: 'preserved-on-disk',
    sharedTools: 'unchanged',
    targetLocalReadiness: 'manual-native-framework-inapplicable',
    officialStage: null,
    targetFrameworkCommitInventory: null,
    recovery: Object.freeze({
      transactionKind: 'workflow-transition',
      journalPathParts: Object.freeze([
        ...workflowTransitionTransactionPathParts
      ]),
      selectedBy:
        'plan-fingerprint-and-observed-transaction-digest'
    })
  });
  return Object.freeze({
    report,
    mutations: Object.freeze(mutations),
    preconditions: Object.freeze(preconditions)
  });
}

async function readFrameworkInput(
  projectRoot: string,
  pathParts: readonly string[]
): Promise<ProjectFileSnapshot> {
  return await readBoundProjectFileSnapshot(projectRoot, pathParts, {
    maximumBytes: maximumFrameworkFileBytes,
    linkPolicy: 'single-link',
    diagnostics: {
      pathLabel: `workflow target framework file ${pathParts.join('/')}`,
      invalid
    }
  });
}

interface TransitionFrameworkFile {
  readonly pathParts: readonly string[];
  readonly relativePath: string;
  readonly content: Buffer;
  readonly contentHash: string;
  readonly mode: number;
  readonly origin: 'official' | 'repository-placeholder';
}

function specKitRepositoryPlaceholder(
  workflow: WorkflowTransitionTarget,
  stagedFiles: readonly TransitionFrameworkFile[]
): TransitionFrameworkFile | null {
  if (workflow !== 'spec-kit' ||
      stagedFiles.some(file => file.pathParts[0] === 'specs')) {
    return null;
  }
  const content = Buffer.alloc(0);
  return Object.freeze({
    pathParts: Object.freeze(['specs', '.gitkeep']),
    relativePath: 'specs/.gitkeep',
    content,
    contentHash: digest(content),
    mode: process.platform === 'win32' ? 0o666 : 0o644,
    origin: 'repository-placeholder'
  });
}

async function buildTargetFrameworkCommitInventory(
  projectRoot: string,
  workflow: Exclude<WorkflowTransitionTarget, 'manual'>,
  targetInventory: WorkflowTransitionTargetFrameworkInventory,
  files: readonly TransitionFrameworkFile[],
  allowActiveWork = false
): Promise<WorkflowTransitionFrameworkInventory> {
  return await withStagingArea(async area => {
    if (targetInventory.status === 'preserved') {
      for (const pathParts of targetInventory.roots) {
        const destination = path.join(area.root, ...pathParts);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(
          path.join(projectRoot, ...pathParts),
          destination,
          {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            verbatimSymlinks: true
          }
        );
      }
      const copied = await inspectFrameworkInventory(area.root, workflow);
      if (canonicalJson(copied) !== canonicalJson(targetInventory)) {
        invalid(
          'Target framework history changed while preparing its commit inventory.'
        );
      }
    } else if (targetInventory.status !== 'absent') {
      invalid('External target commit inventory requires preserved or absent history.');
    }
    for (const file of files) {
      const destination = path.join(area.root, ...file.pathParts);
      await mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700
      });
      await writeFile(destination, file.content);
      await chmod(destination, file.mode);
    }
    const expected = await inspectFrameworkInventory(area.root, workflow);
    if (expected.status !== 'preserved' ||
        !allowActiveWork && expected.activeWork.identifiers.length > 0) {
      invalid(
        'Expected external target commit inventory is incomplete or contains active work.'
      );
    }
    return expected;
  });
}

async function buildExternalExecution(
  projectRoot: string,
  manifest: LiftoffManifestV8,
  manifestSnapshot: ProjectFileSnapshot,
  configSnapshot: ProjectFileSnapshot,
  selected: ReturnType<typeof targetSelection>,
  sourceInventory: WorkflowTransitionFrameworkInventory,
  targetInventory: WorkflowTransitionTargetFrameworkInventory,
  options: {
    readonly runner: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
    readonly onCommand?: (command: string) => void;
  }
): Promise<WorkflowTransitionExecutionCandidate> {
  if (!isExternalProjectPlan(selected.plan) ||
      selected.target.workflow === 'manual' ||
      selected.target.frameworkState !== 'initialization-required') {
    invalid('External workflow execution requires an exact initialized framework target.');
  }
  const externalPlan = selected.plan;
  if (manifest.project.specWorkflow !== 'manual' &&
      sourceInventory.status === 'preserved' &&
      sourceInventory.activeWork.identifiers.length > 0) {
    invalid(
      `Active ${sourceInventory.workflow} work overlaps the requested workflow transition: ${sourceInventory.activeWork.identifiers.join(', ')}. Reconcile it before selecting another external framework.`
    );
  }
  if (targetInventory.status === 'preserved' &&
      targetInventory.activeWork.identifiers.length > 0) {
    invalid('Target framework active work must be reconciled before initialization.');
  }

  const staged = await withStagingArea(async area => {
    const initialized = await initializeFramework(
      area,
      externalPlan,
      options.runner,
      {
        env: options.env,
        ...options.streamOptions,
        onCommand: options.onCommand
      }
    );
    const files: TransitionFrameworkFile[] = (await validateStagedTree(area))
      .filter(file => file.origin === 'framework')
      .map(file => Object.freeze({
        pathParts: Object.freeze([...file.pathParts]),
        relativePath: file.relativePath,
        content: Buffer.from(file.content),
        contentHash: file.contentHash,
        mode: file.mode,
        origin: 'official' as const
      }));
    const totalBytes = files.reduce(
      (total, file) => total + file.content.length,
      0
    );
    if (files.length === 0 ||
        files.length > maximumFrameworkFiles ||
        totalBytes > maximumFrameworkBytes) {
      invalid('Official framework staging output exceeds its bounded file inventory.');
    }
    return Object.freeze({
      commands: Object.freeze([...initialized.commands]),
      files: Object.freeze(files),
      totalBytes,
      digest: canonicalSha256(files.map(file => ({
        pathParts: file.pathParts,
        contentHash: file.contentHash,
        bytes: file.content.length,
        mode: file.mode
      })))
    });
  });
  const placeholder = specKitRepositoryPlaceholder(
    selected.target.workflow,
    staged.files
  );
  const frameworkFiles = Object.freeze([
    ...staged.files,
    ...(placeholder ? [placeholder] : [])
  ]);
  const targetFrameworkCommitInventory =
    await buildTargetFrameworkCommitInventory(
      projectRoot,
      selected.target.workflow,
      targetInventory,
      frameworkFiles
    );

  const activeLayout = manifest.activeLayout;
  const managed = buildModernManagedCore({
    selection: selected.selection,
    plugins: selected.plugins,
    activeLayout
  });
  const targetNames = new Set(managed.map(artifact => artifact.logicalName));
  const decisions: ManagedManifestDecision[] = [
    ...managed.map(artifact => ({
      kind: 'bytes' as const,
      logicalName: artifact.logicalName,
      category: artifact.category,
      pathParts: [...artifact.pathParts],
      content: artifact.content
    })),
    ...manifest.managedArtifacts
      .filter(artifact => !targetNames.has(artifact.logicalName))
      .map(artifact => ({
        kind: 'retire' as const,
        logicalName: artifact.logicalName
      }))
  ];
  const candidateManifest = createManifestV8Candidate({
    origin: 'workflow-transition',
    source: manifest,
    selection: selected.selection,
    activeLayout,
    managed: decisions
  });
  const configContent = `${renderLiftoffConfig(selected.plan)}\n`;
  const sourceByPath = new Map(
    manifest.managedArtifacts.map(artifact => [
      artifact.pathParts.join('/'),
      artifact
    ])
  );
  const targetByPath = new Map(
    managed.map(artifact => [artifact.pathParts.join('/'), artifact])
  );
  const stagedByPath = new Map(
    frameworkFiles.map(file => [file.relativePath, file])
  );
  for (const key of targetByPath.keys()) {
    if (stagedByPath.has(key)) {
      invalid(
        `Official framework output overlaps a Liftoff managed integration: ${key}.`
      );
    }
  }
  const managedPaths = new Map<string, readonly string[]>();
  for (const artifact of [
    ...manifest.managedArtifacts,
    ...managed
  ]) {
    managedPaths.set(artifact.pathParts.join('/'), artifact.pathParts);
  }
  const snapshots = new Map<string, ProjectFileSnapshot>([
    ['liftoff.manifest.json', manifestSnapshot],
    ['liftoff.config.json', configSnapshot]
  ]);
  for (const [key, pathParts] of managedPaths) {
    snapshots.set(key, await readInput(projectRoot, pathParts, false));
  }
  for (const file of frameworkFiles) {
    snapshots.set(
      file.relativePath,
      await readFrameworkInput(projectRoot, file.pathParts)
    );
  }
  for (const artifact of manifest.managedArtifacts) {
    const snapshot = snapshots.get(artifact.pathParts.join('/'));
    if (!snapshot?.content ||
        `sha256:${digest(snapshot.content)}` !== artifact.contentHash) {
      invalid(
        `Managed workflow integration ${artifact.pathParts.join('/')} differs from its recorded Liftoff bytes; reconcile it before transition.`
      );
    }
  }
  for (const artifact of managed) {
    const key = artifact.pathParts.join('/');
    const snapshot = snapshots.get(key);
    if (!sourceByPath.has(key) && snapshot?.content !== undefined) {
      invalid(
        `Target workflow integration ${key} is occupied by a non-source file.`
      );
    }
  }
  for (const file of frameworkFiles) {
    const snapshot = snapshots.get(file.relativePath);
    if (snapshot?.content !== undefined &&
        (!snapshot.content.equals(file.content) ||
          snapshot.mode !== file.mode)) {
      invalid(
        `Target ${selected.target.workflow} framework output collides with existing bytes or mode at ${file.relativePath}.`
      );
    }
  }

  const mutations: ProjectFileMutation[] = [];
  const identities: Array<Pick<
    WorkflowTransitionEffect,
    'logicalName' | 'kind' | 'operation' | 'pathParts'
  >> = [];
  for (const artifact of manifest.managedArtifacts
    .filter(source => !targetByPath.has(source.pathParts.join('/')))
    .sort((left, right) =>
      left.pathParts.join('/').localeCompare(right.pathParts.join('/')))) {
    mutations.push({
      type: 'delete',
      pathParts: [...artifact.pathParts]
    });
    identities.push({
      logicalName: artifact.logicalName,
      kind: 'managed-core',
      operation: 'delete',
      pathParts: [...artifact.pathParts]
    });
  }
  for (const artifact of [...managed].sort((left, right) =>
    left.pathParts.join('/').localeCompare(right.pathParts.join('/')))) {
    const snapshot = snapshots.get(artifact.pathParts.join('/'));
    if (snapshot?.content?.toString('utf8') === artifact.content) continue;
    mutations.push({
      type: 'write',
      pathParts: [...artifact.pathParts],
      content: artifact.content
    });
    identities.push({
      logicalName: artifact.logicalName,
      kind: 'managed-core',
      operation: 'write',
      pathParts: [...artifact.pathParts]
    });
  }
  for (const file of frameworkFiles) {
    const snapshot = snapshots.get(file.relativePath);
    if (snapshot?.content !== undefined) continue;
    mutations.push({
      type: 'write',
      pathParts: [...file.pathParts],
      content: file.content,
      mode: file.mode
    });
    identities.push({
      logicalName: file.origin === 'official'
        ? `framework:${file.relativePath}`
        : 'specs-placeholder',
      kind: file.origin === 'official'
        ? 'framework'
        : 'repository-placeholder',
      operation: 'write',
      pathParts: [...file.pathParts]
    });
  }
  if (configSnapshot.content?.toString('utf8') !== configContent) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.config.json'],
      content: configContent
    });
    identities.push({
      logicalName: 'liftoff-config',
      kind: 'desired-state',
      operation: 'write',
      pathParts: ['liftoff.config.json']
    });
  }
  if (manifestSnapshot.content?.toString('utf8') !==
      candidateManifest.content) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.manifest.json'],
      content: candidateManifest.content
    });
    identities.push({
      logicalName: 'manifest',
      kind: 'manifest',
      operation: 'write',
      pathParts: ['liftoff.manifest.json']
    });
  }
  if (mutations.length === 0 ||
      identities.at(-1)?.kind !== 'manifest' ||
      !samePath(mutations.at(-1)!.pathParts, ['liftoff.manifest.json'])) {
    invalid(
      'Executable external workflow transition requires one exact final manifest mutation.'
    );
  }
  const preconditions = [...snapshots.values()];
  const transaction = await inspectWorkflowTransitionTransactionCandidate(
    projectRoot,
    mutations,
    preconditions
  );
  if (transaction.size.kind !== 'journal' ||
      transaction.payload.mutations.length !== mutations.length ||
      identities.length !== mutations.length) {
    invalid('Workflow transition transaction measurement is incomplete.');
  }
  const effects = identities.map((identity, index) => {
    const measured = transaction.payload.mutations[index]?.target;
    if (!measured) invalid('Workflow transition effect measurement is missing.');
    const write = identity.operation === 'write';
    if (write !== (measured.kind === 'file')) {
      invalid('Workflow transition effect operation differs from its measured target.');
    }
    return Object.freeze({
      ...identity,
      pathParts: Object.freeze([...identity.pathParts]),
      contentDigest: measured.kind === 'file' ? measured.sha256 : null,
      contentBytes: measured.kind === 'file'
        ? Buffer.byteLength(
            (mutations[index] as Extract<
              ProjectFileMutation, { type: 'write' }
            >).content
          )
        : null,
      mode: measured.kind === 'file' ? measured.mode : null
    });
  });
  const report: WorkflowTransitionExecutionReport = Object.freeze({
    status: 'ready-for-file-approval',
    transition: manifest.project.specWorkflow === 'manual'
      ? 'manual-to-external-framework'
      : 'external-framework-to-external-framework',
    preconditionDigest: canonicalSha256(
      preconditions.map(snapshotDescriptor)
    ),
    preconditionCount: preconditions.length,
    transactionCandidateBinding: transaction.binding,
    transactionCandidateDigest: canonicalSha256(transaction.payload),
    transactionSize: Object.freeze({
      mutationCount: transaction.size.mutationCount,
      suppliedPreconditionCount:
        transaction.size.suppliedPreconditionCount,
      snapshotBytes: transaction.size.snapshotBytes,
      completeJournalBytes: transaction.size.completeJournalBytes
    }),
    effects: Object.freeze(effects),
    manifestPublishedLast: true,
    frameworkDocuments:
      'official-staged-with-existing-history-preserved',
    sharedTools: 'unchanged',
    targetLocalReadiness: 'official-framework-initialized',
    officialStage: Object.freeze({
      commands: staged.commands,
      fileCount: staged.files.length,
      totalBytes: staged.totalBytes,
      digest: staged.digest
    }),
    targetFrameworkCommitInventory,
    recovery: Object.freeze({
      transactionKind: 'workflow-transition',
      journalPathParts: Object.freeze([
        ...workflowTransitionTransactionPathParts
      ]),
      selectedBy:
        'plan-fingerprint-and-observed-transaction-digest'
    })
  });
  return Object.freeze({
    report,
    mutations: Object.freeze(mutations),
    preconditions: Object.freeze(preconditions)
  });
}

function agentRepairLogicalNames(
  agents: readonly CodingAgentId[]
): ReadonlySet<string> {
  return new Set(agents.flatMap(agent => [
    governanceAgentIntegrations[agent].setup.logicalName,
    governanceAgentIntegrations[agent].assessment.logicalName,
    governanceAgentIntegrations[agent].repair.logicalName,
    projectAssessmentAgentIntegrations[agent].logicalName
  ]));
}

async function seedFrameworkRepairStage(
  area: StagingArea,
  projectRoot: string,
  selection: {
    readonly workflow: 'openspec' | 'spec-kit';
    readonly agents: readonly CodingAgentId[];
    readonly defaultAgent: CodingAgentId | null;
  }
): Promise<void> {
  const paths = frameworkOutputPaths({
    workflow: selection.workflow,
    agents: [...selection.agents],
    ...(selection.defaultAgent
      ? { defaultAgent: selection.defaultAgent }
      : {})
  });
  const seen = new Set<string>();
  for (const pathParts of paths) {
    const relativePath = pathParts.join('/');
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const snapshot = await readFrameworkInput(projectRoot, pathParts);
    if (snapshot.content === undefined) continue;
    const destination = path.join(area.root, ...pathParts);
    await mkdir(path.dirname(destination), {
      recursive: true,
      mode: 0o700
    });
    await writeFile(destination, snapshot.content);
    if (snapshot.mode !== undefined) {
      await chmod(destination, snapshot.mode);
    }
    area.origins.set(relativePath, 'framework');
    area.frameworkAllowedRoots.add(pathParts[0]!);
  }
}

function frameworkRepairAllowedPaths(
  workflow: 'openspec' | 'spec-kit',
  agents: readonly CodingAgentId[],
  allowDefaultState: boolean
): ReadonlySet<string> {
  const paths = agents.flatMap(agent =>
    frameworkIntegrationPaths(workflow, agent)
  );
  if (agents.includes('codex')) {
    paths.push([
      ...(workflow === 'openspec'
        ? OPEN_SPEC_CODEX_TARGET_PATH
        : SPEC_KIT_CODEX_CONFIG_PATH)
    ]);
  }
  if (workflow === 'spec-kit' && allowDefaultState) {
    paths.push(['.specify', 'integration.json']);
  }
  return new Set(paths.map(parts => parts.join('/')));
}

async function stageExternalAgentRepair(
  projectRoot: string,
  selected: ReturnType<typeof targetSelection>,
  source: WorkflowTransitionPlanReport['source'],
  repairAgents: readonly CodingAgentId[],
  defaultChanged: boolean,
  options: {
    readonly runner: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
    readonly onCommand?: (command: string) => void;
  }
): Promise<{
  readonly commands: readonly string[];
  readonly files: readonly TransitionFrameworkFile[];
  readonly totalBytes: number;
  readonly digest: string;
}> {
  if (!isExternalProjectPlan(selected.plan) ||
      selected.target.workflow === 'manual' ||
      source.workflow === 'manual' ||
      source.workflow !== selected.target.workflow) {
    invalid('External agent repair requires one initialized unchanged framework.');
  }
  const externalPlan = selected.plan as ProjectPlan;
  const workflow = selected.target.workflow as 'openspec' | 'spec-kit';
  const allowed = frameworkRepairAllowedPaths(
    workflow,
    repairAgents,
    defaultChanged || repairAgents.length > 0
  );
  return await withStagingArea(async area => {
    await seedFrameworkRepairStage(area, projectRoot, {
      workflow,
      agents: source.agents,
      defaultAgent: source.defaultAgent
    });
    const commands = workflow === 'openspec'
      ? [buildOpenSpecInitCommand(externalPlan)]
      : [
          ...repairAgents.map(agent => {
            const selectedAgent = externalPlan.agents.find(
              candidate => candidate.id === agent
            );
            if (!selectedAgent) {
              invalid(`Requested repair agent ${agent} is not selected.`);
            }
            return buildSpecKitIntegrationInstallCommand(
              externalPlan,
              selectedAgent
            );
          }),
          ...(defaultChanged
            ? [buildSpecKitDefaultCommand(externalPlan)]
            : [])
        ];
    if (commands.length === 0) {
      return Object.freeze({
        commands: Object.freeze([]),
        files: Object.freeze([]),
        totalBytes: 0,
        digest: canonicalSha256([])
      });
    }
    const result = await executeFrameworkCommands(
      area,
      externalPlan,
      commands,
      options.runner,
      {
        env: options.env,
        ...options.streamOptions,
        onCommand: options.onCommand
      }
    );
    const changed = new Set(result.changedPaths);
    const staged = await validateStagedTree(area);
    const changedFiles: TransitionFrameworkFile[] = staged
      .filter(file => changed.has(file.relativePath))
      .map(file => Object.freeze({
        pathParts: Object.freeze([...file.pathParts]),
        relativePath: file.relativePath,
        content: Buffer.from(file.content),
        contentHash: file.contentHash,
        mode: file.mode,
        origin: 'official' as const
      }));
    const changedFilePaths = new Set(
      changedFiles.map(file => file.relativePath)
    );
    for (const changedPath of changed) {
      if (changedFilePaths.has(changedPath) ||
          changedFiles.some(file =>
            file.relativePath.startsWith(`${changedPath}/`)
          )) {
        continue;
      }
      invalid(
        `Official ${selected.target.workflow} agent repair removed or created an untracked empty path: ${changedPath}.`
      );
    }
    for (const file of changedFiles) {
      if (!allowed.has(file.relativePath)) {
        invalid(
          `Official ${selected.target.workflow} agent repair changed an unapproved path: ${file.relativePath}.`
        );
      }
    }
    const totalBytes = changedFiles.reduce(
      (total, file) => total + file.content.length,
      0
    );
    if (changedFiles.length > maximumFrameworkFiles ||
        totalBytes > maximumFrameworkBytes) {
      invalid('Official agent repair output exceeds its bounded file inventory.');
    }
    return Object.freeze({
      commands: Object.freeze([...result.commands]),
      files: Object.freeze(changedFiles),
      totalBytes,
      digest: canonicalSha256(changedFiles.map(file => ({
        pathParts: file.pathParts,
        contentHash: file.contentHash,
        bytes: file.content.length,
        mode: file.mode
      })))
    });
  });
}

async function buildAgentRepairExecution(
  projectRoot: string,
  manifest: LiftoffManifestV8,
  manifestSnapshot: ProjectFileSnapshot,
  configSnapshot: ProjectFileSnapshot,
  selected: ReturnType<typeof targetSelection>,
  source: WorkflowTransitionPlanReport['source'],
  targetInventory: WorkflowTransitionTargetFrameworkInventory,
  repairAgents: readonly CodingAgentId[],
  options: {
    readonly runner: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
    readonly onCommand?: (command: string) => void;
  }
): Promise<WorkflowTransitionExecutionCandidate | null> {
  if (source.workflow !== selected.target.workflow ||
      manifest.project.specWorkflow !== source.workflow ||
      repairAgents.some(agent => !selected.target.agents.includes(agent))) {
    invalid('Agent repair must preserve the recorded workflow and add only selected agents.');
  }
  const defaultChanged =
    source.defaultAgent !== selected.target.defaultAgent;
  const staged = selected.target.workflow === 'manual'
    ? null
    : await stageExternalAgentRepair(
        projectRoot,
        selected,
        source,
        repairAgents,
        defaultChanged,
        options
      );
  const sourceSelected = targetSelection(
    manifest,
    source.workflow,
    source.agents,
    source.defaultAgent ?? undefined
  );
  const sourceManaged = buildModernManagedCore({
    selection: sourceSelected.selection,
    plugins: sourceSelected.plugins,
    activeLayout: manifest.activeLayout
  });
  const targetManaged = buildModernManagedCore({
    selection: selected.selection,
    plugins: selected.plugins,
    activeLayout: manifest.activeLayout
  });
  const sourceManagedByName = new Map(
    sourceManaged.map(artifact => [artifact.logicalName, artifact])
  );
  const targetManagedByName = new Map(
    targetManaged.map(artifact => [artifact.logicalName, artifact])
  );
  const repairNames = agentRepairLogicalNames(repairAgents);
  const decisions: ManagedManifestDecision[] = [
    ...manifest.managedArtifacts.map(artifact => ({
      kind: 'retain' as const,
      logicalName: artifact.logicalName
    })),
    ...targetManaged
      .filter(artifact =>
        !sourceManagedByName.has(artifact.logicalName)
      )
      .map(artifact => ({
        kind: 'bytes' as const,
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        content: artifact.content
      }))
  ];
  const candidateManifest = createManifestV8Candidate({
    origin: 'workflow-transition',
    source: manifest,
    selection: selected.selection,
    activeLayout: manifest.activeLayout,
    managed: decisions
  });
  const configContent = `${renderLiftoffConfig(selected.plan)}\n`;
  const snapshots = new Map<string, ProjectFileSnapshot>([
    ['liftoff.manifest.json', manifestSnapshot],
    ['liftoff.config.json', configSnapshot]
  ]);
  const mutations: ProjectFileMutation[] = [];
  const identities: Array<Pick<
    WorkflowTransitionEffect,
    'logicalName' | 'kind' | 'operation' | 'pathParts'
  >> = [];
  for (const file of staged?.files ?? []) {
    const snapshot = await readFrameworkInput(projectRoot, file.pathParts);
    snapshots.set(file.relativePath, snapshot);
    const mutableSpecKitState =
      selected.target.workflow === 'spec-kit' &&
      file.relativePath === '.specify/integration.json';
    if (snapshot.content !== undefined &&
        (!snapshot.content.equals(file.content) ||
          snapshot.mode !== file.mode) &&
        !mutableSpecKitState) {
      invalid(
        `Requested ${selected.target.workflow} agent repair collides with existing bytes or mode at ${file.relativePath}.`
      );
    }
    if (snapshot.content?.equals(file.content) &&
        snapshot.mode === file.mode) {
      continue;
    }
    mutations.push({
      type: 'write',
      pathParts: [...file.pathParts],
      content: file.content,
      mode: file.mode
    });
    identities.push({
      logicalName: `framework:${file.relativePath}`,
      kind: 'framework',
      operation: 'write',
      pathParts: [...file.pathParts]
    });
  }
  const sourceManifestByName = new Map(
    manifest.managedArtifacts.map(artifact => [
      artifact.logicalName,
      artifact
    ])
  );
  for (const logicalName of [...repairNames].sort((left, right) =>
    left.localeCompare(right, 'en'))) {
    const sourceArtifact = sourceManagedByName.get(logicalName);
    const targetArtifact = targetManagedByName.get(logicalName);
    const artifact = sourceArtifact ?? targetArtifact;
    if (!artifact) continue;
    const recorded = sourceManifestByName.get(logicalName);
    if (recorded && !sourceArtifact) {
      invalid(
        `Recorded managed integration ${logicalName} lacks its source producer.`
      );
    }
    if (recorded &&
        `sha256:${digest(Buffer.from(artifact.content, 'utf8'))}` !==
          recorded.contentHash) {
      invalid(
        `Recorded managed integration ${logicalName} cannot be reproduced exactly by this CLI.`
      );
    }
    const key = artifact.pathParts.join('/');
    const snapshot = await readInput(
      projectRoot,
      artifact.pathParts,
      false
    );
    snapshots.set(key, snapshot);
    if (snapshot.content !== undefined) {
      if (snapshot.content.toString('utf8') !== artifact.content) {
        invalid(
          `Requested Liftoff agent integration ${key} is occupied by different bytes.`
        );
      }
      continue;
    }
    mutations.push({
      type: 'write',
      pathParts: [...artifact.pathParts],
      content: artifact.content
    });
    identities.push({
      logicalName: artifact.logicalName,
      kind: 'managed-core',
      operation: 'write',
      pathParts: [...artifact.pathParts]
    });
  }
  if (configSnapshot.content?.toString('utf8') !== configContent) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.config.json'],
      content: configContent
    });
    identities.push({
      logicalName: 'liftoff-config',
      kind: 'desired-state',
      operation: 'write',
      pathParts: ['liftoff.config.json']
    });
  }
  if (manifestSnapshot.content?.toString('utf8') !==
      candidateManifest.content) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.manifest.json'],
      content: candidateManifest.content
    });
    identities.push({
      logicalName: 'manifest',
      kind: 'manifest',
      operation: 'write',
      pathParts: ['liftoff.manifest.json']
    });
  }
  if (mutations.length === 0) return null;
  if (identities.some(identity => identity.operation !== 'write') ||
      identities.some((identity, index) =>
        identity.kind === 'manifest' && index !== identities.length - 1
      )) {
    invalid('Agent repair may only add exact integrations and publish its manifest last.');
  }
  const preconditions = [...snapshots.values()];
  const transaction = await inspectWorkflowTransitionTransactionCandidate(
    projectRoot,
    mutations,
    preconditions
  );
  if (transaction.size.kind !== 'journal' ||
      transaction.payload.mutations.length !== mutations.length ||
      identities.length !== mutations.length) {
    invalid('Agent repair transaction measurement is incomplete.');
  }
  const effects = identities.map((identity, index) => {
    const measured = transaction.payload.mutations[index]?.target;
    if (measured?.kind !== 'file') {
      invalid('Agent repair effect measurement is missing.');
    }
    return Object.freeze({
      ...identity,
      pathParts: Object.freeze([...identity.pathParts]),
      contentDigest: measured.sha256,
      contentBytes: Buffer.byteLength(
        (mutations[index] as Extract<
          ProjectFileMutation, { type: 'write' }
        >).content
      ),
      mode: measured.mode
    });
  });
  const targetFrameworkCommitInventory =
    selected.target.workflow === 'manual'
      ? null
      : await buildTargetFrameworkCommitInventory(
          projectRoot,
          selected.target.workflow,
          targetInventory,
          staged?.files ?? [],
          true
        );
  const report: WorkflowTransitionExecutionReport = Object.freeze({
    status: 'ready-for-file-approval',
    transition: 'agent-integration-repair',
    preconditionDigest: canonicalSha256(
      preconditions.map(snapshotDescriptor)
    ),
    preconditionCount: preconditions.length,
    transactionCandidateBinding: transaction.binding,
    transactionCandidateDigest: canonicalSha256(transaction.payload),
    transactionSize: Object.freeze({
      mutationCount: transaction.size.mutationCount,
      suppliedPreconditionCount:
        transaction.size.suppliedPreconditionCount,
      snapshotBytes: transaction.size.snapshotBytes,
      completeJournalBytes: transaction.size.completeJournalBytes
    }),
    effects: Object.freeze(effects),
    manifestPublishedLast: true,
    frameworkDocuments: selected.target.workflow === 'manual'
      ? 'preserved-on-disk'
      : 'official-integration-staged-with-history-preserved',
    sharedTools: 'unchanged',
    targetLocalReadiness: 'agent-integrations-verified',
    officialStage: staged
      ? Object.freeze({
          commands: staged.commands,
          fileCount: staged.files.length,
          totalBytes: staged.totalBytes,
          digest: staged.digest
        })
      : null,
    targetFrameworkCommitInventory,
    recovery: Object.freeze({
      transactionKind: 'workflow-transition',
      journalPathParts: Object.freeze([
        ...workflowTransitionTransactionPathParts
      ]),
      selectedBy:
        'plan-fingerprint-and-observed-transaction-digest'
    })
  });
  return Object.freeze({
    report,
    mutations: Object.freeze(mutations),
    preconditions: Object.freeze(preconditions)
  });
}

function isExternalProjectPlan(
  plan: CurrentProjectPlan
): plan is ProjectPlan {
  return plan.specWorkflow.id === 'openspec' ||
    plan.specWorkflow.id === 'spec-kit';
}

function validateFingerprint(
  report: Record<string, unknown> & { readonly fingerprint?: unknown }
): void {
  const { fingerprint, ...unsigned } = report;
  if (typeof fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(fingerprint) ||
      canonicalSha256(unsigned) !== fingerprint) {
    invalid('Workflow transition plan fingerprint is invalid.');
  }
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  scope: string
): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length ||
      fields.some(field => !Object.hasOwn(value, field))) {
    invalid(`${scope} fields are invalid.`);
  }
  return value;
}

function denseArray(
  value: unknown,
  maximum: number,
  scope: string
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    invalid(`${scope} must be a bounded dense array.`);
  }
  return value;
}

function sha256(value: unknown, scope: string, prefixed = false): string {
  if (typeof value !== 'string' ||
      !(prefixed ? /^sha256:[a-f0-9]{64}$/u : /^[a-f0-9]{64}$/u).test(value)) {
    invalid(`${scope} must be an exact lowercase SHA-256 digest.`);
  }
  return value;
}

function validateSelection(
  value: unknown,
  source: boolean
): void {
  const fields = source
    ? ['workflow', 'agents', 'defaultAgent', 'frameworkState', 'frameworkContractVersion']
    : ['workflow', 'agents', 'defaultAgent', 'frameworkState', 'pluginResolutionDigest'];
  const selection = exactRecord(
    value,
    fields,
    source ? 'Workflow transition source' : 'Workflow transition target'
  );
  if (!['openspec', 'spec-kit', 'manual'].includes(String(selection.workflow))) {
    invalid('Workflow transition selection has an invalid workflow.');
  }
  const agents = denseArray(selection.agents, 3, 'Workflow transition agents');
  const canonical = projectCatalog.canonicalizeCodingAgents(
    agents.map(agent => typeof agent === 'string' ? agent : invalid(
      'Workflow transition agent identities must be strings.'
    ))
  ).agents.map(agent => agent.id);
  if (canonical.length !== agents.length ||
      canonical.some((agent, index) => agent !== agents[index])) {
    invalid('Workflow transition agent identities must be unique and canonical.');
  }
  if (selection.defaultAgent !== null &&
      (typeof selection.defaultAgent !== 'string' ||
        !canonical.includes(selection.defaultAgent as CodingAgentId))) {
    invalid('Workflow transition default agent must be null or one selected canonical agent.');
  }
  if (source) {
    if (!['not-required', 'legacy', 'initialized'].includes(
      String(selection.frameworkState)
    ) || selection.frameworkContractVersion !== null &&
      typeof selection.frameworkContractVersion !== 'string') {
      invalid('Workflow transition source framework identity is invalid.');
    }
    const legacy = selection.frameworkState === 'legacy';
    const initialized = selection.frameworkState === 'initialized';
    if (selection.workflow === 'manual'
      ? selection.frameworkState !== 'not-required' ||
        selection.frameworkContractVersion !== null ||
        selection.defaultAgent !== null
      : selection.frameworkState === 'not-required' ||
        legacy && (selection.frameworkContractVersion !== null ||
          canonical.length > 0 || selection.defaultAgent !== null) ||
        initialized && (selection.frameworkContractVersion === null ||
          canonical.length === 0 ||
          selection.workflow === 'openspec' && selection.defaultAgent !== null ||
          selection.workflow === 'spec-kit' && selection.defaultAgent === null)) {
      invalid('Workflow transition source workflow and framework state disagree.');
    }
  } else {
    if (!['not-required', 'initialization-required'].includes(
      String(selection.frameworkState)
    )) {
      invalid('Workflow transition target framework state is invalid.');
    }
    if (selection.workflow === 'manual'
      ? selection.frameworkState !== 'not-required' ||
        selection.defaultAgent !== null
      : selection.frameworkState !== 'initialization-required' ||
        canonical.length === 0 ||
        selection.workflow === 'openspec' && selection.defaultAgent !== null ||
        selection.workflow === 'spec-kit' && selection.defaultAgent === null) {
      invalid('Workflow transition target workflow, agents and framework state disagree.');
    }
    sha256(
      selection.pluginResolutionDigest,
      'Workflow transition target plugin resolution',
      true
    );
  }
}

function validateInputs(value: unknown): void {
  const inputs = denseArray(value, 2, 'Workflow transition inputs');
  if (inputs.length !== 2) invalid('Workflow transition inputs are incomplete.');
  const expected = ['liftoff.manifest.json', 'liftoff.config.json'];
  inputs.forEach((entry, index) => {
    const input = exactRecord(
      entry,
      ['pathParts', 'present', 'digest', 'bytes', 'mode'],
      `Workflow transition input ${index}`
    );
    const parts = denseArray(
      input.pathParts,
      1,
      `Workflow transition input ${index} path`
    );
    if (parts.length !== 1 || parts[0] !== expected[index] ||
        typeof input.present !== 'boolean') {
      invalid(`Workflow transition input ${index} identity is invalid.`);
    }
    if (input.present) {
      sha256(input.digest, `Workflow transition input ${index} digest`);
      if (!Number.isSafeInteger(input.bytes) || Number(input.bytes) < 0 ||
          !Number.isSafeInteger(input.mode) || Number(input.mode) < 0 ||
          Number(input.mode) > 0o7777) {
        invalid(`Workflow transition input ${index} metadata is invalid.`);
      }
    } else if (input.digest !== null || input.bytes !== null ||
        input.mode !== null || index === 0) {
      invalid(`Workflow transition input ${index} absence is invalid.`);
    }
  });
}

function validateFrameworkInventory(
  value: unknown,
  source: WorkflowTransitionPlanReport['source']
): void {
  const inventory = exactRecord(value, [
    'status', 'workflow', 'roots', 'activeWork', 'fileCount',
    'directoryCount', 'totalBytes', 'digest'
  ], 'Workflow transition framework inventory');
  const roots = denseArray(
    inventory.roots,
    2,
    'Workflow transition framework inventory roots'
  );
  const active = exactRecord(inventory.activeWork, [
    'identifiers', 'reconciliation'
  ], 'Workflow transition active work');
  const identifiers = denseArray(
    active.identifiers,
    maximumFrameworkDirectories,
    'Workflow transition active work identifiers'
  );
  const zero = inventory.fileCount === 0 &&
    inventory.directoryCount === 0 &&
    inventory.totalBytes === 0 &&
    inventory.digest === null;
  if (source.workflow === 'manual') {
    if (inventory.status !== 'not-applicable' ||
        inventory.workflow !== 'manual' ||
        roots.length !== 0 ||
        identifiers.length !== 0 ||
        active.reconciliation !== 'not-applicable' ||
        !zero) {
      invalid('Manual workflow framework inventory must be inapplicable.');
    }
    return;
  }
  if (source.frameworkState !== 'initialized') {
    if (inventory.status !== 'unavailable' ||
        inventory.workflow !== source.workflow ||
        roots.length !== 0 ||
        identifiers.length !== 0 ||
        active.reconciliation !== 'unavailable' ||
        !zero) {
      invalid('Legacy workflow framework inventory must remain unavailable.');
    }
    return;
  }
  if (inventory.status !== 'preserved' ||
      inventory.workflow !== source.workflow ||
      canonicalJson(roots) !==
        canonicalJson(frameworkRoots(source.workflow)) ||
      active.reconciliation !==
        'preserve-on-disk-as-non-authoritative') {
    invalid('Initialized workflow framework inventory is invalid.');
  }
  let prior = '';
  for (const identifier of identifiers) {
    if (typeof identifier !== 'string' ||
        !identifier ||
        identifier.length > 255 ||
        /[\/\\\u0000-\u001f\u007f]/u.test(identifier) ||
        identifier.localeCompare(prior, 'en') <= 0) {
      invalid(
        'Workflow transition active work identifiers must be unique sorted safe names.'
      );
    }
    prior = identifier;
  }
  if (!Number.isSafeInteger(inventory.fileCount) ||
      Number(inventory.fileCount) < 0 ||
      Number(inventory.fileCount) > maximumFrameworkFiles ||
      !Number.isSafeInteger(inventory.directoryCount) ||
      Number(inventory.directoryCount) <= 0 ||
      Number(inventory.directoryCount) > maximumFrameworkDirectories ||
      !Number.isSafeInteger(inventory.totalBytes) ||
      Number(inventory.totalBytes) < 0 ||
      Number(inventory.totalBytes) > maximumFrameworkBytes) {
    invalid('Workflow transition framework inventory bounds are invalid.');
  }
  sha256(inventory.digest, 'Workflow transition framework inventory digest');
}

function validateTargetFrameworkInventory(
  value: unknown,
  target: WorkflowTransitionPlanReport['target']
): void {
  const inventory = exactRecord(value, [
    'status', 'workflow', 'roots', 'activeWork', 'fileCount',
    'directoryCount', 'totalBytes', 'digest'
  ], 'Workflow transition target framework inventory');
  const roots = denseArray(
    inventory.roots,
    2,
    'Workflow transition target framework inventory roots'
  );
  const active = exactRecord(inventory.activeWork, [
    'identifiers', 'reconciliation'
  ], 'Workflow transition target active work');
  const identifiers = denseArray(
    active.identifiers,
    maximumFrameworkDirectories,
    'Workflow transition target active work identifiers'
  );
  const zero = inventory.fileCount === 0 &&
    inventory.directoryCount === 0 &&
    inventory.totalBytes === 0 &&
    inventory.digest === null;
  if (target.workflow === 'manual') {
    if (inventory.status !== 'not-applicable' ||
        inventory.workflow !== 'manual' ||
        roots.length !== 0 ||
        identifiers.length !== 0 ||
        active.reconciliation !== 'not-applicable' ||
        !zero) {
      invalid('Manual target framework inventory must be inapplicable.');
    }
    return;
  }
  if (inventory.workflow !== target.workflow ||
      canonicalJson(roots) !==
        canonicalJson(frameworkRoots(target.workflow))) {
    invalid('Target framework inventory workflow or roots are invalid.');
  }
  if (inventory.status === 'absent') {
    if (identifiers.length !== 0 ||
        active.reconciliation !== 'no-existing-history' ||
        !zero) {
      invalid('Absent target framework inventory is invalid.');
    }
    return;
  }
  if (inventory.status !== 'preserved' ||
      active.reconciliation !==
        'preserve-on-disk-as-non-authoritative') {
    invalid(
      'Existing target framework history must use the preserved reconciliation contract.'
    );
  }
  let prior = '';
  for (const identifier of identifiers) {
    if (typeof identifier !== 'string' ||
        !identifier ||
        identifier.length > 255 ||
        /[\/\\\u0000-\u001f\u007f]/u.test(identifier) ||
        identifier.localeCompare(prior, 'en') <= 0) {
      invalid(
        'Workflow transition target active work identifiers must be unique sorted safe names.'
      );
    }
    prior = identifier;
  }
  if (!Number.isSafeInteger(inventory.fileCount) ||
      Number(inventory.fileCount) < 0 ||
      Number(inventory.fileCount) > maximumFrameworkFiles ||
      !Number.isSafeInteger(inventory.directoryCount) ||
      Number(inventory.directoryCount) <= 0 ||
      Number(inventory.directoryCount) > maximumFrameworkDirectories ||
      !Number.isSafeInteger(inventory.totalBytes) ||
      Number(inventory.totalBytes) < 0 ||
      Number(inventory.totalBytes) > maximumFrameworkBytes) {
    invalid('Target framework inventory bounds are invalid.');
  }
  sha256(
    inventory.digest,
    'Workflow transition target framework inventory digest'
  );
}

function validatePreparation(
  value: unknown,
  target: WorkflowTransitionPlanReport['target']
): void {
  const preparation = exactRecord(value, [
    'status', 'tools', 'openSpecProfile'
  ], 'Workflow transition preparation');
  const tools = denseArray(
    preparation.tools,
    6,
    'Workflow transition preparation tools'
  );
  const profile = exactRecord(preparation.openSpecProfile, [
    'status', 'profile', 'delivery', 'workflows', 'differences', 'commands'
  ], 'Workflow transition OpenSpec profile preparation');
  const workflows = denseArray(
    profile.workflows,
    64,
    'Workflow transition OpenSpec profile workflows'
  );
  const differences = denseArray(
    profile.differences,
    64,
    'Workflow transition OpenSpec profile differences'
  );
  const commands = denseArray(
    profile.commands,
    8,
    'Workflow transition OpenSpec profile commands'
  );
  if (workflows.some(entry => typeof entry !== 'string') ||
      differences.some(entry => typeof entry !== 'string') ||
      commands.some(entry => typeof entry !== 'string')) {
    invalid('Workflow transition OpenSpec profile preparation arrays are invalid.');
  }
  const toolIds = new Set<string>();
  for (const [index, entry] of tools.entries()) {
    const tool = exactRecord(entry, [
      'id', 'state', 'reasonCode', 'detectedVersion', 'executable',
      'resolution', 'resolvedPath', 'realPath', 'kind', 'origin',
      'evidence', 'minimumVersion', 'exactVersion', 'releaseLine',
      'installCommand'
    ], `Workflow transition preparation tool ${index}`);
    if (typeof tool.id !== 'string' || !tool.id ||
        toolIds.has(tool.id) ||
        typeof tool.executable !== 'string' || !tool.executable ||
        !['ready', 'missing', 'outdated', 'unhealthy', 'not-observable'].includes(String(tool.state)) ||
        typeof tool.reasonCode !== 'string' ||
        !['resolved', 'missing', 'not-observable'].includes(String(tool.resolution)) ||
        !['brew', 'winget', 'npm', 'uv', 'standalone', 'unknown'].includes(String(tool.origin)) ||
        !['path-search', 'version-probe', 'documented-location', 'unavailable'].includes(String(tool.evidence))) {
      invalid(`Workflow transition preparation tool ${index} is invalid.`);
    }
    for (const field of [
      tool.detectedVersion, tool.resolvedPath, tool.realPath, tool.kind,
      tool.minimumVersion, tool.exactVersion, tool.releaseLine,
      tool.installCommand
    ]) {
      if (field !== null && typeof field !== 'string') {
        invalid(`Workflow transition preparation tool ${index} metadata is invalid.`);
      }
    }
    toolIds.add(tool.id);
  }
  if (target.workflow === 'manual') {
    if (preparation.status !== 'not-required' ||
        tools.length !== 0 ||
        profile.status !== 'not-applicable' ||
        profile.profile !== null ||
        profile.delivery !== null ||
        workflows.length !== 0 ||
        differences.length !== 0 ||
        commands.length !== 0) {
      invalid('Manual workflow transition preparation must be inapplicable.');
    }
    return;
  }
  if (preparation.status === 'not-required') {
    if (tools.length !== 0 ||
        profile.status !== 'not-applicable' ||
        profile.profile !== null ||
        profile.delivery !== null ||
        workflows.length !== 0 ||
        differences.length !== 0 ||
        commands.length !== 0) {
      invalid('No-op workflow transition preparation is invalid.');
    }
    return;
  }
  if (!['ready', 'required'].includes(String(preparation.status)) ||
      tools.length === 0) {
    invalid('External workflow transition preparation is incomplete.');
  }
  const toolsReady = tools.every(entry => {
    const tool = entry as Record<string, unknown>;
    return tool.state === 'ready' && tool.reasonCode === 'compatible';
  });
  const expectedProfile = target.workflow === 'openspec'
    ? ['ready', 'configuration-required', 'unavailable']
    : ['not-applicable'];
  if (!expectedProfile.includes(String(profile.status)) ||
      (preparation.status === 'ready') !==
        (toolsReady &&
          (profile.status === 'ready' ||
            profile.status === 'not-applicable'))) {
    invalid('Workflow transition preparation readiness is invalid.');
  }
}

function validateChecks(
  value: unknown,
  target: WorkflowTransitionTarget
): void {
  const checks = denseArray(value, 5, 'Workflow transition checks');
  const expected = [
    'source-inputs-current',
    'source-history-preserved',
    'active-work-reconciled',
    'target-framework-staged',
    'target-integrations-verified'
  ];
  if (checks.length !== expected.length) {
    invalid('Workflow transition checks are incomplete.');
  }
  checks.forEach((entry, index) => {
    const check = exactRecord(
      entry,
      ['id', 'status'],
      `Workflow transition check ${index}`
    );
    const status = index === 3 && target === 'manual'
      ? 'not-applicable'
      : 'required';
    if (check.id !== expected[index] || check.status !== status) {
      invalid(`Workflow transition check ${index} is invalid.`);
    }
  });
}

function validateExecution(
  value: unknown,
  source: WorkflowTransitionPlanReport['source'],
  target: WorkflowTransitionPlanReport['target'],
  operation: WorkflowTransitionPlanReport['operation']
): void {
  if (!isRecord(value)) {
    invalid('Workflow transition execution must be an object.');
  }
  if (value.status === 'not-required' || value.status === 'unavailable') {
    exactRecord(value, ['status'], 'Workflow transition execution');
    return;
  }
  const execution = exactRecord(value, [
    'status', 'transition', 'preconditionDigest', 'preconditionCount',
    'transactionCandidateBinding', 'transactionCandidateDigest',
    'transactionSize', 'effects', 'manifestPublishedLast',
    'frameworkDocuments', 'sharedTools', 'targetLocalReadiness',
    'officialStage', 'targetFrameworkCommitInventory', 'recovery'
  ], 'Workflow transition execution');
  const manual = target.workflow === 'manual';
  if (execution.status !== 'ready-for-file-approval' ||
      execution.manifestPublishedLast !== true ||
      execution.sharedTools !== 'unchanged') {
    invalid('Workflow transition executable identity is invalid.');
  }
  if (operation === 'agent-repair') {
    if (execution.transition !== 'agent-integration-repair' ||
        source.workflow !== target.workflow ||
        execution.frameworkDocuments !==
          (target.workflow === 'manual'
            ? 'preserved-on-disk'
            : 'official-integration-staged-with-history-preserved') ||
        execution.targetLocalReadiness !==
          'agent-integrations-verified') {
      invalid('Agent repair executable identity is invalid.');
    }
    if (target.workflow === 'manual') {
      if (execution.officialStage !== null ||
          execution.targetFrameworkCommitInventory !== null) {
        invalid('Manual agent repair cannot stage an external framework.');
      }
    } else {
      const stage = exactRecord(execution.officialStage, [
        'commands', 'fileCount', 'totalBytes', 'digest'
      ], 'Agent repair official stage');
      const stageCommands = denseArray(
        stage.commands,
        16,
        'Agent repair official stage commands'
      );
      if (stageCommands.length === 0 ||
          stageCommands.some(command =>
            typeof command !== 'string' || !command
          ) ||
          !Number.isSafeInteger(stage.fileCount) ||
          Number(stage.fileCount) < 0 ||
          Number(stage.fileCount) > maximumFrameworkFiles ||
          !Number.isSafeInteger(stage.totalBytes) ||
          Number(stage.totalBytes) < 0 ||
          Number(stage.totalBytes) > maximumFrameworkBytes) {
        invalid('Agent repair official stage inventory is invalid.');
      }
      sha256(stage.digest, 'Agent repair official stage digest');
      validateTargetFrameworkInventory(
        execution.targetFrameworkCommitInventory,
        target
      );
      const commitInventory =
        execution.targetFrameworkCommitInventory as { status?: unknown };
      if (commitInventory.status !== 'preserved') {
        invalid('Agent repair commit inventory must be preserved.');
      }
    }
  } else if (manual) {
    if (execution.transition !== 'external-framework-to-manual' ||
        source.workflow === 'manual' ||
        source.frameworkState !== 'initialized' ||
        execution.frameworkDocuments !== 'preserved-on-disk' ||
        execution.targetLocalReadiness !==
          'manual-native-framework-inapplicable' ||
        execution.officialStage !== null ||
        execution.targetFrameworkCommitInventory !== null) {
      invalid('Manual workflow transition executable identity is invalid.');
    }
  } else {
    const expected = source.workflow === 'manual'
      ? 'manual-to-external-framework'
      : 'external-framework-to-external-framework';
    if (execution.transition !== expected ||
        execution.frameworkDocuments !==
          'official-staged-with-existing-history-preserved' ||
        execution.targetLocalReadiness !==
          'official-framework-initialized') {
      invalid('External workflow transition executable identity is invalid.');
    }
    const stage = exactRecord(execution.officialStage, [
      'commands', 'fileCount', 'totalBytes', 'digest'
    ], 'Workflow transition official stage');
    const stageCommands = denseArray(
      stage.commands,
      16,
      'Workflow transition official stage commands'
    );
    if (stageCommands.length === 0 ||
        stageCommands.some(command => typeof command !== 'string' || !command) ||
        !Number.isSafeInteger(stage.fileCount) ||
        Number(stage.fileCount) <= 0 ||
        Number(stage.fileCount) > maximumFrameworkFiles ||
        !Number.isSafeInteger(stage.totalBytes) ||
        Number(stage.totalBytes) < 0 ||
        Number(stage.totalBytes) > maximumFrameworkBytes) {
      invalid('Workflow transition official stage inventory is invalid.');
    }
    sha256(stage.digest, 'Workflow transition official stage digest');
    validateTargetFrameworkInventory(
      execution.targetFrameworkCommitInventory,
      target
    );
    const commitInventory = execution.targetFrameworkCommitInventory as {
      status?: unknown;
      activeWork?: unknown;
    };
    if (commitInventory.status !== 'preserved') {
      invalid(
        'External workflow transition commit inventory must be preserved.'
      );
    }
  }
  sha256(
    execution.preconditionDigest,
    'Workflow transition precondition digest'
  );
  sha256(
    execution.transactionCandidateBinding,
    'Workflow transition candidate binding'
  );
  sha256(
    execution.transactionCandidateDigest,
    'Workflow transition candidate digest'
  );
  if (!Number.isSafeInteger(execution.preconditionCount) ||
      Number(execution.preconditionCount) < 2) {
    invalid('Workflow transition precondition count is invalid.');
  }
  const size = exactRecord(execution.transactionSize, [
    'mutationCount', 'suppliedPreconditionCount', 'snapshotBytes',
    'completeJournalBytes'
  ], 'Workflow transition transaction size');
  for (const field of Object.values(size)) {
    if (!Number.isSafeInteger(field) || Number(field) < 0) {
      invalid('Workflow transition transaction size is invalid.');
    }
  }
  const effects = denseArray(
    execution.effects,
    1024,
    'Workflow transition effects'
  );
  if (effects.length === 0 ||
      size.mutationCount !== effects.length ||
      size.suppliedPreconditionCount !== execution.preconditionCount) {
    invalid('Workflow transition effect inventory is incomplete.');
  }
  const paths = new Set<string>();
  effects.forEach((effectValue, index) => {
    const effect = exactRecord(effectValue, [
      'logicalName', 'kind', 'operation', 'pathParts', 'contentDigest',
      'contentBytes', 'mode'
    ], `Workflow transition effect ${index}`);
    const parts = denseArray(
      effect.pathParts,
      32,
      `Workflow transition effect ${index} path`
    );
    if (typeof effect.logicalName !== 'string' ||
        ![
          'managed-core',
          'desired-state',
          'framework',
          'repository-placeholder',
          'manifest'
        ].includes(
          String(effect.kind)
        ) ||
        !['write', 'delete'].includes(String(effect.operation)) ||
        parts.length === 0 ||
        parts.some(part => typeof part !== 'string' || part.length === 0)) {
      invalid(`Workflow transition effect ${index} identity is invalid.`);
    }
    const key = parts.join('/');
    if (paths.has(key)) {
      invalid('Workflow transition effects contain a duplicate path.');
    }
    paths.add(key);
    if (effect.operation === 'write') {
      sha256(
        effect.contentDigest,
        `Workflow transition effect ${index} content digest`
      );
      if (!Number.isSafeInteger(effect.contentBytes) ||
          Number(effect.contentBytes) < 0 ||
          !Number.isSafeInteger(effect.mode) ||
          Number(effect.mode) < 0 || Number(effect.mode) > 0o7777) {
        invalid(`Workflow transition effect ${index} metadata is invalid.`);
      }
    } else if (effect.contentDigest !== null ||
        effect.contentBytes !== null || effect.mode !== null) {
      invalid(`Workflow transition effect ${index} deletion is invalid.`);
    }
  });
  const manifestIndex = effects.findIndex(effect =>
    isRecord(effect) && effect.kind === 'manifest'
  );
  const last = effects.at(-1) as Record<string, unknown> | undefined;
  if (operation === 'workflow-transition' &&
      (last?.kind !== 'manifest' ||
        canonicalJson(last.pathParts) !==
          canonicalJson(['liftoff.manifest.json'])) ||
      operation === 'agent-repair' &&
      manifestIndex >= 0 &&
      manifestIndex !== effects.length - 1) {
    invalid('Workflow or agent repair manifest effect must be last when present.');
  }
  const recovery = exactRecord(execution.recovery, [
    'transactionKind', 'journalPathParts', 'selectedBy'
  ], 'Workflow transition recovery');
  if (recovery.transactionKind !== 'workflow-transition' ||
      recovery.selectedBy !==
        'plan-fingerprint-and-observed-transaction-digest' ||
      canonicalJson(recovery.journalPathParts) !==
        canonicalJson(workflowTransitionTransactionPathParts)) {
    invalid('Workflow transition recovery identity is invalid.');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validatePlan(
  value: unknown,
  projectRoot: string,
  now: Date,
  allowExpired = false
): WorkflowTransitionPlanReport {
  if (!isRecord(value)) invalid('Workflow transition plan must be an object.');
  const currentFields = [
    'schemaVersion', 'kind', 'operation', 'repairAgents', 'projectRoot',
    'source', 'target',
    'governanceProfile', 'inputs', 'frameworkInventory',
    'targetFrameworkInventory', 'preparation', 'checks',
    'applicationFiles', 'gitHistory', 'frameworkHistory', 'execution',
    'createdAt', 'expiresAt', 'fingerprint'
  ];
  const legacy = value.schemaVersion === 2 &&
    !Object.hasOwn(value, 'operation') &&
    !Object.hasOwn(value, 'repairAgents');
  const exact = legacy
    ? currentFields.filter(field =>
        field !== 'operation' && field !== 'repairAgents'
      )
    : currentFields;
  if (Object.keys(value).length !== exact.length ||
      exact.some(field => !Object.hasOwn(value, field))) {
    invalid('Workflow transition plan fields are invalid.');
  }
  const report = (legacy
    ? Object.defineProperties(structuredClone(value), {
        operation: {
          value: 'workflow-transition' as const,
          enumerable: false
        },
        repairAgents: {
          value: Object.freeze([] as CodingAgentId[]),
          enumerable: false
        }
      })
    : value) as unknown as WorkflowTransitionPlanReport;
  if ((!legacy &&
        report.schemaVersion !== workflowTransitionPlanSchemaVersion) ||
      report.kind !== 'liftoff-workflow-transition-plan' ||
      !['workflow-transition', 'agent-repair'].includes(report.operation) ||
      report.projectRoot !== projectRoot ||
      report.applicationFiles !== 'preserved' ||
      report.gitHistory !== 'preserved' ||
      report.frameworkHistory !== 'preserved') {
    invalid('Workflow transition plan identity or preservation boundary is invalid.');
  }
  validateSelection(report.source, true);
  validateSelection(report.target, false);
  const repairAgents = projectCatalog.canonicalizeCodingAgents([
    ...report.repairAgents
  ]).agents.map(agent => agent.id);
  if (canonicalJson(repairAgents) !== canonicalJson(report.repairAgents) ||
      (report.operation === 'agent-repair'
        ? repairAgents.length === 0 ||
          repairAgents.some(agent => !report.target.agents.includes(agent))
        : repairAgents.length !== 0)) {
    invalid('Workflow transition repair-agent identity is invalid.');
  }
  if (report.operation === 'agent-repair' &&
      (report.source.workflow !== report.target.workflow ||
        report.source.agents.some(agent =>
          !report.target.agents.includes(agent)
        ) ||
        report.target.agents.some(agent =>
          !report.source.agents.includes(agent) &&
          !repairAgents.includes(agent)
        ) ||
        report.source.defaultAgent !== report.target.defaultAgent &&
        (report.target.defaultAgent === null ||
          !repairAgents.includes(report.target.defaultAgent)))) {
    invalid('Agent repair must preserve its workflow and every existing agent.');
  }
  if (!['none', 'single-maintainer-gitflow', 'team-gitflow'].includes(
    report.governanceProfile
  )) {
    invalid('Workflow transition governance profile is invalid.');
  }
  validateInputs(report.inputs);
  validateFrameworkInventory(report.frameworkInventory, report.source);
  validateTargetFrameworkInventory(
    report.targetFrameworkInventory,
    report.target
  );
  validatePreparation(report.preparation, report.target);
  validateChecks(report.checks, report.target.workflow);
  validateExecution(
    report.execution,
    report.source,
    report.target,
    report.operation
  );
  if (report.execution.status === 'ready-for-file-approval' &&
      (report.target.workflow === 'manual'
        ? report.preparation.status !== 'not-required'
        : report.preparation.status !== 'ready')) {
    invalid('Workflow transition execution lacks its exact preparation state.');
  }
  validateFingerprint(value);
  const created = Date.parse(report.createdAt);
  const expires = Date.parse(report.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) ||
      expires - created !== workflowTransitionPlanLifetimeMs ||
      created > now.getTime() ||
      !allowExpired && expires <= now.getTime()) {
    invalid('Workflow transition plan is future-dated, expired, or has an invalid lifetime.');
  }
  return legacy
    ? deepFreeze(report)
    : deepFreeze(structuredClone(report));
}

export async function prepareWorkflowTransitionPlan(
  projectRoot: string,
  target: WorkflowTransitionTarget,
  options: {
    readonly agents?: readonly string[];
    readonly defaultAgent?: string;
    readonly now: Date;
    readonly storage?: UpdatePreviewOptions;
    readonly runner?: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly workstationProbe?: WorkstationProbeOptions;
    readonly workstationNoProgressStore?: WorkstationNoProgressStore;
    readonly installTools?: boolean;
    readonly configureOpenSpecProfile?: boolean;
    readonly agentRepair?: boolean;
    readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
    readonly authorizeTool?:
      WorkflowTransitionPreparationOptions['authorizeTool'];
    readonly authorizeOpenSpecProfile?:
      WorkflowTransitionPreparationOptions['authorizeOpenSpecProfile'];
    readonly onCommand?: (command: string) => void;
    readonly onMachineCommand?: (command: string) => void;
  }
): Promise<{
  readonly plan: WorkflowTransitionPlanReport;
  readonly path: string;
  readonly machineChanges: readonly string[];
}> {
  const manifestSnapshot = await readInput(
    projectRoot, ['liftoff.manifest.json'], true
  );
  const configSnapshot = await readInput(
    projectRoot, ['liftoff.config.json'], false
  );
  const manifest = parseProjectManifest(
    JSON.parse(manifestSnapshot.content!.toString('utf8')) as unknown
  );
  if (manifest.artifactVersion !== 8) {
    invalid('Workflow transitions require a current manifest-v8 project; run the supported update first.');
  }
  const agentRepair = options.agentRepair === true;
  if (agentRepair && target !== manifest.project.specWorkflow) {
    invalid('Agent repair cannot change the recorded development workflow.');
  }
  const selection = targetSelection(
    manifest,
    target,
    options.agents,
    options.defaultAgent,
    agentRepair ? 'additive' : 'replace'
  );
  const repairAgents = agentRepair
    ? projectCatalog.canonicalizeCodingAgents([
        ...(options.agents ?? []),
        ...(options.defaultAgent ? [options.defaultAgent] : [])
      ]).agents.map(agent => agent.id)
    : [];
  if (agentRepair && repairAgents.length === 0) {
    invalid(
      'Agent repair requires at least one explicit agent or Spec Kit default.'
    );
  }
  const source = Object.freeze({
    workflow: manifest.project.specWorkflow,
    agents: Object.freeze([...manifest.project.agents]),
    defaultAgent: manifest.project.defaultAgent ?? null,
    frameworkState: manifest.framework.state,
    frameworkContractVersion: manifest.framework.state === 'initialized'
      ? manifest.framework.contractVersion
      : null
  });
  const current = source.workflow === selection.target.workflow &&
    canonicalJson(source.agents) ===
      canonicalJson(selection.target.agents) &&
    source.defaultAgent === selection.target.defaultAgent;
  if (!agentRepair &&
      !current &&
      source.workflow === selection.target.workflow &&
      selection.target.workflow !== 'manual') {
    invalid(
      'Changing agents within the same external framework is not a workflow transition; reconcile that framework through its reviewed lifecycle.'
    );
  }
  const createdAt = options.now.toISOString();
  const expiresAt = new Date(
    options.now.getTime() + workflowTransitionPlanLifetimeMs
  ).toISOString();
  const inputs = Object.freeze([
    inputReport(manifestSnapshot),
    inputReport(configSnapshot)
  ]);
  const frameworkInventory = source.workflow === 'manual'
    ? await inspectFrameworkInventory(projectRoot, source.workflow)
    : source.frameworkState === 'initialized'
      ? await inspectFrameworkInventory(projectRoot, source.workflow)
      : unavailableFrameworkInventory(source.workflow);
  const targetFrameworkInventory = agentRepair
    ? frameworkInventory.status === 'preserved' ||
        frameworkInventory.status === 'not-applicable'
      ? frameworkInventory
      : await inspectTargetFrameworkInventory(
          projectRoot,
          selection.target.workflow
        )
    : current
    ? source.workflow === 'manual'
      ? await inspectTargetFrameworkInventory(
          projectRoot,
          selection.target.workflow
        )
      : frameworkInventory.status === 'preserved'
        ? frameworkInventory
        : await inspectTargetFrameworkInventory(
            projectRoot,
            selection.target.workflow
          )
    : await inspectTargetFrameworkInventory(
        projectRoot,
        selection.target.workflow
      );
  if (!agentRepair &&
      !current &&
      selection.target.workflow !== 'manual' &&
      frameworkInventory.status === 'preserved' &&
      frameworkInventory.workflow !== selection.target.workflow &&
      frameworkInventory.activeWork.identifiers.length > 0) {
    invalid(
      `Active ${frameworkInventory.workflow} work overlaps the requested workflow transition: ${frameworkInventory.activeWork.identifiers.join(', ')}. Reconcile it before preparing another framework.`
    );
  }
  const runner = options.runner ?? new NodeCommandRunner();
  const preparationResult = current && !agentRepair
    ? Object.freeze({
        report: Object.freeze({
          status: 'not-required' as const,
          tools: Object.freeze([]),
          openSpecProfile: Object.freeze({
            status: 'not-applicable' as const,
            profile: null,
            delivery: null,
            workflows: Object.freeze([]),
            differences: Object.freeze([]),
            commands: Object.freeze([])
          })
        }),
        machineChanges: Object.freeze([])
      })
    : await prepareWorkflowTransitionEnvironment(
        selection.plan,
        {
          runner,
          cwd: projectRoot,
          env: options.env,
          workstationProbe: options.workstationProbe,
          workstationNoProgressStore:
            options.workstationNoProgressStore,
          installTools: options.installTools,
          configureOpenSpecProfile:
            options.configureOpenSpecProfile,
          streamOptions: options.streamOptions,
          authorizeTool: options.authorizeTool,
          authorizeOpenSpecProfile:
            options.authorizeOpenSpecProfile,
          onCommand: options.onCommand,
          onMachineCommand: options.onMachineCommand
        }
      );
  const checks = Object.freeze([
    Object.freeze({
      id: 'source-inputs-current' as const,
      status: 'required' as const
    }),
    Object.freeze({
      id: 'source-history-preserved' as const,
      status: 'required' as const
    }),
    Object.freeze({
      id: 'active-work-reconciled' as const,
      status: 'required' as const
    }),
    Object.freeze({
      id: 'target-framework-staged' as const,
      status: target === 'manual'
        ? 'not-applicable' as const
        : 'required' as const
    }),
    Object.freeze({
      id: 'target-integrations-verified' as const,
      status: 'required' as const
    })
  ]);
  const execution = agentRepair
    ? preparationResult.report.status === 'ready' ||
        selection.target.workflow === 'manual'
      ? (await buildAgentRepairExecution(
          projectRoot,
          manifest,
          manifestSnapshot,
          configSnapshot,
          selection,
          source,
          targetFrameworkInventory,
          repairAgents,
          {
            runner,
            env: options.env,
            streamOptions: options.streamOptions,
            onCommand: options.onCommand
          }
        ))?.report ??
          Object.freeze({ status: 'not-required' as const })
      : Object.freeze({ status: 'unavailable' as const })
    : current
      ? Object.freeze({ status: 'not-required' as const })
      : source.workflow !== 'manual' &&
        source.frameworkState === 'initialized' &&
        selection.target.workflow === 'manual'
      ? (await buildManualExecution(
          projectRoot,
          manifest,
          manifestSnapshot,
          configSnapshot,
          selection
        )).report
      : selection.target.workflow !== 'manual' &&
          preparationResult.report.status === 'ready'
        ? (await buildExternalExecution(
            projectRoot,
            manifest,
            manifestSnapshot,
            configSnapshot,
            selection,
            frameworkInventory,
            targetFrameworkInventory,
            {
              runner,
              env: options.env,
              streamOptions: options.streamOptions,
              onCommand: options.onCommand
            }
          )).report
      : Object.freeze({ status: 'unavailable' as const });
  const unsigned = {
    schemaVersion: workflowTransitionPlanSchemaVersion,
    kind: 'liftoff-workflow-transition-plan' as const,
    operation: agentRepair
      ? 'agent-repair' as const
      : 'workflow-transition' as const,
    repairAgents: Object.freeze([...repairAgents]),
    projectRoot,
    source,
    target: selection.target,
    governanceProfile: manifest.governance.profile,
    inputs,
    frameworkInventory,
    targetFrameworkInventory,
    preparation: preparationResult.report,
    checks,
    applicationFiles: 'preserved' as const,
    gitHistory: 'preserved' as const,
    frameworkHistory: 'preserved' as const,
    execution,
    createdAt,
    expiresAt
  };
  const plan = Object.freeze({
    ...unsigned,
    fingerprint: canonicalSha256(unsigned)
  });
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'workflow-transition-plan', options.storage
  ).write(plan.fingerprint, plan);
  return {
    plan,
    path: stored.path,
    machineChanges: preparationResult.machineChanges
  };
}

export async function readWorkflowTransitionPlan(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<WorkflowTransitionPlanReport> {
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'workflow-transition-plan', storage
  ).read(fingerprint);
  if (!stored) invalid('No matching workflow transition plan exists for this project.');
  const plan = validatePlan(stored.value, stored.projectRoot, now);
  if (plan.fingerprint !== fingerprint) {
    invalid('Workflow transition plan storage key does not match its fingerprint.');
  }
  return plan;
}

export async function readWorkflowTransitionPlanIfPresent(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions,
  allowExpired = false
): Promise<WorkflowTransitionPlanReport | undefined> {
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'workflow-transition-plan', storage
  ).read(fingerprint);
  if (!stored) return undefined;
  const plan = validatePlan(
    stored.value,
    stored.projectRoot,
    now,
    allowExpired
  );
  if (plan.fingerprint !== fingerprint) {
    invalid(
      'Workflow transition plan storage key does not match its fingerprint.'
    );
  }
  return plan;
}

export async function readWorkflowTransitionPlanForRecovery(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<WorkflowTransitionPlanReport> {
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'workflow-transition-plan', storage
  ).read(fingerprint);
  if (!stored) {
    invalid('No matching workflow transition plan exists for this project.');
  }
  const plan = validatePlan(stored.value, stored.projectRoot, now, true);
  if (plan.fingerprint !== fingerprint) {
    invalid(
      'Workflow transition plan storage key does not match its fingerprint.'
    );
  }
  return plan;
}

export async function assertWorkflowTransitionPlanCurrent(
  plan: WorkflowTransitionPlanReport,
  options: {
    readonly runner?: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly workstationProbe?: WorkstationProbeOptions;
  } = {}
): Promise<void> {
  const snapshots: ProjectFileSnapshot[] = [];
  for (const input of plan.inputs) {
    const snapshot = await readInput(
      plan.projectRoot, input.pathParts,
      input.pathParts.join('/') === 'liftoff.manifest.json'
    );
    snapshots.push(snapshot);
    const current = inputReport(snapshot);
    if (canonicalJson(current) !== canonicalJson(input)) {
      invalid(`Workflow transition input ${input.pathParts.join('/')} changed after preview.`);
    }
  }
  const manifestContent = snapshots[0]?.content;
  if (!manifestContent) {
    invalid('Workflow transition manifest input is unavailable.');
  }
  const manifest = parseProjectManifest(
    JSON.parse(manifestContent.toString('utf8')) as unknown
  );
  if (manifest.artifactVersion !== 8) {
    invalid('Workflow transition manifest changed to an unsupported version after preview.');
  }
  await assertWorkflowTransitionFrameworkPreserved(plan);
  await assertWorkflowTransitionTargetFrameworkCurrent(plan);
  const selected = targetSelection(
    manifest,
    plan.target.workflow,
    plan.target.agents,
    plan.target.defaultAgent ?? undefined
  );
  const currentTarget = selected.target;
  if (canonicalJson(currentTarget) !== canonicalJson(plan.target)) {
    invalid('Workflow transition target plugin resolution changed after preview.');
  }
  if (plan.preparation.status !== 'not-required') {
    const currentPreparation = await prepareWorkflowTransitionEnvironment(
      selected.plan,
      {
        runner: options.runner ?? new NodeCommandRunner(),
        cwd: plan.projectRoot,
        env: options.env,
        workstationProbe: options.workstationProbe
      }
    );
    if (canonicalJson(currentPreparation.report) !==
        canonicalJson(plan.preparation)) {
      invalid(
        'Workflow transition tool or global-profile preparation changed after preview.'
      );
    }
  }
}

export async function assertWorkflowTransitionFrameworkPreserved(
  plan: WorkflowTransitionPlanReport
): Promise<void> {
  const current = plan.frameworkInventory.status === 'preserved'
    ? await inspectFrameworkInventory(
        plan.projectRoot,
        plan.frameworkInventory.workflow
      )
    : plan.frameworkInventory;
  if (canonicalJson(current) !== canonicalJson(plan.frameworkInventory)) {
    invalid(
      'Workflow framework documents or active work changed after preview; reconcile and create a new plan.'
    );
  }
}

export async function assertWorkflowTransitionTargetFrameworkCurrent(
  plan: WorkflowTransitionPlanReport
): Promise<void> {
  const current = plan.targetFrameworkInventory.status === 'preserved'
    ? await inspectFrameworkInventory(
        plan.projectRoot,
        plan.targetFrameworkInventory.workflow
      )
    : await inspectTargetFrameworkInventory(
        plan.projectRoot,
        plan.target.workflow
      );
  if (canonicalJson(current) !==
      canonicalJson(plan.targetFrameworkInventory)) {
    invalid(
      'Target framework history changed after preview; reconcile and create a new plan.'
    );
  }
}

export async function assertWorkflowTransitionTargetFrameworkCommitted(
  plan: WorkflowTransitionPlanReport
): Promise<void> {
  if (plan.target.workflow === 'manual') {
    if (plan.execution.status === 'ready-for-file-approval' &&
        plan.execution.targetFrameworkCommitInventory !== null) {
      invalid('Manual target cannot have a committed framework inventory.');
    }
    return;
  }
  if (plan.execution.status !== 'ready-for-file-approval' ||
      plan.execution.targetFrameworkCommitInventory === null) {
    invalid('External target commit inventory is unavailable.');
  }
  const current = await inspectFrameworkInventory(
    plan.projectRoot,
    plan.target.workflow
  );
  if (canonicalJson(current) !== canonicalJson(
    plan.execution.targetFrameworkCommitInventory
  )) {
    invalid(
      'Target framework history or committed output changed during transition. ' +
      `Expected ${canonicalJson(plan.execution.targetFrameworkCommitInventory)} ` +
      `but observed ${canonicalJson(current)}.`
    );
  }
}

export async function rebuildWorkflowTransitionExecution(
  plan: WorkflowTransitionPlanReport,
  options: {
    readonly runner?: CommandRunner;
    readonly env?: NodeJS.ProcessEnv;
    readonly streamOptions?: Pick<RunCommandOptions, 'stdout' | 'stderr'>;
    readonly onCommand?: (command: string) => void;
  } = {}
): Promise<WorkflowTransitionExecutionCandidate> {
  if (plan.execution.status !== 'ready-for-file-approval') {
    invalid('The selected workflow transition has no executable file plan.');
  }
  const manifestSnapshot = await readInput(
    plan.projectRoot,
    ['liftoff.manifest.json'],
    true
  );
  const configSnapshot = await readInput(
    plan.projectRoot,
    ['liftoff.config.json'],
    false
  );
  const manifest = parseProjectManifest(
    JSON.parse(manifestSnapshot.content!.toString('utf8')) as unknown
  );
  if (manifest.artifactVersion !== 8) {
    invalid('Workflow transition execution requires a current manifest-v8 project.');
  }
  const selection = targetSelection(
    manifest,
    plan.target.workflow,
    plan.target.agents,
    plan.target.defaultAgent ?? undefined
  );
  const rebuilt = plan.operation === 'agent-repair'
    ? await buildAgentRepairExecution(
        plan.projectRoot,
        manifest,
        manifestSnapshot,
        configSnapshot,
        selection,
        plan.source,
        plan.targetFrameworkInventory,
        plan.repairAgents,
        {
          runner: options.runner ?? new NodeCommandRunner(),
          env: options.env,
          streamOptions: options.streamOptions,
          onCommand: options.onCommand
        }
      )
    : plan.target.workflow === 'manual'
    ? await buildManualExecution(
        plan.projectRoot,
        manifest,
        manifestSnapshot,
        configSnapshot,
        selection
      )
    : await buildExternalExecution(
        plan.projectRoot,
        manifest,
        manifestSnapshot,
        configSnapshot,
        selection,
        plan.frameworkInventory,
        plan.targetFrameworkInventory,
        {
          runner: options.runner ?? new NodeCommandRunner(),
          env: options.env,
          streamOptions: options.streamOptions,
          onCommand: options.onCommand
        }
      );
  if (!rebuilt ||
      canonicalJson(rebuilt.report) !== canonicalJson(plan.execution)) {
    invalid(
      'Workflow transition effects or physical preconditions changed after preview.'
    );
  }
  return rebuilt;
}

export function workflowSelectionMatches(
  plan: WorkflowTransitionPlanReport,
  input: {
    readonly target: WorkflowTransitionTarget;
    readonly agents?: readonly string[];
    readonly defaultAgent?: string;
  }
): boolean {
  if (plan.operation !== 'workflow-transition') return false;
  const agents = input.agents === undefined
    ? undefined
    : projectCatalog.canonicalizeCodingAgents([...input.agents]).agents.map(
        agent => agent.id
      );
  const defaultAgent = input.defaultAgent === undefined
    ? undefined
    : projectCatalog.getCodingAgent(input.defaultAgent)?.id;
  return plan.target.workflow === input.target &&
    (agents === undefined ||
      canonicalJson(plan.target.agents) === canonicalJson(agents)) &&
    (input.defaultAgent === undefined ||
      defaultAgent !== undefined &&
      plan.target.defaultAgent === defaultAgent);
}

export function agentRepairSelectionMatches(
  plan: WorkflowTransitionPlanReport,
  input: {
    readonly agents?: readonly string[];
    readonly defaultAgent?: string;
  }
): boolean {
  if (plan.operation !== 'agent-repair') return false;
  if (input.agents === undefined && input.defaultAgent === undefined) {
    return true;
  }
  const requested = projectCatalog.canonicalizeCodingAgents([
    ...(input.agents ?? []),
    ...(input.defaultAgent ? [input.defaultAgent] : [])
  ]).agents.map(agent => agent.id);
  return canonicalJson(requested) === canonicalJson(plan.repairAgents) &&
    (input.defaultAgent === undefined ||
      projectCatalog.getCodingAgent(input.defaultAgent)?.id ===
        plan.target.defaultAgent);
}

export function isCurrentWorkflowSelection(
  plan: WorkflowTransitionPlanReport
): boolean {
  return plan.source.workflow === plan.target.workflow &&
    canonicalJson(plan.source.agents) === canonicalJson(plan.target.agents) &&
    plan.source.defaultAgent === plan.target.defaultAgent;
}

export function workflowTransitionPlanError(error: unknown): string {
  if (error instanceof PlanValidationError) {
    return error.issues.join(' ');
  }
  if (error instanceof WorkflowTransitionPlanError ||
      error instanceof FileSystemError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Workflow transition planning failed before any project write.';
}
