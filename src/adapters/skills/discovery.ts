import { constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  SUPPORTED_SKILL_HOSTS,
  type CanonicalSkillId,
  type SkillDirectoryObservation,
  type SkillFileObservation,
  type SkillHostId,
  type SkillScope
} from '../../domain/skills/contracts.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import type { ProjectFileSnapshot } from '../filesystem/project-transaction.js';
import { resolveSkillPathParts } from './host-projections.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 16_384;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

const fold = (value: string): string => value.normalize('NFC').toLowerCase();
const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
const usableIdentity = (details: Stats): boolean =>
  Number.isSafeInteger(details.dev) && details.dev >= 0 && Number.isSafeInteger(details.ino) && details.ino > 0;

export function validateSkillPathParts(value: unknown): string[] {
  const parts = validateArtifactPathParts(value, 'Skill path');
  if (parts.length > 64 || parts.join('/').length > 2048 || parts.some((part) =>
    part.length > 255 || /[<>:"|?*\u0000-\u001f\u007f]/u.test(part) ||
    /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new Error('Skill path contains an unsafe or nonportable component.');
  }
  return parts;
}

export async function canonicalSkillRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !root || /[\u0000-\u001f\u007f]/u.test(root)) {
    throw new Error('Skill target must be a nonempty native directory path.');
  }
  const resolved = path.resolve(root);
  if (process.platform === 'win32' &&
      (!/^[a-z]:\\$/iu.test(path.parse(resolved).root) &&
       !/^\\\\[^\\]+\\[^\\]+\\$/u.test(path.parse(resolved).root) ||
       resolved.startsWith('\\\\?\\') || resolved.startsWith('\\\\.\\'))) {
    throw new Error('Skill target requires an unambiguous Windows drive or UNC share.');
  }
  const before = await lstat(resolved);
  if (!before.isDirectory() || before.isSymbolicLink() || !usableIdentity(before)) {
    throw new Error('Skill target must have a stable directory identity, not an unsupported filesystem, symlink, or junction.');
  }
  const canonical = await realpath(resolved);
  const after = await lstat(resolved);
  if (canonical !== resolved || !sameIdentity(before, after) || after.isSymbolicLink()) {
    throw new Error('Skill target has a changed, linked, case, or normalization alias; use its exact canonical directory.');
  }
  return canonical;
}

export interface HostDiscoveryRoots {
  host: SkillHostId;
  scope: SkillScope;
  discoveryRoot: string;
  relativeDiscoveryRoot: string;
}

export function resolveHostDiscoveryRoot(host: SkillHostId, scope: SkillScope, baseDir: string): HostDiscoveryRoots {
  if (!SUPPORTED_SKILL_HOSTS.includes(host) || !['user', 'project'].includes(scope)) {
    throw new Error('Unknown skill host or scope.');
  }
  const relativeDiscoveryRoot = host === 'claude' ? '.claude/commands'
    : host === 'github-copilot' && scope === 'project' ? '.github/skills' : '.agents/skills';
  return {
    host, scope, relativeDiscoveryRoot,
    discoveryRoot: path.join(path.resolve(baseDir), ...relativeDiscoveryRoot.split('/'))
  };
}

export function skillDiscoveryPathParts(
  skillId: CanonicalSkillId, host: SkillHostId, scope: SkillScope
): readonly (readonly string[])[] {
  const primary = resolveSkillPathParts(skillId, host, scope);
  const roots = host === 'github-copilot'
    ? scope === 'project' ? ['.github', '.claude', '.agents'] : ['.copilot', '.agents']
    : host === 'claude' ? ['.claude'] : ['.agents'];
  const candidates = [primary, ...roots.map((root) => [root, 'skills', `liftoff-${skillId}`, 'SKILL.md'])];
  return [...new Map(candidates.map((parts) => [parts.join('/'), parts])).values()];
}

export function detectOverlappingPersonalRoots(selectedHosts: readonly SkillHostId[]): string[] {
  const copilot = selectedHosts.includes('github-copilot');
  const codex = selectedHosts.includes('codex');
  if (copilot && codex) {
    return ['Copilot and Codex share the personal discovery root (~/.agents/skills). One physical projection records both selected consumers; this is not native-host qualification evidence.'];
  }
  if (copilot) {
    return ['Personal Copilot skills use ~/.agents/skills, shared with Codex. Codex may also discover these files; its settings and consumer selection are not changed.'];
  }
  if (codex) {
    return ['Personal Codex skills use ~/.agents/skills, shared with Copilot. Copilot may also discover these files; its settings and consumer selection are not changed.'];
  }
  return [];
}

export function isPathConfined(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directoryNames(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  if (names.length > MAX_DIRECTORY_ENTRIES) throw new Error(`Skill directory exceeds the bounded inventory limit: ${directory}`);
  return names;
}

export async function assertSafeSkillPath(root: string, value: readonly string[]): Promise<string> {
  const parts = validateSkillPathParts(value);
  const canonical = await canonicalSkillRoot(root);
  const target = path.join(canonical, ...parts);
  if (!isPathConfined(canonical, target) || target === canonical) throw new Error('Skill path escapes its target boundary.');
  let current = canonical;
  for (const [index, part] of parts.entries()) {
    let names: string[];
    try { names = await directoryNames(current); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') return target;
      throw error;
    }
    const aliases = names.filter((name) => fold(name) === fold(part));
    if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== part) {
      throw new Error(`Case or Unicode normalization collision at ${parts.slice(0, index + 1).join('/')}.`);
    }
    current = path.join(current, part);
    let details: Stats;
    try { details = await lstat(current); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') return target;
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error(`Skill path traverses a symlink or junction: ${parts.slice(0, index + 1).join('/')}`);
    if (index < parts.length - 1 && !details.isDirectory()) throw new Error(`Skill path parent is not a directory: ${current}`);
    if (index === parts.length - 1 && details.isFile() && details.nlink !== 1) {
      throw new Error(`Skill file has multiple hard-link identities: ${current}`);
    }
    if (await realpath(current) !== current) throw new Error(`Skill path has a noncanonical alias: ${current}`);
  }
  return target;
}

export interface CapturedSkillFile {
  observation: SkillFileObservation;
  snapshot: ProjectFileSnapshot;
}

export async function captureSkillFile(root: string, value: readonly string[]): Promise<CapturedSkillFile> {
  const parts = validateSkillPathParts(value);
  const target = await assertSafeSkillPath(root, parts);
  let before: Stats;
  try { before = await lstat(target); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { observation: { pathParts: parts, state: 'absent' }, snapshot: { pathParts: parts } };
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || !usableIdentity(before) || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    throw new Error(`Skill input must be a bounded single-link regular file: ${parts.join('/')}`);
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size > MAX_FILE_BYTES) {
      throw new Error(`Skill input identity changed while opening: ${parts.join('/')}`);
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const content = buffer.subarray(0, length);
    const after = await lstat(await assertSafeSkillPath(root, parts));
    const final = await handle.stat();
    if (!sameIdentity(opened, after) || !sameIdentity(opened, final) || after.nlink !== 1 ||
        length !== opened.size || after.size !== opened.size || final.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Skill input changed while reading: ${parts.join('/')}`);
    }
    return {
      observation: {
        pathParts: parts, state: 'file', contentHash: createHash('sha256').update(content).digest('hex'), mode: opened.mode & 0o7777,
        device: opened.dev, inode: opened.ino, size: content.length
      },
      snapshot: { pathParts: parts, content, mode: opened.mode & 0o7777 }
    };
  } finally { await handle.close(); }
}

export async function captureSkillDirectories(
  root: string, files: readonly (readonly string[])[], excludedFiles: readonly (readonly string[])[] = []
): Promise<SkillDirectoryObservation[]> {
  const paths = new Map<string, string[]>([['', []]]);
  const rootEntries = new Set(files.map((parts) => fold(parts[0])));
  for (const value of files) {
    const parts = validateSkillPathParts(value);
    for (let count = 1; count < parts.length; count += 1) {
      paths.set(parts.slice(0, count).join('/'), parts.slice(0, count));
    }
  }
  const result: SkillDirectoryObservation[] = [];
  for (const [key, parts] of [...paths].sort(([left], [right]) => left.localeCompare(right))) {
    const target = parts.length ? await assertSafeSkillPath(root, parts) : await canonicalSkillRoot(root);
    let before: Stats;
    try { before = await lstat(target); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') {
        result.push({ pathParts: parts, state: 'absent' });
        continue;
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink() || !usableIdentity(before)) throw new Error(`Skill parent lacks a stable directory identity: ${key}`);
    const excluded = new Set(excludedFiles.map((entry) => entry.join('/')));
    const entries = (await directoryNames(target)).filter((entry) =>
      (parts.length > 0 || rootEntries.has(fold(entry))) && !excluded.has([...parts, entry].join('/')));
    const after = await lstat(target);
    if (!sameIdentity(before, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        after.isSymbolicLink() || await realpath(target) !== target) {
      throw new Error(`Skill directory changed while reading: ${key}`);
    }
    result.push({
      pathParts: parts, state: 'directory', mode: after.mode & 0o7777,
      device: after.dev, inode: after.ino, entriesDigest: canonicalSha256(entries.sort())
    });
  }
  return result;
}

export async function captureSkillDirectoryIdentity(
  root: string, parts: readonly string[]
): Promise<SkillDirectoryObservation> {
  const target = parts.length ? await assertSafeSkillPath(root, parts) : await canonicalSkillRoot(root);
  let details: Stats;
  try { details = await lstat(target); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { pathParts: [...parts], state: 'absent' };
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink() || !usableIdentity(details)) {
    throw new Error(`Skill parent lacks a stable directory identity: ${parts.join('/')}`);
  }
  return {
    pathParts: [...parts], state: 'directory', device: details.dev, inode: details.ino, mode: details.mode & 0o7777
  };
}

export async function assertSkillDirectoryIdentities(root: string, expected: readonly SkillDirectoryObservation[]): Promise<void> {
  await canonicalSkillRoot(root);
  for (const directory of expected) {
    if (directory.state === 'absent') continue;
    const target = directory.pathParts.length ? await assertSafeSkillPath(root, directory.pathParts) : root;
    const current = await lstat(target);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.device ||
        current.ino !== directory.inode || (current.mode & 0o7777) !== directory.mode) {
      throw new Error(`Skill directory identity changed after review: ${directory.pathParts.join('/') || '.'}`);
    }
  }
}

export async function detectSkillShadowing(
  projectRoot: string, userHome: string, skillId: CanonicalSkillId, host: SkillHostId
): Promise<{ shadows: boolean; projectPath: string; personalPath: string } | undefined> {
  const projectParts = resolveSkillPathParts(skillId, host, 'project');
  const personalParts = resolveSkillPathParts(skillId, host, 'user');
  const project = await captureSkillFile(projectRoot, projectParts);
  const personal = await captureSkillFile(userHome, personalParts);
  return project.observation.state === 'file' && personal.observation.state === 'file' ? {
    shadows: true,
    projectPath: path.join(projectRoot, ...projectParts),
    personalPath: path.join(userHome, ...personalParts)
  } : undefined;
}
