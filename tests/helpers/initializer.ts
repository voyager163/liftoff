import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InitializerOutcome, InitializerPort } from "../../src/application/ports.ts";
import type { InitializerStep } from "../../src/plugins/contracts/project-plugin.ts";

/** What a fake initializer step does: the files it writes and how it ends. */
export interface FakeStep {
  readonly files?: Readonly<Record<string, string>>;
  readonly outcome?: Partial<InitializerOutcome>;
}

/**
 * Stands in for a framework's initializer: it records each step it is asked
 * to run and writes the files `behave` returns into the directory, as a real
 * initializer would. Nothing is downloaded or run.
 */
export class FakeInitializer implements InitializerPort {
  readonly runs: { step: InitializerStep; directory: string }[] = [];
  private readonly behave: (step: InitializerStep, directory: string) => FakeStep;
  private readonly paths: readonly string[];

  constructor(
    behave: (step: InitializerStep, directory: string) => FakeStep = () => ({}),
    paths: readonly string[] = [],
  ) {
    this.behave = behave;
    this.paths = paths;
  }

  async run(step: InitializerStep, directory: string): Promise<InitializerOutcome> {
    const { files = {}, outcome = {} } = this.behave(step, directory);
    this.runs.push({ step, directory });
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
