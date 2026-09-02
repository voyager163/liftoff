## Context

See `proposal.md` for motivation. Liftoff packages one canonical
`single-maintainer-gitflow` policy, validates required fragments, and renders it
as a managed-core handoff. The selected-agent launcher is intentionally thin
and reads that policy rather than duplicating its requirements.

Policy version 2 treats the VNet-injected GitHub-hosted larger runner as an
externally created organization prerequisite. Current Azure behavior requires
new networks to use explicit outbound connectivity, and GitHub's Azure VNet
integration spans both Azure resources and organization hosted-compute APIs.
Each generated repository owns an independent Azure subscription boundary, so a
shared organization firewall would introduce the cross-subscription coupling
that the repository-scoped policy is intended to avoid.

## Goals / Non-Goals

**Goals:**

- Make the private Staging runner prerequisite achievable without weakening the
  read-only discovery and explicit approval boundary.
- Preserve independent subscription ownership and deterministic fail-closed
  behavior.
- Give downstream agents enough normative detail to choose, provision, verify,
  and remove a safe runner topology.
- Keep `liftoff init` and `liftoff update` local-only.

**Non-Goals:**

- Add Azure or GitHub provisioning code to the Liftoff CLI.
- Provision runners for repositories where private Staging DAST is inapplicable.
- Authorize organization rulesets, required workflows, Apps, or runner
  infrastructure unrelated to the target repository.
- Share firewalls, virtual networks, routes, state, or lifecycle across
  repository subscriptions.
- Replace repository-specific OpenSpec planning with one universal concrete
  network layout.

## Decisions

### Change the canonical policy, not the launcher

The normative change will be made in the canonical policy asset and reflected
in the repository-governance specifications. The generated Copilot and Claude
launchers will remain thin readers of `policy.md` and `context.json`.

Duplicating the provisioning contract in launchers was rejected because the
copies could drift and would bypass the existing canonical-fragment validator.

### Authorize one narrow organization provisioning exception

The repository-scoped invariant will retain one exception: after Phase 0 and
explicit approval, the activation change may create the hosted-compute network
configuration, selected-access runner group, and bounded larger runner required
for the target repository's private Staging DAST. Existing suitable assignments
are consumed rather than duplicated. Other organization controls remain
forbidden.

Keeping the prerequisite permanently external was rejected because it makes the
default release policy impossible for independently owned subscriptions.
Broad organization administration was rejected because it would erase the
policy's blast-radius boundary.

### Make applicability and authority explicit Phase 0 evidence

Phase 0 will determine whether private Staging DAST applies and whether a
suitable runner already exists. Before proposing provisioning it must verify:

- the Staging subscription and tenant, supported region, and billing owner;
- Azure subscription and network roles plus `GitHub.Network` registration;
- GitHub organization identity, hosted-runner and network-configuration
  permissions, and any enterprise policy controlling organization network
  configurations;
- existing network settings, configurations, groups, runners, and repository
  assignments;
- non-overlapping address space, actual Staging topology, private DNS, routing,
  and target reachability;
- state location, deterministic names, resource limits, expected fixed and
  usage cost, and teardown authority;
- whether strict domain-restricted egress is an applicable policy requirement.

Approval must cover this evidence and the exact desired topology. Missing
authority or unresolved inputs produce a blocker and no partial mutation.

Assuming permissions from successful read access was rejected because create,
update, and organization policy permissions differ.

### Keep Azure networking within the repository's Staging subscription

Every Azure resource used by the runner network will live in the same
repository-owned Staging subscription as the private target. A repository may
use the Staging VNet directly or a dedicated runner VNet connected through
same-subscription peering or routing, but the approved plan must prove the
private path and DNS behavior.

```text
Repository Staging subscription
│
├── private Staging target and DNS
│            ▲
│            │ same-subscription route or peering
│            │
└── delegated runner subnet
             ├── inbound denied
             ├── GitHub.Network/networkSettings
             └── one explicit public egress mode
```

A shared connectivity subscription was rejected because it couples independent
repositories through RBAC, address allocation, billing, availability, and
rollback.

### Select exactly one explicit outbound mode

New runner subnets will disable implicit default outbound access. Phase 0 will
select one mode:

1. **Azure Firewall Basic** when an applicable network policy requires
   domain-restricted egress. HTTPS application rules use the current GitHub meta
   domain set, do not use the retired static GitHub IP template, and do not
   intercept TLS. Firewall Basic has no DNS proxy, so private Staging resolution
   remains an explicit VNet DNS responsibility.
2. **Azure NAT Gateway** when domain-restricted egress is not required. An NSG
   limits the required outbound protocols and denies inbound traffic, but the
   policy does not misrepresent NAT or NSG rules as GitHub-domain filtering.

NAT Gateway and a default route through Azure Firewall are mutually exclusive
on the runner subnet because NAT Gateway takes precedence for new outbound
connections and would bypass the intended firewall path.

Always provisioning Firewall Basic was rejected because its fixed monthly cost
would apply even when no domain-filtering requirement exists. Implicit Azure
outbound access was rejected because it is nondeterministic and is no longer the
default for new virtual networks.

### Require network isolation and a real Staging path

The plan must attach an NSG that denies unsolicited inbound connectivity to the
runner subnet. It must also model the real Staging route, private DNS zone or
resolver path, peering or routing flags, and security rules. A standalone
runner VNet is insufficient evidence of private reachability.

The standard-hosted preflight will validate GitHub assignment and labels before
scheduling DAST. The larger-runner job must then prove DNS resolution and live
Staging connectivity. Missing or stale evidence keeps qualification blocked.

Treating successful Azure resource creation as connectivity evidence was
rejected because it does not validate GitHub assignment, DNS, routes, or target
policy.

### Split desired state across Azure IaC and idempotent GitHub APIs

Downstream governance changes will use OpenTofu for repository-owned Azure
resources, including the `GitHub.Network/networkSettings` resource when the
AzureRM provider lacks coverage. Organization network configuration, runner
group, selected repository and workflow access, and larger runner are applied
through supported GitHub APIs using deterministic names and read-before-write
reconciliation.

The default runner is the smallest organization-supported Ubuntu x64 size
proven sufficient for ZAP, with maximum concurrency one unless Phase 0 provides
evidence for a different bound. Every ID, association, label, status, network
configuration, repository restriction, and billing owner is read back.

Manual portal-only setup was rejected because it cannot supply repeatable drift
detection or dependency-ordered rollback.

### Treat provisioning and teardown as state machines

Provisioning advances only after each dependency is ready:

```text
approved plan
  -> remote state and Azure network
  -> delegated subnet and explicit egress
  -> Azure networkSettings and GitHubId
  -> GitHub network configuration
  -> selected-access runner group
  -> bounded larger runner
  -> API readback
  -> DNS and Staging reachability
  -> DAST eligible
```

Rollback reverses those dependencies: stop scheduling, remove repository and
workflow access, delete the larger runner, detach and delete the group and
network configuration, delete the Azure network setting and wait for service
association removal, then delete repository-owned network resources. A failed
partial apply remains visibly blocked and is reconciled or rolled back; it is
never treated as success.

### Advance the managed policy contract

The canonical policy version will advance from 2 to 3. Required and forbidden
fragments will change from consume-only wording to conditional provisioning,
independent subscription ownership, exclusive outbound modes, inbound denial,
private connectivity, readback, and teardown.

Existing projects receive policy v3 only through normal managed-core update
review. An update never applies Azure or GitHub changes. A downstream change
that previously recorded an exception against policy v2 must reconcile its
artifacts and implementation against policy v3 before provisioning.

## Risks / Trade-offs

- **[Firewall Basic has material idle cost]** -> Require Phase 0 evidence for
  domain filtering and disclose fixed and usage costs before approval.
- **[NAT permits broader destinations than a domain firewall]** -> State that
  limitation explicitly, constrain protocols with NSG rules, and choose
  Firewall Basic when destination filtering is required.
- **[GitHub domain requirements change]** -> Record the selected meta domain set
  and require scheduled freshness validation for firewall mode.
- **[Organization permissions may be blocked by enterprise policy]** -> Verify
  policy and write permissions before Azure mutation.
- **[Runner and Staging networks can overlap or resolve differently]** -> Require
  address and DNS evidence plus live reachability before DAST eligibility.
- **[Partial resources can retain cost or service associations]** -> Use remote
  state, readback, explicit intermediate states, and dependency-ordered cleanup.
- **[Policy v3 causes managed-core drift]** -> Preserve Liftoff's existing
  review and conflict behavior; do not infer live activation from generated
  files.

## Migration Plan

1. Update the canonical policy and advance its version to 3 while preserving
   the Liftoff frontmatter and activation protocol.
2. Update policy validation, focused behavior tests, deterministic hashes,
   manifest expectations, generated snapshots, and public documentation.
3. Validate the OpenSpec delta and run the existing repository-governance,
   documentation, manifest, contract, and package checks.
4. Release Liftoff with policy v3; existing projects review the managed-core
   update locally.
5. Reconcile any active downstream runner-provisioning change against policy v3
   before applying cloud or organization resources.
6. Roll back Liftoff by restoring policy version 2, its validation fragments,
   tests, hashes, and documentation together; this rollback changes no live
   downstream resource.
