import { lstat, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { assertBoundProjectPath, readBoundProjectFileSnapshot } from '../adapters/filesystem/bound-project-files.js';
import { errorCode } from '../adapters/filesystem/errors.js';
import type { ProjectFileSnapshot } from '../adapters/filesystem/project-transaction.js';
import { historyCaseKey, historyPathKey, historyFail, historyPathParts, historyExact, rawHistoryDigest } from './history-contracts.js';
import { assertModernRecordData } from '../domain/governance/activation/source-values.js';

const maximumRawBytes = 32 * 1024 * 1024;
export const maximumSourceHistoryFiles = 1024;
const maximumFiles = maximumSourceHistoryFiles;
const maximumFileBytes = 8 * 1024 * 1024;

/** Capture own-data JSON synchronously; no caller references survive a later Promise yield. */
export function copySourceHistoryData<T>(value: T, label: string): T {
  assertModernRecordData(value, label);
  let nodes = 0;
  function count(entry: unknown): void {
    if (++nodes > 200_000 || typeof entry === 'string' && Buffer.byteLength(entry, 'utf8') > maximumFileBytes) {
      historyFail(label, 'exceeds the bounded control-metadata node or string size.', 'history-inspection-limit');
    }
    if (entry !== null && typeof entry === 'object') {
      for (const [key, child] of Object.entries(entry)) {
        if (!Array.isArray(entry)) count(key);
        count(child);
      }
    }
  }
  count(value);
  return structuredClone(value);
}

export function copySourceHistoryPath(value: readonly string[], label: string): string[] {
  assertModernRecordData(value, label);
  const parts = historyPathParts(value, label);
  if (parts.length > 64 || historyPathKey(parts).length > 2048 || parts.some(part => part.length > 255)) {
    historyFail(label, 'exceeds the portable path bound.', 'unsafe-history-path');
  }
  return parts;
}

export function copySourceInventoryOptions(value: { reviewedUnreferencedPathParts?: readonly (readonly string[])[] }) {
  assertModernRecordData(value, 'source options');
  const options = historyExact(value, [], 'source options', ['reviewedUnreferencedPathParts']);
  if (!Object.hasOwn(options, 'reviewedUnreferencedPathParts')) return {};
  if (!Array.isArray(value.reviewedUnreferencedPathParts) || value.reviewedUnreferencedPathParts.length > maximumFiles) {
    historyFail('source options', 'requires at most 1024 explicitly reviewed records.', 'history-inspection-limit');
  }
  return { reviewedUnreferencedPathParts: value.reviewedUnreferencedPathParts.map(parts =>
    copySourceHistoryPath(parts, 'reviewed source path')) };
}

export function copyHistoryBuffer(value: unknown, label: string): Buffer {
  if (!Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Buffer.prototype ||
    ['length', 'byteLength', 'byteOffset', 'buffer', 'valueOf', 'toString', 'toJSON'].some(key => Object.hasOwn(value, key)) ||
    Object.getOwnPropertySymbols(value).length) historyFail(label, 'requires an original plain buffer without hooks.');
  if (value.length > maximumFileBytes) historyFail(label, 'exceeds the 8MiB file limit.', 'history-inspection-limit');
  return Buffer.from(value);
}

export async function createSourceHistoryCapture(projectRoot: string) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) ||
    path.normalize(projectRoot) !== projectRoot || /[\u0000-\u001f\u007f]/u.test(projectRoot)) {
    historyFail('history project root', 'must be an absolute normalized directory path.', 'unsafe-history-path');
  }
  const originalRoot = await lstat(projectRoot);
  if (!originalRoot.isDirectory() || originalRoot.isSymbolicLink()) {
    historyFail('history project root', 'must be a real nonlink directory.', 'unsafe-history-path');
  }
  const root = await realpath(projectRoot);
  async function assertRoot(): Promise<void> {
    const selected = await lstat(projectRoot);
    const canonical = await lstat(root);
    if (!selected.isDirectory() || selected.isSymbolicLink() || !canonical.isDirectory() || canonical.isSymbolicLink() ||
      selected.dev !== originalRoot.dev || selected.ino !== originalRoot.ino || selected.mode !== originalRoot.mode ||
      canonical.dev !== originalRoot.dev || canonical.ino !== originalRoot.ino || canonical.mode !== originalRoot.mode ||
      await realpath(projectRoot) !== root) {
      historyFail('history project root', 'changed during frozen-source inspection.', 'historical-source-changed');
    }
  }
  await assertRoot();
  const captures = new Map<string, ProjectFileSnapshot & { content: Buffer; mode: number }>();
  const absent = new Map<string, ProjectFileSnapshot>();
  let totalBytes = 0;
  function capture(parts: readonly string[]): Promise<ProjectFileSnapshot & { content: Buffer; mode: number }>;
  function capture(parts: readonly string[], optional: true): Promise<ProjectFileSnapshot>;
  async function capture(parts: readonly string[], optional = false): Promise<ProjectFileSnapshot> {
    parts = copySourceHistoryPath(parts, 'source capture path');
    const key = historyCaseKey(parts);
    const previous = captures.get(key);
    if (previous) {
      if (historyPathKey(previous.pathParts) !== historyPathKey(parts)) {
        historyFail('frozen history', 'contains aliased capture paths.', 'history-path-collision');
      }
      return previous;
    }
    if (optional) {
      await assertRoot();
      await assertBoundProjectPath(root, parts, {
        pathLabel: 'Source observation', invalid(detail): never { return historyFail(historyPathKey(parts), detail, 'unsafe-history-path'); }
      });
      try { await lstat(path.join(root, ...parts)); }
      catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await assertRoot();
        const missing = { pathParts: [...parts] };
        absent.set(key, missing);
        return missing;
      }
    }
    if (captures.size >= maximumFiles || totalBytes >= maximumRawBytes) {
      historyFail(historyPathKey(parts), 'frozen-source inspection exceeds 1024 files or 33554432 raw bytes.', 'history-inspection-limit');
    }
    await assertRoot();
    const snapshot = await readBoundProjectFileSnapshot(root, parts, {
      maximumBytes: Math.min(maximumFileBytes, maximumRawBytes - totalBytes),
      linkPolicy: 'single-link',
      diagnostics: {
        pathLabel: 'Frozen history file',
        invalid(detail): never { return historyFail(historyPathKey(parts), detail, 'invalid-frozen-history-file'); }
      }
    });
    await assertRoot();
    if (snapshot.content === undefined || snapshot.mode === undefined) {
      if (optional && snapshot.content === undefined && snapshot.mode === undefined) {
        const missing = { pathParts: [...snapshot.pathParts] };
        absent.set(key, missing);
        return missing;
      }
      historyFail(historyPathKey(parts), 'declared frozen history is missing.', 'missing-historical-record');
    }
    totalBytes += snapshot.content.length;
    const retained = { pathParts: [...snapshot.pathParts], content: snapshot.content, mode: snapshot.mode };
    captures.set(key, retained);
    return retained;
  }
  async function recordPaths(directory: 'evidence' | 'plans' | 'approvals' | 'supersessions' | 'reconciliation'): Promise<string[][]> {
    if (!['evidence', 'plans', 'approvals', 'supersessions', 'reconciliation'].includes(directory)) {
      historyFail('source collection', 'has no declared source inventory.', 'unregistered-history-source');
    }
    await assertRoot();
    const parts = ['governance', directory];
    await assertBoundProjectPath(root, parts, {
      pathLabel: 'Source collection', invalid(detail): never { return historyFail(parts.join('/'), detail, 'unsafe-history-path'); }
    });
    let entries: Dirent[];
    try { entries = await readdir(path.join(root, ...parts), { withFileTypes: true }); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; entries = []; }
    await assertRoot();
    const records = entries.filter(entry => /\.json$/iu.test(entry.name)).map(entry => [...parts, entry.name]);
    if (records.length > maximumFiles) historyFail(parts.join('/'), 'exceeds the 1024 file source limit.', 'history-inspection-limit');
    return records.sort((a, b) => historyPathKey(a) < historyPathKey(b) ? -1 : 1);
  }
  async function assertAbsentDirectory(parts: readonly string[]): Promise<void> {
    parts = copySourceHistoryPath(parts, 'source destination path');
    await assertRoot();
    await assertBoundProjectPath(root, parts, {
      pathLabel: 'Source destination', invalid(detail): never { return historyFail(parts.join('/'), detail, 'unsafe-history-path'); }
    });
    try {
      await lstat(path.join(root, ...parts));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await assertRoot();
      return;
    }
    historyFail(parts.join('/'), 'unindexed snapshot destination already exists.', 'incomplete-history-snapshot');
  }
  function observations(): ProjectFileSnapshot[] {
    return [...captures.values(), ...[...absent.entries()].filter(([key]) => !captures.has(key)).map(([, value]) => value)]
      .map(value => ({ pathParts: [...value.pathParts], ...(value.content === undefined ? {} : { content: Buffer.from(value.content), mode: value.mode }) }));
  }
  return { root, assertRoot, capture, captures, recordPaths, assertAbsentDirectory, observations };
}

/** Validate and copy observations without running getters or treating embedded digests as storage proof. */
export function copySourceHistoryObservations(value: readonly ProjectFileSnapshot[]): ProjectFileSnapshot[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1 || value.length > 3 * maximumFiles) {
    historyFail('source observations', 'requires a finite dense observation list.', 'invalid-historical-reference');
  }
  const seen = new Set<string>();
  let bytes = 0, present = 0;
  const copies: ProjectFileSnapshot[] = [];
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) historyFail('source observations', 'cannot contain accessors or holes.');
    const entry: unknown = property.value;
    if (typeof entry !== 'object' || entry === null || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      historyFail('source observation', 'must be a plain data object.');
    }
    const fields = Object.getOwnPropertyDescriptors(entry);
    if (Reflect.ownKeys(entry).some(key => typeof key !== 'string' || !['pathParts', 'content', 'mode'].includes(key) ||
      !fields[key]?.enumerable || !Object.hasOwn(fields[key], 'value'))) historyFail('source observation', 'contains unsupported fields or hooks.');
    const parts: unknown = fields.pathParts?.value;
    assertModernRecordData(parts, 'source observation path');
    const pathParts = historyPathParts(parts, 'source observation path'), key = historyCaseKey(pathParts);
    if (seen.has(key)) historyFail(key, 'duplicate or aliased source observations.', 'history-path-collision');
    seen.add(key);
    const content: unknown = fields.content?.value, mode: unknown = fields.mode?.value;
    if (content === undefined) {
      if (mode !== undefined || Object.hasOwn(fields, 'content') || Object.hasOwn(fields, 'mode')) historyFail(key, 'absent observations cannot claim content or permissions.');
      copies.push({ pathParts }); continue;
    }
    if (!Buffer.isBuffer(content) || Object.getPrototypeOf(content) !== Buffer.prototype ||
      typeof mode !== 'number' || !Number.isInteger(mode) || Object.is(mode, -0) || mode < 0 || mode > 0o7777) {
      historyFail(key, 'requires actual buffer bytes and original permissions.');
    }
    const retained = copyHistoryBuffer(content, key);
    present++;
    bytes += retained.length;
    if (content.length > maximumFileBytes || bytes > maximumRawBytes || present > maximumFiles) {
      historyFail(key, 'source observations exceed 8MiB/file, 32MiB raw bytes or 1024 files.', 'history-inspection-limit');
    }
    copies.push({ pathParts, content: retained, mode });
  }
  return copies;
}

export function sourceObservationIdentities(captures: readonly ProjectFileSnapshot[]) {
  return copySourceHistoryObservations(captures).map(file => ({
    pathParts: file.pathParts, digest: file.content === undefined ? null : rawHistoryDigest(file.content), mode: file.mode ?? null
  })).sort((a, b) => historyPathKey(a.pathParts) < historyPathKey(b.pathParts) ? -1 : 1);
}
