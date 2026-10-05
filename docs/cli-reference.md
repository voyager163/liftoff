# CLI reference

Run `liftoff help` or command-specific help for the authoritative syntax:

```bash
liftoff init --help
liftoff migrate --help
liftoff governance --help
liftoff governance assess --help
liftoff assess --help
liftoff upgrade --help
liftoff update --help
liftoff repair --help
```

Unknown flags or commands, missing values, invalid booleans, incompatible
duplicates, and extra positional arguments fail before generation.

## Lifecycle

```text
install -> upgrade CLI -> plan -> init or migrate -> validate, doctor, explicitly scoped local operations -> update project -> dev and infra helpers
```

| Command | Behavior |
| --- | --- |
| `liftoff capabilities --json` | Returns the schema-1 installed command, schema, plugin, profile, recipe and limitation catalog without project discovery, tool probes, telemetry or state writes |
| `liftoff assess [project] [--governance <profile>] [--json]` | Bounded read-only whole-project comparison against installed targets; unknown runtime, reference and live-proof coverage remains partial |
| `liftoff plan` | Resolves decisions and previews artifacts and requirements without side effects |
| `liftoff init [project-name]` | Initializes a named child or the exact current Git root through staged readiness and framework setup |
| `liftoff migrate <source>` | Creates a new sibling scaffold and filtered source copy without changing the source |
| `liftoff validate [project]` | Validates manifest identity, managed-core hashes, project provenance, workload metadata, and framework markers |
| `liftoff doctor [project]` | Runs read-only workload-derived project and workstation diagnostics |
| `liftoff governance status [project]` | Reports deterministic setup state, activation identity, phase states, blockers, approvals, and evidence freshness |
| `liftoff governance plan [project]` | Previews dependency-ready work before approval and saves a disclosed project-bound receipt outside the repository; no project/provider mutations |
| `liftoff governance approve [project] --plan <fingerprint>` | Approves only the exact unexpired preview; does not execute its operations; refuses blocked or unavailable capabilities such as credential-ready |
| `liftoff governance apply-next [project]` | Previews the next graph-ready transition; add `--execute` to execute at most one approved mutation; refuses blocked or unavailable capabilities before saving a plan |
| `liftoff governance credential-enroll [project] --plan <fingerprint>` | Currently refuses: public credential readiness and enrollment are unavailable pending independently verified provider wiring; reads no input, writes nothing, and never accepts a token argument |
| `liftoff governance recover [project] --plan <fingerprint>` | Previews an explicitly planned recovery; `--execute` runs only its approved scope |
| `liftoff governance resume [project]` | Rechecks external blockers and readiness descendants without rerunning verified operations |
| `liftoff governance verify [project]` | Read-only validation of graph, state, evidence, task projection, policy identity, active-change identity, and live readback; reports consistency separately from setup completion and reports completion as indeterminate when inspection fails |
| `liftoff governance assess [project]` | Read-only comparison against the installed CLI's packaged governance target; local-only unless `--live` is explicitly requested |
| `liftoff upgrade` | Replaces a verified global npm installation with the exact canonical stable release exposed by the configured registry |
| `liftoff upgrade --check` | Checks installation origin and registry parity without installing; exits 2 when an installable update exists |
| `liftoff update [project]` | Applies an exactly approved v8 successor or managed-core maintenance plan |
| `liftoff update --check` | Reports eligible v8 plans without project mutation; exits 0 when clean and 2 when actionable |
| `liftoff update --force` | Overwrites only exact guarded managed-core conflicts; project-owned files remain unreachable |
| `liftoff repair [project-path]` | Displays an exact plan and offers action-specific default-No approval on a genuine terminal; no fingerprint entry |
| `liftoff repair [project-path] --check` | Inventories current-v8 application bindings or previews historical infrastructure repair without cloud calls, application scripts or project writes |
| `liftoff repair --capabilities --json` | Lists packaged repair contracts, recipes, schemas and real command modes without needing a project |
| `liftoff repair [project-path] --inspect-layout` | Inventories actual application paths, target identities, references and unresolved mappings without execution |
| `liftoff repair [project-path] --application-patch <patch.json>` | Reviews external staged application mappings; interactive verification/network/file consents remain separate |
| `liftoff repair [project-path] --check --live --subscription <UUID>` | Explicitly requests bounded Azure metadata discovery with existing authentication and one selected subscription |
| `liftoff repair [project-path] --verify-plan <fingerprint>` | Optional automation for exact staged application checks; declared preparation requires `--allow-dependency-preparation` and declared network requires `--allow-network` |
| `liftoff repair [project-path] --approve-plan <fingerprint>` | Optional automation for an eligible separately approved exact file plan; application patches need fresh verified checks |
| `liftoff repair [project-path] --recover` | Recovers the recorded interrupted repair transaction without starting a new repair |
| `liftoff dev` | Prints workload-appropriate local development commands; it does not execute them |
| `liftoff infra` | Prints OpenTofu guidance for supported API/GenAI workloads without executing it |
| `liftoff patterns` | Lists GenAI patterns |
| `liftoff providers` | Lists provider availability |
| `liftoff regions` | Lists available regions |
| `liftoff regions --region <slug-or-alias>` | Resolves one region and filters the output; ambiguous or unknown values fail with guidance |
| `liftoff regions search <query>` | Searches region names and slugs |
| `liftoff --version` | Prints exactly one version line |

The former `liftoff create` command is intentionally rejected with guidance to
use `liftoff init`; there is no compatibility alias.
`/liftoff-setup` and `/liftoff-repair` (Copilot/Claude), and `$liftoff-setup` and
`$liftoff-repair` (Codex), are native coding-agent invocations, not a `liftoff setup`
command or `liftoff -repair` flag. Init creates a scaffold; repair
works on a supported existing Liftoff project without reinitializing it.

Generation, validation, doctor, governance, and update consume the packaged
[supported-stack baseline](supported-stack.md). The current contract uses
Node.js 24 LTS, Python 3.14, Go 1.27, OpenTofu 1.12, OpenSpec 1.11, and Spec Kit
1.0 release lines; these commands never resolve mutable latest versions.

`validate` also recognizes the independent v8 source format. It checks actual
managed core and preserved control/history relationships without interpreting
old provenance as current paths. Manual's `not-required` framework needs no
framework markers. A valid source report does not prove native verification or
live governance enforcement. Public generation is advertised separately as
`schemas.currentGeneration`, and update as `schemas.currentUpdate`; read support
alone does not enable other operations.

`governance assess` validates v8 identity but marks its interpretation unsupported
by the existing assessment catalog. Independent repository facts remain
read-only; current layout, managed-core compliance and activation proof require
their separately advertised interfaces, not historical policy inference.

For v8, `doctor` reports bounded source inventory from active bindings, not
historical default paths. Unresolved bindings and unsafe/invalid source remain
visible failures. Excluded entries are not inspected, and the runtime layer
explicitly distinguishes source observation from unexecuted tests, builds,
Compose and OpenTofu checks. Manual does not acquire an external-framework
requirement; selected workload and coding-agent prerequisites still apply.

## Capability discovery

For skill and automation negotiation, `liftoff capabilities --json` is a
project-independent catalog, not a readiness check or execution permission.
Without `--json`, it prints a concise human-readable summary. Both help forms
(`liftoff capabilities --help` and `liftoff help capabilities`) also skip telemetry
and disclosure. Existing `liftoff repair --capabilities --json` remains unchanged.

The catalog validates installed bundled plugin assets but does not inspect the
current directory or load project plugins. Registered syntax is distinguished
from governance executor availability: `unavailable`, `injected-only`, and
explicit blockers are not usable production execution. Plugin host declarations
do not prove local tool readiness or native-package qualification. The current
public catalog lists OpenSpec/Spec Kit/Manual, single-maintainer/none, historical
manifest readers 2-7, and v8 reading/writing. Its plugin inventory is the exact
current generation source family. `schemas.currentGeneration` covers `plan`,
`init`, and sibling `migrate`, not arbitrary source conversion.
`schemas.modernReadOnly` separately lists the v8 source/helper and
governance inspection routes. `schemas.modernLocalVerification` separately lists
the explicit local request, approval and execution boundary below. This
does not enable team generation, arbitrary writer access, or automatic local
completion. An older
installed release may not have this command; use its documented help rather
than assuming a missing interface or inventing receipts.

## Planning and initialization options

Common noninteractive inputs include:

```text
--type genai|standard
--pattern <genai-pattern>
--api python|node|go
--cloud azure
--region <slug>
--frontend | --no-frontend
--environments dev,staging,prod
--spec openspec|spec-kit|manual
--agents copilot,claude,codex | --agents none
--default-agent copilot|claude|codex
--governance single-maintainer-gitflow|none
--copilot-cloud | --no-copilot-cloud
--configure-openspec-profile
```

For an undecided GenAI architecture, use `--type genai --pattern generic`.
OpenSpec remains the default when the workflow is omitted. Manual defaults to
no agents; configuration may omit `agents` or use `[]`. `--agents none` is Manual
only, must appear alone, and cannot be mixed with empty or real-agent entries.
External workflows keep their nonempty/default-agent rules. Manual rejects
external-framework flags, including explicit `--no-copilot-cloud`.
Interactive initialization presents **I'm not sure yet - Generic GenAI
starter** first and accepts it as the default. `liftoff patterns` lists this
stable `generic` identifier alongside the eight specialized patterns.

Power Apps and Code Apps plugin inputs are retired and rejected, including
false/negated plugin flags. Existing retired manifests are not reinterpreted as
supported workloads or ordinary Git repositories.

Consent options are documented in [safety and consent](safety-and-consent.md).
For `init` and `migrate`, case or NFC-normalization aliases in staged destination
paths are blocking conflicts, not forceable replacements. Existing destination
ancestors must be listable; see [overwrite boundaries](safety-and-consent.md#overwrite-boundaries).

Repository governance defaults to `single-maintainer-gitflow`. It generates a
local deterministic setup integrations; initialization does not run activation.
The setup integration coordinates local readiness and separately approved
publication, cloud, and governance work. `none` omits it. See
[repository governance](repository-governance.md).

## Governance setup commands

```bash
liftoff governance status [project] --scope local [--json]
liftoff governance plan [project] --scope activation [--inputs public-inputs.json] [--json]
liftoff governance approve [project] --scope activation --plan <fingerprint> [--json]
liftoff governance apply-next [project] [--json] [--execute]
liftoff governance apply-next [project] --scope activation [--plan <fingerprint>] [--execute] [--json]
liftoff governance credential-enroll [project] --plan <fingerprint> [--protected-stdin] [--json]
liftoff governance plan [project] --scope activation --recover-phase <phase-id> [--json]
liftoff governance recover [project] --scope activation --plan <fingerprint> [--execute] [--json]
liftoff governance resume [project] --scope activation [--json]
liftoff governance verify [project] --scope local [--json]
liftoff governance status [project] --scope lifecycle [--json]
```

These commands are strict and project-aware. Unknown governance subcommands,
unknown flags, invalid `--execute` placement, or extra positionals fail before
project discovery or mutation. Direct governance commands default to
`--scope activation`; `local` and `lifecycle` are explicit independent boundaries.
`status`, `resume`, and `verify` are read-only. `plan` changes no project or
provider data, but discloses its external preview receipt.
`apply-next` previews by default; `--execute` is the explicit request to save the
reviewed plan and execute at most one phase whose dependencies, evidence, and
approval envelope are satisfied. `approve` and `apply-next --execute` refuse a
phase whose production capability is blocked or unavailable in the installed
release, before writing a plan, approval, authority record, or state; an earlier
approval does not override that refusal. `resume` rechecks blockers and downstream
readiness without repeating verified operations.

Apply-next JSON names the attempted phase in `selectedPhase` and reports
`executedPhase` separately. `nextReadyPhase` is recomputed after execution;
`nextPlannablePhase` can identify work awaiting approval. A pending external
operation retains its provider handle and is polled, not dispatched twice.
Status/resume preserve `storedState` and `storedBlockers` when
an archived baseline is `retryable`; only explicit execution may replace that
failure with verified evidence.

Historical governance command JSON uses schema 2 and includes selected `scope`, separate
local/activation/lifecycle progress, and `nextActions`. Each action carries its
registered executable/argument array, project working directory, scope, and
approval requirement; integrations must use it rather than invent commands.
The execution identity uses activation package 0.12.0, manifest artifact 7,
policy 6, activation contract 3, graph schema 2, state/evidence/approval schemas
3, supersession/credential-policy schemas 1, and the computed graph hash.
Compatibility metadata is schema 4. It never
emits a setup-skill version. Future identities, unsupported compatibility
tuples, and unrecognized graph hashes block without rewriting state; the remedy
names the exact field and required Liftoff upgrade. Known v1/v2 history is
diagnostic-only and byte-preserved; a supported successor requires
`liftoff update --check` and explicit approval, not automatic reconciliation.

For v8 projects, `status`, `resume`, and `verify` instead use schema 3 and the
modern record reader before any historical inputs or plans are read. Failures
before a supported manifest family can be selected retain the schema-2
verification failure envelope and never enter an execution path. Source
consistency and `recordedPhases` are not current proof. A genuine local completion
is independently reconstructed from the original operation, consent, committed
publication, unchanged source and current tools, without rerunning checks.
An activation-history successor requires its exact separately approved
publication selector:

```bash
liftoff governance verify [project] --scope local --revalidation-publication <fingerprint> --json
```

The selector is also accepted by v8 `status` and `resume`; it never discovers,
approves, publishes or recovers a transaction. Missing, stale or mismatched
authority is an inspection failure, not missing proof silently treated as valid.
No selector means successor proof remains unobserved. Native or journal
completion flags alone cannot establish current completion. `verify` returns 0
for complete selected scope (or disabled governance's inapplicable nonlocal
scope), 2 for consistent incomplete work, and 1 for inspection failure.
`status` and `resume` may return 0 with consistent incomplete work. Local proof
does not establish activation or lifecycle completion. Modern local verification
has the separate explicit interface below. `schemas.modernLocalCompletion`
separately advertises the admitted Manual/Spec Kit finalization, publication and
attributed recovery interface. Modern governance assessment remains unavailable;
historical plans cannot execute v8 work.

### Modern local verification

For an existing admitted v8 project, select `--scope local --local-operation verify`
on every operation. Without that selector, the historical planning/approval path
cannot interpret modern authority. Store request and consent files **outside the
project**, since adding or changing captured source after planning invalidates
the fingerprint. Relative input paths resolve from the invocation directory.

```bash
liftoff governance plan [project] --scope local --local-operation verify --inputs ../local-request.json --json
liftoff governance approve [project] --scope local --local-operation verify --plan <fingerprint> --inputs ../local-consent.json --json
liftoff governance apply-next [project] --scope local --local-operation verify --plan <fingerprint> --execute --json
```

An explicit dependency-free request is:

```json
{ "kind": "verify-local", "preparation": [] }
```

`verify-local` retains its existing Manual or Spec Kit recipe; it does not gain
provider installation. `verify-manual-native` separately selects the locked
Manual application/infrastructure baseline described below. `verify-openspec-local` selects complete
active OpenSpec source; `verify-openspec-initialized` selects the narrowly admitted
generated initialization obligations; `verify-openspec-archived` selects current
validation of existing archived source. There is no automatic mode or store
fallback. Generic historical OpenSpec schema-2 previews remain nonexecutable.
Each mode retains its source, workflow, tool and actual-host admission checks;
registration is not support for arbitrary projects or hosts.

For projects requiring dependencies, `preparation` must declare the exact
[registered application preparation descriptors](application-repair.md), not an
automatic install instruction. Planning observes installed tool identity and
saves an external, expiring, project-bound preview; it does not execute project
recipes, install dependencies, grant consent, or modify project files.
Review the full returned preview, including commands, inputs, tools, preparation,
network declarations and output roles, before supplying its exact fingerprint.

For example, a selected `backend` binding with admitted npm dependencies can
declare `preparation: [{"provider":"npm-ci","version":1,"cwdPathParts":["backend"],
"packageSource":"npmjs","network":true,"lifecycle":"disabled"}]`. The path must
match the actual selected component, and this declaration still needs separate
preparation and network consent. It is not permission to install in the original
project.

Ordinary consent is a closed public JSON object:

```json
{
  "kind": "approve-local-execution",
  "scopes": {
    "projectCode": true,
    "hostCapabilitiesAcknowledged": true,
    "dependencyPreparation": false,
    "dependencyNetwork": false,
    "workflowFinalization": false,
    "publishLocalRecords": false
  }
}
```

Set `dependencyPreparation` and `dependencyNetwork` true only for the separately
reviewed effects in that exact preview; missing consent refuses execution.
Acknowledging project-code host capabilities matters: copied workspaces and
offline flags are **not a sandbox**. Project code retains host capabilities.
Finalization and publication fields must remain false.

For a current generated Manual project, use `kind: "verify-manual-native"` with
the exact application `preparation` descriptors for its selected backend and
optional frontend. This mode currently requires **macOS ARM64, Node 24.21.0 for
the native HCL adapter, OpenTofu 1.12.6 and the packaged AzureRM 5.3.0 lock**.
Selected workload tools are additional requirements. Capability discovery does
not establish their availability, and "native" verification does not mean a
native installer is published.

Review preview6, then use the distinct native consent:

```json
{
  "kind": "approve-manual-native",
  "scopes": {
    "projectCode": true,
    "hostCapabilitiesAcknowledged": true,
    "dependencyPreparation": true,
    "dependencyNetwork": true,
    "infrastructurePreparation": true,
    "infrastructureNetwork": true,
    "workflowFinalization": false,
    "publishLocalRecords": false
  }
}
```

The dependency flags above apply only to separately reviewed application
preparation; set them false when that preview declares none. The two
infrastructure flags independently authorize locked provider-distribution
preparation and its network use. Ordinary dependency consent cannot substitute.
Native Manual runs actual backend tests, optional frontend/worker checks,
closed Compose configuration, explicitly named `.tf` formatting, locked
backend-disabled initialization and validation in each selected environment.
It neither traverses excluded tfvars nor invents standalone application-module
validation. Provider binaries run locally; **no Azure/GitHub resource operations,
backend initialization, cloud plan/apply, container startup or credentials are
authorized**. Source, owned controls and captured provider/module outputs are
rechecked around dependent commands.

Result5 binds the native outputs. A successful report has
`verificationScope: "manual-locked-local-baseline"` but still has
`localComplete: false`. Continue through the separately approved
[finalization and publication](#modern-local-completion) operations, then
`liftoff governance verify --scope local --json`. No agent, external framework
or fictional archive is required, and governance `none` remains disabled.

Initialized OpenSpec instead requires `kind: "approve-openspec-initialized"`,
`dependencyPreparation: true`, `dependencyNetwork: false`, and the additional
`bootstrapScopeAttestation` object with both `generatedBaselineReviewed: true`
and `domainBehaviorDeferred: true`. Ordinary consent cannot authorize this mode.
Its successful `initialization-obligations-observed` result means only the
generated obligations were observed; `verificationComplete` remains false.

Local verification command JSON uses **schema 7**. Completion schema 5 and
successor-revalidation schema 6 retain their distinct report kinds.
`operationComplete` refers only to the
selected operation, and `verificationComplete` refers to its captured baseline,
not published readiness. `localComplete`, `activationComplete`, and
`lifecycleComplete` remain false. Requested-effect flags do not assert that a
process or write actually occurred; inspect the exact result and saved progress.
Actual check failures, blocked preparation, and uncertain settlement exit 1.
A successfully completed requested operation exits 0.

Omitting `--execute`, or using `--execute=false`, only inspects saved execution
progress and exits 0 unless that inspection fails or is blocked. It never
promotes even a successful stored result to fresh proof. `apply-next` accepts
no new `--inputs`; it reconstructs the exact saved request and consent before
claiming work. Execution refuses unknown, stale or cross-project authority.

This route neither finalizes workflows nor publishes local records, revalidates
a successor transaction, performs recovery, or performs Azure/GitHub resource
operations. `providerOperationsAuthorized: false` refers to those resource
operations, not the explicitly approved native Manual local provider binaries.
Fresh OpenSpec synchronization/archive is not exposed here. Automatic directory
rollback remains unavailable. Human output includes the complete JSON record
for review; project command stdout/stderr is represented by digests, not echoed.

### Modern local completion

Existing admitted fresh/current v8 Manual and Spec Kit projects can finalize
successful local verification, review exact publication files, and independently
approve their publication. This does not enable Manual/team generation, project
conversion, successor revalidation, OpenSpec finalization, providers or automatic
whole-directory rollback. Historical, retained, changed-baseline and nonlocal
progression require their separately supported reconciliation paths.

Keep all request and consent files outside the captured project. Every step
requires `--scope local` and its exact `--local-operation`; no operation discovers
or inherits another operation's authority. Finalization starts with:

```json
{ "kind": "finalize-local", "executionFingerprint": "<completed-verification-fingerprint>" }
```

```bash
liftoff governance plan [project] --scope local --local-operation finalize --inputs ../finalize.json --json
liftoff governance approve [project] --scope local --local-operation finalize --plan <finalization-fingerprint> --inputs ../finalize-consent.json --json
liftoff governance apply-next [project] --scope local --local-operation finalize --plan <finalization-fingerprint> --execute --json
```

Review the returned preview before providing the matching Manual consent:

```json
{
  "kind": "approve-manual-finalization",
  "scopes": {
    "finalizeLocal": true,
    "workflowWrites": false,
    "projectCode": false,
    "dependencyPreparation": false,
    "dependencyNetwork": false,
    "publishLocalRecords": false
  }
}
```

For Spec Kit use `kind: "approve-spec-kit-finalization"` and
`workflowWrites: true`; keep the other values unchanged. Consent must match the
exact preview. Spec Kit finalization prepares only the fixed bootstrap task
checkbox changes; it does not complete arbitrary tasks or run an initializer.
Finalization saves external artifacts, not project files, and does not yet
establish local completion.

Use the returned **publication fingerprint**, not the finalization fingerprint,
in a new review request:

```json
{ "kind": "review-local-publication", "publicationFingerprint": "<publication-fingerprint>" }
```

```bash
liftoff governance plan [project] --scope local --local-operation publish --inputs ../publication-review.json --json
liftoff governance approve [project] --scope local --local-operation publish --plan <publication-fingerprint> --inputs ../publication-consent.json --json
liftoff governance apply-next [project] --scope local --local-operation publish --plan <publication-fingerprint> --execute --json
```

Review every `review.files` entry: its path, original precondition, target
digest/mode and exact UTF-8 `content`. This is saved-artifact review, not a fresh
source check or approval. Bind independent consent to that exact result:

```json
{
  "kind": "approve-local-publication",
  "publishExactLocalBytes": true,
  "finalizationFingerprint": "<finalization-fingerprint>",
  "candidateBinding": "<review.result.candidateBinding>",
  "targetSetDigest": "<review.result.targetSetDigest>"
}
```

Publication independently checks current source, original verification and
consent, exact target bytes, transaction ownership, durable commit and installed
readback. Neither previous consent authorizes publication. It changes only the
reviewed local completion records and, for Spec Kit, admitted bootstrap tasks.
It does not commit or push Git, deploy infrastructure or authorize activation.

Recover only the selected publication, without replaying it:

```bash
liftoff governance recover [project] --scope local --local-operation publish --plan <publication-fingerprint> --execute --json
```

Without `--execute` (including `--execute=false`), `apply-next` and publication
`recover` only inspect selected saved progress. They never grant current proof,
approve work or recover implicitly. A different active transaction blocks before
another operation's authority is read. Finalization has no recovery selector.

Completion command JSON uses **schema 5**, separately from schema-7 verification
and schema-3 current inspection. `operationComplete` describes the requested
operation; `localComplete` is true only for returned committed
`local-complete-current` proof with independent readback and no rollback/cleanup
failures. Activation and lifecycle remain false. Saved successful progress
always has `recordedProgressIsCurrentProof: false`; use `governance verify
--scope local` for independent current inspection.

`schemas.modernLocalCompletion` also advertises stored artifact schemas. New
protected indexes use artifact3 raw-DEFLATE encoding so a full selected input
index fits without base64 inflation. Both the serialized record and decoded
index retain the 64-KiB limit. Historical artifact1/2 remain readable; target
bytes and independent finalization/publication permissions are unchanged.

Requested-effect flags do not prove writes occurred. `publicationCommitted`
preserves an observed commit and is null if execution returned no outcome.
`projectFileEffectsUncertain` exposes an unknown outcome or rollback/cleanup
failures. An error does not imply successful rollback. Confirmed completion or
clean explicit rollback recovery exits 0; the latter is not local completion.
A rolled-back publication attempt, pending readback/cleanup, failure or
uncertainty exits 1. Known credential-shaped output is withheld without claiming
effects were undone; inspect the protected checkpoint before retrying.

### Modern successor revalidation

`schemas.modernSuccessorRevalidation` advertises a separate **schema 6**
interface for an **existing supported v8 activation-history successor**. It
does not create or convert a successor, infer compatibility from version
numbers, finalize workflow tasks, change providers or authorize general update
writes. Spec Kit and already archived OpenSpec sources require newly completed,
separately approved [local verification](#modern-local-verification); old
historical success or consent is not current proof.

Keep public request and consent files outside the project. Construct exact
revalidation records from the completed verification with:

```json
{ "kind": "revalidate-successor", "executionFingerprint": "<64 lowercase hex>" }
```

```bash
liftoff governance plan [project] --scope local --local-operation revalidate-successor --inputs ../revalidate.json --json
```

Construction saves external metadata, not project files. The returned
`fingerprint` is the **publication fingerprint** used by all subsequent commands.
`review.intentFingerprint` is a distinct construction identity, not a valid
publication selector. Review includes exact UTF-8 text and target descriptors;
`currentSourceVerified: false` and `publicationAuthorized: false` prevent saved
bytes from becoming current proof or consent. To review that same saved candidate
again, supply:

```json
{ "kind": "review-successor-revalidation", "publicationFingerprint": "<64 lowercase hex>" }
```

After reviewing the exact files, separately approve their bindings:

```json
{
  "kind": "approve-successor-revalidation",
  "publishExactLocalBytes": true,
  "intentFingerprint": "<review.intentFingerprint>",
  "candidateBinding": "<review.result.candidateBinding>",
  "targetSetDigest": "<review.result.targetSetDigest>"
}
```

```bash
liftoff governance approve [project] --scope local --local-operation revalidate-successor --plan <publication-fingerprint> --inputs ../revalidation-consent.json --json
liftoff governance apply-next [project] --scope local --local-operation revalidate-successor --plan <publication-fingerprint> --execute --json
liftoff governance recover [project] --scope local --local-operation revalidate-successor --plan <publication-fingerprint> --execute --json
```

Approval independently checks current source and exact construction. Publication
preserves original transition/preparation identities and historical bytes while
writing only the reviewed local records. Recovery is bound to the selected
transaction, never a replay or automatic downgrade. Another active transaction
blocks before unrelated result authority is read.

Without `--execute`, including `--execute=false`, `apply-next` and `recover`
only inspect selected saved progress and report
`recordedProgressIsCurrentProof: false`. Use `governance verify --scope local
--revalidation-publication <publication-fingerprint>` for independent current
inspection, not the saved-progress interface.

Actual committed `revalidation-complete-current` with independent readback and
no rollback/cleanup failures sets `revalidationComplete` and `localComplete`
true. Actual committed, independently read-back `revalidation-incomplete`
returns **exit 2**, records attention-required, and leaves both completion flags
false while preserving the active successor. It is neither full completion nor
a reason to restore historical state. Failure, pending cleanup/readback or
uncertainty exits 1. Completed requested operations, saved inspection and clean
explicit rollback recovery exit 0; rollback recovery is not local completion.
`publicationCommitted` and `projectFileEffectsUncertain` retain known or unknown
effects even when output is withheld. Activation, lifecycle and provider
authority remain false.

### Historical completion and public inputs

Local completion requires only `seed-valid`, `seed-verified`, and
`seed-archived` (Spec Kit uses finalization, not an invented archive).
It does not require Git publication, provider credentials, or a deployment.
Activation completion requires the live deployment, qualification, and
enforcement phases. Retained bootstrap-state disposal is separate lifecycle
work due 30 days after verified remote import, not a delay in initial activation.
Consistent but incomplete verification exits 0 and reports `complete: false`;
inconsistent or uninspectable selected-scope evidence exits 1.

`--inputs` selects public configuration, including exact repository, Azure
tenant/subscription/region, bounded budget, and validated per-phase inputs.
Relative paths are resolved from the invocation directory, not the project root.
Supply a singly linked regular JSON file no larger than 64 KiB; named pipes and
devices are not supported inputs. The reader reads at most 65,537 bytes and
refuses inputs when that read observes more than 64 KiB, including growth during
the read. This does not guarantee a stable snapshot or detect growth after EOF.
Never put credentials, raw state, or private plans in that file.

Without atomic no-follow support, the reader compares pre-open and opened
bigint file identities before reading, rejecting unavailable or mismatched
identities. This depends on usable, stable file-system identities; it is not
atomic no-follow protection and does not detect every racing path swap. Native
Windows qualification is pending.

New public inputs are screened for known credential patterns in phase field
names, nested phase values, and other public strings. This is not comprehensive
secret detection: benign text such as `basic setup` or `acme/ghs_tools` can also
be refused. Persisted configuration acceptance is unchanged. Input-validation
diagnostics use trusted schema labels rather than supplied keys or values, and
malformed approval-JSON diagnostics omit parser payload snippets.

`credential-enroll` currently refuses before selecting a private TTY or
`--protected-stdin` channel: public credential readiness and enrollment are
unavailable pending independently verified provider wiring. A fingerprint is not a
token, and approval alone neither enrolls a credential nor provisions resources.
Interrupted writes require a fresh `plan --recover-phase` before `recover`;
unsupported or ambiguous external outcomes remain visible blockers.

Status, resume, and verify JSON include `migration` (the validated journal, or
`null`) and `migrationSummary`. The summary separates `localCommit`, validated
snapshot/index/successor linkage, recorded `revalidation`, `nextRecordedPhase`,
and a project-bound fresh-preview remedy. `currentProofRequired` is always
true: recorded completion is audit history, not current evidence or provider
authority. Human output presents the same migration progress separately from
readiness; stale current proof still blocks even when the journal says complete.
These inspection commands neither advance phases nor create preview receipts.

`/liftoff-setup` calls these commands instead of inferring phase completion from
prose or task checkboxes.

OpenSpec projects use all 12 OpenSpec 1.11 workflows. Copilot and Claude receive
their supported skills/commands; Codex receives native skills under
`.agents/skills`, invoked through `$skill-name` or its skill picker, not fabricated
slash-command adapters. All seven nonempty agent subsets are supported.
`--copilot-cloud` opts into the GitHub-hosted coding-agent workflow and
agent definition; omission and `--no-copilot-cloud` keep it disabled.

OpenSpec stores workflow profile and delivery globally. If the observed profile
does not match Liftoff's complete contract, interactive runs request separate
consent. Noninteractive `init` and `migrate` require
`--configure-openspec-profile` to authorize the displayed
`openspec config set` commands. The flag has no effect during `plan`, which
never inspects or changes machine configuration.

## Read-only whole-project assessment

On builds advertising `schemas.projectAssessment`:

```bash
liftoff assess --json
liftoff assess --project "path with spaces" --governance single-maintainer-gitflow --json
liftoff assess "./existing application" --governance none
```

Choose one positional path or `--project`, not both. Without a path, the nearest
safe Git or Liftoff boundary is selected. Non-Git applications require an
explicit directory. Linked roots/ancestors, aliases and malformed, unsupported
or retired inner manifests fail without falling through to an outer project.
Worktree pointers are presence markers only and are not followed.

The target displays the installed CLI, policy, bundled plugin catalog and, for
validated current projects, the selected plugin/layout comparison identities.
Omitted `--governance` uses a supported recorded profile; unrecorded projects
display the single-maintainer baseline. Explicit `none`,
`single-maintainer-gitflow` or `team-gitflow` comparisons are advisory and never
change selection, weaken existing controls or enable team generation/enforcement.
No registry latest is queried.

Schema 1 has `command: "assess"`, `kind: "liftoff-project-assessment"`,
`readOnly: true`, explicit target/project identities, deterministic findings,
provenance, coverage, diagnostics and a result digest. It is separate from the
schema-1 `governance assess` report. Static declaration names, path presence and
exact expected managed-byte comparisons are observations, not complete
dependency, runtime, reference, agent or governance conformance. Compatible
explicit custom bindings are preserved; generation hashes and canonical
template paths are not current-path authority.

Unknown applicability, uncollected evidence, excluded/limited scopes and
unsupported evaluators remain visible. Current whole-project reports normally
return `partial` and exit 2. Exit 0 requires complete applicable alignment or
explicitly inapplicable requested scope; exit 1 means invalid/unsafe input or
an unavailable requested scope. Known missing files and byte differences are
retained even when overall coverage is partial.

This local producer performs no project-script, framework, Git or package-manager
execution, tool probe, network, credential enrollment, telemetry/disclosure,
receipt or project write. It reads bounded dependency declarations, the selected
manifest and only exact renderer-declared managed files, never activation/state
or credential payloads. Two bounded inventory passes and file/metadata
revalidation detect observed drift; unread payload changes are outside that
scope. Help needs no project and also skips telemetry/disclosure.

`assess --live` is currently unavailable and fails explicitly without accessing
accounts. The narrower `governance assess --live` remains a distinct existing
capability, not a substitute whole-project report. Recommendations separate
managed update, application repair, adoption, workflow/profile/plugin migration,
new-environment activation and existing-deployment planning. Only actual
supported preview routes are supplied; unavailable lanes have no executable
command. Available preview argument arrays include the selected `--project`
path, even when assessment runs from another working directory.
No finding, target choice or digest is write approval, ownership,
activation evidence or permission to run a recommendation.

## Read-only governance assessment

```bash
liftoff governance assess [project] [--json]
liftoff governance assess [project] --live [--json]
liftoff governance assess --project "path with spaces" --json
```

Use an optional positional project or `--project`, never both. It can identify
an ordinary Git repository without a manifest. Nested working directories resolve
to the nearest applicable Git or Liftoff boundary; invalid or retired inner
manifests cannot be bypassed. No initialization or slash-command installation is
required. Help needs no project or
credential discovery. Only `assess` accepts `--live` within governance subcommands; assessment rejects
`--execute` (including `--execute=false`), `--force`, installation, automatic
upgrade, and output-file flags before project access.

The pinned target is the **installed CLI**, including its packaged policy
version/content digest, activation identity, phase-graph hash, and control
catalog schema/digest. It never resolves registry latest or upgrades anything.
The schema-v1 report (`readOnly: true`) separates target, recorded baseline,
declared configuration, and observed enforcement, with expected/observed values,
scope, provenance, impact, diagnostics, and advisory recommendations.
It shows the project policy version when available. JSON observations may retain
optional normalized `facts` alongside evaluator predicate values; these are
sanitized details rather than raw provider payloads.

The default is **local-only with no network access**, registry lookup, project
script execution, or GitHub/Azure credential requirement. Assessment works
before commit, push, or activation. Every assessment invocation, including
`--live` and `--help`, skips telemetry and disclosure entirely. Local Git reads
use only repository root, HEAD, and origin metadata, never `git status`, which
can execute clean filters. `--live` opts into bounded read-only metadata
access using existing permissions and verified repository/environment/resource
bindings. It does not log in, enroll credentials, broaden permissions, register
providers, download state blobs, or mutate GitHub or Azure.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts, not placeholder digests,
future-dated approvals, or inferred bindings. Missing bindings remain
`not-observed`. Do not fabricate or hand-edit state, baselines, receipts, or
evidence as remediation; missing proof requires separately approved setup or
governance work.

Findings are `aligned`, `outdated`, `missing`, `conflicting`,
`approved-exception`, `inapplicable`, or `not-observed`. Coverage preserves
unknown applicability, stale or unavailable proof, and unsupported evaluators.
Denied access, masked 404s, or incomplete collection are not proof of absence.
Local matches do not prove live enforcement; local-only reports normally have
partial coverage. See [finding meanings](repository-governance.md#read-only-governance-assessment).

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `aligned` | 0 | Every applicable catalog control has fresh required proof and matches |
| `not-applicable` | 0 | Governance is explicitly disabled; not an alignment claim |
| `partial` | 2 | Applicability or required proof is unknown; known differences remain visible |
| `differences` | 2 | Complete observation found differences, including approved exceptions |
| `error` | 1 | Invalid invocation/input, unsafe paths, malformed required artifacts, or an invalid catalog prevent a trustworthy report |

Human and JSON output derive from the same report, emitted only to stdout.
Exit 2 is advisory, not proof that governance is broken or authorization to
repair it. Neither assessment mode changes project files, Git, state,
approvals, evidence, or remotes, or runs recommendations. A report cannot
complete Phase 0 or advance activation.

`/liftoff-governance-assess` is a selected-agent explanation wrapper, not a setup
alias; `/liftoff-setup` remains the primary post-init path. Compatible older
projects install the integration through normal `liftoff update --check` and
guarded `liftoff update`. Unowned collisions remain protected even with
`--force`. Unsupported activation mappings may be diagnosed without migration;
force cannot bypass compatibility or overwrite project-owned files. A future
governance upgrade requires fresh observations, its own reviewed plan, and
separate authority.

## CLI upgrade modes

```bash
liftoff upgrade
liftoff upgrade --check
liftoff upgrade --json
liftoff upgrade --check --json
```

`liftoff upgrade` is an imperative request to replace the supported global npm
installation of `@msn-control/liftoff`; it does not prompt or accept `--yes`,
`--force`, `--install-tools`, project paths, or project dependency flags.
Automatic replacement is refused for local dependencies, `npx` execution-cache
copies, linked checkouts, unknown package-manager stores, ambiguous roots, or
unsafe paths.

On macOS, a verified global installation at the standard Homebrew prefix can
remain eligible when Homebrew Node/npm reports its versioned Cellar prefix.
Liftoff checks the package, runtime layout, and launcher, then explicitly targets
that existing prefix throughout the upgrade. It rejects a prefix-specific
registry change instead of silently switching delivery policy. This fallback
does not apply to arbitrary prefixes, Windows, or Linux.

Canonical npm's stable `latest` metadata selects one exact target. The effective
configured npm registry remains the delivery path and must expose that exact
version. Liftoff never edits `.npmrc`, embeds registry credentials, forces a
canonical bypass around a stale mirror, invokes elevation, installs a
prerelease, or performs a downgrade.

Machine-level `@msn-control:registry` takes precedence over the default
`registry`, even when the default is canonical. The lookup runs from a neutral
directory so project `.npmrc` files cannot change upgrade delivery. Canonical
verification isolates both registry settings without changing persistent
configuration; actual delivery still honors the configured mirror.

`--check` performs the same origin, target, and parity checks without invoking
installation. Apply uses one shell-free exact npm command with lifecycle scripts,
audit, and funding prompts disabled, then verifies installed metadata, the
confined binary, and exact `Liftoff <version>` output. A failed install or
verification is not automatically rolled back; use the exact-version repair
command printed by Liftoff.

JSON results use schema version 1 and expose only `mode`, `status`,
`currentVersion`, applicable `targetVersion`, applicable `registryKind`, and a
stable `reasonCode`, plus optional `installationTarget` (`homebrew-opt` or
`homebrew-usr-local`) when the standard Homebrew fallback is verified. Arbitrary
installation paths are not included. Status is one of `current`, `update-available`, `upgraded`,
`blocked`, or `failed`. Child progress goes to stderr so stdout remains one JSON
object.

## Repair modes

```bash
liftoff repair [project-path]
liftoff repair [project-path] --check [--json]
liftoff repair [project-path] --check --live --subscription <UUID> [--json]
liftoff repair --capabilities --json
liftoff repair [project-path] --inspect-layout [--json]
liftoff repair [project-path] --application-patch <external-patch.json>
liftoff repair [project-path] --check --application-patch <external-patch.json> [--json]
liftoff repair [project-path] --recover [--json]
```

**Normal terminal use does not require copying a fingerprint.** Bare current-v8
repair performs read-only application inventory. An explicit application patch
or supported historical infrastructure repair shows the exact immutable plan
and its effects, then asks Yes/No with default
No on usable input/stderr TTYs. Only Yes authorizes that displayed plan.
`--check` never executes the proposed repair. JSON and non-TTY invocations never
prompt or execute implicitly; piped yes, autopilot and generic confirmation are
not consent. No, cancellation or EOF before any effect approval leaves the
project unchanged. A later cancelled file approval prevents the file transaction,
but reports any earlier separately authorized verifier effects.

Use a positional project path to select another project, or run inside the
project (including a subdirectory). Commands in structured `nextActions` retain
separate executable/argument/cwd fields and native POSIX/PowerShell quoting.
Ordinary checks inspect bounded local configuration and state/backend metadata
presence without reading state or contacting cloud services. Only explicit
`--live` with a selected subscription permits bounded read-only Azure metadata
requests using existing authentication: no login, privilege expansion, state
reads, backend writes, or deployment.
This infrastructure discovery lane accepts historical manifests only; v8
requests are explicitly blocked, not silently converted to application checks.
Metadata discovery has a 120-second overall deadline, a 30-second per-command
deadline, and a maximum of 24 resource groups. Exceeding a bound leaves
eligibility incomplete and blocks writes.

The `azure-local-layout` recipe, version 1, reorganizes supported recorded legacy Azure
OpenTofu flat roots into `modules/application` and the selected independent
`environments/<id>` roots. Semantic inspection preserves source bodies,
compatible provider constraints and locks, variables, outputs, and environment
values; it does not replace the application with a newer starter.
Eligibility requires all relevant resource groups to be authoritatively absent
in the selected subscription **and** all supported local state/backend metadata
locations to be absent. Missing state files, a user assertion, or edited manifest
metadata cannot prove that infrastructure is undeployed. Denied, timed-out, or
incomplete discovery remains a blocker.

Review the exact operations and external receipt. The CLI retains the expiring
project-bound fingerprint internally; interactive approval cannot expand the
subscription, commands, file scope or recipe. For eligible infrastructure with
explicit discovery scope, run `liftoff repair [project-path] --live --subscription
<UUID>` to review and approve without hash entry. Changed inputs after a prompt
need a fresh preview, never an automatically substituted plan. Repair repeats eligibility checks before
commit and validates an isolated candidate. Validation first checks that the
installed OpenTofu belongs to a compatible stable release line, then runs these
approved commands **in staging**, not against the original backend:

| Staged directory | Validation command |
| --- | --- |
| Whole Azure root | `tofu fmt -check -recursive` |
| Each selected environment root | `tofu init -backend=false -input=false -lockfile=readonly -no-color` |
| Each selected environment root | `tofu validate -json` |

Formatting must already pass; repair does not silently reformat the candidate
after approval. Initialization can download providers, as disclosed in the plan,
but preserves the lockfile and never initializes the original backend or runs
cloud plan/apply. Committed provenance describes actual repaired bytes, while
original provenance is preserved under `.liftoff/repair-history/<fingerprint>/`.

### Reviewed application files

For broader application folder arrangements, open the same project in a selected
coding agent and use `/liftoff-repair` in Copilot/Claude or `$liftoff-repair` in
Codex's skill picker. Missing native integration is managed drift: review
`liftoff update --check --project <project-path>`, then approve the matching update.
An unowned custom file at the native path remains protected, even under force.
The repair integration is also generated for governance `none`, without enabling
policy, setup, assessment or activation.

Start with `--inspect-layout`. Inventory covers observed project files, current
generated artifact identities, modes/digests, reference locations and exclusions;
it does not infer an old layout version or offer automatic folder moves. The
agent resolves imports, customizations, build/tests, Docker/Compose, scripts,
CI and docs, and authors exact mappings/replacement bytes **outside the project**.
Unresolved mappings, occupied destinations, protected files or unsafe paths block
the selected version-1 recipe: historical `application-layout-patch` or current
`application-active-layout-patch`.

Current-v8 repair supports governance `none` and `single-maintainer-gitflow`,
including Manual/no-agent projects. It uses explicit active artifact bindings
and component roots, including compatible custom paths; generation history does
not select current locations. Missing bindings are not inferred. Moving an
actively bound artifact requires separately reviewed binding publication, which
is not yet available. Current infrastructure and team-profile repair remain
unsupported. Inspect `currentApplication` in the repair capabilities document
instead of assuming historical recipes also authorize current sources.

Normal `--application-patch <external-patch.json>` displays the actual patch and
asks independently about exact staged project-code verification, any declared
network effects, then the file transaction after the verification result is
visible. All script/network consents precede the checks. Staging and a sanitized
environment are **not an OS or network sandbox**: trusted project code can affect
the host or network, and unsupported mandatory-isolation requirements block.
Dependency/tool installation is not supplied by this recipe. Missing validation
dependencies or unsupported commands remain blockers, not skipped checks.
Only the declared checks are verified, not application-wide or live conformance.

The real application is changed only by the confined transaction after separate
file approval, with fresh source/stage/mode/directory/reference/verification
binding. Application patches cannot edit the manifest, desired state, managed or
framework control files, activation proof, history, infrastructure, state or
secrets. The Azure recipe retains its own registered manifest/history authority.
See the [application patch format and review example](application-repair.md).

### Optional exact automation

These remain supported for coding agents and automation with explicit prior
approval of the exact displayed scope; they are not the normal human workflow:

```bash
liftoff repair [project-path] --verify-plan <fingerprint> [--allow-dependency-preparation] [--allow-network] [--json]
liftoff repair [project-path] --approve-plan <fingerprint> [--json]
```

The application verifier flag authorizes only exact staged checks, not file
writes. Explicit `--allow-dependency-preparation` permits only declared locked
private preparation in a fresh disposable environment for exact candidate
manifests and locks (`npm-ci` v1, `uv-locked-sync` v1, `go-mod-download` v1);
it never installs global tools, mutates live dependency trees, inherits ambient
credentials, upgrades locks or commits dependencies/build outputs. Declared
network needs additional `--allow-network` permission. The file-approval flag
never runs application verification on the caller's behalf: a fresh matching
successful receipt is required first. Flags cannot select a different patch,
discovery subscription, command set or recipe. Repeated matching verification
can reuse its recorded result without claiming another command ran.

Do not chain check and apply with `&&`: exit 2 can mean an available plan or a
blocked/plan-only result. Schema-2 results distinguish `inspected`, `current`,
`available`, `blocked`, `verified`, `applied`, `failed`, `partial` and `recovered`.
They contain `identity`, `capabilities`, `requestedScope`, `committed`,
`repairScopeComplete`, verification/effects, and typed `nextActions` (`command`,
`agent` or `guidance`). Fingerprints, receipts and exact operation digests remain
machine-readable audit data. A command action includes `command.executable`,
`command.args`, `cwd`, `scope`, `approvalRequired`, and native `displayCommand`;
`requiresInput` means substitute confirmed values before executing it.
Exit 0 denotes completed inspection/verification, current scope or verified
commit; 2 denotes differences, blockers or partial effects; 1 denotes a rejected
or failed operation before a successful repair. Neither a verified staged
candidate nor a committed repair completes setup or activation.

### Repair records and recovery

`repair --capabilities --json` is a schema-1 capabilities document, not a project
repair report. Repair contract 1 is separate from CLI SemVer and from recipe
versions/layout identities. Current approval previews, reports, new historical
receipts and repair journals use schema 2. Application inventory, patch documents
and nested reports, verification results/receipts and private backup indexes
use their own schema-1 formats. Update's journal remains schema 1.

**Repair and preparation capabilities**: The package version is
0.12.3; application repair and locked preparation capabilities require
`repairContractVersion` 1. Do not infer capability support from
package SemVer alone. Native integrations and tooling must query `liftoff repair --capabilities --json`
directly to verify `repairContractVersion`, supported schemas, registered recipes,
and the preparation matrix.

Changed CLI/contract/recipe/layout/verification or source/staged input invalidates
approval. Old schema-1 previews cannot authorize either current lane. Old
historical receipts remain byte-identical and do not become current proof.
Recovery accepts only externally sealed legacy schema-1 repair journals or
schema-2 journals with exact supported contract/recipe/layout identities.
Unknown future identities block without rewriting the journal.

`--force`, `--yes`, and `--add-agents` are not supported. Agent installation,
framework-default changes, and the public stateful migration coordinator are
**not implemented**. An existing internal stateful engine does not make a public
command executable. Deployed, unknown, ambiguous, or unsupported cases remain
plan-only with source and state untouched. Do not edit metadata, copy a fresh
init scaffold over the project, or use manual state moves to bypass the blocker.

If writes were interrupted, use only the reported
`liftoff repair [project-path] --recover` action. Update cannot recover repair
authority; both lanes exclude overlapping pending transactions and preserve
concurrent edits. After repair, run `liftoff update --check --project <project-path>`,
review any separately approved update work, then inspect
`liftoff governance status <project-path> --scope local --json` and
`liftoff governance resume <project-path> --scope local --json` for governed
projects. Native setup handles remaining separately approved execution.
Application original-byte backups are private user-local records; the reported
index identifies immutable digest-bound chunks and original modes. In-project
history contains descriptors and the original manifest, not application/state
payloads. After commit, corrections require a new reviewed patch or user-controlled
version-history recovery. `--recover` does not blindly restore a completed patch
or undo verifier/host effects.

## Update modes

Check `liftoff capabilities --json` for `schemas.currentUpdate` before using this
v8 interface; older published builds retain their own update contract.

```bash
liftoff update --check
liftoff update
liftoff update --force
liftoff update --check --json
liftoff update --approve-plan <fingerprint> --json
liftoff update <project-path> --recover --approve-plan <saved-fingerprint>
```

Run update from the project root or a subdirectory: Liftoff finds the nearest
`liftoff.manifest.json`, so `--project` is not required for that project.
An explicit positional path or `--project` selects that exact project instead;
do not supply both. Recovery deliberately uses an explicit project path or the
exact current directory, before interpreting a possibly interrupted manifest.
When recovering from a subdirectory, always provide the project path.
JSON remedies remain explicitly targeted and use native-shell argument quoting.

`liftoff update --check` is the human-first compatibility and migration preview.
It changes no project bytes, but saves and discloses a project-bound preview
receipt in user-local storage outside the repository. A receipt is not approval.
`liftoff update` requires a matching preview, recomputes its effective plan, and
asks for explicit approval with a negative default. Missing or stale previews
stop with instructions to rerun check. No-op inspection requires no approval.

Run check and apply as separate commands; do not join check and apply with `&&`.
Check returns exit code 2 for an actionable preview, so a success-only shell
chain would skip apply even though the preview was created successfully.

Noninteractive apply additionally requires the exact full plan fingerprint
through `--approve-plan`. Check and apply must share the same materialized
checkout and user-local storage; another runner, worktree, or moved project
needs a fresh check and approval. `--force`, `--json`, and a generic yes do not
waive these gates. The force variant has its own preview and fingerprint.

The current public writer targets manifest v8. Supported historical manifests
use a reviewed standalone-history successor, or an activation-history successor
when exact supported activation records are present. Existing v8 projects use
inactive or active managed maintenance instead. Original manifest/history bytes,
project provenance, workflow, agents, profile, plugins and compatible active
layout are preserved. Current metadata does not imply successful activation.

Preview lists each eligible normal/force fingerprint and its operations:
write/delete, exact path, and write digest, byte length and requested mode.
These descriptors are not a textual diff. The actual transaction candidate and
all observed input bytes/modes are bound to the fingerprint. A required unowned
conflict blocks a complete successor; force cannot acquire that ownership.
Those conflicting files remain outside managed ownership.
Only guarded managed core, exact historical preservation, associated local
control records and the final manifest are publication targets. Exact retired
generated aliases can be removed only by their independently eligible plan.

The optional `liftoff.config.json` is read without following links, within the
bounded source capture. Its presence, bytes and mode are preconditions, including
an observed absence. Missing configuration is never created to materialize a
default. Configured workload/workflow/profile or established-agent changes are
refused, not silently applied. Desired agents on an uncertain legacy framework
are explicitly listed as deferred configuration; core update does not initialize
that framework. Configuration is resolved again during transaction validation.

Application source, tests, dependencies and locks, database assets, Docker and
Compose files, environment files, documentation, and
OpenTofu topology are `project` artifacts after generation. Update does not
compare them with newer templates, restore deleted paths, or overwrite them
under `--force`.

Adding frontend/environments, changing profile/workflow, additive-agent repair
and application/layout migration are separate operations, not permissions
conferred by this update fingerprint. The current public core path refuses
unsupported configured changes. The older schema-3 application's create-only
provisioning behavior is not part of this public v8 scope.

Use `--check` whenever no project bytes may change. Check reports current-target
compatibility, required history preservation and eligible exact operations.
It lists force only for an independently eligible variant.
`--check --force` remains invalid because check mode never authorizes overwrites.

`--json` selects output format, not safety or consent. Update JSON uses schema 4,
kind `liftoff-current-project-update`, with separate requested execution,
known publication commit, uncertain effects, scoped completion and required
revalidation. Prompts and progress use stderr; stdout remains one
JSON result. Check exits 0 for no actionable work, 2 for differences, and 1 for
errors. Apply exits 0 for completed scope, 2 when migration committed but
revalidation is incomplete, and 1 for rejected approval or an error.
`publicationCommitted` never becomes false just because revalidation remains
incomplete. `localComplete`, `activationComplete` and `lifecycleComplete` are
false for this scope: update does not establish those claims. Existing local
verification/finalization/revalidation interfaces require their own review and
consent. An update fingerprint never authorizes infrastructure repair.
**Local baseline verification** is not an OpenSpec feature change; update
does not automatically run that separately reviewed verification.

Ordinary apply never implicitly recovers a pending transaction, including one
that appears after initial inspection. Use `--recover --approve-plan` with the
exact saved update fingerprint. Recovery also binds the observed transaction
digest under lock, uses its original transaction seals, and cannot borrow
repair/local-verification authority. It does not need parseable configuration
or a fresh preview. It does require attributable safe target bytes; arbitrary
edits to an interrupted target remain blockers. Clean recovery exits 2 and
requires a fresh check before new work. Do not remove an unattributed lock.

Update never installs dependencies. Ordinary transaction backups are for failure
recovery; activation migration additionally retains durable original history.
Force cannot bypass preview, approval, ownership, project-boundary, symlink,
structural, identity, or manifest guards.

### Preview receipt storage

Check reports the exact native receipt path. Receipts and separate transaction
approval records use user-local storage, never the project or its containing
repository:

| Platform | Receipt directory |
| --- | --- |
| Linux | `$XDG_STATE_HOME/liftoff/update-previews` when `XDG_STATE_HOME` is set to an absolute path; otherwise, when unset, `$HOME/.local/state/liftoff/update-previews` |
| macOS | `~/Library/Application Support/liftoff/update-previews` |
| Windows | `%LOCALAPPDATA%\liftoff\update-previews` when `LOCALAPPDATA` is set to an absolute drive or UNC path; otherwise, when unset, `%USERPROFILE%\AppData\Local\liftoff\update-previews` |

An empty or relative override is an error, not a request to use the fallback.
Unsafe paths, links/junctions, or storage inside the project or repository also
block the update; repair the reported storage issue rather than moving a receipt
into the project. When an explicit target is needed, commands containing spaces
or shell metacharacters use literal native-shell quoting and retain the selected
project path.

`preview-missing` means no saved preview was found for the selected project.
It does not mean project discovery failed or that storage is damaged. A receipt
may have been consumed or may be absent from this user-local store; run a fresh
check, review it, then approve the matching apply plan. `preview-mismatch` also
requires a fresh check because the saved preview no longer matches the current
plan. Repeating the project argument does not satisfy either prerequisite.

Other preview failures retain their specific diagnosis: `preview-storage` names
a storage operation or path to repair, `preview-invalid` identifies an invalid
receipt, `preview-unsupported` reports a format incompatibility, and
`preview-busy` reports concurrent access. Follow the named remedy rather than
treating every failure as a missing preview. Do not remove an active lock or
change project files to repair preview metadata.

The immutable history snapshot travels inside the project. Preview receipts and
approval records do not: another machine, checkout, worktree, or moved project
needs its own fresh check and approval. A receipt stores digests, not project
source bodies, and is never portable blanket authorization.

### Reviewed historical activation migration

An exact supported v1/v2/v3 source can be previewed with `liftoff update --check`.
Approved update verifies an immutable in-project history snapshot before
replacing active records, then creates linked state4/journal2 and v8 metadata. Historical
state, evidence, plans, approvals, and source metadata retain their original
bytes under the dedicated governance history directory. History is not managed
core and is never automatically committed, pushed, or cleaned with receipts.

Fresh local revalidation does not translate old success flags or approvals.
It is a separate public verification and exact-byte publication operation,
not automatically executed by update. Validation commands can execute
project-controlled code; their private workspace is not a sandbox.

A failed local transaction uses bounded recovery. A failure after commit keeps
the successor incomplete and resumable: repair the named cause, rerun check, then approve the
remaining work. Do not reset state to v1, change identity fields manually, or
recreate live resources to silence readiness diagnostics.

New dependency, runtime, container, database, application, and infrastructure
templates apply to newly generated projects. Existing
production projects adopt them through a separately reviewed project change.
The existing `liftoff migrate` command only adopts a non-Liftoff source into a
fresh target; it is not an in-place template upgrade.

### Migration from 0.6.x and earlier manifest readers

The `--apply` flag was removed in 0.7.0. These are historical 0.6.x commands,
not current syntax:

| Historical 0.6.x command | 0.7.0 replacement |
| --- | --- |
| `liftoff update` when used as a read-only check | `liftoff update --check` |
| `liftoff update --apply` | `liftoff update` |
| `liftoff update --apply --force` | `liftoff update --force` |

Invoking removed syntax fails during argument parsing, before project discovery
or filesystem access.

Current readers support manifest artifact versions v2, v3, v4, v5, v6, and v7.
All current writes use v7. Supported historical reads are normalized through an
explicit compatibility map; future versions, individually known but unsupported
tuples, and unknown phase-graph hashes block and report an upgrade or
reconciliation remedy instead of downgrading or fabricating evidence.
Exact known activation-v1 identity remains non-executable. The explicitly
supported reviewed successor lane preserves that original history while
establishing new v2 state and fresh proof; merely reading a historical identity
or updating a core file does not perform or authorize the migration.

## Development and infrastructure helpers

`liftoff dev` and `liftoff infra` print commands rather than execute them.
Historical infrastructure helpers use recorded layout, not merely new-looking paths.
For a selected prod environment in the independent layout,
`liftoff infra init --env prod` targets
`infrastructure/opentofu/azure/environments/prod`; plan/apply use
`-var-file=prod.tfvars` in that same root. Operational init uses the configured
backend, not `-backend=false`. Only the local baseline disables backend
initialization, separately for every selected root. Recursive formatting remains
at the Azure parent to include the shared module.

The eight explicitly retired flat-root identities remain old provenance, not
aliases for new roots. See the [exact inventory](azure-deployment.md#explicit-flat-root-identity-retirement)
and [native runtime recipes](configuration-and-manifests.md#application-runtime-configuration).

For v8 source, helpers require explicit active bindings instead. Compose uses
the bound file and its directory; OpenTofu uses the bound selected-environment
directory and, for plan/apply, the bound variables file. These may differ from
their original generated paths. Unresolved/missing bindings, links, nested
project/repository boundaries, unselected environments and preserved state/key
overlaps prevent command emission. Directory observations stop explicitly above
256 entries. Neither a printed command nor its prior path observation approves
execution or guarantees that the path remains unchanged afterward.

## JSON and exit codes

Machine-readable maintenance contracts bypass decorative presentation:

```bash
liftoff validate --json
liftoff doctor --json
liftoff governance status --json
liftoff governance plan --json
liftoff governance apply-next --json
liftoff governance apply-next --json --execute
liftoff governance verify --json
liftoff upgrade --json
liftoff upgrade --check --json
liftoff update --json
liftoff update --check --json
```

Each JSON object has a top-level numeric `schemaVersion`. Update JSON uses
schema version 4 and `kind: "liftoff-current-project-update"`, with separate
publication commit, uncertain effects, scoped completion, preview and approval
results. A committed migration does not imply governance readiness.
Operational warnings, such as a dirty-worktree warning before JSON apply, are
written to stderr so stdout remains one parseable JSON object.

Exit codes:

- `0`: success or a clean check.
- `1`: invalid input, unsafe state, or command failure.
- `2`: update check found differences, update committed a migration but local
  revalidation is incomplete, or upgrade check found an installable CLI release.
  Governance assessment also uses 2 for partial or excepted results.

Raw installer, framework, and dependency child stdout and stderr are forwarded
unchanged.

## Terminal layouts

Interactive `init`, `migrate`, and `plan` display the Liftoff identity before
the first question.

- TTYs at least 96 columns use the rich wordmark, Unicode sections, aligned
  tables, and semantic color.
- Widths from 64 through 95 columns use a compact identity and wrapped
  sections.
- Narrow or redirected output is deterministic plain text without ANSI
  sequences or decorative borders.

Successful completion may include a section labeled `Next recommended command`.
The `$`-prefixed command is a suggested next action for the developer to review
and run; Liftoff has not executed it automatically.

Set `NO_COLOR=1` to keep the selected layout without ANSI color:

```bash
NO_COLOR=1 liftoff init
liftoff doctor > readiness.txt
```

JSON and version output never include banners or decorative layout.

## Catalog examples

```bash
liftoff patterns
liftoff providers
liftoff regions
liftoff regions search korea --cloud azure
```

Azure is the available provider. AWS and GCP are listed as planned and rejected
before generation.
