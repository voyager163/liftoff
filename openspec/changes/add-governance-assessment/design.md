## Context

See `proposal.md` for motivation. Today `update --check` classifies managed-core
file drift, and governance `status`/`verify` inspect activation state and
evidence. Neither is a complete policy comparison. The public update path blocks
unsupported identities before writing; the packaged historical migration map is
empty. Assessment must explain those situations without weakening mutation
guards or pretending a migration exists.

The normative target is the packaged single-maintainer GitFlow policy, not
generic GitHub best practices. In particular, missing peer reviewers are not a
gap: automated checks, zero required reviewers, repository-scoped controls, and
the bounded private-runner exception are deliberate policy requirements.

## Goals / Non-Goals

**Goals:**
- Produce an explainable comparison of installed target, recorded project
  baseline, declared configuration, and observable enforcement.
- Run offline by default; make live collection explicit and narrowly scoped.
- Remain useful before activation and when an activation tuple is unsupported.
- Preserve unknowns, provenance, approved exceptions, and ownership boundaries.
- Keep the selected-agent integration a thin, model-independent CLI wrapper.

**Non-Goals:**
- Upgrade the CLI or project, migrate activation identities, invalidate or write
  evidence, approve exceptions, change Git refs, or apply live configuration.
- Execute workflows, scanners, project scripts, OpenTofu, deployments, DAST,
  rollback rehearsals, or synthetic green/red checks.
- Inspect arbitrary non-Liftoff repositories, discover an entire Azure tenant,
  introduce organization-wide governance, or enroll/broaden credentials.
- Claim complete policy coverage when some controls lack an evaluator or proof.

## Decisions

### 1. A separate read-only operation, not a second setup command

Expose these exact CLI forms, with the existing optional positional project or
`--project` convention but never both:

```text
liftoff governance assess [project] [--json]
liftoff governance assess [project] --live [--json]
```

`--live` belongs only to `assess`. Reject mutation, installation, output-file,
and automatic-upgrade flags before discovery. The first version emits reports
to stdout only; deliberate shell redirection is outside the command's writes.
`--live` authorizes bounded reads using existing credentials, not login,
credential enrollment, permission expansion, or any remote write.

Route assessment before the activation command handler's strict
`inspectGovernance` gate. Do not change that gate for `apply-next`, `update`,
or other existing commands. Do not implement assessment by shelling out to
`update --check`: reuse its pure comparison helpers without registry lookups,
fresh renders that install tools, or update transactions.
Local Git metadata reads must not invoke repository-configured fsmonitor,
external diff, text conversion, or hooks. Use constrained read commands with
those execution paths disabled or bounded metadata readers, and never fetch
remote refs during local assessment.

### 2. Pin the target and separate input validation from compatibility

The report identifies installed CLI SemVer, target profile/policy version,
policy content digest, activation identity, phase-graph hash, and control-catalog
schema/digest. The target is read from the installed package only. Recorded
project identity is a separate value with `known`, `unsupported`, or `unavailable`
availability; equality of CLI versions does not imply equal configuration.

Anchor discovery to a Liftoff manifest using the existing safe project-root
resolution. With a known manifest schema but an unsupported activation tuple,
read only validated known structures and retain the found identity as diagnostic
data. Reuse supported legacy normalization, never numeric guesswork about policy
compatibility. Future/unknown state schemas remain opaque. An unknown manifest
schema, malformed JSON, or unsafe path produces an error report before using
manifest-provided artifact paths; safe target/header diagnostics may still be
shown. No manifest means a project-discovery error, not automatic adoption.

An explicit disabled profile returns `not-applicable` and makes no live calls.
Do not infer consent to enable governance. Missing facts that cannot be obtained
through a recognized historical normalization remain unknown.

### 3. Release-owned control catalog and coverage inventory

Add a packaged `assessment-controls.json` alongside the canonical policy under
`assets/governance/single-maintainer-gitflow/`; it is a package asset, not a new
project-managed copy. Typed catalog entries use stable control IDs, policy
section references, applicability predicates, expected values, required proof
layers, evaluator/collector IDs, phase references, exception policy, severity,
and an ownership-aware remediation category.

Bind the catalog to the exact canonical policy digest. Release integrity tests
must reject a policy/catalog mismatch, duplicate IDs, invalid phase references,
missing declared evaluators, or empty coverage. Maintain a reviewed inventory
for every normative policy family; unavailable evaluations stay in the catalog
as explicitly unsupported, not silently omitted.

Minimum implemented coverage:

| Family / example stable ID | Local comparison | Live or execution proof |
| --- | --- | --- |
| `identity.activation` | Recorded identity and managed hashes against the installed target | Not required for file/identity facts |
| `gitflow.default-branch` | Declared branch roles and local ref facts | Repository default branch |
| `gitflow.protected-refs` | Exact ruleset payloads for develop/main/release/hotfix | Effective branch/ruleset settings and bypass actors |
| `governance.single-maintainer` | Reviewer counts, CODEOWNERS, environment review gates | Actual branch/environment protections |
| `release.tag-controls` | Separate creation and immutability rule intent | Tag rules and allowed automation actor |
| `checks.required-contexts` | Required context declarations and phase-bound evidence | Exact check names, source application, SHA and conclusions |
| `security.pipeline` | Stage/tool inventory, explicit permissions, action references and obvious fail-open flags | Enabled repository security features and available check evidence |
| `environments.configuration` | Applicable dev/staging/prod and workload boundaries | Environment deployment restrictions and reviewer settings |
| `runner.private-assignment` | Applicability and recorded repository/workflow/runner bindings | Exact assignment, labels, group access and runner metadata |
| `azure.providers` | Minimal namespaces derived from recorded approved resource types | Explicit subscription namespace registration states |
| `azure.private-foundation` | Recorded state/network ownership and resource bindings | Bound storage redundancy/access, subnet egress, firewall/NAT mode and DNS configuration |
| `evidence.governance` | Evidence identity, digest, scope, freshness, approvals and retention metadata | Required current readback or execution evidence |

Deeper policy requirements such as actual canary behavior, reachability from a
private runner, alert delivery, successful rollback, complete script fail-closed
semantics, attestation verification, and DORA measurements require corresponding
validated proof. Reading a YAML/HCL file or a successful generic workflow is not
enough. Where v1 has no safe evaluator, return `not-observed` with the missing
proof/evaluator named.

Use a real parse-only YAML parser for workflow configuration; add the `yaml`
runtime dependency through the package manager because the current source has
no shared YAML parser. Reject duplicate keys, unsafe tags, and excessive aliases.
Do not execute expressions, follow unbounded reusable workflows, or parse shell
meaning with keyword heuristics. Dynamic/unresolved semantics stay unknown.
JSON rulesets and existing evidence use strict typed validators. Arbitrary HCL
evaluation is outside v1; recognized configuration bindings and live ARM facts
can be compared without running OpenTofu.

### 4. Typed observations and deterministic evaluation

Keep collectors separate from pure evaluators under a new
`src/governance-assessment/` module. Reuse safe path utilities, normalization,
canonical hashing, managed-core reconciliation, evidence freshness, and approval
validation helpers rather than copying their rules.

Each finding contains:

- `controlId`, policy reference, severity, and repository/environment/resource
  scope;
- expected value and separate recorded/declared/live observations;
- source path and line or sanitized API identity, content digest, relevant
  commit/ref, and capture time;
- applicability and required-proof coverage;
- classification, explicit reasons, affected phase IDs when known, and a
  recommendation with `managed-core`, `project-owned`, `remote`, or
  `external-authority` ownership and approval requirements.

Severity uses `info`, `warning`, and `error`; it does not replace the finding
classification or report outcome. Observation values are typed, JSON-safe
normalized facts, not arbitrary raw file or API payloads.

Classifications have fixed meanings:

| Classification | Meaning |
| --- | --- |
| `aligned` | All proof required by this control is available, fresh, and equivalent to the target |
| `outdated` | A recognized older baseline or untouched recorded managed artifact differs from the target |
| `missing` | An applicable requirement is authoritatively absent after complete observation |
| `conflicting` | Known configuration contradicts the target or declared and observed settings disagree |
| `approved-exception` | A known difference has a valid, exact, unexpired exception for this target and scope |
| `inapplicable` | Validated workload facts establish that the control does not apply |
| `not-observed` | Applicability or required proof is unknown, stale, denied, unsupported, or incomplete |

A known difference can coexist with an unobserved layer; retain both in the
finding and coverage counts. Never let an unknown live layer disappear behind a
local match. Customization is not automatically a conflict, nor is a matching
generation hash proof of live enforcement.

For exceptions, reuse schema-valid approval envelopes only when the catalog
permits an exception, `policyExceptions` contains that exact control ID, and
identity, phase, baseline, destination scope, and expiry validate. Existing
free-form exception prose is an unverified claim, not an approved exception.
Controls with no permitted exception cannot be waived through this report.
Assessment never creates or repairs exception records.

### 5. Live collection is explicitly bounded

Use fixed collector/action IDs and allowlisted read operations; never execute
commands or URLs supplied by project files or report text. Pin API versions in
the adapters and test the exact requests. GitHub reads cover repository
metadata, branch protections/effective rules, repository rulesets, environments,
workflow/check metadata, and security feature flags. Organization reads are
limited to already-bound hosted-runner/network/group IDs needed to inspect the
repository's existing assignment; never enumerate or propose unrelated
organization governance.

Azure reads require known repository/environment subscription and resource
bindings from validated metadata/evidence. Do not use the account's default
subscription as a guess or search tenant-wide for similarly named resources.
Only GET/show/list metadata operations for the approved control families are
allowed. No `register`, provider auto-registration, `listKeys`, SAS generation,
secret values, state-blob downloads, role changes, or resource writes.

Resolve and cross-check repository identity before attaching live evidence.
Preserve local worktree and observed remote commit identities separately.
Use bounded pagination, timeouts and retries; validate continuation hosts and
scope. Incomplete pagination, denied access, missing bindings, or masked 404s
become `not-observed`. Only a successful authoritative inventory or otherwise
proven absence can produce `missing`.

Initial release-owned limits are 10 seconds per request, a 60-second live
collection deadline, at most 20 pages per inventory, one transient retry within
that deadline, and 5 MiB per response. Read local assessment artifacts with a
1 MiB per-file cap. Hitting a collection limit is an explicit coverage gap;
oversized required input is an input diagnostic, never an empty successful
parse. These limits are constants tested with injected clocks and transports,
not additional v1 CLI flags.

Normalize and redact responses before retaining them. Do not log raw credentials,
webhooks, connection strings, private keys, state payloads, or provider response
bodies. Read credentials only through established authentication mechanisms;
do not persist new credentials or change authentication configuration.

### 6. Reporting, determinism, and exit codes

Report schema v1 includes `readOnly: true`, mode, target/project identities,
repository/ref/worktree snapshot identity, capture time, catalog digest,
findings, diagnostics, coverage counts, and outcome. Coverage explicitly counts
unknown applicability, unobserved live proof, and unsupported evaluators.
Human output leads with target, outcome, coverage limitations, and prioritized
differences; JSON and human output use the same report.

For identical captured facts and clock, normalized findings and ordering must be
identical. Sort by catalog/control ID and normalized scope, not filesystem/API
enumeration order. Recheck local input inventory/digests and relevant remote refs
around collection; changed inputs make affected comparisons `not-observed`
instead of mixing incompatible snapshots.

Outcome precedence and exit codes:

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `error` | 1 | Invalid invocation/input, unsafe path, malformed required artifact, or invalid packaged catalog prevents a trustworthy report |
| `not-applicable` | 0 | Governance was explicitly disabled; this is not an alignment claim |
| `partial` | 2 | Some applicable requirement or its applicability cannot be established; known differences are still listed |
| `differences` | 2 | Complete observation found differences, including explicitly accepted exceptions |
| `aligned` | 0 | Every applicable catalog control has required proof and matches, with no unresolved coverage or exceptions |

An empty enabled catalog is an error, never an aligned report. Local-only runs
will normally be partial because live enforcement was not requested; exit 2 is
an advisory assessment outcome, not a trigger to mutate anything. Fatal report
errors take precedence over partial findings. No report is written into
activation state or accepted as phase-completion evidence.

### 7. Explicit integration ownership

Generate the following managed-core integrations only for selected agents when
governance is enabled, for both supported spec frameworks:

| Logical name | Path parts |
| --- | --- |
| `liftoff-governance-assess-copilot` | `.github`, `prompts`, `liftoff-governance-assess.prompt.md` |
| `liftoff-governance-assess-claude` | `.claude`, `commands`, `liftoff-governance-assess.md` |

Append these exact identities to lifecycle, manifest reader, renderer,
compatibility inventory, and logical-name fixtures. Retain manifest v7 and the
existing policy/activation identity; assessment report/catalog schema versions
do not introduce a manually maintained skill version.

The integration may invoke only `liftoff governance assess --json`, or
`liftoff governance assess --live --json` when the developer explicitly requests
live reads. It explains findings without changing classifications or running
remediation. It must not invoke `upgrade`, `update`, `apply-next`, direct
GitHub/Azure mutation commands, or generated shell instructions.

Fresh initialization must not run an assessment. Existing projects obtain the
integration through ordinary guarded `update`; untracked differing files remain
unowned conflicts, and force must not acquire their ownership. Modified managed
integrations follow existing conflict/force rules. Report generation itself adds
no managed ownership and never restores the retired setup alias.
Readers must continue accepting supported older inventories without assessment
entries so adding a new managed artifact does not itself block the update that
would install it. New writers include all applicable selected-agent entries.

### 8. Relationship to upgrade planning

Recommendations can name `liftoff update --check` for managed-core drift, existing
setup commands for unfinished activation, or a separately reviewed governance
change for project/remote differences. An unsupported mapping must be reported
as unavailable; do not recommend a nonexistent upgrade command or suggest
`--force` can repair compatibility.

A future upgrade engine may consume the report's facts and digests, but must
reobserve freshness, build its own authoritative plan, and obtain the required
approvals. Assessment does not supply that authority.

## Risks / Trade-offs

- Partial v1 coverage may disappoint users: expose every unsupported family and
  required proof, and never advertise a whole-policy compliant result from a
  small subset of checks.
- Drift, customization, and version changes can be confused: separate layers and
  require explicit mappings before labeling a baseline outdated or excepted.
- Read-only access can be incomplete: preserve denied/unknown outcomes per
  control and never turn masked errors into absent resources.
- Incompatible state could tempt permissive parsing: retain strict paths and
  schema boundaries, expose opaque identity diagnostics, and keep mutation
  loaders unchanged.
- Workflow parsing can manufacture confidence: limit static conclusions and
  require execution/readback evidence for behavioral controls.
- New integrations cross explicit ownership lists: test exact identities,
  collisions, old manifests, disabled profiles, and all selected-agent/workflow
  combinations on Windows, macOS, and Linux.

## Migration Plan

Ship the feature in a future CLI release after implementation. Existing
compatible projects run normal managed update to install the selected-agent
integration; unsupported activation identities remain untouched and may use
the CLI assessment directly for diagnostics. No state migration, policy bump,
automatic activation, or release operation is part of this change.

Keep the active bootstrap-recovery change separate. This change adds CLI and
scaffold requirements rather than replacing the bootstrap change's modified
requirement blocks. When both are implemented, rerun their combined regression
coverage before release.
