import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { getCanonicalSkill } from '../../adapters/packaged-assets/skill-assets.js';
import { renderRetainedProjectSkill, renderRetainedProjectSkillHeader } from '../../adapters/skills/host-projections.js';
import type { CodingAgentId, ProjectPlan } from '../../domain/project/contracts.js';
import { activationContractVersion, liftoffActivationPackageVersion } from '../../domain/governance/policy/identity.js';
import { runnerPreflightDisplayNameTemplate, runnerPreflightSecretName } from '../../domain/governance/activation/types.js';
import { governancePolicyVersion } from '../../domain/governance/policy/content-validation.js';

export function governanceInvocationGuide(
  plan: Pick<ProjectPlan, 'agents'>,
  operation: 'setup' | 'assessment' | 'repair' = 'setup'
): string {
  if (plan.agents.length === 0) {
    const name = operation === 'assessment' ? 'liftoff-governance-assess' : `liftoff-${operation}`;
    return `No native \`${name}\` integration is recorded.`;
  }
  return plan.agents.map((agent) =>
    `${agent.label}: \`${governanceAgentIntegrations[agent.id][operation].invocation}\``
  ).join('; ');
}

export function renderGovernanceGuide(plan: ProjectPlan): string {
  const launchers = plan.agents.map((agent) =>
    `- ${agent.label}: \`${governanceAgentIntegrations[agent.id].setup.invocation}\`.`
  ).join('\n');
  const primaryAgent = plan.agents.find((agent) => agent.id === plan.defaultAgent?.id) ?? plan.agents[0];
  const primary = primaryAgent ? governanceAgentIntegrations[primaryAgent.id] : undefined;
  const nextAction = primary ? `## Next action after init

From this project, enter the native setup invocation in a selected coding agent,
not in a shell. There is no \`liftoff setup\` CLI command. \`liftoff init\` creates a
new scaffold; do not reinitialize an existing Liftoff application to repair it.

\`\`\`text
${primary.setup.invocation}
\`\`\`

Use the generated setup integration from any selected agent:

${launchers}` : `## Legacy project handoff

No native setup integration is recorded for this legacy project. This managed-core
update does not initialize the framework or install coding-agent integrations.
Inspect the current local boundary without executing setup:

\`\`\`bash
liftoff governance status --scope local --json
\`\`\`

Review the CLI's supported diagnostics and separately approved framework adoption
requirements. The journey below applies only after the required framework and
native integration are established; no agent or prior completion is inferred.`;
  return `# Liftoff deterministic setup

State: **${primary ? 'managed setup generated' : 'managed handoff generated; no native integration recorded'}; live enforcement is not active**.

Liftoff generated deterministic policy and workload context only. It did not
create or change branches, commits, tags, remotes, pull requests, releases,
rulesets, GitHub settings, security features, environments, runners, cloud
resources, deployments, monitoring, alerts, or Slack routes.

${nextAction}

## Separate native repair

${governanceInvocationGuide(plan, 'repair')}

Use the repair integration for actual application-layout review, not setup or
assessment as an alias. It negotiates \`liftoff repair --capabilities --json\`
before project access. Missing contract/recipe/mode support requires an explicit
\`liftoff upgrade --check --json\` remedy, not agent-emulated project writes.
The integration inventories actual custom source and current target artifact
identities, imports/module paths, build/tests, Docker/Compose contexts, scripts,
CI and documentation. Exact replacements and the strict patch document stay in
external staging until CLI preview, independently approved staged verification
(network separately authorized), and separate exact file approval. Staging is
not an OS or network sandbox: trusted project code can affect the host and access
the network. Declaring \`network: false\` is not proof scripts cannot access the
network. Review those effects before consent. Unknown mappings stay plan-only.
Unsupported mandatory isolation blocks verification; trust is not a substitute
for required OS or network isolation.
The application-patch transaction preserves private rollback material, original
manifest/provenance, activation proof and immutable history.
That restriction does not remove the deterministic Azure recipe's separately
registered, reviewed manifest/history writes.
Missing verification tools or dependencies are explicit blockers. Only registered
locked preparation (\`npm-ci\`, \`uv-locked-sync\`, \`go-mod-download\`) is available
under separate exact approval. Go test/vet may download modules; declare and
separately approve those network effects. Never infer installation, live
dependency-tree copying or lock-regeneration authority from verification consent.
Generic repair requests, unrelated approval,
autopilot and agent-generated Yes do not supply action consent.
Repair works with governance disabled without creating governance artifacts or
activation state; its managed hash is not a separate release identity.

## What setup does

\`liftoff-setup\` delegates every transition to the Liftoff CLI, beginning with
\`liftoff capabilities --json\` before project access. For the selected project,
continue with \`liftoff governance status --scope local --json\`. The CLI resolves
the project root, loads \`phase-graph.json\`, validates policy ${governancePolicyVersion},
and uses activation contract ${activationContractVersion} from package
${liftoffActivationPackageVersion}. Native integration changes use managed content
hashes, not an independent version.

Prefer the CLI's supported \`nextActions\`: preserve each \`command.executable\`,
argument array, \`cwd\`, \`project\`, \`scope\`, \`configPath\`, \`configDigest\`,
compatibility identity and required authority. Never drop \`--inputs\` or reinterpret
a relative input from a different working directory. A
\`nextPlannablePhase\` can be previewed before approval; execution uses only a
currently ready action with its required authority. Never invent flags or edit
approval/state JSON.
Unscoped governance commands default to activation; local inspection, execution,
and verification must retain \`--scope local\`. Supported scopes are \`local\`,
\`repository\`, \`activation\`, and \`lifecycle\`. Repository-only completion requires
explicit selection and never satisfies cloud, production or retained-state obligations.
\`governance plan\` saves a disclosed external preview, not approval, and does not
execute its proposed effects. \`apply-next\` without \`--execute\` is strictly
read-only. When public planning inputs are requested, follow the reported
\`--inputs <public-json-file>\` action and its documented public schema; never
put credentials or invented approval/state records in that file.
${plan.agents.some((agent) => agent.id === 'codex')
  ? 'Codex skills use their dollar-prefixed names or the `/skills` picker, not global custom prompts.\n'
  : ''}

Before publication and activation, setup verifies the deterministic baseline seed:
\`liftoff validate\`, applicable backend tests, frontend build,
\`docker compose config -q\`, \`tofu fmt -check -recursive\`,
\`tofu init -backend=false\`, \`tofu validate\`, and strict ${plan.specWorkflow.label}
checks. Missing project boundaries are recorded as inapplicable, not successful.
The seed's completion means the applicable local checks passed and the
${plan.specWorkflow.id === 'openspec'
    ? 'OpenSpec bootstrap seed was synchronized and archived.'
    : 'real Spec Kit bundle at `specs/000-liftoff-bootstrap/` was finalized locally, without an OpenSpec archive or new Git branch.'}
It does not mean product behavior, infrastructure, or enforcement exists.
Local-ready is a milestone, not the end of a requested full journey. After local
verification, present \`liftoff governance plan --scope activation --json\` and
continue only through separately approved actions. A local-only request or
declined later authority preserves local completion without publication or
provider effects.
An older Spec Kit project without that bundle needs separately reviewed seed
adoption; update, force, and assessment never create it or infer completion.
If infrastructure conformance blocks **Local baseline verification**, this is
not an OpenSpec feature change. Before retrying the blocked check, negotiate
\`liftoff repair --capabilities --json\`, then run \`liftoff repair --check --json\`
from this project.
Ordinary check makes no cloud calls. Only when explicitly authorized, use
\`liftoff repair --check --live --subscription <UUID> --json\` for bounded
metadata discovery with existing authentication. The supported local recipe
preserves legacy flat-root OpenTofu semantics while creating the shared
application module and selected independent environment roots. It requires
authoritatively absent resource groups in that subscription and absent local
state/backend metadata; missing state files alone do not prove safety.
Metadata discovery is bounded to 120 seconds overall, 30 seconds per command,
and at most 24 resource groups. Approved repair checks a compatible stable
OpenTofu release line, then runs \`tofu fmt -check -recursive\` on the whole staged
Azure root. Each selected staged environment runs
\`tofu init -backend=false -input=false -lockfile=readonly -no-color\`, then
\`tofu validate -json\`. These checks never initialize the original backend.
For normal human execution, use \`liftoff repair\` with genuine input and stderr TTYs.
It displays the exact immutable plan, then asks action-specific Yes/No with
default No. Explicit Yes authorizes only that displayed plan's internal
fingerprint; humans do not copy or enter approval hashes.
Retain separately approved \`--live --subscription <UUID>\` options in the
interactive infrastructure invocation when metadata discovery is needed.
For an externally staged application patch, use
\`liftoff repair --application-patch <external-patch.json>\`: verification,
declared network effects, and exact local file writes have separate prompts.
No/Ctrl-C/EOF declines the current action without unapproved project writes.
Previously approved verification may already have caused its disclosed host
effects. If verification ran before file-prompt cancellation, report those
executed checks and observed effects separately from no file transaction committed;
never say nothing happened. Changed inputs after a prompt still refuse stale
approval and require fresh review. Never use generic yes flags or piped answers as authority.
Agents using optional JSON automation must obtain independent user approval for
each displayed scope before using returned \`--verify-plan\` or \`--approve-plan\`
fingerprints internally; this is not the primary human path.
Then run \`liftoff update --check --json\`, review any separate update plan, and
inspect \`liftoff governance status --scope local --json\`,
\`liftoff governance verify --scope local --json\`, and
\`liftoff governance resume --scope local --json\` before the next local plan
and its ready apply action. These reads do not run project scripts or advance proof.
Keep the same project target in every command; repair accepts a positional
project path. \`--check\` stays read-only. JSON/nonTTY bare repair previews only,
never prompts, consumes piped approval, or hangs waiting for input. Execution in
JSON/nonTTY requires exact explicit execution flags and their independent consent.
Interrupted repair uses \`liftoff repair --recover\` for this project, not update
recovery. Repair does not support \`--force\`, \`--yes\`, or \`--add-agents\`.
Agent installation and the public stateful migration coordinator are not
implemented. An existing internal stateful engine is not an executable public
command. Deployed, unknown, or unsupported transformations stay plan-only with
their source and state untouched; report the limitation without inventing commands.

Questions are limited to exact repair/migration plans, state-read authority,
independent tool/dependency/global-profile permissions, repository publication,
credentials, billed resources or policy exceptions, final enforcement,
destructive recovery/cleanup, and external blockers.
Use the CLI-provided repair preview and eligibility actions, never a fresh
starter copied over the project or fabricated machine metadata. Local repair
approval does not authorize sensitive-state reads, backend writes, or resources.
Never recommend manual state moves to bypass a repair blocker.
Unknown or unsupported transformations stay plan-only.
Only explicit execution retries repaired local failures; status,
resume, and verify remain read-only. Current unchanged proof may be reused.
Do not repeat an unchanged failure or ineffective installer. Actual missing
capabilities, permissions, quota, or execution paths remain resumable blockers.

Schema-3 results distinguish \`scope\`, local completion, repository enforcement, \`activation\`,
\`migration\`, and \`lifecycle\`. Verification exits 0 for a consistent complete
selected scope, 2 for consistent incomplete progress, and 1 for inconsistency or
inspection failure. Status, plan, and resume can exit 0 while work remains.
\`selectedPhase\` identifies the attempt; \`executedPhase\` records success;
\`nextReadyPhase\` comes from post-operation inspection. If an operation committed
but inspection failed, retain that partial outcome and indeterminate readiness.
Use only the reported reviewed recovery action, never a blind retry or assumed
rollback of remote effects.

For an older supported activation, use \`liftoff update --check\` to review the
exact history-preserving migration. The check changes no project bytes but
discloses an external preview receipt. Explicitly approved update creates a
linked v${activationContractVersion} successor from a declared v1/v2/v3 source. Old state, plans,
evidence, and approvals remain historical, not current authorization.
Failed local revalidation retains blocked, resumable
v${activationContractVersion}. Repair the named cause and approve a fresh preview rather than reset history.
Only the named local revalidation is automatic; no provider, commit, or push is
authorized by the migration plan. \`--json\` is optional formatting, and CI
approval uses \`--approve-plan <fingerprint>\`. Force cannot bypass these gates.

Runner-preflight credentials are deterministic. Setup first prefers an existing
verified selected-repository GitHub App with the required read permissions. If a
fine-grained PAT is required, use display name
\`${runnerPreflightDisplayNameTemplate}\`, secret
\`${runnerPreflightSecretName}\`, 30-day lifetime, current repository only,
repository metadata read, organization hosted-runner and network-configuration
read, no writes, and the recorded workflow/job allowlist.
Use the CLI-provided \`liftoff governance approve --plan <fingerprint>\` only
after the developer explicitly approves the exact displayed plan; never
automatically approve it. Approval persists authority but does not execute.
Credential enrollment uses \`liftoff governance credential-enroll --plan <fingerprint>\`
through the private operator channel. Automation must explicitly select
\`--protected-stdin\` and supply the value through an operator-controlled protected
channel, never chat or argv. Observe actual permitted use/readback,
not just a secret name. Never paste or show a credential in chat, argv,
command arguments, logs, evidence, source files, or screenshots. A leaked value must be
revoked and rotated through its owner-controlled system, not fabricated state.

Live status must be proven from user-owned activation evidence and GitHub
read-back, never inferred from these local files.
Full immediate setup is complete only when requested migration and actual
deployment, qualification, and matching live enforcement are verified.
Future retained-state disposal and other \`lifecycle\` obligations stay visible
separately; activation does not wait for a retention deadline.

${renderGovernanceAssessmentGuide(plan)}
`;
}

export function renderGovernanceAssessmentGuide(plan?: Pick<ProjectPlan, 'agents'>): string {
  const setup = plan ? governanceInvocationGuide(plan) : 'Copilot/Claude: `/liftoff-setup`; Codex: `$liftoff-setup`';
  const assessment = plan ? governanceInvocationGuide(plan, 'assessment') : 'Copilot/Claude: `/liftoff-governance-assess`; Codex: `$liftoff-governance-assess`';
  const repair = plan ? governanceInvocationGuide(plan, 'repair') : 'Copilot/Claude: `/liftoff-repair`; Codex: `$liftoff-repair`';
  const entryPoint = plan?.agents.length === 0
    ? `No native setup or assessment integration is recorded for this legacy project.
Managed-core maintenance does not initialize the framework or install integrations.
For a read-only comparison, use the CLI directly:`
    : `Native setup (${setup}) remains the primary post-init path. For a separate
comparison, use ${assessment}, or run:`;
  return `## Read-only governance assessment

${entryPoint}

\`\`\`bash
liftoff governance assess --json
\`\`\`

The pinned target is the installed CLI's packaged policy, activation identity,
phase graph, and assessment control catalog, never registry latest. The report
separates that target from the recorded baseline, declared project configuration,
and observed enforcement. It includes expected and observed values, provenance,
scope, impact, and ownership-aware advisory remediation.
The project policy version is shown when available. JSON observations may also
retain optional normalized \`facts\` alongside evaluator predicate values;
these are sanitized details, not raw provider payloads.

The default is local-only with no network access or cloud/GitHub credentials.
It works in any Git repository without initialization, a Liftoff manifest, or
generated agent wrappers, including before the first commit. The installed
single-maintainer policy is the explicit target; absent Liftoff identity and
baseline are missing proof, not an opt-out. An invalid or retired inner manifest
blocks fallback to an outer repository. It does not run the bootstrap baseline
or install wrappers. All assessment invocations, including live mode and help, skip
telemetry and disclosure entirely. Local Git reads inspect only repository
root, HEAD, and origin metadata, never \`git status\`, which can execute clean
filters. Only after an explicit request for live reads, use:

\`\`\`bash
liftoff governance assess --live --json
\`\`\`

Live mode permits bounded read-only GitHub/Azure metadata access using existing
permissions and verified repository/environment/resource bindings. No login,
credential enrollment, permission expansion, provider registration, state-blob
access, or resource mutation is authorized. Missing access, unknown applicability,
stale evidence, and unsupported evaluators remain visible coverage gaps, not
proof of absence or alignment.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts that bind their canonical
payload and readback body to current inputs. Placeholder digests, historical v1/v2/v3
receipts, future-dated approvals, and inferred bindings cannot establish proof. Missing
bindings stay \`not-observed\`; do not fabricate or hand-edit activation state,
baselines, receipts, or evidence to make assessment pass. Collect missing proof
through separately approved setup or governance work.

| Finding | Meaning |
| --- | --- |
| \`aligned\` | Every required proof layer is fresh and matches the target |
| \`outdated\` | A recognized older baseline or recorded managed artifact differs |
| \`missing\` | Complete authoritative observation proves an applicable requirement absent |
| \`conflicting\` | Known settings contradict the target or another observed layer |
| \`approved-exception\` | An exact, valid, unexpired permitted exception covers a difference |
| \`inapplicable\` | Validated workload facts prove a control does not apply |
| \`not-observed\` | Applicability or required proof is unknown, stale, denied, or unsupported |

Coverage distinguishes local matches from unobserved live proof; a matching
workflow file is not proof of enforcement. Provider access failures do not erase
independently observed local or other-resource findings. Unsupported controls
stay visible rather than being removed to produce a green result.
Local-only reports will normally be
\`partial\`. Exit 0 means fully observed \`aligned\` or explicitly disabled
\`not-applicable\` governance (not an alignment claim); exit 2 means \`partial\`
coverage or \`differences\`, including approved exceptions; exit 1 means \`error\`.
Exit 2 is advisory, not permission to repair anything.

Assessment writes reports to stdout only. It never updates or upgrades anything,
changes project files, Git, activation state, approvals, or evidence, or runs
recommendations. Reports cannot complete Phase 0 or any other phase.
For layout concerns, explain the separate native repair journey (${repair}).
Do not invoke it from assessment. Actual application inventory, external staged
patches, independent verification consent and separate exact file approval belong
to that journey; an assessment recommendation authorizes none of them.
For compatible older inventories, restore an already selected Liftoff integration
through \`liftoff update --check\`, then \`liftoff update\` with explicit approval
of the matching plan. Check discloses its external preview receipt; it is not approval.
Adding another agent or changing the framework default is not implemented by the
public repair coordinator; ordinary update does not install framework integrations.
Report this limitation without recommending an unsupported repair command.
Unowned collisions stay unowned even with \`--force\`; modified managed entries
retain the existing reviewed force rules. Neither installation nor assessment
activates governance. Unsupported mappings remain diagnostic: no migration is
available unless explicitly supported, and force cannot bypass compatibility
or overwrite project-owned configuration. A future governance upgrade needs
fresh observations, its own reviewed plan, and separate approval.
`;
}

export function nativeIntegrationHeader(agent: CodingAgentId, operation: 'setup' | 'assessment' | 'repair'): string {
  const id = operation === 'assessment' ? 'governance-assess' : operation;
  return renderRetainedProjectSkillHeader(getCanonicalSkill(id), agent);
}

export function renderRepairIntegration(agent: CodingAgentId): string {
  return renderRetainedProjectSkill(getCanonicalSkill('repair'), agent);
}

export function renderSetupIntegration(agent: CodingAgentId): string {
  return renderRetainedProjectSkill(getCanonicalSkill('setup'), agent);
}

export function renderAssessmentIntegration(agent: CodingAgentId): string {
  return renderRetainedProjectSkill(getCanonicalSkill('governance-assess'), agent);
}
