import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FileSystemError } from '../../domain/project/errors.js';
import { isRecord } from '../../domain/project/manifest/fields.js';
import { createFileAtomically, replaceFileAtomically } from './atomic-write.js';
import { readBoundProjectFileSnapshot } from './bound-project-files.js';
import { errorCode } from './errors.js';
import { applyProjectFileTransaction, type ProjectFileSnapshot } from './project-transaction.js';
import {
  parseProjectTelemetryRecord, projectConsentBindings, projectTelemetryRecordPath,
  updateProjectConsent, type ProjectTelemetryRecord
} from '../../domain/project/telemetry-consent.js';

export function telemetrySnapshotIdentity(file: ProjectFileSnapshot) {
  return {
    digest: file.content === undefined ? null : createHash('sha256').update(file.content).digest('hex'),
    mode: file.mode ?? null
  };
}

export function telemetryJson(content: Buffer, label: string): unknown {
  try { return JSON.parse(content.toString('utf8')) as unknown; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new FileSystemError(`${label} contains invalid JSON; no raw contents were disclosed.`);
  }
}

export async function readTelemetryFile(root: string, parts: readonly string[], maximumBytes = 1024 * 1024) {
  return readBoundProjectFileSnapshot(root, parts, {
    maximumBytes, linkPolicy: 'single-link',
    diagnostics: { pathLabel: 'Project telemetry', invalid: detail => { throw new FileSystemError(detail); } }
  });
}

export async function telemetryRoot(input: string): Promise<{ root: string; physical: string }> {
  const root = await realpath(path.resolve(input)), stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileSystemError('Telemetry requires an exact regular project directory.');
  return { root, physical: `${stat.dev}:${stat.ino}` };
}

export interface TelemetryConsentConfig {
  path: string;
  anchor: string;
  parts: string[];
  snapshot: ProjectFileSnapshot;
  config: Record<string, unknown>;
}

export async function readTelemetryConsentConfig(configPath: string): Promise<TelemetryConsentConfig> {
  if (!path.isAbsolute(configPath)) throw new FileSystemError('Telemetry configuration must use an absolute external path.');
  const target = path.resolve(configPath);
  let anchor = path.dirname(target);
  const parts = [path.basename(target)];
  while (true) {
    try {
      const stat = await lstat(anchor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileSystemError('Telemetry configuration parent is unsafe.');
      const canonical = await realpath(anchor);
      const snapshot = await readTelemetryFile(canonical, parts);
      const config: unknown = snapshot.content === undefined ? {} : telemetryJson(snapshot.content, 'Telemetry configuration');
      if (!isRecord(config)) throw new FileSystemError('Telemetry configuration must be a JSON object.');
      const bindings = projectConsentBindings(config);
      if (bindings.some(binding => !path.isAbsolute(binding.projectRoot) || path.normalize(binding.projectRoot) !== binding.projectRoot)) {
        throw new FileSystemError('Local consent contains a noncanonical project root.');
      }
      return { path: path.join(canonical, ...parts), anchor: canonical, parts, snapshot, config };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(anchor);
      if (parent === anchor) throw new FileSystemError('No safe external telemetry configuration parent is available.');
      parts.unshift(path.basename(anchor));
      anchor = parent;
    }
  }
}

export function parseTelemetryFile(file: ProjectFileSnapshot): ProjectTelemetryRecord | undefined {
  return file.content === undefined ? undefined : parseProjectTelemetryRecord(telemetryJson(file.content, 'Project telemetry record'));
}

export async function commitTelemetryConsent(input: {
  projectRoot: string;
  manifest: ProjectFileSnapshot;
  record: ProjectFileSnapshot;
  config: TelemetryConsentConfig;
  target: ProjectTelemetryRecord;
  assertCurrent(): Promise<void>;
}): Promise<void> {
  const directory = path.dirname(input.config.path);
  if (input.config.snapshot.mode !== undefined && (input.config.snapshot.mode & 0o222) === 0) {
    throw new FileSystemError('Telemetry configuration is read-only; enrollment was not written.');
  }
  const anchor = await lstat(input.config.anchor);
  if ((anchor.mode & 0o222) === 0) throw new FileSystemError('Telemetry configuration directory is read-only.');
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, '.project-consent.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    await input.assertCurrent();
    if (input.record.mode !== undefined && (input.record.mode & 0o222) === 0) {
      throw new FileSystemError('Project telemetry record is read-only; no consent was saved.');
    }
    const currentDirectory = await lstat(directory);
    if (currentDirectory.isSymbolicLink() || (currentDirectory.mode & 0o222) === 0) {
      throw new FileSystemError('Telemetry configuration directory is unsafe or read-only.');
    }
    const content = `${JSON.stringify(input.target, null, 2)}\n`;
    await applyProjectFileTransaction(input.projectRoot, [{
      type: 'write', pathParts: [...projectTelemetryRecordPath], content, mode: input.record.mode ?? 0o600
    }], {
      preconditions: [input.manifest, input.record],
      onBeforeMutation: input.assertCurrent
    });
    const currentConfig = await readTelemetryFile(input.config.anchor, input.config.parts);
    if (JSON.stringify(telemetrySnapshotIdentity(currentConfig)) !== JSON.stringify(telemetrySnapshotIdentity(input.config.snapshot))) {
      throw new FileSystemError('Configuration changed after project record publication; local consent was not saved.');
    }
    const next = updateProjectConsent(input.config.config, input.projectRoot, input.target);
    const configContent = `${JSON.stringify(next, null, 2)}\n`;
    if (input.config.snapshot.content === undefined) await createFileAtomically(input.config.path, configContent, 0o600);
    else await replaceFileAtomically(input.config.path, configContent);
    const saved = await readTelemetryFile(input.config.anchor, input.config.parts);
    if (saved.content === undefined || JSON.stringify(telemetryJson(saved.content, 'Saved telemetry consent')) !==
        JSON.stringify(updateProjectConsent(input.config.config, input.projectRoot, input.target))) {
      throw new FileSystemError('Telemetry consent publication did not read back; inspect status before retrying.');
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export function newProjectTelemetryId(): string {
  return randomUUID();
}
