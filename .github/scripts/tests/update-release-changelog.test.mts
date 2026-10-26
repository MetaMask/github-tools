import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertReleaseSectionHasEntries,
  findReleaseVersionsContainingPrs,
  getAutoChangelogCli,
  getAcceptedPrCommits,
  getChangelogValidationArguments,
  getChangelogPushArguments,
  getDeletedPrNumbers,
  getChangelogPrPresentation,
  getHistoricalSkippedPrNumbers,
  isReleaseSectionEmpty,
  hasOnlyUpdaterCommits,
  isUntouchedUnproofreadChangelogPr,
  parseUpdateChangelogArguments,
  shouldKeepChangelogPrPresentation,
  validateGeneratedReleaseSection,
  writeFailedProofreadingReport,
} from '../update-release-changelog.mts';

test('records the failure stage in the proofread report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proofread-report-'));
  try {
    const reportPath = join(directory, 'nested', 'report.json');
    writeFailedProofreadingReport(reportPath, 'no key', 'authentication');
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), {
      status: 'failed',
      stage: 'authentication',
      error: 'no key',
    });
    writeFailedProofreadingReport(reportPath, 'boom');
    assert.equal(
      (JSON.parse(readFileSync(reportPath, 'utf8')) as { stage: string }).stage,
      'execution',
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('collects historical skipped PRs from auto-changelog diagnostics', () => {
  assert.deepEqual(
    getHistoricalSkippedPrNumbers(`[auto-changelog] skipped pr=35695 reason=historical-pr
[auto-changelog] commit=abc accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] skipped pr=35716 reason=historical-pr
[auto-changelog] skipped pr=35695 reason=historical-pr
[auto-changelog] skipped pr=9 reason=cherry-pick-duplicate`),
    ['35695', '35716'],
  );
  assert.deepEqual(getHistoricalSkippedPrNumbers(''), []);
});

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);

test('collects the accepted commits of each canonical PR', () => {
  assert.deepEqual(
    [
      ...getAcceptedPrCommits(`[auto-changelog] commit=${COMMIT_A} accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] commit=${COMMIT_B} accepted source-pr=7 canonical-pr=1 cherry-pick=true
[auto-changelog] commit=${COMMIT_C} accepted source-pr=2 canonical-pr=2 cherry-pick=false
[auto-changelog] skipped pr=9 reason=cherry-pick-duplicate`),
    ],
    [
      ['1', [COMMIT_A, COMMIT_B]],
      ['2', [COMMIT_C]],
    ],
  );
});

test('treats a PR generated before the last tip but missing from the section as deleted', () => {
  const options = {
    acceptedCommitsByPr: new Map([
      ['1', [COMMIT_A]],
      ['2', [COMMIT_B]],
      ['3', [COMMIT_C]],
      ['4', [COMMIT_A, COMMIT_C]],
    ]),
    generatedThrough: 'd'.repeat(40),
    listReachableCommits: () => [COMMIT_A, COMMIT_B],
  };

  assert.deepEqual(
    getDeletedPrNumbers({
      ...options,
      existingPrNumbers: new Set(['1']),
    }),
    new Set(['2']),
  );
  assert.deepEqual(
    getDeletedPrNumbers({
      ...options,
      existingPrNumbers: new Set(['1', '2']),
    }),
    new Set(),
  );
});

test('treats nothing as deleted when the last tip cannot be read', () => {
  assert.deepEqual(
    getDeletedPrNumbers({
      acceptedCommitsByPr: new Map([['1', [COMMIT_A]]]),
      generatedThrough: 'd'.repeat(40),
      existingPrNumbers: new Set(),
      listReachableCommits: () => {
        throw new Error('unknown revision');
      },
    }),
    new Set(),
  );
});

test('finds the releases that already list a PR, oldest first, excluding the target', () => {
  const changelog = `# Changelog

## [Unreleased]

- Mentions #35716 outside a release

## [8.11.0]

### Added

- Added a notice (#35716)
- Updated dependencies ([#35695](https://example.test/pull/35695))

## [8.10.3]

## [8.9.0]

- Added an older feature (#35695)

## [8.8.0]

- Unrelated (#1)
`;
  assert.deepEqual(
    findReleaseVersionsContainingPrs(changelog, ['35695', '35716'], '8.10.3'),
    ['8.9.0', '8.11.0'],
  );
  assert.deepEqual(
    findReleaseVersionsContainingPrs(changelog, ['35716'], '8.11.0'),
    [],
  );
});

test('finds versions that document a PR with this repository long link', () => {
  const changelog = `# Changelog

## [8.9.0]

- Added a feature ([#35695](https://github.com/MetaMask/metamask-mobile/pull/35695))

## [8.8.0]

- Other repo ([#35695](https://github.com/MetaMask/core/pull/35695))
`;
  const repositoryUrl = 'https://github.com/MetaMask/metamask-mobile';

  assert.deepEqual(
    findReleaseVersionsContainingPrs(
      changelog,
      ['35695'],
      '8.10.3',
      repositoryUrl,
    ),
    ['8.9.0'],
  );
  assert.deepEqual(
    findReleaseVersionsContainingPrs(changelog, ['35695'], '8.10.3'),
    [],
  );
});

test('detects a release section without entries', () => {
  assert.equal(
    isReleaseSectionEmpty(
      '# Changelog\n\n## [8.10.3]\n\n## [8.10.2]\n',
      '8.10.3',
    ),
    true,
  );
  assert.equal(
    isReleaseSectionEmpty(
      '# Changelog\n\n## [8.10.3]\n\n### Fixed\n\n- Fixed it (#1)\n\n## [8.10.2]\n',
      '8.10.3',
    ),
    false,
  );
});

test('asks for a manual edit when an OTA release has no new PRs', () => {
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '8.10.3',
      changelogBranch: 'release-changelog/8.10.3',
      proofreadingStatus: 'no-new-prs',
      presentInVersions: ['8.11.0', '8.12.0'],
    }),
    {
      title:
        'release: release-changelog/8.10.3 (no new PRs, manual edit required)',
      body: 'This PR updates the change log for 8.10.3.\n\n> There are no brand new PRs in 8.10.3, there are only cherry-picks that were already present in 8.11.0, 8.12.0. Please decide how you want to handle this and edit the changelog manually.',
    },
  );
  assert.match(
    getChangelogPrPresentation({
      version: '8.10.3',
      changelogBranch: 'release-changelog/8.10.3',
      proofreadingStatus: 'no-new-prs',
    }).body,
    /There are no brand new PRs in 8\.10\.3\. Please decide/u,
  );
});

test('parses dry-run without changing positional arguments', () => {
  assert.deepEqual(
    parseUpdateChangelogArguments([
      '--dry-run',
      'release/13.51.0',
      'extension',
      'https://github.com/MetaMask/metamask-extension',
    ]),
    {
      dryRun: true,
      positionalArguments: [
        'release/13.51.0',
        'extension',
        'https://github.com/MetaMask/metamask-extension',
      ],
    },
  );
});

test('requires a pinned auto-changelog source CLI', () => {
  assert.equal(
    getAutoChangelogCli({ AUTO_CHANGELOG_CLI: '/tmp/auto-changelog.mjs' }),
    '/tmp/auto-changelog.mjs',
  );
  assert.throws(
    () => getAutoChangelogCli({}),
    /AUTO_CHANGELOG_CLI must point/u,
  );
});

test('uses the standard validator when clean-room proofreading fails', () => {
  assert.deepEqual(getChangelogValidationArguments('failed', '13.51.0'), [
    'validate',
    '--prettier',
    '--currentVersion',
    '13.51.0',
  ]);
  assert.deepEqual(getChangelogValidationArguments('succeeded', '13.51.0'), [
    'validate',
    '--prettier',
    '--currentVersion',
    '13.51.0',
    '--rc',
  ]);
});

test('protects first changelog branch creation with an empty lease', () => {
  assert.deepEqual(
    getChangelogPushArguments({
      changelogBranch: 'release-changelog/13.51.0',
      expectedRemoteSha: undefined,
    }),
    [
      'push',
      '--force-with-lease=refs/heads/release-changelog/13.51.0:',
      '--set-upstream',
      'origin',
      'HEAD:refs/heads/release-changelog/13.51.0',
    ],
  );
});

const RUN_ENVIRONMENT_NAMES = [
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
] as const;

/**
 * Runs a callback with the GitHub Actions run variables set or removed, so the
 * result does not depend on whether the tests run in CI.
 *
 * @param values - The values to set, or undefined to remove them.
 * @param callback - The code to run.
 * @returns The callback's result.
 */
function withRunEnvironment<Result>(
  values: Record<(typeof RUN_ENVIRONMENT_NAMES)[number], string> | undefined,
  callback: () => Result,
): Result {
  const original = Object.fromEntries(
    RUN_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of RUN_ENVIRONMENT_NAMES) {
      if (values) {
        process.env[name] = values[name];
      } else {
        delete process.env[name];
      }
    }
    return callback();
  } finally {
    for (const name of RUN_ENVIRONMENT_NAMES) {
      if (original[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original[name];
      }
    }
  }
}

test('marks an unproofread changelog PR when AI proofreading fails', () => {
  const presentation = withRunEnvironment(undefined, () =>
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      proofreadingStatus: 'failed',
      proofreadingStage: 'authentication',
    }),
  );

  assert.deepEqual(presentation, {
    title:
      'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
    body: 'This PR updates the change log for 13.51.0.\n\n> AI automation failed during authentication, not proofread. The deterministic changelog generation, reference validation, and changelog lint passed. Review the release section manually before merging.',
  });
});

test('links the proofreading report artifact when run in GitHub Actions', () => {
  const { body } = withRunEnvironment(
    {
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'MetaMask/metamask-extension',
      GITHUB_RUN_ID: '123',
    },
    () =>
      getChangelogPrPresentation({
        version: '13.51.0',
        changelogBranch: 'release-changelog/13.51.0',
        proofreadingStatus: 'failed',
      }),
  );

  assert.match(
    body,
    /\[View the proofreading report artifact\.\]\(https:\/\/github\.com\/MetaMask\/metamask-extension\/actions\/runs\/123#artifacts\)/u,
  );
});

test('preserves authentication failures for the unproofread PR warning', () => {
  const authenticationFailure = {
    status: 'failed' as const,
    stage: 'authentication',
  };
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      proofreadingStatus: authenticationFailure.status,
      proofreadingStage: authenticationFailure.stage,
    }).title,
    'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
  );
});

test('uses the plain presentation after a successful proofread', () => {
  assert.deepEqual(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      proofreadingStatus: 'succeeded',
    }),
    {
      title: 'release: release-changelog/13.51.0',
      body: 'This PR updates the change log for 13.51.0.',
    },
  );
});

test('explains an empty release section instead of deferring to the validator', () => {
  assert.throws(
    () =>
      assertReleaseSectionHasEntries(
        '# Changelog\n\n## [8.10.3]\n\n## [8.10.2]\n',
        '8.10.3',
      ),
    /## \[8\.10\.3\] has no entries/u,
  );
  assert.doesNotThrow(() =>
    assertReleaseSectionHasEntries(
      '# Changelog\n\n## [8.10.3]\n\n### Fixed\n\n- Fixed it (#1)\n',
      '8.10.3',
    ),
  );
});

test('leaves an existing changelog PR alone when nothing changed', () => {
  assert.equal(
    shouldKeepChangelogPrPresentation({
      existingTitle: 'release: release-changelog/13.51.0',
      proofreadingStatus: 'unchanged',
    }),
    true,
  );
});

test('keeps the AI failure marker when a later run proofreads only new entries', () => {
  const existingTitle =
    'release: release-changelog/13.51.0 (AI automation failed, not proofread)';

  assert.equal(
    shouldKeepChangelogPrPresentation({
      existingTitle,
      proofreadingStatus: 'succeeded',
    }),
    true,
  );
  assert.equal(
    shouldKeepChangelogPrPresentation({
      existingTitle,
      proofreadingStatus: 'failed',
    }),
    false,
  );
});

test('rewrites the AI failure marker when the whole section was proofread again', () => {
  assert.equal(
    shouldKeepChangelogPrPresentation({
      existingTitle:
        'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
      proofreadingStatus: 'succeeded',
      replacesWholeSection: true,
    }),
    false,
  );
});

test("regenerates only an unproofread PR whose sole commit is the updater's own", () => {
  const options = {
    title:
      'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
    version: '13.51.0',
    authorEmail: 'bot@example.com',
    commits: [
      {
        authorEmail: 'bot@example.com',
        subject: 'update changelog for 13.51.0',
        unproofread: true,
      },
    ],
  };

  assert.equal(isUntouchedUnproofreadChangelogPr(options), true);
  assert.equal(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      commits: [
        {
          authorEmail: 'bot@example.com',
          subject: 'update changelog for 13.51.0',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      title: 'release: release-changelog/13.51.0',
    }),
    false,
  );
  assert.equal(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      commits: [
        ...options.commits,
        { authorEmail: 'person@example.com', subject: 'fix wording' },
      ],
    }),
    false,
  );
  assert.equal(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      commits: [
        {
          authorEmail: 'person@example.com',
          subject: 'update changelog for 13.51.0',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isUntouchedUnproofreadChangelogPr({ ...options, commits: [] }),
    false,
  );
});

test("recovers a branch only when every commit is the updater's own", () => {
  const own = {
    authorEmail: 'bot@example.com',
    subject: 'update changelog for 13.51.0',
  };
  const options = {
    version: '13.51.0',
    authorEmail: 'bot@example.com',
    commits: [own],
  };

  assert.equal(hasOnlyUpdaterCommits(options), true);
  assert.equal(
    hasOnlyUpdaterCommits({
      ...options,
      commits: [
        own,
        { authorEmail: 'person@example.com', subject: 'fix wording' },
      ],
    }),
    false,
  );
});

test('rewrites the PR presentation after a normal successful run', () => {
  assert.equal(
    shouldKeepChangelogPrPresentation({
      existingTitle: 'release: release-changelog/13.51.0',
      proofreadingStatus: 'succeeded',
    }),
    false,
  );
});

test('rejects generated sections with missing or duplicate PR references', () => {
  assert.throws(
    () =>
      validateGeneratedReleaseSection(
        `## [13.51.0]

### Fixed

- Fixed an issue`,
        '13.51.0',
      ),
    /without a PR reference/u,
  );
  assert.throws(
    () =>
      validateGeneratedReleaseSection(
        `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)`,
        '13.51.0',
      ),
    /duplicate PR references/u,
  );
  assert.doesNotThrow(() =>
    validateGeneratedReleaseSection(
      `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)`,
      '13.51.0',
      true,
    ),
  );
});
