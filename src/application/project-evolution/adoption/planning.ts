import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type {
  GeneratedArtifact, LiftoffManifestV8, ManifestComponent, ManifestProjectArtifact, ManifestStandards
} from '../../../domain/project/contracts.js';
import { canonicalSha256, isRecord } from '../../../domain/governance/activation/canonical-json.js';
import { adoptionExecutionIdentity } from '../../../domain/project-evolution/adoption/identity.js';
import type { AdoptionEffect, AdoptionFrameworkSelection, AdoptionPlan } from '../../../domain/project-evolution/adoption/contracts.js';
import { managedCoreArtifactPaths } from '../../../domain/project/artifact-lifecycle.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../../adapters/filesystem/project-transaction.js';
import type { ReviewedAdoptionDirectorySnapshot } from '../../../adapters/filesystem/reviewed-update-transaction.js';
import { captureProjectFileSnapshot } from '../../../adapters/filesystem/project-transaction.js';
import { getProfileIdentity, loadPackagedProfilesCatalog, loadPackagedTemplateCatalog } from '../../../adapters/packaged-assets/resource-catalog.js';
import { isActualGoHumaImportAndUsage } from '../../standards-assessment/index.js';
import type { CommandRunner } from '../../../process-runner.js';
import type { UpdatePreviewOptions } from '../../../adapters/filesystem/update-previews.js';
import { liftoffVersion } from '../../../version.js';
import { parseManifest } from '../../project/manifest.js';
import { buildComponentManagedArtifacts, componentDesiredState, componentMaintenancePlan } from '../../project/component-artifacts.js';
import { assessProject } from '../../standards-assessment/runner.js';
import type { AssessmentResult } from '../../../domain/standards-assessment/types.js';
import {
  ApplicationFiles, ApplicationInspectionError, applicationDigest, applicationExclusion, applicationParts,
  applicationPathFold, applicationPathKey, applicationWithin, assertApplicationNoLinkAncestors, canonicalApplicationRoot
} from '../../repair/application-files.js';
import { applicationCandidateDigest, inspectAdoptionApplicationPatch, validateReferenceReview } from '../../repair/application-patch-inspection.js';
import { currentApplicationTargets, inspectApplicationLayout } from '../../repair/application-inventory.js';
import { applicationCandidateFiles, assertApplicationCandidateBounds } from '../../repair/application-candidate.js';
import { validateApplicationCommands, applicationVerificationLimitation } from '../../repair/application-commands.js';
import { inspectApplicationReferences } from '../../repair/application-references.js';
import { resolveApplicationPreparation } from '../../repair/application-preparation.js';
import { snapshotDescriptors } from '../../repair/preview.js';
import type { ApplicationCandidate, ApplicationDirectoryObservation, ApplicationInventoryReport, ApplicationPatchCandidate } from '../../repair/application-types.js';
import type { ApplicationToolIdentity } from '../../repair/application-preparation-types.js';
import type { AdoptionInspectionContext } from './context.js';
import { parseAdoptionProposal, type AdoptionProposal } from './proposal.js';
import { inspectAdoptionFramework, readPreparedAdoptionFramework, type FrameworkPreparation } from './framework.js';

export const adoptionPreviewTtlMs = 15 * 60_000;
export const adoptionFileMode = process.platform === 'win32' ? 0o666 : 0o600;
export const adoptionHistoryPath = (recordId: string): string[] => ['.liftoff', 'adoption-history', recordId, 'record.json'];

export interface AdoptionPlanningOptions {
  project: string;
  profile?: string;
  component?: string;
  proposal?: string;
  now?: Date;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  approvedTools?: readonly ApplicationToolIdentity[];
  storage?: UpdatePreviewOptions;
}

export interface AdoptionInspection {
  projectRoot: string;
  assessment: AssessmentResult;
  inventory: ApplicationInventoryReport;
  context: AdoptionInspectionContext;
  plan: AdoptionPlan;
  manifest: LiftoffManifestV8;
  snapshots: ProjectFileSnapshot[];
  directories: ReviewedAdoptionDirectorySnapshot[];
  mutations: ProjectFileMutation[];
  application: ApplicationCandidate;
  proposal: AdoptionProposal | null;
  framework: FrameworkPreparation | null;
  blockers: string[];
  limitations: string[];
}

function profileAlias(value: string): string {
  const aliases: Record<string, string> = { vue: 'vue-component', frontend: 'vue-component', fastapi: 'python-fastapi', fastify: 'node-fastify', huma: 'go-huma' };
  return Object.hasOwn(aliases, value) ? aliases[value]! : value;
}

function rootParts(value: string | undefined): string[] {
  if (value === undefined || value === '' || value === '.') return [];
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new ApplicationInspectionError('A component boundary must be a project-relative path.');
  return applicationParts(value.split(path.sep));
}

function assessmentIdentity(assessment: AssessmentResult): string {
  return canonicalSha256({
    target: assessment.target, profile: assessment.profile,
    inventory: {
      files: assessment.inventory.files.map(({ path, digest, size, category, unstable }) => ({ path, digest, size, category, ...(unstable !== undefined ? { unstable } : {}) })),
      unobserved: assessment.inventory.unobserved, limits: assessment.inventory.limits,
      exclusions: assessment.inventory.protectedExclusions
    }
  });
}

function inComponent(parts: readonly string[], component: ManifestComponent): boolean {
  return component.rootPathParts.length === 0 || applicationPathKey(parts).startsWith(`${applicationPathKey(component.rootPathParts)}/`);
}

function verifyObservedProfile(component: ManifestComponent, files: readonly ProjectFileSnapshot[]): string[] {
  const selected = files.filter((file) => file.content !== undefined && inComponent(file.pathParts, component));
  const file = (name: string) => selected.find((file) => applicationPathKey(file.pathParts) === applicationPathKey([...component.rootPathParts, name]))?.content;
  const source = selected.filter((file) => /\.(?:[cm]?[jt]sx?|vue|py|go)$/u.test(file.pathParts.at(-1)!))
    .map((file) => file.content!.toString('utf8').replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|'''[\s\S]*?'''|"""[\s\S]*?"""|`(?:\\[\s\S]|[^`])*`|^\s*(?:\/\/|#).*$/gmu, ''));
  const profile = component.profile.id;
  if (profile === 'node-fastify' || profile === 'vue-component') {
    let declaration: unknown;
    try { declaration = JSON.parse(file('package.json')?.toString('utf8') ?? 'null') as unknown; }
    catch { return ['The selected component package.json is malformed; profile support is unobserved.']; }
    const dependency = profile === 'vue-component' ? 'vue' : 'fastify';
    const dependencies = isRecord(declaration) && isRecord(declaration.dependencies) ? declaration.dependencies : {};
    const supported = typeof dependencies[dependency] === 'string' && !/^(?:file:|link:|workspace:|git|https?:)/u.test(String(dependencies[dependency]));
    const imported = profile === 'vue-component'
      ? source.some((text) => /(?:^\s*import[\w\s{},*$]*['"]vue['"]|^\s*<template(?:\s|>))/mu.test(text))
      : source.some((text) => /(?:^\s*import[\w\s{},*$]*['"]fastify['"]|^\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]fastify['"]\s*\))/mu.test(text));
    if (typeof dependencies.express === 'string' && source.some((text) =>
      /(?:^\s*import[\w\s{},*$]*['"]express['"]|^\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]express['"]\s*\))/mu.test(text))) {
      return ['The selected component contains observed unsupported Express application scope. Select a disjoint supported component; no conversion is inferred.'];
    }
    return supported && imported ? [] : [`Current declarations and source do not establish ${profile}; profile selection cannot authorize an unsupported framework conversion.`];
  }
  if (profile === 'go-huma') {
    const declaration = file('go.mod')?.toString('utf8').replace(/\/\/.*$/gmu, '') ?? '';
    return /github\.com\/danielgtaylor\/huma\/v2\s+v2\./u.test(declaration) &&
      selected.some((entry) => entry.pathParts.at(-1)!.endsWith('.go') &&
        !entry.pathParts.at(-1)!.endsWith('_test.go') &&
        isActualGoHumaImportAndUsage(entry.content!.toString('utf8')))
      ? [] : ['Current Go declarations, imports and non-test framework usage do not establish supported Huma v2; no conversion is executable.'];
  }
  let dependencies: unknown = [];
  try {
    const pyproject = file('pyproject.toml');
    if (pyproject) {
      const parsed = parseToml(pyproject.toString('utf8'));
      dependencies = isRecord(parsed.project) ? parsed.project.dependencies : [];
    } else {
      dependencies = (file('requirements.txt')?.toString('utf8') ?? '').split(/\r?\n/u)
        .map((line) => line.replace(/\s+#.*$/u, '').trim()).filter((line) => /^[a-z0-9][a-z0-9_.-]*(?:\[|[<>=!~ ]|$)/iu.test(line));
    }
  } catch { return ['The selected pyproject.toml cannot be safely interpreted for adoption.']; }
  const declared = Array.isArray(dependencies) ? dependencies.filter((entry): entry is string => typeof entry === 'string') : [];
  const fastapi = declared.some((entry) => /^fastapi(?:\[|[<>=!~ ]|$)/iu.test(entry)) &&
    source.some((text) => /^\s*(?:from\s+fastapi\s+import\s+|import\s+fastapi\b)/mu.test(text));
  const genai = !profile.startsWith('genai-') || declared.some((entry) => /^pydantic[-_]ai(?:[-_a-z]*)(?:\[|[<>=!~ ]|$)/iu.test(entry)) &&
    source.some((text) => /^\s*(?:from\s+pydantic_ai\b|import\s+pydantic_ai\b)/mu.test(text));
  return fastapi && genai ? [] : ['Current Python declarations and source do not establish the selected supported FastAPI/GenAI component. No semantic conversion or pattern history is inferred.'];
}

function sortedSnapshots(snapshots: readonly ProjectFileSnapshot[]): ProjectFileSnapshot[] {
  const entries = new Map<string, ProjectFileSnapshot>();
  for (const snapshot of snapshots) {
    const key = applicationPathKey(snapshot.pathParts), previous = entries.get(key);
    if (previous && (previous.mode !== snapshot.mode || (previous.content === undefined) !== (snapshot.content === undefined) ||
      previous.content !== undefined && !previous.content.equals(snapshot.content!))) {
      throw new ApplicationInspectionError('Adoption source or destination changed while the immutable plan was collected.');
    }
    entries.set(key, snapshot);
  }
  return [...entries.values()].sort((left, right) => applicationPathKey(left.pathParts).localeCompare(applicationPathKey(right.pathParts), 'en'));
}

function mergeDirectories(...inventories: readonly ApplicationDirectoryObservation[][]): ApplicationDirectoryObservation[] {
  const entries = new Map<string, ApplicationDirectoryObservation>();
  for (const inventory of inventories) for (const entry of inventory) {
    const key = applicationPathKey(entry.pathParts), previous = entries.get(key);
    if (previous && canonicalSha256(previous) !== canonicalSha256(entry)) throw new ApplicationInspectionError('Adoption directory inventory changed during planning.');
    entries.set(key, entry);
  }
  return [...entries.values()].sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
}

async function directoryIdentities(root: string, inventory: readonly ApplicationDirectoryObservation[]) {
  return Promise.all(inventory.map(async (directory) => {
    try {
      const info = await lstat(path.join(root, ...directory.pathParts));
      if (!directory.exists || !info.isDirectory() || info.isSymbolicLink() ||
        (info.mode & 0o7777) !== directory.mode || !Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino) || info.ino <= 0) {
        throw new ApplicationInspectionError('An adoption directory changed or cannot supply a stable creation identity.');
      }
      return {
        pathParts: directory.pathParts, state: 'directory' as const,
        device: info.dev, inode: info.ino, mode: info.mode & 0o7777, birthtime: String(info.birthtimeMs)
      };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' && !directory.exists) {
        return { pathParts: directory.pathParts, state: 'absent' as const };
      }
      throw error;
    }
  }));
}

export async function inspectAdoption(options: AdoptionPlanningOptions): Promise<AdoptionInspection> {
  if (!options.project) throw new ApplicationInspectionError('Adoption requires an explicitly selected existing --project directory.');
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ApplicationInspectionError('Adoption clock is invalid.');
  const projectRoot = await canonicalApplicationRoot(options.project);
  if (projectRoot !== path.resolve(options.project)) throw new ApplicationInspectionError('Use the canonical project boundary; adoption does not follow aliased roots.');
  await assertApplicationNoLinkAncestors(projectRoot);
  const manifestSnapshot = await captureProjectFileSnapshot(projectRoot, ['liftoff.manifest.json']);
  if (manifestSnapshot.content !== undefined) {
    parseManifest(JSON.parse(manifestSnapshot.content.toString('utf8')) as unknown);
    throw new ApplicationInspectionError('This boundary already has a supported manifest. Inspect its adoption record or use reviewed update/repair; adoption never overwrites initialized provenance.');
  }
  const configSnapshot = await captureProjectFileSnapshot(projectRoot, ['liftoff.config.json']);
  const proposalPath = options.proposal ? path.resolve(options.proposal) : null;
  let proposal: AdoptionProposal | null = null;
  let stage: ApplicationFiles | undefined;
  let proposalSnapshot: ProjectFileSnapshot | undefined;
  if (proposalPath) {
    await assertApplicationNoLinkAncestors(proposalPath);
    if (await realpath(proposalPath) !== proposalPath || applicationWithin(projectRoot, path.dirname(proposalPath)) ||
      applicationWithin(path.dirname(proposalPath), projectRoot)) {
      throw new ApplicationInspectionError('Adoption proposals and staged bytes must use exact disjoint external directories, not the real project or its ancestor.');
    }
    stage = new ApplicationFiles(path.dirname(proposalPath), (parts) => applicationExclusion(parts));
    proposalSnapshot = await stage.read([path.basename(proposalPath)], 64 * 1024);
    if (!proposalSnapshot.content) throw new ApplicationInspectionError('The exact adoption proposal is missing.');
    proposal = parseAdoptionProposal(proposalSnapshot.content);
    if (proposal.projectRoot !== projectRoot) throw new ApplicationInspectionError('Adoption proposal belongs to another project.');
  }
  const componentRootPathParts = proposal?.componentRootPathParts ?? rootParts(options.component);
  if (proposal && options.component !== undefined && canonicalSha256(rootParts(options.component)) !== canonicalSha256(componentRootPathParts)) {
    throw new ApplicationInspectionError('The requested component differs from the reviewed proposal boundary.');
  }
  const componentRoot = path.join(projectRoot, ...componentRootPathParts);
  if (await canonicalApplicationRoot(componentRoot) !== componentRoot) throw new ApplicationInspectionError('Adoption component boundary is aliased.');
  const selectedProfile = proposal?.profile ?? (options.profile ? profileAlias(options.profile) : undefined);
  if (proposal && options.profile && profileAlias(options.profile) !== proposal.profile) throw new ApplicationInspectionError('Requested profile differs from the exact proposal.');
  const sourceObservation = new ApplicationFiles(projectRoot, (parts) => applicationExclusion(parts));
  await sourceObservation.walk();
  await sourceObservation.assertUnchanged();
  const assessment = await assessProject({ targetPath: projectRoot, projectRoot, ...(componentRootPathParts.length ? { componentPath: applicationPathKey(componentRootPathParts) } : {}), ...(selectedProfile ? { profile: selectedProfile } : {}) });
  await sourceObservation.assertUnchanged();
  const profileId = selectedProfile ?? profileAlias(assessment.profile.id);
  const profile = Object.values(loadPackagedProfilesCatalog().profiles).find((profile) => profile.id === profileId);
  if (!profile?.capabilities.adoptionSupported) throw new ApplicationInspectionError('Selected source profile is unsupported for executable adoption. Use read-only liftoff assess; no framework conversion is inferred.');
  const component: ManifestComponent = { id: 'application', profile: getProfileIdentity(profile.id), rootPathParts: [...componentRootPathParts] };
  const standards: ManifestStandards = {
    schemaVersion: 1, catalogDigest: loadPackagedProfilesCatalog().digest,
    resourceCatalogDigest: loadPackagedTemplateCatalog().digest, components: [component]
  };
  const assessmentDigest = canonicalSha256({
    assessment: assessmentIdentity(assessment),
    observedSource: snapshotDescriptors([...sourceObservation.snapshots.values()]),
    observedDirectories: sourceObservation.directoryInventory,
    excludedSource: sourceObservation.exclusions,
    projectRoot, componentRootPathParts, standards
  });
  const projectName = proposal?.projectName ?? path.basename(projectRoot);
  const context: AdoptionInspectionContext = {
    schemaVersion: 1, kind: 'liftoff-adoption-inspection-context',
    projectName: path.basename(projectRoot), standards, assessmentDigest
  };
  const inventory = await inspectApplicationLayout(projectRoot, context);
  await sourceObservation.assertUnchanged();
  const blockers = [...inventory.report.blockers, ...verifyObservedProfile(component, inventory.snapshots)];
  if (assessment.exitCode === 1 || assessment.inventory.unobserved.length || assessment.inventory.limits.exceeded) {
    blockers.push('Current bounded assessment is incomplete or invalid; unobserved source cannot supply adoption preconditions.');
  }
  if (proposal && proposal.inspectionDigest !== inventory.report.inspectionDigest) throw new ApplicationInspectionError('Adoption proposal is stale: current files, directories, profiles or assessment differ.');
  const framework: AdoptionFrameworkSelection = proposal?.framework ?? {
    workflow: 'openspec', agents: [], initialize: false, copilotCloud: false
  };
  const governanceProfile = proposal?.governanceProfile ?? 'none';
  const frameworkPreparation = await inspectAdoptionFramework(framework, projectRoot, proposalPath ? path.dirname(proposalPath) : path.dirname(projectRoot), options);
  let patch: ApplicationPatchCandidate | undefined;
  if (proposal?.patch && proposalPath) {
    patch = await inspectAdoptionApplicationPatch(projectRoot, context, proposalPath, (bytes) => {
      const parsed = parseAdoptionProposal(bytes);
      if (!parsed.patch) throw new ApplicationInspectionError('The reviewed application-patch subplan disappeared.');
      return parsed.patch;
    }, options);
    blockers.push(...patch.blockers);
  }
  const verificationPolicy: ApplicationCandidate['verificationPolicy'] = {
    kind: 'isolated-application-checks', commands: proposal?.verification.commands ?? [],
    preparation: [], toolchain: [], executionCommands: [], outputRoles: [],
    effects: { projectCode: true, preparation: false, lifecycle: false, isolatedCopy: true, network: proposal?.verification.commands.some((command) => command.network) ?? false, securitySandbox: false }
  };
  const application: ApplicationCandidate = {
    blockers,
    snapshots: [...(patch?.snapshots ?? inventory.snapshots)],
    mutations: [...(patch?.mutations ?? [])],
    scope: {
      projectRoot, inspectionDigest: inventory.report.inspectionDigest, target: currentApplicationTargets(context).target,
      staging: { root: proposalPath ? path.dirname(proposalPath) : path.dirname(projectRoot) },
      directoryInventory: [...(patch?.scope.directoryInventory ?? inventory.report.directoryInventory)], preparation: [], toolchain: []
    },
    verificationPolicy,
    get networkRequired() { return verificationPolicy.effects.network; }
  };
  const additions = proposal?.additions ?? [];
  const source = new ApplicationFiles(projectRoot, (parts) => applicationExclusion(parts));
  const seenNames = new Set<string>(), seenPaths = new Set(application.mutations.map((mutation) => applicationPathFold(applicationPathKey(mutation.pathParts))));
  for (const addition of additions) {
    const key = applicationPathKey(addition.targetPathParts), folded = applicationPathFold(key);
    if (addition.componentId !== component.id || !inComponent(addition.targetPathParts, component) ||
      seenNames.has(addition.logicalName) || seenPaths.has(folded) || [...seenPaths].some((other) => other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`)) ||
      managedCoreArtifactPaths.has(addition.logicalName) || applicationExclusion(addition.targetPathParts)) {
      throw new ApplicationInspectionError('Adoption additions must have distinct explicit component identities and cannot overlap patches, metadata, framework, managed core, state or credentials.');
    }
    seenNames.add(addition.logicalName); seenPaths.add(folded);
    if (process.platform === 'win32' && addition.targetMode !== (addition.targetMode & 0o200 ? 0o666 : 0o444)) {
      throw new ApplicationInspectionError('Windows adoption additions must bind their effective native writable/read-only mode (666 or 444 octal).');
    }
    if (!stage || applicationPathKey(addition.stagedPathParts) === path.basename(proposalPath!)) throw new ApplicationInspectionError('An addition requires exact external staged bytes, separate from its proposal.');
    const replacement = await stage.read(addition.stagedPathParts);
    if (replacement.content === undefined) throw new ApplicationInspectionError('A declared staged addition is missing.');
    const destination = await source.read(addition.targetPathParts);
    if (addition.precondition === 'absent' ? destination.content !== undefined :
      destination.content === undefined || !destination.content.equals(replacement.content) || destination.mode !== addition.targetMode) {
      throw new ApplicationInspectionError(`${key}: addition destination does not meet the exact ${addition.precondition} precondition; custom bytes remain protected.`);
    }
    application.snapshots.push(destination);
    if (destination.content === undefined) application.mutations.push({ type: 'write', pathParts: [...addition.targetPathParts], content: replacement.content, mode: addition.targetMode });
  }
  application.snapshots = sortedSnapshots(application.snapshots);
  application.scope.directoryInventory = mergeDirectories(application.scope.directoryInventory, source.directoryInventory);
  assertApplicationCandidateBounds(application);
  const candidateFiles = applicationCandidateFiles(application);
  const references = inspectApplicationReferences(candidateFiles, application.scope.directoryInventory);
  if (patch) validateReferenceReview(patch.scope.mappings, inventory.report.references, references, candidateFiles, application.scope.directoryInventory);
  for (const addition of additions) {
    const outgoing = references.filter((reference) => applicationPathKey(reference.sourcePathParts) === applicationPathKey(addition.targetPathParts));
    if (outgoing.length !== addition.references.length || new Set(addition.references.map((reference) => reference.referenceId)).size !== outgoing.length) {
      throw new ApplicationInspectionError('Every observed outgoing addition reference needs its exact reviewed candidate target.');
    }
    for (const reference of outgoing) {
      const reviewed = addition.references.find((entry) => entry.referenceId === reference.id);
      if (!reviewed || canonicalSha256(reviewed.afterTargetPathParts) !== canonicalSha256(reference.targetPathParts) ||
        !candidateFiles.some((file) => file.content !== undefined && applicationPathKey(file.pathParts) === applicationPathKey(reference.targetPathParts)) &&
        !application.scope.directoryInventory.some((directory) => directory.exists && applicationPathKey(directory.pathParts) === applicationPathKey(reference.targetPathParts))) {
        throw new ApplicationInspectionError('An addition has an unreviewed or missing literal reference target.');
      }
    }
  }
  validateApplicationCommands(verificationPolicy.commands, candidateFiles, application.scope.directoryInventory);
  if (verificationPolicy.commands.length) await resolveApplicationPreparation(application, proposal?.verification.preparation ?? [], options, options.approvedTools, true);
  await source.assertUnchanged();
  await stage?.assertUnchanged();
  const rawInputs = [manifestSnapshot, configSnapshot];
  const directories = new ApplicationFiles(projectRoot);
  const rootIdentity = await lstat(projectRoot);
  const recordId = canonicalSha256({
    identity: adoptionExecutionIdentity(liftoffVersion), projectRoot, assessmentDigest, inspectionDigest: inventory.report.inspectionDigest,
    proposalDigest: proposalSnapshot?.content ? applicationDigest(proposalSnapshot.content) : null, standards, framework, governanceProfile,
    application: applicationCandidateDigest(application), frameworkBinding: frameworkPreparation?.binding ?? null,
    createdAt: now.toISOString()
  });
  const preparedFramework = frameworkPreparation
    ? await readPreparedAdoptionFramework(projectRoot, recordId, frameworkPreparation.binding, now.toISOString(), options.storage?.clock?.() ?? now, options.storage)
    : null;
  const projectArtifacts: ManifestProjectArtifact[] = inventory.snapshots.filter((file) => file.content !== undefined && inComponent(file.pathParts, component)).map((file) => {
    const mapped = patch?.scope.mappings.find((mapping) => applicationPathKey(mapping.sourcePathParts) === applicationPathKey(file.pathParts));
    const identicalAddition = additions.find((addition) => addition.precondition === 'identical' && applicationPathKey(addition.targetPathParts) === applicationPathKey(file.pathParts));
    return {
      logicalName: identicalAddition?.logicalName ?? `adopted-${canonicalSha256(file.pathParts).slice(0, 32)}`, category: 'application',
      pathParts: [...(mapped?.targetPathParts ?? file.pathParts)],
      adoption: { recordId, componentId: component.id, sourcePathParts: [...file.pathParts], observedHash: `sha256:${applicationDigest(file.content!)}`, observedMode: file.mode! }
    };
  });
  for (const addition of additions) if (!projectArtifacts.some((entry) => applicationPathKey(entry.pathParts) === applicationPathKey(addition.targetPathParts))) {
    const file = candidateFiles.find((file) => applicationPathKey(file.pathParts) === applicationPathKey(addition.targetPathParts))!;
    projectArtifacts.push({
      logicalName: addition.logicalName, category: 'application', pathParts: [...addition.targetPathParts],
      addition: { recordId, componentId: component.id, producer: 'reviewed-project-proposal', contentHash: `sha256:${applicationDigest(file.content!)}`, mode: addition.targetMode }
    });
  }
  const manifest: LiftoffManifestV8 = {
    artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion, standards,
    provenance: { kind: 'adopted', recordId, observationDigest: assessmentDigest, repairs: [] },
    project: { name: projectName, workload: { kind: 'components' }, specWorkflow: framework.workflow, agents: [...framework.agents], ...(framework.defaultAgent ? { defaultAgent: framework.defaultAgent } : {}) },
    framework: framework.initialize
      ? { state: 'initialized', adapter: framework.workflow, contractVersion: '' }
      : { state: 'uninitialized', adapter: framework.workflow },
    governance: { profile: 'none', state: 'disabled' }, managedArtifacts: [], projectArtifacts
  };
  const desiredState = JSON.parse(componentDesiredState(manifest)) as Record<string, unknown>;
  desiredState.governanceProfile = governanceProfile;
  const maintenancePlan = componentMaintenancePlan(manifest, desiredState);
  if (framework.initialize) manifest.framework.contractVersion = maintenancePlan.framework.version;
  const managed = buildComponentManagedArtifacts(maintenancePlan);
  if (governanceProfile !== 'none') {
    const { buildComponentMaintenanceManifest } = await import('../../project/component-artifacts.js');
    manifest.governance = buildComponentMaintenanceManifest(manifest, maintenancePlan, managed).governance;
  }
  manifest.managedArtifacts = managed.map((artifact) => ({
    logicalName: artifact.logicalName, category: artifact.category, pathParts: artifact.pathParts,
    contentHash: `sha256:${applicationDigest(artifact.content)}`
  }));
  const metadataArtifacts: Array<GeneratedArtifact & { mode?: number }> = [
    ...managed,
    ...(preparedFramework?.artifacts ?? []),
    { logicalName: 'liftoff-config', category: 'configuration', lifecycle: 'desired-state', pathParts: ['liftoff.config.json'], content: componentDesiredState(manifest) }
  ];
  const metadataPaths: string[] = [];
  const metadataNames = new Set<string>();
  for (const artifact of metadataArtifacts) {
    const key = applicationPathFold(applicationPathKey(artifact.pathParts));
    if (metadataNames.has(artifact.logicalName) || metadataPaths.some((previous) =>
      previous === key || previous.startsWith(`${key}/`) || key.startsWith(`${previous}/`))) {
      throw new ApplicationInspectionError('Deterministic adoption metadata/framework producers have conflicting exact output ownership.');
    }
    metadataNames.add(artifact.logicalName);
    metadataPaths.push(key);
  }
  const snapshots = [...application.snapshots, ...rawInputs];
  const mutations = [...application.mutations];
  const effects: AdoptionEffect[] = application.mutations.map((mutation) => {
    const before = application.snapshots.find((file) => applicationPathKey(file.pathParts) === applicationPathKey(mutation.pathParts))!;
    const addition = additions.find((addition) => applicationPathKey(addition.targetPathParts) === applicationPathKey(mutation.pathParts));
    return {
      producer: addition ? 'application-addition' : 'application-patch', logicalName: addition?.logicalName ?? `mapped-${canonicalSha256(mutation.pathParts).slice(0, 32)}`,
      type: mutation.type, pathParts: [...mutation.pathParts],
      before: { digest: before.content === undefined ? null : applicationDigest(before.content), mode: before.mode ?? null },
      after: { digest: mutation.type === 'write' ? applicationDigest(mutation.content) : null, mode: mutation.type === 'write' ? mutation.mode ?? before.mode ?? adoptionFileMode : null }
    };
  });
  for (const addition of additions.filter((addition) => addition.precondition === 'identical')) {
    const existing = application.snapshots.find((file) => applicationPathKey(file.pathParts) === applicationPathKey(addition.targetPathParts))!;
    const state = { digest: applicationDigest(existing.content!), mode: existing.mode! };
    effects.push({
      producer: 'application-addition', logicalName: addition.logicalName, type: 'adopt',
      pathParts: [...addition.targetPathParts], before: state, after: { ...state }
    });
  }
  for (const artifact of metadataArtifacts) {
    const before = await directories.read(artifact.pathParts);
    if (before.content !== undefined && (!before.content.equals(Buffer.from(artifact.content, 'utf8')) ||
      artifact.mode !== undefined && before.mode !== artifact.mode)) {
      throw new ApplicationInspectionError(`${artifact.pathParts.join('/')}: user/framework metadata collision. Adoption preserves unowned different bytes without force.`);
    }
    snapshots.push(before);
    if (before.content === undefined) mutations.push({ type: 'write', pathParts: [...artifact.pathParts], content: artifact.content, mode: artifact.mode ?? adoptionFileMode });
    effects.push({
      producer: artifact.lifecycle === 'managed-core' ? 'managed-integration' : artifact.lifecycle === 'framework' ? 'framework' : 'desired-state', logicalName: artifact.logicalName,
      type: before.content === undefined ? 'write' : 'adopt', pathParts: [...artifact.pathParts],
      before: { digest: before.content === undefined ? null : applicationDigest(before.content), mode: before.mode ?? null },
      after: { digest: applicationDigest(artifact.content), mode: before.mode ?? artifact.mode ?? adoptionFileMode }
    });
  }
  parseManifest(manifest);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  mutations.push({ type: 'write', pathParts: ['liftoff.manifest.json'], content: manifestBytes, mode: adoptionFileMode });
  effects.push({
    producer: 'manifest', logicalName: 'liftoff-manifest', type: 'write', pathParts: ['liftoff.manifest.json'],
    before: { digest: null, mode: null }, after: { digest: applicationDigest(manifestBytes), mode: adoptionFileMode }
  });
  const historySnapshot = await directories.read(adoptionHistoryPath(recordId));
  if (historySnapshot.content !== undefined) throw new ApplicationInspectionError('Adoption record identity is already present; immutable history cannot be rewritten.');
  snapshots.push(historySnapshot);
  await directories.assertUnchanged();
  const allDirectories = mergeDirectories(application.scope.directoryInventory, directories.directoryInventory);
  const sourceDirectories = await directoryIdentities(projectRoot, allDirectories);
  const reviewedDirectories: ReviewedAdoptionDirectorySnapshot[] = sourceDirectories.map((directory) =>
    directory.state === 'absent'
      ? { pathParts: [...directory.pathParts], state: 'absent' }
      : {
        pathParts: [...directory.pathParts], state: 'directory',
        device: directory.device, inode: directory.inode, mode: directory.mode
      });
  const captured = sortedSnapshots(snapshots);
  const body: Omit<AdoptionPlan, 'fingerprint'> = {
    schemaVersion: 1, kind: 'liftoff-adoption-plan', ...adoptionExecutionIdentity(liftoffVersion),
    projectRoot, projectIdentity: { device: String(rootIdentity.dev), inode: String(rootIdentity.ino), birthtime: String(rootIdentity.birthtimeMs) },
    projectName, standards, component, assessmentDigest, inspectionDigest: inventory.report.inspectionDigest,
    proposal: proposalPath && proposalSnapshot?.content ? { path: proposalPath, digest: applicationDigest(proposalSnapshot.content), mode: proposalSnapshot.mode! } : null,
    framework, governanceProfile,
    frameworkPreparation: {
      status: !frameworkPreparation ? 'not-required' : preparedFramework ? 'prepared' : 'required',
      binding: frameworkPreparation?.binding ?? null,
      files: preparedFramework?.artifacts.map((artifact) => ({ pathParts: artifact.pathParts, digest: applicationDigest(artifact.content), mode: artifact.mode })) ?? []
    },
    source: captured.map((file) => ({ pathParts: [...file.pathParts], digest: file.content === undefined ? null : applicationDigest(file.content), mode: file.mode ?? null })),
    directoryDigest: canonicalSha256({
      source: allDirectories, staging: stage?.directoryInventory ?? [],
      sourceIdentities: sourceDirectories,
      stagingIdentities: stage ? await directoryIdentities(stage.root, stage.directoryInventory) : [],
      patchStaging: patch?.scope.staging ?? null,
      stagedFiles: [...stage?.snapshots.values() ?? []].map((file) => ({
        pathParts: file.pathParts, digest: file.content === undefined ? null : applicationDigest(file.content), mode: file.mode ?? null
      }))
    }),
    targetDigest: canonicalSha256({ application: applicationCandidateDigest(application), patch: patch?.scope ?? null, manifest, effects }),
    verificationDigest: canonicalSha256(verificationPolicy), toolchainDigest: canonicalSha256(verificationPolicy.toolchain),
    effects, permissions: {
      projectCode: verificationPolicy.commands.length > 0, dependencyPreparation: verificationPolicy.effects.preparation,
      network: verificationPolicy.effects.network || framework.initialize && !preparedFramework,
      framework: framework.initialize && !preparedFramework, fileTransaction: !framework.initialize || preparedFramework !== null
    },
    recordId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + adoptionPreviewTtlMs).toISOString()
  };
  const result: AdoptionInspection = {
    projectRoot, assessment, inventory: inventory.report, context, plan: { ...body, fingerprint: canonicalSha256(body) },
    manifest, snapshots: captured, directories: reviewedDirectories, mutations, application, proposal, framework: frameworkPreparation, blockers,
    limitations: [
      applicationVerificationLimitation,
      'Assessment supported/complete classifications and recommendations are advisory, not adoption authority; actual captured source, component/profile facts and exact verified mappings are admitted independently.',
      'Adoption records actual component/profile observations, not historical generation or complete standards/business conformance.',
      'Liftoff does not initialize or copy Git metadata during adoption. Git, provider and other host effects of trusted code are outside the bounded file observation; repository controls, publication, Azure and installation work require separate authority.'
    ]
  };
  Object.defineProperties(result, {
    snapshots: { enumerable: false }, directories: { enumerable: false },
    mutations: { enumerable: false }, application: { enumerable: false }
  });
  return result;
}
