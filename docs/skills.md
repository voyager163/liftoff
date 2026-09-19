# Canonical Agent Skills and Host Projections

Liftoff provides one canonical, capability-negotiated skill library for
**GitHub Copilot**, **Claude Code**, and **Codex**. The library provides
developer assistance across the entire project lifecycle without duplicating
business logic, embedding a model SDK, or bypassing CLI admission gates.

## Architectural Principles

1. **Host Reasoning, Deterministic Execution**: Agent hosts supply LLM
   reasoning and conversational context; Liftoff provides deterministic CLI
   execution, admission checks, and approval gates. Skills never embed an LLM
   client, select model parameters, or self-certify approvals.
2. **One Canonical Workflow Library**: Canonical instructions, references,
   and examples are authored once under `assets/skills/`. Host projections
   derive their semantics from this shared library.
3. **No Independent Per-Skill SemVer**: Skill content is tracked by managed
   SHA-256 content hashes and capability contracts. Skills do not introduce
   an independent SemVer into project activation manifests.
4. **Action-Specific Approval Gates**: Skills delivery, adoption, update and repair
   retain their exact reviewed-plan mechanisms. Governance uses its own `approve`
   action, `--plan` binding and separate execution permission. Human-only `init`
   and fresh-target `migrate` retain narrow default-choice/plan consent; their
   `--yes` grants no independent overwrite, tool, global-configuration or dependency
   authority. Routine owner-preserving `upgrade` is authorized by its dedicated
   invocation without an extra fingerprint/prompt. Generic Yes, autopilot, piped
   answers and model-generated approval never substitute for these contracts.
5. **Exact Ownership and Shared Consumers**: Skill projections maintain exact
   ownership records. Unowned, modified, and neighboring files are protected.
   When multiple hosts share a physical projection, files are retained until all
   registered consumers are removed.

---

## Declared Host Discovery and Qualification Limits

Delivery targets documented discovery roots defined by authoritative host specifications.
**Host Qualification Notice**: Static markdown files, unit tests, or test fixtures
cannot claim production qualification of real agent hosts. Where live runtime execution
is not actively performed with valid host sessions, actual host qualification remains **pending**.

### 1. GitHub Copilot
- **Authoritative Reference**: [GitHub Copilot Documentation](https://docs.github.com/copilot) (Copilot CLI agent skills specification).
- **Personal Discovery Root**: `~/.agents/skills/<skill-name>/SKILL.md` (shared with Codex).
- **Project Discovery Root**: `.github/skills/<skill-name>/SKILL.md` (legacy project integrations use `.github/prompts/<name>.prompt.md`).
- **Minimum/Installed Host Baseline**: Not established by these local tests.
- **Actual Host Qualification Status**: **Pending live agent qualification**.

### 2. Claude Code
- **Authoritative Reference**: [Claude Code Documentation](https://docs.anthropic.com/claude-code) (Anthropic Claude Code CLI commands and skills guide).
- **Personal Discovery Root**: `~/.claude/commands/<command-name>.md`.
- **Project Discovery Root**: `.claude/commands/<command-name>.md`.
- **Minimum/Installed Host Baseline**: Not established by these local tests.
- **Actual Host Qualification Status**: **Pending live agent qualification**.

### 3. OpenAI Codex
- **Transport Contract**: The declared Codex skill projection is tested locally;
  an Assistants API reference is not evidence of native Codex discovery.
- **Personal Discovery Root**: `~/.agents/skills/<skill-name>/SKILL.md` (shared with Copilot).
- **Project Discovery Root**: `.agents/skills/<skill-name>/SKILL.md`.
- **Minimum/Installed Host Baseline**: Not established by these local tests.
- **Actual Host Qualification Status**: **Pending live agent qualification**.

---

## Canonical Workflows and Capability Engines

Liftoff's capabilities are owned by six explicit engines. Every canonical
skill maps to one of these owners:

| Workflow ID | Name | Owning Engine | Command Result Schema | Contract | Invocation (Copilot / Claude / Codex) |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `setup` | Liftoff Setup | Repository Governance | 3 | — | `/liftoff-setup` / `/liftoff-setup` / `$liftoff-setup` |
| `assess` | Project Assessment | Standards and Assessment | 1 | — | `/liftoff-assess` / `/liftoff-assess` / `$liftoff-assess` |
| `init` | Project Initialization | Project Generation | Human only | — | `/liftoff-init` / `/liftoff-init` / `$liftoff-init` |
| `adopt` | Project Adoption | Project Evolution | 1 | — | `/liftoff-adopt` / `/liftoff-adopt` / `$liftoff-adopt` |
| `update` | Project Update | Project Evolution | 3 | — | `/liftoff-update` / `/liftoff-update` / `$liftoff-update` |
| `repair` | Application Repair | Project Evolution | 2 | 1 | `/liftoff-repair` / `/liftoff-repair` / `$liftoff-repair` |
| `migrate` | Fresh-Target Scaffold | Project Evolution | Human only | — | `/liftoff-migrate` / `/liftoff-migrate` / `$liftoff-migrate` |
| `governance-assess`| Governance Assessment | Repository Governance | 1 | — | `/liftoff-governance-assess` / `/liftoff-governance-assess` / `$liftoff-governance-assess` |
| `governance` | Repository Governance | Repository Governance | 3 | — | `/liftoff-governance` / `/liftoff-governance` / `$liftoff-governance` |
| `azure` | Azure Activation | Azure Activation | 3 | — | `/liftoff-azure` / `/liftoff-azure` / `$liftoff-azure` |
| `cli-upgrade` | CLI Self-Upgrade | Distribution and CLI Upgrade | 1 | — | `/liftoff-cli-upgrade` / `/liftoff-cli-upgrade` / `$liftoff-cli-upgrade` |

### Unchanged Schema Contracts

Capability negotiation respects declared command-specific schemas rather than
forcing global conversion:
- `repair` retains its declared **contract 1** and **report schema 2**.
- `update`, `governance`, `azure`, and `setup` use **output schema 3**.
- `assess`, `adopt`, `governance-assess`, and `cli-upgrade` use **schema 1**.
- `init`, `migrate`, and target `plan` emit human output; there is no JSON result
  schema or `--json` flag for them. Fresh migration does not perform semantic
  application conversion or acquire source-write authority.
- Catalog `commandOutput` and nullable `commandResultSchema` distinguish human
  output from JSON. Capability IDs are the actual registered identities such as
  `project-generation`, `project-migration`, `project-repair`, and
  `repository-governance`, not invented CLI command names.

The loader uses the shared bounded packaged-resource reader for `skills.catalog`
and `skills.<id>`. Exact descriptor path, byte length and SHA-256 identity must
match before canonical metadata is accepted. Root/parent links, case/normalization
aliases, non-regular or multiply linked files, changed reads and oversized input
fail closed. Catalogs and source frames reject unknown/duplicate fields, hosts,
invocations and unregistered owner/capability/output/authorization tuples.

The retained native project producers read these verified canonical bodies.
They preserve the richer project setup, assessment and repair safeguards and all
nine registered paths without a separate per-host workflow implementation.
Retained setup, assessment and repair outputs stay below 3,000, 2,500 and 8,000
UTF-8 bytes respectively, including each host's metadata. Their common body
preserves context and consent; the managed manifest, not a textual ownership
label, establishes recorded file authority. Every command example is checked
against the production parser; that is not native agent/provider qualification.

---

## Host Discovery and Delivery Matrix

Liftoff delivers skills to two explicit scopes: **personal (user)** and
**project**.

### Personal Scope (`--scope user`)

Personal skills can be inspected and installed before any project is
initialized:

- **Shared Copilot and Codex Projection**: Copilot and Codex discover personal
  skills from `~/.agents/skills/`. Liftoff creates exactly **one** physical
  projection on disk (`~/.agents/skills/liftoff-<id>/SKILL.md`) and declares
  both hosts as consumers (`consumers: ["github-copilot", "codex"]`).
- **Claude Native Personal Commands**: Claude Code uses native personal commands
  under `~/.claude/commands/liftoff-<id>.md`.
- **Overlapping Discovery Disclosure**: When installing personal skills for
  Copilot or Codex, Liftoff discloses that `~/.agents/skills/` is shared with the
  other host. It does not rewrite or touch host settings files.
- **Repository Isolation**: Personal scope operations never write files to the
  current repository, project manifests, or global framework configurations.

### Project Scope (`--scope project`)

Project skills are delivered into the repository root:

- **GitHub Copilot**: `.github/skills/liftoff-<id>/SKILL.md` (legacy `.github/prompts/` are preserved).
- **Claude Code**: `.claude/commands/liftoff-<id>.md`.
- **Codex**: `.agents/skills/liftoff-<id>/SKILL.md`.

---

## Exact Ownership, Immutability, and Recovery Safety

Skill ownership records are persisted in `.liftoff/skills-ownership.json` under
the resolved discovery root (user home or project directory).

1. **Schema 1 Ownership Identity**: Records track `schemaVersion: 1`, projection
   `kind`, `catalogId`, and immutable by-plan fields (`canonicalContentHash`,
   `projectedContentHash`, `projectedMode`, and `consumers`).
2. **Zero Timestamp Churn**: Repeated matching executions perform zero disk writes;
   file inodes, modes, mtimes, and ctimes remain strictly unmodified.
3. **Exact Identical Adoption**: If an unowned file with matching bytes occupies
   a destination, a hash match alone does **not** establish ownership. Adoption
   must be explicitly proposed, reviewed, and approved under a bound plan fingerprint.
4. **Collision and Customization Protection**: Unowned files with differing bytes
   block delivery. Managed files modified on disk report a managed conflict and are
   preserved without automatic overwrite or deletion.
5. **Shared-Consumer Removal**: Removing Copilot when Codex is also a registered
   consumer does not delete the physical file; it updates the consumers list.
   Only when the final consumer is removed is the file deleted (and only if unmodified).
6. **Interrupted Transaction Recovery**: A sealed interrupted skills transaction
   can be recovered only by the exact same original request and matching plan
   fingerprint. Recovery executes only the sealed attributable operations; it performs
   no new work, and directories are retained without deletion authority.
7. **Neighboring File Safety**: Liftoff protects unrelated skills (such as OpenSpec
   `openspec-*` and Spec Kit `speckit-*` files), custom user scripts, and unknown files.
   They are never claimed, modified, or deleted.

---

## Legacy Project Integrations & Transport Migration Status

Projects initialized with previous versions of Liftoff may contain legacy integrations:
- Copilot: `.github/prompts/liftoff-setup.prompt.md`, `liftoff-governance-assess.prompt.md`, `liftoff-repair.prompt.md`
- Claude: `.claude/commands/liftoff-setup.md`, `liftoff-governance-assess.md`, `liftoff-repair.md`
- Codex: `.agents/skills/liftoff-setup/SKILL.md`, `liftoff-governance-assess/SKILL.md`, `liftoff-repair/SKILL.md`

### Migration Classification and Outcomes

`liftoff skills migrate` distinguishes retained transports, registered bounded
retirements, broader update prerequisites and blocked observations:

1. **Retained Native Transport (`migration-not-required`)**:
   - Current valid projects retain their 9 native IDs, paths, and invocations unchanged.
   - Standalone Copilot `.github/skills/` is **not** an automatic successor for existing prompts.
   - Returns exit code 0 when transports are current, or exit code 2 when same-path native maintenance is pending via `liftoff update`.
2. **Direct Registered Historical Alias Retirement (`migration-planned` / `migration-executed`)**:
   - Direct execution is limited to existing registered obsolete launchers, manifest
     8, unchanged manifest-owned sources, and already-owned unchanged native setup
     replacements. Both registered activation and migration state files must be
     absent. The released update planner must require no reconciliation, unrelated
     or deferred effects, activation-history transition, or revalidation; a
     no-revalidation result alone does not establish that activation is absent.
     The current reader must also report no orphan plans, evidence, approvals,
     reconciliation, credential policy or activation-baseline records. Its
     registered supersession handling is preserved; directory presence alone is
     not an orphan-record rule. This check repeats under the real lease before
     effects and during recovery/readback.
   - `--check` or non-TTY invocation without authority is a zero-write preview.
     Genuine default-No approval or this operation's exact `--approve-plan`
     fingerprint authorizes only the displayed retirement/manifest/history inventory.
   - Active native transports never move or overwrite. Original manifest/source
     bytes are preserved under `.liftoff/skill-transport-history/<key>/` with a
     registered schema-1 record and recipe-specific sealed recovery. A new
     activation/migration state or reader-detected orphan record blocks that
     recovery without deleting its journal or changing the new record; recovery
     cannot widen the original scope.
3. **Owning Update Required (`migration-update-required`)**:
   - Older, absent, or broader historical cases retain the existing update path:
     ```bash
     liftoff update --check --project <project-root> --json
     ```
   - These transitions require the update plan's own approval; a skills plan fingerprint cannot authorize a project update.
   - Returns exit code 2 with the recommended update action.
4. **Blockers & Protection Constraints**:
   - Returns exit code 1 if blocked by unowned file collisions, modified managed content, ambiguous discovery, or pending transactions/journals.
   - No alias resurrection: retired aliases (such as `liftoff-repository-governance`) are never revived.

---

## CLI Usage Reference

### Context-Bound Lifecycle Follow-Ups

Scoped skills results include `nextActions` using the shared schema-1 structured
continuation contract. Project follow-ups retain the canonical absolute
`--project` target, original `cwd`, literal argument array, selected hosts/skill,
required authority and compatibility identity. A preview does not grant that
authority: machine file/recovery actions still require separate approval of the
exact fingerprint; genuine terminal follow-ups retain the default-No journey
without requiring manual fingerprint entry. Completed operations offer only
read-only inspection, and declined decisions are not automatically repeated.

Personal follow-ups record the actual `userInstallTarget`, `targetScope: user`,
user scope, original cwd and proposed arguments in `nextActionGuidance`, with
`executable: null`. The registered CLI has no physical-home selector, so this
metadata is not emitted as an executable continuation that could silently select
another user's home. No project or `--home` flag is invented. Unaddressable or
unsafe recovery and context failures also remain explicitly nonexecuting guidance
without changing the original committed/verified/uncertain outcome.

### Public Subcommands and Syntax

The CLI exposes seven public subcommands: `list`, `plan`, `inspect`, `install`,
`update`, `remove`, and `migrate`.

- **Scope Defaults**: `--scope user` (personal) is the default, completely independent
  of current working directory. Project delivery requires explicit `--scope project --project <path>`.
- **Host Selection**: Explicit `--host <copilot,claude,codex>` CSV is required for
  all delivery operations (`plan`, `install`, `update`, `remove`). Note: `--host all`
  is not supported; explicit comma-separated host names (`copilot`, `claude`, `codex`)
  must be supplied.
- **Operation Preservation via `--check`**: The `--check` flag preserves the selected
  operation and returns a read-only plan preview without performing writes.
- **Non-TTY / JSON Previews**: In JSON or non-TTY mode without an approval fingerprint,
  bare redirected operations produce zero target and zero private writes, returning exit
  code 2 when plan authorization is required.
- **Machine Approval**: Non-interactive execution requires `--approve-plan <fingerprint>`
  matching the exact 64-character lowercase hexadecimal plan fingerprint.

### 1. Inspect the Canonical Catalog

```bash
# List all available canonical workflows and owning engines
liftoff skills list
liftoff skills list --json

# Inspect details of a specific workflow
liftoff skills inspect --skill repair
liftoff skills inspect --skill repair --json
```

### 2. Plan Delivery, Updates, or Removal

Inspect planned actions, collision checks, and shared-root disclosures without modifying files:

```bash
# Personal scope delivery plan for Copilot and Codex
liftoff skills plan --host copilot,codex
liftoff skills plan --host copilot,codex --json

# Project scope delivery plan
liftoff skills plan --scope project --project ./my-app --host copilot,claude,codex

# Check personal installation drift without mutating (exit code 2 if approval required)
liftoff skills install --host copilot,codex --check --json
```

### 3. Install Skills

```bash
# Interactive personal delivery (prompts with action-specific default No)
liftoff skills install --host copilot

# Machine delivery with explicit bound plan fingerprint
liftoff skills install --host copilot,codex --approve-plan <full-64-character-lowercase-hex>

# Deliver to an explicit project
liftoff skills install --scope project --project ./my-app --host claude --approve-plan <fingerprint>
```

### 4. Update Managed Skills

```bash
# Preview update plan
liftoff skills update --host copilot,codex --check

# Apply update with exact plan fingerprint
liftoff skills update --host copilot,codex --approve-plan <fingerprint>
```

### 5. Remove Managed Projections

```bash
# Remove Copilot (retains shared files if Codex remains a consumer)
liftoff skills remove --host copilot --approve-plan <fingerprint>

# Remove all hosts under explicit plan approval
liftoff skills remove --host copilot,claude,codex --approve-plan <fingerprint>
```

### 6. Migrate Project Transports

Inspect project transport status and migration requirements:

```bash
# Inspect migration requirements for an explicit project (read-only preview)
liftoff skills migrate --scope project --project ./my-app --host copilot --check
liftoff skills migrate --scope project --project ./my-app --host copilot --check --json
```
