import type { InstallPorts, QueryResult } from "../../src/application/ports.ts";

/** A recorded answer: what a program printed, or undefined when it could not run. */
export type Answer = QueryResult | undefined;

export const printed = (stdout: string, exitCode = 0): QueryResult => ({
  exitCode,
  stdout,
  stderr: "",
});

/**
 * An install with recorded command outputs instead of real channels. Paths
 * listed in `files` exist, with their text; `links` maps a path to where it
 * resolves. Queries are answered by "command arg arg…".
 */
export interface FakeInstallOptions {
  readonly platform: "darwin" | "win32";
  readonly app: string;
  readonly executable: string;
  readonly env?: Record<string, string | undefined>;
  readonly files?: Record<string, string>;
  readonly links?: Record<string, string>;
  readonly answers?: Record<string, Answer>;
}

export class FakeInstall implements InstallPorts {
  readonly platform: "darwin" | "win32";
  readonly env: Record<string, string | undefined>;
  readonly queries: string[] = [];
  readonly delegated: {
    command: string;
    args: readonly string[];
    pathFirst?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }[] = [];
  readonly handedOff: { command: string; args: readonly string[] }[] = [];
  readonly answers: Record<string, Answer>;
  readonly links: Record<string, string>;
  delegateExit: number | null = 0;
  latest: unknown | Error = undefined;

  readonly options: FakeInstallOptions;

  constructor(options: FakeInstallOptions) {
    this.options = options;
    this.platform = options.platform;
    this.env = options.env ?? {};
    this.answers = { ...options.answers };
    this.links = { ...options.links };
  }

  async running() {
    return { app: this.options.app, executable: this.options.executable };
  }

  async realPath(file: string) {
    const link = this.links[file];
    if (link !== undefined) return link;
    return file in (this.options.files ?? {}) ? file : undefined;
  }

  async readText(file: string) {
    return this.options.files?.[file];
  }

  async exists(file: string) {
    return file in (this.options.files ?? {}) || file in this.links;
  }

  async query(command: string, args: readonly string[]) {
    const key = [command, ...args].join(" ");
    this.queries.push(key);
    return this.answers[key];
  }

  async delegate({
    command,
    args,
    pathFirst,
    env,
  }: {
    command: string;
    args: readonly string[];
    pathFirst?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }) {
    this.delegated.push({
      command,
      args,
      ...(pathFirst === undefined ? {} : { pathFirst }),
      ...(env === undefined ? {} : { env }),
    });
    return this.delegateExit;
  }

  async handOff(command: string, args: readonly string[]) {
    this.handedOff.push({ command, args });
  }

  async fetchJson() {
    if (this.latest instanceof Error) throw this.latest;
    return this.latest;
  }
}
