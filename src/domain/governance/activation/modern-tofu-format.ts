import path from 'node:path';
import type { ExternalCommand } from '../../project/contracts.js';
import { modernLocalInputExclusion } from './modern-local-exclusions.js';
import { capturedFileBytes, copyModernLocalData, localInputFailure, localPath, type ModernLocalFile } from './modern-local-inputs.js';

export const explicitTofuFormatPolicy = Object.freeze({
  kind: 'liftoff-explicit-tofu-format',
  version: 1,
  files: 64,
  argumentsBytes: 32_768,
  args: Object.freeze(['fmt', '-check', '-write=false']),
  scope: 'captured-present-tf-files-only',
  excludedInputs: 'never-added-to-arguments',
  recursion: false,
  evaluation: 'formatting-is-not-provider-or-module-validation'
} as const);

export function explicitTofuFormatCommand(component: readonly string[], input: readonly ModernLocalFile[]): ExternalCommand {
  const captured = copyModernLocalData({ component, input });
  const root = localPath(captured.component).join('/');
  const selected = captured.input.filter(file => {
    const name = localPath(file.pathParts).join('/');
    return name.startsWith(`${root}/`) && name.endsWith('.tf') && file.content !== null;
  }).sort((left, right) => left.pathParts.join('/') < right.pathParts.join('/') ? -1 : 1);
  if (!selected.length || selected.length > explicitTofuFormatPolicy.files) {
    localInputFailure('Explicit OpenTofu formatting requires a bounded nonempty captured .tf file set.');
  }
  const names = new Set<string>();
  const args: string[] = [...explicitTofuFormatPolicy.args];
  for (const file of selected) {
    const name = file.pathParts.join('/');
    if (modernLocalInputExclusion(file.pathParts) || names.has(name.toLowerCase())) {
      localInputFailure('Explicit OpenTofu formatting cannot include protected or ambiguous inputs.');
    }
    names.add(name.toLowerCase());
    capturedFileBytes(file);
    args.push(`./${path.posix.relative(root, name)}`);
  }
  if (Buffer.byteLength(args.join('\0')) > explicitTofuFormatPolicy.argumentsBytes) {
    localInputFailure('Explicit OpenTofu formatting exceeds its argument-byte bound.');
  }
  return { executable: 'tofu', args };
}
