## Why

Liftoff needs a welcoming open-source entry point and enforceable repository ownership boundaries before its planned application rewrite. The existing license and community foundation should be completed with contributor-friendly controls over merges, automation, and releases, without auditing or hardening application code that is about to change.

## What Changes

- Complete the public participation surface with governance and support guidance, CODEOWNERS, bug/feature issue forms, a PR template, explicit contribution rights, and separate public-support, private-security, and private-conduct channels.
- Preserve `GPL-3.0-only`, public source access, forks, and community contributions. Do not add mandatory CLAs, DCO sign-offs, signed commits, or independent approving reviews while there is one maintainer.
- **BREAKING for maintainer workflow:** require PRs into both `develop` and `main`, with zero required approving reviews, resolved conversations, observed required checks, and no standing bypass actors. Prevent branch deletion and force pushes while retaining ancestry-preserving release promotion and back-synchronization.
- Retain read-only automation defaults and prohibit bot PR approvals. Enforce full-SHA action references, allow only approved action dependencies, require workflow approval for all outside contributors, and separate untrusted contribution checks from publication authority.
- **BREAKING for publication workflow:** gate the current publishing workflow through an explicitly approved GitHub release environment, restrict version-tag authority, and enable immutability for future GitHub releases. Preserve existing package qualification, trusted-publishing behavior, provenance, and post-publication verification without inspecting or changing npm account settings.
- Redesign the README as an open-source landing page inspired by Graft's hierarchy, using original rocket-ascent artwork, a prominent Liftoff wordmark, a concise factual tagline, compact badges, navigation, quick start, CLI preview, and contribution links. Keep detailed operational procedures in linked guides and preserve their discoverability.
- Add bounded repository-setup verification and settings readback. Establish required hosted check identities before enforcing them; report blocked configuration honestly rather than bypassing protections.

## Capabilities

### New Capabilities

None. The repository, distribution, and documentation capabilities already exist.

### Modified Capabilities

- `liftoff-source-repository`: define the single-maintainer contribution model, public community entry points, branch/automation controls, and explicit authority and evidence boundaries for live repository setup.
- `liftoff-npm-distribution`: require GitHub-side publication approval, protected release refs, immutable future GitHub releases, and a credential-free non-publishing verification path, preserving existing npm integration until its separate migration.
- `liftoff-user-documentation`: specify the original visual README, accurate open-source participation and release-status messaging, and portable packaging of linked community documents and assets.

## Impact

- Version-controlled surfaces: `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, new `GOVERNANCE.md` and `SUPPORT.md`, `.github/CODEOWNERS`, issue/PR templates, workflow configuration, static assets under `docs/assets/`, and directly related documentation/package/setup checks.
- Hosted surfaces: repository rulesets and legacy protection migration, Actions settings, the release environment, version-tag controls, and future-release immutability. npm trusted-publisher, publishing-access, account 2FA, and token settings are excluded by the owner's 2026-09-23 scope decision; migration away from npm belongs to a separate change.
- Packaging changes are limited to explicitly including README-linked community documents and original assets; no runtime dependencies, CLI commands, application behavior, or generated-project governance policy changes are intended.
- The research basis is GitHub's official open-source and Actions guidance, Microsoft's community practices, Google's contribution/release guidance, Meta's Docusaurus contribution flow, and the referenced MissionSpec single-maintainer setup. Graft is a visual reference, not a source of copied artwork, branding, prose, or claims.
- Out of scope: application-code violation review, source/history or dependency-license audits, vulnerability remediation, new application scanning gates, dependency refreshes, the application rewrite, cloud infrastructure changes, organization migration, npm account/publisher configuration, distribution migration, package publication, and rewriting existing releases/history.
- Artifact creation grants no permission to commit, push, change branches, mutate hosted settings, install apps, or publish. Implementation must distinguish locally prepared configuration, approved live changes, verified effective controls, and any remaining owner action.
