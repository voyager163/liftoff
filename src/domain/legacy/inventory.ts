/**
 * Recognizes what the Liftoff releases before the rebuild (up to 0.12.3)
 * left in a project, without running or changing any of it. Each record found
 * is in one of four states:
 * - readable: recognized and reported; kept unchanged as the project's
 *   history, never counted as current configuration or proof.
 * - migratable: readable, and adopting the project can carry what it says
 *   into the new configuration.
 * - executable: this release could continue or act on it. No record from
 *   before the rebuild is: nothing old is resumed, applied or re-run.
 * - unsupported: not recognized, such as an unknown or newer format, a
 *   malformed file, or a link or directory where the old release kept a
 *   file. Liftoff stops there rather than guess.
 */
export const LEGACY_STATES = ["readable", "migratable", "executable", "unsupported"] as const;
export type LegacyState = (typeof LEGACY_STATES)[number];

/** The newest pre-rebuild release, which wrote the newest formats recognized here. */
export const LAST_PRE_REBUILD_RELEASE = "0.12.3";

/** Larger files are not read: no record the old release wrote comes close. */
export const MAX_LEGACY_BYTES = 1024 * 1024;

export type LegacyRecordKind =
  | "manifest"
  | "config"
  | "governance-handoff"
  | "interrupted-change"
  | "repair-history"
  | "activation-state"
  | "activation-records"
  | "credential-records"
  | "activation-history";

interface Candidate {
  readonly path: string;
  readonly record: LegacyRecordKind;
  readonly kind: "file" | "directory";
  /** Whether its text is read. Records that can hold copies of files, credentials or state are only noted. */
  readonly open: boolean;
  /**
   * Marks the directory as a project from before the rebuild on its own.
   * The others, at generic paths such as governance/, count only beside one.
   */
  readonly marker: boolean;
}

/** Every path the old releases wrote inside a project that is worth recognizing, in report order. */
export const LEGACY_CANDIDATES: readonly Candidate[] = [
  { path: "liftoff.manifest.json", record: "manifest", kind: "file", open: true, marker: true },
  { path: "liftoff.config.json", record: "config", kind: "file", open: true, marker: true },
  {
    path: ".liftoff/governance",
    record: "governance-handoff",
    kind: "directory",
    open: false,
    marker: true,
  },
  {
    path: ".liftoff/reviewed-update-transaction.json",
    record: "interrupted-change",
    kind: "file",
    open: false,
    marker: true,
  },
  {
    path: ".liftoff/reviewed-repair-transaction.json",
    record: "interrupted-change",
    kind: "file",
    open: false,
    marker: true,
  },
  {
    path: ".liftoff/repair-history",
    record: "repair-history",
    kind: "directory",
    open: false,
    marker: true,
  },
  {
    path: "governance/activation-state.json",
    record: "activation-state",
    kind: "file",
    open: true,
    marker: false,
  },
  ...["evidence", "plans", "approvals"].map(
    (name): Candidate => ({
      path: `governance/${name}`,
      record: "activation-records",
      kind: "directory",
      open: false,
      marker: false,
    }),
  ),
  {
    path: "governance/credentials",
    record: "credential-records",
    kind: "directory",
    open: false,
    marker: false,
  },
  {
    path: "governance/history",
    record: "activation-history",
    kind: "directory",
    open: false,
    marker: false,
  },
  {
    path: "governance/migration-state.json",
    record: "activation-history",
    kind: "file",
    open: false,
    marker: false,
  },
];

/**
 * What is at a candidate's path. A link, or a link or file on the way to it
 * where a directory belongs (`via`), is "other".
 */
export type LegacyObservation =
  | { readonly kind: "missing" | "directory" }
  | { readonly kind: "other"; readonly via?: string }
  | { readonly kind: "file"; readonly size: number; readonly text?: string };

export interface LegacyRecord {
  readonly path: string;
  readonly record: LegacyRecordKind;
  readonly state: LegacyState;
  /** Whether its text was read. */
  readonly opened: boolean;
  /** The old format, such as "manifest v7", when one was recognized. */
  readonly format?: string;
  /** The old Liftoff release that wrote it, when the record says. */
  readonly release?: string;
  readonly reason: string;
  /** Why nothing should change the project until this is dealt with. */
  readonly blocks?: string;
}

export interface LegacyInventory {
  /** Whether a record that only the old releases wrote is here. */
  readonly project: boolean;
  readonly records: readonly LegacyRecord[];
}

/** The fields the old project configuration could have; it had no version of its own. */
const CONFIG_FIELDS = new Set([
  "projectName",
  "projectType",
  "apiStack",
  "pattern",
  "cloud",
  "region",
  "includeFrontend",
  "environments",
  "specWorkflow",
  "agents",
  "defaultAgent",
  "governanceProfile",
]);
const MANIFEST_VERSIONS = { oldest: 2, newest: 7 };
const ACTIVATION_STATE_VERSIONS = new Set([1, 2, 3]);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const HISTORY = "kept unchanged as the project's history; never counted as current proof";

/** Classifies what was observed at each candidate path. Paths not in the map count as missing. */
export function classifyLegacy(
  observations: ReadonlyMap<string, LegacyObservation>,
): LegacyInventory {
  const found = LEGACY_CANDIDATES.flatMap((candidate) => {
    const observed = observations.get(candidate.path) ?? { kind: "missing" };
    return observed.kind === "missing" ? [] : [{ candidate, observed }];
  });
  // A link on the way, such as a linked .liftoff, says nothing of the old releases.
  const project = found.some(
    ({ candidate, observed }) =>
      candidate.marker && !(observed.kind === "other" && observed.via !== undefined),
  );
  if (!project) return { project, records: [] };
  // Such a link is reported once, at its own path, not for each record beneath it.
  const links = new Set<string>();
  const records = found.flatMap(({ candidate, observed }): LegacyRecord[] => {
    if (observed.kind !== "other" || observed.via === undefined) {
      return [classify(candidate, observed)];
    }
    if (links.has(observed.via)) return [];
    links.add(observed.via);
    return [
      {
        path: observed.via,
        record: candidate.record,
        state: "unsupported",
        opened: false,
        reason:
          "a link or a file where the old release kept a directory; it is not followed, so nothing under it was looked at",
      },
    ];
  });
  return { project, records };
}

function classify(candidate: Candidate, observed: LegacyObservation): LegacyRecord {
  const base = { path: candidate.path, record: candidate.record, opened: false };
  const unsupported = (reason: string, extra: Partial<LegacyRecord> = {}): LegacyRecord => ({
    ...base,
    state: "unsupported",
    reason,
    ...extra,
  });
  if (observed.kind !== candidate.kind) {
    return unsupported(
      observed.kind === "other"
        ? "a link or other special file; it is not followed"
        : `a ${observed.kind} where the old release kept a ${candidate.kind}`,
    );
  }
  if (!candidate.open || observed.kind !== "file") return presence(candidate);
  if (observed.size > MAX_LEGACY_BYTES || observed.text === undefined) {
    return unsupported(`larger than ${MAX_LEGACY_BYTES} bytes, so it was not read`);
  }
  let value: unknown;
  try {
    value = JSON.parse(observed.text);
  } catch {
    return unsupported("not valid JSON", { opened: true });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return unsupported("not a JSON object", { opened: true });
  }
  const fields = value as Record<string, unknown>;
  const read = { ...base, opened: true };
  switch (candidate.record) {
    case "manifest":
      return manifest(read, fields);
    case "config":
      return config(read, fields);
    default:
      return activationState(read, fields);
  }
}

type Opened = Pick<LegacyRecord, "path" | "record" | "opened">;

function manifest(read: Opened, fields: Record<string, unknown>): LegacyRecord {
  if (fields.generatedBy !== "Mission Control Liftoff") {
    return { ...read, state: "unsupported", reason: "not a manifest written by Liftoff" };
  }
  const version = fields.artifactVersion;
  const release = typeof fields.liftoffVersion === "string" ? fields.liftoffVersion : undefined;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ...read, state: "unsupported", reason: "its format version is missing or unknown" };
  }
  const format = `manifest v${version}`;
  if (version > MANIFEST_VERSIONS.newest) {
    return {
      ...read,
      state: "unsupported",
      format,
      reason: `newer than any release before the rebuild wrote (${LAST_PRE_REBUILD_RELEASE} wrote v${MANIFEST_VERSIONS.newest})`,
    };
  }
  if (version < MANIFEST_VERSIONS.oldest) {
    return { ...read, state: "unsupported", format, reason: "older than any format recognized" };
  }
  if (release === undefined || !SEMVER.test(release)) {
    return {
      ...read,
      state: "unsupported",
      format,
      reason: "it does not say which release wrote it",
    };
  }
  return {
    ...read,
    state: "migratable",
    format,
    release,
    reason: "the project's old manifest; adopting the project can carry its choices over",
  };
}

function config(read: Opened, fields: Record<string, unknown>): LegacyRecord {
  const keys = Object.keys(fields);
  const unknown = keys.filter((key) => !CONFIG_FIELDS.has(key));
  const named = [fields.projectName, fields.projectType].every(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (unknown.length > 0 || !named) {
    return {
      ...read,
      state: "unsupported",
      reason:
        unknown.length > 0
          ? `fields no release before the rebuild wrote: ${unknown.sort().join(", ")}`
          : "it lacks the project's name or type",
    };
  }
  return {
    ...read,
    state: "migratable",
    format: "configuration",
    reason: "the project's old configuration; adopting the project can carry its choices over",
  };
}

function activationState(read: Opened, fields: Record<string, unknown>): LegacyRecord {
  const version = fields.schemaVersion;
  if (typeof version !== "number" || !ACTIVATION_STATE_VERSIONS.has(version)) {
    return {
      ...read,
      state: "unsupported",
      reason: "its format version is missing, unknown or newer than the old release wrote",
    };
  }
  return {
    ...read,
    state: "readable",
    format: `activation state v${version}`,
    reason: `governance activation by the old release, ${HISTORY}`,
  };
}

/** Records noted by their presence alone. */
function presence(candidate: Candidate): LegacyRecord {
  const base = {
    path: candidate.path,
    record: candidate.record,
    state: "readable" as const,
    opened: false,
  };
  switch (candidate.record) {
    case "interrupted-change":
      return {
        ...base,
        reason:
          "the journal of an update or repair the old release did not finish; it holds whole copies of files, so it is not read",
        blocks: `the old release stopped part way through changing this project: run the same command again with Liftoff ${LAST_PRE_REBUILD_RELEASE} to finish or undo it before anything else changes the project`,
      };
    case "governance-handoff":
      return { ...base, reason: `governance files from the old release, ${HISTORY}` };
    case "repair-history":
      return {
        ...base,
        reason: `copies of the manifest from before each old repair, ${HISTORY}; not read`,
      };
    case "credential-records":
      return {
        ...base,
        reason: "credential set-up records from the old release; never read",
      };
    case "activation-history":
      return {
        ...base,
        reason: `copies of earlier activation records, ${HISTORY}; not read`,
      };
    default:
      return { ...base, reason: `activation records from the old release, ${HISTORY}; not read` };
  }
}
