import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import {
  isRetainedProjectInput, type RetainedProjectInput
} from '../application/update/protected-source.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import { historyCaseKey, historyPathParts } from './history-contracts.js';
import type { ActivationHistoryMigrationPlan, HistoricalLifecycleObligation } from './migration-history.js';

const sensitiveFileName = /(?:^\.env(?:\.|$)(?!example$|sample$)|\.tfstate(?:\.|$)|\.tfplan(?:\.|$)|\.pem$|\.key$|\.pfx$|\.p12$|\.enc$|\.age$|\.gpg$|^\.npmrc$|^terraform\.rc$|^credentials(?:\.|$)|^local\.settings\.json$)/iu;
const privateDirectories = new Set(['.git', '.terraform', 'node_modules', '.venv', 'venv', '.azure', '.aws', '.ssh', '.gnupg']);

export function migrationSensitivePathExclusions(
  plan: ActivationHistoryMigrationPlan
): readonly (readonly string[])[] {
  const obligations: readonly HistoricalLifecycleObligation[] = plan.status === 'eligible'
    ? plan.semanticPlan.lifecycleObligations
    : plan.status === 'current' && plan.history.status === 'committed' ? plan.history.lifecycleObligations : [];
  return obligations.flatMap((obligation) => [
    ...obligation.retention.encryptedStatePathParts, ...obligation.retention.encryptionKeyPathParts
  ]).map((parts) => historyPathParts(parts, 'historical protected material reference'));
}

export function isMigrationPublicInputPath(
  parts: readonly string[], sensitivePathParts: readonly (readonly string[])[] = []
): boolean {
  const publicCredentialMetadata = (index: number) =>
    parts[index] === 'credentials' &&
    (index === 1 && parts[0] === 'governance' ||
      index === 5 && parts[0] === 'governance' && parts[1] === 'history' &&
        /^[a-f0-9]{64}$/u.test(parts[2]) && parts[3] === 'files' && parts[4] === 'governance') &&
    (parts.length === index + 1 || parts.length === index + 2 && parts[index + 1] === 'preflight-policy.json');
  if (!isRetainedProjectInput(parts) || parts.some((part) => privateDirectories.has(part.toLowerCase())) ||
    parts.some((part, index) => sensitiveFileName.test(part) && !publicCredentialMetadata(index))) return false;
  const key = historyCaseKey(parts);
  return !sensitivePathParts.some((sensitive) => {
    const excluded = historyCaseKey(sensitive);
    return key === excluded || key.startsWith(`${excluded}/`);
  });
}

/** Metadata migration never hashes protected state/key contents, even to form a preview binding. */
export async function captureMigrationRetainedProjectInputs(
  projectRoot: string, sensitivePathParts: readonly (readonly string[])[] = []
): Promise<RetainedProjectInput[]> {
  const exclusions = sensitivePathParts.map((parts) => historyPathParts(parts, 'protected input exclusion'));
  const result: RetainedProjectInput[] = [];
  async function visit(parts: string[]): Promise<void> {
    const directory = parts.length ? await resolveProjectPath(projectRoot, parts) : projectRoot;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = [...parts, entry.name];
      if (!isMigrationPublicInputPath(child, exclusions)) continue;
      historyPathParts(child, 'migration public input path');
      const absolute = await resolveProjectPath(projectRoot, child);
      const details = await lstat(absolute);
      if (entry.isDirectory() && details.isDirectory()) await visit(child);
      else if (entry.isFile() && details.isFile() && !details.isSymbolicLink() && details.nlink === 1) {
        result.push({ pathParts: child, digest: createHash('sha256').update(await readFile(absolute)).digest('hex'), mode: details.mode & 0o7777 });
      } else {
        throw new Error(`Protected update source ${child.join('/')} must not be a link or special file.`);
      }
    }
  }
  await visit([]);
  return result.sort((a, b) => a.pathParts.join('/').localeCompare(b.pathParts.join('/'), 'en'));
}
