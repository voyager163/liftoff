# Repository governance handoff

Repository governance is a common Liftoff project choice. The default
`single-maintainer-gitflow` profile generates a deterministic local handoff;
`none` opts out:

**Local handoff generated; live enforcement is not active.**

```bash
liftoff plan --governance single-maintainer-gitflow
liftoff init --governance none
```

Accepting the default or passing `--yes` authorizes only local project files. It
does not run an agent, mutate Git, contact GitHub or Azure, configure security,
install a ruleset, deploy, provision a runner, or create monitoring.

## Generated files

An enabled profile adds durable, hash-managed artifacts:

```text
.liftoff/governance/policy.md
.liftoff/governance/context.json
.liftoff/governance/README.md
.github/prompts/liftoff-repository-governance.prompt.md  # Copilot selected
.claude/commands/liftoff-repository-governance.md        # Claude selected
```

The complete canonical policy is also packaged with Liftoff at
[`assets/governance/single-maintainer-gitflow/policy.md`](../assets/governance/single-maintainer-gitflow/policy.md).
It covers GitFlow, zero-human-approval repository rules, designated security
tools, fail-closed checks, immutable release evidence, build-once promotion,
deployment and rollback, monitoring and health, DORA metrics, ruleset
sequencing, negative tests, documentation, and workload adaptation.

Policy version 3 also fixes platform decisions that generated projects should
not repeatedly ask users to make:

- Dev storage uses LRS; Staging and Production use ZRS. IaC state uses ZRS in
  every environment.
- Database HA is off in Dev and Staging and zone-redundant in Production.
- CI uses one user-assigned managed identity with OIDC federation per repository
  and environment, without app registrations or long-lived credentials.
- The default workload is small and cost-optimised with production safeguards.
  Runtimes remain on Active LTS majors, with grouped dependency updates and
  non-LTS major updates ignored.
- Slack webhooks are required environment-level GitHub Actions secrets so the
  alert path does not depend on private-vault connectivity.

These are applicable defaults, not reasons to create unused resources. A
managed service is included only when application code consumes it, after its
cost and known service limits are stated. When live infrastructure differs from
IaC, activation planning adapts the IaC and imports the live resource rather
than creating a parallel stack or forcing replacement.

## Private Staging qualification

DAST for a privately networked Staging environment uses an ephemeral
GitHub-hosted larger runner with Azure VNet injection. Activation reuses a
suitable existing repository assignment. If none exists, policy version 3
permits one narrow post-approval exception to provision the Azure network
setting, organisation hosted-compute network configuration, selected-access
runner group, and bounded larger runner required by that repository.

Phase 0 first proves that private Staging DAST applies. It then discovers the
repository's Staging subscription and tenant, existing runner resources, Azure
and GitHub write authority, enterprise network policy, billing, state, names,
address space, DNS, routing, costs, limits, and teardown ownership. Missing
authority or an unresolved input blocks provisioning without partial mutation.
No self-hosted runner is substituted.

Every Azure runner-network resource, its state, egress cost, and teardown owner
remain inside the repository's Staging subscription. The design cannot share a
firewall, hub, route, state, or lifecycle with another repository or
subscription. GitHub resources exist at organisation level but grant selected
access only to the target repository and required workflows.

The delegated runner subnet disables implicit default outbound access, denies
unsolicited inbound connectivity, and uses exactly one egress mode:

- Azure Firewall Basic only when an applicable policy requires domain-restricted
  egress. Its HTTPS rules use a current GitHub meta domain set without the
  retired static-IP template or TLS interception.
- Azure NAT Gateway otherwise, with required protocols constrained by an NSG.
  NAT and NSG controls do not filter HTTPS by domain.

NAT Gateway cannot be attached to a firewall-routed runner subnet because it
takes precedence and would bypass the firewall. The approved topology must also
prove non-overlapping address space, same-subscription routing or peering,
private DNS, security rules, and live private Staging reachability.

A standard hosted preflight verifies the assignment and labels before scheduling
DAST. Azure and GitHub resources, associations, egress, DNS, and reachability
must all be read back successfully. Missing or partial evidence blocks
qualification rather than leaving a required job queued or reporting success.
Teardown reverses those dependencies and removes the Azure network only after
GitHub scheduling, assignment, and service associations are gone.

## Release identity and automated completion

Staging qualifies the release or hotfix candidate commit and binds it to the
version, artifact digest, and evidence-bundle digest. A later true merge into
`main` necessarily has a different SHA. Production verifies that the merge
incorporates the exact qualified candidate, promotes the identical artifact,
and records both identities:

```text
candidate SHA -> qualification -> artifact digest
       |                              |
       +---------- main merge SHA ----+
                         |
                         +-> deployment -> tag and GitHub Release
```

Package formats may require embedded version metadata, but that value must
match the authoritative `release/X.Y.Z` or `hotfix/X.Y.Z` branch name.

Release and hotfix back-merges remain pull-request-only and require successful
checks. Because `GITHUB_TOKEN`-created events do not normally start more
workflows, the coordinating workflow explicitly dispatches validation for the
back-merge head and any required post-merge work for the resulting SHA. It does
not push directly to a protected branch or rely on a tag push. Tag creation,
Release publication, and durable evidence stay in the successful production
workflow.

`context.json` contains generated project facts only. GitHub repository state,
runner access, licensed features, deployments, monitoring, alert routes,
traffic, and rollout capabilities remain `undiscovered`. Power Apps context
explicitly marks Liftoff backend, Docker, OpenTofu, custom container promotion,
and API DAST as inapplicable.

## Activate after commit and push

1. Review the policy and context.
2. Commit the project and push it to the intended GitHub repository.
3. Run `/liftoff-repository-governance` with a selected agent.
4. The agent performs read-only Phase 0 and reports repository identity,
   artifacts, working commands, refs, workflows and exact checks, rulesets,
   releases, environments, security, runners, deployments, monitoring, alerts,
   health depth, platform capabilities, gaps, and inapplicable controls. When
   private Staging DAST applies without a suitable runner, it also reports the
   complete subscription-local topology, one explicit egress mode, authority,
   costs, limits, verification, and teardown plan.
5. The agent proposes the current `main` SHA as the activation baseline,
   presents an ordered plan, and stops.
6. Explicitly approve or revise the conversational plan. This is not a human
   merge or deployment approval gate.
7. After approval, the agent creates a new OpenSpec or Spec Kit governance
   change, proves required contexts green and deliberately red, applies
   repository-scoped rulesets last, and reads live enforcement back.

The user-owned `governance/activation-baseline.json` is created only after
approval. Liftoff never owns or recreates it or the agent-created governance
change. Complete local handoffs say `handoff-generated`, partial adoptions say
`handoff-partial`, and neither state means `active`.

## Existing projects

Configurations without `governanceProfile` normalize to the enabled default
without rewriting `liftoff.config.json`:

```bash
liftoff update --check
liftoff update
```

Check mode previews the schema-v6 manifest and new named core artifacts without
writing. Plain update applies collision-free files; differing existing files
remain managed-core conflicts unless individually reviewed with `--force`. An unrecorded
conflict remains outside Liftoff ownership and produces `handoff-partial`.
After every conflict is removed or matches the current artifact, the next
update records the full artifact set as `handoff-generated`.

Projects generated with policy version 2 review the version-3 managed-core drift
before replacement. `liftoff update` changes only the local handoff; it never
provisions Azure or GitHub resources. Any active downstream runner change based
on the external-only version-2 contract must reconcile its plan and
implementation with version 3 before applying cloud or organisation resources.

Setting `"governanceProfile": "none"` stops future rendering. Previously managed
handoff files are reported once as orphans and left on disk; Liftoff never
deletes them automatically or changes live repository settings.

## Capability gaps

Phase 0 must report missing GitHub licenses, runner-provisioning authority,
VNet-injected assignment or reachability, Staging access, monitoring routes,
parallel-version mechanisms, or statistically meaningful canary traffic. It
must mark controls inapplicable or blocked rather than creating a skipped,
hanging, partial, duplicate, or success-shaped placeholder.

The official SLSA L3 generator is the policy's only action SHA-pinning
exception because its reusable workflow contains mutable internal references.
The outer call is pinned as tightly as supported and the exact exception is
narrow and expiring. It does not weaken pinning for any other action, create a
second vulnerability allowlist, or make Grype a blocking gate.
