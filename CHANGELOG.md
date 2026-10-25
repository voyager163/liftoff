# Changelog

All notable changes to Liftoff are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Toolchain for the rebuild: Node 26, strict TypeScript, Biome, Vitest with
  coverage above 80% on every metric, an architecture boundary check and
  plain-Markdown requirements traced to tests.
- `liftoff capabilities` and `liftoff review classify`, from one command
  registry with strict parsing and fixed exit codes.
- Review risk policy (`.github/review-policy.yml`) with single-maintainer,
  team, risk-tiered and none profiles, and the `review-policy` check that
  reports a tier and approval status on every pull request.
- Review skills for GitHub Copilot, Codex and Claude Code, and a read-only
  verifier agent for each host.
- Verified AI review with GitHub Copilot CLI: independent finder passes,
  majority voting by separate verifier runs, tagged findings, no repeats and
  a three-round cap, plus nightly review evals and weekly review metrics.
- CI on macOS arm64 and Windows x64 with a fail-closed `ci-gate`, CodeQL,
  dependency review, committed branch rulesets and a weekly drift readback.
- Open source project setup: README hero image, contributing guide,
  Contributor License Agreement, Code of Conduct (Contributor Covenant 3.0),
  security, support and governance policies, issue forms, pull request
  template, CODEOWNERS, Dependabot, and repository checks, CLA and OpenSSF
  Scorecard workflows.

[Unreleased]: https://github.com/voyager163/liftoff/commits/develop
