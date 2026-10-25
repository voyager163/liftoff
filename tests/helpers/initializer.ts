import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InitializerOutcome, InitializerPort } from "../../src/application/ports.ts";
import type { InitializerStep } from "../../src/plugins/contracts/project-plugin.ts";

/** What a fake initializer step does: what it writes, how long it takes and how it ends. */
export interface FakeStep {
  readonly files?: Readonly<Record<string, string>>;
  /** Empty directories it creates. */
  readonly directories?: readonly string[];
  /** How long it runs on the fake clock; past its time limit it is stopped. */
  readonly takesMs?: number;
  readonly outcome?: Partial<InitializerOutcome>;
}

/** A clock a test moves by hand. */
export interface FakeClock {
  ms: number;
}

/**
 * Stands in for a framework's initializer: it records each step it is asked
 * to run, with its time limit, and writes the files `behave` returns into the
 * directory, as a real initializer would. Nothing is downloaded or run.
 */
export class FakeInitializer implements InitializerPort {
  readonly runs: { step: InitializerStep; directory: string; timeoutMs: number }[] = [];
  private readonly behave: (step: InitializerStep, directory: string) => FakeStep;
  private readonly paths: readonly string[];
  private readonly clock: FakeClock | undefined;

  constructor(
    behave: (step: InitializerStep, directory: string) => FakeStep = () => ({}),
    paths: readonly string[] = [],
    clock?: FakeClock,
  ) {
    this.behave = behave;
    this.paths = paths;
    this.clock = clock;
  }

  async run(
    step: InitializerStep,
    directory: string,
    options: { readonly timeoutMs: number },
  ): Promise<InitializerOutcome> {
    const {
      files = {},
      directories = [],
      takesMs = 0,
      outcome = {},
    } = this.behave(step, directory);
    this.runs.push({ step, directory, timeoutMs: options.timeoutMs });
    if (this.clock) this.clock.ms += Math.min(takesMs, options.timeoutMs);
    if (takesMs > options.timeoutMs) {
      return { started: true, exitCode: null, timedOut: true, output: "" };
    }
    for (const directoryPath of directories) {
      mkdirSync(path.join(directory, ...directoryPath.split("/")), { recursive: true });
    }
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(directory, ...file.split("/"));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return { started: true, exitCode: 0, timedOut: false, output: "", ...outcome };
  }

  machinePaths(): readonly string[] {
    return this.paths;
  }
}
