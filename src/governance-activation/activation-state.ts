import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256Hex } from './canonical-json.js';
import {
  readProjectFile,
  resolveProjectPath,
  validateArtifactPathParts
} from '../file-system.js';
import type { UserActivationState } from './types.js';
import { validateUserActivationState } from './validators.js';

export class ActivationStateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivationStateFileError';
  }
}

export class ActivationStateTransactionError extends ActivationStateFileError {
  constructor(
    message: string,
    public readonly rollbackFailures: readonly string[]
  ) {
    super(message);
    this.name = 'ActivationStateTransactionError';
  }
}

export interface LoadedActivationState {
  state: UserActivationState;
  content: string;
  contentHash: string;
  schemaVersion: number;
}

export interface ActivationStateWriteExpectation {
  expectedContentHash: string | null;
  expectedSchemaVersion?: number | null;
  expectedContent?: string | null;
}

export interface ActivationStateWriteResult {
  pathParts: readonly string[];
  content: string;
  contentHash: string;
  schemaVersion: number;
}

export interface ActivationStateWriteOptions {
  failAfterReplace?: boolean;
}

export const activationStateFilePathParts = ['governance', 'activation-state.json'] as const;

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

function activationStatePathParts(): string[] {
  return validateArtifactPathParts([...activationStateFilePathParts], 'Activation state path');
}

export function activationStateContentHash(content: string | Buffer): string {
  return sha256Hex(typeof content === 'string' ? content : content.toString('utf8'));
}

export async function loadActivationState(projectRoot: string): Promise<LoadedActivationState | undefined> {
  const bytes = await readProjectFile(projectRoot, activationStatePathParts());
  if (bytes === undefined) {
    return undefined;
  }
  const content = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ActivationStateFileError(`Unable to parse governance/activation-state.json: ${errorMessage(error)}`);
  }
  let state: UserActivationState;
  try {
    state = validateUserActivationState(parsed);
  } catch (error) {
    throw new ActivationStateFileError(`Invalid governance/activation-state.json: ${errorMessage(error)}`);
  }
  return {
    state,
    content,
    contentHash: activationStateContentHash(content),
    schemaVersion: state.schemaVersion
  };
}

async function removeIfExists(filePath: string, failures: string[]): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      failures.push(`${filePath}: ${errorMessage(error)}`);
    }
  }
}

function assertExpectedPrior(
  loaded: LoadedActivationState | undefined,
  expectation: ActivationStateWriteExpectation
): void {
  if (expectation.expectedContentHash === null) {
    if (loaded !== undefined) {
      throw new ActivationStateFileError('Activation state write expected no prior activation-state.json, but one exists.');
    }
    return;
  }
  if (loaded === undefined) {
    throw new ActivationStateFileError('Activation state write expected an existing activation-state.json, but it is absent.');
  }
  if (loaded.contentHash !== expectation.expectedContentHash) {
    throw new ActivationStateFileError(
      `Activation state changed concurrently: expected hash ${expectation.expectedContentHash}, found ${loaded.contentHash}.`
    );
  }
  if (expectation.expectedSchemaVersion !== undefined && expectation.expectedSchemaVersion !== null) {
    if (loaded.schemaVersion !== expectation.expectedSchemaVersion) {
      throw new ActivationStateFileError(
        `Activation state schema changed concurrently: expected ${expectation.expectedSchemaVersion}, found ${loaded.schemaVersion}.`
      );
    }
  }
  if (expectation.expectedContent !== undefined && expectation.expectedContent !== null) {
    if (loaded.content !== expectation.expectedContent) {
      throw new ActivationStateFileError('Activation state content changed concurrently.');
    }
  }
}

export async function writeActivationState(
  projectRoot: string,
  state: UserActivationState,
  expectation: ActivationStateWriteExpectation,
  options: ActivationStateWriteOptions = {}
): Promise<ActivationStateWriteResult> {
  const validatedState = validateUserActivationState(state);
  const prior = await loadActivationState(projectRoot);
  assertExpectedPrior(prior, expectation);

  const content = canonicalJson(validatedState);
  const contentHash = activationStateContentHash(content);
  const targetPath = await resolveProjectPath(projectRoot, activationStatePathParts());
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.liftoff-${process.pid}-${randomUUID()}.tmp`);
  const backupPath = path.join(directory, `.${path.basename(targetPath)}.liftoff-${process.pid}-${randomUUID()}.bak`);
  const mode = prior ? (await stat(targetPath)).mode & 0o7777 : 0o600;
  let temporaryWritten = false;
  let backupWritten = false;
  let replacementInstalled = false;
  const rollbackFailures: string[] = [];

  try {
    await mkdir(directory, { recursive: true });
    if (prior) {
      await writeFile(backupPath, prior.content, { encoding: 'utf8', flag: 'wx', mode });
      await chmod(backupPath, mode);
      backupWritten = true;
    }
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode });
    await chmod(temporaryPath, mode);
    temporaryWritten = true;
    await rename(temporaryPath, targetPath);
    replacementInstalled = true;
    temporaryWritten = false;
    if (options.failAfterReplace) {
      throw new ActivationStateTransactionError('Injected activation-state write failure after replace.', []);
    }
    if (backupWritten) {
      await unlink(backupPath);
      backupWritten = false;
    }
    return {
      pathParts: activationStateFilePathParts,
      content,
      contentHash,
      schemaVersion: validatedState.schemaVersion
    };
  } catch (error) {
    if (temporaryWritten) {
      await removeIfExists(temporaryPath, rollbackFailures);
    }
    if (replacementInstalled) {
      if (prior) {
        try {
          await writeFile(targetPath, prior.content, { encoding: 'utf8', mode });
          await chmod(targetPath, mode);
        } catch (restoreError) {
          rollbackFailures.push(`restore governance/activation-state.json: ${errorMessage(restoreError)}`);
        }
      } else {
        await removeIfExists(targetPath, rollbackFailures);
      }
    }
    if (backupWritten) {
      await removeIfExists(backupPath, rollbackFailures);
    }
    throw new ActivationStateTransactionError(
      `Unable to write governance/activation-state.json transactionally: ${errorMessage(error)}`,
      rollbackFailures
    );
  }
}
