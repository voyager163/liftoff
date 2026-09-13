## Context

See proposal.md. The existing repair specification describes a wider future contract than the shipped CLI. Existing primitives include explicit infrastructure identities, project boundary checks, an externally sealed recoverable update transaction, user-local record storage, isolated framework staging, and an internal protected state migration service. None is a substitute for a project-bound infrastructure repair coordinator.

## Goals / Non-Goals

**Goals:** Ship a usable, bounded local OpenTofu reorganization lane, and truthful guidance for projects it cannot yet transform. Preserve real project code and provenance. Make check/apply/recovery available through the packaged entrypoint.

**Non-Goals:** Arbitrary business-code rewrites, provider upgrades, adding agents, live deployment, unqualified stateful cutover, or claiming every archived recoverable-setup task was implemented. Existing state services are not implicitly wired to guessed backend or resource mappings.

## Decisions

### Separate repair authority with an update handoff

Register `repair [project-path] --check [--live --subscription <id>]`, `repair [project-path] --approve-plan <fingerprint>`, and `repair [project-path] --recover`. Bare repair previews rather than silently writing. Store exact executable previews outside the repository under a distinct record kind. Application reloads that receipt; it cannot add discovery or widen scope. Bind CLI/recipe, canonical project, source/destination bytes and modes, selected environments, subscription, operations and verification policy. Receipts expire after a bounded interval.

Do not silently add project-file ownership to `update` or `--force`. Update and native setup present the repair handoff, then resume ordinary update/local verification. This preserves the existing core/project boundary.

### Semantic, conservative transformation

Use a packaged semantic HCL parser, with preservation of original supported bodies rather than rendering new resource templates. Explicit retired/current artifact identities determine files; directory enumeration detects unsupported additional active configuration, not ownership. Read only bounded configuration files, not state contents. Preserve locks, provider constraints, variables, outputs, environment values and resource bodies. Generate root module consumers and explicit environment backends using selected manifest environments. Recognize equivalent partially moved source/destination files; conflicting definitions remain blocked.

Reject constructs whose module movement or resource scope cannot be proven: external modules, path-dependent expressions, provisioners, unknown providers/backends, ambiguous duplicates, dynamic ownership, or unbounded configuration. A plan-only result identifies the unsupported file or construct.

### Undeployed discovery is not inferred from missing files

Ordinary preview checks explicit local state locations and backend configuration without reading state. Only `--live --subscription <id>` requests bounded Azure CLI metadata using existing authentication, explicit arguments, output limits, and deadlines. The recipe must establish all supported resource-group bindings from source/environment semantics; each group must be authoritatively absent in the selected verified subscription, and all supported local state/backend locations must be absent. Unknown, denied, timed-out, stateful or incomplete observations block writes. Apply repeats discovery immediately before commit under the project lock.

Stateful/unknown plans explain that this public lane cannot migrate deployed state and disclose no fabricated state migration command. They leave original roots usable and unchanged.

### Reuse transaction and storage defenses

Parameterize the existing reviewed transaction with a registered repair journal while retaining the default update behavior. Both commands reject pending transactions from either lane and share the mutation lock. Repair's external approval seal remains independent. Journal recovery can only restore recorded unchanged targets, never overwrite concurrent edits. Preserve original manifest/provenance in immutable `.liftoff/repair-history/<fingerprint>/` records before active replacement; state contents never enter these records. File content remains local/private; public preview shows exact operation paths and digests, not potentially sensitive configuration.

### Validate before commit and report scoped completion

Validate the candidate in isolated staging using only approved backend-disabled OpenTofu initialization/validation; never plan or apply cloud changes. Missing tools and validation failures preserve the project. Update active project artifact records from actual committed bytes and remove only exact retired identities. Preserve unrelated manifest fields, existing activation identity, history and evidence. Post-commit validation failure reports committed-but-incomplete repair and a supported retry; success means infrastructure repair scope only, not completed governance.

## Risks / Trade-offs

- Conservative semantic support can block customized configurations -> give exact unsupported reasons; never replace them with a starter.
- Azure discovery can hang or deny access -> bounded per-command deadlines and explicit incomplete outcomes; no retries that loop indefinitely.
- Cloud state has concurrency beyond a local filesystem lock -> the local lane is restricted to proven absence and performs no deployment; stateful cutover remains separately qualified work.
- Backend-disabled initialization can need provider downloads -> disclose this in approval, use bounded execution and private staging, and never initialize the original backend.
- Windows path/case differences -> reuse native path and sealed-transaction checks and test paths with spaces and collisions.
- Earlier specifications overstate shipped support -> document current executable/plan-only boundaries and mark tasks complete only with implementation evidence.

## Migration Plan

Add the new command without changing existing manifests on check. For eligible legacy projects: preview, approve, validate staged configuration, commit files plus provenance, then run update and local setup verification. Interrupted writes use explicit repair recovery. Existing deployed roots are never relocated by this local lane.
