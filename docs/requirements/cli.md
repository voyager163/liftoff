# Command line

## CLI-001 One registry drives every command

Every command is declared once in the command registry. Parsing, `--help`,
`liftoff help <command>`, `liftoff capabilities --json` and the CLI reference
are all produced from it, so documentation cannot list a command that does not
exist.

- Given the registry, when root help is printed, then it lists every command.
- Given a command name prefix shared by several commands, when it is run
  without a subcommand, then group help is shown on stderr with exit code 2.

Verification: test

## CLI-002 Strict arguments and fixed exit codes

Unknown options, stray positional arguments, missing or empty values and values
outside a declared set are usage errors. Exit codes are fixed:

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | success | The command did what was asked. |
| 1 | failure | It could not complete. |
| 2 | usage | The command line was wrong. |
| 3 | attention | It worked and found something to act on. |
| 4 | cancelled | The user or a signal stopped it. |
| 5 | partial | Some effects happened; see the report. |
| 6 | unsupported | This release does not support the request. |

With `--json`, exactly one JSON object is printed on stdout, including for
errors (`schema: "liftoff.error/v1"`); diagnostics go to stderr.

Verification: test

## CLI-003 Capability discovery

`liftoff capabilities --json` lists every command with its options, whether it
is read-only and its report schema, plus the exit codes, stacks, GenAI patterns
and their maturity, frontends, infrastructure, environments and governance
profiles.
It never writes anything, contacts no network service and sends no telemetry.

Verification: test

## CLI-010 Bounded child processes

Liftoff runs other programs without a shell, with a time limit and capped
output. A timeout or cancellation kills the whole process tree, including
grandchildren, on macOS and Windows. On Windows, tools installed as batch
files, such as `npx`, run through `cmd.exe`, and only with arguments
`cmd.exe` passes on unchanged.

- Given a child that starts a grandchild and hangs, when the time limit passes,
  then both processes are gone.

Verification: test
