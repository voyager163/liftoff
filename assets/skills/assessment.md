Explain the whole-project assessment, not an installation, repair, adoption or
workflow change. A supplied report is evidence to explain, never write approval.
If the developer asks only to explain a supplied report, validate its format and
explain its own recorded target and limits without project or provider access.

Before collecting a new report, run `liftoff capabilities --json`, independently
of the project. Require `schemaVersion: 1`, `kind: liftoff-capabilities`,
`cliVersion`, `schemas.reports.projectAssessment: 1` and
`schemas.projectAssessment` with `command: assess`, `report: 1`,
`readOnly: true` and `modes` containing `local`. Require
`projectExecution: false`, `projectWrites: false`, `credentialEnrollment: false`
and `telemetry: false`. A version number or a registered command alone does not
establish producer support. Missing, malformed or incompatible capabilities:
STOP; use project-independent `liftoff --help` and `liftoff --version` to explain
the mismatch. An installation change needs separate permission and fresh
negotiation. Never manufacture a command, report, receipt or compatibility flag.

1. Preserve the exact selected project directory. Use an explicit project root
   for non-Git applications. Never initialize, copy, move or choose an outer
   project to bypass a missing, malformed, retired, linked or ambiguous inner
   boundary. Do not infer application bindings from starter folder names.
2. Collect only `liftoff assess --project <project> --json`, using separate
   executable/argument values or CLI-native shell rendering for paths.
   Comparison is against the installed release, not registry latest. An explicit
   `--governance <profile>` is an advisory comparison, not a project profile
   change; use only an advertised comparison profile the developer requested.
3. Local collection performs no project script, package manager, framework,
   Git execution, network, enrollment, disclosure, receipt or project write.
   Do not supplement its bounded inventory by opening excluded credentials,
   state, caches, private payloads, links or nested projects, or executing code.
4. Use `--live` only after an explicit request for scoped metadata reads and
   compatible capabilities: `modes` contains `live`, `liveMetadata: true`, and
   `liveProviders`/`liveScope` cover the actual request. Current GitHub support
   does not authorize Azure, account or runner discovery. Preserve existing
   permissions and the verified repository binding; do not enroll credentials,
   change remotes, broaden access or work around a refusal. A requested no-ref
   scope can remain stable without proving provider absence or conformance.
5. Require schema 1, `kind: liftoff-project-assessment`, `command: assess`,
   `readOnly: true`, the actual mode, target, snapshot, findings, coverage,
   diagnostics and outcome. Explain the selected root and recorded manifest/
   profile separately from the installed comparison target, plugins and layout.
   Preserve IDs, expected/observed values, availability, provenance, facts,
   applicability, support and classifications exactly. Unknown, not-observed,
   approved-exception or incomplete coverage is never full alignment. A metadata
   observation is not a supported evaluator, reference proof or activation.
6. Explain exit 0 as complete applicable alignment or explicitly inapplicable
   requested scope, exit 2 as differences or incomplete coverage, and exit 1 as
   invalid input or inability to produce a trustworthy report. Inputs stable
   means only the recorded reobservation scope was unchanged, not an atomic
   filesystem/provider snapshot. Preserve known differences in partial reports.
   Denied, masked, paginated, unsupported or missing evidence must stay distinct.
7. Explain the reported remediation lanes without executing them:
   managed update changes only its reviewed managed metadata/integrations;
   application repair needs independent mapping, staged checks and file approval;
   adoption is a separate in-place operation, not initialization or sibling
   `migrate`; workflow/profile/plugin changes have separate authorities;
   new-environment activation is not existing-deployment/state migration.
   Preserve each finding's `remediation.available`, `previewCommand` argument
   array and `separateConsent`, with the exact reported project target. Do not
   invent executable, cwd, approval or effect fields absent from this schema.
   Null, unavailable or unadvertised recommendations are blockers, never invented
   `adopt`, `workflow set`, state-import, shell setup or force-update instructions.
   Preserve compatible custom layouts and original generation/adoption history.
8. Stop after explaining evidence, limits and separately reviewed next options.
   Do not stage a patch, run checks, install tools, upgrade, update, repair,
   migrate, commit, push, activate, change Git/GitHub/Azure, publish state,
   manufacture proof or edit any project file. A later requested action must
   negotiate its own actual capability, consent, execution and recovery contract.

The existing `liftoff governance assess --json` is a narrower governance report,
not a whole-project replacement and not this report schema's producer.
Agent hosts and models do not change any permission boundary. CLI-only users can
run the same negotiated assessment and read its JSON/text without an agent or
external specification framework; never install one merely to assess a project.
