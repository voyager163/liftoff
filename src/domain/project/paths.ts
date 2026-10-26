/**
 * Why a path is not a repository-relative POSIX path that every system and
 * Git can hold, or undefined when it is: no absolute path, drive or
 * backslash, no empty, "." or ".." part, no control character or character
 * Windows forbids in a name, no name Windows would read as another file (a
 * trailing dot or space, a stream with ":", a device such as "nul", or an
 * 8.3 short name such as "GIT~1", any of which could reach .git), and
 * nothing inside a .git directory at any depth.
 */
export function repositoryPathProblem(path: string): string | undefined {
  const parts = path.split("/");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\u0000-\u001f\u007f<>"|?*]/.test(path)) {
    return `${JSON.stringify(path)} has a character Git or Windows cannot hold in a name`;
  }
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return `${path} is not a repository-relative path`;
  }
  if (
    parts.some(
      (part) =>
        /[. ]$/.test(part) ||
        part.includes(":") ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part) ||
        /~\d/.test(part),
    )
  ) {
    return `${path} has a name Windows would read as another file`;
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    return `${path} is inside a .git directory`;
  }
  return undefined;
}
