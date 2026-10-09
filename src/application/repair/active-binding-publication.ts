import {
  captureProjectFileSnapshot, type ProjectFileMutation,
  type ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  applyReviewedUpdateTransaction, inspectRepairTransactionCandidate,
  reviewedUpdateTargetMode, type ReviewedUpdateTransactionOutcome
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  canonicalSha256, isRecord
} from '../../domain/governance/activation/canonical-json.js';
import {
  manifestActiveLayoutDigest, validateManifestActiveLayout
} from '../../domain/project/manifest/layout.js';
import type {
  ManifestActiveLayout
} from '../../domain/project/contracts.js';
import {
  repairExecutionIdentity, repairSchemaVersions
} from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import {
  parseProjectManifest,
  type SupportedProjectManifest
} from '../project/manifest.js';
import {
  modernProjectSourceInput, resolveModernProjectSourceContext
} from '../project/source-context.js';
import {
  applicationCandidateDigest
} from './application-patch.js';
import {
  applicationDigest, applicationParts, applicationPathFold,
  applicationPathKey
} from './application-files.js';
import {
  applicationBounds, type ApplicationPatchCandidate
} from './application-types.js';
import {
  byteDigest, mutationDescriptors, repairApprovalStore, repairHistoryRoot,
  snapshotDescriptors, type RepairPreview
} from './preview.js';

const planTtlMs = 15 * 60_000;
const publicationFile = 'binding-publication.json';

export interface ActiveBindingChange {
  readonly logicalName: string;
  readonly sourcePathParts: readonly string[];
  readonly targetPathParts: readonly string[];
  readonly targetDigest: string;
  readonly targetMode: number;
}

export interface ActiveBindingPublicationIntent {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-active-binding-publication-intent';
  readonly projectRoot: string;
  readonly applicationPlanFingerprint: string;
  readonly applicationCandidateDigest: string;
  readonly applicationEffectsDigest: string;
  readonly sourceManifestDigest: string;
  readonly targetActiveLayout: ManifestActiveLayout;
  readonly targetActiveLayoutDigest: `sha256:${string}`;
  readonly bindings: readonly ActiveBindingChange[];
}

export interface ActiveBindingPublicationPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-active-binding-publication-plan';
  readonly projectRoot: string;
  readonly applicationPlanFingerprint: string;
  readonly applicationHistoryReceiptDigest: string;
  readonly applicationEffectsDigest: string;
  readonly committedApplicationEffects:
    readonly ActiveBindingCommittedEffect[];
  readonly sourceManifestDigest: string;
  readonly targetManifestDigest: string;
  readonly targetActiveLayoutDigest: `sha256:${string}`;
  readonly bindings: readonly ActiveBindingChange[];
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
  readonly effects: readonly {
    readonly kind: 'repair-history' | 'manifest';
    readonly pathParts: readonly string[];
    readonly contentDigest: string;
    readonly contentBytes: number;
    readonly mode: number;
  }[];
  readonly status: 'ready-for-binding-approval';
  readonly requiredPermissions: readonly ['active-binding-publication'];
  readonly approval: 'not-requested';
  readonly transaction: 'not-started';
  readonly activationEvidence: 'not-issued';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface ActiveBindingPublicationPlan {
  readonly report: ActiveBindingPublicationPlanReport;
  readonly mutations: readonly ProjectFileMutation[];
  readonly preconditions: readonly ProjectFileSnapshot[];
}

export interface ActiveBindingPublicationPreparation {
  readonly status: 'available' | 'complete';
  readonly applicationPlanFingerprint: string;
  readonly plan?: ActiveBindingPublicationPlan;
  readonly path?: string;
  readonly targetActiveLayoutDigest: string;
  readonly committedApplicationEffects:
    readonly ActiveBindingCommittedEffect[];
}

export interface ActiveBindingPublicationOutcome {
  readonly status: 'committed' | 'partial' | 'complete';
  readonly committed: boolean;
  readonly applicationPlanFingerprint: string;
  readonly publicationPlanFingerprint: string;
  readonly transactionDigest: string | null;
  readonly cleanupFailures: readonly string[];
  readonly rollbackFailures: readonly string[];
  readonly targetActiveLayoutDigest: string;
  readonly committedApplicationEffects:
    readonly ActiveBindingCommittedEffect[];
}

export interface ActiveBindingCommittedEffect {
  readonly type: 'write' | 'delete';
  readonly pathParts: readonly string[];
  readonly digest: string | null;
  readonly mode: number | null;
}

interface BindingHistory {
  readonly intent: ActiveBindingPublicationIntent;
  readonly sourceManifest: Buffer;
  readonly receiptDigest: string;
  readonly effects: readonly ActiveBindingCommittedEffect[];
  readonly reviewedAt: string;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} requires a complete lowercase SHA-256 digest.`);
  }
  return value;
}

function exact(
  value: unknown, keys: readonly string[], label: string
): Record<string, unknown> {
  if (!isRecord(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain exactly its schema-1 fields.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' &&
      !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPortableDistinctPaths(
  paths: readonly (readonly string[])[],
  label: string
): void {
  const selected = paths.map(pathParts => {
    const key = applicationPathKey(pathParts);
    return { key, folded: applicationPathFold(key) };
  });
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const a = selected[left]!;
      const b = selected[right]!;
      if (a.folded === b.folded ||
          a.folded.startsWith(`${b.folded}/`) ||
          b.folded.startsWith(`${a.folded}/`)) {
        throw new Error(
          `${label} paths must be portable, distinct files without aliases or prefix collisions.`
        );
      }
    }
  }
}

function changes(value: unknown): ActiveBindingChange[] {
  if (!Array.isArray(value) || value.length < 1 ||
      value.length > applicationBounds.mappings) {
    throw new Error('Active-binding publication requires a bounded non-empty binding set.');
  }
  const names = new Set<string>();
  const sources = new Set<string>();
  const targets = new Set<string>();
  const selected = value.map<ActiveBindingChange>(entry => {
    const item = exact(entry, [
      'logicalName', 'sourcePathParts', 'targetPathParts',
      'targetDigest', 'targetMode'
    ], 'Active-binding change');
    if (typeof item.logicalName !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(item.logicalName) ||
        !Number.isSafeInteger(item.targetMode) ||
        (item.targetMode as number) < 0 ||
        (item.targetMode as number) > 0o777) {
      throw new Error('Active-binding change identity or mode is invalid.');
    }
    const sourcePathParts = applicationParts(item.sourcePathParts);
    const targetPathParts = applicationParts(item.targetPathParts);
    const source = applicationPathKey(sourcePathParts);
    const target = applicationPathKey(targetPathParts);
    if (source === target || names.has(item.logicalName) ||
        sources.has(source) || targets.has(target)) {
      throw new Error('Active-binding changes must be unique exact moves.');
    }
    names.add(item.logicalName);
    sources.add(source);
    targets.add(target);
    return {
      logicalName: item.logicalName,
      sourcePathParts,
      targetPathParts,
      targetDigest: digest(item.targetDigest, 'Active-binding target'),
      targetMode: item.targetMode as number
    };
  });
  assertPortableDistinctPaths(
    selected.flatMap(change => [
      change.sourcePathParts, change.targetPathParts
    ]),
    'Active-binding change'
  );
  return selected;
}

function targetLayout(
  manifest: SupportedProjectManifest,
  selected: readonly ActiveBindingChange[]
): {
  layout: ManifestActiveLayout;
  digest: `sha256:${string}`;
} {
  if (manifest.artifactVersion !== 8) {
    throw new Error('Active-binding publication requires a current manifest v8.');
  }
  const context = resolveModernProjectSourceContext(
    modernProjectSourceInput(manifest)
  );
  const pending = new Map(selected.map(change =>
    [change.logicalName, change] as const));
  const layout = validateManifestActiveLayout({
    ...manifest.activeLayout,
    bindings: manifest.activeLayout.bindings.map(binding => {
      if (binding.kind !== 'artifact') return binding;
      const change = pending.get(binding.logicalName);
      if (!change) return binding;
      if (applicationPathKey(binding.pathParts) !==
          applicationPathKey(change.sourcePathParts)) {
        throw new Error(
          `Active binding ${binding.logicalName} changed before publication intent was recorded.`
        );
      }
      pending.delete(binding.logicalName);
      return { ...binding, pathParts: [...change.targetPathParts] };
    })
  }, context.source.layoutDescriptor);
  if (pending.size) {
    throw new Error('Active-binding publication names an unbound artifact identity.');
  }
  return {
    layout,
    digest: manifestActiveLayoutDigest(
      layout, context.source.layoutDescriptor
    )
  };
}

export function createActiveBindingPublicationIntent(
  manifest: SupportedProjectManifest,
  sourceManifest: Buffer,
  candidate: ApplicationPatchCandidate,
  preview: RepairPreview
): ActiveBindingPublicationIntent | null {
  if (!candidate.scope.activeBindingChanges.length) return null;
  if (manifest.artifactVersion !== 8 ||
      preview.recipe.id !== 'application-active-layout-patch' ||
      preview.projectRoot !== candidate.scope.projectRoot) {
    throw new Error(
      'Only a current active-layout application repair can record binding publication intent.'
    );
  }
  const selected = changes(candidate.scope.activeBindingChanges);
  const target = targetLayout(manifest, selected);
  return Object.freeze({
    schemaVersion: repairSchemaVersions.activeBindingPublication,
    kind: 'liftoff-active-binding-publication-intent',
    projectRoot: preview.projectRoot,
    applicationPlanFingerprint: preview.fingerprint,
    applicationCandidateDigest: applicationCandidateDigest(candidate),
    applicationEffectsDigest: canonicalSha256(
      mutationDescriptors(candidate.mutations)
    ),
    sourceManifestDigest: byteDigest(sourceManifest),
    targetActiveLayout: target.layout,
    targetActiveLayoutDigest: target.digest,
    bindings: Object.freeze(selected.map(change => Object.freeze({
      ...change,
      sourcePathParts: Object.freeze([...change.sourcePathParts]),
      targetPathParts: Object.freeze([...change.targetPathParts])
    })))
  });
}

function validateIntent(
  value: unknown, projectRoot: string, applicationPlanFingerprint: string
): ActiveBindingPublicationIntent {
  const item = exact(value, [
    'schemaVersion', 'kind', 'projectRoot', 'applicationPlanFingerprint',
    'applicationCandidateDigest', 'applicationEffectsDigest',
    'sourceManifestDigest', 'targetActiveLayout',
    'targetActiveLayoutDigest', 'bindings'
  ], 'Active-binding publication intent');
  if (item.schemaVersion !== repairSchemaVersions.activeBindingPublication ||
      item.kind !== 'liftoff-active-binding-publication-intent' ||
      item.projectRoot !== projectRoot ||
      item.applicationPlanFingerprint !== applicationPlanFingerprint) {
    throw new Error('Active-binding publication intent belongs to another repair.');
  }
  const selected = changes(item.bindings);
  const sourceManifestDigest = digest(
    item.sourceManifestDigest, 'Binding source manifest'
  );
  const applicationCandidate = digest(
    item.applicationCandidateDigest, 'Binding application candidate'
  );
  const applicationEffects = digest(
    item.applicationEffectsDigest, 'Binding application effects'
  );
  if (typeof item.targetActiveLayoutDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.targetActiveLayoutDigest)) {
    throw new Error('Active-binding layout digest is invalid.');
  }
  return {
    schemaVersion: 1,
    kind: 'liftoff-active-binding-publication-intent',
    projectRoot,
    applicationPlanFingerprint,
    applicationCandidateDigest: applicationCandidate,
    applicationEffectsDigest: applicationEffects,
    sourceManifestDigest,
    targetActiveLayout: item.targetActiveLayout as ManifestActiveLayout,
    targetActiveLayoutDigest:
      item.targetActiveLayoutDigest as `sha256:${string}`,
    bindings: selected
  };
}

function descriptors(value: unknown): ActiveBindingCommittedEffect[] {
  if (!Array.isArray(value) || value.length < 1 ||
      value.length > applicationBounds.files * 2) {
    throw new Error('Repair history target inventory is invalid.');
  }
  const selected = value.map<ActiveBindingCommittedEffect>(entry => {
    const item = exact(entry, ['type', 'pathParts', 'digest', 'mode'],
      'Repair history target');
    if (item.type !== 'write' && item.type !== 'delete') {
      throw new Error('Repair history target operation is invalid.');
    }
    const pathParts = applicationParts(item.pathParts);
    if (item.type === 'delete') {
      if (item.digest !== null || item.mode !== null) {
        throw new Error('Deleted repair history targets cannot claim bytes.');
      }
      return { type: 'delete', pathParts, digest: null, mode: null };
    }
    if (!Number.isSafeInteger(item.mode) ||
        (item.mode as number) < 0 ||
        (item.mode as number) > 0o777) {
      throw new Error('Repair history target mode is invalid.');
    }
    return {
      type: 'write',
      pathParts,
      digest: digest(item.digest, 'Repair history target'),
      mode: item.mode as number
    };
  });
  assertPortableDistinctPaths(
    selected.map(descriptor => descriptor.pathParts),
    'Repair history target'
  );
  return selected;
}

async function readBindingHistory(
  projectRoot: string, applicationPlanFingerprint: string
): Promise<BindingHistory | null> {
  digest(applicationPlanFingerprint, 'Application repair plan');
  const root = [...repairHistoryRoot, applicationPlanFingerprint];
  const [manifest, receipt] = await Promise.all([
    captureProjectFileSnapshot(projectRoot, [...root, 'manifest.json']),
    captureProjectFileSnapshot(projectRoot, [...root, 'receipt.json'])
  ]);
  if (manifest.content === undefined && receipt.content === undefined) {
    return null;
  }
  if (!receipt.content || receipt.content.length > 1024 * 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(receipt.content.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) ||
      !Object.hasOwn(raw, 'activeBindingPublication')) return null;
  if (!manifest.content ||
      manifest.content.length > 4 * 1024 * 1024) {
    throw new Error('Active-binding repair history is incomplete or oversized.');
  }
  if (raw.schemaVersion !== repairSchemaVersions.history ||
      raw.kind !== 'liftoff-repair-history' ||
      raw.projectRoot !== projectRoot ||
      raw.fingerprint !== applicationPlanFingerprint ||
      raw.activationEvidence !== 'not-issued' ||
      !isRecord(raw.verification) ||
      raw.verification.result !== 'declared-staged-checks-passed' ||
      typeof raw.reviewedAt !== 'string') {
    throw new Error('Active-binding repair history is invalid or unverified.');
  }
  const intent = validateIntent(
    raw.activeBindingPublication,
    projectRoot,
    applicationPlanFingerprint
  );
  if (byteDigest(manifest.content) !== intent.sourceManifestDigest) {
    throw new Error('Preserved source manifest differs from binding intent.');
  }
  const effects = descriptors(raw.target);
  if (canonicalSha256(effects) !== intent.applicationEffectsDigest) {
    throw new Error('Committed application effects differ from binding intent.');
  }
  for (const binding of intent.bindings) {
    const source = applicationPathKey(binding.sourcePathParts);
    const target = applicationPathKey(binding.targetPathParts);
    const removedSource = effects.some(effect =>
      effect.type === 'delete' &&
      applicationPathKey(effect.pathParts) === source);
    const writtenTarget = effects.some(effect =>
      effect.type === 'write' &&
      applicationPathKey(effect.pathParts) === target &&
      effect.digest === binding.targetDigest &&
      effect.mode === binding.targetMode);
    if (!removedSource || !writtenTarget) {
      throw new Error(
        'Active-binding intent differs from the committed move effects.'
      );
    }
  }
  return {
    intent,
    sourceManifest: Buffer.from(manifest.content),
    receiptDigest: byteDigest(receipt.content),
    effects,
    reviewedAt: raw.reviewedAt
  };
}

function bindingReceiptPath(applicationPlanFingerprint: string): string[] {
  return [
    ...repairHistoryRoot, applicationPlanFingerprint, publicationFile
  ];
}

function targetManifestBytes(
  sourceManifest: Buffer,
  intent: ActiveBindingPublicationIntent
): Buffer {
  let raw: unknown;
  try {
    raw = JSON.parse(sourceManifest.toString('utf8')) as unknown;
  } catch {
    throw new Error('Preserved source manifest is invalid JSON.');
  }
  const source = parseProjectManifest(raw);
  if (source.artifactVersion !== 8) {
    throw new Error('Active-binding publication source is not manifest v8.');
  }
  const target = targetLayout(source, intent.bindings);
  if (canonicalSha256(target.layout) !==
        canonicalSha256(intent.targetActiveLayout) ||
      target.digest !== intent.targetActiveLayoutDigest ||
      !isRecord(raw) || !isRecord(raw.governance)) {
    throw new Error('Active-binding target layout differs from repair history.');
  }
  const governance = source.governance.profile === 'none'
    ? raw.governance
    : {
        ...raw.governance,
        activationIdentity: {
          ...source.governance.activationIdentity,
          activeLayoutDigest: target.digest
        }
      };
  const next = {
    ...raw,
    governance,
    activeLayout: target.layout
  };
  const parsed = parseProjectManifest(next);
  if (parsed.artifactVersion !== 8 ||
      canonicalSha256(parsed.projectArtifacts) !==
        canonicalSha256(source.projectArtifacts) ||
      canonicalSha256(parsed.adoptionObservations) !==
        canonicalSha256(source.adoptionObservations)) {
    throw new Error(
      'Active-binding publication changed application provenance.'
    );
  }
  return Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
}

function publicationReceipt(
  history: BindingHistory,
  targetManifestDigest: string
) {
  const intent = history.intent;
  return {
    schemaVersion: 1,
    kind: 'liftoff-active-binding-publication',
    projectRoot: intent.projectRoot,
    applicationPlanFingerprint: intent.applicationPlanFingerprint,
    applicationHistoryReceiptDigest: history.receiptDigest,
    applicationEffectsDigest: intent.applicationEffectsDigest,
    sourceManifestDigest: intent.sourceManifestDigest,
    targetManifestDigest,
    targetActiveLayoutDigest: intent.targetActiveLayoutDigest,
    bindings: intent.bindings,
    activationEvidence: 'not-issued'
  };
}

async function effectPreconditions(
  projectRoot: string,
  effects: readonly ActiveBindingCommittedEffect[]
): Promise<ProjectFileSnapshot[]> {
  const snapshots: ProjectFileSnapshot[] = [];
  for (const effect of effects) {
    const actual = await captureProjectFileSnapshot(
      projectRoot, [...effect.pathParts]
    );
    if (effect.type === 'delete'
      ? actual.content !== undefined
      : actual.content === undefined ||
        applicationDigest(actual.content) !== effect.digest ||
        actual.mode !== effect.mode) {
      throw new Error(
        `Committed application effect changed before binding publication: ${effect.pathParts.join('/')}.`
      );
    }
    snapshots.push(actual);
  }
  return snapshots;
}

function privatePlan(
  report: ActiveBindingPublicationPlanReport,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): ActiveBindingPublicationPlan {
  const plan = { report: deepFreeze(structuredClone(report)) } as
    ActiveBindingPublicationPlan;
  Object.defineProperties(plan, {
    mutations: {
      enumerable: false,
      get: () => mutations.map(mutation => mutation.type === 'delete'
        ? { type: 'delete' as const, pathParts: [...mutation.pathParts] }
        : {
            type: 'write' as const,
            pathParts: [...mutation.pathParts],
            content: Buffer.from(mutation.content),
            ...(mutation.mode === undefined ? {} : { mode: mutation.mode })
          })
    },
    preconditions: {
      enumerable: false,
      get: () => preconditions.map(snapshot => ({
        pathParts: [...snapshot.pathParts],
        ...(snapshot.content === undefined
          ? {}
          : { content: Buffer.from(snapshot.content) }),
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
      }))
    }
  });
  return Object.freeze(plan);
}

function planEffect(
  value: unknown
): ActiveBindingPublicationPlanReport['effects'][number] {
  const item = exact(value, [
    'kind', 'pathParts', 'contentDigest', 'contentBytes', 'mode'
  ], 'Active-binding publication effect');
  if (item.kind !== 'repair-history' && item.kind !== 'manifest' ||
      !Number.isSafeInteger(item.contentBytes) ||
      (item.contentBytes as number) < 1 ||
      (item.contentBytes as number) > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(item.mode) ||
      (item.mode as number) < 0 ||
      (item.mode as number) > 0o777) {
    throw new Error('Active-binding publication effect is invalid.');
  }
  return {
    kind: item.kind,
    pathParts: applicationParts(item.pathParts),
    contentDigest: digest(
      item.contentDigest, 'Active-binding publication effect'
    ),
    contentBytes: item.contentBytes as number,
    mode: item.mode as number
  };
}

async function completed(
  projectRoot: string,
  history: BindingHistory
): Promise<boolean> {
  const receiptPath = bindingReceiptPath(
    history.intent.applicationPlanFingerprint
  );
  const [receipt, manifest] = await Promise.all([
    captureProjectFileSnapshot(projectRoot, receiptPath),
    captureProjectFileSnapshot(projectRoot, ['liftoff.manifest.json'])
  ]);
  if (receipt.content === undefined) return false;
  const target = targetManifestBytes(history.sourceManifest, history.intent);
  const expectedReceipt = Buffer.from(
    `${JSON.stringify(publicationReceipt(history, byteDigest(target)), null, 2)}\n`
  );
  if (!receipt.content.equals(expectedReceipt) ||
      !manifest.content?.equals(target)) {
    throw new Error(
      'Recorded active-binding publication differs from the current manifest.'
    );
  }
  return true;
}

async function buildPlan(
  projectRoot: string,
  applicationPlanFingerprint: string,
  issuedAt: Date
): Promise<ActiveBindingPublicationPlan | null> {
  const history = await readBindingHistory(
    projectRoot, applicationPlanFingerprint
  );
  if (!history) return null;
  if (await completed(projectRoot, history)) return null;
  const manifest = await captureProjectFileSnapshot(
    projectRoot, ['liftoff.manifest.json']
  );
  if (!manifest.content ||
      byteDigest(manifest.content) !== history.intent.sourceManifestDigest) {
    throw new Error(
      'Current manifest changed before active-binding publication.'
    );
  }
  const receiptPath = bindingReceiptPath(applicationPlanFingerprint);
  const receiptBefore = await captureProjectFileSnapshot(
    projectRoot, receiptPath
  );
  if (receiptBefore.content !== undefined) {
    throw new Error('Active-binding publication receipt already exists.');
  }
  const applicationPreconditions = await effectPreconditions(
    projectRoot, history.effects
  );
  const targetManifest = targetManifestBytes(
    history.sourceManifest, history.intent
  );
  const receiptBody = publicationReceipt(
    history, byteDigest(targetManifest)
  );
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptBody, null, 2)}\n`);
  const mutations: ProjectFileMutation[] = [
    {
      type: 'write',
      pathParts: receiptPath,
      content: receiptBytes,
      mode: 0o600
    },
    {
      type: 'write',
      pathParts: ['liftoff.manifest.json'],
      content: targetManifest,
      mode: manifest.mode
    }
  ];
  const preconditions = [
    ...applicationPreconditions,
    receiptBefore,
    manifest
  ];
  const identity = repairExecutionIdentity(
    liftoffVersion, 'application-active-binding-publication'
  );
  const candidate = await inspectRepairTransactionCandidate(
    projectRoot, mutations, preconditions, identity
  );
  const effects = mutations.map((mutation, index) => {
    if (mutation.type !== 'write') {
      throw new Error('Active-binding publication cannot delete files.');
    }
    const measured = candidate.payload.mutations[index]?.target;
    if (measured?.kind !== 'file') {
      throw new Error('Active-binding publication measurement is incomplete.');
    }
    return {
      kind: index === mutations.length - 1
        ? 'manifest' as const
        : 'repair-history' as const,
      pathParts: [...mutation.pathParts],
      contentDigest: measured.sha256,
      contentBytes: Buffer.byteLength(mutation.content),
      mode: measured.mode
    };
  });
  const body = {
    schemaVersion: 1 as const,
    kind: 'liftoff-active-binding-publication-plan' as const,
    projectRoot,
    applicationPlanFingerprint,
    applicationHistoryReceiptDigest: history.receiptDigest,
    applicationEffectsDigest: history.intent.applicationEffectsDigest,
    committedApplicationEffects: history.effects,
    sourceManifestDigest: history.intent.sourceManifestDigest,
    targetManifestDigest: byteDigest(targetManifest),
    targetActiveLayoutDigest: history.intent.targetActiveLayoutDigest,
    bindings: history.intent.bindings,
    preconditionDigest: canonicalSha256(snapshotDescriptors(preconditions)),
    preconditionCount: preconditions.length,
    transactionCandidateBinding: candidate.binding,
    transactionCandidateDigest: canonicalSha256(candidate.payload),
    transactionSize: {
      mutationCount: candidate.size.mutationCount,
      suppliedPreconditionCount: candidate.size.suppliedPreconditionCount,
      snapshotBytes: candidate.size.snapshotBytes,
      completeJournalBytes: candidate.size.completeJournalBytes
    },
    effects,
    status: 'ready-for-binding-approval' as const,
    requiredPermissions: ['active-binding-publication'] as const,
    approval: 'not-requested' as const,
    transaction: 'not-started' as const,
    activationEvidence: 'not-issued' as const,
    createdAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + planTtlMs).toISOString()
  };
  return privatePlan(
    { ...body, fingerprint: canonicalSha256(body) },
    mutations,
    preconditions
  );
}

function validatePlanReport(
  value: unknown,
  projectRoot: string,
  fingerprint: string,
  now: Date
): ActiveBindingPublicationPlanReport {
  const item = exact(value, [
    'schemaVersion', 'kind', 'projectRoot', 'applicationPlanFingerprint',
    'applicationHistoryReceiptDigest', 'applicationEffectsDigest',
    'committedApplicationEffects',
    'sourceManifestDigest', 'targetManifestDigest',
    'targetActiveLayoutDigest', 'bindings', 'preconditionDigest',
    'preconditionCount', 'transactionCandidateBinding',
    'transactionCandidateDigest', 'transactionSize', 'effects', 'status',
    'requiredPermissions', 'approval', 'transaction',
    'activationEvidence', 'createdAt', 'expiresAt', 'fingerprint'
  ], 'Active-binding publication plan');
  const selected = changes(item.bindings);
  const committedApplicationEffects = descriptors(
    item.committedApplicationEffects
  );
  const transactionSize = exact(item.transactionSize, [
    'mutationCount', 'suppliedPreconditionCount', 'snapshotBytes',
    'completeJournalBytes'
  ], 'Active-binding publication transaction size');
  const effects = Array.isArray(item.effects)
    ? item.effects.map(planEffect)
    : [];
  const applicationPlanFingerprint = digest(
    item.applicationPlanFingerprint, 'Active-binding application plan'
  );
  const expectedReceiptPath = bindingReceiptPath(
    applicationPlanFingerprint
  );
  const createdAt = typeof item.createdAt === 'string'
    ? Date.parse(item.createdAt)
    : Number.NaN;
  const expiresAt = typeof item.expiresAt === 'string'
    ? Date.parse(item.expiresAt)
    : Number.NaN;
  const { fingerprint: actual, ...body } = item;
  if (item.schemaVersion !== 1 ||
      item.kind !== 'liftoff-active-binding-publication-plan' ||
      item.projectRoot !== projectRoot ||
      actual !== fingerprint ||
      canonicalSha256(body) !== fingerprint ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      createdAt > now.getTime() ||
      expiresAt - createdAt !== planTtlMs ||
      expiresAt <= now.getTime() ||
      item.status !== 'ready-for-binding-approval' ||
      !Array.isArray(item.requiredPermissions) ||
      item.requiredPermissions.length !== 1 ||
      item.requiredPermissions[0] !== 'active-binding-publication' ||
      item.approval !== 'not-requested' ||
      item.transaction !== 'not-started' ||
      item.activationEvidence !== 'not-issued' ||
      !Number.isSafeInteger(item.preconditionCount) ||
      item.preconditionCount !==
        committedApplicationEffects.length + 2 ||
      !Object.values(transactionSize).every(size =>
        Number.isSafeInteger(size) && (size as number) >= 0) ||
      transactionSize.mutationCount !== 2 ||
      transactionSize.suppliedPreconditionCount !==
        item.preconditionCount ||
      effects.length !== 2 ||
      effects[0]?.kind !== 'repair-history' ||
      canonicalSha256(effects[0].pathParts) !==
        canonicalSha256(expectedReceiptPath) ||
      effects[0].mode !== reviewedUpdateTargetMode(0o600) ||
      effects[1]?.kind !== 'manifest' ||
      effects[1].pathParts.length !== 1 ||
      effects[1].pathParts[0] !== 'liftoff.manifest.json' ||
      effects[1].contentDigest !== item.targetManifestDigest ||
      canonicalSha256(committedApplicationEffects) !==
        item.applicationEffectsDigest) {
    throw new Error('Active-binding publication plan is invalid or expired.');
  }
  assertPortableDistinctPaths(
    effects.map(effect => effect.pathParts),
    'Active-binding publication effect'
  );
  for (const field of [
    'applicationHistoryReceiptDigest',
    'applicationEffectsDigest', 'sourceManifestDigest',
    'targetManifestDigest', 'preconditionDigest',
    'transactionCandidateBinding', 'transactionCandidateDigest'
  ] as const) {
    digest(item[field], `Active-binding plan ${field}`);
  }
  if (typeof item.targetActiveLayoutDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.targetActiveLayoutDigest)) {
    throw new Error('Active-binding plan layout digest is invalid.');
  }
  return deepFreeze(structuredClone({
    ...item,
    applicationPlanFingerprint,
    committedApplicationEffects,
    bindings: selected,
    transactionSize: {
      mutationCount: transactionSize.mutationCount as number,
      suppliedPreconditionCount:
        transactionSize.suppliedPreconditionCount as number,
      snapshotBytes: transactionSize.snapshotBytes as number,
      completeJournalBytes: transactionSize.completeJournalBytes as number
    },
    effects
  }) as unknown as ActiveBindingPublicationPlanReport);
}

export async function readActiveBindingPublicationPlan(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<ActiveBindingPublicationPlanReport | null> {
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'repair-active-binding-plan', storage
  ).read(fingerprint);
  if (!stored) return null;
  return validatePlanReport(stored.value, projectRoot, fingerprint, now);
}

async function loadPlan(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<ActiveBindingPublicationPlan> {
  const report = await readActiveBindingPublicationPlan(
    projectRoot, fingerprint, now, storage
  );
  if (!report) {
    throw new Error(
      'No matching active-binding publication plan exists for this project.'
    );
  }
  const current = await buildPlan(
    projectRoot,
    report.applicationPlanFingerprint,
    new Date(report.createdAt)
  );
  if (!current ||
      canonicalSha256(current.report) !== canonicalSha256(report)) {
    throw new Error(
      'Active-binding publication inputs changed after review.'
    );
  }
  return current;
}

export async function prepareActiveBindingPublication(
  projectRoot: string,
  applicationPlanFingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<ActiveBindingPublicationPreparation | null> {
  const history = await readBindingHistory(
    projectRoot, applicationPlanFingerprint
  );
  if (!history) return null;
  if (await completed(projectRoot, history)) {
    return {
      status: 'complete',
      applicationPlanFingerprint,
      targetActiveLayoutDigest:
        history.intent.targetActiveLayoutDigest,
      committedApplicationEffects: deepFreeze(
        structuredClone(history.effects)
      )
    };
  }
  const plan = await buildPlan(
    projectRoot, applicationPlanFingerprint, now
  );
  if (!plan) {
    throw new Error('Active-binding publication plan could not be rebuilt.');
  }
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'repair-active-binding-plan', storage
  ).write(plan.report.fingerprint, plan.report);
  return {
    status: 'available',
    applicationPlanFingerprint,
    plan,
    path: stored.path,
    targetActiveLayoutDigest: plan.report.targetActiveLayoutDigest,
    committedApplicationEffects:
      plan.report.committedApplicationEffects
  };
}

function transactionOutcome(
  report: ActiveBindingPublicationPlanReport,
  result: ReviewedUpdateTransactionOutcome
): ActiveBindingPublicationOutcome {
  return Object.freeze({
    status: result.committed
      ? result.cleanupFailures.length
        ? 'partial'
        : 'committed'
      : 'partial',
    committed: result.committed,
    applicationPlanFingerprint: report.applicationPlanFingerprint,
    publicationPlanFingerprint: report.fingerprint,
    transactionDigest: result.transactionDigest ?? null,
    cleanupFailures: Object.freeze([...result.cleanupFailures]),
    rollbackFailures: Object.freeze([...result.rollbackFailures]),
    targetActiveLayoutDigest: report.targetActiveLayoutDigest,
    committedApplicationEffects:
      report.committedApplicationEffects
  });
}

export async function publishActiveBindingPlan(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<ActiveBindingPublicationOutcome> {
  const stored = await readActiveBindingPublicationPlan(
    projectRoot, fingerprint, now, storage
  );
  if (!stored) {
    throw new Error(
      'No matching active-binding publication plan exists for this project.'
    );
  }
  const history = await readBindingHistory(
    projectRoot, stored.applicationPlanFingerprint
  );
  if (!history) {
    throw new Error('Active-binding repair history is unavailable.');
  }
  if (await completed(projectRoot, history)) {
    return Object.freeze({
      status: 'complete',
      committed: true,
      applicationPlanFingerprint: stored.applicationPlanFingerprint,
      publicationPlanFingerprint: fingerprint,
      transactionDigest: null,
      cleanupFailures: Object.freeze([]),
      rollbackFailures: Object.freeze([]),
      targetActiveLayoutDigest: stored.targetActiveLayoutDigest,
      committedApplicationEffects:
        stored.committedApplicationEffects
    });
  }
  const plan = await loadPlan(projectRoot, fingerprint, now, storage);
  const identity = repairExecutionIdentity(
    liftoffVersion, 'application-active-binding-publication'
  );
  const result = await applyReviewedUpdateTransaction(
    projectRoot,
    plan.mutations,
    {
      transactionKind: 'repair',
      repairIdentity: identity,
      planFingerprint: fingerprint,
      approvalStore: repairApprovalStore(projectRoot, storage),
      preconditions: plan.preconditions,
      expectedCandidateBinding: plan.report.transactionCandidateBinding,
      validatePlan: async () => {
        const current = await loadPlan(
          projectRoot, fingerprint, now, storage
        );
        if (canonicalSha256(current.report) !==
            canonicalSha256(plan.report)) {
          throw new Error(
            'Active-binding publication changed before commit.'
          );
        }
      }
    }
  );
  if (result.committed) {
    const currentHistory = await readBindingHistory(
      projectRoot, stored.applicationPlanFingerprint
    );
    if (!currentHistory || !await completed(projectRoot, currentHistory)) {
      throw new Error(
        'Active-binding transaction committed without exact manifest readback.'
      );
    }
  }
  return transactionOutcome(plan.report, result);
}
