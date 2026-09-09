import { readFileSync } from 'node:fs';
import {
  parseSupportedStackBaseline,
  SupportedStackError,
  type SupportedStackBaseline
} from '../../domain/project/supported-stack.js';
import { resolvePackageFileUrl } from './package-root.js';

export function readSupportedStackBaseline(file: URL): SupportedStackBaseline {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new SupportedStackError(
      `Unable to read supported-stack baseline: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseSupportedStackBaseline(value);
}

export function readPackagedSupportedStackBaseline(): SupportedStackBaseline {
  return readSupportedStackBaseline(
    resolvePackageFileUrl('assets', 'supported-stack.json')
  );
}

export const packagedSupportedStack = readPackagedSupportedStackBaseline();
