## 1. Package Metadata

- [x] 1.1 Add npm discovery metadata to root `package.json`, including repository, homepage, bugs, keywords, and explicit public scoped-package publish configuration.
- [x] 1.2 Confirm only the standalone Liftoff package is publishable.
- [x] 1.3 Verify `files` and `bin` metadata include compiled runtime assets and exclude source, tests, local caches, and generated tarballs from the published package.

## 2. Package Verification

- [x] 2.1 Add a package smoke-test script that builds or consumes the built Liftoff package, creates an npm tarball, and installs it into an isolated temporary npm prefix.
- [x] 2.2 Resolve the installed `liftoff` executable with cross-platform Node.js or npm path handling instead of hardcoded POSIX paths.
- [x] 2.3 Invoke the installed CLI with `liftoff help` from outside the Liftoff repository and fail if the command cannot run.
- [x] 2.4 Add assertions or checks that the packed package includes `package.json`, README content, `dist/cli.js`, and required compiled runtime modules.

## 3. Release Automation

- [x] 3.1 Add a GitHub Actions release workflow that installs dependencies, builds Liftoff, runs tests, inspects npm pack output, runs the package smoke test, and publishes the standalone package.
- [x] 3.2 Configure publishing for public scoped package access and npm provenance or trusted publishing where available.
- [x] 3.3 Document the `NPM_TOKEN` fallback path if trusted publishing is not configured for the repository and npm organization.
- [x] 3.4 Ensure stable releases publish to the `latest` dist-tag and prerelease versions do not move `latest`.

## 4. Documentation

- [x] 4.1 Update the root README to show `npm install -g @msn-control/liftoff@latest` as the primary user install path.
- [x] 4.2 Update the Liftoff README with first-use commands such as `liftoff help` and `liftoff create` after global installation.
- [x] 4.3 Keep repository-local `npm run build`, `npm test`, and `npm run check` instructions clearly separated as contributor workflows.

## 5. Verification

- [x] 5.1 Run the full root workspace check and confirm existing Liftoff tests still pass.
- [x] 5.2 Run the package smoke test on macOS locally and ensure CI covers Linux and Windows path behavior.
- [x] 5.3 Run `npm pack --dry-run --json` and confirm the package contents match the distribution requirements.
- [x] 5.4 Before first publish, verify npm scope/package ownership and then confirm `npm install -g @msn-control/liftoff@latest` works from a clean environment.