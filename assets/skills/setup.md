Before project access, run `liftoff capabilities --json`.
Require `schemaVersion: 1`, `kind: liftoff-capabilities`, `cliVersion`;
check `commands` name/subcommands/flags and `schemas.reports`: governance 2,
update 3 or update 4. Update 4 additionally requires `schemas.currentUpdate`
with report 4, manifestWrite 8, separateConsent and explicitRecovery.
Missing/malformed/incompatible support: STOP. Use `liftoff --help` for supported
upgrade guidance. Upgrade needs separate permission and fresh negotiation.
Never emulate commands or fabricate plans/receipts/approvals/evidence.
Execution also needs the applicable phase's `productionExecutorAvailable: true`,
no blocker, actual readiness and independent approval. Before repair, negotiate
its dedicated capabilities/recipes through the separate native repair protocol.

Current update 4 preserves configuration, original history and recorded workflow,
agents, profile and compatible layout. Check is an external preview, not approval.
Apply needs its exact fingerprint; force has a separately eligible fingerprint.
Pending update recovery needs `update <project> --recover --approve-plan <saved-fingerprint>`;
never substitute repair/governance recovery or silently reap a lock.
Preserve `publicationCommitted` and uncertain effects even on failure.
Committed-incomplete is not rollback or local completion.

For v8 projects, do not execute the historical phase sequence below.
Use advertised schema-3 modern status/resume/verify inspection first.
Negotiate `schemas.modernLocalVerification`, `schemas.modernLocalCompletion`
and `schemas.modernSuccessorRevalidation` separately for the requested operation.
Consult the installed command help for exact selectors and closed request/consent
shapes; keep inputs outside the project and obtain separate verification,
finalization and exact-byte publication consent. Existing activation-history
successors require their successor-revalidation route, not fresh completion.
No admitted operation means STOP and report the boundary; never turn a recorded
phase, native receipt or `operationComplete` into `localComplete`.
OpenSpec finalization, provider execution and workflow/profile transitions are
not granted by core-update approval. Do not manufacture their missing support.

For supported historical projects only:

Use the Liftoff governance engine; read `.liftoff/governance/README.md`, `policy.md`, `context.json`.

1. Start `liftoff governance status --scope local --json`;
   Unscoped governance defaults to activation: `liftoff governance status --json`.
   Preserve schema-2 `nextActions`: `command.executable`, `command.args`, `cwd`, `scope`, `approvalRequired`.
   `nextReadyPhase` is post-operation readiness, not `nextPlannablePhase`.
   Scopes: `localSetup`, `migration`, `activation`, `lifecycle`.
2. Local baseline verification is not an OpenSpec feature change.
   Use separate native repair (liftoff-repair); no direct edits.
   Preview `liftoff repair --check --json`.
   Ordinary check makes no cloud calls. Explicit live:
   `liftoff repair --check --live --subscription <UUID> --json`.
   Normally use `liftoff repair`: exact immutable plan, then Yes/No, default No.
   No/Ctrl-C/EOF blocks unapproved writes; report prior verification effects.
   JSON/nonTTY bare previews only. No copied hashes or piped approval.
   Verification/network/file consent stays separate.
   Then `liftoff update --check --json`; update approval is separate.
   Resume: `liftoff governance resume --scope local --json`.
   Same project; positional repair path. Recover: `liftoff repair --recover`.
   Agent installation and the public stateful migration coordinator are not implemented.
   Blocked stays plan-only.
3. Preview `liftoff governance plan --scope local --json` and `liftoff governance apply-next --scope local --json`.
   `selectedPhase` is attempted; `executedPhase` succeeded.
   Only for a reported ready, approval-free local action:
   `liftoff governance apply-next --scope local --json --execute`.
   Plan saves a disclosed external preview, not approval.
   Apply-next without `--execute` is strictly read-only.
4. Honor a local-only request or declined later authority; else
   `liftoff governance plan --scope activation --json`
   with `--inputs <public-json-file>` if requested.
   Never automatically approve a plan. With consent:
   `liftoff governance approve --plan <fingerprint>`; approval does not execute.
5. Credential enrollment is currently unavailable pending independently verified
   provider wiring; approve/apply-next refuse unavailable capabilities.
   Never accept credentials in chat.
6. Verify `liftoff governance verify --scope local --json` or
   `liftoff governance verify --scope activation --json` (`liftoff governance verify --json`).
   Exit 0 is complete; exit 2 means consistent but
   incomplete (indeterminate readiness).
   Full completion: actual deployment, matching live enforcement and readback;
   deferred retention is not failed activation (future lifecycle work).
7. Do not repeat an unchanged failure. Approved recovery:
   `liftoff governance recover --plan <fingerprint> --execute`.
