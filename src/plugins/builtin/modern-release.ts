import type { PluginReleaseInventory } from '../contracts.js';
import { deepFrozen } from './core.js';
import { builtinRelease } from './release.js';

// Reviewed hashes of the actual modern declarations and C1 source assets.
export const modernRelease: PluginReleaseInventory = deepFrozen({
  schemaVersion: 1,
  sharedAssets: [
    ...builtinRelease.sharedAssets,
    {
      id: 'modern-single-maintainer-policy',
      pathParts: ['assets', 'governance', 'single-maintainer-gitflow', 'policy-v7.md'],
      sha256: 'sha256:d39036cf736fa95480b3289c63a34cac9ecee7f4cd4cdd1d779f94aed98b4706'
    },
    {
      id: 'modern-team-policy',
      pathParts: ['assets', 'governance', 'team-gitflow', 'policy-v1.md'],
      sha256: 'sha256:707bd85e1fee60ccf023eebcb4f33a0458a0014ee0f92fe9e398d2e7fe4b7646'
    },
    {
      id: 'modern-governance-source-contracts',
      pathParts: ['assets', 'governance', 'modern', 'source-contracts.json'],
      sha256: 'sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6'
    }
  ],
  plugins: [
    ...builtinRelease.plugins.filter((entry) => entry.category !== 'agent'),
    {
      category: 'agent', id: 'github-copilot', apiVersion: 1, contentVersion: 2,
      contentDigest: 'sha256:e27664b5c85487cdf40fbf7da40691b3fb26d71d0026686152842d167bc46ce8', assets: []
    },
    {
      category: 'agent', id: 'claude', apiVersion: 1, contentVersion: 2,
      contentDigest: 'sha256:001e1e7b1ee4e8b9f2f4ed250ed9d1eada084ef33992682165821277379cbfb1', assets: []
    },
    {
      category: 'agent', id: 'codex', apiVersion: 1, contentVersion: 2,
      contentDigest: 'sha256:4ad1642e726ac08037442f67a63b714bc544821a185281defdc6c682227e3b39', assets: []
    },
    {
      category: 'workflow', id: 'manual', apiVersion: 1, contentVersion: 1,
      contentDigest: 'sha256:0a97939a6f22ff7a388d41136fc513ddd1f043e2ef2f9a3f3694a3557ca0b3e9', assets: []
    }
  ]
});
