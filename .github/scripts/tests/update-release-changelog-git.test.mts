import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  assertRemoteRefUnchanged,
  getRemoteBranchSha,
  getReviewedCurrentReleaseSection,
  pushChangelogBranch,
  rebuildChangelogBranch,
} from '../update-release-changelog.mts';

const TARGET = 'release/13.51.0';
const CHANGELOG_BRANCH = 'release-changelog/13.51.0';
const STABLE_BASELINE = {
  kind: 'stable' as const,
  ref: 'origin/stable',
  version: '13.50.0',
};

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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
  let root: string;
  let seed: string;
  let work: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'release-changelog-test-'));
    const origin = join(root, 'origin.git');
    seed = join(root, 'seed');
    work = join(root, 'work');
    mkdirSync(seed);
    git(root, 'init', '--bare', '-b', 'main', origin);
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

    git(root, 'clone', '-c', 'core.autocrlf=false', origin, work);
    process.chdir(work);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { force: true, maxRetries: 5, recursive: true });
  });

  describe('rebuildChangelogBranch', () => {
    it('starts at the target tip and restores only CHANGELOG.md from the baseline', () => {
      rebuildChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        releaseBranch: TARGET,
        baseline: STABLE_BASELINE,
      });

      assert.equal(git(work, 'branch', '--show-current'), CHANGELOG_BRANCH);
      assert.equal(
        git(work, 'rev-parse', 'HEAD'),
        git(work, 'rev-parse', `origin/${TARGET}`),
      );
      assert.equal(
        readFileSync(join(work, 'CHANGELOG.md'), 'utf8'),
        stableChangelog,
      );
      assert.equal(readFileSync(join(work, 'code.txt'), 'utf8'), 'target\n');
      assert.equal(
        git(work, 'status', '--porcelain', '--untracked-files=no'),
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
      assert.equal(readFileSync(join(work, 'code.txt'), 'utf8'), 'stale\n');

      rebuildChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        releaseBranch: TARGET,
        baseline: STABLE_BASELINE,
      });

      assert.equal(readFileSync(join(work, 'code.txt'), 'utf8'), 'target\n');
    });

    it('does not leave the rebuilt branch tracking the remote', () => {
      rebuildChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        releaseBranch: TARGET,
        baseline: STABLE_BASELINE,
      });

      assert.throws(() =>
        git(work, 'config', '--get', `branch.${CHANGELOG_BRANCH}.remote`),
      );
    });

    it('fails when the baseline has no CHANGELOG.md', () => {
      assert.throws(
        () =>
          rebuildChangelogBranch({
            changelogBranch: CHANGELOG_BRANCH,
            releaseBranch: TARGET,
            baseline: {
              kind: 'release',
              ref: 'origin/no-changelog',
              version: '13.50.0',
            },
          }),
        /does not contain CHANGELOG\.md/u,
      );
    });
  });

  describe('getReviewedCurrentReleaseSection', () => {
    const input = {
      changelogBranch: CHANGELOG_BRANCH,
      releaseBranch: TARGET,
      version: '13.51.0',
    };

    it('returns undefined on a first run', () => {
      assert.equal(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: undefined,
          getOpenPrNumber: () => {
            throw new Error('must not query PRs on a first run');
          },
        }),
        undefined,
      );
    });

    it('refuses a stale changelog branch that has no open PR', () => {
      assert.throws(
        () =>
          getReviewedCurrentReleaseSection({
            ...input,
            changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
            getOpenPrNumber: () => undefined,
          }),
        /exists without an open PR/u,
      );
    });

    it('refuses an open changelog branch that lacks the current heading', () => {
      assert.throws(
        () =>
          getReviewedCurrentReleaseSection({
            ...input,
            version: '13.52.0',
            changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
            getOpenPrNumber: () => '7',
          }),
        /lacks 13\.52\.0/u,
      );
    });

    it('returns the reviewed section from an open changelog branch', () => {
      git(work, 'fetch', 'origin', CHANGELOG_BRANCH);
      assert.equal(
        getReviewedCurrentReleaseSection({
          ...input,
          changelogBranchSha: getRemoteBranchSha(CHANGELOG_BRANCH),
          getOpenPrNumber: (head, base) => {
            assert.equal(head, CHANGELOG_BRANCH);
            assert.equal(base, TARGET);
            return '7';
          },
        }),
        `## [13.51.0]

### Added

- Added a reviewed feature (#101)`,
      );
    });
  });

  describe('pushChangelogBranch', () => {
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

      assert.throws(
        () =>
          pushChangelogBranch({
            changelogBranch: CHANGELOG_BRANCH,
            expectedRemoteSha: leasedSha,
          }),
        /changed after this run began/u,
      );
      assert.equal(getRemoteBranchSha(CHANGELOG_BRANCH), movedSha);
    });

    it('rewrites the branch when the lease still matches', () => {
      const leasedSha = getRemoteBranchSha(CHANGELOG_BRANCH);
      startLocalBranch();

      pushChangelogBranch({
        changelogBranch: CHANGELOG_BRANCH,
        expectedRemoteSha: leasedSha,
      });

      assert.equal(
        getRemoteBranchSha(CHANGELOG_BRANCH),
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
      assert.equal(
        getRemoteBranchSha(newBranch),
        git(work, 'rev-parse', 'HEAD'),
      );

      git(work, 'commit', '--allow-empty', '-m', 'second');
      assert.throws(
        () =>
          pushChangelogBranch({
            changelogBranch: newBranch,
            expectedRemoteSha: undefined,
          }),
        /may have been created concurrently/u,
      );
    });
  });

  describe('assertRemoteRefUnchanged', () => {
    it('accepts an unchanged ref and rejects a moved one', () => {
      const sha = getRemoteBranchSha(TARGET);
      assert.ok(sha);
      assert.doesNotThrow(() =>
        assertRemoteRefUnchanged({
          ref: `origin/${TARGET}`,
          expectedSha: sha,
          description: 'Target release branch',
        }),
      );

      git(seed, 'checkout', TARGET);
      git(seed, 'commit', '--allow-empty', '-m', 'move target');
      git(seed, 'push', 'origin', TARGET);

      assert.throws(
        () =>
          assertRemoteRefUnchanged({
            ref: `origin/${TARGET}`,
            expectedSha: sha,
            description: 'Target release branch',
          }),
        /changed during changelog generation/u,
      );
    });
  });
});
