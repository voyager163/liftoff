## 1. Revise the canonical governance policy

- [x] 1.1 Advance the canonical `single-maintainer-gitflow` policy from version 2 to version 3 and replace the consume-only external-runner wording with the narrow post-approval provisioning exception; verify the Liftoff frontmatter, read-only Phase 0, activation baseline, and repository-scoped governance invariants remain present
- [x] 1.2 Expand Phase 0 runner discovery to cover applicability, existing assignments, Staging subscription and tenant, Azure and GitHub permissions, enterprise network-configuration policy, billing, state, names, address space, DNS, routing, cost, limits, and teardown authority; verify unresolved evidence blocks mutation
- [x] 1.3 Define repository-dedicated Azure ownership and prohibit shared or cross-subscription firewall, hub, route, state, billing, and lifecycle dependencies; verify the policy does not instruct independently owned repositories to consume common Azure networking
- [x] 1.4 Define the exclusive outbound decision: Firewall Basic only for evidenced domain-restricted egress, otherwise NAT Gateway with controlled HTTPS egress; verify the policy prohibits attaching NAT Gateway to a firewall-routed runner subnet and never represents NAT or NSG controls as domain filtering
- [x] 1.5 Add private-subnet, inbound-denial, non-overlapping address, same-subscription Staging routing, private DNS, no-TLS-interception, current GitHub-domain, and live-reachability requirements; verify resource creation alone cannot satisfy the runner prerequisite
- [x] 1.6 Define idempotent Azure and GitHub application, deterministic ownership, selected repository and workflow access, bounded Ubuntu runner capacity, complete API readback, fail-closed intermediate states, and dependency-ordered teardown; verify unrelated organization controls remain forbidden

## 2. Advance and enforce the managed policy contract

- [x] 2.1 Update the governance policy version constant and profile catalog metadata to version 3; verify generated context, manifest governance metadata, and canonical frontmatter all report the same version
- [x] 2.2 Replace consume-only required fragments with focused version-3 fragments for conditional provisioning, per-subscription ownership, exclusive Firewall/NAT modes, inbound denial, private connectivity, readback, and teardown; verify removing each critical behavior makes policy validation fail
- [x] 2.3 Add forbidden legacy or unsafe fragments for unconditional external-only blocking, cross-subscription sharing, simultaneous NAT and firewall routing, self-hosted fallback, and success without connectivity evidence; verify validation rejects each unsafe policy mutation
- [x] 2.4 Update deterministic managed-core hashes, desired-state expectations, and generated artifact snapshots for the new canonical bytes; verify normal update reconciliation reports policy drift without claiming live enforcement
- [x] 2.5 Preserve the thin Copilot and Claude launchers as canonical-policy readers rather than duplicating the runner contract; verify generated launchers reference `policy.md` and `context.json` and still stop after Phase 0

## 3. Update specifications and user guidance

- [x] 3.1 Update `docs/repository-governance.md` to explain applicability, independent Staging-subscription ownership, organization GitHub resources, Firewall Basic versus NAT Gateway selection, permissions, cost, private connectivity, verification, and teardown; verify every statement matches policy version 3
- [x] 3.2 Update prerequisite, troubleshooting, update, and migration guidance affected by the former external-only blocker; verify documentation distinguishes local Liftoff generation from later approved cloud and organization mutation
- [x] 3.3 Document that existing policy-version-2 projects review managed-core drift locally and reconcile active downstream runner changes before provisioning; verify no guidance implies `liftoff update` applies Azure or GitHub resources
- [x] 3.4 Update packaged documentation and generated-guide snapshots while preserving cross-platform path assertions; verify both Copilot and Claude outputs remain equivalent

## 4. Strengthen behavioral coverage

- [x] 4.1 Extend canonical policy tests for inapplicable DAST, reuse of an existing assignment, missing provisioning authority, approved dedicated provisioning, and fail-closed partial state; verify each scenario has a focused passing and rejection assertion
- [x] 4.2 Add outbound-mode tests covering Firewall Basic selection, NAT Gateway selection, absent implicit outbound, and the prohibited NAT-plus-firewall combination; verify tests also reject claims that NSGs provide FQDN filtering
- [x] 4.3 Add network-contract tests for inbound denial, address overlap, private DNS and Staging routing, GitHub domain freshness, TLS interception prohibition, standard-hosted preflight, and live reachability; verify missing evidence prevents DAST eligibility
- [x] 4.4 Update catalog, planner, manifest, migration, file-system, contract, and repository-governance expectations from policy version 2 to version 3; verify schema-v5 and schema-v6 compatibility behavior remains intentional
- [x] 4.5 Regenerate affected fixtures and snapshots using existing repository tooling and verify assertions use cross-platform path construction on macOS, Linux, and Windows

## 5. Validate and package the change

- [x] 5.1 Run `openspec validate provision-vnet-hosted-runners --strict` and resolve every proposal, design, delta-spec, or task error
- [x] 5.2 Run the focused repository-governance, documentation, catalog, planner, manifest, migration, file-system, and contract tests and verify the version-3 behavior passes
- [x] 5.3 Run `npm run check` and verify the complete TypeScript build, lint, and test suite passes without adding new tooling
- [x] 5.4 Run the existing package smoke test and `npm pack --dry-run --json`; verify the version-3 policy and updated public documentation remain in the published package
- [x] 5.5 Generate a representative governed project and verify its managed policy contains the complete version-3 contract, its launcher remains thin, and initialization performs only existing read-only Azure readiness probes without provisioning Azure or mutating GitHub
