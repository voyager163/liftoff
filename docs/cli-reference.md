# CLI reference

Run `liftoff help` or command-specific help for the authoritative syntax:

```bash
liftoff init --help
liftoff migrate --help
liftoff update --help
```

Unknown flags or commands, missing values, invalid booleans, incompatible
duplicates, and extra positional arguments fail before generation.

## Lifecycle

```text
plan -> init or migrate -> validate and doctor -> update -> dev and infra helpers
```

| Command | Behavior |
| --- | --- |
| `liftoff plan` | Resolves decisions and previews artifacts and requirements without side effects |
| `liftoff init [project-name]` | Initializes a named child or the exact current Git root through staged readiness and framework setup |
| `liftoff migrate <source>` | Creates a new sibling scaffold and filtered source copy without changing the source |
| `liftoff validate [project]` | Validates manifest identity, durable files, workload metadata, and framework markers |
| `liftoff doctor [project]` | Runs read-only workload-derived project and workstation diagnostics |
| `liftoff update [project]` | Reports template and configuration drift without writing |
| `liftoff update --apply` | Applies safe changes, preserves unforced conflicts, and records the resulting manifest |
| `liftoff dev` | Prints workload-appropriate local development commands; it does not execute them |
| `liftoff infra` | Prints OpenTofu guidance for API workloads and reports infrastructure as not applicable for Power Apps |
| `liftoff patterns` | Lists GenAI patterns |
| `liftoff providers` | Lists provider availability |
| `liftoff regions` | Lists available regions |
| `liftoff regions search <query>` | Searches region names and slugs |
| `liftoff --version` | Prints exactly one version line |

The former `liftoff create` command is intentionally rejected with guidance to
use `liftoff init`; there is no compatibility alias.

## Planning and initialization options

Common noninteractive inputs include:

```text
--type genai|standard|power-apps-code-app
--pattern <genai-pattern>
--api python|node|go
--cloud azure
--region <slug>
--frontend | --no-frontend
--environments dev,test,prod
--spec openspec|spec-kit
--agents copilot,claude
--default-agent copilot|claude
--code-apps-plugin | --no-code-apps-plugin
```

Power Apps rejects API, pattern, cloud, region, frontend, and API environment
options rather than ignoring them.

Consent options are documented in [safety and consent](safety-and-consent.md).

## Update modes

```bash
liftoff update
liftoff update --json
liftoff update --apply
liftoff update --apply --force
```

`--force` is valid only with `--apply`. It overwrites reported file conflicts;
it does not permit workload, API stack, GenAI pattern, framework, selected
agent, or user-supplied Power Apps starter identity changes.

## JSON and exit codes

Machine-readable maintenance contracts bypass decorative presentation:

```bash
liftoff validate --json
liftoff doctor --json
liftoff update --json
```

Each JSON object has a top-level numeric `schemaVersion`.

Exit codes:

- `0`: success or a clean check.
- `1`: invalid input, unsafe state, or command failure.
- `2`: a read-only check found drift.

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
