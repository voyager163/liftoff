import { PolicyError } from "../domain/risk-policy/policy.ts";
import type { CommandContext, CommandResult, CommandSpec, Io } from "./command.ts";
import { renderCommandHelp, renderGroupHelp, renderRootHelp } from "./help.ts";
import {
  CancelledError,
  type ExitCode,
  exitCodeFor,
  type Outcome,
  UnsupportedError,
  UsageError,
} from "./outcome.ts";
import { parseCommandArgs, resolveCommand } from "./parse.ts";

/**
 * Runs one command line and returns its exit code. With --json exactly one
 * JSON object is written to stdout, whatever happens; diagnostics go to stderr.
 */
export async function runCli(
  argv: readonly string[],
  io: Io,
  registry: readonly CommandSpec[],
  version: string,
): Promise<ExitCode> {
  const json = argv.includes("--json");
  const context: CommandContext = { io, registry, version };

  try {
    if (argv[0] === "--version") {
      if (argv.slice(1).some((arg) => arg !== "--json")) {
        throw new UsageError("--version takes no other arguments");
      }
      io.stdout(
        json ? `${JSON.stringify({ schema: "liftoff.version/v1", version })}\n` : `${version}\n`,
      );
      return exitCodeFor("success");
    }
    if (argv.length === 0 || ((argv[0] === "--help" || argv[0] === "-h") && argv.length === 1)) {
      io.stdout(renderRootHelp(registry, version));
      return exitCodeFor("success");
    }
    if (argv[0] === "help") return showHelp(argv.slice(1), io, registry, version);

    const resolution = resolveCommand(registry, argv);
    if (resolution.kind === "root") {
      throw new UsageError(`unknown option "${argv[0]}"; run "liftoff --help"`);
    }
    if (resolution.kind === "group") {
      const wantsHelp = argv.includes("--help") || argv.includes("-h");
      (wantsHelp ? io.stdout : io.stderr)(renderGroupHelp(resolution.path, resolution.specs));
      return exitCodeFor(wantsHelp ? "success" : "usage");
    }

    const { spec, rest } = resolution;
    const args = parseCommandArgs(spec, rest);
    if (args.options.help === true) {
      io.stdout(renderCommandHelp(spec));
      return exitCodeFor("success");
    }
    const result = await spec.run(args, context);
    emit(io, json, spec.reportSchema, result);
    return exitCodeFor(result.outcome);
  } catch (error) {
    const outcome = classifyError(error, io);
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      io.stdout(`${JSON.stringify({ schema: "liftoff.error/v1", outcome, error: { message } })}\n`);
    }
    io.stderr(`liftoff: ${message}\n`);
    return exitCodeFor(outcome);
  }
}

function showHelp(
  words: readonly string[],
  io: Io,
  registry: readonly CommandSpec[],
  version: string,
): ExitCode {
  if (words.length === 0) {
    io.stdout(renderRootHelp(registry, version));
    return exitCodeFor("success");
  }
  const resolution = resolveCommand(registry, words);
  if (resolution.kind === "command") {
    if (resolution.rest.length > 0) throw new UsageError(`help takes only a command name`);
    io.stdout(renderCommandHelp(resolution.spec));
  } else if (resolution.kind === "group") {
    io.stdout(renderGroupHelp(resolution.path, resolution.specs));
  } else {
    io.stdout(renderRootHelp(registry, version));
  }
  return exitCodeFor("success");
}

function emit(io: Io, json: boolean, schema: string, result: CommandResult): void {
  if (json) {
    io.stdout(
      `${JSON.stringify({ schema, outcome: result.outcome, ...result.report }, null, 2)}\n`,
    );
  } else {
    io.stdout(result.text);
  }
}

function classifyError(error: unknown, io: Io): Outcome {
  if (io.signal.aborted || error instanceof CancelledError) return "cancelled";
  if (error instanceof UsageError) return "usage";
  if (error instanceof UnsupportedError) return "unsupported";
  if (error instanceof PolicyError) return "failure";
  return "failure";
}
