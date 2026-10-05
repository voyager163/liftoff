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
  'node-backend-package-lock': 'sha256:bbb0ca538b14a79382236cee07cf4200b83129d59176b58cf1f9df88e4c4393d',
  'go-backend-module': 'sha256:b4a00ccd7a9881c7e518dcbba83bd8ead0a852b29cb2509402f3c8c9af5bafac',
  'go-backend-checksums': 'sha256:c4c5f94664176df8c09e6fbf02a48391e606d135caec6b75932271333bbb4fb5',
  'python-standard-project': 'sha256:dc551853962b84bec527bb3463801b74ab9681b41d362653892243836a6e6935',
  'python-standard-lock': 'sha256:4bc135105548ce5d16d64fe034be6993cf722f75f51ac4d728a56c35c80d0dc2',
  'python-genai-project': 'sha256:94cbed85dbaf807866b4908703106d19e01eee9a30b7ccf186b88f68d8154745',
  'python-genai-lock': 'sha256:2d6c651f9237d092ef56461b3f492aa19b1a825f08f14608b3cc2d020d89e16d',
  'python-genai-function-requirements': 'sha256:6297c0dbb51146fa6188b380e026d6a31f61d1cec9c5586aa495ff1dca26ef46',
  'opentofu-azure-versions': 'sha256:7f1b60e1d88e6e8f0bc3981fafbb33b9d1471b3fe028b2eaa757d01d7f7001af',
  'opentofu-azure-provider-lock': 'sha256:e4a061da79009c7e1c2f9cb356b3a4df0bb05802f9b98f30de79c351c280ef61',
  'frontend-package-manifest': 'sha256:8217179388207e3d8e8599544e7741b29beb6dded81f01bcf5d4356785a68561',
  'frontend-package-lock': 'sha256:7e454f0ab739038e99569d174045673776b4565786b1f81764b4c3ee785638b5'
};

interface PluginRecord {
  readonly category: PluginCategory;
  readonly id: string;
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: Sha256Digest;
}

const pluginRecords: readonly PluginRecord[] = [
  { category: 'stack', id: 'python-fastapi', apiVersion: 1, contentVersion: 2, contentDigest: 'sha256:44f91983bc9b69360cb6c0f35c61b8e0132bd4bfd1f7c93c1bf696d525bed7ea' },
  { category: 'stack', id: 'node-fastify', apiVersion: 1, contentVersion: 3, contentDigest: 'sha256:2140749905f08e15db0e18c0b0b97ffd72a9f7fb30ae5469c7678822e1dcee7c' },
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
  pluginSetDigest: 'sha256:a263187ff10f7c68714d3d1b958e486ee734753a8485ae367b82b00fcbbabe0b' as Sha256Digest,
  coreContributionDigest: 'sha256:b46fee151601812c273ec4552c67fdb05c8a2a6125f11e0d9cd28f2e4dca169d' as Sha256Digest,
  registryDigest: 'sha256:5d8cb413fb0dd5c1292831c863fab51a0c98318a1716f4c224cba86369c3f869' as Sha256Digest
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
