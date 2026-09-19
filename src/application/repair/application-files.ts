import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { ObservedFileError, observedFileStamp as stamp, readObservedFile } from '../../adapters/filesystem/observed-file.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import {
  applicationBounds, type ApplicationDirectoryObservation, type ApplicationEntryKind
} from './application-types.js';

export class ApplicationInspectionError extends Error {}

export const applicationDigest = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const applicationPathKey = (parts: readonly string[]): string => parts.join('/');
export const applicationPathFold = (value: string): string =>
  value.normalize('NFKC').toUpperCase().toLowerCase();

export function applicationFailure(error: unknown): string {
  return error instanceof ApplicationInspectionError
    ? error.message : 'Application inspection could not safely read the complete bounded scope.';
}

export function applicationParts(value: unknown, allowRoot = false): string[] {
  if (allowRoot && Array.isArray(value) && value.length === 0) return [];
  let parts: string[];
  try { parts = validateArtifactPathParts(value, 'Application path'); }
  catch { throw new ApplicationInspectionError('Application paths must be portable, exact path-part arrays without traversal.'); }
  if (parts.length > applicationBounds.depth ||
      Buffer.byteLength(parts.join('/')) > applicationBounds.pathBytes ||
      parts.some((part) => /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) ||
        part !== part.normalize('NFKC') || Buffer.byteLength(part) > 255)) {
    throw new ApplicationInspectionError('Application path exceeds portable depth/name bounds or contains a normalization alias.');
  }
  return [...parts];
}

export function applicationWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function canonicalApplicationRoot(input: string): Promise<string> {
  try {
    const absolute = path.resolve(input);
    const details = await lstat(absolute);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new ApplicationInspectionError('Application root must be a real directory, not a link or junction.');
    }
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof ApplicationInspectionError) throw error;
    throw new ApplicationInspectionError('Application root is missing or cannot be safely resolved.');
  }
}

export async function assertApplicationNoLinkAncestors(absolute: string): Promise<void> {
  const resolved = path.resolve(absolute);
  const root = path.parse(resolved).root;
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let details: Stats;
    try { details = await lstat(current); }
    catch {
      throw new ApplicationInspectionError('External application staging has a missing or inaccessible path.');
    }
    if (details.isSymbolicLink() || index < parts.length - 1 && !details.isDirectory()) {
      throw new ApplicationInspectionError('External application staging must not traverse links or junctions.');
    }
  }
}

const excludedDirectories = new Set([
  '.git', '.hg', '.svn', '.bzr', '.liftoff',
  'infrastructure', 'infra', 'terraform', 'opentofu', '.terraform', '.tofu', '.terragrunt-cache',
  'state', 'states', '.state', 'tfstate', 'terraform.tfstate.d',
  '.aws', '.azure', '.gcloud', '.kube', '.ssh', '.gnupg', '.docker', '.direnv',
  'credentials', '.credentials', 'secrets', '.secrets', 'certificates',
  'node_modules', 'vendor', '.pnpm-store', '.yarn', '.npm', '.venv', 'venv', '.virtualenv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis',
  '.cache', '.turbo', '.parcel-cache', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'target', 'coverage', 'htmlcov', 'out', 'obj',
  '.idea', '.vscode', '.claude', '.agents', '.copilot', '.codex', '.cursor',
  '.specify', 'openspec'
]);
const excludedNames = new Set([
  'liftoff.manifest.json', 'liftoff.config.json', 'runtime.config.json', 'local.settings.json',
  '.liftoff-init.lock',
  '.env', '.envrc', '.netrc', '_netrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc',
  'state.json', 'state.yaml', 'state.yml', '.ds_store', '.pnp.cjs', '.pnp.loader.mjs',
  '.python_history', '.bash_history', '.zsh_history',
  '.terraformrc', 'terraform.rc', '.terraform.lock.hcl', '.gitmodules', '.gitattributes',
  'credentials.json', 'secrets.json', 'service-account.json', 'service_account.json',
  'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa',
  'agents.md', 'claude.md', 'gemini.md', '.cursorrules', '.copilotignore',
  'copilot-instructions.md', 'copilot-setup-steps.yml', 'copilot-setup-steps.yaml'
]);

/**
 * Application-recipe restrictions, not a global repair denylist: Azure retains its registered bookkeeping writes.
 * Restrictions never confer ownership; generated identities and each exact mapping do that separately.
 */
export function applicationExclusion(
  parts: readonly string[], protectedPaths: ReadonlySet<string> = new Set(),
  examplePaths: ReadonlySet<string> = new Set()
): string | null {
  const folded = parts.map(applicationPathFold);
  const key = folded.join('/');
  if (protectedPaths.has(key)) return 'exact-protected-artifact';
  if (folded.some((part) => excludedDirectories.has(part))) return 'excluded-control-state-secret-or-output-tree';
  if (folded.some((part) => excludedNames.has(part))) return 'excluded-control-or-live-configuration';
  if (folded.some((part) => /^(?:\.env[.-]|.*\.env(?:[.-]|$))/u.test(part)) &&
      !examplePaths.has(key)) return 'excluded-live-dotenv';
  if (folded.some((part) => /\.(?:tf|tfvars|tfstate|tfplan|tofu)(?:\.|$)/u.test(part) ||
      /\.(?:pem|key|p12|pfx|kdbx|sqlite|sqlite3|db)(?:\.|$)/u.test(part) ||
      /^(?:service[-_]account|credentials?|secrets?|tokens?)[.-]/u.test(part))) {
    return 'excluded-state-or-credential-file';
  }
  const github = folded.indexOf('.github');
  if (github >= 0 && ['skills', 'prompts', 'instructions', 'agents'].includes(folded[github + 1] ?? '')) {
    return 'excluded-native-agent-control';
  }
  if (folded[0] === 'specs' && folded[1] === '000-liftoff-bootstrap') return 'excluded-bootstrap-seed';
  return null;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const entryKind = (entry: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): ApplicationEntryKind =>
  entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';

export class ApplicationFiles {
  readonly snapshots = new Map<string, ProjectFileSnapshot>();
  readonly directoryInventory: ApplicationDirectoryObservation[] = [];
  readonly exclusions: { pathParts: string[]; kind: ApplicationEntryKind; reason: string }[] = [];
  private readonly directories = new Map<string, ApplicationDirectoryObservation>();
  private readonly stamps = new Map<string, string>();
  private totalBytes = 0;

  constructor(
    readonly root: string,
    private readonly exclude: (parts: readonly string[]) => string | null = () => null
  ) {}

  private async confined(parts: readonly string[]): Promise<string> {
    applicationParts(parts, true);
    let current = this.root;
    for (let index = 0; index <= parts.length; index++) {
      if (index) current = path.join(current, parts[index - 1]!);
      try {
        const details = await lstat(current);
        if (details.isSymbolicLink() || index < parts.length && !details.isDirectory()) {
          throw new ApplicationInspectionError(`${parts.slice(0, index).join('/') || '.'}: link, junction, or non-directory parent is unsupported.`);
        }
        if (await realpath(current) !== current) {
          throw new ApplicationInspectionError('Application scope contains a noncanonical path or alias.');
        }
      } catch (error) {
        if (missing(error) && index > 0) break;
        throw error;
      }
    }
    return path.join(this.root, ...parts);
  }

  async inventory(input: readonly string[]): Promise<ApplicationDirectoryObservation> {
    const parts = applicationParts(input, true);
    const key = applicationPathKey(parts);
    const previous = this.directories.get(key);
    if (previous) return previous;
    if (parts.length && this.exclude(parts)) {
      throw new ApplicationInspectionError(`${key}: excluded directories cannot be inspected.`);
    }
    if (this.directories.size >= applicationBounds.directories) {
      throw new ApplicationInspectionError('Application inventory exceeds the directory count bound.');
    }
    const observation: ApplicationDirectoryObservation = { pathParts: parts, exists: false, mode: null, entries: [] };
    this.directories.set(key, observation);
    this.directoryInventory.push(observation);
    try {
      const target = await this.confined(parts);
      const before = await lstat(target);
      if (!before.isDirectory()) throw new ApplicationInspectionError(`${key || '.'}: expected a regular directory.`);
      if ((before.mode & 0o7000) !== 0) throw new ApplicationInspectionError(`${key || '.'}: special directory modes are unsupported.`);
      observation.exists = true;
      observation.mode = before.mode & 0o7777;
      const directory = await opendir(target);
      for await (const entry of directory) {
        if (observation.entries.length >= applicationBounds.directoryEntries) {
          throw new ApplicationInspectionError(`${key || '.'}: directory exceeds the entry bound.`);
        }
        applicationParts([entry.name]);
        observation.entries.push({ name: entry.name, kind: entryKind(entry) });
      }
      observation.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const aliases = new Set<string>();
      for (const entry of observation.entries) {
        const folded = applicationPathFold(entry.name);
        if (aliases.has(folded)) throw new ApplicationInspectionError(`${key || '.'}: case or normalization aliases are unsupported.`);
        aliases.add(folded);
      }
      const after = await lstat(await this.confined(parts));
      if (stamp(before) !== stamp(after)) throw new ApplicationInspectionError(`${key || '.'}: directory changed during inspection.`);
      this.stamps.set(key, stamp(after));
    } catch (error) {
      if (!missing(error)) throw error;
      if (observation.exists) throw new ApplicationInspectionError(`${key || '.'}: directory disappeared during inspection.`);
    }
    return observation;
  }

  async observeParents(input: readonly string[]): Promise<void> {
    const parts = applicationParts(input);
    for (let index = 0; index < parts.length; index++) {
      const parent = await this.inventory(parts.slice(0, index));
      const folded = applicationPathFold(parts[index]!);
      const entry = parent.entries.find((item) => applicationPathFold(item.name) === folded);
      if (entry && entry.name !== parts[index]) {
        throw new ApplicationInspectionError(`${parts.join('/')}: destination aliases an existing case-normalized path.`);
      }
      if (entry && (entry.kind === 'symlink' || entry.kind === 'other' ||
          index < parts.length - 1 && entry.kind !== 'directory')) {
        throw new ApplicationInspectionError(`${parts.join('/')}: unsafe link, junction, or non-directory parent.`);
      }
    }
  }

  async read(input: readonly string[], limit: number = applicationBounds.fileBytes): Promise<ProjectFileSnapshot> {
    const parts = applicationParts(input);
    const key = applicationPathKey(parts);
    if (this.exclude(parts)) throw new ApplicationInspectionError(`${key}: excluded application files cannot be read or mapped.`);
    const previous = this.snapshots.get(key);
    if (previous) return previous;
    if (this.snapshots.size >= applicationBounds.files) {
      throw new ApplicationInspectionError('Application inventory exceeds the file count bound.');
    }
    await this.observeParents(parts);
    const snapshot: ProjectFileSnapshot = { pathParts: parts };
    this.snapshots.set(key, snapshot);
    let observedPresent = false;
    try {
      const target = await this.confined(parts);
      const before = await lstat(target);
      observedPresent = true;
      if (!before.isFile() || before.nlink !== 1) {
        throw new ApplicationInspectionError(`${key}: only singly linked regular files can be inspected.`);
      }
      if ((before.mode & 0o7000) !== 0) throw new ApplicationInspectionError(`${key}: special file modes are unsupported.`);
      if (before.size > limit || this.totalBytes + before.size > applicationBounds.totalBytes) {
        throw new ApplicationInspectionError(`${key}: application file or total byte bound exceeded.`);
      }
      const observed = await readObservedFile(target, {
        maximumBytes: limit, expected: before,
        assertPathCurrent: () => this.confined(parts)
      });
      snapshot.content = observed.content;
      snapshot.mode = before.mode & 0o7777;
      this.totalBytes += observed.content.length;
      this.stamps.set(key, stamp(observed.metadata));
    } catch (error) {
      if (error instanceof ObservedFileError) throw new ApplicationInspectionError(`${key}: ${error.message}`);
      if (!missing(error)) throw error;
      if (observedPresent) throw new ApplicationInspectionError(`${key}: file disappeared during inspection.`);
    }
    return snapshot;
  }

  async walk(parts: string[] = []): Promise<void> {
    const directory = await this.inventory(parts);
    for (const entry of directory.entries) {
      const child = [...parts, entry.name];
      const reason = this.exclude(child);
      if (reason) {
        this.exclusions.push({ pathParts: child, kind: entry.kind, reason });
        continue;
      }
      applicationParts(child);
      if (entry.kind === 'directory') await this.walk(child);
      else if (entry.kind === 'file') await this.read(child);
      else throw new ApplicationInspectionError(`${child.join('/')}: unsafe link or non-regular file blocks complete inventory.`);
    }
  }

  async assertUnchanged(): Promise<void> {
    for (const [key, observed] of this.stamps) {
      const parts = key === '' ? [] : key.split('/');
      let details: Stats;
      try { details = await lstat(await this.confined(parts)); }
      catch { throw new ApplicationInspectionError('Application scope changed during bounded inspection.'); }
      if (stamp(details) !== observed) throw new ApplicationInspectionError('Application scope changed during bounded inspection.');
    }
    for (const observation of this.directoryInventory.filter((item) => !item.exists)) {
      try {
        await lstat(await this.confined(observation.pathParts));
        throw new ApplicationInspectionError('An absent application directory appeared during inspection.');
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.content !== undefined) continue;
      try {
        await lstat(await this.confined(snapshot.pathParts));
        throw new ApplicationInspectionError('An absent application destination appeared during inspection.');
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
}
