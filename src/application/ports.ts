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
