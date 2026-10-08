import { createHash } from 'node:crypto';
import { readBoundProjectFileSnapshot } from '../../adapters/filesystem/bound-project-files.js';
import {
  createScopedUserLocalRecordStore,
  type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import {
  canonicalJson,
  canonicalSha256,
  isRecord
} from '../../domain/governance/activation/canonical-json.js';
import type { CodingAgentId } from '../../domain/project/contracts.js';
import { FileSystemError } from '../../domain/project/errors.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { PlanValidationError } from '../../domain/project/planning.js';
import { projectCatalog } from '../project/catalog.js';
import { buildCurrentProjectPlan } from '../project/planning.js';
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
  readonly effects: 'not-authorized';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export class WorkflowTransitionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTransitionPlanError';
  }
}

const maximumInputBytes = 2 * 1024 * 1024;

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
  return {
    plan,
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
  now: Date
): WorkflowTransitionPlanReport {
  if (!isRecord(value)) invalid('Workflow transition plan must be an object.');
  const exact = [
    'schemaVersion', 'kind', 'projectRoot', 'source', 'target',
    'governanceProfile', 'inputs', 'checks', 'applicationFiles', 'gitHistory',
    'frameworkHistory', 'effects', 'createdAt', 'expiresAt', 'fingerprint'
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
      report.frameworkHistory !== 'preserved' ||
      report.effects !== 'not-authorized') {
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
  validateChecks(report.checks, report.target.workflow);
  validateFingerprint(report);
  const created = Date.parse(report.createdAt);
  const expires = Date.parse(report.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) ||
      expires - created !== workflowTransitionPlanLifetimeMs ||
      created > now.getTime() || expires <= now.getTime()) {
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
  const unsigned = {
    schemaVersion: workflowTransitionPlanSchemaVersion,
    kind: 'liftoff-workflow-transition-plan' as const,
    projectRoot,
    source,
    target: selection.target,
    governanceProfile: manifest.governance.profile,
    inputs,
    checks,
    applicationFiles: 'preserved' as const,
    gitHistory: 'preserved' as const,
    frameworkHistory: 'preserved' as const,
    effects: 'not-authorized' as const,
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
  return 'Workflow transition planning failed before any project write.';
}
