# CLI reference

Run `liftoff help` or command-specific help for the authoritative syntax:

```bash
liftoff init --help
liftoff migrate --help
liftoff governance --help
liftoff governance assess --help
liftoff upgrade --help
liftoff update --help
```

Unknown flags or commands, missing values, invalid booleans, incompatible
duplicates, and extra positional arguments fail before generation.

## Lifecycle

```text
install -> upgrade CLI -> plan -> init or migrate -> /liftoff-setup -> validate, doctor, governance verify -> update project -> dev and infra helpers
```

| Command | Behavior |
| --- | --- |
| `liftoff plan` | Resolves decisions and previews artifacts and requirements without side effects |
| `liftoff init [project-name]` | Initializes a named child or the exact current Git root through staged readiness and framework setup |
| `liftoff migrate <source>` | Creates a new sibling scaffold and filtered source copy without changing the source |
| `liftoff validate [project]` | Validates manifest identity, managed-core hashes, project provenance, workload metadata, and framework markers |
| `liftoff doctor [project]` | Runs read-only workload-derived project and workstation diagnostics |
| `liftoff governance status [project]` | Reports deterministic setup state, activation identity, phase states, blockers, approvals, and evidence freshness |
| `liftoff governance plan [project]` | Previews ready and blocked phase transitions, required evidence, approval gates, permitted mutations, and cost-envelope impact without writes |
| `liftoff governance apply-next [project]` | Previews the next graph-ready transition; add `--execute` to execute at most one approved mutation |
| `liftoff governance resume [project]` | Rechecks external blockers and readiness descendants without rerunning verified operations |
| `liftoff governance verify [project]` | Read-only validation of graph, state, evidence, task projection, policy identity, active-change identity, and live readback; reports consistency separately from setup completion and reports completion as indeterminate when inspection fails |
| `liftoff governance assess [project]` | Read-only comparison against the installed CLI's packaged governance target; local-only unless `--live` is explicitly requested |
| `liftoff upgrade` | Replaces a verified global npm installation with the exact canonical stable release exposed by the configured registry |
| `liftoff upgrade --check` | Checks installation origin and registry parity without installing; exits 2 when an installable update exists |
| `liftoff update [project]` | Applies safe managed-core maintenance and authorized create-only component provisioning |
| `liftoff update --check` | Reports core maintenance and provisioning without mutation; exits 0 when clean and 2 when actionable |
| `liftoff update --force` | Overwrites only exact guarded managed-core conflicts; project-owned files remain unreachable |
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

Generation, validation, doctor, governance, and update consume the packaged
[supported-stack baseline](supported-stack.md). The current contract uses
Node.js 24 LTS, Python 3.14, Go 1.27, OpenTofu 1.12, OpenSpec 1.11, and Spec Kit
1.0 release lines; these commands never resolve mutable latest versions.

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
--spec openspec|spec-kit
--agents copilot,claude
--default-agent copilot|claude
--governance single-maintainer-gitflow|none
--copilot-cloud | --no-copilot-cloud
--configure-openspec-profile
```

For an undecided GenAI architecture, use `--type genai --pattern generic`.
Interactive initialization presents **I'm not sure yet - Generic GenAI
starter** first and accepts it as the default. `liftoff patterns` lists this
stable `generic` identifier alongside the eight specialized patterns.

Power Apps and Code Apps plugin inputs are retired and rejected, including
false/negated plugin flags. Existing retired manifests are not reinterpreted as
supported workloads or ordinary Git repositories.

Consent options are documented in [safety and consent](safety-and-consent.md).
Repository governance defaults to `single-maintainer-gitflow`. It generates a
local deterministic setup handoff only; `none` omits it. See
[repository governance](repository-governance.md).

## Governance setup commands

```bash
liftoff governance status [project] [--json]
liftoff governance plan [project] [--json]
liftoff governance apply-next [project] [--json] [--execute]
liftoff governance resume [project] [--json]
liftoff governance verify [project] [--json]
```

These commands are strict and project-aware. Unknown governance subcommands,
unknown flags, invalid `--execute` placement, or extra positionals fail before
project discovery or mutation. `status`, `plan`, and `verify` are read-only.
`apply-next` previews by default; `--execute` is the explicit request to save the
reviewed plan and execute at most one phase whose dependencies, evidence, and
approval envelope are satisfied. `resume` rechecks blockers and downstream
readiness without repeating verified operations.

Apply-next JSON names the attempted phase in `selectedPhase` and reports
`executedPhase` on execution (`null` on failure). For compatibility its existing
`nextReadyPhase` field can refer to the phase just attempted, not the next
post-transition phase. Read `nextReadyPhase` from the subsequent `status` or
`verify` result. Status/resume preserve `storedState` and `storedBlockers` when
an archived baseline is `retryable`; only explicit execution may replace that
failure with verified evidence.

Governance JSON uses versioned objects and includes the complete activation
version vector: creating Liftoff version, manifest artifact version 7, policy
version 6, activation-contract version 2, state/evidence-header/approval schema
versions 2, graph/supersession/credential schema versions 1, and the phase-graph
hash. Compatibility metadata is version 3. It never
emits a setup-skill version. Future identities, unsupported compatibility
tuples, and unrecognized graph hashes block without rewriting state; the remedy
names the exact field and required Liftoff upgrade. Known v1 history is
diagnostic-only and byte-preserved; a supported successor requires
`liftoff update --check` and explicit approval, not automatic reconciliation.

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

OpenSpec projects use all 12 OpenSpec 1.11 workflows with both skills and
commands. `--copilot-cloud` opts into the GitHub-hosted coding-agent workflow and
agent definition; omission and `--no-copilot-cloud` keep it disabled.

OpenSpec stores workflow profile and delivery globally. If the observed profile
does not match Liftoff's complete contract, interactive runs request separate
consent. Noninteractive `init` and `migrate` require
`--configure-openspec-profile` to authorize the displayed
`openspec config set` commands. The flag has no effect during `plan`, which
never inspects or changes machine configuration.

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
credential discovery. Only `assess` accepts `--live`; assessment rejects
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
stable `reasonCode`. Status is one of `current`, `update-available`, `upgraded`,
`blocked`, or `failed`. Child progress goes to stderr so stdout remains one JSON
object.

## Update modes

```bash
liftoff update --check
liftoff update
liftoff update --force
liftoff update --check --json
liftoff update --approve-plan <fingerprint> --json
```

`liftoff update --check` is the human-first compatibility and migration preview.
It changes no project bytes, but saves and discloses a project-bound preview
receipt in user-local storage outside the repository. A receipt is not approval.
`liftoff update` requires a matching preview, recomputes its effective plan, and
asks for explicit approval with a negative default. Missing or stale previews
stop with instructions to rerun check. No-op inspection requires no approval.

Noninteractive apply additionally requires the exact full plan fingerprint
through `--approve-plan`. Check and apply must share the same materialized
checkout and user-local storage; another runner, worktree, or moved project
needs a fresh check and approval. `--force`, `--json`, and a generic yes do not
waive these gates. The force variant has its own preview and fingerprint.

Approved apply retains safe new, missing, untouched-upgrade, clean-move, and
recorded-state changes only for explicit `managed-core` artifacts. For manifest v7 this includes governance
policy, context, guide, phase graph, compatibility metadata, credential-policy
schema, and selected-agent `/liftoff-setup` integrations. Core conflicts are
skipped and core orphans are reported without deletion. During legacy governance
adoption, preserved unrecorded conflicts remain outside managed ownership and
set local state to `handoff-partial`. Forced update may remove exact retired
generated setup-alias entries from older manifests after review.

Application source, tests, dependencies and locks, database assets, Docker and
Compose files, environment files, documentation, and
OpenTofu topology are `project` artifacts after generation. Update does not
compare them with newer templates, restore deleted paths, or overwrite them
under `--force`.

Changing desired state from no frontend to frontend, or adding an environment,
can authorize one create-only provisioning group. All destinations are
preflighted together. Absent files are created and byte-identical files are
adopted as provenance; any differing destination blocks the group even with
`--force`. Disabling or re-enabling a previously provisioned group never
recreates or deletes project files.
New environments also require recorded independent-root infrastructure and safe
existing shared-module files. Legacy/shared or unknown layout produces a
component-level migration-required result; other safe managed-core work may
continue. Force cannot migrate infrastructure state or rewrite shared infrastructure.
New component provisioning is deferred during activation-v1 migration and needs
a fresh post-migration preview.

Use `--check` whenever no project bytes may change. Human check mode prints
managed-core drift, ownership-only manifest v2-v7 migration, activation-identity
compatibility, history preservation, revalidation gaps, and authorized
provisioning. It recommends `--force` only for eligible owned core conflicts
and displays the additional exact changes and fingerprint separately.
`--check --force` remains invalid because check mode never authorizes overwrites.

`--json` selects output format, not safety or consent. Update JSON uses schema 3
with project-update scope and separate core, provisioning, activation-migration,
and revalidation outcomes. Prompts and progress use stderr; stdout remains one
JSON result. Check exits 0 for no actionable work, 2 for differences, and 1 for
errors. Apply exits 0 for completed scope, 2 when migration committed but
revalidation is incomplete, and 1 for rejected approval or an error.

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
into the project. Commands containing spaces or shell metacharacters use literal
native-shell quoting and retain the selected project path.

The immutable history snapshot travels inside the project. Preview receipts and
approval records do not: another machine, checkout, worktree, or moved project
needs its own fresh check and approval. A receipt stores digests, not project
source bodies, and is never portable blanket authorization.

### Reviewed activation-v1 migration

An exact supported v1 source can be previewed with `liftoff update --check`.
Approved update verifies an immutable in-project history snapshot before
replacing active records, then creates a linked strict v2 activation. Historical
state, evidence, plans, approvals, and source metadata retain their original
bytes under the dedicated governance history directory. History is not managed
core and is never automatically committed, pushed, or cleaned with receipts.

Fresh local revalidation does not translate old success flags or approvals.
It uses only the finite reviewed local operations and stops before provider
access, dependency installation, publication, or other independently approved
work. Validation commands execute project-controlled code, not a sandbox;
unexpected protected-input edits are preserved and reported.

A failed local transaction uses bounded recovery. A failure after commit keeps
v2 blocked and resumable: repair the named cause, rerun check, then approve the
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
Infrastructure helpers use recorded layout, not merely new-looking paths.
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
schema version 3 and `scope: "project-update"`, with separate managed-core,
provisioning, activation-migration, and revalidation outcomes plus preview and
approval status. A committed migration does not imply governance readiness.
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
