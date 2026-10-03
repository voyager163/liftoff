Before project access, run `liftoff capabilities --json`.
Require `schemaVersion: 1`, `kind: liftoff-capabilities`, `cliVersion`;
check `commands` name/subcommands/flags and `schemas.reports`: governance 2, update 3.
Missing/malformed/incompatible support: STOP. Use `liftoff --help` for supported
upgrade guidance. Upgrade needs separate permission and fresh negotiation.
Never emulate commands or fabricate plans/receipts/approvals/evidence.
Execution also needs the applicable phase's `productionExecutorAvailable: true`,
no blocker, actual readiness and independent approval. Before repair, negotiate
its dedicated capabilities/recipes through the separate native repair protocol.

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
