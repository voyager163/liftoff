import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  getApiStack,
  canonicalizeCodingAgents,
  getEnvironment,
  getGovernanceProfile,
  getCodingAgent,
  getPattern,
  getProvider,
  getProjectType,
  getSpecWorkflow,
  listRegions
} from './catalogs.js';
import type {
  GeneratedArtifact,
  LiftoffManifest,
  ManifestManagedArtifact,
  ManifestProjectArtifact,
  ProjectProvisioningGroup
} from './types.js';
import { validateFrameworkInstallation } from './framework-validation.js';
import {
  isManagedCoreLogicalName,
  isRetiredManagedCoreArtifactIdentity,
  isRetiredManagedCoreLogicalName,
  isUnknownRetiredManagedCoreAliasLogicalName,
  managedCoreLogicalNames,
  legacyProvisioningGroup
} from './artifact-lifecycle.js';
import {
  governanceArtifactPaths,
  governancePolicyVersion
} from './repository-governance.js';
import {
  currentActivationIdentity
} from './governance-activation/graph.js';
import {
  validateActivationIdentity
} from './governance-activation/validators.js';
import {
  validateGovernanceCompatibilityMetadata,
  type ManagedCompatibilityInventoryEntry
} from './governance-activation/compatibility.js';

export class FileSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileSystemError';
  }
}

export type ProjectFileMutation =
  | { type: 'write'; pathParts: string[]; content: string }
  | { type: 'delete'; pathParts: string[] };

export class ProjectFileTransactionError extends FileSystemError {
  constructor(
    message: string,
    public readonly rollbackFailures: readonly string[]
  ) {
    super(message);
    this.name = 'ProjectFileTransactionError';
  }
}

export function resolveTargetRoot(cwd: string, projectName: string): string {
  return path.resolve(cwd, projectName);
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateArtifactPathParts(value: unknown, label = 'Artifact path'): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FileSystemError(`${label} must be a non-empty path-part array.`);
  }

  return value.map((part, index) => {
    if (typeof part !== 'string' || part.length === 0 || part.trim().length === 0) {
      throw new FileSystemError(`${label} part ${index + 1} must be a non-empty string.`);
    }
    if (
      part === '.' ||
      part === '..' ||
      part.includes('/') ||
      part.includes('\\') ||
      part.includes('\0') ||
      path.posix.isAbsolute(part) ||
      path.win32.isAbsolute(part) ||
      WINDOWS_DRIVE_PATTERN.test(part)
    ) {
      throw new FileSystemError(`${label} contains unsafe path part ${JSON.stringify(part)}.`);
    }
    if (part.endsWith('.') || part.endsWith(' ') || WINDOWS_RESERVED_NAME_PATTERN.test(part)) {
      throw new FileSystemError(`${label} contains non-portable path part ${JSON.stringify(part)}.`);
    }
    return part;
  });
}

export function artifactPath(root: string, pathParts: string[]): string {
  const validated = validateArtifactPathParts(pathParts);
  const joinedPath = path.join(root, ...validated);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(joinedPath);
  if (!isPathWithin(resolvedRoot, resolvedPath) || resolvedPath === resolvedRoot) {
    throw new FileSystemError(`Artifact path escapes project root: ${validated.join('/')}`);
  }
  return joinedPath;
}

export async function resolveProjectPath(projectRoot: string, pathParts: string[]): Promise<string> {
  const validated = validateArtifactPathParts(pathParts);
  const resolvedRoot = path.resolve(projectRoot);
  const targetPath = artifactPath(resolvedRoot, validated);

  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch (error) {
    throw new FileSystemError(`Unable to resolve project root ${resolvedRoot}: ${errorMessage(error)}`);
  }

  let current = resolvedRoot;
  for (const [index, part] of validated.entries()) {
    current = path.join(current, part);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return targetPath;
      }
      throw new FileSystemError(`Unable to inspect artifact path ${validated.join('/')}: ${errorMessage(error)}`);
    }

    let resolvedExistingPath: string;
    try {
      resolvedExistingPath = await realpath(current);
    } catch (error) {
      throw new FileSystemError(`Unable to resolve artifact path ${validated.join('/')}: ${errorMessage(error)}`);
    }
    if (!isPathWithin(realRoot, resolvedExistingPath)) {
      throw new FileSystemError(`Artifact path escapes project root through a symlink: ${validated.join('/')}`);
    }
    if (index < validated.length - 1 && !details.isDirectory() && !details.isSymbolicLink()) {
      throw new FileSystemError(`Artifact path parent is not a directory: ${validated.slice(0, index + 1).join('/')}`);
    }
  }

  return targetPath;
}

export async function assertNewOrEmptyDirectory(targetRoot: string): Promise<void> {
  try {
    const details = await stat(targetRoot);
    if (!details.isDirectory()) {
      throw new FileSystemError(`Target path exists and is not a directory: ${targetRoot}`);
    }
    const entries = await readdir(targetRoot);
    if (entries.length > 0) {
      throw new FileSystemError(`Target directory must be new or empty: ${targetRoot}`);
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function writeArtifacts(targetRoot: string, artifacts: GeneratedArtifact[]): Promise<void> {
  await assertNewOrEmptyDirectory(targetRoot);
  await mkdir(targetRoot, { recursive: true });

  for (const artifact of artifacts) {
    await writeProjectFile(targetRoot, artifact.pathParts, artifact.content);
  }
}

export const SUPPORTED_MANIFEST_VERSIONS: readonly number[] = [2, 3, 4, 5, 6, 7];

// seed entries recorded by 0.2.0 manifests; dropped on read so archiving the
// seeded change is a non-event for validate, update, and doctor
const LEGACY_SEED_LOGICAL_NAMES = new Set([
  'openspec-config',
  'openspec-seed-change-metadata',
  'openspec-seed-proposal',
  'openspec-seed-design',
  'openspec-seed-tasks',
  'openspec-seed-spec',
  'openspec-spec-placeholder',
  'spec-kit-constitution',
  'specs-placeholder'
]);
const LEGACY_NON_PROVENANCE_LOGICAL_NAMES = new Set([
  ...LEGACY_SEED_LOGICAL_NAMES,
  'liftoff-config',
  'spec-kit-spec-template',
  'spec-kit-plan-template'
]);
const manifestsWithFilteredLegacySeedOwnership = new WeakSet<LiftoffManifest>();

export function manifestHadFilteredLegacyNonDurableOwnership(
  manifest: LiftoffManifest
): boolean {
  return manifestsWithFilteredLegacySeedOwnership.has(manifest);
}

export async function loadManifest(projectRoot: string): Promise<LiftoffManifest> {
  let raw: unknown;
  try {
    const manifestBytes = await readProjectFile(projectRoot, ['liftoff.manifest.json']);
    if (manifestBytes === undefined) {
      throw new Error('file does not exist');
    }
    raw = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new FileSystemError(`Unable to read liftoff.manifest.json: ${errorMessage(error)}`);
  }

  return parseManifest(raw);
}

export function parseManifest(raw: unknown): LiftoffManifest {
  if (!isRecord(raw)) {
    throw new FileSystemError('Manifest root must be a JSON object.');
  }

  const artifactVersion = raw.artifactVersion;
  if (typeof artifactVersion !== 'number' || !Number.isInteger(artifactVersion)) {
    throw new FileSystemError('Manifest artifactVersion must be an integer.');
  }
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(artifactVersion)) {
    throw new FileSystemError(
      `Unsupported manifest artifactVersion ${JSON.stringify(artifactVersion)}: found ${JSON.stringify(artifactVersion)}; ` +
        `supported values are ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}; write version is 7. ` +
        `Minimum Liftoff ${currentActivationIdentity.liftoffVersion} is required for manifest v7. ` +
        'Regenerate the project with this CLI, upgrade the CLI for future manifests, or use the Liftoff version that generated this project; no downgrade or write was performed.'
    );
  }
  if (artifactVersion === 6 || artifactVersion === 7) {
    assertOnlyFields(
      raw,
      [
        'artifactVersion',
        'generatedBy',
        'liftoffVersion',
        'project',
        'framework',
        'governance',
        'managedArtifacts',
        'projectArtifacts'
      ],
      'Manifest'
    );
  } else if (artifactVersion === 5) {
    assertOnlyFields(
      raw,
      [
        'artifactVersion',
        'generatedBy',
        'liftoffVersion',
        'project',
        'framework',
        'governance',
        'artifacts'
      ],
      'Manifest'
    );
  }

  if (raw.generatedBy !== 'Mission Control Liftoff') {
    throw new FileSystemError('Manifest generatedBy must be "Mission Control Liftoff".');
  }
  const liftoffVersion = requiredString(raw, 'liftoffVersion', 'Manifest');
  if (!SEMVER_PATTERN.test(liftoffVersion)) {
    throw new FileSystemError('Manifest liftoffVersion must be a valid semantic version.');
  }

  const project = normalizeManifestProject(raw.project, artifactVersion);
  const framework = normalizeManifestFramework(raw.framework, artifactVersion, project);
  const governance = normalizeManifestGovernance(raw.governance, artifactVersion);
  let managedArtifacts: ManifestManagedArtifact[];
  let projectArtifacts: ManifestProjectArtifact[];
  let filteredLegacySeedOwnership = false;
  if (artifactVersion === 6 || artifactVersion === 7) {
    managedArtifacts = normalizeManifestManagedArtifacts(
      raw.managedArtifacts,
      'Manifest.managedArtifacts'
    );
    projectArtifacts = normalizeManifestProjectArtifacts(raw.projectArtifacts);
    validateV6AndV7ArtifactAuthority(managedArtifacts, projectArtifacts);
  } else {
    const normalizedArtifacts = normalizeManifestManagedArtifacts(
      raw.artifacts,
      'Manifest.artifacts'
    );
    const artifacts = normalizedArtifacts.filter(
      (artifact) => !LEGACY_NON_PROVENANCE_LOGICAL_NAMES.has(artifact.logicalName)
    );
    for (const artifact of artifacts) {
      if (isUnknownRetiredManagedCoreAliasLogicalName(artifact.logicalName)) {
        throw new FileSystemError(
          `Manifest artifact ${artifact.logicalName} is an unknown retired managed-core alias logical name.`
        );
      }
    }
    filteredLegacySeedOwnership = artifacts.length !== normalizedArtifacts.length;
    managedArtifacts = artifacts.filter((artifact) =>
      isManagedCoreLogicalName(artifact.logicalName) ||
      isRetiredManagedCoreLogicalName(artifact.logicalName)
    );
    projectArtifacts = artifacts
      .filter((artifact) =>
        !isManagedCoreLogicalName(artifact.logicalName) &&
        !isRetiredManagedCoreLogicalName(artifact.logicalName)
      )
      .map((artifact) => ({
        logicalName: artifact.logicalName,
        category: artifact.category,
        pathParts: artifact.pathParts,
        generatedBy: liftoffVersion,
        generationHash: artifact.contentHash,
        provisioningGroup: project.workload.kind === 'power-apps-code-app'
          ? 'power-apps-starter'
          : legacyProvisioningGroup(artifact.logicalName)
      }));
  }
  validateManifestArtifactUniqueness(managedArtifacts, projectArtifacts);
  const manifest: LiftoffManifest = {
    artifactVersion: artifactVersion as 2 | 3 | 4 | 5 | 6 | 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project,
    framework,
    governance,
    managedArtifacts,
    projectArtifacts
  };
  validateGovernanceArtifactIdentity(manifest);
  if (filteredLegacySeedOwnership) {
    manifestsWithFilteredLegacySeedOwnership.add(manifest);
  }
  return manifest;
}

function requiredString(record: Record<string, unknown>, key: string, scope: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FileSystemError(`${scope}.${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, scope: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FileSystemError(`${scope}.${key} must be a non-empty string when present.`);
  }
  return value;
}

export function normalizeManifestProject(project: unknown, artifactVersion: number): LiftoffManifest['project'] {
  if (!isRecord(project)) {
    throw new FileSystemError('Manifest.project must be a JSON object.');
  }
  if (artifactVersion >= 4) {
    return normalizeV4ManifestProject(project);
  }

  const name = requiredString(project, 'name', 'Manifest.project');
  const patternValue = optionalString(project, 'pattern', 'Manifest.project');
  const projectTypeValue = optionalString(project, 'projectType', 'Manifest.project');
  const projectType = getProjectType(projectTypeValue ?? (patternValue ? 'genai' : ''));
  if (!projectType || projectTypeValue !== undefined && projectType.id !== projectTypeValue) {
    throw new FileSystemError('Manifest project identity is missing a valid projectType.');
  }

  const apiStackValue = optionalString(project, 'apiStack', 'Manifest.project');
  const apiStack = getApiStack(apiStackValue ?? (projectType.id === 'genai' ? 'python-fastapi' : ''));
  if (!apiStack || apiStackValue !== undefined && apiStack.id !== apiStackValue) {
    throw new FileSystemError(`Manifest project type ${projectType.id} is missing a valid apiStack.`);
  }

  const pattern = patternValue ? getPattern(patternValue) : undefined;
  if (patternValue && (!pattern || pattern.id !== patternValue)) {
    throw new FileSystemError(`Manifest project pattern ${JSON.stringify(patternValue)} is invalid.`);
  }
  if (projectType.id === 'genai' && (!pattern || apiStack.id !== 'python-fastapi')) {
    throw new FileSystemError('GenAI manifests require a valid pattern and the python-fastapi API stack.');
  }
  if (projectType.id === 'standard' && pattern) {
    throw new FileSystemError('Standard manifests cannot record a GenAI pattern.');
  }

  const cloudValue = requiredString(project, 'cloud', 'Manifest.project');
  const provider = getProvider(cloudValue);
  if (!provider || provider.id !== cloudValue || provider.status !== 'available') {
    throw new FileSystemError(`Manifest project cloud ${JSON.stringify(cloudValue)} is invalid or unavailable.`);
  }
  const regionValue = requiredString(project, 'region', 'Manifest.project');
  if (!listRegions(provider.id).some((region) => region.slug === regionValue)) {
    throw new FileSystemError(`Manifest project region ${JSON.stringify(regionValue)} is invalid for ${provider.id}.`);
  }

  const frontend = project.frontend;
  if (typeof frontend !== 'boolean') {
    throw new FileSystemError('Manifest.project.frontend must be a boolean.');
  }

  const specWorkflowValue = requiredString(project, 'specWorkflow', 'Manifest.project');
  const specWorkflow = getSpecWorkflow(specWorkflowValue);
  if (!specWorkflow || specWorkflow.id !== specWorkflowValue) {
    throw new FileSystemError(`Manifest project specWorkflow ${JSON.stringify(specWorkflowValue)} is invalid.`);
  }

  let agents: LiftoffManifest['project']['agents'] = [];
  let defaultAgent: LiftoffManifest['project']['defaultAgent'];
  if (artifactVersion >= 3) {
    if (!Array.isArray(project.agents)) {
      throw new FileSystemError('Manifest.project.agents must be an array.');
    }
    const rawAgents = project.agents.map((value, index) => {
      if (typeof value !== 'string') {
        throw new FileSystemError(`Manifest.project.agents[${index}] must be a string.`);
      }
      const agent = getCodingAgent(value);
      if (!agent || agent.id !== value) {
        throw new FileSystemError(`Manifest project agent ${JSON.stringify(value)} is invalid.`);
      }
      return agent.id;
    });
    const canonical = canonicalizeCodingAgents(rawAgents).agents.map((agent) => agent.id);
    if (canonical.length !== rawAgents.length || canonical.some((agent, index) => agent !== rawAgents[index])) {
      throw new FileSystemError('Manifest.project.agents must be unique and in canonical order.');
    }
    agents = canonical;

    const defaultAgentValue = optionalString(project, 'defaultAgent', 'Manifest.project');
    if (defaultAgentValue) {
      const resolved = getCodingAgent(defaultAgentValue);
      if (!resolved || resolved.id !== defaultAgentValue) {
        throw new FileSystemError(`Manifest project defaultAgent ${JSON.stringify(defaultAgentValue)} is invalid.`);
      }
      defaultAgent = resolved.id;
    }
  }

  if (!Array.isArray(project.environments) || project.environments.length === 0) {
    throw new FileSystemError('Manifest.project.environments must be a non-empty string array.');
  }
  const environments = project.environments.map((value, index) => {
    if (typeof value !== 'string') {
      throw new FileSystemError(`Manifest.project.environments[${index}] must be a string.`);
    }
    const environment = getEnvironment(value);
    if (!environment || environment.id !== value) {
      throw new FileSystemError(`Manifest project environment ${JSON.stringify(value)} is invalid.`);
    }
    return environment.id;
  });
  if (new Set(environments).size !== environments.length) {
    throw new FileSystemError('Manifest.project.environments must not contain duplicates.');
  }

  return {
    name,
    workload: projectType.id === 'genai'
      ? {
          kind: 'genai',
          apiStack: apiStack.id,
          pattern: pattern!.id,
          cloud: provider.id,
          region: regionValue,
          frontend,
          environments
        }
      : {
          kind: 'standard',
          apiStack: apiStack.id,
          cloud: provider.id,
          region: regionValue,
          frontend,
          environments
        },
    specWorkflow: specWorkflow.id,
    agents,
    ...(defaultAgent ? { defaultAgent } : {})
  };
}

function assertOnlyFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  scope: string
): void {
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw new FileSystemError(
      `${scope} contains inapplicable or unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`
    );
  }
}

function requiredBoolean(record: Record<string, unknown>, key: string, scope: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new FileSystemError(`${scope}.${key} must be a boolean.`);
  }
  return value;
}

function normalizeV4ManifestProject(project: Record<string, unknown>): LiftoffManifest['project'] {
  assertOnlyFields(
    project,
    ['name', 'workload', 'specWorkflow', 'agents', 'defaultAgent'],
    'Manifest.project'
  );
  const name = requiredString(project, 'name', 'Manifest.project');
  if (!isRecord(project.workload)) {
    throw new FileSystemError('Manifest.project.workload must be a JSON object.');
  }
  const workload = normalizeV4ManifestWorkload(project.workload);
  const specWorkflowValue = requiredString(project, 'specWorkflow', 'Manifest.project');
  const specWorkflow = getSpecWorkflow(specWorkflowValue);
  if (!specWorkflow || specWorkflow.id !== specWorkflowValue) {
    throw new FileSystemError(`Manifest project specWorkflow ${JSON.stringify(specWorkflowValue)} is invalid.`);
  }
  if (!Array.isArray(project.agents)) {
    throw new FileSystemError('Manifest.project.agents must be an array.');
  }
  const rawAgents = project.agents.map((value, index) => {
    if (typeof value !== 'string') {
      throw new FileSystemError(`Manifest.project.agents[${index}] must be a string.`);
    }
    const agent = getCodingAgent(value);
    if (!agent || agent.id !== value) {
      throw new FileSystemError(`Manifest project agent ${JSON.stringify(value)} is invalid.`);
    }
    return agent.id;
  });
  const agents = canonicalizeCodingAgents(rawAgents).agents.map((agent) => agent.id);
  if (agents.length !== rawAgents.length || agents.some((agent, index) => agent !== rawAgents[index])) {
    throw new FileSystemError('Manifest.project.agents must be unique and in canonical order.');
  }
  const defaultAgentValue = optionalString(project, 'defaultAgent', 'Manifest.project');
  let defaultAgent: LiftoffManifest['project']['defaultAgent'];
  if (defaultAgentValue) {
    const resolved = getCodingAgent(defaultAgentValue);
    if (!resolved || resolved.id !== defaultAgentValue) {
      throw new FileSystemError(`Manifest project defaultAgent ${JSON.stringify(defaultAgentValue)} is invalid.`);
    }
    defaultAgent = resolved.id;
  }
  return {
    name,
    workload,
    specWorkflow: specWorkflow.id,
    agents,
    ...(defaultAgent ? { defaultAgent } : {})
  };
}

function normalizeV4ManifestWorkload(
  workload: Record<string, unknown>
): LiftoffManifest['project']['workload'] {
  const kind = requiredString(workload, 'kind', 'Manifest.project.workload');
  if (kind === 'power-apps-code-app') {
    assertOnlyFields(
      workload,
      ['kind', 'starter', 'codeAppsPlugin'],
      'Manifest.project.workload'
    );
    if (!isRecord(workload.starter)) {
      throw new FileSystemError('Manifest.project.workload.starter must be a JSON object.');
    }
    assertOnlyFields(
      workload.starter,
      ['repository', 'path', 'commit'],
      'Manifest.project.workload.starter'
    );
    const repository = requiredString(
      workload.starter,
      'repository',
      'Manifest.project.workload.starter'
    );
    const templatePath = requiredString(
      workload.starter,
      'path',
      'Manifest.project.workload.starter'
    );
    const commit = requiredString(
      workload.starter,
      'commit',
      'Manifest.project.workload.starter'
    );
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repository)) {
      throw new FileSystemError('Manifest Power Apps starter repository must be a canonical GitHub repository URL.');
    }
    if (
      templatePath.startsWith('/') ||
      templatePath.endsWith('/') ||
      templatePath.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new FileSystemError('Manifest Power Apps starter path must be a canonical repository-relative path.');
    }
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new FileSystemError('Manifest Power Apps starter commit must be a 40-character lowercase Git commit.');
    }
    return {
      kind,
      starter: { repository, path: templatePath, commit },
      codeAppsPlugin: requiredBoolean(workload, 'codeAppsPlugin', 'Manifest.project.workload')
    };
  }
  if (kind !== 'genai' && kind !== 'standard') {
    throw new FileSystemError(`Manifest project workload kind ${JSON.stringify(kind)} is invalid.`);
  }
  const allowed = kind === 'genai'
    ? ['kind', 'apiStack', 'pattern', 'cloud', 'region', 'frontend', 'environments']
    : ['kind', 'apiStack', 'cloud', 'region', 'frontend', 'environments'];
  assertOnlyFields(workload, allowed, 'Manifest.project.workload');
  const apiStackValue = requiredString(workload, 'apiStack', 'Manifest.project.workload');
  const apiStack = getApiStack(apiStackValue);
  if (!apiStack || apiStack.id !== apiStackValue) {
    throw new FileSystemError(`Manifest project workload apiStack ${JSON.stringify(apiStackValue)} is invalid.`);
  }
  const patternValue = kind === 'genai'
    ? requiredString(workload, 'pattern', 'Manifest.project.workload')
    : undefined;
  const pattern = patternValue ? getPattern(patternValue) : undefined;
  if (kind === 'genai' && (!pattern || pattern.id !== patternValue || apiStack.id !== 'python-fastapi')) {
    throw new FileSystemError('GenAI manifest workloads require a valid pattern and python-fastapi API stack.');
  }
  const cloudValue = requiredString(workload, 'cloud', 'Manifest.project.workload');
  const provider = getProvider(cloudValue);
  if (!provider || provider.id !== cloudValue || provider.status !== 'available') {
    throw new FileSystemError(`Manifest project workload cloud ${JSON.stringify(cloudValue)} is invalid or unavailable.`);
  }
  const region = requiredString(workload, 'region', 'Manifest.project.workload');
  if (!listRegions(provider.id).some((candidate) => candidate.slug === region)) {
    throw new FileSystemError(`Manifest project workload region ${JSON.stringify(region)} is invalid for ${provider.id}.`);
  }
  if (!Array.isArray(workload.environments) || workload.environments.length === 0) {
    throw new FileSystemError('Manifest.project.workload.environments must be a non-empty string array.');
  }
  const environments = workload.environments.map((value, index) => {
    if (typeof value !== 'string') {
      throw new FileSystemError(`Manifest.project.workload.environments[${index}] must be a string.`);
    }
    const environment = getEnvironment(value);
    if (!environment || environment.id !== value) {
      throw new FileSystemError(`Manifest project workload environment ${JSON.stringify(value)} is invalid.`);
    }
    return environment.id;
  });
  if (new Set(environments).size !== environments.length) {
    throw new FileSystemError('Manifest.project.workload.environments must not contain duplicates.');
  }
  const common = {
    apiStack: apiStack.id,
    cloud: provider.id,
    region,
    frontend: requiredBoolean(workload, 'frontend', 'Manifest.project.workload'),
    environments
  };
  return kind === 'genai'
    ? { kind, ...common, pattern: pattern!.id }
    : { kind, ...common };
}

export function normalizeManifestFramework(
  value: unknown,
  artifactVersion: number,
  project: LiftoffManifest['project']
): LiftoffManifest['framework'] {
  if (artifactVersion === 2) {
    return { state: 'legacy', adapter: project.specWorkflow };
  }
  if (!isRecord(value)) {
    throw new FileSystemError('Manifest.framework must be a JSON object.');
  }
  if (artifactVersion >= 5) {
    assertOnlyFields(
      value,
      ['state', 'adapter', 'contractVersion'],
      'Manifest.framework'
    );
  }
  const state = requiredString(value, 'state', 'Manifest.framework');
  if (state !== 'initialized' && state !== 'legacy') {
    throw new FileSystemError('Manifest.framework.state must be "initialized" or "legacy".');
  }
  const adapterValue = requiredString(value, 'adapter', 'Manifest.framework');
  const adapter = getSpecWorkflow(adapterValue);
  if (!adapter || adapter.id !== adapterValue || adapter.id !== project.specWorkflow) {
    throw new FileSystemError('Manifest.framework.adapter must match Manifest.project.specWorkflow.');
  }
  const contractVersion = optionalString(value, 'contractVersion', 'Manifest.framework');
  if (contractVersion && !SEMVER_PATTERN.test(contractVersion)) {
    throw new FileSystemError('Manifest.framework.contractVersion must be a valid semantic version.');
  }
  if (state === 'legacy') {
    if (contractVersion || project.agents.length > 0 || project.defaultAgent) {
      throw new FileSystemError('Legacy framework state cannot claim a contract version or configured agents.');
    }
    return { state, adapter: adapter.id };
  }
  if (!contractVersion) {
    throw new FileSystemError('Initialized framework state requires Manifest.framework.contractVersion.');
  }
  if (project.agents.length === 0) {
    throw new FileSystemError('Initialized framework state requires at least one configured agent.');
  }
  if (adapter.id === 'spec-kit') {
    if (!project.defaultAgent || !project.agents.includes(project.defaultAgent)) {
      throw new FileSystemError('Spec Kit manifests require a selected defaultAgent.');
    }
  } else if (project.defaultAgent) {
    throw new FileSystemError('OpenSpec manifests cannot record a defaultAgent.');
  }
  return { state, adapter: adapter.id, contractVersion };
}

function normalizeManifestGovernance(
  value: unknown,
  artifactVersion: number
): LiftoffManifest['governance'] {
  if (artifactVersion < 5) {
    return { profile: 'unspecified', state: 'unspecified' };
  }
  if (!isRecord(value)) {
    throw new FileSystemError('Manifest.governance must be a JSON object.');
  }
  const profileValue = requiredString(value, 'profile', 'Manifest.governance');
  const profile = getGovernanceProfile(profileValue);
  if (!profile || profile.id !== profileValue) {
    throw new FileSystemError(
      `Manifest governance profile ${JSON.stringify(profileValue)} is invalid.`
    );
  }
  const state = requiredString(value, 'state', 'Manifest.governance');
  if (profile.id === 'none') {
    assertOnlyFields(value, ['profile', 'state'], 'Manifest.governance');
    if (state !== 'disabled') {
      throw new FileSystemError(
        'Manifest governance profile none requires disabled state.'
      );
    }
    return { profile: profile.id, state };
  }
  assertOnlyFields(
    value,
    artifactVersion === 7
      ? ['profile', 'policyVersion', 'state', 'activationIdentity']
      : ['profile', 'policyVersion', 'state'],
    'Manifest.governance'
  );
  const policyVersion = requiredString(
    value,
    'policyVersion',
    'Manifest.governance'
  );
  if (!/^[1-9]\d*$/.test(policyVersion)) {
    throw new FileSystemError(
      'Manifest governance policyVersion must be a positive integer.'
    );
  }
  const supportedPolicyVersions = artifactVersion === 7
    ? [governancePolicyVersion]
    : ['1', '2', '3', '4', '5', governancePolicyVersion];
  if (!supportedPolicyVersions.includes(policyVersion)) {
    throw new FileSystemError(
      `Manifest governance policyVersion cannot be newer than ${governancePolicyVersion}. ` +
        `Unsupported Manifest.governance.policyVersion: found ${JSON.stringify(policyVersion)}; ` +
        `supported values for artifactVersion ${artifactVersion} are ${supportedPolicyVersions.map((value) => JSON.stringify(value)).join(', ')}. ` +
        `Minimum Liftoff ${currentActivationIdentity.liftoffVersion} is required for policy ${governancePolicyVersion}; ` +
        'upgrade the CLI for future policy identities or restore a supported manifest without writing.'
    );
  }
  if (artifactVersion === 7 && policyVersion !== governancePolicyVersion) {
    throw new FileSystemError(
      `Manifest governance policyVersion must be ${governancePolicyVersion} for artifactVersion 7.`
    );
  }
  if (state !== 'handoff-generated' && state !== 'handoff-partial') {
    throw new FileSystemError(
      'Enabled manifest governance requires handoff-generated or handoff-partial state.'
    );
  }
  if (artifactVersion === 7) {
    let activationIdentity;
    try {
      activationIdentity = validateActivationIdentity(value.activationIdentity);
    } catch (error) {
      throw new FileSystemError(
        `Manifest governance activationIdentity is invalid: ${errorMessage(error)}`
      );
    }
    if (activationIdentity.policyVersion !== policyVersion) {
      throw new FileSystemError(
        'Manifest governance activationIdentity.policyVersion must match policyVersion.'
      );
    }
    return {
      profile: profile.id,
      policyVersion,
      activationIdentity,
      state
    };
  }
  return {
    profile: profile.id,
    policyVersion,
    state
  };
}

function normalizeManifestManagedArtifacts(
  value: unknown,
  scopeRoot: string
): ManifestManagedArtifact[] {
  if (!Array.isArray(value)) {
    throw new FileSystemError(`${scopeRoot} must be an array.`);
  }

  const logicalNames = new Set<string>();
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const scope = `${scopeRoot}[${index}]`;
    if (!isRecord(entry)) {
      throw new FileSystemError(`${scope} must be a JSON object.`);
    }
    assertOnlyFields(
      entry,
      ['logicalName', 'category', 'pathParts', 'contentHash'],
      scope
    );
    const logicalName = requiredString(entry, 'logicalName', scope);
    const category = requiredString(entry, 'category', scope);
    const pathParts = validateArtifactPathParts(entry.pathParts, `${scope}.pathParts`);
    const contentHash = requiredString(entry, 'contentHash', scope);
    if (!CONTENT_HASH_PATTERN.test(contentHash)) {
      throw new FileSystemError(`${scope}.contentHash must be a sha256-prefixed lowercase hexadecimal digest.`);
    }
    if (logicalNames.has(logicalName)) {
      throw new FileSystemError(`Manifest contains duplicate logicalName ${JSON.stringify(logicalName)}.`);
    }
    logicalNames.add(logicalName);
    const pathKey = pathParts.join('\0');
    if (paths.has(pathKey)) {
      throw new FileSystemError(`Manifest contains duplicate artifact path ${pathParts.join('/')}.`);
    }
    paths.add(pathKey);
    return { logicalName, category, pathParts, contentHash };
  });
}

function normalizeManifestProjectArtifacts(value: unknown): ManifestProjectArtifact[] {
  if (!Array.isArray(value)) {
    throw new FileSystemError('Manifest.projectArtifacts must be an array.');
  }

  const logicalNames = new Set<string>();
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const scope = `Manifest.projectArtifacts[${index}]`;
    if (!isRecord(entry)) {
      throw new FileSystemError(`${scope} must be a JSON object.`);
    }
    assertOnlyFields(
      entry,
      [
        'logicalName',
        'category',
        'pathParts',
        'generatedBy',
        'generationHash',
        'provisioningGroup'
      ],
      scope
    );
    const logicalName = requiredString(entry, 'logicalName', scope);
    const category = requiredString(entry, 'category', scope);
    const pathParts = validateArtifactPathParts(entry.pathParts, `${scope}.pathParts`);
    const generatedBy = requiredString(entry, 'generatedBy', scope);
    if (!SEMVER_PATTERN.test(generatedBy)) {
      throw new FileSystemError(`${scope}.generatedBy must be a valid semantic version.`);
    }
    const generationHash = requiredString(entry, 'generationHash', scope);
    if (!CONTENT_HASH_PATTERN.test(generationHash)) {
      throw new FileSystemError(
        `${scope}.generationHash must be a sha256-prefixed lowercase hexadecimal digest.`
      );
    }
    const provisioningGroup = normalizeProjectProvisioningGroup(
      requiredString(entry, 'provisioningGroup', scope),
      scope
    );
    if (logicalNames.has(logicalName)) {
      throw new FileSystemError(`Manifest contains duplicate logicalName ${JSON.stringify(logicalName)}.`);
    }
    logicalNames.add(logicalName);
    const pathKey = pathParts.join('\0');
    if (paths.has(pathKey)) {
      throw new FileSystemError(`Manifest contains duplicate artifact path ${pathParts.join('/')}.`);
    }
    paths.add(pathKey);
    return {
      logicalName,
      category,
      pathParts,
      generatedBy,
      generationHash,
      provisioningGroup
    };
  });
}

function normalizeProjectProvisioningGroup(
  value: string,
  scope: string
): ProjectProvisioningGroup {
  if (
    value === 'base' ||
    value === 'frontend' ||
    value === 'power-apps-starter'
  ) {
    return value;
  }
  const prefix = 'environment:';
  if (value.startsWith(prefix)) {
    const environmentValue = value.slice(prefix.length);
    const environment = getEnvironment(environmentValue);
    if (environment?.id === environmentValue) {
      return `environment:${environment.id}`;
    }
  }
  throw new FileSystemError(`${scope}.provisioningGroup is invalid.`);
}

function validateV6AndV7ArtifactAuthority(
  managedArtifacts: readonly ManifestManagedArtifact[],
  projectArtifacts: readonly ManifestProjectArtifact[]
): void {
  for (const artifact of managedArtifacts) {
    if (isManagedCoreLogicalName(artifact.logicalName)) {
      continue;
    }
    if (isRetiredManagedCoreLogicalName(artifact.logicalName)) {
      if (
        !isRetiredManagedCoreArtifactIdentity(
          artifact.logicalName,
          artifact.category,
          artifact.pathParts
        )
      ) {
        throw new FileSystemError(
          `Retired managed-core artifact ${artifact.logicalName} has invalid identity.`
        );
      }
      continue;
    }
    if (isUnknownRetiredManagedCoreAliasLogicalName(artifact.logicalName)) {
      throw new FileSystemError(
        `Manifest managed artifact ${artifact.logicalName} is an unknown retired managed-core alias logical name.`
      );
    }
    throw new FileSystemError(
      `Manifest managed artifact ${artifact.logicalName} is not an explicit managed-core logical name.`
    );
  }
  for (const artifact of projectArtifacts) {
    if (isManagedCoreLogicalName(artifact.logicalName)) {
      throw new FileSystemError(
        `Manifest project artifact ${artifact.logicalName} cannot contain a managed-core logical name.`
      );
    }
    if (isRetiredManagedCoreLogicalName(artifact.logicalName)) {
      throw new FileSystemError(
        `Manifest project artifact ${artifact.logicalName} cannot contain a retired managed-core logical name.`
      );
    }
    if (isUnknownRetiredManagedCoreAliasLogicalName(artifact.logicalName)) {
      throw new FileSystemError(
        `Manifest project artifact ${artifact.logicalName} cannot contain an unknown retired managed-core alias logical name.`
      );
    }
  }
}

function validateManifestArtifactUniqueness(
  managedArtifacts: readonly ManifestManagedArtifact[],
  projectArtifacts: readonly ManifestProjectArtifact[]
): void {
  const logicalNames = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of [...managedArtifacts, ...projectArtifacts]) {
    if (logicalNames.has(artifact.logicalName)) {
      throw new FileSystemError(
        `Manifest contains duplicate logicalName ${JSON.stringify(artifact.logicalName)}.`
      );
    }
    logicalNames.add(artifact.logicalName);
    const pathKey = artifact.pathParts.join('\0');
    if (paths.has(pathKey)) {
      throw new FileSystemError(
        `Manifest contains duplicate artifact path ${artifact.pathParts.join('/')}.`
      );
    }
    paths.add(pathKey);
  }
}

const governanceLogicalPaths = new Map<string, readonly string[]>([
  ['repository-governance-policy', governanceArtifactPaths.policy],
  ['repository-governance-context', governanceArtifactPaths.context],
  ['repository-governance-guide', governanceArtifactPaths.guide],
  ['repository-governance-phase-graph', governanceArtifactPaths.phaseGraph],
  ['repository-governance-compatibility', governanceArtifactPaths.compatibility],
  [
    'repository-governance-credential-policy-schema',
    governanceArtifactPaths.credentialPolicySchema
  ],
  [
    'liftoff-setup-copilot',
    governanceArtifactPaths.setup['github-copilot']
  ],
  [
    'liftoff-setup-claude',
    governanceArtifactPaths.setup.claude
  ],
  [
    'liftoff-governance-assess-copilot',
    governanceArtifactPaths.assessment['github-copilot']
  ],
  [
    'liftoff-governance-assess-claude',
    governanceArtifactPaths.assessment.claude
  ]
]);

const assessmentLogicalNames = [
  'liftoff-governance-assess-copilot',
  'liftoff-governance-assess-claude'
] as const;
const preAssessmentManagedCoreLogicalNames = managedCoreLogicalNames.filter((logicalName) =>
  !assessmentLogicalNames.some((assessment) => assessment === logicalName)
);

function validateGovernanceArtifactIdentity(manifest: LiftoffManifest): void {
  if ([...manifest.managedArtifacts, ...manifest.projectArtifacts].some((artifact) =>
    artifact.pathParts.join('/') === 'governance/activation-baseline.json'
  )) {
    throw new FileSystemError(
      'governance/activation-baseline.json is user-owned and cannot be a Liftoff manifest artifact.'
    );
  }
  const governanceArtifacts = manifest.managedArtifacts.filter((artifact) =>
    governanceLogicalPaths.has(artifact.logicalName)
  );
  const retiredGovernanceArtifacts = manifest.managedArtifacts.filter((artifact) =>
    isRetiredManagedCoreLogicalName(artifact.logicalName)
  );
  for (const artifact of retiredGovernanceArtifacts) {
    if (
      !isRetiredManagedCoreArtifactIdentity(
        artifact.logicalName,
        artifact.category,
        artifact.pathParts
      )
    ) {
      throw new FileSystemError(
        `Retired managed-core artifact ${artifact.logicalName} has invalid identity.`
      );
    }
  }
  const applicableAssessment: string[] = manifest.project.agents.map((agent) =>
    agent === 'github-copilot'
      ? 'liftoff-governance-assess-copilot'
      : 'liftoff-governance-assess-claude'
  );
  for (const artifact of governanceArtifacts.filter((entry) =>
    assessmentLogicalNames.some((logicalName) => entry.logicalName === logicalName)
  )) {
    if (!applicableAssessment.includes(artifact.logicalName)) {
      throw new FileSystemError(
        `Manifest governance contains inapplicable assessment integration ${artifact.logicalName}.`
      );
    }
    if (
      artifact.category !== 'governance' ||
      artifact.pathParts.join('\0') !== governanceLogicalPaths.get(artifact.logicalName)!.join('\0')
    ) {
      throw new FileSystemError(
        `Manifest governance artifact ${artifact.logicalName} has invalid identity.`
      );
    }
  }
  if (manifest.governance.profile === 'unspecified') {
    return;
  }
  if (manifest.governance.profile === 'none') {
    if (governanceArtifacts.length > 0 || retiredGovernanceArtifacts.length > 0) {
      throw new FileSystemError(
        'Disabled manifest governance cannot own governance handoff artifacts.'
      );
    }
    return;
  }
  const required = [
    'repository-governance-policy',
    'repository-governance-context',
    'repository-governance-guide',
    'repository-governance-phase-graph',
    'repository-governance-compatibility',
    'repository-governance-credential-policy-schema',
    ...manifest.project.agents.map((agent) =>
      agent === 'github-copilot'
        ? 'liftoff-setup-copilot'
        : 'liftoff-setup-claude'
    )
  ];
  const applicable = [...required, ...applicableAssessment];
  const hasAssessmentInventory = governanceArtifacts.some((artifact) =>
    applicableAssessment.includes(artifact.logicalName)
  );
  const missing: string[] = [];
  for (const logicalName of applicable) {
    const artifact = manifest.managedArtifacts.find((entry) =>
      entry.logicalName === logicalName
    );
    const expectedPath = governanceLogicalPaths.get(logicalName);
    if (!artifact) {
      missing.push(logicalName);
      continue;
    }
    if (!expectedPath) {
      throw new FileSystemError(`Unknown manifest governance artifact ${logicalName}.`);
    }
    if (
      artifact.category !== 'governance' ||
      artifact.pathParts.join('\0') !== expectedPath.join('\0')
    ) {
      throw new FileSystemError(
        `Manifest governance artifact ${logicalName} has invalid identity.`
      );
    }
  }
  // Supported older complete inventories predate assessment integrations.
  const missingRequired = missing.filter((logicalName) =>
    hasAssessmentInventory || required.includes(logicalName)
  );
  if (manifest.governance.state === 'handoff-generated' && missingRequired.length > 0) {
    throw new FileSystemError(
      `Enabled manifest governance is missing artifact ${missingRequired[0]}.`
    );
  }
  if (
    manifest.governance.state === 'handoff-partial' &&
    missing.length === 0 &&
    retiredGovernanceArtifacts.length === 0
  ) {
    throw new FileSystemError(
      'Manifest governance state handoff-partial requires at least one applicable artifact to remain outside Liftoff ownership or one protected retired alias to remain tracked.'
    );
  }
  for (const artifact of governanceArtifacts) {
    if (!applicable.includes(artifact.logicalName)) {
      const integration = assessmentLogicalNames.some((logicalName) => artifact.logicalName === logicalName)
        ? 'assessment'
        : 'setup';
      throw new FileSystemError(
        `Manifest governance contains inapplicable ${integration} integration ${artifact.logicalName}.`
      );
    }
  }
}

export async function validateGeneratedProject(projectRoot: string): Promise<string[]> {
  let manifest: LiftoffManifest;
  try {
    manifest = await loadManifest(projectRoot);
  } catch (error) {
    return [(error as Error).message];
  }

  const issues: string[] = [];
  for (const artifact of manifest.managedArtifacts) {
    if (isRetiredManagedCoreLogicalName(artifact.logicalName)) {
      try {
        await resolveProjectPath(projectRoot, artifact.pathParts);
      } catch (error) {
        issues.push(
          `Unsafe retired managed-core path for ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`
        );
      }
      continue;
    }
    try {
      const targetPath = await resolveProjectPath(projectRoot, artifact.pathParts);
      const bytes = await readFile(targetPath);
      const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actualHash !== artifact.contentHash) {
        issues.push(
          `Artifact hash mismatch for ${artifact.logicalName} at ${artifact.pathParts.join('/')}`
        );
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        issues.push(`Missing artifact ${artifact.logicalName} at ${artifact.pathParts.join('/')}`);
      } else {
        issues.push(`Unable to access artifact ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`);
      }
    }
  }
  const compatibilityArtifact = manifest.managedArtifacts.find((artifact) =>
    artifact.logicalName === 'repository-governance-compatibility'
  );
  if (
    compatibilityArtifact &&
    manifest.governance.profile !== 'none' &&
    manifest.governance.profile !== 'unspecified'
  ) {
    try {
      const bytes = await readProjectFile(projectRoot, compatibilityArtifact.pathParts);
      if (bytes === undefined) {
        issues.push(
          `Missing artifact ${compatibilityArtifact.logicalName} at ${compatibilityArtifact.pathParts.join('/')}`
        );
      } else {
        const hasRetiredManagedArtifacts = manifest.managedArtifacts.some((artifact) =>
          isRetiredManagedCoreLogicalName(artifact.logicalName)
        );
        const currentManagedArtifacts = manifest.managedArtifacts.filter((artifact) =>
          !isRetiredManagedCoreLogicalName(artifact.logicalName)
        );
        const expectedInventory: ManagedCompatibilityInventoryEntry[] =
          currentManagedArtifacts.map((artifact) => ({
            logicalName: artifact.logicalName,
            pathParts: artifact.pathParts,
            lifecycle: 'managed-core',
            contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
          }));
        const compatibility = validateGovernanceCompatibilityMetadata(
          JSON.parse(bytes.toString('utf8')) as unknown
        );
        const predatesAssessment = !currentManagedArtifacts.some((artifact) =>
          assessmentLogicalNames.some((logicalName) => artifact.logicalName === logicalName)
        ) && compatibility.managedCore.logicalNameAllowlist.join('\0') ===
          preAssessmentManagedCoreLogicalNames.join('\0');
        const logicalNameAllowlist = predatesAssessment
          ? preAssessmentManagedCoreLogicalNames
          : managedCoreLogicalNames;
        validateGovernanceCompatibilityMetadata(
          compatibility,
          hasRetiredManagedArtifacts
            ? undefined
            : manifest.governance.state === 'handoff-generated'
            ? {
                logicalNameAllowlist,
                pathAllowlist: currentManagedArtifacts.map((artifact) => artifact.pathParts),
                inventory: expectedInventory
              }
            : {
                logicalNameAllowlist
              }
        );
      }
    } catch (error) {
      issues.push(`Invalid repository-governance-compatibility at ${compatibilityArtifact.pathParts.join('/')}: ${errorMessage(error)}`);
    }
  }
  for (const artifact of manifest.projectArtifacts) {
    try {
      await resolveProjectPath(projectRoot, artifact.pathParts);
    } catch (error) {
      issues.push(
        `Unsafe project provenance path for ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`
      );
    }
  }

  if (manifest.framework.state === 'initialized') {
    issues.push(...await validateFrameworkInstallation(projectRoot, {
      workflow: manifest.framework.adapter,
      agents: manifest.project.agents,
      ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
    }));
  }
  if (manifest.project.workload.kind === 'power-apps-code-app') {
    const requiredArtifacts = [
      { logicalName: 'power-apps-package', pathParts: ['package.json'] },
      { logicalName: 'power-apps-lock', pathParts: ['package-lock.json'] },
      { logicalName: 'power-apps-readme', pathParts: ['README.md'] },
      { logicalName: 'power-apps-attribution', pathParts: ['THIRD_PARTY_NOTICES.md'] }
    ];
    for (const required of requiredArtifacts) {
      const artifact = manifest.projectArtifacts.find(
        (entry) => entry.logicalName === required.logicalName
      );
      if (!artifact) {
        issues.push(
          `Missing required Power Apps manifest artifact ${required.logicalName} at ${required.pathParts.join('/')}`
        );
      } else if (artifact.pathParts.join('/') !== required.pathParts.join('/')) {
        issues.push(
          `Power Apps manifest artifact ${required.logicalName} must target ${required.pathParts.join('/')}`
        );
      }
    }
  }

  return issues;
}

export function manifestDisplayPath(pathParts: string[]): string {
  return pathParts.join('/');
}

export async function findProjectRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  while (true) {
    try {
      await access(path.join(current, 'liftoff.manifest.json'));
      return current;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') {
        throw new FileSystemError(`Unable to inspect ${current} for a Liftoff manifest: ${errorMessage(error)}`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

export async function readProjectFile(projectRoot: string, pathParts: string[]): Promise<Buffer | undefined> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw new FileSystemError(`Unable to read ${pathParts.join('/')}: ${errorMessage(error)}`);
  }
}

export async function writeProjectFile(
  projectRoot: string,
  pathParts: string[],
  content: string | Buffer
): Promise<void> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.liftoff-${process.pid}-${randomUUID()}.tmp`
  );
  let temporaryFileWritten = false;
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(temporaryPath, content, { flag: 'wx' });
    temporaryFileWritten = true;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    let cleanupFailure: string | undefined;
    if (temporaryFileWritten) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== 'ENOENT') {
          cleanupFailure = errorMessage(cleanupError);
        }
      }
    }
    const cleanupDetail = cleanupFailure ? ` Temporary-file cleanup also failed: ${cleanupFailure}` : '';
    throw new FileSystemError(`Unable to write ${pathParts.join('/')}: ${errorMessage(error)}${cleanupDetail}`);
  }
}

export async function deleteProjectFile(projectRoot: string, pathParts: string[]): Promise<void> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    await unlink(targetPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw new FileSystemError(`Unable to delete ${pathParts.join('/')}: ${errorMessage(error)}`);
  }
}

export interface ProjectFileSnapshot {
  pathParts: string[];
  content?: Buffer;
  mode?: number;
}

export async function captureProjectFileSnapshot(
  projectRoot: string,
  pathParts: string[]
): Promise<ProjectFileSnapshot> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  try {
    const details = await lstat(targetPath);
    if (!details.isFile()) {
      throw new FileSystemError(
        `Project update target must be a regular file: ${pathParts.join('/')}`
      );
    }
    return {
      pathParts,
      content: await readFile(targetPath),
      mode: details.mode & 0o7777
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { pathParts };
    }
    throw error;
  }
}

async function assertProjectFileSnapshot(
  projectRoot: string,
  snapshot: ProjectFileSnapshot
): Promise<void> {
  const current = await captureProjectFileSnapshot(projectRoot, snapshot.pathParts);
  if (
    (snapshot.content === undefined) !== (current.content === undefined) ||
    snapshot.mode !== current.mode ||
    snapshot.content?.equals(current.content!) === false
  ) {
    throw new FileSystemError(
      `Project update target changed after review: ${snapshot.pathParts.join('/')}`
    );
  }
}

async function assertAppliedMutationCurrent(
  projectRoot: string,
  mutation: ProjectFileMutation
): Promise<void> {
  const current = await captureProjectFileSnapshot(projectRoot, mutation.pathParts);
  if (mutation.type === 'delete') {
    if (current.content !== undefined) {
      throw new FileSystemError(
        `Project update target changed before rollback: ${mutation.pathParts.join('/')}`
      );
    }
    return;
  }
  if (
    current.content === undefined ||
    !current.content.equals(Buffer.from(mutation.content, 'utf8'))
  ) {
    throw new FileSystemError(
      `Project update target changed before rollback: ${mutation.pathParts.join('/')}`
    );
  }
}

async function missingMutationParents(
  projectRoot: string,
  pathParts: string[]
): Promise<string[][]> {
  const missing: string[][] = [];
  for (let index = 1; index < pathParts.length; index += 1) {
    const parentParts = pathParts.slice(0, index);
    const parentPath = await resolveProjectPath(projectRoot, parentParts);
    try {
      const details = await lstat(parentPath);
      if (!details.isDirectory() && !details.isSymbolicLink()) {
        throw new FileSystemError(
          `Artifact path parent is not a directory: ${parentParts.join('/')}`
        );
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        missing.push(parentParts);
        continue;
      }
      throw error;
    }
  }
  return missing;
}

export async function applyProjectFileTransaction(
  projectRoot: string,
  mutations: readonly ProjectFileMutation[],
  options: {
    onBeforeMutation?: (mutation: ProjectFileMutation, index: number) => Promise<void>;
    preconditions?: readonly ProjectFileSnapshot[];
  } = {}
): Promise<void> {
  const snapshots = new Map<string, ProjectFileSnapshot>();
  const preconditions = new Map<string, ProjectFileSnapshot>();
  const missingParents = new Map<string, string[]>();
  for (const snapshot of options.preconditions ?? []) {
    const key = snapshot.pathParts.join('\0');
    if (preconditions.has(key)) {
      throw new FileSystemError(
        `Project update contains duplicate preconditions for ${snapshot.pathParts.join('/')}.`
      );
    }
    preconditions.set(key, snapshot);
  }
  for (const mutation of mutations) {
    const key = mutation.pathParts.join('\0');
    if (snapshots.has(key)) {
      throw new FileSystemError(
        `Project update contains duplicate mutations for ${mutation.pathParts.join('/')}.`
      );
    }
    snapshots.set(
      key,
      preconditions.get(key) ??
        await captureProjectFileSnapshot(projectRoot, mutation.pathParts)
    );
    if (mutation.type === 'write') {
      for (const parentParts of await missingMutationParents(projectRoot, mutation.pathParts)) {
        missingParents.set(parentParts.join('\0'), parentParts);
      }
    }
  }
  for (const snapshot of preconditions.values()) {
    await assertProjectFileSnapshot(projectRoot, snapshot);
  }

  const applied: ProjectFileMutation[] = [];
  try {
    for (const [index, mutation] of mutations.entries()) {
      await options.onBeforeMutation?.(mutation, index);
      await assertProjectFileSnapshot(
        projectRoot,
        snapshots.get(mutation.pathParts.join('\0'))!
      );
      if (mutation.type === 'write') {
        await writeProjectFile(projectRoot, mutation.pathParts, mutation.content);
      } else {
        await deleteProjectFile(projectRoot, mutation.pathParts);
      }
      applied.push(mutation);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const mutation of [...applied].reverse()) {
      const snapshot = snapshots.get(mutation.pathParts.join('\0'))!;
      try {
        await assertAppliedMutationCurrent(projectRoot, mutation);
        if (snapshot.content === undefined) {
          await deleteProjectFile(projectRoot, mutation.pathParts);
        } else {
          await writeProjectFile(projectRoot, mutation.pathParts, snapshot.content);
          await chmod(
            await resolveProjectPath(projectRoot, mutation.pathParts),
            snapshot.mode!
          );
        }
      } catch (rollbackError) {
        rollbackFailures.push(
          `${mutation.pathParts.join('/')}: ${errorMessage(rollbackError)}`
        );
      }
    }
    const parents = [...missingParents.values()]
      .sort((left, right) => right.length - left.length);
    for (const parentParts of parents) {
      try {
        await rmdir(await resolveProjectPath(projectRoot, parentParts));
      } catch (rollbackError) {
        if (errorCode(rollbackError) !== 'ENOENT') {
          rollbackFailures.push(`${parentParts.join('/')}: ${errorMessage(rollbackError)}`);
        }
      }
    }
    const rollbackDetail = rollbackFailures.length === 0
      ? 'All applied changes were rolled back.'
      : `Rollback was incomplete:\n${rollbackFailures.map((failure) => `- ${failure}`).join('\n')}`;
    throw new ProjectFileTransactionError(
      `Project update failed: ${errorMessage(error)} ${rollbackDetail}`,
      rollbackFailures
    );
  }
}