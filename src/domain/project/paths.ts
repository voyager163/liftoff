/**
 * Why a path is not a repository-relative POSIX path that every system and
 * Git can hold, or undefined when it is: no absolute path, drive or
 * backslash, no empty, "." or ".." part, no control character or character
 * Windows forbids in a name, no name Windows would read as another file (a
 * trailing dot or space, a stream with ":", a device such as "nul", or an
 * 8.3 short name such as "GIT~1", any of which could reach .git), no name
 * longer than 255 bytes, and nothing inside a .git directory at any depth.
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
        // Windows reserves COM¹ to COM³ and LPT¹ to LPT³ too.
        /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(part) ||
        /~\d/.test(part),
    )
  ) {
    return `${path} has a name Windows would read as another file`;
  }
  // macOS, Windows and Linux all allow 255 bytes in one name, at most.
  if (parts.some((part) => new TextEncoder().encode(part).length > 255)) {
    return `${path} has a name longer than 255 bytes`;
  }
  if (parts.some((part) => pathKey(part) === ".git")) {
    return `${path} is inside a .git directory`;
  }
  return undefined;
}

/**
 * The form two paths are compared in: macOS and Windows ignore letter case,
 * and macOS also treats a letter and its decomposed form (such as "é" and
 * "e" with a combining accent) as the same name. A path is lowercased, then
 * folded through its capitals and lowercased again, so that letters sharing
 * a small letter or a capital match: "Σ", "σ" and "ς", "ı" and "i", and "ß",
 * "ẞ" and "ss". That joins a few names one system keeps apart, erring toward
 * refusing a path rather than missing an alias.
 */
export const pathKey = (path: string): string =>
  path.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
