# Liftoff

Liftoff is a developer platform CLI for macOS (Apple Silicon) and Windows
(x64) that creates, assesses, adopts and maintains governed API and GenAI
projects. It is being rebuilt from scratch: no code, schemas or file layouts
come from the old v0.12 release.

## Checks

Run from the repository root with Node 26 (`.node-version`):

| Command | What it checks |
| --- | --- |
| `npm ci` | Install the locked dependencies |
| `npm run lint` | Biome lint and formatting |
| `npm run typecheck` | TypeScript, strict |
| `npm run boundaries` | Architecture boundaries, cycles, unreachable files |
| `npm run check:trace` | Requirements in `docs/requirements/` and the tests that cite them |
| `npm run check:generated` | Committed generated files match their sources |
| `npm run coverage` | Tests, with more than 80% on every coverage metric |
| `npm run check` | All of the above |

`npm run liftoff -- <command>` runs the CLI from source.

## Layout and boundaries

- `src/cli/` parsing, help and output; `src/cli/registry.ts` lists every
  command. `src/ci/` holds checks bundled into `.github/liftoff/`.
- `src/application/` use cases. They reach files, Git, GitHub and processes
  only through the ports in `src/application/ports.ts`.
- `src/domain/` deterministic rules with no I/O.
- `src/adapters/` the only code that touches the file system, processes and
  the network.
- `src/plugins/` and `src/generators/` are pure; `assets/` holds the one
  canonical copy of each template, skill and agent.
- `npm run boundaries` enforces these rules.

## Conventions

- Requirements live in `docs/requirements/` with IDs such as `REVIEW-002`.
  A test for a requirement puts its ID in the `describe` or `it` name.
- Generated files carry a "Managed by Liftoff" marker. Change the source in
  `assets/` or `src/`, then run `npm run render:own` or
  `npm run build:ci-bundle`. Never edit generated copies by hand.
- Pin exact dependency versions and GitHub Actions to full commit SHAs.
- Match the surrounding code: naming, error handling and comment density.

## Never

- Weaken a check to get green: no skipped tests, `|| true`,
  `continue-on-error`, lowered thresholds or coverage exclusions.
- Claim a check passed without running it and showing the output.
- Add Linux CLI support, carry over old Liftoff code or formats, or add
  features the requirements do not ask for.
- Commit secrets, real customer data or absolute local paths.

## Review

Pull requests target `develop`. See [REVIEW.md](REVIEW.md) for what reviewers
look for and [GOVERNANCE.md](GOVERNANCE.md) for how changes merge. Use the
`liftoff-verify`, `liftoff-code-review` and `liftoff-pr` skills before
opening a pull request.
