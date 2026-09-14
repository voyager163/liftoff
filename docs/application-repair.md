# Reviewed application-file repair

`application-layout-patch` version 1 moves or edits explicitly identified existing
application files. It is **not** a historical-layout detector, a recursive folder
mover, or permission to replace customized source with generated starters. The
recorded manifest workload selects the current target identities; this lane
cannot change the stack, manifest, desired configuration, framework, or activation
proof.
These application-patch restrictions do not remove the deterministic Azure
recipe's separately registered, reviewed manifest and history writes.

## Normal interactive flow

1. `liftoff repair <project> --inspect-layout --json` inventories the actual
   bounded project and current generated target identities.
2. Author a patch document and replacement files in a dedicated directory
   **outside** the project. The two directories must be disjoint, not ancestors
   of one another.
3. Run `liftoff repair <project> --application-patch <external-patch.json>` in an
   interactive terminal with genuine input and stderr TTY streams, without JSON
   output. It first displays the exact immutable plan. Review the
   staged project-code commands and their host effects, then answer the separate
   action-specific verification question. If the commands declare network
   effects, a distinct network-consent question is required too.
4. After successful, fresh matching verification, review the exact file effects
   and answer the separate file-write question. Each question is Yes/No with
   **default No**. Only explicit Yes authorizes that displayed action; the CLI
   uses the displayed plan's internal fingerprint, without asking a human to copy
   `--verify-plan` or `--approve-plan` hashes. File approval does **not** grant
   project-code or network authority.

No, Ctrl-C, or EOF never grants authority and leaves repair's project-file
transaction unapplied. If the later file-write question is canceled after
separately approved verification, report **verification already ran, with its
actual check results, and no file transaction committed**. Do not report
"nothing happened." Earlier script/host/external effects are not undone or
comprehensively audited by declining the file transaction.

For a read-only review, use
`liftoff repair <project> --check --application-patch <external-patch.json> --json`.
`--check` remains read-only. Bare JSON/non-TTY invocations preview only and never
wait for interactive input. JSON/non-TTY execution requires an exact explicit
`--verify-plan` or `--approve-plan` request; `--allow-network` alone is not
execution authority. Genuine input and stderr TTY detection, not piped answers
or a synthetic interactive assertion, is required for bare prompts.
Bare interactive repair previews first and may
execute only after the relevant action-specific explicit Yes. Never supply
generic `--yes` or piped answers as authority.

### Optional automation

Fingerprints remain available for automation/backward compatibility, not as the
primary human workflow:

- `liftoff repair <project> --verify-plan <fingerprint>` authorizes only the exact
  staged verification; declared network effects additionally need
  `--allow-network`.
- `liftoff repair <project> --approve-plan <fingerprint>` authorizes only the exact
  file transaction after fresh matching successful verification.

A native repair agent should guide humans through the normal interactive flow.
Before using either optional automation command on the user's behalf, the agent
must independently obtain explicit user approval for the exact displayed action,
including separate project-code, declared-network, and file-write consent. A
generic repair request, prior unrelated approval, autopilot mode, agent-generated
Yes, generic Yes flag, or piped input is not that approval. Internally supplied
flags must refer to the same actual user-approved immutable plan and effect
scopes; permission for one action never authorizes another.

Use the CLI's same-project next actions and native-shell rendering for real paths,
especially spaces and PowerShell metacharacters. Never edit the actual application
first and seek retrospective approval. A changed source, destination, file mode,
directory entry, patch document, replacement, target identity, or verification
policy requires fresh inspection/review. Changes while any prompt is open must
refuse the old approval: an explicit Yes does not authorize a silently refreshed
or substituted plan.

## What inventory means

The public inventory has schema 1 and kind `liftoff-application-inventory`.
`projectRoot` is canonical. `inspectionDigest` binds the bounded observation and
the supplied manifest. `target.digest` binds layout
`liftoff-application-artifacts-v1`, version 1, the recorded workload, and the
current generator's exact artifact identities.

Targets come from the real current generator, including the selected standard
Node/Python/Go or GenAI backend, applicable Functions worker, optional frontend,
database, and containers. Each has `logicalName`, `category`, `pathParts`,
`provisioningGroup`, `component`, and `componentRootPathParts`. Target identities
are not generated replacement bytes.

`files` contains paths, byte digests, modes, lengths, current exact target matches,
and any recorded provenance. `recorded-only` provenance is not a recognized
historical layout. A matching generation hash does not grant mutation authority.
`unresolvedMappings` identifies files needing an explicit developer decision; it
does not imply that every file must be moved.

`references` exposes IDs, referring file paths, line/column locations, target
paths, and literal/relative/Python-import classifications—not source snippets or
configuration values. This is a bounded lexical observation, **not** a complete
dependency graph. Dynamic imports, aliases, templates, code generation, external
packages, and runtime behavior require actual developer review. Binary assets
are byte-bound but have no reference scan.

Exclusions include VCS internals, `.liftoff`, infrastructure/state anywhere,
live dotenv and recognized credential/configuration files, known protected
Liftoff/framework/seed/native-agent control files, and dependency/cache/build
output trees. Excluded content is neither opened nor copied. Known generated
non-live examples, such as a selected `.env.example`, are distinct from live
dotenv files. Broad exclusions are restrictions, never ownership grants.

The current bounds are 512 files, 256 directories, 256 entries per inspected
directory, depth 12, 1 MiB per file, 8 MiB total content, 2,048 references,
500,000 reference tokens, 96 mappings, and a 64 KiB patch document. Exceeding a
relevant bound blocks executable repair rather than silently approving an
incomplete inventory. Unsafe links/junctions, hard links, case/normalization
aliases, special modes, and nonportable/traversing paths also block the lane.

## Strict schema-1 patch input

JSON uses exactly these fields. Unknown fields, duplicate object keys, unsupported
schemas, incomplete source bindings, and nonempty `unresolvedMappings` are
rejected. A staged file path is a portable path-part array **relative to the patch
document's directory**, not relative to the application.

```json
{
  "schemaVersion": 1,
  "kind": "liftoff-application-patch",
  "projectRoot": "/work/custom-app",
  "inspectionDigest": "0000000000000000000000000000000000000000000000000000000000000000",
  "targetLayoutDigest": "0000000000000000000000000000000000000000000000000000000000000000",
  "dynamicReferencesReviewed": true,
  "unresolvedMappings": [],
  "mappings": [
    {
      "sourcePathParts": ["legacy", "service.mjs"],
      "targetPathParts": ["backend", "src", "app.ts"],
      "expectedSourceDigest": "0000000000000000000000000000000000000000000000000000000000000000",
      "expectedSourceMode": 420,
      "stagedPathParts": ["replacements", "app.txt"],
      "targetMode": 420,
      "role": "application",
      "targetIdentity": {
        "kind": "generated-artifact",
        "logicalName": "node-backend-app"
      },
      "customization": "preserved",
      "references": []
    },
    {
      "sourcePathParts": ["tests", "service.test.mjs"],
      "targetPathParts": ["tests", "service.test.mjs"],
      "expectedSourceDigest": "0000000000000000000000000000000000000000000000000000000000000000",
      "expectedSourceMode": 420,
      "stagedPathParts": ["replacements", "service-test.txt"],
      "targetMode": 420,
      "role": "reference",
      "targetIdentity": {
        "kind": "custom-component",
        "logicalName": "node-backend-app"
      },
      "customization": "reviewed-edit",
      "references": [
        {
          "referenceId": "0000000000000000000000000000000000000000000000000000000000000000",
          "disposition": "updated",
          "afterTargetPathParts": ["backend", "src", "app.ts"]
        }
      ]
    }
  ],
  "verification": {
    "commands": [
      {
        "executable": "node",
        "args": ["--test", "tests/service.test.mjs"],
        "cwdPathParts": [],
        "timeoutMs": 10000,
        "maxOutputBytes": 16384,
        "network": false
      }
    ]
  }
}
```

**The zero digests and example root above are placeholders, not approval
material.** Copy the exact canonical root, inspection/target digests, observed
source digests/modes, and reference IDs from the actual inventory. The native
repair agent/tooling normally fills these machine bindings; they are not human
approval steps or a request to type approval hashes. Digests are
bare lowercase 64-character SHA-256 strings, not `sha256:`-prefixed strings.
Modes are JSON decimal integers (`420` is Unix `0644`). On Windows copy the
effective observed native mode: writable `0666` is decimal `438`, read-only
`0444` is decimal `292`.

This small example assumes the original service has no outgoing project
references and the test has exactly one observed reference to it. Preserve the
actual service bytes in `replacements/app.txt`; update the test's import from
`../legacy/service.mjs` to `../backend/src/app.ts` in its replacement. Do not
remove real additional references to make the example fit. If imports, build
configuration, scripts, Docker/Compose, CI, or documentation refer to the moved
source, include their exact mappings and dispositions too.

### Mapping and reference rules

- A source must be an existing, fully inspected, safe regular file with the exact
  expected digest and mode. There are no arbitrary new-file additions.
- A move destination must be absent. Equal existing bytes do not make an occupied
  destination safe. Same-path edits are allowed; swaps, cycles, duplicate or
  overlapping paths, directory moves, and wildcard mappings are not.
- `generated-artifact` requires the exact current path of its selected
  `logicalName`.
- `custom-component` permits an explicitly named custom application file inside
  the selected backend, frontend, database, or particular generated worker
  component. It never grants recursive ownership. For `role: "reference"`, a
  custom-component mapping is an exact same-path edit of an inspected reference
  file, anchored to a selected current identity.
- `customization: "preserved"` requires byte-identical staged content.
  `reviewed-edit` explicitly declares developer-reviewed replacement bytes.
  Liftoff does not prove semantic equivalence or generate starters for either.
- Every observed outgoing reference in a mapped file requires exactly one
  disposition. Every referring file affected by a move must itself have an exact
  mapping. Unknown IDs and missing dispositions block the patch.
- `updated` names the concrete target found in the resulting staged file.
  `unchanged-reviewed` names the same original target and requires it to remain
  present and referenced. `historical-documentation` uses
  `afterTargetPathParts: null` and is limited to explicitly mapped documentation,
  never executable code. A historical reference is not evidence that a runtime
  reference still works.

The executable fixture `tests/fixtures/repair-application.ts` demonstrates the
larger case:

| Existing file | Exact target | Purpose |
| --- | --- | --- |
| `legacy/service.mjs` | `backend/src/app.ts` | Preserve custom behavior at `node-backend-app` |
| `legacy/custom.mjs` | `backend/src/custom.mjs` | Explicit custom component file |
| `tests/quote.test.mjs` | Same path | Update import and execute real pricing assertions |
| `scripts/check-layout.mjs` | Same path | Check actual staged build/container/CI/docs references |
| `package.json` | Same path | Preserve scripts with the corrected entrypoint |
| `Dockerfile` | Same path | Update `COPY` and command references |
| `docker-compose.yml` | Same path | Update command and volume paths |
| `.github/workflows/check.yml` | Same path | Update working directory and entrypoint |
| `docs/operations.md` | Same path | Update operational paths |
| `README.md` | Same path | Update the application run reference |

The fixture runs native Node tests plus a real staged reference-check script.
It does not claim that Docker builds, hosted CI, Python/Go behavior, deployment,
or native Windows qualification ran merely because their references were checked.
These are dependency-free custom-behavior and reference checks, not generated
Fastify/FastAPI/Vue build or test qualification. The other component-mapping
fixtures inspect preserved candidate bytes; they do not execute those frameworks.

## Verification scope and limitations

The API accepts at most eight exact commands, each with a maximum 120-second
timeout and 64 KiB combined output limit. `cwdPathParts: []` means the candidate
copy's root; other working directories must exist in that copy. Commands are
passed as executable plus separate argument arrays through the existing
`shell: false` process runner, with streaming disabled.

Permitted direct command families are:

- `node --test <exact-local-test-files>` or `node <exact-local-check-file>`;
- `python`/`python3` with a local `.py` check or `-m pytest`/`-m unittest`;
- `go test`/`go vet`, without alternate executors, overlays, or working roots;
- `npm test --ignore-scripts`, or
  `npm run test|build|check|lint --ignore-scripts`.

The last family still executes the explicitly requested trusted package script;
`--ignore-scripts` disables incidental lifecycle hooks, not that requested script.
Shell programs, inline Node/Python evaluation, arbitrary installers, Git,
cloud/state commands, and external absolute/traversing paths are rejected.
Permitted command families are not a promise that the required dependencies are
available. Live `node_modules` and virtual environments are excluded, not copied
from the real application. Typical existing npm builds/tests and Python framework
checks can therefore be unavailable in this fresh copy even when they work in the
original project. Installing dependencies in the original project does not make
those excluded trees available here.

The application repair lane supports optional, registered locked dependency
preparation for the disposable verification copy. Live `node_modules` and virtual
environments are never copied or shared from the real application. Installing
dependencies in the original project does not grant authority or make those
trees available in verification.

Registered preparation providers are:

- `npm-ci` version 1: selected backend or frontend `package.json` plus
  `package-lock.json` (lockfile version 3); compatible installed Node and npm;
  exact `npm ci` with lifecycle scripts disabled and audit/fund/config side
  effects suppressed; frozen dependency tree and a fresh private cache.
- `uv-locked-sync` version 1: Python `pyproject.toml` plus `uv.lock` (version 1);
  compatible installed Python and uv; derives an explicit Python venv creation
  command followed by locked sync into the private environment with `UV_LINK_MODE=copy`;
  no interpreter downloads, source builds, or project-install/build hooks.
- `go-mod-download` version 1: Go `go.mod` plus `go.sum`; compatible installed Go;
  exact module download/read-only checks with private module and build caches and
  local toolchain only; no module or checksum updates, workfiles, or toolchain downloads.

Supported package sources are explicitly registered credential-free registries:
`npmjs`, `microsoft-npm`, `pypi`, `microsoft-pypi`, and `go-proxy`. Project and
global package-manager configurations, tokens, credential helpers, hooks, and
ambient credentials are not inherited. Lifecycle and build hooks remain
strictly suppressed (`lifecycle: "disabled"`). If a candidate requires
unsupported hooks or unregistered sources, preparation is blocked.

Preparation requires separate action-specific consent: in the interactive flow,
an explicit default-No question precedes preparation and check commands; in
automation, `--allow-dependency-preparation` must accompany `--verify-plan <fingerprint>`.
Declared network effects require their own distinct permission (the network question
interactively; `--allow-network` for automation). Neither project-check consent
nor file-write consent implies preparation or network authority.

### Actionable failures without raw diagnostic output

Verification classifies allowlisted launch errors, exit statuses, and bounded
known diagnostic patterns internally. Public blockers identify the declared
command's index/tool and a fixed category, never the matched package name, path,
source snippet, token, stdout, stderr, or arbitrary exception message:

- `missing-executable`: a required executable/interpreter or script command
  could not be found. Review the installed tool and its prerequisites through
  separate workstation setup; repair does not install global tools.
- `missing-dependencies`: a required module, type declaration, project-local
  check tool, build output, or package/cache input appears unavailable.
  Generic `npm install` remains rejected; registered preparation must be
  declared and separately approved. A dependency diagnostic does not silently
  authorize any unapproved preparation.
- `check-failed`: an existing assertion/build/check failed, or the requested
  npm script/Go module context is absent. Review the actual staged inputs and
  existing check; do not invent replacement tests or infer preparation success.
- `timed-out` / `output-limit`: the reviewed execution bound was exceeded.
  Investigate waits or reduce verbosity; changing a bound requires fresh review,
  not an automatic retry.
- `execution-failed` / `interrupted`: execution prerequisites, launch permissions,
  tool compatibility, or completion were not confirmed. Earlier verifier effects
  are not undone.
- `termination-unconfirmed`: the runner could not confirm all verifier processes
  stopped. The private workspace is retained rather than deleted under uncertain
  writers, cleanup is incomplete, and no success receipt can be issued.

These are sanitized causal hints, not complete root-cause or conformance proofs.
Review detailed diagnostics only through separately approved trusted local
tooling. Do not paste secrets or treat unsupported preparation/cleanup as
implicitly available.

Verification creates an exclusively named private sibling of the external
staging directory, copies only bounded inspected application bytes, and applies
the proposed file effects **there only**. Home, caches, and scratch paths are
private, ambient credential/hook variables are cleared, and source/candidate
bindings are rechecked before and after execution. Results contain command
indexes/statuses, bounds/failure flags, and digests; arbitrary stdout, stderr,
or exception messages are not returned. Successful cleanup removes the private
copy; an unsuccessful cleanup reports its retained location.
Checks that rewrite protected source bytes, modes, or inspected directories
inside the candidate copy invalidate verification even if their exit status is
zero. Newly created build outputs are not transferred to the application.

**This is not a security sandbox.** Explicitly approved trusted project scripts
can themselves access the host or network. Offline environment settings and an
isolated working directory do not enforce an operating-system network or
filesystem boundary. In particular, `network: false` records the declared effects;
it is **not** proof that scripts cannot access the network. Scripts can also
read/write host files and start other processes. Review the actual code and
commands; do not verify untrusted code. A passed result proves only the declared checks, not complete
application conformance, local setup, activation, deployment, or live safety.
If mandatory operating-system or network isolation is required, this lane is
unsupported and must remain blocked; do not silently substitute a weaker
guarantee. The strict patch schema rejects unsupported isolation assertions.
`inspectedProjectUnchanged` describes equality of the bounded application
inventory using the originally supplied manifest metadata. It does **not** prove
raw manifest/configuration, excluded state/control/credential contents, or other
project/host/network effects unchanged. The coordinator independently binds and
rechecks raw manifest and configuration bytes; an engine result is not a
substitute for those checks. A script can change excluded inputs even when this
narrow inventory comparison still returns true.

## Approval, originals, and recovery

The coordinator binds all original snapshots, destination absences, mutations,
directory inventories, staged file/patch digests and modes, reference review,
target identity, and exact verification policy into the approval. It rebinds
under the project mutation lock and requires fresh matching successful
verification before the existing confined transaction writes.

Private original bytes are separate from public or generic external receipts.
The application engine supplies private `{ pathParts, content?: Buffer, mode? }`
snapshots, including absent destinations, without writing backups itself.
The coordinator selects only snapshots for actual mutated paths and calls
`preserveRepairOriginals(preview, onlyMutatedSnapshots, storage)`. It stores
bounded chunks under the project-bound `repair-backup` scoped store and returns
the index key/path for bookkeeping. Each record stays within the 64 KiB bound;
even a larger original source is not embedded in a generic preview, verification,
or history receipt. Unrelated inspected files remain transaction preconditions
but are not duplicated into the changed-file backup.

The original manifest, desired configuration, history and activation evidence
are not application-patch targets. Interrupted approved transaction effects use
the separate `--recover` path. A later behavior correction requires a new reviewed
patch or user-controlled version-history recovery—not automatic restoration of
old bytes over subsequent developer work.
