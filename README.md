# Liftoff CLI

Status: implemented.

Liftoff is the open-source Mission Control Launchpad Engine. It exposes the `liftoff` command and scaffolds governed GenAI applications or standard APIs with Docker Compose, OpenTofu, and spec-driven governance assets.

Source, issues, and contribution guidance live at [github.com/voyager163/liftoff](https://github.com/voyager163/liftoff).

## Installation

The authoritative Liftoff release registry is `https://registry.npmjs.org`. Where direct public npm access is permitted, verify and install the latest stable CLI explicitly from that registry:

```bash
npm view @msn-control/liftoff@latest version --registry=https://registry.npmjs.org
npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org
```

After installation, confirm the resolved version and command availability:

```bash
liftoff --version
liftoff help
```

Versions before 0.3.0 are unsupported and must not be used for new projects. If npm is configured to use a managed registry or mirror, query `@msn-control/liftoff@latest` through that registry before installing and compare it with the canonical version. Stop if the managed registry exposes an older version or rejects the current explicit version; ask the mirror owner to synchronize or approve the release before onboarding resumes. Liftoff does not modify `.npmrc` or bypass managed-registry policy automatically.

## Quick Start

Preview a project and its derived workstation requirements without writing files or running installers:

```bash
liftoff plan --pattern rag --cloud azure --region eastus --frontend --agents copilot,claude
```

Initialize a named project. Liftoff probes required runtimes, the selected spec framework, cloud/development tools, and every selected AI coding agent before it writes:

```bash
liftoff init claims-copilot --pattern rag --cloud azure --region eastus --spec openspec --agents copilot,claude --frontend --yes
cd claims-copilot
cp .env.example .env
liftoff validate
liftoff doctor
```

Add `--install-tools` only after reviewing machine-level install commands, and add `--install-dependencies` to run the generated project's locked dependency commands. These permissions are independent from `--yes`.

To initialize an existing Git worktree root in place, run `liftoff init` at that exact root. With no project name, Liftoff uses the repository directory name; a supplied name changes project identity without creating a child directory.

```bash
cd existing-repository
liftoff init --no-genai --api node --cloud azure --region eastus --spec spec-kit --agents copilot,claude --default-agent copilot
```

In a non-Git directory or below (but not at) a Git root, a project name creates a named child. Standard API choices are `python` (FastAPI), `node` (Fastify with TypeScript), and `go` (Huma v2 with Chi). A GenAI `--pattern` selects the Python/FastAPI/PydanticAI stack.

For an existing application, migration creates a fresh sibling scaffold, runs the same readiness and official-framework pipeline, stages a filtered source copy, and leaves the source byte-for-byte unchanged:

```bash
liftoff migrate ../legacy-app --region eastus --agents copilot,claude --yes
```

## Lifecycle

```text
plan -> init or migrate -> validate and doctor -> update -> dev and infra helpers
```

- `liftoff plan` resolves project decisions, previews artifacts and requirements, and has no side effects.
- `liftoff init` initializes a new child or the exact current Git root, checks workstation readiness, runs the pinned official OpenSpec or Spec Kit initializer in temporary staging, validates all output, and merges transactionally.
- `liftoff migrate <path>` scans a non-Liftoff source, requires a new or empty sibling target, and uses the same staged framework and optional dependency phases. `--force` never permits a non-empty migration target.
- `liftoff validate` checks the manifest's durable files plus the declared framework contract and selected-agent markers.
- `liftoff doctor` performs read-only plan-derived probes with blocking, advisory, authentication-health, framework, drift, runtime, and cloud layers. JSON output uses stable requirement identifiers and states.
- `liftoff update` is a read-only drift check by default. `liftoff update --apply` writes safe durable changes, skips conflicts unless `--force` is supplied, and reports orphans without deleting them.
- `liftoff dev` and `liftoff infra` print Docker Compose and OpenTofu helper commands; they do not execute them.

Catalog discovery remains available:

```bash
liftoff patterns
liftoff providers
liftoff regions
liftoff regions search korea --cloud azure
```

Azure is the available V1 provider. AWS and GCP remain planned and are rejected before generation.

## Workstation Readiness

Liftoff automatically detects requirements derived from the full project plan:

- Blocking: Node.js 20.19+, the selected Python/Node/Go runtime, the exact tested OpenSpec or Spec Kit CLI, and every selected Copilot or Claude Code integration.
- Advisory: Docker and daemon health, OpenTofu, Azure CLI, and cloud authentication.
- Authentication: Liftoff reports observable health but never stores credentials or signs in on the developer's behalf.

On macOS, allowlisted recipes use Homebrew, npm, or `uv`; on Windows they use WinGet, npm, or `uv`. Liftoff prints each command and requires `--install-tools` or separate interactive approval. Linux system packages are never installed with automatic elevation: Liftoff gives distribution-appropriate official guidance, while npm/`uv` framework recipes remain separately consented. PATH-changing installs are re-probed and may require a new terminal.

Copilot is detected through its CLI or supported VS Code extensions. Claude Code is checked with its version and doctor commands. Both agents may be selected together; Spec Kit additionally records one selected agent as its default integration.

## Target, Ownership, And Consent Safety

Liftoff renders into a temporary staging directory, runs official framework commands there, rejects symlinks and unexpected framework roots, validates the complete tree, then computes one immutable destination preflight. Existing unrelated files are preserved. Different regular files are disclosed as one conflict set; structural collisions, symlink paths, unsafe ancestors, and an existing `liftoff.manifest.json` are non-overridable blockers. Writes are atomic and handled failures roll back created or replaced files.

The four consent flags do not imply one another:

| Flag | Authorizes | Does not authorize |
| --- | --- | --- |
| `--yes` | Project defaults and plan confirmation | File replacement, machine installs, or project dependencies |
| `--force` | Only listed, validated regular-file replacements | Manifest guards, symlinks, structural collisions, tools, dependencies, or non-empty migration targets |
| `--install-tools` | Allowlisted workstation installation commands | Project decisions, overwrites, or project dependencies |
| `--install-dependencies` | Locked project-local dependency commands after a successful merge | Machine tools, project decisions, or overwrites |

OpenSpec and Spec Kit core/integration output is owned by their official initializers. Liftoff validates the declared version and selected-agent markers but does not place framework-owned or one-time seed files in durable artifact hashes. Schema-v3 manifests record this contract explicitly; schema-v2 projects remain supported as legacy state without inventing framework ownership or agent selections.

## Strict Commands And Safe Recovery

Liftoff validates each command before running it. Unknown flags or subcommands, missing flag values, invalid booleans, incompatible duplicates, and extra positional arguments exit 1 without generating files or printing a fallback helper command. Use command-specific help to see the accepted syntax:

```bash
liftoff init --help
liftoff migrate --help
liftoff update --help
```

The former `liftoff create` command is intentionally rejected with guidance to use `liftoff init`; there is no compatibility alias.

Manifest paths must be portable path-part arrays confined to the project. Traversal, absolute, drive-qualified, UNC, embedded-separator, empty, and symlink-escaping paths are rejected before artifact access. If validation reports an unsafe or malformed manifest, restore `liftoff.manifest.json` from version control or regenerate a fresh project with the matching Liftoff version. Do not repair the issue by weakening path validation or by retaining a hand-edited unsafe path.

## Generated Integration Configuration

GenAI starters contain executable, offline-testable integration boundaries:

- `PYDANTIC_AI_MODEL` selects the production PydanticAI model. Invoking an unconfigured production agent raises a clear configuration error rather than returning a successful placeholder.
- Redis Streams publishing uses `REDIS_URL` and `REDIS_STREAM_NAME`.
- Azure Service Bus publishing uses `SERVICE_BUS_QUEUE_NAME` and either `SERVICE_BUS_CONNECTION_STRING` or `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE`; `AZURE_CLIENT_ID` selects a user-assigned managed identity.
- Langfuse tracing requires both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`, with optional `LANGFUSE_HOST`. Without both keys, tracing is explicitly disabled and reports no remote trace ID.
- Generated frontends read `VITE_API_BASE_URL` from `frontend/.env`, call the route selected by the project pattern or API stack, and expose loading, response, and failure states.
- Generated backends allow the local frontend origin by default. Set the comma-separated `CORS_ALLOWED_ORIGINS` value whenever `VITE_API_BASE_URL` points at a frontend on another origin; generated Azure infrastructure sets it to the deployed frontend URL.

Generated backend, messaging, tracing, and orchestration tests require no external model, Redis, Service Bus, or Langfuse service. Each generated README includes the fresh-project install, build, and test commands for its selected stack.

## Azure Deployment Contracts

Environment tfvars contain a deterministic 12-character lowercase alphanumeric `resource_suffix` for globally scoped Azure names. If Azure reports a collision, replace that environment's suffix with another unique value matching `^[a-z0-9]{12}$`; `tofu validate` rejects invalid overrides.

Worker-enabled projects configure `ServiceBusConnection__fullyQualifiedNamespace` and `ServiceBusConnection__clientId` for the attached user-assigned identity, and grant that identity's principal the Service Bus Data Receiver role. `function_worker_queue_name` drives the provisioned queue, Function setting, and output. Function host storage uses one complete key-backed `AzureWebJobsStorage` configuration rather than mixed partial identity settings.

## Generated Project Structure

Generated paths below are logical project structure examples. The CLI writes them using platform-correct filesystem handling on macOS, Linux, and Windows, and machine-readable manifests store path parts rather than joined path strings.

```text
claims-copilot/
|-- README.md
|-- liftoff.config.json
|-- liftoff.manifest.json
|-- .env.example
|-- Dockerfile
|-- docker-compose.yml
|-- backend/                  # internals depend on the selected API stack
|-- database/
|   |-- alembic.ini
|   |-- migrations/
|   `-- models/
|-- environments/
|   |-- dev/
|   |-- test/
|   `-- prod/
|-- infrastructure/
|   `-- opentofu/
|       `-- azure/
|-- openspec/ or .specify/
|-- frontend/                  # only when frontend generation is selected
|-- functions/<worker-name>/    # only for worker-enabled Azure patterns
`-- migration/legacy/           # only for projects created by liftoff migrate
```

Core generated areas:

- `backend` contains the selected API stack and Scalar/OpenAPI wiring. Python uses `backend/apis`, Node.js uses `backend/src`, and Go uses `backend/cmd/api` plus `backend/internal`.
- `backend/orchestration` appears only in GenAI projects and contains PydanticAI agents, prompts, model configuration, and integration boundaries.
- `database` contains stack-native migrations and SQL schema assets: SQLAlchemy/Alembic for Python, Drizzle for Node.js, or pgx/Goose for Go.
- `environments/<env>` contains environment-specific backend settings, and Functions settings when a worker is generated.
- `docker-compose.yml` starts the selected backend runtime, PostgreSQL, Redis, Azurite, and Mailpit. GenAI projects use pgvector when required and include the optional Langfuse observability profile.
- `infrastructure/opentofu/azure` contains Azure OpenTofu modules, environment tfvars, local state configuration, and a remote state example.
- `openspec` is generated for the OpenSpec workflow; `.specify` and `specs` are generated for the Spec Kit workflow.

Conditional areas:

- `frontend` is generated only when `--frontend` is selected. It uses Vue 3 and Tailwind with a generic API starter for standard projects or an experience matched to the selected GenAI pattern.
- `functions/<worker-name>` is generated only for worker-enabled Azure GenAI patterns such as RAG, agent, multi-agent, and workflow. Azure Functions trigger adapters live there; reusable GenAI orchestration stays under `backend/orchestration`.
- `backend/workers` appears for worker-backed patterns as backend-adjacent or containerized worker code, separate from Azure Functions runtime files.
- `migration/legacy` appears only after `liftoff migrate` and contains a filtered copy of the source project for guided migration work.

## Configuration And Manifest

Generated projects contain two root files with different ownership models:

- `liftoff.config.json` is user-owned desired state after creation. Liftoff writes it once during generation and does not machine-rewrite it afterwards. Supported changes, such as adding an environment or enabling frontend output, are reconciled by `liftoff update`. Project type, API stack, and GenAI pattern changes are migrations and should use `liftoff migrate`.
- `liftoff.manifest.json` is the CLI-owned compatibility record. Manifest schema v3 records the generating `liftoffVersion`, project identity, selected agents, applicable default agent, official framework adapter and tested contract version, and durable generated artifact `logicalName`s with OS-neutral path parts and `sha256:` content hashes. V2 manifests remain readable as explicit legacy framework state.

The manifest lets `liftoff validate`, `liftoff doctor`, and `liftoff update` distinguish clean generated files from local edits. Seed content, such as the initial OpenSpec bootstrap change, is written once and intentionally omitted from the durable manifest so it can follow its own lifecycle. Treat the manifest as CLI-owned: restore or regenerate it when validation fails rather than hand-editing artifact paths or hashes.

## Contract Conventions

Generated projects contain persistent files that outlive any CLI release. The following rules are the compatibility contract, enforced by `tests/contract.test.ts` where possible:

- **Manifest schema**: writers use `artifactVersion` 3; readers support v2 legacy and v3 initialized framework state and reject other versions with a remedy. Durable artifacts retain `sha256:`-prefixed hashes, while framework-owned and seed files are validated separately.
- **Append-only identifiers**: artifact `logicalName`s and catalog ids (project types, API stacks, patterns, providers, environments, spec workflows) are never renamed or removed, only added. The contract test snapshots the logical-name sets.
- **Deterministic rendering**: artifact content depends only on the project plan and the template code, with no timestamps, randomness, or environment leakage. Verified by a double-render byte-equality test.
- **Reserved namespaces**: `.liftoff/` in generated projects is reserved for future CLI-managed state; no new CLI-managed root-level files beyond `liftoff.config.json` and `liftoff.manifest.json`. `liftoff.config.json` is written once at generation and never machine-written afterwards.
- **Portable paths**: machine-readable files store OS-neutral path-part arrays, never joined path strings.
- **Exit codes**: 0 = success or clean check, 1 = failure, 2 = a check mode found drift.
- **Machine output**: every `--json` output carries a top-level numeric `schemaVersion`.

## Development

Clone the public repository and install its development dependencies:

```bash
npm ci
```

Run contributor commands from the repository root:

```bash
npm run check
npm run build
npm test
npm run smoke:package
```

The complete test suite exercises generated Python, Node.js, and Go projects. Install Python 3.12, Go 1.23, and OpenTofu 1.12 when working on generated-stack or infrastructure behavior.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Release

The `Release Liftoff` workflow builds, tests, packs, smoke-installs, and publishes `@msn-control/liftoff` from this repository. Stable versions publish with the `latest` npm dist-tag; prerelease versions publish with `next`. After publication, the workflow waits for canonical npm propagation, clean-installs the selected dist-tag into an isolated prefix, verifies its package version, and executes installed CLI commands. A mismatch fails the workflow even though npm has already accepted immutable package bytes.

Releases use npm trusted publishing with provenance from this public repository. Publishing remains blocked unless npm authorizes `.github/workflows/release.yml` for `voyager163/liftoff`.

Canonical publication does not prove that an external managed mirror has synchronized. Organizations using a mirror should gate their internal release announcement on that mirror exposing the canonical stable version. See [CONTRIBUTING.md](CONTRIBUTING.md) for post-publish recovery and historical-version deprecation procedures.