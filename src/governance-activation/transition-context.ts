import os from 'node:os';
import {
  getUpdatePreviewDirectory, nodeUpdatePreviewFileSystem, type UpdatePreviewOptions
} from '../adapters/filesystem/update-previews.js';
import type { GovernanceTransitionAdapters } from './transition-ports.js';

export function bindGovernanceTransitionContext(input: {
  storage?: UpdatePreviewOptions;
  adapters?: GovernanceTransitionAdapters;
} = {}): { storage: UpdatePreviewOptions; adapters: GovernanceTransitionAdapters } {
  const adapters = input.adapters ?? {};
  const configured = [input.storage, adapters.githubActivation?.storage, adapters.azureActivation?.storage]
    .filter((storage): storage is UpdatePreviewOptions => storage !== undefined);
  const selected = configured[0] ?? {};
  for (const candidate of configured.slice(1)) {
    if (getUpdatePreviewDirectory(candidate) !== getUpdatePreviewDirectory(selected) ||
      (candidate.platform ?? process.platform) !== (selected.platform ?? process.platform) ||
      (candidate.repositoryRoot ?? null) !== (selected.repositoryRoot ?? null) ||
      (candidate.fileSystem ?? nodeUpdatePreviewFileSystem) !== (selected.fileSystem ?? nodeUpdatePreviewFileSystem)) {
      throw new Error('Governance preview, approval and provider recovery must use the same explicitly selected private storage boundary.');
    }
  }
  const env = selected.env ?? process.env;
  const storage: UpdatePreviewOptions = Object.freeze({
    ...selected,
    platform: selected.platform ?? process.platform,
    homedir: selected.homedir ?? os.homedir(),
    env: Object.freeze({ XDG_STATE_HOME: env.XDG_STATE_HOME, LOCALAPPDATA: env.LOCALAPPDATA })
  });
  return {
    storage,
    adapters: {
      ...adapters,
      githubActivation: { ...adapters.githubActivation, storage },
      azureActivation: { ...adapters.azureActivation, storage }
    }
  };
}
