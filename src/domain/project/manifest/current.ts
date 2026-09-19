import type {
  LiftoffManifestV8, ManifestAdoptedProjectArtifact, ManifestComponent, ManifestFrameworkIdentity,
  ManifestHistoricalSource, ManifestProfileIdentity, ManifestProjectArtifact, ManifestProjectIdentity,
  ManifestProvenance, ManifestRepairProvenance, ManifestStandards
} from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { validateArtifactPathParts } from '../paths.js';
import { isManagedCoreLogicalName, isRetiredManagedCoreLogicalName, managedCoreArtifactPaths } from '../artifact-lifecycle.js';
import { canonicalSha256 } from '../../governance/activation/canonical-json.js';
import { repairRecipes } from '../../repair/identity.js';
import type { ManifestContractContext } from './context.js';
import { assertOnlyFields, isRecord, requiredString, SEMVER_PATTERN } from './fields.js';
import { historicalManifestVersions } from './identity.js';
import { createManifestArtifactReader } from './artifacts.js';
import { createManifestProjectReader } from './project-identity.js';
import { createManifestGovernanceReader } from './governance.js';

const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new FileSystemError(`${label} must be an object.`);
  assertOnlyFields(value, keys, label);
  return value;
}

function hash(value: unknown, label: string, prefixed = true): string {
  if (typeof value !== 'string' || !(prefixed ? hashPattern : digestPattern).test(value)) {
    throw new FileSystemError(`${label} must be a complete ${prefixed ? 'sha256-prefixed ' : ''}lowercase SHA-256 digest.`);
  }
  return value;
}

function semver(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value) ||
      value.split('+')[0]!.split('-').slice(1).join('-').split('.').some((part) => /^0\d+$/u.test(part))) {
    throw new FileSystemError(`${label} must be a valid semantic version.`);
  }
  return value;
}

export function manifestPortablePath(value: unknown, label: string, root = false): string[] {
  const parts = root && Array.isArray(value) && value.length === 0 ? [] : validateArtifactPathParts(value, label);
  if (parts.length > 32 || parts.some((part) => part !== part.normalize('NFKC') ||
    /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) || part.length > 255)) {
    throw new FileSystemError(`${label} contains a non-portable or normalization-ambiguous path.`);
  }
  return [...parts];
}

export const manifestPathKey = (parts: readonly string[]): string =>
  parts.map((part) => part.normalize('NFKC').toUpperCase().toLowerCase()).join('/');

function profileIdentity(value: unknown, label: string, context: ManifestContractContext): ManifestProfileIdentity {
  const item = record(value, ['schemaVersion', 'id', 'revision', 'digest'], label);
  if (item.schemaVersion !== 1) throw new FileSystemError(`${label}.schemaVersion must be 1.`);
  const id = requiredString(item, 'id', label), revision = requiredString(item, 'revision', label);
  const digest = hash(item.digest, `${label}.digest`);
  const registered = Object.values(context.currentStandards!().profiles.profiles).find((profile) => profile.id === id);
  if (!registered || registered.revision !== revision || registered.digest !== digest) {
    throw new FileSystemError(`${label} is not an exact installed supported profile identity; use a compatible CLI or a reviewed profile transition.`);
  }
  return { schemaVersion: 1, id, revision, digest };
}

export function normalizeManifestStandards(value: unknown, context: ManifestContractContext): ManifestStandards {
  if (!context.currentStandards) throw new FileSystemError('Manifest 8 requires the registered installed profile and resource catalogs.');
  const item = record(value, ['schemaVersion', 'catalogDigest', 'resourceCatalogDigest', 'components'], 'Manifest.standards');
  if (item.schemaVersion !== 1) throw new FileSystemError('Manifest.standards.schemaVersion must be 1.');
  const catalogDigest = hash(item.catalogDigest, 'Manifest.standards.catalogDigest');
  const resourceCatalogDigest = hash(item.resourceCatalogDigest, 'Manifest.standards.resourceCatalogDigest');
  const installed = context.currentStandards();
  if (catalogDigest !== installed.profiles.digest || resourceCatalogDigest !== installed.resourceCatalogDigest) {
    throw new FileSystemError('Manifest standards catalogs are not registered by this CLI; use a compatible CLI or a reviewed profile migration.');
  }
  if (!Array.isArray(item.components) || item.components.length === 0 || item.components.length > 32) {
    throw new FileSystemError('Manifest.standards.components must contain 1 through 32 explicit component boundaries.');
  }
  const ids = new Set<string>(), roots: string[] = [];
  const components = item.components.map((value, index): ManifestComponent => {
    const label = `Manifest.standards.components[${index}]`;
    const component = record(value, ['id', 'profile', 'rootPathParts'], label);
    const id = requiredString(component, 'id', label);
    if (!identifierPattern.test(id) || ids.has(id)) throw new FileSystemError(`${label}.id must be a unique portable component identity.`);
    ids.add(id);
    const rootPathParts = manifestPortablePath(component.rootPathParts, `${label}.rootPathParts`, true);
    const key = manifestPathKey(rootPathParts);
    if (roots.some((other) => !other || !key || other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`))) {
      throw new FileSystemError('Manifest component boundaries overlap or alias one another.');
    }
    roots.push(key);
    return { id, profile: profileIdentity(component.profile, `${label}.profile`, context), rootPathParts };
  });
  return { schemaVersion: 1, catalogDigest, resourceCatalogDigest, components };
}

function normalizeRepairs(value: unknown): ManifestRepairProvenance[] {
  if (!Array.isArray(value) || value.length > 1024) throw new FileSystemError('Manifest.provenance.repairs must be a bounded array.');
  const ids = new Set<string>();
  return value.map((value, index) => {
    const label = `Manifest.provenance.repairs[${index}]`;
    const item = record(value, ['recordId', 'recipe', 'recipeVersion', 'sourceManifestHash'], label);
    const recordId = hash(item.recordId, `${label}.recordId`, false);
    const recipe = Object.values(repairRecipes).find((recipe) => recipe.id === item.recipe && recipe.version === item.recipeVersion);
    if (ids.has(recordId) || !recipe) throw new FileSystemError(`${label} requires a unique registered repair identity.`);
    ids.add(recordId);
    return { recordId, recipe: recipe.id, recipeVersion: recipe.version, sourceManifestHash: hash(item.sourceManifestHash, `${label}.sourceManifestHash`) };
  });
}

function normalizeProvenance(value: unknown, context: ManifestContractContext): ManifestProvenance {
  if (!isRecord(value)) throw new FileSystemError('Manifest.provenance must be an object.');
  if (value.kind === 'adopted') {
    assertOnlyFields(value, ['kind', 'recordId', 'observationDigest', 'repairs'], 'Manifest.provenance');
    return {
      kind: 'adopted', recordId: hash(value.recordId, 'Manifest.provenance.recordId', false),
      observationDigest: hash(value.observationDigest, 'Manifest.provenance.observationDigest', false),
      repairs: normalizeRepairs(value.repairs)
    };
  }
  if (value.kind !== 'generated') throw new FileSystemError('Manifest.provenance.kind must be generated or adopted.');
  assertOnlyFields(value, ['kind', 'origin', 'repairs'], 'Manifest.provenance');
  if (!isRecord(value.origin)) throw new FileSystemError('Manifest.provenance.origin must identify actual generation or a preserved historical manifest.');
  if (value.origin.kind === 'catalog') {
    const origin = record(value.origin, ['kind', 'cliVersion', 'standards'], 'Manifest.provenance.origin');
    return {
      kind: 'generated',
      origin: { kind: 'catalog', cliVersion: semver(origin.cliVersion, 'Manifest.provenance.origin.cliVersion'), standards: normalizeManifestStandards(origin.standards, context) },
      repairs: normalizeRepairs(value.repairs)
    };
  }
  const origin = record(value.origin, [
    'kind', 'artifactVersion', 'writerVersion', 'contentHash', 'historyPathParts', 'originalProfile'
  ], 'Manifest.provenance.origin');
  const version = historicalManifestVersions.find((version) => version === origin.artifactVersion);
  const contentHash = hash(origin.contentHash, 'Manifest.provenance.origin.contentHash');
  const historyPathParts = manifestPortablePath(origin.historyPathParts, 'Manifest.provenance.origin.historyPathParts');
  if (origin.kind !== 'historical-manifest' || !version || origin.originalProfile !== 'unknown' ||
    historyPathParts.join('/') !== `.liftoff/manifest-history/${contentHash.slice(7)}/manifest.json`) {
    throw new FileSystemError('Manifest historical origin must retain an exact supported source and immutable history identity, with unknown original profile facts.');
  }
  const historical: ManifestHistoricalSource = {
    kind: 'historical-manifest', artifactVersion: version,
    writerVersion: semver(origin.writerVersion, 'Manifest.provenance.origin.writerVersion'),
    contentHash, historyPathParts, originalProfile: 'unknown'
  };
  return { kind: 'generated', origin: historical, repairs: normalizeRepairs(value.repairs) };
}

export function createCurrentManifestReader(context: ManifestContractContext) {
  const historical = createManifestProjectReader(context.catalog);
  const artifacts = createManifestArtifactReader(context.catalog);
  const governance = createManifestGovernanceReader(context);
  return function parseCurrentManifest(raw: Record<string, unknown>): LiftoffManifestV8 {
    assertOnlyFields(raw, [
      'artifactVersion', 'generatedBy', 'liftoffVersion', 'project', 'framework', 'governance',
      'managedArtifacts', 'projectArtifacts', 'standards', 'provenance'
    ], 'Manifest');
    if (raw.artifactVersion !== 8 || raw.generatedBy !== 'Mission Control Liftoff') {
      throw new FileSystemError('Current manifests require artifactVersion 8 and the exact Liftoff writer identity.');
    }
    const liftoffVersion = semver(raw.liftoffVersion, 'Manifest.liftoffVersion');
    const standards = normalizeManifestStandards(raw.standards, context);
    const provenance = normalizeProvenance(raw.provenance, context);
    const projectRaw = record(raw.project, ['name', 'workload', 'specWorkflow', 'agents', 'defaultAgent'], 'Manifest.project');
    let project: ManifestProjectIdentity;
    if (isRecord(projectRaw.workload) && projectRaw.workload.kind === 'components') {
      record(projectRaw.workload, ['kind'], 'Manifest.project.workload');
      if (provenance.kind !== 'adopted') throw new FileSystemError('Component-only identity requires actual adopted provenance, not generated workload history.');
      const name = requiredString(projectRaw, 'name', 'Manifest.project');
      const workflow = context.catalog.getSpecWorkflow(requiredString(projectRaw, 'specWorkflow', 'Manifest.project'));
      if (!workflow || workflow.id !== projectRaw.specWorkflow) throw new FileSystemError('Manifest.project.specWorkflow is invalid.');
      if (!Array.isArray(projectRaw.agents) || projectRaw.agents.some((agent) => typeof agent !== 'string')) {
        throw new FileSystemError('Manifest.project.agents must be a canonical array of registered agents.');
      }
      const agents = context.catalog.canonicalizeCodingAgents(projectRaw.agents).agents.map((agent) => agent.id);
      if (canonicalSha256(agents) !== canonicalSha256(projectRaw.agents)) throw new FileSystemError('Manifest.project.agents must be unique canonical registered identities.');
      const defaultAgent = projectRaw.defaultAgent === undefined ? undefined : context.catalog.getCodingAgent(String(projectRaw.defaultAgent));
      if (projectRaw.defaultAgent !== undefined && (!defaultAgent || defaultAgent.id !== projectRaw.defaultAgent)) {
        throw new FileSystemError('Manifest.project.defaultAgent must be a registered identity.');
      }
      project = { name, workload: { kind: 'components' }, specWorkflow: workflow.id, agents, ...(defaultAgent ? { defaultAgent: defaultAgent.id } : {}) };
    } else {
      const generatedProject = historical.normalizeManifestProject(projectRaw, 7);
      project = generatedProject;
      const expected = generatedProject.workload.kind === 'genai' ? `genai-${generatedProject.workload.pattern}` : generatedProject.workload.apiStack;
      const backend = standards.components.filter((component) => component.profile.id !== 'vue-component');
      const frontends = standards.components.filter((component) => component.profile.id === 'vue-component');
      if (backend.length !== 1 || backend[0]!.profile.id !== expected || frontends.length !== Number(generatedProject.workload.frontend)) {
        throw new FileSystemError('Manifest workload and selected profile components disagree.');
      }
      if (provenance.kind === 'generated' && provenance.origin.kind === 'catalog' &&
        (backend[0]!.rootPathParts.join('/') !== 'backend' || frontends.some((component) => component.rootPathParts.join('/') !== 'frontend'))) {
        throw new FileSystemError('New generation must record its actual registered backend and frontend component boundaries.');
      }
    }
    let framework: ManifestFrameworkIdentity;
    if (isRecord(raw.framework) && raw.framework.state === 'uninitialized') {
      record(raw.framework, ['state', 'adapter'], 'Manifest.framework');
      if (provenance.kind !== 'adopted' || raw.framework.adapter !== project.specWorkflow || project.agents.length || project.defaultAgent) {
        throw new FileSystemError('Uninitialized framework state is adoption-only and cannot claim configured agents, a default, or a framework contract.');
      }
      framework = { state: 'uninitialized', adapter: project.specWorkflow };
    } else {
      framework = historical.normalizeManifestFramework(raw.framework, 7, project);
      if (framework.state === 'legacy' && (provenance.kind !== 'generated' || provenance.origin.kind !== 'historical-manifest')) {
        throw new FileSystemError('Legacy framework uncertainty requires preserved historical provenance.');
      }
    }
    const managedArtifacts = artifacts.normalizeManifestManagedArtifacts(raw.managedArtifacts, 'Manifest.managedArtifacts');
    if (!Array.isArray(raw.projectArtifacts)) throw new FileSystemError('Manifest.projectArtifacts must be an array.');
    const projectArtifacts: ManifestProjectArtifact[] = raw.projectArtifacts.map((value, index) => {
      if (isRecord(value) && Object.hasOwn(value, 'addition')) {
        const label = `Manifest.projectArtifacts[${index}]`;
        const item = record(value, ['logicalName', 'category', 'pathParts', 'addition'], label);
        const addition = record(item.addition, ['recordId', 'componentId', 'producer', 'contentHash', 'mode'], `${label}.addition`);
        const recordId = hash(addition.recordId, `${label}.addition.recordId`, false);
        const componentId = requiredString(addition, 'componentId', `${label}.addition`);
        const component = standards.components.find((component) => component.id === componentId);
        const pathParts = manifestPortablePath(item.pathParts, `${label}.pathParts`);
        if (provenance.kind !== 'adopted' || provenance.recordId !== recordId || !component ||
          addition.producer !== 'reviewed-project-proposal' || typeof addition.mode !== 'number' ||
          !Number.isInteger(addition.mode) || addition.mode < 0 || addition.mode > 0o777 ||
          component.rootPathParts.length && !pathParts.join('/').startsWith(`${component.rootPathParts.join('/')}/`)) {
          throw new FileSystemError(`${label} requires actual reviewed addition provenance and an exact component boundary.`);
        }
        const logicalName = requiredString(item, 'logicalName', label);
        if (!identifierPattern.test(logicalName)) throw new FileSystemError(`${label}.logicalName must identify an exact approved addition.`);
        return {
          logicalName, category: requiredString(item, 'category', label), pathParts,
          addition: { recordId, componentId, producer: 'reviewed-project-proposal', contentHash: hash(addition.contentHash, `${label}.addition.contentHash`), mode: addition.mode }
        };
      }
      if (!isRecord(value) || !Object.hasOwn(value, 'adoption')) {
        return artifacts.normalizeManifestProjectArtifacts([value])[0]!;
      }
      const label = `Manifest.projectArtifacts[${index}]`;
      const item = record(value, ['logicalName', 'category', 'pathParts', 'adoption'], label);
      const adopted = record(item.adoption, ['recordId', 'componentId', 'sourcePathParts', 'observedHash', 'observedMode'], `${label}.adoption`);
      const logicalName = requiredString(item, 'logicalName', label), category = requiredString(item, 'category', label);
      const pathParts = manifestPortablePath(item.pathParts, `${label}.pathParts`);
      const sourcePathParts = manifestPortablePath(adopted.sourcePathParts, `${label}.adoption.sourcePathParts`);
      const recordId = hash(adopted.recordId, `${label}.adoption.recordId`, false);
      const componentId = requiredString(adopted, 'componentId', `${label}.adoption`);
      const component = standards.components.find((component) => component.id === componentId);
      if (provenance.kind !== 'adopted' || provenance.recordId !== recordId || !component ||
        !identifierPattern.test(logicalName) || !Number.isInteger(adopted.observedMode) ||
        typeof adopted.observedMode !== 'number' || adopted.observedMode < 0 || adopted.observedMode > 0o777) {
        throw new FileSystemError(`${label} requires exact adopted file, component, record and ordinary-mode provenance without generation claims.`);
      }
      if (component.rootPathParts.length && !pathParts.join('/').startsWith(`${component.rootPathParts.join('/')}/`)) {
        throw new FileSystemError(`${label} lies outside its actual component boundary.`);
      }
      const artifact: ManifestAdoptedProjectArtifact = {
        logicalName, category, pathParts,
        adoption: { recordId, componentId, sourcePathParts, observedHash: hash(adopted.observedHash, `${label}.adoption.observedHash`), observedMode: adopted.observedMode }
      };
      return artifact;
    });
    artifacts.validateV6AndV7ArtifactAuthority(managedArtifacts, projectArtifacts);
    artifacts.validateManifestArtifactUniqueness(managedArtifacts, projectArtifacts);
    const paths: string[] = [];
    for (const artifact of [...managedArtifacts, ...projectArtifacts]) {
      manifestPortablePath(artifact.pathParts, `Manifest artifact ${artifact.logicalName}`);
      const key = manifestPathKey(artifact.pathParts);
      if (paths.some((other) => key === other || key.startsWith(`${other}/`) || other.startsWith(`${key}/`))) {
        throw new FileSystemError('Manifest artifact destinations collide, overlap, or have case/normalization aliases.');
      }
      paths.push(key);
      if (isManagedCoreLogicalName(artifact.logicalName) &&
        (artifact.category !== 'governance' || managedCoreArtifactPaths.get(artifact.logicalName)?.join('/') !== artifact.pathParts.join('/'))) {
        throw new FileSystemError(`Managed artifact ${artifact.logicalName} has invalid identity: expected its exact registered category and destination.`);
      }
      if (isRetiredManagedCoreLogicalName(artifact.logicalName) &&
        (provenance.kind !== 'generated' || provenance.origin.kind !== 'historical-manifest')) {
        throw new FileSystemError('Retired managed aliases are historical migration debt, never new generation or adoption output.');
      }
    }
    const manifest: LiftoffManifestV8 = {
      artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion,
      project, framework, governance: governance.normalizeManifestGovernance(raw.governance, 8),
      managedArtifacts, projectArtifacts, standards, provenance
    };
    const originalNativeIdentity = manifest.governance.profile !== 'none' && manifest.governance.profile !== 'unspecified' &&
      manifest.governance.activationIdentity?.manifestArtifactVersion === 8;
    if (manifest.governance.profile === 'unspecified' ||
      manifest.governance.profile !== 'none' && manifest.governance.policyVersion !== context.policyVersion &&
        !originalNativeIdentity &&
        (provenance.kind !== 'generated' || provenance.origin.kind !== 'historical-manifest')) {
      throw new FileSystemError('Historical governance identity in manifest 8 requires its preserved source provenance and cannot authorize current execution.');
    }
    governance.validateGovernanceArtifactIdentity(manifest);
    return manifest;
  };
}
