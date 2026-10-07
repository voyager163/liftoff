import { createHash } from 'node:crypto';
import {
  readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import type {
  ProjectFileMutation, ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { applicationBounds } from '../repair/application-types.js';
import { buildModernManagedCore } from '../project/modern-managed-core.js';
import {
  loadAdoptionPreview, revalidateAdoptionPreview, validateAdoptionPreview, type AdoptionPreview
} from './preview.js';

export const adoptionDestinationPlanSchemaVersion = 1 as const;

export interface AdoptionDestinationObservation {
  readonly logicalName: string;
  readonly pathParts: readonly string[];
  readonly kind: 'managed-core' | 'manifest';
  readonly status: 'absent' | 'matching-unowned' | 'conflict';
  readonly observedDigest: string | null;
  readonly observedMode: number | null;
  readonly candidateDigest: string;
  readonly candidateBytes: number;
}

export interface AdoptionDestinationPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-destination-plan';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly candidateDigest: string | null;
  readonly status: 'blocked' | 'ready-for-independent-verification';
  readonly destinations: readonly AdoptionDestinationObservation[];
  readonly blockers: readonly (
    | { code: 'candidate-incomplete'; logicalName: string; pathParts: readonly string[] }
    | { code: 'unowned-destination-conflict'; logicalName: string; pathParts: readonly string[] }
  )[];
  readonly verification: 'not-performed';
  readonly approval: 'not-requested';
  readonly publication: 'not-authorized';
  readonly requiredPermissions: readonly [
    'dependency-preparation',
    'project-code-execution',
    'declared-network',
    'file-transaction'
  ];
  readonly fingerprint: string;
}

/** Private exact bytes and snapshots are excluded from report serialization and grant no transaction authority. */
export interface AdoptionDestinationPlan {
  readonly report: AdoptionDestinationPlanReport;
  readonly mutations: readonly ProjectFileMutation[];
  readonly preconditions: readonly ProjectFileSnapshot[];
}

export interface SavedAdoptionDestinationPlan {
  readonly path: string;
  readonly plan: AdoptionDestinationPlan;
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function snapshotDescriptor(snapshot: ProjectFileSnapshot) {
  return {
    pathParts: [...snapshot.pathParts],
    digest: snapshot.content === undefined ? null : digest(snapshot.content),
    mode: snapshot.mode ?? null
  };
}

function uniqueSnapshots(snapshots: readonly ProjectFileSnapshot[]): ProjectFileSnapshot[] {
  const result = new Map<string, ProjectFileSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshot.pathParts.join('\0');
    const prior = result.get(key);
    if (prior && canonicalSha256(snapshotDescriptor(prior)) !== canonicalSha256(snapshotDescriptor(snapshot))) {
      throw new Error(`Adoption review captured different observations for ${snapshot.pathParts.join('/')}.`);
    }
    result.set(key, {
      pathParts: [...snapshot.pathParts],
      ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
      ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
    });
  }
  return [...result.values()].sort((left, right) =>
    left.pathParts.join('\0').localeCompare(right.pathParts.join('\0'), 'en'));
}

export async function prepareAdoptionDestinationPlan(
  previewValue: unknown, source: unknown, now: Date
): Promise<AdoptionDestinationPlan> {
  const preview: AdoptionPreview = validateAdoptionPreview(previewValue, now);
  const inspection = await revalidateAdoptionPreview(preview, source, now);
  const managed = buildModernManagedCore(source);
  const incomplete = inspection.report.blockers.map(blocker => ({
    code: 'candidate-incomplete' as const,
    logicalName: blocker.logicalName,
    pathParts: [...blocker.pathParts]
  }));
  if (inspection.candidate === null) {
    const body = {
      schemaVersion: adoptionDestinationPlanSchemaVersion,
      kind: 'liftoff-adoption-destination-plan' as const,
      readOnly: true as const,
      projectRoot: preview.projectRoot,
      reviewFingerprint: preview.fingerprint,
      candidateDigest: null,
      status: 'blocked' as const,
      destinations: [] as readonly AdoptionDestinationObservation[],
      blockers: incomplete,
      verification: 'not-performed' as const,
      approval: 'not-requested' as const,
      publication: 'not-authorized' as const,
      requiredPermissions: [
        'dependency-preparation', 'project-code-execution', 'declared-network', 'file-transaction'
      ] as const
    };
    return privatePlan({ ...body, fingerprint: canonicalSha256(body) }, [], inspection.snapshots);
  }
  const candidateByName = new Map(inspection.report.managedSource.map(entry => [entry.logicalName, entry]));
  if (candidateByName.size !== managed.length || managed.some(artifact => {
    const entry = candidateByName.get(artifact.logicalName);
    return entry === undefined || canonicalSha256(entry.pathParts) !== canonicalSha256(artifact.pathParts) ||
      entry.candidateHash !== `sha256:${digest(artifact.content)}`;
  })) {
    throw new Error('Adoption managed destinations differ from the exact reviewed candidate.');
  }
  const targets = [
    ...managed.map(artifact => ({
      logicalName: artifact.logicalName,
      pathParts: [...artifact.pathParts],
      kind: 'managed-core' as const,
      content: artifact.content
    })),
    {
      logicalName: 'manifest',
      pathParts: ['liftoff.manifest.json'],
      kind: 'manifest' as const,
      content: inspection.candidate.content
    }
  ];
  const snapshots = await Promise.all(targets.map(target =>
    readBoundProjectFileSnapshot(preview.projectRoot, target.pathParts, {
      maximumBytes: applicationBounds.fileBytes,
      linkPolicy: 'single-link',
      diagnostics: {
        pathLabel: `Adoption destination ${target.logicalName}`,
        invalid(detail): never {
          throw new Error(`Unsafe adoption destination ${target.pathParts.join('/')}: ${detail}`);
        }
      }
    })));
  const destinations: AdoptionDestinationObservation[] = targets.map((target, index) => {
    const snapshot = snapshots[index]!;
    const candidateDigest = digest(target.content);
    return {
      logicalName: target.logicalName,
      pathParts: target.pathParts,
      kind: target.kind,
      status: snapshot.content === undefined ? 'absent' :
        snapshot.content.equals(Buffer.from(target.content, 'utf8')) ? 'matching-unowned' : 'conflict',
      observedDigest: snapshot.content === undefined ? null : digest(snapshot.content),
      observedMode: snapshot.mode ?? null,
      candidateDigest,
      candidateBytes: Buffer.byteLength(target.content)
    };
  });
  const conflicts = destinations.filter(destination => destination.status === 'conflict').map(destination => ({
    code: 'unowned-destination-conflict' as const,
    logicalName: destination.logicalName,
    pathParts: [...destination.pathParts]
  }));
  const blocked = conflicts.length > 0;
  const mutations: ProjectFileMutation[] = blocked ? [] : targets.flatMap((target, index) =>
    snapshots[index]!.content === undefined
      ? [{ type: 'write' as const, pathParts: [...target.pathParts], content: target.content }]
      : []);
  const preconditions = uniqueSnapshots([...inspection.snapshots, ...snapshots]);
  const body = {
    schemaVersion: adoptionDestinationPlanSchemaVersion,
    kind: 'liftoff-adoption-destination-plan' as const,
    readOnly: true as const,
    projectRoot: preview.projectRoot,
    reviewFingerprint: preview.fingerprint,
    candidateDigest: inspection.candidate.digest,
    status: blocked ? 'blocked' as const : 'ready-for-independent-verification' as const,
    destinations,
    blockers: conflicts,
    verification: 'not-performed' as const,
    approval: 'not-requested' as const,
    publication: 'not-authorized' as const,
    requiredPermissions: [
      'dependency-preparation', 'project-code-execution', 'declared-network', 'file-transaction'
    ] as const
  };
  return privatePlan({ ...body, fingerprint: canonicalSha256({
    ...body,
    effects: mutations.map(mutation => ({
      type: mutation.type,
      pathParts: mutation.pathParts,
      contentDigest: mutation.type === 'write' ? digest(mutation.content) : null
    })),
    preconditions: preconditions.map(snapshotDescriptor)
  }) }, mutations, preconditions);
}

/** Persists only a freshly re-observed report; private effects remain transient and unapproved. */
export async function saveAdoptionDestinationPlan(
  projectRoot: string,
  reviewFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<SavedAdoptionDestinationPlan> {
  const preview = await loadAdoptionPreview(projectRoot, reviewFingerprint, now, storage);
  const plan = await prepareAdoptionDestinationPlan(preview, source, now);
  if (plan.report.status !== 'ready-for-independent-verification') {
    throw new Error('Blocked adoption destinations cannot become a saved verification input.');
  }
  const stored = await createScopedUserLocalRecordStore(
    preview.projectRoot, 'adoption-destination-plan', storage
  ).write(plan.report.fingerprint, plan.report);
  if (stored.projectRoot !== preview.projectRoot) {
    throw new Error('Adoption destination-plan storage resolved a different canonical project root.');
  }
  return { path: stored.path, plan };
}

/** Rebuilds private effects from current inputs; saved metadata never supplies transaction bytes. */
export async function loadAdoptionDestinationPlan(
  projectRoot: string,
  reviewFingerprint: string,
  planFingerprint: string,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<AdoptionDestinationPlan> {
  const preview = await loadAdoptionPreview(projectRoot, reviewFingerprint, now, storage);
  const stored = await createScopedUserLocalRecordStore(
    preview.projectRoot, 'adoption-destination-plan', storage
  ).read(planFingerprint);
  if (!stored) throw new Error('No matching same-project adoption destination plan exists; request a new review.');
  if (stored.projectRoot !== preview.projectRoot) {
    throw new Error('Adoption destination-plan storage resolved a different canonical project root.');
  }
  const plan = await prepareAdoptionDestinationPlan(preview, source, now);
  if (plan.report.status !== 'ready-for-independent-verification' ||
      plan.report.fingerprint !== planFingerprint ||
      canonicalSha256(stored.value) !== canonicalSha256(plan.report)) {
    throw new Error('Adoption destination plan is invalid, stale or bound to different observations; request a new review.');
  }
  return plan;
}

function privatePlan(
  report: AdoptionDestinationPlanReport,
  mutations: readonly ProjectFileMutation[],
  preconditions: readonly ProjectFileSnapshot[]
): AdoptionDestinationPlan {
  const capturedMutations = mutations.map(mutation => mutation.type === 'delete'
    ? { type: 'delete' as const, pathParts: [...mutation.pathParts] }
    : {
        type: 'write' as const,
        pathParts: [...mutation.pathParts],
        content: typeof mutation.content === 'string' ? mutation.content : Buffer.from(mutation.content),
        ...(mutation.mode === undefined ? {} : { mode: mutation.mode })
      });
  const capturedPreconditions = preconditions.map(snapshot => ({
    pathParts: [...snapshot.pathParts],
    ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  }));
  const frozenReport = Object.freeze({
    ...report,
    destinations: Object.freeze(report.destinations.map(destination => Object.freeze({
      ...destination, pathParts: Object.freeze([...destination.pathParts])
    }))),
    blockers: Object.freeze(report.blockers.map(blocker => Object.freeze({
      ...blocker, pathParts: Object.freeze([...blocker.pathParts])
    }))),
    requiredPermissions: Object.freeze([...report.requiredPermissions]) as AdoptionDestinationPlanReport['requiredPermissions']
  });
  const plan = { report: frozenReport } as AdoptionDestinationPlan;
  Object.defineProperties(plan, {
    mutations: {
      enumerable: false,
      get: () => capturedMutations.map(mutation => mutation.type === 'delete'
        ? { type: 'delete' as const, pathParts: [...mutation.pathParts] }
        : {
            type: 'write' as const,
            pathParts: [...mutation.pathParts],
            content: typeof mutation.content === 'string' ? mutation.content : Buffer.from(mutation.content),
            ...(mutation.mode === undefined ? {} : { mode: mutation.mode })
          })
    },
    preconditions: {
      enumerable: false,
      get: () => capturedPreconditions.map(snapshot => ({
        pathParts: [...snapshot.pathParts],
        ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
      }))
    }
  });
  return Object.freeze(plan);
}
