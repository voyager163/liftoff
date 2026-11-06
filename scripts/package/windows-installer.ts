// Pure rules for the Windows installer (DIST-006), apart from the scripts
// that build and check it, so they can be tested anywhere.

/** The UpgradeCode every Liftoff MSI shares; distribution/windows/liftoff.wxs has it. */
export const UPGRADE_CODE = "{60D7F28B-CC6D-4476-B93F-20A568C637F2}";

/** The MSI asset's name in a release. */
export const MSI_NAME = "liftoff-x86_64-pc-windows-msvc.msi";

/**
 * The MSI ProductVersion for a Liftoff version: its X.Y.Z, without any
 * prerelease, which Windows Installer cannot hold. Windows Installer allows
 * at most 255.255.65535.
 */
export function msiVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) throw new Error(`${version} is not an X.Y.Z version`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (major > 255 || minor > 255 || patch > 65535) {
    throw new Error(`${version} is beyond the MSI version limit 255.255.65535`);
  }
  return `${major}.${minor}.${patch}`;
}

/** A value from `reg query <key> /v <name>`, or null when it is absent. */
export function registryValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S(?:.*?\S)?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
    if (match !== null && match[1]?.toLowerCase() === name.toLowerCase()) return match[3] ?? "";
  }
  return null;
}

/** The entries of a Windows PATH value, with %VARIABLES% expanded from `env`. */
export function pathEntries(value: string, env: Record<string, string | undefined>): string[] {
  const lower = new Map(Object.entries(env).map(([key, entry]) => [key.toLowerCase(), entry]));
  return value
    .split(";")
    .map((entry) =>
      entry.replace(/%([^%]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole),
    )
    .filter((entry) => entry.trim() !== "");
}
