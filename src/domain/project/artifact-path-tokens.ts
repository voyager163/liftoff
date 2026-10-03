import { validateArtifactPathParts } from './paths.js';

/*
 * Reserved path parts that release-owned artifact declarations use in place of project-specific
 * values. Declarations, release records and content identities therefore never contain a project
 * name; each plan materializes the value before rendering. A token confers no directory ownership.
 */

/** Reserved placeholder for the per-project OpenSpec bootstrap change directory. */
export const bootstrapChangeToken = '_bootstrap-change_';

export interface ArtifactPathTokenValues {
  /** The plan's safe project name: lowercase ASCII letters, digits and single dashes. */
  readonly safeProjectName: string;
}

export interface ArtifactPathTokenPlacement {
  readonly token: string;
  /** Exact parts that precede the token; the token is always the next, non-final part. */
  readonly prefix: readonly string[];
  /** The only logical names allowed to declare the token. */
  readonly logicalNames: readonly string[];
}

export const artifactPathTokenPlacements: readonly ArtifactPathTokenPlacement[] = Object.freeze([
  Object.freeze({
    token: bootstrapChangeToken,
    prefix: Object.freeze(['openspec', 'changes']),
    logicalNames: Object.freeze([
      'openspec-seed-change-metadata',
      'openspec-seed-proposal',
      'openspec-seed-design',
      'openspec-seed-tasks',
      'openspec-seed-spec'
    ])
  })
]);

export interface ArtifactPathIdentity {
  readonly logicalName: string;
  readonly pathParts: readonly string[];
}

export type ArtifactPathIssueCode =
  | 'token-misplaced'
  | 'token-embedded'
  | 'token-unmaterialized'
  | 'non-portable-path'
  | 'path-alias-collision'
  | 'path-prefix-collision';

export interface ArtifactPathIssue {
  readonly code: ArtifactPathIssueCode;
  readonly subject: string;
  readonly detail: string;
}

const portablePartPattern = /^[A-Za-z0-9._-]+$/;

function placementFor(part: string): ArtifactPathTokenPlacement | undefined {
  return artifactPathTokenPlacements.find((placement) => placement.token === part);
}

/** True when a path part is, or embeds, a reserved token. */
export function containsArtifactPathToken(part: string): boolean {
  return artifactPathTokenPlacements.some((placement) => part.includes(placement.token));
}

export function isArtifactPathToken(part: string): boolean {
  return placementFor(part) !== undefined;
}

function aliasKey(parts: readonly string[]): string {
  return parts.map((part) => part.normalize('NFC').toLowerCase()).join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Declared tokens must be whole, non-final parts at their reserved placement in listed declarations. */
export function artifactPathTokenIssues(artifacts: readonly ArtifactPathIdentity[]): ArtifactPathIssue[] {
  const issues: ArtifactPathIssue[] = [];
  for (const artifact of artifacts) {
    const subject = `artifact:${artifact.logicalName}`;
    artifact.pathParts.forEach((part, index) => {
      const placement = placementFor(part);
      if (placement !== undefined) {
        const placed = index === placement.prefix.length &&
          index < artifact.pathParts.length - 1 &&
          placement.prefix.every((expected, position) => artifact.pathParts[position] === expected) &&
          placement.logicalNames.includes(artifact.logicalName);
        if (!placed) {
          issues.push({
            code: 'token-misplaced',
            subject,
            detail: `${placement.token} is reserved for ${placement.logicalNames.join(', ')} directly under ${placement.prefix.join('/')}/`
          });
        }
      } else if (containsArtifactPathToken(part)) {
        issues.push({ code: 'token-embedded', subject, detail: `path part ${JSON.stringify(part)} embeds a reserved token` });
      }
    });
  }
  return issues;
}

function tokenValue(token: string, values: ArtifactPathTokenValues): string {
  if (token === bootstrapChangeToken) return `bootstrap-${values.safeProjectName}`;
  throw new Error(`Unknown artifact path token ${JSON.stringify(token)}.`);
}

export function materializeArtifactPathParts(
  pathParts: readonly string[],
  values: ArtifactPathTokenValues
): string[] {
  return pathParts.map((part) => (isArtifactPathToken(part) ? tokenValue(part, values) : part));
}

/**
 * Validates concrete identities as one set before rendering: portable parts with no remaining token,
 * no case-folded alias (including exact duplicates) and no path used as both a file and a directory.
 */
export function concreteArtifactPathIssues(artifacts: readonly ArtifactPathIdentity[]): ArtifactPathIssue[] {
  const issues: ArtifactPathIssue[] = [];
  const valid: ArtifactPathIdentity[] = [];
  for (const artifact of artifacts) {
    const subject = `artifact:${artifact.logicalName}`;
    try {
      validateArtifactPathParts([...artifact.pathParts], 'Artifact path');
    } catch (error) {
      issues.push({ code: 'non-portable-path', subject, detail: (error as Error).message });
      continue;
    }
    const nonPortable = artifact.pathParts.find((part) => !portablePartPattern.test(part));
    if (nonPortable !== undefined) {
      issues.push({ code: 'non-portable-path', subject, detail: `path part ${JSON.stringify(nonPortable)} uses characters outside [A-Za-z0-9._-]` });
      continue;
    }
    if (artifact.pathParts.some(containsArtifactPathToken)) {
      issues.push({ code: 'token-unmaterialized', subject, detail: `${artifact.pathParts.join('/')} still contains a reserved token` });
      continue;
    }
    valid.push(artifact);
  }
  const namesByKey = new Map<string, string[]>();
  for (const artifact of valid) {
    const key = aliasKey(artifact.pathParts);
    namesByKey.set(key, [...(namesByKey.get(key) ?? []), artifact.logicalName]);
  }
  for (const [key, names] of namesByKey) {
    if (names.length > 1) {
      issues.push({ code: 'path-alias-collision', subject: `path:${key}`, detail: `claimed by ${[...names].sort(compareText).join(', ')}` });
    }
  }
  for (const artifact of valid) {
    for (let length = 1; length < artifact.pathParts.length; length += 1) {
      const prefix = aliasKey(artifact.pathParts.slice(0, length));
      const files = namesByKey.get(prefix);
      if (files !== undefined) {
        issues.push({
          code: 'path-prefix-collision',
          subject: `path:${prefix}`,
          detail: `${[...files].sort(compareText).join(', ')} is a file where ${artifact.logicalName} requires a directory`
        });
      }
    }
  }
  return issues;
}
