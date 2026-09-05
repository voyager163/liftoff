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
deterministic Liftoff governance engine, user-owned activation state, and
read-only Phase 0 discovery.

**Current activation limits:** local bootstrap is implemented, but the CLI does
not yet wire every production phase executor or expose approval persistence
and secure credential enrollment through the command-only setup flow. Missing
capabilities stop with a blocker; they are not completed by assessment or by
hand-editing evidence. See the [developer follow-up plan](../DEVELOPER.md#activation-completeness-and-separate-follow-up-plan)
for the remaining activation work.

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
.claude/commands/liftoff-setup.md                      # Claude selected
.github/prompts/liftoff-governance-assess.prompt.md    # Copilot selected
.claude/commands/liftoff-governance-assess.md           # Claude selected
```

Older generated setup aliases are retired. Use `liftoff update --force` after
review to remove exact modified retired alias entries from older manifests; do
not invoke them as commands.

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

## Read-only governance assessment

`/liftoff-governance-assess` is separate from `/liftoff-setup`, which remains the
primary post-init path. Both OpenSpec and Spec Kit receive only their selected
agents' assessment integrations when governance is enabled. Initialization never
runs assessment. It needs no commit, push, activation, or cloud credentials:

```bash
liftoff governance assess --json
```

The pinned target is the **installed CLI** and its packaged policy, activation
identity, phase graph, and assessment control catalog, never registry latest.
The report compares four distinct layers: target, recorded project baseline,
declared project configuration, and observed enforcement. Each finding includes
expected and observed values, scope, provenance and capture metadata, impact,
and ownership-aware advisory remediation. Matching CLI versions or generated
hashes alone do not prove alignment.
The project policy version is shown when available. JSON observations may also
retain optional normalized `facts` alongside evaluator predicate values so a
predicate result does not hide observed configuration. Raw provider payloads are
not retained.

The default is **local-only with no network access** or registry lookup.
All assessment invocations, including `--live` and `--help`, skip telemetry and
disclosure entirely. Local Git reads inspect only repository root, HEAD, and
origin metadata, never `git status`, which can execute clean filters.
Applicable live proof stays unobserved. Only an explicit live-read request
allows the agent wrapper to substitute:

```bash
liftoff governance assess --live --json
```

Live mode performs bounded read-only GitHub/Azure metadata access with existing
permissions and verified repository/environment/resource bindings. Runner
organization metadata is limited to already-bound assignment IDs. Azure reads
do not guess a default subscription or search unrelated resources. Neither mode
enrolls credentials, expands permissions, registers providers, reads state blobs,
executes project code, runs scanners or infrastructure tools, or changes local
or remote configuration.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts. Placeholder digests,
future-dated approvals, and inferred bindings cannot establish proof. Missing
bindings remain `not-observed`. Do not fabricate or hand-edit activation state,
baselines, receipts, or evidence to manufacture alignment; use separately
approved setup or governance work to obtain trustworthy proof.

| Finding | Meaning |
| --- | --- |
| `aligned` | All required proof layers are available, fresh, and match the target |
| `outdated` | A recognized older baseline or recorded managed artifact differs from the target |
| `missing` | Complete authoritative observation proves an applicable requirement absent |
| `conflicting` | Known settings contradict the target, or declared and observed layers disagree |
| `approved-exception` | An exact, catalog-permitted, valid, unexpired approval covers the difference |
| `inapplicable` | Validated workload facts establish that the control does not apply |
| `not-observed` | Applicability or required proof is unknown, stale, denied, unsupported, or incomplete |

Coverage counts unknown applicability, unobserved live proof, and unsupported
evaluators explicitly. A local workflow declaration is not proof that its check
is enforced. Denied access, masked 404s, incomplete pagination, and timeouts are
not proof of absence. Single-maintainer expectations follow the canonical
zero-required-reviewer policy rather than generic peer-review advice.
Approved exceptions remain differences; free-form or expired claims cannot
waive controls or hide coverage gaps.

Human and schema-v1 JSON reports share `readOnly: true`, target and project
identities, findings, diagnostics, provenance, and coverage. Exit **0** means
fully observed `aligned` or explicitly disabled `not-applicable` governance
(not an alignment claim). Exit **2** means `partial` coverage or `differences`,
including approved exceptions. Exit **1** means `error`: invalid/unsafe input
or an invalid packaged catalog prevents a trustworthy report. Local-only runs
normally return partial coverage. Exit 2 is advisory, not proof that governance
is broken or permission to remediate.

Reports go to stdout only, never activation state or evidence. Assessment cannot
complete Phase 0, satisfy an approval gate, or advance any phase. The wrapper
explains the CLI's classifications without inventing findings or executing
recommendations. Neither installing the integration nor running it activates,
updates, upgrades, or migrates the project.

Older supported inventories without assessment entries remain readable. Use
`liftoff update --check`, then normal guarded `liftoff update` to install the
selected integrations. Unowned conflicting destinations remain unowned even with
`--force`; only already-managed modifications follow reviewed force rules.
Unsupported activation tuples can still receive safe identity and coverage
diagnostics, but no migration is available without an explicit supported mapping.
Force cannot bypass compatibility or overwrite project-owned configuration.
A future governance upgrade must reobserve facts and obtain its own reviewed
plan and approvals; an assessment report supplies no mutation authority.

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

If the seed was already archived before setup began, it stays archived.
Setup still runs the entire applicable local baseline, but strict OpenSpec
validation targets the synchronized spec set with `openspec validate --all
--strict`, not the inactive bootstrap change name. The expected main capability
must exist with a concrete Purpose. A failed archived baseline can be retried
after repair: `resume` reports readiness without rewriting stored state, and
`apply-next --json --execute` reruns the checks before saving verified evidence.

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

Managed updates install new policy, graph, schema, compatibility metadata, and
setup and assessment integrations without touching user-owned state. Forced update can remove
exact retired generated setup-alias entries from older manifests. When a policy,
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
liftoff governance apply-next --json
liftoff governance apply-next --json --execute
liftoff governance resume --json
liftoff governance verify --json
```

`status`, `plan`, and `verify` are read-only. `apply-next` previews mutations
unless `--execute` is supplied, and even then executes at most one graph-ready,
evidence-ready, approved phase. Here, approved means its approval status is
`not-required` or `reused`. Unknown subcommands, flags, or extra positionals
fail before project discovery or mutation. Verification reports consistency
separately from setup completion: a valid not-started or in-progress state may
have `ok: true` and `verificationStatus: "consistent"` while `complete` remains
false. An intact bootstrap seed awaiting baseline verification or archive is
also incomplete rather than inconsistent. Missing or overlapping seeds, or an
active seed contradicting recorded archive completion, still fail verification.

Apply-next reports `selectedPhase` for the attempted transition and
`executedPhase` only when execution succeeds (otherwise `null`). Its legacy
`nextReadyPhase` field is not post-transition readiness; use the subsequent
status or verify response for the next phase. OpenSpec failures include bounded
diagnostics with terminal controls removed; credential-shaped output is
withheld rather than copied into state or command output.

## Existing projects

Projects without `governanceProfile` normalize to the enabled default during
read, then `liftoff update --check` previews manifest v7 and managed-core drift.
Plain `liftoff update` writes v7 only after preflights pass. It never provisions
Azure or GitHub resources and never advances activation state. Setting
`"governanceProfile": "none"` stops future rendering; previously managed files
become reported orphans and remain on disk for manual review.
