import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ActivationConfiguration, ActivationConfigurationBinding } from '../../domain/governance/activation/types.js';
import { validateActivationConfiguration } from '../../domain/governance/activation/validators.js';
import { parseHistoryJson } from '../../governance-activation/history-contracts.js';

export async function readGovernanceConfiguration(
  reference: string, cwd: string
): Promise<{ configuration: ActivationConfiguration; binding: ActivationConfigurationBinding }> {
  const requested = path.resolve(cwd, reference);
  const before = await lstat(requested);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024) {
    throw new Error('Activation inputs must be a singly linked regular public JSON file no larger than 64 KiB.');
  }
  const canonical = await realpath(requested);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(requested);
    if (!opened.isFile() || opened.nlink !== 1 || after.isSymbolicLink() ||
      [opened, after].some((observed) => observed.dev !== before.dev || observed.ino !== before.ino ||
        observed.size !== before.size || observed.mode !== before.mode || observed.mtimeMs !== before.mtimeMs) ||
      await realpath(requested) !== canonical) {
      throw new Error('Activation configuration changed while it was being bound. Request a fresh plan.');
    }
    const configuration = validateActivationConfiguration(parseHistoryJson(bytes, 'public activation inputs'));
    return {
      configuration,
      binding: { schemaVersion: 1, reference: canonical, digest: createHash('sha256').update(bytes).digest('hex') }
    };
  } finally {
    await handle.close();
  }
}

export async function assertGovernanceConfigurationBinding(
  binding: ActivationConfigurationBinding
): Promise<ActivationConfiguration> {
  const observed = await readGovernanceConfiguration(binding.reference, path.dirname(binding.reference));
  if (observed.binding.reference !== binding.reference || observed.binding.digest !== binding.digest) {
    throw new Error('The exact reviewed configuration reference or bytes changed. Request a fresh plan; the old approval is not reused.');
  }
  return observed.configuration;
}
