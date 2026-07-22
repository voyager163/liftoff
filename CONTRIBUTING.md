# Contributing to Liftoff

Thank you for helping improve Mission Control Liftoff.

## Development setup

Install the supported toolchains:

- Node.js 20 or newer
- Python 3.12
- Go 1.23
- OpenTofu 1.12

Clone the repository and install the locked Node.js dependencies:

```bash
git clone https://github.com/voyager163/liftoff.git
cd liftoff
npm ci
```

## Validate a change

Run the full package check and packed-install smoke test:

```bash
npm run check
npm run smoke:package
```

Filesystem and manifest changes must remain portable across Windows, macOS, and Linux. Use Node.js path utilities rather than hardcoded separators, and preserve append-only manifest logical names and catalog identifiers.

## Propose behavior changes

Liftoff uses OpenSpec for product behavior and compatibility contracts. Changes that add, remove, or modify observable behavior should include an OpenSpec change under `openspec/changes/` and update the applicable capability specs.

## Pull requests

- Keep changes focused and include tests for changed behavior.
- Update user and contributor documentation when commands, generated output, or workflows change.
- Confirm generated projects contain no credentials or environment-specific values.
- Do not change persisted manifest identity or append-only identifiers without an explicit compatibility design.

By contributing, you agree that your contribution is licensed under GPL-3.0-only.

Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
