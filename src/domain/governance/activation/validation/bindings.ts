import type { EvidenceTransitionIdentity, PhaseId, PlannedFileChange, InputTransitionBinding } from '../types.js';
import { phaseIdSet, exact, stringField, stringArray, safePathParts, enumValue, hexDigest, assertNoDuplicateStrings } from './common.js';

export function validateFileChanges(value: unknown, path: string): PlannedFileChange[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const changes = value.map((entry, index): PlannedFileChange => {
    const item = exact(entry, ['pathParts', 'beforeHash', 'afterHash'], `${path}[${index}]`);
    return {
      pathParts: safePathParts(item.pathParts, `${path}[${index}].pathParts`),
      beforeHash: item.beforeHash === null ? null : hexDigest(item.beforeHash, `${path}[${index}].beforeHash`),
      afterHash: item.afterHash === null ? null : hexDigest(item.afterHash, `${path}[${index}].afterHash`)
    };
  });
  assertNoDuplicateStrings(changes.map((change) => change.pathParts.join('/')), path);
  return changes;
}

export function validateGitInput(value: unknown, path: string): NonNullable<InputTransitionBinding['git']>['before'] {
  const git = exact(value, ['head', 'branch', 'pushUrls'], path);
  const head = git.head === null ? null : stringField(git, 'head', path);
  if (head !== null && !/^[a-f0-9]{40,64}$/u.test(head)) throw new Error(`${path}.head must be an actual Git object ID.`);
  const pushUrls = stringArray(git.pushUrls, `${path}.pushUrls`);
  if (pushUrls.some((url) => !/^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/u.test(url))) {
    throw new Error(`${path}.pushUrls must contain credential-free supported GitHub destinations.`);
  }
  return { head, branch: git.branch === null ? null : stringField(git, 'branch', path), pushUrls };
}

export function validateEvidenceTransitionIdentity(value: unknown, path: string): EvidenceTransitionIdentity {
  const transition = exact(value, ['phaseId', 'baselineSha', 'inputDigest', 'transitionDigest'], path);
  return {
    phaseId: enumValue<PhaseId>(transition.phaseId, phaseIdSet, `${path}.phaseId`),
    baselineSha: hexDigest(transition.baselineSha, `${path}.baselineSha`),
    inputDigest: hexDigest(transition.inputDigest, `${path}.inputDigest`),
    transitionDigest: hexDigest(transition.transitionDigest, `${path}.transitionDigest`)
  };
}
