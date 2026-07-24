import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getApiStack,
  canonicalizeCodingAgents,
  getEnvironment,
  getCodingAgent,
  getPattern,
  getProvider,
  getProjectType,
  getSpecWorkflow,
  listRegions
} from './catalogs.js';
import type { GeneratedArtifact, LiftoffManifest, ManifestArtifact } from './types.js';
import { validateFrameworkInstallation } from './framework-validation.js';

export class FileSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileSystemError';
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

export const SUPPORTED_MANIFEST_VERSIONS: readonly number[] = [2, 3];

// seed entries recorded by 0.2.0 manifests; dropped on read so archiving the
// seeded change is a non-event for validate, update, and doctor
const LEGACY_SEED_LOGICAL_NAMES = new Set([
  'openspec-seed-change-metadata',
  'openspec-seed-proposal',
  'openspec-seed-design',
  'openspec-seed-tasks'
]);

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

  if (!isRecord(raw)) {
    throw new FileSystemError('Manifest root must be a JSON object.');
  }

  const artifactVersion = raw.artifactVersion;
  if (typeof artifactVersion !== 'number' || !Number.isInteger(artifactVersion)) {
    throw new FileSystemError('Manifest artifactVersion must be an integer.');
  }
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(artifactVersion)) {
    throw new FileSystemError(
      `Unsupported manifest artifactVersion ${JSON.stringify(artifactVersion)}; this CLI supports version ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}. ` +
        'Regenerate the project with this CLI or use the Liftoff version that generated it.'
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
  const artifacts = normalizeManifestArtifacts(raw.artifacts)
    .filter((artifact) => !LEGACY_SEED_LOGICAL_NAMES.has(artifact.logicalName));

  return {
    artifactVersion: artifactVersion as 2 | 3,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project,
    framework,
    artifacts
  };
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

function normalizeManifestProject(project: unknown, artifactVersion: number): LiftoffManifest['project'] {
  if (!isRecord(project)) {
    throw new FileSystemError('Manifest.project must be a JSON object.');
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
    projectType: projectType.id,
    apiStack: apiStack.id,
    ...(pattern ? { pattern: pattern.id } : {}),
    cloud: provider.id,
    region: regionValue,
    frontend,
    specWorkflow: specWorkflow.id,
    agents,
    ...(defaultAgent ? { defaultAgent } : {}),
    environments
  };
}

function normalizeManifestFramework(
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

function normalizeManifestArtifacts(value: unknown): ManifestArtifact[] {
  if (!Array.isArray(value)) {
    throw new FileSystemError('Manifest.artifacts must be an array.');
  }

  const logicalNames = new Set<string>();
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const scope = `Manifest.artifacts[${index}]`;
    if (!isRecord(entry)) {
      throw new FileSystemError(`${scope} must be a JSON object.`);
    }
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

export async function validateGeneratedProject(projectRoot: string): Promise<string[]> {
  let manifest: LiftoffManifest;
  try {
    manifest = await loadManifest(projectRoot);
  } catch (error) {
    return [(error as Error).message];
  }

  const issues: string[] = [];
  for (const artifact of manifest.artifacts) {
    try {
      const targetPath = await resolveProjectPath(projectRoot, artifact.pathParts);
      await access(targetPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        issues.push(`Missing artifact ${artifact.logicalName} at ${artifact.pathParts.join('/')}`);
      } else {
        issues.push(`Unable to access artifact ${artifact.logicalName} at ${artifact.pathParts.join('/')}: ${errorMessage(error)}`);
      }
    }
  }

  if (manifest.framework.state === 'initialized') {
    issues.push(...await validateFrameworkInstallation(projectRoot, {
      workflow: manifest.framework.adapter,
      agents: manifest.project.agents,
      ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
    }));
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

export async function writeProjectFile(projectRoot: string, pathParts: string[], content: string): Promise<void> {
  const targetPath = await resolveProjectPath(projectRoot, pathParts);
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.liftoff-${process.pid}-${randomUUID()}.tmp`
  );
  let temporaryFileWritten = false;
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
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