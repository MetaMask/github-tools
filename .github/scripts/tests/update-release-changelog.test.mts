import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

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
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toStrictEqual({
      status: 'failed',
      stage: 'authentication',
      error: 'no key',
    });
    writeFailedProofreadingReport(reportPath, 'boom');
    expect(
      (JSON.parse(readFileSync(reportPath, 'utf8')) as { stage: string }).stage,
    ).toBe('execution');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('collects historical skipped PRs from auto-changelog diagnostics', () => {
  expect(
    getHistoricalSkippedPrNumbers(`[auto-changelog] skipped pr=35695 reason=historical-pr
[auto-changelog] commit=abc accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] skipped pr=35716 reason=historical-pr
[auto-changelog] skipped pr=35695 reason=historical-pr
[auto-changelog] skipped pr=9 reason=cherry-pick-duplicate`),
  ).toStrictEqual(['35695', '35716']);
  expect(getHistoricalSkippedPrNumbers('')).toStrictEqual([]);
});

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);

test('collects the accepted commits of each canonical PR', () => {
  expect([
    ...getAcceptedPrCommits(`[auto-changelog] commit=${COMMIT_A} accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] commit=${COMMIT_B} accepted source-pr=7 canonical-pr=1 cherry-pick=true
[auto-changelog] commit=${COMMIT_C} accepted source-pr=2 canonical-pr=2 cherry-pick=false
[auto-changelog] skipped pr=9 reason=cherry-pick-duplicate`),
  ]).toStrictEqual([
    ['1', [COMMIT_A, COMMIT_B]],
    ['2', [COMMIT_C]],
  ]);
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

  expect(
    getDeletedPrNumbers({
      ...options,
      existingPrNumbers: new Set(['1']),
    }),
  ).toStrictEqual(new Set(['2']));
  expect(
    getDeletedPrNumbers({
      ...options,
      existingPrNumbers: new Set(['1', '2']),
    }),
  ).toStrictEqual(new Set());
});

test('treats nothing as deleted when the last tip cannot be read', () => {
  expect(
    getDeletedPrNumbers({
      acceptedCommitsByPr: new Map([['1', [COMMIT_A]]]),
      generatedThrough: 'd'.repeat(40),
      existingPrNumbers: new Set(),
      listReachableCommits: () => {
        throw new Error('unknown revision');
      },
    }),
  ).toStrictEqual(new Set());
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
  expect(
    findReleaseVersionsContainingPrs(changelog, ['35695', '35716'], '8.10.3'),
  ).toStrictEqual(['8.9.0', '8.11.0']);
  expect(
    findReleaseVersionsContainingPrs(changelog, ['35716'], '8.11.0'),
  ).toStrictEqual([]);
});

test('finds versions that document a PR with this repository long link', () => {
  const changelog = `# Changelog

## [8.9.0]

- Added a feature ([#35695](https://github.com/MetaMask/metamask-mobile/pull/35695))

## [8.8.0]

- Other repo ([#35695](https://github.com/MetaMask/core/pull/35695))
`;
  const repositoryUrl = 'https://github.com/MetaMask/metamask-mobile';

  expect(
    findReleaseVersionsContainingPrs(
      changelog,
      ['35695'],
      '8.10.3',
      repositoryUrl,
    ),
  ).toStrictEqual(['8.9.0']);
  expect(
    findReleaseVersionsContainingPrs(changelog, ['35695'], '8.10.3'),
  ).toStrictEqual([]);
});

test('detects a release section without entries', () => {
  expect(
    isReleaseSectionEmpty(
      '# Changelog\n\n## [8.10.3]\n\n## [8.10.2]\n',
      '8.10.3',
    ),
  ).toBe(true);
  expect(
    isReleaseSectionEmpty(
      '# Changelog\n\n## [8.10.3]\n\n### Fixed\n\n- Fixed it (#1)\n\n## [8.10.2]\n',
      '8.10.3',
    ),
  ).toBe(false);
});

test('asks for a manual edit when an OTA release has no new PRs', () => {
  expect(
    getChangelogPrPresentation({
      version: '8.10.3',
      changelogBranch: 'release-changelog/8.10.3',
      proofreadingStatus: 'no-new-prs',
      presentInVersions: ['8.11.0', '8.12.0'],
    }),
  ).toStrictEqual({
    title:
      'release: release-changelog/8.10.3 (no new PRs, manual edit required)',
    body: 'This PR updates the change log for 8.10.3.\n\n> There are no brand new PRs in 8.10.3, there are only cherry-picks that were already present in 8.11.0, 8.12.0. Please decide how you want to handle this and edit the changelog manually.',
  });
  expect(
    getChangelogPrPresentation({
      version: '8.10.3',
      changelogBranch: 'release-changelog/8.10.3',
      proofreadingStatus: 'no-new-prs',
    }).body,
  ).toMatch(/There are no brand new PRs in 8\.10\.3\. Please decide/u);
});

test('parses dry-run without changing positional arguments', () => {
  expect(
    parseUpdateChangelogArguments([
      '--dry-run',
      'release/13.51.0',
      'extension',
      'https://github.com/MetaMask/metamask-extension',
    ]),
  ).toStrictEqual({
    dryRun: true,
    positionalArguments: [
      'release/13.51.0',
      'extension',
      'https://github.com/MetaMask/metamask-extension',
    ],
  });
});

test('requires a pinned auto-changelog source CLI', () => {
  expect(
    getAutoChangelogCli({ AUTO_CHANGELOG_CLI: '/tmp/auto-changelog.mjs' }),
  ).toBe('/tmp/auto-changelog.mjs');
  expect(() => getAutoChangelogCli({})).toThrow(
    /AUTO_CHANGELOG_CLI must point/u,
  );
});

test('uses the standard validator when clean-room proofreading fails', () => {
  expect(getChangelogValidationArguments('failed', '13.51.0')).toStrictEqual([
    'validate',
    '--prettier',
    '--currentVersion',
    '13.51.0',
  ]);
  expect(getChangelogValidationArguments('succeeded', '13.51.0')).toStrictEqual(
    ['validate', '--prettier', '--currentVersion', '13.51.0', '--rc'],
  );
});

test('protects first changelog branch creation with an empty lease', () => {
  expect(
    getChangelogPushArguments({
      changelogBranch: 'release-changelog/13.51.0',
      expectedRemoteSha: undefined,
    }),
  ).toStrictEqual([
    'push',
    '--force-with-lease=refs/heads/release-changelog/13.51.0:',
    '--set-upstream',
    'origin',
    'HEAD:refs/heads/release-changelog/13.51.0',
  ]);
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

  expect(presentation).toStrictEqual({
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

  expect(body).toMatch(
    /\[View the proofreading report artifact\.\]\(https:\/\/github\.com\/MetaMask\/metamask-extension\/actions\/runs\/123#artifacts\)/u,
  );
});

test('preserves authentication failures for the unproofread PR warning', () => {
  const authenticationFailure = {
    status: 'failed' as const,
    stage: 'authentication',
  };
  expect(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      proofreadingStatus: authenticationFailure.status,
      proofreadingStage: authenticationFailure.stage,
    }).title,
  ).toStrictEqual(
    'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
  );
});

test('uses the plain presentation after a successful proofread', () => {
  expect(
    getChangelogPrPresentation({
      version: '13.51.0',
      changelogBranch: 'release-changelog/13.51.0',
      proofreadingStatus: 'succeeded',
    }),
  ).toStrictEqual({
    title: 'release: release-changelog/13.51.0',
    body: 'This PR updates the change log for 13.51.0.',
  });
});

test('explains an empty release section instead of deferring to the validator', () => {
  expect(() =>
    assertReleaseSectionHasEntries(
      '# Changelog\n\n## [8.10.3]\n\n## [8.10.2]\n',
      '8.10.3',
    ),
  ).toThrow(/## \[8\.10\.3\] has no entries/u);
  expect(() =>
    assertReleaseSectionHasEntries(
      '# Changelog\n\n## [8.10.3]\n\n### Fixed\n\n- Fixed it (#1)\n',
      '8.10.3',
    ),
  ).not.toThrow();
});

test('leaves an existing changelog PR alone when nothing changed', () => {
  expect(
    shouldKeepChangelogPrPresentation({
      existingTitle: 'release: release-changelog/13.51.0',
      proofreadingStatus: 'unchanged',
    }),
  ).toBe(true);
});

test('keeps the AI failure marker when a later run proofreads only new entries', () => {
  const existingTitle =
    'release: release-changelog/13.51.0 (AI automation failed, not proofread)';

  expect(
    shouldKeepChangelogPrPresentation({
      existingTitle,
      proofreadingStatus: 'succeeded',
    }),
  ).toBe(true);
  expect(
    shouldKeepChangelogPrPresentation({
      existingTitle,
      proofreadingStatus: 'failed',
    }),
  ).toBe(false);
});

test('rewrites the AI failure marker when the whole section was proofread again', () => {
  expect(
    shouldKeepChangelogPrPresentation({
      existingTitle:
        'release: release-changelog/13.51.0 (AI automation failed, not proofread)',
      proofreadingStatus: 'succeeded',
      replacesWholeSection: true,
    }),
  ).toBe(false);
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

  expect(isUntouchedUnproofreadChangelogPr(options)).toBe(true);
  expect(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      commits: [
        {
          authorEmail: 'bot@example.com',
          subject: 'update changelog for 13.51.0',
        },
      ],
    }),
  ).toBe(false);
  expect(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      title: 'release: release-changelog/13.51.0',
    }),
  ).toBe(false);
  expect(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      commits: [
        ...options.commits,
        { authorEmail: 'person@example.com', subject: 'fix wording' },
      ],
    }),
  ).toBe(false);
  expect(
    isUntouchedUnproofreadChangelogPr({
      ...options,
      commits: [
        {
          authorEmail: 'person@example.com',
          subject: 'update changelog for 13.51.0',
        },
      ],
    }),
  ).toBe(false);
  expect(isUntouchedUnproofreadChangelogPr({ ...options, commits: [] })).toBe(
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

  expect(hasOnlyUpdaterCommits(options)).toBe(true);
  expect(
    hasOnlyUpdaterCommits({
      ...options,
      commits: [
        own,
        { authorEmail: 'person@example.com', subject: 'fix wording' },
      ],
    }),
  ).toBe(false);
});

test('rewrites the PR presentation after a normal successful run', () => {
  expect(
    shouldKeepChangelogPrPresentation({
      existingTitle: 'release: release-changelog/13.51.0',
      proofreadingStatus: 'succeeded',
    }),
  ).toBe(false);
});

test('rejects generated sections with missing or duplicate PR references', () => {
  expect(() =>
    validateGeneratedReleaseSection(
      `## [13.51.0]

### Fixed

- Fixed an issue`,
      '13.51.0',
    ),
  ).toThrow(/without a PR reference/u);
  expect(() =>
    validateGeneratedReleaseSection(
      `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)`,
      '13.51.0',
    ),
  ).toThrow(/duplicate PR references/u);
  expect(() =>
    validateGeneratedReleaseSection(
      `## [13.51.0]

### Fixed

- Fixed an issue (#101)
- Fixed it again (#101)`,
      '13.51.0',
      true,
    ),
  ).not.toThrow();
});

test('collects the canonical PR of each accepted cherry-pick commit', () => {
  expect([
    ...getCherryPickedPrsByCommit(`[auto-changelog] commit=${COMMIT_A} accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] commit=${COMMIT_B} accepted source-pr=7 canonical-pr=1 cherry-pick=true
[auto-changelog] commit=${COMMIT_C} accepted source-pr=none canonical-pr=none cherry-pick=true`),
  ]).toStrictEqual([[COMMIT_B, '1']]);
});

test('finds the PRs cherry-picked onto the baseline branch', () => {
  const cherryPickedPrsByCommit = new Map([
    [COMMIT_A, '1'],
    [COMMIT_B, '2'],
  ]);

  expect(
    getPrsCherryPickedOntoBaseline({
      cherryPickedPrsByCommit,
      baselineRef: 'origin/release/1.0.0',
      isAncestor: (commit, ref) =>
        commit === COMMIT_A && ref === 'origin/release/1.0.0',
    }),
  ).toStrictEqual(new Set(['1']));
  expect(
    getPrsCherryPickedOntoBaseline({
      cherryPickedPrsByCommit,
      baselineRef: 'origin/stable',
      isAncestor: () => false,
    }),
  ).toStrictEqual(new Set());
});

test('maps each canonical PR to its cherry-pick PR numbers', () => {
  expect([
    ...getCherryPickAliasesByPr(`[auto-changelog] commit=${COMMIT_A} accepted source-pr=1 canonical-pr=1 cherry-pick=false
[auto-changelog] commit=${COMMIT_B} accepted source-pr=7 canonical-pr=1 cherry-pick=true
[auto-changelog] commit=${COMMIT_C} accepted source-pr=8 canonical-pr=1 cherry-pick=true`),
  ]).toStrictEqual([['1', ['7', '8']]]);
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

  expect(
    findPrsMissingFromChangelog({
      changelog,
      prNumbers: ['1', '2', '3', '4'],
      aliasesByPr: new Map([['3', ['31']]]),
      version: '2.0.0',
      repositoryUrl: 'https://github.com/MetaMask/example',
    }),
  ).toStrictEqual(['1', '4']);
});

test('counts a pending section of the earlier release as listing a PR', () => {
  const changelog = ['## [2.0.0]', '', '- Fixed one (#1)', ''].join('\n');
  const pendingSection = [
    '## [1.0.0]',
    '',
    '- Fixed two (#2)',
    '- Fixed three by its cherry-pick (#31)',
  ].join('\n');

  expect(
    findPrsMissingFromChangelog({
      changelog,
      pendingSections: [pendingSection],
      prNumbers: ['2', '3', '4'],
      aliasesByPr: new Map([['3', ['31']]]),
      version: '2.0.0',
      repositoryUrl: 'https://github.com/MetaMask/example',
    }),
  ).toStrictEqual(['4']);
});

const RELEASE_BASELINE = {
  kind: 'release',
  ref: 'origin/release/1.0.0',
  version: '1.0.0',
} as const;

test('reads the earlier release section from its open changelog PR', () => {
  const lookups: string[][] = [];

  expect(
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
  ).toBe('release-changelog/1.0.0 1.0.0');
  expect(lookups).toStrictEqual([['release-changelog/1.0.0', 'release/1.0.0']]);
});

test('ignores the earlier release changelog when no PR is open', () => {
  const options = {
    baseline: RELEASE_BASELINE,
    determineBranch: (version: string) => `release-changelog/${version}`,
    readSection: () => {
      throw new Error('must not read');
    },
  };

  expect(
    getOpenBaselineChangelogSection({
      ...options,
      getSha: () => undefined,
      getOpenPrNumber: () => '9',
    }),
  ).toBe(undefined);
  expect(
    getOpenBaselineChangelogSection({
      ...options,
      getSha: () => 'abc',
      getOpenPrNumber: () => undefined,
    }),
  ).toBe(undefined);
});

test('only reads an open changelog PR for a release baseline', () => {
  for (const kind of ['stable', 'target'] as const) {
    expect(
      getOpenBaselineChangelogSection({
        baseline: { kind, ref: 'origin/stable', version: '1.0.0' },
        getSha: () => 'abc',
        getOpenPrNumber: () => '9',
        readSection: () => 'section',
      }),
    ).toBe(undefined);
  }
});

test('carries on when the open changelog branch lacks the section', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  expect(
    getOpenBaselineChangelogSection({
      baseline: RELEASE_BASELINE,
      determineBranch: (version) => `release-changelog/${version}`,
      getSha: () => 'abc',
      getOpenPrNumber: () => '9',
      readSection: () => {
        throw new Error('Expected exactly one release heading for 1.0.0');
      },
    }),
  ).toBe(undefined);
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

  expect(
    findEntriesDroppedByRestore({
      restoredChangelog,
      releaseChangelog: RELEASE_BRANCH_CHANGELOG,
    }),
  ).toStrictEqual([{ version: '2.0.0', entryCount: 1, prNumbers: ['2'] }]);
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

  expect(
    findEntriesDroppedByRestore({
      restoredChangelog,
      releaseChangelog: RELEASE_BRANCH_CHANGELOG,
    }),
  ).toStrictEqual([{ version: '1.0.0', entryCount: 1, prNumbers: ['3'] }]);
});

test('reports nothing when the restore keeps every released entry', () => {
  expect(
    findEntriesDroppedByRestore({
      restoredChangelog: `${RELEASE_BRANCH_CHANGELOG}\n## [3.0.0]\n\n- New (#5)\n`,
      releaseChangelog: RELEASE_BRANCH_CHANGELOG,
    }),
  ).toStrictEqual([]);
});

test('words the warning for entries the restore dropped', () => {
  expect(
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
  ).toBe(
    '> Restoring the changelog from the 8.19.0 baseline dropped 6 entries that release/8.20.0 lists under earlier releases: 8.18.0 (5 entries: #1, #2, #3, +2 more); 8.17.0 (1 entry: #6). The 8.19.0 changelog may be stale for 8.20.0; fix it or merge its changelog PR first, then rerun.',
  );
  expect(
    getDroppedEntriesWarning('8.20.0', {
      baselineVersion: '8.19.0',
      releaseBranch: 'release/8.20.0',
      versions: [{ version: '8.18.0', entryCount: 1, prNumbers: ['1'] }],
    }),
  ).toMatch(/dropped 1 entry that release\/8\.20\.0 lists/u);
});

test('does not count a reworded entry as dropped', () => {
  const releaseChangelog = '## [1.0.0]\n\n- Fixed a crash (#1, #2)\n';
  expect(
    findEntriesDroppedByRestore({
      restoredChangelog: '## [1.0.0]\n\n- Fixed the crash on launch (#2)\n',
      releaseChangelog,
    }),
  ).toStrictEqual([]);
});

test('reads long PR links when comparing dropped entries', () => {
  const repositoryUrl = 'https://github.com/MetaMask/metamask-mobile';
  const link = (number: string): string =>
    `[#${number}](${repositoryUrl}/pull/${number})`;
  const releaseChangelog = `## [1.0.0]\n\n- Fixed a crash (${link('1')})\n- Fixed a hang (${link('2')})\n`;
  expect(
    findEntriesDroppedByRestore({
      restoredChangelog: `## [1.0.0]\n\n- Fixed the crash on launch (${link('1')})\n`,
      releaseChangelog,
      repositoryUrl,
    }),
  ).toStrictEqual([{ version: '1.0.0', entryCount: 1, prNumbers: ['2'] }]);
});

test('compares an entry without a PR number by its text', () => {
  const releaseChangelog = '## [1.0.0]\n\n- Manual note\n';
  expect(
    findEntriesDroppedByRestore({
      restoredChangelog: '## [1.0.0]\n\n- Other note\n',
      releaseChangelog,
    }),
  ).toStrictEqual([{ version: '1.0.0', entryCount: 1, prNumbers: [] }]);
  expect(
    findEntriesDroppedByRestore({
      restoredChangelog: releaseChangelog,
      releaseChangelog,
    }),
  ).toStrictEqual([]);
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
  expect(warningFor(['1', '2', '3'])).toMatch(/\(3 entries: #1, #2, #3\)/u);
  expect(warningFor(['1', '2', '3', '4'])).toMatch(
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

  expect(body).toMatch(/^This PR updates the change log for 8\.20\.0\./u);
  expect(body).toMatch(
    /\n\n> Restoring the changelog from the 8\.19\.0 baseline/u,
  );
});

test('words the warning for PRs the earlier changelog lacks', () => {
  expect(
    getUnlistedCherryPicksWarning('13.56.0', {
      baselineVersion: '13.55.0',
      prNumbers: ['47395', '47400'],
    }),
  ).toBe(
    '> #47395, #47400 were left out of 13.56.0 because their cherry-picks are already on the 13.55.0 branch, but the 13.55.0 changelog does not list them. Add an entry to the right release if one is needed.',
  );
  expect(
    getUnlistedCherryPicksWarning('13.56.0', {
      baselineVersion: '13.55.0',
      prNumbers: ['47395'],
    }),
  ).toBe(
    '> #47395 was left out of 13.56.0 because its cherry-pick is already on the 13.55.0 branch, but the 13.55.0 changelog does not list it. Add an entry to the right release if one is needed.',
  );
});

test('removes a left-out warning that no longer holds', () => {
  const existingBody = `This PR updates the change log for 8.20.0.\r\n\r\n${getUnlistedCherryPicksWarning('8.20.0', { baselineVersion: '8.19.0', prNumbers: ['1'] })}`;
  expect(refreshGeneratedWarnings({ existingBody, version: '8.20.0' })).toBe(
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
  expect(
    refreshGeneratedWarnings({
      existingBody,
      version: '8.20.0',
      unlistedCherryPicks,
    }),
  ).toBe(
    `Intro.\n\n${kept}\n\n${getUnlistedCherryPicksWarning('8.20.0', unlistedCherryPicks)}`,
  );
});

test('leaves a body whose warnings still hold', () => {
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['1'],
  };
  const existingBody = `Intro.\n\n${getUnlistedCherryPicksWarning('8.20.0', unlistedCherryPicks)}`;
  expect(
    refreshGeneratedWarnings({
      existingBody,
      version: '8.20.0',
      unlistedCherryPicks,
    }),
  ).toBe(undefined);
});

const RUN_PATH = '.github/workflows/update-release-changelog.yml';

test('finds the run the moving push triggered', () => {
  expect(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => ['.github/workflows/other.yml', RUN_PATH],
    }),
  ).toBe(true);
});

test('waits for the run of the moving push to appear', () => {
  const waits: number[] = [];
  let lookups = 0;
  expect(
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
  ).toBe(true);
  expect(waits).toStrictEqual([1000, 1000]);
});

test('gives up after the last attempt without a matching run', () => {
  const waits: number[] = [];
  expect(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => [],
      attempts: 3,
      delayMs: 1000,
      wait: (milliseconds) => waits.push(milliseconds),
    }),
  ).toBe(false);
  expect(waits).toStrictEqual([1000, 1000]);
});

test('does not assume a newer run when none matches or the lookup fails', () => {
  expect(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => ['.github/workflows/other.yml'],
      wait: () => undefined,
    }),
  ).toBe(false);
  expect(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: RUN_PATH,
      listRunPaths: () => {
        throw new Error('403');
      },
    }),
  ).toBe(false);
  expect(
    hasWorkflowRunForSha({
      sha: 'abc',
      workflowPath: undefined,
      listRunPaths: () => [RUN_PATH],
    }),
  ).toBe(false);
});

test('reads the calling workflow path from the workflow ref', () => {
  expect(
    getCallingWorkflowPath({
      GITHUB_REPOSITORY: 'MetaMask/metamask-mobile',
      GITHUB_WORKFLOW_REF: `MetaMask/metamask-mobile/${RUN_PATH}@refs/heads/release/8.20.0`,
    }),
  ).toBe(RUN_PATH);
  expect(getCallingWorkflowPath({})).toBe(undefined);
});

const staleWarning = getUnlistedCherryPicksWarning('8.20.0', {
  baselineVersion: '8.19.0',
  prNumbers: ['1'],
});

test('keeps text written on the line after a stale warning', () => {
  expect(
    refreshGeneratedWarnings({
      existingBody: `Intro.\n\n${staleWarning}\nChecked #1, fine.`,
      version: '8.20.0',
    }),
  ).toBe('Intro.\n\nChecked #1, fine.');
});

test('removes a stale warning separated by extra blank lines', () => {
  expect(
    refreshGeneratedWarnings({
      existingBody: `Intro.\n\n\n${staleWarning}`,
      version: '8.20.0',
    }),
  ).toBe('Intro.');
});

test('adds a warning to an empty body without leading blank lines', () => {
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['1'],
  };
  expect(
    refreshGeneratedWarnings({
      existingBody: '',
      version: '8.20.0',
      unlistedCherryPicks,
    }),
  ).toBe(staleWarning);
});

test('leaves a CRLF body whose warning sits mid-body', () => {
  const unlistedCherryPicks = {
    baselineVersion: '8.19.0',
    prNumbers: ['1'],
  };
  expect(
    refreshGeneratedWarnings({
      existingBody: `Intro.\r\n\r\n${staleWarning}\r\n\r\nTrailing note.`,
      version: '8.20.0',
      unlistedCherryPicks,
    }),
  ).toBe(undefined);
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

  expect(result.excludedPrNumbers).toStrictEqual(['1', '3']);
  expect(result.section).toBe(
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

  expect(result.section).toBe(EXCLUSION_SECTION);
  expect(result.excludedPrNumbers).toStrictEqual([]);
});

test('does not report PRs a reviewer already approved in the section', () => {
  const result = excludePrsCherryPickedOntoBaseline({
    section: EXCLUSION_SECTION,
    shippedEarlier: new Set(['1', '2']),
    aliasesByPr: new Map(),
    reviewedPrNumbers: new Set(['1']),
  });

  expect(result.excludedPrNumbers).toStrictEqual(['2']);
});

test('does not report excluded PRs that the section never listed', () => {
  const result = excludePrsCherryPickedOntoBaseline({
    section: EXCLUSION_SECTION,
    shippedEarlier: new Set(['99']),
    aliasesByPr: new Map(),
    reviewedPrNumbers: new Set(),
  });

  expect(result.section).toBe(EXCLUSION_SECTION);
  expect(result.excludedPrNumbers).toStrictEqual([]);
});

test('adds the unlisted cherry-pick warning to the PR body', () => {
  const { body } = getChangelogPrPresentation({
    version: '2.0.0',
    changelogBranch: 'release-changelog/2.0.0',
    proofreadingStatus: 'succeeded',
    unlistedCherryPicks: { baselineVersion: '1.0.0', prNumbers: ['5'] },
  });

  expect(body).toMatch(/#5 was left out of 2\.0\.0/u);
});
