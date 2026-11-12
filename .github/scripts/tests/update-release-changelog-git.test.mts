import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertRemoteRefUnchanged,
  getRemoteBranchSha,
  getChangelogBranchCommits,
  hasSameChangelogAsRemoteBranch,
  getReviewedCurrentReleaseSection,
  pushChangelogBranch,
  rebuildChangelogBranch,
} from '../update-release-changelog.mts';
import { git } from './git-test-environment.mts';

const TARGET = 'release/13.51.0';
const CHANGELOG_BRANCH = 'release-changelog/13.51.0';
const STABLE_BASELINE = {
  kind: 'stable' as const,
  ref: 'origin/stable',
  version: '13.50.0',
};

/**
 * Commits files to a branch and force-pushes it to origin.
 *
 * @param cwd - The repository to commit in.
 * @param branch - The branch to create or reset.
 * @param files - The file contents by file name.
 * @param options0 - The options.
 * @param options0.from - A ref to branch from; when omitted, an orphan branch is
 * created.
 */
function commitFiles(
  cwd: string,
  branch: string,
  files: Record<string, string>,
  { from }: { from?: string } = {},
): void {
  if (from) {
    git(cwd, 'checkout', '-B', branch, from);
  } else {
    git(cwd, 'checkout', '--orphan', branch);
    git(cwd, 'rm', '-rf', '--ignore-unmatch', '.');
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(cwd, name), content);
    git(cwd, 'add', name);
  }
  git(cwd, 'commit', '-m', `fixture ${branch}`);
  git(cwd, 'push', '--force', 'origin', branch);
}

const releaseChangelog = `# Changelog

## [Unreleased]

## [13.51.0]

### Added

- Added a reviewed feature (#101)

## [13.49.0]

### Fixed

- Fixed an older issue (#90)
`;

const stableChangelog = `# Changelog

## [Unreleased]

## [13.50.0]

### Fixed

- Fixed the predecessor issue (#100)
`;

describe('release changelog Git behavior', () => {
  let rootDirectory: string;
  let seed: string;
  let work: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    rootDirectory = mkdtempSync(join(tmpdir(), 'release-changelog-test-'));
    const origin = join(rootDirectory, 'origin.git');
    seed = join(rootDirectory, 'seed');
    work = join(rootDirectory, 'work');
    mkdirSync(seed);
    git(rootDirectory, 'init', '--bare', '-b', 'main', origin);
    git(seed, 'init', '-b', 'main');
    git(seed, 'remote', 'add', 'origin', origin);

    commitFiles(seed, 'main', {
      'CHANGELOG.md': 'main\n',
      'code.txt': 'main\n',
    });
    commitFiles(
      seed,
      TARGET,
      {
        'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
        'code.txt': 'target\n',
      },
      { from: 'main' },
    );
    commitFiles(
      seed,
      'stable',
      { 'CHANGELOG.md': stableChangelog, 'code.txt': 'stable\n' },
      { from: 'main' },
    );
    commitFiles(
      seed,
      CHANGELOG_BRANCH,
      { 'CHANGELOG.md': releaseChangelog, 'code.txt': 'stale\n' },
      { from: TARGET },
    );
    commitFiles(
      seed,
      'no-changelog',
      { 'code.txt': 'none\n' },
      { from: 'main' },
    );
    git(seed, 'rm', '-q', 'CHANGELOG.md');
    git(seed, 'commit', '-m', 'drop changelog');
    git(seed, 'push', '--force', 'origin', 'no-changelog');

    git(rootDirectory, 'clone', '-c', 'core.autocrlf=false', origin, work);
    process.chdir(work);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(rootDirectory, { force: true, maxRetries: 5, recursive: true });
  });

  describe('rebuildChangelogBranch', () => {
    it('starts at the target tip and restores only CHANGELOG.md from the baseline', () => {
      rebuildChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        releaseBranch: TARGET,
        baseline: STABLE_BASELINE,
      });

      expect(git(work, 'branch', '--show-current')).toBe(CHANGELOG_BRANCH);
      expect(git(work, 'rev-parse', 'HEAD')).toBe(
        git(work, 'rev-parse', `origin/${TARGET}`),
      );
      expect(readFileSync(join(work, 'CHANGELOG.md'), 'utf8')).toBe(
        stableChangelog,
      );
      expect(readFileSync(join(work, 'code.txt'), 'utf8')).toBe('target\n');
      expect(git(work, 'status', '--porcelain', '--untracked-files=no')).toBe(
        'M  CHANGELOG.md',
      );
    });

    it('discards stale code from an existing changelog branch', () => {
      git(
        work,
        'checkout',
        '-B',
        CHANGELOG_BRANCH,
        `origin/${CHANGELOG_BRANCH}`,
      );
      expect(readFileSync(join(work, 'code.txt'), 'utf8')).toBe('stale\n');

      rebuildChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        releaseBranch: TARGET,
        baseline: STABLE_BASELINE,
      });

      expect(readFileSync(join(work, 'code.txt'), 'utf8')).toBe('target\n');
    });

    it('does not leave the rebuilt branch tracking the remote', () => {
      rebuildChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        releaseBranch: TARGET,
        baseline: STABLE_BASELINE,
      });

      expect(() =>
        git(work, 'config', '--get', `branch.${CHANGELOG_BRANCH}.remote`),
      ).toThrow();
    });

    it('fails when the baseline has no CHANGELOG.md', () => {
      expect(() =>
        rebuildChangelogBranch({
          changelogBranch: CHANGELOG_BRANCH,
          releaseBranch: TARGET,
          baseline: {
            kind: 'release',
            ref: 'origin/no-changelog',
            version: '13.50.0',
          },
        }),
      ).toThrow(/does not contain CHANGELOG\.md/u);
    });
  });

  describe('getReviewedCurrentReleaseSection', () => {
    const input = {
      changelogBranch: CHANGELOG_BRANCH,
      releaseBranch: TARGET,
      version: '13.51.0',
    };

    it('returns undefined on a first run', () => {
      expect(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: undefined,
          getOpenPrNumber: () => {
            throw new Error('must not query PRs on a first run');
          },
        }),
      ).toBe(undefined);
    });

    it('refuses a stale changelog branch that has no open PR', () => {
      expect(() =>
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          getOpenPrNumber: () => undefined,
        }),
      ).toThrow(/exists without an open PR/u);
    });

    it('regenerates a branch without an open PR when only the updater committed to it', () => {
      expect(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          isUpdaterOnlyBranch: () => true,
          getOpenPrNumber: () => undefined,
        }),
      ).toBe(undefined);
    });

    it('strips trailing whitespace from a reviewed section', () => {
      commitFiles(
        seed,
        CHANGELOG_BRANCH,
        {
          'CHANGELOG.md': releaseChangelog.replace('(#101)', '(#101)  '),
        },
        { from: TARGET },
      );
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      expect(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          getOpenPrNumber: () => '7',
        }) ?? '',
      ).not.toMatch(/[ \t]$/mu);
    });

    it('ignores a branch without an open PR when the target already has the section', () => {
      expect(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          allowMissingOpenPr: true,
          getOpenPrNumber: () => undefined,
        }),
      ).toBe(undefined);
    });

    it('still preserves an open PR when the target already has the section', () => {
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      expect(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          allowMissingOpenPr: true,
          getOpenPrNumber: () => '7',
        }) ?? '',
      ).toMatch(/Added a reviewed feature \(#101\)/u);
    });

    it('refuses an open changelog branch that lacks the current heading', () => {
      expect(() =>
        getReviewedCurrentReleaseSection({
          ...input,
          version: '13.52.0',
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          getOpenPrNumber: () => '7',
        }),
      ).toThrow(/lacks 13\.52\.0/u);
    });

    it('returns the reviewed section from an open changelog branch', () => {
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      expect(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          getOpenPrNumber: (head, base) => {
            expect(head).toBe(CHANGELOG_BRANCH);
            expect(base).toBe(TARGET);
            return '7';
          },
        }),
      ).toBe(`## [13.51.0]

### Added

- Added a reviewed feature (#101)`);
    });
  });

  describe('pushChangelogBranch', () => {
    /**
     * Creates a local changelog branch with one local commit.
     */
    function startLocalBranch(): void {
      git(work, 'checkout', '-B', CHANGELOG_BRANCH, `origin/${TARGET}`);
      writeFileSync(join(work, 'CHANGELOG.md'), 'local\n');
      git(work, 'add', 'CHANGELOG.md');
      git(work, 'commit', '-m', 'local changelog');
    }

    it('rejects when the changelog branch moved after the lease was recorded', () => {
      const leasedSha = getRemoteBranchSha(CHANGELOG_BRANCH);
      git(seed, 'checkout', CHANGELOG_BRANCH);
      writeFileSync(join(seed, 'CHANGELOG.md'), 'concurrent edit\n');
      git(seed, 'commit', '-am', 'concurrent edit');
      git(seed, 'push', 'origin', CHANGELOG_BRANCH);
      const movedSha = getRemoteBranchSha(CHANGELOG_BRANCH);
      startLocalBranch();

      expect(() =>
        pushChangelogBranch({
          changelogBranch: CHANGELOG_BRANCH,
          expectedRemoteSha: leasedSha,
        }),
      ).toThrow(/changed after this run began/u);
      expect(getRemoteBranchSha(CHANGELOG_BRANCH)).toBe(movedSha);
    });

    it('rewrites the branch when the lease still matches', () => {
      const leasedSha = getRemoteBranchSha(CHANGELOG_BRANCH);
      startLocalBranch();

      pushChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        expectedRemoteSha: leasedSha,
      });

      expect(getRemoteBranchSha(CHANGELOG_BRANCH)).toBe(
        git(work, 'rev-parse', 'HEAD'),
      );
    });

    it('creates a new branch and then refuses a racing creation', () => {
      const newBranch = 'release-changelog/99.0.0';
      git(work, 'checkout', '-B', newBranch, `origin/${TARGET}`);
      writeFileSync(join(work, 'CHANGELOG.md'), 'new\n');
      git(work, 'add', 'CHANGELOG.md');
      git(work, 'commit', '-m', 'new changelog');

      pushChangelogBranch({
        changelogBranch: newBranch,
        expectedRemoteSha: undefined,
      });
      expect(getRemoteBranchSha(newBranch)).toBe(
        git(work, 'rev-parse', 'HEAD'),
      );

      git(work, 'commit', '--allow-empty', '-m', 'second');
      expect(() =>
        pushChangelogBranch({
          changelogBranch: newBranch,
          expectedRemoteSha: undefined,
        }),
      ).toThrow(/may have been created concurrently/u);
    });
  });

  describe('hasSameChangelogAsRemoteBranch', () => {
    it('ignores other files that changed on the release branch', () => {
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      const remoteSha = getRemoteBranchSha(CHANGELOG_BRANCH) as string;
      git(
        work,
        'checkout',
        '-B',
        CHANGELOG_BRANCH,
        `origin/${CHANGELOG_BRANCH}`,
      );
      writeFileSync(join(work, 'code.txt'), 'release moved\n');
      git(work, 'commit', '-am', 'same changelog, other file moved');

      expect(hasSameChangelogAsRemoteBranch(CHANGELOG_BRANCH, remoteSha)).toBe(
        true,
      );
    });

    it('recognizes a rebuilt commit with identical content', () => {
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      const remoteSha = getRemoteBranchSha(CHANGELOG_BRANCH) as string;
      git(
        work,
        'checkout',
        '-B',
        CHANGELOG_BRANCH,
        `origin/${CHANGELOG_BRANCH}`,
      );
      git(work, 'commit', '--amend', '-m', 'rebuilt with a new hash');

      expect(git(work, 'rev-parse', 'HEAD')).not.toBe(remoteSha);
      expect(hasSameChangelogAsRemoteBranch(CHANGELOG_BRANCH, remoteSha)).toBe(
        true,
      );
    });

    it('rejects changed content and a stale expected tip', () => {
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      const remoteSha = getRemoteBranchSha(CHANGELOG_BRANCH) as string;
      git(
        work,
        'checkout',
        '-B',
        CHANGELOG_BRANCH,
        `origin/${CHANGELOG_BRANCH}`,
      );

      expect(
        hasSameChangelogAsRemoteBranch(CHANGELOG_BRANCH, 'f'.repeat(40)),
      ).toBe(false);

      writeFileSync(join(work, 'CHANGELOG.md'), 'edited\n');
      git(work, 'commit', '-am', 'edit');
      expect(hasSameChangelogAsRemoteBranch(CHANGELOG_BRANCH, remoteSha)).toBe(
        false,
      );
    });
  });

  describe('getChangelogBranchCommits', () => {
    /**
     * Pushes a changelog branch commit made with the given message arguments.
     *
     * @param messageArguments - The `-m` arguments for the commit.
     */
    function pushCommit(...messageArguments: string[]): void {
      git(work, 'checkout', '-B', CHANGELOG_BRANCH, `origin/${TARGET}`);
      writeFileSync(join(work, 'CHANGELOG.md'), 'changed\n');
      git(work, 'add', 'CHANGELOG.md');
      git(work, 'commit', ...messageArguments);
      git(work, 'push', '--force', 'origin', CHANGELOG_BRANCH);
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
    }

    it('reads the unproofread marker from the commit trailer', () => {
      pushCommit(
        '-m',
        'update changelog for 13.51.0',
        '-m',
        'Changelog-Proofread: failed',
      );

      expect(
        getChangelogBranchCommits(CHANGELOG_BRANCH, TARGET).map(
          ({ subject, unproofread }) => ({ subject, unproofread }),
        ),
      ).toStrictEqual([
        { subject: 'update changelog for 13.51.0', unproofread: true },
      ]);
    });

    it('reports no marker on a commit without the trailer', () => {
      pushCommit('-m', 'update changelog for 13.51.0');

      expect(
        getChangelogBranchCommits(CHANGELOG_BRANCH, TARGET).map(
          ({ unproofread }) => unproofread,
        ),
      ).toStrictEqual([false]);
    });

    it('reads the release tip a run generated through, next to the other trailer', () => {
      const tip = git(work, 'rev-parse', `origin/${TARGET}`);
      pushCommit(
        '-m',
        'update changelog for 13.51.0',
        '-m',
        `Changelog-Generated-Through: ${tip}\nChangelog-Proofread: failed`,
      );

      expect(
        getChangelogBranchCommits(CHANGELOG_BRANCH, TARGET).map(
          ({ generatedThrough, unproofread }) => ({
            generatedThrough,
            unproofread,
          }),
        ),
      ).toStrictEqual([{ generatedThrough: tip, unproofread: true }]);
    });

    it('ignores a generated-through value that is not a commit SHA', () => {
      pushCommit(
        '-m',
        'update changelog for 13.51.0',
        '-m',
        'Changelog-Generated-Through: not-a-sha',
      );

      expect(
        getChangelogBranchCommits(CHANGELOG_BRANCH, TARGET)[0]
          ?.generatedThrough,
      ).toBe(undefined);
    });
  });

  describe('assertRemoteRefUnchanged', () => {
    it('accepts an unchanged ref and rejects a moved one', () => {
      const sha = getRemoteBranchSha(TARGET);
      if (sha === undefined) {
        throw new Error('Expected the target release branch to exist');
      }
      expect(() =>
        assertRemoteRefUnchanged({
          ref: `origin/${TARGET}`,
          expectedSha: sha,
          description: 'Target release branch',
        }),
      ).not.toThrow();

      git(seed, 'checkout', TARGET);
      git(seed, 'commit', '--allow-empty', '-m', 'move target');
      git(seed, 'push', 'origin', TARGET);

      expect(() =>
        assertRemoteRefUnchanged({
          ref: `origin/${TARGET}`,
          expectedSha: sha,
          description: 'Target release branch',
        }),
      ).toThrow(/changed during changelog generation/u);
    });
  });
});
