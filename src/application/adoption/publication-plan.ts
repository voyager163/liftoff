import { createHash } from 'node:crypto';
import {
  inspectAdoptionTransactionCandidate, reviewedAdoptionTransactionPathParts
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import type {
  ProjectFileMutation, ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  canonicalSha256
} from '../../domain/governance/activation/canonical-json.js';
import {
  assertModernRecordData
} from '../../domain/governance/activation/source-values.js';
import {
  denseArray, exactRecord
} from '../../domain/project/manifest/fields.js';
import {
  manifestPathAliasKey
} from '../../domain/project/manifest/layout.js';
import {
  applicationParts
} from '../repair/application-files.js';
import type {
  ApplicationInspectionOptions
} from '../repair/application-preparation-types.js';
import {
  applicationBounds
} from '../repair/application-types.js';
import {
  loadAdoptionCompatibilityPlan
} from './compatibility-plan.js';
import {
  loadAdoptionDestinationPlan
} from './destination-plan.js';
import {
  adoptionVerificationTime, loadAdoptionVerificationAuthority,
  readAdoptionVerificationResult,
  type AdoptionVerificationIdentity
} from './verification-result.js';

export const adoptionPublicationPlanSchemaVersion = 1 as const;

export interface AdoptionPublicationEffect {
  readonly logicalName: string;
  readonly kind: 'managed-core' | 'manifest';
  readonly operation: 'write';
  readonly pathParts: readonly string[];
  readonly contentDigest: string;
  readonly contentBytes: number;
  readonly mode: number;
}

export interface AdoptionPublicationPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-publication-plan';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly compatibilityPlanFingerprint: string;
  readonly verificationPlanFingerprint: string;
  readonly verificationReceiptFingerprint: string;
  readonly inventoryDigest: string;
  readonly targetLayoutDigest: string;
  readonly verificationSnapshotDigest: string;
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
  readonly effects: readonly AdoptionPublicationEffect[];
  readonly application: {
    readonly status: 'preserved-current-bytes-modes-and-paths';
    readonly fileCount: number;
    readonly moveCount: 0;
    readonly referenceUpdateCount: 0;
  };
  readonly manifestPublishedLast: true;
  readonly status: 'ready-for-file-approval';
  readonly requiredPermissions: readonly ['file-transaction'];
  readonly approval: 'not-requested';
  readonly transaction: 'not-started';
  readonly recovery: {
    readonly transactionKind: 'adoption';
    readonly journalPathParts: readonly string[];
    readonly selectedBy: 'publication-plan-fingerprint-and-observed-transaction-digest';
  };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly limitations: readonly string[];
  readonly fingerprint: string;
}

/** Exact project bytes are deliberately non-enumerable and are rebuilt from current inputs. */
export interface AdoptionPublicationPlan {
  readonly report: AdoptionPublicationPlanReport;
  readonly mutations: readonly ProjectFileMutation[];
  readonly preconditions: readonly ProjectFileSnapshot[];
}

export interface AdoptionPublicationPlanOptions {
  readonly storage?: UpdatePreviewOptions;
  readonly inspection?: ApplicationInspectionOptions;
}

export interface SavedAdoptionPublicationPlan {
  readonly path: string;
  readonly plan: AdoptionPublicationPlan;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} requires a complete lowercase SHA-256 digest.`);
  }
  return value;
}

function snapshotDescriptor(snapshot: ProjectFileSnapshot) {
  return {
    pathParts: [...snapshot.pathParts],
    digest: snapshot.content === undefined ? null : digest(snapshot.content),
    mode: snapshot.mode ?? null
  };
}

function validPublicationEffects(
  effects: readonly AdoptionPublicationEffect[]
): boolean {
  const files = new Set<string>();
  const directories = new Set<string>();
  const spellings = new Map<string, string>();
  for (const effect of effects) {
    const folded = manifestPathAliasKey(effect.pathParts);
    if (files.has(folded) || directories.has(folded)) return false;
    for (let length = 1; length <= effect.pathParts.length; length += 1) {
      const prefix = effect.pathParts.slice(0, length);
      const foldedPrefix = manifestPathAliasKey(prefix);
      const spelling = prefix.join('/');
      const previous = spellings.get(foldedPrefix);
      if (previous !== undefined && previous !== spelling) return false;
      spellings.set(foldedPrefix, spelling);
      if (length < effect.pathParts.length) {
        if (files.has(foldedPrefix)) return false;
        directories.add(foldedPrefix);
      }
    }
    files.add(folded);
  }
  const manifests = effects.filter(effect => effect.kind === 'manifest');
  return manifests.length === 1 &&
    manifests[0]?.pathParts.length === 1 &&
    manifests[0]?.pathParts[0] === 'liftoff.manifest.json' &&
    effects.at(-1) === manifests[0];
}

function privatePlan(
  report: AdoptionPublicationPlanReport,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): AdoptionPublicationPlan {
  const capturedMutations = mutations.map(mutation => mutation.type === 'delete'
    ? { type: 'delete' as const, pathParts: [...mutation.pathParts] }
    : {
        type: 'write' as const,
        pathParts: [...mutation.pathParts],
        content: typeof mutation.content === 'string'
          ? mutation.content
          : Buffer.from(mutation.content),
        ...(mutation.mode === undefined ? {} : { mode: mutation.mode })
      });
  const capturedPreconditions = preconditions.map(snapshot => ({
    pathParts: [...snapshot.pathParts],
    ...(snapshot.content === undefined
      ? {}
      : { content: Buffer.from(snapshot.content) }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  }));
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const plan = {
    report: deepFreeze(structuredClone(report))
  } as AdoptionPublicationPlan;
  Object.defineProperties(plan, {
    mutations: {
      enumerable: false,
      get: () => capturedMutations.map(mutation => mutation.type === 'delete'
        ? { type: 'delete' as const, pathParts: [...mutation.pathParts] }
        : {
            type: 'write' as const,
            pathParts: [...mutation.pathParts],
            content: typeof mutation.content === 'string'
              ? mutation.content
              : Buffer.from(mutation.content),
            ...(mutation.mode === undefined ? {} : { mode: mutation.mode })
          })
    },
    preconditions: {
      enumerable: false,
      get: () => capturedPreconditions.map(snapshot => ({
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

async function buildAdoptionPublicationPlan(
  identity: AdoptionVerificationIdentity,
  source: unknown,
  options: AdoptionPublicationPlanOptions
): Promise<AdoptionPublicationPlan> {
  const now = adoptionVerificationTime(options.storage);
  const receipt = await readAdoptionVerificationResult(
    identity.projectRoot,
    identity.reviewFingerprint,
    identity.destinationPlanFingerprint,
    identity.compatibilityPlanFingerprint,
    identity.verificationPlanFingerprint,
    source,
    options
  );
  if (!receipt) {
    throw new Error(
      'A complete current successful adoption verification receipt is required before file approval.'
    );
  }
  const compatibility = await loadAdoptionCompatibilityPlan(
    identity.projectRoot,
    identity.reviewFingerprint,
    identity.destinationPlanFingerprint,
    identity.compatibilityPlanFingerprint,
    source,
    now,
    options.storage
  );
  const destination = await loadAdoptionDestinationPlan(
    identity.projectRoot,
    identity.reviewFingerprint,
    identity.destinationPlanFingerprint,
    source,
    now,
    options.storage
  );
  if (compatibility.report.fileMappings.some(mapping =>
    mapping.decision !== 'preserve-current-path') ||
      compatibility.report.referenceReviews.some(reference =>
        reference.disposition !== 'unchanged-reviewed')) {
    throw new Error(
      'Application moves and reference updates require a separately staged adoption publication.'
    );
  }
  if (!destination.mutations.length ||
      destination.mutations.some(mutation => mutation.type !== 'write')) {
    throw new Error('Adoption publication requires a finite non-empty exact write set.');
  }
  const manifestIndexes = destination.mutations.flatMap((mutation, index) =>
    mutation.pathParts.length === 1 &&
    mutation.pathParts[0] === 'liftoff.manifest.json'
      ? [index]
      : []
  );
  if (manifestIndexes.length !== 1 ||
      manifestIndexes[0] !== destination.mutations.length - 1) {
    throw new Error('Adoption publication requires the final manifest to be the last exact mutation.');
  }
  const candidate = await inspectAdoptionTransactionCandidate(
    destination.report.projectRoot,
    destination.mutations,
    destination.preconditions
  );
  if (candidate.size.kind !== 'journal' ||
      candidate.size.mutationCount !== destination.mutations.length) {
    throw new Error('Adoption publication transaction measurement is incomplete.');
  }
  const effects = destination.mutations.map((mutation, index) => {
    if (mutation.type !== 'write') {
      throw new Error('Adoption publication cannot delete project files.');
    }
    const observation = destination.report.destinations.find(item =>
      canonicalSha256(item.pathParts) === canonicalSha256(mutation.pathParts));
    const measured = candidate.payload.mutations[index];
    if (!observation || observation.status !== 'absent' ||
        measured?.target.kind !== 'file' ||
        measured.target.sha256 !== digest(mutation.content)) {
      throw new Error('Adoption publication effects differ from the reviewed destination bytes.');
    }
    return {
      logicalName: observation.logicalName,
      kind: observation.kind,
      operation: 'write' as const,
      pathParts: [...mutation.pathParts],
      contentDigest: measured.target.sha256,
      contentBytes: Buffer.byteLength(mutation.content),
      mode: measured.target.mode
    };
  });
  if (!validPublicationEffects(effects)) {
    throw new Error(
      'Adoption publication effects require collision-free portable paths and one exact final manifest.'
    );
  }
  const repeated = await buildRepeatedInputs(identity, source, options, now);
  if (receipt.receiptFingerprint !== repeated.receiptFingerprint ||
      canonicalSha256(compatibility.report) !== repeated.compatibilityDigest ||
      canonicalSha256(destination.report) !== repeated.destinationDigest) {
    throw new Error('Adoption publication inputs changed during transaction measurement.');
  }
  const body = {
    schemaVersion: adoptionPublicationPlanSchemaVersion,
    kind: 'liftoff-adoption-publication-plan' as const,
    readOnly: true as const,
    projectRoot: destination.report.projectRoot,
    reviewFingerprint: identity.reviewFingerprint,
    destinationPlanFingerprint: identity.destinationPlanFingerprint,
    compatibilityPlanFingerprint: identity.compatibilityPlanFingerprint,
    verificationPlanFingerprint: identity.verificationPlanFingerprint,
    verificationReceiptFingerprint: receipt.receiptFingerprint,
    inventoryDigest: compatibility.report.inventoryDigest,
    targetLayoutDigest: compatibility.report.targetLayoutDigest,
    verificationSnapshotDigest: receipt.snapshotDigest,
    preconditionDigest: canonicalSha256(
      destination.preconditions.map(snapshotDescriptor)
    ),
    preconditionCount: destination.preconditions.length,
    transactionCandidateBinding: candidate.binding,
    transactionCandidateDigest: canonicalSha256(candidate.payload),
    transactionSize: {
      mutationCount: candidate.size.mutationCount,
      suppliedPreconditionCount: candidate.size.suppliedPreconditionCount,
      snapshotBytes: candidate.size.snapshotBytes,
      completeJournalBytes: candidate.size.completeJournalBytes
    },
    effects,
    application: {
      status: 'preserved-current-bytes-modes-and-paths' as const,
      fileCount: compatibility.report.fileMappings.length,
      moveCount: 0 as const,
      referenceUpdateCount: 0 as const
    },
    manifestPublishedLast: true as const,
    status: 'ready-for-file-approval' as const,
    requiredPermissions: ['file-transaction'] as const,
    approval: 'not-requested' as const,
    transaction: 'not-started' as const,
    recovery: {
      transactionKind: 'adoption' as const,
      journalPathParts: [...reviewedAdoptionTransactionPathParts],
      selectedBy: 'publication-plan-fingerprint-and-observed-transaction-digest' as const
    },
    createdAt: receipt.completedAt,
    expiresAt: repeated.expiresAt,
    limitations: [
      'This plan authorizes nothing until its exact fingerprint is supplied as file approval.',
      'The transaction writes only the listed absent managed-core and manifest targets; application bytes, modes and paths remain exact preconditions.',
      'The final manifest is written last. A missing manifest never permits a second adoption while the authenticated transaction journal remains.',
      'Deployment configuration, state, credentials, Git history and cloud resources remain outside this publication.'
    ]
  };
  return privatePlan(
    { ...body, fingerprint: canonicalSha256(body) },
    destination.mutations,
    destination.preconditions
  );
}

async function buildRepeatedInputs(
  identity: AdoptionVerificationIdentity,
  source: unknown,
  options: AdoptionPublicationPlanOptions,
  now: Date
): Promise<{
  receiptFingerprint: string;
  compatibilityDigest: string;
  destinationDigest: string;
  expiresAt: string;
}> {
  const receipt = await readAdoptionVerificationResult(
    identity.projectRoot,
    identity.reviewFingerprint,
    identity.destinationPlanFingerprint,
    identity.compatibilityPlanFingerprint,
    identity.verificationPlanFingerprint,
    source,
    options
  );
  if (!receipt) {
    throw new Error('Adoption verification receipt disappeared during publication planning.');
  }
  const compatibility = await loadAdoptionCompatibilityPlan(
    identity.projectRoot,
    identity.reviewFingerprint,
    identity.destinationPlanFingerprint,
    identity.compatibilityPlanFingerprint,
    source,
    now,
    options.storage
  );
  const destination = await loadAdoptionDestinationPlan(
    identity.projectRoot,
    identity.reviewFingerprint,
    identity.destinationPlanFingerprint,
    source,
    now,
    options.storage
  );
  const authority = await loadAdoptionVerificationAuthority(
    identity, source, options.storage, options.inspection
  );
  return {
    receiptFingerprint: receipt.receiptFingerprint,
    compatibilityDigest: canonicalSha256(compatibility.report),
    destinationDigest: canonicalSha256(destination.report),
    expiresAt: authority.consent.expiresAt
  };
}

export async function prepareAdoptionPublicationPlan(
  identity: AdoptionVerificationIdentity,
  source: unknown,
  options: AdoptionPublicationPlanOptions = {}
): Promise<AdoptionPublicationPlan> {
  return buildAdoptionPublicationPlan(structuredClone(identity), source, options);
}

export async function saveAdoptionPublicationPlan(
  identity: AdoptionVerificationIdentity,
  source: unknown,
  options: AdoptionPublicationPlanOptions = {}
): Promise<SavedAdoptionPublicationPlan> {
  const plan = await prepareAdoptionPublicationPlan(identity, source, options);
  const stored = await createScopedUserLocalRecordStore(
    plan.report.projectRoot, 'adoption-publication-plan', options.storage
  ).write(plan.report.fingerprint, plan.report);
  if (stored.projectRoot !== plan.report.projectRoot) {
    throw new Error('Adoption publication-plan storage resolved a different canonical project root.');
  }
  return { path: stored.path, plan };
}

function storedEffect(value: unknown): AdoptionPublicationEffect {
  const fields = exactRecord(value, [
    'logicalName', 'kind', 'operation', 'pathParts', 'contentDigest',
    'contentBytes', 'mode'
  ], 'Saved adoption publication effect');
  if (typeof fields.logicalName !== 'string' || !fields.logicalName ||
      !['managed-core', 'manifest'].includes(String(fields.kind)) ||
      fields.operation !== 'write' ||
      !Number.isSafeInteger(fields.contentBytes) ||
      (fields.contentBytes as number) < 0 ||
      !Number.isSafeInteger(fields.mode) ||
      (fields.mode as number) < 0) {
    throw new Error('Saved adoption publication effect is invalid.');
  }
  const pathParts = applicationParts(fields.pathParts);
  return {
    logicalName: fields.logicalName,
    kind: fields.kind as AdoptionPublicationEffect['kind'],
    operation: 'write',
    pathParts,
    contentDigest: assertDigest(
      fields.contentDigest, 'Saved adoption publication effect'
    ),
    contentBytes: fields.contentBytes as number,
    mode: fields.mode as number
  };
}

export function validateAdoptionPublicationPlanReport(
  value: unknown,
  expectedProjectRoot?: string,
  expectedFingerprint?: string
): AdoptionPublicationPlanReport {
  assertModernRecordData(value, 'Saved adoption publication plan');
  const fields = exactRecord(value, [
    'schemaVersion', 'kind', 'readOnly', 'projectRoot', 'reviewFingerprint',
    'destinationPlanFingerprint', 'compatibilityPlanFingerprint',
    'verificationPlanFingerprint', 'verificationReceiptFingerprint',
    'inventoryDigest', 'targetLayoutDigest', 'verificationSnapshotDigest',
    'preconditionDigest', 'preconditionCount', 'transactionCandidateBinding',
    'transactionCandidateDigest', 'transactionSize', 'effects', 'application',
    'manifestPublishedLast', 'status', 'requiredPermissions', 'approval',
    'transaction', 'recovery', 'createdAt', 'expiresAt', 'limitations',
    'fingerprint'
  ], 'Saved adoption publication plan');
  const transactionSize = exactRecord(fields.transactionSize, [
    'mutationCount', 'suppliedPreconditionCount', 'snapshotBytes',
    'completeJournalBytes'
  ], 'Saved adoption publication transaction size');
  const application = exactRecord(fields.application, [
    'status', 'fileCount', 'moveCount', 'referenceUpdateCount'
  ], 'Saved adoption publication application');
  const recovery = exactRecord(fields.recovery, [
    'transactionKind', 'journalPathParts', 'selectedBy'
  ], 'Saved adoption publication recovery');
  const effects = denseArray(
    fields.effects, applicationBounds.files,
    'Saved adoption publication effects'
  ).map(storedEffect);
  const permissions = denseArray(
    fields.requiredPermissions, 1,
    'Saved adoption publication permissions'
  );
  const limitations = denseArray(
    fields.limitations, 16,
    'Saved adoption publication limitations'
  );
  const journalPathParts = applicationParts(recovery.journalPathParts);
  const createdAt = typeof fields.createdAt === 'string'
    ? Date.parse(fields.createdAt)
    : Number.NaN;
  const expiresAt = typeof fields.expiresAt === 'string'
    ? Date.parse(fields.expiresAt)
    : Number.NaN;
  for (const [entry, label] of [
    [fields.reviewFingerprint, 'review'],
    [fields.destinationPlanFingerprint, 'destination plan'],
    [fields.compatibilityPlanFingerprint, 'compatibility plan'],
    [fields.verificationPlanFingerprint, 'verification plan'],
    [fields.verificationReceiptFingerprint, 'verification receipt'],
    [fields.inventoryDigest, 'inventory'],
    [fields.targetLayoutDigest, 'target layout'],
    [fields.verificationSnapshotDigest, 'verification snapshot'],
    [fields.preconditionDigest, 'precondition'],
    [fields.transactionCandidateBinding, 'transaction candidate binding'],
    [fields.transactionCandidateDigest, 'transaction candidate']
  ] as const) {
    assertDigest(entry, `Saved adoption publication ${label}`);
  }
  if (fields.schemaVersion !== adoptionPublicationPlanSchemaVersion ||
      fields.kind !== 'liftoff-adoption-publication-plan' ||
      fields.readOnly !== true ||
      typeof fields.projectRoot !== 'string' ||
      expectedProjectRoot !== undefined &&
        fields.projectRoot !== expectedProjectRoot ||
      effects.length === 0 ||
      !validPublicationEffects(effects) ||
      !Number.isSafeInteger(fields.preconditionCount) ||
      (fields.preconditionCount as number) < effects.length ||
      !Object.values(transactionSize).every(value =>
        Number.isSafeInteger(value) && (value as number) >= 0) ||
      transactionSize.mutationCount !== effects.length ||
      transactionSize.suppliedPreconditionCount !== fields.preconditionCount ||
      application.status !== 'preserved-current-bytes-modes-and-paths' ||
      !Number.isSafeInteger(application.fileCount) ||
      (application.fileCount as number) < 0 ||
      application.moveCount !== 0 ||
      application.referenceUpdateCount !== 0 ||
      fields.manifestPublishedLast !== true ||
      fields.status !== 'ready-for-file-approval' ||
      permissions.length !== 1 ||
      permissions[0] !== 'file-transaction' ||
      fields.approval !== 'not-requested' ||
      fields.transaction !== 'not-started' ||
      recovery.transactionKind !== 'adoption' ||
      canonicalSha256(journalPathParts) !==
        canonicalSha256(reviewedAdoptionTransactionPathParts) ||
      recovery.selectedBy !==
        'publication-plan-fingerprint-and-observed-transaction-digest' ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= createdAt ||
      limitations.some(entry => typeof entry !== 'string') ||
      typeof fields.fingerprint !== 'string') {
    throw new Error('Saved adoption publication plan is invalid.');
  }
  const { fingerprint, ...body } = fields;
  const selectedFingerprint = assertDigest(
    fingerprint, 'Saved adoption publication plan'
  );
  if (selectedFingerprint !== canonicalSha256(body) ||
      expectedFingerprint !== undefined &&
        selectedFingerprint !== expectedFingerprint) {
    throw new Error('Saved adoption publication plan fingerprint is invalid.');
  }
  const selected: AdoptionPublicationPlanReport = structuredClone({
    schemaVersion: adoptionPublicationPlanSchemaVersion,
    kind: 'liftoff-adoption-publication-plan',
    readOnly: true,
    projectRoot: fields.projectRoot as string,
    reviewFingerprint: fields.reviewFingerprint as string,
    destinationPlanFingerprint: fields.destinationPlanFingerprint as string,
    compatibilityPlanFingerprint: fields.compatibilityPlanFingerprint as string,
    verificationPlanFingerprint: fields.verificationPlanFingerprint as string,
    verificationReceiptFingerprint:
      fields.verificationReceiptFingerprint as string,
    inventoryDigest: fields.inventoryDigest as string,
    targetLayoutDigest: fields.targetLayoutDigest as string,
    verificationSnapshotDigest: fields.verificationSnapshotDigest as string,
    preconditionDigest: fields.preconditionDigest as string,
    preconditionCount: fields.preconditionCount as number,
    transactionCandidateBinding: fields.transactionCandidateBinding as string,
    transactionCandidateDigest: fields.transactionCandidateDigest as string,
    effects,
    application: {
      status: 'preserved-current-bytes-modes-and-paths',
      fileCount: application.fileCount as number,
      moveCount: 0,
      referenceUpdateCount: 0
    },
    transactionSize: {
      mutationCount: transactionSize.mutationCount as number,
      suppliedPreconditionCount:
        transactionSize.suppliedPreconditionCount as number,
      snapshotBytes: transactionSize.snapshotBytes as number,
      completeJournalBytes: transactionSize.completeJournalBytes as number
    },
    manifestPublishedLast: true,
    status: 'ready-for-file-approval',
    requiredPermissions: ['file-transaction'],
    approval: 'not-requested',
    transaction: 'not-started',
    recovery: {
      transactionKind: 'adoption',
      journalPathParts,
      selectedBy:
        'publication-plan-fingerprint-and-observed-transaction-digest'
    },
    createdAt: fields.createdAt as string,
    expiresAt: fields.expiresAt as string,
    limitations: limitations as string[],
    fingerprint: selectedFingerprint
  });
  const deepFreeze = <T>(entry: T): T => {
    if (typeof entry === 'object' && entry !== null && !Object.isFrozen(entry)) {
      for (const child of Object.values(entry)) deepFreeze(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return deepFreeze(selected);
}

export async function readStoredAdoptionPublicationPlan(
  projectRoot: string,
  planFingerprint: string,
  storage?: UpdatePreviewOptions
): Promise<AdoptionPublicationPlanReport> {
  assertDigest(planFingerprint, 'Adoption publication plan');
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'adoption-publication-plan', storage
  ).read(planFingerprint);
  if (!stored) {
    throw new Error(
      'No matching same-project adoption publication plan exists; request a new verified plan.'
    );
  }
  return validateAdoptionPublicationPlanReport(
    stored.value, stored.projectRoot, planFingerprint
  );
}

export async function loadAdoptionPublicationPlan(
  projectRoot: string,
  planFingerprint: string,
  source: unknown,
  options: AdoptionPublicationPlanOptions = {}
): Promise<AdoptionPublicationPlan> {
  const stored = await readStoredAdoptionPublicationPlan(
    projectRoot, planFingerprint, options.storage
  );
  const plan = await prepareAdoptionPublicationPlan({
    projectRoot: stored.projectRoot,
    reviewFingerprint: stored.reviewFingerprint,
    destinationPlanFingerprint: stored.destinationPlanFingerprint,
    compatibilityPlanFingerprint: stored.compatibilityPlanFingerprint,
    verificationPlanFingerprint: stored.verificationPlanFingerprint
  }, source, options);
  if (plan.report.fingerprint !== planFingerprint ||
      canonicalSha256(plan.report) !== canonicalSha256(stored)) {
    throw new Error(
      'Adoption publication plan is invalid, stale or bound to different verified inputs.'
    );
  }
  return plan;
}
