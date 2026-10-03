import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { access, lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ActivationConfiguration } from '../../domain/governance/activation/types.js';
import { validatePublicActivationInputs } from '../../domain/governance/activation/validators.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { readProjectFile } from './project-files.js';
import { resolveProjectPath } from './project-paths.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export async function readProjectJsonDirectory(projectRoot: string, directoryPathParts: readonly string[], label: string): Promise<Array<{
  name: string;
  value: unknown;
}>> {
  const directory = await resolveProjectPath(
    projectRoot,
    validateArtifactPathParts([...directoryPathParts], `${label} directory path`)
  );
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to read ${directoryPathParts.join('/')}: ${errorMessage(error)}`);
  }

  const values: Array<{ name: string; value: unknown }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (!entry.name.endsWith('.json')) {
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`${directoryPathParts.join('/')}/${entry.name} must be a regular JSON file.`);
    }
    const pathParts = validateArtifactPathParts([...directoryPathParts, entry.name], `${label} file path`);
    const bytes = await readProjectFile(projectRoot, pathParts);
    if (bytes === undefined) {
      throw new Error(`${pathParts.join('/')} disappeared during governance inspection.`);
    }
    try {
      values.push({ name: entry.name, value: JSON.parse(bytes.toString('utf8')) as unknown });
    } catch {
      throw new Error(`Unable to parse ${pathParts.join('/')}: the file is not valid JSON; its content was withheld.`);
    }
  }
  return values;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

const inputLimitBytes = 64 * 1024;
const inputRefusal = 'Activation inputs must be a singly linked regular public JSON file no larger than 64 KiB.';
const inputIdentityUnavailable =
  'Activation inputs file identity is unavailable on this file system; the opened file cannot be matched to the inspected path.';

function acceptableInputFile(details: BigIntStats): boolean {
  return details.isFile() && !details.isSymbolicLink() && details.nlink === 1n && details.size <= BigInt(inputLimitBytes);
}

// Reads at most limit + 1 bytes, so growth after the size check cannot enlarge the read.
async function readAtMost(handle: FileHandle, limit: number): Promise<Buffer> {
  const bytes = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > limit) throw new Error(inputRefusal);
  return bytes.subarray(0, length);
}

// Only errno-style codes are repeated; cleanup error text is never surfaced.
function trustedCodeSuffix(error: unknown): string {
  const code = errorCode(error);
  return code !== undefined && /^E[A-Z0-9]{2,15}$/u.test(code) ? ` (${code})` : '';
}

async function readOpenedInputs(handle: FileHandle, observed: BigIntStats | undefined): Promise<ActivationConfiguration> {
  const opened = await handle.stat({ bigint: true });
  if (!acceptableInputFile(opened)) throw new Error(inputRefusal);
  if (observed) {
    if (opened.ino === 0n) throw new Error(inputIdentityUnavailable);
    if (opened.dev !== observed.dev || opened.ino !== observed.ino) throw new Error(inputRefusal);
  }
  const text = (await readAtMost(handle, inputLimitBytes)).toString('utf8');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Activation inputs are not valid JSON; credential or state content must not be supplied here.'); }
  return validatePublicActivationInputs(value);
}

export async function readPublicActivationInputs(filePath: string): Promise<ActivationConfiguration> {
  const noFollow = constants.O_NOFOLLOW;
  // Without an atomic no-follow open (Windows), the opened file must match the identity an
  // earlier lstat observed for the same path. Matching identities do not rule out every racing swap.
  const observed = noFollow === undefined ? await lstat(filePath, { bigint: true }) : undefined;
  if (observed && !acceptableInputFile(observed)) throw new Error(inputRefusal);
  const handle = await open(filePath, constants.O_RDONLY | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0));
  let configuration: ActivationConfiguration;
  try {
    configuration = await readOpenedInputs(handle, observed);
  } catch (error) {
    try {
      await handle.close();
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)} Closing the activation inputs file also failed${trustedCodeSuffix(cleanupError)}.`, { cause: error });
    }
    throw error;
  }
  try {
    await handle.close();
  } catch (cleanupError) {
    throw new Error(`Closing the activation inputs file failed${trustedCodeSuffix(cleanupError)}; the inputs were not used.`);
  }
  return configuration;
}
