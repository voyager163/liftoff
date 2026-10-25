# Review guide

Start every review with the number of findings. When there is nothing to
fix, say "No findings" and stop.

## What failure looks like here

- **The CLI lies**: it reports success, "passed" or "up to date" for
  something it did not check, or exits 0 after a failure.
- **It writes without consent**: a read-only command (`plan`, `assess`,
  `capabilities`, `review classify`, any `--check`) changes files, settings,
  remote state or telemetry, or a mutation runs without an approved plan.
- **It weakens a gate**: a check that can pass vacuously, a skipped or
  filtered test, a lowered threshold, `continue-on-error`, `|| true`, or a
  required check that no workflow produces.
- **It trusts the pull request**: review policy, review instructions or
  workflow logic read from the pull request instead of the base branch.
- **It breaks a host**: Windows paths, drive letters, spaces, case or
  line endings; macOS permissions or symlinks; a process tree left running.
- **It drifts**: a generated file, skill or bundle that no longer matches
  its source, or help and docs that list a command that does not exist.

## Important

A finding is Important when the change introduces or exposes one of the
failures above, or any other defect a user would hit. Give the file and line,
the input and state that trigger it, and the wrong result.

## Nits

At most three per review. Skip anything Biome or TypeScript already reports.

## Do not report

- Style the formatter controls.
- Generated files (`.github/liftoff/*.mjs`, rendered skills and agents);
  review their sources in `src/` and `assets/` instead.
- `package-lock.json` content, beyond whether it matches `package.json`.

## Always check

- New commands and options are in the registry, documented and tested,
  and read-only commands stay read-only.
- Every new requirement has a test that cites its ID, or is marked live.
- Errors are actionable and exit with the documented code.
