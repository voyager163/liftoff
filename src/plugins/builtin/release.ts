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
 * Public agent guidance advances to 3: version 2 is already allocated to the distinct private
 * modern source descriptors. Their unchanged renderers and recorded identities are not retagged.
 */

const assetSha256: Readonly<Record<string, Sha256Digest>> = {
  'node-backend-package-manifest': 'sha256:6ce7e8d9f6a5c878c9e6ed843e75772453bac1d72b049762f84e4a403b9b3382',
  'node-backend-package-lock': 'sha256:1eedf51491d8900fe4b487980720ea7257ced4697ee8d6a4865c922734bf2c86',
  'go-backend-module': 'sha256:b4a00ccd7a9881c7e518dcbba83bd8ead0a852b29cb2509402f3c8c9af5bafac',
  'go-backend-checksums': 'sha256:c4c5f94664176df8c09e6fbf02a48391e606d135caec6b75932271333bbb4fb5',
  'python-standard-project': 'sha256:dc551853962b84bec527bb3463801b74ab9681b41d362653892243836a6e6935',
  'python-standard-lock': 'sha256:ac827ab61c9704b1cd080034571320a2b9285e9f7d420658b2d232ae14ed2647',
  'python-genai-project': 'sha256:94cbed85dbaf807866b4908703106d19e01eee9a30b7ccf186b88f68d8154745',
  'python-genai-lock': 'sha256:4aa3bea0873ade3a2d4266adeeb1d504138f18bc2f093459f90699674d805648',
  'python-genai-function-requirements': 'sha256:3d8fa15e16764e7b1d5d2b884829a06e0e020f4627bd2e83c221461564e4cbfb',
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
  { category: 'stack', id: 'python-fastapi', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:3cf538179f9cd748aea425bae9723bee29d232b91db6a794df88c65fc6e82c63' },
  { category: 'stack', id: 'node-fastify', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:34dcdb9e17e17441709eba87c462e08de49a55abc187989b84f1482f64fbb24e' },
  { category: 'stack', id: 'go-huma', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:89f2689d613fcd5708bf9a94b5138cc0d39fb3c0c18374c75a190e7ee8ba1432' },
  { category: 'cloud', id: 'azure', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:f7b67895895c43bff579a5108d0dffd5171dbd6cbdf56fd99e725e41a672f6d7' },
  { category: 'workflow', id: 'openspec', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:8675a3187f44932c7bee9f9a8e5d3f307bcb36d66ced0f20593663221c509d5e' },
  { category: 'workflow', id: 'spec-kit', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:420fd4584bf02e8efc65bf9893848a4748ce676c030095de9ef1fba20ca7a137' },
  { category: 'agent', id: 'github-copilot', apiVersion: 1, contentVersion: 3, contentDigest: 'sha256:5e9106f0d854a97f38a8b02b1c7f9a2df4f69a516f47b1c1d5c45787936cce15' },
  { category: 'agent', id: 'claude', apiVersion: 1, contentVersion: 3, contentDigest: 'sha256:4ce992b50c2f35650aa325b7a538816e67d01818d706215f761f52392605bc77' },
  { category: 'agent', id: 'codex', apiVersion: 1, contentVersion: 3, contentDigest: 'sha256:d3db2b86b2188b7812ca2b5f39c0e0bf2d4bb16763c4c86b0b7daf1e14a006c1' }
];

/** Expected registry identities of the built-ins. Tests assert them; runtime never consults them. */
export const builtinReleaseDigests = deepFrozen({
  pluginSetDigest: 'sha256:fc7e34f7d248fd9994d6f89706434dde07a3b5c41182723874e180e94cd519bd' as Sha256Digest,
  coreContributionDigest: 'sha256:b46fee151601812c273ec4552c67fdb05c8a2a6125f11e0d9cd28f2e4dca169d' as Sha256Digest,
  registryDigest: 'sha256:cb63953cf1070b764ac543034dc36653c990ec3201154b53e3ae6dab854fd464' as Sha256Digest
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
