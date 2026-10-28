import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { after } from 'node:test';

const SCRIPT_PATH = join(
  process.cwd(),
  '.github',
  'scripts',
  'merge-previous-releases.sh',
);

const TEMPORARY_DIRECTORY = mkdtempSync(
  join(tmpdir(), 'previous-release-merge-'),
);
after(() => rmSync(TEMPORARY_DIRECTORY, { force: true, recursive: true }));

// CI runners have no global git identity, and the script commits.
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Runs a git command and returns its trimmed output.
 * @param directory - The working directory.
 * @param argumentsList - The git arguments.
 * @returns The trimmed stdout.
 */
function git(directory: string, ...argumentsList: string[]): string {
  return execFileSync('git', argumentsList, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
  }).trim();
}

/**
 * Creates an origin repository with a `main`, an older active release, and a
 * new release branch, plus a clone and a fake `gh` for running the script.
 * @param changelogs - The changelogs for the two release branches.
 * @param changelogs.sourceChangelog - The older release branch's changelog.
 * @param changelogs.destinationChangelog - The new release branch's changelog.
 * @returns The clone directory and functions to run the script and read the
 * resulting changelog.
 */
function createReleaseMergeFixture({
  sourceChangelog,
  destinationChangelog,
}: {
  sourceChangelog: string;
  destinationChangelog: string;
}) {
  const directory = mkdtempSync(join(TEMPORARY_DIRECTORY, 'fixture-'));
  const originDirectory = join(directory, 'origin');
  const workDirectory = join(directory, 'work');
  const binDirectory = join(directory, 'bin');

  git(directory, 'init', '--initial-branch', 'main', originDirectory);
  writeFileSync(
    join(originDirectory, 'CHANGELOG.md'),
    '# Changelog\n\n## [13.53.0]\n\n- Existing entry (#1)\n',
  );
  git(originDirectory, 'add', 'CHANGELOG.md');
  git(originDirectory, 'commit', '-m', 'Initial changelog');

  for (const [branch, changelog] of Object.entries({
    'release/13.54.0': sourceChangelog,
    'release/13.55.0': destinationChangelog,
  })) {
    git(originDirectory, 'switch', '-c', branch, 'main');
    writeFileSync(join(originDirectory, 'CHANGELOG.md'), changelog);
    git(originDirectory, 'commit', '-am', `Update ${branch} changelog`);
  }
  // Leave `main` checked out so the script can push the release branch.
  git(originDirectory, 'switch', 'main');

  // Check out LF on Windows too, matching the Linux runners.
  git(
    directory,
    'clone',
    '-c',
    'core.autocrlf=false',
    '--branch',
    'release/13.55.0',
    originDirectory,
    workDirectory,
  );

  mkdirSync(binDirectory);
  const ghPath = join(binDirectory, 'gh');
  writeFileSync(
    ghPath,
    '#!/usr/bin/env bash\nprintf "%s\\n" release/13.54.0\n',
  );
  chmodSync(ghPath, 0o755);

  return {
    workDirectory,
    run: () =>
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: workDirectory,
        env: {
          ...process.env,
          ...GIT_IDENTITY,
          NEW_RELEASE_BRANCH: 'release/13.55.0',
          GITHUB_TOKEN: 'test-token',
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: 'pipe',
      }),
    readChangelog: () =>
      readFileSync(join(workDirectory, 'CHANGELOG.md'), 'utf8'),
  };
}

test('preserves changelog history from an older active release branch', () => {
  // 13.54.0 is the source's oldest section, so it ends at the link references.
  const fixture = createReleaseMergeFixture({
    sourceChangelog:
      '# Changelog\n\n## [Unreleased]\n\n## [13.54.0]\n\n- Released entry (#2)\n\n[Unreleased]: https://example.com/HEAD\n[13.54.0]: https://example.com/13.54.0\n',
    destinationChangelog:
      '# Changelog\n\n## [Unreleased]\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n\n[Unreleased]: https://example.com/HEAD\n[13.53.0]: https://example.com/13.53.0\n',
  });

  fixture.run();

  assert.equal(
    fixture.readChangelog(),
    '# Changelog\n\n## [Unreleased]\n\n## [13.54.0]\n\n- Released entry (#2)\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n\n[Unreleased]: https://example.com/HEAD\n[13.54.0]: https://example.com/13.54.0\n[13.53.0]: https://example.com/13.53.0\n',
  );
  assert.doesNotThrow(() =>
    git(
      fixture.workDirectory,
      'merge-base',
      '--is-ancestor',
      'origin/release/13.54.0',
      'HEAD',
    ),
  );
});

test('preserves changelog history when the source changelog exceeds the default process buffer', () => {
  // 80,000 lines is about 1.3 MiB, above the 1 MiB default of execFileSync.
  const padding = '- Padding entry (#5)\n'.repeat(80_000);
  const fixture = createReleaseMergeFixture({
    sourceChangelog: `# Changelog\n\n## [13.54.0]\n\n- Released entry (#2)\n\n## [13.52.0]\n\n${padding}`,
    destinationChangelog:
      '# Changelog\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n',
  });

  fixture.run();

  assert.equal(
    fixture.readChangelog(),
    '# Changelog\n\n## [13.54.0]\n\n- Released entry (#2)\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n',
  );
});

test('preserves destination changelog when the source section is ambiguous', () => {
  const destinationChangelog =
    '# Changelog\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n';
  const fixture = createReleaseMergeFixture({
    sourceChangelog:
      '# Changelog\n\n## [13.54.0]\n\n- First entry (#2)\n\n## [13.54.0]\n\n- Duplicate entry (#4)\n',
    destinationChangelog,
  });

  fixture.run();

  assert.equal(fixture.readChangelog(), destinationChangelog);
});

test('preserves destination changelog when it already has the release section', () => {
  const destinationChangelog =
    '# Changelog\n\n## [13.54.0]\n\n- Destination entry (#3)\n';
  const fixture = createReleaseMergeFixture({
    sourceChangelog: '# Changelog\n\n## [13.54.0]\n\n- Released entry (#2)\n',
    destinationChangelog,
  });

  fixture.run();

  assert.equal(fixture.readChangelog(), destinationChangelog);
});
