## Context

See `proposal.md` for the approved scope. These fixes are deliberately separate
from the assessment implementation and from the larger capability gaps found
by the whole-CLI audit.

## Goals / Non-Goals

**Goals:**
- Fail release verification before publishing inconsistent or noncanonical
  package metadata.
- Produce usable project-aware helper recipes without executing them.
- Keep diagnostic authority and time bounds explicit.
- Make preservation and infrastructure guidance describe actual guarantees.

**Non-Goals:**
- Complete activation adapters, GenAI orchestration, Function deployment,
  production infrastructure, or the historical migration engine.
- Redesign configured-registry delivery into canonical tarball verification.
- Expand dependency setup into a full project-tree sandbox or rollback system.
- Refactor the entire CLI while preparing the patch.

## Decisions

### Canonical release checks precede side effects

Reuse the package identity constant and existing SemVer utilities. Comparing
package and lock metadata to one another is necessary but insufficient: all
three could contain the same wrong name. Limit the legacy version-command
exception to the historical `0.3.3` target before installation or publication
verification begins.

### Derive helper context from the project

For a known API project, render OpenTofu commands against its actual generated
module using host-safe path resolution and command formatting. Select the first
declared environment when no override is supplied, and reject an override absent
from that project's environment set. Keep helper commands printed-only and
preserve existing outside-project and Power Apps behavior.

### Bound probes without changing authority

Keep canonical doctor release lookup fixed to canonical npm; test injection
remains available. Use finite timeouts for real subprocess probes and report
timeouts as unavailable/failed observations rather than waiting indefinitely.
Do not change configured registry delivery preferences or install tools.

### Narrow claims instead of inventing rollback

Dependency setup protects particular metadata, not every file a lifecycle
script can touch. State that boundary in failure output and direct the user
to review other changes. Generated infrastructure guidance must distinguish
reference commands from authorized execution and must not pretend unavailable
production adapters are implemented.

### Preserve identity and planning integrity

Complete the generated OpenSpec migration artifact set rather than weakening
strict validation or silently skipping its missing deltas. Describe adoption of
existing source without inventing domain-specific application behavior.

Treat project name, cloud, and region changes as migration-only until a
reviewed migration exists; ordinary managed update must not rewrite metadata
while leaving all corresponding project-owned files on the old identity.
Likewise, an existing activation state prevents update from recording governance
as disabled. No deactivation implementation or proof is invented in this patch.

## Risks / Trade-offs

- Existing helper snapshots change because the directory/environment was
  previously implicit: verify project, nested-path, spaces, and selected-env
  cases on supported hosts.
- Stricter release checks may reject formerly accepted metadata: this is the
  intended pre-publication failure boundary.
- Broader audit findings remain: document them as separate follow-up work and
  do not advertise the patch as making every generated application production
  complete.
- Filesystem TOCTOU hardening and shared mutation locking remain a separate
  infrastructure change, not an improvised path reset in this patch.
