import type { PluginCategory, PluginReleaseInventory, Sha256Digest } from '../contracts.js';
import { builtinAssets } from './assets.js';
import { deepFrozen } from './core.js';

/*
 * Reviewed release identity of the bundled built-ins, as literal values only. Runtime never derives,
 * refreshes or writes them: registry intake recomputes every digest and rejects any difference. A
 * reviewed change to asset bytes, a descriptor or the core declarations updates these literals in
 * the same change, from the values the failing tests print. Content digests cover declarations and
 * asset bytes but not renderer code, so a reviewed change to a plugin's rendered behavior also
 * advances that plugin's contentVersion. Asset locations come from the C1 declaration table.
 * Public agent guidance advances from capability-first version 3 to v8-aware version 4.
 * Version 2 remains allocated to the distinct modern source descriptors; their unchanged
 * renderers and recorded identities are not retagged.
 */

const assetSha256: Readonly<Record<string, Sha256Digest>> = {
  'node-backend-package-manifest': 'sha256:ce24c806c0ebc3f54b79647422b44afafb4cbe9ec4b2b062e934aa8fc78c4481',
  'node-backend-package-lock': 'sha256:e4a88cada73456bf1b0a3923d5e814313358c91b0b9b2a13d5fbf41632231369',
  'go-backend-module': 'sha256:b4a00ccd7a9881c7e518dcbba83bd8ead0a852b29cb2509402f3c8c9af5bafac',
  'go-backend-checksums': 'sha256:c4c5f94664176df8c09e6fbf02a48391e606d135caec6b75932271333bbb4fb5',
  'python-standard-project': 'sha256:dc551853962b84bec527bb3463801b74ab9681b41d362653892243836a6e6935',
  'python-standard-lock': 'sha256:042440545f33b7c82e0a676602c29092ec06104da543372110602225c637ec3a',
  'python-genai-project': 'sha256:9d71f403b7298edbb4413384ef786da4e66cc4849749e90824daa2acd2a1629e',
  'python-genai-lock': 'sha256:6734357fa5dc42b1aac41c80b4a8ee91a5aede97c1efc4d2b2a2213943d73112',
  'python-genai-function-requirements': 'sha256:67886959248dfbc782dc408bb87f54679eaecb97fcb82c47340a3b979838c3c6',
  'opentofu-azure-versions': 'sha256:7f1b60e1d88e6e8f0bc3981fafbb33b9d1471b3fe028b2eaa757d01d7f7001af',
  'opentofu-azure-provider-lock': 'sha256:e4a061da79009c7e1c2f9cb356b3a4df0bb05802f9b98f30de79c351c280ef61',
  'frontend-package-manifest': 'sha256:8217179388207e3d8e8599544e7741b29beb6dded81f01bcf5d4356785a68561',
  'frontend-package-lock': 'sha256:494f2312ba163062c10164df363c49b0987109b529f320381ec5795bbf0ea689'
};

interface PluginRecord {
  readonly category: PluginCategory;
  readonly id: string;
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: Sha256Digest;
}

const pluginRecords: readonly PluginRecord[] = [
  { category: 'stack', id: 'python-fastapi', apiVersion: 1, contentVersion: 3, contentDigest: 'sha256:007ef8be99fea8d880c5f4411e1a77f2f58bb0f5945f5c6728a599905cca7c5c' },
  { category: 'stack', id: 'node-fastify', apiVersion: 1, contentVersion: 4, contentDigest: 'sha256:741c6dc7221d9178db1ea88dee47c98e3bdb1ba382ba432dc76f277c705feb92' },
  { category: 'stack', id: 'go-huma', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:89f2689d613fcd5708bf9a94b5138cc0d39fb3c0c18374c75a190e7ee8ba1432' },
  { category: 'cloud', id: 'azure', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:f7b67895895c43bff579a5108d0dffd5171dbd6cbdf56fd99e725e41a672f6d7' },
  { category: 'workflow', id: 'openspec', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:8675a3187f44932c7bee9f9a8e5d3f307bcb36d66ced0f20593663221c509d5e' },
  { category: 'workflow', id: 'spec-kit', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:420fd4584bf02e8efc65bf9893848a4748ce676c030095de9ef1fba20ca7a137' },
  { category: 'agent', id: 'github-copilot', apiVersion: 1, contentVersion: 4, contentDigest: 'sha256:bb8fefb021d3a5dbad4fb0ddb052c5c5fe6ffa9d360030bdb72f9770efbefa40' },
  { category: 'agent', id: 'claude', apiVersion: 1, contentVersion: 4, contentDigest: 'sha256:3fd7a42b9cc8daee3401dcf21b755782a1f28e0fb1b59f76c17139edc5b50873' },
  { category: 'agent', id: 'codex', apiVersion: 1, contentVersion: 4, contentDigest: 'sha256:7ed80a1d4710117bf6888c3e5bacda1febb9a24878a82e394e1c3017d02d288d' }
];

/** Expected registry identities of the built-ins. Tests assert them; runtime never consults them. */
export const builtinReleaseDigests = deepFrozen({
  pluginSetDigest: 'sha256:9e44b24e3703878cabd683f45dfab2d0d8fd1e34e117c5b086f986ca263b5f8e' as Sha256Digest,
  coreContributionDigest: 'sha256:f8189ff22d635da4f8c5598e92159d3c4364684016a00e0df9af034a7503ae22' as Sha256Digest,
  registryDigest: 'sha256:1b41b3e9c1cc55d5463a743beb8041cd8459ab95dea86b24d44f314296df7cb8' as Sha256Digest
});

// A missing literal is reported by registry intake as a release mismatch at first use, never here.
const unrecorded = 'sha256:unrecorded' as Sha256Digest;

function assetRecords(ownedBy: (asset: (typeof builtinAssets)[number]) => boolean) {
  return builtinAssets.filter(ownedBy).map((asset) => ({
    id: asset.id,
    pathParts: [...asset.pathParts],
    sha256: assetSha256[asset.id] ?? unrecorded
  }));
}

export const builtinRelease: PluginReleaseInventory = deepFrozen({
  schemaVersion: 1,
  sharedAssets: assetRecords((asset) => asset.owner.kind === 'core'),
  plugins: pluginRecords.map((record) => ({
    ...record,
    assets: assetRecords((asset) => asset.owner.kind === 'plugin' &&
      asset.owner.category === record.category && asset.owner.id === record.id)
  }))
});
