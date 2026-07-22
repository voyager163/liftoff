# Tasks: add-manifest-v2

## 1. Manifest schema v2

- [x] 1.1 Update `LiftoffManifest` and `ManifestArtifact` types in `src/types.ts`: `artifactVersion: 2`, top-level `liftoffVersion: string`, per-artifact `contentHash: string`
- [x] 1.2 Add a CLI version helper that reads the package version from package metadata resolved relative to the compiled module (works from source, tests, and the packed npm layout)
- [x] 1.3 Update `buildManifest` in `src/templates.ts` to embed `liftoffVersion` and compute `sha256:<hex>` content hashes with `node:crypto` over the exact artifact bytes (after trailing-newline normalization)

## 2. Manifest reading policy

- [x] 2.1 Add a manifest loader in `src/file-system.ts` that parses `liftoff.manifest.json`, accepts `artifactVersion` 2, and rejects other versions with a message naming the found version, supported versions, and the remedy (regenerate or use a matching CLI)
- [x] 2.2 Route `validateGeneratedProject` through the loader so `validate` keeps its presence-check behavior on v2 manifests and fails clearly on unsupported versions

## 3. Contract test

- [x] 3.1 Add a contract test that renders a representative plan matrix (frontend on/off, worker and non-worker patterns) and asserts the sorted `logicalName` list matches a checked-in snapshot, with a failure message stating the append-only policy
- [x] 3.2 In the same test, render each plan twice and assert every artifact (including the manifest) is byte-identical across renders
- [x] 3.3 Freeze a v2 manifest fixture and assert it parses through the loader and matches the expected schema shape (spot-check `liftoffVersion` presence and `sha256:` prefix format)
- [x] 3.4 Add a test that hashing a generated file on disk reproduces the manifest's `contentHash` for that artifact (use `path.join` for expected paths)

## 4. Conventions and release

- [x] 4.1 Document the contract conventions in root `README.md`: exit codes (0 clean / 1 failure / 2 drift), `.liftoff/` reserved for future CLI state, no new root-level CLI files, `--json` outputs carry `schemaVersion`, manifest policy read-supported/write-latest
- [x] 4.2 Bump `package.json` to 0.2.0
- [x] 4.3 Run `npm run check` and the package smoke test; confirm create → validate round-trip passes on a scratch project
