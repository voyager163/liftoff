# Whole-Project Standards Assessment

`liftoff assess` provides evidence-backed, whole-project standards assessment before or after Liftoff initialization. It evaluates an existing repository, project directory, or component against release-owned standards profiles without mutating the project or executing project code.

## Guarantees

Assessment is strictly **local** and **read-only**:

1. **No Initialization**: Assessment does not create `liftoff.manifest.json`, initialize configuration, or run `git init`. Missing VCS or Liftoff metadata is recorded as an observation, not an error or a prompt to initialize.
2. **No Provider or Network Calls**: Assessment does not contact GitHub, Azure, or package registries.
3. **No Script Execution**: Assessment never executes project scripts, compilers, test runners, package managers (`npm`, `uv`, `go`), or background processes.
4. **No Dependency Preparation**: Assessment does not install, restore, or sync dependencies.
5. **No State Mutation or Receipts**: Assessment does not write preview receipts, verification receipts, or telemetry notice state. The filesystem remains bit-for-bit identical before and after assessment.

## CLI Usage

```bash
# Assess the nearest project or repository boundary from the working directory
liftoff assess

# Assess an explicit project path
liftoff assess path/to/project

# Assess with explicit standards profile
liftoff assess --profile python-fastapi path/to/project

# Assess a specific component in a multi-component project
liftoff assess --component backend path/to/project

# Emit machine-readable schema-1 JSON result
liftoff assess --json
```

### Options

| Flag | Description |
|------|-------------|
| `[path]` | Explicit target directory. Without a target, resolve and disclose the nearest project or repository boundary; an ordinary directory without either remains its own target. |
| `--project <path>` | Explicit project root directory. |
| `--component <path>` | Specific component subpath within the project (confines inventory strictly to component). |
| `--profile <id>` | Exact installed standards profile ID, such as `python-fastapi`, `node-fastify`, `go-huma`, `vue-component`, or `genai-rag`. |
| `--inputs <file>` | Explicit public inputs file; resolve it against the invocation cwd and bind its reference and digest. Never provide credentials or sensitive payloads. |
| `--json` | Output deterministic schema-1 JSON on stdout. |
| `--help` | Show command-specific help. |

## Exit Codes

`liftoff assess` uses deterministic, standards-aligned exit codes:

- **0**: Full assessed coverage for the selected scope is achieved with complete matching evidence and **zero** differences, missing rules, or unknown observations.
- **2**: Valid assessment report completed, but contains differences, missing rules, unsupported stacks, or unknown/incomplete observations.
- **1**: Fatal boundary error, path safety violation (escaping symlink, junction, case collision), malformed inner manifest, or invalid catalog profile selection.

The envelope records `cliVersion` and `capabilityProtocolSchemaVersion`
independently from the observed manifest version and selected profile revision.
A selected component retains its containing project's validated manifest
reference and digest as boundary context, without inventorying sibling source.

## Supported Standards Profiles

Assessment binds its evaluation to release-owned, schema-1 standards profiles:

| Profile ID | Target Stack | Declared Evidence Requirements |
|------------|--------------|--------------------------------|
| `python-fastapi` | Python / FastAPI | `pyproject.toml` or `requirements.txt` declaring `fastapi`, source importing and using FastAPI, health check, OpenAPI route, test suite, Dockerfile/compose, OpenTofu layout. |
| `node-fastify` | Node.js / Fastify / TypeScript | `package.json` declaring `fastify`, TypeScript source importing and using Fastify, health check, OpenAPI/Scalar docs, Vitest suite, Dockerfile/compose, OpenTofu layout. |
| `go-huma` | Go / Huma v2 / Chi | `go.mod` declaring `github.com/danielgtaylor/huma/v2`, Go source using Huma/Chi, health check, OpenAPI route, test files, Dockerfile/compose, OpenTofu layout. |
| `vue-component` | Vue 3 / Vite / TypeScript | Vue dependency and source declarations, component-local locks, build and test declarations; no invented backend, cloud, or generation history. |
| GenAI profiles listed below | Python / FastAPI / GenAI | Supported FastAPI/PydanticAI source and dependency declarations with pattern-specific observations; worker applicability is not inferred for every pattern. |

The nine GenAI profile IDs are `genai-generic`, `genai-rag`, `genai-chatbot`,
`genai-agent`, `genai-prompt`, `genai-multi-agent`, `genai-fine-tuned`,
`genai-streaming`, and `genai-workflow`. Profile selection states the intended
evaluation target; it is not evidence that the source already implements it.
The installed catalog defines each profile's actual rule coverage.

### Evidence vs. Resemblance

- **Comments and Resemblance**: A comment mentioning a framework (e.g. `// Migrating to Fastify later`) or a filename resemblance (e.g. `fastify.ts` without fastify imports) does **not** establish framework support.
- **Unsupported Stacks**: When assessment observes Express, Flask, Django, or an unregistered stack, it reports the observed facts and marks the profile as `unsupported`. It does **not** propose automatic conversion to a supported stack.

## Bounded Inventory & Exclusions

Assessment inventories files across 13 bounded categories:
`source`, `declarations`, `locks`, `tests`, `build`, `config`, `docs`, `containers`, `infrastructure`, `workflows`, `framework`, `agent`, and `provenance`.

### Protected Payload Exclusions

Assessment **never** reads or includes sensitive state or credential payloads:
- `.env`, `.env.local`, `.env.*.local` (only `.env.example` is inventoried)
- Private keys: `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `*.pfx`, `*.p12`
- State files: `*.tfstate`, `*.tfstate.backup`
- Named credential payloads, including `.credentials`, `credentials.json`,
  `secrets.json`, and `*.pat`. Do not place secrets in public source or inputs;
  filename exclusions are not a general secret detector.

Source inspection distinguishes empty credential defaults and variable references
from credential literals. Recognized tokens, private-key payloads, and nonempty
credential literals are withheld; a declaration such as `api_key: str = ""`
does not by itself make ordinary generated source unreadable.

### Bounded Limits & Unknown Observations

When size limits (2 MiB per file and 50 MiB across the scan), count limits
(5,000 files), depth limits (15), the 15-second collection budget, or filesystem
permissions prevent complete observation, affected paths are reported as
unobserved with explicit reasons such as `size_limit_exceeded`,
`time_limit_exceeded`, `permission_denied`, and `unstable_during_collection`.
Unobserved items are **never** treated as absent or aligned.

## Evidence-Backed Findings

Each finding records:
- `ruleId`: Stable standard rule ID (e.g. `RULE-DEP-LOCK`, `RULE-API-HEALTH`, `RULE-TEST-SUITE`).
- `classification`: `aligned`, `difference`, `missing`, `conflicting`, `unsupported`, `unknown`, or evidence-backed `inapplicable`.
- `observed`: Exact references (file paths and SHA-256 digests), observed facts, and limitations.
- `remedy`: Advisory next action without automatic authorization.

### Custom Code Conformance
Custom source can satisfy a statically evaluated rule without byte equality to a
Liftoff starter. A source declaration alone does not prove a running health
endpoint, prefix-safe schema retrieval, passing tests, or deployed compliance.
Rules requiring execution remain limited or unknown until separately authorized
verification establishes their operational contract.

### Test Presence vs. Runtime Proof
Assessment verifies the *presence* of declared test suites, not their runtime execution. Findings explicitly record: *"Test suite declared in files; runtime execution and passing status are not verified by read-only assessment."*

## Context-Bound Recommendations

Assessment generates recommendations pointing **only** to real, installed Liftoff capabilities:

- `liftoff adopt --project <path> --check`: In-place adoption preview for uninitialized supported projects.
- `liftoff update --project <path> --check`: Managed core update check for initialized projects.
- `liftoff repair <path> --check`: Separate repair preview when an actual supported recipe applies.
- `liftoff governance assess <path>`: Repository governance assessment.

Recommendations retain the literal executable and argument array, invocation
cwd, selected project/component, compatibility identity, qualification, and
required authority. A captured inputs reference and digest do not authorize
effects. If the destination command cannot consume that binding, the
recommendation must remain blocked guidance rather than silently dropping it or
inventing an unsupported flag. Unsupported stacks do not gain adoption or
conversion authority from an explicitly selected target profile.

Available actions carry the actual installed capability ID, qualification state,
command-result schema, and a digest of their compatibility requirements. Project
targets are absolute even when the invocation started elsewhere. Blocked
recommendations retain the selected context and reasons but have no executable
or continuation; a missing executor is not replaced by a runnable recommendation.
A component-only assessment never silently becomes a
project-wide update or repair request. Generic application gaps can suggest
`repair <path> --inspect-layout --json`; this is inventory, not an eligible
recipe, a verified patch, or file approval. That command retains repair report
schema 2, with a nested application-inventory schema 1; recommendations describe
the outer command result rather than substituting the nested schema.
