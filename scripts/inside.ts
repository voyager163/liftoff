// Whether a path is strictly inside a directory, for scripts that write or
// remove files only within the repository.
import path from "node:path";

/**
 * True when `target` is below `root`, never `root` itself. `pathApi` is
 * `path.win32` or `path.posix`, so both systems' rules can be tested
 * anywhere: on Windows, `root` with its drive letter written in another case
 * is still `root`, and a target on another drive comes back absolute from
 * `relative`.
 */
export function isInside(root: string, target: string, pathApi: typeof path.posix = path): boolean {
  const inside = pathApi.relative(root, pathApi.resolve(root, target));
  return (
    inside !== "" &&
    !pathApi.isAbsolute(inside) &&
    inside !== ".." &&
    !inside.startsWith(`..${pathApi.sep}`)
  );
}
