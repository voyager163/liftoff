# Released baseline characterization

This is **offline source characterization**, not native-platform, installation,
publication, provider, or release qualification.

`corpus-v2/index.json` is pinned by SHA-256
`ccd0fc5ce4122383aeb32ac384f7aa8d9c1de00df56a2d76abfe615c7047b3ab`.
It inventories 21 captures, 448 distinct raw buffers, and 321 source files.
Every source entry records its original path, Git blob ID, SHA-256, length, and
Git mode. Every captured project/private-store file records its original path,
SHA-256, length, and observed mode.

This is a fresh capture from the same immutable releases at a neutral temporary
checkout path, not a rewritten or redacted version of earlier records. The
original `corpus-v1` is preserved locally and ignored because its original
absolute paths identify the developer's checkout. No buffers, roots, nonces or
seals were normalized to produce the publishable corpus.

| Source release | Peeled commit | Captured authority |
| --- | --- | --- |
| `v0.11.2` | `7ae307a0269f31cc4737336b8d445ade336e2ff0` | Original schema-1 update writer without `transactionKind`; v1-to-v2 history serializer |
| `v0.12.2` | `06cb0b065022663e5dafb3a295e14f6a0d221ab7` | Released schema-1 repair writer without a later recipe identity |
| `v0.12.3` | `70d10881b46d873118d825735696f39b6d35ebe0` | Implementation baseline; activation fixture producers/serializers, schema-1 update and schema-2 repair writers |

The tags are annotated. Their tag-object IDs are recorded separately; they are
not substituted for the peeled implementation commits.

## What the goldens prove

- **v1/v2:** exact outputs of the fixture producers present in the baseline
  source, including complete state, plans, evidence, approvals, source metadata,
  OpenSpec/Spec Kit variants, and retained/disposed lifecycle records. These are
  released **test fixtures**, not collected user records or claims that every
  fixture byte was emitted by a production CLI named inside a fixture.
- **Maintained v1:** the baseline's original renderer-backed producer outputs
  for compatibility schemas 2 and 3, including the full core and Claude prompts.
  The helper consumes these buffers instead of reconstructing shortened
  historical text or rendering with the current platform.
- **v3 local:** baseline generation and production state/plan/evidence
  serializers with bounded offline inputs. The evidence is a deliberate local
  failure, not a successful verification. A ready publication phase has a test
  approval but no publication evidence or effects. Its unexecuted saved plan
  requires explicit inclusion in the historical inventory; default admission
  remains blocked.
- **v3 disallowed terminal:** an exact negative output accepted by the generic
  released serializer but contradicting its phase graph (`committed: approved`).
  The current historical reader must reject it without editing its bytes.
- **Ancestry:** the real v1-to-v2 index/finalizer and baseline fixture producer
  supply retained v1 history; the baseline update planner, history finalizer,
  and filesystem transaction supply v3 with v2 and v1 ancestors. Revalidation
  stays pending. The separate `history-v1-to-v2` capture intentionally precedes
  managed-core/manifest reconciliation and is not an admissible complete project.
- **Journals:** real released writers and the released private approval store,
  interrupted after retirement or after commit. Both baseline repair recipes
  are represented. Original roots, nonces, owner PIDs/tokens, frame seals,
  approval IDs, and timestamps remain unchanged.

`blobs/` deduplicates identical buffers; it does not reserialize them. BOM, CRLF,
invalid UTF-8/arbitrary binary data, and executable/read-only mode observations
are preserved. Git cannot retain every POSIX permission bit, so materialization
explicitly restores the inventoried modes rather than trusting checkout modes.

## Static refusal versus same-root recovery

Static journals retain their original absolute project/private-store identities.
Tests copy their **unchanged bytes** only to prove foreign-root refusal. They do
not rewrite roots, reseal journals, install captured owner locks, or attempt
recovery against those historical absolute paths.

Positive tests materialize the hash-verified released source closure in a
private checkout-local fixture. A subprocess runs that actual writer and stops
at an original checkpoint. Current readers inspect its original journal and
external seals at the **same project root**. Recovery first refuses the existing
owner lock. The test owner then confirms its own subprocess exited, the PID is
absent, and the lock's bytes/device/inode/mode/UID/GID still match before removing
only that exact fixture-owned stale lock. No journal or approval is changed.
This models explicit stale-owner review, not automatic CLI lock reclamation.

Recovery verifies exact rollback or committed effects and original modes;
unknown identities, future schemas, missing checkpoint seals, foreign roots,
wrong transaction paths, and concurrent edits remain protected. A concurrent
edit can leave bounded rollback incomplete while other attributable effects
are restored; the original journal and seals remain for that outcome.

## Reproduction

With the existing project dependencies and local release objects available:

```sh
node tests/fixtures/released-baseline/capture.mjs tests/.released-baseline-new-capture
npm test -- --maxWorkers=2 tests/characterization-baseline.test.ts tests/released-baseline-journals.test.ts
```

Use a neutral temporary checkout path outside personal home directories for
captures intended for publication, then copy the resulting corpus without
changing its buffers. Inspect the complete corpus for personal paths before
publishing it. Keep earlier captures unchanged and local.

The capture destination must be new. Capture uses `git archive`, verifies the
peeled commits and source blob IDs, and transforms exact archived TypeScript in
memory with the already-installed `rolldown/utils`. It does not create Git
worktrees, install dependencies, invoke providers, or publish anything.
Regeneration has new absolute roots, UUIDs, and owner identities; **never
normalize or rewrite new outputs to imitate an earlier capture**.

The manifest v2-v7 inventory remains separately owned by
`../manifest-history-index.json` and `tests/manifest-history-migration.test.ts`;
this corpus neither replaces nor rewrites those fixtures.
