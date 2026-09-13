## Context

The existing upgrade guard compares the running package's real path with `npm root --global`. On the affected Mac, Liftoff is under `/opt/homebrew/lib/node_modules`, whereas the active Node 24 npm reports `/opt/homebrew/Cellar/node@24/24.21.0/lib/node_modules`. A check-only invocation with `npm_config_prefix=/opt/homebrew` succeeds.

## Goals / Non-Goals

**Goals:** Correct this verified Homebrew mismatch while retaining package confinement, configured-registry parity, bounded subprocesses, read-only checks, and exact replacement verification.

**Non-Goals:** Supporting arbitrary npm prefixes or other package managers by guessing, changing `.npmrc`, installing/upgrading Node or npm, modifying projects, changing activation contracts, or publishing during this patch.

## Decisions

1. Preserve the current same-root path. Add a macOS-only fallback for the explicit standard Homebrew prefixes `/opt/homebrew` and `/usr/local`, rather than accepting any path ending in `lib/node_modules`.
2. Require the resolved Node executable and npm global root to agree on a Node Cellar installation beneath that same prefix. Require the running package to be a real canonical package under the stable global root, with valid metadata and a confined regular binary reached by the prefix's `bin/liftoff` link. Reject missing, linked, escaped, or ambiguous targets.
3. Confirm the candidate with bounded `npm root --global --prefix <prefix>`. Carry that explicit prefix into registry probes, exact installation, and post-install root checks. Compare the active and targeted machine-level registries before proceeding, and use global mode so the prefix's local `.npmrc` cannot become authority. Recheck the selected installation before writes; require post-install verification to remain at the originally selected package root.
4. Preserve JSON schema 1 and its privacy boundary. A new optional, enumerated installation-target hint can identify a standard Homebrew layout without exposing arbitrary package paths. This also lets failure guidance retain the correct `--prefix`.
5. Test with injected filesystem/process observations or temporary fixtures only; do not install into the developer's Homebrew prefix. Validate the actual reproduction with read-only checks.

## Risks / Trade-offs

- Unrecognized Homebrew or custom npm layouts remain blocked rather than guessed.
- Prefix changes during an upgrade could redirect writes or verification; mitigate with explicit npm arguments and repeated canonical target/launcher checks.
- Existing old binaries cannot acquire this fix themselves; document the verified one-invocation prefix workaround to bootstrap the patched release.
