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
import { join } from 'node:path';
import test from 'node:test';

const SCRIPT_PATH = join(
  process.cwd(),
  '.github',
  'scripts',
  'merge-previous-releases.sh',
);

function git(directory: string, ...argumentsList: string[]): string {
  return execFileSync('git', argumentsList, {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function createReleaseMergeFixture({
  sourceChangelog,
  destinationChangelog,
}: {
  sourceChangelog: string;
  destinationChangelog: string;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'previous-release-merge-'));
  const remoteDirectory = join(directory, 'origin.git');
  const seedDirectory = join(directory, 'seed');
  const workDirectory = join(directory, 'work');
  const binDirectory = join(directory, 'bin');

  git(directory, 'init', '--bare', remoteDirectory);
  git(directory, 'clone', remoteDirectory, seedDirectory);
  git(seedDirectory, 'config', 'user.name', 'Test User');
  git(seedDirectory, 'config', 'user.email', 'test@example.com');
  writeFileSync(
    join(seedDirectory, 'CHANGELOG.md'),
    '# Changelog\n\n## [13.53.0]\n\n- Existing entry (#1)\n',
  );
  git(seedDirectory, 'add', 'CHANGELOG.md');
  git(seedDirectory, 'commit', '-m', 'Initial changelog');
  git(seedDirectory, 'branch', '-M', 'main');
  git(seedDirectory, 'push', 'origin', 'main');

  git(seedDirectory, 'switch', '-c', 'release/13.54.0');
  writeFileSync(join(seedDirectory, 'CHANGELOG.md'), sourceChangelog);
  git(seedDirectory, 'add', 'CHANGELOG.md');
  git(seedDirectory, 'commit', '-m', 'Add 13.54.0 changelog');
  git(seedDirectory, 'push', 'origin', 'release/13.54.0');

  git(seedDirectory, 'switch', 'main');
  git(seedDirectory, 'switch', '-c', 'release/13.55.0');
  writeFileSync(join(seedDirectory, 'CHANGELOG.md'), destinationChangelog);
  git(seedDirectory, 'add', 'CHANGELOG.md');
  git(seedDirectory, 'commit', '-m', 'Add destination changelog entry');
  git(seedDirectory, 'push', 'origin', 'release/13.55.0');

  git(directory, 'clone', remoteDirectory, workDirectory);
  git(workDirectory, 'switch', 'release/13.55.0');
  mkdirSync(binDirectory);
  const ghPath = join(binDirectory, 'gh');
  writeFileSync(
    ghPath,
    '#!/usr/bin/env bash\nprintf "%s\\n" release/13.54.0\n',
  );
  chmodSync(ghPath, 0o755);

  return {
    directory,
    workDirectory,
    run: () =>
      execFileSync('bash', [SCRIPT_PATH], {
        cwd: workDirectory,
        env: {
          ...process.env,
          NEW_RELEASE_BRANCH: 'release/13.55.0',
          GITHUB_TOKEN: 'test-token',
          PATH: `${binDirectory};${process.env.PATH ?? ''}`,
        },
        stdio: 'pipe',
      }),
  };
}

test('preserves changelog history from an older active release branch', () => {
  const fixture = createReleaseMergeFixture({
    sourceChangelog:
      '# Changelog\n\n## [13.54.0]\n\n- Released entry (#2)\n\n## [13.53.0]\n\n- Existing entry (#1)\n\n[13.54.0]: https://example.com/13.54.0\n[13.53.0]: https://example.com/13.53.0\n',
    destinationChangelog:
      '# Changelog\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n\n[13.53.0]: https://example.com/13.53.0\n',
  });

  try {
    fixture.run();
    const changelog = readFileSync(
      join(fixture.workDirectory, 'CHANGELOG.md'),
      'utf8',
    );
    assert.match(changelog, /^## \[13\.54\.0\]$/mu);
    assert.match(changelog, /Destination-only entry/u);
    assert.match(
      changelog,
      /^\[13\.54\.0\]: https:\/\/example\.com\/13\.54\.0$/mu,
    );
    assert.doesNotThrow(() => {
      execFileSync(
        'git',
        ['merge-base', '--is-ancestor', 'origin/release/13.54.0', 'HEAD'],
        { cwd: fixture.workDirectory },
      );
    });
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test('preserves destination changelog content when the source section is ambiguous', () => {
  const destinationChangelog =
    '# Changelog\n\n## [13.53.0]\n\n- Destination-only entry (#3)\n';
  const fixture = createReleaseMergeFixture({
    sourceChangelog:
      '# Changelog\n\n## [13.54.0]\n\n- First entry (#2)\n\n## [13.54.0]\n\n- Duplicate entry (#4)\n',
    destinationChangelog,
  });

  try {
    assert.doesNotThrow(() => fixture.run());
    assert.equal(
      readFileSync(join(fixture.workDirectory, 'CHANGELOG.md'), 'utf8'),
      destinationChangelog.replaceAll('\n', '\r\n'),
    );
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});

test('preserves destination changelog content when the destination section is ambiguous', () => {
  const destinationChangelog =
    '# Changelog\n\n## [13.54.0]\n\n- First destination entry (#3)\n\n## [13.54.0]\n\n- Duplicate destination entry (#4)\n';
  const fixture = createReleaseMergeFixture({
    sourceChangelog: '# Changelog\n\n## [13.54.0]\n\n- Released entry (#2)\n',
    destinationChangelog,
  });

  try {
    assert.doesNotThrow(() => fixture.run());
    assert.equal(
      readFileSync(join(fixture.workDirectory, 'CHANGELOG.md'), 'utf8'),
      destinationChangelog.replaceAll('\n', '\r\n'),
    );
  } finally {
    rmSync(fixture.directory, { force: true, recursive: true });
  }
});
