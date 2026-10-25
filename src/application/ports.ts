import type { ChangedFile } from "../domain/risk-policy/classify.ts";

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
}

/** Reads a tool's version without changing anything. */
export interface ToolPort {
  /** First line of the tool's version output, or undefined when it cannot run. */
  version(command: string, args: readonly string[]): Promise<string | undefined>;
}
