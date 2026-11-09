import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertReleaseSectionHasEntries,
  excludePrsCherryPickedOntoBaseline,
  findEntriesDroppedByRestore,
  findPrsMissingFromChangelog,
  findReleaseVersionsContainingPrs,
  getAutoChangelogCli,
  getAcceptedPrCommits,
  getChangelogValidationArguments,
  getChangelogPushArguments,
  getDeletedPrNumbers,
  getChangelogPrPresentation,
  getCherryPickAliasesByPr,
  getCherryPickedPrsByCommit,
  getCallingWorkflowPath,
  getDroppedEntriesWarning,
  getHistoricalSkippedPrNumbers,
  getOpenBaselineChangelogSection,
  getPrsCherryPickedOntoBaseline,
  getUnlistedCherryPicksWarning,
  isReleaseSectionEmpty,
  hasOnlyUpdaterCommits,
  hasWorkflowRunForSha,
  isUntouchedUnproofreadChangelogPr,
  parseUpdateChangelogArguments,
  refreshGeneratedWarnings,
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

test('collects the canonical PR of each accepted cherry-pick commit', () => {
  assert.deepEqual(
    [
      ...getCherryPickedPrsByCommit(`[auto-changelog] commit=${COMMIT_A} accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] commit=${COMMIT_B} accepted source-pr=7 canonical-pr=1 cherry-pick=true
[auto-changelog] commit=${COMMIT_C} accepted source-pr=none canonical-pr=none cherry-pick=true`),
    ],
    [[COMMIT_B, '1']],
  );
});

test('finds the PRs cherry-picked onto the baseline branch', () => {
  const cherryPickedPrsByCommit = new Map([
    [COMMIT_A, '1'],
    [COMMIT_B, '2'],
  ]);

  assert.deepEqual(
    getPrsCherryPickedOntoBaseline({
      cherryPickedPrsByCommit,
      baselineRef: 'origin/release/1.0.0',
      isAncestor: (commit, ref) =>
        commit === COMMIT_A && ref === 'origin/release/1.0.0',
    }),
    new Set(['1']),
  );
  assert.deepEqual(
    getPrsCherryPickedOntoBaseline({
      cherryPickedPrsByCommit,
      baselineRef: 'origin/stable',
      isAncestor: () => false,
    }),
    new Set(),
  );
});

test('maps each canonical PR to its cherry-pick PR numbers', () => {
  assert.deepEqual(
    [
      ...getCherryPickAliasesByPr(`[auto-changelog] commit=${COMMIT_A} accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] commit=${COMMIT_B} accepted source-pr=7 canonical-pr=1 cherry-pick=true
[auto-changelog] commit=${COMMIT_C} accepted source-pr=8 canonical-pr=1 cherry-pick=true`),
    ],
    [['1', ['7', '8']]],
  );
});

test('reports PRs that no other section lists under any of their numbers', () => {
  const changelog = [
    '## [2.0.0]',
    '',
    '### Fixed',
    '',
    '- Fixed one (#1)',
    '',
    '## [1.0.0]',
    '',
    '### Fixed',
    '',
    '- Fixed two (#2)',
    '- Fixed three by its cherry-pick (#31)',
    '',
  ].join('\n');

  assert.deepEqual(
    findPrsMissingFromChangelog({
      changelog,
      prNumbers: ['1', '2', '3', '4'],
      aliasesByPr: new Map([['3', ['31']]]),
      version: '2.0.0',
      repositoryUrl: 'https://github.com/MetaMask/example',
    }),
    ['1', '4'],
  );
});

test('counts a pending section of the earlier release as listing a PR', () => {
  const changelog = ['## [2.0.0]', '', '- Fixed one (#1)', ''].join('\n');
  const pendingSection = [
    '## [1.0.0]',
    '',
    '- Fixed two (#2)',
    '- Fixed three by its cherry-pick (#31)',
  ].join('\n');

  assert.deepEqual(
    findPrsMissingFromChangelog({
      changelog,
      pendingSections: [pendingSection],
      prNumbers: ['2', '3', '4'],
      aliasesByPr: new Map([['3', ['31']]]),
      version: '2.0.0',
      repositoryUrl: 'https://github.com/MetaMask/example',
    }),
    ['4'],
  );
});

const RELEASE_BASELINE = {
  kind: 'release',
  ref: 'origin/release/1.0.0',
  version: '1.0.0',
} as const;

test('reads the earlier release section from its open changelog PR', () => {
  const lookups: string[][] = [];

  assert.equal(
    getOpenBaselineChangelogSection({
      baseline: RELEASE_BASELINE,
      determineBranch: (version) => `release-changelog/${version}`,
      getSha: () => 'abc',
      getOpenPrNumber: (...branches) => {
        lookups.push(branches);
        return '9';
      },
      readSection: (branch, version) => `${branch} ${version}`,
    }),
    'release-changelog/1.0.0 1.0.0',
  );
  assert.deepEqual(lookups, [['release-changelog/1.0.0', 'release/1.0.0']]);
});

test('ignores the earlier release changelog when no PR is open', () => {
  const options = {
    baseline: RELEASE_BASELINE,
    determineBranch: (version: string) => `release-changelog/${version}`,
    readSection: () => {
      throw new Error('must not read');
    },
  };

  assert.equal(
    getOpenBaselineChangelogSection({
      ...options,
      getSha: () => undefined,
      getOpenPrNumber: () => '9',
    }),
    undefined,
  );
  assert.equal(
    getOpenBaselineChangelogSection({
      ...options,
      getSha: () => 'abc',
      getOpenPrNumber: () => undefined,
    }),
    undefined,
  );
});

test('only reads an open changelog PR for a release baseline', () => {
  for (const kind of ['stable', 'target'] as const) {
    assert.equal(
      getOpenBaselineChangelogSection({
        baseline: { kind, ref: 'origin/stable', version: '1.0.0' },
        getSha: () => 'abc',
        getOpenPrNumber: () => '9',
        readSection: () => 'section',
      }),
      undefined,
    );
  }
});

test('carries on when the open changelog branch lacks the section', (context) => {
  context.mock.method(console, 'warn', () => undefined);

  assert.equal(
    getOpenBaselineChangelogSection({
      baseline: RELEASE_BASELINE,
      determineBranch: (version) => `release-changelog/${version}`,
      getSha: () => 'abc',
      getOpenPrNumber: () => '9',
      readSection: () => {
        throw new Error('Expected exactly one release heading for 1.0.0');
      },
    }),
    undefined,
  );
});

const RELEASE_BRANCH_CHANGELOG = [
  '## [Unreleased]',
  '',
  '- Unreleased only (#9)',
  '',
  '## [2.0.0]',
  '',
  '### Fixed',
  '',
  '- Fixed one (#1)',
  '- Fixed two (#2)',
  '  - A sub-bullet',
  '',
  '## [1.0.0]',
  '',
  '- Fixed three (#3)',
  '- Fixed four (#4)',
  '',
].join('\n');

test('finds released entries a stale baseline restore drops', () => {
  const restoredChangelog = [
    '## [2.0.0]',
    '',
    '- Fixed one (#1)',
    '',
    '## [1.0.0]',
    '',
    '- Fixed three (#3)',
    '- Fixed four (#4)',
    '',
  ].join('\n');

  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog,
      releaseChangelog: RELEASE_BRANCH_CHANGELOG,
    }),
    [{ version: '2.0.0', entryCount: 1, prNumbers: ['2'] }],
  );
});

test('counts an entry as dropped when only another version lists it', () => {
  const restoredChangelog = [
    '## [2.0.0]',
    '',
    '- Fixed one (#1)',
    '- Fixed two (#2)',
    '- Fixed three (#3)',
    '',
    '## [1.0.0]',
    '',
    '- Fixed four (#4)',
    '',
  ].join('\n');

  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog,
      releaseChangelog: RELEASE_BRANCH_CHANGELOG,
    }),
    [{ version: '1.0.0', entryCount: 1, prNumbers: ['3'] }],
  );
});

test('reports nothing when the restore keeps every released entry', () => {
  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog: `${RELEASE_BRANCH_CHANGELOG}\n## [3.0.0]\n\n- New (#5)\n`,
      releaseChangelog: RELEASE_BRANCH_CHANGELOG,
    }),
    [],
  );
});

test('words the warning for entries the restore dropped', () => {
  assert.equal(
    getDroppedEntriesWarning('8.20.0', {
      baselineVersion: '8.19.0',
      releaseBranch: 'release/8.20.0',
      versions: [
        {
          version: '8.18.0',
          entryCount: 5,
          prNumbers: ['1', '2', '3', '4', '5'],
        },
        { version: '8.17.0', entryCount: 1, prNumbers: ['6'] },
      ],
    }),
    '> Restoring the changelog from the 8.19.0 baseline dropped 6 entries that release/8.20.0 lists under earlier releases: 8.18.0 (5 entries: #1, #2, #3, +2 more); 8.17.0 (1 entry: #6). The 8.19.0 changelog may be stale for 8.20.0; fix it or merge its changelog PR first, then rerun.',
  );
  assert.match(
    getDroppedEntriesWarning('8.20.0', {
      baselineVersion: '8.19.0',
      releaseBranch: 'release/8.20.0',
      versions: [{ version: '8.18.0', entryCount: 1, prNumbers: ['1'] }],
    }),
    /dropped 1 entry that release\/8\.20\.0 lists/u,
  );
});

test('does not count a reworded entry as dropped', () => {
  const releaseChangelog = '## [1.0.0]\n\n- Fixed a crash (#1, #2)\n';
  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog: '## [1.0.0]\n\n- Fixed the crash on launch (#2)\n',
      releaseChangelog,
    }),
    [],
  );
});

test('reads long PR links when comparing dropped entries', () => {
  const repositoryUrl = 'https://github.com/MetaMask/metamask-mobile';
  const link = (number: string): string =>
    `[#${number}](${repositoryUrl}/pull/${number})`;
  const releaseChangelog = `## [1.0.0]\n\n- Fixed a crash (${link('1')})\n- Fixed a hang (${link('2')})\n`;
  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog: `## [1.0.0]\n\n- Fixed the crash on launch (${link('1')})\n`,
      releaseChangelog,
      repositoryUrl,
    }),
    [{ version: '1.0.0', entryCount: 1, prNumbers: ['2'] }],
  );
});

test('compares an entry without a PR number by its text', () => {
  const releaseChangelog = '## [1.0.0]\n\n- Manual note\n';
  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog: '## [1.0.0]\n\n- Other note\n',
      releaseChangelog,
    }),
    [{ version: '1.0.0', entryCount: 1, prNumbers: [] }],
  );
  assert.deepEqual(
    findEntriesDroppedByRestore({
      restoredChangelog: releaseChangelog,
      releaseChangelog,
    }),
    [],
  );
});

test('lists up to three dropped PRs before summarizing the rest', () => {
  const warningFor = (prNumbers: string[]): string =>
    getDroppedEntriesWarning('8.20.0', {
      baselineVersion: '8.19.0',
      releaseBranch: 'release/8.20.0',
      versions: [
        { version: '8.18.0', entryCount: prNumbers.length, prNumbers },
      ],
    });
  assert.match(warningFor(['1', '2', '3']), /\(3 entries: #1, #2, #3\)/u);
  assert.match(
    warningFor(['1', '2', '3', '4']),
    /\(4 entries: #1, #2, #3, \+1 more\)/u,
  );
});

test('adds the dropped entries warning to the PR body', () => {
  const { body } = getChangelogPrPresentation({
    version: '8.20.0',
    changelogBranch: 'release-changelog/8.20.0',
    proofreadingStatus: 'succeeded',
    droppedEntries: {
      baselineVersion: '8.19.0',
      releaseBranch: 'release/8.20.0',
      versions: [{ version: '8.18.0', entryCount: 1, prNumbers: ['1'] }],
    },
  });

  assert.match(body, /^This PR updates the change log for 8\.20\.0\./u);
  assert.match(
    body,
    /\n\n> Restoring the changelog from the 8\.19\.0 baseline/u,
  );
});

test('words the warning for PRs the earlier changelog lacks', () => {
  assert.equal(
    getUnlistedCherryPicksWarning('13.56.0', {
      baselineVersion: '13.55.0',
      prNumbers: ['47395', '47400'],
    }),
    '> #47395, #47400 were left out of 13.56.0 because their cherry-picks are already on the 13.55.0 branch, but the 13.55.0 changelog does not list them. Add an entry to the right release if one is needed.',
  );
  assert.equal(
    getUnlistedCherryPicksWarning('13.56.0', {
      baselineVersion: '13.55.0',
      prNumbers: ['47395'],
    }),
    '> #47395 was left out of 13.56.0 because its cherry-pick is already on the 13.55.0 branch, but the 13.55.0 changelog does not list it. Add an entry to the right release if one is needed.',
  );
});

test('removes a left-out warning that no longer holds', () => {
  const existingBody = `This PR updates the change log for 8.20.0.\r\n\r\n${getUnlistedCherryPicksWarning('8.20.0', { baselineVersion: '8.19.0', prNumbers: ['1'] })}`;
  assert.equal(
    refreshGeneratedWarnings({ existingBody, version: '8.20.0' }),
    'This PR updates the change log for 8.20.0.',
  );
});

test('replaces a stale warning and keeps unrelated quotes', () => {
  const kept = '> AI automation failed, not proofread.';
  const existingBody = `Intro.\n\n${kept}\n\n${getUnlistedCherryPicksWarning('8.20.0', { baselineVersion: '8.19.0', prNumbers: ['1', '2'] })}`;
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['2'],
  };
  assert.equal(
    refreshGeneratedWarnings({
      existingBody,
      version: '8.20.0',
      unlistedCherryPicks,
    }),
    `Intro.\n\n${kept}\n\n${getUnlistedCherryPicksWarning('8.20.0', unlistedCherryPicks)}`,
  );
});

test('leaves a body whose warnings still hold', () => {
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['1'],
  };
  const existingBody = `Intro.\n\n${getUnlistedCherryPicksWarning('8.20.0', unlistedCherryPicks)}`;
  assert.equal(
    refreshGeneratedWarnings({
      existingBody,
      version: '8.20.0',
      unlistedCherryPicks,
    }),
    undefined,
  );
});

const RUN_PATH = '.github/workflows/update-release-changelog.yml';

test('finds the run the moving push triggered', () => {
  assert.equal(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => ['.github/workflows/other.yml', RUN_PATH],
    }),
    true,
  );
});

test('waits for the run of the moving push to appear', () => {
  const waits: number[] = [];
  let lookups = 0;
  assert.equal(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => {
        lookups += 1;
        return lookups < 3 ? [] : [RUN_PATH];
      },
      attempts: 5,
      delayMs: 1000,
      wait: (milliseconds) => waits.push(milliseconds),
    }),
    true,
  );
  assert.deepEqual(waits, [1000, 1000]);
});

test('gives up after the last attempt without a matching run', () => {
  const waits: number[] = [];
  assert.equal(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => [],
      attempts: 3,
      delayMs: 1000,
      wait: (milliseconds) => waits.push(milliseconds),
    }),
    false,
  );
  assert.deepEqual(waits, [1000, 1000]);
});

test('does not assume a newer run when none matches or the lookup fails', () => {
  assert.equal(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => ['.github/workflows/other.yml'],
      wait: () => undefined,
    }),
    false,
  );
  assert.equal(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => {
        throw new Error('403');
      },
    }),
    false,
  );
  assert.equal(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: undefined,
      listRunPaths: () => [RUN_PATH],
    }),
    false,
  );
});

test('reads the calling workflow path from the workflow ref', () => {
  assert.equal(
    getCallingWorkflowPath({
      GITHUB_REPOSITORY: 'MetaMask/metamask-mobile',
      GITHUB_WORKFLOW_REF: `MetaMask/metamask-mobile/${RUN_PATH}@refs/heads/release/8.20.0`,
    }),
    RUN_PATH,
  );
  assert.equal(getCallingWorkflowPath({}), undefined);
});

const staleWarning = getUnlistedCherryPicksWarning('8.20.0', {
  baselineVersion: '8.19.0',
  prNumbers: ['1'],
});

test('keeps text written on the line after a stale warning', () => {
  assert.equal(
    refreshGeneratedWarnings({
      existingBody: `Intro.\n\n${staleWarning}\nChecked #1, fine.`,
      version: '8.20.0',
    }),
    'Intro.\n\nChecked #1, fine.',
  );
});

test('removes a stale warning separated by extra blank lines', () => {
  assert.equal(
    refreshGeneratedWarnings({
      existingBody: `Intro.\n\n\n${staleWarning}`,
      version: '8.20.0',
    }),
    'Intro.',
  );
});

test('adds a warning to an empty body without leading blank lines', () => {
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['1'],
  };
  assert.equal(
    refreshGeneratedWarnings({
      existingBody: '',
      version: '8.20.0',
      unlistedCherryPicks,
    }),
    staleWarning,
  );
});

test('leaves a CRLF body whose warning sits mid-body', () => {
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['1'],
  };
  assert.equal(
    refreshGeneratedWarnings({
      existingBody: `Intro.\r\n\r\n${staleWarning}\r\n\r\nTrailing note.`,
      version: '8.20.0',
      unlistedCherryPicks,
    }),
    undefined,
  );
});

const EXCLUSION_SECTION = [
  '## [2.0.0]',
  '',
  '### Fixed',
  '',
  '- Fixed one (#1)',
  '- Fixed two (#2)',
  '- Fixed three (#3, #7)',
  '- Fixed the regression from (#4) (#5)',
  '',
].join('\n');

test('excludes the entries of PRs already on the baseline branch', () => {
  const result = excludePrsCherryPickedOntoBaseline({
    section: EXCLUSION_SECTION,
    shippedEarlier: new Set(['1', '3']),
    aliasesByPr: new Map([['3', ['7']]]),
    reviewedPrNumbers: new Set(),
  });

  assert.deepEqual(result.excludedPrNumbers, ['1', '3']);
  assert.equal(
    result.section,
    [
      '## [2.0.0]',
      '',
      '### Fixed',
      '',
      '- Fixed two (#2)',
      '- Fixed the regression from (#4) (#5)',
    ].join('\n'),
  );
});

test('keeps an entry that also owns a PR that is not excluded', () => {
  const result = excludePrsCherryPickedOntoBaseline({
    section: EXCLUSION_SECTION,
    shippedEarlier: new Set(['4']),
    aliasesByPr: new Map(),
    reviewedPrNumbers: new Set(),
  });

  assert.equal(result.section, EXCLUSION_SECTION);
  assert.deepEqual(result.excludedPrNumbers, []);
});

test('does not report PRs a reviewer already approved in the section', () => {
  const result = excludePrsCherryPickedOntoBaseline({
    section: EXCLUSION_SECTION,
    shippedEarlier: new Set(['1', '2']),
    aliasesByPr: new Map(),
    reviewedPrNumbers: new Set(['1']),
  });

  assert.deepEqual(result.excludedPrNumbers, ['2']);
});

test('does not report excluded PRs that the section never listed', () => {
  const result = excludePrsCherryPickedOntoBaseline({
    section: EXCLUSION_SECTION,
    shippedEarlier: new Set(['99']),
    aliasesByPr: new Map(),
    reviewedPrNumbers: new Set(),
  });

  assert.equal(result.section, EXCLUSION_SECTION);
  assert.deepEqual(result.excludedPrNumbers, []);
});

test('adds the unlisted cherry-pick warning to the PR body', () => {
  const { body } = getChangelogPrPresentation({
    version: '2.0.0',
    changelogBranch: 'release-changelog/2.0.0',
    proofreadingStatus: 'succeeded',
    unlistedCherryPicks: { baselineVersion: '1.0.0', prNumbers: ['5'] },
  });

  assert.match(body, /#5 was left out of 2\.0\.0/u);
});
