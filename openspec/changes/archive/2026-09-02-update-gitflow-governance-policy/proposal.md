## Why

Liftoff's packaged single-maintainer GitFlow policy still assumes a self-hosted
private-network runner and leaves several recurring platform decisions open for
rediscovery. The updated baseline settles those decisions, removes known sources
of governance theatre, and must be incorporated without losing Liftoff's
versioned local-handoff and approval safeguards.

## What Changes

- Replace the self-hosted Staging DAST runner assumption with an externally
  provisioned GitHub-hosted larger runner group using Azure VNet injection, and
  treat its absence as an explicit release-qualification blocker.
- Add fixed environment defaults for storage redundancy, IaC state, database
  availability, OIDC identities, workload scale, budget posture, Slack secret
  storage, and Active-LTS dependency policy.
- Require cost and service-limit disclosure before provisioning managed services,
  and require import-first reconciliation when live infrastructure differs from
  IaC.
- Add the narrow, expiring `slsa-github-generator` exception to action
  SHA-pinning while keeping every other mutable action reference blocked.
- Clarify the release evidence model so a qualified candidate commit and its
  digest can be traced through the distinct true merge commit on `main`.
- Define an automated protected-branch back-merge path that works with
  `GITHUB_TOKEN` event-recursion constraints without direct pushes, human
  approvals, or fail-open checks.
- Preserve and version Liftoff-specific policy frontmatter, read-only Phase 0,
  explicit conversational approval, activation-baseline grandfathering, and
  workload adaptation when integrating the supplied baseline.
- Update validation, tests, and public governance documentation to enforce and
  explain the revised policy contract.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-repository-governance-profile`: Revise the canonical policy,
  activation discovery, fixed invariants, runner model, release identity,
  automation behavior, platform defaults, and fail-closed validation contract.
- `liftoff-user-documentation`: Document the revised complete policy, its
  external VNet-runner prerequisite, fixed defaults, and candidate-to-production
  evidence chain.

## Impact

The canonical policy asset, governance renderer and validator, governance tests,
managed-core hashes and snapshots, repository-governance documentation, and
generated governance handoffs are affected. Existing generated projects may see
managed-core governance drift during `liftoff update`; live repository settings
remain untouched until their separate read-only Phase 0 and explicit approval.
