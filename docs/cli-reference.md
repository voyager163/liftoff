# CLI reference

Run `liftoff help` or command-specific help for the authoritative syntax:

```bash
liftoff init --help
liftoff migrate --help
liftoff governance --help
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
| `liftoff governance verify [project]` | Read-only validation of graph, state, evidence, task projection, policy identity, active-change identity, and live readback |
| `liftoff upgrade` | Replaces a verified global npm installation with the exact canonical stable release exposed by the configured registry |
| `liftoff upgrade --check` | Checks installation origin and registry parity without installing; exits 2 when an installable update exists |
| `liftoff update [project]` | Applies safe managed-core maintenance and authorized create-only component provisioning |
| `liftoff update --check` | Reports core maintenance and provisioning without mutation; exits 0 when clean and 2 when actionable |
| `liftoff update --force` | Overwrites only exact guarded managed-core conflicts; project-owned files remain unreachable |
| `liftoff dev` | Prints workload-appropriate local development commands; it does not execute them |
| `liftoff infra` | Prints OpenTofu guidance for API workloads and reports infrastructure as not applicable for Power Apps |
| `liftoff patterns` | Lists GenAI patterns |
| `liftoff providers` | Lists provider availability |
| `liftoff regions` | Lists available regions |
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
--type genai|standard|power-apps-code-app
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
--code-apps-plugin | --no-code-apps-plugin
--copilot-cloud | --no-copilot-cloud
--configure-openspec-profile
```

For an undecided GenAI architecture, use `--type genai --pattern generic`.
Interactive initialization presents **I'm not sure yet - Generic GenAI
starter** first and accepts it as the default. `liftoff patterns` lists this
stable `generic` identifier alongside the eight specialized patterns.

Power Apps rejects API, pattern, cloud, region, frontend, and API environment
options rather than ignoring them.

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

Governance JSON uses versioned objects and includes the complete activation
version vector: creating Liftoff version, manifest artifact version 7, policy
version 6, activation-contract version 1, graph/state/evidence/approval/
supersession/credential schema versions, and the phase-graph hash. It never
emits a setup-skill version. Future identities, unsupported compatibility
tuples, and unrecognized graph hashes block without rewriting state; the remedy
names the exact field and required Liftoff upgrade.

`/liftoff-setup` and the compatibility alias `/liftoff-repository-governance`
call these commands instead of inferring phase completion from prose or task
checkboxes.

OpenSpec projects use all 12 OpenSpec 1.11 workflows with both skills and
commands. `--copilot-cloud` opts into the GitHub-hosted coding-agent workflow and
agent definition; omission and `--no-copilot-cloud` keep it disabled.

OpenSpec stores workflow profile and delivery globally. If the observed profile
does not match Liftoff's complete contract, interactive runs request separate
consent. Noninteractive `init` and `migrate` require
`--configure-openspec-profile` to authorize the displayed
`openspec config set` commands. The flag has no effect during `plan`, which
never inspects or changes machine configuration.

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
liftoff update
liftoff update --force
liftoff update --json
liftoff update --check
liftoff update --check --json
```

Plain `liftoff update` is imperative and prompt-free. It applies safe new,
missing, untouched-upgrade, clean-move, and recorded-state changes only for
explicit `managed-core` artifacts. For manifest v7 this includes governance
policy, context, guide, phase graph, compatibility metadata, credential-policy
schema, setup integrations, and selected-agent compatibility aliases. Core
conflicts are skipped and core orphans are reported without deletion. During
legacy governance adoption, preserved unrecorded conflicts remain outside
managed ownership and set local state to `handoff-partial`.

Application source, tests, dependencies and locks, database assets, Docker and
Compose files, environment files, documentation, Power Apps starter files, and
OpenTofu topology are `project` artifacts after generation. Update does not
compare them with newer templates, restore deleted paths, or overwrite them
under `--force`.

Changing desired state from no frontend to frontend, or adding an environment,
can authorize one create-only provisioning group. All destinations are
preflighted together. Absent files are created and byte-identical files are
adopted as provenance; any differing destination blocks the group even with
`--force`. Disabling or re-enabling a previously provisioned group never
recreates or deletes project files.

Use `--check` whenever no project bytes may change. Human check mode prints
managed-core drift, ownership-only manifest v2-v7 migration, activation-identity
compatibility, reconciliation-required state, and authorized provisioning. It
recommends `--force` only for core conflicts. `--check --force` is invalid
because check mode never authorizes writes.

`--json` selects output format, not safety. `liftoff update --json` applies safe
changes and emits the versioned apply result. `liftoff update --check --json`
is the read-only automation gate.

Update never installs dependencies. Transaction snapshots restore a failed
core update, but Liftoff retains no backup after a successful core overwrite.
Force cannot bypass the ownership, project-boundary, symlink, structural,
identity, or manifest guards.

New dependency, runtime, container, database, application, Power Apps starter,
and infrastructure templates apply to newly generated projects. Existing
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

## JSON and exit codes

Machine-readable maintenance contracts bypass decorative presentation:

```bash
liftoff validate --json
liftoff doctor --json
liftoff governance status --json
liftoff governance plan --json
liftoff governance verify --json
liftoff upgrade --json
liftoff upgrade --check --json
liftoff update --json
liftoff update --check --json
```

Each JSON object has a top-level numeric `schemaVersion`. Update JSON uses
schema version 2 and includes `scope: "managed-core"`, ownership-migration
state, activation compatibility, and a separate provisioning collection.
Operational warnings, such as a dirty-worktree warning before JSON apply, are
written to stderr so stdout remains one parseable JSON object.

Exit codes:

- `0`: success or a clean check.
- `1`: invalid input, unsafe state, or command failure.
- `2`: an explicit update check found core maintenance or provisioning, or upgrade check found an
  installable CLI release.

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
