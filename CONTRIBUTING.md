# Contributing to Liftoff

Bug fixes, documentation corrections, tests, and improvements to supported
GenAI/API workflows are welcome. Liftoff is an independent, single-maintainer
project. Support and review are best effort, without a response deadline or SLA.

## Support and reporting

| Need | Where to go |
| --- | --- |
| Usage help | [Getting started](docs/getting-started.md) and [troubleshooting](docs/troubleshooting.md), then [GitHub Issues](https://github.com/voyager163/liftoff/issues) |
| Reproducible bug | [Bug report](https://github.com/voyager163/liftoff/issues/new?template=bug_report.yml); a released CLI reproduction is enough |
| Feature or substantial change | [Feature proposal](https://github.com/voyager163/liftoff/issues/new?template=feature_request.yml) to discuss the problem and alternatives first |
| Suspected vulnerability or secret exposure | The private process in [SECURITY.md](SECURITY.md#report-a-vulnerability), never a public issue or PR |
| Sensitive conduct concern | The separate owner-approved [private conduct route](CODE_OF_CONDUCT.md#report-a-conduct-concern), not vulnerability intake or public templates |
| Participation expectations | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

The conduct mailbox is only for private conduct reports. Usage questions,
bugs, and feature requests stay in Issues; suspected vulnerabilities and secret
exposure stay in the separate private security process.

Search existing issues before filing. Share only relevant, sanitized versions,
OS details, and a minimal reproduction. Never post credentials, private source
or data, `.env` files, or unredacted diagnostics. Do not upload whole projects or
broad environment/configuration dumps. No new forum or private project access
is required.

## Development setup

A small documentation correction can be edited on GitHub or in a fork without
every workload toolchain. For local TypeScript or documentation tests, use
Node.js 24 LTS at 24.20.0 or newer within that line and npm 12.x at 12.0.2 or newer.
See [prerequisites](docs/prerequisites.md) and the
[supported stack](docs/supported-stack.md) for workload-specific tools.

Fork `voyager163/liftoff` on GitHub. From your fork, branch from upstream
`develop` (replace `YOUR-USERNAME`):

```bash
git clone https://github.com/YOUR-USERNAME/liftoff.git
cd liftoff
git remote add upstream https://github.com/voyager163/liftoff.git
git fetch upstream
git switch -c fix/my-change upstream/develop
npm ci
npm run build
node dist/cli.js help
```

Use the committed lockfile, not `npm install` to refresh it incidentally.
Canonical public registries are the normal setup; no private Mission Control
files, publisher credentials, or cloud access are needed. Only explicit
organizational policy requires an [approved registry override](docs/maintainer-reference.md#policy-required-registry-overrides);
device ownership alone does not. Do not change global registry settings.

## Validate a change

Run the smallest checks covering your change:

```bash
npx vitest run tests/documentation.test.ts
# For code changes, select the affected test file(s):
npx vitest run tests/<focused-file>.test.ts
```

- **Documentation:** the documentation tests cover links, anchors, public
  contracts, and safe intake. For package/navigation changes also run
  `npm run smoke:package`.
- **CLI or library behavior:** add focused tests, then run `npm run check`
  before requesting merge; explain any unavailable checks.
- **Templates or dependencies:** use the affected locked workload checks and
  [maintainer verification](docs/maintainer-reference.md#validate-a-change),
  including generated-project coverage. Docker and extra language toolchains
  are needed only for their applicable checks.
- **Telemetry or infrastructure:** follow the same maintainer reference;
  ordinary validation does not authorize cloud plan/apply or deployment.

Ordinary tests use deterministic fixtures. Live registry audits and freshness
checks are separate, network-dependent evidence, not a reason to regenerate
locks or bypass a failing check. Never run CLI self-upgrade apply against your
real global prefix while testing.

## Documentation

Public guides are plain Markdown under `docs/`, with static assets under
`docs/assets/`; no documentation generator is needed. Keep the README below
135 normalized content lines: LF and CRLF count equally; ignore only the
terminal newline, not other blank lines. Link detailed guidance instead of
deleting safety, repair, migration, privacy, or compatibility contracts.

Package every locally linked document and asset. Documentation tests and
package smoke verify navigation and section anchors from the checkout and the
extracted tarball independently. Advanced documentation/release checks are in
the [maintainer reference](docs/maintainer-reference.md#documentation).

## Propose behavior changes

Discuss substantial features and public-contract changes in an issue first.
Liftoff uses OpenSpec for behavior and compatibility contracts: applicable
changes belong under `openspec/changes/` and must update affected capabilities.
Before completing such work, run `openspec validate <change-name> --strict`.
Routine typo fixes, clearer wording, and tests of unchanged behavior do not need
an unrelated issue or new specification.

## Pull requests

Open a focused PR from your fork targeting **`develop`**, the default integration
branch. Changes to **`main`** follow the [release path](docs/maintainer-reference.md#release-verification),
not ordinary contributor pushes. The sole maintainer decides what merges; no
second reviewer, CLA, DCO/sign-off, or tool-specific AI disclosure is required.

- Explain the purpose, applicable issue/spec, verification results, and any
  documentation or compatibility impact. Use a justified “not applicable”
  where the PR checklist does not fit a small correction.
- Include tests for changed behavior and generated-project checks where relevant.
- Preserve portable Windows/macOS/Linux paths and stable manifest identities;
  identity, schema, graph, ownership, or compatibility changes need an explicit
  specification decision and migration or rejection-remedy tests.
- Keep generated fixtures free of real credentials and live resource bindings;
  nonsecret defaults must be explicit.
- First-time fork contributors may need maintainer approval before GitHub
  Actions runs. Do not supply secrets or publisher/cloud credentials to enable
  PR validation. Local passing tests or a workflow file do not prove hosted
  protection: hardening qualification and activation are separate work.

### Security policy changes

Normal PR admission requires complete successful candidate analysis, integrity,
functional checks, and actual finding-policy success. The distinct
[policy-only maintenance path](docs/repository-security.md#pull-request-admission-and-policy-adoption)
is limited to exact exception/disposition data already registered by the trusted
base; mixing in code, dependency, workflow, or rule changes does not qualify.
Existing findings remain blocked before adoption. Candidate owner, approval, or
evidence fields are traceability, not authority.

The maintainer's ordinary merge adopts a qualified proposal: there is no separate
pre-merge receipt, authorization command, or second-reviewer gate, and no blind
auto-merge. Later assessments independently reload adopted policy; admission
never authorizes publication. These are locally tested foundations, not yet
qualified production workflow integration or hosted enforcement. See the
[maintainer lifecycle](docs/maintainer-reference.md#review-source-security-policy-changes)
before changing policy data.

## Audit packaged template dependencies

See the [four-graph audit, exact exceptions, and locked refresh procedure](docs/maintainer-reference.md#audit-packaged-template-dependencies).

## Refresh the supported stack

See [canonical sources, stable/LTS selection, and promotion checks](docs/maintainer-reference.md#refresh-the-supported-stack).

### Reconcile Dependabot updates

See [baseline-managed dependency proposals](docs/maintainer-reference.md#reconcile-dependabot-updates).

## Maintain the repository-governance profile

See [profile maintenance and ownership safeguards](docs/maintainer-reference.md#maintain-the-repository-governance-profile)
and the [developer guide](DEVELOPER.md). Generated governance is not proof of
controls enforced on this source repository.

## Release verification

See [release identity, qualification, and publishing](docs/maintainer-reference.md#release-verification).

## Release recovery

See [non-destructive release and managed-registry recovery](docs/maintainer-reference.md#release-recovery).

## License and security

By contributing, you agree that your contribution is licensed under the
existing [GPL-3.0-only](LICENSE) terms. Submit only work you have the right to
share, respecting copyright and confidentiality. You remain responsible for
understanding, explaining, and validating your submission, including
AI-assisted work. Review generated suggestions as carefully as handwritten code.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and the
[support and reporting map](#support-and-reporting). Report vulnerabilities
privately through [SECURITY.md](SECURITY.md#report-a-vulnerability).
