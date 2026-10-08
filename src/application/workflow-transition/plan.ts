import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
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
import type {
  ProjectFileMutation,
  ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  canonicalJson,
  canonicalSha256,
  isRecord
} from '../../domain/governance/activation/canonical-json.js';
import type { CodingAgentId } from '../../domain/project/contracts.js';
import { FileSystemError } from '../../domain/project/errors.js';
import {
  readManifestPluginMetadata
} from '../../domain/project/manifest/plugins.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { PlanValidationError } from '../../domain/project/planning.js';
import { renderLiftoffConfig } from '../../generators/common/base.js';
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

export const workflowTransitionPlanSchemaVersion = 1 as const;
export const workflowTransitionPlanLifetimeMs = 30 * 60 * 1000;

export type WorkflowTransitionTarget = 'openspec' | 'spec-kit' | 'manual';

export interface WorkflowTransitionInput {
  readonly pathParts: readonly string[];
  readonly present: boolean;
  readonly digest: string | null;
  readonly bytes: number | null;
  readonly mode: number | null;
}

export interface WorkflowTransitionPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-workflow-transition-plan';
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
  readonly frameworkInventory:
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
  readonly kind: 'managed-core' | 'desired-state' | 'manifest';
  readonly operation: 'write' | 'delete';
  readonly pathParts: readonly string[];
  readonly contentDigest: string | null;
  readonly contentBytes: number | null;
  readonly mode: number | null;
}

export interface WorkflowTransitionExecutionReport {
  readonly status: 'ready-for-file-approval';
  readonly transition: 'external-framework-to-manual';
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
  readonly frameworkDocuments: 'preserved-on-disk';
  readonly sharedTools: 'unchanged';
  readonly targetLocalReadiness:
    'manual-native-framework-inapplicable';
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
): Promise<WorkflowTransitionPlanReport['frameworkInventory']> {
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
          activeWork.push(entry.name);
        } else if (entry.name !== '.gitkeep') {
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
  requestedDefaultAgent?: string
) {
  const agents = requestedAgents === undefined
    ? [...manifest.project.agents]
    : requestedAgents.map(agent => agent.trim());
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
          defaultAgent: requestedDefaultAgent ??
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

function validateFingerprint(report: WorkflowTransitionPlanReport): void {
  const { fingerprint, ...unsigned } = report;
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) ||
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
  target: WorkflowTransitionPlanReport['target']
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
    'frameworkDocuments', 'sharedTools', 'targetLocalReadiness', 'recovery'
  ], 'Workflow transition execution');
  if (execution.status !== 'ready-for-file-approval' ||
      execution.transition !== 'external-framework-to-manual' ||
      source.workflow === 'manual' || source.frameworkState !== 'initialized' ||
      target.workflow !== 'manual' ||
      execution.manifestPublishedLast !== true ||
      execution.frameworkDocuments !== 'preserved-on-disk' ||
      execution.sharedTools !== 'unchanged' ||
      execution.targetLocalReadiness !==
        'manual-native-framework-inapplicable') {
    invalid('Workflow transition executable identity is invalid.');
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
        !['managed-core', 'desired-state', 'manifest'].includes(
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
  const last = effects.at(-1) as Record<string, unknown> | undefined;
  if (last?.kind !== 'manifest' ||
      canonicalJson(last.pathParts) !==
        canonicalJson(['liftoff.manifest.json'])) {
    invalid('Workflow transition manifest effect must be last.');
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
  const exact = [
    'schemaVersion', 'kind', 'projectRoot', 'source', 'target',
    'governanceProfile', 'inputs', 'frameworkInventory', 'checks',
    'applicationFiles', 'gitHistory', 'frameworkHistory', 'execution',
    'createdAt', 'expiresAt', 'fingerprint'
  ];
  if (Object.keys(value).length !== exact.length ||
      exact.some(field => !Object.hasOwn(value, field))) {
    invalid('Workflow transition plan fields are invalid.');
  }
  const report = value as unknown as WorkflowTransitionPlanReport;
  if (report.schemaVersion !== workflowTransitionPlanSchemaVersion ||
      report.kind !== 'liftoff-workflow-transition-plan' ||
      report.projectRoot !== projectRoot ||
      report.applicationFiles !== 'preserved' ||
      report.gitHistory !== 'preserved' ||
      report.frameworkHistory !== 'preserved') {
    invalid('Workflow transition plan identity or preservation boundary is invalid.');
  }
  validateSelection(report.source, true);
  validateSelection(report.target, false);
  if (!['none', 'single-maintainer-gitflow', 'team-gitflow'].includes(
    report.governanceProfile
  )) {
    invalid('Workflow transition governance profile is invalid.');
  }
  validateInputs(report.inputs);
  validateFrameworkInventory(report.frameworkInventory, report.source);
  validateChecks(report.checks, report.target.workflow);
  validateExecution(report.execution, report.source, report.target);
  validateFingerprint(report);
  const created = Date.parse(report.createdAt);
  const expires = Date.parse(report.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) ||
      expires - created !== workflowTransitionPlanLifetimeMs ||
      created > now.getTime() ||
      !allowExpired && expires <= now.getTime()) {
    invalid('Workflow transition plan is future-dated, expired, or has an invalid lifetime.');
  }
  return deepFreeze(structuredClone(report));
}

export async function prepareWorkflowTransitionPlan(
  projectRoot: string,
  target: WorkflowTransitionTarget,
  options: {
    readonly agents?: readonly string[];
    readonly defaultAgent?: string;
    readonly now: Date;
    readonly storage?: UpdatePreviewOptions;
  }
): Promise<{
  readonly plan: WorkflowTransitionPlanReport;
  readonly path: string;
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
  const selection = targetSelection(
    manifest, target, options.agents, options.defaultAgent
  );
  const source = Object.freeze({
    workflow: manifest.project.specWorkflow,
    agents: Object.freeze([...manifest.project.agents]),
    defaultAgent: manifest.project.defaultAgent ?? null,
    frameworkState: manifest.framework.state,
    frameworkContractVersion: manifest.framework.state === 'initialized'
      ? manifest.framework.contractVersion
      : null
  });
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
  const current = source.workflow === selection.target.workflow &&
    canonicalJson(source.agents) ===
      canonicalJson(selection.target.agents) &&
    source.defaultAgent === selection.target.defaultAgent;
  const execution = current
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
      : Object.freeze({ status: 'unavailable' as const });
  const unsigned = {
    schemaVersion: workflowTransitionPlanSchemaVersion,
    kind: 'liftoff-workflow-transition-plan' as const,
    projectRoot,
    source,
    target: selection.target,
    governanceProfile: manifest.governance.profile,
    inputs,
    frameworkInventory,
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
  return { plan, path: stored.path };
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
  plan: WorkflowTransitionPlanReport
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
  const currentTarget = targetSelection(
    manifest,
    plan.target.workflow,
    plan.target.agents,
    plan.target.defaultAgent ?? undefined
  ).target;
  if (canonicalJson(currentTarget) !== canonicalJson(plan.target)) {
    invalid('Workflow transition target plugin resolution changed after preview.');
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

export async function rebuildWorkflowTransitionExecution(
  plan: WorkflowTransitionPlanReport
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
  const rebuilt = await buildManualExecution(
    plan.projectRoot,
    manifest,
    manifestSnapshot,
    configSnapshot,
    selection
  );
  if (canonicalJson(rebuilt.report) !== canonicalJson(plan.execution)) {
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
