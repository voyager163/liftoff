# Power Apps code-app starter asset

Liftoff packages the official Microsoft starter from:

- Repository: `https://github.com/microsoft/PowerAppsCodeApps`
- Path: `templates/starter`
- Commit: `3438c352483e40982f6c5c0fc36fd71f8e7adbbb`
- License: MIT

The versioned directory contains the copied source, generated lockfile, upstream license, and a
catalog of portable paths, logical names, provenance, and SHA-256 hashes. Runtime generation reads
only this checked-in catalog. The upstream `.gitignore` is also copied to the package-safe
`packaged/gitignore` path because npm excludes nested `.gitignore` files from tarballs.

## Refresh procedure

1. Use Node 22 and run
   `npm run refresh:power-apps-starter -- <40-character-immutable-commit>`.
2. Review the displayed source diff, regenerated lock/catalog, upstream MIT license, package-root
   identity, hashes, and pinned metadata change. The command rejects symlinks, generated bindings,
   caches, dependencies, and build output.
3. Update commit-specific expectations, then run `npm run verify:power-apps-starter`, the package
   smoke test, and the full Liftoff test suite.
4. Review `THIRD_PARTY_NOTICES.md` output and packed-package size before release.

This maintainer-only command downloads the requested immutable archive and never runs during
`liftoff init`, planning, validation, updates, or doctor checks.
