## Context

See `proposal.md` for motivation. Liftoff currently renders a complete policy,
workload context, a guide, and an 18-line launcher. The launcher asks the model
to produce an "ordered implementation plan" but provides no executable phase
graph. The policy's numbered phases are capability chapters, while its
post-approval prose contains an ordering contradiction around `provider-ready`
and `bootstrap-local`.

The generated OpenSpec seed proposal declares a workload capability, but
Liftoff emits no corresponding delta spec. Its design excludes product behavior
while its first task asks the developer to replace placeholders with
domain-specific requirements. Existing tests assert that seed files exist and
can be archived, but do not prove a fresh seed is strict-valid.

Two observed activations using the same initial model diverged before any later
model mix: one completed and archived its seed; the other created governance
work while leaving the seed active. Both improvised PAT display names, and only
one produced a machine-tested credential policy. This establishes that the
control gap is deterministic orchestration, not model selection.

## Goals / Non-Goals

**Goals:**

- Give a developer one post-init `/liftoff-setup` entry point.
- Make seed completion and governance activation deterministic and resumable.
- Prevent task ordering, checkboxes, or model prose from overriding safety
  dependencies.
- Reduce questions to explicit authority boundaries.
- Standardize credential enrollment without exposing values.
- Preserve Liftoff's local-only initialization and update guarantees.

**Non-Goals:**

- Pin, select, compare, or require any language model.
- Make cloud, GitHub, Git commit, push, enforcement, or destructive mutation
  implicit in `liftoff init` or `--yes`.
- Install a GitHub App at organization scope.
- Rewrite arbitrary user-authored OpenSpec changes during managed-core update.
- Replace OpenSpec as the requirements/design/task record.

## Decisions

### Use `/liftoff-setup` as the primary entry point

Liftoff will generate equivalent Copilot and Claude skills or commands named
`/liftoff-setup`. The existing `/liftoff-repository-governance` launcher remains
a compatibility alias that enters the same engine after the seed/commit gate.
`/git-setup` is rejected as the primary name because the flow spans local
validation, Git, GitHub, Azure, state, delivery, security, and operations.

The generated skill is deliberately thin:

```text
resolve project root
  -> invoke `liftoff governance status --json`
  -> explain blockers or approval
  -> invoke the permitted CLI transition
  -> report structured result
```

It has no model property and contains no duplicated phase logic.

### Split managed definitions from user-owned execution state

Managed-core artifacts add a versioned phase graph, setup integrations,
compatibility metadata, and credential-policy schema. User-owned artifacts hold
activation state, approvals, evidence, and the active OpenSpec change.

```text
.liftoff/governance/
  policy.md
  context.json
  phase-graph.json
  credential-policy.schema.json

governance/
  activation-state.json
  approvals/
  evidence/
  credentials/preflight-policy.json
```

Managed update may replace managed definitions through normal conflict rules.
It never rewrites user evidence or declares a phase complete.

### Version activation as a compatibility vector

Package releases, governance rules, execution semantics, and serialized data
change for different reasons. A single policy or package version therefore
cannot safely determine whether long-running activation may resume. Liftoff uses
this initial version vector:

| Identity | Initial target | Advances when |
| --- | --- | --- |
| Liftoff package | `0.10.0` | The published CLI implementation changes under SemVer |
| Manifest `artifactVersion` | `7` | The root manifest shape changes incompatibly |
| Governance `policyVersion` | `6` | A normative governance requirement or fixed decision changes |
| `activationContractVersion` | `1` | Phase dependencies, gates, mutations, evidence meaning, invalidation, or rollback semantics change |
| Phase-graph schema | `1` | The graph JSON shape changes incompatibly |
| Activation-state schema | `1` | The user-owned state JSON shape changes incompatibly |
| Evidence-header schema | `1` | Common evidence identity or result fields change incompatibly |
| Approval-envelope schema | `1` | Approval scope or integrity fields change incompatibly |
| Credential-policy schema | `1` | Credential policy shape changes incompatibly |
| Phase-graph hash | SHA-256 | The canonical managed graph bytes change |

The package version identifies the CLI that wrote an artifact; it is not a
governance compatibility shortcut. Multiple identities advance together when a
change crosses boundaries. A policy wording or setup-wrapper change with no
normative effect changes only its managed content hash and package release. The
generated skill has no separate version because it contains no contract logic.

Manifest v7 records the applicable vector and graph hash for governed projects.
Governance-disabled projects use the v7 disabled-state variant and do not
fabricate activation identities. The root `liftoffVersion` continues to identify
the manifest writer, while each versioned user-owned artifact identifies the
Liftoff version that created that representation.

The `0.10.0` reader applies this compatibility matrix:

| Input | Behavior |
| --- | --- |
| Manifest v2-v6 without an activation vector | Normalize with existing readers; check mode previews v7; apply writes v7 only after all migration preflights pass and never invents phase completion |
| Manifest v7 with policy 6, activation contract 1, and supported schema-1 artifacts | Read, verify, and resume when the recorded graph hash is recognized |
| Supported historical versioned state listed in the compatibility map | Migrate transactionally, preserve immutable evidence, and record explicit old-to-new identity reconciliation |
| Unversioned or ad hoc governance state | Require an explicit import mapping; never infer evidence from prose or task checkboxes |
| A future manifest, policy, contract, or schema version | Block without rewriting and report the exact unsupported identity and minimum CLI remedy |
| Individually known versions in an unsupported combination, or an unrecognized graph hash | Block for reconciliation without advancing a phase |

Compatibility is an explicit lookup keyed by the complete identity rather than
numeric less-than comparisons. Readers reject unknown object fields under each
schema. Migration stages managed files, manifest, and user-owned state before
one atomic commit; any preflight or write failure restores the prior complete
set. Check mode executes the same calculations without writing.

The graph hash covers canonical packaged bytes and detects drift. Each phase
also has a contract digest derived from its behaviorally relevant node fields.
When a graph hash changes without phase semantic changes, compatibility metadata
may map unchanged phase digests so immutable historical evidence remains valid.
A changed phase digest requires an activation-contract bump and invalidates only
that phase and affected descendants. Release validation rejects graph changes
that lack the bump or compatibility mapping required by these rules.

### Make the phase graph the sole ordering authority

The graph models these canonical transitions:

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

Policy chapters remain descriptive capability groupings. The contradictory
`bootstrap-local`/`provider-ready` prose is corrected to match the graph.

Every phase declares dependencies, applicability, allowed local and remote
mutations, evidence schemas, approval gate, invalidation inputs, rollback, and
terminal states. The CLI topologically calculates readiness and rejects cycles,
unknown dependencies, or out-of-order transitions.

### Generate a complete baseline seed

OpenSpec projects receive the declared capability delta spec in addition to
metadata, proposal, design, and tasks. Seed tasks become:

1. confirm generated files, versions, and placeholders;
2. run project-applicable local baseline commands;
3. strict-validate, sync, and archive without product or remote mutation.

`/liftoff-setup` performs those deterministic checks and advances the seed. A
failure leaves the seed active and blocks commit/push guidance. Spec Kit receives
an equivalent baseline verification record without inventing an OpenSpec change.

### Use one active governance source of truth

Setup inspects active changes before creation:

- the generated seed must be completed and archived;
- exactly one compatible governance change is resumed;
- none creates the canonical change from Phase 0 evidence;
- multiple overlapping changes require an explicit supersession record.

The engine records the active change ID in activation state. OpenSpec task
checkboxes are synchronized from phase evidence; checking a task cannot unlock
a transition.

### Consolidate questions into approval envelopes

Deterministic defaults and discovery never become conversational questions.
Human gates are limited to:

1. repository creation/initial commit and push;
2. credential enrollment;
3. billed infrastructure, policy exceptions, and cost ceiling;
4. final enforcement;
5. destructive teardown;
6. external blockers requiring a changed subscription or design.

An approval envelope hashes the reviewed plan and records allowed resource
types, identities and destinations, permissions, maximum fixed and usage cost,
policy exceptions, destructive scope, expiry, and baseline SHA. A retry inside
that envelope does not ask again. A material expansion invalidates approval.

### Standardize credentials and prefer short-lived existing auth

Authentication adapters are evaluated in order:

1. consume an already approved selected-repository GitHub App installation and
   generate short-lived installation tokens;
2. otherwise enroll one fine-grained PAT.

Liftoff does not install an App. PAT enrollment uses fixed values:

```text
display name: <repo>-runner-preflight-read
secret: RUNNER_CONFIGURATION_READ_TOKEN
lifetime: 30 days
organization: hosted runners read, network configurations read
repository: metadata read, current repository only
```

The CLI opens or prints deterministic enrollment guidance and accepts the value
only through a masked stdin channel before passing it to `gh secret set`. The
value never enters command arguments, chat, output, evidence, state, or files.
The payload-free policy supports an explicit list of allowed workflows/jobs,
because bootstrap import and DAST may both need the same reader.

Credential-shaped output triggers a compromised state and revocation guidance.
The engine cannot revoke a user PAT without separate authority.

### Make evidence authoritative and self-consistent

Each evidence document carries its schema, repository ID, complete activation
version vector, phase-graph hash, phase contract and input digests, baseline SHA,
phase ID, timestamp, producer, and result.
Verification rejects:

- a checked task with missing or failed evidence;
- stale evidence after policy, graph, baseline, or plan changes;
- contradictory status across inventory and newer phase evidence;
- completed phases whose live readback no longer matches;
- downstream evidence created before prerequisite evidence.

The latest valid evidence per phase is selected by identity and transition, not
filename timestamp alone.

### Reconcile activation updates without owning project implementation

Managed update installs the reviewed manifest identity, policy, activation
contract, graph, schemas, compatibility metadata, and setup integrations. The
activation engine then compares the active change and state with the complete
new vector. It invalidates only phases whose contract inputs changed and emits
a machine-readable reconciliation plan.

The skill may update deterministic phase mappings and tasks through the selected
spec workflow after approval. It does not silently change project requirements,
cloud resources, or live governance.

### Expose strict internal CLI commands

The generated skill uses:

```text
liftoff governance status [--json]
liftoff governance plan [--json]
liftoff governance apply-next [--json]
liftoff governance resume [--json]
liftoff governance verify [--json]
```

All commands use project-root discovery, strict parsing, output that includes
the complete activation identity, and transactional local state writes. `plan`,
`status`, and `verify` are read-only. `apply-next` prints mutations and enforces
the phase's consent gate.

### Make the kickstart visible everywhere

The root README, getting-started guide, generated README, completion output, and
governance guide show:

```text
liftoff init my-project
cd my-project
/liftoff-setup
```

They explain baseline verification, seed archive, commit/push, the small
question budget, resume behavior, and normal feature/release flow.

## Risks / Trade-offs

- **[The engine duplicates OpenSpec task state]** -> Treat phase state as
  execution authority and task checkboxes as a synchronized human projection.
- **[Existing projects have ad hoc task structures]** -> Import evidence
  conservatively, require explicit mapping, and never infer completion from text.
- **[Credential enrollment cannot be fully autonomous]** -> Limit it to one
  deterministic masked interaction or consume an existing approved App.
- **[A single setup command appears overly powerful]** -> Preserve separate
  approval envelopes and display every pending mutation.
- **[Policy updates invalidate long-running activation]** -> Invalidate only
  affected descendants and retain compatible evidence.
- **[A version vector is more complex than one policy number]** -> Keep versions
  in shared constants, validate only explicit compatibility tuples, and expose
  the resolved vector in every JSON status and verification result.
- **[Historical state may not have trustworthy identity]** -> Migrate only
  supported versioned representations; require explicit mapping for ad hoc state
  and never convert checkboxes into evidence.
- **[Skills differ across agent platforms]** -> Generate equivalent command-only
  integrations and test their referenced CLI operations, not prose equality
  alone.
- **[Git operations can affect user work]** -> Refuse dirty or divergent
  histories and require explicit initial commit/push approval.

## Migration Plan

1. Add shared version constants, the explicit compatibility map, schema-1
   activation artifacts, canonical phase graph and digests, validators, and
   read-only status/plan/verify commands.
2. Add manifest v7 reading/writing and transactional v2-v6 migration while
   retaining all existing manifest compatibility tests.
3. Generate complete strict-valid seeds and baseline setup integrations.
4. Add transactional apply-next/resume, approval envelopes, and credential
   enrollment.
5. Advance the canonical policy to v6 and install activation contract v1,
   compatibility metadata, and managed-core artifacts together.
6. Add historical-state import and active-change reconciliation for existing
   governed projects, with future-version and unsupported-tuple blocking.
7. Update root/generated documentation, completion guidance, package contents,
   snapshots, and release identity checks for Liftoff 0.10.0.
8. Validate fresh OpenSpec, Spec Kit, API, GenAI, and Power Apps projects on
   Windows, macOS, and Linux.
9. Roll back managed definitions and manifest expectations as one compatible
   set; leave user-owned activation state and immutable evidence untouched and
   mark them incompatible rather than deleting or downgrading them.
