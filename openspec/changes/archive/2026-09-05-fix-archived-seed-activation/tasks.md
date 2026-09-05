## 1. Archived baseline execution and recovery

- [x] 1.1 Reproduce external archival before activation with real OpenSpec, then drive the exact generated-skill commands through all three seed phases to the publication approval gate.
- [x] 1.2 Select lifecycle-aware strict validation while retaining every applicable local check and archive-integrity guard; verify active and archived command matrices.
- [x] 1.3 Make archived `seed-verified` failures retryable, including a legacy persisted blocker; verify failure, repair, read-only resume, and successful execution without fabricated evidence or duplicate archives.

## 2. Diagnostic contract

- [x] 2.1 Add selected/executed phase fields and update generated guidance without changing legacy apply-next field meaning; verify success, preview, and failure output.
- [x] 2.2 Include bounded sanitized OpenSpec diagnostics; verify stderr/stdout, control removal, truncation, and credential suppression before persistence.

## 3. Validation and documentation

- [x] 3.1 Update developer and governance documentation for archived recovery and phase semantics; verify the documentation contract.
- [x] 3.2 Use portable project paths including spaces and confirm regression coverage is included in the existing Windows/macOS/Linux CI matrix without publishing changes.
- [x] 3.3 Run the targeted existing governance suites, TypeScript build, and strict OpenSpec change validation; leave the implementation uncommitted and unreleased.

## 4. Additional setup entry points

- [x] 4.1 Exercise a fresh active seed through validation, baseline, archive, and the publication approval gate using the new build and add a durable regression.
- [x] 4.2 Exercise an existing project with `seed-valid` completed, prove its prior evidence is preserved and not executed twice, and run the remaining baseline/archive phases using the new build.
- [x] 4.3 Report ordinary pre-archive seed progress as consistent but incomplete, while retaining failures for missing artifacts, overlapping seeds, or state already claiming archive completion.
