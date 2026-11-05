import manifest from "../../package.json" with { type: "json" };

/** The installed Liftoff version, from the package manifest shipped with it. */
export const VERSION: string = manifest.version;
