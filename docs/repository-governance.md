# Repository governance and deterministic setup

Repository governance is enabled by default through the
`single-maintainer-gitflow` profile; `--governance none` opts out. Initialization
writes local managed-core artifacts only. It does not run an agent, mutate Git,
contact GitHub or Azure, configure rulesets, provision runners, deploy, or start
monitoring.

Primary path after initialization:

```text
liftoff init my-project
cd my-project
/liftoff-setup
```

`/liftoff-setup` completes the generated bootstrap seed, then enters the
deterministic Liftoff governance engine and its read-only Phase 0 discovery. The older
`/liftoff-repository-governance` launcher is a compatibility alias for the same
engine and user-owned activation state; it is not a separate activation path.

## Managed files and user-owned state

Enabled governance adds managed-core files:

```text
.liftoff/governance/policy.md
.liftoff/governance/context.json
.liftoff/governance/README.md
.liftoff/governance/phase-graph.json
.liftoff/governance/compatibility.json
.liftoff/governance/credential-policy.schema.json
.github/prompts/liftoff-setup.prompt.md                # Copilot selected
.github/prompts/liftoff-repository-governance.prompt.md # compatibility alias
.claude/commands/liftoff-setup.md                      # Claude selected
.claude/commands/liftoff-repository-governance.md       # compatibility alias
```

User-owned execution state is separate and is never advanced by
`liftoff update`:

```text
governance/activation-state.json
governance/approvals/
governance/evidence/
governance/credentials/preflight-policy.json
```

The complete policy is packaged at
[`assets/governance/single-maintainer-gitflow/policy.md`](../assets/governance/single-maintainer-gitflow/policy.md).
Policy version 6 treats numbered policy sections as capability chapters, not
execution order. The managed phase graph is the sole execution-order authority.

## Canonical phase graph

The activation graph is packaged as `.liftoff/governance/phase-graph.json` and
records phase IDs, dependencies, applicability, allowed mutations, evidence,
approvals, rollback boundaries, and terminal states:

```text
seed-valid
  -> seed-verified
  -> seed-archived
  -> committed
  -> pushed
  -> phase-0-complete
  -> activation-approved
  -> credential-ready
  -> provider-ready
  -> state-path-selected
       |-> existing-private-path ----------------------|
       `-> bootstrap-local -> runner-ready             |
                            -> private-backend-proof    |
                            -> remote-import-verified --|
  -> remote-ready
  -> application-foundation
  -> workflow-source-ready
  -> dev-proof
  -> staging-qualified
  -> production-rehearsed
  -> green-red-proof
  -> enforcement-approved
  -> rulesets-applied
  -> live-readback
  -> bootstrap-state-disposed
```

If policy prose, generated tasks, or an agent response orders a transition
differently, the graph wins. Provider readiness precedes `bootstrap-local`;
restricted runner readiness precedes private backend proof; private backend proof
precedes declarative remote import; and only an existing private path or verified
remote import can satisfy `remote-ready`.

## Bootstrap seed and local baseline

Before commit/push or Phase 0, setup completes, syncs, and archives the generated
`bootstrap-<project>` OpenSpec seed. It runs only local, applicable checks:

- `liftoff validate`
- backend tests from the generated README
- frontend build when a frontend exists
- `docker compose config -q` when Compose exists
- `tofu fmt -check -recursive`
- `tofu init -backend=false`
- `tofu validate`
- strict OpenSpec validation

Absent components are recorded as inapplicable. The baseline never starts
containers, runs a live `tofu plan` or `tofu apply`, deploys, mutates GitHub, or
requires cloud credentials. A failed check keeps the seed active; rerun
`/liftoff-setup` after remediation and verified phases are not repeated.

## Questions and approval envelopes

Deterministic defaults and discovered facts do not become conversational
questions. Setup may ask only at these authority gates:

1. repository creation, initial commit, remote, or push;
2. credential enrollment;
3. billed infrastructure, policy exceptions, and cost ceiling;
4. final ruleset enforcement;
5. destructive cleanup, including day-30 bootstrap-state disposal;
6. external platform blockers that require changed authority or design.

Every approval envelope records the reviewed plan digest, allowed resource
types, destinations, permissions, cost ceiling, destructive scope, policy
exceptions, expiry, and baseline SHA. Retries inside the same envelope do not
ask again; expanded resources, destinations, permissions, cost, exceptions, or
destructive effects require a new approval.

## Credentials for runner preflight

When `GITHUB_TOKEN` cannot read required hosted-runner metadata, setup first
prefers an existing verified selected-repository GitHub App installation with the
required read permissions. Liftoff does not install or broaden an App.

If no approved App is available, setup guides one fine-grained PAT with exactly:

| Field | Value |
| --- | --- |
| Display name | `<repo>-runner-preflight-read` |
| Repository secret | `RUNNER_CONFIGURATION_READ_TOKEN` |
| Lifetime | 30 days |
| Repository scope | current repository only |
| Repository permission | metadata read |
| Organization permissions | hosted-runner read and network-configuration read |
| Writes | none |
| Workflow/job allowlist | `.github/workflows/bootstrap-import-preflight.yml` job `bootstrap-import-preflight`; `.github/workflows/private-dast-preflight.yml` job `private-dast-preflight` |

Enter the value only through Liftoff's masked input. Never paste or show the
value in chat, argv, command arguments, logs, evidence, files, or screenshots. A value
that appears in any of those places is compromised and must be manually revoked
and rotated before setup can continue.

The recorded credential policy is payload-free: it stores auth kind, display
name, secret name, owner, repository, expiry, rotation lead, permissions,
allowed workflows/jobs, non-forwarding rules, and readback evidence, never the
secret value.

## Evidence authority and active changes

Task checkboxes are a projection of phase state, not authority. Evidence
documents carry repository identity, activation version vector, graph hash, phase
contract digest, input digest, baseline SHA, phase ID, timestamp, producer, and
result. Setup and `liftoff governance verify` reject missing, stale,
contradictory, future-version, or graph-incompatible evidence.

There may be only one active governance source of truth. An unfinished bootstrap
seed blocks Phase 0. Exactly one compatible active governance change is resumed.
Multiple overlapping changes require a schema-valid supersession or archive
record before any phase advances.

Managed updates install new policy, graph, schema, compatibility metadata, setup
integrations, and aliases without touching user-owned state. When a policy,
activation-contract, schema, or graph-hash change affects active work, status
reports `reconciliation-required`, invalidates only affected descendants, and
waits for explicit acknowledgement of the current compatible identity and exact
graph hash.

## Private staging and bootstrap retention

Private Staging DAST uses an ephemeral GitHub-hosted larger runner with Azure
VNet injection only when genuinely applicable. Phase 0 discovers repository,
subscription, authority, billing, network, DNS, cost, teardown, and capability
facts read-only. If DAST is inapplicable, no runner networking is provisioned.

When a private ZRS backend cannot be reached and no existing private management
path is approved, the bounded `bootstrap-local` branch may create only the
access-establishing resources needed to reach the backend. Local bootstrap state
is encrypted, gitignored, single-writer, never uploaded or copied through GitHub
artifacts or secrets, and cannot authorize application provisioning.

After verified declarative import, backend identity parity, state locking, Blob
versioning, and a clean-checkout no-change plan, local state becomes read-only
evidence for exactly 30 days. Disposal deletes the encryption key and approved
temporary copies and records a dated non-secret outcome. Provider registrations
remain retained subscription capabilities and are not unregistered during
teardown.

## Commands

The generated setup integrations call only strict, project-aware CLI commands:

```bash
liftoff governance status --json
liftoff governance plan --json
liftoff governance apply-next --json --execute
liftoff governance resume --json
liftoff governance verify --json
```

`status`, `plan`, and `verify` are read-only. `apply-next` previews mutations
unless `--execute` is supplied, and even then executes at most one graph-ready,
evidence-ready, approved phase. Unknown subcommands, flags, or extra positionals
fail before project discovery or mutation.

## Existing projects

Projects without `governanceProfile` normalize to the enabled default during
read, then `liftoff update --check` previews manifest v7 and managed-core drift.
Plain `liftoff update` writes v7 only after preflights pass. It never provisions
Azure or GitHub resources and never advances activation state. Setting
`"governanceProfile": "none"` stops future rendering; previously managed files
become reported orphans and remain on disk for manual review.
