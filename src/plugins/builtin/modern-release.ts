import type { PluginReleaseInventory } from '../contracts.js';
import { deepFrozen } from './core.js';
import { builtinRelease } from './release.js';

// Reviewed hashes of the actual modern declarations and canonical source assets.
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
    },
    {
      id: 'liftoff-project-assessment',
      pathParts: ['assets', 'skills', 'assessment.md'],
      sha256: 'sha256:d84e9d9dae16d51165fc0d7aceba9594e92b8910194c917b1cbb99793f900713'
    }
  ],
  plugins: [
    ...builtinRelease.plugins.filter((entry) => entry.category !== 'agent'),
    {
      category: 'agent', id: 'github-copilot', apiVersion: 1, contentVersion: 3,
      contentDigest: 'sha256:e60e0ec46c170b90888c87bc498a7e6bd4febd4118952f828082fba71f6d90a2', assets: []
    },
    {
      category: 'agent', id: 'claude', apiVersion: 1, contentVersion: 3,
      contentDigest: 'sha256:28a08ce4964a48b6e24bb4441cc6988c63ef59d5605b595fc0f0559181645c54', assets: []
    },
    {
      category: 'agent', id: 'codex', apiVersion: 1, contentVersion: 3,
      contentDigest: 'sha256:de760a5347c2314841339bf22211a0b883937e2ca7ac2d8a236595e4598ad84e', assets: []
    },
    {
      category: 'workflow', id: 'manual', apiVersion: 1, contentVersion: 1,
      contentDigest: 'sha256:0a97939a6f22ff7a388d41136fc513ddd1f043e2ef2f9a3f3694a3557ca0b3e9', assets: []
    }
  ]
});
