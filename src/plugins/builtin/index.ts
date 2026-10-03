import type {
  PackagedAssetBytes,
  PluginDescriptor,
  PluginRegistryInput,
  PluginRegistryLimits
} from '../contracts.js';
import { claudePlugin } from './agents/claude.js';
import { codexPlugin } from './agents/codex.js';
import { githubCopilotPlugin } from './agents/github-copilot.js';
import { azurePlugin } from './clouds/azure.js';
import { builtinCore, builtinOperations, builtinSelectionSpace, deepFrozen } from './core.js';
import { builtinRelease } from './release.js';
import { goHumaPlugin } from './stacks/go-huma.js';
import { nodeFastifyPlugin } from './stacks/node-fastify.js';
import { pythonFastApiPlugin } from './stacks/python-fastapi.js';
import { openSpecPlugin } from './workflows/openspec.js';
import { specKitPlugin } from './workflows/spec-kit.js';

export { builtinCore, builtinOperations, builtinSelectionSpace } from './core.js';
export { builtinRelease, builtinReleaseDigests } from './release.js';

/** The complete, closed set of first-party built-in plugins, in catalog order. */
export const builtinDescriptors: readonly PluginDescriptor[] = deepFrozen([
  pythonFastApiPlugin,
  nodeFastifyPlugin,
  goHumaPlugin,
  azurePlugin,
  openSpecPlugin,
  specKitPlugin,
  githubCopilotPlugin,
  claudePlugin,
  codexPlugin
]);

/** Complete registry input for the built-ins; the bytes are the caller's bounded reads of C1. */
export function builtinRegistryInput(
  assets: readonly PackagedAssetBytes[],
  limits?: Partial<PluginRegistryLimits>
): PluginRegistryInput {
  return {
    descriptors: builtinDescriptors,
    core: builtinCore,
    selectionSpace: builtinSelectionSpace,
    operations: builtinOperations,
    release: builtinRelease,
    assets,
    ...(limits === undefined ? {} : { limits })
  };
}
