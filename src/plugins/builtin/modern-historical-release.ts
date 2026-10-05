import type { AssetDigest, ResolvedPlugin, Sha256Digest } from '../contracts.js';
import { deepFrozen } from './core.js';

// Metadata-only source interpretation for the exact pre-security-refresh declaration family.
export const modernHistoricalRelease = deepFrozen({
  sourceRevision: '289e703301dd14257d737b620b282bbaee86a845',
  declarationsDigest: 'sha256:086953fe16b5f03121d50a62ce5abf47ffe159f5606723781abb4eb958181301' as Sha256Digest,
  sharedAssets: [
    { id: 'frontend-package-manifest', sha256: 'sha256:8217179388207e3d8e8599544e7741b29beb6dded81f01bcf5d4356785a68561' },
    { id: 'frontend-package-lock', sha256: 'sha256:7e454f0ab739038e99569d174045673776b4565786b1f81764b4c3ee785638b5' },
    { id: 'modern-single-maintainer-policy', sha256: 'sha256:d39036cf736fa95480b3289c63a34cac9ecee7f4cd4cdd1d779f94aed98b4706' },
    { id: 'modern-team-policy', sha256: 'sha256:707bd85e1fee60ccf023eebcb4f33a0458a0014ee0f92fe9e398d2e7fe4b7646' },
    { id: 'modern-governance-source-contracts', sha256: 'sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6' }
  ] satisfies readonly AssetDigest[],
  plugins: [
    { category: 'stack', id: 'python-fastapi', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:3cf538179f9cd748aea425bae9723bee29d232b91db6a794df88c65fc6e82c63' },
    { category: 'stack', id: 'node-fastify', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:34dcdb9e17e17441709eba87c462e08de49a55abc187989b84f1482f64fbb24e' },
    { category: 'stack', id: 'go-huma', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:89f2689d613fcd5708bf9a94b5138cc0d39fb3c0c18374c75a190e7ee8ba1432' },
    { category: 'cloud', id: 'azure', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:f7b67895895c43bff579a5108d0dffd5171dbd6cbdf56fd99e725e41a672f6d7' },
    { category: 'workflow', id: 'openspec', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:8675a3187f44932c7bee9f9a8e5d3f307bcb36d66ced0f20593663221c509d5e' },
    { category: 'workflow', id: 'spec-kit', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:420fd4584bf02e8efc65bf9893848a4748ce676c030095de9ef1fba20ca7a137' },
    { category: 'agent', id: 'github-copilot', apiVersion: 1, contentVersion: 2, contentDigest: 'sha256:e27664b5c85487cdf40fbf7da40691b3fb26d71d0026686152842d167bc46ce8' },
    { category: 'agent', id: 'claude', apiVersion: 1, contentVersion: 2, contentDigest: 'sha256:001e1e7b1ee4e8b9f2f4ed250ed9d1eada084ef33992682165821277379cbfb1' },
    { category: 'agent', id: 'codex', apiVersion: 1, contentVersion: 2, contentDigest: 'sha256:4ad1642e726ac08037442f67a63b714bc544821a185281defdc6c682227e3b39' },
    { category: 'workflow', id: 'manual', apiVersion: 1, contentVersion: 1, contentDigest: 'sha256:0a97939a6f22ff7a388d41136fc513ddd1f043e2ef2f9a3f3694a3557ca0b3e9' }
  ] satisfies readonly ResolvedPlugin[]
});
