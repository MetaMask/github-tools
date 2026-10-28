export type ReleaseBranchKind = 'native' | 'ota';

export type ReleaseBranch = {
  version: string;
  kind: ReleaseBranchKind;
  name: string;
};

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

/**
 * Parses a `release/X.Y.Z` or `release/X.Y.Z-ota` branch name.
 *
 * @param branchName - The branch name without the `origin/` prefix.
 * @returns The parsed branch, or `undefined` when the name is not a release
 * branch.
 */
export function parseReleaseBranch(
  branchName: string,
): ReleaseBranch | undefined {
  const match = /^release\/(\d+\.\d+\.\d+)(-ota)?$/u.exec(branchName);
  if (!match) {
    return undefined;
  }

  const version = match[1];
  if (!version) {
    return undefined;
  }

  return {
    version,
    kind: match[2] ? 'ota' : 'native',
    name: branchName,
  };
}

/**
 * Compares two `X.Y.Z` versions.
 *
 * @param left - The first version.
 * @param right - The second version.
 * @returns A negative number when `left` is lower, a positive number when it is
 * higher, and 0 when they are equal.
 */
export function compareSemver(left: string, right: string): number {
  const leftMatch = SEMVER_PATTERN.exec(left);
  const rightMatch = SEMVER_PATTERN.exec(right);

  if (!leftMatch || !rightMatch) {
    throw new Error(
      `Expected semantic versions, received ${left} and ${right}`,
    );
  }

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/**
 * Picks the highest candidate version that is lower than the target.
 *
 * @param targetVersion - The version the result must be lower than.
 * @param candidateVersions - The versions to choose from.
 * @returns The highest lower version, or `undefined` when none is lower.
 */
export function selectHighestLowerVersion(
  targetVersion: string,
  candidateVersions: readonly string[],
): string | undefined {
  return candidateVersions.reduce<string | undefined>(
    (selectedVersion, candidateVersion) => {
      if (compareSemver(candidateVersion, targetVersion) >= 0) {
        return selectedVersion;
      }

      if (
        !selectedVersion ||
        compareSemver(candidateVersion, selectedVersion) > 0
      ) {
        return candidateVersion;
      }

      return selectedVersion;
    },
    undefined,
  );
}
