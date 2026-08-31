export function compareStableVersions(left, right) {
  const parse = (value) => value.replace(/^v/, '').split('.').map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function requireStableVersion(value, label) {
  const normalized = String(value).trim().replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`${label} returned non-stable version ${JSON.stringify(value)}.`);
  }
  return normalized;
}

export function selectLatestNodeLts(releases) {
  if (!Array.isArray(releases)) {
    throw new Error('Node.js releases response must be an array.');
  }
  const candidates = releases
    .filter((release) => release && release.lts !== false)
    .map((release) => requireStableVersion(release.version, 'Node.js LTS'))
    .sort(compareStableVersions);
  if (candidates.length === 0) {
    throw new Error('Node.js releases response contains no stable LTS release.');
  }
  return candidates.at(-1);
}

export function classifyFreshness(current, candidate, reviewedCandidate) {
  if (current === candidate) return 'current';
  return reviewedCandidate === candidate ? 'reviewed' : 'stale';
}

function stableParts(value, label) {
  return requireStableVersion(value, label).split('.').map(Number);
}

export function versionSatisfiesDeclaredRange(version, specifier) {
  const candidate = stableParts(version, 'candidate');
  const match = String(specifier).match(/^([~^]?)(\d+\.\d+\.\d+)$/);
  if (!match) {
    throw new Error(`Unsupported declared npm range ${JSON.stringify(specifier)}.`);
  }
  const operator = match[1];
  const minimum = stableParts(match[2], 'declared npm range');
  if (compareStableVersions(version, match[2]) < 0) return false;
  if (operator === '') return compareStableVersions(version, match[2]) === 0;
  if (operator === '~') {
    return candidate[0] === minimum[0] && candidate[1] === minimum[1];
  }
  if (minimum[0] > 0) return candidate[0] === minimum[0];
  if (minimum[1] > 0) {
    return candidate[0] === 0 && candidate[1] === minimum[1];
  }
  return candidate[0] === 0 && candidate[1] === 0 && candidate[2] === minimum[2];
}

export function selectLatestCompatibleVersion(versions, specifier) {
  const candidates = versions
    .filter((version) => {
      try {
        return versionSatisfiesDeclaredRange(version, specifier);
      } catch {
        return false;
      }
    })
    .sort(compareStableVersions);
  if (candidates.length === 0) {
    throw new Error(
      `Npm package returned no stable version satisfying ${JSON.stringify(specifier)}.`
    );
  }
  return candidates.at(-1);
}
