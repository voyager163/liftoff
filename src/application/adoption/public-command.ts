import path from 'node:path';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { isUpdatePlanFingerprint } from '../update/approval.js';
import {
  ApplicationFiles,
  ApplicationInspectionError,
  applicationPathFold,
  assertApplicationNoLinkAncestors,
  canonicalApplicationRoot
} from '../repair/application-files.js';
import {
  prepareAdoptionDestinationPlan,
  saveAdoptionDestinationPlan,
  type AdoptionDestinationPlanReport
} from './destination-plan.js';
import {
  createAdoptionReview,
  saveAdoptionPreview,
  type AdoptionPreview
} from './preview.js';
import type { AdoptionCandidateReport } from './candidate.js';
import {
  prepareAdoptionLayoutPlan,
  type AdoptionLayoutPlanReport
} from './layout-plan.js';
import {
  createAdoptionMappingReview,
  type AdoptionMappingReviewReport
} from './mapping-review.js';
import {
  readStoredAdoptionPublicationPlan,
  type AdoptionPublicationPlanReport
} from './publication-plan.js';
import {
  publishAdoptionPlan, recoverAdoptionPlan,
  type AdoptionPublicationOutcome
} from './publication.js';

export const adoptionCommandReportSchemaVersion = 1 as const;

export interface AdoptionCommandRequest {
  readonly project?: string;
  readonly explicitProject: boolean;
  readonly check: boolean;
  readonly approvePlan?: string;
  readonly recover: boolean;
  readonly json: boolean;
}

export type AdoptionProjectBoundary =
  | { readonly projectRoot: string; readonly kind: 'liftoff' | 'git' }
  | { readonly projectRoot: string; readonly kind: 'explicit-non-git' };

export interface AdoptionCommandReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption';
  readonly command: 'adopt';
  readonly operation: 'preview' | 'approve' | 'recover';
  readonly readOnly: boolean;
  readonly projectRoot: string;
  readonly projectKind: AdoptionProjectBoundary['kind'] | 'unavailable';
  readonly status:
    | 'compatibility-review-required'
    | 'blocked'
    | 'existing-liftoff-project'
    | 'applied'
    | 'recovered'
    | 'publication-partial'
    | 'approval-unavailable'
    | 'recovery-unavailable'
    | 'error';
  readonly exitCode: 0 | 1 | 2;
  readonly target: {
    readonly sourceDigest: string;
    readonly inventoryDigest: string;
    readonly pluginResolutionDigest: string;
    readonly activeLayoutDigest: string;
    readonly targetLayoutDigest: string;
  } | null;
  readonly layoutPlan: AdoptionLayoutPlanReport | null;
  readonly mappingReview: AdoptionMappingReviewReport | null;
  readonly review: AdoptionPreview | null;
  readonly candidate: AdoptionCandidateReport | null;
  readonly destinationPlan: AdoptionDestinationPlanReport | null;
  readonly publicationPlan: AdoptionPublicationPlanReport | null;
  readonly approval: {
    readonly requestedFingerprint: string | null;
    readonly status:
      | 'not-requested'
      | 'approved-exact-plan'
      | 'unavailable-before-complete-plan';
  };
  readonly recovery: {
    readonly requested: boolean;
    readonly status:
      | 'not-requested'
      | 'recovered'
      | 'blocked'
      | 'unavailable-before-authenticated-transaction';
  };
  readonly transaction: {
    readonly candidateBinding: string | null;
    readonly transactionDigest: string | null;
    readonly status:
      | 'not-started'
      | 'absent'
      | 'rolled-back'
      | 'blocked'
      | 'committed-cleanup-pending'
      | 'committed-readback-failed'
      | 'committed';
    readonly committed: boolean;
    readonly readbackDigest: string | null;
    readonly rollbackFailures: readonly string[];
    readonly cleanupFailures: readonly string[];
    readonly readbackFailures: readonly string[];
  };
  readonly nextActions: readonly {
    readonly command: readonly string[];
    readonly purpose: string;
  }[];
  readonly diagnostics: readonly string[];
  readonly limitations: readonly string[];
}

const previewLimitations = Object.freeze([
  'This schema-1 preview grants no verification, file approval, transaction, active-binding publication, deployment or recovery authority.',
  'No commit, branch switch, stash, reset, push, database mutation, cloud/state mutation or starter replacement is performed.',
  'Existing deployment configuration, state and resources remain planning-only even when local application review can continue.'
]);

const publicationLimitations = Object.freeze([
  'Exact file approval applies only the selected saved publication fingerprint and its authenticated transaction candidate.',
  'Application bytes, modes and paths remain protected preconditions; active-binding publication after reviewed moves is a separate operation.',
  'No commit, branch switch, stash, reset, push, database mutation, deployment/state mutation or cloud-resource change is authorized.'
]);

export function adoptionCommandRequestIssue(
  request: AdoptionCommandRequest
): string | undefined {
  for (const field of ['explicitProject', 'check', 'recover', 'json'] as const) {
    if (typeof Object.getOwnPropertyDescriptor(request, field)?.value !== 'boolean') {
      return `Adoption ${field} must be an explicit boolean.`;
    }
  }
  if (request.project !== undefined &&
      (typeof request.project !== 'string' || !request.project.trim())) {
    return 'Adoption project must be a non-empty path.';
  }
  if (request.approvePlan !== undefined &&
      !isUpdatePlanFingerprint(request.approvePlan)) {
    return '--approve-plan requires exactly 64 lowercase hexadecimal characters.';
  }
  if (request.check && (request.approvePlan !== undefined || request.recover)) {
    return 'Adoption --check cannot be combined with --approve-plan or --recover.';
  }
  if (request.recover && request.approvePlan === undefined) {
    return 'Adoption --recover requires --approve-plan <saved-fingerprint>.';
  }
  return undefined;
}

function marker(
  directory: Awaited<ReturnType<ApplicationFiles['inventory']>>,
  name: '.git' | 'liftoff.manifest.json'
) {
  const entry = directory.entries.find(item => applicationPathFold(item.name) === name);
  if (entry && (entry.name !== name ||
      entry.kind !== 'file' && (name !== '.git' || entry.kind !== 'directory'))) {
    throw new ApplicationInspectionError(
      'Adoption encountered an unsafe or aliased project boundary; no outer project was selected.'
    );
  }
  return entry;
}

export async function resolveAdoptionProjectBoundary(
  start: string,
  explicit: boolean
): Promise<AdoptionProjectBoundary> {
  await assertApplicationNoLinkAncestors(path.resolve(start), 'Project inventory root');
  let projectRoot = await canonicalApplicationRoot(start);
  const readers: ApplicationFiles[] = [];
  while (true) {
    const reader = new ApplicationFiles(projectRoot);
    readers.push(reader);
    const directory = await reader.inventory([]);
    const manifest = marker(directory, 'liftoff.manifest.json');
    const git = marker(directory, '.git');
    if (manifest || git || explicit) {
      for (const observed of readers) await observed.assertUnchanged();
      return manifest
        ? { projectRoot, kind: 'liftoff' }
        : git
          ? { projectRoot, kind: 'git' }
          : { projectRoot, kind: 'explicit-non-git' };
    }
    const parent = path.dirname(projectRoot);
    if (parent === projectRoot) {
      throw new ApplicationInspectionError(
        'No Liftoff or Git boundary was found. Select an explicit project directory to adopt a non-Git application.'
      );
    }
    projectRoot = parent;
  }
}

function operation(request: AdoptionCommandRequest): AdoptionCommandReport['operation'] {
  return request.recover ? 'recover' : request.approvePlan === undefined ? 'preview' : 'approve';
}

function unavailableReport(
  request: AdoptionCommandRequest,
  status: 'approval-unavailable' | 'recovery-unavailable',
  diagnostic: string
): AdoptionCommandReport {
  return {
    schemaVersion: adoptionCommandReportSchemaVersion,
    kind: 'liftoff-adoption',
    command: 'adopt',
    operation: operation(request),
    readOnly: true,
    projectRoot: path.resolve(request.project ?? '.'),
    projectKind: 'unavailable',
    status,
    exitCode: 1,
    target: null,
    layoutPlan: null,
    mappingReview: null,
    review: null,
    candidate: null,
    destinationPlan: null,
    publicationPlan: null,
    approval: {
      requestedFingerprint: request.approvePlan ?? null,
      status: request.approvePlan === undefined
        ? 'not-requested'
        : 'unavailable-before-complete-plan'
    },
    recovery: {
      requested: request.recover,
      status: request.recover
        ? 'unavailable-before-authenticated-transaction'
        : 'not-requested'
    },
    transaction: {
      candidateBinding: null,
      transactionDigest: null,
      status: 'not-started',
      committed: false,
      readbackDigest: null,
      rollbackFailures: [],
      cleanupFailures: [],
      readbackFailures: []
    },
    nextActions: [{
      command: ['liftoff', 'adopt', '--project', path.resolve(request.project ?? '.'), '--check'],
      purpose: 'Create a fresh bounded adoption preview before requesting any later authority.'
    }],
    diagnostics: [diagnostic],
    limitations: previewLimitations
  };
}

export function unavailableAdoptionAuthorityReport(
  request: AdoptionCommandRequest
): AdoptionCommandReport | null {
  const issue = adoptionCommandRequestIssue(request);
  if (issue) {
    return unavailableReport(request, request.recover ? 'recovery-unavailable' : 'approval-unavailable', issue);
  }
  return null;
}

export function adoptionCommandErrorReport(
  request: AdoptionCommandRequest,
  projectRoot: string,
  diagnostic: string
): AdoptionCommandReport {
  return {
    ...unavailableReport(request, 'approval-unavailable', diagnostic),
    operation: operation(request),
    projectRoot: path.resolve(projectRoot),
    status: 'error',
    approval: {
      requestedFingerprint: request.approvePlan ?? null,
      status: request.approvePlan === undefined
        ? 'not-requested'
        : 'unavailable-before-complete-plan'
    }
  };
}

function transactionReport(
  outcome: AdoptionPublicationOutcome
): AdoptionCommandReport['transaction'] {
  return {
    candidateBinding: outcome.transactionCandidateBinding,
    transactionDigest: outcome.transactionDigest,
    status: outcome.status,
    committed: outcome.committed,
    readbackDigest: outcome.readbackDigest,
    rollbackFailures: [...outcome.rollbackFailures],
    cleanupFailures: [...outcome.cleanupFailures],
    readbackFailures: [...outcome.readbackFailures]
  };
}

function effectReport(
  request: AdoptionCommandRequest,
  boundary: AdoptionProjectBoundary,
  plan: AdoptionPublicationPlanReport,
  outcome: AdoptionPublicationOutcome
): AdoptionCommandReport {
  const cleanCommit = outcome.status === 'committed';
  const cleanRecovery = request.recover && outcome.status === 'rolled-back';
  const blocked = outcome.status === 'blocked' || outcome.status === 'absent';
  const partial = outcome.status === 'committed-cleanup-pending' ||
    outcome.status === 'committed-readback-failed';
  const status: AdoptionCommandReport['status'] = cleanCommit
    ? 'applied'
    : cleanRecovery
      ? 'recovered'
      : partial
        ? 'publication-partial'
        : request.recover
          ? 'recovery-unavailable'
          : 'approval-unavailable';
  const nextActions = outcome.status === 'committed-readback-failed'
    ? [
        {
          command: [
            'liftoff', 'validate', '--project', boundary.projectRoot
          ],
          purpose: 'Inspect the committed project state after failed exact readback.'
        },
        {
          command: [
            'liftoff', 'repair', boundary.projectRoot, '--check'
          ],
          purpose: 'Review any required forward correction without replaying adoption.'
        }
      ]
    : partial || blocked
    ? [{
        command: [
          'liftoff', 'adopt', '--project', boundary.projectRoot, '--recover',
          '--approve-plan', plan.fingerprint
        ],
        purpose: 'Recover only the authenticated selected adoption transaction.'
      }]
    : cleanCommit
      ? [{
          command: [
            'liftoff', 'update', '--project', boundary.projectRoot, '--check'
          ],
          purpose: 'Review later managed control-plane maintenance separately.'
        }]
      : [{
          command: [
            'liftoff', 'adopt', '--project', boundary.projectRoot, '--check'
          ],
          purpose: 'Request a fresh adoption review after clean rollback.'
        }];
  return {
    schemaVersion: adoptionCommandReportSchemaVersion,
    kind: 'liftoff-adoption',
    command: 'adopt',
    operation: operation(request),
    readOnly: false,
    projectRoot: boundary.projectRoot,
    projectKind: boundary.kind,
    status,
    exitCode: cleanCommit ? 0 : cleanRecovery ? 2 : 1,
    target: null,
    layoutPlan: null,
    mappingReview: null,
    review: null,
    candidate: null,
    destinationPlan: null,
    publicationPlan: plan,
    approval: {
      requestedFingerprint: plan.fingerprint,
      status: request.recover
        ? 'not-requested'
        : 'approved-exact-plan'
    },
    recovery: {
      requested: request.recover,
      status: request.recover
        ? cleanCommit || cleanRecovery
          ? 'recovered'
          : blocked || partial
            ? 'blocked'
            : 'unavailable-before-authenticated-transaction'
        : 'not-requested'
    },
    transaction: transactionReport(outcome),
    nextActions,
    diagnostics: cleanCommit
      ? ['The exact approved adoption transaction committed and its project effects passed independent readback.']
      : cleanRecovery
        ? ['The interrupted adoption transaction rolled back only attributable unchanged writes; adoption is not complete.']
        : [
            ...outcome.rollbackFailures,
            ...outcome.cleanupFailures,
            ...outcome.readbackFailures,
            ...(outcome.status === 'absent'
              ? ['No authenticated adoption transaction exists for the selected publication plan.']
              : [])
          ],
    limitations: publicationLimitations
  };
}

export async function approveAdoptionProject(
  request: AdoptionCommandRequest,
  boundary: AdoptionProjectBoundary,
  source: unknown,
  storage?: UpdatePreviewOptions
): Promise<AdoptionCommandReport> {
  if (!request.approvePlan || request.recover) {
    throw new Error('Adoption publication requires one exact approved plan fingerprint.');
  }
  const plan = await readStoredAdoptionPublicationPlan(
    boundary.projectRoot, request.approvePlan, storage
  );
  const layout = await prepareAdoptionLayoutPlan(
    boundary.projectRoot, source
  );
  if (!layout.source) {
    throw new Error(
      'The selected target no longer has a supported current application layout.'
    );
  }
  const outcome = await publishAdoptionPlan(
    boundary.projectRoot, request.approvePlan, layout.source, { storage }
  );
  return effectReport(request, boundary, plan, outcome);
}

export async function recoverAdoptionProject(
  request: AdoptionCommandRequest,
  boundary: AdoptionProjectBoundary,
  storage?: UpdatePreviewOptions
): Promise<AdoptionCommandReport> {
  if (!request.approvePlan || !request.recover) {
    throw new Error('Adoption recovery requires one exact saved publication plan fingerprint.');
  }
  const plan = await readStoredAdoptionPublicationPlan(
    boundary.projectRoot, request.approvePlan, storage
  );
  const outcome = await recoverAdoptionPlan(
    boundary.projectRoot, request.approvePlan, { storage }
  );
  return effectReport(request, boundary, plan, outcome);
}

export async function previewAdoptionProject(
  request: AdoptionCommandRequest,
  boundary: AdoptionProjectBoundary,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<AdoptionCommandReport> {
  const issue = adoptionCommandRequestIssue(request);
  if (issue) return adoptionCommandErrorReport(request, boundary.projectRoot, issue);
  if (boundary.kind === 'liftoff') {
    return {
      ...adoptionCommandErrorReport(
        request,
        boundary.projectRoot,
        'The selected project already has a Liftoff manifest and cannot be adopted again.'
      ),
      projectKind: 'liftoff',
      status: 'existing-liftoff-project',
      exitCode: 2,
      nextActions: [
        {
          command: ['liftoff', 'update', '--project', boundary.projectRoot, '--check'],
          purpose: 'Review supported manifest/control-plane maintenance.'
        },
        {
          command: ['liftoff', 'repair', '--project', boundary.projectRoot, '--check'],
          purpose: 'Review separately authorized application repair.'
        }
      ]
    };
  }
  const layout = await prepareAdoptionLayoutPlan(boundary.projectRoot, source);
  const plannedSource = layout.source;
  if (plannedSource === null) {
    return {
      schemaVersion: adoptionCommandReportSchemaVersion,
      kind: 'liftoff-adoption',
      command: 'adopt',
      operation: 'preview',
      readOnly: true,
      projectRoot: boundary.projectRoot,
      projectKind: boundary.kind,
      status: 'blocked',
      exitCode: 2,
      target: null,
      layoutPlan: layout.report,
      mappingReview: null,
      review: null,
      candidate: null,
      destinationPlan: null,
      publicationPlan: null,
      approval: { requestedFingerprint: null, status: 'not-requested' },
      recovery: { requested: false, status: 'not-requested' },
      transaction: {
        candidateBinding: null,
        transactionDigest: null,
        status: 'not-started',
        committed: false,
        readbackDigest: null,
        rollbackFailures: [],
        cleanupFailures: [],
        readbackFailures: []
      },
      nextActions: [{
        command: ['liftoff', 'adopt', '--project', boundary.projectRoot, '--check'],
        purpose: 'Select a supported target with at least one observed application-component binding, then request a fresh preview.'
      }],
      diagnostics: [
        'No supported application-component binding was observed at the selected current paths; no candidate manifest or destination plan was created.'
      ],
      limitations: previewLimitations
    };
  }
  const inspection = await createAdoptionReview(boundary.projectRoot, plannedSource, now);
  const destination = await prepareAdoptionDestinationPlan(
    inspection.preview,
    plannedSource,
    now
  );
  const mappingReview = createAdoptionMappingReview(
    inspection.report.inventory,
    inspection.preview,
    destination.report
  );
  await saveAdoptionPreview(inspection.preview, now, storage);
  if (destination.report.status === 'ready-for-independent-verification') {
    await saveAdoptionDestinationPlan(
      boundary.projectRoot,
      inspection.preview.fingerprint,
      plannedSource,
      now,
      storage
    );
  }
  const ready = destination.report.status === 'ready-for-independent-verification';
  return {
    schemaVersion: adoptionCommandReportSchemaVersion,
    kind: 'liftoff-adoption',
    command: 'adopt',
    operation: 'preview',
    readOnly: true,
    projectRoot: boundary.projectRoot,
    projectKind: boundary.kind,
    status: ready ? 'compatibility-review-required' : 'blocked',
    exitCode: 2,
    target: {
      sourceDigest: inspection.report.sourceDigest,
      inventoryDigest: inspection.report.inventory.inspectionDigest,
      pluginResolutionDigest: inspection.report.inventory.pluginResolutionDigest,
      activeLayoutDigest: inspection.report.inventory.activeLayoutDigest,
      targetLayoutDigest: inspection.report.inventory.target.digest
    },
    layoutPlan: layout.report,
    mappingReview,
    review: inspection.preview,
    candidate: inspection.report,
    destinationPlan: destination.report,
    publicationPlan: null,
    approval: { requestedFingerprint: null, status: 'not-requested' },
    recovery: { requested: false, status: 'not-requested' },
    transaction: {
      candidateBinding: null,
      transactionDigest: null,
      status: 'not-started',
      committed: false,
      readbackDigest: null,
      rollbackFailures: [],
      cleanupFailures: [],
      readbackFailures: []
    },
    nextActions: ready
      ? [{
          command: ['liftoff', 'adopt', '--project', boundary.projectRoot, '--check'],
          purpose: 'Repeat discovery after completing explicit compatible file, reference, and verification review.'
        }]
      : [{
          command: ['liftoff', 'adopt', '--project', boundary.projectRoot, '--check'],
          purpose: 'Resolve every reported blocker, then request a fresh preview.'
        }],
    diagnostics: ready
      ? ['Destination review is current, but explicit compatibility mappings and declared checks are still required before a public plan can exist.']
      : ['Adoption remains blocked by the reported candidate or destination observations.'],
    limitations: previewLimitations
  };
}
