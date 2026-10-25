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

/** Branch names a ruleset targets directly (wildcards cannot be read back per branch). */
export function targetedBranches(ruleset: DesiredRuleset): string[] {
  return ruleset.conditions.ref_name.include
    .filter((ref) => ref.startsWith("refs/heads/") && !/[*?[]/.test(ref))
    .map((ref) => ref.slice("refs/heads/".length));
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
