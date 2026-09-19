# Reviewed in-place project adoption

`liftoff adopt` integrates an explicitly selected existing supported application
or component **in place**. It is separate from new-project `init`, managed-core
`update`, registered `repair`, source-read-only fresh-target `migrate`, and
installation-owner migration. The current writer is the unpublished `0.13.0`
development candidate; implementing a local workflow is not native-platform or
production-provider release qualification.

## Select and inspect the actual boundary

```sh
liftoff assess --project /work/customer-ui --profile vue-component
liftoff adopt --project /work/customer-ui --profile vue-component --check --json
```

Profiles are the installed catalog's `python-fastapi`, `node-fastify`, `go-huma`,
`vue-component`, and supported `genai-<pattern>` identities. For a selected
component beneath a project root, use `--component <relative-directory>`.
Choose the boundary deliberately: neighboring applications are not silently
converted into that component. Unsupported or ambiguous source frameworks stay
assessment-only until an actual supported boundary is established.

Inspection does not initialize Git, write a real manifest, run project scripts,
prepare dependencies or contact GitHub/Azure. Check saves a disclosed immutable
preview outside the project/repository. A Vue-only adoption records
`project.workload: {"kind":"components"}` and the actual Vue profile/root; it has
no invented API, backend, GenAI pattern, cloud environment or generation history.

JSON contains the current bounded assessment, `inventory`, selected catalog
identities, exact plan and required permissions. The inventory supplies actual
file digests/modes, `inspectionDigest`, `target.digest`, and observed reference
IDs for proposal authors. It contains no original source bodies, credentials or
state payloads.

Assessment classifications and recommendations are advisory, not adoption
authority. Adoption independently captures and rechecks the selected component's
actual declarations, source, modes and directory boundaries. Selecting a target
profile does not prove historical generation, business behavior or conformance
with every rule in that profile.

Go observations require real top-level imports and bound Huma calls in the
selected component's non-test source. Named aliases, import blocks and Go string
escapes retain their language meaning. Dependency declarations, comments,
quoted examples, unused imports or another component's code do not establish
that source fact. This observation does not compile or execute the application.

## Metadata-only adoption

On a genuine input/stderr terminal, omit `--check` and `--json` to review the
current plan and answer its action-specific **default-No** questions. No human
fingerprint copying is required. A metadata-only adoption can establish minimal
desired state and manifest 8 with `framework.state: "uninitialized"`; it does
not pretend that an official framework, coding agent, project tests or live
governance have been initialized or verified.

The initial CLI proposal selects one explicit supported component. Other
components remain untouched; a profile or component conversion is not an update
or permission to copy a starter over them. Existing Liftoff projects use the
appropriate separately reviewed maintenance operation instead.

## Explicit application proposals

Use `--proposal <external-json>` for reviewed application changes or selected
framework/agent/governance additions. The proposal and staged replacement files
must live in a disjoint directory outside the real project, not its ancestor.
The strict proposal uses these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `liftoff-adoption-proposal` |
| `projectRoot`, `inspectionDigest` | Exact canonical project and current adoption inventory |
| `projectName`, `profile`, `componentRootPathParts` | Explicit metadata target and portable component boundary |
| `framework` | `workflow`, canonical `agents`, applicable `defaultAgent`, `initialize`, `copilotCloud` |
| `governanceProfile` | `none` or `single-maintainer-gitflow` |
| `dynamicReferencesReviewed` | Explicit `true` after actual developer review; not model confidence |
| `patch` | `null` or the unchanged schema-1 [application patch](application-repair.md) document |
| `additions` | Exact `logicalName`, `componentId`, `targetPathParts`, `stagedPathParts`, `targetMode`, `precondition`, `references` per addition |
| `verification` | Exact bounded `commands` and registered `preparation` requests |

For an existing-file patch, both `patch.verification` and the outer verification
must identify the same checks/preparation. The nested patch still requires
observed existing sources and complete reference dispositions; it does not gain
new-file or protected-metadata authority. Additions use their **separate**
adoption declaration and an `absent` or exact byte-and-mode `identical`
precondition. Their `componentId` is the plan's selected component ID. Every
observed outgoing addition reference uses its exact candidate `referenceId`,
`disposition: "updated"`, and concrete `afterTargetPathParts`.

No path prefix, matching hash, proposed manifest, model-written approval or
`--force` grants ownership. Application proposals cannot touch manifests, desired
state, framework/agent control files, approvals, activation evidence, history,
credentials or infrastructure. File, mode, directory, root, staged-byte,
configuration, catalog, tool or expiry changes invalidate the reviewed plan.
Installed profile and resource catalogs are reread and strictly validated even
after a preview has warmed their caches. A valid new catalog identity still
requires a new plan; unreadable or damaged metadata is never replaced with
fallback hashes or inferred source facts.

## Preparation, checks, and final file approval

Approval for one effect does not authorize the others:

1. Approve the displayed project-code checks.
2. Separately approve any registered locked dependency preparation.
3. Separately approve declared network effects.
4. Inspect the actual successful required verification.
5. Approve the exact application/metadata/framework file transaction.

The released `npm-ci`, `uv-locked-sync` and `go-mod-download` version-1 providers
retain their lock, tool, package-source and lifecycle restrictions. There is no
global tool installation, live dependency-tree reuse, lock rewriting, undeclared
runtime download, ambient registry credential inheritance or install-hook
permission.

Private copies, filtered environments and owned-process supervision are **not**
an operating-system or network security sandbox. Trusted code can have other
host effects. A zero exit proves only its declared check; unsupported mandatory
isolation or validation remains blocked. Uncertain process settlement retains
the exact registered workspace and cannot issue successful verification or
unsafe cleanup.

For automation, first obtain independent user authorization for the exact
displayed scopes, then use the saved plan fingerprint:

```text
liftoff adopt --project <project> --verify-plan <fingerprint>
liftoff adopt --project <project> --verify-plan <fingerprint> --allow-dependency-preparation --allow-network
liftoff adopt --project <project> --approve-plan <fingerprint>
```

Only include preparation/network flags when those effects are approved and
declared. Verification and file approval are separate invocations; the CLI
rejects combining them. JSON and redirected input never prompt. Generic Yes,
piped answers, host autopilot, an agent's approval claim or a fingerprint from
another plan are not authority.

Declining file approval after checks does not erase earlier preparation, code,
network or host effects. The result retains those actual effects and reports
that the file transaction did not run.

## Official framework and managed integrations

A proposal can select official OpenSpec or Spec Kit initialization with canonical
agents. The exact pinned tool/runtime must already be available. The CLI uses
the supported official initializer in a registered private workspace, with
separate code/network consent and process settlement.

Successful private initialization produces a **new exact-byte final plan**.
Malformed or expired receipt timestamps and an invalid review clock block reuse.
Review that plan before application verification or file approval. The real
project still has no new framework files or manifest at that point. Unknown
output, custom destination collisions, changed modes or unsupported tool
contracts block delivery; no existing user/framework content is replaced.
Framework files remain framework-owned, while only exact selected registered
managed integrations acquire reconciliation hashes.

## Records, recovery and later maintenance

An approved transaction writes an independent schema-1 record at
`.liftoff/adoption-history/<record-id>/record.json`. Original application backups
remain in the separate user-local `adoption-backup` namespace. The durable
`.liftoff/reviewed-adoption-transaction.json` journal uses the released guarded
transaction, per-effect checkpoints, cooperating lock, exact preconditions and
independent external approval binding. It is not a converted update or repair
journal.
The adoption lane additionally seals the reviewed parent-directory identities
and each actual directory creation. It rechecks those identities before staged
renames and recovery; identical file bytes inside a replaced parent are not
authority to write there. Recovery conservatively retains created directories
and reports them rather than deleting an empty directory solely because its path
was absent during planning. An older or incomplete adoption journal lacking the
required directory evidence remains blocked without format conversion.

```sh
liftoff adopt --project /work/customer-ui --recover
```

Recovery handles only attributable recorded effects. It preserves changed
destinations, uncertain owners, original history and backups; it does not force
unlock, scan/delete guessed paths or start a new adoption. A matching repeated
adoption is a readback/no-op, not a replay of the original approval.

Manifest 8 separates adopted observations and reviewed additions from real
generation. Later managed update uses the recorded profile/layout and exact
managed identities, never application template comparison. Application patches
retain their independent repair record and do not rewrite manifest provenance.
No adoption receipt authorizes Git publication, repository controls, cloud/state
operations, installation migration or production completion.
