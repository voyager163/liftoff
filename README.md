# Liftoff CLI

Status: implemented.

Liftoff is the open-source Mission Control Launchpad Engine. It exposes the `liftoff` command and scaffolds governed GenAI applications or standard APIs with Docker Compose, OpenTofu, and spec-driven governance assets.

Source, issues, and contribution guidance live at [github.com/voyager163/liftoff](https://github.com/voyager163/liftoff).

## Installation

Install the latest stable CLI globally:

```bash
npm install -g @msn-control/liftoff@latest
```

After installation, confirm the command is available:

```bash
liftoff help
```

## Quick Start

Preview a generated project before writing files:

```bash
liftoff plan --pattern rag --cloud azure --region eastus --frontend
```

Create a project non-interactively:

```bash
liftoff create claims-copilot --pattern rag --cloud azure --region eastus --spec openspec --frontend --yes
cd claims-copilot
cp .env.example .env
liftoff validate
liftoff doctor
```

Create a standard Node.js API without GenAI components:

```bash
liftoff plan --no-genai --api node --cloud azure --region eastus
liftoff create claims-api --no-genai --api node --cloud azure --region eastus --spec openspec --no-frontend --yes
```

Standard API choices are `python` (FastAPI), `node` (Fastify with TypeScript), and `go` (Huma v2 with Chi). Existing GenAI commands that provide `--pattern` continue to infer the GenAI project type and Python/FastAPI stack.

Use the local development helper to print the Docker Compose command, then run the printed command:

```bash
liftoff dev up
docker compose up --build
```

For an existing project, create a Liftoff-shaped sibling scaffold and staged migration plan without modifying the source project:

```bash
liftoff migrate ../legacy-app --region eastus --yes
```

## How Liftoff Works

Liftoff turns a small set of project decisions into a deterministic scaffold and records what it wrote so future CLI versions can reconcile safely.

```text
plan -> create or migrate -> validate and doctor -> update -> dev and infra helpers
```

- `liftoff plan` resolves flags or config into a project plan, renders the artifact list, and writes nothing.
- `liftoff create` first determines whether the project is GenAI or standard. GenAI projects select a pattern and use Python/FastAPI/PydanticAI; standard projects select an approved Python, Node.js, or Go API stack. Both flows collect cloud, region, frontend, environments, and spec workflow.
- `liftoff migrate <path>` scans a legacy project, generates a fresh sibling Liftoff scaffold, stages a filtered legacy copy under `migration/legacy`, and emits an OpenSpec migration change or `MIGRATION.md`.
- `liftoff validate` checks that `liftoff.manifest.json` can be loaded and every durable manifest artifact exists on disk.
- `liftoff doctor` runs read-only readiness checks. Outside a generated project it checks the local environment; inside a generated project it also checks manifest health, scaffold drift, runtime configuration, cloud auth, and Azure Functions tooling for worker-enabled Azure projects.
- `liftoff update` checks scaffold drift by default and writes nothing. It exits 0 when clean and 2 when drift exists, which makes it usable as a CI drift gate.
- `liftoff update --apply` writes safe changes such as new, missing, moved, or untouched upgraded artifacts. It skips conflicts unless `--force` is also provided, and it reports orphaned files without deleting them automatically.
- `liftoff dev` prints Docker Compose helper commands such as `docker compose up --build`, `docker compose logs -f`, and `docker compose down --volumes`.
- `liftoff infra` prints OpenTofu helper commands such as `tofu init`, `tofu plan -var-file=environments/dev.tfvars`, and `tofu apply -var-file=environments/dev.tfvars`.

Discovery commands are available for the catalogs that drive generation:

```bash
liftoff patterns
liftoff providers
liftoff regions
liftoff regions search korea --cloud azure
```

Azure is the available V1 provider. AWS and GCP are listed as planned provider adapters and are rejected before generation.

## Strict Commands And Safe Recovery

Liftoff validates each command before running it. Unknown flags or subcommands, missing flag values, invalid booleans, incompatible duplicates, and extra positional arguments exit 1 without generating files or printing a fallback helper command. Use command-specific help to see the accepted syntax:

```bash
liftoff create --help
liftoff update --help
liftoff regions --help
```

`liftoff update --apply` preflights every path and destination before its first mutation. A new or moved artifact is adopted when the destination already contains the rendered bytes; different pre-existing bytes are reported as a conflict and skipped. `--force` overwrites reviewed conflicts. Orphans are reported but never deleted automatically. Any write, replacement, cleanup, or manifest failure exits 1 without a success summary or false manifest state, so fixing the filesystem issue and retrying is safe.

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
- `liftoff.manifest.json` is the CLI-owned compatibility record. Manifest schema v2 records `artifactVersion`, the generating `liftoffVersion`, project type, API stack, applicable GenAI pattern, durable generated artifact `logicalName`s, categories, OS-neutral path parts, and `sha256:` content hashes.

The manifest lets `liftoff validate`, `liftoff doctor`, and `liftoff update` distinguish clean generated files from local edits. Seed content, such as the initial OpenSpec bootstrap change, is written once and intentionally omitted from the durable manifest so it can follow its own lifecycle. Treat the manifest as CLI-owned: restore or regenerate it when validation fails rather than hand-editing artifact paths or hashes.

## Contract Conventions

Generated projects contain persistent files that outlive any CLI release. The following rules are the compatibility contract, enforced by `tests/contract.test.ts` where possible:

- **Manifest schema**: `liftoff.manifest.json` uses `artifactVersion` 2, the first supported schema version, recording the generating CLI version (`liftoffVersion`) and a `sha256:`-prefixed `contentHash` per artifact. Readers accept every supported version and reject others with a remedy; writers always write the latest version.
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

The `Release Liftoff` workflow builds, tests, packs, smoke-installs, and publishes `@msn-control/liftoff` from this repository. Stable versions publish with the `latest` npm dist-tag; prerelease versions publish with `next`.

Releases use npm trusted publishing with provenance from this public repository. Publishing remains blocked unless npm authorizes `.github/workflows/release.yml` for `voyager163/liftoff`.