# Projects

Creating a project and checking it afterwards: `plan`, `init`, `validate` and
`doctor`, the files they read and write, and what a generated project
contains.

## PROJ-001 The project configuration is strict and versioned

`liftoff.yaml` holds the project's desired state with
`schema: liftoff.config/v1`. Unknown keys, invalid names (2 to 50 lowercase
letters, digits and single hyphens) and duplicate agents or owners are
rejected with a message naming the field. The same
configuration always serializes to the same bytes.

Verification: test

## PROJ-002 The manifest inventories every generated file

`.liftoff/manifest.json` lists every file Liftoff generated with its
ownership, sha256 and the plugin that produced it, plus the plugin versions
and the Liftoff version. Ownership is declared, never inferred:

- **managed**: Liftoff keeps it current; a hand edit is reported as drift.
- **seeded**: written once, then owned by the project; Liftoff never
  overwrites it.
- **framework**: written by a specification framework's own initializer,
  such as OpenSpec's, and owned by that framework; Liftoff never changes it
  or reports changes to it.

Paths are repository-relative POSIX paths. No absolute or private paths are
written into a project.

Verification: test

## PROJ-003 Selections are checked before anything is generated

The workload, stack, GenAI pattern, frontend, infrastructure and its
environments, workflow, agents, governance profile and review engine are
checked against the plugins this release ships. An unknown value is a
usage error (exit 2). A value the product supports but this release cannot
generate yet, such as a frontend for a GenAI project, is reported as
unsupported (exit 6), never silently replaced. The review engine must be a
selected agent, verified AI review needs at least one agent, and so does the
Spec Kit workflow.

Verification: test

## PROJ-004 Generation is deterministic and collision-free

The same configuration and release always produce the same files and bytes,
on macOS and Windows. Two plugins writing the same path, or a plugin writing
an unsafe or reserved path, stops generation with an error.

Verification: test

## PROJ-005 The Python API project follows the API contract

A `python-fastapi` project has FastAPI, SQLAlchemy, Alembic and a committed
uv lock; listens on port 8000; separates `/health/live` (no dependencies) from
`/health/ready` (checks PostgreSQL, 503 when unavailable); serves OpenAPI and
Scalar docs; has an initial migration with a working downgrade; reads
configuration from the environment, then an explicitly named TOML file, then
non-secret defaults, failing on a named file that is missing, malformed or has
unknown settings; and ships tests with an 80% coverage gate, a Dockerfile that
runs as an unprivileged user and a Compose file with PostgreSQL. It contains no
GenAI dependencies.

Verification: test

## PROJ-006 A generated project passes its own checks on macOS and Windows

Liftoff's CI generates a project for every API stack, with the Vue frontend,
on macOS arm64 and Windows x64 and runs its locked install, lint, format,
type checks where the stack has them, and tests there, plus the frontend's
production build.

Verification: live

## PROJ-007 Coding-agent files only for the selected hosts

With no agents (Manual) a project gets no agent instructions, skills or
agents. With agents it gets AGENTS.md, CLAUDE.md when Claude Code is
selected, the review and setup skills in each host's native directory and the
read-only verifier agent. The verified AI review runs on one selected host:
the one named with `--review-engine`, otherwise Copilot, then Claude, then
Codex.

Verification: test

## PROJ-008 Governance is a handoff, not enforcement

GitFlow profiles generate GOVERNANCE.md, branch rulesets under
`.github/rulesets/` and a drift workflow, but apply nothing: the rulesets
take effect only when a person applies them after the checks they require
have run. CODEOWNERS is generated only when owners are given. The rulesets
require a code owner's approval only when the profile requires approvals for
every change and there are at least two owners, because nobody can approve
their own pull request. The `none` profile generates no governance files.

Verification: test

## PROJ-009 The Node.js API project follows the API contract

A `node-fastify` project is TypeScript run directly by Node.js 26, with
Fastify, Drizzle ORM and node-postgres and a committed npm lockfile. It
listens on port 8000; separates `/health/live` (no dependencies) from
`/health/ready` (checks PostgreSQL over a new connection with a time limit,
503 when it is unavailable or stops answering); serves OpenAPI and Scalar
docs; has an initial Drizzle migration; reads configuration from the
environment, then an explicitly named JSON file, then non-secret defaults,
failing on a named file that is missing, malformed or has unknown settings;
and ships Biome, strict type checks, tests against an in-process PostgreSQL
with an 80% gate on every coverage metric, integration tests in a throwaway
schema, a Dockerfile that runs as an unprivileged user and a Compose file
with PostgreSQL. It contains no GenAI dependencies.

Verification: test

## PROJ-010 The Go API project follows the API contract

A `go-huma` project is Go with Huma v2 on Chi, pgx and Goose, with a
committed `go.mod` and `go.sum`. It listens on port 8000; separates
`/health/live` (no dependencies) from `/health/ready` (checks PostgreSQL over
a new connection with a time limit, 503 when it is unavailable or stops
answering); serves OpenAPI and Scalar docs; has an initial Goose migration
with a working down migration; reads configuration from the environment,
then an explicitly named JSON file, then non-secret defaults, failing on a
named file that is missing, malformed or has unknown settings; and ships
`gofmt` and `go vet` checks, tests with an 80% statement coverage gate,
integration tests in a throwaway schema, a Dockerfile that builds a static
binary and runs it as an unprivileged user, and a Compose file with
PostgreSQL. It contains no GenAI dependencies.

Verification: test

## PROJ-011 Generated projects work against PostgreSQL and in containers

Liftoff's CI generates a project for every API stack, with the Vue frontend,
on Linux, where service containers and Docker exist, and checks:

- its integration tests pass against a real PostgreSQL and leave the data
  and tables already in that database untouched;
- `docker compose up` brings up PostgreSQL, the migrations, the API and the
  frontend, which run as unprivileged users and pass their container health
  checks;
- the API's live, ready, items, docs and OpenAPI endpoints answer;
- with the database paused, readiness answers 503 within 10 seconds while
  liveness stays up, and readiness recovers once the database is back;
- the frontend serves the application and forwards `/api/` to the API, and
  its Playwright browser test passes against it;
- when the API container is replaced and gets a new address, the frontend
  reaches it again within 30 seconds without being restarted;
- the images it built pass the same Trivy scan, from the same checksum-
  verified release, that the project's own Build workflow runs.

This qualifies the generated containers as a deployment target; Linux is not
a supported platform for the Liftoff CLI.

Verification: live

## PROJ-012 Team and risk-tiered profiles require independent approvals

`team-gitflow` and `risk-tiered-gitflow` generate the same handoff as
`single-maintainer-gitflow`, with their own approval map (REVIEW-005) in
`.github/review-policy.yml`:

- the rulesets require each profile's minimum for every change (team 1,
  risk-tiered 0), dismiss approvals on a new push and, when that minimum is
  above 0, require the approval to come after the last push;
- the `review-policy` check requires the rest by tier, and the always-human
  minimum for paths that always need a person;
- GOVERNANCE.md explains which approvals count, who can give them, and
  which counts the branch rules enforce natively, since a writer could forge
  the `review-policy` status (REVIEW-010).

Verification: test

## PROJ-013 The Vue frontend is optional and reaches the API through one origin

`--frontend vue` adds a `frontend/` directory: a Vue application built with
Vite, styled with Tailwind CSS and written in TypeScript, with a committed
npm lockfile. The default, `--frontend none`, adds no frontend files, jobs or
services.

- The browser calls the API at `/api` on the page's own origin. The Vite dev
  server and preview, and nginx in the frontend's container, forward it to
  the API, so the API needs no CORS settings.
- Its checks are ESLint and Prettier, a strict TypeScript and Vue template
  check, Vitest unit tests with at least 80% on every coverage metric, the
  production build and a Playwright browser test against the application
  running in Docker Compose.
- Its container builds the static files with Node.js and serves them with
  nginx as an unprivileged user, with a health check and a
  Content-Security-Policy that only allows the page's own origin. Base images
  are pinned by digest.
- `docker compose up` starts it on port 8080 once the API is healthy, and
  CI, CodeQL, Dependabot, the README, AGENTS.md, the review policy and
  `liftoff doctor` include it.

Verification: test

## PROJ-014 Shared files are assembled from each component's parts

`compose.yaml`, the CI and CodeQL workflows, Dependabot and the README are
assembled from the parts of the API stack and the frontend:

- each component adds its Compose services, CI jobs, Dependabot entries,
  README sections and the language CodeQL analyzes, each language once;
- `ci-gate` needs every job, dependency review included;
- every relative link in the README points at a file or directory the
  project has;
- generation stops with an error when two components define the same
  service, job or Dependabot entry (ecosystem and directory), when a
  component defines one Liftoff adds itself (the `database` service, the
  `dependencies` and `ci-gate` jobs, the GitHub Actions updates), when a
  service depends on one that does not exist, or when a part is not the
  expected YAML shape.

Verification: test

## PROJ-015 Azure infrastructure is generated as OpenTofu code

`--infrastructure azure` adds `infrastructure/opentofu/azure/`, for the
environments named with `--environments` (dev, staging and prod by
default), always in that order. The default, `--infrastructure none`, adds
none of it.

- `bootstrap/` creates what the environments share: zone-redundant,
  versioned state storage reachable only with Microsoft Entra ID, the
  container registry, and each environment's resource group and the
  identity its containers pull images with.
- Each environment has its own root and state key over one shared module: a
  private network, PostgreSQL reachable only from it, and Container Apps for
  the API, a migrations job running the stack's migrate command and, with a
  frontend, the frontend as the only public entry point.
- Environments differ only in their settings: PostgreSQL is Burstable with
  no standby in dev and staging, and General Purpose with a zone-redundant
  standby in prod.
- Resource names come from the project, the environment and a hash of the
  subscription. They follow Azure's naming rules for every project name
  Liftoff accepts, the longest and most hyphenated included, and
  globally unique names differ between environments.
- Whoever applies bootstrap gets blob access to the state, which accepts
  only Microsoft Entra ID. A PostgreSQL failover is not undone by the next
  apply. With a frontend, nginx reaches the API over its internal HTTPS
  address with the API's own host name.
- Each root commits a provider lock pinning exactly its providers, with
  hashes for macOS arm64, Windows x64 and Linux x64.
- CI checks formatting, validates every root against its lock and runs
  Checkov; Dependabot updates the providers; infrastructure changes are high
  tier and always need a person. Liftoff generates and checks the code but
  never applies it.

Verification: test

## PROJ-016 Generated infrastructure passes OpenTofu and Checkov

Liftoff's CI generates projects with Azure infrastructure, for every
environment with a frontend and for production alone without one, and checks
that `tofu fmt` finds nothing to change, that every root initializes from
its committed lock and validates, and that Checkov reports no findings
except those skipped next to the resource with a reason. It also evaluates
the naming module for the shortest, longest and most hyphenated project
names and checks every name against Azure's rules.

Verification: live

## PROJ-017 The GenAI project is a FastAPI and PydanticAI API

`--workload genai` uses the `python-pydanticai` stack: a FastAPI API on port
8000 with the same health, OpenAPI and Scalar docs, configuration precedence
and container contract as the Python API stack, built around one GenAI
pattern.

- The model is a boundary: `APP_MODEL=test`, the default, is PydanticAI's
  offline test model, so the API runs and its tests pass with no key; any
  other value is a PydanticAI model name whose provider reads its own key
  from the environment. A model that cannot be used stops the API at startup;
  a slow model is a 504 and a failing one a 502, with details only in the
  logs.
- Tracing is off by default. Langfuse is an optional dependency, turned on
  with `APP_TRACING=langfuse`; nothing else depends on it.
- Readiness checks what the pattern needs and never calls the model.
- The project has no PostgreSQL, Compose service or setting it does not use,
  and API projects get no GenAI dependency. The Vue frontend and Azure
  infrastructure are reported as not available for GenAI projects yet
  (exit 6).

Verification: test

## PROJ-018 Nine GenAI patterns with an honest maturity matrix

`--pattern` selects one of `generic` (the default), `prompt`, `chatbot`,
`rag`, `agent`, `multi-agent`, `fine-tuned`, `streaming` and `workflow`.
It applies only to GenAI projects.

- Each pattern adds its endpoints and offline tests. Messaging and worker
  boundaries, with in-process adapters, come only with the pattern that uses
  them (`workflow`); retrieval only with `rag`, and it needs no vector
  store.
- Each pattern plugin declares whether it is complete or a foundation, what
  it implements and what it does not. The project's README and
  `docs/projects/genai-patterns.md` are generated from that metadata, so they
  cannot drift; a check fails when the committed matrix is out of date.

Verification: test

## PROJ-019 Every GenAI pattern passes its own checks

Liftoff's CI generates a GenAI project for every pattern on Linux and runs
its locked install, lint, format and offline tests with coverage, then starts
it with Docker Compose and checks its health, readiness and docs. It also runs
the `generic` project's checks on macOS arm64 and Windows x64.

Verification: live

## PROJ-020 OpenSpec and Spec Kit come from their own pinned initializers

`--workflow openspec` (the default) and `--workflow spec-kit` set the
framework up with its own official initializer, never with copies kept by
Liftoff: OpenSpec 1.14.3 through `npx`, and Spec Kit 1.2.1 through `uvx` at
the commit its tag points to, with Python scripts so they run on macOS and
Windows alike. `--workflow manual` runs nothing.

- The plan lists the `run-initializer` effect and the exact commands, with
  each selected coding agent passed to the framework.
- Init runs them first, alone in the empty staging directory, with telemetry
  off and a temporary home, configuration, data and Codex directory, so
  nothing on the user's machine outside the project changes. They still read
  the user's npm and Git settings and use their package caches.
- Every file they write is recorded in the manifest as framework-owned, and
  `liftoff validate` never reports changes to those files.
- README and AGENTS.md say how to work with the framework, and
  `liftoff doctor` checks the tools its files need: the OpenSpec CLI, or
  Python 3.11 or later for Spec Kit.
- Spec Kit needs at least one coding agent (exit 2).

Verification: test

## PROJ-021 The real initializers run on every platform

Liftoff's CI creates a project with each framework's real initializer, with
every coding agent, on macOS arm64, Windows x64 and Linux. It checks that the
framework's files are there and recorded as its own, and that
`liftoff validate` passes.

Verification: live

## PROJ-022 Every supported combination generates a valid project

The combination matrix is built from the plugin registry: each stack (and
each GenAI pattern), with and without each frontend and infrastructure, each
workflow, every subset of coding agents and every governance profile. Every
combination the registry supports generates without collisions, with
relative paths, no unrendered placeholders or local paths, YAML and JSON that
parse, and a manifest that lists exactly the generated files. The matrix is
snapshotted in `tests/fixtures/golden/matrix.txt`, one line per supported
combination with its file count and inventory hash, plus how many
combinations each reason makes unsupported. Each stack, workflow and profile
is supported in at least one combination.

Verification: test

## PROJ-023 The full matrix runs nightly

Each night Liftoff's CI lints every distinct GitHub Actions workflow and
shell script that any supported combination generates, with actionlint and
shellcheck. It also creates the widest project of each stack, with every
coding agent and a framework's real initializer, and runs its checks on
macOS arm64, Windows x64 and Linux. The check fails, rather than passing
with nothing checked, for a missing project or one without a backend it
knows, and on Linux for infrastructure without OpenTofu.

Verification: live

## PROJ-024 Layout bindings say where each part of a project lives

`liftoff.yaml` may bind each part of the project (`backend`, `frontend`,
`infrastructure`) to the directory it lives in, for a project laid out
differently from Liftoff's standard (`backend/`, `frontend/`,
`infrastructure/opentofu/azure/`). The repository root, `.`, may hold one
part. A binding must:

- be for a part the project has;
- be a repository-relative path every system and Git can hold (no control
  character, no character Windows forbids, no invisible character macOS
  leaves out of a name, no name Windows reads as another file, no name over
  255 bytes), outside `.github` and `.liftoff` and outside `.git` at any
  depth;
- not put one part's directory inside another's, except inside the root,
  comparing names as macOS and Windows do: ignoring letter case and how an
  accented letter is encoded.

A binding to the standard directory is the same as none and is not written,
so a project in the standard layout has no `layout`. `liftoff validate`
warns about a part bound to a directory that is not there, or that is
reached through a link. Until adopting a
project, which honors bindings, is available, Liftoff refuses to generate
files for a project in another layout rather than use the standard
directories.

Verification: test

## PROJ-025 The manifest records its history and anything from before the rebuild

`.liftoff/manifest.json` records:

- each Liftoff operation that wrote the project (`init`, `update`, `adopt`
  and the others), with the release, oldest first;
- for a project adopted from a Liftoff release before the rebuild, a legacy
  record: the old release, and each old record's path, kind and state, with
  the sha256 of a file as it was kept.

Old records stay the project's own, kept byte for byte, and are never
counted as current configuration or proof. A manifest from before these
were recorded is read as having no history and no legacy record.

Verification: test

## INIT-001 Plans are read-only and tamper-evident

`liftoff plan` changes nothing except the plan file named with `--out`. A
plan lists the target, configuration, every file with its ownership, hash and
size, and the permitted effects: writing files and, for a workflow with its
own initializer, running exactly the commands it lists. Because the manifest
then also records the files the initializer writes, its final hash differs
from the planned one. The plan's hash covers every field, so an edited plan
is refused.

Verification: test

## INIT-002 Projects are created in one step or not at all

`liftoff init` creates projects only in a new or empty directory. All files
are written into a staging directory beside the target and published with one
rename; if anything fails or the command is cancelled, the staging directory
is removed and nothing is created. The new directory gets normal permissions.
The target is never the current directory or one that contains it, because
publishing replaces the target directory.

Verification: test

## INIT-003 Init asks before writing

`liftoff init` shows what it will create and asks for confirmation, with no as
the default. Declining exits 4 (cancelled) and writes nothing. Without a
terminal it refuses to write unless `--yes` is given (exit 2).

Verification: test

## INIT-004 Stale plans are refused

A plan made by a different Liftoff version, or one this release would now
generate differently or run a different initializer for, is refused with a
request to make a new plan.

Verification: test

## INIT-005 What an initializer writes is checked before anything is published

If a framework's initializer cannot start, fails, takes more than ten
minutes for all its steps together or is cancelled, nothing is created, and the error says why and what
it needs. The same happens if it creates a Git repository (a `.git` at any
depth, in any case) or anything other than regular files, writes a path
not every system and Git can hold (by the rules for layout bindings in
PROJ-024), writes a file where Liftoff writes one of its own (ignoring
case), or writes a path from
this machine, such as the home or staging directory, into a file, whether
as written, with forward slashes or escaped as in JSON. A failure's message
keeps the end of the initializer's output, where the cause is.

Verification: test

## INIT-006 Init asks for each option in a terminal

Run in a terminal with no project options and no plan, `liftoff init` asks
one question for each option, named after it, and offers only what this
release can generate with the earlier answers: a frontend and infrastructure
only for stacks with a database, environments only with infrastructure,
Spec Kit and AI review only with a coding agent, and a review engine only
with several. It checks names and GitHub logins as the options do, then
prints the command that gives the same answers, quoted for the shell (POSIX
on macOS, PowerShell on Windows), which plans the same project. Questions go
to stderr, so stdout holds only the result, such as the `--json` report.
It then shows the plan and asks before writing, as with options. It never
asks without a terminal or when any project option is given, and Ctrl+C at
a question exits 4 (cancelled).

Verification: test

## VALID-001 Validate reports what changed without repairing it

`liftoff validate` checks the configuration, the plugins it names and every
file in the manifest. Missing or hand-edited managed files and missing seeded
files are reported, as is a directory where a generated file should be;
unknown plugins and invalid files are errors; newer plugin versions are
information. It exits 3 when there is anything to act on and
changes nothing.

Verification: test

## VALID-002 Projects from before the rebuild are recognized

A directory without `liftoff.yaml` that holds a record only the Liftoff
releases before the rebuild wrote ([LEGACY-001](lifecycle.md)) is reported as
a project from before the rebuild, with each record found, its state and
why. An old change that did not finish is an error, and an unsupported
record is a warning. Nothing from the old format is executed or migrated.

Verification: test

## DOCTOR-001 Doctor checks only the tools the project needs

`liftoff doctor` runs the version command of each tool the project's
components and workflow need (or, outside a project, the tools every project
needs), trying a tool's other commands, such as `python` for `python3`, when
the first cannot run. It reports each tool as ok, missing, too old or of
unknown version, with how to install it. It installs nothing and exits 3
when a required tool is not ready.

Verification: test
