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

## Release verification

The public release authority is `https://registry.npmjs.org`. The release workflow performs local package checks before publishing and strict canonical verification afterward. The post-publish verifier must remain after `npm publish`, must receive the selected `latest` or `next` dist-tag, and must not use `continue-on-error` or legacy compatibility mode.

If canonical post-publish verification fails, do not announce the release as complete. Compare the expected and observed dist-tag versions. Correct the dist-tag when the expected immutable package already exists; otherwise publish a corrected patch release. Do not unpublish a released package as routine recovery.

A successful canonical release does not make an external managed mirror ready. Teams using a managed registry must withhold internal installation guidance until the mirror exposes both the canonical stable dist-tag and its explicit version and a clean mirrored install reports the expected package version.

Pre-0.3 Liftoff releases are unsupported but remain available for reproducibility. An authorized npm release owner applies the deprecation warning without unpublishing:

```bash
npm deprecate '@msn-control/liftoff@<0.3.0' 'Liftoff versions before 0.3.0 are unsupported. Upgrade to @msn-control/liftoff@latest.' --registry=https://registry.npmjs.org
```

Afterward, verify that an old explicit version has both the warning and its original tarball:

```bash
npm view @msn-control/liftoff@0.2.1 deprecated --registry=https://registry.npmjs.org
npm view @msn-control/liftoff@0.2.1 dist.tarball --registry=https://registry.npmjs.org
```

## Propose behavior changes

Liftoff uses OpenSpec for product behavior and compatibility contracts. Changes that add, remove, or modify observable behavior should include an OpenSpec change under `openspec/changes/` and update the applicable capability specs.

## Pull requests

- Keep changes focused and include tests for changed behavior.
- Update user and contributor documentation when commands, generated output, or workflows change.
- Confirm generated projects contain no credentials or environment-specific values.
- Do not change persisted manifest identity or append-only identifiers without an explicit compatibility design.

By contributing, you agree that your contribution is licensed under GPL-3.0-only.

Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
