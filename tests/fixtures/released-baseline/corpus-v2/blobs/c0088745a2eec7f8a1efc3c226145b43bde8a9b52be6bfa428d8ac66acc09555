interface ParsedSemver {
  nums: [number, number, number];
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver {
  const withoutBuild = version.split('+')[0];
  const hyphenIndex = withoutBuild.indexOf('-');
  const core = hyphenIndex >= 0 ? withoutBuild.slice(0, hyphenIndex) : withoutBuild;
  const prerelease = hyphenIndex >= 0 ? withoutBuild.slice(hyphenIndex + 1).split('.') : [];
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((part) => Number(part) || 0);
  return { nums: [major, minor, patch], prerelease };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  for (let index = 0; index < 3; index += 1) {
    if (pa.nums[index] !== pb.nums[index]) {
      return pa.nums[index] < pb.nums[index] ? -1 : 1;
    }
  }

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) {
    return 0;
  }
  if (pa.prerelease.length === 0) {
    return 1;
  }
  if (pb.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = pa.prerelease[index];
    const right = pb.prerelease[index];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) {
        return Number(left) < Number(right) ? -1 : 1;
      }
      continue;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }

  return 0;
}
