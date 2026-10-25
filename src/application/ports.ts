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

/** Something under a directory: a regular file, a directory, or anything else such as a link. */
export interface TreeEntry {
  /** Relative POSIX path. */
  readonly path: string;
  readonly kind: "file" | "directory" | "other";
}

/** File system access for creating a project. */
export interface ProjectFsPort {
  state(path: string): Promise<PathState>;
  /** Text of a file, or undefined when it does not exist. */
  readText(path: string): Promise<string | undefined>;
  /** A new empty directory beside `target`, on the same volume, for staging. */
  createStaging(target: string): Promise<string>;
  writeFile(path: string, content: string, executable: boolean): Promise<void>;
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

/** Reads a tool's version without changing anything. */
export interface ToolPort {
  /** First line of the tool's version output, or undefined when it cannot run. */
  version(command: string, args: readonly string[]): Promise<string | undefined>;
}
