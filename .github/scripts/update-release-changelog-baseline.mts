import {
  type ReleaseBranch,
  selectHighestLowerVersion,
} from './release-version-utils.mts';

export type ChangelogBaseline = {
  kind: 'target' | 'stable' | 'release';
  ref: string;
  version: string;
};

export type ChangelogBaselineDependencies = {
  hasReleaseHeading: (ref: string, version: string) => boolean;
  getStableVersions: () => readonly string[];
  getReleaseBranches: () => readonly ReleaseBranch[];
};

export function selectChangelogBaseline({
  version,
  releaseBranch,
  dependencies,
}: {
  version: string;
  releaseBranch: string;
  dependencies: ChangelogBaselineDependencies;
}): ChangelogBaseline {
  if (dependencies.hasReleaseHeading(`origin/${releaseBranch}`, version)) {
    return { kind: 'target', ref: `origin/${releaseBranch}`, version };
  }

  const releaseBranches = dependencies.getReleaseBranches();
  const predecessorVersion = selectHighestLowerVersion(version, [
    ...dependencies.getStableVersions(),
    ...releaseBranches.map(({ version: branchVersion }) => branchVersion),
  ]);

  if (!predecessorVersion) {
    throw new Error(`No earlier release version exists for ${version}`);
  }

  if (dependencies.hasReleaseHeading('origin/stable', predecessorVersion)) {
    return {
      kind: 'stable',
      ref: 'origin/stable',
      version: predecessorVersion,
    };
  }

  const matchingBranches = releaseBranches.filter(
    ({ version: branchVersion }) => branchVersion === predecessorVersion,
  );
  if (matchingBranches.length !== 1) {
    throw new Error(
      `Expected exactly one release branch for ${predecessorVersion}, found ${matchingBranches.length}`,
    );
  }

  const [matchingBranch] = matchingBranches;
  if (!matchingBranch) {
    throw new Error(
      `Expected exactly one release branch for ${predecessorVersion}, found 0`,
    );
  }

  return {
    kind: 'release',
    ref: `origin/${matchingBranch.name}`,
    version: predecessorVersion,
  };
}
