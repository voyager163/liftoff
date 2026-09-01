# Supported stack baseline

Each Liftoff release packages one tested dependency baseline in
`assets/supported-stack.json`. Project generation and update use that committed
file; they never resolve mutable `latest` versions.

## Runtime and framework baseline

| Surface | Tested release |
| --- | --- |
| Node.js | 24.20.0 LTS |
| npm | 12.0.2 |
| Python | 3.14.7 |
| `uv` | 0.12.7 |
| Go | 1.27.0 |
| OpenTofu | 1.12.6 |
| OpenSpec | 1.11.0 |
| Spec Kit | 1.0.1 |
| AzureRM provider | 5.3.0 |
| Power Apps SDK | 1.2.7 |

Power Apps SDK 1.2.7 is an explicit compatibility selection. Versions 1.2.12
and newer remove the project-local `power-apps` CLI required by Liftoff's
current workload contract. Moving to Microsoft's global `pa` CLI is a separate
reviewed workload migration; the freshness check recognizes only the recorded
1.3.0 exclusion and will reopen the decision when a newer candidate appears.

Generated npm projects include `package-lock.json`. Python projects include
`uv.lock` and use `uv sync --frozen`. Go projects include `go.mod` and
`go.sum`. Generated OpenTofu includes a multi-platform `.terraform.lock.hcl`.

Container references include a readable stable tag and an immutable
multi-architecture digest. The optional Langfuse profile uses the v4 web and
worker services with pinned ClickHouse, Redis, and MinIO dependencies.

## Refresh policy

Maintainers compare the committed baseline with canonical ecosystem sources:

```bash
npm run check:supported-stack
npm run check:supported-stack-freshness
```

The first command verifies that package manifests and lockfiles match the
committed baseline. The second is a networked, fail-closed freshness check.
A newer release is not promoted automatically: update manifests and source for
compatibility, regenerate ecosystem-native locks, review immutable image
digests and upstream provenance, then run:

```bash
npm run refresh:supported-stack
npm run check
npm run verify:standard-node-templates
npm run verify:power-apps-starter
```

Power Apps source is refreshed only through its reviewed immutable upstream
commit workflow. Do not edit Microsoft-owned starter files independently.

## Existing generated projects

Upgrade the globally installed Liftoff CLI, then inspect Liftoff core
maintenance as a separate operation:

```bash
liftoff upgrade --check
liftoff upgrade
liftoff update --check
liftoff update
liftoff validate
liftoff doctor
```

Only explicit Liftoff core files are updated automatically. Package manifests,
locks, runtime files, containers, and providers are project-owned after
generation; ordinary update and force do not replace them. Liftoff also never
installs project dependencies during update. CLI upgrade does not discover or
modify the project.

This baseline is a breaking generation boundary: it raises the Node.js, Python,
Go, and OpenTofu floors and includes major framework, provider, frontend,
container, and dependency migrations for new scaffolds. Existing production
projects adopt those changes through separately reviewed project work, not
`liftoff update` or `--force`. Do not use an older Liftoff release as an
automatic downgrade tool.
