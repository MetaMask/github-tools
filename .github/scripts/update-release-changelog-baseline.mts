import {
  detectLineEnding,
  parseReleaseHeadingVersion,
  splitLines,
} from './release-section.mts';
import {
  compareSemver,
  type ReleaseBranch,
  selectHighestLowerVersion,
} from './release-version-utils.mts';

const RELEASE_LINK_REFERENCE = /^\[(\d+\.\d+\.\d+)\]: /u;

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

/**
 * Selects the changelog the release section is generated on top of: the target
 * branch once it has the section, otherwise the predecessor version on `stable`
 * or on its release branch.
 *
 * @param options0 - The options.
 * @param options0.version - The version being released.
 * @param options0.releaseBranch - The target release branch name.
 * @param options0.dependencies - The Git lookups, injected so tests can fake
 * them.
 * @returns The chosen baseline ref and version.
 */
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
  // Strictly lower, also for `-ota` targets: an OTA release has its own patch version, so no same-version native exists.
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

  // Without its own section, the predecessor's PRs would be attributed to the
  // release being generated.
  const ref = `origin/${matchingBranch.name}`;
  if (!dependencies.hasReleaseHeading(ref, predecessorVersion)) {
    throw new Error(
      `${ref} has no ## [${predecessorVersion}] changelog section, so its PRs would be attributed to ${version}. Merge its changelog PR first, or delete the branch if it was abandoned.`,
    );
  }

  return { kind: 'release', ref, version: predecessorVersion };
}

/**
 * Drops the sections and link references of releases newer than the target. A
 * hotfix on an older release line is restored from a baseline that may already
 * hold newer releases, which do not belong on its branch.
 *
 * @param changelog - The changelog restored from the baseline.
 * @param version - The version being released.
 * @returns The changelog without releases newer than `version`.
 */
export function removeNewerReleases(
  changelog: string,
  version: string,
): string {
  const isNewer = (candidate: string): boolean =>
    compareSemver(candidate, version) > 0;
  let skipping = false;

  const keptLines = splitLines(changelog).filter((line) => {
    const headingVersion = parseReleaseHeadingVersion(line);
    if (headingVersion) {
      skipping = isNewer(headingVersion);
      return !skipping;
    }

    // Another heading (such as Unreleased) or the link references end a section.
    if (line.startsWith('## [') || /^\[[^\]]+\]: /u.test(line)) {
      skipping = false;
    }
    const linkVersion = RELEASE_LINK_REFERENCE.exec(line)?.[1];
    if (linkVersion && isNewer(linkVersion)) {
      return false;
    }
    return !skipping;
  });

  return keptLines.join(detectLineEnding(changelog));
}
