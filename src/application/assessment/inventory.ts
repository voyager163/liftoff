import { TextDecoder } from 'node:util';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { goDependencyNames, nodeDependencyNames, pythonDependencyNames } from '../../domain/migration/dependencies.js';
import { projectDependencyDialect, projectInventoryExclusion, projectInventoryRoles } from '../../domain/assessment/inventory.js';
import {
  ApplicationFiles, ApplicationInspectionError, ApplicationInventoryLimitError,
  applicationDigest, applicationParts, applicationPathFold, applicationPathKey,
  assertApplicationNoLinkAncestors, canonicalApplicationRoot
} from '../repair/application-files.js';
import type { ApplicationDirectoryObservation } from '../repair/application-types.js';
import { projectInventoryBounds, type ProjectDependencyObservation, type ProjectInventory } from './inventory-types.js';

const comparePaths = (left: { pathParts: string[] }, right: { pathParts: string[] }): number => {
  const a = applicationPathKey(left.pathParts), b = applicationPathKey(right.pathParts);
  return a < b ? -1 : a > b ? 1 : 0;
};

function marker(directory: ApplicationDirectoryObservation, name: string): 'file-marker' | 'directory-marker' | 'absent' {
  const entry = directory.entries.find(item => applicationPathFold(item.name) === name);
  if (!entry) return 'absent';
  if (entry.name !== name || entry.kind !== 'file' && (name !== '.git' || entry.kind !== 'directory')) {
    throw new ApplicationInspectionError(`${[...directory.pathParts, entry.name].join('/')}: unsafe or aliased project boundary.`);
  }
  return entry.kind === 'file' ? 'file-marker' : 'directory-marker';
}

function dependencyNames(dialect: ProjectDependencyObservation['dialect'], filename: string, bytes: Buffer) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { names: [], diagnostic: 'Dependency metadata is not valid UTF-8; no dependency evidence was inferred.' };
  }
  if (text.includes('\0')) return { names: [], diagnostic: 'Dependency metadata contains binary data; no dependency evidence was inferred.' };
  if (dialect === 'python' && filename === 'requirements.txt' &&
      text.split(/\r?\n/u).some(line => /^\s*-/u.test(line) || /\\\s*$/u.test(line))) {
    return { names: [], diagnostic: 'Indirect requirement files, installer options or continued declarations require explicit reconciliation; they are not followed or executed.' };
  }
  const result = dialect === 'node' ? nodeDependencyNames(text) : dialect === 'python'
    ? pythonDependencyNames(filename, text) : { names: goDependencyNames(text) };
  const names = [...new Set(result.names)].sort();
  if (names.some(name => name.length > 255 || !/^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u.test(name))) {
    return { names: [], diagnostic: 'Dependency names exceed portable static metadata syntax; no names were inferred.' };
  }
  return result.diagnostic ? { names: [], diagnostic: result.diagnostic } : { names, diagnostic: null };
}

export async function inspectProjectInventory(input: string): Promise<ProjectInventory> {
  await assertApplicationNoLinkAncestors(path.resolve(input), 'Project inventory root');
  const root = await canonicalApplicationRoot(input);
  const reader = new ApplicationFiles(root, parts => projectInventoryExclusion(parts));
  const report: ProjectInventory = {
    schemaVersion: 1, kind: 'liftoff-project-inventory', readOnly: true, projectRoot: root,
    rootMarkers: { git: 'not-observed', liftoff: 'not-observed' }, complete: true, inspectionDigest: '',
    entries: [], directories: [], dependencies: [], exclusions: [],
    coverage: {
      metadata: 'bounded-selected-root', dependencyContents: 'bounded-static-name-extraction',
      applicationContents: 'not-observed', references: 'not-observed', limits: []
    },
    limitations: [
      'Presence and extracted dependency names are observations, not syntax validation, installed versions, active bindings, runtime behavior, compliance, ownership or write authority.',
      'Only bounded dependency declarations are read. Application, lock, framework, agent, CI, infrastructure and documentation payloads are not read or executed.',
      'Excluded credentials, state, dependency and output trees and nested projects remain unobserved. Metadata traversal stops at the first limit; all later scopes remain unobserved. Git markers are not resolved or executed; a worktree pointer is not followed.',
      'Directory membership and read declarations are revalidated; unread payload changes and dynamic references are not observed. No outer-root fallback or global project discovery occurs.'
    ],
    bounds: projectInventoryBounds
  };
  let entries = 0, files = 0;
  const limit = (pathParts: string[], bound: keyof typeof projectInventoryBounds) => {
    report.complete = false;
    report.coverage.limits.push({ pathParts: [...pathParts], bound });
  };
  const visit = async (parts: string[]): Promise<boolean> => {
    let directory: ApplicationDirectoryObservation;
    try {
      directory = await reader.inventory(parts, Math.min(
        projectInventoryBounds.directoryEntries, projectInventoryBounds.entries - entries));
    }
    catch (error) {
      if (!(error instanceof ApplicationInventoryLimitError)) throw error;
      limit(parts, error.limit);
      return false;
    }
    if (!directory.exists) throw new ApplicationInspectionError('Selected project directory disappeared during inventory.');
    entries += directory.entries.length;
    const git = marker(directory, '.git'), liftoff = marker(directory, 'liftoff.manifest.json');
    if (!parts.length) {
      report.rootMarkers = { git, liftoff: liftoff === 'file-marker' ? 'file-marker' : 'absent' };
    } else if (git !== 'absent' || liftoff !== 'absent') {
      report.exclusions.push({ pathParts: [...parts], kind: 'directory', reason: 'nested-project' });
      return true;
    }
    report.directories.push({ pathParts: [...parts], entries: directory.entries.length, mode: directory.mode! });
    for (const entry of directory.entries) {
      const child = [...parts, entry.name];
      const reason = projectInventoryExclusion(child);
      if (reason) {
        report.exclusions.push({ pathParts: child, kind: entry.kind, reason });
        continue;
      }
      if (child.length > projectInventoryBounds.depth ||
          Buffer.byteLength(applicationPathKey(child)) > projectInventoryBounds.pathBytes) {
        limit(child, child.length > projectInventoryBounds.depth ? 'depth' : 'pathBytes');
        return false;
      }
      applicationParts(child);
      if (entry.kind !== 'file' && entry.kind !== 'directory') {
        throw new ApplicationInspectionError(`${applicationPathKey(child)}: unsafe link, junction or non-regular inventory entry.`);
      }
      if (entry.kind === 'file' && files >= projectInventoryBounds.files) { limit(child, 'files'); return false; }
      if (entry.kind === 'file') files++;
      report.entries.push({ pathParts: child, kind: entry.kind, roles: projectInventoryRoles(child, entry.kind === 'directory') });
      if (entry.kind === 'directory' && !await visit(child)) return false;
    }
    return true;
  };
  await visit([]);
  for (const entry of report.entries.filter(entry => entry.kind === 'file').sort(comparePaths)) {
    const dialect = projectDependencyDialect(entry.pathParts);
    if (!dialect) continue;
    const observation: ProjectDependencyObservation = {
      pathParts: [...entry.pathParts], dialect, availability: 'not-observed',
      names: [], digest: null, bytes: null, mode: null, diagnostic: null
    };
    report.dependencies.push(observation);
    try {
      const snapshot = await reader.read(entry.pathParts);
      if (!snapshot.content) throw new ApplicationInspectionError('A dependency declaration disappeared during inventory.');
      observation.digest = applicationDigest(snapshot.content);
      observation.bytes = snapshot.content.length;
      observation.mode = snapshot.mode!;
      const parsed = dependencyNames(dialect, applicationPathFold(entry.pathParts.at(-1)!), snapshot.content);
      if (parsed.names.length > projectInventoryBounds.dependencyNames) {
        limit(entry.pathParts, 'dependencyNames');
        observation.diagnostic = 'Dependency name count exceeds the bounded extraction scope.';
      } else {
        observation.names = parsed.names;
        observation.diagnostic = parsed.diagnostic;
        observation.availability = parsed.diagnostic ? 'uninterpretable' : 'observed';
        if (parsed.diagnostic) report.complete = false;
      }
    } catch (error) {
      if (!(error instanceof ApplicationInventoryLimitError)) throw error;
      reader.snapshots.delete(applicationPathKey(entry.pathParts));
      limit(entry.pathParts, error.limit);
      observation.diagnostic = 'Dependency contents exceed the bounded read scope.';
    }
  }
  await reader.assertUnchanged();
  report.entries.sort(comparePaths);
  report.directories.sort(comparePaths);
  report.exclusions.sort(comparePaths);
  report.coverage.limits.sort(comparePaths);
  const { inspectionDigest: _, ...body } = report;
  report.inspectionDigest = canonicalSha256(body);
  return report;
}
