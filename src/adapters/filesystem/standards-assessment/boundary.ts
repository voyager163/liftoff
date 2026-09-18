import path from 'node:path';
import type { AssessmentTarget } from '../../../domain/standards-assessment/types.js';
import { BoundaryError, PathSafetyError } from './errors.js';
import { AssessmentSnapshot } from './snapshot.js';
import { loadManifest } from '../../../application/project/manifest.js';
import { sha256Hex } from '../../../domain/standards-assessment/sanitizer.js';

interface ResolveTargetOptions {
  targetPath?: string;
  projectRoot?: string;
  componentPath?: string;
  stopAt?: string;
  invocationCwd?: string;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function detectCaseCollision(dirPath: string): Promise<void> {
  const snapshot = await AssessmentSnapshot.create(dirPath);
  await snapshot.list([], 10_000);
  await snapshot.assertCurrent();
}

export async function checkPathSafety(resolvedPath: string): Promise<string> {
  try {
    await detectCaseCollision(resolvedPath);
    return resolvedPath;
  } catch (error) {
    if (error instanceof PathSafetyError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new BoundaryError(`Target path does not exist: ${resolvedPath}`);
    }
    throw new PathSafetyError(`Unable to inspect target directory: ${error instanceof Error ? error.message : 'Filesystem inspection failed.'}`);
  }
}

export async function findGitRoot(startDir: string, stopAt?: string): Promise<string | null> {
  const snapshots: AssessmentSnapshot[] = [];
  const root = await discoverGitRoot(startDir, stopAt, snapshots);
  for (const snapshot of snapshots) await snapshot.assertCurrent();
  return root;
}

async function discoverGitRoot(
  startDir: string, stopAt: string | undefined, snapshots: AssessmentSnapshot[]
): Promise<string | null> {
  let current = path.resolve(startDir);
  const resolvedStopAt = stopAt ? path.resolve(stopAt) : null;
  if (resolvedStopAt && !isPathWithin(resolvedStopAt, current)) {
    throw new BoundaryError('Git discovery stop boundary must contain the selected target.');
  }
  for (let depth = 0; depth < 64; depth++) {
    const snapshot = await AssessmentSnapshot.create(current);
    snapshots.push(snapshot);
    const marker = await snapshot.inspect(['.git']);
    if (marker) {
      if (marker.isSymbolicLink() || !(marker.isDirectory() || marker.isFile())) {
        throw new BoundaryError('Git marker must be a real directory or bounded worktree file, never a link or special entry.');
      }
      if (marker.isDirectory()) return current;
      const { content } = await snapshot.read(['.git'], 4096);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      if (!/^gitdir: \S(?:[^\u0000-\u001f\u007f]*\S)?(?:\r?\n)?(?![\s\S])/u.test(text)) {
        throw new BoundaryError('Git worktree marker is malformed; repository identity is not inferred from an invalid pointer.');
      }
      return current;
    }
    if (resolvedStopAt && current === resolvedStopAt) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  throw new BoundaryError('Git discovery exceeds the bounded ancestor depth.');
}

export async function inspectManifest(projectDir: string): Promise<{
  present: boolean;
  version: number | null;
  path: string;
  digest?: string;
}> {
  const snapshot = await AssessmentSnapshot.create(projectDir);
  const manifest = await inspectManifestSnapshot(projectDir, snapshot);
  await snapshot.assertCurrent();
  return manifest;
}

async function inspectManifestSnapshot(projectDir: string, snapshot: AssessmentSnapshot): Promise<{
  present: boolean; version: number | null; path: string; digest?: string;
}> {
  const manifestPath = path.join(projectDir, 'liftoff.manifest.json');
  const details = await snapshot.inspect(['liftoff.manifest.json']);
  if (!details) return { present: false, version: null, path: manifestPath };
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new BoundaryError(
      `Inner manifest at ${manifestPath} must be a regular file, not a directory, symlink, junction, or FIFO.`
    );
  }
  try {
    const observed = await snapshot.read(['liftoff.manifest.json'], 2 * 1024 * 1024);
    const manifest = await loadManifest(projectDir);
    await snapshot.assertCurrent();
    return {
      present: true,
      version: manifest.artifactVersion,
      path: manifestPath,
      digest: `sha256:${sha256Hex(observed.content)}`
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new BoundaryError(`Malformed inner manifest at ${manifestPath}: ${msg}`);
  }
}

async function nearestProjectBoundary(
  start: string, repositoryRoot: string | null, snapshots: AssessmentSnapshot[]
): Promise<string> {
  let current = start;
  for (let depth = 0; depth < 64; depth++) {
    const snapshot = await AssessmentSnapshot.create(current);
    snapshots.push(snapshot);
    const manifest = await inspectManifestSnapshot(current, snapshot);
    if (manifest.present) return current;
    if (current === repositoryRoot) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
  throw new BoundaryError('Default project discovery exceeds the bounded ancestor depth.');
}

export async function resolveAssessmentTarget(
  options: ResolveTargetOptions = {}
): Promise<AssessmentTarget> {
  return (await resolveAssessmentTargetSnapshot(options)).target;
}

export interface AssessmentTargetSnapshot {
  target: AssessmentTarget;
  assertCurrent(): Promise<void>;
}

export async function resolveAssessmentTargetSnapshot(
  options: ResolveTargetOptions = {}
): Promise<AssessmentTargetSnapshot> {
  const explicitTarget = options.targetPath !== undefined || options.projectRoot !== undefined;
  const rawTarget = options.targetPath ?? options.projectRoot ?? options.invocationCwd ?? process.cwd();
  const targetPath = path.resolve(rawTarget);
  if (options.projectRoot && !isPathWithin(path.resolve(options.projectRoot), targetPath)) {
    throw new BoundaryError('Target path escapes the explicitly selected project root.');
  }

  await checkPathSafety(targetPath);
  const snapshots: AssessmentSnapshot[] = [];
  const innerSnapshot = await AssessmentSnapshot.create(targetPath);
  snapshots.push(innerSnapshot);
  const innerManifest = await inspectManifestSnapshot(targetPath, innerSnapshot);

  // Determine project root
  let projectRoot: string;
  if (options.projectRoot) {
    projectRoot = path.resolve(options.projectRoot);
    await checkPathSafety(projectRoot);
    if (!isPathWithin(projectRoot, targetPath)) {
      throw new BoundaryError(`Target path '${targetPath}' escapes specified project root '${projectRoot}'.`);
    }
    if (targetPath !== projectRoot && innerManifest.present) {
      throw new BoundaryError('The selected nested target has its own manifest; select it as the project rather than claiming it under another project.');
    }
  } else {
    projectRoot = targetPath;
  }

  // Discover Git root without initializing Git
  const repositoryRoot = await discoverGitRoot(targetPath, options.stopAt, snapshots);
  const hasGit = repositoryRoot !== null;
  if (!explicitTarget) projectRoot = await nearestProjectBoundary(targetPath, repositoryRoot, snapshots);

  // Inspect manifest at projectRoot
  const projectSnapshot = await AssessmentSnapshot.create(projectRoot);
  snapshots.push(projectSnapshot);
  const manifest = await inspectManifestSnapshot(projectRoot, projectSnapshot);

  let componentPath: string | null = null;
  let scanRoot: string;

  if (options.componentPath) {
    const cleanComponent = options.componentPath.trim();
    if (path.isAbsolute(cleanComponent) || path.win32.isAbsolute(cleanComponent) ||
        cleanComponent.split(/[\\/]/u).includes('..')) {
      throw new BoundaryError(`Component path '${cleanComponent}' must be relative to project root without escaping.`);
    }
    const resolvedComponent = path.resolve(projectRoot, cleanComponent);
    if (!isPathWithin(projectRoot, resolvedComponent)) {
      throw new BoundaryError(`Component path '${cleanComponent}' escapes project root boundary.`);
    }
    await checkPathSafety(resolvedComponent);
    componentPath = path.relative(projectRoot, resolvedComponent);
    scanRoot = resolvedComponent;
  } else if (explicitTarget && projectRoot !== targetPath) {
    componentPath = path.relative(projectRoot, targetPath);
    scanRoot = targetPath;
  } else {
    scanRoot = projectRoot;
  }
  if (scanRoot !== projectRoot) {
    const componentSnapshot = await AssessmentSnapshot.create(scanRoot);
    snapshots.push(componentSnapshot);
    if ((await inspectManifestSnapshot(scanRoot, componentSnapshot)).present) {
      throw new BoundaryError('The selected component contains a separate project manifest; assess that project explicitly.');
    }
  }

  const target: AssessmentTarget = {
    targetPath: scanRoot,
    projectRoot,
    repositoryRoot,
    componentPath,
    scanRoot,
    hasGit,
    hasManifest: manifest.present,
    manifestVersion: manifest.version,
    ...(manifest.present ? { manifestPath: manifest.path, manifestDigest: manifest.digest } : {})
  };
  const assertCurrent = async () => {
    for (const snapshot of snapshots) await snapshot.assertCurrent();
    if (manifest.present) {
      const current = await loadManifest(projectRoot);
      if (current.artifactVersion !== manifest.version) throw new BoundaryError('Manifest identity changed during assessment.');
      await projectSnapshot.assertCurrent();
    }
  };
  await assertCurrent();
  return { target, assertCurrent };
}
