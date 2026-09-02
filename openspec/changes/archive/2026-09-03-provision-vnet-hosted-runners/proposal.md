## Why

Liftoff's default governance policy requires a VNet-injected GitHub-hosted larger
runner for private Staging DAST, but it also forbids the activation agent from
provisioning that prerequisite. Repositories that own independent Azure
subscriptions therefore cannot complete release qualification even when the
user has the required Azure and GitHub organization permissions.

## What Changes

- Replace the consume-only runner prerequisite with a narrowly scoped,
  post-approval capability to provision repository-dedicated Azure networking
  and organization hosted-compute resources when private Staging DAST applies
  and no suitable runner assignment exists.
- Keep each repository's runner network, egress, state, cost, and teardown
  ownership inside that repository's Staging subscription; prohibit shared or
  cross-subscription firewall dependencies.
- Require Phase 0 to choose exactly one explicit outbound mode: Azure Firewall
  Basic when strict domain-restricted egress is required, otherwise Azure NAT
  Gateway with controlled HTTPS egress. The two modes cannot coexist on the
  runner subnet.
- Require inbound denial, non-overlapping address allocation, private Staging
  routing and DNS, current GitHub domain data where applicable, no TLS
  interception, and live reachability evidence.
- Require idempotent Azure and GitHub application, selected access for only the
  target repository, bounded larger-runner concurrency, cost disclosure,
  dependency-ordered rollback, and API readback before DAST can run.
- Preserve read-only Phase 0, explicit conversational approval, fail-closed
  qualification, repository-scoped governance controls, and the prohibition on
  unrelated organization-level substitutions.
- Advance the canonical governance policy version and update generated
  handoffs, validation, tests, snapshots, and public documentation without
  mutating any live Azure or GitHub resource during `liftoff init` or
  `liftoff update`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-repository-governance-profile`: Authorize and constrain conditional,
  repository-dedicated provisioning of the VNet-injected hosted runner required
  for private Staging qualification.
- `liftoff-user-documentation`: Explain runner provisioning applicability,
  per-subscription ownership, outbound-mode selection, approval, cost, and
  migration behavior.

## Impact

The canonical `single-maintainer-gitflow` policy, policy version and validation
fragments, repository-governance specifications, generated managed-core
handoffs, manifest and catalog expectations, contract tests, snapshots, and
repository-governance documentation are affected. Downstream activation agents
may create Azure networking and GitHub organization hosted-compute resources
only after repository-specific discovery and approval; Liftoff itself remains a
local generator and performs no cloud or GitHub mutation.
