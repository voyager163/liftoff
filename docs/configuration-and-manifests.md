# Configuration and manifests

Generated projects have two Liftoff root files with different ownership.

## `liftoff.config.json`: developer-owned desired state

Liftoff writes configuration once during initialization and does not
machine-rewrite it afterward.

Supported edits are reconciled by `liftoff update`:

- API workloads can select a previously absent environment or frontend. Update
  provisions that component once only when its destinations are absent or
  byte-identical; a differing destination blocks the complete component and
  cannot be forced.
- Supported API deployment environments are exactly `dev`, `staging`, and
  `prod`. The retired `test` identifier is rejected in configuration and
  manifests; replace it with `staging` before validation or update.
- Removing or re-enabling a previously provisioned component never deletes,
  restores, or overwrites its project-owned files.

Workload kind, API stack, GenAI pattern, spec workflow, and selected agents are
not ordinary updates.

An undecided GenAI project records an explicit generic identity rather than
omitting the pattern:

```json
{
  "projectName": "general-assistant",
  "projectType": "genai",
  "apiStack": "python-fastapi",
  "pattern": "generic",
  "cloud": "azure",
  "region": "eastus",
  "includeFrontend": false,
  "environments": ["dev"],
  "specWorkflow": "openspec",
  "agents": ["github-copilot"],
  "governanceProfile": "single-maintainer-gitflow"
}
```

Changing `generic` to a specialized pattern later is a reviewed project
migration because application files are project-owned; it is not an update.

The `power-apps-code-app` workload and `codeAppsPlugin` configuration field are
retired. They are rejected rather than ignored or converted to another workload.

## Application runtime configuration

These settings are separate from Liftoff desired state. Each backend resolves
**process environment > selected local configuration file > nonsecret defaults**
once per process. Restart after changing configuration; do not shell-source a
file to make it work.

| Backend | Default native file | Selected-file override |
| --- | --- | --- |
| Python/FastAPI, including GenAI | Project-root `.env`, resolved from `backend/config/settings.py`, not the working directory | `LIFTOFF_ENV_FILE` names a dotenv file |
| Node.js/Fastify | Project-root `.env`, resolved from source or compiled configuration location | `LIFTOFF_ENV_FILE` names a dotenv file |
| Go/Huma | `../runtime.config.json` when launched from `backend/` | `LIFTOFF_ENV_FILE` names a JSON object of string values |

Override paths are relative to the startup working directory unless absolute.
An explicitly selected missing, unreadable, or malformed file fails even when
process values could otherwise satisfy startup. An absent default file is allowed
when process values provide the required settings. All stacks need
`DATABASE_URL` and `REDIS_URL`; model credentials are not required for operational
endpoints.

Python and Node validate dotenv assignments, balanced quotes, UTF-8, and NUL
input before accepting a file. Use `KEY=value`, optional `export`, comments,
and single- or double-quoted values. Node uses the runtime dotenv parser and
rejects escaped quote delimiters that it would otherwise truncate; use the other
quote style, for example `APP_NAME="Bob's API"`. Go uses `encoding/json`, not a
dotenv dependency: numbers such as `PORT` must be quoted strings, and null or
other non-string values are rejected.

### Native development

From the project root in a POSIX shell, prepare the documented local settings:

```bash
cp .env.example .env
docker compose up -d postgres redis azurite mailpit
```

Then run **only the selected backend** after its locked dependency preparation:

| Backend | Native command |
| --- | --- |
| Python | `uv sync --frozen --project backend --extra test`, then `uv run --project backend uvicorn backend.apis.main:app --host 127.0.0.1 --port 8000` |
| Node.js | `(cd backend && npm ci && npm run build && npm start)` |
| Go | Copy `runtime.config.example.json` to `runtime.config.json`, then `(cd backend && go mod download && go run ./cmd/api)` |

Worker-enabled Python projects add `--extra functions` to frozen synchronization.
For a Python launch from `backend/`, use
`uv run uvicorn --app-dir .. backend.apis.main:app --port 8000`; it still reads
root `.env` without exporting the file's values. PowerShell users can use
`Copy-Item` and `Set-Location` rather than the POSIX parenthesized commands.
An explicit selector from `backend/` is `$env:LIFTOFF_ENV_FILE = '..\.env'`
for Python/Node, or `'..\runtime.config.json'` for Go.

Migration tools use the same resolved settings: Python Alembic, Node Drizzle,
and Go's `make migrate` wrapper around the existing pinned Goose tool. Running
migrations is a separate database mutation, not part of the startup probes.

### Compose and integration boundaries

Compose reads root `.env` for interpolation. Select a different dotenv file with
`docker compose --env-file environments/<env>/backend.env up --build`, using an
actually selected environment. Process values take precedence. Compose deliberately
keeps PostgreSQL, Redis, and blob addresses container-reachable while forwarding
the applicable model, messaging, CORS, and tracing settings.

`/health` and `/ready` are local process/configuration endpoints, not dependency
connectivity or production-readiness proofs. They make no model/provider request.
Backend containers listen on 8000; the frontend container serves static files on
80, mapped to 5173 by Compose.

For GenAI:

- `PYDANTIC_AI_MODEL` supports the locked `openai:`, `openai-chat:`, and
  `openai-responses:` providers with `OPENAI_API_KEY` and optional
  `OPENAI_BASE_URL`. Other providers need reviewed dependency/configuration work.
- Redis Streams publishes to `REDIS_STREAM_NAME` using `REDIS_URL`.
- `SERVICE_BUS_AUTH_MODE=managed-identity` requires
  `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE`, `SERVICE_BUS_QUEUE_NAME`, and
  `AZURE_CLIENT_ID`. `connection-string` requires the queue and
  `SERVICE_BUS_CONNECTION_STRING`. Missing sender settings cannot report queued
  ingestion.
- Both Langfuse keys blank means tracing is disabled; configuring exactly one
  of `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` is an error.
  `LANGFUSE_HOST` is optional.

Keep local secrets out of source control and build contexts. Root/frontend
`.dockerignore` files exclude host dependencies, caches, outputs, VCS metadata,
state, and secrets; the Function publish context also has `.funcignore`.
These runtime files remain project-owned, not managed update targets.

## `liftoff.manifest.json`: CLI-owned compatibility record

New projects use manifest artifact version 7. Its common project identity includes the
name, spec workflow, selected agents, and applicable Spec Kit default. A
discriminated `project.workload` object contains only fields valid for one
workload:

- `genai`: API stack, pattern, cloud, region, frontend, and environments.
- `standard`: API stack, cloud, region, frontend, and environments.

The manifest also records:

- Last manifest-writing Liftoff version.
- Official framework adapter, state, and tested contract version when known.
- `managedArtifacts`: exact Liftoff core logical names, paths, and
  reconciliation `contentHash` values.
- `projectArtifacts`: starter provenance with the original path, generating
  Liftoff version, `generationHash`, and provisioning group. These hashes never
  authorize update writes.
- OS-neutral path-part arrays.
- Repository governance profile, policy version 6, activation-contract version
  2, state/evidence-header/approval schema versions 2,
  graph/supersession/credential schema versions 1, the
  exact phase-graph hash, and local `handoff-generated`, `handoff-partial`, or
  disabled state.

An existing Power Apps manifest is rejected at its retired workload boundary
before starter metadata or artifact paths are interpreted. Its original files
remain unchanged.

Treat the manifest as CLI-owned. Restore it from version control or regenerate
with the matching Liftoff version when validation reports malformed identity,
paths, or hashes.

## Compatibility

Readers support artifact versions v2, v3, v4, v5, v6, and v7 for API/GenAI projects:

- V2 normalizes the legacy flat API identity and records framework state as
  uncertain without inventing agents.
- V3 normalizes flat GenAI or API identity plus framework and agent metadata.
- V4 introduces the discriminated workload model. Its formerly supported Power
  Apps variant is now retired.
- V5 adds repository-governance handoff identity without claiming live
  enforcement.
- V6 separates managed-core update authority from project generation
  provenance.
- V7 adds deterministic setup identity. Current output uses
  manifest artifact version 7, policy version 6, activation-contract version 2, and the canonical
  phase-graph hash. Governance-disabled v7 manifests use the
  disabled variant and do not fabricate activation identity.

Enabled governance manifests retain their recorded positive-integer policy
version only when the complete compatibility tuple is supported. Readers accept
historical v2-v6 manifests so `liftoff update --check` can report managed-core
drift and plain update can migrate them to v7. Malformed or future manifest,
policy, contract, schema, or graph identities remain invalid or blocked without
rewrite.

`liftoff update --check`, including `--check --json`, leaves an old manifest
byte-for-byte unchanged while disclosing an external preview receipt. An
explicitly approved update writes v7 only after the
transaction succeeds. V2-v6 backend, frontend, database, dependency, container,
environment, documentation, and infrastructure entries become
project provenance without reading or changing current production bytes.
Intentionally deleted files remain absent. Only exact current core logical names
retain write authority.

The compatibility map is explicit; Liftoff does not use numeric less-than
comparisons to infer execution safety.

| Contract | Current version |
| --- | --- |
| CLI package version | 0.11.3 |
| Activation package identity | 0.11.0 |
| Manifest write / supported reads | 7 / 2-7 for API and GenAI |
| Normative policy | 6 |
| Activation contract, state, evidence header, approval envelope | 2 |
| Compatibility metadata / supported historical input | 3 / 2 |
| Update report | 3 |
| Preview receipt, transaction approval, history index, migration journal | 1 |
| Phase graph, supersession, credential policy | 1 |
| Assessment report and control catalog | 1 |

The 0.11.3 CLI patch retains the 0.11.0 activation identity because its phase
semantics and graph are unchanged. Independent infrastructure provenance
explicitly recognizes generation versions 0.11.0, 0.11.1, 0.11.2, and 0.11.3,
including mixed component histories; unknown releases are not automatically
trusted or treated as compatible. The mandatory preview/approval workflow and
schema-3 update reports remain unchanged by this patch.

Known activation-v1 history remains **diagnostic-only**, not executable proof.
Compatibility metadata v3 separately declares the exact history-preserving
successor lane available through `liftoff update --check` and explicitly
approved update. Schema-2 metadata remains readable input, not authority to
invent a migration. Future/mixed tuples, ad hoc state, and unknown graphs remain
blocked.

Migration preserves the original manifest, historical state and evidence, creates
strict v2 state, and links it through `governance/migration-state.json` to its
immutable `governance/history` snapshot. No required field is added to manifest
v7 or the v2 proof schemas. Original generation provenance remains intact.
A readable historical record never authorizes current provider scope; old
approvals and checked tasks do not become fresh evidence. Revalidation failure
after local commit leaves the linked v2 activation blocked and resumable.

## Artifact ownership

Every generated artifact has an explicit lifecycle independent from its
category or filename:

| Lifecycle | Owner after initialization | Update behavior |
| --- | --- | --- |
| `managed-core` | Liftoff | Safe reconciliation; reviewed core conflicts may use `--force` |
| `project` | Developer/project | Provenance only; never compared, restored, moved, or overwritten |
| `desired-state` | Developer | Read as input and never machine-rewritten |
| `framework` | Official framework | Validated through framework markers and maintained by that framework |
| `seed` | Developer/project | Written once and never reconciled |

New Spec Kit projects explicitly seed
`specs/000-liftoff-bootstrap/{spec.md,plan.md,tasks.md}`. These are not framework
templates or managed-core files. Missing older bundles are an adoption blocker,
not permission for update or force to create them.

The manifest is a CLI-owned transaction record rather than an ordinary
template artifact. Current managed core is limited to the exact repository
governance policy, context, guide, phase graph, compatibility metadata,
credential-policy schema, and selected-agent `/liftoff-setup` integrations.
Enabled projects also own only the exact assessment integrations:
`liftoff-governance-assess-copilot` at
`.github/prompts/liftoff-governance-assess.prompt.md` and
`liftoff-governance-assess-claude` at
`.claude/commands/liftoff-governance-assess.md`, for selected agents only.
Older supported inventories without these entries remain readable and expose
safe managed-core update drift. Unowned collisions stay outside ownership even
with force; assessment never grants write authority for files it reads.
Forced update may remove exact retired generated setup-alias entries from older
manifests after review. A name such as `config.go`, a `configuration` category,
or a path under `.github` does not grant update authority.

User-owned governance artifacts are deliberately excluded from managed-core
hashes: `governance/activation-state.json`, approvals, evidence, credential
policies, supersession records, active OpenSpec changes, and bootstrap
retention/disposal records. Update may report reconciliation-required status for
those files, but it does not advance, reset, or delete a phase.

## Contract conventions

- Writers use `artifactVersion` 7; readers support v2, v3, v4, v5, v6, and v7.
- Artifact logical names and catalog identifiers are append-only except for
  explicitly reviewed retirements. In 0.11.0, the eight
  [flat-root OpenTofu identities](azure-deployment.md#explicit-flat-root-identity-retirement)
  are retired from **new scaffold output only**. Their historical paths,
  identities, and generation hashes remain provenance, not aliases or deletion
  authority. Retained tfvars IDs alone do not establish the independent layout.
- Rendering is deterministic and does not depend on timestamps, host versions,
  or network state.
- `.liftoff/governance/` contains managed setup definitions; `governance/`
  contains user-owned activation state.
- Machine-readable paths are path-part arrays, never platform-joined strings.
- Exit codes are 0 for success or clean, 1 for failure, and 2 for detected
  drift in check mode. Assessment also uses 2 for partial coverage or differences
  including approved exceptions; disabled governance exits 0 as not-applicable,
  never as an alignment claim.
- JSON outputs carry a numeric top-level `schemaVersion`.

See [safety and consent](safety-and-consent.md) for reconciliation and rollback
behavior.
