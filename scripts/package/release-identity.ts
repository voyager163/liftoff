// The release.json every bundle carries (DIST-002): what was built, from
// which source, and who signed it. It names no channel.
import { execFileSync } from "node:child_process";

export interface ReleaseIdentity {
  readonly schema: "liftoff.release/v1";
  readonly version: string;
  readonly target: string;
  readonly node: string;
  readonly commit: string;
  readonly tree: string;
  /** The signing identity for each operating system, or null while unsigned. */
  readonly signed: { readonly macos: string | null; readonly windows: string | null };
}

/** The identity of a bundle built from `commit`, which is named, never read from HEAD again. */
export function releaseIdentity(
  root: string,
  commit: string,
  build: { version: string; target: string; node: string },
): ReleaseIdentity {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    schema: "liftoff.release/v1",
    ...build,
    commit: git("rev-parse", "--verify", `${commit}^{commit}`),
    tree: git("rev-parse", "--verify", `${commit}^{tree}`),
    // Signing fills these in.
    signed: { macos: null, windows: null },
  };
}
