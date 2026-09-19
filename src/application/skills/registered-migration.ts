import { createHash } from 'node:crypto';
import type { CommandRunner } from '../../process-runner.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import type { UpdatePreviewOptions } from '../../adapters/filesystem/update-previews.js';
import { captureSkillDirectories, captureSkillFile, type CapturedSkillFile } from '../../adapters/skills/discovery.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { retiredManagedCoreIdentities } from '../../domain/project/artifact-lifecycle.js';
import { CANONICAL_SKILL_IDS, type SkillDirectoryObservation, type SkillDiscoveryObservation, type SkillFileObservation } from '../../domain/skills/contracts.js';
import {
  skillAliasHistoryPaths, skillAliasRetirementRecipe, validateSkillsExecutionIdentity,
  type SkillAliasRetirementIdentity
} from '../../domain/skills/identity.js';
import { inspectProjectUpdate } from '../update/inspection.js';
import { prepareUpdateReview } from '../update/review-plan.js';
import { loadManifest } from '../project/manifest.js';
import { activationStateFilePathParts } from '../../governance-activation/activation-state.js';
import { migrationStateFilePathParts } from '../../governance-activation/history-contracts.js';
import { activeActivationRecordsWithoutState } from '../../governance-activation/migration-history.js';
import { liftoffVersion } from '../../version.js';
import { planSkillMigration, type SkillMigrationOptions, type SkillMigrationPlan } from './migration.js';

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const reviewWindow = 15 * 60 * 1000;

async function captureRetirementControlState(root: string) {
  const files = await Promise.all([activationStateFilePathParts, migrationStateFilePathParts]
    .map((parts) => captureSkillFile(root, parts)));
  const present = files.filter((file) => file.observation.state !== 'absent');
  const orphaned = present.length === 0 ? await activeActivationRecordsWithoutState(root) : [];
  return {
    files,
    issue: present.length > 0
      ? `Direct alias retirement requires absent activation/migration state. ${present.map((file) => file.observation.pathParts.join('/')).join(', ')} remains in the separately reviewed update/activation scope.`
      : orphaned.length > 0
        ? `Direct alias retirement is blocked by reader-detected orphan activation records: ${orphaned.map((parts) => JSON.stringify(parts.join('/'))).join(', ')}. Preserve those records and use the separately reviewed update/activation scope.`
        : undefined
  };
}

export async function assertSkillAliasRetirementStateAbsent(root: string): Promise<void> {
  const state = await captureRetirementControlState(root);
  if (state.issue) throw new Error(state.issue);
}

export interface RegisteredSkillMigrationDependencies {
  now?: () => Date;
  storage?: UpdatePreviewOptions;
  runner?: CommandRunner;
}

export interface RegisteredAliasSource {
  logicalName: string;
  pathParts: readonly string[];
  hash: string;
  mode: number;
  replacementLogicalName: string;
  replacementPathParts: readonly string[];
  replacementHash: string;
  replacementMode: number;
}

export interface SkillAliasMigrationRecord {
  schemaVersion: 1;
  kind: 'liftoff-skill-alias-retirement';
  identity: SkillAliasRetirementIdentity;
  projectRoot: string;
  sourceManifestHash: string;
  targetManifestHash: string;
  manifestMode: number;
  sources: readonly RegisteredAliasSource[];
}

export interface RegisteredSkillMigrationPlan {
  schemaVersion: 1;
  kind: 'liftoff-registered-skill-migration-plan';
  scope: 'project';
  projectRoot: string;
  identity: SkillAliasRetirementIdentity;
  fingerprint: string;
  updatePlanFingerprint: string;
  validFrom: string;
  expiresAt: string;
  sources: readonly RegisteredAliasSource[];
  effects: readonly {
    type: 'write' | 'delete';
    pathParts: readonly string[];
    beforeHash: string | null;
    afterHash: string | null;
    mode: number | null;
  }[];
  files: readonly SkillFileObservation[];
  directories: readonly SkillDirectoryObservation[];
  catalogInputs: SkillDiscoveryObservation;
}

interface PreparedMigration {
  selection: SkillMigrationOptions;
  dependencies: RegisteredSkillMigrationDependencies;
  mutations: ProjectFileMutation[];
  preconditions: ProjectFileSnapshot[];
  record: SkillAliasMigrationRecord;
  serialized: string;
}

const preparedMigrations = new WeakMap<RegisteredSkillMigrationPlan, PreparedMigration>();

export function registeredMigrationState(plan: RegisteredSkillMigrationPlan): PreparedMigration {
  const prepared = preparedMigrations.get(plan);
  if (!prepared || canonicalJson(plan) !== prepared.serialized) {
    throw new Error('Registered skill migration requires the unmodified plan produced by the current planner.');
  }
  return prepared;
}

export type RegisteredSkillMigrationPreparation =
  | { status: 'ready'; plan: RegisteredSkillMigrationPlan; inspection: SkillMigrationPlan }
  | { status: 'owning-update-required'; reason: string; inspection: SkillMigrationPlan };

export async function prepareRegisteredSkillMigration(
  root: string, selection: SkillMigrationOptions, dependencies: RegisteredSkillMigrationDependencies = {}
): Promise<RegisteredSkillMigrationPreparation> {
  const inspection = await planSkillMigration(root, selection);
  const requiresUpdate = (reason: string): RegisteredSkillMigrationPreparation => ({
    status: 'owning-update-required', reason, inspection
  });
  if (inspection.execution !== 'owning-update-required' || inspection.manifestVersion !== 8 ||
      inspection.registeredTransitions.some((entry) => entry.sourceState !== 'unchanged')) {
    return requiresUpdate('Direct retirement requires manifest 8 and existing unchanged registered aliases. Older, missing, modified, or broader sources retain their original managed-update path.');
  }
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('The skill migration clock is invalid.');
  const controlState = await captureRetirementControlState(inspection.projectRoot);
  if (controlState.issue) return requiresUpdate(controlState.issue);
  const update = await inspectProjectUpdate(inspection.projectRoot, { storage: dependencies.storage, runner: dependencies.runner });
  const review = await prepareUpdateReview(update, false, { runner: dependencies.runner, now });
  const registrations = retiredManagedCoreIdentities.filter((entry) =>
    inspection.registeredTransitions.some((transition) => transition.sourceLogicalId === entry.logicalName));
  const aliases = new Set<string>(registrations.map((entry) => entry.logicalName));
  const aliasPaths = new Set(registrations.map((entry) => entry.pathParts.join('/')));
  if (update.manifest.artifactVersion !== 8 || aliases.size === 0 ||
      !review.summary.eligible || review.summary.mode !== 'normal' || review.descriptor.mode !== 'normal' ||
      review.writePlan.force || review.needsRevalidation || review.revalidation !== undefined ||
      update.reconciliation.status !== 'not-required' ||
      update.stateMigration.status !== 'not-present' || update.historyMigration.status !== 'not-present' ||
      update.revalidationSource !== undefined || update.retainedSource !== undefined ||
      update.deferredAgentRepair !== null || update.ownershipMigrationPending || update.workloadIntentChanged ||
      review.writePlan.skipped.length > 0 || review.writePlan.written.length > 0 ||
      review.writePlan.provisioned.length > 0 ||
      update.provisioningPlans.length > 0 || update.manifestHistoryMutations.length > 0 ||
      update.stateMigration.mutations.length > 0 ||
      review.writePlan.mutations.length !== aliases.size + 1 ||
      new Set(review.writePlan.mutations.map((mutation) => `${mutation.type}:${mutation.pathParts.join('/')}`)).size !== aliases.size + 1 ||
      review.writePlan.mutations.some((mutation) => mutation.type === 'delete'
        ? !aliasPaths.has(mutation.pathParts.join('/'))
        : mutation.pathParts.join('/') !== 'liftoff.manifest.json') ||
      review.writePlan.retired.length !== aliases.size ||
      review.writePlan.retired.some((entry) => !aliases.has(entry.logicalName))) {
    return requiresUpdate('The released update planner requires effects outside these exact alias retirements. Complete its separate reviewed update first; skills migration cannot broaden scope or bypass revalidation.');
  }
  const sourceManifest = update.manifest;
  const expectedManifest = structuredClone(sourceManifest);
  expectedManifest.managedArtifacts = expectedManifest.managedArtifacts.filter((entry) => !aliases.has(entry.logicalName));
  if (expectedManifest.governance.profile !== 'none' && expectedManifest.governance.profile !== 'unspecified' &&
      expectedManifest.governance.state === 'handoff-partial' &&
      review.writePlan.nextManifest.governance.profile !== 'none' &&
      review.writePlan.nextManifest.governance.profile !== 'unspecified' &&
      review.writePlan.nextManifest.governance.state === 'handoff-generated') {
    expectedManifest.governance.state = 'handoff-generated';
  }
  if (canonicalJson(expectedManifest) !== canonicalJson(review.writePlan.nextManifest)) {
    return requiresUpdate('The manifest needs additional identity, profile, writer, or provenance changes. Those remain in the existing managed-update operation, not this bounded retirement.');
  }
  const files = new Map<string, CapturedSkillFile>();
  const capture = async (parts: readonly string[]) => {
    const key = parts.join('/');
    const captured = await captureSkillFile(inspection.projectRoot, parts);
    const before = files.get(key);
    if (before && canonicalJson(before.observation) !== canonicalJson(captured.observation)) {
      throw new Error(`Skill migration input changed during planning: ${key}`);
    }
    files.set(key, captured);
    return captured;
  };
  for (const file of controlState.files) {
    if (canonicalJson((await capture(file.observation.pathParts)).observation) !== canonicalJson(file.observation)) {
      throw new Error('Activation/migration control state changed during skill retirement preparation.');
    }
  }
  for (const file of inspection.files) {
    if (canonicalJson((await capture(file.pathParts)).observation) !== canonicalJson(file)) {
      throw new Error('Project transport inspection changed during registered migration preparation.');
    }
  }
  for (const snapshot of review.preconditions) {
    const current = (await capture(snapshot.pathParts)).snapshot;
    if ((current.content === undefined) !== (snapshot.content === undefined) ||
        current.mode !== snapshot.mode || current.content?.equals(snapshot.content!) === false) {
      throw new Error(`Released update inputs changed during skill migration preparation: ${snapshot.pathParts.join('/')}`);
    }
  }
  const sources: RegisteredAliasSource[] = [];
  for (const registration of registrations) {
    const source = sourceManifest.managedArtifacts.find((entry) => entry.logicalName === registration.logicalName)!;
    const replacement = sourceManifest.managedArtifacts.find((entry) => entry.logicalName === registration.replacementLogicalName);
    const target = update.render.find((entry) => entry.logicalName === registration.replacementLogicalName && entry.lifecycle === 'managed-core');
    if (!replacement || !target || replacement.pathParts.join('/') !== target.pathParts.join('/')) {
      return requiresUpdate('The registered replacement is not already manifest-owned at its retained native path.');
    }
    const sourceFile = await capture(source.pathParts);
    const targetFile = await capture(replacement.pathParts);
    if (!sourceFile.snapshot.content || source.contentHash !== `sha256:${sourceFile.observation.contentHash}` ||
        !targetFile.snapshot.content || replacement.contentHash !== `sha256:${targetFile.observation.contentHash}` ||
        !targetFile.snapshot.content.equals(Buffer.from(target.content))) {
      return requiresUpdate('Both the alias source and its already owned replacement must match their exact current bytes. No existing transport overwrite or destination adoption is allowed here.');
    }
    sources.push({
      logicalName: source.logicalName, pathParts: [...source.pathParts], hash: sourceFile.observation.contentHash!,
      mode: sourceFile.snapshot.mode!, replacementLogicalName: replacement.logicalName,
      replacementPathParts: [...replacement.pathParts], replacementHash: targetFile.observation.contentHash!,
      replacementMode: targetFile.snapshot.mode!
    });
  }
  const manifestSnapshot = (await capture(['liftoff.manifest.json'])).snapshot;
  const manifestMutation = review.writePlan.mutations.find((entry) =>
    entry.type === 'write' && entry.pathParts.join('/') === 'liftoff.manifest.json');
  if (!manifestSnapshot.content || !manifestMutation || manifestMutation.type !== 'write') {
    throw new Error('The released planner did not produce the exact manifest retirement effect.');
  }
  const historyKey = canonicalSha256({
    recipe: skillAliasRetirementRecipe, projectRoot: inspection.projectRoot, sources,
    sourceManifestHash: hash(manifestSnapshot.content), targetManifestHash: hash(manifestMutation.content),
    manifestMode: manifestSnapshot.mode
  });
  const identity = validateSkillsExecutionIdentity({
    cliVersion: liftoffVersion, skillsContractVersion: 1, recipe: skillAliasRetirementRecipe,
    scope: 'project', intent: 'migrate', catalogDigest: inspection.catalogDigest,
    hosts: inspection.hosts, skillIds: selection.skillIds
      ? CANONICAL_SKILL_IDS.filter((id) => selection.skillIds!.includes(id)) : [...CANONICAL_SKILL_IDS],
    retiredAliases: registrations.map((entry) => entry.logicalName), historyKey
  });
  if (identity.intent !== 'migrate') throw new Error('The registered migration identity did not retain its recipe.');
  const record: SkillAliasMigrationRecord = {
    schemaVersion: 1, kind: 'liftoff-skill-alias-retirement', identity, projectRoot: inspection.projectRoot,
    sourceManifestHash: hash(manifestSnapshot.content), targetManifestHash: hash(manifestMutation.content),
    sources, manifestMode: manifestSnapshot.mode!
  };
  const history = skillAliasHistoryPaths(identity);
  const mutations: ProjectFileMutation[] = [
    { type: 'write', pathParts: history.manifest, content: manifestSnapshot.content, mode: 0o600 },
    ...history.sources.map((entry): ProjectFileMutation => {
      const source = sources.find((source) => source.logicalName === entry.logicalName)!;
      return { type: 'write', pathParts: entry.pathParts, content: files.get(source.pathParts.join('/'))!.snapshot.content!, mode: 0o600 };
    }),
    { type: 'write', pathParts: history.record, content: canonicalJson(record), mode: 0o600 },
    ...review.writePlan.mutations
  ];
  for (const parts of [history.manifest, history.record, ...history.sources.map((entry) => entry.pathParts)]) {
    if ((await capture(parts)).snapshot.content !== undefined) {
      return requiresUpdate(`Migration history already occupies ${parts.join('/')}; it cannot be replaced or inferred to be owned.`);
    }
  }
  const start = Math.floor(now.getTime() / reviewWindow) * reviewWindow;
  const fields = {
    schemaVersion: 1 as const, kind: 'liftoff-registered-skill-migration-plan' as const,
    scope: 'project' as const, projectRoot: inspection.projectRoot, identity,
    updatePlanFingerprint: review.descriptor.fingerprint,
    validFrom: new Date(start).toISOString(), expiresAt: new Date(start + reviewWindow).toISOString(),
    sources, effects: mutations.map((mutation) => ({
      type: mutation.type, pathParts: [...mutation.pathParts],
      beforeHash: files.get(mutation.pathParts.join('/'))?.observation.contentHash ?? null,
      afterHash: mutation.type === 'write' ? hash(mutation.content) : null,
      mode: mutation.type === 'write' ? mutation.mode ?? files.get(mutation.pathParts.join('/'))?.snapshot.mode ?? null : null
    })),
    files: [...files.values()].map((entry) => entry.observation),
    directories: await captureSkillDirectories(inspection.projectRoot, [...files.values()].map((entry) => entry.snapshot.pathParts)),
    catalogInputs: inspection.catalogInputs
  };
  const plan: RegisteredSkillMigrationPlan = { ...fields, fingerprint: canonicalSha256(fields) };
  preparedMigrations.set(plan, {
    selection: { hosts: [...selection.hosts], ...(selection.skillIds ? { skillIds: [...selection.skillIds] } : {}) },
    dependencies, mutations, preconditions: [...files.values()].map((entry) => entry.snapshot),
    record, serialized: canonicalJson(plan)
  });
  return { status: 'ready', plan, inspection };
}

export async function recheckRegisteredSkillMigration(plan: RegisteredSkillMigrationPlan): Promise<RegisteredSkillMigrationPlan> {
  const prepared = registeredMigrationState(plan);
  const now = (prepared.dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(plan.validFrom) || now.getTime() >= Date.parse(plan.expiresAt)) {
    throw new Error('Registered skill migration expired; review a fresh plan.');
  }
  const current = await prepareRegisteredSkillMigration(plan.projectRoot, prepared.selection, prepared.dependencies);
  if (current.status !== 'ready') {
    throw new Error(`Registered skill migration prerequisites changed after review: ${current.reason}`);
  }
  if (canonicalJson(current.plan) !== prepared.serialized) {
    throw new Error('Registered skill migration inputs or prerequisites changed after review.');
  }
  return current.plan;
}

export async function verifyRegisteredSkillMigration(
  root: string, identity: SkillAliasRetirementIdentity
): Promise<void> {
  await assertSkillAliasRetirementStateAbsent(root);
  const history = skillAliasHistoryPaths(identity);
  const recordFile = await captureSkillFile(root, history.record);
  if (!recordFile.snapshot.content) throw new Error('Skill migration history is missing.');
  const value: unknown = JSON.parse(recordFile.snapshot.content.toString('utf8'));
  const keys = ['schemaVersion', 'kind', 'identity', 'projectRoot', 'sourceManifestHash', 'targetManifestHash', 'manifestMode', 'sources'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || value.kind !== 'liftoff-skill-alias-retirement' ||
      canonicalJson(value.identity) !== canonicalJson(identity) || value.projectRoot !== root ||
      !Array.isArray(value.sources) || value.sources.length !== identity.retiredAliases.length ||
      typeof value.sourceManifestHash !== 'string' || typeof value.targetManifestHash !== 'string' ||
      !Number.isInteger(value.manifestMode) || (value.manifestMode as number) < 0 || (value.manifestMode as number) > 0o7777) {
    throw new Error('Unregistered or changed skill migration history identity.');
  }
  if (canonicalJson(value) !== recordFile.snapshot.content.toString('utf8') ||
      !/^[a-f0-9]{64}$/u.test(value.sourceManifestHash) || !/^[a-f0-9]{64}$/u.test(value.targetManifestHash)) {
    throw new Error('Skill migration history lost its exact serializer or digest identities.');
  }
  if (canonicalSha256({
    recipe: skillAliasRetirementRecipe, projectRoot: root, sources: value.sources,
    sourceManifestHash: value.sourceManifestHash, targetManifestHash: value.targetManifestHash, manifestMode: value.manifestMode
  }) !== identity.historyKey) {
    throw new Error('Skill migration history does not match its approved immutable operation identity.');
  }
  const original = await captureSkillFile(root, history.manifest);
  const target = await captureSkillFile(root, ['liftoff.manifest.json']);
  const privateMode = process.platform === 'win32' ? 0o666 : 0o600;
  if (original.observation.contentHash !== value.sourceManifestHash || target.observation.contentHash !== value.targetManifestHash ||
      original.observation.mode !== privateMode || recordFile.observation.mode !== privateMode || target.observation.mode !== value.manifestMode) {
    throw new Error('Skill migration manifest history or committed readback changed.');
  }
  const manifest = await loadManifest(root);
  for (const registration of retiredManagedCoreIdentities.filter((entry) => identity.retiredAliases.includes(entry.logicalName))) {
    const source: unknown = value.sources.find((entry: unknown) => isRecord(entry) && entry.logicalName === registration.logicalName);
    const sourceKeys = ['logicalName', 'pathParts', 'hash', 'mode', 'replacementLogicalName', 'replacementPathParts', 'replacementHash', 'replacementMode'];
    if (!isRecord(source) || Object.keys(source).length !== sourceKeys.length || sourceKeys.some((key) => !Object.hasOwn(source, key)) ||
        !Array.isArray(source.replacementPathParts) ||
        source.replacementPathParts.some((part: unknown) => typeof part !== 'string') ||
        source.logicalName !== registration.logicalName || canonicalJson(source.pathParts) !== canonicalJson(registration.pathParts) ||
        source.replacementLogicalName !== registration.replacementLogicalName || typeof source.hash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(source.hash) || typeof source.replacementHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(source.replacementHash) || !Number.isInteger(source.mode) ||
        (source.mode as number) < 0 || (source.mode as number) > 0o7777 ||
        !Number.isInteger(source.replacementMode) || (source.replacementMode as number) < 0 || (source.replacementMode as number) > 0o7777) {
      throw new Error('Skill migration history contains an unregistered alias/replacement mapping.');
    }
    const replacement = manifest.managedArtifacts.find((entry) => entry.logicalName === registration.replacementLogicalName);
    if (!replacement || canonicalJson(replacement.pathParts) !== canonicalJson(source.replacementPathParts) ||
        replacement.contentHash !== `sha256:${source.replacementHash}` ||
        manifest.managedArtifacts.some((entry) => entry.logicalName === registration.logicalName)) {
      throw new Error('Committed native integration ownership differs from the registered retirement.');
    }
    const current = await captureSkillFile(root, replacement.pathParts);
    const retired = await captureSkillFile(root, registration.pathParts);
    const saved = await captureSkillFile(root, history.sources.find((entry) => entry.logicalName === registration.logicalName)!.pathParts);
    if (current.observation.contentHash !== source.replacementHash || current.observation.mode !== source.replacementMode ||
        retired.observation.state !== 'absent' || saved.observation.contentHash !== source.hash || saved.observation.mode !== privateMode) {
      throw new Error('A retained native target, retired alias, or original history copy changed; all newer bytes were preserved.');
    }
  }
  await assertSkillAliasRetirementStateAbsent(root);
}
