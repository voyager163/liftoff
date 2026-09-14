import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  ApplicationFiles, ApplicationInspectionError, applicationDigest, applicationExclusion, applicationFailure,
  applicationParts, applicationPathFold, applicationPathKey, applicationWithin, assertApplicationNoLinkAncestors
} from './application-files.js';
import { currentApplicationTargets, inspectApplicationLayout } from './application-inventory.js';
import { applicationText, inspectApplicationReferences } from './application-references.js';
import { applicationVerificationLimitation, validateApplicationCommands } from './application-commands.js';
import { assertApplicationCandidateBounds } from './application-candidate.js';
import { parseApplicationPreparation } from './application-preparation-inputs.js';
import { resolveApplicationPreparation } from './application-preparation.js';
import type { ApplicationInspectionOptions, ApplicationToolIdentity } from './application-preparation-types.js';
import {
  applicationBounds, type ApplicationDirectoryObservation, type ApplicationPatchCandidate,
  type ApplicationPatchDocument, type ApplicationPatchMapping, type ApplicationReference,
  type ApplicationReferenceDisposition, type ApplicationVerificationCommand, type ApplicationVerificationPolicy
} from './application-types.js';

function fields(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ApplicationInspectionError(`${label} must contain exactly the documented schema-1 fields.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ApplicationInspectionError(`${label} requires a complete lowercase SHA-256 digest.`);
  }
  return value;
}

function mode(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new ApplicationInspectionError('Application modes must be exact ordinary permission bits from 0 through 511.');
  }
  return value as number;
}

function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ApplicationInspectionError(`${label} must be a bounded array.`);
  }
  return value;
}

function noDuplicateKeys(text: string): void {
  let cursor = 0;
  const space = () => { while (/\s/u.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new ApplicationInspectionError('Application patch must contain valid JSON.');
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new ApplicationInspectionError('Application patch JSON exceeds the nesting bound.');
    space();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === '{') {
      cursor++;
      const seen = new Set<string>();
      space();
      if (text[cursor] === '}') { cursor++; return; }
      while (cursor < text.length) {
        space();
        const key = string();
        if (seen.has(key)) throw new ApplicationInspectionError('Application patch JSON contains duplicate object fields.');
        seen.add(key);
        space();
        cursor++;
        value(depth + 1);
        space();
        if (text[cursor++] === '}') return;
      }
    } else if (text[cursor] === '[') {
      cursor++;
      space();
      if (text[cursor] === ']') { cursor++; return; }
      while (cursor < text.length) {
        value(depth + 1);
        space();
        if (text[cursor++] === ']') return;
      }
    } else {
      while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor]!)) cursor++;
    }
  };
  value(0);
}

export function parseApplicationPatch(content: Buffer): ApplicationPatchDocument {
  if (content.byteLength > applicationBounds.patchBytes) throw new ApplicationInspectionError('Application patch exceeds the 64 KiB document bound.');
  const text = applicationText(content);
  if (text === null) throw new ApplicationInspectionError('Application patch must be UTF-8 JSON without NUL bytes.');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; noDuplicateKeys(text); }
  catch (error) {
    if (error instanceof ApplicationInspectionError) throw error;
    throw new ApplicationInspectionError('Application patch must contain valid JSON.');
  }
  const record = fields(parsed, [
    'schemaVersion', 'kind', 'projectRoot', 'inspectionDigest', 'targetLayoutDigest',
    'dynamicReferencesReviewed', 'unresolvedMappings', 'mappings', 'verification'
  ], 'Application patch');
  if (record.schemaVersion !== 1 || record.kind !== 'liftoff-application-patch' ||
      typeof record.projectRoot !== 'string' || !path.isAbsolute(record.projectRoot) ||
      record.dynamicReferencesReviewed !== true) {
    throw new ApplicationInspectionError('Application patch requires schema 1, a canonical absolute project root, and explicit developer review of dynamic references.');
  }
  if (boundedArray(record.unresolvedMappings, applicationBounds.files, 'Unresolved mappings').length !== 0) {
    throw new ApplicationInspectionError('Unresolved application mappings must be empty before a patch is executable.');
  }
  const mappings = boundedArray(record.mappings, applicationBounds.mappings, 'Application mappings').map((value): ApplicationPatchMapping => {
    const item = fields(value, [
      'sourcePathParts', 'targetPathParts', 'expectedSourceDigest', 'expectedSourceMode', 'stagedPathParts',
      'targetMode', 'role', 'targetIdentity', 'customization', 'references'
    ], 'Application mapping');
    const { kind, logicalName } = fields(item.targetIdentity, ['kind', 'logicalName'], 'Target identity');
    const { role, customization } = item;
    if ((kind !== 'generated-artifact' && kind !== 'custom-component') ||
        typeof logicalName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(logicalName) ||
        (role !== 'application' && role !== 'reference') ||
        (customization !== 'preserved' && customization !== 'reviewed-edit')) {
      throw new ApplicationInspectionError('Application mapping requires a recognized role, target identity, and explicit customization disposition.');
    }
    const references = boundedArray(item.references, applicationBounds.references, 'Mapping references').map((value): ApplicationReferenceDisposition => {
      const reference = fields(value, ['referenceId', 'disposition', 'afterTargetPathParts'], 'Reference disposition');
      const { disposition } = reference;
      if (disposition !== 'updated' && disposition !== 'unchanged-reviewed' && disposition !== 'historical-documentation') {
        throw new ApplicationInspectionError('Application reference disposition is unsupported.');
      }
      return {
        referenceId: digest(reference.referenceId, 'Reference ID'),
        disposition,
        afterTargetPathParts: reference.afterTargetPathParts === null ? null : applicationParts(reference.afterTargetPathParts)
      };
    });
    return {
      sourcePathParts: applicationParts(item.sourcePathParts),
      targetPathParts: applicationParts(item.targetPathParts),
      expectedSourceDigest: digest(item.expectedSourceDigest, 'Expected source'),
      expectedSourceMode: mode(item.expectedSourceMode),
      stagedPathParts: applicationParts(item.stagedPathParts),
      targetMode: mode(item.targetMode),
      role,
      targetIdentity: { kind, logicalName },
      customization,
      references
    };
  });
  if (!mappings.length) throw new ApplicationInspectionError('An application patch requires at least one explicit existing-file mapping.');
  const hasPreparation = isRecord(record.verification) && Object.hasOwn(record.verification, 'preparation');
  const verification = fields(record.verification, hasPreparation ? ['commands', 'preparation'] : ['commands'], 'Application verification');
  const preparation = parseApplicationPreparation(verification.preparation);
  const commands = boundedArray(verification.commands, applicationBounds.commands, 'Verification commands').map((value): ApplicationVerificationCommand => {
    const command = fields(value, ['executable', 'args', 'cwdPathParts', 'timeoutMs', 'maxOutputBytes', 'network'], 'Verification command');
    if (typeof command.executable !== 'string' || typeof command.network !== 'boolean' ||
        !Number.isSafeInteger(command.timeoutMs) || (command.timeoutMs as number) < 1 ||
        (command.timeoutMs as number) > applicationBounds.commandTimeoutMs ||
        !Number.isSafeInteger(command.maxOutputBytes) || (command.maxOutputBytes as number) < 1 ||
        (command.maxOutputBytes as number) > applicationBounds.commandOutputBytes) {
      throw new ApplicationInspectionError('Verification commands require an exact executable, network declaration, and finite time/output limits.');
    }
    const args = boundedArray(command.args, 32, 'Verification arguments');
    if (!args.every((arg) => typeof arg === 'string')) throw new ApplicationInspectionError('Verification arguments must be literal strings.');
    return {
      executable: command.executable, args, cwdPathParts: applicationParts(command.cwdPathParts, true),
      timeoutMs: command.timeoutMs as number, maxOutputBytes: command.maxOutputBytes as number, network: command.network
    };
  });
  if (!commands.length) throw new ApplicationInspectionError('An application patch must declare at least one separately authorized check.');
  return {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: record.projectRoot,
    inspectionDigest: digest(record.inspectionDigest, 'Inspection'), targetLayoutDigest: digest(record.targetLayoutDigest, 'Target layout'),
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings,
    verification: { commands, ...(hasPreparation ? { preparation } : {}) }
  };
}

function descriptors(snapshots: readonly ProjectFileSnapshot[]) {
  return snapshots.map((item) => ({
    pathParts: item.pathParts, digest: item.content === undefined ? null : applicationDigest(item.content), mode: item.mode ?? null
  })).sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
}

export function applicationCandidateDigest(candidate: ApplicationPatchCandidate): string {
  return canonicalSha256({
    scope: candidate.scope, verificationPolicy: candidate.verificationPolicy, snapshots: descriptors(candidate.snapshots),
    mutations: candidate.mutations.map((item) => ({
      type: item.type, pathParts: item.pathParts, digest: item.type === 'write' ? applicationDigest(item.content) : null,
      mode: item.type === 'write' ? item.mode ?? null : null
    }))
  });
}

interface PrivateCandidateBinding {
  manifest: LiftoffManifest;
  digest: string;
  projectRoot: string;
  inspectionDigest: string;
  inspectionOptions: ApplicationInspectionOptions;
}
const bindings = new WeakMap<ApplicationPatchCandidate, PrivateCandidateBinding>();

export async function applicationInspectedProjectUnchanged(root: string, candidate: ApplicationPatchCandidate): Promise<boolean> {
  const binding = bindings.get(candidate);
  if (!binding || path.resolve(root) !== binding.projectRoot) return false;
  const current = await inspectApplicationLayout(root, binding.manifest);
  return current.report.complete && current.report.inspectionDigest === binding.inspectionDigest;
}

export async function assertApplicationCandidateCurrent(root: string, candidate: ApplicationPatchCandidate): Promise<void> {
  const binding = bindings.get(candidate);
  if (!binding || candidate.blockers.length || candidate.scope.projectRoot !== path.resolve(root) ||
      applicationCandidateDigest(candidate) !== binding.digest) {
    throw new ApplicationInspectionError('Application candidate is blocked, unrecognized, or changed after inspection; request a new preview.');
  }
  const current = await inspectApplicationPatchState(
    root, binding.manifest, candidate.patchPath, binding.inspectionOptions, candidate.verificationPolicy.toolchain
  );
  if (current.blockers.length || applicationCandidateDigest(current) !== binding.digest) {
    throw new ApplicationInspectionError('Application source, directories, modes, patch, or staging changed after review; request a new inspection and preview.');
  }
}

function mergeDirectories(...inventories: ApplicationDirectoryObservation[][]): ApplicationDirectoryObservation[] {
  const merged = new Map<string, ApplicationDirectoryObservation>();
  for (const inventory of inventories) {
    for (const item of inventory) {
      const key = applicationPathKey(item.pathParts);
      const previous = merged.get(key);
      if (previous && canonicalSha256(previous) !== canonicalSha256(item)) {
        throw new ApplicationInspectionError('Application directory inventory changed while inspecting the patch.');
      }
      merged.set(key, item);
    }
  }
  return [...merged.values()].sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
}

function validateMappingCollisions(mappings: readonly ApplicationPatchMapping[]): void {
  const sources = new Set<string>(), targets = new Set<string>(), staged = new Set<string>();
  const paths: { key: string; index: number }[] = [];
  for (const [index, item] of mappings.entries()) {
    const source = applicationPathFold(applicationPathKey(item.sourcePathParts));
    const target = applicationPathFold(applicationPathKey(item.targetPathParts));
    const stage = applicationPathFold(applicationPathKey(item.stagedPathParts));
    if (sources.has(source) || targets.has(target) || staged.has(stage) ||
        source === target && applicationPathKey(item.sourcePathParts) !== applicationPathKey(item.targetPathParts)) {
      throw new ApplicationInspectionError('Application mappings contain duplicate or case-normalized source, target, or staging paths.');
    }
    sources.add(source); targets.add(target); staged.add(stage);
    paths.push({ key: source, index }, { key: target, index });
  }
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      const a = paths[left]!, b = paths[right]!;
      if (a.key === b.key && a.index !== b.index || a.key.startsWith(`${b.key}/`) || b.key.startsWith(`${a.key}/`)) {
        throw new ApplicationInspectionError('Application source and destination files must not collide or overlap across mappings.');
      }
    }
  }
}

function validateReferenceReview(
  mappings: readonly ApplicationPatchMapping[], before: readonly ApplicationReference[],
  after: readonly ApplicationReference[], candidateFiles: readonly ProjectFileSnapshot[],
  directories: readonly ApplicationDirectoryObservation[]
): void {
  const mapped = new Map(mappings.map((item) => [applicationPathKey(item.sourcePathParts), item]));
  const moves = mappings.filter((item) => applicationPathKey(item.sourcePathParts) !== applicationPathKey(item.targetPathParts));
  const affected = (reference: ApplicationReference) => moves.some((move) => {
    const source = applicationPathKey(move.sourcePathParts), target = applicationPathKey(reference.targetPathParts);
    return source === target || reference.targetKind === 'directory' && source.startsWith(`${target}/`);
  });
  for (const reference of before) {
    if (affected(reference) && !mapped.has(applicationPathKey(reference.sourcePathParts))) {
      throw new ApplicationInspectionError(`${reference.sourcePathParts.join('/')}: an affected reference requires its own exact existing-file mapping and disposition.`);
    }
  }
  const existing = new Set(candidateFiles.filter((item) => item.content !== undefined).map((item) => applicationPathKey(item.pathParts)));
  for (const directory of directories.filter((item) => item.exists)) existing.add(applicationPathKey(directory.pathParts));
  for (const snapshot of candidateFiles) {
    if (snapshot.content === undefined) continue;
    for (let index = 1; index < snapshot.pathParts.length; index++) existing.add(applicationPathKey(snapshot.pathParts.slice(0, index)));
  }
  for (const mapping of mappings) {
    const source = applicationPathKey(mapping.sourcePathParts), target = applicationPathKey(mapping.targetPathParts);
    const outgoing = before.filter((item) => applicationPathKey(item.sourcePathParts) === source);
    if (mapping.references.length !== outgoing.length || new Set(mapping.references.map((item) => item.referenceId)).size !== outgoing.length) {
      throw new ApplicationInspectionError(`${source}: every observed outgoing reference requires exactly one reviewed disposition.`);
    }
    const historical = new Set<string>();
    for (const disposition of mapping.references) {
      const reference = outgoing.find((item) => item.id === disposition.referenceId);
      if (!reference) throw new ApplicationInspectionError(`${source}: unknown reference identity.`);
      if (disposition.disposition === 'historical-documentation') {
        if (mapping.role !== 'reference' || !/\.(?:md|mdx|rst|txt|adoc)$/iu.test(source) || disposition.afterTargetPathParts !== null) {
          throw new ApplicationInspectionError('Historical reference dispositions are limited to explicitly mapped documentation.');
        }
        historical.add(applicationPathKey(reference.targetPathParts));
        continue;
      }
      if (disposition.afterTargetPathParts === null) throw new ApplicationInspectionError('Reviewed references require a concrete candidate target.');
      const afterTarget = applicationPathKey(disposition.afterTargetPathParts);
      if (disposition.disposition === 'unchanged-reviewed' && afterTarget !== applicationPathKey(reference.targetPathParts)) {
        throw new ApplicationInspectionError('Unchanged reference dispositions must retain their exact target.');
      }
      if (!existing.has(afterTarget) || !after.some((item) =>
        applicationPathKey(item.sourcePathParts) === target && applicationPathKey(item.targetPathParts) === afterTarget)) {
        throw new ApplicationInspectionError(`${source}: staged bytes do not contain the declared concrete reference target.`);
      }
    }
    for (const reference of after.filter((item) => applicationPathKey(item.sourcePathParts) === target)) {
      const targetPath = applicationPathKey(reference.targetPathParts);
      if (!existing.has(targetPath) && !historical.has(targetPath)) {
        throw new ApplicationInspectionError(`${source}: staged bytes retain a reference to a removed source.`);
      }
    }
  }
}

async function inspectApplicationPatchState(
  root: string, manifest: LiftoffManifest, externalPatchFile: string, options: ApplicationInspectionOptions,
  approvedTools?: readonly ApplicationToolIdentity[]
): Promise<ApplicationPatchCandidate> {
  const inspection = await inspectApplicationLayout(root, manifest);
  const projectRoot = inspection.report.projectRoot;
  const patchPath = path.resolve(externalPatchFile);
  const verificationPolicy: ApplicationVerificationPolicy = {
    kind: 'isolated-application-checks', commands: [], preparation: [], toolchain: [], executionCommands: [], outputRoles: [],
    effects: { projectCode: true, preparation: false, lifecycle: false, isolatedCopy: true, network: false, securitySandbox: false }
  };
  const blockers = [...inspection.report.blockers];
  const candidate: ApplicationPatchCandidate = {
    patchPath, blockers, snapshots: inspection.snapshots, mutations: [],
    scope: {
      kind: 'application-layout-patch', sourceLayout: 'explicit-project-file-mapping-v1', projectRoot,
      manifestDigest: canonicalSha256(manifest), inspectionDigest: inspection.report.inspectionDigest,
      target: inspection.report.target, patch: { path: patchPath, digest: null, mode: null },
      staging: { root: path.dirname(patchPath), files: [], directoryInventory: [] },
      directoryInventory: inspection.report.directoryInventory, mappings: [], references: inspection.report.references,
      candidateReferences: [], dynamicReferencesReviewed: false, preparation: [], toolchain: []
    },
    verificationPolicy,
    get networkRequired() { return verificationPolicy.effects.network; },
    report: {
      schemaVersion: 1, kind: 'liftoff-application-patch-report', projectRoot, patchPath, status: 'blocked',
      inventory: inspection.report, effects: [], verificationPolicy, blockers,
      get networkRequired() { return verificationPolicy.effects.network; },
      limitations: [
        'Every operation is an explicit developer-reviewed file mapping. Current generator starter bytes are never used as replacements.',
        'Inspection and preview alone execute no checks or file writes. Interactive repair separately asks action-specific Yes/No questions (default No) for verification, declared network effects, and file writes, using only the displayed immutable plan.',
        'Humans do not need to copy fingerprints. Optional --verify-plan, --allow-network, and --approve-plan automation requires the same actual user-approved immutable plan and effect scopes; a generic repair request, unrelated approval, autopilot mode or agent-generated Yes, generic --yes, and piped input are not authority.',
        applicationVerificationLimitation
      ]
    }
  };
  Object.defineProperty(candidate, 'snapshots', { enumerable: false });
  Object.defineProperty(candidate, 'mutations', { enumerable: false });
  Object.defineProperty(candidate, 'networkRequired', { configurable: false });
  Object.defineProperty(candidate.report, 'networkRequired', { configurable: false });
  if (blockers.length || !inspection.report.complete || !inspection.report.target) return candidate;
  try {
    if (applicationWithin(projectRoot, patchPath)) {
      throw new ApplicationInspectionError('Application patches and replacement staging must be outside the real project.');
    }
    await assertApplicationNoLinkAncestors(patchPath);
    const canonicalPatch = await realpath(patchPath);
    if (canonicalPatch !== patchPath) {
      throw new ApplicationInspectionError('External application patch path must use its exact canonical spelling without aliases.');
    }
    const stagingRoot = path.dirname(canonicalPatch);
    if (applicationWithin(projectRoot, stagingRoot) || applicationWithin(stagingRoot, projectRoot)) {
      throw new ApplicationInspectionError('Application staging and the project must be disjoint directories, not ancestors of one another.');
    }
    candidate.patchPath = canonicalPatch;
    candidate.report.patchPath = canonicalPatch;
    candidate.scope.patch.path = canonicalPatch;
    candidate.scope.staging.root = stagingRoot;
    const stage = new ApplicationFiles(stagingRoot, (parts) => applicationExclusion(parts));
    const patch = await stage.read([path.basename(canonicalPatch)], applicationBounds.patchBytes);
    if (!patch.content) throw new ApplicationInspectionError('The external application patch file is missing.');
    candidate.scope.patch.digest = applicationDigest(patch.content);
    candidate.scope.patch.mode = patch.mode!;
    const document = parseApplicationPatch(patch.content);
    if (document.projectRoot !== projectRoot || document.inspectionDigest !== inspection.report.inspectionDigest ||
        document.targetLayoutDigest !== inspection.report.target.digest) {
      throw new ApplicationInspectionError('Application patch belongs to another root, stale inspection, or different current target inventory.');
    }
    validateMappingCollisions(document.mappings);
    const current = currentApplicationTargets(manifest);
    const source = new ApplicationFiles(projectRoot, (parts) =>
      applicationExclusion(parts, current.protectedPaths, current.examplePaths));
    const snapshots = new Map(inspection.snapshots.map((item) => [applicationPathKey(item.pathParts), item]));
    const transformed = new Map(snapshots);
    candidate.scope.mappings = document.mappings;
    candidate.scope.dynamicReferencesReviewed = true;
    verificationPolicy.commands = document.verification.commands;
    verificationPolicy.effects.network = verificationPolicy.commands.some((item) => item.network);
    for (const mapping of document.mappings) {
      const sourceKey = applicationPathKey(mapping.sourcePathParts), targetKey = applicationPathKey(mapping.targetPathParts);
      if (process.platform === 'win32' && mapping.targetMode !== (mapping.targetMode & 0o200 ? 0o666 : 0o444)) {
        throw new ApplicationInspectionError('Windows application target modes must bind the effective native read-only or writable mode (444 or 666 octal).');
      }
      const targetIdentity = current.target.artifacts.find((item) => item.logicalName === mapping.targetIdentity.logicalName);
      if (!targetIdentity) throw new ApplicationInspectionError('Application patch names an unknown or unselected current target identity.');
      for (const parts of [mapping.sourcePathParts, mapping.targetPathParts]) {
        if (applicationExclusion(parts, current.protectedPaths, current.examplePaths)) {
          throw new ApplicationInspectionError(`${parts.join('/')}: protected files cannot participate in an application patch.`);
        }
      }
      const exactTarget = current.target.artifacts.find((item) =>
        applicationPathFold(applicationPathKey(item.pathParts)) === applicationPathFold(targetKey));
      if (exactTarget && applicationPathKey(exactTarget.pathParts) !== targetKey) {
        throw new ApplicationInspectionError('Application destination aliases a generated target identity.');
      }
      if (mapping.targetIdentity.kind === 'generated-artifact') {
        if (applicationPathKey(targetIdentity.pathParts) !== targetKey) {
          throw new ApplicationInspectionError('Generated target identity requires its exact current path.');
        }
      } else {
        if (exactTarget) throw new ApplicationInspectionError('A generated target path must use its exact generated-artifact identity.');
        if (mapping.role === 'application') {
          const componentRoot = applicationPathKey(targetIdentity.componentRootPathParts);
          if (!componentRoot || !targetKey.startsWith(`${componentRoot}/`) ||
              targetIdentity.component === 'functions' && targetIdentity.componentRootPathParts.length !== 2) {
            throw new ApplicationInspectionError('Custom application files require an explicit mapping into a selected current application component.');
          }
        } else if (sourceKey !== targetKey) {
          throw new ApplicationInspectionError('Custom reference edits must map the exact existing file to the same path.');
        }
      }
      const observed = snapshots.get(sourceKey);
      if (!observed?.content) throw new ApplicationInspectionError(`${sourceKey}: mapping source is not an inspected application file.`);
      const fresh = await source.read(mapping.sourcePathParts);
      if (fresh.content === undefined || !fresh.content.equals(observed.content) || fresh.mode !== observed.mode ||
          applicationDigest(fresh.content) !== mapping.expectedSourceDigest || fresh.mode !== mapping.expectedSourceMode) {
        throw new ApplicationInspectionError(`${sourceKey}: source bytes or mode differ from the exact inspected mapping.`);
      }
      const destination = sourceKey === targetKey ? fresh : await source.read(mapping.targetPathParts);
      if (sourceKey !== targetKey && destination.content !== undefined) {
        throw new ApplicationInspectionError(`${targetKey}: move destination must be absent, even if its content matches.`);
      }
      snapshots.set(targetKey, destination);
      const stageKey = applicationPathKey(mapping.stagedPathParts);
      if (applicationPathFold(stageKey) === applicationPathFold(path.basename(canonicalPatch))) {
        throw new ApplicationInspectionError('The patch document cannot also be a staged replacement.');
      }
      const replacement = await stage.read(mapping.stagedPathParts);
      if (replacement.content === undefined) throw new ApplicationInspectionError('An exact external staged replacement is missing.');
      if (mapping.customization === 'preserved' && !replacement.content.equals(observed.content)) {
        throw new ApplicationInspectionError(`${sourceKey}: preserved customization requires byte-identical staged content; declare reviewed-edit for intentional changes.`);
      }
      candidate.scope.staging.files.push({
        pathParts: mapping.stagedPathParts, digest: applicationDigest(replacement.content), mode: replacement.mode!
      });
      transformed.delete(sourceKey);
      transformed.set(targetKey, { pathParts: mapping.targetPathParts, content: replacement.content, mode: mapping.targetMode });
      if (sourceKey !== targetKey || !replacement.content.equals(observed.content) || mapping.targetMode !== observed.mode) {
        candidate.mutations.push({ type: 'write', pathParts: mapping.targetPathParts, content: replacement.content, mode: mapping.targetMode });
        if (sourceKey !== targetKey) candidate.mutations.push({ type: 'delete', pathParts: mapping.sourcePathParts });
      }
      candidate.report.effects.push({
        sourcePathParts: mapping.sourcePathParts, targetPathParts: mapping.targetPathParts,
        beforeDigest: mapping.expectedSourceDigest, afterDigest: applicationDigest(replacement.content),
        beforeMode: mapping.expectedSourceMode, afterMode: mapping.targetMode,
        role: mapping.role, targetIdentity: mapping.targetIdentity, customization: mapping.customization, references: mapping.references
      });
    }
    candidate.snapshots = [...snapshots.values()].sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
    candidate.scope.directoryInventory = mergeDirectories(inspection.report.directoryInventory, source.directoryInventory);
    assertApplicationCandidateBounds(candidate);
    const transformedFiles = [...transformed.values()];
    candidate.scope.candidateReferences = inspectApplicationReferences(transformedFiles, candidate.scope.directoryInventory,
      document.mappings.map((item) => item.sourcePathParts));
    validateReferenceReview(document.mappings, inspection.report.references, candidate.scope.candidateReferences,
      transformedFiles, candidate.scope.directoryInventory);
    validateApplicationCommands(verificationPolicy.commands, transformedFiles, candidate.scope.directoryInventory);
    if (!candidate.mutations.length) throw new ApplicationInspectionError('The staged application patch contains no actual file or mode changes.');
    await resolveApplicationPreparation(candidate, document.verification.preparation ?? [], options, approvedTools);
    await source.assertUnchanged();
    await stage.assertUnchanged();
    if (stage.directoryInventory.some((directory) => directory.entries.some((entry) => entry.kind === 'symlink' || entry.kind === 'other'))) {
      throw new ApplicationInspectionError('External application staging inventory contains an unsafe link or non-regular entry.');
    }
    const repeated = await inspectApplicationLayout(projectRoot, manifest);
    if (!repeated.report.complete || repeated.report.inspectionDigest !== inspection.report.inspectionDigest) {
      throw new ApplicationInspectionError('Application inventory changed during patch inspection.');
    }
    candidate.scope.staging.directoryInventory = [...stage.directoryInventory]
      .sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
    candidate.report.status = 'proposed';
    bindings.set(candidate, {
      manifest: structuredClone(manifest), digest: applicationCandidateDigest(candidate),
      projectRoot, inspectionDigest: inspection.report.inspectionDigest,
      inspectionOptions: { ...options, ...(options.env ? { env: { ...options.env } } : {}) }
    });
  } catch (error) {
    candidate.blockers.push(applicationFailure(error));
    candidate.mutations = [];
  }
  return candidate;
}

export async function inspectApplicationPatch(
  root: string, manifest: LiftoffManifest, externalPatchFile: string, options: ApplicationInspectionOptions = {}
): Promise<ApplicationPatchCandidate> {
  return inspectApplicationPatchState(root, manifest, externalPatchFile, options);
}

export type { ApplicationPatchCandidate, ApplicationPatchDocument } from './application-types.js';
