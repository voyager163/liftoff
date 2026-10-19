import { deepFrozen } from './core.js';

// Exact accepted metadata before the Python refresh, not old asset or execution authority.
export const modernPythonPreviousReleases = deepFrozen({
  "preAssessment": {
    "family": "pre-assessment",
    "sourceRevision": "fa24348df9b8a7909924a56e3fbfd865fe9615d2",
    "declarationsDigest": "sha256:086953fe16b5f03121d50a62ce5abf47ffe159f5606723781abb4eb958181301",
    "sharedAssets": [
      {
        "id": "frontend-package-manifest",
        "sha256": "sha256:8217179388207e3d8e8599544e7741b29beb6dded81f01bcf5d4356785a68561"
      },
      {
        "id": "frontend-package-lock",
        "sha256": "sha256:494f2312ba163062c10164df363c49b0987109b529f320381ec5795bbf0ea689"
      },
      {
        "id": "modern-single-maintainer-policy",
        "sha256": "sha256:d39036cf736fa95480b3289c63a34cac9ecee7f4cd4cdd1d779f94aed98b4706"
      },
      {
        "id": "modern-team-policy",
        "sha256": "sha256:707bd85e1fee60ccf023eebcb4f33a0458a0014ee0f92fe9e398d2e7fe4b7646"
      },
      {
        "id": "modern-governance-source-contracts",
        "sha256": "sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6"
      }
    ],
    "plugins": [
      {
        "category": "stack",
        "id": "go-huma",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:89f2689d613fcd5708bf9a94b5138cc0d39fb3c0c18374c75a190e7ee8ba1432"
      },
      {
        "category": "stack",
        "id": "node-fastify",
        "apiVersion": 1,
        "contentVersion": 4,
        "contentDigest": "sha256:741c6dc7221d9178db1ea88dee47c98e3bdb1ba382ba432dc76f277c705feb92"
      },
      {
        "category": "stack",
        "id": "python-fastapi",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:44f91983bc9b69360cb6c0f35c61b8e0132bd4bfd1f7c93c1bf696d525bed7ea"
      },
      {
        "category": "cloud",
        "id": "azure",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:f7b67895895c43bff579a5108d0dffd5171dbd6cbdf56fd99e725e41a672f6d7"
      },
      {
        "category": "workflow",
        "id": "manual",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:0a97939a6f22ff7a388d41136fc513ddd1f043e2ef2f9a3f3694a3557ca0b3e9"
      },
      {
        "category": "workflow",
        "id": "openspec",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:8675a3187f44932c7bee9f9a8e5d3f307bcb36d66ced0f20593663221c509d5e"
      },
      {
        "category": "workflow",
        "id": "spec-kit",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:420fd4584bf02e8efc65bf9893848a4748ce676c030095de9ef1fba20ca7a137"
      },
      {
        "category": "agent",
        "id": "claude",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:001e1e7b1ee4e8b9f2f4ed250ed9d1eada084ef33992682165821277379cbfb1"
      },
      {
        "category": "agent",
        "id": "codex",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:4ad1642e726ac08037442f67a63b714bc544821a185281defdc6c682227e3b39"
      },
      {
        "category": "agent",
        "id": "github-copilot",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:e27664b5c85487cdf40fbf7da40691b3fb26d71d0026686152842d167bc46ce8"
      }
    ]
  },
  "preWorkflow": {
    "family": "pre-workflow",
    "sourceRevision": "fa24348df9b8a7909924a56e3fbfd865fe9615d2",
    "declarationsDigest": "sha256:57365e5bf84030cb1647e5cde6c18ac3b851f3696e61cb02678748c8942c6f25",
    "sharedAssets": [
      {
        "id": "frontend-package-manifest",
        "sha256": "sha256:8217179388207e3d8e8599544e7741b29beb6dded81f01bcf5d4356785a68561"
      },
      {
        "id": "frontend-package-lock",
        "sha256": "sha256:494f2312ba163062c10164df363c49b0987109b529f320381ec5795bbf0ea689"
      },
      {
        "id": "modern-single-maintainer-policy",
        "sha256": "sha256:d39036cf736fa95480b3289c63a34cac9ecee7f4cd4cdd1d779f94aed98b4706"
      },
      {
        "id": "modern-team-policy",
        "sha256": "sha256:707bd85e1fee60ccf023eebcb4f33a0458a0014ee0f92fe9e398d2e7fe4b7646"
      },
      {
        "id": "modern-governance-source-contracts",
        "sha256": "sha256:74023432198c9eed026a3600a9f37cc1bb39dcda373a16929dd72b1f1b49731f"
      },
      {
        "id": "liftoff-project-assessment",
        "sha256": "sha256:d84e9d9dae16d51165fc0d7aceba9594e92b8910194c917b1cbb99793f900713"
      }
    ],
    "plugins": [
      {
        "category": "stack",
        "id": "go-huma",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:89f2689d613fcd5708bf9a94b5138cc0d39fb3c0c18374c75a190e7ee8ba1432"
      },
      {
        "category": "stack",
        "id": "node-fastify",
        "apiVersion": 1,
        "contentVersion": 4,
        "contentDigest": "sha256:741c6dc7221d9178db1ea88dee47c98e3bdb1ba382ba432dc76f277c705feb92"
      },
      {
        "category": "stack",
        "id": "python-fastapi",
        "apiVersion": 1,
        "contentVersion": 2,
        "contentDigest": "sha256:44f91983bc9b69360cb6c0f35c61b8e0132bd4bfd1f7c93c1bf696d525bed7ea"
      },
      {
        "category": "cloud",
        "id": "azure",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:f7b67895895c43bff579a5108d0dffd5171dbd6cbdf56fd99e725e41a672f6d7"
      },
      {
        "category": "workflow",
        "id": "manual",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:0a97939a6f22ff7a388d41136fc513ddd1f043e2ef2f9a3f3694a3557ca0b3e9"
      },
      {
        "category": "workflow",
        "id": "openspec",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:8675a3187f44932c7bee9f9a8e5d3f307bcb36d66ced0f20593663221c509d5e"
      },
      {
        "category": "workflow",
        "id": "spec-kit",
        "apiVersion": 1,
        "contentVersion": 1,
        "contentDigest": "sha256:420fd4584bf02e8efc65bf9893848a4748ce676c030095de9ef1fba20ca7a137"
      },
      {
        "category": "agent",
        "id": "claude",
        "apiVersion": 1,
        "contentVersion": 3,
        "contentDigest": "sha256:28a08ce4964a48b6e24bb4441cc6988c63ef59d5605b595fc0f0559181645c54"
      },
      {
        "category": "agent",
        "id": "codex",
        "apiVersion": 1,
        "contentVersion": 3,
        "contentDigest": "sha256:de760a5347c2314841339bf22211a0b883937e2ca7ac2d8a236595e4598ad84e"
      },
      {
        "category": "agent",
        "id": "github-copilot",
        "apiVersion": 1,
        "contentVersion": 3,
        "contentDigest": "sha256:e60e0ec46c170b90888c87bc498a7e6bd4febd4118952f828082fba71f6d90a2"
      }
    ]
  }
} as const);
