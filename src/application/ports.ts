import type { ChangedFile } from "../domain/risk-policy/classify.ts";
import type { InitializerStep } from "../plugins/contracts/project-plugin.ts";

/** Read-only view of the Git repository a command runs in. */
export interface GitPort {
  /** Resolves a ref to a commit SHA, or undefined if it does not exist. */
  resolveCommit(ref: string): Promise<string | undefined>;
  mergeBase(a: string, b: string): Promise<string>;
  /**
   * Files changed since `fromCommit`: committed changes up to HEAD, and with
   * `includeWorkingTree` also staged, unstaged and untracked files.
   */
  changedFiles(fromCommit: string, includeWorkingTree: boolean): Promise<ChangedFile[]>;
  /** Contents of a file at a ref, or undefined if it is not there. */
  showFile(ref: string, path: string): Promise<string | undefined>;
}

/** Read-only access to files in the working tree. */
export interface WorkspacePort {
  readText(relativePath: string): Promise<string | undefined>;
}

/** Read-only access to the assets shipped with this Liftoff release. */
export interface AssetPort {
  /** Names of the entries directly inside an asset directory, sorted. */
  list(relativeDirectory: string): Promise<string[]>;
  /** Asset paths of every file under a directory, recursively and sorted. */
  listTree(relativeDirectory: string): Promise<string[]>;
  readText(relativePath: string): Promise<string>;
  /** The committed CI bundles shipped with this release, by file name. */
  ciBundles(): Promise<Record<string, string>>;
}

export type PathState = "missing" | "empty-directory" | "directory" | "file";

/**
 * What a path itself is, without following a link, and a file's size in
 * bytes. It is "inaccessible" when this user may not look at it.
 */
export interface PathEntry {
  readonly kind: "missing" | "file" | "directory" | "other" | "inaccessible";
  readonly size: number;
}

/**
 * A file read with readWithin. Its text is left out when it is over the
 * limit. `via` names a directory on the way to it that is a link, a file or
 * closed to this user, or that changed while the file was being opened.
 */
export type RegularFileRead =
  | { readonly kind: "missing" | "directory" }
  | { readonly kind: "other" | "inaccessible"; readonly via?: string }
  | { readonly kind: "file"; readonly size: number; readonly text?: string };

/** Something under a directory: a regular file, a directory, or anything else such as a link. */
export interface TreeEntry {
  /** Relative POSIX path. */
  readonly path: string;
  readonly kind: "file" | "directory" | "other";
}

/** File system access for creating a project. */
export interface ProjectFsPort {
  state(path: string): Promise<PathState>;
  /** Like state, but a link is "other" rather than what it points at. */
  entry(path: string): Promise<PathEntry>;
  /**
   * Reads the regular file at `relative`, a POSIX path under `directory`,
   * following no link on the way or at the file, and no more than `maxBytes`
   * of it: a file over the limit is not read. It is "other" when anything on
   * the way changed while the file was being opened.
   */
  readWithin(directory: string, relative: string, maxBytes: number): Promise<RegularFileRead>;
  /** Text of a file, or undefined when it does not exist. */
  readText(path: string): Promise<string | undefined>;
  /** A new empty directory beside `target`, on the same volume, for staging. */
  createStaging(target: string): Promise<string>;
  writeFile(path: string, content: string, executable: boolean): Promise<void>;
  /** Writes a file, replacing it if it exists, so a reader sees the old or the new text. */
  replaceFile(path: string, content: string): Promise<void>;
  /**
   * Creates a file only if there is none: false when one exists. If writing
   * it fails once created, it is removed again and the error thrown.
   */
  createExclusive(path: string, content: string): Promise<boolean>;
  /** Moves the staged directory to `target`, which must be missing or empty. */
  publish(staging: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Every entry under a directory, sorted; links are not followed. */
  listTree(directory: string): Promise<TreeEntry[]>;
}

export interface InitializerOutcome {
  /** False when the command could not be started at all, for example because it is not installed. */
  readonly started: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The end of what it printed, for an error message. */
  readonly output: string;
}

/** Runs a development framework's own pinned initializer. */
export interface InitializerPort {
  /**
   * Runs one step in `directory` with telemetry off and with a temporary
   * home and configuration directories, so the user's own configuration is
   * untouched. It is stopped after `timeoutMs`.
   */
  run(
    step: InitializerStep,
    directory: string,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<InitializerOutcome>;
  /** Paths particular to this machine, such as the home directory, that a project's files must never contain. */
  machinePaths(): readonly string[];
}

/**
 * GitHub's REST API, reached with the person's own GitHub CLI login. Liftoff
 * never sees or stores their credentials.
 */
export interface GitHubApiPort {
  /** The GitHub repository a directory's origin remote points at, as owner/name. */
  repositoryOf(directory: string): Promise<string | undefined>;
  get<T>(route: string): Promise<T>;
  /** Like get, but undefined when GitHub answers 404. */
  find<T>(route: string): Promise<T | undefined>;
  send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", route: string, body?: unknown): Promise<T>;
  /** Like send, but reports a refusal with GitHub's HTTP status instead of throwing. */
  attempt(
    method: "PATCH" | "DELETE",
    route: string,
    body?: unknown,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly status?: number; readonly message: string }
  >;
}

/** Reads a tool's version without changing anything. */
export interface ToolPort {
  /** First line of the tool's version output, or undefined when it cannot run. */
  version(command: string, args: readonly string[]): Promise<string | undefined>;
}
