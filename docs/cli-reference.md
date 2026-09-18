# CLI reference

Run `liftoff help` or command-specific help for the authoritative syntax:

```bash
liftoff init --help
liftoff migrate --help
liftoff governance --help
liftoff governance assess --help
liftoff upgrade --help
liftoff update --help
liftoff repair --help
liftoff capabilities --help
liftoff assess --help
liftoff adopt --help
liftoff skills --help
liftoff installation --help
```

Unknown flags or commands, missing values, invalid booleans, incompatible
duplicates, and extra positional arguments fail before generation.

## Lifecycle

```text
install -> upgrade CLI -> plan -> init or migrate -> /liftoff-setup -> validate, doctor, governance verify -> update project -> dev and infra helpers
```

| Command | Behavior |
| --- | --- |
| `liftoff capabilities --json` | Reports installed capability contracts, owners, schemas, and distinct availability/qualification states without a project, probes, disclosure, or writes |
| `liftoff plan` | Resolves decisions and previews artifacts and requirements without side effects |
| `liftoff init [project-name]` | Initializes a named child or the exact current Git root through staged readiness and framework setup |
| `liftoff migrate <source>` | Creates a new sibling scaffold and filtered source copy without changing the source |
| `liftoff validate [project]` | Validates manifest identity, managed-core hashes, project provenance, workload metadata, and framework markers |
| `liftoff doctor` | Runs read-only workload-derived project and workstation diagnostics from the selected working directory |
| `liftoff governance status [project]` | Reports deterministic setup state, activation identity, phase states, blockers, approvals, and evidence freshness |
| `liftoff governance plan [project]` | Previews dependency-ready work before approval and saves a disclosed project-bound receipt outside the repository; no project/provider mutations |
| `liftoff governance approve [project] --plan <fingerprint>` | Approves only the exact unexpired preview; does not execute its operations |
| `liftoff governance apply-next [project]` | Previews the next graph-ready transition; add `--execute` to execute at most one approved mutation |
| `liftoff governance credential-enroll [project] --plan <fingerprint>` | Uses the approved credential plan and a private input channel; never accepts a token argument |
| `liftoff governance recover [project] --plan <fingerprint>` | Previews an explicitly planned recovery; `--execute` runs only its approved scope |
| `liftoff governance resume [project]` | Rechecks external blockers and readiness descendants without rerunning verified operations |
| `liftoff governance verify [project]` | Read-only validation of graph, state, evidence, task projection, policy identity, active-change identity, and live readback; reports consistency separately from setup completion and reports completion as indeterminate when inspection fails |
| `liftoff governance assess [project]` | Read-only comparison against the installed CLI's packaged governance target; local-only unless `--live` is explicitly requested |
| `liftoff assess [path]` | Read-only whole-project standards assessment across supported profiles without mutating files or running code |
| `liftoff adopt <path>` | Reviewed in-place adoption of an explicitly selected supported application with manifest v8; non-TTY/JSON calls preview unless separately authorized |
| `liftoff installation inspect` | Non-mutating inspection of running binary, installation owner, prefix, and conflicting launchers |
| `liftoff installation migrate --to <owner>` | One-time legacy npm-to-native installation handover with schema-1 plan, TTY/exact approval, and read-only recovery |
| `liftoff installation migrate --recover` | Read-only checkpoint recovery exposing a fresh recovery plan without repeating proven npm retirement |
| `liftoff skills list` | Lists canonical skill library workflows and supported host projections (Copilot, Claude, Codex) |
| `liftoff upgrade` | Requests an owner-preserving CLI upgrade through its verified delivery channel; does not authorize installation-owner migration or project changes |
| `liftoff upgrade --check` | Checks actual owner and target availability without installing or refreshing manager configuration; exits 2 when an admissible update exists |
| `liftoff update [project]` | Applies safe managed-core maintenance and authorized create-only component provisioning |
| `liftoff update --check` | Reports core maintenance and provisioning without mutation; exits 0 when clean and 2 when actionable |
| `liftoff update --force` | Overwrites only exact guarded managed-core conflicts; project-owned files remain unreachable |
| `liftoff repair [project-path]` | Displays an exact plan and offers action-specific default-No approval on a genuine terminal; no fingerprint entry |
| `liftoff repair [project-path] --check` | Checks/previews bounded infrastructure repair without cloud calls, application scripts or project writes |
| `liftoff repair [project-path] --recipe azure-baseline-settings --check` | Pure inspection/preview for Azure baseline settings (Redis/Service Bus TLS 1.2, Storage TLS 1.2, public blob disabled) without tool execution |
| `liftoff repair --capabilities --json` | Lists packaged repair contracts, recipes, schemas and real command modes without needing a project |
| `liftoff repair [project-path] --inspect-layout` | Inventories actual application paths, target identities, references and unresolved mappings without execution |
| `liftoff repair [project-path] --application-patch <patch.json>` | Reviews external staged application mappings; interactive verification/network/file consents remain separate |
| `liftoff repair [project-path] --check --live --subscription <UUID>` | Explicitly requests bounded Azure metadata discovery with existing authentication and one selected subscription |
| `liftoff repair [project-path] --verify-plan <fingerprint>` | Optional automation for exact staged application checks or baseline settings; declared preparation requires `--allow-dependency-preparation` and declared network requires `--allow-network` |
| `liftoff repair [project-path] --approve-plan <fingerprint>` | Optional automation for an eligible separately approved exact file plan; application patches and baseline settings need fresh matching verified checks |
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

### Capability and continuation contracts

Public capability discovery uses schema 1 without wrapping or renumbering
existing command reports. Repair still emits report schema 2, update emits
output schema 3, and governance emits output schema 3. `init` and fresh-target
`migrate` remain human-output commands: their capability descriptors explicitly
use `outputFormat: "human"` and `resultSchemaVersion: null`, not a fictional
JSON schema or new approval flag.

Available continuations carry literal `executable`/`args`, canonical `cwd`,
target, scope, compatibility requirements, and any captured configuration
reference/digest. The arguments must express the same target, governance scope,
and configuration; a display string is not execution authority. Unsupported
bindings stay blocked guidance instead of losing context. PowerShell renders
literal quoted arguments, including `@`-prefixed values, without splatting.
Commands selecting one existing project reject simultaneous positional and
`--project` targets. Fresh-target `migrate` remains distinct: its positional
source and `--project` destination have different roles.
Project-scoped skills actions also bind an omitted `--project` selector to their
canonical `cwd`; dropping the project selectors cannot silently switch their
metadata to the CLI's default personal scope.
Only each command's existing authorization contract can permit effects.
Governance schema-3 action metadata includes an exact schema-1 `continuation`
alongside its label and retained flat command fields. Validate that nested
contract rather than treating presentation labels as protocol fields.
`approvalRequired` describes a further governance approval envelope; a false
value never removes the continuation's exact-plan execution or protected
credential-enrollment requirements.

Capability availability is not publication proof. Planner-only,
prerequisite-blocked, implementation-missing, and unqualified results remain
distinct, and release admission separately requires actual matching evidence.
The unpublished candidate keeps built-in implementations `unqualified` until the
required installed/native-host evidence is complete. Advertised platforms are
not removed to manufacture qualification, and missing production executors stay
`implementation-missing`. A successful local source check cannot promote either
state to a qualified native release.
See [native installation](native-installation.md) for owner discovery and the
explicitly historical npm boundary.

### Native CLI diagnostics

Doctor's CLI layer observes the Node process actually running Liftoff; it does
not require an ambient Node installation merely to diagnose a native CLI.
Project/framework Node and npm remain separate requirements. The private CLI
runtime never substitutes for a missing project toolchain.

CLI freshness uses the non-installing native owner check, independently of
project `.npmrc`, scoped npm registries and historical npm overrides. Upstream
availability and readiness of the actual owner source are separate observations;
manager lag, unknown ownership, errors and missing release authority are not
reported as current or repaired through an npm fallback. Native observations in
the schema-1 doctor report retain earlier completed/uncertain effects and
required recovery rather than claiming an untouched installation.

Run `liftoff installation inspect --json` for read-only ownership diagnostics.
Owner migration, recovery and routine upgrade keep their separate authority;
doctor never chooses a new owner, refreshes sources, installs, or upgrades.
Doctor itself is cwd-based, not a positional-project command.

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
--agents copilot,claude,codex
--default-agent copilot|claude|codex
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
approval envelope are satisfied. `resume` rechecks blockers and downstream
readiness without repeating verified operations.

Apply-next JSON names the attempted phase in `selectedPhase` and reports
`executedPhase` separately. `nextReadyPhase` is recomputed after execution;
`nextPlannablePhase` can identify work awaiting approval. A pending external
operation retains its provider handle and is polled, not dispatched twice.
Status/resume preserve `storedState` and `storedBlockers` when
an archived baseline is `retryable`; only explicit execution may replace that
failure with verified evidence.

Governance command JSON uses schema 3 and includes selected `scope` (`local`,
`repository`, `activation`, or `lifecycle`), separate scope progress, and
`nextActions`. Each action carries its registered executable/argument array,
project working directory, scope, and approval requirement; integrations must use it
rather than invent commands. The candidate execution identity uses activation
package 0.13.0, manifest artifact 8, policy 8, activation contract 4, graph schema
3, state/evidence/approval schemas 4, credential-policy schema 2, supersession schema 1, and
the computed graph hash. Compatibility metadata is schema 5. It never
emits a setup-skill version. Future identities, unsupported compatibility
tuples, and unrecognized graph hashes block without rewriting state; the remedy
names the exact field and required Liftoff upgrade. Historical v1/v2/v3 records and
the exact pre-amendment policy-7/schema-1 candidate are
diagnostic-only and byte-preserved; a supported successor requires
`liftoff update --check` and explicit approval, not automatic reconciliation.

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
Never put credentials, raw state, or private plans in that file.
Credential enrollment uses a private TTY by default; `--protected-stdin`
explicitly selects a protected automation channel. A fingerprint is not a
token, and approval alone neither enrolls a credential nor provisions resources.
Actual provider permission requirements (`organization_administration` read) and
current schema-2 permission admission and preserved schema-1 boundaries are documented in
[credential permissions and policy admission](credential-permissions.md).
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

The unpublished 0.13.0 candidate uses native release metadata and the proven
current installation owner: `homebrew-cask`, `winget`, or `direct`.
`liftoff upgrade` is an imperative owner-preserving request; it does not prompt or accept `--yes`,
`--force`, `--install-tools`, project paths, or project dependency flags.
It never falls back to npm or silently changes owners. An npm-owned installation
returns `migration_required`; unknown, conflicting, or unlinked ownership blocks
routine replacement. Use the separate installation inspection/migration journey.

`--check` observes ownership and exact upstream/owner availability without
installing or resuming an unfinished upgrade. An available upstream version does
not prove the current owner can deliver it. Apply requires the independently
admitted target, exact owner operation, and replacement verification; uncertain
effects retain their original recovery records rather than permitting blind retry.
Native artifacts and channels remain unpublished/unqualified, so these command
contracts do not establish present package-manager availability.

Native JSON results use schema version 1 with `distribution: 'native'`, `mode`,
`status`, `currentVersion`, optional `targetVersion`, `owner`,
`upstreamAvailability`, `ownerAvailability`, `reasonCode`, `completedEffects`,
`uncertainEffects`, and `recoveryRequired`. A blocked or incomplete outcome may
also include `manualAction` or `recordPersistence`. Exits are 0 for `current` or
`upgraded`, 2 for `update-available`, and 1 for blocked/failed outcomes.

### Historical npm upgrade behavior

The v0.12.3-and-earlier npm upgrader replaces only a supported global installation
of `@msn-control/liftoff`. It cannot discover or install native-only releases.
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

## Installation inspection and migration modes

```bash
liftoff installation inspect [--json]
liftoff installation migrate --to <owner> [--destination <path>] [--launcher <path>] [--plan] [--json]
liftoff installation migrate --to <owner> [--destination <path>] [--launcher <path>] --approve-plan <fingerprint> [--json]
liftoff installation migrate --recover [--json]
```

`liftoff installation inspect` performs non-mutating inspection of the running binary,
package owner (`npm`, `homebrew-cask`, `winget`, or `direct`), prefix, and conflicting
launchers in `PATH`. It makes no file writes or network changes.

`liftoff installation migrate` coordinates the one-time legacy npm-to-native handover.
JSON+TTY and bare non-TTY invocations are strictly preview only. Execution requires
either the displayed default-No TTY confirmation or automation via `--approve-plan <fingerprint>`.
Direct migration requires explicit `--destination <path>` and `--launcher <path>`.

`liftoff installation migrate --recover` is strictly read-only: it preserves completed
effects, exposes a fresh recovery plan, and permits resuming through normal migrate
exact approval without repeating proven legacy npm retirement.

JSON results use schema version 1 and expose
`{ command: 'installation', mode, status, inspection | plan | record | recovery }`.
Structured continuations (`nextActions`) use the admitted candidate's absolute executable
(never a bare legacy `PATH` launcher), exact canonical arguments, `scope: "installation"`,
action-specific authorization, and exact plan fingerprints. Human output discloses the
required working directory (`cwd`). Verified completion suggests only explicit
installed-launcher inspection, not project update. Failed operations emit no executable
retry; read-only `--recover` offers a fresh separately approved normal migration plan.

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

**Normal terminal use does not require copying a fingerprint.** Bare repair
shows the exact immutable plan and its effects, then asks Yes/No with default
No on usable input/stderr TTYs. Only Yes authorizes that displayed plan.
`--check` never executes the proposed repair. JSON and non-TTY invocations never
prompt or execute implicitly; piped yes, autopilot and generic confirmation are
not consent. No, cancellation or EOF before any effect approval leaves the
project unchanged. A later cancelled file approval prevents the file transaction,
but reports any earlier separately authorized verifier effects.

Use a positional project path to select another project, or run inside the
project (including a subdirectory). Commands in structured `nextActions` retain
separate executable/argument/cwd fields and native POSIX/PowerShell quoting.
Generated repair/update follow-ups retain an explicit absolute project target
even when originally invoked inside that project. Validation/doctor sequences
also select the recorded directory, so copying a remedy after changing
directories does not silently select another project.
Ordinary checks inspect bounded local configuration and state/backend metadata
presence without reading state or contacting cloud services. Only explicit
`--live` with a selected subscription permits bounded read-only Azure metadata
requests using existing authentication: no login, privilege expansion, state
reads, backend writes, or deployment.
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
the `application-layout-patch` version-1 recipe.

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

The verification flag (`--verify-plan`) authorizes only exact staged checks, not file
writes. It covers both application patches and the `azure-baseline-settings` recipe
(running locked backend-disabled private OpenTofu checks). Explicit
`--allow-dependency-preparation` permits only declared locked private preparation in
a fresh disposable environment for exact candidate manifests and locks (`npm-ci` v1,
`uv-locked-sync` v1, `go-mod-download` v1); it never installs global tools, mutates
live dependency trees, inherits ambient credentials, upgrades locks or commits
dependencies/build outputs. Declared network needs additional `--allow-network`
permission.

The file-approval flag (`--approve-plan`) commits files and history only. It never runs
verification on the caller's behalf: a fresh matching successful receipt is required
first for both application patches and baseline settings. File approval never starts
validation. Provider value interpretation for baseline settings is explicitly pinned
to AzureRM 5.3.0 (only 1.2 / TLS1_2 supported); unknown stronger-looking values block
unchanged. Flags cannot select a different patch, discovery subscription, command set
or recipe. Repeated matching verification can reuse its recorded result without claiming
another command ran.

Do not chain check and apply with `&&`: exit 2 can mean an available plan or a
blocked/plan-only result. Schema-2 results distinguish `inspected`, `current`,
`available`, `blocked`, `verified`, `applied`, `failed`, `partial` and `recovered`.
They contain `identity`, `capabilities`, `requestedScope`, `committed`,
`repairScopeComplete`, verification/effects, and typed `nextActions` (`command`,
`agent` or `guidance`). Fingerprints, receipts and exact operation digests remain
machine-readable audit data. A command action includes `command.executable`,
`command.args`, `cwd`, `scope`, `approvalRequired`, and native `displayCommand`;
complete command actions additionally carry a schema-1 `continuation` with
canonical target, action-specific authority, compatibility identity, and any
captured application-patch reference/digest. These additive execution-context
fields do not wrap or renumber the schema-2 report or its historical records.
`requiresInput` identifies a non-executable display template; it has no
`continuation` until confirmed values can be bound.
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

**Repair and preparation capabilities**: Application repair and locked
preparation were released in 0.12.3 and require `repairContractVersion` 1.
The unpublished 0.13.0 candidate adds `azure-baseline-settings` without changing
that repair-contract axis. Do not infer a recipe or preparation capability from
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

```bash
liftoff update --check
liftoff update
liftoff update --force
liftoff update --check --json
liftoff update --approve-plan <fingerprint> --json
```

Run update from the project root or a subdirectory: Liftoff finds the nearest
`liftoff.manifest.json`, so `--project` is not required for that project.
Human follow-ups omit `--project` when discovery from the invocation directory
selects the same target, and identify the selected project separately.
When a positional path or `--project` selects a different project, follow-ups
keep its explicit absolute target. An inner project never substitutes for an
explicitly selected outer project. JSON remedies remain explicitly targeted so
they can be used outside the originating shell.

After apply, the recommended validation sequence omits a directory change when
already at the project root. From other directories, including project
subdirectories, it retains the change to that root. Validate must succeed before
doctor runs; Liftoff prints these instructions without executing them.

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
`seed-verified` is **Local baseline verification**, not an OpenSpec feature
change. Human and JSON output retain the actual next phase and blocker, and
provide same-project repair/check follow-ups when recorded infrastructure needs
reorganization. JSON includes `revalidation.nextPhaseLabel`,
`revalidation.nextActions`, and `infrastructureRepair` separately from
`activationMigration.status` and `committed`: a committed migration remains
committed even when local verification is blocked. Infrastructure repair advice
can appear even when managed core is current and no activation revalidation is
required. The additive `continuations` array and
`infrastructureRepair.continuations` expose schema-1 command context alongside
the retained human guidance; the report remains update output schema 3.
They identify required authority, not permission to execute. An update
fingerprint never authorizes infrastructure repair.

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

### Reviewed activation-v1/v2 migration

An exact supported v1/v2 source can be previewed with `liftoff update --check`.
Approved update verifies an immutable in-project history snapshot before
replacing active records, then creates a linked strict v3 activation. Historical
state, evidence, plans, approvals, and source metadata retain their original
bytes under the dedicated governance history directory. History is not managed
core and is never automatically committed, pushed, or cleaned with receipts.

Fresh local revalidation does not translate old success flags or approvals.
It uses only the finite reviewed local operations and stops before provider
access, dependency installation, publication, or other independently approved
work. Validation commands execute project-controlled code, not a sandbox;
unexpected protected-input edits are preserved and reported.

A failed local transaction uses bounded recovery. A failure after commit keeps
v3 blocked and resumable: repair the named cause, rerun check, then approve the
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
