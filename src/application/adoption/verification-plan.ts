import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  resolveCapturedApplicationVerificationPolicy
} from '../repair/application-preparation.js';
import type {
  ApplicationInspectionOptions
} from '../repair/application-preparation-types.js';
import { assertApplicationToolsCurrent } from '../repair/application-toolchain.js';
import type { ApplicationVerificationPolicy } from '../repair/application-types.js';
import {
  loadAdoptionCompatibilityPlan, type AdoptionCompatibilityPlan
} from './compatibility-plan.js';
import { inspectAdoptionCandidate } from './candidate.js';

export const adoptionVerificationPlanSchemaVersion = 1 as const;

export interface AdoptionVerificationPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-verification-plan';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly compatibilityPlanFingerprint: string;
  readonly inventoryDigest: string;
  readonly targetLayoutDigest: string;
  readonly snapshotDigest: string;
  readonly verificationPolicyDigest: string;
  readonly providerDigest: string;
  readonly toolchainDigest: string;
  readonly status: 'ready-for-independent-permission';
  readonly requiredPermissions: readonly (
    | 'dependency-preparation'
    | 'project-code-execution'
    | 'declared-network'
  )[];
  readonly compatibility: 'not-verified';
  readonly preparation: 'not-performed';
  readonly checkExecution: 'not-performed';
  readonly approval: 'not-requested';
  readonly transaction: 'not-authorized';
  readonly publication: 'not-authorized';
  readonly limitations: readonly string[];
  readonly fingerprint: string;
}

/** Private source bytes and installed-tool identities remain outside report serialization. */
export interface AdoptionVerificationPlan {
  readonly report: AdoptionVerificationPlanReport;
  readonly snapshots: readonly ProjectFileSnapshot[];
  readonly verificationPolicy: ApplicationVerificationPolicy;
}

export interface SavedAdoptionVerificationPlan {
  readonly path: string;
  readonly plan: AdoptionVerificationPlan;
}

function contentDigest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function snapshotDigest(snapshots: readonly ProjectFileSnapshot[]): string {
  return canonicalSha256(snapshots.map(snapshot => ({
    pathParts: [...snapshot.pathParts],
    digest: snapshot.content === undefined ? null : contentDigest(snapshot.content),
    mode: snapshot.mode ?? null
  })));
}

async function stagingBoundary(projectRoot: string): Promise<string> {
  return path.join(
    await realpath(tmpdir()),
    `liftoff-adoption-verification-staging-${canonicalSha256(projectRoot).slice(0, 16)}`
  );
}

function sameCompatibility(
  left: AdoptionCompatibilityPlan,
  right: AdoptionCompatibilityPlan
): boolean {
  return canonicalSha256(left.report) === canonicalSha256(right.report) &&
    snapshotDigest(left.snapshots) === snapshotDigest(right.snapshots);
}

export async function prepareAdoptionVerificationPlan(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions,
  inspection: ApplicationInspectionOptions = {}
): Promise<AdoptionVerificationPlan> {
  const compatibility = await loadAdoptionCompatibilityPlan(
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, source, now, storage
  );
  const candidate = await inspectAdoptionCandidate(compatibility.report.projectRoot, source);
  if (candidate.report.inventory.inspectionDigest !== compatibility.report.inventoryDigest ||
      candidate.report.inventory.target.digest !== compatibility.report.targetLayoutDigest ||
      snapshotDigest(candidate.snapshots) !== snapshotDigest(compatibility.snapshots)) {
    throw new Error('Adoption verification planning observed different compatibility inputs.');
  }
  const boundary = await stagingBoundary(compatibility.report.projectRoot);
  const policy = await resolveCapturedApplicationVerificationPolicy({
    projectRoot: compatibility.report.projectRoot,
    stagingRoot: boundary,
    snapshots: candidate.snapshots,
    directories: candidate.report.inventory.directoryInventory,
    targets: candidate.report.inventory.target.artifacts,
    commands: compatibility.report.verification.commands,
    preparation: compatibility.report.verification.preparation
  }, inspection, undefined, true);
  const repeated = await loadAdoptionCompatibilityPlan(
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, source, now, storage
  );
  if (!sameCompatibility(compatibility, repeated)) {
    throw new Error('Adoption compatibility inputs changed during verification planning.');
  }
  await assertApplicationToolsCurrent(
    compatibility.report.projectRoot, boundary, policy.toolchain
  );
  const permissions = [
    ...(policy.effects.preparation ? ['dependency-preparation' as const] : []),
    'project-code-execution' as const,
    ...(policy.effects.network ? ['declared-network' as const] : [])
  ];
  if (canonicalSha256(permissions) !== canonicalSha256(compatibility.report.requiredPermissions)) {
    throw new Error('Adoption verification effects differ from the exact compatibility permission declaration.');
  }
  const body = {
    schemaVersion: adoptionVerificationPlanSchemaVersion,
    kind: 'liftoff-adoption-verification-plan' as const,
    readOnly: true as const,
    projectRoot: compatibility.report.projectRoot,
    reviewFingerprint,
    destinationPlanFingerprint,
    compatibilityPlanFingerprint,
    inventoryDigest: compatibility.report.inventoryDigest,
    targetLayoutDigest: compatibility.report.targetLayoutDigest,
    snapshotDigest: snapshotDigest(compatibility.snapshots),
    verificationPolicyDigest: canonicalSha256(policy),
    providerDigest: canonicalSha256(policy.preparation),
    toolchainDigest: canonicalSha256(policy.toolchain),
    status: 'ready-for-independent-permission' as const,
    requiredPermissions: permissions,
    compatibility: 'not-verified' as const,
    preparation: 'not-performed' as const,
    checkExecution: 'not-performed' as const,
    approval: 'not-requested' as const,
    transaction: 'not-authorized' as const,
    publication: 'not-authorized' as const,
    limitations: [
      'Ready status binds current source bytes, declared checks, preparation inputs and installed tool identities; it grants no permission to run them.',
      'Dependency preparation, project-code execution and declared network remain separate exact permissions for a later isolated workspace operation.',
      'No compatibility success, file approval, transaction, active-binding publication, recovery or deployment authority follows from this plan.'
    ]
  };
  return privatePlan(
    { ...body, fingerprint: canonicalSha256(body) },
    compatibility.snapshots,
    policy
  );
}

export async function saveAdoptionVerificationPlan(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions,
  inspection: ApplicationInspectionOptions = {}
): Promise<SavedAdoptionVerificationPlan> {
  const plan = await prepareAdoptionVerificationPlan(
    projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, source, now, storage, inspection
  );
  const stored = await createScopedUserLocalRecordStore(
    plan.report.projectRoot, 'adoption-verification-plan', storage
  ).write(plan.report.fingerprint, plan.report);
  if (stored.projectRoot !== plan.report.projectRoot) {
    throw new Error('Adoption verification-plan storage resolved a different canonical project root.');
  }
  return { path: stored.path, plan };
}

export async function loadAdoptionVerificationPlan(
  projectRoot: string,
  reviewFingerprint: string,
  destinationPlanFingerprint: string,
  compatibilityPlanFingerprint: string,
  verificationPlanFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions,
  inspection: ApplicationInspectionOptions = {}
): Promise<AdoptionVerificationPlan> {
  const stored = await createScopedUserLocalRecordStore(
    projectRoot, 'adoption-verification-plan', storage
  ).read(verificationPlanFingerprint);
  if (!stored) {
    throw new Error('No matching same-project adoption verification plan exists; request new verification planning.');
  }
  const plan = await prepareAdoptionVerificationPlan(
    stored.projectRoot, reviewFingerprint, destinationPlanFingerprint,
    compatibilityPlanFingerprint, source, now, storage, inspection
  );
  if (plan.report.fingerprint !== verificationPlanFingerprint ||
      canonicalSha256(stored.value) !== canonicalSha256(plan.report)) {
    throw new Error('Adoption verification plan is invalid, stale or bound to different inputs or tools.');
  }
  return plan;
}

function privatePlan(
  report: AdoptionVerificationPlanReport,
  snapshots: readonly ProjectFileSnapshot[],
  policy: ApplicationVerificationPolicy
): AdoptionVerificationPlan {
  const captured = snapshots.map(snapshot => ({
    pathParts: [...snapshot.pathParts],
    ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  }));
  const capturedPolicy = structuredClone(policy);
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const plan = { report: deepFreeze(structuredClone(report)) } as AdoptionVerificationPlan;
  Object.defineProperties(plan, {
    snapshots: {
      enumerable: false,
      get: () => captured.map(snapshot => ({
        pathParts: [...snapshot.pathParts],
        ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
      }))
    },
    verificationPolicy: {
      enumerable: false,
      get: () => structuredClone(capturedPolicy)
    }
  });
  return Object.freeze(plan);
}
