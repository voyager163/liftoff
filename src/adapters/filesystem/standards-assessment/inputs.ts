import path from 'node:path';
import { InputsError } from './errors.js';
import { isProtectedPayload } from './scanner.js';
import { AssessmentSnapshot, captureCanonicalAncestors } from './snapshot.js';
import { containsSensitiveText, sha256Hex } from '../../../domain/standards-assessment/sanitizer.js';

export interface InputMetadata {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface CapturedInputsResult {
  reference: string;
  digest: string;
  content: string;
  metadata: InputMetadata;
}

const MAX_INPUTS_SIZE = 1024 * 1024;
const captures = new WeakMap<InputMetadata, { reference: string; snapshot: AssessmentSnapshot }>();

export async function verifyCanonicalAncestors(targetPath: string): Promise<void> {
  try {
    await captureCanonicalAncestors(path.dirname(targetPath));
  } catch (error) {
    throw new InputsError(`Inputs path has an unsafe ancestor: ${error instanceof Error ? error.message : 'Directory inspection failed.'}`);
  }
}

export async function captureInputsFile(
  rawInputsPath: string,
  invocationCwd: string
): Promise<CapturedInputsResult> {
  const resolved = path.isAbsolute(rawInputsPath)
    ? path.normalize(rawInputsPath)
    : path.resolve(invocationCwd, rawInputsPath);

  if (containsSensitiveText(resolved)) {
    throw new InputsError('Inputs reference contains a protected credential pattern; its value was withheld.');
  }
  if (isProtectedPayload(path.basename(resolved))) {
    throw new InputsError(
      `Inputs file '${rawInputsPath}' targets protected credentials, keys, or state files.`
    );
  }

  try {
    const snapshot = await AssessmentSnapshot.create(path.dirname(resolved));
    await snapshot.list([], 10_000);
    const parts = [path.basename(resolved)];
    const stats = await snapshot.inspect(parts);
    if (!stats) throw new InputsError(`Inputs file does not exist: ${resolved}`);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new InputsError(`Inputs file '${resolved}' must be a bounded regular file, not a symlink, directory, or special entry.`);
    }
    if (stats.size > MAX_INPUTS_SIZE) {
      throw new InputsError(`Inputs file '${resolved}' exceeds the 1 MiB contract bound.`);
    }
    const { content: buffer } = await snapshot.read(parts, MAX_INPUTS_SIZE);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new InputsError('Inputs file must contain valid UTF-8; undecodable bytes cannot establish an input binding.');
    }
    if (containsSensitiveText(content)) {
      throw new InputsError(`Inputs file '${resolved}' contains prohibited sensitive credentials, tokens, or private keys.`);
    }
    await snapshot.assertCurrent();
    const metadata: InputMetadata = Object.freeze({
      dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size,
      mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs
    });
    captures.set(metadata, { reference: resolved, snapshot });
    return { reference: resolved, digest: `sha256:${sha256Hex(buffer)}`, content, metadata };
  } catch (error) {
    if (error instanceof InputsError) throw error;
    throw new InputsError(`Unable to safely capture inputs: ${error instanceof Error ? error.message : 'Filesystem inspection failed.'}`);
  }
}

export async function recheckCapturedInputs(
  resolvedPath: string,
  expectedMeta: InputMetadata
): Promise<void> {
  const captured = captures.get(expectedMeta);
  if (!captured || captured.reference !== resolvedPath) {
    throw new InputsError('Inputs recheck requires the original captured file and directory observation.');
  }
  try {
    await captured.snapshot.assertCurrent();
  } catch (error) {
    throw new InputsError(`Inputs file or directory changed during observation: ${error instanceof Error ? error.message : 'Recheck failed.'}`);
  }
}
