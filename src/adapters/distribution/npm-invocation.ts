import path from 'node:path';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { DistributionError } from '../../domain/distribution/errors.js';
import { freeze, stableVersion } from '../../domain/distribution/validation.js';
import {
  canonicalNativeRoot, hashNativeFile, ioCode, nativeDirectorySnapshot, readNativeJson, resolveNativeEntrypoint
} from './native-files.js';
import { environmentValue } from './launcher-observation.js';

export interface NpmToolInvocation {
  executable: string;
  argsPrefix: readonly string[];
  bindingDigest: string;
  nodeExecutable?: string;
}

export async function resolveNpmToolInvocation(
  selectedLauncher: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): Promise<NpmToolInvocation> {
  const launcher = await resolveNativeEntrypoint(selectedLauncher, cwd);
  const launcherRoot = await canonicalNativeRoot(path.dirname(launcher));
  const launcherFile = await hashNativeFile(launcherRoot, [path.basename(launcher)]);
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(launcher)) {
    return freeze({ executable: launcher, argsPrefix: [], bindingDigest: canonicalSha256({ launcher, launcherFile }) });
  }
  const packageParts = ['node_modules', 'npm', 'package.json'];
  const metadata = await readNativeJson(launcherRoot, packageParts.join('/'));
  if (!isRecord(metadata) || metadata.name !== 'npm' || !isRecord(metadata.bin) || metadata.bin.npm !== 'bin/npm-cli.js') {
    throw new DistributionError('The selected Windows npm tool has no exact canonical npm-cli.js package binding.', 'tool_unavailable');
  }
  stableVersion(metadata.version);
  const scriptParts = ['node_modules', 'npm', 'bin', 'npm-cli.js'];
  const script = path.join(launcherRoot, ...scriptParts);
  const packageFile = await hashNativeFile(launcherRoot, packageParts, 2 * 1024 * 1024);
  const scriptFile = await hashNativeFile(launcherRoot, scriptParts, 2 * 1024 * 1024);
  const pathValue = environmentValue(env, 'PATH', platform) ?? '';
  const directories = pathValue.split(platform === process.platform ? path.delimiter : ';');
  const candidates = [
    path.join(launcherRoot, 'node.exe'),
    ...directories.filter((directory) => directory && path.isAbsolute(directory)).map((directory) => path.join(directory, 'node.exe'))
  ];
  let nodeExecutable: string | undefined;
  for (const candidate of [...new Set(candidates)]) {
    try {
      nodeExecutable = await resolveNativeEntrypoint(candidate, cwd);
      break;
    } catch (error) {
      if (ioCode(error) !== 'ENOENT' && ioCode(error) !== 'ENOTDIR') throw error;
    }
  }
  if (!nodeExecutable) {
    throw new DistributionError('The selected Windows npm tool has no observed external node.exe interpreter; the CLI private runtime is not substituted.', 'tool_unavailable');
  }
  const nodeRoot = await canonicalNativeRoot(path.dirname(nodeExecutable));
  const nodeFile = await hashNativeFile(nodeRoot, [path.basename(nodeExecutable)]);
  return freeze({
    executable: nodeExecutable, argsPrefix: [script], nodeExecutable,
    bindingDigest: canonicalSha256({
      launcher, launcherFile, packageFile, scriptFile, nodeExecutable, nodeFile,
      directories: [await nativeDirectorySnapshot(launcherRoot), await nativeDirectorySnapshot(nodeRoot)]
    })
  });
}
