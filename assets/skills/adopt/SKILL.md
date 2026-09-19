---
name: liftoff-adopt
description: "Adopt an existing supported codebase in-place with minimal managed core and explicit per-file mappings."
---

# Liftoff In-Place Adoption Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `project-adoption`, Project Evolution, public envelope schema 1 and
adoption command result schema 1. Missing implementation, prerequisites,
unsupported profiles and unqualified execution remain distinct blockers.
Neither a model claim nor a CLI version implies stack conversion support.

## Exact Existing Boundary and Proposal

```bash
liftoff assess --project ./my-app --json
liftoff adopt --project ./my-app --check --json
```

Choose an actual supported profile/component from CLI observations. A Vue-only
application does not acquire an invented backend or cloud target. Existing
business files remain project-owned; generation/adoption hashes are provenance,
not future overwrite permission. Preserve Git history and original profile facts.

If application changes are needed, use an explicit proposal in external staging:

```bash
liftoff adopt --project ./my-app --proposal ../reviewed-adoption.json --check --json
liftoff adopt --project ./my-app --proposal ../reviewed-adoption.json
```

Review exact source/destination mappings, bytes/modes, references, additions,
protected exclusions and tool/recipe identities. Never replace a repository with
a starter, infer ownership from directories, or treat an unowned collision as
permission. Application mappings cannot forge protected metadata; deterministic
adoption metadata/framework/integration producers retain separate exact authority.

## Independent Consent and Actual Outcomes

Normal interactive execution displays the immutable plan, then genuine default-No
decisions. Do not ask for human hash entry. Verification, project-code execution,
declared dependency preparation, network effects and file/metadata commit have
separate permissions. JSON/non-TTY without the appropriate exact flags remains
preview-only. Autopilot, generic Yes, piped answers or model approval authorize none.

Use only actual returned `--verify-plan` and `--approve-plan` actions with the
complete current fingerprint and separately requested permissions. Never add
network/preparation flags merely to make a command proceed.

Report preparation, checks, committed effects, readback, cleanup and remaining
work separately. A late decline cannot erase earlier authorized host/network
effects. Keep current target, cwd, scope, configuration digest and compatibility
bindings in every continuation. Unknown/changed inputs require new review.
Recover only attributable recorded adoption effects; never blind rollback over
newer user files, fabricated generation history, or forced framework conversion.
