import path from 'node:path';
import { types } from 'node:util';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  ApplicationInspectionError, applicationExclusion, applicationParts, applicationPathFold,
  applicationPathKey
} from '../repair/application-files.js';
import { currentBoundApplicationTargets } from '../repair/application-inventory.js';
import { validateApplicationCommands } from '../repair/application-commands.js';
import { parseApplicationPreparation } from '../repair/application-preparation-inputs.js';
import type { ApplicationPreparationRequest } from '../repair/application-preparation-types.js';
import {
  applicationBounds, type ApplicationReferenceDisposition, type ApplicationVerificationCommand
} from '../repair/application-types.js';
import { loadAdoptionDestinationPlan } from './destination-plan.js';
import { inspectAdoptionCandidate } from './candidate.js';

export const adoptionCompatibilityPlanSchemaVersion = 1 as const;

export interface AdoptionCompatibilityFileReview {
  readonly sourcePathParts: readonly string[];
  readonly expectedDigest: string;
  readonly expectedMode: number;
  readonly decision: 'preserve-current-path' | 'move-required';
  readonly targetPathParts: readonly string[];
  readonly targetIdentity: {
    readonly kind: 'active-binding' | 'custom-component';
    readonly logicalName: string;
  };
}

export interface AdoptionCompatibilityReferenceReview {
  readonly referenceId: ApplicationReferenceDisposition['referenceId'];
  readonly disposition: 'updated' | 'unchanged-reviewed';
  readonly afterTargetPathParts: readonly string[];
}

export interface AdoptionCompatibilityReview {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-compatibility-review';
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly inventoryDigest: string;
  readonly targetLayoutDigest: string;
  readonly dynamicReferencesReviewed: boolean;
  readonly unresolvedMappings: readonly {
    readonly pathParts: readonly string[];
    readonly reason:
      | 'mapping-decision-required'
      | 'dynamic-reference-review-required'
      | 'unsupported-language-conversion';
  }[];
  readonly files: readonly AdoptionCompatibilityFileReview[];
  readonly references: readonly AdoptionCompatibilityReferenceReview[];
  readonly verification: {
    readonly commands: readonly ApplicationVerificationCommand[];
    readonly preparation: readonly ApplicationPreparationRequest[];
  };
}

export interface AdoptionCompatibilityPlanReport {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-adoption-compatibility-plan';
  readonly readOnly: true;
  readonly projectRoot: string;
  readonly reviewFingerprint: string;
  readonly destinationPlanFingerprint: string;
  readonly inventoryDigest: string;
  readonly targetLayoutDigest: string;
  readonly status: 'blocked' | 'ready-for-independent-verification-staging';
  readonly compatibility: 'not-verified';
  readonly deployment: 'planning-only';
  readonly fileMappings: readonly AdoptionCompatibilityFileReview[];
  readonly referenceReviews: readonly AdoptionCompatibilityReferenceReview[];
  readonly unresolvedMappings: AdoptionCompatibilityReview['unresolvedMappings'];
  readonly verification: AdoptionCompatibilityReview['verification'];
  readonly blockers: readonly (
    | { readonly code: 'file-review-missing'; readonly pathParts: readonly string[] }
    | { readonly code: 'reference-review-missing'; readonly referenceId: string }
    | { readonly code: 'dynamic-reference-review-incomplete' }
    | { readonly code: 'unresolved-mapping'; readonly pathParts: readonly string[] }
    | { readonly code: 'application-move-requires-staged-patch'; readonly pathParts: readonly string[] }
    | { readonly code: 'reference-update-requires-staged-patch'; readonly referenceId: string }
    | { readonly code: 'verification-command-missing' }
  )[];
  readonly requiredPermissions: readonly (
    | 'dependency-preparation'
    | 'project-code-execution'
    | 'declared-network'
  )[];
  readonly preparation: 'not-performed';
  readonly checkExecution: 'not-performed';
  readonly approval: 'not-requested';
  readonly publication: 'not-authorized';
  readonly limitations: readonly string[];
  readonly fingerprint: string;
}

/** Captured source bytes remain private and grant no execution or transaction authority. */
export interface AdoptionCompatibilityPlan {
  readonly report: AdoptionCompatibilityPlanReport;
  readonly snapshots: readonly ProjectFileSnapshot[];
}

function invalid(message: string): never {
  throw new ApplicationInspectionError(message);
}

function assertPlainData(value: unknown, label: string, depth = 0, state = { nodes: 0 }): void {
  if (++state.nodes > 100_000 || depth > 32) invalid(`${label} exceeds the plain-data bound.`);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object' || types.isProxy(value)) invalid(`${label} must contain only plain own data.`);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) {
    invalid(`${label} cannot contain symbol fields.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) invalid(`${label} arrays must be ordinary arrays.`);
  } else if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} records must be ordinary data objects.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(item => item.get || item.set)) {
    invalid(`${label} cannot contain accessors.`);
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      invalid(`${label} arrays cannot be sparse or contain named fields.`);
    }
    for (const key of keys) assertPlainData(descriptors[key]!.value, label, depth + 1, state);
  } else {
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable) invalid(`${label} records cannot contain hidden fields.`);
      assertPlainData(descriptor.value, label, depth + 1, state);
    }
  }
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) {
    invalid(`${label} must contain exactly the documented schema-1 fields.`);
  }
  return value;
}

function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array.`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    invalid(`${label} requires a complete lowercase SHA-256 digest.`);
  }
  return value;
}

function mode(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    invalid('Compatibility review modes must be exact ordinary permission bits from 0 through 511.');
  }
  return value as number;
}

function parts(value: unknown, allowRoot = false): string[] {
  array(value, applicationBounds.depth, 'Compatibility path');
  return applicationParts(value, allowRoot);
}

function logicalName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)) {
    invalid('Compatibility target identities require bounded lowercase logical names.');
  }
  return value;
}

function command(value: unknown): ApplicationVerificationCommand {
  const item = exact(value, [
    'executable', 'args', 'cwdPathParts', 'timeoutMs', 'maxOutputBytes', 'network'
  ], 'Compatibility verification command');
  if (typeof item.executable !== 'string' || typeof item.network !== 'boolean' ||
      !Number.isSafeInteger(item.timeoutMs) || (item.timeoutMs as number) < 1 ||
      (item.timeoutMs as number) > applicationBounds.commandTimeoutMs ||
      !Number.isSafeInteger(item.maxOutputBytes) || (item.maxOutputBytes as number) < 1 ||
      (item.maxOutputBytes as number) > applicationBounds.commandOutputBytes) {
    invalid('Compatibility verification commands require exact executables, network declarations and finite bounds.');
  }
  const args = array(item.args, 32, 'Compatibility verification arguments');
  if (!args.every(argument => typeof argument === 'string')) {
    invalid('Compatibility verification arguments must be literal strings.');
  }
  return {
    executable: item.executable,
    args: args as string[],
    cwdPathParts: parts(item.cwdPathParts, true),
    timeoutMs: item.timeoutMs as number,
    maxOutputBytes: item.maxOutputBytes as number,
    network: item.network
  };
}

export function validateAdoptionCompatibilityReview(value: unknown): AdoptionCompatibilityReview {
  assertPlainData(value, 'Adoption compatibility review');
  const review = exact(value, [
    'schemaVersion', 'kind', 'projectRoot', 'reviewFingerprint', 'destinationPlanFingerprint',
    'inventoryDigest', 'targetLayoutDigest', 'dynamicReferencesReviewed', 'unresolvedMappings',
    'files', 'references', 'verification'
  ], 'Adoption compatibility review');
  if (review.schemaVersion !== adoptionCompatibilityPlanSchemaVersion ||
      review.kind !== 'liftoff-adoption-compatibility-review' ||
      typeof review.projectRoot !== 'string' || !path.isAbsolute(review.projectRoot) ||
      typeof review.dynamicReferencesReviewed !== 'boolean') {
    invalid('Compatibility review requires schema 1, its distinct kind, a canonical project root and an explicit dynamic-reference decision.');
  }
  const unresolvedMappings = array(
    review.unresolvedMappings, applicationBounds.files, 'Unresolved compatibility mappings'
  ).map(value => {
    const item = exact(value, ['pathParts', 'reason'], 'Unresolved compatibility mapping');
    if (!['mapping-decision-required', 'dynamic-reference-review-required', 'unsupported-language-conversion']
      .includes(String(item.reason))) {
      invalid('Unresolved compatibility mappings require a supported explicit reason.');
    }
    return {
      pathParts: parts(item.pathParts),
      reason: item.reason as AdoptionCompatibilityReview['unresolvedMappings'][number]['reason']
    };
  }).sort((left, right) =>
    applicationPathKey(left.pathParts).localeCompare(applicationPathKey(right.pathParts), 'en') ||
    left.reason.localeCompare(right.reason, 'en'));
  const files = array(review.files, applicationBounds.files, 'Compatibility file reviews').map(value => {
    const item = exact(value, [
      'sourcePathParts', 'expectedDigest', 'expectedMode', 'decision', 'targetPathParts', 'targetIdentity'
    ], 'Compatibility file review');
    const identity = exact(item.targetIdentity, ['kind', 'logicalName'], 'Compatibility target identity');
    if (!['preserve-current-path', 'move-required'].includes(String(item.decision)) ||
        !['active-binding', 'custom-component'].includes(String(identity.kind))) {
      invalid('Compatibility file reviews require a supported decision and target identity.');
    }
    return {
      sourcePathParts: parts(item.sourcePathParts),
      expectedDigest: digest(item.expectedDigest, 'Compatibility source'),
      expectedMode: mode(item.expectedMode),
      decision: item.decision as AdoptionCompatibilityFileReview['decision'],
      targetPathParts: parts(item.targetPathParts),
      targetIdentity: {
        kind: identity.kind as AdoptionCompatibilityFileReview['targetIdentity']['kind'],
        logicalName: logicalName(identity.logicalName)
      }
    };
  }).sort((left, right) =>
    applicationPathKey(left.sourcePathParts).localeCompare(applicationPathKey(right.sourcePathParts), 'en'));
  const references = array(
    review.references, applicationBounds.references, 'Compatibility reference reviews'
  ).map(value => {
    const item = exact(
      value, ['referenceId', 'disposition', 'afterTargetPathParts'], 'Compatibility reference review'
    );
    if (!['updated', 'unchanged-reviewed'].includes(String(item.disposition))) {
      invalid('Adoption compatibility references must be updated or explicitly reviewed unchanged.');
    }
    return {
      referenceId: digest(item.referenceId, 'Compatibility reference'),
      disposition: item.disposition as 'updated' | 'unchanged-reviewed',
      afterTargetPathParts: parts(item.afterTargetPathParts)
    };
  }).sort((left, right) => left.referenceId.localeCompare(right.referenceId, 'en'));
  const verification = exact(review.verification, ['commands', 'preparation'], 'Compatibility verification');
  const commands = array(
    verification.commands, applicationBounds.commands, 'Compatibility verification commands'
  ).map(command);
  const preparation = parseApplicationPreparation(verification.preparation);
  return {
    schemaVersion: adoptionCompatibilityPlanSchemaVersion,
    kind: 'liftoff-adoption-compatibility-review',
    projectRoot: review.projectRoot,
    reviewFingerprint: digest(review.reviewFingerprint, 'Adoption review'),
    destinationPlanFingerprint: digest(review.destinationPlanFingerprint, 'Adoption destination plan'),
    inventoryDigest: digest(review.inventoryDigest, 'Adoption inventory'),
    targetLayoutDigest: digest(review.targetLayoutDigest, 'Adoption target layout'),
    dynamicReferencesReviewed: review.dynamicReferencesReviewed,
    unresolvedMappings,
    files,
    references,
    verification: { commands, preparation }
  };
}

function sameParts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function foldedParts(parts: readonly string[]): string {
  return parts.map(applicationPathFold).join('/');
}

export async function prepareAdoptionCompatibilityPlan(
  value: unknown,
  source: unknown,
  now: Date,
  storage?: UpdatePreviewOptions
): Promise<AdoptionCompatibilityPlan> {
  const review = validateAdoptionCompatibilityReview(value);
  const destination = await loadAdoptionDestinationPlan(
    review.projectRoot, review.reviewFingerprint, review.destinationPlanFingerprint, source, now, storage
  );
  const inspection = await inspectAdoptionCandidate(review.projectRoot, source);
  if (destination.report.projectRoot !== review.projectRoot ||
      inspection.report.inventory.projectRoot !== review.projectRoot ||
      inspection.report.inventory.inspectionDigest !== review.inventoryDigest ||
      inspection.report.inventory.target.digest !== review.targetLayoutDigest ||
      inspection.report.candidateDigest !== destination.report.candidateDigest) {
    invalid('Compatibility review belongs to different or stale adoption observations.');
  }
  const inventory = inspection.report.inventory;
  const targets = currentBoundApplicationTargets(source);
  validateApplicationCommands(
    review.verification.commands, inspection.snapshots, inventory.directoryInventory
  );
  const observedFiles = new Map(inventory.files.map(file => [applicationPathKey(file.pathParts), file]));
  const unresolvedKeys = new Set<string>();
  for (const unresolved of review.unresolvedMappings) {
    const key = canonicalSha256(unresolved);
    if (unresolvedKeys.has(key)) invalid('Compatibility review contains a duplicate unresolved mapping.');
    unresolvedKeys.add(key);
  }
  const mappedFiles = new Map<string, AdoptionCompatibilityFileReview>();
  const boundIdentities = new Set<string>();
  const targetPaths = new Set<string>();
  for (const mapping of review.files) {
    const key = applicationPathKey(mapping.sourcePathParts);
    if (mappedFiles.has(key)) invalid('Compatibility review contains a duplicate source file mapping.');
    const observed = observedFiles.get(key);
    if (!observed) invalid('Compatibility review names a file outside the current bounded adoption inventory.');
    if (!sameParts(observed.pathParts, mapping.sourcePathParts)) {
      invalid('Compatibility review source paths must preserve the exact observed spelling.');
    }
    if (observed.digest !== mapping.expectedDigest || observed.mode !== mapping.expectedMode) {
      invalid('Compatibility review source bytes or mode changed after review.');
    }
    const expectedKind = observed.currentTargetLogicalName === null ? 'custom-component' : 'active-binding';
    if (mapping.targetIdentity.kind !== expectedKind ||
        observed.currentTargetLogicalName !== null &&
        mapping.targetIdentity.logicalName !== observed.currentTargetLogicalName) {
      invalid('Compatibility target identity does not match the explicit current binding or custom-file status.');
    }
    if (mapping.targetIdentity.kind === 'active-binding' &&
        boundIdentities.has(mapping.targetIdentity.logicalName)) {
      invalid('Compatibility target logical identities must be unique.');
    }
    if (mapping.targetIdentity.kind === 'active-binding') {
      boundIdentities.add(mapping.targetIdentity.logicalName);
    }
    if (applicationExclusion(
      mapping.targetPathParts, targets.protectedPaths, targets.examplePaths, targets.protectedTrees
    )) {
      invalid('Compatibility mappings cannot target excluded control, state, credential, output or infrastructure paths.');
    }
    const targetKey = foldedParts(mapping.targetPathParts);
    if (targetPaths.has(targetKey)) invalid('Compatibility mappings contain colliding target paths.');
    targetPaths.add(targetKey);
    const preserved = sameParts(mapping.sourcePathParts, mapping.targetPathParts);
    if (mapping.decision === 'preserve-current-path' && !preserved ||
        mapping.decision === 'move-required' && preserved) {
      invalid('Compatibility mapping decision does not match its exact source and target paths.');
    }
    mappedFiles.set(key, mapping);
  }
  const blockers: AdoptionCompatibilityPlanReport['blockers'][number][] = [];
  for (const file of inventory.files) {
    if (!mappedFiles.has(applicationPathKey(file.pathParts))) {
      blockers.push({ code: 'file-review-missing', pathParts: [...file.pathParts] });
    }
  }
  for (const mapping of review.files) {
    if (mapping.decision === 'move-required') {
      blockers.push({
        code: 'application-move-requires-staged-patch',
        pathParts: [...mapping.sourcePathParts]
      });
    }
  }
  const observedReferences = new Map(inventory.references.map(reference => [reference.id, reference]));
  const reviewedReferences = new Map<string, AdoptionCompatibilityReferenceReview>();
  for (const disposition of review.references) {
    if (reviewedReferences.has(disposition.referenceId)) {
      invalid('Compatibility review contains a duplicate reference decision.');
    }
    const observed = observedReferences.get(disposition.referenceId);
    if (!observed) invalid('Compatibility review names a reference outside the current bounded adoption inventory.');
    const sourceMapping = mappedFiles.get(applicationPathKey(observed.sourcePathParts));
    const targetMapping = mappedFiles.get(applicationPathKey(observed.targetPathParts));
    const needsUpdate = sourceMapping?.decision === 'move-required' ||
      targetMapping?.decision === 'move-required' ||
      !sameParts(disposition.afterTargetPathParts, observed.targetPathParts);
    if (needsUpdate && disposition.disposition !== 'updated' ||
        !needsUpdate && disposition.disposition !== 'unchanged-reviewed' ||
        targetMapping?.decision === 'move-required' &&
        !sameParts(disposition.afterTargetPathParts, targetMapping.targetPathParts)) {
      invalid('Compatibility reference disposition does not match its reviewed source/target mapping.');
    }
    if (disposition.disposition === 'updated') {
      blockers.push({
        code: 'reference-update-requires-staged-patch',
        referenceId: disposition.referenceId
      });
    }
    reviewedReferences.set(disposition.referenceId, disposition);
  }
  for (const reference of inventory.references) {
    if (!reviewedReferences.has(reference.id)) {
      blockers.push({ code: 'reference-review-missing', referenceId: reference.id });
    }
  }
  if (!review.dynamicReferencesReviewed) blockers.push({ code: 'dynamic-reference-review-incomplete' });
  blockers.push(...review.unresolvedMappings.map(mapping => ({
    code: 'unresolved-mapping' as const, pathParts: [...mapping.pathParts]
  })));
  if (!review.verification.commands.length) blockers.push({ code: 'verification-command-missing' });
  const permissions: AdoptionCompatibilityPlanReport['requiredPermissions'][number][] = [];
  if (review.verification.preparation.length) permissions.push('dependency-preparation');
  permissions.push('project-code-execution');
  if (review.verification.preparation.some(item => item.network) ||
      review.verification.commands.some(item => item.network)) {
    permissions.push('declared-network');
  }
  const body = {
    schemaVersion: adoptionCompatibilityPlanSchemaVersion,
    kind: 'liftoff-adoption-compatibility-plan' as const,
    readOnly: true as const,
    projectRoot: review.projectRoot,
    reviewFingerprint: review.reviewFingerprint,
    destinationPlanFingerprint: review.destinationPlanFingerprint,
    inventoryDigest: review.inventoryDigest,
    targetLayoutDigest: review.targetLayoutDigest,
    status: blockers.length ? 'blocked' as const : 'ready-for-independent-verification-staging' as const,
    compatibility: 'not-verified' as const,
    deployment: 'planning-only' as const,
    fileMappings: review.files,
    referenceReviews: review.references,
    unresolvedMappings: review.unresolvedMappings,
    verification: review.verification,
    blockers,
    requiredPermissions: permissions,
    preparation: 'not-performed' as const,
    checkExecution: 'not-performed' as const,
    approval: 'not-requested' as const,
    publication: 'not-authorized' as const,
    limitations: [
      'Ready status qualifies only this exact review as input to a later independently permissioned staging operation; no preparation or project command ran.',
      'Reference coverage is bounded to observed literal paths and imports. Dynamic, generated, framework-specific and runtime resolution remain reviewer assertions until exact checks pass.',
      'Any application move or reference update requires separately supplied staged bytes and validation; this plan never rewrites source or substitutes a starter.',
      'Deployment configuration, state and cloud resources remain planning-only and outside adoption compatibility execution.'
    ]
  };
  return privatePlan(
    { ...body, fingerprint: canonicalSha256(body) },
    inspection.snapshots
  );
}

function privatePlan(
  report: AdoptionCompatibilityPlanReport,
  snapshots: readonly ProjectFileSnapshot[]
): AdoptionCompatibilityPlan {
  const captured = snapshots.map(snapshot => ({
    pathParts: [...snapshot.pathParts],
    ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
  }));
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const frozenReport = deepFreeze(structuredClone(report));
  const plan = { report: frozenReport } as AdoptionCompatibilityPlan;
  Object.defineProperty(plan, 'snapshots', {
    enumerable: false,
    get: () => captured.map(snapshot => ({
      pathParts: [...snapshot.pathParts],
      ...(snapshot.content === undefined ? {} : { content: Buffer.from(snapshot.content) }),
      ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode })
    }))
  });
  return Object.freeze(plan);
}
