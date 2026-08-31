## Context

See `proposal.md` for motivation. Liftoff is published only as the scoped npm package `@msn-control/liftoff`, with global npm installation as the documented user path. The CLI already exposes its exact running version, compares versions with a local semver helper, performs a bounded canonical-registry freshness lookup in doctor, and executes external commands through a shell-free cross-platform runner.

Self-upgrade has stricter constraints than ordinary project reconciliation:

- the running process replaces the package from which it was launched;
- a command invoked through a local dependency, `npx`, a development checkout, `npm link`, or another package manager must not silently create a second global installation;
- enterprise users may depend on an approved npm mirror, while canonical npm remains the release authority;
- repository-local `.npmrc` files must not redirect a machine-level CLI upgrade;
- installation output and failures must remain observable without contaminating JSON stdout;
- tests must never replace the developer or CI runner's real global Liftoff installation.

This change should be implemented after `refresh-supported-stack-baselines` so it uses the final Node.js/npm baseline and shared release-version sources.

## Goals / Non-Goals

**Goals:**

- Upgrade a verified global npm installation to the exact current stable Liftoff release.
- Provide a side-effect-free availability check suitable for people and automation.
- Preserve configured registry policy without trusting a stale mirror as the release authority.
- Verify the replaced package and executable before claiming success.
- Keep behavior independent of the current directory and any Liftoff project.
- Produce stable, redacted human and machine-readable outcomes on Windows, macOS, and Linux.

**Non-Goals:**

- Upgrade Node.js, npm, OpenSpec, Spec Kit, project dependencies, or generated project artifacts.
- Support automatic pnpm, Yarn, Bun, Homebrew, WinGet, local, `npx`, linked-development, or unknown installation origins in the first version.
- Install prerelease channels, select an arbitrary target version, or perform a downgrade.
- Modify `.npmrc`, change the configured registry, bypass a managed mirror, invoke `sudo` or another elevation mechanism, or collect credentials.
- Promise transactional rollback of npm's own global package replacement.

## Decisions

### 1. Make `upgrade` explicit and keep `update` project-scoped

The command surface is:

```text
liftoff upgrade
liftoff upgrade --check
liftoff upgrade --json
liftoff upgrade --check --json
```

`liftoff upgrade` is imperative. Invoking that dedicated command is authorization to replace the supported global Liftoff package, so it does not add a second confirmation or `--yes` flag. It first displays the current and exact target versions plus the package operation in human mode. `--check` performs all discovery and registry parity checks but never starts installation.

`liftoff update` remains the only project-template reconciliation command. A successful CLI upgrade recommends `liftoff update --check` as a separate next action but never runs it.

**Alternative considered:** make `upgrade` an alias for `update`. Rejected because the commands change different ownership domains and have different permissions, failure modes, and prerequisites.

**Alternative considered:** prompt before installation. Rejected because the command itself is a narrow explicit mutation request and an additional prompt would make redirected and automated use ambiguous. No other flag may imply this authorization.

### 2. Use an explicit state machine

```text
inspect supported global installation
                 |
                 v
resolve canonical stable target
                 |
                 v
verify configured registry exposes exact target
                 |
                 v
compare current and target
        /        |         \
   current   newer target   target older/prerelease
      |          |                    |
    exit 0   check: exit 2          blocked
             apply: install            |
                    |                 exit 1
                    v
             verify replacement
               /          \
            success       failure
            exit 0        exit 1
```

Stable result states are `current`, `update-available`, `upgraded`, `blocked`, and `failed`. `blocked` represents a deliberate safety refusal such as an unsupported installation origin or stale approved mirror; `failed` represents an infrastructure, npm, or post-install verification failure.

### 3. Treat canonical npm as authority and the configured registry as delivery policy

The target is resolved from canonical npm's `latest` metadata through a short absolute timeout. Metadata must identify `@msn-control/liftoff`, contain a valid stable semantic version, and not resolve to a prerelease. Liftoff compares that exact version with the running package version and never selects a lower version.

The effective installation registry is obtained from npm in an empty temporary working directory so user/global/environment npm configuration applies while repository-local `.npmrc` does not. Liftoff then verifies that this configured registry exposes the exact canonical target before apply or an update-available check result.

- If the configured registry is canonical, normal canonical delivery proceeds.
- If it is an approved mirror with exact target parity, installation proceeds through that mirror.
- If it is stale, missing the exact version, malformed, or unavailable, the command is blocked or failed with mirror synchronization guidance.

The install command does not force `--registry=https://registry.npmjs.org` over a configured mirror and never writes npm configuration. Display and JSON output identify only `canonical` or `configured` registry kind; raw URLs containing user information, tokens, query strings, or configuration paths are never emitted.

**Alternative considered:** install directly from canonical npm regardless of configuration. Rejected because it silently bypasses enterprise registry policy already protected by Liftoff's distribution contract.

### 4. Upgrade only the installation that launched Liftoff

Before registry resolution, Liftoff asks npm for its effective global package root from the same neutral working directory. It canonicalizes that root and the running package root, then requires the running package to be the explicit `@msn-control/liftoff` entry beneath that npm global root.

The command refuses:

- repository or local `node_modules` installations;
- npm execution-cache or `npx` installations;
- symlinked development checkouts and `npm link`;
- a running package outside npm's reported global root;
- missing or incompatible npm;
- ambiguous roots or package metadata.

The refusal reports the exact manual global npm install form for the canonical target and leaves the current installation untouched. It does not attempt to infer or mutate another package manager's global store.

Path containment uses canonical paths and the Node path module. Tests cover Unix global layouts, Windows prefix layouts, spaces, case-insensitive comparison where applicable, symlinks, and escape attempts.

### 5. Run one exact shell-free npm replacement

Apply mode invokes npm with an argument array equivalent to:

```text
npm install --global --ignore-scripts --no-audit --no-fund @msn-control/liftoff@<exact-version>
```

It runs from the neutral temporary directory, inherits the existing approved npm authentication/configuration environment, does not pass credentials as arguments, uses no shell, and never invokes elevation. Human mode streams child stdout and stderr unchanged. JSON mode keeps stdout byte-pure by routing child progress to stderr and emitting one final JSON document on stdout.

The command has a bounded but installation-appropriate timeout. A timeout, spawn error, signal, or nonzero npm status is a failure and cannot be converted into success by later diagnostic output.

**Alternative considered:** download and replace Liftoff files directly. Rejected because npm owns global prefix layout, links, integrity checks, cache, authentication, and platform behavior.

### 6. Verify package identity and executable after install

After npm exits successfully, Liftoff resolves the same global package root again and verifies:

1. the installed `package.json` has the canonical package name and exact target version;
2. its declared `liftoff` binary resolves to a project-confined regular file;
3. running that binary through the current Node executable prints exactly `Liftoff <target-version>`.

The verification subprocess runs from the neutral directory with telemetry disabled so the parent upgrade emits at most the normal single aggregate command event. Verification does not depend on shell `PATH`, which may still contain another Node-manager prefix.

Only all three checks permit `upgraded`. Failure reports that npm returned success but installation verification failed and provides the exact repair command. Liftoff does not automatically reinstall the old version because npm may have partially changed global state and an unverified rollback could make recovery worse.

### 7. Keep output stable and non-sensitive

Human output uses the shared presentation system and distinguishes discovery, target resolution, registry parity, installation, verification, and completion. The JSON schema is versioned and includes:

```json
{
  "schemaVersion": 1,
  "mode": "check",
  "status": "update-available",
  "currentVersion": "0.7.0",
  "targetVersion": "0.8.0",
  "registryKind": "configured",
  "reasonCode": "update_available"
}
```

Fields that do not apply are omitted. JSON and human summaries never include registry credentials, configuration file paths, global package paths, project paths, raw npm arguments containing secrets, or arbitrary registry response bodies. Detailed child output is forwarded only through the appropriate stderr/progress channel.

Exit codes are:

- `0`: already current or successfully upgraded;
- `2`: check mode found an installable newer stable version;
- `1`: invalid input, unsupported or blocked installation, registry failure, npm failure, timeout, or verification failure.

### 8. Reuse freshness behavior without coupling doctor to mutation

Canonical stable-version parsing and bounded lookup become shared read-only functionality used by doctor and upgrade. Doctor remains read-only and recommends:

1. `liftoff upgrade --check` to confirm delivery through the configured registry;
2. `liftoff upgrade` to apply when supported;
3. the exact manual npm command as fallback for unsupported installation origins.

Doctor never calls upgrade automatically. Upgrade does not invoke doctor or project drift checks.

### 9. Extend telemetry without adding upgrade details

`upgrade` is added to the explicit telemetry command allowlist and ingestion validation. The parent process emits at most one event with command `upgrade`, the version of the process that was invoked, and the existing zero/nonzero outcome. Check/apply flags, current/target versions, registry kind, installation origin, npm output, paths, and failure details remain excluded.

### 10. Test only isolated installations

Unit tests inject registry, filesystem, package-root, and command-runner dependencies. Integration and package-smoke tests create an isolated temporary npm prefix and cache; they never call apply mode against the host's actual global prefix. Coverage includes:

- current, update-available, successful replacement, stale mirror, offline, timeout, malformed metadata, prerelease, and downgrade states;
- local, `npx`, linked, ambiguous, and valid global installation origins;
- npm nonzero exit and success-with-wrong-installed-version;
- human, JSON, redirected, no-color, narrow terminal, and telemetry behavior;
- Windows, macOS, and Linux path and executable resolution.

## Risks / Trade-offs

- **[Running package is replaced during execution]** -> Load required state before install, verify from the resolved replacement root, and avoid reading old package assets afterward.
- **[npm reports success after a partial or wrong install]** -> Require package metadata, binary confinement, and exact version-command verification before success.
- **[Managed mirror lags canonical npm]** -> Block with synchronization guidance instead of bypassing the mirror or installing an older target.
- **[Project `.npmrc` is malicious or accidental]** -> Resolve and run from a neutral temporary directory while preserving user/global/environment configuration.
- **[Global prefix requires administrator rights]** -> Never elevate; surface npm's failure and exact manual remedy.
- **[Unsupported package manager creates duplicate installs]** -> Refuse automatic mutation unless the running package is inside npm's own reported global root.
- **[JSON is corrupted by child output]** -> Reserve stdout for the final JSON object and route installation progress to stderr in JSON mode.
- **[Automatic rollback damages an already partial install]** -> Do not auto-rollback; report verification failure and an exact explicit reinstall command.
- **[Two pending changes touch version documentation]** -> Implement after the stack-baseline change and reconcile shared spec/doc edits rather than applying stale literals.

## Migration Plan

1. Implement the shared canonical release lookup and global npm installation inspection with injected tests.
2. Add command parsing, help, state model, human/JSON rendering, and check mode.
3. Add apply execution and post-install verification against isolated prefixes.
4. Update doctor remedies, telemetry allowlists and ingestion fixtures, package smoke tests, and documentation.
5. Run cross-platform tests and publish through the existing release process.

Older Liftoff versions that do not contain `upgrade` continue using the documented manual global npm command once. After installing the first release containing this capability, future stable releases can be installed through `liftoff upgrade`.

Rollback before publication is a normal source revert. After a failed user upgrade, recovery is an explicit exact-version npm reinstall; the command does not promise automatic rollback.
