/** One rule as GitHub's ruleset API represents it. */
export interface Rule {
  readonly type: string;
  readonly parameters?: Readonly<Record<string, unknown>> | null;
}

/** A desired ruleset, in the shape GitHub's create and update API accepts. */
export interface DesiredRuleset {
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly conditions: {
    readonly ref_name: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  };
  readonly bypass_actors: readonly unknown[];
  readonly rules: readonly Rule[];
}

/** A rule GitHub reports as active on a branch, from any ruleset. */
export interface EffectiveRule extends Rule {
  readonly ruleset_id?: number;
  readonly ruleset_source?: string;
}

export interface Difference {
  readonly branch: string;
  readonly rule: string;
  readonly kind: "missing" | "changed" | "inactive-ruleset";
  readonly detail: string;
}

const isBranchName = (ref: string) => ref.startsWith("refs/heads/") && !/[*?[]/.test(ref);

/** Branch names a ruleset targets directly (wildcards cannot be read back per branch). */
export function targetedBranches(ruleset: DesiredRuleset): string[] {
  return ruleset.conditions.ref_name.include
    .filter(isBranchName)
    .map((ref) => ref.slice("refs/heads/".length));
}

/** What a ruleset targets other than named branches, such as a pattern or ~ALL. */
export function patternTargets(ruleset: DesiredRuleset): string[] {
  return ruleset.conditions.ref_name.include.filter((ref) => !isBranchName(ref));
}

/** A ruleset as GitHub returns it by id. */
export interface LiveRuleset {
  readonly target?: string;
  readonly enforcement: string;
  readonly conditions?: {
    readonly ref_name?: {
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
    };
  } | null;
  /** Missing when the person reading it may not see who can bypass it. */
  readonly bypass_actors?: readonly unknown[];
}

/** Sorts object keys and order-insensitive arrays so equal rules compare equal. */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    return items.every((item) => typeof item !== "object" || item === null)
      ? [...items].sort()
      : [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

const describe = (value: unknown) => JSON.stringify(normalize(value ?? {}));

/** "key: expected X, found Y" for each parameter that differs. */
function changedKeys(
  wanted: Rule["parameters"] | undefined,
  found: Rule["parameters"] | undefined,
): string {
  const a = (wanted ?? {}) as Record<string, unknown>;
  const b = (found ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((key) => describe(a[key]) !== describe(b[key]))
    .map((key) => `${key}: expected ${describe(a[key] ?? null)}, found ${describe(b[key] ?? null)}`)
    .join(", ");
}

/**
 * Compares what a ruleset should enforce with what GitHub says is enforced.
 * A desired rule is satisfied when an active rule of the same type has the
 * same parameters. Extra active rules (for example a stricter organization
 * ruleset) are not drift: they only add protection.
 */
export function compareRuleset(
  desired: DesiredRuleset,
  effectiveByBranch: Readonly<Record<string, readonly EffectiveRule[]>>,
): Difference[] {
  const differences: Difference[] = [];
  for (const branch of targetedBranches(desired)) {
    const effective = effectiveByBranch[branch] ?? [];
    if (desired.enforcement !== "active") {
      differences.push({
        branch,
        rule: "(ruleset)",
        kind: "inactive-ruleset",
        detail: `ruleset "${desired.name}" is ${desired.enforcement}, so nothing is enforced`,
      });
      continue;
    }
    for (const rule of desired.rules) {
      const sameType = effective.filter((candidate) => candidate.type === rule.type);
      if (sameType.length === 0) {
        differences.push({
          branch,
          rule: rule.type,
          kind: "missing",
          detail: "not active on this branch",
        });
        continue;
      }
      const wanted = describe(rule.parameters);
      if (!sameType.some((candidate) => describe(candidate.parameters) === wanted)) {
        differences.push({
          branch,
          rule: rule.type,
          kind: "changed",
          detail: sameType.map((c) => changedKeys(rule.parameters, c.parameters)).join("; or "),
        });
      }
    }
  }
  return differences;
}

/**
 * What the rules on each branch cannot show: which branches a live ruleset
 * applies to, and who may bypass it. Both must be exactly as committed, since
 * a narrower target or an extra bypass weakens it.
 */
export function compareDefinition(desired: DesiredRuleset, live: LiveRuleset): Difference[] {
  const differences: Difference[] = [];
  const at = `ruleset "${desired.name}"`;
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  const applies = {
    include: live.conditions?.ref_name?.include ?? [],
    exclude: live.conditions?.ref_name?.exclude ?? [],
  };
  if (!same(desired.conditions.ref_name, applies) || (live.target ?? "branch") !== desired.target) {
    differences.push({
      branch: at,
      rule: "(conditions)",
      kind: "changed",
      detail: `applies to ${describe(applies)}, not ${describe(desired.conditions.ref_name)}`,
    });
  }
  if (live.bypass_actors === undefined) {
    differences.push({
      branch: at,
      rule: "(bypass)",
      kind: "changed",
      detail: "who may bypass it cannot be read with this login; a repository admin must verify it",
    });
  } else if (!same(desired.bypass_actors, live.bypass_actors)) {
    differences.push({
      branch: at,
      rule: "(bypass)",
      kind: "changed",
      detail: `expected bypass actors ${describe(desired.bypass_actors)}, found ${describe(live.bypass_actors)}`,
    });
  }
  return differences;
}
